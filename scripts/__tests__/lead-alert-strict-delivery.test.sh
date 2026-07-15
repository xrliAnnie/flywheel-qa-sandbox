#!/bin/bash
# FLY-913: lead-alert.sh --strict-delivery machine-readable result channel.
#
# The restart-guard hook's bypass contract needs to distinguish "transiently
# failed but queued (WILL drain)" from "permanently undeliverable" — exit 2
# alone conflates them (Codex R1 #1). Asserts, hermetically (fake curl +
# isolated FLYWHEEL_* dirs + shimmed osascript, no network / no real
# ~/.flywheel):
#   1. All five strict results, one scenario each:
#        sent · duplicate · queued_transient · dead_lettered · config_error
#      (config_error covers BOTH pure config exits AND no-token — plan §4)
#   2. duplicate is emitted on a second call with the SAME signature (and the
#      claim-precedes-delivery caveat means strict callers must deny on it).
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

# ── 1. sent ──────────────────────────────────────────────────────────────────
OUT=$(run_alert 200 --lead flywheel-eng-lead --signature sig-sent --strict-delivery 2>/dev/null); RC=$?
if [ "$RC" = "0" ] && [ "$OUT" = "sent" ]; then ok "strict: HTTP 200 → sent (exit 0)"; else bad "sent: rc=$RC out='$OUT'"; fi

# ── 2. duplicate (same signature again; claim row already present) ───────────
OUT=$(run_alert 200 --lead flywheel-eng-lead --signature sig-sent --strict-delivery 2>/dev/null); RC=$?
if [ "$RC" = "0" ] && [ "$OUT" = "duplicate" ]; then ok "strict: re-claimed signature → duplicate (exit 0)"; else bad "duplicate: rc=$RC out='$OUT'"; fi

# ── 3. queued_transient (HTTP 500 → spill to queue) ──────────────────────────
OUT=$(run_alert 500 --lead flywheel-eng-lead --signature sig-q --strict-delivery 2>/dev/null); RC=$?
NQUEUE=$(ls "$TMP/queue" 2>/dev/null | wc -l | tr -d ' ')
if [ "$RC" = "2" ] && [ "$OUT" = "queued_transient" ] && [ "$NQUEUE" = "1" ]; then
  ok "strict: HTTP 500 → queued_transient (exit 2, queue file written)"
else bad "queued_transient: rc=$RC out='$OUT' nqueue=$NQUEUE"; fi

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
