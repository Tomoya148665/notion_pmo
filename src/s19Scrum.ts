// デイリー KPI表の読み取り / 競争実況 / 週次サマリー用フォーマット。
//
// 表は Notion の「シンプルテーブル(table ブロック)」。Notion API で table_row を読む
// （ブラウザ不要なので軽い）。実行担保の判定・記憶・詰めロジックは kpiRisk.ts / kpiMemory.ts /
// kpiCadence.ts / llmAnalyzer.ts 側にある。
import type { AppConfig } from "./config";
import { withOptionalTemperature } from "./openaiCompat";

const NOTION_VERSION = "2022-06-28";

export interface ScrumTable {
  tableId: string;
  headers: string[];
  dateColumns: { index: number; month: number; day: number; label: string }[];
  rows: { member: string; cells: string[] }[];
}

function hyphenateUuid(hex: string): string {
  const h = hex.replace(/-/g, "");
  if (h.length !== 32) return hex;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function extract32(s: string): string | null {
  const m = s.match(/([0-9a-fA-F]{32})/);
  return m ? m[1] : null;
}

async function notionGet(config: AppConfig, path: string): Promise<any> {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    headers: {
      Authorization: `Bearer ${config.notionToken}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
  if (!res.ok) throw new Error(`Notion GET ${path}: ${res.status}`);
  return res.json();
}

function plainText(cell: any): string {
  if (!Array.isArray(cell)) return "";
  return cell.map((t) => (t?.plain_text ?? "")).join("").trim();
}

async function fetchTableRows(config: AppConfig, tableId: string): Promise<any[]> {
  const rows: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : `?page_size=100`;
    const data = await notionGet(config, `blocks/${tableId}/children${qs}`);
    rows.push(...(Array.isArray(data.results) ? data.results : []));
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return rows;
}

// 深さ制限つきで table ブロックの id を集める（カラム/トグル等のネストも辿る）。
async function findTableBlocks(config: AppConfig, blockId: string, depth: number): Promise<string[]> {
  if (depth > 2) return [];
  let out: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : `?page_size=100`;
    let data: any;
    try {
      data = await notionGet(config, `blocks/${blockId}/children${qs}`);
    } catch {
      break;
    }
    for (const b of data.results ?? []) {
      if (b.type === "table") out.push(b.id);
      else if (
        b.has_children &&
        depth < 2 &&
        ["column_list", "column", "toggle", "synced_block", "callout"].includes(b.type)
      ) {
        out = out.concat(await findTableBlocks(config, b.id, depth + 1));
      }
    }
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return out;
}

/** 1つの table ブロックを取得・パース。ヘッダ行の日付( M/D )列を検出する。 */
async function parseTableCandidate(config: AppConfig, tableId: string): Promise<ScrumTable | null> {
  const raw = await fetchTableRows(config, tableId);
  const trows = raw
    .filter((r) => r.type === "table_row")
    .map((r) => (r.table_row.cells ?? []).map(plainText));
  if (trows.length < 2) return null;
  const headers = trows[0];
  const dateColumns = headers
    .map((h: string, i: number) => {
      const m = h.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
      return m ? { index: i, month: parseInt(m[1], 10), day: parseInt(m[2], 10), label: h } : null;
    })
    .filter(Boolean) as ScrumTable["dateColumns"];
  // Notionの表は同一メンバーの2行目以降でメンバー列を空欄にし、見た目上グルーピングしているだけで、
  // 実データは本当に空文字になっている。空欄なら直前の非空メンバー名を引き継ぐ（forward-fill）。
  // 全列が空の区切り行はメンバーだけ引き継いでもKPI列が空のため後続処理で自然に除外される。
  let lastMember = "";
  const rows = trows.slice(1).map((cells) => {
    const rawMember = (cells[0] ?? "").trim();
    if (rawMember) lastMember = rawMember;
    return { member: rawMember || lastMember, cells };
  });
  return { tableId, headers, dateColumns, rows };
}

/**
 * s19/KPI ページの「デイリー KPI」表を Notion API で取得・パース。
 * URL の #fragment(ブロックリンク) を優先。無ければページ内の table ブロックを走査し、
 * 「メンバー」ヘッダを持つ表の中から target(月/日) の列を含む表を選ぶ
 * （週ごとに表が分かれているページ向け。target 省略時は最初に見つかった表を使う）。
 */
export async function fetchScrumTable(
  config: AppConfig,
  s19Url: string,
  target?: { month: number; day: number }
): Promise<ScrumTable | null> {
  const hashIdx = s19Url.indexOf("#");
  if (hashIdx >= 0) {
    const frag = extract32(s19Url.slice(hashIdx));
    if (frag) {
      const id = hyphenateUuid(frag);
      try {
        const blk = await notionGet(config, `blocks/${id}`);
        if (blk?.type === "table") return parseTableCandidate(config, id);
      } catch {
        /* not a table / no access */
      }
    }
  }
  let pageId32: string | null = null;
  try {
    pageId32 = extract32(new URL(s19Url).pathname);
  } catch {
    /* ignore */
  }
  pageId32 = pageId32 || extract32(s19Url);
  if (!pageId32) return null;
  const candidateIds = await findTableBlocks(config, hyphenateUuid(pageId32), 0);
  const parsed: ScrumTable[] = [];
  for (const id of candidateIds) {
    const t = await parseTableCandidate(config, id).catch(() => null);
    if (t) parsed.push(t);
  }
  const memberTables = parsed.filter((t) => t.headers[0]?.includes("メンバー"));
  const pool = memberTables.length ? memberTables : parsed;
  if (target) {
    const match = pool.find((t) => t.dateColumns.some((c) => c.month === target.month && c.day === target.day));
    if (match) return match;
  }
  return pool[0] ?? null;
}

/** ヘッダー名から列indexを引く（行indexがテーブルごとに変わりうるため位置決め打ちしない）。 */
function headerColumnIndex(t: ScrumTable, headerText: string): number {
  return t.headers.findIndex((h) => h.trim() === headerText);
}

/** 「KPI」列（各行の具体的な達成目標テキスト）のindex。見つからなければ -1。 */
export function kpiTextColumnIndex(t: ScrumTable): number {
  return headerColumnIndex(t, "KPI");
}

/** 「スキルカテゴリ」列のindex。見つからなければ -1。 */
export function skillCategoryColumnIndex(t: ScrumTable): number {
  return headerColumnIndex(t, "スキルカテゴリ");
}

/** 表に出てくる担当者名（重複排除、空・区切り行を除く）。 */
export function membersInTable(t: ScrumTable): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of t.rows) {
    if (r.member && !seen.has(r.member)) {
      seen.add(r.member);
      out.push(r.member);
    }
  }
  return out;
}

/** 指定 月/日 に一致する列の index（無ければ null）。 */
export function dateColumnIndex(t: ScrumTable, month: number, day: number): number | null {
  const c = t.dateColumns.find((d) => d.month === month && d.day === day);
  return c ? c.index : null;
}

/** その列がまだ実績未記入の担当者一覧（「予定」のみ・空セルは未記入扱い）。 */
export function emptyMembersForColumn(t: ScrumTable, colIndex: number): string[] {
  const filled = new Set<string>();
  for (const r of t.rows) {
    if (r.member && isResultFilled(r.cells[colIndex] ?? "")) filled.add(r.member);
  }
  return membersInTable(t).filter((m) => !filled.has(m));
}

// ── セル値の分類 ────────────────────────────────────────────────
export type CellKind = "achieved" | "partial" | "failed" | "planned" | "hours" | "empty" | "other";

export interface CellResult {
  kind: CellKind;
  label: string;
}

export function classifyCell(raw: string): CellResult {
  // 絵文字ピッカー由来のセルには U+FE0E/U+FE0F（異体字セレクタ）が付くことがあり、
  // 単一文字の完全一致では見た目が同じでもマッチしなくなるため、先に取り除く。
  const v = raw.trim().replace(/[︎️]/g, "");
  if (!v) return { kind: "empty", label: "未記入" };
  if (/^[○◯〇⚪✓✔☑✅⭕]$/.test(v)) return { kind: "achieved", label: `${v}（達成）` };
  if (/^[×✗✕✖❌]$/.test(v)) return { kind: "failed", label: `${v}（未達成）` };
  if (/^予定/.test(v)) return { kind: "planned", label: `${v}（予定=未達成）` };
  const frm = v.match(/^(\d+)\/(\d+)$/);
  if (frm) {
    const n = parseInt(frm[1], 10), d = parseInt(frm[2], 10);
    const kind: CellKind = n >= d ? "achieved" : "partial";
    return { kind, label: `${v}（${kind === "achieved" ? "達成" : "部分達成"}）` };
  }
  // 週N回のような累計型KPIでは、セルに単独の "1" / "2" と記入して
  // 実施回数を表す運用がある。正の数値は実績として扱う。
  const numeric = v.match(/^(\d+(?:\.\d+)?)$/);
  if (numeric) {
    const n = Number(numeric[1]);
    const kind: CellKind = n > 0 ? "partial" : "failed";
    return { kind, label: `${v}（${n > 0 ? "実績" : "未実施"}）` };
  }
  if (/^\d+(\.\d+)?[Hh時間]/.test(v)) return { kind: "hours", label: `${v}（作業済み）` };
  // "done"/"完了"/"済" を含む自由記述（例: "アポdone"）は達成扱い
  if (/(done|完了|済)/i.test(v)) return { kind: "achieved", label: `${v}（達成）` };
  // パーセント表記: "100%" は達成、"70%" "Arent50%" 等は部分達成
  const pct = v.match(/(\d{1,3})\s*[%％]/);
  if (pct) {
    const n = parseInt(pct[1], 10);
    const kind: CellKind = n >= 100 ? "achieved" : "partial";
    return { kind, label: `${v}（${kind === "achieved" ? "達成" : "部分達成"}）` };
  }
  return { kind: "other", label: v };
}

/**
 * 週N回KPIの実施回数としてセルを加算する値。
 * ○ や「完了」は1回、単独数値と "n/d" は分子の回数として扱う。
 * 数値を単に「記入済み」と数えるのではなく、"2" を2回分として計算する。
 */
export function progressUnits(raw: string): number {
  const v = raw.trim().replace(/[︎️]/g, "");
  const fraction = v.match(/^(\d+)\/(\d+)$/);
  if (fraction) return parseInt(fraction[1], 10);
  const numeric = v.match(/^(\d+(?:\.\d+)?)$/);
  if (numeric) return Math.max(0, Number(numeric[1]));
  const kind = classifyCell(v).kind;
  return kind === "achieved" || kind === "hours" || kind === "partial" ? 1 : 0;
}

/** セルが「実績あり」かどうか（予定・未記入は false）。リマインド判定に使う。 */
export function isResultFilled(raw: string): boolean {
  const k = classifyCell(raw).kind;
  return k !== "empty" && k !== "planned";
}

// ── 競争実況（LLM） ─────────────────────────────────────────────
function buildMemberSummary(t: ScrumTable, targetColIdx: number | null): string {
  const itemColIdx = kpiTextColumnIndex(t);
  const byMember = new Map<string, Array<{ item: string; cell: CellResult }>>();
  for (const r of t.rows) {
    if (!r.member) continue;
    const item = (itemColIdx >= 0 ? r.cells[itemColIdx] : r.cells[1])?.trim() ?? "";
    if (!item) continue;
    const raw = targetColIdx != null ? (r.cells[targetColIdx] ?? "") : "";
    const cell = classifyCell(raw);
    const arr = byMember.get(r.member) ?? [];
    arr.push({ item, cell });
    byMember.set(r.member, arr);
  }
  const lines: string[] = [];
  for (const [name, rows] of byMember) {
    const done = rows.filter(r => r.cell.kind === "achieved" || r.cell.kind === "hours").length;
    const partial = rows.filter(r => r.cell.kind === "partial").length;
    const failed = rows.filter(r => r.cell.kind === "failed").length;
    const planned = rows.filter(r => r.cell.kind === "planned").length;
    const empty = rows.filter(r => r.cell.kind === "empty").length;
    lines.push(
      `\n■ ${name}（目標${rows.length}件 | 達成:${done} 部分:${partial} 未達成:${failed} 予定のみ:${planned} 未記入:${empty}）`
    );
    for (const row of rows) {
      lines.push(`  - ${row.item}: ${row.cell.label}`);
    }
  }
  return lines.join("\n");
}

/** 各メンバーの達成状況を比較する"競争実況"テキストを生成。失敗時は null。 */
export async function buildLivePlay(
  config: AppConfig,
  t: ScrumTable,
  dateLabel: string
): Promise<string | null> {
  const dc = t.dateColumns.find(c => c.label === dateLabel);
  const targetColIdx = dc?.index ?? null;
  const summary = buildMemberSummary(t, targetColIdx);
  if (!summary) return null;
  const system =
    "あなたはチームのKPI達成を競争形式で盛り上げる、明るいスポーツ実況アナウンサーです。" +
    "各メンバーの達成状況を比較して、誰がリードしていて誰が出遅れているかを煽りすぎず楽しく実況してください。" +
    "【重要】セル値の意味: ○/H表記=達成・作業済み、分数=部分達成、×=未達成、「予定」=まだ実施していない（達成ではない）、未記入=不明。" +
    "絵文字を適度に使い、Markdownの見出し(#)は使わず、3〜5行・200字程度で簡潔に。";
  const user = `デイリー KPI実況（対象日: ${dateLabel}）\n\n各メンバーの達成状況:\n${summary}\n\nこれは競争です。達成件数で順位感を出して実況し、未達成・予定のみの人にも温かく激励してください。`;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(withOptionalTemperature({
        model: config.openaiModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }, config.openaiModel, 0.7)),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// ── 週次表投稿: 日付ごとの記号表示・LLMナレーション ─────────────────────
// kpiRisk.ts の KpiRowContext を循環import無しで受け取れるよう、必要フィールドだけを
// 構造的に受け取る（cadence.kind/weekdays が同じ形であれば実際の KpiRowContext もそのまま渡せる）。
interface RowForSymbols {
  cells: string[];
  cadence: { kind: string; weekdays?: number[] };
}

const WEEKDAY_KANJI_TO_NUM: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };
function weekdayOfLabel(label: string): number | null {
  const m = label.match(/[（(]([日月火水木金土])[)）]/);
  return m ? WEEKDAY_KANJI_TO_NUM[m[1]] : null;
}

const SYMBOL_PRIORITY: Record<CellKind, number> = {
  failed: 0,
  empty: 1,
  planned: 2,
  partial: 3,
  hours: 4,
  achieved: 4,
  other: 5
};
const SYMBOL_FOR_KIND: Record<CellKind, string> = {
  failed: "✗",
  empty: "・",
  planned: "△",
  partial: "◐",
  hours: "○",
  achieved: "○",
  other: "?"
};

/**
 * 指定メンバーの、その週の日付列ごとの状況を1記号ずつ並べた文字列にする。
 * 同じ日に複数KPI行がある場合は「悪い方が勝つ」優先度で1文字に集約するが、
 * その「悪い方」判定に加わるのは以下のみ：
 *   - daily / weekdays（その曜日が対象の場合）: 空欄も含めて毎日の期待値として評価する
 *   - weekly_count / none（頻度に日次の期待値が無い）: 何か記入があるときだけ評価に加える。
 *     空欄は「その日にやる予定ではなかっただけ」であり未達成扱いにしない
 * （週◯回型・一回きり型のKPIは埋まっていない日があって当然なので、それだけで
 *   他の実際の記入まで「未記入」に潰してしまわないようにするため）。
 * その日に評価対象が1つも無ければ "-" になる。
 */
export function formatMemberDaySymbols(
  memberRows: RowForSymbols[],
  dateColumns: ScrumTable["dateColumns"],
  uptoColIndex?: number
): string {
  if (memberRows.length === 0) return "";
  const cols = uptoColIndex != null ? dateColumns.filter((c) => c.index <= uptoColIndex) : dateColumns;
  return cols
    .map((col) => {
      const weekday = weekdayOfLabel(col.label);
      let worst: CellKind | null = null;
      for (const r of memberRows) {
        if (r.cadence.kind === "weekdays" && r.cadence.weekdays && (weekday == null || !r.cadence.weekdays.includes(weekday))) {
          continue; // この曜日は対象外のKPI
        }
        const kind = classifyCell(r.cells[col.index] ?? "").kind;
        if ((r.cadence.kind === "weekly_count" || r.cadence.kind === "none") && kind === "empty") {
          continue; // 日次の期待値が無いKPIの空欄は、この日の評価に加えない
        }
        if (worst == null || SYMBOL_PRIORITY[kind] < SYMBOL_PRIORITY[worst]) worst = kind;
      }
      return worst != null ? SYMBOL_FOR_KIND[worst] : "-";
    })
    .join("");
}

/** 週次表投稿のLLMナレーション（連続未達成の指摘・達成率の高いメンバーの称賛）。失敗時はnull。 */
export async function buildWeeklyBoardNarration(
  config: AppConfig,
  data: {
    perMemberSymbols: Array<{ member: string; symbols: string }>;
    warnings: Array<{ member: string; kpiText: string; streakLen: number }>;
    praise: Array<{ member: string; achievedCount: number; totalCount: number; rate: number }>;
    dateLabel: string;
  }
): Promise<string | null> {
  const system =
    "あなたはチームのKPI達成を見守るPMOアシスタントです。週次のKPI表を締めるにあたり、各メンバーの1週間の達成状況を解説してください。" +
    "【重要】達成率が高い人ははっきり称え、連続未達成が続いている人には温かくも率直に指摘してください。煽りすぎず、事実ベースで淡々と。" +
    "絵文字を適度に使い、Markdownの見出し(#)は使わず、5〜8行程度で簡潔に。";
  const user =
    `週次KPIまとめ（${data.dateLabel}時点）\n\n` +
    `各メンバーの週間記号（左から日付順。○達成 ✗未達成 △予定のみ ◐部分達成 ・未記入 -対象KPIなし）:\n` +
    `${data.perMemberSymbols.map((s) => `${s.member}: ${s.symbols}`).join("\n")}\n\n` +
    `連続未達成の警告:\n${data.warnings.length ? data.warnings.map((w) => `- ${w.member}さん「${w.kpiText}」${w.streakLen}日連続未達成`).join("\n") : "（なし）"}\n\n` +
    `達成率の高いメンバー:\n${data.praise.length ? data.praise.map((p) => `- ${p.member}さん ${Math.round(p.rate * 100)}%（${p.achievedCount}/${p.totalCount}）`).join("\n") : "（該当なし）"}`;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(withOptionalTemperature({
        model: config.openaiModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
      }, config.openaiModel, 0.6))
    });
    if (!res.ok) return null;
    const resData = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return resData.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}
