#!/usr/bin/env bash
# FLY-2045 — does the layout guard actually guard anything?
#
# A guard that cannot go red is not a guard. This suite takes a GREEN checkout, applies ONE
# mutation at a time in a throwaway copy, and asserts the guard fails by name. Anything that
# stays green means the corresponding invariant is not really being enforced.
#
# Two failures during this issue's own review are why the suite is shaped this way:
#   - a guard once matched its "exact" anchor with a substring search, so a renamed heading
#     satisfied it and the guard reported success while enforcing nothing;
#   - a control suite once printed its own pass count as "$n/$n", so deleting a control read
#     as a clean run. The expected total is therefore pinned below.
#
# Scope note: this is deliberately one direct fixture per load-bearing invariant. An earlier
# draft grew a sub-id catalogue, same-group exclusion rules and mutation-of-mutation layers
# until the harness was larger than the migration it protected; that layer was cut. What is
# left is the set where each entry is the only thing standing between a wrong edit and main.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD_REL="scripts/__tests__/fly2045-milestone-layout.test.sh"
MS_REL="engineering/doc/milestones"

T="$(mktemp -d "${TMPDIR:-/tmp}/fly2045-mutations.XXXXXX")"
trap 'rm -rf "$T"' EXIT

pass_n=0; fail_n=0

