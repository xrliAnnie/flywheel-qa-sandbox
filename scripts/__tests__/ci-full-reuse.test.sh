#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="$ROOT/scripts/ci-full-reuse.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
REMOTE="$TMP/origin.git"
FIXTURES="$TMP/fixtures"
BIN="$TMP/bin"
mkdir -p "$REPO" "$FIXTURES" "$BIN"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

git init -q --bare "$REMOTE"
git -C "$REPO" init -q -b basebranch
git -C "$REPO" config user.email ci@example.test
git -C "$REPO" config user.name CI
git -C "$REPO" remote add origin "$REMOTE"
mkdir -p "$REPO/.github"
cp "$ROOT/.github/ci-required-jobs.json" "$REPO/.github/ci-required-jobs.json"
cp "$REPO/.github/ci-required-jobs.json" "$TMP/good-manifest.json"
printf 'base\n' >"$REPO/file.txt"
git -C "$REPO" add .github/ci-required-jobs.json file.txt
git -C "$REPO" commit -qm base
BASE="$(git -C "$REPO" rev-parse HEAD)"

git -C "$REPO" checkout -q -b feature
printf 'feature\n' >"$REPO/feature.txt"
git -C "$REPO" add feature.txt
git -C "$REPO" commit -qm feature
FEATURE="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" push -q origin "$FEATURE:refs/heads/feature"

git -C "$REPO" checkout -q -b main "$BASE"
git -C "$REPO" merge -q --no-ff -m merge "$FEATURE"
MERGE="$(git -C "$REPO" rev-parse HEAD)"
TREE="$(git -C "$REPO" rev-parse 'HEAD^{tree}')"
git -C "$REPO" push -q origin "$MERGE:refs/heads/main"

git -C "$REPO" checkout -q -b other "$BASE"
printf 'other\n' >"$REPO/other.txt"
git -C "$REPO" add other.txt
git -C "$REPO" commit -qm other
OTHER="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" push -q origin "$OTHER:refs/heads/other"

git -C "$REPO" checkout -q -b conflict "$BASE"
printf 'conflict\n' >"$REPO/feature.txt"
git -C "$REPO" add feature.txt
git -C "$REPO" commit -qm conflict
CONFLICT="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" push -q origin "$CONFLICT:refs/heads/conflict"
git -C "$REPO" checkout -q --detach "$MERGE"

cat >"$BIN/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$GH_CALL_LOG"
endpoint="${2:-}"
scenario="${GH_SCENARIO:-good_pr}"
if [[ "$scenario" == api_failure ]]; then
  exit 1
fi
if [[ "$scenario" == api_timeout ]]; then
  sleep 5
fi
case "$endpoint" in
  *'/actions/artifacts?'*)
    if [[ "$scenario" == too_many_artifacts ]]; then
      jq '{total_count: 6, artifacts: [.artifacts[0], .artifacts[0], .artifacts[0], .artifacts[0], .artifacts[0], .artifacts[0]]}' "$GH_FIXTURES/artifacts.json"
    elif [[ "$scenario" == expired_artifact ]]; then
      jq '.artifacts[0].expired = true' "$GH_FIXTURES/artifacts.json"
    else
      cat "$GH_FIXTURES/artifacts.json"
    fi
    ;;
  */actions/runs/42/jobs*)
    case "$scenario" in
      skipped_job) jq '.jobs[2].conclusion = "skipped"' "$GH_FIXTURES/jobs.json" ;;
      missing_aggregate) jq '.jobs |= map(select(.name != "CI OK")) | .total_count = (.jobs | length)' "$GH_FIXTURES/jobs.json" ;;
      missing_matrix) jq '.jobs |= map(select(.name != "Unit (teamlead 2 of 4)")) | .total_count = (.jobs | length)' "$GH_FIXTURES/jobs.json" ;;
      missing_shard) jq '.jobs |= map(select(.name != "Script Tests 6/6 — balanced shell suites F")) | .total_count = (.jobs | length)' "$GH_FIXTURES/jobs.json" ;;
      only_sixteen) jq '.jobs = .jobs[0:16] | .total_count = 16' "$GH_FIXTURES/jobs.json" ;;
      extra_job) jq '.jobs += [{name:"Unknown",conclusion:"success"}] | .total_count = (.jobs | length)' "$GH_FIXTURES/jobs.json" ;;
      duplicate_job) jq '.jobs[2].name = .jobs[1].name' "$GH_FIXTURES/jobs.json" ;;
      too_many_jobs) jq '.total_count = 101' "$GH_FIXTURES/jobs.json" ;;
      *) cat "$GH_FIXTURES/jobs.json" ;;
    esac
    ;;
  */actions/runs/42)
    case "$scenario" in
      run_failure) jq '.conclusion = "failure"' "$GH_FIXTURES/run.json" ;;
      wrong_path) jq '.path = ".github/workflows/other.yml"' "$GH_FIXTURES/run.json" ;;
      wrong_repo) jq '.repository.id = 999' "$GH_FIXTURES/run.json" ;;
      wrong_full_name) jq '.head_repository.full_name = "evil/fork"' "$GH_FIXTURES/run.json" ;;
      *) cat "$GH_FIXTURES/run.json" ;;
    esac
    ;;
  *)
    printf 'unexpected endpoint: %s\n' "$endpoint" >&2
    exit 2
    ;;
esac
SH
chmod +x "$BIN/gh"
cat >"$BIN/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${GH_SCENARIO:-}" == fetch_failure && "${1:-}" == fetch ]]; then
  exit 1
fi
exec /usr/bin/git "$@"
SH
chmod +x "$BIN/git"

