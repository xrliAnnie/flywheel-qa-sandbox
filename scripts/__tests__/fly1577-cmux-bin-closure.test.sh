#!/bin/bash
# FLY-1577: the cmux watcher's <state>/bin hard-dependency closure.
#
# Incident 2026-07-31. `~/.flywheel/bin/restart-storm-gate.py` was absent; the
# cmux watcher's fail-closed preflight refused to launch (exit 127 branch);
# launchd KeepAlive retried every 30s for hours; the founder lost her only view
# of what Runners were doing. converge-flywheel-bin.sh reported CLEAN the whole
# time, because the gate was not in FILES.
#
# The second, worse half: that branch is supposed to SHOUT — it calls
#   "$SELF_DIR/lib/bounded-run.sh" ... "$SELF_DIR/meta-alert.sh" ... >/dev/null 2>&1 || true
# and `$SELF_DIR` resolves to <state>/bin (the launchd plist runs the script
# through its bin symlink). Neither file was in bin. Command-not-found, output
# swallowed by the redirect, status swallowed by `|| true` — rc 0, zero
# delivery. The system did not go unheard; it never spoke.
#
# So this suite proves TWO things, not one:
#   A*  the alarm actually reaches a place a human can see (real meta-alert.sh,
#       real bounded-run.sh, real marker file) — A1 is the NEGATIVE CONTROL that
#       reproduces the silent incident shape and must stay green before AND after
#       the fix; without it, A2/A3 turning green would only prove "something got
#       called".
#   M*  meta-alert.sh's strict terminal state in bin (canonical symlink whose
#       source is sane+shebang+executable), including every unrepairable shape
#       failing LOUD with rc=1 instead of being reported healthy.
#
# Hermetic: trusted/worktree fake repos under scripts/__tests__/.tmp-* (a
# mktemp repo is temp-shaped by is_temp_or_worktree_root and could never reach
# the symlink lane), fixture HOMEs, stub alert sink, stub osascript.
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; shift; [ $# -gt 0 ] && echo "        $*"; return 0; }

REAL_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RSB="$(mktemp -d "${TESTS_DIR}/.tmp-fly1577-XXXXXX")"
SB="$(mktemp -d -t fly1577-closure-XXXXXX)"
# M12/M13 chmod the bin dir read-only on purpose; restore write bits before rm
# so cleanup can never depend on case ordering or leave the tree undeletable.
cleanup() { chmod -R u+w "$RSB" "$SB" 2>/dev/null; rm -rf "$RSB" "$SB"; }
trap cleanup EXIT

# Platform-portable stat helpers. GNU (-c) FIRST: GNU's -f means "file system
# status", so it succeeds with an unrelated multi-line block and the reverse
# order never falls through on Linux (scripts/flywheel-setup.sh::_fs_perm).
# Neither form dereferences a symlink, so t_inode() reads the LINK's own inode.
t_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
t_inode() { stat -c '%i' "$1" 2>/dev/null || stat -f '%i' "$1" 2>/dev/null; }
# device:inode — the same inode number on two filesystems is two different
# objects, so bare numbers both miss real aliases and invent false ones.
t_fsid() { stat -c '%d:%i' "$1" 2>/dev/null || stat -f '%d:%i' "$1" 2>/dev/null; }
# A comparison where both reads failed would be "" == "" — green for the wrong
# reason. Refuse to compare values we did not actually measure.
inode_ok() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
# Kept in lockstep with production id_ok: strictly digits:digits, so a lone
# colon or a stray extra field is a malformed reading rather than an identity.
fsid_ok() {
  case "$1" in ''|*[!0-9:]*) return 1 ;; esac
  case "$1" in *:*:*) return 1 ;; esac
  case "$1" in [0-9]*:[0-9]*) return 0 ;; *) return 1 ;; esac
}

pad() {  # <prefix> — filler that clears FLY-954's 1024B sanity floor with
         # substantive (non-comment) lines
  local i=1
  while [ "$i" -le 60 ]; do echo "$1 line $i placeholder padding text >/dev/null"; i=$((i+1)); done
}

COPY_FILES="flywheel-lead-wrapper-v2.sh flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh resident-codex-lead-recover.sh flywheel-codex-lead-wrapper-codex-infra-bot.sh flywheel-lead-attach.sh flywheel-view-attach.sh flywheel-node-status.sh flywheel-bridge-wrapper.sh restart-services.sh restart-storm-gate.py host-tmux-selection-gate.sh lib/bounded-run.sh lib/lead-address.sh"

# ── fake repos ───────────────────────────────────────────────────────────────
# The canonical flywheel-cmux-sync.sh IS the positive-control recorder. It has
# to be the canonical source rather than a hand-placed regular file in bin,
# because converge's FLY-1446 block archives a regular file at that path and
# replaces it with a symlink — i.e. converge would confiscate the ruler mid-test
# and "sync did not run" would pass for the wrong reason.
make_fake_repo() {  # <dir> <gitshape: dir|file>
  local fr="$1" shape="$2" f
  mkdir -p "$fr/scripts/lib" "$fr/packages/agent-team-transport/dist/bin"
  for f in lib/script-sanity.sh lib/path-hygiene.sh lib/tmux-server-rescue.sh \
           lib/bounded-run.sh meta-alert.sh converge-flywheel-bin.sh \
           flywheel-cmux-autostart.sh lead-patrol-snapshot.sh \
           flywheel-node-dwell-control.mjs; do
    cp "$REAL_REPO_ROOT/scripts/$f" "$fr/scripts/$f"
  done
  { echo "#!/usr/bin/env node"; pad "console.log('cli'); //"; } \
    > "$fr/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js"
  reset_repo_sources "$fr"
  if [ "$shape" = "dir" ]; then mkdir -p "$fr/.git"
  else echo "gitdir: /main/.git/worktrees/x" > "$fr/.git"; fi
}

# M7a/M7b deliberately corrupt the canonical meta-alert.sh source and M8/M9
# need it sane-but-0644, so every case restores a known baseline first —
# otherwise the suite silently depends on execution order and a case can end up
# measuring the wrong gate.
reset_repo_sources() {  # <repo>
  local fr="$1" f
  for f in flywheel-lead-wrapper-v2.sh \
      flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh \
      flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh \
      resident-codex-lead-recover.sh \
      flywheel-codex-lead-wrapper-codex-infra-bot.sh \
      flywheel-lead-attach.sh flywheel-view-attach.sh flywheel-node-status.sh \
      flywheel-bridge-wrapper.sh restart-services.sh \
      host-tmux-selection-gate.sh \
      lib/lead-address.sh; do
    { echo '#!/bin/bash'; pad "echo repo-$f"; } > "$fr/scripts/$f"
  done
  { echo '#!/usr/bin/env python3'; echo 'import sys'
    pad "print('gate')  #"; echo 'sys.exit(0)'; } > "$fr/scripts/restart-storm-gate.py"
  cp "$REAL_REPO_ROOT/scripts/meta-alert.sh" "$fr/scripts/meta-alert.sh"
  chmod 0755 "$fr/scripts/meta-alert.sh"
  { echo '#!/bin/bash'
    echo '# FLY-1577 positive control: proves "the watcher did not start" is a'
    echo '# real measurement and not just a missing target.'
    echo 'printf "SYNC-EXECUTED %s\n" "$*" >> "${SYNC_SENTINEL:?}"'
    pad ': #"'
    echo 'exit 0'
  } > "$fr/scripts/flywheel-cmux-sync.sh"
  chmod 0755 "$fr/scripts/flywheel-cmux-sync.sh"
}

TRUSTED="$RSB/trusted-repo"; make_fake_repo "$TRUSTED" dir
WORKTREE="$RSB/wt-repo";     make_fake_repo "$WORKTREE" file

ALERT="$SB/alert.sh"
cat > "$ALERT" <<'EOF'
#!/bin/bash
echo "ALERT $*" >> "${ALERT_LOG:?}"
exit 0
EOF
chmod +x "$ALERT"

# A neutral HOME for converge runs: keeping HOME out of the fixture state dir
# stops check-global-path-hygiene from switching into --alert mode (which would
# add alerts this suite counts) and keeps it away from the real ~/.flywheel.
HYG_HOME="$SB/hygiene-home"; mkdir -p "$HYG_HOME/.flywheel"

seed_copy_state() {  # <state-dir> <repo> — converged copy lane, mode 555
  local st="$1" repo="$2" f
  mkdir -p "$st/bin/lib"
  for f in $COPY_FILES; do
    [ -e "$st/bin/$f" ] && chmod u+w "$st/bin/$f" 2>/dev/null
    cp "$repo/scripts/$f" "$st/bin/$f"; chmod 555 "$st/bin/$f"
  done
  ln -sfn "$repo/scripts/lead-patrol-snapshot.sh" "$st/bin/flywheel-patrol-snapshot"
  ln -sfn "$repo/scripts/flywheel-node-dwell-control.mjs" "$st/bin/flywheel-node-dwell-control"
}

