#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMON="$REPO_ROOT/scripts/lead-memory/lib/sync-common.sh"
GUARD="$REPO_ROOT/scripts/lead-memory/lib/guard.sh"
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly2146-sync.XXXXXX")"
trap 'rm -rf -- "$TASK_TMP_DIR"' EXIT

PASSED=0
pass() { PASSED=$((PASSED + 1)); printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }

replace_constant_once() {
	local file="$1" name="$2" value="$3"
	python3 - "$file" "$name" "$value" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
name = sys.argv[2]
replacement = f"{name}={sys.argv[3]}"
text = path.read_text()
pattern = re.compile(rf"^{re.escape(name)}=.*$", re.MULTILINE)
matches = pattern.findall(text)
if len(matches) != 1:
    raise SystemExit(f"{name}: expected one declaration, found {len(matches)}")
path.write_text(pattern.sub(lambda _: replacement, text))
PY
}

test -f "$COMMON" || fail "shared sync library exists"
pass "shared sync library exists"

BEFORE="$(find "$TASK_TMP_DIR" -mindepth 1 -print | sort)"
if ! bash -c '. "$1"' _ "$COMMON" >"$TASK_TMP_DIR/source.stdout" 2>"$TASK_TMP_DIR/source.stderr"; then
	sed 's/^/  /' "$TASK_TMP_DIR/source.stderr" >&2
	fail "shared sync library can be sourced"
fi
test ! -s "$TASK_TMP_DIR/source.stdout" || fail "sourcing the shared library writes stdout"
test ! -s "$TASK_TMP_DIR/source.stderr" || fail "sourcing the shared library writes stderr"
AFTER="$(find "$TASK_TMP_DIR" -mindepth 1 ! -name source.stdout ! -name source.stderr -print | sort)"
test "$BEFORE" = "$AFTER" || fail "sourcing the shared library changes filesystem state"
pass "shared sync library sources without side effects"

# shellcheck source=/dev/null
. "$COMMON"
SYNC_SOURCE="$REPO_ROOT/scripts/lead-memory/sync.sh"
# shellcheck source=/dev/null
. "$SYNC_SOURCE"

EARLY_STOP_MARKER="$TASK_TMP_DIR/early-deadline-stopped"
EARLY_UNLOCK_MARKER="$TASK_TMP_DIR/early-writer-unlocked"
set +e
(
	sync_deadline_stop() { : >"$EARLY_STOP_MARKER"; }
	lm_writer_lock_release() { : >"$EARLY_UNLOCK_MARKER"; }
	sync_early_evidence_failure
)
EARLY_FAILURE_RC=$?
set -e
test "$EARLY_FAILURE_RC" = 9 && test -e "$EARLY_STOP_MARKER" && test -e "$EARLY_UNLOCK_MARKER" ||
	fail "early evidence failure does not stop the deadline and release the writer lock"
pass "early evidence failures stop the deadline before returning"

if ! (
	remote_head_after=stale
	arrival_observation=observed
	sync_remote_head() { return 1; }
	sync_observe_remote_after
	[[ -z "$remote_head_after" && "$arrival_observation" == undetermined ]]
); then
	fail "failed terminal remote read is recorded as observed"
fi
pass "failed terminal remote reads remain undetermined"

guard_remote="$(sed -n 's/^REMOTE_URL=//p' "$GUARD")"
guard_memory="$(sed -n 's/^MEMORY_PATH=//p' "$GUARD")"
guard_pattern="$(sed -n 's/^LEAD_NAME_PATTERN=//p' "$GUARD")"
test "$REMOTE_URL" = "$guard_remote" || fail "REMOTE_URL diverges from guard.sh"
test '${HOME:?HOME is required}/.claude/agent-memory' = "$guard_memory" ||
	fail "MEMORY_PATH declaration diverges from guard.sh"
test "'$LEAD_NAME_PATTERN'" = "$guard_pattern" || fail "LEAD_NAME_PATTERN diverges from guard.sh"
pass "shared constants match guard.sh"

GNU_STAT_BIN="$TASK_TMP_DIR/gnu-stat-bin"
GNU_STAT_TARGET="$TASK_TMP_DIR/gnu-stat-target"
mkdir -p "$GNU_STAT_BIN"
printf 'mode probe\n' >"$GNU_STAT_TARGET"
cat >"$GNU_STAT_BIN/stat" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == -f ]]; then
	printf 'File: simulated GNU filesystem output\n'
	exit 0
fi
if [[ "${1:-}" == -c && "${2:-}" == %a ]]; then
	printf '600\n'
	exit 0
fi
exit 2
STUB
chmod 755 "$GNU_STAT_BIN/stat"
test "$(PATH="$GNU_STAT_BIN:$PATH" lm_file_mode "$GNU_STAT_TARGET")" = 600 ||
	fail "file-mode probe accepts GNU stat filesystem output as a permission mode"
pass "file-mode probe uses GNU permission output instead of filesystem output"

LOCK_REPO="$TASK_TMP_DIR/lock-repo"
mkdir -p "$LOCK_REPO/.git"
expected_backend=python
command -v flock >/dev/null 2>&1 && expected_backend=flock
command -v lockf >/dev/null 2>&1 && expected_backend=lockf
SELECTED_BACKEND="$(lm_writer_lock_backend)"
test "$SELECTED_BACKEND" = "$expected_backend" ||
	fail "writer lock selects the platform kernel backend"
if [[ "$(uname -s)" == Linux && "$SELECTED_BACKEND" != flock ]]; then
	fail "Ubuntu CI must exercise the real flock backend"
fi
pass "writer lock selects the real platform kernel backend ($SELECTED_BACKEND)"

lm_writer_lock_acquire "$LOCK_REPO" 0 || fail "first writer acquires the retained lock"
LOCK_PATH="$LOCK_REPO/.git/flywheel-writer.lock"
test -f "$LOCK_PATH" && test ! -L "$LOCK_PATH" || fail "writer lock is not a regular retained file"
LOCK_MODE="$(lm_file_mode "$LOCK_PATH")"
test "$LOCK_MODE" = 600 || fail "writer lock mode is not 0600"
set +e
bash -c '. "$1"; lm_writer_lock_acquire "$2" 0' _ "$COMMON" "$LOCK_REPO"
LOCK_BUSY_RC=$?
set -e
test "$LOCK_BUSY_RC" = 75 || fail "contending writer does not normalize busy to 75"
lm_writer_lock_release
bash -c '. "$1"; lm_writer_lock_acquire "$2" 0; lm_writer_lock_release' _ \
	"$COMMON" "$LOCK_REPO" || fail "writer lock is reusable after release"
pass "writer lock is retained, private, exclusive, and reusable"

HOLDER_READY="$TASK_TMP_DIR/holder.ready"
bash -c '. "$1"; lm_writer_lock_acquire "$2" 0 || exit; : >"$3"; while :; do :; done' _ \
	"$COMMON" "$LOCK_REPO" "$HOLDER_READY" &
HOLDER_PID=$!
for _ in 1 2 3 4 5; do
	test -e "$HOLDER_READY" && break
	sleep 0.1
done
test -e "$HOLDER_READY" || fail "writer lock holder did not start"
kill -9 "$HOLDER_PID"
wait "$HOLDER_PID" 2>/dev/null || true
bash -c '. "$1"; lm_writer_lock_acquire "$2" 0; lm_writer_lock_release' _ \
	"$COMMON" "$LOCK_REPO" || fail "kernel lock survives holder SIGKILL"
test -f "$LOCK_PATH" || fail "SIGKILL recovery incorrectly unlinks the retained lock file"
pass "kernel releases writer lock after SIGKILL"

PYTHON_LOCK="$TASK_TMP_DIR/python-writer.lock"
exec 8>>"$PYTHON_LOCK"
LM_WRITER_LOCK_FD=8
lm_writer_lock_claim python || fail "real Python fcntl backend cannot acquire an inherited FD"
set +e
bash -c '. "$1"; exec 9>>"$2"; LM_WRITER_LOCK_FD=9; lm_writer_lock_claim python' _ \
	"$COMMON" "$PYTHON_LOCK"
PYTHON_BUSY_RC=$?
set -e
test "$PYTHON_BUSY_RC" = 75 || fail "Python fcntl contention does not normalize to 75"
exec 8>&-
bash -c '. "$1"; exec 9>>"$2"; LM_WRITER_LOCK_FD=9; lm_writer_lock_claim python; exec 9>&-' _ \
	"$COMMON" "$PYTHON_LOCK" || fail "Python fcntl lock is not reusable after FD close"

PYTHON_READY="$TASK_TMP_DIR/python-holder.ready"
bash -c '. "$1"; exec 9>>"$2"; LM_WRITER_LOCK_FD=9; lm_writer_lock_claim python || exit; : >"$3"; while :; do :; done' _ \
	"$COMMON" "$PYTHON_LOCK" "$PYTHON_READY" &
PYTHON_HOLDER_PID=$!
for _ in 1 2 3 4 5; do test -e "$PYTHON_READY" && break; sleep 0.1; done
test -e "$PYTHON_READY" || fail "Python fcntl holder did not start"
kill -9 "$PYTHON_HOLDER_PID"
wait "$PYTHON_HOLDER_PID" 2>/dev/null || true
bash -c '. "$1"; exec 9>>"$2"; LM_WRITER_LOCK_FD=9; lm_writer_lock_claim python; exec 9>&-' _ \
	"$COMMON" "$PYTHON_LOCK" || fail "Python fcntl lock survives holder SIGKILL"
pass "real Python fcntl backend is exclusive and recovers after SIGKILL"

SYMLINK_REPO="$TASK_TMP_DIR/symlink-repo"
mkdir -p "$SYMLINK_REPO/.git"
printf 'outside\n' >"$TASK_TMP_DIR/outside-lock"
ln -s "$TASK_TMP_DIR/outside-lock" "$SYMLINK_REPO/.git/flywheel-writer.lock"
set +e
lm_writer_lock_acquire "$SYMLINK_REPO" 0
SYMLINK_RC=$?
set -e
test "$SYMLINK_RC" = 6 || fail "symlinked writer lock does not fail closed as preflight 6"
test "$(cat "$TASK_TMP_DIR/outside-lock")" = outside || fail "writer lock followed an unsafe symlink"
pass "writer lock rejects unsafe paths without touching their targets"

ATOMIC="$TASK_TMP_DIR/state/receipt.json"
mkdir -p "$(dirname "$ATOMIC")"
printf '{"schema":1}\n' | lm_write_json_atomic "$ATOMIC" || fail "atomic JSON write succeeds"
test "$(cat "$ATOMIC")" = '{"schema":1}' || fail "atomic JSON write changes payload"
test "$(find "$(dirname "$ATOMIC")" -name '*.tmp.*' -print -quit)" = "" ||
	fail "atomic JSON write leaves temporary files"
TSV="$TASK_TMP_DIR/state/runs.tsv"
lm_append_tsv "$TSV" $'schema\tvalue' $'1\tfirst' || fail "TSV append creates ledger"
lm_append_tsv "$TSV" $'schema\tvalue' $'1\tsecond' || fail "TSV append reuses ledger"
test "$(grep -c '^schema' "$TSV")" = 1 || fail "TSV append duplicates header"
test "$(wc -l <"$TSV" | tr -d ' ')" = 3 || fail "TSV append loses a row"
pass "evidence writes are atomic and headers are stable"

