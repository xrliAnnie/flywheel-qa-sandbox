#!/usr/bin/env bash
# FLY-1638: restart-services admission-pause contract.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RS="${SCRIPT_DIR}/../restart-services.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1638-admission.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "${ROOT}/bin"

FUNCS="${ROOT}/funcs.sh"
awk '
	/^log\(\)/,/^}/ { print; next }
	/^bridge_admission_request\(\)/,/^}/ { print; next }
	/^pause_admission_best_effort\(\)/,/^}/ { print; next }
	/^resume_admission_best_effort\(\)/,/^}/ { print; next }
' "$RS" > "$FUNCS"

cat > "${ROOT}/bin/curl" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_ARGV"
prev=""
for arg in "$@"; do
	if [[ "$prev" == "-K" && "$arg" == "-" ]]; then cat >> "$CURL_STDIN"; fi
	prev="$arg"
done
exit "${CURL_RC:-0}"
FAKE
chmod +x "${ROOT}/bin/curl"

run_fn() {
	local out="$1" err="$2"; shift 2
	env -i PATH="${ROOT}/bin:/usr/bin:/bin" \
		BRIDGE_URL="http://127.0.0.1:9876" \
		TEAMLEAD_API_TOKEN="super-secret" \
		ADMISSION_PAUSE_SECONDS=1800 RESTART_REASON=deploy \
		CURL_ARGV="${ROOT}/curl.argv" CURL_STDIN="${ROOT}/curl.stdin" \
		${CURL_RC:+CURL_RC="$CURL_RC"} \
		bash -c "set -uo pipefail; source '$FUNCS'; \"\$@\"" _ "$@" >"$out" 2>"$err"
}

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
run_fn "${ROOT}/out1" "${ROOT}/err1" pause_admission_best_effort; rc=$?
[[ $rc -eq 0 ]] && pass "pause request is best-effort" || fail "pause rc=$rc"
grep -q 'api/admission/pause' "${ROOT}/curl.argv" \
	&& pass "pause targets the dedicated control API" || fail "pause API not called"
grep -q 'durationSeconds.*1800' "${ROOT}/curl.argv" \
	&& pass "pause sends the 1800-second lease" || fail "pause lease missing"
grep -q 'Authorization: Bearer super-secret' "${ROOT}/curl.stdin" \
	&& pass "master token rides curl stdin config" || fail "stdin auth missing"
if grep -q 'super-secret' "${ROOT}/curl.argv"; then
	fail "master token leaked into curl argv"
else
	pass "master token absent from curl argv"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RC=22 run_fn "${ROOT}/out2" "${ROOT}/err2" pause_admission_best_effort; rc=$?
[[ $rc -eq 0 ]] && pass "pre-feature/failed pause proceeds" || fail "failed pause rc=$rc"
grep -q 'pause unavailable (pre-feature Bridge or control API failure), proceeding without brake' "${ROOT}/out2" \
	&& pass "bootstrap failure is explicit" || fail "bootstrap warning missing"

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
run_fn "${ROOT}/out3" "${ROOT}/err3" resume_admission_best_effort; rc=$?
[[ $rc -eq 0 ]] && pass "resume request is best-effort" || fail "resume rc=$rc"
grep -q 'api/admission/resume' "${ROOT}/curl.argv" \
	&& pass "resume targets the dedicated control API" || fail "resume API not called"

deploy_body="${ROOT}/deploy.body"
rollback_body="${ROOT}/rollback.body"
awk '/^deploy_and_verify\(\)/,/^}/' "$RS" > "$deploy_body"
awk '/^rollback_and_restart\(\)/,/^}/' "$RS" > "$rollback_body"
notify_line=$(grep -n 'notify_routine "🔄 开始全量重启' "$deploy_body" | cut -d: -f1)
pause_line=$(grep -n 'pause_admission_best_effort' "$deploy_body" | head -1 | cut -d: -f1)
stop_line=$(grep -n 'if ! stop_bridge' "$deploy_body" | head -1 | cut -d: -f1)
if [[ "$notify_line" =~ ^[0-9]+$ && "$pause_line" =~ ^[0-9]+$ && "$stop_line" =~ ^[0-9]+$ ]] \
	&& (( notify_line < pause_line && pause_line < stop_line )); then
	pass "deploy Step 0 pauses after notice and before stop"
else
	fail "deploy Step 0 ordering is wrong"
fi
health_line=$(grep -n 'Bridge health check: OK' "$deploy_body" | cut -d: -f1)
identity_line=$(grep -n 'dbi_accept_health_identity' "$deploy_body" | cut -d: -f1)
resume_line=$(grep -n 'resume_admission_best_effort' "$deploy_body" | awk -F: -v health="$health_line" '$1 > health { print $1; exit }')
if [[ "$health_line" =~ ^[0-9]+$ && "$resume_line" =~ ^[0-9]+$ && "$identity_line" =~ ^[0-9]+$ ]] \
	&& (( health_line < resume_line && resume_line < identity_line )); then
	pass "healthy replacement resumes admission before identity rejection can return"
else
	fail "post-health admission resume ordering is wrong"
fi
grep -B12 'if ! stop_bridge' "$rollback_body" | grep -q 'pause_admission_best_effort' \
	&& pass "rollback also pauses before stopping Bridge" \
	|| fail "rollback pause ordering missing"
grep -q 'ADMISSION_PAUSE_SECONDS="${FLYWHEEL_RESTART_ADMISSION_PAUSE_SECONDS:-1800}"' "$RS" \
	&& pass "default pause lease is 1800 seconds (> 15-minute health default)" \
	|| fail "1800-second default missing"

echo ""
echo "[TEST] restart-services-admission-pause: ${PASSED} passed, ${FAILED} failed"
[[ $FAILED -eq 0 ]]
