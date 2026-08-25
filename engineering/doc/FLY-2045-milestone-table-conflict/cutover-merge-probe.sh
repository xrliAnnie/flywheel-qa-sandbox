#!/usr/bin/env bash
# FLY-2045 — what does the cutover actually do to a stale in-flight branch?
#
# Two layouts were on the table:
#   A  freeze the block in place (sentinels around it, bytes untouched)
#   B  delete the block from CLAUDE.md and move it to engineering/doc/milestones/
#
# The Lead ruled B. This probe is the evidence for WHY B's cutover behaves the way
# §7.2 of the plan says it does, measured against the REAL pre-cutover CLAUDE.md:
#
#   B vs a stale writer  -> CONFLICT   (the branch goes DIRTY: loud, unmergeable)
#   A vs the same writer -> CLEAN      (the stale row would slip inside the sentinels)
#
# That difference is why B's cutover needs a re-inventory + forced-rebase pass while A
# would have needed an event-level CI fence instead: a base advancing does not by itself
# produce a new pull_request run, and ship-await-ci.sh only inspects runs already on the
# exact head, so under A a pre-cutover green head could carry the old row in with the new
# guard never having run.
#
# SOURCE SEAM (Codex design review R4 #1): once B lands, the working tree's CLAUDE.md no
# longer contains the table, so reading the worktree would make this probe unrunnable on
# the final candidate. The base must therefore come from an explicit pre-cutover source:
#
#   --source-sha <sha>    read <sha>:CLAUDE.md   (use D9's authoritative source SHA)
#   --source-file <path>  read a file            (the seam the negative controls drive)
#   (neither)             read the worktree CLAUDE.md — only valid before B lands
#
# Fail-closed: every expectation is an assertion. Any reversed result, any tool error and
# any unexpected merge shape exits non-zero. A silent pass is impossible.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

SOURCE_SHA=""
SOURCE_FILE=""
METRIC_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --source-sha)  SOURCE_SHA="${2:-}"; shift 2 ;;
    --source-file) SOURCE_FILE="${2:-}"; shift 2 ;;
    # Machine records go HERE, on a channel the caller owns. Codex R13 showed a
    # whole-line anchor on stdout only constrains the SHAPE of a line, not its
    # provenance: a caller-controlled path containing an embedded newline plus a fake
    # "FLY2045_METRIC data_rows=151" line makes the human `source:` log emit a perfect
    # forgery, so a probe with its real record DELETED still satisfied every count
    # control (36/36). Nothing the source can influence is written to this file.
    --metric-file) METRIC_FILE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "FATAL: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# `git merge-file` is the whole instrument; a missing git would otherwise surface as
# rc=127, which the shape classifier below must not mistake for a conflict.
command -v git >/dev/null 2>&1 || { echo "FATAL: git not on PATH" >&2; exit 2; }

# Metric-path contract (Codex R13 #2 / R14 #2): the caller owns this path, it must be a
# real path, and it must not alias an input -- pointing it at --source-file makes the probe
# overwrite its own input with a 29-byte record and still exit 0. Output here is
# destructive by design (truncate, follow symlinks), so say so rather than implying
# otherwise.
if [ -n "${METRIC_FILE:-}" ]; then
  case "$METRIC_FILE" in
    "") echo "FATAL: --metric-file requires a path" >&2; exit 2 ;;
  esac
  if [ -n "$SOURCE_FILE" ] && [ "$METRIC_FILE" = "$SOURCE_FILE" ]; then
    echo "FATAL: --metric-file must not be the same path as --source-file" >&2; exit 2
  fi
  if [ -d "$METRIC_FILE" ]; then
    echo "FATAL: --metric-file is a directory: $METRIC_FILE" >&2; exit 2
  fi
fi

SB="$(mktemp -d "${TMPDIR:-/tmp}/fly2045-cutover-probe.XXXXXX")"
trap 'rm -rf "$SB"' EXIT

