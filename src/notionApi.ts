import { extractNotionIdFromUrl, type AppConfig } from "./config";
import type { SprintTasksSummary } from "./schema";
import { withRetry } from "./retry";
import { toJstDateString } from "./workflow";
import type {
  DeliveryProjectRecord,
  DeliverySnapshot,
  DeliveryTaskRecord
} from "./deliveryControl";

const NOTION_VERSION = "2022-06-28";

// ── Virtual Sprint (Sprint DB 不使用時の週次スプリント自動計算) ─────────────
export const VIRTUAL_SPRINT_PREFIX = "virtual-";

export function isVirtualSprintId(id: string): boolean {
  return id.startsWith(VIRTUAL_SPRINT_PREFIX);
}

/**
 * JST の土〜金を1スプリントとして、指定日を含む週のスプリント情報を返す。
 * 例: 2026-07-25(土) 〜 2026-07-31(金) → id=virtual-2026-07-25
 */
export function computeVirtualSprint(
  now: Date
): { id: string; name: string; start_date: string; end_date: string; status: string } {
  const jstMs = now.getTime() + 9 * 3600 * 1000;
  const jst = new Date(jstMs);
  const dow = jst.getUTCDay(); // 0=Sun … 6=Sat
  const daysFromSat = dow === 6 ? 0 : (dow + 1);
  const startMs = jstMs - daysFromSat * 86400000;
  const start = new Date(startMs).toISOString().slice(0, 10);
  const end = new Date(startMs + 6 * 86400000).toISOString().slice(0, 10);
  const mmdd = (s: string) => s.slice(5).replace("-", "/");
  return {
    id: `${VIRTUAL_SPRINT_PREFIX}${start}`,
    name: `${mmdd(start)}〜${mmdd(end)}`,
    start_date: start,
    end_date: end,
    status: "進行中"
  };
}

/** 直近 count 週分の仮想スプリントを返す（新→旧順）。 */
function computeVirtualSprintHistory(
  count: number,
  now: Date
): Array<{ id: string; name: string; start_date: string; end_date: string; status: string }> {
  const results = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getTime() - i * 7 * 86400000);
    results.push(computeVirtualSprint(d));
  }
  return results;
}

/**
 * 仮想スプリント ID から開始日・終了日を返す。
 * 通常スプリントなら null。
 */
function virtualSprintDates(
  sprintId: string
): { start_date: string; end_date: string } | null {
  if (!isVirtualSprintId(sprintId)) return null;
  const start = sprintId.slice(VIRTUAL_SPRINT_PREFIX.length);
  const end = new Date(
    new Date(start + "T00:00:00Z").getTime() + 6 * 86400000
  ).toISOString().slice(0, 10);
  return { start_date: start, end_date: end };
}

/**
 * スプリントタスクの Notion フィルタを返す。
 * 仮想スプリントなら「期限」の日付範囲フィルタ、通常なら relation フィルタ。
 */
function buildSprintTaskFilter(
  config: AppConfig,
  sprint: { id: string; start_date: string; end_date: string }
): Record<string, unknown> {
  if (isVirtualSprintId(sprint.id)) {
    return {
      and: [
        { property: "期限", date: { on_or_after: sprint.start_date } },
        { property: "期限", date: { on_or_before: sprint.end_date } }
      ]
    };
  }
  return { property: config.taskSprintRelationProperty, relation: { contains: sprint.id } };
}

interface NotionTask {
  id: string;
  title: string;
  properties: Record<string, unknown>;
}

interface NotionTaskSummary {
  id: string;
  title: string;
  status?: string;
  period?: { start?: string | null; end?: string | null };
  planSp?: number | null;
  doneSp?: number | null;
  progressSp?: number | null;
}

export async function fetchTasksInDateRange(
  config: AppConfig,
  start: string,
  end: string
): Promise<NotionTask[]> {
  const databaseId =
    config.taskDbId ||
    (await resolveDatabaseId(config, {
      url: config.taskDbUrl,
      name: config.taskDbName,
      label: "TASK_DB"
    }));

  const body = {
    filter: {
      property: config.notionDateProperty,
      date: {
        on_or_after: start,
        on_or_before: end
      }
    },
    sorts: [{ property: config.notionDateProperty, direction: "ascending" }]
  };

  const data = await withRetry(
    async () => {
      const res = await fetch(
        `https://api.notion.com/v1/databases/${databaseId}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.notionToken}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        }
      );
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Notion API error: ${res.status} ${detail}`);
      }
      return (await res.json()) as any;
    },
    { label: "Notion fetchTasksInDateRange" }
  );
  const results = Array.isArray(data.results) ? data.results : [];

  return results.map((page: any) => {
    const titleProp = page.properties?.名前?.title ?? [];
    const title =
      titleProp.find((t: any) => t.plain_text)?.plain_text ?? "(no title)";
    return {
      id: page.id,
      title,
      properties: page.properties
    };
  });
}

const asNumber = (prop: any): number | null => {
  if (prop?.type === "number" && typeof prop.number === "number") {
    return prop.number;
  }
  if (prop?.rollup?.type === "number" && typeof prop.rollup.number === "number")
    return prop.rollup.number;
  if (prop?.formula?.type === "number" && typeof prop.formula.number === "number")
    return prop.formula.number;
  return null;
};

const COMPLETED_STATUSES = [
  "完了",
  "Done",
  "Closed",
  "完了済み",
  "Completed",
  "Resolved",
  "終了",
  "クローズ"
];

const ACTIVE_STATUSES = ["Active", "進行中", "In Progress", "実行中"];

const normalizeDateString = (value?: string | null): string | undefined => {
  if (!value) return undefined;
  return value.slice(0, 10);
};

/** ISO 日時文字列に時刻が含まれていれば JST の "HH:MM" を返す。日付のみ(時刻なし)は null。 */
const extractTimeJst = (value?: string | null): string | null => {
  if (!value || !value.includes("T")) return null;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return null;
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 16);
};

const titleFromRichText = (items: any): string => {
  if (!Array.isArray(items)) return "";
  return items.map((item) => item?.plain_text ?? "").join("").trim();
};

const getPropertyByName = (
  props: Record<string, any>,
  names: string[]
): any | undefined => {
  for (const name of names) {
    if (props?.[name]) return props[name];
  }
  return undefined;
};

const findPropertiesByType = (
  props: Record<string, any>,
  type: string
): Array<{ name: string; value: any }> => {
  if (!props) return [];
  const out: Array<{ name: string; value: any }> = [];
  for (const [name, value] of Object.entries(props)) {
    if ((value as any)?.type === type) {
      out.push({ name, value });
    }
  }
  return out;
};

const getTitleFromProperties = (
  props: Record<string, any>,
  names: string[]
): string => {
  const prop =
    getPropertyByName(props, names) ||
    findPropertiesByType(props, "title")[0]?.value;
  const title = titleFromRichText(prop?.title);
  return title || "(no title)";
};

const getStatusName = (prop: any): string | undefined => {
  if (!prop) return undefined;
  if (prop.type === "status") return prop.status?.name ?? undefined;
  if (prop.type === "select") return prop.select?.name ?? undefined;
  return undefined;
};

const getPeopleNames = (prop: any): string[] => {
  if (prop?.type !== "people" || !Array.isArray(prop.people)) return [];
  return prop.people
    .map((p: any) => p?.name)
    .filter((name: unknown): name is string => typeof name === "string");
};

const getDateValue = (prop: any): { start?: string | null; end?: string | null } | undefined => {
  if (prop?.type !== "date") return undefined;
  return prop.date ?? undefined;
};

export const isCompletedStatus = (status?: string | null): boolean => {
  if (!status) return false;
  return COMPLETED_STATUSES.some((s) =>
    status.toLowerCase().includes(s.toLowerCase())
  );
};

/** 0〜1 のSP進捗率。完了=1.0, doing(60%)=0.6, それ以外=0 */
export function statusProgressRate(status: string | null | undefined): number {
  if (!status) return 0;
  if (isCompletedStatus(status)) return 1.0;
  const m = status.match(/(\d+)\s*%/);
  if (m) return Math.min(100, parseInt(m[1], 10)) / 100;
  return 0;
}

const isActiveStatus = (status?: string | null): boolean => {
  if (!status) return false;
  return ACTIVE_STATUSES.some((s) =>
    status.toLowerCase().includes(s.toLowerCase())
  );
};

const isDateInRange = (
  target: string,
  start?: string | null,
  end?: string | null
): boolean => {
  const startDate = normalizeDateString(start);
  if (!startDate) return false;
  const endDate = normalizeDateString(end) || startDate;
  return startDate <= target && target <= endDate;
};

