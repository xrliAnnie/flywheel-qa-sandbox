#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="$ROOT/scripts/ci-classify.sh"
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
printf 'base\n' >"$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -qm base
BASE="$(git -C "$REPO" rev-parse HEAD)"

preview_checkout() {
  local head="$1" base="$2" tree preview
  tree="$(git -C "$REPO" rev-parse "$head^{tree}")"
  preview="$(printf 'merge preview\n' | git -C "$REPO" commit-tree "$tree" -p "$head" -p "$base")"
  git -C "$REPO" checkout -q --detach "$preview"
}

run_classifier() {
  local head="$1" base="$2"
  local output="$TMP/github-output"
  : >"$output"
  set +e
  (
    cd "$REPO"
    PATH="/usr/bin:/bin" \
      GITHUB_OUTPUT="$output" HEAD_SHA="$head" BASE_SHA="$base" \
      bash "$SUBJECT"
  ) >"$TMP/stdout" 2>"$TMP/stderr"
  CLASSIFY_RC=$?
  set -e
  CLASSIFY_VALUE="$(sed -n 's/^no_code=//p' "$output" | tail -1)"
  CLASSIFY_OUTPUT_LINES="$(wc -l <"$output" | tr -d '[:space:]')"
  CLASSIFY_STDERR="$(cat "$TMP/stderr")"
}