new_state() {  # <name> <repo> → echoes a fresh state dir seeded to copy steady state
  local st="$SB/state-$1"
  rm -rf "$st"; mkdir -p "$st/bin"
  seed_copy_state "$st" "$2"
  echo "$st"
}

run_conv() {  # <repo> <state-dir> [extra env pairs...] → rc; stdout+stderr in $SB/out.log
  local repo="$1" st="$2"; shift 2
  env ALERT_LOG="$SB/alerts.log" HOME="$HYG_HOME" FLYWHEEL_STATE_DIR="$st" \
    FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" "$@" \
    bash "$repo/scripts/converge-flywheel-bin.sh" >"$SB/out.log" 2>&1
}

# `grep -c` already prints 0 when nothing matches (and exits 1), so `|| echo 0`
# would emit a SECOND zero and every arithmetic comparison downstream would die
# with "integer expected" — turning a real failure into a confusing one.
alerts_total() { grep -c '^ALERT' "$SB/alerts.log" 2>/dev/null || true; }
alerts_sig()   { grep -c -- "$1" "$SB/alerts.log" 2>/dev/null || true; }
# expect_one <signature> — the target alert fired AND nothing else did. Counting
# only the target signature would let an un-seeded copy lane fire five repair
# alerts alongside it and still pass.
expect_one() { [ "$(alerts_sig "$1")" -eq 1 ] && [ "$(alerts_total)" -eq 1 ]; }

META_SRC() { echo "$1/scripts/meta-alert.sh"; }

# ─────────────────────────────────────────────────────────────────────────────
# A: does the alarm actually reach a human-visible place?
# ─────────────────────────────────────────────────────────────────────────────
REASON="restart_storm_gate_unavailable_cmux-watcher"
TITLE="Restart brake unavailable"

# The stub must win over the real osascript. autostart prepends
# /opt/homebrew/bin:/usr/local/bin to PATH, so a real binary there would shadow
# the stub and this suite would measure nothing (and pop desktop notifications
# on a real Mac). Fail loudly rather than mis-measure.
for d in /opt/homebrew/bin /usr/local/bin; do
  if [ -x "$d/osascript" ]; then
    fail "A0: $d/osascript would shadow the stub — cannot measure the desktop channel"
  fi
done

# setup_autostart_case <name> <closure: bare|closed> → echoes the case HOME.
# bare   = the incident shape: autostart link + sync recorder only.
# closed = plus the alert transport (real bounded-run.sh) and the real
#          meta-alert.sh, i.e. what converge is supposed to guarantee.
# The gate is never installed — that is what drives the fail-closed branch.
setup_autostart_case() {
  local name="$1" closure="$2" ah="$SB/ahome-$1"
  rm -rf "$ah"; mkdir -p "$ah/.flywheel/bin/lib" "$ah/.flywheel/state" "$ah/stub"
  ln -s "$TRUSTED/scripts/flywheel-cmux-autostart.sh" "$ah/.flywheel/bin/flywheel-cmux-autostart"
  ln -s "$TRUSTED/scripts/flywheel-cmux-sync.sh" "$ah/.flywheel/bin/flywheel-cmux-sync"
  if [ "$closure" = "closed" ]; then
    cp "$TRUSTED/scripts/lib/bounded-run.sh" "$ah/.flywheel/bin/lib/bounded-run.sh"
    cp "$TRUSTED/scripts/meta-alert.sh" "$ah/.flywheel/bin/meta-alert.sh"
    chmod 555 "$ah/.flywheel/bin/lib/bounded-run.sh" "$ah/.flywheel/bin/meta-alert.sh"
  fi
  cat > "$ah/stub/osascript" <<'EOF'
#!/bin/bash
echo "OSASCRIPT $*" >> "${OSA_LOG:?}"
exit 0
EOF
  chmod +x "$ah/stub/osascript"
  : > "$ah/osa.log"
  echo "$ah"
}

run_autostart() {  # <home> → rc
  local ah="$1"
  env -i HOME="$ah" PATH="$ah/stub:/usr/bin:/bin" \
    OSA_LOG="$ah/osa.log" SYNC_SENTINEL="$ah/sync.sentinel" \
    FLYWHEEL_CMUX_SUPERVISED=1 \
    /bin/bash "$ah/.flywheel/bin/flywheel-cmux-autostart" \
    >"$ah/stdout" 2>"$ah/stderr"
}

marker_of() { echo "$1/.flywheel/state/meta-alert/${REASON}.txt"; }

# assert_observation_surface_clean <home> — every A case must start from
# nothing-observed, or a previous case's marker satisfies this one's assertions.
# It also re-checks the positive control itself: "sync did not run" is only a
# measurement if the thing that would have recorded it is present, is the exact
# canonical symlink, and is executable. A broken recorder makes the sentinel
# absent for a trivial reason.
assert_observation_surface_clean() {
  local ah="$1" sync="$1/.flywheel/bin/flywheel-cmux-sync"
  [ -L "$sync" ] || { echo "        (precondition: $sync is not a symlink)"; return 1; }
  [ "$(readlink "$sync")" = "$TRUSTED/scripts/flywheel-cmux-sync.sh" ] \
    || { echo "        (precondition: sync recorder is not the canonical target)"; return 1; }
  [ -x "$sync" ] || { echo "        (precondition: sync recorder target is not executable)"; return 1; }
  [ ! -e "$(marker_of "$ah")" ] && [ ! -s "$ah/osa.log" ] && [ ! -e "$ah/sync.sentinel" ]
}

# assert_alarm_delivered <home> <label> — the real, human-visible evidence.
assert_alarm_delivered() {
  local ah="$1" label="$2" m; m="$(marker_of "$ah")" ok=1
  [ -f "$m" ] || { ok=0; fail "$label: meta-alert marker was never written ($m)"; }
  if [ -f "$m" ]; then
    grep -q "reason=${REASON}" "$m" || { ok=0; fail "$label: marker missing reason=${REASON}"; }
    grep -q "$TITLE" "$m" || { ok=0; fail "$label: marker missing title '$TITLE'"; }
    grep -q 'exit 127' "$m" || { ok=0; fail "$label: marker body missing the gate's exit status"; }
  fi
  [ "$(grep -c '^OSASCRIPT' "$ah/osa.log")" -eq 1 ] \
    || { ok=0; fail "$label: desktop channel not invoked exactly once"; }
  grep -q "Flywheel: $TITLE" "$ah/osa.log" \
    || { ok=0; fail "$label: desktop channel argv missing 'Flywheel: $TITLE'"; }
  [ ! -e "$ah/sync.sentinel" ] || { ok=0; fail "$label: the watcher was launched despite a missing brake"; }
  [ "$ok" = "1" ]
}

# A1 — NEGATIVE CONTROL. Reproduces production bin exactly: the alert chain is
# absent, so the shout is swallowed. Must be green before AND after the fix; it
# is what makes A2/A3 meaningful rather than "a recorder got called".
AH="$(setup_autostart_case a1 bare)"
if ! assert_observation_surface_clean "$AH"; then
  fail "A1: observation surface / positive control was not sound before the run"
else
  run_autostart "$AH"; RC=$?
  if [ "$RC" -eq 0 ] \
     && [ ! -e "$(marker_of "$AH")" ] && [ ! -s "$AH/osa.log" ] \
     && [ ! -e "$AH/sync.sentinel" ] \
     && grep -q 'restart brake missing' "$AH/stderr"; then
    pass "A1 (negative control): incident bin shape → brake refused, alarm SILENT, zero delivery"
  else
    fail "A1: incident shape did not reproduce (rc=$RC)" "$(tail -3 "$AH/stderr" 2>/dev/null)"
  fi
fi

# A2 — the same refusal, with the alert closure present: the shout lands.
AH="$(setup_autostart_case a2 closed)"
if ! assert_observation_surface_clean "$AH"; then
  fail "A2: observation surface was not clean before the run"
else
  run_autostart "$AH"; RC=$?
  if [ "$RC" -eq 0 ] && assert_alarm_delivered "$AH" "A2"; then
    pass "A2: with lib/bounded-run.sh + meta-alert.sh in bin → marker written, desktop channel fired"
  else
    fail "A2: alarm not delivered (rc=$RC)" "$(tail -3 "$AH/stderr" 2>/dev/null)"
  fi
fi

