#!/usr/bin/env bash
# FLY-1081: restart-services.sh ⚠️/🚨 notify-path migration (FLY-915 pain #3).
#
# Hermetic: extracts the REAL log/fire_meta_alert/alert_warning/alert_severe/
# notify_routine definitions from restart-services.sh (no keep-in-sync copy)
# and runs them against fake lead-alert.sh / curl / meta-alert.sh. Asserts:
#   1. alert_warning → lead-alert.sh --kind deploy_degraded --severity warning
#      --lead deploy, minute-level slug signature; stdout stays EMPTY.
#   2. alert_severe  → --kind deploy_failed --severity severe and, when
#      FLYWHEEL_FOUNDER_USER_ID is set, --mention-user <id>.
#   3. founder env unset → NO --mention-user + stderr WARNING + still sends.
#   4. fake lead-alert.sh exits non-zero → helper rc=0 (never blocks deploy).
#   5. notify_routine env missing → ZERO curl + meta-alert
#      (notify_routine_unconfigured) + rc=0 — no Simba/core fallback.
#   6. notify_routine env set but curl FAILS → stderr ERROR + meta-alert
#      (routine_notify_failed) + rc=0.
#   7. Static: severe_alert()/notify_discord are GONE; the two former
#      severe_alert call sites are three-arg alert_severe (Codex R2#1).
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RS="${SCRIPT_DIR}/../restart-services.sh"
[[ -f "$RS" ]] || { echo "[TEST] ✗ restart-services.sh not found: $RS"; exit 1; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1081-notify.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

# ── Extract the real function definitions under test ─────────────────────────
FUNCS="${ROOT}/funcs.sh"
awk '
	/^log\(\)/,/^}/ { print; next }
	/^fire_meta_alert\(\)/,/^}/ { print; next }
	/^alert_warning\(\)/,/^}/ { print; next }
	/^alert_severe\(\)/,/^}/ { print; next }
	/^notify_routine\(\)/,/^}/ { print; next }
' "$RS" > "$FUNCS"
for fn in fire_meta_alert alert_warning alert_severe notify_routine; do
	grep -q "${fn}()" "$FUNCS" || { echo "[TEST] ✗ failed to extract ${fn} from restart-services.sh"; exit 1; }
done

# ── Fakes: lead-alert.sh (records argv, rc via env), curl, meta-alert.sh ────
FLYWHEEL_FAKE="${ROOT}/flywheel"
mkdir -p "${FLYWHEEL_FAKE}/scripts" "${ROOT}/bin"
cat > "${FLYWHEEL_FAKE}/scripts/lead-alert.sh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${LA_CALLS}"
exit "${LA_RC:-0}"
FAKE
cat > "${FLYWHEEL_FAKE}/scripts/meta-alert.sh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "${META_CALLS}"
exit 0
FAKE
cat > "${ROOT}/bin/curl" <<'FAKE'
#!/usr/bin/env bash
# Records "url | argv-auth" per call; captures a `-K -` stdin config to
# ${CURL_LOG}.stdin (FLY-1081: the token must ride stdin, never argv).
url=""; auth=""; prev=""
for a in "$@"; do
	case "$a" in https://*) url="$a" ;; esac
	if [[ "$prev" == "-H" && "$a" == Authorization:* ]]; then auth="$a"; fi
	if [[ "$prev" == "-K" && "$a" == "-" ]]; then cat >> "${CURL_LOG}.stdin"; fi
	prev="$a"
done
printf '%s | %s\n' "$url" "$auth" >> "$CURL_LOG"
exit "${CURL_RC:-0}"
FAKE
chmod +x "${FLYWHEEL_FAKE}/scripts/lead-alert.sh" "${FLYWHEEL_FAKE}/scripts/meta-alert.sh" "${ROOT}/bin/curl"

# run_fn <stdout-file> <stderr-file> [ENV=VAL ...] -- <fn> <args...>
run_fn() {
	local out="$1" err="$2"; shift 2
	local envs=()
	while [[ "$1" != "--" ]]; do envs+=("$1"); shift; done
	shift
	env -i PATH="${ROOT}/bin:/usr/bin:/bin" \
		FLYWHEEL_DIR="$FLYWHEEL_FAKE" \
		LA_CALLS="${ROOT}/la-calls" CURL_LOG="${ROOT}/curl-log" META_CALLS="${ROOT}/meta-calls" \
		${envs[@]+"${envs[@]}"} \
		bash -c "set -uo pipefail; source '$FUNCS'; \"\$@\"" _ "$@" >"$out" 2>"$err"
}

