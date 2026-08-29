#!/bin/bash
# FLY-142 PR #186 codex:rescue Bug B regression — assert that the
# `claude-lead.sh` Agent-Team-args wiring stays OFF when
# `FLYWHEEL_COMM_BACKEND=commdb`.
#
# Two surfaces are gated on the backend, both must skip on commdb:
#   1. `runner-messaging-rules.md` (--append-system-prompt-file)
#   2. `FLYWHEEL_AGENT_TEAM_ARGS` (--agent-id / --agent-name / --team-name)
#
# Without this gating, Lead would advertise itself as a claude-code
# teammate (writes to mailbox via SendMessage) while Runner on the
# rollback path has no Agent Team identity (run-dispatcher.ts:75 returns
# `{}` on commdb), so mailbox writes land in a file no one polls →
# silent message loss.
#
# This test mirrors the two gate blocks from `claude-lead.sh` (lines
# ~1122-1140 + ~1226-1238) in isolated subshells with controlled
# `FLYWHEEL_COMM_BACKEND` values, and asserts the conditional outcome.
# Static greps verify the production file still contains both gates.

set -euo pipefail

PASSED=0
FAILED=0
ERRORS=""

log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); ERRORS="${ERRORS}\n  ✗ $1"; log_test "✗ $1"; }

TMP_DIR="$(mktemp -d -t fly142-rollback-args-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# ─────────────────────────────────────────────────────────────────────────
# Helper: mirror the runner-messaging-rules gate from claude-lead.sh.
# Sets CLAUDE_ARGS_OUT (array) based on the gate outcome.
# ─────────────────────────────────────────────────────────────────────────
normalize_comm_backend() {
  # Mirrors the production helper at the top of claude-lead.sh: default,
  # trim whitespace, lowercase.
  local raw="${FLYWHEEL_COMM_BACKEND:-mailbox}"
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  printf '%s' "$raw" | tr '[:upper:]' '[:lower:]'
}

runner_msg_gate_fragment() {
  CLAUDE_ARGS_OUT=()
  local backend
  backend=$(normalize_comm_backend)
  if [ "$backend" != "commdb" ]; then
    CLAUDE_ARGS_OUT+=(--append-system-prompt-file "/fake/runner-messaging-rules.md")
  fi
}

