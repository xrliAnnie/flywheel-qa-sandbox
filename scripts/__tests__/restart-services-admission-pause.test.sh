#!/usr/bin/env bash
# FLY-1638: restart-services admission-pause contract.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

test_file_mode() {
	local path="$1" mode=""
	if stat -c %a "$path" >/dev/null 2>&1; then
		mode="$(stat -c %a "$path" 2>/dev/null || true)"
		[[ "$mode" =~ ^[0-7]{3,4}$ ]] && { printf '%s\n' "$mode"; return 0; }
	fi
	if stat -f %Lp "$path" >/dev/null 2>&1; then
		mode="$(stat -f %Lp "$path" 2>/dev/null || true)"
		[[ "$mode" =~ ^[0-7]{3,4}$ ]] && { printf '%s\n' "$mode"; return 0; }
	fi
	return 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RS="${SCRIPT_DIR}/../restart-services.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1638-admission.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "${ROOT}/bin"

export RESTART_TEST_SYSTEM_STAT="$(command -v stat)"
if [[ -z "${QA_STAT_LOG:-}" ]]; then
cat > "${ROOT}/bin/stat" <<'FAKE'
#!/usr/bin/env bash
set -u
real_stat_value() {
	local kind="$1" path="$2" value=""
	if [[ "$kind" == "mode" ]]; then
		value=$("${RESTART_TEST_SYSTEM_STAT:?}" -c %a "$path" 2>/dev/null || true)
		[[ "$value" =~ ^[0-7]{3,4}$ ]] \
			|| value=$("$RESTART_TEST_SYSTEM_STAT" -f %Lp "$path" 2>/dev/null || true)
	else
		value=$("${RESTART_TEST_SYSTEM_STAT:?}" -c %u "$path" 2>/dev/null || true)
		[[ "$value" =~ ^[0-9]+$ ]] \
			|| value=$("$RESTART_TEST_SYSTEM_STAT" -f %u "$path" 2>/dev/null || true)
	fi
	[[ "$value" =~ ^[0-9]+$ ]] || return 1
	printf '%s\n' "$value"
}
if [[ "${1:-}" == "-f" ]]; then
	printf '  File: %s\n  Type: mocked GNU filesystem query\n' "${3:-${2:-unknown}}"
	exit 1
fi
if [[ "${1:-}" == "-c" ]]; then
	case "${2:-}" in
		%a) real_stat_value mode "${3:?}"; exit $? ;;
		%u) real_stat_value owner "${3:?}"; exit $? ;;
	esac
fi
exec "${RESTART_TEST_SYSTEM_STAT:?}" "$@"
FAKE
chmod +x "${ROOT}/bin/stat"
fi
RESTART_TEST_RUNTIME_PATH="${ROOT}/bin:$PATH"

FUNCS="${ROOT}/funcs.sh"
awk '
	/^log\(\)/,/^}/ { print; next }
	/^bridge_admission_request\(\)/,/^}/ { print; next }
	/^restart_admission_file_mode\(\)/,/^}/ { print; next }
	/^cutover_legacy_pause_pending\(\)/,/^}/ { print; next }
	/^restart_admission_receipt_path\(\)/,/^}/ { print; next }
	/^write_restart_admission_receipt\(\)/,/^}/ { print; next }
	/^read_restart_admission_identifier\(\)/,/^}/ { print; next }
	/^clear_restart_admission_receipt\(\)/,/^}/ { print; next }
	/^record_admission_takeover_lapse\(\)/,/^}/ { print; next }
	/^write_cutover_admission_lease_handoff\(\)/,/^}/ { print; next }
	/^pause_admission_best_effort\(\)/,/^}/ { print; next }
	/^takeover_cutover_admission_pause_after_bridge_health\(\)/,/^}/ { print; next }
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
if [[ "$*" == *"/api/admission/resume"* && -n "${CURL_RESUME_RESPONSE:-}" ]]; then
	printf '%s\n' "$CURL_RESUME_RESPONSE"
elif [[ -n "${CURL_RESPONSE:-}" ]]; then
	printf '%s\n' "$CURL_RESPONSE"
else
	printf '%s\n' '{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800}}'
fi
exit "${CURL_RC:-0}"
FAKE
chmod +x "${ROOT}/bin/curl"

