#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$REPO_ROOT/scripts/lead-memory/arrival-check.sh"
COMMON_SOURCE="$REPO_ROOT/scripts/lead-memory/lib/sync-common.sh"
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly2146-arrival.XXXXXX")"
trap 'rm -rf -- "$TASK_TMP_DIR"' EXIT

PASSED=0
pass() { PASSED=$((PASSED + 1)); printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }

replace_constant_once() {
	python3 - "$1" "$2" "$3" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
pattern = re.compile(rf"^{re.escape(sys.argv[2])}=.*$", re.MULTILINE)
text = path.read_text()
if len(pattern.findall(text)) != 1:
    raise SystemExit(f"{sys.argv[2]} must have exactly one declaration")
path.write_text(pattern.sub(lambda _: f"{sys.argv[2]}={sys.argv[3]}", text))
PY
}

test -x "$SOURCE" || fail "arrival observer exists and is executable"

FIXTURE="$TASK_TMP_DIR/flywheel"
MEMORY="$TASK_TMP_DIR/memory"
ORIGIN="$TASK_TMP_DIR/origin.git"
mkdir -p "$FIXTURE/scripts/lead-memory/lib" "$FIXTURE/scripts/lib"
cp "$SOURCE" "$FIXTURE/scripts/lead-memory/arrival-check.sh"
cp "$COMMON_SOURCE" "$FIXTURE/scripts/lead-memory/lib/sync-common.sh"
cp "$REPO_ROOT/scripts/lib/bounded-run.sh" "$FIXTURE/scripts/lib/bounded-run.sh"
chmod 755 "$FIXTURE/scripts/lead-memory/arrival-check.sh" "$FIXTURE/scripts/lib/bounded-run.sh"
git init -q --bare --initial-branch=main "$ORIGIN"
git init -q -b main "$MEMORY"
git -C "$MEMORY" config user.name "FLY-2146 Arrival Test"
git -C "$MEMORY" config user.email "fly2146-arrival@example.test"
git -C "$MEMORY" remote add origin "$ORIGIN"
mkdir -p "$MEMORY/alpha-lead"
cp "$REPO_ROOT/scripts/lead-memory/repo-template/.gitignore" "$MEMORY/.gitignore"
printf 'fresh\n' >"$MEMORY/alpha-lead/MEMORY.md"
git -C "$MEMORY" add -A
git -C "$MEMORY" commit -q -m initial
git -C "$MEMORY" push -q -u origin main
replace_constant_once "$FIXTURE/scripts/lead-memory/lib/sync-common.sh" REMOTE_URL "$ORIGIN"
replace_constant_once "$FIXTURE/scripts/lead-memory/lib/sync-common.sh" MEMORY_PATH "$MEMORY"

HARNESS="$TASK_TMP_DIR/run-arrival.sh"
cat >"$HARNESS" <<'HARNESS'
#!/usr/bin/env bash
set -u
. "$1"
_arrival_now_epoch() {
  test "${TEST_NOW_MODE:-ok}" = ok || return 1
  printf '%s\n' "${TEST_NOW_EPOCH:?}"
}
_arrival_now_iso() { printf '%s\n' "${TEST_NOW_ISO:?}"; }
_arrival_remote_head() {
  test "${TEST_REMOTE_MODE:-ok}" = ok || return 1
  printf '%s\n' "${TEST_REMOTE_SHA:?}"
}
_arrival_remote_date() {
  test "${TEST_REMOTE_DATE_MODE:-ok}" = ok || return 1
  printf '%s\n' "${TEST_REMOTE_DATE:-2026-09-04T00:00:00Z}"
}
_arrival_post() {
  printf '%s\t%s\n' "$1" "$2" >>"${TEST_POSTS:?}"
  test "${TEST_POST_FAIL:-0}" != 1
}
arrival_main
HARNESS
chmod 755 "$HARNESS"

NOW=1788480000
NOW_ISO=2026-09-04T00:00:00Z
REMOTE_SHA="$(git -C "$MEMORY" rev-parse HEAD)"
make_receipt() {
	local state="$1" epoch="$2"
	mkdir -p "$state/state/lead-memory/sync"
	printf '{"schema":1,"finished_at":"2026-09-04T00:00:00Z"}\n' \
		>"$state/state/lead-memory/sync/last-receipt.json"
	python3 - "$state/state/lead-memory/sync/last-receipt.json" "$epoch" <<'PY'
import os
import sys
os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))
PY
}

