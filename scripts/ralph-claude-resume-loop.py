#!/usr/bin/env python3
"""Run a Ralph-style loop using Claude CLI one turn at a time.

Simpler than the Codex version: each turn is a fresh `claude -p` call with
full context embedded in the prompt. No session resuming needed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple


class TurnResult(NamedTuple):
    status: str
    summary: str
    next_prompt: str


VALID_STATUSES = {"continue", "complete", "blocked"}


def parse_turn_result(text: str) -> TurnResult:
    status_match = re.search(r"^RALPH_LOOP_STATUS:\s*([A-Za-z_-]+)\s*$", text, re.M)
    status = (status_match.group(1).lower() if status_match else "continue").strip()
    if status not in VALID_STATUSES:
        status = "continue"

    summary_match = re.search(r"^RALPH_LOOP_SUMMARY:\s*(.*?)\s*$", text, re.M)
    summary = summary_match.group(1).strip() if summary_match else ""

    next_prompt = ""
    next_start = re.search(r"^RALPH_LOOP_NEXT_PROMPT:[ \t]*$", text, re.M)
    if next_start:
        rest = text[next_start.end():].lstrip("\r\n")
        next_end = re.search(r"^RALPH_LOOP_END\s*$", rest, re.M)
        next_prompt = (rest[: next_end.start()] if next_end else rest).strip()

    return TurnResult(status=status, summary=summary, next_prompt=next_prompt)


def hooks_text(hooks: list[str]) -> str:
    items = [h.strip() for h in hooks if h.strip()]
    if not items:
        return "- No explicit shell hooks were supplied. Define and run the smallest useful checks for the task."
    return "\n".join(f"- `{h}`" for h in items)


def control_contract(completion_promise: str, *, turn: int, max_iterations: int, exact: bool) -> str:
    if exact and max_iterations > 1:
        if turn < max_iterations:
            status_note = (
                f"You are on turn {turn}/{max_iterations}. "
                f"You MUST use `continue` — do NOT use `complete` until the final turn {max_iterations}."
            )
        else:
            status_note = (
                f"You are on the FINAL turn {turn}/{max_iterations}. "
                f"Use `complete` to end the loop. "
                f"Also print `{completion_promise}` on its own line before the control block."
            )
    else:
        status_note = (
            f"Use `complete` only when the task outcome is satisfied and relevant checks have passed. "
            f"When complete, also print `{completion_promise}` on its own line before the control block."
        )

    return f"""At the very end of your response, append this exact control block:

```text
RALPH_LOOP_STATUS: continue|complete|blocked
RALPH_LOOP_SUMMARY: <one concise sentence about this turn>
RALPH_LOOP_NEXT_PROMPT:
<the exact prompt the controller should send on the next turn, or empty if complete/blocked>
RALPH_LOOP_END
```

{status_note}
Use `blocked` when a concrete missing permission, secret, dependency, or user decision prevents progress.
"""


def build_initial_prompt(
    *, task: str, max_iterations: int, hooks: list[str], completion_promise: str, exact: bool
) -> str:
    exact_note = (
        f"\nThis is an iterative task with exactly {max_iterations} turns. "
        f"Perform one unit of work per turn. Do NOT complete early.\n"
        if exact and max_iterations > 1
        else ""
    )
    return f"""You are a worker turn inside an external Ralph Claude Loop.

Do exactly one worker turn. Treat this as one turn in a longer autonomous loop.
Do not try to consume all future turns; perform the next useful slice of work, then decide whether to continue.
{exact_note}
Original task:
{task}

Completion hooks/checks:
{hooks_text(hooks)}

{control_contract(completion_promise, turn=1, max_iterations=max_iterations, exact=exact)}
"""


def build_resume_prompt(
    *,
    task: str,
    turn_number: int,
    max_iterations: int,
    previous_output: str,
    previous_result: TurnResult,
    hooks: list[str],
    completion_promise: str,
    exact: bool,
) -> str:
    next_instruction = previous_result.next_prompt.strip() or (
        "Inspect the previous turn, identify the next unmet success condition, "
        "perform exactly one useful next step, and run the most relevant check."
    )
    return f"""Turn {turn_number}/{max_iterations} of the external Ralph Claude Loop.

Original task:
{task}

Previous turn summary:
{previous_result.summary or "(no summary provided)"}

Previous turn output:
```text
{previous_output.strip()}
```

Controller-selected next prompt:
{next_instruction}

Completion hooks/checks:
{hooks_text(hooks)}

