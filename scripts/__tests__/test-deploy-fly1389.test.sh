#!/usr/bin/env bash
# FLY-1389: 529-Room repair batch — hermetic suite for the test-deploy.sh
# changes:
#   T*  qa_room_resolve_lead_ready_timeout (P2-a knob: precedence, validation
#       matrix, bounds, default-120 compat)
#   E*  Lead-ful hermetic E2E (stub claude-lead.sh in a fake repo, stub
#       gh/pnpm/node/npx/tmux, fake HOME, local bare sandbox remote):
#       P0-a env sanitize (malicious caller LEAD_WORKSPACE/CLAUDE_CONFIG_DIR/
#       FLYWHEEL_LEAD_MODEL cleared; LEAD_WORKSPACE pinned slot-local),
#       P0-d stale session-id pre-delete, P1-a slot Bridge FLYWHEEL_BIN_DIR/
#       FLYWHEEL_HOOKS_DIR isolation (asserted from the LIVE Bridge process
#       env dump, not source grep), default-path compat (noLead=false).
#   N*  --no-lead hermetic E2E: fake HOME WITHOUT ~/Dev/GeoForge3D reaches
#       Bridge /health; rules-staging skip proven via a SENTINEL source dir
#       (Codex R2 #4: /health alone cannot prove the skip — the canary must
#       not be staged); no Lead artifacts; JSON contract; teardown clean.
#   X*  mutual exclusion + extra-lead source sentinels (campaign path is not
#       E2E-runnable hermetically; the manifest/env lines are pinned).
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; shift; [ $# -gt 0 ] && echo "        $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── T: timeout resolver unit matrix ─────────────────────────────────────────
# shellcheck source=../lib/qa-room.sh
source "${SCRIPT_DIR}/lib/qa-room.sh"

T_OK=1
[[ "$(qa_room_resolve_lead_ready_timeout "" "")" == "120" ]] || { T_OK=0; fail "T: default must be 120"; }
[[ "$(qa_room_resolve_lead_ready_timeout "300" "600")" == "300" ]] || { T_OK=0; fail "T: flag must beat env"; }
[[ "$(qa_room_resolve_lead_ready_timeout "" "600")" == "600" ]] || { T_OK=0; fail "T: env fallback"; }
[[ "$(qa_room_resolve_lead_ready_timeout "1" "")" == "1" ]] || { T_OK=0; fail "T: lower bound 1"; }
[[ "$(qa_room_resolve_lead_ready_timeout "3600" "")" == "3600" ]] || { T_OK=0; fail "T: upper bound 3600"; }
[[ "$(qa_room_resolve_lead_ready_timeout "090" "")" == "90" ]] || { T_OK=0; fail "T: leading zero is decimal 90 (no octal trap)"; }
for bad in abc 0 -5 3.5 3601 "12 34" "1e3"; do
  if qa_room_resolve_lead_ready_timeout "$bad" "" >/dev/null 2>&1; then
    T_OK=0; fail "T: invalid value accepted: '$bad'"
  fi
done
if qa_room_resolve_lead_ready_timeout "" "0" >/dev/null 2>&1; then
  T_OK=0; fail "T: invalid env value accepted: '0'"
fi
[[ "$T_OK" == "1" ]] && pass "T: lead-ready-timeout resolver (default/precedence/bounds/invalid matrix)"

# ── shared hermetic fixture ─────────────────────────────────────────────────
export FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly1389-test-incarnation"
SB="$(mktemp -d /tmp/fly1389-deploy-XXXXXX)"
LEAD_SLOT=31; NOLEAD_SLOT=32
cleanup() {
  # Kill any stub leads / stub bridges we started, release fixture locks.
  pkill -f "fly1389-stub-lead-marker" 2>/dev/null || true
  pkill -f "fly1389-stub-bridge-marker" 2>/dev/null || true
  rm -rf "/tmp/flywheel-test-slot-${LEAD_SLOT}.lock" "/tmp/flywheel-test-slot-${NOLEAD_SLOT}.lock" \
    "/tmp/flywheel-test-slot-${LEAD_SLOT}" "/tmp/flywheel-test-slot-${NOLEAD_SLOT}" "$SB"
}
trap cleanup EXIT

# Fake repo: real test-deploy/test-teardown + real libs + stub claude-lead.
FR="$SB/repo"
mkdir -p "$FR/scripts/lib" "$FR/packages/teamlead/scripts" \
  "$FR/packages/flywheel-comm" "$FR/packages/inbox-mcp" \
  "$FR/packages/edge-worker/dist" \
  "$FR/node_modules/.pnpm/better-sqlite3@11.0.0/node_modules/better-sqlite3/build/Release"
cp "${SCRIPT_DIR}/test-deploy.sh" "${SCRIPT_DIR}/test-teardown.sh" "$FR/scripts/"
cp "${SCRIPT_DIR}/lib/qa-room.sh" "${SCRIPT_DIR}/lib/qa-multilead.sh" "$FR/scripts/lib/"
echo "// fixture" > "$FR/scripts/run-bridge.ts"
echo "FLYWHEEL_RUNNER_START_POINT fixture" > "$FR/packages/edge-worker/dist/WorktreeManager.js"
echo "fake-binding" > "$FR/node_modules/.pnpm/better-sqlite3@11.0.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

# Stub claude-lead.sh: dumps its env, writes pid file + a live lease, parks.
cat > "$FR/packages/teamlead/scripts/claude-lead.sh" <<'STUBLEAD'
#!/bin/bash
# fly1389-stub-lead-marker
AGENT="$1"; PROJ="$3"
SD="$(dirname "$DISCORD_STATE_DIR")"
env | sort > "$SD/lead-env.txt"
mkdir -p "$HOME/.flywheel/pids" "$HOME/.flywheel/comm/$PROJ"
echo $$ > "$HOME/.flywheel/pids/$PROJ-$AGENT.pid"
printf '{"pid": %s}\n' $$ > "$HOME/.flywheel/comm/$PROJ/.inbox-ready-$AGENT"
sleep 300
STUBLEAD
chmod +x "$FR/packages/teamlead/scripts/claude-lead.sh"

# Local bare "sandbox remote" with a main branch.
SRCREPO="$SB/srcrepo"
git init -q -b main "$SRCREPO"
( cd "$SRCREPO" && echo hello > README.md && git add . \
  && git -c user.email=t@t -c user.name=t commit -qm init )
BARE="$SB/sandbox.git"
git clone -q --bare "$SRCREPO" "$BARE"

# Stub bin: gh / pnpm / node / npx (fake Bridge = python http 200) / tmux.
STUB_BIN="$SB/stub-bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/gh" <<'EOF'
#!/bin/bash
case "$1" in
  auth) exit 0 ;;
  repo) exit 0 ;;
  api)  echo "true"; exit 0 ;;
