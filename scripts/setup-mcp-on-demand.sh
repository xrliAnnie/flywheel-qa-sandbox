#!/bin/bash
# FLY-1185 / FLY-1867 — machine-level Playwright MCP policy.
#
# Ordinary Claude sessions inherit two safe defaults:
#   enabledPlugins["playwright@claude-plugins-official"] = false
#   env.PLAYWRIGHT_MCP_HEADLESS = "true"
#
# Runner/Lead launchers may positively opt a specific session back in. Chrome
# remains upstream first-tool lazy, and opt-in sessions stay headless.
#
# Public forms:
#   setup-mcp-on-demand.sh [apply] [path-to-settings.json]
#   setup-mcp-on-demand.sh rollback [path-to-settings.json]
#   setup-mcp-on-demand.sh check [path-to-settings.json]       # read-only
#
# The historical bare-path form is intentionally retained for
# provision-fleet-host.sh and older operators:
#   setup-mcp-on-demand.sh /path/to/settings.json
set -euo pipefail

OP="apply"
SETTINGS=""
case "${1:-}" in
  apply|rollback|check)
    OP="$1"
    SETTINGS="${2:-$HOME/.claude/settings.json}"
    [ "$#" -le 2 ] || { echo "[setup-mcp-on-demand] usage error: too many arguments" >&2; exit 2; }
    ;;
  "")
    SETTINGS="$HOME/.claude/settings.json"
    ;;
  *)
    SETTINGS="$1"
    [ "$#" -eq 1 ] || { echo "[setup-mcp-on-demand] usage error: too many arguments" >&2; exit 2; }
    ;;
esac

exec python3 - "$OP" "$SETTINGS" <<'PY'
from __future__ import annotations

import copy
import fcntl
import hashlib
import json
import os
import stat
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

op = sys.argv[1]
settings = Path(sys.argv[2]).expanduser().absolute()
receipt_path = Path(f"{settings}.flywheel-mcp-policy-receipt.json")
lock_path = Path(f"{settings}.flywheel-mcp-policy.lock")
plugin_key = "playwright@claude-plugins-official"
owned_specs = (
    ("playwrightPlugin", ("enabledPlugins", plugin_key), False),
    ("playwrightHeadless", ("env", "PLAYWRIGHT_MCP_HEADLESS"), "true"),
)


class PolicyError(Exception):
    pass


def fail(message: str, code: int = 1) -> None:
    print(f"[setup-mcp-on-demand] REFUSE: {message}", file=sys.stderr)
    raise SystemExit(code)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def strict_equal(left: Any, right: Any) -> bool:
    return type(left) is type(right) and left == right


def read_regular(path: Path, label: str) -> tuple[bytes, os.stat_result]:
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise PolicyError(f"{label} {path} does not exist")
    if stat.S_ISLNK(info.st_mode):
        raise PolicyError(f"{label} {path} is a symlink")
    if not stat.S_ISREG(info.st_mode):
        raise PolicyError(f"{label} {path} is not a regular file")
    return path.read_bytes(), info


