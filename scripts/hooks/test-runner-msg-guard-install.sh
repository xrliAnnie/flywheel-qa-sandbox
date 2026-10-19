#!/bin/bash
# Test install-runner-msg-guard.sh (FLY-3083).
#
# Every case runs the REAL installer against throwaway settings files under a
# fake HOME + FLYWHEEL_STATE_DIR — the real user settings are never touched.
#   1. merge matrix: fresh / idempotent / converge a stale path / preserve the
#      real production PreToolUse sibling shape + other keys / uninstall removes
#      only our command and drops the emptied group / bad JSON → exit 2, file
#      untouched / --settings leaves the default file alone / paths with spaces.
#   2. lock matrix (<settings>.flywheel-lock, the claude-lead.sh protocol):
#      held lock → standalone waits then exits 3 without writing; stale (>60s)
#      lock is reclaimed; --lock-held without the lock dir is refused (exit 4);
#      --lock-held with the lock dir writes and leaves the lock in place;
#      launcher-writes-under-lock interleave keeps all three keys; concurrent
#      install + uninstall converge to a valid deterministic state.
#
# Usage: bash scripts/hooks/test-runner-msg-guard-install.sh
set -uo pipefail

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1: $2"; }

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="${HERE}/install-runner-msg-guard.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/fly3083 install.XXXXXX") # space on purpose
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
export FLYWHEEL_STATE_DIR="$TMP/state dir"
mkdir -p "$HOME"
unset LEAD_WORKSPACE
STABLE="$FLYWHEEL_STATE_DIR/bin/flywheel-runner-msg-guard.py"

run_installer() { bash "$INSTALLER" "$@" 2>/dev/null; }

# Our entries: every PreToolUse hook command mentioning the guard.
our_cmds() {
  jq -r '[.hooks.PreToolUse[]? | .hooks[]? | .command // "" | select(contains("flywheel-runner-msg-guard.py"))] | .[]' "$1"
}
our_count() { our_cmds "$1" | grep -c . ; }
our_matcher() {
  jq -r '[.hooks.PreToolUse[]? | select(any(.hooks[]?; (.command // "") | contains("flywheel-runner-msg-guard.py"))) | .matcher] | join(",")' "$1"
}

if [ ! -f "$INSTALLER" ]; then
  echo "FAIL: installer not found at $INSTALLER"
  exit 1
fi

echo "── merge matrix"
S="$TMP/ws one/.claude/settings.local.json"

# M1 fresh (settings file and its dir missing)
if run_installer --settings "$S" && [ "$(our_count "$S")" = "1" ] && [ "$(our_matcher "$S")" = "SendMessage" ]; then
  pass "M1 fresh install creates one SendMessage entry"
else
  fail "M1 fresh install" "$(cat "$S" 2>/dev/null)"
fi
if [ -x "$STABLE" ] && cmp -s "$STABLE" "$HERE/flywheel-runner-msg-guard.py"; then
  pass "M1 hook copied to the stable path"
else
  fail "M1 stable copy" "$STABLE"
fi
# The command must run the stable path even though it contains a space.
CMD_LINE=$(our_cmds "$S")
if printf '{"tool_name":"Bash","tool_input":{"command":"true"}}' | sh -c "$CMD_LINE" >/dev/null 2>&1; then
  pass "M1 command runs through sh despite a space in the path"
else
  fail "M1 command quoting" "$CMD_LINE"
fi

# M2 idempotent
BEFORE=$(cat "$S")
run_installer --settings "$S"
if [ "$(cat "$S")" = "$BEFORE" ]; then
  pass "M2 second install is byte-identical"
else
  fail "M2 idempotent" "$(cat "$S")"
fi

# M3 converge a stale path + preserve real production siblings + other keys
cat >"$S" <<'JSON'
{
  "enableAllProjectMcpServers": true,
  "permissions": {"allow": ["Bash(ls:*)"]},
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 /Users/x/.flywheel/bin/flywheel-restart-guard.py"}]},
      {"matcher": "SendMessage", "hooks": [
        {"type": "command", "command": "python3 /old/place/flywheel-runner-msg-guard.py"},
        {"type": "command", "command": "bash /Users/x/.claude/hooks/strategic-compact.sh"}
      ]},
      {"matcher": "mcp__xiaohongshu", "hooks": [{"type": "command", "command": "bash xhs-mcp-autostart.sh"}]}
    ],
    "Stop": [{"hooks": [{"type": "command", "command": "python3 discord-reply-enforcer.py"}]}]
  }
}
JSON
run_installer --settings "$S"
if [ "$(our_count "$S")" = "1" ] && ! grep -q "/old/place/" "$S" \
  && jq -e '.enableAllProjectMcpServers == true and .permissions.allow == ["Bash(ls:*)"]' "$S" >/dev/null \
  && jq -e '[.hooks.PreToolUse[].hooks[].command] | (index("python3 /Users/x/.flywheel/bin/flywheel-restart-guard.py") != null) and (index("bash /Users/x/.claude/hooks/strategic-compact.sh") != null) and (index("bash xhs-mcp-autostart.sh") != null)' "$S" >/dev/null \
  && jq -e '.hooks.Stop[0].hooks[0].command == "python3 discord-reply-enforcer.py"' "$S" >/dev/null; then
  pass "M3 stale path converged, siblings + other keys preserved"
