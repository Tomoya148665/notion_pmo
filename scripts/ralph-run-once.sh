#!/usr/bin/env bash
#
# Ralph Loop — ローカル定期実行ランナー（Docker 隔離版・1 起動 = 1 イテレーション）
#
# 安全設計:
#   - ライブの notion_pmo には触らない。使い捨てクローン($WORKSPACE)で作業する。
#   - そのクローンだけを Docker にマウントし、コンテナ内で claude を bypassPermissions で実行。
#     暴走しても被害は $WORKSPACE 内に限定される（Mac 本体・他プロジェクト・.env は無事）。
#   - 作業ブランチは ralph/auto（main は汚さない）。
#   - 多重起動はロックで防止。タスクが無ければ即終了。
#
set -euo pipefail

export PATH="/Users/tomoya/.local/node-v24.13.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"          # ライブリポジトリ（読み取り元）
WORKSPACE="${RALPH_WORKSPACE:-$HOME/demo/.ralph-workspace/notion_pmo}"  # 使い捨てクローン
BRANCH="ralph/auto"
IMAGE="ralph-notion-pmo:latest"
TOKEN_FILE="$HOME/.config/ralph/token"

LOG_DIR="$REPO_DIR/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/ralph-run.log"
SESSION_LOG="$LOG_DIR/ralph-session.log"
LOCKFILE="/tmp/ralph-notion-pmo.lock"

RALPH_MODEL="${RALPH_MODEL:-opus}"
RALPH_MAX_BUDGET="${RALPH_MAX_BUDGET:-2}"

ts() { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(ts)] $*" >>"$LOG"; }
die() { log "FATAL: $*"; echo "FATAL: $*" >&2; exit 1; }

# --- 時間帯ゲート（任意） ---
if [ -n "${RALPH_TIME_START:-}" ] && [ -n "${RALPH_TIME_END:-}" ]; then
  HOUR="$(date "+%H")"; HOUR="${HOUR#0}"; HOUR="${HOUR:-0}"
  if [ "$HOUR" -lt "$RALPH_TIME_START" ] || [ "$HOUR" -ge "$RALPH_TIME_END" ]; then
    log "time gate: hour=$HOUR 範囲外。skip"; exit 0
  fi
fi

# --- 多重起動ロック ---
if [ -e "$LOCKFILE" ]; then
  OLD_PID="$(cat "$LOCKFILE" 2>/dev/null || echo "")"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "別の run-once 稼働中 (pid=$OLD_PID)。skip。"; exit 0
  fi
  log "古いロックを掃除"
fi
echo "$$" >"$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# --- 未完了タスクを1つ選ぶ（ライブリポジトリのキューを正とする） ---
TASKS_DIR="$REPO_DIR/RALPH_TASKS"
TASK_FILE=""
while IFS= read -r f; do
  base="$(basename "$f")"
  case "$base" in _TEMPLATE.md|README.md) continue ;; esac
  if grep -qE '^[[:space:]]*-[[:space:]]+\[[[:space:]]\]' "$f"; then TASK_FILE="$f"; break; fi
done < <(find "$TASKS_DIR" -maxdepth 1 -name '*.md' | sort)

if [ -z "$TASK_FILE" ]; then log "未完了タスクなし。何もしない。"; exit 0; fi

TASK_NAME="$(basename "$TASK_FILE" .md)"
REL_TASK="RALPH_TASKS/$(basename "$TASK_FILE")"
REL_PROGRESS="RALPH_TASKS/progress/$TASK_NAME.md"

# --- DRY RUN: 選択結果だけ表示 ---
if [ -n "${RALPH_DRY_RUN:-}" ]; then
  echo "DRY RUN:"
  echo "  task      : $REL_TASK"
  echo "  workspace : $WORKSPACE (branch $BRANCH)"
  echo "  image     : $IMAGE / model $RALPH_MODEL / budget \$$RALPH_MAX_BUDGET"
  log "DRY RUN: $REL_TASK"; exit 0
fi

# --- 前提チェック ---
docker info >/dev/null 2>&1 || die "Docker デーモン未起動。Docker Desktop を起動してください。"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "イメージ $IMAGE 未ビルド。scripts/ralph-build-image.sh build を実行してください。"
[ -s "$TOKEN_FILE" ] || die "トークン未保存 ($TOKEN_FILE)。scripts/ralph-build-image.sh token を参照。"
TOKEN="$(cat "$TOKEN_FILE")"

