#!/usr/bin/env python3
"""Durable per-unit shuttle observation ledger (FLY-2669)."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import stat
import sys
import tempfile
import uuid


SCHEMA_VERSION = 1
UNIT_KINDS = {"core_repo", "project_repo", "lead", "external_repo", "inventory"}
WAKE_KINDS = {"scheduled", "urgent", "unknown"}
OUTCOMES = {"deployed", "up_to_date", "skipped", "failed"}
MAX_JSON_BYTES = 256 * 1024


class ObservationError(RuntimeError):
    pass


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def parse_iso(value: str) -> dt.datetime:
    if len(value) > 40 or not value.endswith("Z"):
        raise ObservationError("invalid ISO timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ObservationError("invalid ISO timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta(0):
        raise ObservationError("timestamp must be UTC")
    return parsed


def now_iso(value: str | None) -> str:
    if value is not None:
        parse_iso(value)
        return value
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def clean_text(name: str, value: object, *, maximum: int = 256) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ObservationError(f"invalid {name}")
    if any(ord(char) < 32 for char in value):
        raise ObservationError(f"invalid {name}")
    return value


def sha_or_none(name: str, value: object) -> str | None:
    if value is None:
        return None
    text = clean_text(name, value, maximum=40)
    if len(text) != 40 or any(char not in "0123456789abcdef" for char in text):
        raise ObservationError(f"invalid {name}")
    return text


def unit_id(project: str, kind: str, owner: str) -> str:
    return hashlib.sha256(canonical([project, kind, owner]).encode("utf-8")).hexdigest()


def ensure_owned_regular(path: pathlib.Path, *, allow_missing: bool = False) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        if allow_missing:
            return
        raise
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ObservationError(f"unsafe file: {path.name}")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise ObservationError(f"unexpected owner: {path.name}")


def secure_state_root(requested: str | None) -> pathlib.Path:
    flywheel_home = pathlib.Path(
        os.environ.get("FLYWHEEL_HOME", pathlib.Path.home() / ".flywheel")
    )
    default = flywheel_home / "state" / "shuttle"
    root = pathlib.Path(requested).expanduser() if requested else default
    if requested and root.resolve(strict=False) != default.resolve(strict=False):
        if os.environ.get("SHUTTLE_OBSERVATION_ALLOW_TEST_ROOT") != "1":
            raise ObservationError("custom test root requires explicit test root guard")
    current = root
    ancestors: list[pathlib.Path] = []
    while not current.exists():
        ancestors.append(current)
        current = current.parent
    if current.is_symlink():
        raise ObservationError("state root ancestor is a symlink")
    for directory in reversed(ancestors):
        directory.mkdir(mode=0o700)
    if root.is_symlink() or not root.is_dir():
        raise ObservationError("unsafe state root")
    os.chmod(root, 0o700)
    return root


def load_catalog(path: pathlib.Path) -> tuple[dict[str, dict[str, object]], str]:
    ensure_owned_regular(path)
    raw = path.read_bytes()
    if len(raw) > MAX_JSON_BYTES:
        raise ObservationError("reason catalog too large")
    parsed = json.loads(raw)
    if set(parsed) != {"schemaVersion", "reasons"} or parsed["schemaVersion"] != 1:
        raise ObservationError("unsupported reason catalog")
    reasons = parsed["reasons"]
    if not isinstance(reasons, dict) or not reasons:
        raise ObservationError("empty reason catalog")
    for reason, rule in reasons.items():
        clean_text("reason", reason, maximum=80)
        if not isinstance(rule, dict) or set(rule) != {
            "outcome",
            "expected",
            "evaluated",
            "display",
        }:
            raise ObservationError(f"invalid reason rule: {reason}")
        if rule["outcome"] not in OUTCOMES:
            raise ObservationError(f"invalid reason outcome: {reason}")
        if not isinstance(rule["expected"], bool) or not isinstance(
            rule["evaluated"], bool
        ):
            raise ObservationError(f"invalid reason booleans: {reason}")
        clean_text("reason display", rule["display"], maximum=120)
    return reasons, hashlib.sha256(raw).hexdigest()


def open_db(root: pathlib.Path) -> sqlite3.Connection:
    db_path = root / "observations.sqlite"
    ensure_owned_regular(db_path, allow_missing=True)
    connection = sqlite3.connect(db_path, timeout=5, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS metadata(
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          source_id TEXT UNIQUE NOT NULL,
          schema_version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cycles(
          cycle_id TEXT PRIMARY KEY,
          seq INTEGER UNIQUE NOT NULL,
          wake_kind TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          owner_pid INTEGER NOT NULL,
          owner_start TEXT NOT NULL,
          inventory_json TEXT NOT NULL,
          legacy_result TEXT,
          result TEXT,
          summary_json TEXT,
          observer_bundle_digest TEXT NOT NULL,
          observer_schema_version INTEGER NOT NULL,
          reason_catalog_digest TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS results(
          cycle_id TEXT NOT NULL,
          unit_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          PRIMARY KEY(cycle_id,unit_id),
          FOREIGN KEY(cycle_id) REFERENCES cycles(cycle_id)
        );
        CREATE TABLE IF NOT EXISTS units(
          unit_id TEXT PRIMARY KEY,
          project TEXT NOT NULL,
          last_seq INTEGER NOT NULL,
          last_result_json TEXT NOT NULL,
          episode_id TEXT,
          episode_opened_at TEXT,
          consecutive_scheduled_bad INTEGER NOT NULL,
          last_scheduled_seq INTEGER,
          closed_at TEXT,
          drift_since TEXT,
          founder_aware INTEGER NOT NULL DEFAULT 0,
          last_scheduled_disposition TEXT
        );
        CREATE TABLE IF NOT EXISTS notification_intents(
          intent_id TEXT PRIMARY KEY,
          unit_id TEXT NOT NULL,
          episode_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          utc_day TEXT NOT NULL,
          project TEXT NOT NULL,
          route_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          delivery_state TEXT NOT NULL,
          event_id TEXT,
          message_id TEXT,
          channel_id TEXT,
          claim_owner TEXT,
          claim_at TEXT,
          attempt_state TEXT NOT NULL DEFAULT 'unattempted',
          UNIQUE(unit_id,episode_id,reason,utc_day,route_key)
        );
        CREATE TABLE IF NOT EXISTS notification_batches(
          batch_id TEXT PRIMARY KEY,
          cycle_id TEXT NOT NULL,
          route_key TEXT NOT NULL,
          route_project TEXT NOT NULL,
          reason TEXT NOT NULL,
          intent_ids_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          delivery_state TEXT NOT NULL,
          message_id TEXT,
          channel_id TEXT,
          binding_digest TEXT,
          UNIQUE(cycle_id,route_key,route_project,reason)
        );
        CREATE TABLE IF NOT EXISTS changes(
          change_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          unit_id TEXT,
          cycle_id TEXT,
          payload_json TEXT NOT NULL
        );
        """
    )
    connection.execute(
        "INSERT OR IGNORE INTO metadata(singleton,source_id,schema_version) VALUES(1,?,?)",
        (str(uuid.uuid4()), SCHEMA_VERSION),
    )
    version = connection.execute(
        "SELECT schema_version FROM metadata WHERE singleton=1"
    ).fetchone()[0]
    if version != SCHEMA_VERSION:
        connection.close()
        raise ObservationError("observation schema newer than reader")
    if db_path.exists():
        os.chmod(db_path, 0o600)
    return connection


