#!/bin/bash
# FLY-1062: packaged-mode seams — every runtime branch keyed on the packaged
# tree shape gets BOTH sides tested:
#   packaged judgment holds  → the new path runs;
#   judgment absent          → reverse-compat sentinel (verbatim monorepo
#                              behavior — the Annie-production byte-compat
#                              red line).
#
# Seams under test (packaged-path audit table = the closure authority):
#   S1/S2   flywheel-bridge-wrapper.sh — exec node dist/run-bridge.js vs npx tsx
#   S3/S4   daily-standup.sh           — Bridge self-start launcher branch
#   S5/S6   update-flywheel.sh         — prebuilt refusal vs monorepo updater
#   S7/S8   converge-flywheel-bin.sh   — prebuilt FILES set drops
#           restart-services.sh (a packaged tree never ships it; without the
#           branch every Lead start fires a repo-source-missing alert)
#   S9/S10  linux-preflight.sh --check — prebuilt drops the pnpm requirement
#           (customer machines build nothing; without the branch packaged
#           linux setup hard-fails on a dep the payload never needs)
#   S11/S12 lib/supervisor.sh          — darwin REAL install behind the
#           FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1 opt-in vs FLY-650 no-op
#
# Hermetic: fixture trees + fixture HOMEs + stub node/npx/git/curl/systemctl/
# launchctl on PATH. No network, no real services, no real state dirs.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d -t fly1062-seams-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
REAL_USER_HOME="$HOME"

# ── fixture tree builder ─────────────────────────────────────────────────────
# mk_tree <dir> [prebuilt] — a minimal tree carrying the REAL scripts under
# test (copied, so their self-derived SCRIPT_DIR/.. lands in the fixture).
mk_tree() {
  local dir="$1" prebuilt="${2:-}"
  mkdir -p "$dir/scripts/lib"
  for f in flywheel-bridge-wrapper.sh flywheel-lead-wrapper.sh daily-standup.sh \
           update-flywheel.sh converge-flywheel-bin.sh linux-preflight.sh; do
    cp -p "$REPO_ROOT/scripts/$f" "$dir/scripts/$f"
  done
  for f in lib/script-sanity.sh lib/host-config.sh lib/self-ship-queue.sh \
           lib/supervisor.sh; do
    cp -p "$REPO_ROOT/scripts/$f" "$dir/scripts/$f"
  done
  [ "$prebuilt" = "prebuilt" ] && echo "1.0.0-test" > "$dir/.flywheel-prebuilt"
  return 0
}

# mk_home <dir> — fixture HOME with an empty state env + first-in-PATH stub bin
# (the bridge wrapper prepends $HOME/.local/bin ahead of /opt/homebrew/bin, so
# stubs placed there win over any real toolchain).
mk_home() {
  local h="$1"
  [ "$h" = "$REAL_USER_HOME" ] && { echo "FATAL: fixture HOME is the real HOME" >&2; exit 1; }
  mkdir -p "$h/.flywheel/pids" "$h/.flywheel/state" "$h/.local/bin"
  : > "$h/.flywheel/.env"
}

# stub <home> <name> <body...> — install a recording stub into the fixture
# HOME's .local/bin. Every stub appends "<name> <argv>" to $h/calls.log.
stub() {
  local h="$1" name="$2"; shift 2
  {
    echo '#!/bin/bash'
    echo "echo \"$name \$*\" >> \"$h/calls.log\""
    printf '%s\n' "$@"
  } > "$h/.local/bin/$name"
  chmod +x "$h/.local/bin/$name"
}

calls() { cat "$1/calls.log" 2>/dev/null || true; }

# ─────────────────────────────────────────────────────────────────────────────
# S1/S2 · flywheel-bridge-wrapper.sh exec branch
# The wrapper is run WITHOUT lib/bridge-port.sh in the tree (degraded preflight
# path — deterministic; port preflight has its own suite) and with stub
# node/npx as the exec targets.
# ─────────────────────────────────────────────────────────────────────────────
run_bridge_wrapper() { # <tree> <home>
  local tree="$1" h="$2"
  rm -f "$tree/scripts/lib/bridge-port.sh"
  env -i HOME="$h" PATH="/usr/bin:/bin" FLYWHEEL_DIR="$tree" \
    FLYWHEEL_STATE_DIR="$h/.flywheel" \
    bash "$tree/scripts/flywheel-bridge-wrapper.sh" >"$h/out.log" 2>&1
}

T="$SANDBOX/s1-tree"; H="$SANDBOX/s1-home"
mk_tree "$T"; mk_home "$H"
stub "$H" node 'exit 0'; stub "$H" npx 'exit 0'
mkdir -p "$T/dist"; echo "// compiled" > "$T/dist/run-bridge.js"
run_bridge_wrapper "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "^node dist/run-bridge.js$" <(calls "$H") \
   && ! grep -q "^npx " <(calls "$H"); then
  pass "S1 bridge-wrapper packaged: exec node dist/run-bridge.js (npx untouched)"
