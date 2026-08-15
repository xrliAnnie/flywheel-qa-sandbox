#!/bin/bash
# FLY-1716: shared per-Lead authority lock for launcher and SessionStart(clear).
# Defines functions only; safe to source under bash 3.2.

_LEAD_AUTHORITY_LOCK_DIR=""
_LEAD_AUTHORITY_LOCK_TOKEN=""

_lead_authority_mtime() {
  stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1" 2>/dev/null || return 1
}

_lead_authority_owner_snapshot() {
  local owner_file="$1" line=""
  if [ -f "$owner_file" ]; then
    IFS= read -r line < "$owner_file" || true
  fi
  printf '%s' "$line"
}

_lead_authority_reap_stale() {
  local lock_dir="$1" now="$2" stale_sec="$3"
  local owner_file="$lock_dir/owner" snapshot pid acquired token current mtime
  snapshot="$(_lead_authority_owner_snapshot "$owner_file")"
  pid=""
  acquired=""
  token=""
  IFS=$'\t' read -r pid acquired token <<< "$snapshot"

  if [[ "$pid" =~ ^[0-9]+$ ]] && [[ "$acquired" =~ ^[0-9]+$ ]]; then
    kill -0 "$pid" 2>/dev/null && return 1
    [ $((now - acquired)) -ge "$stale_sec" ] || return 1
  else
    mtime="$(_lead_authority_mtime "$lock_dir")" || return 1
    [[ "$mtime" =~ ^[0-9]+$ ]] || return 1
    [ $((now - mtime)) -ge "$stale_sec" ] || return 1
  fi

  current="$(_lead_authority_owner_snapshot "$owner_file")"
  [ "$current" = "$snapshot" ] || return 1
  if [ -n "$snapshot" ]; then
    rm -f "$owner_file" 2>/dev/null || return 1
  fi
  rmdir "$lock_dir" 2>/dev/null
}

lead_authority_lock_acquire() {
  local lock_dir="$1" timeout_sec="$2"
  local stale_sec="${FLYWHEEL_LEAD_AUTHORITY_STALE_SEC:-120}"
  local started now token owner_file
  [[ "$timeout_sec" =~ ^[0-9]+$ ]] || return 1
  [[ "$stale_sec" =~ ^[1-9][0-9]*$ ]] || return 1
  mkdir -p "$(dirname "$lock_dir")" 2>/dev/null || return 1
  started="$(date +%s)"

  while :; do
    if mkdir "$lock_dir" 2>/dev/null; then
      now="$(date +%s)"
      token="$$-${now}-${RANDOM}-${RANDOM}"
      owner_file="$lock_dir/owner"
      if ! (umask 077 && printf '%s\t%s\t%s\n' "$$" "$now" "$token" > "$owner_file"); then
        rmdir "$lock_dir" 2>/dev/null || true
        return 1
      fi
      _LEAD_AUTHORITY_LOCK_DIR="$lock_dir"
      _LEAD_AUTHORITY_LOCK_TOKEN="$token"
      return 0
    fi

    now="$(date +%s)"
    _lead_authority_reap_stale "$lock_dir" "$now" "$stale_sec" && continue
    [ $((now - started)) -lt "$timeout_sec" ] || return 1
    sleep 0.1
  done
}

lead_authority_lock_release() {
  local lock_dir="${_LEAD_AUTHORITY_LOCK_DIR:-}"
  local expected="${_LEAD_AUTHORITY_LOCK_TOKEN:-}" owner_file snapshot pid acquired token
  _LEAD_AUTHORITY_LOCK_DIR=""
  _LEAD_AUTHORITY_LOCK_TOKEN=""
  [ -n "$lock_dir" ] && [ -n "$expected" ] || return 1
  owner_file="$lock_dir/owner"
  snapshot="$(_lead_authority_owner_snapshot "$owner_file")"
  IFS=$'\t' read -r pid acquired token <<< "$snapshot"
  [ "$pid" = "$$" ] && [ "$token" = "$expected" ] || return 1
  rm -f "$owner_file" 2>/dev/null || return 1
  rmdir "$lock_dir" 2>/dev/null
}
