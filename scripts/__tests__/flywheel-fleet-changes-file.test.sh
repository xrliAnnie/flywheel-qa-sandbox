#!/usr/bin/env bash
# FLY-247 inc2a (§2.1): end-to-end CLI wiring of `flywheel-fleet.sh apply
# --changes-file`. Drives the REAL script (not the sourced functions) with a
# temp HOME + a mocked per-key cutover, proving the dispatch + journal + config
# write all connect.
#   E1 syntax: flywheel-fleet.sh parses
#   E2 apply --changes-file (cutover succeeds) → journal applied + config written
#   E3 apply --changes-file (cutover fails) → journal failed + config restored
set -uo pipefail

SD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLEET="${SD}/flywheel-fleet.sh"
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleetcf.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# E1 — syntax.
if bash -n "$FLEET" 2>/dev/null; then pass "E1 flywheel-fleet.sh parses"; else fail "E1 syntax error"; fi

run_changes() { # <home> <batchId> <cutover_rc>
  local home="$1" id="$2" rc="$3"
  mkdir -p "${home}/.flywheel"
  cat >"${home}/.flywheel/projects.json" <<'JSON'
[ { "projectName": "geo", "projectRoot": "/tmp/g", "leads": [
    { "agentId": "oliver", "chatChannel": "2", "match": {"labels":["O"]} } ] } ]
JSON
  local cut="${home}/cutover.sh"
  printf '#!/usr/bin/env bash\nexit %s\n' "$rc" >"$cut"; chmod +x "$cut"
  local sha; sha="$(shasum -a 256 "${home}/.flywheel/projects.json" | awk '{print $1}')"
  cat >"${home}/changes.json" <<JSON
{ "batchId": "${id}", "expectedConfigSha": "${sha}", "changes": [
  { "key": "geo-oliver", "from": {"model":null}, "to": {"model":"claude-fable-5"} } ] }
JSON
  HOME="$home" FLEET_TXN_DIR="${home}/.flywheel/fleet-txns" \
    FLEET_BATCH_CUTOVER_CMD="$cut" \
    bash "$FLEET" apply --changes-file "${home}/changes.json" >/dev/null 2>&1
  return $?
}

# E2 — cutover succeeds → applied + config written.
H2="${TMP}/h2"
run_changes "$H2" e2 0; rc=$?
st=$(jq -r '.batchStatus' "${H2}/.flywheel/fleet-txns/batch-e2.json" 2>/dev/null)
model=$(jq -r '.[0].leads[0].model // "absent"' "${H2}/.flywheel/projects.json")
if [ "$rc" -eq 0 ] && [ "$st" = "applied" ] && [ "$model" = "claude-fable-5" ]; then
  pass "E2 apply --changes-file (cutover ok) → applied + config written"
else
  fail "E2 rc=$rc status=$st model=$model"
fi

# E3 — cutover fails → failed + config restored to original (absent).
H3="${TMP}/h3"
run_changes "$H3" e3 1; rc=$?
st=$(jq -r '.batchStatus' "${H3}/.flywheel/fleet-txns/batch-e3.json" 2>/dev/null)
model=$(jq -r '.[0].leads[0].model // "absent"' "${H3}/.flywheel/projects.json")
if [ "$rc" -ne 0 ] && [ "$st" = "failed" ] && [ "$model" = "absent" ]; then
  pass "E3 apply --changes-file (cutover fail) → failed + config restored"
else
  fail "E3 rc=$rc status=$st model=$model"
fi

echo "=================================="
echo "fleet changes-file CLI tests: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
