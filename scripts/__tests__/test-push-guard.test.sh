#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK_SOURCE="$REPO_ROOT/packages/edge-worker/assets/push-guard/pre-push"
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly1718-push-guard.XXXXXX")"
trap 'rm -rf -- "$TASK_TMP_DIR"' EXIT

PASSED=0
FAILED=0

pass() {
  PASSED=$((PASSED + 1))
  printf 'ok - %s\n' "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  printf 'not ok - %s\n' "$1" >&2
}

check() {
  local label="$1"
  shift
  if "$@"; then pass "$label"; else fail "$label"; fi
}

git_quiet() {
  git "$@" >/dev/null 2>&1
}

if [[ ! -x "$HOOK_SOURCE" ]]; then
  printf 'missing executable hook asset: %s\n' "$HOOK_SOURCE" >&2
  exit 1
fi

ORIGIN="$TASK_TMP_DIR/origin.git"
REPO="$TASK_TMP_DIR/repo"
WORKTREE="$TASK_TMP_DIR/worktree"
HOOKS_DIR="$TASK_TMP_DIR/hooks"
STATE_DIR="$TASK_TMP_DIR/state"

git_quiet init --bare "$ORIGIN"
git_quiet clone "$ORIGIN" "$REPO"
git -C "$REPO" config user.email "flywheel@example.test"
git -C "$REPO" config user.name "Flywheel Test"
git_quiet -C "$REPO" checkout -b main
printf 'base\n' > "$REPO/file.txt"
git_quiet -C "$REPO" add file.txt
git_quiet -C "$REPO" commit -m base
git_quiet -C "$REPO" push -u origin main

git_quiet -C "$REPO" worktree add -b feature "$WORKTREE" main
mkdir -p "$HOOKS_DIR"
cp "$HOOK_SOURCE" "$HOOKS_DIR/pre-push"
chmod 700 "$HOOKS_DIR/pre-push"
git -C "$WORKTREE" config --local extensions.worktreeConfig true
git -C "$WORKTREE" config --worktree core.hooksPath "$HOOKS_DIR"

audit_file="$STATE_DIR/state/push-guard/audit.log"
audit_lines() {
  if [[ -f "$audit_file" ]]; then wc -l < "$audit_file" | tr -d ' '; else printf '0'; fi
}

# T7: a brand-new remote branch is not a rewrite and emits no audit row.
check "T7 new branch push allowed" env FLYWHEEL_STATE_DIR="$STATE_DIR" git -C "$WORKTREE" push -u origin feature
check "T7 new branch has no audit row" test "$(audit_lines)" = "0"

# T1: a normal fast-forward remains invisible to the guard.
printf 'fast-forward\n' >> "$WORKTREE/file.txt"
git_quiet -C "$WORKTREE" add file.txt
git_quiet -C "$WORKTREE" commit -m fast-forward
check "T1 fast-forward push allowed" env FLYWHEEL_STATE_DIR="$STATE_DIR" git -C "$WORKTREE" push
check "T1 fast-forward has no audit row" test "$(audit_lines)" = "0"

REMOTE_FAST_FORWARD="$(git -C "$WORKTREE" rev-parse HEAD)"
git_quiet -C "$WORKTREE" reset --hard HEAD~1
printf 'rewrite-one\n' >> "$WORKTREE/file.txt"
git_quiet -C "$WORKTREE" add file.txt
git_quiet -C "$WORKTREE" commit -m rewrite-one

# T2: --force-with-lease is still a non-fast-forward and is rejected.
if env FLYWHEEL_STATE_DIR="$STATE_DIR" git -C "$WORKTREE" push --force-with-lease origin feature >/dev/null 2>&1; then
  fail "T2 force-with-lease rejected"
else
  pass "T2 force-with-lease rejected"
fi
check "T2 rejected attempt audited" grep -q $'feature\t.*\trejected$' "$audit_file"

# T6: an ACK for another branch has no authority.
if env FLYWHEEL_STATE_DIR="$STATE_DIR" FLYWHEEL_FORCE_PUSH_ACK=other git -C "$WORKTREE" push --force-with-lease origin feature >/dev/null 2>&1; then
  fail "T6 wrong-branch ACK rejected"
else
  pass "T6 wrong-branch ACK rejected"
fi

# T5: the exact branch ACK permits one audited rewrite.
check "T5 exact ACK allows rewrite" env FLYWHEEL_STATE_DIR="$STATE_DIR" FLYWHEEL_FORCE_PUSH_ACK=feature git -C "$WORKTREE" push --force-with-lease origin feature
check "T5 ACK audited" grep -q $'feature\t.*\tacked$' "$audit_file"

# T4: branch deletion is always refused, even with an ACK.
if env FLYWHEEL_STATE_DIR="$STATE_DIR" FLYWHEEL_FORCE_PUSH_ACK=feature git -C "$WORKTREE" push origin --delete feature >/dev/null 2>&1; then
  fail "T4 branch deletion rejected"
else
  pass "T4 branch deletion rejected"
fi
check "T4 deletion attempt audited" grep -q $'feature\t0000000000000000000000000000000000000000\t.*\trejected$' "$audit_file"

# T3: core.hooksPath is worktree-local; the main checkout remains untouched.
if git -C "$REPO" config --worktree --get core.hooksPath >/dev/null 2>&1; then
  fail "T3 main checkout has no push guard config"
else
  pass "T3 main checkout has no push guard config"
fi
printf 'main-forward\n' >> "$REPO/file.txt"
git_quiet -C "$REPO" add file.txt
git_quiet -C "$REPO" commit -m main-forward
check "T3 main checkout push allowed" git -C "$REPO" push origin main

# T8: an acknowledged rewrite without durable audit evidence fails closed.
git_quiet -C "$WORKTREE" reset --hard "$REMOTE_FAST_FORWARD"
printf 'rewrite-two\n' >> "$WORKTREE/file.txt"
git_quiet -C "$WORKTREE" add file.txt
git_quiet -C "$WORKTREE" commit -m rewrite-two
if env FLYWHEEL_STATE_DIR=/dev/null FLYWHEEL_FORCE_PUSH_ACK=feature git -C "$WORKTREE" push --force-with-lease origin feature >/dev/null 2>&1; then
  fail "T8 ACK without writable audit rejected"
else
  pass "T8 ACK without writable audit rejected"
fi

printf 'RESULTS: %d passed, %d failed\n' "$PASSED" "$FAILED"
test "$FAILED" -eq 0
