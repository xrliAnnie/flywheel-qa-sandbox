#!/usr/bin/env python3
"""FLY-2893: read-only export of every carrier execution in the census window.

Opens ~/.flywheel/teamlead.db with mode=ro. Nothing is written anywhere except
../raw/*.csv and ../raw/freeze.json next to this script.

Freeze: the first run records max(workflow_run_event.id) and max(session_events.id)
in raw/freeze.json. Every later run reuses those ids, so a re-run exports the same
rows even while production keeps writing. Pass --refreeze to take a new snapshot.

Redaction: free-text fields are cut to 200 chars, $HOME is replaced with "~",
and anything shaped like an API key / bearer token is masked.
"""
import csv
import datetime as dt
import json
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "raw")
DB = os.path.expanduser("~/.flywheel/teamlead.db")
HOME = os.path.expanduser("~")

T1 = "2026-09-25T22:00:00Z"
T0 = "2026-09-11T22:00:00Z"

RUN_EVENT_KINDS = (
    "execution_dead_rolled_back",
    "writer_replacement",
    "rework_replacement",
    "rework_replacement_launched",
    "repeated_dead_execution_pattern",
    "retry_limit_escalated",
    "unlaunched_admission_rolled_back",
    "unlaunched_admission_alerted",
    "resume_target_unrecoverable",
    "run_terminated_by_operator",
    "run_terminated",
    "node_completed",
    "node_dispatched",
    "hold_resumed",
    "engine_land_conflict_resolution_requested",
    "engine_land_rework_requested",
    "rework_requested",
    "operator_rework_requested",
)
SESSION_EVENT_TYPES = (
    "session_started",
    "session_failed",
    "session_completed",
    "stage_changed",
    "lead_close_runner",
    "lead_close_runner_finalized",
    "state_transition",
    "reown_revive_failed",
    "reown_turn_reconcile_failed",
    "runner_pane_loss_detected",
    "codex_transport_death_snapshot",
    "tmux_closed",
)

SECRET = re.compile(r"(sk-[A-Za-z0-9_\-*]{6,}|Bearer\s+[A-Za-z0-9._\-]{10,}|eyJ[A-Za-z0-9._\-]{20,})")


