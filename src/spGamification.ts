import type { AppConfig } from "./config";
import {
  isCompletedStatus,
  statusProgressRate,
  type SprintCheckpointRecord,
  type SprintDashboardTask
} from "./notionApi";
import { htmlToPng } from "./timeline";

export interface SprintDashboardInfo {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
}

export interface SpMemberSnapshot {
  name: string;
  completedSp: number;
  planSp: number;
  /** 完了ステータスだけを数えた確定完了SP。completedSp は後方互換上、進捗率加重SPを表す。 */
  doneSp?: number;
}

export interface SpDashboardSnapshot {
  version: 1;
  sprintId: string;
  sprintName: string;
  date: string;
  teamCompletedSp: number;
  teamPlanSp: number;
  /** 完了ステータスだけを数えた確定完了SP。 */
  teamDoneSp?: number;
  members: SpMemberSnapshot[];
  capturedAt: string;
}

interface SpDashboardHistory {
  version: 1;
  sprintId: string;
  snapshots: Record<string, SpDashboardSnapshot>;
}

export interface SpDashboardSeriesPoint {
  date: string;
  teamSp: number | null;
  memberSp: Record<string, number | null>;
  teamDailySp: number | null;
  teamDoneSp: number | null;
  teamDailyDoneSp: number | null;
  memberDailySp: Record<string, number | null>;
  source: "exact" | "estimated" | "future";
}

export interface SpDashboardMemberRow {
  name: string;
  displayName: string;
  color: string;
  rank: number;
  completedSp: number;
  doneSp: number;
  planSp: number;
  todayDelta: number;
  gapToLead: number;
  velocitySp: number | null;
  loadRatio: number | null;
}

export type SprintHealth = "green" | "yellow" | "red" | "unknown";

export interface SprintVelocitySummary {
  sprintCount: number;
  teamAverageSp: number;
  memberAverageSp: Record<string, number>;
}

export interface SprintCheckpointView {
  id: string;
  name: string;
  checkpoint: string;
  due: string | null;
  planSp: number;
  progressSp: number;
  doneSp: number;
  progressRate: number;
  health: SprintHealth;
  healthLabel: string;
  reason: string;
}

export interface SprintPlanningReadiness {
  missingSp: number;
  missingOwner: number;
  missingCompletionCriteria: number;
  orphanTasks: number;
}

export interface SprintControlContext {
  velocity?: SprintVelocitySummary | null;
  checkpointRecords?: SprintCheckpointRecord[];
}

export interface SpDashboardData {
  sprint: SprintDashboardInfo;
  reportDate: string;
  current: SpDashboardSnapshot;
  points: SpDashboardSeriesPoint[];
  members: SpDashboardMemberRow[];
  teamTodayDelta: number;
  elapsedDays: number;
  sprintDays: number;
  dailyPace: number;
  weeklyProjection: number;
  projectedSprintTotal: number;
  expectedByToday: number;
  paceRatio: number;
  completionRate: number;
  usedEstimatedHistory: boolean;
  baselinePlanSp: number;
  scopeDeltaSp: number;
  currentDoneSp: number;
  doneRate: number;
  expectedByTodaySp: number;
  progressGapSp: number;
  remainingDays: number;
  requiredDoneSpPerDay: number;
  recentDailyDoneSp: number | null;
  historicalVelocitySp: number | null;
  projectedDoneSp: number;
  projectedDoneRate: number;
  health: SprintHealth;
  healthLabel: string;
  healthReason: string;
  forecastConfidence: "high" | "medium" | "low";
  recommendations: string[];
  readiness: SprintPlanningReadiness;
  checkpoints: SprintCheckpointView[];
}

export interface SpTaskRow {
  id: string;
  taskName: string;
  spShare: number;        // SP for this member (sp / assignees.length)
  startStatus: string;   // status at sprint start (from KV snapshot, or "—")
  currentStatus: string;
  progressSp: number;    // spShare * statusProgressRate(currentStatus)
  projectName: string;
}

export interface SpTaskDetailGroup {
  memberName: string;
  displayName: string;
  color: string;
  progressSp: number;   // sum of progressSp across rows
  planSp: number;       // sum of spShare across rows
  rows: SpTaskRow[];
}

export interface SpTaskDetailData {
  sprint: SprintDashboardInfo;
  reportDate: string;
  groups: SpTaskDetailGroup[];
  taskCount: number;
  usedEstimatedDates: boolean;
}

export interface AiDashboardBackground {
  base64: string | null;
  model: string;
  error?: string;
}

const DAY_MS = 24 * 3600 * 1000;
const HISTORY_TTL_SECONDS = 60 * 24 * 3600;
export const SPRINT_QUEST_PLAYERS = [
  {
    name: "北川楓",
    color: "#ff5f87",
    aliases: ["北川楓", "kitagawakaede"]
  },
  {
    name: "古鉄朋也",
    color: "#ffcf4a",
    aliases: ["古鉄朋也", "tomoyakotetsu"]
  },
  {
    name: "武田良平",
    color: "#8b7cff",
    aliases: ["武田良平", "ryoheitakeda", "takedaryohei"]
  },
  {
    name: "松田直樹",
    color: "#32e6c4",
    aliases: ["松田直樹", "matsudanaoki", "naokimatsuda"]
  }
] as const;

function dayMs(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime();
}

function addDays(date: string, amount: number): string {
  return new Date(dayMs(date) + amount * DAY_MS).toISOString().slice(0, 10);
}

function daysInclusive(start: string, end: string): number {
  return Math.max(1, Math.round((dayMs(end) - dayMs(start)) / DAY_MS) + 1);
}

function dateRange(start: string, end: string): string[] {
  const length = daysInclusive(start, end);
  return Array.from({ length }, (_, index) => addDays(start, index));
}

function clampDate(date: string, start: string, end: string): string {
  return date < start ? start : date > end ? end : date;
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function safeSp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizedMemberName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　/／|｜・._-]/g, "");
}

export function canonicalSprintPlayer(name: string): string | null {
  const normalized = normalizedMemberName(name);
  const player = SPRINT_QUEST_PLAYERS.find((candidate) =>
    candidate.aliases.some((alias) => normalized.includes(normalizedMemberName(alias)))
  );
  return player?.name ?? null;
}

function playerColor(name: string): string {
  return (
    SPRINT_QUEST_PLAYERS.find((player) => player.name === name)?.color ??
    "#91a2bb"
  );
}

function shortName(name: string): string {
  const first = name.split(/[／/｜|]/)[0]?.trim();
  return first || name.trim() || "名前なし";
}

function estimatedCompletionDate(
  task: SprintDashboardTask,
  sprint: SprintDashboardInfo,
  reportDate: string
): string {
  const raw = task.completedDate ?? task.lastEditedDate ?? reportDate;
  return clampDate(raw, sprint.start_date, reportDate < sprint.end_date ? reportDate : sprint.end_date);
}

function snapshotFromTasks(
  sprint: SprintDashboardInfo,
  tasks: SprintDashboardTask[],
  date: string,
  capturedAt: string,
  estimated: boolean,
  reportDate: string
): SpDashboardSnapshot {
  const memberTotals = new Map<string, { completedSp: number; doneSp: number; planSp: number }>(
    SPRINT_QUEST_PLAYERS.map((player) => [
      player.name,
      { completedSp: 0, doneSp: 0, planSp: 0 }
    ])
  );
  let teamCompletedSp = 0;
  let teamDoneSp = 0;
  let teamPlanSp = 0;

  for (const task of tasks) {
    const sp = safeSp(task.sp);
    teamPlanSp += sp;
    const rate = statusProgressRate(task.status);
    const dateOk = !estimated || estimatedCompletionDate(task, sprint, reportDate) <= date;
    const effectiveSp = rate > 0 && dateOk ? sp * rate : 0;
    const doneSp = isCompletedStatus(task.status) && dateOk ? sp : 0;
    teamCompletedSp += effectiveSp;
    teamDoneSp += doneSp;

    const assignees = [
      ...new Set(
        task.assignees
          .map(canonicalSprintPlayer)
          .filter((name): name is string => name != null)
      )
    ];
    if (assignees.length === 0) continue;
    const share = effectiveSp / assignees.length;
    const planShare = sp / assignees.length;
    for (const assignee of assignees) {
      const totals = memberTotals.get(assignee) ?? { completedSp: 0, doneSp: 0, planSp: 0 };
      totals.planSp += planShare;
      totals.completedSp += share;
      totals.doneSp += doneSp / assignees.length;
      memberTotals.set(assignee, totals);
    }
  }

  return {
    version: 1,
    sprintId: sprint.id,
    sprintName: sprint.name,
    date,
    teamCompletedSp: round1(teamCompletedSp),
    teamDoneSp: round1(teamDoneSp),
    teamPlanSp: round1(teamPlanSp),
    members: [...memberTotals.entries()]
      .map(([name, totals]) => ({
        name,
        completedSp: round1(totals.completedSp),
        doneSp: round1(totals.doneSp),
        planSp: round1(totals.planSp)
      }))
      .sort(
        (a, b) =>
          SPRINT_QUEST_PLAYERS.findIndex((player) => player.name === a.name) -
          SPRINT_QUEST_PLAYERS.findIndex((player) => player.name === b.name)
      ),
    capturedAt
  };
}

