#!/usr/bin/env python3
"""FLY-2893: incident list, root-cause classes, waste time and quota — from ../raw only.

Pure function of ../raw/*.csv (no database access). Rules follow plan.md §2–§7.
Writes ../derived/{incidents,classes,vendor_compare,review_job_failures,unclassified}.csv
and ../derived/summary.json, then runs the §9 self-checks (non-zero exit on failure).
"""
import collections
import csv
import datetime as dt
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "raw")
OUT = os.path.join(HERE, "..", "derived")
BATCH_GAP = dt.timedelta(minutes=10)

CLASSES = {
    "K1": ("账号额度墙 usageLimited", "FLY-2371 · FLY-2521 · FLY-2572 · FLY-2729"),
    "K2": ("上游模型满载 serverOverloaded", "FLY-2630"),
    "K3": ("Codex 凭据 / 账号身份", "FLY-2750(已修) · FLY-2404 · FLY-1896"),
    "K4": ("cyber 400", "FLY-2743"),
    "K5": ("重启后 reown 失败", "FLY-2586 · FLY-2505 · FLY-2558 · FLY-2352 · FLY-2462"),
    "K6": ("worktree 接管失败", "FLY-2510 · FLY-2463"),
    "K7": ("agent home lease 缺失", "FLY-2689"),
    "K8": ("宿主子进程 / git 异常", "FLY-2617 · 新类(GitResultChecker)"),
    "K9": ("体自报 blocked(三轮核验)", "FLY-2344 · FLY-2507 · 新类"),
    "K10": ("停驻超时 resident_hold_expired", "FLY-2477 · FLY-2710"),
    "K11": ("无错误原文的判死", "FLY-2537 · FLY-2512 · FLY-2618"),
    "K12": ("运维收掉(无其他信号)", "按原文"),
    "K13": ("终态后复活 / 自续", "FLY-2814 · FLY-2572"),
    "K0": ("非故障换体(land 冲突再激活)", "—"),
    "K?": ("未归类", "—"),
}
NON_FAULT = {"K0"}


def ts(v):
    if not v:
        return None
    v = v.strip().replace(" ", "T")
    if not v.endswith("Z") and "+" not in v[10:]:
        v += "Z"
    try:
        return dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ") if t else ""


def hours(a, b):
    return round(max((b - a).total_seconds(), 0) / 3600, 4) if a and b else 0.0


def read(name):
    with open(os.path.join(RAW, name), newline="") as fh:
        return list(csv.DictReader(fh))


def pj(s):
    try:
        return json.loads(s or "{}")
    except ValueError:
        return {}


def classify_text(text, failure_kind, dead_reason):
    """Return (class, subclass) for one incident from its evidence text (§3 priority order)."""
    t = (text or "").lower()
    fk = failure_kind or ""
    if "usagelimit" in t or fk == "goal_usage_limited" or "usage limit" in t or "usagelimited" in t:
        return "K1", "usage_limit"
    if "serveroverloaded" in t or "at capacity" in t:
        return "K2", "model_capacity"
    if "cyber" in t or "access_programs" in t:
        return "K4", "cyber_400"
    if "refresh token" in t or "unauthorized" in t:
        return "K3", "refresh_token"
    if "auth.json" in t or "source auth is unavailable" in t:
        return "K3", "auth_json_missing"
    if "unknown codex account identity" in t:
        return "K3", "unknown_identity"
    if fk == "reown_exhausted" or "recovery owner failed" in t or "turn reconciliation" in t \
            or "keyed_home_reown_arm_mismatch" in t or "launch_snapshot_mismatch" in t \
            or "recovery exhausted" in t or "episode_exhausted" in t or "owner_failed" in t:
        return "K5", "reown"
    if "worktree_takeover_failed" in t or fk == "worktree_takeover_failed":
        return "K6", "clean=false" if "clean=false" in t else "head_mismatch" if "clean=true" in t else "other"
    if "agent home lease missing" in t:
        return "K7", "lease_missing"
    if "child stdio did not close" in t:
        return "K8", "child_stdio_250ms"
    if "gitresultchecker" in t:
        return "K8", "git_result_checker"
    if dead_reason == "resident_hold_expired":
        return "K10", "resident_hold_expired"
    return None, None


