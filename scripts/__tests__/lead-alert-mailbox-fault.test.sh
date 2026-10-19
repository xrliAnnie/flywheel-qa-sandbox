#!/usr/bin/env bash
# FLY-3083: the mailbox_channel_fault alert as the Runner channel contract uses it.
#
# Hermetic (lead-alert-fly927.test.sh isolation): fake curl on a prepended PATH
# (records each POST; HTTP code from FAKE_HTTP_CODE), temp HOME, test-local
# claims DB / queue / dead-letter dirs. ONE claims DB is shared across cases so
# dedup is observed exactly as a Lead would hit it. Asserts:
#   1. one Lead, two Runners × two subkinds → four distinct event ids, all sent
#   2. same episode (same anchor) again → duplicate, no POST
#   3. episode A reported → episode B (new anchor) for the same Runner/subkind
#      is sent again (recovery then recurrence is not swallowed)
#   4. first send 403 → dead_lettered; sender fixed, retry → duplicate and NO
#      POST — pins "duplicate ≠ escalated"
#   5. a pre-seeded claim with no delivery → duplicate, no POST
#   6. missing --lead / --project / --title → exit 1; unknown kind → config_error
#   7. the contract's template (runner-channel-contract.md), placeholders filled,
#      runs as written → sent; with FLYWHEEL_LEAD_ALERT_SCRIPT unset the `:?`
#      guard stops it before anything is sent
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
LEAD_ALERT="${REPO_ROOT}/scripts/lead-alert.sh"
CONTRACT="${REPO_ROOT}/packages/teamlead/lead-rules-base/runner-channel-contract.md"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

for tool in jq sqlite3 shasum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "SKIP: required tool '$tool' not in PATH" >&2; exit 0; }
done
[ -x "$LEAD_ALERT" ] || { echo "FAIL: $LEAD_ALERT missing/not executable" >&2; exit 1; }

