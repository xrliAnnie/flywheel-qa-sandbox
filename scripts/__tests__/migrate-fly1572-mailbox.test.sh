#!/bin/bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FLYWHEEL_HOME="$TEST_ROOT/flywheel"
COMM_DIR="$FLYWHEEL_HOME/comm/test"
COMM_DB="$COMM_DIR/comm.db"
mkdir -p "$COMM_DIR"
sqlite3 "$COMM_DB" "CREATE TABLE messages (id TEXT); CREATE TABLE lead_inbox (id TEXT);"
cp "$COMM_DB" "$COMM_DB.pre-fly1572-test"
mkdir -p "$COMM_DIR/.fly1572-staging"
cp "$COMM_DB" "$COMM_DIR/.fly1572-staging/comm.db"
mkdir -p "$FLYWHEEL_HOME/db-backups" "$FLYWHEEL_HOME/comm/messages-only"
cp "$COMM_DB" "$FLYWHEEL_HOME/db-backups/legacy.db"
cp "$COMM_DB" "$FLYWHEEL_HOME/teamlead.db"
cp "$COMM_DB" "$FLYWHEEL_HOME/flywheel-v2-era-leftover.db"
sqlite3 "$FLYWHEEL_HOME/comm/messages-only/comm.db" "CREATE TABLE messages (id TEXT);"

OUTPUT="$({
	cd "$REPO_ROOT"
	FLYWHEEL_HOME="$FLYWHEEL_HOME" FLYWHEEL_COMM_DB="$COMM_DB" \
		pnpm exec tsx scripts/migrate-fly1572-mailbox.ts --inventory
})"

test "$(jq '.inventory | length' <<<"$OUTPUT")" -eq 2
jq -e --arg path "$COMM_DB" '.inventory[] | select(.path == $path and .state == "legacy")' <<<"$OUTPUT" >/dev/null
jq -e --arg path "$FLYWHEEL_HOME/comm/messages-only/comm.db" '.inventory[] | select(.path == $path and .state == "unknown")' <<<"$OUTPUT" >/dev/null
jq -e --arg root "$FLYWHEEL_HOME" '
	all(.inventory[].path;
		. != ($root + "/teamlead.db") and
		. != ($root + "/flywheel-v2-era-leftover.db") and
		(startswith($root + "/db-backups/") | not))
' <<<"$OUTPUT" >/dev/null

# FLY-1646: a half-migrated shard (legacy tables AND mailbox tables coexisting)
# must be reported as a distinct `mixed` state and must never be silently
# skipped as "already migrated". Production `growth` was left in exactly this
# shape by the aborted FLY-1572 rollout: a clean migrated DB drops `messages`
# and `lead_inbox`, so their presence alongside mailbox_migration_meta proves
# the cutover did not complete.
#
# Isolated FLYWHEEL_HOME so the `mixed` refusal is the ONLY thing that can fail
# the write run (the shared home also holds an `unknown` shard, whose guard
# fires first).
MIXED_HOME="$TEST_ROOT/flywheel-mixed"
MIXED_DIR="$MIXED_HOME/comm/mixed"
mkdir -p "$MIXED_DIR"
sqlite3 "$MIXED_DIR/comm.db" "
	CREATE TABLE messages (id TEXT);
	CREATE TABLE lead_inbox (id TEXT);
	CREATE TABLE mailbox (id TEXT);
	CREATE TABLE mailbox_log (id TEXT);
	CREATE TABLE mailbox_migration_meta (singleton INTEGER, schema_generation TEXT);
	INSERT INTO mailbox_migration_meta VALUES (1, 'mailbox_v1');"

# FLYWHEEL_COMM_DB is unset on purpose: `discover()` honors it, so a stray
# value in the operator's shell silently pulls the real production CommDB into
# the inventory.
MIXED_OUTPUT="$({
	cd "$REPO_ROOT"
	env -u FLYWHEEL_COMM_DB FLYWHEEL_HOME="$MIXED_HOME" \
		pnpm exec tsx scripts/migrate-fly1572-mailbox.ts --inventory
})"
test "$(jq '.inventory | length' <<<"$MIXED_OUTPUT")" -eq 1
jq -e --arg path "$MIXED_DIR/comm.db" \
	'.inventory[] | select(.path == $path and .state == "mixed")' <<<"$MIXED_OUTPUT" >/dev/null

