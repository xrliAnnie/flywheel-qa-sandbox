#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="${ROOT}/scripts/lib/legacy-swap-broadcast-retirement.sh"
RESTART="${ROOT}/scripts/restart-services.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly1764-retire.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

passed=0
failed=0
pass() { passed=$((passed + 1)); echo "[TEST] ✓ $1"; }
fail() { failed=$((failed + 1)); echo "[TEST] ✗ $1"; }

if [[ ! -f "$LIB" ]]; then
	fail "retirement library exists"
	echo "[TEST] ${passed} passed, ${failed} failed"
	exit "$failed"
fi
# shellcheck source=/dev/null
source "$LIB"

create_mailbox() {
	local db="$1"
	mkdir -p "$(dirname "$db")"
	sqlite3 "$db" >/dev/null <<'SQL'
PRAGMA journal_mode = WAL;
CREATE TABLE mailbox (
  id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT, type TEXT, kind TEXT,
  collapse_key TEXT, state TEXT, acked_at TEXT, claimed_by TEXT,
  claim_expires_at TEXT, delivered_at TEXT, retry_count INTEGER,
  lease_retry_count INTEGER, next_retry_at TEXT, last_error TEXT,
  batch_id TEXT, dead_at TEXT, dead_reason TEXT
);
SQL
}

# Production still has pre-FLY-1573 CommDB shards. They carry the matching
# identity/state columns but not the two queue-era columns the cleanup wants to
# clear. The cutover must skip an empty legacy shard and settle a matching row
# using only columns that actually exist.
create_pre_fly1573_mailbox() {
	local db="$1"
	mkdir -p "$(dirname "$db")"
	sqlite3 "$db" >/dev/null <<'SQL'
PRAGMA journal_mode = WAL;
CREATE TABLE mailbox (
  id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT, type TEXT, kind TEXT,
  collapse_key TEXT, state TEXT, acked_at TEXT, claimed_by TEXT,
  claim_expires_at TEXT, retry_count INTEGER, next_retry_at TEXT,
  last_error TEXT, batch_id TEXT, dead_at TEXT, dead_reason TEXT
);
SQL
}

insert_row() {
	local db="$1" id="$2" from_agent="$3" type="$4" state="$5"
	sqlite3 "$db" "INSERT INTO mailbox(id,from_agent,to_agent,type,state,retry_count,lease_retry_count) VALUES('$id','$from_agent','lead-a','$type','$state',0,0);"
}

resolved_root="$(FLYWHEEL_COMM_ROOT="$TMP/root-override" FLYWHEEL_COMM_DIR="$TMP/dir-override" legacy_swap_comm_root)"
if [[ "$resolved_root" == "$TMP/root-override" ]]; then
	pass "comm root resolver matches runtime ROOT-before-DIR precedence"
else
	fail "comm root resolver drifted from commDbRootDir"
fi

FENCE_REPO="$TMP/fence-repo"
mkdir -p "$FENCE_REPO/packages/teamlead/src/bridge"
git -C "$FENCE_REPO" init -q
git -C "$FENCE_REPO" config user.email "fly1764-test@example.invalid"
git -C "$FENCE_REPO" config user.name "FLY-1764 test"
printf '%s\n' 'function broadcastLoadShed() {}' >"$FENCE_REPO/packages/teamlead/src/bridge/fleet-sensors.ts"
git -C "$FENCE_REPO" add packages/teamlead/src/bridge/fleet-sensors.ts
git -C "$FENCE_REPO" commit -qm "old producer"
old_sha="$(git -C "$FENCE_REPO" rev-parse HEAD)"
printf '%s\n' 'function routePressureAlertToOwner() {}' >"$FENCE_REPO/packages/teamlead/src/bridge/fleet-sensors.ts"
git -C "$FENCE_REPO" commit -qam "remove producer"
new_sha="$(git -C "$FENCE_REPO" rev-parse HEAD)"
if legacy_swap_retirement_required "$old_sha" "$FENCE_REPO" &&
	! legacy_swap_retirement_required "$new_sha" "$FENCE_REPO"; then
	pass "deployed-source fence runs once when crossing the producer-removal commit"
else
	fail "deployed-source fence did not distinguish old and new producer bytes"
fi
legacy_swap_retirement_required "" "$ROOT" >/dev/null 2>&1
empty_sha_rc=$?
legacy_swap_retirement_required "not-a-sha" "$ROOT" >/dev/null 2>&1
malformed_sha_rc=$?
legacy_swap_retirement_required "0000000000000000000000000000000000000000" "$ROOT" >/dev/null 2>&1
unknown_sha_rc=$?
if [[ "$empty_sha_rc" == "1" && "$malformed_sha_rc" == "1" && "$unknown_sha_rc" == "1" ]]; then
	pass "bootstrap and unreadable provenance skip the one-time fence without blocking restart"
