import type {
  MemberCapacity,
  SprintDashboardTask,
  SprintCheckpointRecord
} from "./notionApi";
import type { SprintDashboardInfo } from "./spGamification";
import type { SprintPlanBaseline, SprintPlanTaskSnapshot } from "./workflow";

export const DEFAULT_MEMBER_WEEKLY_HOURS = 204 / (52 / 12);
export const DEFAULT_TEAM_SIZE = 4;
export const COMMIT_CAPACITY_RATIO = 0.9;

export interface PlanningTaskDecision {
  task: SprintDashboardTask;
  recommendedClass: "Commit" | "Stretch";
  explicitClass: boolean;
  checkpointLinked: boolean;
  issues: string[];
}

export interface MemberLoad {
  name: string;
  plannedHours: number;
  capacityHours: number;
  loadPercent: number;
}

export interface SprintPlanningDraft {
  sprint: SprintDashboardInfo;
  capacitySource: "notion" | "default";
  totalCapacityHours: number;
  commitLimitHours: number;
  velocitySp: number | null;
  commitSp: number;
  commitHours: number;
  stretchSp: number;
  stretchHours: number;
  decisions: PlanningTaskDecision[];
  memberLoads: MemberLoad[];
  qualityCounts: Record<string, number>;
}

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const activeForPlanning = (task: SprintDashboardTask): boolean =>
  !/完了|done|closed|completed|resolved|終了|クローズ|中止|cancel/iu.test(task.status ?? "");

const priorityValue = (priority?: string | null): number => {
  const value = Number(priority);
  return Number.isFinite(value) ? value : 0;
};

const taskIssues = (
  task: SprintDashboardTask,
  checkpointLinked: boolean
): string[] => {
  const issues: string[] = [];
  if (!(task.sp > 0)) issues.push("SP");
  if (task.assignees.length === 0) issues.push("担当者");
  if (!task.completionCriteria?.trim()) issues.push("完了条件");
  if (!task.dueDate) issues.push("期限");
  if (task.budgetHours == null) issues.push("工数予算");
  if ((task.budgetHours ?? 0) > 16) issues.push("16h超");
  if (!checkpointLinked) issues.push("Checkpoint未紐付け");
  return issues;
};

