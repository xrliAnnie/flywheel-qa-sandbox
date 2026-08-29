#!/usr/bin/env bash
# FLY-259 PR-F — Mufasa ③ TUI → headless rollback tool.
#
# Reverts the Mufasa cutover: stops the TUI launchd job, verifies the TUI runtime
# process (by its EXACT launchd job PID, not a fleet-wide pattern) actually exited,
# tears down its tmux window, restores the headless plist from the backup the
# cutover saved (validated to be the HEADLESS plist), and bootstraps headless.
# Memory is preserved either way (thread-id lives in the shared state dir
# ~/.flywheel/state/codex-lead/mufasa-lead, used by BOTH runtimes).
#
# SAFETY:
#   - Targets ONLY the label com.flywheel.lead.growth-mufasa-lead. Process liveness
#     is checked by the EXACT job PID launchd reports for that label — never a
#     `pgrep -f codex-lead-runtime` pattern (which matches every Codex Lead in the
#     fleet, Codex R1 HIGH-4). The tmux window is killed with the exact
#     `=session:=window` selector against the runtime's hard-coded `flywheel`
#     session (Codex R1 MED-1).
#   - Restores ONLY a backup verified to be the headless plist (not a TUI plist a
#     re-run cutover may have clobbered in, Codex R1 HIGH-3).
#   - DRY-RUN by default: prints the plan and exits 0. Pass --yes to actually act.
#   - This is an irreversible production action = run only with Annie's go-ahead.
#
# Usage:
#   rollback-codex-lead-mufasa-tui.sh            # dry-run (show the plan)
#   rollback-codex-lead-mufasa-tui.sh --yes      # perform the rollback
set -euo pipefail

LABEL="com.flywheel.lead.growth-mufasa-lead"
LA_DIR="${HOME}/Library/LaunchAgents"
PLIST="${LA_DIR}/${LABEL}.plist"
# The cutover MUST save the headless plist here BEFORE overwriting it (runbook uses
# `cp -n` so a re-run never clobbers the headless backup with the TUI plist).
HEADLESS_BACKUP="${LA_DIR}/${LABEL}.plist.pre-FLY-259-tui.bak"
# The runtime hard-codes its tmux session (tui-window.ts TUI_TMUX_SESSION) and the
# ③ window name (<project>-<leadId>). NOT configurable here — must match the runtime
# or we would leave the real window and/or kill a same-named window elsewhere.
TMUX_SESSION="flywheel"
WINDOW="growth-mufasa-lead"
# Identifies the HEADLESS wrapper a valid backup must point at (and must NOT be the
# TUI wrapper). Substring match against the plist ProgramArguments.
HEADLESS_WRAPPER="flywheel-codex-lead-wrapper-mufasa.sh"
TUI_WRAPPER="flywheel-codex-lead-wrapper-mufasa-tui.sh"

APPLY=0
[ "${1:-}" = "--yes" ] && APPLY=1

log() { echo "[rollback-mufasa-tui] $*"; }
die() { echo "[rollback-mufasa-tui] ERROR: $*" >&2; exit 1; }

GUI="gui/$(id -u)"

# Read the PID launchd currently reports for a label (empty if not running / absent).
# Codex R2 HIGH: an absent job makes `launchctl print` exit non-zero; under
# `set -euo pipefail` that would abort the whole rollback at `TUI_PID="$(job_pid)"`.
# The trailing `|| true` makes the function always succeed (absent job → empty pid),
# which is exactly the "not running" signal the callers expect.
job_pid() {
  launchctl print "${GUI}/${LABEL}" 2>/dev/null \
    | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\).*/\1/p' | head -1 || true
}

log "plan:"
log "  1. capture the TUI job's exact PID, then launchctl bootout ${GUI}/${LABEL}"
log "  2. wait for THAT pid to exit (exact PID — never a fleet-wide pgrep pattern)"
log "  3. tear down tmux window =${TMUX_SESSION}:=${WINDOW} if it lingers"
log "  4. validate ${HEADLESS_BACKUP} is the HEADLESS plist, then restore it"
log "  5. launchctl bootstrap ${GUI} ${PLIST}   (start headless Mufasa; RunAtLoad+KeepAlive)"
log "  6. verify launchd reports a running pid for ${LABEL}"

if [ "$APPLY" -ne 1 ]; then
  log "DRY-RUN — pass --yes to perform the rollback. Nothing changed."
  exit 0
fi

# Preconditions (fail-loud before touching anything).
command -v launchctl >/dev/null 2>&1 || die "launchctl not found"
[ -f "$HEADLESS_BACKUP" ] || die "headless plist backup missing at ${HEADLESS_BACKUP} — the cutover must save it (cp -n). Refusing to roll back without a known-good headless plist."
# HIGH-3: the backup must be the HEADLESS plist, not a TUI plist a re-run clobbered in.
if ! grep -q "$HEADLESS_WRAPPER" "$HEADLESS_BACKUP" || grep -q "$TUI_WRAPPER" "$HEADLESS_BACKUP"; then
  die "backup ${HEADLESS_BACKUP} does NOT look like the headless plist (expected ProgramArguments → ${HEADLESS_WRAPPER}, and NOT ${TUI_WRAPPER}). Restoring it would be a no-op rollback. Fix the backup by hand."
fi

# 1. Capture the exact TUI job PID BEFORE bootout (Mufasa-specific liveness signal).
TUI_PID="$(job_pid)"
log "TUI job pid before bootout: ${TUI_PID:-<none>}"