READONLY="$TASK_TMP_DIR/readonly"
mkdir "$READONLY"
chmod 500 "$READONLY"
set +e
printf '{}\n' | lm_write_json_atomic "$READONLY/nope.json" 2>/dev/null
READONLY_RC=$?
set -e
chmod 700 "$READONLY"
test "$READONLY_RC" -ne 0 || fail "atomic JSON write accepts an unwritable directory"
pass "atomic evidence write fails closed on unwritable storage"

test "$(lm_bounded 2 printf bounded)" = bounded || fail "bounded command loses stdout"
set +e
lm_bounded 1 bash -c 'sleep 2' >/dev/null 2>&1
BOUNDED_RC=$?
set -e
test "$BOUNDED_RC" = 124 || fail "bounded command timeout does not return 124"
pass "bounded command delegates output and timeout status"

SCAN_REPO="$TASK_TMP_DIR/scan-repo"
SCAN_ORIGIN="$TASK_TMP_DIR/scan-origin.git"
git init -q --bare --initial-branch=main "$SCAN_ORIGIN"
git init -q -b main "$SCAN_REPO"
git -C "$SCAN_REPO" config user.name "FLY-2146 Test"
git -C "$SCAN_REPO" config user.email "fly2146@example.test"
git -C "$SCAN_REPO" remote add origin "$SCAN_ORIGIN"
mkdir -p "$SCAN_REPO/alpha-lead" "$SCAN_REPO/deleted-lead"
printf 'alpha\n' >"$SCAN_REPO/alpha-lead/MEMORY.md"
printf 'gone\n' >"$SCAN_REPO/deleted-lead/MEMORY.md"
printf 'template\n' >"$SCAN_REPO/README.md"
git -C "$SCAN_REPO" add -A
git -C "$SCAN_REPO" commit -q -m initial
git -C "$SCAN_REPO" push -q -u origin main
mkdir -p "$SCAN_REPO/beta-lead"
printf 'beta\n' >"$SCAN_REPO/beta-lead/new note.md"
ln -s "$TASK_TMP_DIR" "$SCAN_REPO/symlink-lead"
MEMORY_PATH_BEFORE_TEST="$MEMORY_PATH"
MEMORY_PATH="$SCAN_REPO"
hold_started=$SECONDS
SYNC_FOLDERS="$TASK_TMP_DIR/sync-folders"
sync_collect_folders "$SYNC_FOLDERS" || fail "production Lead folder census fails"
test "$(cat "$SYNC_FOLDERS")" = $'alpha-lead\nbeta-lead\ndeleted-lead' ||
	fail "Lead folder census admits a file/symlink or misses tracked/current directories"
pass "Lead folder census unions tracked and physical valid directories"

printf 'admin pending\n' >>"$SCAN_REPO/README.md"
git -C "$SCAN_REPO" add -- README.md
REBASE_STATUS=
hold_started=$SECONDS
sync_capture_rebase_status REBASE_STATUS ||
	fail "whole-repository rebase status cannot be captured"
test -n "$REBASE_STATUS" && test "${REBASE_STATUS#*README.md}" != "$REBASE_STATUS" ||
	fail "rebase precondition misses a staged non-Lead path"
git -C "$SCAN_REPO" reset -q -- README.md
git -C "$SCAN_REPO" checkout -q -- README.md
pass "rebase precondition includes staged and tracked-dirty non-Lead paths"

git -C "$SCAN_REPO" remote set-url origin "$REMOTE_URL"
hold_started=$SECONDS
sync_origin_check || fail "canonical origin is rejected"
git -C "$SCAN_REPO" remote set-url --add --push origin https://example.test/wrong.git
set +e
hold_started=$SECONDS
sync_origin_check
PUSHURL_RC=$?
set -e
test "$PUSHURL_RC" -ne 0 || fail "explicit pushurl is accepted"
git -C "$SCAN_REPO" config --unset-all remote.origin.pushurl
git -C "$SCAN_REPO" config url.https://example.test/wrong.git.insteadOf "$REMOTE_URL"
set +e
hold_started=$SECONDS
sync_origin_check
REWRITE_RC=$?
set -e
test "$REWRITE_RC" -ne 0 || fail "resolved insteadOf origin is accepted"
git -C "$SCAN_REPO" config --unset-all url.https://example.test/wrong.git.insteadOf
hold_started=$SECONDS
sync_origin_check || fail "canonical origin is not restored"
pass "origin validation rejects push and fetch rewrites away from canonical"

git -C "$SCAN_REPO" remote set-url origin "$SCAN_ORIGIN"
test "$(lm_remote_head "$SCAN_REPO")" = "$(git --git-dir="$SCAN_ORIGIN" rev-parse refs/heads/main)" ||
	fail "remote head observer does not return origin main"
git -C "$SCAN_REPO" remote set-url origin "$TASK_TMP_DIR/missing-origin.git"
set +e
MISSING_REMOTE_OUT="$(lm_remote_head "$SCAN_REPO" 2>/dev/null)"
MISSING_REMOTE_RC=$?
set -e
test "$MISSING_REMOTE_RC" -ne 0 && test -z "$MISSING_REMOTE_OUT" ||
	fail "unreachable remote head does not fail with empty stdout"
pass "remote head observer fails closed without emitting a false SHA"

git -C "$SCAN_REPO" remote set-url origin "$SCAN_ORIGIN"
REMOTE_SHA="$(git --git-dir="$SCAN_ORIGIN" rev-parse refs/heads/main)"
mkdir -p "$SCAN_REPO/gamma-lead"
printf 'unpushed\n' >"$SCAN_REPO/gamma-lead/MEMORY.md"
git -C "$SCAN_REPO" add gamma-lead/MEMORY.md
git -C "$SCAN_REPO" commit -q -m unpushed
printf 'dirty\n' >>"$SCAN_REPO/alpha-lead/MEMORY.md"
rm "$SCAN_REPO/deleted-lead/MEMORY.md"
printf 'changed template\n' >"$SCAN_REPO/README.md"
lm_pending_scan "$SCAN_REPO" "$REMOTE_SHA" >"$TASK_TMP_DIR/pending.bin"
python3 - "$TASK_TMP_DIR/pending.bin" <<'PY' || fail "pending scan classification is wrong"
import pathlib
import sys

records = pathlib.Path(sys.argv[1]).read_bytes().split(b"\0")
records = [tuple(records[i:i + 3]) for i in range(0, len(records) - 1, 3)]
seen = {(kind.decode(), value.decode()) for kind, value, _ in records}
required = {
    ("dirty", "alpha-lead/MEMORY.md"),
    ("dirty", "beta-lead/new note.md"),
    ("deleted", "deleted-lead/MEMORY.md"),
    ("unpushed", "gamma-lead"),
    ("structural", "README.md"),
}
if not required <= seen:
    raise SystemExit(f"missing records: {sorted(required - seen)!r}; got={sorted(seen)!r}")
PY
pass "pending scan separates Lead delivery work from structural residue"

lm_read_deps_check || fail "read-only dependency preflight rejects the real toolchain"
DEPS_BIN="$TASK_TMP_DIR/deps-bin"
mkdir "$DEPS_BIN"
for tool in git gh jq python3; do
	ln -s "$(command -v "$tool")" "$DEPS_BIN/$tool"
done
set +e
PATH="$DEPS_BIN" lm_read_deps_check
MISSING_CURL_RC=$?
set -e
test "$MISSING_CURL_RC" = 6 || fail "read-only dependency preflight does not reject missing curl"
pass "read-only dependency preflight fails closed on a missing command"

DEPS_REPO="$TASK_TMP_DIR/deps-repo"
mkdir -p "$DEPS_REPO/.githooks/lib"
for hook in pre-commit prepare-commit-msg pre-push; do
	cp "$REPO_ROOT/scripts/lead-memory/hooks/$hook" "$DEPS_REPO/.githooks/$hook"
	chmod 755 "$DEPS_REPO/.githooks/$hook"
done
cp "$REPO_ROOT/scripts/lead-memory/lib/guard.sh" "$DEPS_REPO/.githooks/lib/guard.sh"
chmod 755 "$DEPS_REPO/.githooks/lib/guard.sh"
cp "$REPO_ROOT/scripts/lead-memory/repo-template/.gitleaks.toml" "$DEPS_REPO/.gitleaks.toml"
cp "$REPO_ROOT/scripts/lead-memory/repo-template/.gitleaksignore" "$DEPS_REPO/.gitleaksignore"
GITLEAKS_BIN="$TASK_TMP_DIR/gitleaks-bin"
mkdir "$GITLEAKS_BIN"
cat >"$GITLEAKS_BIN/gitleaks" <<'STUB'
#!/bin/sh
if test "${1:-}" = version; then printf '8.30.1\n'; fi
exit 0
STUB
chmod 755 "$GITLEAKS_BIN/gitleaks"
cat >"$GITLEAKS_BIN/stat" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == -f ]]; then
	printf 'File: simulated GNU filesystem output\n'
	exit 1
fi
if [[ "${1:-}" == -c && "${2:-}" == %a ]]; then
	printf '600\n'
	exit 0
fi
exit 2
STUB
chmod 755 "$GITLEAKS_BIN/stat"
MEMORY_PATH="$DEPS_REPO"
hold_started=$SECONDS
PATH="$GITLEAKS_BIN:$PATH" sync_deps_check ||
	fail "writer dependency preflight rejects the complete fixture"
WRITER_DEPS_BIN="$TASK_TMP_DIR/writer-deps-bin"
mkdir "$WRITER_DEPS_BIN"
for tool in bash git jq python3 sleep; do
	ln -s "$(command -v "$tool")" "$WRITER_DEPS_BIN/$tool"
done
ln -s "$GITLEAKS_BIN/gitleaks" "$WRITER_DEPS_BIN/gitleaks"
hold_started=$SECONDS
PATH="$WRITER_DEPS_BIN" sync_deps_check ||
	fail "writer dependency preflight requires observer-only gh or curl"
pass "writer dependency preflight excludes observer-only commands"
if [[ -n "${FLY2145_REAL_GITLEAKS_BIN:-}" ]]; then
	test -x "$FLY2145_REAL_GITLEAKS_BIN" || fail "configured real gitleaks binary is not executable"
	test "$($FLY2145_REAL_GITLEAKS_BIN version)" = 8.30.1 || fail "configured real gitleaks version drifted"
	(
		cd "$DEPS_REPO"
		"$FLY2145_REAL_GITLEAKS_BIN" dir --no-banner --redact \
			--config .gitleaks.toml --gitleaks-ignore-path .gitleaksignore
	) >/dev/null || fail "real gitleaks rejects the repository scanner policy"
	pass "real gitleaks executes the pinned scanner policy"
fi
rm "$DEPS_REPO/.githooks/pre-push"
ln -s "$REPO_ROOT/scripts/lead-memory/hooks/pre-push" "$DEPS_REPO/.githooks/pre-push"
set +e
hold_started=$SECONDS
PATH="$GITLEAKS_BIN:$PATH" sync_deps_check
SYMLINK_HOOK_RC=$?
set -e
test "$SYMLINK_HOOK_RC" = 6 || fail "writer dependency preflight accepts a symlinked hook"
pass "writer dependency preflight pins scanner and ordinary executable policy files"
MEMORY_PATH="$MEMORY_PATH_BEFORE_TEST"

