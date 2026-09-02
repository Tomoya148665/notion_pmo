import assert from "node:assert/strict";
import { classifyCell, progressUnits, type ScrumTable } from "../src/s19Scrum";
import { assessWeeklyCountPace, type KpiRowContext } from "../src/kpiRisk";

assert.equal(classifyCell("1").kind, "partial", "単独数値は実績として扱う");
assert.equal(progressUnits("1"), 1, "単独数値1は1回分");
assert.equal(progressUnits("2"), 2, "単独数値2は2回分");
assert.equal(progressUnits("2/6"), 2, "分数形式は分子を実施回数にする");
assert.equal(progressUnits("○"), 1, "達成記号は1回分");

const table: ScrumTable = {
  tableId: "test",
  headers: ["メンバー", "KPI", "8/1", "8/2", "8/3", "8/4", "8/5", "8/6", "8/7"],
  dateColumns: [2, 3, 4, 5, 6, 7, 8].map((index, day) => ({ index, month: 8, day: day + 1, label: `8/${day + 1}` })),
  rows: []
};
const row: KpiRowContext = {
  member: "古鉄",
  itemKey: "talk-practice",
  kpiText: "アプリでみんなで話す練習 6回",
  cadence: { kind: "weekly_count", countPerWeek: 6, countUnit: "回", confidence: "high", rationale: "test" },
  cells: ["古鉄", "アプリでみんなで話す練習 6回", "", "1", "", "", "", "", ""]
};
const risk = assessWeeklyCountPace(row, table.dateColumns, 3);
assert.match(risk?.detail ?? "", /現在1回実施済み/, "数値1を0回ではなく1回としてペース表示する");

console.log("KPI numeric-progress tests passed");
