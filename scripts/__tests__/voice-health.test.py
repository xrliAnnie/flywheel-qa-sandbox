#!/usr/bin/env python3
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import tempfile
import unittest
import uuid


REPO_ROOT = Path(__file__).resolve().parents[2]
HELPER = REPO_ROOT / "scripts" / "lib" / "voice-health.py"
SERVICE_LABEL = "com.flywheel.voice"
DEMAND_SOURCE_ID = "11111111-1111-4111-8111-111111111111"
BINDING_DIGEST = "b" * 64


def demand_digest(identities):
    encoded = json.dumps(
        identities, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def run_helper(state_root: Path, command: str, payload=None, check=True):
    completed = subprocess.run(
        [
            "python3",
            str(HELPER),
            "--state-root",
            str(state_root),
            command,
        ],
        input=None if payload is None else json.dumps(payload),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and completed.returncode != 0:
        raise AssertionError(
            f"helper failed rc={completed.returncode}: {completed.stderr}"
        )
    return completed


def output_json(completed: subprocess.CompletedProcess):
    return json.loads(completed.stdout)


class VoiceHealthStoreTests(unittest.TestCase):
    def register_boot(self, root: Path, boot_id=None):
        return output_json(
            run_helper(
                root,
                "register-boot",
                {
                    "bootId": boot_id or str(uuid.uuid4()),
                    "bootAt": "2026-09-18T03:30:00.000Z",
                },
            )
        )

    def record_demand(
        self,
        root: Path,
        revision: int,
        state="required",
        identities=None,
        digest=None,
        source_id=DEMAND_SOURCE_ID,
    ):
        identities = identities if identities is not None else [{"demandId": "meeting-1"}]
        return run_helper(
            root,
            "record-demand",
            {
                "demandSourceId": source_id,
                "revision": revision,
                "digest": digest or demand_digest(identities),
                "state": state,
                "observedAt": "2026-09-18T03:30:01.000Z",
                "identities": identities,
            },
        )

    def record_result(
        self,
        root: Path,
        generation: int,
        event_seq: int,
        result_kind: str,
        observed_at: str,
        **extra,
    ):
        return run_helper(
            root,
            "record-result",
            {
                "generation": generation,
                "producerEventSeq": event_seq,
                "resultKind": result_kind,
                "observedAt": observed_at,
                **extra,
            },
        )

    def test_init_creates_secure_stable_identity_and_rebuilds_only_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            first = output_json(run_helper(root, "init"))
            second = output_json(run_helper(root, "init"))

            self.assertEqual(first, second)
            self.assertEqual(first["schemaVersion"], 1)
            self.assertEqual(first["serviceLabel"], SERVICE_LABEL)
            uuid.UUID(first["sourceId"])
            uuid.UUID(first["hostIdentity"])

            health_dir = root / "state" / "voice-health"
            identity_path = health_dir / "host-instance-id"
            database_path = health_dir / "observations.sqlite"
            self.assertEqual(stat.S_IMODE(health_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(identity_path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(database_path.stat().st_mode), 0o600)

            database_path.unlink()
            rebuilt = output_json(run_helper(root, "init"))
            self.assertEqual(rebuilt["hostIdentity"], first["hostIdentity"])
            self.assertEqual(rebuilt["serviceId"], first["serviceId"])
            self.assertNotEqual(rebuilt["sourceId"], first["sourceId"])

    def test_init_materializes_the_v1_schema_and_durable_connection_policy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            result = output_json(run_helper(root, "init"))
            self.assertEqual(
                result["storage"],
                {
                    "busyTimeoutMs": 100,
                    "journalMode": "wal",
                    "synchronous": "full",
                    "walAutoCheckpoint": 0,
                },
            )

            database_path = root / "state" / "voice-health" / "observations.sqlite"
            with sqlite3.connect(database_path) as database:
                tables = {
                    row[0]
                    for row in database.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
                self.assertTrue(
                    {
                        "metadata",
                        "health",
                        "producer_events",
                        "episodes",
                        "notification_intents",
                        "changes",
                    }.issubset(tables)
                )
                health_columns = {
                    row[1]
                    for row in database.execute("PRAGMA table_info(health)")
                }
                self.assertTrue(
                    {
                        "service_id",
                        "generation",
                        "boot_id",
                        "observation_seq",
                        "demand_revision",
                        "demand_state",
                        "last_iteration_success_at",
                        "last_progress_at",
                        "success_count",
                        "failure_count",
                        "failure_streak",
                        "first_failure_at",
                        "last_failure_at",
                        "reason_class",
                        "operation",
                        "duration_ms",
                        "source_status",
                    }.issubset(health_columns)
                )

    def test_register_boot_is_idempotent_and_sequences_are_source_global(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            first_boot = str(uuid.uuid4())
            second_boot = str(uuid.uuid4())
            boot_at = "2026-09-18T03:30:00.000Z"

            first = output_json(
                run_helper(
                    root,
                    "register-boot",
                    {"bootId": first_boot, "bootAt": boot_at},
                )
            )
            replay = output_json(
                run_helper(
                    root,
                    "register-boot",
                    {"bootId": first_boot, "bootAt": boot_at},
                )
            )
            second = output_json(
                run_helper(
                    root,
                    "register-boot",
                    {
                        "bootId": second_boot,
                        "bootAt": "2026-09-18T03:31:00.000Z",
                    },
                )
            )

            self.assertEqual(first["status"], "registered")
            self.assertEqual(replay["status"], "existing")
            self.assertEqual(first["generation"], 1)
            self.assertEqual(first["observationSeq"], 1)
            self.assertEqual(first["changeSeq"], 1)
            self.assertEqual(replay["generation"], 1)
            self.assertEqual(replay["observationSeq"], 1)
            self.assertEqual(replay["changeSeq"], 1)
            self.assertEqual(second["generation"], 2)
            self.assertEqual(second["observationSeq"], 2)
            self.assertEqual(second["changeSeq"], 2)

            database_path = root / "state" / "voice-health" / "observations.sqlite"
            with sqlite3.connect(database_path) as database:
                self.assertEqual(
                    database.execute(
                        "SELECT generation, boot_id, observation_seq FROM health"
                    ).fetchone(),
                    (2, second_boot, 2),
                )
                self.assertEqual(
                    database.execute("SELECT COUNT(*) FROM changes").fetchone()[0],
                    2,
                )

    def test_parallel_initialization_converges_on_one_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
                results = list(
                    executor.map(
                        lambda _: output_json(run_helper(root, "init")), range(16)
                    )
                )
            self.assertEqual(len({result["hostIdentity"] for result in results}), 1)
            self.assertEqual(len({result["sourceId"] for result in results}), 1)
            self.assertEqual(len({result["serviceId"] for result in results}), 1)

    def test_symlink_and_newer_schema_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "state-root"
            (root / "state").mkdir(parents=True)
            outside = base / "outside"
            outside.mkdir()
            (root / "state" / "voice-health").symlink_to(outside, target_is_directory=True)
            symlinked = run_helper(root, "init", check=False)
            self.assertNotEqual(symlinked.returncode, 0)
            self.assertIn("unsafe_path", symlinked.stderr)
            self.assertFalse((outside / "observations.sqlite").exists())

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            run_helper(root, "init")
            database_path = root / "state" / "voice-health" / "observations.sqlite"
            with sqlite3.connect(database_path) as database:
                database.execute("PRAGMA user_version = 2")
            newer = run_helper(root, "init", check=False)
            self.assertNotEqual(newer.returncode, 0)
            self.assertIn("schema_newer", newer.stderr)

    def test_payload_cannot_override_the_trusted_state_root(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            trusted = base / "trusted"
            injected = base / "injected"
            result = run_helper(
                trusted,
                "register-boot",
                {
                    "bootId": str(uuid.uuid4()),
                    "bootAt": "2026-09-18T03:30:00.000Z",
                    "stateRoot": str(injected),
                },
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid_input", result.stderr)
            self.assertFalse(injected.exists())

    def test_poll_threshold_recovery_and_refailure_create_distinct_episodes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))

            for sequence, second in enumerate((2, 7, 17), start=1):
                receipt = output_json(
                    self.record_result(
                        root,
                        boot["generation"],
                        sequence,
                        "poll_failed",
                        f"2026-09-18T03:30:{second:02d}.000Z",
                        reasonClass="bridge_timeout_headers",
                        operation="desired",
                        durationMs=2000,
                    )
                )
            self.assertEqual(receipt["failureStreak"], 3)
            self.assertEqual(receipt["episode"]["scope"], "poll_dependency")
            self.assertEqual(receipt["notification"]["state"], "pending")
            first_episode = receipt["episode"]["episodeId"]

            recovered = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    4,
                    "idle_success",
                    "2026-09-18T03:30:22.000Z",
                    durationMs=12,
                )
            )
            self.assertEqual(recovered["failureStreak"], 0)
            self.assertEqual(recovered["successCount"], 1)
            self.assertEqual(recovered["closedEpisodeId"], first_episode)

            exported = output_json(run_helper(root, "export", {"afterCursor": 0, "limit": 200}))
            cancelled = [
                item
                for item in exported["notifications"]
                if item["episodeId"] == first_episode
            ]
            self.assertEqual(cancelled[0]["state"], "cancelled_recovered")

            for sequence, second in enumerate((27, 37, 47), start=5):
                receipt = output_json(
                    self.record_result(
                        root,
                        boot["generation"],
                        sequence,
                        "poll_failed",
                        f"2026-09-18T03:30:{second:02d}.000Z",
                        reasonClass="bridge_connect_failed",
                        operation="desired",
                    )
                )
            self.assertNotEqual(receipt["episode"]["episodeId"], first_episode)
            self.assertEqual(receipt["notification"]["state"], "pending")

    def test_lease_renew_progress_does_not_reset_the_poll_failure_window(self):
        # FLY-2693 review R5 (progress-clears-unverified-failure-window): an
        # active session renews its lease every few seconds. That progress must
        # not zero failure_streak or re-anchor first_failure_at, otherwise poll
        # failures interleaved with renews can never reach either threshold.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))

            for sequence, second in enumerate((10, 20), start=1):
                receipt = output_json(
                    self.record_result(
                        root,
                        boot["generation"],
                        sequence,
                        "poll_failed",
                        f"2026-09-18T03:30:{second:02d}.000Z",
                        reasonClass="bridge_timeout_headers",
                        operation="desired",
                        durationMs=2000,
                    )
                )
            self.assertEqual(receipt["failureStreak"], 2)
            self.assertNotIn("episode", receipt)

            progress = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    3,
                    "progress",
                    "2026-09-18T03:30:25.000Z",
                    countDelta=1,
                )
            )
            self.assertEqual(progress["failureStreak"], 2)

            third = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    4,
                    "poll_failed",
                    "2026-09-18T03:30:30.000Z",
                    reasonClass="bridge_timeout_headers",
                    operation="desired",
                    durationMs=2000,
                )
            )
            self.assertEqual(third["failureStreak"], 3)
            self.assertEqual(third["episode"]["scope"], "poll_dependency")
            self.assertEqual(
                third["episode"]["threshold"], "three_consecutive_failures"
            )

            exported = output_json(run_helper(root, "export", {"afterCursor": 0, "limit": 200}))
            self.assertEqual(
                exported["currentProjection"]["firstFailureAt"],
                "2026-09-18T03:30:10.000Z",
            )

            # Only a real idle success clears the poll-scope failure window.
            recovered = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    5,
                    "idle_success",
                    "2026-09-18T03:30:35.000Z",
                    durationMs=12,
                )
            )
            self.assertEqual(recovered["failureStreak"], 0)
            self.assertEqual(recovered["closedEpisodeId"], third["episode"]["episodeId"])

    def test_fail_closed_demand_snapshot_marks_unknown_and_survives_results(self):
        # FLY-2693 review R5 (fail-closed-demand-never-reaches-helper): a
        # StateStore snapshot whose sourceStatus is not "available" must reach
        # the helper and publish unknown/unavailable instead of being dropped
        # in the Bridge, and a later daemon result must not erase that marker.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))

            degraded = output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": DEMAND_SOURCE_ID,
                        "revision": 1,
                        "digest": demand_digest([]),
                        "state": "unknown",
                        "observedAt": "2026-09-18T03:30:05.000Z",
                        "identities": [],
                        "sourceStatus": "trigger_invalid",
                    },
                )
            )
            self.assertEqual(degraded["status"], "recorded")
            self.assertEqual(degraded["sourceStatus"], "unavailable")
            self.assertEqual(degraded["failClosedSourceStatus"], "trigger_invalid")
            exported = output_json(run_helper(root, "export", {"afterCursor": 0, "limit": 200}))
            projection = exported["currentProjection"]
            self.assertEqual(projection["demandState"], "unknown")
            self.assertEqual(projection["sourceStatus"], "unavailable")
            self.assertEqual(projection["reasonClass"], "demand_source_unavailable")
            self.assertEqual(projection["demandEventCursor"], 0)

            # A daemon idle success is real, but it must not flip the demand
            # source back to available on its own.
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "idle_success",
                    "2026-09-18T03:30:10.000Z",
                    durationMs=9,
                )
            )
            exported = output_json(run_helper(root, "export", {"afterCursor": 0, "limit": 200}))
            self.assertEqual(exported["currentProjection"]["demandState"], "unknown")
            self.assertEqual(exported["currentProjection"]["sourceStatus"], "unavailable")

            # Only an authoritative available snapshot restores demand.
            restored = output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": DEMAND_SOURCE_ID,
                        "revision": 1,
                        "digest": demand_digest([{"demandId": "meeting-1"}]),
                        "state": "required",
                        "observedAt": "2026-09-18T03:30:15.000Z",
                        "identities": [{"demandId": "meeting-1"}],
                        "sourceStatus": "available",
                    },
                )
            )
            self.assertIn(restored["status"], {"recorded", "duplicate"})
            exported = output_json(run_helper(root, "export", {"afterCursor": 0, "limit": 200}))
            self.assertEqual(exported["currentProjection"]["demandState"], "required")
            self.assertEqual(exported["currentProjection"]["sourceStatus"], "available")

    def test_elapsed_failure_threshold_opens_one_episode_and_reason_drift_does_not_realert(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "poll_failed",
                    "2026-09-18T03:30:02.000Z",
                    reasonClass="bridge_connect_failed",
                    operation="desired",
                )
            )
            opened = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    2,
                    "poll_failed",
                    "2026-09-18T03:31:02.000Z",
                    reasonClass="bridge_timeout_body",
                    operation="desired",
                )
            )
            repeated = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    3,
                    "poll_failed",
                    "2026-09-18T03:31:10.000Z",
                    reasonClass="bridge_protocol_invalid",
                    operation="desired",
                )
            )
            self.assertEqual(opened["episode"]["threshold"], "first_failure_60s")
            self.assertEqual(
                repeated["episode"]["episodeId"], opened["episode"]["episodeId"]
            )
            reboot = self.register_boot(root)
            after_reboot = output_json(
                self.record_result(
                    root,
                    reboot["generation"],
                    1,
                    "poll_failed",
                    "2026-09-18T03:31:20.000Z",
                    reasonClass="bridge_auth_rejected",
                    operation="desired",
                )
            )
            self.assertEqual(
                after_reboot["episode"]["episodeId"], opened["episode"]["episodeId"]
            )
            self.assertEqual(after_reboot["failureStreak"], 4)
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(len(exported["notifications"]), 1)

    def test_demand_revision_idempotency_mismatch_and_older_revision_rejection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            self.register_boot(root)
            first = output_json(self.record_demand(root, 8))
            replay = output_json(self.record_demand(root, 8))
            self.assertEqual(first["status"], "recorded")
            self.assertEqual(replay["status"], "existing")
            self.assertEqual(first["observationSeq"], replay["observationSeq"])

            mismatch = run_helper(
                root,
                "record-demand",
                {
                    "demandSourceId": DEMAND_SOURCE_ID,
                    "revision": 8,
                    "digest": demand_digest([{"demandId": "meeting-2"}]),
                    "state": "required",
                    "observedAt": "2026-09-18T03:30:02.000Z",
                    "identities": [{"demandId": "meeting-2"}],
                },
                check=False,
            )
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertIn("demand_source_mismatch", mismatch.stderr)

            older = run_helper(
                root,
                "record-demand",
                {
                    "demandSourceId": DEMAND_SOURCE_ID,
                    "revision": 7,
                    "digest": demand_digest([]),
                    "state": "none",
                    "observedAt": "2026-09-18T03:30:03.000Z",
                    "identities": [],
                },
            )
            self.assertEqual(output_json(older)["status"], "stale")
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(exported["currentProjection"]["demandState"], "unknown")

    def test_paged_same_revision_digest_mismatch_rejects_refresh_and_replay(self):
        for replay_events in (False, True):
            with self.subTest(replay_events=replay_events), tempfile.TemporaryDirectory() as temp:
                root = Path(temp) / "state-root"
                events = [{
                    "eventSeq": 1, "eventKind": "normal_completed",
                    "demandId": "meeting-1", "attemptId": "attempt-1",
                    "observedAt": "2026-09-18T03:30:00.000Z",
                }] if replay_events else []
                payload = {
                    "demandSourceId": DEMAND_SOURCE_ID,
                    "revision": len(events), "digest": demand_digest([]),
                    "state": "none", "observedAt": "2026-09-18T03:30:01.000Z",
                    "identities": [], "refreshObservedAt": True,
                    "pageAfterCursor": 0, "pageNextCursor": len(events),
                    "eventHighWater": len(events), "hasMore": False,
                    "gap": False, "events": events,
                }
                output_json(run_helper(root, "record-demand", payload))
                identical = output_json(run_helper(root, "record-demand", payload))
                self.assertEqual(identical["status"], "stale" if replay_events else "refreshed")
                before = output_json(run_helper(root, "export", {"afterCursor": 0}))
                identity = {"demandId": "meeting-2", "attemptId": "attempt-2", "projectId": "flywheel"}
                rejected = run_helper(root, "record-demand", {
                    **payload, "state": "required", "identities": [identity],
                    "digest": demand_digest([identity]),
                    "observedAt": "2026-09-18T03:30:02.000Z",
                }, check=False)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("demand_source_mismatch", rejected.stderr)
                self.assertEqual(rejected.stdout, "")
                after = output_json(run_helper(root, "export", {"afterCursor": 0}))
                self.assertEqual(after["eventHighWater"], before["eventHighWater"] + 1)
                self.assertEqual(after["currentProjection"]["demandState"], "unknown")
                self.assertEqual(after["currentProjection"]["sourceStatus"], "unavailable")
                self.assertEqual(after["currentProjection"]["reasonClass"], "demand_source_unavailable")
                self.assertEqual(after["currentProjection"]["demandDigest"], demand_digest([]))
                self.assertEqual(after["currentProjection"]["demandEventCursor"], len(events))
                output_json(run_helper(root, "record-demand", payload))
                recovered = output_json(run_helper(root, "export", {"afterCursor": 0}))
                self.assertEqual(recovered["currentProjection"]["demandState"], "none")
                self.assertEqual(recovered["currentProjection"]["sourceStatus"], "available")
                self.assertIsNone(recovered["currentProjection"]["reasonClass"])

    def test_demand_can_be_recorded_without_a_daemon_and_survives_first_boot(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            demand = output_json(self.record_demand(root, 1))
            self.assertEqual(demand["status"], "recorded")
            before_boot = output_json(
                run_helper(root, "export", {"afterCursor": 0, "limit": 200})
            )
            self.assertEqual(before_boot["currentProjection"]["generation"], 0)
            self.assertEqual(before_boot["currentProjection"]["phase"], "dormant")
            self.assertEqual(before_boot["currentProjection"]["demandState"], "required")

            boot = self.register_boot(root)
            after_boot = output_json(
                run_helper(root, "export", {"afterCursor": 0, "limit": 200})
            )
            self.assertEqual(boot["generation"], 1)
            self.assertEqual(after_boot["currentProjection"]["demandRevision"], 1)
            self.assertEqual(after_boot["currentProjection"]["demandState"], "required")

    def test_demand_source_rotation_requires_unknown_baseline_and_preserves_episode(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            for sequence in range(1, 4):
                opened = output_json(
                    self.record_result(
                        root,
                        boot["generation"],
                        sequence,
                        "poll_failed",
                        f"2026-09-18T03:30:0{sequence}.000Z",
                        reasonClass="bridge_connect_failed",
                        operation="desired",
                    )
                )
            episode_id = opened["episode"]["episodeId"]
            rotated_source = "22222222-2222-4222-8222-222222222222"
            unsafe_rotation = run_helper(
                root,
                "record-demand",
                {
                    "demandSourceId": rotated_source,
                    "revision": 1,
                    "digest": demand_digest([{"demandId": "meeting-1"}]),
                    "state": "required",
                    "observedAt": "2026-09-18T03:30:10.000Z",
                    "identities": [{"demandId": "meeting-1"}],
                },
                check=False,
            )
            self.assertNotEqual(unsafe_rotation.returncode, 0)
            self.assertIn("demand_source_mismatch", unsafe_rotation.stderr)

            baseline = output_json(
                self.record_demand(
                    root,
                    0,
                    state="unknown",
                    identities=[],
                    source_id=rotated_source,
                )
            )
            self.assertEqual(baseline["status"], "recorded")
            during_rebase = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(during_rebase["openEpisodes"][0]["episodeId"], episode_id)
            advanced = output_json(
                self.record_demand(root, 1, source_id=rotated_source)
            )
            self.assertEqual(advanced["demandState"], "required")

    def test_stale_generation_and_duplicate_events_are_noops_but_payload_drift_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            first_boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            event = dict(
                reasonClass="bridge_connect_failed",
                operation="desired",
            )
            accepted = output_json(
                self.record_result(
                    root,
                    first_boot["generation"],
                    1,
                    "poll_failed",
                    "2026-09-18T03:30:02.000Z",
                    **event,
                )
            )
            replay = output_json(
                self.record_result(
                    root,
                    first_boot["generation"],
                    1,
                    "poll_failed",
                    "2026-09-18T03:30:02.000Z",
                    **event,
                )
            )
            self.assertEqual(replay["status"], "duplicate")
            self.assertEqual(replay["observationSeq"], accepted["observationSeq"])

            drift = run_helper(
                root,
                "record-result",
                {
                    "generation": first_boot["generation"],
                    "producerEventSeq": 1,
                    "resultKind": "poll_failed",
                    "observedAt": "2026-09-18T03:30:02.000Z",
                    "reasonClass": "bridge_timeout_headers",
                    "operation": "desired",
                },
                check=False,
            )
            self.assertNotEqual(drift.returncode, 0)
            self.assertIn("producer_event_mismatch", drift.stderr)

            second_boot = self.register_boot(root)
            self.assertEqual(second_boot["generation"], 2)
            self.assertEqual(second_boot["observationSeq"], accepted["observationSeq"] + 1)
            stale = output_json(
                self.record_result(
                    root,
                    first_boot["generation"],
                    2,
                    "idle_success",
                    "2026-09-18T03:30:03.000Z",
                )
            )
            self.assertEqual(stale["status"], "stale")

    def test_session_episode_is_scope_isolated_from_idle_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(
                self.record_demand(
                    root,
                    1,
                    identities=[{"demandId": "meeting-1", "attemptId": "attempt-2"}],
                )
            )
            failed = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "session_failed",
                    "2026-09-18T03:30:02.000Z",
                    reasonClass="session_create_failed",
                    operation="session_create",
                    demandId="meeting-1",
                    attemptId="attempt-1",
                )
            )
            idle = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    2,
                    "idle_success",
                    "2026-09-18T03:30:03.000Z",
                )
            )
            self.assertEqual(failed["episode"]["scope"], "session_unavailable")
            self.assertIsNone(idle.get("closedEpisodeId"))
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(
                [episode["episodeId"] for episode in exported["openEpisodes"]],
                [failed["episode"]["episodeId"]],
            )

            recovered = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    3,
                    "session_recovered",
                    "2026-09-18T03:30:04.000Z",
                    demandId="meeting-1",
                    successorAttemptId="attempt-2",
                    liveAt="2026-09-18T03:30:02.500Z",
                    renewAt="2026-09-18T03:30:03.500Z",
                )
            )
            self.assertEqual(recovered["closedEpisodeId"], failed["episode"]["episodeId"])
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(exported["openEpisodes"], [])
            self.assertEqual(
                exported["currentProjection"]["lastIterationSuccessAt"],
                "2026-09-18T03:30:03.000Z",
            )

    def test_none_and_unknown_demand_keep_failures_diagnostic_only(self):
        for state in ("none", "unknown"):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as temp:
                root = Path(temp) / "state-root"
                boot = self.register_boot(root)
                identities = [] if state == "none" else []
                output_json(self.record_demand(root, 1, state=state, identities=identities))
                for sequence in range(1, 4):
                    result = output_json(
                        self.record_result(
                            root,
                            boot["generation"],
                            sequence,
                            "poll_failed",
                            f"2026-09-18T03:30:0{sequence}.000Z",
                            reasonClass="bridge_connect_failed",
                            operation="desired",
                        )
                    )
                self.assertEqual(result["failureStreak"], 3)
                self.assertNotIn("episode", result)
                exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
                self.assertEqual(exported["openEpisodes"], [])
                self.assertEqual(exported["notifications"], [])

    def test_notification_claim_is_single_owner_and_sent_requires_real_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            for sequence in range(1, 4):
                opened = output_json(
                    self.record_result(
                        root,
                        boot["generation"],
                        sequence,
                        "poll_failed",
                        f"2026-09-18T03:30:0{sequence}.000Z",
                        reasonClass="bridge_connect_failed",
                        operation="desired",
                    )
                )
            intent_id = opened["notification"]["intentId"]
            first_token = str(uuid.uuid4())
            claimed = output_json(
                run_helper(
                    root,
                    "claim-notification",
                    {
                        "intentId": intent_id,
                        "claimToken": first_token,
                        "claimedAt": "2026-09-18T03:30:04.000Z",
                        "expiresAt": "2026-09-18T03:31:04.000Z",
                        "bindingDigest": BINDING_DIGEST,
                        "channelId": "123456789012345678",
                    },
                )
            )
            self.assertEqual(claimed["status"], "claimed")
            busy = output_json(
                run_helper(
                    root,
                    "claim-notification",
                    {
                        "intentId": intent_id,
                        "claimToken": str(uuid.uuid4()),
                        "claimedAt": "2026-09-18T03:30:05.000Z",
                        "expiresAt": "2026-09-18T03:31:05.000Z",
                        "bindingDigest": BINDING_DIGEST,
                        "channelId": "123456789012345678",
                    },
                )
            )
            self.assertEqual(busy["status"], "claimed_elsewhere")

            wrong_binding = run_helper(
                root,
                "record-delivery",
                {
                    "intentId": intent_id,
                    "claimToken": first_token,
                    "bindingDigest": "c" * 64,
                    "state": "sent",
                    "channelId": "123456789012345678",
                    "messageId": "223456789012345678",
                },
                check=False,
            )
            self.assertNotEqual(wrong_binding.returncode, 0)
            self.assertIn("notification_binding_mismatch", wrong_binding.stderr)

            missing_receipt = run_helper(
                root,
                "record-delivery",
                {
                    "intentId": intent_id,
                    "claimToken": first_token,
                    "bindingDigest": BINDING_DIGEST,
                    "state": "sent",
                },
                check=False,
            )
            self.assertNotEqual(missing_receipt.returncode, 0)
            self.assertIn("invalid_delivery_receipt", missing_receipt.stderr)
            sent = output_json(
                run_helper(
                    root,
                    "record-delivery",
                    {
                        "intentId": intent_id,
                        "claimToken": first_token,
                        "bindingDigest": BINDING_DIGEST,
                        "state": "sent",
                        "channelId": "123456789012345678",
                        "messageId": "223456789012345678",
                    },
                )
            )
            self.assertEqual(sent["state"], "sent")

    def test_expired_claim_becomes_delivery_unknown_and_dead_letter_is_terminal(self):
        for delivery_state in ("delivery_unknown", "dead_lettered"):
            with self.subTest(delivery_state=delivery_state), tempfile.TemporaryDirectory() as temp:
                root = Path(temp) / "state-root"
                boot = self.register_boot(root)
                output_json(self.record_demand(root, 1))
                for sequence in range(1, 4):
                    opened = output_json(
                        self.record_result(
                            root,
                            boot["generation"],
                            sequence,
                            "poll_failed",
                            f"2026-09-18T03:30:0{sequence}.000Z",
                            reasonClass="bridge_connect_failed",
                            operation="desired",
                        )
                    )
                intent_id = opened["notification"]["intentId"]
                first_token = str(uuid.uuid4())
                output_json(
                    run_helper(
                        root,
                        "claim-notification",
                        {
                            "intentId": intent_id,
                            "claimToken": first_token,
                            "claimedAt": "2026-09-18T03:30:04.000Z",
                            "expiresAt": "2026-09-18T03:30:05.000Z",
                            "bindingDigest": BINDING_DIGEST,
                            "channelId": "123456789012345678",
                        },
                    )
                )
                if delivery_state == "dead_lettered":
                    recorded = output_json(
                        run_helper(
                            root,
                            "record-delivery",
                            {
                                "intentId": intent_id,
                                "claimToken": first_token,
                                "bindingDigest": BINDING_DIGEST,
                                "state": "dead_lettered",
                            },
                        )
                    )
                    self.assertEqual(recorded["state"], "dead_lettered")
                    attempted = output_json(
                        run_helper(
                            root,
                            "claim-notification",
                            {
                                "intentId": intent_id,
                                "claimToken": first_token,
                                "claimedAt": "2026-09-18T03:30:06.000Z",
                                "expiresAt": "2026-09-18T03:30:07.000Z",
                                "bindingDigest": BINDING_DIGEST,
                                "channelId": "123456789012345678",
                            },
                        )
                    )
                    self.assertEqual(attempted["status"], "not_claimable")
                else:
                    attempted = output_json(
                        run_helper(
                            root,
                            "claim-notification",
                            {
                                "intentId": intent_id,
                                "claimToken": first_token,
                                "claimedAt": "2026-09-18T03:30:06.000Z",
                                "expiresAt": "2026-09-18T03:30:07.000Z",
                                "bindingDigest": BINDING_DIGEST,
                                "channelId": "123456789012345678",
                            },
                        )
                    )
                    self.assertEqual(attempted["status"], "delivery_unknown")

    def test_failure_progress_closure_and_cursor_guards_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "poll_failed",
                    "2026-09-18T03:30:02.000Z",
                    reasonClass="bridge_connect_failed",
                    operation="desired",
                )
            )
            failed = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertIsNone(failed["currentProjection"]["lastProgressAt"])

            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    2,
                    "idle_success",
                    "2026-09-18T03:30:03.000Z",
                )
            )
            healthy = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertIsNone(healthy["currentProjection"]["reasonClass"])
            self.assertIsNone(healthy["currentProjection"]["operation"])

            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    3,
                    "session_failed",
                    "2026-09-18T03:30:04.000Z",
                    reasonClass="session_create_failed",
                    operation="session_create",
                    demandId="meeting-1",
                    attemptId="attempt-1",
                )
            )
            premature_close = run_helper(
                root,
                "record-result",
                {
                    "generation": boot["generation"],
                    "producerEventSeq": 4,
                    "resultKind": "closed_not_required",
                    "observedAt": "2026-09-18T03:30:05.000Z",
                    "demandId": "meeting-1",
                },
                check=False,
            )
            self.assertNotEqual(premature_close.returncode, 0)
            self.assertIn("demand_close_fact_missing", premature_close.stderr)

            closed = output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": DEMAND_SOURCE_ID,
                        "revision": 2,
                        "digest": demand_digest([]),
                        "state": "none",
                        "observedAt": "2026-09-18T03:30:06.000Z",
                        "identities": [],
                        "pageAfterCursor": 0,
                        "pageNextCursor": 1,
                        "eventHighWater": 1,
                        "hasMore": False,
                        "gap": False,
                        "events": [
                            {
                                "eventSeq": 1,
                                "eventKind": "cancelled",
                                "demandId": "meeting-1",
                                "attemptId": "attempt-1",
                                "observedAt": "2026-09-18T03:30:06.000Z",
                            }
                        ],
                    },
                )
            )
            self.assertIn("closedEpisodeId", closed)
            progress = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    4,
                    "progress",
                    "2026-09-18T03:30:07.000Z",
                )
            )
            self.assertEqual(progress["checkpoint"], {"skipped": True})
            stopped = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    5,
                    "daemon_stopped",
                    "2026-09-18T03:30:08.000Z",
                )
            )
            self.assertEqual(stopped["status"], "recorded")
            stopped_export = output_json(
                run_helper(root, "export", {"afterCursor": 0})
            )
            self.assertEqual(stopped_export["currentProjection"]["phase"], "stopped")

            final_page = output_json(run_helper(root, "export", {"afterCursor": 0}))
            ahead = run_helper(
                root,
                "export",
                {"afterCursor": final_page["eventHighWater"] + 1},
                check=False,
            )
            self.assertNotEqual(ahead.returncode, 0)
            self.assertIn("cursor_mismatch", ahead.stderr)

    def test_demand_digest_shape_and_cardinality_are_validated(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            self.register_boot(root)
            bad_digest = run_helper(
                root,
                "record-demand",
                {
                    "demandSourceId": DEMAND_SOURCE_ID,
                    "revision": 1,
                    "digest": "z" * 64,
                    "state": "required",
                    "observedAt": "2026-09-18T03:30:01.000Z",
                    "identities": [{"demandId": "meeting-1"}],
                },
                check=False,
            )
            self.assertNotEqual(bad_digest.returncode, 0)
            self.assertIn("invalid_input", bad_digest.stderr)
            invalid_none = run_helper(
                root,
                "record-demand",
                {
                    "demandSourceId": DEMAND_SOURCE_ID,
                    "revision": 1,
                    "digest": demand_digest([{"demandId": "meeting-1"}]),
                    "state": "none",
                    "observedAt": "2026-09-18T03:30:01.000Z",
                    "identities": [{"demandId": "meeting-1"}],
                },
                check=False,
            )
            self.assertNotEqual(invalid_none.returncode, 0)
            self.assertIn("invalid_input", invalid_none.stderr)

    def test_v1_foundation_database_migrates_without_identity_or_counter_loss(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            initialized = output_json(run_helper(root, "init"))
            boot = self.register_boot(root)
            database_path = root / "state" / "voice-health" / "observations.sqlite"
            with sqlite3.connect(database_path) as database:
                database.execute(
                    "UPDATE health SET success_count = 5, failure_count = 7, "
                    "failure_streak = 3 WHERE service_id = ?",
                    (initialized["serviceId"],),
                )
                for column in (
                    "demand_source_id",
                    "demand_digest",
                    "demand_observed_at",
                    "demand_identities_json",
                    "demand_event_cursor",
                    "demand_event_high_water",
                    "demand_has_more",
                    "progress_count",
                ):
                    database.execute(f"ALTER TABLE health DROP COLUMN {column}")
                for column in ("demand_source_id", "source_status"):
                    database.execute(f"ALTER TABLE episodes DROP COLUMN {column}")
                for table in (
                    "notification_attempts",
                    "session_recovery_proofs",
                    "startup_events",
                    "demand_attempts",
                    "demand_transition_events",
                ):
                    database.execute(f"DROP TABLE {table}")
                database.execute("DROP TABLE notification_intents")
                database.execute(
                    "CREATE TABLE notification_intents ("
                    "intent_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, "
                    "episode_id TEXT NOT NULL, frozen_payload TEXT NOT NULL, "
                    "route_key TEXT NOT NULL, binding_digest TEXT NOT NULL, "
                    "state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, "
                    "claim_token TEXT, channel_id TEXT, message_id TEXT, "
                    "FOREIGN KEY (service_id) REFERENCES health(service_id), "
                    "FOREIGN KEY (episode_id) REFERENCES episodes(episode_id))"
                )

            migrated = output_json(run_helper(root, "init"))
            self.assertEqual(migrated["sourceId"], initialized["sourceId"])
            self.assertEqual(migrated["hostIdentity"], initialized["hostIdentity"])
            with sqlite3.connect(database_path) as database:
                health = database.execute(
                    "SELECT generation, observation_seq, success_count, failure_count, "
                    "failure_streak FROM health"
                ).fetchone()
                health_columns = {
                    row[1] for row in database.execute("PRAGMA table_info(health)")
                }
                notification_info = list(
                    database.execute("PRAGMA table_info(notification_intents)")
                )
                episode_columns = {
                    row[1] for row in database.execute("PRAGMA table_info(episodes)")
                }
                proof_columns = {
                    row[1]
                    for row in database.execute(
                        "PRAGMA table_info(session_recovery_proofs)"
                    )
                }
                tables = {
                    row[0]
                    for row in database.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
            self.assertEqual(health, (boot["generation"], boot["observationSeq"], 5, 7, 3))
            self.assertTrue(
                {
                    "demand_source_id",
                    "demand_digest",
                    "demand_observed_at",
                    "demand_identities_json",
                    "demand_event_cursor",
                    "demand_event_high_water",
                    "demand_has_more",
                    "progress_count",
                }.issubset(health_columns)
            )
            self.assertTrue(
                {
                    "demand_transition_events",
                    "demand_attempts",
                    "startup_events",
                    "session_recovery_proofs",
                    "notification_attempts",
                }.issubset(tables)
            )
            self.assertEqual(
                next(row[3] for row in notification_info if row[1] == "binding_digest"),
                0,
            )
            self.assertTrue(
                {"demand_source_id", "source_status"}.issubset(episode_columns)
            )
            self.assertIn("demand_source_id", proof_columns)

    def test_export_paginates_by_global_cursor_and_final_page_has_projection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            for sequence in range(1, 5):
                output_json(
                    self.record_result(
                        root,
                        boot["generation"],
                        sequence,
                        "idle_success",
                        f"2026-09-18T03:30:0{sequence}.000Z",
                    )
                )
            cursor = 0
            delivered = []
            source_id = None
            final = None
            while True:
                page = output_json(
                    run_helper(
                        root,
                        "export",
                        {
                            "afterCursor": cursor,
                            "limit": 2,
                            **({"sourceId": source_id} if source_id else {}),
                        },
                    )
                )
                source_id = page["sourceId"]
                delivered.extend(page["changes"])
                cursor = page["nextCursor"]
                if not page["hasMore"]:
                    final = page
                    break
                self.assertNotIn("currentProjection", page)
            self.assertEqual(
                [change["changeSeq"] for change in delivered],
                list(range(1, len(delivered) + 1)),
            )
            self.assertEqual(final["currentProjection"]["observationSeq"], delivered[-1]["observationSeq"])
            self.assertEqual(final["nextCursor"], delivered[-1]["changeSeq"])

    def test_committed_success_and_change_survive_explicit_wal_checkpoint(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            success = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "idle_success",
                    "2026-09-18T03:30:02.000Z",
                )
            )
            database_path = root / "state" / "voice-health" / "observations.sqlite"
            with sqlite3.connect(database_path) as database:
                checkpoint = database.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
                health = database.execute(
                    "SELECT last_iteration_success_at, observation_seq FROM health"
                ).fetchone()
                change_count = database.execute("SELECT COUNT(*) FROM changes").fetchone()[0]
            self.assertEqual(checkpoint[0], 0)
            self.assertEqual(health, ("2026-09-18T03:30:02.000Z", success["observationSeq"]))
            self.assertEqual(change_count, 2)

    def test_concurrent_result_writers_preserve_every_event_and_global_sequence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))

            def write(sequence):
                return output_json(
                    self.record_result(
                        root,
                        boot["generation"],
                        sequence,
                        "poll_failed",
                        f"2026-09-18T03:30:{sequence + 1:02d}.000Z",
                        reasonClass="bridge_connect_failed",
                        operation="desired",
                    )
                )

            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
                results = list(executor.map(write, range(1, 9)))
            self.assertTrue(all(result["status"] == "recorded" for result in results))
            database_path = root / "state" / "voice-health" / "observations.sqlite"
            with sqlite3.connect(database_path) as database:
                self.assertEqual(database.execute("SELECT COUNT(*) FROM producer_events").fetchone()[0], 8)
                observation_sequences = [
                    row[0]
                    for row in database.execute(
                        "SELECT observation_seq FROM producer_events ORDER BY observation_seq"
                    )
                ]
            self.assertEqual(observation_sequences, list(range(3, 11)))

    def test_demand_event_pages_latch_failed_attempt_and_cancel_only_matching_attempt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            identities = []
            first_page_payload = {
                "demandSourceId": DEMAND_SOURCE_ID,
                "revision": 7,
                "digest": demand_digest(identities),
                "state": "unknown",
                "observedAt": "2026-09-18T03:30:02.000Z",
                "identities": identities,
                "pageAfterCursor": 0,
                "pageNextCursor": 2,
                "eventHighWater": 3,
                "hasMore": True,
                "gap": False,
                "events": [
                    {
                        "eventSeq": 1,
                        "eventKind": "required",
                        "demandId": "meeting-1",
                        "attemptId": "attempt-1",
                        "observedAt": "2026-09-18T03:30:00.000Z",
                    },
                    {
                        "eventSeq": 2,
                        "eventKind": "failed",
                        "demandId": "meeting-1",
                        "attemptId": "attempt-1",
                        "observedAt": "2026-09-18T03:30:01.000Z",
                        "reasonClass": "session_create_failed",
                    },
                ],
            }
            first_page = output_json(
                run_helper(root, "record-demand", first_page_payload)
            )
            self.assertEqual(first_page["demandEventCursor"], 2)
            self.assertEqual(first_page["episode"]["scope"], "session_unavailable")
            episode_id = first_page["episode"]["episodeId"]
            midway = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(midway["currentProjection"]["demandState"], "unknown")
            self.assertEqual(midway["unresolvedDemandAttempts"][0]["state"], "failed")
            replay = output_json(
                run_helper(root, "record-demand", first_page_payload)
            )
            self.assertEqual(replay["status"], "stale")
            drifted_page = {
                **first_page_payload,
                "events": [
                    first_page_payload["events"][0],
                    {
                        **first_page_payload["events"][1],
                        "observedAt": "2026-09-18T03:30:01.001Z",
                    },
                ],
            }
            drifted = run_helper(
                root, "record-demand", drifted_page, check=False
            )
            self.assertNotEqual(drifted.returncode, 0)
            self.assertIn("demand_event_mismatch", drifted.stderr)

            discontinuity = run_helper(
                root,
                "record-demand",
                {
                    "demandSourceId": DEMAND_SOURCE_ID,
                    "revision": 7,
                    "digest": demand_digest([]),
                    "state": "none",
                    "observedAt": "2026-09-18T03:30:03.000Z",
                    "identities": [],
                    "pageAfterCursor": 2,
                    "pageNextCursor": 3,
                    "eventHighWater": 3,
                    "hasMore": False,
                    "gap": True,
                    "events": [
                        {
                            "eventSeq": 3,
                            "eventKind": "cancelled",
                            "demandId": "meeting-1",
                            "attemptId": "attempt-1",
                            "observedAt": "2026-09-18T03:30:03.000Z",
                        }
                    ],
                },
                check=False,
            )
            self.assertNotEqual(discontinuity.returncode, 0)
            self.assertIn("demand_change_gap", discontinuity.stderr)

            final_page = output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": DEMAND_SOURCE_ID,
                        "revision": 7,
                        "digest": demand_digest([]),
                        "state": "none",
                        "observedAt": "2026-09-18T03:30:03.000Z",
                        "identities": [],
                        "pageAfterCursor": 2,
                        "pageNextCursor": 3,
                        "eventHighWater": 3,
                        "hasMore": False,
                        "gap": False,
                        "events": [
                            {
                                "eventSeq": 3,
                                "eventKind": "cancelled",
                                "demandId": "meeting-1",
                                "attemptId": "attempt-1",
                                "observedAt": "2026-09-18T03:30:03.000Z",
                            }
                        ],
                    },
                )
            )
            self.assertEqual(final_page["demandEventCursor"], 3)
            final = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(final["openEpisodes"], [])
            self.assertEqual(final["unresolvedDemandAttempts"], [])
            with sqlite3.connect(root / "state" / "voice-health" / "observations.sqlite") as database:
                closed = database.execute(
                    "SELECT close_reason FROM episodes WHERE episode_id = ?", (episode_id,)
                ).fetchone()
                producer_count = database.execute("SELECT COUNT(*) FROM producer_events").fetchone()[0]
            self.assertEqual(closed[0], "closed_not_required")
            self.assertEqual(producer_count, 0)
            self.assertEqual(boot["generation"], 1)

    def test_daemon_terminal_results_reconcile_later_demand_events(self):
        identity = {
            "demandId": "meeting-1",
            "attemptId": "attempt-1",
            "projectId": "flywheel",
        }
        required_page = {
            "demandSourceId": DEMAND_SOURCE_ID,
            "revision": 1,
            "digest": demand_digest([identity]),
            "state": "required",
            "observedAt": "2026-09-18T03:30:01.000Z",
            "identities": [identity],
            "pageAfterCursor": 0,
            "pageNextCursor": 1,
            "eventHighWater": 1,
            "hasMore": False,
            "gap": False,
            "events": [
                {
                    "eventSeq": 1,
                    "eventKind": "required",
                    "demandId": "meeting-1",
                    "attemptId": "attempt-1",
                    "observedAt": "2026-09-18T03:30:00.000Z",
                }
            ],
        }
        cases = [
            (
                "session_failed",
                {
                    "reasonClass": "session_runtime_failed",
                    "operation": "session_runtime",
                    "demandId": "meeting-1",
                    "attemptId": "attempt-1",
                },
                "failed",
            ),
            (
                "session_ended",
                {
                    "demandId": "meeting-1",
                    "successorAttemptId": "attempt-1",
                    "liveAt": "2026-09-18T03:30:02.000Z",
                    "renewAt": "2026-09-18T03:30:03.000Z",
                },
                "normal_completed",
            ),
        ]
        for result_kind, result_fields, terminal_kind in cases:
            with self.subTest(result_kind=result_kind):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp) / result_kind
                    boot = self.register_boot(root)
                    if result_kind == "session_failed":
                        output_json(self.record_demand(root, 0, identities=[identity]))
                    else:
                        output_json(run_helper(root, "record-demand", required_page))
                    output_json(
                        self.record_result(
                            root,
                            boot["generation"],
                            1,
                            result_kind,
                            "2026-09-18T03:30:04.000Z",
                            **result_fields,
                        )
                    )
                    if result_kind == "session_failed":
                        output_json(run_helper(root, "record-demand", required_page))
                    before = output_json(
                        run_helper(root, "export", {"afterCursor": 0})
                    )
                    terminal_payload = {
                        **required_page,
                        "revision": 2,
                        "digest": demand_digest([]),
                        "state": "none",
                        "observedAt": "2026-09-18T03:30:05.000Z",
                        "identities": [],
                        "pageAfterCursor": 1,
                        "pageNextCursor": 2,
                        "eventHighWater": 2,
                        "events": [
                            {
                                "eventSeq": 2,
                                "eventKind": terminal_kind,
                                "demandId": "meeting-1",
                                "attemptId": "attempt-1",
                                "observedAt": "2026-09-18T03:30:03.000Z",
                                **(
                                    {"reasonClass": "session_runtime_failed"}
                                    if terminal_kind == "failed"
                                    else {}
                                ),
                            }
                        ],
                    }
                    reconciled = output_json(
                        run_helper(root, "record-demand", terminal_payload)
                    )
                    self.assertEqual(reconciled["demandEventCursor"], 2)
                    after = output_json(
                        run_helper(root, "export", {"afterCursor": 0})
                    )
                    self.assertEqual(
                        after["currentProjection"]["failureCount"],
                        before["currentProjection"]["failureCount"],
                    )
                    if result_kind == "session_failed":
                        with sqlite3.connect(root / "state" / "voice-health" / "observations.sqlite") as database:
                            terminal = database.execute(
                                "SELECT terminal_at FROM demand_attempts WHERE attempt_id = 'attempt-1'"
                            ).fetchone()
                        self.assertEqual(terminal[0], "2026-09-18T03:30:04.000Z")

    def test_startup_failure_does_not_wedge_later_required_and_terminal_events(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            self.register_boot(root)
            attempt_id = str(uuid.uuid4())
            identity = {
                "demandId": "meeting-1",
                "attemptId": attempt_id,
                "projectId": "flywheel",
            }
            output_json(self.record_demand(root, 1, identities=[identity]))
            opened = output_json(
                run_helper(
                    root,
                    "record-startup",
                    {
                        "startupAttemptId": attempt_id,
                        "demandId": "meeting-1",
                        "observedAt": "2026-09-18T03:31:00.000Z",
                        "reasonClass": "startup_not_ready",
                        "operation": "startup",
                    },
                )
            )
            episode_id = opened["episode"]["episodeId"]
            active = output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": DEMAND_SOURCE_ID,
                        "revision": 2,
                        "digest": demand_digest([identity]),
                        "state": "required",
                        "observedAt": "2026-09-18T03:31:02.000Z",
                        "identities": [identity],
                        "pageAfterCursor": 0,
                        "pageNextCursor": 2,
                        "eventHighWater": 2,
                        "hasMore": False,
                        "gap": False,
                        "events": [
                            {
                                "eventSeq": 1,
                                "eventKind": "required",
                                "demandId": "meeting-1",
                                "attemptId": attempt_id,
                                "observedAt": "2026-09-18T03:31:01.000Z",
                            },
                            {
                                "eventSeq": 2,
                                "eventKind": "required",
                                "demandId": "meeting-1",
                                "attemptId": attempt_id,
                                "observedAt": "2026-09-18T03:31:02.000Z",
                            },
                        ],
                    },
                )
            )
            self.assertEqual(active["demandEventCursor"], 2)
            ended = output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": DEMAND_SOURCE_ID,
                        "revision": 3,
                        "digest": demand_digest([]),
                        "state": "none",
                        "observedAt": "2026-09-18T03:32:00.000Z",
                        "identities": [],
                        "pageAfterCursor": 2,
                        "pageNextCursor": 3,
                        "eventHighWater": 3,
                        "hasMore": False,
                        "gap": False,
                        "events": [
                            {
                                "eventSeq": 3,
                                "eventKind": "normal_completed",
                                "demandId": "meeting-1",
                                "attemptId": attempt_id,
                                "observedAt": "2026-09-18T03:32:00.000Z",
                            }
                        ],
                    },
                )
            )
            self.assertEqual(ended["demandEventCursor"], 3)
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(exported["openEpisodes"], [])
            with sqlite3.connect(
                root / "state" / "voice-health" / "observations.sqlite"
            ) as database:
                closed = database.execute(
                    "SELECT close_reason FROM episodes WHERE episode_id = ?",
                    (episode_id,),
                ).fetchone()
            self.assertEqual(closed[0], "closed_not_required")

    def test_baseline_attempt_accepts_a_later_terminal_event(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            self.register_boot(root)
            identity = {
                "demandId": "meeting-1",
                "attemptId": "attempt-1",
                "projectId": "flywheel",
            }
            output_json(self.record_demand(root, 0, identities=[identity]))
            terminal = output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": DEMAND_SOURCE_ID,
                        "revision": 1,
                        "digest": demand_digest([]),
                        "state": "none",
                        "observedAt": "2026-09-18T03:30:05.000Z",
                        "identities": [],
                        "pageAfterCursor": 0,
                        "pageNextCursor": 1,
                        "eventHighWater": 1,
                        "hasMore": False,
                        "gap": False,
                        "events": [
                            {
                                "eventSeq": 1,
                                "eventKind": "normal_completed",
                                "demandId": "meeting-1",
                                "attemptId": "attempt-1",
                                "observedAt": "2026-09-18T03:30:05.000Z",
                            }
                        ],
                    },
                )
            )
            self.assertEqual(terminal["demandEventCursor"], 1)
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(exported["unresolvedDemandAttempts"], [])

    def test_restart_page_replays_stored_prefix_and_applies_new_suffix(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            self.register_boot(root)
            identity = {
                "demandId": "meeting-1",
                "attemptId": "attempt-1",
                "projectId": "flywheel",
            }
            first_event = {
                "eventSeq": 1,
                "eventKind": "required",
                "demandId": "meeting-1",
                "attemptId": "attempt-1",
                "observedAt": "2026-09-18T03:30:00.000Z",
            }
            first_page = {
                "demandSourceId": DEMAND_SOURCE_ID,
                "revision": 1,
                "digest": demand_digest([identity]),
                "state": "required",
                "observedAt": "2026-09-18T03:30:01.000Z",
                "identities": [identity],
                "pageAfterCursor": 0,
                "pageNextCursor": 1,
                "eventHighWater": 1,
                "hasMore": False,
                "gap": False,
                "events": [first_event],
            }
            output_json(run_helper(root, "record-demand", first_page))
            restarted_page = {
                **first_page,
                "revision": 2,
                "observedAt": "2026-09-18T03:30:02.000Z",
                "pageNextCursor": 2,
                "eventHighWater": 2,
                "events": [
                    first_event,
                    {
                        **first_event,
                        "eventSeq": 2,
                        "observedAt": "2026-09-18T03:30:02.000Z",
                    },
                ],
            }
            recorded = output_json(
                run_helper(root, "record-demand", restarted_page)
            )
            self.assertEqual(recorded["demandEventCursor"], 2)

    def test_accepts_an_authoritative_snapshot_from_a_new_demand_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            self.register_boot(root)
            output_json(self.record_demand(root, 1))
            source_b = "22222222-2222-4222-8222-222222222222"
            identity = {
                "demandId": "meeting-2",
                "attemptId": "attempt-2",
                "projectId": "flywheel",
            }
            rotated = output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": source_b,
                        "revision": 1,
                        "digest": demand_digest([identity]),
                        "state": "required",
                        "observedAt": "2026-09-18T03:31:00.000Z",
                        "identities": [identity],
                        "pageAfterCursor": 0,
                        "pageNextCursor": 1,
                        "eventHighWater": 1,
                        "hasMore": False,
                        "gap": False,
                        "events": [
                            {
                                "eventSeq": 1,
                                "eventKind": "required",
                                "demandId": "meeting-2",
                                "attemptId": "attempt-2",
                                "observedAt": "2026-09-18T03:30:59.000Z",
                            }
                        ],
                    },
                )
            )
            self.assertEqual(rotated["demandEventCursor"], 1)
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(exported["currentProjection"]["demandSourceId"], source_b)
            self.assertEqual(exported["currentProjection"]["demandState"], "required")

    def test_paginated_source_rotation_does_not_inherit_old_revision(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            output_json(self.record_demand(root, 1000))
            identity = {"demandId": "meeting-2", "attemptId": "attempt-2", "projectId": "flywheel"}
            event = {
                "eventSeq": 1, "eventKind": "required", "demandId": "meeting-2",
                "attemptId": "attempt-2", "observedAt": "2026-09-18T03:31:00.000Z",
            }
            payload = {
                "demandSourceId": "22222222-2222-4222-8222-222222222222",
                "revision": 2, "digest": demand_digest([]), "state": "unknown",
                "observedAt": "2026-09-18T03:31:00.000Z", "identities": [],
                "pageAfterCursor": 0, "pageNextCursor": 1, "eventHighWater": 2,
                "hasMore": True, "gap": False, "events": [event],
            }
            output_json(run_helper(root, "record-demand", payload))
            final = output_json(run_helper(root, "record-demand", {
                **payload, "digest": demand_digest([identity]), "state": "required",
                "identities": [identity], "pageAfterCursor": 1, "pageNextCursor": 2,
                "hasMore": False, "events": [{**event, "eventSeq": 2}],
            }))
            self.assertEqual(final["status"], "recorded")
            self.assertEqual(final["demandEventCursor"], 2)
            self.assertEqual(final["demandState"], "required")

    def test_required_progression_updates_the_same_nonterminal_attempt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            self.register_boot(root)
            identity = {
                "demandId": "meeting-1",
                "attemptId": "attempt-1",
                "projectId": "flywheel",
                "meetingId": "meeting-1",
            }
            result = output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": DEMAND_SOURCE_ID,
                        "revision": 2,
                        "digest": demand_digest([identity]),
                        "state": "required",
                        "observedAt": "2026-09-18T03:30:02.000Z",
                        "identities": [identity],
                        "pageAfterCursor": 0,
                        "pageNextCursor": 2,
                        "eventHighWater": 2,
                        "hasMore": False,
                        "gap": False,
                        "events": [
                            {
                                "eventSeq": 1,
                                "eventKind": "required",
                                "demandId": "meeting-1",
                                "attemptId": "attempt-1",
                                "observedAt": "2026-09-18T03:30:00.000Z",
                            },
                            {
                                "eventSeq": 2,
                                "eventKind": "required",
                                "demandId": "meeting-1",
                                "attemptId": "attempt-1",
                                "observedAt": "2026-09-18T03:30:01.000Z",
                            },
                        ],
                    },
                )
            )
            self.assertEqual(result["status"], "recorded")
            database_path = root / "state" / "voice-health" / "observations.sqlite"
            with sqlite3.connect(database_path) as database:
                attempts = database.execute(
                    "SELECT state, first_event_seq, last_event_seq "
                    "FROM demand_attempts"
                ).fetchall()
            self.assertEqual(attempts, [("required", 1, 2)])

    def test_same_revision_unknown_can_become_authoritative_and_refresh_observed_at(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            self.register_boot(root)
            identities = [{"demandId": "meeting-1"}]
            unknown = output_json(
                self.record_demand(
                    root,
                    9,
                    state="unknown",
                    identities=identities,
                )
            )
            required = output_json(
                self.record_demand(root, 9, state="required", identities=identities)
            )
            self.assertEqual(unknown["demandState"], "unknown")
            self.assertEqual(required["status"], "recorded")
            self.assertEqual(required["demandState"], "required")
            refreshed = output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": DEMAND_SOURCE_ID,
                        "revision": 9,
                        "digest": demand_digest(identities),
                        "state": "required",
                        "observedAt": "2026-09-18T03:31:00.000Z",
                        "identities": identities,
                        "refreshObservedAt": True,
                    },
                )
            )
            self.assertEqual(refreshed["status"], "refreshed")
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(
                exported["currentProjection"]["demandObservedAt"],
                "2026-09-18T03:31:00.000Z",
            )

    def test_legacy_startup_digest_migrates_only_for_the_same_event(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            payload = {
                "startupAttemptId": str(uuid.uuid4()),
                "demandId": "meeting-1",
                "observedAt": "2026-09-18T03:30:02.000Z",
                "reasonClass": "startup_config_invalid",
                "operation": "startup",
            }
            original = output_json(run_helper(root, "record-startup", payload))
            database_path = root / "state" / "voice-health" / "observations.sqlite"
            legacy_digest = demand_digest(payload)
            new_digest = demand_digest({key: value for key, value in payload.items() if key != "demandId"})
            with sqlite3.connect(database_path) as database:
                database.execute("UPDATE startup_events SET payload_digest = ?", (legacy_digest,))

            changed_event = run_helper(root, "record-startup", {
                **payload, "reasonClass": "startup_not_ready",
            }, check=False)
            self.assertNotEqual(changed_event.returncode, 0)
            self.assertIn("startup_event_mismatch", changed_event.stderr)

            replay = output_json(run_helper(root, "record-startup", payload))
            self.assertEqual(replay["status"], "duplicate")
            self.assertEqual(replay["observationSeq"], original["observationSeq"])
            with sqlite3.connect(database_path) as database:
                row = database.execute("SELECT payload_digest, demand_id FROM startup_events").fetchone()
            self.assertEqual(row, (new_digest, "meeting-1"))

            rebound = output_json(run_helper(root, "record-startup", {
                **payload, "demandId": "meeting-later",
            }))
            self.assertEqual(rebound["status"], "duplicate")
            self.assertEqual(rebound["observationSeq"], original["observationSeq"])

            with sqlite3.connect(database_path) as database:
                database.execute("UPDATE startup_events SET payload_digest = ?", ("f" * 64,))
            tampered = run_helper(root, "record-startup", payload, check=False)
            self.assertNotEqual(tampered.returncode, 0)
            self.assertIn("startup_event_mismatch", tampered.stderr)
            with sqlite3.connect(database_path) as database:
                self.assertEqual(database.execute("SELECT payload_digest FROM startup_events").fetchone()[0], "f" * 64)

    def test_startup_failure_is_generation_independent_idempotent_and_demand_gated(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            before_startup = output_json(
                run_helper(root, "export", {"afterCursor": 0})
            )["currentProjection"]
            startup_attempt = str(uuid.uuid4())
            payload = {
                "startupAttemptId": startup_attempt,
                "demandId": "meeting-1",
                "observedAt": "2026-09-18T03:30:02.000Z",
                "reasonClass": "startup_config_invalid",
                "operation": "startup",
            }
            first = output_json(run_helper(root, "record-startup", payload))
            replay = output_json(run_helper(root, "record-startup", payload))
            rebound = output_json(
                run_helper(
                    root,
                    "record-startup",
                    {**payload, "demandId": "meeting-later"},
                )
            )
            self.assertEqual(first["status"], "recorded")
            self.assertEqual(replay["status"], "duplicate")
            self.assertEqual(rebound["status"], "duplicate")
            self.assertEqual(first["episode"]["scope"], "session_unavailable")
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(exported["currentProjection"]["generation"], boot["generation"])
            self.assertEqual(exported["currentProjection"]["bootId"], before_startup["bootId"])

            mismatch = run_helper(
                root,
                "record-startup",
                {**payload, "reasonClass": "startup_lock_unavailable"},
                check=False,
            )
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertIn("startup_event_mismatch", mismatch.stderr)

            unrelated = output_json(
                run_helper(
                    root,
                    "record-startup",
                    {
                        "startupAttemptId": str(uuid.uuid4()),
                        "demandId": "meeting-unrelated",
                        "observedAt": "2026-09-18T03:30:03.000Z",
                        "reasonClass": "startup_not_ready",
                        "operation": "startup",
                    },
                )
            )
            self.assertNotIn("episode", unrelated)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1, state="none", identities=[]))
            diagnostic = output_json(
                run_helper(
                    root,
                    "record-startup",
                    {
                        "startupAttemptId": str(uuid.uuid4()),
                        "demandId": "meeting-1",
                        "observedAt": "2026-09-18T03:30:02.000Z",
                        "reasonClass": "startup_config_invalid",
                        "operation": "startup",
                    },
                )
            )
            self.assertNotIn("episode", diagnostic)
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(exported["openEpisodes"], [])
            self.assertEqual(exported["currentProjection"]["generation"], boot["generation"])
            output_json(
                self.record_demand(root, 2, state="unknown", identities=[])
            )
            unknown_diagnostic = output_json(
                run_helper(
                    root,
                    "record-startup",
                    {
                        "startupAttemptId": str(uuid.uuid4()),
                        "demandId": "meeting-1",
                        "observedAt": "2026-09-18T03:30:03.000Z",
                        "reasonClass": "startup_not_ready",
                        "operation": "startup",
                    },
                )
            )
            self.assertNotIn("episode", unknown_diagnostic)

    def test_evaluate_opens_elapsed_poll_episode_without_incrementing_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            failure = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "poll_failed",
                    "2026-09-18T03:30:00.000Z",
                    reasonClass="bridge_timeout_headers",
                    operation="desired",
                )
            )
            evaluated = output_json(
                run_helper(
                    root,
                    "evaluate",
                    {"observedAt": "2026-09-18T03:31:00.000Z"},
                )
            )
            self.assertEqual(failure["failureCount"], 1)
            self.assertEqual(evaluated["failureCount"], 1)
            self.assertEqual(evaluated["failureStreak"], 1)
            self.assertEqual(evaluated["episode"]["threshold"], "first_failure_60s")

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "poll_failed",
                    "2026-09-18T03:30:00.000Z",
                    reasonClass="bridge_timeout_headers",
                    operation="desired",
                )
            )
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    2,
                    "progress",
                    "2026-09-18T03:30:30.000Z",
                )
            )
            suppressed = output_json(
                run_helper(
                    root,
                    "evaluate",
                    {"observedAt": "2026-09-18T03:31:00.000Z"},
                )
            )
            self.assertEqual(suppressed["status"], "no_action")
            self.assertNotIn("episode", suppressed)

    def test_evaluate_opens_idle_heartbeat_stale_from_the_last_real_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "idle_success",
                    "2026-09-18T03:30:02.000Z",
                )
            )

            fresh = output_json(
                run_helper(
                    root,
                    "evaluate",
                    {"observedAt": "2026-09-18T03:31:01.000Z"},
                )
            )
            self.assertEqual(fresh["status"], "no_action")
            stale = output_json(
                run_helper(
                    root,
                    "evaluate",
                    {"observedAt": "2026-09-18T03:31:02.000Z"},
                )
            )
            self.assertEqual(stale["episode"]["reasonClass"], "heartbeat_stale")
            self.assertEqual(stale["episode"]["threshold"], "first_failure_60s")
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(
                exported["currentProjection"]["lastIterationSuccessAt"],
                "2026-09-18T03:30:02.000Z",
            )
            self.assertEqual(exported["currentProjection"]["operation"], "desired")

            recovered = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    2,
                    "idle_success",
                    "2026-09-18T03:31:03.000Z",
                )
            )
            self.assertEqual(
                recovered["closedEpisodeId"], stale["episode"]["episodeId"]
            )

    def test_active_renew_progress_recovers_heartbeat_stale(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "progress",
                    "2026-09-18T03:30:02.000Z",
                )
            )

            stale = output_json(
                run_helper(
                    root,
                    "evaluate",
                    {"observedAt": "2026-09-18T03:31:02.000Z"},
                )
            )
            self.assertEqual(stale["episode"]["reasonClass"], "heartbeat_stale")
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(
                exported["currentProjection"]["lastProgressAt"],
                "2026-09-18T03:30:02.000Z",
            )
            self.assertEqual(exported["currentProjection"]["operation"], "renew")

            recovered = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    2,
                    "progress",
                    "2026-09-18T03:31:03.000Z",
                )
            )
            self.assertEqual(
                recovered["closedEpisodeId"], stale["episode"]["episodeId"]
            )

    def test_session_recovery_and_session_end_require_bound_live_proof(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(
                self.record_demand(
                    root,
                    1,
                    identities=[{"demandId": "meeting-1", "attemptId": "attempt-2"}],
                )
            )
            failed = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "session_failed",
                    "2026-09-18T03:30:02.000Z",
                    reasonClass="session_create_failed",
                    operation="session_create",
                    demandId="meeting-1",
                    attemptId="attempt-1",
                )
            )
            no_fact = run_helper(
                root,
                "record-result",
                {
                    "generation": boot["generation"],
                    "producerEventSeq": 2,
                    "resultKind": "closed_not_required",
                    "observedAt": "2026-09-18T03:30:03.000Z",
                    "demandId": "meeting-1",
                },
                check=False,
            )
            self.assertNotEqual(no_fact.returncode, 0)
            self.assertIn("demand_close_fact_missing", no_fact.stderr)

            for sequence, observed_at in enumerate(
                (
                    "2026-09-18T03:30:03.100Z",
                    "2026-09-18T03:30:03.200Z",
                    "2026-09-18T03:30:03.300Z",
                ),
                start=2,
            ):
                poll_failure = output_json(
                    self.record_result(
                        root,
                        boot["generation"],
                        sequence,
                        "poll_failed",
                        observed_at,
                        reasonClass="bridge_connect_failed",
                        operation="desired",
                    )
                )
            poll_episode_id = poll_failure["episode"]["episodeId"]

            recovered = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    5,
                    "session_recovered",
                    "2026-09-18T03:30:07.000Z",
                    demandId="meeting-1",
                    successorAttemptId="attempt-2",
                    liveAt="2026-09-18T03:30:05.000Z",
                    renewAt="2026-09-18T03:30:06.000Z",
                )
            )
            self.assertEqual(recovered["closedEpisodeId"], failed["episode"]["episodeId"])
            ended = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    6,
                    "session_ended",
                    "2026-09-18T03:31:00.000Z",
                    demandId="meeting-1",
                    successorAttemptId="attempt-2",
                    liveAt="2026-09-18T03:30:05.000Z",
                    renewAt="2026-09-18T03:30:06.000Z",
                )
            )
            self.assertEqual(ended["successCount"], 1)
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(
                exported["currentProjection"]["lastIterationSuccessAt"],
                "2026-09-18T03:31:00.000Z",
            )
            self.assertEqual(exported["sessionRecoveryProofs"][0]["successorAttemptId"], "attempt-2")
            self.assertEqual(
                [episode["episodeId"] for episode in exported["openEpisodes"]],
                [poll_episode_id],
            )

    def test_sampled_count_delta_and_explicit_maintenance_checkpoint(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            idle = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "idle_success",
                    "2026-09-18T03:30:05.000Z",
                    countDelta=5,
                )
            )
            progress = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    2,
                    "progress",
                    "2026-09-18T03:30:10.000Z",
                    countDelta=3,
                )
            )
            self.assertEqual(idle["successCount"], 5)
            self.assertEqual(idle["checkpoint"], {"skipped": True})
            self.assertEqual(progress["progressCount"], 3)
            self.assertEqual(progress["checkpoint"], {"skipped": True})
            maintenance = output_json(
                run_helper(
                    root,
                    "maintenance",
                    {"requestedAt": "2026-09-18T03:31:00.000Z"},
                )
            )
            self.assertEqual(maintenance["status"], "checkpointed")
            self.assertIn("logFrames", maintenance["checkpoint"])

    def test_session_recovery_requires_exact_successor_and_post_failure_live_time(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(
                self.record_demand(
                    root,
                    1,
                    identities=[{"demandId": "meeting-1", "attemptId": "attempt-2"}],
                )
            )
            failed = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "session_failed",
                    "2026-09-18T03:30:05.000Z",
                    reasonClass="session_create_failed",
                    operation="session_create",
                    demandId="meeting-1",
                    attemptId="attempt-1",
                )
            )

            wrong_successor = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    2,
                    "session_recovered",
                    "2026-09-18T03:30:09.000Z",
                    demandId="meeting-1",
                    successorAttemptId="attempt-3",
                    liveAt="2026-09-18T03:30:07.000Z",
                    renewAt="2026-09-18T03:30:08.000Z",
                )
            )
            self.assertEqual(wrong_successor["status"], "no_action")
            pre_failure = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    3,
                    "session_recovered",
                    "2026-09-18T03:30:09.000Z",
                    demandId="meeting-1",
                    successorAttemptId="attempt-2",
                    liveAt="2026-09-18T03:30:04.000Z",
                    renewAt="2026-09-18T03:30:08.000Z",
                )
            )
            self.assertEqual(pre_failure["status"], "no_action")
            pre_failure_end = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    4,
                    "session_ended",
                    "2026-09-18T03:30:09.000Z",
                    demandId="meeting-1",
                    successorAttemptId="attempt-2",
                    liveAt="2026-09-18T03:30:04.000Z",
                    renewAt="2026-09-18T03:30:08.000Z",
                )
            )
            self.assertEqual(pre_failure_end["status"], "no_action")
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(exported["sessionRecoveryProofs"], [])
            self.assertEqual(exported["currentProjection"]["successCount"], 0)
            self.assertEqual(
                [episode["episodeId"] for episode in exported["openEpisodes"]],
                [failed["episode"]["episodeId"]],
            )

            recovered = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    5,
                    "session_recovered",
                    "2026-09-18T03:30:09.000Z",
                    demandId="meeting-1",
                    successorAttemptId="attempt-2",
                    liveAt="2026-09-18T03:30:06.000Z",
                    renewAt="2026-09-18T03:30:08.000Z",
                )
            )
            self.assertEqual(recovered["closedEpisodeId"], failed["episode"]["episodeId"])

    def test_export_rejects_deleted_change_ranges(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "idle_success",
                    "2026-09-18T03:30:02.000Z",
                )
            )
            database_path = root / "state" / "voice-health" / "observations.sqlite"
            with sqlite3.connect(database_path) as database:
                database.execute("DELETE FROM changes WHERE change_seq = 2")
            exported = run_helper(root, "export", {"afterCursor": 0}, check=False)
            self.assertNotEqual(exported.returncode, 0)
            self.assertIn("change_gap", exported.stderr)

    def test_notification_attempt_ledger_preserves_rebind_and_outcomes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            for sequence in range(1, 4):
                opened = output_json(
                    self.record_result(
                        root,
                        boot["generation"],
                        sequence,
                        "poll_failed",
                        f"2026-09-18T03:30:0{sequence}.000Z",
                        reasonClass="bridge_connect_failed",
                        operation="desired",
                    )
                )
            intent_id = opened["notification"]["intentId"]
            first_token = str(uuid.uuid4())
            output_json(
                run_helper(
                    root,
                    "claim-notification",
                    {
                        "intentId": intent_id,
                        "claimToken": first_token,
                        "claimedAt": "2026-09-18T03:30:04.000Z",
                        "expiresAt": "2026-09-18T03:31:04.000Z",
                        "bindingDigest": BINDING_DIGEST,
                        "channelId": "123456789012345678",
                    },
                )
            )
            output_json(
                run_helper(
                    root,
                    "record-delivery",
                    {
                        "intentId": intent_id,
                        "claimToken": first_token,
                        "bindingDigest": BINDING_DIGEST,
                        "state": "queued_transient",
                    },
                )
            )
            second_token = str(uuid.uuid4())
            second_binding = "c" * 64
            output_json(
                run_helper(
                    root,
                    "claim-notification",
                    {
                        "intentId": intent_id,
                        "claimToken": second_token,
                        "claimedAt": "2026-09-18T03:31:05.000Z",
                        "expiresAt": "2026-09-18T03:32:05.000Z",
                        "bindingDigest": second_binding,
                        "channelId": "323456789012345678",
                    },
                )
            )
            output_json(
                run_helper(
                    root,
                    "record-delivery",
                    {
                        "intentId": intent_id,
                        "claimToken": second_token,
                        "bindingDigest": second_binding,
                        "state": "sent",
                        "channelId": "323456789012345678",
                        "messageId": "423456789012345678",
                    },
                )
            )
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            attempts = [
                attempt
                for attempt in exported["notificationAttempts"]
                if attempt["intentId"] == intent_id
            ]
            self.assertEqual(
                [attempt["eventKind"] for attempt in attempts],
                ["claimed", "queued_transient", "claimed", "sent"],
            )
            self.assertEqual(attempts[0]["bindingDigest"], BINDING_DIGEST)
            self.assertEqual(attempts[2]["bindingDigest"], second_binding)

    def test_definite_unsent_receipt_after_recovery_is_cancelled_and_not_reclaimable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            for sequence in range(1, 4):
                opened = output_json(
                    self.record_result(
                        root,
                        boot["generation"],
                        sequence,
                        "poll_failed",
                        f"2026-09-18T03:30:0{sequence}.000Z",
                        reasonClass="bridge_connect_failed",
                        operation="desired",
                    )
                )
            intent_id = opened["notification"]["intentId"]
            claim_token = str(uuid.uuid4())
            output_json(
                run_helper(
                    root,
                    "claim-notification",
                    {
                        "intentId": intent_id,
                        "claimToken": claim_token,
                        "claimedAt": "2026-09-18T03:30:04.000Z",
                        "expiresAt": "2026-09-18T03:31:04.000Z",
                        "bindingDigest": BINDING_DIGEST,
                        "channelId": "123456789012345678",
                    },
                )
            )
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    4,
                    "idle_success",
                    "2026-09-18T03:30:05.000Z",
                )
            )
            closed_claim = output_json(
                run_helper(
                    root,
                    "claim-notification",
                    {
                        "intentId": intent_id,
                        "claimToken": str(uuid.uuid4()),
                        "claimedAt": "2026-09-18T03:30:05.500Z",
                        "expiresAt": "2026-09-18T03:31:05.500Z",
                        "bindingDigest": BINDING_DIGEST,
                        "channelId": "123456789012345678",
                    },
                )
            )
            self.assertEqual(closed_claim["status"], "not_claimable")
            late_unsent = output_json(
                run_helper(
                    root,
                    "record-delivery",
                    {
                        "intentId": intent_id,
                        "claimToken": claim_token,
                        "bindingDigest": BINDING_DIGEST,
                        "state": "queued_transient",
                    },
                )
            )
            self.assertEqual(late_unsent["state"], "cancelled_recovered")
            reclaimed = output_json(
                run_helper(
                    root,
                    "claim-notification",
                    {
                        "intentId": intent_id,
                        "claimToken": str(uuid.uuid4()),
                        "claimedAt": "2026-09-18T03:30:06.000Z",
                        "expiresAt": "2026-09-18T03:31:06.000Z",
                        "bindingDigest": BINDING_DIGEST,
                        "channelId": "123456789012345678",
                    },
                )
            )
            self.assertEqual(reclaimed["status"], "not_claimable")

    def test_late_sent_and_unknown_receipts_remain_historical_after_recovery(self):
        for late_state in ("sent", "delivery_unknown"):
            with self.subTest(late_state=late_state), tempfile.TemporaryDirectory() as temp:
                root = Path(temp) / "state-root"
                boot = self.register_boot(root)
                output_json(self.record_demand(root, 1))
                for sequence in range(1, 4):
                    opened = output_json(
                        self.record_result(
                            root,
                            boot["generation"],
                            sequence,
                            "poll_failed",
                            f"2026-09-18T03:30:0{sequence}.000Z",
                            reasonClass="bridge_connect_failed",
                            operation="desired",
                        )
                    )
                intent_id = opened["notification"]["intentId"]
                claim_token = str(uuid.uuid4())
                output_json(
                    run_helper(
                        root,
                        "claim-notification",
                        {
                            "intentId": intent_id,
                            "claimToken": claim_token,
                            "claimedAt": "2026-09-18T03:30:04.000Z",
                            "expiresAt": "2026-09-18T03:31:04.000Z",
                            "bindingDigest": BINDING_DIGEST,
                            "channelId": "123456789012345678",
                        },
                    )
                )
                output_json(
                    self.record_result(
                        root,
                        boot["generation"],
                        4,
                        "idle_success",
                        "2026-09-18T03:30:05.000Z",
                    )
                )
                delivery = {
                    "intentId": intent_id,
                    "claimToken": claim_token,
                    "bindingDigest": BINDING_DIGEST,
                    "state": late_state,
                }
                if late_state == "sent":
                    delivery.update(
                        {
                            "channelId": "123456789012345678",
                            "messageId": "223456789012345678",
                        }
                    )
                receipt = output_json(
                    run_helper(root, "record-delivery", delivery)
                )
                self.assertEqual(receipt["state"], late_state)
                exported = output_json(
                    run_helper(root, "export", {"afterCursor": 0})
                )
                self.assertEqual(exported["notifications"][0]["state"], late_state)
                self.assertEqual(exported["openEpisodes"], [])

    def test_progress_between_poll_failures_keeps_the_elapsed_threshold(self):
        # FLY-2693 review R5: this used to assert that a lease-renew progress
        # reset the poll failure window (streak 1, no episode). Progress is
        # session-scope evidence and must not defeat the poll thresholds.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    1,
                    "poll_failed",
                    "2026-09-18T03:30:00.000Z",
                    reasonClass="bridge_timeout_headers",
                    operation="desired",
                )
            )
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    2,
                    "progress",
                    "2026-09-18T03:30:30.000Z",
                )
            )
            later = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    3,
                    "poll_failed",
                    "2026-09-18T03:31:01.000Z",
                    reasonClass="bridge_timeout_headers",
                    operation="desired",
                )
            )
            self.assertEqual(later["failureStreak"], 2)
            self.assertEqual(later["episode"]["scope"], "poll_dependency")
            self.assertEqual(later["episode"]["threshold"], "first_failure_60s")
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(exported["currentProjection"]["firstFailureAt"], "2026-09-18T03:30:00.000Z")
            self.assertEqual(len(exported["openEpisodes"]), 1)

    def test_demand_source_rotation_cannot_reuse_ids_to_close_old_episode(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            source_a = DEMAND_SOURCE_ID
            source_b = "33333333-3333-4333-8333-333333333333"
            identities = [{"demandId": "meeting-1", "attemptId": "attempt-1"}]
            opened = output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": source_a,
                        "revision": 1,
                        "digest": demand_digest(identities),
                        "state": "required",
                        "observedAt": "2026-09-18T03:30:02.000Z",
                        "identities": identities,
                        "pageAfterCursor": 0,
                        "pageNextCursor": 2,
                        "eventHighWater": 2,
                        "hasMore": False,
                        "gap": False,
                        "events": [
                            {
                                "eventSeq": 1,
                                "eventKind": "required",
                                "demandId": "meeting-1",
                                "attemptId": "attempt-1",
                                "observedAt": "2026-09-18T03:30:00.000Z",
                            },
                            {
                                "eventSeq": 2,
                                "eventKind": "failed",
                                "demandId": "meeting-1",
                                "attemptId": "attempt-1",
                                "observedAt": "2026-09-18T03:30:01.000Z",
                                "reasonClass": "session_create_failed",
                            },
                        ],
                    },
                )
            )
            old_episode_id = opened["episode"]["episodeId"]
            output_json(
                self.record_demand(
                    root,
                    0,
                    state="unknown",
                    identities=[],
                    source_id=source_b,
                )
            )
            output_json(
                self.record_demand(
                    root,
                    1,
                    state="required",
                    identities=identities,
                    source_id=source_b,
                )
            )
            foreign_recovery = output_json(
                run_helper(
                    root,
                    "record-result",
                    {
                        "generation": boot["generation"],
                        "producerEventSeq": 1,
                        "resultKind": "session_recovered",
                        "observedAt": "2026-09-18T03:30:07.000Z",
                        "demandId": "meeting-1",
                        "successorAttemptId": "attempt-2",
                        "liveAt": "2026-09-18T03:30:05.000Z",
                        "renewAt": "2026-09-18T03:30:06.000Z",
                    },
                )
            )
            self.assertEqual(foreign_recovery["status"], "no_action")

            new_failure = output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    2,
                    "session_failed",
                    "2026-09-18T03:30:08.000Z",
                    reasonClass="session_create_failed",
                    operation="session_create",
                    demandId="meeting-1",
                    attemptId="attempt-1",
                )
            )
            self.assertNotEqual(new_failure["episode"]["episodeId"], old_episode_id)
            output_json(
                self.record_demand(
                    root,
                    2,
                    identities=[{"demandId": "meeting-1", "attemptId": "attempt-2"}],
                    source_id=source_b,
                )
            )
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    3,
                    "session_recovered",
                    "2026-09-18T03:30:12.000Z",
                    demandId="meeting-1",
                    successorAttemptId="attempt-2",
                    liveAt="2026-09-18T03:30:10.000Z",
                    renewAt="2026-09-18T03:30:11.000Z",
                )
            )
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(
                [episode["episodeId"] for episode in exported["openEpisodes"]],
                [old_episode_id],
            )
            self.assertEqual(exported["openEpisodes"][0]["demandSourceId"], source_a)
            self.assertEqual(exported["openEpisodes"][0]["sourceStatus"], "unverified")
            self.assertEqual(exported["sessionRecoveryProofs"][0]["demandSourceId"], source_b)

    def test_unbound_recovery_is_no_action_and_normal_end_requires_current_binding(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            generation = boot["generation"]
            initial = output_json(run_helper(root, "export", {"afterCursor": 0}))
            initial_observation = initial["currentProjection"]["observationSeq"]

            equal_timestamp_proof = run_helper(
                root,
                "record-result",
                {
                    "generation": generation,
                    "producerEventSeq": 1,
                    "resultKind": "session_recovered",
                    "observedAt": "2026-09-18T03:30:06.000Z",
                    "demandId": "unrelated-meeting",
                    "successorAttemptId": "attempt-2",
                    "liveAt": "2026-09-18T03:30:05.000Z",
                    "renewAt": "2026-09-18T03:30:05.000Z",
                },
                check=False,
            )
            self.assertNotEqual(equal_timestamp_proof.returncode, 0)
            self.assertIn("invalid_recovery_proof", equal_timestamp_proof.stderr)

            recovery = output_json(
                self.record_result(
                    root,
                    generation,
                    1,
                    "session_recovered",
                    "2026-09-18T03:30:07.000Z",
                    demandId="unrelated-meeting",
                    successorAttemptId="attempt-2",
                    liveAt="2026-09-18T03:30:05.000Z",
                    renewAt="2026-09-18T03:30:06.000Z",
                )
            )
            self.assertEqual(recovery["status"], "no_action")
            self.assertEqual(recovery["observationSeq"], initial_observation)
            duplicate = output_json(
                self.record_result(
                    root,
                    generation,
                    1,
                    "session_recovered",
                    "2026-09-18T03:30:07.000Z",
                    demandId="unrelated-meeting",
                    successorAttemptId="attempt-2",
                    liveAt="2026-09-18T03:30:05.000Z",
                    renewAt="2026-09-18T03:30:06.000Z",
                )
            )
            self.assertEqual(duplicate["status"], "duplicate")
            ended_unbound = output_json(
                self.record_result(
                    root,
                    generation,
                    2,
                    "session_ended",
                    "2026-09-18T03:30:08.000Z",
                    demandId="unrelated-meeting",
                    successorAttemptId="attempt-2",
                    liveAt="2026-09-18T03:30:05.000Z",
                    renewAt="2026-09-18T03:30:06.000Z",
                )
            )
            self.assertEqual(ended_unbound["status"], "no_action")
            before_bound = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(before_bound["currentProjection"]["successCount"], 0)
            self.assertEqual(before_bound["sessionRecoveryProofs"], [])

            output_json(
                self.record_demand(
                    root,
                    1,
                    identities=[{"demandId": "meeting-1", "attemptId": "attempt-3"}],
                )
            )
            ended_bound = output_json(
                self.record_result(
                    root,
                    generation,
                    3,
                    "session_ended",
                    "2026-09-18T03:30:12.000Z",
                    demandId="meeting-1",
                    successorAttemptId="attempt-3",
                    liveAt="2026-09-18T03:30:10.000Z",
                    renewAt="2026-09-18T03:30:11.000Z",
                )
            )
            self.assertEqual(ended_bound["status"], "recorded")
            self.assertEqual(ended_bound["successCount"], 1)
            after_bound = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(len(after_bound["sessionRecoveryProofs"]), 1)
            self.assertIsNone(after_bound["sessionRecoveryProofs"][0]["episodeId"])
            terminal_after_end = output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": DEMAND_SOURCE_ID,
                        "revision": 2,
                        "digest": demand_digest([]),
                        "state": "none",
                        "observedAt": "2026-09-18T03:30:14.000Z",
                        "identities": [],
                        "pageAfterCursor": 0,
                        "pageNextCursor": 2,
                        "eventHighWater": 2,
                        "hasMore": False,
                        "gap": False,
                        "events": [
                            {
                                "eventSeq": 1,
                                "eventKind": "required",
                                "demandId": "meeting-1",
                                "attemptId": "attempt-3",
                                "observedAt": "2026-09-18T03:30:09.000Z",
                            },
                            {
                                "eventSeq": 2,
                                "eventKind": "normal_completed",
                                "demandId": "meeting-1",
                                "attemptId": "attempt-3",
                                "observedAt": "2026-09-18T03:30:13.000Z",
                            },
                        ],
                    },
                )
            )
            self.assertEqual(terminal_after_end["status"], "recorded")
            final = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(final["currentProjection"]["successCount"], 1)
            self.assertEqual(len(final["sessionRecoveryProofs"]), 1)

    def test_session_end_accepts_exact_normal_completed_fact_but_not_other_terminal_bindings(self):
        def project_terminal(root, terminal_kind="normal_completed"):
            return output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": DEMAND_SOURCE_ID,
                        "revision": 1,
                        "digest": demand_digest([]),
                        "state": "none",
                        "observedAt": "2026-09-18T03:30:13.000Z",
                        "identities": [],
                        "pageAfterCursor": 0,
                        "pageNextCursor": 2,
                        "eventHighWater": 2,
                        "hasMore": False,
                        "gap": False,
                        "events": [
                            {
                                "eventSeq": 1,
                                "eventKind": "required",
                                "demandId": "meeting-1",
                                "attemptId": "attempt-2",
                                "observedAt": "2026-09-18T03:30:01.000Z",
                            },
                            {
                                "eventSeq": 2,
                                "eventKind": terminal_kind,
                                "demandId": "meeting-1",
                                "attemptId": "attempt-2",
                                "observedAt": "2026-09-18T03:30:12.000Z",
                            },
                        ],
                    },
                )
            )

        def record_end(root, generation, successor="attempt-2", **timestamps):
            return output_json(
                self.record_result(
                    root,
                    generation,
                    1,
                    "session_ended",
                    timestamps.get("observedAt", "2026-09-18T03:30:10.000Z"),
                    demandId="meeting-1",
                    successorAttemptId=successor,
                    liveAt=timestamps.get("liveAt", "2026-09-18T03:30:05.000Z"),
                    renewAt=timestamps.get("renewAt", "2026-09-18T03:30:09.000Z"),
                )
            )

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "accepted"
            boot = self.register_boot(root)
            project_terminal(root)
            accepted = record_end(root, boot["generation"])
            self.assertEqual(accepted["status"], "recorded")
            self.assertEqual(accepted["successCount"], 1)
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(len(exported["sessionRecoveryProofs"]), 1)
            self.assertEqual(
                exported["sessionRecoveryProofs"][0]["successorAttemptId"],
                "attempt-2",
            )

        rejected_cases = (
            ("cancelled", "attempt-2", {}),
            ("normal_completed", "attempt-3", {}),
            (
                "normal_completed",
                "attempt-2",
                {
                    "observedAt": "2026-09-18T03:30:15.000Z",
                    "liveAt": "2026-09-18T03:30:13.000Z",
                    "renewAt": "2026-09-18T03:30:14.000Z",
                },
            ),
        )
        for terminal_kind, successor, timestamps in rejected_cases:
            with self.subTest(terminal_kind=terminal_kind, successor=successor):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp) / "rejected"
                    boot = self.register_boot(root)
                    project_terminal(root, terminal_kind)
                    rejected = record_end(
                        root, boot["generation"], successor, **timestamps
                    )
                    self.assertEqual(rejected["status"], "no_action")
                    exported = output_json(
                        run_helper(root, "export", {"afterCursor": 0})
                    )
                    self.assertEqual(exported["currentProjection"]["successCount"], 0)
                    self.assertEqual(exported["sessionRecoveryProofs"], [])

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "wrong-source"
            boot = self.register_boot(root)
            project_terminal(root)
            output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": "33333333-3333-4333-8333-333333333333",
                        "revision": 0,
                        "digest": demand_digest([]),
                        "state": "unknown",
                        "observedAt": "2026-09-18T03:30:14.000Z",
                        "identities": [],
                    },
                )
            )
            wrong_source = record_end(root, boot["generation"])
            self.assertEqual(wrong_source["status"], "no_action")
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(exported["currentProjection"]["successCount"], 0)
            self.assertEqual(exported["sessionRecoveryProofs"], [])

    def test_claim_expiry_is_recorded_after_episode_recovery_before_reclaim_check(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            boot = self.register_boot(root)
            output_json(self.record_demand(root, 1))
            for sequence in range(1, 4):
                opened = output_json(
                    self.record_result(
                        root,
                        boot["generation"],
                        sequence,
                        "poll_failed",
                        f"2026-09-18T03:30:0{sequence}.000Z",
                        reasonClass="bridge_connect_failed",
                        operation="desired",
                    )
                )
            intent_id = opened["notification"]["intentId"]
            claim_token = str(uuid.uuid4())
            output_json(
                run_helper(
                    root,
                    "claim-notification",
                    {
                        "intentId": intent_id,
                        "claimToken": claim_token,
                        "claimedAt": "2026-09-18T03:30:04.000Z",
                        "expiresAt": "2026-09-18T03:30:05.000Z",
                        "bindingDigest": BINDING_DIGEST,
                        "channelId": "123456789012345678",
                    },
                )
            )
            output_json(
                self.record_result(
                    root,
                    boot["generation"],
                    4,
                    "idle_success",
                    "2026-09-18T03:30:04.500Z",
                )
            )
            expired = output_json(
                run_helper(
                    root,
                    "claim-notification",
                    {
                        "intentId": intent_id,
                        "claimToken": claim_token,
                        "claimedAt": "2026-09-18T03:30:06.000Z",
                        "expiresAt": "2026-09-18T03:30:07.000Z",
                        "bindingDigest": BINDING_DIGEST,
                        "channelId": "123456789012345678",
                    },
                )
            )
            self.assertEqual(expired["status"], "delivery_unknown")
            exported = output_json(run_helper(root, "export", {"afterCursor": 0}))
            self.assertEqual(exported["notifications"][0]["state"], "delivery_unknown")
            self.assertEqual(exported["notificationAttempts"][-1]["eventKind"], "delivery_unknown")
            later_claim = output_json(
                run_helper(
                    root,
                    "claim-notification",
                    {
                        "intentId": intent_id,
                        "claimToken": str(uuid.uuid4()),
                        "claimedAt": "2026-09-18T03:30:08.000Z",
                        "expiresAt": "2026-09-18T03:30:09.000Z",
                        "bindingDigest": BINDING_DIGEST,
                        "channelId": "123456789012345678",
                    },
                )
            )
            self.assertEqual(later_claim["status"], "not_claimable")

    def test_incomplete_page_preserves_prior_authoritative_snapshot_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "state-root"
            self.register_boot(root)
            identities = [{"demandId": "meeting-1"}]
            output_json(self.record_demand(root, 5, identities=identities))
            before = output_json(run_helper(root, "export", {"afterCursor": 0}))[
                "currentProjection"
            ]
            output_json(
                run_helper(
                    root,
                    "record-demand",
                    {
                        "demandSourceId": DEMAND_SOURCE_ID,
                        "revision": 6,
                        "digest": demand_digest([]),
                        "state": "unknown",
                        "observedAt": "2026-09-18T03:31:00.000Z",
                        "identities": [],
                        "pageAfterCursor": 0,
                        "pageNextCursor": 1,
                        "eventHighWater": 2,
                        "hasMore": True,
                        "gap": False,
                        "events": [
                            {
                                "eventSeq": 1,
                                "eventKind": "required",
                                "demandId": "meeting-2",
                                "attemptId": "attempt-2",
                                "observedAt": "2026-09-18T03:30:59.000Z",
                            }
                        ],
                    },
                )
            )
            after = output_json(run_helper(root, "export", {"afterCursor": 0}))[
                "currentProjection"
            ]
            self.assertEqual(after["demandState"], "unknown")
            for field in (
                "demandRevision",
                "demandDigest",
                "demandIdentities",
                "demandObservedAt",
            ):
                self.assertEqual(after[field], before[field])


if __name__ == "__main__":
    unittest.main()
