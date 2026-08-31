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
PACKAGED_ASSEMBLY="$SANDBOX/assembled-payload"

# Build the scripts subtree through the REAL packaging assembler. Packaged
# fixtures below must consume this tree, never hand-copy runtime dependencies
# from the repository: a hand copy can make a seam test green for a file the
# customer payload does not ship.
if env PACKAGE_ONBOARD_SOURCED=1 bash -c \
  'source "$1"; po_copy_curated_scripts "$2" "$3"' \
  _ "$REPO_ROOT/scripts/package-onboard.sh" "$REPO_ROOT" "$PACKAGED_ASSEMBLY"; then
  echo "1.0.0-test" > "$PACKAGED_ASSEMBLY/.flywheel-prebuilt"
else
  fail "S0 real packaged scripts assembly failed"
  echo ""
  echo "packaged-seams: PASSED=$PASSED FAILED=$FAILED"
  exit 1
fi

closure_ok=1
for f in restart-storm-gate.py host-tmux-selection-gate.sh lib/bounded-run.sh meta-alert.sh lead-alert.sh \
  flywheel-lead-wrapper-v2.sh \
  flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh \
  flywheel-codex-lead-wrapper-codex-infra-bot.sh \
  flywheel-lead-attach.sh flywheel-view-attach.sh \
  flywheel-node-status.sh lib/lead-address.sh; do
  [ -x "$PACKAGED_ASSEMBLY/scripts/$f" ] || closure_ok=0
done
if [ "$closure_ok" -eq 1 ]; then
  pass "S0 packaged restart-gate runtime closure is assembled and executable"
else
  fail "S0 packaged restart-gate runtime closure incomplete"
fi

# ── fixture tree builder ─────────────────────────────────────────────────────
# mk_tree <dir> [prebuilt] — a minimal tree carrying the REAL scripts under
# test. Prebuilt fixtures copy from PACKAGED_ASSEMBLY; monorepo sentinels copy
# repository files directly.
mk_tree() {
  local dir="$1" prebuilt="${2:-}"
  mkdir -p "$dir/scripts/lib"
  if [ "$prebuilt" = "prebuilt" ]; then
    cp -Rp "$PACKAGED_ASSEMBLY/scripts/." "$dir/scripts/"
    cp -p "$PACKAGED_ASSEMBLY/.flywheel-prebuilt" "$dir/.flywheel-prebuilt"
    return 0
  fi
  for f in flywheel-bridge-wrapper.sh flywheel-lead-wrapper-v2.sh daily-standup.sh \
           update-flywheel.sh converge-flywheel-bin.sh linux-preflight.sh \
           launchd-census.sh restart-storm-gate.py host-tmux-selection-gate.sh meta-alert.sh lead-alert.sh \
           flywheel-view-attach.sh flywheel-node-status.sh; do
    cp -p "$REPO_ROOT/scripts/$f" "$dir/scripts/$f"
  done
  for f in lib/script-sanity.sh lib/host-config.sh lib/supervisor.sh \
           lib/bounded-run.sh lib/discord-pointer-guard.sh \
           lib/converge-nonlead-daemons.sh; do
    cp -p "$REPO_ROOT/scripts/$f" "$dir/scripts/$f"
  done
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
  mkdir -p "$h/.flywheel/bin"
  printf '%s\n' '#!/bin/bash' 'exit 0' > "$h/.flywheel/bin/host-tmux-selection-gate.sh"
  chmod +x "$h/.flywheel/bin/host-tmux-selection-gate.sh"
  env -i HOME="$h" PATH="/usr/bin:/bin" FLYWHEEL_DIR="$tree" \
    FLYWHEEL_STATE_DIR="$h/.flywheel" \
    FLYWHEEL_BRIDGE_LOG_PATH="$h/bridge-main.log" \
    bash "$tree/scripts/flywheel-bridge-wrapper.sh" >"$h/out.log" 2>&1
}

T="$SANDBOX/s1-tree"; H="$SANDBOX/s1-home"
mk_tree "$T"; mk_home "$H"
printf 'stale-wrapper-capture\n' > "$H/.flywheel/state/bridge-startup.log"
stub "$H" node \
  'printf "%s\n" "${FLYWHEEL_TMUX_SOCKET_OVERRIDE-}" > "$HOME/bridge-socket"' \
  'printf "%s|%s|%s\n" "$FLYWHEEL_BRIDGE_LOG_PATH" "$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG" "$FLYWHEEL_BRIDGE_LOG_ERROR_MARKER" > "$HOME/bridge-log-env"' \
  'printf "packaged-wrapper-startup\n"' \
  'exit 0'
