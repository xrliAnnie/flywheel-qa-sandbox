#!/usr/bin/env python3
"""Measure Flywheel CI run counts and billed runner minutes.

Live mode uses GitHub's Actions APIs. Offline mode accepts the tab-separated
snapshots in this directory so the baseline calculation stays reproducible.
"""

from __future__ import annotations

import argparse
import collections
import dataclasses
import datetime as dt
import json
import math
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable


FULL_TITLE_PREFIX = "CI full-request "
MATRIX_PLACEHOLDER = "Unit (${{ matrix.name }})"


@dataclasses.dataclass(frozen=True)
class Run:
    run_id: int
    event: str
    status: str
    conclusion: str
    branch: str
    head_sha: str
    started_at: str
    completed_at: str
    attempt: int
    display_title: str = ""


@dataclasses.dataclass(frozen=True)
class Job:
    run_id: int
    name: str
    status: str
    conclusion: str
    started_at: str
    completed_at: str
    attempt: int


def parse_time(value: str) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


def billed_minutes(job: Job) -> int:
    if job.conclusion == "skipped":
        return 0
    started = parse_time(job.started_at)
    completed = parse_time(job.completed_at)
    if started is None or completed is None or completed <= started:
        return 0
    return math.ceil((completed - started).total_seconds() / 60)


def run_gh(arguments: list[str], timeout: float = 120.0) -> Any:
    completed = subprocess.run(
        ["gh", *arguments],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )
    return json.loads(completed.stdout)


def pages(payload: Any, collection: str) -> list[dict[str, Any]]:
    raw_pages = payload if isinstance(payload, list) else [payload]
    result: list[dict[str, Any]] = []
    for page in raw_pages:
        if not isinstance(page, dict) or not isinstance(page.get(collection), list):
            raise ValueError(f"GitHub response lacks {collection}")
        result.extend(item for item in page[collection] if isinstance(item, dict))
    return result


def fetch_live(repo: str, date_from: str, date_to: str) -> tuple[list[Run], list[Job]]:
    endpoint = (
        f"repos/{repo}/actions/workflows/ci.yml/runs"
        f"?created={date_from}..{date_to}&per_page=100"
    )
    raw_runs = pages(run_gh(["api", "--paginate", "--slurp", endpoint]), "workflow_runs")
    runs = [
        Run(
            run_id=int(raw["id"]),
            event=str(raw.get("event") or ""),
            status=str(raw.get("status") or ""),
            conclusion=str(raw.get("conclusion") or ""),
            branch=str(raw.get("head_branch") or ""),
            head_sha=str(raw.get("head_sha") or ""),
            started_at=str(raw.get("run_started_at") or raw.get("created_at") or ""),
            completed_at=str(raw.get("updated_at") or ""),
            attempt=int(raw.get("run_attempt") or 0),
            display_title=str(raw.get("display_title") or ""),
        )
        for raw in raw_runs
    ]
    jobs: list[Job] = []
    for run in runs:
        endpoint = f"repos/{repo}/actions/runs/{run.run_id}/jobs?filter=all&per_page=100"
        raw_jobs = pages(run_gh(["api", "--paginate", "--slurp", endpoint]), "jobs")
        jobs.extend(
            Job(
                run_id=run.run_id,
                name=str(raw.get("name") or ""),
                status=str(raw.get("status") or ""),
                conclusion=str(raw.get("conclusion") or ""),
                started_at=str(raw.get("started_at") or ""),
                completed_at=str(raw.get("completed_at") or ""),
                attempt=int(raw.get("run_attempt") or run.attempt),
            )
            for raw in raw_jobs
        )
    return runs, jobs


def read_tsv(runs_path: Path, jobs_path: Path) -> tuple[list[Run], list[Job]]:
    runs: list[Run] = []
    for line_number, line in enumerate(runs_path.read_text().splitlines(), 1):
        if not line:
            continue
        fields = line.split("\t")
        if len(fields) != 9:
            raise ValueError(f"{runs_path}:{line_number}: expected 9 fields")
        runs.append(
            Run(
                run_id=int(fields[0]),
                event=fields[1],
                status=fields[2],
                conclusion=fields[3],
                branch=fields[4],
                head_sha=fields[5],
                started_at=fields[6],
                completed_at=fields[7],
                attempt=int(fields[8]),
            )
        )
    jobs: list[Job] = []
    for line_number, line in enumerate(jobs_path.read_text().splitlines(), 1):
        if not line:
            continue
        fields = line.split("\t")
        if len(fields) != 7:
            raise ValueError(f"{jobs_path}:{line_number}: expected 7 fields")
        jobs.append(
            Job(
                run_id=int(fields[0]),
                name=fields[1],
                status=fields[2],
                conclusion=fields[3],
                started_at=fields[4],
                completed_at=fields[5],
                attempt=int(fields[6]),
            )
        )
    return runs, jobs


