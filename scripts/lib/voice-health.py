#!/usr/bin/env python3
"""Trusted local SQLite source for voice daemon health observations."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time
import uuid


SCHEMA_VERSION = 1
SERVICE_LABEL = "com.flywheel.voice"
MAX_INPUT_BYTES = 32 * 1024
MAX_EXPORT_ROWS = 200
MAX_DEMAND_IDENTITIES = 32

DEMAND_STATES = frozenset({"none", "required", "unknown"})
DEMAND_SOURCE_STATUSES = frozenset(
    {"available", "trigger_invalid", "change_gap", "demand_overflow"}
)
REASON_CLASSES = frozenset(
    {
        "bridge_connect_failed",
        "bridge_timeout_headers",
        "bridge_timeout_body",
        "bridge_auth_rejected",
        "bridge_http_error",
        "bridge_protocol_invalid",
        "startup_config_invalid",
        "startup_lock_unavailable",
        "startup_not_ready",
        "session_create_failed",
        "session_runtime_failed",
        "lease_lost",
        "heartbeat_stale",
        "health_observation_unavailable",
        "demand_source_unavailable",
        "unknown_failure",
    }
)
OPERATIONS = frozenset(
    {
        "desired",
        "claim",
        "renew",
        "state",
        "outbound",
        "receipt",
        "session_create",
        "session_runtime",
        "startup",
        "health_store",
        "demand_snapshot",
    }
)
RESULT_KINDS = frozenset(
    {
        "idle_success",
        "poll_failed",
        "session_failed",
        "session_recovered",
        "session_ended",
        "closed_not_required",
        "progress",
        "daemon_stopped",
    }
)
DELIVERY_STATES = frozenset(
    {
        "sent",
        "queued_transient",
        "delivery_unknown",
        "dead_lettered",
        "config_error",
    }
)
CLAIMABLE_STATES = frozenset({"pending", "queued_transient", "config_error"})
SAFE_TOKEN = re.compile(r"^[A-Za-z0-9_.:@-]{1,128}$")
HEX_DIGEST = re.compile(r"^[0-9a-f]{64}$")


class VoiceHealthError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _check_owned(path: Path, expected: str, exact_mode: int | None = None) -> None:
    try:
        info = path.lstat()
    except OSError as error:
        raise VoiceHealthError("unsafe_path") from error
    if stat.S_ISLNK(info.st_mode):
        raise VoiceHealthError("unsafe_path")
    if expected == "directory" and not stat.S_ISDIR(info.st_mode):
        raise VoiceHealthError("unsafe_path")
    if expected == "file" and not stat.S_ISREG(info.st_mode):
        raise VoiceHealthError("unsafe_path")
    if info.st_uid != os.geteuid():
        raise VoiceHealthError("unsafe_path")
    if exact_mode is not None and stat.S_IMODE(info.st_mode) != exact_mode:
        raise VoiceHealthError("unsafe_permissions")


def _ensure_directory(path: Path, exact_mode: int | None = None) -> None:
    if path.exists() or path.is_symlink():
        _check_owned(path, "directory", exact_mode)
        return
    try:
        path.mkdir(mode=exact_mode or 0o700, parents=True, exist_ok=False)
        if exact_mode is not None:
            path.chmod(exact_mode)
    except FileExistsError:
        pass
    except OSError as error:
        raise VoiceHealthError("unsafe_path") from error
    _check_owned(path, "directory", exact_mode)


def _secure_paths(state_root: Path) -> tuple[Path, Path, Path]:
    if not state_root.is_absolute():
        raise VoiceHealthError("unsafe_path")
    _ensure_directory(state_root)
    state_dir = state_root / "state"
    _ensure_directory(state_dir)
    health_dir = state_dir / "voice-health"
    _ensure_directory(health_dir, 0o700)
    return (
        health_dir,
        health_dir / "host-instance-id",
        health_dir / "observations.sqlite",
    )


@contextmanager
def _initialization_lock(health_dir: Path):
    lock_path = health_dir / ".init.lock"
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(lock_path, flags, 0o600)
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        _check_owned(lock_path, "file", 0o600)
        yield
    except OSError as error:
        raise VoiceHealthError("unsafe_path") from error
    finally:
        if "descriptor" in locals():
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)


def _load_or_create_host_identity(path: Path) -> str:
    if path.exists() or path.is_symlink():
        _check_owned(path, "file", 0o600)
        try:
            value = path.read_text(encoding="ascii").strip()
            return str(uuid.UUID(value))
        except (OSError, UnicodeError, ValueError) as error:
            raise VoiceHealthError("host_identity_invalid") from error

    value = str(uuid.uuid4())
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            handle.write(f"{value}\n")
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        return _load_or_create_host_identity(path)
    except OSError as error:
        raise VoiceHealthError("host_identity_unavailable") from error
    _check_owned(path, "file", 0o600)
    return value


def _ensure_database_file(path: Path) -> None:
    if path.exists() or path.is_symlink():
        _check_owned(path, "file", 0o600)
        return
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
        os.close(descriptor)
    except FileExistsError:
        pass
    except OSError as error:
        raise VoiceHealthError("health_store_unavailable") from error
    _check_owned(path, "file", 0o600)


def _open_database(path: Path) -> tuple[sqlite3.Connection, dict[str, object]]:
    _ensure_database_file(path)
    try:
        database = sqlite3.connect(path, timeout=0.1)
        database.row_factory = sqlite3.Row
        busy_timeout = int(database.execute("PRAGMA busy_timeout = 100").fetchone()[0])
        journal_mode = str(database.execute("PRAGMA journal_mode = WAL").fetchone()[0])
        database.execute("PRAGMA synchronous = FULL")
        synchronous = int(database.execute("PRAGMA synchronous").fetchone()[0])
        wal_autocheckpoint = int(
            database.execute("PRAGMA wal_autocheckpoint = 0").fetchone()[0]
        )
        database.execute("PRAGMA foreign_keys = ON")
    except sqlite3.Error as error:
        raise VoiceHealthError("health_store_unavailable") from error
    return database, {
        "busyTimeoutMs": busy_timeout,
        "journalMode": journal_mode.lower(),
        "synchronous": "full" if synchronous == 2 else str(synchronous),
        "walAutoCheckpoint": wal_autocheckpoint,
    }


SCHEMA_SQL = """
CREATE TABLE metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    source_id TEXT NOT NULL UNIQUE,
    next_observation_seq INTEGER NOT NULL CHECK (next_observation_seq > 0),
    next_change_seq INTEGER NOT NULL CHECK (next_change_seq > 0),
    created_at TEXT NOT NULL
);

CREATE TABLE health (
    service_id TEXT PRIMARY KEY,
    service_label TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    boot_id TEXT,
    observation_seq INTEGER NOT NULL CHECK (observation_seq >= 0),
    phase TEXT NOT NULL,
    demand_source_id TEXT,
    demand_revision INTEGER,
    demand_state TEXT NOT NULL DEFAULT 'unknown',
    demand_digest TEXT,
    demand_observed_at TEXT,
    demand_identities_json TEXT NOT NULL DEFAULT '[]',
    demand_event_cursor INTEGER NOT NULL DEFAULT 0,
    demand_event_high_water INTEGER NOT NULL DEFAULT 0,
    demand_has_more INTEGER NOT NULL DEFAULT 0,
    boot_at TEXT,
    last_iteration_success_at TEXT,
    last_progress_at TEXT,
    success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
    progress_count INTEGER NOT NULL DEFAULT 0 CHECK (progress_count >= 0),
    failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    failure_streak INTEGER NOT NULL DEFAULT 0 CHECK (failure_streak >= 0),
    first_failure_at TEXT,
    last_failure_at TEXT,
    reason_class TEXT,
    operation TEXT,
    duration_ms INTEGER,
    poll_episode_id TEXT,
    session_episode_id TEXT,
    source_status TEXT NOT NULL
);

CREATE TABLE producer_events (
    generation INTEGER NOT NULL,
    producer_event_seq INTEGER NOT NULL CHECK (producer_event_seq > 0),
    observation_seq INTEGER NOT NULL CHECK (observation_seq > 0),
    event_kind TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    PRIMARY KEY (generation, producer_event_seq)
);

CREATE TABLE episodes (
    episode_id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    demand_source_id TEXT,
    source_status TEXT NOT NULL DEFAULT 'verified',
    demand_id TEXT,
    attempt_id TEXT,
    opened_at TEXT NOT NULL,
    reason_class TEXT NOT NULL,
    threshold TEXT NOT NULL,
    closed_at TEXT,
    close_reason TEXT,
    recovery_observation_seq INTEGER,
    FOREIGN KEY (service_id) REFERENCES health(service_id)
);

CREATE TABLE notification_intents (
    intent_id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    frozen_payload TEXT NOT NULL,
    route_key TEXT NOT NULL,
    binding_digest TEXT,
    state TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,
    claimed_at TEXT,
    claim_expires_at TEXT,
    channel_id TEXT,
    message_id TEXT,
    FOREIGN KEY (service_id) REFERENCES health(service_id),
    FOREIGN KEY (episode_id) REFERENCES episodes(episode_id)
);

CREATE TABLE demand_transition_events (
    demand_source_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL CHECK (event_seq > 0),
    event_kind TEXT NOT NULL,
    demand_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    reason_class TEXT,
    payload_digest TEXT NOT NULL,
    PRIMARY KEY (demand_source_id, event_seq)
);

CREATE TABLE demand_attempts (
    demand_source_id TEXT NOT NULL,
    demand_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    state TEXT NOT NULL,
    first_event_seq INTEGER NOT NULL,
    last_event_seq INTEGER NOT NULL,
    required_at TEXT NOT NULL,
    terminal_at TEXT,
    terminal_reason_class TEXT,
    PRIMARY KEY (demand_source_id, demand_id, attempt_id)
);

CREATE TABLE startup_events (
    startup_attempt_id TEXT PRIMARY KEY,
    demand_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    reason_class TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    observation_seq INTEGER NOT NULL
);

CREATE TABLE session_recovery_proofs (
    proof_id TEXT PRIMARY KEY,
    episode_id TEXT,
    demand_source_id TEXT NOT NULL,
    demand_id TEXT NOT NULL,
    predecessor_attempt_id TEXT,
    successor_attempt_id TEXT NOT NULL,
    live_at TEXT NOT NULL,
    renew_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    proof_kind TEXT NOT NULL,
    FOREIGN KEY (episode_id) REFERENCES episodes(episode_id)
);

CREATE TABLE notification_attempts (
    ledger_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id TEXT NOT NULL,
    claim_token TEXT,
    event_kind TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    binding_digest TEXT,
    channel_id TEXT,
    message_id TEXT,
    FOREIGN KEY (intent_id) REFERENCES notification_intents(intent_id)
);