stub "$H" npx 'exit 0'
mkdir -p "$T/dist"; echo "// compiled" > "$T/dist/run-bridge.js"
run_bridge_wrapper "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "^node dist/run-bridge.js$" <(calls "$H") \
   && ! grep -q "^npx " <(calls "$H") \
   && [ -z "$(cat "$H/bridge-socket")" ] \
   && [ "$(cat "$H/bridge-log-env")" = "$H/bridge-main.log|$H/.flywheel/state/bridge-startup.log|$H/.flywheel/state/bridge-log-rotation-error.json" ] \
   && grep -q '^packaged-wrapper-startup$' "$H/.flywheel/state/bridge-startup.log" \
   && ! grep -q 'stale-wrapper-capture' "$H/.flywheel/state/bridge-startup.log"; then
  pass "S1 bridge-wrapper packaged: command unchanged, rotation env isolated, startup capture truncated"
else
  fail "S1 rc=$rc socket=[$(cat "$H/bridge-socket" 2>/dev/null || true)] env=[$(cat "$H/bridge-log-env" 2>/dev/null || true)] startup=[$(cat "$H/.flywheel/state/bridge-startup.log" 2>/dev/null || true)] calls=[$(calls "$H")] out=[$(cat "$H/out.log")]"
fi

T="$SANDBOX/s2-tree"; H="$SANDBOX/s2-home"
mk_tree "$T"; mk_home "$H"
printf 'stale-wrapper-capture\n' > "$H/.flywheel/state/bridge-startup.log"
stub "$H" node 'exit 0'
stub "$H" npx \
  'printf "%s|%s|%s\n" "$FLYWHEEL_BRIDGE_LOG_PATH" "$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG" "$FLYWHEEL_BRIDGE_LOG_ERROR_MARKER" > "$HOME/bridge-log-env"' \
  'printf "monorepo-wrapper-startup\n"' \
  'exit 0'
run_bridge_wrapper "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "^npx tsx scripts/run-bridge.ts$" <(calls "$H") \
   && ! grep -q "^node " <(calls "$H") \
   && [ "$(cat "$H/bridge-log-env")" = "$H/bridge-main.log|$H/.flywheel/state/bridge-startup.log|$H/.flywheel/state/bridge-log-rotation-error.json" ] \
   && grep -q '^monorepo-wrapper-startup$' "$H/.flywheel/state/bridge-startup.log" \
   && ! grep -q 'stale-wrapper-capture' "$H/.flywheel/state/bridge-startup.log"; then
  pass "S2 bridge-wrapper monorepo sentinel: command unchanged, rotation env isolated, startup capture truncated"
else
  fail "S2 rc=$rc env=[$(cat "$H/bridge-log-env" 2>/dev/null || true)] startup=[$(cat "$H/.flywheel/state/bridge-startup.log" 2>/dev/null || true)] calls=[$(calls "$H")] out=[$(cat "$H/out.log")]"
fi

T="$SANDBOX/s2b-tree"; H="$SANDBOX/s2b-home"
mk_tree "$T"; mk_home "$H"
printf 'must-not-be-truncated\n' > "$H/startup-target"
ln -s "$H/startup-target" "$H/.flywheel/state/bridge-startup.log"
stub "$H" node 'exit 0'; stub "$H" npx 'exit 0'
run_bridge_wrapper "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] \
   && [ "$(cat "$H/startup-target")" = "must-not-be-truncated" ] \
   && grep -q '^npx tsx scripts/run-bridge.ts$' <(calls "$H") \
   && grep -qi 'unsafe Bridge raw startup log.*continuing via /dev/null' "$H/out.log"; then
  pass "S2b bridge-wrapper bypasses an unsafe raw capture and still starts"
