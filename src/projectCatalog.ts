import type { Bindings, AppConfig } from "./config";
import { getConfig } from "./config";
import { withRetry } from "./retry";

const NOTION_VERSION = "2022-06-28";
const CACHE_TTL_SECONDS = 25 * 3600; // 25h: 1日cronが落ちても前日キャッシュで凌ぐ
const CACHE_KEY = (teamFilter: string) => `team-projects-cache:${teamFilter}`;

export interface CachedProject {
  id: string;
  name: string;
  team: string;
}

export interface ProjectCacheEntry {
  projects: CachedProject[];
  refreshedAt: string;
}

const normalize = (s: string): string =>
  s.trim().toLowerCase().replace(/[\s　]+/g, "");

export async function crawlTeamProjects(
  notionToken: string,
  projectDbId: string,
  teamFilter: string
): Promise<CachedProject[]> {
  const projects: CachedProject[] = [];
  let startCursor: string | undefined;
  const nFilter = normalize(teamFilter);

  while (true) {
    const body: Record<string, unknown> = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;

    const data = await withRetry(
      async () => {
        const res = await fetch(
          `https://api.notion.com/v1/databases/${projectDbId}/query`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${notionToken}`,
              "Notion-Version": NOTION_VERSION,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          }
        );
        if (!res.ok) {
          const detail = await res.text();
          throw new Error(`Notion project DB query error: ${res.status} ${detail}`);
        }
        return (await res.json()) as {
          results: Array<{
            id: string;
            properties?: Record<string, unknown>;
          }>;
          next_cursor?: string;
          has_more?: boolean;
        };
      },
      { label: "Notion crawlTeamProjects" }
    );

    for (const page of data.results) {
      const props = (page.properties ?? {}) as Record<string, unknown>;
      const teamProp = props["チーム"] as { select?: { name?: string } } | undefined;
      const teamName = teamProp?.select?.name;
      if (!teamName) continue;
      if (normalize(teamName) !== nFilter) continue;

      let title = "";
      for (const prop of Object.values(props)) {
        const p = prop as { type?: string; title?: Array<{ plain_text?: string }> };
        if (p?.type === "title" && Array.isArray(p.title)) {
          title = p.title.map((t) => t.plain_text ?? "").join("").trim();
          break;
        }
      }
      if (!title) continue;

      projects.push({ id: page.id, name: title, team: teamName });
    }

    if (!data.has_more || !data.next_cursor) break;
    startCursor = data.next_cursor;
  }

  return projects;
}

export async function getCachedProjects(
  kv: KVNamespace,
  teamFilter: string
): Promise<CachedProject[]> {
  const raw = await kv.get(CACHE_KEY(teamFilter));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ProjectCacheEntry;
    return parsed.projects ?? [];
  } catch {
    return [];
  }
}

export async function saveCachedProjects(
  kv: KVNamespace,
  teamFilter: string,
  projects: CachedProject[]
): Promise<void> {
  const entry: ProjectCacheEntry = {
    projects,
    refreshedAt: new Date().toISOString()
  };
  await kv.put(CACHE_KEY(teamFilter), JSON.stringify(entry), {
    expirationTtl: CACHE_TTL_SECONDS
  });
}

/**
 * キャッシュ済みプロジェクト一覧から、与えられた名前にもっとも近い1件を返す。
 * 揺らぎ許容: 正規化(trim/lowercase/空白除去)後の完全一致 → 部分一致(名前長差最小)。
 */
export function resolveProjectFromCache(
  projects: CachedProject[],
  name: string
): CachedProject | null {
  if (!name) return null;
  const nQuery = normalize(name);
  if (!nQuery) return null;

  let exact: CachedProject | null = null;
  const partial: CachedProject[] = [];

  for (const p of projects) {
    const nName = normalize(p.name);
    if (nName === nQuery) {
      exact = p;
      break;
    }
    if (nName.includes(nQuery) || nQuery.includes(nName)) {
      partial.push(p);
    }
  }

  if (exact) return exact;
  if (partial.length === 0) return null;

  partial.sort(
    (a, b) => Math.abs(a.name.length - name.length) - Math.abs(b.name.length - name.length)
  );
  return partial[0];
}

/**
 * Slackチャンネル名からプロジェクトを推定する。
 * チャンネル名は "proj-mitsui" のように区切り文字やノイズを含むため、
 * (1) 名前全体での照合 → (2) 区切りで分割したトークンごとの照合 を試す。
 * 例: "proj-mitsui" → トークン "mitsui" がカタログ名に部分一致すれば採用。
 */
export function resolveProjectByChannelName(
  projects: CachedProject[],
  channelName: string
): CachedProject | null {
  if (!channelName) return null;

  // (1) チャンネル名全体での照合
  const whole = resolveProjectFromCache(projects, channelName);
  if (whole) return whole;

  // (2) 区切り文字で分割したトークン（長い順）で照合
  const tokens = channelName
    .split(/[-_/\s　.,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);

  for (const token of tokens) {
    const hit = resolveProjectFromCache(projects, token);
    if (hit) return hit;
  }
  return null;
}

/**
 * 与えられたクエリに近い順でプロジェクト候補を返す（未マッチ時の聞き返し用）。
 * 部分一致するものを名前長の近さ順で優先し、足りなければ残りのカタログで埋める。
 */
export function topProjectCandidates(
  projects: CachedProject[],
  query: string,
  limit = 10
): CachedProject[] {
  const nQuery = normalize(query ?? "");
  const matched: CachedProject[] = [];
  const rest: CachedProject[] = [];

  for (const p of projects) {
    const nName = normalize(p.name);
    if (nQuery && (nName.includes(nQuery) || nQuery.includes(nName))) {
      matched.push(p);
    } else {
      rest.push(p);
    }
  }
  matched.sort(
    (a, b) => Math.abs(a.name.length - query.length) - Math.abs(b.name.length - query.length)
  );
  return [...matched, ...rest].slice(0, limit);
}

/**
 * メッセージ本文を走査し、カタログのプロジェクト名が出現するものを返す（ルールベース抽出）。
 * 正規化した本文に、正規化したプロジェクト名(2文字以上)が部分文字列として含まれるかで判定。
 * 高精度優先（フルネーム一致）。言い換え等で取りこぼした場合は呼び出し側がLLM値にフォールバックする。
 */
export function extractProjectFromText(
  projects: CachedProject[],
  text: string
): CachedProject[] {
  const nText = normalize(text ?? "");
  if (!nText) return [];
  const seen = new Set<string>();
  const matches: CachedProject[] = [];
  for (const p of projects) {
    const nName = normalize(p.name);
    if (nName.length >= 2 && nText.includes(nName) && !seen.has(p.id)) {
      seen.add(p.id);
      matches.push(p);
    }
  }
  return matches;
}

/**
 * プロジェクトカタログを更新してKVに保存する。
 * cron / 手動エンドポイント / コールドスタート時のフェイルセーフから呼ばれる。
 */
export async function refreshProjectCatalog(env: Bindings): Promise<{ count: number; teamFilter: string }> {
  const config = getConfig(env);
  const teamFilter = config.teamFilter;
  if (!config.projectDbId) {
    console.warn("refreshProjectCatalog: PROJECT_DB_ID is not set, skipping");
    return { count: 0, teamFilter };
  }
  try {
    const projects = await crawlTeamProjects(config.notionToken, config.projectDbId, teamFilter);
    await saveCachedProjects(env.NOTIFY_CACHE, teamFilter, projects);
    console.log(`refreshProjectCatalog: cached ${projects.length} projects for team="${teamFilter}"`);
    return { count: projects.length, teamFilter };
  } catch (err) {
    console.warn(`refreshProjectCatalog failed: ${(err as Error).message}`);
    return { count: 0, teamFilter };
  }
}

/**
 * キャッシュ取得+空ならフェッチを試みる。コールドスタート対策。
 * フェッチに失敗しても空配列を返すだけで起票自体は止めない。
 */
export async function ensureProjectCatalog(
  env: Bindings,
  config: AppConfig
): Promise<CachedProject[]> {
  const cached = await getCachedProjects(env.NOTIFY_CACHE, config.teamFilter);
  if (cached.length > 0) return cached;
  if (!config.projectDbId) return [];
  try {
    const projects = await crawlTeamProjects(config.notionToken, config.projectDbId, config.teamFilter);
    await saveCachedProjects(env.NOTIFY_CACHE, config.teamFilter, projects);
    console.log(`ensureProjectCatalog: cold-start cached ${projects.length} projects`);
    return projects;
  } catch (err) {
    console.warn(`ensureProjectCatalog cold-start failed: ${(err as Error).message}`);
    return [];
  }
}