def parse_object(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PolicyError(f"{label} is not valid JSON: {error}")
    if not isinstance(value, dict):
        raise PolicyError(f"{label} JSON root must be an object")
    return value


def lookup(root: dict[str, Any], path: tuple[str, str]) -> tuple[bool, Any]:
    parent = root.get(path[0])
    if not isinstance(parent, dict) or path[1] not in parent:
        return False, None
    return True, parent[path[1]]


def set_path(root: dict[str, Any], path: tuple[str, str], value: Any) -> None:
    parent = root.get(path[0])
    if parent is None:
        parent = {}
        root[path[0]] = parent
    if not isinstance(parent, dict):
        raise PolicyError(f"{path[0]} must be a JSON object, got {type(parent).__name__}")
    parent[path[1]] = value


def delete_path(root: dict[str, Any], path: tuple[str, str]) -> None:
    parent = root.get(path[0])
    if not isinstance(parent, dict):
        return
    parent.pop(path[1], None)
    if not parent:
        root.pop(path[0], None)


def desired(root: dict[str, Any]) -> bool:
    for _, path, applied in owned_specs:
        present, value = lookup(root, path)
        if not present or not strict_equal(value, applied):
            return False
    return True


def encode(root: dict[str, Any]) -> bytes:
    return (json.dumps(root, indent=2, ensure_ascii=False) + "\n").encode()


def fsync_dir(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def prepare_temp(path: Path, raw: bytes, mode: int) -> Path:
    descriptor, temp_name = tempfile.mkstemp(prefix=f"{path.name}.tmp.", dir=path.parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, stat.S_IMODE(mode))
        return temp
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def replace_from_temp(temp: Path, destination: Path) -> None:
    os.replace(temp, destination)
    fsync_dir(destination.parent)


def pause_before_cas() -> None:
    raw = os.environ.get("FLY1867_POLICY_PRE_CAS_PAUSE_MS", "0")
    try:
        millis = max(0, min(int(raw), 10_000))
    except ValueError:
        raise PolicyError("FLY1867_POLICY_PRE_CAS_PAUSE_MS must be an integer")
    if millis:
        time.sleep(millis / 1000)


def verify_cas(expected_sha: str) -> None:
    current_raw, _ = read_regular(settings, "settings")
    if sha256(current_raw) != expected_sha:
        raise PolicyError("settings changed after read (preimage CAS mismatch); retry instead of overwriting")


def load_receipt() -> dict[str, Any] | None:
    if not receipt_path.exists():
        return None
    raw, _ = read_regular(receipt_path, "receipt")
    receipt = parse_object(raw, "receipt")
    if receipt.get("version") != 1:
        raise PolicyError(f"unsupported receipt version {receipt.get('version')!r}")
    if receipt.get("settingsPath") != str(settings):
        raise PolicyError("receipt settingsPath does not match the requested file")
    paths = receipt.get("ownedPaths")
    if not isinstance(paths, list) or len(paths) != len(owned_specs):
        raise PolicyError("receipt ownedPaths is incomplete")
    return receipt


def apply_policy() -> None:
    raw, info = read_regular(settings, "settings")
    root = parse_object(raw, "settings")
    receipt = load_receipt()

    if receipt is not None:
        if desired(root):
            print(f"[setup-mcp-on-demand] no-op: policy already applied in {settings} (first receipt preserved)")
            return
        raise PolicyError("active receipt exists but an owned path drifted; inspect or rollback before re-applying")
    if desired(root):
        print(f"[setup-mcp-on-demand] no-op: policy already applied in {settings}")
        return

    preimage_sha = sha256(raw)
    next_root = copy.deepcopy(root)
    owned_paths: list[dict[str, Any]] = []
    for name, path, applied in owned_specs:
        present, value = lookup(root, path)
        owned_paths.append(
            {
                "name": name,
                "path": list(path),
                "present": present,
                "value": value if present else None,
                "appliedValue": applied,
            }
        )
        set_path(next_root, path, applied)
    postimage = encode(next_root)
    postimage_sha = sha256(postimage)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    backup = Path(f"{settings}.bak-mcp-on-demand-{stamp}-{os.getpid()}")
    receipt = {
        "version": 1,
        "settingsPath": str(settings),
        "backupPath": str(backup),
        "appliedAt": datetime.now(timezone.utc).isoformat(),
        "preimageSha256": preimage_sha,
        "postimageSha256": postimage_sha,
        "preimageMode": stat.S_IMODE(info.st_mode),
        "ownedPaths": owned_paths,
    }
    receipt_raw = encode(receipt)
    settings_temp: Path | None = None
    receipt_temp: Path | None = None
    try:
        settings_temp = prepare_temp(settings, postimage, info.st_mode)
        receipt_temp = prepare_temp(receipt_path, receipt_raw, 0o600)
        pause_before_cas()
        verify_cas(preimage_sha)
        # Backup is written only after the final CAS succeeds, so a rejected
        # concurrent write leaves neither backup nor receipt litter.
        with backup.open("xb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(backup, stat.S_IMODE(info.st_mode))
        replace_from_temp(settings_temp, settings)
        settings_temp = None
        replace_from_temp(receipt_temp, receipt_path)
        receipt_temp = None
    finally:
        if settings_temp is not None:
            settings_temp.unlink(missing_ok=True)
        if receipt_temp is not None:
            receipt_temp.unlink(missing_ok=True)

    print(
        f"[setup-mcp-on-demand] applied plugin=false + headless=true in {settings} "
        f"(backup: {backup}; receipt: {receipt_path})"
    )


def rollback_policy() -> None:
    receipt = load_receipt()
    if receipt is None:
        raise PolicyError(f"active receipt {receipt_path} does not exist")
    raw, info = read_regular(settings, "settings")
    root = parse_object(raw, "settings")
    current_sha = sha256(raw)
    preimage_sha = receipt.get("preimageSha256")
    postimage_sha = receipt.get("postimageSha256")
    backup_value = receipt.get("backupPath")
    preimage_mode = receipt.get("preimageMode")
    if not all(isinstance(value, str) and len(value) == 64 for value in (preimage_sha, postimage_sha)):
        raise PolicyError("receipt image hashes are malformed")
    if not isinstance(backup_value, str) or not isinstance(preimage_mode, int):
        raise PolicyError("receipt backup metadata is malformed")
    backup = Path(backup_value)
    backup_raw, _ = read_regular(backup, "receipt backup")
    if sha256(backup_raw) != preimage_sha:
        raise PolicyError("receipt backup hash does not match preimageSha256")

    replacement: bytes | None
    replacement_mode = info.st_mode
    if current_sha == postimage_sha:
        replacement = backup_raw
        replacement_mode = preimage_mode
    elif current_sha == preimage_sha:
        replacement = None
    else:
        next_root = copy.deepcopy(root)
        conflicts: list[str] = []
        changed = False
        receipt_paths = receipt["ownedPaths"]
        for expected, recorded in zip(owned_specs, receipt_paths, strict=True):
            name, expected_path, expected_applied = expected
            if not isinstance(recorded, dict):
                raise PolicyError("receipt owned path entry is malformed")
            path_value = recorded.get("path")
            if path_value != list(expected_path) or not strict_equal(recorded.get("appliedValue"), expected_applied):
                raise PolicyError(f"receipt owned path contract mismatch for {name}")
            pre_present = recorded.get("present")
            if not isinstance(pre_present, bool):
                raise PolicyError(f"receipt preimage presence is malformed for {name}")
            pre_value = recorded.get("value")
            cur_present, cur_value = lookup(root, expected_path)
            current_is_applied = cur_present and strict_equal(cur_value, expected_applied)
            current_is_preimage = cur_present == pre_present and (
                not cur_present or strict_equal(cur_value, pre_value)
            )
            if current_is_preimage:
                continue
            if not current_is_applied:
                conflicts.append(name)
                continue
            if pre_present:
                set_path(next_root, expected_path, pre_value)
            else:
                delete_path(next_root, expected_path)
            changed = True
        if conflicts:
            raise PolicyError(
                "rollback_conflict: owned paths have third values: " + ", ".join(conflicts)
            )
        replacement = encode(next_root) if changed else None

    if replacement is not None:
        temp: Path | None = prepare_temp(settings, replacement, replacement_mode)
        try:
            pause_before_cas()
            verify_cas(current_sha)
            replace_from_temp(temp, settings)
            temp = None
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)
    else:
        # Even a no-op rollback consumes only a receipt whose current file was
        # already proved equal to its preimage or both path-level preimages.
        verify_cas(current_sha)

    receipt_path.unlink()
    fsync_dir(receipt_path.parent)
    print(f"[setup-mcp-on-demand] rollback complete for {settings} (active receipt consumed)")


def check_policy() -> None:
    raw, _ = read_regular(settings, "settings")
    root = parse_object(raw, "settings")
    drift: list[str] = []
    for name, path, applied in owned_specs:
        present, value = lookup(root, path)
        if not present or not strict_equal(value, applied):
            drift.append(name)
    if drift:
        raise PolicyError("policy drift: " + ", ".join(drift))
    print(f"[setup-mcp-on-demand] check ok: plugin=false + headless=true in {settings}")


if not settings.parent.exists():
    fail(f"settings parent {settings.parent} does not exist")

if op == "check":
    try:
        check_policy()
    except PolicyError as error:
        fail(str(error))
    raise SystemExit(0)

lock_descriptor: int | None = None
try:
    lock_flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        lock_flags |= os.O_NOFOLLOW
    lock_descriptor = os.open(lock_path, lock_flags, 0o600)
    lock_info = os.fstat(lock_descriptor)
    if not stat.S_ISREG(lock_info.st_mode):
        raise OSError("lock is not a regular file")
    os.fchmod(lock_descriptor, 0o600)
    lock_handle = os.fdopen(lock_descriptor, "a+")
    lock_descriptor = None
except OSError as error:
    if lock_descriptor is not None:
        os.close(lock_descriptor)
    fail(f"cannot open policy lock {lock_path}: {error}")

try:
    try:
        lock_timeout = float(os.environ.get("FLY1867_POLICY_LOCK_TIMEOUT_SECONDS", "10"))
    except ValueError:
        raise PolicyError("FLY1867_POLICY_LOCK_TIMEOUT_SECONDS must be numeric")
    deadline = time.monotonic() + max(0.0, lock_timeout)
    while True:
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise PolicyError(f"timed out acquiring policy lock {lock_path}")
            time.sleep(0.05)

    if op == "apply":
        apply_policy()
    elif op == "rollback":
        rollback_policy()
    else:
        raise PolicyError(f"unknown operation {op!r}")
except PolicyError as error:
    fail(str(error))
finally:
    lock_handle.close()
PY