/** 現在のステータスから、当日の正確な累積 SP スナップショットを作る。 */
export function buildCurrentSpSnapshot(
  sprint: SprintDashboardInfo,
  tasks: SprintDashboardTask[],
  reportDate: string,
  capturedAt = new Date().toISOString()
): SpDashboardSnapshot {
  return snapshotFromTasks(
    sprint,
    tasks,
    reportDate,
    capturedAt,
    false,
    reportDate
  );
}

export function spDashboardHistoryKey(sprintId: string): string {
  return `sprint-dashboard:${sprintId}`;
}

/** 同じスプリントの保存済み実測スナップショットを読み込む。 */
export async function loadSpDashboardHistory(
  kv: KVNamespace,
  sprintId: string
): Promise<Record<string, SpDashboardSnapshot>> {
  const value = await kv
    .get<SpDashboardHistory>(spDashboardHistoryKey(sprintId), "json")
    .catch(() => null);
  if (!value || value.version !== 1 || value.sprintId !== sprintId) return {};
  return value.snapshots ?? {};
}

/** 当日の実測値を追加し、スプリント履歴を一つの KV レコードとして保存する。 */
export async function saveSpDashboardSnapshot(
  kv: KVNamespace,
  snapshot: SpDashboardSnapshot,
  existing: Record<string, SpDashboardSnapshot> = {}
): Promise<Record<string, SpDashboardSnapshot>> {
  const snapshots = { ...existing, [snapshot.date]: snapshot };
  const keptEntries = Object.entries(snapshots)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-65);
  const kept = Object.fromEntries(keptEntries);
  const payload: SpDashboardHistory = {
    version: 1,
    sprintId: snapshot.sprintId,
    snapshots: kept
  };
  await kv.put(spDashboardHistoryKey(snapshot.sprintId), JSON.stringify(payload), {
    expirationTtl: HISTORY_TTL_SECONDS
  });
  return kept;
}

export interface HistoricalSprintTasks {
  sprint: SprintDashboardInfo;
  tasks: SprintDashboardTask[];
}

/** 直近Sprintの確定完了SPから、チーム・担当者別Velocityを算出する。 */
export function calculateSprintVelocity(
  histories: HistoricalSprintTasks[]
): SprintVelocitySummary | null {
  if (histories.length === 0) return null;
  const memberTotals = new Map<string, number>(
    SPRINT_QUEST_PLAYERS.map((player) => [player.name, 0])
  );
  let teamTotal = 0;
  let countedSprints = 0;

  for (const { sprint, tasks } of histories) {
    let sprintDone = 0;
    const sprintMember = new Map<string, number>();
    for (const task of tasks) {
      if (!isCompletedStatus(task.status)) continue;
      if (task.completedDate && task.completedDate > sprint.end_date) continue;
      const sp = safeSp(task.sp);
      sprintDone += sp;
      const assignees = [
        ...new Set(
          task.assignees
            .map(canonicalSprintPlayer)
            .filter((name): name is string => name != null)
        )
      ];
      if (assignees.length === 0) continue;
      const share = sp / assignees.length;
      for (const name of assignees) {
        sprintMember.set(name, (sprintMember.get(name) ?? 0) + share);
      }
    }
    teamTotal += sprintDone;
    countedSprints++;
    for (const [name, value] of sprintMember) {
      memberTotals.set(name, (memberTotals.get(name) ?? 0) + value);
    }
  }

  if (countedSprints === 0) return null;
  return {
    sprintCount: countedSprints,
    teamAverageSp: round1(teamTotal / countedSprints),
    memberAverageSp: Object.fromEntries(
      [...memberTotals.entries()].map(([name, value]) => [
        name,
        round1(value / countedSprints)
      ])
    )
  };
}

function sprintHealthLabel(health: SprintHealth): string {
  if (health === "green") return "🟢 On Track";
  if (health === "yellow") return "🟡 軌道修正を検討";
  if (health === "red") return "🔴 再計画が必要";
  return "⚪ 判定データ不足";
}

