#!/bin/bash
# FLY-259 PR-F — rollback-codex-lead-mufasa-tui.sh tests. Stateful PATH-injected
# mocks (launchctl/tmux) so we exercise the apply path WITHOUT touching real
# launchd/tmux. Run with /bin/bash.
#
# Key regression (Codex R2 HIGH): under `set -euo pipefail`, an ABSENT launchd job
# makes `launchctl print` exit non-zero — `TUI_PID="$(job_pid)"` must NOT abort the
# rollback (the `|| true` in job_pid). This test drives exactly that scenario
# (job absent at capture time) and asserts the rollback completes.
set -uo pipefail
PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUT="$SCRIPT_DIR/rollback-codex-lead-mufasa-tui.sh"
[ -x "$SUT" ] || { echo "FATAL: $SUT not executable"; exit 1; }

T=$(mktemp -d /tmp/rbmt.XXXXX) || { echo "FATAL: mktemp"; exit 1; }
trap 'rm -rf "$T"' EXIT

LA="$T/Library/LaunchAgents"; mkdir -p "$LA"
LABEL="com.flywheel.lead.growth-mufasa-lead"
BACKUP="$LA/$LABEL.plist.pre-FLY-259-tui.bak"
WINDOW="growth-mufasa-lead"   # the ③ TUI window name the rollback targets

# A valid HEADLESS backup: points at the headless wrapper, NOT the -tui wrapper.
write_headless_backup() {
  printf '<plist><array><string>/x/flywheel-codex-lead-wrapper-mufasa.sh</string></array></plist>\n' > "$BACKUP"
}

# launchctl mock lives on the OPERATOR PATH ($T/bin); the tmux mock lives ONLY in a
# separate "canonical" dir ($T/canon) that is NOT on the operator PATH. So every
# tmux test below only works if the rollback resolves tmux via the wrapper search
# order (FLYWHEEL_ROLLBACK_TMUX_PATH=$T/canon), NOT the operator shell PATH — that's
# the PATH-regression coverage for Codex R6.
mkdir -p "$T/bin" "$T/canon"
# Stateful launchctl mock: print succeeds (emits a pid) iff the state file exists.
cat > "$T/bin/launchctl" <<'EOF'
#!/bin/bash
S="$LAUNCHCTL_STATE"
case "$1" in
  print)     if [ -f "$S" ]; then printf '\tpid = 4242\n'; exit 0; else exit 1; fi ;;
  bootout)   rm -f "$S"; exit 0 ;;
  bootstrap) echo loaded > "$S"; exit 0 ;;
  *) exit 0 ;;
esac
EOF
# Scenario-driven tmux mock. Default (no MOCK_TMUX_SESSION) → no session, so the
# window-teardown block is skipped entirely. Knobs:
#   MOCK_TMUX_SESSION=1     session exists
#   MOCK_TMUX_BEFORE=<name> window list before kill (newline-joined)
#   MOCK_TMUX_AFTER=<name>  window list after kill
#   MOCK_TMUX_PROBE_FAIL=1  list-windows fails (errors) after kill
#   MOCK_TMUX_KILLED=<file> kill marker (per test)
cat > "$T/canon/tmux" <<'EOF'
#!/bin/bash
# A stray TMUX_TMPDIR points tmux at the WRONG socket → it cannot see the real
# session (simulates Codex R5's false-absence). The rollback must unset it.
[ -n "${TMUX_TMPDIR:-}" ] && exit 1
case "$1" in
  has-session) [ "${MOCK_TMUX_SESSION:-0}" = "1" ] && exit 0 || exit 1 ;;
  kill-window) : > "${MOCK_TMUX_KILLED:-/dev/null}"; exit 0 ;;
  list-windows)
    [ "${MOCK_TMUX_LIST_FAIL:-0}" = "1" ] && exit 1   # session reachable but unreadable
    if [ -n "${MOCK_TMUX_KILLED:-}" ] && [ -f "${MOCK_TMUX_KILLED}" ]; then
      [ "${MOCK_TMUX_PROBE_FAIL:-0}" = "1" ] && exit 1
      printf '%s\n' "${MOCK_TMUX_AFTER:-}"
    else
      printf '%s\n' "${MOCK_TMUX_BEFORE:-}"
    fi ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$T/bin/launchctl" "$T/canon/tmux"

