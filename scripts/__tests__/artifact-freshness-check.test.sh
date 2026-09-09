#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OBSERVER="$REPO_ROOT/scripts/artifact-freshness-check.sh"
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly2134-check.XXXXXX")"
trap 'rm -rf -- "$TASK_TMP_DIR"' EXIT

fail() {
	printf 'not ok - %s\n' "$1" >&2
	exit 1
}

hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }

# shellcheck source=../artifact-freshness-check.sh
. "$OBSERVER"

NOW=1788480000
_af_now() { printf '%s\n' "$NOW"; }
STAT_MODE=ok
STAT_MTIME=$((NOW - 3599))
_af_stat() {
	[[ "$STAT_MODE" == ok ]] || return 1
	printf '%s\n' "$STAT_MTIME"
}

FRESH_FILE="$TASK_TMP_DIR/fresh.txt"
printf 'fresh\n' >"$FRESH_FILE"

result="$(_af_probe_file "$FRESH_FILE" 1)" || fail "fresh file probe executes"
[[ "$result" == $'fresh\t1788476401\t1.0\tok' ]] ||
	fail "fresh file probe returned unexpected evidence: $result"

printf 'ok - file probe judges a non-empty artifact by output age\n'

assert_file_probe() {
	local name="$1" path="$2" max_age="$3" expected="$4" actual
	actual="$(_af_probe_file "$path" "$max_age")" || fail "$name probe executes"
	[[ "$actual" == "$expected" ]] || fail "$name expected [$expected], got [$actual]"
}

MISSING_FILE="$TASK_TMP_DIR/missing"
assert_file_probe missing "$MISSING_FILE" 1 $'missing\tnone\tn/a\tmissing'

SYMLINK_FILE="$TASK_TMP_DIR/symlink"
ln -s "$FRESH_FILE" "$SYMLINK_FILE"
assert_file_probe symlink "$SYMLINK_FILE" 1 $'missing\tnone\tn/a\tunsafe_type'

DIRECTORY="$TASK_TMP_DIR/directory"
mkdir "$DIRECTORY"
assert_file_probe directory "$DIRECTORY" 1 $'missing\tnone\tn/a\tunsafe_type'

FIFO="$TASK_TMP_DIR/fifo"
mkfifo "$FIFO"
assert_file_probe fifo "$FIFO" 1 $'missing\tnone\tn/a\tunsafe_type'

ZERO_FILE="$TASK_TMP_DIR/zero"
: >"$ZERO_FILE"
STAT_MTIME=$NOW
assert_file_probe zero-byte "$ZERO_FILE" 1 $'stale\t1788480000\t0.0\tzero_byte'

STAT_MODE=fail
assert_file_probe stat-failure "$FRESH_FILE" 1 $'undetermined\tnone\tn/a\tstat_failed'
STAT_MODE=ok

STAT_MTIME=$((NOW + 1))
assert_file_probe future-mtime "$FRESH_FILE" 1 $'fresh\t1788480001\t0.0\tfuture_mtime'

STAT_MTIME=$((NOW - 900))
assert_file_probe quarter-hour-boundary "$FRESH_FILE" 0.25 $'fresh\t1788479100\t0.2\tok'
STAT_MTIME=$((NOW - 901))
assert_file_probe quarter-hour-stale "$FRESH_FILE" 0.25 $'stale\t1788479099\t0.3\tok'

printf 'ok - file probe covers missing, unsafe, empty, unreadable, future, and threshold edges\n'

SQLITE_FILE="$TASK_TMP_DIR/data.sqlite"
printf 'fixture\n' >"$SQLITE_FILE"
SQLITE_MODE=ok
SQLITE_OUTPUT=2026-09-04
SQLITE_CALLS="$TASK_TMP_DIR/sqlite.calls"
: >"$SQLITE_CALLS"
_af_sqlite() {
	printf '%s\t%s\n' "$1" "$2" >>"$SQLITE_CALLS"
	[[ "$SQLITE_MODE" == ok ]] || return "${SQLITE_RC:-1}"
	printf '%s\n' "$SQLITE_OUTPUT"
}

result="$(_af_probe_sqlite "$SQLITE_FILE" token_usage_daily day 36)" ||
	fail "fresh sqlite probe executes"
[[ "$result" == $'fresh\t2026-09-04\t0.0\tok' ]] ||
	fail "fresh sqlite probe returned unexpected evidence: $result"
