#!/usr/bin/env python3
"""Render a self-contained, escaped meeting-notes founder review card."""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any


ISSUE_RE = re.compile(r"^[A-Z][A-Z0-9]+-[1-9][0-9]*$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
ACTION_RE = re.compile(r"^AI-[1-9][0-9]*$")


def expect_dict(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def expect_string(value: Any, label: str, *, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    cleaned = value.strip()
    if pattern is not None and pattern.fullmatch(cleaned) is None:
        raise ValueError(f"{label} has an invalid format")
    return cleaned


def validate_payload(raw: Any) -> dict[str, Any]:
    payload = expect_dict(raw, "input")
    allowed = {
        "issueIdentifier",
        "meetingId",
        "title",
        "meta",
        "summary",
        "actionItems",
    }
    unknown = sorted(set(payload) - allowed)
    missing = sorted(allowed - set(payload))
    if unknown or missing:
        raise ValueError(f"input keys mismatch: missing={missing}, unknown={unknown}")

    issue_identifier = expect_string(
        payload["issueIdentifier"], "issueIdentifier", pattern=ISSUE_RE
    )
    meeting_id = expect_string(payload["meetingId"], "meetingId", pattern=UUID_RE)
    title = expect_string(payload["title"], "title")
    meta = expect_string(payload["meta"], "meta")

    summary_raw = payload["summary"]
    if not isinstance(summary_raw, list) or any(
        not isinstance(item, str) or not item.strip() for item in summary_raw
    ):
        raise ValueError("summary must be an array of non-empty strings")
    summary = [item.strip() for item in summary_raw]

    actions_raw = payload["actionItems"]
    if not isinstance(actions_raw, list):
        raise ValueError("actionItems must be an array")
    actions: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, raw_action in enumerate(actions_raw):
        action = expect_dict(raw_action, f"actionItems[{index}]")
        if set(action) != {"id", "text", "source"}:
            raise ValueError(
                f"actionItems[{index}] keys must be exactly id, text, source"
            )
        action_id = expect_string(action["id"], f"actionItems[{index}].id", pattern=ACTION_RE)
        if action_id in seen:
            raise ValueError(f"duplicate action item id: {action_id}")
        seen.add(action_id)
        actions.append(
            {
                "id": action_id,
                "text": expect_string(action["text"], f"actionItems[{index}].text"),
                "source": expect_string(action["source"], f"actionItems[{index}].source"),
            }
        )

    return {
        "issueIdentifier": issue_identifier,
        "meetingId": meeting_id,
        "title": title,
        "meta": meta,
        "summary": summary,
        "actionItems": actions,
    }


def render(payload: dict[str, Any], template: str) -> str:
    summary_html = "".join(f"<p>{html.escape(item)}</p>" for item in payload["summary"])
    if not summary_html:
        summary_html = '<p class="empty">本场没有可确认的讨论总结。</p>'

    action_html: list[str] = []
    for action in payload["actionItems"]:
        action_id = html.escape(action["id"], quote=True)
        action_html.append(
            "\n".join(
                [
                    f'<section class="action" data-action-id="{action_id}">',
                    f"  <h2>{action_id}</h2>",
                    f'  <div class="action-text">{html.escape(action["text"])}</div>',
                    f'  <div class="source">出处：{html.escape(action["source"])}</div>',
                    '  <div class="choices">',
                    '    <button class="choice" data-decision="要做" aria-pressed="false">要做</button>',
                    '    <button class="choice" data-decision="不做" aria-pressed="false">不做</button>',
                    '    <button class="choice" data-decision="有意见" aria-pressed="false">有意见</button>',
                    "  </div>",
                    f'  <textarea data-k="action-{action_id}" placeholder="可留空；选「有意见」时请说明原因"></textarea>',
                    "</section>",
                ]
            )
        )
    if not action_html:
        action_html.append(
            '<section><h2>Action items</h2><div class="empty">本场没有 action items。</div></section>'
        )

    replacements = {
        "{{ISSUE_IDENTIFIER}}": html.escape(payload["issueIdentifier"], quote=True),
        "{{MEETING_TITLE}}": html.escape(payload["title"]),
        "{{MEETING_META}}": html.escape(payload["meta"]),
        "{{SUMMARY_HTML}}": summary_html,
        "{{ACTION_ITEMS_HTML}}": "\n".join(action_html),
    }
    output = template
    for marker, value in replacements.items():
        output = output.replace(marker, value)
    leftovers = sorted(set(re.findall(r"\{\{[A-Z_]+\}\}", output)))
    if leftovers:
        raise ValueError(f"unresolved template placeholders: {leftovers}")
    if output.count('__CSP_NONCE__') != 1:
        raise ValueError("template must contain exactly one CSP nonce placeholder")
    if re.search(r"<meta[^>]+http-equiv=[\"']Content-Security-Policy", output, re.I):
        raise ValueError("template must not embed a CSP meta tag")
    return output


def write_atomic(path: Path, content: str) -> None:
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise ValueError("output must not be a symlink or non-file")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--template",
        type=Path,
        default=Path(__file__).resolve().parent.parent
        / "assets"
        / "meeting-notes.template.html",
    )
    arguments = parser.parse_args()
    payload = validate_payload(json.loads(arguments.input.read_text(encoding="utf-8")))
    rendered = render(payload, arguments.template.read_text(encoding="utf-8"))
    write_atomic(Path(os.path.abspath(arguments.output)), rendered)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"[meeting-notes-card] {error}") from error
