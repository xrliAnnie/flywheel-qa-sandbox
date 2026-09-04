#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$REPO_ROOT/scripts/lead-memory/retire-units.sh"
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly2146-retire.XXXXXX")"
trap 'rm -rf -- "$TASK_TMP_DIR"' EXIT

PASSED=0
pass() { PASSED=$((PASSED + 1)); printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }

test -x "$SOURCE" || fail "retirement operator exists and is executable"

FIXTURE_SOURCE="$TASK_TMP_DIR/source"
AGENTS="$TASK_TMP_DIR/Library/LaunchAgents"
MANIFEST="$TASK_TMP_DIR/units.manifest"
STATE="$TASK_TMP_DIR/runtime"
LOG="$TASK_TMP_DIR/operator.log"
mkdir -p "$FIXTURE_SOURCE" "$AGENTS" "$STATE"
cp "$REPO_ROOT/scripts/launchd/com.flywheel.lead-memory-sync.plist" "$FIXTURE_SOURCE/"
cp "$REPO_ROOT/scripts/launchd/com.flywheel.lead-memory-arrival-check.plist" "$FIXTURE_SOURCE/"
cp "$REPO_ROOT/scripts/launchd/units.manifest" "$MANIFEST"

HARNESS="$TASK_TMP_DIR/run-retire.sh"
cat >"$HARNESS" <<'HARNESS'
#!/usr/bin/env bash
set -u
. "$1"
shift
_retire_source_dir() { printf '%s\n' "${TEST_SOURCE_DIR:?}"; }
_retire_manifest_path() { printf '%s\n' "${TEST_MANIFEST:?}"; }
fly1814_operator_has_tty() { test "${TEST_TTY:-1}" = 1; }
fly1814_domain() { printf 'gui/501\n'; }
fly1814_launch_agents_dir() { printf '%s\n' "${TEST_AGENTS:?}"; }
fly1814_today() { printf '20260904\n'; }
fly1814_domain_state() { cat "${TEST_RUNTIME:?}/domain-${2}"; }
fly1814_disabled_state() { cat "${TEST_RUNTIME:?}/disabled-${2}"; }
fly1814_operator_audit() {
  printf 'audit\t%s\n' "$2" >>"${TEST_LOG:?}"
  test "${TEST_AUDIT_FAIL:-0}" != 1
}
fly1814_launchctl() {
  printf '%s\n' "$*" >>"${TEST_LOG:?}"
  action=$1
  target=$2
  label=${target##*/}
  test "${TEST_FAIL_ACTION:-}" != "$action" || return 1
  case "$action" in
    disable) printf 'disabled\n' >"${TEST_RUNTIME:?}/disabled-${label}" ;;
    enable) printf 'enabled\n' >"${TEST_RUNTIME:?}/disabled-${label}" ;;
    bootout) printf 'missing\n' >"${TEST_RUNTIME:?}/domain-${label}" ;;
  esac
}
fly1814_archive_publish() {
  test "${TEST_FAIL_ACTION:-}" != archive || return 1
  ln "$1" "$2"
}
fly1814_source_remove() {
  test "${TEST_FAIL_ACTION:-}" != unlink || return 1
  command rm -f -- "$1"
}
retire_main "$@"
HARNESS
chmod 755 "$HARNESS"

run_operator() {
	env TEST_SOURCE_DIR="$FIXTURE_SOURCE" TEST_MANIFEST="$MANIFEST" TEST_AGENTS="$AGENTS" \
		TEST_RUNTIME="$STATE" TEST_LOG="$LOG" "$HARNESS" "$SOURCE" "$@"
}

SYNC_LABEL=com.flywheel.lead-memory-sync
ARRIVAL_LABEL=com.flywheel.lead-memory-arrival-check
install_unit() {
	local label="$1"
	cp "$FIXTURE_SOURCE/$label.plist" "$AGENTS/$label.plist"
	printf 'loaded\n' >"$STATE/domain-$label"
	printf 'enabled\n' >"$STATE/disabled-$label"
}

