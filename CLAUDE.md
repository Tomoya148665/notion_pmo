# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

notion-sprint-worker: Cloudflare Worker + Slack Bot + Notion API + OpenAI LLM のプロジェクト。
下部の「Development Rules」に実装時に必ず守るルールを記載する。

## Repository Structure

- `.claude/skills/<name>/SKILL.md` — AIセキュリティ関連のスキル定義ファイル（Markdown frontmatter形式）
- `.github/workflows/` — GitHub Actions（Claude自動レビュー: reusable workflow経由）
- `.gemini/` — Gemini Code Assist設定（レビュー無効化）

管理・運用ドキュメントは [ai-security-guideline-skills-admin](https://github.com/AICE-inc/ai-security-guideline-skills-admin) にある。

## Conventions

- スキルファイルはMarkdown形式、YAML frontmatter（name, description, type）を持つ
- 日本語を基本言語とする（技術用語・コード識別子は英語のまま）
- ブランチ戦略: feature branch → PR → mainマージ

## GitHub Actions

- PR作成時に自動でClaudeコードレビューが実行される
- `@claude` メンションで手動レビューも可能
- レビュー結果はPRコメント（トップレベル + インラインコメント）として投稿される

## セキュリティ（必須）

- 本番環境のクレデンシャルをソースコードに含めない
- 本番DBへの直接操作を行わない
- 外部APIキーをログに出力しない
- セキュリティに関わる作業は .claude/skills/ 配下のスキルを必ず参照すること

<important if="you are reviewing code or creating a PR">
- .claude/skills/security-review/SKILL.md を参照し、全チェック項目を通過させること
- 秘密情報のハードコードを検知した場合は [CRITICAL] として即時指摘すること
</important>

<important if="you are creating a new repository, initializing a project, or configuring CI/CD">
- .claude/skills/security-setup/SKILL.md を参照し、GitHub Settings・.gitignore・環境変数設計を確認すること
</important>

<important if="you are implementing API integrations, authentication, or handling secrets, tokens, or credentials">
- .claude/skills/credential-guard/SKILL.md を参照すること。秘密情報は環境変数またはSecrets Manager経由で注入し、ソースコードに直書きしない
</important>

<important if="you are responding to a security incident, data breach, or credential leak">
- .claude/skills/incident-report/SKILL.md を参照し、エスカレーション基準に従って報告を促すこと
- 初動対応（キー無効化等）を最優先すること
</important>

<important if="you are adding, updating, or removing dependencies or packages">
- .claude/skills/security-review/SKILL.md の「依存ライブラリ」セクションを参照し、既知脆弱性と不要な依存を確認すること
</important>

<important if="you are writing documentation, README, proposals, or any content for external sharing">
- .claude/skills/doc-guardrail/SKILL.md を参照し、個人情報・社内情報・技術情報の漏洩がないか確認すること
</important>

---

# Development Rules — notion-sprint-worker

Cloudflare Worker + Slack Bot + Notion API + OpenAI LLM のプロジェクト。
実装時に必ず守るルールを記載する。

## 1. Cloudflare Workers の制約

### waitUntil() を長時間処理に使わない
- Free プランの `ctx.waitUntil()` は **30秒で打ち切られる**
- LLM 呼び出し + Notion API + Slack 返信は 30秒を超えることが多い
- **正しいパターン**: `TransformStream` でストリーミングレスポンスを返し、処理完了まで Worker を生存させる
- 参考実装: `src/slackEvents.ts` の `respondAndProcess()`

```ts
// NG — 30秒で処理がキャンセルされる
ctx.waitUntil(handleMention(env, event));
return new Response("ok");

// OK — Worker が処理完了まで生存する
const { readable, writable } = new TransformStream();
const writer = writable.getWriter();
const task = (async () => {
  try { await handleMention(env, event); }
  finally { await writer.write(new TextEncoder().encode("ok")); await writer.close(); }
})();
if (ctx) ctx.waitUntil(task);
return new Response(readable, { status: 200 });
```

### cron トリガーは最大 5 個
- Cloudflare Free プランの上限は 5 cron triggers
- 新しい定期処理を追加する場合は既存の cron に JST 時間帯ゲーティングで相乗りさせる

## 2. Slack API

### blocks がある場合 text は表示されない
- `chat.postMessage` に `blocks` を渡すと、`text` フィールドは通知プレビュー専用になり画面に表示されない
- テキストを表示したい場合は `section` ブロックとして `blocks` 配列に含めること
- `chatPostMessage()` in `src/slackBot.ts` が自動で text を section block として先頭に挿入するようになっている

### Interactivity URL の設定
- ボタン等のインタラクティブコンポーネントを使う場合、Slack App Settings の Interactivity & Shortcuts で Request URL を設定する必要がある
- URL: `https://notion-sprint-worker-dev.tomoya-kotetsu.workers.dev/slack/interactions`

## 3. Notion API アクション

### 全アクションを有効にすること
- `update_assignee`, `update_due`, `update_sp`, `update_status`, `update_sprint`, `create_task` は全て実際に Notion を更新する
- `[NOT ACTIVE]` や `（未有効）` のようなガードを入れない。実装したら有効にすること
- `notionWriter.ts` の `updateTaskPage()` で担当者変更は `properties["担当者"]` に people を設定する
- ユーザーマッピングは `fetchNotionUserMap()` で取得する

### ユーザー名マッピング
- LLM が返す `new_value` は日本語の担当者名（例: 「古鉄朋也 / Tomoya Kotetsu」）
- `fetchNotionUserMap()` で Notion ユーザー ID に変換してから API を呼ぶ
- マッチしない場合は warn ログを出し、ユーザーに「Notion ユーザー未検出」と伝える

## 4. エラーハンドリング

### 想定内のエラーにログを出さない
- Notion API の 4xx エラー（アクセス権限なし等）は想定内 — warn/error ログを出さない
- `withRetry()` はデフォルトで 4xx を silent にしている
- キャパシティ DB が存在しない場合など、データが取れなくても正常動作すること
- LLM プロンプトでも「データが null なら登録を促すな、あるデータだけで回答しろ」と指示済み

### .catch(() => fallback) パターン
- 補助データの取得は `.catch(() => [])` or `.catch(() => null)` で失敗を許容する
- メインのスプリントデータ取得が失敗した場合のみユーザーにエラーメッセージを返す

## 5. KV ストレージ

- バインディング名: `NOTIFY_CACHE`
- キーの命名規則: `{機能名}:{識別子}` (例: `phone-reminder:{userId}:{channel}:{threadTs}`)
- TTL はデフォルト 7 日間 (`DEFAULT_TTL = 7 * 24 * 3600`)
- Phone reminder は 30 日間

## 6. デプロイ

- 修正後は都度デプロイする（確認不要）
- コマンド: `npx wrangler deploy`
- コミットは明示的に指示があった場合のみ行う
