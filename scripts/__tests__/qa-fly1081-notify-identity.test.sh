#!/usr/bin/env bash
# FLY-1081 independent QA — exercise the REAL lead-alert.sh via the exact
# production call form restart-services.sh/update-flywheel.sh use
# (--lead deploy|updater, --kind deploy_failed|deploy_degraded), proving:
#   A. seam resolvable → POST fires with the INFRA token (not Simba); founder
#      ping present in content + allowed_mentions.users.
#   B. seam set-but-unresolvable → ZERO curl POST + refusal on stderr (no
#      Simba/legacy fallback). This is the whole point of the issue.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"
LEAD_ALERT="$REPO/lead-alert.sh"
for tool in jq sqlite3 shasum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "SKIP: required tool '$tool' not in PATH" >&2; exit 0; }
done
[ -x "$LEAD_ALERT" ] || { echo "FAIL: $LEAD_ALERT missing/not executable" >&2; exit 1; }
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok   - $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

TMP=$(mktemp -d /tmp/qa1081.XXXXXX); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
# Fake curl: records argv + `-K -` stdin; emits 200.
cat > "$TMP/bin/curl" <<'FAKE'
#!/bin/bash
printf '%s\n' "$*" >> "$CURL_ARGS_FILE"
prev=""; out=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  [ "$prev" = "-K" ] && [ "$a" = "-" ] && cat >> "${CURL_ARGS_FILE}.stdin"
  prev="$a"
done
[ -n "$out" ] && : > "$out"
printf '200'; exit 0
FAKE
cat > "$TMP/bin/osascript" <<'FAKE'
#!/bin/bash
exit 0
FAKE
chmod +x "$TMP/bin/curl" "$TMP/bin/osascript"

INFRA="INFRA-DISPATCH-TOK-$$"
SIMBA="SIMBA-LEGACY-TOK-$$"       # must NEVER appear in any POST
FOUNDER="123456789012345678"

run() { # <suffix> <KEY=VAL env...> <-- flags...>  (split on '=' like the shipped test)
  local suffix="$1"; shift
  local envs=() flags=() a
  for a in "$@"; do
    case "$a" in *=*) envs+=("$a");; *) flags+=("$a");; esac
  done
  env PATH="$TMP/bin:$PATH" HOME="$TMP/home-$suffix" \
    CURL_ARGS_FILE="$TMP/curl-$suffix" \
    FLYWHEEL_PROJECTS_FILE="$TMP/projects.json" \
    FLYWHEEL_CLAIMS_DB="$TMP/claims-$suffix.db" \
    FLYWHEEL_ALERT_QUEUE_DIR="$TMP/q-$suffix" \
    FLYWHEEL_ALERT_DEADLETTER_DIR="$TMP/dl-$suffix" \
    FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="555000111222333444" \
    DISCORD_BOT_TOKEN="$SIMBA" \
    ${envs[@]+"${envs[@]}"} \
    bash "$LEAD_ALERT" --project flywheel --lead deploy \
      --title "Flywheel deploy failed" --body "port stuck" \
      --strict-delivery ${flags[@]+"${flags[@]}"} 2>"$TMP/err-$suffix" | tail -n1
}
echo "[]" > "$TMP/projects.json"   # deploy/updater are system-level, no registry entry

echo "== Case A: seam resolvable → infra identity + founder ping =="
RES=$(mkdir -p "$TMP/home-A"; run A \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN" \
  FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN="$INFRA" \
  --kind deploy_failed --severity severe --signature "port-stuck-A" \
  --mention-user "$FOUNDER")
[ "$RES" = "sent" ] && ok "deploy_failed accepted + sent (result=sent)" || bad "expected sent, got '$RES' (err: $(cat "$TMP/err-A"))"
grep -q "channels/555000111222333444/messages" "$TMP/curl-A" && ok "POST → unified alert channel" || bad "not posted to unified channel"
grep -qF "Authorization: Bot ${INFRA}" "$TMP/curl-A.stdin" && ok "INFRA token used (stdin config)" || bad "infra token not in stdin config"
grep -qF "$SIMBA" "$TMP/curl-A" "$TMP/curl-A.stdin" && bad "SIMBA token leaked into POST!" || ok "SIMBA token NEVER appears (argv+stdin)"
grep -qF "<@${FOUNDER}>" "$TMP/curl-A" && ok "founder <@id> prefixed in content" || bad "founder ping missing from content"
grep -q "\"users\"" "$TMP/curl-A" && grep -qF "$FOUNDER" "$TMP/curl-A" && ok "allowed_mentions.users carries founder id" || bad "allowed_mentions.users missing founder"

echo "== Case B: seam set-but-UNRESOLVABLE → refuse, ZERO POST, no Simba fallback =="
# Point the seam at a var name that is GENUINELY unset (avoid inheriting the
# runner's real FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN via env-inheritance).
RES=$(mkdir -p "$TMP/home-B"; run B \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="FLY1081_UNRESOLVABLE_SEAM_ENV" \
  --kind deploy_failed --severity severe --signature "port-stuck-B")
[ "$RES" != "sent" ] && ok "NOT sent (result=$RES)" || bad "expected non-sent, got sent — fell back!"
if [ -s "$TMP/curl-B" ]; then bad "a POST fired despite unresolvable seam (Simba fallback!)"; else ok "ZERO curl POST (no fallback)"; fi
grep -q "refusing per-lead fallback" "$TMP/err-B" && ok "stderr states 'refusing per-lead fallback'" || bad "no refusal trace on stderr"
grep -qF "$SIMBA" "$TMP/curl-B" 2>/dev/null && bad "SIMBA token leaked!" || ok "SIMBA token absent"

echo "== Case C: deploy_degraded (warning) via --lead deploy accepted =="
RES=$(mkdir -p "$TMP/home-C"; run C \
  FLYWHEEL_ALERT_SENDER_TOKEN_ENV="FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN" \
  FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN="$INFRA" \
  --kind deploy_degraded --severity warning --signature "degraded-C")
[ "$RES" = "sent" ] && ok "deploy_degraded accepted by kind allowlist + sent" || bad "deploy_degraded rejected: '$RES' (err: $(cat "$TMP/err-C"))"

echo
echo "FLY-1081 independent QA: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
