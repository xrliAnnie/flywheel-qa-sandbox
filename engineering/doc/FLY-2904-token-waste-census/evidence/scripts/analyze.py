#!/usr/bin/env python3
"""FLY-2904: derive the ledger + per-mechanism waste estimates from ../raw (census.py output).

Read-only except ../derived/summary.json. Every number printed here is recomputed from the
per-request / per-file rows; no aggregate is taken from another aggregate.
"""
import collections
import bisect
import csv
import datetime as dt
import json
import os
import sqlite3
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "raw")
DER = os.path.join(HERE, "..", "derived")
H = os.path.expanduser("~")
T0, T1 = "2026-09-11 22:00:00", "2026-09-25 22:00:00"
# Relative weights, API list-price ratios (only for comparing categories; subscription
# quota accounting is unpublished). Claude: in 1, cache write 1.25, cache read 0.1, out 5.
# Codex (OpenAI): uncached in 1, cached in 0.1, out 8.
CW = dict(input=1.0, cache_creation=1.25, cache_read=0.1, output=5.0)
XW = dict(uncached=1.0, cached=0.1, output=8.0)


def rows(name):
    with open(os.path.join(RAW, name)) as fh:
        yield from csv.DictReader(fh)


def I(x):
    return int(x or 0)


def pct(a, b):
    return round(100 * a / b, 1) if b else 0.0


out = {}
# ------------------------------------------------------------------ load
creq = list(rows("claude_requests.csv"))
xreq = list(rows("codex_requests.csv"))
cfiles = {r["file_id"]: r for r in rows("claude_files.csv")}
xfiles = {r["file_id"]: r for r in rows("codex_files.csv")}
for r in creq:
    r["tot"] = I(r["input"]) + I(r["cache_creation"]) + I(r["cache_read"]) + I(r["output"])
    r["w"] = sum(CW[k] * I(r[k]) for k in CW)
    r["ctx"] = I(r["ctx"])
for r in xreq:
    d_in, d_ca, d_out = I(r["delta_input"]), I(r["delta_cached"]), I(r["delta_output"])
    r["tot"] = I(r["delta_total"])
    r["w"] = XW["uncached"] * max(d_in - d_ca, 0) + XW["cached"] * d_ca + XW["output"] * d_out
    r["ctx"] = I(r["ctx_last_input"])
C_TOT = sum(r["tot"] for r in creq)
X_TOT = sum(r["tot"] for r in xreq)
C_W = sum(r["w"] for r in creq)
X_W = sum(r["w"] for r in xreq)
out["totals"] = dict(claude_tokens=C_TOT, codex_tokens=X_TOT, claude_requests=len(creq),
                     codex_requests=len(xreq), claude_weighted=round(C_W), codex_weighted=round(X_W),
                     claude_fields={k: sum(I(r[k]) for r in creq) for k in CW},
                     codex_fields=dict(input=sum(I(r["delta_input"]) for r in xreq),
                                       cached=sum(I(r["delta_cached"]) for r in xreq),
                                       output=sum(I(r["delta_output"]) for r in xreq)))

# ------------------------------------------------------------------ ledger (who uses it)
def who(vendor, r):
    b, s = r["bucket"], r["sub"]
    if b == "lead":
        return f"Lead · {s.replace('codex-lead:', '')}"
    if b == "runner":
        node = s.split(":", 1)[1]
        return f"Runner · {node}"
    if b == "review":
        return "评审 · " + {"claude-review:code": "代码评审(Claude)", "claude-review:design": "设计评审(Claude)"}.get(
            s, "runner 调用的 Codex companion")
    if b == "qa_env":
        return "QA 测试环境"
    return "其它 / founder 手动"


ledger = collections.defaultdict(lambda: dict(claude=0, codex=0, claude_w=0.0, codex_w=0.0, requests=0,
                                              subagent=0))
for r in creq:
    k = who("claude", r)
    ledger[k]["claude"] += r["tot"]
    ledger[k]["claude_w"] += r["w"]
    ledger[k]["requests"] += 1
    if r["subagent"] == "1":
        ledger[k]["subagent"] += r["tot"]