write_fixtures() {
  local event="$1" head="$2"
  jq -n --arg tree "$TREE" '{total_count:1,artifacts:[{id:7,name:("ci-full-green-"+$tree),expired:false,created_at:"2026-09-17T20:00:00Z",workflow_run:{id:42}}]}' >"$FIXTURES/artifacts.json"
  jq -n --arg event "$event" --arg head "$head" '{id:42,path:".github/workflows/ci.yml",status:"completed",conclusion:"success",event:$event,head_sha:$head,repository:{id:123,full_name:"xrliAnnie/flywheel"},head_repository:{id:123,full_name:"xrliAnnie/flywheel"}}' >"$FIXTURES/run.json"
  jq -n --slurpfile manifest "$TMP/good-manifest.json" '{jobs:(($manifest[0].always+$manifest[0].heavy+[$manifest[0].aggregate]) | map({name:.,conclusion:"success"}))} | .total_count = (.jobs | length)' >"$FIXTURES/jobs.json"
}

run_reuse() {
  local scenario="$1" event="${2:-push}" evidence_event="${3:-pull_request}" evidence_head="${4:-$FEATURE}"
  local output="$TMP/github-output"
  : >"$output"
  : >"$TMP/gh-calls"
  write_fixtures "$evidence_event" "$evidence_head"
  set +e
  (
    cd "$REPO"
    PATH="$BIN:/usr/bin:/bin" \
      GH_FIXTURES="$FIXTURES" GH_CALL_LOG="$TMP/gh-calls" GH_SCENARIO="$scenario" \
      CI_FULL_REUSE_TIMEOUT_SECONDS=1 \
      GITHUB_OUTPUT="$output" CI_SCOPED_MODE=on EVENT_NAME="$event" \
      GITHUB_SHA="$MERGE" GITHUB_REPOSITORY=xrliAnnie/flywheel GITHUB_REPOSITORY_ID=123 \
      bash "$SUBJECT"
  ) >"$TMP/stdout" 2>"$TMP/stderr"
  REUSE_RC=$?
  set -e
  REUSE_VALUE="$(sed -n 's/^reuse=//p' "$output")"
  REUSE_RUN="$(sed -n 's/^reuse_run=//p' "$output")"
  REUSE_LINES="$(wc -l <"$output" | tr -d '[:space:]')"
}

assert_reuse() {
  local name="$1" expected="$2" expected_run="${3:-}"
  if [[ "$REUSE_RC" -eq 0 && "$REUSE_VALUE" == "$expected" &&
    "$REUSE_RUN" == "$expected_run" && "$REUSE_LINES" -eq 2 ]]; then
    pass "$name"
  else
    fail "$name (rc=$REUSE_RC reuse=${REUSE_VALUE:-missing} run=${REUSE_RUN:-missing} lines=$REUSE_LINES stderr=$(cat "$TMP/stderr"))"
  fi
}

if [[ ! -f "$SUBJECT" ]]; then
  fail "ci-full-reuse.sh exists"
else
  run_reuse good_pr
  assert_reuse "reuses a full green PR run whose recomputed merge tree matches" true 42

  run_reuse good_push push push "$MERGE"
  assert_reuse "reuses a full green push run with the same tree" true 42

  for scenario in run_failure wrong_path wrong_repo wrong_full_name skipped_job missing_aggregate missing_matrix missing_shard only_sixteen extra_job duplicate_job too_many_jobs expired_artifact too_many_artifacts api_failure api_timeout; do
    run_reuse "$scenario"
    assert_reuse "$scenario fails closed" false
  done

  run_reuse good_pr pull_request
  assert_reuse "non-push invocation does not reuse" false

  CI_SCOPED_MODE=off EVENT_NAME=push GITHUB_OUTPUT="$TMP/off-output" bash "$SUBJECT"
  if grep -Fxq 'reuse=false' "$TMP/off-output"; then
    pass "rollout switch off does not reuse"
  else
    fail "rollout switch off does not reuse"
  fi

  mv "$REPO/.github/ci-required-jobs.json" "$TMP/manifest"
  run_reuse good_pr
  assert_reuse "missing manifest fails closed" false
  mv "$TMP/manifest" "$REPO/.github/ci-required-jobs.json"

  cp "$REPO/.github/ci-required-jobs.json" "$TMP/manifest"
  printf '{bad json\n' >"$REPO/.github/ci-required-jobs.json"
  run_reuse good_pr
  assert_reuse "malformed manifest fails closed" false
  mv "$TMP/manifest" "$REPO/.github/ci-required-jobs.json"

  run_reuse good_pr push pull_request "$OTHER"
  assert_reuse "merge-tree mismatch fails closed" false

  run_reuse good_pr push pull_request "$CONFLICT"
  assert_reuse "merge conflict fails closed" false

  run_reuse good_push push push "$BASE"
  assert_reuse "push evidence with a different tree fails closed" false

  run_reuse fetch_failure
  assert_reuse "fetch failure fails closed" false

  if ! grep -Eq '/actions/artifacts/[0-9]+/(zip|download)|/download' "$TMP/gh-calls"; then
    pass "reuse reads artifact metadata and never downloads artifact contents"
  else
    fail "reuse reads artifact metadata and never downloads artifact contents"
  fi
  printf 'api repos/x/actions/artifacts/7/zip\n' >"$TMP/download-positive-control"
  if grep -Eq '/actions/artifacts/[0-9]+/(zip|download)|/download' "$TMP/download-positive-control"; then
    pass "artifact-download guard detects a positive control"
  else
    fail "artifact-download guard detects a positive control"
  fi
fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