const newestSprint = (sprints: SprintInfo[]): SprintInfo | undefined =>
  [...sprints].sort((a, b) =>
    b.start_date.localeCompare(a.start_date) ||
    b.end_date.localeCompare(a.end_date)
  )[0];

const selectCurrentSprint = (
  sprints: SprintInfo[],
  today: string
): SprintInfo | undefined => {
  const inRange = sprints.filter((s) =>
    isDateInRange(today, s.start_date, s.end_date)
  );
  if (inRange.length > 0) return newestSprint(inRange);

  const active = sprints.filter((s) => isActiveStatus(s.status));
  if (active.length > 0) return newestSprint(active);

  return newestSprint(sprints);
};


async function notionRequest(
  config: AppConfig,
  path: string,
  body: Record<string, unknown>,
  options?: { silent?: boolean }
): Promise<any> {
  return withRetry(
    async () => {
      const res = await fetch(`https://api.notion.com/v1/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.notionToken}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Notion API error: ${res.status} ${detail}`);
      }
      return res.json();
    },
    { label: `Notion ${path}`, silent: options?.silent }
  );
}

async function queryDatabase(
  config: AppConfig,
  databaseId: string,
  body: Record<string, unknown>,
  maxPages = 5,
  options?: { silent?: boolean }
): Promise<any[]> {
  const results: any[] = [];
  let cursor: string | undefined;
  let page = 0;

  while (page < maxPages) {
    const payload = {
      page_size: 100,
      ...body,
      ...(cursor ? { start_cursor: cursor } : {})
    };
    const data = await notionRequest(
      config,
      `databases/${databaseId}/query`,
      payload,
      options
    );
    const items = Array.isArray(data.results) ? data.results : [];
    results.push(...items);
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
    page += 1;
  }
  return results;
}

async function searchDatabaseIdByName(
  config: AppConfig,
  name: string
): Promise<string> {
  const data = await notionRequest(config, "search", {
    query: name,
    filter: { property: "object", value: "database" },
    page_size: 20
  });
  const results = Array.isArray(data.results) ? data.results : [];
  const normalized = name.trim().toLowerCase();

  const pickTitle = (db: any) => titleFromRichText(db?.title ?? []);
  const exact = results.find(
    (db: any) => pickTitle(db).trim().toLowerCase() === normalized
  );
  if (exact?.id) return exact.id;

  const partial = results.find((db: any) =>
    pickTitle(db).trim().toLowerCase().includes(normalized)
  );
  if (partial?.id) return partial.id;

  throw new Error(`Database not found by name: ${name}`);
}

async function resolveDatabaseId(
  config: AppConfig,
  options: { url?: string; name?: string; label: string }
): Promise<string> {
  const idFromUrl = extractNotionIdFromUrl(options.url);
  if (idFromUrl) return idFromUrl;
  if (options.name) return searchDatabaseIdByName(config, options.name);
  throw new Error(
    `${options.label} database id is required (set ${options.label}_URL or ${options.label}_NAME)`
  );
}

interface SprintInfo {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  planSp: number | null;
  progressSp: number | null;
  requiredSpPerDay: number | null;
}

interface TaskRow {
  id: string;
  name: string;
  status: string | null;
  priority: string | null;
  sp: number | null;
  due: string | null;
  dueEnd: string | null;
  dueTime: string | null;
  startDate: string | null;
  category: string | null;
  subItem: string | null;
  company: string | null;
  url?: string | null;
  assignees: string[];
  projectIds: string[];
  /** ページ作成日(JST, YYYY-MM-DD)。当日作成タスク判定に使う。 */
  createdTime: string | null;
}

const extractSprintInfo = (
  page: any,
  datePropName: string
): SprintInfo | null => {
  const props = page?.properties ?? {};
  const name = getTitleFromProperties(props, ["名前", "Name"]);
  const statusProp =
    getPropertyByName(props, ["ステータス", "Status", "状態"]) ||
    findPropertiesByType(props, "status")[0]?.value ||
    findPropertiesByType(props, "select")[0]?.value;
  const status = getStatusName(statusProp) ?? "-";

  const dateProp =
    getPropertyByName(props, [datePropName]) ||
    findPropertiesByType(props, "date")[0]?.value;
  const period = getDateValue(dateProp);
  const start = normalizeDateString(period?.start);
  const end = normalizeDateString(period?.end) || start;
  if (!start || !end) return null;

  const planSp =
    asNumber(props?.計画SP) ?? asNumber(props?.計画ポイント) ?? asNumber(props?.計画);
  const progressSp =
    asNumber(props?.進捗SP) ??
    asNumber(props?.進捗ポイント) ??
    asNumber(props?.進捗);
  const requiredSpPerDay =
    asNumber(props?.["必要SP/日"]) ??
    asNumber(props?.["必要SP/日数"]) ??
    asNumber(props?.required_sp_per_day);

  return {
    id: page.id,
    name,
    start_date: start,
    end_date: end,
    status,
    planSp,
    progressSp,
    requiredSpPerDay
  };
};

/** Fetch page titles by IDs in batch (individual fetches, deduplicated) */
export async function fetchPageTitles(
  config: AppConfig,
  pageIds: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(pageIds)];

  await Promise.all(
    unique.map(async (pageId) => {
      try {
        const res = await withRetry(
          async () => {
            const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
              headers: {
                Authorization: `Bearer ${config.notionToken}`,
                "Notion-Version": NOTION_VERSION
              }
            });
            if (!r.ok) throw new Error(`${r.status}`);
            return r.json();
          },
          { label: `fetchPage ${pageId}` }
        );
        const props = (res as any)?.properties ?? {};
        for (const prop of Object.values(props)) {
          if ((prop as any)?.type === "title" && Array.isArray((prop as any).title)) {
            const title = (prop as any).title
              .map((t: any) => t.plain_text ?? "")
              .join("");
            if (title) {
              result.set(pageId, title);
              break;
            }
          }
        }
      } catch (err) {
        console.warn(`Failed to fetch page title for ${pageId}: ${(err as Error).message}`);
      }
    })
  );

  return result;
}

/** Generate abbreviated project name (e.g. "Mavericks" → "M", "LiftForce" → "LF") */
function abbreviateProjectName(name: string): string {
  // If already short (<=3 chars), use as-is
  if (name.length <= 3) return name;

  // Extract uppercase letters from camelCase/PascalCase (e.g. "LiftForce" → "LF")
  const uppercaseLetters = name.match(/[A-Z]/g);
  if (uppercaseLetters && uppercaseLetters.length >= 2) {
    return uppercaseLetters.join("");
  }

  // Split by spaces/delimiters and take initials
  const words = name.split(/[\s\-_・]+/).filter(Boolean);
  if (words.length >= 2) {
    return words.map((w) => w[0].toUpperCase()).join("");
  }

  // Single word: first 1-2 chars (uppercase for English)
  if (/^[a-zA-Z]/.test(name)) {
    return name.slice(0, 1).toUpperCase();
  }

  // Japanese/other: first char
  return name.slice(0, 1);
}