for r in xreq:
    k = who("codex", r)
    ledger[k]["codex"] += r["tot"]
    ledger[k]["codex_w"] += r["w"]
    ledger[k]["requests"] += 1
led = []
for k, v in ledger.items():
    t = v["claude"] + v["codex"]
    led.append(dict(who=k, tokens=t, claude=v["claude"], codex=v["codex"], share=pct(t, C_TOT + X_TOT),
                    claude_share=pct(v["claude"], C_TOT), codex_share=pct(v["codex"], X_TOT),
                    weighted_share_claude=pct(v["claude_w"], C_W), weighted_share_codex=pct(v["codex_w"], X_W),
                    requests=v["requests"], subagent_tokens=v["subagent"]))
led.sort(key=lambda d: -d["tokens"])
out["ledger"] = led

# daily totals
daily = collections.defaultdict(lambda: [0, 0])
for r in creq:
    daily[r["ts"][:10]][0] += r["tot"]
for r in xreq:
    daily[r["ts"][:10]][1] += r["tot"]
out["daily"] = {d: dict(claude=v[0], codex=v[1]) for d, v in sorted(daily.items())}

# ------------------------------------------------------------------ M1 Lead wakes by what woke them
LIFECYCLE = {"stage_changed", "session_started", "session_monitoring_reestablished",
             "workflow_replacement_eligibility", "action_executed", "workflow_claim_recorded"}
lead_turns = collections.defaultdict(lambda: dict(tok=0, w=0.0, req=0, lead=None, kind=None, day=None))
for r in creq:
    if r["bucket"] != "lead" or r["subagent"] == "1":
        continue
    k = (r["file_id"], r["turn_seq"])
    t = lead_turns[k]
    t["tok"] += r["tot"]
    t["w"] += r["w"]
    t["req"] += 1
    t["lead"], t["kind"] = r["sub"], r["turn_kind"]
    t["day"] = t["day"] or r["ts"][:10]
by_kind = collections.defaultdict(lambda: dict(turns=0, tokens=0, weighted=0.0, requests=0))
by_lead_kind = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0]))
by_day_life = collections.defaultdict(lambda: [0, 0, 0])  # eng-lead: lifecycle turns, tokens, all turns
for t in lead_turns.values():
    d = by_kind[t["kind"]]
    d["turns"] += 1
    d["tokens"] += t["tok"]
    d["weighted"] += t["w"]
    d["requests"] += t["req"]
    by_lead_kind[t["lead"]][t["kind"]][0] += 1
    by_lead_kind[t["lead"]][t["kind"]][1] += t["tok"]
    if t["lead"] == "flywheel-eng-lead":
        by_day_life[t["day"]][2] += 1
        if t["kind"] in LIFECYCLE:
            by_day_life[t["day"]][0] += 1
            by_day_life[t["day"]][1] += t["tok"]
lead_total = sum(d["tokens"] for d in by_kind.values())
out["lead_wakes"] = dict(
    lead_tokens=lead_total,
    by_kind=sorted(({"kind": k, **v, "share_of_lead": pct(v["tokens"], lead_total),
                     "tokens_per_turn": round(v["tokens"] / v["turns"]) if v["turns"] else 0}
                    for k, v in by_kind.items()), key=lambda d: -d["tokens"]),
    lifecycle_kinds=sorted(LIFECYCLE),
    eng_lead_lifecycle_by_day={d: dict(lifecycle_turns=v[0], lifecycle_tokens=v[1], all_turns=v[2])
                               for d, v in sorted(by_day_life.items())},
    by_lead={lead: {k: dict(turns=v[0], tokens=v[1]) for k, v in kinds.items()}
             for lead, kinds in by_lead_kind.items()})