cat >> "$FUNCS" <<'HELPERS'
pause_then_resume() {
	pause_admission_best_effort
	resume_admission_best_effort
}
pause_twice_then_resume() {
	pause_admission_best_effort
	pause_admission_best_effort
	resume_admission_best_effort
}
legacy_pause_takeover_then_resume() {
	export CURL_RC=22
	pause_admission_best_effort
	export CURL_RC=0
	export CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800,"reacquiredAfterLapse":true,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}'
	takeover_cutover_admission_pause_after_bridge_health
	resume_admission_best_effort
}
plain_legacy_pause_takeover_then_resume() {
	export CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800}}'
	pause_admission_best_effort
	export CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}'
	takeover_cutover_admission_pause_after_bridge_health
	resume_admission_best_effort
}
plain_failed_pause_then_takeover() {
	export CURL_RC=22
	pause_admission_best_effort
	takeover_cutover_admission_pause_after_bridge_health
}
plain_legacy_takeover_conflict() {
	export CURL_RC=0
	export CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800}}'
	pause_admission_best_effort
	export CURL_RC=22
	takeover_cutover_admission_pause_after_bridge_health
}
plain_foreign_null_without_receipt() {
	ADMISSION_PAUSE_NEEDS_CUTOVER_TAKEOVER=true
	ADMISSION_PAUSE_RELEASE_ON_EXIT=true
	takeover_cutover_admission_pause_after_bridge_health
}
detect_cutover_receipt() {
	cutover_legacy_pause_pending \
		&& write_cutover_admission_lease_handoff \
			'123e4567-e89b-42d3-a456-426614174000'
}
HELPERS

run_fn() {
	local out="$1" err="$2"; shift 2
	env -i PATH="$RESTART_TEST_RUNTIME_PATH" \
		HOME="${ROOT}/home" \
		BRIDGE_URL="http://127.0.0.1:9876" \
		TEAMLEAD_API_TOKEN="super-secret" \
		ADMISSION_PAUSE_SECONDS=1800 RESTART_REASON=deploy \
		CURL_ARGV="${ROOT}/curl.argv" CURL_STDIN="${ROOT}/curl.stdin" \
		RESTART_TEST_SYSTEM_STAT="$RESTART_TEST_SYSTEM_STAT" \
		${QA_STAT_LOG:+QA_STAT_LOG="$QA_STAT_LOG"} \
		${CURL_RESPONSE:+CURL_RESPONSE="$CURL_RESPONSE"} \
		${CURL_RESUME_RESPONSE:+CURL_RESUME_RESPONSE="$CURL_RESUME_RESPONSE"} \
		${CURL_RC:+CURL_RC="$CURL_RC"} \
		${FLYWHEEL_HOST_CUTOVER_RECEIPT:+FLYWHEEL_HOST_CUTOVER_RECEIPT="$FLYWHEEL_HOST_CUTOVER_RECEIPT"} \
		bash -c "set -uo pipefail; source '$FUNCS'; \"\$@\"" _ "$@" >"$out" 2>"$err"
}

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}' \
	run_fn "${ROOT}/out1" "${ROOT}/err1" pause_then_resume; rc=$?
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
grep -q 'api/admission/resume' "${ROOT}/curl.argv" \
	&& pass "owned lease is resumed" || fail "owned resume API not called"
grep -q 'leaseId.*123e4567-e89b-42d3-a456-426614174000' "${ROOT}/curl.argv" \
	&& pass "resume sends the server-issued lease id" || fail "owner lease id missing from resume"

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RC=22 run_fn "${ROOT}/out2" "${ROOT}/err2" pause_then_resume; rc=$?
[[ $rc -eq 0 ]] && pass "pre-feature/failed pause proceeds" || fail "failed pause rc=$rc"
grep -q 'no owned admission lease acquired; preserving any existing brake' "${ROOT}/out2" \
	&& pass "bootstrap/foreign-owner failure is explicit" || fail "acquisition warning missing"
if grep -q 'api/admission/resume' "${ROOT}/curl.argv"; then
	fail "failed or foreign-owned acquisition triggered resume"
else
	pass "failed or foreign-owned acquisition cannot resume another owner"
fi
if [[ "$(grep -c 'api/admission/pause' "${ROOT}/curl.argv")" == "1" ]]; then
	pass "failed ordinary acquisition does not schedule a post-health takeover"