FRESH_STATE="$TASK_TMP_DIR/fresh-state"
FRESH_POSTS="$TASK_TMP_DIR/fresh.posts"
: >"$FRESH_POSTS"
make_receipt "$FRESH_STATE" "$NOW"
env FLYWHEEL_STATE_DIR="$FRESH_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$FRESH_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "fresh arrival observation succeeds"
test ! -s "$FRESH_POSTS" || fail "fresh arrival observation posts an incident"
CHECKS="$FRESH_STATE/state/lead-memory/arrival/checks.tsv"
test "$(wc -l <"$CHECKS" | tr -d ' ')" = 2 || fail "fresh observation does not append one check"
tail -1 "$CHECKS" | grep -Fq $'\tfresh\t' || fail "fresh observation is not recorded as fresh"
pass "observer records a fresh remote-backed heartbeat without posting"

DATE_FAIL_STATE="$TASK_TMP_DIR/date-fail-state"
DATE_FAIL_POSTS="$TASK_TMP_DIR/date-fail.posts"
: >"$DATE_FAIL_POSTS"
make_receipt "$DATE_FAIL_STATE" "$NOW"
env FLYWHEEL_STATE_DIR="$DATE_FAIL_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_REMOTE_DATE_MODE=fail TEST_POSTS="$DATE_FAIL_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "remote metadata failure does not preserve the successful remote-head observation"
test ! -s "$DATE_FAIL_POSTS" || fail "remote metadata failure opens a false remote-unreachable episode"
DATE_FAIL_ROW="$(tail -1 "$DATE_FAIL_STATE/state/lead-memory/arrival/checks.tsv")"
test "$(printf '%s\n' "$DATE_FAIL_ROW" | awk -F '\t' '{print $3}')" = "$REMOTE_SHA" ||
	fail "remote metadata failure loses the independently observed remote head"
test "$(printf '%s\n' "$DATE_FAIL_ROW" | awk -F '\t' '{print $4}')" = undetermined ||
	fail "remote metadata failure invents a commit date"
test "$(printf '%s\n' "$DATE_FAIL_ROW" | awk -F '\t' '{print $11}')" = fresh ||
	fail "remote metadata failure hides a fresh delivery verdict"
pass "observer derives remote availability from ls-remote, not optional commit metadata"

IGNORED_STATE="$TASK_TMP_DIR/ignored-state"
IGNORED_POSTS="$TASK_TMP_DIR/ignored.posts"
: >"$IGNORED_POSTS"
make_receipt "$IGNORED_STATE" "$NOW"
printf 'Finder metadata\n' >"$MEMORY/.DS_Store"
env FLYWHEEL_STATE_DIR="$IGNORED_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$IGNORED_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "observer rejects an ignored root metadata file"
test ! -s "$IGNORED_POSTS" || fail "ignored root metadata opens a structural episode"
test "$(tail -1 "$IGNORED_STATE/state/lead-memory/arrival/checks.tsv" | awk -F '\t' '{print $8}')" = 0 ||
	fail "ignored root metadata increments structural_count"
rm -f -- "$MEMORY/.DS_Store"
pass "observer excludes ignored Finder metadata from structural incidents"

TMP_FAIL_STATE="$TASK_TMP_DIR/tmp-fail-state"
TMP_FAIL_POSTS="$TASK_TMP_DIR/tmp-fail.posts"
: >"$TMP_FAIL_POSTS"
set +e
env FLYWHEEL_STATE_DIR="$TMP_FAIL_STATE" TEST_NOW_MODE=fail TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$TMP_FAIL_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null 2>&1
TMP_FAIL_RC=$?
set -e
test "$TMP_FAIL_RC" = 9 || fail "observer clock failure does not fail as evidence error 9"
test -z "$(find "$TMP_FAIL_STATE/state/lead-memory/arrival" -maxdepth 1 -type d -name 'run.*' -print -quit)" ||
	fail "observer failure leaks its private run directory"
test ! -s "$TMP_FAIL_POSTS" || fail "observer failure posts after aborting evidence collection"
pass "observer removes its private run directory on a failure path"

STALE_STATE="$TASK_TMP_DIR/stale-state"
STALE_POSTS="$TASK_TMP_DIR/stale.posts"
: >"$STALE_POSTS"
make_receipt "$STALE_STATE" "$NOW"
printf 'old pending\n' >>"$MEMORY/alpha-lead/MEMORY.md"
python3 - "$MEMORY/alpha-lead/MEMORY.md" "$((NOW - 30 * 3600))" <<'PY'
import os
import sys
os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))
PY
env FLYWHEEL_STATE_DIR="$STALE_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$STALE_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "stale arrival observation succeeds"
grep -Fxq $'stale\tenter' "$STALE_POSTS" || fail "30-hour Lead pending work does not open stale episode"
jq -e '.episodes.stale.active == true and .episodes.stale.lastNotifiedAt == 1788480000' \
	"$STALE_STATE/state/lead-memory/arrival/state.json" >/dev/null ||
	fail "stale episode state is not persisted after successful post"