def validate_inventory(raw: object) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw or len(raw) > 512:
        raise ObservationError("invalid inventory")
    inventory: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict) or set(item) != {
            "projectName",
            "unitKind",
            "ownerKey",
            "displayName",
        }:
            raise ObservationError("invalid inventory descriptor")
        project = clean_text("projectName", item["projectName"], maximum=80)
        kind = clean_text("unitKind", item["unitKind"], maximum=40)
        owner = clean_text("ownerKey", item["ownerKey"], maximum=160)
        display = clean_text("displayName", item["displayName"], maximum=160)
        if kind not in UNIT_KINDS:
            raise ObservationError("invalid unitKind")
        identifier = unit_id(project, kind, owner)
        if identifier in seen:
            raise ObservationError("inventory-conflict")
        seen.add(identifier)
        inventory.append(
            {
                "unitId": identifier,
                "projectName": project,
                "unitKind": kind,
                "ownerKey": owner,
                "displayName": display,
            }
        )
    return inventory


def materialize_bundle(root: pathlib.Path, catalog: pathlib.Path) -> str:
    helper = pathlib.Path(__file__).resolve()
    shell = helper.with_suffix(".sh")
    files = [helper, catalog]
    if shell.exists():
        files.append(shell)
    for path in files:
        ensure_owned_regular(path)
    content_digest = hashlib.sha256()
    for path in sorted(files, key=lambda item: item.name):
        raw = path.read_bytes()
        content_digest.update(path.name.encode("utf-8") + b"\0" + raw + b"\0")
    bundle_digest = content_digest.hexdigest()
    bundles = root / "bundles"
    bundles.mkdir(mode=0o700, exist_ok=True)
    target = bundles / bundle_digest
    if not target.exists():
        temporary = pathlib.Path(tempfile.mkdtemp(prefix=".bundle-", dir=bundles))
        try:
            for source in files:
                destination = temporary / source.name
                shutil.copyfile(source, destination)
                os.chmod(destination, 0o500 if source.suffix in {".py", ".sh"} else 0o400)
            os.chmod(temporary, 0o500)
            os.replace(temporary, target)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    return bundle_digest


def unit_snapshot(connection: sqlite3.Connection, identifier: str) -> dict[str, object]:
    row = connection.execute("SELECT * FROM units WHERE unit_id=?", (identifier,)).fetchone()
    if row is None:
        raise ObservationError("unit state missing")
    result = json.loads(row["last_result_json"])
    intents = [
        json.loads(intent[0])
        | {
            "deliveryState": intent[1],
            "attemptState": intent[2],
            "messageId": intent[3],
            "channelId": intent[4],
        }
        for intent in connection.execute(
            "SELECT payload_json,delivery_state,attempt_state,message_id,channel_id "
            "FROM notification_intents WHERE unit_id=? ORDER BY utc_day,intent_id",
            (identifier,),
        ).fetchall()
    ]
    return {
        **result,
        "episodeId": row["episode_id"],
        "episodeOpenedAt": row["episode_opened_at"],
        "consecutiveScheduledBad": row["consecutive_scheduled_bad"],
        "founderAware": bool(row["founder_aware"]),
        "closedAt": row["closed_at"],
        "driftSince": row["drift_since"],
        "notificationIntents": intents,
    }