else
	fail "failed ordinary acquisition scheduled an ownership takeover"
fi
if [[ "$(grep -c 'no owned admission lease acquired; preserving any existing brake' "${ROOT}/out2")" == "1" ]]; then
	pass "foreign active leases produce one warning and do not abort the ordinary deploy"
else
	fail "foreign active lease warning was duplicated or missing"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800}}' \
	run_fn "${ROOT}/out3" "${ROOT}/err3" pause_then_resume; rc=$?
[[ $rc -eq 0 ]] && pass "legacy pause response is best-effort" || fail "legacy pause rc=$rc"
if grep -q 'api/admission/resume' "${ROOT}/curl.argv"; then
	fail "legacy unowned pause was resumed"
else
	pass "legacy unowned pause is preserved for post-deploy takeover"
fi
grep -q 'no owner lease id; preserving the admission brake' "${ROOT}/out3" \
	&& pass "legacy preservation is explicit" || fail "legacy preservation warning missing"
restart_receipt=""
for candidate in "${ROOT}/home/.flywheel/state"/restart-services-admission-pause-*.json; do
	[[ -f "$candidate" ]] || continue
	restart_receipt="$candidate"
	break
done
receipt_mode=""
if [[ -f "$restart_receipt" ]]; then
	receipt_mode=$(test_file_mode "$restart_receipt" || true)
fi
if [[ "$receipt_mode" == "600" ]] \
	&& jq -e '.pid > 0
		and (.createdAt | type == "string")
		and (.pauseIdentifier | startswith("restart-services:deploy:pid="))' \
		"$restart_receipt" >/dev/null; then
	pass "legacy NULL-owner pause writes a durable 0600 run-local receipt"
else
	fail "legacy NULL-owner pause receipt missing or unsafe (mode=${receipt_mode:-missing})"
fi
[[ -z "$restart_receipt" ]] || rm -f "$restart_receipt"

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
run_fn "${ROOT}/out3b" "${ROOT}/err3b" plain_legacy_pause_takeover_then_resume; rc=$?
if [[ $rc -eq 0 ]] \
	&& [[ "$(grep -c 'api/admission/pause' "${ROOT}/curl.argv")" == "2" ]] \
	&& grep -q 'expectedLegacyReason.*restart-services:deploy:pid=' "${ROOT}/curl.argv" \
	&& grep -q 'api/admission/resume' "${ROOT}/curl.argv"; then
	pass "plain version-crossing deploy adopts the legacy NULL owner after health and releases its new lease"
else
	fail "plain legacy pause was not taken over and released (rc=$rc)" \
		"$(cat "${ROOT}/out3b" 2>/dev/null)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
run_fn "${ROOT}/out3e" "${ROOT}/err3e" plain_foreign_null_without_receipt; rc=$?
if [[ $rc -eq 0 ]] \
	&& [[ ! -s "${ROOT}/curl.argv" ]] \
	&& grep -q 'no run-local receipt; preserving the foreign NULL-owner brake' "${ROOT}/out3e"; then
	pass "ordinary deploy cannot adopt or release a foreign NULL-owner brake"
else
	fail "ordinary deploy touched a foreign NULL-owner brake (rc=$rc)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
run_fn "${ROOT}/out3c" "${ROOT}/err3c" plain_failed_pause_then_takeover; rc=$?
if [[ $rc -eq 0 ]] \
	&& [[ "$(grep -c 'api/admission/pause' "${ROOT}/curl.argv")" == "1" ]]; then
	pass "ordinary failed acquisition cannot abort after the new Bridge becomes healthy"
else
	fail "ordinary failed acquisition retried takeover and aborted (rc=$rc)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
run_fn "${ROOT}/out3d" "${ROOT}/err3d" plain_legacy_takeover_conflict; rc=$?
if [[ $rc -eq 0 ]] \
	&& grep -q 'ordinary deploy could not take ownership' "${ROOT}/out3d"; then
	pass "ordinary NULL-owner takeover conflicts degrade to a warning"
else
	fail "ordinary NULL-owner takeover conflict aborted the deploy (rc=$rc)" \
		"$(cat "${ROOT}/out3d" 2>/dev/null)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}' \
	run_fn "${ROOT}/out4" "${ROOT}/err4" pause_twice_then_resume; rc=$?
