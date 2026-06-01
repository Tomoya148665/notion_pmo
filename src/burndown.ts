// スプリントのバーンダウンチャートを React + Recharts(LineChart) で描画し、
// Browser Rendering でスクショして PNG を返すモジュール。
//  - 理想線: 開始日に total → 終了日に 0 の直線
//  - 実績線: 各日の残SP = total −（完了日 ≤ その日 の完了タスクSP合計）。今日まで描画。
import { htmlToPng } from "./timeline";
import { isCompletedStatus } from "./notionApi";

export interface BurndownTask {
  sp: number;
  status: string | null;
  completedDate: string | null;
  due: string | null;
}

export interface BurndownSeries {
  sprintName: string;
  start: string;
  end: string;
  total: number;
  points: Array<{ date: string; ideal: number; actual: number | null }>;
}

function dayMs(d: string): number { return new Date(d + "T00:00:00Z").getTime(); }
function addDays(d: string, n: number): string {
  const dt = new Date(dayMs(d)); dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function md(d: string): string { return d.slice(5).replace("-", "/"); }

/** バーンダウン系列を計算する。 */
export function buildBurndownSeries(
  sprintName: string,
  start: string,
  end: string,
  tasks: BurndownTask[],
  today: string
): BurndownSeries {
  const total = tasks.reduce((s, t) => s + (t.sp || 0), 0);
  const nDays = Math.max(1, Math.round((dayMs(end) - dayMs(start)) / 86400000));
  const points: BurndownSeries["points"] = [];
  for (let i = 0; i <= nDays; i++) {
    const d = addDays(start, i);
    const ideal = Math.round((total * (nDays - i)) / nDays * 10) / 10;
    let actual: number | null = null;
    if (d <= today) {
      const burned = tasks
        .filter((t) => isCompletedStatus(t.status))
        .filter((t) => (t.completedDate ?? t.due ?? end) <= d)
        .reduce((s, t) => s + (t.sp || 0), 0);
      actual = Math.max(0, Math.round((total - burned) * 10) / 10);
    }
    points.push({ date: md(d), ideal, actual });
  }
  return { sprintName, start, end, total, points };
}

/** バーンダウンを描画するHTMLを生成する（React + Recharts LineChart）。 */
export function renderBurndownHtml(series: BurndownSeries): string {
  const payload = {
    points: series.points,
    title: `バーンダウン ${series.sprintName}（${md(series.start)}〜${md(series.end)}） 計画 ${series.total} SP`
  };
  return `<!doctype html><html><head><meta charset="utf-8">
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/prop-types@15/prop-types.min.js"></script>
<script src="https://unpkg.com/recharts@2/umd/Recharts.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#fff;font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",Meiryo,sans-serif}
  #root{display:inline-block;padding:16px}
  .title{font-size:16px;font-weight:700;color:#222;margin:0 0 10px 4px}
</style></head><body>
<div id="root"></div>
<script>
(function(){
  var D = ${JSON.stringify(payload)};
  var e = React.createElement;
  var R = Recharts;
  var chart = e(R.LineChart, {width:760, height:420, data:D.points, margin:{top:10,right:30,bottom:10,left:10}},
    e(R.CartesianGrid, {strokeDasharray:'3 3', stroke:'#eee'}),
    e(R.XAxis, {dataKey:'date', tick:{fontSize:11, fill:'#666'}, interval:0, angle:-30, textAnchor:'end', height:50}),
    e(R.YAxis, {tick:{fontSize:11, fill:'#666'}, label:{value:'残SP', angle:-90, position:'insideLeft', fontSize:12, fill:'#666'}}),
    e(R.Tooltip, null),
    e(R.Legend, {verticalAlign:'top', height:28}),
    e(R.Line, {type:'linear', dataKey:'ideal', name:'理想', stroke:'#9aa0a6', strokeWidth:2, strokeDasharray:'6 5', dot:false, isAnimationActive:false}),
    e(R.Line, {type:'monotone', dataKey:'actual', name:'実績', stroke:'#2f6fed', strokeWidth:3, dot:{r:3}, connectNulls:false, isAnimationActive:false})
  );
  var app = e('div', null, e('div',{className:'title'}, D.title), chart);
  ReactDOM.createRoot(document.getElementById('root')).render(app);
  window.__ready = true;
})();
</script>
</body></html>`;
}

/** バーンダウンを Browser Rendering でスクショして PNG を返す。 */
export async function buildBurndownPng(
  browser: Fetcher | undefined,
  series: BurndownSeries
): Promise<Uint8Array | null> {
  if (!browser) return null;
  return htmlToPng(browser, renderBurndownHtml(series));
}