else
  fail "S2b rc=$rc target=[$(cat "$H/startup-target")] calls=[$(calls "$H")] out=[$(cat "$H/out.log")]"
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
    FLYWHEEL_STATE_DIR="$h/.flywheel" \
    FLYWHEEL_BRIDGE_LOG_PATH="$h/bridge-main.log" \
    bash "$tree/scripts/daily-standup.sh" >"$h/out.log" 2>&1
}
mk_standup_stubs() { # <home>
  local h="$1"
  stub "$h" curl \
    'for a in "$@"; do case "$a" in */health)' \
    '  [ -f "${STANDUP_MARKER:?}" ] && exit 0 || exit 22 ;;' \
    'esac; done' \
    'echo "{}"; exit 0'
  stub "$h" node \
    'printf "%s|%s|%s\n" "$FLYWHEEL_BRIDGE_LOG_PATH" "$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG" "$FLYWHEEL_BRIDGE_LOG_ERROR_MARKER" > "$HOME/standup-log-env"' \
    'printf "daily-node-startup\n"' \
    'touch "${STANDUP_MARKER:?}"; sleep 3'
  stub "$h" npx \
    'printf "%s|%s|%s\n" "$FLYWHEEL_BRIDGE_LOG_PATH" "$FLYWHEEL_BRIDGE_RAW_STARTUP_LOG" "$FLYWHEEL_BRIDGE_LOG_ERROR_MARKER" > "$HOME/standup-log-env"' \
    'printf "daily-npx-startup\n"' \
    'touch "${STANDUP_MARKER:?}"; sleep 3'
}

T="$SANDBOX/s3-tree"; H="$SANDBOX/s3-home"
mk_tree "$T"; mk_home "$H"; mk_standup_stubs "$H"
printf 'stale-daily-capture\n' > "$H/.flywheel/state/bridge-startup-daily.log"
mkdir -p "$T/dist" "$T/packages/teamlead/dist/bridge"
echo "// compiled" > "$T/dist/run-bridge.js"
echo "// plugin"   > "$T/packages/teamlead/dist/bridge/plugin.js"
run_standup "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "^node $T/dist/run-bridge.js$" <(calls "$H") \
   && ! grep -q "^npx " <(calls "$H") \
   && [ "$(cat "$H/standup-log-env")" = "$H/bridge-main.log|$H/.flywheel/state/bridge-startup-daily.log|$H/.flywheel/state/bridge-log-rotation-error.json" ] \
   && grep -q '^daily-node-startup$' "$H/.flywheel/state/bridge-startup-daily.log" \
   && ! grep -q 'stale-daily-capture' "$H/.flywheel/state/bridge-startup-daily.log"; then
  pass "S3 daily-standup packaged: command unchanged, distinct startup capture truncated"
else
  fail "S3 rc=$rc env=[$(cat "$H/standup-log-env" 2>/dev/null || true)] startup=[$(cat "$H/.flywheel/state/bridge-startup-daily.log" 2>/dev/null || true)] calls=[$(calls "$H")] out=[$(cat "$H/out.log")]"
fi

T="$SANDBOX/s4-tree"; H="$SANDBOX/s4-home"
mk_tree "$T"; mk_home "$H"; mk_standup_stubs "$H"
printf 'stale-daily-capture\n' > "$H/.flywheel/state/bridge-startup-daily.log"
mkdir -p "$T/packages/teamlead/dist/bridge"
echo "// plugin" > "$T/packages/teamlead/dist/bridge/plugin.js"
run_standup "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "^npx tsx $T/scripts/run-bridge.ts$" <(calls "$H") \
   && ! grep -q "^node " <(calls "$H") \
   && [ "$(cat "$H/standup-log-env")" = "$H/bridge-main.log|$H/.flywheel/state/bridge-startup-daily.log|$H/.flywheel/state/bridge-log-rotation-error.json" ] \
   && grep -q '^daily-npx-startup$' "$H/.flywheel/state/bridge-startup-daily.log" \
   && ! grep -q 'stale-daily-capture' "$H/.flywheel/state/bridge-startup-daily.log"; then
  pass "S4 daily-standup monorepo sentinel: command unchanged, distinct startup capture truncated"
else
  fail "S4 rc=$rc env=[$(cat "$H/standup-log-env" 2>/dev/null || true)] startup=[$(cat "$H/.flywheel/state/bridge-startup-daily.log" 2>/dev/null || true)] calls=[$(calls "$H")] out=[$(cat "$H/out.log")]"
fi

T="$SANDBOX/s4b-tree"; H="$SANDBOX/s4b-home"
mk_tree "$T"; mk_home "$H"; mk_standup_stubs "$H"
mkdir -p "$T/packages/teamlead/dist/bridge"
echo "// plugin" > "$T/packages/teamlead/dist/bridge/plugin.js"
printf 'must-not-be-truncated\n' > "$H/daily-startup-target"
ln -s "$H/daily-startup-target" "$H/.flywheel/state/bridge-startup-daily.log"
run_standup "$T" "$H"; rc=$?
if [ "$rc" -eq 0 ] \
   && [ "$(cat "$H/daily-startup-target")" = "must-not-be-truncated" ] \
   && grep -q "^npx tsx $T/scripts/run-bridge.ts$" <(calls "$H") \
   && grep -qi 'unsafe Bridge raw startup log.*continuing via /dev/null' "$H/out.log"; then
  pass "S4b daily fallback bypasses an unsafe raw capture and still starts"
