#!/usr/bin/env python3
"""Kernel-independent restart-storm ledger and launch gate (FLY-1501 W3).

The wrapper contract is intentionally small:
  gate                         0=launch, 2=lock busy, 3=held, 4=invalid
  record-failure               0=recorded/no-op, 2=lock busy, 3=held, 4=invalid
  resume/status [--with-seq]   0=success, 2=lock busy, 4=invalid

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
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
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
    if state in {"held_alert_pending", "held_alert_attempted"}:
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
    if state in {"held_alert_pending", "held_alert_attempted"}:
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


def _attempt_hold_alert(record: dict[str, Any]) -> bool:
    child = record["child_key"]
    episode = record["episode_key"]
    title = f"Restart storm held: {child}"
    body = (
        f"{child} crashed {record['count']} times since "
        f"{record['window_start']}; automatic restart is held. "
        f"Inspect the service, then run restart-storm-gate.py resume {child}."
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
) -> None:
    record = _record_for_state(child, state_value, events)
    if _attempt_hold_alert(record):
        attempted = dict(state_value)
        attempted["state"] = "held_alert_attempted"
        _write_state(root, child, attempted)


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
    _recover_pending(root, child, pending, events)
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
    lock = _acquire_lock(root, f"{child}.lock")
    if lock is None:
        return EXIT_LOCKED
    try:
        try:
            state_value = _read_state(root, child)
            state_name = state_value["state"]
            if state_name == "held_alert_attempted":
                return EXIT_HELD
            if state_name == "held_alert_pending":
                ledger_fd, events = _read_ledger(root, child, True)
                try:
                    _recover_pending(root, child, state_value, events)
                finally:
                    if ledger_fd >= 0:
                        os.close(ledger_fd)
                return EXIT_HELD
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
    lock = _acquire_lock(root, f"{child}.lock")
    if lock is None:
        return EXIT_LOCKED
    try:
        try:
            state_value = _read_state(root, child)
            ledger_fd, events = _read_ledger(root, child, True)
            try:
                ledger_seq = events[-1]["seq"] if events else 0
                if state_value["state"] == "held_alert_pending":
                    _recover_pending(root, child, state_value, events)
                    _print_record_result(
                        root, child, ledger_seq, False, "held"
                    )
                    return EXIT_HELD
                if state_value["state"] == "held_alert_attempted":
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


def _resume(root: Path, child: str) -> int:
    lock = _acquire_lock(root, f"{child}.lock")
    if lock is None:
        return EXIT_LOCKED
    try:
        try:
            state_value = _read_state(root, child)
            if state_value["state"] not in {
                "held_alert_pending",
                "held_alert_attempted",
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