ROOT_REPO="$TASK_TMP_DIR/root-repo"
git init -q -b main "$ROOT_REPO"
lm_repo_root_check "$ROOT_REPO" || fail "repository-root invariant rejects a real root"
mkdir "$ROOT_REPO/nested"
set +e
lm_repo_root_check "$ROOT_REPO/nested"
NESTED_ROOT_RC=$?
set -e
test "$NESTED_ROOT_RC" = 6 || fail "repository-root invariant accepts an outer repository"
mv "$ROOT_REPO/.git" "$ROOT_REPO/real-git"
printf 'gitdir: real-git\n' >"$ROOT_REPO/.git"
set +e
lm_repo_root_check "$ROOT_REPO"
GITFILE_ROOT_RC=$?
set -e
test "$GITFILE_ROOT_RC" = 6 || fail "repository-root invariant accepts a gitfile"
pass "repository-root invariant rejects nested and gitfile shapes"

PID_LOCK="$TASK_TMP_DIR/arrival/lock"
mkdir -p "$(dirname "$PID_LOCK")"
lm_lock_acquire "$PID_LOCK" || fail "state lock does not acquire"
test "$(cat "$PID_LOCK/pid")" = "$$" || fail "state lock does not record its holder"
set +e
bash -c '. "$1"; lm_lock_acquire "$2"' _ "$COMMON" "$PID_LOCK"
LIVE_PID_RC=$?
set -e
test "$LIVE_PID_RC" = 1 || fail "state lock does not distinguish a live holder"
lm_lock_release || fail "state lock does not release"
mkdir "$PID_LOCK"
printf '99999999\n' >"$PID_LOCK/pid"
lm_lock_acquire "$PID_LOCK" || fail "state lock does not reclaim a dead holder"
lm_lock_release
mkdir "$PID_LOCK"
printf 'malformed\n' >"$PID_LOCK/pid"
lm_lock_acquire "$PID_LOCK" || fail "state lock does not reclaim malformed residue"
lm_lock_release
pass "state lock distinguishes live ownership and reclaims stale residue"

TERM_READY="$TASK_TMP_DIR/term.ready"
bash -c '. "$1"; lm_lock_acquire "$2" || exit; trap '\''lm_lock_release; exit 143'\'' TERM; : >"$3"; while :; do :; done' _ \
	"$COMMON" "$PID_LOCK" "$TERM_READY" &
TERM_PID=$!
for _ in 1 2 3 4 5; do test -e "$TERM_READY" && break; sleep 0.1; done
test -e "$TERM_READY" || fail "TERM state-lock holder did not start"
kill -TERM "$TERM_PID"
set +e
wait "$TERM_PID"
TERM_RC=$?
set -e
test "$TERM_RC" = 143 && test ! -e "$PID_LOCK" || fail "TERM does not release state lock"
pass "state lock is released by the caller signal trap"

test -f "$SYNC_SOURCE" || fail "scheduled sync writer exists"
SYNC_FIXTURE="$TASK_TMP_DIR/flywheel-fixture"
mkdir -p "$SYNC_FIXTURE/scripts/lead-memory/lib" "$SYNC_FIXTURE/scripts/lib"
cp "$SYNC_SOURCE" "$SYNC_FIXTURE/scripts/lead-memory/sync.sh"
cp "$COMMON" "$SYNC_FIXTURE/scripts/lead-memory/lib/sync-common.sh"
cp "$REPO_ROOT/scripts/lib/bounded-run.sh" "$SYNC_FIXTURE/scripts/lib/bounded-run.sh"
chmod 755 "$SYNC_FIXTURE/scripts/lead-memory/sync.sh" "$SYNC_FIXTURE/scripts/lib/bounded-run.sh"

WRITER_REPO="$TASK_TMP_DIR/writer-repo"
WRITER_ORIGIN="$TASK_TMP_DIR/writer-origin.git"
WRITER_STATE="$TASK_TMP_DIR/writer-state"
git init -q --bare --initial-branch=main "$WRITER_ORIGIN"
git init -q -b main "$WRITER_REPO"
git -C "$WRITER_REPO" config user.name "FLY-2146 Writer Test"
git -C "$WRITER_REPO" config user.email "fly2146-writer@example.test"
git -C "$WRITER_REPO" remote add origin "$WRITER_ORIGIN"
"$REPO_ROOT/scripts/lead-memory/sync-template.sh" "$WRITER_REPO" >/dev/null
replace_constant_once "$WRITER_REPO/write-memory.sh" REMOTE_URL "$WRITER_ORIGIN"
git -C "$WRITER_REPO" config core.hooksPath .githooks
mkdir -p "$WRITER_REPO/alpha-lead" "$WRITER_REPO/beta-lead"
printf 'alpha v1\n' >"$WRITER_REPO/alpha-lead/MEMORY.md"
printf 'beta v1\n' >"$WRITER_REPO/beta-lead/MEMORY.md"
git -C "$WRITER_REPO" add -A
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$WRITER_STATE" FLYWHEEL_MEMORY_ACTOR=admin \
	git -C "$WRITER_REPO" commit -q -m initial
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$WRITER_STATE" FLYWHEEL_MEMORY_ACTOR=admin \
	git -C "$WRITER_REPO" push -q -u origin main

replace_constant_once "$SYNC_FIXTURE/scripts/lead-memory/lib/sync-common.sh" REMOTE_URL "$WRITER_ORIGIN"
replace_constant_once "$SYNC_FIXTURE/scripts/lead-memory/lib/sync-common.sh" MEMORY_PATH "$WRITER_REPO"
printf 'alpha staged\n' >>"$WRITER_REPO/alpha-lead/MEMORY.md"
git -C "$WRITER_REPO" add alpha-lead/MEMORY.md
ALPHA_STAGE_BEFORE="$(git -C "$WRITER_REPO" ls-files -s -- alpha-lead/MEMORY.md)"
printf 'beta scheduled\n' >>"$WRITER_REPO/beta-lead/MEMORY.md"
SYNC_OUTPUT="$TASK_TMP_DIR/sync.output"
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$WRITER_STATE" FLYWHEEL_SYNC_TRIGGER=manual \
	"$SYNC_FIXTURE/scripts/lead-memory/sync.sh" >"$SYNC_OUTPUT" 2>&1 ||
	{ sed 's/^/  /' "$SYNC_OUTPUT" >&2; fail "scheduled sync happy path succeeds"; }

test "$(git -C "$WRITER_REPO" ls-files -s -- alpha-lead/MEMORY.md)" = "$ALPHA_STAGE_BEFORE" ||
	fail "scheduled sync changes another Lead's staged path/blob/mode"
test "$(git -C "$WRITER_REPO" show --format= --name-only HEAD)" = beta-lead/MEMORY.md ||
	fail "scheduled sync commit contains paths outside its target Lead folder"
test "$(git -C "$WRITER_REPO" show -s --format=%B HEAD | grep -c '^Memory-Owner: beta-lead$')" = 1 ||
	fail "scheduled sync commit lacks its derived owner"
test "$(git --git-dir="$WRITER_ORIGIN" rev-parse refs/heads/main)" = "$(git -C "$WRITER_REPO" rev-parse HEAD)" ||
	fail "scheduled sync success is not present on remote main"
RECEIPT="$WRITER_STATE/state/lead-memory/sync/last-receipt.json"
jq -e '.schema == 1 and .arrived == true and .arrival_observation == "observed" and .committed_n == 1 and .failed_n == 0 and .preserved_staged_n == 1 and .fetch_rc == 0 and .push_rc == 0' \
	"$RECEIPT" >/dev/null || fail "scheduled sync receipt does not prove remote arrival"
test "$(wc -l <"$WRITER_STATE/state/lead-memory/sync/runs.tsv" | tr -d ' ')" = 2 ||
	fail "scheduled sync does not append exactly one run ledger row"
pass "scheduled sync commits only its Lead folder, preserves staged work, and proves remote arrival"

WRITE_SOURCE="$REPO_ROOT/scripts/lead-memory/repo-template/write-memory.sh"
test -x "$WRITE_SOURCE" || fail "ordinary Lead writer template exists and is executable"
test "$(sed -n 's/^REMOTE_URL=//p' "$WRITE_SOURCE")" = "$REMOTE_URL" ||
	fail "ordinary writer canonical origin drifts from the shared guard contract"
"$REPO_ROOT/scripts/lead-memory/sync-template.sh" "$WRITER_REPO" >/dev/null
replace_constant_once "$WRITER_REPO/write-memory.sh" REMOTE_URL "$WRITER_ORIGIN"
test -x "$WRITER_REPO/write-memory.sh" || fail "template sync installs executable ordinary writer"
printf 'beta staged by another writer\n' >>"$WRITER_REPO/beta-lead/MEMORY.md"
git -C "$WRITER_REPO" add beta-lead/MEMORY.md
BETA_STAGE_BEFORE="$(git -C "$WRITER_REPO" ls-files -s -- beta-lead/MEMORY.md)"
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$WRITER_STATE" FLYWHEEL_LEAD_ID=alpha-lead \
	"$WRITER_REPO/write-memory.sh" >"$TASK_TMP_DIR/write-memory.output" 2>&1 ||
	{ sed 's/^/  /' "$TASK_TMP_DIR/write-memory.output" >&2; fail "ordinary Lead writer succeeds"; }
test "$(git -C "$WRITER_REPO" ls-files -s -- beta-lead/MEMORY.md)" = "$BETA_STAGE_BEFORE" ||
	fail "ordinary Lead writer changes another Lead's staged path/blob/mode"
test "$(git -C "$WRITER_REPO" show --format= --name-only HEAD)" = alpha-lead/MEMORY.md ||
	fail "ordinary Lead writer commits outside its own folder"
test "$(git -C "$WRITER_REPO" show -s --format=%B HEAD | grep -c '^Memory-Owner: alpha-lead$')" = 1 ||
	fail "ordinary Lead writer lacks its ownership trailer"
test "$(git --git-dir="$WRITER_ORIGIN" rev-parse refs/heads/main)" = "$(git -C "$WRITER_REPO" rev-parse HEAD)" ||
	fail "ordinary Lead writer reports success before remote arrival"
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$WRITER_STATE" FLYWHEEL_LEAD_ID=alpha-lead \
	"$WRITER_REPO/write-memory.sh" >/dev/null || fail "ordinary Lead writer no-change path succeeds"
pass "ordinary Lead writer shares the lock, preserves staged work, and reaches remote"