function normalizedPageId(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

/**
 * 初回は Notion 更新日から過去推移を復元し、保存済みの日付は KV の実測値で上書きする。
 * 現在日の値は必ず現在の Notion ステータスを採用する。
 */
export function buildSpDashboardData(
  sprint: SprintDashboardInfo,
  tasks: SprintDashboardTask[],
  reportDateInput: string,
  history: Record<string, SpDashboardSnapshot> = {},
  capturedAt = new Date().toISOString(),
  control: SprintControlContext = {}
): SpDashboardData {
  const reportDate = clampDate(reportDateInput, sprint.start_date, sprint.end_date);
  const current = buildCurrentSpSnapshot(sprint, tasks, reportDate, capturedAt);
  const pastDates = dateRange(sprint.start_date, reportDate);
  const allDates = dateRange(sprint.start_date, sprint.end_date);
  const snapshotByDate = new Map<string, { value: SpDashboardSnapshot; source: "exact" | "estimated" }>();

  for (const date of pastDates) {
    snapshotByDate.set(date, {
      value: snapshotFromTasks(sprint, tasks, date, capturedAt, true, reportDate),
      source: "estimated"
    });
  }
  for (const [date, snapshot] of Object.entries(history)) {
    if (
      snapshot.sprintId === sprint.id &&
      sprint.start_date <= date &&
      date <= reportDate
    ) {
      snapshotByDate.set(date, { value: snapshot, source: "exact" });
    }
  }
  snapshotByDate.set(reportDate, { value: current, source: "exact" });

  const names: string[] = SPRINT_QUEST_PLAYERS.map((player) => player.name);
  const snapshotMemberMap = (
    snapshot: SpDashboardSnapshot
  ): Map<string, number> => {
    const result = new Map(names.map((name) => [name, 0]));
    for (const member of snapshot.members) {
      const canonical = canonicalSprintPlayer(member.name);
      if (!canonical) continue;
      result.set(
        canonical,
        round1((result.get(canonical) ?? 0) + member.completedSp)
      );
    }
    return result;
  };

  const cumulativePoints = allDates.map((date) => {
    const item = snapshotByDate.get(date);
    if (!item) {
      return {
        date,
        teamSp: null,
        teamDoneSp: null,
        memberSp: Object.fromEntries(names.map((name) => [name, null])),
        source: "future"
      } as const;
    }
    const memberMap = snapshotMemberMap(item.value);
    return {
      date,
      teamSp: item.value.teamCompletedSp,
      teamDoneSp: item.value.teamDoneSp ?? null,
      memberSp: Object.fromEntries(names.map((name) => [name, memberMap.get(name) ?? 0])),
      source: item.source
    };
  });

  let previousTeamSpForDaily = 0;
  let previousTeamDoneSpForDaily = 0;
  let previousMemberSpForDaily: Record<string, number> =
    Object.fromEntries(names.map((name) => [name, 0]));
  const points: SpDashboardSeriesPoint[] = cumulativePoints.map((point) => {
    if (point.teamSp == null) {
      return {
        ...point,
        teamDailySp: null,
        teamDailyDoneSp: null,
        memberDailySp: Object.fromEntries(names.map((name) => [name, null]))
      };
    }
    const memberDailySp = Object.fromEntries(
      names.map((name) => [
        name,
        round1(
          Math.max(
            0,
            Number(point.memberSp[name] ?? 0) -
              Number(previousMemberSpForDaily[name] ?? 0)
          )
        )
      ])
    );
    const teamDailySp = round1(
      Math.max(0, point.teamSp - previousTeamSpForDaily)
    );
    const teamDailyDoneSp = point.teamDoneSp == null
      ? null
      : round1(Math.max(0, point.teamDoneSp - previousTeamDoneSpForDaily));
    previousTeamSpForDaily = point.teamSp;
    if (point.teamDoneSp != null) previousTeamDoneSpForDaily = point.teamDoneSp;
    previousMemberSpForDaily = Object.fromEntries(
      names.map((name) => [name, Number(point.memberSp[name] ?? 0)])
    );
    return { ...point, teamDailySp, teamDailyDoneSp, memberDailySp };
  });

  const currentByName = new Map(current.members.map((member) => [member.name, member]));
  const previousPoint = [...points]
    .filter((point) => point.date < reportDate && point.teamSp != null)
    .at(-1);
  const priorByName = previousPoint?.memberSp ?? {};
  const sortedMembers = names
    .map(
      (name) =>
        currentByName.get(name) ?? {
          name,
          completedSp: 0,
          doneSp: 0,
          planSp: 0
        }
    )
    .sort(
      (a, b) =>
        b.completedSp - a.completedSp ||
        b.planSp - a.planSp ||
        SPRINT_QUEST_PLAYERS.findIndex((player) => player.name === a.name) -
          SPRINT_QUEST_PLAYERS.findIndex((player) => player.name === b.name)
  );
  const lead = sortedMembers[0]?.completedSp ?? 0;
  let previousScore: number | null = null;
  let currentRank = 0;
  const members: SpDashboardMemberRow[] = sortedMembers.map((member, index) => {
    if (previousScore == null || member.completedSp < previousScore) currentRank = index + 1;
    previousScore = member.completedSp;
    return {
      name: member.name,
      displayName: member.name,
      color: playerColor(member.name),
      rank: currentRank,
      completedSp: member.completedSp,
      doneSp: member.doneSp ?? 0,
      planSp: member.planSp,
      todayDelta: round1(member.completedSp - Number(priorByName[member.name] ?? 0)),
      gapToLead: round1(Math.max(0, lead - member.completedSp)),
      velocitySp: control.velocity?.memberAverageSp[member.name] ?? null,
      loadRatio:
        (control.velocity?.memberAverageSp[member.name] ?? 0) > 0
          ? round1(member.planSp / Number(control.velocity?.memberAverageSp[member.name]))
          : null
    };
  });

  const sprintDays = daysInclusive(sprint.start_date, sprint.end_date);
  const elapsedDays = daysInclusive(sprint.start_date, reportDate);
  const dailyPace = current.teamCompletedSp / Math.max(1, elapsedDays);
  const exactSnapshots = Object.entries({ ...history, [reportDate]: current })
    .filter(([, snapshot]) => snapshot.sprintId === sprint.id)
    .sort(([a], [b]) => a.localeCompare(b));
  const baselinePlanSp =
    exactSnapshots.find(([, snapshot]) => snapshot.teamPlanSp > 0)?.[1].teamPlanSp ??
    current.teamPlanSp;
  const expectedByToday = baselinePlanSp * (elapsedDays / sprintDays);
  const previousTeamSp = previousPoint?.teamSp ?? 0;
  const remainingDays = Math.max(
    0,
    Math.round((dayMs(sprint.end_date) - dayMs(reportDate)) / DAY_MS)
  );
  const currentDoneSp = current.teamDoneSp ?? 0;
  const scopeDeltaSp = round1(current.teamPlanSp - baselinePlanSp);

  const recentDoneRates: number[] = [];
  const doneSnapshots = exactSnapshots.filter(
    ([, snapshot]) => typeof snapshot.teamDoneSp === "number"
  );
  for (let index = 1; index < doneSnapshots.length; index++) {
    const [prevDate, prevSnapshot] = doneSnapshots[index - 1];
    const [nextDate, nextSnapshot] = doneSnapshots[index];
    const dayDiff = Math.max(1, Math.round((dayMs(nextDate) - dayMs(prevDate)) / DAY_MS));
    recentDoneRates.push(
      Math.max(0, Number(nextSnapshot.teamDoneSp) - Number(prevSnapshot.teamDoneSp)) / dayDiff
    );
  }
  const recentDoneWindow = recentDoneRates.slice(-3);
  const recentDailyDoneSp = recentDoneWindow.length > 0
    ? round1(recentDoneWindow.reduce((sum, value) => sum + value, 0) / recentDoneWindow.length)
    : null;
  const historicalVelocitySp = control.velocity?.teamAverageSp ?? null;
  const historicalDailyDoneSp = historicalVelocitySp != null
    ? historicalVelocitySp / sprintDays
    : null;
  const forecastDailyDoneSp = recentDailyDoneSp != null && historicalDailyDoneSp != null
    ? recentDailyDoneSp * 0.6 + historicalDailyDoneSp * 0.4
    : recentDailyDoneSp ?? historicalDailyDoneSp ?? dailyPace;
  const projectedDoneSp = round1(currentDoneSp + forecastDailyDoneSp * remainingDays);
  const projectedDoneRate = baselinePlanSp > 0
    ? round1((projectedDoneSp / baselinePlanSp) * 100)
    : 0;
  const requiredDoneSpPerDay = remainingDays > 0
    ? round1(Math.max(0, baselinePlanSp - currentDoneSp) / remainingDays)
    : round1(Math.max(0, baselinePlanSp - currentDoneSp));
  const progressGapSp = round1(current.teamCompletedSp - expectedByToday);

  const allCheckpointTaskIds = new Set(
    (control.checkpointRecords ?? []).flatMap((record) => record.taskIds.map(normalizedPageId))
  );
  const readiness: SprintPlanningReadiness = {
    missingSp: tasks.filter((task) => safeSp(task.sp) <= 0).length,
    missingOwner: tasks.filter((task) => task.assignees.length === 0).length,
    missingCompletionCriteria: tasks.filter(
      (task) => !(task.completionCriteria ?? "").trim()
    ).length,
    orphanTasks: tasks.filter((task) => !allCheckpointTaskIds.has(normalizedPageId(task.id))).length
  };

  const taskById = new Map(tasks.map((task) => [normalizedPageId(task.id), task]));
  const checkpoints: SprintCheckpointView[] = (control.checkpointRecords ?? [])
    .filter((record) => !/完了|保留|done|closed/i.test(record.status ?? ""))
    .map((record) => {
      const linked = record.taskIds
        .map((id) => taskById.get(normalizedPageId(id)))
        .filter((task): task is SprintDashboardTask => task != null);
      const planSp = round1(linked.reduce((sum, task) => sum + safeSp(task.sp), 0));
      const progressSp = round1(
        linked.reduce((sum, task) => sum + safeSp(task.sp) * statusProgressRate(task.status), 0)
      );
      const doneSp = round1(
        linked.reduce((sum, task) => sum + (isCompletedStatus(task.status) ? safeSp(task.sp) : 0), 0)
      );
      const progressRate = planSp > 0 ? round1((progressSp / planSp) * 100) : 0;
      const dueDays = record.checkpointDue
        ? Math.round((dayMs(record.checkpointDue) - dayMs(reportDate)) / DAY_MS)
        : null;
      let health: SprintHealth = "green";
      let reason = "現在の進捗はSprint計画線の範囲内です";
      if (!record.checkpoint.trim()) {
        health = "red";
        reason = "次チェックポイントが未定義です";
      } else if (linked.length === 0) {
        health = "red";
        reason = "チェックポイントに今Sprintのタスクが紐づいていません";
      } else if (!record.checkpointDue) {
        health = "yellow";
        reason = "チェックポイント期日が未設定です";
      } else if ((dueDays ?? 99) <= 1 && progressRate < 80) {
        health = "red";
        reason = `期日まで${Math.max(0, dueDays ?? 0)}日で進捗${progressRate}%です`;
      } else if (progressRate + 10 < (elapsedDays / sprintDays) * 100) {
        health = "yellow";
        reason = `Sprint計画線より${round1((elapsedDays / sprintDays) * 100 - progressRate)}pt遅れています`;
      }
      return {
        id: record.id,
        name: record.name,
        checkpoint: record.checkpoint,
        due: record.checkpointDue,
        planSp,
        progressSp,
        doneSp,
        progressRate,
        health,
        healthLabel: sprintHealthLabel(health),
        reason
      };
    })
    .filter((checkpoint) => checkpoint.planSp > 0 || checkpoint.due != null)
    .sort((a, b) =>
      (a.due ?? "9999-12-31").localeCompare(b.due ?? "9999-12-31") ||
      a.name.localeCompare(b.name, "ja")
    );
  const readinessIssueCount =
    readiness.missingSp +
    readiness.missingOwner +
    readiness.missingCompletionCriteria +
    readiness.orphanTasks;

  let health: SprintHealth = "unknown";
  if (baselinePlanSp > 0) {
    if (projectedDoneRate < 80 || checkpoints.some((item) => item.health === "red")) {
      health = "red";
    } else if (
      projectedDoneRate < 95 ||
      progressGapSp < -baselinePlanSp * 0.1 ||
      scopeDeltaSp > baselinePlanSp * 0.1 ||
      checkpoints.some((item) => item.health === "yellow") ||
      readinessIssueCount > 0
    ) {
      health = "yellow";
    } else {
      health = "green";
    }
  }
  const healthReason = health === "green"
    ? `計画差${progressGapSp >= 0 ? "+" : ""}${progressGapSp}SP、着地予測${projectedDoneRate}%です`
    : health === "yellow"
    ? `着地予測${projectedDoneRate}%です。小さな再配分またはスコープ確認が必要です`
    : health === "red"
    ? `着地予測${projectedDoneRate}%です。このままではSprintゴール未達の可能性が高いです`
    : "計画SPまたはVelocity履歴が不足しています";

  const recommendations: string[] = [];
  const projectedShortage = round1(Math.max(0, baselinePlanSp - projectedDoneSp));
  if (projectedShortage > 0) {
    recommendations.push(`${projectedShortage}SP分を再配分・分割・スコープ調整する`);
  }
  if (scopeDeltaSp > 0) {
    recommendations.push(`Sprint開始後に増えた${scopeDeltaSp}SPをコミット対象か確認する`);
  }
  if (readiness.missingCompletionCriteria > 0) {
    recommendations.push(`完了条件未設定の${readiness.missingCompletionCriteria}件を補う`);
  }
  if (readiness.missingOwner > 0 || readiness.missingSp > 0) {
    recommendations.push(`担当者/SP未設定タスクをPlanningで確定する`);
  }
  if (readiness.orphanTasks > 0) {
    recommendations.push(`チェックポイント未接続の${readiness.orphanTasks}件をEpic / Workstreamへ紐づける`);
  }
  const riskyCheckpoint = checkpoints.find((item) => item.health === "red") ??
    checkpoints.find((item) => item.health === "yellow");
  if (riskyCheckpoint) recommendations.push(`「${riskyCheckpoint.name}」の不足タスクと到達条件を再確認する`);
  if (recommendations.length === 0) recommendations.push("現在の優先順位を維持し、明日も計画差を確認する");
  const forecastConfidence = recentDoneWindow.length >= 2 && (control.velocity?.sprintCount ?? 0) >= 2
    ? "high"
    : recentDoneWindow.length >= 1 || (control.velocity?.sprintCount ?? 0) >= 2
    ? "medium"
    : "low";

  return {
    sprint,
    reportDate,
    current,
    points,
    members,
    teamTodayDelta: round1(current.teamCompletedSp - Number(previousTeamSp)),
    elapsedDays,
    sprintDays,
    dailyPace: round1(dailyPace),
    weeklyProjection: historicalVelocitySp ?? round1(dailyPace * 7),
    projectedSprintTotal: projectedDoneSp,
    expectedByToday: round1(expectedByToday),
    paceRatio:
      expectedByToday > 0
        ? Math.round((current.teamCompletedSp / expectedByToday) * 100) / 100
        : 0,
    completionRate:
      current.teamPlanSp > 0 ? round1((current.teamCompletedSp / current.teamPlanSp) * 100) : 0,
    usedEstimatedHistory: points.some(
      (point) => point.date < reportDate && point.source === "estimated"
    ),
    baselinePlanSp,
    scopeDeltaSp,
    currentDoneSp,
    doneRate: baselinePlanSp > 0 ? round1((currentDoneSp / baselinePlanSp) * 100) : 0,
    expectedByTodaySp: round1(expectedByToday),
    progressGapSp,
    remainingDays,
    requiredDoneSpPerDay,
    recentDailyDoneSp,
    historicalVelocitySp,
    projectedDoneSp,
    projectedDoneRate,
    health,
    healthLabel: sprintHealthLabel(health),
    healthReason,
    forecastConfidence,
    recommendations: recommendations.slice(0, 3),
    readiness,
    checkpoints: checkpoints.slice(0, 5)
  };
}

/** 完了タスクを固定4名へ割り当て、詳細テーブル画像用の行データを作る。 */
export function buildSpTaskDetailData(
  sprint: SprintDashboardInfo,
  tasks: SprintDashboardTask[],
  reportDateInput: string,
  startStatusMap: Map<string, string> = new Map()
): SpTaskDetailData {
  const reportDate = clampDate(reportDateInput, sprint.start_date, sprint.end_date);

  // タスクIDごとにメンバー別行を生成（全ステータス対象）
  const rowsByMember = new Map<string, SpTaskRow[]>(
    SPRINT_QUEST_PLAYERS.map((p) => [p.name, []])
  );

  // 重複排除（multi-assignee タスクが groupTasksByAssignee で重複している場合）
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);

    const assignees = [
      ...new Set(
        task.assignees
          .map(canonicalSprintPlayer)
          .filter((name): name is string => name != null)
      )
    ];
    if (assignees.length === 0) continue;

    const sp = safeSp(task.sp);
    const spShare = round1(sp / assignees.length);
    const currentStatus = task.status ?? "—";
    const startStatus = startStatusMap.get(task.id) ?? "—";
    const progressSp = round1(spShare * statusProgressRate(currentStatus));
    const projectName =
      task.projectNames.map((n) => n.trim()).filter(Boolean).join(" / ") || "未設定";

    for (const memberName of assignees) {
      const memberRows = rowsByMember.get(memberName);
      if (!memberRows) continue;
      memberRows.push({
        id: `${task.id}:${memberName}`,
        taskName: task.name,
        spShare,
        startStatus,
        currentStatus,
        progressSp,
        projectName
      });
    }
  }

  const groups = SPRINT_QUEST_PLAYERS.map((player) => {
    const memberRows = rowsByMember.get(player.name) ?? [];
    // 進捗SP降順 → タスク名昇順でソート
    memberRows.sort((a, b) => b.progressSp - a.progressSp || a.taskName.localeCompare(b.taskName, "ja"));
    return {
      memberName: player.name,
      displayName: player.name,
      color: player.color,
      progressSp: round1(memberRows.reduce((sum, r) => sum + r.progressSp, 0)),
      planSp: round1(memberRows.reduce((sum, r) => sum + r.spShare, 0)),
      rows: memberRows
    };
  });

  const totalRows = groups.reduce((sum, g) => sum + g.rows.length, 0);
  return { sprint, reportDate, groups, taskCount: totalRows, usedEstimatedDates: false };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function md(date: string): string {
  return date.slice(5).replace("-", "/");
}

