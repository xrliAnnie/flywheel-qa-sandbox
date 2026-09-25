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
    flywheel-lead.sh \
    flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh \
    resident-codex-lead-recover.sh \
    flywheel-codex-lead-wrapper-codex-infra-bot.sh \
    flywheel-lead-attach.sh flywheel-view-attach.sh flywheel-node-status.sh \
    verify-agent-visibility.sh lib/agent-visibility.sh \
    flywheel-bridge-wrapper.sh restart-services.sh \
    host-tmux-selection-gate.sh lib/bounded-run.sh lib/lead-address.sh \
    lib/lead-host-tmux-gate.sh lib/raya-standard-migration.sh lib/lead-backend-migration.sh lib/codex-quota-summary.mjs; do
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
# FLY-2695: the Raya CoS host shim is copied from the REAL repo source, not
# stubbed — C13 then proves the shipped bytes clear the install sanity floor
# and land in bin with sha == repo source and mode 555 (plan FLY-2680 §12 S2 ①).
cp "$REAL_REPO_ROOT/scripts/raya-cos.sh" "$FR/scripts/raya-cos.sh"

# FLY-1577: every case that is not specifically testing a missing/drifted copy
# must start from a converged copy-lane steady state — otherwise the widened
# FILES makes converge repair the un-seeded entries and the "exactly one alert"
# assertions below count repairs they never meant to trigger.
COPY_FILES="flywheel-lead-wrapper-v2.sh flywheel-lead.sh flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh resident-codex-lead-recover.sh flywheel-codex-lead-wrapper-codex-infra-bot.sh flywheel-lead-attach.sh flywheel-view-attach.sh flywheel-node-status.sh verify-agent-visibility.sh flywheel-bridge-wrapper.sh restart-services.sh restart-storm-gate.py host-tmux-selection-gate.sh lib/bounded-run.sh lib/agent-visibility.sh lib/lead-address.sh lib/lead-host-tmux-gate.sh lib/raya-standard-migration.sh lib/lead-backend-migration.sh lib/codex-quota-summary.mjs raya-cos.sh"
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
# The gate, formerly-unmanaged Codex carriers, and recovery helper must be
# installed atomically by this same convergence authority. Their first valid
# adoption is expected rollout work, not pre-existing integrity drift, so only
# the independently-new host gate alerts on this first pass.
: > "$SB/alerts.log"
seed_steady_state "$ST"
rm -rf "$ST/state/converge-adoptions"
rm -f "$ST/bin/host-tmux-selection-gate.sh" \
  "$ST/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" \
  "$ST/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh" \
  "$ST/bin/resident-codex-lead-recover.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] \
  && cmp -s "$ST/bin/host-tmux-selection-gate.sh" "$FR/scripts/host-tmux-selection-gate.sh" \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" "$FR/scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh" "$FR/scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh" \
  && cmp -s "$ST/bin/resident-codex-lead-recover.sh" "$FR/scripts/resident-codex-lead-recover.sh" \
  && [ "$(t_mode "$ST/bin/host-tmux-selection-gate.sh")" = "555" ] \
  && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 1 ] \
  && [ "$(t_mode "$ST/state/converge-adoptions/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh")" = "600" ] \
  && [ "$(t_mode "$ST/state/converge-adoptions/flywheel-codex-lead-wrapper-codex-infra-bot.sh")" = "600" ] \
  && [ "$(t_mode "$ST/state/converge-adoptions/resident-codex-lead-recover.sh")" = "600" ] \
  && [ "$(t_mode "$ST/state/converge-adoptions/lib__raya-standard-migration.sh")" = "600" ]; then
  pass "C9b: first Codex carrier/recovery/migration adoption converges silently and records durable baselines"
else fail "C9b: FLY-2190 runtime closure not converged (rc=$RC)"
  cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C9c: adoption is one-shot, never a permanent alert exemption. Once the
# durable baseline exists, every managed carrier/recovery artifact uses the
# normal severe drift repair path.
: > "$SB/alerts.log"
chmod u+w "$ST/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" \
  "$ST/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh" \
  "$ST/bin/resident-codex-lead-recover.sh"
