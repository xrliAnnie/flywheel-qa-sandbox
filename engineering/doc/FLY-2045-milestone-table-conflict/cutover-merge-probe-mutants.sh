#!/usr/bin/env bash
# FLY-2045 — a positive control for the CONTROLS.
#
# Codex design review R9 #2 made the point that mattered: the controls suite can print a
# clean 23/23 while several of its assertions are being carried by a different branch. It
# proved this by mutating the probe -- deleting the complete-token boundary, and separately
# re-allowing leading whitespace -- and showing the suite still passed, because every
# fixture at the time also violated the status-cell predicate.
#
# So the suite needs its own control: take the real probe, delete ONE predicate branch, and
# assert the controls suite NOTICES. If a mutant passes, the corresponding fixture is not
# actually testing that branch and the suite's green is decoration.
#
# Usage: bash engineering/doc/FLY-2045-milestone-table-conflict/cutover-merge-probe-mutants.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/cutover-merge-probe.sh"
CONTROLS="$HERE/cutover-merge-probe-controls.sh"
for f in "$PROBE" "$CONTROLS"; do
  [ -r "$f" ] || { echo "FATAL: cannot read $f" >&2; exit 2; }
done

T="$(mktemp -d "${TMPDIR:-/tmp}/fly2045-probe-mutants.XXXXXX")"
trap 'rm -rf "$T"' EXIT

failures=0
pass_n=0

# ---- canonical-list comparator, proved directly -------------------------------------
# Codex R12 showed the self-control was only substring-matching: changing its edit
# argument to the literal string "failure set mismatch" produced `unknown edit` and a
# HARNESS ERROR, yet the outer check still printed "correctly rejected" and 7/7. So the
# comparator is proved on its own inputs BEFORE any end-to-end sabotage, and the sabotage
# only has to prove the wiring.
#
# NAME AND PRECONDITION (Codex R13 #2): this is NOT a set comparator. It compares two
# CANONICAL LISTS, and its correctness depends on the caller having already sorted,
# de-duplicated and validated them. Calling it sets_equal invited exactly the confusion
# where "a\nb" vs "b\na" would be a silent false negative. Both production call sites
# canonicalise with `LC_ALL=C sort -u` first, and both validate ids.
# rc 0 = equal, 1 = different.
canonical_lists_equal() { [ "$(printf '%s\n' "$1")" = "$(printf '%s\n' "$2")" ]; }

# validate_ids <list> -> rc 0 if every non-empty line is a plain control id
validate_ids() {
  printf '%s\n' "$1" | while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      *[!A-Za-z0-9-]*) exit 1 ;;
    esac
  done
}

comparator_selftest() {
  local bad=0
  canonical_lists_equal "a
b" "a
b" || { echo "comparator: equal lists not reported equal" >&2; bad=1; }
  canonical_lists_equal "a
b" "a"       && { echo "comparator: missing element not detected" >&2; bad=1; }
  canonical_lists_equal "a" "a
b"              && { echo "comparator: extra element not detected" >&2; bad=1; }
  canonical_lists_equal "a" ""    && { echo "comparator: empty actual not detected" >&2; bad=1; }
  canonical_lists_equal "" ""     || { echo "comparator: empty-vs-empty must be equal" >&2; bad=1; }
  # Documented precondition, asserted rather than assumed: unsorted input IS treated as
  # different, which is why callers must canonicalise.
  canonical_lists_equal "a
b" "b
a"           && { echo "comparator: order-sensitivity contract changed unnoticed" >&2; bad=1; }
  canonical_lists_equal "a
a" "a"          && { echo "comparator: duplicate-sensitivity contract changed unnoticed" >&2; bad=1; }
  validate_ids "ok-id
another1"      || { echo "validate_ids: rejected legal ids" >&2; bad=1; }
  validate_ids "bad id"           && { echo "validate_ids: accepted whitespace in an id" >&2; bad=1; }
  validate_ids "FAIL: leftover"   && { echo "validate_ids: accepted an unparsed FAIL line" >&2; bad=1; }
  [ "$bad" -eq 0 ] || { echo "FATAL: comparator/validator is broken; every mutant verdict below would be meaningless" >&2; exit 2; }
  echo "comparator: equal / missing / extra / empty / order / duplicate / id-validation all classified correctly"
}
comparator_selftest

