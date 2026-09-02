import { getConfig, resolveTeamKChannelId, type Bindings, type AppConfig } from "./config";
import { listAllChannelConfigs, resolveConfig } from "./channelConfig";
import { buildDedupKey, hashPayload, isDuplicateAndRemember } from "./dedupe";
import { fetchSprintSummary, fetchFreeText, fetchSprintTasks } from "./notionMcp";
import {
  buildSlackPayload,
  postSlack,
  buildSprintTasksPayload,
  buildTasksPayload,
  buildAssigneeTasksPayload
} from "./slack";
import {
  validateResponse,
  validateSprintTasks,
  type SprintTasksSummary
} from "./schema";
import {
  fetchTasksInDateRange,
  summarizeTasks,
  fetchCurrentSprintTasksSummary,
  fetchSprintCapacity,
  fetchTasksByDueRange,
  fetchAllSprints,
  fetchSprintBurndownTasks,
  fetchSprintDashboardTasks,
  fetchSprintCheckpointRecords,
  updateCheckpointHealth,
  fetchCompletedTasksByDateRange,
  isCompletedStatus,
  type SprintDashboardTask,
  statusProgressRate,
  fetchTaskPropertiesById,
  fetchDeliveryControlSnapshot,
  updateProjectDeliveryHealth
} from "./notionApi";
import { buildBurndownSeries, buildBurndownPng, renderBurndownHtml } from "./burndown";
import {
  buildCurrentSpSnapshot,
  buildSpDashboardData,
  calculateSprintVelocity,
  buildSpDashboardPng,
  buildSpTaskDetailData,
  buildCombinedDashboardPng,
  spTaskDetailCanvasHeight,
  buildSpTaskDetailsPng,
  generateAiDashboardBackground,
  loadSpDashboardHistory,
  renderSpDashboardHtml,
  renderSpTaskDetailsHtml,
  saveSpDashboardSnapshot,
  spDashboardSlackComment,
  sprintPlanningSlackComment,
  spTaskDetailsSlackComment,
  type SpDashboardData,
  type SpTaskDetailData,
  type SprintDashboardInfo
} from "./spGamification";
import { handleSlackEvents, processKpiReply } from "./slackEvents";
import {
  handleSlackInteractions,
  buildPmReportButtons,
  buildEodReminderButtons,
  buildReminderDeliveryButtons,
  buildDailyCheckinButton,
  buildSprintPlanLockButton
} from "./slackInteractions";
import { fetchMembers } from "./memberApi";
import {
  fetchScrumTable,
  buildLivePlay,
  dateColumnIndex,
  emptyMembersForColumn,
  kpiTextColumnIndex,
  skillCategoryColumnIndex,
  formatMemberDaySymbols,
  buildWeeklyBoardNarration,
  type ScrumTable
} from "./s19Scrum";
import { getOrInferCadence } from "./kpiCadence";
import {
  computeKpiRiskAssessment,
  resolvePendingCommitments,
  computeStreaksAndPraise,
  type KpiRowContext
} from "./kpiRisk";
import { getKpiMemory, recentForItem, markCommitmentOutcome, clearKpiMemory, type KpiMemberMemory } from "./kpiMemory";
import {
  analyzeTasksAndMembers,
  generateAssigneeMessages,
  interpretRepliesAndPropose,
  matchTasksToSchedule,
  generateKpiNudge
} from "./llmAnalyzer";
import { chatPostMessage, conversationsOpen, uploadImageToSlack, uploadMultipleImagesToSlack, deleteSlackMessage, bulletListBlocks, findChannelIdByName, conversationsReplies } from "./slackBot";
import { refreshProjectCatalog, getCachedProjects } from "./projectCatalog";
import { refreshUserCatalog, getCachedUsers, ensureUserCatalog, resolveSlackUserIdByName, resolveMemberByName } from "./userCatalog";
import { buildTimelinePng, htmlToPng, renderTimelineHtml } from "./timeline";
import {
  assessSnapshot,
  calculateAssigneeCapacity,
  collectAssigneeUpdateGaps,
  collectExpansionReminders,
  deliveryAlertFingerprint,
  renderDeliveryAlerts,
  renderDeliveryDashboardHtml,
  renderDeliveryDigest,
  renderExpansionReminders,
  renderPortfolioSummary,
  renderUpdateReminder,
  isDailyUpdateTask,
  type DeliverySnapshot,
  type ProjectAssessment
} from "./deliveryControl";
import { captureAssigneeBoards, captureNotionTimeline, captureNotionTimelineDebug, captureNotionPage, debugNotionPageInfo, debugNotionRedirectTrap, debugNotionTableMeasure, probeBrowserCapabilities, fetchNotionAvatarMap, getNotionSession, DEFAULT_NOTION_BOARD_URL, DEFAULT_NOTION_TIMELINE_URL } from "./notionBoard";
import { fetchScheduleData, analyzeScheduleDeviation } from "./sheetsApi";
import {
  saveThreadState,
  savePmThread,
  getPmThread,
  addActiveThread,
  getActiveThreads,
  getReplies,
  toJstDateString,
  listAllPhoneReminders,
  savePhoneReminder,
  saveCronHeartbeat,
  getCronHeartbeat,
  getAllCronHeartbeats,
  hasCronAlertBeenSent,
  markCronAlertSent,
  saveTaskSnapshot,
  getTaskSnapshot,
  recordTaskCompletion,
  listTaskCompletions,
  type TaskCompletionRecord,
  saveCurrentTaskThread,
  getCurrentTaskThread,
  saveDayStartProgress,
  getDayStartProgress,
  type DayStartEntry,
  saveKpiThreadState,
  getKpiThreadState,
  saveTodayKpiThreadRef,
  getTodayKpiThreadRef,
  appendConversationTurn,
  type KpiThreadState,
  type KpiIncident,
  type KpiIncidentItem,
  saveDailyCheckinSession,
  saveSprintPlanLockSession,
  getSprintPlanBaseline,
  getSprintScopeFingerprint,
  saveSprintScopeFingerprint,
  type SprintPlanBaseline
} from "./workflow";
import { updateTaskSprintClass } from "./notionWriter";
import {
  buildSprintPlanningDraft,
  renderSprintPlanningDraft,
  toSprintPlanTaskSnapshots,
  buildSprintScopeDiff,
  renderSprintScopeDiff,
  type SprintScopeDiff
} from "./sprintPlanningAssistant";

interface Env extends Bindings {}

// ── CJK-aware fixed-width table helpers ────────────────────────────────────

function isWideChar(code: number): boolean {
  return (
    // Hangul Jamo
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x11a8 && code <= 0x11ff) ||
    // Enclosed Alphanumerics ①②③ etc.
    (code >= 0x2460 && code <= 0x24ff) ||
    // Arrows ← → ↑ ↓ ⇒ etc.（Slack等幅では全角幅で表示される）
    (code >= 0x2190 && code <= 0x21ff) ||
    // Box Drawing + Block Elements + Geometric Shapes ■□▲△○● etc.
    (code >= 0x2500 && code <= 0x25ff) ||
    // Miscellaneous Symbols + Dingbats ☆★☏ etc.
    (code >= 0x2600 && code <= 0x27bf) ||
    // Miscellaneous Symbols and Arrows
    (code >= 0x2b00 && code <= 0x2bff) ||
    // CJK Radicals → CJK Unified Ideographs (includes Hiragana, Katakana, Kanji)
    (code >= 0x2e80 && code <= 0x9fff) ||
    // Hangul Syllables
    (code >= 0xac00 && code <= 0xd7af) ||
    // CJK Compatibility Ideographs
    (code >= 0xf900 && code <= 0xfaff) ||
    // Vertical Forms + CJK Compatibility Forms
    (code >= 0xfe10 && code <= 0xfe6f) ||
    // Fullwidth Latin / Halfwidth CJK Forms
    (code >= 0xff01 && code <= 0xff60) ||
    // Fullwidth Signs
    (code >= 0xffe0 && code <= 0xffe6) ||
    // Emoji & Symbols (Misc Symbols and Pictographs, Emoticons, etc.)
    (code >= 0x1f000 && code <= 0x1fbff) ||
    // CJK Extensions B–G
    (code >= 0x20000 && code <= 0x3ffff)
  );
}

function getDisplayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    width += isWideChar(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

function padEndCjk(str: string, targetWidth: number): string {
  const diff = Math.max(0, targetWidth - getDisplayWidth(str));
  // \u5168\u89d2\u30b9\u30da\u30fc\u30b9(U+3000)\u4e3b\u4f53\u3067\u57cb\u3081\u308b\u3002Slack \u306e\u7b49\u5e45\u30d5\u30a9\u30f3\u30c8\u3067\u306f CJK \u3082\u5168\u89d2\u30b9\u30da\u30fc\u30b9\u3082 2\u5e45\u3067
  // \u30ec\u30f3\u30c0\u30ea\u30f3\u30b0\u3055\u308c\u308b\u305f\u3081\u3001\u534a\u89d2\u30b9\u30da\u30fc\u30b9\u3060\u3051\u3067\u57cb\u3081\u308b\u3088\u308a\u6841\u30ba\u30ec(\u7d2f\u7a4d\u30b5\u30d6\u30d4\u30af\u30bb\u30eb\u30c9\u30ea\u30d5\u30c8)\u304c\u51fa\u306b\u304f\u3044\u3002
  const fwSpaces = Math.floor(diff / 2);
  const hwRemainder = diff % 2;
  return str + "\u3000".repeat(fwSpaces) + " ".repeat(hwRemainder);
}

function formatShortDate(dateStr: string): string {
  const parts = dateStr.split("-");
  return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
}

// Known project abbreviation overrides (Japanese names etc. that can't be auto-abbreviated)
const PROJECT_ABBREVIATION_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ["三井住友海上", "MS"],
  ["川崎設備", "川設"],
  ["新菱冷熱工業", "新菱"],
]);
const projectAbbrCache = new Map<string, string>();
function abbreviateProject(name: string): string {
  if (projectAbbrCache.has(name)) return projectAbbrCache.get(name)!;
  for (const [pattern, abbr] of PROJECT_ABBREVIATION_OVERRIDES) {
    if (name === pattern || name.startsWith(pattern)) { projectAbbrCache.set(name, abbr); return abbr; }
  }
  if (name.length <= 3) { projectAbbrCache.set(name, name); return name; }
  const uppers = name.match(/[A-Z]/g);
  if (uppers && uppers.length >= 2) { const abbr = uppers.join(""); projectAbbrCache.set(name, abbr); return abbr; }
  const words = name.split(/[\s\-_・]+/).filter(Boolean);
  if (words.length >= 2) { const abbr = words.map((w) => w[0].toUpperCase()).join(""); projectAbbrCache.set(name, abbr); return abbr; }
  const abbr = /^[a-zA-Z]/.test(name) ? name.slice(0, 1).toUpperCase() : name.slice(0, 1);
  projectAbbrCache.set(name, abbr);
  return abbr;
}

type TaskTableRow = { name: string; project: string; status: string; priority: string; sp: string; due: string; alert?: string };
// 24時サマリー用（ステータス差分・進捗SP表示）
type ProgressTableRow = { name: string; project: string; statusDiff: string; spText: string };

/** タスク一覧の非表示判定: 完了 or 中止 は一覧に出さない（Pending/他者ボール/Backlog は表示）。 */
function isHiddenFromList(status: string | null | undefined): boolean {
  return isCompletedStatus(status) || /中止|キャンセル|cancel/i.test(status ?? "");
}

/** "doing(60%)" → "60%" に簡略化（doing 接頭辞を除去）。完了等はそのまま。 */
function simplifyStatus(status: string | null | undefined): string {
  if (!status) return "-";
  return status.replace(/doing\((\d+)%\)/g, "$1%");
}

/**
 * 期限と today（と送信タイミング reason）から行末アラート絵文字を返す。
 *   期限超過      → 🔥🔥🔥（常時）
 *   今日が期日    → 8:30:💪💪💪 / 14:00:🚨💪💪 / 20:00:🚨🚨💪（時刻が進むほど緊急）
 *   明日が期日    → 💪💪💪
 *   それ以外      → 空
 */
function deadlineAlert(
  due: string | null | undefined,
  today: string,
  status?: string | null,
  reason?: string
): string {
  if (!due) return "";
  if (status && isCompletedStatus(status)) return "";
  // ペンディング/中止/Backlog のタスクは期限アラート対象外（着手前 or 進行していないため）
  if (status && /ペンディング|中止|backlog|バックログ/i.test(status)) return "";
  const dueDate = new Date(due.slice(0, 10) + "T00:00:00Z");
  const todayDate = new Date(today + "T00:00:00Z");
  const days = Math.ceil((dueDate.getTime() - todayDate.getTime()) / 86400000);
  if (days < 0) return "🔥🔥🔥"; // 期限超過
  if (days === 0) {
    if (reason === "evening") return "🚨🚨💪"; // 20:00
    if (reason === "midday") return "🚨💪💪"; // 14:00
    return "💪💪💪"; // 8:30 / manual
  }
  if (days === 1) return "💪💪💪"; // 明日
  return "";
}

/** 定期送信のタスク表（タスク名/プロジェクト/ステータス/優先度/SP/期限 + 期限アラート）。 */
function renderTaskTable(tasks: TaskTableRow[]): string {
  const headers = ["タスク名", "プロジェクト", "ステータス", "優先度", "SP", "期限"];
  const keys: Array<Exclude<keyof TaskTableRow, "alert">> = ["name", "project", "status", "priority", "sp", "due"];
  const colWidths = keys.map((k, i) =>
    Math.max(getDisplayWidth(headers[i]), ...tasks.map((t) => getDisplayWidth(t[k])))
  );
  const lines: string[] = ["```"];
  lines.push(headers.map((h, i) => padEndCjk(h, colWidths[i])).join("  "));
  lines.push(colWidths.map((w) => "-".repeat(w)).join("  "));
  for (const task of tasks) {
    const row = keys
      .map((k, i) => (i === keys.length - 1 ? task[k] : padEndCjk(task[k], colWidths[i])))
      .join("  ");
    lines.push(task.alert ? `${row}  ${task.alert}` : row);
  }
  lines.push("```");
  return lines.join("\n");
}

/** 24時サマリー用のタスク表（タスク名/プロジェクト/ステータス差分/SP（進捗SP））。 */
function renderProgressTable(rows: ProgressTableRow[]): string {
  const headers = ["タスク名", "プロジェクト", "ステータス差分", "SP（進捗SP）"];
  const keys: (keyof ProgressTableRow)[] = ["name", "project", "statusDiff", "spText"];
  const colWidths = keys.map((k, i) =>
    Math.max(getDisplayWidth(headers[i]), ...rows.map((t) => getDisplayWidth(t[k])))
  );
  const lines: string[] = ["```"];
  lines.push(headers.map((h, i) => padEndCjk(h, colWidths[i])).join("  "));
  lines.push(colWidths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) {
    lines.push(keys.map((k, i) => (i === keys.length - 1 ? r[k] : padEndCjk(r[k], colWidths[i]))).join("  "));
  }
  lines.push("```");
  return lines.join("\n");
}

/** 定期送信用: Notion タスク1件を表示行に変換（ステータスは doing(N%)→N% に簡略化）。 */
function taskToTableRow(task: {
  name: string; status?: string | null; priority?: string | null; sp?: number | null; due?: string | null; dueTime?: string | null; projectName?: string | null;
}, today?: string, reason?: string): TaskTableRow {
  return {
    name: task.name,
    project: task.projectName ? abbreviateProject(task.projectName) : "-",
    status: simplifyStatus(task.status),
    priority: task.priority ?? "-",
    sp: task.sp != null ? String(task.sp) : "-",
    // 期日に時刻があれば "M/D HH:MM"、無ければ "M/D"
    due: task.due ? formatShortDate(task.due) + (task.dueTime ? ` ${task.dueTime}` : "") : "-",
    alert: today ? deadlineAlert(task.due, today, task.status, reason) : ""
  };
}

/** 24時サマリー用: 朝の起点と比較してステータス差分・進捗SP行を作る。 */
function taskToProgressRow(
  task: { name: string; status: string | null; sp: number | null; projectName: string | null },
  dayStart: { status: string | null; sp: number | null }
): ProgressTableRow {
  const curStatus = simplifyStatus(task.status);
  const startStatus = simplifyStatus(dayStart.status);
  const statusDiff = startStatus !== curStatus ? `${startStatus} → ${curStatus}` : curStatus;
  const sp = task.sp ?? dayStart.sp ?? 0;
  const delta =
    Math.round((sp * statusProgressRate(task.status) - sp * statusProgressRate(dayStart.status)) * 10) / 10;
  const spText = delta > 0 ? `${task.sp ?? sp}（+${delta}）` : (task.sp != null ? String(task.sp) : "-");
  return {
    name: task.name,
    project: task.projectName ? abbreviateProject(task.projectName) : "-",
    statusDiff,
    spText
  };
}

function formatDeadlineTasksTable(
  summary: SprintTasksSummary,
  today: string,
  daysThreshold: number = 2
): string {
  const todayDate = new Date(today + "T00:00:00Z");

  const groups = new Map<
    string,
    Array<{ name: string; status: string; priority: string; sp: string; due: string }>
  >();

  for (const assignee of summary.assignees) {
    for (const task of assignee.tasks) {
      if (isHiddenFromList(task.status)) continue;
      if (!task.due) continue;
      const dueDate = new Date(task.due + "T00:00:00Z");
      const daysRemaining = Math.ceil(
        (dueDate.getTime() - todayDate.getTime()) / 86400000
      );
      if (daysRemaining > daysThreshold) continue;
      const group = groups.get(assignee.name) ?? [];
      // Prefix task name with project abbreviation if available
      const projectPrefix = task.projectName
        ? `【${abbreviateProject(task.projectName)}】`
        : "";
      group.push({
        name: projectPrefix + task.name,
        status: task.status ?? "-",
        priority: task.priority ?? "-",
        sp: task.sp != null ? String(task.sp) : "-",
        due: formatShortDate(task.due)
      });
      groups.set(assignee.name, group);
    }
  }

  if (groups.size === 0) {
    return "【残り期限2日のタスク状況】\n```\n該当タスクなし\n```";
  }

  const sections: string[] = ["【残り期限2日のタスク状況】"];
  const headers = ["タスク名", "ステータス", "優先度", "SP", "期限"];

  for (const [assigneeName, tasks] of groups) {
    const colWidths = [
      Math.max(getDisplayWidth(headers[0]), ...tasks.map((t) => getDisplayWidth(t.name))),
      Math.max(getDisplayWidth(headers[1]), ...tasks.map((t) => getDisplayWidth(t.status))),
      Math.max(getDisplayWidth(headers[2]), ...tasks.map((t) => getDisplayWidth(t.priority))),
      Math.max(getDisplayWidth(headers[3]), ...tasks.map((t) => getDisplayWidth(t.sp))),
      Math.max(getDisplayWidth(headers[4]), ...tasks.map((t) => getDisplayWidth(t.due)))
    ];

    const lines: string[] = [];
    lines.push(`*${assigneeName}*`);
    lines.push("```");
    lines.push(
      headers.map((h, i) => padEndCjk(h, colWidths[i])).join("  ")
    );
    lines.push(colWidths.map((w) => "-".repeat(w)).join("  "));
    for (const task of tasks) {
      lines.push(
        padEndCjk(task.name, colWidths[0]) + "  " +
        padEndCjk(task.status, colWidths[1]) + "  " +
        padEndCjk(task.priority, colWidths[2]) + "  " +
        padEndCjk(task.sp, colWidths[3]) + "  " +
        task.due
      );
    }
    lines.push("```");
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

/**
 * 【スケジュール分析】セクションをコードで生成する（固定フォーマット）。
 * スプリント消化率・残り日数・必要SP/日・平均消化SP から オンスケ/注意/危険 を判定。
 */
function buildScheduleAnalysis(
  summary: SprintTasksSummary,
  avgDailySp: number | null,
  today: string
): string {
  const m = summary.sprint_metrics;
  const planSp = m?.plan_sp ?? null;
  const progressSp = m?.progress_sp ?? null;
  const remainingSp = planSp != null && progressSp != null ? planSp - progressSp : null;

  const todayDate = new Date(today + "T00:00:00Z");
  const endDate = new Date(summary.sprint.end_date + "T00:00:00Z");
  const remainingDays = Math.max(
    1,
    Math.ceil((endDate.getTime() - todayDate.getTime()) / 86400000)
  );
  const requiredPerDay = m?.required_sp_per_day ??
    (remainingSp != null ? Math.round((remainingSp / remainingDays) * 100) / 100 : null);

  // 判定: 残りSP/残り日数 と 平均消化SP の比較
  let verdict = "—";
  if (remainingSp != null && avgDailySp != null && avgDailySp > 0) {
    const needPerDay = remainingSp / remainingDays;
    if (needPerDay <= avgDailySp) verdict = "🟢 オンスケ";
    else if (remainingDays <= 2) verdict = "🔴 危険（期限直前で間に合わないペース）";
    else verdict = "🟡 注意（今のペースだと間に合わない）";
  }

  const fmt = (v: number | null): string => (v == null ? "-" : String(v));
  const body = [
    `・スプリント: ${summary.sprint.name}（${summary.sprint.start_date} ～ ${summary.sprint.end_date}）`,
    `・計画SP: ${fmt(planSp)} / 進捗SP: ${fmt(progressSp)} / 残りSP: ${fmt(remainingSp)}`,
    `・残り日数: ${remainingDays} 日`,
    `・必要SP/日: ${fmt(requiredPerDay)} SP/日`,
    `・過去7日平均消化SP: ${avgDailySp != null ? avgDailySp.toFixed(1) : "-"} SP/日`,
    `・判定: ${verdict}`
  ].join("\n");
  return "【スケジュール分析】\n```\n" + body + "\n```";
}

/**
 * 担当者ごとのタスクテーブルを返す。期限による絞り込みは呼び出し側(fetchTasksByDueRange)で
 * 済んでいる前提で、ここでは未完了タスクのみをテーブル化する。
 * 1人1メッセージで個別送信するため、{担当者名, テーブル文字列} の配列で返す。
 */
function buildPerMemberTaskTables(
  assignees: SprintTasksSummary["assignees"],
  today?: string,
  reason?: string
): Array<{ assigneeName: string; tableText: string }> {
  const result: Array<{ assigneeName: string; tableText: string }> = [];
  for (const assignee of assignees) {
    if (assignee.name === "未割当") continue; // 担当者なしのタスクはリマインド対象外
    const rows = assignee.tasks
      .filter((t) => !isHiddenFromList(t.status))
      .map((t) => taskToTableRow(t, today, reason));
    if (rows.length === 0) continue;
    result.push({ assigneeName: assignee.name, tableText: renderTaskTable(rows) });
  }
  return result;
}

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });

type SprintTasksMeta = {
  metrics: {
    planSp: number | null;
    progressSp: number | null;
    remainingSp: number | null;
    requiredSpPerDay: number | null;
  };
  changes: {
    totalProgressSp: number;
    items: string[];
  };
};

async function buildSprintTasksMeta(
  env: Env,
  summary: SprintTasksSummary,
  config: AppConfig,
  now: Date
): Promise<SprintTasksMeta> {
  const todayKey = toJstDateString(now);
  const dateLabel = todayKey.slice(5).replace("-", "/"); // "MM/DD"
  const yesterdayKey = toJstDateString(now, -1);
  const snapshotKey = `sprint-task-snapshot:${summary.sprint.id}:${todayKey}`;
  const previousKey = `sprint-task-snapshot:${summary.sprint.id}:${yesterdayKey}`;
  // 未完了タスクのスナップショット（表示・変更検出用）
  const currentSnapshot = summary.assignees.flatMap((assignee) =>
    assignee.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      status: task.status ?? null,
      sp: task.sp ?? null
    }))
  );

  // 完了タスクも含めたスナップショットをKVに保存（calculateAvgDailySpConsumption が完了への遷移を検出するため）
  const fullSummary = await fetchCurrentSprintTasksSummary(config, now, { includeCompleted: true }).catch(() => null);
  const completedForSnapshot = (fullSummary?.assignees ?? [])
    .flatMap((a) => a.tasks)
    .filter((t) => isCompletedStatus(t.status ?? null))
    .map((t) => ({ id: t.id, name: t.name, status: t.status ?? null, sp: t.sp ?? null }));
  const fullSnapshot = [...currentSnapshot, ...completedForSnapshot];

  const previousSnapshot =
    ((await env.NOTIFY_CACHE.get(previousKey, "json")) as
      | typeof currentSnapshot
      | null) ?? [];
  const previousById = new Map(
    previousSnapshot.map((task) => [task.id, task])
  );
  const changeItems: string[] = [];
  let totalProgressSp = 0;

  for (const task of currentSnapshot) {
    const prev = previousById.get(task.id);
    if (!prev) continue;
    if (prev.status === task.status) continue;
    const before = prev.status ?? "-";
    const after = task.status ?? "-";
    changeItems.push(`• ${dateLabel} ${task.name} ${before} → ${after}`);
    if (typeof task.sp === "number") {
      totalProgressSp += task.sp;
    }
  }
  // 前日スナップショットにいて今日のスナップショットにいないタスク = 完了して消えた
  for (const [taskId, prevTask] of previousById) {
    if (!fullSnapshot.find((t) => t.id === taskId) && isCompletedStatus(null) === false) {
      if (prevTask.sp && !isCompletedStatus(prevTask.status)) {
        changeItems.push(`• ${dateLabel} ${prevTask.name} → 完了（スナップショット外）`);
        totalProgressSp += prevTask.sp;
      }
    }
  }

  await env.NOTIFY_CACHE.put(snapshotKey, JSON.stringify(fullSnapshot), {
    expirationTtl: config.dedupeTtlSeconds
  });

  const planSp =
    typeof summary.sprint_metrics?.plan_sp === "number"
      ? summary.sprint_metrics.plan_sp
      : null;
  const progressSp =
    typeof summary.sprint_metrics?.progress_sp === "number"
      ? summary.sprint_metrics.progress_sp
      : null;
  const remainingSp =
    planSp != null && progressSp != null ? planSp - progressSp : null;
  const endDate = new Date(`${summary.sprint.end_date}T00:00:00Z`);
  const startDate = new Date(`${summary.sprint.start_date}T00:00:00Z`);
  const totalDays =
    Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
  const elapsedDays =
    Math.ceil((now.getTime() - startDate.getTime()) / 86400000) + 1;
  const remainingDays = totalDays > 0 ? Math.max(totalDays - elapsedDays, 1) : 1;
  const requiredSpPerDay =
    typeof summary.sprint_metrics?.required_sp_per_day === "number"
      ? summary.sprint_metrics.required_sp_per_day
      : remainingSp != null
      ? Math.round((remainingSp / remainingDays) * 100) / 100
      : null;

  return {
    metrics: {
      planSp,
      progressSp,
      remainingSp,
      requiredSpPerDay
    },
    changes: {
      totalProgressSp,
      items: changeItems
    }
  };
}

