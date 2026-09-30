#!/bin/bash
# FLY-3083 (code review R2): the REAL claude-lead.sh settings.local lock block,
# non-dry, with the REAL install-runner-msg-guard.sh (--lock-held).
#
# The block is extracted verbatim from claude-lead.sh (from the
# `_SETTINGS_LOCAL_JSON=` assignment to the `fi` closing its `command -v jq`
# guard) and run in isolation — the full launcher would start tmux / claude.
# Asserts:
#   - missing file → created, enableAllProjectMcpServers=true + one
#     PreToolUse(SendMessage) guard entry, lock released;
#   - one valid object → both keys added, existing keys kept;
#   - NOT exactly one JSON object (valid head + broken tail, several top-level
#     values, an array, garbage) → bytes unchanged (neither the MCP pre-seed nor
#     the guard install writes), installer not called, WARN logged, lock released.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEAD_SH="$(cd "${SCRIPT_DIR}/.." && pwd)/claude-lead.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INSTALLER="${REPO_ROOT}/scripts/hooks/install-runner-msg-guard.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not in PATH" >&2; exit 0; }

BLOCK="$(awk '
  /^_SETTINGS_LOCAL_JSON="\$\{LEAD_WORKSPACE\}\/\.claude\/settings\.local\.json"$/ { on = 1 }
  on { print }
  on && /^fi$/ { exit }
' "$LEAD_SH")"
if [ -z "$BLOCK" ] || ! printf '%s\n' "$BLOCK" | grep -q 'install_runner_msg_guard_hook'; then
  echo "FAIL: could not extract the settings.local lock block from claude-lead.sh"
  exit 1
fi

T=$(mktemp -d "/tmp/fly3083-lockblock.XXXXXX")
trap 'rm -rf "$T"' EXIT

# run_block <workspace> → stdout = the block's log lines
run_block() {
  local ws="$1"
  LEAD_WORKSPACE="$ws" FLYWHEEL_STATE_DIR="$T/state" INSTALLER="$INSTALLER" CALLS="$T/calls" \
  bash -c '
    set -euo pipefail
    log() { echo "[lead] $*"; }
    install_runner_msg_guard_hook() {
      echo "$1" >> "$CALLS"
      bash "$INSTALLER" --settings "$1" --lock-held >/dev/null 2>&1 || log "WARNING: installer failed"
    }
    '"$BLOCK"'
  ' 2>&1
}
guard_count() { jq '[.hooks.PreToolUse[]? | select(.matcher == "SendMessage") | .hooks[]? | select((.command // "") | contains("flywheel-runner-msg-guard.py"))] | length' "$1"; }

# ── missing file
WS="$T/ws-missing"; mkdir -p "$WS"; : > "$T/calls"
run_block "$WS" >/dev/null
S="$WS/.claude/settings.local.json"
if [ -f "$S" ] && jq -e '.enableAllProjectMcpServers == true' "$S" >/dev/null && [ "$(guard_count "$S")" = "1" ] \
   && [ ! -d "$S.flywheel-lock" ]; then
  ok "missing file → created with MCP pre-seed + one guard entry, lock released"
else
  bad "missing file: $(cat "$S" 2>/dev/null)"
fi

# ── one valid object
WS="$T/ws-valid"; mkdir -p "$WS/.claude"; : > "$T/calls"
echo '{"keep":{"x":1}}' > "$WS/.claude/settings.local.json"
run_block "$WS" >/dev/null
S="$WS/.claude/settings.local.json"
if jq -e '.keep.x == 1 and .enableAllProjectMcpServers == true' "$S" >/dev/null && [ "$(guard_count "$S")" = "1" ] \
   && [ ! -d "$S.flywheel-lock" ]; then
  ok "valid object → both keys added, existing keys kept, lock released"
else
  bad "valid object: $(cat "$S")"
fi

# ── not exactly one object → untouched
i=0
for content in '{"permissions":{"allow":["Bash(ls:*)"]}}
{broken' '{"a":1}
{"b":2}' '[{"a":1}]' 'not json at all'; do
  i=$((i+1))
  WS="$T/ws-bad-$i"; mkdir -p "$WS/.claude"; : > "$T/calls"
  S="$WS/.claude/settings.local.json"
  printf '%s\n' "$content" > "$S"; cp "$S" "$T/orig-$i"
  out=$(run_block "$WS")
  if cmp -s "$S" "$T/orig-$i" && [ ! -s "$T/calls" ] && [ ! -d "$S.flywheel-lock" ] \
     && printf '%s' "$out" | grep -q "not exactly one JSON object"; then
    ok "invalid settings #$i → bytes unchanged, no installer call, WARN, lock released"
  else
    bad "invalid settings #$i: calls=$(cat "$T/calls") lock=$([ -d "$S.flywheel-lock" ] && echo held || echo free) now=$(cat "$S") out=$out"
  fi
done

echo
echo "FLY-3083 settings lock block: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