[[ "$(cut -f1 "$SQLITE_CALLS")" == "$SQLITE_FILE" ]] || fail "sqlite seam did not receive the database path"
[[ "$(cut -f2- "$SQLITE_CALLS")" == 'SELECT max("day") FROM "token_usage_daily"' ]] ||
	fail "sqlite seam received an unapproved query: $(cut -f2- "$SQLITE_CALLS")"

printf 'ok - sqlite probe derives freshness from one fixed max-column query\n'

assert_sqlite_probe() {
	local name="$1" path="$2" output="$3" mode="$4" expected="$5" actual
	SQLITE_OUTPUT="$output"
	SQLITE_MODE="$mode"
	actual="$(_af_probe_sqlite "$path" token_usage_daily day 36)" ||
		fail "$name probe does not return a verdict"
	[[ "$actual" == "$expected" ]] || fail "$name expected [$expected], got [$actual]"
}

assert_sqlite_probe missing-db "$TASK_TMP_DIR/no.sqlite" 2026-09-04 ok $'missing\tnone\tn/a\tmissing'
assert_sqlite_probe empty-table "$SQLITE_FILE" '' ok $'missing\tnone\tn/a\tempty'
assert_sqlite_probe invalid-date "$SQLITE_FILE" yesterday ok $'undetermined\tnone\tn/a\tinvalid_date'
assert_sqlite_probe multiple-lines "$SQLITE_FILE" $'2026-09-04\n2026-09-03' ok $'undetermined\tnone\tn/a\tnon_scalar'
assert_sqlite_probe multiple-columns "$SQLITE_FILE" $'2026-09-04\textra' ok $'undetermined\tnone\tn/a\tnon_scalar'
SQLITE_RC=124
assert_sqlite_probe timeout "$SQLITE_FILE" '' fail $'undetermined\tnone\tn/a\tquery_failed_124'
SQLITE_RC=1
assert_sqlite_probe query-error "$SQLITE_FILE" '' fail $'undetermined\tnone\tn/a\tquery_failed_1'
assert_sqlite_probe iso-date "$SQLITE_FILE" 2026-09-03T23:00:00Z ok $'fresh\t2026-09-03T23:00:00Z\t1.0\tok'
assert_sqlite_probe epoch-seconds "$SQLITE_FILE" "$NOW" ok $'fresh\t1788480000\t0.0\tok'
assert_sqlite_probe stale-date "$SQLITE_FILE" 2026-09-02 ok $'stale\t2026-09-02\t48.0\tok'

printf 'ok - sqlite probe distinguishes missing, unreadable, non-scalar, invalid, and stale outputs\n'

GIT_REPO="$TASK_TMP_DIR/repo"
mkdir -p "$GIT_REPO/.git"
LOCAL_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
REMOTE_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
GIT_SCENARIO=equal
GIT_OLDEST=$((NOW - 3600))
GIT_CALLS="$TASK_TMP_DIR/git.calls"
: >"$GIT_CALLS"
_af_remote_head() {
	printf 'remote-head\t%s\n' "$1" >>"$GIT_CALLS"
	[[ "$GIT_SCENARIO" != remote-fail ]] || return 1
	printf '%s\n' "$REMOTE_SHA"
}
_af_git() {
	local repo="$1"
	shift
	printf '%s\t%s\n' "$repo" "$*" >>"$GIT_CALLS"
	case "$1 $2" in
		'remote get-url') [[ "$GIT_SCENARIO" != no-origin ]] || return 2; printf 'fixture-origin\n' ;;
		'rev-parse HEAD') printf '%s\n' "$LOCAL_SHA" ;;
		'cat-file -e') [[ "$GIT_SCENARIO" != remote-object-missing ]] ;;
		'merge-base --is-ancestor')
			[[ "$GIT_SCENARIO" != ancestry-error ]] || return 2
			if [[ "$3" == "$LOCAL_SHA" ]]; then
				[[ "$GIT_SCENARIO" == remote-ahead ]] && return 0
				return 1
			fi
			[[ "$GIT_SCENARIO" == local-ahead ]] && return 0
			return 1
			;;
		'log --format=%ct') printf '%s\n' "$GIT_OLDEST" ;;
		*) return 2 ;;
	esac
}

