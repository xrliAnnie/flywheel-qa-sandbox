#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$REPO_ROOT/scripts/lead-memory/freshness-report.sh"
COMMON_SOURCE="$REPO_ROOT/scripts/lead-memory/lib/sync-common.sh"
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly2146-report.XXXXXX")"
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

test -x "$SOURCE" || fail "freshness report exists and is executable"

FIXTURE="$TASK_TMP_DIR/flywheel"
MEMORY="$TASK_TMP_DIR/memory"
ORIGIN="$TASK_TMP_DIR/origin.git"
RUNS="$TASK_TMP_DIR/runs"
mkdir -p "$FIXTURE/scripts/lead-memory/lib" "$FIXTURE/scripts/lib" "$RUNS"
cp "$SOURCE" "$FIXTURE/scripts/lead-memory/freshness-report.sh"
cp "$COMMON_SOURCE" "$FIXTURE/scripts/lead-memory/lib/sync-common.sh"
cp "$REPO_ROOT/scripts/lib/bounded-run.sh" "$FIXTURE/scripts/lib/bounded-run.sh"
chmod 755 "$FIXTURE/scripts/lead-memory/freshness-report.sh" "$FIXTURE/scripts/lib/bounded-run.sh"
git init -q --bare --initial-branch=main "$ORIGIN"
git init -q -b main "$MEMORY"
git -C "$MEMORY" config user.name "FLY-2146 Report Test"
git -C "$MEMORY" config user.email "fly2146-report@example.test"
git -C "$MEMORY" remote add origin "$ORIGIN"
mkdir -p "$MEMORY/alpha-lead"
printf 'baseline\n' >"$MEMORY/alpha-lead/MEMORY.md"
git -C "$MEMORY" add -A
git -C "$MEMORY" commit -q -m initial
git -C "$MEMORY" push -q -u origin main
replace_constant_once "$FIXTURE/scripts/lead-memory/lib/sync-common.sh" REMOTE_URL "$ORIGIN"
replace_constant_once "$FIXTURE/scripts/lead-memory/lib/sync-common.sh" MEMORY_PATH "$MEMORY"

OLD_SHA="$(git -C "$MEMORY" rev-parse HEAD)"
NEW_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
D1=2026-09-03
D2=2026-09-04
cat >"$RUNS/$D1.json" <<JSON
[
  {"databaseId":101,"url":"https://example.test/manual","event":"workflow_dispatch","headBranch":"main","headSha":"$OLD_SHA","createdAt":"${D1}T09:01:00Z","status":"completed","conclusion":"success","attempt":1},
  {"databaseId":102,"url":"https://example.test/rerun","event":"schedule","headBranch":"main","headSha":"$OLD_SHA","createdAt":"${D1}T09:05:00Z","status":"completed","conclusion":"success","attempt":2},
  {"databaseId":103,"url":"https://example.test/d1","event":"schedule","headBranch":"main","headSha":"$OLD_SHA","createdAt":"${D1}T09:05:00Z","status":"completed","conclusion":"success","attempt":1}
]
JSON
cat >"$RUNS/$D2.json" <<JSON
[
  {"databaseId":104,"url":"https://example.test/d2","event":"schedule","headBranch":"main","headSha":"$OLD_SHA","createdAt":"${D2}T09:05:00Z","status":"completed","conclusion":"success","attempt":1}
]
JSON

HARNESS="$TASK_TMP_DIR/run-report.sh"
cat >"$HARNESS" <<'HARNESS'
#!/usr/bin/env bash
set -u
. "$1"
shift
_report_today() { printf '%s\n' "${TEST_TODAY:?}"; }
_report_now_iso() { printf '%s\n' "${TEST_NOW_ISO:?}"; }
_report_gh_run_list() {
  printf '%s\n' "$*" >>"${TEST_RUN_CALLS:?}"
  local previous= arg day=
  for arg in "$@"; do
    if test "$previous" = --created; then day="$arg"; break; fi
    previous="$arg"
  done
  test -n "$day" || return 2
  cat "${TEST_RUNS:?}/$day.json" 2>/dev/null || printf '[]\n'
}
_report_gh_api() {
  printf '%s\n' "$*" >>"${TEST_API_CALLS:?}"
  case "$*" in
    *"ref=${TEST_OLD_SHA:?}"*)
      test "${TEST_D_MODE:-missing}" != missing || return 44
      printf '{"sha":"%s"}\n' "${TEST_D_BLOB:?}"
      ;;
    *"ref=${TEST_NEW_SHA:?}"*) printf '{"sha":"%s"}\n' "${TEST_NEW_BLOB:?}" ;;
    *) return 1 ;;
  esac
}
report_main "$@"
HARNESS
chmod 755 "$HARNESS"

