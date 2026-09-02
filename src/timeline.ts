// タスク群を React + Recharts でガント風に描画する HTML を生成し、
// Cloudflare Browser Rendering でスクショして PNG(Uint8Array) を返すモジュール。
//  - バー色 = スケジュール健全度（順調=青/あぶない=黄/期限ぎりぎり=紫/期限切れ=赤）
//  - 左軸 = 苗字バッジ(担当者色) + プロジェクトバッジ + タスク名
//  - バー右端 = ステータス（Doing は N% 表示）
//  - 今日に破線 / 上部に凡例
// ※ puppeteer は buildTimelinePng 内で動的 import（renderTimelineHtml を純粋に保つ）。

const PROJECT_PALETTE = [
  "#4e79a7", "#f28e2c", "#b07aa1", "#59a14f", "#e15759",
  "#0f9d9d", "#d6627a", "#9c755f", "#1f77b4", "#8c564b"
];
const ASSIGNEE_PALETTE = [
  "#2563eb", "#db2777", "#16a34a", "#d97706", "#7c3aed",
  "#0891b2", "#b91c1c", "#4b5563", "#0d9488", "#9333ea"
];

// ── スケジュール健全度 ──────────────────────────────────────────────
const DAILY_SP = 2.5; // 1人が1日に消化できるSPの目安
const HEALTH = {
  onTrack: { color: "#2f6fed", label: "順調" },
  atRisk: { color: "#f1c40f", label: "あぶない" },
  imminent: { color: "#8e44ad", label: "期限ぎりぎり" },
  overdue: { color: "#e74c3c", label: "期限切れ" }
};
export const HEALTH_LEGEND_TEXT = "🔵順調 🟡あぶない 🟣期限ぎりぎり 🔴期限切れ";

export interface TimelineTask {
  name: string;
  assignee: string; // 苗字
  status: string;
  project: string;
  start: string; // 実行日 or 期限開始
  end: string;   // 期日 or 期限終了（健全度判定の締切）
  sp: number | null;
}

