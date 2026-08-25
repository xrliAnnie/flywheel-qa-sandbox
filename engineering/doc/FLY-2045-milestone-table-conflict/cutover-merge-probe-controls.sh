#!/usr/bin/env bash
# FLY-2045 — negative controls for cutover-merge-probe.sh.
#
# The probe's own results only mean something if the probe can actually go red. Codex
# design review R4 #1 correctly objected that "I ran four negative controls" was a claim
# in a plan document with no runnable artifact behind it. This is that artifact.
#
# Each control feeds a deliberately broken CLAUDE.md through the probe's --source-file
# seam and asserts a NAMED non-zero exit. A control that passes silently fails the suite.
#
# Usage: bash engineering/doc/FLY-2045-milestone-table-conflict/cutover-merge-probe-controls.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/cutover-merge-probe.sh"
[ -x "$PROBE" ] || [ -r "$PROBE" ] || { echo "FATAL: cannot find $PROBE" >&2; exit 2; }

# --fail-file <path>: the caller-owned FAILURE channel. Codex R14 showed that scraping
# ids out of the human "FAIL:" text has the same defect the metric record had one round
# earlier -- the parser silently dropped a malformed record ("FAIL: !!! ...") and both the
# controls and the whole mutant suite still reported a clean 37/37 and 10/10. Identity of a
# failure is machine data, so it travels on its own channel with a strict grammar.
FAIL_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fail-file) FAIL_FILE="${2:-}"; shift 2 ;;
    *) echo "FATAL: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -z "$FAIL_FILE" ] || : > "$FAIL_FILE"

T="$(mktemp -d "${TMPDIR:-/tmp}/fly2045-probe-controls.XXXXXX")"
trap 'rm -rf "$T"' EXIT

failures=0
pass_n=0

# record_failure <control-id> — the ONLY way to count a failure, so the human log and the
# machine channel cannot disagree.
record_failure() {
  failures=$((failures + 1))
  [ -z "$FAIL_FILE" ] || printf 'FLY2045_FAIL %s\n' "$1" >> "$FAIL_FILE"
}

# expect_red <name> <expected-exit> <expected-stderr-substring> <fixture>
expect_red() {
  local name="$1" want_rc="$2" want_msg="$3" fixture="$4" rc=0 out
  out="$(bash "$PROBE" --source-file "$fixture" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'FAIL: %-22s exited 0 — the probe cannot detect this\n' "$name" >&2
    record_failure "$name"; return
  fi
  if [ "$rc" -ne "$want_rc" ]; then
    printf 'FAIL: %-22s exited %s, expected %s\n' "$name" "$rc" "$want_rc" >&2
    record_failure "$name"; return
  fi
  case "$out" in
    *"$want_msg"*) printf 'ok:   %-22s exit=%s, named reason present\n' "$name" "$rc"; pass_n=$((pass_n + 1)) ;;
    *) printf 'FAIL: %-22s exit=%s but the reason was not named (wanted %s)\n' "$name" "$rc" "$want_msg" >&2
       record_failure "$name" ;;
  esac
}

# expect_green <name> <fixture> — a legitimate shape that must NOT be rejected. False RED
# is as much a defect as false GREEN: it would make the guard reject live milestone rows.
expect_green() {
  local name="$1" fixture="$2" rc=0 out
  out="$(bash "$PROBE" --source-file "$fixture" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'ok:   %-26s stayed GREEN (no false RED)\n' "$name"; pass_n=$((pass_n + 1))
  else
    printf 'FAIL: %-26s went red on a LEGITIMATE shape (exit=%s)\n' "$name" "$rc" >&2
    record_failure "$name"
  fi
}

