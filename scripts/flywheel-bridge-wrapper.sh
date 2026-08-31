#!/bin/bash
# FLY-151: launchd → run-bridge.ts thin wrapper.
#
# launchd cannot source .bashrc or .env files, so this wrapper handles
# environment setup before exec-ing the real Bridge process. Mirrors the
# pattern used by the Lead launch wrapper (FLY-74).
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
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

# FLY-2190: this wrapper can be born directly from launchd KeepAlive, bypassing
# updater and restart-services. Gate here before a preflight can consume the
# PATH that S1 will change. Prefer the converged state-bin copy, but first
# deployment must fall back to the gate in the live checkout because launchd
# can birth this wrapper before restart-services reaches convergence.
host_tmux_gate_fail_loud() {
  local rc="$1"
  local bounded_run="${FLYWHEEL_DIR}/scripts/lib/bounded-run.sh"
  local meta_alert="${FLYWHEEL_META_ALERT_BIN:-${FLYWHEEL_DIR}/scripts/meta-alert.sh}"
  local reason="host_tmux_selection_gate_unavailable_bridge"
  local title="Bridge host tmux selection gate unavailable"
  local body="Host tmux selection gate failed with exit ${rc}; refusing to launch the Bridge until host selection authority is restored."
  log "FAIL-LOUD [${reason}] ${title} — ${body}" >&2
  if [ -x "$bounded_run" ] && [ -x "$meta_alert" ]; then
    "$bounded_run" "${FLYWHEEL_META_ALERT_TIMEOUT_S:-15}" \
      "$meta_alert" "$reason" "$title" "$body" >/dev/null 2>&1 || true
  else
    log "FAIL-LOUD notifier unavailable (bounded-run=${bounded_run}, meta-alert=${meta_alert})." >&2
  fi
}

HOST_TMUX_GATE_DEFAULT="${FLYWHEEL_STATE_DIR}/bin/host-tmux-selection-gate.sh"
HOST_TMUX_GATE_FALLBACK="${FLYWHEEL_DIR}/scripts/host-tmux-selection-gate.sh"
HOST_TMUX_GATE_OVERRIDE="${FLYWHEEL_HOST_TMUX_GATE_BIN:-}"
if [ -n "$HOST_TMUX_GATE_OVERRIDE" ]; then
  HOST_TMUX_GATE_BIN="$HOST_TMUX_GATE_OVERRIDE"
  case "$FLYWHEEL_STATE_DIR" in
    /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) : ;;
    *)
      log "Host tmux gate override is not allowed for the production state root — refusing to launch the Bridge."
      host_tmux_gate_fail_loud 126
      exit 0
      ;;
  esac
elif [ -f "$HOST_TMUX_GATE_DEFAULT" ] && [ ! -L "$HOST_TMUX_GATE_DEFAULT" ] \
  && [ -x "$HOST_TMUX_GATE_DEFAULT" ]; then
  HOST_TMUX_GATE_BIN="$HOST_TMUX_GATE_DEFAULT"
else
  HOST_TMUX_GATE_BIN="$HOST_TMUX_GATE_FALLBACK"
fi
unset HOST_TMUX_GATE_OVERRIDE
# Fixture-only observation seams must never ride a sourced production .env.
unset FLYWHEEL_HOST_TMUX_GATE_TEST_MODE \
  FLYWHEEL_HOST_TMUX_POST_S1_PATH \
  FLYWHEEL_HOST_TMUX_EXPECTED_CANONICAL_PATH \
  FLYWHEEL_HOST_TMUX_FILE_BIN \
  FLYWHEEL_HOST_TMUX_HOST_ID \
  FLYWHEEL_HOST_TMUX_GATE_APPLICABILITY \
  FLYWHEEL_HOST_TMUX_GATE_NOW_EPOCH \
  FLYWHEEL_HOST_TMUX_GATE_TTL_SECONDS
HOST_TMUX_TARGET_SHA="$(/usr/bin/git -C "$FLYWHEEL_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
if [ -z "$HOST_TMUX_TARGET_SHA" ] && [ -f "${FLYWHEEL_STATE_DIR}/deployed-sha" ]; then
  HOST_TMUX_TARGET_SHA="$(/bin/cat "${FLYWHEEL_STATE_DIR}/deployed-sha" 2>/dev/null || true)"
