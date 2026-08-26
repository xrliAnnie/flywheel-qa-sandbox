#!/bin/bash
# FLY-913: lead-alert.sh --strict-delivery machine-readable result channel.
#
# The restart-guard hook's bypass contract needs to distinguish "transiently
# failed but queued (WILL drain)" from "permanently undeliverable" — exit 2
# alone conflates them (Codex R1 #1). Asserts, hermetically (fake curl +
# isolated FLYWHEEL_* dirs + shimmed osascript, no network / no real
# ~/.flywheel):
#   1. All five strict results, one scenario each:
#        sent · duplicate(active lease) · queued_transient · dead_lettered · config_error
#      (config_error covers BOTH pure config exits AND no-token — plan §4)
#   2. A duplicate WITH a sent/queued receipt returns that proven result; a bare
#      legacy claim is leased and retried instead of being mistaken for delivery.
#   3. Reverse-compat: WITHOUT the flag, stdout is byte-empty and exit codes
#      are unchanged for the same scenarios.
#   4. Kind face parity: restart_guard_bypass is accepted by lead-alert.sh
#      AND present in the TS AlertEventType union (LeadAlertNotifier.ts) —
#      an unknown kind is still rejected (allowlist genuinely enforced).
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
LEAD_ALERT="${REPO_ROOT}/scripts/lead-alert.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

