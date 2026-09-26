#!/usr/bin/env bash
# FLY-247 inc2a (§2.1): fleet_batch_apply orchestration tests (cutover mocked).
#   O1 happy path: all keys applied → reduce=applied → rc0; config written
#   O2 cutover fails on key 2 of 3 → k1 applied, k2 failed-restored (config
#      restored), k3 skipped → reduce=partially-applied → rc!=0
#   O3 baseline mismatch (stale expectedConfigSha) → rejected, ZERO mutation
#   O4 env-pinned (FLYWHEEL_PROJECTS set) → rejected, zero mutation
set -uo pipefail

SD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleetapply.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
export FLEET_TXN_DIR="${TMP}/txns"
# shellcheck source=/dev/null
source "${SD}/flywheel-config-lock.sh"
# shellcheck source=/dev/null
source "${SD}/flywheel-fleet-journal.sh"
# shellcheck source=/dev/null
source "${SD}/flywheel-fleet-batch.sh"

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

seed_config() {
  cat >"$1" <<'JSON'
[ { "projectName": "geo", "projectRoot": "/tmp/g", "leads": [
    { "agentId": "peter",  "chatChannel": "1", "match": {"labels":["P"]}, "model": "claude-fable-5" },
    { "agentId": "oliver", "chatChannel": "2", "match": {"labels":["O"]} },
    { "agentId": "simba",  "chatChannel": "3", "match": {"labels":["S"]} }
] } ]
JSON
}

# changes: peter fable→null, oliver null→fable, simba null→fable
mk_changes() {
  local id="$1" sha="$2"
  cat >"${TMP}/${id}-changes.json" <<JSON
{ "batchId": "${id}", "expectedConfigSha": "${sha}", "changes": [
  { "key": "geo-peter",  "from": {"model":"claude-fable-5"}, "to": {"model":null} },
  { "key": "geo-oliver", "from": {"model":null}, "to": {"model":"claude-fable-5"} },
  { "key": "geo-simba",  "from": {"model":null}, "to": {"model":"claude-fable-5"} }
] }
JSON
  echo "${TMP}/${id}-changes.json"
}

# Mock cutover: succeeds unless the key is in FAIL_KEYS.
mock_cutover() { case " ${FAIL_KEYS:-} " in (*" $1 "*) return 1 ;; esac; return 0; }
export FLEET_BATCH_CUTOVER_CMD=mock_cutover

# ── O1 happy path ────────────────────────────────────────────────
PJ="${TMP}/o1-config.json"; seed_config "$PJ"
SHA="$(file_sha "$PJ")"
CF="$(mk_changes o1 "$SHA")"
batch_journal_create o1 "$CF" "$SHA"
FAIL_KEYS="" fleet_batch_apply "$CF" "$PJ"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(batch_journal_status o1)" = "applied" ] &&
   [ "$(batch_key_status o1 geo-peter)" = "applied" ] &&
   [ "$(fleet_batch_current_model "$PJ" geo-oliver)" = "claude-fable-5" ] &&
   [ "$(fleet_batch_current_model "$PJ" geo-peter)" = "null" ]; then
  pass "O1 happy path → all applied, config written"
else
  fail "O1 rc=$rc status=$(batch_journal_status o1)"
fi

# ── O2 cutover fails on oliver (key 2) ───────────────────────────
PJ="${TMP}/o2-config.json"; seed_config "$PJ"
SHA="$(file_sha "$PJ")"
CF="$(mk_changes o2 "$SHA")"
batch_journal_create o2 "$CF" "$SHA"
FAIL_KEYS="geo-oliver" fleet_batch_apply "$CF" "$PJ"; rc=$?
if [ "$rc" -ne 0 ] &&
   [ "$(batch_journal_status o2)" = "partially-applied" ] &&
   [ "$(batch_key_status o2 geo-peter)" = "applied" ] &&
   [ "$(batch_key_status o2 geo-oliver)" = "failed-restored" ] &&
   [ "$(batch_key_status o2 geo-simba)" = "skipped" ] &&
   [ "$(fleet_batch_current_model "$PJ" geo-oliver)" = "null" ]; then
  pass "O2 mid-fail → partially-applied, oliver restored, simba skipped"
else
  fail "O2 rc=$rc status=$(batch_journal_status o2) oliver=$(batch_key_status o2 geo-oliver)/$(fleet_batch_current_model "$PJ" geo-oliver) simba=$(batch_key_status o2 geo-simba)"
fi