# ...and a write run must refuse outright rather than skip the shard.
MIXED_RC=0
MIXED_ERR="$({
	cd "$REPO_ROOT"
	env -u FLYWHEEL_COMM_DB FLYWHEEL_HOME="$MIXED_HOME" \
		pnpm exec tsx scripts/migrate-fly1572-mailbox.ts --confirm-quiesced 2>&1
} )" || MIXED_RC=$?
test "$MIXED_RC" -ne 0
grep -q "half-migrated" <<<"$MIXED_ERR"
# the shard must be untouched: refusal, not a partial cutover
test ! -e "$MIXED_DIR/comm.db.migration-swap-intent.json"
test -z "$(find "$MIXED_DIR" -maxdepth 1 -name '.fly1572-*' -print -quit)"

# ...but --rollback is the recovery path FOR a half-migrated shard, so the
# `mixed` guard must not strand it. Exercising rollback here would need a real
# swap-intent + backup pair; asserting the guard does not fire is enough.
ROLLBACK_RC=0
ROLLBACK_ERR="$({
	cd "$REPO_ROOT"
	env -u FLYWHEEL_COMM_DB FLYWHEEL_HOME="$MIXED_HOME" \
		pnpm exec tsx scripts/migrate-fly1572-mailbox.ts --confirm-quiesced --rollback 2>&1
} )" || ROLLBACK_RC=$?
test "$ROLLBACK_RC" -eq 0
if grep -q "half-migrated" <<<"$ROLLBACK_ERR"; then
	echo "rollback incorrectly rejected mixed-state recovery" >&2
	exit 1
fi

# FLY-1649 G2/G3: exercise the no-intent recovery path with the real
# backupCommDb artifact shape (standalone DB + refs tree + manifest). Replacing
# the whole shard removes mixed-state debris without ever dropping live legacy
# tables in place.
RECOVERY_DIR="$TEST_ROOT/growth-recovery"
RECOVERY_DB="$RECOVERY_DIR/comm.db"
RECOVERY_BACKUP="$RECOVERY_DB.pre-fly1572-verified"
mkdir -p "$RECOVERY_DIR/refs"
sqlite3 "$RECOVERY_DB" "
	CREATE TABLE messages (id TEXT PRIMARY KEY, content BLOB, attempts INTEGER);
	CREATE TABLE lead_inbox (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, content TEXT);
	INSERT INTO messages VALUES ('m-1', X'00ff10', 2), ('m-2', NULL, 0);
	INSERT INTO lead_inbox VALUES (7, 'lead-7', 'keep legacy alive');"
printf 'content-ref-bytes' > "$RECOVERY_DIR/refs/m-1.bin"
(
	cd "$REPO_ROOT"
	DB_PATH="$RECOVERY_DB" BACKUP_PATH="$RECOVERY_BACKUP" pnpm exec tsx -e \
		'import { backupCommDb } from "./packages/flywheel-comm/src/mailbox-migration.ts"; backupCommDb(process.env.DB_PATH!, process.env.BACKUP_PATH!).catch((error) => { console.error(error); process.exitCode = 1; });'
)
test "$(sqlite3 "$RECOVERY_BACKUP" "PRAGMA quick_check;")" = "ok"
test -f "$RECOVERY_BACKUP.refs-manifest.json"
test "$(cat "$RECOVERY_BACKUP.refs/m-1.bin")" = "content-ref-bytes"
BACKUP_STATE="$({
	cd "$REPO_ROOT"
	pnpm exec tsx scripts/migrate-fly1572-mailbox.ts --inventory --db "$RECOVERY_BACKUP"
})"
jq -e '.inventory == [{"path": $path, "state": "legacy"}]' \
	--arg path "$RECOVERY_BACKUP" <<<"$BACKUP_STATE" >/dev/null

DIGEST_FIXTURE="$REPO_ROOT/scripts/__tests__/fixtures/fly1649-legacy-mailbox-digest.ts"
BEFORE_DIGEST="$({ cd "$REPO_ROOT"; pnpm exec tsx "$DIGEST_FIXTURE" "$RECOVERY_DB"; })"
sqlite3 "$RECOVERY_DB" "
	CREATE TABLE mailbox (id TEXT PRIMARY KEY);
	CREATE TABLE mailbox_log (event_id TEXT PRIMARY KEY);
	CREATE TABLE mailbox_migration_meta (singleton INTEGER PRIMARY KEY, schema_generation TEXT);
	INSERT INTO mailbox_migration_meta VALUES (1, 'mailbox_v1');"
RECOVERY_MIXED="$({
	cd "$REPO_ROOT"
	pnpm exec tsx scripts/migrate-fly1572-mailbox.ts --inventory --db "$RECOVERY_DB"
})"
jq -e '.inventory == [{"path": $path, "state": "mixed"}]' \
	--arg path "$RECOVERY_DB" <<<"$RECOVERY_MIXED" >/dev/null

