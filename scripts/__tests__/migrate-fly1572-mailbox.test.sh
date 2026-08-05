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

OUTPUT="$({
	cd "$REPO_ROOT"
	FLYWHEEL_HOME="$FLYWHEEL_HOME" FLYWHEEL_COMM_DB="$COMM_DB" \
		pnpm exec tsx scripts/migrate-fly1572-mailbox.ts --inventory
})"

test "$(jq '.inventory | length' <<<"$OUTPUT")" -eq 1
test "$(jq -r '.inventory[0].path' <<<"$OUTPUT")" = "$COMM_DB"

echo "migrate-fly1572-mailbox: PASS"
