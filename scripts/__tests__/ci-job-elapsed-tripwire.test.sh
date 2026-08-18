#!/usr/bin/env bash
# FLY-1870: the Script Tests capacity tripwire must fail loudly before a
# timeout cliff can masquerade as a flaky suite.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$REPO_ROOT/scripts/ci-job-elapsed-tripwire.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1870-tripwire.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
LAST_OUTPUT=""
LAST_RC=0

pass() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

run_case() {
  local label="$1" expected="$2" needle="$3"
  shift 3

  LAST_OUTPUT="$("$TARGET" "$@" 2>&1)"
  LAST_RC=$?

  if { [ "$expected" = pass ] && [ "$LAST_RC" -eq 0 ]; } ||
     { [ "$expected" = fail ] && [ "$LAST_RC" -ne 0 ]; }; then
    pass "$label exit status"
  else
    fail "$label exit status (rc=$LAST_RC)"
  fi

  if grep -Fq -- "$needle" <<<"$LAST_OUTPUT"; then
    pass "$label output"
  else
    fail "$label output missing: $needle"
  fi
}

if [ ! -x "$TARGET" ]; then
  fail "production tripwire exists and is executable: $TARGET"
  printf 'RESULT: %s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi

START="$TMP_ROOT/start"
printf '1000\n' > "$START"

run_case "below budget" pass "[tripwire] elapsed=500s budget=1020s cap=1200s usage=41%" \
  --cap-minutes 20 --threshold-pct 85 --start-file "$START" --now-epoch 1500
if grep -Fq "CAPACITY TRIPWIRE" <<<"$LAST_OUTPUT"; then
  fail "below budget omits capacity alarm"
else
  pass "below budget omits capacity alarm"
fi

run_case "at budget" fail "CAPACITY TRIPWIRE (FLY-1870)" \
  --cap-minutes 20 --threshold-pct 85 --start-file "$START" --now-epoch 2020
if grep -Fq "NOT flakiness" <<<"$LAST_OUTPUT"; then
  pass "at budget identifies capacity, not flakiness"
else
  fail "at budget identifies capacity, not flakiness"
fi

run_case "above budget" fail "CAPACITY TRIPWIRE (FLY-1870)" \
  --cap-minutes 20 --threshold-pct 85 --start-file "$START" --now-epoch 2021

run_case "missing start file" fail "TRIPWIRE MISCONFIGURED (FLY-1870)" \
  --cap-minutes 20 --threshold-pct 85 --start-file "$TMP_ROOT/missing" --now-epoch 1500

printf 'not-an-epoch\n' > "$TMP_ROOT/garbage"
run_case "garbage start epoch" fail "TRIPWIRE MISCONFIGURED (FLY-1870)" \
  --cap-minutes 20 --threshold-pct 85 --start-file "$TMP_ROOT/garbage" --now-epoch 1500

printf '1600\n' > "$TMP_ROOT/future"
run_case "future start epoch" fail "TRIPWIRE MISCONFIGURED (FLY-1870)" \
  --cap-minutes 20 --threshold-pct 85 --start-file "$TMP_ROOT/future" --now-epoch 1500

run_case "missing arguments" fail "TRIPWIRE MISCONFIGURED (FLY-1870)"
run_case "zero cap" fail "TRIPWIRE MISCONFIGURED (FLY-1870)" \
  --cap-minutes 0 --threshold-pct 85 --start-file "$START" --now-epoch 1500
run_case "zero threshold" fail "TRIPWIRE MISCONFIGURED (FLY-1870)" \
  --cap-minutes 20 --threshold-pct 0 --start-file "$START" --now-epoch 1500
run_case "threshold above 100" fail "TRIPWIRE MISCONFIGURED (FLY-1870)" \
  --cap-minutes 20 --threshold-pct 101 --start-file "$START" --now-epoch 1500
run_case "non-integer now" fail "TRIPWIRE MISCONFIGURED (FLY-1870)" \
  --cap-minutes 20 --threshold-pct 85 --start-file "$START" --now-epoch nope
run_case "negative now" fail "TRIPWIRE MISCONFIGURED (FLY-1870)" \
  --cap-minutes 20 --threshold-pct 85 --start-file "$START" --now-epoch -1
run_case "unknown flag" fail "TRIPWIRE MISCONFIGURED (FLY-1870)" \
  --cap-minutes 20 --threshold-pct 85 --start-file "$START" --now-epoch 1500 --surprise yes
run_case "duplicate flag" fail "TRIPWIRE MISCONFIGURED (FLY-1870)" \
  --cap-minutes 20 --cap-minutes 20 --threshold-pct 85 --start-file "$START" --now-epoch 1500
run_case "flag missing value" fail "TRIPWIRE MISCONFIGURED (FLY-1870)" \
  --cap-minutes 20 --threshold-pct

mkdir -p "$TMP_ROOT/bin"
cat > "$TMP_ROOT/bin/date" <<'SH'
#!/usr/bin/env bash
[ "$#" -eq 1 ] && [ "$1" = +%s ] || exit 97
printf '%s\n' "$FLY1870_FAKE_NOW"
SH
chmod +x "$TMP_ROOT/bin/date"

FLYWHEEL_TEST_PATH="$PATH"
PATH="$TMP_ROOT/bin:$FLYWHEEL_TEST_PATH" FLY1870_FAKE_NOW=1500 \
  run_case "real date path below budget" pass "[tripwire] elapsed=500s" \
    --cap-minutes 20 --threshold-pct 85 --start-file "$START"
PATH="$TMP_ROOT/bin:$FLYWHEEL_TEST_PATH" FLY1870_FAKE_NOW=2020 \
  run_case "real date path at budget" fail "CAPACITY TRIPWIRE (FLY-1870)" \
    --cap-minutes 20 --threshold-pct 85 --start-file "$START"

printf 'RESULT: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
