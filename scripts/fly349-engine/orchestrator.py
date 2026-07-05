#!/usr/bin/env python3
"""FLY-349 v2 deep-scan engine — orchestrator (batch loop wiring the 3 cores + I/O).

Architecture (PR #292): serial producer (fetch+download) → bounded consumer (deep
multimodal read+extract) → single aggregator (judge→dedupe→create issue→retention→
review page). 10-notes-per-batch; per-batch report; PAUSE for Annie review (never
auto-advance to the next batch). Durable checkpoint after every stage → resumable
across cutover.

I/O is injected (the `IO` protocol) so the batch loop is dry-run testable with mocks;
the live wiring (run.py) plugs in the spike-proven implementations: fresh-session MCP
fetch, yt-dlp download, agy/Gemini-Pro deep read, Linear GraphQL create/comment.
"""
from __future__ import annotations
import checkpoint as C
import dedupe as D
import load_gate as LG


def run_batch(state, io, cfg, now_fn, *, batch_size=10, max_attempts=3, log=print):
    """Process exactly ONE batch end-to-end, then stop (pause for review).
    Returns the batch record (with status 'reported' or 'empty'). Idempotent/resumable:
    re-invoking after a crash resumes the unfinished batch from the checkpoint."""
    state["batchSize"] = batch_size

    # 1. enumerate candidates (newest-first) + dedupe against existing issues
    candidates = io.enumerate_notes()                      # [{id,tok,type,title}], serial MCP
    covered = D.covered_note_ids(io.existing_issues())     # Linear scan
    cand_ids = [n["id"] for n in candidates]
    by_id = {n["id"]: n for n in candidates}

    # 2. pick/resume the batch (assign_next_batch returns unfinished current batch on resume)
    batch = C.assign_next_batch(state, [c for c in cand_ids if D.should_create(c, covered) or c in state["notes"]], now_fn())
    if not batch["noteIds"]:
        log("no fresh notes to process (all covered/processed) — batch empty")
        return batch
    if batch.get("status") == "reported":
        # already done + reported; PAUSE semantics — do not re-process/re-report until reviewed
        log(f"batch {batch['batchNo']} already reported — awaiting Annie review (no re-process/advance)")
        return batch
    C.mark_batch(state, batch["batchNo"], "running", now_fn())
    io.save(state)

    # 3. per-note pipeline (resume-aware via checkpoint); load-gate before heavy work
    prev_action = "proceed"
    for nid in batch["noteIds"]:
        meta = by_id.get(nid) or {"id": nid, "type": "?", "title": "(meta unavailable)", "tok": None}
        C.add_note(state, nid, meta.get("title", ""), meta.get("type", "?"), now_fn())
        if C.is_resolved(state, nid):
            log(f"  {nid}: already resolved — skip (resume)"); continue

        gate = LG.decide(io.load1(), cfg, prev_action); prev_action = gate["action"]
        if gate["action"] == "pause":
            log(f"  ⏸ load gate PAUSE: {gate['reason']} — checkpoint + stop batch for re-check")
            io.save(state)
            return batch  # orchestrator caller sleeps + re-invokes; checkpoint preserves progress

        n = state["notes"][nid]
        if C.bump_attempt(state, nid, now_fn()) > max_attempts:
            C.set_status(state, nid, "failed", now_fn()); io.save(state)
            log(f"  ✗ {nid}: exceeded {max_attempts} attempts — mark failed (terminal), unblock batch")
            continue
        try:
            if not n["stages"]["fetched"]:
                io.fetch(meta); C.mark_stage(state, nid, "fetched", True, now_fn()); io.save(state)
            if not n["stages"]["downloaded"]:
                io.download(meta); C.mark_stage(state, nid, "downloaded", True, now_fn()); io.save(state)
            if not n["stages"]["analyzed"]:
                io.analyze(meta, gate); C.mark_stage(state, nid, "analyzed", True, now_fn()); io.save(state)
            if n["useful"] is None:
                useful = io.judge(meta); C.set_judgment(state, nid, useful, now_fn()); io.save(state)
            if state["notes"][nid]["useful"] and not n["stages"]["issue"]:
                iid = io.create_issue(meta)               # dedup already gated upstream
                C.mark_stage(state, nid, "issue", iid, now_fn()); io.save(state)
            if state["notes"][nid]["useful"] and not n["stages"]["attached"]:
                io.attach_retention(meta, state["notes"][nid]["issueId"]); C.mark_stage(state, nid, "attached", True, now_fn()); io.save(state)
            C.set_status(state, nid, "done" if C.note_done(state, nid) else "in_progress", now_fn()); io.save(state)
            log(f"  ✓ {nid}: {state['notes'][nid]['status']}")
        except io.LoginLost as e:                          # MCP login dropped / CAPTCHA
            C.set_status(state, nid, "pending", now_fn()); io.save(state)
            log(f"  🔴 login/CAPTCHA lost on {nid}: {e} — checkpoint + STOP, escalate")
            raise
        except Exception as e:                             # transient (timeout/flaky) → pending, next run retries
            C.set_status(state, nid, "pending", now_fn()); io.save(state)
            log(f"  ⚠ {nid} failed (transient): {e} — left pending for retry")

    # 4. only report when the batch is fully resolved; pending (transient) notes → retry next run
    unfinished = C.batch_unfinished_notes(state, batch["batchNo"])
    if unfinished:
        log(f"batch {batch['batchNo']}: {len(unfinished)} note(s) still pending (transient) — NOT reporting; retry next run")
        io.save(state)
        return batch  # stays 'running'; caller re-invokes to retry the pending notes
    # aggregate: build review page + report; PAUSE (do not advance)
    report_path = io.build_report(state, batch["batchNo"])
    C.mark_batch(state, batch["batchNo"], "reported", now_fn(), report_path)
    io.save(state)
    log(f"📋 batch {batch['batchNo']} reported → {report_path} — PAUSE for review (no auto-advance)")
    return batch