def blocked_subreason(msg):
    m = (msg or "").lower()
    if "billing" in m or "计费" in m or "spending limit" in m or "runner_id=0" in m:
        return "ci_billing"
    if "no-turn" in m or "注册缺失" in m or "执行注册" in m or "session 已移除" in m:
        return "no_turn_or_registration"
    if "529" in m or "n-to-n" in m:
        return "infra_529"
    if "冻结" in m or "暂停" in m or "停止指令" in m or "freeze" in m or "pause" in m or "范围决定" in m or "关闭或改题" in m:
        return "lead_freeze_or_scope_wait"
    if re.search(r"#\d{3,}", m) and re.search(r"合入|合并|merge|依赖", m):
        return "dependency_pr"
    if "worktree_takeover_failed" in m or "held" in m:
        return "waiting_engine_hold"
    return "other"


def operator_subclass(reason):
    r = (reason or "").lower()
    if re.search(r"quota|额度|usagelimit|usage limit|断供", r):
        return "K1", "operator_after_quota"
    if re.search(r"号识别|account identity|auth", r):
        return "K3", "operator_after_identity"
    if re.search(r"fly-2373|completion deadlock|drain_receipt|consume_pending_mail", r):
        return "K12", "completion_deadlock_FLY-2373"
    if re.search(r"resident_hold_already_woken|rework_retry_exhausted|fly-2821", r):
        return "K12", "rework_wake_exhausted_FLY-2821"
    if re.search(r"fly-2329|死结|dead knot|未铸体|unlaunched|never launched|从未起跑", r):
        return "K12", "dead_knot_FLY-2329"
    if re.search(r"reown|shuttle|班车", r):
        return "K5", "operator_after_reown"
    if re.search(r"worktree_takeover|dirty tree|worktree_dirty", r):
        return "K6", "operator_after_takeover"
    if re.search(r"founder|直接关掉|superseded|ghost|stale|duplicate|misdispatc|清理|砍掉", r):
        return "K0", "operator_scope_or_cleanup"
    return "K12", "other"


