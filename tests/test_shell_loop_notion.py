import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "shell-loop-notion.py"
spec = importlib.util.spec_from_file_location("shell_loop_notion", SCRIPT)
shell_loop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shell_loop)


def block(block_type, text, block_id=None):
    key = "rich_text"
    return {
        "id": block_id or f"{block_type}-{text}",
        "type": block_type,
        block_type: {
            key: [{"plain_text": text, "type": "text", "text": {"content": text}}],
        },
    }


class FakeNotionClient:
    def __init__(self):
        self.appended = []

    def append_children(self, block_id, children):
        self.appended.append((block_id, children))
        return {
            "results": [
                {
                    "id": "created-result",
                    **children[0],
                }
            ]
        }


class ChildrenNotionClient:
    def __init__(self, children_by_id):
        self.children_by_id = children_by_id

    def children(self, block_id):
        return self.children_by_id.get(block_id, [])


class ShellLoopNotionTest(unittest.TestCase):
    def test_extract_page_id_from_notion_url(self):
        url = "https://app.notion.com/p/aice-co-jp/384e00135b618115a436f2b9c6af4778?source=copy_link"

        self.assertEqual(
            shell_loop.extract_page_id(url),
            "384e0013-5b61-8115-a436-f2b9c6af4778",
        )

    def test_detect_tasks_from_bullets_numbers_and_blank_paragraphs(self):
        blocks = [
            block("heading_1", "Shell Loop Task List"),
            block("bulleted_list_item", "計算: 足し算をする", "b1"),
            block("numbered_list_item", "クイズ: 問題を作る", "n1"),
            block("paragraph", "ユーモア: ジョークを書く", "p1"),
            block("paragraph", "", "blank"),
            block("paragraph", "レポート: 進捗を書く", "p2"),
            block("toggle", "実行結果", "result"),
            {
                "id": "heading-result",
                "type": "heading_2",
                "heading_2": {
                    "rich_text": [{"plain_text": "実行結果", "type": "text", "text": {"content": "実行結果"}}],
                    "is_toggleable": True,
                },
            },
        ]

        tasks = shell_loop.detect_tasks(blocks)

        self.assertEqual([task.text for task in tasks], [
            "計算: 足し算をする",
            "クイズ: 問題を作る",
            "ユーモア: ジョークを書く",
            "レポート: 進捗を書く",
        ])
        self.assertEqual([task.source_block_id for task in tasks], ["b1", "n1", "p1", "p2"])

    def test_ensure_result_toggle_creates_heading_2_toggle(self):
        client = FakeNotionClient()

        result = shell_loop.ensure_result_toggle(client, "page-id", [])

        self.assertEqual(result["type"], "heading_2")
        self.assertEqual(shell_loop.block_text(result), "実行結果")
        self.assertIs(result["heading_2"]["is_toggleable"], True)

    def test_ensure_result_toggle_reuses_existing_heading_2_toggle(self):
        existing = {
            "id": "existing-result",
            "type": "heading_2",
            "heading_2": {
                "rich_text": [{"plain_text": "実行結果", "type": "text", "text": {"content": "実行結果"}}],
                "is_toggleable": True,
            },
        }
        client = FakeNotionClient()

        result = shell_loop.ensure_result_toggle(client, "page-id", [block("toggle", "実行結果"), existing])

        self.assertEqual(result["id"], "existing-result")
        self.assertEqual(client.appended, [])

    def test_build_runner_command_uses_one_task_only(self):
        command = shell_loop.build_runner_command(
            runner="./scripts/ralph-codex-loop.sh",
            task="計算: 足し算をする",
            max_iterations=2,
            run_id="notion-shell-loop-01",
            workdir="/repo",
        )

        self.assertEqual(command[:2], ["./scripts/ralph-codex-loop.sh", "--task"])
        self.assertIn("計算: 足し算をする", command)
        self.assertIn("--max-iterations", command)
        self.assertIn("2", command)
        self.assertIn("--run-id", command)
        self.assertIn("notion-shell-loop-01", command)

    def test_parse_runner_state_returns_summary_and_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            (run_dir / "state.json").write_text(
                json.dumps({
                    "last_status": "complete",
                    "last_summary": "done summary",
                    "turns": [{"turn": 1, "summary": "turn summary"}],
                }),
                encoding="utf-8",
            )
            (run_dir / "turn-01-output.md").write_text("final output", encoding="utf-8")

            result = shell_loop.parse_runner_result(run_dir)

            self.assertEqual(result.status, "complete")
            self.assertEqual(result.summary, "done summary")
            self.assertEqual(result.output, "final output")

    def test_actual_output_prefers_referenced_markdown_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            workdir = Path(tmp)
            artifact = workdir / "RALPH_TASKS" / "output" / "result.md"
            artifact.parent.mkdir(parents=True)
            artifact.write_text("# Actual Output\n\nThis should be shown.", encoding="utf-8")
            result = shell_loop.RunnerResult(
                status="complete",
                summary="summary",
                output=f"作成しました: [result]({artifact})\n\nRALPH_CODEX_RESUME_DONE_x\n",
            )

            output = shell_loop.actual_output_text(result, run_dir=workdir / ".codex" / "run", workdir=workdir)

            self.assertEqual(output, "# Actual Output\n\nThis should be shown.")

    def test_strip_runner_metadata_removes_loop_markers(self):
        output = """実際の結果です。

RALPH_CODEX_RESUME_DONE_run

```text
RALPH_LOOP_STATUS: complete
RALPH_LOOP_SUMMARY: metadata
RALPH_LOOP_NEXT_PROMPT:

RALPH_LOOP_END
```"""

        self.assertEqual(shell_loop.strip_runner_metadata(output), "実際の結果です。")

    def test_append_result_writes_output_then_log_toggle(self):
        client = FakeNotionClient()

        shell_loop.append_result(
            client,
            "task-toggle",
            output_text="実際のアウトプット",
            status="Done",
            run_id="run-1",
            run_dir=Path("/repo/.codex/run-1"),
            rc=0,
            summary="summary",
        )

        block_id, children = client.appended[-1]
        self.assertEqual(block_id, "task-toggle")
        self.assertEqual(children[0]["type"], "paragraph")
        self.assertEqual(shell_loop.block_text(children[0]), "実際のアウトプット")
        self.assertEqual(children[1]["type"], "toggle")
        self.assertEqual(shell_loop.block_text(children[1]), "実行ログ")
        log_children = children[1]["toggle"]["children"]
        self.assertEqual([shell_loop.block_text(child) for child in log_children], [
            "Status: Done",
            "Run ID: run-1",
            "Run directory: /repo/.codex/run-1",
            "Exit code: 0",
            "Summary: summary",
        ])

    def test_task_result_status_reads_done_from_log_toggle(self):
        client = ChildrenNotionClient({
            "task-toggle": [{"id": "log-toggle", **shell_loop.toggle("実行ログ")}],
            "log-toggle": [shell_loop.paragraph("Status: Done")],
        })

        self.assertEqual(shell_loop.task_result_status(client, "task-toggle"), "Done")

    def test_priority_rank_prefers_p_markers(self):
        ordered = sorted(
            [
                shell_loop.Task("あとでやる", "a", "paragraph"),
                shell_loop.Task("[P1] 次にやる", "b", "paragraph"),
                shell_loop.Task("P0 最優先でやる", "c", "paragraph"),
            ],
            key=shell_loop.priority_rank,
        )

        self.assertEqual([task.source_block_id for task in ordered], ["c", "b", "a"])


if __name__ == "__main__":
    unittest.main()