fi
if [ -z "$HOST_TMUX_TARGET_SHA" ] && [ -f "${FLYWHEEL_DIR}/.flywheel-build-sha" ] \
  && [ ! -L "${FLYWHEEL_DIR}/.flywheel-build-sha" ]; then
  HOST_TMUX_TARGET_SHA="$(/bin/cat "${FLYWHEEL_DIR}/.flywheel-build-sha" 2>/dev/null || true)"
fi
HOST_TMUX_GATE_RC=0
FLYWHEEL_HOST_TMUX_TARGET_SHA="$HOST_TMUX_TARGET_SHA" \
FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
  "$HOST_TMUX_GATE_BIN" gate bridge || HOST_TMUX_GATE_RC=$?
if [ "$HOST_TMUX_GATE_RC" -eq 0 ]; then
  FLYWHEEL_HOST_TMUX_TARGET_SHA="$HOST_TMUX_TARGET_SHA" \
  FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION="keepalive:bridge" \
  FLYWHEEL_HOST_TMUX_MOUNT_POINT="scripts/flywheel-bridge-wrapper.sh" \
    "$HOST_TMUX_GATE_BIN" verify bridge || HOST_TMUX_GATE_RC=$?
fi
if [ "$HOST_TMUX_GATE_RC" -ne 0 ]; then
  log "Host tmux selection gate held or unavailable (exit ${HOST_TMUX_GATE_RC}) — refusing to launch the Bridge."
  host_tmux_gate_fail_loud "$HOST_TMUX_GATE_RC"
  exit 0
fi

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
    # FLY-1081: this direct-curl leg runs ONLY when lead-alert.sh is missing/
    # failed AND the Bridge is down. The core-channel TARGET stays — a
    # gate-approved explicit exception: when the alert pipeline itself is
    # broken, better a wrong-channel post than a lost Bridge-death signal.
    # The sender IDENTITY, however, resolves via the FLY-927 seam (indirect
    # expansion, semantics aligned with lead-alert.sh:243-247) — the old
    # Simba/legacy-bot-token fallback was the FLY-915 pain-#3 bug. Seam
    # unresolvable → stderr ERROR + return 0 (the meta-alert above already
    # fired; no Discord leg is left). stdout stays EMPTY throughout — this
    # function runs inside the $(bp_launcher_preflight …) capture (Codex R2
    # HIGH constraint). Token rides a curl stdin config, never argv.
    local sender_env="${FLYWHEEL_ALERT_SENDER_TOKEN_ENV:-}"
    local token=""
    [[ -n "$sender_env" ]] && token="${!sender_env:-}"
    if [[ -z "$token" ]]; then
      log "ERROR: fallback curl cannot resolve FLYWHEEL_ALERT_SENDER_TOKEN_ENV='${sender_env}' — refusing legacy fallback" >&2
      return 0
    fi
    if [[ -n "${DISCORD_CORE_CHANNEL:-}" ]] && command -v jq >/dev/null 2>&1; then
      curl -sf -X POST "https://discord.com/api/v10/channels/${DISCORD_CORE_CHANNEL}/messages" \
        -H "Content-Type: application/json" \
        -d "$(jq -n --arg c "🚨 ${title} — ${body}" '{content:$c}')" \
        --max-time 5 -K - >/dev/null 2>&1 <<CURLCFG || true
header = "Authorization: Bot ${token}"
CURLCFG
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

