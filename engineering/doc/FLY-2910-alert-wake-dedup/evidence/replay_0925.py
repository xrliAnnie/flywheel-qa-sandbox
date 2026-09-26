#!/usr/bin/env python3
"""FLY-2910 design-stage replay: 9-25 (America/Los_Angeles day) alert wakes, before vs after.

Read-only over CommDB mailbox. Two wake carriers are covered:
  - Bridge mailbox rows with source_kind='infra_alert'  (the "[infra_alert] <title>" letters)
  - Discord deliveries authored by flywheel-alerts-dispatcher (ticket posts in the alerts channel)
Stores no alert text in the output: titles are emitted normalized (ids/numbers folded).
"""
import json, re, sqlite3, sys, collections, datetime as dt, os

DB = os.path.expanduser("~/.flywheel/comm/flywheel/comm.db")
START = sys.argv[1] if len(sys.argv) > 1 else "2026-09-25T07:00:00Z"
END = sys.argv[2] if len(sys.argv) > 2 else "2026-09-26T07:00:00Z"
WINDOW = 6 * 3600
INFO_ACTIONABLE = {"flag_scan_handoff"}
SEV_RANK = {"info": 0, "warning": 1, "warn": 1, "severe": 2, "critical": 3}

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
HEX = re.compile(r"\b[0-9a-f]{12,64}\b", re.I)
ISSUE = re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d+\b")
TS = re.compile(r"\d{4}-\d{2}-\d{2}T[\d:.]+Z?")
NUM = re.compile(r"\d+(?:\.\d+)?")


def norm(s):
    s = TS.sub("<ts>", s)
    s = UUID.sub("<id>", s)
    s = HEX.sub("<hex>", s)
    s = ISSUE.sub("<issue>", s)
    s = NUM.sub("<n>", s)
    return re.sub(r"\s+", " ", s).strip()


def parse_mailbox(content):
    lines = content.split("\n")
    title = lines[0].removeprefix("[infra_alert] ").strip()
    tail = {}
    for ln in reversed(lines):
        if ln.startswith("event="):
            tail = dict(kv.split("=", 1) for kv in ln.split() if "=" in kv)
            break
    body = [ln for ln in lines[1:] if not ln.startswith("event=")]
    return title, tail, body


def parse_discord(content):
    j, _ = json.JSONDecoder().raw_decode(content[content.find("{"):])
    text = j.get("text", "")
    first = text.split("\n", 1)[0]
    m = re.search(r"\*\*(.+?)\*\*\s*\(([^/]+) / ([^)]+)\)", first)
    title = m.group(1) if m else first
    sev = "severe" if "🚨" in first else ("warning" if "⚠️" in first else "info")
    tail = {"event": m.group(3).strip() if m else "?", "severity": sev,
            "affected": m.group(2).strip() if m else ""}
    body = text.split("\n")[1:]
    return title, tail, body


def obj_of(title, tail, body):
    """The alerted object: explicit session, else issue id, else affected."""
    if tail.get("session"):
        return "s:" + tail["session"]
    m = ISSUE.search(title) or ISSUE.search(" ".join(body))
    if m:
        return "i:" + m.group(0)
    return "a:" + tail.get("affected", "")


def action_sig(body):
    """Normalized set of body lines = what the alert asks for (ids/numbers folded)."""
    return frozenset(norm(b) for b in body if b.strip() and not b.startswith("🎫"))


def count_of(title):
    m = re.search(r"(\d+)\s*个|(\d+) minutes|\((\d+)", title)
    return int(next(g for g in m.groups() if g)) if m else None


def load():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = []
    for tbl in ("mailbox", "mailbox_archive"):
        q = (f"select to_agent, created_at, source_kind, content, batch_id, type from {tbl} "
             "where recipient_kind='lead' and created_at>=? and created_at<? and "
             "(source_kind='infra_alert' or (source_kind='discord_chat' and content like '%flywheel-alerts-dispatcher%'))")
        for to, ca, sk, ct, batch, typ in c.execute(q, (START, END)):
            if sk == "infra_alert" and typ != "alert_handoff" and ct.startswith("[infra_alert]"):
                title, tail, body = parse_mailbox(ct)
                carrier = "mailbox"
            elif sk == "discord_chat":
                title, tail, body = parse_discord(ct)
                carrier = "discord"
            else:
                continue
            rows.append(dict(lead=to, ts=dt.datetime.fromisoformat(ca.replace("Z", "+00:00")), carrier=carrier,
                             title=title, key=norm(title), sev=tail.get("severity", "warning"),
                             event=tail.get("event", "?"), obj=obj_of(title, tail, body),
                             act=action_sig(body), count=count_of(title), batch=batch))
    rows.sort(key=lambda r: r["ts"])
    members = collections.Counter()
    ids = {r["batch"] for r in rows if r["batch"]}
    for tbl in ("mailbox", "mailbox_archive"):
        for (b,) in c.execute(f"select batch_id from {tbl} where batch_id is not null and created_at>=? and created_at<?",
                              (START, END)):
            if b in ids:
                members[b] += 1
    return rows, members


