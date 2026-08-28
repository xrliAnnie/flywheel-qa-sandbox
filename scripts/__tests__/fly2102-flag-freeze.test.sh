#!/usr/bin/env bash
# FLY-2102: the nine Batch-B2 startup/CLI flag names may survive only in exact
# retirement, QA-exemption, and anti-flag test seams. Every exception is checked
# for liveness so this list cannot widen silently.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d -t fly2102-flag-freeze-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); echo "PASS: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL: $1" >&2; }

allowed_hits=(
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_FLAG_STORE'
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_GHOST_GUARD_WAIT_MS'
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_PUBLISH_BROKER'
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_CONVERGE_CMUX_SYMLINK'
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_CMUX_VIEW_HELPER'
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_CMUX_NODE_PRESENCE'
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS'
  'packages/config/src/feature-flags/truth.ts|FLYWHEEL_LEAD_LEASE_BYPASS'
  'packages/config/src/feature-flags/exemptions.ts|FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE'
  'packages/config/src/__tests__/feature-flags-registry.test.ts|FLYWHEEL_FLAG_STORE'
  'packages/config/src/__tests__/feature-flags-registry.test.ts|FLYWHEEL_GHOST_GUARD_WAIT_MS'
  'packages/config/src/__tests__/feature-flags-registry.test.ts|FLYWHEEL_PUBLISH_BROKER'
  'packages/config/src/__tests__/feature-flags-registry.test.ts|FLYWHEEL_CONVERGE_CMUX_SYMLINK'
  'packages/config/src/__tests__/feature-flags-registry.test.ts|FLYWHEEL_CMUX_VIEW_HELPER'
  'packages/config/src/__tests__/feature-flags-registry.test.ts|FLYWHEEL_CMUX_NODE_PRESENCE'
  'packages/config/src/__tests__/feature-flags-registry.test.ts|FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS'
  'packages/config/src/__tests__/feature-flags-registry.test.ts|FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE'
  'packages/config/src/__tests__/feature-flags-registry.test.ts|FLYWHEEL_LEAD_LEASE_BYPASS'
  'packages/config/src/__tests__/feature-flags-store-policy.test.ts|FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE'
  'packages/config/src/__tests__/fly1981-legacy-snapshot.ts|FLYWHEEL_FLAG_STORE'
  'packages/config/src/__tests__/fly1981-legacy-snapshot.ts|FLYWHEEL_GHOST_GUARD_WAIT_MS'
  'packages/config/src/__tests__/fly1981-legacy-snapshot.ts|FLYWHEEL_PUBLISH_BROKER'
  'packages/config/src/__tests__/fly1981-legacy-snapshot.ts|FLYWHEEL_CONVERGE_CMUX_SYMLINK'
  'packages/config/src/__tests__/fly1981-legacy-snapshot.ts|FLYWHEEL_CMUX_VIEW_HELPER'
  'packages/config/src/__tests__/fly1981-legacy-snapshot.ts|FLYWHEEL_CMUX_NODE_PRESENCE'
  'packages/config/src/__tests__/fly1981-legacy-snapshot.ts|FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS'
  'packages/config/src/__tests__/fly1981-legacy-snapshot.ts|FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE'
  'packages/config/src/__tests__/fly1981-legacy-snapshot.ts|FLYWHEEL_LEAD_LEASE_BYPASS'
  'packages/teamlead/src/bridge/__tests__/flag-store-runtime.test.ts|FLYWHEEL_FLAG_STORE'
  'packages/teamlead/src/__tests__/flag-routes.test.ts|FLYWHEEL_FLAG_STORE'
  'packages/teamlead/src/bridge/__tests__/runs-route.dag-entry.test.ts|FLYWHEEL_GHOST_GUARD_WAIT_MS'
  'packages/flywheel-comm/src/__tests__/lead-lease-enforce.test.ts|FLYWHEEL_LEAD_LEASE_BYPASS'
  'scripts/__tests__/converge-fly1389.test.sh|FLYWHEEL_CONVERGE_CMUX_SYMLINK'
  'scripts/test-cmux-sync.sh|FLYWHEEL_CMUX_VIEW_HELPER'
  'scripts/__tests__/fly1884-node-presence.test.sh|FLYWHEEL_CMUX_NODE_PRESENCE'
  'packages/voice-bridge/src/assistant/wiring.ts|FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE'
  'packages/voice-bridge/e2e/gemini-staged.mjs|FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE'
  'packages/voice-bridge/e2e/gemini-voice-loop.mjs|FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE'
  'packages/voice-bridge/src/__tests__/rig-config.test.ts|FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE'
  'packages/voice-bridge/src/__tests__/assistant-wiring.test.ts|FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE'
)

