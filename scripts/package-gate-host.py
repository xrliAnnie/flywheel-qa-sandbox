#!/usr/bin/env python3
"""Host-wide FIFO admission and supervision for local package gates.

The authoritative ledger is SQLite.  ``ledger.json`` is a human-readable
projection only and is never consulted for admission.  Production callers use
the OS account's real home directory; the underscored commands are an explicit
test API and reject use unless ``FLYWHEEL_PACKAGE_GATE_TESTING=1``.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import errno
import fcntl
import json
import os
import pwd
import random
import select
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Iterator, Sequence


SCHEMA_VERSION = 1
DEFAULT_CAPACITY = 2
MAX_CAPACITY = 16
POLL_SECONDS = 0.25
HEARTBEAT_SECONDS = 2.0
STALE_HEARTBEAT_MS = 10_000
WAIT_PRINT_SECONDS = 10.0
TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
MAX_TERMINAL_ROWS = 10_000
LIVE_STATES = ("queued", "suspended", "reserved", "running", "draining", "recovery_hold")
OCCUPIED_STATES = ("reserved", "running", "draining", "recovery_hold")
TERMINAL_STATES = ("finished", "cancelled", "abandoned")


class HostQueueError(RuntimeError):
	pass


def utc_now() -> str:
	return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def epoch_ms() -> int:
	return time.time_ns() // 1_000_000


def production_root() -> Path:
	home = Path(pwd.getpwuid(os.getuid()).pw_dir)
	return home / ".flywheel" / "state" / "package-gate" / "v1"


def require_test_mode() -> None:
	if os.environ.get("FLYWHEEL_PACKAGE_GATE_TESTING") != "1":
		raise HostQueueError("test_api_disabled")


def ensure_directory(path: Path) -> None:
	path.mkdir(parents=True, mode=0o700, exist_ok=True)
	info = path.lstat()
	if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
		raise HostQueueError("state_root_not_directory")
	if info.st_uid != os.getuid():
		raise HostQueueError("state_root_owner_mismatch")
	os.chmod(path, 0o700)


def reject_unsafe_file(path: Path) -> None:
	if not path.exists() and not path.is_symlink():
		return
	info = path.lstat()
	if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
		raise HostQueueError(f"unsafe_file:{path.name}")
	if info.st_uid != os.getuid():
		raise HostQueueError(f"owner_mismatch:{path.name}")


def atomic_json(path: Path, value: Any) -> None:
	reject_unsafe_file(path)
	fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
	try:
		os.fchmod(fd, 0o600)
		with os.fdopen(fd, "w", encoding="utf-8") as handle:
			json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
			handle.write("\n")
			handle.flush()
			os.fsync(handle.fileno())
		os.replace(temporary, path)
	finally:
		with contextlib.suppress(FileNotFoundError):
			os.unlink(temporary)


def read_control(root: Path) -> dict[str, Any]:
	path = root / "control.json"
	if not path.exists() and not path.is_symlink():
		return {"schemaVersion": SCHEMA_VERSION, "mode": "disabled", "generation": None}
	reject_unsafe_file(path)
	try:
		value = json.loads(path.read_text(encoding="utf-8"))
	except (OSError, json.JSONDecodeError) as exc:
		raise HostQueueError("control_unreadable") from exc
	if (
		not isinstance(value, dict)
		or value.get("schemaVersion") != SCHEMA_VERSION
		or value.get("mode") not in ("enabled", "disabled")
		or not isinstance(value.get("generation"), str)
	):
		raise HostQueueError("control_invalid")
	return value


def write_control(root: Path, mode: str) -> dict[str, Any]:
	value = {
		"schemaVersion": SCHEMA_VERSION,
		"mode": mode,
		"generation": str(uuid.uuid4()),
		"updatedAt": utc_now(),
	}
	atomic_json(root / "control.json", value)
	return value


def database(root: Path) -> sqlite3.Connection:
	ensure_directory(root)
	path = root / "queue.sqlite3"
	reject_unsafe_file(path)
	connection = sqlite3.connect(path, timeout=0.25, isolation_level=None)
	connection.row_factory = sqlite3.Row
	connection.execute("PRAGMA busy_timeout=250")
	connection.execute("PRAGMA journal_mode=DELETE")
	connection.execute("PRAGMA foreign_keys=ON")
	connection.executescript(
		"""
		CREATE TABLE IF NOT EXISTS meta(
			singleton INTEGER PRIMARY KEY CHECK(singleton=1),
			schemaVersion INTEGER NOT NULL,
			uid INTEGER NOT NULL,
			generation TEXT NOT NULL,
			capacity INTEGER NOT NULL,
			calibrated INTEGER NOT NULL,
			revision INTEGER NOT NULL,
			nextSeq INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS requests(
			requestId TEXT PRIMARY KEY,
			seq INTEGER NOT NULL UNIQUE,
			previousSeq INTEGER,
			protocolVersion INTEGER NOT NULL,
			state TEXT NOT NULL,
			enqueuedAt TEXT NOT NULL,
			enqueuedAtMs INTEGER NOT NULL,
			supervisorPid INTEGER NOT NULL,
			ownerLockId TEXT NOT NULL,
			ownerLockDev INTEGER NOT NULL,
			ownerLockInode INTEGER NOT NULL,
			worktreeRealpath TEXT NOT NULL,
			head TEXT,
			executionIdClaim TEXT,
			heartbeatAt TEXT NOT NULL,
			heartbeatAtMs INTEGER NOT NULL,
			admittedAt TEXT,
			admittedAtMs INTEGER,
			workerPid INTEGER,
			watchdogPid INTEGER,
			pgid INTEGER,
			finishedAt TEXT,
			finishedAtMs INTEGER,
			exitCode INTEGER,
			outcome TEXT,
			receiptPath TEXT
		);
		CREATE INDEX IF NOT EXISTS requests_state_seq ON requests(state,seq);
		"""
	)
	info = path.lstat()
	if stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid():
		connection.close()
		raise HostQueueError("database_identity_invalid")
	os.chmod(path, 0o600)
	with immediate(connection):
		row = connection.execute("SELECT * FROM meta WHERE singleton=1").fetchone()
		if row is None:
			connection.execute(
				"INSERT INTO meta VALUES(1,?,?,?,?,?,?,?)",
				(SCHEMA_VERSION, os.getuid(), str(uuid.uuid4()), DEFAULT_CAPACITY, 0, 0, 1),
			)
		elif row["schemaVersion"] != SCHEMA_VERSION or row["uid"] != os.getuid():
			raise HostQueueError("database_schema_or_uid_mismatch")
	return connection


@contextlib.contextmanager
def immediate(connection: sqlite3.Connection) -> Iterator[None]:
	for attempt in range(20):
		try:
			connection.execute("BEGIN IMMEDIATE")
			break
		except sqlite3.OperationalError as exc:
			if "locked" not in str(exc).lower() or attempt == 19:
				raise
			time.sleep(random.uniform(0.01, POLL_SECONDS))
	else:  # pragma: no cover - loop always breaks or raises
		raise HostQueueError("database_busy")
	try:
		yield
	except BaseException:
		connection.execute("ROLLBACK")
		raise
	else:
		connection.execute("COMMIT")


def bump_revision(connection: sqlite3.Connection) -> None:
	connection.execute("UPDATE meta SET revision=revision+1 WHERE singleton=1")


def row_json(row: sqlite3.Row) -> dict[str, Any]:
	return {key: row[key] for key in row.keys()}


def projected_row(row: sqlite3.Row, now_ms: int) -> dict[str, Any]:
	value = row_json(row)
	end_ms = row["admittedAtMs"] or row["finishedAtMs"] or now_ms
	value["waitMs"] = max(0, end_ms - row["enqueuedAtMs"])
	return value


def refresh_projection(root: Path, connection: sqlite3.Connection) -> None:
	lock_path = root / "projection.lock"
	fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
	try:
		os.fchmod(fd, 0o600)
		fcntl.flock(fd, fcntl.LOCK_EX)
		meta = connection.execute("SELECT * FROM meta WHERE singleton=1").fetchone()
		live = connection.execute(
			f"SELECT * FROM requests WHERE state IN ({','.join('?' for _ in LIVE_STATES)}) ORDER BY seq",
			LIVE_STATES,
		).fetchall()
		terminal = connection.execute(
			f"SELECT * FROM requests WHERE state IN ({','.join('?' for _ in TERMINAL_STATES)}) ORDER BY finishedAtMs DESC LIMIT 100",
			TERMINAL_STATES,
		).fetchall()
		now_ms = epoch_ms()
		position = 0
		rows = []
		for item in live:
			value = projected_row(item, now_ms)
			if item["state"] == "queued":
				position += 1
				value["position"] = position
			else:
				value["position"] = None
			rows.append(value)
		atomic_json(
			root / "ledger.json",
			{
				"schemaVersion": SCHEMA_VERSION,
				"uid": meta["uid"],
				"generation": meta["generation"],
				"capacity": meta["capacity"],
				"calibrated": bool(meta["calibrated"]),
				"revision": meta["revision"],
				"updatedAt": utc_now(),
				"live": rows,
				"recent": [projected_row(item, now_ms) for item in terminal],
			},
		)
	finally:
		fcntl.flock(fd, fcntl.LOCK_UN)
		os.close(fd)


def create_owner_lock(root: Path, request_id: str) -> tuple[int, os.stat_result, Path]:
	locks = root / "owners"
	ensure_directory(locks)
	path = locks / f"{request_id}.lock"
	flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
	fd = os.open(path, flags, 0o600)
	os.fchmod(fd, 0o600)
	fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
	return fd, os.fstat(fd), path


def probe_owner(root: Path, row: sqlite3.Row) -> str:
	path = root / "owners" / f"{row['ownerLockId']}.lock"
	try:
		fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
	except FileNotFoundError:
		return "unknown"
	except OSError:
		return "unknown"
	try:
		info = os.fstat(fd)
		if (
			info.st_uid != os.getuid()
			or info.st_dev != row["ownerLockDev"]
			or info.st_ino != row["ownerLockInode"]
		):
			return "unknown"
		try:
			fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
		except BlockingIOError:
			return "held"
		else:
			fcntl.flock(fd, fcntl.LOCK_UN)
			return "free"
	finally:
		os.close(fd)


def group_empty(pgid: int | None) -> bool | None:
	if not pgid or pgid <= 0:
		return True
	try:
		os.killpg(pgid, 0)
		return False
	except ProcessLookupError:
		return True
	except PermissionError:
		return None


def recover_abandoned(root: Path, connection: sqlite3.Connection, own_id: str) -> bool:
	rows = connection.execute(
		f"SELECT * FROM requests WHERE requestId!=? AND state IN ({','.join('?' for _ in LIVE_STATES)})",
		(own_id, *LIVE_STATES),
	).fetchall()
	updates: list[tuple[str, str]] = []
	for row in rows:
		owner = probe_owner(root, row)
		if owner != "free":
			continue
		if row["state"] in ("queued", "suspended") or not row["pgid"]:
			updates.append((row["requestId"], "abandoned"))
		else:
			empty = group_empty(row["pgid"])
			if empty is True:
				updates.append((row["requestId"], "abandoned"))
			elif row["state"] != "recovery_hold":
				updates.append((row["requestId"], "recovery_hold"))
	if not updates:
		return False
	changed = False
	now = epoch_ms()
	with immediate(connection):
		for request_id, target in updates:
			if target == "abandoned":
				cursor = connection.execute(
					f"UPDATE requests SET state='abandoned',finishedAt=?,finishedAtMs=?,outcome='owner_gone' WHERE requestId=? AND state IN ({','.join('?' for _ in LIVE_STATES)})",
					(utc_now(), now, request_id, *LIVE_STATES),
				)
			else:
				cursor = connection.execute(
					f"UPDATE requests SET state='recovery_hold',outcome='owner_gone_group_live' WHERE requestId=? AND state IN ({','.join('?' for _ in OCCUPIED_STATES)})",
					(request_id, *OCCUPIED_STATES),
				)
			changed = changed or cursor.rowcount > 0
		if changed:
			bump_revision(connection)
	if changed:
		refresh_projection(root, connection)
	return changed


def prune_terminal(root: Path, connection: sqlite3.Connection) -> int:
	rows = connection.execute(
		f"SELECT * FROM requests WHERE state IN ({','.join('?' for _ in TERMINAL_STATES)}) ORDER BY finishedAtMs DESC,seq DESC",
		TERMINAL_STATES,
	).fetchall()
	cutoff = epoch_ms() - TERMINAL_RETENTION_MS
	candidates = [
		row
		for index, row in enumerate(rows)
		if index >= MAX_TERMINAL_ROWS
		or (row["finishedAtMs"] is not None and row["finishedAtMs"] < cutoff)
	]
	deletable = [
		row
		for row in candidates
		if probe_owner(root, row) == "free" and group_empty(row["pgid"]) is True
	]
	if not deletable:
		return 0
	with immediate(connection):
		deleted = 0
		for row in deletable:
			deleted += connection.execute(
				f"DELETE FROM requests WHERE requestId=? AND state IN ({','.join('?' for _ in TERMINAL_STATES)})",
				(row["requestId"], *TERMINAL_STATES),
			).rowcount
		if deleted:
			bump_revision(connection)
	for row in deletable:
		path = root / "owners" / f"{row['ownerLockId']}.lock"
		try:
			info = path.lstat()
			if (
				info.st_uid == os.getuid()
				and info.st_dev == row["ownerLockDev"]
				and info.st_ino == row["ownerLockInode"]
			):
				path.unlink()
		except FileNotFoundError:
			pass
	return deleted


def heartbeat(connection: sqlite3.Connection, request_id: str) -> None:
	with immediate(connection):
		connection.execute(
			f"UPDATE requests SET heartbeatAt=?,heartbeatAtMs=? WHERE requestId=? AND state IN ({','.join('?' for _ in LIVE_STATES)})",
			(utc_now(), epoch_ms(), request_id, *LIVE_STATES),
		)
		bump_revision(connection)


def insert_queued(
	connection: sqlite3.Connection,
	request_id: str,
	lock_info: os.stat_result,
	worktree: str,
	head: str | None,
) -> None:
	now_text, now = utc_now(), epoch_ms()
	with immediate(connection):
		meta = connection.execute("SELECT nextSeq FROM meta WHERE singleton=1").fetchone()
		seq = meta["nextSeq"]
		connection.execute("UPDATE meta SET nextSeq=nextSeq+1 WHERE singleton=1")
		connection.execute(
			"""INSERT INTO requests(
				requestId,seq,previousSeq,protocolVersion,state,enqueuedAt,enqueuedAtMs,
				supervisorPid,ownerLockId,ownerLockDev,ownerLockInode,worktreeRealpath,
				head,executionIdClaim,heartbeatAt,heartbeatAtMs
			) VALUES(?,?,NULL,?,'queued',?,?,?,?,?,?,?,?,?,?,?)""",
			(
				request_id,
				seq,
				SCHEMA_VERSION,
				now_text,
				now,
				os.getpid(),
				request_id,
				lock_info.st_dev,
				lock_info.st_ino,
				os.path.realpath(worktree),
				head,
				os.environ.get("FLYWHEEL_EXEC_ID"),
				now_text,
				now,
			),
		)
		bump_revision(connection)


def suspend_stale_queued(root: Path, connection: sqlite3.Connection, own_id: str) -> None:
	cutoff = epoch_ms() - STALE_HEARTBEAT_MS
	rows = connection.execute(
		"SELECT * FROM requests WHERE requestId!=? AND state='queued' AND heartbeatAtMs<?",
		(own_id, cutoff),
	).fetchall()
	for row in rows:
		if probe_owner(root, row) != "held":
			continue
		with immediate(connection):
			changed = connection.execute(
				"UPDATE requests SET state='suspended',outcome='heartbeat_stale' WHERE requestId=? AND state='queued' AND heartbeatAtMs=?",
				(row["requestId"], row["heartbeatAtMs"]),
			).rowcount
			if changed:
				bump_revision(connection)
		if changed:
			refresh_projection(root, connection)


def try_admit(connection: sqlite3.Connection, request_id: str) -> tuple[bool, sqlite3.Row]:
	with immediate(connection):
		row = connection.execute("SELECT * FROM requests WHERE requestId=?", (request_id,)).fetchone()
		if row is None:
			raise HostQueueError("request_missing")
		if row["state"] == "suspended":
			meta = connection.execute("SELECT nextSeq FROM meta WHERE singleton=1").fetchone()
			connection.execute("UPDATE meta SET nextSeq=nextSeq+1 WHERE singleton=1")
			connection.execute(
				"UPDATE requests SET previousSeq=seq,seq=?,state='queued',outcome=NULL,heartbeatAt=?,heartbeatAtMs=? WHERE requestId=? AND state='suspended'",
				(meta["nextSeq"], utc_now(), epoch_ms(), request_id),
			)
			bump_revision(connection)
			row = connection.execute("SELECT * FROM requests WHERE requestId=?", (request_id,)).fetchone()
		if row["state"] != "queued":
			return row["state"] in OCCUPIED_STATES, row
		meta = connection.execute("SELECT capacity FROM meta WHERE singleton=1").fetchone()
		occupied = connection.execute(
			f"SELECT COUNT(*) count FROM requests WHERE state IN ({','.join('?' for _ in OCCUPIED_STATES)})",
			OCCUPIED_STATES,
		).fetchone()["count"]
		first = connection.execute("SELECT requestId FROM requests WHERE state='queued' ORDER BY seq LIMIT 1").fetchone()
		if occupied >= meta["capacity"] or first is None or first["requestId"] != request_id:
			return False, row
		now_text, now = utc_now(), epoch_ms()
		changed = connection.execute(
			"UPDATE requests SET state='reserved',admittedAt=?,admittedAtMs=?,heartbeatAt=?,heartbeatAtMs=? WHERE requestId=? AND state='queued'",
			(now_text, now, now_text, now, request_id),
		).rowcount
		if changed:
			bump_revision(connection)
		row = connection.execute("SELECT * FROM requests WHERE requestId=?", (request_id,)).fetchone()
		return changed == 1, row


def wait_position(connection: sqlite3.Connection, request_id: str) -> tuple[int, int, int, int]:
	row = connection.execute("SELECT seq,enqueuedAtMs FROM requests WHERE requestId=?", (request_id,)).fetchone()
	position = connection.execute(
		"SELECT COUNT(*) count FROM requests WHERE state='queued' AND seq<=?", (row["seq"],)
	).fetchone()["count"]
	meta = connection.execute("SELECT capacity FROM meta WHERE singleton=1").fetchone()
	running = connection.execute(
		f"SELECT COUNT(*) count FROM requests WHERE state IN ({','.join('?' for _ in OCCUPIED_STATES)})",
		OCCUPIED_STATES,
	).fetchone()["count"]
	return position, max(0, position - 1), running, meta["capacity"]


LAUNCHER = r"""
import json, os, sys
ready_fd=int(sys.argv[1]); go_fd=int(sys.argv[2]); command=json.loads(sys.argv[3]); extra_env=json.loads(sys.argv[4])
os.write(ready_fd,(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp()})+'\n').encode())
os.close(ready_fd)
token=os.read(go_fd,1)
os.close(go_fd)
if token != b'G': sys.exit(125)
environment=dict(os.environ); environment.update(extra_env)
os.execvpe(command[0],command,environment)
"""


WATCHDOG = r"""
import errno, os, signal, sys, time
fd=int(sys.argv[1]); pgid=int(sys.argv[2])
while os.read(fd,4096): pass
os.close(fd)
def alive():
    try: os.killpg(pgid,0); return True
    except ProcessLookupError: return False
    except PermissionError: return True
