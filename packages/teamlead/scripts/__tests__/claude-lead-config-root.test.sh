#!/usr/bin/env bash
# FLY-1439: launcher-managed agent identities and settings mutations must
# follow CLAUDE_CONFIG_DIR in isolated QA. Flywheel-owned hooks remain under
# ~/.flywheel; these two surfaces must not touch production ~/.claude.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="${SCRIPT_DIR}/../claude-lead.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INSTALLER="${REPO_ROOT}/scripts/hooks/install-restart-guard.sh"
PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }

SETTINGS_LINE='local settings_file="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/settings.json"'
if [[ "$(grep -cF "$SETTINGS_LINE" "$LAUNCHER")" == "2" ]]; then
  pass "both launcher settings writers use the resolved Claude config root"
else
  fail "launcher settings root" "expected two isolated-root settings writers"
fi

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1439-config-root.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
FAKE_HOME="$ROOT/home"
ISO="$ROOT/isolated"
mkdir -p "$FAKE_HOME/.claude" "$ISO"
printf '%s\n' '{"sentinel":"production-untouched"}' > "$FAKE_HOME/.claude/settings.json"
printf '%s\n' '{}' > "$ISO/settings.json"
BEFORE="$(shasum -a 256 "$FAKE_HOME/.claude/settings.json" | awk '{print $1}')"

if HOME="$FAKE_HOME" CLAUDE_CONFIG_DIR="$ISO" bash "$INSTALLER" >/dev/null 2>&1; then
  AFTER="$(shasum -a 256 "$FAKE_HOME/.claude/settings.json" | awk '{print $1}')"
  COUNT="$(jq '[.hooks.PreToolUse[]?.hooks[]? | select((.command // "") | endswith("flywheel-restart-guard.py"))] | length' "$ISO/settings.json")"
  if [[ "$BEFORE" == "$AFTER" && "$COUNT" == "1" ]]; then
    pass "restart-guard installer mutates isolated settings and leaves production sentinel byte-identical"
  else
    fail "restart-guard isolated target" "prod hash changed or isolated hook count=$COUNT"
  fi
else
  fail "restart-guard isolated target" "installer exited non-zero"
fi

echo
echo "[TEST] claude-lead-config-root: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
