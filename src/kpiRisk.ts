// KPIの「重い/要注意/未達成」を機械的に判定する純粋関数群（Notion/LLM/KV呼び出しなし）。
// 入力は呼び出し側で事前に取得済みの ScrumTable・cadence・記憶データ。
import { classifyCell, kpiTextColumnIndex, progressUnits, type ScrumTable } from "./s19Scrum";
import type { KpiCadence } from "./kpiCadence";
import type { KpiMemberMemory } from "./kpiMemory";

export type KpiRiskKind = "not_started_heavy" | "overdue_today" | "broken_promise" | "pace_ok";

export interface KpiRiskItem {
  member: string;
  itemKey: string;
  kpiText: string;
  riskKind: KpiRiskKind;
  detail: string; // 人間可読な理由。ナッジ生成LLMにそのまま渡す
}

/** 1行分のKPI（担当者+KPIテキスト+推論済みcadence+その行の全セル）。 */
export interface KpiRowContext {
  member: string;
  itemKey: string;
  kpiText: string;
  cadence: KpiCadence;
  cells: string[]; // ScrumTable の row.cells（headers/dateColumns とインデックスが対応）
}

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const WEEKDAY_KANJI_TO_NUM: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

/** 日付列ラベル（例:"8/1(土)"）から曜日番号(0=日..6=土)を取る。西暦推定は行わない。 */
function weekdayOfColumnLabel(label: string): number | null {
  const m = label.match(/[（(]([日月火水木金土])[)）]/);
  return m ? WEEKDAY_KANJI_TO_NUM[m[1]] : null;
}

function cellKindAt(cells: string[], colIndex: number): ReturnType<typeof classifyCell>["kind"] {
  return classifyCell(cells[colIndex] ?? "").kind;
}

/** そのセルが「実行された」とみなせるか（達成・部分達成・作業時間記録）。 */
function isAchievedKind(kind: string): boolean {
  return kind === "achieved" || kind === "hours" || kind === "partial";
}

/** 週内回数目標（weekly_count）のペース判定。間に合わない/猶予ゼロなら risk item を返す。 */
export function assessWeeklyCountPace(
  row: KpiRowContext,
  dateColumns: ScrumTable["dateColumns"],
  todayColPos: number
): KpiRiskItem | null {
  const cadence = row.cadence;
  if (cadence.kind !== "weekly_count" || !cadence.countPerWeek || todayColPos < 0) return null;
  const unit = cadence.countUnit ?? "回";
  const totalDays = dateColumns.length;
  const doneSoFar = dateColumns
    .slice(0, todayColPos + 1)
    .reduce((total, c) => total + progressUnits(row.cells[c.index] ?? ""), 0);
  const requiredRemaining = cadence.countPerWeek - doneSoFar;
  if (requiredRemaining <= 0) return null; // 既に週の目標達成
  const daysRemaining = totalDays - todayColPos; // 今日を含む残り日数
  if (requiredRemaining > daysRemaining) {
    return {
      member: row.member,
      itemKey: row.itemKey,
      kpiText: row.kpiText,
      riskKind: "not_started_heavy",
      detail: `週${cadence.countPerWeek}${unit}の目標に対し、残り${daysRemaining}日で${requiredRemaining}${unit}必要（現在のペースでは数学的に達成不可能）。現在${doneSoFar}${unit}実施済み。`
    };
  }
  if (requiredRemaining === daysRemaining) {
    return {
      member: row.member,
      itemKey: row.itemKey,
      kpiText: row.kpiText,
      riskKind: "not_started_heavy",
      detail: `週${cadence.countPerWeek}${unit}の目標に対し、残り${daysRemaining}日で${requiredRemaining}${unit}必要（猶予ゼロ）。現在${doneSoFar}${unit}実施済み。`
    };
  }
  return null; // pace_ok
}

/**
 * 曜日指定（weekdays）の判定。
 * - 過去の指定曜日で未達成 → broken_promise（直近1件のみ。それ以前は繰り返し指摘しない）
 * - 当日が指定曜日で evening 時点なお未達成 → overdue_today
 */
