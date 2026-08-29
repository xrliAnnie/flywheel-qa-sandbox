#!/usr/bin/env bash
# FLY-529 alert-mirror smoke — proves the QA Room routes alerts to an isolated
# test channel and isolates BOTH alert writer paths (Bridge LeadAlertNotifier +
# shell lead-alert.sh) from the production queue/claims/dead-letter dirs.
#
# AC4: a Bridge-path alert reaches the isolated test channel, not production.
# AC5: queue/claims/dead-letter for BOTH writers land under the slot dir;
#      production ~/.flywheel/alert-queue|alert-deadletter|alerts/claims.db get
#      ZERO new files and an unchanged claims.db.
#
# The Bridge writer path is triggered deterministically by a small Node harness
# (scripts/lib/qa-fly-529-fire-bridge-alert.mjs) that runs the exact plugin.ts
# composition (resolveAlertDirsFromEnv + createClaims* + LeadAlertNotifier.alert)
# against the real Discord API — no frozen-pane needed (the full LeadWatchdog
# trigger + Cass auto-repair is FLY-368 downstream). The shell path is invoked
# directly as the second writer-path proof.
#
# Requires: setup alertChannel (scripts/setup-alert-channel.sh), TEST_BOT_TOKEN_*,
# and a built teamlead dist (pnpm --filter flywheel-teamlead build).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${HOME}/.flywheel/.env"
SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
PROD_QUEUE="${HOME}/.flywheel/alert-queue"
PROD_DL="${HOME}/.flywheel/alert-deadletter"
PROD_CLAIMS="${HOME}/.flywheel/alerts/claims.db"

log() { echo "[qa-529-al] $(date +%H:%M:%S) $*"; }
fail() { echo "[qa-529-al] FAIL: $*" >&2; FAILED=1; }
FAILED=0
SLOT="${1:-1}"

