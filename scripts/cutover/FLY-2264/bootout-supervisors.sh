#!/bin/bash
# FLY-2274: recovery-first, fail-closed supervisor bootout.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/launchd-window.sh
source "$SELF_DIR/lib/launchd-window.sh"

die() { printf 'bootout-supervisors: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 1 ] || die "usage: $0 <labels.txt>"
labels_file="$1"
case "$labels_file" in /*) ;; *) die "labels path must be absolute" ;; esac
[ -f "$labels_file" ] && [ ! -L "$labels_file" ] || die "labels file must be a regular non-symlink"

uid="$(id -u)"
agents_dir="${HOME}/Library/LaunchAgents"
recovery="$(dirname "$labels_file")/supervisor-recovery.json"
tmp="$(mktemp -d -t fly2264-bootout.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

"$SELF_DIR/generate-supervisor-labels.sh" "$agents_dir" >"$tmp/fresh-labels"
cmp -s "$labels_file" "$tmp/fresh-labels" || die "reviewed supervisor manifest differs from fresh live census"
[ "$(wc -l <"$tmp/fresh-labels" | tr -d ' ')" -eq 19 ] || die "fresh supervisor census is not 19 labels"
fly2264_assert_updater_safe "$uid" || die "updater window state or queue safety check failed"

entries='[]'
unloaded=""
while IFS= read -r label; do
  [ -n "$label" ] || die "blank label in manifest"
  fly2264_allowed_label "$label" || die "out-of-scope label in manifest: $label"
  plist="${agents_dir}/${label}.plist"
  fly2264_validate_plist "$plist" "$label" || die "invalid plist for $label"
  state="$(fly2264_launchd_state "$label" "$uid")" || die "cannot determine launchd state for $label"
  loaded=false
  if [ "$state" = loaded ]; then
    loaded=true
  else
    unloaded="${unloaded}${unloaded:+$'\n'}${label}"
  fi
  entry="$(jq -cn --arg label "$label" --arg plistPath "$plist" --argjson loaded "$loaded" \
    '{label:$label,plistPath:$plistPath,loaded:$loaded}')" || die "cannot encode recovery entry for $label"
  entries="$(printf '%s' "$entries" | jq -c --argjson entry "$entry" '. + [$entry]')" \
    || die "cannot append recovery entry for $label"
done <"$tmp/fresh-labels"

recovery_exists=false
if [ -e "$recovery" ] || [ -L "$recovery" ]; then
  [ -f "$recovery" ] && [ ! -L "$recovery" ] || die "existing recovery is not a regular file"
  [ "$(fly2264_file_mode "$recovery")" = 600 ] || die "existing recovery mode must be 0600"
  [ "$(fly2264_file_owner "$recovery")" = "$uid" ] || die "existing recovery owner must be current uid"
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
  ' "$recovery" >/dev/null || die "existing recovery schema is invalid"
  jq -S '[.entries[] | {label,plistPath}] | sort_by(.label)' "$recovery" >"$tmp/existing-scope" \
    || die "cannot inspect existing recovery scope"
  printf '%s' "$entries" | jq -S '[.[] | {label,plistPath}] | sort_by(.label)' >"$tmp/current-scope" \
    || die "cannot encode current recovery scope"
  cmp -s "$tmp/existing-scope" "$tmp/current-scope" \
    || die "existing recovery scope differs from the reviewed live census"
  recovery_exists=true
fi

# A prior partial bootout must retain its original all-loaded recovery until
# restore closes the fleet. Never replace that recovery with a degraded current
# snapshot; after restore, an all-loaded retry atomically refreshes it below.
if [ "$recovery_exists" = true ] && [ -n "$unloaded" ]; then
  while IFS= read -r label; do
    [ -n "$label" ] && printf 'bootout-supervisors: retry requires restore before bootout: %s\n' "$label" >&2
  done <<EOF
$unloaded
EOF
  exit 1
fi

recovery_tmp="$(mktemp "$(dirname "$recovery")/.supervisor-recovery.XXXXXX")" || die "cannot stage recovery"
if ! jq -n --argjson uid "$uid" --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson entries "$entries" \
    '{schemaVersion:1,uid:$uid,createdAt:$createdAt,entries:$entries}' >"$recovery_tmp" \
    || ! jq -e '.schemaVersion == 1 and (.entries | length == 19)' "$recovery_tmp" >/dev/null; then
  rm -f "$recovery_tmp"
  die "cannot publish complete recovery"
fi
chmod 600 "$recovery_tmp" || { rm -f "$recovery_tmp"; die "cannot chmod recovery"; }
mv "$recovery_tmp" "$recovery" || { rm -f "$recovery_tmp"; die "cannot publish recovery"; }

if [ -n "$unloaded" ]; then
  while IFS= read -r label; do
    [ -n "$label" ] && printf 'bootout-supervisors: pre-existing unloaded supervisor: %s\n' "$label" >&2
  done <<EOF
$unloaded
EOF
  exit 1
fi

fly2264_assert_updater_safe "$uid" || die "updater window state or queue safety check failed before bootout"
while IFS= read -r label; do
  launchctl bootout "gui/${uid}/${label}" || die "bootout failed for $label"
done <"$tmp/fresh-labels"
cp "$tmp/fresh-labels" "$tmp/pending-labels" || die "cannot stage convergence census"
started_at="$(date +%s)" || die "cannot read convergence clock"
[[ "$started_at" =~ ^[0-9]+$ ]] || die "invalid convergence clock"
deadline=$((started_at + 90))
while [ -s "$tmp/pending-labels" ]; do
  : >"$tmp/next-pending-labels"
  while IFS= read -r label; do
    state="$(fly2264_launchd_state "$label" "$uid")" || die "post-bootout state unknown for $label"
    [ "$state" = absent ] || printf '%s\n' "$label" >>"$tmp/next-pending-labels"
  done <"$tmp/pending-labels"
  mv "$tmp/next-pending-labels" "$tmp/pending-labels" \
    || die "cannot update convergence census"
  [ -s "$tmp/pending-labels" ] || break
  now="$(date +%s)" || die "cannot read convergence clock"
  [[ "$now" =~ ^[0-9]+$ ]] || die "invalid convergence clock"
  if [ "$now" -ge "$deadline" ]; then
    while IFS= read -r label; do
      printf 'bootout-supervisors: label did not become absent within shared 90-second convergence deadline: %s\n' \
        "$label" >&2
    done <"$tmp/pending-labels"
    exit 1
  fi
  sleep 1
done

"$SELF_DIR/generate-supervisor-labels.sh" "$agents_dir" >"$tmp/post-labels"
cmp -s "$labels_file" "$tmp/post-labels" || die "supervisor plist scope drifted during bootout"
while IFS= read -r label; do
  state="$(fly2264_launchd_state "$label" "$uid")" || die "final launchd state unknown for $label"
  [ "$state" = absent ] || die "final census found loaded label: $label"
done <"$tmp/post-labels"
fly2264_assert_updater_safe "$uid" || die "updater window state or queue safety check failed after bootout"
jq -n --arg recovery "$recovery" --argjson count 19 '{status:"pass",recovery:$recovery,absent:$count}'