: >"$LOG"
install_unit "$SYNC_LABEL"
run_operator --apply --i-am-operator "$SYNC_LABEL" >/dev/null || fail "normal retirement succeeds"
ARCHIVE="$AGENTS/retired-20260904/$SYNC_LABEL.plist"
test ! -e "$AGENTS/$SYNC_LABEL.plist" && test -f "$ARCHIVE" ||
	fail "normal retirement does not archive then remove the active plist"
test "$(cat "$STATE/disabled-$SYNC_LABEL")" = disabled || fail "normal retirement does not disable override"
test "$(cat "$STATE/domain-$SYNC_LABEL")" = missing || fail "normal retirement does not boot out the label"
EXPECTED_ORDER=$'audit\tcom.flywheel.lead-memory-sync\ndisable gui/501/com.flywheel.lead-memory-sync\nbootout gui/501/com.flywheel.lead-memory-sync'
test "$(cat "$LOG")" = "$EXPECTED_ORDER" || fail "retirement mutations are not audit → disable → bootout"
pass "retirement audits, disables, unloads, and hard-link archives in order"

LOG_BEFORE="$(shasum -a 256 "$LOG" | awk '{print $1}')"
run_operator --apply --i-am-operator "$SYNC_LABEL" >/dev/null || fail "completed retirement is not idempotent"
test "$(shasum -a 256 "$LOG" | awk '{print $1}')" = "$LOG_BEFORE" ||
	fail "idempotent retirement repeats an audit or mutation"
pass "completed retirement is idempotent"

install_unit "$ARRIVAL_LABEL"
LOG_BEFORE="$(shasum -a 256 "$LOG" | awk '{print $1}')"
set +e
TEST_TTY=0 run_operator --apply --i-am-operator "$ARRIVAL_LABEL" >/dev/null 2>&1
NO_TTY_RC=$?
set -e
test "$NO_TTY_RC" -ne 0 && test "$(cat "$STATE/domain-$ARRIVAL_LABEL")" = loaded &&
	test "$(cat "$STATE/disabled-$ARRIVAL_LABEL")" = enabled &&
	test "$(shasum -a 256 "$LOG" | awk '{print $1}')" = "$LOG_BEFORE" ||
	fail "non-TTY retirement mutates unit state"
pass "non-TTY retirement is refused before audit or mutation"

set +e
TEST_AUDIT_FAIL=1 run_operator --apply --i-am-operator "$ARRIVAL_LABEL" >/dev/null 2>&1
AUDIT_FAIL_RC=$?
set -e
test "$AUDIT_FAIL_RC" -ne 0 && test "$(cat "$STATE/domain-$ARRIVAL_LABEL")" = loaded &&
	test "$(cat "$STATE/disabled-$ARRIVAL_LABEL")" = enabled ||
	fail "failed audit permits launchctl mutation"
pass "audit delivery failure leaves the unit untouched"

# Rehearse the crash window after hard-link publication and before source unlink.
printf 'disabled\n' >"$STATE/disabled-$ARRIVAL_LABEL"
printf 'missing\n' >"$STATE/domain-$ARRIVAL_LABEL"
mkdir -p "$AGENTS/retired-20260904"
ln "$AGENTS/$ARRIVAL_LABEL.plist" "$AGENTS/retired-20260904/$ARRIVAL_LABEL.plist"
SOURCE_INODE="$(stat -c '%d:%i' "$AGENTS/$ARRIVAL_LABEL.plist" 2>/dev/null || stat -f '%d:%i' "$AGENTS/$ARRIVAL_LABEL.plist")"
ARCHIVE_INODE="$(stat -c '%d:%i' "$AGENTS/retired-20260904/$ARRIVAL_LABEL.plist" 2>/dev/null || stat -f '%d:%i' "$AGENTS/retired-20260904/$ARRIVAL_LABEL.plist")"
test "$SOURCE_INODE" = "$ARCHIVE_INODE" || fail "crash fixture is not the same inode"
run_operator --apply --i-am-operator "$ARRIVAL_LABEL" >/dev/null ||
	fail "retirement does not resume the published-before-unlink crash window"