# ------------------------------------------------------------------ M2 context size (1M window)
def ctx_profile(sel):
    cs = sorted(r["ctx"] for r in sel)
    if not cs:
        return {}
    def q(p):
        return cs[min(len(cs) - 1, int(p * len(cs)))]
    over = lambda n: sum(1 for c in cs if c > n)
    return dict(requests=len(cs), p50=q(.5), p90=q(.9), max=cs[-1], mean=round(statistics.mean(cs)),
                over_200k=over(200_000), over_400k=over(400_000),
                cache_read_above_200k=sum(max(0, min(I(r.get("cache_read", r.get("delta_cached"))), r["ctx"] - 200_000)) for r in sel))


ctx = {}
for lead in sorted({r["sub"] for r in creq if r["bucket"] == "lead"}):
    ctx["Lead · " + lead] = ctx_profile([r for r in creq if r["bucket"] == "lead" and r["sub"] == lead and r["subagent"] == "0"])
for b, s in (("runner", "claude:qa"), ("runner", "claude:implement"), ("review", "claude-review:code"),
             ("review", "claude-review:design"), ("runner", "claude:eng_design")):
    ctx[f"{b} · {s}"] = ctx_profile([r for r in creq if r["bucket"] == b and r["sub"] == s and r["subagent"] == "0"])
for s in ("codex:implement", "codex:eng_design", "codex:qa"):
    ctx["codex " + s] = ctx_profile([r for r in xreq if r["sub"] == s])
out["context_profile"] = ctx

# ------------------------------------------------------------------ M3 cache rebuilds (TTL / compaction)
prev_ts = {}
rebuild = collections.defaultdict(lambda: dict(n=0, cache_creation=0, after_idle_1h=0, cc_after_idle_1h=0,
                                               after_idle_5m=0, cc_after_idle_5m=0))
for r in sorted(creq, key=lambda r: (r["file_id"], r["ts"])):
    t = dt.datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
    gap = (t - prev_ts[r["file_id"]]).total_seconds() if r["file_id"] in prev_ts else None
    prev_ts[r["file_id"]] = t
    cc = I(r["cache_creation"])
    if cc < 50_000:
        continue
    k = who("claude", r)
    d = rebuild[k]
    d["n"] += 1
    d["cache_creation"] += cc
    if gap is not None and gap > 3600:
        d["after_idle_1h"] += 1
        d["cc_after_idle_1h"] += cc
    elif gap is not None and gap > 300:
        d["after_idle_5m"] += 1
        d["cc_after_idle_5m"] += cc
out["cache_rebuilds"] = dict(sorted(rebuild.items(), key=lambda kv: -kv[1]["cache_creation"]))
out["cache_rebuilds_total_cc"] = sum(I(r["cache_creation"]) for r in creq)

# ------------------------------------------------------------------ M4 fixed prefix (system prompt/tools)
prefix = collections.defaultdict(lambda: dict(files=0, requests=0, prefix_tokens=0, first_ctx=[]))
for f in cfiles.values():
    if not I(f["requests"]):
        continue
    k = who("claude", f)
    d = prefix[k]
    d["files"] += 1
    d["requests"] += I(f["requests"])
    d["prefix_tokens"] += I(f["min_ctx"]) * I(f["requests"])
    d["first_ctx"].append(I(f["first_ctx"]))
for f in xfiles.values():
    if not I(f["requests"]):
        continue
    k = "Codex " + who("codex", f)
    d = prefix[k]
    d["files"] += 1
    d["requests"] += I(f["requests"])
    d["prefix_tokens"] += I(f["min_ctx"]) * I(f["requests"])
    d["first_ctx"].append(I(f["first_ctx"]))
out["fixed_prefix"] = {k: dict(files=v["files"], requests=v["requests"], prefix_tokens=v["prefix_tokens"],
                               first_ctx_median=statistics.median(v["first_ctx"]) if v["first_ctx"] else 0)
                       for k, v in sorted(prefix.items(), key=lambda kv: -kv[1]["prefix_tokens"])}

