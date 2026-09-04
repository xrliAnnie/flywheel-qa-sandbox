#!/usr/bin/env python3
"""Atomically apply and verify the reviewed two-key Raya env migration."""

import os
import stat
import sys
import tempfile
from pathlib import Path


EXPECTED = {
    "RAYA_MEMORY_FILE": (
        "/Users/xiaorongli/Dev/raya-lead-workspace/memory/MEMORY.md"
    ),
    "RAYA_WORKSPACE_ROOTS_JSON": (
        '["/Users/xiaorongli/.flywheel/raya/code",'
        '"/Users/xiaorongli/Dev/raya-lead-workspace/memory"]'
    ),
}


def read_regular(path: Path):
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"input must be a regular non-symlink file: {path}")
    if metadata.st_size > 1024 * 1024:
        raise ValueError(f"input is too large: {path}")
    return path.read_text(encoding="utf-8"), metadata


def target_lines(text: str):
    lines = text.splitlines(keepends=True)
    matches = {}
    for key in EXPECTED:
        prefix = f"{key}="
        indices = [
            index
            for index, line in enumerate(lines)
            if line.rstrip("\r\n").startswith(prefix)
        ]
        if len(indices) != 1:
            raise ValueError(f"{key} must appear exactly once")
        index = indices[0]
        matches[key] = (index, lines[index].rstrip("\r\n")[len(prefix) :])
    return lines, matches


def atomic_write(path: Path, text: str, metadata) -> None:
    temporary_path = None
    descriptor, raw_temporary_path = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    temporary_path = Path(raw_temporary_path)
    try:
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
        directory_descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def edit(path: Path, assignments) -> None:
    provided = {}
    for assignment in assignments:
        if "=" not in assignment:
            raise ValueError("each replacement must be KEY=value")
        key, value = assignment.split("=", 1)
        if key in provided:
            raise ValueError(f"replacement key appears more than once: {key}")
        provided[key] = value
    if provided != EXPECTED:
        raise ValueError("replacements must equal the two reviewed Raya target values")

    text, metadata = read_regular(path)
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        raise ValueError("source mode must be 0600")
    lines, matches = target_lines(text)
    for key, (index, _) in matches.items():
        old_line = lines[index]
        ending = old_line[len(old_line.rstrip("\r\n")) :]
        lines[index] = f"{key}={EXPECTED[key]}{ending}"
    atomic_write(path, "".join(lines), metadata)


def normalized_transition(text: str):
    lines, matches = target_lines(text)
    values = {}
    for key, (index, value) in matches.items():
        values[key] = value
        old_line = lines[index]
        ending = old_line[len(old_line.rstrip("\r\n")) :]
        lines[index] = f"{key}=<reviewed-target>{ending}"
    return "".join(lines), values


def verify(backup_path: Path, current_path: Path) -> None:
    backup_text, backup_metadata = read_regular(backup_path)
    current_text, current_metadata = read_regular(current_path)
    if stat.S_IMODE(current_metadata.st_mode) != 0o600:
        raise ValueError("current file mode must be 0600")
    if (backup_metadata.st_uid, backup_metadata.st_gid) != (
        current_metadata.st_uid,
        current_metadata.st_gid,
    ):
        raise ValueError("backup and current file owner must match")

    backup_normalized, backup_values = normalized_transition(backup_text)
    current_normalized, current_values = normalized_transition(current_text)
    if backup_normalized != current_normalized:
        raise ValueError("non-target content changed")
    for key, expected in EXPECTED.items():
        if current_values[key] != expected:
            raise ValueError(f"target value mismatch: {key}")
        if backup_values[key] == expected:
            raise ValueError(f"backup already has target value: {key}")


def main() -> int:
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--verify":
            verify(Path(sys.argv[2]), Path(sys.argv[3]))
        elif len(sys.argv) == 4 and sys.argv[1] != "--verify":
            edit(Path(sys.argv[1]), sys.argv[2:])
        else:
            print(
                "usage: edit-raya-env.py <raya.env> <memory assignment> "
                "<workspace-roots assignment> | --verify <backup> <current>",
                file=sys.stderr,
            )
            return 64
    except (OSError, UnicodeError, ValueError) as error:
        print(f"edit-raya-env: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
