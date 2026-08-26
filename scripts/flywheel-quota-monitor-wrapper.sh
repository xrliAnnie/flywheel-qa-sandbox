#!/usr/bin/env bash
# FLY-1256: launchd wrapper for the external Claude quota monitor.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLYWHEEL_DIR="${FLYWHEEL_DIR:-$(cd "$SELF_DIR/.." && pwd)}"
ENV_FILE="${FLYWHEEL_QUOTA_ENV_FILE:-${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/.env}"

log() { echo "[quota-monitor-wrapper] $(date '+%Y-%m-%d %H:%M:%S') $*" >&2; }

# launchd has a sparse environment. Load the shared .env, but preserve every
# quota/profile value explicitly injected by the parent (QA relies on this to
# stay hermetic even when the production .env exists).
ENV_SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/flywheel-quota-env.XXXXXX")"
cleanup_snapshot() { rm -f "$ENV_SNAPSHOT"; }
trap cleanup_snapshot EXIT
export -p | grep -E '^declare -x FLYWHEEL_(QUOTA|CLAUDE)_' > "$ENV_SNAPSHOT" || true

if [[ ! -f "$ENV_FILE" ]]; then
  log "ERROR: environment file not found: $ENV_FILE"
  exit 1
fi
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

# Re-apply only values that existed before sourcing. Variables supplied solely
# by .env remain exported; colliding process values regain precedence.
# shellcheck source=/dev/null
source "$ENV_SNAPSHOT"
cleanup_snapshot
trap - EXIT

export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

MONITOR_BIN="${FLYWHEEL_QUOTA_MONITOR_BIN:-$FLYWHEEL_DIR/packages/teamlead/bin/flywheel-quota-monitor}"
MONITOR_DIST="${FLYWHEEL_QUOTA_MONITOR_DIST:-$FLYWHEEL_DIR/packages/teamlead/dist/account-heal/quota-monitor-cli.js}"
RUN_MARKER="${FLYWHEEL_QUOTA_RUN_MARKER:-$HOME/.flywheel/quota-monitor.running}"
CRASH_STREAK="${FLYWHEEL_QUOTA_CRASH_STREAK:-$HOME/.flywheel/quota-monitor-crashes}"
CRASH_WINDOW="${FLYWHEEL_QUOTA_CRASH_WINDOW_SECONDS:-600}"
CRASH_THRESHOLD="${FLYWHEEL_QUOTA_CRASH_THRESHOLD:-3}"
ALERT_BIN="${FLYWHEEL_LEAD_ALERT_BIN:-$FLYWHEEL_DIR/scripts/lead-alert.sh}"
LOG_PATH="${FLYWHEEL_QUOTA_LOG_PATH:-$HOME/.flywheel/logs/quota-monitor.log}"

fail_loud() { # reason title body signature
  local reason="$1" title="$2" body="$3" signature="$4"
  log "FAIL-LOUD [$reason] $title — $body"
  if [[ -x "$ALERT_BIN" ]]; then
    "$ALERT_BIN" \
      --lead quota-monitor --project flywheel \
      --kind quota_monitor_down --severity severe \
      --title "$title" --body "$body" \
      --signature "$signature" --strict-delivery >/dev/null || true
  fi
}

if [[ ! "$CRASH_WINDOW" =~ ^[1-9][0-9]*$ ]] || [[ ! "$CRASH_THRESHOLD" =~ ^[1-9][0-9]*$ ]]; then
  fail_loud "invalid_wrapper_config" "Claude quota monitor wrapper misconfigured" \
    "crash window/threshold must be positive integers" \
    "quota-monitor-wrapper-config-$(date -u +%Y%m%d)"
  exit 1
fi

# FLY-2051: the switch-family sender overrides the alert channel at delivery
# time. Refuse to boot without that route so a successful account switch can
# never be silently acknowledged while its founder notification is dropped.
NOTIFY_CHANNEL="${FLYWHEEL_NOTIFY_CHANNEL:-}"
if [[ -z "${NOTIFY_CHANNEL//[[:space:]]/}" ]]; then
  fail_loud "missing_notify_channel" "Claude quota monitor notification route missing" \
    "FLYWHEEL_NOTIFY_CHANNEL is empty; refusing to start the quota monitor" \
    "quota-monitor-notify-channel-missing-$(date -u +%Y%m%d)"
  exit 1
fi

