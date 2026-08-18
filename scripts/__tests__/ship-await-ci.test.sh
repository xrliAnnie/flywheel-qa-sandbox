#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUBJECT="$ROOT/scripts/ship-await-ci.sh"
VECTORS="$ROOT/scripts/ci-status-vectors.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

mkdir -p "$TMP/bin"

cat >"$TMP/bin/timeout" <<'SH'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >>"$MOCK_TIMEOUT_LOG"
shift
if [[ "${MOCK_TIMEOUT_FAIL_ONCE:-0}" == "1" && ! -e "$MOCK_STATE/timeout-failed" ]]; then
  : >"$MOCK_STATE/timeout-failed"
  exit 124
fi
exec "$@"
SH

cat >"$TMP/bin/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH

cat >"$TMP/bin/date" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
count=0
[[ ! -f "$MOCK_STATE/date-count" ]] || count="$(<"$MOCK_STATE/date-count")"
printf '%s\n' "$((count + 1))" >"$MOCK_STATE/date-count"
printf '%s\n' "$count"
SH

cat >"$TMP/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-} ${2:-}" in
  "pr view")
    printf '{"headRefOid":"%s","state":"%s"}\n' "${MOCK_HEAD_SHA:-$HEAD_SHA}" "${MOCK_PR_STATE:-OPEN}"
    ;;
  "api repos/")
    echo "unexpected exact api form" >&2
    exit 2
    ;;
  "api "*)
    count=0
    [[ ! -f "$MOCK_STATE/check-count" ]] || count="$(<"$MOCK_STATE/check-count")"
    count=$((count + 1))
    printf '%s\n' "$count" >"$MOCK_STATE/check-count"
    if [[ "${MOCK_CHECK_SUCCESS_AT:-0}" -gt 0 && "$count" -ge "$MOCK_CHECK_SUCCESS_AT" ]]; then
      printf '%s\n' '{"check_runs":[{"name":"CI OK","status":"completed","conclusion":"success","started_at":"2026-08-18T00:01:00Z"}]}'
    else
      printf '%s\n' '{"check_runs":[]}'
    fi
    ;;
  "run list")
    count=0
    [[ ! -f "$MOCK_STATE/run-list-count" ]] || count="$(<"$MOCK_STATE/run-list-count")"
    printf '%s\n' "$((count + 1))" >"$MOCK_STATE/run-list-count"
    jq -c --argjson index "$count" '.[$index] // .[-1] // []' "$MOCK_RUN_SEQUENCE"
    ;;
  "run rerun")
    printf '%s\n' "${3:-missing}" >>"$MOCK_RERUN_LOG"
    ;;
  *)
    printf 'unexpected gh argv: %s\n' "$*" >&2
    exit 2
    ;;
esac
SH

chmod +x "$TMP/bin/timeout" "$TMP/bin/sleep" "$TMP/bin/date" "$TMP/bin/gh"

reset_case() {
  local name="$1"
  CASE_DIR="$TMP/$name"
  rm -rf "$CASE_DIR"
  mkdir -p "$CASE_DIR/state"
  : >"$CASE_DIR/output"
  : >"$CASE_DIR/reruns"
  : >"$CASE_DIR/timeouts"
}

run_subject() {
  local budget="${1:-4}"
  set +e
  PATH="$TMP/bin:/usr/bin:/bin" \
    HEAD_SHA="${HEAD_SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" \
    PR_NUMBER=871 \
    GITHUB_REPOSITORY=xrliAnnie/flywheel \
    GITHUB_OUTPUT="$CASE_DIR/output" \
    AWAIT_BUDGET_SECONDS="$budget" \
    POLL_SECONDS=1 \
    MOCK_STATE="$CASE_DIR/state" \
    MOCK_RUN_SEQUENCE="$CASE_DIR/runs.json" \
    MOCK_RERUN_LOG="$CASE_DIR/reruns" \
    MOCK_TIMEOUT_LOG="$CASE_DIR/timeouts" \
    MOCK_HEAD_SHA="${MOCK_HEAD_SHA:-}" \
    MOCK_PR_STATE="${MOCK_PR_STATE:-OPEN}" \
    MOCK_CHECK_SUCCESS_AT="${MOCK_CHECK_SUCCESS_AT:-0}" \
    MOCK_TIMEOUT_FAIL_ONCE="${MOCK_TIMEOUT_FAIL_ONCE:-0}" \
    bash "$SUBJECT" >"$CASE_DIR/stdout" 2>"$CASE_DIR/stderr"
  SUBJECT_RC=$?
  set -e
}

outcome() { sed -n 's/^outcome=//p' "$CASE_DIR/output" | tail -1; }
rerun_count() { wc -l <"$CASE_DIR/reruns" | tr -d ' '; }

if [[ ! -f "$SUBJECT" ]]; then
  fail "ship-await-ci.sh exists"
