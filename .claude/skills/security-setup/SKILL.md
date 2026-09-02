---
name: security-setup
description: リポジトリ新規作成・新機能開発開始時のセキュリティ初期設定を行う。GitHub Settings（Secret Scanning、Branch Protection）、.gitignore、環境変数設計、CLAUDE.mdのセキュリティセクション追記を確認する。
type: security
---

## 原則

セキュリティは後付けではなく初期設定で組み込む。
リポジトリ作成時に正しく設定すれば、以降の開発で「うっかり漏洩」のリスクを大幅に減らせる。

## 推奨実行順序

1. **GitHub Settings** → リポジトリ自体の保護を最初に
2. **.gitignore + .env.example** → ローカル開発環境の安全確保
3. **環境変数設計** → CI/CD統合前に注入方法を決定
4. **CLAUDE.md追記** → 最後にセキュリティセクションを追加

## チェックリスト

### Step 1: GitHub Settings
- [ ] **Secret Scanningの有効化**
  - Settings → Code security → Secret scanning を ON にする
  - なぜ: コミットに含まれる秘密情報をGitHub側で自動検知できる
- [ ] **Branch Protectionの設定**
  - mainブランチへの直接push禁止、PRレビュー必須を設定
  - なぜ: レビューなしのコードが本番に到達することを防ぐ
- [ ] **CODEOWNERS の設定**
  - セキュリティに関わるファイル（.env.example、認証関連等）にオーナーを設定
  - なぜ: 重要ファイルの変更が適切な担当者にレビューされることを保証する

### Step 2: .gitignore
- [ ] **秘密情報ファイルの除外**
  - `.env`, `.env.local`, `credentials.json`, `*.pem`, `*.key` 等を.gitignoreに追加
  - なぜ: 秘密情報の意図しないコミットを防ぐ第一防衛線
- [ ] **.env.example の整備**
  - 必要な環境変数のキー名のみ記載したテンプレートを用意（値は空またはダミー）
  - なぜ: 開発者が必要な設定項目を把握でき、かつ実際の値は含まれない

### Step 3: 環境変数設計
- [ ] **秘密情報の注入方法の確認**
  - 環境変数 or Secrets Manager 経由で注入する設計になっているか
  - なぜ: ソースコードに秘密情報を含めない原則を設計段階で担保する
  - 詳細は `credential-guard` スキルを参照

### Step 4: CLAUDE.md
- [ ] **セキュリティセクションの追記**
  - 禁止事項（3-5行）+ スキル参照指示が記載されているか
  - なぜ: Claude Codeがスキル参照前でも最低限のセキュリティガードを適用するため

## 違反検知時の対応

1. 未設定項目をリストアップし、設定手順を具体的に提示
2. 設定コマンドやGitHub UIの操作手順を添える
3. .gitignore漏れは即時修正を提案

## 関連スキル

- 秘密情報の管理方法 → `credential-guard`
