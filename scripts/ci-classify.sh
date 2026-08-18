#!/usr/bin/env bash
# Classify whether the current PR head differs from its latest green CI head
# only by inert process documentation. Any uncertainty runs the full CI suite.
set -uo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

fail_closed() {
  printf 'ci-classify: fail-closed: %s\n' "$1" >&2
  printf 'no_code=false\n' >>"$GITHUB_OUTPUT"
  exit 0
}

if [[ ! "${PR_NUMBER:-}" =~ ^[1-9][0-9]*$ ]] ||
  [[ ! "${HEAD_SHA:-}" =~ ^[0-9a-fA-F]{40}$ ]] ||
  [[ ! "${BASE_SHA:-}" =~ ^[0-9a-fA-F]{40}$ ]] ||
  [[ ! "${GITHUB_REPOSITORY:-}" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
  fail_closed "invalid_input"
fi

head_sha="$(printf '%s' "$HEAD_SHA" | tr '[:upper:]' '[:lower:]')"
base_sha="$(printf '%s' "$BASE_SHA" | tr '[:upper:]' '[:lower:]')"

RUNS_PER_PAGE=100
MAX_RUN_PAGES=12
# 12 pages ≈ ~18 days lookback, based on ~64.5 runs/day; table in research.md §10.
baseline_candidates='[]'
for ((page = 1; page <= MAX_RUN_PAGES; page++)); do
  page_json="$(
    gh api "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs" \
      --method GET -f event=pull_request -f per_page="$RUNS_PER_PAGE" -f page="$page" 2>/dev/null
  )" || fail_closed "runs_api_failed:page=$page"

  page_count="$(
    printf '%s' "$page_json" | jq -er '
      if (.workflow_runs | type) == "array" then
        .workflow_runs | length
      else
        error("workflow_runs is not an array")
      end
    ' 2>/dev/null
  )" || fail_closed "runs_page_invalid:page=$page"

  page_candidates="$(
    printf '%s' "$page_json" | jq -c --argjson pr "$PR_NUMBER" '
      [
        .workflow_runs[]? as $run
        | ($run.pull_requests // [])[]?
        | select(.number == $pr)
        | select($run.status == "completed")
        | {
            id: ($run.id // 0),
            conclusion: ($run.conclusion // ""),
            headSha: ($run.head_sha // ""),
            baseSha: (.base.sha // ""),
            createdAt: ($run.run_started_at // $run.created_at // "")
          }
      ]
    ' 2>/dev/null
  )" || fail_closed "runs_page_filter_failed:page=$page"

  baseline_candidates="$(
    printf '%s\n%s\n' "$baseline_candidates" "$page_candidates" | jq -sc 'add' 2>/dev/null
  )" || fail_closed "runs_page_merge_failed:page=$page"

  ((page_count < RUNS_PER_PAGE)) && break
done

baseline="$(
  printf '%s' "$baseline_candidates" | jq -c '
    sort_by(.createdAt, .id)
    | last // empty
  ' 2>/dev/null
)" || fail_closed "baseline_selection_failed"
[[ -n "$baseline" ]] || fail_closed "no_completed_pr_baseline"

baseline_fields="$(
  printf '%s' "$baseline" | jq -r '[.conclusion // "", .headSha // "", .baseSha // ""] | @tsv' 2>/dev/null
)" || fail_closed "baseline_fields_invalid"
IFS=$'\t' read -r baseline_conclusion baseline_head baseline_base <<<"$baseline_fields"
baseline_head="$(printf '%s' "$baseline_head" | tr '[:upper:]' '[:lower:]')"
baseline_base="$(printf '%s' "$baseline_base" | tr '[:upper:]' '[:lower:]')"

[[ "$baseline_conclusion" == "success" ]] || fail_closed "latest_completed_run_not_success"
[[ "$baseline_head" =~ ^[0-9a-f]{40}$ ]] || fail_closed "baseline_head_invalid"
[[ "$baseline_base" == "$base_sha" ]] || fail_closed "baseline_base_sha_mismatch"
git cat-file -e "$baseline_head^{commit}" 2>/dev/null || fail_closed "baseline_commit_missing"
git cat-file -e "$head_sha^{commit}" 2>/dev/null || fail_closed "head_commit_missing"
git merge-base --is-ancestor "$baseline_head" "$head_sha" 2>/dev/null || fail_closed "baseline_not_ancestor"

python3 - "$baseline_head" "$head_sha" <<'PY' || fail_closed "diff_not_inert"
import subprocess
import sys

green, head = sys.argv[1:]
try:
    raw = subprocess.run(
        ["git", "diff", "--raw", "-z", "--no-renames", f"{green}..{head}"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ).stdout
except (OSError, subprocess.CalledProcessError):
    raise SystemExit(2)

tokens = raw.split(b"\0")
if tokens and tokens[-1] == b"":
    tokens.pop()
if len(tokens) % 2 != 0:
    raise SystemExit(2)

allowed_prefixes = (b"doc/", b"product/doc/", b"engineering/doc/", b"content/doc/")
allowed_suffixes = (
    b".md",
    b".markdown",
    b".mmd",
    b".html",
    b".htm",
    b".svg",
    b".png",
    b".jpg",
    b".jpeg",
    b".gif",
    b".webp",
    b".avif",
    b".pdf",
)
for index in range(0, len(tokens), 2):
    header = tokens[index]
    path = tokens[index + 1]
    if (
        not header.startswith(b":")
        or not path.startswith(allowed_prefixes)
        or not path.endswith(allowed_suffixes)
    ):
        raise SystemExit(1)
    fields = header[1:].split()
    if len(fields) < 5:
        raise SystemExit(2)
    old_mode, new_mode = fields[0], fields[1]
    if old_mode in {b"120000", b"160000"} or new_mode in {b"120000", b"160000"}:
        raise SystemExit(1)
PY

printf 'no_code=true\n' >>"$GITHUB_OUTPUT"