printf '%s\n' '#!/bin/bash' > "$ST/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh"
printf '%s\n' '#!/bin/bash' > "$ST/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh"
printf '%s\n' '#!/bin/bash' > "$ST/bin/resident-codex-lead-recover.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" "$FR/scripts/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh" \
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh" "$FR/scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh" \
  && cmp -s "$ST/bin/resident-codex-lead-recover.sh" "$FR/scripts/resident-codex-lead-recover.sh" \
  && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 3 ] \
  && grep -q 'flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh' "$SB/alerts.log" \
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
  && cmp -s "$ST/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh" "$FR/scripts/flywheel-codex-lead-wrapper-codex-infra-bot.sh" \
  && cmp -s "$ST/bin/resident-codex-lead-recover.sh" "$FR/scripts/resident-codex-lead-recover.sh" \
  && cmp -s "$ST/bin/lib/raya-standard-migration.sh" "$FR/scripts/lib/raya-standard-migration.sh" \
   && cmp -s "$ST/bin/lib/lead-backend-migration.sh" "$FR/scripts/lib/lead-backend-migration.sh" \
  && [ "$(grep -c 'adoption baseline FAILED' "$SB/alerts.log")" -eq 7 ] \
  && grep -q 'adoption baseline FAILED for raya-cos.sh' "$SB/alerts.log"; then
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
   && cmp -s "$ST/bin/lib/agent-visibility.sh" "$FR/scripts/lib/agent-visibility.sh" \
   && cmp -s "$ST/bin/lib/lead-address.sh" "$FR/scripts/lib/lead-address.sh" \
   && cmp -s "$ST/bin/lib/lead-host-tmux-gate.sh" "$FR/scripts/lib/lead-host-tmux-gate.sh" \
   && cmp -s "$ST/bin/lib/raya-standard-migration.sh" "$FR/scripts/lib/raya-standard-migration.sh" \
   && cmp -s "$ST/bin/lib/lead-backend-migration.sh" "$FR/scripts/lib/lead-backend-migration.sh" \
   && [ "$(t_mode "$ST/bin/lib/bounded-run.sh")" = "555" ] \
   && [ "$(t_mode "$ST/bin/lib/agent-visibility.sh")" = "555" ] \
   && [ "$(t_mode "$ST/bin/lib/lead-address.sh")" = "555" ] \
   && [ "$(t_mode "$ST/bin/lib/lead-host-tmux-gate.sh")" = "555" ] \
   && [ "$(t_mode "$ST/bin/lib/raya-standard-migration.sh")" = "555" ] \
   && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 4 ] \
   && [ "$(t_mode "$ST/state/converge-adoptions/lib__raya-standard-migration.sh")" = "600" ]; then
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

# ── FLY-2695: Raya CoS host shim + the RETIRED_FILES contract ────────────────
#
# The shim enters the monorepo FILES as a first adoption (silent once, loud on
# every later drift). A PACKAGED tree never ships raya-cos, so there the name
# is RETIRED: any copy left in bin (e.g. from an earlier monorepo install on the
# same state root) is removed and the removal is PROVEN, never assumed.
SHIM_MARKER="$ST/state/converge-adoptions/raya-cos.sh"
write_shim_marker() {
  mkdir -p "$ST/state/converge-adoptions"
  printf 'managed=raya-cos.sh\nsourceSha=%s\n' "$(shasum -a 256 "$FR/scripts/raya-cos.sh" | awk '{print $1}')" > "$SHIM_MARKER"
  chmod 600 "$SHIM_MARKER"
}
install_bin_shim() {
  [ -e "$ST/bin/raya-cos.sh" ] && chmod u+w "$ST/bin/raya-cos.sh"
  cp "$FR/scripts/raya-cos.sh" "$ST/bin/raya-cos.sh"; chmod 555 "$ST/bin/raya-cos.sh"
}

# C13 (QA ①): first rollout onto a host that never had the shim → installed
# from the real repo source (sha equal, 555) and adopted silently exactly once.
: > "$SB/alerts.log"
rm -f "$FR/.flywheel-prebuilt"
seed_steady_state "$ST"
rm -f "$ST/bin/raya-cos.sh"
rm -rf "$ST/state/converge-adoptions"
run_converge; RC=$?
if [ "$RC" -eq 0 ] \
   && cmp -s "$ST/bin/raya-cos.sh" "$FR/scripts/raya-cos.sh" \
   && [ "$(shasum -a 256 < "$ST/bin/raya-cos.sh")" = "$(shasum -a 256 < "$REAL_REPO_ROOT/scripts/raya-cos.sh")" ] \
   && [ "$(t_mode "$ST/bin/raya-cos.sh")" = "555" ] \
   && grep -q 'first managed adoption recorded: raya-cos.sh' "$SB/out.log" \
   && [ ! -s "$SB/alerts.log" ] \
   && [ "$(t_mode "$SHIM_MARKER")" = "600" ] \
   && grep -Fqx 'managed=raya-cos.sh' "$SHIM_MARKER"; then
  pass "C13: raya-cos.sh first rollout → installed (sha == repo source, 555), adopted silently, marker 600"