# BASELINE FIRST. A mutant suite that only asks "does the mutated build go red" has a
# silent false-pass mode: if the UNMUTATED probe is already broken -- a stray apostrophe
# ended the single-quoted awk block and it was -- then every mutant goes red for the wrong
# reason and this suite prints a clean 4/4. Prove the unmutated pair is healthy first.
if ! bash -n "$PROBE" 2>/dev/null; then
  echo "FATAL: baseline probe does not even parse; mutant results would be meaningless" >&2
  exit 2
fi
baseline_fail="$(mktemp "${TMPDIR:-/tmp}/fly2045-baseline-fail.XXXXXX")"
if ! bash "$CONTROLS" --fail-file "$baseline_fail" >/dev/null 2>&1; then
  echo "FATAL: baseline controls do not pass; mutant results would be meaningless" >&2
  exit 2
fi
# rc 0 is not enough: a successful run must also carry NO failure records. Codex R14
# injected a malformed record into an otherwise-passing run and both suites stayed green.
if [ -s "$baseline_fail" ]; then
  echo "FATAL: baseline controls exited 0 but emitted failure records:" >&2
  cat "$baseline_fail" >&2
  rm -f "$baseline_fail"; exit 2
fi
rm -f "$baseline_fail"
echo "baseline: unmutated probe parses, controls pass, failure channel empty"


# run_mutant <name> <edit> <expected-failing-control-ids...>
#
# The contract is an EXPECTED FAILURE SET, not "the expected id appeared somewhere".
# Codex R11 #2 broke the substring version by making drop-token-boundary ALSO remove the
# status boundary: five controls failed, the suite saw its expected id among them and
# recorded a clean kill -- which is exactly the "unrelated control = harness error" rule
# the plan claims. Now the actual failing set is collected and compared for equality:
# missing ids, extra ids and an empty set all fail.
# classify_mutant <name> <edit> <expected ids...>
#   rc 0 = killed by exactly the expected set
#   rc 1 = went red, but the failure set does not match  (a real, reportable verdict)
#   rc 2 = harness error: mutation did not apply as pinned / mutant does not parse /
#          controls died / controls did not go red at all
# The distinction matters: the self-control below must see rc 1 specifically, because
# rc 2 means the sabotage never even happened (Codex R12).
classify_mutant() {
  local name="$1" edit="$2"; shift 2
  local expected; expected="$(printf '%s\n' "$@" | LC_ALL=C sort -u)"
  validate_ids "$expected" || { printf 'HARNESS ERROR: %-22s expected-id list is malformed\n' "$name" >&2; return 2; }
  local rc=0 out actual
  mkdir -p "$T/$name"
  cp "$PROBE" "$T/$name/cutover-merge-probe.sh"
  cp "$CONTROLS" "$T/$name/cutover-merge-probe-controls.sh"
  # Some edits target the controls copy instead of the probe (they are prefixed
  # "controls:"), so that a self-control can exercise the PRODUCTION classifier rather
  # than re-implementing its check and drifting from it.
  local edit_target="$T/$name/cutover-merge-probe.sh"
  case "$edit" in controls:*) edit_target="$T/$name/cutover-merge-probe-controls.sh" ;; esac
  if ! python3 - "$edit_target" "$edit" <<'PY'
import io, sys
path, edit = sys.argv[1], sys.argv[2]
s = io.open(path, encoding='utf-8').read()

