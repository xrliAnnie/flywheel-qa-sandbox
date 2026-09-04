#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="$REPO_ROOT/scripts/lead-memory"
SYNC="$SOURCE/sync-template.sh"
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly2145-hooks.XXXXXX")"
trap 'rm -rf -- "$TASK_TMP_DIR"' EXIT

PASSED=0
pass() { PASSED=$((PASSED + 1)); printf 'ok - %s\n' "$1"; }
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }

expect_failure() {
  local label="$1" expected="$2"
  shift 2
  if "$@" >"$TASK_TMP_DIR/stdout" 2>"$TASK_TMP_DIR/stderr"; then
    fail "$label (unexpected success)"
  fi
  grep -Fq "$expected" "$TASK_TMP_DIR/stderr" || {
    sed 's/^/  /' "$TASK_TMP_DIR/stderr" >&2
    fail "$label (missing error: $expected)"
  }
  pass "$label"
}

for required in \
  "$SYNC" \
  "$SOURCE/bootstrap.sh" \
  "$SOURCE/hooks/pre-commit" \
  "$SOURCE/hooks/prepare-commit-msg" \
  "$SOURCE/hooks/pre-push"; do
  test -x "$required" || fail "required executable exists: $required"
done

BIN="$TASK_TMP_DIR/bin"
mkdir -p "$BIN"
cat >"$BIN/gitleaks" <<'STUB'
#!/bin/sh
if [ "${1:-}" = version ]; then
  printf '8.30.1\n'
  exit 0
fi
printf '%s\n' "$*" >>"${GITLEAKS_CALLS:?}"
exit 0
STUB
chmod +x "$BIN/gitleaks"

UNSAFE_REPO="$TASK_TMP_DIR/unsafe-repo"
OUTSIDE_HOOKS="$TASK_TMP_DIR/outside-hooks"
mkdir -p "$UNSAFE_REPO" "$OUTSIDE_HOOKS"
printf 'outside sentinel\n' >"$OUTSIDE_HOOKS/pre-commit"
OUTSIDE_BEFORE="$(shasum -a 256 "$OUTSIDE_HOOKS/pre-commit" | awk '{print $1}')"
ln -s "$OUTSIDE_HOOKS" "$UNSAFE_REPO/.githooks"
expect_failure "template sync rejects a symlinked managed directory before copying" \
  "lead-memory-sync: managed path must not be a symbolic link" \
  "$SYNC" "$UNSAFE_REPO"
test "$(shasum -a 256 "$OUTSIDE_HOOKS/pre-commit" | awk '{print $1}')" = "$OUTSIDE_BEFORE" ||
  fail "template sync must not overwrite a file outside the target"
test -z "$(find "$UNSAFE_REPO" -mindepth 1 ! -name .githooks -print -quit)" ||
  fail "template sync must preflight all managed paths before copying"
pass "template sync leaves symlink targets and the target tree untouched"

REPO="$TASK_TMP_DIR/repo"
ORIGIN="$TASK_TMP_DIR/origin.git"
STATE="$TASK_TMP_DIR/state"
GITLEAKS_CALLS="$TASK_TMP_DIR/gitleaks.calls"
export GITLEAKS_CALLS
# Keep this fixture independent from each host's init.defaultBranch. GitHub's
# Linux runner currently defaults bare repositories to master, which exposes
# a missing remote HEAD update that macOS hosts configured for main can hide.
git init -q --bare --initial-branch=master "$ORIGIN"
git init -q -b main "$REPO"
git -C "$REPO" config user.name "FLY-2145 Test"
git -C "$REPO" config user.email "fly2145@example.test"
git -C "$REPO" remote add origin "$ORIGIN"

printf 'runtime ledger — do not overwrite\n' >"$REPO/SCAN-LEDGER.md"
LEDGER_BEFORE="$(shasum -a 256 "$REPO/SCAN-LEDGER.md" | awk '{print $1}')"
"$SYNC" "$REPO"
test "$(shasum -a 256 "$REPO/SCAN-LEDGER.md" | awk '{print $1}')" = "$LEDGER_BEFORE" ||
  fail "template sync preserves the runtime ledger"
