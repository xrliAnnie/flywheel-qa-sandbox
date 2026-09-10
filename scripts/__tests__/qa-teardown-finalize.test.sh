#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="$SCRIPT_DIR/lib/qa-teardown-finalize.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$*" >&2; }

FAKE_TEARDOWN="$TEST_ROOT/fake-teardown.sh"
cat > "$FAKE_TEARDOWN" <<'SH'
#!/usr/bin/env bash
slot="$1"
printf '%s\n' "$slot" >> "$QA_FAKE_CALLS"
printf 'teardown output for slot %s\n' "$slot"
if [[ "${QA_FAKE_REPLACE_RECEIPT_SLOT:-}" == "$slot" ]]; then
  printf 'invocation=concurrent-new\ntimestamp=now\nrc=9\n' \
    > "${QA_TEARDOWN_RECEIPT_ROOT}/flywheel-test-slot-${slot}.teardown-failed"
fi
[[ ",${QA_FAKE_FAIL_SLOTS:-}," == *",${slot},"* ]] && exit 7
exit 0
SH
chmod +x "$FAKE_TEARDOWN"

if [[ ! -r "$HELPER" ]]; then
  printf 'RED: missing %s\n' "$HELPER" >&2
  exit 1
fi
# shellcheck source=../lib/qa-teardown-finalize.sh
source "$HELPER"

reset_case() {
  local name="$1"
  CASE_ROOT="$TEST_ROOT/$name"
  mkdir -p "$CASE_ROOT/logs" "$CASE_ROOT/receipts"
  QA_FAKE_CALLS="$CASE_ROOT/calls"
  : > "$QA_FAKE_CALLS"
  QA_TEARDOWN_SCRIPT="$FAKE_TEARDOWN"
  QA_TEARDOWN_RECEIPT_ROOT="$CASE_ROOT/receipts"
  QA_FAKE_FAIL_SLOTS=""
  QA_FAKE_REPLACE_RECEIPT_SLOT=""
  QA_TEARDOWN_FINALIZER_INVOCATION=""
  QA_TEARDOWN_FINALIZER_ACTIVE=0
  QA_TEARDOWN_FINALIZER_RC=0
  export QA_FAKE_CALLS QA_TEARDOWN_RECEIPT_ROOT QA_FAKE_FAIL_SLOTS QA_FAKE_REPLACE_RECEIPT_SLOT
  unset QA_TEARDOWN_FINALIZED_SLOT_1 QA_TEARDOWN_FINALIZED_SLOT_2 QA_TEARDOWN_FINALIZED_SLOT_3
}

echo "Test: FLY-1482 finalizer attempts every slot and aggregates failures"
reset_case aggregate
QA_FAKE_FAIL_SLOTS="2"
export QA_FAKE_FAIL_SLOTS
rc=0
qa_finalize_teardown_slots "$CASE_ROOT/logs" 1 2 3 2>"$CASE_ROOT/stderr" || rc=$?
receipt="$CASE_ROOT/receipts/flywheel-test-slot-2.teardown-failed"
if [[ "$rc" -ne 0 && "$(tr '\n' ',' < "$QA_FAKE_CALLS")" == "1,2,3," \
    && -f "$receipt" && "$(cat "$receipt")" == *"rc=7"* \
    && "$(cat "$receipt")" == *"teardown output for slot 2"* \
    && "$(cat "$CASE_ROOT/stderr")" == *"slot 2 teardown failed"* ]]; then
  pass "later slots still run; the failed slot is loud and leaves an evidence receipt"
else
  fail "aggregate contract mismatch rc=$rc calls=[$(cat "$QA_FAKE_CALLS")] receipt=[$(cat "$receipt" 2>/dev/null)]"
fi

