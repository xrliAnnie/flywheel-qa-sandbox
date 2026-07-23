#!/usr/bin/env bash
# FLY-1256: install and enable the external Claude quota monitor.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLYWHEEL_DIR="${FLYWHEEL_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
ENV_FILE="${FLYWHEEL_ENV_FILE:-$STATE_DIR/.env}"
POOL_DIR="${FLYWHEEL_CLAUDE_PROFILES_DIR:-$STATE_DIR/claude-profiles}"
STORE_PATH="${FLYWHEEL_CLAUDE_ACCOUNTS_PATH:-$STATE_DIR/claude-accounts.json}"
CONFIG_PATH="${FLYWHEEL_QUOTA_MONITOR_CONFIG:-$STATE_DIR/quota-monitor.json}"
PIDFILE="${FLYWHEEL_QUOTA_PIDFILE:-$STATE_DIR/quota-monitor.pid}"
STATE_PATH="${FLYWHEEL_QUOTA_STATE_PATH:-$STATE_DIR/quota-monitor-state.json}"
LOG_PATH="${FLYWHEEL_QUOTA_LOG_PATH:-$STATE_DIR/logs/quota-monitor.log}"
PLIST_TEMPLATE="${FLYWHEEL_QUOTA_PLIST_TEMPLATE:-$FLYWHEEL_DIR/scripts/com.flywheel.quota-monitor.plist.template}"
PLIST_DEST="${FLYWHEEL_QUOTA_PLIST_DEST:-$HOME/Library/LaunchAgents/com.flywheel.quota-monitor.plist}"
LABEL="com.flywheel.quota-monitor"
LAUNCHCTL="${FLYWHEEL_QUOTA_LAUNCHCTL_BIN:-launchctl}"
RESTART_BIN="${FLYWHEEL_QUOTA_RESTART_BIN:-$FLYWHEEL_DIR/scripts/restart-services.sh}"
ALERT_BIN="${FLYWHEEL_LEAD_ALERT_BIN:-$FLYWHEEL_DIR/scripts/lead-alert.sh}"
HEALTH_TIMEOUT="${FLYWHEEL_QUOTA_HEALTH_TIMEOUT_SECONDS:-90}"
STOP_TIMEOUT="${FLYWHEEL_QUOTA_STOP_TIMEOUT_SECONDS:-30}"
MODE="enable"

log() { echo "[quota-monitor-setup] $*"; }
fail_loud() { # reason detail
  local reason="$1" detail="$2"
  echo "[quota-monitor-setup] ERROR: $detail" >&2
  if [[ -x "$ALERT_BIN" ]]; then
    "$ALERT_BIN" --lead quota-monitor --project flywheel \
      --kind quota_monitor_down --severity severe \
      --title "Claude quota monitor setup failed" --body "$detail" \
      --signature "quota-monitor-setup-${reason}-$(date -u +%Y%m%d%H%M)" \
      --strict-delivery >/dev/null || true
  fi
}
die() { fail_loud "$1" "$2"; exit 1; }

usage() {
  echo "Usage: setup-quota-monitor.sh [--monitor-only | --disable | --rollback-state]" >&2
  exit 2
}
while (( $# > 0 )); do
  case "$1" in
    --monitor-only) [[ "$MODE" == "enable" ]] || usage; MODE="monitor-only" ;;
    --disable) [[ "$MODE" == "enable" ]] || usage; MODE="disable" ;;
    --rollback-state) [[ "$MODE" == "enable" ]] || usage; MODE="rollback-state" ;;
    *) usage ;;
  esac
  shift
done

