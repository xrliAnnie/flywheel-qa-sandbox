#!/bin/bash
# FLY-1701 · ship-on-comment merge-token contract.
#
# GitHub hard-blocks the default Actions token (`secrets.GITHUB_TOKEN`) from
# merging a PR that touches `.github/workflows/*`: the merge API answers 403
# "refusing to allow a GitHub App to update workflow without workflows
# permission". Every :cool: ship of a workflow-touching PR therefore died at
# the Merge step (PR #808 / #806 sat blocked, land executor retrying forever).
#
# The fix is one token expression: the MERGE step reads `secrets.SHIP_PAT`
# (a founder-issued PAT carrying the workflow scope) and falls back to
# `secrets.GITHUB_TOKEN` when SHIP_PAT is absent — an unset secret evaluates to
# the empty string, so `||` yields the old token and behavior is byte-identical
# to today's on a repo without the secret.
#
# SHIP_PAT is a far broader credential than the job's default token, so the
# contract these assertions pin is not just "the merge works" but "the PAT
# reaches exactly one place and nowhere else":
#
#   T1  SHIP_PAT appears EXACTLY ONCE in the whole parsed document, at
#       jobs.*.steps[].with.github-token of the step whose id is `merge-pr`,
#       with the exact fallback expression.
#   T2  that same `merge-pr` step is the one that actually calls the merge API
#       (identity bound to behavior — the merge cannot drift into a step that
#       has no PAT, and the PAT step cannot stop being the merge).
#   T3  no other step carries a non-default github-token.
#
# The walk is over the PARSED YAML, so a commented-out or re-quoted line does
# not survive (same discipline as release-workflows-structure.test.sh, whose
# substring greps Codex fooled twice). A missing python3/PyYAML is a FAILED
# check, never a silent pass.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHIP="$ROOT/.github/workflows/ship-on-comment.yml"

[ -f "$SHIP" ] || { echo "ERROR: missing $SHIP"; exit 1; }

# The probe heredoc is deliberately NOT nested inside `$( ... )`: bash 3.2 (the
# stock /bin/bash on the macOS production host) scans a command substitution's
# body for quotes even when the heredoc delimiter is quoted, so a single
# apostrophe in a Python comment makes the whole file unparseable there — while
# CI's bash 5 runs it fine, i.e. it fails only off-CI. Redirecting to a temp
# file keeps the heredoc at top level, where that bug does not apply.
PROBE_OUT="$(mktemp -t ship-merge-token.XXXXXX)"
trap 'rm -f "$PROBE_OUT"' EXIT

python3 - "$SHIP" >"$PROBE_OUT" <<'PYEOF'
import sys

import yaml

MERGE_STEP_ID = "merge-pr"
MERGE_TOKEN = "${{ secrets.SHIP_PAT || secrets.GITHUB_TOKEN }}"
DEFAULT_TOKEN = "${{ secrets.GITHUB_TOKEN }}"


def norm(expr):
    return " ".join(str(expr or "").split())


def walk(node, path=""):
    """Every scalar in the document, with a dotted path — env:, run:, with:,
    a nested composite input, anywhere. Substring checks that only look at
    `with.github-token` miss a PAT smuggled into env or a run block."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk(v, f"{path}.{k}" if path else str(k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk(v, f"{path}[{i}]")
    else:
        yield path, node


with open(sys.argv[1]) as f:
    doc = yaml.safe_load(f)

steps = []
for jname, job in (doc.get("jobs") or {}).items():
    for i, step in enumerate((job or {}).get("steps") or []):
        steps.append((f"jobs.{jname}.steps[{i}]", step or {}))

failures = []

merge_id_steps = [(p, s) for p, s in steps if str(s.get("id") or "") == MERGE_STEP_ID]
merge_api_steps = [
    (p, s) for p, s in steps if "pulls.merge" in str((s.get("with") or {}).get("script") or "")
]

# T1 — the PAT reaches exactly one place, and that place is the merge step's
# github-token, carrying the exact fallback expression.
pat_sites = [(p, v) for p, v in walk(doc) if "secrets.SHIP_PAT" in str(v)]
if len(pat_sites) != 1:
    failures.append(f"T1:pat-occurrences={len(pat_sites)}:{[p for p, _ in pat_sites]}")
elif len(merge_id_steps) != 1:
    failures.append(f"T1:merge-step-id={MERGE_STEP_ID!r}-count={len(merge_id_steps)}")
else:
    site_path, site_val = pat_sites[0]
    expected_path = f"{merge_id_steps[0][0]}.with.github-token"
    if site_path != expected_path:
        failures.append(f"T1:pat-at={site_path!r}-not={expected_path!r}")
    if norm(site_val) != norm(MERGE_TOKEN):
        failures.append(f"T1:merge-token={norm(site_val)!r}")

# T2 — identity bound to behavior: the step holding the PAT is the step that
# merges. Catches both drifts (merge moves away / PAT step stops merging).
if len(merge_api_steps) != 1:
    failures.append(f"T2:merge-api-steps={[p for p, _ in merge_api_steps]}")
elif len(merge_id_steps) != 1:
    failures.append(f"T2:merge-step-id-count={len(merge_id_steps)}")
elif merge_api_steps[0][0] != merge_id_steps[0][0]:
    failures.append(f"T2:merge-api-at={merge_api_steps[0][0]}-id-at={merge_id_steps[0][0]}")

# T3 — scope discipline: every OTHER step keeps the default token (they only
# read the PR and post comments, which GITHUB_TOKEN already does fine).
merge_paths = {p for p, _ in merge_id_steps}
for p, s in steps:
    if p in merge_paths:
        continue
    token = norm((s.get("with") or {}).get("github-token"))
    if token and token != norm(DEFAULT_TOKEN):
        failures.append(f"T3:non-merge-step={str(s.get('name'))!r} token={token!r}")

print("|".join(failures) if failures else "OK")
PYEOF
PROBE_RC=$?
# a missing python3/PyYAML, or any parse error, is a FAILED check — never a
# silent pass on an empty $OUT
[ "$PROBE_RC" -eq 0 ] || { echo "ERROR: YAML contract probe failed to run (rc=$PROBE_RC; python3/PyYAML missing?)"; exit 1; }
OUT="$(cat "$PROBE_OUT")"
[ -n "$OUT" ] || { echo "ERROR: YAML contract probe produced no verdict"; exit 1; }

case "$OUT" in
  *T1:*) fail "T1 SHIP_PAT is not exactly-once at the merge step's github-token ($OUT)" ;;
  *)     pass "T1 SHIP_PAT appears exactly once — merge step github-token, with the GITHUB_TOKEN fallback" ;;
esac

case "$OUT" in
  *T2:*) fail "T2 the PAT-holding step is not the step that merges ($OUT)" ;;
  *)     pass "T2 the merge API call lives in the PAT-holding step (id: merge-pr)" ;;
esac

case "$OUT" in
  *T3:*) fail "T3 a non-merge step carries a non-default token ($OUT)" ;;
  *)     pass "T3 non-merge steps still use the default GITHUB_TOKEN" ;;
esac

echo
echo "Passed: $PASSED  Failed: $FAILED"
[ "$FAILED" -eq 0 ]