assert_git_probe() {
	local name="$1" repo="$2" scenario="$3" max_age="$4" expected="$5" actual
	GIT_SCENARIO="$scenario"
	actual="$(_af_probe_git "$repo" "$max_age")" || fail "$name probe does not return a verdict"
	[[ "$actual" == "$expected" ]] || fail "$name expected [$expected], got [$actual]"
}

REMOTE_SHA="$LOCAL_SHA"
assert_git_probe equal "$GIT_REPO" equal 48 $'fresh\t'"${LOCAL_SHA}"$'\t0.0\tequal'
REMOTE_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
assert_git_probe missing-repo "$TASK_TMP_DIR/no-repo" equal 48 $'missing\tnone\tn/a\tmissing_repo'
assert_git_probe no-origin "$GIT_REPO" no-origin 48 $'missing\tnone\tn/a\tno_origin'
assert_git_probe remote-ahead "$GIT_REPO" remote-ahead 48 $'fresh\tbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\t0.0\tremote_ahead'
GIT_OLDEST=$((NOW - 3600))
assert_git_probe local-ahead-fresh "$GIT_REPO" local-ahead 48 $'fresh\tbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\t1.0\tlocal_ahead'
GIT_OLDEST=$((NOW - 49 * 3600))
assert_git_probe local-ahead-stale "$GIT_REPO" local-ahead 48 $'stale\tbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\t49.0\tlocal_ahead'
assert_git_probe diverged-stale "$GIT_REPO" diverged 48 $'stale\tbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\t49.0\tdiverged'
assert_git_probe remote-object-missing "$GIT_REPO" remote-object-missing 48 $'undetermined\tbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tn/a\tremote_object_missing'
assert_git_probe remote-failure "$GIT_REPO" remote-fail 48 $'undetermined\tnone\tn/a\tremote_failed_1'
assert_git_probe ancestry-failure "$GIT_REPO" ancestry-error 48 $'undetermined\tbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tn/a\tancestry_failed'

if grep -Eq 'git[[:space:]]+fetch|launchctl|chezmoi|[.]log|runs[.]tsv' "$OBSERVER"; then
	fail "observer source contains a forbidden run/log/status signal"
fi
if grep -Fq 'fetch' "$GIT_CALLS"; then fail "git probe attempted to fetch remote objects"; fi

printf 'ok - git probe judges remote delivery topology without mutating the repository\n'

NOW_ISO=2026-09-04T00:00:00Z
_af_now_iso() { printf '%s\n' "$NOW_ISO"; }
POSTS="$TASK_TMP_DIR/posts.tsv"
: >"$POSTS"
POST_FAIL=0
_af_post() {
	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >>"$POSTS"
	[[ "$POST_FAIL" != 1 ]]
}

AF_HOME="$TASK_TMP_DIR/home"
mkdir -p "$AF_HOME"
printf 'heartbeat\n' >"$AF_HOME/output"
HOME="$AF_HOME"
FLYWHEEL_STATE_DIR="$TASK_TMP_DIR/state-root"
STAT_MODE=ok
STAT_MTIME=$NOW
ONE_REGISTRY="$TASK_TMP_DIR/one.manifest"
printf '%s\n' $'one-output\tfile_mtime\t$HOME/output\t1\tactive\tnone\tone output' >"$ONE_REGISTRY"

af_main --registry "$ONE_REGISTRY" >/dev/null || fail "one-row fresh observation succeeds"
AF_STATE_DIR="$FLYWHEEL_STATE_DIR/state/artifact-freshness"
[[ ! -s "$POSTS" ]] || fail "fresh first observation posts an incident"
[[ "$(wc -l <"$AF_STATE_DIR/checks.tsv" | tr -d ' ')" -eq 2 ]] ||
	fail "fresh observation does not append exactly one ledger row"
jq -e '
  .schema == 1 and
  (.run_id | test("^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$")) and
  .observed_at == "2026-09-04T00:00:00Z" and
  .rows == 1 and
  .counts == {fresh:1,stale:0,missing:0,undetermined:0,suspended:0} and
  .unobservable_active == 0 and .post_status == "none" and .run_status == "ok"
' "$AF_STATE_DIR/last-run.json" >/dev/null || fail "fresh receipt is not a complete run marker"
jq -e '
  .schema == 1 and
  .episodes["one-output"].incident == {active:false,lastNotifiedAt:null} and
  .episodes["one-output"].unobservable == {active:false,lastNotifiedAt:null,streak:0}
' "$AF_STATE_DIR/state.json" >/dev/null || fail "fresh observation does not initialize both episode books"

