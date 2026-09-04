#!/bin/bash
# FLY-1663: deterministic per-Lead tmux socket addressing.
# Pure resolution is shared by launchers and fleet validation; directory
# creation/validation is an explicit separate operation.

_lead_socket_hash16() {
  printf '%s' "$1" | shasum -a 256 | awk '{print substr($1, 1, 16)}'
}

_lead_socket_prefix() {
  local prefix
  prefix=$(printf '%s' "$1" \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C sed -e 's/[^a-z0-9]/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//' \
    | LC_ALL=C cut -c1-20)
  [ -n "$prefix" ] || prefix="lead"
  printf '%s' "$prefix"
}

# derive_codex_lead_home <codex-home-key> [home-root]
# Prints the isolated home shared by every production Codex Lead launcher.
derive_codex_lead_home() {
  local codex_home_key="${1:-}"
  local home_root="${2:-${HOME:-}}"
  if ! [[ "$codex_home_key" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
    echo "Codex Lead home key must match ^[a-z][a-z0-9-]{0,31}$" >&2
    return 2
  fi
  case "$home_root" in
    /*) : ;;
    *) echo "Codex Lead home root must be absolute: $home_root" >&2; return 2 ;;
  esac
  if [ "$home_root" = / ]; then
    printf '/.codex-%s\n' "$codex_home_key"
  else
    printf '%s/.codex-%s\n' "${home_root%/}" "$codex_home_key"
  fi
}

# derive_lead_socket <exact-key> [state-dir]
# Prints the canonical absolute socket path. The complete path budget is kept
# below 90 bytes, leaving margin under macOS sockaddr_un.sun_path.
derive_lead_socket() {
  local exact_key="${1:-}"
  local state_dir="${2:-${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}}"
  [ -n "$exact_key" ] || { echo "lead exact key is required" >&2; return 2; }
  case "$state_dir" in
    /*) : ;;
    *) echo "lead socket state directory must be absolute: $state_dir" >&2; return 2 ;;
  esac

  local prefix hash path bytes
  prefix=$(_lead_socket_prefix "$exact_key") || return 2
  hash=$(_lead_socket_hash16 "$exact_key") || return 2
  path="${state_dir}/sock/fw-${prefix}-${hash}.sock"
  bytes=$(LC_ALL=C printf '%s' "$path" | wc -c | tr -d ' ')
  if [ "$bytes" -ge 90 ]; then
    echo "lead socket path must be < 90 bytes (got ${bytes}): $path" >&2
    return 2
  fi
  printf '%s\n' "$path"
}

_lead_socket_stat_uid() {
  # GNU stat accepts -f with different semantics and exits zero, so try its
  # explicit field form first. Darwin stat rejects -c and falls through.
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1" 2>/dev/null
}

_lead_socket_stat_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

# ensure_lead_socket_dir [state-dir]
# Creates the socket directory once, then validates owner/mode/non-symlink.
ensure_lead_socket_dir() {
  local state_dir="${1:-${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}}"
  case "$state_dir" in
    /*) : ;;
    *) echo "lead socket state directory must be absolute: $state_dir" >&2; return 2 ;;
  esac
  local socket_dir="${state_dir}/sock"
  if [ -L "$socket_dir" ]; then
    echo "lead socket directory must not be a symlink: $socket_dir" >&2
    return 2
  fi
  if [ ! -e "$socket_dir" ]; then
    mkdir -p "$socket_dir" || return 2
    chmod 700 "$socket_dir" || return 2
  fi
  [ -d "$socket_dir" ] || {
    echo "lead socket path is not a directory: $socket_dir" >&2
    return 2
  }
  local uid mode current_uid
  uid=$(_lead_socket_stat_uid "$socket_dir") || return 2
  mode=$(_lead_socket_stat_mode "$socket_dir") || return 2
  current_uid=$(id -u)
  if [ "$uid" != "$current_uid" ] || [ "$mode" != "700" ]; then
    echo "lead socket directory must be owned by uid ${current_uid} with mode 0700: $socket_dir (uid=${uid}, mode=${mode})" >&2
    return 2
  fi
}
