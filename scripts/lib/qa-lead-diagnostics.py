#!/usr/bin/env python3
"""Bounded, redacted diagnostics for 529-room Lead carrier failures."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import selectors
import subprocess
import sys
import tempfile
import time
from typing import Any


MAX_INPUT_BYTES = 64 * 1024
PROBE_TIMEOUT_SECONDS = 2
MAX_PROBE_OUTPUT_BYTES = 4096
BODY_OUTPUT_LIMIT = 256 * 1024
LABEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
QA_RUNTIME_RE = re.compile(
    r"/(?:private/)?tmp/flywheel-test-slot-[0-9]+/launchd/"
    r"([A-Za-z0-9][A-Za-z0-9._-]*)"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def safe_path(raw: str, *, must_exist: bool = False) -> Path:
    if not raw.startswith("/") or "\n" in raw or "\r" in raw or "\x00" in raw:
        raise ValueError("path must be absolute and contain no control characters")
    path = Path(raw)
    if must_exist:
        info = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(info.st_mode):
            raise ValueError("input must be a regular non-symlink file")
    return path


def safe_executable(raw: str) -> Path:
    # Probe availability is diagnostic data, not a precondition for recording
    # the rest of the snapshot. run_probe() classifies absent/non-executable
    # paths as unavailable while still allowing a trusted absolute symlink such
    # as Homebrew's /opt/homebrew/bin/tmux.
    return safe_path(raw)


def read_bounded(path: Path) -> bytes:
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_size > MAX_INPUT_BYTES:
        raise ValueError("input is not a bounded regular file")
    data = path.read_bytes()
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError("input is too large")
    return data


def run_probe(argv: list[str]) -> subprocess.CompletedProcess[str] | None:
    process: subprocess.Popen[bytes] | None = None
    try:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError:
        return None

    retained = {"stdout": bytearray(), "stderr": bytearray()}
    deadline = time.monotonic() + PROBE_TIMEOUT_SECONDS
    try:
        # A descendant can retain a pipe after the direct child exits. Bound
        # draining and process completion by one deadline, not just wait().
        with selectors.DefaultSelector() as selector:
            for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                for key, _ in selector.select(remaining):
                    try:
                        chunk = os.read(key.fd, 64 * 1024)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    capacity = MAX_PROBE_OUTPUT_BYTES - len(retained[key.data])
                    if capacity > 0:
                        retained[key.data].extend(chunk[:capacity])
            returncode = process.wait(timeout=max(0, deadline - time.monotonic()))
        return subprocess.CompletedProcess(
            argv,
            returncode,
            retained["stdout"].decode("utf-8", errors="replace"),
            retained["stderr"].decode("utf-8", errors="replace"),
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    finally:
        # Only the process we launched is signal authority; closing our pipe
        # ends does not grant authority over other processes holding copies.
        if process.poll() is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        process.wait()
        process.stdout.close()
        process.stderr.close()


def parse_int(raw: str | None) -> int | None:
    if raw is None or not re.fullmatch(r"[1-9][0-9]*", raw):
        return None
    return int(raw)


def launchd_snapshot(
    binary: Path, domain: str, label: str
) -> tuple[dict[str, Any], str | None]:
    result = run_probe([str(binary), "print", f"{domain}/{label}"])
    empty = {"state": "unknown", "pid": None, "lastExitCode": None}
    if result is None:
        return empty, "probe_unavailable"
    if result.returncode != 0:
        message = (result.stderr + "\n" + result.stdout).lower()[:4096]
        if any(
            marker in message
            for marker in ("could not find service", "service not found", "no such process")
        ):
            return {"state": "not_found", "pid": None, "lastExitCode": None}, (
                "launchd_job_missing"
            )
        return empty, "probe_unavailable"
    state_match = re.search(r"(?m)^\s*state\s*=\s*([^\s]+)\s*$", result.stdout)
    pid_matches = re.findall(r"(?m)^\s*pid\s*=\s*([1-9][0-9]*)\s*$", result.stdout)
    exit_match = re.search(
        r"(?m)^\s*last exit code\s*=\s*(-?[0-9]+)\s*$", result.stdout
    )
    value = {
        "state": state_match.group(1) if state_match else "unknown",
        "pid": int(pid_matches[0]) if len(pid_matches) == 1 else None,
        "lastExitCode": int(exit_match.group(1)) if exit_match else None,
    }
    return value, None if value["pid"] is not None else "launchd_pid_missing"


def classify_tmux_error(message: str) -> str:
    lowered = message.lower()[:4096]
    if "protocol version mismatch" in lowered or "protocol mismatch" in lowered:
        return "protocol_mismatch"
    if any(
        marker in lowered
        for marker in ("no server running", "error connecting to", "connect failed")
    ):
        return "socket_unavailable"
    if "can't find session" in lowered or "session not found" in lowered:
        return "session_missing"
    return "unknown"


def tmux_snapshot(binary: Path, socket_path: str | None) -> tuple[dict[str, Any], str | None]:
    identity = run_probe([str(binary), "-V"])
    value = {
        "binary": str(binary),
        "realpath": os.path.realpath(binary),
        "version": "unknown",
        "exitCode": None,
        "kind": "unknown",
        "socketExists": None if socket_path is None else Path(socket_path).exists(),
    }
    if identity is None or identity.returncode != 0 or len(identity.stdout) > 256:
        value["kind"] = "probe_unavailable"
        return value, "probe_unavailable"
    version = identity.stdout.strip()
    if not re.fullmatch(r"tmux\s+\S+", version):
        value["kind"] = "probe_unavailable"
        return value, "probe_unavailable"
    value["version"] = version
    if socket_path is None:
        return value, None
    probe = run_probe([str(binary), "-S", socket_path, "has-session", "-t", "=main"])
    if probe is None:
        value["kind"] = "probe_unavailable"
        return value, "probe_unavailable"
    value["exitCode"] = probe.returncode
    if probe.returncode == 0:
        value["kind"] = "ok"
        return value, None
    value["kind"] = classify_tmux_error(probe.stderr + "\n" + probe.stdout)
    return value, "session_probe_failed"


def manifest_snapshot(path: Path) -> tuple[str, int | None, str | None, list[str]]:
    if not path.exists() and not path.is_symlink():
        return "missing", None, None, ["manifest_missing"]
    try:
        value = json.loads(read_bounded(path))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return "invalid", None, None, ["manifest_invalid"]
    if not isinstance(value, dict):
        return "invalid", None, None, ["manifest_invalid"]
    lead_id = value.get("leadId")
    project_name = value.get("projectName")
    if not isinstance(lead_id, str) or not lead_id or not isinstance(project_name, str) or not project_name:
        return "invalid", None, None, ["manifest_invalid"]
    pid = value.get("pid")
    socket_path = value.get("socketPath")
    if type(pid) is not int or pid <= 0 or not isinstance(socket_path, str) or not socket_path:
        return "configured", None, None, ["runtime_unpublished"]
    if not socket_path.startswith("/") or any(char in socket_path for char in "\r\n\x00"):
        return "invalid", None, None, ["manifest_invalid"]
    return "runtime_published", pid, socket_path, []


def plist_matches(path: Path, label: str, wrapper: Path, manifest: Path) -> bool:
    try:
        value = plistlib.loads(read_bounded(path))
    except (OSError, ValueError, plistlib.InvalidFileException):
        return False
    return (
        isinstance(value, dict)
        and value.get("Label") == label
        and value.get("ProgramArguments") == [str(wrapper), str(manifest)]
    )


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    parent = path.parent
    parent_info = parent.lstat()
    if parent.is_symlink() or not stat.S_ISDIR(parent_info.st_mode):
        raise ValueError("evidence parent must be a non-symlink directory")
    if path.exists() or path.is_symlink():
        target_info = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(target_info.st_mode):
            raise ValueError("evidence target must be a regular non-symlink file")
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def load_json_object(path: Path) -> dict[str, Any]:
    value = json.loads(read_bounded(path))
    if not isinstance(value, dict):
        raise ValueError("JSON value must be an object")
    return value


def validate_runtime_path(
    raw_runtime: str, *, manifest_raw: str | None = None, lead_id: str | None = None
) -> Path:
    runtime = safe_path(raw_runtime)
    info = runtime.lstat()
    if runtime.is_symlink() or not stat.S_ISDIR(info.st_mode):
        raise ValueError("runtime must be a non-symlink directory")
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("runtime must be owned by this uid with mode 0700")
    resolved = runtime.resolve(strict=True)
    match = QA_RUNTIME_RE.fullmatch(str(resolved))
    if match is None:
        raise ValueError("runtime is outside the QA slot launchd root")
    path_lead_id = match.group(1)
    if lead_id is not None and (not LABEL_RE.fullmatch(lead_id) or lead_id != path_lead_id):
        raise ValueError("runtime lead identity mismatch")
    if manifest_raw is not None:
        manifest = safe_path(manifest_raw, must_exist=True)
        if manifest.parent.resolve(strict=True) != resolved:
            raise ValueError("runtime must equal the manifest parent")
        manifest_value = load_json_object(manifest)
        manifest_lead_id = manifest_value.get("leadId")
        if not isinstance(manifest_lead_id, str) or manifest_lead_id != path_lead_id:
            raise ValueError("manifest lead identity mismatch")
        if lead_id is not None and manifest_lead_id != lead_id:
            raise ValueError("canonical lead identity mismatch")
    return runtime


def validate_runtime(args: argparse.Namespace) -> int:
    validate_runtime_path(
        args.runtime, manifest_raw=args.manifest, lead_id=args.lead_id
    )
    return 0


def required_pid(raw: str, name: str) -> int:
    value = parse_int(raw)
    if value is None:
        raise ValueError(f"{name} must be a positive integer")
    return value


def exit_code(raw: str | None, name: str) -> int | None:
    if raw is None or not re.fullmatch(r"[0-9]+", raw):
        if raw is None:
            return None
        raise ValueError(f"{name} must be a non-negative integer")
    value = int(raw)
    if value > 255:
        raise ValueError(f"{name} is outside the shell exit-code range")
    return value


def executable_identity(binary: Path) -> dict[str, str]:
    value = {
        "binary": str(binary),
        "realpath": os.path.realpath(binary),
        "version": "unknown",
        "architecture": "unknown",
    }
    version = run_probe([str(binary), "-V"])
    if version is not None and version.returncode == 0:
        candidate = version.stdout.strip()
        if len(candidate) <= 256 and re.fullmatch(r"tmux\s+\S+", candidate):
            value["version"] = candidate
    file_binary = Path("/usr/bin/file")
    if file_binary.is_file():
        architecture = run_probe([str(file_binary), "-b", str(binary)])
        if architecture is not None and architecture.returncode == 0:
            candidate = architecture.stdout.strip()
            if len(candidate) <= 512 and not any(c in candidate for c in "\r\n\x00"):
                value["architecture"] = candidate
    return value


def empty_body_status(carrier_pid: int) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "carrierPid": carrier_pid,
        "carrierTmux": None,
        "bodyPid": None,
        "startedAt": None,
        "endedAt": None,
        "exitCode": None,
        "exitObservation": None,
        "claudeExitCode": None,
        "observedShellExitCode": None,
    }


def read_body_status(path: Path) -> dict[str, Any] | None:
    if not path.exists() and not path.is_symlink():
        return None
    value = load_json_object(path)
    if value.get("schemaVersion") != 1 or type(value.get("carrierPid")) is not int:
        raise ValueError("body status is invalid")
    return value


def update_body_status(args: argparse.Namespace) -> int:
    runtime = validate_runtime_path(args.runtime)
    carrier_pid = required_pid(args.carrier_pid, "carrier pid")
    status_path = runtime / "body-status.json"
    current = read_body_status(status_path)
    if args.event in ("carrier", "started") and (
        current is None or current.get("carrierPid") != carrier_pid
    ):
        current = empty_body_status(carrier_pid)
    elif current is None or current.get("carrierPid") != carrier_pid:
        raise ValueError("body status generation mismatch")

    if args.event == "carrier":
        tmux = safe_executable(args.tmux)
        current["carrierTmux"] = executable_identity(tmux)
    elif args.event == "started":
        current["bodyPid"] = required_pid(args.body_pid, "body pid")
        current["startedAt"] = utc_now()
        current["endedAt"] = None
        current["exitCode"] = None
        current["exitObservation"] = None
        current["claudeExitCode"] = None
        current["observedShellExitCode"] = None
    elif args.event == "pre-server-stop":
        current["endedAt"] = utc_now()
        current["exitCode"] = exit_code(args.exit_code, "exit code")
        current["exitObservation"] = "pre_server_stop"
        current["claudeExitCode"] = exit_code(
            args.claude_exit_code, "Claude exit code"
        )
    elif args.event == "shell-exit":
        observed = exit_code(args.exit_code, "exit code")
        current["observedShellExitCode"] = observed
        if current.get("endedAt") is None:
            current["endedAt"] = utc_now()
            current["exitCode"] = observed
            current["exitObservation"] = "shell_exit"
    else:
        raise ValueError("unsupported body status event")
    atomic_json(status_path, current)
    return 0


def process_start_identity(pid: int) -> str | None:
    ps = Path("/bin/ps")
    if not ps.is_file():
        return None
    result = run_probe([str(ps), "-p", str(pid), "-o", "lstart="])
    if result is None or result.returncode != 0:
        return None
    value = result.stdout.strip()
    if not value or len(value) > 256 or any(char in value for char in "\r\n\x00"):
        return None
    return value


def record_body_output(args: argparse.Namespace) -> int:
    runtime = validate_runtime_path(args.runtime)
    carrier_pid = required_pid(args.carrier_pid, "carrier pid")
    output_path = runtime / "body-output.log"
    recorder_path = runtime / "body-recorder.json"
    marker_path = runtime / "body-output.truncated"
    recorder = {
        "schemaVersion": 1,
        "carrierPid": carrier_pid,
        "recorderPid": os.getpid(),
        "recorderStartIdentity": process_start_identity(os.getpid()),
        "active": True,
        "startedAt": utc_now(),
        "endedAt": None,
        "truncated": False,
    }
    atomic_json(recorder_path, recorder)
    descriptor: int | None = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(output_path, flags, 0o600)
        os.fchmod(descriptor, 0o600)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("body output target is unsafe")
        used = info.st_size
        boundary = (
            f"\n--- FLYWHEEL_QA_GENERATION carrierPid={carrier_pid} "
            f"startedAt={recorder['startedAt']} ---\n"
        ).encode("utf-8")
        if used < BODY_OUTPUT_LIMIT:
            written = boundary[: BODY_OUTPUT_LIMIT - used]
            os.write(descriptor, written)
            used += len(written)
        while True:
            chunk = sys.stdin.buffer.read(64 * 1024)
            if not chunk:
                break
            if used < BODY_OUTPUT_LIMIT:
                written = chunk[: BODY_OUTPUT_LIMIT - used]
                os.write(descriptor, written)
                used += len(written)
                if len(written) < len(chunk):
                    recorder["truncated"] = True
            else:
                recorder["truncated"] = True
        if recorder["truncated"]:
            atomic_json(
                marker_path,
                {"schemaVersion": 1, "carrierPid": carrier_pid, "truncated": True},
            )
    finally:
        if descriptor is not None:
            os.close(descriptor)
        recorder["active"] = False
        recorder["endedAt"] = utc_now()
        atomic_json(recorder_path, recorder)
    return 0


def discard_body_output(args: argparse.Namespace) -> int:
    runtime = validate_runtime_path(args.runtime)
    recorder_path = runtime / "body-recorder.json"
    output_path = runtime / "body-output.log"
    marker_path = runtime / "body-output.truncated"
    if output_path.exists() or output_path.is_symlink():
        if not recorder_path.exists() or recorder_path.is_symlink():
            raise ValueError("body output has no recorder ownership record")
        recorder = load_json_object(recorder_path)
        if (
            recorder.get("schemaVersion") != 1
            or type(recorder.get("carrierPid")) is not int
            or recorder["carrierPid"] <= 0
            or type(recorder.get("recorderPid")) is not int
            or recorder["recorderPid"] <= 0
            or not isinstance(recorder.get("startedAt"), str)
            or type(recorder.get("truncated")) is not bool
            or type(recorder.get("active")) is not bool
        ):
            raise ValueError("body output recorder ownership record is invalid")
        if recorder.get("active") is True:
            recorder_pid = recorder.get("recorderPid")
            expected_start = recorder.get("recorderStartIdentity")
            actual_start = process_start_identity(recorder_pid)
            if expected_start is None or actual_start is None or actual_start == expected_start:
                raise ValueError("body output recorder is still active or unverified")
        elif not isinstance(recorder.get("endedAt"), str):
            raise ValueError("body output recorder completion is unverified")
    for path in (output_path, marker_path):
        if path.exists() or path.is_symlink():
            info = path.lstat()
            if path.is_symlink() or not stat.S_ISREG(info.st_mode):
                raise ValueError("body output residue target is unsafe")
            path.unlink()
    return 0


def body_snapshot(
    runtime: Path, runtime_pid: int | None, launchd_pid: int | None
) -> dict[str, Any]:
    path = runtime / "body-status.json"
    if not path.exists() and not path.is_symlink():
        return {"state": "unknown", "exitCode": None}
    try:
        value = load_json_object(path)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return {"state": "unknown", "exitCode": None}
    carrier_pid = value.get("carrierPid")
    if (
        type(carrier_pid) is not int
        or carrier_pid <= 0
        or runtime_pid is None
        or launchd_pid is None
        or runtime_pid != launchd_pid
        or carrier_pid != runtime_pid
    ):
        return {"state": "stale", "exitCode": None}
    body_pid = value.get("bodyPid")
    if type(body_pid) is not int or body_pid <= 0:
        body_pid = None
    recorded_exit = value.get("exitCode")
    if type(recorded_exit) is not int or not 0 <= recorded_exit <= 255:
        recorded_exit = None
    observation = value.get("exitObservation")
    if observation not in ("pre_server_stop", "shell_exit"):
        observation = None
    claude_exit = value.get("claudeExitCode")
    if type(claude_exit) is not int or not 0 <= claude_exit <= 255:
        claude_exit = None
    shell_exit = value.get("observedShellExitCode")
    if type(shell_exit) is not int or not 0 <= shell_exit <= 255:
        shell_exit = None
    state = "exited" if isinstance(value.get("endedAt"), str) else "running"
    return {
        "state": state,
        "carrierPid": carrier_pid,
        "bodyPid": body_pid,
        "exitCode": recorded_exit,
        "exitObservation": observation,
        "claudeExitCode": claude_exit,
        "observedShellExitCode": shell_exit,
    }


def snapshot(args: argparse.Namespace) -> int:
    if not LABEL_RE.fullmatch(args.label):
        raise ValueError("invalid label")
    manifest = safe_path(args.manifest)
    plist = safe_path(args.plist)
    safe_path(args.log)
    wrapper = safe_path(args.wrapper)
    launchctl = safe_executable(args.launchctl)
    tmux = safe_executable(args.tmux)

    manifest_state, runtime_pid, runtime_socket, checks = manifest_snapshot(manifest)
    if args.phase == "bootstrap":
        checks = [item for item in checks if item != "runtime_unpublished"]
    if not plist_matches(plist, args.label, wrapper, manifest):
        checks.append("plist_mismatch")

    launchd, launchd_check = launchd_snapshot(launchctl, args.domain, args.label)
    if launchd_check is not None:
        checks.append(launchd_check)
    if (
        runtime_pid is not None
        and launchd["pid"] is not None
        and runtime_pid != launchd["pid"]
    ):
        checks.append("pid_mismatch")
    probe, probe_check = tmux_snapshot(tmux, runtime_socket)
    if probe_check is not None:
        checks.append(probe_check)
    checks = list(dict.fromkeys(checks))
    reason_order = (
        "manifest_missing",
        "manifest_invalid",
        "runtime_unpublished",
        "plist_mismatch",
        "launchd_job_missing",
        "launchd_pid_missing",
        "pid_mismatch",
        "session_probe_failed",
        "probe_unavailable",
    )
    reason = next((item for item in reason_order if item in checks), "unknown")
    last_launch_pid = parse_int(args.last_launch_pid)
    observed_at = utc_now()
    result = {
        "schemaVersion": 1,
        "phase": args.phase,
        "reason": reason,
        "label": args.label,
        "manifest": str(manifest),
        "manifestState": manifest_state,
        "launchd": launchd,
        "runtime": {"pid": runtime_pid, "socketPath": runtime_socket},
        "probe": probe,
        "body": body_snapshot(manifest.parent, runtime_pid, launchd["pid"]),
        "checks": checks,
        "observedAt": observed_at,
        "observationKind": "post_failure_reprobe",
        "lastLoopObservation": {
            "launchPid": last_launch_pid,
            "manifestPid": parse_int(args.last_manifest_pid),
            "socketPath": args.last_socket or None,
            "probeExitCode": (
                int(args.last_probe_exit_code)
                if args.last_probe_exit_code is not None
                and re.fullmatch(r"[0-9]+", args.last_probe_exit_code)
                else None
            ),
            "observedAt": args.last_observed_at or None,
        },
        "generationChanged": bool(
            launchd["pid"] is not None
            and last_launch_pid is not None
            and launchd["pid"] != last_launch_pid
        ),
    }
    evidence = manifest.parent / f"{args.phase}-failure.json"
    atomic_json(evidence, result)
    print(
        f"[qa-launchd] ERROR: phase={args.phase} reason={result['reason']} "
        f"label={args.label} plist={args.plist} manifest={args.manifest} "
        f"launchPid={launchd['pid'] or ''} manifestPid={runtime_pid or ''} "
        f"socket={runtime_socket or ''} probeKind={result['probe']['kind']} "
        f"evidencePath={evidence}",
        file=sys.stderr,
    )
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    subcommands = result.add_subparsers(dest="command", required=True)
    command = subcommands.add_parser("snapshot")
    command.add_argument("--phase", choices=("bootstrap", "topology"), required=True)
    command.add_argument("--label", required=True)
    command.add_argument("--plist", required=True)
    command.add_argument("--manifest", required=True)
    command.add_argument("--log", required=True)
    command.add_argument("--wrapper", required=True)
    command.add_argument("--launchctl", required=True)
    command.add_argument("--domain", required=True)
    command.add_argument("--tmux", required=True)
    command.add_argument("--last-launch-pid")
    command.add_argument("--last-manifest-pid")
    command.add_argument("--last-socket")
    command.add_argument("--last-probe-exit-code")
    command.add_argument("--last-observed-at")

    command = subcommands.add_parser("validate-runtime")
    command.add_argument("--runtime", required=True)
    command.add_argument("--manifest", required=True)
    command.add_argument("--lead-id")

    command = subcommands.add_parser("body-status")
    command.add_argument("--runtime", required=True)
    command.add_argument(
        "--event",
        choices=("carrier", "started", "pre-server-stop", "shell-exit"),
        required=True,
    )
    command.add_argument("--carrier-pid", required=True)
    command.add_argument("--body-pid")
    command.add_argument("--tmux")
    command.add_argument("--exit-code")
    command.add_argument("--claude-exit-code")

    command = subcommands.add_parser("record")
    command.add_argument("--runtime", required=True)
    command.add_argument("--carrier-pid", required=True)

    command = subcommands.add_parser("discard")
    command.add_argument("--runtime", required=True)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "snapshot":
            return snapshot(args)
        if args.command == "validate-runtime":
            return validate_runtime(args)
        if args.command == "body-status":
            return update_body_status(args)
        if args.command == "record":
            return record_body_output(args)
        if args.command == "discard":
            return discard_body_output(args)
    except (OSError, ValueError) as error:
        print(f"[qa-launchd] ERROR: diagnostic_write_failed: {type(error).__name__}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