async function runReport(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);
    const now = new Date();
    const raw = await fetchSprintSummary(config, now);
    const summary = validateResponse(raw);
    const dedupKey = buildDedupKey(summary);
    const hash = await hashPayload(summary);
    const isDup = await isDuplicateAndRemember(
      env,
      dedupKey,
      hash,
      config.dedupeTtlSeconds
    );

    if (isDup) {
      console.log("Duplicate notification skipped", { dedupKey, reason });
      return { ok: true, skipped: true, dedupKey };
    }

    const slackPayload = buildSlackPayload(summary);

    if (config.dryRun) {
      console.log("DRY_RUN: payload not sent", slackPayload);
      return { ok: true, dryRun: true, summary };
    }

    if (!config.slackWebhookUrl) {
      console.warn("SLACK_WEBHOOK_URL not set; skipping webhook post");
      return { ok: true, skipped: true, reason: "no webhook url" };
    }

    await postSlack(config.slackWebhookUrl, slackPayload);
    console.log("Slack notification sent", { dedupKey, reason });
    return { ok: true, dedupKey };
  } catch (error) {
    const err = error as Error;
    console.error("runReport failed", err);
    if (config) {
      await notifyError(env, config, err);
    }
    return { ok: false, error: err.message };
  }
}

async function runSprintTasksReport(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);
    const now = new Date();
    const raw = await fetchSprintTasks(config, now);
    const summary = validateSprintTasks(raw);
    const { metrics, changes } = await buildSprintTasksMeta(
      env,
      summary,
      config,
      now
    );

    const dedupKey = `sprint-tasks:${summary.sprint.id}`;
    const hash = await hashPayload(summary);
    const isDup = await isDuplicateAndRemember(
      env,
      dedupKey,
      hash,
      config.dedupeTtlSeconds
    );

    if (isDup) {
      console.log("Duplicate sprint tasks notification skipped", {
        dedupKey,
        reason
      });
      return { ok: true, skipped: true, dedupKey };
    }

    const slackPayload = buildSprintTasksPayload(
      summary,
      metrics,
      changes
    );

    if (config.dryRun) {
      console.log("DRY_RUN: sprint tasks payload not sent", slackPayload);
      return { ok: true, dryRun: true, summary };
    }

    if (!config.slackWebhookUrl) {
      console.warn("SLACK_WEBHOOK_URL not set; skipping webhook post");
      return { ok: true, skipped: true, reason: "no webhook url" };
    }

    await postSlack(config.slackWebhookUrl, slackPayload);
    console.log("Sprint tasks notification sent", { dedupKey, reason });
    return { ok: true, dedupKey };
  } catch (error) {
    const err = error as Error;
    console.error("runSprintTasksReport failed", err);
    if (config) {
      await notifyError(env, config, err);
    }
    return { ok: false, error: err.message };
  }
}

async function runAssigneeTasksReport(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);
    const now = new Date();
    const summary = await fetchCurrentSprintTasksSummary(config, now);
    const { metrics, changes } = await buildSprintTasksMeta(
      env,
      summary,
      config,
      now
    );
    const slackPayload = buildAssigneeTasksPayload(summary, {
      metrics,
      changes
    });
    const count = summary.assignees.reduce(
      (total, assignee) => total + assignee.tasks.length,
      0
    );

    if (config.dryRun) {
      console.log("DRY_RUN: assignee tasks payload not sent", {
        reason,
        count
      });
      return { ok: true, dryRun: true, count, summary };
    }

    if (!config.slackWebhookUrl) {
      console.warn("SLACK_WEBHOOK_URL not set; skipping webhook post");
      return { ok: true, skipped: true, reason: "no webhook url" };
    }

    await postSlack(config.slackWebhookUrl, slackPayload);
    console.log("Assignee tasks notification sent", { reason, count });
    return { ok: true, count };
  } catch (error) {
    const err = error as Error;
    console.error("runAssigneeTasksReport failed", err);
    if (config) {
      await notifyError(env, config, err);
    }
    return { ok: false, error: err.message };
  }
}

// ── SP consumption rate calculation ────────────────────────────────────────

interface TaskSnapshot {
  id: string;
  name: string;
  status: string | null;
  sp: number | null;
}

/**
 * Calculate average daily SP consumption over the past 7 days from KV snapshots.
 * Returns the average, or null if insufficient data.
 */
export async function calculateAvgDailySpConsumption(
  kv: KVNamespace,
  sprintId: string,
  today: string
): Promise<{ avgDailySp: number; daysWithData: number } | null> {
  const todayDate = new Date(today + "T00:00:00Z");
  let totalCompletedSp = 0;
  let daysWithData = 0;

  for (let i = 1; i <= 7; i++) {
    const d = new Date(todayDate);
    d.setUTCDate(d.getUTCDate() - i);
    const dateKey = d.toISOString().slice(0, 10);

    const prevD = new Date(d);
    prevD.setUTCDate(prevD.getUTCDate() - 1);
    const prevDateKey = prevD.toISOString().slice(0, 10);

    const currentRaw = await kv.get(`sprint-task-snapshot:${sprintId}:${dateKey}`, "json") as TaskSnapshot[] | null;
    const prevRaw = await kv.get(`sprint-task-snapshot:${sprintId}:${prevDateKey}`, "json") as TaskSnapshot[] | null;

    if (!currentRaw || !prevRaw) continue;

    const prevById = new Map(prevRaw.map((t) => [t.id, t]));
    let dailySp = 0;

    for (const task of currentRaw) {
      const prev = prevById.get(task.id);
      if (!prev) continue;
      if (isCompletedStatus(task.status) && !isCompletedStatus(prev.status)) {
        dailySp += task.sp ?? 0;
      }
    }

    totalCompletedSp += dailySp;
    daysWithData++;
  }

  if (daysWithData === 0) return null;
  return {
    avgDailySp: totalCompletedSp / daysWithData,
    daysWithData
  };
}

/**
 * Fallback: calculate average daily SP from sprint data + current tasks.
 *
 * 1. plan_sp があれば: progress_sp = plan_sp - remaining_sp → avgDaily = progress_sp / elapsed_days
 * 2. plan_sp がなくても: remaining_sp / remaining_days で「必要ペース」を返す（判定基準として使える）
 */
export function calcAvgDailySpFromSprint(
  summary: SprintTasksSummary,
  today: string
): number | null {
  const startDate = new Date(summary.sprint.start_date + "T00:00:00Z");
  const endDate = new Date(summary.sprint.end_date + "T00:00:00Z");
  const todayDate = new Date(today + "T00:00:00Z");

  const elapsedMs = todayDate.getTime() - startDate.getTime();
  const elapsedDays = Math.max(Math.ceil(elapsedMs / 86400000), 1);

  // Sum remaining SP from current (non-completed) tasks
  const remainingSp = summary.assignees.reduce(
    (sum, a) => sum + a.tasks.reduce((s, t) => s + (t.sp ?? 0), 0),
    0
  );

  // Try sprint-level progress_sp first
  let progressSp = summary.sprint_metrics?.progress_sp;

  // If not available, derive from plan_sp - remaining_sp
  if (typeof progressSp !== "number" && typeof summary.sprint_metrics?.plan_sp === "number") {
    progressSp = summary.sprint_metrics.plan_sp - remainingSp;
  }

  // If we have progress data, calculate actual daily pace
  if (typeof progressSp === "number" && progressSp > 0) {
    return Math.round((progressSp / elapsedDays) * 100) / 100;
  }

  // Last resort: use remaining SP / remaining days as baseline pace
  const remainingMs = endDate.getTime() - todayDate.getTime();
  const remainingDays = Math.max(Math.ceil(remainingMs / 86400000), 1);
  if (remainingSp > 0) {
    return Math.round((remainingSp / remainingDays) * 100) / 100;
  }

  return null;
}



/**
 * Detect Doing tasks that have had no status change for 2+ days (Step 2-A).
 * Returns a list of stagnant task IDs and names.
 */
export async function detectStagnantDoingTasks(
  kv: KVNamespace,
  sprintId: string,
  today: string,
  currentTasks: TaskSnapshot[]
): Promise<Array<{ id: string; name: string; staleDays: number }>> {
  const stagnant: Array<{ id: string; name: string; staleDays: number }> = [];
  const DOING_STATUSES = ["doing", "進行中", "in progress", "実行中"];

  // Current Doing tasks
  const doingTasks = currentTasks.filter((t) =>
    t.status && DOING_STATUSES.some((s) => t.status!.toLowerCase().includes(s))
  );

  if (doingTasks.length === 0) return [];

  // Check 2 days ago snapshot
  const twoDaysAgo = new Date(today + "T00:00:00Z");
  twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
  const twoDaysAgoKey = twoDaysAgo.toISOString().slice(0, 10);

  const oldSnapshot = await kv.get(
    `sprint-task-snapshot:${sprintId}:${twoDaysAgoKey}`,
    "json"
  ) as TaskSnapshot[] | null;

  if (!oldSnapshot) return [];

  const oldById = new Map(oldSnapshot.map((t) => [t.id, t]));

  for (const task of doingTasks) {
    const old = oldById.get(task.id);
    if (!old) continue;
    // Same status for 2+ days
    if (old.status === task.status) {
      stagnant.push({ id: task.id, name: task.name, staleDays: 2 });
    }
  }

  return stagnant;
}

/**
 * Compare current task snapshot with 7-day-old KV snapshot.
 * Returns completed tasks and newly added tasks during the period.
 */
export async function calculateWeeklyDiff(
  kv: KVNamespace,
  sprintId: string,
  today: string,
  currentTasks: TaskSnapshot[]
): Promise<{
  periodStart: string;
  periodEnd: string;
  completedTasks: Array<{ id: string; name: string; sp: number | null }>;
  totalCompletedSp: number;
  newTasks: Array<{ id: string; name: string; sp: number | null }>;
  totalNewSp: number;
} | null> {
  const todayDate = new Date(today + "T00:00:00Z");
  const weekAgo = new Date(todayDate);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
  const weekAgoKey = weekAgo.toISOString().slice(0, 10);

  const oldSnapshot = await kv.get(
    `sprint-task-snapshot:${sprintId}:${weekAgoKey}`,
    "json"
  ) as TaskSnapshot[] | null;

  if (!oldSnapshot) return null;

  const oldById = new Map(oldSnapshot.map((t) => [t.id, t]));
  const currentById = new Map(currentTasks.map((t) => [t.id, t]));

  // Tasks that were not completed in old snapshot but are now completed (or removed from current = completed)
  const completedTasks: Array<{ id: string; name: string; sp: number | null }> = [];
  for (const old of oldSnapshot) {
    if (isCompletedStatus(old.status)) continue; // already completed back then
    const current = currentById.get(old.id);
    // Task removed from current sprint (completed) or status changed to completed
    if (!current || isCompletedStatus(current.status)) {
      completedTasks.push({ id: old.id, name: old.name, sp: old.sp });
    }
  }

  // Tasks in current snapshot that didn't exist in old snapshot = newly added
  const newTasks: Array<{ id: string; name: string; sp: number | null }> = [];
  for (const task of currentTasks) {
    if (!oldById.has(task.id)) {
      newTasks.push({ id: task.id, name: task.name, sp: task.sp });
    }
  }

  const totalCompletedSp = completedTasks.reduce((sum, t) => sum + (t.sp ?? 0), 0);
  const totalNewSp = newTasks.reduce((sum, t) => sum + (t.sp ?? 0), 0);

  return {
    periodStart: weekAgoKey,
    periodEnd: today,
    completedTasks,
    totalCompletedSp,
    newTasks,
    totalNewSp
  };
}

// ── PMO AI Agent flows ─────────────────────────────────────────────────────

/** Member notification flow: Steps 1-4 (20:00 JST = 11:00 UTC, night before) */
async function runMorningFlow(
  env: Env,
  reason: string,
  targetName?: string | null,
  channelId?: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = channelId ? await resolveConfig(env, channelId) : getConfig(env);
    const targetChannel = channelId ?? config.slackPmoChannelId;

    if (!config.slackBotToken) {
      console.warn("SLACK_BOT_TOKEN not set; skipping morning flow");
      return { ok: true, skipped: true, reason: "no bot token" };
    }

    const now = new Date();
    const today = toJstDateString(now);
    const yesterdayKey = toJstDateString(now, -1);

    // Dedup: skip if already run today (prevents double-execution from cron + catch-up race)
    if (reason !== "manual") {
      const activeThreads = await getActiveThreads(env.NOTIFY_CACHE, today, channelId);
      if (activeThreads.length > 0) {
        console.log(`Morning flow: already run today (${activeThreads.length} active threads), skipping (reason=${reason})`);
        return { ok: true, skipped: true, reason: "already run today" };
      }
    }

    // Step 1: Fetch tasks and members
    const summary = await fetchCurrentSprintTasksSummary(config, now);
    const members = await fetchMembers(config);

    // Save current task snapshot for change detection
    const snapshotScope = channelId ? `task-snapshot:${channelId}:` : `task-snapshot:`;
    const currentSnapshot = summary.assignees.flatMap((a) =>
      a.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status ?? null,
        sp: t.sp ?? null
      }))
    );
    await env.NOTIFY_CACHE.put(
      `${snapshotScope}${today}`,
      JSON.stringify(currentSnapshot),
      { expirationTtl: config.dedupeTtlSeconds }
    );

    const previousSnapshot =
      ((await env.NOTIFY_CACHE.get(
        `${snapshotScope}${yesterdayKey}`,
        "json"
      )) as typeof currentSnapshot | null) ?? [];

    // Google Sheets schedule data (best-effort: skip on error)
    let scheduleData: Awaited<ReturnType<typeof fetchScheduleData>> | null = null;
    try {
      scheduleData = await fetchScheduleData(config);
      if (scheduleData.rows.length > 0) {
        const deviation = analyzeScheduleDeviation(scheduleData, today);
        console.log("Schedule analysis:", deviation.summary);
      }
    } catch (err) {
      console.warn("Google Sheets fetch skipped:", (err as Error).message);
    }

    // Calculate average daily SP consumption for 🟢🟡🔴 judgment
    // Priority: 7-day KV history > sprint-level calculation
    const spConsumption = await calculateAvgDailySpConsumption(
      env.NOTIFY_CACHE,
      summary.sprint.id,
      today
    );
    let avgDailySp: number | null = spConsumption ? spConsumption.avgDailySp : null;
    let avgDailySpSource = spConsumption ? "kv_7day" : null;

    if (avgDailySp == null) {
      avgDailySp = calcAvgDailySpFromSprint(summary, today);
      if (avgDailySp != null) avgDailySpSource = "sprint_progress";
    }
    console.log("SP consumption rate:", { avgDailySp, source: avgDailySpSource });

    // Step 2-A: Detect stagnant Doing tasks (no change for 2+ days)
    const stagnantTasks = await detectStagnantDoingTasks(
      env.NOTIFY_CACHE,
      summary.sprint.id,
      today,
      currentSnapshot
    );
    if (stagnantTasks.length > 0) {
      console.log("Stagnant Doing tasks detected:", stagnantTasks);
    }

    // Step 1.5: Match Notion tasks to spreadsheet items (LLM-based)
    let taskScheduleMapping = null;
    if (scheduleData && scheduleData.rows.length > 0) {
      try {
        taskScheduleMapping = await matchTasksToSchedule(config, summary, scheduleData);
        const matched = taskScheduleMapping.mappings.filter((m) => m.confidence !== "none");
        console.log(`Task-schedule mapping: ${matched.length}/${taskScheduleMapping.mappings.length} tasks matched`);
        for (const m of matched) {
          console.log(`  [${m.confidence}] ${m.task_name.slice(0, 40)} → ${m.schedule_category} / ${m.schedule_item}`);
        }
      } catch (err) {
        console.warn("Task-schedule matching skipped:", (err as Error).message);
      }
    }

    // Step 2: LLM analysis (with schedule data + SP consumption + stagnant tasks + mapping)
    const analysis = await analyzeTasksAndMembers(
      config,
      summary,
      members,
      previousSnapshot,
      scheduleData,
      avgDailySp,
      stagnantTasks,
      taskScheduleMapping
    );
    console.log("Morning flow: analysis complete", {
      schedule_status: analysis.schedule_status
    });

    // Step 3: Generate per-assignee messages
    const messages = await generateAssigneeMessages(
      config,
      analysis,
      summary,
      members
    );

    // Step 4: Send messages via Slack Bot Token
    const channel = targetChannel ?? "";
    let sent = 0;

    if (!channel) {
      console.warn("SLACK_PMO_CHANNEL_ID not set; skipping morning flow");
      return { ok: true, skipped: true, reason: "no pmo channel" };
    }

    // Filter by member whitelist, then by target name if specified
    const whitelist = config.memberWhitelist;
    let filteredMessages = whitelist.length > 0
      ? messages.filter((m) =>
          whitelist.some((name) =>
            m.assignee_name.includes(name) || name.includes(m.assignee_name)
          )
        )
      : messages;

    if (targetName) {
      filteredMessages = filteredMessages.filter((m) =>
        m.assignee_name.includes(targetName) || targetName.includes(m.assignee_name)
      );
      console.log(`Morning flow: targeting "${targetName}", ${filteredMessages.length}/${messages.length} messages`);
    }

    if (whitelist.length > 0) {
      console.log(`Morning flow: whitelist active, ${filteredMessages.length}/${messages.length} members`);
    }

    for (const msg of filteredMessages) {
      // Match member by exact name or partial match (e.g. "北川" matches "北川楓")
      const member = members.find(
        (m) => m.name === msg.assignee_name || msg.assignee_name.includes(m.name)
      );
      // Always post to PMO channel; mention the member if we have their Slack user ID
      const mention = member?.slackUserId ? `<@${member.slackUserId}> ` : "";
      const messageText = mention + msg.message_text;

      if (config.dryRun) {
        console.log(`DRY_RUN: would send to ${channel}\n${messageText}`);
        continue;
      }

      const result = await chatPostMessage(
        config.slackBotToken,
        channel,
        messageText
      );

      // Save thread state so Events API can route replies
      const assigneeTasks =
        summary.assignees.find((a) => a.name === msg.assignee_name)?.tasks ?? [];
      await saveThreadState(env.NOTIFY_CACHE, result.channel, result.ts, {
        assigneeName: msg.assignee_name,
        tasks: assigneeTasks.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status ?? null,
          sp: t.sp ?? null
        })),
        state: "pending",
        date: today,
        channel: result.channel
      });

      await addActiveThread(env.NOTIFY_CACHE, today, {
        channel: result.channel,
        ts: result.ts,
        assigneeName: msg.assignee_name
      }, undefined, channelId);

      sent++;
    }

    console.log("Morning flow complete", { reason, sent });
    await saveCronHeartbeat(env.NOTIFY_CACHE, "morning");
    return { ok: true, reason, sent, dryRun: config.dryRun };
  } catch (error) {
    const err = error as Error;
    console.error("runMorningFlow failed", err);
    return { ok: false, error: err.message };
  }
}

/**
 * タスクリマインド: 毎日 08:30 JST。SLACK_PMO_CHANNEL_ID に投稿する。
 *  1. 親メッセージ "MM/DD_タスク"
 *  2. スレッド内に【スケジュール分析】
 *  3. スレッド内に未完了タスクがあるメンバーを1人1メッセージで（個別メンション）全件表示
 */
async function runTaskReminderFlow(
  env: Env,
  reason: string,
  channelId?: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = channelId ? await resolveConfig(env, channelId) : getConfig(env);
    const channel = channelId ?? config.slackPmoChannelId ?? "";
    if (!config.slackBotToken) {
      console.warn("SLACK_BOT_TOKEN not set; skipping task reminder");
      return { ok: true, skipped: true, reason: "no bot token" };
    }
    if (!channel) {
      console.warn("SLACK_PMO_CHANNEL_ID not set; skipping task reminder");
      return { ok: true, skipped: true, reason: "no channel" };
    }

    const now = new Date();
    const today = toJstDateString(now);
    const dateLabel = today.slice(5).replace("-", "/"); // "MM/DD"
    const dueStart = toJstDateString(now, -30); // 今日-30日（期限切れは30日前まで一覧表示）
    const dueEnd = toJstDateString(now, 10);    // 今日+10日

    // スケジュール分析はスプリントベース（現状のスプリント検出）
    const summary = await fetchCurrentSprintTasksSummary(config, now);
    const members = await fetchMembers(config).catch(() => []);

    // 平均日次消化SP（KV 7日履歴 → スプリント計算 フォールバック）
    const spConsumption = await calculateAvgDailySpConsumption(
      env.NOTIFY_CACHE,
      summary.sprint.id,
      today
    ).catch(() => null);
    let avgDailySp: number | null = spConsumption ? spConsumption.avgDailySp : null;
    if (avgDailySp == null) avgDailySp = calcAvgDailySpFromSprint(summary, today);

    // 各自のタスクはスプリント非依存: 期限が今日-30日〜今日+10日の未完了タスクを直接取得
    const dueRange = await fetchTasksByDueRange(config, dueStart, dueEnd);
    const isUpdate = reason === "midday" || reason === "evening";
    const memberTables = buildPerMemberTaskTables(dueRange.assignees, today, reason);

    // メンション解決用: キャッシュ済みユーザーカタログ（別名で漢字/ローマ字の表記揺れを吸収）
    const userCatalog = await ensureUserCatalog(env, config).catch(() => []);

    if (config.dryRun) {
      console.log(`DRY_RUN: task reminder — header="${dateLabel}_タスク", schedule + ${memberTables.length} members`);
      return { ok: true, dryRun: true, members: memberTables.length };
    }

    // 1. スレッド決定:
    //   full(8:30/manual) = 新規「MM/DD_タスク」親メッセージ + スケジュール分析
    //   update(14:00/20:00) = 当日スレッドに「⏰ 時刻時点」見出しを追記（画像は朝の分を流用）
    let threadTs: string;
    if (isUpdate) {
      const existing = await getCurrentTaskThread(env.NOTIFY_CACHE, channel);
      if (existing) {
        threadTs = existing;
        const label = reason === "midday" ? "14:00" : "20:00";
        await chatPostMessage(
          config.slackBotToken,
          channel,
          `⏰ ${label} 時点のタスク状況（🔥=期限超過 / 💪=期限が今日か明日）`,
          undefined,
          threadTs
        );
      } else {
        // 当日スレッドが無ければ新規作成にフォールバック
        const parent = await chatPostMessage(config.slackBotToken, channel, `${dateLabel}_タスク`);
        threadTs = parent.ts;
        await saveCurrentTaskThread(env.NOTIFY_CACHE, channel, threadTs).catch(() => {});
        await chatPostMessage(
          config.slackBotToken,
          channel,
          buildScheduleAnalysis(summary, avgDailySp, today),
          undefined,
          threadTs
        );
      }
    } else {
      const parent = await chatPostMessage(config.slackBotToken, channel, `${dateLabel}_タスク`);
      threadTs = parent.ts;
      await chatPostMessage(
        config.slackBotToken,
        channel,
        buildScheduleAnalysis(summary, avgDailySp, today),
        undefined,
        threadTs
      );
    }

    // 2.5 Notion 実ビューのスクショ（A方式: KVのセッションCookieでログイン）
    //   ① タイムラインビュー(ガントチャート) ② 担当者ごとのボードを切り出し
    //   full モードのみ（update=14:00/20:00 は朝の画像を流用し、テキストの状況だけ追記）
    try {
      const session = isUpdate ? null : await getNotionSession(env.NOTIFY_CACHE);
      if (session) {
        // 担当者アバターの実URL(avatar_url)を API から取得しておく（白い丸対策）
        const avatarMap = await fetchNotionAvatarMap(config.notionToken).catch(() => ({}));
        // ① Notion タイムラインビュー
        try {
          const tlUrl = env.NOTION_TIMELINE_VIEW_URL || DEFAULT_NOTION_TIMELINE_URL;
          const tlPng = await captureNotionTimeline(env.BROWSER, session, tlUrl, avatarMap);
          if (tlPng) {
            await uploadImageToSlack(
              config.slackBotToken,
              channel,
              threadTs,
              `notion-timeline-${today}.png`,
              tlPng,
              "【タイムライン】"
            );
            // 画像はSlack側で表示確定が遅延するため、次の投稿前に待機して順序を保つ
            await new Promise((r) => setTimeout(r, 2500));
            console.log("Task reminder: posted Notion timeline screenshot");
          }
        } catch (err) {
          console.warn(`Task reminder: Notion timeline image failed: ${(err as Error).message}`);
        }

        // ② 担当者ごとのボード
        const boardUrl = env.NOTION_BOARD_VIEW_URL || DEFAULT_NOTION_BOARD_URL;
        const boards = await captureAssigneeBoards(env.BROWSER, session, boardUrl, avatarMap);
        for (const b of boards) {
          await uploadImageToSlack(
            config.slackBotToken,
            channel,
            threadTs,
            `board-${b.key}-${today}.png`,
            b.png,
            `【${b.name}さんのタスクボード】`
          );
          // 画像の表示順を確定させるため待機（テキストが先に割り込むのを防ぐ）
          await new Promise((r) => setTimeout(r, 2500));
        }
        console.log(`Task reminder: posted ${boards.length} assignee board images`);
      } else {
        console.log("Task reminder: no Notion session in KV (notion:session) — skipping Notion screenshots");
      }
    } catch (err) {
      console.warn(`Task reminder: Notion screenshots failed: ${(err as Error).message}`);
    }

    // 3. 各自のタスク状況（スレッド内・1人1メッセージ・個別メンション）
    let sent = 0;
    for (const { assigneeName, tableText } of memberTables) {
      // カタログの別名照合でSlack IDを引く（"Matsuda Naoki"↔"松田" 等の表記揺れに対応）。
      // 取れなければ従来のメンバー名部分一致でフォールバック。
      const slackId =
        resolveSlackUserIdByName(userCatalog, assigneeName) ??
        members.find(
          (m) => m.name === assigneeName || assigneeName.includes(m.name) || m.name.includes(assigneeName)
        )?.slackUserId;
      if (!slackId) console.warn(`Task reminder: no Slack ID for assignee "${assigneeName}"`);
      const mention = slackId ? `<@${slackId}> ` : "";
      await chatPostMessage(
        config.slackBotToken,
        channel,
        `${mention}${assigneeName}\n${tableText}`,
        undefined,
        threadTs
      );
      sent++;
    }

    // 3.5 担当者未定のタスク一覧（他の一覧と同形式・メンションなし）
    const unassignedGrp = dueRange.assignees.find((a) => a.name === "未割当");
    if (unassignedGrp) {
      const rows = unassignedGrp.tasks
        .filter((t) => !isHiddenFromList(t.status))
        .map((t) => taskToTableRow(t, today, reason));
      if (rows.length > 0) {
        await chatPostMessage(
          config.slackBotToken,
          channel,
          `【担当者未定のタスク】\n${renderTaskTable(rows)}`,
          undefined,
          threadTs
        );
      }
    }

    // Notion webhook の変更検出用スナップショット保存
    //   page_id ごとに「このスレッド(threadTs)」と現在のプロパティ値を記録。
    //   以降、Notion でプロパティが変わると webhook がこのスレッドに通知する。
    //   表示テーブルは今日-3〜+10 に限定するが、webhook 対象は広めに取る:
    //   下限なし(=何日前の期限切れでも) + 期限なし + 今日+10 まで。完了タスクは extractTaskRow が除外。
    const snapshotSource = await fetchTasksByDueRange(config, null, dueEnd, "期限", { includeNoDue: true })
      .catch(() => dueRange);
    const snapshotMap = new Map<string, { name: string; status: string | null; due: string | null; sp: number | null; assignees: string[] }>();
    for (const a of snapshotSource.assignees) {
      if (a.name === "未割当") continue;
      for (const t of a.tasks) {
        const ex = snapshotMap.get(t.id);
        if (ex) {
          if (!ex.assignees.includes(a.name)) ex.assignees.push(a.name);
        } else {
          snapshotMap.set(t.id, {
            name: t.name,
            status: t.status ?? null,
            due: t.due ?? null,
            sp: t.sp ?? null,
            assignees: [a.name]
          });
        }
      }
    }
    for (const [pageId, snap] of snapshotMap) {
      await saveTaskSnapshot(env.NOTIFY_CACHE, pageId, {
        threadTs,
        channel,
        taskName: snap.name,
        status: snap.status,
        assignees: snap.assignees,
        due: snap.due,
        sp: snap.sp
      }).catch(() => {});
    }
    console.log(`Task reminder: saved ${snapshotMap.size} task snapshots for webhook diffing`);

    // full モードのみ: 当日スレッドを記録 + 朝の進捗起点を保存（24:00 サマリー用）
    if (!isUpdate) {
      await saveCurrentTaskThread(env.NOTIFY_CACHE, channel, threadTs).catch(() => {});
      const dayStart: Record<string, DayStartEntry> = {};
      for (const [pageId, snap] of snapshotMap) {
        dayStart[pageId] = { status: snap.status, sp: snap.sp, name: snap.name, assignees: snap.assignees };
      }
      await saveDayStartProgress(env.NOTIFY_CACHE, today, dayStart).catch(() => {});
      console.log(`Task reminder: saved day-start progress for ${Object.keys(dayStart).length} tasks`);
    }

    await saveCronHeartbeat(env.NOTIFY_CACHE, "task-reminder");
    console.log("Task reminder complete", { reason, members: sent });
    return { ok: true, reason, members: sent, threadTs };
  } catch (error) {
    const err = error as Error;
    console.error("runTaskReminderFlow failed", err);
    return { ok: false, error: err.message };
  }
}

