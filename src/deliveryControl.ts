export const REQUIRED_REVENUE_DENSITY_MAN_YEN_PER_HOUR = 4.08;
export const MEMBER_DELIVERY_HOURS_PER_MONTH = 204;
export const TEAM_DELIVERY_HOURS_PER_MONTH = 816;
export const MEMBER_DELIVERY_HOURS_PER_WEEK =
  MEMBER_DELIVERY_HOURS_PER_MONTH / (52 / 12);
const THRESHOLD_EPSILON = 1e-6;

export type DeliverySeverity = "green" | "yellow" | "red" | "unknown";

export interface DeliveryTaskRecord {
  id: string;
  url: string;
  name: string;
  status: string | null;
  assignees: string[];
  projectIds: string[];
  budgetHours: number | null;
  actualHours: number | null;
  remainingHours: number | null;
  evidenceUrl: string | null;
  completionCriteria: string | null;
  reuseType: string | null;
  evalPercent: number | null;
  blocker: string | null;
  blockerStartedAt: string | null;
  due: string | null;
  forecastCompletionDate: string | null;
  progressUpdatedDate: string | null;
  lastEditedTime: string | null;
}

export interface DeliveryProjectRecord {
  id: string;
  url: string;
  name: string;
  status: string | null;
  team: string | null;
  owners: string[];
  contractAmountManYen: number | null;
  allowedHours: number | null;
  actualHours: number | null;
  remainingHours: number | null;
  forecastHours: number | null;
  effortBurnPercent: number | null;
  outcomeProgressPercent: number | null;
  burnGapPoints: number | null;
  revenueDensityManYenPerHour: number | null;
  currentHealth: string | null;
  internalDeadline: string | null;
  ttfvDays: number | null;
  evalPassPercent: number | null;
  nextPhaseStatus: string | null;
  nextPhaseAmountManYen: number | null;
  nextPhaseProposalDue: string | null;
}

export interface DeliverySnapshot {
  today: string;
  projects: DeliveryProjectRecord[];
  tasks: DeliveryTaskRecord[];
}

export interface ProjectAssessment {
  project: DeliveryProjectRecord;
  severity: DeliverySeverity;
  healthLabel: "🟢 Green" | "🟡 Yellow" | "🔴 Red" | "⚪ 未評価";
  allowedHours: number | null;
  actualHours: number | null;
  remainingHours: number | null;
  forecastHours: number | null;
  forecastRatioPercent: number | null;
  effortBurnPercent: number | null;
  outcomeProgressPercent: number | null;
  burnGapPoints: number | null;
  revenueDensityManYenPerHour: number | null;
  maxBlockerAgeHours: number | null;
  blockerTasks: DeliveryTaskRecord[];
  remainingFteMonths: number | null;
  teamMonthlyCapacityPercent: number | null;
  missingInputs: string[];
  reasons: string[];
  nextAction: string;
}

export interface AssigneeUpdateGap {
  assignee: string;
  tasks: Array<{ task: DeliveryTaskRecord; missing: string[] }>;
}

export interface AssigneeCapacity {
  assignee: string;
  remainingHours: number;
  weeklyFte: number;
}

export interface ExpansionReminder {
  project: DeliveryProjectRecord;
  assessment: ProjectAssessment;
  gate: 50 | 70 | 85;
  targetPhase: string;
  nextAction: string;
}

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const finiteOrNull = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const maxSeverity = (a: DeliverySeverity, b: DeliverySeverity): DeliverySeverity => {
  const rank: Record<DeliverySeverity, number> = {
    unknown: 0,
    green: 1,
    yellow: 2,
    red: 3
  };
  return rank[b] > rank[a] ? b : a;
};

const hoursSince = (iso: string | null, now: Date): number | null => {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (now.getTime() - ms) / 3_600_000);
};

const projectTasks = (
  projectId: string,
  tasks: DeliveryTaskRecord[]
): DeliveryTaskRecord[] => tasks.filter((task) => task.projectIds.includes(projectId));