# ── FLY-1501: durable restart-storm ceiling ─────────────────────
# Placement is load-bearing: both single-instance guards have finished, but
# this launch has not written its PID/running markers yet. Count only a wrapper
# invocation that will actually launch the Bridge.
RESTART_STORM_GATE_BIN="${FLYWHEEL_RESTART_STORM_GATE_BIN:-${FLYWHEEL_DIR}/scripts/restart-storm-gate.py}"
# `set -e` aborts on a bare non-zero command, so the exit code must be
# captured in an errexit-exempt `||` list — otherwise a held brake would
# kill this wrapper with the gate's status and launchd would read the
# hold as a crash.
RESTART_STORM_RC=0
"$RESTART_STORM_GATE_BIN" gate bridge || RESTART_STORM_RC=$?
if [ "$RESTART_STORM_RC" -ne 0 ]; then
  if [ "$RESTART_STORM_RC" -eq 126 ] || [ "$RESTART_STORM_RC" -eq 127 ]; then
    # Bounded and synchronous, via the shared helper. Unbounded would let a
    # hung osascript inside meta-alert.sh pin this launch path so launchd
    # never retries once the brake is restored; detached would let launchd
    # kill the notifier with the job's process group before it writes its
    # marker, restoring the silence this branch removes.
    "${FLYWHEEL_DIR}/scripts/lib/bounded-run.sh" \
      "${FLYWHEEL_META_ALERT_TIMEOUT_S:-15}" \
      "${FLYWHEEL_META_ALERT_BIN:-${FLYWHEEL_DIR}/scripts/meta-alert.sh}" \
      restart_storm_gate_unavailable_bridge \
      "Restart brake unavailable" \
      "restart-storm-gate.py is missing or not executable (exit ${RESTART_STORM_RC}); the Bridge will not launch until it is restored." \
      >/dev/null 2>&1 || true
    log "Restart brake missing or not executable (exit ${RESTART_STORM_RC}) — refusing to launch the Bridge."
  else
    log "Restart-storm gate held or refused Bridge startup — not writing PID marker."
  fi
  exit 0
fi

mkdir -p "$(dirname "$PID_FILE")"
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

# ── FLY-1082 (Task 2.4): dirty-exit marker page — the Bridge-INDEPENDENT
# fast path. A "running" marker here means the previous Bridge died without a
# clean shutdown (the 2026-07-09 fatal-exit shape). READ-ONLY: the booting
# Bridge latches + rewrites the marker itself. FAIL-OPEN throughout — this
# block must never stop the Bridge from starting (alerting aid, not a gate).
# Placement (Codex R1 MED-1 + R2 MED-4): AFTER the port preflight AND the PID
# lock, and ONLY on the "bind" verdict — a duplicate start against a healthy
# Bridge (already-healthy verdict OR a live pre-bind peer holding the PID
# lock) exits above and never reads the live instance's own `running` marker
# as a death; a "stuck" verdict is not a respawn either (its own fail-loud
# already fired) so it must not claim "已由 launchd 复活".
if type bp_check_dirty_marker >/dev/null 2>&1 \
   && [[ "${PREFLIGHT_ACTION:-}" == "bind" ]]; then
  BRIDGE_RUN_MARKER="${FLYWHEEL_BRIDGE_MARKER:-${STATE_DIR}/bridge-running-marker.json}"
  DIRTY_STREAK_MARKER="${STATE_DIR}/bridge-dirty-exits"
  DIRTY_VERDICT="$(bp_check_dirty_marker "$BRIDGE_RUN_MARKER" || echo none)"
  if [[ "$DIRTY_VERDICT" == dirty\ * ]]; then
    read -r _ PREV_PID PREV_BOOT_TS <<<"$DIRTY_VERDICT"
    EPISODE_SIG="bridge-abnormal-exit:${PREV_PID}:${PREV_BOOT_TS}"
    # Crash-loop streak: >=3 dirty boots inside 10 min upgrades the copy —
    # launchd is respawning into repeated deaths, a human should look now.
    if bp_record_dirty_and_check_streak "$DIRTY_STREAK_MARKER" 600 3; then
      DIRTY_TITLE="Bridge 非正常退出（已由 launchd 复活）"
      DIRTY_BODY="上一个 Bridge (PID ${PREV_PID}, boot ${PREV_BOOT_TS}) 没有走 clean shutdown 就死了。本次启动即复活;复活后的 Bridge 会开生命周期工单对账（episode ${EPISODE_SIG}）。"
    else
      DIRTY_TITLE="Bridge crash-loop（10 分钟内 ≥3 次非正常退出）"
      DIRTY_BODY="Bridge 反复非正常退出后被 launchd 复活（最近一枚 dirty marker: PID ${PREV_PID}, boot ${PREV_BOOT_TS}, episode ${EPISODE_SIG}）。需要人看 /tmp/flywheel-bridge.log、${FLYWHEEL_STATE_DIR}/state/bridge-startup.log、${FLYWHEEL_STATE_DIR}/state/bridge-log-rotation-error.json + 机器内存水位。"
    fi
    # The page id is the WRAPPER leg's own dedup identity — deliberately
    # distinct from the boot ticket id (shared episode signature correlates
    # them; identical ids would let claims.db swallow the later leg).
    "${FLYWHEEL_DIR}/scripts/lead-alert.sh" \
      --project flywheel --lead bridge \
      --kind bridge_abnormal_exit --severity severe \
      --title "$DIRTY_TITLE" --body "$DIRTY_BODY" \
      --signature "bridge-abnormal-exit-page:${PREV_PID}:${PREV_BOOT_TS}" \
      >/dev/null 2>&1 || log "dirty-marker page failed (non-fatal; boot ticket leg remains)"
  fi
