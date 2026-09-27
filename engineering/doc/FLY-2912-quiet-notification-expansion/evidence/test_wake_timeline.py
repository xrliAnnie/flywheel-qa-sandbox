import importlib.util
import unittest
import json
import os
import sqlite3
import tempfile
from types import SimpleNamespace
from contextlib import closing
from pathlib import Path

spec = importlib.util.spec_from_file_location("wake_timeline", Path(__file__).with_name("reconstruct-wake-timeline.py"))
module = importlib.util.module_from_spec(spec)
if spec.loader is not None:
    spec.loader.exec_module(module)


def record(uid, kind, timestamp, parent=None, **extra):
    return dict(uuid=uid, type=kind, timestamp=timestamp, parentUuid=parent, **extra)


def input_row(uid, timestamp, parent=None, text="[mailbox-batch batch-1 | 1 messages | from bridge]\n[Event #1]", **extra):
    return record(uid, "user", timestamp, parent, message={"content": text}, **extra)


def finish(uid, timestamp, duration, parent):
    return record(uid, "system", timestamp, parent, subtype="turn_duration", durationMs=duration)


class WakeTimelineTest(unittest.TestCase):
    def test_multiple_inputs_and_model_requests_in_one_runtime_turn_are_one_start(self):
        rows = [input_row("i1", "2026-09-25T07:00:00Z"),
                record("a1", "assistant", "2026-09-25T07:00:01Z", "i1", requestId="r1"),
                input_row("i2", "2026-09-25T07:00:02Z", "a1"),
                record("a2", "assistant", "2026-09-25T07:00:04Z", "i2", requestId="r2"),
                finish("t1", "2026-09-25T07:00:05Z", 5000, "a2")]
        result = module.reconstruct([module.project_rows("s1", rows)], [], [])
        self.assertEqual(len(result["turns"]), 1)
        self.assertEqual(result["turns"][0]["inputIds"], ["i1", "i2"])
        self.assertEqual(result["turns"][0]["triggerInputId"], "i1")
        self.assertIsNone(result["comparison"]["after"])
        self.assertFalse(result["acceptance"]["complete"])

    def test_window_uses_start_time_and_includes_completion_after_midnight(self):
        rows = [input_row("old", "2026-09-25T06:59:59Z"),
                finish("t0", "2026-09-25T07:00:01Z", 2000, "old"),
                input_row("last", "2026-09-26T06:59:59Z", "t0"),
                finish("t1", "2026-09-26T07:00:01Z", 2000, "last")]
        result = module.reconstruct([module.project_rows("s1", rows)], [], [])
        self.assertEqual([t["markerId"] for t in result["turns"]], ["t1"])

    def test_parent_link_is_required_not_just_a_nearby_input(self):
        rows = [input_row("unrelated", "2026-09-25T07:00:00Z"),
                finish("t1", "2026-09-25T07:00:01Z", 1000, "missing")]
        result = module.reconstruct([module.project_rows("s1", rows)], [], [])
        self.assertIsNone(result["turns"][0]["triggerInputId"])
        self.assertEqual(result["counts"]["unattributedTurnStarts"], 1)

    def test_projection_retains_meta_trigger_but_never_private_text(self):
        rows = [input_row("i1", "2026-09-25T07:00:00Z", text="private secret", isMeta=True),
                finish("t1", "2026-09-25T07:00:01Z", 1000, "i1")]
        projected = module.project_rows("s1", rows)
        self.assertNotIn("private secret", str(projected))
        result = module.reconstruct([projected], [], [])
        self.assertEqual(result["turns"][0]["triggerInputId"], "i1")
        self.assertTrue(result["turns"][0]["hasOtherInput"])

    def test_batch_join_preserves_founder_member_without_event_seq(self):
        rows = [input_row("i1", "2026-09-25T07:00:00Z", text="[mailbox-batch batch-1 | 2 messages | from bridge]\n[Event #1]"),
                finish("t1", "2026-09-25T07:00:01Z", 1000, "i1")]
        mailbox = [dict(delivery_id="d1", batch_id="batch-1", source_kind="lead_event", source_ref="1"),
                   dict(delivery_id="d2", batch_id="batch-1", source_kind="discord_chat", source_ref="founder-1")]
        events = [dict(seq=1, event_id="e1", event_type="stage_changed")]
        result = module.reconstruct([module.project_rows("s1", rows)], mailbox, events)
        turn = result["turns"][0]
        self.assertEqual(turn["sourceJoinMissing"], [])
        self.assertEqual(turn["sourceKinds"], ["discord_chat", "lead_event"])
        self.assertFalse(turn["onlyTargetNotifications"])

    def test_missing_batch_member_is_not_a_complete_source_join(self):
        rows = [input_row("i1", "2026-09-25T07:00:00Z", text="[mailbox-batch batch-1 | 2 messages | from bridge]\n[Event #1]"),
                finish("t1", "2026-09-25T07:00:01Z", 1000, "i1")]
        mailbox = [dict(delivery_id="d1", batch_id="batch-1", source_kind="lead_event", source_ref="1")]
        events = [dict(seq=1, event_id="e1", event_type="stage_changed")]
        result = module.reconstruct([module.project_rows("s1", rows)], mailbox, events)
        self.assertTrue(result["turns"][0]["sourceJoinMissing"])
        self.assertFalse(result["turns"][0]["onlyTargetNotifications"])

    def test_target_authority_unknown_is_excluded_from_reconstructable_comparison(self):
        events = [dict(seq=1, event_id="e1", event_type="stage_changed", created_at="2026-09-25 07:00:01", delivery_disposition="model"),
                  dict(seq=2, event_id="e2", event_type="founder_reply", created_at="2026-09-25 07:00:02", delivery_disposition="model")]
        result = module.reconstruct([], [], events)
        comparison = result["eventComparison"]
        self.assertEqual(comparison["unknown"], 1)
        self.assertEqual(comparison["reconstructable"], 1)
        self.assertEqual(comparison["beforeModel"], 1)
        self.assertEqual(comparison["afterModel"], 1)
        self.assertEqual(comparison["unknownShare"], 0.5)
        self.assertIsNone(result["comparison"]["after"])

    def test_compaction_logical_parent_preserves_original_trigger(self):
        rows = [input_row("i1", "2026-09-25T07:00:00Z"),
                record("boundary", "system", "2026-09-25T07:00:01Z", None, subtype="compact_boundary", logicalParentUuid="i1"),
                input_row("summary", "2026-09-25T07:00:02Z", "boundary", isCompactSummary=True),
                finish("t1", "2026-09-25T07:00:03Z", 3000, "summary")]
        result = module.reconstruct([module.project_rows("s1", rows)], [], [])
        self.assertEqual(result["turns"][0]["triggerInputId"], "i1")
        self.assertEqual(result["turns"][0]["inputIds"], ["i1"])

    def test_quoted_headers_in_free_text_are_not_source_members(self):
        rows = [input_row("i1", "2026-09-25T07:00:00Z", text="Old context: [mailbox-batch batch-1 | 1 messages | from bridge] [Event #1]")]
        projected = module.project_rows("s1", rows)
        self.assertEqual(projected["records"][0]["batches"], [])
        self.assertEqual(projected["records"][0]["eventSeqs"], [])

    def test_nonempty_error_is_a_reconstructable_model_guard_not_quiet_proof(self):
        events = [dict(seq=1, event_id="e1", event_type="stage_changed", created_at="2026-09-25 07:00:01", delivery_disposition="model", actionGuardFields=["last_error"])]
        result = module.reconstruct([], [], events)
        self.assertEqual(result["eventComparison"]["unknown"], 0)
        self.assertEqual(result["eventComparison"]["reconstructable"], 1)
        self.assertEqual(result["eventComparison"]["beforeModel"], 1)
        self.assertEqual(result["eventComparison"]["afterModel"], 1)

    def test_extract_recovers_old_exact_source_and_membership_from_mailbox_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            transcript = root / "session.jsonl"
            rows = [input_row("i1", "2026-09-25T07:00:00Z"), finish("t1", "2026-09-25T07:00:01Z", 1000, "i1")]
            transcript.write_text("".join(json.dumps(row) + "\n" for row in rows))
            os.utime(transcript, (module.millis(module.END) / 1000,) * 2)
            with closing(sqlite3.connect(root / "team.db")) as db:
                db.execute("CREATE TABLE lead_events(seq INTEGER, event_id TEXT, event_type TEXT, session_key TEXT, created_at TEXT, delivery_disposition TEXT, payload TEXT, lead_id TEXT)")
                db.execute("INSERT INTO lead_events VALUES (1,'e1','stage_changed','flywheel:FLY-1','2026-09-20 00:00:00','model','{}',?)", (module.LEAD,))
                db.commit()
            with closing(sqlite3.connect(root / "comm.db")) as db:
                for table in ("mailbox", "mailbox_archive"):
                    db.execute(f"CREATE TABLE {table}(delivery_id TEXT,batch_id TEXT,source_kind TEXT,source_ref TEXT,created_at TEXT,to_agent TEXT)")
                db.execute("CREATE TABLE mailbox_terminal_archive(mailbox_json TEXT)")
                db.execute("CREATE TABLE mailbox_log(row_json TEXT)")
                member = dict(delivery_id="d1", batch_id="batch-1", source_kind="lead_event", source_ref="1", created_at="2026-09-20T00:00:00Z", to_agent=module.LEAD, content="PRIVATE BODY")
                db.execute("INSERT INTO mailbox_log VALUES (?)", (json.dumps(member),))
                db.commit()
            exported = module.export_sources(SimpleNamespace(transcript_dir=root, teamlead_db=root / "team.db", comm_db=root / "comm.db"))
            self.assertEqual(len(exported["events"]), 1)
            self.assertEqual(len(exported["mailbox"]), 1)
            self.assertNotIn("PRIVATE BODY", str(exported))
            result = module.reconstruct(exported["transcripts"], exported["mailbox"], exported["events"])
            self.assertEqual(result["turns"][0]["sourceJoinMissing"], [])

    def test_duplicates_deduplicate_but_conflicting_identity_fails(self):
        row = input_row("i1", "2026-09-25T07:00:00Z")
        projected = module.project_rows("s1", [row, row])
        self.assertEqual(len(projected["records"]), 1)
        with self.assertRaises(ValueError):
            module.project_rows("s1", [row, input_row("i1", "2026-09-25T07:00:01Z")])


if __name__ == "__main__":
    unittest.main()
