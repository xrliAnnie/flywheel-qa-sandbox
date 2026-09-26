#!/usr/bin/env python3
"""FLY-2904: split runner <task-notification> wakes into Monitor stream events vs background
task terminal notices (read-only). Writes counts only to ../derived/task_notification_split.json."""
import collections
import glob
import json
import os
import re

H = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
T0, T1 = "2026-09-11T22", "2026-09-25T22"
c = collections.Counter()
for f in glob.glob(H + "/.claude/projects/-Users-xiaorongli-Dev-flywheel-FLY-*/*.jsonl"):
    with open(f, errors="replace") as fh:
        for line in fh:
            if "<task-notification>" not in line or '"type":"user"' not in line:
                continue
            o = json.loads(line)
            if not (T0 <= o.get("timestamp", "") < T1):
                continue
            cc = (o.get("message") or {}).get("content", "")
            t = cc if isinstance(cc, str) else "\n".join(
                b.get("text", "") for b in cc if isinstance(b, dict) and b.get("type") == "text")
            if not t.lstrip().startswith("<task-notification>"):
                continue
            if "Monitor event" in t:
                c["monitor_event"] += 1
            else:
                m = re.search(r"<status>(\w+)", t)
                c["background_task_" + (m.group(1) if m else "other")] += 1
json.dump(dict(c), open(os.path.join(HERE, "..", "derived", "task_notification_split.json"), "w"), indent=1)
print(dict(c))