test ! -e "$AGENTS/$ARRIVAL_LABEL.plist" && test -f "$AGENTS/retired-20260904/$ARRIVAL_LABEL.plist" ||
	fail "resumed retirement does not finish identity-safe unlink"
pass "retirement resumes safely after archive publication interruption"

run_operator --enable --i-am-operator "$ARRIVAL_LABEL" >"$TASK_TMP_DIR/enable.out" ||
	fail "enable recovery succeeds after source and manifest restoration"
test "$(cat "$STATE/disabled-$ARRIVAL_LABEL")" = enabled || fail "enable recovery does not clear override"
grep -Fq 'converge-nonlead-daemons.sh' "$TASK_TMP_DIR/enable.out" ||
	fail "enable recovery does not require convergence after source restoration"
pass "re-enable clears override only after repository authority is present"

reset_unit() {
	local label="$1"
	rm -f -- "$AGENTS/$label.plist" "$AGENTS/retired-20260904/$label.plist"
	install_unit "$label"
	: >"$LOG"
}

reset_unit "$SYNC_LABEL"
set +e
TEST_FAIL_ACTION=disable run_operator --apply --i-am-operator "$SYNC_LABEL" >/dev/null 2>&1
DISABLE_FAIL_RC=$?
set -e
test "$DISABLE_FAIL_RC" -ne 0 && test -f "$AGENTS/$SYNC_LABEL.plist" &&
	test ! -e "$AGENTS/retired-20260904/$SYNC_LABEL.plist" &&
	test "$(cat "$STATE/disabled-$SYNC_LABEL")" = enabled &&
	test "$(cat "$STATE/domain-$SYNC_LABEL")" = loaded ||
	fail "disable failure permits later retirement mutations"
pass "disable failure stops before unload or archive"

reset_unit "$SYNC_LABEL"
set +e
TEST_FAIL_ACTION=bootout run_operator --apply --i-am-operator "$SYNC_LABEL" >/dev/null 2>&1
BOOTOUT_FAIL_RC=$?
set -e
test "$BOOTOUT_FAIL_RC" -ne 0 && test -f "$AGENTS/$SYNC_LABEL.plist" &&
	test ! -e "$AGENTS/retired-20260904/$SYNC_LABEL.plist" &&
	test "$(cat "$STATE/disabled-$SYNC_LABEL")" = disabled &&
	test "$(cat "$STATE/domain-$SYNC_LABEL")" = loaded ||
	fail "bootout failure permits archive or source removal"
pass "bootout failure stops before archive"

reset_unit "$SYNC_LABEL"
set +e
TEST_FAIL_ACTION=archive run_operator --apply --i-am-operator "$SYNC_LABEL" >/dev/null 2>&1
ARCHIVE_FAIL_RC=$?
set -e
test "$ARCHIVE_FAIL_RC" -ne 0 && test -f "$AGENTS/$SYNC_LABEL.plist" &&
	test ! -e "$AGENTS/retired-20260904/$SYNC_LABEL.plist" &&
	test "$(cat "$STATE/disabled-$SYNC_LABEL")" = disabled &&
	test "$(cat "$STATE/domain-$SYNC_LABEL")" = missing ||
	fail "archive failure removes the only plist copy"
run_operator --apply --i-am-operator "$SYNC_LABEL" >/dev/null ||
	fail "retirement cannot resume after archive publication failure"
test ! -e "$AGENTS/$SYNC_LABEL.plist" && test -f "$AGENTS/retired-20260904/$SYNC_LABEL.plist" ||
	fail "archive failure resume does not complete retirement"
pass "archive failure preserves source and resumes safely"

