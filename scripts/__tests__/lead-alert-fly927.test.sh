#!/usr/bin/env bash
# FLY-927 (Task 1.7): lead-alert.sh unified-channel / single-sender / rate /
# schema alignment (D3 — the shell path is a FIRST-CLASS citizen of the alert
# ticket queue, not a legacy bypass).
#
# Hermetic: fake curl on a prepended PATH (records argv + `-K -` stdin config),
# temp HOME, slot-local claims/queue/deadletter. Asserts:
#   1. FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID wins channel resolution
#   2. FLYWHEEL_ALERT_SENDER_TOKEN_ENV wins identity; with BOTH set the script
#      works for a lead with NO projects.json entry (--lead bridge)
#   3. sender env set but unresolvable → dead-letter, NO per-lead fallback
#   4. token rides `-K -` stdin config, NEVER curl argv
#   5. POST body always carries allowed_mentions {parse: []}
#   6. FLYWHEEL_ALERT_RATE_PER_MIN: at-cap → queued (rate-limited), no POST
#   7. 🎫 schema line in unified+tickets mode; absent when tickets off
#   8. bridge_wrapper_fail accepted by the kind allowlist
#   9. SENTINEL: all new env unset → per-lead projects.json path unchanged
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
LEAD_ALERT="${REPO_ROOT}/lead-alert.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

for tool in jq sqlite3 shasum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "SKIP: required tool '$tool' not in PATH" >&2; exit 0; }
done
[ -x "$LEAD_ALERT" ] || { echo "FAIL: $LEAD_ALERT missing/not executable" >&2; exit 1; }

