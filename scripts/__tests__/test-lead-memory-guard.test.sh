#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/lead-memory/lib/guard.sh"
TASK_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fly2145-guard.XXXXXX")"
trap 'rm -rf -- "$TASK_TMP_DIR"' EXIT

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

git_quiet() {
  git "$@" >/dev/null 2>&1
}

test -x "$GUARD" || fail "guard library exists and is executable"

PASSED=0

pass() {
  PASSED=$((PASSED + 1))
  printf 'ok - %s\n' "$1"
}

expect_success() {
  local label="$1"
  shift
  if "$@" >"$TASK_TMP_DIR/stdout" 2>"$TASK_TMP_DIR/stderr"; then
    pass "$label"
  else
    sed 's/^/  /' "$TASK_TMP_DIR/stderr" >&2
    fail "$label"
  fi
}

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

CASE_ID=0
new_repo() {
  CASE_ID=$((CASE_ID + 1))
  REPO="$TASK_TMP_DIR/repo-$CASE_ID"
  STATE="$TASK_TMP_DIR/state-$CASE_ID"
  git_quiet init -b main "$REPO"
  git -C "$REPO" config user.name "FLY-2145 Test"
  git -C "$REPO" config user.email "fly2145@example.test"
}

stage_file() {
  local path="$1" content="${2:-memory}"
  mkdir -p "$(dirname "$REPO/$path")"
  printf '%s\n' "$content" >"$REPO/$path"
  git_quiet -C "$REPO" add -- "$path"
}

run_staged_lead() {
  local lead_id="$1"
  (
    cd "$REPO"
    env -u FLYWHEEL_MEMORY_ACTOR FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_LEAD_ID="$lead_id" \
      "$GUARD" check-staged
  )
}

run_staged_actor() {
  local actor="$1"
  (
    cd "$REPO"
    env -u FLYWHEEL_LEAD_ID FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_MEMORY_ACTOR="$actor" \
      "$GUARD" check-staged
  )
}

run_staged_no_identity() {
  (
    cd "$REPO"
    env -u FLYWHEEL_LEAD_ID -u FLYWHEEL_MEMORY_ACTOR FLYWHEEL_STATE_DIR="$STATE" \
      "$GUARD" check-staged
  )
}

run_trailer_lead() {
  local lead_id="$1" message_file="$2"
  (
    cd "$REPO"
    env -u FLYWHEEL_MEMORY_ACTOR FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_LEAD_ID="$lead_id" \
      "$GUARD" trailer "$message_file"
  )
}

run_trailer_actor() {
  local actor="$1" message_file="$2"
  (
    cd "$REPO"
    env -u FLYWHEEL_LEAD_ID FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_MEMORY_ACTOR="$actor" \
      "$GUARD" trailer "$message_file"
  )
}

run_range() {
  local range="$1"
  (
    cd "$REPO"
    env -u FLYWHEEL_LEAD_ID -u FLYWHEEL_MEMORY_ACTOR FLYWHEEL_STATE_DIR="$STATE" \
      "$GUARD" check-range "$range"
  )
}

run_push_lead() {
  local lead_id="$1" push_line="$2"
  (
    cd "$REPO"
    printf '%s\n' "$push_line" | \
      env -u FLYWHEEL_MEMORY_ACTOR FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_LEAD_ID="$lead_id" \
        "$GUARD" check-push
  )
}

run_push_actor() {
  local actor="$1" push_line="$2"
  (
    cd "$REPO"
    printf '%s\n' "$push_line" | \
      env -u FLYWHEEL_LEAD_ID FLYWHEEL_STATE_DIR="$STATE" FLYWHEEL_MEMORY_ACTOR="$actor" \
        "$GUARD" check-push
  )
}

run_lead_tree() {
  local treeish="$1"
  (
    cd "$REPO"
    env FLYWHEEL_STATE_DIR="$STATE" "$GUARD" lead-tree "$treeish"
  )
}

commit_message() {
  local subject="$1" owner="$2"
  git_quiet -C "$REPO" commit -m "$subject" -m "Memory-Owner: $owner"
}

new_repo
stage_file flywheel-eng-lead/MEMORY.md own
expect_success "lead can stage its own folder" run_staged_lead flywheel-eng-lead