for tool in jq sqlite3 shasum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "SKIP: required tool '$tool' not in PATH" >&2; exit 0; }
done
[ -f "$LEAD_ALERT" ] || { echo "FAIL: $LEAD_ALERT missing" >&2; exit 1; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/fly913-strict.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

# ── Fake curl (HTTP code from CURL_HTTP_CODE) + shimmed osascript ────────────
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'FAKE'
#!/bin/bash
printf 'call\n' >> "${CURL_CALLS:?}"
printf '%s' "${CURL_HTTP_CODE:-200}"
exit 0
FAKE
chmod +x "$TMP/bin/curl"
# meta-alert.sh fires on dead-letter paths — shim osascript so no desktop
# notification pops during tests.
printf '#!/bin/bash\nexit 0\n' > "$TMP/bin/osascript"
chmod +x "$TMP/bin/osascript"

PROJECTS_FILE="$TMP/projects.json"
cat > "$PROJECTS_FILE" <<'JSON'
[
  {
    "projectName": "flywheel",
    "generalChannel": "999999999999999999",
    "leads": [
      {
        "agentId": "flywheel-eng-lead",
        "alertChannel": "444444444444444444",
        "alertBotTokenEnv": "FLY913_ALERT_TOKEN",
        "botTokenEnv": "FLY913_LEAD_TOKEN"
      },
      {
        "agentId": "tokenless-lead",
        "alertChannel": "555555555555555555",
        "alertBotTokenEnv": "FLY913_EMPTY_TOKEN",
        "botTokenEnv": "FLY913_EMPTY_TOKEN2"
      }
    ]
  }
]
JSON

run_alert() {
  # $1 = http code for fake curl, remaining = extra args. Isolated env.
  local http="$1"; shift
  PATH="$TMP/bin:$PATH" \
  CURL_CALLS="$TMP/curl.calls" \
  CURL_HTTP_CODE="$http" \
  FLYWHEEL_PROJECTS_FILE="$PROJECTS_FILE" \
  FLYWHEEL_CLAIMS_DB="$TMP/claims.db" \
  FLYWHEEL_ALERT_QUEUE_DIR="$TMP/queue" \
  FLYWHEEL_ALERT_DEADLETTER_DIR="$TMP/deadletter" \
  FLYWHEEL_STATE_DIR="$TMP/state" \
  FLY913_ALERT_TOKEN="CANARY-TOKEN" \
  bash "$LEAD_ALERT" --project flywheel --kind restart_guard_bypass \
    --severity severe --title T --body B "$@"
}

run_routed_alert() {
  # $1 = http code, $2 = kind, $3 = signature, $4 = queue dir, $5 = channel,
  # $6 = optional 1 for the ordinary-message delivery style.
  local http="$1" kind="$2" signature="$3" queue_dir="$4" channel="$5" plain="${6:-0}"
  local style_args=()
  if [ "$plain" = "1" ]; then style_args=(--plain-message); fi
  PATH="$TMP/bin:$PATH" \
  CURL_CALLS="$TMP/curl.calls" \
  CURL_HTTP_CODE="$http" \
  FLYWHEEL_CLAIMS_DB="$TMP/claims.db" \
  FLYWHEEL_ALERT_QUEUE_DIR="$queue_dir" \
  FLYWHEEL_ALERT_DEADLETTER_DIR="$TMP/deadletter" \
  FLYWHEEL_STATE_DIR="$TMP/state" \
  FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="$channel" \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="FLY913_ALERT_TOKEN" \
  FLY913_ALERT_TOKEN="CANARY-TOKEN" \
  bash "$LEAD_ALERT" --project flywheel --lead flywheel-eng-lead \
    --kind "$kind" --severity severe --title T --body B \
    --signature "$signature" --strict-delivery "${style_args[@]}"
}

# ── 1. sent ──────────────────────────────────────────────────────────────────
OUT=$(run_alert 200 --lead flywheel-eng-lead --signature sig-sent --strict-delivery 2>/dev/null); RC=$?
if [ "$RC" = "0" ] && [ "$OUT" = "sent" ]; then ok "strict: HTTP 200 → sent (exit 0)"; else bad "sent: rc=$RC out='$OUT'"; fi

# ── 2. sent receipt (same signature again; no second POST) ───────────────────
CALLS_BEFORE=$(wc -l < "$TMP/curl.calls" | tr -d ' ')
OUT=$(run_alert 200 --lead flywheel-eng-lead --signature sig-sent --strict-delivery 2>/dev/null); RC=$?
CALLS_AFTER=$(wc -l < "$TMP/curl.calls" | tr -d ' ')
if [ "$RC" = "0" ] && [ "$OUT" = "sent" ] && [ "$CALLS_BEFORE" = "$CALLS_AFTER" ]; then ok "strict: duplicate with sent receipt → sent without re-POST"; else bad "sent receipt: rc=$RC out='$OUT' calls=$CALLS_BEFORE/$CALLS_AFTER"; fi

# ── 2b. bare legacy claim is retried; active lease is not ────────────────────
event_id() {
  LC_ALL=C printf '%s|%s|%s|%s' flywheel flywheel-eng-lead restart_guard_bypass "$1" \
    | LC_ALL=C shasum -a 1 | awk '{print $1}'
}
BARE_ID=$(event_id sig-bare)
sqlite3 "$TMP/claims.db" "INSERT INTO alert_claims VALUES ('$BARE_ID','flywheel-eng-lead','restart_guard_bypass',strftime('%s','now'));"
OUT=$(run_alert 200 --lead flywheel-eng-lead --signature sig-bare --strict-delivery 2>/dev/null); RC=$?
if [ "$RC" = "0" ] && [ "$OUT" = "sent" ]; then ok "strict: bare legacy claim → leased retry → sent"; else bad "bare claim: rc=$RC out='$OUT'"; fi

LEASE_ID=$(event_id sig-lease)
sqlite3 "$TMP/claims.db" "INSERT INTO alert_claims VALUES ('$LEASE_ID','flywheel-eng-lead','restart_guard_bypass',strftime('%s','now')); INSERT INTO alert_deliveries(event_id,state,lease_token,lease_until,attempt_count,updated_at,last_error) VALUES ('$LEASE_ID','leased','other',strftime('%s','now')+60,1,strftime('%s','now'),NULL);"
CALLS_BEFORE=$(wc -l < "$TMP/curl.calls" | tr -d ' ')
OUT=$(run_alert 200 --lead flywheel-eng-lead --signature sig-lease --strict-delivery 2>/dev/null); RC=$?
CALLS_AFTER=$(wc -l < "$TMP/curl.calls" | tr -d ' ')
if [ "$RC" = "0" ] && [ "$OUT" = "duplicate" ] && [ "$CALLS_BEFORE" = "$CALLS_AFTER" ]; then ok "strict: active delivery lease → duplicate/unconfirmed without POST"; else bad "active lease: rc=$RC out='$OUT' calls=$CALLS_BEFORE/$CALLS_AFTER"; fi
sqlite3 "$TMP/claims.db" "UPDATE alert_deliveries SET lease_until=0 WHERE event_id='$LEASE_ID';"
OUT=$(run_alert 200 --lead flywheel-eng-lead --signature sig-lease --strict-delivery 2>/dev/null); RC=$?
if [ "$RC" = "0" ] && [ "$OUT" = "sent" ]; then ok "strict: stale lease → takeover → sent"; else bad "stale lease: rc=$RC out='$OUT'"; fi

# POST success followed by receipt-write failure stays unconfirmed. Replay may
# duplicate the Discord post, but the stable event id converges to sent.
CRASH_ID=$(event_id sig-post-receipt-crash)
sqlite3 "$TMP/claims.db" "CREATE TRIGGER fail_sent_receipt BEFORE UPDATE OF state ON alert_deliveries WHEN NEW.event_id='$CRASH_ID' AND NEW.state='sent' BEGIN SELECT RAISE(ABORT,'injected receipt crash'); END;"
OUT=$(run_alert 200 --lead flywheel-eng-lead --signature sig-post-receipt-crash --strict-delivery 2>/dev/null); RC=$?
if [ "$RC" = "0" ] && [ "$OUT" = "duplicate" ]; then ok "strict: POST without durable receipt → duplicate/unconfirmed"; else bad "receipt crash: rc=$RC out='$OUT'"; fi
sqlite3 "$TMP/claims.db" "DROP TRIGGER fail_sent_receipt; UPDATE alert_deliveries SET lease_until=0 WHERE event_id='$CRASH_ID';"
OUT=$(run_alert 200 --lead flywheel-eng-lead --signature sig-post-receipt-crash --strict-delivery 2>/dev/null); RC=$?
CRASH_STATE=$(sqlite3 "$TMP/claims.db" "SELECT state FROM alert_deliveries WHERE event_id='$CRASH_ID';")
if [ "$RC" = "0" ] && [ "$OUT" = "sent" ] && [ "$CRASH_STATE" = "sent" ]; then ok "strict: unreceipted POST replay → stable-id sent receipt"; else bad "receipt recovery: rc=$RC out='$OUT' state=$CRASH_STATE"; fi

# ── 3. queued_transient (HTTP 500 → spill to queue) ──────────────────────────
OUT=$(run_alert 500 --lead flywheel-eng-lead --signature sig-q --strict-delivery 2>/dev/null); RC=$?
NQUEUE=$(ls "$TMP/queue" 2>/dev/null | wc -l | tr -d ' ')
# GNU stat accepts BSD's `-f` but prints filesystem data instead of failing, so
# prefer GNU `-c` and fall back to BSD/macOS `-f`.
QMODE=$(stat -c '%a' "$TMP/queue"/*.json 2>/dev/null || stat -f '%Lp' "$TMP/queue"/*.json 2>/dev/null)
NTMP=$(find "$TMP/queue" -maxdepth 1 -name '*.tmp.*' | wc -l | tr -d ' ')
if [ "$RC" = "2" ] && [ "$OUT" = "queued_transient" ] && [ "$NQUEUE" = "1" ] && [ "$QMODE" = "600" ] && [ "$NTMP" = "0" ]; then
  ok "strict: HTTP 500 → durably queued (0600 temp+fsync+rename)"
else bad "queued_transient: rc=$RC out='$OUT' nqueue=$NQUEUE"; fi

# FLY-2051: transient replays must preserve the switch-family destination,
# while non-switch queue records remain byte-compatible (no route override).
ROUTE_CHANNEL="$(printf '7%.0s' {1..18})"
SWITCH_QUEUE="$TMP/switch-route-queue"
OUT=$(run_routed_alert 500 account_switched sig-switch-route "$SWITCH_QUEUE" "$ROUTE_CHANNEL" 1 2>/dev/null); RC=$?
SWITCH_RECORD=$(find "$SWITCH_QUEUE" -maxdepth 1 -name '*.json' -print -quit 2>/dev/null)
SWITCH_DESTINATION=$(jq -r '.deliveryChannelId // ""' "$SWITCH_RECORD" 2>/dev/null)
SWITCH_STYLE=$(jq -r '.deliveryStyle // ""' "$SWITCH_RECORD" 2>/dev/null)
if [ "$RC" = "2" ] && [ "$OUT" = "queued_transient" ] \
    && [ "$SWITCH_DESTINATION" = "$ROUTE_CHANNEL" ] && [ "$SWITCH_STYLE" = "plain" ]; then
  ok "strict: queued account_switched preserves channel + ordinary-message style"
else bad "switch queue route: rc=$RC out='$OUT' channel='$SWITCH_DESTINATION' style='$SWITCH_STYLE'"; fi

CONTROL_QUEUE="$TMP/control-route-queue"
OUT=$(run_routed_alert 500 quota_no_target sig-control-route "$CONTROL_QUEUE" "$ROUTE_CHANNEL" 2>/dev/null); RC=$?
CONTROL_RECORD=$(find "$CONTROL_QUEUE" -maxdepth 1 -name '*.json' -print -quit 2>/dev/null)
if [ "$RC" = "2" ] && [ "$OUT" = "queued_transient" ] \
    && jq -e '((has("deliveryChannelId") | not) and (has("deliveryStyle") | not))' "$CONTROL_RECORD" >/dev/null 2>&1; then
  ok "strict: queued quota_no_target keeps the legacy record shape"
else bad "control queue route: rc=$RC out='$OUT' record='$CONTROL_RECORD'"; fi

CALLS_BEFORE=$(wc -l < "$TMP/curl.calls" | tr -d ' ')
OUT=$(run_alert 500 --lead flywheel-eng-lead --signature sig-q --strict-delivery 2>/dev/null); RC=$?
CALLS_AFTER=$(wc -l < "$TMP/curl.calls" | tr -d ' ')
NQUEUE_AFTER=$(ls "$TMP/queue" 2>/dev/null | wc -l | tr -d ' ')
if [ "$RC" = "2" ] && [ "$OUT" = "queued_transient" ] && [ "$NQUEUE_AFTER" = "$NQUEUE" ] && [ "$CALLS_BEFORE" = "$CALLS_AFTER" ]; then ok "strict: duplicate with queued receipt → queued without re-POST"; else bad "queued receipt: rc=$RC out='$OUT' queue=$NQUEUE/$NQUEUE_AFTER calls=$CALLS_BEFORE/$CALLS_AFTER"; fi

QUEUE_CRASH_ID=$(event_id sig-queue-receipt-crash)
sqlite3 "$TMP/claims.db" "CREATE TRIGGER fail_queued_receipt BEFORE UPDATE OF state ON alert_deliveries WHEN NEW.event_id='$QUEUE_CRASH_ID' AND NEW.state='queued' BEGIN SELECT RAISE(ABORT,'injected queued receipt crash'); END;"
OUT=$(run_alert 500 --lead flywheel-eng-lead --signature sig-queue-receipt-crash --strict-delivery 2>/dev/null); RC=$?
QUEUE_CRASH_STATE=$(sqlite3 "$TMP/claims.db" "SELECT state FROM alert_deliveries WHERE event_id='$QUEUE_CRASH_ID';")
if [ "$RC" = "2" ] && [ "$OUT" = "duplicate" ] && [ "$QUEUE_CRASH_STATE" = "leased" ]; then ok "strict: durable queue without receipt → duplicate/unconfirmed, not dead-lettered"; else bad "queued receipt crash: rc=$RC out='$OUT' state=$QUEUE_CRASH_STATE"; fi
sqlite3 "$TMP/claims.db" "DROP TRIGGER fail_queued_receipt;"

# ── 4. dead_lettered (permanent HTTP 403) ────────────────────────────────────
OUT=$(run_alert 403 --lead flywheel-eng-lead --signature sig-dl --strict-delivery 2>/dev/null); RC=$?
NDL=$(ls "$TMP/deadletter" 2>/dev/null | wc -l | tr -d ' ')
if [ "$RC" = "2" ] && [ "$OUT" = "dead_lettered" ] && [ "$NDL" = "1" ]; then
  ok "strict: HTTP 403 → dead_lettered (exit 2, dead-letter written)"
else bad "dead_lettered: rc=$RC out='$OUT' ndl=$NDL"; fi

# ── 5a. config_error — no-token lead (plan §4: no-token → config_error) ──────
OUT=$(run_alert 200 --lead tokenless-lead --signature sig-nt --strict-delivery 2>/dev/null); RC=$?
if [ "$RC" = "2" ] && [ "$OUT" = "config_error" ]; then ok "strict: no-token → config_error (exit 2)"; else bad "config_error/no-token: rc=$RC out='$OUT'"; fi

# ── 5b. config_error — unknown lead (exit 1) ─────────────────────────────────
OUT=$(run_alert 200 --lead ghost-lead --signature sig-gl --strict-delivery 2>/dev/null); RC=$?
if [ "$RC" = "1" ] && [ "$OUT" = "config_error" ]; then ok "strict: unknown lead → config_error (exit 1)"; else bad "config_error/unknown-lead: rc=$RC out='$OUT'"; fi

# ── 6. reverse-compat: WITHOUT the flag, stdout byte-empty + same exits ──────
OUT=$(run_alert 200 --lead flywheel-eng-lead --signature rc-sent 2>/dev/null); RC=$?
[ "$RC" = "0" ] && [ -z "$OUT" ] && ok "no-flag: sent path → empty stdout, exit 0" || bad "no-flag sent: rc=$RC out='$OUT'"
OUT=$(run_alert 200 --lead flywheel-eng-lead --signature rc-sent 2>/dev/null); RC=$?
[ "$RC" = "0" ] && [ -z "$OUT" ] && ok "no-flag: duplicate path → empty stdout, exit 0" || bad "no-flag dup: rc=$RC out='$OUT'"
OUT=$(run_alert 500 --lead flywheel-eng-lead --signature rc-q 2>/dev/null); RC=$?
[ "$RC" = "2" ] && [ -z "$OUT" ] && ok "no-flag: transient path → empty stdout, exit 2" || bad "no-flag transient: rc=$RC out='$OUT'"
OUT=$(run_alert 403 --lead flywheel-eng-lead --signature rc-dl 2>/dev/null); RC=$?
[ "$RC" = "2" ] && [ -z "$OUT" ] && ok "no-flag: dead-letter path → empty stdout, exit 2" || bad "no-flag dl: rc=$RC out='$OUT'"
OUT=$(run_alert 200 --lead ghost-lead --signature rc-gl 2>/dev/null); RC=$?
[ "$RC" = "1" ] && [ -z "$OUT" ] && ok "no-flag: unknown lead → empty stdout, exit 1" || bad "no-flag ghost: rc=$RC out='$OUT'"

# ── 7. kind allowlist: restart_guard_bypass in, unknown kind out ─────────────
# (the sent case in 1. already proves restart_guard_bypass is ACCEPTED)
OUT=$(PATH="$TMP/bin:$PATH" FLYWHEEL_PROJECTS_FILE="$PROJECTS_FILE" \
  FLYWHEEL_CLAIMS_DB="$TMP/claims.db" FLYWHEEL_STATE_DIR="$TMP/state" \
  bash "$LEAD_ALERT" --project flywheel --lead flywheel-eng-lead \
  --kind not_a_real_kind --severity severe --title T --body B --strict-delivery 2>/dev/null); RC=$?
if [ "$RC" = "1" ] && [ "$OUT" = "config_error" ]; then ok "unknown kind rejected → config_error (exit 1)"; else bad "unknown kind: rc=$RC out='$OUT'"; fi

# FLY-954: bin_integrity_drift is a real, accepted kind end-to-end (real shell
# enum + HTTP-200 stub — no fake sink; the converge suite's alert stub does NOT
# pin this allowlist). run_alert's built-in --kind is overridden by the extra
# --kind here (lead-alert.sh arg loop: last flag wins).
OUT=$(run_alert 200 --lead flywheel-eng-lead --kind bin_integrity_drift \
  --signature sig-bid --strict-delivery 2>/dev/null); RC=$?
if [ "$RC" = "0" ] && [ "$OUT" = "sent" ]; then
  ok "bin_integrity_drift accepted → sent (exit 0)"
else bad "bin_integrity_drift: rc=$RC out='$OUT'"; fi

# ── 8. TS union parity (shared kind face has no drift) ───────────────────────
TS="${REPO_ROOT}/packages/teamlead/src/LeadAlertNotifier.ts"
grep -q '"restart_guard_bypass"' "$TS" \
  && ok "TS AlertEventType union contains restart_guard_bypass" \
  || bad "TS union missing restart_guard_bypass"
grep -q 'restart_guard_bypass' "$LEAD_ALERT" \
  && ok "lead-alert.sh kind allowlist contains restart_guard_bypass" \
  || bad "lead-alert.sh allowlist missing restart_guard_bypass"
# FLY-954: bin_integrity_drift parity (converge-flywheel-bin.sh ↔ shell ↔ TS)
grep -q '"bin_integrity_drift"' "$TS" \
  && ok "TS AlertEventType union contains bin_integrity_drift" \
  || bad "TS union missing bin_integrity_drift"
grep -q 'bin_integrity_drift' "$LEAD_ALERT" \
  && ok "lead-alert.sh kind allowlist contains bin_integrity_drift" \
  || bad "lead-alert.sh allowlist missing bin_integrity_drift"

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
