import type { Bindings, AppConfig } from "./config";
import { getConfig } from "./config";
import { fetchMembers } from "./memberApi";
import { fetchNotionUserMap, buildUserMapFromDatabase } from "./notionWriter";
import { usersInfo } from "./slackBot";

const CACHE_TTL_SECONDS = 25 * 3600; // 25h: 1日cronが落ちても前日キャッシュで凌ぐ
const CACHE_KEY = (teamFilter: string) => `team-users-cache:${teamFilter}`;

/**
 * 担当者解決に必要な情報を1メンバー分まとめたもの。
 * 構築には Slack users.info / Notion users.list を叩くため毎回は重い → KVキャッシュする。
 */
export interface CachedUser {
  /** Notion ユーザー ID（担当者プロパティにセットする値）。未解決なら undefined */
  notionUserId?: string;
  /** Slack ユーザー ID（@メンション解決用） */
  slackUserId?: string;
  /** メンバーDB上の正式名（表示用） */
  name: string;
  /** 漢字/ローマ字/Slack表示名/トークン等のエイリアス（生文字列） */
  aliases: string[];
}

export interface UserCacheEntry {
  users: CachedUser[];
  refreshedAt: string;
}

const HONORIFIC_RE = /(さん|くん|ちゃん|様|さま|殿|氏|君|san|kun|chan)$/iu;

/** 曖昧マッチ用に名前を正規化: 敬称除去 / 小文字化 / 空白記号除去 / NFKC */
export function normalizeName(s: string): string {
  return s
    .replace(HONORIFIC_RE, "")
    .toLowerCase()
    .replace(/[\s　・,，.、]/g, "")
    .normalize("NFKC")
    .trim();
}

/**
 * メンバー1人分のエイリアス集合と Notion ユーザー ID を構築する。
 * (旧 buildAssigneeResolver の per-member 計算を移植)
 */
async function buildEntry(
  m: { name: string; slackUserId?: string },
  notionUserMap: Map<string, string>,
  dbUserMap: Map<string, string> | undefined,
  memberExtra: Record<string, string>,
  slackToken: string | undefined,
  isExcluded: (n: string) => boolean
): Promise<CachedUser> {
  const aliases = new Set<string>([m.name]);
  const extraTarget = memberExtra[m.name];
  if (extraTarget) aliases.add(extraTarget);

  if (slackToken && m.slackUserId) {
    const info = await usersInfo(slackToken, m.slackUserId).catch(() => null);
    if (info) {
      if (info.realName) aliases.add(info.realName);
      if (info.displayName) {
        // "Matsuda Naoki_毎週月曜大学院" のような接尾辞を除去
        const cleaned = info.displayName.split(/[_(（【]/)[0].trim();
        if (cleaned) aliases.add(cleaned);
      }
    }
  }

  // 複数語名はトークン分割して "Matsuda Naoki" → "Matsuda" / "Naoki" もマッチ
  for (const a of [...aliases]) {
    const tokens = a.split(/[\s　]+/).filter((t) => t.length >= 2);
    if (tokens.length > 1) for (const t of tokens) aliases.add(t);
  }

  // いずれかのエイリアスを Notion マップに照合して Notion ユーザー ID を確定
  let notionUserId: string | undefined;
  const maps = dbUserMap ? [dbUserMap, notionUserMap] : [notionUserMap];
  // Pass 1: 完全一致
  for (const alias of aliases) {
    if (isExcluded(alias)) continue;
    for (const map of maps) {
      const id = map.get(alias);
      if (id) { notionUserId = id; break; }
    }
    if (notionUserId) break;
  }
  // Pass 2: 部分一致（双方向の部分文字列）
  if (!notionUserId) {
    outer: for (const alias of aliases) {
      if (isExcluded(alias)) continue;
      for (const map of maps) {
        for (const [notionName, id] of map) {
          if (isExcluded(notionName)) continue;
          if (notionName.includes(alias) || alias.includes(notionName)) {
            notionUserId = id;
            break outer;
          }
        }
      }
    }
  }

  if (!notionUserId) {
    console.warn(`buildUserCatalog: no Notion user matched for "${m.name}" (aliases: ${[...aliases].join(", ")})`);
  }

  return { notionUserId, slackUserId: m.slackUserId, name: m.name, aliases: [...aliases] };
}

/**
 * チームのユーザーカタログをライブ構築する（Slack/Notion API を叩く重い処理）。
 */
export async function buildUserCatalog(config: AppConfig): Promise<CachedUser[]> {
  const excludeList = config.memberExclude ?? [];
  const isExcluded = (n: string): boolean =>
    excludeList.some((ex) => n.includes(ex) || ex.includes(n));
  const memberExtra = config.memberExtra ?? {};

  const [members, notionUserMap, dbUserMap] = await Promise.all([
    fetchMembers(config).catch(() => []),
    fetchNotionUserMap(config.notionToken).catch(() => new Map<string, string>()),
    config.taskDbId
      ? buildUserMapFromDatabase(config.notionToken, config.taskDbId).catch(() => new Map<string, string>())
      : Promise.resolve(new Map<string, string>())
  ]);

  return Promise.all(
    members.map((m) =>
      buildEntry(m, notionUserMap, dbUserMap, memberExtra, config.slackBotToken, isExcluded)
    )
  );
}

export async function getCachedUsers(
  kv: KVNamespace,
  teamFilter: string
): Promise<CachedUser[]> {
  const raw = await kv.get(CACHE_KEY(teamFilter));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as UserCacheEntry;
    return parsed.users ?? [];
  } catch {
    return [];
  }
}