echo "Test: FLY-1482 invocation and per-slot guards make repeated cleanup idempotent"
rc2=0
qa_finalize_teardown_slots "$CASE_ROOT/logs" 2 3 >/dev/null 2>&1 || rc2=$?
if [[ "$rc2" -ne 0 && "$(tr '\n' ',' < "$QA_FAKE_CALLS")" == "1,2,3," ]]; then
  pass "a repeated trap invocation reruns no slot and returns the cached aggregate failure"
else
  fail "idempotency mismatch rc=$rc2 calls=[$(cat "$QA_FAKE_CALLS")]"
fi

echo "Test: FLY-1482 success clears only the receipt observed before teardown"
reset_case old-receipt
old="$CASE_ROOT/receipts/flywheel-test-slot-1.teardown-failed"
printf 'invocation=old-nonce\ntimestamp=old\nrc=7\n' > "$old"
qa_finalize_teardown_slots "$CASE_ROOT/logs" 1 >/dev/null 2>&1 || true
if [[ ! -e "$old" ]]; then
  pass "successful teardown clears its unchanged pre-existing failure receipt"
else
  fail "unchanged old receipt survived successful teardown"
fi

reset_case concurrent-receipt
concurrent="$CASE_ROOT/receipts/flywheel-test-slot-1.teardown-failed"
printf 'invocation=old-nonce\ntimestamp=old\nrc=7\n' > "$concurrent"
QA_FAKE_REPLACE_RECEIPT_SLOT=1
export QA_FAKE_REPLACE_RECEIPT_SLOT
qa_finalize_teardown_slots "$CASE_ROOT/logs" 1 >/dev/null 2>&1 || true
if [[ -f "$concurrent" && "$(sed -n 's/^invocation=//p' "$concurrent" | head -1)" == "concurrent-new" ]]; then
  pass "successful teardown preserves a concurrently replaced receipt"
else
  fail "success deleted or changed the concurrent receipt"
fi

echo "Test: FLY-1482 EXIT policy preserves primary rc and promotes cleanup-only failure"
run_exit_policy() {
  local primary="$1" fail_slots="$2" case_name="$3"
  (
    reset_case "$case_name"
    QA_FAKE_FAIL_SLOTS="$fail_slots"
    export QA_FAKE_FAIL_SLOTS
    qa_test_exit_trap() {
      local primary_rc=$?
      trap - EXIT
      set +e
      qa_finalize_teardown_slots "$CASE_ROOT/logs" 1 >/dev/null 2>&1
      local cleanup_rc=$?
      (( primary_rc != 0 )) && exit "$primary_rc"
      (( cleanup_rc != 0 )) && exit 2
      exit 0
    }
    trap qa_test_exit_trap EXIT
    exit "$primary"
  )
}
primary_rc=0; run_exit_policy 5 1 primary-wins || primary_rc=$?
cleanup_rc=0; run_exit_policy 0 1 cleanup-promoted || cleanup_rc=$?
ok_rc=0; run_exit_policy 0 "" all-clean || ok_rc=$?
if [[ "$primary_rc" == "5" && "$cleanup_rc" == "2" && "$ok_rc" == "0" ]]; then
  pass "primary failure wins; cleanup-only failure is exit 2; all-clean is zero"
else
  fail "exit policy mismatch primary=$primary_rc cleanup=$cleanup_rc clean=$ok_rc"
fi

echo "Test: FLY-1482 QA smoke entry points use the shared observable finalizer"
wire_ok=1
for smoke in qa-fly-1189-room-smoke.sh qa-fly-529-roundtable-smoke.sh \
    qa-fly-529-alert-smoke.sh qa-fly-153-mirror-smoke.sh; do
  grep -q 'source .*qa-teardown-finalize.sh' "$SCRIPT_DIR/$smoke" || wire_ok=0
  grep -q 'PASS_WITH_TEARDOWN_FAILURE' "$SCRIPT_DIR/$smoke" || wire_ok=0
done
grep -q 'qa_finalize_teardown_slots "$trial_dir" "$SLOT"' \
  "$SCRIPT_DIR/qa-fly-60-driver.sh" || wire_ok=0
