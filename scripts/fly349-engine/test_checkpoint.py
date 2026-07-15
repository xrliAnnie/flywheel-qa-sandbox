#!/usr/bin/env python3
"""Tests for the FLY-349 engine checkpoint state machine. Run: python3 test_checkpoint.py"""
import os, tempfile, sys
import checkpoint as C

NOW = "2026-06-20T00:00:00Z"
N2 = "2026-06-20T00:01:00Z"
ok = 0


def check(cond, msg):
    global ok
    assert cond, "FAIL: " + msg
    ok += 1


def test_save_load_roundtrip_atomic():
    st = C.fresh_state("claude", "cid", NOW)
    C.add_note(st, "n1", "t1", "video", NOW)
    d = tempfile.mkdtemp()
    p = os.path.join(d, "sub", "state.json")
    C.save_state(st, p)
    check(os.path.exists(p), "state file written")
    check(oct(os.stat(p).st_mode)[-3:] == "600", "state file is 0600")
    got = C.load_state(p)
    check(got["notes"]["n1"]["title"] == "t1", "roundtrip preserves note")
    check(C.load_state(os.path.join(d, "nope.json")) is None, "missing file -> None")


def test_stage_progression_and_done():
    st = C.fresh_state("claude", "cid", NOW)
    C.add_note(st, "n1", "t", "video", NOW)
    check(not C.note_done(st, "n1"), "fresh note not done")
    for s in ("fetched", "downloaded", "analyzed"):
        C.mark_stage(st, "n1", s, True, NOW)
    check(not C.note_done(st, "n1"), "not done before judged")
    # useful -> needs issue + attached
    C.set_judgment(st, "n1", True, NOW)
    check(not C.note_done(st, "n1"), "useful note not done w/o issue")
    C.mark_stage(st, "n1", "issue", "FLY-999", NOW)
    check(st["notes"]["n1"]["issueId"] == "FLY-999", "issueId recorded")
    check(not C.note_done(st, "n1"), "useful note not done w/o attached")
    C.mark_stage(st, "n1", "attached", True, NOW)
    check(C.note_done(st, "n1"), "useful note done after issue+attached")


def test_not_useful_done_without_issue():
    st = C.fresh_state("claude", "cid", NOW)
    C.add_note(st, "n2", "t", "normal", NOW)
    for s in ("fetched", "downloaded", "analyzed"):
        C.mark_stage(st, "n2", s, True, NOW)
    C.set_judgment(st, "n2", False, NOW)
    check(C.note_done(st, "n2"), "not-useful note done after judged (no issue needed)")


def test_resume_skips_resolved():
    st = C.fresh_state("claude", "cid", NOW)
    C.add_note(st, "done1", "t", "normal", NOW)
    for s in ("fetched", "downloaded", "analyzed"):
        C.mark_stage(st, "done1", s, True, NOW)
    C.set_judgment(st, "done1", False, NOW)
    C.add_note(st, "fail1", "t", "normal", NOW)
    C.set_status(st, "fail1", "failed", NOW)
    check(C.is_resolved(st, "done1"), "fully-done note resolved")
    check(C.is_resolved(st, "fail1"), "failed (terminal) note resolved")
    check(not C.is_resolved(st, "neverseen"), "unknown note not resolved")


def test_batching_10_and_resume():
    st = C.fresh_state("claude", "cid", NOW)
    cands = [f"c{i}" for i in range(25)]
    b1 = C.assign_next_batch(st, cands, NOW)
    check(len(b1["noteIds"]) == 10, "batch 1 has 10")
    check(b1["batchNo"] == 1, "batch numbered 1")
    # resume mid-batch: batch 1 not reviewed -> assign returns same batch
    again = C.assign_next_batch(st, cands, N2)
    check(again["noteIds"] == b1["noteIds"], "unfinished batch returned on resume, not a new one")
    # mark batch1 reviewed -> next assign opens batch 2 with next 10 (no overlap)
    C.mark_batch(st, 1, "reviewed", N2)
    b2 = C.assign_next_batch(st, cands, N2)
    check(b2["batchNo"] == 2 and len(b2["noteIds"]) == 10, "batch 2 has next 10")
    check(set(b1["noteIds"]).isdisjoint(b2["noteIds"]), "batches don't overlap")
    # 25 candidates -> batch3 has 5
    C.mark_batch(st, 2, "reviewed", N2)
    b3 = C.assign_next_batch(st, cands, N2)
    check(len(b3["noteIds"]) == 5, "batch 3 has remaining 5")


def test_assign_skips_already_resolved_candidates():
    st = C.fresh_state("claude", "cid", NOW)
    # pre-resolved (e.g. already-done from a prior spike) should not be batched
    C.add_note(st, "predone", "t", "normal", NOW)
    for s in ("fetched", "downloaded", "analyzed"):
        C.mark_stage(st, "predone", s, True, NOW)
    C.set_judgment(st, "predone", False, NOW)
    b = C.assign_next_batch(st, ["predone", "fresh1", "fresh2"], NOW)
    check("predone" not in b["noteIds"], "already-resolved candidate skipped in batching")
    check(b["noteIds"] == ["fresh1", "fresh2"], "only fresh candidates batched")


def test_batch_unfinished_for_resume():
    st = C.fresh_state("claude", "cid", NOW)
    C.assign_next_batch(st, ["a", "b", "c"], NOW)
    for s in ("fetched", "downloaded", "analyzed"):
        C.mark_stage(st, "a", s, True, NOW) if "a" in st["notes"] else None
    # 'a' not registered as note yet (assign doesn't auto-add) -> unfinished = all 3
    unf = C.batch_unfinished_notes(st, 1)
    check(unf == ["a", "b", "c"], "all unregistered batch notes are unfinished")
    # register + complete 'a'
    C.add_note(st, "a", "t", "normal", NOW)
    for s in ("fetched", "downloaded", "analyzed"):
        C.mark_stage(st, "a", s, True, NOW)
    C.set_judgment(st, "a", False, NOW)
    unf2 = C.batch_unfinished_notes(st, 1)
    check("a" not in unf2 and set(unf2) == {"b", "c"}, "completed note drops out of unfinished")


def test_corrupt_state_backs_up_and_returns_none():
    """F3 (QA FLY-372): a truncated/garbage checkpoint must not crash the runner. load_state
    backs it up to .corrupt and returns None so the orchestrator starts fresh."""
    d = tempfile.mkdtemp()
    p = os.path.join(d, "state.json")
    with open(p, "w", encoding="utf-8") as f:
        f.write('{"schemaVersion": 1, "notes": {trunc')  # invalid JSON
    got = C.load_state(p)
    check(got is None, "corrupt checkpoint → None (fresh start, no crash)")
    check(os.path.exists(p + ".corrupt"), "corrupt checkpoint preserved as .corrupt for forensics")
    check(not os.path.exists(p), "corrupt original moved aside (not left to re-fail next run)")


def test_missing_state_returns_none():
    check(C.load_state("/tmp/does-not-exist-fly349.json") is None, "missing checkpoint → None")


for fn in list(globals().values()):
    if callable(fn) and getattr(fn, "__name__", "").startswith("test_"):
        fn()
print(f"✅ ALL CHECKPOINT TESTS PASSED ({ok} assertions)")