reset_logs() { : > "${ROOT}/la-calls"; : > "${ROOT}/curl-log"; : > "${ROOT}/curl-log.stdin"; : > "${ROOT}/meta-calls"; }

# ── 1. alert_warning routes to lead-alert.sh with the right shape ────────────
reset_logs
run_fn "${ROOT}/o1" "${ROOT}/e1" -- alert_warning "idle-timeout" "T title" "B body"; rc=$?
if grep -q -- "--project flywheel --lead deploy --kind deploy_degraded --severity warning" "${ROOT}/la-calls"; then
	pass "alert_warning → deploy_degraded/warning with --lead deploy"
else
	fail "alert_warning args wrong: $(cat "${ROOT}/la-calls")"
fi
grep -qE -- "--signature idle-timeout-[0-9]{12}" "${ROOT}/la-calls" \
	&& pass "alert_warning minute-level slug signature" || fail "alert_warning signature missing/wrong"
[[ $rc -eq 0 ]] && pass "alert_warning rc=0" || fail "alert_warning rc=$rc"
[[ ! -s "${ROOT}/o1" ]] && pass "alert_warning stdout EMPTY" || fail "alert_warning leaked stdout: $(cat "${ROOT}/o1")"

# ── 2. alert_severe with founder id → deploy_failed/severe + --mention-user ──
reset_logs
run_fn "${ROOT}/o2" "${ROOT}/e2" FLYWHEEL_FOUNDER_USER_ID="999888777666555444" -- \
	alert_severe "deploy-port-stuck" "T" "B"; rc=$?
grep -q -- "--kind deploy_failed --severity severe" "${ROOT}/la-calls" \
	&& pass "alert_severe → deploy_failed/severe" || fail "alert_severe args wrong: $(cat "${ROOT}/la-calls")"
grep -q -- "--mention-user 999888777666555444" "${ROOT}/la-calls" \
	&& pass "alert_severe carries --mention-user with founder env set" || fail "--mention-user missing"
[[ $rc -eq 0 && ! -s "${ROOT}/o2" ]] && pass "alert_severe rc=0 + stdout EMPTY" || fail "alert_severe rc=$rc stdout=$(cat "${ROOT}/o2")"

# ── 3. founder env UNSET → no --mention-user, stderr WARNING, still sends ────
reset_logs
run_fn "${ROOT}/o3" "${ROOT}/e3" -- alert_severe "deploy-port-stuck" "T" "B"; rc=$?
if grep -q -- "--kind deploy_failed" "${ROOT}/la-calls" && ! grep -q -- "--mention-user" "${ROOT}/la-calls"; then
	pass "founder env unset → alert still sent WITHOUT --mention-user"
else
	fail "founder-unset behavior wrong: $(cat "${ROOT}/la-calls")"
fi
grep -qi "WARNING.*FLYWHEEL_FOUNDER_USER_ID" "${ROOT}/e3" \
	&& pass "founder env unset → stderr WARNING trace" || fail "no WARNING on stderr: $(cat "${ROOT}/e3")"
[[ $rc -eq 0 && ! -s "${ROOT}/o3" ]] && pass "founder-unset rc=0 + stdout EMPTY" || fail "rc=$rc stdout=$(cat "${ROOT}/o3")"

# ── 4. lead-alert.sh non-zero exit → helper rc=0 (deploy never blocked) ──────
reset_logs
run_fn "${ROOT}/o4" "${ROOT}/e4" LA_RC=2 -- alert_severe "rollback-port-stuck" "T" "B"; rc=$?
[[ $rc -eq 0 ]] && pass "lead-alert failure → alert_severe rc=0" || fail "alert_severe rc=$rc on lead-alert failure"
reset_logs
run_fn "${ROOT}/o4b" "${ROOT}/e4b" LA_RC=2 -- alert_warning "idle-timeout" "T" "B"; rc=$?
[[ $rc -eq 0 ]] && pass "lead-alert failure → alert_warning rc=0" || fail "alert_warning rc=$rc on lead-alert failure"

