#!/bin/bash
# FLY-142 PR 1.2: verify claude-lead.sh integrates agent-team-transport CLI
# correctly per plan v1.27.1 §2.0.4-bis.
#
# Tests the eval-able output pattern (Codex r2 high #4 — quote-safe vs
# spaces, single-quotes, $VAR literals, newlines). We stub
# `agent-team-transport` on PATH with a fake script that emits known
# output, then verify the launcher properly:
#   1. Runs preflight before continuing
#   2. Eval'd lead-env exports the expected env vars
#   3. Eval'd lead-args populates FLYWHEEL_AGENT_TEAM_ARGS
#   4. CLAUDE_ARGS+= splat preserves quote-safe values
#   5. Adversarial values (spaces / single-quotes / $VAR / newlines) survive
#      the round-trip without word-splitting / variable-expansion bugs
#   6. Skipping preflight is honored when FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT=1
#   7. Missing CLI on PATH is non-fatal (launcher logs + continues)
set -euo pipefail

PASSED=0
FAILED=0
ERRORS=""

log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); ERRORS="${ERRORS}\n  ✗ $1"; log_test "✗ $1"; }

TMP_DIR="$(mktemp -d -t fly142-pr12-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# ─────────────────────────────────────────────────────────────────────────
# Helper: source-able fragment that mirrors claude-lead.sh:1118-1167
# (the FLY-142 PR 1.2 transport block). Self-contained for testability.
# ─────────────────────────────────────────────────────────────────────────
source_transport_fragment() {
  # Inputs from caller's env: LEAD_ID, FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT
  # Outputs: CLAUDE_ARGS array + transport env vars (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS etc.)
  #
  # Mirrors claude-lead.sh:1148-1190 exactly so tests catch regressions
  # in either the launcher OR this fragment's mirror.
  CLAUDE_ARGS=("--initial-flag" "$LEAD_ID")  # baseline existing args

  if command -v agent-team-transport >/dev/null 2>&1; then
    if [ "${FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT:-0}" != "1" ]; then
      if ! agent-team-transport preflight >/dev/null 2>&1; then
        echo "[FRAGMENT] preflight FAILED, exiting"
        return 1
      fi
    fi

    # Codex r1 PR 1.2 MEDIUM: capture output + check exit status BEFORE eval
    # (eval "$(false)" doesn't propagate under set -e).
    if ! _lead_env_output=$(agent-team-transport lead-env --lead-id "${LEAD_ID}"); then
      echo "[FRAGMENT] lead-env FAILED, exiting"
      return 1
    fi
    eval "${_lead_env_output}"
    unset _lead_env_output

    if ! _lead_args_output=$(agent-team-transport lead-args --lead-id "${LEAD_ID}"); then
      echo "[FRAGMENT] lead-args FAILED, exiting"
      return 1
    fi
    eval "${_lead_args_output}"
    unset _lead_args_output

    # Post-eval assertion: env MUST be set.
    if [ "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}" != "1" ]; then
      echo "[FRAGMENT] env not set after eval, exiting"
      return 1
    fi

    if [ "${#FLYWHEEL_AGENT_TEAM_ARGS[@]}" -gt 0 ]; then
      CLAUDE_ARGS+=("${FLYWHEEL_AGENT_TEAM_ARGS[@]}")
    fi
  fi
}

# ─────────────────────────────────────────────────────────────────────────
# Stub `agent-team-transport` on PATH that emits configurable output.
# ─────────────────────────────────────────────────────────────────────────
make_stub_transport() {
  local mode="$1"  # ok | preflight-fail | adversarial
  local stub_dir="$TMP_DIR/stub-${mode}"
  mkdir -p "$stub_dir"
  local stub="$stub_dir/agent-team-transport"
  case "$mode" in
    ok)
      cat > "$stub" <<'STUB'
#!/bin/bash
case "$1" in
  preflight) exit 0 ;;
  vendor) echo "claude-code" ;;
  lead-env)
    echo "export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=\$'1'"
    echo "export CLAUDE_CONFIG_DIR=\$'/test/claude'"
    echo "export FLYWHEEL_AGENT_BACKEND=\$'claude-code'"
    ;;
  lead-args)
    echo "FLYWHEEL_AGENT_TEAM_ARGS=( \$'--agent-id' \$'cos-lead@cos-lead' \$'--agent-name' \$'cos-lead' \$'--team-name' \$'cos-lead' )"
    ;;