else fail "C13: shim first adoption (rc=$RC, mode=$(t_mode "$ST/bin/raya-cos.sh"))"
  cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C14: adoption is one-shot — later drift of the shim repairs LOUDLY.
: > "$SB/alerts.log"
chmod u+w "$ST/bin/raya-cos.sh"; printf '%s\n' '#!/bin/bash' > "$ST/bin/raya-cos.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$ST/bin/raya-cos.sh" "$FR/scripts/raya-cos.sh" \
   && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 1 ] \
   && grep -q 'bin_integrity_drift' "$SB/alerts.log" \
   && grep -q 'raya-cos.sh|repaired' "$SB/alerts.log"; then
  pass "C14: post-adoption shim drift repaired + exactly one drift alert"
else fail "C14: adopted shim drift (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C15 (QA ⑤, plan §6.2 🔴 "pre-seed, then assert removal"): a packaged tree
# with a leftover 555 shim + adoption marker from an earlier monorepo install.
# An empty-bin fixture would pass vacuously — "not listed" only means "not
# managed", never "removed".
: > "$SB/alerts.log"
seed_steady_state "$ST"
touch "$FR/.flywheel-prebuilt"
install_bin_shim; write_shim_marker
echo 'belongs to a human, not to converge' > "$ST/bin/unrelated-user-file.txt"
run_converge; RC=$?
if [ "$RC" -eq 0 ] \
   && [ ! -e "$ST/bin/raya-cos.sh" ] && [ ! -L "$ST/bin/raya-cos.sh" ] \
   && [ ! -e "$SHIM_MARKER" ] && [ ! -L "$SHIM_MARKER" ] \
   && [ -f "$ST/bin/unrelated-user-file.txt" ] \
   && grep -q 'retired removed: raya-cos.sh' "$SB/out.log" \
   && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 1 ] \
   && grep -q 'raya-cos.sh|retired-removed' "$SB/alerts.log" \
   && ! grep -q 'srcmissing' "$SB/alerts.log" "$SB/out.log"; then
  pass "C15: packaged tree removes the leftover shim + marker (proven), keeps unrelated files, 0 srcmissing"
else fail "C15: packaged retirement (rc=$RC)"; ls -la "$ST/bin"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi
: > "$SB/alerts.log"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ ! -s "$SB/alerts.log" ] && ! grep -q 'retired removed' "$SB/out.log" \
   && [ -f "$ST/bin/unrelated-user-file.txt" ]; then
  pass "C15b: packaged retirement is idempotent — a second run is silent"
else fail "C15b: retirement not idempotent (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C16: a removal that cannot be PROVEN fails the run (rc=1 → the pre-kickstart
# mount refuses) and alerts; it never reads as clean. Read-only bin blocks rm.
: > "$SB/alerts.log"
install_bin_shim
chmod 555 "$ST/bin"
run_converge; RC=$?
chmod 755 "$ST/bin"
if [ "$RC" -eq 1 ] && [ -e "$ST/bin/raya-cos.sh" ] \
   && grep -q 'raya-cos.sh|retired-unproven' "$SB/alerts.log" \
   && ! grep -q 'retired removed' "$SB/out.log"; then
  pass "C16: unprovable retired removal → rc=1 + retired-unproven alert, never 'removed'"
else fail "C16: unprovable removal (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi
: > "$SB/alerts.log"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ ! -e "$ST/bin/raya-cos.sh" ] \
   && grep -q 'raya-cos.sh|retired-removed' "$SB/alerts.log"; then
  pass "C16: once bin is writable again the retired shim is removed (rc=0)"
