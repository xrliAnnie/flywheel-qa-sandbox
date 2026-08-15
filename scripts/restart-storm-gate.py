#!/usr/bin/env python3
"""Kernel-independent restart-storm ledger and launch gate (FLY-1501 W3).

The wrapper contract is intentionally small:
  gate                         0=launch, 2=lock busy, 3=held, 4=invalid
  record-failure               0=recorded/no-op, 2=lock busy, 3=held, 4=invalid
  resume/status [--with-seq]   0=success, 2=lock busy, 4=invalid
  arm-controlled-wave         0=armed, 2=lock busy, 3=seq changed, 4=invalid

Only Python's standard library is used so this remains available while the
Bridge, Node dependencies, or the v2 kernel are down.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

EXIT_OK = 0
EXIT_LOCKED = 2
EXIT_HELD = 3
EXIT_INVALID = 4

CHILD_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
EPISODE_RE = re.compile(
    r"^(?P<child>[A-Za-z0-9][A-Za-z0-9._-]{0,127})__"
    r"(?P<stamp>[0-9]{8}T[0-9]{6}Z)__"
    r"(?P<seq>[1-9][0-9]*)$"
)
ISO_RE = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"
    r"[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$"
)
STATE_NAMES = {
    "active",
    "held_alert_pending",
    "held_alert_attempted",
    "terminal_hold",
    "resumed",
}


class UsageFailure(Exception):
    """Invalid CLI or environment configuration."""


class DataFailure(Exception):
    """Persistent state cannot be trusted; callers must fail closed."""


class GateArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise UsageFailure(message)


def _json_bytes(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _write_all(fd: int, data: bytes) -> None:
    offset = 0
    while offset < len(data):
        written = os.write(fd, data[offset:])
        if written <= 0:
            raise OSError("short write")
        offset += written


def _fsync_dir(path: Path) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    fd = os.open(path, flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.parent / f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(temp, flags, 0o600)
    try:
        _write_all(fd, _json_bytes(value))
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.replace(temp, path)
        _fsync_dir(path.parent)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _fault(point: str) -> None:
    if os.environ.get("FLYWHEEL_RESTART_STORM_FAULT") == point:
        os._exit(97)


def _parse_positive_env(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    if not re.fullmatch(r"[1-9][0-9]*", raw):
        raise UsageFailure(f"{name} must be a positive integer")
    return int(raw)


def _parse_autoresume_env() -> tuple[int, int, int, int]:
    base = _parse_positive_env(
        "FLYWHEEL_RESTART_STORM_AUTORESUME_BASE_SEC", 300
    )
    cap = _parse_positive_env(
        "FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_SEC", 3600
    )
    stick = _parse_positive_env(
        "FLYWHEEL_RESTART_STORM_AUTORESUME_STICK_SEC", 1800
    )
    cap_probes = _parse_positive_env(
        "FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_PROBES", 6
    )
    if base > cap:
        raise UsageFailure(
            "FLYWHEEL_RESTART_STORM_AUTORESUME_BASE_SEC must not exceed "
            "FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_SEC"
        )
    if cap > 31_536_000:
        raise UsageFailure(
            "FLYWHEEL_RESTART_STORM_AUTORESUME_CAP_SEC must not exceed 31536000"
        )
    return base, cap, stick, cap_probes


def _parse_nonnegative_int(raw: str) -> int:
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)", raw):
        raise argparse.ArgumentTypeError("must be a non-negative integer")
    return int(raw)


def _parse_deadline() -> float:
    raw = os.environ.get("FLYWHEEL_RESTART_STORM_LOCK_DEADLINE_SEC", "0.25")
    try:
        value = float(raw)
    except ValueError as error:
        raise UsageFailure(
            "FLYWHEEL_RESTART_STORM_LOCK_DEADLINE_SEC must be numeric"
        ) from error
    if value < 0:
        raise UsageFailure(
            "FLYWHEEL_RESTART_STORM_LOCK_DEADLINE_SEC must be non-negative"
        )
    return value


def _normalize_root(raw: str | None) -> Path:
    if raw is None:
        return (Path.home() / ".flywheel" / "restart-ledger").resolve()
    candidate = Path(raw)
    if not candidate.is_absolute():
        raise UsageFailure("--root must be an absolute path")
    return candidate.resolve()


def _controlled_marker_root() -> Path:
    raw = os.environ.get("FLYWHEEL_LEAD_REPLACEMENT_DIR")
    if raw is None:
        return (Path.home() / ".flywheel" / "state" / "lead-replacements").resolve()
    candidate = Path(raw)
    if not candidate.is_absolute():
        raise UsageFailure("FLYWHEEL_LEAD_REPLACEMENT_DIR must be absolute")
    return candidate.resolve()


def _validate_child(child: str) -> str:
    if not CHILD_RE.fullmatch(child):
        raise UsageFailure(
            "child_key must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
        )
    return child


def _parse_iso(value: object) -> datetime:
    if not isinstance(value, str) or not ISO_RE.fullmatch(value):
        raise ValueError("timestamp must be canonical UTC ISO-8601")
    parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include UTC")
    return parsed.astimezone(timezone.utc)


def _nonempty_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value or "\n" in value or "\t" in value:
        raise DataFailure(f"controlled-wave marker {name} is invalid")
    return value


def _positive_integer(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise DataFailure(f"controlled-wave marker {name} is invalid")
    return value


def _read_controlled_marker(
    raw_path: str, child: str, attempt_id: str
) -> tuple[Path, str]:
    if not child.startswith("lead."):
        raise UsageFailure("arm-controlled-wave accepts only lead.<daemon_key>")
    daemon_key = child.removeprefix("lead.")
    _validate_child(daemon_key)
    try:
        parsed_attempt = uuid.UUID(attempt_id)
    except (ValueError, AttributeError) as error:
        raise UsageFailure("--attempt-id must be a UUID") from error
    if str(parsed_attempt) != attempt_id:
        raise UsageFailure("--attempt-id must be a canonical UUID")

    marker_root = _controlled_marker_root()
    marker = Path(raw_path)
    if not marker.is_absolute() or marker.parent.resolve() != marker_root:
        raise UsageFailure("--intent-marker must be inside the managed marker directory")
    try:
        marker_stat = os.lstat(marker)
    except OSError as error:
        raise DataFailure(f"cannot stat controlled-wave marker: {error}") from error
    if not stat.S_ISREG(marker_stat.st_mode) or stat.S_IMODE(marker_stat.st_mode) != 0o600:
        raise DataFailure("controlled-wave marker must be a non-symlink 0600 regular file")
    try:
        fd = _open_nofollow(marker, os.O_RDONLY)
        try:
            chunks: list[bytes] = []
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                chunks.append(chunk)
            raw = b"".join(chunks)
        finally:
            os.close(fd)
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DataFailure(f"cannot read controlled-wave marker: {error}") from error
    expected_top = {
        "schema_version",
        "attempt_id",
        "daemon_key",
        "expected_label",
        "phase",
        "old_supervisor_tuple",
        "authority",
        "ts",
    }
    if not isinstance(value, dict) or set(value) != expected_top:
        raise DataFailure("controlled-wave marker has an invalid shape")
    if value.get("schema_version") != 1:
        raise DataFailure("controlled-wave marker schema_version is invalid")
    if value.get("attempt_id") != attempt_id:
        raise DataFailure("controlled-wave marker attempt_id does not match")
    if value.get("daemon_key") != daemon_key or marker.name != f"{daemon_key}.json":
        raise DataFailure("controlled-wave marker daemon_key does not match")
    if value.get("expected_label") != f"com.flywheel.lead.{daemon_key}":
        raise DataFailure("controlled-wave marker expected_label does not match")
    if value.get("phase") not in {"bootout", "bootstrap"}:
        raise DataFailure("controlled-wave marker phase is invalid")
    old_tuple = value.get("old_supervisor_tuple")
    if not isinstance(old_tuple, dict) or set(old_tuple) != {"pid", "start"}:
        raise DataFailure("controlled-wave marker old_supervisor_tuple is invalid")
    if old_tuple.get("pid") is None and old_tuple.get("start") is None:
        pass
    elif old_tuple.get("pid") is not None and old_tuple.get("start") is not None:
        _positive_integer(old_tuple.get("pid"), "old supervisor pid")
        _nonempty_string(old_tuple.get("start"), "old supervisor start")
    else:
        raise DataFailure("controlled-wave marker old supervisor tuple is partial")

    authority = value.get("authority")
    if not isinstance(authority, dict) or set(authority) != {"manifest", "plist", "projects"}:
        raise DataFailure("controlled-wave marker authority is invalid")
    manifest = authority.get("manifest")
    if not isinstance(manifest, dict) or set(manifest) != {"path", "semantic_identity"}:
        raise DataFailure("controlled-wave marker manifest authority is invalid")
    _nonempty_string(manifest.get("path"), "manifest path")
    semantic = manifest.get("semantic_identity")
    semantic_keys = {"leadId", "projectDir", "projectName", "projectsFile", "leadBackend"}
    if not isinstance(semantic, dict) or set(semantic) != semantic_keys:
        raise DataFailure("controlled-wave marker semantic identity is invalid")
    for name in ("leadId", "projectDir", "projectName", "projectsFile"):
        _nonempty_string(semantic.get(name), f"semantic {name}")
    backend = semantic.get("leadBackend")
    if not isinstance(backend, dict) or set(backend) != {"backendId"}:
        raise DataFailure("controlled-wave marker semantic backend is invalid")
    _nonempty_string(backend.get("backendId"), "semantic backendId")
    for name in ("plist", "projects"):
        item = authority.get(name)
        if not isinstance(item, dict) or set(item) != {"path", "digest"}:
            raise DataFailure(f"controlled-wave marker {name} authority is invalid")
        _nonempty_string(item.get("path"), f"{name} path")
        digest = item.get("digest")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise DataFailure(f"controlled-wave marker {name} digest is invalid")
    try:
        _parse_iso(value.get("ts"))
    except ValueError as error:
        raise DataFailure("controlled-wave marker ts is invalid") from error
    return marker, hashlib.sha256(raw).hexdigest()


def _format_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")


def _compact_stamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _decode_episode(episode_key: str) -> tuple[str, str, int]:
    match = EPISODE_RE.fullmatch(episode_key)
    if not match:
        raise ValueError("episode key is not canonical")
    try:
        datetime.strptime(match.group("stamp"), "%Y%m%dT%H%M%SZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError as error:
        raise ValueError("episode timestamp is invalid") from error
    return (
        match.group("child"),
        match.group("stamp"),
        int(match.group("seq")),
    )


def _episode_key(child: str, window_start: datetime, seq: int) -> str:
    episode = f"{child}__{_compact_stamp(window_start)}__{seq}"
    decoded_child, _, decoded_seq = _decode_episode(episode)
    if decoded_child != child or decoded_seq != seq:
        raise DataFailure("episode encoder did not round-trip")
    return episode


def _open_nofollow(path: Path, flags: int, mode: int = 0o600) -> int:
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    return os.open(path, flags, mode)


def _acquire_lock(root: Path, lock_name: str, shared: bool = False) -> int | None:
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / lock_name
    fd = _open_nofollow(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    operation = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
    deadline = time.monotonic() + _parse_deadline()
    while True:
        try:
            fcntl.flock(fd, operation | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            if time.monotonic() >= deadline:
                os.close(fd)
                return None
            time.sleep(0.02)


def _release_lock(fd: int) -> None:
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _default_state() -> dict[str, Any]:
    return {"state": "active", "last_resumed_seq": 0}


def _validate_state(value: object, child: str) -> dict[str, Any]:
    if not isinstance(value, dict) or isinstance(value, list):
        raise DataFailure("restart state must be an object")
    state = value.get("state")
    if state not in STATE_NAMES:
        raise DataFailure("restart state name is invalid")
    if state in {
        "held_alert_pending",
        "held_alert_attempted",
        "terminal_hold",
    }:
        expected = {
            "state",
            "episode_key",
            "window_start",
            "last_resumed_seq",
        }
    else:
        expected = {"state", "last_resumed_seq"}
    if set(value) != expected:
        raise DataFailure("restart state has an invalid shape")
    last_resumed = value.get("last_resumed_seq")
    if (
        isinstance(last_resumed, bool)
        or not isinstance(last_resumed, int)
        or last_resumed < 0
    ):
        raise DataFailure("restart state last_resumed_seq is invalid")
    if state in {
        "held_alert_pending",
        "held_alert_attempted",
        "terminal_hold",
    }:
        episode = value.get("episode_key")
        window_start = value.get("window_start")
        if not isinstance(episode, str):
            raise DataFailure("restart state episode_key is invalid")
        try:
            episode_child, stamp, _ = _decode_episode(episode)
            parsed_start = _parse_iso(window_start)
        except ValueError as error:
            raise DataFailure(str(error)) from error
        if episode_child != child or _compact_stamp(parsed_start) != stamp:
            raise DataFailure("restart state episode identity does not match")
    return dict(value)


def _read_state(root: Path, child: str) -> dict[str, Any]:
    path = root / f"{child}.state"
    try:
        fd = _open_nofollow(path, os.O_RDONLY)
    except FileNotFoundError:
        return _default_state()
    except OSError as error:
        raise DataFailure(f"cannot open restart state: {error}") from error
    try:
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read()
    finally:
        os.close(fd)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DataFailure("restart state contains invalid JSON") from error
    return _validate_state(value, child)


def _write_state(root: Path, child: str, state_value: dict[str, Any]) -> None:
    validated = _validate_state(state_value, child)
    _atomic_write(root / f"{child}.state", validated)


def _validate_ledger_event(
    value: object, expected_seq: int
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"seq", "ts"}:
        raise DataFailure("restart ledger line has an invalid shape")
    seq = value.get("seq")
    if isinstance(seq, bool) or not isinstance(seq, int) or seq != expected_seq:
        raise DataFailure("restart ledger sequence is not contiguous")
    try:
        timestamp = _parse_iso(value.get("ts"))
    except ValueError as error:
        raise DataFailure(str(error)) from error
    return {"seq": seq, "ts": _format_iso(timestamp)}


def _quarantine_corrupt_ledger(
    root: Path, child: str, path: Path, raw: bytes
) -> None:
    directory = root / "ledger-quarantine"
    directory.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(raw).hexdigest()[:16]
    destination = directory / f"{child}.jsonl.{digest}"
    if destination.exists():
        destination = directory / (
            f"{child}.jsonl.{digest}.{uuid.uuid4().hex}"
        )
    os.rename(path, destination)
    _fsync_dir(path.parent)
    _fsync_dir(directory)


def _read_ledger(
    root: Path, child: str, repair_partial_tail: bool
) -> tuple[int, list[dict[str, Any]]]:
    path = root / f"{child}.jsonl"
    flags = os.O_RDWR | os.O_CREAT if repair_partial_tail else os.O_RDONLY
    try:
        fd = _open_nofollow(path, flags, 0o600)
    except FileNotFoundError:
        return (-1, [])
    except OSError as error:
        raise DataFailure(f"cannot open restart ledger: {error}") from error
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        raw = b"".join(chunks)
        if raw and not raw.endswith(b"\n"):
            if not repair_partial_tail:
                raise DataFailure("restart ledger has a partial tail")
            boundary = raw.rfind(b"\n") + 1
            os.ftruncate(fd, boundary)
            os.fsync(fd)
            raw = raw[:boundary]
        events: list[dict[str, Any]] = []
        for index, line in enumerate(raw.splitlines(), start=1):
            try:
                decoded = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise DataFailure(
                    f"restart ledger line {index} is corrupt"
                ) from error
            events.append(_validate_ledger_event(decoded, index))
        return (fd, events)
    except DataFailure:
        os.close(fd)
        try:
            _quarantine_corrupt_ledger(root, child, path, raw)
        except OSError as error:
            raise DataFailure(
                f"cannot quarantine corrupt restart ledger: {error}"
            ) from error
        raise
    except Exception:
        os.close(fd)
        raise


def _append_ledger(
    fd: int, events: list[dict[str, Any]], now: datetime
) -> dict[str, Any]:
    event = {"seq": len(events) + 1, "ts": _format_iso(now)}
    os.lseek(fd, 0, os.SEEK_END)
    _write_all(fd, _json_bytes(event))
    os.fsync(fd)
    events.append(event)
    _fault("after_ledger_append")
    return event


def _record_for_state(
    child: str,
    state_value: dict[str, Any],
    events: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    episode = state_value["episode_key"]
    episode_child, _, first_seq = _decode_episode(episode)
    if episode_child != child:
        raise DataFailure("held episode belongs to another child")
    relevant = [event for event in events if event["seq"] >= first_seq]
    if not relevant or relevant[0]["seq"] != first_seq:
        raise DataFailure("held episode no longer exists in the ledger")
    return {
        "child_key": child,
        "episode_key": episode,
        "window_start": state_value["window_start"],
        "seq": first_seq,
        "count": len(relevant),
    }


def _script_path(env_name: str, default_name: str) -> Path:
    override = os.environ.get(env_name)
    if override:
        return Path(override)
    return Path(__file__).resolve().parent / default_name


def _run_best_effort(command: list[str], capture: bool = False) -> str:
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=capture,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout.strip() if capture else ""


def _emit_corruption_alert(child: str, reason: str, body: str) -> None:
    meta = _script_path("FLYWHEEL_META_ALERT_BIN", "meta-alert.sh")
    if meta.is_file() and os.access(meta, os.X_OK):
        _run_best_effort([str(meta), reason, "Restart gate state is corrupt", body])


def _quarantine_autoresume_sidecar(
    root: Path, child: str, detail: str
) -> None:
    path = root / f"{child}.auto-resume.json"
    destination = root / (
        f"{child}.auto-resume.json.corrupt.{uuid.uuid4().hex}"
    )
    try:
        os.replace(path, destination)
        _fsync_dir(root)
    except OSError:
        pass
    _emit_corruption_alert(
        child,
        "restart_gate_autoresume_corrupt",
        f"{child}: discarded invalid auto-resume state ({detail})",
    )


def _read_autoresume_sidecar(
    root: Path, child: str, now: datetime
) -> dict[str, Any] | None:
    path = root / f"{child}.auto-resume.json"
    try:
        fd = _open_nofollow(path, os.O_RDONLY)
    except FileNotFoundError:
        return None
    except OSError as error:
        _quarantine_autoresume_sidecar(root, child, str(error))
        return None
    try:
        sidecar_stat = os.fstat(fd)
        if (
            not stat.S_ISREG(sidecar_stat.st_mode)
            or stat.S_IMODE(sidecar_stat.st_mode) != 0o600
        ):
            raise ValueError("sidecar must be a 0600 regular file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read()
    except (OSError, ValueError) as error:
        os.close(fd)
        _quarantine_autoresume_sidecar(root, child, str(error))
        return None
    os.close(fd)
    try:
        value = json.loads(raw.decode("utf-8"))
        expected_v1 = {
            "schema_version",
            "step",
            "last_auto_resume_ts",
            "episode_key",
        }
        expected_v2 = expected_v1 | {
            "probe_count",
            "cap_probe_count",
            "total_delay_sec",
            "terminal_episode_key",
        }
        if not isinstance(value, dict):
            raise ValueError("sidecar has an invalid shape")
        schema_version = value.get("schema_version")
        if (
            isinstance(schema_version, bool)
            or not isinstance(schema_version, int)
            or schema_version not in {1, 2}
        ):
            raise ValueError("sidecar schema_version is invalid")
        if set(value) != (expected_v1 if schema_version == 1 else expected_v2):
            raise ValueError("sidecar has an invalid shape")
        step = value["step"]
        if (
            isinstance(step, bool)
            or not isinstance(step, int)
            or not 0 <= step <= 32
        ):
            raise ValueError("sidecar step is invalid")
        last_auto_resume = _parse_iso(value["last_auto_resume_ts"])
        if last_auto_resume > now:
            raise ValueError("sidecar timestamp is in the future")
        if not isinstance(value["episode_key"], str):
            raise ValueError("sidecar episode_key is invalid")
        episode_child, _, _ = _decode_episode(value["episode_key"])
        if episode_child != child:
            raise ValueError("sidecar episode belongs to another child")
        if schema_version == 1:
            value.update(
                {
                    "schema_version": 2,
                    "probe_count": step,
                    "cap_probe_count": 0,
                    "total_delay_sec": 0,
                    "terminal_episode_key": None,
                }
            )
        else:
            counters = (
                value["probe_count"],
                value["cap_probe_count"],
                value["total_delay_sec"],
            )
            if any(
                isinstance(counter, bool)
                or not isinstance(counter, int)
                or counter < 0
                for counter in counters
            ):
                raise ValueError("sidecar counters are invalid")
            if value["cap_probe_count"] > value["probe_count"]:
                raise ValueError("sidecar cap probe count is invalid")
            if step > value["probe_count"]:
                raise ValueError("sidecar step exceeds probe count")
            terminal_episode = value["terminal_episode_key"]
            if terminal_episode is not None:
                if not isinstance(terminal_episode, str):
                    raise ValueError("sidecar terminal episode is invalid")
                terminal_child, _, _ = _decode_episode(terminal_episode)
                if terminal_child != child:
                    raise ValueError(
                        "sidecar terminal episode belongs to another child"
                    )
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, ValueError) as error:
        _quarantine_autoresume_sidecar(root, child, str(error))
        return None
    return dict(value)


def _remove_autoresume_sidecar(root: Path, child: str) -> None:
    path = root / f"{child}.auto-resume.json"
    try:
        path.unlink()
        _fsync_dir(root)
    except FileNotFoundError:
        pass
    except OSError as error:
        sys.stderr.write(
            f"restart-storm-gate: cannot clear auto-resume state for {child}: {error}\n"
        )


def _autoresume_schedule(
    sidecar: dict[str, Any] | None,
    hold_at: datetime,
    base: int,
    cap: int,
    stick: int,
) -> tuple[int, int, datetime, bool]:
    step = 0
    inherited = False
    if sidecar is not None:
        gap = (
            hold_at - _parse_iso(sidecar["last_auto_resume_ts"])
        ).total_seconds()
        if gap <= stick:
            step = sidecar["step"]
            inherited = True
    delay = cap if step >= 32 else min(base * (2**step), cap)
    try:
        eta = hold_at + timedelta(seconds=delay)
    except OverflowError as error:
        raise DataFailure(
            "auto-resume ETA overflows the representable range"
        ) from error
    return step, delay, eta, inherited


def _autoresume_display_plan(
    root: Path,
    child: str,
    state_value: dict[str, Any],
    events: list[dict[str, Any]],
    now: datetime,
    base: int,
    cap: int,
    stick: int,
    cap_probes: int,
) -> dict[str, Any]:
    record = _record_for_state(child, state_value, events)
    hold_at = _parse_iso(events[-1]["ts"])
    sidecar = _read_autoresume_sidecar(root, child, now)
    if (
        sidecar is not None
        and sidecar["terminal_episode_key"] == record["episode_key"]
    ):
        return {"mode": "terminal", "sidecar": sidecar}
    if sidecar is not None and sidecar["episode_key"] == record["episode_key"]:
        if sidecar["step"] >= 1:
            return {
                "mode": "replay",
                "step_next": sidecar["step"],
                "probe_no": sidecar["probe_count"],
                "probe_count_next": sidecar["probe_count"],
                "cap_probe_count_next": sidecar["cap_probe_count"],
                "total_delay_sec_next": sidecar["total_delay_sec"],
                "delay": 0,
                "eta": now,
            }
        _quarantine_autoresume_sidecar(root, child, "prepared sidecar has step 0")
        sidecar = None
    step, delay, eta, inherited = _autoresume_schedule(
        sidecar, hold_at, base, cap, stick
    )
    if (
        inherited
        and sidecar is not None
        and sidecar["cap_probe_count"] >= cap_probes
    ):
        return {"mode": "terminal", "sidecar": sidecar}
    step_next = min(step + 1, 32)
    probe_count = sidecar["probe_count"] if inherited else 0
    cap_probe_count = sidecar["cap_probe_count"] if inherited else 0
    total_delay = sidecar["total_delay_sec"] if inherited else 0
    return {
        "mode": "probe",
        "step_next": step_next,
        "probe_no": probe_count + 1,
        "probe_count_next": probe_count + 1,
        "cap_probe_count_next": cap_probe_count + (delay == cap),
        "total_delay_sec_next": total_delay + delay,
        "delay": delay,
        "eta": eta,
    }


def _autoresume_plan(
    root: Path,
    child: str,
    state_value: dict[str, Any],
    events: list[dict[str, Any]],
    now: datetime,
    base: int,
    cap: int,
    stick: int,
    cap_probes: int,
) -> dict[str, Any] | None:
    plan = _autoresume_display_plan(
        root, child, state_value, events, now, base, cap, stick, cap_probes
    )
    if plan["mode"] in {"replay", "terminal"}:
        return plan
    hold_at = _parse_iso(events[-1]["ts"])
    if max(0.0, (now - hold_at).total_seconds()) < plan["delay"]:
        return None
    return plan


def _attempt_hold_alert(
    record: dict[str, Any], plan: dict[str, Any]
) -> bool:
    child = record["child_key"]
    episode = record["episode_key"]
    title = f"Restart storm held: {child}"
    eta = _format_iso(plan["eta"])
    manual = f"python3 {Path(__file__).resolve()} resume {child}"
    schedule = (
        f"prepared probe #{plan['probe_no']} replaying now"
        if plan["mode"] == "replay"
        else (
            f"Auto-resume probe #{plan['probe_no']} ≈ {eta} "
            f"(backoff {plan['delay'] / 60:g}min)"
        )
    )
    body = (
        f"{child} crashed {record['count']} times since "
        f"{record['window_start']}; automatic restart is held. "
        f"{schedule}. Manual now: {manual}"
    )
    meta = _script_path("FLYWHEEL_META_ALERT_BIN", "meta-alert.sh")
    if meta.is_file() and os.access(meta, os.X_OK):
        _run_best_effort(
            [str(meta), f"restart_storm_{child}", title, body],
        )
    lead = _script_path("FLYWHEEL_LEAD_ALERT_BIN", "lead-alert.sh")
    if not lead.is_file() or not os.access(lead, os.X_OK):
        return False
    output = _run_best_effort(
        [
            str(lead),
            "--project",
            "flywheel",
            "--lead",
            child,
            "--kind",
            "restart_storm_hold",
            "--severity",
            "severe",
            "--title",
            title,
            "--body",
            body,
            "--signature",
            episode,
            "--strict-delivery",
        ],
        capture=True,
    )
    results = {line.strip() for line in output.splitlines()}
    return bool(results & {"sent", "queued_transient"})


def _recover_pending(
    root: Path,
    child: str,
    state_value: dict[str, Any],
    events: list[dict[str, Any]],
    plan: dict[str, Any],
) -> None:
    record = _record_for_state(child, state_value, events)
    if _attempt_hold_alert(record, plan):
        attempted = dict(state_value)
        attempted["state"] = "held_alert_attempted"
        _write_state(root, child, attempted)


def _append_autoresume_audit(
    root: Path, child: str, value: dict[str, Any]
) -> None:
    path = root / f"{child}.auto-resume.ndjson"
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
    try:
        fd = _open_nofollow(path, flags, 0o600)
        try:
            audit_stat = os.fstat(fd)
            if (
                not stat.S_ISREG(audit_stat.st_mode)
                or stat.S_IMODE(audit_stat.st_mode) != 0o600
            ):
                raise DataFailure(
                    "auto-resume audit must be a 0600 regular file"
                )
            if (
                os.environ.get("FLYWHEEL_RESTART_STORM_FAULT")
                == "autoresume_audit_error"
            ):
                raise DataFailure("simulated auto-resume audit failure")
            _write_all(fd, _json_bytes(value))
            os.fsync(fd)
        finally:
            os.close(fd)
        _fsync_dir(root)
    except OSError as error:
        raise DataFailure(f"cannot append auto-resume audit: {error}") from error


def _attempt_autoresume_alert(
    record: dict[str, Any],
    plan: dict[str, Any],
    base: int,
    cap: int,
    cap_probes: int,
) -> None:
    child = record["child_key"]
    probe_no = plan["probe_no"]
    next_delay = (
        cap
        if plan["step_next"] >= 32
        else min(base * (2 ** plan["step_next"]), cap)
    )
    replay = (
        " Prepared probe replayed after an interrupted commit."
        if plan["mode"] == "replay"
        else ""
    )
    manual = f"python3 {Path(__file__).resolve()} resume {child}"
    title = f"Restart storm auto-resume probe #{probe_no}: {child}"
    retrip = (
        "If it re-trips, automatic recovery will stop."
        if plan["cap_probe_count_next"] >= cap_probes
        else f"If it re-trips, the next cooldown is {next_delay / 60:g}min."
    )
    body = (
        f"Releasing held episode {record['episode_key']} for half-open probe "
        f"#{probe_no}.{replay} {retrip} Manual override: {manual}"
    )
    meta = _script_path("FLYWHEEL_META_ALERT_BIN", "meta-alert.sh")
    if meta.is_file() and os.access(meta, os.X_OK):
        _run_best_effort(
            [str(meta), f"restart_storm_autoresume_{child}", title, body]
        )
    lead = _script_path("FLYWHEEL_LEAD_ALERT_BIN", "lead-alert.sh")
    if lead.is_file() and os.access(lead, os.X_OK):
        _run_best_effort(
            [
                str(lead),
                "--project",
                "flywheel",
                "--lead",
                child,
                "--kind",
                "restart_storm_hold",
                "--severity",
                "warning",
                "--title",
                title,
                "--body",
                body,
                "--signature",
                f"{record['episode_key']}__auto__{probe_no}",
                "--strict-delivery",
            ],
            capture=True,
        )


def _commit_auto_resume(
    root: Path,
    child: str,
    record: dict[str, Any],
    plan: dict[str, Any],
    events: list[dict[str, Any]],
    now: datetime,
    base: int,
    cap: int,
    cap_probes: int,
) -> None:
    last_seq = events[-1]["seq"] if events else 0
    _append_autoresume_audit(
        root,
        child,
        {
            "event": (
                "probe_replayed" if plan["mode"] == "replay" else "probe_intent"
            ),
            "episode_key": record["episode_key"],
            "resume_seq": last_seq,
            "step": plan["step_next"],
            "ts": _format_iso(now),
        },
    )
    _fault("after_autoresume_audit")
    _atomic_write(
        root / f"{child}.auto-resume.json",
        {
            "schema_version": 2,
            "step": plan["step_next"],
            "last_auto_resume_ts": _format_iso(now),
            "episode_key": record["episode_key"],
            "probe_count": plan["probe_count_next"],
            "cap_probe_count": plan["cap_probe_count_next"],
            "total_delay_sec": plan["total_delay_sec_next"],
            "terminal_episode_key": None,
        },
    )
    _fault("after_autoresume_sidecar")
    _write_state(
        root,
        child,
        {"state": "resumed", "last_resumed_seq": last_seq},
    )
    _fault("after_autoresume_state")
    _attempt_autoresume_alert(record, plan, base, cap, cap_probes)


def _attempt_terminal_alert(
    record: dict[str, Any], sidecar: dict[str, Any]
) -> None:
    child = record["child_key"]
    manual = f"python3 {Path(__file__).resolve()} resume {child}"
    hours = sidecar["total_delay_sec"] / 3600
    title = f"Restart storm auto-recovery abandoned: {child}"
    body = (
        f"Automatic recovery abandoned after {sidecar['probe_count']} probes "
        f"over {hours:g}h; terminal_hold requires manual recovery: {manual}"
    )
    meta = _script_path("FLYWHEEL_META_ALERT_BIN", "meta-alert.sh")
    if meta.is_file() and os.access(meta, os.X_OK):
        _run_best_effort(
            [str(meta), f"restart_storm_autoresume_{child}", title, body]
        )
    lead = _script_path("FLYWHEEL_LEAD_ALERT_BIN", "lead-alert.sh")
    if lead.is_file() and os.access(lead, os.X_OK):
        _run_best_effort(
            [
                str(lead),
                "--project",
                "flywheel",
                "--lead",
                child,
                "--kind",
                "restart_storm_hold",
                "--severity",
                "severe",
                "--title",
                title,
                "--body",
                body,
                "--signature",
                f"{record['episode_key']}__terminal",
                "--strict-delivery",
            ],
            capture=True,
        )


def _enter_terminal_hold(
    root: Path,
    child: str,
    state_value: dict[str, Any],
    record: dict[str, Any],
    plan: dict[str, Any],
) -> None:
    sidecar = dict(plan["sidecar"])
    _attempt_terminal_alert(record, sidecar)
    sidecar["terminal_episode_key"] = record["episode_key"]
    _atomic_write(root / f"{child}.auto-resume.json", sidecar)
    _fault("after_terminal_sidecar")
    terminal = dict(state_value)
    terminal["state"] = "terminal_hold"
    _write_state(root, child, terminal)


def _normalize_resumed_state(
    root: Path, child: str, state_value: dict[str, Any]
) -> dict[str, Any]:
    if state_value["state"] != "resumed":
        return state_value
    active = {
        "state": "active",
        "last_resumed_seq": state_value["last_resumed_seq"],
    }
    _write_state(root, child, active)
    return active


def _evaluate_brake(
    root: Path,
    child: str,
    state_value: dict[str, Any],
    events: list[dict[str, Any]],
    now: datetime,
    window_seconds: int,
    max_restarts: int,
    autoresume_base: int,
    autoresume_cap: int,
    autoresume_stick: int,
    autoresume_cap_probes: int,
) -> int:
    cutoff = now.timestamp() - window_seconds
    relevant = [
        event
        for event in events
        if event["seq"] > state_value["last_resumed_seq"]
        and _parse_iso(event["ts"]).timestamp() >= cutoff
    ]
    if len(relevant) <= max_restarts:
        return EXIT_OK
    first = relevant[0]
    window_start = _parse_iso(first["ts"])
    pending = {
        "state": "held_alert_pending",
        "episode_key": _episode_key(child, window_start, first["seq"]),
        "window_start": _format_iso(window_start),
        "last_resumed_seq": state_value["last_resumed_seq"],
    }
    _write_state(root, child, pending)
    _fault("after_hold_claim")
    alert_plan = _autoresume_display_plan(
        root,
        child,
        pending,
        events,
        now,
        autoresume_base,
        autoresume_cap,
        autoresume_stick,
        autoresume_cap_probes,
    )
    if alert_plan["mode"] == "terminal":
        record = _record_for_state(child, pending, events)
        _enter_terminal_hold(
            root, child, pending, record, alert_plan
        )
        return EXIT_HELD
    _recover_pending(root, child, pending, events, alert_plan)
    return EXIT_HELD


def _print_record_result(
    root: Path,
    child: str,
    ledger_seq: int,
    recorded: bool,
    reason: str | None = None,
) -> None:
    value = _read_state(root, child)
    value["ledger_seq"] = ledger_seq
    value["recorded"] = recorded
    if reason is not None:
        value["reason"] = reason
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))


def _gate(root: Path, child: str) -> int:
    window_seconds = _parse_positive_env(
        "FLYWHEEL_RESTART_STORM_WINDOW_SEC", 600
    )
    max_restarts = _parse_positive_env("FLYWHEEL_RESTART_STORM_MAX", 5)
    (
        autoresume_base,
        autoresume_cap,
        autoresume_stick,
        autoresume_cap_probes,
    ) = _parse_autoresume_env()
    lock = _acquire_lock(root, f"{child}.lock")
    if lock is None:
        return EXIT_LOCKED
    try:
        try:
            state_value = _read_state(root, child)
            state_name = state_value["state"]
            if state_name == "terminal_hold":
                return EXIT_HELD
            if state_name in {
                "held_alert_pending",
                "held_alert_attempted",
            }:
                ledger_fd, events = _read_ledger(root, child, True)
                try:
                    now = datetime.now(timezone.utc)
                    plan = _autoresume_plan(
                        root,
                        child,
                        state_value,
                        events,
                        now,
                        autoresume_base,
                        autoresume_cap,
                        autoresume_stick,
                        autoresume_cap_probes,
                    )
                    if plan is None:
                        if state_name == "held_alert_pending":
                            alert_plan = _autoresume_display_plan(
                                root,
                                child,
                                state_value,
                                events,
                                now,
                                autoresume_base,
                                autoresume_cap,
                                autoresume_stick,
                                autoresume_cap_probes,
                            )
                            _recover_pending(
                                root,
                                child,
                                state_value,
                                events,
                                alert_plan,
                            )
                        return EXIT_HELD
                    if plan["mode"] == "terminal":
                        record = _record_for_state(
                            child, state_value, events
                        )
                        _enter_terminal_hold(
                            root, child, state_value, record, plan
                        )
                        return EXIT_HELD
                    if state_name == "held_alert_pending":
                        _recover_pending(
                            root, child, state_value, events, plan
                        )
                        state_value = _read_state(root, child)
                    record = _record_for_state(
                        child, state_value, events
                    )
                    _commit_auto_resume(
                        root,
                        child,
                        record,
                        plan,
                        events,
                        now,
                        autoresume_base,
                        autoresume_cap,
                        autoresume_cap_probes,
                    )
                    state_value = _normalize_resumed_state(
                        root, child, _read_state(root, child)
                    )
                    _append_ledger(ledger_fd, events, now)
                    return _evaluate_brake(
                        root,
                        child,
                        state_value,
                        events,
                        now,
                        window_seconds,
                        max_restarts,
                        autoresume_base,
                        autoresume_cap,
                        autoresume_stick,
                        autoresume_cap_probes,
                    )
                finally:
                    if ledger_fd >= 0:
                        os.close(ledger_fd)
            state_value = _normalize_resumed_state(root, child, state_value)

            ledger_fd, events = _read_ledger(root, child, True)
            try:
                now = datetime.now(timezone.utc)
                _append_ledger(ledger_fd, events, now)
            finally:
                if ledger_fd >= 0:
                    os.close(ledger_fd)
            return _evaluate_brake(
                root,
                child,
                state_value,
                events,
                now,
                window_seconds,
                max_restarts,
                autoresume_base,
                autoresume_cap,
                autoresume_stick,
                autoresume_cap_probes,
            )
        except DataFailure as error:
            alert_kind = (
                "restart_gate_ledger_corrupt"
                if "ledger" in str(error)
                else "restart_gate_state_corrupt"
            )
            _emit_corruption_alert(
                child,
                alert_kind,
                f"{child}: {error}",
            )
            sys.stderr.write(f"restart-storm-gate: {error}\n")
            return EXIT_INVALID
    finally:
        _release_lock(lock)


def _record_failure(root: Path, child: str, expected_seq: int) -> int:
    window_seconds = _parse_positive_env(
        "FLYWHEEL_RESTART_STORM_WINDOW_SEC", 600
    )
    max_restarts = _parse_positive_env("FLYWHEEL_RESTART_STORM_MAX", 5)
    (
        autoresume_base,
        autoresume_cap,
        autoresume_stick,
        autoresume_cap_probes,
    ) = _parse_autoresume_env()
    lock = _acquire_lock(root, f"{child}.lock")
    if lock is None:
        return EXIT_LOCKED
    try:
        try:
            state_value = _read_state(root, child)
            ledger_fd, events = _read_ledger(root, child, True)
            try:
                ledger_seq = events[-1]["seq"] if events else 0
                if state_value["state"] == "terminal_hold":
                    _print_record_result(
                        root, child, ledger_seq, False, "held"
                    )
                    return EXIT_HELD
                if state_value["state"] in {
                    "held_alert_pending",
                    "held_alert_attempted",
                }:
                    now = datetime.now(timezone.utc)
                    alert_plan = _autoresume_display_plan(
                        root,
                        child,
                        state_value,
                        events,
                        now,
                        autoresume_base,
                        autoresume_cap,
                        autoresume_stick,
                        autoresume_cap_probes,
                    )
                    if alert_plan["mode"] == "terminal":
                        record = _record_for_state(
                            child, state_value, events
                        )
                        _enter_terminal_hold(
                            root,
                            child,
                            state_value,
                            record,
                            alert_plan,
                        )
                        _print_record_result(
                            root, child, ledger_seq, False, "held"
                        )
                        return EXIT_HELD
                    if state_value["state"] == "held_alert_pending":
                        _recover_pending(
                            root,
                            child,
                            state_value,
                            events,
                            alert_plan,
                        )
                    _print_record_result(
                        root, child, ledger_seq, False, "held"
                    )
                    return EXIT_HELD
                state_value = _normalize_resumed_state(
                    root, child, state_value
                )
                if ledger_seq != expected_seq:
                    _print_record_result(
                        root, child, ledger_seq, False, "seq_changed"
                    )
                    return EXIT_OK
                now = datetime.now(timezone.utc)
                event = _append_ledger(ledger_fd, events, now)
            finally:
                if ledger_fd >= 0:
                    os.close(ledger_fd)
            result = _evaluate_brake(
                root,
                child,
                state_value,
                events,
                now,
                window_seconds,
                max_restarts,
                autoresume_base,
                autoresume_cap,
                autoresume_stick,
                autoresume_cap_probes,
            )
            _print_record_result(root, child, event["seq"], True)
            return result
        except DataFailure as error:
            alert_kind = (
                "restart_gate_ledger_corrupt"
                if "ledger" in str(error)
                else "restart_gate_state_corrupt"
            )
            _emit_corruption_alert(
                child,
                alert_kind,
                f"{child}: {error}",
            )
            sys.stderr.write(f"restart-storm-gate: {error}\n")
            return EXIT_INVALID
    finally:
        _release_lock(lock)


def _append_controlled_audit(
    root: Path, child: str, value: dict[str, Any]
) -> None:
    path = root / f"{child}.controlled-waves.ndjson"
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
    fd = _open_nofollow(path, flags, 0o600)
    try:
        audit_stat = os.fstat(fd)
        if not stat.S_ISREG(audit_stat.st_mode) or stat.S_IMODE(audit_stat.st_mode) != 0o600:
            raise DataFailure("controlled-wave audit must be a 0600 regular file")
        _write_all(fd, _json_bytes(value))
        os.fsync(fd)
    finally:
        os.close(fd)
    _fsync_dir(root)


def _arm_controlled_wave(
    root: Path,
    child: str,
    expected_seq: int,
    marker_path: str,
    attempt_id: str,
) -> int:
    lock = _acquire_lock(root, f"{child}.lock")
    if lock is None:
        return EXIT_LOCKED
    try:
        try:
            marker, marker_digest = _read_controlled_marker(
                marker_path, child, attempt_id
            )
            state_value = _read_state(root, child)
            ledger_fd, events = _read_ledger(root, child, False)
            try:
                ledger_seq = events[-1]["seq"] if events else 0
            finally:
                if ledger_fd >= 0:
                    os.close(ledger_fd)
            if ledger_seq != expected_seq:
                print(
                    json.dumps(
                        {
                            "expectedSeq": expected_seq,
                            "ledgerSeq": ledger_seq,
                            "reason": "seq_changed",
                            "status": "not_armed",
                        },
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                )
                return EXIT_HELD

            common = {
                "attempt_id": attempt_id,
                "expected_seq": expected_seq,
                "marker_digest": marker_digest,
                "marker_path": str(marker),
                "previous_state": state_value["state"],
                "ts": _format_iso(datetime.now(timezone.utc)),
            }
            _append_controlled_audit(
                root, child, {**common, "event": "prepared"}
            )
            _fault("after_controlled_prepared")
            _write_state(
                root,
                child,
                {"state": "resumed", "last_resumed_seq": ledger_seq},
            )
            _remove_autoresume_sidecar(root, child)
            _fault("after_controlled_state")
            _append_controlled_audit(
                root,
                child,
                {
                    **common,
                    "event": "armed",
                    "ts": _format_iso(datetime.now(timezone.utc)),
                },
            )
            print(
                json.dumps(
                    {
                        "attemptId": attempt_id,
                        "ledgerSeq": ledger_seq,
                        "markerDigest": marker_digest,
                        "status": "armed",
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                )
            )
            return EXIT_OK
        except DataFailure as error:
            sys.stderr.write(f"restart-storm-gate: {error}\n")
            return EXIT_INVALID
    finally:
        _release_lock(lock)


def _resume(root: Path, child: str) -> int:
    lock = _acquire_lock(root, f"{child}.lock")
    if lock is None:
        return EXIT_LOCKED
    try:
        try:
            state_value = _read_state(root, child)
            _remove_autoresume_sidecar(root, child)
            if state_value["state"] not in {
                "held_alert_pending",
                "held_alert_attempted",
                "terminal_hold",
            }:
                return EXIT_OK
            ledger_fd, events = _read_ledger(root, child, True)
            try:
                last_seq = events[-1]["seq"] if events else 0
            finally:
                if ledger_fd >= 0:
                    os.close(ledger_fd)
            _write_state(
                root,
                child,
                {"state": "resumed", "last_resumed_seq": last_seq},
            )
            return EXIT_OK
        except DataFailure as error:
            alert_kind = (
                "restart_gate_ledger_corrupt"
                if "ledger" in str(error)
                else "restart_gate_state_corrupt"
            )
            _emit_corruption_alert(
                child,
                alert_kind,
                f"{child}: {error}",
            )
            sys.stderr.write(f"restart-storm-gate: {error}\n")
            return EXIT_INVALID
    finally:
        _release_lock(lock)


def _status(root: Path, child: str, with_seq: bool) -> int:
    lock = _acquire_lock(root, f"{child}.lock", shared=not with_seq)
    if lock is None:
        return EXIT_LOCKED
    try:
        try:
            value = _read_state(root, child)
            if with_seq:
                ledger_fd, events = _read_ledger(root, child, True)
                try:
                    value["ledger_seq"] = (
                        events[-1]["seq"] if events else 0
                    )
                finally:
                    if ledger_fd >= 0:
                        os.close(ledger_fd)
        except DataFailure as error:
            sys.stderr.write(f"restart-storm-gate: {error}\n")
            return EXIT_INVALID
        print(json.dumps(value, separators=(",", ":"), sort_keys=True))
        return EXIT_OK
    finally:
        _release_lock(lock)


def _build_parser() -> GateArgumentParser:
    parser = GateArgumentParser(prog="restart-storm-gate.py")
    commands = parser.add_subparsers(
        dest="command", required=True, parser_class=GateArgumentParser
    )

    for name in ("gate", "resume"):
        command = commands.add_parser(name)
        command.add_argument("--root")
        command.add_argument("child_key")

    status = commands.add_parser("status")
    status.add_argument("--root")
    status.add_argument("--with-seq", action="store_true")
    status.add_argument("child_key")

    record = commands.add_parser("record-failure")
    record.add_argument("--root")
    record.add_argument(
        "--expected-seq", required=True, type=_parse_nonnegative_int
    )
    record.add_argument("child_key")

    controlled = commands.add_parser("arm-controlled-wave")
    controlled.add_argument("--root")
    controlled.add_argument(
        "--expected-seq", required=True, type=_parse_nonnegative_int
    )
    controlled.add_argument("--intent-marker", required=True)
    controlled.add_argument("--attempt-id", required=True)
    controlled.add_argument("child_key")
    return parser


def main(argv: list[str]) -> int:
    try:
        args = _build_parser().parse_args(argv)
        root = _normalize_root(args.root)
        child = _validate_child(args.child_key)
        if args.command == "gate":
            return _gate(root, child)
        if args.command == "record-failure":
            return _record_failure(root, child, args.expected_seq)
        if args.command == "arm-controlled-wave":
            return _arm_controlled_wave(
                root,
                child,
                args.expected_seq,
                args.intent_marker,
                args.attempt_id,
            )
        if args.command == "resume":
            return _resume(root, child)
        if args.command == "status":
            return _status(root, child, args.with_seq)
        raise UsageFailure(f"unknown command: {args.command}")
    except UsageFailure as error:
        sys.stderr.write(f"restart-storm-gate: {error}\n")
        return EXIT_INVALID
    except (OSError, DataFailure) as error:
        sys.stderr.write(f"restart-storm-gate: {error}\n")
        return EXIT_INVALID


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
