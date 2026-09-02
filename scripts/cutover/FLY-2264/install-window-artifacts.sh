#!/bin/bash
# FLY-2274: atomically publish reviewed cutover artifacts into a private window.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
die() { printf 'install-window-artifacts: %s\n' "$*" >&2; exit 1; }
mode_of() {
  local value=""
  if value="$(stat -c %a "$1" 2>/dev/null)" && [[ "$value" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s\n' "$value"
  else
    stat -f %Lp "$1" 2>/dev/null
  fi
}
owner_of() {
  local value=""
  if value="$(stat -c %u "$1" 2>/dev/null)" && [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
  else
    stat -f %u "$1" 2>/dev/null
  fi
}

[ "$#" -eq 1 ] || die "usage: $0 <absolute-WINDOW_DIR/artifacts>"
destination="$1"
case "$destination" in
  /*) ;;
  *) die "WINDOW_DIR must be absolute" ;;
esac
case "$destination" in
  /|*/.|*/..|*/) die "WINDOW_DIR must name a concrete directory without a trailing slash" ;;
esac
case "$destination" in *$'\n'*|*$'\r'*) die "WINDOW_DIR contains a line break" ;; esac
[ "$(basename "$destination")" = artifacts ] \
  || die "installation target must be the fixed WINDOW_DIR/artifacts child"

parent="$(dirname "$destination")"
[ -d "$parent" ] && [ ! -L "$parent" ] || die "WINDOW_DIR parent must be a real directory: $parent"
[ "$(owner_of "$parent")" = "$(id -u)" ] || die "WINDOW_DIR parent is not owned by the current user: $parent"
[ "$(mode_of "$parent")" = 700 ] || die "WINDOW_DIR parent mode must be 0700: $parent"
[ ! -L "$destination" ] || die "WINDOW_DIR symlink is forbidden: $destination"

files=(
  bootout-supervisors.sh
  generate-supervisor-labels.sh
  lib/launchd-window.sh
  lib/tmux-process-inventory.sh
  phase-b-link.sh
  restore-supervisors.sh
  stop-old-tmux-servers.sh
  supervisor-labels.txt
  verify-native-tmux-cutover.sh
)

for relative in "${files[@]}"; do
  source_path="$SELF_DIR/$relative"
  [ -f "$source_path" ] && [ ! -L "$source_path" ] \
    || die "reviewed source is missing, non-regular, or a symlink: $relative"
done

destination_exists=false
if [ -e "$destination" ]; then
  [ -d "$destination" ] || die "WINDOW_DIR exists and is not a directory: $destination"
  [ "$(owner_of "$destination")" = "$(id -u)" ] \
    || die "WINDOW_DIR is not owned by the current user: $destination"
  [ "$(mode_of "$destination")" = 700 ] || die "WINDOW_DIR mode must be 0700: $destination"
  destination_exists=true
fi

shopt -s nullglob
stale_stages=("$parent"/.fly2264-window.*)
shopt -u nullglob
[ "${#stale_stages[@]}" -eq 0 ] \
  || die "stale or concurrent staging directory exists: ${stale_stages[0]}"

umask 077
stage="$(mktemp -d "$parent/.fly2264-window.XXXXXX")" || die "cannot create sibling staging directory"
cleanup() {
  [ -z "${stage:-}" ] || rm -rf "$stage"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$stage"
mkdir -m 700 "$stage/lib"

for relative in "${files[@]}"; do
  cp "$SELF_DIR/$relative" "$stage/$relative" || die "copy failed: $relative"
  chmod 700 "$stage/$relative" || die "chmod failed: $relative"
done

manifest="$stage/sha256-manifest.txt"
: >"$manifest"
for relative in "${files[@]}"; do
  hash="$(shasum -a 256 "$stage/$relative" | awk '{print $1}')" || die "hash failed: $relative"
  [[ "$hash" =~ ^[0-9a-f]{64}$ ]] || die "invalid sha256 output: $relative"
  printf '%s  %s\n' "$hash" "$relative" >>"$manifest"
done
chmod 600 "$manifest"
(cd "$stage" && shasum -a 256 -c sha256-manifest.txt >/dev/null) \
  || die "staged manifest verification failed"

validate_existing() {
  local relative entry name runtime_file
  [ -f "$destination/sha256-manifest.txt" ] && [ ! -L "$destination/sha256-manifest.txt" ] \
    || return 1
  [ "$(mode_of "$destination/sha256-manifest.txt")" = 600 ] || return 1
  [ "$(owner_of "$destination/sha256-manifest.txt")" = "$(id -u)" ] || return 1
  [ -d "$destination/lib" ] && [ ! -L "$destination/lib" ] \
    && [ -z "$(find "$destination" -type l -print -quit)" ] || return 1
  [ "$(mode_of "$destination/lib")" = 700 ] || return 1
  [ "$(owner_of "$destination/lib")" = "$(id -u)" ] || return 1
  for relative in "${files[@]}"; do
    [ -f "$destination/$relative" ] && [ ! -L "$destination/$relative" ] || return 1
    [ "$(mode_of "$destination/$relative")" = 700 ] || return 1
    [ "$(owner_of "$destination/$relative")" = "$(id -u)" ] || return 1
  done
  [ "$(find "$destination/lib" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" -eq 2 ] \
    || return 1

  # Runtime outputs are deliberately colocated under the Lead-locked
  # WINDOW_DIR/artifacts path. They are not reviewed source bytes and are not
  # in the manifest, but an idempotent revalidation may preserve only these
  # exact private names and shapes; every unknown extra still fails closed.
  while IFS= read -r entry; do
    name="${entry##*/}"
    case "$name" in
      bootout-supervisors.sh|generate-supervisor-labels.sh|lib|phase-b-link.sh|restore-supervisors.sh|stop-old-tmux-servers.sh|supervisor-labels.txt|verify-native-tmux-cutover.sh|sha256-manifest.txt)
        ;;
      supervisor-recovery.json|tmux-union.json)
        [ -f "$entry" ] && [ ! -L "$entry" ] || return 1
        [ "$(mode_of "$entry")" = 600 ] && [ "$(owner_of "$entry")" = "$(id -u)" ] || return 1
        ;;
      verification-artifacts)
        [ -d "$entry" ] && [ ! -L "$entry" ] || return 1
        [ "$(mode_of "$entry")" = 700 ] && [ "$(owner_of "$entry")" = "$(id -u)" ] || return 1
        [ -z "$(find "$entry" -mindepth 1 -type d -print -quit)" ] \
          && [ -z "$(find "$entry" -type l -print -quit)" ] || return 1
        while IFS= read -r runtime_file; do
          case "${runtime_file##*/}" in
            01-updater.json|02-lead-census.json|03-native-tmux.json|04-tmux-servers.json|05-lead-health.json|06-cmux.json|07-path.json|verification-summary.json) ;;
            *) return 1 ;;
          esac
          [ -f "$runtime_file" ] && [ "$(mode_of "$runtime_file")" = 600 ] \
            && [ "$(owner_of "$runtime_file")" = "$(id -u)" ] || return 1
        done < <(find "$entry" -mindepth 1 -maxdepth 1 -print)
        ;;
      *) return 1 ;;
    esac
  done < <(find "$destination" -mindepth 1 -maxdepth 1 -print)
  cmp -s "$manifest" "$destination/sha256-manifest.txt" || return 1
  (cd "$destination" && shasum -a 256 -c sha256-manifest.txt >/dev/null 2>&1) || return 1
}

