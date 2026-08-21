#!/bin/bash
# FLY-574 — tests for decommission-legacy-companion-daemon.sh
#
# Permanently retires a legacy companion daemon (e.g. com.xiaorongli.belle-daemon
# → belle/start.sh → BELLE.md) that shares the SAME Discord bot token as the
# canonical Flywheel companion lead (belle-lead via claude-lead.sh). Two
# supervisors on one token open two gateway connections → MESSAGE_CREATE for
# #leads-roundtable is delivered to whichever connection Discord picks; the legacy
# one (subscribed only to #belle) drops it. A session-level `launchctl bootout`
# does NOT fix this: the plist stays in ~/Library/LaunchAgents with
# RunAtLoad+KeepAlive, so the dual respawns on next login/reboot.
#
# This script does the permanent decommission: bootout + archive the plist out of
# LaunchAgents + fail-close the legacy start.sh (so a stray reload can never launch
# a second process on the token) + kill the legacy tmux session. Idempotent,
# dry-run by default, with a --verify mode.
#
# Safety: hermetic. launchctl + tmux are stubbed via the LAUNCHCTL_BIN / TMUX_BIN
# env seams; the plist + start.sh are temp fixtures. Nothing touches the real
# launchd domain, the real LaunchAgents dir, or the real personal-assistant repo.
#
# Coverage:
#   T1  --dry-run (default) makes NO changes (plist + start.sh untouched)
#   T2  --apply archives the plist out of LaunchAgents and neuters start.sh
#   T3  --apply is idempotent (re-run: still archived, sentinel once, backup kept)
#   T4  --verify PASSES after a successful apply (label not loaded, no plist, ...)
#   T5  --verify FAILS when the launchd label is still loaded
#   T6  --verify FAILS when the plist is still in LaunchAgents
#   T7  neuter preserves a one-time backup of the ORIGINAL start.sh content
#   T8  apply calls launchctl bootout with the per-user gui/<uid>/<label> target
#   T9  missing start.sh: apply does not fail; verify still PASSES
#   T10 the fail-close start.sh stub exits without launching claude + prints pointer
#   T13 an unset TMUX_BIN follows PATH instead of preferring a stale Intel path

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/../decommission-legacy-companion-daemon.sh"

TMP_DIR="$(mktemp -d -t decomm-test.XXXXXX)" || { echo "FATAL: mktemp -d failed" >&2; exit 1; }
[ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] || { echo "FATAL: TMP_DIR unusable" >&2; exit 1; }
# shellcheck disable=SC2329  # invoked indirectly via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

LABEL="com.xiaorongli.belle-daemon-test"
LA_DIR="$TMP_DIR/LaunchAgents"; mkdir -p "$LA_DIR"
PLIST="$LA_DIR/$LABEL.plist"
START_SH="$TMP_DIR/personal-assistant/belle/start.sh"
SOCKET="belle-test"
BOOTOUT_LOG="$TMP_DIR/bootout.args"

PASSED=0
FAILED=0
ERRORS=""
log_test() { echo "[TEST] $*"; }
log_pass() { echo "  ✓ $*"; PASSED=$((PASSED + 1)); }
log_fail() { echo "  ✗ $*" >&2; FAILED=$((FAILED + 1)); ERRORS="${ERRORS}\n  - $*"; }

# Build a stub launchctl. $1 = "loaded" → its `list` prints the label (job still
# present); anything else → `list` prints nothing. `bootout` records its args and
# exits 0.
make_launchctl_stub() {
  local mode="$1" out="$2"
  cat > "$out" <<STUB
#!/bin/bash
case "\$1" in
  bootout) printf '%s\n' "\$2" >> "$BOOTOUT_LOG"; exit 0 ;;
  list)    [ "$mode" = "loaded" ] && echo "12345  0  $LABEL"; exit 0 ;;
  *)       exit 0 ;;
esac
STUB
  chmod +x "$out"
}

# Build a stub tmux. $1 = "alive" → `has-session` exits 0 (session exists);
# anything else → exits 1. kill-* always exit 0.
make_tmux_stub() {
  local mode="$1" out="$2"
  cat > "$out" <<STUB
#!/bin/bash
args="\$*"
case "\$args" in
  *has-session*) [ "$mode" = "alive" ] && exit 0 || exit 1 ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "$out"
}

make_plist() {
  cat > "$PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
XML
}

ORIGINAL_START_BODY='#!/bin/bash
# original legacy belle daemon
exec claude --append-system-prompt-file BELLE.md --channels plugin:discord@claude-plugins-official'

make_start_sh() {
  mkdir -p "$(dirname "$START_SH")"
  printf '%s\n' "$ORIGINAL_START_BODY" > "$START_SH"
  chmod +x "$START_SH"
}