reset_unit "$SYNC_LABEL"
printf '\nforeign-active\n' >>"$AGENTS/$SYNC_LABEL.plist"
LOG_BEFORE="$(shasum -a 256 "$LOG" | awk '{print $1}')"
set +e
run_operator --apply --i-am-operator "$SYNC_LABEL" >/dev/null 2>&1
FOREIGN_ACTIVE_RC=$?
set -e
test "$FOREIGN_ACTIVE_RC" -ne 0 && test "$(cat "$STATE/disabled-$SYNC_LABEL")" = enabled &&
	test "$(cat "$STATE/domain-$SYNC_LABEL")" = loaded &&
	test "$(shasum -a 256 "$LOG" | awk '{print $1}')" = "$LOG_BEFORE" ||
	fail "foreign active plist reaches audit or launchctl mutation"
pass "foreign active plist is rejected before audit"

reset_unit "$SYNC_LABEL"
mkdir -p "$AGENTS/retired-20260904"
printf 'foreign-archive\n' >"$AGENTS/retired-20260904/$SYNC_LABEL.plist"
LOG_BEFORE="$(shasum -a 256 "$LOG" | awk '{print $1}')"
set +e
run_operator --apply --i-am-operator "$SYNC_LABEL" >/dev/null 2>&1
FOREIGN_ARCHIVE_RC=$?
set -e
test "$FOREIGN_ARCHIVE_RC" -ne 0 && test -f "$AGENTS/$SYNC_LABEL.plist" &&
	test "$(cat "$STATE/disabled-$SYNC_LABEL")" = enabled &&
	test "$(cat "$STATE/domain-$SYNC_LABEL")" = loaded &&
	test "$(shasum -a 256 "$LOG" | awk '{print $1}')" = "$LOG_BEFORE" ||
	fail "foreign archive destination reaches audit or mutation"
pass "foreign archive collision is rejected before audit"

rm -f -- "$FIXTURE_SOURCE/$ARRIVAL_LABEL.plist"
printf 'disabled\n' >"$STATE/disabled-$ARRIVAL_LABEL"
set +e
run_operator --enable --i-am-operator "$ARRIVAL_LABEL" >/dev/null 2>&1
MISSING_AUTHORITY_RC=$?
set -e
test "$MISSING_AUTHORITY_RC" -ne 0 && test "$(cat "$STATE/disabled-$ARRIVAL_LABEL")" = disabled ||
	fail "enable clears override without repository authority"
cp "$REPO_ROOT/scripts/launchd/$ARRIVAL_LABEL.plist" "$FIXTURE_SOURCE/"
pass "enable refuses missing repository authority"

