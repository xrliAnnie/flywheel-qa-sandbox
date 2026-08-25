#!/usr/bin/env bash
# FLY-2045 — the milestone ledger must stay out of CLAUDE.md.
#
# WHY THIS EXISTS
# The milestone table used to live in CLAUDE.md, and every ship inserted a row directly
# under the header. Two parallel branches cut from the same base therefore made an additive
# change at the SAME position, so git could not merge them: the conflict rate was 100%, not
# occasional. A conflicted PR has no merge commit, the `pull_request` workflow never queues,
# and the branch loses its CI ability entirely -- which is why one merge could put every
# other in-flight branch into an unmeasurable state (FLY-2045).
#
# The ledger now lives in engineering/doc/milestones/ as one file per issue, so two PRs
# create two DIFFERENT paths and there is nothing to conflict over. This guard keeps it
# that way.
#
# It runs in the always-on quick gate, BEFORE `pnpm install`, because every regression it
# catches is a Markdown-only change -- and Markdown under engineering/doc/ is classified
# inert, so the heavy jobs would skip exactly the PRs this is meant to catch.
#
# Pure bash, zero dependencies, fail-closed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLAUDE_MD="$ROOT/CLAUDE.md"
MS_DIR="$ROOT/engineering/doc/milestones"
ARCHIVE_NAME="ARCHIVE-pre-FLY-2045.md"
ARCHIVE="$MS_DIR/$ARCHIVE_NAME"

DOC_HEADING='## Doc Structure & Lifecycle'
PHASE_HEADING='## Current Phase'
TABLE_HEADER='| Milestone | Status |'
# The one line G2 counts. Kept as a literal so the guard and the pointer text cannot drift.
POINTER_ANCHOR='里程碑账本在 `engineering/doc/milestones/` —— 一 issue 一文件,ship 时新建 `<ID>.md`。'

BEGIN_SENTINEL='<!-- FLY-2045-ARCHIVE-BEGIN -->'
END_SENTINEL='<!-- FLY-2045-ARCHIVE-END -->'

# Pinned from the authoritative origin/main block by scripts/fly2045-pin-archive.sh.
# Do NOT hand-edit: the pin script proves the candidate matches the source before writing.
ARCHIVE_SHA256='220e060f0db2ebeba5dcbe161a31d5a42a34f605fa493a055b3bc4430c6c4801'
ARCHIVE_BYTES='172521'
# The row count is pinned as well. For the archive BYTES the hash already implies it, so
# this is not a second check on the content -- it is the only thing that would notice the
# pin script's own CLASSIFIER drifting: a changed predicate leaves bytes and hash untouched
# while silently counting a different set of lines as ledger.
ARCHIVE_ROWS='179'

pass_n=0; fail_n=0
pass() { printf 'PASS: %s\n' "$1"; pass_n=$((pass_n + 1)); }
fail() { printf 'FAIL: [%s] %s\n' "$1" "$2" >&2; fail_n=$((fail_n + 1)); }

# Portable sha256 with a fail-closed fallback: if none of the three tools exist the guard
# must exit non-zero by name rather than quietly skipping the byte-integrity check.
# (`md5` is macOS-only and does not exist on the Ubuntu runner, which is why this is not it.)
sha256_of_file() {
  if   command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum    >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl   >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | awk '{print $1}'
  else return 3; fi
}

count_fixed() { grep -cFx -- "$1" "$2" 2>/dev/null || true; }
line_of_fixed() { grep -nFx -- "$1" "$2" 2>/dev/null | head -1 | cut -d: -f1; }

# ---------------------------------------------------------------- G1: layout exists
if [ -d "$MS_DIR" ]; then pass "G1 milestones directory exists"
else fail G1 "missing directory: engineering/doc/milestones"; fi
if [ -f "$MS_DIR/README.md" ]; then pass "G1 README.md exists"
else fail G1 "missing engineering/doc/milestones/README.md"; fi
if [ -f "$ARCHIVE" ]; then pass "G1 $ARCHIVE_NAME exists"
else fail G1 "missing engineering/doc/milestones/$ARCHIVE_NAME"; fi

