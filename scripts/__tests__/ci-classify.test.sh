#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="$ROOT/scripts/ci-classify.sh"
VECTORS="$ROOT/scripts/ci-status-vectors.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
MOCK_BIN="$TMP/bin"
mkdir -p "$REPO" "$MOCK_BIN"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

cat >"$MOCK_BIN/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${MOCK_GH_FAIL:-0}" != "1" ]] || exit 1
[[ "${1:-} ${2:-}" == "api repos/xrliAnnie/flywheel/actions/workflows/ci.yml/runs" ]] || {
  printf 'unexpected gh argv: %s\n' "$*" >&2
  exit 2
}
page=1
for argument in "$@"; do
  [[ "$argument" != page=* ]] || page="${argument#page=}"
done
[[ -z "${MOCK_GH_CALLS_FILE:-}" ]] || printf '%s\n' "$page" >>"$MOCK_GH_CALLS_FILE"
if [[ -n "${MOCK_RUNS_DIR:-}" ]]; then
  cat "$MOCK_RUNS_DIR/page-$page.json"
else
  cat "$MOCK_RUNS_FILE"
fi
SH
chmod +x "$MOCK_BIN/gh"

git -C "$REPO" init -q
git -C "$REPO" config user.email ci@example.test
git -C "$REPO" config user.name CI
printf 'base\n' >"$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -qm base
BASE="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" checkout -qb pr
mkdir -p "$REPO/src"
printf 'export const value = 1;\n' >"$REPO/src/code.ts"
git -C "$REPO" add src/code.ts
git -C "$REPO" commit -qm green-code
GREEN="$(git -C "$REPO" rev-parse HEAD)"
mkdir -p "$REPO/engineering/doc/example"
printf 'ledger\n' >"$REPO/engineering/doc/example/progress.md"
printf 'static image fixture\n' >"$REPO/engineering/doc/example/proof.png"
git -C "$REPO" add engineering/doc/example/progress.md engineering/doc/example/proof.png
git -C "$REPO" commit -qm docs-only
DOC_HEAD="$(git -C "$REPO" rev-parse HEAD)"

preview_checkout() {
  local head="$1" base="$2" tree preview
  tree="$(git -C "$REPO" rev-parse "$head^{tree}")"
  preview="$(printf 'merge preview\n' | git -C "$REPO" commit-tree "$tree" -p "$head" -p "$base")"
  git -C "$REPO" checkout -q --detach "$preview"
}

write_runs() {
  local file="$1" status="$2" conclusion="$3" head="$4" base="$5" created="${6:-2026-08-18T00:00:00Z}" id="${7:-1}"
  jq -cn \
    --arg status "$status" --arg conclusion "$conclusion" --arg head "$head" \
    --arg base "$base" --arg created "$created" --argjson id "$id" '
      {workflow_runs:[{id:$id,status:$status,conclusion:(if $conclusion == "" then null else $conclusion end),head_sha:$head,created_at:$created,pull_requests:[{number:871,base:{sha:$base}}]}]}
    ' >"$file"
}

append_run() {
  local file="$1" status="$2" conclusion="$3" head="$4" base="$5" created="$6" id="$7"
  jq \
    --arg status "$status" --arg conclusion "$conclusion" --arg head "$head" \
    --arg base "$base" --arg created "$created" --argjson id "$id" '
      .workflow_runs += [{id:$id,status:$status,conclusion:(if $conclusion == "" then null else $conclusion end),head_sha:$head,created_at:$created,pull_requests:[{number:871,base:{sha:$base}}]}]
    ' "$file" >"$file.next"
  mv "$file.next" "$file"
}

write_filler_page() {
  local file="$1" count="$2" page="$3"
  jq -cn --argjson count "$count" --argjson page "$page" '
    {
      workflow_runs: [
        range(0; $count) as $index
        | {
            id: ($page * 1000 + $index),
            status: "completed",
            conclusion: "success",
            head_sha: "0000000000000000000000000000000000000000",
            created_at: "2026-08-17T00:00:00Z",
            pull_requests: []
          }
      ]
    }
  ' >"$file"
}

run_classifier() {
  local head="$1" base="$2" runs="$3" gh_fail="${4:-0}" pr_number="${5:-871}" runs_dir="${6:-}"
  local output="$TMP/github-output" calls="$TMP/gh-calls"
  : >"$output"
  : >"$calls"
  set +e
  (
    cd "$REPO"
    PATH="$MOCK_BIN:/usr/bin:/bin" \
      GITHUB_OUTPUT="$output" GITHUB_REPOSITORY=xrliAnnie/flywheel \
      PR_NUMBER="$pr_number" HEAD_SHA="$head" BASE_SHA="$base" GH_TOKEN=test \
      MOCK_RUNS_FILE="$runs" MOCK_RUNS_DIR="$runs_dir" MOCK_GH_FAIL="$gh_fail" \
      MOCK_GH_CALLS_FILE="$calls" \
      bash "$SUBJECT"
  ) >"$TMP/stdout" 2>"$TMP/stderr"
  CLASSIFY_RC=$?
  set -e
  CLASSIFY_VALUE="$(sed -n 's/^no_code=//p' "$output" | tail -1)"
  CLASSIFY_STDERR="$(cat "$TMP/stderr")"
  CLASSIFY_GH_CALLS="$(cat "$calls")"
}

