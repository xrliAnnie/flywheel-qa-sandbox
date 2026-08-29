#!/bin/bash
# FLY-871 §12 W1 — verify a windowed (cmux TUI) Codex Lead is actually up, LAYER BY
# LAYER, as a read-only bring-up evidence gate.
#
# Background (research R-10): a windowed Codex Lead is a chain — launchd job →
# codex-lead-tui-runtime process → remote-control daemon socket → tmux window →
# a pane actually running `codex`. When it "looks broken", the failure could be at
# ANY link, and the previous bring-up had no way to localize it (the misdiagnosis
# that produced this re-plan). This script probes each link independently, prints
# a PASS/FAIL per layer, and its non-zero exit code names the FIRST failing layer.
#
# READ-ONLY: it never bootstraps the job, opens a window, or kills a process. It is
# safe to run repeatedly during bring-up. The FIX actions (launchctl bootstrap, the
# TUI runtime's own 20s liveness re-ensure) live elsewhere.
#
# Usage:
#   verify-windowed-lead.sh <project> <leadId> \
#     [--label <launchd-label>]   # default com.flywheel.lead.<project>-<leadId>
#     [--codex-home <dir>]        # default $CODEX_HOME or ~/.codex-infra-bot
#     [--log <path>]              # launchd stdout/err log (diagnostic layer only)
#
# Exit codes:
#   0        — all of layers 1-5 PASS (the window is up)
#   10 + N   — layer N (1-5) is the FIRST failing layer
#   2        — usage error
#
# Layers:
#   1  launchd job loaded AND running (a live pid)
#   2  that pid is the TUI runtime (node …/codex-lead-tui-runtime.js) — NEVER the
#      launcher path (its argv is replaced by `exec node`, so pgrep-ing it is a
#      false-red; Codex R1#2)
#   3  the remote-control daemon socket exists
#   4  the tmux window <project>-<leadId> is alive (identity-echo — same check as
#      isTuiWindowAlive: '#{window_name} #{pane_dead}' == '<window> 0')
#   5  the pane is actually running codex (not a bare zsh/bash husk)
#   6  DIAGNOSTIC ONLY (not in the exit code): launchd log tail. A healthy 20s
#      liveness loop does NOT log a green tick, so "no recent 'real TUI up' line"
#      is NOT a failure — only layers 1-5 (live probes) decide (Codex R1#2).
set -u

TMUX_SESSION="flywheel"
RUNTIME_RE='codex-lead-tui-runtime'

# Command indirection so tests can inject hermetic fakes (same spirit as
# test-lead-alert-dedup.sh). Default to the real binaries.
LAUNCHCTL_BIN="${FLYWHEEL_VERIFY_LAUNCHCTL:-launchctl}"
TMUX_BIN="${FLYWHEEL_VERIFY_TMUX:-tmux}"
PS_BIN="${FLYWHEEL_VERIFY_PS:-ps}"

usage() {
  sed -n '15,33p' "$0" >&2
  exit 2
}

if [ $# -lt 2 ]; then usage; fi
case "$1" in -h|--help) usage ;; esac
PROJECT="$1"
LEAD="$2"
shift 2

LABEL=""
CODEX_HOME_ARG=""
LOG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --label)      LABEL="${2:?--label requires a value}"; shift 2 ;;
    --codex-home) CODEX_HOME_ARG="${2:?--codex-home requires a value}"; shift 2 ;;
    --log)        LOG="${2:?--log requires a value}"; shift 2 ;;
    -h|--help)    usage ;;
    *) echo "verify-windowed-lead: unknown argument '$1'" >&2; usage ;;
  esac
done

LABEL="${LABEL:-com.flywheel.lead.${PROJECT}-${LEAD}}"
CODEX_HOME_RESOLVED="${CODEX_HOME_ARG:-${CODEX_HOME:-${HOME}/.codex-infra-bot}}"
WINDOW="${PROJECT}-${LEAD}"
TARGET="=${TMUX_SESSION}:=${WINDOW}"
UID_NUM="$(id -u)"

FIRST_FAIL=0
record_layer() {
  # $1 = layer number, $2 = PASS|FAIL, $3 = message
  local n="$1" st="$2" msg="$3"
  if [ "$st" = "PASS" ]; then
    printf 'layer %s  PASS  %s\n' "$n" "$msg"
  else
    printf 'layer %s  FAIL  %s\n' "$n" "$msg"
    if [ "$FIRST_FAIL" -eq 0 ]; then FIRST_FAIL="$n"; fi
  fi
}

echo "verify-windowed-lead: project=${PROJECT} lead=${LEAD} label=${LABEL}"
echo "                      codexHome=${CODEX_HOME_RESOLVED} window=${WINDOW}"
echo ""

# ── Layer 1: launchd job loaded AND running (a live pid) ──────────────────────
LC_OUT="$("$LAUNCHCTL_BIN" print "gui/${UID_NUM}/${LABEL}" 2>/dev/null)"
LC_RC=$?
PID=""
if [ $LC_RC -ne 0 ] || [ -z "$LC_OUT" ]; then
  record_layer 1 FAIL "launchd job ${LABEL} not loaded (launchctl print failed — bootstrap it?)"