else
  fail "S1 rc=$rc calls=[$(calls "$H")] out=[$(cat "$H/out.log")]"
fi

T="$SANDBOX/s2-tree"; H="$SANDBOX/s2-home"
mk_tree "$T"; mk_home "$H"
stub "$H" node 'exit 0'; stub "$H" npx 'exit 0'
run_bridge_wrapper "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "^npx tsx scripts/run-bridge.ts$" <(calls "$H") \
   && ! grep -q "^node " <(calls "$H"); then
  pass "S2 bridge-wrapper monorepo sentinel: exec npx tsx verbatim (node untouched)"
else
  fail "S2 rc=$rc calls=[$(calls "$H")] out=[$(cat "$H/out.log")]"
fi

# ─────────────────────────────────────────────────────────────────────────────
# S3/S4 · daily-standup.sh Bridge self-start launcher branch
# curl stub: /health fails until the launcher stub drops a marker; every other
# call (the standup trigger POST) succeeds. The launcher stubs stay alive
# briefly so the script's kill -0 liveness probe passes.
# ─────────────────────────────────────────────────────────────────────────────
run_standup() { # <tree> <home>
  local tree="$1" h="$2"
  env -i HOME="$h" PATH="$h/.local/bin:/usr/bin:/bin" \
    STANDUP_MARKER="$h/bridge-up" \
    bash "$tree/scripts/daily-standup.sh" >"$h/out.log" 2>&1
}
mk_standup_stubs() { # <home>
  local h="$1"
  stub "$h" curl \
    'for a in "$@"; do case "$a" in */health)' \
    '  [ -f "${STANDUP_MARKER:?}" ] && exit 0 || exit 22 ;;' \
    'esac; done' \
    'echo "{}"; exit 0'
  stub "$h" node 'touch "${STANDUP_MARKER:?}"; sleep 3'
  stub "$h" npx  'touch "${STANDUP_MARKER:?}"; sleep 3'
}

T="$SANDBOX/s3-tree"; H="$SANDBOX/s3-home"
mk_tree "$T"; mk_home "$H"; mk_standup_stubs "$H"
mkdir -p "$T/dist" "$T/packages/teamlead/dist/bridge"
echo "// compiled" > "$T/dist/run-bridge.js"
echo "// plugin"   > "$T/packages/teamlead/dist/bridge/plugin.js"
run_standup "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "^node $T/dist/run-bridge.js$" <(calls "$H") \
   && ! grep -q "^npx " <(calls "$H"); then
  pass "S3 daily-standup packaged: self-start via node dist/run-bridge.js"
else
  fail "S3 rc=$rc calls=[$(calls "$H")] out=[$(cat "$H/out.log")]"
fi

T="$SANDBOX/s4-tree"; H="$SANDBOX/s4-home"
mk_tree "$T"; mk_home "$H"; mk_standup_stubs "$H"
mkdir -p "$T/packages/teamlead/dist/bridge"
echo "// plugin" > "$T/packages/teamlead/dist/bridge/plugin.js"
run_standup "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "^npx tsx $T/scripts/run-bridge.ts$" <(calls "$H") \
   && ! grep -q "^node " <(calls "$H"); then
  pass "S4 daily-standup monorepo sentinel: self-start via npx tsx verbatim"
else
  fail "S4 rc=$rc calls=[$(calls "$H")] out=[$(cat "$H/out.log")]"
fi

# ─────────────────────────────────────────────────────────────────────────────
# S5/S6 · update-flywheel.sh prebuilt refusal
# ─────────────────────────────────────────────────────────────────────────────
run_update() { # <tree> <home>
  local tree="$1" h="$2"
  env -i HOME="$h" PATH="$h/.local/bin:/usr/bin:/bin" USER="fixture" \
    FLYWHEEL_DIR="$tree" ENV_FILE=/dev/null DEPLOYED_SHA_FILE="$h/.flywheel/deployed-sha" \
    bash "$tree/scripts/update-flywheel.sh" >"$h/out.log" 2>&1
}

T="$SANDBOX/s5-tree"; H="$SANDBOX/s5-home"
mk_tree "$T" prebuilt; mk_home "$H"
stub "$H" git 'exit 1'; stub "$H" curl 'exit 0'
run_update "$T" "$H"; rc=$?
if [ "$rc" -eq 3 ] && grep -q "安装包形态" "$H/out.log" \
   && ! grep -q "^git " <(calls "$H"); then
  pass "S5 update-flywheel prebuilt: honest refusal, exit 3, zero git"
