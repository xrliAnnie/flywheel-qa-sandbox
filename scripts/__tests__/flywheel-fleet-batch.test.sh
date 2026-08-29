#!/usr/bin/env bash
# FLY-247 inc2a (§2.1): batch canonical-request validation + baseline gate tests.
#   B1  valid model-only request passes structural validation
#   B2  backend field anywhere → rejected (FLY-264)
#   B3  bad batchId grammar → rejected
#   B4  to.model non-string/non-null → rejected
#   B5  duplicate keys → rejected
#   B6  baseline OK: SHA matches + per-key from matches → authorized
#   B7  baseline: config SHA changed since stage → rejected, zero mutation
#   B8  baseline: a key's current model != reviewed from → rejected
#   B9  null from matches an absent model (account default)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/flywheel-fleet-batch.sh"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleetbatch.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
PJ="${TMP}/projects.json"

# Production-ish config: peter on Fable, oliver on account default (no model).
cat >"$PJ" <<'JSON'
[
  { "projectName": "geo", "projectRoot": "/tmp/g", "leads": [
      { "agentId": "peter",  "chatChannel": "1", "match": {"labels":["P"]}, "model": "claude-fable-5" },
      { "agentId": "oliver", "chatChannel": "2", "match": {"labels":["O"]} }
  ]}
]
JSON
SHA="$(file_sha "$PJ")"

mk_changes() { printf '%s' "$1" >"${TMP}/changes.json"; echo "${TMP}/changes.json"; }

