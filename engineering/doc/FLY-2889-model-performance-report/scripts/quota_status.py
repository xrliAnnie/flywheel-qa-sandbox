#!/usr/bin/env python3
"""FLY-2889: export current weekly quota readings (alias, plan, %, reset, observedAt) only.
Reads ~/.flywheel/codex-quota/codex-accounts.json and ~/.flywheel/claude-accounts.json;
never exports identity keys, credentials or credit balances."""
import csv, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "quota_status.csv")
rows = []
cx = json.load(open(os.path.expanduser("~/.flywheel/codex-quota/codex-accounts.json")))
for a in cx.get("accounts", []):
    w = a.get("weekly") or {}
    rows.append(("codex", a.get("name"), a.get("planType"), a.get("name") == cx.get("activeAccount"),
                 w.get("usedPercent"), w.get("resetAt"), a.get("observedAt"), a.get("authHealth")))
cl = json.load(open(os.path.expanduser("~/.flywheel/claude-accounts.json")))
accs = cl.get("accounts", cl)
items = accs.items() if isinstance(accs, dict) else [(a.get("name") or a.get("alias"), a) for a in accs]
for name, a in items:
    if not isinstance(a, dict):
        continue
    rows.append(("claude", name, a.get("tier") or a.get("planType"), name == cl.get("activeAccount"),
                 a.get("observedSevenDPct"), a.get("weeklyResetAt"), a.get("lastObservedAt"),
                 a.get("status") or a.get("state")))
with open(OUT, "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["vendor", "account", "plan", "active", "weekly_used_pct", "weekly_reset_at",
                "observed_at", "health"])
    w.writerows(rows)
for r in rows:
    print(r)