export async function saveCachedUsers(
  kv: KVNamespace,
  teamFilter: string,
  users: CachedUser[]
): Promise<void> {
  const entry: UserCacheEntry = { users, refreshedAt: new Date().toISOString() };
  await kv.put(CACHE_KEY(teamFilter), JSON.stringify(entry), {
    expirationTtl: CACHE_TTL_SECONDS
  });
}

/**
 * ユーザーカタログを更新して KV に保存する（cron / 手動 から呼ばれる）。
 */
export async function refreshUserCatalog(env: Bindings): Promise<{ count: number; teamFilter: string }> {
  const config = getConfig(env);
  const teamFilter = config.teamFilter;
  try {
    const users = await buildUserCatalog(config);
    await saveCachedUsers(env.NOTIFY_CACHE, teamFilter, users);
    console.log(`refreshUserCatalog: cached ${users.length} users for team="${teamFilter}"`);
    return { count: users.length, teamFilter };
  } catch (err) {
    console.warn(`refreshUserCatalog failed: ${(err as Error).message}`);
    return { count: 0, teamFilter };
  }
}

/**
 * キャッシュ取得 + 空ならライブ構築を試みる（コールドスタート対策）。
 */
export async function ensureUserCatalog(
  env: Bindings,
  config: AppConfig
): Promise<CachedUser[]> {
  const cached = await getCachedUsers(env.NOTIFY_CACHE, config.teamFilter);
  if (cached.length > 0) return cached;
  try {
    const users = await buildUserCatalog(config);
    await saveCachedUsers(env.NOTIFY_CACHE, config.teamFilter, users);
    console.log(`ensureUserCatalog: cold-start cached ${users.length} users`);
    return users;
  } catch (err) {
    console.warn(`ensureUserCatalog cold-start failed: ${(err as Error).message}`);
    return [];
  }
}

export type AssigneeResolver = (rawName: string) => string | undefined;

/**
 * キャッシュ済みカタログから「名前 → Notion ユーザー ID」を引く決定的リゾルバを作る。
 * (旧 buildAssigneeResolver の返り値部分を移植。API 呼び出しは一切しない)
 */
