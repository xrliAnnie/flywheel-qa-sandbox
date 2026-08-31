#!/bin/bash
# FLY-2190 S0: restart-services gates every local fast-forward and re-proves
# converged Lead carrier bytes before any kickstart candidate can be consumed.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; shift; [ "$#" -eq 0 ] || echo "        $*"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESTART="$REPO_ROOT/scripts/restart-services.sh"
SANDBOX="$(mktemp -d -t fly2190-host-tmux-restart-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

FUNCTIONS="$SANDBOX/functions.sh"
for function_name in restart_host_tmux_gate restart_host_tmux_census; do
  sed -n "/^${function_name}()/,/^}/p" "$RESTART" >> "$FUNCTIONS"
done

if grep -q '^restart_host_tmux_gate()' "$FUNCTIONS" \
  && grep -q '^restart_host_tmux_census()' "$FUNCTIONS"; then
  # shellcheck source=/dev/null
  source "$FUNCTIONS"

  export HOME="$SANDBOX/home"
  export FLYWHEEL_STATE_DIR="$HOME/.flywheel"
  export FLYWHEEL_DIR="$SANDBOX/repo"
  mkdir -p "$HOME/.flywheel/bin" "$FLYWHEEL_DIR/scripts"
  GATE="$HOME/.flywheel/bin/host-tmux-selection-gate.sh"
  CALLS="$SANDBOX/gate.calls"
  export CALLS
  printf '%s\n' \
    '#!/bin/bash' \
    'printf "%s|%s|%s|%s|%s\n" "$*" "${FLYWHEEL_HOST_TMUX_TARGET_SHA:-}" "${FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION:-}" "${FLYWHEEL_HOST_TMUX_MOUNT_POINT:-}" "${FLYWHEEL_STATE_DIR:-}" >> "$CALLS"' \
    'if [ "${1:-}" = verify ]; then exit 42; fi' \
    'exit 0' > "$GATE"
  chmod +x "$GATE"

  SHA="2222222222222222222222222222222222222222"
  GATE_RC=0
  restart_host_tmux_gate "$SHA" restart-preflight \
    scripts/restart-services.sh:before-ff || GATE_RC=$?
  if [ "$GATE_RC" -eq 42 ] \
    && grep -Fqx "gate restart-preflight|$SHA|restart-preflight:$SHA|scripts/restart-services.sh:before-ff|$HOME/.flywheel" "$CALLS" \
    && grep -Fqx "verify restart-preflight|$SHA|restart-preflight:$SHA|scripts/restart-services.sh:before-ff|$HOME/.flywheel" "$CALLS"; then
    pass "restart transaction propagates receipt verification failure"
  else
    fail "restart host gate did not fail closed (rc=$GATE_RC calls=$(cat "$CALLS" 2>/dev/null))"
  fi

  # First deployment runs the new restart-services bytes before the old
  # updater could have converged this newly-added state-bin file. The checked-
  # out source must therefore be a safe bootstrap fallback.
  mv "$GATE" "$FLYWHEEL_DIR/scripts/host-tmux-selection-gate.sh"
  : > "$CALLS"
  BOOTSTRAP_RC=0
  restart_host_tmux_gate "$SHA" restart-preflight \
    scripts/restart-services.sh:before-ff || BOOTSTRAP_RC=$?
  if [ "$BOOTSTRAP_RC" -eq 42 ] \
    && grep -Fq 'gate restart-preflight' "$CALLS" \
    && grep -Fq 'verify restart-preflight' "$CALLS"; then
    pass "restart preflight falls back to checked-out gate before first convergence"
  else
    fail "first-deploy gate bootstrap missing (rc=$BOOTSTRAP_RC calls=$(cat "$CALLS" 2>/dev/null))"
  fi
  mv "$FLYWHEEL_DIR/scripts/host-tmux-selection-gate.sh" "$GATE"

  printf '%s\n' \
    '#!/bin/bash' \
    'printf "%s\n" "$*" >> "$CALLS"' \
    'exit 0' > "$GATE"
  chmod +x "$GATE"
  : > "$CALLS"
  CENSUS_RC=0
  CANDIDATES="$SANDBOX/candidates.tsv"
  printf '%s\n' $'fixture\tfixture\tlead\t-\trestart\tplist' > "$CANDIDATES"
  restart_host_tmux_census "$CANDIDATES" || CENSUS_RC=$?
  if [ "$CENSUS_RC" -eq 0 ] \
    && grep -Fqx "census $CANDIDATES" "$CALLS"; then
    pass "restart transaction passes the loaded candidate inventory to census"
  else
    fail "restart census mount missing (rc=$CENSUS_RC calls=$(cat "$CALLS" 2>/dev/null))"
  fi
else
  fail "restart-services lacks host gate/census helpers"
fi

preflight_gate_line="$(rg -n 'restart_host_tmux_gate "\$target_sha" restart-preflight' "$RESTART" | head -1 | cut -d: -f1)"
preflight_merge_line="$(rg -n 'merge --ff-only --quiet "\$target_sha"' "$RESTART" | head -1 | cut -d: -f1)"
lead_gate_line="$(rg -n 'restart_host_tmux_gate "\$host_tmux_target_sha" restart-lead-wave' "$RESTART" | head -1 | cut -d: -f1)"
lead_census_line="$(rg -n '^[[:space:]]*if ! restart_host_tmux_census "\$candidates_file"; then$' "$RESTART" | head -1 | cut -d: -f1)"
candidate_line="$(rg -n '^[[:space:]]*lead_restart_collect_candidates ' "$RESTART" | head -1 | cut -d: -f1)"
candidate_consume_line="$(rg -n '^[[:space:]]*done < "\$candidates_file"$' "$RESTART" | head -1 | cut -d: -f1)"

if [[ "$preflight_gate_line" =~ ^[0-9]+$ && "$preflight_merge_line" =~ ^[0-9]+$ \
  && "$preflight_gate_line" -lt "$preflight_merge_line" ]]; then
  pass "manual restart gates the captured target before fast-forward"
else
  fail "restart preflight host gate is not before merge"
fi

if [[ "$lead_gate_line" =~ ^[0-9]+$ && "$lead_census_line" =~ ^[0-9]+$ \
  && "$candidate_line" =~ ^[0-9]+$ && "$candidate_consume_line" =~ ^[0-9]+$ \
  && "$lead_gate_line" -lt "$candidate_line" \
  && "$candidate_line" -lt "$lead_census_line" \
  && "$lead_census_line" -lt "$candidate_consume_line" ]]; then
  pass "loaded candidate authority feeds census before Lead consumption"
else
  fail "Lead wave gate/candidate/census ordering is incomplete"
fi

echo ""
echo "host-tmux-selection-restart-mounts: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
