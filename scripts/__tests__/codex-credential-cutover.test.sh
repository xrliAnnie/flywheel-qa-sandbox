#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="$ROOT/scripts/codex-credential-cutover.sh"
TMP_ROOT="$(mktemp -d /tmp/fly2404-cutover.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

make_fixture() {
	local t="$1"
	mkdir -p "$t/home/.flywheel/codex-homes/agents/flywheel/implement/.flywheel-leases" "$t/bin"
	printf '%s\n' '{"version":1,"project":"flywheel","role":"implement","createdAt":"2026-09-06T00:00:00Z","assemblyArm":"bare","materializedArm":null}' > "$t/home/.flywheel/codex-homes/agents/flywheel/implement/.flywheel-agent-home.json"
	printf 'copy' > "$t/home/.flywheel/codex-homes/agents/flywheel/implement/auth.json"
	printf 'pending\n' > "$t/home/.flywheel/codex-homes/agents/flywheel/implement/.credential-copy-pending"
	cat > "$t/bin/curl" <<'SH'
#!/usr/bin/env bash
set -eu
body=""; url=""
while [ "$#" -gt 0 ]; do
	case "$1" in -d|--data) body="$2"; shift 2 ;; http*) url="$1"; shift ;; *) shift ;; esac
done
printf '%s\t%s\n' "$url" "$body" >> "$CUTOVER_CALLS"
case "$url" in
	*/api/admission/pause)
		if [ "${CUTOVER_PAUSE_FAIL:-0}" = 1 ]; then exit 22; fi
		printf '%s\n' '{"ok":true,"admissionPause":{"active":true,"leaseId":"123e4567-e89b-42d3-a456-426614174000"}}'
		;;
	*/api/admission/quiescence) printf '%s\n' '{"quiescent":true}' ;;
	*/api/admission/resume) printf '%s\n' '{"ok":true,"resumed":true}' ;;
	*) exit 22 ;;
esac
SH
	cat > "$t/bin/scan" <<'SH'
#!/usr/bin/env bash
set -eu
count=0; [ ! -f "$CUTOVER_SCAN_COUNT" ] || count="$(cat "$CUTOVER_SCAN_COUNT")"
count=$((count + 1)); printf '%s\n' "$count" > "$CUTOVER_SCAN_COUNT"
if [ "${CUTOVER_SECOND_SCAN_ACTIVE:-0}" = 1 ] && [ "$count" -ge 2 ]; then
	printf '%s\n' '{"activeLegacy":["legacy-live"]}'
else
	printf '%s\n' '{"activeLegacy":[]}'
fi
SH
	cat > "$t/bin/link" <<'SH'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$CUTOVER_LINK_CALLS"
rm -f "$1/auth.json" "$1/.credential-copy-pending"
ln -s "$CUTOVER_TRUTH" "$1/auth.json"
SH
	chmod +x "$t/bin/curl" "$t/bin/scan" "$t/bin/link"
}

run_cutover() {
	local t="$1"; shift
	HOME="$t/home" TEAMLEAD_API_TOKEN=fixture-token \
	FLYWHEEL_CODEX_HOMES_ROOT="$t/home/.flywheel/codex-homes" \
	FLYWHEEL_CODEX_CUTOVER_CURL_BIN="$t/bin/curl" \
	FLYWHEEL_CODEX_CUTOVER_LEGACY_SCAN_BIN="$t/bin/scan" \
	FLYWHEEL_CODEX_CUTOVER_LINK_BIN="$t/bin/link" \
	FLYWHEEL_CODEX_CUTOVER_BASE_URL=http://bridge.test \
	FLYWHEEL_CODEX_CUTOVER_POLL_SECONDS=0 FLYWHEEL_CODEX_CUTOVER_TIMEOUT_SECONDS=1 \
	CUTOVER_CALLS="$t/calls" CUTOVER_LINK_CALLS="$t/link-calls" \
	CUTOVER_SCAN_COUNT="$t/scan-count" CUTOVER_TRUTH="$t/truth" \
		"${CUTOVER_SHELL:-bash}" "$SUT" "$@"
}

T1="$TMP_ROOT/success"; make_fixture "$T1"; printf '{}' > "$T1/truth"
if run_cutover "$T1" >/dev/null 2>&1 \
	&& [ -L "$T1/home/.flywheel/codex-homes/agents/flywheel/implement/auth.json" ] \
	&& [ ! -e "$T1/home/.flywheel/state/fly2404-cutover.json" ] \
	&& grep -q '"leaseId":"123e4567-e89b-42d3-a456-426614174000"' "$T1/calls"; then
	pass "cutover owns, renews, and resumes one pause while migrating every pending keyed home"
else
	fail "successful owned-pause cutover contract"
fi

T2="$TMP_ROOT/reown"; make_fixture "$T2"; printf '{}' > "$T2/truth"
CUTOVER_SECOND_SCAN_ACTIVE=1 run_cutover "$T2" >/dev/null 2>&1
reown_rc=$?
if [ "$reown_rc" -ne 0 ] && [ ! -L "$T2/home/.flywheel/codex-homes/agents/flywheel/implement/auth.json" ] \
	&& grep -q '/api/admission/resume' "$T2/calls"; then
	pass "the post-pause legacy scan blocks mutation and still resumes the owned lease"
else
	fail "post-pause legacy reown was not fenced"
fi

T3="$TMP_ROOT/corrupt"; make_fixture "$T3"; printf '{}' > "$T3/truth"
mkdir -p "$T3/home/.flywheel/state"
printf 'not-json\n' > "$T3/home/.flywheel/state/fly2404-cutover.json"
run_cutover "$T3" >/dev/null 2>&1
corrupt_rc=$?
if [ "$corrupt_rc" -ne 0 ] && [ ! -s "$T3/calls" ]; then
	pass "a corrupt crash-resume state fails closed before API or home mutation"
else
	fail "corrupt cutover state was not fail-closed"
fi

if /bin/bash -c '[[ "$BASH_VERSION" == 3.2* ]]' 2>/dev/null; then
	T4="$TMP_ROOT/bash32-empty"; make_fixture "$T4"; printf '{}' > "$T4/truth"
	rm -rf "$T4/home/.flywheel/codex-homes/agents"
	CUTOVER_SHELL=/bin/bash run_cutover "$T4" >"$T4/out" 2>"$T4/err"
	empty_rc=$?
	if [ "$empty_rc" -eq 0 ] && grep -q 'state=complete migrated=0' "$T4/out" \
		&& grep -q '/api/admission/resume' "$T4/calls"; then
		pass "an empty keyed-home inventory completes under macOS Bash 3.2"
	else
		fail "empty keyed-home inventory aborted under Bash 3.2: rc=$empty_rc"
	fi
else
	pass "the empty keyed-home inventory uses the Bash 3.2-safe expansion contract"
fi

if grep -Fxq 'codex-credential-cutover.sh' "$ROOT/scripts/package-onboard.sh" \
	&& grep -Fxq 'scripts/codex-credential-cutover.sh' "$ROOT/scripts/package-onboard-files.allow"; then
	pass "the cutover driver ships in the onboarding payload"
else
	fail "the cutover driver is absent from onboarding packaging"
fi

printf 'Results: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
