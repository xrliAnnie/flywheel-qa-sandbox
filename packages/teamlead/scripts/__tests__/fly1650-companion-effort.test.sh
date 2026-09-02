#!/bin/bash
# FLY-1650 (Codex R3): the launcher's FLY-583 companion fallback used to append a
# hardcoded `--effort xhigh`, which re-added the exact effort the model resolver
# had just rejected. It now consumes the resolver's already-narrowed value.
#
# The contract this locks:
#   1. a configured effort still wins (byte-compat);
#   2. a companion with no configured effort still gets the resolver's value —
#      `xhigh` for every model that accepts it, so today's fleet is unchanged;
#   3. a companion whose model accepts NO fallback tier gets no --effort at all,
#      instead of a flag the API would reject;
#   4. the last-good receipt path never invents effort capability metadata.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/../claude-lead.sh"
PASSED=0
FAILED=0

log_test() { echo "[TEST] $*"; }
log_pass() { echo "  ✓ $*"; PASSED=$((PASSED + 1)); }
log_fail() { echo "  ✗ $*" >&2; FAILED=$((FAILED + 1)); }

# Evaluate only the production token-replacement block: from the comment that
# opens it to the model-source log line that closes it.
extract_block() {
  awk '
    /Replace every earlier model\/effort token/ { in_block = 1 }
    in_block && /if \[ "\$_fly1496_reason" = "last_good_receipt" \]/ { exit }
    in_block { print }
  ' "$LAUNCHER"
}

# Run the block with the resolver outputs injected as plain variables, and echo
# the resulting launch_args so the assertions read the real argv.
run_block() {
  local companion="$1" model="$2" effort="$3" companion_effort="$4" block
  block="$(extract_block)"
  bash -c "
    set -uo pipefail
    launch_args=(--dangerously-skip-permissions)
    IS_COMPANION_ROLE=$companion
    _fly1496_model='$model'
    _fly1496_effort='$effort'
    _fly1496_companion_effort='$companion_effort'
    _fly1496_skip=false
    _fly1496_filtered=()
    _fly1496_arg=''
    log() { :; }
    $block
    printf '%s\n' \"\${launch_args[@]}\"
  "
}

assert_argv() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    log_pass "$label"
  else
    log_fail "$label — expected [$expected] got [$actual]"
  fi
}

log_test "a configured effort wins regardless of role"
assert_argv "configured high survives" \
  "--dangerously-skip-permissions --model claude-opus-5 --effort high" \
  "$(run_block true claude-opus-5 high xhigh | tr '\n' ' ' | sed 's/ $//')"

log_test "companion with no configured effort uses the resolver's narrowed value"
assert_argv "xhigh preserved for a model that accepts it" \
  "--dangerously-skip-permissions --model claude-opus-5 --effort xhigh" \
  "$(run_block true claude-opus-5 "" xhigh | tr '\n' ' ' | sed 's/ $//')"

log_test "companion whose model accepts no fallback tier gets no --effort"
assert_argv "flag omitted rather than rejected upstream" \
  "--dangerously-skip-permissions --model claude-opus-4-6" \
  "$(run_block true claude-opus-4-6 "" "" | tr '\n' ' ' | sed 's/ $//')"

log_test "non-companion roles are untouched by the fallback"
assert_argv "no --effort for a non-companion without config" \
  "--dangerously-skip-permissions --model claude-opus-5" \
  "$(run_block false claude-opus-5 "" xhigh | tr '\n' ' ' | sed 's/ $//')"

# A last-good receipt proves only model identity/window/revision. It cannot
# safely reconstruct an effort capability, so the degraded path starts empty.
log_test "last-good authority path does not invent effort capability"
if grep -q '^  local _fly1496_companion_effort=""$' "$LAUNCHER"; then
  log_pass "declaration leaves the companion fallback empty until resolver proof"
else
  log_fail "declaration still seeds an unverified companion effort"
fi

# ── FLY-1650 (Codex R4): the PARSE step, not just the argv step ──────────────
# jq's `//` collapses "field absent" and "field explicitly null". Collapsing
# them lets an older dist (new shell + stale build — a real deployment window)
# erase the seeded FLY-583 literal and silently drop a companion's effort flag.
# Absent ⇒ keep the seed; present-and-null ⇒ omit the flag.

extract_parse_block() {
  awk '
    /^  if \[ -n "\$_fly1496_result" \] && jq -e/ { in_block = 1 }
    in_block && /Replace every earlier model\/effort token/ { exit }
    in_block { print }
  ' "$LAUNCHER"
}