# A3 — the closure produced by CONVERGE ITSELF, not by this test's hands. This
# is the one that ties the fix to the outcome: converge the bin, prove the three
# terminal shapes, wipe the observation surface, remove only the gate, and show
# the alarm still reaches a human.
AH="$SB/ahome-a3"; rm -rf "$AH"; mkdir -p "$AH/.flywheel" "$AH/stub"
: > "$SB/alerts.log"
run_conv "$TRUSTED" "$AH/.flywheel"; RC=$?
A3_SETUP=1
[ "$RC" -eq 0 ] || { A3_SETUP=0; fail "A3: converge failed to build the bin (rc=$RC)" "$(tail -5 "$SB/out.log")"; }
if [ "$A3_SETUP" = "1" ]; then
  cmp -s "$AH/.flywheel/bin/restart-storm-gate.py" "$TRUSTED/scripts/restart-storm-gate.py" \
    || { A3_SETUP=0; fail "A3: converge did not install the gate"; }
  [ "$(t_mode "$AH/.flywheel/bin/restart-storm-gate.py")" = "555" ] \
    || { A3_SETUP=0; fail "A3: converged gate is not 555"; }
  cmp -s "$AH/.flywheel/bin/lib/bounded-run.sh" "$TRUSTED/scripts/lib/bounded-run.sh" \
    || { A3_SETUP=0; fail "A3: converge did not install lib/bounded-run.sh"; }
  [ "$(t_mode "$AH/.flywheel/bin/lib/bounded-run.sh")" = "555" ] \
    || { A3_SETUP=0; fail "A3: converged bounded-run.sh is not 555"; }
  [ "$(readlink "$AH/.flywheel/bin/meta-alert.sh")" = "$(META_SRC "$TRUSTED")" ] \
    || { A3_SETUP=0; fail "A3: meta-alert.sh is not the exact canonical symlink"; }
fi
if [ "$A3_SETUP" = "1" ]; then
  # autostart needs its own entry points; converge owns bin content, not these.
  ln -sf "$TRUSTED/scripts/flywheel-cmux-autostart.sh" "$AH/.flywheel/bin/flywheel-cmux-autostart"
  ln -sf "$TRUSTED/scripts/flywheel-cmux-sync.sh" "$AH/.flywheel/bin/flywheel-cmux-sync"
  cat > "$AH/stub/osascript" <<'EOF'
#!/bin/bash
echo "OSASCRIPT $*" >> "${OSA_LOG:?}"
exit 0
EOF
  chmod +x "$AH/stub/osascript"
  mkdir -p "$AH/.flywheel/state"
  # wipe the observation surface AFTER the converge stage
  rm -rf "$AH/.flywheel/state/meta-alert"; : > "$AH/osa.log"; rm -f "$AH/sync.sentinel"
  chmod u+w "$AH/.flywheel/bin/restart-storm-gate.py"; rm -f "$AH/.flywheel/bin/restart-storm-gate.py"
  if ! assert_observation_surface_clean "$AH"; then
    fail "A3: observation surface was not clean before the run"
  else
    run_autostart "$AH"; RC=$?
    if [ "$RC" -eq 0 ] && assert_alarm_delivered "$AH" "A3"; then
      pass "A3: the bin CONVERGE produced is sufficient — brake removed → alarm reaches a human"
    else
      fail "A3: converged closure did not deliver (rc=$RC)" "$(tail -3 "$AH/stderr" 2>/dev/null)"
    fi
  fi
fi

# A4: the two meta-alert channels are INDEPENDENT — knocking out the durable one
# must not take the desktop one with it. This is the property that makes
# meta-alert's "always exit 0, best-effort" contract defensible: it is allowed to
# be best-effort precisely because it is not a single point of failure. If the
# channels ever became coupled, that contract would quietly turn into "one bad
# permission bit and nobody hears anything", which is the FLY-742 shape again.
# (What happens when BOTH channels are down is a measured, open question with
# the Lead — deliberately not asserted here, because asserting today's behaviour
# would cement it.)
AH="$(setup_autostart_case a4 closed)"
mkdir -p "$AH/.flywheel/state/meta-alert"; chmod 500 "$AH/.flywheel/state/meta-alert"
run_autostart "$AH"; RC=$?
chmod 700 "$AH/.flywheel/state/meta-alert"
if [ "$RC" -eq 0 ] && [ ! -e "$(marker_of "$AH")" ] \
   && [ "$(grep -c '^OSASCRIPT' "$AH/osa.log")" -eq 1 ]; then
  pass "A4: durable channel unwritable → the desktop channel still fires (channels are independent)"
else
  fail "A4: knocking out the marker also silenced the desktop channel (rc=$RC, osa=$(grep -c '^OSASCRIPT' "$AH/osa.log" 2>/dev/null))"
fi

# A5 (FLY-1577, Lead decision "丁"): when the durable channel cannot be written,
# the failure has to leave a trace that does not depend on the caller's stderr —
# every launch-path caller runs the notifier as `... >/dev/null 2>&1 || true`, so
# a shell redirect error is discarded and zero delivery reads as success.
#
# This asserts the FIX, not today's-behaviour-as-correct: the both-channels-down
# state is still not blessed as acceptable, it now simply leaves evidence. The
# exit status and the caller's redirect are deliberately untouched (this sits on
# launchd launch paths; FLY-1501's bounded-run exists so a notifier can never
# wedge the service it reports on).
AH="$(setup_autostart_case a5 closed)"
A5_TMP="$AH/fallback"; mkdir -p "$A5_TMP"
mkdir -p "$AH/.flywheel/state/meta-alert"; chmod 500 "$AH/.flywheel/state/meta-alert"
# BOTH channels must be down, or this proves nothing about an independent
# escape: with the desktop stub still returning 0, a fallback that only fires
# when osascript SUCCEEDS would pass too.
cat > "$AH/stub/osascript" <<'OSAEOF'
#!/bin/bash
echo "OSA $*" >> "${OSA_LOG:?}"
exit 1
OSAEOF
chmod +x "$AH/stub/osascript"
env -i HOME="$AH" PATH="$AH/stub:/usr/bin:/bin" TMPDIR="$A5_TMP" \
  OSA_LOG="$AH/osa.log" SYNC_SENTINEL="$AH/sync.sentinel" \
  FLYWHEEL_CMUX_SUPERVISED=1 \
  /bin/bash "$AH/.flywheel/bin/flywheel-cmux-autostart" >"$AH/stdout" 2>"$AH/stderr"
RC=$?
chmod 700 "$AH/.flywheel/state/meta-alert"
A5_N="$(ls "$A5_TMP"/flywheel-meta-alert-undelivered-*.txt 2>/dev/null | wc -l | tr -d ' ')"
A5_FB="$(ls "$A5_TMP"/flywheel-meta-alert-undelivered-*.txt 2>/dev/null | head -1)"
A5_OK=1
[ "$RC" -eq 0 ] || { A5_OK=0; fail "A5: the caller's exit status changed (rc=$RC) — the launch path must not be wedged"; }
[ ! -e "$(marker_of "$AH")" ] || { A5_OK=0; fail "A5: precondition not built — the durable marker was writable after all"; }
[ "$(grep -c '^OSA' "$AH/osa.log" 2>/dev/null)" -ge 1 ] \
  || { A5_OK=0; fail "A5: precondition not built — the desktop channel was never even attempted"; }
[ "$A5_N" = "1" ] || { A5_OK=0; fail "A5: expected exactly one fallback record, found $A5_N"; }
if [ -n "$A5_FB" ]; then
  # All four fields the contract promises — a trace that names none of them is
  # not a trace of THIS alert.
  grep -q "UNDELIVERED" "$A5_FB" || { A5_OK=0; fail "A5: trace does not say it was undelivered"; }
  grep -q "reason=$REASON" "$A5_FB" || { A5_OK=0; fail "A5: trace does not name the reason"; }
  grep -q "title=$TITLE" "$A5_FB" || { A5_OK=0; fail "A5: trace does not carry the title"; }
  grep -q "intended_marker=.*meta-alert" "$A5_FB" || { A5_OK=0; fail "A5: trace does not name the marker it could not write"; }
  grep -q "exit 127" "$A5_FB" || { A5_OK=0; fail "A5: trace does not carry the body"; }
  [ ! -L "$A5_FB" ] || { A5_OK=0; fail "A5: the published trace is a symlink, not a regular file"; }
  [ "$(t_mode "$A5_FB")" = "600" ] || { A5_OK=0; fail "A5: trace mode is $(t_mode "$A5_FB"), expected 600 (it can carry alert body detail)"; }
  [ -z "$(ls "$A5_TMP"/*.XXXXXX* 2>/dev/null)" ] || { A5_OK=0; fail "A5: temp residue left behind"; }