renewal_uses=$(grep -o 'leaseId[^}]*123e4567-e89b-42d3-a456-426614174000' "${ROOT}/curl.argv" | wc -l | tr -d ' ')
if [[ $rc -eq 0 && "$renewal_uses" == "2" ]]; then
	pass "same owner id is reused for renewal and terminal resume"
else
	fail "same-owner renewal contract missing (uses=$renewal_uses rc=$rc)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800,"reacquiredAfterLapse":true,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}' \
	run_fn "${ROOT}/out4b" "${ROOT}/err4b" pause_admission_best_effort; rc=$?
if [[ $rc -eq 0 ]] \
	&& grep -q 'admission owner lease was reacquired after expiry; admission continuity was broken' "${ROOT}/out4b"; then
	pass "restart surfaces an admission lease continuity breach"
else
	fail "restart hid the admission lease continuity breach (rc=$rc)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
CURL_RESPONSE='{"ok":true,"admissionPause":{"active":true,"remainingSeconds":1800,"reacquiredAfterLapse":false,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}' \
CURL_RESUME_RESPONSE='{"ok":true,"admissionPause":{"active":false,"remainingSeconds":0,"wasActive":false,"leaseLapsed":true}}' \
	run_fn "${ROOT}/out4c" "${ROOT}/err4c" pause_then_resume; rc=$?
if [[ $rc -eq 0 ]] \
	&& grep -q 'admission brake had already expired before resume; admission continuity was broken' "${ROOT}/out4c"; then
	pass "restart logs an expired brake returned by owner-qualified resume"
else
	fail "restart hid an expired brake returned by resume (rc=$rc)"
fi

: > "${ROOT}/curl.argv"; : > "${ROOT}/curl.stdin"
mkdir -p "${ROOT}/home/.flywheel/state"
cat > "${ROOT}/home/.flywheel/state/host-terminal-cutover.json" <<'JSON'
{"status":"paused","pause":{"remainingSeconds":1800,"leaseId":null,"reason":"tmux 3.7c host cutover"}}
JSON
chmod 600 "${ROOT}/home/.flywheel/state/host-terminal-cutover.json"
run_fn "${ROOT}/out5" "${ROOT}/err5" legacy_pause_takeover_then_resume; rc=$?
handoff="${ROOT}/home/.flywheel/state/host-terminal-cutover.admission-lease-id"
handoff_mode=""
if [[ -f "$handoff" ]]; then
	handoff_mode=$(test_file_mode "$handoff" || true)
fi
if [[ $rc -eq 0 && -f "$handoff" \
	&& "$(tr -d '\n' < "$handoff")" == "123e4567-e89b-42d3-a456-426614174000" \
	&& "$handoff_mode" == "600" ]] \
	&& grep -q 'legacy pause was reacquired after expiry; admission continuity was broken' "${ROOT}/out5" \
	&& jq -e '.pause.reacquiredAfterLapse == true' \
		"${ROOT}/home/.flywheel/state/host-terminal-cutover.json" >/dev/null; then
	pass "lapsed legacy cutover is warned, receipted, and handed off as a 0600 capability"
else
	fail "legacy cutover lapse/handoff evidence missing or unsafe (rc=$rc mode=${handoff_mode:-missing})"
fi
if grep -q 'api/admission/resume' "${ROOT}/curl.argv"; then
	fail "restart resumed the cutover-owned adopted lease"
else
	pass "adopted cutover lease remains paused for the host transaction"
fi

custom_receipt="${ROOT}/home/custom-state/host-terminal-cutover.json"
rm -f "${ROOT}/home/.flywheel/state/host-terminal-cutover.json"
mkdir -p "$(dirname "$custom_receipt")"
printf '%s\n' '{"status":"paused","pause":{"remainingSeconds":1800,"leaseId":null,"reason":"tmux 3.7c host cutover"}}' \
	> "$custom_receipt"
chmod 600 "$custom_receipt"
if FLYWHEEL_HOST_CUTOVER_RECEIPT="$custom_receipt" \
	run_fn "${ROOT}/out6" "${ROOT}/err6" detect_cutover_receipt \
	&& [[ "$(tr -d '\n' < "$(dirname "$custom_receipt")/host-terminal-cutover.admission-lease-id")" \
		== "123e4567-e89b-42d3-a456-426614174000" ]]; then
	pass "restart inspects the overridden receipt and writes its handoff beside it"