function createChartSvg(data: SpDashboardData): string {
  const width = 1424;
  const height = 292;
  const left = 70;
  const right = 64;
  const top = 38;
  const bottom = 43;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const cumulativeMaxObserved = Math.max(
    data.current.teamPlanSp,
    data.baselinePlanSp,
    data.projectedDoneSp,
    ...data.points.map((point) => point.teamSp ?? 0)
  );
  const cumulativeMax = Math.max(
    10,
    Math.ceil(cumulativeMaxObserved / 10) * 10
  );
  const dailyMaxObserved = Math.max(
    0,
    ...data.points.flatMap((point) =>
      Object.values(point.memberDailySp).map((value) => Number(value ?? 0))
    )
  );
  const dailyMax = Math.max(5, Math.ceil(dailyMaxObserved / 5) * 5);
  const slotWidth = plotW / Math.max(1, data.points.length);
  const x = (index: number) => left + slotWidth * (index + 0.5);
  const yCumulative = (value: number) =>
    top + plotH - (Math.max(0, value) / cumulativeMax) * plotH;
  const yDaily = (value: number) =>
    top + plotH - (Math.max(0, value) / dailyMax) * plotH;

  const actualPoints = data.points
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => point.teamSp != null);
  const teamPath = actualPoints
    .map(
      ({ point, index }, pathIndex) =>
        `${pathIndex === 0 ? "M" : "L"} ${x(index)} ${yCumulative(point.teamSp ?? 0)}`
    )
    .join(" ");
  const idealPath = data.points
    .map((_, index) => {
      const ideal = data.baselinePlanSp * ((index + 1) / Math.max(1, data.sprintDays));
      return `${index === 0 ? "M" : "L"} ${x(index)} ${yCumulative(ideal)}`;
    })
    .join(" ");
  const reportIndexForForecast = data.points.findIndex((point) => point.date === data.reportDate);
  const forecastPath = reportIndexForForecast >= 0
    ? data.points
        .map((_, index) => index)
        .filter((index) => index >= reportIndexForForecast)
        .map((index, pathIndex, indexes) => {
          const ratio = indexes.length <= 1 ? 0 : pathIndex / (indexes.length - 1);
          const projected = data.currentDoneSp +
            (data.projectedDoneSp - data.currentDoneSp) * ratio;
          return `${pathIndex === 0 ? "M" : "L"} ${x(index)} ${yCumulative(projected)}`;
        })
        .join(" ")
    : "";

  const memberPaths = data.members
    .map((member) => {
      const path = data.points
        .map((point, index) => ({ value: point.memberSp[member.name], index }))
        .filter(({ value }) => value != null)
        .map(
          ({ value, index }, pathIndex) =>
            `${pathIndex === 0 ? "M" : "L"} ${x(index)} ${yCumulative(Number(value))}`
        )
        .join(" ");
      return path
        ? `<path d="${path}" fill="none" stroke="${member.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity=".96"/>`
        : "";
    })
    .join("");

  const bars = data.points
    .map((point, pointIndex) => {
      if (point.teamSp == null) return "";
      const groupWidth = Math.min(112, slotWidth * 0.72);
      const gap = 3;
      const barWidth =
        (groupWidth - gap * (data.members.length - 1)) /
        Math.max(1, data.members.length);
      const startX = x(pointIndex) - groupWidth / 2;
      return data.members
        .map((member, memberIndex) => {
          const value = Number(point.memberDailySp[member.name] ?? 0);
          const yy = yDaily(value);
          const barHeight = Math.max(value > 0 ? 3 : 0, top + plotH - yy);
          const xx = startX + memberIndex * (barWidth + gap);
          return `<rect x="${xx}" y="${top + plotH - barHeight}" width="${barWidth}" height="${barHeight}" rx="3" fill="${member.color}" opacity=".78"/>
            ${
              value > 0
                ? `<text x="${xx + barWidth / 2}" y="${Math.max(top + 10, yy - 5)}" text-anchor="middle" fill="${member.color}" font-size="11" font-weight="800">${fmt(value)}</text>`
                : ""
            }`;
        })
        .join("");
    })
    .join("");

  const yGrid = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const cumulativeValue = round1(cumulativeMax * ratio);
      const dailyValue = round1(dailyMax * ratio);
      const yy = yCumulative(cumulativeValue);
      return `<line x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}" stroke="rgba(255,255,255,.13)" stroke-width="1"/>
        <text x="${left - 12}" y="${yy + 4}" text-anchor="end" fill="rgba(255,255,255,.62)" font-size="14">${fmt(dailyValue)}</text>
        <text x="${width - right + 12}" y="${yy + 4}" text-anchor="start" fill="rgba(255,255,255,.62)" font-size="14">${fmt(cumulativeValue)}</text>`;
    })
    .join("");
  const xLabels = data.points
    .map((point, index) => {
      const xx = x(index);
      const active = point.date === data.reportDate;
      return `<line x1="${xx}" y1="${top}" x2="${xx}" y2="${top + plotH}" stroke="${active ? "rgba(50,230,196,.36)" : "rgba(255,255,255,.045)"}"/>
        <text x="${xx}" y="${height - 12}" text-anchor="middle" fill="${active ? "#55ffe0" : "rgba(255,255,255,.66)"}" font-size="16" font-weight="${active ? 800 : 500}">${md(point.date)}</text>`;
    })
    .join("");
  const dots = actualPoints
    .map(({ point, index }) => {
      const estimated = point.source === "estimated";
      return `<circle cx="${x(index)}" cy="${yCumulative(point.teamSp ?? 0)}" r="${point.date === data.reportDate ? 6 : 3.5}" fill="${estimated ? "#91a2bb" : "#f5ffff"}" stroke="#07121f" stroke-width="3"/>`;
    })
    .join("");
  const planY = yCumulative(data.baselinePlanSp);
  const reportIndex = data.points.findIndex((point) => point.date === data.reportDate);

  return `<svg class="recharts-surface" viewBox="0 0 ${width} ${height}" role="img" aria-label="メンバー別の日次消化SP棒グラフと累積SP線グラフ">
    <defs>
      <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    ${yGrid}${xLabels}
    <line x1="${left}" y1="${planY}" x2="${width - right}" y2="${planY}" stroke="#ffcf4a" stroke-width="2" stroke-dasharray="10 8" opacity=".78"/>
    <text x="${width - right}" y="${Math.max(18, planY - 8)}" text-anchor="end" fill="#ffdc72" font-size="15" font-weight="700">COMMIT ${fmt(data.baselinePlanSp)} SP</text>
    <text x="${left}" y="18" fill="rgba(255,255,255,.64)" font-size="13" font-weight="700">左軸：日次SP（棒）</text>
    <text x="${width - right}" y="18" text-anchor="end" fill="rgba(255,255,255,.64)" font-size="13" font-weight="700">右軸：累積SP（線）</text>
    ${bars}
    ${memberPaths}
    ${idealPath ? `<path d="${idealPath}" fill="none" stroke="#55ffe0" stroke-width="3" stroke-dasharray="8 7" opacity=".75"/>` : ""}
    ${teamPath ? `<path d="${teamPath}" fill="none" stroke="#f5ffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>` : ""}
    ${forecastPath ? `<path d="${forecastPath}" fill="none" stroke="#ff7197" stroke-width="4" stroke-dasharray="11 8" stroke-linecap="round" opacity=".92"/>` : ""}
    ${dots}
    ${reportIndex >= 0 ? `<line x1="${x(reportIndex)}" y1="${top}" x2="${x(reportIndex)}" y2="${top + plotH}" stroke="#32e6c4" stroke-width="2" stroke-dasharray="5 7" opacity=".7"/>` : ""}
  </svg>`;
}

/** OpenAI には装飾背景だけを生成させる。人名・タスク名・正確な SP は送信しない。 */
export async function generateAiDashboardBackground(
  config: Pick<AppConfig, "openaiApiKey" | "openaiImageModel">,
  data: SpDashboardData
): Promise<AiDashboardBackground> {
  const progressBand =
    data.completionRate >= 75 ? "final stretch" : data.completionRate >= 40 ? "mid-race" : "early race";
  const prompt = [
    "Create a 16:9 wide landscape decorative background for a Japanese software-team sprint gamification dashboard.",
    "Style: premium futuristic arcade racing game, dark navy arena, subtle neon cyan and warm gold track trails, soft speed particles, energetic but professional.",
    `The abstract race is in its ${progressBand}, sprint day ${data.elapsedDays} of ${data.sprintDays}, with ${data.members.length} racers.`,
    "Keep the entire center and lower-middle calm and dark for precise charts and data overlays.",
    "No people, no portraits, no text, no letters, no numbers, no logos, no UI widgets, no charts, no watermarks.",
    "High contrast only near the outer edges; clean composition; no copyrighted game characters."
  ].join(" ");

  try {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.openaiImageModel,
        prompt,
        n: 1,
        size: "1536x864",
        quality: "low",
        output_format: "jpeg",
        output_compression: 72
      })
    });
    const payload = (await response.json()) as {
      data?: Array<{ b64_json?: string }>;
      error?: { message?: string };
    };
    const base64 = payload.data?.[0]?.b64_json;
    if (!response.ok || !base64) {
      return {
        base64: null,
        model: config.openaiImageModel,
        error: (payload.error?.message ?? `OpenAI image API ${response.status}`).slice(0, 300)
      };
    }
    return { base64, model: config.openaiImageModel };
  } catch (error) {
    return {
      base64: null,
      model: config.openaiImageModel,
      error: (error as Error).message.slice(0, 300)
    };
  }
}

/** 正確な数値・線・順位を決定論的に重ねた 1536×1024 ダッシュボード HTML。 */
export function renderSpDashboardHtml(
  data: SpDashboardData,
  background?: AiDashboardBackground
): string {
  const chart = createChartSvg(data);
  const healthClass = `health-${data.health}`;
  const memberRows = data.members
    .map((member) => {
      const load = member.loadRatio == null ? "—" : `${fmt(member.loadRatio * 100)}%`;
      const loadClass = member.loadRatio == null
        ? ""
        : member.loadRatio > 1.2
        ? "load-red"
        : member.loadRatio > 1
        ? "load-yellow"
        : "load-green";
      return `<div class="member-row">
        <div class="member-name"><span class="dot" style="background:${member.color}"></span>${escapeHtml(member.displayName)}</div>
        <div><strong>${fmt(member.completedSp)}</strong><small>進捗</small></div>
        <div><strong>${fmt(member.doneSp)}</strong><small>Done</small></div>
        <div><strong>${fmt(member.planSp)}</strong><small>計画</small></div>
        <div><strong>${member.velocitySp == null ? "—" : fmt(member.velocitySp)}</strong><small>平均Velocity</small></div>
        <div class="${loadClass}"><strong>${load}</strong><small>負荷</small></div>
      </div>`;
    })
    .join("");
  const legend = [
    `<span><i style="background:#55ffe0"></i>計画線</span>`,
    `<span><i style="background:#f5ffff"></i>進捗SP実績</span>`,
    `<span><i style="background:#ff7197"></i>着地予測</span>`
  ].join("");
  const checkpointRows = data.checkpoints.length > 0
    ? data.checkpoints.slice(0, 3).map((checkpoint) => `<div class="checkpoint-row">
        <div><strong>${checkpoint.healthLabel.split(" ")[0]} ${escapeHtml(checkpoint.name)}</strong><span>${escapeHtml(checkpoint.checkpoint || "次チェックポイント未設定")}</span></div>
        <div><b>${fmt(checkpoint.progressRate)}%</b><small>${fmt(checkpoint.progressSp)}/${fmt(checkpoint.planSp)} SP</small></div>
      </div>`).join("")
    : `<div class="checkpoint-empty">今Sprintに紐づくチェックポイントがありません</div>`;
  const actionItems = data.recommendations
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const note = data.usedEstimatedHistory
    ? "※ 灰色区間はNotion更新日からの推定。以後は毎日24時の実測。進捗SPはステータス率×SP、Doneは完了のみ。"
    : "※ 毎日24時の実測。進捗SPはステータス率×SP、Doneは完了のみ。複数担当タスクは均等配分。";
  const bgStyle = background?.base64
    ? `background-image:linear-gradient(105deg,rgba(3,10,23,.90),rgba(5,16,33,.76) 52%,rgba(3,9,22,.92)),url(data:image/jpeg;base64,${background.base64});`
    : "background-image:radial-gradient(circle at 82% 4%,rgba(50,230,196,.22),transparent 30%),radial-gradient(circle at 8% 100%,rgba(139,124,255,.24),transparent 34%),linear-gradient(135deg,#050b17,#0a1730 55%,#070c19);";
  const aiLabel = background?.base64 ? `AI THEME · ${escapeHtml(background.model)}` : "SAFE FALLBACK THEME";
  const confidenceLabel = data.forecastConfidence === "high" ? "高" : data.forecastConfidence === "medium" ? "中" : "低";

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
*{box-sizing:border-box}html,body{margin:0;width:1536px;height:1024px;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;background:#050b17;color:#f7fbff}
#root{width:1536px;height:1024px;padding:30px 42px 24px;${bgStyle}background-size:cover;background-position:center;position:relative}
#root:after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px);background-size:100% 4px;mix-blend-mode:soft-light}
.content{position:relative;z-index:1;height:100%;display:flex;flex-direction:column;gap:11px}
.header{height:78px;display:flex;align-items:flex-start;justify-content:space-between}
.eyebrow{color:#55ffe0;font-size:15px;font-weight:900;letter-spacing:.22em}.title{font-size:43px;line-height:1;font-weight:950;letter-spacing:.035em;margin-top:5px;text-shadow:0 0 28px rgba(50,230,196,.22)}
.header-right{text-align:right}.sprint{font-size:23px;font-weight:850}.date{margin-top:5px;color:#b6c7da;font-size:15px}.ai{display:inline-block;margin-top:5px;padding:4px 9px;border:1px solid rgba(85,255,224,.42);border-radius:999px;color:#82ffe9;background:rgba(5,26,38,.72);font-size:10px;font-weight:800;letter-spacing:.08em}
.kpis{height:124px;display:grid;grid-template-columns:1.05fr 1.1fr 1fr 1.2fr;gap:11px}.card{border:1px solid rgba(255,255,255,.15);background:linear-gradient(145deg,rgba(11,28,51,.88),rgba(7,15,31,.80));border-radius:16px;box-shadow:0 16px 36px rgba(0,0,0,.2),inset 0 1px rgba(255,255,255,.05);backdrop-filter:blur(8px)}
.kpi{padding:15px 18px}.kpi-label{color:#aabbd0;font-size:13px;font-weight:850;letter-spacing:.08em}.kpi-value{font-size:35px;font-weight:950;line-height:1.08;margin-top:7px}.kpi-value small{font-size:16px;color:#91a4bb;font-weight:700}.accent{color:#55ffe0}.gold{color:#ffda65}.pink{color:#ff7197}.sub{margin-top:5px;font-size:12px;color:#a7b8cc;line-height:1.35}.status{font-weight:850;color:#e7f5ff}.health-green{color:#55ffe0}.health-yellow{color:#ffda65}.health-red{color:#ff7197}.health-unknown{color:#aabbd0}
.chart-card{height:338px;padding:11px 12px 3px}.section-head{display:flex;align-items:center;justify-content:space-between;padding:0 18px 1px}.section-title{font-size:18px;font-weight:900}.legend{display:flex;gap:15px;align-items:center;color:#b9c8d9;font-size:12px;font-weight:700}.legend span{display:flex;align-items:center;gap:6px}.legend i{width:9px;height:9px;border-radius:50%;box-shadow:0 0 8px currentColor}.chart-card svg{display:block;width:100%;height:292px}
.bottom{height:330px;display:grid;grid-template-columns:1.18fr 1fr;gap:11px}.panel{padding:13px 16px;overflow:hidden}.panel-title{height:29px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,.10);padding-bottom:8px}.panel-title h2{margin:0;font-size:17px}.panel-title span{color:#94a7bc;font-size:11px}
.member-row{height:54px;display:grid;grid-template-columns:1.5fr repeat(5,.72fr);gap:7px;align-items:center;border-bottom:1px solid rgba(255,255,255,.075);text-align:right}.member-name{font-size:14px;font-weight:850;text-align:left;display:flex;align-items:center;gap:8px}.dot{width:9px;height:9px;border-radius:50%;box-shadow:0 0 10px currentColor}.member-row strong{font-size:17px}.member-row small{display:block;color:#8fa3b9;font-size:9px;margin-top:2px}.load-green strong{color:#55ffe0}.load-yellow strong{color:#ffda65}.load-red strong{color:#ff7197}
.checkpoint-row{min-height:53px;padding:7px 0;display:grid;grid-template-columns:1fr 88px;gap:10px;border-bottom:1px solid rgba(255,255,255,.075);align-items:center}.checkpoint-row strong{font-size:13px;display:block}.checkpoint-row span{display:block;color:#9eb0c4;font-size:10px;line-height:1.35;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.checkpoint-row>div:last-child{text-align:right}.checkpoint-row b{font-size:18px}.checkpoint-row small{display:block;color:#8fa3b9;font-size:9px}.checkpoint-empty{height:54px;display:flex;align-items:center;color:#8fa3b9;font-size:12px}
.decision{display:grid;grid-template-rows:auto 1fr}.actions{padding-top:9px}.actions h3{font-size:13px;margin:0 0 5px;color:#ffda65}.actions ol{margin:0;padding-left:21px;color:#d8e4ef;font-size:11px;line-height:1.5}.actions li{margin-bottom:2px}.reason{font-size:11px;color:#a7b8cc;margin-top:5px}.footer{height:24px;display:flex;justify-content:space-between;align-items:center;color:#92a5bb;font-size:10px}.footer strong{color:#d7e6f4;letter-spacing:.06em}
</style></head><body><div id="root"><main class="content">
  <header class="header"><div><div class="eyebrow">DAILY PLAN × ACTUAL × FORECAST</div><div class="title">SPRINT CONTROL</div></div><div class="header-right"><div class="sprint">${escapeHtml(data.sprint.name)} · DAY ${data.elapsedDays}/${data.sprintDays}</div><div class="date">${escapeHtml(data.sprint.start_date)} → ${escapeHtml(data.sprint.end_date)} ｜ 集計 ${escapeHtml(data.reportDate)}</div><div class="ai">${aiLabel}</div></div></header>
  <section class="kpis">
    <div class="card kpi"><div class="kpi-label">SPRINT HEALTH</div><div class="kpi-value ${healthClass}">${escapeHtml(data.healthLabel.split(" ")[0])} <small>${escapeHtml(data.healthLabel.split(" ").slice(1).join(" "))}</small></div><div class="sub">${escapeHtml(data.healthReason)}</div></div>
    <div class="card kpi"><div class="kpi-label">PROGRESS VS PLAN</div><div class="kpi-value accent">${fmt(data.current.teamCompletedSp)} <small>/ ${fmt(data.baselinePlanSp)} SP</small></div><div class="sub">本日計画 ${fmt(data.expectedByTodaySp)} SP ｜ 差分 <span class="status">${data.progressGapSp >= 0 ? "+" : ""}${fmt(data.progressGapSp)} SP</span></div></div>
    <div class="card kpi"><div class="kpi-label">CONFIRMED DONE</div><div class="kpi-value gold">${fmt(data.currentDoneSp)} <small>SP</small></div><div class="sub">Done率 ${fmt(data.doneRate)}% ｜ 本日進捗 +${fmt(data.teamTodayDelta)} SP</div></div>
    <div class="card kpi"><div class="kpi-label">SPRINT LANDING</div><div class="kpi-value pink">${fmt(data.projectedDoneSp)} <small>/ ${fmt(data.baselinePlanSp)} SP</small></div><div class="sub">着地 ${fmt(data.projectedDoneRate)}% ｜ 必要 ${fmt(data.requiredDoneSpPerDay)} SP/日 ｜ 信頼度 ${confidenceLabel}</div></div>
  </section>
  <section class="card chart-card"><div class="section-head"><div class="section-title">計画線 × 進捗SP実績 × 着地予測 <span style="color:#8194aa;font-size:12px;font-weight:600">｜棒: 担当者別の日次進捗SP</span></div><div class="legend">${legend}</div></div>${chart}</section>
  <section class="bottom">
    <div class="card panel"><div class="panel-title"><h2>👥 MEMBER LOAD × VELOCITY</h2><span>進捗 / Done / 計画 / 直近Sprint平均</span></div>${memberRows}</div>
    <div class="card panel decision"><div><div class="panel-title"><h2>🎯 CHECKPOINTS</h2><span>Scope ${data.scopeDeltaSp >= 0 ? "+" : ""}${fmt(data.scopeDeltaSp)} SP ｜ 未接続 ${data.readiness.orphanTasks}件</span></div>${checkpointRows}</div><div class="actions"><h3>明日の軌道修正</h3><ol>${actionItems}</ol></div></div>
  </section>
  <footer class="footer"><span>${escapeHtml(note)}</span><strong>SPRINT CONTROL · OPENAI + CLOUDFLARE</strong></footer>
</main></div></body></html>`;
}

