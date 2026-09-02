#!/usr/bin/env bash
#
# Ralph Loop — shell-loop ラッパー
#
# cron/launchd を使わず、その場で連続実行したいとき用。
# ralph-run-once.sh を sleep を挟みながら最大 RALPH_MAX_RUNS 回繰り返す。
# 未完了タスクが無くなった場合の空振りもカウントに含まれる。
#
# 使い方:
#   ./scripts/ralph-loop.sh
#   RALPH_MAX_RUNS=50 RALPH_SLEEP=300 ./scripts/ralph-loop.sh
#
# 止め方: Ctrl-C
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RALPH_MAX_RUNS="${RALPH_MAX_RUNS:-20}"   # 安全のための上限（コスト暴走防止）
RALPH_SLEEP="${RALPH_SLEEP:-300}"        # 各イテレーション間の待機秒数

echo "Ralph shell-loop 開始: 最大 $RALPH_MAX_RUNS 回 / 間隔 ${RALPH_SLEEP}s (Ctrl-C で停止)"

count=0
while [ "$count" -lt "$RALPH_MAX_RUNS" ]; do
  count=$((count + 1))
  echo "--- iteration $count/$RALPH_MAX_RUNS ($(date '+%H:%M:%S')) ---"
  "$SCRIPT_DIR/ralph-run-once.sh" || echo "run-once が非0で終了（継続します）"
  if [ "$count" -lt "$RALPH_MAX_RUNS" ]; then
    sleep "$RALPH_SLEEP"
  fi
done

echo "Ralph shell-loop 終了 (最大回数 $RALPH_MAX_RUNS に到達)。"