TMP=$(mktemp -d "/tmp/fly927-alert.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

# Fake curl: records argv; captures `-K -` stdin config; honors -o; emits 200.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'FAKE'
#!/bin/bash
printf '%s\n' "$*" >> "$CURL_ARGS_FILE"
out=""; prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  [ "$prev" = "-K" ] && [ "$a" = "-" ] && cat >> "${CURL_ARGS_FILE}.stdin"
  prev="$a"
done
[ -n "$out" ] && : > "$out"
printf '200'
exit 0
FAKE
cat > "$TMP/bin/osascript" <<'FAKE'
#!/bin/bash
exit 0
FAKE
chmod +x "$TMP/bin/curl" "$TMP/bin/osascript"

CANARY="FLY927-CANARY-TOKEN-$$"
LEGACY="FLY927-LEGACY-TOKEN-$$"
PROJECTS_FILE="$TMP/projects.json"
cat > "$PROJECTS_FILE" <<JSON
[
  { "projectName": "flywheel",
    "projectRoot": "$TMP/repo",
    "leads": [
      { "agentId": "test-lead",
        "chatChannel": "111111111111111111",
        "alertChannel": "444444444444444444",
        "alertBotTokenEnv": "LEGACY_BOT_TOKEN",
        "match": { "labels": ["x"] } }
    ] }
]
JSON

# run_alert <home-suffix> <kind> <lead> [extra env KEY=VAL ...]
run_alert() {
  local suffix="$1" kind="$2" lead="$3"; shift 3
  local home="$TMP/home-$suffix"
  mkdir -p "$home"
  env PATH="$TMP/bin:$PATH" HOME="$home" \
    CURL_ARGS_FILE="$TMP/curl-$suffix" \
    FLYWHEEL_PROJECTS_FILE="$PROJECTS_FILE" \
    FLYWHEEL_CLAIMS_DB="$TMP/claims-$suffix.db" \
    FLYWHEEL_ALERT_QUEUE_DIR="$TMP/queue-$suffix" \
    FLYWHEEL_ALERT_DEADLETTER_DIR="$TMP/dl-$suffix" \
    LEGACY_BOT_TOKEN="$LEGACY" \
    FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="" \
    FLYWHEEL_ALERT_SENDER_TOKEN_ENV="" \
    FLYWHEEL_ALERT_TICKETS="" \
    FLYWHEEL_ALERT_RATE_PER_MIN="" \
    "$@" \
    bash "$LEAD_ALERT" \
      --lead "$lead" --project flywheel \
      --kind rate_limit --severity warning \
      --title "T927" --body "B927" --signature "sig-$suffix" \
      --strict-delivery ${kind:+--kind "$kind"} 2>"$TMP/err-$suffix" \
      | tail -n 1
}
# NOTE: --kind appears twice when $kind set (later wins) — harmless, keeps helper simple.

# ── 1+2+4+5+7: unified channel + sender identity + stdin token + mentions + 🎫 ──
RESULT=$(run_alert u1 rate_limit bridge \
  FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="999888777666555444" \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="INFRA_TOKEN" \
  INFRA_TOKEN="$CANARY" \
  FLYWHEEL_ALERT_TICKETS="1")
[ "$RESULT" = "sent" ] && ok "unified+sender: sent for a NO-projects.json lead (--lead bridge)" || bad "unified+sender: expected sent, got '$RESULT'"
grep -q "channels/999888777666555444/messages" "$TMP/curl-u1" \
  && ok "unified channel env wins channel resolution" || bad "POST did not target the unified channel"
grep -qF "Authorization: Bot ${CANARY}" "$TMP/curl-u1.stdin" \
  && ok "sender token resolved via FLYWHEEL_ALERT_SENDER_TOKEN_ENV (stdin config)" || bad "sender token not in stdin config"
grep -qF "$CANARY" "$TMP/curl-u1" \
  && bad "token leaked into curl argv" || ok "token never in curl argv"
grep -q '"allowed_mentions"' "$TMP/curl-u1" && grep -q '"parse": \[\]' "$TMP/curl-u1" \
  && ok "POST body carries allowed_mentions parse:[]" || bad "allowed_mentions missing from body"
grep -q '🎫 flywheel · 首见' "$TMP/curl-u1" \
  && ok "🎫 schema line rendered (unified + tickets on)" || bad "🎫 line missing"
grep -q 'owner — · 状态 NEW' "$TMP/curl-u1" \
  && ok "shell 🎫 line fixed at owner — · 状态 NEW" || bad "🎫 owner/status wrong"

# ── 7b: tickets OFF → no 🎫 even in unified mode ──
run_alert u2 rate_limit bridge \
  FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="999888777666555444" \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="INFRA_TOKEN" \
  INFRA_TOKEN="$CANARY" >/dev/null
grep -q '🎫' "$TMP/curl-u2" \
  && bad "🎫 rendered with tickets OFF" || ok "no 🎫 when FLYWHEEL_ALERT_TICKETS unset"

# ── 3: sender env set but UNRESOLVABLE → dead-letter, no per-lead fallback ──
RESULT=$(run_alert u3 rate_limit test-lead \
  FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="999888777666555444" \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="MISSING_TOKEN_ENV")
[ "$RESULT" = "config_error" ] && ok "unresolvable sender env → config_error (fail-closed)" || bad "expected config_error, got '$RESULT'"
[ ! -f "$TMP/curl-u3" ] && ok "no POST attempted with per-lead token (no fallback)" || bad "fell back to per-lead token"
ls "$TMP/dl-u3"/*.json >/dev/null 2>&1 && ok "payload dead-lettered" || bad "no dead-letter record"

# ── 6: rate cap → queued, no POST ──
run_alert r1 rate_limit test-lead \
  FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="999888777666555444" \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="INFRA_TOKEN" \
  INFRA_TOKEN="$CANARY" \
  FLYWHEEL_ALERT_RATE_PER_MIN="1" >/dev/null
RESULT=$(run_alert r1 usage_limit test-lead \
  FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="999888777666555444" \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="INFRA_TOKEN" \
  INFRA_TOKEN="$CANARY" \
  FLYWHEEL_ALERT_RATE_PER_MIN="1")
[ "$RESULT" = "queued_transient" ] && ok "second alert in the same minute → queued_transient" || bad "rate cap: expected queued_transient, got '$RESULT'"
QCOUNT=$(ls "$TMP/queue-r1"/*.json 2>/dev/null | wc -l | tr -d ' ')
[ "$QCOUNT" = "1" ] && ok "rate-limited record written to queue" || bad "expected 1 queue record, got $QCOUNT"
POSTS=$(grep -c "channels/" "$TMP/curl-r1" 2>/dev/null || echo 0)
[ "$POSTS" = "1" ] && ok "only the first alert POSTed" || bad "expected 1 POST, got $POSTS"
grep -q '"queueReason": "rate-limited"' "$TMP/queue-r1"/*.json \
  && ok "queue record reason = rate-limited" || bad "queue reason wrong"

# ── 8: bridge_wrapper_fail in the allowlist ──
RESULT=$(run_alert w1 bridge_wrapper_fail bridge \
  FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="999888777666555444" \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="INFRA_TOKEN" \
  INFRA_TOKEN="$CANARY")
[ "$RESULT" = "sent" ] && ok "bridge_wrapper_fail accepted + sent" || bad "bridge_wrapper_fail: expected sent, got '$RESULT'"

# ── 9: SENTINEL — all new env unset → legacy per-lead path ──
RESULT=$(run_alert s1 rate_limit test-lead)
[ "$RESULT" = "sent" ] && ok "sentinel: legacy path still sends" || bad "sentinel: expected sent, got '$RESULT'"
grep -q "channels/444444444444444444/messages" "$TMP/curl-s1" \
  && ok "sentinel: channel from projects.json alertChannel" || bad "sentinel: wrong channel"
grep -qF "Authorization: Bot ${LEGACY}" "$TMP/curl-s1.stdin" \
  && ok "sentinel: per-lead token via alertBotTokenEnv" || bad "sentinel: wrong token"
grep -q '🎫' "$TMP/curl-s1" && bad "sentinel: 🎫 leaked into legacy path" || ok "sentinel: no 🎫 on legacy path"

echo ""
echo "FLY-927 lead-alert alignment test: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