pass "template sync preserves the runtime ledger"

for installed in \
  .githooks/pre-commit \
  .githooks/prepare-commit-msg \
  .githooks/pre-push \
  .githooks/lib/guard.sh \
  bootstrap.sh \
  README.md .gitleaks.toml .gitleaksignore .gitignore \
  .github/workflows/guard.yml; do
  test -f "$REPO/$installed" || fail "template sync installs $installed"
done
pass "template sync installs the exact repository surface"

find "$REPO" -type f ! -path '*/.git/*' ! -name SCAN-LEDGER.md -print0 |
  sort -z | xargs -0 shasum -a 256 >"$TASK_TMP_DIR/manifest-before"
"$SYNC" "$REPO"
find "$REPO" -type f ! -path '*/.git/*' ! -name SCAN-LEDGER.md -print0 |
  sort -z | xargs -0 shasum -a 256 >"$TASK_TMP_DIR/manifest-after"
cmp -s "$TASK_TMP_DIR/manifest-before" "$TASK_TMP_DIR/manifest-after" ||
  fail "template sync is byte-idempotent"
pass "template sync is byte-idempotent"

git -C "$REPO" config core.hooksPath .githooks
git -C "$REPO" add -A
env PATH="$BIN:$PATH" FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_MEMORY_ACTOR=admin \
  git -C "$REPO" commit -q -m initial
test "$(git -C "$REPO" show -s --format=%B HEAD | grep -c '^Memory-Owner: admin$')" = 1 ||
  fail "admin commit receives exactly one owner trailer"
pass "admin commit receives exactly one owner trailer"
grep -Fq 'git --pre-commit --staged' "$GITLEAKS_CALLS" ||
  fail "admin commit still invokes staged gitleaks"
pass "admin commit still invokes staged gitleaks"
env PATH="$BIN:$PATH" FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_MEMORY_ACTOR=admin \
  git -C "$REPO" push -q -u origin main
test "$(git --git-dir="$ORIGIN" rev-parse refs/heads/main)" = "$(git -C "$REPO" rev-parse HEAD)" ||
  fail "real pre-push permits the admin import"
pass "real pre-push permits the admin import"
git --git-dir="$ORIGIN" symbolic-ref HEAD refs/heads/main
test "$(git --git-dir="$ORIGIN" symbolic-ref HEAD)" = refs/heads/main ||
  fail "fresh-clone fixture origin must advertise main as its default branch"
pass "fresh-clone fixture origin advertises main"

mkdir -p "$REPO/flywheel-eng-lead"
printf 'lead memory\n' >"$REPO/flywheel-eng-lead/MEMORY.md"
git -C "$REPO" add flywheel-eng-lead/MEMORY.md
env PATH="$BIN:$PATH" FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_LEAD_ID=flywheel-eng-lead \
  git -C "$REPO" commit -q -m lead-memory
test "$(git -C "$REPO" show -s --format=%B HEAD | grep -c '^Memory-Owner: flywheel-eng-lead$')" = 1 ||
  fail "Lead commit receives exactly one owner trailer"
pass "Lead commit receives exactly one owner trailer"
env PATH="$BIN:$PATH" FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_LEAD_ID=flywheel-eng-lead \
  git -C "$REPO" push -q
pass "real pre-push permits a Lead-owned fast-forward"

mkdir -p "$REPO/sub-lead"
printf 'sync memory\n' >"$REPO/sub-lead/MEMORY.md"
git -C "$REPO" add sub-lead/MEMORY.md
env PATH="$BIN:$PATH" FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_MEMORY_ACTOR=sync \
  git -C "$REPO" commit -q -m sync-memory
test "$(git -C "$REPO" show -s --format=%B HEAD | grep -c '^Memory-Owner: sub-lead$')" = 1 ||
  fail "sync commit derives exactly one owner trailer"
