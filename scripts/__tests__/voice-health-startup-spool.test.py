#!/usr/bin/env python3
"""Hermetic contracts for the pre-config voice startup spool."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
import uuid


REPO_ROOT = Path(__file__).resolve().parents[2]
HELPER = REPO_ROOT / "scripts" / "lib" / "voice-health-startup-spool.py"


def run_helper(home: Path, reason: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    environment = {"HOME": str(home), "PATH": os.environ.get("PATH", "")}
    return subprocess.run(
        ["python3", str(HELPER), "record", reason],
        env=environment,
        text=True,
        capture_output=True,
        check=check,
    )


class VoiceHealthStartupSpoolTest(unittest.TestCase):
    def test_records_one_private_atomic_document_without_external_identity(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            receipt = json.loads(run_helper(home, "startup_config_invalid").stdout)
            spool = home / ".flywheel" / "voice-startup-spool"
            documents = list(spool.glob("*.json"))

            self.assertEqual(receipt["status"], "recorded")
            self.assertEqual(len(documents), 1)
            payload = json.loads(documents[0].read_text(encoding="utf-8"))
            self.assertEqual(payload["schemaVersion"], 1)
            self.assertEqual(payload["operation"], "startup")
            self.assertEqual(payload["reasonClass"], "startup_config_invalid")
            self.assertEqual(payload["startupAttemptId"], receipt["startupAttemptId"])
            uuid.UUID(payload["startupAttemptId"])
            self.assertTrue(payload["observedAt"].endswith("Z"))
            self.assertEqual(
                set(payload),
                {
                    "schemaVersion",
                    "startupAttemptId",
                    "observedAt",
                    "reasonClass",
                    "operation",
                },
            )
            self.assertEqual(stat.S_IMODE(spool.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(documents[0].stat().st_mode), 0o600)

    def test_concurrent_writers_are_isolated_and_never_replace_each_other(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            processes = [
                subprocess.Popen(
                    ["python3", str(HELPER), "record", "startup_not_ready"],
                    env={"HOME": str(home), "PATH": os.environ.get("PATH", "")},
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                for _ in range(12)
            ]
            receipts = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, stderr)
                receipts.append(json.loads(stdout))

            documents = list((home / ".flywheel" / "voice-startup-spool").glob("*.json"))
            attempt_ids = {receipt["startupAttemptId"] for receipt in receipts}
            self.assertEqual(len(attempt_ids), 12)
            self.assertEqual(len(documents), 12)
            self.assertEqual(
                {json.loads(path.read_text())["startupAttemptId"] for path in documents},
                attempt_ids,
            )

    def test_rejects_unknown_reason_and_untrusted_or_overpermissive_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            unknown = run_helper(home, "raw-secret /private/path", check=False)
            self.assertNotEqual(unknown.returncode, 0)
            self.assertIn("startup_reason_invalid", unknown.stderr)

        with tempfile.TemporaryDirectory() as raw, tempfile.TemporaryDirectory() as outside:
            home = Path(raw)
            (home / ".flywheel").symlink_to(Path(outside), target_is_directory=True)
            linked = run_helper(home, "startup_not_ready", check=False)
            self.assertNotEqual(linked.returncode, 0)
            self.assertIn("startup_spool_path_invalid", linked.stderr)

        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            flywheel = home / ".flywheel"
            flywheel.mkdir(mode=0o777)
            flywheel.chmod(0o777)
            permissive = run_helper(home, "startup_not_ready", check=False)
            self.assertNotEqual(permissive.returncode, 0)
            self.assertIn("startup_spool_path_invalid", permissive.stderr)

    def test_refuses_a_full_spool_without_removing_existing_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            spool = home / ".flywheel" / "voice-startup-spool"
            spool.mkdir(parents=True, mode=0o700)
            spool.chmod(0o700)
            for index in range(128):
                document = spool / f"{index:064x}.json"
                document.write_text("{}\n", encoding="utf-8")
                document.chmod(0o600)

            full = run_helper(home, "startup_not_ready", check=False)
            self.assertNotEqual(full.returncode, 0)
            self.assertIn("startup_spool_full", full.stderr)
            self.assertEqual(len(list(spool.glob("*.json"))), 128)


if __name__ == "__main__":
    unittest.main()
