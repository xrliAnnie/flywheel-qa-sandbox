#!/bin/bash
# FLY-3083: install / uninstall the flywheel-runner-msg-guard PreToolUse hook
# into ONE Lead's workspace-local settings.
#
# Target = <LEAD_WORKSPACE>/.claude/settings.local.json (override --settings).
# Lead-local, not the global ~/.claude/settings.json: a Lead runs with
# `cd "$LEAD_WORKSPACE"`, project-local hooks merge with user hooks, and each
# workspace has exactly one launcher writer — so a CLAUDE_CONFIG_DIR profile
# can't send the entry to the wrong file and no other global writer competes.
#
# Hook script: copied to <FLYWHEEL_STATE_DIR|~/.flywheel>/bin/ with mktemp + mv
# (atomic; another Lead never reads a half-written copy). --uninstall removes
# only this workspace's settings entry — the stable script may be referenced by
# other Leads and is left in place.
#
# Lock protocol (shared with claude-lead.sh's settings.local.json block): the
# read → merge → rename runs while holding the mkdir spinlock
# <settings>.flywheel-lock (stale after 60s, give up after 10s → exit 3, no
# write). claude-lead.sh already holds that lock when it calls us and passes
# --lock-held; we then require the lock dir to exist (refuse otherwise) and
# never release it. There is no lock-free writer.
#
# jq defenses inherited from install-restart-guard.sh: validity is judged by
# OUTPUT non-emptiness (macOS jq 1.6 exits 0 on parse errors); bad JSON → skip,
# file untouched; only our own command is removed from each group, siblings are
# kept, emptied groups dropped.
#
# Usage:
#   bash scripts/hooks/install-runner-msg-guard.sh [--settings <path>] [--uninstall] [--lock-held]
#
# Exit codes: 0 ok · 1 usage / missing prerequisite · 2 settings skipped
#             (invalid JSON) · 3 lock not acquired · 4 --lock-held without lock
set -euo pipefail

log() { echo "[install-runner-msg-guard] $*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_SCRIPT="${SCRIPT_DIR}/flywheel-runner-msg-guard.py"
STATE_BASE="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
HOOK_SCRIPT="${STATE_BASE}/bin/flywheel-runner-msg-guard.py"

SETTINGS_FILE=""
UNINSTALL=0
LOCK_HELD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --settings)
      [ $# -ge 2 ] || { log "ERROR: --settings needs a path"; exit 1; }
      SETTINGS_FILE="$2"
      shift 2
      ;;
    --uninstall) UNINSTALL=1; shift ;;
    --lock-held) LOCK_HELD=1; shift ;;
    *) log "ERROR: unknown flag '$1'"; exit 1 ;;
  esac
done

if [ -z "$SETTINGS_FILE" ]; then
  if [ -z "${LEAD_WORKSPACE:-}" ]; then
    log "ERROR: no target — pass --settings <path> or set LEAD_WORKSPACE"
    exit 1
  fi
  SETTINGS_FILE="${LEAD_WORKSPACE}/.claude/settings.local.json"
fi

if ! command -v jq >/dev/null 2>&1; then
  log "ERROR: jq not found in PATH"
  exit 1
fi

# POSIX single-quote the path so a space (or any shell metachar) in the state
# dir survives the `sh -c` the hook runner uses.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
CMD="python3 $(sq "$HOOK_SCRIPT")"

LOCK_DIR="${SETTINGS_FILE}.flywheel-lock"
OWN_LOCK=0
release_lock() {
  if [ "$OWN_LOCK" = "1" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    OWN_LOCK=0
  fi
}
trap release_lock EXIT

mkdir -p "$(dirname "$SETTINGS_FILE")"
if [ "$LOCK_HELD" = "1" ]; then
  if [ ! -d "$LOCK_DIR" ]; then
    log "ERROR: --lock-held but $LOCK_DIR does not exist (refusing a lock-free write)"
    exit 4
  fi
else
  # Same spinlock as claude-lead.sh: 50 × 0.2s, stale after 1 minute.
  for _i in $(seq 1 50); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      OWN_LOCK=1
      break
    fi
    if find "$LOCK_DIR" -maxdepth 0 -mmin +1 -print 2>/dev/null | grep -q .; then
      rmdir "$LOCK_DIR" 2>/dev/null || true
      log "removed stale lock dir $LOCK_DIR"
      continue
    fi
    sleep 0.2
  done
  if [ "$OWN_LOCK" != "1" ]; then
    log "ERROR: could not acquire $LOCK_DIR after 10s (another writer holds it); nothing written"
    exit 3
  fi
fi

# ── Read + validate (under the lock) ────────────────────────────────────────
EXISTING="{}"
if [ -f "$SETTINGS_FILE" ]; then
  EXISTING=$(cat "$SETTINGS_FILE")
  if [ -z "$(printf '%s' "$EXISTING" | jq -c . 2>/dev/null)" ]; then
    log "WARNING: $SETTINGS_FILE is not valid JSON. Skipping (file untouched)."
    exit 2
  fi
fi

# Remove ONLY runner-msg-guard commands (any path), keep siblings, drop
# emptied groups; install then appends one SendMessage entry.
STRIP_FILTER='
  .hooks = (.hooks // {}) |
  .hooks.PreToolUse = (if (.hooks.PreToolUse | type) == "array" then .hooks.PreToolUse else [] end) |
  .hooks.PreToolUse = ([ .hooks.PreToolUse[]
      | .hooks = ([ (.hooks // [])[]
          | select(((.command // "") | contains("flywheel-runner-msg-guard.py")) | not) ])
    ] | map(select(((.hooks // []) | length) > 0)))
'
INSTALL_FILTER="${STRIP_FILTER}"' |
  .hooks.PreToolUse += [{"matcher": "SendMessage", "hooks": [{"type": "command", "command": $cmd}]}]
'

write_settings() {
  # $1 = merged JSON. Never write an empty/invalid result.
  if [ -z "$1" ] || [ -z "$(printf '%s' "$1" | jq -c . 2>/dev/null)" ]; then
    log "WARNING: settings merge produced empty/invalid JSON. Skipping (file untouched)."
    exit 2
  fi
  local tmpfile
  tmpfile=$(mktemp "${SETTINGS_FILE}.XXXXXX")
  printf '%s\n' "$1" >"$tmpfile"
  mv "$tmpfile" "$SETTINGS_FILE"
}

if [ "$UNINSTALL" = "1" ]; then
  MERGED=$(printf '%s' "$EXISTING" | jq "$STRIP_FILTER" 2>/dev/null || true)
  write_settings "$MERGED"
  log "uninstalled: entry removed from $SETTINGS_FILE (siblings kept; $HOOK_SCRIPT left for other Leads)"
  exit 0
fi

if [ ! -f "$SRC_SCRIPT" ]; then
  log "ERROR: hook source not found: $SRC_SCRIPT"
  exit 1
fi
mkdir -p "$(dirname "$HOOK_SCRIPT")"
TMP_HOOK=$(mktemp "${HOOK_SCRIPT}.XXXXXX")
cp "$SRC_SCRIPT" "$TMP_HOOK"
chmod 755 "$TMP_HOOK"
mv "$TMP_HOOK" "$HOOK_SCRIPT"

MERGED=$(printf '%s' "$EXISTING" | jq --arg cmd "$CMD" "$INSTALL_FILTER" 2>/dev/null || true)
write_settings "$MERGED"
log "installed: $HOOK_SCRIPT + PreToolUse(SendMessage) entry in $SETTINGS_FILE"
exit 0