pass "sync commit derives exactly one owner trailer"
env PATH="$BIN:$PATH" FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_MEMORY_ACTOR=sync \
  git -C "$REPO" push -q
pass "real pre-push permits a sync-owned fast-forward"

# Rehearse the C6 negative acceptance in a disposable fresh clone. The same
# bad change must be refused by commit, by push after --no-verify, and by the
# actor-independent range checker that CI executes.
NEGATIVE_CLONE="$TASK_TMP_DIR/negative-clone"
NEGATIVE_STATE="$TASK_TMP_DIR/negative-state"
git clone -q "$ORIGIN" "$NEGATIVE_CLONE"
git -C "$NEGATIVE_CLONE" config user.name "FLY-2145 Negative Acceptance"
git -C "$NEGATIVE_CLONE" config user.email "fly2145-negative@example.test"
git -C "$NEGATIVE_CLONE" config core.hooksPath .githooks

printf 'foreign fresh-clone change\n' >>"$NEGATIVE_CLONE/sub-lead/MEMORY.md"
git -C "$NEGATIVE_CLONE" add sub-lead/MEMORY.md
expect_failure "fresh clone rejects another Lead folder at commit" \
  "lead-memory-guard: refusing commit" \
  env PATH="$BIN:$PATH" FLYWHEEL_STATE_DIR="$NEGATIVE_STATE" \
    FLYWHEEL_LEAD_ID=flywheel-eng-lead \
    git -C "$NEGATIVE_CLONE" commit -m foreign-fresh-clone
AUDIT_ROWS="$(wc -l <"$NEGATIVE_STATE/state/lead-memory/audit.log" | tr -d ' ')"
test "$AUDIT_ROWS" = 1 || fail "fresh-clone commit rejection appends exactly one audit row"
pass "fresh-clone commit rejection appends one isolated audit row"

expect_failure "fresh clone still rejects --no-verify at prepare-commit-msg" \
  "lead-memory-guard: refusing commit" \
  env PATH="$BIN:$PATH" FLYWHEEL_STATE_DIR="$NEGATIVE_STATE" \
    FLYWHEEL_LEAD_ID=flywheel-eng-lead \
    git -C "$NEGATIVE_CLONE" commit --no-verify \
      -m foreign-no-verify \
      -m "Memory-Owner: flywheel-eng-lead"
BAD_TREE="$(git -C "$NEGATIVE_CLONE" write-tree)"
BAD_PARENT="$(git -C "$NEGATIVE_CLONE" rev-parse HEAD)"
BAD_SHA="$(printf 'foreign plumbing bypass\n\nMemory-Owner: flywheel-eng-lead\n' |
  git -C "$NEGATIVE_CLONE" commit-tree "$BAD_TREE" -p "$BAD_PARENT")"
git -C "$NEGATIVE_CLONE" update-ref refs/heads/main "$BAD_SHA" "$BAD_PARENT"
REMOTE_BEFORE="$(git --git-dir="$ORIGIN" rev-parse refs/heads/main)"
expect_failure "fresh clone pre-push rejects a plumbing-bypassed foreign commit" \
  "owner flywheel-eng-lead does not match path sub-lead/MEMORY.md" \
  env PATH="$BIN:$PATH" FLYWHEEL_STATE_DIR="$NEGATIVE_STATE" \
    FLYWHEEL_LEAD_ID=flywheel-eng-lead \
    git -C "$NEGATIVE_CLONE" push origin main
test "$(git --git-dir="$ORIGIN" rev-parse refs/heads/main)" = "$REMOTE_BEFORE" ||
  fail "rejected fresh-clone push must leave remote main unchanged"
pass "fresh-clone pre-push rejection leaves remote main unchanged"
run_negative_range() {
  (
    cd "$NEGATIVE_CLONE"
    FLYWHEEL_STATE_DIR="$NEGATIVE_STATE" .githooks/lib/guard.sh check-range "$BAD_SHA"
  )
}
expect_failure "CI range checker rejects the same bypassed foreign commit" \
  "owner flywheel-eng-lead does not match path sub-lead/MEMORY.md" \
  run_negative_range

