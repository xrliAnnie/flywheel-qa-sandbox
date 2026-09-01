#!/bin/bash
# FLY-954: converge-flywheel-bin.sh — checksum+mode-converge <state>/bin
# runtime scripts to repo sources; repair + alert on drift; NEVER repair from
# an insane repo source. Hermetic: sandbox STATE_DIR + fake repo (the REAL
# converge script is COPIED into the fake repo and invoked there, so its
# self-derived SCRIPT_DIR/.. repo root points at the fake repo — no env seam
# for repair provenance, Codex R2#1) + stub alert sink (notification-only
# seam FLYWHEEL_CONVERGE_ALERT_BIN).
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }

REAL_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SB="$(mktemp -d -t fly954-converge-XXXXXX)"; trap 'rm -rf "$SB"' EXIT

# fake repo with sane sources + the REAL converge script + the REAL libs
# (path-hygiene.sh added by FLY-1389 — converge sources it at startup; this
# mktemp fake repo is a temp root, so the FLY-1389 guard/symlink sections
# self-disable and C1-C8 exercise the FLY-954 wrapper loop verbatim).
FR="$SB/repo"; mkdir -p "$FR/scripts/lib"
# FLY-1577: mark the fake repo worktree-shaped EXPLICITLY rather than relying on
# mktemp landing under /tmp or /var/folders. With a valid custom TMPDIR (e.g.
# ~/.flywheel/.../browser-tmp) it does not, is_temp_or_worktree_root judges the
# fixture trusted, the symlink lane runs, and cases that never meant to exercise
# it fail before reaching their copy-lane assertions.
echo "gitdir: /main/.git/worktrees/fly954-fixture" > "$FR/.git"
cp "$REAL_REPO_ROOT/scripts/lib/script-sanity.sh" "$FR/scripts/lib/"
cp "$REAL_REPO_ROOT/scripts/lib/path-hygiene.sh" "$FR/scripts/lib/"
cp "$REAL_REPO_ROOT/scripts/converge-flywheel-bin.sh" "$FR/scripts/"
CONVERGE="$FR/scripts/converge-flywheel-bin.sh"
for f in flywheel-lead-wrapper-v2.sh \
    flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh \
    flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh \
    resident-codex-lead-recover.sh \
    flywheel-codex-lead-wrapper-codex-infra-bot.sh \
    flywheel-lead-attach.sh flywheel-view-attach.sh flywheel-node-status.sh \
    flywheel-bridge-wrapper.sh restart-services.sh \
    host-tmux-selection-gate.sh lib/bounded-run.sh lib/lead-address.sh; do
  { echo '#!/bin/bash'; i=1; while [ "$i" -le 80 ]; do echo "echo repo-$f-$i >/dev/null"; i=$((i+1)); done; } > "$FR/scripts/$f"
done
# FLY-1577: the gate is PYTHON. It is in FILES because the cmux watcher's
# fail-closed preflight loads it from <state>/bin (not from the repo), so its
# absence refuses the watcher launch — the 2026-07-31 incident. Shaped like a
# real .py file so this fixture EXERCISES (rather than asserts) that FLY-954's
# language-agnostic sanity floor accepts Python sources.
{ echo '#!/usr/bin/env python3'; echo 'import sys'; echo 'def main() -> int:'
  i=1; while [ "$i" -le 80 ]; do echo "    print('repo-gate-$i')"; i=$((i+1)); done
  echo '    return 0'; echo 'if __name__ == "__main__":'; echo '    sys.exit(main())'
} > "$FR/scripts/restart-storm-gate.py"

