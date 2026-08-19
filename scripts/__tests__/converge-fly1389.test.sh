#!/bin/bash
# FLY-1389: converge-flywheel-bin.sh new sections —
#   G*  P1-b write-time guard (temp/worktree root + effective-global bin →
#       refuse, ZERO writes, ONE alert, rc=1; sandbox state untouched)
#   S*  P1-c symlink health (broken → repaired+alert / temp-target →
#       repaired+alert / healthy → silent / source missing → alert-only /
#       refused root → no repair)
#   H*  P1-d hygiene mount (scan failure ORs into converger rc)
#
# Fixture note: the TRUSTED fake repo lives under the REAL repo checkout
# (scripts/__tests__/.tmp-*) with a .git DIRECTORY — a mktemp fake repo is a
# temp root by the predicate under test and can never exercise the healthy /
# repair paths. The predicate stops the owning-root walk at the fixture's
# own .git entry, so this works both in a CI clone and in a worktree.
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; shift; [ $# -gt 0 ] && echo "        $*"; }

REAL_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RSB="$(mktemp -d "${TESTS_DIR}/.tmp-converge1389-XXXXXX")"
SB="$(mktemp -d /tmp/fly1389-converge-XXXXXX)"
trap 'rm -rf "$RSB" "$SB"' EXIT

make_fake_repo() {  # <dir> <gitshape: dir|file>
  local fr="$1" shape="$2"
  mkdir -p "$fr/scripts/lib" \
    "$fr/packages/agent-team-transport/dist/bin"
  cp "$REAL_REPO_ROOT/scripts/lib/script-sanity.sh" "$fr/scripts/lib/"
  cp "$REAL_REPO_ROOT/scripts/lib/path-hygiene.sh" "$fr/scripts/lib/"
  cp "$REAL_REPO_ROOT/scripts/lib/tmux-server-rescue.sh" "$fr/scripts/lib/" 2>/dev/null || \
    { echo '#!/bin/bash' > "$fr/scripts/lib/tmux-server-rescue.sh"; }
  cp "$REAL_REPO_ROOT/scripts/converge-flywheel-bin.sh" "$fr/scripts/"
  local f i
  for f in flywheel-lead-wrapper-v2.sh \
      flywheel-lead-attach.sh flywheel-bridge-wrapper.sh restart-services.sh \
      flywheel-cmux-sync.sh flywheel-cmux-autostart.sh lib/bounded-run.sh \
      lib/lead-address.sh meta-alert.sh lead-patrol-snapshot.sh; do
    { echo '#!/bin/bash'; i=1; while [ "$i" -le 80 ]; do echo "echo repo-$f-$i >/dev/null"; i=$((i+1)); done; } > "$fr/scripts/$f"
  done
  chmod 0755 "$fr/scripts/meta-alert.sh" "$fr/scripts/lead-patrol-snapshot.sh"
  # FLY-1577 widened FILES with the cmux watcher's launch-path dependencies;
  # the gate is Python, so the fixture keeps that shape too.
  { echo '#!/usr/bin/env python3'; echo 'import sys'
    i=1; while [ "$i" -le 80 ]; do echo "print('repo-gate-$i')"; i=$((i+1)); done
    echo 'sys.exit(0)'; } > "$fr/scripts/restart-storm-gate.py"
  # dist fixture must pass the symlink-repair source bar: FLY-954 sanity
  # (>=1024B + substantive lines) AND a shebang first line. Created via
  # redirect => mode 0644, so S1 also exercises the auto-chmod leg.
  { echo "#!/usr/bin/env node"; i=1; while [ "$i" -le 80 ]; do echo "console.log('cli-line-$i');"; i=$((i+1)); done; } \
    > "$fr/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js"
  if [ "$shape" = "dir" ]; then mkdir -p "$fr/.git"; else echo "gitdir: /main/.git/worktrees/x" > "$fr/.git"; fi
}

TRUSTED="$RSB/trusted-repo";  make_fake_repo "$TRUSTED" dir
WORKTREE="$RSB/wt-repo";      make_fake_repo "$WORKTREE" file

ALERT="$SB/alert.sh"
cat > "$ALERT" <<'EOF'
#!/bin/bash
echo "ALERT $*" >> "${ALERT_LOG:?}"
exit 0
EOF
chmod +x "$ALERT"

# FLY-1577: every case below targets the SYMLINK lane, so it has to start from
# a converged copy lane and a healthy meta-alert.sh link — otherwise the widened
# FILES and the strict meta-alert regime add repairs/alerts of their own and the
# "exactly one alert" / "alerts log empty" assertions here count noise they
# never meant to trigger.
seed_wrappers() {  # <state-dir> <repo> — pre-converge steady state (healthy)
  mkdir -p "$1/bin/lib"
  local f
  for f in flywheel-lead-wrapper-v2.sh \
           flywheel-lead-attach.sh flywheel-bridge-wrapper.sh restart-services.sh \
           restart-storm-gate.py lib/bounded-run.sh lib/lead-address.sh; do
    cp "$2/scripts/$f" "$1/bin/$f"
  done
  ln -sfn "$2/scripts/meta-alert.sh" "$1/bin/meta-alert.sh"
  ln -sfn "$2/scripts/lead-patrol-snapshot.sh" "$1/bin/flywheel-patrol-snapshot"
}

run_conv() {  # <repo> <state-dir> [extra env pairs...] → rc; out in $SB/out.log
  local repo="$1" st="$2"; shift 2
  ALERT_LOG="$SB/alerts.log" FLYWHEEL_STATE_DIR="$st" \
  FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
  env ALERT_LOG="$SB/alerts.log" FLYWHEEL_STATE_DIR="$st" \
    FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" "$@" \
    bash "$repo/scripts/converge-flywheel-bin.sh" >"$SB/out.log" 2>&1
}

# ── G1: guard — worktree repo + effective-global bin → refuse, rc=1, ZERO
# writes, exactly one alert ──
GH="$SB/guardhome"; mkdir -p "$GH/.flywheel"
: > "$SB/alerts.log"
if env ALERT_LOG="$SB/alerts.log" HOME="$GH" FLYWHEEL_STATE_DIR="$GH/.flywheel" \
    FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
    bash "$WORKTREE/scripts/converge-flywheel-bin.sh" >"$SB/out.log" 2>&1; then
  fail "G1: guard must exit non-zero" "$(cat "$SB/out.log")"
else
  G1_OK=1
  [[ ! -e "$GH/.flywheel/bin" ]] || { G1_OK=0; fail "G1: refused run CREATED the bin dir"; }
  [[ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 1 ]] || { G1_OK=0; fail "G1: expected exactly one alert"; }
  grep -q "FLY-1389" "$SB/out.log" || { G1_OK=0; fail "G1: refusal must cite FLY-1389"; }
  [[ "$G1_OK" == "1" ]] && pass "G1: worktree→global converge refused (rc=1, zero writes, one alert)"
fi

# ── G2: temp (/var/folders|/tmp canonical) repo root → same refusal ──
TMPREPO="$SB/tmp-repo"; make_fake_repo "$TMPREPO" dir   # .git dir but temp path
GH2="$SB/guardhome2"; mkdir -p "$GH2/.flywheel"
: > "$SB/alerts.log"
if env ALERT_LOG="$SB/alerts.log" HOME="$GH2" FLYWHEEL_STATE_DIR="$GH2/.flywheel" \
    FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
    bash "$TMPREPO/scripts/converge-flywheel-bin.sh" >"$SB/out.log" 2>&1; then
  fail "G2: temp-root converge against global must be refused"
else
  pass "G2: temp-canonical repo root → refused (TMPDIR-shape checkout can never converge global)"
fi

# ── G3: trusted repo + effective-global bin → converges normally ──
GH3="$SB/guardhome3"; mkdir -p "$GH3/.flywheel"
: > "$SB/alerts.log"
if env ALERT_LOG="$SB/alerts.log" HOME="$GH3" FLYWHEEL_STATE_DIR="$GH3/.flywheel" \
    FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
    bash "$TRUSTED/scripts/converge-flywheel-bin.sh" >"$SB/out.log" 2>&1 \
   && cmp -s "$GH3/.flywheel/bin/flywheel-lead-wrapper-v2.sh" "$TRUSTED/scripts/flywheel-lead-wrapper-v2.sh" \
   && [[ "$(readlink "$GH3/.flywheel/bin/flywheel-patrol-snapshot")" == "$TRUSTED/scripts/lead-patrol-snapshot.sh" ]] \
   && grep -q 'managed executable.*flywheel-patrol-snapshot' "$SB/alerts.log" \
   && grep -q "flywheel-patrol-snapshot created to this checkout's .*lead-patrol-snapshot.sh" "$SB/alerts.log" \
   && ! grep -q 'alert-chain.*flywheel-patrol-snapshot' "$SB/alerts.log"; then
  pass "G3: trusted (.git dir) repo converges the effective-global bin normally"
else
  fail "G3: trusted root wrongly refused" "$(cat "$SB/out.log")"
fi

# ── G3b: generic strict failures never blame the cmux watcher. ──
G3B_BACKUP="$SB/lead-patrol-snapshot.sh.backup"
cp "$TRUSTED/scripts/lead-patrol-snapshot.sh" "$G3B_BACKUP"
printf 'not-a-sane-script\n' > "$TRUSTED/scripts/lead-patrol-snapshot.sh"
: > "$SB/alerts.log"
if env ALERT_LOG="$SB/alerts.log" HOME="$GH3" FLYWHEEL_STATE_DIR="$GH3/.flywheel" \
    FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
    bash "$TRUSTED/scripts/converge-flywheel-bin.sh" >"$SB/out.log" 2>&1; then
  fail "G3b: an unready patrol source must fail convergence"
elif grep -q 'managed executable' "$SB/alerts.log" \
  && ! grep -q 'cmux watcher' "$SB/alerts.log"; then
  pass "G3b: patrol strict-source failure uses generic managed-executable wording"
else
  fail "G3b: patrol strict-source alert leaked cmux wording" "$(cat "$SB/alerts.log")"
fi
mv "$G3B_BACKUP" "$TRUSTED/scripts/lead-patrol-snapshot.sh"

# ── S1: broken symlink → repaired to this repo's source + ONE alert, rc=0 ──
ST="$SB/state-s1"; seed_wrappers "$ST" "$TRUSTED"
ln -s "$SB/gone/agent-team-transport-cli.js" "$ST/bin/agent-team-transport"
: > "$SB/alerts.log"
if run_conv "$TRUSTED" "$ST" \
   && [[ "$(readlink "$ST/bin/agent-team-transport")" == "$TRUSTED/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js" ]] \
   && grep -q 'symlink repaired' "$SB/alerts.log"; then
  pass "S1: broken agent-team-transport link → atomically re-pointed + alert (the incident shape, now LOUD)"
else
  fail "S1: broken-link repair" "rc=$? $(cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null | tail -4)"
fi

# ── S2: link target inside a worktree checkout → repaired + alert ──
ST="$SB/state-s2"; seed_wrappers "$ST" "$TRUSTED"
ln -s "$WORKTREE/scripts/lib/tmux-server-rescue.sh" "$ST/bin/tmux-server-rescue"
: > "$SB/alerts.log"
if run_conv "$TRUSTED" "$ST" \
   && [[ "$(readlink "$ST/bin/tmux-server-rescue")" == "$TRUSTED/scripts/lib/tmux-server-rescue.sh" ]] \
   && grep -q 'symlink repaired' "$SB/alerts.log"; then
  pass "S2: worktree-target link → re-pointed to trusted checkout + alert"
else
  fail "S2: worktree-target repair" "$(cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null | tail -4)"
fi

# ── S3: healthy links → silent (no alert) ──
ST="$SB/state-s3"; seed_wrappers "$ST" "$TRUSTED"
ln -s "$TRUSTED/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js" "$ST/bin/agent-team-transport"
ln -s "$TRUSTED/scripts/flywheel-cmux-sync.sh" "$ST/bin/flywheel-cmux-sync"
: > "$SB/alerts.log"
if run_conv "$TRUSTED" "$ST" && [[ ! -s "$SB/alerts.log" ]]; then
  pass "S3: healthy links → silent no-op"
else
  fail "S3: healthy links produced noise" "$(cat "$SB/alerts.log")"
fi

# ── S4: broken link but THIS checkout lacks the source → alert only, no
# repair, rc stays 0 ──
ST="$SB/state-s4"; seed_wrappers "$ST" "$TRUSTED"
rm -f "$TRUSTED/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js"
ln -s "$SB/gone/cli.js" "$ST/bin/agent-team-transport"
: > "$SB/alerts.log"
if run_conv "$TRUSTED" "$ST" \
   && [[ "$(readlink "$ST/bin/agent-team-transport")" == "$SB/gone/cli.js" ]] \
   && grep -q 'no sane local source' "$SB/alerts.log"; then
  pass "S4: source missing in checkout → alert-only, link untouched"
else
  fail "S4: no-source path" "$(cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null | tail -4)"
fi
echo "console.log('cli')" > "$TRUSTED/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js"

# ── S5: refused root (worktree repo, sandbox state) → NO repair attempted ──
ST="$SB/state-s5"; seed_wrappers "$ST" "$WORKTREE"
ln -s "$SB/gone/cli.js" "$ST/bin/agent-team-transport"
: > "$SB/alerts.log"
run_conv "$WORKTREE" "$ST" || true
if [[ "$(readlink "$ST/bin/agent-team-transport")" == "$SB/gone/cli.js" ]] \
   && grep -q 'symlink health: skipped' "$SB/out.log" \
   && ! grep -q 'symlink repaired' "$SB/alerts.log"; then
  pass "S5: temp/worktree root never repairs (no trusted source there)"
else
  fail "S5: refused-root repair leak" "$(cat "$SB/out.log" | tail -4)"
fi

# ── S6 (Codex R1 HIGH-2): broken link + INSANE local source → alert-only,
# NOT repaired (a degenerate stub must never be linked in and blessed) ──
ST="$SB/state-s6"; seed_wrappers "$ST" "$TRUSTED"
printf '#!/bin/bash\n' > "$TRUSTED/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js"  # stub: fails sanity
ln -s "$SB/gone/cli.js" "$ST/bin/agent-team-transport"
: > "$SB/alerts.log"
if run_conv "$TRUSTED" "$ST" \
   && [[ "$(readlink "$ST/bin/agent-team-transport")" == "$SB/gone/cli.js" ]] \
   && grep -q 'no sane local source' "$SB/alerts.log" \
   && ! grep -q 'symlink repaired' "$SB/alerts.log"; then
  pass "S6: insane repair source → alert-only, link untouched (never bless a stub)"
else
  fail "S6: insane-source guard" "$(cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null | tail -4)"
fi
{ echo "#!/usr/bin/env node"; i=1; while [ "$i" -le 80 ]; do echo "console.log('cli-line-$i');"; i=$((i+1)); done; } \
  > "$TRUSTED/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js"

# ── S6b (Codex R2 HIGH): big enough but NO shebang → alert-only, not linked
# (a shebang-less target dies with Exec format error at invocation) ──
ST="$SB/state-s6b"; seed_wrappers "$ST" "$TRUSTED"
{ echo "// no shebang"; i=1; while [ "$i" -le 80 ]; do echo "console.log('x-$i');"; i=$((i+1)); done; } \
  > "$TRUSTED/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js"
ln -s "$SB/gone/cli.js" "$ST/bin/agent-team-transport"
: > "$SB/alerts.log"
if run_conv "$TRUSTED" "$ST" \
   && [[ "$(readlink "$ST/bin/agent-team-transport")" == "$SB/gone/cli.js" ]] \
   && grep -q 'no sane local source' "$SB/alerts.log"; then
  pass "S6b: shebang-less source → alert-only, never linked"
else
  fail "S6b: shebang gate" "$(cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null | tail -4)"
fi
{ echo "#!/usr/bin/env node"; i=1; while [ "$i" -le 80 ]; do echo "console.log('cli-line-$i');"; i=$((i+1)); done; } \
  > "$TRUSTED/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js"

# ── S6c (Codex R2 HIGH): sane + shebang but mode 0644 → auto-chmod 0755 and
# repaired (mirrors syncFlywheelCliBin, FLY-142 R5: tsc emits 0644) ──
ST="$SB/state-s6c"; seed_wrappers "$ST" "$TRUSTED"
chmod 0644 "$TRUSTED/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js"
ln -s "$SB/gone/cli.js" "$ST/bin/agent-team-transport"
: > "$SB/alerts.log"
if run_conv "$TRUSTED" "$ST" \
   && [[ "$(readlink "$ST/bin/agent-team-transport")" == "$TRUSTED/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js" ]] \
   && [[ -x "$TRUSTED/packages/agent-team-transport/dist/bin/agent-team-transport-cli.js" ]] \
   && grep -q 'symlink repaired' "$SB/alerts.log"; then
  pass "S6c: 0644 source auto-chmod 0755 + repaired (final target executable)"
else
  fail "S6c: auto-chmod leg" "$(cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null | tail -4)"
fi

# ── S7 (Codex R1 HIGH-1): the ALLOW_TEMP_ROOT escape must NEVER enable
# symlink repair from a temp/worktree root — it opens the content-converge
# write guard only ──
ST="$SB/state-s7"; seed_wrappers "$ST" "$WORKTREE"
ln -s "$SB/gone/cli.js" "$ST/bin/agent-team-transport"
: > "$SB/alerts.log"
run_conv "$WORKTREE" "$ST" FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT=1 || true
if [[ "$(readlink "$ST/bin/agent-team-transport")" == "$SB/gone/cli.js" ]] \
   && grep -q 'symlink health: skipped' "$SB/out.log" \
   && ! grep -q 'symlink repaired' "$SB/alerts.log"; then
  pass "S7: escape env on a worktree root still never repairs symlinks"
else
  fail "S7: escape leaked into symlink repair" "$(cat "$SB/out.log" | tail -4)"
fi

# ── C1 (FLY-1446): a regular-file cmux deployment copy is itself drift.
# Archive it first, then atomically restore the installer's symlink shape. ──
ST="$SB/state-c1"; seed_wrappers "$ST" "$TRUSTED"
cp "$TRUSTED/scripts/flywheel-cmux-sync.sh" "$ST/bin/flywheel-cmux-sync"
cp "$TRUSTED/scripts/flywheel-cmux-autostart.sh" "$ST/bin/flywheel-cmux-autostart"
: > "$SB/alerts.log"
if run_conv "$TRUSTED" "$ST" \
   && [[ -L "$ST/bin/flywheel-cmux-sync" ]] \
   && [[ "$(readlink "$ST/bin/flywheel-cmux-sync")" == "$TRUSTED/scripts/flywheel-cmux-sync.sh" ]] \
   && [[ -L "$ST/bin/flywheel-cmux-autostart" ]] \
   && [[ "$(readlink "$ST/bin/flywheel-cmux-autostart")" == "$TRUSTED/scripts/flywheel-cmux-autostart.sh" ]] \
   && [[ "$(find "$ST/bin" -maxdepth 1 -type f -name 'flywheel-cmux-sync.bak-shape-*' | wc -l | tr -d ' ')" -eq 1 ]] \
   && [[ "$(find "$ST/bin" -maxdepth 1 -type f -name 'flywheel-cmux-autostart.bak-shape-*' | wc -l | tr -d ' ')" -eq 1 ]] \
   && cmp -s "$(find "$ST/bin" -maxdepth 1 -type f -name 'flywheel-cmux-sync.bak-shape-*' | head -1)" "$TRUSTED/scripts/flywheel-cmux-sync.sh" \
   && cmp -s "$(find "$ST/bin" -maxdepth 1 -type f -name 'flywheel-cmux-autostart.bak-shape-*' | head -1)" "$TRUSTED/scripts/flywheel-cmux-autostart.sh" \
   && grep -q 'copy-shape-converged' "$SB/alerts.log"; then
  pass "C1: both cmux script copies → archived + atomically converged to trusted symlinks + alerts"
else
  fail "C1: regular-file cmux shape convergence" "$(cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null | tail -8)"
fi

# ── C2: archive failure is fail-closed. The canonical executable remains
# byte-identical and no temp symlink is published. ──
ST="$SB/state-c2"; seed_wrappers "$ST" "$TRUSTED"
cp "$TRUSTED/scripts/flywheel-cmux-autostart.sh" "$ST/bin/flywheel-cmux-autostart"
C2_BEFORE="$(shasum -a 256 "$ST/bin/flywheel-cmux-autostart" | awk '{print $1}')"
chmod 0555 "$ST/bin"
: > "$SB/alerts.log"
if run_conv "$TRUSTED" "$ST"; then
  chmod 0755 "$ST/bin"
  fail "C2: archive failure must leave converge non-zero"
else
  chmod 0755 "$ST/bin"
  C2_AFTER="$(shasum -a 256 "$ST/bin/flywheel-cmux-autostart" | awk '{print $1}')"
  if [[ ! -L "$ST/bin/flywheel-cmux-autostart" ]] \
     && [[ "$C2_BEFORE" == "$C2_AFTER" ]] \
     && [[ "$(find "$ST/bin" -maxdepth 1 -name 'flywheel-cmux-autostart.tmp.*' | wc -l | tr -d ' ')" -eq 0 ]] \
     && grep -q 'shape archive FAILED' "$SB/alerts.log"; then
    pass "C2: archive failure → canonical copy untouched, no temp publish, alert + rc=1"
  else
    fail "C2: archive-first fail-closed invariant" "$(cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null | tail -8)"
  fi
fi

# ── C3: concurrent mounts converge idempotently. Per-process archive names
# may both exist, but the canonical path must end at the trusted symlink. ──
ST="$SB/state-c3"; seed_wrappers "$ST" "$TRUSTED"
cp "$TRUSTED/scripts/flywheel-cmux-sync.sh" "$ST/bin/flywheel-cmux-sync"
: > "$SB/alerts.log"
env ALERT_LOG="$SB/alerts.log" FLYWHEEL_STATE_DIR="$ST" \
  FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
  bash "$TRUSTED/scripts/converge-flywheel-bin.sh" >"$SB/c3-1.log" 2>&1 &
C3_P1=$!
env ALERT_LOG="$SB/alerts.log" FLYWHEEL_STATE_DIR="$ST" \
  FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
  bash "$TRUSTED/scripts/converge-flywheel-bin.sh" >"$SB/c3-2.log" 2>&1 &
C3_P2=$!
wait "$C3_P1"; C3_R1=$?
wait "$C3_P2"; C3_R2=$?
if [[ "$C3_R1" -eq 0 && "$C3_R2" -eq 0 ]] \
   && [[ -L "$ST/bin/flywheel-cmux-sync" ]] \
   && [[ "$(readlink "$ST/bin/flywheel-cmux-sync")" == "$TRUSTED/scripts/flywheel-cmux-sync.sh" ]] \
   && [[ "$(find "$ST/bin" -maxdepth 1 -type f -name 'flywheel-cmux-sync.bak-shape-*' | wc -l | tr -d ' ')" -ge 1 ]]; then
  pass "C3: concurrent converge mounts → both succeed, one trusted canonical symlink"
else
  fail "C3: concurrent shape convergence" "rc=$C3_R1/$C3_R2 $(tail -6 "$SB/c3-1.log" "$SB/c3-2.log")"
fi

# ── C4: an insane trusted-checkout source cannot replace a deployed copy. ──
ST="$SB/state-c4"; seed_wrappers "$ST" "$TRUSTED"
cp "$TRUSTED/scripts/flywheel-cmux-sync.sh" "$ST/bin/flywheel-cmux-sync"
printf '#!/bin/bash\n' > "$TRUSTED/scripts/flywheel-cmux-sync.sh"
: > "$SB/alerts.log"
if run_conv "$TRUSTED" "$ST"; then
  fail "C4: insane source must fail convergence"
elif [[ ! -L "$ST/bin/flywheel-cmux-sync" ]] \
   && grep -q 'no sane executable source' "$SB/alerts.log"; then
  pass "C4: insane source → copy preserved, alert-only, rc=1"
else
  fail "C4: insane source guard" "$(cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null | tail -8)"
fi
{ echo '#!/bin/bash'; i=1; while [ "$i" -le 80 ]; do echo "echo repo-flywheel-cmux-sync.sh-$i >/dev/null"; i=$((i+1)); done; } \
  > "$TRUSTED/scripts/flywheel-cmux-sync.sh"

# ── C5: emergency bypass preserves the legacy regular-file shape silently. ──
ST="$SB/state-c5"; seed_wrappers "$ST" "$TRUSTED"
cp "$TRUSTED/scripts/flywheel-cmux-sync.sh" "$ST/bin/flywheel-cmux-sync"
: > "$SB/alerts.log"
if run_conv "$TRUSTED" "$ST" FLYWHEEL_CONVERGE_CMUX_SYMLINK=0 \
   && [[ ! -L "$ST/bin/flywheel-cmux-sync" ]] \
   && [[ ! -s "$SB/alerts.log" ]]; then
  pass "C5: FLYWHEEL_CONVERGE_CMUX_SYMLINK=0 → byte-compatible copy-shape bypass"
else
  fail "C5: copy-shape escape hatch" "$(cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null | tail -8)"
fi

# ── C5b: malformed input is fail-safe default-on, never an implicit bypass. ──
ST="$SB/state-c5b"; seed_wrappers "$ST" "$TRUSTED"
cp "$TRUSTED/scripts/flywheel-cmux-sync.sh" "$ST/bin/flywheel-cmux-sync"
: > "$SB/alerts.log"
if run_conv "$TRUSTED" "$ST" FLYWHEEL_CONVERGE_CMUX_SYMLINK=banana \
   && [[ -L "$ST/bin/flywheel-cmux-sync" ]] \
   && grep -q 'invalid FLYWHEEL_CONVERGE_CMUX_SYMLINK' "$SB/out.log"; then
  pass "C5b: invalid shape flag → warning + fail-safe default-on convergence"
else
  fail "C5b: invalid flag fallback" "$(cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null | tail -8)"
fi

# ── C6: even with a sandbox state root, a worktree source is never trusted
# to replace a regular-file cmux deployment. ──
ST="$SB/state-c6"; seed_wrappers "$ST" "$WORKTREE"
cp "$WORKTREE/scripts/flywheel-cmux-sync.sh" "$ST/bin/flywheel-cmux-sync"
: > "$SB/alerts.log"
run_conv "$WORKTREE" "$ST" || true
if [[ ! -L "$ST/bin/flywheel-cmux-sync" ]] \
   && grep -q 'symlink health: skipped' "$SB/out.log" \
   && ! grep -q 'copy-shape-converged' "$SB/alerts.log"; then
  pass "C6: worktree root never converts a cmux copy into a global-style link"
else
  fail "C6: worktree copy-shape repair leak" "$(cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null | tail -8)"
fi

# ── H1: hygiene mount — scan failure ORs into converger rc ──
# Copy the REAL scanner into the trusted fake repo; point HOME at a fixture
# home with one broken global-bin symlink. Sandbox state → print-only path.
cp "$REAL_REPO_ROOT/scripts/check-global-path-hygiene.sh" "$TRUSTED/scripts/"
HH="$SB/hygienehome"; mkdir -p "$HH/.flywheel/bin"
ln -s "$SB/gone/x" "$HH/.flywheel/bin/broken-link"
ST="$SB/state-h1"; seed_wrappers "$ST" "$TRUSTED"
: > "$SB/alerts.log"
if env ALERT_LOG="$SB/alerts.log" HOME="$HH" FLYWHEEL_STATE_DIR="$ST" \
    FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
    bash "$TRUSTED/scripts/converge-flywheel-bin.sh" >"$SB/out.log" 2>&1; then
  fail "H1: hygiene violations must OR into converger rc" "$(cat "$SB/out.log" | tail -5)"
else
  grep -q 'path-hygiene' "$SB/out.log" \
    && pass "H1: hygiene scan failure → converger rc=1 (stderr carries the list)" \
    || fail "H1: rc=1 but no hygiene output" "$(cat "$SB/out.log" | tail -5)"
fi
rm -f "$TRUSTED/scripts/check-global-path-hygiene.sh"

# ── H2: clean HOME → hygiene mount adds nothing, rc=0 ──
cp "$REAL_REPO_ROOT/scripts/check-global-path-hygiene.sh" "$TRUSTED/scripts/"
HH2="$SB/hygienehome2"; mkdir -p "$HH2/.flywheel/bin"
ST="$SB/state-h2"; seed_wrappers "$ST" "$TRUSTED"
if env ALERT_LOG="$SB/alerts.log" HOME="$HH2" FLYWHEEL_STATE_DIR="$ST" \
    FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
    bash "$TRUSTED/scripts/converge-flywheel-bin.sh" >"$SB/out.log" 2>&1; then
  pass "H2: clean HOME → hygiene mount passes, converger rc=0"
else
  fail "H2: clean hygiene should not fail converge" "$(cat "$SB/out.log" | tail -5)"
fi

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]] || exit 1
