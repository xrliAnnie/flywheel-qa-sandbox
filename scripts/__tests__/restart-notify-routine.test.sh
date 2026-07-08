#!/usr/bin/env bash
# FLY-929 W3b ②: restart-services.sh routine-notice migration.
#
# Hermetic: extracts the REAL log/notify_discord/severe_alert/notify_routine
# function definitions from restart-services.sh (no keep-in-sync copy) and runs
# them against a fake curl that records the channel + Authorization header.
# Asserts:
#   1. P-identity (both envs) → notify_routine posts to FLYWHEEL_NOTIFY_CHANNEL
#      with the Claude Infra Bot token.
#   2. Either env missing → notify_routine falls through to the EXACT legacy
#      notify_discord path (core channel + Simba token) — byte-compat.
#   3. Call-site classification: the 5 routine sites (⏳ idle wait / 🔄 update
#      start / ✅ updated / 🔄 lead restart / ✅ lead restart done) call
#      notify_routine; every ⚠️/🚨/severe_alert site still calls notify_discord.
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
	/^notify_discord\(\)/,/^}/ { print; next }
	/^severe_alert\(\)/ { print; next }
	/^notify_routine\(\)/,/^}/ { print; next }
' "$RS" > "$FUNCS"
grep -q "notify_routine()" "$FUNCS" || { echo "[TEST] ✗ failed to extract notify_routine from restart-services.sh"; exit 1; }

# ── Fake curl on a prepended PATH (records url + auth header) ────────────────
mkdir -p "${ROOT}/bin"
cat > "${ROOT}/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url=""; auth=""
prev=""
for a in "$@"; do
	case "$a" in
		https://*) url="$a" ;;
	esac
	if [[ "$prev" == "-H" && "$a" == Authorization:* ]]; then auth="$a"; fi
	prev="$a"
done
printf '%s | %s\n' "$url" "$auth" >> "$CURL_LOG"
exit 0
FAKE
chmod +x "${ROOT}/bin/curl"

# Run one notify_routine call in a hermetic subshell. $1=log file, rest=env pairs.
run_routine() {
	local logfile="$1"; shift
	env -i PATH="${ROOT}/bin:/usr/bin:/bin" CURL_LOG="$logfile" \
		DISCORD_CORE_CHANNEL="core-chan" NOTIFY_BOT_TOKEN="simba-token" \
		"$@" \
		bash -c "source '$FUNCS'; notify_routine '✅ 测试消息'"
}

# ── Case 1: P-identity satisfied → infra token + notify channel ──────────────
L1="${ROOT}/c1.log"; : > "$L1"
run_routine "$L1" CLAUDE_INFRA_BOT_TOKEN="infra-token" FLYWHEEL_NOTIFY_CHANNEL="notify-chan"
if grep -q "channels/notify-chan/messages | Authorization: Bot infra-token" "$L1"; then
	pass "P-identity satisfied → posts to FLYWHEEL_NOTIFY_CHANNEL as the infra bot"
else
	fail "P-identity satisfied: unexpected curl log: $(cat "$L1")"
fi
if ! grep -q "core-chan" "$L1"; then
	pass "P-identity satisfied → legacy core-channel path NOT taken"
else
	fail "P-identity satisfied: legacy path was ALSO hit: $(cat "$L1")"
fi

# ── Case 2: token only → exact legacy path (byte-compat) ─────────────────────
L2="${ROOT}/c2.log"; : > "$L2"
run_routine "$L2" CLAUDE_INFRA_BOT_TOKEN="infra-token"
if grep -q "channels/core-chan/messages | Authorization: Bot simba-token" "$L2"; then
	pass "token-only → falls through to legacy notify_discord (core + Simba)"
else
	fail "token-only: unexpected curl log: $(cat "$L2")"
fi

# ── Case 3: channel only → exact legacy path ─────────────────────────────────
L3="${ROOT}/c3.log"; : > "$L3"
run_routine "$L3" FLYWHEEL_NOTIFY_CHANNEL="notify-chan"
if grep -q "channels/core-chan/messages | Authorization: Bot simba-token" "$L3"; then
	pass "channel-only → falls through to legacy notify_discord"
else
	fail "channel-only: unexpected curl log: $(cat "$L3")"
fi

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

# Every ⚠️/🚨 message must still ride notify_discord (or severe_alert), never notify_routine.
if grep -E 'notify_routine "(⚠️|🚨)' "$RS" >/dev/null; then
	fail "a ⚠️/🚨 legacy alert was migrated to notify_routine (must stay on notify_discord)"
else
	pass "no ⚠️/🚨 site rides notify_routine (legacy alerts untouched)"
fi
# severe_alert body unchanged: still notify_discord.
if grep -q 'severe_alert() { log "SEVERE: $1"; notify_discord "🚨 $1"; }' "$RS"; then
	pass "severe_alert still routes through notify_discord verbatim"
else
	fail "severe_alert definition changed"
fi

echo "[TEST] restart-notify-routine: ${PASSED} passed, ${FAILED} failed"
[[ $FAILED -eq 0 ]] || exit 1
