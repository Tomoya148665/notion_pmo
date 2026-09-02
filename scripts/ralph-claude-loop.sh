#!/usr/bin/env bash
#
# External Claude Resume Ralph Loop.
# Runs scripts/ralph-claude-resume-loop.py using Claude CLI instead of Codex.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec python3 "$SCRIPT_DIR/ralph-claude-resume-loop.py" "$@"
