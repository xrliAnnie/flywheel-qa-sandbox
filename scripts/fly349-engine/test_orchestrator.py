#!/usr/bin/env python3
"""Dry-run tests for the FLY-349 orchestrator batch loop (mock I/O). Run: python3 test_orchestrator.py"""
import checkpoint as C, load_gate as LG
from orchestrator import run_batch
ok = 0
_t = [0]
def now():
    _t[0] += 1
    return f"2026-06-20T00:00:{_t[0]:02d}Z"
def check(c, m):
    global ok
    assert c, "FAIL: " + m
    ok += 1


class MockIO:
    class LoginLost(Exception): pass
    def __init__(self, notes, existing=None, load1=3.0, fail_ids=None, login_lost_ids=None, not_useful=None):
        self._notes = notes; self._existing = existing or []; self._load1 = load1
        self._fail = set(fail_ids or []); self._login_lost = set(login_lost_ids or [])
        self._not_useful = set(not_useful or [])
        self.created = []; self.attached = []; self.reports = 0; self.saves = 0
    def enumerate_notes(self): return self._notes
    def existing_issues(self): return self._existing
    def load1(self): return self._load1
    def save(self, state): self.saves += 1
    def fetch(self, m):
        if m["id"] in self._login_lost: raise self.LoginLost("session dropped")
    def download(self, m):
        if m["id"] in self._fail: raise RuntimeError("yt-dlp flaky")
    def analyze(self, m, gate): pass
    def judge(self, m): return m["id"] not in self._not_useful
    def create_issue(self, m): iid = f"FLY-{900+len(self.created)}"; self.created.append((m['id'], iid)); return iid
    def attach_retention(self, m, iid): self.attached.append((m["id"], iid))
    def build_report(self, state, bn): self.reports += 1; return f"/tmp/report-batch{bn}.html"


def notes(n): return [{"id": f"6a{i:022d}", "tok": f"T{i}", "type": "video" if i % 2 else "normal", "title": f"note {i}"} for i in range(n)]


def test_happy_path_one_batch_pauses():
    st = C.fresh_state("claude", "cid", now())
    io = MockIO(notes(25))
    cfg = LG.GateConfig(cores=8, video_concurrency=2)
    b = run_batch(st, io, cfg, now, batch_size=10, log=lambda *_: None)
    check(b["batchNo"] == 1 and len(b["noteIds"]) == 10, "first batch = 10 notes")
    check(st["batches"]["1"]["status"] == "reported", "batch reported")
    check(io.reports == 1, "exactly one report built (one batch, then pause)")
    check(len(io.created) == 10 and len(io.attached) == 10, "10 useful → 10 issues + 10 retention")
    check(all(C.note_done(st, nid) for nid in b["noteIds"]), "all 10 notes done")
    # PAUSE: a second run_batch WITHOUT marking reviewed must NOT advance to batch 2
    b2 = run_batch(st, io, cfg, now, batch_size=10, log=lambda *_: None)
    check(b2["noteIds"] == b["noteIds"], "no auto-advance: returns same (reported, not reviewed) batch")
    check(io.reports == 1, "no new report until reviewed")


def test_review_then_next_batch():
    st = C.fresh_state("claude", "cid", now())
    io = MockIO(notes(25)); cfg = LG.GateConfig(cores=8)
    run_batch(st, io, cfg, now, log=lambda *_: None)
    C.mark_batch(st, 1, "reviewed", now())              # Annie reviewed
    b2 = run_batch(st, io, cfg, now, log=lambda *_: None)
    check(b2["batchNo"] == 2 and len(b2["noteIds"]) == 10, "after review, batch 2 = next 10")
    check(set(b2["noteIds"]).isdisjoint(st["batches"]["1"]["noteIds"]), "batch 2 disjoint from 1")


def test_dedupe_skips_covered():
    nn = notes(15)
    covered_issue = {"identifier": "FLY-352", "title": "x", "description": f"explore/{nn[0]['id']} explore/{nn[1]['id']}"}
    io = MockIO(nn, existing=[covered_issue]); st = C.fresh_state("claude", "cid", now())
    b = run_batch(st, io, LG.GateConfig(cores=8), now, log=lambda *_: None)
    check(nn[0]["id"] not in b["noteIds"] and nn[1]["id"] not in b["noteIds"], "covered notes not batched")
    check(len(b["noteIds"]) == 10, "batch still fills 10 from uncovered")


def test_not_useful_no_issue():
    nn = notes(3)
    io = MockIO(nn, not_useful=[nn[0]["id"]]); st = C.fresh_state("claude", "cid", now())
    run_batch(st, io, LG.GateConfig(cores=8), now, batch_size=3, log=lambda *_: None)
    check(nn[0]["id"] not in [c[0] for c in io.created], "not-useful note → no issue")
    check(C.note_done(st, nn[0]["id"]), "not-useful note still marked done")


def test_load_pause_checkpoints_and_stops():
    nn = notes(10)
    io = MockIO(nn, load1=40.0)  # ≥ absolute_pause 30 → pause immediately
    st = C.fresh_state("claude", "cid", now())
    b = run_batch(st, io, LG.GateConfig(cores=8), now, log=lambda *_: None)
    check(io.reports == 0, "no report when paused before any note done")
    check(st["batches"]["1"]["status"] == "running", "batch left running (not reported) on pause")
    check(not any(nid in st["notes"] and C.note_done(st, nid) for nid in b["noteIds"]), "no batch note completed under pause")
    check(len(io.created) == 0, "no issues created under pause")


def test_transient_failure_left_pending_then_resumes():
    nn = notes(3)
    io = MockIO(nn, fail_ids=[nn[1]["id"]])  # nn[1] download fails first run
    st = C.fresh_state("claude", "cid", now())
    run_batch(st, io, LG.GateConfig(cores=8), now, batch_size=3, log=lambda *_: None)
    check(st["notes"][nn[1]["id"]]["status"] == "pending", "transient-failed note left pending")
    check(C.note_done(st, nn[0]["id"]) and C.note_done(st, nn[2]["id"]), "other notes done despite one failing")
    # second run (failure cleared) resumes the pending note within the SAME unfinished batch
    io._fail = set()
    run_batch(st, io, LG.GateConfig(cores=8), now, batch_size=3, log=lambda *_: None)
    check(C.note_done(st, nn[1]["id"]), "pending note completes on retry")


def test_login_lost_raises_and_checkpoints():
    nn = notes(3)
    io = MockIO(nn, login_lost_ids=[nn[0]["id"]])
    st = C.fresh_state("claude", "cid", now())
    raised = False
    try:
        run_batch(st, io, LG.GateConfig(cores=8), now, batch_size=3, log=lambda *_: None)
    except MockIO.LoginLost:
        raised = True
    check(raised, "login-lost propagates (escalate/stop)")
    check(st["notes"][nn[0]["id"]]["status"] == "pending", "note left pending on login-lost (checkpointed)")


for fn in list(globals().values()):
    if callable(fn) and getattr(fn, "__name__", "").startswith("test_"):
        fn()
print(f"✅ ALL ORCHESTRATOR DRY-RUN TESTS PASSED ({ok} assertions)")