VERIFY_REPO="$TASK_TMP_DIR/verify-repo"
VERIFY_ORIGIN="$TASK_TMP_DIR/verify-origin.git"
git init -q --bare --initial-branch=main "$VERIFY_ORIGIN"
git init -q -b main "$VERIFY_REPO"
git -C "$VERIFY_REPO" config user.name "FLY-2146 Verify Test"
git -C "$VERIFY_REPO" config user.email "fly2146-verify@example.test"
git -C "$VERIFY_REPO" remote add origin "$VERIFY_ORIGIN"
"$REPO_ROOT/scripts/lead-memory/sync-template.sh" "$VERIFY_REPO" >/dev/null
replace_constant_once "$VERIFY_REPO/write-memory.sh" REMOTE_URL "$VERIFY_ORIGIN"
mkdir -p "$VERIFY_REPO/alpha-lead" "$VERIFY_REPO/no-hooks"
printf 'alpha v1\n' >"$VERIFY_REPO/alpha-lead/MEMORY.md"
git -C "$VERIFY_REPO" add -A
git -C "$VERIFY_REPO" -c core.hooksPath=no-hooks commit -q -m initial
git -C "$VERIFY_REPO" push -q -u origin main
git -C "$VERIFY_REPO" config core.hooksPath .githooks
printf '#!/bin/sh\nexit 0\n' >"$VERIFY_REPO/.githooks/prepare-commit-msg"
printf '#!/bin/sh\nexit 0\n' >"$VERIFY_REPO/.githooks/pre-push"
chmod 755 "$VERIFY_REPO/.githooks/prepare-commit-msg" "$VERIFY_REPO/.githooks/pre-push"
VERIFY_LOCAL_BEFORE="$(git -C "$VERIFY_REPO" rev-parse HEAD)"
VERIFY_REMOTE_BEFORE="$(git --git-dir="$VERIFY_ORIGIN" rev-parse refs/heads/main)"
printf 'alpha without an ownership hook\n' >>"$VERIFY_REPO/alpha-lead/MEMORY.md"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_LEAD_ID=alpha-lead \
	"$VERIFY_REPO/write-memory.sh" >"$TASK_TMP_DIR/write-memory-verify.output" 2>&1
VERIFY_RC=$?
set -e
test "$VERIFY_RC" = 6 || fail "ordinary writer accepts a commit that fails its ownership verification"
test "$(git -C "$VERIFY_REPO" rev-parse HEAD)" != "$VERIFY_LOCAL_BEFORE" ||
	fail "invalid-commit fixture does not reach post-commit verification"
test "$(git -C "$VERIFY_REPO" show -s --format=%B HEAD | grep -c '^Memory-Owner: alpha-lead$' || true)" = 0 ||
	fail "invalid-commit fixture unexpectedly gains an ownership trailer"
test "$(git --git-dir="$VERIFY_ORIGIN" rev-parse refs/heads/main)" = "$VERIFY_REMOTE_BEFORE" ||
	fail "ordinary writer publishes a commit that fails ownership verification"
pass "ordinary writer executes post-commit ownership verification before publication"

PREFLIGHT_REPO="$TASK_TMP_DIR/preflight-repo"
git clone -q "$VERIFY_ORIGIN" "$PREFLIGHT_REPO"
git -C "$PREFLIGHT_REPO" config user.name "FLY-2146 Preflight Test"
git -C "$PREFLIGHT_REPO" config user.email "fly2146-preflight@example.test"
git -C "$PREFLIGHT_REPO" config core.hooksPath no-hooks
PREFLIGHT_LOCAL_BEFORE="$(git -C "$PREFLIGHT_REPO" rev-parse HEAD)"
PREFLIGHT_REMOTE_BEFORE="$(git --git-dir="$VERIFY_ORIGIN" rev-parse refs/heads/main)"
printf 'must stay uncommitted without hooks\n' >>"$PREFLIGHT_REPO/alpha-lead/MEMORY.md"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_LEAD_ID=alpha-lead \
	"$PREFLIGHT_REPO/write-memory.sh" >"$TASK_TMP_DIR/write-memory-preflight.output" 2>&1
PREFLIGHT_RC=$?
set -e
test "$PREFLIGHT_RC" = 6 || fail "ordinary writer does not fail closed when hooksPath is unsafe"
test "$(git -C "$PREFLIGHT_REPO" rev-parse HEAD)" = "$PREFLIGHT_LOCAL_BEFORE" ||
	fail "ordinary writer commits before validating hooksPath"
test "$(git --git-dir="$VERIFY_ORIGIN" rev-parse refs/heads/main)" = "$PREFLIGHT_REMOTE_BEFORE" ||
	fail "ordinary writer changes remote before validating hooksPath"

WRONG_GITLEAKS_BIN="$TASK_TMP_DIR/wrong-write-gitleaks-bin"
mkdir "$WRONG_GITLEAKS_BIN"
printf '#!/bin/sh\nprintf "8.31.0\\n"\n' >"$WRONG_GITLEAKS_BIN/gitleaks"
chmod 755 "$WRONG_GITLEAKS_BIN/gitleaks"
git -C "$PREFLIGHT_REPO" config core.hooksPath .githooks
set +e
env PATH="$WRONG_GITLEAKS_BIN:$PATH" FLYWHEEL_LEAD_ID=alpha-lead \
	"$PREFLIGHT_REPO/write-memory.sh" >"$TASK_TMP_DIR/write-memory-gitleaks-preflight.output" 2>&1
PREFLIGHT_RC=$?
set -e
test "$PREFLIGHT_RC" = 6 || fail "ordinary writer does not fail closed on a different gitleaks version"
test "$(git -C "$PREFLIGHT_REPO" rev-parse HEAD)" = "$PREFLIGHT_LOCAL_BEFORE" ||
	fail "ordinary writer commits before validating gitleaks"
test "$(git --git-dir="$VERIFY_ORIGIN" rev-parse refs/heads/main)" = "$PREFLIGHT_REMOTE_BEFORE" ||
	fail "ordinary writer changes remote before validating gitleaks"
pass "ordinary writer validates repository hooks and scanner before mutation"

ORIGIN_PREFLIGHT_REPO="$TASK_TMP_DIR/origin-preflight-repo"
ORIGIN_WRONG="$TASK_TMP_DIR/origin-wrong.git"
git clone -q "$VERIFY_ORIGIN" "$ORIGIN_PREFLIGHT_REPO"
git clone -q --bare "$VERIFY_ORIGIN" "$ORIGIN_WRONG"
git -C "$ORIGIN_PREFLIGHT_REPO" config user.name "FLY-2146 Origin Test"
git -C "$ORIGIN_PREFLIGHT_REPO" config user.email "fly2146-origin@example.test"
git -C "$ORIGIN_PREFLIGHT_REPO" config core.hooksPath .githooks
ORIGIN_LOCAL_BEFORE="$(git -C "$ORIGIN_PREFLIGHT_REPO" rev-parse HEAD)"
ORIGIN_GOOD_BEFORE="$(git --git-dir="$VERIFY_ORIGIN" rev-parse refs/heads/main)"
ORIGIN_WRONG_BEFORE="$(git --git-dir="$ORIGIN_WRONG" rev-parse refs/heads/main)"
git -C "$ORIGIN_PREFLIGHT_REPO" config remote.origin.pushurl "$ORIGIN_WRONG"
printf 'must stay local with a wrong push URL\n' >>"$ORIGIN_PREFLIGHT_REPO/alpha-lead/MEMORY.md"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_LEAD_ID=alpha-lead \
	"$ORIGIN_PREFLIGHT_REPO/write-memory.sh" >"$TASK_TMP_DIR/write-memory-origin.output" 2>&1
ORIGIN_PREFLIGHT_RC=$?
set -e
test "$ORIGIN_PREFLIGHT_RC" = 10 || fail "ordinary writer does not identify a noncanonical origin as status 10"
test "$(git -C "$ORIGIN_PREFLIGHT_REPO" rev-parse HEAD)" = "$ORIGIN_LOCAL_BEFORE" ||
	fail "ordinary writer commits before rejecting a noncanonical origin"
test "$(git --git-dir="$VERIFY_ORIGIN" rev-parse refs/heads/main)" = "$ORIGIN_GOOD_BEFORE" ||
	fail "ordinary writer changes canonical remote before rejecting a noncanonical origin"
test "$(git --git-dir="$ORIGIN_WRONG" rev-parse refs/heads/main)" = "$ORIGIN_WRONG_BEFORE" ||
	fail "ordinary writer publishes private memory to a noncanonical push URL"
ORIGIN_REWRITE_REPO="$TASK_TMP_DIR/origin-rewrite-repo"
git clone -q "$VERIFY_ORIGIN" "$ORIGIN_REWRITE_REPO"
git -C "$ORIGIN_REWRITE_REPO" config user.name "FLY-2146 Origin Rewrite Test"
git -C "$ORIGIN_REWRITE_REPO" config user.email "fly2146-origin-rewrite@example.test"
git -C "$ORIGIN_REWRITE_REPO" config core.hooksPath .githooks
git -C "$ORIGIN_REWRITE_REPO" config "url.$ORIGIN_WRONG.insteadOf" "$VERIFY_ORIGIN"
ORIGIN_REWRITE_HEAD_BEFORE="$(git -C "$ORIGIN_REWRITE_REPO" rev-parse HEAD)"
printf 'must stay local with a rewritten origin\n' >>"$ORIGIN_REWRITE_REPO/alpha-lead/MEMORY.md"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_LEAD_ID=alpha-lead \
	"$ORIGIN_REWRITE_REPO/write-memory.sh" >"$TASK_TMP_DIR/write-memory-origin-rewrite.output" 2>&1
ORIGIN_REWRITE_RC=$?
set -e
test "$ORIGIN_REWRITE_RC" = 10 || fail "ordinary writer accepts a resolved noncanonical origin"
test "$(git -C "$ORIGIN_REWRITE_REPO" rev-parse HEAD)" = "$ORIGIN_REWRITE_HEAD_BEFORE" ||
	fail "ordinary writer commits before rejecting a rewritten origin"
test "$(git --git-dir="$ORIGIN_WRONG" rev-parse refs/heads/main)" = "$ORIGIN_WRONG_BEFORE" ||
	fail "ordinary writer publishes private memory through insteadOf"
pass "ordinary writer rejects a noncanonical origin before mutation"

