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
grep -qv "half-migrated" <<<"$ROLLBACK_ERR"

echo "migrate-fly1572-mailbox: PASS"
