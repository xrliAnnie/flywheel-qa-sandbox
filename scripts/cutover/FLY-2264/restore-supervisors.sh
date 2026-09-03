#!/bin/bash
# FLY-2274: bootstrap exactly the originally-loaded supervisor plists.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/launchd-window.sh
source "$SELF_DIR/lib/launchd-window.sh"

die() { printf 'restore-supervisors: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 1 ] || die "usage: $0 <supervisor-recovery.json>"
recovery="$1"
case "$recovery" in /*) ;; *) die "recovery path must be absolute" ;; esac
[ -f "$recovery" ] && [ ! -L "$recovery" ] || die "recovery must be a regular non-symlink file"
uid="$(id -u)"
[ "$(fly2264_file_mode "$recovery")" = 600 ] || die "recovery mode must be 0600"
[ "$(fly2264_file_owner "$recovery")" = "$uid" ] || die "recovery owner must be current uid"

jq -e --argjson uid "$uid" '
  type == "object" and keys == ["createdAt","entries","schemaVersion","uid"]
  and .schemaVersion == 1 and .uid == $uid
  and (.createdAt | type == "string" and length > 0)
  and (.entries | type == "array" and length == 19)
  and ([.entries[].label] | unique | length == 19)
  and all(.entries[];
    (keys == ["label","loaded","plistPath"])
    and (.label | type == "string" and length > 0)
    and (.plistPath | type == "string" and startswith("/"))
    and (.loaded | type == "boolean"))
' "$recovery" >/dev/null || die "recovery schema is invalid"

ordered="$({
  printf '%s\n' com.flywheel.bridge com.flywheel.bridge-liveness-probe com.flywheel.cmux-watcher
  jq -r '.entries[].label | select(startswith("com.flywheel.lead."))' "$recovery" | LC_ALL=C sort
} | awk 'NF')"
[ "$(printf '%s\n' "$ordered" | wc -l | tr -d ' ')" -eq 19 ] || die "recovery does not contain the exact supervisor scope"

fly2264_assert_updater_state_safe "$uid" || die "updater state is unsafe before supervisor restore"
while IFS= read -r label; do
  fly2264_allowed_label "$label" || die "out-of-scope recovery label: $label"
  row="$(jq -erc --arg label "$label" '.entries[] | select(.label == $label)' "$recovery")" \
    || die "missing recovery row for $label"
  plist="$(printf '%s' "$row" | jq -er '.plistPath')" || die "missing plist path for $label"
  loaded="$(printf '%s' "$row" | jq -er '.loaded')" || die "missing loaded state for $label"
  expected="${HOME}/Library/LaunchAgents/${label}.plist"
  [ "$plist" = "$expected" ] || die "unexpected plist path for $label: $plist"
  fly2264_validate_plist "$plist" "$label" || die "invalid original plist for $label"
  state="$(fly2264_launchd_state "$label" "$uid")" || die "cannot determine current state for $label"
  if [ "$loaded" = true ]; then
    if [ "$state" = absent ]; then
      launchctl bootstrap "gui/${uid}" "$plist" || die "bootstrap failed for $label"
    fi
    state="$(fly2264_launchd_state "$label" "$uid")" || die "post-bootstrap state unknown for $label"
    [ "$state" = loaded ] || die "label not loaded after restore: $label"
  else
    [ "$state" = absent ] || die "originally-unloaded label is unexpectedly loaded: $label"
  fi
done <<EOF
$ordered
EOF
fly2264_assert_updater_state_safe "$uid" || die "updater state became unsafe during supervisor restore"
jq -n --argjson count 19 '{status:"pass",restoredScope:$count}'