# ── 5. notify_routine env missing → ZERO curl + meta-alert + rc=0 ────────────
reset_logs
run_fn "${ROOT}/o5" "${ROOT}/e5" -- notify_routine "✅ 测试消息"; rc=$?
[[ ! -s "${ROOT}/curl-log" ]] && pass "routine unconfigured → ZERO curl (no Simba/core fallback)" \
	|| fail "routine unconfigured still curled: $(cat "${ROOT}/curl-log")"
grep -q "notify_routine_unconfigured" "${ROOT}/meta-calls" \
	&& pass "routine unconfigured → meta-alert(notify_routine_unconfigured)" || fail "meta-alert missing: $(cat "${ROOT}/meta-calls")"
grep -qi "ERROR.*NOT falling back" "${ROOT}/e5" \
	&& pass "routine unconfigured → stderr ERROR (refusal trace)" || fail "no refusal ERROR: $(cat "${ROOT}/e5")"
[[ $rc -eq 0 ]] && pass "routine unconfigured rc=0" || fail "routine unconfigured rc=$rc"

# ── 6. notify_routine configured but curl FAILS → stderr ERROR + meta-alert ──
reset_logs
run_fn "${ROOT}/o6" "${ROOT}/e6" CLAUDE_INFRA_BOT_TOKEN="infra-token" FLYWHEEL_NOTIFY_CHANNEL="notify-chan" CURL_RC=22 -- \
	notify_routine "✅ 测试消息"; rc=$?
grep -q "channels/notify-chan/messages" "${ROOT}/curl-log" \
	&& pass "routine main path targeted #flywheel-notify" || fail "routine curl wrong: $(cat "${ROOT}/curl-log")"
grep -qF "Authorization: Bot infra-token" "${ROOT}/curl-log.stdin" \
	&& pass "routine auth = infra token via curl stdin config" || fail "stdin config auth wrong: $(cat "${ROOT}/curl-log.stdin")"
grep -qF "infra-token" "${ROOT}/curl-log" \
	&& fail "infra token leaked into curl argv" || pass "infra token never in curl argv (Codex R1 MEDIUM)"
grep -q "routine_notify_failed" "${ROOT}/meta-calls" \
	&& pass "routine POST failure → meta-alert(routine_notify_failed)" || fail "meta-alert missing on curl failure"
grep -qi "ERROR" "${ROOT}/e6" && pass "routine POST failure → stderr ERROR" || fail "no ERROR on stderr"
[[ $rc -eq 0 ]] && pass "routine POST failure rc=0" || fail "routine POST failure rc=$rc"

# ── 6b. notify_routine happy path: exactly one curl, no meta-alert ───────────
reset_logs
run_fn "${ROOT}/o7" "${ROOT}/e7" CLAUDE_INFRA_BOT_TOKEN="infra-token" FLYWHEEL_NOTIFY_CHANNEL="notify-chan" -- \
	notify_routine "✅ 测试消息"; rc=$?
[[ "$(grep -c . "${ROOT}/curl-log")" == "1" && ! -s "${ROOT}/meta-calls" && $rc -eq 0 ]] \
	&& pass "routine happy path: 1 POST, no meta-alert, rc=0" || fail "routine happy path broken"

# ── 7. Static contract against the real script ───────────────────────────────
grep -q "notify_discord" "$RS" \
	&& fail "notify_discord still referenced in restart-services.sh" \
	|| pass "notify_discord fully removed"
grep -q "severe_alert()" "$RS" \
	&& fail "severe_alert() wrapper still defined (Codex R2#1: must be deleted)" \
	|| pass "severe_alert() wrapper deleted"
grep -q 'alert_severe "rollback-port-stuck" ' "$RS" \
	&& pass "former severe_alert site :1132 → three-arg alert_severe (rollback-port-stuck)" \
	|| fail "rollback-port-stuck site not migrated to three-arg alert_severe"
grep -q 'alert_severe "rollback-leads-failed" ' "$RS" \
	&& pass "former severe_alert site :1149 → three-arg alert_severe (rollback-leads-failed)" \
	|| fail "rollback-leads-failed site not migrated to three-arg alert_severe"
grep -q 'alert_severe "port-fail-loud-${reason}"' "$RS" \
	&& pass "bp_fail_loud Discord leg → alert_severe (port-fail-loud-<reason>)" \
	|| fail "bp_fail_loud Discord leg not migrated"

echo ""
echo "[TEST] restart-services-notify: ${PASSED} passed, ${FAILED} failed"
[[ $FAILED -eq 0 ]]
