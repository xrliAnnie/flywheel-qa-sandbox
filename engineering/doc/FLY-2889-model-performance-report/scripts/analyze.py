#!/usr/bin/env python3
"""FLY-2889 analysis: ../data/raw/*.csv -> ../data/metrics.json + episodes.csv.

Unit = episode (run_id, node_id). Speed unit = (run_id, node_id, attempt).
Every ratio carries numerator/denominator; n < 5 is flagged "too_few".
"""
import csv
import datetime as dt
import json
import os
import statistics
from collections import Counter as Counter_, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data", "raw")
OUT = os.path.join(HERE, "..", "data")
NEW_RULE_START = "2026-09-24T23:15:43Z"  # first model_arm_assigned
SCORECARD_START = "2026-09-23T23:46:01Z"  # first workflow_scorecard_turn
# Blocking runner gates inside a node attempt. approve_to_ship is the workflow
# founder-gate card (outside node attempts); it is handled at delivery level via
# founder verdicts, never deducted from a node attempt.
BLOCKING = {"question", "founder_review"}
FAULT_KINDS = {"execution_dead_rolled_back", "resume_target_unrecoverable",
               "writer_replacement", "repeated_dead_execution_pattern",
               "rework_pane_loss_handoff", "unlaunched_admission_rolled_back"}
GAP_KINDS = {"execution_dead_rolled_back", "resume_target_unrecoverable",
             "rework_pane_loss_handoff"}
MIN_N = 5


def ts(v):
    if v in (None, "", "None"):
        return None
    v = v.strip().replace("Z", "")
    if "T" not in v:
        v = v.replace(" ", "T")
    return dt.datetime.fromisoformat(v[:26]).replace(tzinfo=dt.timezone.utc)


def load(name):
    return load_path(os.path.join(RAW, f"{name}.csv"))


def load_path(path):
    with open(path) as fh:
        return list(csv.DictReader(fh))


def mkey(e):
    return f"{e['vendor']}/{e['model']}/{e['effort']}"


def union_len(intervals, lo, hi):
    """Total seconds covered by intervals clipped to [lo, hi]."""
    clipped = sorted((max(a, lo), min(b, hi)) for a, b in intervals if b and a and b > lo and a < hi)
    total, cur_a, cur_b = 0.0, None, None
    for a, b in clipped:
        if cur_b is None or a > cur_b:
            if cur_b is not None:
                total += (cur_b - cur_a).total_seconds()
            cur_a, cur_b = a, b
        else:
            cur_b = max(cur_b, b)
    if cur_b is not None:
        total += (cur_b - cur_a).total_seconds()
    return total


