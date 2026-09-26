#!/usr/bin/env python3
"""FLY-2893 (Lead clue 6e689d44): are Codex 401 / refresh-token / identity deaths near account switches?

Read-only. An account switch on a Codex home is inferred from rollout token_count events:
rate_limits.primary.resets_at identifies one account-week, so within one home a change of
resets_at (minute bucket, ignoring 0%-used fresh buckets that drift with "now") between
consecutive events marks a switch. Also reads ~/.codex/log/codex-login.log for interactive
login times (timestamps only).

Outputs ../raw/codex_switches.csv and ../derived/switch_correlation.csv:
for every K3 incident (credential/identity), the nearest prior credential operation on the GLOBAL ~/.codex (login start/finish, profile swap).\nFingerprint changes on runner homes are exported for context only.
"""
import csv
import datetime as dt
import glob
import json
import os
import re

import usage  # reuse rollout parsing + home labels

H = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "raw")
OUT = os.path.join(HERE, "..", "derived")


def main():
    freeze = json.load(open(os.path.join(RAW, "freeze.json")))
    t0, frozen = usage.parse_ts(freeze["T0"]), usage.parse_ts(freeze["frozen_at"])
    per_home = {}
    roots = [f"{H}/.flywheel/codex-homes", f"{H}/.flywheel/codex-homes-exp"] + glob.glob(f"{H}/.codex*/sessions")
    seen = set()
    for root in roots:
        for dp, _, fn in os.walk(root):
            for n in fn:
                if not re.match(rf"rollout-.*-{usage.UUID}\.jsonl$", n) or n in seen:
                    continue
                p = os.path.join(dp, n)
                if os.path.getmtime(p) < t0.timestamp():
                    continue
                seen.add(n)
                hl = usage.home_label(p)
                for ts, _d, _t, pct, rkey in usage.codex_events([p], frozen):
                    if rkey is None or ts < t0 or not pct:
                        continue  # 0%-used buckets drift with "now"; not an identity
                    per_home.setdefault(hl, []).append((ts, rkey))
    switches = []
    for hl, evs in per_home.items():
        evs.sort()
        prev = None
        for ts, k in evs:
            if prev is not None and abs(k - prev) > 5:  # >5 min apart = different account-week
                switches.append((ts, hl, "fingerprint_change"))
            prev = k
    log = f"{H}/.codex/log/codex-login.log"
    if os.path.exists(log):
        for line in open(log, errors="replace"):
            m = re.match(r"(\S+Z)\s+INFO .*(oauth token exchange succeeded|starting \w+ (?:code )?login flow)", line)
            if m:
                t = usage.parse_ts(m.group(1))
                kind = "login_completed" if "succeeded" in m.group(2) else "login_started"
                if t and t0 <= t <= frozen:
                    switches.append((t, "~/.codex(global)", kind))
    # codex-profile leaves ~/.codex/auth.json.bak-<profile>-<UTC stamp> when it swaps the global credential.
    for p in glob.glob(f"{H}/.codex/auth.json.bak-*"):
        m = re.search(r"(\d{8}T\d{6})Z$", p)
        if m:
            t = dt.datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=dt.timezone.utc)
            if t0 <= t <= frozen:
                switches.append((t, "~/.codex(global)", "profile_swap_backup"))
    switches.sort()
    with open(os.path.join(RAW, "codex_switches.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["ts", "codex_home", "kind"])
        for t, hl, k in switches:
            w.writerow([usage.iso(t), hl, k])

    rows = []
    inc = list(csv.DictReader(open(os.path.join(OUT, "incidents.csv"))))
    for i in inc:
        if i["class_key"] != "K3":
            continue
        ti = usage.parse_ts(i["t_i"])
        before = [s for s in switches if s[0] <= ti and s[1] == "~/.codex(global)"]
        near = before[-1] if before else None
        gap = round((ti - near[0]).total_seconds() / 60, 1) if near else ""
        rows.append([i["execution_id"], i["issue"], i["subclass"], i["t_i"],
                     usage.iso(near[0]) if near else "", near[1] if near else "",
                     near[2] if near else "", gap])
    # Baseline: how often is a random minute within 60 min after a switch?
    span = (frozen - t0).total_seconds() / 60
    covered = set()
    for t, h, _k in switches:
        if h != "~/.codex(global)":
            continue
        base = int((t - t0).total_seconds() // 60)
        covered.update(range(base, base + 60))
    baseline = round(len([m for m in covered if 0 <= m < span]) / span, 3)
    with open(os.path.join(OUT, "switch_correlation.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["execution_id", "issue", "subclass", "t_i", "nearest_prior_switch", "switch_home",
                    "switch_kind", "minutes_after_switch"])
        w.writerows(rows)
    within = sum(1 for r in rows if r[7] != "" and r[7] <= 60)
    json.dump({"k3_incidents": len(rows), "within_60min": within,
               "within_12min": sum(1 for r in rows if r[7] != "" and r[7] <= 12),
               "baseline_share_of_minutes_within_60min": baseline,
               "global_credential_operations": sum(1 for s in switches if s[1] == "~/.codex(global)")},
              open(os.path.join(OUT, "switch_summary.json"), "w"), indent=2)
    print(f"switches={len(switches)} K3={len(rows)} within60min={within} baseline_share_of_minutes_within60={baseline}")


if __name__ == "__main__":
    main()
