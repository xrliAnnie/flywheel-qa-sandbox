#!/usr/bin/env bash
# QA·FLY-1365 Cap ② part B — REAL Discord delivery of the attributed alert.
# Fires the real LeadAlertNotifier.alert() with the real buildAbnormalExitAlertContent
# payload to the ISOLATED test-flywheel-alerts channel, then verifies receipt <30s
# and proves production alert dirs are untouched.
set -uo pipefail
ROOT="/Users/xiaorongli/Dev/flywheel-FLY-1365"
ENV_FILE="${HOME}/.flywheel/.env"
SLOTS="${HOME}/.flywheel/test-slots.json"
PROD_QUEUE="${HOME}/.flywheel/alert-queue"
PROD_DL="${HOME}/.flywheel/alert-deadletter"
PROD_CLAIMS="${HOME}/.flywheel/alerts/claims.db"

# shellcheck disable=SC1090
source "$ENV_FILE"
CHANNEL=$(jq -r '.alertChannel.channelId' "$SLOTS")
TOKEN_ENV=$(jq -r '.slots[0].tokenEnvVar' "$SLOTS")   # TEST_BOT_TOKEN_1
LEAD_ID=$(jq -r '.slots[0].botName' "$SLOTS")          # flywheel-test-1
TOKEN_VAL="${!TOKEN_ENV:-}"
[[ -n "$TOKEN_VAL" ]] || { echo "FAIL: $TOKEN_ENV empty in .env"; exit 2; }
MARKER="fly1365qa-$(date +%s)-$$"

snap() { find "$1" -type f 2>/dev/null | LC_ALL=C sort; }
Q_BEFORE=$(snap "$PROD_QUEUE"); DL_BEFORE=$(snap "$PROD_DL")
CLAIMS_MT_BEFORE="missing"; [[ -f "$PROD_CLAIMS" ]] && CLAIMS_MT_BEFORE=$(stat -f %m "$PROD_CLAIMS" 2>/dev/null||echo err)

echo "── Cap ②B: real Discord delivery to isolated #test-flywheel-alerts ($CHANNEL) ──"
echo "  lead=$LEAD_ID token_env=$TOKEN_ENV marker=$MARKER"

# Harness isolation: the production .env exports FLYWHEEL_ALERT_SENDER_TOKEN_ENV
# (=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN, the single prod gate-keeper sender). If it
# leaks in, the send chain collapses to the PROD dispatch bot, which isn't in the
# isolated test guild → 403. Unset it so the chain uses the test lead's own token
# (proven able to post to the isolated channel). This is env isolation, not a fix.
unset FLYWHEEL_ALERT_SENDER_TOKEN_ENV
export FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="$CHANNEL"
export FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV="$TOKEN_ENV"
export QA_LEAD_ID="$LEAD_ID"
export QA_PROJECT_NAME="flywheel-qa-1365"
export QA_BOT_TOKEN_ENV="$TOKEN_ENV"
export QA_ALERT_MARKER="$MARKER"
export TMPDIR=/tmp

OUT=$(cd "$ROOT" && TMPDIR=/tmp pnpm exec tsx engineering/doc/FLY-1365-codex-groupkill-bridge/qa/cap2b-real-discord-alert.mts 2>&1)
RC=$?
echo "  harness rc=$RC"
echo "$OUT" | tail -3 | sed 's/^/    /'
JSON=$(echo "$OUT" | grep -E '^\{' | tail -1)
SENT_AT=$(echo "$JSON" | jq -r '.sentAt // empty' 2>/dev/null)
ATTRIBUTED=$(echo "$JSON" | jq -r '.attributed // false' 2>/dev/null)
MSG_ID=$(echo "$JSON" | jq -r '.messageId // empty' 2>/dev/null)
[[ "$RC" == "0" ]] || { echo "FAIL: harness did not exit 0"; exit 1; }

# ── Verify RECEIPT via the real Discord API (poll up to 30s) ──
RECV_TS=""; RECV_CONTENT=""
for i in $(seq 1 15); do
  RESP=$(curl -s -A "fly1365-qa/1.0" -H "Authorization: Bot ${TOKEN_VAL}" \
    "https://discord.com/api/v10/channels/${CHANNEL}/messages?limit=25")
  HIT=$(echo "$RESP" | jq -c --arg m "$MARKER" '[.[] | select(.content // "" | contains($m))][0] // empty' 2>/dev/null)
  if [[ -n "$HIT" && "$HIT" != "null" ]]; then
    RECV_CONTENT=$(echo "$HIT" | jq -r '.content')
    RECV_TS=$(echo "$HIT" | jq -r '.timestamp')
    break
  fi
  sleep 2
done

if [[ -z "$RECV_CONTENT" ]]; then
  echo "FAIL: marker $MARKER NOT received in #test-flywheel-alerts within 30s"
  exit 1
fi
NOW_MS=$(( $(date +%s) * 1000 ))
LAT_MS=$(( NOW_MS - SENT_AT ))
echo "  RECEIVED in Discord: message present, latency ≈ ${LAT_MS}ms"
echo "  received content head: $(echo "$RECV_CONTENT" | head -1)"

# The received message must carry the ATTRIBUTED content (not generic).
if echo "$RECV_CONTENT" | grep -q "卡死自杀\|watchdog\|卡死"; then
  ATTR_OK=1; else ATTR_OK=0; fi

# ── Production isolation check ──
Q_AFTER=$(snap "$PROD_QUEUE"); DL_AFTER=$(snap "$PROD_DL")
CLAIMS_MT_AFTER="missing"; [[ -f "$PROD_CLAIMS" ]] && CLAIMS_MT_AFTER=$(stat -f %m "$PROD_CLAIMS" 2>/dev/null||echo err)
ISO_OK=1
[[ "$Q_BEFORE" == "$Q_AFTER" ]] || { echo "FAIL: prod alert-queue changed"; ISO_OK=0; }
[[ "$DL_BEFORE" == "$DL_AFTER" ]] || { echo "FAIL: prod deadletter changed"; ISO_OK=0; }
[[ "$CLAIMS_MT_BEFORE" == "$CLAIMS_MT_AFTER" ]] || { echo "FAIL: prod claims.db mtime changed"; ISO_OK=0; }

echo "── Verdict ──"
echo "  real send+receive to isolated channel: PASS (latency ${LAT_MS}ms < 30000)"
echo "  attributed content reached Discord:     $([[ $ATTR_OK == 1 ]] && echo PASS || echo FAIL)"
echo "  production alert dirs untouched:         $([[ $ISO_OK == 1 ]] && echo PASS || echo FAIL)"

if [[ $ATTR_OK == 1 && $ISO_OK == 1 && $LAT_MS -lt 30000 ]]; then
  echo "RESULT: PASS ✅"
  exit 0
fi
echo "RESULT: FAIL ❌"
exit 1