CALLS="$TASK_TMP_DIR/run.calls"
API_CALLS="$TASK_TMP_DIR/api.calls"
: >"$CALLS"
: >"$API_CALLS"
REPORT_OUT="$TASK_TMP_DIR/observations.out"
env TEST_TODAY="$D2" TEST_NOW_ISO="${D2}T10:00:00Z" TEST_RUNS="$RUNS" \
	TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" TEST_OLD_SHA="$OLD_SHA" \
	TEST_NEW_SHA="$NEW_SHA" TEST_D_BLOB=unused TEST_NEW_BLOB=unused \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" \
	--remote-observations --from "$D1" --through "$D2" >"$REPORT_OUT" ||
	fail "two-day remote observation report succeeds"
grep -Fq "$D1" "$REPORT_OUT" && grep -Fq '103' "$REPORT_OUT" && grep -Fq "$D2" "$REPORT_OUT" ||
	fail "remote observation report omits a valid natural run"
test "$(wc -l <"$CALLS" | tr -d ' ')" = 2 || fail "remote report does not query each UTC day exactly once"
while IFS= read -r call; do
	case "$call" in
		*'-R xrliAnnie/lead-memory'*'--workflow remote-observe.yml'*'--event schedule'*'--branch main'*'--limit 50'*'--json databaseId,url,event,headBranch,headSha,createdAt,status,conclusion,attempt'*) ;;
		*) fail "remote run-list call is not pinned to the canonical repository and fields" ;;
	esac
done <"$CALLS"
pass "remote report counts only one natural first-attempt schedule per UTC day"

cat >"$RUNS/$D1.json" <<JSON
[{"databaseId":102,"url":"https://example.test/rerun","event":"schedule","headBranch":"main","headSha":"$OLD_SHA","createdAt":"${D1}T09:05:00Z","status":"completed","conclusion":"success","attempt":2}]
JSON
set +e
env TEST_TODAY="$D2" TEST_NOW_ISO="${D2}T10:00:00Z" TEST_RUNS="$RUNS" \
	TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" TEST_OLD_SHA="$OLD_SHA" \
	TEST_NEW_SHA="$NEW_SHA" TEST_D_BLOB=unused TEST_NEW_BLOB=unused \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" \
	--remote-observations --from "$D1" --through "$D2" >"$TASK_TMP_DIR/missing.out"
MISSING_RC=$?
set -e
test "$MISSING_RC" -ne 0 && grep -Fq "$D1 MISSING" "$TASK_TMP_DIR/missing.out" ||
	fail "rerun-only UTC day is accepted as a natural observation"
pass "manual reruns cannot satisfy a missing natural observation"

CALLS_BEFORE="$(wc -l <"$CALLS" | tr -d ' ')"
set +e
env TEST_TODAY="$D2" TEST_NOW_ISO="${D2}T10:00:00Z" TEST_RUNS="$RUNS" \
	TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" TEST_OLD_SHA="$OLD_SHA" \
	TEST_NEW_SHA="$NEW_SHA" TEST_D_BLOB=unused TEST_NEW_BLOB=unused \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" \
	--remote-observations --from 2026-08-27 --through "$D2" >/dev/null 2>&1
LONG_WINDOW_RC=$?
set -e
test "$LONG_WINDOW_RC" = 2 && test "$(wc -l <"$CALLS" | tr -d ' ')" = "$CALLS_BEFORE" ||
	fail "remote report accepts a window longer than seven UTC days"
pass "remote report rejects oversized windows before querying GitHub"

# Restore D1 and create the dedicated D2 marker after the D2 observation.
cat >"$RUNS/$D1.json" <<JSON
[{"databaseId":103,"url":"https://example.test/d1","event":"schedule","headBranch":"main","headSha":"$OLD_SHA","createdAt":"${D1}T09:05:00Z","status":"completed","conclusion":"success","attempt":1}]
JSON
MARKER="alpha-lead/_fly2146-acceptance-${D2}.md"
printf 'created after the D2 observation\n' >"$MEMORY/$MARKER"
EXPECTED_BLOB="$(git -C "$MEMORY" hash-object "$MARKER")"
FREEZE_STATE="$TASK_TMP_DIR/freeze-state"
env FLYWHEEL_STATE_DIR="$FREEZE_STATE" TEST_TODAY="$D2" TEST_NOW_ISO="${D2}T10:00:00Z" \
	TEST_RUNS="$RUNS" TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" \
	TEST_OLD_SHA="$OLD_SHA" TEST_NEW_SHA="$NEW_SHA" TEST_D_BLOB=unused TEST_NEW_BLOB="$EXPECTED_BLOB" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" \
	--freeze --day "$D2" --path "$MARKER" >/dev/null || fail "dedicated marker freezes"
