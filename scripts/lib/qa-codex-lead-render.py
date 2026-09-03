#!/usr/bin/env python3
"""Render and statically verify the fixed 529-room Codex Lead wrapper."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile


LEAD_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
PROJECT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
SAFE_PATH_RE = re.compile(r"^[A-Za-z0-9_./-]+$")
MAX_WRAPPER_BYTES = 64 * 1024
EXEC_PREFIX = "${FLYWHEEL_DIR}/packages/teamlead/scripts/codex-lead.sh"


def die(message: str) -> None:
    print(f"[qa-codex-lead-render] ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def regular_file(path: Path, field: str) -> None:
    try:
        info = path.lstat()
    except OSError:
        die(field)
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_size > MAX_WRAPPER_BYTES:
        die(field)


def validate_values(lead_id: str, project_dir: str, project_name: str) -> None:
    if not LEAD_RE.fullmatch(lead_id):
        die("lead_id")
    if not PROJECT_RE.fullmatch(project_name):
        die("project_name")
    project_path = Path(project_dir)
    if not project_path.is_absolute() or not SAFE_PATH_RE.fullmatch(project_dir):
        die("project_dir")
    try:
        info = project_path.lstat()
    except OSError:
        die("project_dir")
    if not stat.S_ISDIR(info.st_mode) or project_path.is_symlink():
        die("project_dir")


def expected_exec(lead_id: str, project_dir: str, project_name: str) -> list[str]:
    return ["exec", "/bin/bash", EXEC_PREFIX, lead_id, project_dir, project_name]


def check_text(text: str, lead_id: str, project_dir: str, project_name: str) -> None:
    validate_values(lead_id, project_dir, project_name)
    lines = [line for line in text.splitlines() if line.startswith("exec ")]
    if len(lines) != 1:
        die("exec")
    try:
        argv = shlex.split(lines[0], posix=True)
    except ValueError:
        die("exec")
    if argv != expected_exec(lead_id, project_dir, project_name):
        die("exec")
    if "@@" in text:
        die("placeholder")


def render(args: argparse.Namespace) -> None:
    template = Path(args.template)
    output = Path(args.output)
    validate_values(args.lead_id, args.project_dir, args.project_name)
    regular_file(template, "template")
    if not output.is_absolute():
        die("output")
    if output.exists() or output.is_symlink():
        die("output")
    if not output.parent.is_dir() or output.parent.is_symlink():
        die("output")
    text = template.read_text(encoding="utf-8")
    replacements = {
        "@@LEAD_ID@@": shlex.quote(args.lead_id),
        "@@PROJECT_DIR@@": shlex.quote(args.project_dir),
        "@@PROJECT@@": shlex.quote(args.project_name),
    }
    for marker in replacements:
        if text.count(marker) != 1:
            die("placeholder")
    for marker, value in replacements.items():
        text = text.replace(marker, value)
    check_text(text, args.lead_id, args.project_dir, args.project_name)

    fd, tmp_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
        os.chmod(tmp_name, 0o700)
        subprocess.run(["/bin/bash", "-n", tmp_name], check=True)
        os.replace(tmp_name, output)
    except Exception:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def check(args: argparse.Namespace) -> None:
    path = Path(args.path)
    regular_file(path, "path")
    text = path.read_text(encoding="utf-8")
    check_text(text, args.lead_id, args.project_dir, args.project_name)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    render_parser = commands.add_parser("render")
    render_parser.add_argument("--template", required=True)
    render_parser.add_argument("--output", required=True)
    check_parser = commands.add_parser("check")
    check_parser.add_argument("--path", required=True)
    for command in (render_parser, check_parser):
        command.add_argument("--lead-id", required=True)
        command.add_argument("--project-dir", required=True)
        command.add_argument("--project-name", required=True)
    return root


def main() -> None:
    args = parser().parse_args()
    if args.command == "render":
        render(args)
    else:
        check(args)


if __name__ == "__main__":
    main()
