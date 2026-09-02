import assert from "node:assert/strict";
import type { MemberCapacity, SprintDashboardTask } from "../src/notionApi";
import type { SprintDashboardInfo } from "../src/spGamification";
import type { SprintPlanBaseline } from "../src/workflow";
import {
  buildSprintPlanningDraft,
  buildSprintScopeDiff,
  renderSprintPlanningDraft,
  renderSprintScopeDiff,
  toSprintPlanTaskSnapshots
} from "../src/sprintPlanningAssistant";

const sprint: SprintDashboardInfo = {
  id: "sprint-1",
  name: "S-20",
  start_date: "2026-09-05",
  end_date: "2026-09-11",
  status: "進行中"
};

const task = (
  id: string,
  budgetHours: number | null,
  overrides: Partial<SprintDashboardTask> = {}
): SprintDashboardTask => ({
  id,
  url: `https://www.notion.so/${id}`,
  name: `Task ${id}`,
  sp: 3,
  status: "Ready",
  assignees: ["A"],
  projectNames: ["Project"],
  priority: "3",
  sprintClass: null,
  budgetHours,
  actualHours: null,
  remainingHours: budgetHours,
  completedDate: null,
  lastEditedDate: null,
  completionCriteria: "Acceptance passed",
  dueDate: "2026-09-10",
  ...overrides
});

const capacities: MemberCapacity[] = [
  { name: "A", totalHours: 40, remainingHours: 40, dailyHours: {} },
  { name: "B", totalHours: 40, remainingHours: 40, dailyHours: {} }
];
const tasks = [
  task("commit-explicit", 50, { sprintClass: "Commit", priority: "5" }),
  task("candidate", 20, { assignees: ["B"], priority: "4" }),
  task("stretch", 10, { assignees: ["B"], sprintClass: "Stretch" }),
  task("missing", null, {
    sp: 0,
    assignees: [],
    completionCriteria: "",
    dueDate: null
  })
];
const draft = buildSprintPlanningDraft(
  sprint,
  tasks,
  capacities,
  [{
    id: "cp",
    name: "Demo",
    kind: null,
    status: null,
    goal: "Demo ready",
    checkpoint: "E2E passes",
    checkpointDue: "2026-09-10",
    taskIds: ["commit-explicit", "candidate"],
    projectNames: ["Project"],
    health: null
  }],
  12
);

assert.equal(draft.totalCapacityHours, 80);
assert.equal(draft.commitLimitHours, 72);
assert.equal(draft.decisions.find((item) => item.task.id === "candidate")?.recommendedClass, "Commit");
assert.equal(draft.decisions.find((item) => item.task.id === "stretch")?.recommendedClass, "Stretch");
assert.ok((draft.qualityCounts.SP ?? 0) >= 1);
assert.ok((draft.qualityCounts["Checkpoint未紐付け"] ?? 0) >= 1);
assert.match(renderSprintPlanningDraft(draft), /SPRINT PLANNING DRAFT/);

const snapshots = toSprintPlanTaskSnapshots(draft);
const baseline: SprintPlanBaseline = {
  sprintId: sprint.id,
  sprintName: sprint.name,
  startDate: sprint.start_date,
  endDate: sprint.end_date,
  lockedAt: "2026-09-05T00:00:00Z",
  lockedBy: "U1",
  totalSp: snapshots.reduce((sum, item) => sum + item.sp, 0),
  totalHours: snapshots.reduce((sum, item) => sum + (item.budgetHours ?? 0), 0),
  tasks: snapshots
};
const current = [
  ...tasks.filter((item) => item.id !== "stretch"),
  task("added", 8, { sp: 5, sprintClass: null })
];
const diff = buildSprintScopeDiff(baseline, current);
assert.equal(diff.added.length, 1);
assert.equal(diff.removed.length, 1);
assert.equal(diff.addedSp, 5);
assert.equal(diff.addedHours, 8);
assert.match(renderSprintScopeDiff(diff), /途中追加 \+5SP/);

console.log("Sprint Planning Assistant tests passed");
