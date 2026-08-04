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

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
