# notion-sprint-worker

Notion + Slack + Google Sheets + OpenAI LLM を連携した、Cloudflare Workers 上で動く Slack PMO ボット。
スプリントのタスク進捗管理・メンバー通知・PMレポート生成を自動化する。

---

## アーキテクチャ概要

- **Runtime**: Cloudflare Workers（単一の10分 cron 内で JST 時刻ゲーティング）
- **状態保存**: Workers KV (`NOTIFY_CACHE`) で全状態管理（スレッド・リマインダ・スナップショット等）
- **Slack**: Events API + Interactions（HMAC-SHA256 検証）
- **LLM**: OpenAI `gpt-4.1-mini`（`/v1/responses` + Structured Output）
- **データソース**: Notion API 直叩き + Google Sheets（マスタースケジュール）

### 主なフロー

| 時刻 (JST) | フロー | 内容 |
|---|---|---|
| 05:00 | `runProgressSpSnapshot` | スプリントの進捗SPを KV に保存（消化SP計算用） |
| 08:30 | `runTaskReminderFlow` | 当日の `MM/DD_タスク` 親スレッドを作成 |
| 08:50 | `runDeliveryMorningFlow` | 同スレッドへ案件別 Forecast・Burn Gap・FTE・Health の `DELIVERY CONTROL` 画像を投稿 |
| 土曜 08:50 | `runSprintPlanningFlow` | MMDDタスクスレッドへチェックポイント・Planning品質・Velocity負荷の診断を投稿 |
| 09:00 | `runMorningFlow` | 各担当者へ進捗確認メッセージを LLM 生成 → Slack 投稿 |
| 09:10〜09:50 (10分毎) | `runReminderFlow` | 未返信メンバーへリマインド |
| 10:00 | `runEveningFlow` | 返信を集約 → PMレポート＋割り振り提案 |
| 12:00 | `runDeliveryAlertFlow` | Forecast超過・Burn Gap・長時間Blockerの状態変化だけを通知 |
| 金曜 17:50 | `runDeliveryPortfolioFlow` | 案件Portfolioと担当者別の次週FTE需要を投稿 |
| 18:30 | `runDeliveryUpdateReminderFlow` | doingタスクの工数・Evidence未更新を担当者別に集約して通知 |
| 24:00 | `runMidnightPostSequence` | 進捗サマリーの後、計画線・進捗SP・Done・着地予測・Velocity・チェックポイントを統合した SPRINT CONTROL 画像を最後に投稿 |
| 毎時 :00/:15 | 複合 | ☎️ リマインド・PM未返信リマインド・EOD・cron 監視・catch-up |

加えて、☎️ リアクションでメッセージを DM に転送し、指定時刻にリマインドする機能あり。

### Sprint Control の運用ルール

- **Planning**: Epic / Workstream の「次チェックポイント」と「チェックポイント期日」を決め、今Sprintのタスクを `Epic / Workstream` に接続する。各タスクの SP・担当者・完了条件・期限を確定する。
- **Daily**: `進捗SP = SP × ステータス進捗率` と、完了ステータスだけを数える `Done SP` を分けて見る。計画線との差、残り日数、必要Done SP/日、直近3日と過去3SprintのVelocityから着地を予測する。
- **軌道修正**: 着地予測80%未満、または期限直前で進捗80%未満のチェックポイントは赤。95%未満、計画差10%以上、スコープ増10%以上、Planning項目の欠落は黄色にする。
- **Notion反映**: 毎晩、対象Sprint・今Sprint計画SP・今Sprint進捗SP・今Sprint完了SP・Health・判定理由・最終判定日を Epic / Workstream DB に書き戻す。

### Delivery Control の運用ルール

- **採算基準**: TeamK月次Delivery Capacityは816h（4名 × 240h × 85%）、必要売上密度は4.08万円/h。`許容総工数 = 契約金額 ÷ 4.08` とする。
- **着地予測**: `Forecast = 実績工数 + 残工数`、`Burn Gap = 工数消化率 - 成果進捗`。Active Taskの工数が未入力なら0扱いにせず「未評価」にする。
- **Health**: Forecast 100%超・Burn Gap 10pt以上・Blocker 24h以上はYellow、110%超・20pt超・48h超はRed。同じ状態はKVで再通知しない。
- **FTE**: 1人月204h、TeamK月816hとして、案件残工数のFTE月と担当者別の次週FTE需要（1人週約47h）を表示する。複数担当タスクは均等配分する。
- **次Phase**: 工数消化50%で仮説整理、70%で正式提案準備、85%で予算・契約調整を確認する。

