#!/usr/bin/env python3
"""Offline Claude usage evidence; reads logs, writes only the requested JSON artifact.

Live capture:
  python3 measure-usage.py --start 2026-09-17T00:00:00Z \
    --end 2026-09-19T00:00:00Z --out evidence/baseline-usage.json
Frozen replay (even if the live files have since grown):
  python3 measure-usage.py --manifest evidence/baseline-usage.json --out /tmp/replay.json

The manifest stores relative filenames, complete-line prefix sizes and SHA-256,
never transcript content. This is Claude model-request accounting, not a count
of Lead wakes and not a cross-vendor usage collector.
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import pathlib
import re
import sys

VERSION = 1
FIELDS = ("input_tokens", "cache_creation_input_tokens",
          "cache_read_input_tokens", "output_tokens")
DEFAULT_CWD = pathlib.Path.home() / ".flywheel/lead-workspace/flywheel-eng-lead"
DEFAULT_ROOT = pathlib.Path.home() / ".claude/projects/-Users-xiaorongli--flywheel-lead-workspace-flywheel-eng-lead"


def instant(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta(0):
        raise ValueError("timestamps must have an explicit UTC offset")
    return parsed


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


def external_kind(content):
    text = content if isinstance(content, str) else "\n".join(
        block.get("text", "") for block in content
        if isinstance(block, dict) and block.get("type") == "text") if isinstance(content, list) else ""
    if text.startswith("This session is being continued"):
        return "inherited_compaction_summary"
    if re.search(r"\| from founder\]", text):
        return "founder_or_mixed_with_founder"
    events = re.findall(r"\[Event #\d+\]\s*(?:\[[^\]]+\]\s*)?(\w+)", text)
    if len(set(events)) > 1:
        return "mixed_event_types"
    if events:
        event = events[0]
        if event == "runner_question":
            return "runner_report_text" if "[REPORT]" in text else "runner_ask_or_unclassified"
        if event == "gate_question":
            return "review_gate_text" if re.search(r"REVIEW_CODE|REVIEW_DESIGN|review_code|review_design", text) else "nonreview_or_unknown_gate"
        # Restrict output vocabulary: arbitrary transcript text never becomes a label.
        known = {"stage_changed", "session_started", "session_failed", "workflow_replacement_eligibility",
                 "workflow_claim_recorded", "action_executed", "monitoring_reestablished", "patrol_tick",
                 "summary_due", "replacement", "alert"}
        return event if event in known else "other_event_type"
    if "## Bootstrap — Lead:" in text:
        return "bootstrap"
    if "<task-notification>" in text:
        return "task_notification"
    if text.startswith("[self-wakeup") or text.startswith("[session-cron"):
        return "self_schedule"
    return "unclassified_external_input"


def summarize(records):
    def group(rows):
        result = {"model_requests": len(rows)}
        result.update({key: sum(row["usage"][key] for row in rows) for key in FIELDS})
        result["total_tokens"] = sum(result[key] for key in FIELDS)
        result["average_cache_read_per_model_request"] = (
            result["cache_read_input_tokens"] / len(rows) if rows else None)
        return result

    rows = list(records.values())
    days = sorted({row["day"] for row in rows})
    return {
        "window": {"all_models": group(rows), "fable": group([
            row for row in rows if "fable" in row["model"].lower()])},
        "whole_turn_attribution": {kind: group([row for row in rows if row["source_kind"] == kind])
                                   for kind in sorted({row["source_kind"] for row in rows})},
        "by_utc_day": {day: {
            "all_models": group([row for row in rows if row["day"] == day]),
            "fable": group([row for row in rows if row["day"] == day
                            and "fable" in row["model"].lower()]),
            "whole_turn_attribution": {kind: group([row for row in rows
                                                    if row["day"] == day and row["source_kind"] == kind])
                                       for kind in sorted({row["source_kind"] for row in rows if row["day"] == day})},
            "by_model": {model: group([row for row in rows
                                       if row["day"] == day and row["model"] == model])
                         for model in sorted({row["model"] for row in rows
                                              if row["day"] == day})},
        } for day in days},
    }


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=DEFAULT_ROOT)
    parser.add_argument("--cwd", type=pathlib.Path, default=DEFAULT_CWD)
    parser.add_argument("--start", help="inclusive UTC timestamp")
    parser.add_argument("--end", help="exclusive UTC timestamp")
    parser.add_argument("--manifest", type=pathlib.Path, help="prior output JSON; replay frozen prefixes")
    parser.add_argument("--out", type=pathlib.Path, help="JSON output; default stdout")
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    exact_cwd = str(args.cwd)
    cwd_digest = hashlib.sha256(exact_cwd.encode()).hexdigest()
    old = json.loads(args.manifest.read_text()) if args.manifest else None
    if old:
        if old["schema_version"] != VERSION:
            raise ValueError("unsupported manifest schema")
        if old["exact_cwd_sha256"] != cwd_digest:
            raise ValueError("--cwd differs from frozen manifest")
        start_text = old["requested_window"]["start_inclusive"]
        end_text = old["requested_window"]["end_exclusive"]
        if args.start and instant(args.start) != instant(start_text):
            raise ValueError("--start differs from frozen manifest")
        if args.end and instant(args.end) != instant(end_text):
            raise ValueError("--end differs from frozen manifest")
        captured = instant(old["captured_at"])
        entries = old["sources"]
    else:
        if not args.start or not args.end:
            parser.error("live capture requires --start and --end")
        start_text, end_text = args.start, args.end
        captured = dt.datetime.now(dt.timezone.utc)
        entries = [{"path": str(path.relative_to(root)), "prefix_bytes": path.stat().st_size}
                   for path in sorted(root.rglob("*.jsonl")) if path.is_file()]
    start, end = instant(start_text), instant(end_text)
    if end <= start or captured <= start:
        raise ValueError("require start < end and capture time > start")
    effective_end = min(end, captured)
    stats = collections.Counter({key: 0 for key in (
        "source_lines", "parse_errors", "invalid_timestamps", "synthetic_rows",
        "different_cwd_rows", "invalid_usage_rows", "missing_identity_rows",
        "eligible_usage_rows", "message_key_fallback_rows", "request_key_fallback_rows",
        "message_duplicate_rows", "request_duplicate_rows",
        "message_usage_conflicts", "request_usage_conflicts")})
    by_message, by_request, sources = {}, {}, []
    for entry in entries:
        source_kind = "unknown_inherited_source"
        relative = pathlib.Path(entry["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("manifest paths must be relative and contained")
        path = (root / relative).resolve(strict=True)
        if not path.is_relative_to(root):
            raise ValueError("source path escaped --root")
        limit = entry["prefix_bytes"]
        if not isinstance(limit, int) or limit < 0 or path.stat().st_size < limit:
            raise ValueError("invalid or truncated frozen source")
        digest, consumed = hashlib.sha256(), 0
        with path.open("rb") as stream:
            while consumed < limit:
                line = stream.readline(limit - consumed)
                if not line:
                    raise ValueError("source truncated during read")
                if not line.endswith(b"\n"):
                    if old:
                        raise ValueError("frozen prefix ends inside a line")
                    break
                consumed += len(line)
                digest.update(line)
                stats["source_lines"] += 1
                try:
                    obj = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    stats["parse_errors"] += 1
                    continue
                if not isinstance(obj, dict):
                    continue
                message = obj.get("message")
                if obj.get("type") == "user" and isinstance(message, dict):
                    content = message.get("content", "")
                    tool_result = isinstance(content, list) and any(
                        isinstance(block, dict) and block.get("type") == "tool_result" for block in content)
                    if not tool_result:
                        source_kind = external_kind(content)
                if obj.get("type") != "assistant":
                    continue
                if not isinstance(message, dict) or not isinstance(message.get("usage"), dict):
                    continue
                try:
                    timestamp = instant(obj.get("timestamp", ""))
                except (ValueError, TypeError, AttributeError):
                    stats["invalid_timestamps"] += 1
                    continue
                if not start <= timestamp < effective_end:
                    continue
                if obj.get("cwd") != exact_cwd:
                    stats["different_cwd_rows"] += 1
                    continue
                model = message.get("model", "?")
                if model == "<synthetic>":
                    stats["synthetic_rows"] += 1
                    continue
                usage = {key: message["usage"].get(key, 0) for key in FIELDS}
                if any(isinstance(value, bool) or not isinstance(value, (int, float))
                       or not math.isfinite(value) or value < 0 or int(value) != value
                       for value in usage.values()):
                    stats["invalid_usage_rows"] += 1
                    continue
                mid, rid, uid = message.get("id"), obj.get("requestId"), obj.get("uuid")
                if any(value is not None and (not isinstance(value, str) or not value)
                       for value in (mid, rid, uid)) or not (mid or rid or uid):
                    stats["missing_identity_rows"] += 1
                    continue
                stats["eligible_usage_rows"] += 1
                stats["message_key_fallback_rows"] += not bool(mid)
                stats["request_key_fallback_rows"] += not bool(rid)
                row = {"day": timestamp.date().isoformat(), "model": str(model), "usage": usage,
                       "source_kind": source_kind}
                for records, key, label in ((by_message, mid or rid or uid, "message"),
                                            (by_request, rid or mid or uid, "request")):
                    if key in records:
                        stats[label + "_duplicate_rows"] += 1
                        stats[label + "_usage_conflicts"] += any(
                            records[key][field] != row[field] for field in ("usage", "day", "model"))
                    else:
                        records[key] = row
        sha = digest.hexdigest()
        if old and (consumed != limit or sha != entry["sha256"]):
            raise ValueError("frozen source prefix changed")
        sources.append({"path": str(relative), "prefix_bytes": consumed, "sha256": sha})
    message_summary, request_summary = summarize(by_message), summarize(by_request)
    days = {}
    day = start.date()
    while dt.datetime.combine(day, dt.time(), dt.timezone.utc) < end:
        low = dt.datetime.combine(day, dt.time(), dt.timezone.utc)
        high = low + dt.timedelta(days=1)
        days[day.isoformat()] = {"complete_utc_day": start <= low and effective_end >= high,
                                "observed_seconds": max(0, (min(high, effective_end) - max(low, start)).total_seconds())}
        day += dt.timedelta(days=1)
    result = {
        "schema_version": VERSION,
        "script_sha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
        "source_kind": "claude-jsonl",
        "metric": "deduplicated model requests, not inbound events or Lead wakes",
        "attribution_method": "All model requests after the last external user input until the next external input; tool_result messages do not reset attribution. Compaction summaries and unknown inherited inputs are explicit. Text categories are descriptive, not suppression authority or proven removable savings.",
        "exact_cwd_sha256": cwd_digest,
        "captured_at": iso(captured),
        "requested_window": {"start_inclusive": iso(start), "end_exclusive": iso(end)},
        "effective_end_exclusive": iso(effective_end),
        "partial_window": effective_end < end,
        "utc_day_coverage": days,
        "capture_boundary": "per-file complete-line prefixes, not an atomic filesystem snapshot",
        "sources": sources,
        "counts": dict(stats),
        "message_id_primary": message_summary,
        "request_id_crosscheck": request_summary,
        "crosscheck_totals_match": message_summary == request_summary,
    }
    if old and old["script_sha256"] != result["script_sha256"]:
        raise ValueError("script differs from frozen manifest")
    encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.write_text(encoded)
    else:
        sys.stdout.write(encoded)


if __name__ == "__main__":
    try:
        run()
    except (ValueError, OSError, KeyError) as error:
        sys.exit(f"measurement failed: {error}")