if [[ "$wire_ok" == "1" ]]; then
  pass "four EXIT traps and the FLY-60 continue path share the same receipt-producing helper"
else
  fail "one or more QA cleanup entry points bypasses the observable finalizer"
fi

echo "Test: FLY-2454 teardown archives slot isolation evidence before deleting the slot"
TEARDOWN_SCRIPT="$SCRIPT_DIR/test-teardown.sh"
ARCHIVE_SLOT="$TEST_ROOT/archive-slot"
ARCHIVE_ROOT="$TEST_ROOT/qa-evidence"
mkdir -p "$ARCHIVE_SLOT/state/kill-ledger"
printf '%s\n' '{"refusal":"isolation_boundary","target":2231}' \
  > "$ARCHIVE_SLOT/state/kill-ledger/20260909.ndjson"
printf '%s\n' '{"contract":"slot"}' > "$ARCHIVE_SLOT/launch-manifest.json"
sqlite3 "$ARCHIVE_SLOT/teamlead.db" <<'SQL'
CREATE TABLE session_events (
  id INTEGER PRIMARY KEY,
  event_id TEXT,
  ts TEXT,
  execution_id TEXT,
  issue_id TEXT,
  project_name TEXT,
  event_type TEXT,
  severity TEXT,
  payload JSON,
  source TEXT
);
INSERT INTO session_events VALUES
  (1, 'boundary', '2026-09-09 01:00:00', 'exec-1', 'issue-1', 'flywheel-test-2',
   'isolation_boundary_refused', 'warn', '{"target":2231}', 'test'),
  (2, 'orphan', '2026-09-09 01:01:00', 'exec-1', 'issue-1', 'flywheel-test-2',
   'codex_app_server_orphan_refused', 'warn', '{"pid":2231}', 'test'),
  (3, 'noise', '2026-09-09 01:02:00', 'exec-1', 'issue-1', 'flywheel-test-2',
   'session_started', 'info', '{}', 'test');
SQL
archive_rc=0
FLYWHEEL_QA_EVID_DIR="$ARCHIVE_ROOT" bash -c \
  'source "$1"; qa_archive_slot_isolation_evidence "$2" 2' \
  _ "$TEARDOWN_SCRIPT" "$ARCHIVE_SLOT" >/dev/null 2>"$TEST_ROOT/archive-stderr" \
  || archive_rc=$?
archive_dir=$(find "$ARCHIVE_ROOT/slot-2" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
  | head -1)
archive_line=$(grep -n 'qa_archive_slot_isolation_evidence "$SLOT_DIR" "$SLOT"' \
  "$TEARDOWN_SCRIPT" | head -1 | cut -d: -f1)
delete_line=$(grep -n '^[[:space:]]*rm -rf "$SLOT_DIR"$' "$TEARDOWN_SCRIPT" \
  | head -1 | cut -d: -f1)
if [[ "$archive_rc" == "0" && -n "$archive_dir" \
    && -f "$archive_dir/kill-ledger/20260909.ndjson" \
    && -f "$archive_dir/launch-manifest.json" \
    && "$(jq -r 'map(.event_type) | join(",")' "$archive_dir/boundary-events.json" 2>/dev/null)" \
      == "isolation_boundary_refused,codex_app_server_orphan_refused" \
    && -n "$archive_line" && -n "$delete_line" \
    && "$archive_line" -lt "$delete_line" \
    && "$(grep -c "event_type = 'isolation_boundary_refused'" "$TEARDOWN_SCRIPT")" == "1" ]]; then
  pass "authoritative ledger, exact boundary event, orphan events, and manifest survive before slot deletion"
else
  fail "evidence archive contract mismatch rc=$archive_rc dir=[$archive_dir] order=${archive_line:-?}/${delete_line:-?} stderr=[$(cat "$TEST_ROOT/archive-stderr" 2>/dev/null)]"
fi

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