# FLY-1577: every case that is not specifically testing a missing/drifted copy
# must start from a converged copy-lane steady state — otherwise the widened
# FILES makes converge repair the un-seeded entries and the "exactly one alert"
# assertions below count repairs they never meant to trigger.
COPY_FILES="flywheel-lead-wrapper-v2.sh flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh resident-codex-lead-recover.sh flywheel-codex-lead-wrapper-codex-infra-bot.sh flywheel-lead-attach.sh flywheel-view-attach.sh flywheel-node-status.sh flywheel-bridge-wrapper.sh restart-services.sh restart-storm-gate.py host-tmux-selection-gate.sh lib/bounded-run.sh lib/lead-address.sh"
seed_steady_state() {  # <state-dir>
  local st="$1" f
  for f in $COPY_FILES; do
    mkdir -p "$(dirname "$st/bin/$f")"
    [ -e "$st/bin/$f" ] && chmod u+w "$st/bin/$f" 2>/dev/null
    cp "$FR/scripts/$f" "$st/bin/$f"
    chmod 555 "$st/bin/$f"
  done
}
# stub alert sink (records invocations)
ALERT="$SB/alert.sh"
cat > "$ALERT" <<'EOF'
#!/bin/bash
echo "ALERT $*" >> "${ALERT_LOG:?}"
exit 0
EOF
chmod +x "$ALERT"

ST="$SB/state"; mkdir -p "$ST/bin"
run_converge() {
  ALERT_LOG="$SB/alerts.log" FLYWHEEL_STATE_DIR="$ST" \
  FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
    bash "$CONVERGE" >"$SB/out.log" 2>&1
}

# C1: drifted (the incident stub) → repaired + one alert
: > "$SB/alerts.log"
seed_steady_state "$ST"
chmod u+w "$ST/bin/flywheel-lead-wrapper-v2.sh"
echo '#!/bin/bash' > "$ST/bin/flywheel-lead-wrapper-v2.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] \
   && cmp -s "$ST/bin/flywheel-lead-wrapper-v2.sh" "$FR/scripts/flywheel-lead-wrapper-v2.sh" \
   && [ ! -w "$ST/bin/flywheel-lead-wrapper-v2.sh" ] \
   && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 1 ] \
   && grep -q 'bin_integrity_drift' "$SB/alerts.log"; then
  pass "C1: stub drift repaired to repo source (555) + exactly one alert"
else fail "C1: repair (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C2: converged state → silent no-op (no alert, exit 0)
: > "$SB/alerts.log"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ ! -s "$SB/alerts.log" ]; then
  pass "C2: converged → silent no-op"
else fail "C2: no-op (rc=$RC)"; cat "$SB/alerts.log"; fi

# C3: missing bin file → repaired
: > "$SB/alerts.log"
rm -f "$ST/bin/restart-services.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$ST/bin/restart-services.sh" "$FR/scripts/restart-services.sh"; then
  pass "C3: missing bin file re-installed"
else fail "C3: missing repair (rc=$RC)"; fi

# C5 (Codex R1#1): content matches but mode 644 → converge tightens to 555, silently
: > "$SB/alerts.log"
chmod 644 "$ST/bin/flywheel-lead-wrapper-v2.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ ! -w "$ST/bin/flywheel-lead-wrapper-v2.sh" ] && [ ! -s "$SB/alerts.log" ]; then
  pass "C5: mode-only drift tightened to 555, no alert"
else fail "C5: mode convergence (rc=$RC)"; ls -l "$ST/bin"; cat "$SB/alerts.log" 2>/dev/null; fi

# C4: drift + INSANE repo source → alert, NOT repaired, exit non-zero
: > "$SB/alerts.log"
echo '#!/bin/bash' > "$FR/scripts/flywheel-bridge-wrapper.sh"     # repo side goes bad
chmod u+w "$ST/bin/flywheel-bridge-wrapper.sh" 2>/dev/null || true
echo 'echo drifted' >> "$ST/bin/flywheel-bridge-wrapper.sh"       # force drift
run_converge; RC=$?
if [ "$RC" -ne 0 ] && grep -q 'drifted' "$ST/bin/flywheel-bridge-wrapper.sh" \
   && grep -q 'insane' "$SB/alerts.log"; then
  pass "C4: insane repo source → alert only, bin untouched, non-zero exit"