FREEZE="$FREEZE_STATE/state/lead-memory/acceptance/day-${D2}.json"
jq -e --arg path "$MARKER" --arg blob "$EXPECTED_BLOB" \
	'.path == $path and .expected_blob == $blob and .run_id_D == 104 and .head_sha_D != null' \
	"$FREEZE" >/dev/null || fail "freeze record lacks immutable marker and run identity"
python3 - "$FREEZE" <<'PY' || fail "freeze evidence path is not private"
import pathlib
import stat
import sys

record = pathlib.Path(sys.argv[1])
assert stat.S_IMODE(record.parent.stat().st_mode) == 0o700
assert stat.S_IMODE(record.stat().st_mode) == 0o600
PY
set +e
env FLYWHEEL_STATE_DIR="$FREEZE_STATE" TEST_TODAY="$D2" TEST_NOW_ISO="${D2}T10:01:00Z" \
	TEST_RUNS="$RUNS" TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" \
	TEST_OLD_SHA="$OLD_SHA" TEST_NEW_SHA="$NEW_SHA" TEST_D_BLOB=unused TEST_NEW_BLOB="$EXPECTED_BLOB" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" \
	--freeze --day "$D2" --path "$MARKER" >/dev/null 2>&1
REPEAT_FREEZE_RC=$?
set -e
test "$REPEAT_FREEZE_RC" -ne 0 || fail "freeze record can be overwritten"

EQUAL_STATE="$TASK_TMP_DIR/equal-state"
set +e
env FLYWHEEL_STATE_DIR="$EQUAL_STATE" TEST_TODAY="$D2" TEST_NOW_ISO="${D2}T10:00:00Z" \
	TEST_RUNS="$RUNS" TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" \
	TEST_OLD_SHA="$OLD_SHA" TEST_NEW_SHA="$NEW_SHA" TEST_D_MODE=present \
	TEST_D_BLOB="$EXPECTED_BLOB" TEST_NEW_BLOB="$EXPECTED_BLOB" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" \
	--freeze --day "$D2" --path "$MARKER" >/dev/null 2>&1
ALREADY_VISIBLE_RC=$?
set -e
test "$ALREADY_VISIBLE_RC" -ne 0 && test ! -e "$EQUAL_STATE/state/lead-memory/acceptance/day-${D2}.json" ||
	fail "freeze accepts a blob already present in the D-day remote tree"

SYMLINK_MARKER="alpha-lead/_fly2146-acceptance-${D2}-link.md"
ln -s "$MEMORY/$MARKER" "$MEMORY/$SYMLINK_MARKER"
set +e
env FLYWHEEL_STATE_DIR="$TASK_TMP_DIR/symlink-state" TEST_TODAY="$D2" TEST_NOW_ISO="${D2}T10:00:00Z" \
	TEST_RUNS="$RUNS" TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" \
	TEST_OLD_SHA="$OLD_SHA" TEST_NEW_SHA="$NEW_SHA" TEST_D_BLOB=unused TEST_NEW_BLOB="$EXPECTED_BLOB" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" \
	--freeze --day "$D2" --path "$SYMLINK_MARKER" >/dev/null 2>&1
SYMLINK_MARKER_RC=$?
set -e
test "$SYMLINK_MARKER_RC" -ne 0 || fail "freeze accepts a symlink or non-dedicated marker name"
pass "freeze is create-once and binds a dedicated marker to the D-day remote tree"

D3=2026-09-05
cat >"$RUNS/$D3.json" <<JSON
[{"databaseId":105,"url":"https://example.test/d3","event":"schedule","headBranch":"main","headSha":"$NEW_SHA","createdAt":"${D3}T09:05:00Z","status":"completed","conclusion":"success","attempt":1}]
JSON
env FLYWHEEL_STATE_DIR="$FREEZE_STATE" TEST_TODAY="$D3" TEST_NOW_ISO="${D3}T10:00:00Z" \
	TEST_RUNS="$RUNS" TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" \
	TEST_OLD_SHA="$OLD_SHA" TEST_NEW_SHA="$NEW_SHA" TEST_D_BLOB=unused TEST_NEW_BLOB="$EXPECTED_BLOB" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" \
	--check-visible --day "$D2" >/dev/null || fail "next-day two-tree visibility proof succeeds"

set +e
env FLYWHEEL_STATE_DIR="$FREEZE_STATE" TEST_TODAY="$D3" TEST_NOW_ISO="${D3}T10:00:00Z" \
	TEST_RUNS="$RUNS" TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" \
	TEST_OLD_SHA="$OLD_SHA" TEST_NEW_SHA="$NEW_SHA" TEST_D_BLOB=unused TEST_NEW_BLOB=cccccccccccccccccccccccccccccccccccccccc \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" \
	--check-visible --day "$D2" >/dev/null 2>&1
