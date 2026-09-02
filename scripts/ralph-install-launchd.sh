#!/usr/bin/env bash
#
# Ralph Loop — launchd への登録 / 解除（macOS）
#
# launchd は macOS 標準のスケジューラ。cron より推奨される。
# StartInterval ごとに ralph-run-once.sh を1回起動する（Mac が起きている間のみ）。
#
# 使い方:
#   ./scripts/ralph-install-launchd.sh install     # 登録（既定 10 分間隔）
#   ./scripts/ralph-install-launchd.sh uninstall   # 解除
#   ./scripts/ralph-install-launchd.sh status      # 状態確認
#   RALPH_INTERVAL=1800 ./scripts/ralph-install-launchd.sh install  # 30分間隔で登録
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.tomoya.ralph-notion-pmo"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNNER="$REPO_DIR/scripts/ralph-run-once.sh"
LOG_DIR="$REPO_DIR/logs"
INTERVAL="${RALPH_INTERVAL:-600}"   # 秒。既定 10 分。

cmd="${1:-status}"

case "$cmd" in
  install)
    mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$RUNNER</string>
    </array>
    <key>StartInterval</key>
    <integer>$INTERVAL</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/tomoya/.local/node-v24.13.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/ralph-launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/ralph-launchd.err.log</string>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
</dict>
</plist>
EOF
    # 既存があれば一旦解除してから登録
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "登録しました: $LABEL (間隔 ${INTERVAL}s)"
    echo "  plist : $PLIST"
    echo "  runner: $RUNNER"
    echo "  log   : $LOG_DIR/ralph-*.log"
    echo "解除は: $0 uninstall"
    ;;
  uninstall)
    if [ -f "$PLIST" ]; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "解除しました: $LABEL"
    else
      echo "未登録です（$PLIST が無い）。"
    fi
    ;;
  status)
    if [ -f "$PLIST" ]; then
      echo "plist あり: $PLIST"
      if launchctl list | grep -q "$LABEL"; then
        echo "launchd に登録済み:"
        launchctl list | grep "$LABEL" || true
      else
        echo "plist はあるが launchd 未ロード。'$0 install' で再登録できます。"
      fi
    else
      echo "未登録です。'$0 install' で登録できます。"
    fi
    ;;
  *)
    echo "usage: $0 {install|uninstall|status}"
    exit 1
    ;;
esac
