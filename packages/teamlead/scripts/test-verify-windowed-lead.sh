#!/bin/bash
# FLY-871 §12 W1 — hermetic test for verify-windowed-lead.sh.
#
# Injects fake launchctl / tmux / ps via FLYWHEEL_VERIFY_* env indirection (same
# spirit as test-lead-alert-dedup.sh) + a temp CODEX_HOME so each scenario drives
# the probes deterministically. Asserts:
#   - all green → exit 0
#   - each layer's failure → exit 10+layer (and it is the FIRST failing layer)
#   - all green but no 'real TUI up' in the log → still PASS (Codex R1#2 false-red
#     regression guard: the diagnostic layer must not affect the exit code)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${HERE}/verify-windowed-lead.sh"

if [ ! -x "$SCRIPT" ]; then
  echo "FAIL: $SCRIPT missing or not executable" >&2
  exit 1
fi

TMPROOT="$(mktemp -d -t flywheel-verify-windowed.XXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

BIN="${TMPROOT}/bin"
mkdir -p "$BIN"

# ── fake launchctl ────────────────────────────────────────────────────────────
# `print gui/UID/LABEL`: emit a block with a pid unless FAKE_LC_ABSENT=1, or emit
# a loaded-but-not-running block (no pid) when FAKE_LC_NOPID=1.
cat > "${BIN}/launchctl" <<'SH'
#!/bin/bash
if [ "${1:-}" = "print" ]; then
  if [ "${FAKE_LC_ABSENT:-0}" = "1" ]; then exit 1; fi
  echo "${2} = {"
  echo "	state = running"
  if [ "${FAKE_LC_NOPID:-0}" != "1" ]; then
    echo "	pid = ${FAKE_LC_PID:-4242}"
  fi
  echo "}"
  exit 0
fi
exit 0
SH
chmod +x "${BIN}/launchctl"

# ── fake ps ───────────────────────────────────────────────────────────────────
# `-p PID -o command=` → echo FAKE_PS_CMD.
cat > "${BIN}/ps" <<'SH'
#!/bin/bash
echo "${FAKE_PS_CMD:-}"
exit 0
SH
chmod +x "${BIN}/ps"

# ── fake tmux ─────────────────────────────────────────────────────────────────
# display-message with '#{window_name} #{pane_dead}' → FAKE_TMUX_WINDOW
# display-message with '#{pane_current_command}'      → FAKE_TMUX_PANECMD
cat > "${BIN}/tmux" <<'SH'
#!/bin/bash
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *pane_current_command*) echo "${FAKE_TMUX_PANECMD:-}" ;;
  *pane_dead*)            echo "${FAKE_TMUX_WINDOW:-}" ;;
  *) echo "" ;;
esac
exit 0
SH
chmod +x "${BIN}/tmux"

export FLYWHEEL_VERIFY_LAUNCHCTL="${BIN}/launchctl"
export FLYWHEEL_VERIFY_PS="${BIN}/ps"
export FLYWHEEL_VERIFY_TMUX="${BIN}/tmux"

PROJECT="flywheel"
LEAD="codex-infra-bot-lead"
WINDOW="${PROJECT}-${LEAD}"
CODEX_HOME_DIR="${TMPROOT}/codex-home"
SOCK_DIR="${CODEX_HOME_DIR}/app-server-control"
mkdir -p "$SOCK_DIR"

# All-green defaults (each scenario overrides one).
green_env() {
  export FAKE_LC_ABSENT=0
  export FAKE_LC_NOPID=0
  export FAKE_LC_PID=4242
  export FAKE_PS_CMD="node /Users/x/Dev/flywheel/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js"
  export FAKE_TMUX_WINDOW="${WINDOW} 0"
  export FAKE_TMUX_PANECMD="codex"
  # socket present
  : > "${SOCK_DIR}/app-server-control.sock"
}

run() {
  # runs the script; captures exit code into RC (no set -e so we can assert).
  "$SCRIPT" "$PROJECT" "$LEAD" --codex-home "$CODEX_HOME_DIR" "$@" >"${TMPROOT}/out" 2>&1
  RC=$?
}

errors=0
check_rc() {
  # $1 = expected rc, $2 = scenario name
  if [ "$RC" != "$1" ]; then
    echo "FAIL: [$2] expected exit $1, got $RC" >&2
    echo "----- output -----" >&2
    cat "${TMPROOT}/out" >&2
    echo "------------------" >&2
    errors=$((errors + 1))
  else
    echo "PASS: [$2] exit $RC"
  fi
}

# 1) all green → 0
green_env
run
check_rc 0 "all-green"

# 2) layer 1 fail (job not loaded) → 11
green_env
export FAKE_LC_ABSENT=1
run
check_rc 11 "layer1-not-loaded"

# 2b) layer 1 fail (loaded but no pid) → 11
green_env
export FAKE_LC_NOPID=1
run
check_rc 11 "layer1-no-pid"

# 3) layer 2 fail (pid is a bare shell, not the runtime) → 12
green_env
export FAKE_PS_CMD="-zsh"
run
check_rc 12 "layer2-wrong-process"

# 4) layer 3 fail (socket missing) → 13
green_env
rm -f "${SOCK_DIR}/app-server-control.sock"
run
check_rc 13 "layer3-no-socket"

# 5) layer 4 fail (window dead: pane_dead=1) → 14
green_env
export FAKE_TMUX_WINDOW="${WINDOW} 1"
run
check_rc 14 "layer4-window-dead"

# 5b) layer 4 fail (identity mismatch: tmux resolved a different window) → 14
green_env
export FAKE_TMUX_WINDOW="some-other-window 0"
run
check_rc 14 "layer4-identity-mismatch"

# 6) layer 5 fail (pane is a bare shell) → 15
green_env
export FAKE_TMUX_PANECMD="zsh"
run
check_rc 15 "layer5-bare-shell"

# 7) FIRST-failing-layer semantics: layers 1 AND 3 both broken → exit names layer 1
green_env
export FAKE_LC_ABSENT=1
rm -f "${SOCK_DIR}/app-server-control.sock"
run
check_rc 11 "first-fail-is-layer1"

# 8) all green but NO 'real TUI up' in the log → still PASS (false-red regression)
green_env
LOGFILE="${TMPROOT}/launchd.log"
{
  echo "some routine startup line"
  echo "another line with no green tick"
} > "$LOGFILE"
run --log "$LOGFILE"
check_rc 0 "green-without-real-tui-up-log"
if ! grep -q "no recent 'real TUI up' line" "${TMPROOT}/out"; then
  echo "FAIL: [green-without-real-tui-up-log] diagnostic note about missing 'real TUI up' not present" >&2
  errors=$((errors + 1))
fi

echo ""
if [ "$errors" -gt 0 ]; then
  echo "=== ${errors} scenario(s) FAILED ==="
  exit 1
fi
echo "PASS: all verify-windowed-lead.sh scenarios"