const sumKnown = (
  tasks: DeliveryTaskRecord[],
  pick: (task: DeliveryTaskRecord) => number | null
): number | null => {
  const values = tasks.map(pick).filter((value): value is number => value != null);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
};

export const isClosedDeliveryTask = (status: string | null): boolean =>
  /完了|done|closed|completed|resolved|終了|クローズ|中止|cancel/iu.test(status ?? "");

export const isActiveDeliveryTask = (status: string | null): boolean =>
  !isClosedDeliveryTask(status) &&
  !/backlog|ready|未着手/iu.test(status ?? "") &&
  Boolean(status);

export const isDailyUpdateTask = (status: string | null): boolean =>
  /doing|レビュー|他者ボール|ペンディング|pending/iu.test(status ?? "") && !isClosedDeliveryTask(status);

export function assessDeliveryProject(
  project: DeliveryProjectRecord,
  tasks: DeliveryTaskRecord[],
  now = new Date()
): ProjectAssessment {
  const relatedTasks = projectTasks(project.id, tasks);
  const activeTasks = relatedTasks.filter((task) => isActiveDeliveryTask(task.status));
  const taskActual = sumKnown(relatedTasks, (task) => task.actualHours);
  const taskRemaining = sumKnown(activeTasks, (task) => task.remainingHours);
  const taskActualIncomplete = activeTasks.some((task) => task.actualHours == null);
  const taskRemainingIncomplete = activeTasks.some((task) => task.remainingHours == null);
  const taskBudgetIncomplete = activeTasks.some((task) => task.budgetHours == null);
  const actualHours = taskActualIncomplete
    ? null
    : finiteOrNull(project.actualHours) ?? taskActual;
  const remainingHours = taskRemainingIncomplete
    ? null
    : finiteOrNull(project.remainingHours) ?? taskRemaining;
  const allowedHours =
    (project.allowedHours != null && project.allowedHours > 0 ? project.allowedHours : null) ??
    (project.contractAmountManYen != null
      ? project.contractAmountManYen / REQUIRED_REVENUE_DENSITY_MAN_YEN_PER_HOUR
      : null);
  const forecastHours =
    taskActualIncomplete || taskRemainingIncomplete
      ? null
      : finiteOrNull(project.forecastHours) ??
    (actualHours != null && remainingHours != null ? actualHours + remainingHours : null);
  const effortBurnPercent =
    actualHours != null && allowedHours != null && allowedHours > 0
      ? (actualHours / allowedHours) * 100
      : null;
  const outcomeProgressPercent = finiteOrNull(project.outcomeProgressPercent);
  const burnGapPoints =
    (effortBurnPercent != null && outcomeProgressPercent != null
      ? effortBurnPercent - outcomeProgressPercent
      : null);
  const forecastRatioPercent =
    forecastHours != null && allowedHours != null && allowedHours > 0
      ? (forecastHours / allowedHours) * 100
      : null;
  const revenueDensityManYenPerHour =
    (project.contractAmountManYen != null && forecastHours != null && forecastHours > 0
      ? project.contractAmountManYen / forecastHours
      : forecastHours != null && forecastHours > 0
        ? finiteOrNull(project.revenueDensityManYenPerHour)
        : null);

  const blockerTasks = activeTasks.filter((task) => Boolean(task.blocker?.trim()));
  const blockerAges = blockerTasks
    .map((task) => hoursSince(task.blockerStartedAt, now))
    .filter((value): value is number => value != null);
  const maxBlockerAgeHours = blockerAges.length > 0 ? Math.max(...blockerAges) : null;

  const missingInputs: string[] = [];
  if (project.contractAmountManYen == null && !(project.allowedHours != null && project.allowedHours > 0)) {
    missingInputs.push("契約金額/許容総工数");
  }
  if (taskBudgetIncomplete) missingInputs.push("Active Task工数予算");
  if (actualHours == null) missingInputs.push("Active Task実績工数");
  if (remainingHours == null) missingInputs.push("Active Task残工数");
  if (outcomeProgressPercent == null) missingInputs.push("成果進捗");
  if (blockerTasks.some((task) => !task.blockerStartedAt)) {
    missingInputs.push("ブロッカー発生日");
  }

  let severity: DeliverySeverity = "unknown";
  const reasons: string[] = [];
  let evaluated = false;

  if (forecastRatioPercent != null) {
    evaluated = true;
    if (forecastRatioPercent > 110 + THRESHOLD_EPSILON) {
      severity = maxSeverity(severity, "red");
      reasons.push(`Forecast ${round(forecastRatioPercent)}%（許容比110%超）`);
    } else if (forecastRatioPercent > 100 + THRESHOLD_EPSILON) {
      severity = maxSeverity(severity, "yellow");
      reasons.push(`Forecast ${round(forecastRatioPercent)}%（許容超過）`);
    } else {
      severity = maxSeverity(severity, "green");
    }
  }

  if (burnGapPoints != null) {
    evaluated = true;
    if (burnGapPoints > 20) {
      severity = maxSeverity(severity, "red");
      reasons.push(`Burn Gap +${round(burnGapPoints)}pt（20pt超）`);
    } else if (burnGapPoints >= 10) {
      severity = maxSeverity(severity, "yellow");
      reasons.push(`Burn Gap +${round(burnGapPoints)}pt`);
    } else {
      severity = maxSeverity(severity, "green");
    }
  }

  if (maxBlockerAgeHours != null) {
    evaluated = true;
    if (maxBlockerAgeHours > 48) {
      severity = maxSeverity(severity, "red");
      reasons.push(`Blocker ${round(maxBlockerAgeHours, 0)}h（48h超）`);
    } else if (maxBlockerAgeHours >= 24) {
      severity = maxSeverity(severity, "yellow");
      reasons.push(`Blocker ${round(maxBlockerAgeHours, 0)}h`);
    } else {
      severity = maxSeverity(severity, "green");
    }
  }

  const incompleteGreenJudgement =
    forecastRatioPercent == null ||
    burnGapPoints == null ||
    blockerTasks.some((task) => !task.blockerStartedAt);
  if (!evaluated || (severity === "green" && incompleteGreenJudgement)) {
    severity = "unknown";
    reasons.length = 0;
  }
  if (reasons.length === 0 && severity === "green") reasons.push("Forecast・Burn・Blockerは基準内");
  if (severity === "unknown") reasons.push(`算出不足: ${missingInputs.join("、") || "判定値"}`);

  const healthLabel =
    severity === "red"
      ? "🔴 Red"
      : severity === "yellow"
        ? "🟡 Yellow"
        : severity === "green"
          ? "🟢 Green"
          : "⚪ 未評価";
  const nextAction =
    severity === "red"
      ? "新規作業を止め、Scope削減・追加見積・期限変更のいずれかを今日決める"
      : severity === "yellow"
        ? "残工数を再見積し、今SprintのCommit/Stretchを組み替える"
        : severity === "green"
          ? "現計画を維持し、次Phaseの仮説・提案準備を前倒しする"
          : "工数予算・残工数・成果進捗を更新し、着地予測を確定する";

  return {
    project,
    severity,
    healthLabel,
    allowedHours,
    actualHours,
    remainingHours,
    forecastHours,
    forecastRatioPercent,
    effortBurnPercent,
    outcomeProgressPercent,
    burnGapPoints,
    revenueDensityManYenPerHour,
    maxBlockerAgeHours,
    blockerTasks,
    remainingFteMonths:
      remainingHours != null ? remainingHours / MEMBER_DELIVERY_HOURS_PER_MONTH : null,
    teamMonthlyCapacityPercent:
      remainingHours != null ? (remainingHours / TEAM_DELIVERY_HOURS_PER_MONTH) * 100 : null,
    missingInputs,
    reasons,
    nextAction
  };
}

