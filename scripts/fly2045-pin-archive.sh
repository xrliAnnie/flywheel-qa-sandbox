#!/usr/bin/env bash
# FLY-2045 — compute the archive's byte pins from an AUTHORITATIVE source, never from the
# candidate.
#
# The archive holds the milestone table exactly as it stood in CLAUDE.md before FLY-2045
# moved it out. "Zero loss" is the issue's second acceptance criterion, and the only way to
# prove it is to compare the candidate against the real thing and derive the pins from the
# SOURCE bytes.
#
# Deriving them from the candidate would be circular: if the migration dropped a line, a
# re-run would simply bless the damaged content. That proves the candidate agrees with
# itself, which is not the claim.
#
# And it is not enough for the caller to NAME a source: passing a stale SHA lets source and
# candidate agree while silently omitting milestones that landed on main in between. So the
# source identity is proven here, not asserted.
#
#   fly2045-pin-archive.sh --source-sha <40-hex> [--check-only]
#
# --check-only verifies without rewriting the pins (use it in CI / after a rebase).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GUARD="$ROOT/scripts/__tests__/fly2045-milestone-layout.test.sh"
ARCHIVE="$ROOT/engineering/doc/milestones/ARCHIVE-pre-FLY-2045.md"
BEGIN_SENTINEL='<!-- FLY-2045-ARCHIVE-BEGIN -->'
END_SENTINEL='<!-- FLY-2045-ARCHIVE-END -->'
DOC_HEADING='## Doc Structure & Lifecycle'
TABLE_HEADER='| Milestone | Status |'
SEPARATOR_RE='^\|:?-{3,}:?\|:?-{3,}:?\|$'
# A canonical ledger row has THREE independent parts. Checking only the first two was a
# real hole: `| FLY-7777: CRITICAL ACTIVE RULE - no status column |` satisfies the token
# test, so a live rule line parked at the end of the table would be counted as ledger,
# over-captured into the archive, deleted from CLAUDE.md -- and the pins would bless the
# deletion, because they only prove the two sides agree about that span, not that the span
# contains only ledger.
#
#   1. column-0 "| " start, no leading whitespace;
#   2. a COMPLETE issue token followed by a non-word character (or a complete v1.2.3
#      version followed by whitespace). Deliberately NOT "digits then a colon" -- 41 of the
#      170 real FLY/GEO rows are combined ids, version annotations or track markers, so
#      that shortcut would reject live data;
#   3. a terminal STATUS cell. Delimiters are UNESCAPED pipes only (a pipe written \| is
#      body text, not a cell boundary), and the last cell must be a complete status marker
#      followed by whitespace and non-empty text. Measured: all 179 real rows satisfy this,
#      and one of them legitimately carries an escaped pipe in its body.
CANON_RE='^\| ((FLY|GEO)-[0-9]+[^0-9A-Za-z_-]|v[0-9]+(\.[0-9]+)*[[:space:]])'
STATUS_RE='^(✅|⏳|⛔|⚠️|⚠|↪)[[:space:]]+[^[:space:]]'

SOURCE_SHA=""; CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --source-sha) SOURCE_SHA="${2:-}"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "FATAL: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SOURCE_SHA" ] || { echo "FATAL: --source-sha <40-hex> is required" >&2; exit 2; }

die() { echo "FATAL: $*" >&2; exit 2; }
command -v git >/dev/null 2>&1 || die "git not on PATH"