else fail "C16: recovery after permissions restored (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C16b: the marker is ALWAYS taken through strict_discard. With the PARENT of
# the adoption directory unsearchable, -e/-L are both false for the marker,
# which must not read as "absent". (The parent, not converge-adoptions itself:
# the managed loop's record_adoption re-creates and chmods that directory.)
# Only the retired-marker assertions are this case's business — the managed
# loop's own "adoption baseline FAILED" alerts under a broken state dir are C9d's.
: > "$SB/alerts.log"
rm -f "$ST/bin/raya-cos.sh"
write_shim_marker
chmod 000 "$ST/state"
run_converge; RC=$?
chmod 700 "$ST/state"
if [ "$RC" -eq 1 ] && [ -e "$SHIM_MARKER" ] \
   && grep -q 'raya-cos.sh|retired-marker-unproven' "$SB/alerts.log" \
   && ! grep -q 'retired removed' "$SB/out.log"; then
  pass "C16b: marker behind an unsearchable parent → rc=1 + retired-marker-unproven, never 'removed'"
else fail "C16b: unprovable marker removal (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi
: > "$SB/alerts.log"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ ! -e "$SHIM_MARKER" ] \
   && [ "$(grep -c 'retired-removed' "$SB/alerts.log")" -eq 1 ]; then
  pass "C16b: parent restored → marker removed, exactly one retired-removed alert"
else fail "C16b: marker recovery (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C17: a name in BOTH FILES and RETIRED_FILES would install and delete on every
# run. The self-check refuses BEFORE any write: a managed file that genuinely
# needs repair stays missing (proves the exit is not "nothing to write").
: > "$SB/alerts.log"
rm -f "$FR/.flywheel-prebuilt"
seed_steady_state "$ST"
BOTH="$FR/scripts/converge-both-lists.sh"
sed 's/^RETIRED_FILES=""$/RETIRED_FILES="raya-cos.sh"/' "$CONVERGE" > "$BOTH"
rm -f "$ST/bin/restart-services.sh"
ALERT_LOG="$SB/alerts.log" FLYWHEEL_STATE_DIR="$ST" FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
  bash "$BOTH" >"$SB/out.log" 2>&1
RC=$?
if ! cmp -s "$CONVERGE" "$BOTH" && [ "$RC" -eq 1 ] \
   && grep -q 'raya-cos.sh is listed in both FILES and RETIRED_FILES' "$SB/out.log" \
   && [ ! -e "$ST/bin/restart-services.sh" ] && [ ! -s "$SB/alerts.log" ]; then
  pass "C17: FILES ∩ RETIRED_FILES → exit 1 before any write, no alert"
else fail "C17: list intersection self-check (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi
rm -f "$BOTH"

# C18: two converges overlap on first adoption (every Claude Lead start runs
# one, no shared lock). Deterministic sync point in the FIXTURE's lib copy only:
# a peer finishes the adoption after this run checked for the marker and before
# it installs. Eligibility is fixed before any check, so this run still takes
# the silent adoption path instead of a severe "drift repaired" alert.
: > "$SB/alerts.log"
seed_steady_state "$ST"
rm -f "$ST/bin/raya-cos.sh" "$SHIM_MARKER"
cp "$FR/scripts/lib/script-sanity.sh" "$SB/script-sanity.real"
{ sed 's/^install_script_atomic() {/__fly2695_real_install_script_atomic() {/' "$SB/script-sanity.real"
  cat <<'EOF'
# FLY-2695 C18 (test-only, fixture copy): a concurrent converger completes the
# shim's adoption between this run's eligibility check and its install.
install_script_atomic() {
  case "$2" in
    */bin/raya-cos.sh)
      mkdir -p "$ADOPTION_DIR" && chmod 700 "$ADOPTION_DIR" \
        && printf 'managed=raya-cos.sh\nsourceSha=peer\n' > "$ADOPTION_DIR/raya-cos.sh" \
        && chmod 600 "$ADOPTION_DIR/raya-cos.sh" && : > "$ADOPTION_DIR/../c18-peer-fired" ;;
  esac
  __fly2695_real_install_script_atomic "$@"
}
EOF
} > "$FR/scripts/lib/script-sanity.sh"
run_converge; RC=$?
cp "$SB/script-sanity.real" "$FR/scripts/lib/script-sanity.sh"
if [ "$RC" -eq 0 ] && [ -f "$ST/state/c18-peer-fired" ] \
   && cmp -s "$ST/bin/raya-cos.sh" "$FR/scripts/raya-cos.sh" \
   && [ "$(t_mode "$ST/bin/raya-cos.sh")" = "555" ] \
   && grep -q 'first managed adoption recorded: raya-cos.sh' "$SB/out.log" \
   && [ ! -s "$SB/alerts.log" ]; then
  pass "C18: overlapping first adoption stays silent (eligibility fixed before install)"
