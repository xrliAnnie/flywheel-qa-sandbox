#!/usr/bin/env bash
# FLY-529: hermetic unit tests for scripts/lib/qa-room.sh pure helpers.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="${SCRIPT_DIR}/../lib/qa-room.sh"
[[ -f "$LIB" ]] || { echo "[TEST] ✗ lib not found: $LIB"; exit 1; }
# shellcheck source=../lib/qa-room.sh
source "$LIB"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/qa-room-env.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

# ── roundtable bridge env: host slot emits manager config ───────────────────
OUT=$(qa_room_roundtable_bridge_env 1 1 "555" "TEST_BOT_TOKEN_1" "111" "any_top_level" "222,333" "/tmp/slot-1")
if grep -q '^FLYWHEEL_ROUNDTABLE_ENABLED=1$' <<<"$OUT" \
  && grep -q '^FLYWHEEL_ROUNDTABLE_CHANNEL_ID=555$' <<<"$OUT" \
  && grep -q '^FLYWHEEL_ROUNDTABLE_BOT_USER_ID=111$' <<<"$OUT" \
  && grep -q '^FLYWHEEL_ROUNDTABLE_TRIGGER_MODE=any_top_level$' <<<"$OUT" \
  && grep -q '^FLYWHEEL_ROUNDTABLE_MEMBER_USER_IDS=222,333$' <<<"$OUT" \
  && grep -q "^FLYWHEEL_ROUNDTABLE_INBOUND_CURSOR_PATH=/tmp/slot-1/roundtable-inbound-cursor.json$" <<<"$OUT"; then
  pass "roundtable host emits full manager env"
else
  fail "roundtable host env" "$OUT"
fi

# ── roundtable bridge env: non-host slot emits NOTHING ──────────────────────
OUT=$(qa_room_roundtable_bridge_env 2 1 "555" "TEST_BOT_TOKEN_2" "222" "any_top_level" "333" "/tmp/slot-2")
if [[ -z "$OUT" ]]; then
  pass "roundtable non-host emits nothing (single manager invariant)"
else
  fail "roundtable non-host should be empty" "$OUT"
fi

# ── roundtable: empty memberIds omits the MEMBER_USER_IDS var ────────────────
OUT=$(qa_room_roundtable_bridge_env 1 1 "555" "E" "111" "any_top_level" "" "/tmp/s")
if grep -q '^FLYWHEEL_ROUNDTABLE_ENABLED=1$' <<<"$OUT" \
  && ! grep -q 'FLYWHEEL_ROUNDTABLE_MEMBER_USER_IDS' <<<"$OUT"; then
  pass "roundtable empty memberIds omits MEMBER_USER_IDS"
else
  fail "roundtable empty memberIds" "$OUT"
fi

# ── FLY-314 Part b: reply-in-thread lead env OFF => emits NOTHING (byte-compat) ─
OUT=$(qa_room_roundtable_lead_env "555" "0" "0" "2")
if [[ -z "$OUT" ]]; then
  pass "roundtable lead env OFF (replyInThread=0) emits nothing — byte-compatible"
else
  fail "roundtable lead env OFF should be empty" "$OUT"
fi

# ── FLY-314 Part b: reply-in-thread ON + autoContinue ON => full plugin flags ──
OUT=$(qa_room_roundtable_lead_env "555" "1" "1" "3")
if grep -q '^FLYWHEEL_ROUNDTABLE_CHANNEL_ID=555$' <<<"$OUT" \
  && grep -q '^FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD=1$' <<<"$OUT" \
  && grep -q '^FLYWHEEL_ROUNDTABLE_THREAD_BUDGET=3$' <<<"$OUT"; then
  pass "roundtable lead env ON+autoContinue emits channel+reply+budget"
else
  fail "roundtable lead env ON+autoContinue" "$OUT"
fi

# ── FLY-676: autoContinue ON but NO explicit budget => OMIT budget ──
# (test-deploy.sh now passes empty when threadBudget is unset, so the backend default 12 is
# exercised instead of forcing 2). The lead env must NOT carry FLYWHEEL_ROUNDTABLE_THREAD_BUDGET.
OUT=$(qa_room_roundtable_lead_env "555" "1" "1" "")
if ! grep -q 'FLYWHEEL_ROUNDTABLE_THREAD_BUDGET' <<<"$OUT"; then
  pass "FLY-676: autoContinue ON + empty budget omits THREAD_BUDGET (backend default 12 used)"
else
  fail "FLY-676 autoContinue ON + empty budget omits THREAD_BUDGET" "$OUT"
fi

# ── FLY-314 Part b: replyInThread ON but autoContinue OFF => no autocontinue/budget ─
OUT=$(qa_room_roundtable_lead_env "555" "1" "0" "2")
if grep -q '^FLYWHEEL_ROUNDTABLE_CHANNEL_ID=555$' <<<"$OUT" \
  && grep -q '^FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD=1$' <<<"$OUT" \
  && ! grep -q 'FLYWHEEL_ROUNDTABLE_THREAD_BUDGET' <<<"$OUT"; then
  pass "roundtable lead env replyInThread-only omits autocontinue+budget (budget unused without autoContinue)"