# ── O3 baseline mismatch ─────────────────────────────────────────
PJ="${TMP}/o3-config.json"; seed_config "$PJ"
before="$(cat "$PJ")"
CF="$(mk_changes o3 "deadbeef-stale")"
batch_journal_create o3 "$CF" "deadbeef-stale"
FAIL_KEYS="" fleet_batch_apply "$CF" "$PJ"; rc=$?
if [ "$rc" -ne 0 ] && [ "$(batch_journal_status o3)" = "rejected" ] &&
   [ "$(cat "$PJ")" = "$before" ]; then
  pass "O3 baseline mismatch → rejected, zero mutation"
else
  fail "O3 rc=$rc status=$(batch_journal_status o3) mutated=$([ "$(cat "$PJ")" = "$before" ] && echo no || echo YES)"
fi

# ── O4 env-pinned ────────────────────────────────────────────────
PJ="${TMP}/o4-config.json"; seed_config "$PJ"
SHA="$(file_sha "$PJ")"; before="$(cat "$PJ")"
CF="$(mk_changes o4 "$SHA")"
batch_journal_create o4 "$CF" "$SHA"
FLYWHEEL_PROJECTS='[]' fleet_batch_apply "$CF" "$PJ" 2>/dev/null; rc=$?
if [ "$rc" -ne 0 ] && [ "$(batch_journal_status o4)" = "rejected" ] &&
   [ "$(cat "$PJ")" = "$before" ]; then
  pass "O4 env-pinned → rejected, zero mutation"
else
  fail "O4 rc=$rc status=$(batch_journal_status o4)"
fi

# ── O5 engine claims owner sidecar (Codex R2 HIGH-2) ─────────────
# O1 ran fleet_batch_apply for batch o1 → the engine must have written its
# owner sidecar with a real pid.
OWN="$(batch_owner_path o1)"
if [ -f "$OWN" ] && [ "$(jq -r '.pid' "$OWN")" -gt 0 ] 2>/dev/null; then
  pass "O5 engine wrote owner sidecar with a live pid"
else
  fail "O5 owner sidecar missing/invalid: $OWN"
fi

# ── O6 CAS: journal pre-moved off launching → abort, zero mutation ─
# Simulate a concurrent recover rejecting the batch after creation but before
# the engine transitions; the engine's CAS must abort with zero config mutation.
PJ="${TMP}/o6-config.json"; seed_config "$PJ"
SHA="$(file_sha "$PJ")"; before="$(cat "$PJ")"
CF="$(mk_changes o6 "$SHA")"
batch_journal_create o6 "$CF" "$SHA"
batch_journal_set_status o6 rejected   # concurrent recover wins
FAIL_KEYS="" fleet_batch_apply "$CF" "$PJ" 2>/dev/null; rc=$?
if [ "$rc" -ne 0 ] && [ "$(batch_journal_status o6)" = "rejected" ] &&
   [ "$(cat "$PJ")" = "$before" ] &&
   [ "$(batch_key_status o6 geo-peter)" = "pending" ]; then
  pass "O6 CAS abort (pre-rejected) → stays rejected, zero mutation"
else
  fail "O6 rc=$rc status=$(batch_journal_status o6) mutated=$([ "$(cat "$PJ")" = "$before" ] && echo no || echo YES) peter=$(batch_key_status o6 geo-peter)"
fi

# ── O7 owner-claim failure → fail-closed (Codex R3 HIGH-2a) ──────
# If the engine cannot publish ownership, it must abort with zero mutation
# (never proceed unowned — that's what lets reconcile recover a live engine).
PJ="${TMP}/o7-config.json"; seed_config "$PJ"
SHA="$(file_sha "$PJ")"; before="$(cat "$PJ")"
CF="$(mk_changes o7 "$SHA")"
batch_journal_create o7 "$CF" "$SHA"
# Force the ownership claim to fail for this run only.
batch_journal_claim_owner() { return 1; }
FAIL_KEYS="" fleet_batch_apply "$CF" "$PJ" 2>/dev/null; rc=$?
unset -f batch_journal_claim_owner
if [ "$rc" -ne 0 ] && [ "$(batch_journal_status o7)" = "rejected" ] &&
   [ "$(cat "$PJ")" = "$before" ] &&
   [ "$(batch_key_status o7 geo-peter)" = "pending" ]; then
  pass "O7 owner-claim fail → rejected, zero mutation (fail-closed)"
else
  fail "O7 rc=$rc status=$(batch_journal_status o7) mutated=$([ "$(cat "$PJ")" = "$before" ] && echo no || echo YES)"
fi

echo "=================================="
echo "fleet-apply-batch tests: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