else
  fail "S4b rc=$rc target=[$(cat "$H/daily-startup-target")] calls=[$(calls "$H")] out=[$(cat "$H/out.log")]"
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
# monorepo side: no urgent token → scheduled sweep → stubbed fetch fails with
# the new indeterminate rc=2. The refusal must NOT fire and git MUST be exercised
# (proves the script ran past the sentinel check into the updater flow).
mkdir -p "$H/.flywheel/restart.lock.d"
stub "$H" git 'exit 1'; stub "$H" curl 'exit 0'
run_update "$T" "$H"; rc=$?
if [ "$rc" -eq 2 ] && ! grep -q "安装包形态" "$H/out.log" \
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
    FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT=1 \
    FLYWHEEL_CONVERGE_ALERT_BIN="$h/.local/bin/alert-stub" \
    bash "$tree/scripts/converge-flywheel-bin.sh" >"$h/out.log" 2>&1
}
mk_alert_stub() { # <home>
  local h="$1"
  stub "$h" alert-stub 'exit 0'
}

T="$SANDBOX/s7-tree"; H="$SANDBOX/s7-home"
mk_tree "$T" prebuilt; mk_home "$H"; mk_alert_stub "$H"
# FLY-1577: mark this converge fixture worktree-shaped EXPLICITLY instead of
# relying on the sandbox landing somewhere path-hygiene calls temp. Under a
# valid custom TMPDIR it does not, the tree is judged trusted, and the strict
# meta-alert lane creates a link + alert that this zero-alert case then counts.
# Scoped to the converge seams (S7/S8) so the other packaged/monorepo seams keep
# their existing shape.
echo "gitdir: /main/.git/worktrees/s7-fixture" > "$T/.git"
# steady-state Lead start: bin copies already converged (555) — the ONLY thing
# that could ring here is the restart-services.sh source-missing false positive
# this branch removes.
# FLY-1577 widened the packaged FILES with the cmux watcher's launch-path
# dependencies (both ship in a packaged tree — see the S0 closure check above),
# so steady state now has to include them or this case counts their repairs.
mkdir -p "$H/.flywheel/bin/lib"
for f in flywheel-lead-wrapper-v2.sh \
  flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh \
  flywheel-codex-lead-wrapper-codex-infra-bot.sh flywheel-lead-attach.sh \
  flywheel-view-attach.sh flywheel-node-status.sh flywheel-bridge-wrapper.sh \
  restart-storm-gate.py host-tmux-selection-gate.sh lib/bounded-run.sh lib/lead-address.sh; do
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
echo "gitdir: /main/.git/worktrees/s8-fixture" > "$T/.git"   # FLY-1577: see S7
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

# interval timer spec renders StartInterval and stays non-KeepAlive
H="$SANDBOX/s11c-home"; mk_home "$H"
stub "$H" launchctl 'exit 0'
LDIR="$SANDBOX/s11c-launchd"
SPEC='{"name":"interval-worker","kind":"timer","exec":"/bin/bash /x/interval-worker-once.sh","intervalSeconds":60,"timeoutSeconds":60}'
out="$(env HOME="$H" PATH="$H/.local/bin:$PATH" \
  FLYWHEEL_SUPERVISOR_BACKEND=launchd FLYWHEEL_LAUNCHD_DIR="$LDIR" \
  FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1 \
  bash -c 'source "'"$REPO_ROOT"'/scripts/lib/supervisor.sh"; supervisor_install "$1"' _ "$SPEC" 2>&1)"; rc=$?
PLIST="$LDIR/com.flywheel.interval-worker.plist"
if [ "$rc" -eq 0 ] && [ -f "$PLIST" ] \
   && grep -q "<key>StartInterval</key><integer>60</integer>" "$PLIST" \
   && ! grep -q "<key>KeepAlive</key>" "$PLIST"; then
  pass "S11c supervisor darwin opt-in: bounded interval timer renders StartInterval"
else
  fail "S11c rc=$rc out=[$out]"
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