else fail "C4: fail-safe (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C6 (lead-instruction 4d224848): a NON-default state root (sandbox/QA-slot
# exercise) must prefix alert titles loudly — a founder glancing at Discord
# cannot be expected to recognize /var/folders paths in the body.
# (C4 left the fake repo's bridge-wrapper source insane — restore it first so
# this run exercises a clean repair only.)
{ echo '#!/bin/bash'; i=1; while [ "$i" -le 80 ]; do echo "echo repo-flywheel-bridge-wrapper.sh-$i >/dev/null"; i=$((i+1)); done; } > "$FR/scripts/flywheel-bridge-wrapper.sh"
: > "$SB/alerts.log"
rm -f "$ST/bin/restart-services.sh"        # force a repair (drift) alert
run_converge; RC=$?
if [ "$RC" -eq 0 ] && grep -q '🧪\[sandbox test\]' "$SB/alerts.log"; then
  pass "C6: non-default state root → alert title carries the 🧪[sandbox test] prefix"
else fail "C6: drill prefix missing (rc=$RC)"; cat "$SB/alerts.log" 2>/dev/null; fi

# C8 (Codex code R1 HIGH): a required repo source that is MISSING entirely
# (mid-pull / broken checkout) must FAIL the converge (rc=1) + alert — never
# exit 0 with an unverifiable bin. The pre-kickstart mount treats exit 0 as
# "healthy, safe to kickstart".
: > "$SB/alerts.log"
rm -f "$FR/scripts/flywheel-bridge-wrapper.sh"     # repo source vanishes
run_converge; RC=$?
if [ "$RC" -ne 0 ] && grep -q 'missing' "$SB/alerts.log"; then
  pass "C8: missing repo source → alert + non-zero exit (never silently healthy)"
else fail "C8: absent source was tolerated (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi
# restore the source for C7
{ echo '#!/bin/bash'; i=1; while [ "$i" -le 80 ]; do echo "echo repo-flywheel-bridge-wrapper.sh-$i >/dev/null"; i=$((i+1)); done; } > "$FR/scripts/flywheel-bridge-wrapper.sh"

# C7: the PRODUCTION shape (STATE_DIR == $HOME/.flywheel) must NOT be prefixed
# — simulated with a fake HOME inside the sandbox (never the real one).
# FLY-1389: this shape (temp fake repo + effective-global bin) is now
# refused by the write-time guard; the deliberate override keeps C7 on its
# original target (drill-prefix behavior of the repair alert).
FH="$SB/fakehome"; mkdir -p "$FH/.flywheel/bin"
: > "$SB/alerts.log"
seed_steady_state "$FH/.flywheel"
chmod u+w "$FH/.flywheel/bin/flywheel-lead-wrapper-v2.sh"
echo '#!/bin/bash' > "$FH/.flywheel/bin/flywheel-lead-wrapper-v2.sh"   # drift
ALERT_LOG="$SB/alerts.log" HOME="$FH" FLYWHEEL_STATE_DIR="$FH/.flywheel" \
FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT=1 \
  bash "$CONVERGE" >"$SB/out7.log" 2>&1
RC=$?
if [ "$RC" -eq 0 ] && grep -q '^ALERT' "$SB/alerts.log" \
   && ! grep -q '🧪' "$SB/alerts.log"; then
  pass "C7: production shape (STATE_DIR == \$HOME/.flywheel) → no drill prefix"
else fail "C7: prefix leaked into production shape (rc=$RC)"; cat "$SB/alerts.log" 2>/dev/null; fi

# ── FLY-1577: the cmux watcher's hard dependencies belong to this invariant ──
#
# Incident 2026-07-31: ~/.flywheel/bin/restart-storm-gate.py was absent, the
# cmux watcher's fail-closed preflight refused to launch it for hours, and
# converge reported CLEAN the whole time — because the gate was not in FILES.
# The founder lost her only view of what Runners were doing.
#
# mode is compared LITERALLY (not via `[ -w ]`): C11 has to prove 700 -> 555,
# and a writability probe cannot tell those apart for the owning user.
# GNU (-c) first, BSD (-f) fallback — GNU's -f means "file system status" and
# succeeds with an unrelated multi-line block, so the reverse order never
# falls through on Linux (same contract as scripts/flywheel-setup.sh::_fs_perm).
t_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

