#!/usr/bin/env python3
"""Verify pre-window or active Raya activation file state without mutations."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any


MAX_INPUT_BYTES = 1024 * 1024
RUNTIME_CHECKS = [
    "launchd",
    "tmux",
    "heartbeat",
    "discord_roundtrip",
    "bridge_reload",
    "full_fleet_identity_refresh",
    "raya_runtime_registration",
]
EXPECTED_ROW = {
    "projectName": "raya",
    "projectRoot": "/Users/xiaorongli/Dev/raya-lead-workspace",
    "projectRepo": "xrliAnnie/raya",
    "memoryAllowedUsers": ["annie", "raya"],
    "generalChannel": "1542079099928059987",
    "leads": [
        {
            "agentId": "raya",
            "chatChannel": "1542079099928059987",
            "botTokenEnv": "RAYA_BOT_TOKEN",
            "botUserId": "1542068543645024257",
            "canSpawnRunners": False,
            "backend": "codex-app-server",
            "codexProfile": "full-access",
            "role": "cos",
            "model": "gpt-5.6-sol",
            "effort": "xhigh",
            "modelContextWindow": 1000000,
            "summaryRole": "recipient",
            "codexResidencyPatrol": True,
            "match": {"labels": ["raya-lead"]},
        }
    ],
}


class StateReport:
    def __init__(self, phase: str) -> None:
        self.phase = phase
        self.checks: list[dict[str, str]] = []
        self.advisories: list[dict[str, str]] = []

    def add(self, check_id: str, status: str, detail: str) -> None:
        self.checks.append({"id": check_id, "status": status, "detail": detail})

    def advisory(self, advisory_id: str, detail: str) -> None:
        self.advisories.append({"id": advisory_id, "detail": detail})

    def result(self) -> tuple[dict[str, Any], int]:
        failed = any(check["status"] == "fail" for check in self.checks)
        pending = any(check["status"] == "pending" for check in self.checks)
        ready = not failed and not pending
        return (
            {
                "schemaVersion": 1,
                "phase": self.phase,
                "ready": ready,
                "productionWritesPerformed": False,
                "checks": self.checks,
                "advisories": self.advisories,
                "runtimeChecksRequired": RUNTIME_CHECKS,
            },
            1 if failed else 2 if pending else 0,
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


def load_json(path: Path) -> tuple[Any, bytes, os.stat_result]:
    raw, metadata = read_regular(path)
    try:
        value = json.loads(decode_utf8(path, raw))
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSON input: {path}") from error
    return value, raw, metadata


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
    value, _, _ = load_json(path)
    expected_keys = {
        "RAYA_MEMORY_FILE",
        "RAYA_WORKSPACE_ROOTS_JSON",
        "RAYA_VOICE_OPTIONS_JSON",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise ValueError("env target must contain exactly the three reviewed Raya keys")
    expanded = expand_home(value, home)
    if not isinstance(expanded["RAYA_MEMORY_FILE"], str):
        raise ValueError("RAYA_MEMORY_FILE target must be a string")
    if not isinstance(expanded["RAYA_WORKSPACE_ROOTS_JSON"], list):
        raise ValueError("RAYA_WORKSPACE_ROOTS_JSON target must be an array")
    voice = expanded["RAYA_VOICE_OPTIONS_JSON"]
    if not isinstance(voice, dict) or not isinstance(
        voice.get("startInstructionsFile"), str
    ):
        raise ValueError("RAYA_VOICE_OPTIONS_JSON target must pin startInstructionsFile")
    return expanded


def parse_env(text: str) -> dict[str, Any]:
    keys = (
        "RAYA_MEMORY_FILE",
        "RAYA_WORKSPACE_ROOTS_JSON",
        "RAYA_VOICE_OPTIONS_JSON",
    )
    matches: dict[str, list[str]] = {key: [] for key in keys}
    for line in text.splitlines():
        for key in keys:
            prefix = f"{key}="
            if line.startswith(prefix):
                matches[key].append(line[len(prefix) :])
    for key in keys[:2]:
        if len(matches[key]) != 1:
            raise ValueError(f"{key} must appear exactly once")
    if len(matches["RAYA_VOICE_OPTIONS_JSON"]) > 1:
        raise ValueError("RAYA_VOICE_OPTIONS_JSON must appear at most once")
    try:
        roots = json.loads(matches["RAYA_WORKSPACE_ROOTS_JSON"][0])
    except json.JSONDecodeError as error:
        raise ValueError("RAYA_WORKSPACE_ROOTS_JSON must be valid JSON") from error
    if not isinstance(roots, list) or not all(isinstance(item, str) for item in roots):
        raise ValueError("RAYA_WORKSPACE_ROOTS_JSON must be an array of strings")
    voice = None
    if matches["RAYA_VOICE_OPTIONS_JSON"]:
        try:
            voice = json.loads(matches["RAYA_VOICE_OPTIONS_JSON"][0])
        except json.JSONDecodeError as error:
            raise ValueError("RAYA_VOICE_OPTIONS_JSON must be valid JSON") from error
        if not isinstance(voice, dict):
            raise ValueError("RAYA_VOICE_OPTIONS_JSON must be a JSON object")
    return {
        "RAYA_MEMORY_FILE": matches["RAYA_MEMORY_FILE"][0],
        "RAYA_WORKSPACE_ROOTS_JSON": roots,
        "RAYA_VOICE_OPTIONS_JSON": voice,
    }


def path_absent(path: Path) -> bool:
    return not os.path.lexists(path)


def check_codex_auth_link(home: Path) -> tuple[bool, str]:
    auth_path = home / ".codex-raya/auth.json"
    truth_path = home / ".codex/auth.json"
    if path_absent(auth_path):
        return False, "missing"
    try:
        auth_metadata = auth_path.lstat()
        if not stat.S_ISLNK(auth_metadata.st_mode):
            return False, "must be an absolute symlink, not a copied credential"
        target = os.readlink(auth_path)
        if not os.path.isabs(target) or target != str(truth_path):
            return False, "must point absolutely to canonical ~/.codex/auth.json"
        _, truth_metadata = read_regular(truth_path)
    except (OSError, ValueError):
        return False, "canonical truth is missing or not a regular file"
    actual = stat.S_IMODE(truth_metadata.st_mode)
    if actual != 0o600:
        return False, f"canonical truth mode={actual:04o}, expected 0600"
    return True, "absolute symlink to canonical truth mode=0600"


def git_clean(path: Path) -> bool:
    environment = dict(os.environ)
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    result = subprocess.run(
        ["git", "-C", str(path), "status", "--porcelain", "--untracked-files=normal"],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        timeout=10,
    )
    return result.returncode == 0 and result.stdout == ""


def validate_plist(raw: bytes) -> bool:
    try:
        payload = plistlib.loads(raw)
    except Exception:
        return False
    expected_log = "/Users/xiaorongli/.flywheel/logs/lead-raya-raya.log"
    return (
        payload.get("Label") == "com.flywheel.lead.raya-raya"
        and payload.get("ProgramArguments")
        == [
            "/bin/bash",
            "/Users/xiaorongli/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh",
        ]
        and payload.get("StandardOutPath") == expected_log
        and payload.get("StandardErrorPath") == expected_log
    )


def registry_matches(projects: Any) -> tuple[int, int, list[dict[str, Any]]]:
    if not isinstance(projects, list):
        raise ValueError("projects registry must be a JSON array")
    raya_projects: list[dict[str, Any]] = []
    raya_lead_count = 0
    for project in projects:
        if not isinstance(project, dict):
            raise ValueError("each projects registry entry must be an object")
        if project.get("projectName") == "raya":
            raya_projects.append(project)
        leads = project.get("leads", [])
        if not isinstance(leads, list):
            raise ValueError("project leads must be an array")
        for lead in leads:
            if not isinstance(lead, dict):
                raise ValueError("each Lead registry entry must be an object")
            if lead.get("agentId") == "raya":
                raya_lead_count += 1
    return len(raya_projects), raya_lead_count, raya_projects


def verify_pre(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    report = StateReport("pre")
    home = Path(args.home)
    if not home.is_absolute():
        raise ValueError("--home must be an absolute path")

    projects, _, _ = load_json(Path(args.projects))
    raya_projects, raya_leads, _ = registry_matches(projects)
    report.add(
        "registry",
        "pass" if (raya_projects, raya_leads) == (0, 0) else "fail",
        f"rayaProjects={raya_projects},rayaLeads={raya_leads}",
    )

    target = load_target(Path(args.env_target), home)
    target_memory = Path(target["RAYA_MEMORY_FILE"])
    workspace = target_memory.parent.parent
    old_memory = home / ".flywheel/raya/memory"
    if old_memory.is_dir() and not old_memory.is_symlink() and git_clean(old_memory):
        report.add("source_memory", "pass", "canonical source memory is a clean git checkout")
    elif path_absent(old_memory):
        report.add("source_memory", "pending", "canonical source memory is missing")
    else:
        report.add("source_memory", "fail", "source memory is not a clean regular checkout")

    destination_memory = workspace / "memory"
    destination_state = workspace / "state"
    if path_absent(workspace):
        report.add("destination_workspace", "pass", "destination workspace is absent")
    elif path_absent(destination_memory) and path_absent(destination_state):
        report.add("destination_workspace", "pass", "empty destination parent is staged")
    else:
        report.add("destination_workspace", "fail", "destination contains partial activation state")

    codex_home = home / ".codex-raya"
    if path_absent(codex_home):
        report.add("codex_home", "pending", "founder Codex home is missing")
    elif codex_home.is_dir() and not codex_home.is_symlink() and stat.S_IMODE(codex_home.stat().st_mode) == 0o700:
        report.add("codex_home", "pass", "isolated Codex home mode=0700")
    else:
        report.add("codex_home", "fail", "isolated Codex home must be a 0700 directory")

    auth_ok, auth_detail = check_codex_auth_link(home)
    report.add(
        "codex_auth",
        "pass" if auth_ok else "pending" if auth_detail == "missing" else "fail",
        auth_detail,
    )
    codex_binary = codex_home / "packages/standalone/current/codex"
    if path_absent(codex_binary):
        report.add("codex_binary", "pending", "standalone Codex binary is missing")
    else:
        try:
            _, binary_metadata = read_regular(codex_binary)
            executable = bool(binary_metadata.st_mode & 0o111)
        except (OSError, ValueError):
            executable = False
        report.add(
            "codex_binary",
            "pass" if executable else "fail",
            "standalone Codex binary is executable" if executable else "standalone Codex binary is invalid",
        )

    wrapper_source, _ = read_regular(Path(args.wrapper_source))
    try:
        wrapper_installed, installed_metadata = read_regular(Path(args.wrapper_installed))
        wrapper_ok = wrapper_source == wrapper_installed and bool(installed_metadata.st_mode & 0o111)
        report.add(
            "wrapper",
            "pass" if wrapper_ok else "fail",
            "installed wrapper matches deployed source and is executable" if wrapper_ok else "installed wrapper drifted",
        )
    except FileNotFoundError:
        report.add("wrapper", "pending", "installed wrapper is missing")
    except (OSError, ValueError):
        report.add("wrapper", "fail", "installed wrapper is not a valid regular file")

    row, _, _ = load_json(Path(args.project_row))
    report.add(
        "row",
        "pass" if row == EXPECTED_ROW else "fail",
        "FLY-2259 Raya row is exact" if row == EXPECTED_ROW else "FLY-2259 Raya row drifted",
    )

    plist_raw, _ = read_regular(Path(args.plist_template))
    plist_ok = validate_plist(plist_raw)
    report.add(
        "plist_template",
        "pass" if plist_ok else "fail",
        "deployed plist template is exact" if plist_ok else "deployed plist template drifted",
    )

    voice_asset = Path(target["RAYA_VOICE_OPTIONS_JSON"]["startInstructionsFile"])
    try:
        read_regular(voice_asset)
        report.add("voice_asset", "pass", "voice start-instructions asset is readable")
    except FileNotFoundError:
        report.add("voice_asset", "pending", "voice start-instructions asset is missing")
    except (OSError, ValueError):
        report.add("voice_asset", "fail", "voice start-instructions asset is not a valid regular file")

    global_raw, _ = read_regular(Path(args.global_env))
    token_count = sum(
        line.startswith("RAYA_BOT_TOKEN=")
        for line in decode_utf8(Path(args.global_env), global_raw).splitlines()
    )
    report.add(
        "token_selector",
        "pass" if token_count == 1 else "pending" if token_count == 0 else "fail",
        f"RAYA_BOT_TOKEN key count={token_count}",
    )

    raya_env_raw, _ = read_regular(Path(args.raya_env))
    env = parse_env(decode_utf8(Path(args.raya_env), raya_env_raw))
    old_memory_file = str(old_memory / "MEMORY.md")
    old_roots = [str(home / ".flywheel/raya/code"), str(old_memory)]
    env_ok = (
        env["RAYA_MEMORY_FILE"] == old_memory_file
        and env["RAYA_WORKSPACE_ROOTS_JSON"] == old_roots
        and env["RAYA_VOICE_OPTIONS_JSON"] is None
    )
    report.add(
        "env",
        "pass" if env_ok else "fail",
        "three env keys are in the exact pre-window state" if env_ok else "Raya env is partial or drifted",
    )

    identity_source_raw, _ = read_regular(Path(args.identity_source))
    identity_text = decode_utf8(Path(args.identity_source), identity_source_raw).lower()
    identity_ok = all(word in identity_text for word in ("summary", "merge", "round", "report"))
    report.add(
        "identity_source",
        "pass" if identity_ok else "fail",
        "deployed code identity carries summary merge/round/report contract" if identity_ok else "deployed code identity contract is incomplete",
    )

    try:
        projection_raw, projection_metadata = read_regular(Path(args.identity_projection))
        projection_mode = stat.S_IMODE(projection_metadata.st_mode)
        report.add(
            "identity_projection",
            "pass",
            f"product projection is audit-only, authoritativeForLead=false, mode={projection_mode:04o}",
        )
        if projection_mode != 0o444:
            report.advisory(
                "identity_projection_mode",
                f"product projection mode is {projection_mode:04o}, expected 0444; mutationPlanned=false",
            )
        if sha256(projection_raw) != sha256(identity_source_raw):
            report.advisory(
                "identity_projection_drift",
                "product projection differs from deployed Lead identity; mutationPlanned=false",
            )
    except FileNotFoundError:
        report.add("identity_projection", "pending", "product projection is missing")

    report.add(
        "installed_plist",
        "pass" if path_absent(Path(args.installed_plist)) else "fail",
        "formal Raya Lead plist is absent" if path_absent(Path(args.installed_plist)) else "formal Raya Lead plist already exists",
    )
    report.add(
        "manifest",
        "pass" if path_absent(Path(args.manifest)) else "fail",
        "Raya Lead manifest is absent" if path_absent(Path(args.manifest)) else "Raya Lead manifest already exists",
    )
    return report.result()


def verify_active(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    report = StateReport("active")
    home = Path(args.home)
    if not home.is_absolute():
        raise ValueError("--home must be an absolute path")

    projects, _, _ = load_json(Path(args.projects))
    raya_projects, raya_leads, matching_projects = registry_matches(projects)
    registry_ok = (
        raya_projects == 1
        and raya_leads == 1
        and matching_projects[0] == EXPECTED_ROW
    )
    report.add(
        "registry",
        "pass" if registry_ok else "fail",
        f"rayaProjects={raya_projects},rayaLeads={raya_leads},exactRow={str(registry_ok).lower()}",
    )

    target = load_target(Path(args.env_target), home)
    target_memory = Path(target["RAYA_MEMORY_FILE"])
    workspace = target_memory.parent.parent
    old_memory = home / ".flywheel/raya/memory"
    report.add(
        "source_memory",
        "pass" if path_absent(old_memory) else "fail",
        "old memory path is absent" if path_absent(old_memory) else "old memory path still exists",
    )
    destination_ok = (
        target_memory.parent.is_dir()
        and not target_memory.parent.is_symlink()
        and target_memory.is_file()
        and (workspace / "state").is_dir()
        and not (workspace / "state").is_symlink()
        and git_clean(target_memory.parent)
    )
    report.add(
        "destination_workspace",
        "pass" if destination_ok else "fail",
        "destination memory is a clean checkout and state exists" if destination_ok else "destination workspace is incomplete or dirty",
    )

    codex_home = home / ".codex-raya"
    codex_home_ok = (
        codex_home.is_dir()
        and not codex_home.is_symlink()
        and stat.S_IMODE(codex_home.stat().st_mode) == 0o700
    )
    report.add(
        "codex_home",
        "pass" if codex_home_ok else "fail",
        "isolated Codex home mode=0700" if codex_home_ok else "isolated Codex home must be a 0700 directory",
    )
    auth_ok, auth_detail = check_codex_auth_link(home)
    report.add(
        "codex_auth",
        "pass" if auth_ok else "fail",
        auth_detail,
    )
    codex_binary = codex_home / "packages/standalone/current/codex"
    try:
        _, binary_metadata = read_regular(codex_binary)
        binary_ok = bool(binary_metadata.st_mode & 0o111)
    except (OSError, ValueError):
        binary_ok = False
    report.add(
        "codex_binary",
        "pass" if binary_ok else "fail",
        "standalone Codex binary is executable" if binary_ok else "standalone Codex binary is invalid",
    )

    wrapper_source, _ = read_regular(Path(args.wrapper_source))
    try:
        wrapper_installed, installed_metadata = read_regular(Path(args.wrapper_installed))
        wrapper_ok = wrapper_source == wrapper_installed and bool(installed_metadata.st_mode & 0o111)
    except (OSError, ValueError):
        wrapper_ok = False
    report.add(
        "wrapper",
        "pass" if wrapper_ok else "fail",
        "installed wrapper matches deployed source and is executable" if wrapper_ok else "installed wrapper drifted",
    )

    row, _, _ = load_json(Path(args.project_row))
    row_ok = row == EXPECTED_ROW
    report.add(
        "row",
        "pass" if row_ok else "fail",
        "FLY-2259 Raya row is exact" if row_ok else "FLY-2259 Raya row drifted",
    )

    plist_raw, _ = read_regular(Path(args.plist_template))
    plist_template_ok = validate_plist(plist_raw)
    report.add(
        "plist_template",
        "pass" if plist_template_ok else "fail",
        "deployed plist template is exact" if plist_template_ok else "deployed plist template drifted",
    )
    try:
        installed_plist_raw, _ = read_regular(Path(args.installed_plist))
        installed_plist_ok = installed_plist_raw == plist_raw
    except (OSError, ValueError):
        installed_plist_ok = False
    tui_residue = Path(args.installed_plist).with_name(
        "com.flywheel.lead.raya-raya.tui.plist"
    )
    plist_active_ok = installed_plist_ok and path_absent(tui_residue)
    report.add(
        "installed_plist",
        "pass" if plist_active_ok else "fail",
        "formal plist matches deployed template and .tui residue is absent" if plist_active_ok else "formal plist drifted or .tui residue exists",
    )

    voice_asset = Path(target["RAYA_VOICE_OPTIONS_JSON"]["startInstructionsFile"])
    try:
        read_regular(voice_asset)
        voice_ok = True
    except (OSError, ValueError):
        voice_ok = False
    report.add(
        "voice_asset",
        "pass" if voice_ok else "fail",
        "voice start-instructions asset is readable" if voice_ok else "voice start-instructions asset is missing or invalid",
    )

    global_raw, _ = read_regular(Path(args.global_env))
    token_count = sum(
        line.startswith("RAYA_BOT_TOKEN=")
        for line in decode_utf8(Path(args.global_env), global_raw).splitlines()
    )
    report.add(
        "token_selector",
        "pass" if token_count == 1 else "fail",
        f"RAYA_BOT_TOKEN key count={token_count}",
    )

    raya_env_raw, _ = read_regular(Path(args.raya_env))
    env = parse_env(decode_utf8(Path(args.raya_env), raya_env_raw))
    voice = env["RAYA_VOICE_OPTIONS_JSON"]
    env_ok = (
        env["RAYA_MEMORY_FILE"] == target["RAYA_MEMORY_FILE"]
        and env["RAYA_WORKSPACE_ROOTS_JSON"] == target["RAYA_WORKSPACE_ROOTS_JSON"]
        and isinstance(voice, dict)
        and voice.get("startInstructionsFile")
        == target["RAYA_VOICE_OPTIONS_JSON"]["startInstructionsFile"]
    )
    report.add(
        "env",
        "pass" if env_ok else "fail",
        "three env targets are active" if env_ok else "Raya env target drifted",
    )

    identity_source_raw, _ = read_regular(Path(args.identity_source))
    identity_text = decode_utf8(Path(args.identity_source), identity_source_raw).lower()
    identity_ok = all(word in identity_text for word in ("summary", "merge", "round", "report"))
    report.add(
        "identity_source",
        "pass" if identity_ok else "fail",
        "deployed code identity carries summary merge/round/report contract" if identity_ok else "deployed code identity contract is incomplete",
    )
    try:
        projection_raw, projection_metadata = read_regular(Path(args.identity_projection))
        projection_mode = stat.S_IMODE(projection_metadata.st_mode)
        report.add(
            "identity_projection",
            "pass",
            f"product projection is audit-only, authoritativeForLead=false, mode={projection_mode:04o}",
        )
        if projection_mode != 0o444:
            report.advisory(
                "identity_projection_mode",
                f"product projection mode is {projection_mode:04o}, expected 0444; mutationPlanned=false",
            )
        if sha256(projection_raw) != sha256(identity_source_raw):
            report.advisory(
                "identity_projection_drift",
                "product projection differs from deployed Lead identity; mutationPlanned=false",
            )
    except FileNotFoundError:
        report.add("identity_projection", "pass", "product projection absent; audit-only")
        report.advisory(
            "identity_projection_missing",
            "product projection is absent; authoritativeForLead=false, mutationPlanned=false",
        )

    try:
        manifest, _, _ = load_json(Path(args.manifest))
        manifest_ok = isinstance(manifest, dict) and all(
            (
                manifest.get("projectName") == "raya",
                manifest.get("leadId") == "raya",
                manifest.get("projectDir") == str(workspace),
                manifest.get("workspace") == str(workspace),
                manifest.get("projectsFile") == str(Path(args.projects)),
                manifest.get("leadBackend") == {"backendId": "codex-app-server"},
            )
        )
    except (OSError, ValueError):
        manifest_ok = False
    report.add(
        "manifest",
        "pass" if manifest_ok else "fail",
        "Raya manifest carries the five canonical coordinates" if manifest_ok else "Raya manifest drifted",
    )
    return report.result()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("pre", "active"))
    parser.add_argument("--home", required=True)
    parser.add_argument("--projects", required=True)
    parser.add_argument("--raya-env", required=True)
    parser.add_argument("--global-env", required=True)
    parser.add_argument("--project-row", required=True)
    parser.add_argument("--env-target", required=True)
    parser.add_argument("--identity-source", required=True)
    parser.add_argument("--identity-projection", required=True)
    parser.add_argument("--wrapper-source", required=True)
    parser.add_argument("--wrapper-installed", required=True)
    parser.add_argument("--plist-template", required=True)
    parser.add_argument("--installed-plist", required=True)
    parser.add_argument("--manifest", required=True)
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        report, return_code = (
            verify_pre(args) if args.phase == "pre" else verify_active(args)
        )
        json.dump(report, sys.stdout, ensure_ascii=False, sort_keys=True)
        sys.stdout.write("\n")
        return return_code
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"verify-activation-state: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