[[ -f "$SLOTS_FILE" ]] || { echo "ERROR: ${SLOTS_FILE} missing" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "ERROR: ${ENV_FILE} missing" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"

[[ -f "${REPO_ROOT}/packages/teamlead/dist/LeadAlertNotifier.js" ]] \
  || { echo "ERROR: teamlead dist missing — run 'pnpm --filter flywheel-teamlead build' first." >&2; exit 1; }

ALERT_CHANNEL=$(jq -r '.alertChannel.channelId // empty' "$SLOTS_FILE")
if [[ -z "$ALERT_CHANNEL" || "$ALERT_CHANNEL" == "<test-flywheel-alerts-channel-id>" ]]; then
  echo "ERROR: alertChannel not configured. Run scripts/setup-alert-channel.sh <channel-id> first." >&2
  exit 2
fi
SLOT_DIR="/tmp/flywheel-test-slot-${SLOT}"
PROJECTS_FILE="${SLOT_DIR}/flywheel-projects.json"
AGENT_ID=$(jq -r --argjson i "$((SLOT - 1))" '.slots[$i].botName' "$SLOTS_FILE")
TOKEN_VAR=$(jq -r --argjson i "$((SLOT - 1))" '.slots[$i].tokenEnvVar' "$SLOTS_FILE")
REPAIR_ENV=$(jq -r --arg d "$TOKEN_VAR" '.alertChannel.repairBotTokenEnv // $d' "$SLOTS_FILE")

cleanup() { log "teardown"; bash "${SCRIPT_DIR}/test-teardown.sh" "$SLOT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Portable production-dir isolation check: snapshot the file SETS before/after
# and assert no NEW files appeared (no GNU find -newermt — that fails on macOS
# and silently reports 0; Codex code R1 #1). claims.db is a single file → mtime.
snap() { find "$1" -type f 2>/dev/null | LC_ALL=C sort; }
PROD_Q_BEFORE=$(snap "$PROD_QUEUE")
PROD_DL_BEFORE=$(snap "$PROD_DL")
PROD_CLAIMS_MT_BEFORE="missing"
[[ -f "$PROD_CLAIMS" ]] && PROD_CLAIMS_MT_BEFORE=$(stat -f %m "$PROD_CLAIMS" 2>/dev/null || echo "err")

log "deploy slot ${SLOT} (--alerts)"
bash "${SCRIPT_DIR}/test-deploy.sh" --alerts "$SLOT" >/dev/null || { echo "deploy failed" >&2; exit 1; }

# ── Bridge wiring assertion via bridge.log (macOS SIP blocks reading another
# process's env, so `ps eww` shows only the command line — useless here). The
# deployed Bridge, on receiving FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID +
# FLYWHEEL_ALERT_THREADS=1, logs "FLY-368 AlertChannelHub ON (unified
# channel=<id> ...)". That single line proves the alert env block reached the
# Bridge — the isolated queue/claims dirs are injected in the SAME env array, so
# they reach it too. Poll the log briefly (the line prints during startup).
BRIDGE_WIRED=0
for _ in $(seq 1 15); do
  if grep -q "FLY-368 AlertChannelHub ON (unified channel=${ALERT_CHANNEL}" "${SLOT_DIR}/bridge.log" 2>/dev/null; then
    BRIDGE_WIRED=1; break
  fi
  sleep 1
done
if (( BRIDGE_WIRED )); then
  log "PASS: deployed Bridge wired the unified alert channel + alert env (AlertChannelHub ON, channel=${ALERT_CHANNEL})"
else
  fail "deployed Bridge did not log AlertChannelHub ON for ${ALERT_CHANNEL} — alert env not injected (see ${SLOT_DIR}/bridge.log)"
fi

# ── Shell path config wiring: the slot-local projects file names the test
# channel + the slot's own token env (so lead-alert.sh resolves, not the repair
# env). Asserted before the writers so a shell-path config break fails loudly
# (Codex code R2 #1) rather than hiding behind the Bridge harness's claim row.
PROJ_CH=$(jq -r --arg a "$AGENT_ID" '.[] | .leads[] | select(.agentId==$a) | .alertChannel // ""' "$PROJECTS_FILE" 2>/dev/null || echo "")
PROJ_TOK=$(jq -r --arg a "$AGENT_ID" '.[] | .leads[] | select(.agentId==$a) | .alertBotTokenEnv // ""' "$PROJECTS_FILE" 2>/dev/null || echo "")
if [[ "$PROJ_CH" == "$ALERT_CHANNEL" && "$PROJ_TOK" == "$TOKEN_VAR" ]]; then
  log "PASS: slot-local projects names test channel + slot token env (${PROJ_TOK})"
else
  fail "shell config: projects alertChannel=${PROJ_CH} (want ${ALERT_CHANNEL}) alertBotTokenEnv=${PROJ_TOK} (want ${TOKEN_VAR})"
fi

# ── Bridge writer path (deterministic harness, real Discord) ─────────────────
BRIDGE_TITLE="QA-529 bridge alert smoke $(date +%s)"
log "trigger Bridge writer path via harness"
env -i \
  HOME="$HOME" PATH="$PATH" \
  FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="$ALERT_CHANNEL" \
  FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV="$REPAIR_ENV" \
  FLYWHEEL_ALERT_QUEUE_DIR="${SLOT_DIR}/alert-queue" \
  FLYWHEEL_ALERT_DEADLETTER_DIR="${SLOT_DIR}/alert-deadletter" \
  FLYWHEEL_CLAIMS_DB="${SLOT_DIR}/alerts/claims.db" \
  QA_LEAD_ID="$AGENT_ID" QA_PROJECT_NAME="test-slot-${SLOT}" QA_BOT_TOKEN_ENV="$TOKEN_VAR" \
  QA_ALERT_TITLE="$BRIDGE_TITLE" \
  "${TOKEN_VAR}=${!TOKEN_VAR:-}" "${REPAIR_ENV}=${!REPAIR_ENV:-}" \
  node "${SCRIPT_DIR}/lib/qa-fly-529-fire-bridge-alert.mjs" >/tmp/qa529-bridge-fire.out 2>&1 \
  && log "harness: $(cat /tmp/qa529-bridge-fire.out)" \
  || { log "harness output: $(cat /tmp/qa529-bridge-fire.out)"; fail "Bridge alert harness exited non-zero"; }

# ── Shell writer path (second writer-path proof) ────────────────────────────
SHELL_TITLE="QA-529 shell alert smoke $(date +%s)"
log "invoke shell-side lead-alert.sh with the test Lead env"
env -i \
  HOME="$HOME" PATH="$PATH" \
  FLYWHEEL_PROJECTS_FILE="$PROJECTS_FILE" \
  FLYWHEEL_ALERT_QUEUE_DIR="${SLOT_DIR}/alert-queue" \
  FLYWHEEL_ALERT_DEADLETTER_DIR="${SLOT_DIR}/alert-deadletter" \
  FLYWHEEL_CLAIMS_DB="${SLOT_DIR}/alerts/claims.db" \
  "${TOKEN_VAR}=${!TOKEN_VAR:-}" \
  bash "${REPO_ROOT}/scripts/lead-alert.sh" \
    --lead "$AGENT_ID" --project "test-slot-${SLOT}" --kind login_expired \
    --severity warning --title "$SHELL_TITLE" --body "shell-path isolation probe" \
  >/dev/null 2>&1 || true   # exit 2 (queued) is acceptable; assert by files/channel

# ── AC5: EACH writer claimed independently into the slot-local claims.db ─────
# Bridge harness used kind=rate_limit; shell lead-alert.sh used login_expired.
# Per-kind rows prove BOTH paths ran + isolated — not just one (Codex code R2 #1:
# a generic LIMIT 1 would pass on the Bridge row alone even if the shell broke).
SDB="${SLOT_DIR}/alerts/claims.db"
have_claim() { [[ -f "$SDB" ]] && [[ -n "$(sqlite3 "$SDB" "SELECT 1 FROM alert_claims WHERE lead_id='${AGENT_ID}' AND event_type='$1' LIMIT 1;" 2>/dev/null)" ]]; }
have_claim rate_limit \
  && log "PASS AC5: Bridge writer claimed slot-local (rate_limit)" \
  || fail "AC5: Bridge writer claim (rate_limit) missing from slot-local claims.db"
have_claim login_expired \
  && log "PASS AC5: shell writer claimed slot-local (login_expired)" \
  || fail "AC5: shell writer claim (login_expired) missing — shell path did not run/resolve"

# Shell-specific outcome: the shell alert either posted SHELL_TITLE to the test
# channel OR spilled to a slot-local queue/dead-letter JSON for login_expired —
# and NEVER dead-lettered with a config-break reason (no-channel / no-token).
SHELL_SPILL=$(grep -rls --include='*.json' "$SHELL_TITLE" "${SLOT_DIR}/alert-queue" "${SLOT_DIR}/alert-deadletter" 2>/dev/null | head -1 || echo "")
BAD_REASON=""
[[ -n "$SHELL_SPILL" ]] && BAD_REASON=$(jq -r '.queueReason // ""' "$SHELL_SPILL" 2>/dev/null | grep -E 'no-channel|no-token' || echo "")
SHELL_IN_CHANNEL=$(curl -s -H "Authorization: Bot ${!TOKEN_VAR:-}" \
  "https://discord.com/api/v10/channels/${ALERT_CHANNEL}/messages?limit=25" 2>/dev/null \
  | jq -e --arg t "$SHELL_TITLE" '[.[] | select(.content | contains($t))] | length > 0' >/dev/null 2>&1 && echo "yes" || echo "no")
if [[ -z "$BAD_REASON" ]] && { [[ "$SHELL_IN_CHANNEL" == "yes" ]] || [[ -n "$SHELL_SPILL" ]]; }; then
  log "PASS AC5: shell writer resolved the test channel (channel=${SHELL_IN_CHANNEL}, slot-local-spill=${SHELL_SPILL:-none}, no config-break reason)"
else
  fail "AC5: shell writer outcome bad (in-channel=${SHELL_IN_CHANNEL} spill=${SHELL_SPILL:-none} reason=${BAD_REASON:-none})"
fi

# ── AC5: production dirs got ZERO new files + claims.db unchanged ────────────
PROD_Q_AFTER=$(snap "$PROD_QUEUE"); PROD_DL_AFTER=$(snap "$PROD_DL")
NEW_Q=$(LC_ALL=C comm -13 <(printf '%s\n' "$PROD_Q_BEFORE") <(printf '%s\n' "$PROD_Q_AFTER") | sed '/^$/d')
NEW_DL=$(LC_ALL=C comm -13 <(printf '%s\n' "$PROD_DL_BEFORE") <(printf '%s\n' "$PROD_DL_AFTER") | sed '/^$/d')
PROD_CLAIMS_MT_AFTER="missing"
[[ -f "$PROD_CLAIMS" ]] && PROD_CLAIMS_MT_AFTER=$(stat -f %m "$PROD_CLAIMS" 2>/dev/null || echo "err")
if [[ -z "$NEW_Q" && -z "$NEW_DL" && "$PROD_CLAIMS_MT_BEFORE" == "$PROD_CLAIMS_MT_AFTER" ]]; then
  log "PASS AC5: production alert dirs untouched (no new queue/deadletter files; claims.db mtime ${PROD_CLAIMS_MT_BEFORE})"
else
  fail "AC5: production changed — new queue=[${NEW_Q}] new deadletter=[${NEW_DL}] claims ${PROD_CLAIMS_MT_BEFORE}->${PROD_CLAIMS_MT_AFTER}"
fi

# ── AC4: the Bridge-path alert reached the isolated test channel ─────────────
RECENT=$(curl -s -H "Authorization: Bot ${!TOKEN_VAR:-}" \
  "https://discord.com/api/v10/channels/${ALERT_CHANNEL}/messages?limit=25" 2>/dev/null || echo "[]")
if jq -e --arg t "$BRIDGE_TITLE" '[.[] | select(.content | contains($t))] | length > 0' <<<"$RECENT" >/dev/null 2>&1; then
  log "PASS AC4: Bridge alert posted to the isolated test channel ${ALERT_CHANNEL}"
else
  fail "AC4: no Bridge alert in test channel (bot ${TOKEN_VAR} needs Send Messages in #test-flywheel-alerts; harness out: $(cat /tmp/qa529-bridge-fire.out 2>/dev/null))"
fi

echo
[[ "$FAILED" -eq 0 ]] && { log "ALERT SMOKE: PASS"; exit 0; } || { log "ALERT SMOKE: FAIL"; exit 1; }
