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
EXTRA_SLOT=30; LEAD_SLOT=31; NOLEAD_SLOT=32
# Per-process high ports keep repeated/parallel hermetic runs independent. A
# force-stopped prior test must not make a new run accept its orphan listener.
FIXTURE_PORT_BASE=$((20000 + ($$ % 5000)))
LEAD_PORT=$FIXTURE_PORT_BASE
NOLEAD_PORT=$((FIXTURE_PORT_BASE + 1))
cleanup() {
  # Kill any stub leads / stub bridges we started, release fixture locks.
  pkill -f "fly1389-stub-lead-marker" 2>/dev/null || true
  pkill -f "fly1389-stub-bridge-marker" 2>/dev/null || true
  rm -rf "/tmp/flywheel-test-slot-${EXTRA_SLOT}.lock" "/tmp/flywheel-test-slot-${LEAD_SLOT}.lock" "/tmp/flywheel-test-slot-${NOLEAD_SLOT}.lock" \
    "/tmp/flywheel-test-slot-${EXTRA_SLOT}" "/tmp/flywheel-test-slot-${LEAD_SLOT}" "/tmp/flywheel-test-slot-${NOLEAD_SLOT}" "$SB"
}
trap cleanup EXIT

# Fake repo: real test-deploy/test-teardown + real libs + stub claude-lead.
FR="$SB/repo"
mkdir -p "$FR/scripts/lib" "$FR/packages/teamlead/scripts" \
  "$FR/packages/flywheel-comm" "$FR/packages/inbox-mcp" \
  "$FR/packages/edge-worker/dist" \
  "$FR/node_modules/.pnpm/better-sqlite3@11.0.0/node_modules/better-sqlite3/build/Release"
cp "${SCRIPT_DIR}/test-deploy.sh" "${SCRIPT_DIR}/test-teardown.sh" "$FR/scripts/"
cp "${SCRIPT_DIR}/lib/qa-room.sh" \
  "${SCRIPT_DIR}/lib/qa-multilead.sh" \
  "${SCRIPT_DIR}/lib/qa-generalized.sh" \
  "${SCRIPT_DIR}/lib/qa-launchd-lead.sh" \
  "${SCRIPT_DIR}/lib/cmux-mutator-process-census.sh" \
  "${SCRIPT_DIR}/lib/runner-workspace-trust.sh" \
  "$FR/scripts/lib/"
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
pwd > "$SD/lead-cwd.txt"
echo $$ > "$SD/lead-shell-pid.txt"
mkdir -p "$HOME/.flywheel/pids" "$HOME/.flywheel/comm/$PROJ"
echo $$ > "$HOME/.flywheel/pids/$PROJ-$AGENT.pid"
printf '{"pid": %s}\n' $$ > "$HOME/.flywheel/comm/$PROJ/.inbox-ready-$AGENT"
# FLY-1608 campaign-abort fixture: the extra Lead records its true process
# identity/cwd/env above but deliberately withholds readiness. test-deploy must
# kill exactly this supervisor PID through its own failure path.
if [[ "$AGENT" == "flywheel-test-30" ]]; then
  rm -f "$HOME/.flywheel/comm/$PROJ/.inbox-ready-$AGENT"
fi
sleep 300
STUBLEAD
chmod +x "$FR/packages/teamlead/scripts/claude-lead.sh"

