#!/usr/bin/env bash
# FLY-1766 QA: A/B with VERSION-CORRECT env knob names on both sides, driven to
# the actual page threshold (3 consecutive degraded ticks over the grace window).
set -uo pipefail
AB="$(cd "$(dirname "$0")" && pwd)"
run_case() {
  local probe="$1" body_file="$2" label="$3"
  local T; T="$(mktemp -d)"
  export FLYWHEEL_PROBE_STATE_FILE="$T/state.json"
  export FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="chan-x"
  # both naming generations set, so each version sees its own knobs
  export FLYWHEEL_WATCHDOG_MANIFEST_GRACE_MIN=1  FLYWHEEL_LIVENESS_MANIFEST_GRACE_MIN=1
  export FLYWHEEL_WATCHDOG_MANIFEST_DEGRADED_MIN=3 FLYWHEEL_LIVENESS_MANIFEST_DEGRADED_MIN=3
  # shellcheck disable=SC1090
  source "$probe"
  POSTS="$T/posts.log"; : > "$POSTS"
  local BODY; BODY="$(cat "$body_file")"
  NOW=500000
  _probe_curl() { printf '%s' "$BODY"; }
  _probe_now()  { echo "$NOW"; }
  _probe_post() { printf '%s\n' "$1" >> "$POSTS"; return 0; }
  local last=""
  for i in 1 2 3 4 5; do NOW=$(( 500000 + i*60 )); last="$(probe_once)"; done
  printf '%-7s | %-22s | verdict=%-12s | pages=%s\n' "$label" "$(basename "$body_file" .json)" "$last" "$(wc -l < "$POSTS"|tr -d ' ')"
  [[ -s "$POSTS" ]] && sed 's/^/          ↳ /' "$POSTS"
  rm -rf "$T"
}
for body in "$AB/body-v2-real.json" "$AB/body-v1-realproducer.json"; do
  ( run_case "$AB/probe-BEFORE.sh" "$body" "BEFORE" )
  ( run_case "$AB/probe-AFTER.sh"  "$body" "AFTER" )
  echo
done
