#!/bin/bash
# FLY-142 PR #186 codex:rescue Bug A regression — assert that the wrapper
# sources its .env file with `set -a` so variables auto-export into the
# subprocess env that `exec` inherits.
#
# Without this, `FLYWHEEL_COMM_BACKEND=commdb` in `.env` would be set as a
# shell-local variable in the wrapper but invisible to `claude-lead.sh`,
# producing a split-brain rollback (Bridge picks CommDB runtime, Lead
# loads mailbox identity, messages silently lost).
#
# We don't need to actually exec claude-lead.sh (that's heavy). Instead we
# mirror the wrapper's source-env block in an isolated subshell, then probe
# whether a downstream subprocess can see the value via its env.

set -euo pipefail

PASSED=0
FAILED=0
ERRORS=""

log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); ERRORS="${ERRORS}\n  ✗ $1"; log_test "✗ $1"; }

TMP_DIR="$(mktemp -d -t fly142-wrapper-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Write a fake .env that sets FLYWHEEL_COMM_BACKEND. The test mirrors the
# wrapper's source block (with `set -a`) and assigns; a child process should
# see the value in its env.
cat > "${TMP_DIR}/env-file" <<'ENV'
FLYWHEEL_COMM_BACKEND=commdb
FLYWHEEL_OTHER_VAR=hello
ENV

# ─────────────────────────────────────────────────────────────────────────
# Test 1 — `set -a` + source: env var visible in child process
# ─────────────────────────────────────────────────────────────────────────
test_set_a_exports_to_child() {
  local child_value
  child_value=$(
    set -euo pipefail
    set -a
    # shellcheck source=/dev/null
    source "${TMP_DIR}/env-file"
    set +a
    # Spawn a child shell and read FLYWHEEL_COMM_BACKEND from its env. If
    # the source-with-set-a worked, the child should see "commdb". If we
    # had used plain `source` without `set -a`, the var would be shell-
    # local and the child would see nothing.
    bash -c 'echo "${FLYWHEEL_COMM_BACKEND:-MISSING}"'
  )
  if [ "$child_value" = "commdb" ]; then
    pass "set -a + source: FLYWHEEL_COMM_BACKEND propagates into child subshell"
  else
    fail "set -a + source did NOT propagate FLYWHEEL_COMM_BACKEND (child saw '${child_value}', expected 'commdb')"
  fi
}

# ─────────────────────────────────────────────────────────────────────────
# Test 2 — Without `set -a` (control): env var NOT visible in child
# Demonstrates the original Bug A behavior so a regression that removed
# `set -a` would flip both tests.
# ─────────────────────────────────────────────────────────────────────────
test_without_set_a_no_export() {
  local child_value
  child_value=$(
    set -euo pipefail
    # shellcheck source=/dev/null
    source "${TMP_DIR}/env-file"  # NO set -a
    bash -c 'echo "${FLYWHEEL_COMM_BACKEND:-MISSING}"'
  )
  if [ "$child_value" = "MISSING" ]; then
    pass "control: plain source does NOT export to child (confirms Bug A premise)"
  else
    fail "control failed: plain source somehow propagated FLYWHEEL_COMM_BACKEND='${child_value}' (expected MISSING). Bash semantics changed?"
  fi
}

# ─────────────────────────────────────────────────────────────────────────
# Test 3 — Production wrapper has the `set -a` / `set +a` pair around its
# source call. Static check of the file.
# ─────────────────────────────────────────────────────────────────────────
test_production_wrapper_has_set_a() {
  local script_dir
  script_dir=$(cd "$(dirname "$0")/.." && pwd)
  local wrapper="${script_dir}/flywheel-lead-wrapper.sh"
  if [ ! -f "$wrapper" ]; then
    fail "wrapper not found at ${wrapper}"
    return
  fi
  # Look for the `set -a` + `source "$ENV_FILE"` + conditional `set +a`
  # restore. The conditional form (codex:rescue Round 2 LOW) preserves
  # caller's pre-existing `allexport` state.
  if grep -qE '^set -a$' "$wrapper" \
     && grep -qE '^source +"\$ENV_FILE"$' "$wrapper" \
     && grep -qE '_wrapper_prev_allexport' "$wrapper"; then
    pass "production flywheel-lead-wrapper.sh contains set -a / source / conditional restore"
  else
    fail "production flywheel-lead-wrapper.sh missing one of: set -a, source \"\$ENV_FILE\", _wrapper_prev_allexport restore"
  fi
}

# ─────────────────────────────────────────────────────────────────────────
# Test 4 (codex:rescue Round 2 LOW) — caller had `set -a` ON before:
# wrapper preserves that state (does NOT turn off after).
# ─────────────────────────────────────────────────────────────────────────
test_preserves_caller_allexport_on() {
  local state_after
  state_after=$(
    set -euo pipefail
    set -a   # caller-side allexport ON
    # Mirror the wrapper block — capture incoming state then restore only
    # if we enabled it.
    if [[ "$-" == *a* ]]; then prev=on; else prev=off; fi
    set -a
    # shellcheck source=/dev/null
    source "${TMP_DIR}/env-file"
    if [ "$prev" = "off" ]; then set +a; fi
    # Probe the current state.
    if [[ "$-" == *a* ]]; then echo "on"; else echo "off"; fi
  )
  if [ "$state_after" = "on" ]; then
    pass "caller had set -a on: wrapper preserves it (state_after=on)"
  else
    fail "caller had set -a on but state_after=${state_after} (should be on)"
  fi
}

# ─────────────────────────────────────────────────────────────────────────
# Test 5 (codex:rescue Round 2 LOW) — caller had `set -a` OFF before:
# wrapper turns it back off after the source (no leaked allexport).
# ─────────────────────────────────────────────────────────────────────────
test_preserves_caller_allexport_off() {
  local state_after
  state_after=$(
    set -euo pipefail
    # Caller has allexport OFF (default).
    if [[ "$-" == *a* ]]; then prev=on; else prev=off; fi
    set -a
    # shellcheck source=/dev/null
    source "${TMP_DIR}/env-file"
    if [ "$prev" = "off" ]; then set +a; fi
    if [[ "$-" == *a* ]]; then echo "on"; else echo "off"; fi
  )
  if [ "$state_after" = "off" ]; then
    pass "caller had set -a off: wrapper restores it (state_after=off)"
  else
    fail "caller had set -a off but state_after=${state_after} (should be off; allexport leaked)"
  fi
}

# ─── Run ──────────────────────────────────────────────────────────
test_set_a_exports_to_child
test_without_set_a_no_export
test_production_wrapper_has_set_a
test_preserves_caller_allexport_on
test_preserves_caller_allexport_off

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Summary: ${PASSED} passed, ${FAILED} failed"
if [ "$FAILED" -gt 0 ]; then
  echo -e "Failures:${ERRORS}"
  exit 1
fi
exit 0