for entry in "${allowed_hits[@]}"; do
  path="${entry%%|*}"
  token="${entry#*|}"
  if grep -Fq "$token" "$ROOT/$path" 2>/dev/null; then
    pass "live exception: $path :: $token"
  else
    fail "dead exception: $path :: $token"
  fi
done

is_allowed_hit() {
  local candidate_path="$1" candidate_token="$2" entry path token
  for entry in "${allowed_hits[@]}"; do
    path="${entry%%|*}"
    token="${entry#*|}"
    if [[ "$candidate_path" == "$path" && "$candidate_token" == "$token" ]]; then
      return 0
    fi
  done
  return 1
}

pattern='FLYWHEEL_(FLAG_STORE|GHOST_GUARD_WAIT_MS|PUBLISH_BROKER|CONVERGE_CMUX_SYMLINK|CMUX_VIEW_HELPER|CMUX_NODE_PRESENCE|ISSUE_DISPLAY_SWEEP_TICKS|VOICE_QA_PRESENCE_OVERRIDE|LEAD_LEASE_BYPASS)(?![A-Z0-9_])'
raw_hits="$TMP/raw-hits"
(
  cd "$ROOT" || exit 2
  rg -n -o --pcre2 --hidden "$pattern" . \
    -g '!doc/**' \
    -g '!docs/**' \
    -g '!engineering/doc/**' \
    -g '!product/doc/**' \
    -g '!dist/**' \
    -g '!**/dist/**' \
    -g '!scripts/__tests__/fly2102-flag-freeze.test.sh'
) > "$raw_hits" 2>&1
scan_rc=$?
if [[ "$scan_rc" -gt 1 ]]; then
  fail "flag residue scan failed (rc=$scan_rc)"
fi

unexpected="$TMP/unexpected"
: > "$unexpected"
while IFS=: read -r path line token; do
  [[ -n "$path" ]] || continue
  path="${path#./}"
  if ! is_allowed_hit "$path" "$token"; then
    printf '%s:%s:%s\n' "$path" "$line" "$token" >> "$unexpected"
  fi
done < "$raw_hits"

if [[ ! -s "$unexpected" ]]; then
  pass "nine retired names occur only in exact retirement, QA, and anti-flag seams"
else
  fail "unexpected retired flag references remain"
  sed -n '1,160p' "$unexpected" >&2
fi

if [[ ! -d "$ROOT/packages/teamlead/src/bridge/publish-broker" ]] \
  && [[ ! -e "$ROOT/scripts/release/broker-request.mjs" ]] \
  && [[ ! -e "$ROOT/scripts/__tests__/publish-broker-structure.test.sh" ]]; then
  pass "publish broker source, client, and obsolete structure suite are absent"
else
  fail "publish broker source, client, or obsolete structure suite remains"
fi

if ! grep -Fq 'publish-broker-structure.test.sh' "$ROOT/.github/workflows/ci.yml"; then
  pass "CI no longer invokes the deleted publish broker suite"
else
  fail "CI still invokes the deleted publish broker suite"
fi

if grep -Fq 'dist/bridge/publish-broker' "$ROOT/packages/teamlead/package.json"; then
  pass "teamlead build prunes stale compiled publish broker bytes"
else
  fail "teamlead build lacks stale publish broker pruning"
fi

if [[ -f "$ROOT/.github/workflows/payload-activation.yml" ]]; then
  pass "payload activation workflow remains present"
else
  fail "payload activation workflow is missing"
fi

active_bypass_hits="$TMP/active-bypass"
(
  cd "$ROOT" || exit 2
  rg -n 'no_clock:bypass|\[publish-broker\]|flag-store.*bypass' packages scripts \
    -g '!**/__tests__/**' -g '!**/dist/**' -g '!scripts/__tests__/fly2102-flag-freeze.test.sh'
) > "$active_bypass_hits" 2>&1
active_rc=$?
if [[ "$active_rc" -eq 1 ]]; then
  pass "active runtime contains no deleted bypass or broker log path"
elif [[ "$active_rc" -eq 0 ]]; then
  fail "active runtime still contains a deleted bypass or broker log path"
  sed -n '1,120p' "$active_bypass_hits" >&2
else
  fail "active bypass/log scan failed (rc=$active_rc)"
fi

echo "fly2102-flag-freeze: PASSED=$PASSED FAILED=$FAILED"
[[ "$FAILED" -eq 0 ]]