for mapping in \
  "hooks/pre-commit:.githooks/pre-commit" \
  "hooks/prepare-commit-msg:.githooks/prepare-commit-msg" \
  "hooks/pre-push:.githooks/pre-push" \
  "lib/guard.sh:.githooks/lib/guard.sh"; do
  source_path="${mapping%%:*}"
  installed_path="${mapping#*:}"
  SOURCE_HASH="$(shasum -a 256 "$SOURCE/$source_path" | awk '{print $1}')"
  REPO_HASH="$(shasum -a 256 "$REPO/$installed_path" | awk '{print $1}')"
  CLONE_HASH="$(shasum -a 256 "$NEGATIVE_CLONE/$installed_path" | awk '{print $1}')"
  test "$SOURCE_HASH" = "$REPO_HASH" && test "$REPO_HASH" = "$CLONE_HASH" ||
    fail "source, installed repository, and fresh clone hook hashes must match: $installed_path"
done
pass "source, installed repository, and fresh clone hook hashes match"

printf 'foreign\n' >>"$REPO/sub-lead/MEMORY.md"
git -C "$REPO" add sub-lead/MEMORY.md
expect_failure "real pre-commit rejects another Lead folder" \
  "lead-memory-guard: refusing commit" \
  env PATH="$BIN:$PATH" FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_LEAD_ID=flywheel-eng-lead \
    git -C "$REPO" commit -m foreign-memory
git -C "$REPO" reset -q --hard HEAD

mkdir -p "$REPO/flywheel-eng-lead"
printf 'missing scanner\n' >>"$REPO/flywheel-eng-lead/MEMORY.md"
git -C "$REPO" add flywheel-eng-lead/MEMORY.md
expect_failure "pre-commit fails closed when gitleaks is unavailable" \
  "gitleaks 8.30.1 is required" \
  env PATH="/usr/bin:/bin" FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_LEAD_ID=flywheel-eng-lead \
    git -C "$REPO" commit -m missing-gitleaks
git -C "$REPO" reset -q --hard HEAD

cat >"$BIN/gitleaks" <<'STUB'
#!/bin/sh
if [ "${1:-}" = version ]; then printf '8.29.0\n'; exit 0; fi
exit 0
STUB
chmod +x "$BIN/gitleaks"
printf 'wrong scanner\n' >>"$REPO/flywheel-eng-lead/MEMORY.md"
git -C "$REPO" add flywheel-eng-lead/MEMORY.md
expect_failure "pre-commit fails closed on a different gitleaks version" \
  "gitleaks 8.30.1 is required" \
  env PATH="$BIN:$PATH" FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_LEAD_ID=flywheel-eng-lead \
    git -C "$REPO" commit -m wrong-gitleaks

if [ -n "${FLY2145_REAL_GITLEAKS_BIN:-}" ]; then
  REAL_REPO="$TASK_TMP_DIR/real-gitleaks-repo"
  git init -q -b main "$REAL_REPO"
  git -C "$REAL_REPO" config user.name "FLY-2145 Real Scanner Test"
  git -C "$REAL_REPO" config user.email "fly2145-real@example.test"
  printf 'runtime ledger\n' >"$REAL_REPO/SCAN-LEDGER.md"
  "$SYNC" "$REAL_REPO" >/dev/null
  git -C "$REAL_REPO" config core.hooksPath .githooks
  git -C "$REAL_REPO" add -A
  env PATH="$(dirname "$FLY2145_REAL_GITLEAKS_BIN"):/usr/bin:/bin" \
    FLYWHEEL_STATE_DIR="$TASK_TMP_DIR/real-state" FLYWHEEL_MEMORY_ACTOR=admin \
    git -C "$REAL_REPO" commit -q -m real-admin-import
  pass "real gitleaks accepts the scanner config during an admin import"
fi

printf 'RESULTS: %d passed\n' "$PASSED"
