---
name: credential-guard
description: 秘密情報（APIキー、トークン、パスワード、証明書）のライフサイクル管理。保存方法、.env管理、CI/CD Secrets注入、ローテーション手順を定義する。API連携・認証機能の実装時に参照。秘密情報のSingle Source of Truth。
type: security
---

## 原則

秘密情報はソースコードに含めない。環境変数またはSecrets Manager経由で注入する。
漏洩した秘密情報は「変更」ではなく「即時無効化＋再発行」で対応する。

## チェックリスト

### 保存ルール
- [ ] **ソースコード直書きの禁止**
  - APIキー、パスワード、トークンをコード内にハードコードしない
  - なぜ: gitの履歴に残り、force-pushしても完全な削除が困難
- [ ] **環境変数またはSecrets Managerを使用**
  - `process.env.API_KEY` 等、環境変数経由でのアクセスに統一
  - なぜ: 秘密情報とコードのライフサイクルを分離する

### .env管理
- [ ] **.gitignoreへの登録確認**
  - `.env`, `.env.local`, `.env.production` 等が.gitignoreに含まれているか
  - なぜ: git addで意図せずステージングされることを防ぐ
- [ ] **.env.exampleの整備**
  - キー名のみ記載、値は空またはダミー（`API_KEY=your_api_key_here`）
  - なぜ: 新規メンバーが必要な設定項目を把握でき、実際の値は共有されない
- [ ] **.envの共有方法**
  - Slack, メール, チャットでの.envファイル共有は禁止。1Password等のSecrets Managerを使用
  - なぜ: チャットログに秘密情報が残り、退職者のアクセス制御が困難になる

### CI/CD
- [ ] **GitHub Secrets経由での注入**
  - CI/CDパイプラインではGitHub Secrets（またはクラウドのSecrets Manager）から注入
  - なぜ: ビルドログに秘密情報が露出するリスクを排除する
- [ ] **ログマスキングの確認**
  - CI/CDのログ出力で秘密情報がマスクされているか
  - なぜ: ビルドログは複数メンバーがアクセスでき、秘密情報の露出経路になる

### ローテーション
- [ ] **漏洩時の即時対応手順**
  - 1) 該当キーを即時無効化 2) 新しいキーを発行 3) 全環境に反映 4) インシデント報告
  - なぜ: 漏洩した秘密情報は変更ではなく無効化が必要。時間が経つほど被害が拡大する
  - インシデント報告の手順は `incident-report` スキルを参照

### 検知方法
```bash
# 簡易チェック（grepベース、偽陽性あり）
grep -rEn "AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}" \
  --include="*.ts" --include="*.js" --include="*.py" --include="*.go" \
  --include="*.java" --include="*.rb" --include="*.yaml" --include="*.yml" \
  --include="*.json" .
```
- 上記は簡易チェック用。本格運用では専用ツールを推奨:
  - **gitleaks**: git履歴を含むスキャン。CI/CD組み込み向き
  - **truffleHog**: エントロピー分析による高精度な秘密情報検知

## 違反検知時の対応

1. `[CRITICAL]` として即時対応を求める
2. 該当箇所の修正方法を提示（環境変数への移行手順）
3. git履歴に秘密情報が残っている場合は `git filter-repo` または BFG Repo-Cleaner の使用を案内
4. 漏洩の可能性がある場合は `incident-report` スキルに従いエスカレーション

## 関連スキル

- コードレビューでの秘密情報検知 → `security-review`
- インシデント報告 → `incident-report`
