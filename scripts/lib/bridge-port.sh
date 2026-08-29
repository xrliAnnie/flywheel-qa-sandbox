#!/usr/bin/env bash
# FLY-516: shared Bridge-port helpers for restart hardening.
#
# Used by scripts/flywheel-bridge-wrapper.sh (start-time preflight) and
# scripts/restart-services.sh (stop_bridge port-release poll) to guarantee the
# old Bridge's port (:9876) is truly released before a new Bridge binds —
# root-curing the "orphan Bridge holds the port → launchd KeepAlive crash-loops
# on EADDRINUSE → 30-min wedge" incident (batch restart #2).
#
# Sourceable. All real IO (lsof / kill / curl / sleep) goes through overridable
# seams so the logic is hermetically unit-testable (scripts/__tests__/bridge-port.test.sh)
# without touching a real port, process, or the network.
#
# Functions:
#   bp_port_listeners <port>                 → echo listener PIDs (one per line)
#   bp_port_is_free   <port>                 → rc 0 = free (no listener)
#   bp_wait_port_free <port> <timeout_s> [interval_s]
#                                            → poll until free; rc 0 = freed, 1 = still occupied
#   bp_reclaim_port   <port> <term_wait_s> <kill_wait_s>
#                                            → TERM → wait → KILL → poll; rc 0 = released, 1 = can't
#   bp_probe_health   <base_url>             → echo healthy | shutting_down | down

# ── Seams (overridden in tests) ─────────────────────────────────────────────
# LISTEN-state TCP listener PIDs on a port. `-t` = terse (PIDs only), the most
# portable lsof subset. Failure (no listener / lsof denied) → empty (fail-open:
# treat as free so a transient lsof error never wedges Bridge startup).
_bp_listeners() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }
_bp_kill()      { kill "$@" 2>/dev/null; }
_bp_curl()      { curl -sf --max-time "${BP_HEALTH_TIMEOUT_S:-2}" "$1" 2>/dev/null; }
_bp_sleep()     { sleep "$1"; }
_bp_now()       { date +%s; }

# Parse the TCP port out of a base URL (http://host:PORT/...). Falls back to
# 9876 (the Bridge default, TEAMLEAD_PORT) when there is no explicit port.
bp_port_from_url() {
  local p
  p="$(printf '%s' "$1" | sed -E 's#^[a-zA-Z]+://[^/]*:([0-9]+).*#\1#')"
  if [[ "$p" =~ ^[0-9]+$ ]]; then printf '%s\n' "$p"; else printf '9876\n'; fi
}

# ── Queries ─────────────────────────────────────────────────────────────────
bp_port_listeners() { _bp_listeners "$1" | awk 'NF'; }

bp_port_is_free() {
  local pids
  pids="$(bp_port_listeners "$1")"
  [[ -z "$pids" ]]
}

# Poll until the port is free or the timeout elapses. Checks at the top of each
# interval, then a final check after the loop (so timeout 0 = single immediate
# check). Returns 0 the moment it sees the port free.
bp_wait_port_free() {
  local port="$1" timeout="${2:-10}" interval="${3:-1}" waited=0
  while (( waited < timeout )); do
    bp_port_is_free "$port" && return 0
    _bp_sleep "$interval"
    waited=$(( waited + interval ))
  done
  bp_port_is_free "$port"
}

# Reclaim a held port: SIGTERM the listeners, wait for graceful release, then
# SIGKILL whatever still listens, and wait again. Returns 0 if the port ends up
# free, 1 if it cannot be reclaimed (caller should fail-loud).
bp_reclaim_port() {
  local port="$1" term_wait="${2:-10}" kill_wait="${3:-5}" pids
  pids="$(bp_port_listeners "$port")"
  [[ -z "$pids" ]] && return 0   # already free

  # Intentionally word-split the PID list into separate kill targets.
  # shellcheck disable=SC2086
  _bp_kill -TERM $pids
  bp_wait_port_free "$port" "$term_wait" && return 0

  # Re-resolve: the surviving listener may differ from the original set.
  pids="$(bp_port_listeners "$port")"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    _bp_kill -KILL $pids
  fi
  bp_wait_port_free "$port" "$kill_wait"
}