assert_writer_sync_state_preflight() {
	local state_shape="$1" root="$TASK_TMP_DIR/state-preflight-$1"
	local state_repo="$root/repo" state_origin="$root/origin.git" state_flywheel="$root/flywheel"
	local state_store="$root/state" writer_rc sync_rc head_before
	mkdir -p "$state_flywheel/scripts/lead-memory/lib" "$state_flywheel/scripts/lib"
	git init -q --bare --initial-branch=main "$state_origin"
	git init -q -b main "$state_repo"
	git -C "$state_repo" config user.name "FLY-2146 State Preflight"
	git -C "$state_repo" config user.email "fly2146-state@example.test"
	git -C "$state_repo" remote add origin "$state_origin"
	"$REPO_ROOT/scripts/lead-memory/sync-template.sh" "$state_repo" >/dev/null
	replace_constant_once "$state_repo/write-memory.sh" REMOTE_URL "$state_origin"
	git -C "$state_repo" config core.hooksPath .githooks
	mkdir -p "$state_repo/alpha-lead"
	printf 'initial\n' >"$state_repo/alpha-lead/MEMORY.md"
	git -C "$state_repo" add -A
	env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_MEMORY_ACTOR=admin \
		git -C "$state_repo" commit -q -m initial
	env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_MEMORY_ACTOR=admin \
		git -C "$state_repo" push -q -u origin main
	cp "$SYNC_SOURCE" "$state_flywheel/scripts/lead-memory/sync.sh"
	cp "$COMMON" "$state_flywheel/scripts/lead-memory/lib/sync-common.sh"
	cp "$REPO_ROOT/scripts/lib/bounded-run.sh" "$state_flywheel/scripts/lib/bounded-run.sh"
	chmod 755 "$state_flywheel/scripts/lead-memory/sync.sh" "$state_flywheel/scripts/lib/bounded-run.sh"
	replace_constant_once "$state_flywheel/scripts/lead-memory/lib/sync-common.sh" REMOTE_URL "$state_origin"
	replace_constant_once "$state_flywheel/scripts/lead-memory/lib/sync-common.sh" MEMORY_PATH "$state_repo"
	case "$state_shape" in
		detached) git -C "$state_repo" checkout -q --detach HEAD ;;
		rebase-merge | rebase-apply) mkdir "$state_repo/.git/$state_shape" ;;
		*) fail "unknown state preflight fixture: $state_shape" ;;
	esac
	printf 'must remain pending\n' >>"$state_repo/alpha-lead/MEMORY.md"
	head_before="$(git -C "$state_repo" rev-parse HEAD)"
	git -C "$state_repo" diff --cached --raw -z >"$root/index-before"
	set +e
	env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_LEAD_ID=alpha-lead \
		"$state_repo/write-memory.sh" >"$root/writer.output" 2>&1
	writer_rc=$?
	env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$state_store" \
		"$state_flywheel/scripts/lead-memory/sync.sh" >"$root/sync.output" 2>&1
	sync_rc=$?
	set -e
	test "$writer_rc" = 6 && test "$sync_rc" = 6 ||
		fail "writer state preflight drifts from sync for $state_shape (writer=$writer_rc sync=$sync_rc)"
	test "$(git -C "$state_repo" rev-parse HEAD)" = "$head_before" ||
		fail "state preflight changes HEAD for $state_shape"
	git -C "$state_repo" diff --cached --raw -z >"$root/index-after"
	cmp -s "$root/index-before" "$root/index-after" ||
		fail "state preflight changes the index for $state_shape"
}
assert_writer_sync_state_preflight detached
assert_writer_sync_state_preflight rebase-merge
assert_writer_sync_state_preflight rebase-apply
pass "ordinary and scheduled writers reject the same unsafe repository states"

bash -c '
set -u
. "$1"
export FLYWHEEL_LEAD_ID=alpha-lead
export FLYWHEEL_MEMORY_ACTOR=admin
sync_run_or_interrupt() {
	[[ "${FLYWHEEL_LEAD_ID+x}" != x ]] || return 97
	[[ "${FLYWHEEL_MEMORY_ACTOR:-}" == sync ]] || return 98
	return 42
}
set +e
sync_actor_run 1 true
rc=$?
set -e
[[ "$rc" == 42 ]]
[[ "$FLYWHEEL_LEAD_ID" == alpha-lead ]]
[[ "$FLYWHEEL_MEMORY_ACTOR" == admin ]]
unset FLYWHEEL_LEAD_ID FLYWHEEL_MEMORY_ACTOR
sync_run_or_interrupt() {
	[[ "${FLYWHEEL_LEAD_ID+x}" != x ]] || return 97
	[[ "${FLYWHEEL_MEMORY_ACTOR:-}" == sync ]] || return 98
}
sync_actor_run 1 true
[[ "${FLYWHEEL_LEAD_ID+x}" != x ]]
[[ "${FLYWHEEL_MEMORY_ACTOR+x}" != x ]]
' _ "$SYNC_FIXTURE/scripts/lead-memory/sync.sh" || fail "sync actor isolation does not restore its inherited environment"
pass "sync actor isolation sets sync privilege only around the bounded Git child"

AHEAD_ORIGIN="$TASK_TMP_DIR/write-ahead-origin.git"
AHEAD_REPO="$TASK_TMP_DIR/write-ahead-repo"
AHEAD_PEER="$TASK_TMP_DIR/write-ahead-peer"
git init -q --bare --initial-branch=main "$AHEAD_ORIGIN"
git init -q -b main "$AHEAD_REPO"
git -C "$AHEAD_REPO" config user.name "FLY-2146 Ahead Writer"
git -C "$AHEAD_REPO" config user.email "fly2146-ahead@example.test"
git -C "$AHEAD_REPO" remote add origin "$AHEAD_ORIGIN"
"$REPO_ROOT/scripts/lead-memory/sync-template.sh" "$AHEAD_REPO" >/dev/null
replace_constant_once "$AHEAD_REPO/write-memory.sh" REMOTE_URL "$AHEAD_ORIGIN"
git -C "$AHEAD_REPO" config core.hooksPath .githooks
mkdir -p "$AHEAD_REPO/alpha-lead" "$AHEAD_REPO/beta-lead"
printf 'alpha v1\n' >"$AHEAD_REPO/alpha-lead/MEMORY.md"
printf 'beta v1\n' >"$AHEAD_REPO/beta-lead/MEMORY.md"
git -C "$AHEAD_REPO" add -A
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_MEMORY_ACTOR=admin \
	git -C "$AHEAD_REPO" commit -q -m initial
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_MEMORY_ACTOR=admin \
	git -C "$AHEAD_REPO" push -q -u origin main
git clone -q "$AHEAD_ORIGIN" "$AHEAD_PEER"
git -C "$AHEAD_PEER" config user.name "FLY-2146 Ahead Peer"
git -C "$AHEAD_PEER" config user.email "fly2146-ahead-peer@example.test"
printf 'beta from peer\n' >>"$AHEAD_PEER/beta-lead/MEMORY.md"
git -C "$AHEAD_PEER" commit -q -am "peer advances remote"
git -C "$AHEAD_PEER" push -q origin main
printf 'alpha pending locally\n' >>"$AHEAD_REPO/alpha-lead/MEMORY.md"
printf 'Finder metadata\n' >"$AHEAD_REPO/.DS_Store"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_LEAD_ID=alpha-lead \
	"$AHEAD_REPO/write-memory.sh" >"$TASK_TMP_DIR/write-memory-ahead.output" 2>&1
AHEAD_RC=$?
set -e
test "$AHEAD_RC" = 0 || {
	sed 's/^/  /' "$TASK_TMP_DIR/write-memory-ahead.output" >&2
	fail "ordinary writer cannot publish its own dirty folder after remote advances"
}
AHEAD_REMOTE="$(git --git-dir="$AHEAD_ORIGIN" rev-parse refs/heads/main)"
test "$AHEAD_REMOTE" = "$(git -C "$AHEAD_REPO" rev-parse HEAD)" ||
	fail "ordinary writer reports remote-ahead recovery before remote arrival"
test "$(git --git-dir="$AHEAD_ORIGIN" show "$AHEAD_REMOTE:alpha-lead/MEMORY.md")" = $'alpha v1\nalpha pending locally' ||
	fail "remote-ahead recovery loses the current Lead write"
test "$(git --git-dir="$AHEAD_ORIGIN" show "$AHEAD_REMOTE:beta-lead/MEMORY.md")" = $'beta v1\nbeta from peer' ||
	fail "remote-ahead recovery loses the peer Lead write"
test "$(git --git-dir="$AHEAD_ORIGIN" show -s --format=%B "$AHEAD_REMOTE" | grep -c '^Memory-Owner: alpha-lead$')" = 1 ||
	fail "remote-ahead recovery loses the current Lead owner"
test -z "$(git -C "$AHEAD_REPO" status --porcelain=v1 -- .DS_Store)" ||
	fail "root OS metadata is not ignored by the memory repository"
pass "ordinary writer commits its own dirty folder, rebases, and reaches an advanced remote"

git -C "$AHEAD_PEER" pull -q --rebase origin main
printf 'beta advances again\n' >>"$AHEAD_PEER/beta-lead/MEMORY.md"
git -C "$AHEAD_PEER" commit -q -am "peer advances before admin publication"
git -C "$AHEAD_PEER" push -q origin main
printf 'admin publication pending\n' >>"$AHEAD_REPO/README.md"
git -C "$AHEAD_REPO" add -- README.md
AHEAD_INDEX_BEFORE="$TASK_TMP_DIR/ahead-index-before"
git -C "$AHEAD_REPO" diff --cached --raw -z >"$AHEAD_INDEX_BEFORE"
AHEAD_SYNC_FIXTURE="$TASK_TMP_DIR/ahead-sync-fixture"
cp -R "$SYNC_FIXTURE" "$AHEAD_SYNC_FIXTURE"
replace_constant_once "$AHEAD_SYNC_FIXTURE/scripts/lead-memory/lib/sync-common.sh" REMOTE_URL "$AHEAD_ORIGIN"
replace_constant_once "$AHEAD_SYNC_FIXTURE/scripts/lead-memory/lib/sync-common.sh" MEMORY_PATH "$AHEAD_REPO"
AHEAD_SYNC_STATE="$TASK_TMP_DIR/ahead-sync-state"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$AHEAD_SYNC_STATE" \
	"$AHEAD_SYNC_FIXTURE/scripts/lead-memory/sync.sh" >"$TASK_TMP_DIR/ahead-sync.output" 2>&1
AHEAD_SYNC_RC=$?
set -e
test "$AHEAD_SYNC_RC" = 3 || fail "scheduled sync does not defer staged non-Lead work before rebase"
jq -e '.exit_code == 3 and .reason == "dirty_rebase_deferred"' \
	"$AHEAD_SYNC_STATE/state/lead-memory/sync/last-receipt.json" >/dev/null ||
	fail "staged non-Lead rebase deferral lacks an exit-3 receipt"
git -C "$AHEAD_REPO" diff --cached --raw -z >"$TASK_TMP_DIR/ahead-index-after"
cmp -s "$AHEAD_INDEX_BEFORE" "$TASK_TMP_DIR/ahead-index-after" ||
	fail "rebase deferral changes the staged admin publication"
test ! -e "$AHEAD_REPO/.git/rebase-merge" && test ! -e "$AHEAD_REPO/.git/rebase-apply" ||
	fail "staged non-Lead work reaches git rebase"
git -C "$AHEAD_REPO" reset -q -- README.md
git -C "$AHEAD_REPO" checkout -q -- README.md
pass "scheduled sync defers whole-repository tracked dirt before rebase"

FAST_SYNC="$SYNC_FIXTURE/scripts/lead-memory/sync-fast.sh"
cp "$SYNC_FIXTURE/scripts/lead-memory/sync.sh" "$FAST_SYNC"
replace_constant_once "$FAST_SYNC" SYNC_LOCK_WAIT_SECONDS 0
chmod 755 "$FAST_SYNC"
LOCK_HOLDER_READY="$TASK_TMP_DIR/writer-holder.ready"
bash -c '. "$1"; lm_writer_lock_acquire "$2" 0 || exit; : >"$3"; while :; do :; done' _ \
	"$SYNC_FIXTURE/scripts/lead-memory/lib/sync-common.sh" "$WRITER_REPO" "$LOCK_HOLDER_READY" &
LOCK_HOLDER_PID=$!
for _ in 1 2 3 4 5; do test -e "$LOCK_HOLDER_READY" && break; sleep 0.1; done
test -e "$LOCK_HOLDER_READY" || fail "scheduled writer lock holder did not start"
RUNS_BEFORE="$(shasum -a 256 "$WRITER_STATE/state/lead-memory/sync/runs.tsv" | awk '{print $1}')"
REMOTE_BEFORE="$(git --git-dir="$WRITER_ORIGIN" rev-parse refs/heads/main)"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$WRITER_STATE" "$FAST_SYNC" \
	>"$TASK_TMP_DIR/lock-busy.output" 2>&1
