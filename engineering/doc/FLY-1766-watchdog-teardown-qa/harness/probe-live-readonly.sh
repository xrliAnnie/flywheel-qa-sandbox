#!/usr/bin/env bash
# Fix for the first run's instrument bug: each version gets its OWN state file.
set -uo pipefail
AB="$(cd "$(dirname "$0")" && pwd)"
unset CODEX_INFRA_BOT_TOKEN FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID FLYWHEEL_FOUNDER_DISCORD_USER_ID
export FLYWHEEL_LIVENESS_MANIFEST_GRACE_MIN=5 FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN=3
export FLYWHEEL_WATCHDOG_MANIFEST_GRACE_MIN=5 FLYWHEEL_WATCHDOG_MANIFEST_DEGRADED_MIN=3
run_probe() {
  local probe="$1" label="$2"
  local T; T="$(mktemp -d)"
  ( export FLYWHEEL_PROBE_STATE_FILE="$T/state.json"
    # shellcheck disable=SC1090
    source "$probe"
    POSTS="$T/posts.log"; : > "$POSTS"
    _probe_post() { printf '%s\n' "$1" >> "$POSTS"; return 0; }
    local out; out="$(probe_once)"
    printf '%-7s | fresh state | verdict=%-12s | pages=%s\n' "$label" "$out" "$(wc -l < "$POSTS"|tr -d ' ')"
    [[ -s "$POSTS" ]] && sed 's/^/          ↳ /' "$POSTS"
  )
  rm -rf "$T"
}
run_probe "$AB/probe-AFTER.sh" "AFTER"
run_probe "$AB/probe-BEFORE.sh" "BEFORE"
