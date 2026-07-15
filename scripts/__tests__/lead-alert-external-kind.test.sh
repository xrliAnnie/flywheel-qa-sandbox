#!/bin/bash
# FLY-879: lead-alert.sh must accept the NEW `external_config_error` kind (added to
# the kind allowlist) and resolve the alert token via `alertBotTokenEnv` — the exact
# path the claude-lead.sh external fail-STOP takes (_external_failstop_alert). Uses a
# fake `curl` (returns HTTP 200, records argv) so the whole resolve→claim→POST flow
# runs hermetically with no network. Asserts:
#   1. external_config_error is ACCEPTED: exit 0, "sent" logged, and the resolved
#      token (from alertBotTokenEnv) appears in the Discord Authorization header.
#   2. control — an unknown kind is REJECTED (exit 1, "unknown --kind"), proving the
#      allowlist is genuinely enforced and external_config_error is specifically in it.
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

TMP=$(mktemp -d "/tmp/fly879-alert.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

# Fake curl on a prepended PATH — records argv, returns 200 (the `-w %{http_code}`
# value the caller captures). jq/sqlite3/shasum still resolve from the real PATH.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'FAKE'
#!/bin/bash
printf '%s\n' "$*" >> "$CURL_ARGS_FILE"
# FLY-927: lead-alert.sh now feeds the Authorization header via `-K -` (stdin
# curl config) so the token never rides argv — capture stdin for assertions.
for a in "$@"; do
  if [ "$a" = "-" ]; then cat >> "${CURL_ARGS_FILE}.stdin"; break; fi
done
printf '200'
exit 0
FAKE
chmod +x "$TMP/bin/curl"

CANARY_TOKEN="CANARY-ANNA-TOKEN-$$"
PROJECTS_FILE="$TMP/projects.json"
cat > "$PROJECTS_FILE" <<JSON
[
  {
    "projectName": "flywheel",
    "projectRoot": "$TMP/repo",
    "leads": [
      {
        "agentId": "anna-interviewer-lead",
        "chatChannel": "111111111111111111",
        "alertChannel": "444444444444444444",
        "alertBotTokenEnv": "ANNA_BOT_TOKEN",
        "external": true,
        "canSpawnRunners": false,
        "match": { "labels": ["external-interviews"] }
      }
    ]
  }
]
JSON

run_alert() { # $1 = kind
  env PATH="$TMP/bin:$PATH" HOME="$TMP" \
    CURL_ARGS_FILE="$TMP/curl-args" \
    FLYWHEEL_PROJECTS_FILE="$PROJECTS_FILE" \
    FLYWHEEL_CLAIMS_DB="$TMP/claims-$1.db" \
    FLYWHEEL_ALERT_QUEUE_DIR="$TMP/queue" \
    FLYWHEEL_ALERT_DEADLETTER_DIR="$TMP/deadletter" \
    ANNA_BOT_TOKEN="$CANARY_TOKEN" \
    bash "$LEAD_ALERT" \
      --lead anna-interviewer-lead --project flywheel \
      --kind "$1" --severity severe \
      --title "External Lead failed to start" \
      --body "external-agent-contract.md missing/unreadable; refusing to start"
}

# ── 1. external_config_error ACCEPTED + token resolved ──
rm -f "$TMP/curl-args"
run_alert external_config_error > "$TMP/ok.out" 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "external_config_error accepted (exit 0)" || { bad "external_config_error rejected (exit $rc)"; sed 's/^/      /' "$TMP/ok.out"; }
grep -qi "unknown --kind" "$TMP/ok.out" && bad "external_config_error hit the unknown-kind branch" || ok "external_config_error NOT flagged unknown"
grep -q "sent" "$TMP/ok.out" && ok "alert POST attempted (sent)" || bad "alert POST not reached"
# Token resolved via alertBotTokenEnv → present in the Authorization header.
# FLY-927: the header now rides the curl STDIN config (`-K -`), never argv —
# assert it in the recorded stdin AND that argv stays token-free.
if [ -f "$TMP/curl-args.stdin" ] && grep -qF "Authorization: Bot ${CANARY_TOKEN}" "$TMP/curl-args.stdin"; then
  ok "alert token resolved via alertBotTokenEnv (ANNA_BOT_TOKEN)"
else
  bad "alert token NOT resolved from alertBotTokenEnv"
fi
if [ -f "$TMP/curl-args" ] && grep -qF "$CANARY_TOKEN" "$TMP/curl-args"; then
  bad "token leaked into curl argv (must ride stdin config only)"
else
  ok "token never appears in curl argv (FLY-927 hygiene)"
fi

# ── 2. control: an unknown kind is REJECTED ──
rm -f "$TMP/curl-args"
run_alert bogus_kind_xyz > "$TMP/bad.out" 2>&1; rc=$?
[ "$rc" -eq 1 ] && ok "unknown kind rejected (exit 1)" || bad "unknown kind not rejected (exit $rc)"
grep -qi "unknown --kind" "$TMP/bad.out" && ok "unknown kind logs 'unknown --kind'" || bad "unknown kind missing diagnostic"

echo ""
echo "FLY-879 lead-alert external-kind test: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
