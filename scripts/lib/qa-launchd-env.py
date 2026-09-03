#!/usr/bin/env python3
"""Render a slot-owned Codex Lead environment from validated assignments."""

from __future__ import annotations

import os
from pathlib import Path
import re
import shlex
import stat
import sys
import tempfile


NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
RESOLVER_OWNED = frozenset(
    """
    LEAD_ID PROJECT_NAME FLYWHEEL_LEAD_ID FLYWHEEL_PROJECT_NAME
    FLYWHEEL_LEAD_KEY FLYWHEEL_LEAD_BACKEND FLYWHEEL_LEAD_BOT_USER_ID
    FLYWHEEL_LEAD_ROLE FLYWHEEL_LEAD_MODEL FLYWHEEL_LEAD_EFFORT
    FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW FLYWHEEL_LEAD_SUMMARY_ROLE
    FLYWHEEL_LEAD_HAS_SUMMARY_DUTY FLYWHEEL_SUMMARY_GRANULARITY
    FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST FLYWHEEL_LEAD_IDENTITY_DIGEST
    FLYWHEEL_LEAD_PROJECTS_DIGEST FLYWHEEL_CANONICAL_IDENTITY_RESOLVED
    FLYWHEEL_CODEX_LEAD_ID FLYWHEEL_CODEX_LEAD_PROJECT
    FLYWHEEL_CODEX_LEAD_BOT_TOKEN_ENV DISCORD_STATE_DIR
    DISCORD_EXPECTED_BOT_USER_ID DISCORD_IDENTITY_MODE DISCORD_BOT_TOKEN
    FLYWHEEL_PROJECTS FLYWHEEL_SUMMARY_CONFIG_HOME
    FLYWHEEL_CODEX_LEAD_STATE_DIR FLYWHEEL_LEAD_DRY_RUN
    """.split()
)


def die(field: str) -> "NoReturn":
    print(f"qa-launchd-env: {field}", file=sys.stderr)
    raise SystemExit(1)


def parse_args(argv: list[str]) -> tuple[Path | None, list[str]]:
    if len(argv) >= 2 and argv[0] == "--check":
        return None, argv[1:]
    if len(argv) < 3 or argv[0] != "--output":
        die("arguments")
    output = Path(argv[1])
    if not output.is_absolute():
        die("output")
    return output, argv[2:]


def validate_assignments(raw: list[str]) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    seen: set[str] = set()
    for assignment in raw:
        name, separator, value = assignment.partition("=")
        if not separator or not NAME_RE.fullmatch(name):
            die(name or "name")
        if name in seen or name in RESOLVER_OWNED:
            die(name)
        seen.add(name)
        result.append((name, value))
    return result


def write_atomic(output: Path, assignments: list[tuple[str, str]]) -> None:
    parent = output.parent
    try:
        parent_info = parent.lstat()
    except OSError:
        die("output")
    if not stat.S_ISDIR(parent_info.st_mode) or parent.is_symlink():
        die("output")
    if output.is_symlink() or (output.exists() and not output.is_file()):
        die("output")

    body = "".join(f"{name}={shlex.quote(value)}\n" for name, value in assignments)
    old_umask = os.umask(0o077)
    temporary: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{output.name}.tmp.", dir=parent
        )
        temporary = Path(temporary_name)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, output)
        temporary = None
    except OSError:
        die("output")
    finally:
        os.umask(old_umask)
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def main(argv: list[str]) -> int:
    output, raw_assignments = parse_args(argv)
    assignments = validate_assignments(raw_assignments)
    if output is not None:
        write_atomic(output, assignments)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