BASE="$SB/base.md"
if [ -n "$SOURCE_SHA" ] && [ -n "$SOURCE_FILE" ]; then
  echo "FATAL: pass --source-sha or --source-file, not both" >&2; exit 2
elif [ -n "$SOURCE_SHA" ]; then
  git -C "$ROOT" rev-parse --quiet --verify "${SOURCE_SHA}^{commit}" >/dev/null \
    || { echo "FATAL: not a commit: $SOURCE_SHA" >&2; exit 2; }
  git -C "$ROOT" show "${SOURCE_SHA}:CLAUDE.md" > "$BASE" \
    || { echo "FATAL: cannot read CLAUDE.md at $SOURCE_SHA" >&2; exit 2; }
  echo "  source: $(printf '%s' "$SOURCE_SHA" | tr '\n\r' '??'):CLAUDE.md"
elif [ -n "$SOURCE_FILE" ]; then
  [ -r "$SOURCE_FILE" ] || { echo "FATAL: cannot read $SOURCE_FILE" >&2; exit 2; }
  cp "$SOURCE_FILE" "$BASE"
  # Single-line-encode the untrusted path so it cannot inject additional log lines.
  echo "  source: $(printf '%s' "$SOURCE_FILE" | tr '\n\r' '??')"
else
  [ -r "$ROOT/CLAUDE.md" ] || { echo "FATAL: cannot read $ROOT/CLAUDE.md" >&2; exit 2; }
  cp "$ROOT/CLAUDE.md" "$BASE"
  echo "  source: worktree CLAUDE.md (only valid before the cutover lands)"
fi