def append_change(
    connection: sqlite3.Connection,
    identifier: str | None,
    cycle_id: str | None,
    payload: object,
) -> None:
    connection.execute(
        "INSERT INTO changes(unit_id,cycle_id,payload_json) VALUES(?,?,?)",
        (identifier, cycle_id, canonical(payload)),
    )


def command_begin(args: argparse.Namespace, connection: sqlite3.Connection, root: pathlib.Path, catalog_digest: str) -> dict[str, object]:
    if args.wake_kind not in WAKE_KINDS:
        raise ObservationError("invalid wake kind")
    inventory_path = pathlib.Path(args.inventory)
    ensure_owned_regular(inventory_path)
    raw = inventory_path.read_bytes()
    if len(raw) > MAX_JSON_BYTES:
        raise ObservationError("inventory too large")
    inventory = validate_inventory(json.loads(raw))
    if args.owner_pid <= 0:
        raise ObservationError("invalid owner pid")
    owner_start = clean_text("ownerStart", args.owner_start, maximum=160)
    bundle_digest = materialize_bundle(root, pathlib.Path(args.catalog))
    cycle_id = str(uuid.uuid4())
    connection.execute("BEGIN IMMEDIATE")
    try:
        sequence = connection.execute("SELECT COALESCE(MAX(seq),0)+1 FROM cycles").fetchone()[0]
        connection.execute(
            "INSERT INTO cycles(cycle_id,seq,wake_kind,started_at,owner_pid,owner_start,inventory_json,observer_bundle_digest,observer_schema_version,reason_catalog_digest) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (
                cycle_id,
                sequence,
                args.wake_kind,
                args.now,
                args.owner_pid,
                owner_start,
                canonical(inventory),
                bundle_digest,
                SCHEMA_VERSION,
                catalog_digest,
            ),
        )
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    return {
        "schemaVersion": SCHEMA_VERSION,
        "cycleId": cycle_id,
        "cycleSeq": sequence,
        "wakeKind": args.wake_kind,
        "observerBundleDigest": bundle_digest,
        "inventory": inventory,
    }


def validate_result(
    raw: object,
    cycle: sqlite3.Row,
    reasons: dict[str, dict[str, object]],
    observed_at: str,
) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise ObservationError("result must be an object")
    required = {
        "projectName",
        "unitKind",
        "ownerKey",
        "displayName",
        "outcome",
        "reason",
        "evidenceRef",
        "logRef",
        "deployedSha",
        "targetSha",
        "behindCommits",
        "driftBasis",
    }
    if set(raw) != required:
        raise ObservationError("invalid result fields")
    project = clean_text("projectName", raw["projectName"], maximum=80)
    kind = clean_text("unitKind", raw["unitKind"], maximum=40)
    owner = clean_text("ownerKey", raw["ownerKey"], maximum=160)
    display = clean_text("displayName", raw["displayName"], maximum=160)
    reason = clean_text("reason", raw["reason"], maximum=80)
    if kind not in UNIT_KINDS or reason not in reasons:
        raise ObservationError("unknown unit kind or reason")
    rule = reasons[reason]
    if raw["outcome"] != rule["outcome"]:
        raise ObservationError("outcome disagrees with reason catalog")
    identifier = unit_id(project, kind, owner)
    inventory = {item["unitId"]: item for item in json.loads(cycle["inventory_json"])}
    if identifier not in inventory:
        raise ObservationError("unit absent from frozen inventory")
    if inventory[identifier]["displayName"] != display:
        raise ObservationError("unit descriptor changed after cycle start")
    behind = raw["behindCommits"]
    if behind is not None and (not isinstance(behind, int) or behind < 0 or behind > 10_000_000):
        raise ObservationError("invalid behindCommits")
    drift_basis = raw["driftBasis"]
    if drift_basis not in {"first_observed_behind", "unknown"}:
        raise ObservationError("invalid driftBasis")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "cycleId": cycle["cycle_id"],
        "cycleSeq": cycle["seq"],
        "unitId": identifier,
        "projectName": project,
        "unitKind": kind,
        "ownerKey": owner,
        "displayName": display,
        "wakeKind": cycle["wake_kind"],
        "outcome": raw["outcome"],
        "reason": reason,
        "reasonDisplay": rule["display"],
        "expected": rule["expected"],
        "evaluated": rule["evaluated"],
        "observedAt": observed_at,
        "evidenceRef": clean_text("evidenceRef", raw["evidenceRef"], maximum=240),
        "logRef": clean_text("logRef", raw["logRef"], maximum=240),
        "deployedSha": sha_or_none("deployedSha", raw["deployedSha"]),
        "targetSha": sha_or_none("targetSha", raw["targetSha"]),
        "behindCommits": behind,
        "driftBasis": drift_basis,
    }