# ------------------------------------------------------------------ M5 tool output amplification
def tool_amp(name, vendor):
    agg = collections.defaultdict(lambda: dict(calls=0, chars=0, reread_tokens=0, big_calls=0, big_reread=0))
    for r in rows(name):
        k = r["tool_class"]
        ch, n = I(r["chars"]), I(r["later_requests_same_ctx"])
        d = agg[k]
        if r["in_ctx_tokens"] == "":
            d["unknown_outputs"] = d.get("unknown_outputs", 0) + 1
            continue
        tk = I(r["in_ctx_tokens"])
        d["calls"] += 1
        d["chars"] += ch
        d["in_ctx_tokens"] = d.get("in_ctx_tokens", 0) + tk
        d["reread_tokens"] += tk * n
        if tk > 5_000:
            d["big_calls"] += 1
            d["big_reread"] += tk * n
    return dict(sorted(agg.items(), key=lambda kv: -kv[1]["reread_tokens"]))


out["tool_amplification"] = dict(claude=tool_amp("claude_tool_outputs.csv", "claude"),
                                 codex=tool_amp("codex_tool_outputs.csv", "codex"))

# ------------------------------------------------------------------ M6 post-terminal residue
res = collections.defaultdict(lambda: [0, 0])
for f in cfiles.values():
    if I(f["tokens_after_terminal"]):
        res["claude:" + (f["node"] or f["sub"])][0] += I(f["tokens_after_terminal"])
        res["claude:" + (f["node"] or f["sub"])][1] += 1
for f in xfiles.values():
    if I(f["tokens_after_terminal"]):
        res["codex:" + (f["node"] or f["sub"])][0] += I(f["tokens_after_terminal"])
        res["codex:" + (f["node"] or f["sub"])][1] += 1
out["post_terminal"] = {k: dict(tokens=v[0], files=v[1]) for k, v in sorted(res.items(), key=lambda kv: -kv[1][0])}

# ------------------------------------------------------------------ M7 extra executions per issue x node
db = sqlite3.connect(f"file:{H}/.flywheel/teamlead.db?mode=ro", uri=True)
ex = list(db.execute(
    "select w.execution_id, w.node_id, w.vendor, w.created_at, s.issue_identifier, s.status "
    "from workflow_execution_runtime w left join sessions s using(execution_id) "
    "where w.created_at >= '2026-09-11T22:00:00' and w.created_at < '2026-09-25T22:00:00'"))
tok_by_exec = collections.Counter()
first_turn_by_exec = collections.Counter()
for f in cfiles.values():
    if f["exec_id"]:
        tok_by_exec[f["exec_id"]] += I(f["tokens"])
for f in xfiles.values():
    if f["exec_id"]:
        tok_by_exec[f["exec_id"]] += I(f["tokens"])
        first_turn_by_exec[f["exec_id"]] += I(f["first_turn_tokens"])
groups = collections.defaultdict(list)
for eid, node, vendor, created, issue, status in ex:
    groups[(issue, node)].append((created, eid, vendor, status))
extra = dict(groups=0, groups_multi=0, executions=len(ex), extra_executions=0, extra_tokens=0,
             extra_tokens_failed=0, extra_first_turn_codex=0, by_node=collections.Counter(),
             by_node_n=collections.Counter())
for (issue, node), lst in groups.items():
    extra["groups"] += 1
    if len(lst) < 2:
        continue
    extra["groups_multi"] += 1
    lst.sort()
    for created, eid, vendor, status in lst[1:]:  # every execution after the first one of issue x node
        extra["extra_executions"] += 1
        extra["extra_tokens"] += tok_by_exec[eid]
        extra["extra_first_turn_codex"] += first_turn_by_exec[eid]
        extra["by_node"][f"{vendor}:{node}"] += tok_by_exec[eid]
        extra["by_node_n"][f"{vendor}:{node}"] += 1
    for created, eid, vendor, status in lst[:-1]:  # executions that did not end the chain
        if status in ("failed", "terminated", "blocked"):
            extra["extra_tokens_failed"] += tok_by_exec[eid]
extra["by_node"] = dict(extra["by_node"].most_common())
extra["by_node_n"] = dict(extra["by_node_n"].most_common())
extra["mapped_exec_tokens"] = sum(tok_by_exec[e[0]] for e in ex)
out["extra_executions"] = extra