LOCK_TIMEOUT_RC=$?
set -e
kill -9 "$LOCK_HOLDER_PID"
wait "$LOCK_HOLDER_PID" 2>/dev/null || true
test "$LOCK_TIMEOUT_RC" = 75 || fail "scheduled writer lock timeout is not normalized to 75"
test "$(shasum -a 256 "$WRITER_STATE/state/lead-memory/sync/runs.tsv" | awk '{print $1}')" = "$RUNS_BEFORE" ||
	fail "lock-timeout writer changed runs.tsv"
test "$(git --git-dir="$WRITER_ORIGIN" rev-parse refs/heads/main)" = "$REMOTE_BEFORE" ||
	fail "lock-timeout writer changed remote main"
pass "scheduled writer lock timeout is a side-effect-free retryable 75"

test "$(sed -n 's/^SYNC_LOCK_HOLD_MAX_SECONDS=//p' "$SYNC_SOURCE")" = 600 ||
	fail "scheduled writer hold ceiling is not 600 seconds"
test "$(sed -n 's/^LEAD_WRITE_LOCK_WAIT_SECONDS=//p' "$WRITE_SOURCE")" = 660 ||
	fail "ordinary writer wait budget is not 660 seconds"
test "$(sed -n 's/^LEAD_WRITE_HOLD_MAX_SECONDS=//p' "$WRITE_SOURCE")" = 600 ||
	fail "ordinary writer hold ceiling is not 600 seconds"

STUCK_WRITE="$WRITER_REPO/write-memory-stuck.sh"
cp "$WRITE_SOURCE" "$STUCK_WRITE"
replace_constant_once "$STUCK_WRITE" REMOTE_URL "$WRITER_ORIGIN"
replace_constant_once "$STUCK_WRITE" LEAD_WRITE_LOCK_WAIT_SECONDS 3
replace_constant_once "$STUCK_WRITE" LEAD_WRITE_HOLD_MAX_SECONDS 15
replace_constant_once "$STUCK_WRITE" LEAD_WRITE_COMMAND_MAX_SECONDS 30
chmod 755 "$STUCK_WRITE"
STUCK_BIN="$TASK_TMP_DIR/stuck-write-bin"
mkdir "$STUCK_BIN"
cat >"$STUCK_BIN/git" <<'STUB'
#!/bin/sh
case " $* " in
  *" fetch origin main "*)
    : >"${STUCK_WRITE_READY:?}"
    sleep 20
    ;;
esac
exec "${REAL_GIT:?}" "$@"
STUB
chmod 755 "$STUCK_BIN/git"
ln -s "$GITLEAKS_BIN/gitleaks" "$STUCK_BIN/gitleaks"
REAL_GIT="$(command -v git)"
export REAL_GIT
STUCK_WRITE_READY="$TASK_TMP_DIR/stuck-write.ready"
export STUCK_WRITE_READY
printf 'stuck ordinary writer payload\n' >>"$WRITER_REPO/alpha-lead/MEMORY.md"
STUCK_CONTENT_BEFORE="$(shasum -a 256 "$WRITER_REPO/alpha-lead/MEMORY.md" | awk '{print $1}')"
git -C "$WRITER_REPO" diff --cached --raw -z >"$TASK_TMP_DIR/stuck-index-before"
env PATH="$STUCK_BIN:$PATH" FLYWHEEL_LEAD_ID=alpha-lead \
	"$STUCK_WRITE" >"$TASK_TMP_DIR/stuck-write.output" 2>&1 &
STUCK_WRITE_PID=$!
for _ in $(seq 1 200); do test -e "$STUCK_WRITE_READY" && break; sleep 0.1; done
test -e "$STUCK_WRITE_READY" || fail "ordinary writer did not enter its bounded Git operation"
RUNS_BEFORE="$(shasum -a 256 "$WRITER_STATE/state/lead-memory/sync/runs.tsv" | awk '{print $1}')"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$WRITER_STATE" "$FAST_SYNC" \
	>"$TASK_TMP_DIR/stuck-sync.output" 2>&1
STUCK_SYNC_RC=$?
wait "$STUCK_WRITE_PID"
STUCK_WRITE_RC=$?
set -e
test "$STUCK_SYNC_RC" = 75 || fail "sync does not defer behind a stuck ordinary writer"
test "$STUCK_WRITE_RC" = 75 || fail "ordinary writer total hold deadline does not normalize to 75"
test "$(shasum -a 256 "$WRITER_STATE/state/lead-memory/sync/runs.tsv" | awk '{print $1}')" = "$RUNS_BEFORE" ||
	fail "sync lock contention changes runs.tsv"
test "$(shasum -a 256 "$WRITER_REPO/alpha-lead/MEMORY.md" | awk '{print $1}')" = "$STUCK_CONTENT_BEFORE" ||
	fail "stuck ordinary writer changes the pending memory file"
git -C "$WRITER_REPO" diff --cached --raw -z >"$TASK_TMP_DIR/stuck-index-after"
cmp -s "$TASK_TMP_DIR/stuck-index-before" "$TASK_TMP_DIR/stuck-index-after" ||
	fail "stuck ordinary writer changes the existing staged set"
rm -f -- "$STUCK_WRITE"
pass "stuck ordinary writer is bounded while sync defers without evidence churn"

LOCAL_STUCK_WRITE="$WRITER_REPO/write-memory-local-stuck.sh"
cp "$WRITE_SOURCE" "$LOCAL_STUCK_WRITE"
replace_constant_once "$LOCAL_STUCK_WRITE" REMOTE_URL "$WRITER_ORIGIN"
replace_constant_once "$LOCAL_STUCK_WRITE" LEAD_WRITE_LOCK_WAIT_SECONDS 3
replace_constant_once "$LOCAL_STUCK_WRITE" LEAD_WRITE_HOLD_MAX_SECONDS 2
replace_constant_once "$LOCAL_STUCK_WRITE" LEAD_WRITE_COMMAND_MAX_SECONDS 10
chmod 755 "$LOCAL_STUCK_WRITE"
LOCAL_STUCK_BIN="$TASK_TMP_DIR/local-stuck-write-bin"
mkdir "$LOCAL_STUCK_BIN"
cat >"$LOCAL_STUCK_BIN/git" <<'STUB'
#!/bin/sh
case " $* " in
  *" diff --cached --raw -z "*)
    : >"${LOCAL_STUCK_READY:?}"
    sleep 10
    ;;
esac
exec "${REAL_GIT:?}" "$@"
STUB
chmod 755 "$LOCAL_STUCK_BIN/git"
ln -s "$GITLEAKS_BIN/gitleaks" "$LOCAL_STUCK_BIN/gitleaks"
LOCAL_STUCK_READY="$TASK_TMP_DIR/local-stuck.ready"
export LOCAL_STUCK_READY
LOCAL_STUCK_STARTED="$(date +%s)"
set +e
env PATH="$LOCAL_STUCK_BIN:$PATH" FLYWHEEL_LEAD_ID=alpha-lead \
	"$LOCAL_STUCK_WRITE" >"$TASK_TMP_DIR/local-stuck.output" 2>&1
LOCAL_STUCK_RC=$?
set -e
LOCAL_STUCK_ELAPSED=$(( $(date +%s) - LOCAL_STUCK_STARTED ))
test -e "$LOCAL_STUCK_READY" || fail "ordinary writer local-Git stall fixture did not run"
test "$LOCAL_STUCK_RC" = 75 || fail "ordinary writer local-Git stall does not normalize to 75"
test "$LOCAL_STUCK_ELAPSED" -le 6 || fail "ordinary writer hold cap excludes an unbounded local Git command"
rm -f -- "$LOCAL_STUCK_WRITE"
pass "ordinary writer whole-lock budget also bounds local Git operations"

make_deadline_case() {
	local root="$TASK_TMP_DIR/deadline"
	DEADLINE_REPO="$root/repo"
	DEADLINE_TREE="$root/flywheel"
	DEADLINE_STATE="$root/state"
	DEADLINE_ORIGIN="$root/origin.git"
	mkdir -p "$DEADLINE_TREE/scripts/lead-memory/lib" "$DEADLINE_TREE/scripts/lib"
	git init -q --bare --initial-branch=main "$DEADLINE_ORIGIN"
	git init -q -b main "$DEADLINE_REPO"
	git -C "$DEADLINE_REPO" config user.name "FLY-2146 Deadline"
	git -C "$DEADLINE_REPO" config user.email "deadline@example.test"
	git -C "$DEADLINE_REPO" remote add origin "$DEADLINE_ORIGIN"
	"$REPO_ROOT/scripts/lead-memory/sync-template.sh" "$DEADLINE_REPO" >/dev/null
	replace_constant_once "$DEADLINE_REPO/write-memory.sh" REMOTE_URL "$DEADLINE_ORIGIN"
	git -C "$DEADLINE_REPO" config core.hooksPath .githooks
	mkdir -p "$DEADLINE_REPO/alpha-lead"
	printf 'initial\n' >"$DEADLINE_REPO/alpha-lead/MEMORY.md"
	git -C "$DEADLINE_REPO" add -A
	env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_MEMORY_ACTOR=admin git -C "$DEADLINE_REPO" commit -q -m initial
	env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_MEMORY_ACTOR=admin git -C "$DEADLINE_REPO" push -q -u origin main
	cp "$SYNC_SOURCE" "$DEADLINE_TREE/scripts/lead-memory/sync.sh"
	cp "$COMMON" "$DEADLINE_TREE/scripts/lead-memory/lib/sync-common.sh"
	cp "$REPO_ROOT/scripts/lib/bounded-run.sh" "$DEADLINE_TREE/scripts/lib/bounded-run.sh"
	replace_constant_once "$DEADLINE_TREE/scripts/lead-memory/lib/sync-common.sh" REMOTE_URL "$DEADLINE_ORIGIN"
	replace_constant_once "$DEADLINE_TREE/scripts/lead-memory/lib/sync-common.sh" MEMORY_PATH "$DEADLINE_REPO"
	replace_constant_once "$DEADLINE_TREE/scripts/lead-memory/sync.sh" SYNC_LOCK_HOLD_MAX_SECONDS 10
	chmod 755 "$DEADLINE_TREE/scripts/lead-memory/sync.sh" "$DEADLINE_TREE/scripts/lib/bounded-run.sh"
}
make_deadline_case
HOOK_READY="$TASK_TMP_DIR/deadline-hook.ready"
python3 - "$DEADLINE_REPO/.githooks/pre-commit" <<'PY'
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
needle = "set -eu\n"
if text.count(needle) != 1:
    raise SystemExit("pre-commit set -eu declaration must occur exactly once")