---

## セットアップ

### 必要なもの

- Node.js 18+
- Cloudflare アカウント（Workers + KV のアクセス権）
- `.dev.vars`（環境変数。リポジトリには含まれていない。リポオーナーから別途受領）

### 手順

```bash
git clone https://github.com/Tomoya148665/notion_pmo.git
cd notion_pmo
npm install

# 受け取った .dev.vars をプロジェクト直下に配置（拡張子なし、先頭ドット）

npx wrangler login        # Cloudflare 認証
npx wrangler dev          # ローカル動作確認
```

`http://localhost:8787/health` にアクセスして `{"status":"ok",...}` が返れば起動成功。

### Codex Resume RALPH ループ

Codex の Stop hook で同一ターン内に継続する方式とは別に、外部コントローラーから `codex exec --json` を起動し、取得した thread id に対して `codex exec resume <thread-id>` を1ターンずつ送る RALPH ループを用意している。

```bash
python3 scripts/ralph-codex-resume-loop.py \
  --task '5回、だんだん難しい足し算を1ターン1回ずつ実行して、各回の計算結果を確認する' \
  --max-iterations 5
```

検証コマンドを Codex への完了条件として渡す場合:

```bash
python3 scripts/ralph-codex-resume-loop.py \
  --task-file task.md \
  --max-iterations 5 \
  --hook 'npx tsc --noEmit'
```

各ターンの prompt / output / state は `.codex/ralph-codex-loop/<run-id>/` に保存される。動作確認だけしたい場合は `--dry-run` を付ける。

Worker は既存のリポジトリファイルを文脈として読んでよいが、今回の run の完了判定は今回の output / check / 明示されたタスク条件で行う。過去の完了済み RALPH progress は参考情報に留め、fresh なデモや繰り返し実行では run 専用の progress/output を使う。

### 本番デプロイ

```bash
npx wrangler deploy
```

→ 即時に `notion-sprint-worker-dev.aice-demo.workers.dev` に反映される。

---

## ⚠️ 開発時の注意事項

### 本番環境を直接触る

- 本番運用中の Slack ボットです
- **`wrangler dev` でも本番の Slack / Notion / KV を触ります**（dev/prod 分離なし）
- 大きい変更を試すときは `.dev.vars` で `DRY_RUN=true` にすると、Slack 投稿・Notion 更新がスキップされる
- `wrangler deploy` は即本番反映なので、PR レビュー後の実行を推奨

### シークレット管理

- `.dev.vars` は `.gitignore` 済。**git に絶対 push しない**
- 画像背景モデルは `OPENAI_IMAGE_MODEL`（既定 `gpt-image-2`）。API には集計値だけを渡し、人名・タスク名は送らない
- 万が一漏えいした場合はリポオーナーへ即連絡（トークンローテーション可能）

### Cloudflare Workers の制約

- Free プランの `ctx.waitUntil()` は **30秒で打ち切られる**
- LLM 呼び出し + Notion API + Slack 返信は 30秒を超えるため、`TransformStream` でストリーミングレスポンスを返して Worker を生存させるパターンを使うこと
- 詳細は [`CLAUDE.md`](./CLAUDE.md) 参照

### Slack API の罠

- `chat.postMessage` で `blocks` を指定すると `text` フィールドは画面に表示されない（通知プレビュー専用になる）
- `chatPostMessage()` in `src/slackBot.ts` が自動で text を section block として先頭挿入する

---

## ディレクトリ構成

