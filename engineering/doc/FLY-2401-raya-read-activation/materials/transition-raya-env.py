#!/usr/bin/env python3
"""Atomically apply, verify, or roll back the reviewed Raya env transition."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any


MAX_INPUT_BYTES = 1024 * 1024
TARGET_KEYS = (
    "RAYA_MEMORY_FILE",
    "RAYA_WORKSPACE_ROOTS_JSON",
    "RAYA_VOICE_OPTIONS_JSON",
)


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def read_regular(path: Path) -> tuple[bytes, os.stat_result]:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"input must be a regular non-symlink file: {path}")
    if metadata.st_size > MAX_INPUT_BYTES:
        raise ValueError(f"input is too large: {path}")
    return path.read_bytes(), metadata


def decode_utf8(path: Path, raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"input must be UTF-8: {path}") from error


def expand_home(value: Any, home: Path) -> Any:
    if isinstance(value, str):
        if value == "$HOME":
            return str(home)
        if value.startswith("$HOME/"):
            return str(home / value[len("$HOME/") :])
        return value
    if isinstance(value, list):
        return [expand_home(item, home) for item in value]
    if isinstance(value, dict):
        return {key: expand_home(item, home) for key, item in value.items()}
    return value


def load_target(path: Path, home: Path) -> dict[str, Any]:
    raw, _ = read_regular(path)
    try:
        value = json.loads(decode_utf8(path, raw))
    except json.JSONDecodeError as error:
        raise ValueError("env target must be valid JSON") from error
    if not isinstance(value, dict) or set(value) != set(TARGET_KEYS):
        raise ValueError("env target must contain exactly the three reviewed Raya keys")
    expanded = expand_home(value, home)
    memory = expanded["RAYA_MEMORY_FILE"]
    roots = expanded["RAYA_WORKSPACE_ROOTS_JSON"]
    voice = expanded["RAYA_VOICE_OPTIONS_JSON"]
    if not isinstance(memory, str) or not memory:
        raise ValueError("RAYA_MEMORY_FILE target must be a string")
    if not isinstance(roots, list) or not all(
        isinstance(item, str) and item for item in roots
    ):
        raise ValueError("RAYA_WORKSPACE_ROOTS_JSON target must be an array of strings")
    if (
        not isinstance(voice, dict)
        or set(voice) != {"startInstructionsFile"}
        or not isinstance(voice["startInstructionsFile"], str)
    ):
        raise ValueError("RAYA_VOICE_OPTIONS_JSON target must pin startInstructionsFile")
    return expanded


def parse_env(text: str) -> tuple[list[str], dict[str, tuple[int, Any] | None]]:
    lines = text.splitlines(keepends=True)
    matches: dict[str, list[tuple[int, str]]] = {key: [] for key in TARGET_KEYS}
    for index, line in enumerate(lines):
        logical = line.rstrip("\r\n")
        for key in TARGET_KEYS:
            prefix = f"{key}="
            if logical.startswith(prefix):
                matches[key].append((index, logical[len(prefix) :]))

    for key in TARGET_KEYS[:2]:
        if len(matches[key]) != 1:
            raise ValueError(f"{key} must appear exactly once")
    if len(matches["RAYA_VOICE_OPTIONS_JSON"]) > 1:
        raise ValueError("RAYA_VOICE_OPTIONS_JSON must appear at most once")

    parsed: dict[str, tuple[int, Any] | None] = {}
    memory_index, memory = matches["RAYA_MEMORY_FILE"][0]
    parsed["RAYA_MEMORY_FILE"] = (memory_index, memory)

    roots_index, roots_raw = matches["RAYA_WORKSPACE_ROOTS_JSON"][0]
    try:
        roots = json.loads(roots_raw)
    except json.JSONDecodeError as error:
        raise ValueError("RAYA_WORKSPACE_ROOTS_JSON must be valid JSON") from error
    if not isinstance(roots, list) or not all(
        isinstance(item, str) and item for item in roots
    ):
        raise ValueError("RAYA_WORKSPACE_ROOTS_JSON must be an array of strings")
    parsed["RAYA_WORKSPACE_ROOTS_JSON"] = (roots_index, roots)

    voice_matches = matches["RAYA_VOICE_OPTIONS_JSON"]
    if not voice_matches:
        parsed["RAYA_VOICE_OPTIONS_JSON"] = None
    else:
        voice_index, voice_raw = voice_matches[0]
        try:
            voice = json.loads(voice_raw)
        except json.JSONDecodeError as error:
            raise ValueError("RAYA_VOICE_OPTIONS_JSON must be valid JSON") from error
        if not isinstance(voice, dict):
            raise ValueError("RAYA_VOICE_OPTIONS_JSON must be a JSON object")
        parsed["RAYA_VOICE_OPTIONS_JSON"] = (voice_index, voice)
    return lines, parsed


def ending(line: str) -> str:
    return line[len(line.rstrip("\r\n")) :]


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def rendered_target(text: str, target: dict[str, Any]) -> str:
    lines, parsed = parse_env(text)
    memory_index = parsed["RAYA_MEMORY_FILE"][0]  # type: ignore[index]
    roots_index = parsed["RAYA_WORKSPACE_ROOTS_JSON"][0]  # type: ignore[index]
    voice_match = parsed["RAYA_VOICE_OPTIONS_JSON"]

    lines[memory_index] = (
        f"RAYA_MEMORY_FILE={target['RAYA_MEMORY_FILE']}" + ending(lines[memory_index])
    )
    lines[roots_index] = (
        "RAYA_WORKSPACE_ROOTS_JSON="
        + compact_json(target["RAYA_WORKSPACE_ROOTS_JSON"])
        + ending(lines[roots_index])
    )

    prior_voice = dict(voice_match[1]) if voice_match is not None else {}
    prior_voice["startInstructionsFile"] = target["RAYA_VOICE_OPTIONS_JSON"][
        "startInstructionsFile"
    ]
    voice_line = "RAYA_VOICE_OPTIONS_JSON=" + compact_json(prior_voice)
    if voice_match is not None:
        voice_index = voice_match[0]
        lines[voice_index] = voice_line + ending(lines[voice_index])
    else:
        insert_at = roots_index + 1
        if not ending(lines[roots_index]):
            lines[roots_index] += "\n"
        lines.insert(insert_at, voice_line + "\n")
    return "".join(lines)


def non_target_lines(text: str) -> list[str]:
    lines, _ = parse_env(text)
    return [
        line
        for line in lines
        if not any(line.rstrip("\r\n").startswith(f"{key}=") for key in TARGET_KEYS)
    ]


def verify_transition(
    before_path: Path, current_path: Path, target: dict[str, Any]
) -> tuple[bytes, os.stat_result, bytes, os.stat_result]:
    before_raw, before_metadata = read_regular(before_path)
    current_raw, current_metadata = read_regular(current_path)
    if stat.S_IMODE(before_metadata.st_mode) != 0o600:
        raise ValueError("before file mode must be 0600")
    if stat.S_IMODE(current_metadata.st_mode) != 0o600:
        raise ValueError("current file mode must be 0600")
    if (before_metadata.st_uid, before_metadata.st_gid) != (
        current_metadata.st_uid,
        current_metadata.st_gid,
    ):
        raise ValueError("before and current file owner must match")

    before_text = decode_utf8(before_path, before_raw)
    current_text = decode_utf8(current_path, current_raw)
    expected = rendered_target(before_text, target)
    if current_text != expected:
        if non_target_lines(before_text) != non_target_lines(current_text):
            raise ValueError("non-target content changed")
        raise ValueError("target value or placement mismatch")
    return before_raw, before_metadata, current_raw, current_metadata


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_backup(path: Path, raw: bytes, metadata: os.stat_result) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)
    fsync_directory(path.parent)


def atomic_write(path: Path, raw: bytes, metadata: os.stat_result) -> None:
    descriptor, raw_temp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(raw_temp)
    try:
        os.fchmod(descriptor, stat.S_IMODE(metadata.st_mode))
        os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.close(descriptor)
        descriptor = -1
        os.replace(temp_path, path)
        fsync_directory(path.parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temp_path.unlink(missing_ok=True)


def apply(args: argparse.Namespace, target: dict[str, Any]) -> dict[str, Any]:
    env_path = Path(args.env)
    backup_path = Path(args.backup)
    if os.path.lexists(backup_path):
        raise ValueError(f"backup already exists: {backup_path}")
    env_raw, env_metadata = read_regular(env_path)
    if stat.S_IMODE(env_metadata.st_mode) != 0o600:
        raise ValueError("source mode must be 0600")
    target_raw = rendered_target(decode_utf8(env_path, env_raw), target).encode()
    write_backup(backup_path, env_raw, env_metadata)
    atomic_write(env_path, target_raw, env_metadata)
    return {
        "operation": "apply",
        "keys": list(TARGET_KEYS),
        "beforeSha256": sha256(env_raw),
        "afterSha256": sha256(target_raw),
        "backupRetained": True,
    }


def verify(args: argparse.Namespace, target: dict[str, Any]) -> dict[str, Any]:
    before_raw, _, current_raw, _ = verify_transition(
        Path(args.before), Path(args.current), target
    )
    return {
        "operation": "verify",
        "keys": list(TARGET_KEYS),
        "beforeSha256": sha256(before_raw),
        "afterSha256": sha256(current_raw),
        "verified": True,
    }


def rollback(args: argparse.Namespace, target: dict[str, Any]) -> dict[str, Any]:
    backup_path = Path(args.backup)
    env_path = Path(args.env)
    backup_raw, backup_metadata, current_raw, _ = verify_transition(
        backup_path, env_path, target
    )
    atomic_write(env_path, backup_raw, backup_metadata)
    return {
        "operation": "rollback",
        "keys": list(TARGET_KEYS),
        "beforeSha256": sha256(current_raw),
        "afterSha256": sha256(backup_raw),
        "backupRetained": True,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("apply", "verify", "rollback"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("--home", required=True)
        subparser.add_argument("--target", required=True)
        if command == "verify":
            subparser.add_argument("--before", required=True)
            subparser.add_argument("--current", required=True)
        else:
            subparser.add_argument("--env", required=True)
            subparser.add_argument("--backup", required=True)
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        home = Path(args.home)
        if not home.is_absolute():
            raise ValueError("--home must be an absolute path")
        target = load_target(Path(args.target), home)
        operations = {"apply": apply, "verify": verify, "rollback": rollback}
        result = operations[args.command](args, target)
        json.dump(result, sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    except (OSError, ValueError) as error:
        print(f"transition-raya-env: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
