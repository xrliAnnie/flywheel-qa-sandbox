#!/usr/bin/env python3
"""Hash versioned filesystem metadata without opening regular files."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import sys


def encoded(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def entry_type(mode: int) -> str:
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISLNK(mode):
        return "symlink"
    if stat.S_ISSOCK(mode):
        return "socket"
    if stat.S_ISFIFO(mode):
        return "fifo"
    if stat.S_ISCHR(mode):
        return "character"
    if stat.S_ISBLK(mode):
        return "block"
    return "other"


def snapshot_root(raw_root: str) -> dict[str, object]:
    if not os.path.isabs(raw_root):
        raise ValueError("root must be absolute")
    root = os.fsencode(raw_root)
    root_info = os.lstat(root)
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        raise ValueError("root must be a non-symlink directory")

    entries: list[dict[str, object]] = []
    pending = [root]
    while pending:
        directory = pending.pop()
        children = sorted(os.scandir(directory), key=lambda item: os.fsencode(item.name))
        for child_entry in children:
            child = os.path.join(directory, os.fsencode(child_entry.name))
            info = os.lstat(child)
            relative = os.path.relpath(child, root)
            kind = entry_type(info.st_mode)
            row: dict[str, object] = {
                "pathB64": encoded(relative),
                "type": kind,
                "mode": format(stat.S_IMODE(info.st_mode), "04o"),
                "size": info.st_size,
                "mtimeNs": info.st_mtime_ns,
                "uid": info.st_uid,
                "gid": info.st_gid,
            }
            if kind == "symlink":
                row["linkTargetB64"] = encoded(os.readlink(child))
            elif kind == "directory":
                pending.append(child)
            entries.append(row)
    entries.sort(key=lambda row: base64.b64decode(str(row["pathB64"])))
    return {
        "rootPathB64": encoded(root),
        "rootRealPathB64": encoded(os.fsencode(os.path.realpath(root))),
        "entries": entries,
    }


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: qa-metadata-snapshot.py <absolute-root>...", file=sys.stderr)
        return 1
    try:
        roots = [snapshot_root(root) for root in argv]
    except (OSError, ValueError) as error:
        print(f"qa-metadata-snapshot: {error}", file=sys.stderr)
        return 1
    manifest = {"schemaVersion": 1, "roots": roots}
    canonical = json.dumps(
        manifest, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    output = {
        "schemaVersion": 1,
        "sha256": hashlib.sha256(canonical).hexdigest(),
        "roots": roots,
    }
    print(json.dumps(output, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