else
  fail "S5 rc=$rc calls=[$(calls "$H")] out=[$(cat "$H/out.log")]"
fi

T="$SANDBOX/s6-tree"; H="$SANDBOX/s6-home"
mk_tree "$T"; mk_home "$H"
# monorepo side: empty self-ship queue → fallback sweep → stubbed fetch fails →
# clean exit 0. The refusal must NOT fire and git MUST be exercised (proves the
# script ran past the sentinel check into the verbatim updater flow).
stub "$H" git 'exit 1'; stub "$H" curl 'exit 0'
run_update "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] && ! grep -q "安装包形态" "$H/out.log" \
   && grep -q "^git " <(calls "$H"); then
  pass "S6 update-flywheel monorepo sentinel: no refusal, updater flow runs"
else
  fail "S6 rc=$rc calls=[$(calls "$H")] out=[$(cat "$H/out.log")]"
fi

# ─────────────────────────────────────────────────────────────────────────────
# S7/S8 · converge-flywheel-bin.sh FILES set on a packaged tree
# ─────────────────────────────────────────────────────────────────────────────
run_converge() { # <tree> <home>
  local tree="$1" h="$2"
  env -i HOME="$h" PATH="/usr/bin:/bin" \
    FLYWHEEL_STATE_DIR="$h/.flywheel" \
    FLYWHEEL_CONVERGE_ALERT_BIN="$h/.local/bin/alert-stub" \
    bash "$tree/scripts/converge-flywheel-bin.sh" >"$h/out.log" 2>&1
}
mk_alert_stub() { # <home>
  local h="$1"
  stub "$h" alert-stub 'exit 0'
}

T="$SANDBOX/s7-tree"; H="$SANDBOX/s7-home"
mk_tree "$T" prebuilt; mk_home "$H"; mk_alert_stub "$H"
# steady-state Lead start: bin copies already converged (555) — the ONLY thing
# that could ring here is the restart-services.sh source-missing false positive
# this branch removes.
mkdir -p "$H/.flywheel/bin"
for f in flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh; do
  cp -p "$T/scripts/$f" "$H/.flywheel/bin/$f"; chmod 555 "$H/.flywheel/bin/$f"
done
run_converge "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] && ! grep -q "restart-services.sh" "$H/out.log" \
   && [ -z "$(calls "$H")" ]; then
  pass "S7 converge prebuilt: restart-services.sh not expected, zero alerts on steady state"
else
  fail "S7 rc=$rc alerts=[$(calls "$H")] out=[$(cat "$H/out.log")]"
fi

T="$SANDBOX/s8-tree"; H="$SANDBOX/s8-home"
mk_tree "$T"; mk_home "$H"; mk_alert_stub "$H"
run_converge "$T" "$H"; rc=$?
if [ "$rc" -eq 1 ] && grep -q "repo source missing.*restart-services.sh" "$H/out.log" \
   && grep -q "srcmissing" <(calls "$H"); then
  pass "S8 converge monorepo sentinel: missing restart-services.sh stays fail-loud"
else
  fail "S8 rc=$rc alerts=[$(calls "$H")] out=[$(cat "$H/out.log")]"
fi

# ─────────────────────────────────────────────────────────────────────────────
# S9/S10 · linux-preflight.sh --check pnpm requirement on a packaged tree
# Stub systemctl/loginctl so the systemd probes pass deterministically on any
# CI host; provide every required command EXCEPT pnpm.
# ─────────────────────────────────────────────────────────────────────────────
run_preflight() { # <tree> <home>
  local tree="$1" h="$2"
  env -i HOME="$h" PATH="$h/.local/bin:/usr/bin:/bin" USER="fixture" \
    bash "$tree/scripts/linux-preflight.sh" --check >"$h/out.log" 2>&1
}
mk_preflight_stubs() { # <home>
  local h="$1"
  stub "$h" systemctl 'exit 0'
  stub "$h" loginctl 'echo "Linger=yes"; exit 0'
  stub "$h" curl 'exit 0'
  for c in node git tmux gh; do
    stub "$h" "$c" 'echo "stub-version 1.0"; exit 0'
  done
  # jq must be REAL: host-config parses with it (a fake jq flips HOSTCFG_FAIL
  # and pollutes the --check differential this test isolates to pnpm).
  ln -s "$(command -v jq)" "$h/.local/bin/jq"
}

T="$SANDBOX/s9-tree"; H="$SANDBOX/s9-home"
mk_tree "$T" prebuilt; mk_home "$H"; mk_preflight_stubs "$H"
run_preflight "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "CHECK: PASS" "$H/out.log" \
   && ! grep -q "\[MISSING\] pnpm" "$H/out.log"; then
  pass "S9 linux-preflight prebuilt: --check passes without pnpm"