const extractTaskRow = (page: any, opts: { includeCompleted?: boolean } = {}): TaskRow | null => {
  const props = page?.properties ?? {};
  const name = getTitleFromProperties(props, ["名前", "Name"]);
  const url = typeof page?.url === "string" ? page.url : null;
  const statusProp =
    getPropertyByName(props, ["ステータス", "Status", "状態"]) ||
    (findPropertiesByType(props, "status").length === 1
      ? findPropertiesByType(props, "status")[0].value
      : undefined);
  const priorityProp =
    getPropertyByName(props, ["優先度", "Priority"]) ||
    (findPropertiesByType(props, "select").length === 1
      ? findPropertiesByType(props, "select")[0].value
      : undefined);
  const assigneeProp =
    getPropertyByName(props, ["担当者", "Assignee", "Owner"]) ||
    (findPropertiesByType(props, "people").length === 1
      ? findPropertiesByType(props, "people")[0].value
      : undefined);

  const status = getStatusName(statusProp) ?? null;
  // 通常は完了タスクを除外する。includeCompleted のときだけ完了タスクも返す（進捗サマリー用）。
  if (!opts.includeCompleted && isCompletedStatus(status)) return null;

  // ページ作成日を JST(YYYY-MM-DD) に変換（created_time は UTC ISO）
  const createdTime =
    typeof page?.created_time === "string"
      ? new Date(new Date(page.created_time).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)
      : null;

  const priority = getStatusName(priorityProp) ?? null;
  const sp =
    asNumber(props?.SP) ??
    asNumber(props?.ポイント) ??
    asNumber(props?.["Story Points"]);
  const dueProp = getPropertyByName(props, ["期限", "Due", "Due Date"]);
  const dueDate = getDateValue(dueProp);
  // 期限がレンジ(開始 → 終了)の場合、締切は「終了日」。単日ならその日。
  const due = normalizeDateString(dueDate?.end ?? dueDate?.start) ?? null;
  // 期限がレンジ(開始〜終了)の場合の終端 = 期日。単日なら null。
  const dueEnd = normalizeDateString(dueDate?.end) ?? null;
  // 期日に時刻が含まれる場合の時刻(JST "HH:MM")。日付のみなら null。
  const dueTime = extractTimeJst(dueDate?.end ?? dueDate?.start);

  const assignees = getPeopleNames(assigneeProp);

  const categoryProp = getPropertyByName(props, ["大項目", "カテゴリ", "Category"]);
  const category = getStatusName(categoryProp) ?? null;

  const subItemProp = getPropertyByName(props, ["小項目", "Sub Item"]);
  const subItem = getStatusName(subItemProp) ?? null;

  const companyProp = getPropertyByName(props, ["実施社", "Company"]);
  const company = getStatusName(companyProp) ?? null;

  // 開始(実行)日: このDBは「実行日」を使う。互換のため「開始日/Start Date」もフォールバック。
  const startDateProp = getPropertyByName(props, ["実行日", "開始日", "Start Date"]);
  const startDateValue = getDateValue(startDateProp);
  const startDate = normalizeDateString(startDateValue?.start) ?? null;

  // Extract per-task project relation IDs
  const projectProp = getPropertyByName(props, ["プロジェクト", "Project"]);
  const taskProjectIds: string[] = [];
  if (projectProp?.type === "relation" && Array.isArray(projectProp.relation)) {
    for (const rel of projectProp.relation) {
      if (rel?.id) taskProjectIds.push(rel.id);
    }
  }

  return {
    id: page.id,
    name,
    status,
    priority,
    sp,
    due,
    dueEnd,
    dueTime,
    startDate,
    category,
    subItem,
    company,
    url,
    assignees,
    projectIds: taskProjectIds,
    createdTime
  };
};

const groupTasksByAssignee = (
  tasks: TaskRow[]
): SprintTasksSummary["assignees"] => {
  const grouped = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    const names = task.assignees.length ? task.assignees : ["未割当"];
    for (const name of names) {
      const list = grouped.get(name) ?? [];
      list.push(task);
      grouped.set(name, list);
    }
  }

  const sorted = Array.from(grouped.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return sorted.map(([name, list]) => {
    const priorityValue = (value: string | null): number => {
      if (!value) return Number.NEGATIVE_INFINITY;
      const trimmed = value.trim();
      const num = Number(trimmed);
      if (!Number.isNaN(num)) return num;
      return Number.NEGATIVE_INFINITY;
    };

    const tasksSorted = list.sort((a, b) => {
      const aDue = a.due ?? "9999-99-99";
      const bDue = b.due ?? "9999-99-99";
      const dueCompare = aDue.localeCompare(bDue);
      if (dueCompare !== 0) return dueCompare;
      const priorityCompare =
        priorityValue(b.priority) - priorityValue(a.priority);
      if (priorityCompare !== 0) return priorityCompare;
      return a.name.localeCompare(b.name);
    });
    return {
      name,
      tasks: tasksSorted.map((task) => ({
        id: task.id,
        name: task.name,
        status: task.status ?? null,
        priority: task.priority ?? null,
        sp: task.sp ?? null,
        due: task.due ?? null,
        dueEnd: task.dueEnd ?? null,
        dueTime: task.dueTime ?? null,
        startDate: task.startDate ?? null,
        category: task.category ?? null,
        subItem: task.subItem ?? null,
        company: task.company ?? null,
        url: task.url ?? null,
        projectName: null as string | null
      }))
    };
  });
};