export function assessSnapshot(
  snapshot: DeliverySnapshot,
  now = new Date()
): ProjectAssessment[] {
  return snapshot.projects.map((project) =>
    assessDeliveryProject(project, snapshot.tasks, now)
  );
}

export function missingTaskUpdateFields(
  task: DeliveryTaskRecord,
  today: string
): string[] {
  if (!isDailyUpdateTask(task.status)) return [];
  const missing: string[] = [];
  if (task.progressUpdatedDate !== today) missing.push("進捗更新日");
  if (task.budgetHours == null) missing.push("工数予算");
  if (task.actualHours == null) missing.push("実績工数");
  if (task.remainingHours == null) missing.push("残工数");
  if (!task.completionCriteria?.trim()) missing.push("完了条件");
  if (!task.evidenceUrl) missing.push("Evidence");
  if (task.blocker?.trim() && !task.blockerStartedAt) missing.push("ブロッカー発生日");
  return missing;
}

export function collectAssigneeUpdateGaps(
  snapshot: DeliverySnapshot
): AssigneeUpdateGap[] {
  const grouped = new Map<string, AssigneeUpdateGap["tasks"]>();
  for (const task of snapshot.tasks) {
    const missing = missingTaskUpdateFields(task, snapshot.today);
    if (missing.length === 0) continue;
    for (const assignee of task.assignees) {
      const list = grouped.get(assignee) ?? [];
      list.push({ task, missing });
      grouped.set(assignee, list);
    }
  }
  return [...grouped.entries()]
    .map(([assignee, tasks]) => ({ assignee, tasks }))
    .sort((a, b) => a.assignee.localeCompare(b.assignee, "ja"));
}

