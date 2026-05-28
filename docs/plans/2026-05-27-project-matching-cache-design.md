# プロジェクトマッチング拡充 — 設計

## 背景と問題

タスク起票時のプロジェクト解決が当てずっぽうで、正しいプロジェクトが入らないことが多い。

現状 ([src/slackEvents.ts:909](../../src/slackEvents.ts#L909), [src/notionWriter.ts:372](../../src/notionWriter.ts#L372)):

1. LLM がスレッド文脈から思いつきの文字列を `project` に返す
2. `searchProjectsByName` が Notion `/v1/search` で部分一致検索
3. 候補の先頭1件を採用

問題点:
- LLM はチームが扱うプロジェクト群を知らないので、命名揺れに弱い
- `/v1/search` を起票毎に叩くので latency と Notion API quota が無駄
- チャンネル名(最強のヒント)が LLM に渡っていない

## 目的

LLM に「このチームが扱うプロジェクト一覧」を事前にキャッシュして渡し、その中から1件選ばせる。
未指定の場合もチャンネル名・スレッド文脈から最適なものを推測できるようにする。

## 設計

### コンポーネント全体像

```
[05:00 cron]                  [起票時]
  │                             │
  ▼                             ▼
crawlTeamProjects()      handleMention()
  │                             │
  ├─ Notion projectDb query     ├─ getCachedProjects() ──→ KV
  │   filter: チーム=TeamK      │
  ▼                             ▼
KV: team-projects-cache    LLM prompt に「候補一覧 + チャンネル名」を埋め込む
  (25h TTL)                     │
                                ▼
                         LLM が project名 を返す
                                │
                                ▼
                         resolveProjectFromCache(name)
                                │
                                ├─ 正規化一致 → ID
                                └─ miss → fallback /v1/search
```

### 1. プロジェクトカタログ層

新規ファイル: `src/projectCatalog.ts`

```ts
export interface CachedProject {
  id: string;
  name: string;
  team: string;          // "TeamK"
}

export interface ProjectCacheEntry {
  projects: CachedProject[];
  refreshedAt: string;   // ISO timestamp
}

export async function crawlTeamProjects(
  notionToken: string,
  projectDbId: string,
  teamFilter: string
): Promise<CachedProject[]>;

export async function getCachedProjects(
  kv: KVNamespace,
  teamFilter: string
): Promise<CachedProject[]>;

export async function saveCachedProjects(
  kv: KVNamespace,
  teamFilter: string,
  projects: CachedProject[]
): Promise<void>;

export function resolveProjectFromCache(
  projects: CachedProject[],
  name: string
): CachedProject | null;

export async function refreshProjectCatalog(env: Bindings): Promise<void>;
```

**クロール仕様**:
- `/v1/databases/{projectDbId}/query` を `page_size: 100` で全件取得 (pagination 対応)
- `properties["チーム"]` (select) の `select.name` が `teamFilter` と完全一致するもののみ採用
- 名前は title プロパティから抽出 (`searchProjectsByName` と同様)

**KV キー**: `team-projects-cache:{teamFilter}` (例: `team-projects-cache:TeamK`)
**TTL**: 25時間 (cron が1日休んでも前日キャッシュで凌げる)

**resolveProjectFromCache の正規化ルール** (揺らぎ許容):
- 入力 / 候補名どちらも `trim().toLowerCase().replace(/[\s　]+/g, "")` で正規化
- 完全一致 → 即返却
- 入力 ⊆ 候補名 または 候補名 ⊆ 入力 の部分一致 → 名前長差が最小の候補を返却
- 該当なし → null

### 2. クロール起動

**定期実行**: 既存 `0 20 * * *` cron (05:00 JST、SP スナップショット) に相乗り。

`src/index.ts` の `scheduled` ハンドラ内:

```ts
} else if (event.cron === "0 20 * * *") {
  ctx.waitUntil(runProgressSpSnapshot(env, "cron"));
  ctx.waitUntil(refreshProjectCatalog(env));   // ← 追加
}
```

**手動実行用エンドポイント**: `GET /pmo/refresh-projects`
初回ブートストラップと検証用。レスポンスにキャッシュ件数を返す。

**キャッシュ空時のフェイルセーフ**: `handleMention` でキャッシュが空なら同期的に1回クロール (cold start 対策)。失敗しても起票自体は止めない。

### 3. LLM へのコンテキスト注入

`src/schema.ts` の `MentionContext` に2フィールド追加:

```ts
export interface MentionContext {
  // ... 既存 ...
  channelName?: string;            // 例: "proj-mitsui"
  availableProjects?: Array<{ id: string; name: string }>;
}
```

`src/llmAnalyzer.ts` の `interpretMention` プロンプトに、`available_sprints` と同じ場所で追加:

```
available_projects: チームが対応中のプロジェクト一覧。create_task の project には
このリストに存在する name を必ず使うこと(リスト外の名前を返してはならない)。
判断手順:
1. ユーザーが明示的にプロジェクト名を指定 → その名前にもっとも近い候補を選ぶ
2. 明示なし → channel_name と thread_context, task_name の総合判断で最適な1件を選ぶ
3. 候補のどれにも当てはまらない → null (デフォルトプロジェクトが使われる)
4. 「プロジェクトなし」と明示 → "" (空文字)
```

`src/slackEvents.ts` の `handleMention` で `channelName` と `availableProjects` を取得して context に詰める:

```ts
const channelInfo = await conversationsInfo(config.slackBotToken, channel);
const availableProjects = (await getCachedProjects(env.NOTIFY_CACHE, config.teamFilter))
  .map(p => ({ id: p.id, name: p.name }));
mentionContext.channelName = channelInfo.name;
mentionContext.availableProjects = availableProjects;
```

### 4. 起票時の解決パス差し替え

`src/slackEvents.ts:904-920` のプロジェクト解決ブロックを書き換え:

```ts
} else if (newTask.project) {
  // 1) キャッシュ参照
  const cached = await getCachedProjects(env.NOTIFY_CACHE, config.teamFilter);
  const hit = resolveProjectFromCache(cached, newTask.project);
  if (hit) {
    resolvedProjectIds = [hit.id];
    projectDisplay = hit.name;
  } else {
    // 2) フォールバック: 旧 /v1/search
    const candidates = await searchProjectsByName(config.notionToken, newTask.project, config.projectDbId);
    if (candidates.length === 0) {
      resolvedProjectIds = [];
      projectDisplay = `${newTask.project}(⚠️ 未検出、プロジェクト未設定)`;
    } else {
      resolvedProjectIds = [candidates[0].id];
      projectDisplay = candidates[0].name;
    }
  }
}
```

LLM は `available_projects` リストにある名前しか返さないので、フォールバックは新規プロジェクト追加直後など稀なケースに限定される。

`searchProjectsByName` 自体は残す ([src/slackEvents.ts](../../src/slackEvents.ts) の `update_project` アクションでも使用中)。

## エラー処理

| ケース | 動作 |
|---|---|
| クロール失敗 | warn ログ、旧キャッシュ継続使用 |
| `PROJECT_DB_ID` 未設定 | キャッシュは空配列、現行動作維持 |
| `TEAM_FILTER` 未設定 | デフォルト `"TeamK"` を使用 |
| キャッシュ空かつ初回 | `handleMention` 内で同期クロールを1回試行、失敗時はキャッシュなしで続行 |
| LLM がリスト外を返す | resolve miss → 旧 search にフォールバック |

## 設定

新規 env 変数:
- `TEAM_FILTER`: フィルタするチーム名 (デフォルト `"TeamK"`)

既存変数の流用:
- `PROJECT_DB_ID`: プロジェクトDB ID (既存)
- `NOTIFY_CACHE`: KV バインディング (既存)

## 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/projectCatalog.ts` | 新規。クロール / KV / 名前解決 / `refreshProjectCatalog` |
| `src/config.ts` | `TEAM_FILTER` env を追加 |
| `src/index.ts` | cron 相乗り + `GET /pmo/refresh-projects` |
| `src/slackBot.ts` | `conversationsInfo` を追加 (チャンネル名取得用) |
| `src/llmAnalyzer.ts` | `available_projects` / `channel_name` を prompt に注入 |
| `src/schema.ts` | `MentionContext` に `availableProjects` / `channelName` を追加 |
| `src/slackEvents.ts` | `handleMention` でキャッシュ参照、`searchProjectsByName` をフォールバック化 |

## 受け入れ基準

1. デプロイ後、`GET /pmo/refresh-projects` が `{ count: N }` を返し、KV に `team-projects-cache:TeamK` が保存される
2. Slack で起票テストを実施し、LLM が `available_projects` の中から名前を返す
3. プロジェクト名が空・未指定の起票で、チャンネル名から正しいプロジェクトが選ばれる
4. 既存の `update_project` アクション (プロジェクト変更) が引き続き動作する
5. `wrangler dev` で立ち上げ、`/health` が正常に返る