printf 'ok - observer commits state, one ledger row, and a bound receipt for a fresh round\n'

STAT_MTIME=$((NOW - 2 * 3600))
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "stale observation succeeds"
[[ "$(wc -l <"$POSTS" | tr -d ' ')" -eq 1 ]] || fail "stale episode did not post exactly once"
[[ "$(cut -f1-3 "$POSTS")" == $'one-output\tincident\tenter' ]] || fail "stale episode did not enter"
jq -e '.episodes["one-output"].incident == {active:true,lastNotifiedAt:1788480000}' \
	"$AF_STATE_DIR/state.json" >/dev/null || fail "successful incident enter was not persisted"

NOW=$((NOW + 23 * 3600))
NOW_ISO=2026-09-04T23:00:00Z
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "stale observation inside reminder window succeeds"
[[ "$(wc -l <"$POSTS" | tr -d ' ')" -eq 1 ]] || fail "incident re-posted inside 24 hours"

NOW=$((NOW + 3600))
NOW_ISO=2026-09-05T00:00:00Z
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "stale observation at reminder boundary succeeds"
[[ "$(tail -1 "$POSTS" | cut -f1-3)" == $'one-output\tincident\trenotify' ]] ||
	fail "incident did not renotify at 24 hours"

NOW=$((NOW + 1))
NOW_ISO=2026-09-05T00:00:01Z
STAT_MTIME=$NOW
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "fresh recovery observation succeeds"
[[ "$(tail -1 "$POSTS" | cut -f1-3)" == $'one-output\tincident\trecover' ]] ||
	fail "fresh artifact did not recover its incident"
jq -e '.episodes["one-output"].incident == {active:false,lastNotifiedAt:null}' \
	"$AF_STATE_DIR/state.json" >/dev/null || fail "successful recovery did not clear incident state"

printf 'ok - incident episode enters once, renotifies at 24h, and clears only on fresh recovery\n'

INVALID_ROOT="$TASK_TMP_DIR/invalid-root"
INVALID_DIR="$INVALID_ROOT/state/artifact-freshness"
mkdir -p "$INVALID_DIR"
chmod 700 "$INVALID_DIR"
printf '%s\n' '{"schema":2,"episodes":{}}' >"$INVALID_DIR/state.json"
printf '%s\n' "$AF_HEADER" >"$INVALID_DIR/checks.tsv"
printf '%s\n' '{"old":"receipt"}' >"$INVALID_DIR/last-run.json"
INVALID_STATE_BEFORE="$(hash_file "$INVALID_DIR/state.json")"
INVALID_CHECKS_BEFORE="$(hash_file "$INVALID_DIR/checks.tsv")"
INVALID_RECEIPT_BEFORE="$(hash_file "$INVALID_DIR/last-run.json")"
PROBE_CALLS="$TASK_TMP_DIR/probe.calls"
: >"$PROBE_CALLS"
_af_stat() {
	printf 'probe\n' >>"$PROBE_CALLS"
	printf '%s\n' "$STAT_MTIME"
}
FLYWHEEL_STATE_DIR="$INVALID_ROOT"
set +e
af_main --registry "$ONE_REGISTRY" >/dev/null 2>&1
invalid_rc=$?
set -e
[[ "$invalid_rc" -eq 9 ]] || fail "invalid state schema returned $invalid_rc instead of 9"
[[ ! -s "$PROBE_CALLS" ]] || fail "observer probed an artifact before rejecting invalid state"
[[ "$(hash_file "$INVALID_DIR/state.json")" == "$INVALID_STATE_BEFORE" ]] || fail "invalid state was overwritten"
[[ "$(hash_file "$INVALID_DIR/checks.tsv")" == "$INVALID_CHECKS_BEFORE" ]] || fail "ledger changed after invalid state"
[[ "$(hash_file "$INVALID_DIR/last-run.json")" == "$INVALID_RECEIPT_BEFORE" ]] || fail "receipt changed after invalid state"

printf 'ok - sink preflight rejects invalid state before any probe, post, or write\n'