export function calculateAssigneeCapacity(
  snapshot: DeliverySnapshot
): AssigneeCapacity[] {
  const hours = new Map<string, number>();
  for (const task of snapshot.tasks) {
    if (!isActiveDeliveryTask(task.status) || task.remainingHours == null || task.assignees.length === 0) continue;
    const share = task.remainingHours / task.assignees.length;
    for (const assignee of task.assignees) {
      hours.set(assignee, (hours.get(assignee) ?? 0) + share);
    }
  }
  return [...hours.entries()]
    .map(([assignee, remainingHours]) => ({
      assignee,
      remainingHours: round(remainingHours),
      weeklyFte: round(remainingHours / MEMBER_DELIVERY_HOURS_PER_WEEK, 2)
    }))
    .sort((a, b) => b.weeklyFte - a.weeklyFte || a.assignee.localeCompare(b.assignee, "ja"));
}

const phaseRank = (phase: string | null): number => {
  const normalized = phase ?? "";
  if (/契約済/.test(normalized)) return 5;
  if (/商談中/.test(normalized)) return 4;
  if (/提案済/.test(normalized)) return 3;
  if (/提案準備/.test(normalized)) return 2;
  if (/仮説整理/.test(normalized)) return 1;
  return 0;
};

export function collectExpansionReminders(
  assessments: ProjectAssessment[]
): ExpansionReminder[] {
  const reminders: ExpansionReminder[] = [];
  for (const assessment of assessments) {
    const burn = assessment.effortBurnPercent;
    if (burn == null) continue;
    const rank = phaseRank(assessment.project.nextPhaseStatus);
    let gate: 50 | 70 | 85 | null = null;
    let targetRank = 0;
    let targetPhase = "";
    let nextAction = "";
    if (burn >= 85 && rank < 4) {
      gate = 85;
      targetRank = 4;
      targetPhase = "商談中";
      nextAction = "予算・契約条件を調整し、次Phaseの開始判断を確定する";
    } else if (burn >= 70 && rank < 2) {
      gate = 70;
      targetRank = 2;
      targetPhase = "提案準備";
      nextAction = "新機能追加を止め、次Phaseの正式提案を開始する";
    } else if (burn >= 50 && rank < 1) {
      gate = 50;
      targetRank = 1;
      targetPhase = "仮説整理";
      nextAction = "次Phase仮説を顧客課題・効果・概算金額まで整理する";
    }
    if (gate && rank < targetRank) {
      reminders.push({
        project: assessment.project,
        assessment,
        gate,
        targetPhase,
        nextAction
      });
    }
  }
  return reminders;
}

const band = (value: number | null, yellow: number, red: number): string => {
  if (value == null) return "na";
  if (value > red + THRESHOLD_EPSILON) return "red";
  if (value >= yellow) return "yellow";
  return "green";
};