export async function fetchCurrentSprintTasksSummary(
  config: AppConfig,
  now: Date,
  opts: { includeCompleted?: boolean } = {}
): Promise<SprintTasksSummary> {
  // Sprint DB 未設定時は仮想スプリント（土〜金の週次）にフォールバック
  const hasSprintDb = !!(config.sprintDbUrl || config.sprintDbName);
  const taskDbId = await resolveDatabaseId(config, {
    url: config.taskDbUrl,
    name: config.taskDbName,
    label: "TASK_DB"
  });

  let sprint: SprintInfo;

  if (!hasSprintDb) {
    const v = computeVirtualSprint(now);
    sprint = { ...v, planSp: null, progressSp: null, requiredSpPerDay: null };
    console.log("Virtual sprint (no Sprint DB):", sprint.name, sprint.start_date, "~", sprint.end_date);
  } else {
    const sprintDbId = await resolveDatabaseId(config, {
      url: config.sprintDbUrl,
      name: config.sprintDbName,
      label: "SPRINT_DB"
    });

    const dateProp = config.notionDateProperty;
    const sprintPages = await queryDatabase(config, sprintDbId, {}, 10);
    if (sprintPages.length === 0) {
      throw new Error("Sprint DB query returned no results");
    }

    const today = toJstDateString(now);
    const sprintCandidates = sprintPages
      .map((page) => extractSprintInfo(page, dateProp))
      .filter((s): s is SprintInfo => s != null);
    if (sprintCandidates.length === 0) {
      throw new Error("Sprint records did not contain a valid period property");
    }

    console.log("Sprint candidates:", sprintCandidates.map((s) => `${s.name} ${s.start_date}~${s.end_date} [${s.status}]`));
    console.log("Looking for sprint containing today:", today);

    const selected = selectCurrentSprint(sprintCandidates, today);
    if (!selected) throw new Error("Could not select current sprint");

    console.log("Selected sprint:", selected.name, selected.start_date, "~", selected.end_date);
    sprint = selected;
  }

  const taskPages = await queryDatabase(
    config,
    taskDbId,
    { filter: buildSprintTaskFilter(config, sprint) },
    10
  );

  const tasks: TaskRow[] = [];
  const metricTasks: TaskRow[] = [];
  // Extract project relation — collect from ALL non-completed tasks and pick the most common
  const projectIdCounts = new Map<string, number>();
  for (const page of taskPages) {
    // 返却一覧は従来どおり未完了中心だが、Sprint 指標は完了済みも含む全タスクで算出する。
    const metricTask = extractTaskRow(page, { includeCompleted: true });
    if (!metricTask) continue;
    metricTasks.push(metricTask);
    const task = opts.includeCompleted || !isCompletedStatus(metricTask.status)
      ? metricTask
      : null;
    if (!task) continue;
    tasks.push(task);
    const props = page?.properties ?? {};
    const projectProp = getPropertyByName(props, ["プロジェクト", "Project"]);
    if (projectProp?.type === "relation" && Array.isArray(projectProp.relation)) {
      for (const rel of projectProp.relation) {
        if (rel?.id) {
          projectIdCounts.set(rel.id, (projectIdCounts.get(rel.id) ?? 0) + 1);
        }
      }
    }
  }

  // Sort by frequency (most common first) and deduplicate
  const projectIds = Array.from(projectIdCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  if (projectIds.length > 0) {
    console.log(`Project relations extracted: ${projectIds.join(", ")} (from ${projectIdCounts.size} unique projects)`);
  } else {
    console.warn("No project relations found in sprint tasks");
  }

  // Resolve project IDs to names and assign to tasks
  const allTaskProjectIds = tasks.flatMap((t) => t.projectIds);
  const uniqueProjectIds = [...new Set(allTaskProjectIds)];
  let projectNameMap = new Map<string, string>();
  if (uniqueProjectIds.length > 0) {
    projectNameMap = await fetchPageTitles(config, uniqueProjectIds);
    console.log(`Project names resolved: ${Array.from(projectNameMap.entries()).map(([id, name]) => `${name}(${id.slice(0, 8)})`).join(", ")}`);
  }

  // Build task ID → project name mapping
  const taskProjectNameMap = new Map<string, string>();
  for (const task of tasks) {
    if (task.projectIds.length > 0) {
      const firstName = projectNameMap.get(task.projectIds[0]);
      if (firstName) {
        taskProjectNameMap.set(task.id, firstName);
      }
    }
  }

  const assignees = groupTasksByAssignee(tasks);

  // Assign project names to grouped tasks
  for (const assignee of assignees) {
    for (const task of assignee.tasks) {
      task.projectName = taskProjectNameMap.get(task.id) ?? null;
    }
  }

  const measurableTasks = metricTasks.filter(
    (task) => !/中止|cancel|abort/i.test(task.status ?? "")
  );
  const calculatedPlanSp = measurableTasks.reduce(
    (sum, task) => sum + (task.sp ?? 0),
    0
  );
  const calculatedProgressSp = measurableTasks.reduce(
    (sum, task) => sum + (task.sp ?? 0) * statusProgressRate(task.status),
    0
  );
  const planSp = sprint.planSp ?? Math.round(calculatedPlanSp * 10) / 10;
  const progressSp = sprint.progressSp ?? Math.round(calculatedProgressSp * 10) / 10;
  const today = toJstDateString(now);
  const remainingDays = Math.max(
    1,
    Math.ceil(
      (new Date(`${sprint.end_date}T00:00:00Z`).getTime() -
        new Date(`${today}T00:00:00Z`).getTime()) /
        86400000
    )
  );
  const requiredSpPerDay =
    sprint.requiredSpPerDay ??
    Math.round((Math.max(0, planSp - progressSp) / remainingDays) * 100) / 100;

  return {
    sprint: {
      id: sprint.id,
      name: sprint.name,
      start_date: sprint.start_date,
      end_date: sprint.end_date,
      status: sprint.status
    },
    sprint_metrics: {
      plan_sp: planSp,
      progress_sp: progressSp,
      required_sp_per_day: requiredSpPerDay
    },
    assignees,
    projectIds
  };
}

/**
 * 期限(「期限」プロパティ)が [startDate, endDate] に入る未完了タスクを、スプリントに関係なく取得する。
 * extractTaskRow が完了タスクを除外し、担当者ごとにグルーピング＋プロジェクト名を解決して返す。
 * タスクリマインド（期限ベース）用。
 */
export async function fetchTasksByDueRange(
  config: AppConfig,
  startDate: string | null,
  endDate: string,
  dueProperty = "期限",
  opts: { includeNoDue?: boolean; includeCompleted?: boolean } = {}
): Promise<{ assignees: SprintTasksSummary["assignees"] }> {
  const taskDbId = await resolveDatabaseId(config, {
    url: config.taskDbUrl,
    name: config.taskDbName,
    label: "TASK_DB"
  });

  // Notion は1つの date 条件に on_or_after と on_or_before を同時指定できない。
  // 両端で絞るには and 複合フィルタにする必要がある。
  // startDate=null のときは下限なし(=過去の期限切れを全部含む)。
  const dateConds: any[] = [];
  if (startDate) dateConds.push({ property: dueProperty, date: { on_or_after: startDate } });
  dateConds.push({ property: dueProperty, date: { on_or_before: endDate } });
  const rangeFilter = dateConds.length > 1 ? { and: dateConds } : dateConds[0];
  // includeNoDue=true のときは「期限が範囲内 OR 期限未設定」を対象にする。
  const filter = opts.includeNoDue
    ? { or: [rangeFilter, { property: dueProperty, date: { is_empty: true } }] }
    : rangeFilter;

  const taskPages = await queryDatabase(
    config,
    taskDbId,
    {
      filter,
      sorts: [{ property: dueProperty, direction: "ascending" }]
    },
    10
  );

  const tasks: TaskRow[] = [];
  for (const page of taskPages) {
    const task = extractTaskRow(page, { includeCompleted: opts.includeCompleted }); // 既定では完了タスクは null
    if (task) tasks.push(task);
  }

  const assignees = groupTasksByAssignee(tasks);

  // プロジェクト名を解決して各タスクに付与（fetchCurrentSprintTasksSummary と同じ手順）
  const uniqueProjectIds = [...new Set(tasks.flatMap((t) => t.projectIds))];
  if (uniqueProjectIds.length > 0) {
    const projectNameMap = await fetchPageTitles(config, uniqueProjectIds);
    const taskProjectNameMap = new Map<string, string>();
    for (const task of tasks) {
      if (task.projectIds.length > 0) {
        const firstName = projectNameMap.get(task.projectIds[0]);
        if (firstName) taskProjectNameMap.set(task.id, firstName);
      }
    }
    for (const assignee of assignees) {
      for (const task of assignee.tasks) {
        task.projectName = taskProjectNameMap.get(task.id) ?? null;
      }
    }
  }

  console.log(`fetchTasksByDueRange: ${tasks.length} tasks in ${startDate ?? "(下限なし)"}~${endDate}${opts.includeNoDue ? "+期限なし" : ""} across ${assignees.length} assignees`);
  return { assignees };
}

/**
 * バーンダウン用: 指定スプリントの全タスク（完了含む）から SP・ステータス・完了日・期限 を取得する。
 * extractTaskRow は完了タスクを除外するため、ここでは専用に抽出する。
 */
export async function fetchSprintBurndownTasks(
  config: AppConfig,
  sprintId: string
): Promise<Array<{ sp: number; status: string | null; completedDate: string | null; due: string | null }>> {
  const taskDbId = await resolveDatabaseId(config, {
    url: config.taskDbUrl,
    name: config.taskDbName,
    label: "TASK_DB"
  });
  const vDates = virtualSprintDates(sprintId);
  const sprintFilter = vDates
    ? buildSprintTaskFilter(config, { id: sprintId, ...vDates })
    : { property: config.taskSprintRelationProperty, relation: { contains: sprintId } };
  const pages = await queryDatabase(
    config,
    taskDbId,
    { filter: sprintFilter },
    10
  );
  return pages.map((page: any) => {
    const props = page?.properties ?? {};
    const statusProp =
      getPropertyByName(props, ["ステータス", "Status", "状態"]) ||
      findPropertiesByType(props, "status")[0]?.value;
    const status = getStatusName(statusProp) ?? null;
    const sp =
      asNumber(props?.SP) ?? asNumber(props?.ポイント) ?? asNumber(props?.["Story Points"]) ?? 0;
    const doneProp = getPropertyByName(props, ["完了日", "Completed Date", "完了"]);
    const completedDate = normalizeDateString(getDateValue(doneProp)?.start) ?? null;
    const dueProp = getPropertyByName(props, ["期限", "Due", "Due Date"]);
    const dueVal = getDateValue(dueProp);
    // レンジ期限は終了日が締切
    const due = normalizeDateString(dueVal?.end ?? dueVal?.start) ?? null;
    return { sp: sp ?? 0, status, completedDate, due };
  });
}

export interface SprintDashboardTask {
  id: string;
  url?: string;
  name: string;
  sp: number;
  status: string | null;
  assignees: string[];
  projectNames: string[];
  priority?: string | null;
  sprintClass?: string | null;
  budgetHours?: number | null;
  actualHours?: number | null;
  remainingHours?: number | null;
  /** Notion に明示的な完了日がある場合のみ。 */
  completedDate: string | null;
  /** 完了日がない既存タスクの初回履歴推定に使う JST 日付。 */
  lastEditedDate: string | null;
  /** Planning 品質チェックに使う完了条件。 */
  completionCriteria?: string;
  /** 仮想 Sprint で使うタスク期限。 */
  dueDate?: string | null;
}

export interface SprintCheckpointRecord {
  id: string;
  name: string;
  kind: string | null;
  status: string | null;
  goal: string;
  checkpoint: string;
  checkpointDue: string | null;
  taskIds: string[];
  projectNames: string[];
  health: string | null;
}

/**
 * スプリントのゲーミフィケーション画像用データ。
 * 現時点の完了SPはステータスから正確に集計し、過去推移の初回推定だけ
 * last_edited_time を利用する。以後の推移は KV の日次スナップショットを使う。
 */
export async function fetchSprintDashboardTasks(
  config: AppConfig,
  sprintId: string,
  opts: { resolveProjects?: boolean } = {}
): Promise<SprintDashboardTask[]> {
  const taskDbId = await resolveDatabaseId(config, {
    url: config.taskDbUrl,
    name: config.taskDbName,
    label: "TASK_DB"
  });
  const vDates = virtualSprintDates(sprintId);
  const sprintFilter = vDates
    ? buildSprintTaskFilter(config, { id: sprintId, ...vDates })
    : { property: config.taskSprintRelationProperty, relation: { contains: sprintId } };
  const pages = await queryDatabase(
    config,
    taskDbId,
    { filter: sprintFilter },
    10
  );

  const extracted = pages.map((page: any) => {
    const props = page?.properties ?? {};
    const statusProp =
      getPropertyByName(props, ["ステータス", "Status", "状態"]) ||
      findPropertiesByType(props, "status")[0]?.value;
    const assigneeProp =
      getPropertyByName(props, ["担当者", "Assignee", "Owner"]) ||
      (findPropertiesByType(props, "people").length === 1
        ? findPropertiesByType(props, "people")[0].value
        : undefined);
    const completedProp = getPropertyByName(props, [
      "完了日",
      "Completed Date",
      "Completion Date"
    ]);
    const dueProp = getPropertyByName(props, ["期限", "Due", "Due Date"]);
    const completionCriteriaProp = getPropertyByName(props, [
      "完了条件",
      "Acceptance Criteria",
      "Done Definition"
    ]);
    const priorityProp = getPropertyByName(props, ["優先度", "Priority"]);
    const sprintClassProp = getPropertyByName(props, ["Sprint区分", "Sprint Class"]);
    const lastEditedDate =
      typeof page?.last_edited_time === "string"
        ? new Date(new Date(page.last_edited_time).getTime() + 9 * 3600 * 1000)
            .toISOString()
            .slice(0, 10)
        : null;
    const projectProp = getPropertyByName(props, ["プロジェクト", "Project"]);
    const projectIds: string[] =
      projectProp?.type === "relation" && Array.isArray(projectProp.relation)
        ? projectProp.relation
            .map((relation: any) => relation?.id)
            .filter((id: unknown): id is string => typeof id === "string")
        : [];

    return {
      id: String(page?.id ?? ""),
      url: String(page?.url ?? ""),
      name: getTitleFromProperties(props, ["名前", "Name"]),
      sp:
        asNumber(props?.SP) ??
        asNumber(props?.ポイント) ??
        asNumber(props?.["Story Points"]) ??
        0,
      status: getStatusName(statusProp) ?? null,
      assignees: getPeopleNames(assigneeProp),
      priority: getStatusName(priorityProp) ?? null,
      sprintClass: getStatusName(sprintClassProp) ?? null,
      budgetHours: asNumber(props?.["工数予算(h)"]),
      actualHours: asNumber(props?.["実績工数(h)"]),
      remainingHours: asNumber(props?.["残工数(h)"]),
      projectIds,
      completedDate:
        normalizeDateString(getDateValue(completedProp)?.start) ?? null,
      lastEditedDate,
      completionCriteria: titleFromRichText(completionCriteriaProp?.rich_text),
      dueDate:
        normalizeDateString(
          getDateValue(dueProp)?.end ?? getDateValue(dueProp)?.start
        ) ?? null
    };
  });

  const projectIds: string[] = [
    ...new Set(extracted.flatMap((task) => task.projectIds))
  ];
  const projectTitles =
    opts.resolveProjects !== false && projectIds.length > 0
      ? await fetchPageTitles(config, projectIds)
      : new Map<string, string>();
  return extracted.map(({ projectIds: ids, ...task }) => ({
    ...task,
    projectNames: ids
      .map((id) => projectTitles.get(id))
      .filter((name): name is string => typeof name === "string" && name.length > 0)
  }));
}

/**
 * Sprint の成果到達点として使う Epic / Workstream 一覧を取得する。
 * DB が未設定・未共有でも日次管理本体は継続できるよう空配列へフォールバック可能なAPIにする。
 */
export async function fetchSprintCheckpointRecords(
  config: AppConfig
): Promise<SprintCheckpointRecord[]> {
  if (!config.epicDbId && !config.epicDbUrl && !config.epicDbName) return [];
  const epicDbId = await resolveDatabaseId(config, {
    url: config.epicDbUrl,
    name: config.epicDbName,
    label: "EPIC_DB"
  });
  const pages = await queryDatabase(config, epicDbId, {}, 5, { silent: true });
  const extracted = pages.map((page: any) => {
    const props = page?.properties ?? {};
    const taskProp = getPropertyByName(props, ["タスク", "Tasks"]);
    const projectProp = getPropertyByName(props, ["プロジェクト", "Project"]);
    const relationIds = (prop: any): string[] =>
      prop?.type === "relation" && Array.isArray(prop.relation)
        ? prop.relation
            .map((relation: any) => relation?.id)
            .filter((id: unknown): id is string => typeof id === "string")
        : [];
    const checkpointProp = getPropertyByName(props, ["次チェックポイント"]);
    const goalProp = getPropertyByName(props, ["ゴール", "Goal"]);
    const dueProp = getPropertyByName(props, ["チェックポイント期日"]);
    return {
      id: String(page?.id ?? ""),
      name: getTitleFromProperties(props, ["名前", "Name"]),
      kind: getStatusName(getPropertyByName(props, ["種別", "Type"])) ?? null,
      status: getStatusName(getPropertyByName(props, ["ステータス", "Status"])) ?? null,
      goal: titleFromRichText(goalProp?.rich_text),
      checkpoint: titleFromRichText(checkpointProp?.rich_text),
      checkpointDue:
        normalizeDateString(getDateValue(dueProp)?.end ?? getDateValue(dueProp)?.start) ?? null,
      taskIds: relationIds(taskProp),
      projectIds: relationIds(projectProp),
      health: getStatusName(getPropertyByName(props, ["Health", "ヘルス"])) ?? null
    };
  });
  const projectTitles = await fetchPageTitles(
    config,
    [...new Set(extracted.flatMap((item) => item.projectIds))]
  );
  return extracted.map(({ projectIds, ...item }) => ({
    ...item,
    projectNames: projectIds
      .map((id) => projectTitles.get(id))
      .filter((name): name is string => typeof name === "string" && name.length > 0)
  }));
}

/** Bot の日次判定を Epic / Workstream DB に反映する。Notion 4xx は想定内として静かに失敗させる。 */
export async function updateCheckpointHealth(
  config: AppConfig,
  pageId: string,
  update: {
    health: string;
    reason: string;
    judgedDate: string;
    sprintName: string;
    planSp: number;
    progressSp: number;
    doneSp: number;
  }
): Promise<boolean> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${config.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      properties: {
        Health: { select: { name: update.health } },
        判定理由: {
          rich_text: [
            { type: "text", text: { content: update.reason.slice(0, 1900) } }
          ]
        },
        最終判定日: { date: { start: update.judgedDate } },
        対象Sprint: {
          rich_text: [
            { type: "text", text: { content: update.sprintName.slice(0, 1900) } }
          ]
        },
        今Sprint計画SP: { number: update.planSp },
        今Sprint進捗SP: { number: update.progressSp },
        今Sprint完了SP: { number: update.doneSp }
      }
    })
  });
  return res.ok;
}