else
	fail "bootstrap or unreadable provenance would block the restart"
fi

COMM="$TMP/comm"
DB_A="$COMM/project-a/comm.db"
DB_REMOVED="$COMM/config-removed-project/comm.db"
create_mailbox "$DB_A"
create_mailbox "$DB_REMOVED"
sqlite3 "$DB_A" >/dev/null <<'SQL'
INSERT INTO mailbox VALUES
 ('swap-broadcast:queued:lead','bridge','lead','instruction',NULL,NULL,'QUEUED',NULL,NULL,NULL,NULL,7,4,'old','retry','batch-x',NULL,NULL),
 ('swap-broadcast:leased:lead','bridge','lead','instruction','fleet_broadcast','fleet:swap','LEASED',NULL,'legacy-push','old','old',2,1,'old','retry','batch-y',NULL,NULL),
 ('swap-broadcast:acked:lead','bridge','lead','instruction',NULL,NULL,'ACKED','old-ack',NULL,NULL,NULL,0,0,NULL,NULL,NULL,NULL,NULL),
 ('swap-broadcast:dead:lead','bridge','lead','instruction',NULL,NULL,'DEAD',NULL,NULL,NULL,NULL,0,0,NULL,NULL,NULL,'old-dead','expired'),
 ('swap-broadcast:other-producer','lead-a','lead','instruction',NULL,NULL,'QUEUED',NULL,NULL,NULL,NULL,0,0,NULL,NULL,NULL,NULL,NULL),
 ('ordinary','bridge','lead','instruction',NULL,NULL,'QUEUED',NULL,NULL,NULL,NULL,0,0,NULL,NULL,NULL,NULL,NULL);
SQL
insert_row "$DB_REMOVED" "swap-broadcast:removed-project:lead" bridge instruction QUEUED

# The redesigned sensor stays enabled. Cleanup must not retain FLY-1749's
# sensor-off activation guard.
export FLYWHEEL_FLEET_SENSOR_SWAP=1
if retire_legacy_swap_broadcasts "$COMM" "2026-08-14T09:00:00.000Z" >/dev/null; then
	targets="$(sqlite3 -separator '|' "$DB_A" "SELECT id,state,COALESCE(acked_at,''),COALESCE(claimed_by,''),retry_count,lease_retry_count,COALESCE(next_retry_at,''),COALESCE(batch_id,'') FROM mailbox WHERE id IN ('swap-broadcast:queued:lead','swap-broadcast:leased:lead') ORDER BY id")"
	untouched="$(sqlite3 -separator '|' "$DB_A" "SELECT id,state,COALESCE(acked_at,'') FROM mailbox WHERE id IN ('swap-broadcast:acked:lead','swap-broadcast:dead:lead','swap-broadcast:other-producer','ordinary') ORDER BY id")"
	removed_state="$(sqlite3 "$DB_REMOVED" "SELECT state FROM mailbox WHERE id='swap-broadcast:removed-project:lead'")"
	if [[ "$targets" == $'swap-broadcast:leased:lead|ACKED|2026-08-14T09:00:00.000Z||0|0||\nswap-broadcast:queued:lead|ACKED|2026-08-14T09:00:00.000Z||0|0||' ]] &&
		[[ "$untouched" == $'ordinary|QUEUED|\nswap-broadcast:acked:lead|ACKED|old-ack\nswap-broadcast:dead:lead|DEAD|\nswap-broadcast:other-producer|QUEUED|' ]] &&
		[[ "$removed_state" == "ACKED" ]]; then
		pass "retires every live legacy row across on-disk projects and clears lease/retry state"
	else
		fail "retirement row-set mismatch targets=${targets@Q} untouched=${untouched@Q} removed=${removed_state}"
	fi
else
	fail "valid retirement unexpectedly failed while sensor stayed enabled"
fi

if retire_legacy_swap_broadcasts "$COMM" "2026-08-14T09:01:00.000Z" >/dev/null &&
	[[ "$(sqlite3 "$DB_A" "SELECT acked_at FROM mailbox WHERE id='swap-broadcast:queued:lead'")" == "2026-08-14T09:00:00.000Z" ]]; then
	pass "crash rerun is idempotent"
else
	fail "rerun changed an already-retired row"
fi