failures=0
note() { printf '  %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }

# --- Boundary resolution. Hardcoding 39/224 contradicts the plan's own rule that main
#     advancing shifts them, and "the next '## ' heading" is not a stable anchor either:
#     delete `## Doc Structure & Lifecycle` and the scan happily runs on to
#     `## Key Architecture Decisions`, silently swallowing everything between
#     (Codex R4 #2/#3). So both ends are bound to exact, unique anchors -- and, since an
#     exact anchor only stops the block from capturing too LITTLE, the shape closure
#     below stops it from capturing too MUCH (Codex R6 #1). Note that after the anchor is
#     exact, an ordinary `## Rogue Heading` inside the table no longer truncates anything
#     -- it OVER-captures; the genuine under-capture shape is the unique Doc heading being
#     hoisted up into the table, which the outside-row check catches.
# NOTE: the pipe is written as the bracket expression [|], NOT as \| — in awk's ERE a
# backslash-escaped pipe is not portable and degenerates into alternation, which makes
# `^[[:space:]]*` its own branch and therefore matches every line in the file. This
# probe's own completeness check caught that (it reported 441-186=255 "outside" rows).
# Two different predicates, deliberately:
#
#  MILESTONE_ROW_RE (LOOSE) — used only to detect milestone-shaped rows that escaped
#  OUTSIDE the block. Being generous here is the conservative direction: it fires more
#  often, and a false fire is a named stop rather than a silent truncation.
#
#  canonical()      (STRICT) — used to decide what may live INSIDE the block. Codex R8
#  showed the loose form is far too weak for that job: it only asserts "optional indent,
#  pipe, FLY-/GEO-/v, one digit", so all of these were absorbed with PROBE OK and the
#  block grew to 39..225:
#      | FLY-1NOT-A-MILESTONE LIVE RULE |          <- issue token has no boundary
#      | v1THIS-IS-NOT-A-VERSION LIVE RULE |       <- version token has no boundary
#          | GEO-7NOT-A-MILESTONE LIVE RULE |      <- leading whitespace still allowed
#      | FLY-7777: CRITICAL ACTIVE RULE |          <- one cell, not a two-column row
#      | FLY-7777NOT-A-MILESTONE | preserve |      <- extra pipes do not fix the token
#  The strict form requires: column-0 "| ", a COMPLETE FLY/GEO digit token followed by a
#  non-word character (or a complete v1.2.3-style version followed by whitespace), real
#  delimiters at both ends, and a trailing pipe — i.e. proof that milestone and status cells
#  both exist. Verified against the real file: 177/177 rows accepted, all of the above
#  rejected. Note it deliberately does NOT require an immediate colon after the digits —
#  41 of the 170 real FLY/GEO rows are combined IDs, version annotations or track/inc
#  markers, so that shortcut would false-RED on live data.
MILESTONE_ROW_RE='^[[:space:]]*[|][[:space:]]*((FLY|GEO)-[0-9]|v[0-9])'
CANONICAL_ROW_RE='^[|] ((FLY|GEO)-[0-9]+[^0-9A-Za-z_-]|v[0-9]+(\.[0-9]+)*[[:space:]])'
# One predicate for the whole status grammar: complete marker, whitespace, then at least
# one non-space character. The previous form paired a prefix regex with
# `trim(substr(status, 4)) == ""`, which Codex R11 #3 showed was (a) dead once the status
# is trimmed and the regex already demands trailing whitespace, and (b) not portable —
# a fixed offset of 4 bakes in whether awk counts bytes or characters, and the markers are
# not even the same length (⚠️ carries a variation selector).
STATUS_CELL_RE='^(✅|⏳|⛔|⚠️|⚠|↪)[[:space:]]+[^[:space:]]'
DOC_HEADING='## Doc Structure & Lifecycle'

count_matches() { grep -c "$1" "$2" 2>/dev/null || true; }

header_matches=$(count_matches '^| Milestone | Status |$' "$BASE")
[ "${header_matches:-0}" = "1" ] || { echo "FATAL: expected exactly 1 milestone table header, got ${header_matches:-0}" >&2; exit 2; }
# -x is load-bearing: without whole-line matching, `## Doc Structure & Lifecycle (renamed)`
# and any other decorated variant satisfy a plain -F substring search, and the probe then
# happily resolves a boundary that the guard contract says must be an exact unique anchor.
# Codex design review R5 #1 demonstrated exactly that against this file (it printed
# PROBE OK on a renamed heading); `decorated-doc-heading` in the controls suite pins it.
doc_matches=$(grep -cFx -- "$DOC_HEADING" "$BASE" 2>/dev/null || true)
[ "${doc_matches:-0}" = "1" ] || { echo "FATAL: expected exactly 1 whole-line '$DOC_HEADING', got ${doc_matches:-0}" >&2; exit 2; }

BLOCK_START=$(grep -n '^| Milestone | Status |$' "$BASE" | cut -d: -f1)
DOC_LINE=$(grep -nFx -- "$DOC_HEADING" "$BASE" | cut -d: -f1)
[ "$BLOCK_START" -lt "$DOC_LINE" ] || { echo "FATAL: milestone header (line $BLOCK_START) is not before '$DOC_HEADING' (line $DOC_LINE)" >&2; exit 2; }

BLOCK_END=$(awk -v s="$BLOCK_START" -v e="$DOC_LINE" 'NR>=s && NR<e && NF>0 {last=NR} END{print last+0}' "$BASE")
[ "$BLOCK_END" -ge "$BLOCK_START" ] || { echo "FATAL: could not resolve the block end" >&2; exit 2; }

# Completeness (UNDER-capture): every milestone-shaped row in the whole file must fall
# inside the range. Without this, the exact Doc heading being hoisted up into the table --
# or a row that drifted out of it -- truncates the block while the probe still looks
# healthy. (An ordinary rogue heading does not truncate; it OVER-captures, which the shape
# closure below handles.)
outside=$(awk -v s="$BLOCK_START" -v e="$BLOCK_END" -v re="$MILESTONE_ROW_RE" \
  '(NR<s || NR>e) && $0 ~ re {c++} END{print c+0}' "$BASE")
[ "$outside" = "0" ] || { echo "FATAL: $outside milestone-shaped row(s) fall outside lines ${BLOCK_START}..${BLOCK_END}; boundary detection is wrong" >&2; exit 2; }

# TABLE-SHAPE CLOSURE. The completeness check above only guards against capturing too
# LITTLE. Codex design review R6 #1 showed the opposite failure is worse: put an ordinary
# rule line between the table and the Doc heading and the block end happily extends to
# swallow it, so the B fixture deletes a live CLAUDE.md rule and the pin blesses the
# deletion. Measured on the real file, lines 39..224 are 179 pipe rows + 7 blanks + 0
# other non-empty lines, so requiring every non-empty line in range to be a table row
# costs nothing today and closes the over-capture hole.
# (a) The separator must be a real two-column Markdown separator, not merely something
#     that starts and ends with a pipe. Codex R7 showed `||||`, `| |` and `|::|` all
#     satisfied the old loose character-class test and the probe still exited 0.
sep_line=$(sed -n "$((BLOCK_START + 1))p" "$BASE")
printf '%s\n' "$sep_line" | grep -qE '^\|:?-{3,}:?\|:?-{3,}:?\|$' \
  || { echo "FATAL: line $((BLOCK_START + 1)) is not a two-column Markdown separator row: ${sep_line:-<empty>}" >&2; exit 2; }

# (b) Every non-empty line after the separator must be a CANONICAL milestone row, not
#     merely pipe-prefixed. Codex R7 swallowed `| CRITICAL ACTIVE RULE: preserve this |`
#     and even a whole unrelated 3-row table this way, extending the block to 225/227 and
#     still printing PROBE OK — which would have let B delete live unrelated content with
#     cmp and both pins blessing the deletion. Mechanically verified on the real file:
#     all 177 data rows begin with `| FLY-<n>`, `| GEO-<n>` or `| v<digit>`, so requiring
#     that shape costs nothing today.
scan=$(CANON_RE="$CANONICAL_ROW_RE" STATUS_RE="$STATUS_CELL_RE" awk -v s="$((BLOCK_START + 2))" -v e="$BLOCK_END" '
  # ---- legacy-aware source-row classifier ------------------------------------
  # This is NOT a Markdown renderer and does not claim to be. It answers one narrow
  # question: is this source line one of the frozen ledger rows, or live content that
  # must not be swallowed by the block?
  #
  # Delimiters are UNESCAPED pipes only. There is deliberately no backtick state
  # machine: per GFM a pipe inside an inline-code span is still a cell delimiter unless
  # escaped, and a parity toggle over single backticks is not a code-span scanner
  # anyway -- it false-REDs legitimate rows carrying an unmatched backtick or a
  # ``a ` b`` span, and its verdict flips with the NUMBER of backticks (Codex R10 #1).
  # Measured: 7 of the 177 frozen rows carry extra unescaped pipes (6 in historical
  # inline-code text, 1 in the plain words "schema 1|2"); they are accepted byte for
  # byte, which is the point -- compatibility with the legacy source shape, not
  # rendering fidelity.
  function cells(line, out,    i, c, nxt, cur, cnt) {
    cnt = 0; cur = ""
    for (i = 1; i <= length(line); i++) {
      c = substr(line, i, 1)
      if (c == "\\") { nxt = substr(line, i+1, 1); cur = cur c nxt; i++; continue }
      if (c == "|")  { cnt++; out[cnt] = cur; cur = ""; continue }
      cur = cur c
    }
    cnt++; out[cnt] = cur
    return cnt
  }
  function trim(x) { sub(/^[[:space:]]+/, "", x); sub(/[[:space:]]+$/, "", x); return x }
  # Three independent predicates, each with its own control and its own mutant.
  function canonical(line,   seg, n, status) {
    if (line !~ ENVIRON["CANON_RE"]) return 0                            # 1. column-0 + complete token
    n = cells(line, seg)
    if (trim(seg[1]) != "" || trim(seg[n]) != "") return 0    # 2. real delimiters at both ends
    status = trim(seg[n-1])                                   # 3. terminal cell is a real status
    # A complete marker followed by whitespace and a non-empty remainder. A bare prefix
    # test accepted "@NOT-A-STATUS", "@<!-- fake status -->" and a marker on its own --
    # the same missing-boundary bug as the FLY-1NOT token collision (Codex R10 #2).
    # Measured: all 177 frozen rows have whitespace after the marker and non-empty text.
    # This proves conformance to the frozen ledger STATUS GRAMMAR, not human intent:
    # "@ KEEP THIS LIVE" is still indistinguishable from a status by any machine.
    if (status !~ ENVIRON["STATUS_RE"]) return 0
    return 1
  }

  # ONE pass, ONE classifier. There used to be two copies of this awk program -- one to
  # reject bad rows, one to count data rows -- and Codex R11 #1 showed they could drift:
  # changing ONLY the second copy so it did not accept the variation-selector ⚠️ made the
  # real line 146 vanish from the count (177 -> 176) while probe, controls and mutants all
  # still reported success, because nothing asserted the count exactly. One copy cannot
  # disagree with itself.
  NR>=s && NR<=e && NF>0 {
    if (canonical($0)) { data++ } else { bad++; if (!first) first = NR }
  }
  END { printf "%d %d %d", bad+0, first+0, data+0 }' "$BASE")
bad_rows_count=$(printf '%s' "$scan" | cut -d' ' -f1)
bad_rows_first=$(printf '%s' "$scan" | cut -d' ' -f2)
data_rows=$(printf '%s' "$scan" | cut -d' ' -f3)
[ "$bad_rows_count" = "0" ] || { echo "FATAL: $bad_rows_count non-milestone line(s) inside lines ${BLOCK_START}..${BLOCK_END} (first at line ${bad_rows_first}); the block would over-capture live content" >&2; exit 2; }

# Counted with the SAME canonical predicate, so the reported number cannot drift from
# what the closure actually accepted (Codex R8 #1).

[ "${data_rows:-0}" -gt 100 ] || { echo "FATAL: resolved block holds only ${data_rows:-0} data rows; boundary detection is wrong" >&2; exit 2; }
note "resolved milestone block: lines ${BLOCK_START}..${BLOCK_END} (${data_rows} data rows, 0 outside, 0 non-milestone inside)"
# A dedicated whole-line machine record, separate from the human log. Codex R12 showed the
# human line is not a protocol: a control that searched the output for "(N data rows" could
# be satisfied by the earlier `source: <path>` line, so simply running from a directory
# named "(151 data rows spoof)" made a deliberately wrong probe report 35/35. Consumers
# must anchor on this record and assert it appears exactly once.
# stdout keeps a copy for humans; the authoritative record goes to the caller-owned file
# when one was supplied. Consumers must read the file, not the log.
printf 'FLY2045_METRIC data_rows=%s\n' "$data_rows"
if [ -n "$METRIC_FILE" ]; then
  printf 'FLY2045_METRIC data_rows=%s\n' "$data_rows" > "$METRIC_FILE" \
    || { echo "FATAL: cannot write the metric record to $METRIC_FILE" >&2; exit 2; }
fi

# --- side "B" (the ruled layout): delete the block, leave a pointer.
BVAR="$SB/variant-b.md"
{
  sed -n "1,$((BLOCK_START - 1))p" "$BASE"
  echo '里程碑账本在 `engineering/doc/milestones/` —— 一 issue 一文件。'
  sed -n "$((BLOCK_END + 1)),\$p" "$BASE"
} > "$BVAR"

# --- side "A" (the rejected layout): sentinels around the block, only lines outside it.
AVAR="$SB/variant-a.md"
{
  sed -n "1,$((BLOCK_START - 1))p" "$BASE"
  echo '⚠️ 本表已冻结。'
  echo ''
  echo '<!-- FLY-2045-FROZEN-BEGIN -->'
  sed -n "${BLOCK_START},${BLOCK_END}p" "$BASE"
  echo '<!-- FLY-2045-FROZEN-END -->'
  sed -n "$((BLOCK_END + 1)),\$p" "$BASE"
} > "$AVAR"

# --- side "stale": an in-flight branch still inserting at the top of the table, exactly
#     the way every ship does today.
make_stale() {  # $1=outfile $2=marker
  {
    sed -n "1,$((BLOCK_START + 1))p" "$BASE"
    echo "| $2: **a stale in-flight branch row** | ⏳ Pending ship |"
    sed -n "$((BLOCK_START + 2)),\$p" "$BASE"
  } > "$1"
}
STALE="$SB/stale.md";   make_stale "$STALE"  "FLY-9999"
STALE2="$SB/stale2.md"; make_stale "$STALE2" "FLY-8888"

merge_count=0
merge_shape() {  # <ours> <base> <theirs> -> "CLEAN" | "CONFLICT"; non-zero on tool error
  local ours="$1" base="$2" theirs="$3" rc=0
  merge_count=$((merge_count + 1))
  local out="$SB/merged.${merge_count}.md"
  cp "$ours" "$out"
  git merge-file "$out" "$base" "$theirs" >/dev/null 2>&1 || rc=$?
  # git merge-file returns the conflict count; 127 is reserved for command-not-found and
  # anything >=127 is treated as a tool error rather than an implausible conflict count.
  if [ "$rc" -eq 0 ]; then
    printf 'CLEAN\n'
  elif [ "$rc" -ge 1 ] && [ "$rc" -lt 127 ]; then
    printf 'CONFLICT\n'
  else
    echo "FATAL: git merge-file tool error rc=$rc" >&2
    return 2
  fi
  printf '%s\n' "$out" > "$SB/last-merged-path"
}

echo "################ 1. RULED LAYOUT B vs a stale in-flight branch ################"
shape=$(merge_shape "$BVAR" "$BASE" "$STALE")
if [ "$shape" = "CONFLICT" ]; then
  note "CONFLICT — as expected: under B the stale branch goes DIRTY at cutover."
  note "           loud and unmergeable, so it cannot carry the old row in silently."
else
  fail "B vs stale writer was $shape, expected CONFLICT — §7.2 of the plan is built on this"
fi

echo
echo "################ 2. REJECTED LAYOUT A vs the same stale branch ################"
shape=$(merge_shape "$AVAR" "$BASE" "$STALE")
merged_a=$(cat "$SB/last-merged-path")
if [ "$shape" = "CLEAN" ]; then
  note "CLEAN — under A the stale branch would NOT go DIRTY."
  occurrences=$(grep -c 'FLY-9999' "$merged_a" || true)
  [ "${occurrences:-0}" = "1" ] || fail "expected the stale row exactly once under A, got ${occurrences:-0}"
  inside=$(awk '
    /FLY-2045-FROZEN-BEGIN/ {inblock=1; next}
    /FLY-2045-FROZEN-END/   {inblock=0; next}
    /FLY-9999/              {if (inblock) hit++; else outside++}
    END {if (hit==1 && outside==0) print "yes"; else print "no"}' "$merged_a")
  if [ "$inside" = "yes" ]; then
    note "           and it lands strictly inside the frozen sentinels — which is why A"
    note "           would have needed an event-level CI fence, not just an owner notice."
  else
    fail "under A the stale row did not land strictly inside the sentinels"
  fi
else
  fail "A vs stale writer was $shape, expected CLEAN"
fi

echo
echo "################ 3. control — is the harness itself able to detect a conflict? ################"
shape=$(merge_shape "$STALE" "$BASE" "$STALE2")
if [ "$shape" = "CONFLICT" ]; then
  note "CONFLICT — harness is sound: two top-inserts still collide."
else
  fail "two stale top-inserts merged $shape; the harness is BROKEN and results 1-2 mean nothing"
fi

echo
if [ "$failures" -ne 0 ]; then
  echo "PROBE FAILED — $failures expectation(s) not met" >&2
  exit 1
fi
echo "PROBE OK — all three expectations held"