export function assessWeekdaysCadence(
  row: KpiRowContext,
  dateColumns: ScrumTable["dateColumns"],
  todayColPos: number,
  timeSlot: "morning" | "evening" | "realtime"
): KpiRiskItem | null {
  const cadence = row.cadence;
  if (cadence.kind !== "weekdays" || !cadence.weekdays || cadence.weekdays.length === 0 || todayColPos < 0) {
    return null;
  }

  for (let i = todayColPos - 1; i >= 0; i--) {
    const col = dateColumns[i];
    const weekday = weekdayOfColumnLabel(col.label);
    if (weekday == null || !cadence.weekdays.includes(weekday)) continue;
    const kind = cellKindAt(row.cells, col.index);
    if (!isAchievedKind(kind)) {
      return {
        member: row.member,
        itemKey: row.itemKey,
        kpiText: row.kpiText,
        riskKind: "broken_promise",
        detail: `${col.label}（${WEEKDAY_LABELS[weekday]}曜日）にやる予定でしたが、未実施のままです。`
      };
    }
    break; // 直近の指定曜日だけ見る
  }

  if (timeSlot === "evening") {
    const todayCol = dateColumns[todayColPos];
    const todayWeekday = todayCol ? weekdayOfColumnLabel(todayCol.label) : null;
    if (todayCol && todayWeekday != null && cadence.weekdays.includes(todayWeekday)) {
      const kind = cellKindAt(row.cells, todayCol.index);
      if (!isAchievedKind(kind)) {
        return {
          member: row.member,
          itemKey: row.itemKey,
          kpiText: row.kpiText,
          riskKind: "overdue_today",
          detail: `今日（${todayCol.label}）はやる予定の曜日ですが、まだ実施記録がありません。`
        };
      }
    }
  }
  return null;
}

/** 毎日系（daily）の判定。夜時点でまだ今日分が未達成なら overdue_today。 */
export function assessDailyCadence(
  row: KpiRowContext,
  dateColumns: ScrumTable["dateColumns"],
  todayColPos: number,
  timeSlot: "morning" | "evening" | "realtime"
): KpiRiskItem | null {
  if (row.cadence.kind !== "daily" || todayColPos < 0 || timeSlot !== "evening") return null;
  const todayCol = dateColumns[todayColPos];
  if (!todayCol) return null;
  const kind = cellKindAt(row.cells, todayCol.index);
  if (isAchievedKind(kind)) return null;
  return {
    member: row.member,
    itemKey: row.itemKey,
    kpiText: row.kpiText,
    riskKind: "overdue_today",
    detail: `毎日実施する目標ですが、今日（${todayCol.label}）はまだ実施記録がありません。`
  };
}

/**
 * テーブル全体・全行に対してリスク判定を行う。cadence.kind に応じて該当する assess* を呼び分ける。
 * timeSlot: "morning" = 週内回数の遅れのみ検出（着手催促用）/ "evening" = 曜日・毎日の当日遅れも検出 / "realtime" は使わない想定。
 */
export function computeKpiRiskAssessment(
  rows: KpiRowContext[],
  table: ScrumTable,
  todayMD: { month: number; day: number },
  timeSlot: "morning" | "evening"
): KpiRiskItem[] {
  const todayColPos = table.dateColumns.findIndex((c) => c.month === todayMD.month && c.day === todayMD.day);
  if (todayColPos < 0) return [];
  const results: KpiRiskItem[] = [];
  for (const row of rows) {
    const paceRisk = assessWeeklyCountPace(row, table.dateColumns, todayColPos);
    if (paceRisk) {
      results.push(paceRisk);
      continue;
    }
    const weekdayRisk = assessWeekdaysCadence(row, table.dateColumns, todayColPos, timeSlot);
    if (weekdayRisk) {
      results.push(weekdayRisk);
      continue;
    }
    const dailyRisk = assessDailyCadence(row, table.dateColumns, todayColPos, timeSlot);
    if (dailyRisk) results.push(dailyRisk);
  }
  return results;
}

export interface CommitmentCheckResult {
  member: string;
  itemKey: string;
  committedDate: string;
  outcome: "fulfilled" | "broken";
}

/**
 * 過去の pending commitment を、実際のテーブルの該当日セルと突き合わせて確定させる。
 * committedDate が「今日以前（=期日が到来済み）」かつ列がこのテーブルに存在する場合のみ判定する。
 * 未来日の約束はまだ判定しない（実施のしようがないため）。範囲外・未到来の日付は次回以降に判定される。
 */
export function resolvePendingCommitments(
  rows: KpiRowContext[],
  table: ScrumTable,
  memoryByMember: Map<string, KpiMemberMemory>,
  todayColPos: number
): CommitmentCheckResult[] {
  const results: CommitmentCheckResult[] = [];
  const rowsByKey = new Map<string, KpiRowContext>();
  for (const r of rows) rowsByKey.set(r.itemKey, r);

  for (const memory of memoryByMember.values()) {
    for (const c of memory.commitments) {
      if (c.fulfilled !== "pending") continue;
      const md = c.committedDate.match(/^\d{4}-(\d{2})-(\d{2})$/);
      if (!md) continue;
      const month = parseInt(md[1], 10);
      const day = parseInt(md[2], 10);
      const col = table.dateColumns.find((dc) => dc.month === month && dc.day === day);
      if (!col) continue;
      const colPos = table.dateColumns.indexOf(col);
      if (colPos > todayColPos) continue; // 期日がまだ来ていない（判定しない）
      const row = rowsByKey.get(c.itemKey);
      if (!row) continue;
      const kind = cellKindAt(row.cells, col.index);
      results.push({
        member: memory.member,
        itemKey: c.itemKey,
        committedDate: c.committedDate,
        outcome: isAchievedKind(kind) ? "fulfilled" : "broken"
      });
    }
  }
  return results;
}