# (old, new, expected_replacement_count) -- the count is pinned so that "meant to change
# two places, only found one" fails loudly instead of passing the `s != before` check.
EDITS = {
    # Applied to the CONTROLS copy: break one predicate so the run goes red, and make the
    # recorder emit a record that does not parse. classify_mutant must return 2.
    'controls:malformed-record': [
        # (a) make the recorder emit a record that does not parse, and
        # (b) make exactly one control genuinely fail so the recorder actually fires.
        ('record_failure() {' + chr(10) + '  failures=$((failures + 1))',
         'record_failure() {' + chr(10) + '  failures=$((failures + 1))' + chr(10) +
         '  [ -z "$FAIL_FILE" ] || printf ' + chr(39) + 'FLY2045_FAIL !! unparseable' + chr(92) + 'n' + chr(39) + ' >> "$FAIL_FILE"; return',
         1),
        ('expect_red "status-no-boundary" 2 "non-milestone line(s) inside"',
         'expect_red "status-no-boundary" 99 "non-milestone line(s) inside"',
         1)],
    'drop-token-boundary': [(
        "CANONICAL_ROW_RE='^[|] ((FLY|GEO)-[0-9]+[^0-9A-Za-z_-]|v[0-9]+(\\.[0-9]+)*[[:space:]])'",
        "CANONICAL_ROW_RE='^[|] ((FLY|GEO)-[0-9]|v[0-9])'", 1)],
    'drop-column-zero': [(
        "CANONICAL_ROW_RE='^[|] (", "CANONICAL_ROW_RE='^[[:space:]]*[|][[:space:]]*(", 1)],
    'drop-status-cell': [(
        'if (status !~ ENVIRON["STATUS_RE"]) return 0', 'if (0) return 0', 1)],
    'drop-status-boundary': [(
        "STATUS_CELL_RE='^(✅|⏳|⛔|⚠️|⚠|↪)[[:space:]]+[^[:space:]]'",
        "STATUS_CELL_RE='^(✅|⏳|⛔|⚠️|⚠|↪)'", 1)],
    'drop-escape': [(
        'if (c == "\\\\") { nxt = substr(line, i+1, 1); cur = cur c nxt; i++; continue }', '', 1)],
    'drop-strict-separator': [(
        "grep -qE '^\\|:?-{3,}:?\\|:?-{3,}:?\\|$'", "grep -qE '^\\|.*\\|$'", 1)],
    # Deliberate saboteur used by this harness's OWN negative control: breaks two
    # predicates at once, so the failure set must not match any single-branch contract.
    # The metric record is a protocol, so it needs branch mutants of its own: a wrong
    # count, a duplicated record and a missing record must all be caught by the seven
    # marker/count controls plus the spoof-path control (Codex R12).
    'offset-data-count': [(
        'END { printf "%d %d %d", bad+0, first+0, data+0 }',
        'END { printf "%d %d %d", bad+0, first+0, data+1 }', 1)],
    # Target the AUTHORITATIVE channel (the metric file), not the stdout copy: after
    # provenance separation the printf appears twice, and the pinned site count caught
    # that the moment it happened.
    'duplicate-metric-line': [(
        "printf 'FLY2045_METRIC data_rows=%s\\n' \"$data_rows\" > \"$METRIC_FILE\"",
        "printf 'FLY2045_METRIC data_rows=%s\\n' \"$data_rows\" > \"$METRIC_FILE\"\n  printf 'FLY2045_METRIC data_rows=%s\\n' \"$data_rows\" >> \"$METRIC_FILE\"", 1)],
    'drop-metric-line': [(
        "printf 'FLY2045_METRIC data_rows=%s\\n' \"$data_rows\" > \"$METRIC_FILE\"", ':', 1)],
    'sabotage-two-branches': [(
        "CANONICAL_ROW_RE='^[|] ((FLY|GEO)-[0-9]+[^0-9A-Za-z_-]|v[0-9]+(\\.[0-9]+)*[[:space:]])'",
        "CANONICAL_ROW_RE='^[|] ((FLY|GEO)-[0-9]|v[0-9])'", 1),
        ("STATUS_CELL_RE='^(✅|⏳|⛔|⚠️|⚠|↪)[[:space:]]+[^[:space:]]'",
         "STATUS_CELL_RE='^(✅|⏳|⛔|⚠️|⚠|↪)'", 1)],
}
if edit not in EDITS:
    raise SystemExit('unknown edit: ' + edit)