# C9: the incident, verbatim — gate missing from bin → repaired to 555 + LOUD.
# "not clean" is asserted directly: converge must both say `repaired:` and emit
# exactly one drift alert. Reporting clean here is what let the outage run.
: > "$SB/alerts.log"
seed_steady_state "$ST"
rm -f "$ST/bin/restart-storm-gate.py"
run_converge; RC=$?
if [ "$RC" -eq 0 ] \
   && cmp -s "$ST/bin/restart-storm-gate.py" "$FR/scripts/restart-storm-gate.py" \
   && [ "$(t_mode "$ST/bin/restart-storm-gate.py")" = "555" ] \
   && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 1 ] \
   && grep -q 'bin_integrity_drift' "$SB/alerts.log" \
   && grep -q 'repaired: restart-storm-gate.py' "$SB/out.log"; then
  pass "C9: missing restart-storm-gate.py repaired to 555 + reported drifted (never 'clean')"
else fail "C9: gate not converged (rc=$RC, mode=$(t_mode "$ST/bin/restart-storm-gate.py"))"
  cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C9b (FLY-2190/2216): every host-selection mount resolves through state/bin.
# The gate, formerly-unmanaged Codex carriers, and Raya recovery helper must be
# installed atomically by this same convergence authority. Their first valid
# adoption is expected rollout work, not pre-existing integrity drift, so only
# the independently-new host gate alerts on this first pass.
: > "$SB/alerts.log"
seed_steady_state "$ST"
rm -rf "$ST/state/converge-adoptions"
rm -f "$ST/bin/host-tmux-selection-gate.sh" \
  "$ST/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" \
  "$ST/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  "$ST/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh" \
  "$ST/bin/resident-codex-lead-recover.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] \
  && cmp -s "$ST/bin/host-tmux-selection-gate.sh" "$FR/scripts/host-tmux-selection-gate.sh" \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" "$FR/scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" "$FR/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh" "$FR/scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh" \
  && cmp -s "$ST/bin/resident-codex-lead-recover.sh" "$FR/scripts/resident-codex-lead-recover.sh" \
  && [ "$(t_mode "$ST/bin/host-tmux-selection-gate.sh")" = "555" ] \
  && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 1 ] \
  && [ "$(t_mode "$ST/state/converge-adoptions/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh")" = "600" ] \
  && [ "$(t_mode "$ST/state/converge-adoptions/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh")" = "600" ] \
  && [ "$(t_mode "$ST/state/converge-adoptions/flywheel-codex-lead-wrapper-codex-infra-bot.sh")" = "600" ] \
  && [ "$(t_mode "$ST/state/converge-adoptions/resident-codex-lead-recover.sh")" = "600" ]; then
  pass "C9b: first Codex carrier/recovery adoption converges silently and records durable baselines"
else fail "C9b: FLY-2190 runtime closure not converged (rc=$RC)"
  cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C9c: adoption is one-shot, never a permanent alert exemption. Once the
# durable baseline exists, every managed carrier/recovery artifact uses the
# normal severe drift repair path.
: > "$SB/alerts.log"
chmod u+w "$ST/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" \
  "$ST/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  "$ST/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh" \
  "$ST/bin/resident-codex-lead-recover.sh"
printf '%s\n' '#!/bin/bash' > "$ST/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh"
printf '%s\n' '#!/bin/bash' > "$ST/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh"
printf '%s\n' '#!/bin/bash' > "$ST/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh"
printf '%s\n' '#!/bin/bash' > "$ST/bin/resident-codex-lead-recover.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" "$FR/scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" "$FR/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh" "$FR/scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh" \
  && cmp -s "$ST/bin/resident-codex-lead-recover.sh" "$FR/scripts/resident-codex-lead-recover.sh" \
  && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 4 ] \
  && grep -q 'flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh' "$SB/alerts.log" \
  && grep -q 'flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh' "$SB/alerts.log" \
  && grep -q 'flywheel-codex-lead-wrapper-codex-infra-bot.sh' "$SB/alerts.log" \
  && grep -q 'resident-codex-lead-recover.sh' "$SB/alerts.log"; then
  pass "C9c: post-adoption Codex carrier/recovery drift repairs loudly"
