#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="$ROOT/scripts/codex-home-link-truth.sh"
TMP_ROOT="$(mktemp -d /tmp/fly2404-link-truth.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

file_mode() {
	python3 -c 'import os, sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$1"
}

make_fixture() {
	local t="$1"
	mkdir -p "$t/home/.codex" "$t/home/runner" "$t/bin"
	printf '%s\n' '{"version":1,"primary":"personal","profiles":[{"name":"school","email":"school@example.test","role":"manual_backup"},{"name":"personal","email":"personal@example.test","role":"primary"},{"name":"business","email":"business@example.test","role":"manual_backup"}]}' > "$t/registry.json"
	python3 - "$t/home/.codex/auth.json" <<'PY'
import base64, json, pathlib, sys
payload = base64.urlsafe_b64encode(json.dumps({"email":"personal@example.test","https://api.openai.com/auth":{"chatgpt_account_id":"acct-personal","chatgpt_plan_type":"pro"}}).encode()).decode().rstrip("=")
pathlib.Path(sys.argv[1]).write_text(json.dumps({"tokens":{"id_token":"e30.%s.sig" % payload,"access_token":"fixture-access","refresh_token":"fixture-refresh"}}))
PY
	chmod 600 "$t/home/.codex/auth.json"
	printf 'legacy-copy' > "$t/home/runner/auth.json"
	chmod 600 "$t/home/runner/auth.json"
	cat > "$t/bin/ps" <<'SH'
#!/usr/bin/env bash
set -eu
case "${LINK_TRUTH_PS_MODE:-empty}" in
	fail) exit 1 ;;
	live)
		if [ "${1:-}" = "-axo" ]; then printf '991 1 codex\n'; else printf 'CODEX_HOME=%s codex exec\n' "$LINK_TRUTH_HOME"; fi
		;;
	*) [ "${1:-}" = "-axo" ] && exit 0; exit 1 ;;
esac
SH
	chmod +x "$t/bin/ps"
}

run_sut() {
	local t="$1"; shift
	HOME="$t/home" \
	FLYWHEEL_CODEX_SOURCE_HOME="$t/home/.codex" \
	FLYWHEEL_CODEX_ACCOUNT_REGISTRY_PATH="$t/registry.json" \
	FLYWHEEL_CODEX_LINK_PS_BIN="$t/bin/ps" \
	FLYWHEEL_CODEX_LINK_HELPER="$ROOT/packages/claude-runner/bin/flywheel-codex-link-truth.mjs" \
	LINK_TRUTH_HOME="$t/home/runner" \
		"${LINK_TRUTH_SHELL:-bash}" "$SUT" "$@"
}

T1="$TMP_ROOT/link"; make_fixture "$T1"
TRUTH1="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$T1/home/.codex/auth.json")"
if run_sut "$T1" "$T1/home/runner" >"$T1/first.out" 2>&1 \
	&& [ -L "$T1/home/runner/auth.json" ] \
	&& [ "$(readlink "$T1/home/runner/auth.json")" = "$TRUTH1" ]; then
	pass "an idle ordinary credential becomes the canonical link"
else
	fail "ordinary credential migration failed: $(cat "$T1/first.out")"
fi

LINK_TRUTH_PS_MODE=fail run_sut "$T1" "$T1/home/runner" > "$T1/already.out" 2>&1
already_rc=$?
if [ "$already_rc" -eq 0 ] && grep -q 'state=already' "$T1/already.out"; then
	pass "an already-correct link returns before the process fence"
else
	fail "idempotent fast path consulted the unavailable process fence"
fi

chmod -x "$T1/bin/ps"
run_sut "$T1" "$T1/home/runner" > "$T1/already-no-ps.out" 2>&1
already_no_ps_rc=$?
if [ "$already_no_ps_rc" -eq 0 ] && grep -q 'state=already' "$T1/already-no-ps.out"; then
	pass "an already-correct link returns before validating the process-fence executable"
else
	fail "idempotent fast path required an executable process fence: rc=$already_no_ps_rc"
fi
chmod +x "$T1/bin/ps"

if /bin/bash -c '[[ "$BASH_VERSION" == 3.2* ]]' 2>/dev/null; then
	TB32="$TMP_ROOT/bash32"; make_fixture "$TB32"
	LINK_TRUTH_SHELL=/bin/bash run_sut "$TB32" "$TB32/home/runner" > "$TB32/out" 2>&1
	bash32_rc=$?
	if [ "$bash32_rc" -eq 0 ] && [ -L "$TB32/home/runner/auth.json" ]; then
		pass "the default empty-option path works under macOS Bash 3.2"
	else
		fail "the default empty-option path aborted under Bash 3.2: rc=$bash32_rc"
	fi
else
	pass "the default empty-option path uses the Bash 3.2-safe expansion contract"
fi

