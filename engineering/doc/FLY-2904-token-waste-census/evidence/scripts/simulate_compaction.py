#!/usr/bin/env python3
"""FLY-2904: replay Lead requests under a hypothetical auto-compact window (read-only).

For each Lead transcript (non-subagent), walk requests in order. Observed context growth
between consecutive requests is kept; a drop > 40% is treated as an observed compaction /
restart and resets the simulated context to the observed value. When the simulated context
would exceed WINDOW, a compaction is charged (one request reading the whole context plus a
cache write of the post-compaction floor) and the simulated context resets to FLOOR.
Saving = observed - simulated raw tokens (input + cache write + cache read + output).
All quantities are raw tokens; the window, floor, growth replay and compaction count are
model assumptions, not a prediction of production behaviour. Model is deliberately
simple; it ignores second-order effects (post-compaction re-reads of docs), stated in plan.md.
"""
import collections
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "raw")
DER = os.path.join(HERE, "..", "derived")
POST_COMPACT_EXTRA = 25_000  # summary tokens added on top of the session's own floor


def run(window):
    by_file = collections.defaultdict(list)
    for r in csv.DictReader(open(os.path.join(RAW, "claude_requests.csv"))):
        if r["bucket"] == "lead" and r["subagent"] == "0":
            by_file[r["file_id"]].append(r)
    res = collections.defaultdict(lambda: dict(observed=0, simulated=0, compactions=0, requests=0))
    for fid, rs in by_file.items():
        rs.sort(key=lambda r: r["ts"])
        ctxs = [int(r["ctx"]) for r in rs]
        floor = min(ctxs) + POST_COMPACT_EXTRA
        sim = None
        prev = None
        d = res[rs[0]["sub"]]
        for r, c in zip(rs, ctxs):
            obs = int(r["input"]) + int(r["cache_creation"]) + int(r["cache_read"])
            d["observed"] += obs + int(r["output"])
            d["requests"] += 1
            if prev is None or c < 0.6 * prev:
                sim = c
            else:
                sim += c - prev
            prev = c
            if sim > window:
                d["compactions"] += 1
                d["simulated"] += sim + 4_000 + floor  # summary request + rebuild (raw tokens)
                sim = floor
            d["simulated"] += min(sim, obs) + int(r["output"])
    return res


if __name__ == "__main__":
    out = {}
    for w in (250_000, 400_000):
        res = run(w)
        tot_o = sum(v["observed"] for v in res.values())
        tot_s = sum(v["simulated"] for v in res.values())
        out[str(w)] = dict(observed=tot_o, simulated=tot_s, saving=tot_o - tot_s,
                           compactions=sum(v["compactions"] for v in res.values()),
                           by_lead={k: dict(v, saving=v["observed"] - v["simulated"]) for k, v in res.items()})
        print(w, round(tot_o / 1e6), round(tot_s / 1e6), "saving", round((tot_o - tot_s) / 1e6),
              "compactions", out[str(w)]["compactions"])
        for k, v in sorted(res.items(), key=lambda kv: -(kv[1]["observed"] - kv[1]["simulated"]))[:5]:
            print("   ", k, round((v["observed"] - v["simulated"]) / 1e6), v["compactions"])
    json.dump(out, open(os.path.join(DER, "compaction_simulation.json"), "w"), indent=1)