else fail "C9c: adopted carrier drift lost its alert (rc=$RC)"
  cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C9d: the marker controls alert wording only. If state storage cannot retain
# it, the already-healthy runtime wrappers remain eligible for restart while a
# loud diagnostic preserves the bookkeeping failure.
: > "$SB/alerts.log"
rm -rf "$ST/state/converge-adoptions"
mkdir -p "$ST/state"
: > "$ST/state/converge-adoptions"
run_converge; RC=$?
if [ "$RC" -eq 0 ] \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" "$FR/scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" "$FR/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh" "$FR/scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh" \
  && cmp -s "$ST/bin/resident-codex-lead-recover.sh" "$FR/scripts/resident-codex-lead-recover.sh" \
  && [ "$(grep -c 'adoption baseline FAILED' "$SB/alerts.log")" -eq 4 ]; then
  pass "C9d: adoption-marker failure alerts without blocking healthy runtime bytes"
else fail "C9d: bookkeeping marker blocked healthy convergence (rc=$RC)"
  cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi
rm -f "$ST/state/converge-adoptions"

# C10: the alert TRANSPORT is a hard dependency too. bounded-run.sh is what
# carries the "brake is missing" meta-alert out of the launch path; without it
# the notifier is a silent no-op (see fly1577-cmux-bin-closure.test.sh A1).
# Nested destination => install_script_atomic must create <bin>/lib itself.
: > "$SB/alerts.log"
seed_steady_state "$ST"
rm -rf "$ST/bin/lib"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ -d "$ST/bin/lib" ] \
   && cmp -s "$ST/bin/lib/bounded-run.sh" "$FR/scripts/lib/bounded-run.sh" \
   && cmp -s "$ST/bin/lib/lead-address.sh" "$FR/scripts/lib/lead-address.sh" \
   && [ "$(t_mode "$ST/bin/lib/bounded-run.sh")" = "555" ] \
   && [ "$(t_mode "$ST/bin/lib/lead-address.sh")" = "555" ] \
   && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 2 ]; then
  pass "C10: missing support-lib closure repaired to 555, <bin>/lib auto-created"
else fail "C10: nested copy not converged (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C11: the shape a human leaves behind. The Lead hand-restored the gate during
# the incident and it landed 700; converge must tighten it to 555 without
# alerting (mode-only drift is not a content breach — C5's contract).
: > "$SB/alerts.log"
seed_steady_state "$ST"
chmod 700 "$ST/bin/restart-storm-gate.py"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ "$(t_mode "$ST/bin/restart-storm-gate.py")" = "555" ] \
   && [ ! -s "$SB/alerts.log" ]; then
  pass "C11: hand-restored 700 gate tightened to 555, no alert"
else fail "C11: mode convergence (rc=$RC, mode=$(t_mode "$ST/bin/restart-storm-gate.py"))"
  cat "$SB/alerts.log" 2>/dev/null; fi

# C12: mode convergence must be IDEMPOTENT. mode_of() used to try BSD `stat -f`
# first, which on Linux succeeds in filesystem-status mode and never falls
# through to GNU -c — so an already-555 file was re-chmod'd and re-logged on
# every single run (every Lead start, every kickstart).
: > "$SB/alerts.log"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && ! grep -q 'mode tightened:' "$SB/out.log" \
   && [ ! -s "$SB/alerts.log" ]; then
  pass "C12: second run is a true no-op (no repeated 'mode tightened', no alert)"
else fail "C12: mode check not idempotent (rc=$RC)"; cat "$SB/out.log" 2>/dev/null; fi

echo ""; echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