// ── Delivery OS（案件採算・FTE・Forecast）───────────────────────────────

const richTextValue = (prop: any): string | null => {
  if (!prop) return null;
  const items =
    prop.type === "rich_text"
      ? prop.rich_text
      : prop.type === "title"
        ? prop.title
        : [];
  const text = titleFromRichText(items);
  return text || null;
};

const urlValue = (prop: any): string | null =>
  prop?.type === "url" && typeof prop.url === "string" ? prop.url : null;

const relationIds = (prop: any): string[] =>
  prop?.type === "relation" && Array.isArray(prop.relation)
    ? prop.relation
        .map((relation: any) => relation?.id)
        .filter((id: unknown): id is string => typeof id === "string")
    : [];

/** Notion の percent format は API 上 0.5、通常 number は 50 のことがあるため表示値へ正規化する。 */
const asPercent = (prop: any): number | null => {
  const value = asNumber(prop);
  if (value == null) return null;
  return Math.abs(value) <= 1.5 ? value * 100 : value;
};

const dateStart = (prop: any): string | null =>
  normalizeDateString(getDateValue(prop)?.start) ?? null;

const isClosedProjectStatus = (status: string | null): boolean =>
  /完了|done|closed|cancel|中止|終了|クローズ|^チーム$/iu.test(status ?? "");

const extractDeliveryProject = (page: any): DeliveryProjectRecord => {
  const props = page?.properties ?? {};
  const owners = [
    ...getPeopleNames(getPropertyByName(props, ["PM"])),
    ...getPeopleNames(getPropertyByName(props, ["担当", "担当者", "Owner"]))
  ];
  return {
    id: String(page?.id ?? ""),
    url: typeof page?.url === "string" ? page.url : "",
    name: getTitleFromProperties(props, ["プロジェクト名", "名前", "Name"]),
    status: getStatusName(getPropertyByName(props, ["ステータス", "Status"])) ?? null,
    team: getStatusName(getPropertyByName(props, ["チーム", "Team"])) ?? null,
    owners: [...new Set(owners)],
    contractAmountManYen: asNumber(getPropertyByName(props, ["契約金額(万円)", "契約金額"])),
    allowedHours: asNumber(getPropertyByName(props, ["許容総工数(h)", "許容工数(h)"])),
    actualHours: asNumber(getPropertyByName(props, ["実績工数(h)", "実績工数"])),
    remainingHours: asNumber(getPropertyByName(props, ["残工数(h)", "残工数"])),
    forecastHours: asNumber(getPropertyByName(props, ["Forecast工数(h)", "Forecast工数", "見込工数(h)"])),
    effortBurnPercent: asPercent(getPropertyByName(props, ["工数消化率(%)", "工数消化率"])),
    outcomeProgressPercent: asPercent(getPropertyByName(props, ["成果進捗(%)", "成果進捗"])),
    burnGapPoints: asPercent(getPropertyByName(props, ["Burn Gap(pt)", "Burn Gap"])),
    revenueDensityManYenPerHour: asNumber(getPropertyByName(props, ["売上密度(万円/h)", "売上密度"])),
    currentHealth: getStatusName(getPropertyByName(props, ["Delivery Health", "Health"])) ?? null,
    internalDeadline: dateStart(getPropertyByName(props, ["Internal Deadline", "内部期限"])),
    ttfvDays: asNumber(getPropertyByName(props, ["TTFV(日)", "TTFV"])),
    evalPassPercent: asPercent(getPropertyByName(props, ["Eval合格率(%)", "Eval合格率"])),
    nextPhaseStatus: getStatusName(getPropertyByName(props, ["次Phase状況", "次フェーズ状況"])) ?? null,
    nextPhaseAmountManYen: asNumber(getPropertyByName(props, ["次Phase金額(万円)", "次フェーズ金額(万円)"])),
    nextPhaseProposalDue: dateStart(getPropertyByName(props, ["次Phase提案期限", "次フェーズ提案期限"]))
  };
};

