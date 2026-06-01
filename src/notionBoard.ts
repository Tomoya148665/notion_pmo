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

/**
 * 各担当者の Notion ボードを切り出してPNGで返す。
 * browser/cookies が無い場合は空配列（呼び出し側でスキップ）。
 */
export async function captureAssigneeBoards(
  browser: Fetcher | undefined,
  cookies: SessionCookie[] | null,
  boardUrl: string = DEFAULT_NOTION_BOARD_URL
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

/**
 * Notion タイムラインビュー(ガントチャート)をスクショして PNG で返す。
 * browser/cookies が無い、またはセッション失効時は null。
 */
export async function captureNotionTimeline(
  browser: Fetcher | undefined,
  cookies: SessionCookie[] | null,
  timelineUrl: string = DEFAULT_NOTION_TIMELINE_URL
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