mv "$RECOVERY_DB" "$RECOVERY_DB.mixed-evidence"
mv "$RECOVERY_DIR/refs" "$RECOVERY_DIR/refs.mixed-evidence"
cp "$RECOVERY_BACKUP" "$RECOVERY_DB"
cp -R "$RECOVERY_BACKUP.refs" "$RECOVERY_DIR/refs"
AFTER_DIGEST="$({ cd "$REPO_ROOT"; pnpm exec tsx "$DIGEST_FIXTURE" "$RECOVERY_DB"; })"
test "$AFTER_DIGEST" = "$BEFORE_DIGEST"
test "$(cat "$RECOVERY_DIR/refs/m-1.bin")" = "content-ref-bytes"
test -z "$(sqlite3 "$RECOVERY_DB" "SELECT name FROM sqlite_master WHERE name IN ('mailbox','mailbox_log','mailbox_migration_meta');")"
RECOVERED_STATE="$({
	cd "$REPO_ROOT"
	pnpm exec tsx scripts/migrate-fly1572-mailbox.ts --inventory --db "$RECOVERY_DB"
})"
jq -e '.inventory == [{"path": $path, "state": "legacy"}]' \
	--arg path "$RECOVERY_DB" <<<"$RECOVERED_STATE" >/dev/null

sqlite3 "$RECOVERY_DB" "UPDATE messages SET attempts = attempts + 1 WHERE id = 'm-1';"
NEGATIVE_DIGEST="$({ cd "$REPO_ROOT"; pnpm exec tsx "$DIGEST_FIXTURE" "$RECOVERY_DB"; })"
test "$NEGATIVE_DIGEST" != "$BEFORE_DIGEST"

# FLY-1649: already-migrated shards still pass through canonical permission
# repair plus a real CommDB open. Suffixed forensic artifacts are deliberately
# outside that boundary and must remain untouched.
MIGRATED_DIR="$TEST_ROOT/flywheel-migrated/comm/test"
MIGRATED_DB="$MIGRATED_DIR/comm.db"
mkdir -p "$MIGRATED_DIR"
(
	cd "$REPO_ROOT"
	DB_PATH="$MIGRATED_DB" pnpm exec tsx -e \
		'import { CommDB } from "./packages/flywheel-comm/src/db.ts"; const db = new CommDB(process.env.DB_PATH!); db.close();'
)
rm -f "$MIGRATED_DB-wal" "$MIGRATED_DB-shm"
sqlite3 "$MIGRATED_DB" "PRAGMA journal_mode=DELETE;" >/dev/null
chmod 0400 "$MIGRATED_DB"
FORENSIC_SHM="$MIGRATED_DB-shm.migrated-r2-failed-20260806"
: > "$FORENSIC_SHM"
chmod 0444 "$FORENSIC_SHM"

MIGRATED_RC=0
MIGRATED_OUTPUT="$({
	cd "$REPO_ROOT"
	pnpm exec tsx scripts/migrate-fly1572-mailbox.ts \
		--confirm-quiesced --db "$MIGRATED_DB" 2>&1
})" || MIGRATED_RC=$?
test "$MIGRATED_RC" -eq 0
if stat -f %Lp "$MIGRATED_DB" >/dev/null 2>&1; then
	test "$(stat -f %Lp "$MIGRATED_DB")" = "600"
	test "$(stat -f %Lp "$FORENSIC_SHM")" = "444"
else
	test "$(stat -c %a "$MIGRATED_DB")" = "600"
	test "$(stat -c %a "$FORENSIC_SHM")" = "444"
fi

# A canonical sidecar is part of the shard and must fail loud before open;
# unlike the suffixed evidence above, it can reproduce the exact r2 hazard.
: > "$MIGRATED_DB-shm"
chmod 0444 "$MIGRATED_DB-shm"
SIDE_RC=0
SIDE_ERR="$({
	cd "$REPO_ROOT"
	pnpm exec tsx scripts/migrate-fly1572-mailbox.ts \
		--confirm-quiesced --db "$MIGRATED_DB" 2>&1
})" || SIDE_RC=$?
test "$SIDE_RC" -ne 0
grep -Fq "$MIGRATED_DB-shm" <<<"$SIDE_ERR"
grep -q "mode=0444" <<<"$SIDE_ERR"
grep -q "chmod 0600" <<<"$SIDE_ERR"
if grep -Fq "$FORENSIC_SHM" <<<"$SIDE_ERR"; then
	echo "canonical sidecar diagnostic named the unrelated forensic suffix" >&2
	exit 1
fi

echo "migrate-fly1572-mailbox: PASS"