run_parse() {
  local decision_json="$1" block
  block="$(extract_parse_block)"
  bash -c "
    set -uo pipefail
    _fly1496_result='$decision_json'
    _fly1496_model=claude-fable-5-1
    _fly1496_raw_model=''
    _fly1496_effort=''
    _fly1496_raw_effort=''
    _fly1496_reason=model_authority_unavailable
    _fly1496_substituted=true
    _fly1496_companion_effort=xhigh
    FLYWHEEL_LEAD_MODEL=''
    LOGGED=''
    log() { LOGGED=\"\$LOGGED\$*\"; }
    return() { :; }
    $block
    printf '%s\n' \"\$_fly1496_companion_effort\"
    printf 'LOG:%s\n' \"\$LOGGED\"
  "
}

assert_parse() {
  local label="$1" expected="$2" actual="$3"
  actual="$(printf '%s\n' "$actual" | head -1)"
  if [ "$actual" = "$expected" ]; then
    log_pass "$label"
  else
    log_fail "$label — expected [$expected] got [$actual]"
  fi
}

log_test "parse: a current resolver's value is adopted"
assert_parse "explicit xhigh adopted" "xhigh" \
  "$(run_parse '{"ok":true,"decision":{"model":"claude-opus-5","reason":"configured","substituted":false,"companionDefaultEffort":"xhigh"}}')"

log_test "parse: an explicit null omits the flag"
assert_parse "null ⇒ empty ⇒ no --effort" "" \
  "$(run_parse '{"ok":true,"decision":{"model":"claude-opus-4-6","reason":"configured","substituted":false,"companionDefaultEffort":null}}')"

# Codex R5: keeping the seed here is NOT safe — an older dist can still resolve
# a model that rejects xhigh (e.g. a models.json-declared Opus 4.6), and the
# shell has no registry to tell the two apart. Any literal is a guess that is
# wrong in one direction or the other, so refuse to guess: warn loudly and take
# the branch that cannot produce an invalid launch.
log_test "parse: an OLDER dist without the field refuses to guess"
absent_out="$(run_parse '{"ok":true,"decision":{"model":"claude-opus-5","reason":"configured","substituted":false}}')"
assert_parse "absent ⇒ no fallback tier invented" "" "$absent_out"
if printf '%s\n' "$absent_out" | grep -q 'LOG:.*build/deploy skew'; then
  log_pass "absent ⇒ skew is reported, not silent"
else
  log_fail "absent ⇒ skew must be logged; got [$(printf '%s\n' "$absent_out" | tail -1)]"
fi

# ── FLY-1650 (Codex R6): the COMBINED parse → argv path ──────────────────────
# Testing the two blocks separately hid the real defect: the skew branch cleared
# the fallback but left the old resolver's `decision.effort` — itself never
# narrowed by a dist that old — to reach argv. Drive both blocks in one shell so
# the assertion is the launcher's actual argv.

extract_combined_block() {
  awk '
    /^  if \[ -n "\$_fly1496_result" \] && jq -e/ { in_block = 1 }
    in_block && /if \[ "\$_fly1496_reason" = "last_good_receipt" \]/ { exit }
    in_block { print }
  ' "$LAUNCHER"
}

run_combined() {
  local companion="$1" decision_json="$2" block
  block="$(extract_combined_block)"
  bash -c "
    set -uo pipefail
    launch_args=(--dangerously-skip-permissions)
    IS_COMPANION_ROLE=$companion
    _fly1496_result='$decision_json'
    _fly1496_model=claude-fable-5-1
    _fly1496_raw_model=''
    _fly1496_effort=''
    _fly1496_raw_effort=''
    _fly1496_reason=model_authority_unavailable
    _fly1496_substituted=true
    _fly1496_companion_effort=xhigh
    _fly1496_skip=false
    _fly1496_filtered=()
    _fly1496_arg=''
    FLYWHEEL_LEAD_MODEL=''
    log() { :; }
    return() { :; }
    $block
    printf '%s\n' \"\${launch_args[@]}\"
  " | tr '\n' ' ' | sed 's/ $//'
}

SKEW_46='{"ok":true,"decision":{"model":"claude-opus-4-6","reason":"configured","substituted":false,"effort":"xhigh","rawEffort":"xhigh"}}'
CURRENT_46='{"ok":true,"decision":{"model":"claude-opus-4-6","reason":"configured","substituted":false,"effort":null,"rawEffort":"xhigh","companionDefaultEffort":null}}'
CURRENT_O5='{"ok":true,"decision":{"model":"claude-opus-5","reason":"configured","substituted":false,"effort":"high","rawEffort":"high","companionDefaultEffort":"xhigh"}}'

log_test "combined: skew must not launch an unvalidated configured effort"
assert_argv "old dist + 4.6 + configured xhigh ⇒ no --effort at all" \
  "--dangerously-skip-permissions --model claude-opus-4-6" \
  "$(run_combined true "$SKEW_46")"

log_test "combined: a current resolver's null effort stays omitted"
assert_argv "4.6 with everything narrowed away ⇒ no --effort" \
  "--dangerously-skip-permissions --model claude-opus-4-6" \
  "$(run_combined true "$CURRENT_46")"

log_test "combined: a current resolver's vetted effort still rides"
assert_argv "Opus 5 + high survives end to end" \
  "--dangerously-skip-permissions --model claude-opus-5 --effort high" \
  "$(run_combined true "$CURRENT_O5")"

echo
echo "Passed: $PASSED, Failed: $FAILED"
[ "$FAILED" -eq 0 ]