new_repo
stage_file sub-lead/MEMORY.md foreign
expect_failure "lead cannot stage another folder" \
  "lead-memory-guard: refusing commit" run_staged_lead flywheel-eng-lead

new_repo
stage_file README.md top-level
expect_failure "lead cannot stage a top-level file" \
  "lead-memory-guard: refusing commit" run_staged_lead flywheel-eng-lead

new_repo
stage_file flywheel-eng-lead/a.md one
stage_file sub-lead/b.md two
expect_failure "lead cannot stage two folders" \
  "lead-memory-guard: refusing commit" run_staged_lead flywheel-eng-lead

new_repo
stage_file flywheel-eng-lead/a.md one
expect_failure "missing identity fails closed" \
  "FLYWHEEL_LEAD_ID is required" run_staged_no_identity

new_repo
stage_file flywheel-eng-lead/a.md one
expect_failure "invalid lead identity fails closed" \
  "invalid FLYWHEEL_LEAD_ID" run_staged_lead '../flywheel-eng-lead'

new_repo
stage_file flywheel-eng-lead/a.md one
expect_failure "unknown actor fails closed" \
  "unknown FLYWHEEL_MEMORY_ACTOR" run_staged_actor mystery

new_repo
stage_file flywheel-eng-lead/a.md one
expect_failure "control characters in an invalid actor fail closed" \
  "unknown FLYWHEEL_MEMORY_ACTOR" run_staged_actor $'bad\tactor\nforged'
CONTROL_AUDIT="$STATE/state/lead-memory/audit.log"
test "$(wc -l <"$CONTROL_AUDIT" | tr -d ' ')" = 1 ||
  fail "control characters must not forge additional audit rows"
awk -F '\t' 'NF == 6 { found = 1 } END { exit found ? 0 : 1 }' "$CONTROL_AUDIT" ||
  fail "control characters must not forge additional audit fields"
pass "rejected external identity values remain one six-field audit row"

new_repo
stage_file sub-lead/a.md one
expect_success "sync can stage exactly one Lead folder" run_staged_actor sync
test "$(wc -l <"$STATE/state/lead-memory/audit.log" | tr -d ' ')" = 1 || \
  fail "sync allow writes one audit row"
pass "sync allow writes one audit row"

new_repo
stage_file sub-lead/a.md one
stage_file flywheel-eng-lead/b.md two
expect_failure "sync cannot combine Lead folders" \
  "lead-memory-guard: refusing commit" run_staged_actor sync

new_repo
stage_file README.md top
expect_failure "sync cannot stage top-level files" \
  "lead-memory-guard: refusing commit" run_staged_actor sync

new_repo
stage_file README.md top
stage_file flywheel-eng-lead/a.md one
stage_file sub-lead/b.md two
expect_success "admin can stage top-level files and multiple folders" run_staged_actor admin
test "$(wc -l <"$STATE/state/lead-memory/audit.log" | tr -d ' ')" = 1 || \
  fail "admin allow writes one audit row"
pass "admin allow writes one audit row"

new_repo
stage_file README.md top
STATE=/dev/null
expect_failure "admin allow fails closed without durable audit" \
  "audit evidence could not be written" run_staged_actor admin

new_repo
mkdir -p "$REPO/sub-lead"
printf 'old\n' >"$REPO/sub-lead/old.md"
git_quiet -C "$REPO" add sub-lead/old.md
git_quiet -C "$REPO" commit -m baseline
git_quiet -C "$REPO" rm sub-lead/old.md
expect_failure "deleting another Lead path is rejected" \
  "lead-memory-guard: refusing commit" run_staged_lead flywheel-eng-lead

new_repo
stage_file flywheel-eng-lead/old.md old
git_quiet -C "$REPO" commit -m baseline
mkdir -p "$REPO/sub-lead"
git_quiet -C "$REPO" mv flywheel-eng-lead/old.md sub-lead/new.md
expect_failure "renaming into another Lead folder is rejected" \
  "lead-memory-guard: refusing commit" run_staged_lead flywheel-eng-lead