export function buildSprintPlanningDraft(
  sprint: SprintDashboardInfo,
  tasks: SprintDashboardTask[],
  capacities: MemberCapacity[],
  checkpoints: SprintCheckpointRecord[],
  velocitySp: number | null
): SprintPlanningDraft {
  const activeTasks = tasks.filter(activeForPlanning);
  const checkpointTaskIds = new Set(checkpoints.flatMap((item) => item.taskIds));
  const capacitySource = capacities.length > 0 ? "notion" : "default";
  const assigneeNames = [...new Set(activeTasks.flatMap((task) => task.assignees))];
  const fallbackMemberCount = Math.max(DEFAULT_TEAM_SIZE, assigneeNames.length);
  const totalCapacityHours =
    capacities.length > 0
      ? capacities.reduce((sum, item) => sum + item.totalHours, 0)
      : fallbackMemberCount * DEFAULT_MEMBER_WEEKLY_HOURS;
  const commitLimitHours = totalCapacityHours * COMMIT_CAPACITY_RATIO;

  const sorted = [...activeTasks].sort((a, b) => {
    const checkpointDelta =
      Number(checkpointTaskIds.has(b.id)) - Number(checkpointTaskIds.has(a.id));
    if (checkpointDelta !== 0) return checkpointDelta;
    const priorityDelta = priorityValue(b.priority) - priorityValue(a.priority);
    if (priorityDelta !== 0) return priorityDelta;
    const dueA = a.dueDate ?? "9999-12-31";
    const dueB = b.dueDate ?? "9999-12-31";
    return dueA.localeCompare(dueB) || a.name.localeCompare(b.name, "ja");
  });

  let plannedCommitHours = sorted
    .filter((task) => task.sprintClass === "Commit")
    .reduce((sum, task) => sum + (task.budgetHours ?? 0), 0);

  const decisions: PlanningTaskDecision[] = sorted.map((task) => {
    const checkpointLinked = checkpointTaskIds.has(task.id);
    const explicitClass = task.sprintClass === "Commit" || task.sprintClass === "Stretch";
    let recommendedClass: "Commit" | "Stretch";
    if (task.sprintClass === "Commit" || task.sprintClass === "Stretch") {
      recommendedClass = task.sprintClass;
    } else {
      const taskHours = task.budgetHours ?? 0;
      // 未見積を0hとしてCommitへ入れると過剰Commitになるため、見積入力まではStretch扱い。
      recommendedClass = task.budgetHours == null
        ? "Stretch"
        : plannedCommitHours + taskHours <= commitLimitHours
          ? "Commit"
          : "Stretch";
      if (recommendedClass === "Commit") plannedCommitHours += taskHours;
    }
    return {
      task,
      recommendedClass,
      explicitClass,
      checkpointLinked,
      issues: taskIssues(task, checkpointLinked)
    };
  });

  const sumFor = (kind: "Commit" | "Stretch", pick: (task: SprintDashboardTask) => number) =>
    decisions
      .filter((item) => item.recommendedClass === kind)
      .reduce((sum, item) => sum + pick(item.task), 0);
  const commitSp = sumFor("Commit", (task) => task.sp || 0);
  const commitHours = sumFor("Commit", (task) => task.budgetHours ?? 0);
  const stretchSp = sumFor("Stretch", (task) => task.sp || 0);
  const stretchHours = sumFor("Stretch", (task) => task.budgetHours ?? 0);

  const capacityByName = new Map(
    capacities.map((item) => [item.name, item.totalHours] as const)
  );
  const loadByName = new Map<string, number>();
  for (const item of decisions.filter((entry) => entry.recommendedClass === "Commit")) {
    if (item.task.assignees.length === 0) continue;
    const share = (item.task.budgetHours ?? 0) / item.task.assignees.length;
    for (const assignee of item.task.assignees) {
      loadByName.set(assignee, (loadByName.get(assignee) ?? 0) + share);
    }
  }
  const memberLoads = [...new Set([...capacityByName.keys(), ...loadByName.keys()])]
    .map((name) => {
      const plannedHours = loadByName.get(name) ?? 0;
      const capacityHours = capacityByName.get(name) ?? DEFAULT_MEMBER_WEEKLY_HOURS;
      return {
        name,
        plannedHours: round(plannedHours),
        capacityHours: round(capacityHours),
        loadPercent: capacityHours > 0 ? round((plannedHours / capacityHours) * 100) : 0
      };
    })
    .sort((a, b) => b.loadPercent - a.loadPercent || a.name.localeCompare(b.name, "ja"));

  const qualityCounts: Record<string, number> = {};
  for (const decision of decisions) {
    for (const issue of decision.issues) {
      qualityCounts[issue] = (qualityCounts[issue] ?? 0) + 1;
    }
  }

  return {
    sprint,
    capacitySource,
    totalCapacityHours: round(totalCapacityHours),
    commitLimitHours: round(commitLimitHours),
    velocitySp,
    commitSp: round(commitSp),
    commitHours: round(commitHours),
    stretchSp: round(stretchSp),
    stretchHours: round(stretchHours),
    decisions,
    memberLoads,
    qualityCounts
  };
}

const slackTask = (task: SprintDashboardTask): string =>
  task.url ? `<${task.url}|${task.name.replace(/[<>|]/g, "")}>` : task.name;