# ─────────────────────────────────────────────────────────────────────────
# Helper: mirror the Agent-Team-args gate from claude-lead.sh.
# Caller pre-populates FLYWHEEL_AGENT_TEAM_ARGS (would have been set by
# `eval $(agent-team-transport lead-args)`).
# ─────────────────────────────────────────────────────────────────────────
agent_team_args_gate_fragment() {
  CLAUDE_ARGS_OUT=()
  local backend
  backend=$(normalize_comm_backend)
  if [ "$backend" = "commdb" ]; then
    return  # rollback — skip the merge
  fi
  if [ "${#FLYWHEEL_AGENT_TEAM_ARGS[@]}" -gt 0 ]; then
    CLAUDE_ARGS_OUT+=( "${FLYWHEEL_AGENT_TEAM_ARGS[@]}" )
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# Test 1 — runner-messaging-rules on mailbox (default): rule IS appended.
# ═══════════════════════════════════════════════════════════════════════
test_runner_msg_mailbox_includes() {
  local result
  result=$(
    set -euo pipefail
    unset FLYWHEEL_COMM_BACKEND
    $(declare -f runner_msg_gate_fragment)
    runner_msg_gate_fragment
    printf '%s\n' "${CLAUDE_ARGS_OUT[@]:-}"
  )
  if printf '%s\n' "$result" | grep -q "runner-messaging-rules.md"; then
    pass "default backend (mailbox): runner-messaging-rules.md appended"
  else
    fail "default backend should append rule, got: '$result'"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# Test 2 — runner-messaging-rules on commdb: rule NOT appended.
# ═══════════════════════════════════════════════════════════════════════
test_runner_msg_commdb_skips() {
  local result
  result=$(
    set -euo pipefail
    export FLYWHEEL_COMM_BACKEND=commdb
    $(declare -f runner_msg_gate_fragment)
    runner_msg_gate_fragment
    printf '%s\n' "${CLAUDE_ARGS_OUT[@]:-}"
  )
  if printf '%s\n' "$result" | grep -q "runner-messaging-rules.md"; then
    fail "commdb backend should NOT append rule, got: '$result'"
  else
    pass "commdb backend (rollback): runner-messaging-rules.md NOT appended"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# Test 3 — runner-messaging-rules on COMMDB (case insensitive): NOT appended.
# ═══════════════════════════════════════════════════════════════════════
test_runner_msg_commdb_case_insensitive() {
  local result
  result=$(
    set -euo pipefail
    export FLYWHEEL_COMM_BACKEND=COMMDB
    $(declare -f runner_msg_gate_fragment)
    runner_msg_gate_fragment
    printf '%s\n' "${CLAUDE_ARGS_OUT[@]:-}"
  )
  if printf '%s\n' "$result" | grep -q "runner-messaging-rules.md"; then
    fail "COMMDB (uppercase) should NOT append rule, got: '$result'"
  else
    pass "case-insensitive commdb detection: COMMDB → no rule"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# Test 4 — Agent Team args on mailbox: merged.
# ═══════════════════════════════════════════════════════════════════════
test_agent_team_args_mailbox_merged() {
  local result
  result=$(
    set -euo pipefail
    unset FLYWHEEL_COMM_BACKEND
    declare -a FLYWHEEL_AGENT_TEAM_ARGS=("--agent-id" "lead@team" "--agent-name" "lead")
    $(declare -f agent_team_args_gate_fragment)
    agent_team_args_gate_fragment
    printf '%s\n' "${CLAUDE_ARGS_OUT[@]:-}"
  )
  if printf '%s\n' "$result" | grep -q -- "--agent-id"; then
    pass "default backend (mailbox): FLYWHEEL_AGENT_TEAM_ARGS merged into CLAUDE_ARGS"
  else
    fail "default backend should merge Agent Team args, got: '$result'"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# Test 5 — Agent Team args on commdb: NOT merged.
# ═══════════════════════════════════════════════════════════════════════
test_agent_team_args_commdb_skipped() {
  local result
  result=$(
    set -euo pipefail
    export FLYWHEEL_COMM_BACKEND=commdb
    declare -a FLYWHEEL_AGENT_TEAM_ARGS=("--agent-id" "lead@team" "--agent-name" "lead")
    $(declare -f agent_team_args_gate_fragment)
    agent_team_args_gate_fragment
    printf '%s\n' "${CLAUDE_ARGS_OUT[@]:-}"
  )
  if printf '%s\n' "$result" | grep -q -- "--agent-id"; then
    fail "commdb should NOT merge Agent Team args, got: '$result'"
  else
    pass "commdb backend (rollback): FLYWHEEL_AGENT_TEAM_ARGS NOT merged"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# Test 6 — Production claude-lead.sh has both gate blocks.
# ═══════════════════════════════════════════════════════════════════════
test_production_has_both_gates() {
  local script_dir
  script_dir=$(cd "$(dirname "$0")/.." && pwd)
  local lead="${script_dir}/claude-lead.sh"
  if [ ! -f "$lead" ]; then
    fail "claude-lead.sh not found at ${lead}"
    return
  fi
  # runner-messaging-rules gate: "_runnermsg_backend" assignment must guard
  # the BASE_RUNNER_MSG_RULES append.
  if ! grep -qE 'BASE_RUNNER_MSG_RULES.*runner-messaging-rules' "$lead"; then
    fail "claude-lead.sh missing BASE_RUNNER_MSG_RULES assignment"
    return
  fi
  if ! grep -qE '_runnermsg_backend' "$lead"; then
    fail "claude-lead.sh missing _runnermsg_backend gate (Bug B regression)"
    return
  fi
  # Agent Team args gate: "_agentteam_backend" assignment must guard the
  # FLYWHEEL_AGENT_TEAM_ARGS merge.
  if ! grep -qE '_agentteam_backend' "$lead"; then
    fail "claude-lead.sh missing _agentteam_backend gate (Bug B regression)"
    return
  fi
  pass "production claude-lead.sh has both _runnermsg_backend + _agentteam_backend gates"
}

# ═══════════════════════════════════════════════════════════════════════
# Test 7 (codex:rescue Round 2 MEDIUM) — quoted whitespace around `commdb`
# in env value still routes to rollback (would slip past pre-fix lowercase-
# only normalization).
# ═══════════════════════════════════════════════════════════════════════
test_runner_msg_commdb_whitespace_trimmed() {
  local result
  result=$(
    set -euo pipefail
    export FLYWHEEL_COMM_BACKEND=" commdb "
    $(declare -f normalize_comm_backend)
    $(declare -f runner_msg_gate_fragment)
    runner_msg_gate_fragment
    printf '%s\n' "${CLAUDE_ARGS_OUT[@]:-}"
  )
  if printf '%s\n' "$result" | grep -q "runner-messaging-rules.md"; then
    fail "whitespace-padded commdb should NOT append rule, got: '$result'"
  else
    pass "FLYWHEEL_COMM_BACKEND=\" commdb \" trimmed correctly → no rule"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# Test 8 (codex:rescue Round 2 MEDIUM) — same trim semantic for the Agent
# Team args gate.
# ═══════════════════════════════════════════════════════════════════════
test_agent_team_args_commdb_whitespace_trimmed() {
  local result
  result=$(
    set -euo pipefail
    export FLYWHEEL_COMM_BACKEND=" commdb "
    declare -a FLYWHEEL_AGENT_TEAM_ARGS=("--agent-id" "lead@team")
    $(declare -f normalize_comm_backend)
    $(declare -f agent_team_args_gate_fragment)
    agent_team_args_gate_fragment
    printf '%s\n' "${CLAUDE_ARGS_OUT[@]:-}"
  )
  if printf '%s\n' "$result" | grep -q -- "--agent-id"; then
    fail "whitespace-padded commdb should NOT merge Agent Team args, got: '$result'"
  else
    pass "FLYWHEEL_COMM_BACKEND=\" commdb \" trimmed correctly → no args merge"
  fi
}

# ─── Run ──────────────────────────────────────────────────────────
test_runner_msg_mailbox_includes
test_runner_msg_commdb_skips
test_runner_msg_commdb_case_insensitive
test_agent_team_args_mailbox_merged
test_agent_team_args_commdb_skipped
test_production_has_both_gates
test_runner_msg_commdb_whitespace_trimmed
test_agent_team_args_commdb_whitespace_trimmed

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Summary: ${PASSED} passed, ${FAILED} failed"
if [ "$FAILED" -gt 0 ]; then
  echo -e "Failures:${ERRORS}"
  exit 1
fi
exit 0