if alive():
    try: os.killpg(pgid,signal.SIGTERM)
    except ProcessLookupError: pass
deadline=time.monotonic()+5
while alive() and time.monotonic()<deadline: time.sleep(.05)
if alive():
    try: os.killpg(pgid,signal.SIGKILL)
    except ProcessLookupError: pass
"""


def start_barrier(
	command: Sequence[str], extra_env: dict[str, str]
) -> tuple[subprocess.Popen[Any], int, int, int]:
	ready_read, ready_write = os.pipe()
	go_read, go_write = os.pipe()
	try:
		launcher = subprocess.Popen(
			[
				sys.executable,
				"-c",
				LAUNCHER,
				str(ready_write),
				str(go_read),
				json.dumps(list(command)),
				json.dumps(extra_env),
			],
			stdin=subprocess.DEVNULL,
			start_new_session=True,
			pass_fds=(ready_write, go_read),
		)
	finally:
		os.close(ready_write)
		os.close(go_read)
	ready, _, _ = select.select([ready_read], [], [], 5.0)
	if not ready:
		launcher.kill()
		os.close(ready_read)
		os.close(go_write)
		raise HostQueueError("launcher_ready_timeout")
	try:
		message = json.loads(os.read(ready_read, 4096).decode("utf-8"))
	finally:
		os.close(ready_read)
	if message.get("pid") != launcher.pid or message.get("pgid") != launcher.pid:
		launcher.kill()
		os.close(go_write)
		raise HostQueueError("launcher_identity_invalid")
	return launcher, launcher.pid, launcher.pid, go_write


def start_watchdog(pgid: int) -> tuple[subprocess.Popen[Any], int]:
	lifeline_read, lifeline_write = os.pipe()
	try:
		watchdog = subprocess.Popen(
			[sys.executable, "-c", WATCHDOG, str(lifeline_read), str(pgid)],
			stdin=subprocess.DEVNULL,
			stdout=subprocess.DEVNULL,
			stderr=subprocess.DEVNULL,
			start_new_session=True,
			pass_fds=(lifeline_read,),
		)
	finally:
		os.close(lifeline_read)
	return watchdog, lifeline_write


def cleanup_group(pgid: int) -> bool:
	if group_empty(pgid) is True:
		return True
	try:
		os.killpg(pgid, signal.SIGTERM)
	except ProcessLookupError:
		return True
	except PermissionError:
		return False
	deadline = time.monotonic() + 5.0
	while time.monotonic() < deadline:
		if group_empty(pgid) is True:
			return True
		time.sleep(0.05)
	try:
		os.killpg(pgid, signal.SIGKILL)
	except ProcessLookupError:
		return True
	except PermissionError:
		return False
	deadline = time.monotonic() + 2.0
	while time.monotonic() < deadline:
		if group_empty(pgid) is True:
			return True
		time.sleep(0.05)
	return group_empty(pgid) is True


def terminalize(
	root: Path,
	connection: sqlite3.Connection,
	request_id: str,
	state: str,
	exit_code: int,
	outcome: str,
	receipt_path: str | None = None,
) -> None:
	with immediate(connection):
		connection.execute(
			"UPDATE requests SET state=?,finishedAt=?,finishedAtMs=?,exitCode=?,outcome=?,receiptPath=? WHERE requestId=?",
			(state, utc_now(), epoch_ms(), exit_code, outcome, receipt_path, request_id),
		)
		bump_revision(connection)
	refresh_projection(root, connection)


def result_receipt_path(result_path: str | None) -> str | None:
	if not result_path:
		return None
	try:
		value = json.loads(Path(result_path).read_text(encoding="utf-8"))
	except (OSError, json.JSONDecodeError):
		return None
	directory = value.get("directory") if isinstance(value, dict) else None
	return directory if isinstance(directory, str) and os.path.isabs(directory) else None


def run_supervised(
	root: Path,
	worktree: str,
	head: str | None,
	command: Sequence[str],
	result_path: str | None = None,
) -> int:
	if not command:
		raise HostQueueError("worker_command_required")
	ensure_directory(root)
	control = read_control(root)
	if control["mode"] != "enabled":
		print("PACKAGE_GATE_HOST_BYPASS mode=disabled", file=sys.stderr, flush=True)
		return subprocess.call(list(command), cwd=worktree if Path(worktree).is_dir() else None)
	connection = database(root)
	prune_terminal(root, connection)
	request_id = str(uuid.uuid4())
	owner_fd, lock_info, _ = create_owner_lock(root, request_id)
	requested_signal: int | None = None
	old_handlers: dict[int, Any] = {}

	def on_signal(number: int, _frame: Any) -> None:
		nonlocal requested_signal
		requested_signal = number

	for number in (signal.SIGINT, signal.SIGTERM):
		old_handlers[number] = signal.getsignal(number)
		signal.signal(number, on_signal)
	try:
		insert_queued(connection, request_id, lock_info, worktree, head)
		refresh_projection(root, connection)
		last_heartbeat = 0.0
		last_print = 0.0
		last_position: tuple[int, int, int, int] | None = None
		while True:
			if requested_signal is not None:
				terminalize(root, connection, request_id, "cancelled", 128 + requested_signal, "signal_while_queued")
				return 128 + requested_signal
			control = read_control(root)
			if control["mode"] != "enabled":
				terminalize(root, connection, request_id, "cancelled", 0, "host_disabled_bypass")
				print("PACKAGE_GATE_HOST_BYPASS mode=disabled queued_cancelled=yes", file=sys.stderr, flush=True)
				return subprocess.call(list(command), cwd=worktree if Path(worktree).is_dir() else None)
			recover_abandoned(root, connection, request_id)
			suspend_stale_queued(root, connection, request_id)
			admitted, row = try_admit(connection, request_id)
			if admitted:
				refresh_projection(root, connection)
				break
			now = time.monotonic()
			if now - last_heartbeat >= HEARTBEAT_SECONDS:
				heartbeat(connection, request_id)
				last_heartbeat = now
			position = wait_position(connection, request_id)
			if position != last_position or now - last_print >= WAIT_PRINT_SECONDS:
				wait_seconds = max(0, (epoch_ms() - row["enqueuedAtMs"]) // 1000)
				print(
					f"PACKAGE_GATE_WAIT request={request_id} 等待第 {position[0]} 位 / 前面 {position[1]} 个 / 已等 {wait_seconds}s 运行 {position[2]}/{position[3]}",
					file=sys.stderr,
					flush=True,
				)
				last_position, last_print = position, now
				refresh_projection(root, connection)
			time.sleep(POLL_SECONDS)

		launcher: subprocess.Popen[Any] | None = None
		watchdog: subprocess.Popen[Any] | None = None
		go_write: int | None = None
		lifeline_write: int | None = None
		try:
			launcher, worker_pid, pgid, go_write = start_barrier(
				command,
				{
					"FLYWHEEL_PACKAGE_GATE_REQUEST_ID": request_id,
					"FLYWHEEL_PACKAGE_GATE_SUBMITTED_AT_MS": str(row["enqueuedAtMs"]),
					"FLYWHEEL_PACKAGE_GATE_ADMITTED_AT_MS": str(row["admittedAtMs"]),
				},
			)
			watchdog, lifeline_write = start_watchdog(pgid)
			with immediate(connection):
				changed = connection.execute(
					"UPDATE requests SET workerPid=?,watchdogPid=?,pgid=?,heartbeatAt=?,heartbeatAtMs=? WHERE requestId=? AND state='reserved'",
					(worker_pid, watchdog.pid, pgid, utc_now(), epoch_ms(), request_id),
				).rowcount
				if changed != 1:
					raise HostQueueError("reservation_lost")
				bump_revision(connection)
			os.write(go_write, b"G")
			os.close(go_write)
			go_write = None
			with immediate(connection):
				connection.execute(
					"UPDATE requests SET state='running',heartbeatAt=?,heartbeatAtMs=? WHERE requestId=? AND state='reserved'",
					(utc_now(), epoch_ms(), request_id),
				)
				bump_revision(connection)
			refresh_projection(root, connection)
			last_heartbeat = time.monotonic()
			signal_cleanup_deadline: float | None = None
			while launcher.poll() is None:
				if requested_signal is not None and signal_cleanup_deadline is None:
					with immediate(connection):
						connection.execute("UPDATE requests SET state='draining',outcome='signal_cleanup' WHERE requestId=? AND state IN ('reserved','running')", (request_id,))
						bump_revision(connection)
					if lifeline_write is not None:
						os.close(lifeline_write)
						lifeline_write = None
					signal_cleanup_deadline = time.monotonic() + 7.0
				if signal_cleanup_deadline is not None and time.monotonic() >= signal_cleanup_deadline:
					cleanup_group(pgid)
					with contextlib.suppress(ProcessLookupError):
						launcher.kill()
				if time.monotonic() - last_heartbeat >= HEARTBEAT_SECONDS:
					heartbeat(connection, request_id)
					last_heartbeat = time.monotonic()
				time.sleep(POLL_SECONDS)
			exit_code = launcher.wait()
			clean = cleanup_group(pgid)
			if lifeline_write is not None:
				os.close(lifeline_write)
				lifeline_write = None
			with contextlib.suppress(subprocess.TimeoutExpired):
				watchdog.wait(timeout=7)
			if requested_signal is not None:
				code = 128 + requested_signal
				terminalize(root, connection, request_id, "finished", code, "signal_cleanup" if clean else "group_cleanup_failed")
				return code
			if not clean:
				terminalize(root, connection, request_id, "finished", 1, "group_cleanup_failed")
				return 1
			terminalize(
				root,
				connection,
				request_id,
				"finished",
				exit_code,
				"completed",
				result_receipt_path(result_path),
			)
			return exit_code
		except BaseException:
			if go_write is not None:
				os.close(go_write)
			if launcher is not None:
				cleanup_group(launcher.pid)
			if lifeline_write is not None:
				os.close(lifeline_write)
			terminalize(root, connection, request_id, "finished", 1, "host_queue_failure")
			raise
	finally:
		for number, handler in old_handlers.items():
			signal.signal(number, handler)
		fcntl.flock(owner_fd, fcntl.LOCK_UN)
		os.close(owner_fd)
		connection.close()


def configure(root: Path, capacity: int | None, mode: str | None) -> dict[str, Any]:
	connection = database(root)
	try:
		prune_terminal(root, connection)
		if capacity is not None:
			if capacity < 1 or capacity > MAX_CAPACITY:
				raise HostQueueError("capacity_invalid")
			with immediate(connection):
				live = connection.execute(
					f"SELECT COUNT(*) count FROM requests WHERE state IN ({','.join('?' for _ in LIVE_STATES)})",
					LIVE_STATES,
				).fetchone()["count"]
				if live:
					raise HostQueueError("capacity_change_requires_empty_queue")
				connection.execute("UPDATE meta SET capacity=?,calibrated=0 WHERE singleton=1", (capacity,))
				bump_revision(connection)
		if mode is not None:
			if mode == "enabled":
				live = connection.execute(
					f"SELECT COUNT(*) count FROM requests WHERE state IN ({','.join('?' for _ in LIVE_STATES)})",
					LIVE_STATES,
				).fetchone()["count"]
				if live:
					raise HostQueueError("enable_requires_empty_queue")
			write_control(root, mode)
		refresh_projection(root, connection)
		meta = row_json(connection.execute("SELECT * FROM meta WHERE singleton=1").fetchone())
		return {"control": read_control(root), "meta": meta}
	finally:
		connection.close()


def status(root: Path) -> dict[str, Any]:
	connection = database(root)
	try:
		prune_terminal(root, connection)
		refresh_projection(root, connection)
		return json.loads((root / "ledger.json").read_text(encoding="utf-8")) | {"control": read_control(root)}
	finally:
		connection.close()


def parser() -> argparse.ArgumentParser:
	result = argparse.ArgumentParser()
	sub = result.add_subparsers(dest="command", required=True)
	for name in ("config", "_test-config"):
		command = sub.add_parser(name)
		if name.startswith("_test"):
			command.add_argument("--state-root", required=True)
		command.add_argument("--capacity", type=int)
		mode = command.add_mutually_exclusive_group()
		mode.add_argument("--enable", action="store_true")
		mode.add_argument("--disable", action="store_true")
	for name in ("status", "_test-status"):
		command = sub.add_parser(name)
		if name.startswith("_test"):
			command.add_argument("--state-root", required=True)
		command.add_argument("--json", action="store_true")
	for name in ("run", "_test-run"):
		command = sub.add_parser(name)
		if name.startswith("_test"):
			command.add_argument("--state-root", required=True)
		command.add_argument("--worktree", required=True)
		command.add_argument("--head")
		command.add_argument("--result-path")
		command.add_argument("worker", nargs=argparse.REMAINDER)
	return result


def main(argv: Sequence[str] | None = None) -> int:
	args = parser().parse_args(argv)
	try:
		if args.command.startswith("_test"):
			require_test_mode()
			root = Path(args.state_root)
			if not root.is_absolute():
				raise HostQueueError("state_root_must_be_absolute")
		else:
			root = production_root()
		if args.command in ("config", "_test-config"):
			mode = "enabled" if args.enable else "disabled" if args.disable else None
			print(json.dumps(configure(root, args.capacity, mode), sort_keys=True))
			return 0
		if args.command in ("status", "_test-status"):
			value = status(root)
			print(json.dumps(value, sort_keys=True) if args.json else json.dumps(value, indent=2, sort_keys=True))
			return 0
		if args.command in ("run", "_test-run"):
			worker = list(args.worker)
			if worker[:1] == ["--"]:
				worker = worker[1:]
			return run_supervised(root, args.worktree, args.head, worker, args.result_path)
		raise HostQueueError("unsupported_command")
	except HostQueueError as exc:
		print(f"PACKAGE_GATE_HOST_ERROR {exc}", file=sys.stderr)
		return 70
	except Exception as exc:
		print(f"PACKAGE_GATE_HOST_ERROR {type(exc).__name__}:{exc}", file=sys.stderr)
		return 70


if __name__ == "__main__":
	raise SystemExit(main())
