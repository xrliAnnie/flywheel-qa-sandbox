#!/bin/bash
# config.sh — Flywheel orchestrator configuration

# Paths (derived from script location — works from any checkout)
ORCHESTRATOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$ORCHESTRATOR_DIR/../.." && pwd)"

# Shared state (outside repo tree — shared across all worktrees)
# Allow env override for testing with temporary directories
SHARED_STATE_DIR="${SHARED_STATE_DIR:-$HOME/.flywheel/orchestrator}"
DB_PATH="${DB_PATH:-$SHARED_STATE_DIR/agent-state.db}"
LOCK_DIR="${LOCK_DIR:-$SHARED_STATE_DIR/locks}"

# Doc paths (flat structure, no domain subdirs)
PLAN_NEW="$PROJECT_ROOT/doc/engineer/plan/new"
PLAN_DRAFT="$PROJECT_ROOT/doc/engineer/plan/draft"
PLAN_INPROGRESS="$PROJECT_ROOT/doc/engineer/plan/inprogress"
PLAN_ARCHIVE="$PROJECT_ROOT/doc/engineer/plan/archive"
EXPLORATION_NEW="$PROJECT_ROOT/doc/engineer/exploration/new"
EXPLORATION_ARCHIVE="$PROJECT_ROOT/doc/engineer/exploration/archive"
RESEARCH_NEW="$PROJECT_ROOT/doc/engineer/research/new"
RESEARCH_ARCHIVE="$PROJECT_ROOT/doc/engineer/research/archive"

# Limits
MAX_CONCURRENT_AGENTS=5
DOCS_LOCK_TIMEOUT=120                    # 2 min
RECONCILE_INTERVAL=300                   # 5 min

# Dashboard
DASHBOARD_PORT=9474

# Claude
CLAUDE_MODEL="opus"

# Lock functions (must be after LOCK_DIR is set)
source "$ORCHESTRATOR_DIR/lock.sh"

# Version management
VERSION_FILE="$PROJECT_ROOT/doc/VERSION"

get_current_version() {
    if [ -f "$VERSION_FILE" ]; then
        cat "$VERSION_FILE"
        return
    fi
    echo "ERROR: VERSION file not found at $VERSION_FILE" >&2
    return 1
}

# Alias for backwards compatibility
get_feature_version() { get_current_version; }

# Compute next minor version WITHOUT writing to VERSION file.
# Use this at sprint start to get the version for branch/plan naming.
# Only call bump_feature_version during ship phase to actually write.
compute_next_version() {
    local current
    current=$(get_current_version) || return 1
    local major minor patch
    IFS='.' read -r major minor patch <<< "${current#v}"
    echo "v${major}.$((minor + 1)).0"
}

bump_feature_version() {
    local type="$1"  # "minor" or "patch"

    # Reclaim stale lock (>60s = holder crashed)
    local age
    age=$(lock_age "version-bump")
    if [ "$age" -gt 60 ]; then
        echo "WARNING: version-bump lock stale (${age}s, holder: $(lock_holder "version-bump")). Reclaiming." >&2
        release_lock "version-bump"
    fi

    # Wait for lock (blocks up to 30s, polls every 1s)
    local _vb_start _vb_elapsed
    _vb_start=$(date +%s)
    while ! acquire_lock "version-bump" "${AGENT_ID:-orchestrator}"; do
        _vb_elapsed=$(( $(date +%s) - _vb_start ))
        if [ "$_vb_elapsed" -ge 30 ]; then
            echo "ERROR: Could not acquire version-bump lock after 30s" >&2
            return 1
        fi
        sleep 1
    done

    if [ ! -f "$VERSION_FILE" ]; then
        mkdir -p "$(dirname "$VERSION_FILE")"
        echo "v1.16.0" > "$VERSION_FILE"
        release_lock "version-bump"
        echo "v1.16.0"
        return
    fi

    local current
    current=$(cat "$VERSION_FILE")
    local major minor patch
    IFS='.' read -r major minor patch <<< "${current#v}"
    case "$type" in
        minor) minor=$((minor + 1)); patch=0 ;;
        patch) patch=$((patch + 1)) ;;
    esac
    local next="v${major}.${minor}.${patch}"
    local tmpfile="${VERSION_FILE}.tmp.$$"
    echo "$next" > "$tmpfile"
    if ! mv "$tmpfile" "$VERSION_FILE"; then
        echo "ERROR: Failed to write VERSION file" >&2
        rm -f "$tmpfile"
        release_lock "version-bump"
        return 1
    fi
    release_lock "version-bump"
    echo "$next"
}