# ------------------------------------------------- G2: the ledger is OUT of CLAUDE.md
if [ ! -r "$CLAUDE_MD" ]; then
  fail G2 "cannot read CLAUDE.md"
else
  n_phase=$(count_fixed "$PHASE_HEADING" "$CLAUDE_MD")
  n_doc=$(count_fixed "$DOC_HEADING" "$CLAUDE_MD")
  n_ptr=$(count_fixed "$POINTER_ANCHOR" "$CLAUDE_MD")
  # Whole-line exact matching (-Fx) is load-bearing: a substring search would accept
  # "## Doc Structure & Lifecycle (renamed)" and the anchor would stop being an anchor.
  [ "${n_phase:-0}" = "1" ] && pass "G2 '$PHASE_HEADING' appears exactly once" \
    || fail G2 "expected exactly 1 '$PHASE_HEADING', got ${n_phase:-0}"
  [ "${n_doc:-0}" = "1" ] && pass "G2 '$DOC_HEADING' appears exactly once" \
    || fail G2 "expected exactly 1 whole-line '$DOC_HEADING', got ${n_doc:-0}"
  [ "${n_ptr:-0}" = "1" ] && pass "G2 pointer anchor appears exactly once" \
    || fail G2 "expected exactly 1 pointer anchor line, got ${n_ptr:-0}"

  if [ "${n_phase:-0}" = "1" ] && [ "${n_doc:-0}" = "1" ] && [ "${n_ptr:-0}" = "1" ]; then
    l_phase=$(line_of_fixed "$PHASE_HEADING" "$CLAUDE_MD")
    l_doc=$(line_of_fixed "$DOC_HEADING" "$CLAUDE_MD")
    l_ptr=$(line_of_fixed "$POINTER_ANCHOR" "$CLAUDE_MD")
    # Two relations, both checked: an implementation that only enforces pointer < doc
    # would not notice the pointer drifting above Current Phase.
    [ "$l_phase" -lt "$l_ptr" ] && pass "G2 order: Current Phase < pointer" \
      || fail G2 "pointer (line $l_ptr) must come after '$PHASE_HEADING' (line $l_phase)"
    [ "$l_ptr" -lt "$l_doc" ] && pass "G2 order: pointer < Doc Structure" \
      || fail G2 "pointer (line $l_ptr) must come before '$DOC_HEADING' (line $l_doc)"
  fi

  # No table header, and no milestone data row of ANY of the three shapes, anywhere in the
  # file. Leading whitespace is allowed for in the pattern so an indented row cannot slip
  # through, and legacy `| v0.1.0 ...` rows are covered because the frozen block really
  # does contain seven of them.
  if grep -Fq -- "$TABLE_HEADER" "$CLAUDE_MD"; then
    fail G2 "the milestone table header is back in CLAUDE.md"
  else
    pass "G2 no milestone table header in CLAUDE.md"
  fi
  rows=$(grep -cE '^[[:space:]]*\|[[:space:]]*((FLY|GEO)-[0-9]|v[0-9])' "$CLAUDE_MD" 2>/dev/null || true)
  if [ "${rows:-0}" = "0" ]; then
    pass "G2 no milestone data rows in CLAUDE.md"
  else
    fail G2 "${rows} milestone data row(s) found in CLAUDE.md; the ledger must not flow back"
  fi
fi

# ----------------------------------------------------- G3: the archive is byte-frozen
if [ ! -r "$ARCHIVE" ]; then
  fail G3 "cannot read the archive"