else
  fail "roundtable lead env replyInThread-only" "$OUT"
fi

# ── alert iso env: queue/deadletter/claims all under slot dir ───────────────
OUT=$(qa_room_alert_iso_env "/tmp/slot-7")
if grep -q '^FLYWHEEL_ALERT_QUEUE_DIR=/tmp/slot-7/alert-queue$' <<<"$OUT" \
  && grep -q '^FLYWHEEL_ALERT_DEADLETTER_DIR=/tmp/slot-7/alert-deadletter$' <<<"$OUT" \
  && grep -q '^FLYWHEEL_CLAIMS_DB=/tmp/slot-7/alerts/claims.db$' <<<"$OUT"; then
  pass "alert iso env isolates queue/deadletter/claims to slot dir"
else
  fail "alert iso env" "$OUT"
fi

# ── alert bridge env: unified channel + repair bot ──────────────────────────
OUT=$(qa_room_alert_bridge_env "999" "TEST_BOT_TOKEN_1")
if grep -q '^FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=999$' <<<"$OUT" \
  && grep -q '^FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV=TEST_BOT_TOKEN_1$' <<<"$OUT"; then
  pass "alert bridge env sets unified channel + repair bot"
else
  fail "alert bridge env" "$OUT"
fi

# ── inject alert into projects: only the matching lead gets alertChannel ─────
PROJECTS='[{"projectName":"p","leads":[{"agentId":"flywheel-test-1","botTokenEnv":"TEST_BOT_TOKEN_1","match":{"labels":["*"]}}]}]'
OUT=$(printf '%s' "$PROJECTS" | qa_room_inject_alert_into_projects "flywheel-test-1" "999" "TEST_BOT_TOKEN_1")
GOT_CH=$(printf '%s' "$OUT" | jq -r '.[0].leads[0].alertChannel')
GOT_TOK=$(printf '%s' "$OUT" | jq -r '.[0].leads[0].alertBotTokenEnv')
if [[ "$GOT_CH" == "999" && "$GOT_TOK" == "TEST_BOT_TOKEN_1" ]]; then
  pass "inject alert into projects sets alertChannel + alertBotTokenEnv on the lead"
else
  fail "inject alert into projects" "ch=$GOT_CH tok=$GOT_TOK"
fi

# ── inject alert: non-matching lead untouched ───────────────────────────────
OUT=$(printf '%s' "$PROJECTS" | qa_room_inject_alert_into_projects "other-lead" "999" "X")
GOT_CH=$(printf '%s' "$OUT" | jq -r '.[0].leads[0].alertChannel // "ABSENT"')
if [[ "$GOT_CH" == "ABSENT" ]]; then
  pass "inject alert leaves non-matching lead untouched"
else
  fail "inject alert non-match" "ch=$GOT_CH"
fi

# ── member user ids: resolve botAppId for the non-host member slots ─────────
cat > "${ROOT}/slots.json" <<'EOF'
{"slots":[{"id":1,"botAppId":"AAA"},{"id":2,"botAppId":"BBB"},{"id":3,"botAppId":"CCC"}]}
EOF
OUT=$(qa_room_member_user_ids "${ROOT}/slots.json" "[2]")
[[ "$OUT" == "BBB" ]] && pass "member user ids [2] → BBB" || fail "member ids [2]" "$OUT"
OUT=$(qa_room_member_user_ids "${ROOT}/slots.json" "[2,3]")
[[ "$OUT" == "BBB,CCC" ]] && pass "member user ids [2,3] → BBB,CCC" || fail "member ids [2,3]" "$OUT"

# ── roundtable allowBots: self + OTHER participants (host ∪ members − self) ──
# Regression: the inline jq once did `$participants | index(.id)` where `.` is
# the array → "Cannot index array with string id"; a real deploy caught it.
cat > "${ROOT}/slots3.json" <<'EOF'
{"slots":[{"id":1,"botAppId":"AAA"},{"id":2,"botAppId":"BBB"},{"id":3,"botAppId":"CCC"}]}
EOF
OUT=$(qa_room_roundtable_allowbots "${ROOT}/slots3.json" "AAA" 1 1 "[2]" | jq -c 'sort')
[[ "$OUT" == '["AAA","BBB"]' ]] && pass "allowBots host slot1 → [AAA,BBB] (self + member)" || fail "allowBots host" "$OUT"
OUT=$(qa_room_roundtable_allowbots "${ROOT}/slots3.json" "BBB" 2 1 "[2]" | jq -c 'sort')
[[ "$OUT" == '["AAA","BBB"]' ]] && pass "allowBots member slot2 → [AAA,BBB] (self + host)" || fail "allowBots member" "$OUT"
OUT=$(qa_room_roundtable_allowbots "${ROOT}/slots3.json" "AAA" 1 1 "[2,3]" | jq -c 'sort')
[[ "$OUT" == '["AAA","BBB","CCC"]' ]] && pass "allowBots host w/ members [2,3] → [AAA,BBB,CCC]" || fail "allowBots 3-slot" "$OUT"

echo
echo "[TEST] qa-room-env: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
