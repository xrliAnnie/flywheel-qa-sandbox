#!/bin/bash
# FLY-1708: adoption is attached to physical Lead birth, never to dry-run/HOLD.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEAD_SH="$ROOT/packages/teamlead/scripts/claude-lead.sh"
TMP="$(mktemp -d /tmp/fly1708-lead-adopt.XXXXXX)"
PASS=0
FAIL=0
trap 'rm -rf "$TMP"' EXIT

ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# Pin the production source, not a mirrored test implementation: one call at
# the v2 child fork and none at the dry-run fork.
call_count="$(grep -c '^[[:space:]]*_adopt_inflight_before_launch$' "$LEAD_SH")"
v2_line="$(grep -n '_launch_claude "${_v2_launch_args\[@\]}"' "$LEAD_SH" | cut -d: -f1)"
dry_line="$(grep -n '_launch_claude "${CLAUDE_ARGS\[@\]}" --session-id "DRY-RUN-SESSION"' "$LEAD_SH" | cut -d: -f1)"

previous_is_adopt() {
  local line="$1"
  [ "$(sed -n "$((line - 1))p" "$LEAD_SH" | tr -d '[:space:]')" = "_adopt_inflight_before_launch" ]
}

if [ "$call_count" -eq 1 ] && previous_is_adopt "$v2_line"; then
  ok "v2 adopts exactly at the real fork"
else
  bad "the v2 physical fork is not preceded by exactly one adoption"
fi

if [ -n "$dry_line" ] && ! previous_is_adopt "$dry_line"; then
  ok "dry-run does not adopt"
else
  bad "dry-run must not consume an adoption retry generation"
fi

# Execute the exact helper body with a stub node binary. The success case pins
# the required `node $FLYWHEEL_COMM_CLI adopt-inflight ...` argv; the failure
# case pins fail-open launch behavior.
HELPER="$TMP/helper.sh"
awk '
  /^_adopt_inflight_before_launch\(\)/ { copying=1 }
  copying { print }
  copying && /^}/ { exit }
' "$LEAD_SH" > "$HELPER"

mkdir -p "$TMP/bin"
cat > "$TMP/bin/node" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$FLY1708_CALLS"
if [ "${FLY1708_NODE_FAIL:-0}" = 1 ]; then
  printf 'fixture failure\n' >&2
  exit 17
fi
printf 'adopted: 2\n'
SH
chmod +x "$TMP/bin/node"
touch "$TMP/comm-cli.js"

run_helper() {
  PATH="$TMP/bin:$PATH" \
  FLY1708_CALLS="$TMP/calls" \
  FLYWHEEL_COMM_CLI="$TMP/comm-cli.js" \
  LEAD_ID="eng-lead" \
  FLY1708_NODE_FAIL="${1:-0}" \
  bash -c 'log() { printf "%s\n" "$*"; }; source "$1"; _adopt_inflight_before_launch' bash "$HELPER"
}

success_out="$(run_helper 0)"
if [ "$success_out" = "In-flight adoption: adopted: 2" ] \
  && [ "$(tail -1 "$TMP/calls")" = "$TMP/comm-cli.js adopt-inflight --recipient eng-lead --kind lead" ]; then
  ok "helper uses the required node CLI shape and reports adopted count"
else
  bad "helper success path or argv drifted"
fi

failure_out="$(run_helper 1)"
failure_rc=$?
if [ "$failure_rc" -eq 0 ] \
  && [[ "$failure_out" == "WARNING: in-flight adoption failed (exit 17): fixture failure" ]]; then
  ok "CLI failure is loud but never blocks Lead birth"
else
  bad "CLI failure did not fail open"
fi

# The v2 acquire-bind HOLD loop and rules receipt are structurally before the
# only adoption call, so a held body cannot consume a retry generation.
adopt_call="$(grep -n '^[[:space:]]*_adopt_inflight_before_launch$' "$LEAD_SH" | cut -d: -f1)"
v2_bind="$(grep -n '^[[:space:]]*lead_identity_v2_acquire_bind \\' "$LEAD_SH" | head -1 | cut -d: -f1)"
rules_commit="$(grep -n '^[[:space:]]*if ! _rules_bundle_commit_once; then' "$LEAD_SH" | tail -1 | cut -d: -f1)"
if [ "$v2_bind" -lt "$adopt_call" ] && [ "$rules_commit" -lt "$adopt_call" ]; then
  ok "v2 identity HOLD and rules gates precede adoption"
else
  bad "adoption moved before a HOLD gate"
fi

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