else
  fail "M3 converge/preserve" "$(cat "$S")"
fi

# M4 uninstall removes only ours; the emptied group is dropped, a shared group kept
cat >"$TMP/only-ours.json" <<JSON
{"hooks":{"PreToolUse":[{"matcher":"SendMessage","hooks":[{"type":"command","command":"python3 '$STABLE'"}]},
 {"matcher":"Bash","hooks":[{"type":"command","command":"python3 /x/flywheel-restart-guard.py"}]}]}}
JSON
run_installer --settings "$TMP/only-ours.json" --uninstall
if [ "$(our_count "$TMP/only-ours.json")" = "0" ] \
  && jq -e '(.hooks.PreToolUse | length) == 1 and .hooks.PreToolUse[0].matcher == "Bash"' "$TMP/only-ours.json" >/dev/null; then
  pass "M4 uninstall drops our emptied group, keeps siblings"
else
  fail "M4 uninstall" "$(cat "$TMP/only-ours.json")"
fi
run_installer --settings "$S" --uninstall
if [ "$(our_count "$S")" = "0" ] && jq -e '[.hooks.PreToolUse[].hooks[].command] | index("bash /Users/x/.claude/hooks/strategic-compact.sh") != null' "$S" >/dev/null; then
  pass "M4 uninstall keeps a sibling sharing our matcher group"
else
  fail "M4 shared group" "$(cat "$S")"
fi
if [ -f "$STABLE" ]; then
  pass "M4 uninstall leaves the shared stable-path script in place"
else
  fail "M4 stable script" "deleted"
fi

# M5 bad JSON → exit 2, untouched
printf '{not json' >"$TMP/bad.json"
run_installer --settings "$TMP/bad.json"; rc=$?
if [ "$rc" = "2" ] && [ "$(cat "$TMP/bad.json")" = "{not json" ]; then
  pass "M5 bad JSON → exit 2, file untouched"
else
  fail "M5 bad JSON" "rc=$rc content=$(cat "$TMP/bad.json")"
fi

# M5b/M5c (code review R1 MEDIUM): a valid object followed by a broken tail, or
# several top-level values, is NOT one valid settings object — refuse (exit 2)
# and keep the exact bytes, for install AND uninstall.
printf '%s\n%s\n' '{"permissions":{"allow":["Bash(ls:*)"]}}' '{broken' >"$TMP/tail.json"
printf '%s\n%s\n' '{"a":1}' '{"b":2}' >"$TMP/multi.json"
printf '%s\n' '[{"a":1}]' >"$TMP/array.json"
for fx in tail multi array; do
  cp "$TMP/$fx.json" "$TMP/$fx.orig"
  for mode in install uninstall; do
    if [ "$mode" = "uninstall" ]; then
      run_installer --settings "$TMP/$fx.json" --uninstall; rc=$?
    else
      run_installer --settings "$TMP/$fx.json"; rc=$?
    fi
    if [ "$rc" = "2" ] && cmp -s "$TMP/$fx.json" "$TMP/$fx.orig"; then
      pass "M5 $fx.json $mode → exit 2, bytes unchanged"
    else
      fail "M5 $fx.json $mode" "rc=$rc content=$(cat "$TMP/$fx.json")"
    fi
  done
done

# M6 --settings custom file leaves the LEAD_WORKSPACE default untouched
mkdir -p "$TMP/ws two/.claude"
echo '{"keep":1}' >"$TMP/ws two/.claude/settings.local.json"
LEAD_WORKSPACE="$TMP/ws two" bash "$INSTALLER" --settings "$TMP/custom.json" 2>/dev/null
if [ "$(cat "$TMP/ws two/.claude/settings.local.json")" = '{"keep":1}' ] && [ "$(our_count "$TMP/custom.json")" = "1" ]; then
  pass "M6 --settings writes only the named file"
else
  fail "M6 custom path" "$(cat "$TMP/ws two/.claude/settings.local.json")"
fi
# default = $LEAD_WORKSPACE/.claude/settings.local.json
LEAD_WORKSPACE="$TMP/ws two" bash "$INSTALLER" 2>/dev/null
if [ "$(our_count "$TMP/ws two/.claude/settings.local.json")" = "1" ] \
  && jq -e '.keep == 1' "$TMP/ws two/.claude/settings.local.json" >/dev/null; then
  pass "M6 default target is the Lead workspace settings.local.json"
else
  fail "M6 default target" "$(cat "$TMP/ws two/.claude/settings.local.json")"