new_repo
stage_file flywheel-eng-lead/a.md one
MESSAGE="$TASK_TMP_DIR/message-lead"
printf 'remember\n' >"$MESSAGE"
expect_success "trailer adds Lead owner" run_trailer_lead flywheel-eng-lead "$MESSAGE"
test "$(git interpret-trailers --parse <"$MESSAGE")" = "Memory-Owner: flywheel-eng-lead" ||
  fail "Lead trailer value is exact"
pass "Lead trailer value is exact"
expect_success "trailer update is idempotent" run_trailer_lead flywheel-eng-lead "$MESSAGE"
test "$(grep -c '^Memory-Owner:' "$MESSAGE")" = 1 || fail "trailer remains unique"
pass "trailer remains unique"

new_repo
stage_file sub-lead/a.md one
MESSAGE="$TASK_TMP_DIR/message-sync"
printf 'sync\n' >"$MESSAGE"
expect_success "sync trailer derives its one staged folder" run_trailer_actor sync "$MESSAGE"
test "$(git interpret-trailers --parse <"$MESSAGE")" = "Memory-Owner: sub-lead" ||
  fail "sync trailer value is exact"
pass "sync trailer value is exact"

new_repo
stage_file README.md top
MESSAGE="$TASK_TMP_DIR/message-admin"
printf 'admin\n' >"$MESSAGE"
expect_success "admin trailer uses admin owner" run_trailer_actor admin "$MESSAGE"
test "$(git interpret-trailers --parse <"$MESSAGE")" = "Memory-Owner: admin" ||
  fail "admin trailer value is exact"
pass "admin trailer value is exact"

# Root commit coverage: --root is required for this valid commit to have paths.
new_repo
stage_file flywheel-eng-lead/a.md one
commit_message valid-root flywheel-eng-lead
ROOT_SHA="$(git -C "$REPO" rev-parse HEAD)"
expect_success "check-range accepts a valid root commit" run_range "$ROOT_SHA"

new_repo
stage_file flywheel-eng-lead/a.md one
commit_message wrong-owner sub-lead
expect_failure "check-range rejects a mismatched owner" \
  "owner sub-lead does not match" run_range "$(git -C "$REPO" rev-parse HEAD)"

new_repo
stage_file flywheel-eng-lead/a.md one
git_quiet -C "$REPO" commit -m missing-owner
expect_failure "check-range rejects a missing owner trailer" \
  "exactly one Memory-Owner trailer" run_range "$(git -C "$REPO" rev-parse HEAD)"

new_repo
stage_file flywheel-eng-lead/a.md one
git_quiet -C "$REPO" commit -m owner-looking-body \
  -m $'Memory-Owner: admin\nordinary prose after owner-looking body line'
expect_failure "check-range rejects an owner-looking body line outside the trailer block" \
  "exactly one Memory-Owner trailer" run_range "$(git -C "$REPO" rev-parse HEAD)"

new_repo
stage_file flywheel-eng-lead/a.md one
git_quiet -C "$REPO" commit -m duplicate-owner \
  -m $'Memory-Owner: flywheel-eng-lead\nMemory-Owner: flywheel-eng-lead'
expect_failure "check-range rejects duplicate owner trailers" \
  "exactly one Memory-Owner trailer" run_range "$(git -C "$REPO" rev-parse HEAD)"

new_repo
stage_file flywheel-eng-lead/a.md one
git_quiet -C "$REPO" commit -m duplicate-owner-case \
  -m $'Memory-Owner: flywheel-eng-lead\nmemory-owner: sub-lead'
expect_failure "check-range rejects case-variant duplicate owner trailers" \
  "exactly one Memory-Owner trailer" run_range "$(git -C "$REPO" rev-parse HEAD)"

new_repo
stage_file flywheel-eng-lead/a.md one
stage_file sub-lead/b.md two
commit_message multi-folder flywheel-eng-lead
expect_failure "check-range rejects a multi-folder Lead commit" \
  "owner flywheel-eng-lead does not match" run_range "$(git -C "$REPO" rev-parse HEAD)"

new_repo
stage_file README.md top
git_quiet -C "$REPO" commit -m valid-admin -m 'Memory-Owner: admin'
expect_success "check-range accepts an admin root commit" \
  run_range "$(git -C "$REPO" rev-parse HEAD)"

