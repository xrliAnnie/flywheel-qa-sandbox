#!/usr/bin/env bash
# FLY-1439: an isolated CLAUDE_CONFIG_DIR must not make the launcher write the
# synced Lead identity into production ~/.claude/agents.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="${SCRIPT_DIR}/../claude-lead.sh"
PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1439-agent-target.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

BLOCK="$(awk '
  /^(CLAUDE_AGENT_ROOT|AGENT_TARGET)=/ { in_block = 1 }
  in_block { print }
  in_block && /^mkdir -p .*agents/ { exit }
' "$LAUNCHER")"

resolve_target() {
  local home="$1" config="$2"
  HOME="$home" CLAUDE_CONFIG_DIR="$config" LEAD_ID="qa-lead" \
    bash -c "$BLOCK"$'\n''printf "%s\n" "$AGENT_TARGET"'
}

DEFAULT="$(resolve_target "$ROOT/home" '')"
if [[ "$DEFAULT" == "$ROOT/home/.claude/agents/qa-lead.md" ]]; then
  pass "unset config preserves production ~/.claude/agents target"
else
  fail "default target" "got $DEFAULT"
fi

ISOLATED="$(resolve_target "$ROOT/home" "$ROOT/isolated-config")"
if [[ "$ISOLATED" == "$ROOT/isolated-config/agents/qa-lead.md" ]]; then
  pass "isolated config routes agent identity under the isolated root"
else
  fail "isolated target" "got $ISOLATED"
fi

echo
echo "[TEST] claude-lead-agent-target: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
