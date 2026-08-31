#!/usr/bin/env bash
# FLY-2137: launchd installer render/lint/idempotence/uninstall contract.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="$ROOT/scripts/install-calendar-sweep.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly2137-installer-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1" >&2; }

if [[ ! -f "$INSTALLER" ]]; then
	fail "install-calendar-sweep.sh exists"
	printf '%s passed, %s failed\n' "$PASS" "$FAIL"
	exit 1
fi

HOME_DIR="$TMP_ROOT/home"
CTL="$TMP_ROOT/launchctl"
CALLS="$TMP_ROOT/launchctl.calls"
mkdir -p "$HOME_DIR"
printf '%s\n' \
	'#!/usr/bin/env bash' \
	'printf "%s\n" "$*" >> "$LAUNCHCTL_CALLS"' \
	'if [[ "$1" == bootstrap && "${LAUNCHCTL_BOOTSTRAP_FAIL:-0}" == 1 ]]; then exit 9; fi' \
	'exit 0' > "$CTL"
chmod +x "$CTL"

run_installer() {
	HOME="$HOME_DIR" FLYWHEEL_REPO="$ROOT" \
		FLYWHEEL_CALENDAR_SWEEP_LAUNCHCTL="$CTL" LAUNCHCTL_CALLS="$CALLS" \
		bash "$INSTALLER" "$@"
}

DEST="$HOME_DIR/Library/LaunchAgents/com.flywheel.calendar-sweep.plist"
if run_installer install >/dev/null 2>&1 \
	&& [[ -f "$DEST" && ! -L "$DEST" ]] \
	&& ! grep -q '__[A-Z_]*__' "$DEST" \
	&& grep -q "$ROOT/scripts/calendar-write-sweep.mjs" "$DEST" \
	&& grep -q "$(command -v node)" "$DEST" \
	&& grep -q 'bootstrap' "$CALLS" \
	&& grep -q 'print' "$CALLS"; then
	pass "I1 render + placeholder verification + bootstrap/print"
else fail "I1 install render"; fi

if run_installer install >/dev/null 2>&1 \
	&& [[ "$(grep -c 'bootstrap' "$CALLS")" == 2 ]]; then
	pass "I2 install is idempotent"
else fail "I2 idempotent install"; fi

if run_installer uninstall >/dev/null 2>&1 \
	&& [[ ! -e "$DEST" ]] \
	&& grep -q 'bootout' "$CALLS"; then
	pass "I3 uninstall bootouts and removes only the rendered plist"
else fail "I3 uninstall"; fi

LAUNCHCTL_BOOTSTRAP_FAIL=1 run_installer install >/dev/null 2>&1; rc=$?
if [[ "$rc" != 0 ]] && tail -n 3 "$CALLS" | grep -q 'bootout'; then
	pass "I4 bootstrap failure is fail-loud with bootout rollback"
else fail "I4 bootstrap failure rollback"; fi

if command -v plutil >/dev/null 2>&1 && plutil -lint "$DEST" >/dev/null 2>&1; then
	pass "I5 rendered plist passes plutil"
elif ! command -v plutil >/dev/null 2>&1; then
	pass "I5 plutil unavailable (installer still verifies placeholders)"
else fail "I5 rendered plist lint"; fi

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
exit "$FAIL"
