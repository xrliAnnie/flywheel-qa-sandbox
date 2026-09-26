#!/usr/bin/env python3
"""FLY-2910 design replay v2 (after design review R1): strict equivalence model.

A letter is merged only if an EQUIVALENT letter was delivered to the same Lead within a FIXED 6h window
that started at that equivalent's first delivery, with severity >= the new one, in the same ticket
generation. Equivalent = same kind + same raw title + same canonical body (only ISO/clock timestamps and
per-kind volatile fields folded; ids/numbers kept). Truncated aggregate lists never prove equivalence.
info (non-actionable kinds) -> digest. Unknown shapes -> wake. Read-only on CommDB + StateStore.
"""
import json, re, sqlite3, sys, collections, hashlib, datetime as dt, os
sys.path.insert(0, os.path.dirname(__file__))
from replay_0925 import parse_mailbox, parse_discord, SEV_RANK  # noqa: E402

COMM = os.path.expanduser("~/.flywheel/comm/flywheel/comm.db")
TL = os.path.expanduser("~/.flywheel/teamlead.db")
START, END = (sys.argv[1:3] if len(sys.argv) > 2 else ("2026-09-25T07:00:00Z", "2026-09-26T04:00:00Z"))
WINDOW = 6 * 3600
INFO_WAKE_KINDS = {"flag_scan_handoff"}
VOLATILE = {"cmux_watcher_stalled": [re.compile(r"\b(heartbeat_age_ms|event_age_ms)=[\d.]+")]}
TS = [re.compile(r"\d{4}-\d{2}-\d{2}T[\d:.]+Z?")]
TRUNC = re.compile(r"仅列前\s*\d+|\(\+\d+ more\)|…共\s*\d+\s*个")


def canon(kind, title, body):
    lines = []
    for b in body:
        if b.startswith("🎫"):
            continue
        for p in TS + VOLATILE.get(kind, []):
            b = p.sub("<v>", b)
        lines.append(b.rstrip())
    return hashlib.sha256(("\x00".join([kind, title] + lines)).encode()).hexdigest()[:16]


def load():
    c = sqlite3.connect(f"file:{COMM}?mode=ro", uri=True)
    t = sqlite3.connect(f"file:{TL}?mode=ro", uri=True)
    rows, members = [], collections.Counter()
    q = ("select to_agent, created_at, source_kind, content, batch_id, type, source_ref, delivered_at, state from mailbox "
         "where recipient_kind='lead' and created_at>=? and created_at<? and (source_kind='infra_alert' or "
         "(source_kind='discord_chat' and content like '%flywheel-alerts-dispatcher%'))")
    for to, ca, sk, ct, batch, typ, sref, deliv, state in c.execute(q, (START, END)):
        if sk == "infra_alert":
            if not ct.startswith("[infra_alert]"):
                continue
            title, tail, body = parse_mailbox(ct)
            # Ledger/thread tables keep only the LATEST generation per correlation key, so a historical
            # lookup by an old eventId misses. At decision time the row's own ticket is present; the
            # replay approximates the generation by the correlation key (project|lead|kind|session) and
            # therefore cannot see resolve->recur inside the window (caveat recorded in the output).
            gen = (tail.get("project"), tail.get("affected") or tail.get("owner"), tail.get("event"), tail.get("session"))
            carrier = "A"
        else:
            title, tail, body = parse_discord(ct)
            j, _ = json.JSONDecoder().raw_decode(ct[ct.find("{"):])
            gen = ("B", tail.get("affected"), tail.get("event"), title)  # same approximation, see above
            carrier = "B"
        kind = tail.get("event", "?")
        truncated = bool(TRUNC.search("\n".join(body)))
        fp = canon(kind, title, body)
        # Known shape with a trusted producer identity: the zombie eventId embeds the sha256 of the FULL
        # sorted (shape:executionId) set (fleet-sensors.ts:666-691), so a truncated sample list is still provable.
        m = re.match(r"zombie-backlog:([0-9a-f]{16}):", sref or "") if carrier == "A" else None
        if kind == "zombie_session_backlog" and m:
            fp, truncated = hashlib.sha256(f"{kind}\x00{title}\x00{m.group(1)}".encode()).hexdigest()[:16], False
        rows.append(dict(lead=to, ts=dt.datetime.fromisoformat(ca.replace("Z", "+00:00")), carrier=carrier, kind=kind,
                         title=title, sev=tail.get("severity", "warning"), fp=fp, gen=gen,
                         truncated=truncated, batch=batch, delivered=deliv is not None))
    ids = {r["batch"] for r in rows if r["batch"]}
    for (b,) in c.execute("select batch_id from mailbox where batch_id is not null and created_at>=? and created_at<?",
                          (START, END)):
        if b in ids:
            members[b] += 1
    rows.sort(key=lambda r: r["ts"])
    return rows, members