# Build a pristine copy of everything the guard reads. Copying rather than mutating the real
# worktree keeps a failing run from leaving the repo in a half-edited state.
seed() {
  local d="$1"
  mkdir -p "$d/scripts/__tests__" "$d/$MS_REL" \
           "$d/.flywheel/agents/nodes" "$d/.claude/commands"
  cp "$ROOT/CLAUDE.md" "$d/CLAUDE.md"
  cp "$ROOT/$GUARD_REL" "$d/$GUARD_REL"
  cp "$ROOT/$MS_REL"/*.md "$d/$MS_REL/"
  cp "$ROOT/.flywheel/agents/nodes/engineer.md" "$d/.flywheel/agents/nodes/"
  cp "$ROOT/.claude/commands/spin.md" "$d/.claude/commands/"
  cp "$ROOT/.claude/commands/orchestrator.md" "$d/.claude/commands/"
}

run_guard() { bash "$1/$GUARD_REL" >"$1/out.txt" 2>&1; }

# expect_red <name> <shell-body-mutating-$d>
expect_red() {
  local name="$1" body="$2" rc=0
  local d="$T/$name"
  seed "$d"
  ( cd "$d" && eval "$body" ) || { printf 'HARNESS ERROR: %-28s mutation failed to apply\n' "$name" >&2
                                   fail_n=$((fail_n + 1)); return; }
  run_guard "$d" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'FAIL: %-28s guard stayed GREEN — this invariant is not enforced\n' "$name" >&2
    fail_n=$((fail_n + 1))
  else
    printf 'ok:   %-28s guard went red: %s\n' "$name" \
      "$(grep -m1 '^FAIL:' "$d/out.txt" | cut -c1-72)"
    pass_n=$((pass_n + 1))
  fi
}

# expect_green <name> <shell-body> — a legitimate shape must NOT be rejected. False red is
# as much a defect as false green: it would block real milestone rows.
expect_green() {
  local name="$1" body="$2" rc=0
  local d="$T/$name"
  seed "$d"
  ( cd "$d" && eval "$body" ) || { printf 'HARNESS ERROR: %-28s setup failed\n' "$name" >&2
                                   fail_n=$((fail_n + 1)); return; }
  run_guard "$d" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'ok:   %-28s stayed GREEN (no false red)\n' "$name"; pass_n=$((pass_n + 1))
  else
    printf 'FAIL: %-28s went red on a LEGITIMATE shape:\n%s\n' "$name" \
      "$(grep -m2 '^FAIL:' "$d/out.txt")" >&2
    fail_n=$((fail_n + 1))
  fi
}

echo "=== baseline: the real checkout must be green before any mutation means anything ==="
if bash "$ROOT/$GUARD_REL" >/dev/null 2>&1; then
  echo "ok:   baseline guard is green"
else
  echo "FATAL: the guard is already red on the real checkout; every verdict below would be meaningless" >&2
  exit 2
fi

echo
echo "=== the ledger must not flow back into CLAUDE.md ==="
expect_red N1-table-header  "printf '\n| Milestone | Status |\n|---|---|\n' >> CLAUDE.md"
expect_red N2a-fly-row      "printf '\n| FLY-9999: back again | ⏳ Pending ship |\n' >> CLAUDE.md"
expect_red N2b-geo-row      "printf '\n| GEO-999: back again | ✅ Merged (PR #1) |\n' >> CLAUDE.md"
expect_red N2c-indented-row "printf '\n  | FLY-9999: indented | ⏳ Pending ship |\n' >> CLAUDE.md"
expect_red N2d-legacy-v-row "printf '\n| v9.9.9 Legacy shape | ✅ Merged (PR #1) |\n' >> CLAUDE.md"
expect_red N2e-pointer-gone "grep -v '里程碑账本在' CLAUDE.md > t && mv t CLAUDE.md"

echo
echo "=== the archive is byte-frozen ==="
# One byte different, same length, on a line INSIDE the block (not a sentinel): the byte
# count is unchanged, so only the hash pin can catch this. Targeting the last line instead
# would hit the END sentinel and go red for the wrong reason -- which is what a first draft
# of this fixture did.
expect_red N3-archive-byte  "awk 'NR==50{sub(/./,\"X\")}1' $MS_REL/ARCHIVE-pre-FLY-2045.md > t && mv t $MS_REL/ARCHIVE-pre-FLY-2045.md"
# Byte count changed but content is a legal edit shape: this is the byte pin's own case.
expect_red N4-archive-lines "sed '/FLY-2014/d' $MS_REL/ARCHIVE-pre-FLY-2045.md > t && mv t $MS_REL/ARCHIVE-pre-FLY-2045.md"
expect_red N4b-sentinel     "grep -v 'FLY-2045-ARCHIVE-END' $MS_REL/ARCHIVE-pre-FLY-2045.md > t && mv t $MS_REL/ARCHIVE-pre-FLY-2045.md"

echo
echo "=== the directory holds per-issue files and nothing else ==="
expect_red N5-illegal-name  "printf 'x\n' > $MS_REL/notes.md"
# ARCHIVE-*.md must NOT be a wildcard exemption, or this file would bypass the naming rule.
expect_red N5b-archive-wild "printf 'x\n' > $MS_REL/ARCHIVE-notes.md"
expect_red N6-non-vacuous   "rm -f $MS_REL/FLY-*.md $MS_REL/GEO-*.md"
# A template must not reach the permanent ledger just because the filename is legal.
expect_red N6b-placeholder  "sed 's/#947/#NNN/' $MS_REL/FLY-2045.md > t && mv t $MS_REL/FLY-2045.md"

echo
echo "=== every Flywheel writer points at the new home, and the generic one is protected ==="
expect_red N7-executor      "grep -v 'engineering/doc/milestones/' .flywheel/agents/nodes/engineer.md > t && mv t .flywheel/agents/nodes/engineer.md"
expect_red N8-generic-rule  "grep -v 'Update CLAUDE.md: add milestone to table' .claude/commands/spin.md > t && mv t .claude/commands/spin.md"
# These delete the REAL shell, not the tag comments. Deleting only a tag used to leave the
# guard green, which meant it was proving a comment exists rather than that the check runs.
expect_red N9-a0-base-fence "grep -v 'git cat-file -e \"origin/main:' .claude/commands/orchestrator.md > t && mv t .claude/commands/orchestrator.md"
expect_red N9b-a0-detached  "grep -v 'git symbolic-ref --quiet --short HEAD' .claude/commands/orchestrator.md > t && mv t .claude/commands/orchestrator.md"
expect_red N9c-a0-branch-bind "grep -v 'EXPECTED_BRANCH=\"{branch}\"' .claude/commands/orchestrator.md > t && mv t .claude/commands/orchestrator.md"
expect_red N9d-a0-branch-cmp  "grep -v 'current_branch\" != \"\$EXPECTED_BRANCH' .claude/commands/orchestrator.md > t && mv t .claude/commands/orchestrator.md"
expect_red N10-a0-handoff   "grep -v 'git ls-files --error-unmatch' .claude/commands/orchestrator.md > t && mv t .claude/commands/orchestrator.md"
expect_red N11-a0-add       "grep -v 'git add -- \"\$milestone_path\"' .claude/commands/orchestrator.md > t && mv t .claude/commands/orchestrator.md"
expect_red N11b-a0-placeholder "grep -v 'do not ship a placeholder' .claude/commands/orchestrator.md > t && mv t .claude/commands/orchestrator.md"
expect_red N12-f-skip       "grep -v 'FLY-2045-F-SKIP' .claude/commands/orchestrator.md > t && mv t .claude/commands/orchestrator.md"
expect_red N13-repo-pred    "grep -v 'basename \"\$MAIN_REPO\"' .claude/commands/orchestrator.md > t && mv t .claude/commands/orchestrator.md"
# Deleting ONE of the two flywheel spin.md call sites must also be caught.
expect_red N7b-spin-one-site "python3 -c \"import io;p='.claude/commands/spin.md';s=io.open(p,encoding='utf-8').read();i=s.index('engineering/doc/milestones/<ID>.md');s=s[:i]+'CLAUDE.md milestone'+s[i+len('engineering/doc/milestones/<ID>.md'):];io.open(p,'w',encoding='utf-8').write(s)\""

echo
echo "=== positives: legitimate shapes must not be rejected ==="
# Without P1 a hardcoded ^FLY- rule would pass every negative above while silently
# rejecting Flywheel's own GEO-era issues.
expect_green P1-geo-file "printf '# GEO-145 — x\n\n**Status**: ✅ Merged (PR #18)\n**PR**: #18\n**Date**: 2026-08-25\n\nx\n' > $MS_REL/GEO-145.md"

echo
echo "=== fail-closed portability: no checksum tool must be a NAMED failure, not a skip ==="
d="$T/P2-no-checksum"; seed "$d"
mkdir -p "$d/emptybin"
if PATH="$d/emptybin:/usr/bin:/bin" bash "$d/$GUARD_REL" >"$d/out.txt" 2>&1; then
  # /usr/bin still provides shasum on macOS, so this only proves the fallback chain works.
  if grep -q 'G3 archive sha256 matches the pin' "$d/out.txt"; then
    printf 'ok:   %-28s a checksum tool was still reachable; fallback chain works\n' "P2-no-checksum"
    pass_n=$((pass_n + 1))
  else
    printf 'FAIL: %-28s guard passed without verifying the archive checksum\n' "P2-no-checksum" >&2
    fail_n=$((fail_n + 1))
  fi
else
  if grep -q 'checksum tool unavailable' "$d/out.txt"; then
    printf 'ok:   %-28s named failure when no checksum tool exists\n' "P2-no-checksum"
    pass_n=$((pass_n + 1))
  else
    printf 'FAIL: %-28s failed for some other reason:\n%s\n' "P2-no-checksum" \
      "$(grep -m2 '^FAIL:' "$d/out.txt")" >&2
    fail_n=$((fail_n + 1))
  fi
fi

# The checklist's length is part of the contract: printing "$pass_n/$pass_n" would let a
# deleted fixture read as a clean run.
EXPECTED=27

printf '\nfly2045-milestone-layout-mutations: PASSED=%d FAILED=%d\n' "$pass_n" "$fail_n"
if [ "$fail_n" -ne 0 ]; then exit 1; fi
if [ "$pass_n" -ne "$EXPECTED" ]; then
  printf 'FAILED — ran %d fixture(s), expected %d; one was dropped\n' "$pass_n" "$EXPECTED" >&2
  exit 1
fi
echo "all $EXPECTED fixtures held"