const extractDeliveryTask = (page: any): DeliveryTaskRecord => {
  const props = page?.properties ?? {};
  const blocker = richTextValue(getPropertyByName(props, ["ブロッカー", "Blocker"]));
  return {
    id: String(page?.id ?? ""),
    url: typeof page?.url === "string" ? page.url : "",
    name: getTitleFromProperties(props, ["名前", "Name"]),
    status: getStatusName(getPropertyByName(props, ["ステータス", "Status"])) ?? null,
    assignees: getPeopleNames(getPropertyByName(props, ["担当者", "Assignee", "Owner"])),
    projectIds: relationIds(getPropertyByName(props, ["プロジェクト", "Project"])),
    budgetHours: asNumber(getPropertyByName(props, ["工数予算(h)", "工数予算"])),
    actualHours: asNumber(getPropertyByName(props, ["実績工数(h)", "実績工数"])),
    remainingHours: asNumber(getPropertyByName(props, ["残工数(h)", "残工数"])),
    evidenceUrl: urlValue(getPropertyByName(props, ["Evidence", "エビデンス"])),
    completionCriteria: richTextValue(getPropertyByName(props, ["完了条件", "Definition of Done"])),
    reuseType: getStatusName(getPropertyByName(props, ["再利用区分", "Reuse Type"])) ?? null,
    evalPercent: asPercent(getPropertyByName(props, ["Eval結果(%)", "Eval結果"])),
    blocker,
    blockerStartedAt: getDateValue(getPropertyByName(props, ["ブロッカー発生日"]))?.start ?? null,
    due: dateStart(getPropertyByName(props, ["期限", "Due", "Due Date"])),
    forecastCompletionDate: dateStart(getPropertyByName(props, ["見込完了日", "Forecast Completion"])),
    progressUpdatedDate: dateStart(getPropertyByName(props, ["進捗更新日", "Progress Updated"])),
    lastEditedTime: typeof page?.last_edited_time === "string" ? page.last_edited_time : null
  };
};

/** TeamK の進行中案件と、その案件に紐づくタスクを1つのスナップショットとして取得する。 */
export async function fetchDeliveryControlSnapshot(
  config: AppConfig,
  now = new Date()
): Promise<DeliverySnapshot> {
  if (!config.projectDbId) {
    throw new Error("PROJECT_DB_ID is required for Delivery Control");
  }
  const taskDbId =
    config.taskDbId ||
    (await resolveDatabaseId(config, {
      url: config.taskDbUrl,
      name: config.taskDbName,
      label: "TASK_DB"
    }));

  let projectPages: any[];
  try {
    projectPages = await queryDatabase(
      config,
      config.projectDbId,
      {
        filter: {
          property: "チーム",
          select: { equals: config.teamFilter }
        }
      },
      5,
      { silent: true }
    );
  } catch {
    // プロパティ名や型が変わっていても全件取得→JS側filterで正常動作を維持する。
    projectPages = await queryDatabase(config, config.projectDbId, {}, 5, { silent: true });
  }
  const projects = projectPages
    .map(extractDeliveryProject)
    .filter(
      (project) =>
        !isClosedProjectStatus(project.status) &&
        (!project.team || project.team.toLowerCase() === config.teamFilter.toLowerCase())
    );

  const taskPages: any[] = [];
  for (let offset = 0; offset < projects.length; offset += 25) {
    const ids = projects.slice(offset, offset + 25).map((project) => project.id);
    if (ids.length === 0) continue;
    const filter = {
      or: ids.map((id) => ({
        property: "プロジェクト",
        relation: { contains: id }
      }))
    };
    const batch = await queryDatabase(config, taskDbId, { filter }, 5, { silent: true });
    taskPages.push(...batch);
  }
  const uniqueTasks = new Map<string, DeliveryTaskRecord>();
  for (const page of taskPages) {
    const task = extractDeliveryTask(page);
    if (task.id) uniqueTasks.set(task.id, task);
  }
  return {
    today: toJstDateString(now),
    projects,
    tasks: [...uniqueTasks.values()]
  };
}

/** Delivery Health select をBot判定で更新する。4xxは想定内としてログを出さない。 */
export async function updateProjectDeliveryHealth(
  config: AppConfig,
  pageId: string,
  health: "🟢 Green" | "🟡 Yellow" | "🔴 Red"
): Promise<boolean> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${config.notionToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      properties: { "Delivery Health": { select: { name: health } } }
    })
  });
  return res.ok;
}

export interface CompletedTaskInfo {
  id: string;
  name: string;
  sp: number;
  status: string | null;
  assignees: string[];
  completedDate: string | null;
}

/**
 * スプリントに関係なく、「完了日」が [start, end] に入る全タスクを取得する。
 * 複数スプリントをまたぐ期間の「担当者ごとの消化SP集計」などに使う。
 */
export async function fetchCompletedTasksByDateRange(
  config: AppConfig,
  range: { start: string; end: string }
): Promise<CompletedTaskInfo[]> {
  const taskDbId = await resolveDatabaseId(config, {
    url: config.taskDbUrl,
    name: config.taskDbName,
    label: "TASK_DB"
  });

  const pages = await queryDatabase(
    config,
    taskDbId,
    {
      filter: {
        and: [
          { property: "完了日", date: { on_or_after: range.start } },
          { property: "完了日", date: { on_or_before: range.end } }
        ]
      }
    },
    10
  );

  return pages.map((page: any) => {
    const props = page?.properties ?? {};
    const statusProp =
      getPropertyByName(props, ["ステータス", "Status", "状態"]) ||
      findPropertiesByType(props, "status")[0]?.value;
    const assigneeProp =
      getPropertyByName(props, ["担当者", "Assignee", "Owner"]) ||
      (findPropertiesByType(props, "people").length === 1
        ? findPropertiesByType(props, "people")[0].value
        : undefined);
    const completedProp = getPropertyByName(props, [
      "完了日",
      "Completed Date",
      "Completion Date"
    ]);
    return {
      id: String(page?.id ?? ""),
      name: getTitleFromProperties(props, ["名前", "Name"]),
      sp:
        asNumber(props?.SP) ??
        asNumber(props?.ポイント) ??
        asNumber(props?.["Story Points"]) ??
        0,
      status: getStatusName(statusProp) ?? null,
      assignees: getPeopleNames(assigneeProp),
      completedDate: normalizeDateString(getDateValue(completedProp)?.start) ?? null
    };
  });
}

export interface MemberCapacity {
  name: string;
  totalHours: number;
  remainingHours: number;
  dailyHours: Record<string, number>;
}

// 曜日カラム名 → JS Date.getDay() の値
const DAY_COLUMN_MAP: Record<string, number> = {
  "日曜日": 0, "月曜日": 1, "火曜日": 2, "水曜日": 3,
  "木曜日": 4, "金曜日": 5, "土曜日": 6
};

// スプリントの曜日順（火曜始まり）
const SPRINT_DAY_ORDER = [2, 3, 4, 5, 6, 0, 1]; // 火水木金土日月

/**
 * スプリントページ内のキャパシティ子データベースから
 * 各メンバーの曜日別稼働時間と今日以降の残り稼働時間を取得する
 */