# Thin carrier fixture: launchctl starts this exact process. It projects the
# manifest environment, publishes launchd PID/socket evidence, then emulates
# the real body readiness contract without invoking resident lifecycle code.
cat > "$FR/scripts/flywheel-lead-wrapper-v2.sh" <<'STUBCARRIER'
#!/bin/bash
# fly1389-stub-lead-marker
set -euo pipefail
MANIFEST="$1"
AGENT=$(jq -r '.leadId' "$MANIFEST")
PROJ=$(jq -r '.projectName' "$MANIFEST")
PROJECTS_FILE=$(jq -r '.projectsFile' "$MANIFEST")
LEAD_ROW=$(jq -cer --arg project "$PROJ" --arg agent "$AGENT" '
  [.[] | select(.projectName == $project) | .leads[]? | select(.agentId == $agent)]
  | if length == 1 then .[0] else error("expected exactly one canonical Lead row") end
' "$PROJECTS_FILE")
TOKEN_ENV=$(jq -r '.botTokenEnv' <<<"$LEAD_ROW")
if jq -e --arg name "$TOKEN_ENV" '.launchEnvironment | has($name)' \
    "$MANIFEST" >/dev/null; then
  echo "identity_launch_env_conflict $TOKEN_ENV may not be supplied by the manifest" >&2
  exit 86
fi
while IFS=$'\t' read -r name value; do
  printf -v "$name" '%s' "$value"
  export "$name"
done < <(jq -r '.launchEnvironment | to_entries[] | [.key,.value] | @tsv' "$MANIFEST")
source "$FLYWHEEL_WRAPPER_ENV_FILE"
export FLYWHEEL_LEAD_ID="$AGENT"
export LEAD_ID="$AGENT"
export FLYWHEEL_PROJECT_NAME="$PROJ"
export PROJECT_NAME="$PROJ"
export FLYWHEEL_LEAD_KEY="${PROJ}-${AGENT}"
export FLYWHEEL_LEAD_ROLE="$(jq -r '.role // "lead"' <<<"$LEAD_ROW")"
export FLYWHEEL_LEAD_BACKEND="$(jq -r '.backend // "claude-code"' <<<"$LEAD_ROW")"
export DISCORD_STATE_DIR="$(jq -r '.discordStateDir' <<<"$LEAD_ROW")"
export DISCORD_EXPECTED_BOT_USER_ID="$(jq -r '.botUserId' <<<"$LEAD_ROW")"
export DISCORD_IDENTITY_MODE=managed
export DISCORD_BOT_TOKEN="${!TOKEN_ENV:-}"
SOCKET="/tmp/fly1389-${AGENT}.sock"
TMP_MANIFEST="${MANIFEST}.tmp.$$"
jq --arg socket "$SOCKET" --argjson pid "$$" '. + {pid:$pid,socketPath:$socket}' \
  "$MANIFEST" > "$TMP_MANIFEST" && mv "$TMP_MANIFEST" "$MANIFEST"
SD="$(dirname "$DISCORD_STATE_DIR")"
cd "$(dirname "$0")/../packages/teamlead"
env | sort > "$SD/lead-env.txt"
pwd > "$SD/lead-cwd.txt"
echo $$ > "$SD/lead-shell-pid.txt"
mkdir -p "$HOME/.flywheel/comm/$PROJ"
if [[ "$AGENT" != "flywheel-test-30" ]]; then
  printf '{"pid": %s}\n' $$ > "$HOME/.flywheel/comm/$PROJ/.inbox-ready-$AGENT"
fi
sleep 300
STUBCARRIER
chmod +x "$FR/scripts/flywheel-lead-wrapper-v2.sh"

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
if [[ "$*" == *"capture-pane"* ]]; then echo "Loading development channels"; exit 0; fi
if [[ "$*" == *"has-session"* ]]; then exit 0; fi
case "$1" in
  list-windows) [ -n "${TMUX_STUB_WINDOW:-}" ] && echo "@1 ${TMUX_STUB_WINDOW}"; exit 0 ;;
  capture-pane) echo "Loading development channels"; exit 0 ;;
esac
exit 0
EOF
cat > "$STUB_BIN/launchctl" <<'LAUNCHCTL'
#!/bin/bash
set -euo pipefail
state="${FLY1389_LAUNCHCTL_STATE:?}"
mkdir -p "$state"
case "$1" in
  bootstrap)
    plist="$3"
    python3 - "$plist" "$state" <<'PY'
import os, plistlib, subprocess, sys
plist, state = sys.argv[1:]
with open(plist, "rb") as f:
    job = plistlib.load(f)
env = {"PATH": os.environ["PATH"], "TMPDIR": os.environ.get("TMPDIR", "/tmp")}
env.update(job.get("EnvironmentVariables", {}))
log_path = job.get("StandardOutPath", os.devnull)
log = open(log_path, "ab", buffering=0)
p = subprocess.Popen(job["ProgramArguments"], env=env, stdin=subprocess.DEVNULL,
                     stdout=log, stderr=log, start_new_session=True)