/**
 * 直近のテーブル群（新しい順）から連続未達成日数を数える。行indexは週替わりでずれるため、
 * itemKey（内容ハッシュ）ではなく、同じ (担当者名, KPIテキスト) の完全一致で行を突き合わせる
 * （itemKeyの元になっているのは同じ文字列なので、テキストが変わっていなければ結果は等価）。
 * cadence.kind="weekdays"の場合は該当曜日のみ、それ以外は全日付列を対象にする。
 * 最初に達成が見つかった時点で打ち切る。
 */
export function computeConsecutiveMiss(
  tablesNewestFirst: ScrumTable[],
  member: string,
  kpiText: string,
  cadence: KpiCadence
): number {
  let streak = 0;
  const normalizedKpiText = kpiText.trim();
  for (const table of tablesNewestFirst) {
    const kpiColIdx = kpiTextColumnIndex(table);
    if (kpiColIdx < 0) continue;
    const row = table.rows.find(
      (r) => r.member === member && (r.cells[kpiColIdx] ?? "").trim() === normalizedKpiText
    );
    if (!row) continue;
    const cols = [...table.dateColumns].reverse(); // 新しい日付から遡る
    for (const col of cols) {
      if (cadence.kind === "weekdays" && cadence.weekdays) {
        const weekday = weekdayOfColumnLabel(col.label);
        if (weekday == null || !cadence.weekdays.includes(weekday)) continue;
      }
      const kind = cellKindAt(row.cells, col.index);
      if (kind === "empty") continue; // 未来日・未記入はカウントしない（達成でも未達成でもない）
      if (isAchievedKind(kind)) return streak;
      streak++;
    }
  }
  return streak;
}

export interface KpiStreakWarning {
  member: string;
  itemKey: string;
  kpiText: string;
  streakLen: number;
}

export interface KpiPraiseEntry {
  member: string;
  achievedCount: number;
  totalCount: number;
  rate: number;
}

/**
 * 当週の行(cadence付き)から、連続未達成ストリークの警告と達成率の高いメンバーの称賛材料を作る。
 * ストリークは tablesNewestFirst（当週+直近の別週があれば含める）を遡って computeConsecutiveMiss で算出。
 * 達成率は当週テーブルの daily/weekdays 系KPIのみ対象（weekly_countは日単位の期待値が無いため対象外）。
 */
export function computeStreaksAndPraise(
  tablesNewestFirst: ScrumTable[],
  currentWeekRows: KpiRowContext[],
  streakThreshold = 3
): { warnings: KpiStreakWarning[]; praise: KpiPraiseEntry[] } {
  const warnings: KpiStreakWarning[] = [];
  for (const row of currentWeekRows) {
    if (row.cadence.kind === "none") continue;
    const streak = computeConsecutiveMiss(tablesNewestFirst, row.member, row.kpiText, row.cadence);
    if (streak >= streakThreshold) {
      warnings.push({ member: row.member, itemKey: row.itemKey, kpiText: row.kpiText, streakLen: streak });
    }
  }

  const byMember = new Map<string, { achieved: number; total: number }>();
  const currentTable = tablesNewestFirst[0];
  if (currentTable) {
    for (const row of currentWeekRows) {
      if (row.cadence.kind !== "daily" && row.cadence.kind !== "weekdays") continue;
      for (const col of currentTable.dateColumns) {
        if (row.cadence.kind === "weekdays" && row.cadence.weekdays) {
          const weekday = weekdayOfColumnLabel(col.label);
          if (weekday == null || !row.cadence.weekdays.includes(weekday)) continue;
        }
        const kind = cellKindAt(row.cells, col.index);
        if (kind === "empty") continue; // 未到来日・未記入はカウントしない
        const entry = byMember.get(row.member) ?? { achieved: 0, total: 0 };
        entry.total++;
        if (isAchievedKind(kind)) entry.achieved++;
        byMember.set(row.member, entry);
      }
    }
  }

  const praise: KpiPraiseEntry[] = [];
  for (const [member, { achieved, total }] of byMember) {
    if (total < 3) continue; // サンプルが少なすぎる場合は称賛対象にしない
    const rate = achieved / total;
    if (rate >= 0.8) praise.push({ member, achievedCount: achieved, totalCount: total, rate });
  }
  praise.sort((a, b) => b.rate - a.rate);

  return { warnings, praise };
}