else
  A5_OK=0; fail "A5: both channels down and NO trace outside the caller's discarded stderr"
fi
[ ! -e "$AH/sync.sentinel" ] || { A5_OK=0; fail "A5: the watcher was launched despite a missing brake"; }
[ "$A5_OK" = "1" ] && pass "A5: both channels down → one 0600 regular trace naming reason/title/marker/body, caller still exits 0"

# A6: the loss shape A5 cannot see. A marker left over from an EARLIER alert is
# non-empty, so a fallback keyed on "is the pathname empty?" never fires — the
# stale bytes of some other alert masquerade as this one's delivery. The trigger
# has to be THIS write's own result, not whatever happens to sit at the path.
# A6 drives meta-alert.sh DIRECTLY rather than through autostart. Its subject is
# the fallback trigger, and going through the launch path added nothing except
# the one thing that makes this undiagnosable: the caller's `>/dev/null 2>&1`
# swallows the notifier's own stderr, so when this case failed on CI there was
# no way to see why. The redirect this whole issue is about was hiding the
# evidence from the test written to prove the issue.
A6D="$SB/a6"; rm -rf "$A6D"; mkdir -p "$A6D/state" "$A6D/tmp"
A6_BODY="body mentioning exit 127"
run_meta() {  # <state-dir> → rc; stderr in $A6D/err
  env -i PATH="$SHIM_PATH_FOR_META:/usr/bin:/bin" \
    FLYWHEEL_STATE_DIR="$1" TMPDIR="$A6D/tmp" \
    FLYWHEEL_META_ALERT_DEBOUNCE_MS=0 OSA_LOG="$A6D/osa.log" \
    /bin/bash "$TRUSTED/scripts/meta-alert.sh" "$REASON" "$TITLE" "$A6_BODY" \
    >"$A6D/out" 2>"$A6D/err"
}
SHIM_PATH_FOR_META="$A6D/stub"; mkdir -p "$SHIM_PATH_FOR_META"
cat > "$SHIM_PATH_FOR_META/osascript" <<'OSAEOF'
#!/bin/bash
echo "OSA $*" >> "${OSA_LOG:?}"
exit 1
OSAEOF
chmod +x "$SHIM_PATH_FOR_META/osascript"
: > "$A6D/osa.log"

# 1. let the notifier create its own marker, so the path comes from the system
#    under test rather than being re-derived beside it
run_meta "$A6D/state"
A6_MARKER="$(ls "$A6D/state/meta-alert/"*.txt 2>/dev/null | head -1)"
A6_OK=1
[ -n "$A6_MARKER" ] || { A6_OK=0; fail "A6: setup run produced no marker — cannot build the stale-marker shape"; }
if [ "$A6_OK" = "1" ]; then
  printf 'STALE MARKER FROM AN EARLIER ALERT\n' > "$A6_MARKER"
  rm -f "$A6D/tmp"/flywheel-meta-alert-undelivered-*.txt 2>/dev/null
  # the FILE must be unwritable: `>` over an existing file needs write
  # permission on the file, so a read-only directory would not stop it
  chmod 444 "$A6_MARKER"
  run_meta "$A6D/state"; RC=$?
  chmod 644 "$A6_MARKER" 2>/dev/null
  A6_FB="$(ls "$A6D/tmp"/flywheel-meta-alert-undelivered-*.txt 2>/dev/null | head -1)"
  [ "$RC" -eq 0 ] || { A6_OK=0; fail "A6: meta-alert must always exit 0 (got $RC)"; }
  grep -q "STALE MARKER" "$A6_MARKER" 2>/dev/null \
    || { A6_OK=0; fail "A6: precondition not built — the stale marker was overwritten, so the write did not fail"; }
  if [ -n "$A6_FB" ]; then
    grep -q "reason=$REASON" "$A6_FB" || { A6_OK=0; fail "A6: the trace is not about this alert"; }
  else
    A6_OK=0
    fail "A6: a stale marker from another alert masked this failure — no trace written" \
      "tmp dir: [$(ls -la "$A6D/tmp" 2>&1 | tr '\n' '|')] | meta-alert stderr: [$(tr '\n' '|' < "$A6D/err" 2>/dev/null | head -c 500)]"
  fi
fi
[ "$A6_OK" = "1" ] && pass "A6: stale non-empty marker + failed write → still traced (trigger is the write, not the path)"

# ─────────────────────────────────────────────────────────────────────────────
# M: meta-alert.sh's strict terminal state in bin
# ─────────────────────────────────────────────────────────────────────────────

# M1 (T2): absent → created, exactly one alert and nothing else.
ST="$(new_state m1 "$TRUSTED")"; : > "$SB/alerts.log"
run_conv "$TRUSTED" "$ST"; RC=$?
if [ "$RC" -eq 0 ] && [ -L "$ST/bin/meta-alert.sh" ] \
   && [ "$(readlink "$ST/bin/meta-alert.sh")" = "$(META_SRC "$TRUSTED")" ] \
   && expect_one 'meta-alert.sh'; then
  pass "M1: absent meta-alert.sh created as the canonical symlink (+1 alert)"
else fail "M1: absent-create (rc=$RC, alerts=$(alerts_total))" "$(cat "$SB/alerts.log")"; fi

# M2 (T1): idempotent — a converged closure must be silent.
: > "$SB/alerts.log"
run_conv "$TRUSTED" "$ST"; RC=$?
if [ "$RC" -eq 0 ] && [ ! -s "$SB/alerts.log" ]; then
  pass "M2: second run → silent no-op"
else fail "M2: not idempotent (rc=$RC)" "$(cat "$SB/alerts.log")"; fi

# M3 (T6): a regular-file deployment copy — Codex's original counter-example was
# mode 000, which converge used to leave in place while reporting healthy.
# The archive is compared byte-for-byte, but a 000 file cannot be read by cmp
# (it exits 2), so the expected bytes are kept separately and the archive's read
# bit is restored inside the fixture only after its shape has been checked.
ST="$(new_state m3 "$TRUSTED")"; : > "$SB/alerts.log"
printf 'deployed-copy-bytes-fly1577\n' > "$SB/m3-expected"
cp "$SB/m3-expected" "$ST/bin/meta-alert.sh"; chmod 000 "$ST/bin/meta-alert.sh"
run_conv "$TRUSTED" "$ST"; RC=$?
M3_ARCHIVE="$(ls "$ST/bin/"meta-alert.sh.bak-shape-* 2>/dev/null | head -1)"
M3_OK=1
[ "$RC" -eq 0 ] || { M3_OK=0; fail "M3: rc=$RC"; }
[ -L "$ST/bin/meta-alert.sh" ] && [ "$(readlink "$ST/bin/meta-alert.sh")" = "$(META_SRC "$TRUSTED")" ] \
  || { M3_OK=0; fail "M3: regular-file copy was not converged to the canonical symlink"; }
if [ -n "$M3_ARCHIVE" ]; then
  chmod u+r "$M3_ARCHIVE" 2>/dev/null
  cmp -s "$M3_ARCHIVE" "$SB/m3-expected" || { M3_OK=0; fail "M3: archive is not the original bytes"; }
else M3_OK=0; fail "M3: no forensic archive was left"; fi
expect_one 'meta-alert.sh' || { M3_OK=0; fail "M3: expected exactly one alert, got $(alerts_total)"; }
[ "$M3_OK" = "1" ] && pass "M3: mode-000 regular file archived byte-exact, then replaced by the canonical symlink"

# M4 (T7): an unsupported shape must fail LOUD, never be reported healthy.
ST="$(new_state m4 "$TRUSTED")"; : > "$SB/alerts.log"
mkdir -p "$ST/bin/meta-alert.sh"
run_conv "$TRUSTED" "$ST"; RC=$?
if [ "$RC" -ne 0 ] && [ -d "$ST/bin/meta-alert.sh" ] && expect_one 'meta-alert.sh'; then
  pass "M4: directory at meta-alert.sh → untouched, alerted, rc=1"
else fail "M4: unsupported shape tolerated (rc=$RC)" "$(cat "$SB/alerts.log")"; fi

# M5 (T5): a symlink that exists and resolves, but not to the canonical source.
ST="$(new_state m5 "$TRUSTED")"; : > "$SB/alerts.log"
printf '#!/bin/bash\n' > "$SB/decoy-meta.sh"; pad 'echo decoy' >> "$SB/decoy-meta.sh"; chmod 0755 "$SB/decoy-meta.sh"
ln -s "$SB/decoy-meta.sh" "$ST/bin/meta-alert.sh"
run_conv "$TRUSTED" "$ST"; RC=$?
if [ "$RC" -eq 0 ] && [ "$(readlink "$ST/bin/meta-alert.sh")" = "$(META_SRC "$TRUSTED")" ] \
   && expect_one 'meta-alert.sh'; then
  pass "M5: link pointing somewhere else → re-pointed at the canonical source"
