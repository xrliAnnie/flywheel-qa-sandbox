#!/usr/bin/env bash
# FLY-1887: bounded rename rotation for Flywheel-owned logs that are opened for
# each append. Source-only; macOS Bash 3.2 compatible. Do not use this for a
# launchd StandardOutPath/StandardErrorPath held open by a long-lived process.

FLYWHEEL_LOG_DEFAULT_MAX_BYTES="${FLYWHEEL_LOG_MAX_BYTES:-10485760}"
FLYWHEEL_LOG_DEFAULT_RETENTION="${FLYWHEEL_LOG_RETENTION:-3}"
FLYWHEEL_LOG_DEFAULT_LOCK_STALE_SECONDS="${FLYWHEEL_LOG_LOCK_STALE_SECONDS:-300}"

_flywheel_log_size_bytes() {
  local path="$1" size
  # GNU stat accepts `-f` with different semantics, so probe GNU `-c` first;
  # BSD/macOS stat rejects it cleanly and then uses `-f`.
  size="$(stat -c '%s' "$path" 2>/dev/null)" \
    || size="$(stat -f '%z' "$path" 2>/dev/null)" \
    || return 1
  case "$size" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$size"
}

_flywheel_log_positive_integer() {
  case "${1:-}" in ''|0|*[!0-9]*) return 1 ;; esac
}

_flywheel_log_lock_identity() {
  local path="$1" value
  value="$(stat -c '%d:%i:%Y' "$path" 2>/dev/null)" \
    || value="$(stat -f '%d:%i:%m' "$path" 2>/dev/null)" \
    || return 1
  case "$value" in
    ''|*[!0-9:]*) return 1 ;;
    *:*:*) ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$value"
}

_flywheel_log_acquire_rotation_lock() {
  local lock="$1" stale_seconds="$2" observed_identity moved_identity
  local mtime now age quarantine
  mkdir "$lock" 2>/dev/null && return 0
  _flywheel_log_positive_integer "$stale_seconds" || return 1
  [[ -d "$lock" && ! -L "$lock" ]] || return 1
  observed_identity="$(_flywheel_log_lock_identity "$lock" 2>/dev/null)" \
    || return 1
  mtime="${observed_identity##*:}"
  now="$(date +%s)"
  case "$now" in ''|*[!0-9]*) return 1 ;; esac
  (( now >= mtime )) || return 1
  age=$(( now - mtime ))
  (( age >= stale_seconds )) || return 1

  # Rename the stale inode out of the lock path before acquiring a fresh one.
  # A recent lock is never touched; a crash residue therefore cannot suppress
  # rotation forever after its bounded grace period.
  quarantine="${lock}.stale.${BASHPID:-$$}.${RANDOM:-0}"
  mv "$lock" "$quarantine" 2>/dev/null || return 1
  moved_identity="$(_flywheel_log_lock_identity "$quarantine" 2>/dev/null)" \
    || {
      [[ -e "$lock" || -L "$lock" ]] \
        || mv "$quarantine" "$lock" 2>/dev/null || true
      return 1
    }
  if [[ "$moved_identity" != "$observed_identity" ]]; then
    # The lock changed between inspection and rename. Put the replacement back
    # and abandon recovery instead of entering beside its live owner.
    [[ -e "$lock" || -L "$lock" ]] \
      || mv "$quarantine" "$lock" 2>/dev/null || true
    return 1
  fi
  if mkdir "$lock" 2>/dev/null; then
    rmdir "$quarantine" 2>/dev/null || true
    return 0
  fi
  [[ -e "$lock" ]] || mv "$quarantine" "$lock" 2>/dev/null || true
  return 1
}

# flywheel_log_rotate_if_needed <path> [max_bytes] [keep]
# Returns success even when rotation cannot run. The caller must perform its
# append after this function and retain its own append-error semantics.
flywheel_log_rotate_if_needed() {
  local path="$1"
  local max_bytes="${2:-$FLYWHEEL_LOG_DEFAULT_MAX_BYTES}"
  local keep="${3:-$FLYWHEEL_LOG_DEFAULT_RETENTION}"
  local size lock generation prior

  _flywheel_log_positive_integer "$max_bytes" || return 0
  _flywheel_log_positive_integer "$keep" || return 0
  [[ -f "$path" && ! -L "$path" ]] || return 0
  size="$(_flywheel_log_size_bytes "$path" 2>/dev/null)" || return 0
  (( size >= max_bytes )) || return 0

  lock="${path}.rotate.lock"
  _flywheel_log_acquire_rotation_lock "$lock" \
    "$FLYWHEEL_LOG_DEFAULT_LOCK_STALE_SECONDS" || return 0

  # A waiter may have observed the old size before another process rotated it.
  # Recheck under the lock so it does not rotate the fresh active file again.
  if [[ ! -f "$path" || -L "$path" ]]; then
    rmdir "$lock" 2>/dev/null || true
    return 0
  fi
  size="$(_flywheel_log_size_bytes "$path" 2>/dev/null)" || {
    rmdir "$lock" 2>/dev/null || true
    return 0
  }
  if (( size < max_bytes )); then
    rmdir "$lock" 2>/dev/null || true
    return 0
  fi

  rm -f "${path}.${keep}" 2>/dev/null || {
    rmdir "$lock" 2>/dev/null || true
    return 0
  }
  generation="$keep"
  while (( generation >= 2 )); do
    prior=$(( generation - 1 ))
    if [[ -e "${path}.${prior}" ]] \
      && ! mv -f "${path}.${prior}" "${path}.${generation}" 2>/dev/null; then
      rmdir "$lock" 2>/dev/null || true
      return 0
    fi
    generation=$(( generation - 1 ))
  done
  mv -f "$path" "${path}.1" 2>/dev/null || true
  rmdir "$lock" 2>/dev/null || true
  return 0
}