else
	fail "restart receipt/handoff paths ignored FLYWHEEL_HOST_CUTOVER_RECEIPT"
fi

deploy_body="${ROOT}/deploy.body"
rollback_body="${ROOT}/rollback.body"
identity_failure_body="${ROOT}/identity-failure.body"
voice_deploy_body="${ROOT}/voice-deploy.body"
awk '/^deploy_and_verify\(\)/,/^}/' "$RS" > "$deploy_body"
awk '/^rollback_and_restart\(\)/,/^}/' "$RS" > "$rollback_body"
awk '
	/if ! dbi_accept_health_identity/ { capture=1 }
	capture && /rm -f .*deploy-build-identity/ { capture=0 }
	capture { print }
' "$RS" > "$identity_failure_body"
awk '/^ensure_voice_bridge_for_deploy\(\)/,/^}/' "$RS" > "$voice_deploy_body"
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
takeover_line=$(grep -n 'takeover_cutover_admission_pause_after_bridge_health' "$deploy_body" | cut -d: -f1)
lead_wave_line=$(grep -n 'do_restart_all_leads stagger' "$deploy_body" | cut -d: -f1)
resume_line=$(grep -n 'resume_admission_best_effort' "$deploy_body" | tail -1 | cut -d: -f1)
if [[ "$health_line" =~ ^[0-9]+$ && "$identity_line" =~ ^[0-9]+$ \
	&& "$takeover_line" =~ ^[0-9]+$ && "$lead_wave_line" =~ ^[0-9]+$ \
	&& "$resume_line" =~ ^[0-9]+$ ]] \
	&& (( health_line < identity_line && identity_line < takeover_line \
		&& takeover_line < lead_wave_line && lead_wave_line < resume_line )); then
	pass "legacy ownership takeover occurs after accepted Bridge health and before the full Lead wave"
else
	fail "legacy ownership takeover is not fenced between Bridge identity and the Lead wave"
fi
if grep -q 'resume_admission_best_effort' "$identity_failure_body" \
	&& grep -q 'resume_admission_best_effort' "$voice_deploy_body"; then
	pass "post-health identity and no-rollback voice failures release ordinary owned brakes"
else
	fail "a post-health deploy failure can retain an ordinary owned brake until TTL"
fi
grep -B12 'if ! stop_bridge' "$rollback_body" | grep -q 'pause_admission_best_effort' \
	&& pass "rollback also pauses before stopping Bridge" \
	|| fail "rollback pause ordering missing"
if grep -B16 'if ! stop_bridge' "$rollback_body" \
	| grep -q 'if ! pause_admission_best_effort; then' \
	&& grep -q 'rollback admission pause failed; continuing rollback' "$rollback_body"; then
	pass "rollback handles pause failure explicitly and continues recovery"
else
	fail "rollback pause failure can still interrupt recovery under set -e"
fi
rollback_wave_line=$(grep -n 'do_restart_all_leads immediate' "$rollback_body" | cut -d: -f1)
rollback_resume_line=$(grep -n 'resume_admission_best_effort' "$rollback_body" | tail -1 | cut -d: -f1)
if [[ "$rollback_wave_line" =~ ^[0-9]+$ && "$rollback_resume_line" =~ ^[0-9]+$ ]] \
	&& (( rollback_wave_line < rollback_resume_line )); then
	pass "rollback keeps the owned brake through its Lead recovery wave"
else
	fail "rollback admission resume precedes Lead recovery"
fi
grep -q 'ADMISSION_PAUSE_SECONDS="${FLYWHEEL_RESTART_ADMISSION_PAUSE_SECONDS:-1800}"' "$RS" \
	&& pass "default pause lease is 1800 seconds (> 15-minute health default)" \
	|| fail "1800-second default missing"
if ! grep -q 'FLYWHEEL_RESTART_ADMISSION_RECEIPT' "$RS" \
	&& grep -Fq 'register_restart_transient_file "$(restart_admission_receipt_path)"' "$RS"; then
	pass "restart receipt path is fixed and registered for terminal cleanup"
else
	fail "restart receipt still has an env bypass or is absent from transient cleanup"
fi

echo ""
echo "[TEST] restart-services-admission-pause: ${PASSED} passed, ${FAILED} failed"
[[ $FAILED -eq 0 ]]