def record_payload(
    connection: sqlite3.Connection,
    cycle: sqlite3.Row,
    payload: dict[str, object],
) -> dict[str, object]:
    identifier = str(payload["unitId"])
    payload_digest = digest(payload)
    existing_result = connection.execute(
        "SELECT payload_digest FROM results WHERE cycle_id=? AND unit_id=?",
        (cycle["cycle_id"], identifier),
    ).fetchone()
    if existing_result is not None:
        if existing_result["payload_digest"] != payload_digest:
            raise ObservationError("observation-conflict")
        return {
            "status": "idempotent",
            "unit": unit_snapshot(connection, identifier),
            "createdIntents": [],
        }

    previous = connection.execute("SELECT * FROM units WHERE unit_id=?", (identifier,)).fetchone()
    abnormal = payload["outcome"] == "failed" or (
        payload["outcome"] == "skipped" and not payload["expected"]
    )
    verified_healthy = bool(payload["evaluated"]) and payload["outcome"] in {
        "deployed",
        "up_to_date",
    }
    episode_id = previous["episode_id"] if previous else None
    episode_opened = previous["episode_opened_at"] if previous else None
    consecutive = previous["consecutive_scheduled_bad"] if previous else 0
    founder_aware = bool(previous["founder_aware"]) if previous else False
    drift_since = previous["drift_since"] if previous else None
    closed_at = previous["closed_at"] if previous else None
    last_scheduled_seq = previous["last_scheduled_seq"] if previous else None
    last_disposition = previous["last_scheduled_disposition"] if previous else None
    created_intents: list[dict[str, object]] = []

    if abnormal:
        if episode_id is None:
            episode_id = str(uuid.uuid4())
            episode_opened = payload["observedAt"]
            drift_since = payload["observedAt"]
        if payload["wakeKind"] == "scheduled" and last_scheduled_seq != payload["cycleSeq"]:
            consecutive += 1
            last_scheduled_seq = payload["cycleSeq"]
            last_disposition = "abnormal"
        founder_aware = founder_aware or consecutive >= 2
        closed_at = None
        utc_day = parse_iso(str(payload["observedAt"])).date().isoformat()
        identity = [identifier, episode_id, payload["reason"], utc_day, "primary"]
        intent_id = hashlib.sha256(canonical(identity).encode("utf-8")).hexdigest()
        intent_payload = {
            "schemaVersion": 1,
            "intentId": intent_id,
            "unitId": identifier,
            "episodeId": episode_id,
            "cycleId": payload["cycleId"],
            "projectName": payload["projectName"],
            "unitKind": payload["unitKind"],
            "displayName": payload["displayName"],
            "reason": payload["reason"],
            "reasonDisplay": payload["reasonDisplay"],
            "utcDay": utc_day,
            "routeKey": "primary",
            "behindCommits": payload["behindCommits"],
            "driftSince": drift_since,
            "logRef": payload["logRef"],
        }
        inserted = connection.execute(
            "INSERT OR IGNORE INTO notification_intents(intent_id,unit_id,episode_id,reason,utc_day,project,route_key,payload_json,delivery_state,event_id) "
            "VALUES(?,?,?,?,?,?,?,?,'pending',?)",
            (
                intent_id,
                identifier,
                episode_id,
                payload["reason"],
                utc_day,
                payload["projectName"],
                "primary",
                canonical(intent_payload),
                intent_id,
            ),
        ).rowcount
        if inserted:
            created_intents.append(intent_payload)
    elif verified_healthy:
        if episode_id is not None:
            closed_at = payload["observedAt"]
            connection.execute(
                "UPDATE notification_intents SET delivery_state='cancelled_recovered' "
                "WHERE unit_id=? AND episode_id=? AND delivery_state IN ('pending','retryable')",
                (identifier, episode_id),
            )
        episode_id = None
        episode_opened = None
        consecutive = 0
        founder_aware = False
        drift_since = None
        if payload["wakeKind"] == "scheduled":
            last_scheduled_seq = payload["cycleSeq"]
            last_disposition = "healthy"
    elif payload["wakeKind"] == "scheduled":
        last_scheduled_seq = payload["cycleSeq"]
        last_disposition = "expected_skip"

    connection.execute(
        "INSERT INTO results(cycle_id,unit_id,payload_json,payload_digest) VALUES(?,?,?,?)",
        (cycle["cycle_id"], identifier, canonical(payload), payload_digest),
    )
    connection.execute(
        "INSERT INTO units(unit_id,project,last_seq,last_result_json,episode_id,episode_opened_at,consecutive_scheduled_bad,last_scheduled_seq,closed_at,drift_since,founder_aware,last_scheduled_disposition) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(unit_id) DO UPDATE SET "
        "project=excluded.project,last_seq=excluded.last_seq,last_result_json=excluded.last_result_json,episode_id=excluded.episode_id,episode_opened_at=excluded.episode_opened_at,"
        "consecutive_scheduled_bad=excluded.consecutive_scheduled_bad,last_scheduled_seq=excluded.last_scheduled_seq,closed_at=excluded.closed_at,drift_since=excluded.drift_since,"
        "founder_aware=excluded.founder_aware,last_scheduled_disposition=excluded.last_scheduled_disposition",
        (
            identifier,
            payload["projectName"],
            payload["cycleSeq"],
            canonical(payload),
            episode_id,
            episode_opened,
            consecutive,
            last_scheduled_seq,
            closed_at,
            drift_since,
            int(founder_aware),
            last_disposition,
        ),
    )
    snapshot = unit_snapshot(connection, identifier)
    append_change(connection, identifier, str(cycle["cycle_id"]), snapshot)
    return {"status": "recorded", "unit": snapshot, "createdIntents": created_intents}


