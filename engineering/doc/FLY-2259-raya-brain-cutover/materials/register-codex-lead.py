#!/usr/bin/env python3
"""Append one reviewed project row with an atomic, mode-preserving replace."""

import json
import os
import stat
import sys
import tempfile
from pathlib import Path


def load_regular_json(path: Path):
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"input must be a regular non-symlink file: {path}")
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle), metadata


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "usage: register-codex-lead.py <projects.json> <project-row.json>",
            file=sys.stderr,
        )
        return 64

    projects_path = Path(sys.argv[1])
    row_path = Path(sys.argv[2])
    temporary_path = None
    try:
        projects, projects_metadata = load_regular_json(projects_path)
        row, _ = load_regular_json(row_path)
        if not isinstance(projects, list):
            raise ValueError("projects registry must be a JSON array")
        if not isinstance(row, dict):
            raise ValueError("project row must be a JSON object")
        project_name = row.get("projectName")
        if not isinstance(project_name, str) or not project_name:
            raise ValueError("project row projectName must be a non-empty string")
        existing_names = [
            item.get("projectName")
            for item in projects
            if isinstance(item, dict)
        ]
        if project_name in existing_names:
            raise ValueError(f"projectName already exists: {project_name}")

        projects.append(row)
        descriptor, raw_temporary_path = tempfile.mkstemp(
            prefix=f".{projects_path.name}.", dir=projects_path.parent
        )
        temporary_path = Path(raw_temporary_path)
        try:
            os.fchown(
                descriptor, projects_metadata.st_uid, projects_metadata.st_gid
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(projects, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fchmod(
                    handle.fileno(), stat.S_IMODE(projects_metadata.st_mode)
                )
                os.fsync(handle.fileno())
            os.replace(temporary_path, projects_path)
            temporary_path = None
            directory_descriptor = os.open(projects_path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"register-codex-lead: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