# B1 — valid model-only request.
cf=$(mk_changes "{\"batchId\":\"b-1\",\"expectedConfigSha\":\"$SHA\",\"changes\":[
  {\"key\":\"geo-oliver\",\"from\":{\"model\":null},\"to\":{\"model\":\"claude-fable-5\"}}]}")
if fleet_batch_validate_request "$cf" 2>/dev/null; then pass "B1 valid request passes structural"; else fail "B1 valid request rejected"; fi

# B2 — backend field rejected.
cf=$(mk_changes "{\"batchId\":\"b-2\",\"expectedConfigSha\":\"$SHA\",\"changes\":[
  {\"key\":\"geo-oliver\",\"from\":{\"model\":null},\"to\":{\"model\":null,\"backend\":\"codex-app-server\"}}]}")
if ! fleet_batch_validate_request "$cf" 2>/dev/null; then pass "B2 backend field rejected (FLY-264)"; else fail "B2 backend field accepted"; fi

# B3 — bad batchId grammar.
cf=$(mk_changes "{\"batchId\":\"../evil\",\"expectedConfigSha\":\"$SHA\",\"changes\":[
  {\"key\":\"geo-oliver\",\"from\":{\"model\":null},\"to\":{\"model\":null}}]}")
if ! fleet_batch_validate_request "$cf" 2>/dev/null; then pass "B3 bad batchId rejected"; else fail "B3 bad batchId accepted"; fi

# B4 — to.model wrong type.
cf=$(mk_changes "{\"batchId\":\"b-4\",\"expectedConfigSha\":\"$SHA\",\"changes\":[
  {\"key\":\"geo-oliver\",\"from\":{\"model\":null},\"to\":{\"model\":123}}]}")
if ! fleet_batch_validate_request "$cf" 2>/dev/null; then pass "B4 to.model non-string/null rejected"; else fail "B4 bad to.model accepted"; fi

# B5 — duplicate keys.
cf=$(mk_changes "{\"batchId\":\"b-5\",\"expectedConfigSha\":\"$SHA\",\"changes\":[
  {\"key\":\"geo-oliver\",\"from\":{\"model\":null},\"to\":{\"model\":null}},
  {\"key\":\"geo-oliver\",\"from\":{\"model\":null},\"to\":{\"model\":\"claude-fable-5\"}}]}")
if ! fleet_batch_validate_request "$cf" 2>/dev/null; then pass "B5 duplicate keys rejected"; else fail "B5 duplicate keys accepted"; fi

# B6 — baseline OK (SHA + per-key from match).
cf=$(mk_changes "{\"batchId\":\"b-6\",\"expectedConfigSha\":\"$SHA\",\"changes\":[
  {\"key\":\"geo-peter\",\"from\":{\"model\":\"claude-fable-5\"},\"to\":{\"model\":null}},
  {\"key\":\"geo-oliver\",\"from\":{\"model\":null},\"to\":{\"model\":\"claude-fable-5\"}}]}")
if fleet_batch_verify_baseline "$cf" "$PJ" 2>/dev/null; then pass "B6 baseline OK → authorized"; else fail "B6 baseline rejected a valid request"; fi

# B7 — config changed since stage (wrong expectedConfigSha).
cf=$(mk_changes "{\"batchId\":\"b-7\",\"expectedConfigSha\":\"deadbeef\",\"changes\":[
  {\"key\":\"geo-oliver\",\"from\":{\"model\":null},\"to\":{\"model\":null}}]}")
if ! fleet_batch_verify_baseline "$cf" "$PJ" 2>/dev/null; then pass "B7 config-SHA mismatch rejected"; else fail "B7 stale SHA accepted"; fi

# B8 — per-key from mismatch (peter is fable, but request claims from=opus/null).
cf=$(mk_changes "{\"batchId\":\"b-8\",\"expectedConfigSha\":\"$SHA\",\"changes\":[
  {\"key\":\"geo-peter\",\"from\":{\"model\":null},\"to\":{\"model\":\"claude-fable-5\"}}]}")
if ! fleet_batch_verify_baseline "$cf" "$PJ" 2>/dev/null; then pass "B8 per-key from mismatch rejected"; else fail "B8 from mismatch accepted"; fi

# B9 — null from matches an absent model.
cur="$(fleet_batch_current_model "$PJ" "geo-oliver")"
if [ "$cur" = "null" ]; then pass "B9 absent model reads as 'null' (account default)"; else fail "B9 expected 'null', got '$cur'"; fi

# --- WI-2d primitives: per-key write + conditional restore ---
PJ2="${TMP}/pj2.json"; cp "$PJ" "$PJ2"

# B10 — write a model onto a key (account-default → explicit).
fleet_batch_write_key_model "$PJ2" "geo-oliver" "claude-fable-5"
if [ "$(fleet_batch_current_model "$PJ2" geo-oliver)" = "claude-fable-5" ]; then pass "B10 write key model (set)"; else fail "B10 set failed"; fi

# B11 — write "null" deletes the model field (back to account default).
fleet_batch_write_key_model "$PJ2" "geo-peter" "null"
if [ "$(fleet_batch_current_model "$PJ2" geo-peter)" = "null" ] &&
   [ "$(jq -r '.[0].leads[] | select(.agentId=="peter") | has("model")' "$PJ2")" = "false" ]; then
  pass "B11 write 'null' deletes model field"
else fail "B11 null-delete failed"; fi

# B12 — write touches ONLY the target key (oliver still fable, untouched leads intact).
if [ "$(fleet_batch_current_model "$PJ2" geo-oliver)" = "claude-fable-5" ]; then pass "B12 write isolates to target key"; else fail "B12 collateral change"; fi

# B13 — conditional restore succeeds when current == written.
cp "$PJ" "$PJ2"
fleet_batch_write_key_model "$PJ2" "geo-oliver" "claude-fable-5"   # from null → fable
fleet_batch_restore_key "$PJ2" "geo-oliver" "claude-fable-5" "null"  # restore to null
if [ "$(fleet_batch_current_model "$PJ2" geo-oliver)" = "null" ]; then pass "B13 conditional restore (match) → original"; else fail "B13 restore failed"; fi

# B14 — conditional restore REFUSES when an external writer changed the key.
cp "$PJ" "$PJ2"
fleet_batch_write_key_model "$PJ2" "geo-oliver" "claude-fable-5"   # our write
fleet_batch_write_key_model "$PJ2" "geo-oliver" "claude-opus-x"    # "external" change
fleet_batch_restore_key "$PJ2" "geo-oliver" "claude-fable-5" "null"; rc=$?
if [ "$rc" -eq 2 ] && [ "$(fleet_batch_current_model "$PJ2" geo-oliver)" = "claude-opus-x" ]; then
  pass "B14 restore conflict → rc2, no clobber"
else fail "B14 expected rc2/no-clobber, rc=$rc cur=$(fleet_batch_current_model "$PJ2" geo-oliver)"; fi

# --- FLY-671 composite primitive (model + effort, three-state) ---
# B15 — touch_effort=1 sets BOTH model and effort in one write.
cp "$PJ" "$PJ2"
fleet_batch_write_key_fields "$PJ2" "geo-oliver" "claude-sonnet-4-6" 1 "high"
if [ "$(fleet_batch_current_model "$PJ2" geo-oliver)" = "claude-sonnet-4-6" ] &&
   [ "$(fleet_batch_current_effort "$PJ2" geo-oliver)" = "high" ]; then
  pass "B15 composite write sets model + effort"
else fail "B15 composite set failed (model=$(fleet_batch_current_model "$PJ2" geo-oliver) effort=$(fleet_batch_current_effort "$PJ2" geo-oliver))"; fi

# B16 — touch_effort=0 leaves effort UNTOUCHED (three-state absent), writes model only.
cp "$PJ" "$PJ2"
fleet_batch_write_key_fields "$PJ2" "geo-oliver" "x" 1 "medium"   # seed an effort
fleet_batch_write_key_fields "$PJ2" "geo-oliver" "claude-fable-5" 0 "null"  # touch_effort=0
if [ "$(fleet_batch_current_model "$PJ2" geo-oliver)" = "claude-fable-5" ] &&
   [ "$(fleet_batch_current_effort "$PJ2" geo-oliver)" = "medium" ]; then
  pass "B16 touch_effort=0 leaves effort untouched (absent)"
else fail "B16 effort should be preserved, got $(fleet_batch_current_effort "$PJ2" geo-oliver)"; fi

# B17 — touch_effort=1 with effort='null' DELETES the effort field (back to default).
cp "$PJ" "$PJ2"
fleet_batch_write_key_fields "$PJ2" "geo-oliver" "claude-fable-5" 1 "high"
fleet_batch_write_key_fields "$PJ2" "geo-oliver" "claude-fable-5" 1 "null"
if [ "$(fleet_batch_current_effort "$PJ2" geo-oliver)" = "null" ] &&
   [ "$(jq -r '.[0].leads[] | select(.agentId=="oliver") | has("effort")' "$PJ2")" = "false" ]; then
  pass "B17 effort='null' deletes the effort field"
else fail "B17 effort null-delete failed"; fi

# B18 — composite conditional restore refuses if EFFORT was externally changed.
cp "$PJ" "$PJ2"
fleet_batch_write_key_fields "$PJ2" "geo-oliver" "claude-fable-5" 1 "high"   # our write
fleet_batch_write_key_fields "$PJ2" "geo-oliver" "claude-fable-5" 1 "max"    # external effort change
fleet_batch_restore_key_fields "$PJ2" "geo-oliver" "claude-fable-5" "null" 1 "high" "null"; rc=$?
if [ "$rc" -eq 2 ] && [ "$(fleet_batch_current_effort "$PJ2" geo-oliver)" = "max" ]; then
  pass "B18 composite restore refuses on external effort change (rc2, no clobber)"
else fail "B18 expected rc2/no-clobber, rc=$rc effort=$(fleet_batch_current_effort "$PJ2" geo-oliver)"; fi

echo "=================================="
echo "fleet-batch tests: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