def clean(text, limit=200):
    if text is None:
        return ""
    s = str(text).replace(HOME, "~")
    s = SECRET.sub("<redacted>", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


def ro():
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def dump(name, header, rows):
    path = os.path.join(RAW, name)
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(header)
        n = 0
        for r in rows:
            w.writerow(r)
            n += 1
    print(f"{name}: {n}")


def payload_fields(payload):
    """Keep only the structured fields the classifier reads; cut free text."""
    try:
        j = json.loads(payload or "{}")
    except ValueError:
        return clean(payload, 300)
    if not isinstance(j, dict):
        return clean(payload, 300)
    keep = {}
    for k in (
        "reason", "failureKind", "lastError", "retryDisposition", "newExecutionId",
        "deadExecutionId", "attempt", "targetAttempt", "launchOrdinal", "deathNumber",
        "maxLaunchOrdinal", "from", "to", "trigger", "fromStatus", "toStatus", "stage",
        "route", "closed", "alreadyGone", "requestId", "targetNodeId", "cause",
    ):
        if k in j:
            v = j[k]
            keep[k] = clean(v, 300) if isinstance(v, str) else v
    if isinstance(j.get("decision"), dict) and "route" in j["decision"]:
        keep["route"] = j["decision"]["route"]
    if isinstance(j.get("detail"), dict) and "cause" in j["detail"]:
        keep["cause"] = clean(j["detail"]["cause"], 120)
    return json.dumps(keep, ensure_ascii=False, sort_keys=True)


def main():
    os.makedirs(RAW, exist_ok=True)
    db = ro()
    freeze_path = os.path.join(RAW, "freeze.json")
    if os.path.exists(freeze_path) and "--refreeze" not in sys.argv:
        freeze = json.load(open(freeze_path))
    else:
        freeze = {
            "T0": T0,
            "T1": T1,
            "frozen_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "max_run_event_id": db.execute("select max(id) from workflow_run_event").fetchone()[0],
            "max_session_event_id": db.execute("select max(id) from session_events").fetchone()[0],
        }
        json.dump(freeze, open(freeze_path, "w"), indent=2)
    frozen_at = freeze["frozen_at"]
    mre, mse = freeze["max_run_event_id"], freeze["max_session_event_id"]

    # Executions: census window plus later successors (created up to the freeze).
    ex = db.execute(
        """select r.execution_id, r.run_id, r.node_id, r.attempt, r.vendor, r.model, r.effort,
                  r.created_at, w.issue_id, w.project_name, s.status, s.started_at, s.terminal_at,
                  s.session_stage, s.last_error
             from workflow_execution_runtime r
             join workflow_run w using(run_id)
             left join sessions s using(execution_id)
            where r.created_at >= ? and r.created_at <= ?
            order by r.created_at, r.execution_id""",
        (T0, frozen_at),
    ).fetchall()
    dump(
        "executions.csv",
        ["execution_id", "run_id", "node_id", "attempt", "vendor", "model", "effort", "created_at",
         "issue", "project", "in_window", "session_status", "started_at", "terminal_at",
         "session_stage", "last_error"],
        [
            (e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9],
             int(T0 <= e[7] < T1), e[10] or "", e[11] or "", e[12] or "", e[13] or "", clean(e[14]))
            for e in ex
        ],
    )
    ids = {e[0] for e in ex}
    runs = sorted({e[1] for e in ex})

    # Workflow runs touched by those executions.
    q = ",".join("?" * len(runs))
    dump(
        "runs.csv",
        ["run_id", "issue", "project", "status", "created_at", "current_node_id"],
        db.execute(
            f"select run_id, issue_id, project_name, status, created_at, current_node_id from workflow_run where run_id in ({q}) order by created_at",
            runs,
        ).fetchall(),
    )

    kinds = ",".join("?" * len(RUN_EVENT_KINDS))
    rows = db.execute(
        f"""select id, run_id, kind, node_id, execution_id, at, payload from workflow_run_event
             where id <= ? and kind in ({kinds}) and run_id in ({q}) order by id""",
        (mre, *RUN_EVENT_KINDS, *runs),
    ).fetchall()
    dump(
        "run_events.csv",
        ["id", "run_id", "kind", "node_id", "execution_id", "at", "payload"],
        [(r[0], r[1], r[2], r[3] or "", r[4] or "", r[5], payload_fields(r[6])) for r in rows],
    )

    types = ",".join("?" * len(SESSION_EVENT_TYPES))
    out = []
    for r in db.execute(
        f"""select id, execution_id, ts, event_type, source, payload from session_events
             where id <= ? and event_type in ({types}) and ts >= ? order by id""",
        (mse, *SESSION_EVENT_TYPES, T0.replace("T", " ").rstrip("Z")),
    ):
        if r[1] in ids:
            out.append((r[0], r[1], r[2], r[3], r[4], payload_fields(r[5])))
    dump("session_events.csv", ["id", "execution_id", "ts", "event_type", "source", "payload"], out)

    dump(
        "node_completions.csv",
        ["run_id", "node_id", "attempt", "execution_id", "route", "completed_at"],
        db.execute(
            f"select run_id, node_id, attempt, execution_id, route, completed_at from workflow_node_completion where run_id in ({q}) order by completed_at",
            runs,
        ).fetchall(),
    )

    dump(
        "review_jobs.csv",
        ["request_id", "execution_id", "issue", "review_type", "status", "failure_reason",
         "author_family", "created_at", "updated_at", "failure_attempt_count", "auto_retry_count",
         "failure_raw"],
        [
            (*r[:11], clean(r[11]))
            for r in db.execute(
                """select request_id, execution_id, issue_id, review_type, status, failure_reason,
                          author_family, created_at, updated_at, failure_attempt_count,
                          auto_retry_count, failure_raw
                     from codex_review_job where created_at >= ? and created_at < ? order by created_at""",
                (T0.replace("T", " ").rstrip("Z"), T1.replace("T", " ").rstrip("Z")),
            )
        ],
    )


if __name__ == "__main__":
    main()