def replay(rows, mode):
    """mode: 'title' = FLY-2904 title-only; 'full' = FLY-2910 escalation rules
    (count = the alert's own number); 'full_occ' = same, but "count doubled" means the
    window's occurrence count reached 2x the count at the last wake."""
    win = {}  # (lead, key) -> state
    out = []
    for r in rows:
        k = (r["lead"], r["key"])
        st = win.get(k)
        if r["sev"] == "info" and mode != "title" and r["event"] not in INFO_ACTIONABLE:
            out.append((r, "digest", "info"))
            continue
        if st is None or (r["ts"] - st["opened"]).total_seconds() > WINDOW:
            win[k] = dict(opened=r["ts"], sev=SEV_RANK.get(r["sev"], 1), objs={r["obj"]}, acts={r["act"]},
                          count=r["count"], n=1)
            out.append((r, "wake", "first"))
            continue
        st["n"] += 1
        if mode == "title":
            out.append((r, "suppress", "repeat"))
            continue
        reason = None
        if SEV_RANK.get(r["sev"], 1) > st["sev"]:
            reason = "severity_up"
        elif mode == "full_occ" and st["n"] >= 2 * st.get("n_at_wake", 1):
            reason = "occurrences_doubled"
        elif mode != "full_occ" and r["count"] is not None and st["count"] and r["count"] >= 2 * st["count"]:
            reason = "count_doubled"
        elif r["obj"] not in st["objs"]:
            reason = "new_object"
        elif r["act"] not in st["acts"]:
            reason = "new_action"
        if reason:
            st["sev"] = max(st["sev"], SEV_RANK.get(r["sev"], 1))
            st["objs"].add(r["obj"]); st["acts"].add(r["act"])
            if r["count"]:
                st["count"] = r["count"]
            st["n_at_wake"] = st["n"]
            out.append((r, "wake", reason))
        else:
            out.append((r, "suppress", "repeat"))
    return out


def main():
    rows, members = load()
    res = {"window_utc": [START, END], "letters": len(rows)}
    by_lead = collections.Counter(r["lead"] for r in rows)
    res["before_letters_by_lead"] = dict(by_lead)
    before_batches = {r["batch"] for r in rows if r["batch"]}
    res["before_wake_batches"] = len(before_batches)
    res["before_wake_batches_by_lead"] = dict(collections.Counter(
        next(r["lead"] for r in rows if r["batch"] == b) for b in before_batches))
    for mode in ("title", "full", "full_occ"):
        out = replay(rows, mode)
        quiet = collections.Counter(r["batch"] for r, d, _ in out if d != "wake" and r["batch"])
        # a wake disappears only when EVERY member of its batch (alert or not) went quiet
        gone = {b for b, n in quiet.items() if n == members.get(b, 0)}
        after = before_batches - gone
        wake = collections.Counter(r["lead"] for r, d, _ in out if d == "wake")
        reasons = collections.Counter(why for _, d, why in out)
        dispo = collections.Counter(d for _, d, _ in out)
        per_key = collections.defaultdict(collections.Counter)
        for r, d, why in out:
            per_key[(r["lead"], r["carrier"], r["event"], r["key"][:90])][d + ":" + why] += 1
        res[mode] = dict(wake_batches_after=len(after),
                         wake_batches_after_by_lead=dict(collections.Counter(
                             next(r["lead"] for r in rows if r["batch"] == b) for b in after)),
                         wake_by_lead=dict(wake), dispositions=dict(dispo), reasons=dict(reasons),
                         per_key=[dict(lead=k[0], carrier=k[1], event=k[2], key=k[3], **v)
                                  for k, v in sorted(per_key.items(), key=lambda kv: -sum(kv[1].values()))])
    json.dump(res, sys.stdout, ensure_ascii=False, indent=1, default=str)


if __name__ == "__main__":
    main()