sha256_of_file() {
  if   command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum    >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl   >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | awk '{print $1}'
  else return 3; fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2045-pin.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- preflight on the SOURCE
printf '%s' "$SOURCE_SHA" | grep -qE '^[0-9a-f]{40}$' \
  || die "--source-sha must be a full 40-hex commit id, got: $SOURCE_SHA"

# Fetch first. Checking a possibly-stale local ref and calling the result fail-closed would
# be a claim the check cannot support.
git -C "$ROOT" fetch --quiet origin main || die "could not fetch origin/main"
actual_main="$(git -C "$ROOT" rev-parse "origin/main^{commit}" 2>/dev/null)" \
  || die "could not resolve origin/main"
[ "$SOURCE_SHA" = "$actual_main" ] \
  || die "source SHA is not current origin/main
  passed:      $SOURCE_SHA
  origin/main: $actual_main
  A stale source can agree with the candidate while omitting milestones that landed since."
git -C "$ROOT" merge-base --is-ancestor "$SOURCE_SHA" HEAD \
  || die "source SHA is not an ancestor of HEAD; this branch is not built on it"

SRC_MD="$TMP/source-CLAUDE.md"
git -C "$ROOT" show "$SOURCE_SHA:CLAUDE.md" > "$SRC_MD" || die "cannot read CLAUDE.md at $SOURCE_SHA"

# ------------------------------------------------- resolve the block, both ends anchored
n_hdr=$(grep -cFx -- "$TABLE_HEADER" "$SRC_MD" 2>/dev/null || true)
[ "${n_hdr:-0}" = "1" ] || die "source has ${n_hdr:-0} milestone table headers, expected exactly 1"
# -x matters: without it a decorated heading such as "## Doc Structure & Lifecycle (renamed)"
# would satisfy an anchor the contract says must be exact.
n_doc=$(grep -cFx -- "$DOC_HEADING" "$SRC_MD" 2>/dev/null || true)
[ "${n_doc:-0}" = "1" ] || die "source has ${n_doc:-0} whole-line '$DOC_HEADING', expected exactly 1"

BLOCK_START=$(grep -nFx -- "$TABLE_HEADER" "$SRC_MD" | cut -d: -f1)
DOC_LINE=$(grep -nFx -- "$DOC_HEADING" "$SRC_MD" | cut -d: -f1)
[ "$BLOCK_START" -lt "$DOC_LINE" ] || die "the table header is not before '$DOC_HEADING' in the source"
BLOCK_END=$(awk -v s="$BLOCK_START" -v e="$DOC_LINE" 'NR>=s && NR<e && NF>0 {last=NR} END{print last+0}' "$SRC_MD")
[ "$BLOCK_END" -gt "$BLOCK_START" ] || die "could not resolve the end of the block in the source"

# The separator must be a real two-column separator, not merely something bounded by pipes.
sep="$(sed -n "$((BLOCK_START + 1))p" "$SRC_MD")"
printf '%s\n' "$sep" | grep -qE "$SEPARATOR_RE" \
  || die "line $((BLOCK_START + 1)) is not a two-column Markdown separator: ${sep:-<empty>}"

# UNDER-capture: no ledger-shaped row may sit outside the resolved range. Without this, the
# Doc heading drifting up into the table would truncate the block, the candidate would
# compare equal against that prefix, and the back half would be lost with every SHA and
# ancestor check still green.
outside=$(awk -v s="$BLOCK_START" -v e="$BLOCK_END" \
  '(NR<s || NR>e) && $0 ~ /^[[:space:]]*[|][[:space:]]*((FLY|GEO)-[0-9]|v[0-9])/ {c++} END{print c+0}' "$SRC_MD")
[ "$outside" = "0" ] || die "$outside ledger-shaped row(s) fall outside lines ${BLOCK_START}..${BLOCK_END}"

# OVER-capture: every non-empty line inside must be a canonical row. Anything else -- prose,
# a stray heading, an unrelated table -- would be deleted from CLAUDE.md by the migration
# and the pins would bless the deletion, because they only prove the two sides agree about
# that span, not that the span contains only ledger.
# ONE awk invocation, ONE canonical(). There used to be two copies -- one to find bad rows,
# one to count good ones -- and that shape is a known false-green: changing only the counter
# made --check-only report "0 ledger rows" while still declaring the archive byte-identical
# and both pins matching, exit 0. A single implementation cannot disagree with itself.
# NOTE: these regexes reach awk through ENVIRON, not -v. `awk -v X='^\| ...'` performs
# backslash-escape processing on the VALUE, so `^\|` arrives as `^|` -- "start of line OR
# empty" -- which matches every line and silently disables the whole predicate. That was a
# real bug here: a deliberately narrowed classifier still reported all 179 rows because the
# column-0/token half was never actually applied. ENVIRON passes the bytes through untouched.
scan=$(CANON_RE="$CANON_RE" STATUS_RE="$STATUS_RE" \
  awk -v s="$((BLOCK_START + 2))" -v e="$BLOCK_END" '
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
  function canonical(line,   seg, n) {
    if (line !~ ENVIRON["CANON_RE"]) return 0
    n = cells(line, seg)
    if (trim(seg[1]) != "" || trim(seg[n]) != "") return 0
    if (trim(seg[n-1]) !~ ENVIRON["STATUS_RE"]) return 0
    return 1
  }
  NR>=s && NR<=e && NF>0 {
    if (canonical($0)) { rows++ } else { bad++; if (!first) first = NR }
  }
  END { printf "%d %d %d", bad+0, first+0, rows+0 }' "$SRC_MD")
bad_n=$(printf '%s' "$scan" | cut -d' ' -f1)
bad_first=$(printf '%s' "$scan" | cut -d' ' -f2)
rows=$(printf '%s' "$scan" | cut -d' ' -f3)
[ "$bad_n" = "0" ] || die "$bad_n non-ledger line(s) inside lines ${BLOCK_START}..${BLOCK_END} (first at ${bad_first})"
# The count is a contract, and it must be EXACT rather than "> 0". A nonzero drift is the
# case that matters: the classifier changing what it counts as ledger leaves bytes and hash
# identical, so only an exact expected count can notice.
[ "${rows:-0}" -gt 0 ] || die "resolved block contains 0 ledger rows; refusing to pin an empty ledger"
pinned_rows=$(grep -E "^ARCHIVE_ROWS=" "$GUARD" | head -1 | sed "s/.*='\(.*\)'.*/\1/")
if [ "$CHECK_ONLY" -eq 1 ] && [ "$pinned_rows" != "PIN_UNSET" ]; then
  [ "$rows" = "$pinned_rows" ] \
    || die "ledger row count drifted: source yields $rows, guard pins $pinned_rows
  bytes and hash can stay identical while the classifier changes what it counts."
fi

# Extract to a FILE and measure the file. Never block="$(...)": command substitution strips
# every trailing newline, so a blank line added or removed at the end of the block would
# slip past a byte-level proof.
sed -n "${BLOCK_START},${BLOCK_END}p" "$SRC_MD" > "$TMP/src-block"
src_bytes=$(wc -c < "$TMP/src-block" | tr -d ' ')
src_hash=$(sha256_of_file "$TMP/src-block") || die "checksum tool unavailable (need sha256sum, shasum or openssl)"

echo "source ${SOURCE_SHA:0:9}: lines ${BLOCK_START}..${BLOCK_END}, ${rows} ledger rows, ${src_bytes} bytes"
echo "  sha256 ${src_hash}"

# ------------------------------------------------------- compare against the candidate
if [ -r "$ARCHIVE" ]; then
  nb=$(grep -cFx -- "$BEGIN_SENTINEL" "$ARCHIVE" 2>/dev/null || true)
  ne=$(grep -cFx -- "$END_SENTINEL" "$ARCHIVE" 2>/dev/null || true)
  [ "${nb:-0}" = "1" ] && [ "${ne:-0}" = "1" ] \
    || die "archive must contain exactly one BEGIN and one END sentinel (got ${nb:-0}/${ne:-0})"
  b=$(grep -nFx -- "$BEGIN_SENTINEL" "$ARCHIVE" | cut -d: -f1)
  e=$(grep -nFx -- "$END_SENTINEL" "$ARCHIVE" | cut -d: -f1)
  [ "$b" -lt "$e" ] || die "archive END sentinel precedes BEGIN"
  sed -n "$((b + 1)),$((e - 1))p" "$ARCHIVE" > "$TMP/cand-block"
  if ! cmp -s "$TMP/src-block" "$TMP/cand-block"; then
    echo "FATAL: the archive does not match the source block byte for byte." >&2
    echo "  first differences:" >&2
    diff "$TMP/src-block" "$TMP/cand-block" 2>/dev/null | head -12 >&2
    echo "  refusing to write pins -- that would bless the damaged content." >&2
    exit 2
  fi
  echo "archive matches the source block byte for byte"
else
  [ "$CHECK_ONLY" -eq 1 ] && die "archive does not exist yet: $ARCHIVE"
  echo "archive does not exist yet; emitting pins for the initial migration"
fi

# ------------------------------------------------------------------------- write the pins
if [ "$CHECK_ONLY" -eq 1 ]; then
  cur_hash=$(grep -E "^ARCHIVE_SHA256=" "$GUARD" | head -1 | sed "s/.*='\(.*\)'.*/\1/")
  cur_bytes=$(grep -E "^ARCHIVE_BYTES=" "$GUARD" | head -1 | sed "s/.*='\(.*\)'.*/\1/")
  [ "$cur_hash" = "$src_hash" ] && [ "$cur_bytes" = "$src_bytes" ] && [ "$pinned_rows" = "$rows" ] \
    || die "guard pins are stale
  guard:  $cur_bytes bytes / $pinned_rows rows / $cur_hash
  source: $src_bytes bytes / $rows rows / $src_hash"
  echo "check-only: guard pins match the source"
  exit 0
fi

tmp_guard="$TMP/guard.sh"
sed -e "s/^ARCHIVE_SHA256='.*'/ARCHIVE_SHA256='${src_hash}'/" \
    -e "s/^ARCHIVE_BYTES='.*'/ARCHIVE_BYTES='${src_bytes}'/" \
    -e "s/^ARCHIVE_ROWS='.*'/ARCHIVE_ROWS='${rows}'/" "$GUARD" > "$tmp_guard"
grep -q "ARCHIVE_SHA256='${src_hash}'" "$tmp_guard" || die "failed to write the sha256 pin"
grep -q "ARCHIVE_BYTES='${src_bytes}'" "$tmp_guard" || die "failed to write the byte pin"
grep -q "ARCHIVE_ROWS='${rows}'" "$tmp_guard" || die "failed to write the row pin"
cat "$tmp_guard" > "$GUARD"
echo "pins written to ${GUARD#$ROOT/}"