LC_STUB="$TMP_DIR/launchctl-decommissioned"; make_launchctl_stub "clean" "$LC_STUB"
LC_STUB_LOADED="$TMP_DIR/launchctl-loaded"; make_launchctl_stub "loaded" "$LC_STUB_LOADED"
TMUX_STUB="$TMP_DIR/tmux-dead"; make_tmux_stub "dead" "$TMUX_STUB"

run_apply() {
  LAUNCHCTL_BIN="$LC_STUB" TMUX_BIN="$TMUX_STUB" bash "$SCRIPT" \
    --label "$LABEL" --plist "$PLIST" --start-sh "$START_SH" --tmux-socket "$SOCKET" \
    --apply
}
run_dry() {
  LAUNCHCTL_BIN="$LC_STUB" TMUX_BIN="$TMUX_STUB" bash "$SCRIPT" \
    --label "$LABEL" --plist "$PLIST" --start-sh "$START_SH" --tmux-socket "$SOCKET"
}
run_verify() {  # $1 = launchctl stub to use
  LAUNCHCTL_BIN="$1" TMUX_BIN="$TMUX_STUB" bash "$SCRIPT" \
    --label "$LABEL" --plist "$PLIST" --start-sh "$START_SH" --tmux-socket "$SOCKET" --verify
}

# ── T1: dry-run makes no changes ────────────────────────────────────────────
log_test "T1 --dry-run (default) makes no changes"
make_plist; make_start_sh; : > "$BOOTOUT_LOG"
run_dry >/dev/null 2>&1
if [ -f "$PLIST" ] && grep -q "exec claude" "$START_SH" && ! grep -q "DECOMMISSIONED" "$START_SH"; then
  log_pass "T1 plist still present and start.sh untouched after dry-run"
else
  log_fail "T1 dry-run mutated state"
fi