else
  n_begin=$(count_fixed "$BEGIN_SENTINEL" "$ARCHIVE")
  n_end=$(count_fixed "$END_SENTINEL" "$ARCHIVE")
  [ "${n_begin:-0}" = "1" ] && pass "G3 BEGIN sentinel appears exactly once" \
    || fail G3 "expected exactly 1 BEGIN sentinel, got ${n_begin:-0}"
  [ "${n_end:-0}" = "1" ] && pass "G3 END sentinel appears exactly once" \
    || fail G3 "expected exactly 1 END sentinel, got ${n_end:-0}"

  if [ "${n_begin:-0}" = "1" ] && [ "${n_end:-0}" = "1" ]; then
    b=$(line_of_fixed "$BEGIN_SENTINEL" "$ARCHIVE")
    e=$(line_of_fixed "$END_SENTINEL" "$ARCHIVE")
    if [ "$b" -lt "$e" ]; then
      pass "G3 sentinel order"
      tmp="$(mktemp "${TMPDIR:-/tmp}/fly2045-block.XXXXXX")"
      # Extract to a FILE and measure the file. Never `block="$(...)"`: command
      # substitution strips every trailing newline, so adding or removing a blank line at
      # the end of the block would slip past a byte-level proof.
      sed -n "$((b + 1)),$((e - 1))p" "$ARCHIVE" > "$tmp"
      bytes=$(wc -c < "$tmp" | tr -d ' ')
      if hash_now=$(sha256_of_file "$tmp"); then
        [ "$bytes" = "$ARCHIVE_BYTES" ] && pass "G3 archive byte count matches the pin" \
          || fail G3 "archive is $bytes bytes, pinned at $ARCHIVE_BYTES"
        [ "$hash_now" = "$ARCHIVE_SHA256" ] && pass "G3 archive sha256 matches the pin" \
          || fail G3 "archive sha256 $hash_now does not match the pin $ARCHIVE_SHA256"
      else
        fail G3 "checksum tool unavailable (need sha256sum, shasum or openssl)"
      fi
      rm -f "$tmp"
    else
      fail G3 "END sentinel (line $e) precedes BEGIN sentinel (line $b)"
    fi
  fi
fi

# ------------------------------------------- G4: every Flywheel writer points at the new home
anchor_in() { # <label> <file> <fixed-string>
  if [ -r "$2" ] && grep -Fq -- "$3" "$2"; then pass "G4 $1"
  else fail G4 "$1 — missing anchor in ${2#$ROOT/}: $3"; fi
}
EXEC_MD="$ROOT/.flywheel/agents/engineering/engineer-executor.md"
SPIN_MD="$ROOT/.claude/commands/spin.md"
ORCH_MD="$ROOT/.claude/commands/orchestrator.md"

# These anchor the actual SHELL, not the FLY-2045-* tag comments. Anchoring the tags was a
# real defect: replacing the collision check with `if false` while leaving the comment in
# place kept the guard green, so it was proving a comment exists rather than that the fence
# does anything (a proxy check is not the property it stands for).
count_of() { grep -cF -- "$2" "$1" 2>/dev/null || true; }
anchor_n() { # <label> <file> <fixed-string> <expected-count>
  local n; n=$(count_of "$2" "$3")
  if [ "${n:-0}" = "$4" ]; then pass "G4 $1"
  else fail G4 "$1 — expected $4 occurrence(s) in ${2#$ROOT/}, found ${n:-0}: $3"; fi
}

anchor_in "engineer-executor points at engineering/doc/milestones/" "$EXEC_MD" 'engineering/doc/milestones/'
# BOTH flywheel call sites, counted. "Somewhere in the file" would let one of them be
# deleted while the other kept the guard green.
anchor_n "spin.md rewrites both flywheel bookkeeping blocks" "$SPIN_MD" 'engineering/doc/milestones/<ID>.md' 2
# POSITIVE protection: spin.md's generic path is shared with every other repo, which still
# keeps its own CLAUDE.md table. Changing it would break them, so assert it is still there.
anchor_in "spin.md keeps the non-flywheel generic CLAUDE.md rule" "$SPIN_MD" \
  'Update CLAUDE.md: add milestone to table'
anchor_in "orchestrator A0 base-collision fence (real check)" "$ORCH_MD" \
  'git cat-file -e "origin/main:${milestone_path}"'
anchor_in "orchestrator A0 refuses a detached HEAD" "$ORCH_MD" \
  'git symbolic-ref --quiet --short HEAD'
