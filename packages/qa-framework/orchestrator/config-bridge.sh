#!/bin/bash
# config-bridge.sh — Load qa-config.yaml into shell environment
# Sources the TypeScript shell-export output to set QA_* variables.
#
# Usage: source config-bridge.sh [path-to-qa-config.yaml]
#
# After sourcing, all QA_* variables are available:
#   QA_PROJECT_NAME, QA_DOC_ROOT, QA_DOMAIN_0_NAME, etc.

_CONFIG_BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

load_qa_config() {
    local config_file="${1:-.claude/qa-config.yaml}"

    if [ ! -f "$config_file" ]; then
        echo "ERROR: qa-config.yaml not found at $config_file" >&2
        return 1
    fi

    # Find shell-export.js — check dist/ in this package, then fallback
    local shell_export=""
    if [ -f "$_CONFIG_BRIDGE_DIR/../dist/config/shell-export.js" ]; then
        shell_export="$_CONFIG_BRIDGE_DIR/../dist/config/shell-export.js"
    elif [ -f "$_CONFIG_BRIDGE_DIR/../src/config/shell-export.ts" ]; then
        # Dev mode: use tsx or ts-node
        echo "WARNING: shell-export.js not built. Run 'pnpm --filter ./packages/qa-framework build' first." >&2
        return 1
    fi

    if [ -z "$shell_export" ]; then
        echo "ERROR: shell-export.js not found. Build the qa-framework package first." >&2
        return 1
    fi

    # Run shell-export and eval the output
    local exports
    exports=$(node "$shell_export" "$config_file" 2>&1)
    local rc=$?
    if [ $rc -ne 0 ]; then
        echo "ERROR: shell-export failed: $exports" >&2
        return 1
    fi

    eval "$exports"

    # Set DB_PATH from config (used by state.sh)
    export DB_PATH="${QA_ORCH_DB_PATH:-$HOME/.flywheel/orchestrator/qa.db}"

    echo "[CONFIG] Loaded qa-config.yaml: project=${QA_PROJECT_NAME:-?}, domains=${QA_DOMAIN_COUNT:-0}"
}

# Auto-load if config file argument is provided
if [ -n "${1:-}" ]; then
    load_qa_config "$1"
fi