function dayMs(d: string): number { return new Date(d + "T00:00:00Z").getTime(); }
function daysBetween(a: string, b: string): number { return Math.round((dayMs(b) - dayMs(a)) / 86400000); }
function addDays(d: string, n: number): string {
  const dt = new Date(dayMs(d)); dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function md(d: string): string { return d.slice(5).replace("-", "/"); }

/** SP・期日・他タスク負荷からバー色(健全度)を決める。同じ担当者の「期日≤当該」のSP合計で判定。 */
function computeHealthColors(
  tasks: Array<{ assignee: string; end: string; sp: number | null }>,
  today: string
): string[] {
  const byA = new Map<string, number[]>();
  tasks.forEach((t, i) => { const a = byA.get(t.assignee) ?? []; a.push(i); byA.set(t.assignee, a); });
  const out: string[] = new Array(tasks.length).fill(HEALTH.onTrack.color);
  for (const idxs of byA.values()) {
    for (const i of idxs) {
      const t = tasks[i];
      if (t.end < today) { out[i] = HEALTH.overdue.color; continue; }
      const daysLeft = daysBetween(today, t.end);
      if (daysLeft <= 1) { out[i] = HEALTH.imminent.color; continue; }
      let req = 0;
      for (const j of idxs) { if (tasks[j].end <= t.end) req += tasks[j].sp ?? 0; }
      out[i] = req / daysLeft > DAILY_SP ? HEALTH.atRisk.color : HEALTH.onTrack.color;
    }
  }
  return out;
}

/** ステータス→ピル背景色（バー右端のステータス丸）。 */
function statusCategory(status: string): { bg: string } {
  const s = (status || "").toLowerCase();
  if (s.includes("doing") || s.includes("進行") || s.includes("作業中")) return { bg: "#2e8b57" };
  if (s.includes("ready")) return { bg: "#1f6fc0" };
  if (s.includes("review") || s.includes("レビュー") || s.includes("他者")) return { bg: "#e08e0b" };
  if (s.includes("ペンディング") || s.includes("pending") || s.includes("保留")) return { bg: "#d6453f" };
  if (s.includes("中止") || s.includes("cancel")) return { bg: "#9aa0a6" };
  if (s.includes("backlog")) return { bg: "#8a8f98" };
  return { bg: "#666666" };
}

/** ステータス表示文字列。Doing は進捗% (例 "20%")、その他は簡潔ラベル。 */
function statusDisplay(status: string): string {
  const s = status || "";
  const pct = s.match(/(\d+)\s*%/);
  if (/doing|進行|作業中/i.test(s)) return pct ? `${pct[1]}%` : "Doing";
  if (/ready/i.test(s)) return "Ready";
  if (/backlog/i.test(s)) return "Backlog";
  if (/review|レビュー|他者/i.test(s)) return "Review";
  if (/ペンディング|pending|保留/i.test(s)) return "Pending";
  if (/中止|cancel/i.test(s)) return "中止";
  return s.length > 8 ? s.slice(0, 8) : s;
}

/** タイムライン(React+Recharts)を描画するHTMLを生成する。 */
export function renderTimelineHtml(
  tasks: TimelineTask[],
  windowStart: string,
  windowEnd: string,
  today: string
): string {
  const N = daysBetween(windowStart, windowEnd) + 1;

  const projects = [...new Set(tasks.map((t) => t.project).filter(Boolean))];
  const projColor = new Map<string, string>();
  projects.forEach((p, i) => projColor.set(p, PROJECT_PALETTE[i % PROJECT_PALETTE.length]));

  const assignees = [...new Set(tasks.map((t) => t.assignee))];
  const asgColor = new Map<string, string>();
  assignees.forEach((a, i) => asgColor.set(a, ASSIGNEE_PALETTE[i % ASSIGNEE_PALETTE.length]));

  const sorted = [...tasks].sort(
    (a, b) => a.assignee.localeCompare(b.assignee) || a.end.localeCompare(b.end) || a.name.localeCompare(b.name)
  );

  const health = computeHealthColors(
    sorted.map((t) => ({ assignee: t.assignee, end: t.end, sp: t.sp })),
    today
  );

  const items = sorted.map((t, i) => {
    const startC = t.start < windowStart ? windowStart : t.start;
    const endRaw = t.end > t.start ? t.end : addDays(t.start, 1);
    const endC = endRaw > addDays(windowEnd, 1) ? addDays(windowEnd, 1) : endRaw;
    return {
      name: t.name.length > 22 ? t.name.slice(0, 22) + "…" : t.name,
      surname: t.assignee,
      surnameColor: asgColor.get(t.assignee) ?? "#555",
      project: t.project,
      projColor: t.project ? projColor.get(t.project) ?? "#888" : "#bbb",
      statusDisp: statusDisplay(t.status),
      statusColor: statusCategory(t.status).bg,
      healthColor: health[i],
      offset: Math.max(0, daysBetween(windowStart, startC)),
      duration: Math.max(0.5, daysBetween(startC, endC))
    };
  });

  const tickLabels = Array.from({ length: N + 1 }, (_, i) => (i < N ? md(addDays(windowStart, i)) : ""));
  const payload = {
    items,
    N,
    ticks: Array.from({ length: N + 1 }, (_, i) => i),
    tickLabels,
    todayOffset: daysBetween(windowStart, today) + 0.5,
    title: `タイムライン ${md(windowStart)}〜${md(windowEnd)}`,
    todayLabel: `今日 ${md(today)}`,
    rowH: 30,
    labelW: 430,
    dayW: 46
  };

  return `<!doctype html><html><head><meta charset="utf-8">
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/prop-types@15/prop-types.min.js"></script>
<script src="https://unpkg.com/recharts@2/umd/Recharts.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#fff;font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",Meiryo,sans-serif}
  #root{display:inline-block;padding:14px}
  .title{font-size:16px;font-weight:700;color:#222;margin:0 0 6px 4px}
  .legend{display:flex;gap:14px;margin:0 0 8px 4px;font-size:12px;color:#444;align-items:center}
  .legend span{display:flex;align-items:center;gap:4px}
  .legend i{width:12px;height:12px;border-radius:3px;display:inline-block}
  .badge{display:inline-block;padding:1px 6px;border-radius:6px;color:#fff;font-size:11px;font-weight:600;flex:none}
  .lblrow{display:flex;align-items:center;gap:4px;font-size:12px;color:#222;white-space:nowrap;overflow:hidden;height:100%}
  .tname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style></head><body>
<div id="root"></div>
<script>
(function(){
  var D = ${JSON.stringify(payload)};
  var e = React.createElement;
  var R = Recharts;
  var chartW = D.labelW + D.N * D.dayW + 120;
  var chartH = D.items.length * D.rowH + 64;

  function Badge(bg, fg, text){ return e('span', {className:'badge', style:{background:bg, color:fg||'#fff'}}, text); }

  // ステータスをバー右端に「丸(ピル)」で表示する custom label
  function statusPill(props){
    var it = D.items[props.index]; var v = props.value;
    if(!it || v==null || v==='') return null;
    var txt = String(v);
    var w = txt.length * 7.5 + 16;
    var bx = props.x + props.width + 6;
    var by = props.y + props.height/2 - 9;
    return e('g', null,
      e('rect', {x:bx, y:by, width:w, height:18, rx:9, ry:9, fill: it.statusColor}),
      e('text', {x:bx + w/2, y:by + 13, textAnchor:'middle', fontSize:11, fontWeight:600, fill:'#fff'}, txt)
    );
  }
  function tick(props){
    var it = D.items[props.payload.index];
    if(!it) return null;
    var kids = [Badge(it.surnameColor,'#fff', it.surname)];
    if(it.project) kids.push(Badge(it.projColor,'#fff', it.project));
    kids.push(e('span',{className:'tname'}, it.name));
    return e('g', {transform:'translate('+(props.x - D.labelW + 4)+','+(props.y - 11)+')'},
      e('foreignObject', {width: D.labelW - 10, height: 24},
        e('div', {className:'lblrow', xmlns:'http://www.w3.org/1999/xhtml'}, kids)));
  }

  var chart = e(R.BarChart, {
      layout:'vertical', width: chartW, height: chartH, data: D.items,
      margin:{top:52, right:120, bottom:6, left:6}, barCategoryGap:5
    },
    e(R.CartesianGrid, {horizontal:false, stroke:'#eee'}),
    e(R.XAxis, {type:'number', domain:[0, D.N], orientation:'top', ticks:D.ticks, interval:0,
      tickFormatter:function(v){return D.tickLabels[v]||'';}, tick:{fontSize:10, fill:'#888'}, axisLine:false, tickLine:false}),
    e(R.YAxis, {type:'category', dataKey:'name', width:D.labelW, interval:0, tick:tick, axisLine:false, tickLine:false}),
    e(R.Bar, {key:'off', dataKey:'offset', stackId:'a', fill:'transparent', isAnimationActive:false}),
    e(R.Bar, {key:'dur', dataKey:'duration', stackId:'a', isAnimationActive:false, radius:[5,5,5,5]},
      D.items.map(function(it,idx){ return e(R.Cell,{key:idx, fill: it.healthColor}); }),
      e(R.LabelList, {dataKey:'statusDisp', content: statusPill})
    ),
    e(R.ReferenceLine, {x:D.todayOffset, stroke:'#d11', strokeWidth:2, strokeDasharray:'5 4',
      label:{value:D.todayLabel, position:'top', fill:'#d11', fontSize:11, fontWeight:700, dy:-20}})
  );

  var legend = e('div',{className:'legend'},
    e('span',null, e('i',{style:{background:'#2f6fed'}}), '順調'),
    e('span',null, e('i',{style:{background:'#f1c40f'}}), 'あぶない'),
    e('span',null, e('i',{style:{background:'#8e44ad'}}), '期限ぎりぎり'),
    e('span',null, e('i',{style:{background:'#e74c3c'}}), '期限切れ')
  );
  var app = e('div', null, e('div',{className:'title'}, D.title), legend, chart);
  ReactDOM.createRoot(document.getElementById('root')).render(app);
  window.__ready = true;
})();
</script>
</body></html>`;
}

/** Browser Rendering で HTML(#root内にRecharts) をスクショして PNG を返す共通処理。失敗時 null。 */
export async function htmlToPng(
  browser: Fetcher | undefined,
  html: string,
  viewport: { width: number; height: number; deviceScaleFactor?: number } = {
    width: 1400,
    height: 900,
    deviceScaleFactor: 2
  }
): Promise<Uint8Array | null> {
  if (!browser) return null;
  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  let br: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    br = await puppeteer.launch(browser);
    const page = await br.newPage();
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1
    });
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.waitForSelector("#root svg.recharts-surface", { timeout: 8000 }).catch(() => {});
    const el = await page.$("#root");
    return el
      ? ((await el.screenshot({ type: "png" })) as Uint8Array)
      : ((await page.screenshot({ type: "png", fullPage: true })) as Uint8Array);
  } catch (err) {
    console.warn(`htmlToPng error: ${(err as Error).message}`);
    return null;
  } finally {
    if (br) await br.close().catch(() => {});
  }
}

/** タイムラインを Browser Rendering でスクショして PNG を返す。 */
export async function buildTimelinePng(
  browser: Fetcher | undefined,
  tasks: TimelineTask[],
  windowStart: string,
  windowEnd: string,
  today: string
): Promise<Uint8Array | null> {
  if (!browser || tasks.length === 0) return null;
  return htmlToPng(browser, renderTimelineHtml(tasks, windowStart, windowEnd, today));
}
