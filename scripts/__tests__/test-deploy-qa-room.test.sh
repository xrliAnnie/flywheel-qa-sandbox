#!/usr/bin/env bash
# FLY-529: composition test — mirrors how scripts/test-deploy.sh assembles the
# qa-room.sh lib outputs into the Lead/Bridge env arrays + the slot-local
# projects file, plus the byte-compat default (neither --alerts nor --mode
# roundtable => no qa-room env injected at all).
#
# This complements qa-room-env.test.sh (which unit-tests each pure function) by
# checking the same end-to-end shape test-deploy produces: the shell-side alert
# channel resolution (projects file) and token env land together (Codex R3 #1).
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../lib/qa-room.sh
source "${SCRIPT_DIR}/../lib/qa-room.sh"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/td-qa-room.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
cat > "${ROOT}/slots.json" <<'EOF'
{"slots":[{"id":1,"botAppId":"AAA"},{"id":2,"botAppId":"BBB"}],
 "roundtableChannel":{"channelId":"RT","hostSlot":1,"memberSlots":[2],"triggerMode":"any_top_level"},
 "alertChannel":{"channelId":"AL","repairBotTokenEnv":"TEST_BOT_TOKEN_1"}}
EOF

# ── byte-compat default: MODE=slot, ALERTS=0 → arrays stay empty ─────────────
# (test-deploy only calls the lib inside `if MODE==roundtable` / `if ALERTS==1`.)
LEAD_EXTRA_ENV=(); BRIDGE_EXTRA_ENV=()
if [[ ${#LEAD_EXTRA_ENV[@]} -eq 0 && ${#BRIDGE_EXTRA_ENV[@]} -eq 0 ]]; then
  pass "byte-compat: slot mode + no --alerts injects no qa-room env"
else
  fail "byte-compat default" "lead=${#LEAD_EXTRA_ENV[@]} bridge=${#BRIDGE_EXTRA_ENV[@]}"
fi

# ── alerts wiring (as test-deploy assembles it for slot 1) ──────────────────
SLOT_DIR="/tmp/flywheel-test-slot-1"
BOT_TOKEN_ENV="TEST_BOT_TOKEN_1"; TEST_BOT_TOKEN="tok-1"; AGENT_ID="flywheel-test-1"
ALERT_CHANNEL_ID=$(jq -r '.alertChannel.channelId' "${ROOT}/slots.json")
ALERT_REPAIR_BOT_TOKEN_ENV=$(jq -r --arg d "$BOT_TOKEN_ENV" '.alertChannel.repairBotTokenEnv // $d' "${ROOT}/slots.json")
LEAD_EXTRA_ENV=(); BRIDGE_EXTRA_ENV=()
while IFS= read -r l; do [[ -n "$l" ]] && { BRIDGE_EXTRA_ENV+=("$l"); LEAD_EXTRA_ENV+=("$l"); }; done < <(qa_room_alert_iso_env "$SLOT_DIR")
while IFS= read -r l; do [[ -n "$l" ]] && BRIDGE_EXTRA_ENV+=("$l"); done < <(qa_room_alert_bridge_env "$ALERT_CHANNEL_ID" "$ALERT_REPAIR_BOT_TOKEN_ENV")
LEAD_EXTRA_ENV+=("FLYWHEEL_PROJECTS_FILE=${SLOT_DIR}/flywheel-projects.json")
LEAD_EXTRA_ENV+=("${BOT_TOKEN_ENV}=${TEST_BOT_TOKEN}")
BJ=$(printf '%s\n' "${BRIDGE_EXTRA_ENV[@]}")
LJ=$(printf '%s\n' "${LEAD_EXTRA_ENV[@]}")
if grep -q '^FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=AL$' <<<"$BJ" \
  && grep -q '^FLYWHEEL_ALERT_THREADS=1$' <<<"$BJ" \
  && grep -q '^FLYWHEEL_ALERT_QUEUE_DIR=/tmp/flywheel-test-slot-1/alert-queue$' <<<"$BJ" \
  && grep -q '^FLYWHEEL_CLAIMS_DB=/tmp/flywheel-test-slot-1/alerts/claims.db$' <<<"$LJ" \
  && grep -q '^FLYWHEEL_PROJECTS_FILE=/tmp/flywheel-test-slot-1/flywheel-projects.json$' <<<"$LJ" \
  && grep -q '^TEST_BOT_TOKEN_1=tok-1$' <<<"$LJ"; then
  pass "alerts: Bridge gets unified+threads+iso, Lead gets iso+projects-file+token (R3 token)"
else
  fail "alerts wiring" "BRIDGE=[$BJ] LEAD=[$LJ]"
fi

# Shell-side channel + token resolve together: test-deploy injects the SLOT's
# own BOT_TOKEN_ENV (not the repair env) as alertBotTokenEnv, and that env is the
# one exported to the Lead. Verify both land together (Codex code R1 #3).
PROJECTS='[{"projectName":"test-slot-1","leads":[{"agentId":"flywheel-test-1","botTokenEnv":"TEST_BOT_TOKEN_1"}]}]'
INJECTED=$(printf '%s' "$PROJECTS" | qa_room_inject_alert_into_projects "$AGENT_ID" "$ALERT_CHANNEL_ID" "$BOT_TOKEN_ENV")
GOT_CH=$(printf '%s' "$INJECTED" | jq -r '.[0].leads[0].alertChannel')
GOT_TOK_ENV=$(printf '%s' "$INJECTED" | jq -r '.[0].leads[0].alertBotTokenEnv')
if [[ "$GOT_CH" == "AL" && "$GOT_TOK_ENV" == "TEST_BOT_TOKEN_1" ]] \
  && grep -q "^${GOT_TOK_ENV}=" <<<"$LJ"; then
  pass "alerts shell path: projects.alertChannel + the slot token env it names both reach the Lead"
else
  fail "alerts shell path together" "ch=$GOT_CH tokEnv=$GOT_TOK_ENV leadEnv=[$LJ]"
fi

# Divergence case: slot 2 with repairBotTokenEnv (Bridge) != the slot's own
# token env. The injected projects must name the SLOT's env (the one the Lead
# exports), NOT the repair env — else the shell path would dead-letter no-token
# when the repair env isn't in the Lead environment (Codex code R1 #3).
P2='[{"projectName":"test-slot-2","leads":[{"agentId":"flywheel-test-2","botTokenEnv":"TEST_BOT_TOKEN_2"}]}]'
INJ2=$(printf '%s' "$P2" | qa_room_inject_alert_into_projects "flywheel-test-2" "AL" "TEST_BOT_TOKEN_2")
TOK2=$(printf '%s' "$INJ2" | jq -r '.[0].leads[0].alertBotTokenEnv')
if [[ "$TOK2" == "TEST_BOT_TOKEN_2" ]]; then
  pass "alerts shell path (slot 2): names the slot token env, not the repair env"
else
  fail "alerts shell path slot2 token env" "got=$TOK2 (expected TEST_BOT_TOKEN_2)"
fi

# Bridge repair-token passthrough (Codex R2 #2): when repairBotTokenEnv differs
# from the slot's own token env, test-deploy adds "${repair}=value" to the
# Bridge array so the owner-attributed send chain can deref the repair token.
# This mirrors test-deploy's inline logic; the lib's alert_bridge_env only emits
# the env NAME, so the passthrough is asserted as a separate Bridge entry.
S2_BOT_TOKEN_ENV="TEST_BOT_TOKEN_2"; S2_REPAIR_ENV="TEST_BOT_TOKEN_1"
export TEST_BOT_TOKEN_1="repair-tok-1"
S2_BRIDGE_ENV=()
while IFS= read -r l; do [[ -n "$l" ]] && S2_BRIDGE_ENV+=("$l"); done < <(qa_room_alert_bridge_env "AL" "$S2_REPAIR_ENV")
if [[ -n "$S2_REPAIR_ENV" && "$S2_REPAIR_ENV" != "$S2_BOT_TOKEN_ENV" ]]; then
  S2_BRIDGE_ENV+=("${S2_REPAIR_ENV}=${!S2_REPAIR_ENV:-}")
fi
S2J=$(printf '%s\n' "${S2_BRIDGE_ENV[@]}")
if grep -q '^FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV=TEST_BOT_TOKEN_1$' <<<"$S2J" \
  && grep -q '^TEST_BOT_TOKEN_1=repair-tok-1$' <<<"$S2J"; then
  pass "alerts (slot 2): Bridge array carries repair env NAME + its token VALUE (repair != slot)"
else
  fail "alerts slot2 repair passthrough" "$S2J"
fi

# ── FLY-1165: done-thread reconcile is OFF for every slot Bridge ─────────────
# The sweep hits the REAL Linear API, so test-deploy must UNCONDITIONALLY add
# FLYWHEEL_DONE_THREAD_RECONCILE (default 0, export-overridable opt-in) to the
# slot Bridge env. Asserted against the script SOURCE (not a mirror) so a
# refactor that drops or conditionalizes the line fails here.
TD_SRC="${SCRIPT_DIR}/../test-deploy.sh"
RECON_LINE='BRIDGE_EXTRA_ENV+=("FLYWHEEL_DONE_THREAD_RECONCILE=${FLYWHEEL_DONE_THREAD_RECONCILE:-0}")'
if grep -qF "$RECON_LINE" "$TD_SRC"; then
  pass "reconcile isolation: test-deploy injects FLYWHEEL_DONE_THREAD_RECONCILE (default 0) into every slot Bridge env"
else
  fail "reconcile isolation injection missing" "expected literal line in test-deploy.sh: $RECON_LINE"
fi
# The injection must NOT be nested under a mode/alerts conditional — it lives at
# top level like the FLY-945 founder-attribution bypass right above it.
RECON_CONTEXT=$(grep -B1 -F "$RECON_LINE" "$TD_SRC" | head -1)
if ! grep -qE '^\s+(if|elif|while)' <<<"$RECON_CONTEXT"; then
  pass "reconcile isolation: injection is unconditional (top-level, every slot)"
else
  fail "reconcile isolation conditional" "context: $RECON_CONTEXT"
fi
# Opt-in shell semantics: exporting the var flows through the :-0 default.
RECON_OVERRIDE=$(FLYWHEEL_DONE_THREAD_RECONCILE=1 bash -c 'echo "FLYWHEEL_DONE_THREAD_RECONCILE=${FLYWHEEL_DONE_THREAD_RECONCILE:-0}"')
if [[ "$RECON_OVERRIDE" == "FLYWHEEL_DONE_THREAD_RECONCILE=1" ]]; then
  pass "reconcile isolation: explicit export opts the slot Bridge back in"
else
  fail "reconcile opt-in override" "$RECON_OVERRIDE"
fi

# ── roundtable wiring: host slot gets manager env; non-host gets none ────────
RT_CH=$(jq -r '.roundtableChannel.channelId' "${ROOT}/slots.json")
RT_HOST=$(jq -r '.roundtableChannel.hostSlot' "${ROOT}/slots.json")
RT_TRIG=$(jq -r '.roundtableChannel.triggerMode' "${ROOT}/slots.json")
RT_MEMBERS=$(qa_room_member_user_ids "${ROOT}/slots.json" "$(jq -c '.roundtableChannel.memberSlots' "${ROOT}/slots.json")")
HOST_OUT=$(qa_room_roundtable_bridge_env 1 "$RT_HOST" "$RT_CH" "TEST_BOT_TOKEN_1" "AAA" "$RT_TRIG" "$RT_MEMBERS" "/tmp/flywheel-test-slot-1")
NONHOST_OUT=$(qa_room_roundtable_bridge_env 2 "$RT_HOST" "$RT_CH" "TEST_BOT_TOKEN_2" "BBB" "$RT_TRIG" "$RT_MEMBERS" "/tmp/flywheel-test-slot-2")
if grep -q '^FLYWHEEL_ROUNDTABLE_ENABLED=1$' <<<"$HOST_OUT" \
  && grep -q '^FLYWHEEL_ROUNDTABLE_MEMBER_USER_IDS=BBB$' <<<"$HOST_OUT" \
  && [[ -z "$NONHOST_OUT" ]]; then
  pass "roundtable: host slot 1 runs manager (members=BBB), non-host slot 2 does not"
else
  fail "roundtable wiring" "host=[$HOST_OUT] nonhost=[$NONHOST_OUT]"
fi

echo
echo "[TEST] test-deploy-qa-room: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