fi

cd "$FLYWHEEL_DIR"

# FLY-2049: launchd's StandardOutPath is inherited as a long-lived FD. A
# rename-only rotator cannot reclaim that FD: later writes keep landing in .1.
# Release it before exec and let run-bridge install strict short-FD appends.
# The separate raw capture preserves tsx/module-loader/V8 failures that happen
# before the TypeScript entry can install the adapter; single `>` bounds it to
# the latest launch attempt.
BRIDGE_RUNTIME_STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state"
export FLYWHEEL_BRIDGE_LOG_PATH="${FLYWHEEL_BRIDGE_LOG_PATH:-/tmp/flywheel-bridge.log}"
export FLYWHEEL_BRIDGE_RAW_STARTUP_LOG="${FLYWHEEL_BRIDGE_RAW_STARTUP_LOG:-${BRIDGE_RUNTIME_STATE_DIR}/bridge-startup.log}"
export FLYWHEEL_BRIDGE_LOG_ERROR_MARKER="${FLYWHEEL_BRIDGE_LOG_ERROR_MARKER:-${BRIDGE_RUNTIME_STATE_DIR}/bridge-log-rotation-error.json}"

BRIDGE_RAW_STARTUP_REDIRECT=/dev/null
if ! mkdir -p "$BRIDGE_RUNTIME_STATE_DIR"; then
  log "WARNING: cannot create Bridge runtime state directory $BRIDGE_RUNTIME_STATE_DIR; continuing via /dev/null"
elif [[ ! -d "$BRIDGE_RUNTIME_STATE_DIR" || -L "$BRIDGE_RUNTIME_STATE_DIR" ]]; then
  log "WARNING: unsafe Bridge runtime state directory $BRIDGE_RUNTIME_STATE_DIR; continuing via /dev/null"
elif [[ "$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG" != /* ]]; then
  log "WARNING: Bridge raw startup log is not absolute ($FLYWHEEL_BRIDGE_RAW_STARTUP_LOG); continuing via /dev/null"
else
  BRIDGE_RAW_STARTUP_PARENT="$(dirname "$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG")"
  if ! mkdir -p "$BRIDGE_RAW_STARTUP_PARENT"; then
    log "WARNING: cannot create Bridge raw startup parent $BRIDGE_RAW_STARTUP_PARENT; continuing via /dev/null"
  elif [[ ! -d "$BRIDGE_RAW_STARTUP_PARENT" || -L "$BRIDGE_RAW_STARTUP_PARENT" ]]; then
    log "WARNING: unsafe Bridge raw startup parent $BRIDGE_RAW_STARTUP_PARENT; continuing via /dev/null"
  elif [[ -e "$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG" || -L "$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG" ]] \
     && [[ ! -f "$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG" || -L "$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG" ]]; then
    log "WARNING: unsafe Bridge raw startup log $FLYWHEEL_BRIDGE_RAW_STARTUP_LOG; continuing via /dev/null"
  else
    BRIDGE_RAW_STARTUP_REDIRECT="$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG"
  fi
fi
exec > "$BRIDGE_RAW_STARTUP_REDIRECT" 2>&1
log "Starting Bridge (TEAMLEAD_CHAT_THREADS_ENABLED=${TEAMLEAD_CHAT_THREADS_ENABLED:-unset})"

# exec replaces this wrapper process so launchd directly manages the
# Bridge process (correct PID tracking, signal delivery, KeepAlive).
# FLY-1062: a PACKAGED install ships a compiled dist/run-bridge.js (no tsx /
# TypeScript on customer machines) — exec node when it exists. A monorepo
# checkout has no dist/run-bridge.js, so the tsx line below stays the verbatim
# production path (reverse-compat sentinel: packaged-seams.test.sh).
if [[ -f "$FLYWHEEL_DIR/dist/run-bridge.js" ]]; then
  exec node dist/run-bridge.js
fi
exec npx tsx scripts/run-bridge.ts