export function deliveryAlertFingerprint(assessment: ProjectAssessment): string {
  return [
    assessment.severity,
    band(assessment.forecastRatioPercent, 100 + THRESHOLD_EPSILON, 110),
    band(assessment.burnGapPoints, 10, 20),
    band(assessment.maxBlockerAgeHours, 24, 48),
    assessment.blockerTasks.map((task) => task.id).sort().join(",")
  ].join("|");
}

const formatNumber = (value: number | null, suffix = ""): string =>
  value == null ? "-" : `${round(value).toLocaleString("ja-JP")}${suffix}`;

const slackLink = (url: string, label: string): string =>
  url ? `<${url}|${label.replace(/[<>|]/g, "")}>` : label;

export function renderDeliveryDigest(
  snapshot: DeliverySnapshot,
  assessments: ProjectAssessment[]
): string {
  const counts = { green: 0, yellow: 0, red: 0, unknown: 0 };
  for (const assessment of assessments) counts[assessment.severity] += 1;
  const totalContract = assessments.reduce(
    (sum, item) => sum + (item.project.contractAmountManYen ?? 0),
    0
  );
  const totalRemaining = assessments.reduce(
    (sum, item) => sum + (item.remainingHours ?? 0),
    0
  );
  const lines = [
    `📊 *DELIVERY CONTROL｜${snapshot.today.slice(5).replace("-", "/")}*`,
    `🟢 ${counts.green}　🟡 ${counts.yellow}　🔴 ${counts.red}　⚪ ${counts.unknown}`,
    `契約総額 ${formatNumber(totalContract, "万円")}｜残工数 ${formatNumber(totalRemaining, "h")} = ${round(totalRemaining / MEMBER_DELIVERY_HOURS_PER_MONTH, 2)} FTE月（TeamK月次Capacityの${round((totalRemaining / TEAM_DELIVERY_HOURS_PER_MONTH) * 100)}%）`,
    ""
  ];
  for (const item of assessments) {
    lines.push(
      `${item.healthLabel} ${slackLink(item.project.url, item.project.name)}｜Forecast ${formatNumber(item.forecastHours, "h")}/${formatNumber(item.allowedHours, "h")} (${formatNumber(item.forecastRatioPercent, "%")})｜Burn Gap ${item.burnGapPoints == null ? "-" : `${item.burnGapPoints >= 0 ? "+" : ""}${round(item.burnGapPoints)}pt`}｜残 ${formatNumber(item.remainingFteMonths, " FTE月")}`,
      `　状態: ${item.reasons.join(" / ")}｜次: ${item.nextAction}`
    );
  }
  return lines.join("\n").slice(0, 38_000);
}

export function renderUpdateReminder(
  snapshot: DeliverySnapshot,
  gaps: AssigneeUpdateGap[],
  mentions: Record<string, string>
): string {
  const lines = [
    `📝 *18:30 Delivery更新リマインド｜${snapshot.today.slice(5).replace("-", "/")}*`,
    "未更新の項目だけを担当者別にまとめました。更新済みのタスクは対象外です。"
  ];
  for (const gap of gaps) {
    const mention = mentions[gap.assignee] ? `<@${mentions[gap.assignee]}>` : gap.assignee;
    lines.push("", `*${mention}*`);
    for (const item of gap.tasks.slice(0, 8)) {
      lines.push(`• ${slackLink(item.task.url, item.task.name)}｜不足: ${item.missing.join("・")}`);
    }
    if (gap.tasks.length > 8) lines.push(`• ほか ${gap.tasks.length - 8}件（Notionのdoing一覧を確認）`);
  }
  lines.push("", "次: Notionを更新すると、翌日のForecast・FTE・Burn Gapへ自動反映されます。");
  return lines.join("\n").slice(0, 38_000);
}

