#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/fly2278-rollback-attempt-versions.sh"
TMP="$(mktemp -d -t fly2278-rollback-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/teamlead.db"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

before='{ "table" : "workflow_rework_delivery" , "pk" : "rework-1" }'
after='{"table":"workflow_rework_delivery","pk":"rework-1","routeRevision":4}'

sqlite3 "$DB" <<SQL
CREATE TABLE workflow_delivery_attempt (
  attempt_id TEXT PRIMARY KEY,
  contract_ref_json TEXT NOT NULL
);
CREATE TABLE workflow_run_event (
  event_uid TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSON NOT NULL
);
INSERT INTO workflow_delivery_attempt(attempt_id, contract_ref_json)
VALUES ('attempt-1', '$after');
INSERT INTO workflow_run_event(event_uid, kind, payload)
VALUES (
  'delivery_attempt_version_upgraded:attempt-1',
  'delivery_attempt_version_upgraded',
  json_object('attemptId', 'attempt-1', 'before', '$before', 'after', '$after')
);
SQL

dry_run="$($SCRIPT --db "$DB")"
[[ "$dry_run" == *'mode=dry-run eligible=1 already_restored=0 drifted=0 missing=0 invalid_events=0'* ]] \
  || fail "dry-run did not report the exact eligible cohort"
[[ "$(sqlite3 "$DB" "SELECT contract_ref_json FROM workflow_delivery_attempt WHERE attempt_id='attempt-1'")" == "$after" ]] \
  || fail "dry-run mutated the database"

apply_output="$($SCRIPT --db "$DB" --apply)"
[[ "$apply_output" == *'applied=1'* ]] || fail "apply did not restore one row"
[[ "$(sqlite3 "$DB" "SELECT contract_ref_json FROM workflow_delivery_attempt WHERE attempt_id='attempt-1'")" == "$before" ]] \
  || fail "apply did not restore the byte-exact before value"

replay_output="$($SCRIPT --db "$DB" --apply)"
[[ "$replay_output" == *'eligible=0 already_restored=1'* && "$replay_output" == *'applied=0'* ]] \
  || fail "apply replay was not idempotent"

sqlite3 "$DB" "UPDATE workflow_delivery_attempt SET contract_ref_json='drifted-after-upgrade' WHERE attempt_id='attempt-1'"
set +e
drift_output="$($SCRIPT --db "$DB" --apply 2>&1)"
drift_rc=$?
set -e
[[ "$drift_rc" -ne 0 ]] || fail "drifted row was accepted"
[[ "$drift_output" == *'drifted=1'* ]] || fail "drifted row was not reported"
[[ "$(sqlite3 "$DB" "SELECT contract_ref_json FROM workflow_delivery_attempt WHERE attempt_id='attempt-1'")" == 'drifted-after-upgrade' ]] \
  || fail "drifted row was mutated"

printf 'PASS: FLY-2278 rollback dry-run, exact restore, replay, and drift fence\n'