# Classify a Bridge by probing GET <base_url>/health:
#   healthy        — ok:true && shuttingDown:false (a real serving Bridge)
#   shutting_down  — shuttingDown:true (mid-close(), zombie-in-the-making)
#   legacy         — valid JSON but NO shuttingDown field (a pre-FLY-516 Bridge)
#   down           — no/garbage response (not a serving Bridge)
# Only "healthy" makes the caller yield the port; everything else is reclaim-eligible.
#
# HIGH (Codex R1): a legacy Bridge's /health can't signal shutting-down, so a
# legacy instance stuck in close() still answers `{ok:true}` — trusting ok:true
# there would let the very first FLY-516 deploy (or a mixed-version direct launchd
# restart) classify a stuck legacy zombie as "already-healthy" and re-wedge. So an
# absent shuttingDown field is reported as "legacy" (NOT healthy) → the caller
# reclaims it. A graceful SIGTERM to a genuinely-healthy legacy Bridge is just a
# clean restart (the deploy was restarting it anyway); SIGKILL fallback covers a
# legacy that itself hangs on SIGTERM. This ambiguity is transient — after this
# fix ships, every Bridge emits shuttingDown.
bp_probe_health() {
  local url="${1%/}" body
  body="$(_bp_curl "${url}/health")" || { echo "down"; return 0; }
  [[ -z "$body" ]] && { echo "down"; return 0; }
  # Must be a JSON object to be a real /health response.
  if ! printf '%s' "$body" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo "down"; return 0
  fi
  if ! printf '%s' "$body" | jq -e 'has("shuttingDown")' >/dev/null 2>&1; then
    echo "legacy"; return 0
  fi
  local shutting ok
  shutting="$(printf '%s' "$body" | jq -r '.shuttingDown // false' 2>/dev/null || echo "false")"
  ok="$(printf '%s' "$body" | jq -r 'if .ok == true then "true" else "false" end' 2>/dev/null || echo "false")"
  if [[ "$shutting" == "true" ]]; then
    echo "shutting_down"
  elif [[ "$ok" == "true" ]]; then
    echo "healthy"
  else
    echo "down"
  fi
}

# Decide what a Bridge launcher should do about the port before binding.
# Echoes exactly one action:
#   "bind"            — port is ours to bind (free now, or reclaimed from a zombie)
#   "already-healthy" — a healthy Bridge already serves here → caller exits 0 (no double-start)
#   "stuck"           — port held and could not be reclaimed → caller fail-louds + exits 1
#
# Sequence: free → bind. Held + healthy → yield. Held + shutting_down/down/legacy
# → give Layer-0 bounded shutdown a grace window to release the port on its own
# (respects in-flight drain), re-probe (a fresh Bridge may have claimed it during
# the grace), then force-reclaim. Only "healthy" yields — "legacy" (no shuttingDown
# field) is reclaim-eligible (Codex R1 HIGH; see bp_probe_health).
bp_ensure_port_for_start() {
  local port="$1" url="$2" grace="${3:-25}" term_wait="${4:-5}" kill_wait="${5:-5}"
  if bp_port_is_free "$port"; then echo "bind"; return 0; fi
  if [[ "$(bp_probe_health "$url")" == "healthy" ]]; then
    echo "already-healthy"; return 0
  fi
  # Zombie / draining holder. Wait out the bounded-shutdown window first.
  if bp_wait_port_free "$port" "$grace"; then echo "bind"; return 0; fi
  # A healthy Bridge may have claimed the freed port during the grace — re-probe
  # before killing anything so we never reclaim a live double-start winner.
  if [[ "$(bp_probe_health "$url")" == "healthy" ]]; then
    echo "already-healthy"; return 0
  fi
  if bp_reclaim_port "$port" "$term_wait" "$kill_wait"; then echo "bind"; return 0; fi
  echo "stuck"; return 0
}

# ── FLY-1082 (Task 2.4): dirty-exit marker check (READ-ONLY) ────────────────
# The Bridge writes ~/.flywheel/state/bridge-running-marker.json ("running" at
# boot, flipped to "clean" by close()). A "running" marker at wrapper start
# time = the previous Bridge died WITHOUT a clean shutdown. This check only
# READS — the marker is latched+overwritten by the booting Bridge itself
# (evidence before overwrite). Echoes exactly one verdict:
#   "dirty <prevPid> <prevBootTs>" | "clean" | "none"
# FAIL-OPEN by design: jq missing / unreadable / garbage → "none" (the marker
# is an alerting aid, never a startup gate — the Bridge must always come up).
bp_check_dirty_marker() {
  local marker="$1"
  [[ -f "$marker" ]] || { echo "none"; return 0; }
  command -v jq >/dev/null 2>&1 || { echo "none"; return 0; }
  local state pid boot_ts
  state="$(jq -r '.state // empty' "$marker" 2>/dev/null || true)"
  case "$state" in
    running)
      pid="$(jq -r '.pid // empty' "$marker" 2>/dev/null || true)"
      boot_ts="$(jq -r '.bootTs // empty' "$marker" 2>/dev/null || true)"
      [[ "$pid" =~ ^[0-9]+$ && "$boot_ts" =~ ^[0-9]+$ ]] || { echo "none"; return 0; }
      echo "dirty $pid $boot_ts"
      ;;
    clean) echo "clean" ;;
    *) echo "none" ;;
  esac
}