else fail "M5: wrong-target not corrected (rc=$RC)" "$(cat "$SB/alerts.log")"; fi

# M6 (T8): broken link AND no usable source → repair is impossible, so say so
# with rc=1. Reporting 0 here would tell the kickstart path "safe to proceed".
BADREPO="$RSB/nosrc-repo"; make_fake_repo "$BADREPO" dir
printf '#!/bin/bash\n' > "$BADREPO/scripts/meta-alert.sh"   # below the sanity floor
ST="$(new_state m6 "$BADREPO")"; : > "$SB/alerts.log"
ln -s "$SB/gone/meta-alert.sh" "$ST/bin/meta-alert.sh"
run_conv "$BADREPO" "$ST"; RC=$?
if [ "$RC" -ne 0 ] && expect_one 'meta-alert.sh'; then
  pass "M6: broken link + unusable source → alert + rc=1 (never silently healthy)"
else fail "M6: unrepairable link reported healthy (rc=$RC)" "$(cat "$SB/alerts.log")"; fi

# M7a (T9): the gap R2 caught — the link is already canonical, so the old code
# `continue`d before ever checking the source. A rotted alert source is a broken
# alert chain. The link must not be touched (inode identity, not readlink text:
# delete-and-recreate would pass a text comparison).
ST="$(new_state m7a "$TRUSTED")"; : > "$SB/alerts.log"
ln -s "$(META_SRC "$TRUSTED")" "$ST/bin/meta-alert.sh"
M7A_INO="$(t_inode "$ST/bin/meta-alert.sh")"
printf '#!/bin/bash\n' > "$TRUSTED/scripts/meta-alert.sh"    # insane: under the floor
run_conv "$TRUSTED" "$ST"; RC=$?
M7A_INO2="$(t_inode "$ST/bin/meta-alert.sh")"
if [ "$RC" -ne 0 ] && inode_ok "$M7A_INO" && [ "$M7A_INO" = "$M7A_INO2" ] \
   && expect_one 'meta-alert.sh'; then
  pass "M7a: canonical link + insane source → link untouched, alert, rc=1"
else fail "M7a: rotted source reported healthy (rc=$RC, inode $M7A_INO->$M7A_INO2)" "$(cat "$SB/alerts.log")"; fi
reset_repo_sources "$TRUSTED"

# M7b: same terminal state, reached through the SHEBANG gate rather than the
# sanity gate — split out so a source that fails both cannot let the shebang
# check go permanently untested.
ST="$(new_state m7b "$TRUSTED")"; : > "$SB/alerts.log"
ln -s "$(META_SRC "$TRUSTED")" "$ST/bin/meta-alert.sh"
M7B_INO="$(t_inode "$ST/bin/meta-alert.sh")"
{ echo 'echo no-shebang-here'; pad 'echo body'; } > "$TRUSTED/scripts/meta-alert.sh"
chmod 0755 "$TRUSTED/scripts/meta-alert.sh"
run_conv "$TRUSTED" "$ST"; RC=$?
M7B_INO2="$(t_inode "$ST/bin/meta-alert.sh")"
if [ "$RC" -ne 0 ] && inode_ok "$M7B_INO" && [ "$M7B_INO" = "$M7B_INO2" ] \
   && expect_one 'meta-alert.sh'; then
  pass "M7b: canonical link + shebang-less (but sane-sized) source → untouched, alert, rc=1"
else fail "M7b: shebang gate not reached (rc=$RC, inode $M7B_INO->$M7B_INO2)" "$(cat "$SB/alerts.log")"; fi
reset_repo_sources "$TRUSTED"

# M8 (T10): a 0644 source is the normal fresh-checkout shape. Fix the source's
# mode, do not rebuild the link, and stay quiet.
ST="$(new_state m8 "$TRUSTED")"; : > "$SB/alerts.log"
ln -s "$(META_SRC "$TRUSTED")" "$ST/bin/meta-alert.sh"
chmod 0644 "$TRUSTED/scripts/meta-alert.sh"
M8_INO="$(t_inode "$ST/bin/meta-alert.sh")"
run_conv "$TRUSTED" "$ST"; RC=$?
M8_INO2="$(t_inode "$ST/bin/meta-alert.sh")"
if [ "$RC" -eq 0 ] && inode_ok "$M8_INO" && [ "$M8_INO" = "$M8_INO2" ] \
   && [ -x "$(META_SRC "$TRUSTED")" ] && [ ! -s "$SB/alerts.log" ]; then
  pass "M8: canonical link + 0644 source → source chmod'd, link NOT rebuilt, no alert"
else fail "M8: 0644 handling (rc=$RC, inode $M8_INO->$M8_INO2)" "$(cat "$SB/alerts.log")"; fi
reset_repo_sources "$TRUSTED"

# M9 (T2 + source readiness): creating the link from a 0644 source.
ST="$(new_state m9 "$TRUSTED")"; : > "$SB/alerts.log"
chmod 0644 "$TRUSTED/scripts/meta-alert.sh"
run_conv "$TRUSTED" "$ST"; RC=$?
if [ "$RC" -eq 0 ] && [ "$(readlink "$ST/bin/meta-alert.sh")" = "$(META_SRC "$TRUSTED")" ] \
   && [ -x "$(META_SRC "$TRUSTED")" ]; then
  pass "M9: absent link + 0644 source → source auto-chmod'd, link created"
else fail "M9: 0644 create (rc=$RC)" "$(cat "$SB/alerts.log")"; fi
reset_repo_sources "$TRUSTED"

# M10: FLY-1389's boundary is untouched — a worktree/temp checkout has no
# trusted source to repair FROM, so it must not create anything.
ST="$(new_state m10 "$WORKTREE")"; : > "$SB/alerts.log"
run_conv "$WORKTREE" "$ST"; RC=$?
if [ ! -e "$ST/bin/meta-alert.sh" ]; then
  pass "M10: worktree-shaped checkout never creates the link (FLY-1389 boundary intact)"
else fail "M10: worktree checkout wrote a global-shaped link (rc=$RC)"; fi

# M11: the four pre-existing symlink names keep their old semantics — absence is
# still the installer's business, not converge's. Widening the strict regime to
# them would be a much larger blast radius than this incident justifies.
ST="$(new_state m11 "$TRUSTED")"; : > "$SB/alerts.log"
run_conv "$TRUSTED" "$ST"; RC=$?
M11_OK=1
for n in agent-team-transport tmux-server-rescue flywheel-cmux-sync flywheel-cmux-autostart; do
  [ -e "$ST/bin/$n" ] && { M11_OK=0; fail "M11: converge created $n, which it never used to"; }
done
[ "$RC" -eq 0 ] || { M11_OK=0; fail "M11: rc=$RC — the four legacy names must not affect rc"; }
[ "$M11_OK" = "1" ] && pass "M11: legacy symlink names unchanged (absent stays absent, rc unaffected)"

# M12 (§3.5-1): publishing fails → the path must stay absent, leave no tmp
# behind, alert, and rc=1. Never report a link it did not manage to create.
ST="$(new_state m12 "$TRUSTED")"; : > "$SB/alerts.log"
chmod 555 "$ST/bin"
run_conv "$TRUSTED" "$ST"; RC=$?
chmod 755 "$ST/bin"
M12_TMP="$(ls "$ST/bin/"meta-alert.sh.tmp.* 2>/dev/null | wc -l | tr -d ' ')"
if [ "$RC" -ne 0 ] && [ ! -e "$ST/bin/meta-alert.sh" ] && [ "$M12_TMP" = "0" ] \
   && expect_one 'meta-alert.sh'; then
  pass "M12: publish failure → path stays absent, no tmp residue, alert, rc=1"
else fail "M12: publish failure (rc=$RC, tmp=$M12_TMP, exists=$([ -e "$ST/bin/meta-alert.sh" ] && echo y || echo n))"; fi