else fail "C18: concurrent first adoption (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi
rm -f "$ST/state/c18-peer-fired"
: > "$SB/alerts.log"
chmod u+w "$ST/bin/raya-cos.sh"; printf '%s\n' '#!/bin/bash' > "$ST/bin/raya-cos.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 1 ] \
   && grep -q 'raya-cos.sh|repaired' "$SB/alerts.log"; then
  pass "C18: after the overlap the adoption is spent — later drift alerts"
else fail "C18: post-overlap drift (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C19: two converges overlap on retirement. The shape predicates are separate
# tests, not one atomic observation; a peer can delete the shim between them.
# Sync point in the FIXTURE's path-hygiene.sh copy only: a test-only `[`
# function (bash lets a function shadow the builtin) forwards every call and,
# on the first TRUE shape predicate for the shim — the first line that tests it
# is the "had" probe, the next line is the shape check — deletes the target
# before returning. The fixed order (file / link / absent) must still prove the
# removal; the pre-fix order (exists && !file && !link) misreads the vanished
# file as an unsupported shape, which the mutation control below demonstrates.
cp "$FR/scripts/lib/path-hygiene.sh" "$SB/path-hygiene.real"
{ cat "$SB/path-hygiene.real"
  cat <<'EOF'
# FLY-2695 C19 (test-only, fixture copy): peer deletes the retired shim between
# two shape predicates of this run.
__c19_target="$FLYWHEEL_STATE_DIR/bin/raya-cos.sh"; __c19_probe_line=""; __c19_fired=0
[() {
  builtin [ "$@"; local r=$? a hit=0
  for a in "$@"; do test "$a" = "$__c19_target" && hit=1; done
  if test "$hit" = 1 && test "$__c19_fired" = 0; then
    if test -z "$__c19_probe_line"; then
      __c19_probe_line="${BASH_LINENO[0]}"
    elif test "${BASH_LINENO[0]}" != "$__c19_probe_line" && test "$r" = 0; then
      /bin/rm -f "$__c19_target"; __c19_fired=1; : > "$FLYWHEEL_STATE_DIR/c19-peer-fired"
    fi
  fi
  return "$r"
}
EOF
} > "$FR/scripts/lib/path-hygiene.sh"
c19_seed() {
  : > "$SB/alerts.log"; rm -f "$ST/c19-peer-fired"
  seed_steady_state "$ST"; install_bin_shim; write_shim_marker
}
touch "$FR/.flywheel-prebuilt"
c19_seed
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ -f "$ST/c19-peer-fired" ] \
   && [ ! -e "$ST/bin/raya-cos.sh" ] && [ ! -e "$SHIM_MARKER" ] \
   && ! grep -q 'retired-shape-unsupported' "$SB/alerts.log" \
   && [ "$(grep -c 'retired-removed' "$SB/alerts.log")" -le 1 ] \
   && [ -f "$ST/bin/unrelated-user-file.txt" ]; then
  pass "C19: shim deleted by a peer between shape predicates → still proven removed, rc=0"
else fail "C19: concurrent retirement (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi
# Mutation control: the same sync point against the PRE-FIX predicate order.
# If this does not go red, C19 above is not testing the order at all.
PREFIX="$FR/scripts/converge-prefix-order.sh"
sed 's/^  if \[ -f "\$dst" \] || \[ -L "\$dst" \] || \[ ! -e "\$dst" \]; then$/  if ! { [ -e "$dst" ] \&\& [ ! -f "$dst" ] \&\& [ ! -L "$dst" ]; }; then/' \
  "$CONVERGE" > "$PREFIX"
c19_seed
ALERT_LOG="$SB/alerts.log" FLYWHEEL_STATE_DIR="$ST" FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
  bash "$PREFIX" >"$SB/out.log" 2>&1
RC=$?
if ! cmp -s "$CONVERGE" "$PREFIX" && [ "$RC" -eq 1 ] && [ -f "$ST/c19-peer-fired" ] \
   && grep -q 'raya-cos.sh|retired-shape-unsupported' "$SB/alerts.log"; then
  pass "C19 mutation control: the pre-fix order misreads the same race as unsupported (rc=1)"
else fail "C19 mutation control: sync point does not bite the pre-fix order (rc=$RC)"
  cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi
rm -f "$PREFIX" "$ST/c19-peer-fired"
cp "$SB/path-hygiene.real" "$FR/scripts/lib/path-hygiene.sh"
rm -f "$FR/.flywheel-prebuilt"

echo ""; echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
