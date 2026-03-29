#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"
source "$SCRIPT_DIR/state.sh"

AGENT_ID="${1:?Usage: cleanup-agent.sh <agent_id> [terminal_status]}"
TERMINAL_STATUS="${2:-completed}"

# 1. Update status (terminal states are immutable — safe to call multiple times)
state_critical update_agent_status "$AGENT_ID" "$TERMINAL_STATUS"

# 2. Get agent info from DB
agent_info=$(_sql "SELECT branch, worktree_path FROM agents WHERE id='$(sql_escape "$AGENT_ID")';")
agent_branch=$(echo "$agent_info" | cut -d'|' -f1)
agent_worktree=$(echo "$agent_info" | cut -d'|' -f2)

# 3. Remove worktree (macOS-safe: rename → prune → background rm)
if [ -n "$agent_worktree" ]; then
    if [ -d "$agent_worktree" ]; then
        tmp_path="${agent_worktree}.removing.$$"
        if mv "$agent_worktree" "$tmp_path" 2>/dev/null; then
            git -C "$PROJECT_ROOT" worktree prune 2>/dev/null || true
            rm -rf "$tmp_path" &
        else
            echo "WARNING: Could not rename worktree $agent_worktree for removal" >&2
        fi
    else
        # Worktree directory already gone — just prune stale references
        git -C "$PROJECT_ROOT" worktree prune 2>/dev/null || true
    fi
fi

# 4. Delete branch (only suppress "not found" errors)
if [ -n "$agent_branch" ]; then
    delete_output=$(git -C "$PROJECT_ROOT" branch -D "$agent_branch" 2>&1) || {
        if echo "$delete_output" | grep -q "not found"; then
            : # Branch already deleted (by PR merge or manual cleanup) — idempotent
        else
            echo "WARNING: git branch -D $agent_branch failed: $delete_output" >&2
        fi
    }
fi

# 5. Release any locks held by this agent
for lock_name in docs-update version-bump; do
    held_by=$(lock_holder "$lock_name")
    if [ "$held_by" = "$AGENT_ID" ]; then
        release_lock "$lock_name"
    fi
done

# 6. Sound notification
afplay /System/Library/Sounds/Funk.aiff &>/dev/null &
