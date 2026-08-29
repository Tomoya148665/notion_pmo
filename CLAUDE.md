# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AIセキュリティガイドラインに基づくスキルテンプレートを格納するリポジトリ。GitHub ActionsによるClaudeレビューワークフローを含む。

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