export function renderSprintPlanningDraft(draft: SprintPlanningDraft): string {
  const source = draft.capacitySource === "notion" ? "Notion Capacity" : "標準4FTE換算";
  const velocity = draft.velocitySp == null ? "未計測" : `${round(draft.velocitySp)} SP`;
  const quality = Object.entries(draft.qualityCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`)
    .join(" / ") || "不足なし";
  const lines = [
    `🧭 *SPRINT PLANNING DRAFT｜${draft.sprint.name}*`,
    `Checkpoint → Capacity → Commit → Stretch の順で確認します。`,
    `Capacity ${draft.totalCapacityHours}h（${source}）｜Commit上限 ${draft.commitLimitHours}h（90%）｜直近Velocity ${velocity}`,
    `*Commit案* ${draft.commitSp}SP / ${draft.commitHours}h　*Stretch案* ${draft.stretchSp}SP / ${draft.stretchHours}h`,
    "",
    "*Commit候補*"
  ];
  for (const item of draft.decisions.filter((entry) => entry.recommendedClass === "Commit").slice(0, 12)) {
    lines.push(`• ${slackTask(item.task)}｜${item.task.sp || 0}SP / ${item.task.budgetHours ?? "?"}h${item.checkpointLinked ? " / CP" : ""}${item.issues.length ? ` / 要補完:${item.issues.join("・")}` : ""}`);
  }
  const stretch = draft.decisions.filter((entry) => entry.recommendedClass === "Stretch");
  if (stretch.length > 0) {
    lines.push("", "*Stretch候補*");
    for (const item of stretch.slice(0, 8)) {
      lines.push(`• ${slackTask(item.task)}｜${item.task.sp || 0}SP / ${item.task.budgetHours ?? "?"}h`);
    }
  }
  const overloaded = draft.memberLoads.filter((item) => item.loadPercent > 100);
  lines.push(
    "",
    `*担当負荷* ${draft.memberLoads.map((item) => `${item.name} ${item.plannedHours}/${item.capacityHours}h (${item.loadPercent}%)`).join("｜") || "担当者未設定"}`,
    `*品質ゲート* ${quality}`,
    overloaded.length > 0
      ? `⚠️ 過負荷: ${overloaded.map((item) => `${item.name} ${item.loadPercent}%`).join("、")}。担当変更かStretch移動を決めてください。`
      : "✅ 担当負荷はCapacity内です。",
    "次: 不足値と過負荷を直し、PMが「計画をロック」を押すとSprint区分とbaselineを確定します。"
  );
  return lines.join("\n").slice(0, 38_000);
}

export function toSprintPlanTaskSnapshots(
  draft: SprintPlanningDraft
): SprintPlanTaskSnapshot[] {
  return draft.decisions.map((item) => ({
    id: item.task.id,
    name: item.task.name,
    sp: item.task.sp || 0,
    budgetHours: item.task.budgetHours ?? null,
    sprintClass: item.task.sprintClass ?? null,
    recommendedClass: item.recommendedClass
  }));
}

export interface SprintScopeDiff {
  baseline: SprintPlanBaseline;
  added: SprintDashboardTask[];
  removed: SprintPlanTaskSnapshot[];
  addedSp: number;
  addedHours: number;
  currentSp: number;
  currentHours: number;
  increasePercent: number | null;
  fingerprint: string;
}

export function buildSprintScopeDiff(
  baseline: SprintPlanBaseline,
  currentTasks: SprintDashboardTask[]
): SprintScopeDiff {
  // 完了はScopeから消えたのではない。明示的な中止だけを除き、完了タスクもbaseline比較に残す。
  const active = currentTasks.filter(
    (task) => !/中止|cancel/iu.test(task.status ?? "")
  );
  const baselineIds = new Set(baseline.tasks.map((task) => task.id));
  const currentIds = new Set(active.map((task) => task.id));
  const added = active.filter((task) => !baselineIds.has(task.id));
  const removed = baseline.tasks.filter((task) => !currentIds.has(task.id));
  const addedSp = added.reduce((sum, task) => sum + (task.sp || 0), 0);
  const addedHours = added.reduce((sum, task) => sum + (task.budgetHours ?? 0), 0);
  const currentSp = active.reduce((sum, task) => sum + (task.sp || 0), 0);
  const currentHours = active.reduce((sum, task) => sum + (task.budgetHours ?? 0), 0);
  const increasePercent = baseline.totalHours > 0
    ? round((addedHours / baseline.totalHours) * 100)
    : null;
  const fingerprint = [
    ...added.map((task) => `+${task.id}:${task.sp}:${task.budgetHours ?? ""}`),
    ...removed.map((task) => `-${task.id}`)
  ].sort().join("|");
  return {
    baseline,
    added,
    removed,
    addedSp: round(addedSp),
    addedHours: round(addedHours),
    currentSp: round(currentSp),
    currentHours: round(currentHours),
    increasePercent,
    fingerprint
  };
}

export function renderSprintScopeDiff(diff: SprintScopeDiff): string {
  const lines = [
    `🔒 *SPRINT SCOPE｜${diff.baseline.sprintName}*`,
    `Baseline ${diff.baseline.totalSp}SP / ${diff.baseline.totalHours}h → Current ${diff.currentSp}SP / ${diff.currentHours}h`,
    `途中追加 +${diff.addedSp}SP / +${diff.addedHours}h${diff.increasePercent == null ? "" : `（Baseline比 +${diff.increasePercent}%）`}`
  ];
  if (diff.added.length > 0) {
    lines.push("", "*追加*");
    for (const task of diff.added.slice(0, 10)) {
      lines.push(`• ${slackTask(task)}｜${task.sp || 0}SP / ${task.budgetHours ?? "?"}h`);
    }
  }
  if (diff.removed.length > 0) {
    lines.push("", "*除外/期限外へ移動*");
    for (const task of diff.removed.slice(0, 10)) {
      lines.push(`• ${task.name}｜${task.sp}SP / ${task.budgetHours ?? "?"}h`);
    }
  }
  lines.push("", "次: 追加分を受け入れるなら、同量のScopeをStretch/次Sprintへ移すかCapacity増を明示してください。");
  return lines.join("\n").slice(0, 38_000);
}