def pct(values, p):
    """Nearest-rank percentile."""
    if not values:
        return None
    s = sorted(values)
    k = max(1, int(-(-p * len(s) // 100)))
    return s[k - 1]


def dist(values):
    values = [v for v in values if v is not None]
    out = {"n": len(values)}
    if not values:
        return out
    out["median"] = statistics.median(values)
    out["p90"] = pct(values, 90)
    if len(values) < MIN_N:
        out["too_few"] = True
        out["values"] = sorted(values)
    return out


def ratio(num, den, issues=None):
    """Episode-weighted ratio; the sample threshold uses independent issues."""
    base = den if issues is None else issues
    return {"num": num, "den": den, "issues": issues,
            "rate": (num / den) if den else None, "too_few": base < MIN_N}


def main():
    execs = {r["execution_id"]: r for r in load("executions")}
    runs = {r["run_id"]: r for r in load("runs")}
    arms = defaultdict(list)
    for r in load("arms"):
        arms[(r["run_id"], r["node_id"])].append(r)
    bindings = defaultdict(list)
    for r in load("bindings"):
        bindings[(r["run_id"], r["node_id"], int(r["attempt"]))].append(r)
    completions = {(r["run_id"], r["node_id"], int(r["attempt"])): r for r in load("completions")}
    claims = defaultdict(list)
    for r in load("claims"):
        claims[r["workflow_run_id"] if "workflow_run_id" in r else r["run_id"]].append(r)
    for v in claims.values():
        v.sort(key=lambda r: int(r["server_seq"]))
    cursor = defaultdict(list)
    for r in load("scorecard_cursor"):
        cursor[r["execution_id"]].append(r["coverage"])
    jobs = defaultdict(list)
    for r in load("review_jobs"):
        jobs[r["execution_id"]].append(r)
    records = defaultdict(list)
    for r in load("review_records"):
        records[r["execution_id"]].append(r)
    rework = defaultdict(list)
    for r in load("rework_requests"):
        rework[r["run_id"]].append(r)
    fverd = defaultdict(list)
    for r in load("founder_verdicts"):
        fverd[r["run_id"]].append(r)
    gates = defaultdict(list)
    for r in load("gate_holders"):
        gates[r["run_id"]].append(r)
    events = defaultdict(list)
    for r in load("run_events"):
        events[r["run_id"]].append(r)
    questions = defaultdict(list)
    for r in load("questions"):
        questions[r["execution_id"]].append(r)
    self_rounds = {}
    sr_path = os.path.join(RAW, "self_review_rounds.csv")
    if os.path.exists(sr_path):
        for r in load("self_review_rounds"):
            self_rounds[(r["execution_id"], r["review_type"])] = r

    freeze = json.load(open(os.path.join(OUT, "freeze.json")))
    t1 = ts(freeze["t1"])

    # ---- episodes -------------------------------------------------------
    ep_execs = defaultdict(list)
    for e in execs.values():
        ep_execs[(e["run_id"], e["node_id"])].append(e)
    episodes = {}
    for key, xs in ep_execs.items():
        run_id, node = key
        models = sorted({mkey(x) for x in xs})
        model = models[0] if len(models) == 1 else "mixed"
        first = min(ts(x["created_at"]) for x in xs)
        arm_rows = arms.get(key, [])
        arm = None
        segment = "O"
        arm_state = "none"
        if arm_rows:
            a = sorted(arm_rows, key=lambda r: r["kind"] != "model_arm_assigned")[0]
            arm = a["arm"]
            arm_model = a["model"]
            if model != "mixed" and model.split("/")[1] == arm_model:
                arm_state = "honored"
                if a["kind"] == "model_arm_assigned":
                    segment = "R_new"
                else:
                    pv = a["policy_version"].split(":")[0]
                    segment = "L:" + (pv + "(50/50)" if a["rule"] == "issue_number_parity"
                                      else f"{pv}(astra={a['codex_percent']}%)")
            else:
                arm_state = "not_honored"
        elif first >= ts(NEW_RULE_START) and node in ("eng_design", "implement", "qa"):
            arm_state = "no_arm_after_new_rule"
        evs = [ev for ev in events.get(run_id, []) if ev["node_id"] in (node, "")]
        fault = sorted({ev["kind"] for ev in evs if ev["kind"] in FAULT_KINDS
                        and (ev["execution_id"] in {x["execution_id"] for x in xs} or not ev["execution_id"])})
        noise = list(fault)
        if model == "mixed":
            noise.append("mixed_model")
        if arm_state == "not_honored":
            noise.append("arm_not_honored")
        if len(xs) > len({int(x["attempt"]) for x in xs}):
            noise.append("replacement_execution")
        rr = runs[run_id].get("routing_reason", "")
        if arm_rows:
            routing = "auto_arm"
        elif "menu_api_override" in rr:
            routing = "lead_menu_override"
        elif rr == "none":
            routing = "no_model_routing_snapshot"
        else:
            routing = "no_arm"
        episodes[key] = {
            "routing": routing,
            "run_id": run_id, "node": node, "issue": runs[run_id]["issue_id"],
            "project": runs[run_id]["project_name"], "template": runs[run_id]["template_id"],
            "run_status": runs[run_id]["status"], "model": model, "models": models,
            "execs": [x["execution_id"] for x in xs], "first": first, "arm": arm,
            "arm_state": arm_state, "segment": segment, "noise": sorted(set(noise)),
        }

    # First run of each (issue, node): later runs of the same issue often resume
    # work already on the branch and finish fast.
    first_of = {}
    for ep in episodes.values():
        k = (ep["issue"], ep["node"])
        if k not in first_of or ep["first"] < first_of[k]["first"]:
            first_of[k] = ep
    for ep in episodes.values():
        ep["first_run_for_issue"] = first_of[(ep["issue"], ep["node"])] is ep

    # ---- correctness ----------------------------------------------------
    def review_stats(ep, rtype):
        """Per-round facts only from Bridge jobs; runner self-reports kept separate."""
        out = {}
        done = sorted((j for x in ep["execs"] for j in jobs.get(x, [])
                       if j["review_type"] == rtype and j["status"] == "done"),
                      key=lambda j: (ts(j["created_at"]), j["request_id"]))
        if done:
            verdicts = [j["verdict"] for j in done]
            appr = "APPROVED" in verdicts
            fam = done[0]["author_family"] or "unknown"
            rev = ("same_family" if done[0]["same_family_sanction"] == "1" else "cross_family")
            out["bridge"] = {"first_approved": verdicts[0] == "APPROVED",
                             "rounds": verdicts.index("APPROVED") + 1 if appr else len(verdicts),
                             "approved": appr, "stratum": f"{fam}_author/{rev}"}
        if rtype == "code":
            recs = sorted((r for x in ep["execs"] for r in records.get(x, [])
                           if r["rounds"] not in ("", None)), key=lambda r: ts(r["created_at"]))
            if recs:
                r0 = recs[0]
                out["self_report"] = {
                    "rounds": int(r0["rounds"]),
                    "stratum": f"{r0['author_family']}_author/"
                               + ("same_family" if r0["same_family_sanction"] == "1" else
                                  "cross_family" if r0["author_family"] != r0["reviewer_family"]
                                  else "same_family")}
        return out

    for key, ep in episodes.items():
        run_id, node = key
        cl = claims.get(run_id, [])
        qa_claims = [c for c in cl if c["predicate"] in ("qa_passed", "qa_failed")]
        if node == "eng_design":
            ep["design_review"] = review_stats(ep, "design")
        if node == "implement":
            ep["code_review"] = review_stats(ep, "code")
            mine = [c for c in qa_claims if c["subject_producer_execution_id"] in ep["execs"]]
            if not mine:  # one implement episode per run; producer id may be absent
                mine = [c for c in qa_claims if not c["subject_producer_execution_id"]]
            ep["qa_first"] = None if not mine else mine[0]["predicate"] == "qa_passed"
            ep["qa_fail_count"] = len({c["subject_digest"] for c in mine
                                       if c["predicate"] == "qa_failed"})
            ep["reached_qa"] = bool(mine)
        if node == "qa":
            mine = [c for c in qa_claims if c["issuer_execution_id"] in ep["execs"]]
            fv = fverd.get(run_id, [])
            rw = rework.get(run_id, [])
            ep["qa_verdicts"] = []
            for c in mine:
                t = ts(c["issued_at"])
                nxt = [ts(o["issued_at"]) for o in qa_claims
                       if int(o["server_seq"]) > int(c["server_seq"])]
                horizon = min(nxt) if nxt else None
                within = lambda x: x > t and (horizon is None or x < horizon)
                head = c["subject_digest"] if c["subject_kind"] == "git_head" else None
                sig, reviewed = None, None
                if c["predicate"] == "qa_passed":
                    same = [v for v in fv if head and v["head_sha"] == head]
                    reviewed = bool(same)
                    if any(v["verdict"] == "rework" for v in same):
                        sig = "pass_then_founder_rework_same_head"
                    elif any(r["authority"] == "engine" and r["source_node_id"] == "land"
                             and within(ts(r["requested_at"])) for r in rw):
                        sig = "pass_then_land_rework"
                else:
                    if any(r["authority"] == "lead" and r["source_node_id"] == "qa"
                           and within(ts(r["requested_at"])) for r in rw) or \
                       any(v["verdict"] == "approved" and head and v["head_sha"] == head for v in fv):
                        sig = "fail_then_lead_override"
                ep["qa_verdicts"].append({"verdict": c["predicate"], "signal": sig,
                                          "reviewed_by_founder": reviewed})

    # ---- speed ----------------------------------------------------------
    attempts = []
    for (run_id, node, attempt), bs in bindings.items():
        key = (run_id, node)
        if key not in episodes:
            continue
        ep = episodes[key]
        start = min(ts(b["bound_at"]) for b in bs)
        if node == "qa":
            qc = [c for c in claims.get(run_id, []) if c["node_id"] == "qa"
                  and c["predicate"] in ("qa_passed", "qa_failed") and c["attempt"] == str(attempt)]
            end = ts(qc[0]["issued_at"]) if qc else None
        else:
            comp = completions.get((run_id, node, attempt))
            end = ts(comp["completed_at"]) if comp else None
        exec_ids = {b["execution_id"] for b in bs}
        a_models = sorted({mkey(execs[x]) for x in exec_ids if x in execs})
        rec = {"run_id": run_id, "node": node, "attempt": attempt, "start": start, "end": end,
               "model": a_models[0] if len(a_models) == 1 else "mixed",
               "segment": ep["segment"], "ep_noise": ep["noise"], "issue": ep["issue"],
               "first_run_for_issue": ep["first_run_for_issue"]}
        if end is None or end <= start:
            rec["completed"] = False
            attempts.append(rec)
            continue
        rec["completed"] = True
        wall = (end - start).total_seconds()
        q_int = []
        for x in exec_ids:
            for qq in questions.get(x, []):
                if qq["checkpoint"] in BLOCKING and ts(qq["created_at"]) >= start:
                    a = ts(qq["created_at"])
                    b = ts(qq["first_response_at"]) or ts(qq["resolved_at"]) or end
                    q_int.append((a, b))
        g_int = []
        fault_here = []
        for ev in events.get(run_id, []):
            if ev["node_id"] != node:
                continue
            t = ts(ev["at"])
            if not (start <= t <= end):
                continue
            if ev["kind"] in FAULT_KINDS:
                fault_here.append(ev["kind"])
            if ev["kind"] in GAP_KINDS:
                nxt = [ts(b["bound_at"]) for b in bs if ts(b["bound_at"]) > t]
                g_int.append((t, min(nxt) if nxt else end))
        q_s = union_len(q_int, start, end)
        g_s = union_len(g_int, start, end)
        both = union_len(q_int + g_int, start, end)
        rec.update({"wall_s": wall, "question_wait_s": q_s, "restart_gap_s": g_s,
                    "net_s": wall - both, "fault": sorted(set(fault_here)),
                    "n_exec": len(exec_ids)})
        rec["noisy"] = bool(fault_here) or len(exec_ids) > 1 or rec["model"] == "mixed"
        attempts.append(rec)

    # Delivery: run created -> run_completed, minus founder gate stay, question waits, gaps.
    deliveries = []
    for run_id, run in runs.items():
        done = [ev for ev in events.get(run_id, []) if ev["kind"] == "run_completed"]
        if not done:
            continue
        start, end = ts(run["created_at"]), ts(done[0]["at"])
        g = []
        undeducted = 0
        for h in gates.get(run_id, []):
            vs = [ts(v["recorded_at"]) for v in fverd.get(run_id, [])
                  if v["gate_node_id"] == h["gate_node_id"] and v["attempt"] == h["attempt"]
                  and ts(v["recorded_at"]) >= ts(h["created_at"])]
            if vs:
                g.append((ts(h["created_at"]), min(vs)))
            else:
                undeducted += 1
        qi = []
        for (r2, n2), ep in episodes.items():
            if r2 != run_id:
                continue
            for x in ep["execs"]:
                for qq in questions.get(x, []):
                    if qq["checkpoint"] in BLOCKING:
                        qi.append((ts(qq["created_at"]),
                                   ts(qq["first_response_at"]) or ts(qq["resolved_at"]) or end))
        gap = []
        for ev in events.get(run_id, []):
            if ev["kind"] in GAP_KINDS:
                t = ts(ev["at"])
                nxt = [ts(b["bound_at"]) for (r3, n3, a3), bs in bindings.items()
                       if r3 == run_id and n3 == ev["node_id"] for b in bs if ts(b["bound_at"]) > t]
                gap.append((t, min(nxt) if nxt else t))
        founder_s = union_len(g, start, end)
        net = (end - start).total_seconds() - union_len(g + qi + gap, start, end)
        impl = episodes.get((run_id, "implement"))
        des = episodes.get((run_id, "eng_design"))
        noisy = any(ep["noise"] for (r2, _), ep in episodes.items() if r2 == run_id)
        deliveries.append({"run_id": run_id, "issue": run["issue_id"], "template": run["template_id"],
                           "gate_segments_not_deducted": undeducted,
                           "wall_s": (end - start).total_seconds(), "founder_gate_s": founder_s,
                           "net_s": net, "impl_model": impl["model"] if impl else None,
                           "design_model": des["model"] if des else None,
                           "impl_segment": impl["segment"] if impl else None, "noisy": noisy})

    # ---- cost (raw transcript / rollout per execution; see usage.py) ------
    eu = {r["execution_id"]: r for r in load("exec_usage")}
    fps = []
    fp_path = os.path.join(OUT, "codex_quota_fingerprints.csv")
    accounts = [r for r in load_path(os.path.join(OUT, "quota_status.csv")) if r["vendor"] == "codex"]
    if os.path.exists(fp_path):
        for r in load_path(fp_path):
            if r["delta_pct"] in ("", "None") or float(r["delta_pct"]) < 5:
                continue
            fts = ts(r["fingerprint_resets_at_utc"])
            match = [a for a in accounts if a["weekly_reset_at"]
                     and abs((ts(a["weekly_reset_at"]) - fts).total_seconds()) <= 120]
            if len(match) == 1:
                r["account"], r["plan"] = match[0]["account"], match[0]["plan"]
                fps.append(r)
    metrics_quota = {"codex_fingerprints_used": fps}
    # Method validation: raw backfill vs FLY-2789 scorecard where its cursor is complete.
    sc_sum = {r["execution_id"]: int(r["normalized_delta"] or 0)
              for r in load("scorecard_exec_totals")}
    with open(os.path.join(OUT, "validation_scorecard_vs_raw.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["execution_id", "vendor", "raw_total", "scorecard_total", "diff"])
        n_eq = n_all = 0
        for x, total in sorted(sc_sum.items()):
            if cursor.get(x) and all(cv == "complete" for cv in cursor[x]) and x in eu \
                    and eu[x]["open_at_t1"] == "False" and not eu[x]["locate"].startswith("missing"):
                raw = int(eu[x]["total"])
                w.writerow([x, eu[x]["vendor"], raw, total, raw - total])
                n_all += 1
                n_eq += raw == total
    metrics_quota["validation"] = {"executions_compared": n_all, "exact_equal": n_eq}
    metrics_quota["locate_counts"] = dict(Counter_(r["vendor"] + ":" + r["locate"] for r in eu.values()))
    metrics_quota["codex_counter_resets_execs"] = sum(1 for r in eu.values() if int(r["resets"] or 0))
    metrics_quota["codex_counter_anomaly_execs"] = sum(1 for r in eu.values() if int(r["counter_anomalies"] or 0))
    pro = [r for r in fps if r["plan"] == "pro"]
    k_total = sorted(float(r["pct_per_100M_total_tokens"]) / 1e8 for r in pro)
    k_unc = sorted(float(r["pct_per_1M_uncached_plus_output"]) / 1e6 for r in pro)
    for key, ep in episodes.items():
        tot = defaultdict(int)
        missing = 0
        opened = False
        for x in ep["execs"]:
            r = eu.get(x)
            if not r or r["locate"].startswith("missing") or r["locate"] == "early_loose" \
                    or int(r["counter_anomalies"] or 0):
                missing += 1  # not located, candidate-only attribution, or counter anomaly
                continue
            opened |= r["open_at_t1"] == "True"
            for f in ("input", "output", "cache_read", "cache_write", "reasoning", "total",
                      "sub_total"):
                tot[f] += int(r[f] or 0)
        ep["cost_missing_execs"] = missing
        ep["cost_coverage"] = ("missing" if missing == len(ep["execs"]) else
                               "partial" if missing else "open" if opened else "files_located_all")
        ep["tokens"] = dict(tot)
        if ep["model"].startswith("codex/") and pro and ep["cost_coverage"] == "files_located_all":
            unc = tot["input"] + tot["output"]  # input here is already uncached
            ep["codex_pct_scenario"] = {
                "by_total": [tot["total"] * k_total[0], tot["total"] * k_total[-1]],
                "by_uncached": [unc * k_unc[0], unc * k_unc[-1]]}

    # ---- aggregate --------------------------------------------------------
    def issues_of(eps):
        return {e["issue"] for e in eps}

    def agg(filter_fn):
        out = defaultdict(lambda: defaultdict(dict))
        by = defaultdict(list)
        for ep in episodes.values():
            if filter_fn(ep):
                by[(ep["node"], ep["model"])].append(ep)
        for (node, model), eps in by.items():
            m = out[node][model]
            m["episodes"] = len(eps)
            m["issues"] = len(issues_of(eps))
            m["noise_reasons"] = dict(sorted(
                ((k, sum(1 for e in eps if k in e["noise"]))
                 for k in {n for e in eps for n in e["noise"]}), key=lambda kv: -kv[1]))
            m["noisy_episodes"] = sum(1 for e in eps if e["noise"])
            def review_block(prefix, field):
                rtype = "design" if prefix == "design" else "code"
                with_bridge = [e for e in eps if (e.get(field) or {}).get("bridge")]
                m[f"{prefix}_request_only_no_verdict"] = sum(
                    1 for e in eps if not (e.get(field) or {}).get("bridge")
                    and any(j["review_type"] == rtype for x in e["execs"] for j in jobs.get(x, [])))
                m[f"{prefix}_bridge_coverage"] = ratio(len(with_bridge), len(eps), len(issues_of(eps)))
                for st in sorted({e[field]["bridge"]["stratum"] for e in with_bridge}):
                    sub = [e for e in with_bridge if e[field]["bridge"]["stratum"] == st]
                    b = [e[field]["bridge"] for e in sub]
                    m[f"{prefix}_first_approved[{st}]"] = ratio(
                        sum(x["first_approved"] for x in b), len(b), len(issues_of(sub)))
                    m[f"{prefix}_rounds_to_approve[{st}]"] = dist([x["rounds"] for x in b if x["approved"]])
                    m[f"{prefix}_not_approved_by_T1[{st}]"] = sum(1 for x in b if not x["approved"])
                selfs = [e for e in eps if (e.get(field) or {}).get("self_report")]
                for st in sorted({e[field]["self_report"]["stratum"] for e in selfs}):
                    sub = [e[field]["self_report"]["rounds"] for e in selfs
                           if e[field]["self_report"]["stratum"] == st]
                    m[f"{prefix}_self_reported_rounds[{st}]"] = dist(sub)
            if node == "eng_design":
                review_block("design", "design_review")
            if node == "implement":
                review_block("code", "code_review")
                rq = [e for e in eps if e.get("reached_qa")]
                m["not_reached_qa"] = len(eps) - len(rq)
                m["qa_first_pass"] = ratio(sum(1 for e in rq if e["qa_first"]), len(rq), len(issues_of(rq)))
                m["qa_fail_count"] = dist([e["qa_fail_count"] for e in rq])
                m["qa_fail_total"] = sum(e["qa_fail_count"] for e in rq)
            if node == "qa":
                vs = [v for e in eps for v in e.get("qa_verdicts", [])]
                passes = [v for v in vs if v["verdict"] == "qa_passed"]
                fails = [v for v in vs if v["verdict"] == "qa_failed"]
                m["verdicts"] = {"pass": len(passes), "fail": len(fails)}
                judged = [v for v in passes if v["reviewed_by_founder"]]
                m["pass_not_yet_founder_judged"] = len(passes) - len(judged)
                m["pass_then_founder_rework_same_head"] = ratio(
                    sum(1 for v in judged if v["signal"] == "pass_then_founder_rework_same_head"),
                    len(judged))
                m["pass_then_land_rework"] = ratio(
                    sum(1 for v in passes if v["signal"] == "pass_then_land_rework"), len(passes))
                m["fail_then_lead_override"] = ratio(
                    sum(1 for v in fails if v["signal"] == "fail_then_lead_override"), len(fails))
            cov = [e for e in eps if e["cost_coverage"] == "files_located_all"]
            m["cost_coverage"] = ratio(len(cov), len(eps), len(issues_of(cov)))
            m["cost_status"] = {k: sum(1 for e in eps if e["cost_coverage"] == k)
                                for k in ("files_located_all", "open", "partial", "missing")}
            if cov:
                for f in ("total", "input", "output", "cache_read", "cache_write", "reasoning",
                          "sub_total"):
                    m[f"tokens_{f}"] = dist([e["tokens"].get(f, 0) for e in cov])
                sc = [e["codex_pct_scenario"] for e in cov if e.get("codex_pct_scenario")]
                if sc:
                    m["codex_pct_scenario_by_total"] = [dist([x["by_total"][0] for x in sc]),
                                                        dist([x["by_total"][1] for x in sc])]
                    m["codex_pct_scenario_by_uncached"] = [dist([x["by_uncached"][0] for x in sc]),
                                                           dist([x["by_uncached"][1] for x in sc])]
        return out

    def speed(filter_fn):
        out = defaultdict(dict)
        by = defaultdict(list)
        for a in attempts:
            if filter_fn(a):
                by[(a["node"], a["model"])].append(a)
        for (node, model), xs in by.items():
            done = [a for a in xs if a["completed"]]
            first = [a for a in done if a["attempt"] == 1]
            rw = [a for a in done if a["attempt"] > 1]
            out[node][model] = {
                "attempts": len(xs), "completed": len(done),
                "first_attempt_net_h": dist([a["net_s"] / 3600 for a in first]),
                "first_attempt_wall_h": dist([a["wall_s"] / 3600 for a in first]),
                "first_attempt_net_h_clean": dist([a["net_s"] / 3600 for a in first if not a["noisy"]]),
                "first_attempt_net_h_first_run": dist([a["net_s"] / 3600 for a in first
                                                       if a["first_run_for_issue"]]),
                "first_attempt_net_h_first_run_clean": dist([a["net_s"] / 3600 for a in first
                                                             if a["first_run_for_issue"] and not a["noisy"]]),
                "issues": len({a["issue"] for a in xs}),
                "rework_attempt_net_h": dist([a["net_s"] / 3600 for a in rw]),
                "deducted_question_h": sum(a["question_wait_s"] for a in done) / 3600,
                "deducted_restart_gap_h": sum(a["restart_gap_s"] for a in done) / 3600,
                "noisy_first_attempts": sum(1 for a in first if a["noisy"]),
            }
        return out

    since_new = ts(NEW_RULE_START)
    metrics = {
        "quota": metrics_quota,
        "freeze": freeze,
        "window": {"new_rule_start": NEW_RULE_START, "scorecard_start": SCORECARD_START},
        "counts": {"episodes": len(episodes), "attempts": len(attempts),
                   "runs": len(runs), "deliveries": len(deliveries)},
        "segment_counts": {s: sum(1 for e in episodes.values() if e["segment"] == s)
                           for s in sorted({e["segment"] for e in episodes.values()})},
        "arm_state_counts": {s: sum(1 for e in episodes.values() if e["arm_state"] == s)
                             for s in ("none", "honored", "not_honored", "no_arm_after_new_rule")},
        "O_all": agg(lambda e: True),
        "O_clean": agg(lambda e: not e["noise"]),
        "O_first_run": agg(lambda e: e["first_run_for_issue"]),
        "R_new": agg(lambda e: e["segment"] == "R_new"),
        **{seg: agg(lambda e, seg=seg: e["segment"] == seg)
           for seg in sorted({e["segment"] for e in episodes.values()}) if seg.startswith("L:")},
        "since_new_rule_all_models": agg(lambda e: e["first"] >= since_new),
        "speed_O": speed(lambda a: True),
        "speed_R_new": speed(lambda a: a["segment"] == "R_new"),
        **{"speed_" + seg: speed(lambda a, seg=seg: a["segment"] == seg)
           for seg in sorted({e["segment"] for e in episodes.values()}) if seg.startswith("L:")},
    }
    # Downstream outcome by design arm (design arm assigned by issue number / hash,
    # independent of the implement model of the day): implement QA first pass etc.
    down = defaultdict(lambda: defaultdict(list))
    for (run_id, node), ep in episodes.items():
        if node != "eng_design" or ep["model"] == "mixed":
            continue
        impl = episodes.get((run_id, "implement"))
        if not impl:
            continue
        down[ep["segment"]][ep["model"]].append(impl)
    metrics["downstream_by_design_model"] = {}
    for seg, by_model in down.items():
        metrics["downstream_by_design_model"][seg] = {}
        for model, impls in by_model.items():
            rq = [e for e in impls if e.get("reached_qa")]
            cb = [e["code_review"]["bridge"] for e in impls if (e.get("code_review") or {}).get("bridge")]
            metrics["downstream_by_design_model"][seg][model] = {
                "implement_episodes": len(impls),
                "impl_models": dict(sorted(
                    ((k, sum(1 for e in impls if e["model"] == k)) for k in {e["model"] for e in impls}))),
                "qa_first_pass": ratio(sum(1 for e in rq if e["qa_first"]), len(rq), len(issues_of(rq))),
                "code_first_approved_bridge": ratio(sum(1 for x in cb if x["first_approved"]), len(cb)),
            }

    dv = defaultdict(list)
    for d in deliveries:
        dv[d["impl_model"] or "no_implement"].append(d)
    metrics["delivery_by_impl_model"] = {
        k: {"runs": len(v), "net_h": dist([d["net_s"] / 3600 for d in v]),
            "net_h_clean": dist([d["net_s"] / 3600 for d in v if not d["noisy"]]),
            "wall_h": dist([d["wall_s"] / 3600 for d in v]),
            "founder_gate_h": dist([d["founder_gate_s"] / 3600 for d in v])}
        for k, v in dv.items()}
    # Implement QA first pass by period: same-period comparison limits time confounding.
    periods = [("09-08~09-15", "2026-09-08", "2026-09-16"), ("09-16~09-20", "2026-09-16", "2026-09-21"),
               ("09-21~09-25", "2026-09-21", "2026-09-26")]
    per = defaultdict(dict)
    for label, lo, hi in periods:
        by = defaultdict(list)
        for ep in episodes.values():
            d = ep["first"].strftime("%Y-%m-%d")
            if ep["node"] == "implement" and lo <= d < hi and ep.get("reached_qa"):
                by[ep["model"]].append(ep)
        for model, eps in by.items():
            per[label][model] = ratio(sum(1 for e in eps if e["qa_first"]), len(eps), len(issues_of(eps)))
    metrics["implement_qa_first_pass_by_period"] = {k: dict(v) for k, v in per.items()}
    # Effective routing since the new weighted rule went live.
    eff = defaultdict(lambda: defaultdict(int))
    for ep in episodes.values():
        if ep["first"] >= since_new and ep["node"] in ("eng_design", "implement", "qa"):
            eff[ep["node"]][ep["routing"] + " | " + ep["model"]] += 1
    metrics["effective_routing_since_new_rule"] = {k: dict(v) for k, v in eff.items()}
    metrics["delivery_gate_segments_not_deducted"] = sum(d["gate_segments_not_deducted"] for d in deliveries)
    # Daily mix of models per node (confounding context).
    mix = defaultdict(lambda: defaultdict(int))
    for ep in episodes.values():
        mix[ep["first"].strftime("%m-%d") + " " + ep["node"]][ep["model"]] += 1
    metrics["daily_mix"] = {k: dict(v) for k, v in sorted(mix.items())}

    with open(os.path.join(OUT, "metrics.json"), "w") as fh:
        json.dump(metrics, fh, indent=1, ensure_ascii=False, default=str)
    with open(os.path.join(OUT, "episodes.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["run_id", "issue", "project", "node", "model", "segment", "arm", "arm_state",
                    "first", "noise", "review_stratum", "first_approved", "rounds", "qa_first",
                    "qa_fail_count", "cost_coverage", "tokens_total"])
        for ep in sorted(episodes.values(), key=lambda e: e["first"]):
            rv = (ep.get("design_review") or ep.get("code_review") or {}).get("bridge") or {}
            tk = ep["tokens"].get("total")
            w.writerow([ep["run_id"], ep["issue"], ep["project"], ep["node"], ep["model"],
                        ep["segment"], ep["arm"], ep["arm_state"], ep["first"].isoformat(),
                        "|".join(ep["noise"]), rv.get("stratum"), rv.get("first_approved"),
                        rv.get("rounds"), ep.get("qa_first"), ep.get("qa_fail_count"),
                        ep["cost_coverage"], tk])
    with open(os.path.join(OUT, "attempts.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        cols = ["run_id", "issue", "node", "attempt", "model", "segment", "completed", "start",
                "end", "wall_s", "question_wait_s", "restart_gap_s", "net_s", "noisy", "fault"]
        w.writerow(cols)
        for a in sorted(attempts, key=lambda a: a["start"]):
            w.writerow([a.get(c) if c != "fault" else "|".join(a.get("fault", [])) for c in cols])
    with open(os.path.join(OUT, "deliveries.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        cols = ["run_id", "issue", "template", "impl_model", "design_model", "impl_segment",
                "wall_s", "founder_gate_s", "net_s", "noisy"]
        w.writerow(cols)
        for d in deliveries:
            w.writerow([d[c] for c in cols])
    print(json.dumps(metrics["counts"]), json.dumps(metrics["segment_counts"]),
          json.dumps(metrics["arm_state_counts"]))


if __name__ == "__main__":
    main()