# ------------------------------------------------------------------ M8 review rounds
jobs = list(db.execute(
    "select reviewer_session_uuid, review_type, round, status, failure_reason, issue_id from codex_review_job "
    "where created_at >= ? and created_at < ?", (T0, T1)))
rv_tokens = {}
for f in cfiles.values():
    if f["bucket"] == "review" and f["subagent"] == "0":
        rv_tokens.setdefault(f["review_jobs"] and f["file_id"], 0)
sess_tok = collections.Counter()
sess_file = {}
for f in cfiles.values():
    if f["bucket"] == "review":
        sess_tok[f["file_id"]] += I(f["tokens"])
rounds = collections.defaultdict(lambda: collections.Counter())
fail = collections.Counter()
per_gate = collections.defaultdict(int)
for uid, rtype, rnd, st, fr, issue in jobs:
    rounds[rtype][min(rnd or 1, 6)] += 1
    per_gate[(issue, rtype)] = max(per_gate[(issue, rtype)], rnd or 1)
    if st == "failed":
        fail[f"{rtype}:{fr or '?'}"] += 1
review_tokens = collections.Counter()
review_req = collections.Counter()
for r in creq:
    if r["bucket"] == "review":
        review_tokens[r["sub"]] += r["tot"]
        review_req[r["sub"]] += 1
gate_rounds = collections.defaultdict(collections.Counter)
for (issue, rtype), m in per_gate.items():
    gate_rounds[rtype][min(m, 6)] += 1
out["reviews"] = dict(jobs=len(jobs), rounds_hist={k: dict(sorted(v.items())) for k, v in rounds.items()},
                      gates_by_max_round={k: dict(sorted(v.items())) for k, v in gate_rounds.items()},
                      failed=dict(fail.most_common()), tokens=dict(review_tokens), requests=dict(review_req),
                      sessions=sum(1 for f in cfiles.values() if f["bucket"] == "review" and f["subagent"] == "0"))

# per-job attribution: requests of the reviewer session between job creation and last update
sess_files = collections.defaultdict(set)
for f in cfiles.values():
    if f["bucket"] == "review":
        sess_files[f["session"]].add(f["file_id"])
req_by_file = collections.defaultdict(list)
for r in creq:
    if r["bucket"] == "review":
        req_by_file[r["file_id"]].append((r["ts"], r["tot"], r["w"]))
job_tok = collections.defaultdict(lambda: [0, 0, 0.0])
jobs2 = list(db.execute(
    "select reviewer_session_uuid, review_type, round, status, coalesce(failure_reason,''), "
    "replace(created_at,' ','T')||'Z' from codex_review_job "
    "where reviewer_session_uuid is not null and created_at < ?", (T1,)))
by_sess = collections.defaultdict(list)
for uid, rtype, rnd, st, fr, c0 in jobs2:
    by_sess[uid].append((c0, rtype, rnd or 1, st, fr))
unassigned = 0
for uid, lst in by_sess.items():
    lst.sort()
    starts = [j[0] for j in lst]
    acc = [[0, 0.0] for _ in lst]
    for fid in sess_files.get(uid, ()):
        for ts, tot, ww in req_by_file[fid]:
            k = bisect.bisect_right(starts, ts) - 1  # latest job created at/before this request
            if k < 0:
                unassigned += tot
                continue
            acc[k][0] += tot
            acc[k][1] += ww
    for (c0, rtype, rnd, st, fr), (t, w) in zip(lst, acc):
        if not (T0.replace(" ", "T") + "Z" <= c0):
            continue  # job created before the window; its in-window tokens still counted below
        for key in (f"{rtype}:{'done' if st == 'done' else fr or st}",
                    f"{rtype}:round{min(rnd, 5)}{'+' if rnd >= 5 else ''}"):
            job_tok[key][0] += 1
            job_tok[key][1] += t
            job_tok[key][2] += w
out["review_unassigned_tokens"] = unassigned
out["review_job_tokens"] = {k: dict(jobs=v[0], tokens=v[1], weighted=round(v[2])) for k, v in sorted(job_tok.items())}

