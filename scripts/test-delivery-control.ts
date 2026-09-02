import assert from "node:assert/strict";
import {
  assessDeliveryProject,
  calculateAssigneeCapacity,
  collectAssigneeUpdateGaps,
  collectExpansionReminders,
  deliveryAlertFingerprint,
  renderDeliveryDigest,
  type DeliveryProjectRecord,
  type DeliverySnapshot,
  type DeliveryTaskRecord
} from "../src/deliveryControl";

const project = (
  overrides: Partial<DeliveryProjectRecord> = {}
): DeliveryProjectRecord => ({
  id: "project-1",
  url: "https://www.notion.so/project-1",
  name: "案件A",
  status: "dev進行中",
  team: "TeamK",
  owners: ["古鉄朋也"],
  contractAmountManYen: 408,
  allowedHours: 100,
  actualHours: 40,
  remainingHours: 40,
  forecastHours: 80,
  effortBurnPercent: 40,
  outcomeProgressPercent: 40,
  burnGapPoints: 0,
  revenueDensityManYenPerHour: 5.1,
  currentHealth: null,
  internalDeadline: "2026-09-30",
  ttfvDays: 3,
  evalPassPercent: 90,
  nextPhaseStatus: "未整理",
  nextPhaseAmountManYen: null,
  nextPhaseProposalDue: null,
  ...overrides
});

const task = (overrides: Partial<DeliveryTaskRecord> = {}): DeliveryTaskRecord => ({
  id: "task-1",
  url: "https://www.notion.so/task-1",
  name: "E2Eデモを通す",
  status: "doing(60%)",
  assignees: ["古鉄朋也"],
  projectIds: ["project-1"],
  budgetHours: 16,
  actualHours: 8,
  remainingHours: 8,
  evidenceUrl: "https://example.com/evidence",
  completionCriteria: "実データでE2Eが成功する",
  reuseType: "Standard",
  evalPercent: 90,
  blocker: null,
  blockerStartedAt: null,
  due: "2026-09-03",
  forecastCompletionDate: "2026-09-03",
  progressUpdatedDate: "2026-09-01",
  lastEditedTime: "2026-09-01T09:00:00+09:00",
  ...overrides
});

const now = new Date("2026-09-01T03:00:00.000Z");

const green = assessDeliveryProject(project(), [], now);
assert.equal(green.severity, "green");
assert.equal(green.remainingFteMonths, 40 / 204);
assert.equal(green.teamMonthlyCapacityPercent, (40 / 816) * 100);

const yellow = assessDeliveryProject(
  project({ forecastHours: 110, effortBurnPercent: 60, outcomeProgressPercent: 40, burnGapPoints: 20 }),
  [
    task({
      blocker: "レビュー待ち",
      blockerStartedAt: "2026-08-30T12:00:00.000Z"
    })
  ],
  new Date("2026-09-01T12:00:00.000Z")
);
assert.equal(yellow.severity, "yellow", "110% / 20pt / 48h exactly are Yellow boundaries");

const red = assessDeliveryProject(
  project({ forecastHours: 111, effortBurnPercent: 61, outcomeProgressPercent: 40, burnGapPoints: 21 }),
  [
    task({
      blocker: "顧客データ待ち",
      blockerStartedAt: "2026-08-29T12:00:00.000Z"
    })
  ],
  new Date("2026-09-01T13:00:00.000Z")
);
assert.equal(red.severity, "red");
assert.match(red.nextAction, /新規作業を止め/);

const unknown = assessDeliveryProject(
  project({ outcomeProgressPercent: null, burnGapPoints: null }),
  [],
  now
);
assert.equal(unknown.severity, "unknown", "missing outcome must not be reported Green");

const snapshot: DeliverySnapshot = {
  today: "2026-09-01",
  projects: [project()],
  tasks: [
    task(),
    task({
      id: "task-2",
      name: "更新不足",
      progressUpdatedDate: "2026-08-31",
      actualHours: null,
      remainingHours: null,
      evidenceUrl: null,
      assignees: ["古鉄朋也", "松田直樹"]
    })
  ]
};
const gaps = collectAssigneeUpdateGaps(snapshot);
assert.equal(gaps.length, 2);
assert.deepEqual(
  gaps.find((gap) => gap.assignee === "古鉄朋也")?.tasks[0]?.missing,
  ["進捗更新日", "実績工数", "残工数", "Evidence"]
);

const capacitySnapshot: DeliverySnapshot = {
  today: "2026-09-01",
  projects: [project()],
  tasks: [task({ remainingHours: 94.1538461538, assignees: ["A", "B"] })]
};
const capacity = calculateAssigneeCapacity(capacitySnapshot);
assert.equal(capacity.length, 2);
assert.equal(capacity[0].weeklyFte, 1);

const expansionAssessment = assessDeliveryProject(
  project({ actualHours: 86, remainingHours: 14, forecastHours: 100, effortBurnPercent: 86, nextPhaseStatus: "提案準備" }),
  [],
  now
);
const expansion = collectExpansionReminders([expansionAssessment]);
assert.equal(expansion[0]?.gate, 85);
assert.equal(expansion[0]?.targetPhase, "商談中");

const redLater = assessDeliveryProject(
  red.project,
  [
    task({
      blocker: "顧客データ待ち",
      blockerStartedAt: "2026-08-29T12:00:00.000Z"
    })
  ],
  new Date("2026-09-01T16:00:00.000Z")
);
assert.equal(
  deliveryAlertFingerprint(red),
  deliveryAlertFingerprint(redLater),
  "elapsed blocker time within the same risk band must not re-notify"
);

const digest = renderDeliveryDigest(snapshot, [green]);
assert.match(digest, /DELIVERY CONTROL/);
assert.match(digest, /https:\/\/www\.notion\.so\/project-1/);
assert.match(digest, /次:/);

console.log("Delivery Control tests passed");
