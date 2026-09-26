#!/usr/bin/env python3
"""FLY-2889 read-only collector.

Opens production SQLite stores strictly read-only (mode=ro URI) and exports the
filtered rows the report needs into ../data/raw/*.csv. Never exports message
bodies, tokens, credentials or free-text rationale; only ids, enums, models,
counts and timestamps.

Usage: python3 collect.py [--t1 ISO]   (T1 = data freeze; default: now UTC)
"""
import csv
import datetime as dt
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "raw")
TEAMLEAD_DB = os.path.expanduser("~/.flywheel/teamlead.db")
COMM_ROOT = os.path.expanduser("~/.flywheel/comm")

# First design_model_arm_assigned event in production (split start).
W0 = "2026-09-08T19:18:20Z"
NODES = ("eng_design", "implement", "qa", "general")
NOISE_KINDS = (
    "execution_dead_rolled_back",
    "resume_target_unrecoverable",
    "writer_replacement",
    "repeated_dead_execution_pattern",
    "rework_replacement_launched",
    "rework_pane_loss_handoff",
    "run_terminated_by_operator",
    "run_terminated",
    "unlaunched_admission_rolled_back",
)
BLOCKING_CHECKPOINTS = ("question", "founder_review", "approve_to_ship")


def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=60)


def sql_ts(iso):
    """ISO Z -> both comparable forms used in the DB."""
    return iso.replace("T", " ").replace("Z", "")[:19], iso


def dump(name, header, rows):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f"{name}.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        n = 0
        for r in rows:
            w.writerow(r)
            n += 1
    print(f"{name}: {n}")