# Executable counterexample for the retirement ordering: deleting an enabled
# copy unit is temporary because the existing deploy convergence immediately
# re-installs and bootstraps it. The disabled override is the durable authority
# that prevents resurrection while the manifest row remains present.
CONVERGE_ROOT="$TASK_TMP_DIR/converge"
CONVERGE_REPO="$CONVERGE_ROOT/repo"
CONVERGE_AGENTS="$CONVERGE_ROOT/agents"
CONVERGE_MANIFEST="$CONVERGE_ROOT/units.manifest"
CONVERGE_DOMAIN="$CONVERGE_ROOT/domain"
CONVERGE_DISABLED="$CONVERGE_ROOT/disabled"
CONVERGE_BOOTSTRAP="$CONVERGE_ROOT/bootstrap.log"
mkdir -p "$CONVERGE_REPO" "$CONVERGE_AGENTS"
cat >"$CONVERGE_MANIFEST" <<EOF
# host-prefix: /fixture/
# census-scope: com.flywheel.
$SYNC_LABEL	$SYNC_LABEL.plist	copy	0	FLY-2146 resurrection counterexample
EOF
cat >"$CONVERGE_REPO/$SYNC_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$SYNC_LABEL</string>
<key>ProgramArguments</key><array>
<string>/bin/bash</string><string>/bin/bash</string>
</array>
</dict></plist>
EOF
: >"$CONVERGE_DOMAIN"
: >"$CONVERGE_BOOTSTRAP"
cat >"$CONVERGE_DISABLED" <<EOF
disabled services = {
	"$SYNC_LABEL" => enabled
}
EOF
CONVERGE_HARNESS="$TASK_TMP_DIR/run-converge.sh"
cat >"$CONVERGE_HARNESS" <<'HARNESS'
#!/usr/bin/env bash
set -uo pipefail
. "$1"
_cnd_converge_codex_guard() { :; }
_cnd_units_manifest() { printf '%s\n' "${TEST_CONVERGE_MANIFEST:?}"; }
_cnd_repo_launchd_dir() { printf '%s\n' "${TEST_CONVERGE_REPO:?}"; }
_cnd_launch_agents_dir() { printf '%s\n' "${TEST_CONVERGE_AGENTS:?}"; }
_cnd_domain() { printf 'gui/501\n'; }
_cnd_launchctl() {
	case "$1" in
		print-disabled) cat "${TEST_CONVERGE_DISABLED:?}" ;;
		print)
			label=${2##*/}
			if grep -Fxq "$label" "${TEST_CONVERGE_DOMAIN:?}"; then
				return 0
			fi
			printf 'Could not find service "%s" in domain for user gui: 501\n' "$label" >&2
			return 113
			;;
		bootstrap)
			label="$(nonlead_daemon_plist_label "$3")" || return 1
			printf '%s\n' "$label" >>"${TEST_CONVERGE_BOOTSTRAP:?}"
			printf '%s\n' "$label" >>"${TEST_CONVERGE_DOMAIN:?}"
			;;
		*) return 1 ;;
	esac
}
converge_nonlead_daemons
printf 'state=%s\ndetail=%s\n' "$NONLEAD_DAEMON_CONVERGE_STATE" "$NONLEAD_DAEMON_CONVERGE_DETAIL"
HARNESS
chmod 755 "$CONVERGE_HARNESS"
run_converge() {
	env TEST_CONVERGE_MANIFEST="$CONVERGE_MANIFEST" TEST_CONVERGE_REPO="$CONVERGE_REPO" \
		TEST_CONVERGE_AGENTS="$CONVERGE_AGENTS" TEST_CONVERGE_DOMAIN="$CONVERGE_DOMAIN" \
		TEST_CONVERGE_DISABLED="$CONVERGE_DISABLED" TEST_CONVERGE_BOOTSTRAP="$CONVERGE_BOOTSTRAP" \
		"$CONVERGE_HARNESS" "$REPO_ROOT/scripts/lib/converge-nonlead-daemons.sh"
}
run_converge >"$CONVERGE_ROOT/enabled.out" 2>&1 || fail "enabled manifest unit resurrection fixture cannot converge"
test -f "$CONVERGE_AGENTS/$SYNC_LABEL.plist" && grep -Fxq "$SYNC_LABEL" "$CONVERGE_BOOTSTRAP" ||
	fail "enabled retired unit is not resurrected by existing convergence: $(tr '\n' ' ' <"$CONVERGE_ROOT/enabled.out")"
rm -f -- "$CONVERGE_AGENTS/$SYNC_LABEL.plist"
: >"$CONVERGE_DOMAIN"
: >"$CONVERGE_BOOTSTRAP"
cat >"$CONVERGE_DISABLED" <<EOF
disabled services = {
	"$SYNC_LABEL" => disabled
}
EOF
run_converge >"$CONVERGE_ROOT/disabled.out" 2>&1 || fail "disabled manifest unit fixture cannot converge safely"
test ! -e "$CONVERGE_AGENTS/$SYNC_LABEL.plist" && test ! -s "$CONVERGE_BOOTSTRAP" ||
	fail "disabled retired unit is resurrected by convergence"
pass "disabled override prevents manifest-driven resurrection"

set +e
run_operator --apply --i-am-operator com.flywheel.not-memory >/dev/null 2>&1
FOREIGN_LABEL_RC=$?
set -e
test "$FOREIGN_LABEL_RC" -ne 0 || fail "retirement accepts a label outside its exact allowlist"
pass "retirement is bounded to the two FLY-2146 labels"

printf 'ALL %s TESTS PASSED\n' "$PASSED"
