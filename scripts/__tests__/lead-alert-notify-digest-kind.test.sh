#!/bin/bash
# FLY-929: lead-alert.sh must accept the NEW `notify_digest_failed` kind (the
# token-report fail-loud + Bridge expect-tick alert). Mirrors
# lead-alert-external-kind.test.sh: fake curl (200, records argv) so the whole
# resolve→claim→POST flow runs hermetically. Asserts:
#   1. notify_digest_failed is ACCEPTED: exit 0, "sent" logged.
#   2. control — an unknown kind is REJECTED (exit 1, "unknown --kind"),
#      proving the allowlist is genuinely enforced.
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

TMP=$(mktemp -d "/tmp/fly929-alert.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'FAKE'
#!/bin/bash
printf '%s\n' "$*" >> "$CURL_ARGS_FILE"
printf '200'
exit 0
FAKE
chmod +x "$TMP/bin/curl"

TOKEN="INFRA-TOKEN-$$"
PROJECTS_FILE="$TMP/projects.json"
cat > "$PROJECTS_FILE" <<JSON
[
  {
    "projectName": "flywheel",
    "projectRoot": "$TMP/repo",
    "leads": [
      {
        "agentId": "codex-infra-bot-lead",
        "chatChannel": "111111111111111111",
        "alertChannel": "444444444444444444",
        "alertBotTokenEnv": "CODEX_INFRA_BOT_TOKEN",
        "match": { "labels": ["infra"] }
      }
    ]
  }
]
JSON

run_alert() {
  local kind="$1"
  CURL_ARGS_FILE="$TMP/curl-args.txt" \
  CODEX_INFRA_BOT_TOKEN="$TOKEN" \
  FLYWHEEL_PROJECTS_FILE="$PROJECTS_FILE" \
  FLYWHEEL_CLAIMS_DB="$TMP/claims.db" \
  FLYWHEEL_ALERT_QUEUE_DIR="$TMP/queue" \
  FLYWHEEL_DEADLETTER_DIR="$TMP/deadletter" \
  PATH="$TMP/bin:$PATH" \
  bash "$LEAD_ALERT" \
    --lead codex-infra-bot-lead --project flywheel \
    --kind "$kind" --severity warning \
    --title "token report 发送失败" --body "step=publish exit=4" \
    > "$TMP/out.log" 2>&1
}

# 1. notify_digest_failed accepted → exit 0, POST fired with the resolved token
: > "$TMP/curl-args.txt"
if run_alert notify_digest_failed; then
  ok "notify_digest_failed accepted (exit 0)"
else
  bad "notify_digest_failed rejected: $(cat "$TMP/out.log")"
fi
if grep -q "Bot ${TOKEN}" "$TMP/curl-args.txt" 2>/dev/null; then
  ok "POST used the resolved alertBotTokenEnv token"
else
  bad "no Discord POST with the infra token: $(cat "$TMP/curl-args.txt" 2>/dev/null)"
fi

# 2. control: unknown kind rejected
if run_alert totally_bogus_kind; then
  bad "unknown kind was ACCEPTED (allowlist broken)"
else
  if grep -q "unknown --kind" "$TMP/out.log"; then
    ok "unknown kind rejected with 'unknown --kind' (allowlist enforced)"
  else
    bad "unknown kind rejected but without the allowlist error: $(cat "$TMP/out.log")"
  fi
fi

echo "lead-alert-notify-digest-kind: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ] || exit 1