def replay(rows):
    notified = {}  # (lead, fp) -> dict(start, sev, gen)
    out = []
    for r in rows:
        if r["sev"] == "info" and r["kind"] not in INFO_WAKE_KINDS:
            out.append((r, "digest", "info")); continue
        k = (r["lead"], r["fp"])
        n = notified.get(k)
        reason = None
        if r["truncated"]:
            reason = "unprovable_truncated"
        elif r["gen"] is None or os.environ.get("GEN_MODE") == "verified":
            # "verified" column: historical letters have no alert_letter_ticket mapping, so the production
            # interface would report the generation as unknown -> wake (lower bound).
            reason = "no_ticket_generation"
        elif n is None or (r["ts"] - n["start"]).total_seconds() > WINDOW:
            reason = "first_or_expired"
        elif SEV_RANK.get(r["sev"], 1) > n["sev"]:
            reason = "severity_up"
        elif n["gen"] != r["gen"]:
            reason = "new_ticket_generation"
        if reason:
            out.append((r, "wake", reason))
            # replay assumes the woken letter is delivered (all 9-25 rows were ACKED)
            if n is None or reason == "first_or_expired":
                notified[k] = dict(start=r["ts"], sev=SEV_RANK.get(r["sev"], 1), gen=r["gen"])
            else:
                n["sev"] = max(n["sev"], SEV_RANK.get(r["sev"], 1)); n["gen"] = r["gen"]
        else:
            out.append((r, "suppress", "equivalent_delivered"))
    return out


def main():
    rows, members = load()
    out = replay(rows)
    before = {r["batch"] for r in rows if r["batch"]}
    quiet = collections.Counter(r["batch"] for r, d, _ in out if d != "wake" and r["batch"])
    after = before - {b for b, n in quiet.items() if n == members.get(b, 0)}
    lead_of = {r["batch"]: r["lead"] for r in rows}
    per = collections.defaultdict(collections.Counter)
    for r, d, why in out:
        per[(r["lead"], r["carrier"], r["kind"], re.sub(r"\d+", "<n>", r["title"])[:90])][f"{d}:{why}"] += 1
    res = dict(model="strict-equivalence-v2", gen_mode=os.environ.get("GEN_MODE", "assumed_same"),
               caveat="ticket generation approximated by correlation key; resolve->recur inside a window is not visible", window_utc=[START, END], letters=len(rows),
               before_wake_batches=len(before), before_by_lead=dict(collections.Counter(lead_of[b] for b in before)),
               after_wake_batches=len(after), after_by_lead=dict(collections.Counter(lead_of[b] for b in after)),
               reasons=dict(collections.Counter(f"{d}:{w}" for _, d, w in out)),
               per_key=[dict(lead=k[0], carrier=k[1], kind=k[2], title=k[3], **v)
                        for k, v in sorted(per.items(), key=lambda kv: -sum(kv[1].values()))])
    json.dump(res, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