/**
 * 24:00(翌0時)に、その日の各メンバーの進捗SPと進捗のあったタスクを当日スレッドに投稿する。
 * 朝(8:30)の起点(day-start)と現在値を比較し、進捗SPが増えたタスクを担当者ごとに列挙（メンションなし・名前のみ）。
 */
async function runDailyProgressSummary(env: Env, reason: string, channelId?: string): Promise<Record<string, unknown>> {
  const config = getConfig(env);
  if (!config.slackBotToken) return { ok: true, skipped: true, reason: "no bot token" };
  const channel = channelId || config.slackPmoChannelId || "";
  if (!channel) return { ok: true, skipped: true, reason: "no channel" };

  const now = new Date();
  // 24:00(翌0時)に走るので、集計対象の「その日」は前日。manual テスト時は当日。
  const summaryDate = toJstDateString(now, reason === "manual" ? 0 : -1);
  const threadTs = (await getCurrentTaskThread(env.NOTIFY_CACHE, channel)) ?? undefined;
  const dayStart = await getDayStartProgress(env.NOTIFY_CACHE, summaryDate);
  if (Object.keys(dayStart).length === 0) {
    console.log(`Daily progress summary: no day-start data for ${summaryDate}, skip`);
    return { ok: true, skipped: true, reason: "no day-start", threadTs: threadTs ?? null };
  }

  // 現在のタスク（期限が今日-3〜今日+10）
  const dueStart = toJstDateString(now, -3);
  const dueEnd = toJstDateString(now, 10);
  // 完了タスクも含めて取得する（起票→即完了 や doing→完了 の進捗SPを計上するため）。
  const dueRange = await fetchTasksByDueRange(config, dueStart, dueEnd, "期限", { includeCompleted: true }).catch(
    () => ({ assignees: [] as SprintTasksSummary["assignees"] })
  );

  const current = new Map<string, { name: string; status: string | null; sp: number | null; assignees: string[]; projectName: string | null; createdTime: string | null }>();
  for (const a of dueRange.assignees) {
    if (a.name === "未割当") continue;
    for (const t of a.tasks) {
      const ex = current.get(t.id);
      if (ex) {
        if (!ex.assignees.includes(a.name)) ex.assignees.push(a.name);
      } else {
        current.set(t.id, { name: t.name, status: t.status ?? null, sp: t.sp ?? null, assignees: [a.name], projectName: t.projectName ?? null, createdTime: t.createdTime ?? null });
      }
    }
  }

  // 進捗SPが増えたタスクを担当者ごとに集計（テーブル行 + 合計進捗SP）
  const byAssignee = new Map<string, { rows: ProgressTableRow[]; total: number }>();
  const allIds = new Set([...Object.keys(dayStart), ...current.keys()]);
  for (const pageId of allIds) {
    const cur = current.get(pageId);
    if (!cur) continue; // 現在のタスク状態が取れないものは対象外
    const start = dayStart[pageId];
    // ベースライン(その日の起点)を決める:
    //   ① 朝の起点があればそれを使う
    //   ② 起点が無くても「当日作成」なら進捗0から開始とみなす（起票→即完了も計上する）
    //   ③ それ以外（起点無し & 当日作成でもない = 過去に完了済み等）は当日の進捗ではないので除外
    let baseStatus: string | null;
    let baseSp: number | null;
    if (start) {
      baseStatus = start.status;
      baseSp = start.sp;
    } else if (cur.createdTime === summaryDate) {
      baseStatus = null; // rate 0
      baseSp = cur.sp;
    } else {
      continue;
    }
    const sp = cur.sp ?? baseSp ?? 0;
    const delta =
      Math.round((sp * statusProgressRate(cur.status) - sp * statusProgressRate(baseStatus)) * 10) / 10;
    if (delta <= 0) continue; // 進捗SPが増えたものだけ
    const row = taskToProgressRow(
      { name: cur.name, status: cur.status, sp: cur.sp, projectName: cur.projectName },
      { status: baseStatus, sp: baseSp }
    );
    for (const assignee of cur.assignees) {
      const entry = byAssignee.get(assignee) ?? { rows: [], total: 0 };
      entry.rows.push(row);
      entry.total = Math.round((entry.total + delta) * 10) / 10;
      byAssignee.set(assignee, entry);
    }
  }

  const lines: string[] = [`📊 本日の進捗サマリー（${summaryDate}）`, ""];
  if (byAssignee.size === 0) {
    lines.push("本日、進捗SPが増えたタスクはありませんでした。");
  } else {
    for (const [assignee, { rows, total }] of byAssignee) {
      lines.push(`${assignee}  \`進捗SP +${total}\``);
      lines.push(renderProgressTable(rows));
      lines.push("");
    }
  }
  await chatPostMessage(config.slackBotToken, channel, lines.join("\n").trimEnd(), undefined, threadTs);
  console.log(`Daily progress summary posted: ${byAssignee.size} members with progress`);

  // 担当者未定のタスク一覧（8:30と同形式・期限-30〜+10日・メンションなし）
  const todayActual = toJstDateString(now);
  const listStart = toJstDateString(now, -30);
  const listEnd = toJstDateString(now, 10);
  const listRange = await fetchTasksByDueRange(config, listStart, listEnd).catch(
    () => ({ assignees: [] as SprintTasksSummary["assignees"] })
  );
  const unassignedGrp = listRange.assignees.find((a) => a.name === "未割当");
  if (unassignedGrp) {
    const rows = unassignedGrp.tasks
      .filter((t) => !isHiddenFromList(t.status))
      .map((t) => taskToTableRow(t, todayActual, reason));
    if (rows.length > 0) {
      await chatPostMessage(
        config.slackBotToken,
        channel,
        `【担当者未定のタスク】\n${renderTaskTable(rows)}`,
        undefined,
        threadTs
      );
    }
  }

  return { ok: true, members: byAssignee.size, threadTs: threadTs ?? null };
}

function normalizeSprintName(value: string): string {
  return value.toLowerCase().replace(/[\s　_-]/g, "");
}

/** Slack sectionの3000文字上限を越えないよう、改行単位で分割する。 */
function slackSectionBlocks(text: string, maxChars = 2900): unknown[] {
  const chunks: string[] = [];
  let current = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.length <= maxChars ? rawLine : rawLine.slice(0, maxChars);
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxChars && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => ({
    type: "section",
    text: { type: "mrkdwn", text: chunk }
  }));
}

async function prepareSpGamificationDashboard(
  env: Env,
  opts: {
    reportDate: string;
    sprintName?: string | null;
    persistSnapshot: boolean;
  }
): Promise<{
  data: SpDashboardData;
  details: SpTaskDetailData;
  taskCount: number;
  tasks: SprintDashboardTask[];
  checkpointRecords: Awaited<ReturnType<typeof fetchSprintCheckpointRecords>>;
}> {
  const config = getConfig(env);
  const sprints = await fetchAllSprints(config);
  const sprint =
    (opts.sprintName
      ? sprints.find(
          (candidate) =>
            normalizeSprintName(candidate.name) === normalizeSprintName(opts.sprintName ?? "")
        )
      : undefined) ??
    sprints.find(
      (candidate) =>
        candidate.start_date <= opts.reportDate && opts.reportDate <= candidate.end_date
    ) ??
    sprints.find((candidate) => /進行中|active|in progress/i.test(candidate.status));
  if (!sprint) {
    throw new Error(`sprint not found for ${opts.reportDate}`);
  }

  const dashboardSprint: SprintDashboardInfo = sprint;
  const tasks = await fetchSprintDashboardTasks(config, sprint.id);
  const checkpointRecords = await fetchSprintCheckpointRecords(config).catch(() => []);
  const previousSprints = sprints
    .filter((candidate) => candidate.end_date < dashboardSprint.start_date)
    .sort((a, b) => b.end_date.localeCompare(a.end_date))
    .slice(0, 3);
  const historicalSprintTasks: Array<{
    sprint: SprintDashboardInfo;
    tasks: SprintDashboardTask[];
  }> = [];
  // Notion API のレート上限を避けるため、直近3Sprintは順番に取得する。
  for (const previousSprint of previousSprints) {
    const previousTasks = await fetchSprintDashboardTasks(
      config,
      previousSprint.id,
      { resolveProjects: false }
    ).catch(() => []);
    historicalSprintTasks.push({ sprint: previousSprint, tasks: previousTasks });
  }
  const velocity = calculateSprintVelocity(historicalSprintTasks);
  const history = await loadSpDashboardHistory(env.NOTIFY_CACHE, sprint.id);
  let mergedHistory = history;
  if (opts.persistSnapshot) {
    const current = buildCurrentSpSnapshot(
      dashboardSprint,
      tasks,
      opts.reportDate
    );
    mergedHistory = await saveSpDashboardSnapshot(
      env.NOTIFY_CACHE,
      current,
      history
    );
  }
  // スプリント開始日のタスクスナップショットを「開始時ステータス」として使う
  // なければ近隣日付を順に試みる（最大3日後まで）
  let startStatusMap = new Map<string, string>();
  for (let offset = 0; offset <= 3; offset++) {
    const d = new Date(dashboardSprint.start_date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + offset);
    const dateKey = d.toISOString().slice(0, 10);
    const raw = await env.NOTIFY_CACHE.get(
      `sprint-task-snapshot:${dashboardSprint.id}:${dateKey}`,
      "json"
    ) as Array<{ id: string; status: string | null }> | null;
    if (raw && raw.length > 0) {
      startStatusMap = new Map(raw.map((t) => [t.id, t.status ?? "—"]));
      break;
    }
  }

  const data = buildSpDashboardData(
    dashboardSprint,
    tasks,
    opts.reportDate,
    mergedHistory,
    undefined,
    { velocity, checkpointRecords }
  );
  if (opts.persistSnapshot && data.checkpoints.length > 0) {
    await Promise.all(
      data.checkpoints.map((checkpoint) =>
        updateCheckpointHealth(
          config,
          checkpoint.id,
          {
            health:
              checkpoint.health === "green"
                ? "🟢 On Track"
                : checkpoint.health === "yellow"
                ? "🟡 At Risk"
                : checkpoint.health === "red"
                ? "🔴 Off Track"
                : "⚪ 未評価",
            reason: checkpoint.reason,
            judgedDate: data.reportDate,
            sprintName: data.sprint.name,
            planSp: checkpoint.planSp,
            progressSp: checkpoint.progressSp,
            doneSp: checkpoint.doneSp
          }
        ).catch(() => false)
      )
    );
  }

  return {
    data,
    details: buildSpTaskDetailData(
      dashboardSprint,
      tasks,
      opts.reportDate,
      startStatusMap
    ),
    taskCount: tasks.length,
    tasks,
    checkpointRecords
  };
}

/** 土曜のSprint開始時に、Checkpoint・タスク品質・Velocity負荷をPlanning順で案内する。 */
async function runSprintPlanningFlow(
  env: Env,
  reason: string,
  channelId?: string
): Promise<Record<string, unknown>> {
  try {
    const config = getConfig(env);
    const channel = channelId || resolveTeamKChannelId(env);
    if (!config.slackBotToken || !channel) {
      return { ok: true, skipped: true, reason: "missing Slack config" };
    }
    const reportDate = toJstDateString(new Date());
    const { data, tasks, checkpointRecords } = await prepareSpGamificationDashboard(env, {
      reportDate,
      persistSnapshot: false
    });
    const capacities = data.sprint.id.startsWith("virtual-")
      ? []
      : await fetchSprintCapacity(config, data.sprint.id).catch(() => []);
    const draft = buildSprintPlanningDraft(
      data.sprint,
      tasks,
      capacities,
      checkpointRecords,
      data.historicalVelocitySp
    );
    const threadTs = await getCurrentTaskThread(env.NOTIFY_CACHE, channel).catch(() => null);
    const message = `${sprintPlanningSlackComment(data)}\n\n${renderSprintPlanningDraft(draft)}`;
    const sessionId = crypto.randomUUID();
    const planTasks = toSprintPlanTaskSnapshots(draft);
    const baseline: SprintPlanBaseline = {
      sprintId: data.sprint.id,
      sprintName: data.sprint.name,
      startDate: data.sprint.start_date,
      endDate: data.sprint.end_date,
      lockedAt: "",
      lockedBy: "",
      totalSp: planTasks.reduce((sum, task) => sum + task.sp, 0),
      totalHours: Math.round(planTasks.reduce((sum, task) => sum + (task.budgetHours ?? 0), 0) * 10) / 10,
      tasks: planTasks
    };
    if (config.dryRun) {
      console.log("DRY_RUN: Sprint Planning guide", { sprint: data.sprint.name, message, draft });
      return { ok: true, dryRun: true, sprint: data.sprint.name, draft };
    }
    // Button投稿直後のクリックにも耐えるよう、messageTs未確定のsessionを先に保存する。
    await saveSprintPlanLockSession(env.NOTIFY_CACHE, {
      id: sessionId,
      channel,
      messageTs: "",
      threadTs: threadTs ?? undefined,
      baseline
    });
    const planningBlocks = [
      ...slackSectionBlocks(message),
      ...buildSprintPlanLockButton(sessionId)
    ];
    const posted = await chatPostMessage(
      config.slackBotToken,
      channel,
      message,
      planningBlocks,
      threadTs ?? undefined
    );
    await saveSprintPlanLockSession(env.NOTIFY_CACHE, {
      id: sessionId,
      channel,
      messageTs: posted.ts,
      threadTs: threadTs ?? undefined,
      baseline
    });
    return {
      ok: true,
      reason,
      sprint: data.sprint.name,
      checkpointCount: data.checkpoints.length,
      threadTs,
      commitSp: draft.commitSp,
      commitHours: draft.commitHours,
      capacityHours: draft.totalCapacityHours,
      qualityCounts: draft.qualityCounts
    };
  } catch (error) {
    const err = error as Error;
    console.error("runSprintPlanningFlow failed", err);
    return { ok: false, error: err.message };
  }
}

interface SprintScopeFlowState {
  config: AppConfig;
  channel: string;
  threadTs: string | null;
  diff: SprintScopeDiff;
}

async function prepareSprintScopeFlowState(env: Env): Promise<SprintScopeFlowState | null> {
  const config = getConfig(env);
  const channel = resolveTeamKChannelId(env);
  const today = toJstDateString();
  const sprints = await fetchAllSprints(config);
  const sprint =
    sprints.find((item) => item.start_date <= today && today <= item.end_date) ??
    sprints.find((item) => /進行中|active|in progress/iu.test(item.status));
  if (!sprint) return null;
  const baseline = await getSprintPlanBaseline(env.NOTIFY_CACHE, sprint.id);
  if (!baseline) return null;
  const tasks = await fetchSprintDashboardTasks(config, sprint.id);
  return {
    config,
    channel,
    threadTs: await getCurrentTaskThread(env.NOTIFY_CACHE, channel).catch(() => null),
    diff: buildSprintScopeDiff(baseline, tasks)
  };
}

/** Lock後の新規タスクを「途中追加」にし、同じ差分は一度だけ通知する。 */
async function runSprintScopeControlFlow(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  try {
    const state = await prepareSprintScopeFlowState(env);
    if (!state) return { ok: true, skipped: true, reason: "baseline or current sprint not found" };
    const { diff } = state;
    if (diff.added.length === 0 && diff.removed.length === 0) {
      return { ok: true, skipped: true, reason: "scope unchanged", sprint: diff.baseline.sprintName };
    }
    const previous = await getSprintScopeFingerprint(env.NOTIFY_CACHE, diff.baseline.sprintId);
    if (previous === diff.fingerprint) {
      return { ok: true, skipped: true, reason: "same diff already posted", sprint: diff.baseline.sprintName };
    }
    if (!state.config.dryRun) {
      for (const task of diff.added) {
        if (task.sprintClass !== "途中追加") {
          await updateTaskSprintClass(state.config.notionToken, task.id, "途中追加");
        }
      }
      if (state.config.slackBotToken && state.threadTs) {
        await chatPostMessage(
          state.config.slackBotToken,
          state.channel,
          renderSprintScopeDiff(diff),
          undefined,
          state.threadTs
        );
      }
      await saveSprintScopeFingerprint(
        env.NOTIFY_CACHE,
        diff.baseline.sprintId,
        diff.fingerprint
      );
    }
    return {
      ok: true,
      reason,
      sprint: diff.baseline.sprintName,
      added: diff.added.length,
      removed: diff.removed.length,
      addedSp: diff.addedSp,
      addedHours: diff.addedHours,
      dryRun: state.config.dryRun
    };
  } catch (error) {
    const err = error as Error;
    console.error("runSprintScopeControlFlow failed", err.message);
    return { ok: false, error: err.message };
  }
}

// ── Delivery OS: 案件単価 × 工数 × FTE × 成果進捗 ────────────────────

interface DeliveryFlowState {
  config: AppConfig;
  channel: string;
  threadTs: string;
  snapshot: DeliverySnapshot;
  assessments: ProjectAssessment[];
}

async function prepareDeliveryFlowState(env: Env): Promise<DeliveryFlowState | null> {
  const config = getConfig(env);
  const channel = resolveTeamKChannelId(env);
  if (!config.slackBotToken || !channel) return null;
  const threadTs = await getCurrentTaskThread(env.NOTIFY_CACHE, channel).catch(() => null);
  if (!threadTs) {
    console.log("Delivery Control: today's task thread is not available; skip");
    return null;
  }
  const now = new Date();
  const snapshot = await fetchDeliveryControlSnapshot(config, now);
  return {
    config,
    channel,
    threadTs,
    snapshot,
    assessments: assessSnapshot(snapshot, now)
  };
}

/** 朝のDigest直後に、担当者別の30秒更新ボタンを同じタスクスレッドへ出す。 */
async function postDailyCheckinPrompts(
  env: Env,
  state: DeliveryFlowState
): Promise<number> {
  const dedupeKey = `daily-checkin-prompts:${state.snapshot.today}:${state.channel}`;
  if (await env.NOTIFY_CACHE.get(dedupeKey).catch(() => null)) return 0;
  const grouped = new Map<string, DeliverySnapshot["tasks"]>();
  for (const task of state.snapshot.tasks) {
    if (!isDailyUpdateTask(task.status)) continue;
    for (const assignee of task.assignees) {
      const list = grouped.get(assignee) ?? [];
      if (!list.some((item) => item.id === task.id)) list.push(task);
      grouped.set(assignee, list);
    }
  }
  if (grouped.size === 0) return 0;
  const catalog = await ensureUserCatalog(env, state.config).catch(() => []);
  let posted = 0;
  for (const [assignee, tasks] of grouped) {
    const slackUserId = resolveSlackUserIdByName(catalog, assignee) ?? undefined;
    const sessionId = crypto.randomUUID();
    await saveDailyCheckinSession(env.NOTIFY_CACHE, {
      id: sessionId,
      date: state.snapshot.today,
      channel: state.channel,
      threadTs: state.threadTs,
      assignee,
      slackUserId,
      tasks: tasks.map((task) => ({
        id: task.id,
        url: task.url,
        name: task.name,
        status: task.status,
        evidenceUrl: task.evidenceUrl,
        blockerStartedAt: task.blockerStartedAt
      }))
    });
    const mention = slackUserId ? `<@${slackUserId}>` : assignee;
    const preview = tasks
      .slice(0, 4)
      .map((task) => `• <${task.url}|${task.name}>｜${task.status ?? "-"}`)
      .join("\n");
    const more = tasks.length > 4 ? `\n• ほか ${tasks.length - 4}件` : "";
    if (!state.config.dryRun) {
      await chatPostMessage(
        state.config.slackBotToken!,
        state.channel,
        `${mention} 今日の進捗を30秒で更新できます。タスクごとに押してください。\n${preview}${more}`,
        buildDailyCheckinButton(sessionId),
        state.threadTs
      );
    }
    posted++;
  }
  if (!state.config.dryRun) {
    await env.NOTIFY_CACHE.put(dedupeKey, new Date().toISOString(), {
      expirationTtl: 2 * 24 * 3600
    });
  }
  return posted;
}

async function syncProjectDeliveryHealth(
  state: DeliveryFlowState
): Promise<number> {
  if (state.config.dryRun) return 0;
  const updates = state.assessments.filter(
    (assessment) =>
      assessment.severity !== "unknown" &&
      assessment.project.currentHealth !== assessment.healthLabel
  );
  const results = await Promise.all(
    updates.map((assessment) =>
      updateProjectDeliveryHealth(
        state.config,
        assessment.project.id,
        assessment.healthLabel as "🟢 Green" | "🟡 Yellow" | "🔴 Red"
      ).catch(() => false)
    )
  );
  return results.filter(Boolean).length;
}

async function postChangedDeliveryAlerts(
  env: Env,
  state: DeliveryFlowState,
  force = false
): Promise<number> {
  const candidates: Array<{ assessment: ProjectAssessment; key: string; fingerprint: string; previous: string | null }> = [];
  for (const assessment of state.assessments) {
    const key = `delivery-alert:${assessment.project.id}`;
    const fingerprint = deliveryAlertFingerprint(assessment);
    const previous = await env.NOTIFY_CACHE.get(key).catch(() => null);
    candidates.push({ assessment, key, fingerprint, previous });
  }
  const changedAlerts = candidates
    .filter(
      ({ assessment, fingerprint, previous }) =>
        (assessment.severity === "yellow" || assessment.severity === "red") &&
        (force || previous !== fingerprint)
    )
    .map(({ assessment }) => assessment);

  if (changedAlerts.length > 0 && !state.config.dryRun) {
    await chatPostMessage(
      state.config.slackBotToken!,
      state.channel,
      renderDeliveryAlerts(changedAlerts),
      undefined,
      state.threadTs
    );
  }
  if (!state.config.dryRun) {
    await Promise.all(
      candidates.map(({ key, fingerprint }) =>
        env.NOTIFY_CACHE.put(key, fingerprint, { expirationTtl: 30 * 24 * 3600 })
      )
    );
  }
  return changedAlerts.length;
}

async function postNewExpansionGates(
  env: Env,
  state: DeliveryFlowState,
  force = false
): Promise<number> {
  const reminders = collectExpansionReminders(state.assessments);
  const pending: typeof reminders = [];
  for (const reminder of reminders) {
    const key = `delivery-expansion:${reminder.project.id}:${reminder.gate}`;
    const existing = await env.NOTIFY_CACHE.get(key).catch(() => null);
    if (!existing || force) pending.push(reminder);
  }
  if (pending.length > 0 && !state.config.dryRun) {
    await chatPostMessage(
      state.config.slackBotToken!,
      state.channel,
      renderExpansionReminders(pending),
      undefined,
      state.threadTs
    );
    await Promise.all(
      pending.map((reminder) =>
        env.NOTIFY_CACHE.put(
          `delivery-expansion:${reminder.project.id}:${reminder.gate}`,
          state.snapshot.today,
          { expirationTtl: 120 * 24 * 3600 }
        )
      )
    );
  }
  return pending.length;
}