for old, new, want in EDITS[edit]:
    got = s.count(old)
    if got != want:
        raise SystemExit('MUTATION SITE COUNT %d, expected %d, for: %s' % (got, want, edit))
    s = s.replace(old, new)
io.open(path, 'w', encoding='utf-8').write(s)
PY
  then
    printf 'HARNESS ERROR: %-22s mutation did not apply as pinned\n' "$name" >&2
    return 2
  fi

  if ! bash -n "$T/$name/cutover-merge-probe.sh" 2>/dev/null; then
    printf 'HARNESS ERROR: %-22s mutated probe does not parse; a red result would be meaningless\n' "$name" >&2
    return 2
  fi

  local ffile="$T/$name/failures.txt"
  : > "$ffile"
  out="$(bash "$T/$name/cutover-merge-probe-controls.sh" --fail-file "$ffile" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'FAIL: %-22s controls still passed — that branch is not actually being tested\n' "$name" >&2
    return 2
  fi
  case "$out" in
    *FATAL*|*"HARNESS ERROR"*)
      printf 'HARNESS ERROR: %-22s controls died rather than failing assertions\n' "$name" >&2
      return 2 ;;
  esac

  # Read identity from the FAILURE CHANNEL, with a strict whole-line grammar, and require
  # that every raw record parses. Scraping the human log let a malformed record be dropped
  # silently -- the exact defect Codex R14 demonstrated end to end (R14 #1).
  local raw_n parsed_n
  # wc -l, not `grep -c .`: grep -c . skips BLANK lines, so a blank record in the channel
  # would satisfy "raw == parsed" while being an unparseable record.
  raw_n="$(wc -l < "$ffile" 2>/dev/null | tr -d ' ')"
  parsed_n="$(grep -c '^FLY2045_FAIL [A-Za-z0-9-][A-Za-z0-9-]*$' "$ffile" 2>/dev/null || true)"
  if [ "${raw_n:-0}" != "${parsed_n:-0}" ]; then
    printf 'HARNESS ERROR: %-22s failure channel has %s record(s) but only %s parse\n' \
      "$name" "${raw_n:-0}" "${parsed_n:-0}" >&2
    return 2
  fi
  if [ "${raw_n:-0}" = "0" ]; then
    printf 'HARNESS ERROR: %-22s controls went red but emitted no failure records\n' "$name" >&2
    return 2
  fi
  actual="$(sed -n 's/^FLY2045_FAIL \([A-Za-z0-9-][A-Za-z0-9-]*\)$/\1/p' "$ffile" | LC_ALL=C sort -u)"
  # Any FAIL line that does not reduce to a bare control id means the controls printed
  # something this harness does not understand -- treat that as a harness error rather
  # than silently dropping it (Codex R13 #2).
  if ! validate_ids "$actual"; then
    printf 'HARNESS ERROR: %-22s controls emitted an unparseable FAIL line\n' "$name" >&2
    return 2
  fi
  if canonical_lists_equal "$expected" "$actual"; then
    printf 'ok:   %-22s killed by exactly: %s\n' "$name" "$(printf '%s' "$actual" | tr '\n' ' ')"
    return 0
  fi
  printf 'FAIL: %-22s failure set mismatch\n      expected: %s\n      actual:   %s\n' \
    "$name" "$(printf '%s' "$expected" | tr '\n' ' ')" "$(printf '%s' "$actual" | tr '\n' ' ')" >&2
  return 1
}

# The normal wrapper: anything other than an exact-set kill is a failure of this suite.
run_mutant() {
  local rc=0
  classify_mutant "$@" || rc=$?
  if [ "$rc" -eq 0 ]; then pass_n=$((pass_n + 1)); else failures=$((failures + 1)); fi
}

# --- the six real branch mutants -------------------------------------------------
run_mutant drop-token-boundary   drop-token-boundary   token-collision-flygeo token-collision-legacy
run_mutant drop-column-zero      drop-column-zero      indented-row-inside
# Measured, not guessed: eight controls depend on the terminal-status branch, because
# every single-cell / bad-status fixture is rejected by it. Listing the exact set is the
# honest form of "one predicate per fixture" -- escape-isolation, for instance, depends on
# BOTH the escape branch and this one, and only drop-escape flips it on its own.
run_mutant drop-status-cell      drop-status-cell \
  arbitrary-status-cell escape-isolation escaped-pipe-single-cell inline-code-single-cell \
  missing-status-cell status-html-comment status-marker-only status-no-boundary