def main():
    t1 = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if "--t1" in sys.argv:
        t1 = sys.argv[sys.argv.index("--t1") + 1]
    w0_sql, w0_iso = sql_ts(W0)
    t1_sql, t1_iso = sql_ts(t1)
    c = ro(TEAMLEAD_DB)
    c.isolation_level = None
    c.execute("BEGIN")  # one read snapshot for every teamlead.db query below
    q = lambda s, *a: c.execute(s, a)

    # Executions of the measured nodes created inside [W0, T1).
    ex_rows = list(q(
        f"""SELECT r.execution_id, r.run_id, r.node_id, r.attempt, r.vendor, r.model,
                   r.effort, r.created_at
            FROM workflow_execution_runtime r
            WHERE r.node_id IN ({','.join('?' * len(NODES))})
              AND r.created_at >= ? AND r.created_at < ?""",
        *NODES, w0_iso, t1_iso))
    dump("executions", ["execution_id", "run_id", "node_id", "attempt", "vendor",
                        "model", "effort", "created_at"], ex_rows)
    run_ids = sorted({r[1] for r in ex_rows})
    exec_ids = sorted({r[0] for r in ex_rows})
    c.execute("CREATE TEMP TABLE sel_run(run_id TEXT PRIMARY KEY)")
    c.executemany("INSERT INTO sel_run VALUES (?)", [(r,) for r in run_ids])
    c.execute("CREATE TEMP TABLE sel_exec(execution_id TEXT PRIMARY KEY)")
    c.executemany("INSERT INTO sel_exec VALUES (?)", [(e,) for e in exec_ids])

    run_rows = []
    for r in q("""SELECT w.run_id, w.issue_id, w.project_name, w.template_id, w.status,
                         w.created_at, w.selection_source, w.snapshot
                  FROM workflow_run w JOIN sel_run USING(run_id)"""):
        snap = json.loads(r[7] or "{}")
        routing = snap.get("modelRouting") or {}
        reason = (routing.get("selectionOverride") or {}).get("reason")
        # enum-like reason only (e.g. "automatic_model_split", "menu_api_override; ...")
        run_rows.append(tuple(r[:7]) + ("none" if not routing else (reason or "unknown"),))
    dump("runs", ["run_id", "issue_id", "project_name", "template_id", "status",
                  "created_at", "selection_source", "routing_reason"], run_rows)

    # Arm assignments (new + legacy design rule); only structural fields.
    arm_rows = []
    for run_id, node_id, kind, payload, at in q(
            """SELECT e.run_id, e.node_id, e.kind, e.payload, e.at
               FROM workflow_run_event e JOIN sel_run USING(run_id)
               WHERE e.kind IN ('model_arm_assigned','design_model_arm_assigned')"""):
        p = json.loads(payload or "{}")
        basis = p.get("basis") or {}
        arm_rows.append((run_id, node_id, kind, p.get("arm"), p.get("model"),
                         p.get("modelAlias"), p.get("policyVersion") or basis.get("ruleVersion"),
                         basis.get("rule"), basis.get("codexPercent"), at))
    dump("arms", ["run_id", "node_id", "kind", "arm", "model", "model_alias",
                  "policy_version", "rule", "codex_percent", "at"], arm_rows)

    dump("bindings", ["activation_id", "execution_id", "run_id", "node_id", "attempt",
                      "mode", "bound_at"],
         q("""SELECT b.activation_id, b.execution_id, b.run_id, b.node_id, b.attempt,
                     b.mode, b.bound_at
              FROM workflow_execution_binding b JOIN sel_run USING(run_id)"""))

    dump("completions", ["run_id", "node_id", "attempt", "execution_id", "route",
                         "completed_at"],
         q("""SELECT n.run_id, n.node_id, n.attempt, n.execution_id, n.route, n.completed_at
              FROM workflow_node_completion n JOIN sel_run USING(run_id)"""))

    dump("claims", ["run_id", "node_id", "attempt", "predicate", "issuer_kind",
                    "issuer_execution_id", "issuer_vendor", "issuer_model",
                    "subject_producer_execution_id", "issued_at", "server_seq",
                    "subject_kind", "subject_digest"],
         q("""SELECT cl.workflow_run_id, cl.node_id, cl.attempt, cl.predicate, cl.issuer_kind,
                     cl.issuer_execution_id, cl.issuer_vendor, cl.issuer_model,
                     cl.subject_producer_execution_id, cl.issued_at, cl.server_seq,
                     cl.subject_kind, cl.subject_digest
              FROM workflow_claims cl JOIN sel_run s ON s.run_id = cl.workflow_run_id"""))

    dump("review_jobs", ["request_id", "execution_id", "review_type", "round", "status",
                         "verdict", "author_family", "same_family_sanction", "created_at",
                         "responded_at"],
         q("""SELECT j.request_id, j.execution_id, j.review_type, j.round, j.status,
                     j.verdict, j.author_family, j.same_family_sanction IS NOT NULL,
                     j.created_at, j.responded_at
              FROM codex_review_job j JOIN sel_exec USING(execution_id)"""))

    dump("review_records", ["execution_id", "status", "rounds", "author_family",
                            "reviewer_family", "same_family_sanction", "created_at",
                            "approved_at"],
         q("""SELECT x.execution_id, x.status, x.rounds, x.author_family, x.reviewer_family,
                     x.same_family_sanction IS NOT NULL, x.created_at, x.approved_at
              FROM codex_review_record x JOIN sel_exec USING(execution_id)"""))

    routed = []
    for run_id, ex, payload, at in q(
            """SELECT e.run_id, e.execution_id, e.payload, e.at FROM workflow_run_event e
               JOIN sel_run USING(run_id) WHERE e.kind='review_model_routed'"""):
        p = json.loads(payload or "{}")
        routed.append((run_id, ex, p.get("reviewType"), p.get("authorModel"),
                       p.get("reviewerVendor"), p.get("reviewerModel"),
                       p.get("reviewerEffort"), at))
    dump("review_routed", ["run_id", "execution_id", "review_type", "author_model",
                           "reviewer_vendor", "reviewer_model", "reviewer_effort", "at"], routed)

    dump("design_manifests", ["execution_id", "revision", "created_at"],
         q("""SELECT m.execution_id, m.revision, m.created_at
              FROM design_review_manifest m JOIN sel_exec USING(execution_id)"""))

    dump("rework_requests", ["request_id", "run_id", "authority", "source_node_id",
                             "source_attempt", "requested_at"],
         q("""SELECT r.request_id, r.run_id, r.authority, r.source_node_id, r.source_attempt,
                     r.requested_at
              FROM workflow_rework_request r JOIN sel_run USING(run_id)"""))

    dump("founder_verdicts", ["run_id", "gate_node_id", "attempt", "verdict",
                              "founder_authored", "head_sha", "recorded_at"],
         q("""SELECT v.run_id, v.gate_node_id, v.attempt, v.verdict, v.founder_authored,
                     v.head_sha, v.recorded_at
              FROM workflow_founder_gate_verdict v JOIN sel_run USING(run_id)"""))

    dump("gate_holders", ["run_id", "gate_node_id", "attempt", "state", "created_at",
                          "updated_at"],
         q("""SELECT g.run_id, g.gate_node_id, g.attempt, g.state, g.created_at, g.updated_at
              FROM workflow_gate_holder g JOIN sel_run USING(run_id)"""))

    dump("run_events", ["run_id", "seq", "kind", "node_id", "execution_id", "at"],
         q(f"""SELECT e.run_id, e.seq, e.kind, e.node_id, e.execution_id, e.at
               FROM workflow_run_event e JOIN sel_run USING(run_id)
               WHERE e.kind IN ({','.join('?' * len(NOISE_KINDS))},
                                'run_completed','node_completed','execution_admitted',
                                'qa_same_family_exemption_applied','gate_opened')""",
           *NOISE_KINDS))

    # FLY-2789 scorecard per-execution totals (normalized_delta), used only to
    # validate the raw transcript/rollout backfill in usage.py.
    import hashlib
    h = lambda v: hashlib.sha1((v or "").encode()).hexdigest()[:12]
    dump("scorecard_exec_totals", ["execution_id", "vendor", "usage_rows", "normalized_delta"],
         q("""SELECT t.execution_id, u.vendor, COUNT(*), SUM(u.normalized_delta)
              FROM workflow_scorecard_usage u
              JOIN workflow_scorecard_turn t
                ON t.vendor=u.vendor AND t.native_session_id=u.native_session_id
               AND t.native_turn_id=u.native_turn_id
              JOIN sel_exec s ON s.execution_id=t.execution_id
              GROUP BY 1,2"""))

    dump("scorecard_cursor", ["execution_id", "vendor", "session", "coverage", "error"],
         [(r[0], r[1], h(r[2]), r[3], r[4] is not None) for r in q(
             """SELECT k.execution_id, k.vendor, k.native_session_id, k.coverage, k.error
                FROM workflow_scorecard_cursor k JOIN sel_exec USING(execution_id)""")])

    dump("scorecard_activation", ["activation_id", "execution_id", "run_id", "node_id",
                                  "attempt", "axis", "assignment_state", "arm_id",
                                  "admitted_at", "closed_at", "close_kind"],
         q("""SELECT a.activation_id, a.execution_id, a.run_id, a.node_id, a.attempt, a.axis,
                     a.assignment_state, a.arm_id, a.admitted_at, a.closed_at, a.close_kind
              FROM workflow_scorecard_activation a JOIN sel_exec USING(execution_id)"""))

    dump("sessions", ["execution_id", "project_name", "worktree_path_present", "started_at",
                      "status"],
         q("""SELECT s.execution_id, s.project_name, s.worktree_path IS NOT NULL, s.started_at,
                     s.status
              FROM sessions s JOIN sel_exec USING(execution_id)"""))

    # Codex pool exhaustion / quota incidents (time windows only).
    cols = [r[1] for r in c.execute("PRAGMA table_info(codex_quota_incident)")]
    keep = [k for k in ("incident_id", "kind", "reason", "state", "status", "opened_at",
                        "created_at", "resolved_at", "closed_at", "updated_at") if k in cols]
    dump("codex_quota_incidents", keep,
         q(f"SELECT {','.join(keep)} FROM codex_quota_incident") if keep else [])
    for t in ("codex_quota_execution_pause", "codex_quota_admission_wait"):
        dump(t + "_count", ["rows"], [(c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0],)])

    # CommDB blocking questions from these executions (no content).
    qrows = []
    by_proj = {}
    for (e, proj) in c.execute("""SELECT r.execution_id, w.project_name
                                  FROM workflow_execution_runtime r
                                  JOIN sel_exec USING(execution_id)
                                  JOIN workflow_run w ON w.run_id=r.run_id"""):
        by_proj.setdefault(proj, set()).add(e)
    for proj, execs in by_proj.items():
        path = os.path.join(COMM_ROOT, proj, "comm.db")
        if not os.path.exists(path):
            print(f"commdb missing for {proj}")
            continue
        cc = ro(path)
        cc.execute("CREATE TEMP TABLE sel_exec(execution_id TEXT PRIMARY KEY)")
        cc.executemany("INSERT INTO sel_exec VALUES (?)", [(x,) for x in execs])
        for row in cc.execute(
                f"""SELECT m.id, m.from_agent, m.checkpoint, m.created_at, m.resolved_at,
                           (SELECT MIN(r.created_at) FROM mailbox r
                             WHERE r.type='response' AND r.ref_id=m.id AND r.created_at < ?)
                    FROM mailbox m JOIN sel_exec s ON s.execution_id=m.from_agent
                    WHERE m.type='question' AND m.created_at < ?""", (t1_iso, t1_iso)):
            qrows.append((proj,) + tuple(row))
    dump("questions", ["project", "question_id", "execution_id", "checkpoint", "created_at",
                       "resolved_at", "first_response_at"], qrows)

    with open(os.path.join(OUT, "..", "freeze.json"), "w") as fh:
        json.dump({"w0": W0, "t1": t1, "collected_at": dt.datetime.now(
            dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}, fh, indent=2)


if __name__ == "__main__":
    main()
