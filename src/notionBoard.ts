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
  "https://app.notion.com/p/aice-co-jp/241e00135b6180ce987fe97df3036458?v=2d7e00135b6180eca61a000cc8954548";

/** Notion タスクDB タイムラインビューの既定 URL（env で上書き可）。 */
export const DEFAULT_NOTION_TIMELINE_URL =
  "https://app.notion.com/p/aice-co-jp/241e00135b6180ce987fe97df3036458?v=519ab1cc6ed942d5a8abc747542e137e";

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

function toAppNotionUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if ((u.hostname === "www.notion.so" || u.hostname === "notion.so") && !u.pathname.startsWith("/p/")) {
      u.hostname = "app.notion.com";
      u.pathname = `/p${u.pathname}`;
      return u.toString();
    }
  } catch {
    /* keep raw */
  }
  return raw;
}

async function isNotionLoggedOut(page: {
  url: () => string;
  evaluate: (s: string) => Promise<unknown>;
}): Promise<boolean> {
  const current = page.url();
  if (current.includes("/login") || current.includes("status=unauthenticated")) return true;
  try {
    const text = (await page.evaluate(
      "((document.body && document.body.innerText) || '').slice(0, 500)"
    )) as string;
    return /Sign in to see this page|You're almost there|You’re almost there|Use an organization email/i.test(text);
  } catch {
    return false;
  }
}

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

