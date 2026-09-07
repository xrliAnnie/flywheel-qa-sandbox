#!/usr/bin/env python3
"""Render a scoped, read-only Raya activation proposal."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import plistlib
import stat
import sys
from pathlib import Path
from typing import Any


MAX_INPUT_BYTES = 1024 * 1024
TARGET_KEYS = (
    "RAYA_MEMORY_FILE",
    "RAYA_WORKSPACE_ROOTS_JSON",
    "RAYA_VOICE_OPTIONS_JSON",
)
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


def read_regular(path: Path) -> tuple[bytes, Any]:
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


def load_json(path: Path) -> tuple[Any, bytes, Any]:
    raw, metadata = read_regular(path)
    try:
        value = json.loads(decode_utf8(path, raw))
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSON input: {path}") from error
    return value, raw, metadata


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


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


def parse_env_targets(text: str) -> dict[str, Any]:
    matches: dict[str, list[str]] = {key: [] for key in TARGET_KEYS}
    for line in text.splitlines():
        for key in TARGET_KEYS:
            prefix = f"{key}="
            if line.startswith(prefix):
                matches[key].append(line[len(prefix) :])

    for key in TARGET_KEYS[:2]:
        if len(matches[key]) != 1:
            raise ValueError(f"{key} must appear exactly once")
    if len(matches["RAYA_VOICE_OPTIONS_JSON"]) > 1:
        raise ValueError("RAYA_VOICE_OPTIONS_JSON must appear at most once")

    memory = matches["RAYA_MEMORY_FILE"][0]
    try:
        roots = json.loads(matches["RAYA_WORKSPACE_ROOTS_JSON"][0])
    except json.JSONDecodeError as error:
        raise ValueError("RAYA_WORKSPACE_ROOTS_JSON must be valid JSON") from error
    if not isinstance(roots, list) or not all(
        isinstance(item, str) and item for item in roots
    ):
        raise ValueError("RAYA_WORKSPACE_ROOTS_JSON must be an array of strings")

    voice: dict[str, Any] | None = None
    if matches["RAYA_VOICE_OPTIONS_JSON"]:
        try:
            parsed_voice = json.loads(matches["RAYA_VOICE_OPTIONS_JSON"][0])
        except json.JSONDecodeError as error:
            raise ValueError("RAYA_VOICE_OPTIONS_JSON must be valid JSON") from error
        if not isinstance(parsed_voice, dict):
            raise ValueError("RAYA_VOICE_OPTIONS_JSON must be a JSON object")
        voice = parsed_voice

    return {
        "RAYA_MEMORY_FILE": memory,
        "RAYA_WORKSPACE_ROOTS_JSON": roots,
        "RAYA_VOICE_OPTIONS_JSON": voice,
    }


def validate_target(target: Any, home: Path) -> dict[str, Any]:
    if not isinstance(target, dict) or set(target) != set(TARGET_KEYS):
        raise ValueError("env target must contain exactly the three reviewed Raya keys")
    expanded = expand_home(target, home)
    if not isinstance(expanded["RAYA_MEMORY_FILE"], str):
        raise ValueError("RAYA_MEMORY_FILE target must be a string")
    roots = expanded["RAYA_WORKSPACE_ROOTS_JSON"]
    if not isinstance(roots, list) or not all(
        isinstance(item, str) and item for item in roots
    ):
        raise ValueError("RAYA_WORKSPACE_ROOTS_JSON target must be an array of strings")
    voice = expanded["RAYA_VOICE_OPTIONS_JSON"]
    if (
        not isinstance(voice, dict)
        or set(voice) != {"startInstructionsFile"}
        or not isinstance(voice["startInstructionsFile"], str)
    ):
        raise ValueError("RAYA_VOICE_OPTIONS_JSON target must pin startInstructionsFile")
    return expanded


def validate_projects(projects: Any) -> tuple[int, int]:
    if not isinstance(projects, list):
        raise ValueError("projects registry must be a JSON array")
    lead_count = 0
    raya_projects = 0
    raya_leads = 0
    for project in projects:
        if not isinstance(project, dict):
            raise ValueError("each projects registry entry must be an object")
        if project.get("projectName") == "raya":
            raya_projects += 1
        leads = project.get("leads", [])
        if not isinstance(leads, list):
            raise ValueError("project leads must be an array")
        lead_count += len(leads)
        for lead in leads:
            if not isinstance(lead, dict):
                raise ValueError("each Lead registry entry must be an object")
            if lead.get("agentId") == "raya":
                raya_leads += 1
    if raya_projects or raya_leads:
        raise ValueError("Raya project/Lead already exists; refusing add patch")
    return len(projects), lead_count


def validate_plist(path: Path, raw: bytes) -> None:
    try:
        payload = plistlib.loads(raw)
    except Exception as error:
        raise ValueError(f"invalid plist input: {path}") from error
    expected_args = [
        "/bin/bash",
        "/Users/xiaorongli/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh",
    ]
    expected_log = "/Users/xiaorongli/.flywheel/logs/lead-raya-raya.log"
    if payload.get("Label") != "com.flywheel.lead.raya-raya":
        raise ValueError("Raya plist label drifted")
    if payload.get("ProgramArguments") != expected_args:
        raise ValueError("Raya plist wrapper path drifted")
    if payload.get("StandardOutPath") != expected_log:
        raise ValueError("Raya plist stdout path drifted")
    if payload.get("StandardErrorPath") != expected_log:
        raise ValueError("Raya plist stderr path drifted")


def render(args: argparse.Namespace) -> dict[str, Any]:
    home = Path(args.home)
    if not home.is_absolute():
        raise ValueError("--home must be an absolute path")

    projects, projects_raw, _ = load_json(Path(args.projects))
    project_count, lead_count = validate_projects(projects)
    row, row_raw, _ = load_json(Path(args.project_row))
    if row != EXPECTED_ROW:
        raise ValueError("Raya project row does not match the reviewed FLY-2259 row")

    target_value, target_raw, _ = load_json(Path(args.env_target))
    target = validate_target(target_value, home)
    env_raw, _ = read_regular(Path(args.raya_env))
    env_before = parse_env_targets(decode_utf8(Path(args.raya_env), env_raw))
    voice_after = dict(env_before["RAYA_VOICE_OPTIONS_JSON"] or {})
    voice_after["startInstructionsFile"] = target["RAYA_VOICE_OPTIONS_JSON"][
        "startInstructionsFile"
    ]

    source_raw, _ = read_regular(Path(args.identity_source))
    projection_raw, projection_metadata = read_regular(Path(args.identity_projection))
    source_text = decode_utf8(Path(args.identity_source), source_raw)
    projection_text = decode_utf8(Path(args.identity_projection), projection_raw)
    identity_diff = "".join(
        difflib.unified_diff(
            projection_text.splitlines(keepends=True),
            source_text.splitlines(keepends=True),
            fromfile="identity-projection",
            tofile="identity-source",
        )
    )

    plist_raw, _ = read_regular(Path(args.plist_template))
    validate_plist(Path(args.plist_template), plist_raw)

    return {
        "schemaVersion": 1,
        "productionWritesPerformed": False,
        "projectsPatch": [
            {"op": "add", "path": f"/{project_count}", "value": row}
        ],
        "fleetIdentityImpact": {
            "currentLeadCount": lead_count,
            "targetLeadCount": lead_count + 1,
            "allExistingLeadsRequireRestart": True,
            "reason": "summaryAssignmentDigest covers the full Lead registry",
        },
        "envPatch": [
            {
                "key": "RAYA_MEMORY_FILE",
                "before": env_before["RAYA_MEMORY_FILE"],
                "after": target["RAYA_MEMORY_FILE"],
            },
            {
                "key": "RAYA_WORKSPACE_ROOTS_JSON",
                "before": env_before["RAYA_WORKSPACE_ROOTS_JSON"],
                "after": target["RAYA_WORKSPACE_ROOTS_JSON"],
            },
            {
                "key": "RAYA_VOICE_OPTIONS_JSON",
                "before": env_before["RAYA_VOICE_OPTIONS_JSON"],
                "after": voice_after,
            },
        ],
        "identityProjection": {
            "operation": "audit_only",
            "mutationPlanned": False,
            "authoritativeForLead": False,
            "sourceSha256": sha256(source_raw),
            "projectionSha256": sha256(projection_raw),
            "projectionMode": f"{stat.S_IMODE(projection_metadata.st_mode):04o}",
            "diff": identity_diff,
        },
        "launchdPlist": {
            "operation": "create",
            "targetPath": str(
                home / "Library/LaunchAgents/com.flywheel.lead.raya-raya.plist"
            ),
            "templateSha256": sha256(plist_raw),
        },
        "inputs": {
            "projectsSha256": sha256(projects_raw),
            "rayaEnvSha256": sha256(env_raw),
            "projectRowSha256": sha256(row_raw),
            "envTargetSha256": sha256(target_raw),
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", required=True)
    parser.add_argument("--projects", required=True)
    parser.add_argument("--raya-env", required=True)
    parser.add_argument("--identity-source", required=True)
    parser.add_argument("--identity-projection", required=True)
    parser.add_argument("--project-row", required=True)
    parser.add_argument("--plist-template", required=True)
    parser.add_argument("--env-target", required=True)
    return parser.parse_args()


def main() -> int:
    try:
        report = render(parse_args())
        json.dump(report, sys.stdout, ensure_ascii=False, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    except (OSError, ValueError) as error:
        print(f"render-production-diff: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