path.write_text(text.replace(needle, 'set -eu\n: >"${TEST_HOOK_READY:?}"\nsleep 20\n', 1))
PY
printf 'deadline payload\n' >>"$DEADLINE_REPO/alpha-lead/MEMORY.md"
DEADLINE_INDEX_BEFORE="$TASK_TMP_DIR/deadline-index-before"
git -C "$DEADLINE_REPO" diff --cached --raw -z >"$DEADLINE_INDEX_BEFORE"
DEADLINE_CONTENDER="$DEADLINE_REPO/write-memory-contender.sh"
cp "$WRITE_SOURCE" "$DEADLINE_CONTENDER"
replace_constant_once "$DEADLINE_CONTENDER" REMOTE_URL "$DEADLINE_ORIGIN"
replace_constant_once "$DEADLINE_CONTENDER" LEAD_WRITE_LOCK_WAIT_SECONDS 0
chmod 755 "$DEADLINE_CONTENDER"
DEADLINE_STARTED="$(date +%s)"
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$DEADLINE_STATE" TEST_HOOK_READY="$HOOK_READY" \
	"$DEADLINE_TREE/scripts/lead-memory/sync.sh" >"$TASK_TMP_DIR/deadline.output" 2>&1 &
DEADLINE_PID=$!
for _ in $(seq 1 90); do test -e "$HOOK_READY" && break; sleep 0.1; done
test -e "$HOOK_READY" || fail "scheduled writer deadline fixture did not reach the commit hook"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_LEAD_ID=alpha-lead "$DEADLINE_CONTENDER" \
	>"$TASK_TMP_DIR/deadline-contender.output" 2>&1
DEADLINE_CONTENDER_RC=$?
wait "$DEADLINE_PID"
DEADLINE_RC=$?
set -e
DEADLINE_ELAPSED=$(( $(date +%s) - DEADLINE_STARTED ))
test "$DEADLINE_CONTENDER_RC" = 75 ||
	fail "ordinary writer does not defer while sync owns the writer lock (rc=$DEADLINE_CONTENDER_RC; $(tr '\n' ' ' <"$TASK_TMP_DIR/deadline-contender.output"))"
test "$DEADLINE_RC" = 143 || fail "scheduled writer hold deadline is not normalized through TERM recovery"
test "$DEADLINE_ELAPSED" -le 15 || fail "scheduled writer exceeds its shortened whole-flow deadline"
jq -e '.exit_code == 143 and .reason == "interrupted" and .arrival_observation == "undetermined"' \
	"$DEADLINE_STATE/state/lead-memory/sync/last-receipt.json" >/dev/null ||
	fail "scheduled writer deadline lacks interruption evidence"
test -z "$(git -C "$DEADLINE_REPO" diff --cached --name-only -- alpha-lead/)" ||
	fail "scheduled writer deadline leaves its own staged paths behind"
git -C "$DEADLINE_REPO" diff --cached --raw -z >"$TASK_TMP_DIR/deadline-index-after"
cmp -s "$DEADLINE_INDEX_BEFORE" "$TASK_TMP_DIR/deadline-index-after" ||
	fail "sync/ordinary contention loses the pre-existing staged set"
rm -f -- "$DEADLINE_CONTENDER"
pass "scheduled writer enforces its deadline while an ordinary writer defers without interleaving"

WRONG_GITLEAKS="$TASK_TMP_DIR/wrong-gitleaks"
mkdir "$WRONG_GITLEAKS"
cat >"$WRONG_GITLEAKS/gitleaks" <<'STUB'
#!/bin/sh
if test "${1:-}" = version; then printf '8.29.0\n'; fi
exit 0
STUB
chmod 755 "$WRONG_GITLEAKS/gitleaks"
HEAD_BEFORE="$(git -C "$WRITER_REPO" rev-parse HEAD)"
set +e
env PATH="$WRONG_GITLEAKS:$PATH" FLYWHEEL_STATE_DIR="$WRITER_STATE" \
	"$SYNC_FIXTURE/scripts/lead-memory/sync.sh" >"$TASK_TMP_DIR/preflight.output" 2>&1
PREFLIGHT_RC=$?
set -e
test "$PREFLIGHT_RC" = 6 || fail "writer preflight failure does not return 6"
test "$(git -C "$WRITER_REPO" rev-parse HEAD)" = "$HEAD_BEFORE" || fail "preflight failure changes repository HEAD"
jq -e '.exit_code == 6 and .reason == "preflight_failed" and .arrival_observation == "undetermined"' \
	"$RECEIPT" >/dev/null || fail "preflight failure lacks an undetermined receipt"
pass "scheduled writer records fail-closed preflight without changing memory"

INVALID_ROOT_TREE="$TASK_TMP_DIR/invalid-root-flywheel"
INVALID_ROOT="$TASK_TMP_DIR/not-a-repository"
INVALID_ROOT_STATE="$TASK_TMP_DIR/invalid-root-state"
mkdir -p "$INVALID_ROOT_TREE/scripts/lead-memory/lib" "$INVALID_ROOT_TREE/scripts/lib" "$INVALID_ROOT"
cp "$SYNC_SOURCE" "$INVALID_ROOT_TREE/scripts/lead-memory/sync.sh"
cp "$COMMON" "$INVALID_ROOT_TREE/scripts/lead-memory/lib/sync-common.sh"
cp "$REPO_ROOT/scripts/lib/bounded-run.sh" "$INVALID_ROOT_TREE/scripts/lib/bounded-run.sh"
replace_constant_once "$INVALID_ROOT_TREE/scripts/lead-memory/lib/sync-common.sh" MEMORY_PATH "$INVALID_ROOT"
chmod 755 "$INVALID_ROOT_TREE/scripts/lead-memory/sync.sh" "$INVALID_ROOT_TREE/scripts/lib/bounded-run.sh"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$INVALID_ROOT_STATE" \
	"$INVALID_ROOT_TREE/scripts/lead-memory/sync.sh" >"$TASK_TMP_DIR/invalid-root.output" 2>&1
INVALID_ROOT_RC=$?
set -e
test "$INVALID_ROOT_RC" = 6 || fail "invalid repository root does not return preflight 6"
jq -e '.exit_code == 6 and .reason == "preflight_failed" and .arrival_observation == "undetermined"' \
	"$INVALID_ROOT_STATE/state/lead-memory/sync/last-receipt.json" >/dev/null ||
	fail "repository-root preflight failure lacks durable evidence"

make_sync_case() {
	local name="$1" case_root
	case_root="$TASK_TMP_DIR/$name"
	CASE_REPO="$case_root/repo"
	CASE_TREE="$case_root/flywheel"
	CASE_STATE="$case_root/state"
	mkdir -p "$CASE_TREE/scripts/lead-memory/lib" "$CASE_TREE/scripts/lib"
	git clone -q "$WRITER_ORIGIN" "$CASE_REPO"
	git -C "$CASE_REPO" config user.name "FLY-2146 $name"
	git -C "$CASE_REPO" config user.email "$name@example.test"
	git -C "$CASE_REPO" config core.hooksPath .githooks
	cp "$SYNC_SOURCE" "$CASE_TREE/scripts/lead-memory/sync.sh"
	cp "$COMMON" "$CASE_TREE/scripts/lead-memory/lib/sync-common.sh"
	cp "$REPO_ROOT/scripts/lib/bounded-run.sh" "$CASE_TREE/scripts/lib/bounded-run.sh"
	chmod 755 "$CASE_TREE/scripts/lead-memory/sync.sh" "$CASE_TREE/scripts/lib/bounded-run.sh"
	replace_constant_once "$CASE_TREE/scripts/lead-memory/lib/sync-common.sh" REMOTE_URL "$WRITER_ORIGIN"
	replace_constant_once "$CASE_TREE/scripts/lead-memory/lib/sync-common.sh" MEMORY_PATH "$CASE_REPO"
}

make_sync_case local-git-deadline
mkdir -p "$CASE_REPO/gamma-lead"
printf 'local git must not outlive the writer deadline\n' >"$CASE_REPO/gamma-lead/MEMORY.md"
python3 - "$CASE_TREE/scripts/lead-memory/sync.sh" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()
needle = '''\t\tif ! sync_run_or_interrupt "$SYNC_LOCK_HOLD_MAX_SECONDS" \\
\t\t\tgit -C "$MEMORY_PATH" add -A -- "$folder/"; then'''
replacement = '''\t\tif [[ "$folder" == gamma-lead ]]; then
\t\t\tsync_deadline_stop
\t\t\thold_started=$SECONDS
\t\t\tSYNC_LOCK_HOLD_MAX_SECONDS=4
\t\t\tsync_deadline_start
\t\tfi
''' + needle
if text.count(needle) != 1:
    raise SystemExit(f"local-Git deadline seam: expected one add call, found {text.count(needle)}")
path.write_text(text.replace(needle, replacement, 1))
PY
LOCAL_GIT_DEADLINE_BIN="$TASK_TMP_DIR/local-git-deadline-bin"
LOCAL_GIT_DEADLINE_READY="$TASK_TMP_DIR/local-git-deadline.ready"
mkdir "$LOCAL_GIT_DEADLINE_BIN"
cat >"$LOCAL_GIT_DEADLINE_BIN/git" <<'STUB'
#!/bin/sh
case " $* " in
  *" add -A -- gamma-lead/ "*)
    : >"${LOCAL_GIT_DEADLINE_READY:?}"
    sleep 20
    ;;
esac
exec "${REAL_GIT:?}" "$@"
STUB
chmod 755 "$LOCAL_GIT_DEADLINE_BIN/git"
ln -s "$GITLEAKS_BIN/gitleaks" "$LOCAL_GIT_DEADLINE_BIN/gitleaks"
LOCAL_GIT_DEADLINE_STARTED="$(date +%s)"
set +e
env PATH="$LOCAL_GIT_DEADLINE_BIN:$PATH" REAL_GIT="$REAL_GIT" \
	LOCAL_GIT_DEADLINE_READY="$LOCAL_GIT_DEADLINE_READY" FLYWHEEL_STATE_DIR="$CASE_STATE" \
	"$CASE_TREE/scripts/lead-memory/sync.sh" >"$TASK_TMP_DIR/local-git-deadline.output" 2>&1
LOCAL_GIT_DEADLINE_RC=$?
set -e
LOCAL_GIT_DEADLINE_ELAPSED=$(( $(date +%s) - LOCAL_GIT_DEADLINE_STARTED ))
test -e "$LOCAL_GIT_DEADLINE_READY" || fail "scheduled writer local-Git deadline fixture did not run"
test "$LOCAL_GIT_DEADLINE_RC" = 143 || fail "scheduled writer local-Git deadline is not normalized to 143"
test "$LOCAL_GIT_DEADLINE_ELAPSED" -le 8 || fail "scheduled writer waits past its whole-flow deadline for local Git"
jq -e '.exit_code == 143 and .reason == "interrupted" and .arrival_observation == "undetermined"' \
	"$CASE_STATE/state/lead-memory/sync/last-receipt.json" >/dev/null ||
	fail "scheduled writer local-Git deadline lacks interruption evidence"
test -z "$(git -C "$CASE_REPO" diff --cached --name-only -- gamma-lead/)" ||
	fail "scheduled writer local-Git deadline leaves its own staged paths behind"
pass "scheduled writer whole-flow deadline bounds local Git and recovers its index"

make_sync_case unsafe-lock
printf 'outside lock target\n' >"$TASK_TMP_DIR/outside-writer-lock"
ln -s "$TASK_TMP_DIR/outside-writer-lock" "$CASE_REPO/.git/flywheel-writer.lock"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$CASE_STATE" \
	"$CASE_TREE/scripts/lead-memory/sync.sh" >"$TASK_TMP_DIR/unsafe-lock.output" 2>&1
