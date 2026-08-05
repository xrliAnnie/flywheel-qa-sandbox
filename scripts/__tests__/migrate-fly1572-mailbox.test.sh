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

echo "migrate-fly1572-mailbox: PASS"
