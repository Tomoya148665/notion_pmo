#!/usr/bin/env python3
"""Run Notion page tasks one by one through the external Codex resume loop."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import NamedTuple


NOTION_VERSION = "2022-06-28"


class Task(NamedTuple):
    text: str
    source_block_id: str
    source_type: str


class RunnerResult(NamedTuple):
    status: str
    summary: str
    output: str


def extract_page_id(value: str) -> str:
    compact = ""
    match = re.search(r"([0-9a-fA-F]{32})", value)
    if match:
        compact = match.group(1).lower()
    else:
        uuid_match = re.search(
            r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})",
            value,
        )
        if uuid_match:
            compact = uuid_match.group(1).replace("-", "").lower()
    if not compact:
        raise ValueError(f"Could not find a Notion page id in: {value}")
    return f"{compact[0:8]}-{compact[8:12]}-{compact[12:16]}-{compact[16:20]}-{compact[20:32]}"


def rich_text(text: str) -> list[dict]:
    chunks = []
    remaining = str(text)
    while remaining:
        chunk, remaining = remaining[:2000], remaining[2000:]
        chunks.append({"type": "text", "text": {"content": chunk}})
    return chunks or [{"type": "text", "text": {"content": ""}}]


def paragraph(text: str) -> dict:
    return {"object": "block", "type": "paragraph", "paragraph": {"rich_text": rich_text(text)}}


def toggle(title: str, children: list[dict] | None = None) -> dict:
    block = {
        "object": "block",
        "type": "toggle",
        "toggle": {"rich_text": rich_text(title), "color": "default"},
    }
    if children is not None:
        block["toggle"]["children"] = children
    return block


def paragraphs(text: str, *, chunk_size: int = 1800) -> list[dict]:
    value = str(text).strip()
    if not value:
        return [paragraph("")]
    blocks = []
    while value:
        chunk, value = value[:chunk_size], value[chunk_size:]
        blocks.append(paragraph(chunk))
    return blocks


def heading_2_toggle(title: str) -> dict:
    return {
        "object": "block",
        "type": "heading_2",
        "heading_2": {
            "rich_text": rich_text(title),
            "color": "default",
            "is_toggleable": True,
        },
    }


def plain_text_from_rich_text(items: list[dict] | None) -> str:
    return "".join(item.get("plain_text") or item.get("text", {}).get("content", "") for item in (items or []))


def block_text(block: dict) -> str:
    block_type = block.get("type")
    value = block.get(block_type, {}) if block_type else {}
    return plain_text_from_rich_text(value.get("rich_text") or value.get("title")).strip()


def detect_tasks(blocks: list[dict]) -> list[Task]:
    tasks: list[Task] = []
    for block in blocks:
        block_type = block.get("type")
        if block_text(block) == "実行結果" and block_type in {"toggle", "heading_2"}:
            continue
        if block_type not in {"bulleted_list_item", "numbered_list_item", "paragraph"}:
            continue
        text = block_text(block)
        if not text:
            continue
        tasks.append(Task(text=text, source_block_id=block.get("id", ""), source_type=block_type))
    return tasks


def load_env_token(workdir: Path) -> str:
    token = os.environ.get("NOTION_OAUTH_ACCESS_TOKEN") or os.environ.get("NOTION_TOKEN")
    if token:
        return token
    env_path = workdir / ".env"
    if env_path.exists():
        match = re.search(r'^NOTION_OAUTH_ACCESS_TOKEN="?([^"\n]+)"?', env_path.read_text(encoding="utf-8"), re.M)
        if match:
            return match.group(1)
    raise SystemExit("ERROR: NOTION_OAUTH_ACCESS_TOKEN is not set and was not found in .env")


class NotionClient:
    def __init__(self, token: str):
        self.token = token

    def request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            f"https://api.notion.com/v1/{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Notion API {method} {path} failed: {exc.code} {detail}") from exc

    def children(self, block_id: str) -> list[dict]:
        results: list[dict] = []
        cursor = ""
        while True:
            query = "page_size=100"
            if cursor:
                query += f"&start_cursor={cursor}"
            data = self.request("GET", f"blocks/{block_id}/children?{query}")
            results.extend(data.get("results", []))
            cursor = data.get("next_cursor") or ""
            if not cursor:
                return results

    def append_children(self, block_id: str, children: list[dict]) -> dict:
        return self.request("PATCH", f"blocks/{block_id}/children", {"children": children})


def ensure_result_toggle(client: NotionClient, page_id: str, top_blocks: list[dict]) -> dict:
    for block in top_blocks:
        if (
            block.get("type") == "heading_2"
            and block_text(block) == "実行結果"
            and block.get("heading_2", {}).get("is_toggleable") is True
        ):
            return block
    created = client.append_children(page_id, [heading_2_toggle("実行結果")])
    return created["results"][0]


def ensure_task_toggle(client: NotionClient, result_toggle_id: str, task: Task, existing_children: list[dict]) -> dict:
    for block in existing_children:
        if block.get("type") == "toggle" and block_text(block) == task.text:
            return block
    created = client.append_children(
        result_toggle_id,
        [toggle(task.text)],
    )
    return created["results"][0]


def task_result_status(client: NotionClient, task_toggle_id: str) -> str:
    for child in client.children(task_toggle_id):
        if child.get("type") != "toggle" or block_text(child) != "実行ログ":
            continue
        for log_child in client.children(child.get("id", "")):
            text = block_text(log_child)
            match = re.match(r"Status:\s*(.+)\s*$", text)
            if match:
                return match.group(1).strip()
    return ""


def priority_rank(task: Task) -> int:
    text = task.text
    match = re.search(r"\bP([0-9])\b|\[P([0-9])\]|優先度[:：]?\s*([0-9])", text, re.I)
    if match:
        value = next(group for group in match.groups() if group is not None)
        return int(value)
    if any(marker in text for marker in ("最優先", "高優先", "高 priority", "high priority")):
        return 0
    return 99


def strip_runner_metadata(output: str) -> str:
    text = output.strip()
    text = re.sub(r"(?m)^RALPH_CODEX_RESUME_DONE_[^\n]*\n?", "", text)
    text = re.sub(r"```text\s*RALPH_LOOP_STATUS:.*?RALPH_LOOP_END\s*```", "", text, flags=re.S)
    text = re.sub(r"(?m)^RALPH_LOOP_(STATUS|SUMMARY|NEXT_PROMPT|END):.*\n?", "", text)
    return text.strip()


def referenced_markdown_paths(text: str, workdir: Path) -> list[Path]:
    workdir = workdir.resolve()
    candidates: list[str] = []
    candidates.extend(re.findall(r"\]\((/[^)\n]+?\.md)\)", text))
    candidates.extend(re.findall(r"\]\((RALPH_TASKS/[^)\n]+?\.md)\)", text))
    candidates.extend(re.findall(r"(?<!\()((?:RALPH_TASKS|docs|task)/[^\s)`]+?\.md)", text))
    paths: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        path = Path(candidate)
        if not path.is_absolute():
            path = workdir / path
        path = path.resolve()
        try:
            path.relative_to(workdir)
        except ValueError:
            continue
        if path.exists() and path.suffix == ".md" and path not in seen:
            paths.append(path)
            seen.add(path)
    return paths


def actual_output_text(result: RunnerResult, *, run_dir: Path, workdir: Path) -> str:
    for path in referenced_markdown_paths(result.output, workdir):
        return path.read_text(encoding="utf-8").strip()
    cleaned = strip_runner_metadata(result.output)
    return cleaned or result.summary or f"No output was captured. See run directory: {run_dir}"


def run_log_toggle(
    *,
    status: str,
    run_id: str,
    run_dir: Path,
    rc: int | None,
    summary: str,
) -> dict:
    lines = [
        f"Status: {status}",
        f"Run ID: {run_id}",
        f"Run directory: {run_dir}",
    ]
    if rc is not None:
        lines.append(f"Exit code: {rc}")
    if summary:
        lines.append(f"Summary: {summary}")
    return toggle("実行ログ", [paragraph(line) for line in lines])


def run_log_lines(
    *,
    status: str,
    run_id: str,
    run_dir: Path,
    rc: int | None,
    summary: str,
) -> list[str]:
    lines = [
        f"Status: {status}",
        f"Run ID: {run_id}",
        f"Run directory: {run_dir}",
    ]
    if rc is not None:
        lines.append(f"Exit code: {rc}")
    if summary:
        lines.append(f"Summary: {summary}")
    return lines


def append_result(
    client: NotionClient,
    task_toggle_id: str,
    *,
    output_text: str,
    status: str,
    run_id: str,
    run_dir: Path,
    rc: int | None,
    summary: str,
) -> None:
    created = client.append_children(
        task_toggle_id,
        [
            *paragraphs(output_text),
            toggle("実行ログ"),
        ],
    )
    log_toggle = next((block for block in created.get("results", []) if block.get("type") == "toggle"), None)
    if log_toggle:
        client.append_children(
            log_toggle["id"],
            [
                paragraph(line)
                for line in run_log_lines(status=status, run_id=run_id, run_dir=run_dir, rc=rc, summary=summary)
            ],
        )


def make_run_id(index: int) -> str:
    return f"notion-shell-loop-{time.strftime('%Y%m%d-%H%M%S')}-{index:02d}"


def build_runner_command(
    *,
    runner: str,
    task: str,
    max_iterations: int,
    run_id: str,
    workdir: str,
) -> list[str]:
    return [
        runner,
        "--task",
        task,
        "--max-iterations",
        str(max_iterations),
        "--run-id",
        run_id,
        "--workdir",
        workdir,
    ]


def parse_runner_result(run_dir: Path) -> RunnerResult:
    state_path = run_dir / "state.json"
    if not state_path.exists():
        return RunnerResult(status="blocked", summary="runner did not write state.json", output="")
    state = json.loads(state_path.read_text(encoding="utf-8"))
    outputs = sorted(run_dir.glob("turn-*-output.md"))
    output = outputs[-1].read_text(encoding="utf-8") if outputs else ""
    return RunnerResult(
        status=state.get("last_status", "blocked"),
        summary=state.get("last_summary", ""),
        output=output,
    )


def run_task(command: list[str], *, cwd: Path) -> int:
    print("[shell-loop-notion] " + " ".join(command), flush=True)
    process = subprocess.Popen(
        command,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    if process.stdout:
        try:
            for line in process.stdout:
                print(line, end="", flush=True)
        finally:
            process.stdout.close()
    return process.wait()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run Notion page tasks one by one through shell-loop.")
    parser.add_argument("page", help="Notion page URL or page id")
    parser.add_argument("--max-iterations", type=int, default=1, help="Max Codex resume turns per single Notion task")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of tasks for this run; 0 means all")
    parser.add_argument("--runner", default="./scripts/ralph-codex-loop.sh")
    parser.add_argument("--workdir", default=os.getcwd())
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--include-completed", action="store_true", help="Run tasks that already have Status: Done results")
    parser.add_argument("--priority-sort", action="store_true", help="Prefer tasks marked P0/P1/P2 before page order")
    args = parser.parse_args(argv)

    workdir = Path(args.workdir).resolve()
    page_id = extract_page_id(args.page)
    token = load_env_token(workdir)
    client = NotionClient(token)

    top_blocks = client.children(page_id)
    tasks = detect_tasks(top_blocks)
    if not tasks:
        print("[shell-loop-notion] no tasks detected")
        return 0

    result_toggle = ensure_result_toggle(client, page_id, top_blocks)
    result_children = client.children(result_toggle["id"])
    selected_tasks: list[tuple[Task, dict]] = []
    for task in sorted(tasks, key=priority_rank) if args.priority_sort else tasks:
        task_toggle = ensure_task_toggle(client, result_toggle["id"], task, result_children)
        result_children.append(task_toggle)
        status = "" if args.include_completed else task_result_status(client, task_toggle["id"])
        if status in {"Done", "Blocked"}:
            print(f"[shell-loop-notion] skip {status.lower()} task: {task.text}", flush=True)
            continue
        selected_tasks.append((task, task_toggle))
        if args.limit and len(selected_tasks) >= args.limit:
            break

    if not selected_tasks:
        print("[shell-loop-notion] no runnable tasks detected")
        return 0

    runner_stem = Path(args.runner).stem
    state_root = workdir / (".claude" if "claude" in runner_stem else ".codex") / runner_stem

    completed = 0
    handled = 0
    for index, (task, task_toggle) in enumerate(selected_tasks, start=1):
        run_id = make_run_id(index)
        run_dir = state_root / run_id
        if args.dry_run:
            append_result(
                client,
                task_toggle["id"],
                output_text="dry run; runner was not invoked",
                status="Blocked",
                run_id=run_id,
                run_dir=run_dir,
                rc=None,
                summary="dry run; runner was not invoked",
            )
            continue
        command = build_runner_command(
            runner=args.runner,
            task=task.text,
            max_iterations=args.max_iterations,
            run_id=run_id,
            workdir=str(workdir),
        )
        rc = run_task(command, cwd=workdir)
        result = parse_runner_result(run_dir)
        output_text = actual_output_text(result, run_dir=run_dir, workdir=workdir)
        if rc == 0 and result.status == "complete":
            append_result(
                client,
                task_toggle["id"],
                output_text=output_text,
                status="Done",
                run_id=run_id,
                run_dir=run_dir,
                rc=rc,
                summary=result.summary,
            )
            completed += 1
            handled += 1
        else:
            status = "Blocked" if result.status == "blocked" else "Failed"
            append_result(
                client,
                task_toggle["id"],
                output_text=output_text,
                status=status,
                run_id=run_id,
                run_dir=run_dir,
                rc=rc,
                summary=result.summary or f"runner rc={rc}",
            )
            if status == "Blocked":
                handled += 1

    print(f"[shell-loop-notion] completed {completed}/{len(selected_tasks)} tasks")
    if args.dry_run:
        return 0
    return 0 if handled == len(selected_tasks) else 2


if __name__ == "__main__":
    raise SystemExit(main())
