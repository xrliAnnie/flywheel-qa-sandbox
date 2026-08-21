#!/bin/bash
# FLY-574 — permanently decommission a legacy companion daemon that shares a
# Discord bot token with the canonical Flywheel companion lead.
#
# THE BUG: Belle ran TWICE on one bot token (id 1509701064935477318):
#   - CANONICAL  belle-lead  via flywheel launchd
#       (com.flywheel.lead.personal-assistant-belle-lead → claude-lead.sh),
#       companion persona, subscribed to #leads-roundtable.
#   - LEGACY     belle/start.sh via com.xiaorongli.belle-daemon
#       (KeepAlive=true, RunAtLoad=true), BELLE.md persona, only #belle.
# Two supervisors → two gateway connections on one bot. Discord delivers a given
# MESSAGE_CREATE to one connection; #leads-roundtable messages landed on the
# legacy one, which is not subscribed to that channel, so they were dropped — the
# canonical lead never saw them. A `launchctl bootout` alone is only session-level:
# the plist stays in ~/Library/LaunchAgents with RunAtLoad+KeepAlive, so the dual
# respawns on the next login/reboot.
#
# THE FIX (permanent, idempotent):
#   1. bootout the launchd job (no-op if not loaded),
#   2. ARCHIVE the plist OUT of LaunchAgents so it can never RunAtLoad again,
#   3. FAIL-CLOSE the legacy start.sh (back it up once, replace with an inert stub
#      that refuses to launch a second process on the token), and
#   4. kill the legacy tmux session.
# `--verify` re-checks all four. Dry-run by default; pass --apply to execute.
#
# Reusable for any legacy companion daemon (defaults target the belle-daemon).
#
# Testability seams (unset in production → real behavior): LAUNCHCTL_BIN, TMUX_BIN.

set -euo pipefail

# ── Defaults (the belle-daemon case) — all overridable ──────────────────────
LABEL="com.xiaorongli.belle-daemon"
PLIST=""   # default derived from LABEL below if not given
START_SH="/Users/xiaorongli/Dev/personal-assistant/belle/start.sh"
TMUX_SOCKET="belle"
CANONICAL="belle-lead (com.flywheel.lead.personal-assistant-belle-lead → claude-lead.sh)"
MODE="dry-run"   # dry-run | apply | verify

LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"
# Follow the caller's PATH so every host entry point resolves the same upgraded
# tmux.  An explicit TMUX_BIN remains available for launchd and tests.
if [ -z "${TMUX_BIN:-}" ]; then
  TMUX_BIN="$(command -v tmux || printf '%s\n' tmux)"
fi

usage() {
  cat >&2 <<USAGE
Usage: decommission-legacy-companion-daemon.sh [--apply|--verify]
         [--label <launchd-label>] [--plist <path>] [--start-sh <path>]
         [--tmux-socket <name>] [--canonical <desc>]
Permanently retires a legacy companion daemon (default: the belle-daemon).
Dry-run by default; --apply executes; --verify checks the decommissioned state.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --label)        LABEL="${2:-}"; shift 2 ;;
    --plist)        PLIST="${2:-}"; shift 2 ;;
    --start-sh)     START_SH="${2:-}"; shift 2 ;;
    --tmux-socket)  TMUX_SOCKET="${2:-}"; shift 2 ;;
    --canonical)    CANONICAL="${2:-}"; shift 2 ;;
    --apply)        MODE="apply"; shift ;;
    --verify)       MODE="verify"; shift ;;
    --dry-run)      MODE="dry-run"; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "[decommission] ERROR: unknown arg '$1'" >&2; usage; exit 2 ;;
  esac
done

[ -z "$PLIST" ] && PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"
ARCHIVE="${PLIST}.decommissioned-fly574.bak"
START_BACKUP="${START_SH}.pre-fly574.bak"
SENTINEL="DECOMMISSIONED by FLY-574"

log() { echo "[decommission] $*"; }

# Write the inert fail-close stub over START_SH.
write_failclose_stub() {
  cat > "$START_SH" <<STUB
#!/bin/bash
# ${SENTINEL} (companion single-process hygiene).
#
# The canonical Belle is the Flywheel companion lead:
#   ${CANONICAL}
# This legacy daemon (BELLE.md persona, #belle only) shared the SAME Discord bot
# token and opened a SECOND gateway connection, which split #leads-roundtable
# delivery away from the canonical lead. Do NOT re-enable: two processes on one
# bot token = the FLY-574 dual-gateway recurrence. To intentionally run this
# daemon again you must first retire the canonical lead.
#
# Original body preserved at: ${START_BACKUP}
echo "[belle/start.sh] ${SENTINEL}. Canonical Belle = ${CANONICAL}. Refusing to start a second process on the same bot token." >&2
exit 0
STUB
  chmod +x "$START_SH" 2>/dev/null || true
}

