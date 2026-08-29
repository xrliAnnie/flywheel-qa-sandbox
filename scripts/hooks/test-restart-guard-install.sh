#!/bin/bash
# Test the flywheel-restart-guard PreToolUse install/uninstall (FLY-913).
#
# Two layers:
#   1. jq merge filter matrix (mirrors test-reply-enforcer-install.sh):
#      idempotent, removes only guard commands, preserves sibling hooks
#      (incl. the REAL production PreToolUse shape: strategic-compact +
#      xhs-mcp-autostart entries), fail-open on bad JSON.
#   2. End-to-end runs of install-restart-guard.sh against a fake HOME:
#      install, converge, uninstall, bad-JSON skip (file untouched).
#
# Usage: bash scripts/hooks/test-restart-guard-install.sh
set -euo pipefail

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1: $2"; }

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="${HERE}/install-restart-guard.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/fly913-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

CMD="python3 ${HOME}/.flywheel/bin/flywheel-restart-guard.py"

# Canonical merge filter — MUST stay in sync with
# scripts/hooks/install-restart-guard.sh::INSTALL_FILTER
FILTER='
  .hooks = (.hooks // {}) |
  .hooks.PreToolUse = (if (.hooks.PreToolUse | type) == "array" then .hooks.PreToolUse else [] end) |
  .hooks.PreToolUse = ([ .hooks.PreToolUse[]
      | .hooks = ([ (.hooks // [])[]
          | select(((.command // "") | endswith("flywheel-restart-guard.py")) | not) ])
    ] | map(select(((.hooks // []) | length) > 0))) |
  if ([ .hooks.PreToolUse[] | select(any((.hooks // [])[]; (.command // "") == $cmd)) ] | length) == 0
  then .hooks.PreToolUse += [{"matcher": "Bash", "hooks": [{"type": "command", "command": $cmd}]}]
  else .
  end
'

merge() { jq --arg cmd "$CMD" "$FILTER"; }

count_guard() {
  jq '[.hooks.PreToolUse[]?.hooks[]? | select((.command // "") | endswith("flywheel-restart-guard.py"))] | length'
}
has_cmd() { jq --arg c "$1" '[.hooks.PreToolUse[]?.hooks[]? | select((.command // "") == $c)] | length'; }

# ── T1: idempotent — run twice, exactly one guard entry, matcher Bash ────────
echo "T1: idempotent install"
OUT=$(echo '{}' | merge | merge)
N=$(echo "$OUT" | count_guard)
MATCHER=$(echo "$OUT" | jq -r '[.hooks.PreToolUse[]? | select(any((.hooks // [])[]; (.command // "") | endswith("flywheel-restart-guard.py")))][0].matcher')
if [ "$N" = "1" ] && [ "$MATCHER" = "Bash" ]; then pass "T1 exactly one guard entry, matcher=Bash"; else fail "T1" "n=$N matcher=$MATCHER"; fi

# ── T2: old-path guard in its OWN group → replaced by stable path ────────────
echo "T2: old guard entry replaced"
OLD='{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"python3 /Users/x/.claude/hooks/flywheel-restart-guard.py"}]}]}}'
OUT=$(echo "$OLD" | merge)
N=$(echo "$OUT" | count_guard)
HASOLD=$(echo "$OUT" | has_cmd "python3 /Users/x/.claude/hooks/flywheel-restart-guard.py")
HASNEW=$(echo "$OUT" | has_cmd "$CMD")
if [ "$N" = "1" ] && [ "$HASOLD" = "0" ] && [ "$HASNEW" = "1" ]; then pass "T2 old removed, stable added"; else fail "T2" "n=$N hasold=$HASOLD hasnew=$HASNEW"; fi

# ── T3: REAL production PreToolUse shape → siblings preserved verbatim ───────
echo "T3: production siblings (strategic-compact + xhs) preserved"
PROD='{"hooks":{"PreToolUse":[
  {"matcher":"Edit || Write","hooks":[{"type":"command","command":"/Users/x/.claude/plugins/cache/everything-claude-code/skills/strategic-compact/suggest-compact.sh","timeout":5}]},
  {"matcher":"mcp__xiaohongshu*","hooks":[{"type":"command","command":"/Users/x/.claude/hooks/xhs-mcp-autostart.sh","timeout":10}]}
]}}'
OUT=$(echo "$PROD" | merge)
SC=$(echo "$OUT" | jq '[.hooks.PreToolUse[]?.hooks[]? | select((.command // "") | endswith("suggest-compact.sh"))] | length')
XHS=$(echo "$OUT" | jq '[.hooks.PreToolUse[]?.hooks[]? | select((.command // "") | endswith("xhs-mcp-autostart.sh"))] | length')
SCTIMEOUT=$(echo "$OUT" | jq '[.hooks.PreToolUse[]?.hooks[]? | select((.command // "") | endswith("suggest-compact.sh"))][0].timeout')
MATCHERS=$(echo "$OUT" | jq -r '[.hooks.PreToolUse[].matcher] | sort | join(",")')
HASNEW=$(echo "$OUT" | has_cmd "$CMD")
if [ "$SC" = "1" ] && [ "$XHS" = "1" ] && [ "$SCTIMEOUT" = "5" ] && [ "$HASNEW" = "1" ] \
  && [ "$MATCHERS" = "Bash,Edit || Write,mcp__xiaohongshu*" ]; then
  pass "T3 both prod siblings intact (matchers + timeout), guard appended"
else
  fail "T3" "sc=$SC xhs=$XHS timeout=$SCTIMEOUT hasnew=$HASNEW matchers=$MATCHERS"
fi

# ── T4: guard + sibling in SAME group → sibling survives, guard swapped ──────
echo "T4: same-group sibling preserved"
MIXED='{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"python3 /old/flywheel-restart-guard.py"},{"type":"command","command":"/Users/x/other-guard.sh"}]}]}}'
OUT=$(echo "$MIXED" | merge)
N=$(echo "$OUT" | count_guard)
HASOTHER=$(echo "$OUT" | has_cmd "/Users/x/other-guard.sh")
if [ "$N" = "1" ] && [ "$HASOTHER" = "1" ]; then pass "T4 sibling kept, guard swapped"; else fail "T4" "n=$N hasother=$HASOTHER"; fi

# ── T5: other hook events (Stop etc.) untouched ──────────────────────────────
echo "T5: other hook events untouched"
OTHER='{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"python3 /Users/x/.flywheel/bin/discord-reply-enforcer.py"}]}]}}'
OUT=$(echo "$OTHER" | merge)
STOPN=$(echo "$OUT" | jq '[.hooks.Stop[]?.hooks[]? | select((.command // "") | endswith("discord-reply-enforcer.py"))] | length')
if [ "$STOPN" = "1" ]; then pass "T5 Stop hooks preserved"; else fail "T5" "stopn=$STOPN"; fi

# ── T6: malformed settings.json → empty merge output (fail-open signal) ──────
echo "T6: malformed JSON fail-open (output-based guard)"
# NOTE: newer jq exits non-zero on parse errors (macOS jq 1.6 exits 0) —
# `|| true` keeps this matrix runnable on both; the installer's guard is
# OUTPUT-emptiness either way.
MERGED=$(printf '%s' '{ this is not json' | jq --arg cmd "$CMD" "$FILTER" 2>/dev/null || true)
PRECHECK=$(printf '%s' '{ this is not json' | jq -c . 2>/dev/null || true)
if [ -z "$MERGED" ] && [ -z "$PRECHECK" ]; then
  pass "T6 malformed input → empty merge + empty precheck → install skips"
else
  fail "T6" "merged='$MERGED' precheck='$PRECHECK'"
fi

# ═════ End-to-end: run the real installer against a fake HOME ════════════════
run_installer() { HOME="$FAKE_HOME" bash "$INSTALLER" "$@" 2>/dev/null; }

# ── T7: fresh install — bin file + settings entry ────────────────────────────
echo "T7: e2e fresh install"
FAKE_HOME="$TMP/home-fresh"
mkdir -p "$FAKE_HOME"
FCMD="python3 ${FAKE_HOME}/.flywheel/bin/flywheel-restart-guard.py"
if run_installer; then
  BIN="$FAKE_HOME/.flywheel/bin/flywheel-restart-guard.py"
  N=$(HOME="$FAKE_HOME" jq --arg c "$FCMD" '[.hooks.PreToolUse[]?.hooks[]? | select((.command // "") == $c)] | length' "$FAKE_HOME/.claude/settings.json")
  if [ -x "$BIN" ] && [ "$N" = "1" ]; then pass "T7 bin deployed + settings entry added"; else fail "T7" "bin-x=$([ -x "$BIN" ] && echo y || echo n) n=$N"; fi
else
  fail "T7" "installer exited non-zero"
fi

# ── T8: converge — second run stays at exactly one entry ─────────────────────
echo "T8: e2e converge (idempotent)"
run_installer
N=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select((.command // "") | endswith("flywheel-restart-guard.py"))] | length' "$FAKE_HOME/.claude/settings.json")
if [ "$N" = "1" ]; then pass "T8 still exactly one entry"; else fail "T8" "n=$N"; fi

# ── T9: uninstall — entry gone, siblings intact, bin removed ─────────────────
echo "T9: e2e uninstall"
FAKE_HOME="$TMP/home-uninst"
mkdir -p "$FAKE_HOME/.claude"
printf '%s' '{"hooks":{"PreToolUse":[{"matcher":"Edit || Write","hooks":[{"type":"command","command":"/x/suggest-compact.sh"}]}]}}' > "$FAKE_HOME/.claude/settings.json"
run_installer
run_installer --uninstall
N=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select((.command // "") | endswith("flywheel-restart-guard.py"))] | length' "$FAKE_HOME/.claude/settings.json")
SIB=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select((.command // "") == "/x/suggest-compact.sh")] | length' "$FAKE_HOME/.claude/settings.json")
BIN="$FAKE_HOME/.flywheel/bin/flywheel-restart-guard.py"
if [ "$N" = "0" ] && [ "$SIB" = "1" ] && [ ! -f "$BIN" ]; then
  pass "T9 entry removed, sibling intact, bin deleted"
else
  fail "T9" "n=$N sib=$SIB bin-exists=$([ -f "$BIN" ] && echo y || echo n)"
fi

# ── T10: uninstall on a never-installed HOME → no-op success ─────────────────
echo "T10: e2e uninstall no-op"
FAKE_HOME="$TMP/home-noop"
mkdir -p "$FAKE_HOME"
if run_installer --uninstall; then pass "T10 no-op uninstall succeeds"; else fail "T10" "exit non-zero"; fi

# ── T11: bad settings JSON → installer skips, file byte-untouched ────────────
echo "T11: e2e bad JSON skip"
FAKE_HOME="$TMP/home-bad"
mkdir -p "$FAKE_HOME/.claude"
printf '{ this is not json' > "$FAKE_HOME/.claude/settings.json"
BEFORE=$(cat "$FAKE_HOME/.claude/settings.json")
if run_installer; then
  fail "T11" "installer exited 0 on malformed settings (expected skip exit 2)"
else
  AFTER=$(cat "$FAKE_HOME/.claude/settings.json")
  if [ "$BEFORE" = "$AFTER" ]; then pass "T11 malformed settings untouched + non-zero exit"; else fail "T11" "file was modified"; fi
fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
