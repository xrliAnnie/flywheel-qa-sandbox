#!/bin/bash
# FLY-151: launchd → run-bridge.ts thin wrapper.
#
# launchd cannot source .bashrc or .env files, so this wrapper handles
# environment setup before exec-ing the real Bridge process. Mirrors the
# pattern established by scripts/flywheel-lead-wrapper.sh (FLY-74).
#
# Usage: flywheel-bridge-wrapper.sh
#   Invoked by launchd plist ProgramArguments — not intended for manual use.
#   For manual Bridge startup, use scripts/run-bridge.ts directly via tsx.
set -euo pipefail

# FLY-650: resolve FLYWHEEL_DIR / FLYWHEEL_STATE_DIR from host.json (core/host
# config). Defaults == today's hardcoded values, so a host with NO host.json is
# byte-identical (the Bridge runs on both macOS and Linux, so this wrapper is on
# the portable path). A missing/broken lib falls back to the old hardcode.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SELF_DIR/lib/host-config.sh" ]]; then
  # shellcheck source=lib/host-config.sh
  source "$SELF_DIR/lib/host-config.sh"
  # FLY-650 (Codex R1 HIGH-2): FAIL-CLOSED on a malformed host.json. host_config_load
  # only fails on a PRESENT-but-broken host.json (absent → succeeds with defaults);
  # a broken core config must stop startup (launchd/systemd throttle-restarts +
  # the operator is alerted) rather than silently start the WRONG checkout.
  if ! host_config_load >/dev/null; then
    echo "[bridge-wrapper] FATAL: host.json invalid (fail-closed) — fix it and restart" >&2
    exit 1
  fi
fi
FLYWHEEL_DIR="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
FLYWHEEL_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}"
ENV_FILE="${FLYWHEEL_STATE_DIR}/.env"
PID_FILE="${FLYWHEEL_STATE_DIR}/pids/bridge.pid"

log() { echo "[bridge-wrapper] $(date '+%H:%M:%S') $*"; }

# ── Source environment (fail-fast) ─────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  log "ERROR: Environment file not found: ${ENV_FILE}"
  exit 1
fi
# `set -a` auto-exports every variable assigned while sourcing. Without it,
# bare `KEY=value` lines in ~/.flywheel/.env (the common case) would set
# shell-local vars only and never reach the exec'd Node process — defeating
# the whole purpose of this wrapper. Mirrors restart-services.sh:34-37.
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

# ── Expand PATH for launchd minimal env ────────────────────────
# launchd provides only /usr/bin:/bin:/usr/sbin:/sbin.
# tsx, npx, node, jq, brew tools live outside that.
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:${PATH}"