# ── verify mode ─────────────────────────────────────────────────────────────
if [ "$MODE" = "verify" ]; then
  fail=0
  # launchctl probe — fail-CLOSED: distinguish "ran, label absent" (ok) from
  # "could not run the probe at all" (e.g. missing binary) → a probe we cannot run
  # must never be reported as clean absence (FLY-574 Codex review MEDIUM).
  LIST_OUT="$("$LAUNCHCTL_BIN" list 2>/dev/null)" && LIST_RC=0 || LIST_RC=$?
  if [ "$LIST_RC" -ne 0 ]; then
    log "VERIFY FAIL: could not run launchctl probe (LAUNCHCTL_BIN='$LAUNCHCTL_BIN', rc=$LIST_RC)"; fail=1
  elif printf '%s\n' "$LIST_OUT" | grep -q "$LABEL"; then
    log "VERIFY FAIL: launchd job '$LABEL' is still loaded"; fail=1
  else
    log "verify ok: launchd job '$LABEL' not loaded"
  fi
  if [ -f "$PLIST" ]; then
    log "VERIFY FAIL: plist still present in LaunchAgents: $PLIST"; fail=1
  else
    log "verify ok: plist archived/absent ($PLIST)"
  fi
  if [ -f "$START_SH" ]; then
    if grep -q "$SENTINEL" "$START_SH"; then
      log "verify ok: start.sh is fail-closed ($START_SH)"
    else
      log "VERIFY FAIL: start.sh present but NOT fail-closed: $START_SH"; fail=1
    fi
  else
    log "verify ok: start.sh absent (nothing to neuter)"
  fi
  # tmux probe — fail-CLOSED: rc 0 = session exists (fail), rc 1 = no session (ok),
  # anything else = the probe could not run (e.g. missing binary) → not clean.
  if ! command -v "$TMUX_BIN" >/dev/null 2>&1; then
    TMUX_RC=127
  elif "$TMUX_BIN" -L "$TMUX_SOCKET" has-session -t "$TMUX_SOCKET" >/dev/null 2>&1; then
    TMUX_RC=0
  else
    TMUX_RC=$?
  fi
  case "$TMUX_RC" in
    0) log "VERIFY FAIL: legacy tmux session still alive (-L $TMUX_SOCKET)"; fail=1 ;;
    1) log "verify ok: no legacy tmux session (-L $TMUX_SOCKET)" ;;
    *) log "VERIFY FAIL: could not run tmux probe (TMUX_BIN='$TMUX_BIN', rc=$TMUX_RC)"; fail=1 ;;
  esac
  if [ "$fail" -eq 0 ]; then
    log "VERIFY PASS: single-process state confirmed for token of '$LABEL'"
    exit 0
  fi
  exit 1
fi

# ── dry-run / apply ─────────────────────────────────────────────────────────
APPLY=0; [ "$MODE" = "apply" ] && APPLY=1
if [ "$APPLY" -eq 0 ]; then
  log "DRY-RUN (pass --apply to execute). Planned actions:"
  log "  1. launchctl bootout gui/${UID_NUM}/${LABEL}"
  log "  2. archive plist ${PLIST} -> ${ARCHIVE}"
  log "  3. fail-close start.sh ${START_SH} (backup -> ${START_BACKUP})"
  log "  4. kill tmux session -L ${TMUX_SOCKET}"
  log "  canonical kept: ${CANONICAL}"
  exit 0
fi

log "APPLY: decommissioning legacy daemon '${LABEL}'"

# 1. bootout (session-level stop; no-op if not loaded)
"$LAUNCHCTL_BIN" bootout "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true
log "1/4 bootout gui/${UID_NUM}/${LABEL} (ignored if not loaded)"

# 2. archive the plist out of LaunchAgents (prevents RunAtLoad on reboot)
if [ -f "$PLIST" ]; then
  if [ -e "$ARCHIVE" ]; then
    rm -f "$PLIST"
    log "2/4 plist removed (archive already exists: ${ARCHIVE})"
  else
    mv "$PLIST" "$ARCHIVE"
    log "2/4 plist archived: ${PLIST} -> ${ARCHIVE}"
  fi
else
  log "2/4 plist already absent: ${PLIST}"
fi

# 3. fail-close the legacy start.sh (back up the original once)
if [ -f "$START_SH" ]; then
  if grep -q "$SENTINEL" "$START_SH"; then
    log "3/4 start.sh already fail-closed: ${START_SH}"
  else
    [ -e "$START_BACKUP" ] || cp -p "$START_SH" "$START_BACKUP"
    write_failclose_stub
    log "3/4 start.sh fail-closed (backup: ${START_BACKUP})"
  fi
else
  log "3/4 start.sh absent — nothing to neuter: ${START_SH}"
fi

# 4. kill the legacy tmux session
"$TMUX_BIN" -L "$TMUX_SOCKET" kill-server >/dev/null 2>&1 || true
log "4/4 killed tmux server -L ${TMUX_SOCKET} (ignored if none)"

log "APPLY done. Run with --verify to confirm. Canonical kept: ${CANONICAL}"
exit 0