# The detached check alone is half a fence. Deleting the branch-equality comparison left the
# guard green while the original wrong-branch failure still reproduced, so the binding and
# the comparison are both anchored -- and the binding must come from the same {branch} value
# the push uses, not from a variable that silently disables the check when unset.
anchor_in "orchestrator A0 binds the expected branch from {branch}" "$ORCH_MD" \
  'EXPECTED_BRANCH="{branch}"'
anchor_in "orchestrator A0 compares HEAD against the pushed branch" "$ORCH_MD" \
  '"$current_branch" != "$EXPECTED_BRANCH"'
anchor_in "orchestrator A0 branch-local handoff verifies tracked, no overwrite" "$ORCH_MD" \
  'git ls-files --error-unmatch "$milestone_path"'
anchor_in "orchestrator A0 stages the absent-path file" "$ORCH_MD" 'git add -- "$milestone_path"'
anchor_in "orchestrator A0 refuses to ship a placeholder" "$ORCH_MD" 'do not ship a placeholder'
anchor_in "orchestrator F flywheel skip" "$ORCH_MD" 'FLY-2045-F-SKIP'
# The flywheel branch must be decided by the REPO, not by an issue prefix: Flywheel's own
# history lives partly under GEO-, so a FLY- prefix test would route those down the wrong path.
anchor_in "orchestrator decides flywheel by repo, not issue prefix" "$ORCH_MD" \
  '[[ "$(basename "$MAIN_REPO")" == "flywheel" ]]'

# --------------------------------------------------- G5: only per-issue files in the directory
if [ -d "$MS_DIR" ]; then
  bad=0; n_issue=0
  for f in "$MS_DIR"/*; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    # The exemption is the EXACT archive basename, not ARCHIVE-*.md: a wildcard would let
    # ARCHIVE-notes.md through the naming rule entirely.
    [ "$base" = "README.md" ] && continue
    [ "$base" = "$ARCHIVE_NAME" ] && continue
    if printf '%s' "$base" | grep -qE '^(FLY|GEO)-[0-9]+\.md$'; then
      n_issue=$((n_issue + 1))
    else
      fail G5 "unexpected file in engineering/doc/milestones/: $base"
      bad=$((bad + 1))
    fi
  done
  [ "$bad" -eq 0 ] && pass "G5 every file matches ^(FLY|GEO)-[0-9]+\\.md\$ or the exact exemptions"

  # A template is not a milestone. `#NNN`, `<short title>` and `<summary>` are the fallback
  # placeholders; letting them through means the permanent ledger records nothing.
  ph=0
  for f in "$MS_DIR"/*.md; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    [ "$base" = "README.md" ] && continue
    [ "$base" = "$ARCHIVE_NAME" ] && continue
    if grep -qE '#NNN|<short title>|<summary>' "$f"; then
      fail G5 "$base still contains a template placeholder (#NNN / <short title> / <summary>)"
      ph=$((ph + 1))
    fi
  done
  [ "$ph" -eq 0 ] && pass "G5 no per-issue file ships a template placeholder"
  # Non-vacuous: an empty directory must not read as compliant.
  [ "$n_issue" -gt 0 ] && pass "G5 at least one per-issue milestone file exists" \
    || fail G5 "no per-issue milestone file found; the directory cannot be vacuously compliant"
fi

# ------------------------------------------------ G6: README states the same contract
README="$MS_DIR/README.md"
if [ -r "$README" ]; then
  grep -Fq -- '^(FLY|GEO)-[0-9]+\.md$' "$README" \
    && pass "G6 README states the same filename rule as G5" \
    || fail G6 "README does not state the filename rule ^(FLY|GEO)-[0-9]+\\.md\$"
  grep -Fq -- 'FLY-2045-SINGLE-WRITER' "$README" \
    && pass "G6 README states the single-writer contract" \
    || fail G6 "README is missing the single-writer contract marker"
fi

printf '\nfly2045-milestone-layout: PASSED=%d FAILED=%d\n' "$pass_n" "$fail_n"
[ "$fail_n" -eq 0 ] || exit 1
