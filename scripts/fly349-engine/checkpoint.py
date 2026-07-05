#!/usr/bin/env python3
"""FLY-349 v2 deep-scan engine — durable checkpoint state machine.

Per-note progress is persisted to a JSON state file (atomic temp+rename, 0600) so a
cutover/Bridge-restart that kills the runner can be resumed by a fresh runner: it
reads the state, skips done notes, and continues. Batching is 10-notes-per-batch
(Annie's review cadence) with per-batch status (pending→running→reported→reviewed).

Pure logic + fs; no MCP/network here (the orchestrator wires fetch/analyze around it).
"""
from __future__ import annotations
import json, os, tempfile
from typing import Iterable

SCHEMA = 1
STAGES = ("fetched", "downloaded", "analyzed", "judged", "issue", "attached")
# A note is "done" once these terminal-meaningful stages are satisfied. issue/attached
# are conditional (only if judged useful) — see note_done().
TERMINAL_STATUSES = ("done", "degraded", "skipped", "failed")


def fresh_state(collection: str, collection_id: str, now: str) -> dict:
    return {
        "schemaVersion": SCHEMA,
        "collection": collection,
        "collectionId": collection_id,
        "createdAt": now,
        "batchSize": 10,
        "notes": {},      # noteId -> note record
        "batches": {},    # batchNo(str) -> {noteIds, status, reportPath, ...}
        "cursor": {"nextBatch": 1},
    }


def load_state(path: str) -> dict | None:
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError, ValueError):
        # F3 (QA): corrupt checkpoint → back it up + start fresh, don't crash the runner.
        try:
            os.replace(path, path + ".corrupt")
        except OSError:
            pass
        return None


def save_state(state: dict, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)  # atomic
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _note(state: dict, note_id: str) -> dict:
    return state["notes"][note_id]


def add_note(state: dict, note_id: str, title: str, ntype: str, now: str) -> dict:
    """Register a note (idempotent — existing record kept so resume preserves progress)."""
    if note_id not in state["notes"]:
        state["notes"][note_id] = {
            "noteId": note_id, "title": title, "type": ntype,
            "batch": None,
            "stages": {s: False for s in STAGES},
            "issueId": None,
            "useful": None,          # judge result; None until judged
            "status": "pending",
            "attempts": 0,           # processing attempts (retry cap → terminal 'failed')
            "updatedAt": now,
        }
    return state["notes"][note_id]


def bump_attempt(state: dict, note_id: str, now: str) -> int:
    n = _note(state, note_id)
    n["attempts"] = n.get("attempts", 0) + 1
    n["updatedAt"] = now
    return n["attempts"]


def mark_stage(state: dict, note_id: str, stage: str, value, now: str) -> None:
    if stage not in STAGES:
        raise ValueError(f"unknown stage {stage}")
    n = _note(state, note_id)
    if stage == "issue":
        n["issueId"] = value or None
        n["stages"]["issue"] = bool(value)
    else:
        n["stages"][stage] = bool(value)
    n["updatedAt"] = now


def set_judgment(state: dict, note_id: str, useful: bool, now: str) -> None:
    n = _note(state, note_id)
    n["useful"] = bool(useful)
    n["stages"]["judged"] = True
    n["updatedAt"] = now


def set_status(state: dict, note_id: str, status: str, now: str) -> None:
    _note(state, note_id)["status"] = status
    _note(state, note_id)["updatedAt"] = now


def note_done(state: dict, note_id: str) -> bool:
    """A note is complete when fetched+downloaded+analyzed+judged are done AND, if it was
    judged useful, an issue exists + retention attached. Not-useful notes need no issue."""
    n = _note(state, note_id)
    st = n["stages"]
    base = st["fetched"] and st["downloaded"] and st["analyzed"] and st["judged"]
    if not base:
        return False
    if n.get("useful"):
        return st["issue"] and st["attached"]
    return True  # not-useful (or degraded-but-judged): no issue needed


def is_resolved(state: dict, note_id: str) -> bool:
    """Skip on resume: terminal status OR fully done."""
    if note_id not in state["notes"]:
        return False
    n = state["notes"][note_id]
    return n["status"] in TERMINAL_STATUSES or note_done(state, note_id)


def assign_next_batch(state: dict, candidate_ids: Iterable[str], now: str) -> dict:
    """Pick up to batchSize unresolved+unassigned candidates → a new batch.
    Returns the batch record. Idempotent-ish: a candidate already assigned to a batch
    isn't reassigned; an unfinished current batch is returned as-is (resume)."""
    size = state.get("batchSize", 10)
    # Resume: if the latest batch isn't 'reviewed', keep working it (don't open a new one).
    cur = state["cursor"]["nextBatch"]
    existing = state["batches"].get(str(cur - 1)) if cur > 1 else None
    if existing and existing.get("status") not in ("reviewed",):
        return existing
    assigned = {nid for b in state["batches"].values() for nid in b["noteIds"]}
    picked = []
    for cid in candidate_ids:
        if cid in assigned:
            continue
        if cid in state["notes"] and is_resolved(state, cid):
            continue
        picked.append(cid)
        if len(picked) >= size:
            break
    if not picked:
        return {"batchNo": cur, "noteIds": [], "status": "empty"}
    batch = {"batchNo": cur, "noteIds": picked, "status": "pending",
             "reportPath": None, "startedAt": now, "reportedAt": None}
    state["batches"][str(cur)] = batch
    for nid in picked:
        if nid in state["notes"]:
            state["notes"][nid]["batch"] = cur
    state["cursor"]["nextBatch"] = cur + 1
    return batch


def batch_unfinished_notes(state: dict, batch_no: int) -> list[str]:
    """Notes in a batch still needing work (for resume within a batch)."""
    b = state["batches"].get(str(batch_no))
    if not b:
        return []
    return [nid for nid in b["noteIds"] if not is_resolved(state, nid)]


def mark_batch(state: dict, batch_no: int, status: str, now: str, report_path: str | None = None) -> None:
    b = state["batches"][str(batch_no)]
    b["status"] = status
    if status == "reported":
        b["reportedAt"] = now
        if report_path:
            b["reportPath"] = report_path
