#!/usr/bin/env python3
"""Read-only event census. No production copies or mutations; IDs, codes only.

Fresh mode freezes [now-14d, now) and max event ID in a read transaction.
Replay mode (default when raw exists) derives byte-stable counts from saved rows.
Counts distinct Codex executions with recovery-failure evidence, not restarts.
"""
import collections
import csv
import datetime as dt
import hashlib
import json
import pathlib
import sqlite3
import sys

HERE = pathlib.Path(__file__).resolve().parent
RAW = HERE / "reown-events.json"
if not RAW.exists() or "--refresh" in sys.argv:
    end = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    start = end - dt.timedelta(days=14)
    db = sqlite3.connect("file:" + str(pathlib.Path.home() / ".flywheel/teamlead.db") + "?mode=ro", uri=True)
    db.execute("PRAGMA query_only=ON")
    db.execute("BEGIN")
    ceiling = db.execute("SELECT max(id) FROM session_events").fetchone()[0]
    kinds = ("reown_revive_failed", "reown_turn_reconcile_failed", "session_failed")
    sql = """SELECT e.id,e.ts,e.execution_id,e.event_type,e.payload,r.run_id,r.node_id,
                    s.issue_identifier
             FROM session_events e
             JOIN workflow_execution_runtime r ON r.execution_id=e.execution_id
             LEFT JOIN sessions s ON s.execution_id=e.execution_id
             WHERE e.event_type=? AND e.ts>=? AND e.ts<?
               AND julianday(e.ts)>=julianday(?) AND julianday(e.ts)<julianday(?)
               AND e.id<=? AND r.vendor='codex'
             ORDER BY e.id"""
    rows = []
    def reason_code(payload):
        text = json.dumps(payload, ensure_ascii=False).lower()
        for needle, code in [
            ("active_turn_mismatch", "active_turn_mismatch"),
            ("turn reconciliation failed", "turn_reconciliation_failed"),
            ("keyed_home_reown_arm_mismatch", "home_arm_mismatch"),
            ("launch_snapshot_mismatch", "launch_snapshot_mismatch"),
            ("recovery owner failed after commit", "post_commit_unspecified"),
            ("owner_failed_unknown", "owner_failure_unspecified"),
            ("reown_exhausted", "exhausted_unspecified"),
            ("recovery exhausted", "exhausted_unspecified"),
        ]:
            if needle in text:
                return code
        return "unclassified"
    for kind in kinds:
        bounds = (kind, start.strftime("%Y-%m-%d"), (end + dt.timedelta(days=1)).strftime("%Y-%m-%d"), start.isoformat(), end.isoformat(), ceiling)
        for eid, ts, execution, event_type, raw, run, node, issue in db.execute(sql, bounds):
            try:
                payload = json.loads(raw or "{}")
            except ValueError:
                payload = {}
            code = reason_code(payload)
            if kind == "session_failed" and code == "unclassified":
                continue
            rows.append(dict(event_id=eid, timestamp=ts, execution_id=execution, event_type=event_type, reason_code=code, run_id=run, node_id=node, issue=issue))
    db.rollback()
    db.close()
    rows.sort(key=lambda row: row["event_id"])
    RAW.write_text(json.dumps(dict(start=start.isoformat(), end=end.isoformat(), max_session_event_id=ceiling, events=rows), ensure_ascii=False, indent=2) + "\n")

data = json.loads(RAW.read_text())
grouped = collections.defaultdict(list)
for row in data["events"]:
    grouped[row["execution_id"]].append(row)
# Prefer specific mechanical evidence; one primary bucket per execution.
priority = ["active_turn_mismatch", "turn_reconciliation_failed", "home_arm_mismatch", "launch_snapshot_mismatch", "post_commit_unspecified", "owner_failure_unspecified", "exhausted_unspecified", "unclassified"]
incidents = []
for execution, rows in sorted(grouped.items()):
    cause = min((r["reason_code"] for r in rows), key=priority.index)
    proof = next(r for r in rows if r["reason_code"] == cause)
    incidents.append(dict(execution_id=execution, issue=proof["issue"], run_id=proof["run_id"], node_id=proof["node_id"], first_seen=rows[0]["timestamp"], cause=cause, proof_event_id=proof["event_id"], event_count=len(rows)))
with (HERE / "reown-incidents.csv").open("w") as f:
    writer = csv.DictWriter(f, fieldnames=list(incidents[0]) if incidents else ["execution_id"])
    writer.writeheader()
    writer.writerows(incidents)
summary = dict(start=data["start"], end=data["end"], max_session_event_id=data["max_session_event_id"], raw_sha256=hashlib.sha256(RAW.read_bytes()).hexdigest(), failure_event_rows=len(data["events"]), affected_executions=len(incidents), issues=len(set(r["issue"] for r in incidents)), cause_counts=dict(collections.Counter(r["cause"] for r in incidents)), limitations=["Failure evidence only; no restart denominator or causal attribution to a specific Bridge restart.", "Specific event codes override generic terminal summaries. Multiple different failure reasons on one execution count once by documented priority.", "This event-window census includes older executions; it differs from FLY-2893's creation-window cohort.", "Structured codes do not prove root cause. Unspecified failures remain unspecified."])
failed_ids = {r["execution_id"] for r in data["events"] if r["event_type"] == "session_failed"}
summary["executions_with_recovery_session_failed"] = len(failed_ids)
summary["terminal_failure_cause_counts"] = dict(collections.Counter(r["cause"] for r in incidents if r["execution_id"] in failed_ids))
summary["executions_without_recovery_session_failed"] = len(incidents) - len(failed_ids)
summary["limitations"].append("No matching session_failed does not prove recovery succeeded; an execution may remain held or fail under another code.")
assert sum(summary["cause_counts"].values()) == len(incidents)
(HERE / "reown-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(summary, ensure_ascii=False, indent=2))
