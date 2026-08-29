#!/usr/bin/env bash
# FLY-957: record_deployed_range must never kill the deploy finalization.
#
# Regression: under set -euo pipefail, a commit subject without a PR number
# (or without an issue id) made the issue/pr grep exit 1, killing the while
# subshell and then the whole script BEFORE deployed-sha was written —
# deployed-sha never advanced, ✅ never announced (2026-07-06, twice).
#
# Hermetic: extracts the function from scripts/restart-services.sh (no
# copy-paste drift), runs it under production strictness (set -euo pipefail)
# against a throwaway git repo, with a PATH-shim node capturing
# report-deployed argv. No real ~/.flywheel, no network.
#
# BASH_UNDER_TEST selects the interpreter the function runs under (default:
# `bash` from PATH). Local 3.2 check: BASH_UNDER_TEST=/bin/bash bash <this>.
set -uo pipefail
BASH_UNDER_TEST="${BASH_UNDER_TEST:-bash}"

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RS="$REPO_ROOT/scripts/restart-services.sh"
[ -f "$RS" ] || { echo "ERROR: $RS not found"; exit 1; }

# ── extract the function under test (guard against sed anchor drift) ──────
FN_SRC="$(sed -n '/^record_deployed_range()/,/^}/p' "$RS")"
[ -n "$FN_SRC" ] || { echo "ERROR: extraction came back empty"; exit 1; }

SANDBOX="$(mktemp -d -t fly957-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# ── fake FLYWHEEL_DIR: real git repo + comm dist marker ───────────────────
FD="$SANDBOX/flywheel"
mkdir -p "$FD/packages/flywheel-comm/dist"
: > "$FD/packages/flywheel-comm/dist/index.js"
git init -q "$FD"
G() { git -C "$FD" -c user.name=t -c user.email=t@t "$@"; }
c() { G commit -q --allow-empty -m "$1"; }
c "init"
OLD="$(G rev-parse HEAD)"
c "bump version (#99)"                       # PR, no issue (line-46 kill shape)
c "feat(FLY-901): with pr (#465)"            # issue + PR (full report shape)
c "docs: no markers at all"                  # neither → must be skipped
NOMARK_SHA="$(G rev-parse HEAD)"             # subjects never appear in argv → assert by SHA
c "chore(progress): FLY-913 implement 1/5"   # issue, no PR — the incident shape;
NEW="$(G rev-parse HEAD)"                    # newest = read FIRST (git log order)

# ── PATH-shim node: capture report-deployed argv, exit 0 ─────────────────
CAPTURE="$SANDBOX/calls.log"; : > "$CAPTURE"
mkdir -p "$SANDBOX/shim"
cat > "$SANDBOX/shim/node" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CAPTURE"
exit 0
EOF
chmod +x "$SANDBOX/shim/node"

# ── wrapper: production strictness + extracted function ──────────────────
WRAPPER="$SANDBOX/wrapper.sh"
{
  echo 'set -euo pipefail'
  printf 'FLYWHEEL_DIR=%q\n' "$FD"
  printf '%s\n' "$FN_SRC"
  echo 'record_deployed_range "$1" "$2"'
  echo 'echo FINALIZED'
} > "$WRAPPER"
run_fn() { env PATH="$SANDBOX/shim:$PATH" "$BASH_UNDER_TEST" "$WRAPPER" "$1" "$2" 2>&1; }

# T1 — THE regression: survives PR-less / marker-less commits in the range
OUT="$(run_fn "$OLD" "$NEW")"; RC=$?
[ "$RC" -eq 0 ] && pass "exit 0 across PR-less/issue-less commits" \
                || fail "exit $RC — finalization killed"
grep -q FINALIZED <<<"$OUT" && pass "code after the call still runs" \
                            || fail "FINALIZED never reached"

# T2 — keeps processing commits AFTER the killer one (newest-first order)
grep -q -- "--issue FLY-901" "$CAPTURE" && grep -q -- "--pr 465" "$CAPTURE" \
  && pass "issue+PR commit reported after killer commit" \
  || fail "older issue+PR commit lost"
grep -q -- "--pr 99" "$CAPTURE" && pass "PR-only commit reported" \
                                || fail "PR-only commit lost"

# T3 — incident shape reported with issue and WITHOUT a --pr flag
# (note the trailing space: plain "--pr" would substring-match "--project")
grep -- "--issue FLY-913" "$CAPTURE" | grep -qv -- "--pr " \
  && pass "issue-only commit reported without --pr" \
  || fail "issue-only commit wrong or missing"

# T4 — marker-less commit is skipped, not reported (assert by its SHA — the
# report-deployed argv never contains commit subjects, so a subject grep
# would be a false signal), and exactly the other 3 commits are reported
grep -q -- "--merge-sha $NOMARK_SHA" "$CAPTURE" \
  && fail "marker-less commit was reported" || pass "marker-less commit skipped"
CALLS="$(grep -c -- "report-deployed" "$CAPTURE" || true)"
[ "$CALLS" -eq 3 ] && pass "exactly 3 commits reported" \
                   || fail "expected 3 report calls, got $CALLS"

# T5 — contract: git-log failure (unknown 40-hex old) must not escape
: > "$CAPTURE"
OUT="$(run_fn "ffffffffffffffffffffffffffffffffffffffff" "$NEW")"; RC=$?
{ [ "$RC" -eq 0 ] && grep -q FINALIZED <<<"$OUT"; } \
  && pass "git-log failure swallowed (best-effort contract)" \
  || fail "git-log failure escaped the function"

# T6 (QA FLY-957) — empty range: old == new (updater fired, nothing new merged)
# → git log yields no commits, the while body never runs. Must still exit 0,
# reach FINALIZED, and report nothing. Realistic every-cycle deploy shape that
# the T1–T5 mixed-range cases don't exercise.
: > "$CAPTURE"
OUT="$(run_fn "$NEW" "$NEW")"; RC=$?
{ [ "$RC" -eq 0 ] && grep -q FINALIZED <<<"$OUT"; } \
  && pass "empty range (old==new) exits 0, finalization proceeds" \
  || fail "empty range killed finalization (exit $RC)"
EMPTY_CALLS="$(grep -c -- "report-deployed" "$CAPTURE" || true)"
[ "$EMPTY_CALLS" -eq 0 ] && pass "empty range reports nothing" \
                        || fail "empty range reported $EMPTY_CALLS commit(s)"

echo
echo "[TEST] passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
