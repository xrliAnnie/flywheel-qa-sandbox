#!/usr/bin/env bash
# FLY-1766 QA item B — 探针假 page 回归 against a REAL Bridge on the PR head.
# Read-only: isolated state file per version, _probe_post redirected to a log,
# no bot token. Drives 6 consecutive ticks past the page threshold.
set -uo pipefail
AB="$(cd "$(dirname "$0")" && pwd)"
URL="${1:-http://localhost:19873}"
unset CODEX_INFRA_BOT_TOKEN FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID FLYWHEEL_FOUNDER_DISCORD_USER_ID
export FLYWHEEL_LIVENESS_MANIFEST_GRACE_MIN=5  FLYWHEEL_WATCHDOG_MANIFEST_GRACE_MIN=5
export FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN=3 FLYWHEEL_WATCHDOG_MANIFEST_DEGRADED_MIN=3
BODY="$(curl -sS --max-time 10 "$URL/health")"
KEY="$(jq -r 'if has("liveness") then "liveness(v2)" elif has("watchdogs") then "watchdogs(v1)" else "NONE" end' <<<"$BODY")"
SHA="$(jq -r '.buildSha // "?"' <<<"$BODY")"
W1="$(jq -r '(.liveness // .watchdogs).components.w1_process_liveness.freshness // "?"' <<<"$BODY")"
echo "source=$URL  key=$KEY  buildSha=$SHA  w1.freshness=$W1"
# Also derive a v1-shaped body from the same live manifest (rollout other side).
V1="$(jq -c '{ok:.ok, watchdogs:((.liveness // .watchdogs)
  | .schema_version = 1
  | .components.w1_process_liveness |= del(.freshness,.in_flight_age_ms,.last_check_started_at,.last_check_completed_at,.switch)
  | .components.w4_lead_blocked = {class:"W-4",wired:true,effective_enabled:true})}' <<<"$BODY")"
run() {
  local probe="$1" label="$2" body="$3" shape="$4"
  local T; T="$(mktemp -d)"
  ( export FLYWHEEL_PROBE_STATE_FILE="$T/state.json"
    # shellcheck disable=SC1090
    source "$probe"
    POSTS="$T/posts.log"; : > "$POSTS"
    BODYX="$body"
    _probe_curl() { printf '%s' "$BODYX"; }
    NOW=900000
    _probe_now()  { echo "$NOW"; }
    _probe_post() { printf '%s\n' "$1" >> "$POSTS"; return 0; }
    local out=""
    for i in 1 2 3 4 5 6; do NOW=$(( 900000 + i*60 )); out="$(probe_once)"; done
    printf '  %-7s | %-24s | verdict=%-12s | pages=%s\n' "$label" "$shape" "$out" "$(wc -l < "$POSTS"|tr -d ' ')"
    [[ -s "$POSTS" ]] && sed 's/^/            ↳ /' "$POSTS"
  )
  rm -rf "$T"
}
echo "-- live v2 manifest (the deploy-side shape) --"
run "$AB/probe-AFTER.sh"  "AFTER"  "$BODY" "live v2 (liveness)"
run "$AB/probe-BEFORE.sh" "BEFORE" "$BODY" "live v2 (liveness)"
echo "-- same Bridge, rendered in the legacy v1 shape (rollout other side) --"
run "$AB/probe-AFTER.sh"  "AFTER"  "$V1" "derived v1 (watchdogs)"
run "$AB/probe-BEFORE.sh" "BEFORE" "$V1" "derived v1 (watchdogs)"