# M13 (§3.5-3): archive failure on the strict regular-file path. The existing
# FLY-1446 C2 case does NOT cover this — it exercises the inline cmux block, not
# the strict one, so a bug here could ship behind a green C2.
ST="$(new_state m13 "$TRUSTED")"; : > "$SB/alerts.log"
printf 'deployed-copy-bytes-m13\n' > "$SB/m13-expected"
cp "$SB/m13-expected" "$ST/bin/meta-alert.sh"; chmod 000 "$ST/bin/meta-alert.sh"
chmod 555 "$ST/bin"
run_conv "$TRUSTED" "$ST"; RC=$?
chmod 755 "$ST/bin"
M13_TMP="$(ls "$ST/bin/"meta-alert.sh.tmp.* "$ST/bin/"meta-alert.sh.bak-shape-* 2>/dev/null | wc -l | tr -d ' ')"
M13_OK=1
[ "$RC" -ne 0 ] || { M13_OK=0; fail "M13: archive failure must be rc=1 (got $RC)"; }
[ -f "$ST/bin/meta-alert.sh" ] && [ ! -L "$ST/bin/meta-alert.sh" ] \
  || { M13_OK=0; fail "M13: the canonical copy was replaced despite the archive failing"; }
[ "$M13_TMP" = "0" ] || { M13_OK=0; fail "M13: residue left behind ($M13_TMP)"; }
if [ -f "$ST/bin/meta-alert.sh" ]; then
  chmod u+r "$ST/bin/meta-alert.sh" 2>/dev/null
  cmp -s "$ST/bin/meta-alert.sh" "$SB/m13-expected" || { M13_OK=0; fail "M13: original bytes were modified"; }
fi
expect_one 'meta-alert.sh' || { M13_OK=0; fail "M13: expected exactly one alert, got $(alerts_total)"; }
[ "$M13_OK" = "1" ] && pass "M13: strict archive failure → original bytes preserved, no residue, alert, rc=1"

# M14: the regular file in bin is itself a HARD LINK to the canonical source.
# The pathname never moves, so the identity re-check is satisfied end to end —
# yet archiving it just mints a third alias of the trusted repo file inside
# <state>/bin, where a later chmod/write would reach production source through
# the shared inode. There are no distinct bytes to preserve here, so the right
# outcome is: publish the canonical link, keep NO archive that shares the
# source's inode.
ST="$(new_state m14 "$TRUSTED")"; : > "$SB/alerts.log"
rm -f "$ST/bin/meta-alert.sh"
M14_OK=1
# The precondition is the whole case. `ln` across filesystems fails with EXDEV,
# and this suite has no errexit — converge would then just see an absent path,
# create the canonical link, and M14 would go green having never built the shape
# it exists to test. Assert the hard link really happened, on both platforms.
if ! ln "$(META_SRC "$TRUSTED")" "$ST/bin/meta-alert.sh" 2>/dev/null; then
  M14_OK=0; fail "M14: could not hard-link the fixture (cross-filesystem state dir?) — precondition not built"
fi
M14_SRC_ID="$(t_fsid "$(META_SRC "$TRUSTED")")"
if [ "$M14_OK" = "1" ]; then
  fsid_ok "$M14_SRC_ID" || { M14_OK=0; fail "M14: source identity unmeasurable"; }
  { [ -f "$ST/bin/meta-alert.sh" ] && [ ! -L "$ST/bin/meta-alert.sh" ]; } \
    || { M14_OK=0; fail "M14: precondition is not a plain regular file"; }
  [ "$(t_fsid "$ST/bin/meta-alert.sh")" = "$M14_SRC_ID" ] \
    || { M14_OK=0; fail "M14: precondition does not actually alias the source"; }
fi
if [ "$M14_OK" = "1" ]; then
  run_conv "$TRUSTED" "$ST"; RC=$?
  [ "$RC" -eq 0 ] || { M14_OK=0; fail "M14: rc=$RC"; }
  [ "$(readlink "$ST/bin/meta-alert.sh")" = "$(META_SRC "$TRUSTED")" ] \
    || { M14_OK=0; fail "M14: canonical link not published"; }
  for a in "$ST/bin/"meta-alert.sh.bak-shape-*; do
    [ -e "$a" ] || continue
    aid="$(t_fsid "$a")"
    fsid_ok "$aid" || { M14_OK=0; fail "M14: retained archive identity unmeasurable"; continue; }
    [ "$aid" = "$M14_SRC_ID" ] \
      && { M14_OK=0; fail "M14: retained an archive that aliases the repo source"; }
  done
fi
[ "$M14_OK" = "1" ] && pass "M14: hard-link-to-source copy → published, no repo-aliasing archive kept"

# M15/M16: the two safety transitions must be VERIFIED, not assumed. An unlink
# can fail (immutable flag, directory ACL, storage error); swallowing that with
# `|| true` reports clean while the dangerous artifact is still on disk — the
# exact failure mode this whole change exists to remove. The rm shim refuses
# only this process's bak-shape paths.
RM_SHIM="$SB/rmshim"; mkdir -p "$RM_SHIM"
{ echo '#!/bin/bash'; echo "REAL=\"$(command -v rm)\""
  cat <<'EOF'
for a in "$@"; do
  case "$a" in
    *meta-alert.sh.bak-shape-*)
      # SHIM_RM_DELETE_THEN_FAIL reproduces the nastier shape: the unlink
      # reports failure but the directory entry is gone anyway, so a later
      # lstat sees nothing. An implementation that only consults lstat reads
      # that as "removed" and reports clean.
      if [ -n "${SHIM_RM_DELETE_THEN_FAIL:-}" ]; then "$REAL" -f "$@" 2>/dev/null; fi
      exit 1
      ;;
  esac
done
exec "$REAL" "$@"
EOF
} > "$RM_SHIM/rm"; chmod +x "$RM_SHIM/rm"

ST="$(new_state m15 "$TRUSTED")"; : > "$SB/alerts.log"
rm -f "$ST/bin/meta-alert.sh"
M15_OK=1
M15_SRC_ID="$(t_fsid "$(META_SRC "$TRUSTED")")"
ln "$(META_SRC "$TRUSTED")" "$ST/bin/meta-alert.sh" 2>/dev/null \
  || { M15_OK=0; fail "M15: could not build the hard-link precondition"; }
if [ "$M15_OK" = "1" ]; then
  fsid_ok "$M15_SRC_ID" || { M15_OK=0; fail "M15: source identity unmeasurable"; }
  [ "$(t_fsid "$ST/bin/meta-alert.sh")" = "$M15_SRC_ID" ] \
    || { M15_OK=0; fail "M15: precondition does not actually alias the source"; }
fi
if [ "$M15_OK" = "1" ]; then
  run_conv "$TRUSTED" "$ST" PATH="$RM_SHIM:$PATH"; RC=$?
  [ "$RC" -ne 0 ] || { M15_OK=0; fail "M15: unprovable cleanup still exited 0"; }
  expect_one 'strict-discard-failed' \
    || { M15_OK=0; fail "M15: expected exactly one discard-failure alert, got $(alerts_total)"; }
  [ ! -L "$ST/bin/meta-alert.sh" ] \
    || { M15_OK=0; fail "M15: published despite unprovable cleanup"; }
  [ "$(t_fsid "$ST/bin/meta-alert.sh")" = "$M15_SRC_ID" ] \
    || { M15_OK=0; fail "M15: the canonical preimage was disturbed"; }
  [ "$(ls "$ST/bin/"meta-alert.sh.bak-shape-* 2>/dev/null | wc -l | tr -d ' ')" = "1" ] \
    || { M15_OK=0; fail "M15: expected exactly one retained residue to report"; }
fi
[ "$M15_OK" = "1" ] && pass "M15: unprovable archive cleanup → reported, nothing published, preimage intact, rc=1"

# M15b: the narrower fail-open. The unlink reports failure but the entry is gone
# anyway — the same directory/storage fault can block the unlink AND hide the
# path from the follow-up lstat. An implementation that only consults lstat
# concludes "removed" and reports clean. Removal was not PROVEN, so this is
# fail-closed on purpose, and the alert says "could not be proven" rather than
# claiming residue that may not exist.
ST="$(new_state m15b "$TRUSTED")"; : > "$SB/alerts.log"
rm -f "$ST/bin/meta-alert.sh"
M15B_OK=1
M15B_SRC_ID="$(t_fsid "$(META_SRC "$TRUSTED")")"
ln "$(META_SRC "$TRUSTED")" "$ST/bin/meta-alert.sh" 2>/dev/null \
  || { M15B_OK=0; fail "M15b: could not build the hard-link precondition"; }
if [ "$M15B_OK" = "1" ]; then
  fsid_ok "$M15B_SRC_ID" || { M15B_OK=0; fail "M15b: source identity unmeasurable"; }
  [ "$(t_fsid "$ST/bin/meta-alert.sh")" = "$M15B_SRC_ID" ] \
    || { M15B_OK=0; fail "M15b: precondition does not actually alias the source"; }