LEGACY_ROOT="$TMP/pre-fly1573"
LEGACY_EMPTY="$LEGACY_ROOT/empty/comm.db"
LEGACY_TARGET="$LEGACY_ROOT/target/comm.db"
create_pre_fly1573_mailbox "$LEGACY_EMPTY"
create_pre_fly1573_mailbox "$LEGACY_TARGET"
sqlite3 "$LEGACY_EMPTY" "INSERT INTO mailbox(id,from_agent,to_agent,type,state,retry_count) VALUES('ordinary','bridge','lead-a','instruction','QUEUED',7);"
sqlite3 "$LEGACY_TARGET" "INSERT INTO mailbox(id,from_agent,to_agent,type,state,claimed_by,retry_count,next_retry_at,last_error,batch_id,dead_at,dead_reason) VALUES('swap-broadcast:legacy-schema:lead','bridge','lead-a','instruction','LEASED','legacy-owner',9,'old','retry','batch-z','old-dead','old-reason');"
if retire_legacy_swap_broadcasts "$LEGACY_ROOT" "2026-08-14T09:01:30.000Z" >/dev/null &&
	[[ "$(sqlite3 "$LEGACY_EMPTY" "SELECT state || '|' || retry_count FROM mailbox WHERE id='ordinary'")" == "QUEUED|7" ]] &&
	[[ "$(sqlite3 -separator '|' "$LEGACY_TARGET" "SELECT state,acked_at,COALESCE(claimed_by,''),retry_count,COALESCE(next_retry_at,''),COALESCE(batch_id,''),COALESCE(dead_at,''),COALESCE(dead_reason,'') FROM mailbox WHERE id='swap-broadcast:legacy-schema:lead'")" == "ACKED|2026-08-14T09:01:30.000Z||0||||" ]]; then
	pass "pre-FLY-1573 shards skip zero-match DBs and settle targets using existing columns only"
else
	fail "pre-FLY-1573 schema compatibility failed"
fi

# Unknown schema must fail closed even if another database was already cleaned;
# after repairing that schema, the same operation converges on rerun.
BAD_ROOT="$TMP/bad-root"
GOOD_DB="$BAD_ROOT/a-good/comm.db"
BAD_DB="$BAD_ROOT/z-bad/comm.db"
create_mailbox "$GOOD_DB"
insert_row "$GOOD_DB" "swap-broadcast:partial:lead" bridge instruction LEASED
mkdir -p "$(dirname "$BAD_DB")"
sqlite3 "$BAD_DB" "CREATE TABLE mailbox(id TEXT PRIMARY KEY);"
if retire_legacy_swap_broadcasts "$BAD_ROOT" "2026-08-14T09:02:00.000Z" >/dev/null 2>&1; then
	fail "unknown schema must fail closed"
else
	pass "unknown schema fails closed"
fi
rm -f "$BAD_DB"
create_mailbox "$BAD_DB"
insert_row "$BAD_DB" "swap-broadcast:after-crash:lead" bridge instruction QUEUED
if retire_legacy_swap_broadcasts "$BAD_ROOT" "2026-08-14T09:03:00.000Z" >/dev/null &&
	[[ "$(sqlite3 "$GOOD_DB" "SELECT state FROM mailbox WHERE id='swap-broadcast:partial:lead'")" == "ACKED" ]] &&
	[[ "$(sqlite3 "$BAD_DB" "SELECT state FROM mailbox WHERE id='swap-broadcast:after-crash:lead'")" == "ACKED" ]]; then
	pass "partial crash state converges after schema repair"
else
	fail "rerun did not converge after schema repair"
fi

# A transient competing writer is retried; exhausted contention is fail-closed.
LOCK_DB="$TMP/locks/project/comm.db"
create_mailbox "$LOCK_DB"
insert_row "$LOCK_DB" "swap-broadcast:locked:lead" bridge instruction LEASED
LOCK_OUT="$TMP/lock.out"
{ printf 'BEGIN IMMEDIATE;\nSELECT "LOCK_HELD";\n'; sleep 0.4; printf 'ROLLBACK;\n'; } |
	sqlite3 "$LOCK_DB" >"$LOCK_OUT" 2>/dev/null &
LOCK_PID=$!
for _ in {1..40}; do
	grep -q 'LOCK_HELD' "$LOCK_OUT" 2>/dev/null && break
	sleep 0.02
done
if LEGACY_SWAP_BUSY_TIMEOUT_MS=50 LEGACY_SWAP_MAX_BUSY_ATTEMPTS=10 retire_legacy_swap_broadcasts "$TMP/locks" "2026-08-14T09:04:00.000Z" >/dev/null 2>&1 &&
	[[ "$(sqlite3 "$LOCK_DB" "SELECT state FROM mailbox WHERE id='swap-broadcast:locked:lead'")" == "ACKED" ]]; then
	pass "transient writer contention is retried"
else
	fail "transient writer contention did not recover"