UNSAFE_LOCK_RC=$?
set -e
test "$UNSAFE_LOCK_RC" = 6 || fail "unsafe writer-lock path does not return preflight 6"
jq -e '.exit_code == 6 and .reason == "preflight_failed"' \
	"$CASE_STATE/state/lead-memory/sync/last-receipt.json" >/dev/null ||
	fail "writer-lock preflight failure lacks durable evidence"
test "$(cat "$TASK_TMP_DIR/outside-writer-lock")" = 'outside lock target' ||
	fail "unsafe writer-lock preflight follows the symlink target"
pass "all preflight-6 paths persist evidence without mutating memory"

make_sync_case unreachable
mkdir -p "$CASE_REPO/gamma-lead"
printf 'must remain local\n' >"$CASE_REPO/gamma-lead/MEMORY.md"
MISSING_ORIGIN="$TASK_TMP_DIR/definitely-missing.git"
git -C "$CASE_REPO" remote set-url origin "$MISSING_ORIGIN"
replace_constant_once "$CASE_TREE/scripts/lead-memory/lib/sync-common.sh" REMOTE_URL "$MISSING_ORIGIN"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$CASE_STATE" \
	"$CASE_TREE/scripts/lead-memory/sync.sh" >"$TASK_TMP_DIR/unreachable.output" 2>&1
UNREACHABLE_RC=$?
set -e
test "$UNREACHABLE_RC" = 5 || fail "unreachable remote does not return not-arrived 5"
jq -e '.exit_code == 5 and .arrived == false and .arrival_observation == "undetermined" and .expected_local_sha != null' \
	"$CASE_STATE/state/lead-memory/sync/last-receipt.json" >/dev/null ||
	fail "unreachable remote receipt invents an arrival observation"
pass "scheduled writer treats an unreadable remote as undetermined, never delivered"

make_sync_case proxy-unreachable
mkdir -p "$CASE_REPO/gamma-lead"
printf 'must remain behind the closed proxy\n' >"$CASE_REPO/gamma-lead/MEMORY.md"
git -C "$CASE_REPO" remote set-url origin https://github.com/xrliAnnie/lead-memory.git
replace_constant_once "$CASE_TREE/scripts/lead-memory/lib/sync-common.sh" REMOTE_URL https://github.com/xrliAnnie/lead-memory.git
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$CASE_STATE" \
	https_proxy=http://127.0.0.1:1 HTTPS_PROXY=http://127.0.0.1:1 no_proxy= NO_PROXY= \
	"$CASE_TREE/scripts/lead-memory/sync.sh" >"$TASK_TMP_DIR/proxy-unreachable.output" 2>&1
PROXY_UNREACHABLE_RC=$?
set -e
test "$PROXY_UNREACHABLE_RC" = 5 || fail "closed-proxy remote failure does not return not-arrived 5"
jq -e '.exit_code == 5 and .arrived == false and .arrival_observation == "undetermined" and .push_rc == null' \
	"$CASE_STATE/state/lead-memory/sync/last-receipt.json" >/dev/null ||
	fail "closed-proxy negative control invents remote delivery"
pass "closed HTTPS proxy proves remote unreadability stays undetermined without a push"

make_git_wrapper() {
	local directory="$1" behavior="$2"
	mkdir -p "$directory"
	cat >"$directory/git" <<'STUB'
#!/bin/sh
case " $* " in
  *" fetch origin main "*)
    if test "${GIT_TEST_BEHAVIOR:-}" = fetch-fail; then exit 42; fi
    ;;
  *" push origin main "*)
    if test -n "${PUSH_OUTPUT_MODE_FILE:-}"; then
      python3 -c 'import os, pathlib, stat; pathlib.Path(os.environ["PUSH_OUTPUT_MODE_FILE"]).write_text(str(stat.S_IMODE(os.fstat(1).st_mode)))'
    fi
    case ${GIT_TEST_BEHAVIOR:-} in
      push-noop) exit 0 ;;
      push-then-fail) "$REAL_GIT" "$@" || exit; exit 42 ;;
    esac
    ;;
esac
exec "$REAL_GIT" "$@"
STUB
	chmod 755 "$directory/git"
	ln -s "$GITLEAKS_BIN/gitleaks" "$directory/gitleaks"
}

REAL_GIT="$(command -v git)"
export REAL_GIT
make_sync_case fetch-failure
FAKE_BIN="$TASK_TMP_DIR/fetch-failure/bin"
make_git_wrapper "$FAKE_BIN" fetch-fail
set +e
env PATH="$FAKE_BIN:$PATH" GIT_TEST_BEHAVIOR=fetch-fail FLYWHEEL_STATE_DIR="$CASE_STATE" \
	"$CASE_TREE/scripts/lead-memory/sync.sh" >"$TASK_TMP_DIR/fetch-failure.output" 2>&1
FETCH_FAILURE_RC=$?
set -e
test "$FETCH_FAILURE_RC" = 7 || fail "failed fetch with already-arrived HEAD does not return 7"
jq -e '.exit_code == 7 and .arrived == true and .fetch_rc == 42 and .push_rc == null' \
	"$CASE_STATE/state/lead-memory/sync/last-receipt.json" >/dev/null ||
	fail "fetch failure receipt claims a push result when no push was attempted"
pass "scheduled writer derives arrival from remote without inventing an unattempted push"

make_sync_case push-noop
mkdir -p "$CASE_REPO/gamma-lead"
printf 'push must move remote\n' >"$CASE_REPO/gamma-lead/MEMORY.md"
FAKE_BIN="$TASK_TMP_DIR/push-noop/bin"
make_git_wrapper "$FAKE_BIN" push-noop
PUSH_OUTPUT_MODE_FILE="$TASK_TMP_DIR/push-output.mode"
set +e
env PATH="$FAKE_BIN:$PATH" GIT_TEST_BEHAVIOR=push-noop PUSH_OUTPUT_MODE_FILE="$PUSH_OUTPUT_MODE_FILE" \
	FLYWHEEL_STATE_DIR="$CASE_STATE" \
	"$CASE_TREE/scripts/lead-memory/sync.sh" >"$TASK_TMP_DIR/push-noop.output" 2>&1
PUSH_NOOP_RC=$?
set -e
test "$PUSH_NOOP_RC" = 5 || fail "zero push status without remote movement is accepted"
test "$(cat "$PUSH_OUTPUT_MODE_FILE")" = 384 || fail "push hook output is not isolated in a 0600 file"
jq -e '.exit_code == 5 and .arrived == false and .arrival_observation == "observed" and .push_rc == 0' \
	"$CASE_STATE/state/lead-memory/sync/last-receipt.json" >/dev/null ||
	fail "no-op push receipt does not expose remote mismatch"
pass "scheduled writer rejects a successful push status when remote did not move"

make_sync_case push-then-fail
mkdir -p "$CASE_REPO/gamma-lead"
printf 'remote moves despite rc\n' >"$CASE_REPO/gamma-lead/MEMORY.md"
FAKE_BIN="$TASK_TMP_DIR/push-then-fail/bin"
make_git_wrapper "$FAKE_BIN" push-then-fail
set +e
env PATH="$FAKE_BIN:$PATH" GIT_TEST_BEHAVIOR=push-then-fail FLYWHEEL_STATE_DIR="$CASE_STATE" \
	"$CASE_TREE/scripts/lead-memory/sync.sh" >"$TASK_TMP_DIR/push-then-fail.output" 2>&1
PUSH_THEN_FAIL_RC=$?
set -e
test "$PUSH_THEN_FAIL_RC" = 7 || fail "nonzero push status after remote arrival does not return 7"
jq -e '.exit_code == 7 and .arrived == true and .arrival_observation == "observed" and .push_rc == 42' \
	"$CASE_STATE/state/lead-memory/sync/last-receipt.json" >/dev/null ||
	fail "push failure after arrival is not represented honestly"
pass "scheduled writer distinguishes remote arrival from push command success"

make_sync_case commit-only-mutation
for hook in pre-commit prepare-commit-msg pre-push; do
	cat >"$CASE_REPO/.githooks/$hook" <<'STUB'
#!/bin/sh
exit 0
STUB
	chmod 755 "$CASE_REPO/.githooks/$hook"
done
printf 'must remain staged\n' >>"$CASE_REPO/alpha-lead/MEMORY.md"
git -C "$CASE_REPO" add alpha-lead/MEMORY.md
printf 'must be the only commit owner\n' >>"$CASE_REPO/beta-lead/MEMORY.md"
MUTANT_SYNC="$CASE_TREE/scripts/lead-memory/sync-without-commit-only.sh"
python3 - "$CASE_TREE/scripts/lead-memory/sync.sh" "$MUTANT_SYNC" <<'PY'
import pathlib
import sys
source = pathlib.Path(sys.argv[1]).read_text()
needle = 'commit -q --only \\\n'
if source.count(needle) != 1:
    raise SystemExit(f"commit --only mutation must match exactly once, found {source.count(needle)}")
pathlib.Path(sys.argv[2]).write_text(source.replace(needle, 'commit -q --include \\\n', 1))
PY
chmod 755 "$MUTANT_SYNC"
MUTANT_HEAD_BEFORE="$(git -C "$CASE_REPO" rev-parse HEAD)"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$CASE_STATE" \
	"$MUTANT_SYNC" >"$TASK_TMP_DIR/commit-only-mutant.output" 2>&1
MUTANT_RC=$?
set -e
MUTANT_HEAD_AFTER="$(git -C "$CASE_REPO" rev-parse HEAD)"
test "$MUTANT_RC" -ne 0 && test "$MUTANT_HEAD_AFTER" != "$MUTANT_HEAD_BEFORE" ||
	fail "commit --only mutation control did not expose a forbidden commit"
MUTANT_PATHS="$(git -C "$CASE_REPO" show --format= --name-only "$MUTANT_HEAD_AFTER" | LC_ALL=C sort)"
test "$MUTANT_PATHS" = $'alpha-lead/MEMORY.md\nbeta-lead/MEMORY.md' ||
	fail "replacing commit --only with include does not hitchhike the foreign staged Lead folder"
pass "commit --only mutation control reproduces cross-Lead staged hitchhiking"

USAGE_STATE="$TASK_TMP_DIR/usage-state"
set +e
env PATH="$GITLEAKS_BIN:$PATH" FLYWHEEL_STATE_DIR="$USAGE_STATE" \
	"$SYNC_FIXTURE/scripts/lead-memory/sync.sh" --dry-run >/dev/null 2>&1
USAGE_RC=$?
set -e
test "$USAGE_RC" = 2 && test ! -e "$USAGE_STATE" || fail "unsupported writer switch mutates state or is accepted"
if rg -n 'FLYWHEEL_MEMORY_ACTOR=admin|chezmoi|git[[:space:]]+push[^\n]*(--force|-f|--no-verify)' "$SYNC_SOURCE" >/dev/null; then
	fail "scheduled writer source contains a forbidden actor, subsystem, or push bypass"
fi
pass "scheduled writer exposes no bypass switches, admin actor, chezmoi, or forced push"

printf 'ALL %s TESTS PASSED\n' "$PASSED"