fi
# no --settings and no LEAD_WORKSPACE → refuse
bash "$INSTALLER" 2>/dev/null; rc=$?
if [ "$rc" = "1" ]; then
  pass "M6 no target → exit 1"
else
  fail "M6 no target" "rc=$rc"
fi
bash "$INSTALLER" --bogus 2>/dev/null; rc=$?
[ "$rc" = "1" ] && pass "M6 unknown flag → exit 1" || fail "M6 unknown flag" "rc=$rc"

echo "── lock matrix"
L="$TMP/lock ws/settings.local.json"
mkdir -p "$(dirname "$L")"
echo '{}' >"$L"

# K1 held lock → wait, then exit 3 without writing
mkdir "$L.flywheel-lock"
start=$(date +%s)
run_installer --settings "$L"; rc=$?
elapsed=$(($(date +%s) - start))
if [ "$rc" = "3" ] && [ "$(cat "$L")" = "{}" ] && [ "$elapsed" -ge 8 ] && [ -d "$L.flywheel-lock" ]; then
  pass "K1 lock held by another writer → waited ${elapsed}s, exit 3, no write, foreign lock kept"
else
  fail "K1 held lock" "rc=$rc elapsed=$elapsed content=$(cat "$L")"
fi
rmdir "$L.flywheel-lock"

# K2 stale lock (>60s) is reclaimed
mkdir "$L.flywheel-lock"
touch -t 202001010000 "$L.flywheel-lock"
run_installer --settings "$L"; rc=$?
if [ "$rc" = "0" ] && [ "$(our_count "$L")" = "1" ] && [ ! -d "$L.flywheel-lock" ]; then
  pass "K2 stale lock reclaimed, install done, lock released"
else
  fail "K2 stale lock" "rc=$rc"
fi

# K3 --lock-held without the lock dir → refused
echo '{}' >"$L"
run_installer --settings "$L" --lock-held; rc=$?
if [ "$rc" = "4" ] && [ "$(cat "$L")" = "{}" ]; then
  pass "K3 --lock-held without the lock dir → exit 4, no write"
else
  fail "K3 lock-held refusal" "rc=$rc"
fi

# K4 --lock-held with the lock dir → writes, leaves the caller's lock alone
mkdir "$L.flywheel-lock"
run_installer --settings "$L" --lock-held; rc=$?
if [ "$rc" = "0" ] && [ "$(our_count "$L")" = "1" ] && [ -d "$L.flywheel-lock" ]; then
  pass "K4 --lock-held writes under the caller's lock and does not release it"
else
  fail "K4 lock-held write" "rc=$rc"
fi
rmdir "$L.flywheel-lock"

# K5 controlled interleave: a launcher holds the lock and writes MCP pre-seed +
# a sibling hook while the standalone installer is already waiting; the
# installer must read the post-launcher snapshot → all three survive.
echo '{}' >"$L"
mkdir "$L.flywheel-lock"
run_installer --settings "$L" &
inst_pid=$!
sleep 1
jq '.enableAllProjectMcpServers = true
    | .hooks.PreToolUse = [{"matcher":"Bash","hooks":[{"type":"command","command":"python3 /x/flywheel-restart-guard.py"}]}]' \
  "$L" >"$L.tmp" && mv "$L.tmp" "$L"
rmdir "$L.flywheel-lock"
wait "$inst_pid"; rc=$?
if [ "$rc" = "0" ] && jq -e '.enableAllProjectMcpServers == true' "$L" >/dev/null \
  && [ "$(our_count "$L")" = "1" ] \
  && jq -e '[.hooks.PreToolUse[].hooks[].command] | index("python3 /x/flywheel-restart-guard.py") != null' "$L" >/dev/null; then
  pass "K5 launcher write under lock + waiting installer → all three kept"
else
  fail "K5 interleave" "rc=$rc $(cat "$L")"
fi

# K6 concurrent install + uninstall → valid JSON, deterministic end state, no lock left
for i in 1 2 3; do
  echo '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"sib.sh"}]}]}}' >"$L"
  run_installer --settings "$L" &
  p1=$!
  run_installer --settings "$L" --uninstall &
  p2=$!
  wait "$p1"; r1=$?
  wait "$p2"; r2=$?
  n=$(our_count "$L" 2>/dev/null)
  if [ "$r1" = "0" ] && [ "$r2" = "0" ] && jq -e . "$L" >/dev/null 2>&1 \
    && { [ "$n" = "0" ] || [ "$n" = "1" ]; } \
    && jq -e '[.hooks.PreToolUse[].hooks[].command] | index("sib.sh") != null' "$L" >/dev/null \
    && [ ! -d "$L.flywheel-lock" ]; then
    pass "K6.$i concurrent install+uninstall → valid, ours=$n, sibling kept, lock released"
  else
    fail "K6.$i concurrent" "r1=$r1 r2=$r2 n=$n $(cat "$L")"
  fi
done

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