run_mutant drop-status-boundary  drop-status-boundary  status-no-boundary status-html-comment status-marker-only
run_mutant drop-escape           drop-escape           escape-isolation
run_mutant drop-strict-separator drop-strict-separator malformed-separator

# The metric protocol's own branch mutants. Expected set is the seven marker/count
# controls plus spoof-path, all of which consume the record.
METRIC_CONSUMERS="marker-check marker-hourglass marker-stop marker-warn marker-warn-vs marker-arrow marker-short-body spoof-path newline-injection-path"
run_mutant offset-data-count     offset-data-count     $METRIC_CONSUMERS
run_mutant duplicate-metric-line duplicate-metric-line $METRIC_CONSUMERS
run_mutant drop-metric-line      drop-metric-line      $METRIC_CONSUMERS

# --- negative control for THIS harness -------------------------------------------
# Break two predicates at once. Its failure set matches no single-branch contract, so the
# comparator must report rc 1 (a real mismatch verdict). rc 0 would mean the comparator is
# decorative; rc 2 would mean the sabotage never happened -- which is exactly how Codex
# R12 fooled the previous substring version by passing a bogus edit name.
sab_out=""; sab_rc=0
sab_out="$(classify_mutant sabotage-two-branches sabotage-two-branches \
             token-collision-flygeo token-collision-legacy 2>&1)" || sab_rc=$?
case "$sab_out" in
  *"HARNESS ERROR"*|*FATAL*)
    printf 'HARNESS ERROR: self-control never ran the sabotage:\n%s\n' "$sab_out" >&2
    failures=$((failures + 1)) ;;
  *)
    if [ "$sab_rc" -eq 1 ]; then
      printf 'ok:   %-22s comparator returned rc=1 on a two-branch break\n' "self-control"
      pass_n=$((pass_n + 1))
    else
      printf 'HARNESS ERROR: self-control expected rc=1, got rc=%s:\n%s\n' "$sab_rc" "$sab_out" >&2
      failures=$((failures + 1))
    fi ;;
esac

# --- second self-control: a malformed failure record must be a harness error ----------
# Driven through the PRODUCTION classifier, not a re-implementation of its check. The
# earlier version re-derived raw/parsed counts itself, so deleting the real malformed
# branch would have left it passing -- a control that tests a copy of the thing rather
# than the thing.
mal_out=""; mal_rc=0
mal_out="$(classify_mutant malformed-record controls:malformed-record \
             status-no-boundary 2>&1)" || mal_rc=$?
case "$mal_out" in
  *"failure channel has"*)
    if [ "$mal_rc" -eq 2 ]; then
      printf 'ok:   %-22s classifier returned rc=2 on an unparseable failure record\n' "malformed-record"
      pass_n=$((pass_n + 1))
    else
      printf 'HARNESS ERROR: malformed-record expected rc=2, got rc=%s\n' "$mal_rc" >&2
      failures=$((failures + 1))
    fi ;;
  *)
    printf 'HARNESS ERROR: malformed-record did not reach the parse check:\n%s\n' "$mal_out" >&2
    failures=$((failures + 1)) ;;
esac

EXPECTED_MUTANTS=11  # 6 predicate + 3 metric-protocol mutants + 1 self-control

echo
if [ "$failures" -ne 0 ]; then
  echo "MUTANTS FAILED — $failures mutant(s) did not hold their contract" >&2
  exit 1
fi
if [ "$pass_n" -ne "$EXPECTED_MUTANTS" ]; then
  echo "MUTANTS FAILED — ran $pass_n, expected $EXPECTED_MUTANTS; a mutant was dropped" >&2
  exit 1
fi
echo "MUTANTS OK — $pass_n/$EXPECTED_MUTANTS mutants held (6 predicate + 3 metric-protocol branches, 2 self-controls)"
