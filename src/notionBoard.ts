// ── Notion ボードビューを担当者ごとにスクショする (Browser Rendering / A方式) ──
//
// 仕組み:
//  1. KV に保存した Notion セッション Cookie をセット（手動ログインで取得・保存）
//  2. ボードビュー(TeamKボード)を開く
//  3. サイドバーを CSS で非表示
//  4. 担当者グループ群コンテナ(g0)の各子要素の座標を取得（スクロールしない＝sticky裏隠れ回避）
//  5. 各担当者のグループを clip でスクショ
//
// ※ token_v2 等の Cookie が KV に無い場合は空配列を返し、呼び出し側でスキップ。

/** Notion タスクDB TeamKボードビューの既定 URL（env で上書き可）。 */
export const DEFAULT_NOTION_BOARD_URL =
  "https://www.notion.so/aice-co-jp/241e00135b6180ce987fe97df3036458?v=2d7e00135b6180eca61a000cc8954548";

/** Notion タスクDB タイムラインビューの既定 URL（env で上書き可）。 */
export const DEFAULT_NOTION_TIMELINE_URL =
  "https://www.notion.so/aice-co-jp/241e00135b6180ce987fe97df3036458?v=519ab1cc6ed942d5a8abc747542e137e";

const SESSION_KEY = "notion:session";

const NAME_MAP: Record<string, string> = {
  kotetsu: "古鉄朋也",
  kitagawa: "北川楓",
  takeda: "武田良平",
  matsuda: "松田直樹",
};

/** グループ見出しテキストから担当者キーを判定。対象外(担当者なし等)は null。 */
function keyOf(text: string): string | null {
  if (text.includes("古鉄")) return "kotetsu";
  if (text.includes("北川")) return "kitagawa";
  if (text.includes("武田")) return "takeda";
  if (text.includes("Matsuda")) return "matsuda";
  return null;
}

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface AssigneeBoardShot {
  key: string;
  name: string;
  png: Uint8Array;
}

/** KV から Notion セッション Cookie を取得。未保存なら null。 */
export async function getNotionSession(
  kv: KVNamespace
): Promise<SessionCookie[] | null> {
  const raw = await kv.get(SESSION_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as SessionCookie[];
  } catch {
    /* ignore */
  }
  return null;
}