else
  reset_case success
  printf '%s\n' '[[{"databaseId":1,"status":"completed","conclusion":"success","createdAt":"2026-08-18T00:00:00Z"}]]' >"$CASE_DIR/runs.json"
  MOCK_CHECK_SUCCESS_AT=1 run_subject
  [[ "$SUBJECT_RC" -eq 0 && "$(outcome)" == "success" ]] && pass "CI OK success returns immediately" || fail "CI OK success returns immediately"

  reset_case pending_success
  printf '%s\n' '[[{"databaseId":1,"status":"in_progress","conclusion":null,"createdAt":"2026-08-18T00:00:00Z"}],[{"databaseId":1,"status":"completed","conclusion":"success","createdAt":"2026-08-18T00:00:00Z"}]]' >"$CASE_DIR/runs.json"
  MOCK_CHECK_SUCCESS_AT=2 run_subject 6
  [[ "$SUBJECT_RC" -eq 0 && "$(outcome)" == "success" && "$(rerun_count)" -eq 0 ]] && pass "in-progress current run is awaited" || fail "in-progress current run is awaited"

  reset_case cancelled_success
  printf '%s\n' '[[{"databaseId":41,"status":"completed","conclusion":"cancelled","createdAt":"2026-08-18T00:00:00Z"}]]' >"$CASE_DIR/runs.json"
  MOCK_CHECK_SUCCESS_AT=2 run_subject 6
  [[ "$SUBJECT_RC" -eq 0 && "$(outcome)" == "success" && "$(rerun_count)" -eq 1 ]] && pass "cancelled exact-head run is rerun once then awaited" || fail "cancelled exact-head run is rerun once then awaited"

  reset_case cancelled_twice
  printf '%s\n' '[[{"databaseId":42,"status":"completed","conclusion":"cancelled","createdAt":"2026-08-18T00:00:00Z"}]]' >"$CASE_DIR/runs.json"
  MOCK_CHECK_SUCCESS_AT=0 run_subject 3
  [[ "$SUBJECT_RC" -ne 0 && "$(outcome)" == "await_ci_timeout" && "$(rerun_count)" -eq 1 ]] && pass "one ship attempt never reruns CI more than once" || fail "one ship attempt never reruns CI more than once"

  reset_case failure
  printf '%s\n' '[[{"databaseId":43,"status":"completed","conclusion":"failure","createdAt":"2026-08-18T00:00:00Z"}]]' >"$CASE_DIR/runs.json"
  run_subject 3
  [[ "$SUBJECT_RC" -ne 0 && "$(outcome)" == "ci_failure" && "$(rerun_count)" -eq 0 ]] && pass "true CI failure is terminal and never rerun" || fail "true CI failure is terminal and never rerun"

  reset_case newer_running
  printf '%s\n' '[[{"databaseId":44,"status":"completed","conclusion":"cancelled","createdAt":"2026-08-18T00:00:00Z"},{"databaseId":45,"status":"in_progress","conclusion":null,"createdAt":"2026-08-18T00:01:00Z"}]]' >"$CASE_DIR/runs.json"
  run_subject 2
  [[ "$SUBJECT_RC" -ne 0 && "$(outcome)" == "await_ci_timeout" && "$(rerun_count)" -eq 0 ]] && pass "a newer in-progress run suppresses rerun of an old cancellation" || fail "a newer in-progress run suppresses rerun of an old cancellation"

  reset_case head_moved
  printf '%s\n' '[[]]' >"$CASE_DIR/runs.json"
  MOCK_HEAD_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb run_subject
  [[ "$SUBJECT_RC" -ne 0 && "$(outcome)" == "head_moved" ]] && pass "head drift fails closed before merge" || fail "head drift fails closed before merge"

  reset_case pr_closed
  printf '%s\n' '[[]]' >"$CASE_DIR/runs.json"
  MOCK_PR_STATE=CLOSED run_subject
  [[ "$SUBJECT_RC" -ne 0 && "$(outcome)" == "pr_not_open" ]] && pass "non-open PR fails closed" || fail "non-open PR fails closed"

  reset_case transient_gh
  printf '%s\n' '[[{"databaseId":46,"status":"in_progress","conclusion":null,"createdAt":"2026-08-18T00:00:00Z"}]]' >"$CASE_DIR/runs.json"
  MOCK_TIMEOUT_FAIL_ONCE=1 MOCK_CHECK_SUCCESS_AT=2 run_subject 6
  [[ "$SUBJECT_RC" -eq 0 && "$(outcome)" == "success" ]] && pass "a timed-out gh probe is retried instead of crashing" || fail "a timed-out gh probe is retried instead of crashing"
  grep -q '^60 gh ' "$CASE_DIR/timeouts" && pass "every gh probe is command-timeout wrapped" || fail "every gh probe is command-timeout wrapped"

  while IFS=$'\t' read -r status conclusion expected; do
    [[ "$conclusion" != "__NULL__" ]] || conclusion=""
    reset_case "vector-${status}-${conclusion:-none}"
    jq -cn --arg status "$status" --arg conclusion "$conclusion" '
      [[{databaseId:77,status:$status,conclusion:(if $conclusion == "" then null else $conclusion end),createdAt:"2026-08-18T00:00:00Z"}]]
    ' >"$CASE_DIR/runs.json"
    MOCK_CHECK_SUCCESS_AT=0
    [[ "$expected" != "success" ]] || MOCK_CHECK_SUCCESS_AT=1
    run_subject 0
    actual="$(outcome)"
    case "$expected" in
      success) ok=$([[ "$SUBJECT_RC" -eq 0 && "$actual" == "success" ]] && echo yes || echo no) ;;
      fail) ok=$([[ "$SUBJECT_RC" -ne 0 && "$actual" == "ci_failure" ]] && echo yes || echo no) ;;
      rerun) ok=$([[ "$SUBJECT_RC" -ne 0 && "$actual" == "await_ci_timeout" && "$(rerun_count)" -eq 1 ]] && echo yes || echo no) ;;
      wait) ok=$([[ "$SUBJECT_RC" -ne 0 && "$actual" == "await_ci_timeout" && "$(rerun_count)" -eq 0 ]] && echo yes || echo no) ;;
      *) ok=no ;;
    esac
    [[ "$ok" == yes ]] || fail "shared vector status=$status conclusion=${conclusion:-null} expected=$expected"
  done < <(jq -r '.[] | [.status, (.conclusion // "__NULL__"), .await] | @tsv' "$VECTORS")
  [[ "$FAILED" -ne 0 ]] || pass "ship await parser consumes every shared status vector"
fi

printf '\nPassed: %s  Failed: %s\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