export function renderDeliveryAlerts(alerts: ProjectAssessment[]): string {
  const lines = ["🚨 *DELIVERY ALERT｜軌道修正が必要です*"];
  for (const item of alerts) {
    lines.push(
      "",
      `${item.healthLabel} ${slackLink(item.project.url, item.project.name)}`,
      `状態: ${item.reasons.join(" / ")}`,
      `次: ${item.nextAction}`
    );
    for (const task of item.blockerTasks.slice(0, 3)) {
      lines.push(`• Blocker: ${slackLink(task.url, task.name)}｜${task.blocker}`);
    }
  }
  return lines.join("\n").slice(0, 38_000);
}

export function renderExpansionReminders(reminders: ExpansionReminder[]): string {
  const lines = ["🌱 *NEXT PHASE GATE｜案件拡張の準備*"];
  for (const item of reminders) {
    lines.push(
      "",
      `${slackLink(item.project.url, item.project.name)}｜工数消化 ${formatNumber(item.assessment.effortBurnPercent, "%")}（${item.gate}% Gate）`,
      `状態: 次Phase=${item.project.nextPhaseStatus ?? "未整理"}｜目標=${item.targetPhase}`,
      `次: ${item.nextAction}`
    );
  }
  return lines.join("\n").slice(0, 38_000);
}

