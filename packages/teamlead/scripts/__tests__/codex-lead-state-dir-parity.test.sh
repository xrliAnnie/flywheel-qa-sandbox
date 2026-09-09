#!/bin/bash
# FLY-2444: codex-lead.sh must resolve the exact state directory used by the
# Bridge without creating it in the read-only --print-state-dir mode.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_LEAD="${SCRIPT_DIR}/../codex-lead.sh"
TMP="$(mktemp -d -t fly2444-state-dir-XXXXXX)" || exit 1
trap 'rm -rf "$TMP"' EXIT

identity_hex() {
  printf '%s\037%s' "$1" "$2" | od -An -v -tx1 | tr -d ' \n'
}

run_print() {
  env -u FLYWHEEL_CODEX_LEAD_STATE_DIRS \
    HOME="$TMP/home" FLYWHEEL_STATE_DIR="$TMP/state-root" \
    /bin/bash "$CODEX_LEAD" --print-state-dir "$1" "$2"
}

mkdir -p "$TMP/home" "$TMP/state-root/state/codex-lead/legacy-lead"

out="$(run_print legacy-lead project-a 2>"$TMP/legacy.err")"; code=$?
expected="$TMP/state-root/state/codex-lead/legacy-lead"
if [ "$code" -eq 0 ] && [ "$out" = "$expected" ]; then
  pass "prefers the existing legacy <root>/<lead> state directory"
else
  fail "legacy state directory mismatch: code=$code out=$out err=$(cat "$TMP/legacy.err")"
fi

before="$(find "$TMP/state-root" -print | sort)"
out="$(run_print 'lead-y' 'project/x' 2>"$TMP/generated.err")"; code=$?
expected="$TMP/state-root/state/codex-lead/project_x__lead-y-$(identity_hex 'project/x' 'lead-y')"
after="$(find "$TMP/state-root" -print | sort)"
if [ "$code" -eq 0 ] && [ "$out" = "$expected" ] && [ "$before" = "$after" ]; then
  pass "uses the injective identity path without mutating state"
else
  fail "generated state directory mismatch or mutation: code=$code out=$out"
fi

mapped="$TMP/absolute/mapped-state"
: >"$TMP/mapped.err"
before="$(find "$TMP" -print | sort)"
out="$(FLYWHEEL_CODEX_LEAD_STATE_DIRS="{\"project-a\":{\"lead-a\":\"$mapped\"}}" \
  HOME="$TMP/home" FLYWHEEL_STATE_DIR="$TMP/state-root" \
  /bin/bash "$CODEX_LEAD" --print-state-dir lead-a project-a 2>"$TMP/mapped.err")"; code=$?
after="$(find "$TMP" -print | sort)"
if [ "$code" -eq 0 ] && [ "$out" = "$mapped" ] && [ "$before" = "$after" ]; then
  pass "explicit Bridge state-dir map wins without creating the path"
else
  fail "explicit map mismatch or mutation: code=$code out=$out err=$(cat "$TMP/mapped.err")"
fi

if FLYWHEEL_CODEX_LEAD_STATE_DIRS='not-json' \
  /bin/bash "$CODEX_LEAD" --print-state-dir lead-a project-a >"$TMP/invalid.out" 2>"$TMP/invalid.err"; then
  fail "invalid state-dir JSON must fail"
elif [ "$?" -eq 78 ] && grep -q 'must be valid JSON' "$TMP/invalid.err"; then
  pass "invalid state-dir JSON fails closed with exit 78"
else
  fail "invalid state-dir JSON returned the wrong error"
fi

if FLYWHEEL_CODEX_LEAD_STATE_DIRS='{"project-a":{"lead-a":"relative/path"}}' \
  /bin/bash "$CODEX_LEAD" --print-state-dir lead-a project-a >"$TMP/relative.out" 2>"$TMP/relative.err"; then
  fail "relative mapped state directory must fail"
elif [ "$?" -eq 78 ] && grep -q 'has no absolute path' "$TMP/relative.err"; then
  pass "relative mapped state directory fails closed with exit 78"
else
  fail "relative mapped state directory returned the wrong error"
fi

slot_root="$TMP/flywheel-test-slot-7/q/7"
out="$(env -u FLYWHEEL_CODEX_LEAD_STATE_DIRS HOME="$TMP/home" FLYWHEEL_STATE_DIR="$slot_root" \
  /bin/bash "$CODEX_LEAD" --print-state-dir qa-lead qa-project 2>"$TMP/slot.err")"; code=$?
expected="$slot_root/state/codex-lead/qa-project__qa-lead-$(identity_hex qa-project qa-lead)"
if [ "$code" -eq 0 ] && [ "$out" = "$expected" ]; then
  pass "slot-local root matches the 529 qa_launchd_codex_state_dir formula"
else
  fail "slot-local parity mismatch: code=$code out=$out"
fi

echo ""
echo "[codex-lead-state-dir-parity] passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
