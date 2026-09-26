#!/usr/bin/env python3
"""Count Claude Lead requests triggered only by inbox batch-ACK results.

The script streams Claude JSONL transcripts and emits aggregate counts only. It
never writes or prints message/tool-result bodies. A request qualifies when every
tool result since the preceding assistant request belongs to
``flywheel_inbox_ack_batch`` and no external input arrived in between. The
``ack_triggered_no_tool`` subset is the directly avoidable tail request whose
assistant response made no subsequent tool call.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


ACK_TOOL_NAMES = {
	"mcp__flywheel-inbox__flywheel_inbox_ack_batch",
	"flywheel_inbox_ack_batch",
}
LEAD_DIRECTORIES = (
	re.compile(r"(?:^|-)flywheel-lead-workspace-"),
	re.compile(
		r"^-private-tmp-flywheel-test-slot-\d+-"
		r"(?:extra-leads-slot-\d+-)?lead-workspace$"
	),
	re.compile(r"-Dev-personal-assistant$"),
)


def parse_utc(value: str) -> dt.datetime:
	try:
		parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
	except ValueError as error:
		raise argparse.ArgumentTypeError(f"invalid ISO-8601 timestamp: {value}") from error
	if parsed.tzinfo is None:
		raise argparse.ArgumentTypeError(f"timestamp must include a timezone: {value}")
	return parsed.astimezone(dt.timezone.utc)


def row_timestamp(value: object) -> dt.datetime | None:
	if not isinstance(value, str) or not value:
		return None
	try:
		parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
	except ValueError:
		return None
	if parsed.tzinfo is None:
		return None
	return parsed.astimezone(dt.timezone.utc)


def is_lead_transcript(path: Path) -> bool:
	return "subagents" not in path.parts and any(
		pattern.search(part) for part in path.parts for pattern in LEAD_DIRECTORIES
	)


def transcript_files(
	roots: Iterable[Path], all_transcripts: bool, since: dt.datetime
) -> list[Path]:
	files: set[Path] = set()
	for root in roots:
		if root.is_file():
			candidates = [root]
		elif root.is_dir():
			candidates = root.rglob("*.jsonl")
		else:
			raise FileNotFoundError(f"transcript root does not exist: {root}")
		for candidate in candidates:
			if candidate.suffix != ".jsonl":
				continue
			try:
				if candidate.stat().st_mtime < since.timestamp():
					continue
			except OSError:
				continue
			resolved = candidate.resolve()
			if all_transcripts or is_lead_transcript(resolved):
				files.add(resolved)
	return sorted(files)


def content_blocks(message: dict[str, Any]) -> list[dict[str, Any]]:
	content = message.get("content")
	if not isinstance(content, list):
		return []
	return [block for block in content if isinstance(block, dict)]


def usage_tokens(message: dict[str, Any]) -> int | None:
	usage = message.get("usage")
	if not isinstance(usage, dict):
		return None
	return sum(
		int(usage.get(name) or 0)
		for name in (
			"input_tokens",
			"cache_creation_input_tokens",
			"cache_read_input_tokens",
			"output_tokens",
		)
	)


@dataclass
class Request:
	key: str
	timestamp: dt.datetime
	tokens: int
	ack_only_trigger: bool
	calls_tools: bool


@dataclass
class ParseResult:
	requests: list[Request]
	parse_errors: int


def parse_transcript(path: Path) -> ParseResult:
	tool_names: dict[str, str] = {}
	pending_results: list[str] = []
	external_pending = False
	requests: list[Request] = []
	request_index: dict[str, int] = {}
	parse_errors = 0

	with path.open(encoding="utf-8", errors="replace") as handle:
		for line_number, line in enumerate(handle, start=1):
			try:
				row = json.loads(line)
			except (json.JSONDecodeError, TypeError):
				parse_errors += 1
				continue
			if not isinstance(row, dict):
				continue
			message = row.get("message")
			if not isinstance(message, dict):
				message = {}

			if row.get("type") == "user":
				blocks = content_blocks(message)
				tool_results = [
					block for block in blocks if block.get("type") == "tool_result"
				]
				if tool_results:
					for block in tool_results:
						tool_use_id = block.get("tool_use_id")
						pending_results.append(tool_names.get(str(tool_use_id), "unknown"))
					if any(block.get("type") != "tool_result" for block in blocks):
						external_pending = True
				else:
					external_pending = True
				continue

			if row.get("type") != "assistant":
				continue
			blocks = content_blocks(message)
			for block in blocks:
				if block.get("type") == "tool_use":
					tool_id = block.get("id")
					tool_name = block.get("name")
					if tool_id is not None and isinstance(tool_name, str):
						tool_names[str(tool_id)] = tool_name

			tokens = usage_tokens(message)
			timestamp = row_timestamp(row.get("timestamp"))
			if (
				tokens is None
				or timestamp is None
				or message.get("model") == "<synthetic>"
			):
				continue
			key_value = message.get("id") or row.get("requestId") or row.get("uuid")
			key = str(key_value) if key_value else f"{path}:{line_number}"
			calls_tools = any(block.get("type") == "tool_use" for block in blocks)
			if key in request_index:
				request = requests[request_index[key]]
				request.timestamp = timestamp
				request.tokens = tokens
				request.calls_tools = request.calls_tools or calls_tools
				continue

			ack_only_trigger = bool(pending_results) and not external_pending and all(
				name in ACK_TOOL_NAMES for name in pending_results
			)
			request_index[key] = len(requests)
			requests.append(
				Request(
					key=key,
					timestamp=timestamp,
					tokens=tokens,
					ack_only_trigger=ack_only_trigger,
					calls_tools=calls_tools,
				)
			)
			pending_results = []
			external_pending = False

	return ParseResult(requests=requests, parse_errors=parse_errors)


def metric(requests: Iterable[Request]) -> dict[str, int]:
	selected = list(requests)
	return {
		"requests": len(selected),
		"tokens": sum(request.tokens for request in selected),
	}


def build_parser() -> argparse.ArgumentParser:
	parser = argparse.ArgumentParser(
		description=(
			"Count Claude Lead requests triggered only by flywheel inbox batch-ACK "
			"results, including the no-follow-up-tool subset."
		)
	)
	parser.add_argument(
		"--transcript-root",
		type=Path,
		action="append",
		required=True,
		help="Claude projects directory, Lead directory, or JSONL file (repeatable)",
	)
	parser.add_argument("--since", type=parse_utc, required=True, help="inclusive UTC start")
	parser.add_argument("--until", type=parse_utc, required=True, help="exclusive UTC end")
	parser.add_argument(
		"--all-transcripts",
		action="store_true",
		help="disable the default known Lead-workspace path filter",
	)
	parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
	return parser


def main() -> int:
	args = build_parser().parse_args()
	if args.since >= args.until:
		print("--since must be earlier than --until", file=sys.stderr)
		return 2
	try:
		files = transcript_files(args.transcript_root, args.all_transcripts, args.since)
	except FileNotFoundError as error:
		print(str(error), file=sys.stderr)
		return 2

	seen: set[str] = set()
	window_requests: list[Request] = []
	parse_errors = 0
	duplicates = 0
	for path in files:
		parsed = parse_transcript(path)
		parse_errors += parsed.parse_errors
		for request in parsed.requests:
			if request.key in seen:
				duplicates += 1
				continue
			seen.add(request.key)
			if args.since <= request.timestamp < args.until:
				window_requests.append(request)

	ack_triggered = [request for request in window_requests if request.ack_only_trigger]
	ack_no_tool = [request for request in ack_triggered if not request.calls_tools]
	result = {
		"schemaVersion": 1,
		"window": {
			"since": args.since.isoformat().replace("+00:00", "Z"),
			"until": args.until.isoformat().replace("+00:00", "Z"),
		},
		"transcripts": len(files),
		"assistant_requests": len(window_requests),
		"parse_errors": parse_errors,
		"duplicate_responses": duplicates,
		"ack_tool_names": sorted(ACK_TOOL_NAMES),
		"ack_triggered": metric(ack_triggered),
		"ack_triggered_no_tool": metric(ack_no_tool),
	}
	if args.json:
		print(json.dumps(result, ensure_ascii=False, sort_keys=True))
	else:
		print(
			"ack-triggered requests: "
			f"{result['ack_triggered']['requests']} "
			f"({result['ack_triggered']['tokens']} tokens)"
		)
		print(
			"ack-triggered requests with no tool call: "
			f"{result['ack_triggered_no_tool']['requests']} "
			f"({result['ack_triggered_no_tool']['tokens']} tokens)"
		)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
