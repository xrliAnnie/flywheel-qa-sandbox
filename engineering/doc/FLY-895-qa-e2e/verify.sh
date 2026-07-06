#!/usr/bin/env bash
# QA structural verification for the FLY-895 E2E run-log entry in
# doc/qa/sandbox-notes.md. Mirrors the FLY-202 precedent
# (doc/qa/FLY-202-sandbox-notes/verify.sh) — run from repo root or anywhere.
set -eu
cd "$(git rev-parse --show-toplevel)"

FILE="doc/qa/sandbox-notes.md"
ENTRY_REGEX='^- 2026-07-05 — FLY-895 slot-2 redo of the FLY-887 keep-alive E2E \(Discord narrative\)\.?$'
fail=0

check() {
  local desc="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "PASS: ${desc} (${actual})"
  else
    echo "FAIL: ${desc} (expected ${expected}, got ${actual})"
    fail=1
  fi
}

if [ ! -f "$FILE" ]; then
  echo "FAIL: ${FILE} does not exist"
  exit 1
fi

section_count=$(grep -c '^## E2E run log$' "$FILE")
check "'## E2E run log' section present exactly once" "$section_count" "1"

entry_count=$(grep -cE "$ENTRY_REGEX" "$FILE")
check "run-log entry present with correct date + issue number + text" "$entry_count" "1"

entry_line=$(awk '/^## E2E run log/,0' "$FILE" | grep '^- ' | head -1)
if [[ "$entry_line" == *. ]]; then
  echo "PASS: run-log entry ends with a terminal period (style consistency with other bullets in file)"
else
  echo "FAIL: run-log entry missing terminal period (every other top-level bullet in ${FILE} ends with '.') — got: ${entry_line}"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "SOME CHECKS FAILED"
  exit 1
fi