def command_record(args: argparse.Namespace, connection: sqlite3.Connection, reasons: dict[str, dict[str, object]]) -> dict[str, object]:
    cycle = connection.execute("SELECT * FROM cycles WHERE cycle_id=?", (args.cycle_id,)).fetchone()
    if cycle is None:
        raise ObservationError("unknown cycle")
    if cycle["ended_at"] is not None:
        raise ObservationError("cycle already finished")
    result_path = pathlib.Path(args.result)
    ensure_owned_regular(result_path)
    raw = result_path.read_bytes()
    if len(raw) > MAX_JSON_BYTES:
        raise ObservationError("result too large")
    payload = validate_result(json.loads(raw), cycle, reasons, args.now)
    connection.execute("BEGIN IMMEDIATE")
    try:
        receipt = record_payload(connection, cycle, payload)
        connection.execute("COMMIT")
        return receipt
    except Exception:
        connection.execute("ROLLBACK")
        raise


def command_fill(args: argparse.Namespace, connection: sqlite3.Connection, reasons: dict[str, dict[str, object]]) -> dict[str, object]:
    cycle = connection.execute("SELECT * FROM cycles WHERE cycle_id=?", (args.cycle_id,)).fetchone()
    if cycle is None:
        raise ObservationError("unknown cycle")
    if cycle["ended_at"] is not None:
        raise ObservationError("cycle already finished")
    reason = clean_text("reason", args.reason, maximum=80)
    rule = reasons.get(reason)
    if rule is None:
        raise ObservationError("unknown fill reason")
    wanted = set(args.unit_kind or [])
    if not wanted or not wanted.issubset(UNIT_KINDS):
        raise ObservationError("fill requires valid unit kinds")
    existing = {
        row[0]
        for row in connection.execute(
            "SELECT unit_id FROM results WHERE cycle_id=?", (args.cycle_id,)
        ).fetchall()
    }
    receipts: list[dict[str, object]] = []
    connection.execute("BEGIN IMMEDIATE")
    try:
        for item in json.loads(cycle["inventory_json"]):
            if item["unitKind"] not in wanted or item["unitId"] in existing:
                continue
            payload = {
                "schemaVersion": 1,
                "cycleId": cycle["cycle_id"],
                "cycleSeq": cycle["seq"],
                "unitId": item["unitId"],
                "projectName": item["projectName"],
                "unitKind": item["unitKind"],
                "ownerKey": item["ownerKey"],
                "displayName": item["displayName"],
                "wakeKind": cycle["wake_kind"],
                "outcome": rule["outcome"],
                "reason": reason,
                "reasonDisplay": rule["display"],
                "expected": rule["expected"],
                "evaluated": rule["evaluated"],
                "observedAt": args.now,
                "evidenceRef": "cycle-fill",
                "logRef": "flywheel-updater.log#cycle",
                "deployedSha": None,
                "targetSha": None,
                "behindCommits": None,
                "driftBasis": "unknown",
            }
            receipts.append(record_payload(connection, cycle, payload))
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    return {
        "schemaVersion": 1,
        "cycleId": args.cycle_id,
        "reason": reason,
        "recorded": len(receipts),
        "receipts": receipts,
    }


def missing_payload(cycle: sqlite3.Row, item: dict[str, str], observed_at: str) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "cycleId": cycle["cycle_id"],
        "cycleSeq": cycle["seq"],
        "unitId": item["unitId"],
        "projectName": item["projectName"],
        "unitKind": item["unitKind"],
        "ownerKey": item["ownerKey"],
        "displayName": item["displayName"],
        "wakeKind": cycle["wake_kind"],
        "outcome": "failed",
        "reason": "unit-result-missing",
        "reasonDisplay": "缺少单元结果",
        "expected": False,
        "evaluated": False,
        "observedAt": observed_at,
        "evidenceRef": "cycle-finalizer",
        "logRef": "flywheel-updater.log#cycle",
        "deployedSha": None,
        "targetSha": None,
        "behindCommits": None,
        "driftBasis": "unknown",
    }