fi
wait "$LOCK_PID"

insert_row "$LOCK_DB" "swap-broadcast:exhausted:lead" bridge instruction QUEUED
{ printf 'BEGIN IMMEDIATE;\nSELECT "LOCK_HELD";\n'; sleep 1; printf 'ROLLBACK;\n'; } |
	sqlite3 "$LOCK_DB" >"$LOCK_OUT" 2>/dev/null &
LOCK_PID=$!
for _ in {1..40}; do
	grep -q 'LOCK_HELD' "$LOCK_OUT" 2>/dev/null && break
	sleep 0.02
done
if LEGACY_SWAP_BUSY_TIMEOUT_MS=25 LEGACY_SWAP_MAX_BUSY_ATTEMPTS=2 retire_legacy_swap_broadcasts "$TMP/locks" "2026-08-14T09:05:00.000Z" >/dev/null 2>&1; then
	fail "exhausted writer contention must fail closed"
else
	pass "exhausted writer contention fails closed"
fi
wait "$LOCK_PID"

mkdir -p "$TMP/empty"
if retire_legacy_swap_broadcasts "$TMP/empty" >/dev/null 2>&1; then
	fail "empty comm root must fail closed"
else
	pass "empty comm root fails closed"
fi

# The deployment fence must be old Bridge stopped → new bytes built → cleanup
# and postcondition → new Bridge started.
source_line="$(grep -n 'source .*legacy-swap-broadcast-retirement.sh' "$RESTART" | head -1 | cut -d: -f1)"
deploy_body="$TMP/deploy-body.sh"
awk '/^deploy_and_verify\(\)/,/^}/' "$RESTART" >"$deploy_body"
stop_line="$(grep -n 'if ! stop_bridge' "$deploy_body" | head -1 | cut -d: -f1)"
build_line="$(grep -n 'if ! build_project' "$deploy_body" | head -1 | cut -d: -f1)"
hook_line="$(grep -n 'if ! retire_legacy_swap_broadcasts' "$deploy_body" | head -1 | cut -d: -f1)"
start_line="$(grep -n '^[[:space:]]*start_bridge$' "$deploy_body" | head -1 | cut -d: -f1)"
if [[ -n "$source_line" && -n "$stop_line" && -n "$build_line" && -n "$hook_line" && -n "$start_line" ]] &&
	(( stop_line < build_line && build_line < hook_line && hook_line < start_line )) &&
	grep -B3 'if ! retire_legacy_swap_broadcasts' "$deploy_body" | grep -q 'restart_bridge.*true'; then
	pass "restart wires cleanup after stop/build and before the new Bridge start"
else
	fail "restart cleanup ordering is not producer-fenced and fail-closed"
fi

# Exercise deploy_and_verify itself with production boundaries stubbed. A
# cleanup failure happens after the old Bridge stopped, so returning without
# rollback leaves the control plane down even though the old bytes are known
# good. The observable contract is one rollback attempt and a non-zero deploy.
rollback_log="$TMP/retirement-rollback.log"
: >"$rollback_log"
bash -c '
  set -uo pipefail
  source "$1"
  ROLLBACK_LOG="$2"
  RESTART_NOTICE_STARTED=false
  RESTART_TERMINAL_REPORTED=false
  RESTART_REASON=fly1764-test
  DEPLOYED_SHA=1111111111111111111111111111111111111111
  CURRENT_HEAD=2222222222222222222222222222222222222222
  FLYWHEEL_DIR=/fixture/flywheel
  SKIP_BUILD=true
  RESTART_CODE_ROLLBACK_DISABLED=0
  restart_bridge=true
  restart_all_leads=false
  notify_routine() { :; }
  audit_tmux_qa_residue_read_only() { :; }
  pause_admission_best_effort() { :; }
  resume_admission_best_effort() { :; }
  stop_bridge() { return 0; }
  log() { :; }
  alert_severe() { :; }
  legacy_swap_retirement_required() { return 0; }
  retire_legacy_swap_broadcasts() { return 1; }
  rollback_and_restart() { printf "%s\n" "$1" >>"$ROLLBACK_LOG"; return 0; }
  deploy_and_verify
' _ "$deploy_body" "$rollback_log" >/dev/null 2>&1
rollback_rc=$?
if [[ "$rollback_rc" == "1" ]] &&
	[[ "$(cat "$rollback_log")" == "1111111111111111111111111111111111111111" ]]; then
	pass "cleanup failure rolls back to the known-good deployment before returning"
else
	fail "cleanup failure did not restore the old deployment (rc=${rollback_rc}, calls=$(cat "$rollback_log"))"
fi

echo "[TEST] ${passed} passed, ${failed} failed"
exit "$failed"