# expect_count <name> <fixture> <expected-data-rows> — the probe must not only exit 0, it
# must report EXACTLY this many canonical rows. Asserting only "> 100" was what let a
# drifted second classifier silently drop the real ⚠️ row (177 -> 176) while every suite
# still reported success (Codex R11 #1).
expect_count() {
  local name="$1" fixture="$2" want="$3" rc=0 out got mfile
  mfile="$(mktemp "${TMPDIR:-/tmp}/fly2045-metric.XXXXXX")"
  : > "$mfile"
  out="$(bash "$PROBE" --source-file "$fixture" --metric-file "$mfile" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'FAIL: %-26s exited %s on a legitimate fixture\n' "$name" "$rc" >&2
    record_failure "$name"; return
  fi
  # Anchored on the dedicated record, and it must appear EXACTLY once -- searching free
  # text let the `source: <path>` line impersonate the metric (Codex R12).
  # Read the record from the caller-owned file, never from the log. The log copy cannot
  # be trusted: a source path with an embedded newline forges a perfect record there.
  local n_metric
  n_metric="$(grep -c '^FLY2045_METRIC data_rows=[0-9][0-9]*$' "$mfile" 2>/dev/null || true)"
  if [ "${n_metric:-0}" != "1" ]; then
    printf 'FAIL: %-26s expected exactly 1 metric record on the metric channel, saw %s\n' "$name" "${n_metric:-0}" >&2
    rm -f "$mfile"; record_failure "$name"; return
  fi
  got="$(sed -n 's/^FLY2045_METRIC data_rows=\([0-9][0-9]*\)$/\1/p' "$mfile")"
  rm -f "$mfile"
  if [ "$got" = "$want" ]; then
    printf 'ok:   %-26s reported exactly %s data rows\n' "$name" "$got"; pass_n=$((pass_n + 1))
  else
    printf 'FAIL: %-26s reported %s data rows, expected %s\n' "$name" "${got:-<none>}" "$want" >&2
    record_failure "$name"
  fi
}

big_table() {  # a plausibly sized table so the row-count sanity check is not what fires
  printf '| Milestone | Status |\n|---|---|\n'
  # Rows must be CANONICAL, status marker included. They were '| ... | done |', which
  # fails the status contract -- so every control was going red on the filler rows rather
  # than on the line it was meant to test. My own legit-row positive control caught it.
  local i; for i in $(seq 1 150); do printf '| FLY-%d: **x** | ⏳ Pending ship |\n' "$i"; done
}

printf '# fake\n\nno table here\n' > "$T/no-header.md"
expect_red "no-header" 2 "expected exactly 1 milestone table header" "$T/no-header.md"

