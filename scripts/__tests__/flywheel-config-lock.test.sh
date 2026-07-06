#!/usr/bin/env bash
# FLY-247 inc2a (§2.1): config-write flock helper tests.
#   C1 single acquire runs the command and returns its exit code
#   C2 holds the lock — a concurrent acquire times out → EX_TEMPFAIL (75)
#   C3 lock auto-released after the holder exits → next acquire succeeds
#   C4 the held command's NON-zero exit code is propagated (not masked)
#   C5 missing command → EX_USAGE (64)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Tell the helper it's being sourced (not executed) so it doesn't auto-run.
export FLYWHEEL_CONFIG_LOCK_SOURCED=1
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/flywheel-config-lock.sh"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cfglock.XXXXXX")"
LOCK="${TMP}/projects.lock"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# C1 — single acquire runs the command, returns its rc.
out="$(config_write_locked "$LOCK" 2 echo hello)"
rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "hello" ]; then
  pass "C1 single acquire runs cmd + returns rc 0"
else
  fail "C1 expected rc0/'hello', got rc=$rc out='$out'"
fi

# C2 — hold the lock in the background, then a concurrent acquire must time out.
# Background holder keeps the lock for ~1.5s via a sleeping child command.
config_write_locked "$LOCK" 2 sleep 1.5 &
holder_pid=$!
sleep 0.3 # let the holder acquire
config_write_locked "$LOCK" 0.4 echo should-not-run >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 75 ]; then
  pass "C2 concurrent acquire times out → EX_TEMPFAIL(75)"
else
  fail "C2 expected rc75, got rc=$rc"
fi
wait "$holder_pid" 2>/dev/null

# C3 — after the holder exits, the lock is free → next acquire succeeds.
out="$(config_write_locked "$LOCK" 2 echo free-now)"
rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "free-now" ]; then
  pass "C3 lock auto-released → next acquire succeeds"
else
  fail "C3 expected rc0/'free-now', got rc=$rc out='$out'"
fi

# C4 — the command's non-zero exit code propagates (not masked by the lock).
config_write_locked "$LOCK" 2 sh -c 'exit 42' >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 42 ]; then
  pass "C4 held command's non-zero rc propagates"
else
  fail "C4 expected rc42, got rc=$rc"
fi

# C5 — missing command → EX_USAGE(64).
config_write_locked "$LOCK" 2 >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 64 ]; then
  pass "C5 missing command → EX_USAGE(64)"
else
  fail "C5 expected rc64, got rc=$rc"
fi

echo "=================================="
echo "config-lock tests: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
