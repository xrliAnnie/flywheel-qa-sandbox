#!/bin/bash
# Test the discord-reply-enforcer Stop-hook install jq merge (FLY-387).
# Covers the fine-grained .hooks.Stop merge from claude-lead.sh
# install_discord_reply_enforcer_hook(): idempotent, removes only enforcer
# commands, preserves sibling hooks in the same group, fail-open on bad JSON.
#
# Usage: bash scripts/hooks/test-reply-enforcer-install.sh
set -euo pipefail

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1: $2"; }

CMD="python3 ${HOME}/.flywheel/bin/discord-reply-enforcer.py"

# Canonical merge filter — MUST stay in sync with
# packages/teamlead/scripts/claude-lead.sh::install_discord_reply_enforcer_hook
FILTER='
  .hooks = (.hooks // {}) |
  .hooks.Stop = (if (.hooks.Stop | type) == "array" then .hooks.Stop else [] end) |
  .hooks.Stop = ([ .hooks.Stop[]
      | .hooks = ([ (.hooks // [])[]
          | select(((.command // "") | endswith("discord-reply-enforcer.py")) | not) ])
    ] | map(select(((.hooks // []) | length) > 0))) |
  if ([ .hooks.Stop[] | select(any((.hooks // [])[]; (.command // "") == $cmd)) ] | length) == 0
  then .hooks.Stop += [{"hooks": [{"type": "command", "command": $cmd}]}]
  else .
  end
'

merge() { jq --arg cmd "$CMD" "$FILTER"; }

# count Stop hook entries whose command ends with the enforcer script
count_enforcer() {
  jq '[.hooks.Stop[]?.hooks[]? | select((.command // "") | endswith("discord-reply-enforcer.py"))] | length'
}
has_cmd() { jq --arg c "$1" '[.hooks.Stop[]?.hooks[]? | select((.command // "") == $c)] | length'; }

# ── T13: idempotent — run twice, exactly one enforcer entry ────────────────
echo "T13: idempotent install"
OUT=$(echo '{}' | merge | merge)
N=$(echo "$OUT" | count_enforcer)
HASNEW=$(echo "$OUT" | has_cmd "$CMD")
if [ "$N" = "1" ] && [ "$HASNEW" = "1" ]; then pass "T13 exactly one enforcer after 2 runs"; else fail "T13" "n=$N hasnew=$HASNEW"; fi

# ── T14: old enforcer in its OWN Stop object → replaced ────────────────────
echo "T14: old enforcer in own object"
OLD='{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"python3 /Users/x/.claude/hooks/discord-reply-enforcer.py"}]}]}}'
OUT=$(echo "$OLD" | merge)
N=$(echo "$OUT" | count_enforcer)
HASOLD=$(echo "$OUT" | has_cmd "python3 /Users/x/.claude/hooks/discord-reply-enforcer.py")
HASNEW=$(echo "$OUT" | has_cmd "$CMD")
if [ "$N" = "1" ] && [ "$HASOLD" = "0" ] && [ "$HASNEW" = "1" ]; then pass "T14 old removed, stable added"; else fail "T14" "n=$N hasold=$HASOLD hasnew=$HASNEW"; fi

# ── T15: old enforcer + UNRELATED command in SAME group → sibling preserved ─
echo "T15: enforcer + sibling in same group"
MIXED='{"hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"python3 /Users/x/.claude/hooks/discord-reply-enforcer.py"},{"type":"command","command":"/Users/x/.claude/hooks/other-guard.sh"}]}]}}'
OUT=$(echo "$MIXED" | merge)
N=$(echo "$OUT" | count_enforcer)
HASOTHER=$(echo "$OUT" | jq '[.hooks.Stop[]?.hooks[]? | select((.command // "") == "/Users/x/.claude/hooks/other-guard.sh")] | length')
HASMATCHER=$(echo "$OUT" | jq '[.hooks.Stop[]? | select(.matcher == "*")] | length')
HASNEW=$(echo "$OUT" | has_cmd "$CMD")
if [ "$N" = "1" ] && [ "$HASOTHER" = "1" ] && [ "$HASMATCHER" = "1" ] && [ "$HASNEW" = "1" ]; then
  pass "T15 sibling + matcher group preserved, enforcer swapped"
else
  fail "T15" "n=$N hasother=$HASOTHER hasmatcher=$HASMATCHER hasnew=$HASNEW"
fi

# ── T15b: PostCompact / PreToolUse hooks must be untouched ─────────────────
echo "T15b: other hook events untouched"
OTHEREVENTS='{"hooks":{"PostCompact":[{"hooks":[{"type":"command","command":"x.sh"}]}],"Stop":[{"hooks":[{"type":"command","command":"python3 /old/discord-reply-enforcer.py"}]}]}}'
OUT=$(echo "$OTHEREVENTS" | merge)
PC=$(echo "$OUT" | jq '[.hooks.PostCompact[]?.hooks[]? | select((.command // "") == "x.sh")] | length')
if [ "$PC" = "1" ]; then pass "T15b PostCompact preserved"; else fail "T15b" "pc=$PC"; fi

# ── T16: malformed settings.json → output-based guard skips (fail-open) ────
# macOS jq 1.6 returns exit 0 even on parse errors, so the install validates by
# OUTPUT non-emptiness. A malformed input must yield empty merge output → skip.
echo "T16: malformed JSON fail-open (output-based guard)"
MERGED=$(printf '%s' '{ this is not json' | jq --arg cmd "$CMD" "$FILTER" 2>/dev/null)
PRECHECK=$(printf '%s' '{ this is not json' | jq -c . 2>/dev/null)
if [ -z "$MERGED" ] && [ -z "$PRECHECK" ]; then
  pass "T16 malformed input → empty merge + empty precheck → install skips (file untouched)"
else
  fail "T16" "merged='$MERGED' precheck='$PRECHECK' (expected both empty)"
fi

# ── T16b: valid input always yields non-empty parseable output ─────────────
echo "T16b: valid input yields non-empty output"
GOOD=$(printf '%s' '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"k.sh"}]}]}}' | jq --arg cmd "$CMD" "$FILTER" 2>/dev/null)
KEEP=$(printf '%s' "$GOOD" | jq '[.hooks.PreToolUse[]?.hooks[]? | select((.command // "")=="k.sh")] | length')
if [ -n "$GOOD" ] && [ "$KEEP" = "1" ]; then pass "T16b valid merge non-empty, PreToolUse preserved"; else fail "T16b" "good='$GOOD' keep=$KEEP"; fi

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