T2="$TMP_ROOT/ps-fail"; make_fixture "$T2"
LINK_TRUTH_PS_MODE=fail run_sut "$T2" "$T2/home/runner" >/dev/null 2>&1
ps_fail_rc=$?
if [ "$ps_fail_rc" -eq 5 ] && [ ! -L "$T2/home/runner/auth.json" ]; then
	pass "an unavailable process fence fails closed without mutation"
else
	fail "unavailable process fence did not fail closed: rc=$ps_fail_rc"
fi

T3="$TMP_ROOT/live"; make_fixture "$T3"
LINK_TRUTH_PS_MODE=live run_sut "$T3" "$T3/home/runner" >/dev/null 2>&1
live_rc=$?
if [ "$live_rc" -eq 3 ] && [ ! -L "$T3/home/runner/auth.json" ]; then
	pass "a live Codex process for the home blocks migration"
else
	fail "live process did not block migration: rc=$live_rc"
fi

run_sut "$T3" "$T3/home/runner" --keep-backup >/dev/null 2>&1
order_rc=$?
if [ "$order_rc" -eq 2 ]; then
	pass "the CLI rejects options placed after the home"
else
	fail "CLI accepted ambiguous argument order: rc=$order_rc"
fi

LINK_TRUTH_PS_MODE=empty run_sut "$T1" --unlink "$T1/home/runner" >/dev/null 2>&1
unlink_rc=$?
if [ "$unlink_rc" -eq 0 ] && [ -f "$T1/home/runner/auth.json" ] \
		&& [ ! -L "$T1/home/runner/auth.json" ] \
		&& [ "$(file_mode "$T1/home/runner/auth.json")" = 600 ]; then
	pass "rollback restores a 0600 ordinary copy"
else
	fail "rollback contract failed: rc=$unlink_rc"
fi

T4="$TMP_ROOT/backup"; make_fixture "$T4"
LINK_TRUTH_PS_MODE=empty run_sut "$T4" --keep-backup "$T4/home/runner" >/dev/null 2>&1
backup_rc=$?
backup_count="$(find "$T4/home/.flywheel/codex-credential-backups" -type f 2>/dev/null | wc -l | tr -d ' ')"
report="$T4/home/.flywheel/reports/fly2404-link-truth.jsonl"
if [ "$backup_rc" -eq 0 ] && [ "$backup_count" -eq 1 ] \
		&& [ "$(file_mode "$(find "$T4/home/.flywheel/codex-credential-backups" -type f -print -quit)")" = 600 ] \
	&& [ -f "$report" ] && ! grep -Eq 'fixture-(access|refresh)|e30\.' "$report"; then
	pass "keep-backup is private and the metadata report contains no token material"
else
	fail "backup/report contract failed: rc=$backup_rc count=$backup_count"
fi

T5="$TMP_ROOT/missing-backup"; make_fixture "$T5"
rm "$T5/home/runner/auth.json"
TRUTH5="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$T5/home/.codex/auth.json")"
LINK_TRUTH_PS_MODE=empty run_sut "$T5" --keep-backup "$T5/home/runner" >/dev/null 2>&1
missing_backup_rc=$?
missing_backup_count="$(find "$T5/home/.flywheel/codex-credential-backups" -type f 2>/dev/null | wc -l | tr -d ' ')"
if [ "$missing_backup_rc" -eq 0 ] \
		&& [ -L "$T5/home/runner/auth.json" ] \
	&& [ "$(readlink "$T5/home/runner/auth.json")" = "$TRUTH5" ] \
	&& [ "$missing_backup_count" -eq 0 ]; then
	pass "keep-backup repairs a missing link without inventing a backup"
else
	fail "missing-link keep-backup contract failed: rc=$missing_backup_rc count=$missing_backup_count"
fi

T6="$TMP_ROOT/report-failure"; make_fixture "$T6"
mkdir -p "$T6/home/.flywheel" "$T6/foreign-reports"
ln -s "$T6/foreign-reports" "$T6/home/.flywheel/reports"
TRUTH6="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$T6/home/.codex/auth.json")"
LINK_TRUTH_PS_MODE=empty run_sut "$T6" "$T6/home/runner" > "$T6/out" 2>&1
report_failure_rc=$?
if [ "$report_failure_rc" -eq 6 ] \
		&& [ -L "$T6/home/runner/auth.json" ] \
		&& [ "$(readlink "$T6/home/runner/auth.json")" = "$TRUTH6" ] \
		&& grep -q 'state=linked reason=report-write-failed' "$T6/out" \
		&& ! grep -q 'state=refused' "$T6/out"; then
	pass "post-mutation report failure returns a distinct linked-but-uncertain result"
else
	fail "post-mutation report failure was misreported: rc=$report_failure_rc"
fi

if grep -Fxq 'codex-home-link-truth.sh' "$ROOT/scripts/package-onboard.sh" \
	&& grep -Fxq 'scripts/codex-home-link-truth.sh' "$ROOT/scripts/package-onboard-files.allow"; then
	pass "the migration gate ships in the onboarding payload"
else
	fail "the migration gate is absent from onboarding packaging"
fi

printf 'Results: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