```
src/
├── index.ts              # エントリポイント (fetch / scheduled handler)
├── config.ts             # 環境変数のパース
├── channelConfig.ts      # チャンネル別設定（per-channel onboarding）
├── workflow.ts           # KV 操作（スレッド状態・リマインダ・ハートビート）
├── slackEvents.ts        # Slack Events API ハンドラ（メンション・返信・リアクション）
├── slackInteractions.ts  # Slack ボタン・モーダル ハンドラ
├── slackBot.ts           # Slack Bot Token 経由の API 呼び出し
├── slack.ts              # Slack Webhook 経由の API 呼び出し（旧式）
├── notionApi.ts          # Notion DB 読み取り
├── spGamification.ts     # Sprint Control（計画対実績・Done・着地予測・Velocity・チェックポイント）
├── notionWriter.ts       # Notion ページ作成・更新
├── notionMcp.ts          # Notion MCP server 経由のフェッチ
├── llmAnalyzer.ts        # OpenAI で分析・メッセージ生成・返信解釈
├── schema.ts             # Zod + JSON Schema（LLM Structured Output 用）
├── memberApi.ts          # Notion メンバー DB から取得
├── sheetsApi.ts          # Google Sheets API（マスタースケジュール）
├── onboarding.ts         # チャンネル招待時の setup モーダル
├── dedupe.ts             # 重複排除（payload ハッシュ + KV TTL）
└── retry.ts              # withRetry（4xx silent / 5xx リトライ）

docs/plans/               # 設計ドキュメント
task/pmo-agent-spec.md    # PMOエージェント仕様書 v1.0
CLAUDE.md                 # 開発ルール（必読）
```

---

## ドキュメント

- [`CLAUDE.md`](./CLAUDE.md) — 開発時の必須ルール（Cloudflare 30秒制限・Slack blocks・Notion API・KV キー命名 など）
- [`docs/plans/morning-evening-flow.md`](./docs/plans/morning-evening-flow.md) — 朝夜フローの設計
- [`docs/plans/2026-03-06-channel-onboarding-design.md`](./docs/plans/2026-03-06-channel-onboarding-design.md) — チャンネルオンボーディング設計
- [`docs/plans/2026-03-11-task-creation-enhancements.md`](./docs/plans/2026-03-11-task-creation-enhancements.md) — タスク起票機能の改善
- [`task/pmo-agent-spec.md`](./task/pmo-agent-spec.md) — PMOエージェント仕様書

---

## 管理用 HTTP エンドポイント

`https://notion-sprint-worker-dev.aice-demo.workers.dev` 配下:

| Path | 用途 |
|---|---|
| `GET /health` | ヘルスチェック・cron ハートビート |
| `POST /slack/events` | Slack Events API 受信 |
| `POST /slack/interactions` | Slack ボタンクリック等 |
| `GET /pmo/morning` | 朝フロー手動実行 |
| `GET /pmo/evening` | 夜フロー手動実行 |
| `GET /pmo/progress-snapshot` | 進捗SPスナップショット手動実行 |
| `GET /pmo/sprint-planning` | Sprint Planning診断を当日のMMDDタスクスレッドへ投稿 |
| `GET /pmo/delivery-control` | Delivery Controlの実データ・判定・入力不足・FTEをJSON確認（投稿なし） |
| `GET /pmo/delivery-digest` | 日次Delivery Digest画像を当日のタスクスレッドへ手動投稿 |
| `GET /pmo/delivery-reminder` | 18:30未更新Reminderを手動投稿 |
| `GET /pmo/delivery-alerts` | 状態変化Alertを手動確認・投稿 |
| `GET /pmo/delivery-portfolio` | 週次Portfolio/FTE Summaryを手動投稿 |
| `GET /pmo/sp-dashboard?debug=data` | SPRINT CONTROL の集計値確認（投稿なし） |
| `GET /pmo/sp-dashboard?debug=png` | 決定論的な PNG プレビュー（`&ai=1` で OpenAI 背景付き） |
| `GET /pmo/sp-dashboard?debug=details-png` | メンバー別完了タスク詳細表のPNGプレビュー |
| `GET /pmo/sp-dashboard?to=dm` | Sprint Control＋タスク詳細の統合画像をPMユーザーのDMにテスト投稿 |
| `GET /pmo/pm-debug` | PMスレッド状態の確認 |
| `GET /pmo/pm-dismiss` | PMスレッドを processed に変更（リマインド停止） |

---

## トラブルシュート

### cron が動いていない

`/health` で `crons` のハートビート時刻を確認。watchdog が PMユーザーに DM で警告を出す仕組みあり（[`runCronHealthCheck`](./src/index.ts)）。手動実行は上記エンドポイントから。

### Slack に投稿されない

- `SLACK_BOT_TOKEN` の権限確認（`chat:write` 必須）
- ボットが対象チャンネルに招待されているか
- `DRY_RUN=true` になっていないか

### Notion 更新が失敗する

- Integration がデータベースに接続されているか（Notion 側でデータベース → Connections）
- 担当者名が `fetchNotionUserMap()` で解決できるか（ログに warn が出る）