def valid_manifest(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("schema") != 1:
        raise ValueError("required-job manifest must have schema 1")
    for key in ("aggregate", "aggregate_scoped"):
        if not isinstance(raw.get(key), str) or not raw[key]:
            raise ValueError(f"required-job manifest has invalid {key}")
    for key in ("always", "heavy"):
        if not isinstance(raw.get(key), list) or not all(
            isinstance(item, str) and item for item in raw[key]
        ):
            raise ValueError(f"required-job manifest has invalid {key}")
    return raw


def classify(run: Run, jobs: list[Job], manifest: dict[str, Any]) -> tuple[str, bool]:
    names = {job.name for job in jobs}
    full_aggregate = str(manifest["aggregate"])
    scoped_aggregate = str(manifest["aggregate_scoped"])
    heavy_names = set(str(name) for name in manifest["heavy"]) | {MATRIX_PLACEHOLDER}
    heavy_jobs = [job for job in jobs if job.name in heavy_names]
    heavy_executed = any(job.conclusion != "skipped" for job in heavy_jobs)
    heavy_all_skipped = bool(heavy_jobs) and not heavy_executed

    if run.event == "push":
        if full_aggregate in names and heavy_all_skipped:
            return "reuse", False
        return "push", heavy_executed
    if scoped_aggregate in names:
        return "pr-scoped", False
    if run.display_title.startswith(FULL_TITLE_PREFIX):
        return "pr-full", True
    if full_aggregate in names and heavy_all_skipped:
        return "docs-only", False
    # Old workflow runs and interrupted full requests have no scoped aggregate.
    return "pr-full", True


def deduplicate(jobs: Iterable[Job]) -> list[Job]:
    unique: dict[tuple[int, str, str, str], Job] = {}
    for job in jobs:
        key = (job.run_id, job.name, job.started_at, job.completed_at)
        unique.setdefault(key, job)
    return list(unique.values())


def measure(
    runs: list[Run],
    jobs: list[Job],
    manifest: dict[str, Any],
    merged_prs: int | None,
    qa_sessions: int | None,
    baseline_minutes: int | None,
) -> dict[str, Any]:
    jobs_by_run: dict[int, list[Job]] = collections.defaultdict(list)
    for job in deduplicate(jobs):
        jobs_by_run[job.run_id].append(job)

    rows: list[dict[str, Any]] = []
    class_totals: dict[str, dict[str, int]] = collections.defaultdict(
        lambda: {"runs": 0, "minutes": 0}
    )
    for run in runs:
        run_jobs = jobs_by_run[run.run_id]
        kind, is_full = classify(run, run_jobs, manifest)
        minutes = sum(billed_minutes(job) for job in run_jobs)
        class_totals[kind]["runs"] += 1
        class_totals[kind]["minutes"] += minutes
        rows.append(
            {
                "id": run.run_id,
                "event": run.event,
                "head": run.head_sha,
                "kind": kind,
                "full": is_full,
                "minutes": minutes,
            }
        )

    total_minutes = sum(row["minutes"] for row in rows)
    pr_rows = [row for row in rows if row["event"] == "pull_request"]
    pr_heads = {row["head"] for row in pr_rows if row["head"]}
    full_rows = [row for row in rows if row["full"]]
    for totals in class_totals.values():
        totals["minute_share_pct"] = (
            round(100 * totals["minutes"] / total_minutes, 1) if total_minutes else 0.0
        )
    result: dict[str, Any] = {
        "runs": len(rows),
        "billed_minutes": total_minutes,
        "classes": dict(sorted(class_totals.items())),
        "distinct_pr_heads": len(pr_heads),
        "minutes_per_pr_head": (
            round(sum(row["minutes"] for row in pr_rows) / len(pr_heads), 1)
            if pr_heads
            else None
        ),
        "full_matrix_runs": len(full_rows),
        "minutes_per_full_matrix": (
            round(sum(row["minutes"] for row in full_rows) / len(full_rows), 1)
            if full_rows
            else None
        ),
        "merged_prs": merged_prs,
        "full_runs_per_merged_pr": (
            round(len(full_rows) / merged_prs, 2) if merged_prs else None
        ),
        "qa_sessions": qa_sessions,
        "minutes_per_qa_session": (
            round(total_minutes / qa_sessions, 1) if qa_sessions else None
        ),
        "baseline_minutes": baseline_minutes,
        "saving_vs_baseline_pct": (
            round(100 * (1 - total_minutes / baseline_minutes), 1)
            if baseline_minutes
            else None
        ),
    }
    return result


def merged_pr_count(repo: str, date_from: str, date_to: str) -> int:
    query = f"repo:{repo} is:pr is:merged merged:{date_from}..{date_to}"
    payload = run_gh(
        ["api", "--method", "GET", "search/issues", "-f", f"q={query}", "-f", "per_page=1"]
    )
    if not isinstance(payload, dict) or not isinstance(payload.get("total_count"), int):
        raise ValueError("GitHub search response lacks total_count")
    return int(payload["total_count"])


def resolve_repo(explicit: str | None) -> str:
    if explicit:
        return explicit
    from_env = os.environ.get("GITHUB_REPOSITORY", "")
    if from_env:
        return from_env
    value = subprocess.run(
        ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=15,
    ).stdout.strip()
    if "/" not in value:
        raise ValueError("could not resolve GitHub repository")
    return value


def date_value(value: str) -> str:
    dt.date.fromisoformat(value)
    return value


def print_report(result: dict[str, Any], date_from: str, date_to: str) -> None:
    print(f"period: {date_from}..{date_to}")
    print(f"runs: {result['runs']}")
    print(f"billed runner-minutes: {result['billed_minutes']}")
    for kind, totals in result["classes"].items():
        print(
            f"  {kind:10s} runs={totals['runs']:3d} minutes={totals['minutes']:6d} "
            f"share={totals['minute_share_pct']:5.1f}%"
        )
    print(
        f"PR heads: {result['distinct_pr_heads']} "
        f"({result['minutes_per_pr_head']} minutes/head)"
    )
    print(
        f"full matrices: {result['full_matrix_runs']} "
        f"({result['minutes_per_full_matrix']} minutes/full)"
    )
    if result["merged_prs"] is not None:
        print(
            f"merged PRs: {result['merged_prs']} "
            f"(full matrices/merged PR={result['full_runs_per_merged_pr']})"
        )
    if result["qa_sessions"] is not None:
        print(
            f"QA sessions: {result['qa_sessions']} "
            f"({result['minutes_per_qa_session']} minutes/QA session)"
        )
    if result["baseline_minutes"] is not None:
        print(f"saving vs baseline: {result['saving_vs_baseline_pct']}%")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="date_from", type=date_value, required=True)
    parser.add_argument("--to", dest="date_to", type=date_value, required=True)
    parser.add_argument("--repo")
    parser.add_argument("--runs-tsv", type=Path)
    parser.add_argument("--jobs-tsv", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--merged-prs", type=int)
    parser.add_argument("--qa-sessions", type=int)
    parser.add_argument("--baseline-minutes", type=int)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.date_from > args.date_to:
        parser.error("--from must not be later than --to")
    if bool(args.runs_tsv) != bool(args.jobs_tsv):
        parser.error("--runs-tsv and --jobs-tsv must be supplied together")
    for name in ("merged_prs", "qa_sessions", "baseline_minutes"):
        value = getattr(args, name)
        if value is not None and value <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")

    script_dir = Path(__file__).resolve().parent
    manifest_path = args.manifest or script_dir.parents[3] / ".github/ci-required-jobs.json"
    manifest = valid_manifest(json.loads(manifest_path.read_text()))
    if args.runs_tsv:
        runs, jobs = read_tsv(args.runs_tsv, args.jobs_tsv)
        merged_prs = args.merged_prs
    else:
        repo = resolve_repo(args.repo)
        runs, jobs = fetch_live(repo, args.date_from, args.date_to)
        merged_prs = args.merged_prs
        if merged_prs is None:
            merged_prs = merged_pr_count(repo, args.date_from, args.date_to)
    result = measure(
        runs,
        jobs,
        manifest,
        merged_prs,
        args.qa_sessions,
        args.baseline_minutes,
    )
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print_report(result, args.date_from, args.date_to)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"ci-cost: {error}", file=sys.stderr)
        raise SystemExit(2)