# 2. Stop the TUI job (bootout stops + disables until bootstrapped again).
log "booting out ${LABEL} …"
launchctl bootout "${GUI}/${LABEL}" 2>/dev/null || log "  (job not loaded — continuing)"

# 3. Verify THAT pid exited (exact PID — not a fleet pattern). Empty pid = already down.
if [ -n "$TUI_PID" ]; then
  for i in $(seq 1 10); do
    if ! kill -0 "$TUI_PID" 2>/dev/null; then
      log "  TUI runtime pid ${TUI_PID} exited."
      break
    fi
    [ "$i" -eq 10 ] && die "TUI runtime pid ${TUI_PID} still alive after bootout — investigate by hand before continuing (do NOT pattern-kill)."
    sleep 1
  done
fi

# Codex R5/R6 HIGH: resolve tmux through the SAME PATH search order the launchd
# wrapper uses, so the rollback probes the EXACT tmux client the runtime did — NOT
# whatever the operator's shell PATH resolves. Otherwise the "tmux absent / session
# unreachable → proceed" branches below would trust a FALSE absence: a restricted
# operator PATH could miss a wrapper tmux (e.g. in ~/.local/bin) and a different
# on-PATH tmux could be the wrong client — either way `command -v tmux` /
# `has-session` would report no window while the real `flywheel:growth-mufasa-lead`
# window is still alive → bootstrapping headless over a live orphan. We also clear
# TMUX_TMPDIR so the probe hits the SAME default socket the runtime used
# (tui-window.ts / the wrapper set no TMUX_TMPDIR).
#   FLYWHEEL_ROLLBACK_TMUX_PATH overrides the search order (tests inject a mock dir);
#   default = the wrapper's PATH, VERBATIM and IN ORDER (must stay in sync with
#   flywheel-codex-lead-wrapper-mufasa-tui.sh). Empty result = tmux genuinely not in
#   that order → no reachable tmux window can exist.
WRAPPER_TMUX_PATH="${FLYWHEEL_ROLLBACK_TMUX_PATH:-${HOME}/.local/bin:${HOME}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:${PATH}}"
TMUX_BIN="$(PATH="$WRAPPER_TMUX_PATH" command -v tmux || true)"
unset TMUX_TMPDIR

# 4. Tear down the lingering TUI window with the EXACT `=session:=window` selector
#    the runtime uses (never a prefix match across sessions). Three-state,
#    fail-closed where indeterminate (Codex R2/R3/R4 HIGH). With the wrapper-matched
#    tmux resolution above, a genuine "tmux absent / session unreachable" now truly
#    means no reachable window (no orphan possible) → safe to proceed.
#
#      - tmux not found in the wrapper's search order → no tmux window can exist (safe)
#      - session NOT reachable    → no window in our session → proceed (safe)
#      - session reachable but window list UNREADABLE → INDETERMINATE → fail-closed
#      - window present           → kill, then re-confirm gone (fail-closed on doubt)
if [ -z "$TMUX_BIN" ]; then
  : # tmux not in the wrapper's search order → a `codex resume --remote` window cannot exist
elif ! "$TMUX_BIN" has-session -t "$TMUX_SESSION" 2>/dev/null; then
  : # server/session not reachable → no window in our session → nothing to tear down
else
  # Session reachable → we MUST be able to read its window list; a read error is
  # indeterminate (server up but unreadable) and must not be assumed "no window".
  if ! windows=$("$TMUX_BIN" list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null); then
    die "tmux session ${TMUX_SESSION} is reachable but its window list could not be read — cannot determine whether the TUI window is present. Check by hand before rolling back (do NOT bootstrap headless blind)."
  fi
  if printf '%s\n' "$windows" | grep -qx "$WINDOW"; then
    log "killing lingering tmux window =${TMUX_SESSION}:=${WINDOW}"
    "$TMUX_BIN" kill-window -t "=${TMUX_SESSION}:=${WINDOW}" 2>/dev/null || true
    # Re-confirm gone. If the session is still up, positively confirm the window is
    # no longer listed; a re-probe that errors is indeterminate → fail loud. If the
    # session itself is gone (the window was its last), the window is gone → proceed.
    if "$TMUX_BIN" has-session -t "$TMUX_SESSION" 2>/dev/null; then
      if ! windows_after=$("$TMUX_BIN" list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null); then
        die "could not re-read tmux windows for session ${TMUX_SESSION} after kill-window — cannot confirm the TUI window is gone. Check by hand before rolling back."
      fi
      if printf '%s\n' "$windows_after" | grep -qx "$WINDOW"; then
        die "TUI window =${TMUX_SESSION}:=${WINDOW} survived kill — an orphan 'codex resume --remote' is still attached to the thread. Remove it by hand before rolling back (do NOT bootstrap headless over it)."
      fi
    fi
  fi
fi

# 5. Restore the (validated) headless plist.
log "restoring headless plist from backup"
cp "$HEADLESS_BACKUP" "$PLIST"

# 6. Bootstrap the headless job (RunAtLoad starts it).
log "bootstrapping headless ${LABEL} …"
launchctl bootstrap "${GUI}" "$PLIST"

# 7. Verify launchd reports a running pid for the label (Mufasa-specific).
for i in $(seq 1 15); do
  if [ -n "$(job_pid)" ]; then
    log "headless Mufasa is up (launchd pid $(job_pid)). Rollback complete."
    log "Verify in Discord (#mufasa) that Mufasa responds and remembers the conversation (thread-id continuity)."
    exit 0
  fi
  sleep 1
done
die "launchd did not report a running pid for ${LABEL} within 15s — check /tmp/flywheel-lead-growth-mufasa-lead.log"