{control_contract(completion_promise, turn=turn_number, max_iterations=max_iterations, exact=exact)}
"""


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_task(args: argparse.Namespace) -> str:
    if args.task_file:
        return Path(args.task_file).read_text(encoding="utf-8").strip()
    if args.task:
        return args.task.strip()
    if not sys.stdin.isatty():
        return sys.stdin.read().strip()
    raise SystemExit("ERROR: provide --task, --task-file, or pipe task text on stdin")


def invoke_claude(prompt: str, *, claude_bin: str, output_file: Path, command_log: Path, cwd: Path) -> int:
    cmd = [claude_bin, "-p"]
    with command_log.open("w", encoding="utf-8") as log:
        log.write(f"$ {claude_bin} -p < prompt\n\n")
        log.flush()
        process = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        try:
            if process.stdin:
                process.stdin.write(prompt)
                process.stdin.close()
        except BrokenPipeError:
            pass

        output_lines: list[str] = []
        if process.stdout:
            try:
                for line in process.stdout:
                    print(line, end="", flush=True)
                    log.write(line)
                    log.flush()
                    output_lines.append(line)
            finally:
                process.stdout.close()

        rc = process.wait()

    output_file.write_text("".join(output_lines), encoding="utf-8")
    return rc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run a bounded Ralph loop using Claude CLI one turn at a time."
    )
    parser.add_argument("--task", help="Task text to run")
    parser.add_argument("--task-file", help="Read task text from a file")
    parser.add_argument("--max-iterations", type=int, default=5)
    parser.add_argument("--hook", action="append", default=[], help="Completion check command")
    parser.add_argument("--workdir", default=os.getcwd())
    parser.add_argument("--state-root", default=".claude/ralph-claude-loop")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--claude-bin", default=shutil.which("claude") or "claude")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--exact-iterations",
        action="store_true",
        help="Run exactly max-iterations turns, ignoring early 'complete' signals from the worker",
    )
    args = parser.parse_args(argv)

    if args.max_iterations < 1 or args.max_iterations > 25:
        raise SystemExit("ERROR: --max-iterations must be between 1 and 25")

    task = read_task(args)
    workdir = Path(args.workdir).resolve()
    if not workdir.exists():
        raise SystemExit(f"ERROR: workdir does not exist: {workdir}")

    run_id = args.run_id or dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    state_root = (workdir / args.state_root).resolve()
    run_dir = state_root / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    completion_promise = f"RALPH_CLAUDE_DONE_{run_id.replace('-', '_')}"

    state: dict = {
        "run_id": run_id,
        "active": True,
        "task": task,
        "max_iterations": args.max_iterations,
        "completion_promise": completion_promise,
        "workdir": str(workdir),
        "turns": [],
    }

    previous_output = ""
    previous_result = TurnResult(status="continue", summary="", next_prompt="")

    exact = args.exact_iterations

    for turn in range(1, args.max_iterations + 1):
        prompt = (
            build_initial_prompt(
                task=task,
                max_iterations=args.max_iterations,
                hooks=args.hook,
                completion_promise=completion_promise,
                exact=exact,
            )
            if turn == 1
            else build_resume_prompt(
                task=task,
                turn_number=turn,
                max_iterations=args.max_iterations,
                previous_output=previous_output,
                previous_result=previous_result,
                hooks=args.hook,
                completion_promise=completion_promise,
                exact=exact,
            )
        )

        prompt_file = run_dir / f"turn-{turn:02d}-prompt.md"
        output_file = run_dir / f"turn-{turn:02d}-output.md"
        command_log = run_dir / f"turn-{turn:02d}-command.log"
        prompt_file.write_text(prompt, encoding="utf-8")

        if args.dry_run:
            rc = 0
            output_file.write_text(
                "DRY RUN: Claude was not invoked.\n"
                "RALPH_LOOP_STATUS: complete\n"
                "RALPH_LOOP_SUMMARY: dry run\n"
                "RALPH_LOOP_NEXT_PROMPT:\n"
                "RALPH_LOOP_END\n",
                encoding="utf-8",
            )
            command_log.write_text(f"$ {args.claude_bin} -p < prompt\n", encoding="utf-8")
        else:
            rc = invoke_claude(
                prompt,
                claude_bin=args.claude_bin,
                output_file=output_file,
                command_log=command_log,
                cwd=workdir,
            )

        if not output_file.exists():
            output_file.write_text("", encoding="utf-8")
        previous_output = output_file.read_text(encoding="utf-8")
        previous_result = parse_turn_result(previous_output)

        turn_state = {
            "turn": turn,
            "return_code": rc,
            "status": previous_result.status,
            "summary": previous_result.summary,
            "prompt_file": str(prompt_file),
            "output_file": str(output_file),
            "command_log": str(command_log),
            "next_prompt": previous_result.next_prompt,
        }
        state["turns"].append(turn_state)
        state["last_status"] = previous_result.status
        state["last_summary"] = previous_result.summary
        write_json(run_dir / "state.json", state)

        print(f"[ralph-claude] turn {turn}/{args.max_iterations}: status={previous_result.status} rc={rc}")

        if rc != 0 and previous_result.status == "continue":
            state["active"] = False
            state["last_status"] = "blocked"
            state["last_summary"] = f"claude exited with rc={rc}"
            write_json(run_dir / "state.json", state)
            print(f"[ralph-claude] blocked: claude exited with rc={rc}; see {command_log}")
            return rc

        if previous_result.status == "blocked":
            state["active"] = False
            write_json(run_dir / "state.json", state)
            print(f"[ralph-claude] finished: blocked; run dir: {run_dir}")
            return 2

        if previous_result.status == "complete":
            if exact and turn < args.max_iterations:
                # Override: keep running until all iterations are done
                print(f"[ralph-claude] exact mode: overriding early complete at turn {turn}/{args.max_iterations}")
                previous_result = TurnResult(status="continue", summary=previous_result.summary, next_prompt="")
                state["turns"][-1]["status"] = "continue"
                write_json(run_dir / "state.json", state)
            else:
                state["active"] = False
                write_json(run_dir / "state.json", state)
                print(f"[ralph-claude] finished: complete; run dir: {run_dir}")
                return 0

    state["active"] = False
    state["last_status"] = "max_iterations"
    write_json(run_dir / "state.json", state)
    print(f"[ralph-claude] reached max iterations; run dir: {run_dir}")
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
