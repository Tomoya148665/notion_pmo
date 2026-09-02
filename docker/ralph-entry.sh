#!/usr/bin/env bash
#
# コンテナ内エントリポイント。
# ホストの ralph-run-once.sh から環境変数でタスク内容を受け取り、
# /work（マウントされた使い捨てクローン）に対して claude -p を1回走らせる。
#
# bypassPermissions だが、このコンテナは /work しか触れないので被害は限定される。
#
set -euo pipefail

cd /work

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: 認証情報がありません。CLAUDE_CODE_OAUTH_TOKEN か ANTHROPIC_API_KEY を渡してください。" >&2
  echo "ホストで 'claude setup-token' を実行し、scripts/ralph-build-image.sh の手順でトークンを保存してください。" >&2
  exit 1
fi

if [ -z "${RALPH_PROMPT:-}" ]; then
  echo "ERROR: RALPH_PROMPT が空です。" >&2
  exit 1
fi

exec claude -p "$RALPH_PROMPT" \
  --model "${RALPH_MODEL:-opus}" \
  --permission-mode bypassPermissions \
  --max-budget-usd "${RALPH_MAX_BUDGET:-2}" \
  --output-format text