# Operator PATH = $T/bin (has launchctl, NO tmux). The rollback must find tmux via
# FLYWHEEL_ROLLBACK_TMUX_PATH=$T/canon (the wrapper search-order hook), not the
# operator PATH. Per-test overrides of FLYWHEEL_ROLLBACK_TMUX_PATH are honored.
run() {
  local tmux_path="${TMUX_PATH_OVERRIDE:-$T/canon}"
  HOME="$T" PATH="$T/bin:$PATH" LAUNCHCTL_STATE="$T/lc-state" \
    FLYWHEEL_ROLLBACK_TMUX_PATH="$tmux_path" /bin/bash "$SUT" "$@" 2>&1
}

# ── 1. dry-run: prints plan, takes no action ───────────────────────────────
rm -f "$T/lc-state"; write_headless_backup
out=$(run); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "DRY-RUN" && ! printf '%s' "$out" | grep -q "Rollback complete"; then
  pass "dry-run prints plan, no action"
else fail "dry-run wrong (rc=$rc)"; fi

# ── 2. HIGH regression: ABSENT job at capture → no abort, rollback completes ──
# Initial state: no lc-state file = job absent. job_pid's launchctl print fails;
# without `|| true` the rollback would die here. bootstrap re-creates the state so
# step 7's verify sees a pid.
rm -f "$T/lc-state"; write_headless_backup
out=$(run --yes); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "Rollback complete"; then
  pass "absent job at PID capture → no set -e abort, rollback completes (Codex R2 HIGH)"
else fail "absent-job rollback should complete (rc=$rc, out=$out)"; fi

# ── 3. missing backup → fail-loud (before touching launchd) ────────────────
rm -f "$T/lc-state" "$BACKUP"
out=$(run --yes); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "backup missing"; then
  pass "missing backup → fail-loud"
else fail "missing backup should fail (rc=$rc)"; fi

# ── 4. backup is a TUI plist (clobbered) → fail-loud (HIGH-3) ───────────────
rm -f "$T/lc-state"
printf '<plist><array><string>/x/flywheel-codex-lead-wrapper-mufasa-tui.sh</string></array></plist>\n' > "$BACKUP"
out=$(run --yes); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "does NOT look like the headless plist"; then
  pass "backup is TUI plist → fail-loud (no no-op rollback)"
else fail "TUI-plist backup should fail (rc=$rc, out=$out)"; fi

# ── 5. orphan TUI window SURVIVES kill → fail-loud (Codex R2/R3 HIGH) ───────
rm -f "$T/lc-state"; write_headless_backup; KILLED="$T/killed.5"; rm -f "$KILLED"
out=$(MOCK_TMUX_SESSION=1 MOCK_TMUX_BEFORE="$WINDOW" MOCK_TMUX_AFTER="$WINDOW" \
  MOCK_TMUX_KILLED="$KILLED" run --yes); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "survived kill"; then
  pass "orphan window survives kill → fail-loud (no headless over orphan)"
else fail "surviving window should fail loud (rc=$rc, out=$out)"; fi

# ── 6. re-probe FAILS after kill → fail-loud, NOT treated as gone (Codex R3 HIGH) ──
rm -f "$T/lc-state"; write_headless_backup; KILLED="$T/killed.6"; rm -f "$KILLED"
out=$(MOCK_TMUX_SESSION=1 MOCK_TMUX_BEFORE="$WINDOW" MOCK_TMUX_PROBE_FAIL=1 \
  MOCK_TMUX_KILLED="$KILLED" run --yes); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "could not re-read tmux windows"; then
  pass "re-probe failure → fail-loud (indeterminate ≠ gone)"
else fail "probe-failure should fail loud (rc=$rc, out=$out)"; fi

# ── 7. window present then confirmed gone after kill → rollback completes ───
rm -f "$T/lc-state"; write_headless_backup; KILLED="$T/killed.7"; rm -f "$KILLED"
out=$(MOCK_TMUX_SESSION=1 MOCK_TMUX_BEFORE="$WINDOW" MOCK_TMUX_AFTER="other-win" \
  MOCK_TMUX_KILLED="$KILLED" run --yes); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "Rollback complete"; then
  pass "window confirmed gone after kill → rollback completes"