CHANGED_AFTER_FREEZE_RC=$?
set -e
test "$CHANGED_AFTER_FREEZE_RC" -ne 0 || fail "next-day proof accepts a remote blob different from the freeze"

SAME_HEAD_STATE="$TASK_TMP_DIR/same-head-state"
mkdir -p "$SAME_HEAD_STATE/state/lead-memory/acceptance"
jq --arg head "$NEW_SHA" '.head_sha_D=$head' "$FREEZE" \
	>"$SAME_HEAD_STATE/state/lead-memory/acceptance/day-${D2}.json"
set +e
env FLYWHEEL_STATE_DIR="$SAME_HEAD_STATE" TEST_TODAY="$D3" TEST_NOW_ISO="${D3}T10:00:00Z" \
	TEST_RUNS="$RUNS" TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" \
	TEST_OLD_SHA="$OLD_SHA" TEST_NEW_SHA="$NEW_SHA" TEST_D_BLOB=unused TEST_NEW_BLOB="$EXPECTED_BLOB" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" \
	--check-visible --day "$D2" >/dev/null 2>&1
SAME_HEAD_RC=$?
set -e
test "$SAME_HEAD_RC" -ne 0 || fail "next-day proof accepts the same observed head"
pass "next-day visibility passes only when D differs and D+1 equals the frozen blob"

ARRIVAL_STATE="$FREEZE_STATE/state/lead-memory/arrival"
mkdir -p "$ARRIVAL_STATE/lock"
printf '%s\n' "$$" >"$ARRIVAL_STATE/lock/pid"
printf '{"schema":1,"sentinel":"unchanged"}\n' >"$ARRIVAL_STATE/state.json"
STATE_BEFORE="$(shasum -a 256 "$ARRIVAL_STATE/state.json" | awk '{print $1}')"
env FLYWHEEL_STATE_DIR="$FREEZE_STATE" TEST_TODAY="$D3" TEST_NOW_ISO="${D3}T10:00:00Z" \
	TEST_RUNS="$RUNS" TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" \
	TEST_OLD_SHA="$OLD_SHA" TEST_NEW_SHA="$NEW_SHA" TEST_D_BLOB=unused TEST_NEW_BLOB="$EXPECTED_BLOB" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" --local >/dev/null ||
	fail "local report cannot run while observer holds its state lock"
test "$(shasum -a 256 "$ARRIVAL_STATE/state.json" | awk '{print $1}')" = "$STATE_BEFORE" ||
	fail "local report mutates arrival state"
pass "local report remains lock-free and read-only"

env FLYWHEEL_STATE_DIR="$FREEZE_STATE" TEST_TODAY="$D3" TEST_NOW_ISO="${D3}T10:00:00Z" \
	TEST_RUNS="$RUNS" TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" \
	TEST_OLD_SHA="$OLD_SHA" TEST_NEW_SHA="$NEW_SHA" TEST_D_BLOB=unused TEST_NEW_BLOB="$EXPECTED_BLOB" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" --local --json \
	>"$TASK_TMP_DIR/local.json" || fail "local JSON report fails"
jq -e '.schema == 1 and (.dirty | type) == "number" and (.deleted | type) == "number" and (.unpushed | type) == "number" and (.structural | type) == "number" and has("last_check")' \
	"$TASK_TMP_DIR/local.json" >/dev/null || fail "local --json does not emit its documented machine-readable shape"

env FLYWHEEL_STATE_DIR="$FREEZE_STATE" TEST_TODAY="$D3" TEST_NOW_ISO="${D3}T10:00:00Z" \
	TEST_RUNS="$RUNS" TEST_RUN_CALLS="$CALLS" TEST_API_CALLS="$API_CALLS" \
	TEST_OLD_SHA="$OLD_SHA" TEST_NEW_SHA="$NEW_SHA" TEST_D_BLOB=unused TEST_NEW_BLOB="$EXPECTED_BLOB" \
	"$HARNESS" "$FIXTURE/scripts/lead-memory/freshness-report.sh" --commits --days 1 --json \
	>"$TASK_TMP_DIR/commits.json" || fail "commit JSON report fails"
jq -e 'type == "array" and length >= 1 and all(.[]; (.sha | test("^[0-9a-f]{40,64}$")) and (.date | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")) and (.subject | type == "string"))' \
	"$TASK_TMP_DIR/commits.json" >/dev/null || fail "commits --json does not emit structured commit records"
pass "local and commit JSON modes emit validated machine-readable output"

printf 'ALL %s TESTS PASSED\n' "$PASSED"