def command_finish(args: argparse.Namespace, connection: sqlite3.Connection) -> dict[str, object]:
    cycle = connection.execute("SELECT * FROM cycles WHERE cycle_id=?", (args.cycle_id,)).fetchone()
    if cycle is None:
        raise ObservationError("unknown cycle")
    if cycle["ended_at"] is not None:
        return json.loads(cycle["summary_json"])
    connection.execute("BEGIN IMMEDIATE")
    try:
        recorded = {
            row[0]
            for row in connection.execute(
                "SELECT unit_id FROM results WHERE cycle_id=?", (args.cycle_id,)
            ).fetchall()
        }
        for item in json.loads(cycle["inventory_json"]):
            if item["unitId"] not in recorded:
                record_payload(connection, cycle, missing_payload(cycle, item, args.now))
        payloads = [
            json.loads(row[0])
            for row in connection.execute(
                "SELECT payload_json FROM results WHERE cycle_id=? ORDER BY unit_id",
                (args.cycle_id,),
            ).fetchall()
        ]
        counts = {outcome: 0 for outcome in OUTCOMES}
        abnormal = 0
        healthy = 0
        expected_skips = 0
        for payload in payloads:
            counts[payload["outcome"]] += 1
            if payload["outcome"] == "failed" or (
                payload["outcome"] == "skipped" and not payload["expected"]
            ):
                abnormal += 1
            elif payload["outcome"] in {"deployed", "up_to_date"}:
                healthy += 1
            else:
                expected_skips += 1
        if abnormal and healthy + expected_skips:
            result = "partial_failure"
        elif abnormal:
            result = "all_failed"
        elif healthy:
            result = "all_success"
        else:
            result = "expected_skips_only"
        active = connection.execute(
            "SELECT COUNT(*) FROM units WHERE episode_id IS NOT NULL"
        ).fetchone()[0]
        summary = {
            "schemaVersion": 1,
            "cycleId": args.cycle_id,
            "cycleSeq": cycle["seq"],
            "wakeKind": cycle["wake_kind"],
            "legacyResult": clean_text("legacyResult", args.legacy_result, maximum=80),
            "result": result,
            "counts": counts,
            "allUnitsVerified": abnormal == 0 and expected_skips == 0,
            "activeIncidentCount": active,
        }
        connection.execute(
            "UPDATE cycles SET ended_at=?,legacy_result=?,result=?,summary_json=? WHERE cycle_id=?",
            (args.now, args.legacy_result, result, canonical(summary), args.cycle_id),
        )
        append_change(connection, None, args.cycle_id, {"kind": "cycle_summary", **summary})
        connection.execute("COMMIT")
        return summary
    except Exception:
        connection.execute("ROLLBACK")
        raise