pass "observer opens a stale episode only for old Lead delivery work"

STRUCTURAL_STATE="$TASK_TMP_DIR/structural-state"
STRUCTURAL_POSTS="$TASK_TMP_DIR/structural.posts"
: >"$STRUCTURAL_POSTS"
make_receipt "$STRUCTURAL_STATE" "$NOW"
git -C "$MEMORY" checkout -q -- alpha-lead/MEMORY.md
printf 'admin residue\n' >>"$MEMORY/README.md"
python3 - "$MEMORY/README.md" "$((NOW - 30 * 3600))" <<'PY'
import os
import sys
os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))
PY
env FLYWHEEL_STATE_DIR="$STRUCTURAL_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$STRUCTURAL_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "structural observation succeeds"
grep -Fxq $'structural\tenter' "$STRUCTURAL_POSTS" || fail "structural residue does not open its episode"
if grep -q '^stale' "$STRUCTURAL_POSTS"; then fail "top-level template residue incorrectly becomes stale"; fi
tail -1 "$STRUCTURAL_STATE/state/lead-memory/arrival/checks.tsv" | grep -Fq $'\t1\t' ||
	fail "structural count is absent from heartbeat"
pass "observer separates structural residue from delivery staleness"

DELETE_STATE="$TASK_TMP_DIR/delete-state"
DELETE_POSTS="$TASK_TMP_DIR/delete.posts"
: >"$DELETE_POSTS"
rm -f -- "$MEMORY/README.md"
git -C "$MEMORY" rm -q alpha-lead/MEMORY.md
make_receipt "$DELETE_STATE" "$NOW"
env FLYWHEEL_STATE_DIR="$DELETE_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$DELETE_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "first deletion observation succeeds"
test ! -s "$DELETE_POSTS" || fail "new deletion inherits an old mtime and opens stale immediately"
jq -e '.deletedFirstObserved["alpha-lead/MEMORY.md"] == 1788480000' \
	"$DELETE_STATE/state/lead-memory/arrival/state.json" >/dev/null ||
	fail "deletion first-observed identity is not persisted"
make_receipt "$DELETE_STATE" "$((NOW + 30 * 3600))"
env FLYWHEEL_STATE_DIR="$DELETE_STATE" TEST_NOW_EPOCH="$((NOW + 30 * 3600))" TEST_NOW_ISO=2026-09-05T06:00:00Z \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$DELETE_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "aged deletion observation succeeds"
grep -Fxq $'stale\tenter' "$DELETE_POSTS" || fail "deletion does not age from its first observation"
git -C "$MEMORY" reset -q -- alpha-lead/MEMORY.md
git -C "$MEMORY" checkout -q -- alpha-lead/MEMORY.md
pass "deleted memory ages from first observation, not the missing file mtime"

REMOTE_STATE="$TASK_TMP_DIR/remote-state"
REMOTE_POSTS="$TASK_TMP_DIR/remote.posts"
: >"$REMOTE_POSTS"
make_receipt "$REMOTE_STATE" "$NOW"
env FLYWHEEL_STATE_DIR="$REMOTE_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_MODE=fail TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$REMOTE_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "remote-unreachable observation still records operational evidence"
grep -Fxq $'remote_unreachable\tenter' "$REMOTE_POSTS" ||
	fail "remote read failure does not open remote_unreachable episode"
tail -1 "$REMOTE_STATE/state/lead-memory/arrival/checks.tsv" | grep -Fq $'\tundetermined\t' ||
	fail "remote read failure invents a local-ahead result"
pass "observer reports remote unreadability without trusting local state"

REMOTE_POST_FAIL_STATE="$TASK_TMP_DIR/remote-post-fail-state"
REMOTE_POST_FAIL_POSTS="$TASK_TMP_DIR/remote-post-fail.posts"
: >"$REMOTE_POST_FAIL_POSTS"
make_receipt "$REMOTE_POST_FAIL_STATE" "$NOW"
set +e
env FLYWHEEL_STATE_DIR="$REMOTE_POST_FAIL_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_MODE=fail TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$REMOTE_POST_FAIL_POSTS" TEST_POST_FAIL=1 \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null
REMOTE_POST_FAIL_RC=$?
set -e
test "$REMOTE_POST_FAIL_RC" = 10 ||
	fail "remote-unreachable notification failure does not surface as status 10"