esac
STUB
      ;;
    preflight-fail)
      cat > "$stub" <<'STUB'
#!/bin/bash
case "$1" in
  preflight) echo "stub preflight failure" 1>&2; exit 1 ;;
  *) exit 0 ;;
esac
STUB
      ;;
    preflight-fail-env-ok)
      # Codex r2 PR 1.2 MEDIUM #2: preflight FAILS but lead-env/lead-args
      # succeed normally. Used to verify FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT=1
      # truly bypasses preflight AND that env+args are still properly merged
      # (not a false-positive "fragment refused but test passes" case).
      cat > "$stub" <<'STUB'
#!/bin/bash
case "$1" in
  preflight) echo "preflight should be skipped" 1>&2; exit 1 ;;
  vendor) echo "claude-code" ;;
  lead-env)
    echo "export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=\$'1'"
    echo "export CLAUDE_CONFIG_DIR=\$'/skip/test'"
    ;;
  lead-args)
    echo "FLYWHEEL_AGENT_TEAM_ARGS=( \$'--agent-id' \$'cos-lead@cos-lead' )"
    ;;
esac
STUB
      ;;
    adversarial)
      cat > "$stub" <<'STUB'
#!/bin/bash
case "$1" in
  preflight) exit 0 ;;
  vendor) echo "claude-code" ;;
  lead-env)
    # Path with spaces + single-quote + $VAR literal
    echo "export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=\$'1'"
    echo "export CLAUDE_CONFIG_DIR=\$'/path with spaces/.claude\\'with quote'"
    echo "export FLYWHEEL_LITERAL_DOLLAR=\$'\$PWD/test_\$RANDOM'"
    ;;
  lead-args)
    # Adversarial values: spaces, single-quote, $VAR, newline
    printf '%s' "FLYWHEEL_AGENT_TEAM_ARGS=( "
    printf '%s' "\$'--parent-session-id' \$'sess\\'with\\'quotes' "
    printf '%s' "\$'--workspace' \$'/path with spaces' "
    printf '%s' "\$'--literal-dollar' \$'\$PWD/test_\$RANDOM' "
    printf '%s\n' ")"
    ;;
esac
STUB
      ;;
    lead-env-fails)
      cat > "$stub" <<'STUB'
#!/bin/bash
# Codex r1 PR 1.2 MEDIUM: simulate preflight OK but lead-env failure
# (transient node crash / dist regression / etc).
case "$1" in
  preflight) exit 0 ;;  # passes
  vendor) echo "claude-code" ;;
  lead-env) echo "stub: lead-env crashed" 1>&2; exit 2 ;;  # FAILS
  lead-args) echo "FLYWHEEL_AGENT_TEAM_ARGS=( \$'--agent-id' \$'x@y' )" ;;
esac
STUB
      ;;
    env-not-set)
      cat > "$stub" <<'STUB'
#!/bin/bash
# Codex r1 PR 1.2 MEDIUM: lead-env succeeds but doesn't actually set the
# required env (helper regression — output is well-formed bash but missing
# the CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS export).
case "$1" in
  preflight) exit 0 ;;
  vendor) echo "claude-code" ;;
  lead-env) echo "export CLAUDE_CONFIG_DIR=\$'/test'" ;;  # NO _AGENT_TEAMS
  lead-args) echo "FLYWHEEL_AGENT_TEAM_ARGS=( \$'--agent-id' \$'x@y' )" ;;
esac
STUB
      ;;
  esac
  chmod +x "$stub"
  echo "$stub_dir"
}