if [ "$destination_exists" = true ] && [ -n "$(find "$destination" -mindepth 1 -print -quit)" ]; then
  validate_existing || die "existing WINDOW_DIR is populated but not an exact reviewed installation"
  rm -rf "$stage"
  stage=""
  trap - EXIT INT TERM
  jq -n --arg windowDir "$destination" '{status:"idempotent",windowDir:$windowDir,files:9}'
  exit 0
fi

if [ "$destination_exists" = true ]; then
  [ -z "$(find "$destination" -mindepth 1 -print -quit)" ] \
    || die "WINDOW_DIR changed while staging"
  rmdir "$destination" || die "empty WINDOW_DIR changed while staging"
fi
if ! python3 - "$stage" "$destination" <<'PY'
import os
import sys
try:
    os.rename(sys.argv[1], sys.argv[2])
except OSError as exc:
    print(f"rename failed: {exc}", file=sys.stderr)
    raise SystemExit(1)
PY
then
  if [ "$destination_exists" = true ] && [ ! -e "$destination" ]; then
    mkdir -m 700 "$destination" 2>/dev/null || true
  fi
  die "atomic WINDOW_DIR publication failed"
fi
stage=""
trap - EXIT INT TERM
[ "$(mode_of "$destination")" = 700 ] || die "published WINDOW_DIR mode drifted"
(cd "$destination" && shasum -a 256 -c sha256-manifest.txt >/dev/null) \
  || die "published manifest verification failed"
jq -n --arg windowDir "$destination" '{status:"installed",windowDir:$windowDir,files:9}'
