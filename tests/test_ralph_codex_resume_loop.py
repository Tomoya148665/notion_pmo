import importlib.util
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ralph-codex-resume-loop.py"
spec = importlib.util.spec_from_file_location("ralph_codex_resume_loop", SCRIPT)
ralph = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ralph)


class RalphCodexResumeLoopTest(unittest.TestCase):
    def test_parse_turn_result_extracts_status_summary_and_next_prompt(self):
        text = """Work finished for now.

RALPH_LOOP_STATUS: continue
RALPH_LOOP_SUMMARY: fixed the parser and found one failing hook
RALPH_LOOP_NEXT_PROMPT:
Run the focused hook again and patch the failing assertion.
RALPH_LOOP_END
"""

        result = ralph.parse_turn_result(text)

        self.assertEqual(result.status, "continue")
        self.assertEqual(result.summary, "fixed the parser and found one failing hook")
        self.assertEqual(result.next_prompt, "Run the focused hook again and patch the failing assertion.")

    def test_parse_turn_result_defaults_to_continue_without_control_block(self):
        result = ralph.parse_turn_result("No control block here.")

        self.assertEqual(result.status, "continue")
        self.assertEqual(result.summary, "")
        self.assertEqual(result.next_prompt, "")

    def test_parse_turn_result_accepts_complete_and_empty_next_prompt(self):
        result = ralph.parse_turn_result(
            """RALPH_LOOP_STATUS: complete
RALPH_LOOP_SUMMARY: hooks pass
RALPH_LOOP_NEXT_PROMPT:
RALPH_LOOP_END
"""
        )

        self.assertEqual(result.status, "complete")
        self.assertEqual(result.summary, "hooks pass")
        self.assertEqual(result.next_prompt, "")

    def test_build_initial_prompt_contains_contract_and_one_turn_limit(self):
        prompt = ralph.build_initial_prompt(
            task="Implement a tiny feature.",
            max_iterations=5,
            hooks=["npx tsc --noEmit"],
            completion_promise="RALPH_CODEX_DONE_TEST",
        )

        self.assertIn("Implement a tiny feature.", prompt)
        self.assertIn("Do exactly one worker turn", prompt)
        self.assertIn("npx tsc --noEmit", prompt)
        self.assertIn("RALPH_CODEX_DONE_TEST", prompt)
        self.assertIn("RALPH_LOOP_STATUS: continue|complete|blocked", prompt)
        self.assertIn("Read existing repository files as context", prompt)
        self.assertIn("Do not treat prior completed Ralph progress files as proof that this new run is complete", prompt)

    def test_build_resume_prompt_prefers_worker_next_prompt(self):
        prompt = ralph.build_resume_prompt(
            task="Original task",
            turn_number=2,
            max_iterations=5,
            previous_output="Previous result",
            previous_result=ralph.TurnResult(
                status="continue",
                summary="Need one more check",
                next_prompt="Use this precise next instruction.",
            ),
            hooks=[],
            completion_promise="RALPH_CODEX_DONE_TEST",
        )

        self.assertIn("Turn 2/5", prompt)
        self.assertIn("Use this precise next instruction.", prompt)
        self.assertIn("Previous result", prompt)
        self.assertIn("Original task", prompt)
        self.assertIn("This run's completion must be proven by this run's outputs", prompt)

    def test_extract_thread_id_from_json_event(self):
        self.assertEqual(
            ralph.extract_thread_id('{"type":"thread.started","thread_id":"019ede64-91d5-7400-9d76-c35220437269"}'),
            "019ede64-91d5-7400-9d76-c35220437269",
        )
        self.assertIsNone(ralph.extract_thread_id("not json"))
        self.assertIsNone(ralph.extract_thread_id('{"type":"turn.started"}'))

    def test_main_invokes_exec_then_resume_with_fake_codex(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake_codex = root / "fake_codex.py"
            calls_file = root / "calls.jsonl"
            fake_codex.write_text(
                """#!/usr/bin/env python3
import json
import pathlib
import sys

args = sys.argv[1:]
prompt = sys.stdin.read()
out = pathlib.Path(args[args.index("-o") + 1])
is_resume = "resume" in args
with open(%r, "a", encoding="utf-8") as f:
    f.write(json.dumps({"args": args, "prompt": prompt}) + "\\n")
if is_resume:
    out.write_text("RALPH_CODEX_RESUME_DONE_TEST\\nRALPH_LOOP_STATUS: complete\\nRALPH_LOOP_SUMMARY: done\\nRALPH_LOOP_NEXT_PROMPT:\\nRALPH_LOOP_END\\n", encoding="utf-8")
else:
    print(json.dumps({"type": "thread.started", "thread_id": "THREAD_TEST_123"}), flush=True)
    out.write_text("RALPH_LOOP_STATUS: continue\\nRALPH_LOOP_SUMMARY: first turn\\nRALPH_LOOP_NEXT_PROMPT:\\nPlease finish now.\\nRALPH_LOOP_END\\n", encoding="utf-8")
sys.exit(0)
"""
                % str(calls_file),
                encoding="utf-8",
            )
            os.chmod(fake_codex, 0o755)

            rc = ralph.main(
                [
                    "--task",
                    "Do two turns.",
                    "--max-iterations",
                    "3",
                    "--run-id",
                    "fake-run",
                    "--workdir",
                    str(root),
                    "--codex-bin",
                    str(fake_codex),
                    "--completion-promise",
                    "RALPH_CODEX_RESUME_DONE_TEST",
                ]
            )

            self.assertEqual(rc, 0)
            calls = [json.loads(line) for line in calls_file.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(calls), 2)
            self.assertNotIn("resume", calls[0]["args"])
            self.assertIn("resume", calls[1]["args"])
            self.assertIn("THREAD_TEST_123", calls[1]["args"])
            self.assertNotIn("--last", calls[1]["args"])
            state = json.loads((root / ".codex/ralph-codex-loop/fake-run/state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["thread_id"], "THREAD_TEST_123")
            self.assertEqual(state["last_status"], "complete")
            self.assertEqual(len(state["turns"]), 2)

    def test_invoke_codex_tees_child_stdout_to_log_and_parent_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fake_codex = root / "fake_streaming_codex.py"
            command_log = root / "command.log"
            fake_codex.write_text(
                """#!/usr/bin/env python3
import sys

sys.stdin.read()
print("child line 1", flush=True)
print("child line 2", flush=True)
sys.exit(0)
""",
                encoding="utf-8",
            )
            os.chmod(fake_codex, 0o755)

            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                result = ralph.invoke_codex([str(fake_codex)], "prompt text", cwd=root, command_log=command_log)

            self.assertEqual(result.return_code, 0)
            self.assertIn("child line 1", captured.getvalue())
            self.assertIn("child line 2", captured.getvalue())
            log_text = command_log.read_text(encoding="utf-8")
            self.assertIn("child line 1", log_text)
            self.assertIn("child line 2", log_text)


if __name__ == "__main__":
    unittest.main()
