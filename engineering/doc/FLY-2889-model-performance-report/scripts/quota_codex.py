#!/usr/bin/env python3
"""FLY-2889 Codex quota scenario estimate (read-only).

Scans Codex rollout JSONL files under ~/.flywheel/codex-homes (and ~/.codex/sessions
if present) modified since --since, reading only `token_count` events. Each event
carries rate_limits.primary (used_percent, window_minutes, resets_at): resets_at
identifies one account-week ("fingerprint"). Per fingerprint we sum per-file
deltas of total_token_usage and relate them to the observed percentage change.

Output: ../data/codex_quota_fingerprints.csv (no message content, no identities).
"""
import csv
import datetime as dt
import glob
import json
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "codex_quota_fingerprints.csv")
ROOTS = [os.path.expanduser("~/.flywheel/codex-homes"), os.path.expanduser("~/.codex/sessions")]


def main():
    since = sys.argv[sys.argv.index("--since") + 1] if "--since" in sys.argv else "2026-09-23T00:00:00Z"
    since_ts = dt.datetime.fromisoformat(since.replace("Z", "+00:00")).timestamp()
    files = []
    for root in ROOTS:
        for p in glob.glob(os.path.join(root, "**", "rollout-*.jsonl"), recursive=True):
            try:
                if os.path.getmtime(p) >= since_ts:
                    files.append(p)
            except OSError:
                pass
    fp = defaultdict(lambda: {"tokens": 0, "input": 0, "cached": 0, "output": 0,
                              "min_pct": None, "max_pct": None, "first": None, "last": None,
                              "events": 0, "files": set(), "plan": set(), "series": []})
    for p in files:
        prev_total = None
        prev = {"input": 0, "cached": 0, "output": 0}
        with open(p, errors="replace") as fh:
            for line in fh:
                if '"token_count"' not in line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                pl = row.get("payload") or {}
                if pl.get("type") != "token_count":
                    continue
                rl = (pl.get("rate_limits") or {}).get("primary") or {}
                info = pl.get("info") or {}
                tot = (info.get("total_token_usage") or {})
                if not rl or rl.get("window_minutes") != 10080 or not tot:
                    continue
                total = tot.get("total_tokens")
                if total is None:
                    continue
                cur = {"input": tot.get("input_tokens", 0), "cached": tot.get("cached_input_tokens", 0),
                       "output": tot.get("output_tokens", 0)}
                if prev_total is None or total < prev_total:
                    delta, dcomp = 0, {k: 0 for k in cur}  # file start / reset: baseline only
                else:
                    delta = total - prev_total
                    dcomp = {k: cur[k] - prev[k] for k in cur}
                prev_total, prev = total, cur
                key = int(rl.get("resets_at") or 0) // 60  # minute bucket absorbs 1-2 s jitter
                f = fp[key]
                ts = row.get("timestamp")
                pct = rl.get("used_percent")
                f["tokens"] += delta
                for k, v in dcomp.items():
                    f[k] += max(v, 0)
                f["events"] += 1
                f["files"].add(p)
                if rl.get("plan_type"):
                    f["plan"].add(rl.get("plan_type"))
                f["series"].append((ts or "", pct, delta, dcomp))
                if pct is not None:
                    f["min_pct"] = pct if f["min_pct"] is None else min(f["min_pct"], pct)
                    f["max_pct"] = pct if f["max_pct"] is None else max(f["max_pct"], pct)
                if ts:
                    f["first"] = ts if f["first"] is None else min(f["first"], ts)
                    f["last"] = ts if f["last"] is None else max(f["last"], ts)
    with open(OUT, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["fingerprint_resets_at_utc", "plan", "events", "files", "first", "last",
                    "min_pct", "max_pct", "delta_pct", "tokens_total", "tokens_input",
                    "tokens_cached_input", "tokens_output", "pct_per_100M_total_tokens",
                    "pct_per_1M_uncached_plus_output"])
        for key, f in sorted(fp.items()):
            dp = (f["max_pct"] - f["min_pct"]) if f["min_pct"] is not None else None
            # Only count tokens until the percentage first reaches its maximum, so
            # usage logged while capped at 100% does not dilute the rate.
            ser = sorted(f["series"], key=lambda e: e[0])
            if dp:
                cut = next(i for i, e in enumerate(ser) if e[1] == f["max_pct"])
                ser = ser[:cut + 1]
                f["tokens"] = sum(e[2] for e in ser)
                for k in ("input", "cached", "output"):
                    f[k] = sum(max(e[3][k], 0) for e in ser)
                f["last"] = ser[-1][0]
            unc = f["input"] - f["cached"] + f["output"]
            w.writerow([dt.datetime.fromtimestamp(key * 60, dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
                        "|".join(sorted(f["plan"])), f["events"], len(f["files"]), f["first"],
                        f["last"], f["min_pct"], f["max_pct"], dp, f["tokens"], f["input"],
                        f["cached"], f["output"],
                        round(dp / f["tokens"] * 1e8, 3) if dp and f["tokens"] else None,
                        round(dp / unc * 1e6, 4) if dp and unc > 0 else None])
    print(f"files={len(files)} fingerprints={len(fp)} -> {OUT}")


if __name__ == "__main__":
    main()