new_repo
stage_file flywheel-eng-lead/a.md one
commit_message base flywheel-eng-lead
git_quiet -C "$REPO" commit --allow-empty -m empty -m 'Memory-Owner: flywheel-eng-lead'
expect_failure "check-range rejects an empty commit" \
  "empty commit" run_range "$(git -C "$REPO" rev-parse HEAD)"

new_repo
stage_file flywheel-eng-lead/a.md one
commit_message base flywheel-eng-lead
git_quiet -C "$REPO" checkout -b side
stage_file flywheel-eng-lead/side.md side
commit_message side flywheel-eng-lead
git_quiet -C "$REPO" checkout main
stage_file flywheel-eng-lead/main.md main
commit_message main flywheel-eng-lead
git_quiet -C "$REPO" merge --no-ff side -m merge -m 'Memory-Owner: flywheel-eng-lead'
expect_failure "check-range rejects a merge commit" \
  "merge commit" run_range "$(git -C "$REPO" rev-parse HEAD)"

ZERO_SHA=0000000000000000000000000000000000000000

new_repo
stage_file flywheel-eng-lead/a.md one
commit_message valid-root flywheel-eng-lead
LOCAL_SHA="$(git -C "$REPO" rev-parse HEAD)"
expect_success "check-push accepts a valid new main branch" run_push_lead flywheel-eng-lead \
  "refs/heads/main $LOCAL_SHA refs/heads/main $ZERO_SHA"

new_repo
stage_file README.md top
git_quiet -C "$REPO" commit -m import -m 'Memory-Owner: admin'
LOCAL_SHA="$(git -C "$REPO" rev-parse HEAD)"
expect_success "check-push accepts an admin initial import" run_push_actor admin \
  "refs/heads/main $LOCAL_SHA refs/heads/main $ZERO_SHA"
expect_failure "sync push cannot publish an admin-owned commit" \
  "push actor sync cannot publish owner admin" run_push_actor sync \
  "refs/heads/main $LOCAL_SHA refs/heads/main $ZERO_SHA"

new_repo
stage_file sub-lead/a.md one
commit_message foreign-root sub-lead
LOCAL_SHA="$(git -C "$REPO" rev-parse HEAD)"
expect_failure "lead push applies identity rule to every new commit" \
  "push actor flywheel-eng-lead cannot publish owner sub-lead" run_push_lead flywheel-eng-lead \
  "refs/heads/main $LOCAL_SHA refs/heads/main $ZERO_SHA"

new_repo
stage_file flywheel-eng-lead/a.md one
git_quiet -C "$REPO" commit -m missing-owner
LOCAL_SHA="$(git -C "$REPO" rev-parse HEAD)"
git_quiet -C "$REPO" update-ref refs/remotes/origin/mask "$LOCAL_SHA"
expect_failure "new main checks commits hidden behind a local remote-tracking ref" \
  "exactly one Memory-Owner trailer" run_push_lead flywheel-eng-lead \
  "refs/heads/main $LOCAL_SHA refs/heads/main $ZERO_SHA"

new_repo
stage_file flywheel-eng-lead/a.md one
commit_message base flywheel-eng-lead
REMOTE_SHA="$(git -C "$REPO" rev-parse HEAD)"
stage_file flywheel-eng-lead/b.md two
commit_message forward flywheel-eng-lead
LOCAL_SHA="$(git -C "$REPO" rev-parse HEAD)"
expect_success "check-push accepts a valid fast-forward" run_push_lead flywheel-eng-lead \
  "refs/heads/main $LOCAL_SHA refs/heads/main $REMOTE_SHA"

expect_failure "check-push rejects remote branch deletion" \
  "refusing deletion of remote branch main" run_push_actor admin \
  "(delete) $ZERO_SHA refs/heads/main $LOCAL_SHA"

git_quiet -C "$REPO" checkout --orphan rewritten
git_quiet -C "$REPO" rm -rf .
stage_file flywheel-eng-lead/rewrite.md rewrite
commit_message rewrite flywheel-eng-lead
REWRITE_SHA="$(git -C "$REPO" rev-parse HEAD)"
expect_failure "check-push rejects every non-fast-forward without an ACK" \
  "refusing non-fast-forward update for main" run_push_lead flywheel-eng-lead \
  "refs/heads/rewritten $REWRITE_SHA refs/heads/main $LOCAL_SHA"