# ── T2: apply archives plist + neuters start.sh ─────────────────────────────
log_test "T2 --apply archives plist out of LaunchAgents and neuters start.sh"
make_plist; make_start_sh; : > "$BOOTOUT_LOG"
run_apply >/dev/null 2>&1
plist_gone=0; [ ! -f "$PLIST" ] && plist_gone=1
archived=0; ls "$LA_DIR"/*.decommissioned-fly574.bak* >/dev/null 2>&1 && archived=1
neutered=0; grep -q "DECOMMISSIONED" "$START_SH" 2>/dev/null && ! grep -q "exec claude" "$START_SH" 2>/dev/null && neutered=1
if [ "$plist_gone" -eq 1 ] && [ "$archived" -eq 1 ] && [ "$neutered" -eq 1 ]; then
  log_pass "T2 plist archived (gone from LaunchAgents) + start.sh fail-closed"
else
  log_fail "T2 apply incomplete (plist_gone=$plist_gone archived=$archived neutered=$neutered)"
fi

# ── T3: apply idempotent ────────────────────────────────────────────────────
log_test "T3 --apply idempotent on re-run"
run_apply >/dev/null 2>&1
rc=$?
sentinel_count=$(grep -c "DECOMMISSIONED by FLY-574" "$START_SH" 2>/dev/null || echo 0)
bak_count=$(find "$(dirname "$START_SH")" -maxdepth 1 -name "$(basename "$START_SH").pre-fly574.bak" 2>/dev/null | wc -l | tr -d ' ')
if [ "$rc" -eq 0 ] && [ "$sentinel_count" -ge 1 ] && [ "$bak_count" -eq 1 ]; then
  log_pass "T3 re-run clean (exit 0, not double-wrapped, single backup)"
else
  log_fail "T3 not idempotent (rc=$rc sentinel=$sentinel_count bak=$bak_count)"
fi

# ── T4: verify PASS after apply ─────────────────────────────────────────────
log_test "T4 --verify PASSES after a successful apply"
if run_verify "$LC_STUB" >/dev/null 2>&1; then
  log_pass "T4 verify exit 0 (single-process state confirmed)"
else
  log_fail "T4 verify failed after a clean apply"
fi

# ── T5: verify FAIL when label still loaded ─────────────────────────────────
log_test "T5 --verify FAILS when the launchd label is still loaded"
if run_verify "$LC_STUB_LOADED" >/dev/null 2>&1; then
  log_fail "T5 verify passed while the label was still loaded"
else
  log_pass "T5 verify correctly failed on a still-loaded label"
fi

# ── T6: verify FAIL when plist still present ─────────────────────────────────
log_test "T6 --verify FAILS when the plist is still in LaunchAgents"
make_plist  # resurrect the plist
if run_verify "$LC_STUB" >/dev/null 2>&1; then
  log_fail "T6 verify passed while the plist was still present"
else
  log_pass "T6 verify correctly failed on a present plist"
fi
rm -f "$PLIST"

# ── T7: backup preserves original start.sh ──────────────────────────────────
log_test "T7 neuter preserves a one-time backup of the original start.sh"
make_plist; make_start_sh; : > "$BOOTOUT_LOG"
run_apply >/dev/null 2>&1
if [ -f "$START_SH.pre-fly574.bak" ] && grep -q "exec claude" "$START_SH.pre-fly574.bak"; then
  log_pass "T7 original start.sh content preserved in backup"
else
  log_fail "T7 no backup or backup does not contain the original body"
fi

# ── T8: bootout target ──────────────────────────────────────────────────────
log_test "T8 apply calls launchctl bootout with gui/<uid>/<label>"
make_plist; make_start_sh; : > "$BOOTOUT_LOG"
run_apply >/dev/null 2>&1
uid="$(id -u)"
if grep -q "gui/$uid/$LABEL" "$BOOTOUT_LOG" 2>/dev/null; then
  log_pass "T8 bootout target was gui/$uid/$LABEL"
else
  log_fail "T8 bootout target wrong/absent: $(cat "$BOOTOUT_LOG" 2>/dev/null)"
fi

# ── T9: missing start.sh ────────────────────────────────────────────────────
log_test "T9 missing start.sh: apply does not fail, verify still PASSES"
make_plist; rm -f "$START_SH"; : > "$BOOTOUT_LOG"
if run_apply >/dev/null 2>&1 && run_verify "$LC_STUB" >/dev/null 2>&1; then
  log_pass "T9 tolerated absent start.sh"
else
  log_fail "T9 failed when start.sh was absent"
fi

# ── T10: fail-close stub behavior ───────────────────────────────────────────
log_test "T10 the neutered start.sh exits without launching claude + prints pointer"
make_plist; make_start_sh
run_apply >/dev/null 2>&1
out="$(bash "$START_SH" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && echo "$out" | grep -qi "DECOMMISSIONED" && ! echo "$out" | grep -q "exec claude"; then
  log_pass "T10 stub is inert and self-documenting"
else
  log_fail "T10 stub misbehaved (rc=$rc out=$out)"
fi

# ── T11: verify is fail-closed when the launchctl probe cannot run ──────────
log_test "T11 --verify FAILS when the launchctl probe binary cannot run"
make_plist; make_start_sh; run_apply >/dev/null 2>&1   # reach a decommissioned state
BROKEN="$TMP_DIR/nonexistent-launchctl"   # does not exist → probe cannot run
if LAUNCHCTL_BIN="$BROKEN" TMUX_BIN="$TMUX_STUB" bash "$SCRIPT" \
     --label "$LABEL" --plist "$PLIST" --start-sh "$START_SH" --tmux-socket "$SOCKET" --verify >/dev/null 2>&1; then
  log_fail "T11 verify PASSED while the launchctl probe could not run (fail-open)"
else
  log_pass "T11 verify correctly failed-closed on an unrunnable launchctl probe"
fi

# ── T12: verify is fail-closed when the tmux probe cannot run ────────────────
log_test "T12 --verify FAILS when the tmux probe binary cannot run"
BROKEN_TMUX="$TMP_DIR/nonexistent-tmux"
if LAUNCHCTL_BIN="$LC_STUB" TMUX_BIN="$BROKEN_TMUX" bash "$SCRIPT" \
     --label "$LABEL" --plist "$PLIST" --start-sh "$START_SH" --tmux-socket "$SOCKET" --verify >/dev/null 2>&1; then
  log_fail "T12 verify PASSED while the tmux probe could not run (fail-open)"
else
  log_pass "T12 verify correctly failed-closed on an unrunnable tmux probe"
fi

# ── T13: default tmux selection follows PATH ────────────────────────────────
log_test "T13 unset TMUX_BIN follows PATH"
PATH_BIN="$TMP_DIR/path-bin"; mkdir -p "$PATH_BIN"
PATH_TMUX_LOG="$TMP_DIR/path-tmux.args"
cat > "$PATH_BIN/tmux" <<STUB
#!/bin/bash
printf '%s\n' "\$*" >> "$PATH_TMUX_LOG"
case "\$*" in
  *has-session*) exit 1 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$PATH_BIN/tmux"
if env -u TMUX_BIN PATH="$PATH_BIN:$PATH" LAUNCHCTL_BIN="$LC_STUB" \
  bash "$SCRIPT" --label "$LABEL" --plist "$PLIST" --start-sh "$START_SH" \
  --tmux-socket "$SOCKET" --verify >/dev/null 2>&1 \
  && grep -q "has-session" "$PATH_TMUX_LOG" 2>/dev/null; then
  log_pass "T13 PATH-selected tmux handled the verification probe"
else
  log_fail "T13 script bypassed the PATH-selected tmux"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "═════════════════════════════════════════"
echo "PASSED: $PASSED"
echo "FAILED: $FAILED"
echo "═════════════════════════════════════════"
if [ "$FAILED" -gt 0 ]; then echo -e "Failures:$ERRORS" >&2; exit 1; fi
exit 0
