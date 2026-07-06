#!/bin/bash
# FLY-896 structural verify — doc/qa/sandbox-notes.md payload checks (FLY-895 precedent)
set -u
f="doc/qa/sandbox-notes.md"
pass=0; fail=0
check() { if [ "$2" -eq 0 ]; then echo "PASS: $1"; pass=$((pass+1)); else echo "FAIL: $1"; fail=$((fail+1)); fi; }
[ -f "$f" ] && grep -q '^## E2E run log$' "$f"; check "file exists with '## E2E run log' section" $?
grep -q '^- 2026-07-05 — FLY-896 slot-3 real-machine check of the FLY-887 founder-visibility status line' "$f"; check "run-log entry present (date + issue + slot + subject)" $?
grep -q '^- 2026-07-05 — FLY-896 .*\.$' "$f"; check "run-log entry ends with terminal period (house bullet style)" $?
echo "---"
if [ "$fail" -eq 0 ]; then echo "ALL CHECKS PASSED ($pass/$((pass+fail)))"; else echo "CHECKS FAILED ($fail/$((pass+fail)) failing)"; exit 1; fi