command -v jq >/dev/null 2>&1 || die "jq_missing" "jq is required"
[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || die "health_timeout" "health timeout must be an integer"
[[ "$STOP_TIMEOUT" =~ ^[0-9]+$ ]] || die "stop_timeout" "stop timeout must be an integer"

rollback_state_for_old_loader() {
  [[ -f "$STORE_PATH" && ! -L "$STORE_PATH" ]] \
    || die "rollback_store" "rollback requires a safe regular account store: $STORE_PATH"
  if [[ -e "$STATE_PATH" && ( -L "$STATE_PATH" || ! -f "$STATE_PATH" ) ]]; then
    die "rollback_state_unsafe" "rollback state must be absent or a regular non-symlink file: $STATE_PATH"
  fi
  command -v node >/dev/null 2>&1 || die "node_missing" "node is required for atomic rollback-state validation"
  node - "$STORE_PATH" "$STATE_PATH" <<'NODE' \
    || die "rollback_state_failed" "could not materialize an old-loader-compatible state at $STATE_PATH"
const fs = require("node:fs");
const path = require("node:path");
const storePath = process.argv[2];
const statePath = process.argv[3];
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nonNegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const generation = (value) => nonNegative(value) && Number.isInteger(value);
const nullableTime = (value) => value === null || nonNegative(value);
const exactKeys = (value, expected) => {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const profileName = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]+$/;
const attemptValid = (attempt) => exactKeys(attempt, ["attempts", "lastAttemptAt"])
  && generation(attempt.attempts) && attempt.attempts <= 3 && nonNegative(attempt.lastAttemptAt);
const reviveValid = (epoch) => {
  if (epoch === null) return true;
  if (!exactKeys(epoch, ["open", "sourceAccount", "generation", "openedAt", "expiresAt", "panes"])) return false;
  if (epoch.open !== true || typeof epoch.sourceAccount !== "string" || !profileName.test(epoch.sourceAccount)
      || !generation(epoch.generation) || !nonNegative(epoch.openedAt) || !nonNegative(epoch.expiresAt)
      || epoch.expiresAt <= epoch.openedAt || !isRecord(epoch.panes)) return false;
  return Object.entries(epoch.panes).every(([key, attempt]) => key.length > 0 && attemptValid(attempt));
};
const oldKeys = ["version", "lastPollAt", "lastSuccessfulUsageAt", "errorStreak", "backoffUntilMs", "tier", "lastCandidateSweepAt", "lastSwitchAt", "observedGeneration", "reviveEpoch"];
const oldValid = (state, storeGeneration) => exactKeys(state, oldKeys)
  && state.version === 1
  && nullableTime(state.lastPollAt)
  && nullableTime(state.lastSuccessfulUsageAt)
  && generation(state.errorStreak)
  && nonNegative(state.backoffUntilMs)
  && (state.tier === "base" || state.tier === "accelerated")
  && nullableTime(state.lastCandidateSweepAt)
  && nullableTime(state.lastSwitchAt)
  && generation(state.observedGeneration)
  && state.observedGeneration === storeGeneration
  && reviveValid(state.reviveEpoch);
const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
if (!isRecord(store) || !generation(store.generation) || !Array.isArray(store.accounts)) {
  throw new Error("invalid account store");
}
let current;
try { current = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
if (oldValid(current, store.generation)) process.exit(0);
let next = current;
if (isRecord(next)) {
  next = { ...next };
  delete next.blockedEpisode;
  delete next.pendingSwitchFailure;
  delete next.identityMismatchEpisodes;
  delete next.identityAlertCursor;
}
if (!oldValid(next, store.generation)) {
  next = {
    version: 1,
    lastPollAt: null,
    lastSuccessfulUsageAt: null,
    errorStreak: 0,
    backoffUntilMs: 0,
    tier: "base",
    lastCandidateSweepAt: null,
    lastSwitchAt: Date.now(),
    observedGeneration: store.generation,
    reviveEpoch: null,
  };
}
fs.mkdirSync(path.dirname(statePath), { recursive: true });
const tmp = `${statePath}.tmp.${process.pid}`;
let fd;
try {
  fd = fs.openSync(tmp, "wx", 0o600);
  fs.writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = undefined;
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, statePath);
} finally {
  if (fd !== undefined) fs.closeSync(fd);
  try { fs.unlinkSync(tmp); } catch {}
}
NODE
  log "rollback state is compatible with the previous daemon schema"
}

if [[ "$MODE" == "rollback-state" ]]; then
  rollback_state_for_old_loader
  exit 0
fi

set_env_key() { # key [value]; missing value removes key
  local key="$1" value="${2-}" tmp
  mkdir -p "$(dirname "$ENV_FILE")"
  [[ -f "$ENV_FILE" ]] || : > "$ENV_FILE"
  [[ ! -L "$ENV_FILE" ]] || die "unsafe_env" "$ENV_FILE is a symlink"
  tmp="${ENV_FILE}.tmp.$$"
  awk -v key="$key" 'index($0, key "=") != 1 {print}' "$ENV_FILE" > "$tmp"
  if (( $# == 2 )); then printf '%s=%s\n' "$key" "$value" >> "$tmp"; fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

if [[ "$MODE" == "disable" ]]; then
  "$LAUNCHCTL" bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_DEST"
  set_env_key FLYWHEEL_QUOTA_DAEMON_CUTOVER
  [[ -x "$RESTART_BIN" ]] || die "restart_missing" "Bridge restart command missing: $RESTART_BIN"
  "$RESTART_BIN" --reason env-change
  log "disabled daemon and restored the Bridge switch path"
  exit 0
fi

[[ -d "$POOL_DIR" && ! -L "$POOL_DIR" ]] || die "pool_missing" "safe profile pool missing: $POOL_DIR"
[[ -f "$STORE_PATH" && ! -L "$STORE_PATH" ]] || die "store_missing" "safe account store missing: $STORE_PATH"
[[ -f "$PLIST_TEMPLATE" ]] || die "plist_missing" "plist template missing: $PLIST_TEMPLATE"
[[ -x "$LAUNCHCTL" ]] || command -v "$LAUNCHCTL" >/dev/null 2>&1 \
  || die "launchctl_missing" "launchctl unavailable: $LAUNCHCTL"

write_default_config() {
  local order_json tmp account
  local -a order=(shopping school)
  while IFS= read -r account; do
    [[ "$account" == "shopping" || "$account" == "school" ]] && continue
    order+=("$account")
  done < <(find "$POOL_DIR" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null \
    | sed 's|.*/||' | LC_ALL=C sort)
  if [[ "$MODE" == "monitor-only" ]]; then order=(); fi
  if (( ${#order[@]} == 0 )); then
    order_json='[]'
  else
    order_json="$(printf '%s\n' "${order[@]}" | jq -Rsc 'split("\n")[:-1]')"
  fi
  tmp="${CONFIG_PATH}.tmp.$$"
  mkdir -p "$(dirname "$CONFIG_PATH")"
  jq -n --argjson order "$order_json" '{
    trigger5hPct:90,
    basePollMinutes:20,
    acceleratePct:70,
    acceleratedPollMinutes:10,
    candidateSweepMinutes:60,
    minSwitchIntervalMinutes:15,
    paneScanSeconds:60,
    confirmDelayMinutes:7,
    order:$order,
    writeStatuslineCache:true,
    degradedSwitch:false,
    episodeRealertMinutes:30
  }' > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$CONFIG_PATH"
}

if [[ ! -e "$CONFIG_PATH" ]]; then
  write_default_config
elif [[ -L "$CONFIG_PATH" || ! -f "$CONFIG_PATH" ]]; then
  die "unsafe_config" "config must be a regular non-symlink file: $CONFIG_PATH"
elif [[ "$MODE" == "monitor-only" ]]; then
  tmp="${CONFIG_PATH}.tmp.$$"
  jq '.order = []' "$CONFIG_PATH" > "$tmp" \
    || die "invalid_config" "cannot set monitor-only on invalid config"
  chmod 600 "$tmp"
  mv "$tmp" "$CONFIG_PATH"
fi

if ! jq -e '
  type == "object" and
  (.trigger5hPct | type == "number" and . >= 0 and . <= 100) and
  (.acceleratePct | type == "number" and . >= 0 and . < 100) and
  (.acceleratePct < .trigger5hPct) and
  (.basePollMinutes | type == "number" and . > 0 and . <= 1440) and
  (.acceleratedPollMinutes | type == "number" and . > 0 and . <= 1440) and
  (.acceleratedPollMinutes <= .basePollMinutes) and
  (.candidateSweepMinutes | type == "number" and . > 0 and . <= 10080) and
  (.minSwitchIntervalMinutes | type == "number" and . > 0 and . <= 1440) and
  ((.paneScanSeconds // 60) | type == "number" and . >= 1 and . <= 3600) and
  ((.confirmDelayMinutes // 7) | type == "number" and . >= 5 and . <= 10) and
  (.writeStatuslineCache | type == "boolean") and
  ((.degradedSwitch // false) | type == "boolean") and
  ((.episodeRealertMinutes // 30) | type == "number" and . >= 5 and . <= 1440) and
  (.order | type == "array" and all(.[]; type == "string") and length == (unique | length))
' "$CONFIG_PATH" >/dev/null; then
  die "invalid_config" "quota monitor config failed schema validation: $CONFIG_PATH"
fi

if [[ "$MODE" == "enable" ]] \
  && [[ "$(jq -r '.order | length' "$CONFIG_PATH")" == "0" ]]; then
  die "empty_order" "enable requires at least one configured target; use --monitor-only to keep the Bridge switch path active"
fi

validate_target() { # name
  local name="$1" profile="$POOL_DIR/$1" credential="$POOL_DIR/$1/.credentials.json" perms
  case "$name" in
    ""|.*|*..*|*[!A-Za-z0-9._-]*) die "invalid_target" "unsafe profile name in order: $name" ;;
  esac
  [[ -d "$profile" && ! -L "$profile" ]] \
    || die "invalid_target" "order target is not a safe pool directory: $name"
  [[ -f "$credential" && ! -L "$credential" ]] \
    || die "invalid_target" "order target lacks a safe pooled credential: $name"
  perms="$(stat -f '%Lp' "$credential" 2>/dev/null || true)"
  case "$perms" in
    ""|*[!0-9]*) perms="$(stat -c '%a' "$credential" 2>/dev/null || true)" ;;
  esac
  [[ "$perms" == "600" || "$perms" == "400" ]] \
    || die "invalid_target" "credential for $name must be mode 0600/0400"
  jq -e '.claudeAiOauth | (.accessToken | type == "string" and length > 0) and (.refreshToken | type == "string" and length > 0) and (.expiresAt | type == "number")' \
    "$credential" >/dev/null \
    || die "invalid_target" "credential for $name is not switchable"
  jq -e --arg name "$name" '
    [.accounts[] | select(.name == $name)] as $matches |
    ($matches | length) == 1 and
    (($matches[0].authExpired // false) == false) and
    (($matches[0].refreshTokenInvalid // false) == false) and
    (($matches[0].profileVerifyFailed // false) == false)
  ' "$STORE_PATH" >/dev/null \
    || die "invalid_target" "order target is missing or auth-unusable in account store: $name"
}

while IFS= read -r target; do validate_target "$target"; done \
  < <(jq -r '.order[]' "$CONFIG_PATH")

mkdir -p "$(dirname "$PLIST_DEST")"
[[ ! -L "$PLIST_DEST" ]] || die "unsafe_plist" "plist destination is a symlink: $PLIST_DEST"
plist_tmp="$(mktemp "$(dirname "$PLIST_DEST")/.quota-monitor.plist.XXXXXX")"
sed "s|__HOME__|$HOME|g" "$PLIST_TEMPLATE" > "$plist_tmp"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$plist_tmp" >/dev/null \
    || die "plist_invalid" "rendered plist failed plutil: $PLIST_DEST"
fi
old_pid="$(jq -r '.pid // empty' "$PIDFILE" 2>/dev/null || true)"
"$LAUNCHCTL" bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

pid_is_live() { # pid; zombies are no longer writing and count as stopped
  local pid="$1" state
  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  [[ -n "$state" && "$state" != Z* ]]
}
if [[ "$old_pid" =~ ^[1-9][0-9]*$ ]]; then
  stop_deadline=$(( $(date +%s) + STOP_TIMEOUT ))
  while pid_is_live "$old_pid" && (( $(date +%s) <= stop_deadline )); do sleep 0.1; done
  pid_is_live "$old_pid" \
    && die "stop_failed" "old quota monitor pid $old_pid did not stop within ${STOP_TIMEOUT}s"
fi

mkdir -p "$(dirname "$LOG_PATH")"
[[ ! -L "$LOG_PATH" && ! -L "$LOG_PATH.1" ]] \
  || die "unsafe_log" "quota monitor log path is symlinked: $LOG_PATH"
[[ ! -e "$LOG_PATH" || -f "$LOG_PATH" ]] \
  || die "unsafe_log" "quota monitor log is not a regular file: $LOG_PATH"
[[ ! -e "$LOG_PATH.1" || -f "$LOG_PATH.1" ]] \
  || die "unsafe_log" "quota monitor rotated log is not a regular file: $LOG_PATH.1"
rm -f "$LOG_PATH.1"
if [[ -f "$LOG_PATH" ]]; then mv "$LOG_PATH" "$LOG_PATH.1"; fi

mv "$plist_tmp" "$PLIST_DEST"
health_start_ms=$(( $(date +%s) * 1000 ))
"$LAUNCHCTL" bootstrap "gui/$(id -u)" "$PLIST_DEST" \
  || die "bootstrap_failed" "launchctl bootstrap failed for $LABEL"

base_poll_ms="$(jq -r '(.basePollMinutes * 60000) | floor' "$CONFIG_PATH")"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
healthy=0
while (( $(date +%s) <= deadline )); do
  pid="$(jq -r '.pid // empty' "$PIDFILE" 2>/dev/null || true)"
  last_poll="$(jq -r '.lastPollAt // empty' "$STATE_PATH" 2>/dev/null || true)"
  now_ms=$(( $(date +%s) * 1000 ))
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null \
    && [[ "$last_poll" =~ ^[0-9]+$ ]] \
    && (( last_poll >= health_start_ms )) \
    && (( now_ms - last_poll <= base_poll_ms )); then
    healthy=1
    break
  fi
  sleep 1
done
if (( healthy != 1 )); then
  "$LAUNCHCTL" bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  die "health_failed" "daemon did not produce a live pidfile + fresh state within ${HEALTH_TIMEOUT}s"
fi
log "daemon healthy (pid=$pid, lastPollAt=$last_poll)"

if [[ "$MODE" == "enable" ]]; then
  # No automatic-switch vacuum: retire the Bridge path only after the daemon is
  # independently healthy. The unified restart reloads the new env and notifies.
  set_env_key FLYWHEEL_QUOTA_DAEMON_CUTOVER 1
  [[ -x "$RESTART_BIN" ]] || die "restart_missing" "Bridge restart command missing: $RESTART_BIN"
  "$RESTART_BIN" --reason env-change \
    || die "restart_failed" "Bridge failed to reload CUTOVER after daemon health passed"
  log "enabled daemon and retired the Bridge switch path"
else
  log "monitor-only daemon healthy; Bridge switch path remains active"
fi