expect_invalid_state() {
	local name="$1" json="$2" before probe_count posts_count
	printf '%s\n' "$json" >"$INVALID_DIR/state.json"
	printf '%s\n' "$AF_HEADER" >"$INVALID_DIR/checks.tsv"
	printf '%s\n' '{"old":"receipt"}' >"$INVALID_DIR/last-run.json"
	before="$(hash_file "$INVALID_DIR/state.json")"
	probe_count="$(wc -l <"$PROBE_CALLS" | tr -d ' ')"
	posts_count="$(wc -l <"$POSTS" | tr -d ' ')"
	set +e
	af_main --registry "$ONE_REGISTRY" >/dev/null 2>&1
	local status=$?
	set -e
	[[ "$status" -eq 9 ]] || fail "$name state returned $status instead of 9"
	[[ "$(hash_file "$INVALID_DIR/state.json")" == "$before" ]] || fail "$name state was overwritten"
	[[ "$(wc -l <"$PROBE_CALLS" | tr -d ' ')" -eq "$probe_count" ]] || fail "$name state reached a probe"
	[[ "$(wc -l <"$POSTS" | tr -d ' ')" -eq "$posts_count" ]] || fail "$name state reached a post"
}

expect_invalid_state active-not-boolean '{"schema":1,"episodes":{"one-output":{"incident":{"active":"yes","lastNotifiedAt":null},"unobservable":{"active":false,"lastNotifiedAt":null,"streak":0}}}}'
expect_invalid_state future-notification '{"schema":1,"episodes":{"one-output":{"incident":{"active":true,"lastNotifiedAt":1788566702},"unobservable":{"active":false,"lastNotifiedAt":null,"streak":0}}}}'
expect_invalid_state negative-streak '{"schema":1,"episodes":{"one-output":{"incident":{"active":false,"lastNotifiedAt":null},"unobservable":{"active":false,"lastNotifiedAt":null,"streak":-1}}}}'
expect_invalid_state active-without-time '{"schema":1,"episodes":{"one-output":{"incident":{"active":true,"lastNotifiedAt":null},"unobservable":{"active":false,"lastNotifiedAt":null,"streak":0}}}}'
expect_invalid_state inactive-with-time '{"schema":1,"episodes":{"one-output":{"incident":{"active":false,"lastNotifiedAt":1788566401},"unobservable":{"active":false,"lastNotifiedAt":null,"streak":0}}}}'
expect_invalid_state premature-unobservable '{"schema":1,"episodes":{"one-output":{"incident":{"active":false,"lastNotifiedAt":null},"unobservable":{"active":true,"lastNotifiedAt":1788566401,"streak":1}}}}'
expect_invalid_state one-book-only '{"schema":1,"episodes":{"one-output":{"incident":{"active":false,"lastNotifiedAt":null}}}}'

printf '%s\n' '{"schema":1,"episodes":{}}' >"$INVALID_DIR/state.json"
printf 'wrong-header\n' >"$INVALID_DIR/checks.tsv"
: >"$PROBE_CALLS"
set +e
af_main --registry "$ONE_REGISTRY" >/dev/null 2>&1
bad_header_rc=$?
set -e
[[ "$bad_header_rc" -eq 9 && ! -s "$PROBE_CALLS" ]] || fail "bad ledger header was not rejected before probing"

printf 'ok - state invariants and the fixed ledger header fail closed\n'

UNOBS_ROOT="$TASK_TMP_DIR/unobservable-root"
FLYWHEEL_STATE_DIR="$UNOBS_ROOT"
: >"$POSTS"
: >"$PROBE_CALLS"
STAT_MODE=fail
_af_stat() {
	printf 'probe\n' >>"$PROBE_CALLS"
	[[ "$STAT_MODE" == ok ]] || return 1
	printf '%s\n' "$STAT_MTIME"
}
NOW=1788652800
NOW_ISO=2026-09-06T00:00:00Z
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "first undetermined observation succeeds"
UNOBS_DIR="$UNOBS_ROOT/state/artifact-freshness"
[[ ! -s "$POSTS" ]] || fail "single undetermined observation posted"
jq -e '.episodes["one-output"].incident.active == false and .episodes["one-output"].unobservable == {active:false,lastNotifiedAt:null,streak:1}' \
	"$UNOBS_DIR/state.json" >/dev/null || fail "first undetermined streak was not persisted independently"

NOW=$((NOW + 3600))
NOW_ISO=2026-09-06T01:00:00Z
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "second undetermined observation succeeds"
[[ "$(tail -1 "$POSTS" | cut -f1-3)" == $'one-output\tunobservable\tenter' ]] || fail "second undetermined observation did not enter"
jq -e '.episodes["one-output"].incident.active == false and .episodes["one-output"].unobservable == {active:true,lastNotifiedAt:1788656400,streak:2}' \
	"$UNOBS_DIR/state.json" >/dev/null || fail "unobservable episode was not persisted"
