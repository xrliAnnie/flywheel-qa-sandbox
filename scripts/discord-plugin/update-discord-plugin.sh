#!/bin/bash
# FLY-1676: update the CLI-managed Discord pointer, serialized fleet-wide.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="${SCRIPT_DIR}/check-discord-plugin.sh"
PLUGIN_KEY="discord@flywheel-plugins"
MARKETPLACE="flywheel-plugins"
LOCK_DIR="${HOME}/.flywheel/discord-plugin-update.lock.d"
LOCK_WAIT_SECONDS="${FLYWHEEL_DISCORD_LOCK_WAIT_SECONDS:-120}"
LOCK_OWNER="${LOCK_DIR}/owner"
LOCK_INCARNATION=""

if [ ! -x "$CHECKER" ]; then
  echo "ERROR: Discord checker is missing or not executable: $CHECKER" >&2
  exit 1
fi
case "$LOCK_WAIT_SECONDS" in
  ''|*[!0-9]*) echo "ERROR: FLYWHEEL_DISCORD_LOCK_WAIT_SECONDS must be a non-negative integer" >&2; exit 2 ;;
esac
if [ "$LOCK_WAIT_SECONDS" -gt 600 ]; then
  echo "ERROR: FLYWHEEL_DISCORD_LOCK_WAIT_SECONDS must be <= 600" >&2
  exit 2
fi

process_incarnation() {
  ps -p "$1" -o lstart= 2>/dev/null | awk '{$1=$1; print}'
}

write_lock_owner() {
  local temporary="${LOCK_DIR}/.owner.$$"
  LOCK_INCARNATION="$(process_incarnation $$)"
  [ -n "$LOCK_INCARNATION" ] || return 1
  printf '%s|%s\n' "$$" "$LOCK_INCARNATION" > "$temporary" || return 1
  mv "$temporary" "$LOCK_OWNER"
}

release_lock() {
  local owner_pid="" owner_incarnation=""
  [ -d "$LOCK_DIR" ] || return 0
  IFS='|' read -r owner_pid owner_incarnation < "$LOCK_OWNER" 2>/dev/null || return 0
  if [ "$owner_pid" = "$$" ] && [ "$owner_incarnation" = "$LOCK_INCARNATION" ]; then
    rm -f "$LOCK_OWNER"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}

break_stale_lock() {
  local observed_pid="$1" observed_incarnation="$2"
  local breaker="${LOCK_DIR}/.breaker.$$" current_pid="" current_incarnation=""
  local stale_dir="${LOCK_DIR}.stale.$$"

  # The breaker directory makes the incumbent's rmdir fail, freezing this
  # exact lock generation while we re-read its owner. If the incumbent
  # released and a successor acquired between our first read and this mkdir,
  # the changed owner below is preserved and we back away.
  mkdir "$breaker" 2>/dev/null || return 1
  if IFS='|' read -r current_pid current_incarnation < "$LOCK_OWNER" 2>/dev/null; then
    if [ "$current_pid" != "$observed_pid" ] \
        || [ "$current_incarnation" != "$observed_incarnation" ]; then
      rmdir "$breaker" 2>/dev/null || true
      return 1
    fi
    if mv "$LOCK_DIR" "$stale_dir" 2>/dev/null; then
      rm -rf "$stale_dir"
      return 0
    fi
    rmdir "$breaker" 2>/dev/null || true
    return 1
  fi

  # The observed owner legitimately released after our first read. Its rmdir
  # was held off by the breaker; finish that release without stealing a new
  # generation, then let the normal acquire loop retry.
  rmdir "$breaker" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null
}

mkdir -p "$(dirname "$LOCK_DIR")"
deadline=$(( $(date +%s) + LOCK_WAIT_SECONDS ))
while true; do
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    if ! write_lock_owner; then
      rmdir "$LOCK_DIR" 2>/dev/null || true
      echo "ERROR: could not persist Discord update lock ownership" >&2
      exit 1
    fi
    break
  fi

  owner_pid=""; owner_incarnation=""; live_incarnation=""
  if IFS='|' read -r owner_pid owner_incarnation < "$LOCK_OWNER" 2>/dev/null \
      && [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] \
      && [ -n "$owner_incarnation" ]; then
    live_incarnation="$(process_incarnation "$owner_pid" || true)"
    if [ -z "$live_incarnation" ] || [ "$live_incarnation" != "$owner_incarnation" ]; then
      if break_stale_lock "$owner_pid" "$owner_incarnation"; then
        continue
      fi
    fi
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ERROR: timed out waiting for Discord plugin update lock: $LOCK_DIR (owner=${owner_pid:-unknown})" >&2
    exit 1
  fi
  sleep 1
done
trap 'release_lock' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Recheck inside the lock. A concurrent launcher may already have completed it.
if "$CHECKER" >/dev/null 2>&1; then
  exit 0
fi

claude plugin marketplace update "$MARKETPLACE"
claude plugin update "$PLUGIN_KEY" --scope user

if ! "$CHECKER"; then
  echo "ERROR: Claude CLI returned success but ${PLUGIN_KEY} still fails integrity checks" >&2
  exit 1
fi

echo "UPDATED: ${PLUGIN_KEY} now matches fork main; restart the Lead to load it"