def drift_age_text(value: object, now: str) -> str:
    if not isinstance(value, str):
        return "落后时间未知"
    elapsed = parse_iso(now) - parse_iso(value)
    hours = max(0, int(elapsed.total_seconds() // 3600))
    return f"已确认至少落后 {hours} 小时"


def dispatch_body(intents: list[dict[str, object]], now: str) -> tuple[str, str]:
    first = intents[0]
    if len(intents) == 1:
        title = f"班车单元异常：{first['displayName']}"
    else:
        title = f"班车 {len(intents)} 个单元同因异常"
    lines: list[str] = []
    for intent in intents[:8]:
        behind = intent.get("behindCommits")
        behind_text = f"落后 {behind} 个提交" if isinstance(behind, int) else "落后提交数未知"
        drift_text = drift_age_text(intent.get("driftSince"), now)
        lines.append(
            f"- {intent['displayName']} ({intent['projectName']}): "
            f"{intent['reason']}；{behind_text}；{drift_text}；日志 {intent['logRef']}"
        )
    if len(intents) > 8:
        lines.append(f"- 另有 {len(intents) - 8} 个同因单元，详见固定页")
    body = "\n".join(lines)
    if len(body) > 1800:
        body = body[:1770] + "…详见固定页"
    return title, body


def command_prepare_dispatch(
    args: argparse.Namespace, connection: sqlite3.Connection
) -> dict[str, object]:
    cycle = connection.execute(
        "SELECT * FROM cycles WHERE cycle_id=?", (args.cycle_id,)
    ).fetchone()
    if cycle is None or cycle["ended_at"] is None:
        raise ObservationError("dispatch requires a finished cycle")
    copy_projects = {
        clean_text("copyProject", value, maximum=80)
        for value in (args.copy_project or [])
    }
    connection.execute("BEGIN IMMEDIATE")
    try:
        primary_rows = connection.execute(
            "SELECT * FROM notification_intents WHERE route_key='primary' "
            "AND delivery_state='pending' ORDER BY intent_id"
        ).fetchall()
        for row in primary_rows:
            payload = json.loads(row["payload_json"])
            if row["project"] not in copy_projects:
                continue
            identity = [
                row["unit_id"],
                row["episode_id"],
                row["reason"],
                row["utc_day"],
                "project_copy",
            ]
            copy_id = hashlib.sha256(canonical(identity).encode("utf-8")).hexdigest()
            copy_payload = {**payload, "intentId": copy_id, "routeKey": "project_copy"}
            connection.execute(
                "INSERT OR IGNORE INTO notification_intents(intent_id,unit_id,episode_id,reason,utc_day,project,route_key,payload_json,delivery_state,event_id) "
                "VALUES(?,?,?,?,?,?,?,?,'pending',?)",
                (
                    copy_id,
                    row["unit_id"],
                    row["episode_id"],
                    row["reason"],
                    row["utc_day"],
                    row["project"],
                    "project_copy",
                    canonical(copy_payload),
                    copy_id,
                ),
            )

        eligible = connection.execute(
            "SELECT * FROM notification_intents WHERE delivery_state='pending' ORDER BY intent_id"
        ).fetchall()

        grouped: dict[tuple[str, str, str], list[sqlite3.Row]] = {}
        for row in eligible:
            route_project = row["project"] if row["route_key"] == "project_copy" else "primary"
            grouped.setdefault(
                (row["route_key"], route_project, row["reason"]), []
            ).append(row)

        batches: list[dict[str, object]] = []
        for (route_key, route_project, reason), rows in sorted(grouped.items()):
            intent_ids = sorted(str(row["intent_id"]) for row in rows)
            batch_id = hashlib.sha256(
                canonical([args.cycle_id, route_key, route_project, reason, intent_ids]).encode(
                    "utf-8"
                )
            ).hexdigest()
            intents = [json.loads(row["payload_json"]) for row in rows]
            title, body = dispatch_body(intents, args.now)
            origin_projects = sorted({str(item["projectName"]) for item in intents})
            payload = {
                "schemaVersion": 1,
                "batchId": batch_id,
                "cycleId": args.cycle_id,
                "routeKey": route_key,
                "routeProject": route_project,
                "originProject": origin_projects[0],
                "originProjects": origin_projects,
                "reason": reason,
                "intentIds": intent_ids,
                "title": title,
                "body": body,
                "signature": batch_id,
                "unitCount": len(intents),
            }
            inserted = connection.execute(
                "INSERT OR IGNORE INTO notification_batches(batch_id,cycle_id,route_key,route_project,reason,intent_ids_json,payload_json,delivery_state) "
                "VALUES(?,?,?,?,?,?,?,'delivery_unknown')",
                (
                    batch_id,
                    args.cycle_id,
                    route_key,
                    route_project,
                    reason,
                    canonical(intent_ids),
                    canonical(payload),
                ),
            ).rowcount
            if not inserted:
                continue
            placeholders = ",".join("?" for _ in intent_ids)
            connection.execute(
                f"UPDATE notification_intents SET delivery_state='delivery_unknown',attempt_state='inflight',claim_owner=? WHERE intent_id IN ({placeholders})",
                (batch_id, *intent_ids),
            )
            for identifier in sorted({str(row["unit_id"]) for row in rows}):
                append_change(
                    connection,
                    identifier,
                    args.cycle_id,
                    unit_snapshot(connection, identifier),
                )
            batches.append(payload)
        connection.execute("COMMIT")
        return {"schemaVersion": 1, "cycleId": args.cycle_id, "batches": batches}
    except Exception:
        connection.execute("ROLLBACK")
        raise


def command_intent(args: argparse.Namespace, connection: sqlite3.Connection) -> dict[str, object]:
    identifier = clean_text("intentId", args.intent_id, maximum=64)
    row = connection.execute(
        "SELECT payload_json,delivery_state,binding_digest,message_id,channel_id "
        "FROM notification_batches WHERE batch_id=?",
        (identifier,),
    ).fetchone()
    if row is None:
        raise ObservationError("unknown shuttle dispatch intent")
    return {
        **json.loads(row["payload_json"]),
        "deliveryState": row["delivery_state"],
        "bindingDigest": row["binding_digest"],
        "messageId": row["message_id"],
        "channelId": row["channel_id"],
    }


def command_delivery(args: argparse.Namespace, connection: sqlite3.Connection) -> dict[str, object]:
    states = {
        "sent",
        "queued_transient",
        "delivery_unknown",
        "dead_lettered",
        "config_error",
    }
    if args.state not in states:
        raise ObservationError("invalid shuttle delivery state")
    if args.channel_id is not None and not args.channel_id.isdigit():
        raise ObservationError("invalid delivery channel")
    if args.message_id is not None and not args.message_id.isdigit():
        raise ObservationError("invalid delivery message")
    if args.state == "sent" and (args.channel_id is None or args.message_id is None):
        raise ObservationError("sent delivery requires channel and message receipt")
    row = connection.execute(
        "SELECT * FROM notification_batches WHERE batch_id=?", (args.intent_id,)
    ).fetchone()
    if row is None:
        raise ObservationError("unknown shuttle dispatch intent")
    intent_ids = json.loads(row["intent_ids_json"])
    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.execute(
            "UPDATE notification_batches SET delivery_state=?,message_id=?,channel_id=?,binding_digest=? WHERE batch_id=?",
            (
                args.state,
                args.message_id,
                args.channel_id,
                args.binding_digest,
                args.intent_id,
            ),
        )
        placeholders = ",".join("?" for _ in intent_ids)
        connection.execute(
            f"UPDATE notification_intents SET delivery_state=?,attempt_state=?,message_id=?,channel_id=? WHERE intent_id IN ({placeholders})",
            (
                args.state,
                "settled" if args.state != "delivery_unknown" else "unknown",
                args.message_id,
                args.channel_id,
                *intent_ids,
            ),
        )
        unit_rows = connection.execute(
            f"SELECT DISTINCT unit_id FROM notification_intents WHERE intent_id IN ({placeholders})",
            intent_ids,
        ).fetchall()
        for unit_row in unit_rows:
            append_change(
                connection,
                unit_row["unit_id"],
                row["cycle_id"],
                unit_snapshot(connection, unit_row["unit_id"]),
            )
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise
    return {
        "schemaVersion": 1,
        "intentId": args.intent_id,
        "deliveryState": args.state,
        "messageId": args.message_id,
        "channelId": args.channel_id,
    }


def command_export(args: argparse.Namespace, connection: sqlite3.Connection) -> dict[str, object]:
    if args.after_change_seq < 0 or not 1 <= args.limit <= 200:
        raise ObservationError("invalid export cursor or limit")
    source = connection.execute(
        "SELECT source_id FROM metadata WHERE singleton=1"
    ).fetchone()[0]
    rows = connection.execute(
        "SELECT change_seq,unit_id,cycle_id,payload_json FROM changes "
        "WHERE change_seq>? ORDER BY change_seq LIMIT ?",
        (args.after_change_seq, args.limit + 1),
    ).fetchall()
    has_more = len(rows) > args.limit
    rows = rows[: args.limit]
    changes = [
        {
            "changeSeq": row["change_seq"],
            "unitId": row["unit_id"],
            "cycleId": row["cycle_id"],
            "payload": json.loads(row["payload_json"]),
        }
        for row in rows
    ]
    unit_rows = connection.execute(
        "SELECT unit_id FROM units ORDER BY project,unit_id"
    ).fetchall()
    return {
        "schemaVersion": 1,
        "sourceId": source,
        "afterChangeSeq": args.after_change_seq,
        "nextCursor": changes[-1]["changeSeq"] if changes else args.after_change_seq,
        "hasMore": has_more,
        "changes": changes,
        "units": [unit_snapshot(connection, row[0]) for row in unit_rows],
    }


def command_show(connection: sqlite3.Connection) -> dict[str, object]:
    source = connection.execute(
        "SELECT source_id FROM metadata WHERE singleton=1"
    ).fetchone()[0]
    return {
        "schemaVersion": 1,
        "sourceId": source,
        "cycles": connection.execute("SELECT COUNT(*) FROM cycles").fetchone()[0],
        "units": [
            unit_snapshot(connection, row[0])
            for row in connection.execute(
                "SELECT unit_id FROM units ORDER BY project,unit_id"
            ).fetchall()
        ],
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--state-root")
    result.add_argument(
        "--catalog",
        default=str(pathlib.Path(__file__).with_name("shuttle-reasons.json")),
    )
    result.add_argument("--now")
    commands = result.add_subparsers(dest="command", required=True)
    begin = commands.add_parser("begin")
    begin.add_argument("--wake-kind", required=True)
    begin.add_argument("--inventory", required=True)
    begin.add_argument("--owner-pid", required=True, type=int)
    begin.add_argument("--owner-start", required=True)
    record = commands.add_parser("record")
    record.add_argument("--cycle-id", required=True)
    record.add_argument("--result", required=True)
    finish = commands.add_parser("finish")
    finish.add_argument("--cycle-id", required=True)
    finish.add_argument("--legacy-result", required=True)
    fill = commands.add_parser("fill")
    fill.add_argument("--cycle-id", required=True)
    fill.add_argument("--reason", required=True)
    fill.add_argument("--unit-kind", action="append")
    prepare = commands.add_parser("prepare-dispatch")
    prepare.add_argument("--cycle-id", required=True)
    prepare.add_argument("--copy-project", action="append")
    intent = commands.add_parser("intent")
    intent.add_argument("--intent-id", required=True)
    delivery = commands.add_parser("delivery")
    delivery.add_argument("--intent-id", required=True)
    delivery.add_argument("--state", required=True)
    delivery.add_argument("--message-id")
    delivery.add_argument("--channel-id")
    delivery.add_argument("--binding-digest")
    export = commands.add_parser("export")
    export.add_argument("--after-change-seq", required=True, type=int)
    export.add_argument("--limit", required=True, type=int)
    commands.add_parser("show")
    return result


def main() -> int:
    args = parser().parse_args()
    args.now = now_iso(args.now)
    root = secure_state_root(args.state_root)
    reasons, catalog_digest = load_catalog(pathlib.Path(args.catalog))
    connection = open_db(root)
    try:
        if args.command == "begin":
            output = command_begin(args, connection, root, catalog_digest)
        elif args.command == "record":
            output = command_record(args, connection, reasons)
        elif args.command == "finish":
            output = command_finish(args, connection)
        elif args.command == "fill":
            output = command_fill(args, connection, reasons)
        elif args.command == "prepare-dispatch":
            output = command_prepare_dispatch(args, connection)
        elif args.command == "intent":
            output = command_intent(args, connection)
        elif args.command == "delivery":
            output = command_delivery(args, connection)
        elif args.command == "export":
            output = command_export(args, connection)
        else:
            output = command_show(connection)
        print(canonical(output))
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ObservationError, OSError, sqlite3.Error, json.JSONDecodeError) as error:
        print(f"shuttle-observation: {error}", file=sys.stderr)
        raise SystemExit(2)