/** ブラウザに渡せる形へ Cookie を正規化（sameSite を正しい大文字小文字に）。 */
function normalizeCookies(cookies: SessionCookie[]): Record<string, unknown>[] {
  return cookies.map((c) => {
    const ck: Record<string, unknown> = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
    };
    if (typeof c.expires === "number" && c.expires > 0) ck.expires = c.expires;
    if (typeof c.httpOnly === "boolean") ck.httpOnly = c.httpOnly;
    if (typeof c.secure === "boolean") ck.secure = c.secure;
    const ss = (c.sameSite || "").toLowerCase();
    if (ss === "strict") ck.sameSite = "Strict";
    else if (ss === "lax") ck.sameSite = "Lax";
    else if (ss === "none") ck.sameSite = "None";
    return ck;
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ページの全スクリプト実行前に注入する。IntersectionObserver を上書きし、observe された
// 要素を即「画面内(isIntersecting:true)」として通知する。これにより Notion の遅延画像
// (初期は1pxプレースホルダ)が headless でも実URLを即セットする。
const IO_OVERRIDE_SCRIPT = `(() => {
  try {
    var Real = window.IntersectionObserver;
    function FakeIO(cb){ this._cb = cb; }
    FakeIO.prototype.observe = function(el){
      var self = this;
      var notify = function(){
        try { self._cb([{ isIntersecting: true, intersectionRatio: 1, target: el,
          boundingClientRect: el.getBoundingClientRect(), intersectionRect: el.getBoundingClientRect(),
          rootBounds: null, time: 0 }], self); } catch (e) {}
      };
      // 同期/非同期の両方で通知（実装差異に対応）
      notify(); setTimeout(notify, 0);
    };
    FakeIO.prototype.unobserve = function(){};
    FakeIO.prototype.disconnect = function(){};
    FakeIO.prototype.takeRecords = function(){ return []; };
    window.IntersectionObserver = FakeIO;
    // Notion の遅延画像は requestIdleCallback で src をセットすることがある。
    // headless では idle が来ず発火しないため、即時実行に置き換える。
    window.requestIdleCallback = function(cb){ return setTimeout(function(){ cb({ didTimeout: false, timeRemaining: function(){ return 50; } }); }, 1); };
    window.cancelIdleCallback = function(id){ clearTimeout(id); };
  } catch (e) {}
})()`;

/** 遅延画像を即読込させるため、goto 前に IntersectionObserver 上書きを注入する。 */
async function injectEagerImages(page: {
  evaluateOnNewDocument?: (s: string) => Promise<unknown>;
}): Promise<void> {
  if (typeof page.evaluateOnNewDocument === "function") {
    await page.evaluateOnNewDocument(IO_OVERRIDE_SCRIPT).catch(() => {});
  }
}

// スクショ前にアバター画像を確実に読み込ませる in-page スクリプト。
//
// 背景: Notion のアバターは <img src="https://www.notion.so/image/<S3をURLエンコードしたURL>">
// で、表示時に画像リサイズプロキシ img.notionusercontent.com へ 302 される。
// Cloudflare Browser Rendering の経路だと、このプロキシが特定画像に対して
// 500 / ERR_CONTENT_LENGTH_MISMATCH(応答途中切れ) を“決定的に”返すことがあり、
// 当該 <img> は naturalWidth=0 のまま＝白い丸になる(担当者アイコンが欠ける現象)。
//
// アバターが headless で「白い丸」になる原因は2つ重なっている:
//  (A) Notion のアバターは遅延読み込みで、行内アバターは初期 1px の data:gif プレースホルダ。
//      IntersectionObserver / requestIdleCallback を上書きしても、コレクション行の実URLは
//      セットされないことがある(虚白のまま)。ページ上から実URLを収集する方式は facepile の
//      読み込み有無に依存して不安定だった。
//  (B) 実URL(www.notion.so/image/ → img.notionusercontent.com)へ 302 するが、特定画像で
//      このリサイズプロキシが 500/途中切れ(ERR_CONTENT_LENGTH_MISMATCH) → naturalWidth=0。
//
// 対策(決定的): Notion API の users.list が返す avatar_url(公開S3 or googleusercontent。
// いずれもリサイズプロキシ非経由で直読み込み可) を「alt(人名) → URL」で受け取り、
// 各アバター<img>の alt を突き合わせて src を直接セットする。facepile/遅延に依存しない。
// 全アバターが読み込み完了(naturalWidth>2)するまで(上限あり)ポーリング待機。
function ensureAvatarsScript(mapJson: string): string {
  return `(() => new Promise((resolve) => {
    var MAP = ${mapJson};
    var keys = Object.keys(MAP);
    var MAX = 16000, STEP = 500, start = Date.now(), swapped = 0;
    var lookup = function (alt) {
      if (!alt) return null;
      if (MAP[alt]) return MAP[alt];
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (alt.indexOf(k) >= 0 || k.indexOf(alt) >= 0) return MAP[k];
      }
      return null;
    };
    var isAvatarSlot = function (im) {
      var r = im.getBoundingClientRect();
      var s = im.getAttribute('src') || im.src || '';
      var isImgUrl = /\\/image\\/|notionusercontent|amazonaws|notion-static|googleusercontent/.test(s);
      return (r.width > 0 && r.width <= 40 && (!!im.alt || isImgUrl)) || (isImgUrl && im.complete && im.naturalWidth === 0);
    };
    var clean = 0; // 連続して「待ち0」になった回数（行は遅延レンダリングされるため落ち着くまで待つ）
    var tick = function () {
      var ims = document.querySelectorAll('img'), pending = 0;
      for (var i = 0; i < ims.length; i++) {
        var im = ims[i];
        if (!isAvatarSlot(im)) continue;
        if (im.naturalWidth > 2) continue; // 実画像読み込み済み
        var url = lookup((im.alt || '').trim());
        if (url && im.src !== url) { im.removeAttribute('srcset'); im.src = url; swapped++; }
        var srcNow = im.src || '';
        // マップ該当(注入済み) または Notion 自前の実URLが読み込み中 → 完了を待つ
        var realLoading = /\\/image\\/|notionusercontent|amazonaws|notion-static|googleusercontent/.test(srcNow);
        if (url || realLoading) pending++;
      }
      if (pending === 0) clean++; else clean = 0;
      // 待ち0が3連続(=約1.5s安定) で完了。遅延レンダリングの行も取りこぼさない。
      if (clean >= 3 || Date.now() - start > MAX) resolve(swapped);
      else setTimeout(tick, STEP);
    };
    tick();
  }))()`;
}

/**
 * スクショ前に呼ぶ: API由来の avatar_url を alt 一致で各アバターに流し込み、読込完了まで待機。
 * avatarMap が空なら何もしない。差し替え枚数を返す。
 */
async function ensureAvatarsLoaded(
  page: { evaluate: (s: string) => Promise<unknown> },
  avatarMap?: Record<string, string>
): Promise<number> {
  if (!avatarMap || Object.keys(avatarMap).length === 0) return 0;
  try {
    const n = (await page.evaluate(ensureAvatarsScript(JSON.stringify(avatarMap)))) as number;
    return typeof n === "number" ? n : 0;
  } catch {
    return 0;
  }
}

/** Notion users.list から「表示名 → avatar_url」を取得(写真設定済みユーザーのみ)。失敗時は空。 */
export async function fetchNotionAvatarMap(notionToken: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  try {
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const u = cursor
        ? `https://api.notion.com/v1/users?start_cursor=${cursor}&page_size=100`
        : "https://api.notion.com/v1/users?page_size=100";
      const res = await fetch(u, {
        headers: { Authorization: `Bearer ${notionToken}`, "Notion-Version": "2022-06-28" },
      });
      if (!res.ok) break;
      const data = (await res.json()) as {
        results: Array<{ name?: string; avatar_url?: string | null; type?: string }>;
        has_more?: boolean;
        next_cursor?: string | null;
      };
      for (const usr of data.results) {
        if (usr.name && usr.avatar_url) map[usr.name] = usr.avatar_url;
      }
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
  } catch {
    /* 補助データなので失敗は許容 */
  }
  return map;
}

/**
 * 各担当者の Notion ボードを切り出してPNGで返す。
 * browser/cookies が無い場合は空配列（呼び出し側でスキップ）。
 */
export async function captureAssigneeBoards(
  browser: Fetcher | undefined,
  cookies: SessionCookie[] | null,
  boardUrl: string = DEFAULT_NOTION_BOARD_URL,
  avatarMap?: Record<string, string>
): Promise<AssigneeBoardShot[]> {
  if (!browser || !cookies || cookies.length === 0) return [];

  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  let br: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  const results: AssigneeBoardShot[] = [];

  try {
    br = await puppeteer.launch(browser);
    const page = await br.newPage();
    await page.setViewport({ width: 2000, height: 4200, deviceScaleFactor: 2 });

    // Notion セッション Cookie をセット
    const ck = normalizeCookies(cookies);
    // @ts-expect-error puppeteer の setCookie はオブジェクト配列を受ける
    await page.setCookie(...ck);

    await injectEagerImages(page); // 遅延画像(アバター)を即読込させる
    await page.goto(boardUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(13000); // タイムライン/ボードのレンダリング待ち

    // ログイン維持の確認（/login に飛ばされたらセッション失効）
    const url = page.url();
    if (url.includes("/login")) {
      console.warn("captureAssigneeBoards: Notion session expired (redirected to /login)");
      return [];
    }

    // サイドバー非表示
    await page.addStyleTag({
      content: `.notion-sidebar-container,.notion-sidebar,[class*="sidebar"]{display:none!important}`,
    });
    await sleep(2000);

    // 担当者アバターを確実に読み込ませる（白い丸対策）
    await ensureAvatarsLoaded(page, avatarMap);

    // 担当者グループ群(g0)の子要素の座標を一括取得（スクロールしない）
    const groups = (await page.evaluate(`(() => {
      const bv = document.querySelector('.notion-board-view');
      const g0 = bv && bv.children[2] && bv.children[2].children[0]
        && bv.children[2].children[0].children[1] && bv.children[2].children[0].children[1].children[0];
      if (!g0) return [];
      const out = [];
      for (const c of g0.children) {
        const r = c.getBoundingClientRect();
        const t = (c.textContent || '').trim();
        if (r.height > 30) out.push({ top: Math.round(r.top), height: Math.round(r.height), text: t.slice(0, 25) });
      }
      return out;
    })()`)) as Array<{ top: number; height: number; text: string }>;

    for (const g of groups) {
      const key = keyOf(g.text);
      if (!key) continue;
      const y = Math.max(g.top - 4, 0);
      const png = (await page.screenshot({
        type: "png",
        clip: { x: 0, y, width: 2000, height: g.height + 8 },
      })) as Uint8Array;
      results.push({ key, name: NAME_MAP[key] ?? key, png });
    }
    console.log(`captureAssigneeBoards: captured ${results.length} boards`);
  } catch (err) {
    console.warn(`captureAssigneeBoards error: ${(err as Error).message}`);
  } finally {
    if (br) await br.close().catch(() => {});
  }
  return results;
}

export interface TimelineDebug {
  ok: boolean;
  reason?: string;
  finalUrl?: string;
  avatarImgs?: Array<{ alt: string; complete: boolean; nw: number; src: string }>;
  imgResponses?: Array<{ status: number; url: string }>;
  failedRequests?: Array<{ url: string; err: string }>;
  png?: Uint8Array;
}

/**
 * 【診断用】Browser Rendering 上でアバター画像の読み込み状態を計測して返す。
 * 本番フローでは使わず、HTTP デバッグルートからのみ呼ぶ。
 */
export async function captureNotionTimelineDebug(
  browser: Fetcher | undefined,
  cookies: SessionCookie[] | null,
  timelineUrl: string = DEFAULT_NOTION_TIMELINE_URL,
  withPng = false,
  avatarMap?: Record<string, string>
): Promise<TimelineDebug> {
  if (!browser || !cookies || cookies.length === 0)
    return { ok: false, reason: "no browser or cookies" };

  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  let br: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  const imgResponses: Array<{ status: number; url: string }> = [];
  const failedRequests: Array<{ url: string; err: string }> = [];
  try {
    br = await puppeteer.launch(browser);
    const page = await br.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });

    page.on("response", (res: { status: () => number; url: () => string }) => {
      const u = res.url();
      if (/\/image\/|notionusercontent|amazonaws|notion-static/i.test(u))
        imgResponses.push({ status: res.status(), url: u.slice(0, 110) });
    });
    page.on("requestfailed", (req: { url: () => string; failure: () => { errorText?: string } | null }) => {
      const u = req.url();
      if (/\/image\/|notionusercontent|amazonaws|notion-static/i.test(u))
        failedRequests.push({ url: u.slice(0, 110), err: req.failure()?.errorText ?? "?" });
    });

    const ck = normalizeCookies(cookies);
    // @ts-expect-error puppeteer の setCookie はオブジェクト配列を受ける
    await page.setCookie(...ck);
    await injectEagerImages(page);
    await page.goto(timelineUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(13000);
    if (page.url().includes("/login")) return { ok: false, reason: "session expired" };

    await page.addStyleTag({
      content: `.notion-sidebar-container,.notion-sidebar,[class*="sidebar"]{display:none!important}`,
    });
    await sleep(2000);

    const swapped = await ensureAvatarsLoaded(page, avatarMap);
    console.log(`captureNotionTimelineDebug: avatar swaps=${swapped}`);

    const avatarImgs = (await page.evaluate(`(() => {
      const out = [];
      let icons = 0, loaded = 0, blank = 0;
      for (const im of document.querySelectorAll('img')) {
        const r = im.getBoundingClientRect();
        if (!(r.width > 0 && r.width <= 30 && r.height <= 30)) continue;
        icons++;
        const ok = im.naturalWidth > 2;        // 実画像(プレースホルダ1pxは未満)
        if (ok) loaded++; else blank++;
        if (im.alt) out.push({ alt: (im.alt||'').slice(0,16), complete: im.complete, nw: im.naturalWidth, src: (im.src||'').slice(0,90) });
      }
      out.unshift({ alt: 'SUMMARY iconImgs='+icons+' loaded='+loaded+' blank='+blank, complete: true, nw: 0, src: '' });
      return out;
    })()`)) as TimelineDebug["avatarImgs"];

    const result: TimelineDebug = {
      ok: true,
      finalUrl: page.url(),
      avatarImgs,
      imgResponses: imgResponses.slice(0, 40),
      failedRequests,
    };
    if (withPng) result.png = (await page.screenshot({ type: "png" })) as Uint8Array;
    return result;
  } catch (err) {
    return { ok: false, reason: (err as Error).message, imgResponses, failedRequests };
  } finally {
    if (br) await br.close().catch(() => {});
  }
}

/**
 * Notion タイムラインビュー(ガントチャート)をスクショして PNG で返す。
 * browser/cookies が無い、またはセッション失効時は null。
 */
export async function captureNotionTimeline(
  browser: Fetcher | undefined,
  cookies: SessionCookie[] | null,
  timelineUrl: string = DEFAULT_NOTION_TIMELINE_URL,
  avatarMap?: Record<string, string>
): Promise<Uint8Array | null> {
  if (!browser || !cookies || cookies.length === 0) return null;

  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  let br: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    br = await puppeteer.launch(browser);
    const page = await br.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });

    const ck = normalizeCookies(cookies);
    // @ts-expect-error puppeteer の setCookie はオブジェクト配列を受ける
    await page.setCookie(...ck);

    await injectEagerImages(page); // 遅延画像(アバター)を即読込させる
    await page.goto(timelineUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(13000);

    if (page.url().includes("/login")) {
      console.warn("captureNotionTimeline: Notion session expired (redirected to /login)");
      return null;
    }

    await page.addStyleTag({
      content: `.notion-sidebar-container,.notion-sidebar,[class*="sidebar"]{display:none!important}`,
    });
    await sleep(2000);

    // 担当者アバターを確実に読み込ませる（白い丸対策）
    await ensureAvatarsLoaded(page, avatarMap);

    const png = (await page.screenshot({ type: "png" })) as Uint8Array;
    console.log("captureNotionTimeline: captured");
    return png;
  } catch (err) {
    console.warn(`captureNotionTimeline error: ${(err as Error).message}`);
    return null;
  } finally {
    if (br) await br.close().catch(() => {});
  }
}