fi
if [ "$M15B_OK" = "1" ]; then
  run_conv "$TRUSTED" "$ST" PATH="$RM_SHIM:$PATH" SHIM_RM_DELETE_THEN_FAIL=1; RC=$?
  [ "$RC" -ne 0 ] || { M15B_OK=0; fail "M15b: rm reported failure yet converge exited 0"; }
  expect_one 'strict-discard-failed' \
    || { M15B_OK=0; fail "M15b: expected exactly one discard-failure alert, got $(alerts_total)"; }
  [ ! -L "$ST/bin/meta-alert.sh" ] || { M15B_OK=0; fail "M15b: published on an unproven cleanup"; }
  [ "$(t_fsid "$ST/bin/meta-alert.sh")" = "$M15B_SRC_ID" ] \
    || { M15B_OK=0; fail "M15b: the canonical preimage was disturbed"; }
  [ -z "$(ls "$ST/bin/"meta-alert.sh.bak-shape-* 2>/dev/null)" ] \
    || { M15B_OK=0; fail "M15b: the shim deleted the artifact, so nothing should remain"; }
fi
[ "$M15B_OK" = "1" ] && pass "M15b: rm fails but the entry is gone → still unproven, fail closed"

# M16a/M16b: identity unmeasurable → fail closed. Publishing here could replace a
# working regular file with a link to a source that has since vanished.
# The shim must let the PRE/POST reads of $link through: failing every identity
# read would trip the earlier unproven-preimage branch instead, and this case
# would never reach the source/archive check it exists to cover.
STAT_SHIM="$SB/statshim"; mkdir -p "$STAT_SHIM"
{ echo '#!/bin/bash'; echo "REAL=\"$(command -v stat)\""
  cat <<'EOF'
# Only device:inode reads are affected, and only for the operand named by
# SHIM_FAIL_ID_MATCH — mode reads and every other path stay real.
case "$*" in
  *'%d:%i'*)
    target=""
    for a in "$@"; do case "$a" in -*|'%d:%i') ;; *) target="$a" ;; esac; done
    case "$target" in ${SHIM_FAIL_ID_MATCH:-__none__}) exit 1 ;; esac
    ;;
esac
exec "$REAL" "$@"
EOF
} > "$STAT_SHIM/stat"; chmod +x "$STAT_SHIM/stat"

identity_case() {  # <state-name> <shim glob> → sets ID_FAILS
  local nm="$1" glob="$2"
  ST="$(new_state "$nm" "$TRUSTED")"; : > "$SB/alerts.log"
  printf 'deployed-copy-bytes-%s\n' "$nm" > "$SB/$nm-expected"
  cp "$SB/$nm-expected" "$ST/bin/meta-alert.sh"; chmod 0644 "$ST/bin/meta-alert.sh"
  local pre_id; pre_id="$(t_fsid "$ST/bin/meta-alert.sh")"
  run_conv "$TRUSTED" "$ST" PATH="$STAT_SHIM:$PATH" SHIM_FAIL_ID_MATCH="$glob"
  local rrc=$?
  ID_FAILS=""
  [ "$rrc" -ne 0 ] || ID_FAILS="$ID_FAILS exited-0"
  expect_one 'strict-identity-unmeasurable' \
    || ID_FAILS="$ID_FAILS wrong-alert($(alerts_total):$(grep -o 'strict-[a-z-]*' "$SB/alerts.log" | tr '\n' ',' ))"
  [ ! -L "$ST/bin/meta-alert.sh" ] || ID_FAILS="$ID_FAILS published"
  cmp -s "$ST/bin/meta-alert.sh" "$SB/$nm-expected" || ID_FAILS="$ID_FAILS preimage-changed"
  fsid_ok "$pre_id" || ID_FAILS="$ID_FAILS preimage-id-unmeasurable"
  [ "$(t_fsid "$ST/bin/meta-alert.sh")" = "$pre_id" ] || ID_FAILS="$ID_FAILS preimage-object-replaced"
  [ -z "$(ls "$ST/bin/"meta-alert.sh.bak-shape-* 2>/dev/null)" ] || ID_FAILS="$ID_FAILS archive-residue"
}

identity_case m16a '*/scripts/meta-alert.sh'
if [ -z "$ID_FAILS" ]; then
  pass "M16a: source identity unreadable → fail closed, nothing published, preimage intact"
else fail "M16a: source-identity branch —$ID_FAILS"; fi

identity_case m16b '*bak-shape*'
if [ -z "$ID_FAILS" ]; then
  pass "M16b: archive identity unreadable → fail closed, nothing published, preimage intact"
else fail "M16b: archive-identity branch —$ID_FAILS"; fi

# R1: two Leads starting at once both see the link absent. Both must succeed
# with the exact canonical target and leave no tmp behind. Alert COUNT is
# deliberately not asserted — user-visible dedup is lead-alert.sh's claims
# contract, a different layer.
ST="$(new_state r1 "$TRUSTED")"; : > "$SB/alerts.log"
run_conv "$TRUSTED" "$ST" & P1=$!
run_conv "$TRUSTED" "$ST" & P2=$!
wait $P1; RC1=$?
wait $P2; RC2=$?
R1_TMP="$(ls "$ST/bin/"meta-alert.sh.tmp.* 2>/dev/null | wc -l | tr -d ' ')"
if [ "$RC1" -eq 0 ] && [ "$RC2" -eq 0 ] \
   && [ "$(readlink "$ST/bin/meta-alert.sh")" = "$(META_SRC "$TRUSTED")" ] \
   && [ "$R1_TMP" = "0" ]; then
  pass "R1: concurrent absent-create → both succeed, exact canonical target, no tmp residue"
else fail "R1: concurrency (rc=$RC1/$RC2, tmp=$R1_TMP)"; fi

# R2: the SAME race, but on the regular-file (T6) path — the one R1 never
# reached. Both convergers enter Block A seeing a regular file; whoever loses
# gets there after the winner has already published the symlink. `[ -f "$link" ]`
# follows symlinks, so the loser tries to archive a SYMLINK, and BSD `ln` without
# -P would dereference it and hard-link the repo's own meta-alert.sh — an
# "archive" that lies about the displaced bytes AND shares an inode with trusted
# production source, so chmod'ing it would mutate the repo.
# Codex reproduced this on iteration 2 of 50; it is looped here for the same
# reason. Every retained archive must be non-symlink, byte-equal to the original
# deployment copy, and must NOT share the canonical source's inode.
# (R3/R4 below make the SAME contract deterministic and platform-independent;
# R2 stays as the realistic end-to-end shape with two real convergers.)
R2_FAILS=""
R2_SRC_INO="$(t_inode "$(META_SRC "$TRUSTED")")"
inode_ok "$R2_SRC_INO" || R2_FAILS="$R2_FAILS unmeasurable-src-inode"
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  ST="$(new_state "r2-$attempt" "$TRUSTED")"; : > "$SB/alerts.log"
  printf 'deployed-copy-bytes-r2-%s\n' "$attempt" > "$SB/r2-expected"
  cp "$SB/r2-expected" "$ST/bin/meta-alert.sh"; chmod 0644 "$ST/bin/meta-alert.sh"
  run_conv "$TRUSTED" "$ST" & Q1=$!
  run_conv "$TRUSTED" "$ST" & Q2=$!
  wait $Q1; QR1=$?
  wait $Q2; QR2=$?
  [ "$QR1" -eq 0 ] && [ "$QR2" -eq 0 ] || R2_FAILS="$R2_FAILS rc($attempt)=$QR1/$QR2"
  [ "$(readlink "$ST/bin/meta-alert.sh")" = "$(META_SRC "$TRUSTED")" ] \
    || R2_FAILS="$R2_FAILS target($attempt)"
  [ -z "$(ls "$ST/bin/"meta-alert.sh.tmp.* 2>/dev/null)" ] || R2_FAILS="$R2_FAILS tmp($attempt)"
  for a in "$ST/bin/"meta-alert.sh.bak-shape-*; do
    [ -e "$a" ] || continue
    [ -L "$a" ] && { R2_FAILS="$R2_FAILS symlink-archive($attempt)"; continue; }
    [ "$(t_inode "$a")" = "$R2_SRC_INO" ] && R2_FAILS="$R2_FAILS repo-inode-archive($attempt)"
    cmp -s "$a" "$SB/r2-expected" || R2_FAILS="$R2_FAILS archive-bytes($attempt)"
  done
done
if [ -z "$R2_FAILS" ]; then
  pass "R2: concurrent regular-file convergence never archives the repo source (15 attempts)"
else fail "R2: concurrent T6 archive race —$R2_FAILS"; fi

