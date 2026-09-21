#!/usr/bin/env bash
# FLY-2681: reuse a prior full-green run only after independently proving the tree.
set -uo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

reuse_run=""
if [[ "${CI_SCOPED_MODE:-}" == "on" && "${EVENT_NAME:-}" == "push" ]]; then
  reuse_run="$({ python3 - <<'PY'
import collections
import datetime
import json
import os
import re
import subprocess
import sys
import traceback
from pathlib import Path

HEX40 = re.compile(r"^[0-9a-f]{40}$")
REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def command(argv: list[str]) -> str:
    timeout = float(os.environ.get("CI_FULL_REUSE_TIMEOUT_SECONDS", "15"))
    timeout = min(max(timeout, 0.1), 15.0)
    completed = subprocess.run(
        argv,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=timeout,
    )
    return completed.stdout


def api(endpoint: str) -> object:
    return json.loads(command(["gh", "api", endpoint]))


def valid_manifest(raw: object):
    if not isinstance(raw, dict) or raw.get("schema") != 1:
        return None
    aggregate = raw.get("aggregate")
    scoped = raw.get("aggregate_scoped")
    always = raw.get("always")
    heavy = raw.get("heavy")
    if (
        not isinstance(aggregate, str)
        or not isinstance(scoped, str)
        or not isinstance(always, list)
        or not isinstance(heavy, list)
        or len(always) != 2
        or len(heavy) != 14
        or not all(isinstance(item, str) and item for item in always + heavy)
    ):
        return None
    all_names = always + heavy + [aggregate, scoped]
    if len(set(all_names)) != len(all_names):
        return None
    return always + heavy + [aggregate], scoped


def parse_time(value: object):
    if not isinstance(value, str):
        return None
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def main() -> str:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    repo_id = os.environ.get("GITHUB_REPOSITORY_ID", "")
    merge_sha = os.environ.get("GITHUB_SHA", "").lower()
    if not REPO.fullmatch(repo) or not repo_id.isdigit() or not HEX40.fullmatch(merge_sha):
        return ""

    try:
        manifest_raw = json.loads(Path(".github/ci-required-jobs.json").read_text())
    except (OSError, json.JSONDecodeError):
        return ""
    manifest = valid_manifest(manifest_raw)
    if manifest is None:
        return ""
    required_jobs, _ = manifest

    if command(["git", "rev-parse", "HEAD"]).strip().lower() != merge_sha:
        return ""
    tested_tree = command(["git", "rev-parse", f"{merge_sha}^{{tree}}"]).strip().lower()
    parent = command(["git", "rev-parse", f"{merge_sha}^1"]).strip().lower()
    if not HEX40.fullmatch(tested_tree) or not HEX40.fullmatch(parent):
        return ""

    artifact_name = f"ci-full-green-{tested_tree}"
    artifact_page = api(f"repos/{repo}/actions/artifacts?name={artifact_name}&per_page=10")
    if not isinstance(artifact_page, dict) or not isinstance(artifact_page.get("artifacts"), list):
        return ""
    candidates = []
    for artifact in artifact_page["artifacts"]:
        if not isinstance(artifact, dict):
            continue
        created = parse_time(artifact.get("created_at"))
        run = artifact.get("workflow_run")
        if (
            artifact.get("name") == artifact_name
            and artifact.get("expired") is False
            and created is not None
            and isinstance(run, dict)
            and isinstance(run.get("id"), int)
            and run["id"] > 0
        ):
            candidates.append((created, run["id"]))
    if len(candidates) > 5:
        return ""
    candidates.sort(reverse=True)

    for _, run_id in candidates:
        run = api(f"repos/{repo}/actions/runs/{run_id}")
        if not isinstance(run, dict):
            continue
        repository = run.get("repository")
        head_repository = run.get("head_repository")
        head_sha = str(run.get("head_sha", "")).lower()
        event = run.get("event")
        if (
            run.get("path") != ".github/workflows/ci.yml"
            or run.get("status") != "completed"
            or run.get("conclusion") != "success"
            or event not in {"pull_request", "push"}
            or not HEX40.fullmatch(head_sha)
            or not isinstance(repository, dict)
            or not isinstance(head_repository, dict)
            or str(repository.get("id")) != repo_id
            or str(head_repository.get("id")) != repo_id
            or repository.get("full_name") != repo
            or head_repository.get("full_name") != repo
        ):
            continue

        jobs_page = api(f"repos/{repo}/actions/runs/{run_id}/jobs?filter=latest&per_page=100")
        if not isinstance(jobs_page, dict) or not isinstance(jobs_page.get("jobs"), list):
            continue
        jobs = jobs_page["jobs"]
        count = jobs_page.get("total_count")
        if not isinstance(count, int) or count > 100 or count != len(jobs):
            continue
        names = []
        jobs_green = True
        for job in jobs:
            if not isinstance(job, dict) or not isinstance(job.get("name"), str):
                jobs_green = False
                break
            names.append(job["name"])
            if job.get("conclusion") != "success":
                jobs_green = False
        if not jobs_green or collections.Counter(names) != collections.Counter(required_jobs):
            continue

        if event == "push":
            evidence_tree = command(["git", "rev-parse", f"{head_sha}^{{tree}}"]).strip().lower()
            if evidence_tree != tested_tree:
                continue
        else:
            command(["git", "fetch", "--no-tags", "origin", head_sha])
            merge_tree = command(["git", "merge-tree", "--write-tree", parent, head_sha])
            first_line = merge_tree.splitlines()[0].strip().lower() if merge_tree.splitlines() else ""
            if first_line != tested_tree:
                continue
        return str(run_id)
    return ""


try:
    print(main())
except (OSError, ValueError, TypeError, json.JSONDecodeError, subprocess.SubprocessError):
    if os.environ.get("CI_FULL_REUSE_DEBUG") == "1":
        traceback.print_exc(file=sys.stderr)
    print("")
PY
  })"
fi

if [[ "$reuse_run" =~ ^[0-9]+$ ]]; then
  printf 'reuse=true\n' >>"$GITHUB_OUTPUT"
  printf 'reuse_run=%s\n' "$reuse_run" >>"$GITHUB_OUTPUT"
else
  printf 'reuse=false\n' >>"$GITHUB_OUTPUT"
  printf 'reuse_run=\n' >>"$GITHUB_OUTPUT"
fi