TMP=$(mktemp -d "/tmp/fly3083-alert.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin" "$TMP/home"
cat > "$TMP/bin/curl" <<'FAKE'
#!/bin/bash
printf '%s\n' "$*" >> "$CURL_ARGS_FILE"
out=""; prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  [ "$prev" = "-K" ] && [ "$a" = "-" ] && cat >/dev/null
  prev="$a"
done
[ -n "$out" ] && : > "$out"
printf '%s' "${FAKE_HTTP_CODE:-200}"
exit 0
FAKE
cat > "$TMP/bin/osascript" <<'FAKE'
#!/bin/bash
exit 0
FAKE
chmod +x "$TMP/bin/curl" "$TMP/bin/osascript"

PROJECTS_FILE="$TMP/projects.json"
cat > "$PROJECTS_FILE" <<JSON
[
  { "projectName": "flywheel",
    "projectRoot": "$TMP/repo",
    "leads": [
      { "agentId": "eng-lead",
        "chatChannel": "111111111111111111",
        "alertChannel": "444444444444444444",
        "alertBotTokenEnv": "LEAD_BOT_TOKEN",
        "match": { "labels": ["x"] } }
    ] }
]
JSON
CURL_LOG="$TMP/curl.log"
: > "$CURL_LOG"

alert_env() {
  env PATH="$TMP/bin:$PATH" HOME="$TMP/home" \
    CURL_ARGS_FILE="$CURL_LOG" \
    FLYWHEEL_PROJECTS_FILE="$PROJECTS_FILE" \
    FLYWHEEL_CLAIMS_DB="$TMP/claims.db" \
    FLYWHEEL_ALERT_QUEUE_DIR="$TMP/queue" \
    FLYWHEEL_ALERT_DEADLETTER_DIR="$TMP/dl" \
    LEAD_BOT_TOKEN="fly3083-token" \
    FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="" \
    FLYWHEEL_ALERT_SENDER_TOKEN_ENV="" \
    FLYWHEEL_ALERT_TICKETS="" \
    FLYWHEEL_ALERT_RATE_PER_MIN="" \
    "$@"
}

# fault <exec> <subkind> <anchor> [KEY=VAL ...] → prints the strict result line
fault() {
  local exec_id="$1" subkind="$2" anchor="$3"; shift 3
  alert_env "$@" bash "$LEAD_ALERT" \
    --lead eng-lead --project flywheel \
    --kind mailbox_channel_fault --severity severe --strict-delivery \
    --signature "mailbox:${exec_id}:${subkind}:${anchor}" \
    --title "Mailbox channel fault (${subkind}) runner runner-${exec_id:0:8} issue FLY-3083" \
    --body "subkind=${subkind}
anchor_instruction_id=${anchor}" 2>>"$TMP/stderr.log" | tail -n 1
}
posts() { grep -c "channels/444444444444444444/messages" "$CURL_LOG"; }

EXEC_A="aaaaaaaa-1111-4222-8333-444455556666"
EXEC_B="bbbbbbbb-1111-4222-8333-444455556666"

# ── 1: 2 Runners × 2 subkinds → 4 distinct, all sent
results=""
for e in "$EXEC_A" "$EXEC_B"; do
  for sk in transport_error suspected_stall; do
    results="$results $(fault "$e" "$sk" "anchor-1")"
  done
done
[ "$results" = " sent sent sent sent" ] && ok "2 Runners × 2 subkinds → 4 sends" || bad "expected 4× sent, got '$results'"
[ "$(posts)" = "4" ] && ok "4 POSTs (distinct event ids)" || bad "expected 4 POSTs, got $(posts)"
n_ids=$(sqlite3 "$TMP/claims.db" "SELECT COUNT(DISTINCT event_id) FROM alert_claims WHERE event_type='mailbox_channel_fault'")
[ "$n_ids" = "4" ] && ok "4 distinct claim rows" || bad "expected 4 claim rows, got $n_ids"

# ── 2: same episode again → duplicate, no POST
before=$(posts)
r=$(fault "$EXEC_A" transport_error "anchor-1")
[ "$r" = "duplicate" ] && ok "same episode retry → duplicate" || bad "same episode expected duplicate, got '$r'"
[ "$(posts)" = "$before" ] && ok "same episode retry → no POST" || bad "same episode retry POSTed"

# ── 3: new episode (new anchor) after recovery → sent again
r=$(fault "$EXEC_A" transport_error "anchor-2")
[ "$r" = "sent" ] && ok "episode B (new anchor) → sent" || bad "episode B expected sent, got '$r'"

# ── 4: 403 → dead_lettered; fix sender, retry → duplicate + no POST
EXEC_C="cccccccc-1111-4222-8333-444455556666"
r=$(fault "$EXEC_C" transport_error "anchor-9" FAKE_HTTP_CODE=403)
[ "$r" = "dead_lettered" ] && ok "first send 403 → dead_lettered" || bad "403 expected dead_lettered, got '$r'"
before=$(posts)
r=$(fault "$EXEC_C" transport_error "anchor-9" FAKE_HTTP_CODE=200)
[ "$r" = "duplicate" ] && ok "retry after fixing sender → duplicate" || bad "retry expected duplicate, got '$r'"
[ "$(posts)" = "$before" ] && ok "that duplicate did NOT POST — duplicate ≠ escalated" || bad "duplicate retry POSTed"

# ── 5: a pre-seeded claim with no delivery → duplicate, no POST
EXEC_D="dddddddd-1111-4222-8333-444455556666"
SIG="mailbox:${EXEC_D}:suspected_stall:anchor-5"
EID=$(LC_ALL=C printf '%s|%s|%s|%s' flywheel eng-lead mailbox_channel_fault "$SIG" | LC_ALL=C shasum -a 1 | awk '{print $1}')
sqlite3 "$TMP/claims.db" "INSERT INTO alert_claims VALUES ('$EID','eng-lead','mailbox_channel_fault',strftime('%s','now'))"
before=$(posts)
r=$(fault "$EXEC_D" suspected_stall "anchor-5")
[ "$r" = "duplicate" ] && [ "$(posts)" = "$before" ] \
  && ok "claim-only (never delivered) → duplicate with no POST" || bad "claim-only expected duplicate/no POST, got '$r'"

# ── 6: required flags + unknown kind
for missing in --lead --project --title; do
  args=(--lead eng-lead --project flywheel --kind mailbox_channel_fault --severity severe
        --strict-delivery --signature "mailbox:x:transport_error:y" --title T --body B)
  filtered=(); skip=0
  for a in "${args[@]}"; do
    if [ "$skip" = "1" ]; then skip=0; continue; fi
    if [ "$a" = "$missing" ]; then skip=1; continue; fi
    filtered+=("$a")
  done
  alert_env bash "$LEAD_ALERT" "${filtered[@]}" >/dev/null 2>&1; rc=$?
  [ "$rc" = "1" ] && ok "missing $missing → exit 1" || bad "missing $missing expected exit 1, got $rc"
done
r=$(alert_env bash "$LEAD_ALERT" --lead eng-lead --project flywheel --kind mailbox_fault_typo \
  --severity severe --strict-delivery --title T --body B 2>/dev/null | tail -n 1)
[ "$r" = "config_error" ] && ok "unknown kind → config_error" || bad "unknown kind expected config_error, got '$r'"

# ── 7: the contract template runs as written
TEMPLATE=$(awk '/^   ```bash$/{f=1;next} /^   ```$/{f=0} f' "$CONTRACT" | sed 's/^   //')
if [ -z "$TEMPLATE" ]; then
  bad "could not extract the bash template from runner-channel-contract.md"
else
  FILLED=$(printf '%s\n' "$TEMPLATE" | sed \
    -e 's/<execution_id>/eeeeeeee-1111-4222-8333-444455556666/g' \
    -e 's/<subkind>/transport_error/g' \
    -e 's/<anchor_instruction_id>/anchor-t/g' \
    -e 's/<runner 队名>/runner-eeeeeeee/g' \
    -e 's/<FLY-xxx>/FLY-3083/g' \
    -e 's/<episode 首条 id>/anchor-t/g' \
    -e 's/<本次 id>/anchor-t/g' \
    -e 's/<send 时间>/2026-09-30T00:00:00Z/g' \
    -e 's/<一行证据>/inbox unwritable/g')
  r=$(alert_env FLYWHEEL_LEAD_ALERT_SCRIPT="$LEAD_ALERT" FLYWHEEL_LEAD_ID=eng-lead \
    FLYWHEEL_PROJECT_NAME=flywheel bash -c "$FILLED" 2>/dev/null | tail -n 1)
  [ "$r" = "sent" ] && ok "contract template (filled) → sent" || bad "contract template expected sent, got '$r'"
  before=$(posts)
  out=$(alert_env FLYWHEEL_LEAD_ID=eng-lead FLYWHEEL_PROJECT_NAME=flywheel \
    bash -c "unset FLYWHEEL_LEAD_ALERT_SCRIPT; $FILLED" 2>&1); rc=$?
  if [ "$rc" != "0" ] && printf '%s' "$out" | grep -q "未注入" && [ "$(posts)" = "$before" ]; then
    ok "FLYWHEEL_LEAD_ALERT_SCRIPT unset → :? guard stops the template, nothing sent"
  else
    bad "unset script guard: rc=$rc out=$out"
  fi
fi

echo
echo "FLY-3083 mailbox_channel_fault: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