# ── R3/R4: the -P contract, deterministically, on ANY platform ───────────────
#
# R2 above is probabilistic AND platform-blind: GNU `ln`/`cp` already default to
# no-dereference, so on Linux CI (where this suite will run) deleting the
# explicit -P from production is completely invisible. The regression would then
# sit green until the macOS fleet reproduced the incident again.
#
# These two cases remove both weaknesses with a test-only shim that (a) emulates
# BSD's dereferencing default whenever -P is absent, and (b) acts as a barrier —
# it publishes the canonical symlink at the exact instant a rival converger
# would, i.e. after converge's shape check and before its archive syscall.
# No concurrency, no luck: one run, one deterministic interleaving.
SHIM="$SB/shim"; mkdir -p "$SHIM"
LN_REAL="$(command -v ln)"; CP_REAL="$(command -v cp)"
mk_shim() {  # <name> <real> — BSD-default emulation + publish barrier
  cat > "$SHIM/$1" <<EOF
#!/bin/bash
REAL="$2"
TOOL="$1"
LN_FOR_CONTAMINATE="$LN_REAL"
EOF
  cat >> "$SHIM/$1" <<'EOF'
symlink_op=0; physical=0
for a in "$@"; do
  case "$a" in
    -*P*) physical=1 ;;
  esac
  case "$a" in
    -*s*) symlink_op=1 ;;
  esac
done
# Barrier: fire once, on the archive syscall only, before it runs.
if [ "$symlink_op" = "0" ] && [ -n "${SHIM_PUBLISH_LINK:-}" ] && [ ! -e "${SHIM_FIRED:-/nonexistent}" ]; then
  case "$*" in
    *bak-shape*) "$REAL" -sfn "$SHIM_TARGET" "$SHIM_PUBLISH_LINK"; : > "$SHIM_FIRED" ;;
  esac
fi
# Force ONLY the hard-link leg to fail, so the cp fallback is actually exercised
# (R4). This must never apply to the cp shim: failing cp too would make R4 pass
# no matter what flags cp is given — the leg under test would never run.
if [ "$TOOL" = "ln" ] && [ "$symlink_op" = "0" ] && [ -n "${SHIM_FAIL_HARDLINK:-}" ]; then
  case "$*" in *bak-shape*) exit 1 ;; esac
fi
# R5: emulate the window INSIDE cp. `cp -P` is a command, not one atomic
# syscall — it can lstat a regular file and only then open the pathname, so a
# rival publishing in between yields a REGULAR archive full of repo-source
# bytes that -P cannot prevent and shape/inode cannot distinguish. Reproduce
# exactly that artifact: publish the canonical link, then write repo-source
# bytes into the archive and report success.
if [ "$TOOL" = "cp" ] && [ -n "${SHIM_CONTAMINATE:-}" ]; then
  case "$*" in
    *bak-shape*)
      dest=""; for a in "$@"; do case "$a" in -*) ;; *) dest="$a" ;; esac; done
      "$LN_FOR_CONTAMINATE" -sfn "$SHIM_TARGET" "$SHIM_PUBLISH_LINK"
      "$REAL" -p "$SHIM_TARGET" "$dest" && exit 0
      exit 1
      ;;
  esac
fi
[ "$symlink_op" = "1" ] && exec "$REAL" "$@"
[ "$physical" = "1" ] && exec "$REAL" "$@"
exec "$REAL" -L "$@"   # BSD default: dereference the source
EOF
  chmod +x "$SHIM/$1"
}
mk_shim ln "$LN_REAL"
mk_shim cp "$CP_REAL"

race_case() {  # <label> <state-name> <extra env...> → sets RACE_FAILS
  local label="$1" nm="$2"; shift 2
  ST="$(new_state "$nm" "$TRUSTED")"; : > "$SB/alerts.log"
  printf 'deployed-copy-bytes-%s\n' "$nm" > "$SB/$nm-expected"
  cp "$SB/$nm-expected" "$ST/bin/meta-alert.sh"; chmod 0644 "$ST/bin/meta-alert.sh"
  rm -f "$SB/$nm-fired"
  local src_ino; src_ino="$(t_inode "$(META_SRC "$TRUSTED")")"
  run_conv "$TRUSTED" "$ST" PATH="$SHIM:$PATH" \
    SHIM_PUBLISH_LINK="$ST/bin/meta-alert.sh" SHIM_TARGET="$(META_SRC "$TRUSTED")" \
    SHIM_FIRED="$SB/$nm-fired" "$@"
  local rrc=$?
  RACE_FAILS=""
  inode_ok "$src_ino" || RACE_FAILS="$RACE_FAILS unmeasurable-src-inode"
  [ -e "$SB/$nm-fired" ] || RACE_FAILS="$RACE_FAILS barrier-never-fired"
  [ "$rrc" -eq 0 ] || RACE_FAILS="$RACE_FAILS rc=$rrc"
  [ "$(readlink "$ST/bin/meta-alert.sh")" = "$(META_SRC "$TRUSTED")" ] \
    || RACE_FAILS="$RACE_FAILS target"
  [ -z "$(ls "$ST/bin/"meta-alert.sh.tmp.* 2>/dev/null)" ] || RACE_FAILS="$RACE_FAILS tmp-residue"
  local a
  for a in "$ST/bin/"meta-alert.sh.bak-shape-*; do
    [ -e "$a" ] || continue
    # The winner published before the archive syscall, so there was never a
    # deployment copy left to preserve: any retained archive is a lie.
    [ -L "$a" ] && { RACE_FAILS="$RACE_FAILS symlink-archive-kept"; continue; }
    [ "$(t_inode "$a")" = "$src_ino" ] && RACE_FAILS="$RACE_FAILS repo-inode-archive"
    cmp -s "$a" "$SB/$nm-expected" || RACE_FAILS="$RACE_FAILS false-archive"
  done
}

race_case "R3" r3
if [ -z "$RACE_FAILS" ]; then
  pass "R3: rival publishes before the hard-link archive → no false archive (deterministic, platform-independent)"
else fail "R3: hard-link leg dereferenced the winner's link —$RACE_FAILS"; fi

race_case "R4" r4 SHIM_FAIL_HARDLINK=1
if [ -z "$RACE_FAILS" ]; then
  pass "R4: same race on the cp fallback leg → no false archive"
else fail "R4: cp fallback dereferenced the winner's link —$RACE_FAILS"; fi

# R5: the residual window that -P alone cannot close, because `cp -P` is a
# command rather than a single atomic syscall. The shim produces exactly the
# artifact a mid-copy loss would produce — a regular archive holding
# repo-source bytes — which no shape or inode test on the ARCHIVE can tell from
# a legitimate one. Only re-checking the SOURCE's identity after the fact
# catches it, so this is the case that proves that check is load-bearing.
race_case "R5" r5 SHIM_FAIL_HARDLINK=1 SHIM_CONTAMINATE=1
if [ -z "$RACE_FAILS" ]; then
  pass "R5: rival publishes mid-copy → contaminated archive detected and discarded"
else fail "R5: mid-copy contamination survived —$RACE_FAILS"; fi

# R6 is a SOURCE-CONTRACT assertion, and deliberately so. Once the post-hoc
# source-identity re-check existed, deleting -P from either leg stopped changing
# observable behaviour — the backstop discards the bad artifact either way, so
# R3/R4 go green on a mutant. That makes -P defence in depth rather than the
# guarantee, and defence in depth that no test defends is defence that gets
# deleted in the next cleanup. Keeping it matters: without -P the hard-link leg
# briefly creates an extra hard link to the trusted repo source inside
# <state>/bin, and the copy leg reads a file it was told not to follow.
# The runtime guarantee itself is covered behaviourally by R5.
ARCHIVE_BLOCK="$(sed -n '/strict-shape-unsupported/,$p;/Block A/,/^    \[ -L "\$link" \] || continue/p' \
  "$REAL_REPO_ROOT/scripts/converge-flywheel-bin.sh" | grep -E '(ln|cp) .*"\$link" "\$archive"')"
R6_FAILS=""
echo "$ARCHIVE_BLOCK" | grep -q 'ln -P "\$link" "\$archive"' || R6_FAILS="$R6_FAILS hardlink-leg-not-P"
echo "$ARCHIVE_BLOCK" | grep -q 'cp -pP "\$link" "\$archive"' || R6_FAILS="$R6_FAILS copy-leg-not-P"
[ "$(echo "$ARCHIVE_BLOCK" | grep -c .)" -eq 2 ] || R6_FAILS="$R6_FAILS unexpected-archive-call-count"
if [ -z "$R6_FAILS" ]; then
  pass "R6 (source contract): both archive legs keep explicit no-dereference flags"
else fail "R6: archive legs lost their no-dereference flags —$R6_FAILS"; fi

echo ""; echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