{ printf '# fake\n'; printf '| Milestone | Status |\n'; printf '| Milestone | Status |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/two-headers.md"
expect_red "two-headers" 2 "expected exactly 1 milestone table header" "$T/two-headers.md"

{ printf '# fake\n'; big_table; printf '\n'; } > "$T/no-doc-heading.md"
expect_red "no-doc-heading" 2 "## Doc Structure & Lifecycle" "$T/no-doc-heading.md"

{ printf '# fake\n'; big_table; printf '\n## Doc Structure & Lifecycle\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/two-doc-headings.md"
expect_red "two-doc-headings" 2 "## Doc Structure & Lifecycle" "$T/two-doc-headings.md"

{ printf '# fake\n'; printf '\n## Doc Structure & Lifecycle\n'; big_table; } > "$T/heading-before-table.md"
expect_red "heading-before-table" 2 "is not before" "$T/heading-before-table.md"

{ printf '# fake\n'; printf '| Milestone | Status |\n|---|---|\n| FLY-1: x | ⏳ Pending ship |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/tiny-table.md"
expect_red "tiny-table" 2 "data rows; boundary detection is wrong" "$T/tiny-table.md"

# A rogue '## ' inside the table. Note this is an OVER-capture case once the boundary
# anchor is the exact Doc heading: the block end extends past it rather than stopping
# short. The genuine UNDER-capture shape is the exact Doc heading being hoisted up into
# the table, which the outside-row completeness check catches.
{ printf '# fake\n'; printf '| Milestone | Status |\n|---|---|\n'
  i=1; while [ "$i" -le 120 ]; do printf '| FLY-%d: **x** | ⏳ Pending ship |\n' "$i"; i=$((i+1)); done
  printf '\n## Doc Structure & Lifecycle\n'
  i=121; while [ "$i" -le 160 ]; do printf '| FLY-%d: **x** | ⏳ Pending ship |\n' "$i"; i=$((i+1)); done
} > "$T/rows-outside.md"
expect_red "rows-outside-block" 2 "fall outside lines" "$T/rows-outside.md"

# Over-capture: an ordinary rule line sitting between the table and the Doc heading gets
# swallowed by the block, so B would delete live CLAUDE.md content and the pin would bless
# it. This is the fixture Codex design review R6 #1 built by hand; before the shape
# closure the probe reported "lines 39..226 ... 0 rows outside" and exited 0.
{ printf '# fake\n'; big_table
  printf '\nCRITICAL ACTIVE RULE: preserve this in CLAUDE.md\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/non-table-line-inside.md"
expect_red "non-table-line-inside" 2 "non-milestone line(s) inside" "$T/non-table-line-inside.md"

# Same class, heading-shaped. Once the anchor is exact an ordinary '## Rogue Heading' does
# not truncate -- it OVER-captures, which is the risk worth controlling for.
{ printf '# fake\n'; big_table
  printf '\n## Rogue Heading\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/rogue-heading-inside.md"
expect_red "rogue-heading-inside" 2 "non-milestone line(s) inside" "$T/rogue-heading-inside.md"

# Pipe-prefixed is NOT the same as "is a milestone row". Codex R7 fed exactly this line
# in and the block silently grew from 39..224 to 39..225 with PROBE OK.
{ printf '# fake\n'; big_table
  printf '| CRITICAL ACTIVE RULE: preserve this |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/pipe-prefixed-non-milestone.md"
expect_red "pipe-non-milestone" 2 "non-milestone line(s) inside" "$T/pipe-prefixed-non-milestone.md"

# Same class at table granularity: a whole unrelated Markdown table between the milestone
# table and the Doc heading also used to be absorbed.
{ printf '# fake\n'; big_table
  printf '\n| Key | Value |\n|---|---|\n| an unrelated table | keep me |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/unrelated-table-inside.md"
expect_red "unrelated-table-inside" 2 "non-milestone line(s) inside" "$T/unrelated-table-inside.md"

# Codex R8 #1: "starts with a canonical prefix" is not "is a canonical row". Each of these
# was absorbed with PROBE OK before the token/column tightening, so each gets its own case.
{ printf '# fake\n'; big_table
  printf '| FLY-1NOT-A-MILESTONE | ⏳ Pending ship |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/token-collision-flygeo.md"
expect_red "token-collision-flygeo" 2 "non-milestone line(s) inside" "$T/token-collision-flygeo.md"

{ printf '# fake\n'; big_table
  printf '| v1THIS-IS-NOT-A-VERSION | ⏳ Pending ship |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/token-collision-legacy.md"
expect_red "token-collision-legacy" 2 "non-milestone line(s) inside" "$T/token-collision-legacy.md"

{ printf '# fake\n'; big_table
  printf '    | GEO-7777: valid milestone | ⏳ Pending ship |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/indented-row-inside.md"
expect_red "indented-row-inside" 2 "non-milestone line(s) inside" "$T/indented-row-inside.md"

{ printf '# fake\n'; big_table
  printf '| FLY-7777: CRITICAL ACTIVE RULE - no status column |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/missing-status-cell.md"
expect_red "missing-status-cell" 2 "non-milestone line(s) inside" "$T/missing-status-cell.md"

# Codex R9 #1: raw pipe counting is not cell counting. Both of these have three raw
# pipes and ONE Markdown cell, and both were absorbed with PROBE OK before the scanner.
{ printf '# fake\n'; big_table
  printf '| FLY-7777: CRITICAL ACTIVE RULE mentions \\| but has no status cell |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/escaped-pipe-single-cell.md"
expect_red "escaped-pipe-single-cell" 2 "non-milestone line(s) inside" "$T/escaped-pipe-single-cell.md"

{ printf '# fake\n'; big_table
  printf '| FLY-7777: CRITICAL ACTIVE RULE uses `a | b` but has no status cell |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/inline-code-single-cell.md"
expect_red "inline-code-single-cell" 2 "non-milestone line(s) inside" "$T/inline-code-single-cell.md"

# Two real cells, but the terminal cell is not a milestone status.
{ printf '# fake\n'; big_table
  printf '| FLY-7777: CRITICAL ACTIVE RULE | KEEP THIS LIVE |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/arbitrary-status-cell.md"
expect_red "arbitrary-status-cell" 2 "non-milestone line(s) inside" "$T/arbitrary-status-cell.md"

# ESCAPE-BRANCH ISOLATION (Codex R10 #3). The old inline-code fake-status fixture used an
# UNESCAPED pipe, which per GFM is a real delimiter, so it could never prove "single cell"
# -- and with escape handling deleted the suite still went 23/23, red for the wrong reason.
# Here the pipe IS escaped, so with escape handling this is one cell whose terminal text
# starts with FLY- and is rejected; DELETE the escape branch and the \| becomes a
# delimiter, the last cell becomes a valid-looking status, and the probe goes green.
# Verified in both directions before adopting.
{ printf '# fake\n'; big_table
  printf '| FLY-7777: ACTIVE RULE mentions \\| ⏳ fake status |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/escape-isolation.md"
expect_red "escape-isolation" 2 "non-milestone line(s) inside" "$T/escape-isolation.md"

# POSITIVE controls. Real line 117 carries an escaped pipe in its milestone body, so the
# closure must not false-RED on one; the inline-code pipe is written \| because per GFM an
# unescaped pipe inside a code span is still a delimiter (Codex R10 #1).
{ printf '# fake\n'; big_table
  printf '| FLY-7777: **legit** — body with a `code \\| pipe` and an escaped \\| pipe | ⏳ Pending ship |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/legit-row-with-pipes.md"
expect_green "legit-row-with-pipes" "$T/legit-row-with-pipes.md"

# Backtick shapes that the old parity toggle false-REDed: an unmatched backtick (a literal
# per spec) and a ``a ` b`` span. Neither may be rejected.
{ printf '# fake\n'; big_table
  printf '| FLY-7777: legitimate prose containing an unmatched ` character | ⏳ Pending ship |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/legit-unmatched-backtick.md"
expect_green "legit-unmatched-backtick" "$T/legit-unmatched-backtick.md"

{ printf '# fake\n'; big_table
  printf '| FLY-7777: legitimate `` a ` b `` body | ⏳ Pending ship |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/legit-double-backtick.md"
expect_green "legit-double-backtick" "$T/legit-double-backtick.md"

# STATUS BOUNDARY (Codex R10 #2). A bare prefix test accepted all three of these, which is
# the same missing-token-boundary bug as FLY-1NOT-A-MILESTONE, one cell to the right.
{ printf '# fake\n'; big_table
  printf '| FLY-7777: CRITICAL ACTIVE RULE | ✅NOT-A-STATUS |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/status-no-boundary.md"
expect_red "status-no-boundary" 2 "non-milestone line(s) inside" "$T/status-no-boundary.md"

{ printf '# fake\n'; big_table
  printf '| FLY-7777: CRITICAL ACTIVE RULE | ✅<!-- fake status --> |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/status-html-comment.md"
expect_red "status-html-comment" 2 "non-milestone line(s) inside" "$T/status-html-comment.md"

{ printf '# fake\n'; big_table
  printf '| FLY-7777: CRITICAL ACTIVE RULE | ✅ |\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/status-marker-only.md"
expect_red "status-marker-only" 2 "non-milestone line(s) inside" "$T/status-marker-only.md"

# A malformed separator must not pass as a separator. `||||` satisfied the old loose test.
{ printf '# fake\n'; printf '| Milestone | Status |\n||||\n'
  i=1; while [ "$i" -le 150 ]; do printf '| FLY-%d: **x** | ⏳ Pending ship |\n' "$i"; i=$((i+1)); done
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/malformed-separator.md"
expect_red "malformed-separator" 2 "two-column Markdown separator" "$T/malformed-separator.md"

# A decorated heading must NOT satisfy the boundary anchor. This is the case Codex
# design review R5 #1 built by hand: with a plain -F substring search the probe resolved
# 39..224 and printed PROBE OK against a renamed heading.
{ printf '# fake\n'; big_table; printf '\n## Doc Structure & Lifecycle (renamed)\n'; } > "$T/decorated-doc-heading.md"
expect_red "decorated-doc-heading" 2 "whole-line" "$T/decorated-doc-heading.md"

# One positive per status marker (Codex R11 #1). Without these, a classifier that quietly
# stopped accepting one marker -- ⚠️ with its variation selector is the realistic case, and
# exactly one real row uses it -- would drop that row from the block with nothing noticing.
# Each also asserts the EXACT data-row count, so a silent drop cannot hide behind "> 100".
for marker_case in \
  'marker-check:✅ Merged (PR #1)' \
  'marker-hourglass:⏳ Pending ship' \
  'marker-stop:⛔ Retired' \
  'marker-warn:⚠ Held' \
  'marker-warn-vs:⚠️ Held' \
  'marker-arrow:↪ Superseded' \
  'marker-short-body:✅ x' ; do
  mc_name="${marker_case%%:*}"; mc_status="${marker_case#*:}"
  { printf '# fake\n'; big_table
    printf '| FLY-9001: marker probe | %s |\n' "$mc_status"
    printf '\n## Doc Structure & Lifecycle\n'; } > "$T/$mc_name.md"
  expect_count "$mc_name" "$T/$mc_name.md" 151
done

# SPOOF PATH (Codex R12). Run a legitimate fixture from a directory whose NAME contains a
# fake metric string. With an anchored, exactly-once record this must still report the real
# count; with the old free-text search the path impersonated the metric.
spoof_dir="$T/(151 data rows spoof)"
mkdir -p "$spoof_dir"
cp "$T/marker-check.md" "$spoof_dir/fixture.md"
expect_count "spoof-path" "$spoof_dir/fixture.md" 151

# NEWLINE-INJECTION PATH (Codex R13). A directory name containing an embedded newline and
# a complete fake record. On stdout this produces a byte-perfect forgery; on the metric
# channel it produces nothing at all, which is the entire point of separating provenance.
inj_dir="$T/$(printf 'inj\nFLY2045_METRIC data_rows=151\nsuffix')"
mkdir -p "$inj_dir" 2>/dev/null || inj_dir=""
if [ -n "$inj_dir" ] && [ -d "$inj_dir" ]; then
  cp "$T/marker-check.md" "$inj_dir/fixture.md"
  expect_count "newline-injection-path" "$inj_dir/fixture.md" 151
else
  printf 'FAIL: %-26s could not create the injection fixture; the control did not run\n' "newline-injection-path" >&2
  record_failure "newline-injection-path"
fi

# The post-cutover shape: after B lands there is no table at all, which is precisely why
# the probe needs --source-sha to keep working on the final candidate.
{ printf '# fake\n\n里程碑账本在 `engineering/doc/milestones/`\n'
  printf '\n## Doc Structure & Lifecycle\n'; } > "$T/post-cutover.md"
expect_red "post-cutover-shape" 2 "expected exactly 1 milestone table header" "$T/post-cutover.md"

# Fail-closed on the COUNT too (Codex R5 #1): printing "$pass_n/$pass_n" means deleting a
# control call still reads as a clean pass. The expected total is pinned here, so removing
# or forgetting to register a control turns the suite red instead of shrinking it silently.
EXPECTED_CONTROLS=37

echo
if [ "$failures" -ne 0 ]; then
  echo "CONTROLS FAILED — $failures of $((pass_n + failures)) could not make the probe go red" >&2
  exit 1
fi
if [ "$pass_n" -ne "$EXPECTED_CONTROLS" ]; then
  echo "CONTROLS FAILED — ran $pass_n control(s), expected $EXPECTED_CONTROLS; a control was dropped" >&2
  exit 1
fi
# The counter and the channel must agree. record_failure() is the only intended writer,
# but nothing stops a future control from doing failures=$((failures + 1)) directly; that
# hidden failure would not show up in the empty-channel check whenever some other control
# legitimately recorded something. Reconciling the two makes the helper's monopoly an
# assertion instead of a convention.
if [ -n "$FAIL_FILE" ]; then
  channel_n="$(wc -l < "$FAIL_FILE" 2>/dev/null | tr -d ' ')"
  if [ "${channel_n:-0}" != "$failures" ]; then
    echo "CONTROLS FAILED — counter says $failures failure(s) but the channel holds ${channel_n:-0}; a failure bypassed record_failure()" >&2
    exit 1
  fi
fi

echo "CONTROLS OK — $pass_n/$EXPECTED_CONTROLS controls held (negatives failed by name, positives stayed green)"
