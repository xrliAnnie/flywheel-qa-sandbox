#!/usr/bin/env python3
"""Read-only verifier for Raya's first real summary-absorption round."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse


SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
SNOWFLAKE_RE = re.compile(r"^[0-9]{17,20}$")
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
DISCORD_MESSAGE_RE = re.compile(
    r"^https://discord\.com/channels/([0-9]{17,20})/([0-9]{17,20})/([0-9]{17,20})$"
)
COUNT_PATTERNS = {
    "reviewed": (
        re.compile(r"(?<![A-Za-z0-9_])reviewed\s*=\s*([0-9]+)(?![A-Za-z0-9_])", re.I),
        re.compile(r"(?<![A-Za-z0-9_])review\s*了?\s*([0-9]+)(?![A-Za-z0-9_])", re.I),
    ),
    "absorbed": (
        re.compile(r"(?<![A-Za-z0-9_])absorbed\s*=\s*([0-9]+)(?![A-Za-z0-9_])", re.I),
        re.compile(r"吸收\s*了?\s*([0-9]+)(?![A-Za-z0-9_])"),
    ),
}
MAX_TEXT_BYTES = 8 * 1024 * 1024
DISCORD_API_BASE = "https://discord.com/api/v10"


class EvidenceError(RuntimeError):
    """A fail-closed evidence error with a non-secret identifier."""


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Keep the Bot credential bound to the exact evidence endpoint."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def fail(evidence_id: str) -> None:
    raise EvidenceError(evidence_id)


def require_regular(path_text: str, evidence_id: str, max_bytes: int | None) -> Path:
    path = Path(path_text).expanduser()
    try:
        details = path.lstat()
    except OSError:
        fail(f"{evidence_id}:unavailable")
    if not stat.S_ISREG(details.st_mode):
        fail(f"{evidence_id}:regular_non_symlink_required")
    if max_bytes is not None and details.st_size > max_bytes:
        fail(f"{evidence_id}:oversize")
    return path


def read_text(path_text: str, evidence_id: str) -> str:
    path = require_regular(path_text, evidence_id, MAX_TEXT_BYTES)
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        fail(f"{evidence_id}:unreadable")


def read_json_object(path_text: str, evidence_id: str) -> dict[str, Any]:
    try:
        value = json.loads(read_text(path_text, evidence_id))
    except json.JSONDecodeError:
        fail(f"{evidence_id}:invalid_json")
    if not isinstance(value, dict):
        fail(f"{evidence_id}:object_required")
    return value


def verify_db(path_text: str, round_id: str) -> list[dict[str, str]]:
    path = require_regular(path_text, "db", None)
    uri = f"file:{quote(str(path.resolve()))}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True)
        connection.row_factory = sqlite3.Row
        try:
            rows = connection.execute(
                """SELECT lead_id, event_id, event_type, session_key,
                          delivered_at, delivery_attempts, last_delivery_error
                   FROM lead_events
                   WHERE lead_id = ? AND event_id = ? AND event_type = ?""",
                ("raya", round_id, "summary_absorption_round"),
            ).fetchall()
        finally:
            connection.close()
    except sqlite3.Error:
        fail("db:query_failed")

    if len(rows) != 1:
        fail("db:expected_exactly_one_round")
    row = rows[0]
    if row["session_key"] != "summary-absorption":
        fail("db:session_key_mismatch")
    if row["delivered_at"] is None:
        fail("db:undelivered")
    attempts = row["delivery_attempts"]
    if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts < 0:
        fail("db:delivery_attempts_invalid")

    advisories: list[dict[str, str]] = []
    if row["last_delivery_error"] not in (None, ""):
        advisories.append(
            {
                "id": "db_stale_last_delivery_error",
                "message": "delivered event retains a historical last_delivery_error",
            }
        )
    return advisories


def nonempty_string_list(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) > 0
        and all(isinstance(item, str) and item.strip() != "" for item in value)
    )


def verify_receipt(
    path_text: str, round_id: str, repo: str, pr_number: int
) -> dict[str, Any]:
    text = read_text(path_text, "receipts")
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            fail(f"receipts:invalid_jsonl_line_{line_number}")
        if not isinstance(value, dict):
            fail(f"receipts:object_required_line_{line_number}")
        rows.append(value)

    matching = [
        row
        for row in rows
        if row.get("type") == "merge"
        and row.get("roundId") == round_id
        and row.get("repo") == repo
        and row.get("pr") == pr_number
    ]
    if not matching:
        fail("receipts:matching_merge_missing")

    shas: set[str] = set()
    for row in matching:
        sha = row.get("verifiedHeadSha")
        if not isinstance(sha, str) or SHA_RE.fullmatch(sha) is None:
            fail("receipts:verified_head_invalid")
        if not nonempty_string_list(row.get("files")):
            fail("receipts:files_invalid")
        if not nonempty_string_list(row.get("projects")):
            fail("receipts:projects_invalid")
        shas.add(sha.lower())
    if len(shas) != 1:
        fail("receipts:conflicting_verified_heads")

    receipt = matching[0].copy()
    receipt["verifiedHeadSha"] = next(iter(shas))
    return receipt


def verify_pr(path_text: str, pr_number: int, expected_sha: str) -> None:
    pull_request = read_json_object(path_text, "pr_json")
    if pull_request.get("state") != "MERGED":
        fail("pr_json:not_merged")
    if pull_request.get("headRefOid") != expected_sha:
        fail("pr_json:head_mismatch")
    if "number" in pull_request and pull_request["number"] != pr_number:
        fail("pr_json:number_mismatch")


def verify_memory(path_text: str, round_id: str, files: list[str]) -> None:
    memory = read_text(path_text, "memory")
    if round_id not in memory:
        fail("memory:round_missing")
    for file_path in files:
        if file_path not in memory:
            fail("memory:receipt_file_missing")


def parse_message_url(message_url: str) -> tuple[str, str, str]:
    match = DISCORD_MESSAGE_RE.fullmatch(message_url)
    if match is None:
        fail("discord:message_url_invalid")
    return match.group(1), match.group(2), match.group(3)


def select_api_base(api_base: str | None, allow_loopback: bool) -> tuple[str, str]:
    if api_base is None:
        if allow_loopback:
            fail("discord:loopback_flag_without_override")
        return DISCORD_API_BASE, "discord_api_v10"
    if not allow_loopback:
        fail("discord:api_override_requires_test_flag")
    parsed = urlparse(api_base)
    try:
        port = parsed.port
    except ValueError:
        fail("discord:api_override_invalid")
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        fail("discord:api_override_not_loopback")
    return api_base.rstrip("/"), "loopback_test"


def fetch_discord_message(
    api_base: str, channel_id: str, message_id: str, token: str
) -> dict[str, Any]:
    endpoint = f"{api_base}/channels/{channel_id}/messages/{message_id}"
    request = urllib.request.Request(
        endpoint,
        headers={"Authorization": f"Bot {token}", "User-Agent": "flywheel-fly2401-evidence/1"},
        method="GET",
    )
    try:
        opener = urllib.request.build_opener(NoRedirectHandler())
        with opener.open(request, timeout=10) as response:
            body = response.read(MAX_TEXT_BYTES + 1)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
        fail("discord:http_failed")
    if len(body) > MAX_TEXT_BYTES:
        fail("discord:response_oversize")
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        fail("discord:invalid_json")
    if not isinstance(value, dict):
        fail("discord:object_required")
    return value


def verify_discord(
    message: dict[str, Any],
    channel_id: str,
    message_id: str,
    bot_user_id: str,
    round_id: str,
) -> tuple[int, int]:
    if message.get("id") != message_id:
        fail("discord:message_mismatch")
    if message.get("channel_id") != channel_id:
        fail("discord:channel_mismatch")
    author = message.get("author")
    if not isinstance(author, dict) or author.get("id") != bot_user_id:
        fail("discord:author_mismatch")
    content = message.get("content")
    if not isinstance(content, str):
        fail("discord:content_missing")
    if round_id not in content:
        fail("discord:round_missing")

    counts: dict[str, int] = {}
    for name, patterns in COUNT_PATTERNS.items():
        match = None
        for pattern in patterns:
            match = pattern.search(content)
            if match is not None:
                break
        if match is None:
            fail(f"discord:{name}_missing")
        counts[name] = int(match.group(1))
        if counts[name] < 1:
            fail(f"discord:{name}_zero")
    return counts["reviewed"], counts["absorbed"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--round-id", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--receipts", required=True)
    parser.add_argument("--memory", required=True)
    parser.add_argument("--pr-json", required=True)
    parser.add_argument("--discord-message-url", required=True)
    parser.add_argument("--discord-bot-user-id", required=True)
    parser.add_argument("--discord-token-env", required=True)
    parser.add_argument("--discord-api-base")
    parser.add_argument("--allow-loopback-test-endpoint", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.pr < 1:
        fail("arguments:pr_invalid")
    if not args.round_id.startswith("summary-absorption:"):
        fail("arguments:round_id_invalid")
    if not SNOWFLAKE_RE.fullmatch(args.discord_bot_user_id):
        fail("discord:bot_user_id_invalid")
    if not ENV_NAME_RE.fullmatch(args.discord_token_env):
        fail("discord:token_env_name_invalid")
    token = os.environ.get(args.discord_token_env)
    if not token:
        fail("discord:token_missing")

    advisories = verify_db(args.db, args.round_id)
    receipt = verify_receipt(args.receipts, args.round_id, args.repo, args.pr)
    verified_sha = receipt["verifiedHeadSha"]
    verify_pr(args.pr_json, args.pr, verified_sha)
    verify_memory(args.memory, args.round_id, receipt["files"])

    _guild_id, channel_id, message_id = parse_message_url(args.discord_message_url)
    api_base, evidence_source = select_api_base(
        args.discord_api_base, args.allow_loopback_test_endpoint
    )
    message = fetch_discord_message(api_base, channel_id, message_id, token)
    reviewed, absorbed = verify_discord(
        message, channel_id, message_id, args.discord_bot_user_id, args.round_id
    )

    print(
        json.dumps(
            {
                "schemaVersion": 1,
                "ok": True,
                "productionWritesPerformed": False,
                "roundId": args.round_id,
                "repo": args.repo,
                "pr": args.pr,
                "verifiedHeadSha": verified_sha,
                "discordMessageUrl": args.discord_message_url,
                "discordMessageId": message_id,
                "reviewed": reviewed,
                "absorbed": absorbed,
                "evidenceSource": evidence_source,
                "advisories": advisories,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except EvidenceError as error:
        print(f"verify-first-round: {error}", file=sys.stderr)
        raise SystemExit(1)