# FLY-1082 (Task 2.4): dirty-exit streak counter — same prune-window pattern as
# bp_record_start_and_check_crashloop, but counting DIRTY boots specifically.
# Returns 0 = under threshold, 1 = crash-loop (>= max_dirty within window_s).
bp_record_dirty_and_check_streak() {
  local marker="$1" window="${2:-600}" max_dirty="${3:-3}" now
  now="$(_bp_now)"
  printf '%s\n' "$now" >> "$marker"
  local recent=() ts
  while IFS= read -r ts; do
    [[ "$ts" =~ ^[0-9]+$ ]] || continue
    if (( now - ts <= window )); then recent+=("$ts"); fi
  done < "$marker"
  printf '%s\n' "${recent[@]}" > "$marker"
  (( ${#recent[@]} < max_dirty ))
}

# Crash-loop detector: append now to a marker, prune entries older than the
# window, and report whether the start rate breached the threshold.
# Returns: 0 = OK (under threshold), 1 = crash-loop (>= max_starts in window_s).
# The marker is rewritten pruned each call so it never grows unbounded.
bp_record_start_and_check_crashloop() {
  local marker="$1" window="${2:-60}" max_starts="${3:-3}" now
  now="$(_bp_now)"
  printf '%s\n' "$now" >> "$marker"
  local recent=() ts
  while IFS= read -r ts; do
    [[ "$ts" =~ ^[0-9]+$ ]] || continue
    if (( now - ts <= window )); then recent+=("$ts"); fi
  done < "$marker"
  printf '%s\n' "${recent[@]}" > "$marker"
  (( ${#recent[@]} < max_starts ))
}

# Fail-loud seam. Overridden by flywheel-bridge-wrapper.sh / restart-services.sh to
# fan out to meta-alert.sh (Bridge-independent) + best-effort Discord. Default no-op
# so the lib is usable/testable standalone. Signature: <reason> <title> <body>.
#
# CONTRACT (Codex R2 HIGH): bp_launcher_preflight / bp_confirm_port_released emit a
# machine-readable verdict on STDOUT that the caller captures via `$(...)`. Every
# bp_fail_loud invocation below therefore redirects its stdout to stderr (`1>&2`)
# so an override that logs (the real ones call `log`, which prints to stdout) can
# NEVER contaminate the captured verdict — otherwise "stuck" becomes
# "FAIL-LOUD…\nstuck", the `== "stuck"` check fails, and the fail-CLOSED guard
# silently turns fail-OPEN. The redirect makes this structurally impossible
# regardless of how the override is written.
bp_fail_loud() { :; }

# Launcher-level preflight orchestration (used by flywheel-bridge-wrapper.sh).
# 1) record this start; alert (non-blocking) if the start rate is a crash-loop;
# 2) decide the port action; alert if the port is stuck.
# Echoes the action ("bind" | "already-healthy" | "stuck") for the caller to act
# on. Crash-loop alerting NEVER blocks the start — this very start may be the
# recovery (e.g. the port preflight below reclaims a zombie).
bp_launcher_preflight() {
  local port="$1" url="$2" marker="$3"
  local cl_window="${4:-60}" cl_max="${5:-3}"
  local grace="${6:-25}" term_wait="${7:-5}" kill_wait="${8:-5}"

  if ! bp_record_start_and_check_crashloop "$marker" "$cl_window" "$cl_max"; then
    # 1>&2: keep the override's logging off this function's captured stdout.
    bp_fail_loud "bridge_crash_loop" "Bridge restart crash-loop" \
      "flywheel-bridge-wrapper.sh started >= ${cl_max} times within ${cl_window}s (port :${port}). Likely a stuck port or a bad build — check /tmp/flywheel-bridge.log." 1>&2
  fi

  local action
  action="$(bp_ensure_port_for_start "$port" "$url" "$grace" "$term_wait" "$kill_wait")"
  if [[ "$action" == "stuck" ]]; then
    bp_fail_loud "bridge_port_stuck" "Bridge port :${port} stuck" \
      "Could not reclaim :${port} from a non-healthy holder before starting the Bridge. launchd may crash-loop on EADDRINUSE — a manual SIGKILL of the listener (lsof -ti:${port}) may be required." 1>&2
  fi
  printf '%s\n' "$action"
}

# Confirm a port is actually released AFTER a stop (used by restart-services.sh
# stop_bridge). `kill -9` on the listener PID does NOT guarantee the socket is
# gone (a different holder, or lingering state) — so poll, then reclaim any
# surviving listener, then fail-loud if it stays bound (the next Bridge would
# hit EADDRINUSE). Echoes "released" | "stuck".
bp_confirm_port_released() {
  local port="$1" wait_s="${2:-10}" term_wait="${3:-5}" kill_wait="${4:-5}"
  if bp_wait_port_free "$port" "$wait_s"; then echo "released"; return 0; fi
  if bp_reclaim_port "$port" "$term_wait" "$kill_wait"; then echo "released"; return 0; fi
  # 1>&2: keep the override's logging off this function's captured stdout.
  bp_fail_loud "bridge_port_stuck" "Bridge port :${port} stuck after stop" \
    "stop_bridge could not free :${port} (kill + reclaim both failed). A new Bridge will fail to bind — a manual SIGKILL of the listener (lsof -ti:${port}) may be required." 1>&2
  echo "stuck"; return 0
}
