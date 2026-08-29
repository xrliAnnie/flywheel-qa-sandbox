#!/usr/bin/env bash
# FLY-247 inc2a (§2.1/§2.5): write-ahead batch journal tests.
#   J1  create writes a launching record with per-key pending status
#   J2  exclusive create — a second create for the same batchId fails
#   J3  set BatchStatus transitions (launching → running)
#   J4  per-key write-ahead status + intendedPostSha recorded
#   J5  reduce: all applied → "applied"
#   J6  reduce: mixed → "partially-applied"
#   J7  reduce: zero applied → "failed"
#   J8  atomic update never leaves a torn journal (valid JSON throughout)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleetjrnl.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
export FLEET_TXN_DIR="${TMP}/txns"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/flywheel-fleet-journal.sh"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

CF="${TMP}/changes.json"
cat >"$CF" <<'JSON'
{ "batchId": "b1", "expectedConfigSha": "abc",
  "changes": [
    { "key": "geo-peter",  "from": {"model":"claude-fable-5"}, "to": {"model":null} },
    { "key": "geo-oliver", "from": {"model":null}, "to": {"model":"claude-fable-5"} }
  ] }
JSON

# J1 — create launching record.
batch_journal_create "b1" "$CF" "abc"
path="$(batch_journal_path b1)"
if [ -f "$path" ] &&
   [ "$(batch_journal_status b1)" = "launching" ] &&
   [ "$(batch_key_status b1 geo-peter)" = "pending" ] &&
   [ "$(batch_key_status b1 geo-oliver)" = "pending" ]; then
  pass "J1 launching record with per-key pending"
else
  fail "J1 create produced wrong record"
fi

# J2 — exclusive create.
if ! batch_journal_create "b1" "$CF" "abc" 2>/dev/null; then
  pass "J2 duplicate create rejected (exclusive)"
else
  fail "J2 duplicate create overwrote"
fi

# J3 — BatchStatus transition.
batch_journal_set_status b1 running
if [ "$(batch_journal_status b1)" = "running" ]; then pass "J3 set BatchStatus running"; else fail "J3 status not set"; fi

# J4 — per-key write-ahead status + intendedPostSha.
batch_key_set_status b1 geo-peter config-writing "post-sha-123"
if [ "$(batch_key_status b1 geo-peter)" = "config-writing" ] &&
   [ "$(jq -r '.keys["geo-peter"].intendedPostSha' "$path")" = "post-sha-123" ]; then
  pass "J4 write-ahead key status + intendedPostSha"
else
  fail "J4 key status/intendedPostSha wrong"
fi

# J5 — reduce all applied.
batch_key_set_status b1 geo-peter applied
batch_key_set_status b1 geo-oliver applied
r=$(batch_journal_reduce b1)
if [ "$r" = "applied" ] && [ "$(batch_journal_status b1)" = "applied" ]; then pass "J5 reduce all-applied → applied"; else fail "J5 got '$r'"; fi

# J6 — reduce mixed.
batch_journal_create "b6" "$CF" "abc"
batch_key_set_status b6 geo-peter applied
batch_key_set_status b6 geo-oliver failed-restored
r=$(batch_journal_reduce b6)
if [ "$r" = "partially-applied" ]; then pass "J6 reduce mixed → partially-applied"; else fail "J6 got '$r'"; fi

# J7 — reduce zero applied → failed.
batch_journal_create "b7" "$CF" "abc"
batch_key_set_status b7 geo-peter failed-restored
batch_key_set_status b7 geo-oliver config-restore-conflict
r=$(batch_journal_reduce b7)
if [ "$r" = "failed" ]; then pass "J7 reduce zero-applied → failed"; else fail "J7 got '$r'"; fi

# J8 — journal is always valid JSON after updates.
if jq empty "$path" 2>/dev/null; then pass "J8 journal stays valid JSON"; else fail "J8 torn journal"; fi

echo "=================================="
echo "fleet-journal tests: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
