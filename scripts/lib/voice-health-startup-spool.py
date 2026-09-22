#!/usr/bin/env python3
"""Record closed, pre-config voice startup failures in a private spool."""

from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import uuid


ALLOWED_REASONS = frozenset(
    {
        "startup_config_invalid",
        "startup_lock_unavailable",
        "startup_not_ready",
        "health_observation_unavailable",
    }
)
MAX_SPOOL_FILES = 128
MAX_SPOOL_BYTES = 1024 * 1024


class StartupSpoolError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _check_directory(path: Path, *, exact_mode: int | None = None) -> None:
    try:
        details = path.lstat()
    except OSError as error:
        raise StartupSpoolError("startup_spool_path_invalid") from error
    mode = stat.S_IMODE(details.st_mode)
    if (
        not stat.S_ISDIR(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or details.st_uid != os.geteuid()
        or mode & 0o022
        or (exact_mode is not None and mode != exact_mode)
    ):
        raise StartupSpoolError("startup_spool_path_invalid")


def _ensure_private_directory(path: Path) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    except OSError as error:
        raise StartupSpoolError("startup_spool_unavailable") from error
    _check_directory(path, exact_mode=0o700)


def _spool_root() -> Path:
    raw_home = os.environ.get("HOME", "")
    home = Path(raw_home)
    if not raw_home or not home.is_absolute():
        raise StartupSpoolError("startup_spool_path_invalid")
    _check_directory(home)
    flywheel = home / ".flywheel"
    if not flywheel.exists():
        _ensure_private_directory(flywheel)
    else:
        _check_directory(flywheel)
    spool = flywheel / "voice-startup-spool"
    _ensure_private_directory(spool)
    return spool


def _observed_at() -> str:
    return (
        dt.datetime.now(dt.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def record(reason_class: str) -> dict[str, object]:
    if reason_class not in ALLOWED_REASONS:
        raise StartupSpoolError("startup_reason_invalid")
    spool = _spool_root()
    for _ in range(4):
        attempt_id = str(uuid.uuid4())
        document = {
            "schemaVersion": 1,
            "startupAttemptId": attempt_id,
            "observedAt": _observed_at(),
            "reasonClass": reason_class,
            "operation": "startup",
        }
        payload = (_canonical_json(document) + "\n").encode("utf-8")
        name = hashlib.sha256(attempt_id.encode("ascii")).hexdigest() + ".json"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        directory = -1
        try:
            directory_flags = os.O_RDONLY
            if hasattr(os, "O_DIRECTORY"):
                directory_flags |= os.O_DIRECTORY
            if hasattr(os, "O_NOFOLLOW"):
                directory_flags |= os.O_NOFOLLOW
            directory = os.open(spool, directory_flags)
            fcntl.flock(directory, fcntl.LOCK_EX)
            existing_files = 0
            existing_bytes = 0
            for existing_name in os.listdir(directory):
                if (
                    len(existing_name) != 69
                    or not existing_name.endswith(".json")
                    or any(
                        character not in "0123456789abcdef"
                        for character in existing_name[:-5]
                    )
                ):
                    continue
                details = os.stat(
                    existing_name,
                    dir_fd=directory,
                    follow_symlinks=False,
                )
                if (
                    not stat.S_ISREG(details.st_mode)
                    or details.st_uid != os.geteuid()
                    or stat.S_IMODE(details.st_mode) != 0o600
                ):
                    raise StartupSpoolError("startup_spool_path_invalid")
                existing_files += 1
                existing_bytes += details.st_size
            if (
                existing_files >= MAX_SPOOL_FILES
                or existing_bytes + len(payload) > MAX_SPOOL_BYTES
            ):
                raise StartupSpoolError("startup_spool_full")
            descriptor = os.open(name, flags, 0o600, dir_fd=directory)
        except FileExistsError:
            if directory >= 0:
                os.close(directory)
            continue
        except StartupSpoolError:
            if directory >= 0:
                fcntl.flock(directory, fcntl.LOCK_UN)
                os.close(directory)
            raise
        except OSError as error:
            if directory >= 0:
                os.close(directory)
            raise StartupSpoolError("startup_spool_unavailable") from error
        try:
            with os.fdopen(descriptor, "wb", closefd=True) as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.fsync(directory)
        except OSError as error:
            raise StartupSpoolError("startup_spool_unavailable") from error
        finally:
            if directory >= 0:
                fcntl.flock(directory, fcntl.LOCK_UN)
            os.close(directory)
        return {
            "schemaVersion": 1,
            "status": "recorded",
            "startupAttemptId": attempt_id,
        }
    raise StartupSpoolError("startup_spool_unavailable")


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] != "record":
        raise StartupSpoolError("startup_spool_usage")
    print(_canonical_json(record(sys.argv[2])))
    return 0


if __name__ == "__main__":
    os.umask(0o077)
    try:
        raise SystemExit(main())
    except StartupSpoolError as error:
        print(f"voice-health-startup-spool: {error.code}", file=sys.stderr)
        raise SystemExit(2)