// Notion の「非対応ブラウザ」判定を回避するステルス注入。
// 主因: Browser Rendering の navigator.userAgentData.brands が空[] で、Notion の Client Hints
// ベースのブラウザ判定が失敗 → /unsupported-browser.html へリダイレクトされる。
// → userAgentData(brands/getHighEntropyValues)・userAgent・webdriver を本物のChrome相当に偽装。
// puppeteer-extra-stealth 相当の headless/自動化検知回避。Notion の unsupported-browser
// ゲートは navigator.webdriver=true / userAgentData欠落 / window.chrome欠落 等で headless を
// 検知して弾くため、これらを本物の Chrome 相当に上書きする。
const NOTION_STEALTH_SCRIPT = `(() => {
  try {
    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
    try { Object.defineProperty(navigator, 'userAgent', { get: function(){ return UA; } }); } catch (e) {}
    try { Object.defineProperty(navigator, 'appVersion', { get: function(){ return UA.replace('Mozilla/',''); } }); } catch (e) {}
    try { Object.defineProperty(navigator, 'platform', { get: function(){ return 'Win32'; } }); } catch (e) {}
    try { Object.defineProperty(navigator, 'vendor', { get: function(){ return 'Google Inc.'; } }); } catch (e) {}
    // webdriver=true を打ち消す（prototype 側も含めて undefined/false に）
    try { Object.defineProperty(navigator, 'webdriver', { get: function(){ return false; } }); } catch (e) {}
    try { delete Object.getPrototypeOf(navigator).webdriver; } catch (e) {}
    // languages
    try { Object.defineProperty(navigator, 'languages', { get: function(){ return ['ja-JP','ja','en-US','en']; } }); } catch (e) {}
    // plugins/mimeTypes（headless は空 → 非空に見せる）
    try {
      var fakePlugins = [{name:'Chrome PDF Plugin'},{name:'Chrome PDF Viewer'},{name:'Native Client'}];
      Object.defineProperty(navigator, 'plugins', { get: function(){ return fakePlugins; } });
      Object.defineProperty(navigator, 'mimeTypes', { get: function(){ return [{type:'application/pdf'}]; } });
    } catch (e) {}
    // window.chrome（headless には存在しない）
    try {
      if (!window.chrome) { window.chrome = {}; }
      if (!window.chrome.runtime) { window.chrome.runtime = {}; }
      window.chrome.app = window.chrome.app || { isInstalled: false };
      window.chrome.csi = window.chrome.csi || function(){ return {}; };
      window.chrome.loadTimes = window.chrome.loadTimes || function(){ return {}; };
    } catch (e) {}
    // permissions.query の不整合（headless: Notification が denied 固定）を是正
    try {
      var origQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (origQuery) {
        window.navigator.permissions.query = function(p){
          return (p && p.name === 'notifications')
            ? Promise.resolve({ state: Notification.permission })
            : origQuery.call(window.navigator.permissions, p);
        };
      }
    } catch (e) {}
    // WebGL vendor/renderer を本物GPU相当に（SwiftShader/headless 検知回避）
    try {
      var getParam = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(p){
        if (p === 37445) return 'Intel Inc.';            // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
        return getParam.call(this, p);
      };
    } catch (e) {}
    var brands = [
      { brand: "Chromium", version: "138" },
      { brand: "Google Chrome", version: "138" },
      { brand: "Not-A.Brand", version: "99" }
    ];
    var uaData = {
      brands: brands,
      mobile: false,
      platform: "Windows",
      getHighEntropyValues: function () {
        return Promise.resolve({
          architecture: "x86", bitness: "64", brands: brands, mobile: false,
          model: "", platform: "Windows", platformVersion: "15.0.0",
          uaFullVersion: "138.0.0.0", fullVersionList: brands
        });
      },
      toJSON: function () { return { brands: brands, mobile: false, platform: "Windows" }; }
    };
    try { Object.defineProperty(navigator, 'userAgentData', { get: function(){ return uaData; } }); } catch (e) {}
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

// Notion が Chrome 130未満を /unsupported-browser.html へ飛ばす（インラインJSが
// navigator.userAgent の Chrome バージョンを見て <=129 を非対応扱い）。Browser Rendering の
// 実エンジンは HeadlessChrome/128 なので、UA を Chrome/138 に偽装しないと全ページで弾かれる。
const NOTION_MODERN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

/** Notion の非対応ブラウザゲート回避: UA を最新Chrome に偽装 + ステルス注入。goto 前に呼ぶ。 */
async function applyNotionStealth(page: {
  setUserAgent?: (ua: string) => Promise<unknown>;
  evaluateOnNewDocument?: (s: string) => Promise<unknown>;
}): Promise<void> {
  await page.setUserAgent?.(NOTION_MODERN_UA).catch(() => {});
  if (typeof page.evaluateOnNewDocument === "function") {
    await page.evaluateOnNewDocument(NOTION_STEALTH_SCRIPT).catch(() => {});
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
    const targetUrl = toAppNotionUrl(boardUrl);
    br = await puppeteer.launch(browser);
    const page = await br.newPage();
    await page.setViewport({ width: 2000, height: 4200, deviceScaleFactor: 2 });

    // Notion セッション Cookie をセット
    const ck = normalizeCookies(cookies);
    // @ts-expect-error puppeteer の setCookie はオブジェクト配列を受ける
    await page.setCookie(...ck);

    await applyNotionStealth(page); // 非対応ブラウザゲート回避(UA→Chrome138)
    await injectEagerImages(page); // 遅延画像(アバター)を即読込させる
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(13000); // タイムライン/ボードのレンダリング待ち

    if (await isNotionLoggedOut(page)) {
      console.warn("captureAssigneeBoards: Notion session expired");
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
    const targetUrl = toAppNotionUrl(timelineUrl);
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
    await applyNotionStealth(page); // 非対応ブラウザゲート回避(UA→Chrome138)
    await injectEagerImages(page);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(13000);
    if (await isNotionLoggedOut(page)) return { ok: false, reason: "session expired" };

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
    const targetUrl = toAppNotionUrl(timelineUrl);
    br = await puppeteer.launch(browser);
    const page = await br.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });

    const ck = normalizeCookies(cookies);
    // @ts-expect-error puppeteer の setCookie はオブジェクト配列を受ける
    await page.setCookie(...ck);

    await applyNotionStealth(page); // 非対応ブラウザゲート回避(UA→Chrome138)
    await injectEagerImages(page); // 遅延画像(アバター)を即読込させる
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(13000);

    if (await isNotionLoggedOut(page)) {
      console.warn("captureNotionTimeline: Notion session expired");
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

/** 診断用: ページに遷移して 最終URL/タイトル/本文/UA/Cookie状況 を返す（スクショなし）。 */
/**
 * 偽装を一切かけずに Browser Rendering の実 Chromium の素性を調べる。
 * 実 userAgent / userAgentData / Notion が要求しそうな JS・CSS 機能の有無を返す。
 */
export async function probeBrowserCapabilities(
  browser: Fetcher | undefined
): Promise<Record<string, unknown>> {
  if (!browser) return { error: "no browser binding" };
  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  let br: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    br = await puppeteer.launch(browser);
    const page = await br.newPage();
    await page.goto("about:blank", { timeout: 15000 }).catch(() => {});
    const probe = `(() => {
      var f = {};
      var t = function(name, fn){ try { f[name] = !!fn(); } catch(e){ f[name] = 'ERR:'+e.message; } };
      t('structuredClone', function(){ return typeof structuredClone === 'function'; });
      t('Array.at', function(){ return typeof [].at === 'function'; });
      t('Object.hasOwn', function(){ return typeof Object.hasOwn === 'function'; });
      t('Array.findLast', function(){ return typeof [].findLast === 'function'; });
      t('crypto.randomUUID', function(){ return typeof (crypto&&crypto.randomUUID) === 'function'; });
      t('ResizeObserver', function(){ return typeof ResizeObserver === 'function'; });
      t('css_has', function(){ return CSS.supports('selector(:has(*))'); });
      t('css_aspect_ratio', function(){ return CSS.supports('aspect-ratio: 1'); });
      t('css_inset', function(){ return CSS.supports('inset: 0'); });
      t('Intl.Segmenter', function(){ return typeof Intl.Segmenter === 'function'; });
      t('regexp_lookbehind', function(){ return /(?<=a)b/.test('ab'); });
      t('BroadcastChannel', function(){ return typeof BroadcastChannel === 'function'; });
      t('OffscreenCanvas', function(){ return typeof OffscreenCanvas === 'function'; });
      return {
        realUserAgent: navigator.userAgent,
        appVersion: navigator.appVersion,
        vendor: navigator.vendor,
        platform: navigator.platform,
        uaDataBrands: navigator.userAgentData ? JSON.stringify(navigator.userAgentData.brands) : 'NO_userAgentData',
        webdriver: navigator.webdriver,
        features: f
      };
    })()`;
    const res = await page.evaluate(probe);
    return res as Record<string, unknown>;
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    if (br) await br.close().catch(() => {});
  }
}

// unsupported-browser への遷移を横取りして、遷移先URLと呼び出し元スタックを記録する。
const REDIRECT_TRAP_SCRIPT = `(() => {
  window.__redir = [];
  window.__trapInstall = {};
  var rec = function(kind, u){
    try {
      if (String(u).indexOf('unsupported') >= 0) {
        window.__redir.push({ kind: kind, url: String(u), stack: (new Error()).stack });
        return true; // 遷移をブロック
      }
    } catch(e){}
    return false;
  };
  // Location.prototype.assign / replace を defineProperty で確実に差し替え
  try {
    var proto = Location.prototype;
    ['assign','replace'].forEach(function(m){
      try {
        var orig = proto[m];
        Object.defineProperty(proto, m, { configurable: true, writable: true, value: function(u){ if(rec(m,u)) return; return orig.call(this, u); } });
        window.__trapInstall[m] = 'ok';
      } catch(e){ window.__trapInstall[m] = 'ERR:'+e.message; }
    });
  } catch(e){ window.__trapInstall.proto = 'ERR:'+e.message; }
  // location.href setter
  try {
    var hd = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (hd && hd.set) {
      Object.defineProperty(Location.prototype, 'href', {
        configurable: true,
        get: function(){ return hd.get.call(this); },
        set: function(v){ if(rec('href',v)) return; hd.set.call(this, v); }
      });
      window.__trapInstall.href = 'ok';
    } else { window.__trapInstall.href = 'no-setter'; }
  } catch(e){ window.__trapInstall.href = 'ERR:'+e.message; }
  // window.location = x （プロパティ代入）
  try {
    var wd = Object.getOwnPropertyDescriptor(window, 'location') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'location');
    if (wd && wd.set) {
      Object.defineProperty(window, 'location', {
        configurable: true,
        get: function(){ return wd.get.call(window); },
        set: function(v){ if(rec('window.location',v)) return; wd.set.call(window, v); }
      });
      window.__trapInstall.winloc = 'ok';
    } else { window.__trapInstall.winloc = 'no-setter'; }
  } catch(e){ window.__trapInstall.winloc = 'ERR:'+e.message; }
  try {
    var _open = window.open;
    window.open = function(u){ if(rec('open',u)) return null; return _open.apply(window, arguments); };
    window.__trapInstall.open = 'ok';
  } catch(e){ window.__trapInstall.open = 'ERR:'+e.message; }
  // meta refresh 検出
  try {
    var mo = new MutationObserver(function(muts){
      muts.forEach(function(mu){
        (mu.addedNodes||[]).forEach(function(n){
          try {
            if (n.tagName === 'META' && /refresh/i.test(n.getAttribute('http-equiv')||'')) {
              var c = n.getAttribute('content')||'';
              if (c.indexOf('unsupported') >= 0) { window.__redir.push({ kind:'meta-refresh', url:c, stack:'(meta)' }); n.remove(); }
            }
          } catch(e){}
        });
      });
    });
    mo.observe(document.documentElement, { childList:true, subtree:true });
  } catch(e){}
})()`;

export async function debugNotionRedirectTrap(
  browser: Fetcher | undefined,
  cookies: SessionCookie[] | null,
  url: string
): Promise<Record<string, unknown>> {
  if (!browser) return { error: "no browser binding" };
  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  let br: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    const targetUrl = toAppNotionUrl(url);
    br = await puppeteer.launch(browser);
    const page = await br.newPage();
    await page.setViewport({ width: 1280, height: 1400, deviceScaleFactor: 2 });
    const MODERN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
    await (page as { setUserAgent?: (ua: string) => Promise<unknown> }).setUserAgent?.(MODERN_UA).catch(() => {});
    const eod = (page as { evaluateOnNewDocument?: (s: string) => Promise<unknown> }).evaluateOnNewDocument;
    if (typeof eod === "function") {
      await eod.call(page, NOTION_STEALTH_SCRIPT).catch(() => {});
      await eod.call(page, REDIRECT_TRAP_SCRIPT).catch(() => {});
    }
    if (cookies && cookies.length) {
      const ck = normalizeCookies(cookies);
      // @ts-expect-error
      await page.setCookie(...ck).catch(() => {});
    }
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(10000);
    const trap = (await page.evaluate("({ redir: window.__redir||[], install: window.__trapInstall||{}, here: location.href, title: document.title, text: (document.body&&document.body.innerText||'').slice(0,200) })")) as Record<string, unknown>;
    return { requestedUrl: url, targetUrl, finalUrl: page.url(), ...trap };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    if (br) await br.close().catch(() => {});
  }
}

export async function debugNotionPageInfo(
  browser: Fetcher | undefined,
  cookies: SessionCookie[] | null,
  url: string,
  jsEnabled = true
): Promise<Record<string, unknown>> {
  if (!browser) return { error: "no browser binding" };
  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  let br: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    const targetUrl = toAppNotionUrl(url);
    br = await puppeteer.launch(browser);
    const page = await br.newPage();
    if (!jsEnabled) {
      await (page as { setJavaScriptEnabled?: (b: boolean) => Promise<unknown> }).setJavaScriptEnabled?.(false).catch(() => {});
    }
    const MODERN_UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
    const setUaOk = await (page as { setUserAgent?: (ua: string) => Promise<unknown> })
      .setUserAgent?.(MODERN_UA).then(() => true).catch(() => false);
    if (typeof (page as { evaluateOnNewDocument?: unknown }).evaluateOnNewDocument === "function") {
      await (page as { evaluateOnNewDocument: (s: string) => Promise<unknown> })
        .evaluateOnNewDocument(NOTION_STEALTH_SCRIPT).catch(() => {});
    }
    const cookieInfo = (cookies ?? []).map((c) => ({ name: c.name, domain: c.domain, expires: c.expires ?? null }));
    if (cookies && cookies.length) {
      const ck = normalizeCookies(cookies);
      // @ts-expect-error
      await page.setCookie(...ck).catch(() => {});
    }
    // Client Hints ヘッダ(Sec-CH-UA)を本物のChrome相当にする（Browser Rendering は空で送るため）
    await (page as { setExtraHTTPHeaders?: (h: Record<string, string>) => Promise<unknown> })
      .setExtraHTTPHeaders?.({
        "sec-ch-ua": '"Chromium";v="138", "Google Chrome";v="138", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"'
      }).catch(() => {});
    const resp = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    let redirectChain: string[] = [];
    let respStatus: number | null = null;
    try {
      respStatus = resp ? (resp as { status: () => number }).status() : null;
      const req = resp ? (resp as { request: () => { redirectChain: () => Array<{ url: () => string }> } }).request() : null;
      redirectChain = req ? req.redirectChain().map((r) => r.url()) : [];
    } catch { /* ignore */ }
    await sleep(jsEnabled ? 8000 : 1500);
    const info = (await page.evaluate(
      "({ua: navigator.userAgent, uaData: (navigator.userAgentData ? JSON.stringify(navigator.userAgentData.brands) : 'none'), webdriver: navigator.webdriver, hasChrome: (typeof window.chrome), plugins: (navigator.plugins?navigator.plugins.length:0), langs: JSON.stringify(navigator.languages||[]), outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight, screenW: screen.width, screenH: screen.height, dpr: window.devicePixelRatio, hwc: navigator.hardwareConcurrency, devMem: navigator.deviceMemory, conn: (navigator.connection?navigator.connection.effectiveType:'none'), hasWebGL: (function(){try{return !!document.createElement('canvas').getContext('webgl')}catch(e){return 'ERR'}})(), hasLS: (function(){try{return !!window.localStorage}catch(e){return 'ERR'}})(), hasSW: ('serviceWorker' in navigator), maxTouch: navigator.maxTouchPoints, title: document.title, text: (document.body&&document.body.innerText||'').slice(0,300)})"
    )) as Record<string, unknown>;
    return {
      requestedUrl: url,
      targetUrl,
      finalUrl: page.url(),
      httpStatus: respStatus,
      redirectChain,
      jsEnabled,
      setUserAgentSupported: setUaOk,
      navigatorUserAgent: info.ua,
      userAgentDataBrands: info.uaData,
      verifyWebdriver: info.webdriver,
      verifyHasChrome: info.hasChrome,
      verifyPlugins: info.plugins,
      verifyLanguages: info.langs,
      win: { outerW: info.outerW, outerH: info.outerH, innerW: info.innerW, innerH: info.innerH, screenW: info.screenW, screenH: info.screenH, dpr: info.dpr },
      env: { hwc: info.hwc, devMem: info.devMem, conn: info.conn, hasWebGL: info.hasWebGL, hasLS: info.hasLS, hasSW: info.hasSW, maxTouch: info.maxTouch },
      title: info.title,
      bodyText: info.text,
      cookieCount: cookieInfo.length
    };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    if (br) await br.close().catch(() => {});
  }
}

/**
 * 任意の Notion ページ(URL)をセッションCookieでログインして全画面スクショする。
 * 日次のページ共有(例: スプリントページ)用。
 */
/** デイリー KPI表の検出/計測のデバッグ。テーブルブロック数と各寸法を返す。 */
export async function debugNotionTableMeasure(
  browser: Fetcher | undefined,
  cookies: SessionCookie[] | null,
  url: string
): Promise<Record<string, unknown>> {
  if (!browser || !cookies) return { error: "no browser/cookies" };
  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  let br: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    const targetUrl = toAppNotionUrl(url);
    br = await puppeteer.launch(browser);
    const page = await br.newPage();
    await page.setViewport({ width: 1280, height: 1400, deviceScaleFactor: 2 });
    await applyNotionStealth(page);
    await injectEagerImages(page);
    const ck = normalizeCookies(cookies);
    // @ts-expect-error
    await page.setCookie(...ck);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(13000);
    const cols = await page.evaluate(`(() => {
      var blocks = Array.from(document.querySelectorAll('.notion-table-block'));
      var pick=null,best=-1; blocks.forEach(function(b){var r=b.getBoundingClientRect();if(r.width*r.height>best){best=r.width*r.height;pick=b;}});
      if(!pick) return null;
      var t = pick.querySelector('table'); if(!t) return null;
      var rows = t.rows;
      var headerCells = rows && rows[0] ? Array.from(rows[0].cells).map(function(c){return (c.innerText||'').trim().slice(0,12);}) : [];
      return { tableW: t.scrollWidth, rowCount: rows?rows.length:0, colCount: rows&&rows[0]?rows[0].cells.length:0, headers: headerCells };
    })()`);
    const out = await page.evaluate(`(() => {
      // 最大面積のシンプルテーブルを特定し、内側<table>から外側へ祖先チェーンの
      // クラス/overflow/幅 をダンプ（横クリップしている要素を見つけるため）
      var blocks = Array.from(document.querySelectorAll('.notion-table-block'));
      var pick = null, best = -1;
      blocks.forEach(function(b){ var r=b.getBoundingClientRect(); if(r.width*r.height>best){best=r.width*r.height;pick=b;} });
      var chain = [];
      if (pick) {
        var t = pick.querySelector('table');
        var node = t || pick;
        for (var i=0; i<6 && node; i++) {
          var cs = getComputedStyle(node);
          var r = node.getBoundingClientRect();
          chain.push({ tag: node.tagName, cls: (node.className||'').toString().slice(0,80), ovx: cs.overflowX, w: Math.round(r.width), sw: node.scrollWidth, mw: cs.maxWidth });
          node = node.parentElement;
        }
      }
      return { finalUrl: location.href, title: document.title, tableBlocks: blocks.length, chain: chain };
    })()`);
    return { targetUrl, cols, ...(out as Record<string, unknown>) };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    if (br) await br.close().catch(() => {});
  }
}

export async function captureNotionPage(
  browser: Fetcher | undefined,
  cookies: SessionCookie[] | null,
  url: string,
  avatarMap?: Record<string, string>,
  clipToTable = false,
  matchLabel?: string
): Promise<Uint8Array | null> {
  if (!browser || !cookies || cookies.length === 0) return null;

  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  let br: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    const targetUrl = toAppNotionUrl(url);
    br = await puppeteer.launch(browser);
    const page = await br.newPage();
    // テーブル切出し時は最初から広く開く（Notion シンプルテーブルは可視幅でクリップされ、
    // 狭いと右側の列(6/22,6/23,KPIポイント)が描画されないため）。
    await page.setViewport({ width: clipToTable ? 1920 : 1280, height: clipToTable ? 2400 : 1400, deviceScaleFactor: 2 });

    // Notion の「非対応ブラウザ」ゲート回避: HTTPヘッダ + クライアント側 navigator を最新Chromeに偽装
    const MODERN_UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
    await (page as { setUserAgent?: (ua: string) => Promise<unknown> }).setUserAgent?.(MODERN_UA).catch(() => {});
    if (typeof (page as { evaluateOnNewDocument?: unknown }).evaluateOnNewDocument === "function") {
      await (page as { evaluateOnNewDocument: (s: string) => Promise<unknown> })
        .evaluateOnNewDocument(
          `try{Object.defineProperty(navigator,'userAgent',{get:()=>${JSON.stringify(MODERN_UA)}});}catch(e){}` +
          `try{Object.defineProperty(navigator,'webdriver',{get:()=>false});}catch(e){}` +
          `try{Object.defineProperty(navigator,'appVersion',{get:()=>'5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'});}catch(e){}`
        ).catch(() => {});
    }

    const ck = normalizeCookies(cookies);
    // @ts-expect-error puppeteer の setCookie はオブジェクト配列を受ける
    await page.setCookie(...ck);

    await injectEagerImages(page);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(13000);

    if (await isNotionLoggedOut(page)) {
      console.warn("captureNotionPage: Notion session expired");
      return null;
    }

    await page.addStyleTag({
      content: `.notion-sidebar-container,.notion-sidebar,[class*="sidebar"]{display:none!important}
        .notion-topbar{display:none!important}`,
    });
    await sleep(2000);
    await ensureAvatarsLoaded(page, avatarMap);

    if (clipToTable) {
      // シンプルテーブルは内側スクローラで横クリップされ右端の列(6/23,KPI等)が描画されない。
      // 横クリップを解除して全幅を描画させ、内側<table>の実寸で clip する。
      await page.addStyleTag({
        content: `.notion-table-block, .notion-table-block > div, .notion-table-block .notion-scroller {
          overflow: visible !important; max-width: none !important; width: max-content !important; }
          table { width: max-content !important; }`,
      }).catch(() => {});
      await sleep(1500);
      // matchLabel 指定時はそのテキストを含む表を優先（ページ内に複数の週次表がある場合の対象特定）。
      // 無ければ最大面積のシンプルテーブルの内側<table>の矩形を計測（=全幅）。
      const MEASURE = `(() => {
        var blocks = Array.from(document.querySelectorAll('.notion-table-block'));
        var matchLabel = ${JSON.stringify(matchLabel || null)};
        var pick = null;
        if (matchLabel) {
          var matched = blocks.find(function(b){ return (b.innerText || '').indexOf(matchLabel) !== -1; });
          if (matched) pick = matched.querySelector('table') || matched;
        }
        if (!pick) {
          var bestArea = -1;
          blocks.forEach(function(b){
            var t = b.querySelector('table') || b;
            var r = t.getBoundingClientRect();
            var area = r.width * r.height;
            if (area > bestArea) { bestArea = area; pick = t; }
          });
        }
        if (!pick) return null;
        var r = pick.getBoundingClientRect();
        // 左端の列（スキルカテゴリ/KPI名等）が数px単位のクリップで先頭文字ごと欠けることがあるため、
        // 余白を広めに取って全方向とも安全にクリップする。
        return { x: Math.max(r.left + window.scrollX - 24, 0), y: Math.max(r.top + window.scrollY - 24, 0), width: Math.ceil(r.width) + 48, height: Math.ceil(r.height) + 48 };
      })()`;
      const rect = (await page.evaluate(MEASURE)) as { x: number; y: number; width: number; height: number } | null;
      if (rect && rect.width > 0 && rect.height > 0) {
        // テーブル全体(全幅・全高)が描画されるようビューポートを拡張
        const vw = Math.min(Math.ceil(rect.x + rect.width + 60), 4000);
        const vh = Math.min(Math.ceil(rect.y + rect.height + 80), 8000);
        await page.setViewport({ width: Math.max(vw, 1920), height: Math.max(vh, 2400), deviceScaleFactor: 2 });
        await sleep(1500);
        await ensureAvatarsLoaded(page, avatarMap);
        const clip = ((await page.evaluate(MEASURE)) as { x: number; y: number; width: number; height: number } | null) || rect;
        try {
          const png = (await page.screenshot({ type: "png", clip })) as Uint8Array;
          console.log(`captureNotionPage: table clip ${clip.width}x${clip.height} ${targetUrl}`);
          return png;
        } catch (e) {
          console.warn(`captureNotionPage: clip screenshot failed (${(e as Error).message}), fallback fullPage`);
        }
      } else {
        console.warn("captureNotionPage: table not found, fallback fullPage");
      }
    }

    const png = (await page.screenshot({ type: "png", fullPage: true })) as Uint8Array;
    console.log(`captureNotionPage: captured ${targetUrl}`);
    return png;
  } catch (err) {
    console.warn(`captureNotionPage error: ${(err as Error).message}`);
    return null;
  } finally {
    if (br) await br.close().catch(() => {});
  }
}
