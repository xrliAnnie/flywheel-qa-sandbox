#!/bin/bash
# lock.sh — mkdir-based cross-process locking (macOS compatible)
# Usage: source lock.sh (for scripts) or lock.sh acquire|release|wait <args> (CLI mode)

LOCK_DIR="${LOCK_DIR:-$HOME/.flywheel/orchestrator/locks}"

acquire_lock() {
    local lock_name="$1"
    local holder="$2"
    local lock_path="$LOCK_DIR/${lock_name}"

    mkdir -p "$LOCK_DIR"

    # mkdir is atomic — if it succeeds, we hold the lock
    if mkdir "$lock_path" 2>/dev/null; then
        echo "${holder} $(date +%s)" > "$lock_path/info"
        return 0
    fi
    return 1
}

release_lock() {
    local lock_name="$1"
    local lock_path="$LOCK_DIR/${lock_name}"

    rm -rf "$lock_path"
}

wait_for_lock() {
    local lock_name="$1"
    local holder="$2"
    local timeout="${3:-1800}"  # Default 30 min

    local start=$(date +%s)
    while ! acquire_lock "$lock_name" "$holder"; do
        local elapsed=$(( $(date +%s) - start ))
        if [ "$elapsed" -ge "$timeout" ]; then
            echo "ERROR: Timeout waiting for lock $lock_name (held by: $(cat "$LOCK_DIR/${lock_name}/info" 2>/dev/null))" >&2
            return 1
        fi
        sleep 10
    done
    return 0
}

# Wrapper: run a command while holding a lock
with_lock() {
    local lock_name="$1"
    local holder="$2"
    shift 2
    [ "$1" = "--" ] && shift

    wait_for_lock "$lock_name" "$holder" || return 1
    "$@"
    local exit_code=$?
    release_lock "$lock_name"
    return $exit_code
}

lock_holder() {
    local lock_name="$1"
    local info_file="$LOCK_DIR/${lock_name}/info"
    if [ -f "$info_file" ]; then
        cut -d' ' -f1 "$info_file"
    fi
}

lock_age() {
    local lock_name="$1"
    local info_file="$LOCK_DIR/${lock_name}/info"
    if [ -f "$info_file" ]; then
        local lock_time
        lock_time=$(cut -d' ' -f2 "$info_file")
        echo $(( $(date +%s) - lock_time ))
    else
        echo 0
    fi
}

# CLI dispatch (when invoked as standalone script, not sourced)
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    case "$1" in
        acquire)  acquire_lock "$2" "$3" ;;
        release)  release_lock "$2" ;;
        wait)     wait_for_lock "$2" "$3" "${4:-600}" ;;
        holder)   lock_holder "$2" ;;
        age)      lock_age "$2" ;;
        *)        echo "Usage: lock.sh {acquire|release|wait|holder|age} <args>" >&2; exit 1 ;;
    esac
fi
