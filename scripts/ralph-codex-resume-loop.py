#!/usr/bin/env python3
"""Run a Ralph-style loop by resuming the same Codex session turn by turn.

This is an external controller, distinct from the Codex Stop-hook loop. It
starts one `codex exec --json` session, captures the emitted thread id, then
feeds follow-up prompts with `codex exec resume <thread-id>`. Each worker turn
is saved to disk so a supervising process can inspect the result and decide the
next prompt.
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
from typing import Iterable, NamedTuple


class TurnResult(NamedTuple):
    status: str
    summary: str
    next_prompt: str


class InvocationResult(NamedTuple):
    return_code: int
    thread_id: str


VALID_STATUSES = {"continue", "complete", "blocked"}


def extract_thread_id(line: str) -> str | None:
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(event, dict):
        return None
    if event.get("type") != "thread.started":
        return None
    thread_id = event.get("thread_id")
    return thread_id if isinstance(thread_id, str) and thread_id else None


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
        rest = text[next_start.end() :].lstrip("\r\n")
        next_end = re.search(r"^RALPH_LOOP_END\s*$", rest, re.M)
        next_prompt = (rest[: next_end.start()] if next_end else rest).strip()

    return TurnResult(status=status, summary=summary, next_prompt=next_prompt)


def hooks_text(hooks: Iterable[str]) -> str:
    items = [hook.strip() for hook in hooks if hook.strip()]
    if not items:
        return "- No explicit shell hooks were supplied. Define and run the smallest useful checks for the task."
    return "\n".join(f"- `{hook}`" for hook in items)


def control_contract(completion_promise: str) -> str:
    return f"""At the very end of your response, append this exact control block:

```text
RALPH_LOOP_STATUS: continue|complete|blocked
RALPH_LOOP_SUMMARY: <one concise sentence about this turn>
RALPH_LOOP_NEXT_PROMPT:
<the exact prompt the controller should send on the next resume turn, or empty if complete/blocked>
RALPH_LOOP_END
```

Use `complete` only when the task outcome is satisfied and the relevant checks have passed.
When complete, also print `{completion_promise}` on its own line before the control block.
Use `blocked` when a concrete missing permission, secret, dependency, or user decision prevents progress.
Use `continue` when more work remains, and write a specific next prompt for the next Codex resume turn.
"""


def run_evidence_policy() -> str:
    return """Repository context and completion evidence:

- Read existing repository files as context whenever they help you understand the task.
- You may inspect prior Ralph progress files for background only.
- Do not treat prior completed Ralph progress files as proof that this new run is complete.
- This run's completion must be proven by this run's outputs, this run's checks, or the explicit task requirements.
- If the task is a fresh/demo/repeated-run task, create or use a run-specific progress/output artifact instead of reusing a prior completed artifact for completion.
"""


def build_initial_prompt(
    *,
    task: str,
    max_iterations: int,
    hooks: list[str],
    completion_promise: str,
) -> str:
    return f"""You are a worker turn inside an external Ralph Codex Resume Loop.

Do exactly one worker turn. Treat this as one user->Codex turn in a longer autonomous loop.
Do not try to consume all future turns just because the max iteration count is {max_iterations}.
Perform the next useful slice of the task, run appropriate checks when possible, then decide whether the controller should continue.

{run_evidence_policy()}

Original task:
{task}

Completion hooks/checks:
{hooks_text(hooks)}

{control_contract(completion_promise)}
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
) -> str:
    next_instruction = previous_result.next_prompt.strip()
    if not next_instruction:
        next_instruction = (
            "Inspect the previous turn, identify the next unmet success condition, "
            "perform exactly one useful next step, and run the most relevant check."
        )

    return f"""Turn {turn_number}/{max_iterations} of the external Ralph Codex Resume Loop.

This is a resumed Codex session. Use the previous turn's result as context, then perform exactly one worker turn.

{run_evidence_policy()}

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

{control_contract(completion_promise)}
"""


def shell_quote(command: list[str]) -> str:
    return " ".join(shlex_quote(part) for part in command)


def shlex_quote(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_@%+=:,./-]+", value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


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


def make_run_id() -> str:
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def build_codex_command(
    *,
    codex_bin: str,
    prompt_file: Path,
    output_file: Path,
    first_turn: bool,
    thread_id: str,
    disable_hooks: bool,
    extra_args: list[str],
) -> tuple[list[str], str]:
    if first_turn:
        command = [codex_bin, "exec"]
    else:
        if not thread_id:
            raise ValueError("thread_id is required for resume turns")
        command = [codex_bin, "exec", "resume"]
    if disable_hooks:
        command += ["--disable", "hooks"]
    command += extra_args
    command += ["--json", "-o", str(output_file)]
    if not first_turn:
        command += [thread_id]
    command += ["-"]
    return command, prompt_file.read_text(encoding="utf-8")


