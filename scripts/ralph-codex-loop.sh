#!/usr/bin/env bash
#
# External Codex Resume Ralph Loop.
# Runs scripts/ralph-codex-resume-loop.py, which starts one Codex exec turn,
# captures its thread id, then resumes that exact session.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec python3 "$SCRIPT_DIR/ralph-codex-resume-loop.py" "$@"