CREATE TABLE changes (
    source_id TEXT NOT NULL,
    change_seq INTEGER NOT NULL CHECK (change_seq > 0),
    service_id TEXT NOT NULL,
    observation_seq INTEGER NOT NULL CHECK (observation_seq > 0),
    changed_at TEXT NOT NULL,
    projection_json TEXT NOT NULL,
    PRIMARY KEY (source_id, change_seq),
    FOREIGN KEY (service_id) REFERENCES health(service_id)
);
"""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _initialize_schema(database: sqlite3.Connection) -> None:
    version = int(database.execute("PRAGMA user_version").fetchone()[0])
    if version > SCHEMA_VERSION:
        raise VoiceHealthError("schema_newer")
    if version == 0:
        try:
            database.execute("BEGIN IMMEDIATE")
            for statement in SCHEMA_SQL.strip().split(";\n\n"):
                database.execute(statement)
            database.execute(
                "INSERT INTO metadata "
                "(singleton, schema_version, source_id, next_observation_seq, "
                "next_change_seq, created_at) VALUES (1, ?, ?, 1, 1, ?)",
                (SCHEMA_VERSION, str(uuid.uuid4()), _utc_now()),
            )
            database.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            database.commit()
        except sqlite3.Error as error:
            database.rollback()
            raise VoiceHealthError("health_store_unavailable") from error
    elif version != SCHEMA_VERSION:
        raise VoiceHealthError("schema_unsupported")

    _migrate_v1_columns(database)

    row = database.execute(
        "SELECT schema_version, source_id FROM metadata WHERE singleton = 1"
    ).fetchone()
    if row is None or int(row["schema_version"]) != SCHEMA_VERSION:
        raise VoiceHealthError("schema_invalid")
    try:
        uuid.UUID(str(row["source_id"]))
    except ValueError as error:
        raise VoiceHealthError("schema_invalid") from error


def _migrate_v1_columns(database: sqlite3.Connection) -> None:
    """Complete the pre-implementation v1 foundation without changing identity."""
    health_columns = {
        str(row["name"])
        for row in database.execute("PRAGMA table_info(health)").fetchall()
    }
    health_additions = {
        "demand_source_id": "TEXT",
        "demand_digest": "TEXT",
        "demand_observed_at": "TEXT",
        "demand_identities_json": "TEXT NOT NULL DEFAULT '[]'",
        "demand_event_cursor": "INTEGER NOT NULL DEFAULT 0",
        "demand_event_high_water": "INTEGER NOT NULL DEFAULT 0",
        "demand_has_more": "INTEGER NOT NULL DEFAULT 0",
        "progress_count": "INTEGER NOT NULL DEFAULT 0",
    }
    episode_columns = {
        str(row["name"])
        for row in database.execute("PRAGMA table_info(episodes)").fetchall()
    }
    episode_additions = {
        "demand_source_id": "TEXT",
        "source_status": "TEXT NOT NULL DEFAULT 'unverified'",
    }
    proof_columns = {
        str(row["name"])
        for row in database.execute(
            "PRAGMA table_info(session_recovery_proofs)"
        ).fetchall()
    }
    notification_info = database.execute(
        "PRAGMA table_info(notification_intents)"
    ).fetchall()
    notification_columns = {str(row["name"]) for row in notification_info}
    binding_not_null = any(
        row["name"] == "binding_digest" and int(row["notnull"]) == 1
        for row in notification_info
    )
    existing_tables = {
        str(row["name"])
        for row in database.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    added_tables = {
        "demand_transition_events",
        "demand_attempts",
        "startup_events",
        "session_recovery_proofs",
        "notification_attempts",
    }
    needs_migration = any(
        column not in health_columns for column in health_additions
    ) or any(
        column not in episode_columns for column in episode_additions
    ) or binding_not_null or not {"claimed_at", "claim_expires_at"}.issubset(
        notification_columns
    ) or not added_tables.issubset(existing_tables) or (
        "session_recovery_proofs" in existing_tables
        and "demand_source_id" not in proof_columns
    )
    if not needs_migration:
        return

    try:
        database.execute("BEGIN IMMEDIATE")
        for column, declaration in health_additions.items():
            if column not in health_columns:
                database.execute(f"ALTER TABLE health ADD COLUMN {column} {declaration}")
        for column, declaration in episode_additions.items():
            if column not in episode_columns:
                database.execute(
                    f"ALTER TABLE episodes ADD COLUMN {column} {declaration}"
                )

        if binding_not_null:
            database.execute(
                "CREATE TABLE notification_intents_v1_migration ("
                "intent_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, "
                "episode_id TEXT NOT NULL, frozen_payload TEXT NOT NULL, "
                "route_key TEXT NOT NULL, binding_digest TEXT, state TEXT NOT NULL, "
                "attempt_count INTEGER NOT NULL DEFAULT 0, claim_token TEXT, "
                "claimed_at TEXT, claim_expires_at TEXT, channel_id TEXT, message_id TEXT, "
                "FOREIGN KEY (service_id) REFERENCES health(service_id), "
                "FOREIGN KEY (episode_id) REFERENCES episodes(episode_id))"
            )
            common_columns = [
                "intent_id",
                "service_id",
                "episode_id",
                "frozen_payload",
                "route_key",
                "binding_digest",
                "state",
                "attempt_count",
                "claim_token",
                "channel_id",
                "message_id",
            ]
            columns_sql = ", ".join(common_columns)
            database.execute(
                f"INSERT INTO notification_intents_v1_migration ({columns_sql}) "
                f"SELECT {columns_sql} FROM notification_intents"
            )
            database.execute("DROP TABLE notification_intents")
            database.execute(
                "ALTER TABLE notification_intents_v1_migration "
                "RENAME TO notification_intents"
            )
        else:
            if "claimed_at" not in notification_columns:
                database.execute(
                    "ALTER TABLE notification_intents ADD COLUMN claimed_at TEXT"
                )
            if "claim_expires_at" not in notification_columns:
                database.execute(
                    "ALTER TABLE notification_intents ADD COLUMN claim_expires_at TEXT"
                )
        database.execute(
            "CREATE TABLE IF NOT EXISTS demand_transition_events ("
            "demand_source_id TEXT NOT NULL, event_seq INTEGER NOT NULL CHECK (event_seq > 0), "
            "event_kind TEXT NOT NULL, demand_id TEXT NOT NULL, attempt_id TEXT NOT NULL, "
            "observed_at TEXT NOT NULL, reason_class TEXT, payload_digest TEXT NOT NULL, "
            "PRIMARY KEY (demand_source_id, event_seq))"
        )
        database.execute(
            "CREATE TABLE IF NOT EXISTS demand_attempts ("
            "demand_source_id TEXT NOT NULL, demand_id TEXT NOT NULL, attempt_id TEXT NOT NULL, "
            "state TEXT NOT NULL, first_event_seq INTEGER NOT NULL, last_event_seq INTEGER NOT NULL, "
            "required_at TEXT NOT NULL, terminal_at TEXT, terminal_reason_class TEXT, "
            "PRIMARY KEY (demand_source_id, demand_id, attempt_id))"
        )
        database.execute(
            "CREATE TABLE IF NOT EXISTS startup_events ("
            "startup_attempt_id TEXT PRIMARY KEY, demand_id TEXT NOT NULL, observed_at TEXT NOT NULL, "
            "reason_class TEXT NOT NULL, operation TEXT NOT NULL, payload_digest TEXT NOT NULL, "
            "observation_seq INTEGER NOT NULL)"
        )
        database.execute(
            "CREATE TABLE IF NOT EXISTS session_recovery_proofs ("
            "proof_id TEXT PRIMARY KEY, episode_id TEXT, demand_source_id TEXT NOT NULL, "
            "demand_id TEXT NOT NULL, "
            "predecessor_attempt_id TEXT, successor_attempt_id TEXT NOT NULL, "
            "live_at TEXT NOT NULL, renew_at TEXT NOT NULL, recorded_at TEXT NOT NULL, "
            "proof_kind TEXT NOT NULL, FOREIGN KEY (episode_id) REFERENCES episodes(episode_id))"
        )
        if (
            "session_recovery_proofs" in existing_tables
            and "demand_source_id" not in proof_columns
        ):
            database.execute(
                "ALTER TABLE session_recovery_proofs "
                "ADD COLUMN demand_source_id TEXT"
            )
        database.execute(
            "UPDATE session_recovery_proofs SET demand_source_id = ("
            "SELECT e.demand_source_id FROM episodes e "
            "WHERE e.episode_id = session_recovery_proofs.episode_id) "
            "WHERE demand_source_id IS NULL"
        )
        database.execute(
            "CREATE TABLE IF NOT EXISTS notification_attempts ("
            "ledger_seq INTEGER PRIMARY KEY AUTOINCREMENT, intent_id TEXT NOT NULL, "
            "claim_token TEXT, event_kind TEXT NOT NULL, recorded_at TEXT NOT NULL, "
            "binding_digest TEXT, channel_id TEXT, message_id TEXT, "
            "FOREIGN KEY (intent_id) REFERENCES notification_intents(intent_id))"
        )
        database.commit()
    except sqlite3.Error as error:
        database.rollback()
        raise VoiceHealthError("health_store_unavailable") from error

    final_health_columns = {
        str(row["name"])
        for row in database.execute("PRAGMA table_info(health)").fetchall()
    }
    final_notification_info = database.execute(
        "PRAGMA table_info(notification_intents)"
    ).fetchall()
    final_notification_columns = {str(row["name"]) for row in final_notification_info}
    final_episode_columns = {
        str(row["name"])
        for row in database.execute("PRAGMA table_info(episodes)").fetchall()
    }
    final_proof_columns = {
        str(row["name"])
        for row in database.execute(
            "PRAGMA table_info(session_recovery_proofs)"
        ).fetchall()
    }
    if not set(health_additions).issubset(final_health_columns) or not {
        "claimed_at",
        "claim_expires_at",
    }.issubset(final_notification_columns):
        raise VoiceHealthError("schema_invalid")
    if not set(episode_additions).issubset(final_episode_columns) or (
        "demand_source_id" not in final_proof_columns
    ):
        raise VoiceHealthError("schema_invalid")
    final_tables = {
        str(row["name"])
        for row in database.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    if not added_tables.issubset(final_tables):
        raise VoiceHealthError("schema_invalid")
    if any(
        row["name"] == "binding_digest" and int(row["notnull"]) == 1
        for row in final_notification_info
    ):
        raise VoiceHealthError("schema_invalid")


@contextmanager
def open_store(state_root: Path):
    health_dir, identity_path, database_path = _secure_paths(state_root)
    with _initialization_lock(health_dir):
        host_identity = _load_or_create_host_identity(identity_path)
        service_id = hashlib.sha256(
            canonical_json([host_identity, SERVICE_LABEL]).encode("utf-8")
        ).hexdigest()
        database, storage = _open_database(database_path)
        try:
            _initialize_schema(database)
        except Exception:
            database.close()
            raise
    try:
        yield database, host_identity, service_id, storage
    finally:
        database.close()


def _base_receipt(
    database: sqlite3.Connection,
    host_identity: str,
    service_id: str,
    storage: dict[str, object],
) -> dict[str, object]:
    metadata = database.execute(
        "SELECT schema_version, source_id FROM metadata WHERE singleton = 1"
    ).fetchone()
    return {
        "schemaVersion": int(metadata["schema_version"]),
        "sourceId": str(metadata["source_id"]),
        "hostIdentity": host_identity,
        "serviceId": service_id,
        "serviceLabel": SERVICE_LABEL,
        "storage": storage,
    }


def initialize(state_root: Path) -> dict[str, object]:
    with open_store(state_root) as (database, host_identity, service_id, storage):
        return _base_receipt(database, host_identity, service_id, storage)


def _validated_register_boot(payload: object) -> tuple[str, str]:
    if not isinstance(payload, dict) or set(payload) != {"bootId", "bootAt"}:
        raise VoiceHealthError("invalid_input")
    boot_id = payload.get("bootId")
    boot_at = payload.get("bootAt")
    if not isinstance(boot_id, str) or not isinstance(boot_at, str):
        raise VoiceHealthError("invalid_input")
    try:
        boot_id = str(uuid.UUID(boot_id))
        parsed = datetime.fromisoformat(boot_at.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("timezone required")
    except ValueError as error:
        raise VoiceHealthError("invalid_input") from error
    return boot_id, boot_at


def _parse_timestamp(value: object) -> tuple[str, datetime]:
    if not isinstance(value, str) or len(value) > 40:
        raise VoiceHealthError("invalid_input")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("timezone required")
    except ValueError as error:
        raise VoiceHealthError("invalid_input") from error
    return value, parsed


def _validated_token(value: object) -> str:
    if not isinstance(value, str) or SAFE_TOKEN.fullmatch(value) is None:
        raise VoiceHealthError("invalid_input")
    return value


def _validated_uuid(value: object) -> str:
    if not isinstance(value, str):
        raise VoiceHealthError("invalid_input")
    try:
        return str(uuid.UUID(value))
    except ValueError as error:
        raise VoiceHealthError("invalid_input") from error


def _validated_digest(value: object) -> str:
    if not isinstance(value, str) or HEX_DIGEST.fullmatch(value) is None:
        raise VoiceHealthError("invalid_input")
    return value


def _passive_checkpoint(database: sqlite3.Connection) -> dict[str, int]:
    try:
        busy, log_frames, checkpointed_frames = database.execute(
            "PRAGMA wal_checkpoint(PASSIVE)"
        ).fetchone()
        return {
            "busy": int(busy),
            "logFrames": int(log_frames),
            "checkpointedFrames": int(checkpointed_frames),
        }
    except sqlite3.Error:
        # The transaction is already durable. A contended maintenance checkpoint
        # must never turn a committed producer event into an ambiguous failure.
        return {"busy": 1, "logFrames": -1, "checkpointedFrames": -1}


def _write_transaction(
    database: sqlite3.Connection, operation, *, checkpoint: bool = True
):
    for attempt in range(2):
        try:
            database.execute("BEGIN IMMEDIATE")
            result = operation()
            database.commit()
            result["checkpoint"] = (
                _passive_checkpoint(database) if checkpoint else {"skipped": True}
            )
            return result
        except VoiceHealthError:
            database.rollback()
            raise
        except sqlite3.OperationalError as error:
            database.rollback()
            locked = "locked" in str(error).lower() or "busy" in str(error).lower()
            if locked and attempt == 0:
                time.sleep(0.025)
                continue
            raise VoiceHealthError("health_store_unavailable") from error
        except sqlite3.Error as error:
            database.rollback()
            raise VoiceHealthError("health_store_unavailable") from error
    raise VoiceHealthError("health_store_unavailable")


def _allocate_sequences(database: sqlite3.Connection) -> tuple[str, int, int]:
    metadata = database.execute(
        "SELECT source_id, next_observation_seq, next_change_seq "
        "FROM metadata WHERE singleton = 1"
    ).fetchone()
    observation_seq = int(metadata["next_observation_seq"])
    change_seq = int(metadata["next_change_seq"])
    database.execute(
        "UPDATE metadata SET next_observation_seq = ?, next_change_seq = ? "
        "WHERE singleton = 1",
        (observation_seq + 1, change_seq + 1),
    )
    return str(metadata["source_id"]), observation_seq, change_seq


def _episode_payload(row: sqlite3.Row) -> dict[str, object]:
    return {
        "episodeId": str(row["episode_id"]),
        "scope": str(row["scope"]),
        "demandSourceId": row["demand_source_id"],
        "sourceStatus": str(row["source_status"]),
        "demandId": row["demand_id"],
        "attemptId": row["attempt_id"],
        "openedAt": str(row["opened_at"]),
        "reasonClass": str(row["reason_class"]),
        "threshold": str(row["threshold"]),
        "closedAt": row["closed_at"],
        "closeReason": row["close_reason"],
    }


def _notification_payload(row: sqlite3.Row) -> dict[str, object]:
    return {
        "intentId": str(row["intent_id"]),
        "episodeId": str(row["episode_id"]),
        "routeKey": str(row["route_key"]),
        "bindingDigest": row["binding_digest"],
        "bindingState": "resolved" if row["binding_digest"] else "unresolved",
        "state": str(row["state"]),
        "attemptCount": int(row["attempt_count"]),
        "channelId": row["channel_id"],
        "messageId": row["message_id"],
    }


def _current_projection(
    database: sqlite3.Connection, service_id: str
) -> dict[str, object] | None:
    row = database.execute(
        "SELECT * FROM health WHERE service_id = ?", (service_id,)
    ).fetchone()
    if row is None:
        return None
    try:
        identities = json.loads(str(row["demand_identities_json"]))
    except json.JSONDecodeError as error:
        raise VoiceHealthError("schema_invalid") from error
    open_episodes = database.execute(
        "SELECT * FROM episodes WHERE service_id = ? AND closed_at IS NULL "
        "ORDER BY opened_at, episode_id LIMIT 200",
        (service_id,),
    ).fetchall()
    active_notifications = database.execute(
        "SELECT n.* FROM notification_intents n JOIN episodes e "
        "ON e.episode_id = n.episode_id WHERE n.service_id = ? "
        "AND e.closed_at IS NULL ORDER BY n.intent_id LIMIT 200",
        (service_id,),
    ).fetchall()
    return {
        "serviceId": str(row["service_id"]),
        "serviceLabel": str(row["service_label"]),
        "generation": int(row["generation"]),
        "bootId": row["boot_id"],
        "observationSeq": int(row["observation_seq"]),
        "phase": str(row["phase"]),
        "demandSourceId": row["demand_source_id"],
        "demandRevision": row["demand_revision"],
        "demandState": str(row["demand_state"]),
        "demandDigest": row["demand_digest"],
        "demandObservedAt": row["demand_observed_at"],
        "demandIdentities": identities,
        "demandEventCursor": int(row["demand_event_cursor"]),
        "demandEventHighWater": int(row["demand_event_high_water"]),
        "demandHasMore": bool(row["demand_has_more"]),
        "bootAt": row["boot_at"],
        "lastIterationSuccessAt": row["last_iteration_success_at"],
        "lastProgressAt": row["last_progress_at"],
        "successCount": int(row["success_count"]),
        "progressCount": int(row["progress_count"]),
        "failureCount": int(row["failure_count"]),
        "failureStreak": int(row["failure_streak"]),
        "firstFailureAt": row["first_failure_at"],
        "lastFailureAt": row["last_failure_at"],
        "reasonClass": row["reason_class"],
        "operation": row["operation"],
        "durationMs": row["duration_ms"],
        "pollEpisodeId": row["poll_episode_id"],
        "sessionEpisodeId": row["session_episode_id"],
        "sourceStatus": str(row["source_status"]),
        "openEpisodes": [_episode_payload(episode) for episode in open_episodes],
        "activeNotifications": [
            _notification_payload(notification)
            for notification in active_notifications
        ],
    }


def _insert_change(
    database: sqlite3.Connection,
    source_id: str,
    service_id: str,
    observation_seq: int,
    change_seq: int,
    changed_at: str,
) -> None:
    projection = _current_projection(database, service_id)
    if projection is None:
        raise VoiceHealthError("schema_invalid")
    database.execute(
        "INSERT INTO changes "
        "(source_id, change_seq, service_id, observation_seq, changed_at, projection_json) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            source_id,
            change_seq,
            service_id,
            observation_seq,
            changed_at,
            canonical_json(projection),
        ),
    )


def _append_change(
    database: sqlite3.Connection, service_id: str, changed_at: str
) -> tuple[int, int]:
    source_id, observation_seq, change_seq = _allocate_sequences(database)
    updated = database.execute(
        "UPDATE health SET observation_seq = ? WHERE service_id = ?",
        (observation_seq, service_id),
    )
    if updated.rowcount != 1:
        raise VoiceHealthError("health_not_registered")
    _insert_change(
        database,
        source_id,
        service_id,
        observation_seq,
        change_seq,
        changed_at,
    )
    return observation_seq, change_seq


def _add_base_receipt(
    database: sqlite3.Connection,
    host_identity: str,
    service_id: str,
    storage: dict[str, object],
    result: dict[str, object],
) -> dict[str, object]:
    receipt = _base_receipt(database, host_identity, service_id, storage)
    receipt.update(result)
    return receipt


def register_boot(state_root: Path, payload: object) -> dict[str, object]:
    boot_id, boot_at = _validated_register_boot(payload)
    with open_store(state_root) as (database, host_identity, service_id, storage):
        def operation() -> dict[str, object]:
            current = database.execute(
                "SELECT generation, boot_id, observation_seq FROM health "
                "WHERE service_id = ?",
                (service_id,),
            ).fetchone()
            if current is not None and current["boot_id"] == boot_id:
                change = database.execute(
                    "SELECT change_seq FROM changes WHERE service_id = ? "
                    "AND observation_seq = ?",
                    (service_id, current["observation_seq"]),
                ).fetchone()
                return {
                    "status": "existing",
                    "generation": int(current["generation"]),
                    "observationSeq": int(current["observation_seq"]),
                    "changeSeq": int(change["change_seq"]),
                }

            generation = 1 if current is None else int(current["generation"]) + 1
            source_id, observation_seq, change_seq = _allocate_sequences(database)
            database.execute(
                "INSERT INTO health "
                "(service_id, service_label, generation, boot_id, observation_seq, "
                "phase, boot_at, source_status) "
                "VALUES (?, ?, ?, ?, ?, 'starting', ?, 'available') "
                "ON CONFLICT(service_id) DO UPDATE SET "
                "generation = excluded.generation, boot_id = excluded.boot_id, "
                "observation_seq = excluded.observation_seq, phase = excluded.phase, "
                "boot_at = excluded.boot_at, source_status = excluded.source_status",
                (
                    service_id,
                    SERVICE_LABEL,
                    generation,
                    boot_id,
                    observation_seq,
                    boot_at,
                ),
            )
            _insert_change(
                database,
                source_id,
                service_id,
                observation_seq,
                change_seq,
                boot_at,
            )
            return {
                "status": "registered",
                "generation": generation,
                "observationSeq": observation_seq,
                "changeSeq": change_seq,
            }

        result = _write_transaction(database, operation)
        return _add_base_receipt(
            database, host_identity, service_id, storage, result
        )


def _validated_demand(payload: object) -> dict[str, object]:
    required = {
        "demandSourceId",
        "revision",
        "digest",
        "state",
        "observedAt",
        "identities",
    }
    page_keys = {
        "pageAfterCursor",
        "pageNextCursor",
        "eventHighWater",
        "hasMore",
        "gap",
        "events",
    }
    allowed = required | page_keys | {"refreshObservedAt", "sourceStatus"}
    if (
        not isinstance(payload, dict)
        or not required.issubset(payload)
        or set(payload) - allowed
        or (bool(set(payload) & page_keys) and not page_keys.issubset(payload))
    ):
        raise VoiceHealthError("invalid_input")
    source_id = _validated_uuid(payload["demandSourceId"])
    revision = payload["revision"]
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise VoiceHealthError("invalid_input")
    digest = _validated_digest(payload["digest"])
    state = payload["state"]
    if state not in DEMAND_STATES:
        raise VoiceHealthError("invalid_input")
    observed_at, _ = _parse_timestamp(payload["observedAt"])
    identities = payload["identities"]
    if not isinstance(identities, list) or len(identities) > MAX_DEMAND_IDENTITIES:
        raise VoiceHealthError("invalid_input")
    normalized: list[dict[str, str]] = []
    allowed_keys = {"demandId", "attemptId", "projectId", "meetingId"}
    for identity in identities:
        if (
            not isinstance(identity, dict)
            or "demandId" not in identity
            or not set(identity).issubset(allowed_keys)
        ):
            raise VoiceHealthError("invalid_input")
        normalized.append(
            {key: _validated_token(value) for key, value in sorted(identity.items())}
        )
    if state == "none" and normalized:
        raise VoiceHealthError("invalid_input")
    if state == "required" and not normalized:
        raise VoiceHealthError("invalid_input")
    refresh_observed_at = payload.get("refreshObservedAt", False)
    if not isinstance(refresh_observed_at, bool):
        raise VoiceHealthError("invalid_input")
    # FLY-2693 review R5: the Bridge projects its own fail-closed authority
    # states through instead of dropping them; anything but "available" is
    # published as demand_source_unavailable below.
    source_status = payload.get("sourceStatus", "available")
    if source_status not in DEMAND_SOURCE_STATUSES:
        raise VoiceHealthError("invalid_input")
    if source_status != "available" and (state != "unknown" or normalized):
        raise VoiceHealthError("invalid_input")
    validated: dict[str, object] = {
        "sourceId": source_id,
        "revision": revision,
        "digest": digest,
        "state": state,
        "observedAt": observed_at,
        "identities": normalized,
        "refreshObservedAt": refresh_observed_at,
        "sourceStatus": source_status,
    }
    if page_keys.issubset(payload):
        after_cursor = payload["pageAfterCursor"]
        next_cursor = payload["pageNextCursor"]
        high_water = payload["eventHighWater"]
        has_more = payload["hasMore"]
        gap = payload["gap"]
        events = payload["events"]
        if (
            not isinstance(after_cursor, int)
            or isinstance(after_cursor, bool)
            or after_cursor < 0
            or not isinstance(next_cursor, int)
            or isinstance(next_cursor, bool)
            or next_cursor < after_cursor
            or not isinstance(high_water, int)
            or isinstance(high_water, bool)
            or high_water < next_cursor
            or not isinstance(has_more, bool)
            or not isinstance(gap, bool)
            or not isinstance(events, list)
            or len(events) > MAX_EXPORT_ROWS
            or (has_more and next_cursor >= high_water)
            or (not has_more and next_cursor != high_water)
            or (has_more and state != "unknown")
            or (has_more and normalized)
        ):
            raise VoiceHealthError("invalid_input")
        validated_events: list[dict[str, object]] = []
        expected_seq = after_cursor + 1
        for event in events:
            if not isinstance(event, dict):
                raise VoiceHealthError("invalid_input")
            event_kind = event.get("eventKind")
            expected_keys = {
                "eventSeq",
                "eventKind",
                "demandId",
                "attemptId",
                "observedAt",
            }
            if event_kind == "failed":
                expected_keys.add("reasonClass")
            if set(event) != expected_keys or event_kind not in {
                "required",
                "failed",
                "cancelled",
                "normal_completed",
            }:
                raise VoiceHealthError("invalid_input")
            event_seq = event["eventSeq"]
            if (
                not isinstance(event_seq, int)
                or isinstance(event_seq, bool)
                or event_seq != expected_seq
            ):
                raise VoiceHealthError("demand_change_gap")
            expected_seq += 1
            event_observed_at, _ = _parse_timestamp(event["observedAt"])
            reason_class = event.get("reasonClass")
            if event_kind == "failed" and reason_class not in REASON_CLASSES:
                raise VoiceHealthError("invalid_input")
            validated_events.append(
                {
                    "eventSeq": event_seq,
                    "eventKind": event_kind,
                    "demandId": _validated_token(event["demandId"]),
                    "attemptId": _validated_token(event["attemptId"]),
                    "observedAt": event_observed_at,
                    "reasonClass": reason_class,
                }
            )
        if events and validated_events[-1]["eventSeq"] != next_cursor:
            raise VoiceHealthError("demand_change_gap")
        if not events and next_cursor != after_cursor:
            raise VoiceHealthError("demand_change_gap")
        validated["page"] = {
            "afterCursor": after_cursor,
            "nextCursor": next_cursor,
            "highWater": high_water,
            "hasMore": has_more,
            "gap": gap,
            "events": validated_events,
        }
    return validated


def _restore_demand_marker(
    database: sqlite3.Connection, service_id: str, current: sqlite3.Row
) -> bool:
    """Keep a fail-closed demand marker across daemon-side writes.

    FLY-2693 review R5: every record_result/evaluate branch stamps
    source_status='available' because the daemon is reporting; that must not
    erase record_demand's demand_source_unavailable marker, which only an
    authoritative available snapshot may clear.
    """
    if (
        current["source_status"] != "unavailable"
        or current["demand_state"] != "unknown"
    ):
        return False
    database.execute(
        "UPDATE health SET source_status = 'unavailable' WHERE service_id = ?",
        (service_id,),
    )
    return True


def record_demand(state_root: Path, payload: object) -> dict[str, object]:
    demand = _validated_demand(payload)
    with open_store(state_root) as (database, host_identity, service_id, storage):
        def operation() -> dict[str, object]:
            current = database.execute(
                "SELECT * FROM health WHERE service_id = ?",
                (service_id,),
            ).fetchone()
            if current is None:
                database.execute(
                    "INSERT INTO health "
                    "(service_id, service_label, generation, observation_seq, phase, "
                    "source_status) VALUES (?, ?, 0, 0, 'dormant', 'available')",
                    (service_id, SERVICE_LABEL),
                )
                current = database.execute(
                    "SELECT * FROM health WHERE service_id = ?", (service_id,)
                ).fetchone()

            if demand["sourceStatus"] != "available":
                # Fail-closed Bridge authority: publish unknown/unavailable while
                # keeping the last authoritative source, cursor and digest so a
                # later available snapshot restores demand from where it left off.
                if (
                    current["source_status"] != "unavailable"
                    or current["demand_state"] != "unknown"
                ):
                    database.execute(
                        "UPDATE health SET demand_state = 'unknown', "
                        "source_status = 'unavailable', "
                        "reason_class = 'demand_source_unavailable', "
                        "operation = 'demand_snapshot' WHERE service_id = ?",
                        (service_id,),
                    )
                    _append_change(database, service_id, str(demand["observedAt"]))
                # A deliberate fail-closed snapshot is a complete, successful
                # record: the Bridge has nothing to retry, so this is not the
                # digest-mismatch "publish then reject" path below.
                return {
                    "status": "recorded",
                    "sourceStatus": "unavailable",
                    "demandState": "unknown",
                    "failClosedSourceStatus": demand["sourceStatus"],
                }
            current_source = current["demand_source_id"]
            current_revision = current["demand_revision"]
            page = demand.get("page")
            source_rotated = False
            if current_source is not None and current_source != demand["sourceId"]:
                explicit_unknown_rebase = (
                    demand["revision"] == 0 and demand["state"] == "unknown"
                )
                authoritative_rebase = (
                    page is not None
                    and int(page["afterCursor"]) == 0
                    and not bool(page["gap"])
                )
                if not explicit_unknown_rebase and not authoritative_rebase:
                    raise VoiceHealthError("demand_source_mismatch")
                current_revision = None
                source_rotated = True
            incomplete_page = page is not None and bool(page["hasMore"])
            # Final snapshots bind revision to digest even when no new events
            # arrive, or a Bridge restart replays an already-consumed page.
            if (
                current_revision is not None
                and int(demand["revision"]) == int(current_revision)
                and not incomplete_page
                and current["demand_digest"] != demand["digest"]
            ):
                if current["source_status"] != "unavailable" or current["demand_state"] != "unknown":
                    database.execute(
                        "UPDATE health SET demand_state = 'unknown', "
                        "source_status = 'unavailable', reason_class = 'demand_source_unavailable', "
                        "operation = 'demand_snapshot' WHERE service_id = ?",
                        (service_id,),
                    )
                    _append_change(database, service_id, str(demand["observedAt"]))
                return {"status": "source_unavailable"}
            current_cursor = 0 if source_rotated else int(current["demand_event_cursor"])
            if page is not None:
                if page["gap"]:
                    raise VoiceHealthError("demand_change_gap")
                if int(page["afterCursor"]) < current_cursor:
                    replayed_through = min(
                        int(page["nextCursor"]), current_cursor
                    )
                    replayed_events = [
                        event
                        for event in page["events"]
                        if int(event["eventSeq"]) <= replayed_through
                    ]
                    replayed_rows = database.execute(
                        "SELECT event_seq, payload_digest FROM demand_transition_events "
                        "WHERE demand_source_id = ? AND event_seq > ? AND event_seq <= ? "
                        "ORDER BY event_seq",
                        (
                            demand["sourceId"],
                            page["afterCursor"],
                            replayed_through,
                        ),
                    ).fetchall()
                    if len(replayed_rows) != len(replayed_events):
                        raise VoiceHealthError("demand_event_mismatch")
                    prior_seq = int(page["afterCursor"])
                    for stored, replayed in zip(
                        replayed_rows, replayed_events, strict=True
                    ):
                        expected_seq = prior_seq + 1
                        replayed_digest = hashlib.sha256(
                            canonical_json(replayed).encode("utf-8")
                        ).hexdigest()
                        if (
                            int(stored["event_seq"]) != expected_seq
                            or int(replayed["eventSeq"]) != expected_seq
                            or stored["payload_digest"] != replayed_digest
                        ):
                            raise VoiceHealthError("demand_event_mismatch")
                        prior_seq = expected_seq
                    if prior_seq != replayed_through:
                        raise VoiceHealthError("demand_event_mismatch")
                    restores_authority = (
                        current["source_status"] == "unavailable"
                        and not incomplete_page
                        and int(page["nextCursor"]) == current_cursor
                    )
                    if int(page["nextCursor"]) <= current_cursor and not restores_authority:
                        return {
                            "status": "stale",
                            "observationSeq": int(current["observation_seq"]),
                            "demandRevision": current_revision,
                            "demandEventCursor": current_cursor,
                        }
                    page = {
                        **page,
                        "afterCursor": current_cursor,
                        "events": [
                            event
                            for event in page["events"]
                            if int(event["eventSeq"]) > current_cursor
                        ],
                    }
                if int(page["afterCursor"]) != current_cursor:
                    raise VoiceHealthError("demand_change_gap")
                if (
                    not source_rotated
                    and int(page["highWater"])
                    < int(current["demand_event_high_water"])
                ):
                    raise VoiceHealthError("demand_source_mismatch")
            if current_revision is not None and int(demand["revision"]) < int(
                current_revision
            ):
                return {
                    "status": "stale",
                    "observationSeq": int(current["observation_seq"]),
                    "demandRevision": int(current_revision),
                    "demandEventCursor": current_cursor,
                }
            if current_revision is not None and not incomplete_page:
                if int(demand["revision"]) == int(current_revision):
                    state_transition = (
                        current["demand_state"] == "unknown"
                        and demand["state"] in {"required", "none"}
                    )
                    page_advances = page is not None and int(
                        page["nextCursor"]
                    ) > current_cursor
                    if not state_transition and not page_advances:
                        if demand["refreshObservedAt"]:
                            database.execute(
                                "UPDATE health SET demand_observed_at = ? "
                                "WHERE service_id = ?",
                                (demand["observedAt"], service_id),
                            )
                            observation_seq, change_seq = _append_change(
                                database, service_id, str(demand["observedAt"])
                            )
                            return {
                                "status": "refreshed",
                                "observationSeq": observation_seq,
                                "changeSeq": change_seq,
                                "demandRevision": int(current_revision),
                                "demandState": str(current["demand_state"]),
                            }
                        return {
                            "status": "existing",
                            "observationSeq": int(current["observation_seq"]),
                            "demandRevision": int(current_revision),
                            "demandState": str(current["demand_state"]),
                        }

            opened_episode = None
            opened_notification = None
            closing_attempts: list[tuple[str, str]] = []
            if page is not None:
                for event in page["events"]:
                    event_digest = hashlib.sha256(
                        canonical_json(event).encode("utf-8")
                    ).hexdigest()
                    database.execute(
                        "INSERT INTO demand_transition_events "
                        "(demand_source_id, event_seq, event_kind, demand_id, "
                        "attempt_id, observed_at, reason_class, payload_digest) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            demand["sourceId"],
                            event["eventSeq"],
                            event["eventKind"],
                            event["demandId"],
                            event["attemptId"],
                            event["observedAt"],
                            event["reasonClass"],
                            event_digest,
                        ),
                    )
                    attempt = database.execute(
                        "SELECT * FROM demand_attempts WHERE demand_source_id = ? "
                        "AND demand_id = ? AND attempt_id = ?",
                        (
                            demand["sourceId"],
                            event["demandId"],
                            event["attemptId"],
                        ),
                    ).fetchone()
                    if event["eventKind"] == "required":
                        if attempt is None:
                            database.execute(
                                "INSERT INTO demand_attempts "
                                "(demand_source_id, demand_id, attempt_id, state, "
                                "first_event_seq, last_event_seq, required_at) "
                                "VALUES (?, ?, ?, 'required', ?, ?, ?)",
                                (
                                    demand["sourceId"],
                                    event["demandId"],
                                    event["attemptId"],
                                    event["eventSeq"],
                                    event["eventSeq"],
                                    event["observedAt"],
                                ),
                            )
                        elif attempt["state"] == "required":
                            database.execute(
                                "UPDATE demand_attempts SET last_event_seq = ? "
                                "WHERE demand_source_id = ? AND demand_id = ? "
                                "AND attempt_id = ?",
                                (
                                    event["eventSeq"],
                                    demand["sourceId"],
                                    event["demandId"],
                                    event["attemptId"],
                                ),
                            )
                        elif attempt["state"] in {"failed", "recovered"}:
                            # Bridge state transitions can arrive after an elapsed
                            # startup guard or daemon proof. They are authoritative
                            # cursor history, but only a live+renew proof may recover
                            # the latched failure.
                            database.execute(
                                "UPDATE demand_attempts SET first_event_seq = CASE "
                                "WHEN first_event_seq = 0 THEN ? ELSE first_event_seq END, "
                                "last_event_seq = ? WHERE demand_source_id = ? "
                                "AND demand_id = ? AND attempt_id = ?",
                                (
                                    event["eventSeq"],
                                    event["eventSeq"],
                                    demand["sourceId"],
                                    event["demandId"],
                                    event["attemptId"],
                                ),
                            )
                        else:
                            database.execute(
                                "UPDATE demand_attempts SET last_event_seq = ? "
                                "WHERE demand_source_id = ? AND demand_id = ? "
                                "AND attempt_id = ?",
                                (
                                    event["eventSeq"],
                                    demand["sourceId"],
                                    event["demandId"],
                                    event["attemptId"],
                                ),
                            )
                    elif event["eventKind"] == "failed":
                        recovered_then_failed = (
                            attempt is not None
                            and attempt["state"] == "recovered"
                            and (
                                attempt["terminal_at"] is None
                                or str(event["observedAt"])
                                > str(attempt["terminal_at"])
                            )
                        )
                        records_new_failure = (
                            attempt is None
                            or attempt["state"] == "required"
                            or recovered_then_failed
                        )
                        if attempt is None:
                            database.execute(
                                "INSERT INTO demand_attempts "
                                "(demand_source_id, demand_id, attempt_id, state, "
                                "first_event_seq, last_event_seq, required_at, terminal_at, "
                                "terminal_reason_class) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?)",
                                (
                                    demand["sourceId"],
                                    event["demandId"],
                                    event["attemptId"],
                                    event["eventSeq"],
                                    event["eventSeq"],
                                    event["observedAt"],
                                    event["observedAt"],
                                    event["reasonClass"],
                                ),
                            )
                        elif attempt["state"] in {"required", "failed"} or recovered_then_failed:
                            # A delayed Bridge event must not weaken a newer
                            # daemon failure's recovery boundary.
                            preserve_terminal = (
                                attempt["state"] == "failed"
                                and attempt["terminal_at"] is not None
                                and str(attempt["terminal_at"]) > str(event["observedAt"])
                            )
                            database.execute(
                                "UPDATE demand_attempts SET state = 'failed', "
                                "last_event_seq = ?, terminal_at = ?, "
                                "terminal_reason_class = ? WHERE demand_source_id = ? "
                                "AND demand_id = ? AND attempt_id = ?",
                                (
                                    event["eventSeq"],
                                    attempt["terminal_at"] if preserve_terminal else event["observedAt"],
                                    attempt["terminal_reason_class"] if preserve_terminal else event["reasonClass"],
                                    demand["sourceId"],
                                    event["demandId"],
                                    event["attemptId"],
                                ),
                            )
                        elif attempt["state"] == "recovered":
                            database.execute(
                                "UPDATE demand_attempts SET last_event_seq = ? "
                                "WHERE demand_source_id = ? AND demand_id = ? "
                                "AND attempt_id = ?",
                                (
                                    event["eventSeq"],
                                    demand["sourceId"],
                                    event["demandId"],
                                    event["attemptId"],
                                ),
                            )
                        else:
                            database.execute(
                                "UPDATE demand_attempts SET last_event_seq = ? "
                                "WHERE demand_source_id = ? AND demand_id = ? "
                                "AND attempt_id = ?",
                                (
                                    event["eventSeq"],
                                    demand["sourceId"],
                                    event["demandId"],
                                    event["attemptId"],
                                ),
                            )
                        if records_new_failure:
                            database.execute(
                                "UPDATE health SET phase = 'session_failed', "
                                "failure_count = failure_count + 1, last_failure_at = ?, "
                                "reason_class = ?, operation = 'session_create' "
                                "WHERE service_id = ?",
                                (event["observedAt"], event["reasonClass"], service_id),
                            )
                            opened_episode, opened_notification = _open_episode(
                                database,
                                service_id,
                                "session_unavailable",
                                str(event["observedAt"]),
                                str(event["reasonClass"]),
                                "terminal_session_failure",
                                str(event["demandId"]),
                                str(event["attemptId"]),
                                str(demand["sourceId"]),
                            )
                    else:
                        if attempt is None:
                            database.execute(
                                "INSERT INTO demand_attempts "
                                "(demand_source_id, demand_id, attempt_id, state, "
                                "first_event_seq, last_event_seq, required_at, terminal_at) "
                                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                (
                                    demand["sourceId"],
                                    event["demandId"],
                                    event["attemptId"],
                                    event["eventKind"],
                                    event["eventSeq"],
                                    event["eventSeq"],
                                    event["observedAt"],
                                    event["observedAt"],
                                ),
                            )
                        elif attempt["state"] in {
                            "required",
                            "failed",
                            "recovered",
                            event["eventKind"],
                        }:
                            database.execute(
                                "UPDATE demand_attempts SET state = ?, last_event_seq = ?, "
                                "terminal_at = ?, terminal_reason_class = NULL "
                                "WHERE demand_source_id = ? AND demand_id = ? AND attempt_id = ?",
                                (
                                    event["eventKind"],
                                    event["eventSeq"],
                                    event["observedAt"],
                                    demand["sourceId"],
                                    event["demandId"],
                                    event["attemptId"],
                                ),
                            )
                        else:
                            database.execute(
                                "UPDATE demand_attempts SET last_event_seq = ? "
                                "WHERE demand_source_id = ? AND demand_id = ? "
                                "AND attempt_id = ?",
                                (
                                    event["eventSeq"],
                                    demand["sourceId"],
                                    event["demandId"],
                                    event["attemptId"],
                                ),
                            )
                        closing_attempts.append(
                            (str(event["demandId"]), str(event["attemptId"]))
                        )

            snapshot_revision = (
                current_revision if incomplete_page else demand["revision"]
            )
            snapshot_state = (
                "unknown" if incomplete_page else demand["state"]
            )
            snapshot_digest = (
                current["demand_digest"] if incomplete_page else demand["digest"]
            )
            snapshot_identities = (
                str(current["demand_identities_json"])
                if incomplete_page
                else canonical_json(demand["identities"])
            )
            snapshot_observed_at = (
                current["demand_observed_at"]
                if incomplete_page
                else demand["observedAt"]
            )
            if source_rotated and incomplete_page:
                # No prior source snapshot is authority for this source's
                # unfinished page stream, including its revision high-water.
                snapshot_digest = None
                snapshot_identities = "[]"
                snapshot_observed_at = None
            if source_rotated:
                database.execute(
                    "UPDATE episodes SET source_status = 'unverified' "
                    "WHERE service_id = ? AND scope = 'session_unavailable' "
                    "AND closed_at IS NULL AND demand_source_id IS NOT NULL "
                    "AND demand_source_id != ?",
                    (service_id, demand["sourceId"]),
                )
            database.execute(
                "UPDATE health SET demand_source_id = ?, demand_revision = ?, "
                "demand_state = ?, demand_digest = ?, demand_observed_at = ?, "
                "demand_identities_json = ?, demand_event_cursor = ?, "
                "demand_event_high_water = ?, demand_has_more = ?, "
                "source_status = 'available', "
                "reason_class = CASE WHEN reason_class = 'demand_source_unavailable' "
                "AND operation = 'demand_snapshot' THEN NULL ELSE reason_class END, "
                "operation = CASE WHEN reason_class = 'demand_source_unavailable' "
                "AND operation = 'demand_snapshot' THEN NULL ELSE operation END "
                "WHERE service_id = ?",
                (
                    demand["sourceId"],
                    snapshot_revision,
                    snapshot_state,
                    snapshot_digest,
                    snapshot_observed_at,
                    snapshot_identities,
                    int(page["nextCursor"]) if page is not None else current_cursor,
                    int(page["highWater"])
                    if page is not None
                    else (
                        0
                        if source_rotated
                        else int(current["demand_event_high_water"])
                    ),
                    1 if page is not None and page["hasMore"] else 0,
                    service_id,
                ),
            )
            observation_seq, change_seq = _append_change(
                database, service_id, str(demand["observedAt"])
            )
            closed_episode_id = None
            for demand_id, attempt_id in closing_attempts:
                closed = _close_session_attempt(
                    database,
                    service_id,
                    str(demand["sourceId"]),
                    demand_id,
                    attempt_id,
                    str(demand["observedAt"]),
                    observation_seq,
                    "closed_not_required",
                )
                closed_episode_id = closed_episode_id or closed
            if closing_attempts:
                source_id = database.execute(
                    "SELECT source_id FROM metadata WHERE singleton = 1"
                ).fetchone()["source_id"]
                database.execute(
                    "UPDATE changes SET projection_json = ? WHERE source_id = ? "
                    "AND change_seq = ?",
                    (
                        canonical_json(_current_projection(database, service_id)),
                        source_id,
                        change_seq,
                    ),
                )
            response: dict[str, object] = {
                "status": "recorded",
                "observationSeq": observation_seq,
                "changeSeq": change_seq,
                "demandRevision": snapshot_revision,
                "demandState": snapshot_state,
                "demandEventCursor": int(page["nextCursor"])
                if page is not None
                else current_cursor,
            }
            if opened_episode is not None:
                response["episode"] = _episode_payload(opened_episode)
            if opened_notification is not None:
                response["notification"] = _notification_payload(opened_notification)
            if closed_episode_id is not None:
                response["closedEpisodeId"] = closed_episode_id
            return response

        result = _write_transaction(database, operation)
        if result["status"] == "source_unavailable":
            # Publish the fail-closed projection durably before rejecting the
            # invalid snapshot; raising inside the transaction would erase it.
            raise VoiceHealthError("demand_source_mismatch")
        return _add_base_receipt(
            database, host_identity, service_id, storage, result
        )


def record_startup(state_root: Path, payload: object) -> dict[str, object]:
    expected = {
        "startupAttemptId",
        "demandId",
        "observedAt",
        "reasonClass",
        "operation",
    }
    if not isinstance(payload, dict) or set(payload) != expected:
        raise VoiceHealthError("invalid_input")
    startup_attempt_id = _validated_uuid(payload["startupAttemptId"])
    demand_id = _validated_token(payload["demandId"])
    observed_at, _ = _parse_timestamp(payload["observedAt"])
    reason_class = payload["reasonClass"]
    if reason_class not in {
        "startup_config_invalid",
        "startup_lock_unavailable",
        "startup_not_ready",
        "health_observation_unavailable",
    } or payload["operation"] != "startup":
        raise VoiceHealthError("invalid_input")
    normalized = {
        "startupAttemptId": startup_attempt_id,
        "observedAt": observed_at,
        "reasonClass": reason_class,
        "operation": "startup",
    }
    payload_digest = hashlib.sha256(
        canonical_json(normalized).encode("utf-8")
    ).hexdigest()
    with open_store(state_root) as (database, host_identity, service_id, storage):
        def operation() -> dict[str, object]:
            duplicate = database.execute(
                "SELECT payload_digest, observation_seq, demand_id, observed_at, "
                "reason_class, operation FROM startup_events "
                "WHERE startup_attempt_id = ?",
                (startup_attempt_id,),
            ).fetchone()
            if duplicate is not None:
                if duplicate["payload_digest"] != payload_digest:
                    stored_event = {
                        "startupAttemptId": startup_attempt_id,
                        "observedAt": duplicate["observed_at"],
                        "reasonClass": duplicate["reason_class"],
                        "operation": duplicate["operation"],
                    }
                    legacy_digest = hashlib.sha256(canonical_json({
                        **stored_event, "demandId": duplicate["demand_id"],
                    }).encode("utf-8")).hexdigest()
                    if stored_event != normalized or duplicate["payload_digest"] != legacy_digest:
                        raise VoiceHealthError("startup_event_mismatch")
                    database.execute(
                        "UPDATE startup_events SET payload_digest = ? WHERE startup_attempt_id = ?",
                        (payload_digest, startup_attempt_id),
                    )
                return {
                    "status": "duplicate",
                    "startupAttemptId": startup_attempt_id,
                    "observationSeq": int(duplicate["observation_seq"]),
                }
            current = database.execute(
                "SELECT * FROM health WHERE service_id = ?", (service_id,)
            ).fetchone()
            if current is None:
                database.execute(
                    "INSERT INTO health "
                    "(service_id, service_label, generation, observation_seq, phase, "
                    "source_status) VALUES (?, ?, 0, 0, 'dormant', 'available')",
                    (service_id, SERVICE_LABEL),
                )
                current = database.execute(
                    "SELECT * FROM health WHERE service_id = ?", (service_id,)
                ).fetchone()
            database.execute(
                "UPDATE health SET phase = 'startup_failed', "
                "failure_count = failure_count + 1, last_failure_at = ?, "
                "reason_class = ?, operation = 'startup' WHERE service_id = ?",
                (observed_at, reason_class, service_id),
            )
            episode = None
            notification = None
            demand_source = current["demand_source_id"]
            try:
                current_identities = json.loads(
                    str(current["demand_identities_json"])
                )
            except json.JSONDecodeError as error:
                raise VoiceHealthError("schema_invalid") from error
            latched_demand = None
            if demand_source is not None:
                latched_demand = database.execute(
                    "SELECT 1 FROM demand_attempts WHERE demand_source_id = ? "
                    "AND demand_id = ? AND state IN ('required', 'failed') LIMIT 1",
                    (demand_source, demand_id),
                ).fetchone()
            demand_matches = any(
                identity.get("demandId") == demand_id
                for identity in current_identities
                if isinstance(identity, dict)
            ) or latched_demand is not None
            if current["demand_state"] == "required" and demand_matches:
                if demand_source is None:
                    raise VoiceHealthError("demand_source_unavailable")
                database.execute(
                    "INSERT INTO demand_attempts "
                    "(demand_source_id, demand_id, attempt_id, state, first_event_seq, "
                    "last_event_seq, required_at, terminal_at, terminal_reason_class) "
                    "VALUES (?, ?, ?, 'failed', 0, 0, ?, ?, ?) "
                    "ON CONFLICT(demand_source_id, demand_id, attempt_id) DO UPDATE SET "
                    "state = 'failed', terminal_at = excluded.terminal_at, "
                    "terminal_reason_class = excluded.terminal_reason_class",
                    (
                        demand_source,
                        demand_id,
                        startup_attempt_id,
                        observed_at,
                        observed_at,
                        reason_class,
                    ),
                )
                episode, notification = _open_episode(
                    database,
                    service_id,
                    "session_unavailable",
                    observed_at,
                    str(reason_class),
                    "startup_failure",
                    demand_id,
                    startup_attempt_id,
                    str(demand_source),
                )
            observation_seq, change_seq = _append_change(
                database, service_id, observed_at
            )
            database.execute(
                "INSERT INTO startup_events "
                "(startup_attempt_id, demand_id, observed_at, reason_class, operation, "
                "payload_digest, observation_seq) VALUES (?, ?, ?, ?, 'startup', ?, ?)",
                (
                    startup_attempt_id,
                    demand_id,
                    observed_at,
                    reason_class,
                    payload_digest,
                    observation_seq,
                ),
            )
            response: dict[str, object] = {
                "status": "recorded",
                "startupAttemptId": startup_attempt_id,
                "observationSeq": observation_seq,
                "changeSeq": change_seq,
            }
            if episode is not None:
                response["episode"] = _episode_payload(episode)
            if notification is not None:
                response["notification"] = _notification_payload(notification)
            return response

        result = _write_transaction(database, operation)
        return _add_base_receipt(
            database, host_identity, service_id, storage, result
        )


def evaluate_health(state_root: Path, payload: object) -> dict[str, object]:
    if not isinstance(payload, dict) or set(payload) != {"observedAt"}:
        raise VoiceHealthError("invalid_input")
    observed_at, observed_datetime = _parse_timestamp(payload["observedAt"])
    with open_store(state_root) as (database, host_identity, service_id, storage):
        def operation() -> dict[str, object]:
            current = database.execute(
                "SELECT * FROM health WHERE service_id = ?", (service_id,)
            ).fetchone()
            if current is None:
                return {"status": "no_action", "failureCount": 0, "failureStreak": 0}
            response: dict[str, object] = {
                "status": "no_action",
                "failureCount": int(current["failure_count"]),
                "failureStreak": int(current["failure_streak"]),
            }
            if current["demand_state"] != "required":
                return response

            reason_class: str
            threshold = "first_failure_60s"
            operation_name: str | None = None
            phase = str(current["phase"])
            if (
                phase == "failed_retrying"
                and int(current["failure_streak"]) >= 1
                and current["first_failure_at"] is not None
            ):
                reason_class = str(current["reason_class"] or "unknown_failure")
                _, threshold_start = _parse_timestamp(current["first_failure_at"])
                if current["last_progress_at"] is not None:
                    _, last_progress = _parse_timestamp(current["last_progress_at"])
                    if last_progress > threshold_start:
                        return response
            elif phase == "idle" and current["last_iteration_success_at"] is not None:
                reason_class = "heartbeat_stale"
                operation_name = "desired"
                _, threshold_start = _parse_timestamp(
                    current["last_iteration_success_at"]
                )
            elif phase == "active" and current["last_progress_at"] is not None:
                reason_class = "heartbeat_stale"
                operation_name = "renew"
                _, threshold_start = _parse_timestamp(current["last_progress_at"])
            else:
                return response

            if (observed_datetime - threshold_start).total_seconds() < 60:
                return response
            existing = database.execute(
                "SELECT * FROM episodes WHERE service_id = ? "
                "AND scope = 'poll_dependency' AND closed_at IS NULL",
                (service_id,),
            ).fetchone()
            if existing is not None:
                response["status"] = "existing"
                response["episode"] = _episode_payload(existing)
                return response
            if reason_class == "heartbeat_stale":
                database.execute(
                    "UPDATE health SET phase = 'failed_retrying', "
                    "last_failure_at = ?, reason_class = 'heartbeat_stale', "
                    "operation = ?, duration_ms = NULL, source_status = 'available' "
                    "WHERE service_id = ?",
                    (observed_at, operation_name, service_id),
                )
                _restore_demand_marker(database, service_id, current)
            episode, notification = _open_episode(
                database,
                service_id,
                "poll_dependency",
                observed_at,
                reason_class,
                threshold,
                None,
                None,
                None,
            )
            observation_seq, change_seq = _append_change(
                database, service_id, observed_at
            )
            response.update(
                {
                    "status": "recorded",
                    "observationSeq": observation_seq,
                    "changeSeq": change_seq,
                    "episode": _episode_payload(episode),
                    "notification": _notification_payload(notification),
                }
            )
            return response

        result = _write_transaction(database, operation, checkpoint=False)
        return _add_base_receipt(
            database, host_identity, service_id, storage, result
        )


def _validated_result(payload: object) -> dict[str, object]:
    allowed = {
        "generation",
        "producerEventSeq",
        "resultKind",
        "observedAt",
        "durationMs",
        "reasonClass",
        "operation",
        "demandId",
        "attemptId",
        "successorAttemptId",
        "liveAt",
        "renewAt",
        "countDelta",
    }
    if not isinstance(payload, dict) or not set(payload).issubset(allowed):
        raise VoiceHealthError("invalid_input")
    required = {"generation", "producerEventSeq", "resultKind", "observedAt"}
    if not required.issubset(payload):
        raise VoiceHealthError("invalid_input")
    generation = payload["generation"]
    event_seq = payload["producerEventSeq"]
    if (
        not isinstance(generation, int)
        or isinstance(generation, bool)
        or generation <= 0
        or not isinstance(event_seq, int)
        or isinstance(event_seq, bool)
        or event_seq <= 0
    ):
        raise VoiceHealthError("invalid_input")
    kind = payload["resultKind"]
    if kind not in RESULT_KINDS:
        raise VoiceHealthError("invalid_input")
    observed_at, observed_datetime = _parse_timestamp(payload["observedAt"])
    duration_ms = payload.get("durationMs")
    if duration_ms is not None and (
        not isinstance(duration_ms, int)
        or isinstance(duration_ms, bool)
        or duration_ms < 0
        or duration_ms > 86_400_000
    ):
        raise VoiceHealthError("invalid_input")
    count_delta = payload.get("countDelta", 1)
    if (
        not isinstance(count_delta, int)
        or isinstance(count_delta, bool)
        or count_delta < 1
        or count_delta > 1_000_000
        or ("countDelta" in payload and kind not in {"idle_success", "progress"})
    ):
        raise VoiceHealthError("invalid_input")

    reason_class = payload.get("reasonClass")
    operation = payload.get("operation")
    if kind in {"poll_failed", "session_failed"}:
        if reason_class not in REASON_CLASSES or operation not in OPERATIONS:
            raise VoiceHealthError("invalid_input")
    elif reason_class is not None or operation is not None:
        raise VoiceHealthError("invalid_input")

    demand_id = payload.get("demandId")
    attempt_id = payload.get("attemptId")
    if demand_id is not None:
        demand_id = _validated_token(demand_id)
    if attempt_id is not None:
        attempt_id = _validated_token(attempt_id)
    if demand_id is not None and kind not in {
        "session_failed",
        "session_recovered",
        "session_ended",
        "closed_not_required",
    }:
        raise VoiceHealthError("invalid_input")
    if attempt_id is not None and kind not in {
        "session_failed",
        "closed_not_required",
    }:
        raise VoiceHealthError("invalid_input")
    if kind in {
        "session_failed",
        "session_recovered",
        "session_ended",
        "closed_not_required",
    } and demand_id is None:
        raise VoiceHealthError("invalid_input")
    if kind == "session_failed" and attempt_id is None:
        raise VoiceHealthError("invalid_input")

    successor_attempt_id = payload.get("successorAttemptId")
    live_at = payload.get("liveAt")
    renew_at = payload.get("renewAt")
    if kind in {"session_recovered", "session_ended"}:
        successor_attempt_id = _validated_token(successor_attempt_id)
        live_at, live_datetime = _parse_timestamp(live_at)
        renew_at, renew_datetime = _parse_timestamp(renew_at)
        if renew_datetime <= live_datetime or observed_datetime < renew_datetime:
            raise VoiceHealthError("invalid_recovery_proof")
    elif any(value is not None for value in (successor_attempt_id, live_at, renew_at)):
        raise VoiceHealthError("invalid_input")

    normalized = dict(payload)
    normalized["observedAt"] = observed_at
    normalized["observedDatetime"] = observed_datetime
    normalized["demandId"] = demand_id
    normalized["attemptId"] = attempt_id
    normalized["successorAttemptId"] = successor_attempt_id
    normalized["liveAt"] = live_at
    normalized["renewAt"] = renew_at
    normalized["countDelta"] = count_delta
    return normalized


def _open_episode(
    database: sqlite3.Connection,
    service_id: str,
    scope: str,
    opened_at: str,
    reason_class: str,
    threshold: str,
    demand_id: str | None,
    attempt_id: str | None,
    demand_source_id: str | None,
) -> tuple[sqlite3.Row, sqlite3.Row]:
    if scope == "poll_dependency":
        existing = database.execute(
            "SELECT * FROM episodes WHERE service_id = ? AND scope = ? "
            "AND closed_at IS NULL ORDER BY opened_at LIMIT 1",
            (service_id, scope),
        ).fetchone()
    else:
        existing = database.execute(
            "SELECT * FROM episodes WHERE service_id = ? AND scope = ? "
            "AND demand_source_id = ? AND demand_id = ? AND closed_at IS NULL "
            "ORDER BY opened_at LIMIT 1",
            (service_id, scope, demand_source_id, demand_id),
        ).fetchone()
    if existing is not None:
        notification = database.execute(
            "SELECT * FROM notification_intents WHERE episode_id = ?",
            (existing["episode_id"],),
        ).fetchone()
        return existing, notification

    episode_id = str(uuid.uuid4())
    database.execute(
        "INSERT INTO episodes "
        "(episode_id, service_id, scope, demand_source_id, source_status, "
        "demand_id, attempt_id, opened_at, reason_class, threshold) "
        "VALUES (?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?)",
        (
            episode_id,
            service_id,
            scope,
            demand_source_id,
            demand_id,
            attempt_id,
            opened_at,
            reason_class,
            threshold,
        ),
    )
    pointer = "poll_episode_id" if scope == "poll_dependency" else "session_episode_id"
    database.execute(
        f"UPDATE health SET {pointer} = ? WHERE service_id = ?",
        (episode_id, service_id),
    )
    route_key = "primary"
    intent_id = hashlib.sha256(
        canonical_json([service_id, episode_id, route_key]).encode("utf-8")
    ).hexdigest()
    frozen_payload = canonical_json(
        {
            "episodeId": episode_id,
            "kind": "voice_daemon_unhealthy",
            "openedAt": opened_at,
            "operation": database.execute(
                "SELECT operation FROM health WHERE service_id = ?", (service_id,)
            ).fetchone()["operation"],
            "reasonClass": reason_class,
            "scope": scope,
            "serviceId": service_id,
            **({"demandId": demand_id} if demand_id else {}),
            **({"attemptId": attempt_id} if attempt_id else {}),
        }
    )
    database.execute(
        "INSERT INTO notification_intents "
        "(intent_id, service_id, episode_id, frozen_payload, route_key, "
        "binding_digest, state) VALUES (?, ?, ?, ?, ?, NULL, 'pending')",
        (intent_id, service_id, episode_id, frozen_payload, route_key),
    )
    episode = database.execute(
        "SELECT * FROM episodes WHERE episode_id = ?", (episode_id,)
    ).fetchone()
    notification = database.execute(
        "SELECT * FROM notification_intents WHERE intent_id = ?", (intent_id,)
    ).fetchone()
    return episode, notification


def _cancel_unsent_notification(
    database: sqlite3.Connection, episode_id: str, recorded_at: str
) -> None:
    placeholders = ",".join("?" for _ in CLAIMABLE_STATES)
    candidates = database.execute(
        f"SELECT * FROM notification_intents WHERE episode_id = ? "
        f"AND claim_token IS NULL AND state IN ({placeholders})",
        (episode_id, *sorted(CLAIMABLE_STATES)),
    ).fetchall()
    database.execute(
        f"UPDATE notification_intents SET state = 'cancelled_recovered', "
        f"claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL "
        f"WHERE episode_id = ? AND claim_token IS NULL "
        f"AND state IN ({placeholders})",
        (episode_id, *sorted(CLAIMABLE_STATES)),
    )
    for intent in candidates:
        _append_notification_attempt(
            database,
            str(intent["intent_id"]),
            None,
            "cancelled_recovered",
            recorded_at,
            intent["binding_digest"],
            intent["channel_id"],
            None,
        )


def _append_notification_attempt(
    database: sqlite3.Connection,
    intent_id: str,
    claim_token: str | None,
    event_kind: str,
    recorded_at: str,
    binding_digest: str | None,
    channel_id: str | None,
    message_id: str | None,
) -> None:
    database.execute(
        "INSERT INTO notification_attempts "
        "(intent_id, claim_token, event_kind, recorded_at, binding_digest, "
        "channel_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            intent_id,
            claim_token,
            event_kind,
            recorded_at,
            binding_digest,
            channel_id,
            message_id,
        ),
    )


def _close_poll_episode(
    database: sqlite3.Connection,
    service_id: str,
    closed_at: str,
    observation_seq: int,
) -> str | None:
    episode = database.execute(
        "SELECT e.* FROM episodes e JOIN health h ON h.poll_episode_id = e.episode_id "
        "WHERE h.service_id = ? AND e.closed_at IS NULL",
        (service_id,),
    ).fetchone()
    if episode is None:
        return None
    database.execute(
        "UPDATE episodes SET closed_at = ?, close_reason = 'recovered', "
        "recovery_observation_seq = ? WHERE episode_id = ? AND closed_at IS NULL",
        (closed_at, observation_seq, episode["episode_id"]),
    )
    database.execute(
        "UPDATE health SET poll_episode_id = NULL WHERE service_id = ?",
        (service_id,),
    )
    _cancel_unsent_notification(database, str(episode["episode_id"]), closed_at)
    return str(episode["episode_id"])


def _close_session_attempt(
    database: sqlite3.Connection,
    service_id: str,
    demand_source_id: str,
    demand_id: str,
    attempt_id: str,
    closed_at: str,
    observation_seq: int,
    close_reason: str,
) -> str | None:
    episode = database.execute(
        "SELECT * FROM episodes WHERE service_id = ? "
        "AND scope = 'session_unavailable' AND demand_source_id = ? "
        "AND demand_id = ? AND attempt_id = ? "
        "AND closed_at IS NULL ORDER BY opened_at LIMIT 1",
        (service_id, demand_source_id, demand_id, attempt_id),
    ).fetchone()
    if episode is None:
        return None
    database.execute(
        "UPDATE episodes SET closed_at = ?, close_reason = ?, "
        "recovery_observation_seq = ? WHERE episode_id = ? AND closed_at IS NULL",
        (closed_at, close_reason, observation_seq, episode["episode_id"]),
    )
    database.execute(
        "UPDATE health SET session_episode_id = NULL WHERE service_id = ? "
        "AND session_episode_id = ?",
        (service_id, episode["episode_id"]),
    )
    _cancel_unsent_notification(
        database, str(episode["episode_id"]), closed_at
    )
    return str(episode["episode_id"])


def _session_proof_id(
    result: dict[str, object], demand_source_id: str
) -> str:
    return hashlib.sha256(
        canonical_json(
            [
                demand_source_id,
                result["demandId"],
                result["successorAttemptId"],
                result["liveAt"],
                result["renewAt"],
            ]
        ).encode("utf-8")
    ).hexdigest()


def _record_session_proof(
    database: sqlite3.Connection,
    demand_source_id: str,
    result: dict[str, object],
    recorded_at: str,
    episode: sqlite3.Row | None = None,
    predecessor_attempt_id: str | None = None,
) -> None:
    episode_id = None if episode is None else episode["episode_id"]
    if episode is not None:
        if episode["demand_source_id"] != demand_source_id:
            raise VoiceHealthError("session_recovery_proof_mismatch")
        predecessor_attempt_id = str(episode["attempt_id"])
    proof_id = _session_proof_id(result, demand_source_id)
    existing = database.execute(
        "SELECT episode_id, demand_source_id FROM session_recovery_proofs "
        "WHERE proof_id = ?",
        (proof_id,),
    ).fetchone()
    if existing is not None:
        if (
            existing["episode_id"] != episode_id
            or existing["demand_source_id"] != demand_source_id
        ):
            raise VoiceHealthError("session_recovery_proof_mismatch")
        return
    database.execute(
        "INSERT INTO session_recovery_proofs "
        "(proof_id, episode_id, demand_source_id, demand_id, predecessor_attempt_id, "
        "successor_attempt_id, live_at, renew_at, recorded_at, proof_kind) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live_renew')",
        (
            proof_id,
            episode_id,
            demand_source_id,
            result["demandId"],
            predecessor_attempt_id,
            result["successorAttemptId"],
            result["liveAt"],
            result["renewAt"],
            recorded_at,
        ),
    )


def record_result(state_root: Path, payload: object) -> dict[str, object]:
    result = _validated_result(payload)
    digest_payload = {
        key: value
        for key, value in result.items()
        if key != "observedDatetime" and value is not None
    }
    payload_digest = hashlib.sha256(
        canonical_json(digest_payload).encode("utf-8")
    ).hexdigest()
    with open_store(state_root) as (database, host_identity, service_id, storage):
        def operation() -> dict[str, object]:
            current = database.execute(
                "SELECT * FROM health WHERE service_id = ?", (service_id,)
            ).fetchone()
            if current is None or int(current["generation"]) == 0:
                raise VoiceHealthError("health_not_registered")
            generation = int(result["generation"])
            current_generation = int(current["generation"])
            if generation < current_generation:
                return {
                    "status": "stale",
                    "generation": current_generation,
                    "observationSeq": int(current["observation_seq"]),
                }
            if generation > current_generation:
                raise VoiceHealthError("generation_mismatch")
            duplicate = database.execute(
                "SELECT observation_seq, payload_digest FROM producer_events "
                "WHERE generation = ? AND producer_event_seq = ?",
                (generation, result["producerEventSeq"]),
            ).fetchone()
            if duplicate is not None:
                if duplicate["payload_digest"] != payload_digest:
                    raise VoiceHealthError("producer_event_mismatch")
                return {
                    "status": "duplicate",
                    "generation": generation,
                    "producerEventSeq": result["producerEventSeq"],
                    "observationSeq": int(duplicate["observation_seq"]),
                    "successCount": int(current["success_count"]),
                    "progressCount": int(current["progress_count"]),
                    "failureCount": int(current["failure_count"]),
                    "failureStreak": int(current["failure_streak"]),
                }

            kind = str(result["resultKind"])
            observed_at = str(result["observedAt"])

            def no_action() -> dict[str, object]:
                observation_seq = int(current["observation_seq"])
                database.execute(
                    "INSERT INTO producer_events "
                    "(generation, producer_event_seq, observation_seq, event_kind, payload_digest) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        generation,
                        result["producerEventSeq"],
                        observation_seq,
                        kind,
                        payload_digest,
                    ),
                )
                return {
                    "status": "no_action",
                    "generation": generation,
                    "producerEventSeq": result["producerEventSeq"],
                    "observationSeq": observation_seq,
                    "successCount": int(current["success_count"]),
                    "progressCount": int(current["progress_count"]),
                    "failureCount": int(current["failure_count"]),
                    "failureStreak": int(current["failure_streak"]),
                }

            def authoritative_successor_matches() -> bool:
                if current["demand_state"] != "required":
                    return False
                try:
                    identities = json.loads(str(current["demand_identities_json"]))
                except json.JSONDecodeError as error:
                    raise VoiceHealthError("schema_invalid") from error
                return any(
                    isinstance(identity, dict)
                    and identity.get("demandId") == result["demandId"]
                    and identity.get("attemptId") == result["successorAttemptId"]
                    for identity in identities
                )

            def live_follows_predecessor(
                episode: sqlite3.Row | None,
                attempt: sqlite3.Row | None,
            ) -> bool:
                _, live_datetime = _parse_timestamp(result["liveAt"])
                predecessor_times: list[str] = []
                if episode is not None:
                    predecessor_times.append(str(episode["opened_at"]))
                if (
                    attempt is not None
                    and attempt["state"] == "failed"
                    and attempt["terminal_at"] is not None
                ):
                    predecessor_times.append(str(attempt["terminal_at"]))
                return all(
                    live_datetime > _parse_timestamp(timestamp)[1]
                    for timestamp in predecessor_times
                )

            closed_episode_id = None
            episode = None
            notification = None
            session_episode = None
            close_attempt_id = None
            current_demand_source = current["demand_source_id"]

            if kind == "idle_success":
                database.execute(
                    "UPDATE health SET phase = 'idle', last_iteration_success_at = ?, "
                    "last_progress_at = ?, success_count = success_count + ?, "
                    "failure_streak = 0, first_failure_at = NULL, "
                    "last_failure_at = NULL, reason_class = NULL, operation = NULL, "
                    "duration_ms = ?, source_status = 'available' "
                    "WHERE service_id = ?",
                    (
                        observed_at,
                        observed_at,
                        result["countDelta"],
                        result.get("durationMs"),
                        service_id,
                    ),
                )
            elif kind == "poll_failed":
                first_failure_at = current["first_failure_at"] or observed_at
                database.execute(
                    "UPDATE health SET phase = 'failed_retrying', "
                    "failure_count = failure_count + 1, "
                    "failure_streak = failure_streak + 1, first_failure_at = ?, "
                    "last_failure_at = ?, reason_class = ?, operation = ?, "
                    "duration_ms = ?, source_status = 'available' WHERE service_id = ?",
                    (
                        first_failure_at,
                        observed_at,
                        result["reasonClass"],
                        result["operation"],
                        result.get("durationMs"),
                        service_id,
                    ),
                )
                refreshed = database.execute(
                    "SELECT * FROM health WHERE service_id = ?", (service_id,)
                ).fetchone()
                threshold = None
                if int(refreshed["failure_streak"]) >= 3:
                    threshold = "three_consecutive_failures"
                else:
                    _, first_datetime = _parse_timestamp(refreshed["first_failure_at"])
                    elapsed = (
                        result["observedDatetime"] - first_datetime
                    ).total_seconds()
                    if elapsed >= 60:
                        threshold = "first_failure_60s"
                if refreshed["demand_state"] == "required" and threshold:
                    episode, notification = _open_episode(
                        database,
                        service_id,
                        "poll_dependency",
                        observed_at,
                        str(result["reasonClass"]),
                        threshold,
                        None,
                        None,
                        None,
                    )
            elif kind == "session_failed":
                database.execute(
                    "UPDATE health SET phase = 'session_failed', "
                    "failure_count = failure_count + 1, last_failure_at = ?, "
                    "reason_class = ?, operation = ?, duration_ms = ?, "
                    "source_status = 'available' WHERE service_id = ?",
                    (
                        observed_at,
                        result["reasonClass"],
                        result["operation"],
                        result.get("durationMs"),
                        service_id,
                    ),
                )
                if current["demand_state"] == "required":
                    demand_source = current["demand_source_id"]
                    if demand_source is None:
                        raise VoiceHealthError("demand_source_unavailable")
                    try:
                        demand_identities = json.loads(
                            str(current["demand_identities_json"])
                        )
                    except json.JSONDecodeError as error:
                        raise VoiceHealthError("schema_invalid") from error
                    latched_identity = database.execute(
                        "SELECT 1 FROM demand_attempts WHERE demand_source_id = ? "
                        "AND demand_id = ? AND state IN ('required', 'failed') LIMIT 1",
                        (demand_source, result["demandId"]),
                    ).fetchone()
                    identity_matches = any(
                        identity.get("demandId") == result["demandId"]
                        for identity in demand_identities
                        if isinstance(identity, dict)
                    ) or latched_identity is not None
                    if not identity_matches:
                        demand_source = None
                if current["demand_state"] == "required" and demand_source is not None:
                    existing_attempt = database.execute(
                        "SELECT state FROM demand_attempts WHERE demand_source_id = ? "
                        "AND demand_id = ? AND attempt_id = ?",
                        (demand_source, result["demandId"], result["attemptId"]),
                    ).fetchone()
                    if existing_attempt is not None and existing_attempt["state"] not in {
                        "required",
                        "failed",
                    }:
                        raise VoiceHealthError("demand_event_invalid")
                    database.execute(
                        "INSERT INTO demand_attempts "
                        "(demand_source_id, demand_id, attempt_id, state, first_event_seq, "
                        "last_event_seq, required_at, terminal_at, terminal_reason_class) "
                        "VALUES (?, ?, ?, 'failed', 0, 0, ?, ?, ?) "
                        "ON CONFLICT(demand_source_id, demand_id, attempt_id) DO UPDATE SET "
                        "state = 'failed', terminal_at = excluded.terminal_at, "
                        "terminal_reason_class = excluded.terminal_reason_class",
                        (
                            demand_source,
                            result["demandId"],
                            result["attemptId"],
                            observed_at,
                            observed_at,
                            result["reasonClass"],
                        ),
                    )
                    episode, notification = _open_episode(
                        database,
                        service_id,
                        "session_unavailable",
                        observed_at,
                        str(result["reasonClass"]),
                        "first_session_failure",
                        str(result["demandId"]),
                        str(result["attemptId"]),
                        str(demand_source),
                    )
            elif kind == "progress":
                # FLY-2693 review R5: lease-renew progress proves the active
                # session is alive; it says nothing about the poll path, so it
                # must not zero failure_streak or re-anchor first_failure_at.
                # Only a real idle_success clears the poll-scope failure window.
                database.execute(
                    "UPDATE health SET phase = 'active', last_progress_at = ?, "
                    "progress_count = progress_count + ?, duration_ms = ?, "
                    "source_status = 'available' WHERE service_id = ?",
                    (
                        observed_at,
                        result["countDelta"],
                        result.get("durationMs"),
                        service_id,
                    ),
                )
            elif kind == "session_recovered":
                if (
                    current_demand_source is None
                    or not authoritative_successor_matches()
                ):
                    return no_action()
                session_episode = database.execute(
                    "SELECT * FROM episodes WHERE service_id = ? "
                    "AND scope = 'session_unavailable' AND demand_source_id = ? "
                    "AND demand_id = ? "
                    "AND closed_at IS NULL ORDER BY opened_at LIMIT 1",
                    (service_id, current_demand_source, result["demandId"]),
                ).fetchone()
                unresolved_attempt = database.execute(
                    "SELECT * FROM demand_attempts WHERE demand_source_id = ? "
                    "AND demand_id = ? AND state = 'failed' "
                    "ORDER BY last_event_seq DESC LIMIT 1",
                    (current_demand_source, result["demandId"]),
                ).fetchone()
                predecessor_attempt = None
                if session_episode is not None:
                    close_attempt_id = str(session_episode["attempt_id"])
                    predecessor_attempt = database.execute(
                        "SELECT * FROM demand_attempts WHERE demand_source_id = ? "
                        "AND demand_id = ? AND attempt_id = ? "
                        "AND state = 'failed' LIMIT 1",
                        (
                            current_demand_source,
                            result["demandId"],
                            close_attempt_id,
                        ),
                    ).fetchone()
                    if predecessor_attempt is None:
                        return no_action()
                elif unresolved_attempt is not None:
                    predecessor_attempt = unresolved_attempt
                    close_attempt_id = str(unresolved_attempt["attempt_id"])
                else:
                    return no_action()
                if not live_follows_predecessor(
                    session_episode, predecessor_attempt
                ):
                    return no_action()
                _record_session_proof(
                    database,
                    str(current_demand_source),
                    result,
                    observed_at,
                    session_episode,
                    str(close_attempt_id),
                )
                database.execute(
                    "UPDATE health SET phase = 'active', last_progress_at = ?, "
                    "source_status = 'available' WHERE service_id = ?",
                    (observed_at, service_id),
                )
            elif kind == "session_ended":
                if current_demand_source is None:
                    return no_action()
                successor_is_current = authoritative_successor_matches()
                if not successor_is_current:
                    completed_attempt = database.execute(
                        "SELECT terminal_at FROM demand_attempts "
                        "WHERE demand_source_id = ? AND demand_id = ? "
                        "AND attempt_id = ? AND state = 'normal_completed' LIMIT 1",
                        (
                            current_demand_source,
                            result["demandId"],
                            result["successorAttemptId"],
                        ),
                    ).fetchone()
                    if (
                        completed_attempt is None
                        or completed_attempt["terminal_at"] is None
                    ):
                        return no_action()
                    _, terminal_datetime = _parse_timestamp(
                        completed_attempt["terminal_at"]
                    )
                    if result["observedDatetime"] > terminal_datetime:
                        return no_action()
                session_episode = database.execute(
                    "SELECT * FROM episodes WHERE service_id = ? "
                    "AND scope = 'session_unavailable' AND demand_source_id = ? "
                    "AND demand_id = ? "
                    "AND closed_at IS NULL ORDER BY opened_at LIMIT 1",
                    (service_id, current_demand_source, result["demandId"]),
                ).fetchone()
                proof_id = _session_proof_id(result, str(current_demand_source))
                existing_proof = database.execute(
                    "SELECT * FROM session_recovery_proofs WHERE proof_id = ? "
                    "AND demand_source_id = ?",
                    (proof_id, current_demand_source),
                ).fetchone()
                proof_episode = None
                proof_attempt = None
                if existing_proof is not None:
                    if existing_proof["episode_id"] is not None:
                        proof_episode = database.execute(
                            "SELECT * FROM episodes WHERE episode_id = ? "
                            "AND demand_source_id = ? AND demand_id = ?",
                            (
                                existing_proof["episode_id"],
                                current_demand_source,
                                result["demandId"],
                            ),
                        ).fetchone()
                        if proof_episode is None:
                            return no_action()
                    if existing_proof["predecessor_attempt_id"] is not None:
                        proof_attempt = database.execute(
                            "SELECT * FROM demand_attempts WHERE demand_source_id = ? "
                            "AND demand_id = ? AND attempt_id = ?",
                            (
                                current_demand_source,
                                result["demandId"],
                                existing_proof["predecessor_attempt_id"],
                            ),
                        ).fetchone()
                        if proof_attempt is None:
                            return no_action()
                    if not live_follows_predecessor(
                        proof_episode, proof_attempt
                    ):
                        return no_action()
                unresolved_attempt = database.execute(
                    "SELECT * FROM demand_attempts WHERE demand_source_id = ? "
                    "AND demand_id = ? AND state IN ('required', 'failed') "
                    "ORDER BY last_event_seq DESC LIMIT 1",
                    (current_demand_source, result["demandId"]),
                ).fetchone()
                predecessor_attempt = None
                if session_episode is not None:
                    close_attempt_id = str(session_episode["attempt_id"])
                    predecessor_attempt = database.execute(
                        "SELECT * FROM demand_attempts WHERE demand_source_id = ? "
                        "AND demand_id = ? AND attempt_id = ? "
                        "AND state = 'failed' "
                        "ORDER BY last_event_seq DESC LIMIT 1",
                        (
                            current_demand_source,
                            result["demandId"],
                            close_attempt_id,
                        ),
                    ).fetchone()
                    if predecessor_attempt is None:
                        return no_action()
                elif unresolved_attempt is not None:
                    predecessor_attempt = unresolved_attempt
                    close_attempt_id = str(unresolved_attempt["attempt_id"])
                if existing_proof is None and not live_follows_predecessor(
                    session_episode, predecessor_attempt
                ):
                    return no_action()
                if existing_proof is None:
                    _record_session_proof(
                        database,
                        str(current_demand_source),
                        result,
                        observed_at,
                        session_episode,
                        close_attempt_id,
                    )
                poll_episode = database.execute(
                    "SELECT e.reason_class FROM episodes e JOIN health h "
                    "ON h.poll_episode_id = e.episode_id WHERE h.service_id = ? "
                    "AND e.closed_at IS NULL",
                    (service_id,),
                ).fetchone()
                database.execute(
                    "UPDATE health SET phase = 'session_ended', "
                    "last_iteration_success_at = ?, last_progress_at = ?, "
                    "success_count = success_count + 1, reason_class = ?, "
                    "operation = ?, source_status = 'available' "
                    "WHERE service_id = ?",
                    (
                        observed_at,
                        observed_at,
                        poll_episode["reason_class"] if poll_episode else None,
                        "desired" if poll_episode else None,
                        service_id,
                    ),
                )
            elif kind == "closed_not_required":
                if current_demand_source is None:
                    raise VoiceHealthError("demand_source_unavailable")
                fact_query = (
                    "SELECT * FROM demand_attempts WHERE demand_source_id = ? "
                    "AND demand_id = ? "
                    "AND state IN ('cancelled', 'normal_completed')"
                )
                parameters: tuple[object, ...] = (
                    current_demand_source,
                    result["demandId"],
                )
                if result.get("attemptId") is not None:
                    fact_query += " AND attempt_id = ?"
                    parameters = (
                        current_demand_source,
                        result["demandId"],
                        result["attemptId"],
                    )
                fact_query += " ORDER BY last_event_seq DESC LIMIT 1"
                close_fact = database.execute(fact_query, parameters).fetchone()
                if close_fact is None:
                    raise VoiceHealthError("demand_close_fact_missing")
                if current["demand_state"] != "none":
                    raise VoiceHealthError("demand_not_none")
                close_attempt_id = str(close_fact["attempt_id"])
                database.execute(
                    "UPDATE health SET phase = 'dormant', source_status = 'available' "
                    "WHERE service_id = ?",
                    (service_id,),
                )
            elif kind == "daemon_stopped":
                database.execute(
                    "UPDATE health SET phase = 'stopped', source_status = 'available' "
                    "WHERE service_id = ?",
                    (service_id,),
                )

            # Allocate the durable global observation before writing recovery
            # references, then replace the just-written change with the final
            # scope state in this same transaction.
            observation_seq, change_seq = _append_change(
                database, service_id, observed_at
            )
            if kind == "idle_success":
                closed_episode_id = _close_poll_episode(
                    database, service_id, observed_at, observation_seq
                )
            elif kind == "progress" and current["poll_episode_id"] is not None:
                heartbeat_episode = database.execute(
                    "SELECT 1 FROM episodes WHERE episode_id = ? "
                    "AND reason_class = 'heartbeat_stale' AND closed_at IS NULL",
                    (current["poll_episode_id"],),
                ).fetchone()
                if heartbeat_episode is not None:
                    closed_episode_id = _close_poll_episode(
                        database, service_id, observed_at, observation_seq
                    )
                    database.execute(
                        "UPDATE health SET reason_class = NULL, operation = NULL "
                        "WHERE service_id = ? AND reason_class = 'heartbeat_stale'",
                        (service_id,),
                    )
            elif kind == "session_recovered":
                closed_episode_id = _close_session_attempt(
                    database,
                    service_id,
                    str(current_demand_source),
                    str(result["demandId"]),
                    str(close_attempt_id),
                    observed_at,
                    observation_seq,
                    "recovered",
                )
                database.execute(
                    "UPDATE demand_attempts SET state = 'recovered', terminal_at = ? "
                    "WHERE demand_source_id = ? AND demand_id = ? AND attempt_id = ?",
                    (
                        observed_at,
                        current_demand_source,
                        result["demandId"],
                        close_attempt_id,
                    ),
                )
            elif kind == "session_ended":
                if close_attempt_id is not None:
                    closed_episode_id = _close_session_attempt(
                        database,
                        service_id,
                        str(current_demand_source),
                        str(result["demandId"]),
                        str(close_attempt_id),
                        observed_at,
                        observation_seq,
                        "recovered",
                    )
                    database.execute(
                        "UPDATE demand_attempts SET state = 'recovered', terminal_at = ? "
                        "WHERE demand_source_id = ? AND demand_id = ? AND attempt_id = ?",
                        (
                            observed_at,
                            current_demand_source,
                            result["demandId"],
                            close_attempt_id,
                        ),
                    )
            elif kind == "closed_not_required":
                closed_episode_id = _close_session_attempt(
                    database,
                    service_id,
                    str(current_demand_source),
                    str(result["demandId"]),
                    str(close_attempt_id),
                    observed_at,
                    observation_seq,
                    "closed_not_required",
                )

            marker_restored = _restore_demand_marker(database, service_id, current)

            # Recovery changes alter episode/notification state after the first
            # snapshot build. Refresh the same change row before commit.
            if (
                kind
                in {
                    "idle_success",
                    "session_recovered",
                    "session_ended",
                    "closed_not_required",
                }
                or closed_episode_id is not None
                or marker_restored
            ):
                source_id = database.execute(
                    "SELECT source_id FROM metadata WHERE singleton = 1"
                ).fetchone()["source_id"]
                database.execute(
                    "UPDATE changes SET projection_json = ? WHERE source_id = ? "
                    "AND change_seq = ?",
                    (
                        canonical_json(_current_projection(database, service_id)),
                        source_id,
                        change_seq,
                    ),
                )

            database.execute(
                "INSERT INTO producer_events "
                "(generation, producer_event_seq, observation_seq, event_kind, payload_digest) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    generation,
                    result["producerEventSeq"],
                    observation_seq,
                    kind,
                    payload_digest,
                ),
            )
            refreshed = database.execute(
                "SELECT success_count, progress_count, failure_count, failure_streak FROM health "
                "WHERE service_id = ?",
                (service_id,),
            ).fetchone()
            response: dict[str, object] = {
                "status": "recorded",
                "generation": generation,
                "producerEventSeq": result["producerEventSeq"],
                "observationSeq": observation_seq,
                "changeSeq": change_seq,
                "successCount": int(refreshed["success_count"]),
                "progressCount": int(refreshed["progress_count"]),
                "failureCount": int(refreshed["failure_count"]),
                "failureStreak": int(refreshed["failure_streak"]),
            }
            if episode is not None:
                response["episode"] = _episode_payload(episode)
            if notification is not None:
                response["notification"] = _notification_payload(notification)
            if closed_episode_id is not None:
                response["closedEpisodeId"] = closed_episode_id
            return response

        mutation = _write_transaction(
            database,
            operation,
            checkpoint=result["resultKind"] not in {"idle_success", "progress"},
        )
        return _add_base_receipt(
            database, host_identity, service_id, storage, mutation
        )


def _snowflake(value: object) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9]{17,20}", value) is None:
        raise VoiceHealthError("invalid_delivery_receipt")
    return value


def claim_notification(state_root: Path, payload: object) -> dict[str, object]:
    expected = {
        "intentId",
        "claimToken",
        "claimedAt",
        "expiresAt",
        "bindingDigest",
        "channelId",
    }
    if not isinstance(payload, dict) or set(payload) != expected:
        raise VoiceHealthError("invalid_input")
    intent_id = _validated_digest(payload["intentId"])
    claim_token = _validated_uuid(payload["claimToken"])
    claimed_at, claimed_datetime = _parse_timestamp(payload["claimedAt"])
    expires_at, expires_datetime = _parse_timestamp(payload["expiresAt"])
    if expires_datetime <= claimed_datetime:
        raise VoiceHealthError("invalid_input")
    binding_digest = _validated_digest(payload["bindingDigest"])
    channel_id = _snowflake(payload["channelId"])
    with open_store(state_root) as (database, host_identity, service_id, storage):
        def operation() -> dict[str, object]:
            intent = database.execute(
                "SELECT * FROM notification_intents WHERE intent_id = ? "
                "AND service_id = ?",
                (intent_id, service_id),
            ).fetchone()
            if intent is None:
                raise VoiceHealthError("notification_not_found")
            if intent["claim_token"] and intent["claim_expires_at"]:
                _, prior_expiry = _parse_timestamp(intent["claim_expires_at"])
                if prior_expiry <= claimed_datetime:
                    database.execute(
                        "UPDATE notification_intents SET state = 'delivery_unknown', "
                        "claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL "
                        "WHERE intent_id = ?",
                        (intent_id,),
                    )
                    _append_notification_attempt(
                        database,
                        intent_id,
                        str(intent["claim_token"]),
                        "delivery_unknown",
                        claimed_at,
                        intent["binding_digest"],
                        intent["channel_id"],
                        None,
                    )
                    observation_seq, change_seq = _append_change(
                        database, service_id, claimed_at
                    )
                    return {
                        "status": "delivery_unknown",
                        "intentId": intent_id,
                        "state": "delivery_unknown",
                        "observationSeq": observation_seq,
                        "changeSeq": change_seq,
                    }
            episode = database.execute(
                "SELECT closed_at FROM episodes WHERE episode_id = ?",
                (intent["episode_id"],),
            ).fetchone()
            if episode is None:
                raise VoiceHealthError("schema_invalid")
            if episode["closed_at"] is not None:
                return {"status": "not_claimable", "state": str(intent["state"])}
            if intent["state"] not in CLAIMABLE_STATES:
                return {"status": "not_claimable", "state": str(intent["state"])}
            if intent["claim_token"]:
                if intent["claim_token"] == claim_token:
                    if (
                        intent["binding_digest"] != binding_digest
                        or intent["channel_id"] != channel_id
                    ):
                        raise VoiceHealthError("notification_binding_mismatch")
                    return {
                        "status": "claimed",
                        "intentId": intent_id,
                        "claimToken": claim_token,
                        "frozenPayload": json.loads(str(intent["frozen_payload"])),
                    }
                return {"status": "claimed_elsewhere", "intentId": intent_id}
            database.execute(
                "UPDATE notification_intents SET claim_token = ?, claimed_at = ?, "
                "claim_expires_at = ?, binding_digest = ?, channel_id = ?, "
                "attempt_count = attempt_count + 1 WHERE intent_id = ? "
                "AND claim_token IS NULL",
                (
                    claim_token,
                    claimed_at,
                    expires_at,
                    binding_digest,
                    channel_id,
                    intent_id,
                ),
            )
            _append_notification_attempt(
                database,
                intent_id,
                claim_token,
                "claimed",
                claimed_at,
                binding_digest,
                channel_id,
                None,
            )
            observation_seq, change_seq = _append_change(
                database, service_id, claimed_at
            )
            return {
                "status": "claimed",
                "intentId": intent_id,
                "claimToken": claim_token,
                "routeKey": str(intent["route_key"]),
                "bindingDigest": binding_digest,
                "channelId": channel_id,
                "frozenPayload": json.loads(str(intent["frozen_payload"])),
                "observationSeq": observation_seq,
                "changeSeq": change_seq,
            }

        mutation = _write_transaction(database, operation)
        return _add_base_receipt(
            database, host_identity, service_id, storage, mutation
        )


def record_delivery(state_root: Path, payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise VoiceHealthError("invalid_input")
    allowed = {
        "intentId",
        "claimToken",
        "bindingDigest",
        "state",
        "channelId",
        "messageId",
    }
    if set(payload) - allowed or not {
        "intentId",
        "claimToken",
        "bindingDigest",
        "state",
    }.issubset(payload):
        raise VoiceHealthError("invalid_input")
    intent_id = _validated_digest(payload["intentId"])
    claim_token = _validated_uuid(payload["claimToken"])
    binding_digest = _validated_digest(payload["bindingDigest"])
    state = payload["state"]
    if state not in DELIVERY_STATES:
        raise VoiceHealthError("invalid_input")
    channel_id = payload.get("channelId")
    message_id = payload.get("messageId")
    if state == "sent":
        channel_id = _snowflake(channel_id)
        message_id = _snowflake(message_id)
    elif channel_id is not None or message_id is not None:
        raise VoiceHealthError("invalid_delivery_receipt")

    with open_store(state_root) as (database, host_identity, service_id, storage):
        def operation() -> dict[str, object]:
            intent = database.execute(
                "SELECT * FROM notification_intents WHERE intent_id = ? "
                "AND service_id = ?",
                (intent_id, service_id),
            ).fetchone()
            if intent is None:
                raise VoiceHealthError("notification_not_found")
            if intent["claim_token"] != claim_token:
                raise VoiceHealthError("notification_claim_mismatch")
            if intent["binding_digest"] != binding_digest:
                raise VoiceHealthError("notification_binding_mismatch")
            if state == "sent" and (
                intent["binding_digest"] is None or intent["channel_id"] != channel_id
            ):
                raise VoiceHealthError("invalid_delivery_receipt")
            episode = database.execute(
                "SELECT closed_at FROM episodes WHERE episode_id = ?",
                (intent["episode_id"],),
            ).fetchone()
            if episode is None:
                raise VoiceHealthError("schema_invalid")
            changed_at = _utc_now()
            _append_notification_attempt(
                database,
                intent_id,
                claim_token,
                str(state),
                changed_at,
                binding_digest,
                channel_id or intent["channel_id"],
                message_id,
            )
            final_state = state
            if episode["closed_at"] is not None and state in {
                "queued_transient",
                "config_error",
            }:
                final_state = "cancelled_recovered"
                _append_notification_attempt(
                    database,
                    intent_id,
                    claim_token,
                    "cancelled_recovered",
                    changed_at,
                    binding_digest,
                    channel_id or intent["channel_id"],
                    None,
                )
            database.execute(
                "UPDATE notification_intents SET state = ?, channel_id = ?, "
                "message_id = ?, claim_token = NULL, claimed_at = NULL, "
                "claim_expires_at = NULL WHERE intent_id = ?",
                (
                    final_state,
                    channel_id or intent["channel_id"],
                    message_id,
                    intent_id,
                ),
            )
            observation_seq, change_seq = _append_change(
                database, service_id, changed_at
            )
            return {
                "status": "recorded",
                "intentId": intent_id,
                "state": final_state,
                "channelId": channel_id or intent["channel_id"],
                "messageId": message_id,
                "observationSeq": observation_seq,
                "changeSeq": change_seq,
            }

        mutation = _write_transaction(database, operation)
        return _add_base_receipt(
            database, host_identity, service_id, storage, mutation
        )


def export_health(state_root: Path, payload: object) -> dict[str, object]:
    if payload is None:
        payload = {}
    if not isinstance(payload, dict) or set(payload) - {"sourceId", "afterCursor", "limit"}:
        raise VoiceHealthError("invalid_input")
    after_cursor = payload.get("afterCursor", 0)
    limit = payload.get("limit", MAX_EXPORT_ROWS)
    if (
        not isinstance(after_cursor, int)
        or isinstance(after_cursor, bool)
        or after_cursor < 0
        or not isinstance(limit, int)
        or isinstance(limit, bool)
        or limit < 1
        or limit > MAX_EXPORT_ROWS
    ):
        raise VoiceHealthError("invalid_input")

    with open_store(state_root) as (database, host_identity, service_id, storage):
        try:
            database.execute("BEGIN")
            metadata = database.execute(
                "SELECT source_id, next_change_seq FROM metadata WHERE singleton = 1"
            ).fetchone()
            source_id = str(metadata["source_id"])
            event_high_water = int(metadata["next_change_seq"]) - 1
            requested_source = payload.get("sourceId")
            if requested_source is not None and requested_source != source_id:
                raise VoiceHealthError("source_mismatch")
            if after_cursor > event_high_water:
                raise VoiceHealthError("cursor_mismatch")
            rows = database.execute(
                "SELECT change_seq, observation_seq, changed_at, projection_json "
                "FROM changes WHERE source_id = ? AND change_seq > ? "
                "ORDER BY change_seq LIMIT ?",
                (source_id, after_cursor, limit + 1),
            ).fetchall()
            if after_cursor < event_high_water:
                if not rows or int(rows[0]["change_seq"]) != after_cursor + 1:
                    raise VoiceHealthError("change_gap")
                prior_seq = after_cursor
                for row in rows:
                    row_seq = int(row["change_seq"])
                    if row_seq != prior_seq + 1:
                        raise VoiceHealthError("change_gap")
                    prior_seq = row_seq
            has_more = len(rows) > limit
            delivered = rows[:limit]
            if (
                not has_more
                and after_cursor < event_high_water
                and int(delivered[-1]["change_seq"]) != event_high_water
            ):
                raise VoiceHealthError("change_gap")
            changes = [
                {
                    "changeSeq": int(row["change_seq"]),
                    "observationSeq": int(row["observation_seq"]),
                    "changedAt": str(row["changed_at"]),
                    "projection": json.loads(str(row["projection_json"])),
                }
                for row in delivered
            ]
            next_cursor = (
                int(delivered[-1]["change_seq"]) if delivered else after_cursor
            )
            response: dict[str, object] = {
                "schemaVersion": SCHEMA_VERSION,
                "sourceId": source_id,
                "serviceId": service_id,
                "serviceLabel": SERVICE_LABEL,
                "eventHighWater": event_high_water,
                "changes": changes,
                "hasMore": has_more,
                "nextCursor": next_cursor,
                "storage": storage,
            }
            if not has_more:
                response["currentProjection"] = _current_projection(
                    database, service_id
                )
                episodes = database.execute(
                    "SELECT * FROM episodes WHERE service_id = ? AND closed_at IS NULL "
                    "ORDER BY opened_at, episode_id LIMIT 201",
                    (service_id,),
                ).fetchall()
                notifications = database.execute(
                    "SELECT n.* FROM notification_intents n "
                    "WHERE n.service_id = ? ORDER BY n.intent_id LIMIT 201",
                    (service_id,),
                ).fetchall()
                response["openEpisodes"] = [
                    _episode_payload(row) for row in episodes[:MAX_EXPORT_ROWS]
                ]
                response["openEpisodesTruncated"] = len(episodes) > MAX_EXPORT_ROWS
                response["notifications"] = [
                    _notification_payload(row)
                    for row in notifications[:MAX_EXPORT_ROWS]
                ]
                response["notificationsTruncated"] = (
                    len(notifications) > MAX_EXPORT_ROWS
                )
                unresolved_attempts = database.execute(
                    "SELECT * FROM demand_attempts WHERE state IN ('required', 'failed') "
                    "ORDER BY last_event_seq, demand_id, attempt_id LIMIT 201"
                ).fetchall()
                response["unresolvedDemandAttempts"] = [
                    {
                        "demandSourceId": str(row["demand_source_id"]),
                        "demandId": str(row["demand_id"]),
                        "attemptId": str(row["attempt_id"]),
                        "state": str(row["state"]),
                        "firstEventSeq": int(row["first_event_seq"]),
                        "lastEventSeq": int(row["last_event_seq"]),
                        "requiredAt": str(row["required_at"]),
                        "terminalAt": row["terminal_at"],
                        "reasonClass": row["terminal_reason_class"],
                    }
                    for row in unresolved_attempts[:MAX_EXPORT_ROWS]
                ]
                response["unresolvedDemandAttemptsTruncated"] = (
                    len(unresolved_attempts) > MAX_EXPORT_ROWS
                )
                proofs = database.execute(
                    "SELECT * FROM session_recovery_proofs "
                    "ORDER BY recorded_at, proof_id LIMIT 201"
                ).fetchall()
                response["sessionRecoveryProofs"] = [
                    {
                        "proofId": str(row["proof_id"]),
                        "episodeId": row["episode_id"],
                        "demandSourceId": row["demand_source_id"],
                        "demandId": str(row["demand_id"]),
                        "predecessorAttemptId": row["predecessor_attempt_id"],
                        "successorAttemptId": str(row["successor_attempt_id"]),
                        "liveAt": str(row["live_at"]),
                        "renewAt": str(row["renew_at"]),
                        "recordedAt": str(row["recorded_at"]),
                        "proofKind": str(row["proof_kind"]),
                    }
                    for row in proofs[:MAX_EXPORT_ROWS]
                ]
                response["sessionRecoveryProofsTruncated"] = (
                    len(proofs) > MAX_EXPORT_ROWS
                )
                notification_attempts = database.execute(
                    "SELECT * FROM notification_attempts "
                    "ORDER BY ledger_seq DESC LIMIT 201"
                ).fetchall()
                selected_attempts = list(
                    reversed(notification_attempts[:MAX_EXPORT_ROWS])
                )
                response["notificationAttempts"] = [
                    {
                        "ledgerSeq": int(row["ledger_seq"]),
                        "intentId": str(row["intent_id"]),
                        "claimToken": row["claim_token"],
                        "eventKind": str(row["event_kind"]),
                        "recordedAt": str(row["recorded_at"]),
                        "bindingDigest": row["binding_digest"],
                        "channelId": row["channel_id"],
                        "messageId": row["message_id"],
                    }
                    for row in selected_attempts
                ]
                response["notificationAttemptsTruncated"] = (
                    len(notification_attempts) > MAX_EXPORT_ROWS
                )
            database.commit()
            return response
        except VoiceHealthError:
            database.rollback()
            raise
        except (sqlite3.Error, json.JSONDecodeError) as error:
            database.rollback()
            raise VoiceHealthError("health_store_unavailable") from error


def maintenance_checkpoint(state_root: Path, payload: object) -> dict[str, object]:
    if not isinstance(payload, dict) or set(payload) != {"requestedAt"}:
        raise VoiceHealthError("invalid_input")
    requested_at, _ = _parse_timestamp(payload["requestedAt"])
    with open_store(state_root) as (database, host_identity, service_id, storage):
        receipt = _base_receipt(database, host_identity, service_id, storage)
        receipt.update(
            {
                "status": "checkpointed",
                "requestedAt": requested_at,
                "checkpoint": _passive_checkpoint(database),
            }
        )
        return receipt


def _read_payload() -> object | None:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise VoiceHealthError("input_too_large")
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VoiceHealthError("invalid_input") from error


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--state-root", required=True)
    parser.add_argument(
        "command",
        choices=(
            "init",
            "register-boot",
            "record-demand",
            "record-startup",
            "record-result",
            "evaluate",
            "export",
            "claim-notification",
            "record-delivery",
            "maintenance",
        ),
    )
    arguments = parser.parse_args()
    payload = _read_payload()
    state_root = Path(arguments.state_root)
    if arguments.command == "init":
        if payload not in (None, {}):
            raise VoiceHealthError("invalid_input")
        result = initialize(state_root)
    elif arguments.command == "register-boot":
        result = register_boot(state_root, payload)
    elif arguments.command == "record-demand":
        result = record_demand(state_root, payload)
    elif arguments.command == "record-startup":
        result = record_startup(state_root, payload)
    elif arguments.command == "record-result":
        result = record_result(state_root, payload)
    elif arguments.command == "evaluate":
        result = evaluate_health(state_root, payload)
    elif arguments.command == "export":
        result = export_health(state_root, payload)
    elif arguments.command == "claim-notification":
        result = claim_notification(state_root, payload)
    elif arguments.command == "record-delivery":
        result = record_delivery(state_root, payload)
    else:
        result = maintenance_checkpoint(state_root, payload)
    print(canonical_json(result))
    return 0


if __name__ == "__main__":
    os.umask(0o077)
    try:
        raise SystemExit(main())
    except VoiceHealthError as error:
        print(f"voice-health: {error.code}", file=sys.stderr)
        raise SystemExit(2)