export function spTaskDetailCanvasHeight(data: SpTaskDetailData): number {
  const maxRows = Math.max(1, ...data.groups.map((group) => group.rows.length));
  const cardHeight = 114 + maxRows * 58;
  return Math.max(1024, 36 + 102 + 18 + cardHeight * 2 + 18 + 34 + 28);
}

/** ステータス文字列から表示用バッジHTMLを返す。 */
function statusBadge(status: string): string {
  if (!status || status === "—") {
    return `<span class="badge badge-none">—</span>`;
  }
  const rate = statusProgressRate(status);
  if (isCompletedStatus(status)) {
    return `<span class="badge badge-done">${escapeHtml(status)}</span>`;
  }
  if (/中止|cancel|abort|closed/i.test(status)) {
    return `<span class="badge badge-cancel">${escapeHtml(status)}</span>`;
  }
  if (rate > 0) {
    return `<span class="badge badge-doing">${escapeHtml(status)}</span>`;
  }
  return `<span class="badge badge-ready">${escapeHtml(status)}</span>`;
}

/** 各メンバーのスプリントタスク一覧（全ステータス）を表示する画像。 */
export function renderSpTaskDetailsHtml(
  data: SpTaskDetailData,
  background?: AiDashboardBackground
): string {
  const canvasHeight = spTaskDetailCanvasHeight(data);
  const maxRows = Math.max(1, ...data.groups.map((g) => g.rows.length));
  const cardHeight = 114 + maxRows * 58;
  const bgStyle = background?.base64
    ? `background-image:linear-gradient(105deg,rgba(3,10,23,.94),rgba(5,16,33,.88) 52%,rgba(3,9,22,.95)),url(data:image/jpeg;base64,${background.base64});`
    : "background-image:radial-gradient(circle at 82% 4%,rgba(50,230,196,.18),transparent 30%),radial-gradient(circle at 8% 100%,rgba(139,124,255,.20),transparent 34%),linear-gradient(135deg,#050b17,#0a1730 55%,#070c19);";

  const totalProgressSp = round1(data.groups.reduce((sum, g) => sum + g.progressSp, 0));
  const totalPlanSp = round1(data.groups.reduce((sum, g) => sum + g.planSp, 0));

  const cards = data.groups
    .map((group) => {
      const rows =
        group.rows.length > 0
          ? group.rows
              .map(
                (row) => `<div class="task-row">
                  <div class="task-cell">${escapeHtml(row.taskName)}<small>${escapeHtml(row.projectName)}</small></div>
                  <div class="status-cell">${statusBadge(row.startStatus)}</div>
                  <div class="status-cell">${statusBadge(row.currentStatus)}</div>
                  <div class="point-cell${row.progressSp > 0 ? " point-pos" : ""}">${row.progressSp > 0 ? "+" : ""}${fmt(row.progressSp)} SP</div>
                </div>`
              )
              .join("")
          : '<div class="empty">タスクなし</div>';
      return `<section class="member-card" style="--player:${group.color}">
        <header class="member-head">
          <div><span class="player-dot"></span><strong>${escapeHtml(group.displayName)}</strong></div>
          <div class="member-total">
            <b>${fmt(group.progressSp)}</b><span class="sp-unit"> / ${fmt(group.planSp)} SP</span>
            <span class="task-count">｜ ${group.rows.length} TASKS</span>
          </div>
        </header>
        <div class="table-head"><span>タスク名</span><span>開始時</span><span>現状</span><span>進捗POINT</span></div>
        <div class="table-body">${rows}</div>
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
*{box-sizing:border-box}html,body{margin:0;width:1536px;height:${canvasHeight}px;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;background:#050b17;color:#f7fbff}
#root{width:1536px;height:${canvasHeight}px;padding:36px 48px 28px;${bgStyle}background-size:cover;background-position:center;position:relative}
#root:after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px);background-size:100% 4px;mix-blend-mode:soft-light}
.content{position:relative;z-index:1}
.header{height:102px;display:flex;justify-content:space-between;align-items:flex-start}
.eyebrow{color:#55ffe0;font-size:16px;font-weight:900;letter-spacing:.2em}
.title{font-size:42px;font-weight:950;letter-spacing:.035em;margin-top:6px}
.header-right{text-align:right}.sprint{font-size:24px;font-weight:900}
.meta{color:#aebfd1;font-size:16px;margin-top:9px}
.total{display:inline-block;margin-top:10px;padding:7px 12px;border:1px solid rgba(85,255,224,.4);border-radius:999px;color:#72ffe5;font-size:13px;font-weight:850}
.grid{height:${cardHeight * 2 + 18}px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:${cardHeight}px ${cardHeight}px;gap:18px}
.member-card{height:${cardHeight}px;border:1px solid rgba(255,255,255,.15);border-top:3px solid var(--player);background:linear-gradient(145deg,rgba(11,28,51,.91),rgba(7,15,31,.86));border-radius:18px;overflow:hidden;box-shadow:0 18px 40px rgba(0,0,0,.2)}
.member-head{height:66px;padding:0 20px;display:flex;align-items:center;justify-content:space-between}
.member-head>div:first-child{display:flex;align-items:center;gap:10px}
.member-head strong{font-size:22px}
.player-dot{width:12px;height:12px;border-radius:50%;background:var(--player);box-shadow:0 0 15px var(--player)}
.member-total{color:#c2d2e2;font-size:15px;display:flex;align-items:baseline;gap:4px}
.member-total b{font-size:28px;color:var(--player);font-weight:900}
.sp-unit{color:#8fa3b9;font-size:13px}.task-count{color:#8fa3b9;font-size:12px;font-weight:800;margin-left:4px}
.table-head,.task-row{display:grid;grid-template-columns:minmax(0,1fr) 148px 148px 96px;align-items:center}
.table-head{height:34px;padding:0 16px;background:rgba(255,255,255,.055);color:#8fa3b9;font-size:11px;font-weight:900;letter-spacing:.08em}
.task-row{min-height:58px;padding:6px 16px;border-top:1px solid rgba(255,255,255,.065);font-size:13px;gap:8px}
.task-cell{font-weight:700;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.task-cell small{display:block;color:#8397ac;font-size:10px;font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.status-cell{display:flex;align-items:center}
.badge{display:inline-block;padding:3px 9px;border-radius:6px;font-size:12px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:136px}
.badge-done{background:rgba(34,197,94,.18);color:#4ade80}
.badge-doing{background:rgba(59,130,246,.18);color:#60a5fa}
.badge-cancel{background:rgba(239,68,68,.14);color:#f87171}
.badge-ready{background:rgba(100,116,139,.16);color:#94a3b8}
.badge-none{color:#4a5568;font-size:14px}
.point-cell{font-size:14px;font-weight:900;color:#64748b}
.point-pos{color:#55ffe0}
.empty{height:${Math.max(58, maxRows * 58)}px;display:flex;align-items:center;justify-content:center;color:#758aa1;font-size:15px}
.footer{height:34px;margin-top:18px;display:flex;justify-content:space-between;align-items:center;color:#90a4ba;font-size:12px}
.footer strong{color:#d6e5f3;letter-spacing:.06em}
</style></head><body><div id="root"><main class="content">
  <header class="header">
    <div><div class="eyebrow">SPRINT PROGRESS RECORDS</div><div class="title">PLAYER TASK STATUS</div></div>
    <div class="header-right">
      <div class="sprint">${escapeHtml(data.sprint.name)} · ALL TASKS</div>
      <div class="meta">${escapeHtml(data.sprint.start_date)} → ${escapeHtml(data.sprint.end_date)} ｜ 集計 ${escapeHtml(data.reportDate)}</div>
      <div class="total">4 PLAYERS · ${data.taskCount} TASKS · ${fmt(totalProgressSp)} / ${fmt(totalPlanSp)} SP</div>
    </div>
  </header>
  <div class="grid">${cards}</div>
  <footer class="footer"><span>※ 複数担当タスクのSPは均等配分。進捗POINTは現状ステータスの進捗率×SP。</span><strong>SPRINT CONTROL · TASK STATUS</strong></footer>
</main></div></body></html>`;
}

export async function buildSpDashboardPng(
  browser: Fetcher | undefined,
  data: SpDashboardData,
  background?: AiDashboardBackground
): Promise<Uint8Array | null> {
  return htmlToPng(browser, renderSpDashboardHtml(data, background), {
    width: 1536,
    height: 1024,
    deviceScaleFactor: 1
  });
}

export async function buildSpTaskDetailsPng(
  browser: Fetcher | undefined,
  data: SpTaskDetailData,
  background?: AiDashboardBackground
): Promise<Uint8Array | null> {
  return htmlToPng(browser, renderSpTaskDetailsHtml(data, background), {
    width: 1536,
    height: spTaskDetailCanvasHeight(data),
    deviceScaleFactor: 1
  });
}

/**
 * ダッシュボード + タスク詳細を横に並べた1枚の PNG を生成する。
 * Slack で見やすい横長の SPRINT CONTROL 画像として1投稿にまとめるために使う。
 */
export async function buildCombinedDashboardPng(
  browser: Fetcher | undefined,
  dashData: SpDashboardData,
  detailsData: SpTaskDetailData,
  background?: AiDashboardBackground
): Promise<Uint8Array | null> {
  const detailsHeight = spTaskDetailCanvasHeight(detailsData);
  const totalWidth = 1536 * 2;
  const totalHeight = Math.max(1024, detailsHeight);

  const toBase64 = (bytes: Uint8Array): string => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(s);
  };

  const dashPng = await buildSpDashboardPng(browser, dashData, background);
  if (!dashPng) return null;
  const detailsPng = await buildSpTaskDetailsPng(browser, detailsData, background);
  if (!detailsPng) return null;

  const b64Dash = toBase64(dashPng);
  const b64Details = toBase64(detailsPng);

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:${totalWidth}px;height:${totalHeight}px;background:#050b17;overflow:hidden;display:flex;align-items:flex-start}
    img{display:block;width:1536px;height:auto;flex:0 0 1536px}
  </style></head><body>
    <img src="data:image/png;base64,${b64Dash}">
    <img src="data:image/png;base64,${b64Details}">
  </body></html>`;

  return htmlToPng(browser, html, { width: totalWidth, height: totalHeight, deviceScaleFactor: 1 });
}

export function spDashboardSlackComment(data: SpDashboardData): string {
  return [
    `${data.healthLabel} *${data.sprint.name} Sprint Control* — ${data.reportDate}`,
    `進捗SP *${fmt(data.current.teamCompletedSp)} / ${fmt(data.baselinePlanSp)}*（本日計画 ${fmt(data.expectedByTodaySp)}、差分 ${data.progressGapSp >= 0 ? "+" : ""}${fmt(data.progressGapSp)} SP）`,
    `確定Done *${fmt(data.currentDoneSp)} SP* ｜ 着地予測 *${fmt(data.projectedDoneSp)} SP / ${fmt(data.projectedDoneRate)}%*`,
    `残り${data.remainingDays}日・完遂に必要 *${fmt(data.requiredDoneSpPerDay)} SP/日* ｜ 直近Velocity ${data.historicalVelocitySp == null ? "—" : `${fmt(data.historicalVelocitySp)} SP/Sprint`}`,
    `明日の判断: ${data.recommendations[0] ?? "現在の優先順位を維持"}`
  ]
    .filter(Boolean)
    .join("\n");
}

/** Sprint開始時にMMDDタスクスレッドへ投稿するPlanning診断。 */
export function sprintPlanningSlackComment(data: SpDashboardData): string {
  const checkpointLines = data.checkpoints.length > 0
    ? data.checkpoints.map((checkpoint) =>
        `• ${checkpoint.name}: ${checkpoint.checkpoint || "⚠️ 次チェックポイント未設定"}（${fmt(checkpoint.planSp)} SP）`
      )
    : ["• ⚠️ 今Sprintのタスクに紐づくチェックポイントがありません"];
  const velocity = data.historicalVelocitySp == null
    ? "履歴不足"
    : `${fmt(data.historicalVelocitySp)} SP / Sprint`;
  const loadRatio = data.historicalVelocitySp && data.historicalVelocitySp > 0
    ? round1((data.current.teamPlanSp / data.historicalVelocitySp) * 100)
    : null;
  return [
    `🧭 *${data.sprint.name} Sprint Planning診断*`,
    `期間: ${data.sprint.start_date}〜${data.sprint.end_date}`,
    `計画: *${fmt(data.current.teamPlanSp)} SP* ｜ 直近Velocity: *${velocity}*${loadRatio == null ? "" : ` ｜ 負荷率: *${fmt(loadRatio)}%*`}`,
    "",
    "*今回到達するチェックポイント*",
    ...checkpointLines,
    "",
    "*Planning品質チェック*",
    `• SP未設定 ${data.readiness.missingSp}件 / 担当者未設定 ${data.readiness.missingOwner}件 / 完了条件未設定 ${data.readiness.missingCompletionCriteria}件`,
    `• チェックポイント未接続 ${data.readiness.orphanTasks}件`,
    "",
    "*Planningで決める順番*",
    "1. Sprint終了時の到達状態を決める",
    "2. 到達に必要なタスクを逆算する",
    "3. 完了条件・SP・担当者・期限を埋める",
    "4. 計画SPをVelocityと比較し、コミット範囲を確定する",
    "",
    `推奨: ${data.recommendations.join(" / ")}`
  ].join("\n");
}

export function spTaskDetailsSlackComment(data: SpTaskDetailData): string {
  const totals = data.groups
    .map((group) => `${group.displayName} ${fmt(group.progressSp)}/${fmt(group.planSp)} SP`)
    .join(" ｜ ");
  return [
    `📋 *${data.sprint.name} タスク進捗内訳* — ${data.reportDate}`,
    totals,
    "※ 進捗POINT = 現状ステータス進捗率 × SP（doing(60%)→60%消化）"
  ].join("\n");
}
