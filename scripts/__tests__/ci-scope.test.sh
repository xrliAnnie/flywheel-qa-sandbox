#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="$ROOT/scripts/ci-scope.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
mkdir -p "$REPO"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

git -C "$REPO" init -q
git -C "$REPO" config user.email ci@example.test
git -C "$REPO" config user.name CI
printf 'base\n' >"$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" commit -qm base
BASE="$(git -C "$REPO" rev-parse HEAD)"

printf 'head\n' >>"$REPO/file.txt"
git -C "$REPO" commit -qam head
SINGLE_HEAD="$(git -C "$REPO" rev-parse HEAD)"

git -C "$REPO" checkout -q -b side "$BASE"
printf 'side\n' >"$REPO/side.txt"
git -C "$REPO" add side.txt
git -C "$REPO" commit -qm side
SIDE_HEAD="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" checkout -q --detach "$SINGLE_HEAD"
git -C "$REPO" merge -qm merge "$SIDE_HEAD"
MERGE_HEAD="$(git -C "$REPO" rev-parse HEAD)"

run_scope() {
  local no_code="${1:-false}"
  local scoped_mode="${2-on}"
  local event_name="${3:-pull_request}"
  local event_action="${4:-synchronize}"
  local label_name="${5:-}"
  local head_sha="${6:-$SINGLE_HEAD}"
  local reuse="${7:-false}"
  local reuse_run="${8:-}"
  local checkout="${9:-$SINGLE_HEAD}"
  local output="$TMP/github-output"

  : >"$output"
  git -C "$REPO" checkout -q --detach "$checkout"
  set +e
  (
    cd "$REPO"
    GITHUB_OUTPUT="$output" \
      NO_CODE="$no_code" \
      CI_SCOPED_MODE="$scoped_mode" \
      EVENT_NAME="$event_name" \
      EVENT_ACTION="$event_action" \
      LABEL_NAME="$label_name" \
      HEAD_SHA="$head_sha" \
      REUSE="$reuse" \
      REUSE_RUN="$reuse_run" \
      bash "$SUBJECT"
  ) >"$TMP/stdout" 2>"$TMP/stderr"
  SCOPE_RC=$?
  set -e
  SCOPE_HEAVY="$(sed -n 's/^heavy=//p' "$output")"
  SCOPE_MODE="$(sed -n 's/^mode=//p' "$output")"
  SCOPE_TREE="$(sed -n 's/^tested_tree=//p' "$output")"
  SCOPE_REUSE_RUN="$(sed -n 's/^reuse_run=//p' "$output")"
  SCOPE_LINES="$(wc -l <"$output" | tr -d '[:space:]')"
}

assert_scope() {
  local name="$1" expected_heavy="$2" expected_mode="$3" expected_reuse_run="${4:-}"
  local expected_tree
  expected_tree="$(git -C "$REPO" rev-parse 'HEAD^{tree}')"
  if [[ "$SCOPE_RC" -eq 0 && "$SCOPE_HEAVY" == "$expected_heavy" &&
    "$SCOPE_MODE" == "$expected_mode" && "$SCOPE_TREE" == "$expected_tree" &&
    "$SCOPE_REUSE_RUN" == "$expected_reuse_run" && "$SCOPE_LINES" -eq 4 ]]; then
    pass "$name"
  else
    fail "$name (rc=$SCOPE_RC heavy=${SCOPE_HEAVY:-missing} mode=${SCOPE_MODE:-missing} tree=${SCOPE_TREE:-missing} reuse_run=${SCOPE_REUSE_RUN:-missing} lines=$SCOPE_LINES stderr=$(cat "$TMP/stderr"))"
  fi
}

if [[ ! -f "$SUBJECT" ]]; then
  fail "ci-scope.sh exists"
else
  run_scope true on pull_request synchronize "" "$SINGLE_HEAD"
  assert_scope "docs-only always skips heavy jobs" skip docs_only

  for value in "" off true ON; do
    run_scope false "$value" pull_request synchronize "" "$SINGLE_HEAD"
    assert_scope "scoped mode '$value' fails closed to full" run full
  done

  run_scope false on push "" "" "$SINGLE_HEAD" true 4242
  assert_scope "main push with independently verified evidence reuses full CI" skip reuse 4242

  run_scope false on push "" "" "$SINGLE_HEAD" false ""
  assert_scope "main push without reusable evidence runs full CI" run full

  run_scope false on pull_request labeled ci:full "$SINGLE_HEAD"
  assert_scope "exact ci:full labeled event runs full CI" run full

  run_scope false on pull_request labeled CI:FULL "$SINGLE_HEAD"
  assert_scope "full label comparison is case-sensitive" skip scoped

  run_scope false on pull_request synchronize "" "$MERGE_HEAD" false "" "$MERGE_HEAD"
  assert_scope "two-parent PR head runs full CI" run full

  for action in opened synchronize reopened labeled; do
    run_scope false on pull_request "$action" other "$SINGLE_HEAD"
    assert_scope "ordinary PR action '$action' uses scoped CI" skip scoped
  done

  run_scope false on pull_request closed "" "$SINGLE_HEAD"
  assert_scope "unknown PR action fails closed" run full

  run_scope false on workflow_dispatch "" "" "$SINGLE_HEAD"
  assert_scope "unknown event fails closed" run full

  run_scope false on pull_request synchronize "" not-a-sha
  assert_scope "invalid head fails closed" run full

  run_scope false on push "" "" "$SINGLE_HEAD" true not-a-run
  assert_scope "invalid reuse run id fails closed" run full

  if ! grep -Eq '(^|[^[:alnum:]_])(gh|jq)([^[:alnum:]_]|$)|https?://|/actions/' "$SUBJECT"; then
    pass "scope classifier has no API, gh, or jq dependency"
  else
    fail "scope classifier has no API, gh, or jq dependency"
  fi

  cp "$SUBJECT" "$TMP/with-gh.sh"
  printf '\ngh api repos/example/actions/runs\n' >>"$TMP/with-gh.sh"
  if grep -Eq '(^|[^[:alnum:]_])(gh|jq)([^[:alnum:]_]|$)|https?://|/actions/' "$TMP/with-gh.sh"; then
    pass "dependency residue guard detects a positive control"
  else
    fail "dependency residue guard detects a positive control"
  fi
fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