# per-review-session: tokens vs number of jobs it served (resumed session grows each round)
per_sess = []
for f in cfiles.values():
    if f["bucket"] == "review" and f["subagent"] == "0" and f["review_jobs"]:
        per_sess.append((I(f["review_jobs"]), I(f["tokens"]), I(f["max_ctx"]), f["sub"]))
agg = collections.defaultdict(lambda: [0, 0, []])
for j, t, mx, s in per_sess:
    k = (s, min(j, 8))
    agg[k][0] += 1
    agg[k][1] += t
    agg[k][2].append(mx)
out["review_sessions_by_jobs"] = {f"{s}|jobs={j}": dict(sessions=v[0], tokens=v[1],
                                                        median_max_ctx=statistics.median(v[2]))
                                  for (s, j), v in sorted(agg.items())}

# ------------------------------------------------------------------ runner turns (woken runners)
rt = collections.defaultdict(lambda: dict(tok_first=0, tok_later=0, turns=0, files=0))
for r in creq:
    if r["bucket"] != "runner" or r["subagent"] == "1":
        continue
    d = rt[r["sub"]]
    if I(r["turn_seq"]) <= 1:
        d["tok_first"] += r["tot"]
    else:
        d["tok_later"] += r["tot"]
for f in cfiles.values():
    if f["bucket"] == "runner" and f["subagent"] == "0":
        rt[f["sub"]]["turns"] += I(f["external_turns"])
        rt[f["sub"]]["files"] += 1
out["runner_turns"] = dict(rt)

# ------------------------------------------------------------------ subagents
sa = collections.Counter()
for r in creq:
    if r["subagent"] == "1":
        sa[who("claude", r)] += r["tot"]
out["subagents"] = dict(sa.most_common())

# model mix
mm = collections.Counter()
for r in creq:
    mm[r["model"]] += r["tot"]
out["claude_models"] = dict(mm.most_common())

os.makedirs(DER, exist_ok=True)
json.dump(out, open(os.path.join(DER, "summary.json"), "w"), indent=1, ensure_ascii=False, default=str)
print(json.dumps({k: out[k] for k in ("totals",)}, indent=1))

# ================================================================== mechanisms (report numbers)
M = {}
def cr(r):
    return I(r.get("cache_read", r.get("delta_cached")))
def wsum(sel):
    return round(sum(r["w"] for r in sel))

# W1 Lead context above a compaction threshold (cache_read only, conservative)
for thr in (200_000, 250_000, 300_000):
    sel = [r for r in creq if r["bucket"] == "lead" and r["subagent"] == "0"]
    M[f"lead_cache_read_above_{thr//1000}k"] = sum(max(0, min(cr(r), r["ctx"] - thr)) for r in sel)
    for sub in ("flywheel-eng-lead",):
        M[f"eng_lead_cache_read_above_{thr//1000}k"] = sum(max(0, min(cr(r), r["ctx"] - thr)) for r in sel if r["sub"] == sub)
    runners = [r for r in creq if r["bucket"] in ("runner", "review", "qa_env") and r["subagent"] == "0"]
    M[f"claude_runner_review_cache_read_above_{thr//1000}k"] = sum(max(0, min(cr(r), r["ctx"] - thr)) for r in runners)
M["lead_tokens_total"] = sum(r["tot"] for r in creq if r["bucket"] == "lead")
M["eng_lead_tokens"] = sum(r["tot"] for r in creq if r["sub"] == "flywheel-eng-lead")
M["eng_lead_mean_ctx"] = round(statistics.mean(r["ctx"] for r in creq if r["sub"] == "flywheel-eng-lead" and r["subagent"] == "0"))

# W2 Lead wakes by tier (whole-turn tokens)
TIER = {"A_pure_lifecycle_or_info": {"stage_changed", "session_started", "session_monitoring_reestablished",
                                     "workflow_replacement_eligibility", "infra_alert:info"},
        "C_cross_lead_chatter": {"discord:other_bot_or_lead"},
        "D_patrol_summary": {"patrol_tick", "summary_due"},
        "E_alerts_warn": {"infra_alert:warn_or_higher", "discord:alerts_dispatcher"}}
