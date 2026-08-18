#!/usr/bin/env bash
# Await the required CI verdict for the exact approved head. Superseded or
# timed-out workflow runs may be rerun once; true test failures are terminal.
set -uo pipefail

: "${PR_NUMBER:?PR_NUMBER is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

AWAIT_BUDGET_SECONDS="${AWAIT_BUDGET_SECONDS:-1500}"
POLL_SECONDS="${POLL_SECONDS:-30}"
GH_COMMAND_TIMEOUT_SECONDS="${GH_COMMAND_TIMEOUT_SECONDS:-60}"

if [[ ! "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] ||
  [[ ! "$HEAD_SHA" =~ ^[0-9a-fA-F]{40}$ ]] ||
  [[ ! "$AWAIT_BUDGET_SECONDS" =~ ^[0-9]+$ ]] ||
  [[ ! "$POLL_SECONDS" =~ ^[0-9]+$ ]] ||
  [[ ! "$GH_COMMAND_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'outcome=preflight\n' >>"$GITHUB_OUTPUT"
  exit 1
fi

HEAD_SHA="$(printf '%s' "$HEAD_SHA" | tr '[:upper:]' '[:lower:]')"

record_outcome() {
  printf 'outcome=%s\n' "$1" >>"$GITHUB_OUTPUT"
}

fail_with() {
  record_outcome "$1"
  exit 1
}

gh_timed() {
  timeout "$GH_COMMAND_TIMEOUT_SECONDS" gh "$@"
}

start_epoch="$(date +%s)"
deadline_epoch=$((start_epoch + AWAIT_BUDGET_SECONDS))
rerun_attempted=0

while true; do
  pr_json="$(gh_timed pr view "$PR_NUMBER" --json headRefOid,state 2>/dev/null)" || pr_json=""
  if [[ -n "$pr_json" ]]; then
    current_head="$(printf '%s' "$pr_json" | jq -r '.headRefOid // ""' 2>/dev/null)" || current_head=""
    current_state="$(printf '%s' "$pr_json" | jq -r '.state // ""' 2>/dev/null)" || current_state=""
    current_head="$(printf '%s' "$current_head" | tr '[:upper:]' '[:lower:]')"
    [[ "$current_head" == "$HEAD_SHA" ]] || fail_with head_moved
    [[ "$current_state" == "OPEN" ]] || fail_with pr_not_open

    check_json="$(
      gh_timed api \
        "repos/$GITHUB_REPOSITORY/commits/$HEAD_SHA/check-runs?filter=latest&per_page=100" \
        --method GET 2>/dev/null
    )" || check_json=""
    if [[ -n "$check_json" ]]; then
      check_conclusion="$(
        printf '%s' "$check_json" | jq -r '
          [.check_runs[]? | select(.name == "CI OK")]
          | sort_by(.started_at // .completed_at // "")
          | last
          | .conclusion // ""
        ' 2>/dev/null
      )" || check_conclusion=""
      if [[ "$check_conclusion" == "success" ]]; then
        record_outcome success
        exit 0
      fi
    fi

    runs_json="$(
      gh_timed run list --workflow=ci.yml --commit "$HEAD_SHA" \
        --json databaseId,status,conclusion,createdAt --limit 100 2>/dev/null
    )" || runs_json=""
    if [[ -n "$runs_json" ]] && printf '%s' "$runs_json" | jq -e 'type == "array"' >/dev/null 2>&1; then
      if ! printf '%s' "$runs_json" | jq -e 'any(.[]; .status != "completed")' >/dev/null 2>&1; then
        latest_run="$(
          printf '%s' "$runs_json" | jq -c '
            sort_by(.createdAt // "", .databaseId // 0) | last // empty
          ' 2>/dev/null
        )" || latest_run=""
        if [[ -n "$latest_run" ]]; then
          latest_id="$(printf '%s' "$latest_run" | jq -r '.databaseId // ""')"
          latest_conclusion="$(printf '%s' "$latest_run" | jq -r '.conclusion // ""')"
          case "$latest_conclusion" in
            failure)
              fail_with ci_failure
              ;;
            cancelled | timed_out | startup_failure | stale)
              if [[ "$rerun_attempted" -eq 0 && "$latest_id" =~ ^[0-9]+$ ]]; then
                # Mark first: a failed/ambiguous API call must not create an
                # unbounded rerun loop inside one ship attempt.
                rerun_attempted=1
                gh_timed run rerun "$latest_id" >/dev/null 2>&1 || true
              fi
              ;;
            success | action_required | neutral | skipped | "")
              ;;
            *)
              # Unknown conclusions are deliberately fail-closed by waiting
              # until the bounded budget expires.
              ;;
          esac
        fi
      fi
    fi
  fi

  now_epoch="$(date +%s)"
  if (( now_epoch >= deadline_epoch )); then
    fail_with await_ci_timeout
  fi
  sleep "$POLL_SECONDS"
done