assert_value() {
  local name="$1" expected="$2"
  if [[ "$CLASSIFY_RC" -eq 0 && "$CLASSIFY_VALUE" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name (rc=$CLASSIFY_RC no_code=${CLASSIFY_VALUE:-missing})"
  fi
}

assert_reason() {
  local name="$1" expected="$2"
  if grep -Fqx "ci-classify: fail-closed: $expected" "$TMP/stderr"; then
    pass "$name"
  else
    fail "$name (stderr=${CLASSIFY_STDERR:-empty})"
  fi
}

if [[ ! -f "$SUBJECT" ]]; then
  fail "ci-classify.sh exists"
else
  RUNS="$TMP/runs.json"
  write_runs "$RUNS" completed success "$GREEN" "$BASE"
  preview_checkout "$DOC_HEAD" "$BASE"
  run_classifier "$DOC_HEAD" "$BASE" "$RUNS"
  assert_value "docs-only cumulative diff passes from a green baseline under merge-preview checkout" true

  preview_checkout "$GREEN" "$BASE"
  run_classifier "$GREEN" "$BASE" "$RUNS"
  assert_value "empty cumulative diff is no-code" true

  git -C "$REPO" checkout -q -B base-moved "$BASE"
  mkdir -p "$REPO/src"
  printf 'base moved\n' >"$REPO/src/base-change.ts"
  git -C "$REPO" add src/base-change.ts
  git -C "$REPO" commit -qm base-moved
  BASE_MOVED="$(git -C "$REPO" rev-parse HEAD)"
  preview_checkout "$DOC_HEAD" "$BASE_MOVED"
  run_classifier "$DOC_HEAD" "$BASE_MOVED" "$RUNS"
  assert_value "base SHA movement invalidates the old green baseline" false
  assert_reason "base SHA movement explains its fail-closed decision" baseline_base_sha_mismatch

  git -C "$REPO" checkout -q -B rename-case "$GREEN"
  mkdir -p "$REPO/engineering/doc/rename"
  git -C "$REPO" mv src/code.ts engineering/doc/rename/code.ts
  git -C "$REPO" commit -qm rename-code-to-docs
  RENAME_HEAD="$(git -C "$REPO" rev-parse HEAD)"
  preview_checkout "$RENAME_HEAD" "$BASE"
  run_classifier "$RENAME_HEAD" "$BASE" "$RUNS"
  assert_value "code-to-doc rename remains code-relevant under no-renames diff" false
  assert_reason "code-to-doc rename explains its fail-closed decision" diff_not_inert

  git -C "$REPO" checkout -q -B symlink-case "$GREEN"
  mkdir -p "$REPO/engineering/doc/symlink"
  ln -s ../../outside "$REPO/engineering/doc/symlink/link.md"
  git -C "$REPO" add engineering/doc/symlink/link.md
  git -C "$REPO" commit -qm docs-symlink
  SYMLINK_HEAD="$(git -C "$REPO" rev-parse HEAD)"
  preview_checkout "$SYMLINK_HEAD" "$BASE"
  run_classifier "$SYMLINK_HEAD" "$BASE" "$RUNS"
  assert_value "allowlisted symlinks fail closed" false
  assert_reason "allowlisted symlink mode explains its fail-closed decision" diff_not_inert

  for path in \
    packages/x/progress.md \
    .github/workflows/extra.yml \
    scripts/ci-classify.sh \
    packages/teamlead/prompts/runtime.md \
    doc/VERSION \
    product/doc/example/evidence/admit.mjs; do
    git -C "$REPO" checkout -q -B "path-case-${RANDOM}" "$GREEN"
    mkdir -p "$REPO/$(dirname "$path")"
    printf 'changed\n' >"$REPO/$path"
    git -C "$REPO" add "$path"
    git -C "$REPO" commit -qm "path-case-$path"
    PATH_HEAD="$(git -C "$REPO" rev-parse HEAD)"
    preview_checkout "$PATH_HEAD" "$BASE"
    run_classifier "$PATH_HEAD" "$BASE" "$RUNS"
    assert_value "non-inert path fails closed: $path" false
  done

  write_runs "$RUNS" completed success "$GREEN" "$BASE" 2026-08-18T00:00:00Z 1
  for conclusion in failure timed_out skipped; do
    append_run "$RUNS" completed "$conclusion" "$GREEN" "$BASE" 2026-08-18T00:01:00Z 2
    preview_checkout "$DOC_HEAD" "$BASE"
    run_classifier "$DOC_HEAD" "$BASE" "$RUNS"
    assert_value "newer completed $conclusion invalidates an older success" false
    assert_reason "newer completed $conclusion explains its fail-closed decision" latest_completed_run_not_success
    write_runs "$RUNS" completed success "$GREEN" "$BASE" 2026-08-18T00:00:00Z 1
  done

  printf '%s\n' '{"workflow_runs":[]}' >"$RUNS"
  preview_checkout "$DOC_HEAD" "$BASE"
  run_classifier "$DOC_HEAD" "$BASE" "$RUNS"
  assert_value "missing green baseline fails closed" false
  assert_reason "missing green baseline explains its fail-closed decision" no_completed_pr_baseline

  write_runs "$RUNS" completed success "$BASE_MOVED" "$BASE"
  preview_checkout "$DOC_HEAD" "$BASE"
  run_classifier "$DOC_HEAD" "$BASE" "$RUNS"
  assert_value "non-ancestor green head fails closed" false
  assert_reason "non-ancestor green head explains its fail-closed decision" baseline_not_ancestor

  write_runs "$RUNS" completed success "$GREEN" "$BASE"
  run_classifier "$DOC_HEAD" "$BASE" "$RUNS" 1
  assert_value "GitHub query failure fails closed without failing the job" false
  assert_reason "GitHub query failure identifies the failed page" runs_api_failed:page=1

  printf '%s\n' '{' >"$RUNS"
  run_classifier "$DOC_HEAD" "$BASE" "$RUNS"
  assert_value "invalid GitHub response fails closed without failing the job" false
  assert_reason "invalid GitHub response identifies the failed page" runs_page_invalid:page=1

  write_runs "$RUNS" completed success "$GREEN" "$BASE"
  run_classifier "$DOC_HEAD" "$BASE" "$RUNS" 0 0
  assert_value "invalid classifier input fails closed without querying GitHub" false
  assert_reason "invalid classifier input explains its fail-closed decision" invalid_input

  write_runs "$RUNS" completed success not-a-sha "$BASE"
  run_classifier "$DOC_HEAD" "$BASE" "$RUNS"
  assert_value "invalid baseline head fails closed" false
  assert_reason "invalid baseline head explains its fail-closed decision" baseline_head_invalid

  write_runs "$RUNS" completed success bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb "$BASE"
  run_classifier "$DOC_HEAD" "$BASE" "$RUNS"
  assert_value "missing baseline commit fails closed" false
  assert_reason "missing baseline commit explains its fail-closed decision" baseline_commit_missing

  write_runs "$RUNS" completed success "$GREEN" "$BASE"
  run_classifier aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$BASE" "$RUNS"
  assert_value "missing current head commit fails closed" false
  assert_reason "missing current head commit explains its fail-closed decision" head_commit_missing

  PAGED_RUNS="$TMP/paged-runs"
  mkdir -p "$PAGED_RUNS"
  for page in $(seq 1 11); do
    write_filler_page "$PAGED_RUNS/page-$page.json" 100 "$page"
  done
  write_filler_page "$PAGED_RUNS/page-12.json" 99 12
  append_run "$PAGED_RUNS/page-12.json" completed success "$GREEN" "$BASE" 2026-08-18T00:00:00Z 12001
  write_runs "$PAGED_RUNS/page-13.json" completed failure "$GREEN" "$BASE" 2026-08-18T00:01:00Z 13001
  preview_checkout "$DOC_HEAD" "$BASE"
  run_classifier "$DOC_HEAD" "$BASE" "$RUNS" 0 871 "$PAGED_RUNS"
  assert_value "green baseline lookup reaches page 12 but never consumes page 13" true
  EXPECTED_CALLS="$(seq 1 12)"
  if [[ "$CLASSIFY_GH_CALLS" == "$EXPECTED_CALLS" ]]; then
    pass "green baseline lookup is capped at exactly 12 pages"
  else
    fail "green baseline lookup is capped at exactly 12 pages (pages=${CLASSIFY_GH_CALLS:-none})"
  fi

  if grep -Eq 'fail_closed([[:space:]]*;)?[[:space:]]*$' "$SUBJECT"; then
    fail "every fail_closed call supplies a diagnostic reason"
  else
    pass "every fail_closed call supplies a diagnostic reason"
  fi

  vector_failures_before="$FAILED"
  while IFS=$'\t' read -r status conclusion baseline; do
    write_runs "$RUNS" "$status" "$conclusion" "$GREEN" "$BASE"
    preview_checkout "$DOC_HEAD" "$BASE"
    run_classifier "$DOC_HEAD" "$BASE" "$RUNS"
    expected=false
    [[ "$baseline" == true ]] && expected=true
    if [[ "$CLASSIFY_RC" -ne 0 || "$CLASSIFY_VALUE" != "$expected" ]]; then
      fail "shared baseline vector status=$status conclusion=${conclusion:-null} expected=$expected"
    fi
  done < <(jq -r '.[] | [.status, (.conclusion // ""), (.baseline | tostring)] | @tsv' "$VECTORS")
  [[ "$FAILED" -ne "$vector_failures_before" ]] || pass "classifier consumes every shared status vector"
fi

printf '\nPassed: %s  Failed: %s\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