turn_rows = collections.defaultdict(list)
for r in creq:
    if r["bucket"] == "lead" and r["subagent"] == "0":
        turn_rows[(r["file_id"], r["turn_seq"])].append(r)
turn_list = []
for key, rs in turn_rows.items():
    turn_list.append(dict(lead=rs[0]["sub"], kind=rs[0]["turn_kind"], akey=rs[0]["alert_key"], ts=rs[0]["ts"],
                          tok=sum(x["tot"] for x in rs), w=sum(x["w"] for x in rs), req=len(rs),
                          first_req_tok=rs[0]["tot"]))
for tier, kinds in TIER.items():
    sel = [t for t in turn_list if t["kind"] in kinds]
    M[f"wake_{tier}"] = dict(turns=len(sel), tokens=sum(t["tok"] for t in sel), weighted=round(sum(t["w"] for t in sel)),
                             first_request_tokens=sum(t["first_req_tok"] for t in sel))
# B: repeat alerts — same normalized title for the same Lead within the previous 6 hours
last_seen = {}
rep = dict(turns=0, tokens=0, weighted=0)
alerts = sorted((t for t in turn_list if t["akey"]), key=lambda t: t["ts"])
for t in alerts:
    k = (t["lead"], t["akey"])
    now = dt.datetime.fromisoformat(t["ts"].replace("Z", "+00:00"))
    if k in last_seen and (now - last_seen[k]).total_seconds() <= 6 * 3600:
        rep["turns"] += 1
        rep["tokens"] += t["tok"]
        rep["weighted"] += round(t["w"])
    last_seen[k] = now
rep["alert_turns_total"] = len(alerts)
rep["alert_tokens_total"] = sum(t["tok"] for t in alerts)
rep["distinct_titles"] = len({(t["lead"], t["akey"]) for t in alerts})
M["wake_B_repeat_alert_6h"] = rep
M["wake_founder"] = dict(turns=sum(1 for t in turn_list if t["kind"] == "founder_or_mixed_with_founder"),
                         tokens=sum(t["tok"] for t in turn_list if t["kind"] == "founder_or_mixed_with_founder"))
M["lead_turns_total"] = len(turn_list)

# W3 polling: requests triggered by wait/poll tool calls (the request re-reads the whole context)
poll = collections.defaultdict(lambda: dict(requests=0, tokens=0, weighted=0))
mixed_wait = dict(requests=0, tokens=0)
for vendor, reqs in (("claude", creq), ("codex", xreq)):
    for r in reqs:
        parts = r["trigger"].split("+")
        if all(p.startswith("wait:") for p in parts):  # request triggered only by pure-wait calls
            k = f"{vendor}|{r['bucket']}|{parts[0]}"
            poll[k]["requests"] += 1
            poll[k]["tokens"] += r["tot"]
            poll[k]["weighted"] += round(r["w"])
        elif "bash:mixed-with-wait" in parts:
            mixed_wait["requests"] += 1
            mixed_wait["tokens"] += r["tot"]
M["poll_requests"] = dict(sorted(poll.items(), key=lambda kv: -kv[1]["tokens"]))
M["mixed_wait_not_counted"] = mixed_wait
trig_tot = collections.defaultdict(lambda: [0, 0])
for vendor, reqs in (("claude", creq), ("codex", xreq)):
    for r in reqs:
        for part in r["trigger"].split("+"):
            trig_tot[f"{vendor}|{part}"][0] += 1
            trig_tot[f"{vendor}|{part}"][1] += r["tot"] / (r["trigger"].count("+") + 1)
M["requests_by_trigger"] = {k: dict(requests=v[0], tokens=round(v[1])) for k, v in
                            sorted(trig_tot.items(), key=lambda kv: -kv[1][1])[:40]}

