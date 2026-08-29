#!/bin/bash
# FLY-913: install / uninstall the flywheel-restart-guard PreToolUse hook.
#
# Tier-1 deploy (zero service restarts): cp the hook to ~/.flywheel/bin and
# jq-merge one PreToolUse entry (matcher "Bash") into ~/.claude/settings.json.
# The hook file is read per-invocation, so a later update = re-run this script
# (or wait for claude-lead.sh, which converges it on every Lead start).
#
# Usage:
#   bash scripts/hooks/install-restart-guard.sh              # install/converge
#   bash scripts/hooks/install-restart-guard.sh --uninstall  # remove hook + entry
#
# jq-merge defenses are inherited verbatim from the discord-reply-enforcer
# precedent (claude-lead.sh::install_discord_reply_enforcer_hook):
#   • macOS jq 1.6 returns exit 0 on parse errors — validity is judged by
#     OUTPUT non-emptiness, never exit code;
#   • malformed settings.json → skip, file untouched (exit 2, fail-loud for a
#     standalone run; claude-lead.sh treats any failure as a non-fatal WARN);
#   • fine-grained merge: removes ONLY flywheel-restart-guard.py commands from
#     each PreToolUse group, PRESERVES sibling hooks, drops emptied groups;
#   • mktemp + mv atomic write.
#
# Exit codes: 0 ok · 1 missing prerequisite (jq/source) · 2 settings skipped
set -euo pipefail

log() { echo "[install-restart-guard] $*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_SCRIPT="${SCRIPT_DIR}/flywheel-restart-guard.py"
HOOK_SCRIPT="${HOME}/.flywheel/bin/flywheel-restart-guard.py"
SETTINGS_FILE="${HOME}/.claude/settings.json"
CMD="python3 ${HOOK_SCRIPT}"

UNINSTALL=0
if [ "${1:-}" = "--uninstall" ]; then
  UNINSTALL=1
elif [ -n "${1:-}" ]; then
  log "ERROR: unknown flag '$1' (only --uninstall is supported)"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  log "ERROR: jq not found in PATH"
  exit 1
fi

# ── Read + validate current settings (output-based check, jq 1.6 safe) ──────
EXISTING="{}"
if [ -f "$SETTINGS_FILE" ]; then
  EXISTING=$(cat "$SETTINGS_FILE")
  if [ -z "$(printf '%s' "$EXISTING" | jq -c . 2>/dev/null)" ]; then
    log "WARNING: $SETTINGS_FILE is not valid JSON. Skipping settings merge (file untouched)."
    exit 2
  fi
fi

# Canonical merge filters — the install/uninstall test matrix
# (scripts/hooks/test-restart-guard-install.sh) exercises these same filters.
INSTALL_FILTER='
  .hooks = (.hooks // {}) |
  .hooks.PreToolUse = (if (.hooks.PreToolUse | type) == "array" then .hooks.PreToolUse else [] end) |
  # Remove ONLY flywheel-restart-guard.py commands from each group; keep
  # sibling hooks; drop groups that become empty.
  .hooks.PreToolUse = ([ .hooks.PreToolUse[]
      | .hooks = ([ (.hooks // [])[]
          | select(((.command // "") | endswith("flywheel-restart-guard.py")) | not) ])
    ] | map(select(((.hooks // []) | length) > 0))) |
  # Add the stable-path entry (matcher Bash) if not already present.
  if ([ .hooks.PreToolUse[] | select(any((.hooks // [])[]; (.command // "") == $cmd)) ] | length) == 0
  then .hooks.PreToolUse += [{"matcher": "Bash", "hooks": [{"type": "command", "command": $cmd}]}]
  else .
  end
'

UNINSTALL_FILTER='
  .hooks = (.hooks // {}) |
  .hooks.PreToolUse = (if (.hooks.PreToolUse | type) == "array" then .hooks.PreToolUse else [] end) |
  .hooks.PreToolUse = ([ .hooks.PreToolUse[]
      | .hooks = ([ (.hooks // [])[]
          | select(((.command // "") | endswith("flywheel-restart-guard.py")) | not) ])
    ] | map(select(((.hooks // []) | length) > 0)))
'

write_settings() {
  # $1 = merged JSON. Fail-open: never write an empty/invalid result.
  if [ -z "$1" ] || [ -z "$(printf '%s' "$1" | jq -c . 2>/dev/null)" ]; then
    log "WARNING: settings merge produced empty/invalid JSON. Skipping (file untouched)."
    exit 2
  fi
  mkdir -p "$(dirname "$SETTINGS_FILE")"
  local tmpfile
  tmpfile=$(mktemp "${SETTINGS_FILE}.XXXXXX")
  printf '%s\n' "$1" > "$tmpfile"
  mv "$tmpfile" "$SETTINGS_FILE"
}

if [ "$UNINSTALL" = "1" ]; then
  MERGED=$(printf '%s' "$EXISTING" | jq "$UNINSTALL_FILTER" 2>/dev/null)
  write_settings "$MERGED"
  rm -f "$HOOK_SCRIPT"
  log "uninstalled: settings entry removed (siblings preserved), $HOOK_SCRIPT deleted"
  exit 0
fi

if [ ! -f "$SRC_SCRIPT" ]; then
  log "ERROR: hook source not found: $SRC_SCRIPT"
  exit 1
fi

mkdir -p "$(dirname "$HOOK_SCRIPT")"
cp "$SRC_SCRIPT" "$HOOK_SCRIPT"
chmod +x "$HOOK_SCRIPT"

MERGED=$(printf '%s' "$EXISTING" | jq --arg cmd "$CMD" "$INSTALL_FILTER" 2>/dev/null)
write_settings "$MERGED"
log "installed: $HOOK_SCRIPT + PreToolUse(Bash) entry in $SETTINGS_FILE"
exit 0