# ── FLY-516: port preflight — guarantee :PORT is ours before binding ────────
# Root-cures batch restart #2: an orphan Bridge stuck mid-close() keeps :9876
# bound, so the launchd-respawned Bridge crash-loops on EADDRINUSE for ~30min.
# Runs on EVERY launchd start (kickstart / bootout+bootstrap / KeepAlive
# respawn), so it self-heals regardless of how the restart was triggered.
# Decision logic + crash-loop detection live in scripts/lib/bridge-port.sh
# (hermetically unit-tested); this wrapper only supplies the fail-loud fan-out.
BRIDGE_PORT_LIB="${FLYWHEEL_DIR}/scripts/lib/bridge-port.sh"
if [[ -f "$BRIDGE_PORT_LIB" ]]; then
  # shellcheck source=lib/bridge-port.sh
  source "$BRIDGE_PORT_LIB"

  BRIDGE_URL="${BRIDGE_URL:-http://localhost:${TEAMLEAD_PORT:-9876}}"
  BRIDGE_PORT="$(bp_port_from_url "$BRIDGE_URL")"
  # FLY-650: FLYWHEEL_STATE_DIR is the state ROOT (~/.flywheel); the wrapper's
  # markers live in its /state subdir. Resolves to the SAME path as before.
  STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state"
  START_MARKER="${STATE_DIR}/bridge-wrapper-starts"
  mkdir -p "$STATE_DIR" 2>/dev/null || true

  # Fail-loud: meta-alert.sh is Bridge-INDEPENDENT (desktop + local file) so it
  # surfaces even while the Bridge is down; Discord is best-effort on top. This
  # overrides the lib's no-op bp_fail_loud seam.
  META_ALERT="${FLYWHEEL_DIR}/scripts/meta-alert.sh"
  bp_fail_loud() {
    local reason="$1" title="$2" body="$3"
    # >&2: never write to stdout — bp_launcher_preflight's verdict is captured via
    # `$(...)`; stdout here would defeat the preflight branch (Codex R2 HIGH). The
    # lib also redirects, but keep the override clean too.
    log "FAIL-LOUD [$reason] $title — $body" >&2
    [[ -x "$META_ALERT" ]] && "$META_ALERT" "$reason" "$title" "$body" || true
    # FLY-927 (D4): the Discord leg prefers the GATED lead-alert.sh pipeline
    # (unified channel + single sender identity + claims dedup; kind =
    # bridge_wrapper_fail with the conventional system identity). Minute-level
    # signature: launchd crash-loop retries collapse to ≤1 post/min while a
    # DISTINCT later failure still rings. Script missing / non-zero → the
    # direct-curl core-channel fallback below — the Bridge is DOWN here, so
    # delivery capability must never be lost (FLY-929 decision).
    local lead_alert="${FLYWHEEL_DIR}/scripts/lead-alert.sh"
    if [[ -x "$lead_alert" ]] && "$lead_alert" \
         --project flywheel --lead bridge \
         --kind bridge_wrapper_fail --severity severe \
         --title "$title" --body "$body" \
         --signature "${reason}-$(date -u +%Y%m%d%H%M)" >/dev/null 2>&1; then
      return 0
    fi
    local token="${SIMBA_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}"
    if [[ -n "$token" && -n "${DISCORD_CORE_CHANNEL:-}" ]] && command -v jq >/dev/null 2>&1; then
      curl -sf -X POST "https://discord.com/api/v10/channels/${DISCORD_CORE_CHANNEL}/messages" \
        -H "Authorization: Bot ${token}" -H "Content-Type: application/json" \
        -d "$(jq -n --arg c "🚨 ${title} — ${body}" '{content:$c}')" --max-time 5 >/dev/null 2>&1 || true
    fi
  }

  PREFLIGHT_ACTION="$(bp_launcher_preflight "$BRIDGE_PORT" "$BRIDGE_URL" "$START_MARKER")"
  case "$PREFLIGHT_ACTION" in
    already-healthy)
      log "Healthy Bridge already serving :${BRIDGE_PORT} — exit 0 (double-start guard)."
      exit 0
      ;;
    stuck)
      # bp_launcher_preflight already fired the fail-loud alert. Exit non-zero so
      # launchd throttles (ThrottleInterval) rather than tight-looping on a port
      # we can't bind; a human has been notified.
      log "Port :${BRIDGE_PORT} could not be reclaimed — refusing to start (alerted). Exit 1."
      exit 1
      ;;
    bind|*)
      : # port is ours — proceed.
      ;;
  esac
else
  log "WARNING: ${BRIDGE_PORT_LIB} not found — skipping port preflight (degraded)."
fi

# ── PID lock — prevent double-start ────────────────────────────
# Secondary guard for the pre-bind boot race (a peer wrapper has exec'd node but
# not yet bound the port, so the port preflight above saw it "free"). The port
# preflight is authoritative for an already-bound Bridge (it tells a healthy
# server apart from a zombie via /health); this only covers the booting peer.
if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -n "${EXISTING_PID:-}" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    log "Bridge already running (PID ${EXISTING_PID}). Exit 0 — launchd retries after ThrottleInterval."
    exit 0
  fi
fi
mkdir -p "$(dirname "$PID_FILE")"
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

cd "$FLYWHEEL_DIR"
log "Starting Bridge (TEAMLEAD_CHAT_THREADS_ENABLED=${TEAMLEAD_CHAT_THREADS_ENABLED:-unset})"

# exec replaces this wrapper process so launchd directly manages the
# Bridge process (correct PID tracking, signal delivery, KeepAlive).
exec npx tsx scripts/run-bridge.ts