jq -e '.unobservable_active == 1 and .post_status == "success" and .run_status == "degraded"' \
	"$UNOBS_DIR/last-run.json" >/dev/null || fail "unobservable episode did not degrade the receipt"

STAT_MODE=ok
STAT_MTIME=$((NOW + 1))
NOW=$((NOW + 1))
NOW_ISO=2026-09-06T01:00:01Z
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "observable recovery succeeds"
[[ "$(tail -1 "$POSTS" | cut -f1-3)" == $'one-output\tunobservable\trecover' ]] || fail "observable result did not recover unobservable episode"
jq -e '.episodes["one-output"].unobservable == {active:false,lastNotifiedAt:null,streak:0}' \
	"$UNOBS_DIR/state.json" >/dev/null || fail "unobservable recovery did not clear its streak"

printf 'ok - unobservable book pages only after two rounds and cannot alter the incident book\n'

STATUS_LOCK="$TASK_TMP_DIR/status-lock"
lm_lock_acquire "$STATUS_LOCK" || fail "status test acquires a live state lock"
STATUS_STATE_BEFORE="$(hash_file "$UNOBS_DIR/state.json")"
STATUS_POSTS_BEFORE="$(wc -l <"$POSTS" | tr -d ' ')"
STATUS_OUTPUT="$(af_main --registry "$ONE_REGISTRY" --status)" || {
	lm_lock_release >/dev/null 2>&1 || true
	fail "status mode succeeds while the writer lock is held"
}
lm_lock_release || fail "status test releases its live state lock"
[[ "$STATUS_OUTPUT" == $'one-output\tfile_mtime\tfresh\t1788656401\t0.0\t1\tactive\tnone\tok' ]] ||
	fail "status output does not expose the current artifact verdict: $STATUS_OUTPUT"
[[ "$(hash_file "$UNOBS_DIR/state.json")" == "$STATUS_STATE_BEFORE" ]] || fail "status mode changed state bytes"
[[ "$(wc -l <"$POSTS" | tr -d ' ')" -eq "$STATUS_POSTS_BEFORE" ]] || fail "status mode posted"

printf 'ok - status mode remains read-only even while an observation lock is held\n'

POST_FAIL_ROOT="$TASK_TMP_DIR/post-fail-root"
FLYWHEEL_STATE_DIR="$POST_FAIL_ROOT"
: >"$POSTS"
POST_FAIL=1
STAT_MODE=ok
STAT_MTIME=$((NOW - 2 * 3600))
set +e
af_main --registry "$ONE_REGISTRY" >/dev/null
post_fail_rc=$?
set -e
[[ "$post_fail_rc" -eq 10 ]] || fail "failed incident delivery returned $post_fail_rc instead of 10"
POST_FAIL_DIR="$POST_FAIL_ROOT/state/artifact-freshness"
jq -e '.episodes["one-output"].incident == {active:false,lastNotifiedAt:null}' \
	"$POST_FAIL_DIR/state.json" >/dev/null || fail "failed incident enter was marked delivered"
jq -e '.post_status == "failed" and .run_status == "degraded"' \
	"$POST_FAIL_DIR/last-run.json" >/dev/null || fail "failed post did not degrade the receipt"
[[ "$(tail -1 "$POST_FAIL_DIR/checks.tsv" | cut -f12)" == failed ]] || fail "failed post was absent from ledger"

POST_FAIL=0
NOW=$((NOW + 1))
NOW_ISO=2026-09-06T01:00:02Z
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "incident retries after delivery recovers"
[[ "$(tail -1 "$POSTS" | cut -f1-3)" == $'one-output\tincident\tenter' ]] || fail "failed enter was not retried"
jq -e '.episodes["one-output"].incident.active == true' "$POST_FAIL_DIR/state.json" >/dev/null ||
	fail "retried incident enter was not persisted"

printf 'ok - failed delivery is recorded as degraded and never advances episode time\n'