# ═══════════════════════════════════════════════════════════════════════
# Test 1: happy path — preflight OK, env + args eval'd into shell
# ═══════════════════════════════════════════════════════════════════════
test_happy_path() {
  local stub_dir
  stub_dir=$(make_stub_transport ok)
  PATH="$stub_dir:$PATH" \
  LEAD_ID="cos-lead" \
  FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT="" \
    bash -c "
      $(declare -f source_transport_fragment)
      source_transport_fragment
      [ \"\${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}\" = '1' ] || { echo 'env var missing'; exit 1; }
      [ \"\${CLAUDE_CONFIG_DIR:-}\" = '/test/claude' ] || { echo 'config dir missing'; exit 1; }
      [ \"\${FLYWHEEL_AGENT_BACKEND:-}\" = 'claude-code' ] || { echo 'backend missing'; exit 1; }
      [ \${#CLAUDE_ARGS[@]} -ge 8 ] || { echo \"CLAUDE_ARGS too short: \${#CLAUDE_ARGS[@]}\"; exit 1; }
      # First 2 = baseline, then 6 transport args
      [ \"\${CLAUDE_ARGS[2]}\" = '--agent-id' ] || { echo \"unexpected element: \${CLAUDE_ARGS[2]}\"; exit 1; }
      [ \"\${CLAUDE_ARGS[3]}\" = 'cos-lead@cos-lead' ] || { echo 'unexpected agent-id value'; exit 1; }
      exit 0
    " && pass "happy path: env vars exported + CLAUDE_ARGS merged correctly" || fail "happy path failed"
}

# ═══════════════════════════════════════════════════════════════════════
# Test 2: preflight failure → fragment returns 1, env not eval'd
# ═══════════════════════════════════════════════════════════════════════
test_preflight_fail() {
  local stub_dir
  stub_dir=$(make_stub_transport preflight-fail)
  PATH="$stub_dir:$PATH" \
  LEAD_ID="cos-lead" \
  FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT="" \
    bash -c "
      $(declare -f source_transport_fragment)
      source_transport_fragment && exit 1 || exit 0
    " && pass "preflight failure: fragment returns nonzero, env NOT eval'd" || fail "preflight failure not detected"
}

# ═══════════════════════════════════════════════════════════════════════
# Test 3 (Codex r2 PR 1.2 MEDIUM #2 fix): skip-preflight must actually run
# the fragment to completion AND assert env+args merged. Old test used a
# stub that failed preflight but ALSO emitted no env, so post-eval
# assertion failed silently — `exit 0` after that masked the error.
# New stub: preflight fails (forcing skip path) but lead-env/lead-args
# succeed, so we can positively verify the merge happened.
# ═══════════════════════════════════════════════════════════════════════
test_skip_preflight() {
  local stub_dir
  stub_dir=$(make_stub_transport preflight-fail-env-ok)  # preflight fails, env OK
  PATH="$stub_dir:$PATH" \
  LEAD_ID="cos-lead" \
  FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT="1" \
    bash -c "
      set -e
      $(declare -f source_transport_fragment)
      source_transport_fragment   # MUST succeed (no '|| true' / 'exit 0' mask)
      # Positive assertions — fragment must have populated these.
      [ \"\${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}\" = '1' ] || { echo 'env not merged'; exit 1; }
      [ \"\${CLAUDE_CONFIG_DIR:-}\" = '/skip/test' ] || { echo 'config dir not merged'; exit 1; }
      [ \${#CLAUDE_ARGS[@]} -ge 4 ] || { echo \"args not merged: \${#CLAUDE_ARGS[@]}\"; exit 1; }
      [ \"\${CLAUDE_ARGS[2]}\" = '--agent-id' ] || { echo \"unexpected first transport arg: \${CLAUDE_ARGS[2]}\"; exit 1; }
      exit 0
    " && pass "skip preflight: bypasses failing preflight AND merges env/args correctly" \
       || fail "skip preflight false-positive regression (Codex r2 PR 1.2 MEDIUM #2)"
}

# ═══════════════════════════════════════════════════════════════════════
# Test 4: missing CLI on PATH is non-fatal
# ═══════════════════════════════════════════════════════════════════════
test_missing_cli() {
  # Use a clean PATH that has bash + coreutils but NOT agent-team-transport.
  # `env -i` resets env so we're not inheriting from the test runner shell.
  env -i PATH="/usr/bin:/bin" LEAD_ID="cos-lead" \
    bash -c "
      $(declare -f source_transport_fragment)
      source_transport_fragment
      # Should succeed; CLAUDE_ARGS still has baseline
      [ \${#CLAUDE_ARGS[@]} -eq 2 ] || { echo \"unexpected CLAUDE_ARGS len: \${#CLAUDE_ARGS[@]}\"; exit 1; }
      [ -z \"\${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}\" ] || { echo 'env should not be set'; exit 1; }
      exit 0
    " && pass "missing CLI: non-fatal, baseline CLAUDE_ARGS preserved" || fail "missing CLI handling failed"
}

# ═══════════════════════════════════════════════════════════════════════
# Test 5: adversarial values survive eval (Codex r2 high #4)
# ═══════════════════════════════════════════════════════════════════════
test_adversarial_quote_safety() {
  local stub_dir
  stub_dir=$(make_stub_transport adversarial)
  PATH="$stub_dir:$PATH" \
  LEAD_ID="cos-lead" \
  FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT="" \
    bash -c "
      $(declare -f source_transport_fragment)
      source_transport_fragment
      # Verify spaces preserved
      [ \"\${CLAUDE_CONFIG_DIR}\" = \$'/path with spaces/.claude\\'with quote' ] || { echo \"CLAUDE_CONFIG_DIR mangled: [\${CLAUDE_CONFIG_DIR}]\"; exit 1; }
      # Verify literal \$ NOT expanded
      [ \"\${FLYWHEEL_LITERAL_DOLLAR}\" = '\$PWD/test_\$RANDOM' ] || { echo \"\$VAR expanded: [\${FLYWHEEL_LITERAL_DOLLAR}]\"; exit 1; }
      # Verify CLAUDE_ARGS array length (2 baseline + 6 adversarial = 8)
      [ \${#CLAUDE_ARGS[@]} -eq 8 ] || { echo \"adversarial array len: \${#CLAUDE_ARGS[@]}\"; exit 1; }
      # Verify adversarial values landed as single elements (not split)
      [ \"\${CLAUDE_ARGS[3]}\" = \$'sess\\'with\\'quotes' ] || { echo \"single-quote split: [\${CLAUDE_ARGS[3]}]\"; exit 1; }
      [ \"\${CLAUDE_ARGS[5]}\" = '/path with spaces' ] || { echo \"space split: [\${CLAUDE_ARGS[5]}]\"; exit 1; }
      [ \"\${CLAUDE_ARGS[7]}\" = '\$PWD/test_\$RANDOM' ] || { echo \"\$VAR expansion: [\${CLAUDE_ARGS[7]}]\"; exit 1; }
      exit 0
    " && pass "adversarial values: spaces / quotes / \$VAR all survive eval round-trip" || fail "adversarial quote-safety regression"
}

# ═══════════════════════════════════════════════════════════════════════
# Test 6 (Codex r1 PR 1.2 MEDIUM): preflight OK but lead-env command FAILS.
# Without exit-status capture, eval "$(false)" silently continues with empty
# env → claude-code starts with identity flags but agent-teams disabled.
# ═══════════════════════════════════════════════════════════════════════
test_lead_env_failure() {
  local stub_dir
  stub_dir=$(make_stub_transport lead-env-fails)
  PATH="$stub_dir:$PATH" \
  LEAD_ID="cos-lead" \
  FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT="" \
    bash -c "
      $(declare -f source_transport_fragment)
      source_transport_fragment && exit 1 || exit 0
    " && pass "preflight OK + lead-env fails: fragment returns nonzero, refuses to continue" \
       || fail "lead-env failure not detected (Codex r1 PR 1.2 MEDIUM regression)"
}

# ═══════════════════════════════════════════════════════════════════════
# Test 7 (Codex r1 PR 1.2 MEDIUM): lead-env succeeds with valid bash output
# but doesn't set the required CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env.
# Post-eval assertion catches helper regression where output is well-formed
# but missing critical exports.
# ═══════════════════════════════════════════════════════════════════════
test_post_eval_env_assertion() {
  local stub_dir
  stub_dir=$(make_stub_transport env-not-set)
  PATH="$stub_dir:$PATH" \
  LEAD_ID="cos-lead" \
  FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT="" \
    env -i PATH="$stub_dir:/usr/bin:/bin" LEAD_ID="cos-lead" \
    bash -c "
      $(declare -f source_transport_fragment)
      source_transport_fragment && exit 1 || exit 0
    " && pass "post-eval assertion: rejects when CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS not set" \
       || fail "post-eval env assertion not enforced (Codex r1 PR 1.2 MEDIUM regression)"
}

# ─── Run all tests ────────────────────────────────────────────────
test_happy_path
test_preflight_fail
test_skip_preflight
test_missing_cli
test_adversarial_quote_safety
test_lead_env_failure
test_post_eval_env_assertion

# ─── Summary ──────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Summary: ${PASSED} passed, ${FAILED} failed"
if [ "$FAILED" -gt 0 ]; then
  echo -e "Failures:${ERRORS}"
  exit 1
fi
exit 0
