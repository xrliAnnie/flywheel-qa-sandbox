#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$ROOT/scripts/lib/lead-address.sh"
HELPER="$ROOT/scripts/resident-codex-lead-recover.sh"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

# shellcheck source=../lib/lead-address.sh
source "$LIB"

if declare -F derive_codex_lead_home >/dev/null 2>&1; then
	valid=1
	for fixture in 'raya /h /h/.codex-raya' \
		'mufasa /h /h/.codex-mufasa' \
		'infra-bot /h /h/.codex-infra-bot'; do
		read -r key home_root expected <<<"$fixture"
		actual="$(derive_codex_lead_home "$key" "$home_root" 2>/dev/null)" || valid=0
		[ "$actual" = "$expected" ] || valid=0
	done
	if [ "$valid" -eq 1 ]; then
		pass "valid Codex Lead home keys resolve through one path rule"
	else
		fail "valid Codex Lead home key resolution"
	fi

	invalid=1
	for fixture in 'Raya /h' 'raya/x /h' '__EMPTY__ /h' 'raya relative/home'; do
		read -r key home_root <<<"$fixture"
		[ "$key" != __EMPTY__ ] || key=""
		stdout_file="$(mktemp /tmp/fly2259-home-rule.XXXXXX)"
		if derive_codex_lead_home "$key" "$home_root" >"$stdout_file" 2>/dev/null; then
			invalid=0
		fi
		[ ! -s "$stdout_file" ] || invalid=0
		rm -f "$stdout_file"
	done
	if [ "$invalid" -eq 1 ]; then
		pass "invalid home keys and relative roots fail with empty stdout"
	else
		fail "invalid home inputs were not fail-closed"
	fi
else
	fail "derive_codex_lead_home is defined"
fi

assert_launcher() {
	local name="$1" key="$2" launcher
	launcher="$ROOT/packages/teamlead/scripts/$name"
	local key_count derive_count safe_default_count export_count legacy_count unsafe_export_count
	key_count="$(grep -cFx "export FLYWHEEL_CODEX_LEAD_HOME_KEY=$key" "$launcher" || true)"
	derive_count="$(grep -cF 'derive_codex_lead_home "$FLYWHEEL_CODEX_LEAD_HOME_KEY"' "$launcher" || true)"
	safe_default_count="$(grep -cF 'codex_home_default="$(derive_codex_lead_home "$FLYWHEEL_CODEX_LEAD_HOME_KEY")" || exit $?' "$launcher" || true)"
	export_count="$(grep -cF 'export CODEX_HOME="${CODEX_HOME:-$codex_home_default}"' "$launcher" || true)"
	legacy_count="$(grep -cF 'CODEX_HOME:-${HOME}/' "$launcher" || true)"
	unsafe_export_count="$(grep -cF 'export CODEX_HOME="${CODEX_HOME:-$(derive_codex_lead_home' "$launcher" || true)"
	if [ "$key_count" -eq 1 ] && [ "$derive_count" -eq 1 ] \
		&& [ "$safe_default_count" -eq 1 ] && [ "$export_count" -eq 1 ] \
		&& [ "$legacy_count" -eq 0 ] && [ "$unsafe_export_count" -eq 0 ] \
		&& ! grep -Fq 'raya/codex-home' "$launcher"; then
		pass "$name fails closed while using the shared Codex Lead home rule with key $key"
	else
		fail "$name home wiring (key=$key key_count=$key_count derive_count=$derive_count safe_default_count=$safe_default_count export_count=$export_count legacy_count=$legacy_count unsafe_export_count=$unsafe_export_count)"
	fi
}

assert_launcher run-codex-lead-mufasa-tui-fullaccess.sh mufasa
assert_launcher run-codex-infra-bot-tui.sh infra-bot
assert_launcher run-codex-lead-raya-tui-fullaccess.sh raya

assert_helper_mapping() {
	local wrapper="$1" key="$2" block
	block="$(sed -n "/$wrapper)/,/;;/p" "$HELPER")"
	if grep -Fqx $'\t\t\tcodex_home_key='"$key" <<<"$block"; then
		pass "recovery helper maps $wrapper to home key $key"
	else
		fail "recovery helper mapping for $wrapper"
	fi
}

assert_helper_mapping flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh mufasa
assert_helper_mapping flywheel-codex-lead-wrapper-codex-infra-bot.sh infra-bot
assert_helper_mapping flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh raya

if grep -Fq 'derive_codex_lead_home "$codex_home_key" "$HOME_ROOT"' "$HELPER" \
	&& ! grep -Fq '.codex-' "$HELPER"; then
	pass "recovery helper derives expected homes without path literals"
else
	fail "recovery helper does not use the shared home rule exclusively"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