tail -1 "$REMOTE_POST_FAIL_STATE/state/lead-memory/arrival/checks.tsv" | grep -Fq $'\tundetermined\t' ||
	fail "negative observer control invents remote truth"
tail -1 "$REMOTE_POST_FAIL_STATE/state/lead-memory/arrival/checks.tsv" | grep -Fq $'\tpost_status' &&
	fail "negative observer control appended a duplicate header"
test "$(tail -1 "$REMOTE_POST_FAIL_STATE/state/lead-memory/arrival/checks.tsv" | awk -F '\t' '{print $NF}')" = failed ||
	fail "negative observer control does not record post_status=failed"
jq -e '.episodes.remote_unreachable.active == true and .episodes.remote_unreachable.lastNotifiedAt == null' \
	"$REMOTE_POST_FAIL_STATE/state/lead-memory/arrival/state.json" >/dev/null ||
	fail "failed remote-unreachable notification is marked delivered"
pass "remote-unreachable negative control records undetermined and failed posting without a real message"

rm -f -- "$MEMORY/README.md"
UNFETCHED_STATE="$TASK_TMP_DIR/unfetched-state"
UNFETCHED_POSTS="$TASK_TMP_DIR/unfetched.posts"
: >"$UNFETCHED_POSTS"
make_receipt "$UNFETCHED_STATE" "$NOW"
UNKNOWN_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
env FLYWHEEL_STATE_DIR="$UNFETCHED_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_SHA="$UNKNOWN_SHA" TEST_POSTS="$UNFETCHED_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "first unfetched observation succeeds"
test ! -s "$UNFETCHED_POSTS" || fail "one missing remote object opens unfetched too early"
make_receipt "$UNFETCHED_STATE" "$((NOW + 3600))"
env FLYWHEEL_STATE_DIR="$UNFETCHED_STATE" TEST_NOW_EPOCH="$((NOW + 3600))" TEST_NOW_ISO=2026-09-04T01:00:00Z \
	TEST_REMOTE_SHA="$UNKNOWN_SHA" TEST_POSTS="$UNFETCHED_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "second unfetched observation succeeds"
grep -Fxq $'unfetched\tenter' "$UNFETCHED_POSTS" ||
	fail "two missing-object observations do not open unfetched"
pass "observer requires two consecutive remote-object misses before unfetched"

SILENT_STATE="$TASK_TMP_DIR/silent-state"
SILENT_POSTS="$TASK_TMP_DIR/silent.posts"
: >"$SILENT_POSTS"
env FLYWHEEL_STATE_DIR="$SILENT_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$SILENT_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "first silent-writer observation succeeds"
test ! -s "$SILENT_POSTS" || fail "one missing receipt opens writer_silent too early"
env FLYWHEEL_STATE_DIR="$SILENT_STATE" TEST_NOW_EPOCH="$((NOW + 3600))" TEST_NOW_ISO=2026-09-04T01:00:00Z \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$SILENT_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "second silent-writer observation succeeds"
grep -Fxq $'writer_silent\tenter' "$SILENT_POSTS" ||
	fail "two silent-writer observations do not open writer_silent"
pass "observer requires two consecutive silent-writer observations"

printf 'old pending\n' >>"$MEMORY/alpha-lead/MEMORY.md"
python3 - "$MEMORY/alpha-lead/MEMORY.md" "$((NOW - 30 * 3600))" <<'PY'
import os
import sys
os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))
PY
make_receipt "$STALE_STATE" "$((NOW + 3600))"
env FLYWHEEL_STATE_DIR="$STALE_STATE" TEST_NOW_EPOCH="$((NOW + 3600))" TEST_NOW_ISO=2026-09-04T01:00:00Z \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$STALE_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "ongoing stale observation succeeds"
test "$(grep -c '^stale' "$STALE_POSTS")" = 1 || fail "stale episode reposts before 24 hours"
make_receipt "$STALE_STATE" "$((NOW + 25 * 3600))"
env FLYWHEEL_STATE_DIR="$STALE_STATE" TEST_NOW_EPOCH="$((NOW + 25 * 3600))" TEST_NOW_ISO=2026-09-05T01:00:00Z \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$STALE_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "renotified stale observation succeeds"
grep -Fxq $'stale\trenotify' "$STALE_POSTS" || fail "stale episode does not renotify after 24 hours"
git -C "$MEMORY" checkout -q -- alpha-lead/MEMORY.md
make_receipt "$STALE_STATE" "$((NOW + 26 * 3600))"
env FLYWHEEL_STATE_DIR="$STALE_STATE" TEST_NOW_EPOCH="$((NOW + 26 * 3600))" TEST_NOW_ISO=2026-09-05T02:00:00Z \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$STALE_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "stale recovery observation succeeds"
grep -Fxq $'stale\trecover' "$STALE_POSTS" || fail "fresh remote-backed state does not recover stale"
jq -e '.episodes.stale.active == false and .episodes.stale.lastNotifiedAt == null' \
	"$STALE_STATE/state/lead-memory/arrival/state.json" >/dev/null || fail "stale recovery does not clear its episode"
