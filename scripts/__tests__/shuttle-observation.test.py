import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/lib/shuttle-observation.py"
CATALOG = ROOT / "scripts/lib/shuttle-reasons.json"


class ShuttleObservationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = pathlib.Path(self.tmp.name) / "state"
        self.inventory = pathlib.Path(self.tmp.name) / "inventory.json"
        self.inventory.write_text(
            json.dumps(
                [
                    {
                        "projectName": "flywheel",
                        "unitKind": "core_repo",
                        "ownerKey": "flywheel",
                        "displayName": "Flywheel core",
                    },
                    {
                        "projectName": "raya",
                        "unitKind": "external_repo",
                        "ownerKey": "raya-repo",
                        "displayName": "Raya",
                    },
                ]
            )
        )
        self.env = {
            **os.environ,
            "SHUTTLE_OBSERVATION_ALLOW_TEST_ROOT": "1",
        }

    def run_helper(self, *args, ok=True, now="2026-09-17T12:06:23Z"):
        completed = subprocess.run(
            [
                sys.executable,
                str(HELPER),
                "--state-root",
                str(self.state),
                "--catalog",
                str(CATALOG),
                "--now",
                now,
                *map(str, args),
            ],
            cwd=ROOT,
            env=self.env,
            text=True,
            capture_output=True,
        )
        if ok and completed.returncode != 0:
            self.fail(
                f"helper failed rc={completed.returncode}\nstdout={completed.stdout}\nstderr={completed.stderr}"
            )
        if not ok:
            self.assertNotEqual(completed.returncode, 0, completed.stdout)
            return completed
        return json.loads(completed.stdout)

    def begin(self, wake="scheduled", now="2026-09-17T12:06:23Z"):
        return self.run_helper(
            "begin",
            "--wake-kind",
            wake,
            "--inventory",
            self.inventory,
            "--owner-pid",
            os.getpid(),
            "--owner-start",
            "fixture-process-start",
            now=now,
        )

    def write_result(self, name, **overrides):
        result = {
            "projectName": "raya",
            "unitKind": "external_repo",
            "ownerKey": "raya-repo",
            "displayName": "Raya",
            "outcome": "failed",
            "reason": "prestop-validation-failed",
            "evidenceRef": "raya:prestop",
            "logRef": "flywheel-updater.log#raya",
            "deployedSha": "0" * 40,
            "targetSha": "1" * 40,
            "behindCommits": 105,
            "driftBasis": "first_observed_behind",
        }
        result.update(overrides)
        path = pathlib.Path(self.tmp.name) / f"{name}.json"
        path.write_text(json.dumps(result))
        return path

    def record(self, cycle, name="result", **overrides):
        return self.run_helper(
            "record",
            "--cycle-id",
            cycle["cycleId"],
            "--result",
            self.write_result(name, **overrides),
        )

    def finish(self, cycle, legacy="scheduled_deployed"):
        return self.run_helper(
            "finish", "--cycle-id", cycle["cycleId"], "--legacy-result", legacy
        )

    def export(self):
        return self.run_helper("export", "--after-change-seq", 0, "--limit", 200)

    def helper_command(self, *args, now="2026-09-17T12:06:23Z"):
        return [
            sys.executable,
            str(HELPER),
            "--state-root",
            str(self.state),
            "--catalog",
            str(CATALOG),
            "--now",
            now,
            *map(str, args),
        ]

    def test_failure_duplicate_conflict_and_partial_failure_summary(self):
        cycle = self.begin()
        failed = self.record(cycle)
        self.assertEqual(failed["unit"]["consecutiveScheduledBad"], 1)
        self.assertFalse(failed["unit"]["founderAware"])
        self.assertEqual(len(failed["createdIntents"]), 1)

        duplicate = self.record(cycle)
        self.assertEqual(duplicate["status"], "idempotent")
        self.assertEqual(duplicate["createdIntents"], [])

        conflict = self.run_helper(
            "record",
            "--cycle-id",
            cycle["cycleId"],
            "--result",
            self.write_result("conflict", behindCommits=106),
            ok=False,
        )
        self.assertIn("observation-conflict", conflict.stderr)

        self.record(
            cycle,
            "core",
            projectName="flywheel",
            unitKind="core_repo",
            ownerKey="flywheel",
            displayName="Flywheel core",
            outcome="deployed",
            reason="deployed",
            evidenceRef="deployed-sha",
            logRef="flywheel-updater.log#core",
            deployedSha="1" * 40,
            targetSha="1" * 40,
            behindCommits=0,
            driftBasis="unknown",
        )
        summary = self.finish(cycle)
        self.assertEqual(summary["result"], "partial_failure")
        self.assertEqual(summary["counts"]["failed"], 1)
        self.assertEqual(summary["counts"]["deployed"], 1)
        self.assertFalse(summary["allUnitsVerified"])

    def test_same_day_second_cycle_escalates_without_duplicate_alert(self):
        first = self.begin()
        self.record(first, "first")
        self.finish(first)
        second = self.begin(now="2026-09-17T23:59:00Z")
        again = self.record(second, "second")
        self.assertEqual(again["unit"]["consecutiveScheduledBad"], 2)
        self.assertTrue(again["unit"]["founderAware"])
        self.assertEqual(again["createdIntents"], [])
        exported = self.export()
        raya = next(item for item in exported["units"] if item["projectName"] == "raya")
        self.assertEqual(len(raya["notificationIntents"]), 1)

    def test_later_cycle_retries_an_undelivered_same_day_intent(self):
        first = self.begin()
        initial = self.record(first, "first-undelivered")
        self.record(
            first,
            "first-core",
            projectName="flywheel",
            unitKind="core_repo",
            ownerKey="flywheel",
            displayName="Flywheel core",
            outcome="up_to_date",
            reason="up-to-date",
            evidenceRef="deployed-sha",
            logRef="flywheel-updater.log#core",
            deployedSha="1" * 40,
            targetSha="1" * 40,
            behindCommits=0,
            driftBasis="unknown",
        )
        self.finish(first)

        second = self.begin(now="2026-09-17T23:59:00Z")
        repeated = self.record(second, "second-same-day")
        self.record(
            second,
            "second-core",
            projectName="flywheel",
            unitKind="core_repo",
            ownerKey="flywheel",
            displayName="Flywheel core",
            outcome="up_to_date",
            reason="up-to-date",
            evidenceRef="deployed-sha",
            logRef="flywheel-updater.log#core",
            deployedSha="1" * 40,
            targetSha="1" * 40,
            behindCommits=0,
            driftBasis="unknown",
        )
        self.finish(second)
        self.assertEqual(repeated["createdIntents"], [])

        prepared = self.run_helper(
            "prepare-dispatch",
            "--cycle-id",
            second["cycleId"],
            now="2026-09-17T23:59:01Z",
        )
        self.assertEqual(len(prepared["batches"]), 1)
        self.assertEqual(
            prepared["batches"][0]["intentIds"],
            [initial["createdIntents"][0]["intentId"]],
        )

    def test_alert_body_includes_confirmed_drift_hours(self):
        cycle = self.begin(now="2026-09-17T12:00:00Z")
        self.record(cycle, "drift-age")
        self.finish(cycle)
        prepared = self.run_helper(
            "prepare-dispatch",
            "--cycle-id",
            cycle["cycleId"],
            now="2026-09-17T14:06:23Z",
        )
        raya_batch = next(
            batch for batch in prepared["batches"] if "Raya" in batch["body"]
        )
        self.assertIn("已确认至少落后 2 小时", raya_batch["body"])

    def test_expected_skip_is_neutral_then_recovery_and_refailure_opens_new_episode(self):
        first = self.begin()
        initial = self.record(first, "initial")
        episode = initial["unit"]["episodeId"]
        self.finish(first)

        skipped_cycle = self.begin(now="2026-09-17T18:00:00Z")
        skipped = self.record(
            skipped_cycle,
            "skip",
            outcome="skipped",
            reason="not-in-deploy-wave",
            deployedSha=None,
            targetSha=None,
            behindCommits=None,
            driftBasis="unknown",
        )
        self.assertEqual(skipped["unit"]["episodeId"], episode)
        self.assertEqual(skipped["unit"]["consecutiveScheduledBad"], 1)
        self.assertEqual(skipped["createdIntents"], [])
        self.finish(skipped_cycle, "scheduled_current")

        recovery_cycle = self.begin(now="2026-09-17T19:00:00Z")
        recovered = self.record(
            recovery_cycle,
            "recovery",
            outcome="up_to_date",
            reason="up-to-date",
            deployedSha="1" * 40,
            targetSha="1" * 40,
            behindCommits=0,
            driftBasis="unknown",
        )
        self.assertIsNone(recovered["unit"]["episodeId"])
        self.assertEqual(recovered["unit"]["consecutiveScheduledBad"], 0)
        self.finish(recovery_cycle, "scheduled_current")

        failed_again_cycle = self.begin(now="2026-09-17T20:00:00Z")
        failed_again = self.record(failed_again_cycle, "failed-again")
        self.assertNotEqual(failed_again["unit"]["episodeId"], episode)
        self.assertEqual(len(failed_again["createdIntents"]), 1)
        exported = self.export()
        raya = next(item for item in exported["units"] if item["projectName"] == "raya")
        self.assertEqual(len(raya["notificationIntents"]), 2)

    def test_reason_changes_share_episode_but_have_separate_daily_budgets(self):
        first = self.begin()
        a1 = self.record(first, "a1")
        self.finish(first)
        second = self.begin(now="2026-09-17T13:00:00Z")
        b = self.record(second, "b", reason="source-prepare-failed")
        self.finish(second)
        third = self.begin(now="2026-09-17T14:00:00Z")
        a2 = self.record(third, "a2")
        self.assertEqual(a1["unit"]["episodeId"], b["unit"]["episodeId"])
        self.assertEqual(a1["unit"]["episodeId"], a2["unit"]["episodeId"])
        self.assertEqual(len(b["createdIntents"]), 1)
        self.assertEqual(a2["createdIntents"], [])

    def test_urgent_failure_does_not_increment_scheduled_count(self):
        urgent = self.begin("urgent")
        result = self.record(urgent, "urgent")
        self.assertEqual(result["unit"]["consecutiveScheduledBad"], 0)
        self.assertFalse(result["unit"]["founderAware"])

    def test_correlated_failures_roll_up_per_route_and_delivery_updates_children(self):
        cycle = self.begin()
        self.record(cycle, "raya")
        self.record(
            cycle,
            "core-failed",
            projectName="flywheel",
            unitKind="core_repo",
            ownerKey="flywheel",
            displayName="Flywheel core",
            evidenceRef="core-preflight",
            logRef="flywheel-updater.log#core",
        )
        self.finish(cycle, "scheduled_failed")
        prepared = self.run_helper(
            "prepare-dispatch",
            "--cycle-id",
            cycle["cycleId"],
            "--copy-project",
            "raya",
        )
        self.assertEqual(len(prepared["batches"]), 2)
        primary = next(
            batch for batch in prepared["batches"] if batch["routeKey"] == "primary"
        )
        copy = next(
            batch
            for batch in prepared["batches"]
            if batch["routeKey"] == "project_copy"
        )
        self.assertEqual(primary["unitCount"], 2)
        self.assertEqual(copy["unitCount"], 1)
        self.assertIn("2 个单元同因异常", primary["title"])

        receipt = self.run_helper(
            "delivery",
            "--intent-id",
            primary["batchId"],
            "--state",
            "sent",
            "--message-id",
            "300000000000000001",
            "--channel-id",
            "100000000000000001",
            "--binding-digest",
            "a" * 64,
        )
        self.assertEqual(receipt["deliveryState"], "sent")
        intent = self.run_helper("intent", "--intent-id", primary["batchId"])
        self.assertEqual(intent["messageId"], "300000000000000001")
        repeated = self.run_helper(
            "prepare-dispatch", "--cycle-id", cycle["cycleId"]
        )
        self.assertEqual(repeated["batches"], [])

    def test_concurrent_duplicate_is_serialized_and_export_paginates(self):
        cycle = self.begin()
        result = self.write_result("concurrent")
        command = self.helper_command(
            "record", "--cycle-id", cycle["cycleId"], "--result", result
        )
        first = subprocess.Popen(
            command, cwd=ROOT, env=self.env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        second = subprocess.Popen(
            command, cwd=ROOT, env=self.env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        outputs = [first.communicate(), second.communicate()]
        self.assertEqual([first.returncode, second.returncode], [0, 0], outputs)
        statuses = sorted(json.loads(stdout)["status"] for stdout, _ in outputs)
        self.assertEqual(statuses, ["idempotent", "recorded"])
        page = self.run_helper("export", "--after-change-seq", 0, "--limit", 1)
        self.assertEqual(len(page["changes"]), 1)
        self.assertFalse(page["hasMore"])
        self.assertGreater(page["nextCursor"], 0)

    def test_begin_materializes_immutable_bundle_and_rejects_symlink_root(self):
        cycle = self.begin()
        bundle = self.state / "bundles" / cycle["observerBundleDigest"]
        self.assertTrue((bundle / "shuttle-observation.py").is_file())
        self.assertTrue((bundle / "shuttle-observation.sh").is_file())
        self.assertTrue((bundle / "shuttle-reasons.json").is_file())
        symlink = pathlib.Path(self.tmp.name) / "linked-state"
        symlink.symlink_to(self.state, target_is_directory=True)
        completed = subprocess.run(
            [
                sys.executable,
                str(HELPER),
                "--state-root",
                str(symlink),
                "--catalog",
                str(CATALOG),
                "show",
            ],
            cwd=ROOT,
            env=self.env,
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("symlink", completed.stderr)

    def test_state_root_requires_explicit_test_guard(self):
        env = dict(self.env)
        env.pop("SHUTTLE_OBSERVATION_ALLOW_TEST_ROOT")
        completed = subprocess.run(
            [
                sys.executable,
                str(HELPER),
                "--state-root",
                str(self.state),
                "--catalog",
                str(CATALOG),
                "show",
            ],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("test root", completed.stderr)


if __name__ == "__main__":
    unittest.main()
