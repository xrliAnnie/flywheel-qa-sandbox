#!/usr/bin/env bash
# FLY-929 W3b ② → FLY-1081: restart-services.sh routine-notice contract.
#
# Hermetic: extracts the REAL log/fire_meta_alert/notify_routine function
# definitions from restart-services.sh (no keep-in-sync copy) and runs them
# against a fake curl that records the channel + Authorization header.
# Asserts (FLY-1081 flipped the FLY-929 fallback contract — the silent
# fall-through to Simba/notify_discord WAS the bug, FLY-915 pain #3):
#   1. P-identity (both envs) → notify_routine posts to FLYWHEEL_NOTIFY_CHANNEL
#      with the Claude Infra Bot token — unchanged.
#   2. Either env missing → ZERO curl + meta-alert(notify_routine_unconfigured)
#      + rc=0 (fail-loud, deploy never blocked, NO legacy fallback sender).
#   3. Call-site classification: the 5 routine sites (⏳ idle wait / 🔄 update
#      start / ✅ updated / 🔄 lead restart / ✅ lead restart done) call
#      notify_routine; every former ⚠️/🚨 site rides alert_warning/alert_severe;
#      notify_discord and the severe_alert() wrapper no longer exist.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RS="${SCRIPT_DIR}/../restart-services.sh"
[[ -f "$RS" ]] || { echo "[TEST] ✗ restart-services.sh not found: $RS"; exit 1; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly929-notify.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

# ── Extract the real function definitions under test ─────────────────────────
FUNCS="${ROOT}/funcs.sh"
awk '
	/^log\(\)/,/^}/ { print; next }
	/^fire_meta_alert\(\)/,/^}/ { print; next }
	/^notify_routine\(\)/,/^}/ { print; next }
' "$RS" > "$FUNCS"
grep -q "notify_routine()" "$FUNCS" || { echo "[TEST] ✗ failed to extract notify_routine from restart-services.sh"; exit 1; }
grep -q "fire_meta_alert()" "$FUNCS" || { echo "[TEST] ✗ failed to extract fire_meta_alert from restart-services.sh"; exit 1; }

# ── Fakes: curl (records url + auth) + meta-alert.sh (records reason) ────────
mkdir -p "${ROOT}/bin" "${ROOT}/flywheel/scripts"
cat > "${ROOT}/bin/curl" <<'FAKE'
#!/usr/bin/env bash
# Records the url per call; a `-K -` stdin config (the FLY-1081 token path —
# never argv) is appended inline so the assertion can bind url ↔ auth.
url=""; auth=""
prev=""
for a in "$@"; do
	case "$a" in
		https://*) url="$a" ;;
	esac
	if [[ "$prev" == "-H" && "$a" == Authorization:* ]]; then auth="argv:$a"; fi
	if [[ "$prev" == "-K" && "$a" == "-" ]]; then auth="stdin:$(cat)"; fi
	prev="$a"
done
printf '%s | %s\n' "$url" "$auth" >> "$CURL_LOG"
exit 0
FAKE
chmod +x "${ROOT}/bin/curl"
cat > "${ROOT}/flywheel/scripts/meta-alert.sh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "${META_CALLS}"
exit 0
FAKE
chmod +x "${ROOT}/flywheel/scripts/meta-alert.sh"

# Run one notify_routine call in a hermetic subshell. $1=curl log, $2=meta log, rest=env pairs.
run_routine() {
	local logfile="$1" metafile="$2"; shift 2
	env -i PATH="${ROOT}/bin:/usr/bin:/bin" CURL_LOG="$logfile" META_CALLS="$metafile" \
		FLYWHEEL_DIR="${ROOT}/flywheel" \
		"$@" \
		bash -c "source '$FUNCS'; notify_routine '✅ 测试消息'"
}

# ── Case 1: P-identity satisfied → infra token + notify channel ──────────────
L1="${ROOT}/c1.log"; M1="${ROOT}/c1.meta"; : > "$L1"; : > "$M1"
run_routine "$L1" "$M1" CLAUDE_INFRA_BOT_TOKEN="infra-token" FLYWHEEL_NOTIFY_CHANNEL="notify-chan"
if grep -q "channels/notify-chan/messages | stdin:header = \"Authorization: Bot infra-token\"" "$L1"; then
	pass "P-identity satisfied → posts to FLYWHEEL_NOTIFY_CHANNEL as the infra bot (token via stdin config)"