/** 毎朝、当日のMM/DDタスクスレッドへ案件HealthとFTEのDigest画像を投稿する。 */
async function runDeliveryMorningFlow(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  try {
    const state = await prepareDeliveryFlowState(env);
    if (!state) return { ok: true, skipped: true, reason: "no task thread or Slack config" };
    const dedupeKey = `delivery-digest:${state.snapshot.today}:${state.channel}`;
    if (reason !== "manual" && (await env.NOTIFY_CACHE.get(dedupeKey))) {
      return { ok: true, skipped: true, reason: "already posted", date: state.snapshot.today };
    }
    const healthUpdates = await syncProjectDeliveryHealth(state);
    const message = renderDeliveryDigest(state.snapshot, state.assessments);
    if (!state.config.dryRun) {
      const height = Math.max(760, 180 + Math.ceil(Math.min(8, state.assessments.length) / 2) * 300);
      const png = await htmlToPng(
        env.BROWSER,
        renderDeliveryDashboardHtml(state.snapshot, state.assessments),
        { width: 1400, height, deviceScaleFactor: 1 }
      ).catch(() => null);
      if (png) {
        await uploadImageToSlack(
          state.config.slackBotToken!,
          state.channel,
          state.threadTs,
          `delivery-control-${state.snapshot.today}.png`,
          png,
          message
        );
      } else {
        await chatPostMessage(
          state.config.slackBotToken!,
          state.channel,
          message,
          undefined,
          state.threadTs
        );
      }
      await env.NOTIFY_CACHE.put(dedupeKey, new Date().toISOString(), {
        expirationTtl: 2 * 24 * 3600
      });
    }
    const dailyCheckinPrompts = await postDailyCheckinPrompts(env, state).catch((error) => {
      console.error("Daily checkin prompts failed", error);
      return 0;
    });
    const alerts = await postChangedDeliveryAlerts(env, state);
    const expansionReminders = await postNewExpansionGates(env, state);
    await saveCronHeartbeat(env.NOTIFY_CACHE, "delivery-digest");
    return {
      ok: true,
      reason,
      projects: state.snapshot.projects.length,
      tasks: state.snapshot.tasks.length,
      healthUpdates,
      alerts,
      expansionReminders,
      dailyCheckinPrompts,
      dryRun: state.config.dryRun,
      threadTs: state.threadTs
    };
  } catch (error) {
    const err = error as Error;
    console.error("runDeliveryMorningFlow failed", err.message);
    return { ok: false, error: err.message };
  }
}

/** 18:30、未更新タスクだけを担当者単位で集約して当日スレッドへ投稿する。 */
async function runDeliveryUpdateReminderFlow(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  try {
    const state = await prepareDeliveryFlowState(env);
    if (!state) return { ok: true, skipped: true, reason: "no task thread or Slack config" };
    const dedupeKey = `delivery-reminder:${state.snapshot.today}:${state.channel}`;
    if (reason !== "manual" && (await env.NOTIFY_CACHE.get(dedupeKey))) {
      return { ok: true, skipped: true, reason: "already posted", date: state.snapshot.today };
    }
    const gaps = collectAssigneeUpdateGaps(state.snapshot);
    if (gaps.length === 0) {
      return { ok: true, skipped: true, reason: "all active tasks updated" };
    }
    const catalog = await ensureUserCatalog(env, state.config).catch(() => []);
    const mentions: Record<string, string> = {};
    for (const gap of gaps) {
      const slackId = resolveSlackUserIdByName(catalog, gap.assignee);
      if (slackId) mentions[gap.assignee] = slackId;
    }
    if (!state.config.dryRun) {
      await chatPostMessage(
        state.config.slackBotToken!,
        state.channel,
        renderUpdateReminder(state.snapshot, gaps, mentions),
        undefined,
        state.threadTs
      );
      await env.NOTIFY_CACHE.put(dedupeKey, new Date().toISOString(), {
        expirationTtl: 2 * 24 * 3600
      });
    }
    const alerts = await postChangedDeliveryAlerts(env, state);
    await saveCronHeartbeat(env.NOTIFY_CACHE, "delivery-reminder");
    return {
      ok: true,
      reason,
      assignees: gaps.length,
      tasks: gaps.reduce((sum, gap) => sum + gap.tasks.length, 0),
      alerts,
      dryRun: state.config.dryRun,
      threadTs: state.threadTs
    };
  } catch (error) {
    const err = error as Error;
    console.error("runDeliveryUpdateReminderFlow failed", err.message);
    return { ok: false, error: err.message };
  }
}

/** Forecast/Burn/Blockerの状態変化を確認し、Yellow/Redになった案件だけ通知する。 */
async function runDeliveryAlertFlow(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  try {
    const state = await prepareDeliveryFlowState(env);
    if (!state) return { ok: true, skipped: true, reason: "no task thread or Slack config" };
    const healthUpdates = await syncProjectDeliveryHealth(state);
    const alerts = await postChangedDeliveryAlerts(env, state, reason === "manual");
    return { ok: true, reason, alerts, healthUpdates, threadTs: state.threadTs };
  } catch (error) {
    const err = error as Error;
    console.error("runDeliveryAlertFlow failed", err.message);
    return { ok: false, error: err.message };
  }
}