with open(os.path.join(state, job["Label"] + ".pid"), "w") as f: f.write(str(p.pid))
PY
    ;;
  print)
    label="${2##*/}"; pid_file="$state/$label.pid"
    [ -f "$pid_file" ] || exit 113
    pid=$(cat "$pid_file")
    kill -0 "$pid" 2>/dev/null || exit 113
    printf 'pid = %s\n' "$pid"
    ;;
  bootout)
    label="${2##*/}"; pid_file="$state/$label.pid"
    if [ -f "$pid_file" ]; then
      pid=$(cat "$pid_file")
      kill "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 0.05; done
      kill -9 "$pid" 2>/dev/null || true
      unlink "$pid_file" 2>/dev/null || true
    fi
    ;;
  *) exit 64 ;;
esac
LAUNCHCTL
chmod +x "$STUB_BIN"/*

# Fake HOME #1 (Lead-ful): identity + shared rules present.
FH1="$SB/home1"
mkdir -p "$FH1/.flywheel/claude-sessions" \
  "$FH1/Dev/GeoForge3D/.lead/product-lead" "$FH1/Dev/GeoForge3D/.lead/ops-lead" "$FH1/Dev/GeoForge3D/.lead/shared"
echo "# prod identity fixture" > "$FH1/Dev/GeoForge3D/.lead/product-lead/identity.md"
echo "# ops identity fixture" > "$FH1/Dev/GeoForge3D/.lead/ops-lead/identity.md"
echo "# shared rule fixture" > "$FH1/Dev/GeoForge3D/.lead/shared/dept.md"
# Fake HOME #2 (--no-lead): NO ~/Dev/GeoForge3D at all.
FH2="$SB/home2"
mkdir -p "$FH2/.flywheel/claude-sessions"

make_slots_json() {  # <file> — slots 30/31/32 carry real fixture values
  jq -n --argjson leadPort "$LEAD_PORT" --argjson noLeadPort "$NOLEAD_PORT" '
    { guildId: "g-fixture",
      slots: ( [range(1;30)] | map({
          id: ., bridgePort: (20000 + .), botName: ("dummy-\(.)"),
          tokenEnvVar: ("DUMMY_TOKEN_\(.)"), botAppId: ("d\(.)"),
          channelId: ("dchan-\(.)"), role: "lead"
        })
        + [ { id: 30, bridgePort: ($leadPort + 2), botName: "flywheel-test-30",
              tokenEnvVar: "TEST_BOT_TOKEN_30", botAppId: "3030",
              channelId: "chan-30", role: "ops", identitySource: "ops-lead" },
            { id: 31, bridgePort: $leadPort, botName: "flywheel-test-31",
              tokenEnvVar: "TEST_BOT_TOKEN_31", botAppId: "3131",
              channelId: "chan-31", role: "lead", identitySource: "product-lead" },
            { id: 32, bridgePort: $noLeadPort, botName: "flywheel-test-32",
              tokenEnvVar: "TEST_BOT_TOKEN_32", botAppId: "3232",
              channelId: "chan-32", role: "lead", identitySource: "product-lead" } ] )
    }'
}
for H in "$FH1" "$FH2"; do
  make_slots_json > "$H/.flywheel/test-slots.json"
  cat > "$H/.flywheel/.env" <<'EOF'
TEST_BOT_TOKEN_31=tok-31
TEST_BOT_TOKEN_32=tok-32
TEST_BOT_TOKEN_30=tok-30
LINEAR_API_KEY=fixture-linear-key
EOF
done

run_deploy() {  # <home> <slot> <stdout-file> <stderr-file> [extra args...]
  local home="$1" slot="$2" out="$3" err="$4"; shift 4
  local caller_cwd="${FLY1608_DEPLOY_CALLER_CWD:-$SB}"
  ( cd "$caller_cwd" && \
    env -i \
      HOME="$home" \
      PATH="$STUB_BIN:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v git)"):$(dirname "$(command -v jq)"):$(dirname "$(command -v python3)"):$(dirname "$(command -v curl)")" \
      TMPDIR=/tmp \
      TMUX_STUB_LOG="$home/tmux-calls.log" \
      TMUX_STUB_WINDOW="" \
      FLY1389_LAUNCHCTL_STATE="$SB/launchctl-state" \
      FLYWHEEL_QA_LAUNCHCTL="$STUB_BIN/launchctl" \
      FLYWHEEL_QA_LEAD_WRAPPER="$FR/scripts/flywheel-lead-wrapper-v2.sh" \
      FLYWHEEL_QA_TMUX="$STUB_BIN/tmux" \
      FLYWHEEL_QA_LAUNCHD_POLL_INTERVAL=0.01 \
      FLYWHEEL_SANDBOX_REMOTE_URL="$BARE" \
      FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly1389-test-incarnation" \
      LEAD_WORKSPACE="/malicious/prod-workspace" \
      CLAUDE_CONFIG_DIR="/malicious/claude-config" \
      TEST_SKIP_PLUGIN_FORK_CHECK=1 \
      TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="/malicious/claude-config" \
      TEST_LEAD_CLAUDE_CONFIG_DIR="${TEST_LEAD_CLAUDE_CONFIG_DIR:-}" \
      TEST_REPLY_BY_ISSUE="${TEST_REPLY_BY_ISSUE:-}" \
      TEST_API_TOKEN="${TEST_API_TOKEN:-}" \
      FLYWHEEL_LEAD_MODEL="malicious-model" \
      FLYWHEEL_LEAD_EFFORT="malicious-effort" \
      bash "$FR/scripts/test-deploy.sh" "$slot" "$@" \
      > "$out" 2> "$err" )
}

# test-deploy stdout carries a stray `git checkout -B` tracking line before
# the JSON (production shape too — consumers slice from the first '{').
extract_json() { sed -n '/^{/,$p' "$1"; }

run_teardown() {  # <home> <slot>
  local home="$1" slot="$2"
  local out="$SB/teardown-slot-${slot}.stdout.log"
  local err="$SB/teardown-slot-${slot}.stderr.log"
  local rc=0
  ( env -i \
      HOME="$home" \
      PATH="$STUB_BIN:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v git)"):$(dirname "$(command -v jq)")" \
      TMPDIR=/tmp \
      TMUX_STUB_LOG="$home/tmux-calls.log" \
      FLY1389_LAUNCHCTL_STATE="$SB/launchctl-state" \
      FLYWHEEL_QA_LAUNCHCTL="$STUB_BIN/launchctl" \
      FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly1389-test-incarnation" \
      FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$home/cmux-mutator.lock" \
      FLYWHEEL_CMUX_MAINTENANCE_MARKER="$home/cmux-maintenance" \
      FLYWHEEL_CMUX_VIEW_WAL_DIR="$home/cmux-view-wal" \
      bash "$FR/scripts/test-teardown.sh" "$slot" >"$out" 2>"$err" ) || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    printf '[TEST] teardown slot %s stdout (%s):\n' "$slot" "$out" >&2
    cat "$out" >&2
    printf '[TEST] teardown slot %s stderr (%s):\n' "$slot" "$err" >&2
    cat "$err" >&2
  fi
  return "$rc"
}

# A cleanup regression must leave its full subprocess evidence in CI instead
# of collapsing into a later lock assertion with no cause.
TEARDOWN_CENSUS_LIB="$FR/scripts/lib/cmux-mutator-process-census.sh"
TEARDOWN_CENSUS_SAVED="$TEARDOWN_CENSUS_LIB.saved"
TEARDOWN_DIAGNOSTIC="$SB/teardown-missing-census.diagnostic.log"
mv "$TEARDOWN_CENSUS_LIB" "$TEARDOWN_CENSUS_SAVED"
if run_teardown "$FH1" 99 2>"$TEARDOWN_DIAGNOSTIC"; then
  fail "D: teardown fixture should fail when its required census library is missing"
elif [[ -f "$SB/teardown-slot-99.stdout.log" \
    && -f "$SB/teardown-slot-99.stderr.log" \
    && "$(cat "$SB/teardown-slot-99.stderr.log")" == *"required cmux process census library unavailable"* \
    && "$(cat "$TEARDOWN_DIAGNOSTIC")" == *"teardown slot 99 stderr"* \
    && "$(cat "$TEARDOWN_DIAGNOSTIC")" == *"required cmux process census library unavailable"* ]]; then
  pass "D: failed teardown persists and dumps subprocess stdout/stderr"
else
  fail "D: failed teardown did not preserve actionable CI diagnostics" "$(cat "$TEARDOWN_DIAGNOSTIC")"
fi
mv "$TEARDOWN_CENSUS_SAVED" "$TEARDOWN_CENSUS_LIB"

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
  jq -e '.leadCarrier == "launchd-v2" and (.leadLaunchdLabel | startswith("com.flywheel.qa.lead.slot-31.")) and (.leadSocket | length > 0)' \
    <<<"$E_JSON" >/dev/null 2>&1 || { E_OK=0; fail "E: deploy JSON lacks launchd-v2 topology evidence"; }
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
    grep -q "^FLYWHEEL_COMPLETE_MARKER_DIR=${E_SLOT_DIR}/state/complete-failed$" "$LE" \
      || { E_OK=0; fail "E/FLY-1608: complete marker dir not slot-local in Lead env"; }
    grep -q "^FLYWHEEL_IDENTITY_FAILURE_DIR=${E_SLOT_DIR}/state/lead-identity-failures$" "$LE" \
      || { E_OK=0; fail "E/FLY-1726: identity failure marker dir not slot-local in Lead env"; }
    grep -q "^FLYWHEEL_DELIVERY_SECRET_PATH=${E_SLOT_DIR}/state/delivery-secret$" "$LE" \
      || { E_OK=0; fail "E/FLY-1663: Lead delivery secret path not slot-local"; }
  else
    E_OK=0; fail "E: stub Lead env dump missing" "$LE"
  fi
  STUB_LEAD_PID="$(cat "$E_SLOT_DIR/lead-shell-pid.txt" 2>/dev/null || true)"
  LOGGED_LEAD_PID="$(sed -n 's/.*Lead background PID: //p' "$E_ERR" | tail -1)"
  [[ -n "$STUB_LEAD_PID" && "$LOGGED_LEAD_PID" == "$STUB_LEAD_PID" ]] \
    || { E_OK=0; fail "E/FLY-1608: test-deploy PID is not the Lead supervisor" "logged=${LOGGED_LEAD_PID:-missing} stub=${STUB_LEAD_PID:-missing}"; }
  [[ "$(cat "$E_SLOT_DIR/lead-cwd.txt" 2>/dev/null || true)" == "$FR/packages/teamlead" ]] \
    || { E_OK=0; fail "E/FLY-1608: Lead cwd does not mirror production wrapper" "$(cat "$E_SLOT_DIR/lead-cwd.txt" 2>/dev/null || true)"; }
  # P0-d: stale session-id removed before Lead start.
  [[ ! -f "$FH1/.flywheel/claude-sessions/test-slot-${LEAD_SLOT}-flywheel-test-31.session-id" ]] \
    || { E_OK=0; fail "E/P0-d: stale session-id survived deploy"; }
  # P1-a: LIVE Bridge process env carries slot-local bin/hooks dirs.
  BE="$E_SLOT_DIR/bridge-env.txt"
  if [[ -f "$BE" ]]; then
    grep -q "^FLYWHEEL_BIN_DIR=${E_SLOT_DIR}/bin$" "$BE" || { E_OK=0; fail "E/P1-a: FLYWHEEL_BIN_DIR not slot-local in Bridge env"; }
    grep -q "^FLYWHEEL_HOOKS_DIR=${E_SLOT_DIR}/hooks$" "$BE" || { E_OK=0; fail "E/P1-a: FLYWHEEL_HOOKS_DIR not slot-local in Bridge env"; }
    grep -q "^FLYWHEEL_COMPLETE_MARKER_DIR=${E_SLOT_DIR}/state/complete-failed$" "$BE" \
      || { E_OK=0; fail "E/FLY-1608: complete marker dir not slot-local in Bridge env"; }
    grep -q "^FLYWHEEL_LOOP_DIAGNOSTICS_DIR=${E_SLOT_DIR}/state/loop-diagnostics$" "$BE" \
      || { E_OK=0; fail "E/FLY-1995: loop diagnostics dir not slot-local in Bridge env"; }
    grep -q "^FLYWHEEL_DELIVERY_SECRET_PATH=${E_SLOT_DIR}/state/delivery-secret$" "$BE" \
      || { E_OK=0; fail "E/FLY-1663: Bridge delivery secret path not slot-local"; }
    grep -q "^TMUX_TMPDIR=${E_SLOT_DIR}$" "$BE" \
      || { E_OK=0; fail "E/FLY-1999: Bridge tmux socket root not slot-local"; }
    ! grep -q '^TMUX=' "$BE" \
      || { E_OK=0; fail "E/FLY-1999: Bridge inherited a caller tmux coordinate"; }
    ! grep -q '^FLYWHEEL_TMUX_SOCKET_OVERRIDE=' "$BE" \
      || { E_OK=0; fail "E/FLY-1999: QA Bridge retained the split-routing socket override"; }
    grep -q '^TEAMLEAD_DEFAULT_LEAD_AGENT=flywheel-test-31$' "$BE" \
      || { E_OK=0; fail "E/FLY-1726: default Bridge branch lacks canonical default Lead"; }
    grep -q "^FLYWHEEL_PROJECTS_FILE=${E_SLOT_DIR}/flywheel-projects.json$" "$BE" \
      || { E_OK=0; fail "E/FLY-1726: default Bridge branch lacks slot-local canonical registry"; }
  else
    E_OK=0; fail "E: Bridge env dump missing" "$BE"
  fi
  [[ "$E_OK" == "1" ]] && pass "E: Lead-ful E2E — sanitize + cwd/PID parity + marker isolation + noLead=false"
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
if FLY1608_DEPLOY_CALLER_CWD="$FR/packages/teamlead" \
    TEST_REPLY_BY_ISSUE=1 \
    TEST_API_TOKEN="fixture-api-token" \
    TEST_LEAD_CLAUDE_CONFIG_DIR="$I_CONFIG" \
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
  grep -q "^FLYWHEEL_COMPLETE_MARKER_DIR=${I_SLOT_DIR}/state/complete-failed$" "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I: reply-by-issue Bridge lost complete-marker isolation"; }
  grep -q "^FLYWHEEL_LOOP_DIAGNOSTICS_DIR=${I_SLOT_DIR}/state/loop-diagnostics$" "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I: reply-by-issue Bridge lost loop-diagnostics isolation"; }
  grep -q "^TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true$" "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I: fixture did not exercise reply-by-issue Bridge branch"; }
  grep -q '^TEAMLEAD_DEFAULT_LEAD_AGENT=flywheel-test-31$' "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I/FLY-1726: reply-by-issue Bridge branch lacks canonical default Lead"; }
  grep -q "^FLYWHEEL_PROJECTS_FILE=${I_SLOT_DIR}/flywheel-projects.json$" "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I/FLY-1726: reply-by-issue Bridge branch lacks slot-local canonical registry"; }
  [[ "$(cat "$I_SLOT_DIR/state/api-token" 2>/dev/null || true)" == "fixture-api-token" ]] \
    || { I_OK=0; fail "I/FLY-1775: reply-by-issue token was not persisted slot-locally"; }
  [[ "$(stat -c '%a' "$I_SLOT_DIR/state/api-token" 2>/dev/null || stat -f '%Lp' "$I_SLOT_DIR/state/api-token")" == "600" ]] \
    || { I_OK=0; fail "I/FLY-1775: reply-by-issue token file is not mode 0600"; }
  [[ "$(cat "$I_SLOT_DIR/lead-cwd.txt" 2>/dev/null || true)" == "$FR/packages/teamlead" ]] \
    || { I_OK=0; fail "I: package-cwd invocation did not keep production-aligned Lead cwd"; }
  [[ "$I_OK" == "1" ]] \
    && pass "I: package-cwd deploy starts Lead + reply-by-issue Bridge stays marker-isolated"
  run_teardown "$FH1" "$LEAD_SLOT"
else
  fail "I: isolated config deploy failed" "$(tail -20 "$I_ERR")"
  run_teardown "$FH1" "$LEAD_SLOT" || true
fi

# ── C: extra-Lead campaign failure owns the true supervisor PIDs (FLY-1608) ─
rm -rf "/tmp/flywheel-test-slot-${EXTRA_SLOT}.lock" "/tmp/flywheel-test-slot-${LEAD_SLOT}.lock" \
  "/tmp/flywheel-test-slot-${EXTRA_SLOT}" "/tmp/flywheel-test-slot-${LEAD_SLOT}"
C_OUT="$SB/c-out.json"; C_ERR="$SB/c-err.log"
if run_deploy "$FH1" "$LEAD_SLOT" "$C_OUT" "$C_ERR" \
    --extra-lead "${EXTRA_SLOT}:Ops-Test" --lead-ready-timeout 1; then
  fail "C: campaign fixture should abort when extra Lead withholds readiness"
  run_teardown "$FH1" "$LEAD_SLOT" || true
else
  C_OWNER_DIR="/tmp/flywheel-test-slot-${LEAD_SLOT}"
  C_EXTRA_DIR="${C_OWNER_DIR}/extra-leads/slot-${EXTRA_SLOT}"
  C_OK=1
  C_MAIN_PID="$(cat "$C_OWNER_DIR/lead-shell-pid.txt" 2>/dev/null || true)"
  C_EXTRA_PID="$(cat "$C_EXTRA_DIR/lead-shell-pid.txt" 2>/dev/null || true)"
  C_LOGGED_MAIN_PID="$(sed -n 's/.*Lead background PID: //p' "$C_ERR" | tail -1)"
  C_LOGGED_EXTRA_PID="$(sed -n 's/.*Extra Lead flywheel-test-30 background PID: //p' "$C_ERR" | tail -1)"
  [[ -n "$C_MAIN_PID" && "$C_LOGGED_MAIN_PID" == "$C_MAIN_PID" ]] \
    || { C_OK=0; fail "C: owner \$! is not its supervisor" "logged=${C_LOGGED_MAIN_PID:-missing} stub=${C_MAIN_PID:-missing}"; }
  [[ -n "$C_EXTRA_PID" && "$C_LOGGED_EXTRA_PID" == "$C_EXTRA_PID" ]] \
    || { C_OK=0; fail "C: extra \$! is not its supervisor" "logged=${C_LOGGED_EXTRA_PID:-missing} stub=${C_EXTRA_PID:-missing}"; }
  [[ "$(cat "$C_OWNER_DIR/lead-cwd.txt" 2>/dev/null || true)" == "$FR/packages/teamlead" ]] \
    || { C_OK=0; fail "C: owner Lead cwd not production-aligned"; }
  [[ "$(cat "$C_EXTRA_DIR/lead-cwd.txt" 2>/dev/null || true)" == "$FR/packages/teamlead" ]] \
    || { C_OK=0; fail "C: extra Lead cwd not production-aligned"; }
  grep -q "^FLYWHEEL_COMPLETE_MARKER_DIR=${C_OWNER_DIR}/state/complete-failed$" "$C_OWNER_DIR/lead-env.txt" \
    || { C_OK=0; fail "C: owner complete-marker env missing"; }
  grep -q "^FLYWHEEL_COMPLETE_MARKER_DIR=${C_OWNER_DIR}/state/complete-failed$" "$C_EXTRA_DIR/lead-env.txt" \
    || { C_OK=0; fail "C: extra complete-marker env missing"; }
  for dead_pid in "$C_MAIN_PID" "$C_EXTRA_PID"; do
    for _poll in $(seq 1 20); do
      kill -0 "$dead_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$dead_pid" 2>/dev/null \
      && { C_OK=0; fail "C: campaign_abort left Lead alive" "$dead_pid"; }
  done
  [[ "$C_OK" == "1" ]] \
    && pass "C: campaign_abort owns main+extra supervisor PID, cwd, env, and kills both"
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
  jq -e '.leadCarrier == "none"' <<<"$N_JSON" >/dev/null 2>&1 || { N_OK=0; fail "N: no-lead carrier must be none"; }
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
  grep -q "^FLYWHEEL_DELIVERY_SECRET_PATH=${N_SLOT_DIR}/state/delivery-secret$" "$N_SLOT_DIR/bridge-env.txt" \
    || { N_OK=0; fail "N/FLY-1663: no-lead Bridge secret path not slot-local"; }
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

# Extra-lead source sentinels: the v2 manifest builder gets an explicit
# slot-local workspace, and the campaign manifest points at the same path.
# Inherited caller values cannot enter launchd because only the constructed
# launchEnvironment object is rendered into the job.
TD_SRC="${SCRIPT_DIR}/test-deploy.sh"
X3_OK=1
grep -q '"${XDIR}/lead-workspace" "$XLEAD_LOG"' "$TD_SRC" || { X3_OK=0; fail "X3: extra-lead workspace argument missing"; }
grep -q 'leadWorkspace: ($slotdir + "/extra-leads/slot-" + (.slotId | tostring) + "/lead-workspace")' "$TD_SRC" \
  || { X3_OK=0; fail "X3: campaign manifest leadWorkspace not under extra-leads dir"; }
grep -q 'launch_env=$(qa_slot_launch_env_json' "$TD_SRC" \
  || { X3_OK=0; fail "X3: explicit launchEnvironment builder missing"; }
[[ "$X3_OK" == "1" ]] && pass "X3: extra-lead explicit launch env + manifest workspace sentinels"

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]] || exit 1