def main():
    os.makedirs(OUT, exist_ok=True)
    freeze = json.load(open(os.path.join(RAW, "freeze.json")))
    T0, T1, FROZEN = ts(freeze["T0"]), ts(freeze["T1"]), ts(freeze["frozen_at"])
    execs = read("executions.csv")
    E = {e["execution_id"]: e for e in execs}
    tok = {r["execution_id"]: r for r in read("exec_tokens.csv")}
    cerr = {r["execution_id"]: r for r in read("codex_errors.csv")}

    sf, dead, unl, completed_at, closes = {}, {}, {}, {}, collections.defaultdict(list)
    for r in read("session_events.csv"):
        eid, p, t = r["execution_id"], pj(r["payload"]), ts(r["ts"])
        if r["event_type"] == "session_failed" and eid not in sf:
            sf[eid] = (t, p.get("failureKind") or "", p.get("lastError") or "")
        elif r["event_type"] == "session_completed" and eid not in completed_at:
            completed_at[eid] = t
        elif r["event_type"] == "lead_close_runner":
            closes[eid].append((t, p.get("reason") or ""))
    run_ev = collections.defaultdict(list)
    for r in read("run_events.csv"):
        p, t = pj(r["payload"]), ts(r["at"])
        run_ev[r["run_id"]].append((t, r["kind"], r["execution_id"], p))
        if r["kind"] == "execution_dead_rolled_back" and r["execution_id"] and r["execution_id"] not in dead:
            dead[r["execution_id"]] = (t, p.get("reason") or "", p.get("newExecutionId") or "")
        elif r["kind"] == "unlaunched_admission_rolled_back" and r["execution_id"] and r["execution_id"] not in unl:
            unl[r["execution_id"]] = t
    node_done = {}
    for r in read("node_completions.csv"):
        node_done.setdefault(r["execution_id"], ts(r["completed_at"]))

    by_run = collections.defaultdict(list)
    for e in execs:
        by_run[e["run_id"]].append(e)
    # S5: an operator run termination counts against ONE body only — the newest body of
    # that run created before the termination, still alive (not terminal >60 s before),
    # whose node attempt never completed and whose session never reported completion.
    # Collateral bodies (e.g. a parked QA body in a run killed for an implement deadlock)
    # are not incidents.
    op_term = {}
    for run_id, evs in run_ev.items():
        for t, kind, _eid, p in evs:
            if kind != "run_terminated_by_operator":
                continue
            cands = [e for e in by_run.get(run_id, []) if ts(e["created_at"]) and ts(e["created_at"]) <= t]
            if not cands:
                continue
            e = max(cands, key=lambda x: x["created_at"])
            eid = e["execution_id"]
            term = ts(e["terminal_at"])
            if eid in node_done or eid in completed_at or eid in op_term:
                continue
            if term and term < t - dt.timedelta(seconds=60):
                continue
            op_term[eid] = (t, p.get("reason") or "")

    incidents = []
    for e in execs:
        if e["in_window"] != "1":
            continue
        eid = e["execution_id"]
        term = ts(e["terminal_at"])
        signals, times = [], []
        if eid in sf:
            signals.append("S1"); times.append(sf[eid][0])
        if eid in dead:
            signals.append("S2"); times.append(dead[eid][0])
        if eid in unl:
            signals.append("S3"); times.append(unl[eid])
        if e["session_status"] == "blocked":
            signals.append("S4"); times.append(term or ts(e["started_at"]))
        if eid in op_term:
            signals.append("S5"); times.append(op_term[eid][0])
        after = int((tok.get(eid) or {}).get("tokens_after_cut") or 0)
        post_terminal = after > 0 and e["session_status"] in ("completed", "terminated", "failed", "blocked")
        if post_terminal:
            signals.append("S6")
            if len(signals) == 1:
                times.append(term + dt.timedelta(minutes=2) if term else FROZEN)
        if not signals:
            continue
        t_i = min(t for t in times if t)

        fk = sf[eid][1] if eid in sf else ""
        dreason = dead[eid][1] if eid in dead else ""
        ce = cerr.get(eid) or {}
        texts = [
            ("transcript_error", f"{ce.get('error_info','')} {ce.get('error_message','')}".strip()),
            ("session_failed", sf[eid][2] if eid in sf else ""),
            ("sessions.last_error", e["last_error"]),
            ("dead_reason", dreason),
        ]
        cls = sub = None
        source = excerpt = ""
        for src, txt in texts:
            if not txt:
                continue
            c, s = classify_text(txt, fk if src == "session_failed" else "", dreason)
            if c:
                cls, sub, source, excerpt = c, s, src, txt
                break
        if not cls and fk:
            c, s = classify_text("", fk, dreason)
            if c:
                cls, sub, source, excerpt = c, s, "failureKind", fk
        if not cls and dreason == "actor_session_terminal:completed" and eid in completed_at \
                and completed_at[eid] <= dead[eid][0] and set(signals) <= {"S2", "S6"}:
            cls, sub, source, excerpt = "K0", "land_conflict_reactivation", "dead_reason", dreason
        if not cls and (fk == "goal_blocked" or e["session_status"] == "blocked" or ce.get("run_ended") == "blocked"):
            cls, sub, source = "K9", blocked_subreason(ce.get("blocked_last_message")), "rollout_last_message"
            excerpt = ce.get("blocked_last_message") or "goal ended non-complete: blocked"
        if not cls and eid in dead and dreason in ("resident_hold_expired",):
            cls, sub, source, excerpt = "K10", dreason, "dead_reason", dreason
        if not cls and "S5" in signals:
            cls, sub = operator_subclass(op_term[eid][1])
            source, excerpt = "operator_reason", op_term[eid][1]
        if not cls and eid in dead:
            cls, sub, source, excerpt = "K11", dreason or "dead_probe", "dead_reason", dreason
        if not cls and signals == ["S6"]:
            cls, sub, source, excerpt = "K13", "post_terminal_tokens", "rollout", f"{after} tokens after terminal"
        if not cls:
            cls, sub, source = "K?", "", "none"
            excerpt = " | ".join(t for _, t in texts if t)
        # A parked body that already completed its node only costs time once it is needed again.
        t_need = t_i
        if eid in node_done and node_done[eid] <= t_i:
            t_need = dead[eid][0] if eid in dead and dead[eid][0] >= t_i else None
        incidents.append({
            "execution_id": eid, "issue": e["issue"], "project": e["project"], "run_id": e["run_id"],
            "node_id": e["node_id"], "attempt": e["attempt"], "vendor": e["vendor"], "model": e["model"],
            "created_at": e["created_at"], "t_i": iso(t_i), "t_need": iso(t_need) if t_need else "",
            "signals": "+".join(signals), "class_key": cls, "subclass": sub, "evidence_source": source,
            "reason_excerpt": re.sub(r"\s+", " ", excerpt or "")[:200], "failure_kind": fk,
            "dead_reason": dreason, "session_status": e["session_status"],
            "tokens_until_cut": int((tok.get(eid) or {}).get("tokens_until_cut") or 0),
            "tokens_after_cut": after,
        })

    # ---- successors and waste (§4) ----
    key_execs = collections.defaultdict(list)
    for e in execs:
        key_execs[(e["project"], e["issue"], e["node_id"])].append(e)
    for k in key_execs:
        key_execs[k].sort(key=lambda e: (e["created_at"], e["execution_id"]))
    inc_by_id = {i["execution_id"]: i for i in incidents}

    def t_on(eid):
        r = tok.get(eid) or {}
        t = ts(r.get("first_token_ts"))
        return (t, "first_token") if t else (None, "none")

    for inc in incidents:
        seq = key_execs[(inc["project"], inc["issue"], inc["node_id"])]
        idx = next(i for i, e in enumerate(seq) if e["execution_id"] == inc["execution_id"])
        succ = seq[idx + 1] if idx + 1 < len(seq) else None
        inc.update({"successor": "", "successor_vendor": "", "successor_created": "", "t_on": "",
                    "t_on_source": "", "waste_start": "", "waste_end": "", "waste_hours": 0.0,
                    "recovered": "", "held_wait_hours": 0.0, "succ_first_turn_tokens": 0,
                    "never_took_over": ""})
        start = ts(inc["t_need"])
        mine_on, _ = t_on(inc["execution_id"])
        inc["never_took_over"] = "1" if (mine_on is None or mine_on >= ts(inc["t_i"])) else "0"
        if start is None:
            inc["recovered"] = "n/a_parked_after_completion"
            continue
        if not succ:
            inc.update({"recovered": "0", "waste_start": iso(start), "waste_end": iso(FROZEN),
                        "open_hours": hours(start, FROZEN)})
            continue
        son, src = t_on(succ["execution_id"])
        s_inc = inc_by_id.get(succ["execution_id"])
        s_ti = ts(s_inc["t_i"]) if s_inc else None
        ends = [t for t in (son, s_ti) if t]
        end = min(ends) if ends else None
        inc.update({"successor": succ["execution_id"], "successor_vendor": succ["vendor"],
                    "successor_created": succ["created_at"], "t_on": iso(son), "t_on_source": src,
                    "succ_first_turn_tokens": int((tok.get(succ["execution_id"]) or {}).get("first_turn_tokens") or 0)})
        if end is None:
            inc.update({"recovered": "0", "waste_start": iso(start), "waste_end": iso(FROZEN),
                        "open_hours": hours(start, FROZEN)})
            continue
        end = max(end, start)
        inc.update({"recovered": "1", "waste_start": iso(start), "waste_end": iso(end),
                    "waste_hours": hours(start, end)})
        held = [t for t, kind, _x, _p in run_ev.get(inc["run_id"], [])
                if kind in ("retry_limit_escalated", "unlaunched_admission_alerted") and start <= t <= end]
        if held:
            inc["held_wait_hours"] = hours(min(held), end)

    # K1 split: when did the SAME Codex home show token use by ANOTHER thread again after
    # the wall (= quota usable again)? Waste after that point is re-arm delay, not outage.
    act = collections.defaultdict(list)
    for r in read("codex_home_activity.csv"):
        act[r["codex_home"]].append((r["minute"], r["thread"]))
    for k in act:
        act[k].sort()
    import bisect
    for inc in incidents:
        inc["quota_back"] = ""
        inc["rearm_delay_hours"] = 0.0
        if inc["class_key"] != "K1" or inc["recovered"] != "1":
            continue
        r = tok.get(inc["execution_id"]) or {}
        home, me = r.get("codex_home"), r.get("thread")
        if not home or home not in act:
            continue
        lst = act[home]
        start_min = (ts(inc["t_i"]) + dt.timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%MZ")
        j = bisect.bisect_left(lst, (start_min, ""))
        back = next((m for m, th in lst[j:] if th != me), None)
        if back:
            qb = ts(back)
            inc["quota_back"] = iso(qb)
            we = ts(inc["waste_end"])
            if qb < we:
                inc["rearm_delay_hours"] = hours(max(qb, ts(inc["waste_start"])), we)

    # Overlap union per (issue, node): later incidents start no earlier than the previous end.
    for k in key_execs:
        mine = sorted((i for i in incidents if (i["project"], i["issue"], i["node_id"]) == k and i["recovered"] == "1"),
                      key=lambda i: i["waste_start"])
        prev_end = None
        for i in mine:
            s, e_ = ts(i["waste_start"]), ts(i["waste_end"])
            if prev_end and s < prev_end:
                s = min(prev_end, e_)
                i["waste_start"] = iso(s)
                i["waste_hours"] = hours(s, e_)
                i["held_wait_hours"] = min(i["held_wait_hours"], i["waste_hours"])
                i["rearm_delay_hours"] = min(i.get("rearm_delay_hours", 0.0), i["waste_hours"])
            prev_end = max(prev_end, e_) if prev_end else e_

    cols = ["execution_id", "issue", "project", "run_id", "node_id", "attempt", "vendor", "model",
            "created_at", "t_i", "t_need", "signals", "class_key", "subclass", "evidence_source",
            "reason_excerpt", "failure_kind", "dead_reason", "session_status", "successor",
            "successor_vendor", "successor_created", "t_on", "t_on_source", "recovered",
            "waste_start", "waste_end", "waste_hours", "held_wait_hours", "open_hours", "quota_back", "rearm_delay_hours",
            "never_took_over", "tokens_until_cut", "tokens_after_cut", "succ_first_turn_tokens"]
    incidents.sort(key=lambda i: (i["t_i"], i["execution_id"]))
    with open(os.path.join(OUT, "incidents.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, lineterminator="\n", extrasaction="ignore")
        w.writeheader()
        for i in incidents:
            i.setdefault("open_hours", 0.0)
            w.writerow(i)
    print("incidents:", len(incidents))

    # ---- per-class summary (§3–§5) ----
    fps = [float(r["pct_per_100M_tokens"]) for r in read("codex_quota_fingerprints.csv")
           if r["pct_per_100M_tokens"] and float(r["delta_pct"] or 0) >= 50]
    fps.sort()

    def q(p):
        if not fps:
            return None
        k = (len(fps) - 1) * p
        lo, hi = int(k), min(int(k) + 1, len(fps) - 1)
        return fps[lo] + (fps[hi] - fps[lo]) * (k - lo)

    rate_lo, rate_mid, rate_hi = q(0.25), q(0.5), q(0.75)

    def pct(tokens):
        return [round(tokens / 1e8 * r, 1) if r else "" for r in (rate_lo, rate_mid, rate_hi)]

    groups = collections.defaultdict(list)
    for i in incidents:
        groups[(i["vendor"], i["class_key"])].append(i)
    rows = []
    for (vendor, cls), items in groups.items():
        items.sort(key=lambda i: i["t_i"])
        batches, last = 0, None
        for i in items:
            t = ts(i["t_i"])
            if last is None or t - last > BATCH_GAP:
                batches += 1
            last = t
        rec = [i for i in items if i["recovered"] == "1"]
        opn = [i for i in items if i["recovered"] == "0"]
        q1 = sum(i["tokens_until_cut"] for i in items)
        q2 = sum(i["succ_first_turn_tokens"] for i in rec)
        q3 = sum(i["tokens_after_cut"] for i in items)
        subs = collections.Counter(i["subclass"] for i in items)
        p1, p3 = pct(q1), pct(q3)
        rows.append({
            "vendor": vendor, "class_key": cls, "label": CLASSES[cls][0], "refs": CLASSES[cls][1],
            "non_fault": int(cls in NON_FAULT), "incidents": len(items),
            "issues": len({i["issue"] for i in items}), "batches": batches,
            "never_took_over": sum(1 for i in items if i["never_took_over"] == "1"),
            "recovered": len(rec), "waste_hours": round(sum(i["waste_hours"] for i in rec), 2),
            "held_wait_hours": round(sum(i["held_wait_hours"] for i in rec), 2),
            "rearm_delay_hours": round(sum(i.get("rearm_delay_hours", 0.0) for i in rec), 2),
            "median_waste_hours": round(sorted(i["waste_hours"] for i in rec)[len(rec) // 2], 2) if rec else 0,
            "open": len(opn), "open_hours": round(sum(i["open_hours"] for i in opn), 1),
            "q1_dead_body_tokens": q1, "q2_successor_first_turn_tokens": q2, "q3_post_terminal_tokens": q3,
            "q1_week_pct_p25_p50_p75": "/".join(map(str, p1)) if vendor == "codex" else "",
            "q3_week_pct_p25_p50_p75": "/".join(map(str, p3)) if vendor == "codex" else "",
            "subclasses": "; ".join(f"{k or '-'}:{v}" for k, v in subs.most_common()),
        })
    rows.sort(key=lambda r: (r["vendor"], -r["waste_hours"], -r["incidents"]))
    with open(os.path.join(OUT, "classes.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)

    # ---- vendor comparison (§6) ----
    win = [e for e in execs if e["in_window"] == "1"]
    fault = {i["execution_id"] for i in incidents if i["class_key"] not in NON_FAULT}
    caused = collections.Counter()
    for i in incidents:
        if i["class_key"] not in NON_FAULT and i["successor"]:
            caused[(i["vendor"], i["project"], i["issue"], i["node_id"])] += 1

    def stratum(n):
        return n if n in ("implement", "eng_design", "qa") else "other"

    cmp_rows = []
    for vendor in ("codex", "claude"):
        for st in ("implement", "eng_design", "qa", "other", "ALL"):
            ex = [e for e in win if e["vendor"] == vendor and (st == "ALL" or stratum(e["node_id"]) == st)]
            if not ex:
                continue
            keys = collections.Counter((e["project"], e["issue"], e["node_id"]) for e in ex)
            inc_keys = {(e["project"], e["issue"], e["node_id"]) for e in ex if e["execution_id"] in fault}
            n_inc = sum(1 for e in ex if e["execution_id"] in fault)
            cmp_rows.append({
                "vendor": vendor, "stratum": st, "executions": len(ex), "incident_executions": n_inc,
                "incident_rate": round(n_inc / len(ex), 3), "issue_node_groups": len(keys),
                "avg_extra_executions_per_group": round(sum(v - 1 for v in keys.values()) / len(keys), 2),
                "avg_incident_redispatch_per_group": round(sum(caused[(vendor, *k)] for k in keys) / len(keys), 2),
                "groups_with_incident_share": round(len(inc_keys) / len(keys), 3),
                "small_sample": int(len(ex) < 30),
            })
    with open(os.path.join(OUT, "vendor_compare.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(cmp_rows[0].keys()), lineterminator="\n")
        w.writeheader()
        w.writerows(cmp_rows)

    # ---- review sub-process failures (§7) ----
    rj = read("review_jobs.csv")
    normal = ("superseded_by_revision", "head_moved", "gate_answered_externally", "gate_answered",
              "reviewed_plan_moved", "head_moved_exhausted")
    rjc = collections.Counter()
    for r in rj:
        if r["status"] != "failed":
            continue
        kind = "normal_void" if r["failure_reason"] in normal else "infra_failure"
        reviewer = "author=" + (r["author_family"] or "?")
        rjc[(reviewer, r["review_type"], kind, r["failure_reason"] or "<null>")] += 1
    with open(os.path.join(OUT, "review_job_failures.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["author_side", "review_type", "kind", "failure_reason", "jobs"])
        for k, v in sorted(rjc.items(), key=lambda kv: (-kv[1], kv[0])):
            w.writerow([*k, v])

    unc = [i for i in incidents if i["class_key"] == "K?"]
    with open(os.path.join(OUT, "unclassified.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, lineterminator="\n", extrasaction="ignore")
        w.writeheader()
        w.writerows(unc)

    # ---- self-checks (§9) ----
    errors = []
    if sum(r["incidents"] for r in rows) != len(incidents):
        errors.append("class counts do not sum to incident rows")
    if len(unc) / max(len(incidents), 1) >= 0.05:
        errors.append(f"unclassified share {len(unc)}/{len(incidents)} >= 5%")
    for k in key_execs:
        spans = sorted((ts(i["waste_start"]), ts(i["waste_end"])) for i in incidents
                       if (i["project"], i["issue"], i["node_id"]) == k and i["recovered"] == "1")
        for (a1, b1), (a2, b2) in zip(spans, spans[1:]):
            if a2 < b1 and b2 > a2:
                errors.append(f"overlapping waste spans on {k}")
                break
    if any(i["waste_hours"] < 0 for i in incidents):
        errors.append("negative waste")
    summary = {
        "freeze": freeze, "incidents": len(incidents),
        "codex_week_pct_per_100M_tokens_p25_p50_p75": [rate_lo, rate_mid, rate_hi],
        "fingerprints_used": len(fps), "unclassified": len(unc), "self_check_errors": errors,
    }
    json.dump(summary, open(os.path.join(OUT, "summary.json"), "w"), indent=2, ensure_ascii=False)
    if errors:
        print("SELF-CHECK FAILED:", errors)
        sys.exit(1)
    print("self-checks ok")


if __name__ == "__main__":
    main()
