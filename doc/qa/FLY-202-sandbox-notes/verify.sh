#!/usr/bin/env bash
# QA structural verification for doc/qa/sandbox-notes.md (FLY-202 fixture).
# Mirrors the "Verification Summary" table in
# doc/qa/FLY-202-sandbox-notes/plan.md — run from repo root or anywhere.
set -eu
cd "$(git rev-parse --show-toplevel)"

FILE="doc/qa/sandbox-notes.md"
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

sections=$(grep -c '^## ' "$FILE")
check "4 sections present" "$sections" "4"

live_dirs=$(ls -F | grep -c '/$')
table_rows=$(grep -c '^| `' "$FILE")
check "table rows == live top-level dir count" "$table_rows" "$live_dirs"

bullets=$(awk '/^## packages/,0' "$FILE" | grep -c '^- ')
if [ "$bullets" -ge 9 ] && [ "$bullets" -le 11 ]; then
  echo "PASS: README summary bullet count in [9,11] (${bullets})"
else
  echo "FAIL: README summary bullet count out of [9,11] range (${bullets})"
  fail=1
fi

fence_count=$(awk '/^## `ls -R/,0' "$FILE" | grep -c '^```')
check "fenced ls -R block open+close" "$fence_count" "2"

live_snapshot=$(ls -R doc/ | head -50)
embedded_snapshot=$(awk '/^## `ls -R/,0' "$FILE" | sed -n '/^```text/,/^```/p' | sed '1d;$d')
if [ "$live_snapshot" = "$embedded_snapshot" ]; then
  echo "PASS: embedded ls -R snapshot matches live output verbatim"
else
  echo "FAIL: embedded ls -R snapshot is stale vs. live 'ls -R doc/ | head -50'"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "SOME CHECKS FAILED"
  exit 1
fi
