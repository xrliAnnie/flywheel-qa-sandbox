#!/usr/bin/env bash
# FLY-247 inc2a (§2.1/§2.5): batch recovery reconciliation tests.
#   R1 launching batch → recover → rejected (pre-accept, zero mutation)
#   R2 running, key config-writing + config landed → manual-intervention →
#      batch recover-required
#   R3 running, key config-writing + config NOT landed → unapplied → reduced
#   R4 running, all keys applied → reduce → applied
#   R5 config-restoring interrupted (our value present) → restore → failed-restored
#   R6 terminal batch returned unchanged
set -uo pipefail

SD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleetrec.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
export FLEET_TXN_DIR="${TMP}/txns"
# shellcheck source=/dev/null
source "${SD}/flywheel-fleet-journal.sh"
# shellcheck source=/dev/null
source "${SD}/flywheel-fleet-batch.sh"

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

seed() { # <file> <oliver_model_or_empty>
  local m="$2"
  if [ -n "$m" ]; then
    printf '[ { "projectName":"geo","projectRoot":"/tmp/g","leads":[ { "agentId":"oliver","chatChannel":"1","match":{"labels":["O"]},"model":"%s" } ] } ]\n' "$m" >"$1"
  else
    printf '[ { "projectName":"geo","projectRoot":"/tmp/g","leads":[ { "agentId":"oliver","chatChannel":"1","match":{"labels":["O"]} } ] } ]\n' >"$1"
  fi
}
mkcf() { # <id>  (oliver null→fable)
  cat >"${TMP}/${1}.cf.json" <<JSON
{ "batchId":"$1","expectedConfigSha":"x","changes":[
  { "key":"geo-oliver","from":{"model":null},"to":{"model":"claude-fable-5"} } ] }
JSON
  echo "${TMP}/${1}.cf.json"
}

# R1 — launching → rejected.
PJ="${TMP}/r1.json"; seed "$PJ" ""
cf=$(mkcf r1); batch_journal_create r1 "$cf" "x"
out=$(fleet_batch_recover "$PJ" r1)
[ "$out" = "rejected" ] && [ "$(batch_journal_status r1)" = "rejected" ] && pass "R1 launching → rejected" || fail "R1 got '$out'"

# R2 — running, config-writing + config landed (fable present) → recover-required.
PJ="${TMP}/r2.json"; seed "$PJ" "claude-fable-5"
cf=$(mkcf r2); batch_journal_create r2 "$cf" "x"
batch_journal_set_status r2 running
batch_key_set_status r2 geo-oliver config-writing
out=$(fleet_batch_recover "$PJ" r2)
[ "$out" = "recover-required" ] && [ "$(batch_key_status r2 geo-oliver)" = "manual-intervention" ] && pass "R2 config-writing+landed → manual → recover-required" || fail "R2 got '$out' key=$(batch_key_status r2 geo-oliver)"

# R3 — running, config-writing + config NOT landed (oliver absent) → unapplied → reduced.
PJ="${TMP}/r3.json"; seed "$PJ" ""
cf=$(mkcf r3); batch_journal_create r3 "$cf" "x"
batch_journal_set_status r3 running
batch_key_set_status r3 geo-oliver config-writing
out=$(fleet_batch_recover "$PJ" r3)
[ "$(batch_key_status r3 geo-oliver)" = "unapplied" ] && [ "$out" = "failed" ] && pass "R3 config-writing+not-landed → unapplied → failed" || fail "R3 got '$out' key=$(batch_key_status r3 geo-oliver)"

# R4 — running, all applied → reduce → applied.
PJ="${TMP}/r4.json"; seed "$PJ" "claude-fable-5"
cf=$(mkcf r4); batch_journal_create r4 "$cf" "x"
batch_journal_set_status r4 running
batch_key_set_status r4 geo-oliver applied
out=$(fleet_batch_recover "$PJ" r4)
[ "$out" = "applied" ] && pass "R4 all-applied → applied" || fail "R4 got '$out'"

# R5 — config-restoring interrupted, our value (fable) present → restore → failed-restored + config back to null.
PJ="${TMP}/r5.json"; seed "$PJ" "claude-fable-5"
cf=$(mkcf r5); batch_journal_create r5 "$cf" "x"
batch_journal_set_status r5 running
batch_key_set_status r5 geo-oliver config-restoring
out=$(fleet_batch_recover "$PJ" r5)
[ "$(batch_key_status r5 geo-oliver)" = "failed-restored" ] && [ "$(fleet_batch_current_model "$PJ" geo-oliver)" = "null" ] && pass "R5 restoring → completed restore" || fail "R5 key=$(batch_key_status r5 geo-oliver) model=$(fleet_batch_current_model "$PJ" geo-oliver)"

# R6 — terminal batch unchanged.
PJ="${TMP}/r6.json"; seed "$PJ" ""
cf=$(mkcf r6); batch_journal_create r6 "$cf" "x"
batch_journal_set_status r6 applied
out=$(fleet_batch_recover "$PJ" r6)
[ "$out" = "applied" ] && [ "$(batch_journal_status r6)" = "applied" ] && pass "R6 terminal unchanged" || fail "R6 got '$out'"

echo "=================================="
echo "fleet-recover tests: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