new_repo
stage_file README.md top
git_quiet -C "$REPO" commit -m import -m 'Memory-Owner: admin'
LOCAL_SHA="$(git -C "$REPO" rev-parse HEAD)"
STATE=/dev/null
expect_failure "admin push fails closed without durable audit" \
  "audit evidence could not be written" run_push_actor admin \
  "refs/heads/main $LOCAL_SHA refs/heads/main $ZERO_SHA"

new_repo
stage_file flywheel-eng-lead/a.md one
commit_message valid-root flywheel-eng-lead
LOCAL_SHA="$(git -C "$REPO" rev-parse HEAD)"
expect_failure "memory guard refuses non-main branches" \
  "only refs/heads/main may be pushed" run_push_lead flywheel-eng-lead \
  "refs/heads/feature $LOCAL_SHA refs/heads/feature $ZERO_SHA"

LEAD_NAMES="cos-lead flywheel-cos-lead flywheel-eng-lead flywheel-product-lead joycon-lead ops-lead product-lead rafiki-lead reflection-lead sub-lead tidal-echo-content-lead tidal-echo-cos-lead"
new_repo
for lead_name in $LEAD_NAMES; do
  stage_file "$lead_name/MEMORY.md" "$lead_name"
done
stage_file README.md management
FULL_TREE="$(git -C "$REPO" write-tree)"
expect_success "lead-tree reconstructs the twelve-folder synthetic root" \
  run_lead_tree "$FULL_TREE"
cp "$TASK_TMP_DIR/stdout" "$TASK_TMP_DIR/lead-tree-one"
SYNTHETIC_TREE="$(awk -F '\t' 'NR == 1 && $1 == "tree" { print $2 }' "$TASK_TMP_DIR/lead-tree-one")"
test -n "$SYNTHETIC_TREE" || fail "lead-tree reports its synthetic tree OID"
pass "lead-tree reports its synthetic tree OID"
test "$(tail -n +2 "$TASK_TMP_DIR/lead-tree-one" | wc -l | tr -d ' ')" = 12 ||
  fail "lead-tree reports exactly twelve mappings"
pass "lead-tree reports exactly twelve mappings"
if grep -Fq $'\tREADME.md' "$TASK_TMP_DIR/lead-tree-one"; then
  fail "lead-tree excludes management paths"
fi
pass "lead-tree excludes management paths"
test "$(git -C "$REPO" archive "$SYNTHETIC_TREE" | tar -tf - | sed 's#/.*##' | sort -u | wc -l | tr -d ' ')" = 12 ||
  fail "synthetic tree materializes all twelve Lead folders"
pass "synthetic tree materializes all twelve Lead folders"

stage_file sub-lead/MEMORY.md mutated
MUTATED_FULL_TREE="$(git -C "$REPO" write-tree)"
expect_success "lead-tree can reconstruct a later candidate" run_lead_tree "$MUTATED_FULL_TREE"
MUTATED_SYNTHETIC_TREE="$(awk -F '\t' 'NR == 1 { print $2 }' "$TASK_TMP_DIR/stdout")"
test "$MUTATED_SYNTHETIC_TREE" != "$SYNTHETIC_TREE" || fail "Lead content mutation changes synthetic tree"
pass "Lead content mutation changes synthetic tree"

git_quiet -C "$REPO" rm -r --cached cos-lead
MISSING_TREE="$(git -C "$REPO" write-tree)"
expect_failure "lead-tree rejects a candidate missing one Lead folder" \
  "expected exactly 12 Lead folders" run_lead_tree "$MISSING_TREE"

git_quiet -C "$REPO" add cos-lead
stage_file thirteenth-lead/MEMORY.md extra
EXTRA_TREE="$(git -C "$REPO" write-tree)"
expect_failure "lead-tree rejects a thirteenth Lead folder" \
  "expected exactly 12 Lead folders" run_lead_tree "$EXTRA_TREE"

find "$TASK_TMP_DIR" -path '*/state/lead-memory/audit.log' -type f -print0 |
  while IFS= read -r -d '' audit; do
    awk -F '\t' 'NF != 6 { exit 1 }' "$audit" || fail "audit row has six fields: $audit"
  done
pass "every audit row has six fields"

printf 'RESULTS: %d passed\n' "$PASSED"