export async function fetchSprintCapacity(
  config: AppConfig,
  sprintPageId: string
): Promise<MemberCapacity[]> {
  // スプリントページの子ブロックを取得
  let blocksData: any;
  try {
    blocksData = await withRetry(
      async () => {
        const res = await fetch(
          `https://api.notion.com/v1/blocks/${sprintPageId}/children?page_size=100`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${config.notionToken}`,
              "Notion-Version": NOTION_VERSION
            }
          }
        );
        if (!res.ok) {
          const detail = await res.text();
          throw new Error(`Failed to fetch sprint page children: ${res.status} ${detail}`);
        }
        return (await res.json()) as any;
      },
      { label: "Notion fetchSprintCapacity" }
    );
  } catch (err) {
    console.warn((err as Error).message);
    return [];
  }
  const blocks = Array.isArray(blocksData.results) ? blocksData.results : [];

  // キャパシティDBを探す: タイトルマッチ or 曜日カラムを持つDBを検出
  let capacityDbId: string | null = null;
  const childDbs = blocks.filter((b: any) => b.type === "child_database");

  for (const db of childDbs) {
    const title = (db.child_database?.title ?? "") as string;
    if (title.includes("キャパシティ") || title.includes("Capacity")) {
      capacityDbId = db.id;
      break;
    }
  }

  // タイトルでマッチしなかった場合、中身をサンプルして曜日カラムがあるDBを探す
  if (!capacityDbId) {
    for (const db of childDbs) {
      try {
        const sample = await queryDatabase(config, db.id, {}, 1, { silent: true });
        if (sample.length === 0) continue;
        const props = Object.keys(sample[0]?.properties ?? {});
        const hasDayColumns = Object.keys(DAY_COLUMN_MAP).some((day) =>
          props.includes(day)
        );
        if (hasDayColumns) {
          capacityDbId = db.id;
          console.log(`Capacity DB detected by day columns: ${db.id}`);
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!capacityDbId) {
    return [];
  }

  // キャパシティDBをクエリ
  const dbResults = await queryDatabase(config, capacityDbId, {}, 3);

  // 今日の曜日（JST）
  const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayDow = nowJst.getUTCDay(); // 0=日, 1=月, ..., 6=土

  // 今日以降のスプリント曜日を取得
  const todayIndex = SPRINT_DAY_ORDER.indexOf(todayDow);
  const remainingDays = todayIndex >= 0
    ? SPRINT_DAY_ORDER.slice(todayIndex)
    : SPRINT_DAY_ORDER; // 見つからなければ全日

  const capacities: MemberCapacity[] = [];
  for (const page of dbResults) {
    const props = page?.properties ?? {};
    const name = getTitleFromProperties(props, [
      "名前", "Name", "メンバー", "Member"
    ]);
    if (!name || name === "(no title)") continue;

    // 曜日別の稼働時間を取得
    const dailyHours: Record<string, number> = {};
    let totalHours = 0;
    let remainingHours = 0;

    for (const [colName, dow] of Object.entries(DAY_COLUMN_MAP)) {
      const val = asNumber(props[colName]);
      if (val != null) {
        dailyHours[colName] = val;
        totalHours += val;
        if (remainingDays.includes(dow)) {
          remainingHours += val;
        }
      }
    }

    // 合計カラムがあればそちらを使う（ロールアップ等の場合）
    const totalProp = getPropertyByName(props, ["合計", "Total", "合計時間"]);
    const explicitTotal = asNumber(totalProp);
    if (explicitTotal != null) {
      totalHours = explicitTotal;
    }

    if (totalHours === 0 && remainingHours === 0) continue;

    capacities.push({ name, totalHours, remainingHours, dailyHours });
  }

  console.log(`Capacity data: today=${Object.entries(DAY_COLUMN_MAP).find(([,v]) => v === todayDow)?.[0]}, remaining days=${remainingDays.length}`,
    capacities.map((c) => `${c.name}: total=${c.totalHours}h, remaining=${c.remainingHours}h`));

  return capacities;
}

/**
 * Lightweight version of fetchCurrentSprintTasksSummary — fetches ONLY the current sprint info
 * (id, name, start_date, end_date) without querying task DB. Used in the create-task fast path
 * where we don't need the task list.
 */
export async function fetchCurrentSprintInfo(
  config: AppConfig,
  now: Date
): Promise<SprintTasksSummary> {
  if (!config.sprintDbUrl && !config.sprintDbName) {
    const sprint = computeVirtualSprint(now);
    return {
      sprint,
      sprint_metrics: { plan_sp: null, progress_sp: null, required_sp_per_day: null },
      assignees: [],
      projectIds: []
    };
  }

  const sprintDbId = await resolveDatabaseId(config, {
    url: config.sprintDbUrl,
    name: config.sprintDbName,
    label: "SPRINT_DB"
  });

  const dateProp = config.notionDateProperty;
  const sprintPages = await queryDatabase(config, sprintDbId, {}, 10);
  if (sprintPages.length === 0) {
    throw new Error("Sprint DB query returned no results");
  }

  const today = toJstDateString(now);
  const sprintCandidates = sprintPages
    .map((page) => extractSprintInfo(page, dateProp))
    .filter((sprint): sprint is SprintInfo => sprint != null);
  if (sprintCandidates.length === 0) {
    throw new Error("Sprint records did not contain a valid period property");
  }

  const sprint = selectCurrentSprint(sprintCandidates, today);
  if (!sprint) {
    throw new Error("Could not select current sprint");
  }

  return {
    sprint: {
      id: sprint.id,
      name: sprint.name,
      start_date: sprint.start_date,
      end_date: sprint.end_date,
      status: sprint.status
    },
    sprint_metrics: { plan_sp: null, progress_sp: null, required_sp_per_day: null },
    assignees: [],
    projectIds: []
  };
}

export async function fetchAllSprints(
  config: AppConfig,
  now?: Date
): Promise<Array<{ id: string; name: string; start_date: string; end_date: string; status: string }>> {
  if (!config.sprintDbUrl && !config.sprintDbName) {
    return computeVirtualSprintHistory(8, now ?? new Date());
  }

  const sprintDbId = await resolveDatabaseId(config, {
    url: config.sprintDbUrl,
    name: config.sprintDbName,
    label: "SPRINT_DB"
  });

  const dateProp = config.notionDateProperty;
  const sprintPages = await queryDatabase(config, sprintDbId, {}, 10);

  const sprints: Array<{ id: string; name: string; start_date: string; end_date: string; status: string }> = [];
  for (const page of sprintPages) {
    const info = extractSprintInfo(page, dateProp);
    if (!info) continue;
    sprints.push({
      id: info.id,
      name: info.name,
      start_date: info.start_date,
      end_date: info.end_date,
      status: info.status
    });
  }

  return sprints;
}

// ── Reference project page (read-only) ──────────────────────────────────────

export interface ReferenceItem {
  /** Section heading path, e.g. "MTG提出資料 > 1/21㈬定例報告資料" */
  section: string;
  content: string;
}

// タスクDBの「ステータス」プロパティの選択肢を取得（プロセス内キャッシュ）。
// LLM に実際の選択肢(doing(20%) 等)を渡し、ユーザーの曖昧指定をマッピングさせる。
let cachedStatusOptions: string[] | null = null;
export async function fetchTaskStatusOptions(config: AppConfig): Promise<string[]> {
  if (cachedStatusOptions) return cachedStatusOptions;
  const taskDbId = config.taskDbId || extractNotionIdFromUrl(config.taskDbUrl);
  if (!taskDbId) return [];
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${taskDbId}`, {
      headers: {
        Authorization: `Bearer ${config.notionToken}`,
        "Notion-Version": NOTION_VERSION,
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      properties?: Record<string, { type?: string; status?: { options?: Array<{ name?: string }> } }>;
    };
    const statusProp = data.properties?.["ステータス"];
    const options = statusProp?.status?.options ?? [];
    cachedStatusOptions = options.map((o) => o.name ?? "").filter((n) => n.length > 0);
    console.log(`Status options loaded: ${cachedStatusOptions.join(", ")}`);
    return cachedStatusOptions;
  } catch (err) {
    console.warn(`fetchTaskStatusOptions error: ${(err as Error).message}`);
    return [];
  }
}

export interface TaskProperties {
  name: string;
  status: string | null;
  assignees: string[];
  due: string | null;
  sp: number | null;
  project: string | null;
}

/** 単一ページの主要プロパティ（名前・ステータス・担当者・期限・SP・プロジェクト）を取得。Notion webhook の変更検出用。 */
export async function fetchTaskPropertiesById(
  config: AppConfig,
  pageId: string
): Promise<TaskProperties | null> {
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: {
        Authorization: `Bearer ${config.notionToken}`,
        "Notion-Version": NOTION_VERSION,
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { properties?: Record<string, any> };
    const props = data.properties ?? {};
    const name = getTitleFromProperties(props, ["名前", "Name", "name"]);
    const status = getStatusName(getPropertyByName(props, ["ステータス", "Status"])) ?? null;
    const assignees = getPeopleNames(getPropertyByName(props, ["担当者", "Assignee"]));
    const dateVal = getDateValue(getPropertyByName(props, ["期限", "Due", "期間"]));
    // レンジ期限は終了日が締切。snapshot 等と桁を揃えるため YYYY-MM-DD に正規化。
    const due = normalizeDateString(dateVal?.end ?? dateVal?.start) ?? null;
    const sp = asNumber(getPropertyByName(props, ["SP", "sp"]));
    const projectProp = getPropertyByName(props, ["プロジェクト", "Project"]);
    const projectId =
      projectProp?.type === "relation" && Array.isArray(projectProp.relation)
        ? projectProp.relation[0]?.id
        : undefined;
    const projectTitles = projectId ? await fetchPageTitles(config, [projectId]) : new Map<string, string>();
    const project = projectId ? projectTitles.get(projectId) ?? null : null;
    return { name, status, assignees, due, sp, project };
  } catch (err) {
    console.warn(`fetchTaskPropertiesById error: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Recursively fetch all text content from a Notion project page (read-only).
 * Used as context for LLM when creating tasks.
 * This page is NEVER written to — only used as reference.
 */
export async function fetchReferenceDbItems(
  config: AppConfig
): Promise<ReferenceItem[]> {
  if (!config.referenceDbId) return [];

  // Also fetch page properties (project name, status, team, etc.)
  const items: ReferenceItem[] = [];

  try {
    const pageRes = await withRetry(
      async () => {
        const res = await fetch(
          `https://api.notion.com/v1/pages/${config.referenceDbId}`,
          {
            headers: {
              Authorization: `Bearer ${config.notionToken}`,
              "Notion-Version": NOTION_VERSION
            }
          }
        );
        if (!res.ok) throw new Error(`Notion page fetch: ${res.status}`);
        return res.json() as Promise<any>;
      },
      { label: "Notion fetchReferencePage" }
    );

    // Extract page-level properties as summary
    const props = pageRes?.properties ?? {};
    const projName = getTitleFromProperties(props, ["プロジェクト名", "名前", "Name", "Title"]);
    const statusProp = getPropertyByName(props, ["ステータス", "Status"]);
    const status = getStatusName(statusProp) ?? "";
    const teamProp = getPropertyByName(props, ["チーム", "Team"]);
    const team = getStatusName(teamProp) ?? "";
    const devTeamProp = getPropertyByName(props, ["開発チーム"]);
    const devTeam = getStatusName(devTeamProp) ?? "";
    const dateProp = getPropertyByName(props, ["日付", "Date"]);
    const dateVal = getDateValue(dateProp);
    const mgr = getPeopleNames(getPropertyByName(props, ["管理者"]));
    const pm = getPeopleNames(getPropertyByName(props, ["PM"]));
    const tanto = getPeopleNames(getPropertyByName(props, ["担当"]));
    const eng = getPeopleNames(getPropertyByName(props, ["エンジニア"]));

    items.push({
      section: "プロジェクト概要",
      content: [
        `プロジェクト名: ${projName}`,
        `ステータス: ${status}`,
        `チーム: ${team}`,
        devTeam ? `開発チーム: ${devTeam}` : "",
        `期間: ${dateVal?.start ?? "?"} 〜 ${dateVal?.end ?? "?"}`,
        mgr.length > 0 ? `管理者: ${mgr.join(", ")}` : "",
        pm.length > 0 ? `PM: ${pm.join(", ")}` : "",
        tanto.length > 0 ? `担当: ${tanto.join(", ")}` : "",
        eng.length > 0 ? `エンジニア: ${eng.join(", ")}` : ""
      ].filter(Boolean).join("\n")
    });
  } catch (err) {
    console.warn(`Reference page properties fetch failed: ${(err as Error).message}`);
  }

  // Recursively read blocks
  await fetchBlocksRecursive(config, config.referenceDbId!, items, "", 0);

  console.log(`Reference page: fetched ${items.length} sections`);
  return items;
}

async function fetchBlocksRecursive(
  config: AppConfig,
  blockId: string,
  items: ReferenceItem[],
  parentSection: string,
  depth: number
): Promise<void> {
  if (depth > 3) return; // Don't go too deep

  let data: any;
  try {
    data = await withRetry(
      async () => {
        const res = await fetch(
          `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100`,
          {
            headers: {
              Authorization: `Bearer ${config.notionToken}`,
              "Notion-Version": NOTION_VERSION
            }
          }
        );
        if (!res.ok) throw new Error(`Notion blocks: ${res.status}`);
        return res.json();
      },
      { label: `Notion blocks ${blockId}` }
    );
  } catch {
    return;
  }

  const blocks = (data as any)?.results ?? [];
  let currentSection = parentSection;
  let textBuffer: string[] = [];

  const flushBuffer = () => {
    if (textBuffer.length > 0 && currentSection) {
      // Append to existing section or create new
      const existing = items.find((i) => i.section === currentSection);
      const text = textBuffer.join("\n");
      if (existing) {
        existing.content += "\n" + text;
      } else {
        items.push({ section: currentSection, content: text });
      }
      textBuffer = [];
    }
  };

  for (const block of blocks) {
    const btype = block.type as string;
    const hasChildren = block.has_children as boolean;

    if (btype === "child_database") {
      // Skip child databases (not accessible / separate concern)
      continue;
    }

    if (btype === "child_page") {
      flushBuffer();
      const pageTitle = block.child_page?.title ?? "";
      const section = parentSection ? `${parentSection} > ${pageTitle}` : pageTitle;
      if (hasChildren) {
        await fetchBlocksRecursive(config, block.id, items, section, depth + 1);
      }
      continue;
    }

    // Heading blocks — update current section
    if (btype.startsWith("heading_")) {
      flushBuffer();
      const rt = block[btype]?.rich_text ?? [];
      const text = rt.map((t: any) => t?.plain_text ?? "").join("");
      if (text) {
        currentSection = parentSection ? `${parentSection} > ${text}` : text;
      }
      if (hasChildren) {
        await fetchBlocksRecursive(config, block.id, items, currentSection, depth + 1);
      }
      continue;
    }

    // Toggle blocks
    if (btype === "toggle") {
      flushBuffer();
      const rt = block.toggle?.rich_text ?? [];
      const text = rt.map((t: any) => t?.plain_text ?? "").join("");
      const toggleSection = parentSection ? `${parentSection} > ${text}` : text;
      if (hasChildren) {
        await fetchBlocksRecursive(config, block.id, items, toggleSection, depth + 1);
      }
      continue;
    }

    // Column list — recurse into children
    if (btype === "column_list" || btype === "column") {
      if (hasChildren) {
        await fetchBlocksRecursive(config, block.id, items, currentSection, depth + 1);
      }
      continue;
    }

    // Text content blocks
    const content = block[btype];
    if (content?.rich_text) {
      const text = (content.rich_text as any[]).map((t) => t?.plain_text ?? "").join("");
      if (text.trim()) {
        const prefix =
          btype === "bulleted_list_item" ? "・" :
          btype === "numbered_list_item" ? "- " :
          btype === "callout" ? "📌 " : "";
        textBuffer.push(prefix + text.trim());
      }
    }

    // Code blocks
    if (btype === "code" && content?.rich_text) {
      const code = (content.rich_text as any[]).map((t) => t?.plain_text ?? "").join("");
      if (code.trim()) {
        textBuffer.push("```\n" + code.trim() + "\n```");
      }
    }

    // Recurse if has children (e.g. callout with children)
    if (hasChildren && btype !== "code") {
      flushBuffer();
      await fetchBlocksRecursive(config, block.id, items, currentSection, depth + 1);
    }
  }

  flushBuffer();
}

export function summarizeTasks(tasks: NotionTask[]): NotionTaskSummary[] {
  return tasks.map((t) => {
    const p = t.properties as any;
    const period = p?.期間?.date ?? undefined;
    const status = p?.ステータス?.status?.name ?? undefined;
    const planSp =
      asNumber(p?.確定計画SP) ?? asNumber(p?.計画SP) ?? asNumber(p?.計画ポイント);
    const doneSp =
      asNumber(p?.確定完了SP) ?? asNumber(p?.完了SP) ?? asNumber(p?.進捗ポイント);
    const progressSp =
      asNumber(p?.確定進捗SP) ?? asNumber(p?.進捗SP) ?? asNumber(p?.進捗ポイント);

    return {
      id: t.id,
      title: t.title,
      status,
      period,
      planSp,
      doneSp,
      progressSp
    };
  });
}