# W4 runner wakes by Monitor / background task notifications
for kind in ("task_notification:monitor", "task_notification:background"):
    tn = [r for r in creq if r["bucket"] == "runner" and r["subagent"] == "0" and r["turn_kind"] == kind]
    M["runner_" + kind.replace(":", "_")] = dict(requests=len(tn), tokens=sum(r["tot"] for r in tn), weighted=wsum(tn),
                                                 turns=len({(r["file_id"], r["turn_seq"]) for r in tn}))

# W5 fixed prefix above a 45k floor (the smallest Claude Lead prefix observed: infra-bot)
FLOOR = 45_000
pre = collections.Counter()
for f in cfiles.values():
    if f["subagent"] == "0" and I(f["requests"]) >= 5:
        pre[f["bucket"]] += max(0, I(f["min_ctx"]) - FLOOR) * I(f["requests"])
M["prefix_above_45k_by_bucket"] = dict(pre)
M["prefix_above_45k_runner_review_qa"] = pre["runner"] + pre["review"] + pre["qa_env"]
M["prefix_floor"] = FLOOR

# W6 large tool outputs: re-read tokens of the part above 5k tokens per output
CAP = 5_000
big = collections.defaultdict(lambda: dict(outputs=0, reread_above_cap=0))
for vendor, name in (("claude", "claude_tool_outputs.csv"), ("codex", "codex_tool_outputs.csv")):
    for r in rows(name):
        if r["in_ctx_tokens"] == "":
            continue  # growth not attributable (other input arrived in between)
        tk, n = I(r["in_ctx_tokens"]), I(r["later_requests_same_ctx"])
        if tk > CAP:
            k = f"{vendor}|{r['tool_class']}"
            big[k]["outputs"] += 1
            big[k]["reread_above_cap"] += (tk - CAP) * n
M["big_output_reread_above_5k"] = dict(sorted(big.items(), key=lambda kv: -kv[1]["reread_above_cap"])[:20])
M["big_output_reread_above_5k_total"] = {v: sum(d["reread_above_cap"] for k, d in big.items() if k.startswith(v))
                                         for v in ("claude", "codex")}

# W7 reviews
rj = out["review_job_tokens"]
M["review_discarded"] = {k: v for k, v in rj.items() if "round" not in k and not k.endswith(":done")}
M["review_discarded_tokens"] = sum(v["tokens"] for v in M["review_discarded"].values())
M["review_round3plus_tokens"] = sum(v["tokens"] for k, v in rj.items() if any(k.endswith(x) for x in ("round3", "round4", "round5+")))
M["review_total_tokens"] = sum(v["tokens"] for k, v in rj.items() if "round" in k)

# W8 runner / review context above 250k handled in W1 (claude_runner_review_cache_read_above_*)
# W9 post-terminal
M["post_terminal_total"] = sum(v["tokens"] for v in out["post_terminal"].values())

# W10 ack round trip: requests triggered ONLY by the inbox ack tool result
ack = [r for r in creq if r["trigger"] == "mcp__flywheel-inbox__flywheel_inbox_ack_batch"]
ack_end = [r for r in ack if r["calls_tools"] == "0"]
M["ack_solo_ended_turn"] = dict(requests=len(ack_end), tokens=sum(r["tot"] for r in ack_end), weighted=wsum(ack_end))
M["ack_solo"] = dict(requests=len(ack), tokens=sum(r["tot"] for r in ack), weighted=wsum(ack),
                     by_sub=dict(collections.Counter({r["sub"]: 0 for r in ack}) + collections.Counter()),
                     avg_output=round(statistics.mean(I(r["output"]) for r in ack)) if ack else 0)
bs = collections.Counter()
for r in ack:
    bs[r["sub"]] += r["tot"]
M["ack_solo"]["by_sub"] = dict(bs.most_common())
M["poll_total"] = dict(requests=sum(v["requests"] for v in poll.values()),
                       tokens=sum(v["tokens"] for v in poll.values()),
                       weighted=sum(v["weighted"] for v in poll.values()))
out["mechanisms"] = M
json.dump(out, open(os.path.join(DER, "summary.json"), "w"), indent=1, ensure_ascii=False, default=str)