export function makeAssigneeResolver(users: CachedUser[]): AssigneeResolver {
  const resolveMap = new Map<string, string>();
  for (const u of users) {
    if (!u.notionUserId) continue;
    for (const alias of u.aliases) {
      const norm = normalizeName(alias);
      if (norm.length >= 2 && !resolveMap.has(norm)) {
        resolveMap.set(norm, u.notionUserId);
      }
    }
  }

  return (rawName: string): string | undefined => {
    const norm = normalizeName(rawName);
    if (!norm || norm.length < 2) return undefined;
    const direct = resolveMap.get(norm);
    if (direct) {
      console.log(`Assignee resolved: "${rawName}" → notionUserId=${direct}`);
      return direct;
    }
    for (const [alias, id] of resolveMap) {
      if (alias.includes(norm) || norm.includes(alias)) {
        console.log(`Assignee resolved (partial): "${rawName}" → alias="${alias}" → notionUserId=${id}`);
        return id;
      }
    }
    console.log(`Assignee unresolved: "${rawName}" (normalized="${norm}")`);
    return undefined;
  };
}

/**
 * メッセージ本文を走査し、別名がカタログに一致するメンバーを返す（ルールベース抽出）。
 * 正規化した本文に、各メンバーの正規化別名(2文字以上)が部分文字列として含まれるかで判定。
 * ちょうど1人に絞れたとき呼び出し側が採用し、0人/複数のときは LLM 抽出値へフォールバックする。
 */
export function extractAssigneesFromText(
  users: CachedUser[],
  text: string
): CachedUser[] {
  const nText = normalizeName(text ?? "");
  if (!nText) return [];
  const seen = new Set<string>();
  const matches: CachedUser[] = [];
  for (const u of users) {
    if (!u.notionUserId) continue;
    const hit = u.aliases.some((a) => {
      const n = normalizeName(a);
      return n.length >= 2 && nText.includes(n);
    });
    if (hit && !seen.has(u.notionUserId)) {
      seen.add(u.notionUserId);
      matches.push(u);
    }
  }
  return matches;
}

/**
 * Notion 担当者名（漢字/ローマ字など表記揺れあり）→ Slack ユーザー ID を、
 * カタログの別名照合（正規化→完全一致→部分一致）で引く。タスクリマインドのメンション用。
 * 例: "Matsuda Naoki"(ローマ字) でも別名に持つ "松田" の slackUserId を返す。
 */
export function resolveSlackUserIdByName(
  users: CachedUser[],
  rawName: string
): string | undefined {
  const norm = normalizeName(rawName);
  if (!norm || norm.length < 2) return undefined;
  // Pass 1: 正規化した別名との完全一致
  for (const u of users) {
    if (!u.slackUserId) continue;
    if (u.aliases.some((a) => normalizeName(a) === norm)) return u.slackUserId;
  }
  // Pass 2: 双方向の部分一致（2文字以上）
  for (const u of users) {
    if (!u.slackUserId) continue;
    for (const alias of u.aliases) {
      const a = normalizeName(alias);
      if (a.length >= 2 && (a.includes(norm) || norm.includes(a))) return u.slackUserId;
    }
  }
  return undefined;
}

/**
 * Notion 担当者名（表記揺れあり）→ カタログのメンバーを引く（別名照合）。
 * メンバーDB上の短い名前(苗字)を得る用途。
 */
export function resolveMemberByName(
  users: CachedUser[],
  rawName: string
): CachedUser | null {
  const norm = normalizeName(rawName);
  if (!norm || norm.length < 2) return null;
  for (const u of users) {
    if (u.aliases.some((a) => normalizeName(a) === norm)) return u;
  }
  for (const u of users) {
    for (const alias of u.aliases) {
      const a = normalizeName(alias);
      if (a.length >= 2 && (a.includes(norm) || norm.includes(a))) return u;
    }
  }
  return null;
}

/**
 * Slack ユーザー ID からカタログのメンバーを引く（@メンション解決用）。
 */
export function resolveMemberBySlackId(
  users: CachedUser[],
  slackUserId: string
): CachedUser | null {
  if (!slackUserId) return null;
  return users.find((u) => u.slackUserId === slackUserId) ?? null;
}
