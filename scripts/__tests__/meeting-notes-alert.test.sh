#!/bin/bash
# FLY-2033 alert kind acceptance + subject/class/day dedup contract.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEAD_ALERT="$REPO_ROOT/scripts/lead-alert.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/fly2033-alert.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

for tool in jq sqlite3 shasum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "SKIP: missing $tool"; exit 0; }
done

mkdir -p "$TMP_ROOT/bin"
cat > "$TMP_ROOT/bin/curl" <<'FAKE'
#!/bin/bash
printf 'call\n' >> "${CURL_CALLS:?}"
for arg in "$@"; do
  if [ "$arg" = "-" ]; then cat >/dev/null; break; fi
done
printf '200'
FAKE
chmod +x "$TMP_ROOT/bin/curl"
cat > "$TMP_ROOT/bin/osascript" <<'FAKE'
#!/bin/bash
exit 0
FAKE
chmod +x "$TMP_ROOT/bin/osascript"

cat > "$TMP_ROOT/projects.json" <<'JSON'
[
  {
    "projectName": "flywheel",
    "generalChannel": "999999999999999999",
    "leads": [
      {
        "agentId": "claude-infra-bot-lead",
        "alertChannel": "444444444444444444",
        "alertBotTokenEnv": "FLY2033_ALERT_TOKEN",
        "botTokenEnv": "FLY2033_ALERT_TOKEN"
      }
    ]
  }
]
JSON

run_alert() {
  local signature="$1"
  PATH="$TMP_ROOT/bin:$PATH" \
  CURL_CALLS="$TMP_ROOT/calls" \
  FLYWHEEL_PROJECTS_FILE="$TMP_ROOT/projects.json" \
  FLYWHEEL_CLAIMS_DB="$TMP_ROOT/claims.db" \
  FLYWHEEL_ALERT_QUEUE_DIR="$TMP_ROOT/queue" \
  FLYWHEEL_ALERT_DEADLETTER_DIR="$TMP_ROOT/deadletter" \
  FLYWHEEL_STATE_DIR="$TMP_ROOT/state" \
  FLY2033_ALERT_TOKEN="canary" \
  bash "$LEAD_ALERT" --lead claude-infra-bot-lead --project flywheel \
    --kind meeting_notes_failed --severity warning \
    --title "会议留痕管线故障" \
    --body "subject=test failureClass=schema detail=safe" \
    --signature "$signature" --strict-delivery 2>/dev/null
}

first=$(run_alert "11111111-1111-4111-8111-111111111111:schema:20260829"); rc1=$?
second=$(run_alert "11111111-1111-4111-8111-111111111111:schema:20260829"); rc2=$?
calls=$(wc -l < "$TMP_ROOT/calls" | tr -d ' ')
if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$first" = sent ] \
  && [ "$second" = sent ] && [ "$calls" -eq 1 ]; then
  ok "same subject/class/founder-day dedups with a durable sent receipt"
else
  bad "same-day dedup failed rc=$rc1/$rc2 out=$first/$second calls=$calls"
fi

run_alert "11111111-1111-4111-8111-111111111111:schema:20260830" >/dev/null
run_alert "11111111-1111-4111-8111-111111111111:identity:20260829" >/dev/null
calls=$(wc -l < "$TMP_ROOT/calls" | tr -d ' ')
if [ "$calls" -eq 3 ]; then
  ok "next founder day and a different failure class each emit independently"
else
  bad "day/class separation failed calls=$calls"
fi

run_alert "preflight:config:20260829" >/dev/null
run_alert "linear-index:linear:20260829" >/dev/null
run_alert "preflight:config:20260829" >/dev/null
calls=$(wc -l < "$TMP_ROOT/calls" | tr -d ' ')
if [ "$calls" -eq 5 ]; then
  ok "global preflight and linear-index subjects dedup independently"
else
  bad "global subject dedup failed calls=$calls"
fi

echo "FLY-2033 meeting notes alert: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