# --- 使い捨てクローンを用意 / 更新（ライブには push しない） ---
if [ ! -d "$WORKSPACE/.git" ]; then
  log "ワークスペースを初期化: $WORKSPACE"
  mkdir -p "$(dirname "$WORKSPACE")"
  git clone --local "$REPO_DIR" "$WORKSPACE" >>"$LOG" 2>&1 || die "クローン失敗"
  git -C "$WORKSPACE" checkout -B "$BRANCH" >>"$LOG" 2>&1 || die "ブランチ作成失敗"
fi

# ライブの最新タスク定義をワークスペースへ同期（コードと progress は壊さず、タスク .md だけ更新）
git -C "$WORKSPACE" checkout "$BRANCH" >>"$LOG" 2>&1 || git -C "$WORKSPACE" checkout -B "$BRANCH" >>"$LOG" 2>&1 || true
mkdir -p "$WORKSPACE/RALPH_TASKS/progress"
# タスク定義ファイルのみコピー（progress/ は除外して作業の記憶を保持）
find "$TASKS_DIR" -maxdepth 1 -name '*.md' -exec cp {} "$WORKSPACE/RALPH_TASKS/" \;

# 進捗ファイルが無ければ初期化
PROGRESS_PATH="$WORKSPACE/$REL_PROGRESS"
if [ ! -f "$PROGRESS_PATH" ]; then
  cat >"$PROGRESS_PATH" <<EOF
# Progress: $TASK_NAME

## Current State
未着手。

## Last Attempt
なし。

## Known Issues
なし。

## Next Step
タスクファイルを読み、最初の未完了 Success Criteria に着手する。
EOF
fi

# --- プロンプト ---
read -r -d '' PROMPT <<EOF || true
あなたは notion_pmo リポジトリを自律的に改善する開発エージェントです。
CLAUDE.md の開発ルールに必ず従ってください（自動で読み込まれます）。

対象タスク : $REL_TASK
進捗ファイル: $REL_PROGRESS

手順（この順で1イテレーションだけ進める）:
1. 対象タスクファイルを読む
2. 進捗ファイルを読む
3. 未完了の Success Criteria ( - [ ] ) を上から1つだけ選ぶ
4. 関連ファイルを調査し、最小変更で実装する
5. タスクに検証コマンド(typecheck/test/lint 等)があれば実際に実行し、出力で結果を確認する
6. 実際に確認できた項目だけ - [x] に更新する（曖昧・未検証のものは - [ ] のまま残す）
7. 進捗ファイルを更新する: Current State / Last Attempt(今回やったこと・変更ファイル・検証結果) / Known Issues / Next Step

禁止事項（厳守）:
- git push しない
- 明示指示がない限り git commit しない
- .env / .dev.vars / secret を変更しない
- 大規模リファクタをしない
- タスク本文に無い作業へ勝手に範囲を広げない

すべての Success Criteria が - [x] になったら、最後に「RALPH_TASK_DONE: $TASK_NAME」と1行出力して終了してください。
EOF

log "START task=$REL_TASK (docker, branch=$BRANCH)"
{ echo ""; echo "===== [$(ts)] START $REL_TASK ====="; } >>"$SESSION_LOG"

set +e
docker run --rm \
  -v "$WORKSPACE:/work" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" \
  -e RALPH_PROMPT="$PROMPT" \
  -e RALPH_MODEL="$RALPH_MODEL" \
  -e RALPH_MAX_BUDGET="$RALPH_MAX_BUDGET" \
  "$IMAGE" >>"$SESSION_LOG" 2>>"$SESSION_LOG"
RC=$?
set -e

# --- ワークスペースの変更を ralph/auto にコミット（ライブには push しない＝レビュー前提） ---
if [ -n "$(git -C "$WORKSPACE" status --porcelain)" ]; then
  git -C "$WORKSPACE" add -A >>"$LOG" 2>&1 || true
  git -C "$WORKSPACE" -c user.name="ralph-bot" -c user.email="ralph@local" \
    commit -m "ralph: $TASK_NAME ($(ts))" >>"$LOG" 2>&1 || true
  log "ワークスペースの変更を $BRANCH にコミット"
fi

log "END   task=$REL_TASK rc=$RC"
echo "完了。差分の確認: git -C $WORKSPACE log --oneline -5 / git -C $WORKSPACE diff main..$BRANCH"
exit 0