else
	fail "P-identity satisfied: unexpected curl log: $(cat "$L1")"
fi
if grep -q "argv:" "$L1"; then
	fail "infra token rode curl argv (must use -K - stdin config)"
else
	pass "infra token never in curl argv"
fi
if [[ ! -s "$M1" ]]; then
	pass "P-identity satisfied → no meta-alert on the happy path"
else
	fail "P-identity satisfied: meta-alert fired: $(cat "$M1")"
fi

# ── Case 2: token only → ZERO curl + meta-alert + rc=0 (NO fallback) ─────────
L2="${ROOT}/c2.log"; M2="${ROOT}/c2.meta"; : > "$L2"; : > "$M2"
run_routine "$L2" "$M2" CLAUDE_INFRA_BOT_TOKEN="infra-token" 2>/dev/null; rc=$?
if [[ ! -s "$L2" ]]; then
	pass "token-only → ZERO curl (no Simba/core fallback)"
else
	fail "token-only: a POST happened: $(cat "$L2")"
fi
grep -q "notify_routine_unconfigured" "$M2" \
	&& pass "token-only → meta-alert(notify_routine_unconfigured)" || fail "token-only: meta-alert missing"
[[ $rc -eq 0 ]] && pass "token-only → rc=0 (deploy not blocked)" || fail "token-only rc=$rc"

# ── Case 3: channel only → ZERO curl + meta-alert + rc=0 ─────────────────────
L3="${ROOT}/c3.log"; M3="${ROOT}/c3.meta"; : > "$L3"; : > "$M3"
run_routine "$L3" "$M3" FLYWHEEL_NOTIFY_CHANNEL="notify-chan" 2>/dev/null; rc=$?
if [[ ! -s "$L3" ]]; then
	pass "channel-only → ZERO curl (no Simba/core fallback)"
else
	fail "channel-only: a POST happened: $(cat "$L3")"
fi
grep -q "notify_routine_unconfigured" "$M3" \
	&& pass "channel-only → meta-alert(notify_routine_unconfigured)" || fail "channel-only: meta-alert missing"
[[ $rc -eq 0 ]] && pass "channel-only → rc=0" || fail "channel-only rc=$rc"

# ── Case 4: call-site classification (static, against the real script) ──────
routine_sites=(
	'notify_routine "⏳ 等待 ${count} 个 active session idle'
	'notify_routine "🔄 开始更新 Flywheel'
	'notify_routine "✅ Flywheel 已更新到'
	'notify_routine "🔄 Lead 重启中'
	'notify_routine "✅ Lead 重启完成'
)
ok=1
for site in "${routine_sites[@]}"; do
	grep -qF "$site" "$RS" || { ok=0; fail "routine site missing/misrouted: $site"; }
done
[[ $ok -eq 1 ]] && pass "all 5 routine call sites use notify_routine"

# Every ⚠️/🚨 message must ride alert_warning/alert_severe, never notify_routine
# and never a raw ⚠️/🚨 string (titles/bodies carry no emoji since FLY-1081 —
# lead-alert.sh renders severity emoji itself).
if grep -E 'notify_routine "(⚠️|🚨)' "$RS" >/dev/null; then
	fail "a ⚠️/🚨 legacy alert was migrated to notify_routine (must ride alert_warning/alert_severe)"
else
	pass "no ⚠️/🚨 site rides notify_routine"
fi
# FLY-1081: notify_discord + the severe_alert() wrapper are GONE.
if grep -q "notify_discord" "$RS"; then
	fail "notify_discord still referenced (legacy Simba path must be fully removed)"
else
	pass "notify_discord fully removed"
fi
if grep -q "severe_alert()" "$RS"; then
	fail "severe_alert() wrapper still defined (Codex R2#1: three-arg alert_severe at call sites)"
else
	pass "severe_alert() wrapper deleted"
fi

echo "[TEST] restart-notify-routine: ${PASSED} passed, ${FAILED} failed"
[[ $FAILED -eq 0 ]] || exit 1