else
  STATE="$(printf '%s\n' "$LC_OUT" | awk -F' = ' '/^[[:space:]]*state = /{gsub(/[^a-z]/,"",$2); print $2; exit}')"
  PID="$(printf '%s\n' "$LC_OUT" | awk -F' = ' '/^[[:space:]]*pid = /{gsub(/[^0-9]/,"",$2); print $2; exit}')"
  if [ -n "$PID" ]; then
    record_layer 1 PASS "launchd job ${LABEL} running (pid ${PID}, state=${STATE:-running})"
  else
    record_layer 1 FAIL "launchd job ${LABEL} loaded but NOT running (no pid; state=${STATE:-unknown} — crash loop?)"
  fi
fi

# ── Layer 2: that pid is the TUI runtime (node …/codex-lead-tui-runtime.js) ────
if [ -n "$PID" ]; then
  CMD="$("$PS_BIN" -p "$PID" -o command= 2>/dev/null)"
  if printf '%s' "$CMD" | grep -q 'node' && printf '%s' "$CMD" | grep -q "$RUNTIME_RE"; then
    record_layer 2 PASS "pid ${PID} is the TUI runtime (node …/${RUNTIME_RE}.js)"
  else
    record_layer 2 FAIL "pid ${PID} is NOT the TUI runtime (command: ${CMD:-<none>})"
  fi
else
  # No pid from layer 1: fall back to pgrep the RUNTIME JS path — NEVER the launcher
  # path (its argv is replaced by `exec node "$TUI_RUNTIME"`, so a launcher-path
  # pgrep would false-red a healthy deployment; Codex R1#2).
  if pgrep -f "${RUNTIME_RE}\.js" >/dev/null 2>&1; then
    record_layer 2 PASS "TUI runtime process found via pgrep (${RUNTIME_RE}.js)"
  else
    record_layer 2 FAIL "no TUI runtime process (pid unknown, pgrep ${RUNTIME_RE}.js empty)"
  fi
fi

# ── Layer 3: remote-control daemon socket exists ──────────────────────────────
SOCK="${CODEX_HOME_RESOLVED}/app-server-control/app-server-control.sock"
if [ -e "$SOCK" ]; then
  record_layer 3 PASS "daemon socket present (${SOCK})"
else
  record_layer 3 FAIL "daemon socket missing (${SOCK})"
fi

# ── Layer 4: tmux window alive (identity-echo — same as isTuiWindowAlive) ──────
W_OUT="$("$TMUX_BIN" display-message -p -t "$TARGET" '#{window_name} #{pane_dead}' 2>/dev/null)"
if [ "$W_OUT" = "${WINDOW} 0" ]; then
  record_layer 4 PASS "tmux window '${WINDOW}' alive in session '${TMUX_SESSION}'"
else
  record_layer 4 FAIL "tmux window '${WINDOW}' not alive (got '${W_OUT:-<none>}', want '${WINDOW} 0')"
fi

# ── Layer 5: the pane is actually running codex (not a bare shell husk) ────────
P_OUT="$("$TMUX_BIN" display-message -p -t "$TARGET" '#{pane_current_command}' 2>/dev/null)"
case "$P_OUT" in
  *codex*)
    record_layer 5 PASS "pane runs codex (current command: ${P_OUT})" ;;
  ""|zsh|-zsh|bash|-bash|sh|login)
    record_layer 5 FAIL "pane is a bare shell / empty (current command: '${P_OUT:-<none>}' — TUI died to a husk?)" ;;
  *)
    record_layer 5 FAIL "pane current command is not codex (got '${P_OUT}')" ;;
esac

# ── Layer 6: DIAGNOSTIC ONLY (not part of the exit code) ───────────────────────
echo ""
echo "── layer 6 (diagnostic — NOT part of the exit code) ──"
if [ -n "$LOG" ] && [ -f "$LOG" ]; then
  echo "launchd log tail (${LOG}):"
  tail -n 20 "$LOG" 2>/dev/null | sed 's/^/    /'
  if tail -n 200 "$LOG" 2>/dev/null | grep -qiE 'fatal|panic'; then
    echo "    ⚠ 'fatal'/'panic' present in recent log — inspect above."
  fi
  if tail -n 500 "$LOG" 2>/dev/null | grep -q 'tui-window: real TUI up'; then
    echo "    note: a 'real TUI up' line is present in the recent log."
  else
    echo "    note: no recent 'real TUI up' line — this is NOT a failure. A healthy 20s"
    echo "          liveness loop logs no green tick; layers 1-5 (live probes) decide."
  fi
else
  echo "(launchd log not provided/found — pass --log <path> to include it; not a failure)"
fi

# ── Result ────────────────────────────────────────────────────────────────────
echo ""
if [ "$FIRST_FAIL" -eq 0 ]; then
  echo "RESULT: PASS — windowed lead ${WINDOW} is up (layers 1-5 green)."
  exit 0
fi
echo "RESULT: FAIL — first failing layer = ${FIRST_FAIL} (exit $((10 + FIRST_FAIL)))."
exit $((10 + FIRST_FAIL))
