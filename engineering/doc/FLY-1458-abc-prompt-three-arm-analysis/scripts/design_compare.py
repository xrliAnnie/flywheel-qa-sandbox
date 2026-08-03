#!/usr/bin/env python3
"""Four-arm design-session comparison for FLY-1458 / FLY-1609."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sqlite3
import subprocess
import sys
import tempfile
from collections import Counter
from contextlib import closing
from pathlib import Path
from typing import Any
from urllib.parse import quote


ARMS = ("superpowers", "matt", "bare", "bare-ponytail")
MECHANICALLY_INERT_VIAS = frozenset(("noop_backend", "fallback_superpowers"))
DEFAULT_DB = Path("~/.flywheel/teamlead.db").expanduser()


def parse_time(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    normalized = value.strip().replace("Z", "+00:00")
    try:
        return dt.datetime.fromisoformat(normalized)
    except ValueError:
        return None


def normalize_since(value: str) -> str:
    parsed = parse_time(value)
    if parsed is None:
        raise ValueError(f"invalid --since timestamp: {value!r}")
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return parsed.isoformat(sep=" ", timespec="microseconds")


def format_duration(seconds: float | None) -> str:
    if seconds is None:
        return "n/a"
    rounded = int(round(seconds))
    hours, remainder = divmod(rounded, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours}h{minutes:02d}m" if hours else f"{minutes}m{secs:02d}s"


def connect_readonly(db_path: Path) -> sqlite3.Connection:
    resolved = db_path.expanduser().resolve()
    uri = f"file:{quote(str(resolved))}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def load_stages(
    connection: sqlite3.Connection, execution_id: str
) -> list[tuple[dt.datetime, str]]:
    rows = connection.execute(
        """SELECT ts, payload FROM session_events
           WHERE execution_id=? AND event_type='stage_changed' ORDER BY ts""",
        (execution_id,),
    ).fetchall()
    stages: list[tuple[dt.datetime, str]] = []
    for timestamp, payload in rows:
        parsed = parse_time(timestamp)
        try:
            stage = json.loads(payload or "{}").get("stage")
        except json.JSONDecodeError:
            stage = None
        if parsed and isinstance(stage, str):
            stages.append((parsed, stage))
    return stages


def is_eligible(mode: str, condition: str | None) -> bool:
    if mode == "bare-ponytail":
        return bool(condition and condition.startswith("on:"))
    return bool(condition and condition.startswith("off:"))


def analyze(
    connection: sqlite3.Connection,
    *,
    since: str | None,
    issues: list[str] | None,
) -> dict[str, dict[str, Any]]:
    clauses = ["session_role='design'", "skill_framework_mode IS NOT NULL"]
    params: list[str] = []
    if since:
        # StateStore writes `YYYY-MM-DD HH:MM:SS`, while operators commonly
        # paste ISO timestamps containing `T`/`Z`. Comparing those as raw text
        # drops the boundary day because a space sorts before `T`. Parse and
        # compare through SQLite's time representation instead.
        clauses.append("julianday(started_at) >= julianday(?)")
        params.append(normalize_since(since))
    if issues:
        placeholders = ",".join("?" for _ in issues)
        clauses.append(f"issue_identifier IN ({placeholders})")
        params.extend(issues)
    placeholders = ",".join("?" for _ in ARMS)
    clauses.append(f"skill_framework_mode IN ({placeholders})")
    params.extend(ARMS)
    rows = connection.execute(
        f"""SELECT issue_identifier, execution_id, skill_framework_mode,
                   skill_framework_mode_via, status, started_at,
                   ponytail_condition
            FROM sessions WHERE {' AND '.join(clauses)}
            ORDER BY skill_framework_mode, issue_identifier, started_at""",
        params,
    ).fetchall()

    result: dict[str, dict[str, Any]] = {
        arm: {"eligible": [], "excluded": [], "conditions": Counter()}
        for arm in ARMS
    }
    for issue, execution, mode, via, status, started_at, condition in rows:
        stages = load_stages(connection, execution)
        start = stages[0][0] if stages else parse_time(started_at)
        first_review = next(
            (timestamp for timestamp, stage in stages if stage == "design_review"),
            None,
        )
        first_pass = (
            (first_review - start).total_seconds()
            if start is not None and first_review is not None
            else None
        )
        sample = {
            "issue": issue,
            "execution": execution,
            "via": via,
            "status": status,
            "condition": condition,
            "first_pass": first_pass,
            "review_visits": sum(1 for _, stage in stages if stage == "design_review"),
        }
        result[mode]["conditions"][condition or "(null)"] += 1
        mechanically_inert = via in MECHANICALLY_INERT_VIAS
        if mechanically_inert:
            sample["exclusion_reason"] = f"via:{via}"
        elif not is_eligible(mode, condition):
            sample["exclusion_reason"] = "condition"
        bucket = (
            "eligible"
            if not mechanically_inert and is_eligible(mode, condition)
            else "excluded"
        )
        result[mode][bucket].append(sample)
    return result


def render_report(
    result: dict[str, dict[str, Any]], *, since: str | None, issues: list[str] | None
) -> None:
    epoch = since or "ALL HISTORY (explicit --allow-pre-rollout smoke)"
    cohort = ",".join(issues) if issues else "all design sessions"
    print("FLY-1458 FOUR-ARM DESIGN COMPARISON")
    print(f"epoch: {epoch}")
    print(f"cohort: {cohort}")
    print(
        "eligibility: A/B/C=off:%; D=on:%; "
        "noop_backend/fallback_superpowers excluded"
    )
    print("=" * 96)
    for arm in ARMS:
        data = result[arm]
        eligible = data["eligible"]
        excluded = data["excluded"]
        distribution = ", ".join(
            f"{condition}={count}"
            for condition, count in sorted(data["conditions"].items())
        ) or "(empty)"
        durations = [row["first_pass"] for row in eligible if row["first_pass"] is not None]
        mean = sum(durations) / len(durations) if durations else None
        review_visits = [row["review_visits"] for row in eligible]
        review_mean = (
            sum(review_visits) / len(review_visits) if review_visits else None
        )
        review_display = f"{review_mean:.2f}" if review_mean is not None else "n/a"
        print(
            f"ARM {arm:<14} eligible={len(eligible):<3} excluded={len(excluded):<3} "
            f"first-pass mean={format_duration(mean):<8} n={len(durations):<3} "
            f"design-review visits mean={review_display} n={len(review_visits)}"
        )
        print(f"  ponytail_condition: {distribution}")
        for row in eligible:
            print(
                f"  + {row['issue']:<10} {row['execution'][:8]} via={row['via'] or '-':<10} "
                f"condition={row['condition']:<24} first-pass={format_duration(row['first_pass'])} "
                f"reviews={row['review_visits']}"
            )
        for row in excluded:
            print(
                f"  - EXCLUDED {row['issue']:<10} {row['execution'][:8]} "
                f"via={row['via'] or '-':<20} condition={row['condition'] or '(null)'} "
                f"reason={row['exclusion_reason']}"
            )
        print("-" * 96)


def create_fixture(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE sessions (
          issue_identifier TEXT, execution_id TEXT PRIMARY KEY,
          session_role TEXT, skill_framework_mode TEXT,
          skill_framework_mode_via TEXT, status TEXT, started_at TEXT,
          ponytail_condition TEXT
        );
        CREATE TABLE session_events (
          execution_id TEXT, event_type TEXT, ts TEXT, payload TEXT
        );
        """
    )
    sessions = [
        # Production StateStore timestamps use a space separator. Keep this row
        # in that exact shape so an ISO `--since` value cannot make the epoch
        # gate vacuously drop the rollout day.
        ("A-1", "a-off", "superpowers", "hash", "off:default", "2026-08-03 01:00:00"),
        ("A-2", "a-noop", "superpowers", "noop_backend", "off:default", "2026-08-03 01:00:00"),
        ("B-1", "b-off", "matt", "hash", "off:default", "2026-08-03T01:00:00"),
        ("B-2", "b-fallback", "superpowers", "fallback_superpowers", "off:default", "2026-08-03T01:00:00"),
        ("C-1", "c-off", "bare", "hash", "off:default", "2026-08-03T01:00:00"),
        ("C-2", "c-on", "bare", "hash", "on:label", "2026-08-03T01:00:00"),
        ("D-1", "d-on", "bare-ponytail", "hash", "on:arm", "2026-08-03T01:00:00"),
        ("D-2", "d-off", "bare-ponytail", "hash", "off:run", "2026-08-03T01:00:00"),
        (
            "D-3",
            "d-unavailable",
            "bare-ponytail",
            "hash",
            "unavailable:readiness:on:arm",
            "2026-08-03T01:00:00",
        ),
        ("D-OLD", "d-old", "bare-ponytail", "hash", "on:arm", "2026-08-02T23:00:00"),
    ]
    for issue, execution, mode, via, condition, started in sessions:
        connection.execute(
            "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)",
            (issue, execution, "design", mode, via, "completed", started, condition),
        )
        connection.execute(
            "INSERT INTO session_events VALUES (?,?,?,?)",
            (execution, "stage_changed", started, '{"stage":"onboard"}'),
        )
        review_at = (parse_time(started) + dt.timedelta(minutes=10)).isoformat()
        connection.execute(
            "INSERT INTO session_events VALUES (?,?,?,?)",
            (execution, "stage_changed", review_at, '{"stage":"design_review"}'),
        )
    connection.commit()
    connection.close()


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="fly1609-design-compare-") as directory:
        db_path = Path(directory) / "fixture.db"
        create_fixture(db_path)
        with closing(connect_readonly(db_path)) as connection:
            result = analyze(
                connection, since="2026-08-03T00:00:00.000Z", issues=None
            )
        assert tuple(result) == ARMS
        assert len(result["superpowers"]["eligible"]) == 1
        assert len(result["superpowers"]["excluded"]) == 2
        assert {
            row["exclusion_reason"]
            for row in result["superpowers"]["excluded"]
        } == {"via:noop_backend", "via:fallback_superpowers"}
        assert len(result["matt"]["eligible"]) == 1
        assert len(result["matt"]["excluded"]) == 0
        assert len(result["bare"]["eligible"]) == 1
        assert len(result["bare"]["excluded"]) == 1
        assert len(result["bare-ponytail"]["eligible"]) == 1
        assert len(result["bare-ponytail"]["excluded"]) == 2
        assert result["bare-ponytail"]["eligible"][0]["condition"] == "on:arm"

        missing_epoch = subprocess.run(
            [sys.executable, __file__, "--db", str(db_path)],
            capture_output=True,
            text=True,
            check=False,
        )
        assert missing_epoch.returncode != 0
        assert "--since is required" in missing_epoch.stderr
        all_history = subprocess.run(
            [
                sys.executable,
                __file__,
                "--db",
                str(db_path),
                "--allow-pre-rollout",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert all_history.returncode == 0, all_history.stderr
        assert "ARM bare-ponytail" in all_history.stdout
        assert "first-pass mean=" in all_history.stdout
        assert "design-review visits mean=" in all_history.stdout
        assert "via:noop_backend" in all_history.stdout

        invalid_epoch = subprocess.run(
            [
                sys.executable,
                __file__,
                "--db",
                str(db_path),
                "--since",
                "not-a-timestamp",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert invalid_epoch.returncode != 0
        assert "invalid --since timestamp" in invalid_epoch.stderr
    print("SELF-TEST PASS: four arms, eligibility, epoch gate, and smoke escape")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--since", help="four-arm rollout epoch (ISO timestamp; required)")
    parser.add_argument("--issues", nargs="+", help="optional issue identifiers")
    parser.add_argument(
        "--allow-pre-rollout",
        action="store_true",
        help="explicitly allow all-history smoke output (not a valid comparison)",
    )
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.since and not args.allow_pre_rollout:
        parser.error("--since is required for comparison; use --allow-pre-rollout only for smoke")
    try:
        with closing(connect_readonly(args.db)) as connection:
            result = analyze(connection, since=args.since, issues=args.issues)
    except ValueError as error:
        parser.error(str(error))
    render_report(result, since=args.since, issues=args.issues)


if __name__ == "__main__":
    main()