esac
exit 0
EOF
cat > "$STUB_BIN/pnpm" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$STUB_BIN/node" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$STUB_BIN/npx" <<'EOF'
#!/bin/bash
# fly1389-stub-bridge-marker — stands in for `npx tsx run-bridge.ts`.
SLOT_DIR="$(dirname "${TEAMLEAD_DB_PATH:?}")"
env | sort > "$SLOT_DIR/bridge-env.txt"
exec python3 -c "
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', int(os.environ['TEAMLEAD_PORT'])), H).serve_forever()
"
EOF
cat > "$STUB_BIN/tmux" <<'EOF'
#!/bin/bash
echo "$*" >> "${TMUX_STUB_LOG:-/dev/null}"
case "$1" in
  list-windows) [ -n "${TMUX_STUB_WINDOW:-}" ] && echo "@1 ${TMUX_STUB_WINDOW}"; exit 0 ;;
  capture-pane) echo "Loading development channels"; exit 0 ;;
esac
exit 0
EOF
chmod +x "$STUB_BIN"/*

# Fake HOME #1 (Lead-ful): identity + shared rules present.
FH1="$SB/home1"
mkdir -p "$FH1/.flywheel/claude-sessions" \
  "$FH1/Dev/GeoForge3D/.lead/product-lead" "$FH1/Dev/GeoForge3D/.lead/shared"
echo "# prod identity fixture" > "$FH1/Dev/GeoForge3D/.lead/product-lead/identity.md"
echo "# shared rule fixture" > "$FH1/Dev/GeoForge3D/.lead/shared/dept.md"
# Fake HOME #2 (--no-lead): NO ~/Dev/GeoForge3D at all.
FH2="$SB/home2"
mkdir -p "$FH2/.flywheel/claude-sessions"

make_slots_json() {  # <file> — 32 slots; only 31/32 carry real fixture values
  jq -n '
    { guildId: "g-fixture",
      slots: ( [range(1;31)] | map({
          id: ., bridgePort: (20000 + .), botName: ("dummy-\(.)"),
          tokenEnvVar: ("DUMMY_TOKEN_\(.)"), botAppId: ("d\(.)"),
          channelId: ("dchan-\(.)"), role: "lead"
        })
        + [ { id: 31, bridgePort: 19898, botName: "flywheel-test-31",
              tokenEnvVar: "TEST_BOT_TOKEN_31", botAppId: "3131",
              channelId: "chan-31", role: "lead", identitySource: "product-lead" },
            { id: 32, bridgePort: 19897, botName: "flywheel-test-32",
              tokenEnvVar: "TEST_BOT_TOKEN_32", botAppId: "3232",
              channelId: "chan-32", role: "lead", identitySource: "product-lead" } ] )
    }'
}
for H in "$FH1" "$FH2"; do
  make_slots_json > "$H/.flywheel/test-slots.json"
  cat > "$H/.flywheel/.env" <<'EOF'
TEST_BOT_TOKEN_31=tok-31
TEST_BOT_TOKEN_32=tok-32
LINEAR_API_KEY=fixture-linear-key
EOF
done

run_deploy() {  # <home> <slot> <stdout-file> <stderr-file> [extra args...]
  local home="$1" slot="$2" out="$3" err="$4"; shift 4
  ( cd "$SB" && \
    env -i \
      HOME="$home" \
      PATH="$STUB_BIN:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v git)"):$(dirname "$(command -v jq)"):$(dirname "$(command -v python3)"):$(dirname "$(command -v curl)")" \
      TMPDIR=/tmp \
      TMUX_STUB_LOG="$home/tmux-calls.log" \
      TMUX_STUB_WINDOW="" \
      FLYWHEEL_SANDBOX_REMOTE_URL="$BARE" \
      FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly1389-test-incarnation" \
      LEAD_WORKSPACE="/malicious/prod-workspace" \
      CLAUDE_CONFIG_DIR="/malicious/claude-config" \
      TEST_SKIP_PLUGIN_FORK_CHECK=1 \
      TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="/malicious/claude-config" \
      TEST_LEAD_CLAUDE_CONFIG_DIR="${TEST_LEAD_CLAUDE_CONFIG_DIR:-}" \
      FLYWHEEL_LEAD_MODEL="malicious-model" \
      FLYWHEEL_LEAD_EFFORT="malicious-effort" \
      bash "$FR/scripts/test-deploy.sh" "$slot" "$@" \
      > "$out" 2> "$err" )
}

# test-deploy stdout carries a stray `git checkout -B` tracking line before
# the JSON (production shape too — consumers slice from the first '{').
extract_json() { sed -n '/^{/,$p' "$1"; }

run_teardown() {  # <home> <slot>
  ( env -i \
      HOME="$1" \
      PATH="$STUB_BIN:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v git)"):$(dirname "$(command -v jq)")" \
      TMPDIR=/tmp \
      TMUX_STUB_LOG="$1/tmux-calls.log" \
      FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly1389-test-incarnation" \
      bash "$FR/scripts/test-teardown.sh" "$2" >/dev/null 2>&1 )
}

# ── E: Lead-ful hermetic E2E (slot 31) ──────────────────────────────────────
rm -rf "/tmp/flywheel-test-slot-${LEAD_SLOT}.lock" "/tmp/flywheel-test-slot-${LEAD_SLOT}"
# P0-d fixture: a stale session-id from a "previous round".
echo "a13ca2cd-dead-dead-dead-000000000000" \
  > "$FH1/.flywheel/claude-sessions/test-slot-${LEAD_SLOT}-flywheel-test-31.session-id"

E_OUT="$SB/e-out.json"; E_ERR="$SB/e-err.log"
if run_deploy "$FH1" "$LEAD_SLOT" "$E_OUT" "$E_ERR"; then
  E_SLOT_DIR="/tmp/flywheel-test-slot-${LEAD_SLOT}"
  E_OK=1
  E_JSON="$(extract_json "$E_OUT")"
  jq -e '.noLead == false' <<<"$E_JSON" >/dev/null 2>&1 || { E_OK=0; fail "E: default path must report noLead=false"; }
  [[ -n "$(jq -r '.leadPidFile' <<<"$E_JSON")" ]] || { E_OK=0; fail "E: leadPidFile must be non-empty on the default path"; }
  # P0-a: caller leak cleared, LEAD_WORKSPACE pinned slot-local.
  LE="$E_SLOT_DIR/lead-env.txt"
  if [[ -f "$LE" ]]; then
    grep -q "^LEAD_WORKSPACE=${E_SLOT_DIR}/lead-workspace$" "$LE" || { E_OK=0; fail "E/P0-a: LEAD_WORKSPACE not pinned slot-local" "$(grep '^LEAD_WORKSPACE=' "$LE" || true)"; }
    grep -q "^CLAUDE_CONFIG_DIR=" "$LE" && { E_OK=0; fail "E/P0-a: CLAUDE_CONFIG_DIR leaked into Lead env"; }
    grep -q "^TEST_SKIP_PLUGIN_FORK_CHECK=" "$LE" && { E_OK=0; fail "E/P0-a: TEST_SKIP_PLUGIN_FORK_CHECK leaked into Lead env"; }
    grep -q "^TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR=" "$LE" \
      && { E_OK=0; fail "E/P0-a: fork-check expected config leaked into Lead env"; }
    grep -q "^FLYWHEEL_LEAD_MODEL=" "$LE" && { E_OK=0; fail "E/P0-a: FLYWHEEL_LEAD_MODEL leaked into Lead env"; }
    grep -q "^FLYWHEEL_LEAD_EFFORT=" "$LE" && { E_OK=0; fail "E/P0-a: FLYWHEEL_LEAD_EFFORT leaked into Lead env"; }
    grep -q "^DISCORD_BOT_TOKEN=tok-31$" "$LE" || { E_OK=0; fail "E: slot token not delivered"; }
  else
    E_OK=0; fail "E: stub Lead env dump missing" "$LE"
  fi
  # P0-d: stale session-id removed before Lead start.
  [[ ! -f "$FH1/.flywheel/claude-sessions/test-slot-${LEAD_SLOT}-flywheel-test-31.session-id" ]] \
    || { E_OK=0; fail "E/P0-d: stale session-id survived deploy"; }
  # P1-a: LIVE Bridge process env carries slot-local bin/hooks dirs.
  BE="$E_SLOT_DIR/bridge-env.txt"
  if [[ -f "$BE" ]]; then
    grep -q "^FLYWHEEL_BIN_DIR=${E_SLOT_DIR}/bin$" "$BE" || { E_OK=0; fail "E/P1-a: FLYWHEEL_BIN_DIR not slot-local in Bridge env"; }
    grep -q "^FLYWHEEL_HOOKS_DIR=${E_SLOT_DIR}/hooks$" "$BE" || { E_OK=0; fail "E/P1-a: FLYWHEEL_HOOKS_DIR not slot-local in Bridge env"; }
  else
    E_OK=0; fail "E: Bridge env dump missing" "$BE"
  fi
  [[ "$E_OK" == "1" ]] && pass "E: Lead-ful E2E — P0-a sanitize + P0-d pre-delete + P1-a Bridge isolation + noLead=false"
  run_teardown "$FH1" "$LEAD_SLOT"
  [[ ! -d "/tmp/flywheel-test-slot-${LEAD_SLOT}.lock" ]] \
    && pass "E2: teardown releases the Lead-ful slot" \
    || fail "E2: teardown left the lock behind"
else
  fail "E: Lead-ful hermetic deploy failed" "$(tail -20 "$E_ERR")"
  run_teardown "$FH1" "$LEAD_SLOT" || true
fi

# ── I: explicit isolated Claude config injection (FLY-1439) ────────────────
# The default E case above proves an inherited caller CLAUDE_CONFIG_DIR is
# still scrubbed. This opt-in case proves the dedicated QA knob is appended
# after `env -u CLAUDE_CONFIG_DIR`, and that the launcher's fail-closed
# expected-path sentinel is derived from the exact same value.
rm -rf "/tmp/flywheel-test-slot-${LEAD_SLOT}.lock" "/tmp/flywheel-test-slot-${LEAD_SLOT}"
I_OUT="$SB/i-out.json"; I_ERR="$SB/i-err.log"
I_CONFIG="$SB/isolated-claude-config"
mkdir -p "$I_CONFIG/plugins"
if TEST_LEAD_CLAUDE_CONFIG_DIR="$I_CONFIG" \
    run_deploy "$FH1" "$LEAD_SLOT" "$I_OUT" "$I_ERR"; then
  I_SLOT_DIR="/tmp/flywheel-test-slot-${LEAD_SLOT}"
  I_LE="$I_SLOT_DIR/lead-env.txt"
  I_OK=1
  grep -q "^CLAUDE_CONFIG_DIR=${I_CONFIG}$" "$I_LE" \
    || { I_OK=0; fail "I: opt-in CLAUDE_CONFIG_DIR did not reach Lead"; }
  grep -q "^TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR=${I_CONFIG}$" "$I_LE" \
    || { I_OK=0; fail "I: expected config sentinel did not match injected config"; }
  grep -q "^TEST_SKIP_PLUGIN_FORK_CHECK=1$" "$I_LE" \
    || { I_OK=0; fail "I: isolated config did not enable guarded fork-check skip"; }
  [[ "$I_OK" == "1" ]] \
    && pass "I: TEST_LEAD_CLAUDE_CONFIG_DIR opt-in reaches Lead with byte-identical expected-path sentinel"
  run_teardown "$FH1" "$LEAD_SLOT"
else
  fail "I: isolated config deploy failed" "$(tail -20 "$I_ERR")"
  run_teardown "$FH1" "$LEAD_SLOT" || true
fi

# ── N: --no-lead hermetic E2E (slot 32, HOME without GeoForge3D) ────────────
rm -rf "/tmp/flywheel-test-slot-${NOLEAD_SLOT}.lock" "/tmp/flywheel-test-slot-${NOLEAD_SLOT}"
# Rules-skip sentinel (Codex R2 #4): an EXISTING source dir with a canary —
# against pre-FLY-1389 code the canary WOULD be staged (that path only warns
# when the dir is missing), so this assertion is the falsifiable proof.
SENTINEL="$SB/sentinel-rules"
mkdir -p "$SENTINEL"
echo "# canary" > "$SENTINEL/canary.md"
# P0-d applies on the no-lead path too (delete sits before the branch).
echo "b13ca2cd-dead-dead-dead-000000000000" \
  > "$FH2/.flywheel/claude-sessions/test-slot-${NOLEAD_SLOT}-flywheel-test-32.session-id"

N_OUT="$SB/n-out.json"; N_ERR="$SB/n-err.log"
if ( cd "$SB" && \
  env -i \
    HOME="$FH2" \
    PATH="$STUB_BIN:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v git)"):$(dirname "$(command -v jq)"):$(dirname "$(command -v python3)"):$(dirname "$(command -v curl)")" \
    TMPDIR=/tmp \
    TMUX_STUB_LOG="$FH2/tmux-calls.log" \
    FLYWHEEL_SANDBOX_REMOTE_URL="$BARE" \
    FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly1389-test-incarnation" \
    GEOFORGE3D_LEAD_RULES_SRC="$SENTINEL" \
    bash "$FR/scripts/test-deploy.sh" "$NOLEAD_SLOT" --no-lead \
    > "$N_OUT" 2> "$N_ERR" ); then
  N_SLOT_DIR="/tmp/flywheel-test-slot-${NOLEAD_SLOT}"
  N_OK=1
  N_JSON="$(extract_json "$N_OUT")"
  jq -e '.noLead == true' <<<"$N_JSON" >/dev/null 2>&1 || { N_OK=0; fail "N: JSON noLead must be true"; }
  [[ "$(jq -r '.leadPidFile' <<<"$N_JSON")" == "" ]] || { N_OK=0; fail "N: leadPidFile must be empty"; }
  [[ "$(jq -r '.leadLog' <<<"$N_JSON")" == "" ]] || { N_OK=0; fail "N: leadLog must be empty"; }
  # No Lead started: no lease, no stub-lead env dump, no 'Starting test Lead'.
  [[ ! -e "$FH2/.flywheel/comm/test-slot-${NOLEAD_SLOT}/.inbox-ready-flywheel-test-32" ]] \
    || { N_OK=0; fail "N: lease file must not exist"; }
  [[ ! -f "$N_SLOT_DIR/lead-env.txt" ]] || { N_OK=0; fail "N: claude-lead.sh must not have been invoked"; }
  grep -q "Starting test Lead" "$N_ERR" && { N_OK=0; fail "N: log shows Lead startup"; }
  # Rules-skip sentinel: canary NOT staged, no staging log line.
  [[ ! -e "$N_SLOT_DIR/project-slot-${NOLEAD_SLOT}/.lead/shared/canary.md" ]] \
    || { N_OK=0; fail "N: sentinel rules canary WAS staged (skip not effective)"; }
  grep -q "Shared rules staged" "$N_ERR" && { N_OK=0; fail "N: rules staging log present on --no-lead"; }
  # No tmux interaction at all.
  [[ ! -s "$FH2/tmux-calls.log" ]] || { N_OK=0; fail "N: tmux was invoked on --no-lead" "$(cat "$FH2/tmux-calls.log")"; }
  # P0-d on the no-lead path.
  [[ ! -f "$FH2/.flywheel/claude-sessions/test-slot-${NOLEAD_SLOT}-flywheel-test-32.session-id" ]] \
    || { N_OK=0; fail "N/P0-d: stale session-id survived"; }
  # Bridge really answered /health (deploy exiting 0 proves it, but pin it).
  grep -q "Bridge ready on port" "$N_ERR" || { N_OK=0; fail "N: Bridge /health never answered"; }
  [[ "$N_OK" == "1" ]] && pass "N: --no-lead E2E — Bridge /health on a GeoForge3D-less HOME, rules sentinel not staged, zero Lead artifacts"
  if run_teardown "$FH2" "$NOLEAD_SLOT"; then
    [[ ! -d "/tmp/flywheel-test-slot-${NOLEAD_SLOT}.lock" ]] \
      && pass "N2: --no-lead teardown succeeds + releases lock" \
      || fail "N2: teardown left the lock behind"
  else
    fail "N2: teardown of a --no-lead slot failed"
  fi
else
  fail "N: --no-lead hermetic deploy failed" "$(tail -20 "$N_ERR")"
  run_teardown "$FH2" "$NOLEAD_SLOT" || true
fi

# ── X: mutual exclusion + extra-lead sentinels ──────────────────────────────
X_ERR="$SB/x-err.log"
if ( env -i HOME="$FH1" PATH="/usr/bin:/bin:$(dirname "$(command -v jq)")" \
    bash "$FR/scripts/test-deploy.sh" "$LEAD_SLOT" --no-lead --extra-lead 2:Ops-Test \
    >/dev/null 2> "$X_ERR" ); then
  fail "X1: --no-lead + --extra-lead must be rejected"
else
  grep -q "mutually exclusive" "$X_ERR" \
    && pass "X1: --no-lead + --extra-lead rejected at argument time" \
    || fail "X1: rejection reason missing" "$(cat "$X_ERR")"
fi

# Invalid knob fails BEFORE preflight (no gh in PATH here — reaching
# preflight would die on a different error message).
X2_ERR="$SB/x2-err.log"
if ( env -i HOME="$FH1" PATH="/usr/bin:/bin:$(dirname "$(command -v jq)")" \
    bash "$FR/scripts/test-deploy.sh" "$LEAD_SLOT" --lead-ready-timeout abc \
    >/dev/null 2> "$X2_ERR" ); then
  fail "X2: invalid --lead-ready-timeout must be rejected"
else
  grep -q "lead-ready-timeout" "$X2_ERR" \
    && pass "X2: invalid --lead-ready-timeout rejected before preflight" \
    || fail "X2: wrong failure point" "$(cat "$X2_ERR")"
fi

# Invalid isolated roots fail before preflight (no gh in PATH, as above).
X2B_ERR="$SB/x2b-err.log"
if ( env -i HOME="$FH1" PATH="/usr/bin:/bin:$(dirname "$(command -v jq)")" \
    TEST_LEAD_CLAUDE_CONFIG_DIR="$SB/does-not-exist" \
    bash "$FR/scripts/test-deploy.sh" "$LEAD_SLOT" \
    >/dev/null 2> "$X2B_ERR" ); then
  fail "X2b: missing TEST_LEAD_CLAUDE_CONFIG_DIR must be rejected"
else
  grep -q "TEST_LEAD_CLAUDE_CONFIG_DIR must be an existing absolute directory" "$X2B_ERR" \
    && pass "X2b: missing isolated config rejected before preflight" \
    || fail "X2b: wrong failure point" "$(cat "$X2B_ERR")"
fi

# Extra-lead path source sentinels (campaign not hermetically E2E-runnable):
# the extra-Lead env must clear the same leak set + pin LEAD_WORKSPACE under
# XDIR, and the campaign manifest's leadWorkspace must live under the OWNER
# slot's extra-leads dir (teardown consumes that same field).
TD_SRC="${SCRIPT_DIR}/test-deploy.sh"
X3_OK=1
grep -q 'LEAD_WORKSPACE="${XDIR}/lead-workspace"' "$TD_SRC" || { X3_OK=0; fail "X3: extra-lead LEAD_WORKSPACE pin missing"; }
grep -q 'leadWorkspace: ($slotdir + "/extra-leads/slot-" + (.slotId | tostring) + "/lead-workspace")' "$TD_SRC" \
  || { X3_OK=0; fail "X3: campaign manifest leadWorkspace not under extra-leads dir"; }
# Both Lead env blocks carry the full -u leak-clear set.
[[ "$(grep -c -- '-u LEAD_WORKSPACE' "$TD_SRC")" -ge 2 ]] || { X3_OK=0; fail "X3: -u LEAD_WORKSPACE missing from a Lead env block"; }
[[ "$(grep -c -- '-u CLAUDE_CONFIG_DIR' "$TD_SRC")" -ge 2 ]] || { X3_OK=0; fail "X3: -u CLAUDE_CONFIG_DIR missing from a Lead env block"; }
[[ "$X3_OK" == "1" ]] && pass "X3: extra-lead sanitize + manifest leadWorkspace sentinels"

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]] || exit 1
