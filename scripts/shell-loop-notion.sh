#!/usr/bin/env bash
#
# Run a Notion page as a Shell Loop queue.
# Each detected Notion task is executed through the external Codex resume loop
# as a separate runner invocation, then written back under the "実行結果" toggle.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec python3 "$SCRIPT_DIR/shell-loop-notion.py" "$@"