else fail "window-gone happy path should complete (rc=$rc, out=$out)"; fi

# ── 8. session reachable but window list UNREADABLE (initial probe) → fail-loud ──
#    (Codex R4 HIGH: server-up-but-unreadable is indeterminate, NOT "no window")
rm -f "$T/lc-state"; write_headless_backup; KILLED="$T/killed.8"; rm -f "$KILLED"
out=$(MOCK_TMUX_SESSION=1 MOCK_TMUX_LIST_FAIL=1 MOCK_TMUX_KILLED="$KILLED" run --yes); rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qi "window list could not be read"; then
  pass "session up but window list unreadable → fail-loud (indeterminate ≠ no window)"
else fail "unreadable initial window list should fail loud (rc=$rc, out=$out)"; fi

# ── 9. tmux session NOT reachable → proceed (no orphan window can exist) ────
#    has-session false = no server / no session → no tmux window → safe to proceed.
rm -f "$T/lc-state"; write_headless_backup
out=$(MOCK_TMUX_SESSION=0 run --yes); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "Rollback complete"; then
  pass "session unreachable → proceed (no reachable tmux server/session = no orphan)"
else fail "unreachable session should proceed (rc=$rc, out=$out)"; fi

# ── 10. stray TMUX_TMPDIR is CLEARED → probe hits the real socket (Codex R5 HIGH) ──
#    With TMUX_TMPDIR set the mock reports "no session" (wrong socket). The rollback
#    must unset it so the probe sees the window and KILLS it — proving it never
#    trusts a socket/PATH-induced false absence and bootstraps over a live orphan.
rm -f "$T/lc-state"; write_headless_backup; KILLED="$T/killed.10"; rm -f "$KILLED"
out=$(TMUX_TMPDIR=/bogus/socket MOCK_TMUX_SESSION=1 MOCK_TMUX_BEFORE="$WINDOW" \
  MOCK_TMUX_AFTER="" MOCK_TMUX_KILLED="$KILLED" run --yes); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "killing lingering tmux window"; then
  pass "stray TMUX_TMPDIR cleared → probe hits real socket, window seen + killed"
else fail "TMUX_TMPDIR must be cleared so the probe is trustworthy (rc=$rc, out=$out)"; fi

# ── 11. tmux NOT in the wrapper search order → proceed (Codex R6) ───────────
#    FLYWHEEL_ROLLBACK_TMUX_PATH points at a dir with no tmux → TMUX_BIN empty →
#    genuinely no reachable tmux window → proceed (the mock is only in $T/canon,
#    which we deliberately exclude here).
mkdir -p "$T/empty"
rm -f "$T/lc-state"; write_headless_backup
out=$(TMUX_PATH_OVERRIDE="$T/empty" MOCK_TMUX_SESSION=1 MOCK_TMUX_BEFORE="$WINDOW" run --yes); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "Rollback complete" \
   && ! printf '%s' "$out" | grep -q "killing lingering tmux window"; then
  pass "tmux not in wrapper search order → TMUX_BIN empty → proceed (no probe)"
else fail "tmux-absent-in-canon should proceed without probing (rc=$rc, out=$out)"; fi

# ── 12. PATH regression: tmux resolved via the canonical hook, NOT operator PATH ──
#    The operator PATH ($T/bin) has NO tmux; the mock lives only in $T/canon. That
#    the window-present cases above (5/7/10) found + killed the window proves the
#    rollback used the wrapper search order, not the operator shell PATH. Re-assert
#    explicitly: window present (seen via $T/canon), confirmed gone after kill.
rm -f "$T/lc-state"; write_headless_backup; KILLED="$T/killed.12"; rm -f "$KILLED"
out=$(MOCK_TMUX_SESSION=1 MOCK_TMUX_BEFORE="$WINDOW" MOCK_TMUX_AFTER="" \
  MOCK_TMUX_KILLED="$KILLED" run --yes); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "killing lingering tmux window"; then
  pass "tmux found via wrapper search order (not operator PATH) → window seen + killed"
else fail "rollback should resolve tmux via the canonical hook (rc=$rc, out=$out)"; fi

echo ""
echo "rollback-codex-lead-mufasa-tui.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