assert_result() {
  local name="$1" expected="$2"
  if [[ "$CLASSIFY_RC" -eq 0 && "$CLASSIFY_VALUE" == "$expected" && "$CLASSIFY_OUTPUT_LINES" -eq 1 ]]; then
    pass "$name"
  else
    fail "$name (rc=$CLASSIFY_RC no_code=${CLASSIFY_VALUE:-missing} output_lines=$CLASSIFY_OUTPUT_LINES stderr=${CLASSIFY_STDERR:-empty})"
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

commit_file_from() {
  local branch="$1" start="$2" path="$3" content="${4:-changed}"
  git -C "$REPO" checkout -q -B "$branch" "$start"
  mkdir -p "$REPO/$(dirname "$path")"
  printf '%s\n' "$content" >"$REPO/$path"
  git -C "$REPO" add "$path"
  git -C "$REPO" commit -qm "$branch"
  git -C "$REPO" rev-parse HEAD
}

if [[ ! -f "$SUBJECT" ]]; then
  fail "ci-classify.sh exists"
else
  allowed_prefixes=(doc product/doc engineering/doc content/doc)
  existing_allowed_suffixes=(md markdown mmd html htm svg png jpg jpeg gif webp avif pdf)
  new_allowed_suffixes=(txt csv log out jsonl wav mp3 m4a ogg mp4 webm vtt srt)
  allowed_suffixes=("${existing_allowed_suffixes[@]}" "${new_allowed_suffixes[@]}")
  DOC_HEAD=""
  for index in "${!allowed_suffixes[@]}"; do
    prefix="${allowed_prefixes[$((index % ${#allowed_prefixes[@]}))]}"
    suffix="${allowed_suffixes[$index]}"
    head="$(commit_file_from "docs-$index" "$BASE" "$prefix/fixture-$index.$suffix")"
    [[ -n "$DOC_HEAD" ]] || DOC_HEAD="$head"
    preview_checkout "$head" "$BASE"
    run_classifier "$head" "$BASE"
    assert_result "allowlisted docs path passes: $prefix/*.$suffix" true
  done

  for index in "${!new_allowed_suffixes[@]}"; do
    suffix="${new_allowed_suffixes[$index]}"
    head="$(commit_file_from "outside-new-suffix-$index" "$BASE" "evidence/fixture-$index.$suffix")"
    preview_checkout "$head" "$BASE"
    run_classifier "$head" "$BASE"
    assert_result "new suffix outside doc prefixes runs the full suite: *.$suffix" false
    assert_reason "new suffix outside doc prefixes supplies a reason: *.$suffix" diff_not_inert
  done

  excluded_doc_suffixes=(json tsv yaml)
  for index in "${!excluded_doc_suffixes[@]}"; do
    suffix="${excluded_doc_suffixes[$index]}"
    head="$(commit_file_from "excluded-doc-suffix-$index" "$BASE" "engineering/doc/excluded-$index.$suffix")"
    preview_checkout "$head" "$BASE"
    run_classifier "$head" "$BASE"
    assert_result "excluded suffix inside doc prefixes runs the full suite: *.$suffix" false
    assert_reason "excluded suffix inside doc prefixes supplies a reason: *.$suffix" diff_not_inert
  done

  known_ci_consumed_doc_paths=(
    doc/engineer/implementation/FLY-222-a0-a10-runbook.md
    doc/qa/framework/529-room-playbook.md
    engineering/doc/FLY-1775-529-generalized-dag-room/plan.md
    engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md
    engineering/doc/FLY-1648-hot-loop-closeout/runbook.md
    doc/engineer/implementation/flag-authoring-runbook.md
    engineering/doc/FLY-1278-review-gate-convergence/exploration.md
    engineering/doc/FLY-1278-review-gate-convergence/research.md
    engineering/doc/FLY-1278-review-gate-convergence/plan.md
    engineering/doc/FLY-1278-review-gate-convergence/progress.md
    engineering/doc/FLY-1278-review-gate-convergence/fixtures/README.md
    engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round1.md
    engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round2.md
    engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round3.md
    engineering/doc/FLY-1135-layer1-dag-templates/exploration.md
    engineering/doc/FLY-1135-layer1-dag-templates/research.md
    engineering/doc/FLY-1135-layer1-dag-templates/plan.md
  )
  for index in "${!known_ci_consumed_doc_paths[@]}"; do
    path="${known_ci_consumed_doc_paths[$index]}"
    head="$(commit_file_from "known-ci-consumer-$index" "$BASE" "$path")"
    preview_checkout "$head" "$BASE"
    run_classifier "$head" "$BASE"
    assert_result "known CI-consumed doc runs the full suite: $path" false
  done

  git -C "$REPO" checkout -q -B known-ci-consumer-mixed "$BASE"
  mkdir -p \
    "$REPO/doc/engineer/implementation" \
    "$REPO/engineering/doc/FLY-2001-fixture"
  printf 'guard input changed\n' >"$REPO/doc/engineer/implementation/FLY-222-a0-a10-runbook.md"
  printf 'inert evidence\n' >"$REPO/engineering/doc/FLY-2001-fixture/evidence.txt"
  git -C "$REPO" add \
    doc/engineer/implementation/FLY-222-a0-a10-runbook.md \
    engineering/doc/FLY-2001-fixture/evidence.txt
  git -C "$REPO" commit -qm known-ci-consumer-mixed
  KNOWN_CONSUMER_MIXED_HEAD="$(git -C "$REPO" rev-parse HEAD)"
  preview_checkout "$KNOWN_CONSUMER_MIXED_HEAD" "$BASE"
  run_classifier "$KNOWN_CONSUMER_MIXED_HEAD" "$BASE"
  assert_result "known CI-consumed doc plus newly allowlisted suffix runs the full suite" false

  pr874_paths=(
    product/doc/FLY-1846-global-chief-of-staff/assets/raya-avatar-square.png
    product/doc/FLY-1846-global-chief-of-staff/assets/raya-avatar.SOURCE.txt
    product/doc/FLY-1846-global-chief-of-staff/assets/raya-avatar.png
    product/doc/FLY-1846-global-chief-of-staff/exploration.md
    product/doc/FLY-1846-global-chief-of-staff/plan.md
    product/doc/FLY-1846-global-chief-of-staff/prd-review.html
    product/doc/FLY-1846-global-chief-of-staff/prd.md
    product/doc/FLY-1846-global-chief-of-staff/progress.md
    product/doc/FLY-1846-global-chief-of-staff/research.md
  )
  git -C "$REPO" checkout -q -B pr874-replay "$BASE"
  for path in "${pr874_paths[@]}"; do
    mkdir -p "$REPO/$(dirname "$path")"
    printf 'PR #874 path replay\n' >"$REPO/$path"
  done
  git -C "$REPO" add product/doc/FLY-1846-global-chief-of-staff
  git -C "$REPO" commit -qm pr874-replay
  PR874_HEAD="$(git -C "$REPO" rev-parse HEAD)"
  preview_checkout "$PR874_HEAD" "$BASE"
  run_classifier "$PR874_HEAD" "$BASE"
  assert_result "PR #874 nine-path replay is docs-only" true

  git -C "$REPO" checkout -q --detach "$BASE"
  run_classifier "$BASE" "$BASE"
  assert_result "empty diff is docs-only" true

  git -C "$REPO" checkout -q -B base-moved "$BASE"
  mkdir -p "$REPO/src"
  printf 'base moved\n' >"$REPO/src/base-change.ts"
  git -C "$REPO" add src/base-change.ts
  git -C "$REPO" commit -qm base-moved
  BASE_MOVED="$(git -C "$REPO" rev-parse HEAD)"
  preview_checkout "$DOC_HEAD" "$BASE_MOVED"
  run_classifier "$DOC_HEAD" "$BASE_MOVED"
  assert_result "docs-only branch still skips after the base branch moves" true

  UPPER_HEAD="$(printf '%s' "$DOC_HEAD" | tr '[:lower:]' '[:upper:]')"
  UPPER_BASE="$(printf '%s' "$BASE" | tr '[:lower:]' '[:upper:]')"
  run_classifier "$UPPER_HEAD" "$UPPER_BASE"
  assert_result "uppercase commit ids are normalized" true

  DOC_BASE="$(commit_file_from delete-base "$BASE" doc/deleted.md before)"
  git -C "$REPO" checkout -q -B delete-doc "$DOC_BASE"
  git -C "$REPO" rm -q doc/deleted.md
  git -C "$REPO" commit -qm delete-doc
  DELETE_HEAD="$(git -C "$REPO" rev-parse HEAD)"
  preview_checkout "$DELETE_HEAD" "$DOC_BASE"
  run_classifier "$DELETE_HEAD" "$DOC_BASE"
  assert_result "deleting an allowlisted regular document skips" true

  CODE_HEAD="$(commit_file_from code-only "$BASE" src/code.ts 'export const value = 1;')"
  preview_checkout "$CODE_HEAD" "$BASE"
  run_classifier "$CODE_HEAD" "$BASE"
  assert_result "code-only diff runs the full suite" false
  assert_reason "code-only diff explains its fail-closed decision" diff_not_inert

  git -C "$REPO" checkout -q -B mixed "$BASE"
  mkdir -p "$REPO/doc" "$REPO/src"
  printf 'notes\n' >"$REPO/doc/notes.md"
  printf 'export const mixed = true;\n' >"$REPO/src/mixed.ts"
  git -C "$REPO" add doc/notes.md src/mixed.ts
  git -C "$REPO" commit -qm mixed
  MIXED_HEAD="$(git -C "$REPO" rev-parse HEAD)"
  preview_checkout "$MIXED_HEAD" "$BASE"
  run_classifier "$MIXED_HEAD" "$BASE"
  assert_result "docs plus code runs the full suite" false
  assert_reason "mixed diff explains its fail-closed decision" diff_not_inert

  non_inert_paths=(
    packages/x/progress.md
    .github/workflows/extra.yml
    scripts/ci-classify.sh
    packages/teamlead/prompts/runtime.md
    doc/VERSION
    product/doc/example/evidence/admit.mjs
  )
  for index in "${!non_inert_paths[@]}"; do
    path="${non_inert_paths[$index]}"
    head="$(commit_file_from "non-inert-$index" "$BASE" "$path")"
    preview_checkout "$head" "$BASE"
    run_classifier "$head" "$BASE"
    assert_result "non-inert path runs the full suite: $path" false
    assert_reason "non-inert path supplies a reason: $path" diff_not_inert
  done

  CODE_BASE="$(commit_file_from rename-base "$BASE" src/rename.ts 'export const rename = true;')"
  git -C "$REPO" checkout -q -B rename-code-to-doc "$CODE_BASE"
  mkdir -p "$REPO/engineering/doc/rename"
  git -C "$REPO" mv src/rename.ts engineering/doc/rename/rename.md
  git -C "$REPO" commit -qm rename-code-to-doc
  RENAME_HEAD="$(git -C "$REPO" rev-parse HEAD)"
  preview_checkout "$RENAME_HEAD" "$CODE_BASE"
  run_classifier "$RENAME_HEAD" "$CODE_BASE"
  assert_result "code-to-doc rename runs the full suite under no-renames diff" false
  assert_reason "code-to-doc rename supplies a reason" diff_not_inert

  git -C "$REPO" checkout -q -B symlink "$BASE"
  mkdir -p "$REPO/engineering/doc/symlink"
  ln -s ../../outside "$REPO/engineering/doc/symlink/link.md"
  git -C "$REPO" add engineering/doc/symlink/link.md
  git -C "$REPO" commit -qm symlink
  SYMLINK_HEAD="$(git -C "$REPO" rev-parse HEAD)"
  preview_checkout "$SYMLINK_HEAD" "$BASE"
  run_classifier "$SYMLINK_HEAD" "$BASE"
  assert_result "allowlisted symlink runs the full suite" false
  assert_reason "allowlisted symlink mode supplies a reason" diff_not_inert

  git -C "$REPO" checkout -q -B gitlink "$BASE"
  mkdir -p "$REPO/engineering/doc/gitlink"
  git -C "$REPO" update-index --add --cacheinfo "160000,$BASE,engineering/doc/gitlink/repo.md"
  git -C "$REPO" commit -qm gitlink
  GITLINK_HEAD="$(git -C "$REPO" rev-parse HEAD)"
  preview_checkout "$GITLINK_HEAD" "$BASE"
  run_classifier "$GITLINK_HEAD" "$BASE"
  assert_result "allowlisted gitlink runs the full suite" false
  assert_reason "allowlisted gitlink mode supplies a reason" diff_not_inert

  run_classifier not-a-sha "$BASE"
  assert_result "invalid head input fails closed" false
  assert_reason "invalid head input supplies a reason" invalid_input

  run_classifier "$DOC_HEAD" not-a-sha
  assert_result "invalid base input fails closed" false
  assert_reason "invalid base input supplies a reason" invalid_input

  run_classifier aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$BASE"
  assert_result "missing head commit fails closed" false
  assert_reason "missing head commit supplies a reason" head_commit_missing

  run_classifier "$DOC_HEAD" bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  assert_result "missing base commit fails closed" false
  assert_reason "missing base commit supplies a reason" base_commit_missing

  EMPTY_TREE="$(git -C "$REPO" mktree </dev/null)"
  ORPHAN="$(printf 'orphan\n' | git -C "$REPO" commit-tree "$EMPTY_TREE")"
  run_classifier "$DOC_HEAD" "$ORPHAN"
  assert_result "unrelated histories fail closed" false
  assert_reason "unrelated histories supply a reason" merge_base_unresolvable

  CRISS_A1="$(commit_file_from criss-a "$BASE" src/criss.ts 'export const criss = true;')"
  CRISS_B1="$(commit_file_from criss-b "$BASE" doc/criss.md docs)"
  git -C "$REPO" checkout -q -B criss-union "$CRISS_A1"
  git -C "$REPO" checkout "$CRISS_B1" -- doc/criss.md
  git -C "$REPO" commit -qm criss-union-tree
  CRISS_TREE="$(git -C "$REPO" rev-parse 'HEAD^{tree}')"
  CRISS_A2="$(printf 'criss merge A\n' | git -C "$REPO" commit-tree "$CRISS_TREE" -p "$CRISS_A1" -p "$CRISS_B1")"
  CRISS_B2="$(printf 'criss merge B\n' | git -C "$REPO" commit-tree "$CRISS_TREE" -p "$CRISS_B1" -p "$CRISS_A1")"
  CRISS_BASE_COUNT="$(git -C "$REPO" merge-base --all "$CRISS_A2" "$CRISS_B2" | wc -l | tr -d ' ')"
  if [[ "$CRISS_BASE_COUNT" -eq 2 ]]; then
    pass "positive control: criss-cross fixture has two merge bases"
  else
    fail "positive control: criss-cross fixture has two merge bases (got $CRISS_BASE_COUNT)"
  fi
  preview_checkout "$CRISS_A2" "$CRISS_B2"
  run_classifier "$CRISS_A2" "$CRISS_B2"
  assert_result "ambiguous merge bases fail closed" false
  assert_reason "ambiguous merge bases supply a reason" merge_base_ambiguous

  git -C "$REPO" checkout -q -B rebased-main "$BASE"
  mkdir -p "$REPO/src"
  printf 'main moved\n' >"$REPO/src/rebased-base.ts"
  git -C "$REPO" add src/rebased-base.ts
  git -C "$REPO" commit -qm rebased-main
  REBASED_BASE="$(git -C "$REPO" rev-parse HEAD)"
  REBASED_HEAD="$(commit_file_from rebased-docs "$REBASED_BASE" doc/rebased.md docs)"
  preview_checkout "$REBASED_HEAD" "$BASE"
  run_classifier "$REBASED_HEAD" "$BASE"
  assert_result "stale base input plus rebased head runs the full suite" false
  assert_reason "stale base plus rebased head supplies a reason" diff_not_inert

  runs_api_pattern='gh[[:space:]]+api|workflows/ci\.yml/runs'
  if grep -Eq "$runs_api_pattern" "$SUBJECT"; then
    fail "classifier contains no runs API call"
  else
    pass "classifier contains no runs API call"
  fi
  runs_api_positive_control='gh api repos/example/project/actions/workflows/ci.yml/runs'
  if grep -Eq "$runs_api_pattern" <<<"$runs_api_positive_control"; then
    pass "positive control: runs API residue ruler fires"
  else
    fail "positive control: runs API residue ruler fires"
  fi

  command_pattern='(^|[;&|[:space:]])(gh|jq)([;&|[:space:]]|$)'
  if grep -Eq "$command_pattern" "$SUBJECT"; then
    fail "classifier invokes neither gh nor jq"
  else
    pass "classifier invokes neither gh nor jq"
  fi
  if grep -Eq "$command_pattern" <<<'jq -r .status'; then
    pass "positive control: gh/jq command ruler fires"
  else
    fail "positive control: gh/jq command ruler fires"
  fi

  if grep -Eq 'fail_closed([[:space:]]*;)?[[:space:]]*$' "$SUBJECT"; then
    fail "every fail_closed call supplies a diagnostic reason"
  else
    pass "every fail_closed call supplies a diagnostic reason"
  fi
fi

printf '\nPassed: %s  Failed: %s\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