if [[ ! -f "$MONITOR_DIST" || ! -x "$MONITOR_BIN" ]]; then
  fail_loud "dist_missing" "Claude quota monitor cannot start" \
    "daemon artifact missing (dist=$MONITOR_DIST, bin=$MONITOR_BIN)" \
    "quota-monitor-dist-missing-$(date -u +%Y%m%d)"
  exit 31
fi

# ── FLY-1501: durable restart-storm ceiling ─────────────────────
# This must precede even the legacy RUN_MARKER read: once held, launchd retries
# must not be miscounted as fresh quota-monitor crashes or mutate either marker.
RESTART_STORM_GATE_BIN="${FLYWHEEL_RESTART_STORM_GATE_BIN:-$FLYWHEEL_DIR/scripts/restart-storm-gate.py}"
# `set -e` aborts on a bare non-zero command, so the exit code must be
# captured in an errexit-exempt `||` list — otherwise a held brake would
# kill this wrapper with the gate's status and launchd would read the
# hold as a crash.
RESTART_STORM_RC=0
"$RESTART_STORM_GATE_BIN" gate quota-monitor || RESTART_STORM_RC=$?
if [ "$RESTART_STORM_RC" -ne 0 ]; then
  if [ "$RESTART_STORM_RC" -eq 126 ] || [ "$RESTART_STORM_RC" -eq 127 ]; then
    # Bounded and synchronous, via the shared helper. Unbounded would let a
    # hung osascript inside meta-alert.sh pin this launch path so launchd
    # never retries once the brake is restored; detached would let launchd
    # kill the notifier with the job's process group before it writes its
    # marker, restoring the silence this branch removes.
    "$FLYWHEEL_DIR/scripts/lib/bounded-run.sh" \
      "${FLYWHEEL_META_ALERT_TIMEOUT_S:-15}" \
      "${FLYWHEEL_META_ALERT_BIN:-$FLYWHEEL_DIR/scripts/meta-alert.sh}" \
      restart_storm_gate_unavailable_quota-monitor \
      "Restart brake unavailable" \
      "restart-storm-gate.py is missing or not executable (exit ${RESTART_STORM_RC}); quota-monitor will not launch until it is restored." \
      >/dev/null 2>&1 || true
    log "Restart brake missing or not executable (exit ${RESTART_STORM_RC}) — refusing to launch quota-monitor."
  else
    log "restart-storm gate held or refused quota-monitor startup; legacy markers untouched"
  fi
  exit 0
fi

mkdir -p "$(dirname "$RUN_MARKER")" "$(dirname "$CRASH_STREAK")"
if [[ -L "$RUN_MARKER" || -L "$CRASH_STREAK" ]]; then
  fail_loud "unsafe_marker" "Claude quota monitor marker is unsafe" \
    "refusing symlinked run/crash marker" \
    "quota-monitor-unsafe-marker-$(date -u +%Y%m%d)"
  exit 1
fi

# A marker left by the previous process means the CLI never reached graceful
# signal cleanup. Count only boots in a bounded window, then let launchd retry.
if [[ -f "$RUN_MARKER" ]]; then
  now="$(date +%s)"
  cutoff=$(( now - CRASH_WINDOW ))
  streak_tmp="$(mktemp "${CRASH_STREAK}.tmp.XXXXXX")"
  if [[ -f "$CRASH_STREAK" ]]; then
    awk -v cutoff="$cutoff" '$1 ~ /^[0-9]+$/ && $1 >= cutoff {print $1}' "$CRASH_STREAK" > "$streak_tmp"
  else
    : > "$streak_tmp"
  fi
  printf '%s\n' "$now" >> "$streak_tmp"
  chmod 600 "$streak_tmp"
  mv "$streak_tmp" "$CRASH_STREAK"
  crash_count="$(wc -l < "$CRASH_STREAK" | tr -d ' ')"
  if (( crash_count >= CRASH_THRESHOLD )); then
    fail_loud "crash_loop" "Claude quota monitor crash-loop" \
      "launchd observed ${crash_count} abnormal exits in ${CRASH_WINDOW}s; inspect $LOG_PATH" \
      "quota-monitor-crash-loop-$(date -u +%Y%m%d%H%M)"
  fi
fi

marker_tmp="$(mktemp "${RUN_MARKER}.tmp.XXXXXX")"
printf '{"pid":%d,"bootedAt":%d}\n' "$$" "$(( $(date +%s) * 1000 ))" > "$marker_tmp"
chmod 600 "$marker_tmp"
mv "$marker_tmp" "$RUN_MARKER"

cd "$FLYWHEEL_DIR"
log "starting external quota monitor"
exec "$MONITOR_BIN"