CRASH_ROOT="$TASK_TMP_DIR/crash-root"
FLYWHEEL_STATE_DIR="$CRASH_ROOT"
: >"$POSTS"
_af_write_json() { return 1; }
set +e
af_main --registry "$ONE_REGISTRY" >/dev/null 2>&1
crash_rc=$?
set -e
[[ "$crash_rc" -eq 9 ]] || fail "state commit injection returned $crash_rc instead of 9"
[[ "$(wc -l <"$POSTS" | tr -d ' ')" -eq 1 ]] || fail "state commit injection did not occur after one successful post"
[[ ! -e "$CRASH_ROOT/state/artifact-freshness/state.json" ]] || fail "failed state commit published state bytes"
[[ ! -e "$CRASH_ROOT/state/artifact-freshness/last-run.json" ]] || fail "failed state commit published a receipt"

printf 'ok - a state commit failure wins with status 9 and leaves no false receipt\n'

_af_write_json() { lm_write_json_atomic "$1"; }
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "round after state commit failure succeeds"
[[ "$(wc -l <"$POSTS" | tr -d ' ')" -eq 2 ]] || fail "round after state commit failure did not retry its enter"

APPEND_ROOT="$TASK_TMP_DIR/append-root"
FLYWHEEL_STATE_DIR="$APPEND_ROOT"
: >"$POSTS"
_af_append_tsv() { return 1; }
set +e
af_main --registry "$ONE_REGISTRY" >/dev/null 2>&1
append_rc=$?
set -e
[[ "$append_rc" -eq 9 ]] || fail "ledger append injection returned $append_rc instead of 9"
APPEND_DIR="$APPEND_ROOT/state/artifact-freshness"
jq -e '.episodes["one-output"].incident.active == true' "$APPEND_DIR/state.json" >/dev/null ||
	fail "state was not committed before the ledger failure"
[[ ! -e "$APPEND_DIR/last-run.json" ]] || fail "ledger failure published a false receipt"
[[ "$(wc -l <"$POSTS" | tr -d ' ')" -eq 1 ]] || fail "ledger failure did not post exactly once"

_af_append_tsv() { lm_append_tsv "$1" "$2" "$3"; }
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "round after ledger failure succeeds"
[[ "$(wc -l <"$POSTS" | tr -d ' ')" -eq 1 ]] || fail "round after committed state re-posted its incident"

RECEIPT_ROOT="$TASK_TMP_DIR/receipt-root"
FLYWHEEL_STATE_DIR="$RECEIPT_ROOT"
: >"$POSTS"
_af_write_json() {
	[[ "$1" != */last-run.json ]] || return 1
	lm_write_json_atomic "$1"
}
set +e
af_main --registry "$ONE_REGISTRY" >/dev/null 2>&1
receipt_rc=$?
set -e
[[ "$receipt_rc" -eq 9 ]] || fail "receipt commit injection returned $receipt_rc instead of 9"
RECEIPT_DIR="$RECEIPT_ROOT/state/artifact-freshness"
[[ -f "$RECEIPT_DIR/state.json" && -f "$RECEIPT_DIR/checks.tsv" ]] ||
	fail "receipt failure lost earlier state or ledger commits"
[[ ! -e "$RECEIPT_DIR/last-run.json" ]] || fail "receipt failure published a receipt"

PRECEDENCE_ROOT="$TASK_TMP_DIR/precedence-root"
FLYWHEEL_STATE_DIR="$PRECEDENCE_ROOT"
POST_FAIL=1
_af_write_json() { lm_write_json_atomic "$1"; }
_af_append_tsv() { return 1; }
set +e
af_main --registry "$ONE_REGISTRY" >/dev/null 2>&1
precedence_rc=$?
set -e
[[ "$precedence_rc" -eq 9 ]] || fail "IO failure did not take precedence over delivery status 10"
POST_FAIL=0
_af_append_tsv() { lm_append_tsv "$1" "$2" "$3"; }

printf 'ok - crash windows preserve ordering and status 9 takes precedence over delivery failure\n'

SUSPEND_ROOT="$TASK_TMP_DIR/suspend-root"
FLYWHEEL_STATE_DIR="$SUSPEND_ROOT"
: >"$POSTS"
STAT_MTIME=$((NOW - 2 * 3600))
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "active incident before suspension succeeds"
SUSPENDED_REGISTRY="$TASK_TMP_DIR/suspended.manifest"
printf '%s\n' $'one-output\tfile_mtime\t$HOME/output\t1\tsuspended\tnone\tFLY-999 intentional pause' >"$SUSPENDED_REGISTRY"
posts_before_suspend="$(wc -l <"$POSTS" | tr -d ' ')"
af_main --registry "$SUSPENDED_REGISTRY" >/dev/null || fail "suspended observation succeeds"
SUSPEND_DIR="$SUSPEND_ROOT/state/artifact-freshness"
[[ "$(wc -l <"$POSTS" | tr -d ' ')" -eq "$posts_before_suspend" ]] || fail "suspension posted a transition"
jq -e '.episodes["one-output"] == {incident:{active:false,lastNotifiedAt:null},unobservable:{active:false,lastNotifiedAt:null,streak:0}}' \
	"$SUSPEND_DIR/state.json" >/dev/null || fail "suspension did not silently close both books"
