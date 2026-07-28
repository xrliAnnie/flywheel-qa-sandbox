#!/usr/bin/env bash
# FLY-1501 QA — scripts/lib/bounded-run.sh.
#
# This helper exists because the restart brake's "brake is missing" alert has to
# be delivered from inside a launch path, where both an unbounded call and a
# detached one are wrong. Three review rounds found three distinct ways an
# inline version got it wrong, so each is pinned here:
#   * a malformed timeout must not silently disable the bound;
#   * the bound must take down descendants, not just the direct child;
#   * the helper must leave nothing running behind it.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="$REPO/scripts/lib/bounded-run.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/qa-fly1501-bounded-run.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }
eq() { if [ "$2" = "$3" ]; then pass "$1 ($2)"; else fail "$1" "want [$3] got [$2]"; fi; }

# A command that finishes immediately and leaves evidence.
cat >"$WORK/fast.sh" <<EOF
#!/bin/sh
echo "ran:\$*" >> "$WORK/fast.log"
EOF
chmod +x "$WORK/fast.sh"

# A command that spawns a descendant and then hangs, mirroring meta-alert.sh
# calling osascript. The descendant records its own pid so we can prove it died.
cat >"$WORK/hang.sh" <<EOF
#!/bin/sh
sh -c 'echo \$\$ > "$WORK/descendant.pid"; sleep 300' &
echo started > "$WORK/hang.started"
sleep 300
EOF
chmod +x "$WORK/hang.sh"

echo "== fast path: runs, returns immediately, delivers =="
: >"$WORK/fast.log"
start=$(date +%s)
"$RUN" 15 "$WORK/fast.sh" alpha beta >/dev/null 2>&1
rc=$?
elapsed=$(( $(date +%s) - start ))
eq "fast command exit status is passed through" "$rc" "0"
eq "fast command actually ran with its args" "$(grep -c 'ran:alpha beta' "$WORK/fast.log")" "1"
if [ "$elapsed" -lt 5 ]; then
  pass "fast command returns without waiting for the bound (${elapsed}s)"
else
  fail "fast command returns promptly" "took ${elapsed}s"
fi

echo "== a hung command is cut off at the bound =="
rm -f "$WORK/descendant.pid" "$WORK/hang.started"
start=$(date +%s)
"$RUN" 2 "$WORK/hang.sh" >/dev/null 2>&1
rc=$?
elapsed=$(( $(date +%s) - start ))
if [ "$elapsed" -lt 15 ]; then
  pass "hung command is bounded (${elapsed}s)"
else
  fail "hung command is bounded" "took ${elapsed}s"
fi
eq "timeout is reported as 124" "$rc" "124"
# Non-vacuous: the command really did start, so "bounded" is not "never ran".
eq "the hung command really started" "$([ -e "$WORK/hang.started" ] && echo yes || echo no)" "yes"

echo "== descendants die with it =="
sleep 1
DESC_PID="$(cat "$WORK/descendant.pid" 2>/dev/null || echo '')"
if [ -z "$DESC_PID" ]; then
  fail "descendant was recorded" "no pid file — the fixture did not spawn one"
else
  pass "descendant was recorded (pid $DESC_PID)"
  if kill -0 "$DESC_PID" 2>/dev/null; then
    fail "descendant is gone" "pid $DESC_PID is still alive — killing only the direct child orphans osascript"
  else
    pass "descendant is gone (pid $DESC_PID)"
  fi
fi

echo "== a malformed bound must not disable the bound =="
for bad in "" "abc" "0" "-5" "2.5"; do
  rm -f "$WORK/hang.started"
  start=$(date +%s)
  # The fallback is the 15s default, so this must return in roughly that time —
  # bounded, not infinite. The point is that it terminates at all.
  "$RUN" "$bad" "$WORK/hang.sh" >/dev/null 2>&1
  elapsed=$(( $(date +%s) - start ))
  if [ "$elapsed" -lt 30 ]; then
    pass "malformed bound '${bad}' still terminates (${elapsed}s)"
  else
    fail "malformed bound '${bad}'" "took ${elapsed}s — the bound was disabled"
  fi
done

echo "== usage is fail-closed =="
"$RUN" >/dev/null 2>&1
eq "no arguments is a usage error" "$?" "2"
"$RUN" 15 >/dev/null 2>&1
eq "missing command is a usage error" "$?" "2"

echo "== nothing is left running afterwards =="
rm -f "$WORK/descendant.pid"
"$RUN" 2 "$WORK/hang.sh" >/dev/null 2>&1
sleep 2
LEFT="$(pgrep -f "$WORK/hang.sh" 2>/dev/null | wc -l | tr -d ' ')"
eq "no helper-spawned process survives" "$LEFT" "0"

echo
echo "[qa-fly1501-bounded-run] passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