pass "stale episodes deduplicate, renotify, and recover independently"

POST_FAIL_STATE="$TASK_TMP_DIR/post-fail-state"
POST_FAIL_POSTS="$TASK_TMP_DIR/post-fail.posts"
: >"$POST_FAIL_POSTS"
make_receipt "$POST_FAIL_STATE" "$NOW"
printf 'old again\n' >>"$MEMORY/alpha-lead/MEMORY.md"
python3 - "$MEMORY/alpha-lead/MEMORY.md" "$((NOW - 30 * 3600))" <<'PY'
import os
import sys
os.utime(sys.argv[1], (int(sys.argv[2]), int(sys.argv[2])))
PY
set +e
env FLYWHEEL_STATE_DIR="$POST_FAIL_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$POST_FAIL_POSTS" TEST_POST_FAIL=1 \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null
POST_FAIL_RC=$?
set -e
test "$POST_FAIL_RC" = 10 || fail "failed notification does not surface as status 10"
jq -e '.episodes.stale.active == true and .episodes.stale.lastNotifiedAt == null' \
	"$POST_FAIL_STATE/state/lead-memory/arrival/state.json" >/dev/null ||
	fail "failed notification is incorrectly recorded as delivered"
make_receipt "$POST_FAIL_STATE" "$((NOW + 3600))"
env FLYWHEEL_STATE_DIR="$POST_FAIL_STATE" TEST_NOW_EPOCH="$((NOW + 3600))" TEST_NOW_ISO=2026-09-04T01:00:00Z \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$POST_FAIL_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "notification retry succeeds"
test "$(grep -c $'^stale\tenter$' "$POST_FAIL_POSTS")" = 2 || fail "failed notification is not retried"
pass "episode notification state advances only after a successful post"

git -C "$MEMORY" checkout -q -- alpha-lead/MEMORY.md
LOCKED_STATE="$TASK_TMP_DIR/locked-state"
LOCKED_POSTS="$TASK_TMP_DIR/locked.posts"
mkdir -p "$LOCKED_STATE/state/lead-memory/arrival/lock"
printf '%s\n' "$$" >"$LOCKED_STATE/state/lead-memory/arrival/lock/pid"
: >"$LOCKED_POSTS"
env FLYWHEEL_STATE_DIR="$LOCKED_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$LOCKED_POSTS" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null ||
	fail "observer treats live state lock as a successful skip"
test ! -e "$LOCKED_STATE/state/lead-memory/arrival/checks.tsv" && test ! -s "$LOCKED_POSTS" ||
	fail "live-lock observer writes shared state or posts"
pass "observer skips a live state lock without shared writes"

BROKEN_FIXTURE="$TASK_TMP_DIR/broken-flywheel"
cp -R "$FIXTURE" "$BROKEN_FIXTURE"
replace_constant_once "$BROKEN_FIXTURE/scripts/lead-memory/lib/sync-common.sh" LM_BOUNDED_RUN /definitely/missing/bounded-run.sh
BROKEN_STATE="$TASK_TMP_DIR/broken-state"
BROKEN_POSTS="$TASK_TMP_DIR/broken.posts"
: >"$BROKEN_POSTS"
set +e
env FLYWHEEL_STATE_DIR="$BROKEN_STATE" TEST_NOW_EPOCH="$NOW" TEST_NOW_ISO="$NOW_ISO" \
	TEST_REMOTE_SHA="$REMOTE_SHA" TEST_POSTS="$BROKEN_POSTS" \
	"$HARNESS" "$BROKEN_FIXTURE/scripts/lead-memory/arrival-check.sh" >/dev/null 2>&1
BROKEN_RC=$?
set -e
test "$BROKEN_RC" = 6 && test ! -e "$BROKEN_STATE" && test ! -s "$BROKEN_POSTS" ||
	fail "observer dependency preflight does not fail closed before state/posting"
if rg -n 'git[[:space:]]+fetch|runs\.tsv|chezmoi' "$SOURCE" >/dev/null; then
	fail "observer reads writer logs, fetches the live repository, or touches chezmoi"
fi
pass "observer preflight and source remain strictly read-only"

printf 'ALL %s TESTS PASSED\n' "$PASSED"