def invoke_codex(command: list[str], prompt: str, *, cwd: Path, command_log: Path) -> InvocationResult:
    thread_id = ""
    with command_log.open("w", encoding="utf-8") as f:
        f.write("$ " + shell_quote(command) + "\n\n")
        f.flush()
        process = subprocess.Popen(
            command,
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

        if process.stdout:
            try:
                for line in process.stdout:
                    if not thread_id:
                        extracted = extract_thread_id(line)
                        if extracted:
                            thread_id = extracted
                    f.write(line)
                    f.flush()
                    print(line, end="", flush=True)
            finally:
                process.stdout.close()

        return InvocationResult(return_code=process.wait(), thread_id=thread_id)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run a bounded Ralph loop by resuming the same Codex session one turn at a time."
    )
    parser.add_argument("--task", help="Task text to run")
    parser.add_argument("--task-file", help="Read task text from a file")
    parser.add_argument("--max-iterations", type=int, default=5)
    parser.add_argument("--hook", action="append", default=[], help="Completion hook/check command to include in prompts")
    parser.add_argument("--workdir", default=os.getcwd(), help="Repository/work directory for Codex")
    parser.add_argument("--state-root", default=".codex/ralph-codex-loop", help="Directory for loop logs/state")
    parser.add_argument("--run-id", default="", help="Optional run id; defaults to timestamp")
    parser.add_argument("--codex-bin", default=shutil.which("codex") or "codex")
    parser.add_argument("--completion-promise", default="", help="Optional completion promise token")
    parser.add_argument("--dry-run", action="store_true", help="Write prompts/state without invoking Codex")
    parser.add_argument("--enable-worker-hooks", action="store_true", help="Allow normal Codex hooks inside worker turns")
    parser.add_argument(
        "--codex-arg",
        action="append",
        default=[],
        help="Extra argument passed to codex exec/resume; repeat for multiple args",
    )
    args = parser.parse_args(argv)

    if args.max_iterations < 1 or args.max_iterations > 25:
        raise SystemExit("ERROR: --max-iterations must be between 1 and 25")

    task = read_task(args)
    workdir = Path(args.workdir).resolve()
    if not workdir.exists():
        raise SystemExit(f"ERROR: workdir does not exist: {workdir}")

    run_id = args.run_id or make_run_id()
    state_root = (workdir / args.state_root).resolve()
    run_dir = state_root / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    completion_promise = args.completion_promise or f"RALPH_CODEX_RESUME_DONE_{run_id.replace('-', '_')}"

    state = {
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
    thread_id = ""

    for turn in range(1, args.max_iterations + 1):
        prompt = (
            build_initial_prompt(
                task=task,
                max_iterations=args.max_iterations,
                hooks=args.hook,
                completion_promise=completion_promise,
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
            )
        )

        prompt_file = run_dir / f"turn-{turn:02d}-prompt.md"
        output_file = run_dir / f"turn-{turn:02d}-output.md"
        command_log = run_dir / f"turn-{turn:02d}-command.log"
        prompt_file.write_text(prompt, encoding="utf-8")

        command, prompt_stdin = build_codex_command(
            codex_bin=args.codex_bin,
            prompt_file=prompt_file,
            output_file=output_file,
            first_turn=(turn == 1),
            thread_id=thread_id,
            disable_hooks=not args.enable_worker_hooks,
            extra_args=args.codex_arg,
        )

        if args.dry_run:
            rc = 0
            output_file.write_text(
                "DRY RUN: Codex was not invoked.\n"
                "RALPH_LOOP_STATUS: complete\n"
                "RALPH_LOOP_SUMMARY: dry run generated prompts and state only\n"
                "RALPH_LOOP_NEXT_PROMPT:\n"
                "RALPH_LOOP_END\n",
                encoding="utf-8",
            )
            command_log.write_text("$ " + shell_quote(command) + "\n", encoding="utf-8")
        else:
            invocation = invoke_codex(command, prompt_stdin, cwd=workdir, command_log=command_log)
            rc = invocation.return_code
            if invocation.thread_id:
                thread_id = invocation.thread_id
                state["thread_id"] = thread_id

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

        print(f"[ralph-codex] turn {turn}/{args.max_iterations}: status={previous_result.status} rc={rc}")

        if rc != 0 and previous_result.status == "continue":
            state["active"] = False
            state["last_status"] = "blocked"
            state["last_summary"] = f"codex exited with rc={rc}"
            write_json(run_dir / "state.json", state)
            print(f"[ralph-codex] blocked: codex exited with rc={rc}; see {command_log}")
            return rc

        if previous_result.status == "continue" and not thread_id:
            state["active"] = False
            state["last_status"] = "blocked"
            state["last_summary"] = "codex did not emit a thread.started thread_id; cannot safely resume"
            write_json(run_dir / "state.json", state)
            print("[ralph-codex] blocked: missing thread_id; refusing unsafe resume")
            return 4

        if previous_result.status in {"complete", "blocked"}:
            state["active"] = False
            write_json(run_dir / "state.json", state)
            print(f"[ralph-codex] finished: {previous_result.status}; run dir: {run_dir}")
            return 0 if previous_result.status == "complete" else 2

    state["active"] = False
    state["last_status"] = "max_iterations"
    write_json(run_dir / "state.json", state)
    print(f"[ralph-codex] reached max iterations without completion; run dir: {run_dir}")
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
