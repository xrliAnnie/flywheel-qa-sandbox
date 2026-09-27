#!/usr/bin/env python3
"""Reconstruct runtime turn boundaries, never equate inbox rows with wakes.

`extract` reads production databases read-only without copying them. Only
allowlisted metadata is frozen. `replay` needs only that public frozen input.
No policy proof is minted and no after-wake result is invented.
"""
import argparse
from contextlib import closing
import datetime as dt
import hashlib
import gzip
import json
import re
import sqlite3
from pathlib import Path

START = "2026-09-25T07:00:00Z"
END = "2026-09-26T07:00:00Z"
LEAD = "flywheel-eng-lead"
TARGETS = {"stage_changed", "session_started", "session_monitoring_reestablished", "workflow_replacement_eligibility"}
BATCH = re.compile(r"\[mailbox-batch ([^\s|\]]+)\s*\|\s*(\d+) messages\s*\|")
EVENT = re.compile(r"\[Event #(\d+)\]")


def millis(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return round(parsed.timestamp() * 1000)


def iso(value):
    return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def project_rows(session, rows):
    records = {}
    for row in rows:
        if not row.get("uuid") or not row.get("timestamp") or row.get("isSidechain"):
            continue
        item = {"id": row["uuid"], "parent": row.get("logicalParentUuid") if row.get("subtype") == "compact_boundary" else row.get("parentUuid"), "at": row["timestamp"], "kind": row.get("type")}
        message = row.get("message") or {}
        content = message.get("content") if isinstance(message, dict) else None
        if row.get("type") == "user" and isinstance(content, str):
            blocks = re.findall(r"<teammate-message\b[^>]*>(.*?)</teammate-message>", content, flags=re.S)
            blocks = [block.strip() for block in blocks if BATCH.match(block.strip())]
            if not blocks and BATCH.match(content.strip()):
                blocks = [content.strip()]
            framed = "\n".join(blocks)
            item.update(kind="input", meta=bool(row.get("isMeta")), compactSummary=bool(row.get("isCompactSummary")),
                        batches=[{"id": bid, "count": int(n)} for bid, n in BATCH.findall(framed)],
                        eventSeqs=sorted({int(seq) for seq in EVENT.findall(framed)}))
            # Unframed text, cron, commands and other triggers are retained.
            item["hasOtherInput"] = not item["batches"] or bool(re.sub(r"<teammate-message\b[^>]*>.*?</teammate-message>", "", content, flags=re.S).strip())
        if row.get("subtype") == "turn_duration":
            item.update(kind="turn_end", durationMs=row["durationMs"])
        if row.get("type") == "assistant":
            item["requestId"] = row.get("requestId")
        if item["id"] in records and records[item["id"]] != item:
            raise ValueError("Conflicting transcript UUID: " + item["id"])
        records[item["id"]] = item
    return {"sessionId": session, "records": list(records.values())}


def reconstruct(transcripts, mailbox, events):
    event_by_seq = {int(row["seq"]): row for row in events}
    by_batch = {}
    for row in mailbox:
        if row.get("batch_id"):
            members = by_batch.setdefault(row["batch_id"], {})
            key = row["delivery_id"]
            if key in members and members[key] != row:
                raise ValueError("Conflicting mailbox member: " + key)
            members[key] = row
    window_events = [row for row in events if row.get("created_at") and millis(START) <= millis(row["created_at"]) < millis(END)]
    unknown_events = [row for row in window_events if row["event_type"] in TARGETS and not row.get("actionGuardFields")]
    unchanged_events = [row for row in window_events if row["event_type"] not in TARGETS or row.get("actionGuardFields")]
    # Outside this change's four categories, the policy is unchanged. This is
    # a source-event comparison only; it cannot be promoted to a wake count.
    unchanged_model = sum(row["delivery_disposition"] == "model" for row in unchanged_events)
    event_comparison = {"metric": "source event disposition, not wakes", "total": len(window_events),
                        "reconstructable": len(unchanged_events), "unknown": len(unknown_events),
                        "unknownShare": len(unknown_events) / len(window_events) if window_events else None,
                        "beforeModel": unchanged_model, "afterModel": sum(row["delivery_disposition"] == "model" or bool(row.get("actionGuardFields")) for row in unchanged_events),
                        "basis": "Unchanged out-of-scope events and immutable nonempty last_error guards only; no quiet authority inferred.",
                        "unknownEventIds": [row["event_id"] for row in unknown_events]}
    turns = []
    unassigned = []
    for transcript in transcripts:
        records = {row["id"]: row for row in transcript["records"]}
        used_inputs = set()
        for marker in records.values():
            if marker["kind"] != "turn_end":
                continue
            duration = marker["durationMs"]
            if not isinstance(duration, (int, float)) or duration < 0:
                raise ValueError("Invalid runtime duration")
            end = millis(marker["at"])
            start = end - duration
            if not millis(START) <= start < millis(END):
                continue
            # Follow completion ancestry, not nearest wall time alone. The 1s
            # tolerance permits runtime serialization around the start boundary;
            # ambiguous or absent inputs remain explicitly unattributed.
            ancestors = []
            current = marker.get("parent")
            visited = set()
            missing_parent = None
            while current and current not in visited:
                visited.add(current)
                row = records.get(current)
                if row is None:
                    missing_parent = current
                    break
                if millis(row["at"]) < start - 1000 or row["kind"] == "turn_end":
                    break
                ancestors.append(row)
                current = row.get("parent")
            inputs = sorted([row for row in ancestors if row["kind"] == "input" and not row.get("compactSummary")], key=lambda row: (row["at"], row["id"]))
            candidates = [row for row in inputs if abs(millis(row["at"]) - start) <= 1000]
            trigger = candidates[0]["id"] if len(candidates) == 1 else None
            used_inputs.update(row["id"] for row in inputs)
            batches = {batch["id"]: batch for row in inputs for batch in row["batches"]}
            members = {}
            missing = []
            for bid, batch in sorted(batches.items()):
                found = by_batch.get(bid, {})
                if len(found) != batch["count"]:
                    missing.append({"batchId": bid, "expected": batch["count"], "found": len(found)})
                members.update(found)
            seqs = {seq for row in inputs for seq in row["eventSeqs"]}
            for member in members.values():
                if member.get("source_kind") == "lead_event":
                    try:
                        seqs.add(int(member["source_ref"]))
                    except (ValueError, TypeError):
                        missing.append({"deliveryId": member["delivery_id"], "reason": "invalid_source_ref"})
            for seq in sorted(seqs):
                if seq not in event_by_seq:
                    missing.append({"eventSeq": seq, "reason": "source_event_missing"})
            kinds = sorted({row.get("source_kind") or "unknown" for row in members.values()})
            types = sorted({event_by_seq[seq]["event_type"] for seq in seqs if seq in event_by_seq})
            other = not inputs or any(row["hasOtherInput"] for row in inputs)
            only_targets = bool(trigger and types and members and not missing and not other and set(kinds) == {"lead_event"} and set(types) <= TARGETS)
            turns.append({"sessionId": transcript["sessionId"], "markerId": marker["id"], "startedAt": iso(start), "endedAt": iso(end),
                          "durationMs": duration, "triggerInputId": trigger, "inputIds": [row["id"] for row in inputs],
                          "assistantRequestIds": sorted({row["requestId"] for row in ancestors if row.get("requestId")}),
                          "missingAncestor": missing_parent, "batchIds": sorted(batches), "deliveryIds": sorted(members),
                          "sourceSeqs": sorted(seqs), "sourceKinds": kinds, "eventTypes": types,
                          "sourceJoinMissing": missing, "hasOtherInput": other, "onlyTargetNotifications": only_targets,
                          "quietAuthority": "not_reconstructed" if only_targets else "not_a_proven_target_only_turn"})
        unassigned += [{"sessionId": transcript["sessionId"], "inputId": row["id"], "at": row["at"], "compactSummary": row["compactSummary"]}
                       for row in records.values() if row["kind"] == "input" and millis(START) <= millis(row["at"]) < millis(END) and row["id"] not in used_inputs]
    turns.sort(key=lambda row: (row["startedAt"], row["sessionId"], row["markerId"]))
    return {"schemaVersion": 1, "windowUtc": [START, END], "project": "flywheel", "lead": LEAD,
            "metric": "completed carrier runtime turns by start timestamp; neither consumed inputs nor proven idle-to-busy transitions",
            "counts": {"runtimeTurnStarts": len(turns), "attributedTurnStarts": sum(row["triggerInputId"] is not None for row in turns),
                       "unattributedTurnStarts": sum(row["triggerInputId"] is None for row in turns),
                       "turnsWithMissingSourceJoins": sum(bool(row["sourceJoinMissing"]) for row in turns),
                       "targetOnlyCandidates": sum(row["onlyTargetNotifications"] for row in turns), "unassignedInputs": len(unassigned)},
            "eventComparison": event_comparison,
            "comparison": {"beforeRuntimeTurns": len(turns), "beforePhysicalWakeTransitions": None, "after": None},
            "acceptance": {"complete": False, "reasons": ["Runtime turn boundaries do not prove that the carrier was idle between adjacent turns.",
                 "After-policy wake count requires at-event producer authority and counterfactual queue/carrier scheduling; event names and timestamps cannot mint this evidence."]},
            "turns": turns, "unassignedInputs": unassigned}


def export_sources(args):
    transcripts = []
    sources = []
    for path in sorted(Path(args.transcript_dir).glob("*.jsonl")):
        if path.stat().st_mtime * 1000 < millis(START):
            continue
        raw = path.read_bytes()
        raw = raw[:raw.rfind(b"\n") + 1]
        rows = [json.loads(line) for line in raw.splitlines() if line]
        if not any(START <= row.get("timestamp", "") < END for row in rows):
            continue
        # Include one day of boundary context for turns crossing midnight.
        rows = [row for row in rows if row.get("timestamp") and millis(START) - 86400000 <= millis(row["timestamp"]) <= millis(END) + 86400000]
        transcripts.append(project_rows(path.stem, rows))
        sources.append({"fileName": path.name, "completePrefixBytes": len(raw), "completePrefixSha256": digest(raw)})
    # Explicit metadata projections, no auth, body, title or payload fields.
    event_cols = "seq, event_id, event_type, session_key, created_at, delivery_disposition, CASE WHEN json_type(payload, '$.last_error')='text' AND length(json_extract(payload, '$.last_error'))>0 THEN 1 ELSE 0 END AS has_last_error"
    with closing(sqlite3.connect(Path(args.teamlead_db).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        events = [dict(row) for row in db.execute(f"SELECT {event_cols} FROM lead_events WHERE lead_id=? AND created_at>=? AND created_at<? ORDER BY seq", (LEAD, "2026-09-24 07:00:00", END.replace("T", " ").removesuffix("Z")))]
    for event in events:
        event["actionGuardFields"] = ["last_error"] if event.pop("has_last_error") else []
    columns = "delivery_id, batch_id, source_kind, source_ref, created_at"
    needed_batches = {batch["id"] for transcript in transcripts for row in transcript["records"] if row["kind"] == "input" for batch in row["batches"]}
    batch_selector = json.dumps(sorted(needed_batches))
    with closing(sqlite3.connect(Path(args.comm_db).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        mailbox = []
        for table in ("mailbox", "mailbox_archive"):
            mailbox += [dict(row) for row in db.execute(f"SELECT {columns} FROM {table} WHERE to_agent=? AND batch_id IN (SELECT value FROM json_each(?))", (LEAD, batch_selector))]
        # Terminal archive keeps the exact original row, including retired batch
        # membership. Parsing is private; only these five fields leave the loop.
        for table, column in (("mailbox_terminal_archive", "mailbox_json"), ("mailbox_log", "row_json")):
            for (raw,) in db.execute(f"SELECT {column} FROM {table} WHERE json_extract({column}, '$.to_agent')=? AND json_extract({column}, '$.batch_id') IN (SELECT value FROM json_each(?))", (LEAD, batch_selector)):
                row = json.loads(raw)
                mailbox.append({key: row.get(key) for key in columns.split(", ")})
    needed_batches = {batch["id"] for transcript in transcripts for row in transcript["records"] if row["kind"] == "input" for batch in row["batches"]}
    mailbox = [row for row in mailbox if row.get("batch_id") in needed_batches]
    unique = {encoded(row): row for row in mailbox}
    mailbox = sorted(unique.values(), key=lambda row: (row["batch_id"], row["delivery_id"]))
    event_seqs = {seq for transcript in transcripts for row in transcript["records"] if row["kind"] == "input" for seq in row["eventSeqs"]}
    event_seqs.update(int(row["source_ref"]) for row in mailbox if row.get("source_kind") == "lead_event" and str(row.get("source_ref", "")).isdigit())
    missing_seqs = sorted(event_seqs - {row["seq"] for row in events})
    if missing_seqs:
        with closing(sqlite3.connect(Path(args.teamlead_db).resolve().as_uri() + "?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            for row in db.execute(f"SELECT {event_cols} FROM lead_events WHERE lead_id=? AND seq IN (SELECT value FROM json_each(?)) ORDER BY seq", (LEAD, json.dumps(missing_seqs))):
                event = dict(row)
                event["actionGuardFields"] = ["last_error"] if event.pop("has_last_error") else []
                events.append(event)
    events.sort(key=lambda row: row["seq"])
    events = [row for row in events if row["seq"] in event_seqs or START.replace("T", " ").removesuffix("Z") <= row["created_at"] < END.replace("T", " ").removesuffix("Z")]
    return {"schemaVersion": 1, "sourceTranscripts": sources, "transcripts": transcripts, "mailbox": mailbox, "events": events,
            "databaseRead": "read-only metadata queries; no database copies; rows are capture-time observations, not historical producer authority"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["extract", "replay"])
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--transcript-dir")
    parser.add_argument("--teamlead-db")
    parser.add_argument("--comm-db")
    args = parser.parse_args()
    if args.mode == "extract":
        data = export_sources(args)
        raw = encoded(data)
        args.input.write_bytes(gzip.compress(raw, mtime=0) if args.input.suffix == ".gz" else raw)
    else:
        raw = args.input.read_bytes()
        data = json.loads(gzip.decompress(raw) if args.input.suffix == ".gz" else raw)
    result = reconstruct(data["transcripts"], data["mailbox"], data["events"])
    result["inputSha256"] = digest(args.input.read_bytes())
    args.output.write_bytes(encoded(result))
    print(json.dumps({"counts": result["counts"], "comparison": result["comparison"], "acceptance": result["acceptance"]}, indent=2))


if __name__ == "__main__":
    main()
