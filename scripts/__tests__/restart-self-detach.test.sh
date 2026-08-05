#!/usr/bin/env bash
set -uo pipefail

PASS=0
FAIL=0
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1634-detach.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

HARNESS="$TEST_ROOT/restart-detach-harness.sh"
{
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'log() { :; }'
  awk '
    /^FORCE=false$/ { capture=1 }
    capture && /^# FLY-1434:/ { exit }
    capture { print }
  ' "$ROOT/scripts/restart-services.sh"
  printf '%s\n' \
    'pgid="$(python3 -c '\''import os; print(os.getpgrp())'\'')"' \
    'printf "%s\t%s\n" "$$" "$pgid" > "$FLY1634_DETACH_RESULT"'
} > "$HARNESS"
chmod +x "$HARNESS"

parent_pgid="$(python3 -c 'import os; print(os.getpgrp())')"
RESULT="$TEST_ROOT/default.result"
output="$(FLY1634_DETACH_RESULT="$RESULT" bash "$HARNESS" --reason test)"
for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [ -s "$RESULT" ] && break
  sleep 0.1
done
child_pgid="$(awk -F '\t' 'NF == 2 { print $2 }' "$RESULT" 2>/dev/null || true)"
if printf '%s\n' "$output" | grep -q '^\[restart\] detached' \
  && [ -n "$parent_pgid" ] && [ -n "$child_pgid" ] \
  && [ "$child_pgid" != "$parent_pgid" ]; then
  pass "default invocation continues in a separate process group"
else
  fail "default invocation did not detach (parent=$parent_pgid child=$child_pgid output=$output)"
fi

RESULT="$TEST_ROOT/bash32-zero-args.result"
output="$(FLY1634_DETACH_RESULT="$RESULT" /bin/bash "$HARNESS" 2>&1)"
zero_args_rc=$?
for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [ -s "$RESULT" ] && break
  sleep 0.1
done
if [ "$zero_args_rc" -eq 0 ] && [ -s "$RESULT" ] \
  && printf '%s\n' "$output" | grep -q '^\[restart\] detached'; then
  pass "zero-argument detach is nounset-safe under /bin/bash"
else
  fail "zero-argument detach failed under /bin/bash (rc=$zero_args_rc output=$output)"
fi

RESULT="$TEST_ROOT/dry-run.result"
output="$(FLY1634_DETACH_RESULT="$RESULT" bash "$HARNESS" --dry-run)"
dry_pgid="$(awk -F '\t' 'NF == 2 { print $2 }' "$RESULT" 2>/dev/null || true)"
if [ -s "$RESULT" ] && ! printf '%s\n' "$output" | grep -q 'detached' \
  && [ "$dry_pgid" = "$parent_pgid" ]; then
  pass "dry-run remains synchronous"
else
  fail "dry-run detached unexpectedly (parent=$parent_pgid child=$dry_pgid output=$output)"
fi

RESULT="$TEST_ROOT/foreground.result"
output="$(FLYWHEEL_RESTART_FOREGROUND=1 FLY1634_DETACH_RESULT="$RESULT" \
  bash "$HARNESS")"
foreground_pgid="$(awk -F '\t' 'NF == 2 { print $2 }' "$RESULT" 2>/dev/null || true)"
if [ -s "$RESULT" ] && ! printf '%s\n' "$output" | grep -q 'detached' \
  && [ "$foreground_pgid" = "$parent_pgid" ]; then
  pass "foreground escape hatch remains synchronous"
else
  fail "foreground escape hatch detached (parent=$parent_pgid child=$foreground_pgid output=$output)"
fi

if rg -q 'FLYWHEEL_RESTART_FOREGROUND=1 "\$\{SCRIPT_DIR\}/restart-services\.sh"' \
  "$ROOT/scripts/update-flywheel.sh"; then
  pass "updater explicitly preserves the restart exit-code contract"
else
  fail "updater does not select synchronous restart execution"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