export function renderPortfolioSummary(
  snapshot: DeliverySnapshot,
  assessments: ProjectAssessment[],
  capacities: AssigneeCapacity[]
): string {
  const totalContract = assessments.reduce(
    (sum, item) => sum + (item.project.contractAmountManYen ?? 0),
    0
  );
  const totalForecast = assessments.reduce((sum, item) => sum + (item.forecastHours ?? 0), 0);
  const density = totalForecast > 0 ? totalContract / totalForecast : null;
  const lines = [
    `📈 *WEEKLY DELIVERY PORTFOLIO｜${snapshot.today}*`,
    `契約 ${formatNumber(totalContract, "万円")}｜Forecast ${formatNumber(totalForecast, "h")}｜Portfolio売上密度 ${formatNumber(density, "万円/h")}（基準 ${REQUIRED_REVENUE_DENSITY_MAN_YEN_PER_HOUR}）`,
    "",
    "*案件Health / 次Phase*"
  ];
  for (const item of assessments) {
    lines.push(
      `• ${item.healthLabel} ${slackLink(item.project.url, item.project.name)}｜残 ${formatNumber(item.remainingFteMonths, " FTE月")}｜次Phase ${item.project.nextPhaseStatus ?? "未整理"}${item.project.nextPhaseAmountManYen != null ? ` ${formatNumber(item.project.nextPhaseAmountManYen, "万円")}` : ""}`
    );
  }
  lines.push("", "*担当者別・次週FTE需要*（残工数÷週47h）");
  for (const item of capacities) {
    const icon = item.weeklyFte > 1.1 ? "🔴" : item.weeklyFte > 0.9 ? "🟡" : "🟢";
    lines.push(`• ${icon} ${item.assignee}: ${formatNumber(item.remainingHours, "h")} / ${item.weeklyFte.toFixed(2)} FTE`);
  }
  lines.push("", "次: Red/過負荷から先に、Scope・担当・期限・追加見積をPlanningで決めます。");
  return lines.join("\n").slice(0, 38_000);
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function renderDeliveryDashboardHtml(
  snapshot: DeliverySnapshot,
  assessments: ProjectAssessment[]
): string {
  const cards = assessments
    .slice(0, 8)
    .map((item) => {
      const cls = item.severity;
      const forecast = item.forecastRatioPercent == null ? "-" : `${round(item.forecastRatioPercent)}%`;
      const burn = item.burnGapPoints == null ? "-" : `${item.burnGapPoints >= 0 ? "+" : ""}${round(item.burnGapPoints)}pt`;
      const fte = item.remainingFteMonths == null ? "-" : `${round(item.remainingFteMonths, 2)} FTE月`;
      return `<section class="card ${cls}">
        <div class="card-head"><span class="dot"></span><h2>${escapeHtml(item.project.name)}</h2><span class="health">${escapeHtml(item.healthLabel)}</span></div>
        <div class="metrics">
          <div><small>FORECAST / ALLOWED</small><strong>${escapeHtml(formatNumber(item.forecastHours, "h"))} / ${escapeHtml(formatNumber(item.allowedHours, "h"))}</strong><em>${escapeHtml(forecast)}</em></div>
          <div><small>BURN GAP</small><strong>${escapeHtml(burn)}</strong><em>工数 − 成果</em></div>
          <div><small>REMAINING FTE</small><strong>${escapeHtml(fte)}</strong><em>${escapeHtml(formatNumber(item.remainingHours, "h"))}</em></div>
          <div><small>REVENUE DENSITY</small><strong>${escapeHtml(formatNumber(item.revenueDensityManYenPerHour, "万円/h"))}</strong><em>基準 ${REQUIRED_REVENUE_DENSITY_MAN_YEN_PER_HOUR}</em></div>
        </div>
        <div class="state">${escapeHtml(item.reasons.join(" / "))}</div>
        <div class="action"><span>NEXT</span>${escapeHtml(item.nextAction)}</div>
      </section>`;
    })
    .join("");
  const counts = { green: 0, yellow: 0, red: 0, unknown: 0 };
  for (const item of assessments) counts[item.severity] += 1;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#07111f;color:#eaf2ff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif}.wrap{width:1400px;padding:54px 58px 48px;background:radial-gradient(circle at 80% -20%,#123d59 0,transparent 42%),linear-gradient(145deg,#07111f,#0a1728)}header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:32px}.eyebrow{font-size:14px;letter-spacing:.22em;color:#53e6c6;font-weight:800}.title{font-size:42px;line-height:1;font-weight:900;margin-top:10px}.date{font-size:18px;color:#9bb0c8}.score{font-size:22px;font-weight:900;margin-top:8px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{border:1px solid rgba(255,255,255,.13);background:rgba(9,24,40,.84);border-radius:18px;padding:23px 24px 20px;box-shadow:0 16px 42px rgba(0,0,0,.22)}.card.red{border-color:rgba(255,83,102,.62)}.card.yellow{border-color:rgba(255,193,66,.58)}.card.green{border-color:rgba(58,224,176,.48)}.card-head{display:flex;align-items:center;gap:11px}.card-head h2{font-size:21px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0;flex:1}.health{font-size:15px;font-weight:800}.dot{width:10px;height:10px;border-radius:50%;background:#7f94aa}.red .dot{background:#ff5366}.yellow .dot{background:#ffc142}.green .dot{background:#3ae0b0}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0 14px}.metrics div{padding:12px 13px;border-radius:11px;background:rgba(255,255,255,.045)}small{display:block;color:#8298b1;font-size:10px;letter-spacing:.08em;font-weight:800}strong{display:block;font-size:19px;margin-top:4px}em{display:block;color:#9cb0c4;font-style:normal;font-size:11px;margin-top:2px}.state{font-size:13px;color:#becce0;min-height:36px}.action{border-top:1px solid rgba(255,255,255,.09);margin-top:12px;padding-top:12px;font-size:13px;line-height:1.45}.action span{color:#53e6c6;font-size:10px;letter-spacing:.12em;font-weight:900;margin-right:9px}footer{display:flex;justify-content:space-between;color:#8196ad;font-size:12px;margin-top:26px}.brand{letter-spacing:.12em;font-weight:800;color:#b9c9da}.render-ready{position:absolute;width:0;height:0;overflow:hidden}</style></head><body><main id="root" class="wrap"><svg class="recharts-surface render-ready"></svg><header><div><div class="eyebrow">TEAMK · ECONOMICS × EXECUTION</div><div class="title">DELIVERY CONTROL</div></div><div style="text-align:right"><div class="date">${escapeHtml(snapshot.today)}</div><div class="score">🟢 ${counts.green}　🟡 ${counts.yellow}　🔴 ${counts.red}　⚪ ${counts.unknown}</div></div></header><div class="grid">${cards || '<div class="card unknown">対象案件なし</div>'}</div><footer><span>Forecast / Burn Gap / Blocker / FTE を Notion 実績から自動判定</span><span class="brand">ALOHA_CAT · DELIVERY OS</span></footer></main></body></html>`;
}
