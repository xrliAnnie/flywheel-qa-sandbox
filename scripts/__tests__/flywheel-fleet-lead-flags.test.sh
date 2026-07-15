#!/usr/bin/env bash
# FLY-709 P4.2: single-Lead value-flags entry — the command the console's
# copy-paste text targets:
#   flywheel-fleet.sh apply --lead <key> [--model <id|default>]
#                            [--effort <level|default>] [--backend <id>] --yes
# Sugar around the inc2a batch engine: it builds a canonical changes-file
# (to.model ALWAYS present — filled with the current model on effort-only
# calls; effort keys only when --effort was given) and drives cmd_apply_batch.
#   L1 syntax
#   L2 model+effort apply → config written, journal applied
#   L3 effort-only → model unchanged (canonical to.model = current model)
#   L4 model-only on a lead WITH effort → effort untouched (three-state)
#   L5 --model default → model null (account default)
#   L6 --effort default → effort removed
#   L7 --backend diff → die, zero mutation; --backend same-as-current → no-op dim
#   L8 unknown lead → die
#   L9 without --yes → WOULD-APPLY + non-zero + zero mutation
set -uo pipefail

SD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLEET="${SD}/flywheel-fleet.sh"
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleetlf.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# L1 — syntax.
if bash -n "$FLEET" 2>/dev/null; then pass "L1 flywheel-fleet.sh parses"; else fail "L1 syntax error"; fi

seed_home() { # <home> [model_json] [effort_json] [backend_json]
  local home="$1" model="${2:-null}" effort="${3:-null}" backend="${4:-null}"
  mkdir -p "${home}/.flywheel"
  jq -n --argjson m "$model" --argjson e "$effort" --argjson b "$backend" '
    [ { projectName: "geo", projectRoot: "/tmp/g", leads: [
        ( { agentId: "oliver", chatChannel: "2", match: {labels:["O"]} }
          + (if $m != null then {model: $m} else {} end)
          + (if $e != null then {effort: $e} else {} end)
          + (if $b != null then {backend: $b} else {} end) ) ] } ]
  ' >"${home}/.flywheel/projects.json"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${home}/cutover.sh"
  chmod +x "${home}/cutover.sh"
}

run_flags() { # <home> <args...>
  local home="$1"; shift
  HOME="$home" FLEET_TXN_DIR="${home}/.flywheel/fleet-txns" \
    FLEET_BATCH_CUTOVER_CMD="${home}/cutover.sh" \
    bash "$FLEET" apply "$@" 2>"${home}/stderr.log" >"${home}/stdout.log"
}

lead_field() { # <home> <field>
  jq -r --arg f "$2" '.[0].leads[0][$f] // "absent"' "$1/.flywheel/projects.json"
}

# L2 — model+effort together.
H2="${TMP}/h2"; seed_home "$H2"
run_flags "$H2" --lead geo-oliver --model claude-sonnet-5 --effort high --yes; rc=$?
if [ "$rc" -eq 0 ] && [ "$(lead_field "$H2" model)" = "claude-sonnet-5" ] \
   && [ "$(lead_field "$H2" effort)" = "high" ] \
   && ls "${H2}/.flywheel/fleet-txns/"batch-cli-geo-oliver-*.json >/dev/null 2>&1; then
  pass "L2 --model + --effort apply → config written + cli batch journal"
else
  fail "L2 rc=$rc model=$(lead_field "$H2" model) effort=$(lead_field "$H2" effort)"
fi

# L3 — effort-only: model must stay byte-identical (canonical to.model = current).
H3="${TMP}/h3"; seed_home "$H3" '"claude-opus-4-8[1m]"'
run_flags "$H3" --lead geo-oliver --effort low --yes; rc=$?
if [ "$rc" -eq 0 ] && [ "$(lead_field "$H3" model)" = "claude-opus-4-8[1m]" ] \
   && [ "$(lead_field "$H3" effort)" = "low" ]; then
  pass "L3 effort-only keeps current model (to.model filled, not null)"
else
  fail "L3 rc=$rc model=$(lead_field "$H3" model) effort=$(lead_field "$H3" effort)"
fi