jq -e '.counts.suspended == 1 and ([.counts[]] | add) == .rows' "$SUSPEND_DIR/last-run.json" >/dev/null ||
	fail "suspended row was not counted exactly once"

STAT_MTIME=$NOW
status_suspended="$(af_main --registry "$SUSPENDED_REGISTRY" --status)" || fail "suspended status succeeds"
[[ "$status_suspended" == *$'\tsuspended(FLY-999 intentional pause)\tnone\tok,suspended-but-fresh' ]] ||
	fail "suspended fresh status lacks its explicit reason marker: $status_suspended"

printf 'ok - suspended rows remain observable but never page or preserve an active episode\n'

REMOVAL_ROOT="$TASK_TMP_DIR/removal-root"
REMOVAL_DIR="$REMOVAL_ROOT/state/artifact-freshness"
mkdir -p "$REMOVAL_DIR"
chmod 700 "$REMOVAL_DIR"
printf '%s\n' '{"schema":1,"episodes":{"one-output":{"incident":{"active":false,"lastNotifiedAt":null},"unobservable":{"active":false,"lastNotifiedAt":null,"streak":0}},"removed-output":{"incident":{"active":true,"lastNotifiedAt":1788656401},"unobservable":{"active":false,"lastNotifiedAt":null,"streak":0}}}}' >"$REMOVAL_DIR/state.json"
FLYWHEEL_STATE_DIR="$REMOVAL_ROOT"
: >"$POSTS"
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "observation after registry row removal succeeds"
jq -e '.episodes | keys == ["one-output"]' "$REMOVAL_DIR/state.json" >/dev/null || fail "removed registry row retained episode state"
[[ ! -s "$POSTS" ]] || fail "removed registry row emitted a recovery post"

printf 'ok - deleting a registry row drops both books without inventing recovery evidence\n'

LOCK_ROOT="$TASK_TMP_DIR/lock-root"
LOCK_DIR="$LOCK_ROOT/state/artifact-freshness"
mkdir -p "$LOCK_DIR/lock"
chmod 700 "$LOCK_DIR"
printf '%s\n' "$$" >"$LOCK_DIR/lock/pid"
FLYWHEEL_STATE_DIR="$LOCK_ROOT"
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "live observer lock returns the normal skip status"
[[ ! -e "$LOCK_DIR/state.json" && ! -e "$LOCK_DIR/last-run.json" ]] || fail "live lock skip wrote state"
printf '99999999\n' >"$LOCK_DIR/lock/pid"
af_main --registry "$ONE_REGISTRY" >/dev/null || fail "dead observer lock is reclaimed"
[[ ! -e "$LOCK_DIR/lock" ]] || fail "reclaimed observer lock remained after completion"

printf 'ok - live locks skip and dead locks are reclaimed without leaking ownership\n'

FINAL_RECEIPT="$LOCK_DIR/last-run.json"
FINAL_CHECK="$(tail -1 "$LOCK_DIR/checks.tsv")"
[[ "$(printf '%s\n' "$FINAL_CHECK" | cut -f2)" == "$(jq -r .run_id "$FINAL_RECEIPT")" ]] ||
	fail "ledger row and receipt use different run ids"
[[ "$(jq -r .registry_sha256 "$FINAL_RECEIPT")" == "$(hash_file "$ONE_REGISTRY")" ]] ||
	fail "receipt does not bind the registry bytes"
[[ "$(lm_file_mode "$LOCK_DIR/state.json")" == 600 && "$(lm_file_mode "$LOCK_DIR/checks.tsv")" == 600 && "$(lm_file_mode "$FINAL_RECEIPT")" == 600 ]] ||
	fail "observer sinks are not mode 0600"

printf 'ok - ledger and receipt bind one run and all durable sinks are private\n'