else
  fail "S9 rc=$rc out=[$(tail -20 "$H/out.log")]"
fi

T="$SANDBOX/s10-tree"; H="$SANDBOX/s10-home"
mk_tree "$T"; mk_home "$H"; mk_preflight_stubs "$H"
run_preflight "$T" "$H"; rc=$?
if [ "$rc" -eq 1 ] && grep -q "CHECK: FAIL" "$H/out.log" \
   && grep -q "\[MISSING\] pnpm" "$H/out.log"; then
  pass "S10 linux-preflight monorepo sentinel: --check still requires pnpm"
else
  fail "S10 rc=$rc out=[$(tail -20 "$H/out.log")]"
fi

# ─────────────────────────────────────────────────────────────────────────────
# S11/S12 · supervisor.sh darwin REAL install opt-in
# ─────────────────────────────────────────────────────────────────────────────
H="$SANDBOX/s11-home"; mk_home "$H"
stub "$H" launchctl 'exit 0'
LDIR="$SANDBOX/s11-launchd"
SPEC='{"name":"bridge","kind":"service","exec":"/bin/bash /x/wrapper.sh","keepAlive":true,"stdout":"/tmp/x.log"}'
out="$(env HOME="$H" PATH="$H/.local/bin:$PATH" \
  FLYWHEEL_SUPERVISOR_BACKEND=launchd FLYWHEEL_LAUNCHD_DIR="$LDIR" \
  FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1 \
  bash -c 'source "'"$REPO_ROOT"'/scripts/lib/supervisor.sh"; supervisor_install "$1"' _ "$SPEC" 2>&1)"; rc=$?
PLIST="$LDIR/com.flywheel.bridge.plist"
if [ "$rc" -eq 0 ] && [ -f "$PLIST" ] \
   && grep -q "<string>com.flywheel.bridge</string>" "$PLIST" \
   && grep -q "<string>/x/wrapper.sh</string>" "$PLIST" \
   && grep -q "<key>KeepAlive</key><true/>" "$PLIST" \
   && grep -q "launchctl bootstrap" <(calls "$H"); then
  pass "S11 supervisor darwin opt-in: plist rendered + bootstrapped"
else
  fail "S11 rc=$rc plist=$([ -f "$PLIST" ] && echo yes || echo no) calls=[$(calls "$H")] out=[$out]"
fi

# timer spec renders StartCalendarInterval
H="$SANDBOX/s11b-home"; mk_home "$H"
stub "$H" launchctl 'exit 0'
LDIR="$SANDBOX/s11b-launchd"
SPEC='{"name":"daily-standup","kind":"timer","exec":"/bin/bash /x/standup.sh","schedule":[{"hour":3,"minute":0}]}'
out="$(env HOME="$H" PATH="$H/.local/bin:$PATH" \
  FLYWHEEL_SUPERVISOR_BACKEND=launchd FLYWHEEL_LAUNCHD_DIR="$LDIR" \
  FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1 \
  bash -c 'source "'"$REPO_ROOT"'/scripts/lib/supervisor.sh"; supervisor_install "$1"' _ "$SPEC" 2>&1)"; rc=$?
PLIST="$LDIR/com.flywheel.daily-standup.plist"
if [ "$rc" -eq 0 ] && [ -f "$PLIST" ] \
   && grep -q "StartCalendarInterval" "$PLIST" \
   && grep -q "<key>Hour</key><integer>3</integer>" "$PLIST"; then
  pass "S11b supervisor darwin opt-in: timer spec renders StartCalendarInterval"
else
  fail "S11b rc=$rc out=[$out]"
fi

H="$SANDBOX/s12-home"; mk_home "$H"
stub "$H" launchctl 'exit 0'
LDIR="$SANDBOX/s12-launchd"
SPEC='{"name":"bridge","kind":"service","exec":"/bin/bash /x/wrapper.sh","keepAlive":true}'
out="$(env HOME="$H" PATH="$H/.local/bin:$PATH" \
  FLYWHEEL_SUPERVISOR_BACKEND=launchd FLYWHEEL_LAUNCHD_DIR="$LDIR" \
  bash -c 'source "'"$REPO_ROOT"'/scripts/lib/supervisor.sh"; supervisor_install "$1"' _ "$SPEC" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$LDIR/com.flywheel.bridge.plist" ] \
   && [ -z "$(calls "$H")" ] \
   && grep -q "delegated to existing launchd flow" <<<"$out"; then
  pass "S12 supervisor darwin sentinel: FLY-650 delegating no-op verbatim (no plist, no launchctl)"
else
  fail "S12 rc=$rc out=[$out] calls=[$(calls "$H")]"
fi

echo ""
echo "packaged-seams: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
