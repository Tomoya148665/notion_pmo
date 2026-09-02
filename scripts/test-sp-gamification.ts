import assert from "node:assert/strict";
import {
  buildCurrentSpSnapshot,
  buildSpDashboardData,
  calculateSprintVelocity,
  buildSpTaskDetailData,
  renderSpDashboardHtml,
  renderSpTaskDetailsHtml,
  type SpDashboardSnapshot,
  type SprintDashboardInfo
} from "../src/spGamification";
import type { SprintDashboardTask } from "../src/notionApi";

const sprint: SprintDashboardInfo = {
  id: "sprint-test",
  name: "s-test",
  start_date: "2026-07-18",
  end_date: "2026-07-24",
  status: "進行中"
};

const tasks: SprintDashboardTask[] = [
  {
    id: "a",
    name: "A",
    sp: 5,
    status: "完了",
    assignees: ["古鉄朋也 / Tomoya Kotetsu"],
    projectNames: ["Project A"],
    completedDate: null,
    lastEditedDate: "2026-07-19"
  },
  {
    id: "b",
    name: "B",
    sp: 3,
    status: "Done",
    assignees: ["北川楓/kitagawakaede"],
    projectNames: ["Project B"],
    completedDate: null,
    lastEditedDate: "2026-07-21"
  },
  {
    id: "c",
    name: "C",
    sp: 2,
    status: "進行中",
    assignees: ["古鉄朋也 / Tomoya Kotetsu"],
    projectNames: ["Project A"],
    completedDate: null,
    lastEditedDate: "2026-07-22"
  },
  {
    id: "shared",
    name: "Shared",
    sp: 4,
    status: "完了",
    assignees: [
      "古鉄朋也 / Tomoya Kotetsu",
      "北川楓/kitagawakaede"
    ],
    projectNames: ["Shared Project"],
    completedDate: "2026-07-23",
    lastEditedDate: "2026-07-24"
  }
];

const capturedAt = "2026-07-24T15:00:00.000Z";
const current = buildCurrentSpSnapshot(
  sprint,
  tasks,
  "2026-07-24",
  capturedAt
);
assert.equal(current.teamCompletedSp, 12);
assert.equal(current.teamDoneSp, 12);
assert.equal(current.teamPlanSp, 14);
assert.deepEqual(
  current.members.map((member) => [member.name, member.completedSp, member.planSp]),
  [
    ["北川楓", 5, 5],
    ["古鉄朋也", 7, 9],
    ["武田良平", 0, 0],
    ["松田直樹", 0, 0]
  ]
);

const previousExact: SpDashboardSnapshot = {
  ...current,
  date: "2026-07-23",
  teamCompletedSp: 9,
  teamDoneSp: 9,
  members: [
    { name: "古鉄朋也 / Tomoya Kotetsu", completedSp: 5, doneSp: 5, planSp: 9 },
    { name: "北川楓/kitagawakaede", completedSp: 4, doneSp: 4, planSp: 5 }
  ]
};
const velocity = calculateSprintVelocity([{ sprint, tasks }]);
assert.equal(velocity?.teamAverageSp, 12);
const data = buildSpDashboardData(
  sprint,
  tasks,
  "2026-07-24",
  { "2026-07-23": previousExact },
  capturedAt,
  { velocity }
);
assert.equal(data.teamTodayDelta, 3);
assert.equal(data.weeklyProjection, 12);
assert.equal(data.projectedSprintTotal, 12);
assert.equal(data.points.find((point) => point.date === "2026-07-19")?.teamSp, 5);
assert.equal(data.points.find((point) => point.date === "2026-07-23")?.source, "exact");
assert.equal(data.points.find((point) => point.date === "2026-07-24")?.teamDailySp, 3);
assert.equal(data.members.length, 4);
assert.equal(data.members[0].name, "古鉄朋也");
assert.equal(data.members[0].rank, 1);
assert.equal(data.members[1].gapToLead, 2);
assert.equal(data.currentDoneSp, 12);
assert.equal(data.projectedDoneRate, 85.7);
assert.equal(data.health, "yellow");
assert.equal(data.historicalVelocitySp, 12);

const html = renderSpDashboardHtml(data, {
  base64: null,
  model: "gpt-image-2",
  error: "test fallback"
});
assert.match(html, /width:1536px;height:1024px/);
assert.match(html, /SPRINT CONTROL/);
assert.match(html, /SPRINT HEALTH/);
assert.match(html, />12 <small>\/ 14 SP<\/small>/);
assert.match(html, /計画線 × 進捗SP実績 × 着地予測/);
assert.match(html, /武田良平/);
assert.match(html, /松田直樹/);
assert.match(html, /SAFE FALLBACK THEME/);

const details = buildSpTaskDetailData(sprint, tasks, "2026-07-24");
assert.equal(details.groups.length, 4);
assert.equal(details.taskCount, 5);
assert.equal(
  details.groups.find((group) => group.memberName === "古鉄朋也")?.rows.length,
  3
);
assert.equal(
  details.groups.find((group) => group.memberName === "北川楓")?.progressSp,
  5
);
assert.equal(details.usedEstimatedDates, false);
const detailsHtml = renderSpTaskDetailsHtml(details, {
  base64: null,
  model: "gpt-image-2"
});
assert.match(detailsHtml, /PLAYER TASK STATUS/);
assert.match(detailsHtml, /Shared Project/);
assert.match(detailsHtml, /Project A/);

console.log("spGamification: all assertions passed");
