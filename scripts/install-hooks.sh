#!/bin/bash
set -euo pipefail
# Install the Flywheel SessionEnd hook into ~/.claude/settings.json.
#
# FLY-1389 P1-b: the pre-1389 version wrote THIS CHECKOUT's absolute path
# into the global settings hook command — run once from a worktree and the
# global config permanently referenced a directory that gets cleaned.
# Now:
#   (i)   refuse temp/worktree source checkouts BEFORE any global change;
#   (ii)  deploy a STABLE copy to ~/.flywheel/hooks/flywheel-session-end.sh
#         (atomic temp-write + chmod 0755 + rename — this script is the
#         deploy owner; Bridge's syncFlywheelHooks deliberately covers only
#         inbox-check.sh);
#   (iii) register the STABLE path in settings.json, REPLACING any legacy
#         checkout-path entry for the same hook (never both).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/path-hygiene.sh
source "$SCRIPT_DIR/lib/path-hygiene.sh"

SETTINGS="$HOME/.claude/settings.json"
HOOK_NAME="flywheel-session-end.sh"
HOOK_SOURCE="$SCRIPT_DIR/hooks/$HOOK_NAME"
HOOKS_DIR="$HOME/.flywheel/hooks"
STABLE_HOOK="$HOOKS_DIR/$HOOK_NAME"

# (i) temp/worktree source refusal — before ANY global write.
if is_temp_or_worktree_root "$REPO_ROOT"; then
  echo "ERROR: refusing to install global hooks from a temp/worktree checkout: $REPO_ROOT" >&2
  echo "  ~/.claude/settings.json must reference the stable ~/.flywheel/hooks copy" >&2
  echo "  deployed from the MAIN checkout (FLY-1389). Re-run from the main checkout." >&2
  exit 1
fi

[ -f "$HOOK_SOURCE" ] || { echo "ERROR: hook source missing: $HOOK_SOURCE" >&2; exit 1; }

# (ii) deploy the stable copy atomically (same-dir temp + chmod + rename so
# a concurrent SessionEnd invocation sees either the old or the new file).
mkdir -p "$HOOKS_DIR"
TMP_HOOK=$(mktemp "${STABLE_HOOK}.XXXXXX")
cp "$HOOK_SOURCE" "$TMP_HOOK"
chmod 0755 "$TMP_HOOK"
mv "$TMP_HOOK" "$STABLE_HOOK"

# (iii) merge settings.json (atomic write): remove ONLY
# flywheel-session-end.sh commands from each SessionEnd group (legacy
# checkout paths AND a prior stable entry — dedupe), PRESERVE sibling hooks
# in mixed groups, drop groups that became empty, then append exactly one
# stable-path entry (same fine-grained-merge pattern as
# scripts/hooks/install-restart-guard.sh; Codex code R1 MED-1: a group-level
# filter would delete unrelated SessionEnd siblings sharing a group).
if [ -f "$SETTINGS" ]; then
  # Validate existing JSON (validate file directly — pipe through echo can lose data)
  if ! jq empty "$SETTINGS" 2>/dev/null; then
    echo "ERROR: $SETTINGS is not valid JSON. Backup and fix manually." >&2
    exit 1
  fi
  EXISTING=$(cat "$SETTINGS")
else
  EXISTING="{}"
  mkdir -p "$(dirname "$SETTINGS")"
fi

TMPFILE=$(mktemp "${SETTINGS}.XXXXXX")
trap 'rm -f "$TMPFILE"' EXIT

echo "$EXISTING" | jq --arg cmd "$STABLE_HOOK" --arg name "/$HOOK_NAME" '
  .hooks.SessionEnd //= [] |
  .hooks.SessionEnd = ([ .hooks.SessionEnd[]
      | .hooks = ([ (.hooks // [])[]
          | select(((.command // "") | endswith($name)) | not) ])
    ] | map(select(((.hooks // []) | length) > 0))) |
  .hooks.SessionEnd += [{"hooks": [{"type": "command", "command": $cmd}]}]
' > "$TMPFILE"

# Validate output before atomic move
if ! jq empty "$TMPFILE" 2>/dev/null; then
  echo "ERROR: Generated settings JSON is invalid. Aborting." >&2
  exit 1
fi

mv "$TMPFILE" "$SETTINGS"
trap - EXIT
echo "Flywheel SessionEnd hook deployed to $STABLE_HOOK and registered (stable path) in $SETTINGS"