/** 金曜、案件Portfolioと担当者別の次週FTE需要を当日スレッドへ投稿する。 */
async function runDeliveryPortfolioFlow(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  try {
    const state = await prepareDeliveryFlowState(env);
    if (!state) return { ok: true, skipped: true, reason: "no task thread or Slack config" };
    const dedupeKey = `delivery-portfolio:${state.snapshot.today}:${state.channel}`;
    if (reason !== "manual" && (await env.NOTIFY_CACHE.get(dedupeKey))) {
      return { ok: true, skipped: true, reason: "already posted", date: state.snapshot.today };
    }
    const capacities = calculateAssigneeCapacity(state.snapshot);
    if (!state.config.dryRun) {
      await chatPostMessage(
        state.config.slackBotToken!,
        state.channel,
        renderPortfolioSummary(state.snapshot, state.assessments, capacities),
        undefined,
        state.threadTs
      );
      await env.NOTIFY_CACHE.put(dedupeKey, new Date().toISOString(), {
        expirationTtl: 8 * 24 * 3600
      });
    }
    return {
      ok: true,
      reason,
      projects: state.snapshot.projects.length,
      assignees: capacities.length,
      dryRun: state.config.dryRun,
      threadTs: state.threadTs
    };
  } catch (error) {
    const err = error as Error;
    console.error("runDeliveryPortfolioFlow failed", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * 毎日24:00の SPRINT CONTROL。OpenAI は装飾背景だけを生成し、
 * SP・順位・累積線・予測値は Worker が正確に描画して Slack に投稿する。
 */
async function runSpGamificationDashboard(
  env: Env,
  reason: string,
  opts: {
    channelId?: string;
    threadTs?: string;
    reportDate?: string;
    sprintName?: string | null;
    useAi?: boolean;
  } = {}
): Promise<Record<string, unknown>> {
  const config = getConfig(env);
  if (!config.slackBotToken) {
    return { ok: false, error: "SLACK_BOT_TOKEN is not set" };
  }
  const reportDate =
    opts.reportDate ?? toJstDateString(new Date(), reason === "cron" ? -1 : 0);
  const { data, details, taskCount } = await prepareSpGamificationDashboard(env, {
    reportDate,
    sprintName: opts.sprintName,
    persistSnapshot: true
  });
  const background =
    opts.useAi === false
      ? { base64: null, model: config.openaiImageModel, error: "disabled" }
      : await generateAiDashboardBackground(config, data);

  // ダッシュボード + タスク詳細を1枚のPNGに結合してから1投稿にまとめる
  const combinedPng = await buildCombinedDashboardPng(env.BROWSER, data, details, background);
  if (!combinedPng) {
    return { ok: false, error: "combined dashboard PNG render failed (BROWSER unbound?)" };
  }

  const channelName = env.S19_SCREENSHOT_CHANNEL || "team-k-古鉄";
  const channelId =
    opts.channelId ||
    env.S19_SCREENSHOT_CHANNEL_ID ||
    (await findChannelIdByName(config.slackBotToken, channelName));
  if (!channelId) {
    return {
      ok: false,
      error: `channel not found: ${channelName}（S19_SCREENSHOT_CHANNEL_ID を設定するか Bot を招待）`
    };
  }
  if (reason === "cron" && !opts.threadTs) {
    return {
      ok: false,
      error: "current MM/DD_タスク thread not found; SPRINT CONTROL was not posted to the channel"
    };
  }
  const sprintSlug = data.sprint.name
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "");
  const slug = sprintSlug || "sprint";
  const messageTs = await uploadImageToSlack(
    config.slackBotToken,
    channelId,
    opts.threadTs,
    `sprint-control-${slug}-${data.reportDate}.png`,
    combinedPng,
    spDashboardSlackComment(data)
  );
  console.log(
    `runSpGamificationDashboard: ${data.sprint.name} ${data.reportDate} ${data.current.teamCompletedSp}/${data.current.teamPlanSp}SP channel=${channelId} ai=${!!background.base64} (${reason})`
  );
  return {
    ok: true,
    channelId,
    messageTs: messageTs ?? null,
    detailsMessageTs: null,
    sprint: data.sprint.name,
    reportDate: data.reportDate,
    taskCount,
    teamCompletedSp: data.current.teamCompletedSp,
    teamPlanSp: data.current.teamPlanSp,
    teamDoneSp: data.currentDoneSp,
    projectedDoneSp: data.projectedDoneSp,
    projectedDoneRate: data.projectedDoneRate,
    health: data.health,
    weeklyProjection: data.weeklyProjection,
    memberCount: data.members.length,
    completedTaskRecords: details.taskCount,
    aiThemeUsed: !!background.base64,
    aiModel: background.model,
    aiError: background.error ?? null,
    usedEstimatedHistory: data.usedEstimatedHistory
  };
}

/** 毎日24時のデイリー KPI リマインドが対象とする固定 Notion ページ（週次 KPI 表）。 */
const KPI_PAGE_URL = "https://app.notion.com/p/aice-co-jp/KPI-3aee00135b61804887c7d658e53c6701";

const JST_OFFSET_MS = 9 * 3600 * 1000;

type DailyKpiTarget = {
  url: string;
  source: "explicit_url" | "env_override" | "kpi_page";
};

export function resolveDailyKpiTarget(env: Bindings, opts: { explicitUrl?: string | null } = {}): DailyKpiTarget {
  if (opts.explicitUrl) return { url: opts.explicitUrl, source: "explicit_url" };
  // env に明示URLが設定されている場合のみ固定KPIページより優先する（開発環境等での差し替え用）
  if (env.NOTION_S19_URL) return { url: env.NOTION_S19_URL, source: "env_override" };
  return { url: KPI_PAGE_URL, source: "kpi_page" };
}

/** JST の現在時刻の 月/日 を返す。 */
export function jstTodayMD(nowMs = Date.now()): { m: number; d: number } {
  const j = new Date(nowMs + JST_OFFSET_MS);
  return { m: j.getUTCMonth() + 1, d: j.getUTCDate() };
}

/**
 * ScrumTable の各行から KpiRowContext（担当者+KPIテキスト+推論済みcadence+セル配列）を構築する。
 * 同一(担当者,KPIテキスト)の重複行はスキップ。KPIテキスト列が見つからない表は空配列を返す。
 */
export async function buildKpiRowContexts(
  config: AppConfig,
  kv: KVNamespace,
  table: ScrumTable
): Promise<KpiRowContext[]> {
  const kpiColIdx = kpiTextColumnIndex(table);
  if (kpiColIdx < 0) return [];
  const catColIdx = skillCategoryColumnIndex(table);
  const seen = new Set<string>();
  const contexts: KpiRowContext[] = [];
  for (const r of table.rows) {
    if (!r.member) continue;
    const kpiText = r.cells[kpiColIdx]?.trim();
    if (!kpiText) continue;
    const dedupeKey = `${r.member}::${kpiText}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const skillCategory = catColIdx >= 0 ? r.cells[catColIdx]?.trim() || null : null;
    const { itemKey, cadence } = await getOrInferCadence(config, kv, r.member, kpiText, skillCategory);
    contexts.push({ member: r.member, itemKey, kpiText, cadence, cells: r.cells });
  }
  return contexts;
}

/** JST の前日（昨日）の月/日。24:00(=JST 0時)投稿時点では「終わった前日」になる。 */
function jstYesterdayMD(nowMs = Date.now()): { m: number; d: number } {
  const j = new Date(nowMs + JST_OFFSET_MS - 24 * 3600 * 1000);
  return { m: j.getUTCMonth() + 1, d: j.getUTCDate() };
}

/** 表の担当者名(例:古鉄) → Slack ユーザーID。部分一致で解決。 */
function resolveSlackId(
  members: Array<{ name: string; slackUserId?: string }>,
  config: ReturnType<typeof getConfig>,
  name: string
): string | undefined {
  const n = name.trim();
  if (!n) return undefined;
  for (const m of members) {
    if (m.slackUserId && (m.name === n || m.name.includes(n) || n.includes(m.name))) return m.slackUserId;
  }
  for (const [k, v] of Object.entries(config.memberSlackMap)) {
    if (k === n || k.includes(n) || n.includes(k)) return v;
  }
  return undefined;
}

// 旧デイリーKPI投稿+10分おきリマインド(runS19DailyPost/runS19ReminderTick)は
// KPI実行担保エンジン（runKpiMorningPost/runKpiEveningCheck/runKpiBoardPost、下記）に置き換え済み。

/**
 * 特定のKPI項目に対するメンバーの履行率を返す（0.0〜1.0）。
 * 直近5件のコミットメントのうち fulfilled の割合。
 * 履歴が2件未満のときは -1（判断不可）を返す。
 */
function computeItemComplianceRate(memory: KpiMemberMemory, itemKey: string): number {
  const all = memory.commitments.filter((c) => c.itemKey === itemKey && c.fulfilled !== "pending");
  if (all.length < 2) return -1;
  const recent = all.slice(-5);
  return recent.filter((c) => c.fulfilled === "fulfilled").length / recent.length;
}

/**
 * リスク項目の深刻度から「必ず送る」かどうかを返す。
 * pace_danger / not_started は履行率に関わらず常に送信対象。
 */
function isSevereRisk(riskKind: string): boolean {
  return riskKind === "pace_danger" || riskKind === "not_started";
}

/**
 * 毎日08:40：team-k-古鉄 に「MM/DD_KPI」親メッセージを投稿する。着手リスクのあるKPI
 * （週内回数のペースが間に合わない等）を持つメンバーだけをスレッド内でメンションし、
 * 「いつやりますか」を尋ねる。KpiThreadState をKVに保存し、以降このスレッドへの返信は
 * handleKpiReply がリアルタイムで詰める（納得いく回答が来るまで）。
 */
async function runKpiMorningPost(
  env: Env,
  reason: string,
  opts?: { channelId?: string; overrideDate?: { m: number; d: number } }
): Promise<Record<string, unknown>> {
  const config = getConfig(env);
  if (!config.slackBotToken) return { ok: true, skipped: true, reason: "no bot token" };

  const channelId = opts?.channelId || resolveTeamKChannelId(env);
  const target = resolveDailyKpiTarget(env);
  const now = new Date();
  const todayMD = opts?.overrideDate || jstTodayMD(now.getTime());
  const today = toJstDateString(now);
  const dateLabel = today.slice(5).replace("-", "/"); // "MM/DD"

  const table = await fetchScrumTable(config, target.url, { month: todayMD.m, day: todayMD.d }).catch(() => null);
  if (!table) return { ok: false, error: "KPI table not found for today" };

  const rows = await buildKpiRowContexts(config, env.NOTIFY_CACHE, table);
  const rawRiskItems = computeKpiRiskAssessment(rows, table, { month: todayMD.m, day: todayMD.d }, "morning");

  // 履行率が高い（自走できる）人のKPI項目はスキップ。
  // 直近5件の約束のうち 80% 以上を守っており、かつリスクが軽度の場合は朝メッセージ不要。
  const riskItems: typeof rawRiskItems = [];
  for (const item of rawRiskItems) {
    if (!isSevereRisk(item.riskKind)) {
      const memory = await getKpiMemory(env.NOTIFY_CACHE, item.member);
      const rate = computeItemComplianceRate(memory, item.itemKey);
      if (rate >= 0.8) {
        console.log(`runKpiMorningPost: skip self-managing "${item.member}" / "${item.kpiText}" (rate=${rate.toFixed(2)})`);
        continue;
      }
    }
    riskItems.push(item);
  }

  const parent = await chatPostMessage(config.slackBotToken, channelId, `${dateLabel}_KPI`).catch(() => null);
  if (!parent?.ts) return { ok: false, error: "failed to post parent message" };
  const parentTs = parent.ts;
  await saveTodayKpiThreadRef(env.NOTIFY_CACHE, channelId, { parentTs, date: today }).catch(() => {});

  // Notion KPI表へのリンクを最初の返信として投稿
  await chatPostMessage(
    config.slackBotToken,
    channelId,
    `📊 <${target.url}|Notion KPI表を開く>`,
    undefined,
    parentTs
  ).catch(() => {});

  // リンクの直後に、その週のKPI表スクショを同スレッドへ投稿する。
  // スクショ失敗（セッション切れ・ブラウザ未バインド等）でも朝投稿自体は継続する。
  try {
    const session = await getNotionSession(env.NOTIFY_CACHE);
    if (session) {
      const todayCol = table.dateColumns.find((c) => c.month === todayMD.m && c.day === todayMD.d);
      const shotLabel = todayCol?.label ?? `${todayMD.m}/${todayMD.d}`;
      const avatarMap = await fetchNotionAvatarMap(config.notionToken).catch(() => ({}));
      const png = await captureNotionPage(env.BROWSER, session, target.url, avatarMap, true, shotLabel);
      if (png) {
        await uploadImageToSlack(config.slackBotToken, channelId, parentTs, `kpi-week-${today}.png`, png).catch(() => {});
      } else {
        console.warn("runKpiMorningPost: KPI screenshot failed (session expired / browser unbound?)");
      }
    } else {
      console.log("runKpiMorningPost: no Notion session in KV (notion:session) — skipping KPI screenshot");
    }
  } catch (err) {
    console.warn(`runKpiMorningPost: KPI screenshot error: ${(err as Error).message}`);
  }

  if (riskItems.length === 0) {
    await chatPostMessage(
      config.slackBotToken,
      channelId,
      "本日、着手リスクのあるKPIはありません（このペースなら間に合います）。今日も一日頑張りましょう！",
      undefined,
      parentTs
    ).catch(() => {});
    console.log(`runKpiMorningPost: posted to ${channelId} thread=${parentTs} risk=0 (${reason})`);
    return { ok: true, channelId, parentTs, riskCount: 0 };
  }

  const byMember = new Map<string, typeof riskItems>();
  for (const item of riskItems) {
    const arr = byMember.get(item.member) ?? [];
    arr.push(item);
    byMember.set(item.member, arr);
  }

  const members = await fetchMembers(config).catch(() => []);
  const incidents: Record<string, KpiIncident> = {};
  let mentioned = 0;

  for (const [member, items] of byMember) {
    const slackId = resolveSlackId(members, config, member);
    const memory = await getKpiMemory(env.NOTIFY_CACHE, member);
    const history = items.map((i) => ({ kpiText: i.kpiText, ...recentForItem(memory, i.itemKey) }));
    const nudgeItems = items.map((i) => ({ itemKey: i.itemKey, kpiText: i.kpiText, triggerKind: i.riskKind, detail: i.detail }));
    const nudge = await generateKpiNudge(config, { member, items: nudgeItems, history, timeSlot: "morning" }).catch(() => null);
    const mentionPrefix = slackId ? `<@${slackId}> ` : `${member} `;
    const nudgeBody = nudge ?? `${items.map((i) => `「${i.kpiText}」`).join("、")} について、今日中の見込みを教えてください。`;
    await chatPostMessage(config.slackBotToken, channelId, `${mentionPrefix}${nudgeBody}`, undefined, parentTs).catch(() => {});
    mentioned++;

    if (slackId) {
      incidents[slackId] = {
        member,
        items: items.map((i) => ({ itemKey: i.itemKey, kpiText: i.kpiText, triggerKind: i.riskKind, detail: i.detail })),
        openedAt: new Date().toISOString(),
        pressCount: 0,
        lastPromptAt: new Date().toISOString(),
        resolved: false,
        conversation: appendConversationTurn(undefined, "bot", nudgeBody)
      };
    } else {
      console.warn(`runKpiMorningPost: no Slack ID for member "${member}", incident not armed (no reply tracking)`);
    }
  }

  if (Object.keys(incidents).length > 0) {
    await saveKpiThreadState(env.NOTIFY_CACHE, channelId, parentTs, {
      channel: channelId,
      parentTs,
      date: today,
      incidents
    }).catch(() => {});
  }

  console.log(`runKpiMorningPost: posted to ${channelId} thread=${parentTs} risk=${riskItems.length} mentioned=${mentioned} (${reason})`);
  return { ok: true, channelId, parentTs, riskCount: riskItems.length, mentioned };
}

/**
 * 18:00/21:00：当日のKPIスレッド（08:40に開いたもの）で、リスクの残っているKPIをエスカレーションする。
 * 既存インシデントがあればitemを統合して再エスカレーション、無ければ新規に開く。
 * 「まだ期日が来ていない約束」がある item は今回は静観し、期日を過ぎた約束は実際のセルと
 * 突き合わせて fulfilled/broken を確定させる（次回以降の詰めの材料として記憶に残す）。
 */
async function runKpiEveningCheck(
  env: Env,
  reason: string,
  slotLabel: "1800" | "2100",
  opts?: { channelId?: string; overrideDate?: { m: number; d: number } }
): Promise<Record<string, unknown>> {
  const config = getConfig(env);
  if (!config.slackBotToken) return { ok: true, skipped: true, reason: "no bot token" };

  const channelId = opts?.channelId || resolveTeamKChannelId(env);
  const target = resolveDailyKpiTarget(env);
  const now = new Date();
  const todayMD = opts?.overrideDate || jstTodayMD(now.getTime());
  // today(YYYY-MM-DD)は todayMD と必ず一致させる（commitment期日比較に使うため、overrideDate指定時のズレを防ぐ）
  const jstYear = new Date(now.getTime() + JST_OFFSET_MS).getUTCFullYear();
  const today = `${jstYear}-${String(todayMD.m).padStart(2, "0")}-${String(todayMD.d).padStart(2, "0")}`;

  const table = await fetchScrumTable(config, target.url, { month: todayMD.m, day: todayMD.d }).catch(() => null);
  if (!table) return { ok: false, error: "KPI table not found for today" };

  const rows = await buildKpiRowContexts(config, env.NOTIFY_CACHE, table);
  const allRisk = computeKpiRiskAssessment(rows, table, { month: todayMD.m, day: todayMD.d }, "evening");
  const todayColPos = table.dateColumns.findIndex((c) => c.month === todayMD.m && c.day === todayMD.d);

  const membersInRisk = [...new Set(allRisk.map((r) => r.member))];
  const memoryByMember = new Map<string, KpiMemberMemory>();
  for (const m of membersInRisk) memoryByMember.set(m, await getKpiMemory(env.NOTIFY_CACHE, m));

  // 期日を過ぎた約束を実際のセルと突き合わせて確定させる（未来日の約束はまだ判定しない）
  const outcomes = resolvePendingCommitments(rows, table, memoryByMember, todayColPos);
  for (const o of outcomes) {
    await markCommitmentOutcome(env.NOTIFY_CACHE, o.member, o.itemKey, o.committedDate, o.outcome).catch(() => {});
  }
  if (outcomes.length > 0) {
    for (const m of membersInRisk) memoryByMember.set(m, await getKpiMemory(env.NOTIFY_CACHE, m));
  }

  // 「まだ期日が来ていない約束」がある item は今回は静観する（約束の期日まで待つ）
  const suppressed = new Set<string>();
  for (const [member, memory] of memoryByMember) {
    for (const c of memory.commitments) {
      if (c.fulfilled === "pending" && c.committedDate >= today) suppressed.add(`${member}::${c.itemKey}`);
    }
  }
  const riskItems = allRisk.filter((r) => !suppressed.has(`${r.member}::${r.itemKey}`));

  if (riskItems.length === 0) {
    console.log(`runKpiEveningCheck(${slotLabel}): no risk to escalate (suppressed=${suppressed.size}, resolvedCommitments=${outcomes.length})`);
    return { ok: true, channelId, riskCount: 0, suppressed: suppressed.size, resolvedCommitments: outcomes.length };
  }

  let threadRef = await getTodayKpiThreadRef(env.NOTIFY_CACHE, channelId);
  let parentTs: string;
  if (threadRef) {
    parentTs = threadRef.parentTs;
  } else {
    // 朝の投稿が無かった場合のフォールバック（本来は08:40に必ず開いているはず）
    const dateLabel = today.slice(5).replace("-", "/");
    const parent = await chatPostMessage(config.slackBotToken, channelId, `${dateLabel}_KPI`).catch(() => null);
    if (!parent?.ts) return { ok: false, error: "failed to post parent message" };
    parentTs = parent.ts;
    await saveTodayKpiThreadRef(env.NOTIFY_CACHE, channelId, { parentTs, date: today }).catch(() => {});
  }

  const kpiState: KpiThreadState =
    (await getKpiThreadState(env.NOTIFY_CACHE, channelId, parentTs)) ||
    { channel: channelId, parentTs, date: today, incidents: {} };

  const byMember = new Map<string, typeof riskItems>();
  for (const item of riskItems) {
    const arr = byMember.get(item.member) ?? [];
    arr.push(item);
    byMember.set(item.member, arr);
  }

  const members = await fetchMembers(config).catch(() => []);
  const updatedIncidents: Record<string, KpiIncident> = { ...kpiState.incidents };
  let escalated = 0;

  for (const [member, items] of byMember) {
    const slackId = resolveSlackId(members, config, member);
    if (!slackId) {
      console.warn(`runKpiEveningCheck: no Slack ID for member "${member}", skipping`);
      continue;
    }
    const existing = updatedIncidents[slackId];
    const memory = memoryByMember.get(member) ?? (await getKpiMemory(env.NOTIFY_CACHE, member));
    const history = items.map((i) => ({ kpiText: i.kpiText, ...recentForItem(memory, i.itemKey) }));
    const nudgeItems = items.map((i) => ({ itemKey: i.itemKey, kpiText: i.kpiText, triggerKind: i.riskKind, detail: i.detail }));
    const hasReplied = (existing?.conversation ?? []).some((t) => t.role === "member");
    const nudge = await generateKpiNudge(config, {
      member,
      items: nudgeItems,
      history,
      timeSlot: "evening",
      conversation: existing?.conversation,
      hasReplied
    }).catch(() => null);
    const nudgeBody = nudge ?? `${items.map((i) => `「${i.kpiText}」`).join("、")} がまだ未達成です。今日中の見込みを教えてください。`;
    await chatPostMessage(config.slackBotToken, channelId, `<@${slackId}> ${nudgeBody}`, undefined, parentTs).catch(() => {});
    escalated++;

    const mergedItems = new Map<string, KpiIncidentItem>();
    if (existing) for (const it of existing.items) mergedItems.set(it.itemKey, it);
    for (const i of items) {
      mergedItems.set(i.itemKey, { itemKey: i.itemKey, kpiText: i.kpiText, triggerKind: i.riskKind, detail: i.detail });
    }

    updatedIncidents[slackId] = {
      member,
      items: [...mergedItems.values()],
      openedAt: existing?.openedAt ?? new Date().toISOString(),
      pressCount: (existing?.pressCount ?? 0) + 1,
      lastPromptAt: new Date().toISOString(),
      resolved: false,
      conversation: appendConversationTurn(existing?.conversation, "bot", nudgeBody)
    };
  }

  await saveKpiThreadState(env.NOTIFY_CACHE, channelId, parentTs, {
    channel: channelId,
    parentTs,
    date: today,
    incidents: updatedIncidents
  }).catch(() => {});

  console.log(
    `runKpiEveningCheck(${slotLabel}): posted to ${channelId} thread=${parentTs} risk=${riskItems.length} suppressed=${suppressed.size} escalated=${escalated} (${reason})`
  );
  return { ok: true, channelId, parentTs, riskCount: riskItems.length, suppressed: suppressed.size, escalated };
}

/**
 * 13:00 JST — 朝ナッジを送ったのにまだ返事をしていないメンバーへの昼フォローアップ。
 * Notion表の再チェックは行わず、KVのスレッド状態だけを見て未返信者を特定してリマインドする。
 */
async function runKpiMiddayFollowup(
  env: Env,
  reason: string,
  opts?: { channelId?: string }
): Promise<Record<string, unknown>> {
  const config = getConfig(env);
  if (!config.slackBotToken) return { ok: true, skipped: true, reason: "no bot token" };

  const channelId = opts?.channelId || resolveTeamKChannelId(env);
  const threadRef = await getTodayKpiThreadRef(env.NOTIFY_CACHE, channelId).catch(() => null);
  if (!threadRef) return { ok: true, skipped: true, reason: "no kpi thread for today" };

  const kpiState = await getKpiThreadState(env.NOTIFY_CACHE, channelId, threadRef.parentTs).catch(() => null);
  if (!kpiState) return { ok: true, skipped: true, reason: "no kpi thread state" };

  const members = await fetchMembers(config).catch(() => []);
  let followed = 0;

  const REMIND_INTERVAL_MS = 15 * 60 * 1000; // 15分

  for (const [slackId, incident] of Object.entries(kpiState.incidents)) {
    if (incident.resolved || incident.items.length === 0) continue;

    const hasReplied = (incident.conversation ?? []).some((t) => t.role === "member");
    if (hasReplied) continue; // 既に返事あり → スキップ

    // 前回送信から15分未満ならスキップ（連続リマインド間隔を守る）
    if (incident.lastPromptAt) {
      const elapsed = Date.now() - new Date(incident.lastPromptAt).getTime();
      if (elapsed < REMIND_INTERVAL_MS) continue;
    }

    const memory = await getKpiMemory(env.NOTIFY_CACHE, incident.member);
    const history = incident.items.map((i) => ({ kpiText: i.kpiText, ...recentForItem(memory, i.itemKey) }));
    const nudge = await generateKpiNudge(config, {
      member: incident.member,
      items: incident.items.map((i) => ({ itemKey: i.itemKey, kpiText: i.kpiText, triggerKind: i.triggerKind, detail: "" })),
      history,
      timeSlot: "midday",
      conversation: incident.conversation,
      hasReplied: false
    }).catch(() => null);

    const body = nudge ?? `${incident.items.map((i) => `「${i.kpiText}」`).join("、")} について、まだご返事いただいていません。一言でよいので今日の状況を教えてください。`;
    await chatPostMessage(config.slackBotToken, channelId, `<@${slackId}> ${body}`, undefined, threadRef.parentTs).catch(() => {});

    const updatedIncident = {
      ...incident,
      pressCount: incident.pressCount + 1,
      lastPromptAt: new Date().toISOString(),
      conversation: appendConversationTurn(incident.conversation, "bot", body)
    };
    await saveKpiThreadState(env.NOTIFY_CACHE, channelId, threadRef.parentTs, {
      ...kpiState,
      incidents: { ...kpiState.incidents, [slackId]: updatedIncident }
    }).catch(() => {});

    followed++;
  }

  console.log(`runKpiMiddayFollowup: channel=${channelId} followed=${followed} (${reason})`);
  return { ok: true, channelId, followed };
}

/**
 * 25:00(=翌01:00)：当日のKPI表をスクショし、当日のKPIスレッドに詳細（表+各メンバーの実況+
 * ストリーク警告+称賛）を返信する。さらに同じスクショをチャンネル直下にも投稿し、
 * 「AA：〇〇〇〇〇〇」形式のコンパクトな週間記号一覧+警告+称賛をスレッドを開かなくても見えるようにする。
 */
async function runKpiBoardPost(
  env: Env,
  reason: string,
  opts?: { channelId?: string; overrideDate?: { m: number; d: number } }
): Promise<Record<string, unknown>> {
  const config = getConfig(env);
  if (!config.slackBotToken) return { ok: true, skipped: true, reason: "no bot token" };

  const channelId = opts?.channelId || resolveTeamKChannelId(env);
  const target = resolveDailyKpiTarget(env);
  const now = new Date();
  const todayMD = opts?.overrideDate || jstTodayMD(now.getTime());
  const today = toJstDateString(now);

  const table = await fetchScrumTable(config, target.url, { month: todayMD.m, day: todayMD.d }).catch(() => null);
  if (!table) return { ok: false, error: "KPI table not found for today" };
  const todayCol = table.dateColumns.find((c) => c.month === todayMD.m && c.day === todayMD.d);
  const dateLabel = todayCol?.label ?? `${todayMD.m}/${todayMD.d}`;

  // 直近の別週テーブル（あれば）をストリーク照合用に追加取得。ページに1表しか無ければ同じ表が返るので、
  // tableIdが同一なら「別週なし」として扱う。
  const prevJst = new Date(now.getTime() - 7 * 24 * 3600 * 1000 + JST_OFFSET_MS);
  const prevMD = { month: prevJst.getUTCMonth() + 1, day: prevJst.getUTCDate() };
  const prevTable = await fetchScrumTable(config, target.url, prevMD).catch(() => null);
  const tablesForStreak = prevTable && prevTable.tableId !== table.tableId ? [table, prevTable] : [table];

  const rows = await buildKpiRowContexts(config, env.NOTIFY_CACHE, table);
  const { warnings, praise } = computeStreaksAndPraise(tablesForStreak, rows);

  const membersInTableOrder: string[] = [];
  const seenMembers = new Set<string>();
  for (const r of table.rows) {
    if (r.member && !seenMembers.has(r.member)) {
      seenMembers.add(r.member);
      membersInTableOrder.push(r.member);
    }
  }
  const perMemberSymbols = membersInTableOrder.map((member) => ({
    member,
    symbols: formatMemberDaySymbols(
      rows.filter((r) => r.member === member),
      table.dateColumns,
      todayCol?.index
    )
  })).filter((s) => s.symbols);

  const narration = await buildWeeklyBoardNarration(config, { perMemberSymbols, warnings, praise, dateLabel }).catch(() => null);

  const session = await getNotionSession(env.NOTIFY_CACHE);
  if (!session) return { ok: false, error: "no notion session (notion:session 未保存)" };
  const avatarMap = await fetchNotionAvatarMap(config.notionToken).catch(() => ({}));
  const png = await captureNotionPage(env.BROWSER, session, target.url, avatarMap, true, dateLabel);
  if (!png) return { ok: false, error: "screenshot failed (session expired / browser unbound?)" };

  const compactBlock = perMemberSymbols.map((s) => `${s.member}：${s.symbols}`).join("\n");
  const warningLines = warnings.map((w) => `⚠️ ${w.member}さん「${w.kpiText}」${w.streakLen}日連続未達成`);
  const praiseLines = praise.map((p) => `🎉 ${p.member}さん 達成率${Math.round(p.rate * 100)}%（${p.achievedCount}/${p.totalCount}）`);

  // チャンネル直下にスクショ+コンパクト一覧を投稿（スレッド返信はしない）
  const channelCaption = [
    `📊 *デイリー KPI 週間サマリー*（${dateLabel}時点）`,
    compactBlock || null,
    warningLines.length ? warningLines.join("\n") : null,
    praiseLines.length ? praiseLines.join("\n") : null,
    narration
  ].filter(Boolean).join("\n\n");
  await uploadImageToSlack(config.slackBotToken, channelId, undefined, `kpi-board-${today}.png`, png, channelCaption).catch(() => {});

  console.log(`runKpiBoardPost: posted to ${channelId} (channel-only) warnings=${warnings.length} praise=${praise.length} (${reason})`);
  return { ok: true, channelId, warnings: warnings.length, praise: praise.length, perMemberSymbols };
}

/**
 * 24:00頃〜08:20 JST、10分おき：当日(08:40スレッドを開いた日)のKPI表がまだ未記入の担当者がいれば
 * そのスレッドで10分おきにリマインドする。全員記入済みになったら、その週のKPI表のスクショを
 * スレッドに投稿して完了とする（以後は同じ日について再投稿しない）。
 */
async function runKpiMidnightFillCheck(env: Env, reason: string): Promise<Record<string, unknown>> {
  const config = getConfig(env);
  if (!config.slackBotToken) return { ok: true, skipped: true, reason: "no bot token" };

  const channelId = resolveTeamKChannelId(env);
  const threadRef = await getTodayKpiThreadRef(env.NOTIFY_CACHE, channelId).catch(() => null);
  if (!threadRef) return { ok: true, skipped: true, reason: "no kpi thread for today" };

  const doneKey = `kpi:midnight-done:${channelId}:${threadRef.date}`;
  if (await env.NOTIFY_CACHE.get(doneKey)) return { ok: true, skipped: true, reason: "already completed" };

  const [ym, mm, dd] = threadRef.date.split("-").map((v) => parseInt(v, 10));
  const target = resolveDailyKpiTarget(env);
  const table = await fetchScrumTable(config, target.url, { month: mm, day: dd }).catch(() => null);
  if (!table) return { ok: false, error: "KPI table not found" };
  const colIndex = dateColumnIndex(table, mm, dd);
  if (colIndex == null) return { ok: false, error: "date column not found" };

  const emptyMembers = emptyMembersForColumn(table, colIndex);

  if (emptyMembers.length === 0) {
    const session = await getNotionSession(env.NOTIFY_CACHE);
    if (!session) return { ok: false, error: "no notion session (notion:session 未保存)" };
    const shotLabel = table.dateColumns.find((c) => c.index === colIndex)?.label ?? `${mm}/${dd}`;
    const avatarMap = await fetchNotionAvatarMap(config.notionToken).catch(() => ({}));
    const png = await captureNotionPage(env.BROWSER, session, target.url, avatarMap, true, shotLabel);
    if (!png) return { ok: false, error: "screenshot failed (session expired / browser unbound?)" };

    await chatPostMessage(
      config.slackBotToken,
      channelId,
      "✅ 全員のKPI記載が完了しました！その週のKPI表です。",
      undefined,
      threadRef.parentTs
    ).catch(() => {});
    await uploadImageToSlack(
      config.slackBotToken,
      channelId,
      threadRef.parentTs,
      `kpi-week-filled-${threadRef.date}.png`,
      png
    ).catch(() => {});
    await env.NOTIFY_CACHE.put(doneKey, "1", { expirationTtl: 7 * 24 * 3600 }).catch(() => {});
    console.log(`runKpiMidnightFillCheck: all filled, posted screenshot to ${channelId} (${reason})`);
    return { ok: true, allFilled: true, channelId, date: threadRef.date };
  }

  // 10分おきのリマインド間隔をKVでゲート（cronの粒度が10分なので9分でも十分だが、余裕を持って9分に設定）。
  const gateKey = `kpi:midnight-remind:${channelId}:${threadRef.date}`;
  const lastAt = await env.NOTIFY_CACHE.get(gateKey);
  if (lastAt && Date.now() - parseInt(lastAt, 10) < 9 * 60 * 1000) {
    return { ok: true, skipped: true, reason: "throttled", remaining: emptyMembers };
  }

  const members = await fetchMembers(config).catch(() => []);
  const mentions = emptyMembers.map((m) => {
    const slackId = resolveSlackId(members, config, m);
    return slackId ? `<@${slackId}>` : m;
  });
  await chatPostMessage(
    config.slackBotToken,
    channelId,
    `⏰ ${mentions.join(" ")} 本日のKPI表への記載がまだ確認できていません。記載をお願いします。`,
    undefined,
    threadRef.parentTs
  ).catch(() => {});
  await env.NOTIFY_CACHE.put(gateKey, String(Date.now()), { expirationTtl: 3600 }).catch(() => {});

  console.log(`runKpiMidnightFillCheck: reminded ${emptyMembers.length} member(s) in ${channelId} (${reason})`);
  return { ok: true, remindedCount: emptyMembers.length, remaining: emptyMembers };
}

// ── Notion Webhook 受信ハンドラ ─────────────────────────────────────────────
// Notion でタスクのプロパティが変わると Notion → このエンドポイントに POST が来る。
// payload には page_id のみ含まれる（変更内容は無い）ので、ページを再取得して
// KV のスナップショットと比較し、変化があれば当日スレッドに通知する。

/** Notion webhook payload から page_id を抽出（複数のpayload形状に対応）。 */
function extractNotionPageId(payload: any): string | null {
  if (!payload || typeof payload !== "object") return null;
  // 公式 integration webhook: entity.id / data.entity.id
  const candidates = [
    payload?.entity?.id,
    payload?.data?.entity?.id,
    payload?.data?.id,
    payload?.page?.id,
    payload?.page_id,
    payload?.id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.replace(/-/g, "").length === 32) return c;
  }
  return null;
}

async function handleNotionWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // 初回の検証リクエスト: verification_token をログに出す（Notion の UI で確認に使う）
  if (payload?.verification_token) {
    console.log(`Notion webhook verification_token: ${payload.verification_token}`);
    return jsonResponse({ verification_token: payload.verification_token });
  }

  const pageId = extractNotionPageId(payload);
  if (!pageId) {
    console.log("Notion webhook: no page_id in payload, ignoring", JSON.stringify(payload).slice(0, 200));
    return new Response("ok");
  }

  // 変更検出・通知はバックグラウンドで（Notion には即 200 を返す）
  const task = handleNotionChange(env, pageId).catch((err) =>
    console.error("handleNotionChange failed:", (err as Error).message)
  );
  if (ctx) ctx.waitUntil(task);
  return new Response("ok");
}

/**
 * ステータス名から進捗率(0〜1)を返す。
 *   doing(20%) → 0.2, doing(60%)M2✅ → 0.6, 完了/Done → 1.0
 *   Backlog/Ready/ペンディング/中止/他者ボール 等 → 0（進捗SPに寄与しない）
 */
/** page_id のスナップショットと現在値を比較し、変化があれば当日スレッドに通知する。 */
async function handleNotionChange(env: Env, pageId: string): Promise<void> {
  const snapshot = await getTaskSnapshot(env.NOTIFY_CACHE, pageId);
  if (!snapshot) {
    console.log(`Notion webhook: no snapshot for page ${pageId} (当日スレッドに無いタスク) — skip`);
    return;
  }
  const config = getConfig(env);
  if (!config.slackBotToken) return;

  // 当日のタスクスレッドがあれば優先、なければスナップショットの作成元スレッドにフォールバック
  const teamKChannel = resolveTeamKChannelId(env);
  const currentThread = await getCurrentTaskThread(env.NOTIFY_CACHE, teamKChannel).catch(() => null);
  const taskChannel = currentThread ? teamKChannel : snapshot.channel;
  const taskThread = currentThread ?? snapshot.threadTs;
  if (!taskThread) {
    console.log(`Notion webhook: no task thread for page ${pageId} — skip`);
    return;
  }

  const current = await fetchTaskPropertiesById(config, pageId);
  if (!current) {
    console.warn(`Notion webhook: failed to fetch page ${pageId}`);
    return;
  }

  // 差分検出
  const changes: string[] = [];
  let statusChanged = false;
  let progressArrow = ""; // 進捗SPが増えたとき↗️
  // これまでに計上済みの最高進捗率(基準)。Pending/他者ボール等(0%)を挟んでも二重計上しない。
  // 旧スナップショット(peakRate無し)は snapshot.status の率でフォールバック。
  const baseRate = Math.max(snapshot.peakRate ?? 0, statusProgressRate(snapshot.status));
  const newPeakRate = Math.max(baseRate, statusProgressRate(current.status));
  if (snapshot.status !== current.status) {
    statusChanged = true;
    // ステータスは N% 表示（doing(60%) → 60%）
    changes.push(`ステータス：${simplifyStatus(snapshot.status)} → ${simplifyStatus(current.status)}`);
    if (isCompletedStatus(current.status) && !isCompletedStatus(snapshot.status)) {
      // 完了日プロパティが空でも、webhook でステータス変更を検知した瞬間の時刻を正確な完了記録として残す。
      await recordTaskCompletion(env.NOTIFY_CACHE, pageId, {
        name: current.name || snapshot.taskName,
        sp: current.sp ?? snapshot.sp ?? null,
        assignees: current.assignees,
        project: current.project,
        completedAt: new Date().toISOString()
      }).catch((err) => console.warn(`recordTaskCompletion failed: ${(err as Error).message}`));
    }
    // 進捗SP: 「基準率(計上済みの最高率)より増えたとき」だけ表示する。
    //   例) 60%→他者ボール→完了 の差分は +40%（+100%ではない）。
    //   doing→Pending/Backlog/中止/他者ボール 等は一時停止なので進捗ダウンは出さない。
    const sp = current.sp ?? snapshot.sp ?? 0;
    const newRate = statusProgressRate(current.status);
    const diff = Math.round((newRate - baseRate) * sp * 10) / 10;
    if (diff > 0) {
      const c = Math.round(sp * baseRate * 10) / 10;
      const d = Math.round(sp * newRate * 10) / 10;
      changes.push(`進捗SP：${c} → ${d}（+${diff}）`);
      progressArrow = ":arrow_upper_right:";
    }
  }
  const prevA = [...snapshot.assignees].sort().join("、");
  const curA = [...current.assignees].sort().join("、");
  if (prevA !== curA) {
    changes.push(`担当者変更：${prevA || "なし"} → ${curA || "なし"}`);
  }
  if ((snapshot.due ?? null) !== (current.due ?? null)) {
    const WDAYS = ["日", "月", "火", "水", "木", "金", "土"];
    const fmtDue = (d: string | null | undefined) => {
      if (!d) return "なし";
      const dt = new Date(`${d}T00:00:00+09:00`);
      return `${dt.getMonth() + 1}/${dt.getDate()}(${WDAYS[dt.getDay()]})`;
    };
    changes.push(`期限変更：${fmtDue(snapshot.due)} → ${fmtDue(current.due)}`);
  }
  if ((snapshot.sp ?? null) !== (current.sp ?? null)) {
    changes.push(`SP変更：${snapshot.sp ?? "なし"} → ${current.sp ?? "なし"}`);
  }

  if (changes.length === 0) {
    console.log(`Notion webhook: page ${pageId} updated but no tracked property changed`);
    // スナップショットは最新化しておく（本文等の変更でも値を揃える）
    await saveTaskSnapshot(env.NOTIFY_CACHE, pageId, {
      ...snapshot,
      taskName: current.name || snapshot.taskName,
      peakRate: newPeakRate,
    }).catch(() => {});
    return;
  }

  const taskName = current.name || snapshot.taskName;
  const assigneeLabel = current.assignees.length > 0 ? current.assignees.join("、") : "担当者未設定";
  // アイコン: ステータス変更時は進捗の増減で矢印、それ以外は🔄
  const icon = statusChanged ? (progressArrow || ":arrow_right:") : ":arrows_counterclockwise:";
  // タイトル行 + rich_text_list で箇条書き
  const title = `${icon} タスク更新`;
  const bullets = [`更新「${taskName}」（担当：${assigneeLabel}）`, ...changes];
  const msg = `${title}\n${bullets.join("\n")}`;
  const blocks = bulletListBlocks(title, bullets) as Record<string, unknown>[];
  await chatPostMessage(config.slackBotToken, taskChannel, msg, blocks, taskThread);
  console.log(`Notion webhook: notified Team K thread ${taskThread} — ${changes.join(" / ")}`);

  // スナップショットを現在値で更新（同じ変更で二重通知しないため）
  await saveTaskSnapshot(env.NOTIFY_CACHE, pageId, {
    threadTs: taskThread,
    channel: taskChannel,
    taskName: current.name || snapshot.taskName,
    status: current.status,
    assignees: current.assignees,
    due: current.due,
    sp: current.sp,
    peakRate: newPeakRate,
  }).catch(() => {});
}

/** Reminder flow: 09:00 JST = 00:00 UTC */
async function runReminderFlow(
  env: Env,
  reason: string,
  channelId?: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = channelId ? await resolveConfig(env, channelId) : getConfig(env);

    if (!config.slackBotToken) {
      console.warn("SLACK_BOT_TOKEN not set; skipping reminder flow");
      return { ok: true, skipped: true, reason: "no bot token" };
    }

    const today = toJstDateString();
    const activeThreads = await getActiveThreads(env.NOTIFY_CACHE, today, channelId);
    let reminded = 0;

    for (const thread of activeThreads) {
      const replies = await getReplies(
        env.NOTIFY_CACHE,
        thread.channel,
        thread.ts
      );

      if (replies.length === 0) {
        if (config.dryRun) {
          console.log(`DRY_RUN: would remind ${thread.assigneeName}`);
          continue;
        }
        await chatPostMessage(
          config.slackBotToken,
          thread.channel,
          `リマインド: 本日のタスク状況について返信をお願いします。`,
          undefined,
          thread.ts
        );
        reminded++;
      }
    }

    console.log("Reminder flow complete", { reason, reminded });
    await saveCronHeartbeat(env.NOTIFY_CACHE, "reminder");
    return { ok: true, reason, reminded };
  } catch (error) {
    const err = error as Error;
    console.error("runReminderFlow failed", err);
    return { ok: false, error: err.message };
  }
}

/** PM report flow: Steps 6-7 (10:00 JST = 01:00 UTC) */
async function runEveningFlow(
  env: Env,
  reason: string,
  channelId?: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = channelId ? await resolveConfig(env, channelId) : getConfig(env);
    const targetChannel = channelId ?? config.slackPmoChannelId;

    if (!config.slackBotToken) {
      console.warn("SLACK_BOT_TOKEN not set; skipping evening flow");
      return { ok: true, skipped: true, reason: "no bot token" };
    }

    const now = new Date();
    const today = toJstDateString(now);

    // Dedup: skip if PM thread already exists for today (prevents double PM report)
    if (reason !== "manual") {
      const existingPmThread = await getPmThread(env.NOTIFY_CACHE, today, channelId);
      if (existingPmThread) {
        console.log(`Evening flow: PM thread already exists for today (state=${existingPmThread.state}), skipping (reason=${reason})`);
        return { ok: true, skipped: true, reason: "pm thread already exists" };
      }
    }

    // Collect replies from all active threads
    const activeThreads = await getActiveThreads(env.NOTIFY_CACHE, today, channelId);
    console.log(`Evening flow: ${activeThreads.length} active threads for ${today}`);
    const replyMap = new Map<string, Awaited<ReturnType<typeof getReplies>>>();

    for (const thread of activeThreads) {
      const replies = await getReplies(
        env.NOTIFY_CACHE,
        thread.channel,
        thread.ts
      );
      console.log(`  thread ${thread.assigneeName} (ts=${thread.ts}): ${replies.length} replies`);
      replyMap.set(thread.assigneeName, replies);
    }
    console.log(`Evening flow: replyMap has ${replyMap.size} entries, total replies: ${Array.from(replyMap.values()).reduce((s, r) => s + r.length, 0)}`);

    // Refresh task summary and members for context
    const summary = await fetchCurrentSprintTasksSummary(config, now);
    const members = await fetchMembers(config);

    const eveningSnapshotScope = channelId ? `task-snapshot:${channelId}:` : `task-snapshot:`;
    const previousSnapshot =
      ((await env.NOTIFY_CACHE.get(
        `${eveningSnapshotScope}${today}`,
        "json"
      )) as Array<{
        id: string;
        name: string;
        status: string | null;
        sp: number | null;
      }> | null) ?? [];

    // スプリントページのキャパシティDBからメンバー稼働時間を取得
    const capacities = await fetchSprintCapacity(config, summary.sprint.id);
    if (capacities.length > 0) {
      for (const member of members) {
        const cap = capacities.find(
          (c) => c.name === member.name || c.name.includes(member.name) || member.name.includes(c.name)
        );
        if (cap) {
          // 残り稼働時間（今日以降）を使用
          member.availableHours = cap.remainingHours;
        }
      }
      console.log("Capacity data merged into members", {
        count: capacities.length,
        data: capacities.map((c) => `${c.name}: ${c.totalHours}h`)
      });
    }

    // Google Sheets schedule data (best-effort: skip on error)
    let scheduleData: Awaited<ReturnType<typeof fetchScheduleData>> | null = null;
    try {
      scheduleData = await fetchScheduleData(config);
      if (scheduleData.rows.length > 0) {
        const deviation = analyzeScheduleDeviation(scheduleData, today);
        console.log("Schedule analysis:", deviation.summary);
      }
    } catch (err) {
      console.warn("Google Sheets fetch skipped:", (err as Error).message);
    }

    // Calculate average daily SP consumption for 🟢🟡🔴 judgment
    const spConsumption = await calculateAvgDailySpConsumption(
      env.NOTIFY_CACHE,
      summary.sprint.id,
      today
    );
    let avgDailySp: number | null = spConsumption ? spConsumption.avgDailySp : null;
    if (avgDailySp == null) {
      avgDailySp = calcAvgDailySpFromSprint(summary, today);
    }

    // Calculate yesterday's consumed SP from 5AM progress_sp snapshots
    // (前日AM5時→当日AM5時の進捗SPの差)
    const yesterdayKey = toJstDateString(now, -1);
    const todayProgressSpRaw = await env.NOTIFY_CACHE.get(
      `progress-sp-5am:${summary.sprint.id}:${today}`,
      "json"
    ) as { progress_sp: number | null } | null;
    const yesterdayProgressSpRaw = await env.NOTIFY_CACHE.get(
      `progress-sp-5am:${summary.sprint.id}:${yesterdayKey}`,
      "json"
    ) as { progress_sp: number | null } | null;

    let yesterdayCompletedSp = 0;
    if (todayProgressSpRaw?.progress_sp != null && yesterdayProgressSpRaw?.progress_sp != null) {
      yesterdayCompletedSp = todayProgressSpRaw.progress_sp - yesterdayProgressSpRaw.progress_sp;
      console.log(`Yesterday consumed SP (5AM snapshots): ${yesterdayCompletedSp} (${yesterdayProgressSpRaw.progress_sp} → ${todayProgressSpRaw.progress_sp})`);
    } else {
      // Fallback: task status change method
      const yesterdaySnapshotRaw = await env.NOTIFY_CACHE.get(
        `sprint-task-snapshot:${summary.sprint.id}:${yesterdayKey}`,
        "json"
      ) as Array<{ id: string; name: string; status: string | null; sp: number | null }> | null;

      if (yesterdaySnapshotRaw) {
        const prevById = new Map(yesterdaySnapshotRaw.map((t) => [t.id, t]));
        const currentSnapshot = summary.assignees.flatMap((a) =>
          a.tasks.map((t) => ({ id: t.id, status: t.status ?? null, sp: t.sp ?? null }))
        );
        for (const task of currentSnapshot) {
          const prev = prevById.get(task.id);
          if (!prev) continue;
          // Count SP for any status change (not just completion)
          if (task.status !== prev.status) {
            yesterdayCompletedSp += task.sp ?? 0;
          }
        }
      }
      console.log(`Yesterday completed SP (fallback): ${yesterdayCompletedSp}`);
    }

    // Step 2-A: Detect stagnant Doing tasks
    const eveningSnapshot = summary.assignees.flatMap((a) =>
      a.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status ?? null,
        sp: t.sp ?? null
      }))
    );
    const stagnantTasks = await detectStagnantDoingTasks(
      env.NOTIFY_CACHE,
      summary.sprint.id,
      today,
      eveningSnapshot
    );

    // Match Notion tasks to spreadsheet items (LLM-based)
    let taskScheduleMapping = null;
    if (scheduleData && scheduleData.rows.length > 0) {
      try {
        taskScheduleMapping = await matchTasksToSchedule(config, summary, scheduleData);
        const matched = taskScheduleMapping.mappings.filter((m) => m.confidence !== "none").length;
        console.log(`Task-schedule mapping: ${matched}/${taskScheduleMapping.mappings.length} tasks matched`);
      } catch (err) {
        console.warn("Task-schedule matching skipped:", (err as Error).message);
      }
    }

    // Step 2 (light): re-analyze with today's data (with schedule data + SP consumption + stagnant tasks + mapping)
    const analysis = await analyzeTasksAndMembers(
      config,
      summary,
      members,
      previousSnapshot,
      scheduleData,
      avgDailySp,
      stagnantTasks,
      taskScheduleMapping
    );

    // Step 6: Interpret replies and propose allocations (with schedule data)
    const proposal = await interpretRepliesAndPropose(
      config,
      analysis,
      replyMap,
      activeThreads,
      members,
      scheduleData,
      summary,
      avgDailySp,
      yesterdayCompletedSp
    );
    console.log("Evening flow: proposal generated", {
      allocations: proposal.task_allocations.length
    });

    // Build deadline tasks table programmatically and append to pm_report
    // (【メンバー稼働余力】は廃止したのでスケジュール分析の後ろに付ける)
    const deadlineTable = formatDeadlineTasksTable(summary, today);
    const pmReport = proposal.pm_report + "\n\n" + deadlineTable;

    // Step 7: Send PM daily report to PMO channel (mention PM)
    const channel = targetChannel ?? "";
    if (!channel) {
      console.warn("SLACK_PMO_CHANNEL_ID not set; skipping PM report");
      return { ok: true, skipped: true, reason: "no pmo channel" };
    }

    const pmMention = config.slackPmUserId ? `<@${config.slackPmUserId}> ` : "";
    const pmReportText = pmMention + pmReport;

    if (config.dryRun) {
      console.log("DRY_RUN: PM report not sent", pmReportText.slice(0, 200));
      return { ok: true, dryRun: true, reason };
    }

    const pmResult = await chatPostMessage(
      config.slackBotToken,
      channel,
      pmReportText,
      buildPmReportButtons()
    );

    // Save PM thread so Events API can route PM's reply (Step 8)
    console.log(`[PM-SAVED-PENDING] evening flow, scope=${channelId}, channel=${pmResult.channel}, ts=${pmResult.ts}`);
    await savePmThread(env.NOTIFY_CACHE, today, {
      channel: pmResult.channel,
      ts: pmResult.ts,
      proposalJson: JSON.stringify(proposal),
      state: "pending"
    }, undefined, channelId);

    console.log("Evening flow complete", { reason, pmThreadTs: pmResult.ts });
    await saveCronHeartbeat(env.NOTIFY_CACHE, "evening");
    return { ok: true, reason, pmThreadTs: pmResult.ts };
  } catch (error) {
    const err = error as Error;
    console.error("runEveningFlow failed", err);
    return { ok: false, error: err.message };
  }
}

/** PM reminder: hourly 11:00-19:00 JST = 02:00-10:00 UTC */
async function runPmReminderFlow(
  env: Env,
  reason: string,
  channelId?: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = channelId ? await resolveConfig(env, channelId) : getConfig(env);

    if (!config.slackBotToken) {
      return { ok: true, skipped: true, reason: "no bot token" };
    }

    const today = toJstDateString();
    const pmThread = await getPmThread(env.NOTIFY_CACHE, today, channelId);

    if (!pmThread || pmThread.state !== "pending") {
      console.log("PM reminder: no pending PM thread for today");
      return { ok: true, skipped: true, reason: "no pending pm thread" };
    }

    // Dedup: skip if reminder was already sent within the last 50 minutes
    const reminderSentKey = `pm-reminder-sent:${channelId ?? "global"}:${today}`;
    const lastSent = await env.NOTIFY_CACHE.get(reminderSentKey);
    if (lastSent && reason !== "manual") {
      console.log("PM reminder: already sent recently, skipping");
      return { ok: true, skipped: true, reason: "already reminded recently" };
    }

    const channel = pmThread.channel;
    const pmMention = config.slackPmUserId ? `<@${config.slackPmUserId}> ` : "";

    if (config.dryRun) {
      console.log("DRY_RUN: would send PM reminder");
      return { ok: true, dryRun: true, reason };
    }

    await chatPostMessage(
      config.slackBotToken,
      channel,
      `${pmMention}リマインド: 本日のPMOレポートへの返信がまだのようです。割り振り提案の承認・修正をお願いします！`,
      undefined,
      pmThread.ts
    );

    // Mark reminder as sent (TTL 50 min = skip :15 trigger, allow next hour's :00)
    await env.NOTIFY_CACHE.put(reminderSentKey, new Date().toISOString(), {
      expirationTtl: 50 * 60
    });

    console.log("PM reminder sent", { reason, today });
    return { ok: true, reason, reminded: true };
  } catch (error) {
    const err = error as Error;
    console.error("runPmReminderFlow failed", err);
    return { ok: false, error: err.message };
  }
}

async function notifyError(_env: Env, config: AppConfig, error: Error) {
  if (!config.slackErrorWebhookUrl) return;
  const message = {
    text: `:rotating_light: Notion Sprint notifier failed\n${error.message}`
  };
  try {
    await postSlack(config.slackErrorWebhookUrl, message);
  } catch (err) {
    console.error("Failed to send error notification", err);
  }
}

// ── Progress SP Snapshot (05:00 JST = 20:00 UTC) ─────────────────────────

/** Save sprint progress_sp snapshot at 5AM JST for daily consumption calculation */
async function runProgressSpSnapshot(
  env: Env,
  reason: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = getConfig(env);
    const now = new Date();
    const today = toJstDateString(now);

    // タスクDBからスプリントタスクを取得し、進捗率(doing(60%)=0.6)でSPを集計する
    // groupTasksByAssignee は多担当タスクを複数グループに入れるため、IDで重複排除してから集計
    const fullSummary = await fetchCurrentSprintTasksSummary(config, now, { includeCompleted: true });
    const uniqueTasks = [
      ...new Map(
        fullSummary.assignees.flatMap((a) => a.tasks).map((t) => [t.id, t])
      ).values()
    ];
    const progressSp = uniqueTasks.reduce(
      (sum, t) => sum + (t.sp ?? 0) * statusProgressRate(t.status ?? null),
      0
    );

    // progress-sp-5am に累積SP保存
    const snapshotKey = `progress-sp-5am:${fullSummary.sprint.id}:${today}`;
    await env.NOTIFY_CACHE.put(snapshotKey, JSON.stringify({
      progress_sp: progressSp,
      timestamp: now.toISOString()
    }), { expirationTtl: config.dedupeTtlSeconds });

    // ダッシュボード履歴にも保存（過去日付を推定値ではなく実測値にする）
    // これにより24時のダッシュボード生成時に正確なバーンダウン曲線が描ける
    const dashTasks = await fetchSprintDashboardTasks(config, fullSummary.sprint.id).catch(() => null);
    if (dashTasks) {
      const dashSprint = {
        id: fullSummary.sprint.id,
        name: fullSummary.sprint.name,
        start_date: fullSummary.sprint.start_date,
        end_date: fullSummary.sprint.end_date,
        status: fullSummary.sprint.status
      };
      const snapshot = buildCurrentSpSnapshot(dashSprint, dashTasks, today);
      const history = await loadSpDashboardHistory(env.NOTIFY_CACHE, fullSummary.sprint.id);
      await saveSpDashboardSnapshot(env.NOTIFY_CACHE, snapshot, history);
      console.log(`Dashboard snapshot saved: ${today} teamCompletedSp=${snapshot.teamCompletedSp}`);
    }

    console.log(`Progress SP snapshot saved: ${snapshotKey} = ${progressSp} (${uniqueTasks.length} unique tasks, progress-rate weighted)`);
    await saveCronHeartbeat(env.NOTIFY_CACHE, "snapshot");
    return { ok: true, reason, progressSp, date: today };
  } catch (error) {
    const err = error as Error;
    console.error("runProgressSpSnapshot failed", err);
    return { ok: false, error: err.message };
  }
}

// ── End-of-Day Reminder Flow (midnight JST) ──────────────────────────────

async function runEodReminderFlow(
  env: Env,
  reason: string,
  channelId?: string
): Promise<Record<string, unknown>> {
  let config: AppConfig | undefined;
  try {
    config = channelId ? await resolveConfig(env, channelId) : getConfig(env);

    if (!config.slackBotToken) {
      return { ok: true, skipped: true, reason: "no bot token" };
    }

    // EOD runs at JST midnight — toJstDateString() already returns the new day,
    // but morning threads were saved under the previous day's date.
    // Try today first (in case manually triggered during the day), then fall back to yesterday.
    const today = toJstDateString();
    const yesterday = toJstDateString(new Date(), -1);
    let activeThreads = await getActiveThreads(env.NOTIFY_CACHE, today, channelId);
    let usedDate = today;
    if (activeThreads.length === 0) {
      activeThreads = await getActiveThreads(env.NOTIFY_CACHE, yesterday, channelId);
      usedDate = yesterday;
    }

    if (activeThreads.length === 0) {
      console.log(`EOD reminder: no active threads for ${today} or ${yesterday}`);
      return { ok: true, skipped: true, reason: "no active threads" };
    }
    console.log(`EOD reminder: found ${activeThreads.length} active threads for ${usedDate}`);

    let reminded = 0;
    for (const thread of activeThreads) {
      if (config.dryRun) {
        console.log(`DRY_RUN: would send EOD reminder to ${thread.assigneeName}`);
        continue;
      }

      await chatPostMessage(
        config.slackBotToken,
        thread.channel,
        `お疲れ様です！🌙 本日のタスクのステータスを更新しましょう！\n進捗があれば共有してください。`,
        buildEodReminderButtons(),
        thread.ts
      );
      reminded++;
    }

    console.log("EOD reminder flow complete", { reason, reminded });
    return { ok: true, reason, reminded };
  } catch (error) {
    const err = error as Error;
    console.error("runEodReminderFlow failed", err);
    return { ok: false, error: err.message };
  }
}

// ── Phone Reminder Flow (☎️ hourly DM reminders) ──────────────────────────

async function runPhoneReminderFlow(
  env: Env,
  trigger: "cron" | "manual"
): Promise<{ ok: boolean; message: string }> {
  const config = getConfig(env);
  if (!config.slackBotToken) {
    return { ok: false, message: "SLACK_BOT_TOKEN not configured" };
  }

  const reminders = await listAllPhoneReminders(env.NOTIFY_CACHE);
  if (reminders.length === 0) {
    console.log(`runPhoneReminderFlow(${trigger}): no active reminders`);
    return { ok: true, message: "No active phone reminders" };
  }

  const now = new Date();
  let sentCount = 0;

  for (const reminder of reminders) {
    // Only fire reminders that have a scheduled time, are pending, and the time has passed
    if (!reminder.remindAt || reminder.status !== "pending") continue;
    const remindAt = new Date(reminder.remindAt);
    if (now.getTime() < remindAt.getTime()) continue;

    try {
      const dmText =
        `☎️ *メッセージリマインド*\n` +
        `<${reminder.threadLink}|メッセージを見る>\n\n` +
        (reminder.messageContent ? `───────────────\n${reminder.messageContent}\n───────────────\n\n` : "") +
        `_再度リマインドしたい場合は時間を選択してください。_`;

      const dmChannelId = reminder.dmChannel || await conversationsOpen(config.slackBotToken, reminder.userId);
      if (!dmChannelId) continue;

      await chatPostMessage(
        config.slackBotToken,
        dmChannelId,
        dmText,
        [buildReminderDeliveryButtons(reminder.userId, reminder.channel, reminder.threadTs)]
      );

      // Mark as fired (won't fire again until rescheduled)
      await savePhoneReminder(
        env.NOTIFY_CACHE,
        reminder.userId,
        reminder.channel,
        reminder.threadTs,
        { ...reminder, status: "fired" }
      );

      sentCount++;
    } catch (err) {
      console.error(`Phone reminder failed for user=${reminder.userId} thread=${reminder.threadTs}:`, err);
    }
  }

  const msg = `Sent ${sentCount} phone reminders out of ${reminders.length} active (trigger=${trigger})`;
  console.log(`runPhoneReminderFlow: ${msg}`);
  return { ok: true, message: msg };
}

// ── Cron Health Check (watchdog) ────────────────────────────────────────────

interface CronMonitorRule {
  name: string;
  checkStartJst: number;  // JST hour to start checking
  checkEndJst: number;    // JST hour to stop checking
  expectedJst: string;    // Display string for alert
  manualEndpoint: string; // Manual trigger path
}

const CRON_MONITOR_RULES: CronMonitorRule[] = [
  { name: "morning",  checkStartJst: 9,  checkEndJst: 10, expectedJst: "09:00", manualEndpoint: "/pmo/morning" },
  { name: "evening",  checkStartJst: 10, checkEndJst: 11, expectedJst: "10:00", manualEndpoint: "/pmo/evening" },
  { name: "snapshot", checkStartJst: 5,  checkEndJst: 6,  expectedJst: "05:00", manualEndpoint: "/pmo/progress-snapshot" },
];

async function runCronHealthCheck(env: Env): Promise<void> {
  const config = getConfig(env);
  if (!config.slackBotToken || !config.slackPmUserId) return;

  const now = new Date();
  const jstHour = (now.getUTCHours() + 9) % 24;
  const jstMinute = now.getUTCMinutes();
  const today = toJstDateString(now);

  for (const rule of CRON_MONITOR_RULES) {
    // Only check within the 30-min window after expected time
    // e.g. morning (09:00): check at 09:30-09:45 (jstHour=9, minute>=30)
    const inCheckWindow =
      (jstHour === rule.checkStartJst && jstMinute >= 30) ||
      (jstHour === rule.checkEndJst && jstMinute === 0);
    if (!inCheckWindow) continue;

    // Already alerted today?
    if (await hasCronAlertBeenSent(env.NOTIFY_CACHE, rule.name, today)) continue;

    // Check heartbeat
    const heartbeat = await getCronHeartbeat(env.NOTIFY_CACHE, rule.name);
    if (heartbeat) {
      const heartbeatDate = toJstDateString(new Date(heartbeat));
      if (heartbeatDate === today) continue; // Already ran today
    }

    // Alert: cron didn't fire today
    const dmChannelId = await conversationsOpen(config.slackBotToken, config.slackPmUserId);
    if (!dmChannelId) continue;

    await chatPostMessage(
      config.slackBotToken,
      dmChannelId,
      `⚠️ *cron 未実行アラート*\n` +
      `\`${rule.name}\` が本日 ${rule.expectedJst} JST に実行されていません。\n` +
      `手動実行: \`curl https://notion-sprint-worker-dev.tomoya-kotetsu.workers.dev${rule.manualEndpoint}\``
    );

    await markCronAlertSent(env.NOTIFY_CACHE, rule.name, today);
    console.log(`Cron health alert sent: ${rule.name} missing for ${today}`);
  }
}

// ── Missed cron catch-up ──────────────────────────────────────────────────
// When crons resume after a Cloudflare outage, automatically re-run missed flows.

async function runMissedCronCatchup(env: Env): Promise<void> {
  try {
    const now = new Date();
    const today = toJstDateString(now);
    const jstHour = (now.getUTCHours() + 9) % 24;
    const jstMinute = now.getUTCMinutes();
    // Combined JST time for range checks (e.g. 9.5 = 09:30)
    const jstTime = jstHour + jstMinute / 60;

    const isFromToday = (hb: string | null): boolean => {
      if (!hb) return false;
      return toJstDateString(new Date(hb)) === today;
    };

    // Prevent double catch-up per day per flow
    const tryCatchup = async (name: string): Promise<boolean> => {
      const key = `cron-catchup:${name}:${today}`;
      if (await env.NOTIFY_CACHE.get(key)) return false;
      await env.NOTIFY_CACHE.put(key, new Date().toISOString(), { expirationTtl: 86400 });
      return true;
    };

    // Snapshot (expected 05:00 JST, catch up 05:30–09:00)
    // 30min buffer avoids racing with the normal 05:00 cron
    if (jstTime >= 5.5 && jstHour < 9) {
      const hb = await getCronHeartbeat(env.NOTIFY_CACHE, "snapshot");
      if (!isFromToday(hb) && await tryCatchup("snapshot")) {
        console.log("Catch-up: snapshot missed, running now");
        await runProgressSpSnapshot(env, "catchup");
        return; // one catch-up per cycle
      }
    }

    // Morning (expected 09:00 JST, catch up 09:30–13:00)
    // 30min buffer avoids racing with the normal 09:00 cron
    if (jstTime >= 9.5 && jstHour < 13) {
      const hb = await getCronHeartbeat(env.NOTIFY_CACHE, "morning");
      if (!isFromToday(hb) && await tryCatchup("morning")) {
        console.log("Catch-up: morning flow missed, running now");
        await runForAllChannels(env, (ch) => runMorningFlow(env, "catchup", null, ch));
        return;
      }
    }

    // Evening (expected 10:00 JST, catch up 10:30–16:00)
    // 30min buffer + dependency: morning must have run today + at least 30 min ago
    if (jstTime >= 10.5 && jstHour < 16) {
      const morningHb = await getCronHeartbeat(env.NOTIFY_CACHE, "morning");
      const eveningHb = await getCronHeartbeat(env.NOTIFY_CACHE, "evening");
      if (isFromToday(morningHb) && !isFromToday(eveningHb)) {
        const morningTime = new Date(morningHb!);
        if (now.getTime() - morningTime.getTime() >= 30 * 60 * 1000) {
          if (await tryCatchup("evening")) {
            console.log("Catch-up: evening flow missed, running now");
            await runForAllChannels(env, (ch) => runEveningFlow(env, "catchup", ch));
            return;
          }
        }
      }
    }
  } catch (err) {
    console.error("Catch-up check failed:", (err as Error).message);
  }
}

// ── HTTP handler ───────────────────────────────────────────────────────────

async function handleHttp(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // テスト用メッセージ削除
  if (path === "/test/slack-bullet-cleanup") {
    const cfg = getConfig(env);
    if (!cfg.slackBotToken) return jsonResponse({ ok: false, message: "no bot token" });
    const ch = resolveTeamKChannelId(env);
    const histRes = await fetch(`https://slack.com/api/conversations.history?channel=${ch}&limit=20`, {
      headers: { Authorization: `Bearer ${cfg.slackBotToken}` }
    });
    const hist = await histRes.json() as { ok: boolean; messages?: Array<{ ts: string; text?: string; bot_id?: string }> };
    const toDelete = (hist.messages ?? []).filter((m) => m.text?.includes("テストタスク名"));
    for (const m of toDelete) {
      await fetch("https://slack.com/api/chat.delete", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.slackBotToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: ch, ts: m.ts })
      });
    }
    return jsonResponse({ ok: true, deleted: toDelete.length });
  }

  if (path === "/health") {
    const heartbeats = await getAllCronHeartbeats(env.NOTIFY_CACHE);
    return jsonResponse({ status: "ok", crons: heartbeats });
  }

  // Delivery OS read-only snapshot: Notionの案件単価・工数・FTE・Health判定を確認する。
  if (path === "/pmo/delivery-control") {
    try {
      const config = getConfig(env);
      const now = new Date();
      const snapshot = await fetchDeliveryControlSnapshot(config, now);
      const assessments = assessSnapshot(snapshot, now);
      return jsonResponse({
        ok: true,
        snapshot,
        assessments,
        updateGaps: collectAssigneeUpdateGaps(snapshot),
        assigneeCapacity: calculateAssigneeCapacity(snapshot),
        expansionReminders: collectExpansionReminders(assessments)
      });
    } catch (error) {
      return jsonResponse({ ok: false, error: (error as Error).message }, 500);
    }
  }

  if (path === "/pmo/delivery-digest") {
    return jsonResponse(await runDeliveryMorningFlow(env, "manual"));
  }

  if (path === "/pmo/delivery-reminder") {
    return jsonResponse(await runDeliveryUpdateReminderFlow(env, "manual"));
  }

  if (path === "/pmo/delivery-alerts") {
    return jsonResponse(await runDeliveryAlertFlow(env, "manual"));
  }

  if (path === "/pmo/delivery-portfolio") {
    return jsonResponse(await runDeliveryPortfolioFlow(env, "manual"));
  }

  // Admin: send PM report to a specific user's DM (for testing)
  if (path === "/pmo/pm-test") {
    const targetUserId = url.searchParams.get("user");
    if (!targetUserId) {
      return jsonResponse({ ok: false, message: "?user=U... required" });
    }
    const cfg = getConfig(env);
    if (!cfg.slackBotToken) return jsonResponse({ ok: false, message: "no bot token" });

    const today = toJstDateString();
    const pmThread = await getPmThread(env.NOTIFY_CACHE, today);
    if (!pmThread) {
      return jsonResponse({ ok: false, message: "no pm thread for today. Run /pmo/evening first" });
    }

    const dmChannelId = await conversationsOpen(cfg.slackBotToken, targetUserId);
    if (!dmChannelId) return jsonResponse({ ok: false, message: "failed to open DM" });

    const proposal = JSON.parse(pmThread.proposalJson);
    const pmResult = await chatPostMessage(
      cfg.slackBotToken,
      dmChannelId,
      proposal.pm_report ?? "PM report test",
      buildPmReportButtons()
    );

    // Save PM thread with the DM's ts so the OK button works
    await savePmThread(env.NOTIFY_CACHE, today, {
      channel: dmChannelId,
      ts: pmResult.ts,
      proposalJson: pmThread.proposalJson,
      state: "pending"
    });

    return jsonResponse({ ok: true, dmChannel: dmChannelId, ts: pmResult.ts });
  }

  // Admin: mark today's PM thread as processed (stop reminders)
  if (path === "/pmo/pm-dismiss") {
    const today = toJstDateString();
    const pmThread = await getPmThread(env.NOTIFY_CACHE, today);
    if (!pmThread) {
      return jsonResponse({ ok: false, message: "no pm thread for today" });
    }
    console.log(`[PM-PROCESSED-BY] /pmo/pm-dismiss endpoint`);
    await savePmThread(env.NOTIFY_CACHE, today, { ...pmThread, state: "processed" });
    return jsonResponse({ ok: true, message: "pm thread marked as processed" });
  }

  // Debug: resolve a Slack channel name → ID (read-only, conversations.list)
  if (path === "/pmo/channel-lookup") {
    const config = getConfig(env);
    const name = url.searchParams.get("name") || "";
    if (!config.slackBotToken || !name) return jsonResponse({ ok: false, error: "name required" }, 400);
    const id = await findChannelIdByName(config.slackBotToken, name);
    return jsonResponse({ ok: true, name, id });
  }

  // Debug: inspect today's PM thread state
  if (path === "/pmo/pm-debug") {
    const today = toJstDateString();
    const globalPm = await getPmThread(env.NOTIFY_CACHE, today);
    const channels = await listAllChannelConfigs(env.NOTIFY_CACHE);
    const channelPms: Record<string, unknown> = {};
    for (const { channelId } of channels) {
      const pm = await getPmThread(env.NOTIFY_CACHE, today, channelId);
      if (pm) channelPms[channelId] = pm;
    }
    const globalConfig = getConfig(env);
    const pmoChannelPm = globalConfig.slackPmoChannelId
      ? await getPmThread(env.NOTIFY_CACHE, today, globalConfig.slackPmoChannelId)
      : null;
    return jsonResponse({
      today,
      globalPm,
      pmoChannelPm,
      channelPms,
      registeredChannels: channels.length,
      pmoChannelId: globalConfig.slackPmoChannelId
    });
  }

  // Slack Events API
  if (path === "/slack/events" && request.method === "POST") {
    return handleSlackEvents(request, env, ctx);
  }

  // Notion Webhook (プロパティ変更通知 → 当日スレッドに「○○が変わりました」を投稿)
  if (path === "/notion/webhook" && request.method === "POST") {
    return handleNotionWebhook(request, env, ctx);
  }

  // Slack Reaction handler (Step 8 confirmation via emoji reaction)
  if (path === "/slack/reaction" && request.method === "POST") {
    // Reaction events come via Events API; this endpoint is a convenience alias
    return handleSlackEvents(request, env, ctx);
  }

  // Slack Interactivity (button clicks, select menus, etc.)
  if (path === "/slack/interactions" && request.method === "POST") {
    return handleSlackInteractions(request, env, ctx);
  }

  if (path === "/run-now") {
    const config = getConfig(env);
    if (
      config.requireApproval === "always" &&
      url.searchParams.get("approved") !== "true"
    ) {
      return jsonResponse(
        { ok: false, message: "approval required (add ?approved=true)" },
        403
      );
    }
    const result = await runReport(env, "manual");
    return jsonResponse(result);
  }

  if (path === "/run-sprint-tasks") {
    const config = getConfig(env);
    if (
      config.requireApproval === "always" &&
      url.searchParams.get("approved") !== "true"
    ) {
      return jsonResponse(
        { ok: false, message: "approval required (add ?approved=true)" },
        403
      );
    }
    const result = await runSprintTasksReport(env, "manual");
    return jsonResponse(result);
  }

  // PMO AI Agent flow triggers (manual)
  if (path === "/pmo/morning") {
    const target = url.searchParams.get("target");
    const result = await runMorningFlow(env, "manual", target);
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  // 本日の進捗サマリー（手動テスト）: 当日の day-start と現在値を比較してスレッドに投稿
  if (path === "/pmo/progress-summary") {
    const result = await runDailyProgressSummary(env, "manual", resolveTeamKChannelId(env));
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/task-reminder") {
    // ?debug=1 → Slackには投稿せず、today・期限window・対象タスク（スプリント非依存）を返す
    if (url.searchParams.get("debug")) {
      const config = getConfig(env);
      const now = new Date();
      const today = toJstDateString(now);
      const dueStart = toJstDateString(now, -3);
      const dueEnd = toJstDateString(now, 10);
      const dueRange = await fetchTasksByDueRange(config, dueStart, dueEnd);
      const userCatalog = await ensureUserCatalog(env, config).catch(() => []);
      const members = await fetchMembers(config).catch(() => []);
      const assignees = dueRange.assignees
        .filter((a) => a.name !== "未割当")
        .map((a) => {
          const catalogSlackId = resolveSlackUserIdByName(userCatalog, a.name) ?? null;
          const legacySlackId = members.find(
            (m) => m.name === a.name || a.name.includes(m.name) || m.name.includes(a.name)
          )?.slackUserId ?? null;
          return {
            name: a.name,
            mentionResolved: !!catalogSlackId,
            catalogSlackId,
            legacySlackId,
            taskCount: a.tasks.filter((t) => !isHiddenFromList(t.status)).length
          };
        });
      // 生の日付プロパティをダンプ（実行日→期日のレンジがどのプロパティかを特定）
      let rawDates: unknown = null;
      if (config.taskDbId) {
        const r = await fetch(`https://api.notion.com/v1/databases/${config.taskDbId}/query`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.notionToken}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
          body: JSON.stringify({
            filter: { and: [{ property: "期限", date: { on_or_after: dueStart } }, { property: "期限", date: { on_or_before: dueEnd } }] },
            page_size: 6
          })
        }).catch(() => null);
        if (r && r.ok) {
          const j = (await r.json()) as { results?: Array<{ properties?: Record<string, any> }> };
          rawDates = (j.results ?? []).map((p) => {
            const props = p.properties ?? {};
            const titleProp = Object.values(props).find((v: any) => v?.type === "title") as any;
            const title = (titleProp?.title ?? []).map((t: any) => t.plain_text ?? "").join("");
            const dates = Object.entries(props)
              .filter(([, v]: [string, any]) => v?.type === "date")
              .map(([name, v]: [string, any]) => ({ name, start: v.date?.start ?? null, end: v.date?.end ?? null }));
            return { title, dates };
          });
        }
      }
      // タイムライン用タスク（苗字化）
      const tlTasks = dueRange.assignees
        .filter((a) => a.name !== "未割当")
        .flatMap((a) => {
          const member = resolveMemberByName(userCatalog, a.name);
          const surname = member?.name ?? a.name.split(/[｜|/／\s]/)[0];
          return a.tasks.filter((t) => !isHiddenFromList(t.status) && t.due).map((t) => ({
            name: t.name, assignee: surname, status: t.status ?? "",
            project: t.projectName ? abbreviateProject(t.projectName) : "",
            start: t.startDate ?? (t.due as string), end: t.dueEnd ?? (t.due as string), sp: t.sp ?? null
          }));
        });
      // ?debug=html → タイムラインのHTMLをそのまま返す（ローカルで見た目確認用）
      if (url.searchParams.get("debug") === "html") {
        return new Response(renderTimelineHtml(tlTasks, dueStart, dueEnd, today), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      // ?debug=notion → 実Notionタイムラインのアバター画像読み込み状態を計測して返す
      if (url.searchParams.get("debug") === "notion" || url.searchParams.get("debug") === "notionpng") {
        const session = await getNotionSession(env.NOTIFY_CACHE);
        const tlUrl = env.NOTION_TIMELINE_VIEW_URL || DEFAULT_NOTION_TIMELINE_URL;
        const wantPng = url.searchParams.get("debug") === "notionpng";
        const avatarMap = await fetchNotionAvatarMap(getConfig(env).notionToken).catch(() => ({}));
        const diag = await captureNotionTimelineDebug(env.BROWSER, session, tlUrl, wantPng, avatarMap);
        if (wantPng && diag.png) {
          return new Response(diag.png as unknown as BodyInit, { headers: { "Content-Type": "image/png" } });
        }
        const { png, ...rest } = diag;
        return jsonResponse(rest);
      }
      // ?debug=png → Browser Rendering で描画したスクショPNGを返す（Slack投稿せず確認用）
      if (url.searchParams.get("debug") === "png") {
        const png = await buildTimelinePng(env.BROWSER, tlTasks, dueStart, dueEnd, today);
        if (!png) return jsonResponse({ ok: false, error: "timeline png failed (BROWSER unbound?)" }, 500);
        return new Response(png as unknown as BodyInit, { headers: { "Content-Type": "image/png" } });
      }
      return jsonResponse({ today, nowUtc: now.toISOString(), dueWindow: { start: dueStart, end: dueEnd }, taskCount: tlTasks.length, assignees, rawDates });
    }
    const result = await runTaskReminderFlow(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/sprint-tasks-debug") {
    const config = getConfig(env);
    const now = new Date();
    const fullSummary = await fetchCurrentSprintTasksSummary(config, now, { includeCompleted: true }).catch((e) => ({ error: (e as Error).message }));
    if ("error" in (fullSummary as object)) return jsonResponse({ ok: false, ...(fullSummary as object) });
    const s = fullSummary as SprintTasksSummary;
    const allTasks = s.assignees.flatMap((a) => a.tasks.map((t) => ({ assignee: a.name, ...t })));
    const uniqueById = new Map(allTasks.map((t) => [t.id, t]));
    return jsonResponse({
      ok: true,
      sprint: s.sprint,
      taskCount: uniqueById.size,
      tasks: [...uniqueById.values()].map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        sp: t.sp,
        isCompleted: isCompletedStatus(t.status ?? null)
      }))
    });
  }

  // debug: 期間内(完了日ベース、スプリント非依存)に完了したタスクを担当者でフィルタして集計する
  if (path === "/pmo/completed-by-assignee-debug") {
    const config = getConfig(env);
    const start = url.searchParams.get("start") || "2026-07-15";
    const end = url.searchParams.get("end") || "2026-08-21";
    const assigneeQuery = url.searchParams.get("assignee") || "";
    const tasks = await fetchCompletedTasksByDateRange(config, { start, end }).catch(
      (e) => ({ error: (e as Error).message })
    );
    if ("error" in (tasks as object)) return jsonResponse({ ok: false, ...(tasks as object) });
    const filtered = (tasks as Array<{ id: string; name: string; sp: number; status: string | null; assignees: string[]; completedDate: string | null }>).filter(
      (t) =>
        isCompletedStatus(t.status) &&
        (!assigneeQuery || t.assignees.some((a) => a.includes(assigneeQuery)))
    );
    const totalSp = filtered.reduce((sum, t) => sum + t.sp, 0);
    return jsonResponse({
      ok: true,
      range: { start, end },
      assignee: assigneeQuery || "(all)",
      taskCount: filtered.length,
      totalSp,
      tasks: filtered.map((t) => ({
        name: t.name,
        sp: t.sp,
        status: t.status,
        assignees: t.assignees,
        completedDate: t.completedDate
      }))
    });
  }

  // debug: 期間内(期限ベースの週次スプリントをまたいで走査)の完了タスクを、担当者×プロジェクトで集計する
  if (path === "/pmo/completed-by-project-debug") {
    const config = getConfig(env);
    const start = url.searchParams.get("start") || "2026-07-15";
    const end = url.searchParams.get("end") || "2026-08-21";
    const assigneeQuery = url.searchParams.get("assignee") || "";
    const sprints = await fetchAllSprints(config).catch(() => []);
    const overlapping = sprints.filter((s) => s.start_date <= end && s.end_date >= start);
    const byId = new Map<string, SprintDashboardTask>();
    for (const sprint of overlapping) {
      const tasks = await fetchSprintDashboardTasks(config, sprint.id).catch(() => []);
      for (const t of tasks) byId.set(t.id, t);
    }
    const filtered = [...byId.values()].filter(
      (t) =>
        isCompletedStatus(t.status) &&
        (!assigneeQuery || t.assignees.some((a) => a.includes(assigneeQuery)))
    );
    const byProject = new Map<string, { sp: number; count: number; names: string[] }>();
    for (const t of filtered) {
      const key = t.projectNames[0] || "(プロジェクト未設定)";
      const entry = byProject.get(key) || { sp: 0, count: 0, names: [] };
      entry.sp += t.sp;
      entry.count += 1;
      entry.names.push(t.name);
      byProject.set(key, entry);
    }
    return jsonResponse({
      ok: true,
      range: { start, end },
      assignee: assigneeQuery || "(all)",
      sprintsScanned: overlapping.map((s) => s.name),
      taskCount: filtered.length,
      totalSp: filtered.reduce((sum, t) => sum + t.sp, 0),
      byProject: Object.fromEntries(byProject)
    });
  }

  // debug: ステータスが「完了」になった日(完了日、無ければ最終更新日で代替)が [start, end] のタスクを担当者×プロジェクトで一覧する
  if (path === "/pmo/completed-window-debug") {
    const config = getConfig(env);
    const start = url.searchParams.get("start") || "2026-08-15";
    const end = url.searchParams.get("end") || "2026-08-21";
    const assigneeQuery = url.searchParams.get("assignee") || "";
    const sprints = await fetchAllSprints(config).catch(() => []);
    const byId = new Map<string, SprintDashboardTask>();
    for (const sprint of sprints) {
      const tasks = await fetchSprintDashboardTasks(config, sprint.id).catch(() => []);
      for (const t of tasks) byId.set(t.id, t);
    }
    const withEffectiveDate = [...byId.values()].map((t) => ({
      ...t,
      effectiveDate: t.completedDate ?? t.lastEditedDate,
      dateSource: t.completedDate ? "完了日" : "最終更新日(代替)"
    }));
    const filtered = withEffectiveDate.filter(
      (t) =>
        isCompletedStatus(t.status) &&
        (!assigneeQuery || t.assignees.some((a) => a.includes(assigneeQuery))) &&
        t.effectiveDate &&
        t.effectiveDate >= start &&
        t.effectiveDate <= end
    );
    return jsonResponse({
      ok: true,
      range: { start, end },
      assignee: assigneeQuery || "(all)",
      taskCount: filtered.length,
      totalSp: filtered.reduce((sum, t) => sum + t.sp, 0),
      tasks: filtered.map((t) => ({
        name: t.name,
        sp: t.sp,
        project: t.projectNames[0] ?? "(プロジェクト未設定)",
        assignees: t.assignees,
        effectiveDate: t.effectiveDate,
        dateSource: t.dateSource
      }))
    });
  }

  // debug: webhook でステータス→完了を検知した瞬間の永続ログを一覧する(完了日プロパティに依存しない正確な記録)
  if (path === "/pmo/completed-log-debug") {
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    const assigneeQuery = url.searchParams.get("assignee") || "";
    const projectQuery = url.searchParams.get("project") || "";
    const all = await listTaskCompletions(env.NOTIFY_CACHE);
    const toJstDate = (iso: string) =>
      new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const filtered = all.filter((t: TaskCompletionRecord) => {
      const day = toJstDate(t.completedAt);
      if (start && day < start) return false;
      if (end && day > end) return false;
      if (assigneeQuery && !t.assignees.some((a) => a.includes(assigneeQuery))) return false;
      if (projectQuery && !(t.project ?? "").includes(projectQuery)) return false;
      return true;
    });
    return jsonResponse({
      ok: true,
      range: { start: start ?? "(all)", end: end ?? "(all)" },
      assignee: assigneeQuery || "(all)",
      project: projectQuery || "(all)",
      taskCount: filtered.length,
      totalSp: filtered.reduce((sum, t) => sum + (t.sp ?? 0), 0),
      tasks: filtered.map((t) => ({
        name: t.name,
        sp: t.sp,
        project: t.project,
        assignees: t.assignees,
        completedAtJst: toJstDate(t.completedAt),
        completedAt: t.completedAt
      }))
    });
  }

  // debug: 指定ページIDの生プロパティをそのまま返す(フィールド名・値の確認用)
  if (path === "/pmo/task-raw-debug") {
    const config = getConfig(env);
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ ok: false, error: "id query param required" }, 400);
    const res = await fetch(`https://api.notion.com/v1/pages/${id}`, {
      headers: {
        Authorization: `Bearer ${config.notionToken}`,
        "Notion-Version": "2022-06-28"
      }
    });
    const data = (await res.json()) as any;
    return jsonResponse({ ok: res.ok, status: res.status, properties: data?.properties ?? data });
  }

  if (path === "/pmo/burndown") {
    // ?sprint=s16 で指定。未指定なら現スプリント(期間内 or 進行中)。
    const config = getConfig(env);
    const now = new Date();
    const today = toJstDateString(now);
    const wantName = url.searchParams.get("sprint");
    const sprints = await fetchAllSprints(config).catch(() => []);
    const norm = (s: string) => s.toLowerCase().replace(/[\s　_-]/g, "");
    const sprint = wantName
      ? sprints.find((s) => norm(s.name) === norm(wantName))
      : sprints.find((s) => s.start_date <= today && today <= s.end_date) ??
        sprints.find((s) => /進行中|active|in progress/i.test(s.status));
    if (!sprint) return jsonResponse({ ok: false, error: `sprint not found: ${wantName ?? "(current)"}` }, 404);

    const tasks = await fetchSprintBurndownTasks(config, sprint.id);
    const series = buildBurndownSeries(sprint.name, sprint.start_date, sprint.end_date, tasks, today);

    if (url.searchParams.get("debug") === "1") {
      return jsonResponse({ ok: true, sprint: sprint.name, taskCount: tasks.length, series });
    }
    if (url.searchParams.get("debug") === "html") {
      return new Response(renderBurndownHtml(series), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (url.searchParams.get("debug") === "png") {
      const png = await buildBurndownPng(env.BROWSER, series);
      if (!png) return jsonResponse({ ok: false, error: "burndown png failed" }, 500);
      return new Response(png as unknown as BodyInit, { headers: { "Content-Type": "image/png" } });
    }

    const channel = config.slackPmoChannelId;
    if (!config.slackBotToken || !channel) return jsonResponse({ ok: false, error: "no bot token / channel" }, 400);
    const png = await buildBurndownPng(env.BROWSER, series);
    if (!png) return jsonResponse({ ok: false, error: "burndown png failed" }, 500);
    await uploadImageToSlack(config.slackBotToken, channel, undefined, `burndown-${sprint.name}.png`, png, `【バーンダウン】 ${sprint.name}`);
    return jsonResponse({ ok: true, sprint: sprint.name, total: series.total, taskCount: tasks.length });
  }

  if (path === "/pmo/sprint-planning") {
    const result = await runSprintPlanningFlow(
      env,
      "manual",
      resolveTeamKChannelId(env)
    );
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  // 計画Lock後のScope差分を読み取り専用で確認する。
  if (path === "/pmo/sprint-scope") {
    try {
      const state = await prepareSprintScopeFlowState(env);
      return jsonResponse(
        state
          ? { ok: true, diff: state.diff, message: renderSprintScopeDiff(state.diff) }
          : { ok: true, skipped: true, reason: "baseline or current sprint not found" }
      );
    } catch (error) {
      return jsonResponse({ ok: false, error: (error as Error).message }, 500);
    }
  }

  if (path === "/pmo/sprint-scope-alert") {
    const result = await runSprintScopeControlFlow(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  // チャンネルの最新ファイル投稿を削除するエンドポイント（前回の dashboard 投稿を消すため）。
  // ?count=N で削除件数（デフォルト2）、?channel_id=xxx でチャンネルを直接指定可。
  // 指定スレッド(親+返信全件)をまとめて削除する後始末用エンドポイント。?channel=...&ts=<parentTs>
  if (path === "/pmo/delete-thread") {
    const config = getConfig(env);
    if (!config.slackBotToken) return jsonResponse({ ok: false, error: "SLACK_BOT_TOKEN not set" }, 400);
    const channel = url.searchParams.get("channel") || "";
    const parentTs = url.searchParams.get("ts") || "";
    if (!channel || !parentTs) return jsonResponse({ ok: false, error: "channel, ts は必須" }, 400);
    const replies = await conversationsReplies(config.slackBotToken, channel, parentTs, 100, true).catch(() => []);
    const targets = replies.length > 0 ? replies.map((m) => m.ts) : [parentTs];
    const results: Array<{ ts: string; deleted: boolean }> = [];
    for (const ts of targets) {
      const deleted = await deleteSlackMessage(config.slackBotToken, channel, ts).catch(() => false);
      results.push({ ts, deleted });
    }
    return jsonResponse({ ok: true, channel, parentTs, count: results.length, results });
  }

  if (path === "/pmo/delete-last-dashboard") {
    const config = getConfig(env);
    if (!config.slackBotToken) return jsonResponse({ ok: false, error: "SLACK_BOT_TOKEN not set" }, 400);
    const count = Math.min(10, parseInt(url.searchParams.get("count") ?? "2", 10));
    const channelName = env.S19_SCREENSHOT_CHANNEL || "team-k-古鉄";
    const channelId = url.searchParams.get("channel_id") ||
      env.S19_SCREENSHOT_CHANNEL_ID ||
      (await findChannelIdByName(config.slackBotToken, channelName));
    if (!channelId) return jsonResponse({ ok: false, error: `channel not found: ${channelName}` }, 400);

    const histRes = await fetch(`https://slack.com/api/conversations.history?channel=${channelId}&limit=20`, {
      headers: { Authorization: `Bearer ${config.slackBotToken}` }
    });
    const hist = (await histRes.json()) as { ok: boolean; messages?: Array<{ ts?: string; files?: unknown[] }> };
    if (!hist.ok) return jsonResponse({ ok: false, error: "conversations.history failed" }, 500);

    const fileMsgs = (hist.messages ?? []).filter((m) => Array.isArray(m.files) && m.files.length > 0);
    const toDelete = fileMsgs.slice(0, count);
    const results: Array<{ ts: string; deleted: boolean }> = [];
    for (const msg of toDelete) {
      if (!msg.ts) continue;
      const deleted = await deleteSlackMessage(config.slackBotToken, channelId, msg.ts);
      results.push({ ts: msg.ts, deleted });
    }
    return jsonResponse({ ok: true, deleted: results.length, results });
  }

  // 特定の1投稿を channel_id + ts 指定で削除するエンドポイント（bot 自身の投稿のみ削除可）。
  // ts は Slack パーマリンの p1234567890123456 部分を "1234567890.123456" 形式に変換して渡す。
  if (path === "/pmo/delete-message") {
    const config = getConfig(env);
    if (!config.slackBotToken) return jsonResponse({ ok: false, error: "SLACK_BOT_TOKEN not set" }, 400);
    const channelId = url.searchParams.get("channel_id");
    const ts = url.searchParams.get("ts");
    if (!channelId || !ts) return jsonResponse({ ok: false, error: "channel_id and ts are required" }, 400);
    const deleted = await deleteSlackMessage(config.slackBotToken, channelId, ts);
    return jsonResponse({ ok: deleted, channel_id: channelId, ts });
  }

  if (path === "/pmo/sp-dashboard" || path === "/pmo/sp-dashboard-v2") {
    const config = getConfig(env);
    const rawDate = url.searchParams.get("date");
    if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return jsonResponse({ ok: false, error: "date must be YYYY-MM-DD" }, 400);
    }
    const reportDate = rawDate ?? toJstDateString(new Date());
    const sprintName = url.searchParams.get("sprint");
    const debug = url.searchParams.get("debug");

    try {
      if (
        debug === "data" ||
        debug === "html" ||
        debug === "png" ||
        debug === "details-data" ||
        debug === "details-html" ||
        debug === "details-png"
      ) {
        const prepared = await prepareSpGamificationDashboard(env, {
          reportDate,
          sprintName,
          persistSnapshot: false
        });
        if (debug === "data") {
          return jsonResponse({
            ok: true,
            taskCount: prepared.taskCount,
            data: prepared.data
          });
        }
        if (debug === "details-data") {
          return jsonResponse({
            ok: true,
            taskCount: prepared.taskCount,
            details: prepared.details
          });
        }
        const background =
          url.searchParams.get("ai") === "1"
            ? await generateAiDashboardBackground(config, prepared.data)
            : { base64: null, model: config.openaiImageModel, error: "disabled" };
        if (debug === "html") {
          return new Response(renderSpDashboardHtml(prepared.data, background), {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
        if (debug === "details-html") {
          return new Response(
            renderSpTaskDetailsHtml(prepared.details, background),
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }
        const png =
          debug === "details-png"
            ? await buildSpTaskDetailsPng(
                env.BROWSER,
                prepared.details,
                background
              )
            : await buildSpDashboardPng(
                env.BROWSER,
                prepared.data,
                background
              );
        if (!png) {
          return jsonResponse(
            {
              ok: false,
              error:
                debug === "details-png"
                  ? "task details PNG render failed"
                  : "dashboard PNG render failed"
            },
            500
          );
        }
        return new Response(png as unknown as BodyInit, {
          headers: {
            "Content-Type": "image/png",
            "X-AI-Theme-Used": String(!!background.base64),
            ...(background.error
              ? { "X-AI-Theme-Error": encodeURIComponent(background.error.slice(0, 180)) }
              : {})
          }
        });
      }

      // ?to=dm は本番チャンネルへ送らず、古鉄の DM へ実画像を投稿する受入テスト用。
      let channelId: string | undefined;
      if (url.searchParams.get("to") === "dm") {
        if (config.slackBotToken && config.slackPmUserId) {
          channelId = await conversationsOpen(
            config.slackBotToken,
            config.slackPmUserId
          ).catch(() => undefined);
        }
        if (!channelId) {
          return jsonResponse(
            { ok: false, error: "DM open failed (SLACK_PM_USER_ID 未設定?)" },
            400
          );
        }
      }
      const result = await runSpGamificationDashboard(env, "manual", {
        channelId,
        reportDate,
        sprintName,
        useAi: url.searchParams.get("noai") !== "1"
      });
      return jsonResponse(result, result.ok ? 200 : 500);
    } catch (error) {
      return jsonResponse(
        { ok: false, error: (error as Error).message ?? "unknown error" },
        500
      );
    }
  }

  if (path === "/pmo/s19-screenshot") {
    const resolveDebugTarget = (): string => resolveDailyKpiTarget(env, { explicitUrl: url.searchParams.get("url") }).url;
    const parseDebugDateParam = (): { m: number; d: number } | null => {
      const dq = url.searchParams.get("date");
      if (!dq) return null;
      const md = dq.match(/(\d{1,2})\D+(\d{1,2})/);
      return md ? { m: parseInt(md[1], 10), d: parseInt(md[2], 10) } : null;
    };

    // ?debug=png → Slack送信せずスクショPNGを返す（確認用）
    if (url.searchParams.get("debug") === "probe") {
      const info = await probeBrowserCapabilities(env.BROWSER);
      return jsonResponse(info);
    }
    if (url.searchParams.get("debug") === "measure") {
      const session = await getNotionSession(env.NOTIFY_CACHE);
      const target = resolveDebugTarget();
      const info = await debugNotionTableMeasure(env.BROWSER, session, target);
      return jsonResponse({ hasSession: !!session, ...info });
    }
    if (url.searchParams.get("debug") === "trap") {
      const session = await getNotionSession(env.NOTIFY_CACHE);
      const target = resolveDebugTarget();
      const info = await debugNotionRedirectTrap(env.BROWSER, session, target);
      return jsonResponse({ hasSession: !!session, ...info });
    }
    if (url.searchParams.get("debug") === "info") {
      const session = await getNotionSession(env.NOTIFY_CACHE);
      const target = resolveDebugTarget();
      const jsEnabled = url.searchParams.get("js") !== "off";
      const info = await debugNotionPageInfo(env.BROWSER, session, target, jsEnabled);
      return jsonResponse({ hasSession: !!session, ...info });
    }
    if (url.searchParams.get("debug") === "png") {
      const config = getConfig(env);
      const session = await getNotionSession(env.NOTIFY_CACHE);
      if (!session) return jsonResponse({ ok: false, error: "no notion session" }, 400);
      const avatarMap = await fetchNotionAvatarMap(config.notionToken).catch(() => ({}));
      const target = resolveDebugTarget();
      const clipToTable = url.searchParams.get("full") !== "1"; // 既定: デイリー KPI表のみ。?full=1 でページ全体
      const dateParam = parseDebugDateParam();
      let matchLabel: string | undefined;
      if (clipToTable && dateParam) {
        const t = await fetchScrumTable(config, target, { month: dateParam.m, day: dateParam.d }).catch(() => null);
        matchLabel = t?.dateColumns.find((c) => c.month === dateParam.m && c.day === dateParam.d)?.label;
      }
      const png = await captureNotionPage(env.BROWSER, session, target, avatarMap, clipToTable, matchLabel);
      if (!png) return jsonResponse({ ok: false, error: "screenshot failed" }, 500);
      return new Response(png as unknown as BodyInit, { headers: { "Content-Type": "image/png" } });
    }
    // debug=table → Notion API での表パース結果を確認（動作確認用。?date=M/D で対象表を指定）
    if (url.searchParams.get("debug") === "table") {
      const config = getConfig(env);
      const target = resolveDebugTarget();
      const dateParam = parseDebugDateParam();
      const t = await fetchScrumTable(config, target, dateParam ? { month: dateParam.m, day: dateParam.d } : undefined).catch(
        (e) => ({ error: (e as Error).message })
      );
      if (!t || "error" in (t as object)) return jsonResponse({ ok: false, ...(t as object) });
      const tbl = t as ScrumTable;
      let emptyInfo: unknown = null;
      if (dateParam) {
        const ci = dateColumnIndex(tbl, dateParam.m, dateParam.d);
        emptyInfo = ci == null ? "column not found" : { colIndex: ci, empty: emptyMembersForColumn(tbl, ci) };
      }
      const memberNames = [...new Set(tbl.rows.map((r) => r.member).filter(Boolean))];
      const members = await fetchMembers(config).catch(() => []);
      const mentionCheck = memberNames.map((n) => {
        const sid = resolveSlackId(members, config, n);
        return { name: n, slackId: sid ?? null, mention: sid ? `<@${sid}>` : `(plain) ${n}` };
      });
      return jsonResponse({
        ok: true,
        tableId: tbl.tableId,
        headers: tbl.headers,
        dateColumns: tbl.dateColumns,
        rowCount: tbl.rows.length,
        members: memberNames,
        mentionCheck,
        emptyInfo,
        rows: tbl.rows
      });
    }
    // 旧デイリーKPI投稿+10分おきリマインド(runS19DailyPost/runS19ReminderTick)は
    // KPI実行担保エンジン（/pmo/kpi-morning, /pmo/kpi-evening, /pmo/kpi-board）に置き換え済み。
    // 上記の debug=probe/measure/trap/info/png/table は汎用デバッグツールとして引き続き利用可能。
    return jsonResponse({
      ok: false,
      error: "廃止されました。/pmo/kpi-morning, /pmo/kpi-evening, /pmo/kpi-board を使ってください（?debug=probe|measure|trap|info|png|table は引き続き利用可能）"
    }, 410);
  }

  // debug: KPIテキストの頻度(cadence)推論結果を確認する（Slack投稿なし）
  if (path === "/pmo/kpi-cadence-debug") {
    const config = getConfig(env);
    const target = resolveDailyKpiTarget(env, { explicitUrl: url.searchParams.get("url") });
    const dq = url.searchParams.get("date");
    const md = dq ? dq.match(/(\d{1,2})\D+(\d{1,2})/) : null;
    const targetDate = md ? { m: parseInt(md[1], 10), d: parseInt(md[2], 10) } : jstTodayMD();
    const table = await fetchScrumTable(config, target.url, { month: targetDate.m, day: targetDate.d }).catch(() => null);
    if (!table) return jsonResponse({ ok: false, error: "KPI table not found for target date" }, 500);
    const rows = await buildKpiRowContexts(config, env.NOTIFY_CACHE, table);
    return jsonResponse({
      ok: true,
      targetDate,
      tableId: table.tableId,
      count: rows.length,
      results: rows.map((r) => ({ member: r.member, kpiText: r.kpiText, itemKey: r.itemKey, cadence: r.cadence }))
    });
  }

  // debug: KPIの危険度判定（重い/要注意/未達成）を確認する（Slack投稿なし）
  // ?slot=morning|evening（既定 evening）、?date=M/D でテーブル・today基準日を指定
  if (path === "/pmo/kpi-risk-debug") {
    const config = getConfig(env);
    const target = resolveDailyKpiTarget(env, { explicitUrl: url.searchParams.get("url") });
    const dq = url.searchParams.get("date");
    const md = dq ? dq.match(/(\d{1,2})\D+(\d{1,2})/) : null;
    const targetDate = md ? { m: parseInt(md[1], 10), d: parseInt(md[2], 10) } : jstTodayMD();
    const timeSlot = url.searchParams.get("slot") === "morning" ? "morning" : "evening";
    const table = await fetchScrumTable(config, target.url, { month: targetDate.m, day: targetDate.d }).catch(() => null);
    if (!table) return jsonResponse({ ok: false, error: "KPI table not found for target date" }, 500);
    const rows = await buildKpiRowContexts(config, env.NOTIFY_CACHE, table);
    const riskItems = computeKpiRiskAssessment(rows, table, { month: targetDate.m, day: targetDate.d }, timeSlot);
    const todayColPos = table.dateColumns.findIndex((c) => c.month === targetDate.m && c.day === targetDate.d);

    const memberNames = [...new Set(rows.map((r) => r.member))];
    const memoryByMember = new Map<string, KpiMemberMemory>();
    for (const m of memberNames) memoryByMember.set(m, await getKpiMemory(env.NOTIFY_CACHE, m));
    const commitmentChecks = resolvePendingCommitments(rows, table, memoryByMember, todayColPos);

    return jsonResponse({
      ok: true,
      targetDate,
      timeSlot,
      tableId: table.tableId,
      riskCount: riskItems.length,
      riskItems,
      commitmentChecks
    });
  }

  // KPI実行担保エンジン: 08:40 朝スレッド投稿を手動実行。?to=dm で本番チャンネルの代わりにPMのDMへ（動作確認用）
  if (path === "/pmo/kpi-morning") {
    let channelId: string | undefined;
    if (url.searchParams.get("to") === "dm") {
      const cfg = getConfig(env);
      if (cfg.slackBotToken && cfg.slackPmUserId) {
        channelId = await conversationsOpen(cfg.slackBotToken, cfg.slackPmUserId).catch(() => undefined);
      }
      if (!channelId) return jsonResponse({ ok: false, error: "DM open failed (SLACK_PM_USER_ID 未設定?)" }, 400);
    }
    const dq = url.searchParams.get("date");
    const dm = dq ? dq.match(/(\d{1,2})\D+(\d{1,2})/) : null;
    const overrideDate = dm ? { m: parseInt(dm[1], 10), d: parseInt(dm[2], 10) } : undefined;
    const result = await runKpiMorningPost(env, "manual", { channelId, overrideDate });
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  // KPI実行担保エンジン: 18:00/21:00 エスカレーションチェックを手動実行。?slot=1800|2100（既定1800）
  if (path === "/pmo/kpi-evening") {
    let channelId: string | undefined;
    if (url.searchParams.get("to") === "dm") {
      const cfg = getConfig(env);
      if (cfg.slackBotToken && cfg.slackPmUserId) {
        channelId = await conversationsOpen(cfg.slackBotToken, cfg.slackPmUserId).catch(() => undefined);
      }
      if (!channelId) return jsonResponse({ ok: false, error: "DM open failed (SLACK_PM_USER_ID 未設定?)" }, 400);
    }
    const dq = url.searchParams.get("date");
    const dm = dq ? dq.match(/(\d{1,2})\D+(\d{1,2})/) : null;
    const overrideDate = dm ? { m: parseInt(dm[1], 10), d: parseInt(dm[2], 10) } : undefined;
    const slot = url.searchParams.get("slot") === "2100" ? "2100" : "1800";
    const result = await runKpiEveningCheck(env, "manual", slot, { channelId, overrideDate });
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  // KPI実行担保エンジン: 25:00(=01:00) の表投稿を手動実行。?to=dm でPMのDMへ（動作確認用）
  if (path === "/pmo/kpi-board") {
    let channelId: string | undefined;
    if (url.searchParams.get("to") === "dm") {
      const cfg = getConfig(env);
      if (cfg.slackBotToken && cfg.slackPmUserId) {
        channelId = await conversationsOpen(cfg.slackBotToken, cfg.slackPmUserId).catch(() => undefined);
      }
      if (!channelId) return jsonResponse({ ok: false, error: "DM open failed (SLACK_PM_USER_ID 未設定?)" }, 400);
    }
    const dq = url.searchParams.get("date");
    const dm = dq ? dq.match(/(\d{1,2})\D+(\d{1,2})/) : null;
    const overrideDate = dm ? { m: parseInt(dm[1], 10), d: parseInt(dm[2], 10) } : undefined;
    const result = await runKpiBoardPost(env, "manual", { channelId, overrideDate });
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  // KPI実行担保エンジン: 00:00〜08:20 の未記入リマインド/完了スクショ判定を手動実行（動作確認用）。
  if (path === "/pmo/kpi-midnight-check") {
    const result = await runKpiMidnightFillCheck(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  // debug: KPI詰めスレッドへの返信を、実際のSlackイベントなしでシミュレートする
  // （署名検証済みSlack Events APIを経由せずに handleKpiReply 相当のコアロジックを直接叩く）
  if (path === "/pmo/kpi-reply-debug") {
    const channel = url.searchParams.get("channel") || "";
    const threadTs = url.searchParams.get("threadTs") || "";
    const userId = url.searchParams.get("userId") || "";
    const text = url.searchParams.get("text") || "";
    if (!channel || !threadTs || !userId || !text) {
      return jsonResponse({ ok: false, error: "channel, threadTs, userId, text は必須" }, 400);
    }
    const result = await processKpiReply(env, { channel, threadTs, userId, text });
    return jsonResponse(result, result.ok ? 200 : 400);
  }

  // debug: 特定メンバーの長期記憶(kpiMemory)を確認/消去する（?clear=1で消去、本番では通常使わない）
  if (path === "/pmo/kpi-memory-debug") {
    const member = url.searchParams.get("member") || "";
    if (!member) return jsonResponse({ ok: false, error: "member は必須" }, 400);
    if (url.searchParams.get("clear") === "1") {
      await clearKpiMemory(env.NOTIFY_CACHE, member);
      return jsonResponse({ ok: true, cleared: member });
    }
    const memory = await getKpiMemory(env.NOTIFY_CACHE, member);
    return jsonResponse({ ok: true, memory });
  }

  if (path === "/pmo/reminder") {
    const result = await runReminderFlow(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/evening") {
    const result = await runEveningFlow(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/pm-reminder") {
    const result = await runPmReminderFlow(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/phone-reminder") {
    const result = await runPhoneReminderFlow(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/eod-reminder") {
    const result = await runEodReminderFlow(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/progress-snapshot") {
    const result = await runProgressSpSnapshot(env, "manual");
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (path === "/pmo/refresh-projects") {
    const result = await refreshProjectCatalog(env);
    return jsonResponse({ ok: true, ...result });
  }

  if (path === "/pmo/projects") {
    const config = getConfig(env);
    const projects = await getCachedProjects(env.NOTIFY_CACHE, config.teamFilter);
    return jsonResponse({ ok: true, teamFilter: config.teamFilter, count: projects.length, projects });
  }

  if (path === "/pmo/refresh-users") {
    const result = await refreshUserCatalog(env);
    return jsonResponse({ ok: true, ...result });
  }

  if (path === "/pmo/users") {
    const config = getConfig(env);
    const users = await getCachedUsers(env.NOTIFY_CACHE, config.teamFilter);
    return jsonResponse({ ok: true, teamFilter: config.teamFilter, count: users.length, users });
  }

  if (path === "/pmo/post-thread" && request.method === "POST") {
    const config = getConfig(env);
    if (!config.slackBotToken) return jsonResponse({ ok: false, error: "no bot token" }, 400);
    const body = await request.json() as { channel: string; thread_ts: string; text: string };
    const res = await chatPostMessage(config.slackBotToken, body.channel, body.text, undefined, body.thread_ts);
    return jsonResponse(res);
  }

  if (path === "/pmo/screenshot-to-thread" && request.method === "POST") {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const config = getConfig(env);
    const body = await request.json() as { channel: string; thread_ts: string };
    const task = (async () => {
      try {
        if (!config.slackBotToken) { await writer.write(new TextEncoder().encode("no bot token")); return; }
        const url = resolveDailyKpiTarget(env).url;
        const now = new Date();
        const td = jstYesterdayMD(now.getTime());
        const table = await fetchScrumTable(config, url, { month: td.m, day: td.d }).catch(() => null);
        const dateLabel = (() => {
          if (!table) return `${td.m}/${td.d}`;
          const ci = dateColumnIndex(table, td.m, td.d);
          return table.dateColumns.find((c) => c.index === ci)?.label ?? `${td.m}/${td.d}`;
        })();
        const session = await getNotionSession(env.NOTIFY_CACHE);
        const avatarMap = await fetchNotionAvatarMap(config.notionToken).catch(() => ({}));
        const png = await captureNotionPage(env.BROWSER, session, url, avatarMap, true, dateLabel);
        if (png) {
          const today = toJstDateString(now);
          await uploadImageToSlack(config.slackBotToken, body.channel, body.thread_ts, `kpi-${today}.png`, png, undefined);
        }
        if (table) {
          const play = await buildLivePlay(config, table, dateLabel).catch(() => null);
          if (play) await chatPostMessage(config.slackBotToken, body.channel, `📣 *実況* — ${dateLabel} の達成状況\n${play}`, undefined, body.thread_ts);
        }
      } finally {
        await writer.write(new TextEncoder().encode("ok"));
        await writer.close();
      }
    })();
    if (ctx) ctx.waitUntil(task);
    return new Response(readable, { status: 200 });
  }

  if (path === "/query" && request.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (!body?.prompt || typeof body.prompt !== "string") {
      return jsonResponse({ ok: false, error: "prompt is required" }, 400);
    }
    const config = getConfig(env);
    try {
      const text = await fetchFreeText(config, body.prompt, new Date());
      return jsonResponse({ ok: true, text });
    } catch (err) {
      return jsonResponse(
        { ok: false, error: (err as Error).message ?? "unknown error" },
        500
      );
    }
  }

  if (path === "/notion-tasks" && request.method === "GET") {
    const config = getConfig(env);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    try {
      if ((start && !end) || (!start && end)) {
        return jsonResponse(
          { ok: false, error: "start and end must be provided together" },
          400
        );
      }
      if (start && end) {
        const tasks = await fetchTasksInDateRange(config, start, end);
        return jsonResponse({ ok: true, count: tasks.length, tasks });
      }
      const now = new Date();
      const summary = await fetchCurrentSprintTasksSummary(config, now);
      const count = summary.assignees.reduce(
        (total, assignee) => total + assignee.tasks.length,
        0
      );
      return jsonResponse({ ok: true, mode: "current_sprint", count, summary });
    } catch (err) {
      return jsonResponse(
        { ok: false, error: (err as Error).message ?? "unknown error" },
        500
      );
    }
  }

  if (path === "/notion-tasks/notify-assignees") {
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    if (start || end) {
      return jsonResponse(
        { ok: false, error: "this endpoint does not accept start/end params" },
        400
      );
    }
    const result = await runAssigneeTasksReport(env, "manual");
    const status = result.ok ? 200 : 500;
    return jsonResponse(result, status);
  }

  if (path === "/notion-tasks/notify") {
    const config = getConfig(env);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    try {
      if ((start && !end) || (!start && end)) {
        return jsonResponse(
          { ok: false, error: "start and end must be provided together" },
          400
        );
      }
      if (start && end) {
        const tasks = await fetchTasksInDateRange(config, start, end);
        const summaries = summarizeTasks(tasks);
        const slackPayload = buildTasksPayload(summaries, { start, end });
        if (config.dryRun) {
          console.log("DRY_RUN: notion-tasks payload", slackPayload);
          return jsonResponse({
            ok: true,
            dryRun: true,
            count: summaries.length
          });
        }
        if (!config.slackWebhookUrl) {
          return jsonResponse({ ok: false, error: "SLACK_WEBHOOK_URL not set" }, 500);
        }
        await postSlack(config.slackWebhookUrl, slackPayload);
        return jsonResponse({ ok: true, count: summaries.length });
      }

      const now = new Date();
      const summary = await fetchCurrentSprintTasksSummary(config, now);
      const { metrics, changes } = await buildSprintTasksMeta(
        env,
        summary,
        config,
        now
      );
      const slackPayload = buildSprintTasksPayload(summary, metrics, changes);
      const count = summary.assignees.reduce(
        (total, assignee) => total + assignee.tasks.length,
        0
      );
      if (config.dryRun) {
        console.log("DRY_RUN: sprint tasks payload", slackPayload);
        return jsonResponse({ ok: true, dryRun: true, count });
      }
      if (!config.slackWebhookUrl) {
        return jsonResponse({ ok: false, error: "SLACK_WEBHOOK_URL not set" }, 500);
      }
      await postSlack(config.slackWebhookUrl, slackPayload);
      return jsonResponse({ ok: true, count });
    } catch (err) {
      return jsonResponse(
        { ok: false, error: (err as Error).message ?? "unknown error" },
        500
      );
    }
  }

  return jsonResponse({ message: "not found" }, 404);
}

async function runForAllChannels(
  env: Env,
  fn: (channelId?: string) => Promise<unknown>
): Promise<void> {
  // Run for all registered channels
  const channels = await listAllChannelConfigs(env.NOTIFY_CACHE);
  for (const { channelId } of channels) {
    try {
      await fn(channelId);
    } catch (err) {
      console.error(`Cron failed for channel ${channelId}:`, err);
    }
  }
  // Also run with global config if PMO channel is set (backward compat)
  try {
    const globalConfig = getConfig(env);
    if (globalConfig.slackPmoChannelId) {
      // Only run global if it's not already covered by a registered channel
      const registeredIds = channels.map((c) => c.channelId);
      if (!registeredIds.includes(globalConfig.slackPmoChannelId)) {
        await fn(undefined);
      }
    }
  } catch {
    // Global config may be incomplete (no DB URLs) - that's fine
  }
}

/**
 * 24:00 JST の投稿を順番に実行する。
 * SPRINT CONTROL は、他の日次投稿が完了した後に必ず最後に送る。
 */
async function runMidnightPostSequence(env: Env): Promise<void> {
  const taskChannel = resolveTeamKChannelId(env);
  const dailySummary = await runDailyProgressSummary(env, "cron", taskChannel).catch((error) => {
    console.error("Daily progress cron failed", error);
    return { ok: false, error: (error as Error).message };
  });
  const dailySummaryRecord = dailySummary as Record<string, unknown>;
  const threadTs =
    typeof dailySummaryRecord.threadTs === "string"
      ? dailySummaryRecord.threadTs
      : await getCurrentTaskThread(env.NOTIFY_CACHE, taskChannel).catch(() => null);
  const result = await runSpGamificationDashboard(env, "cron", {
    channelId: taskChannel,
    threadTs: threadTs ?? undefined
  }).catch(
    (error) => ({ ok: false, error: (error as Error).message })
  );
  if (!result.ok) console.error("SPRINT CONTROL cron failed", result);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handleHttp(request, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 単一の */10 cron に集約（Cloudflare cron 上限対策）。日次ジョブは JST 時刻ゲートで発火。
    if (event.cron === "*/10 * * * *") {
      const now = new Date();
      const jstH = (now.getUTCHours() + 9) % 24;
      const jstM = now.getUTCMinutes();
      const jstDow = new Date(now.getTime() + 9 * 3600 * 1000).getUTCDay();
      const hm = jstH * 100 + jstM;
      // タスクリマインド・KPIイベントは独立して判定（複数同時実行あり）
      if (hm === 830) {
        ctx.waitUntil(runTaskReminderFlow(env, "cron", resolveTeamKChannelId(env))); // 08:30 JST タスクリマインド(full)
      }
      if (hm === 840) {
        // 08:40 JST — KPI実行担保エンジン: 朝スレッド投稿 + 着手リスクのある人への質問
        await runKpiMorningPost(env, "cron");
      }
      if (hm === 850) {
        // 08:50 JST — 当日タスクスレッドへ案件採算・FTE・HealthのDigest画像を投稿。
        // 単一cronが10分粒度のため、Runbookの08:45に最も近い08:50で実行する。
        await runDeliveryMorningFlow(env, "cron");
        await runSprintScopeControlFlow(env, "cron");
        if (jstDow === 6) {
          // 土曜 = 仮想Sprint開始日。Digestの後にPlanning診断を投稿する。
          await runSprintPlanningFlow(env, "cron", resolveTeamKChannelId(env));
        }
      }
      if (hm === 1200) {
        // 正午にForecast/Burn/Blockerの状態変化を再評価する（同一状態はKVで抑止）。
        await runDeliveryAlertFlow(env, "cron");
        // 朝以降に追加されたSprint Scopeも、同一差分を重複せず検知する。
        await runSprintScopeControlFlow(env, "cron");
      }
      if (hm === 1750 && jstDow === 5) {
        // 金曜夕方 — 案件Portfolioと担当者別の次週FTE需要。
        await runDeliveryPortfolioFlow(env, "cron");
      }
      if (hm === 1830) {
        // 18:30 JST — 未更新タスクのみ、担当者単位に集約してリマインド。
        await runDeliveryUpdateReminderFlow(env, "cron");
      }
      if (hm === 1400) {
        ctx.waitUntil(runTaskReminderFlow(env, "midday", resolveTeamKChannelId(env))); // 14:00 JST 追記リマインド
      }
      if (hm === 2000) {
        ctx.waitUntil(runTaskReminderFlow(env, "evening", resolveTeamKChannelId(env))); // 20:00 JST 追記リマインド
      }
      if (hm === 1800) {
        // 18:00 JST — KPI実行担保エンジン: エスカレーションチェック(1回目)
        await runKpiEveningCheck(env, "cron", "1800");
      }
      if (hm === 2100) {
        // 21:00 JST — KPI実行担保エンジン: エスカレーションチェック(2回目)
        await runKpiEveningCheck(env, "cron", "2100");
      }
      if (hm === 0) {
        // 24:00 JST — 本日の進捗サマリー + KPI投稿 + SPRINT CONTROL。
        // scheduled() の Promise を直接待つことで Cron の15分枠を使う。
        // 日次投稿を直列化し、SPRINT CONTROL を一連処理の最後に送る。
        await runMidnightPostSequence(env);
      }
      // 09:00〜17:50 JST — 未返信者への15分間隔リマインド（KPI朝投稿後〜夕方エスカレ前）
      // runKpiMiddayFollowup 内で lastPromptAt チェックし15分未満ならスキップする
      if (hm >= 900 && hm < 1800 && hm !== 840) {
        await runKpiMiddayFollowup(env, "cron");
      }
      // 00:00〜08:20 JST(10分おき) — 当日のKPI表がまだ未記入なら10分おきにリマインド。
      // 全員記入済みになったら、その週のKPI表のスクショをスレッドに投稿する（runKpiMidnightFillCheck内でゲート）。
      if (hm >= 0 && hm < 830) {
        ctx.waitUntil(runKpiMidnightFillCheck(env, "cron"));
      }
      return;
    }
    // Branch by cron expression
    if (event.cron === "0 20 * * *") {
      // 05:00 JST — Save progress SP snapshot + refresh project & user catalogs
      ctx.waitUntil(runProgressSpSnapshot(env, "cron"));
      ctx.waitUntil(refreshProjectCatalog(env));
      ctx.waitUntil(refreshUserCatalog(env));
    } else if (event.cron === "30 23 * * *") {
      // 08:30 JST — Task reminder (full: 親メッセージ + タイムライン + ボード + タスク)
      ctx.waitUntil(runTaskReminderFlow(env, "cron"));
    } else if (event.cron === "0 5 * * *") {
      // 14:00 JST — タスク状況の追記リマインド（当日スレッドにテキスト追記）
      ctx.waitUntil(runTaskReminderFlow(env, "midday"));
    } else if (event.cron === "0 11 * * *") {
      // 20:00 JST — タスク状況の追記リマインド（当日スレッドにテキスト追記）
      ctx.waitUntil(runTaskReminderFlow(env, "evening"));
    } else if (event.cron === "0 15 * * *") {
      // 24:00 JST(翌0時) — 日次投稿の最後に SPRINT CONTROL を送信
      await runMidnightPostSequence(env);
    } else if (event.cron === "0 0 * * *") {
      // 09:00 JST — Member notification
      ctx.waitUntil(runForAllChannels(env, (ch) => runMorningFlow(env, "cron", null, ch)));
    } else if (event.cron === "10,20,30,40,50 0 * * *") {
      // 09:10-09:50 JST — Member reminder (every 10 min)
      ctx.waitUntil(runForAllChannels(env, (ch) => runReminderFlow(env, "cron", ch)));
    } else if (event.cron === "0 1 * * *") {
      // 10:00 JST — PM report (Steps 6-7)
      ctx.waitUntil(runForAllChannels(env, (ch) => runEveningFlow(env, "cron", ch)));
    } else if (event.cron === "0,15 * * * *") {
      // Every hour at :00 and :15 — combined trigger
      // Watchdog heartbeat
      ctx.waitUntil(saveCronHeartbeat(env.NOTIFY_CACHE, "watchdog"));
      // Cron health check
      ctx.waitUntil(runCronHealthCheck(env));
      // ☎️ Phone reminder: always (24h)
      ctx.waitUntil(runPhoneReminderFlow(env, "cron"));
      // PM reminder & EOD: time-gated by JST hour
      const jstHour = (new Date().getUTCHours() + 9) % 24;
      if (jstHour >= 11 && jstHour <= 19) {
        ctx.waitUntil(runForAllChannels(env, (ch) => runPmReminderFlow(env, "cron", ch)));
      }
      if (jstHour === 0) {
        ctx.waitUntil(runForAllChannels(env, (ch) => runEodReminderFlow(env, "cron", ch)));
      }
      // Catch-up: re-trigger missed cron flows when crons resume after outage
      ctx.waitUntil(runMissedCronCatchup(env));
    } else {
      // Fallback: legacy reports
      ctx.waitUntil(runReport(env, "cron"));
      ctx.waitUntil(runSprintTasksReport(env, "cron"));
      ctx.waitUntil(runAssigneeTasksReport(env, "cron"));
    }
  }
};
