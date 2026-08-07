#!/usr/bin/env bash

# Shared production-Bridge process targeting. Callers provide BRIDGE_URL and may
# override the three underscore-prefixed seams in hermetic tests.

bridge_port() {
    local p
    p="$(printf '%s' "${BRIDGE_URL:-http://localhost:9876}" | sed -E 's#^.*:([0-9]+).*$#\1#')"
    if [[ "$p" =~ ^[0-9]+$ ]]; then printf '%s\n' "$p"; else printf '9876\n'; fi
}

_listeners_on_port() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }
_ppid_of()           { ps -o ppid= -p "$1" 2>/dev/null | tr -dc '0-9'; }
_args_of()           { ps -o command= -p "$1" 2>/dev/null; }

# Emit the listener plus ancestors belonging to the same run-bridge invocation.
# Worktree Bridges are deliberately excluded from the production target set.
collect_bridge_tree() {
    local pid="$1" cur ppid args
    [[ -z "$pid" ]] && return 0
    args="$(_args_of "$pid")"
    case "$args" in *worktrees/*) return 0 ;; esac
    printf '%s\n' "$pid"
    cur="$pid"
    while :; do
        ppid="$(_ppid_of "$cur")"
        [[ -z "$ppid" || "$ppid" == 0 || "$ppid" == 1 ]] && break
        args="$(_args_of "$ppid")"
        case "$args" in
            *worktrees/*)   break ;;
            *run-bridge.ts*) printf '%s\n' "$ppid"; cur="$ppid" ;;
            *)              break ;;
        esac
    done
}

bridge_target_pids() {
    local port listener
    port="$(bridge_port)"
    {
        while IFS= read -r listener; do
            [[ -z "$listener" ]] && continue
            collect_bridge_tree "$listener"
        done < <(_listeners_on_port "$port")
    } | awk 'NF && !seen[$0]++'
}