# L4 — model-only on a lead WITH effort: effort untouched (no effort key emitted).
H4="${TMP}/h4"; seed_home "$H4" '"claude-sonnet-5"' '"xhigh"'
run_flags "$H4" --lead geo-oliver --model claude-fable-5 --yes; rc=$?
if [ "$rc" -eq 0 ] && [ "$(lead_field "$H4" model)" = "claude-fable-5" ] \
   && [ "$(lead_field "$H4" effort)" = "xhigh" ]; then
  pass "L4 model-only leaves effort untouched (FLY-671 three-state)"
else
  fail "L4 rc=$rc model=$(lead_field "$H4" model) effort=$(lead_field "$H4" effort)"
fi

# L5 — --model default → null (account default).
H5="${TMP}/h5"; seed_home "$H5" '"claude-sonnet-5"'
run_flags "$H5" --lead geo-oliver --model default --yes; rc=$?
m5=$(jq -r '.[0].leads[0] | has("model") | tostring' "${H5}/.flywheel/projects.json")
m5v=$(jq -r '.[0].leads[0].model // "nullish"' "${H5}/.flywheel/projects.json")
if [ "$rc" -eq 0 ] && { [ "$m5" = "false" ] || [ "$m5v" = "nullish" ]; }; then
  pass "L5 --model default → account default (null)"
else
  fail "L5 rc=$rc has_model=$m5 value=$m5v"
fi

# L6 — --effort default → effort cleared.
H6="${TMP}/h6"; seed_home "$H6" '"claude-sonnet-5"' '"high"'
run_flags "$H6" --lead geo-oliver --effort default --yes; rc=$?
e6=$(jq -r '.[0].leads[0].effort // "cleared"' "${H6}/.flywheel/projects.json")
if [ "$rc" -eq 0 ] && [ "$e6" = "cleared" ]; then
  pass "L6 --effort default → effort cleared"
else
  fail "L6 rc=$rc effort=$e6"
fi

# L7 — backend diff → die with cutover message + zero mutation; same → ignored.
H7="${TMP}/h7"; seed_home "$H7" '"claude-sonnet-5"'
before7=$(cat "${H7}/.flywheel/projects.json")
run_flags "$H7" --lead geo-oliver --backend codex-app-server --model claude-fable-5 --yes; rc=$?
after7=$(cat "${H7}/.flywheel/projects.json")
if [ "$rc" -ne 0 ] && [ "$before7" = "$after7" ] && grep -qi "cutover" "${H7}/stderr.log"; then
  pass "L7a --backend diff → die (manual cutover) + zero mutation"
else
  fail "L7a rc=$rc mutated=$([ "$before7" != "$after7" ] && echo yes || echo no)"
fi
run_flags "$H7" --lead geo-oliver --backend claude-code --model claude-fable-5 --yes; rc=$?
if [ "$rc" -eq 0 ] && [ "$(lead_field "$H7" model)" = "claude-fable-5" ]; then
  pass "L7b --backend same-as-current is a no-op dimension"
else
  fail "L7b rc=$rc model=$(lead_field "$H7" model)"
fi

# L8 — unknown lead → die.
H8="${TMP}/h8"; seed_home "$H8"
run_flags "$H8" --lead nope-lead --model claude-fable-5 --yes; rc=$?
if [ "$rc" -ne 0 ]; then pass "L8 unknown lead → die"; else fail "L8 rc=$rc"; fi

# L9 — without --yes → WOULD-APPLY + non-zero + zero mutation.
H9="${TMP}/h9"; seed_home "$H9"
before9=$(cat "${H9}/.flywheel/projects.json")
run_flags "$H9" --lead geo-oliver --model claude-fable-5; rc=$?
after9=$(cat "${H9}/.flywheel/projects.json")
if [ "$rc" -ne 0 ] && [ "$before9" = "$after9" ] && grep -q "WOULD-APPLY" "${H9}/stdout.log"; then
  pass "L9 without --yes → WOULD-APPLY, non-zero, zero mutation"
else
  fail "L9 rc=$rc mutated=$([ "$before9" != "$after9" ] && echo yes || echo no)"
fi

echo "=================================="
echo "fleet lead-flags CLI tests: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
