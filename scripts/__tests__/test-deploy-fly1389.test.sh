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
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLY1389_REAL_CURL="$(command -v curl)"
FLY1389_REAL_NODE="$(command -v node)"

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
EXTRA_SLOT=30; LEAD_SLOT=31; NOLEAD_SLOT=32; WORKTREE_SLOT=33
CODEX_SLOT=34; CODEX_EXTRA_SLOT=35
WORKER_SENTINEL_PID=""; DAEMON_SENTINEL_PID=""; TMUX_SENTINEL_PID=""
# Per-process high ports keep repeated/parallel hermetic runs independent. A
# force-stopped prior test must not make a new run accept its orphan listener.
FIXTURE_PORT_BASE=$((20000 + ($$ % 5000)))
LEAD_PORT=$FIXTURE_PORT_BASE
NOLEAD_PORT=$((FIXTURE_PORT_BASE + 1))
cleanup() {
  # Kill any stub leads / stub bridges we started, release fixture locks.
  for pid in "$WORKER_SENTINEL_PID" "$DAEMON_SENTINEL_PID" "$TMUX_SENTINEL_PID"; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill "$pid" 2>/dev/null || true
  done
  pkill -f "fly1389-stub-lead-marker" 2>/dev/null || true
  pkill -f "fly1389-stub-bridge-marker" 2>/dev/null || true
  rm -rf "/tmp/flywheel-test-slot-${EXTRA_SLOT}.lock" "/tmp/flywheel-test-slot-${LEAD_SLOT}.lock" "/tmp/flywheel-test-slot-${NOLEAD_SLOT}.lock" "/tmp/flywheel-test-slot-${WORKTREE_SLOT}.lock" \
    "/tmp/flywheel-test-slot-${CODEX_SLOT}.lock" "/tmp/flywheel-test-slot-${CODEX_EXTRA_SLOT}.lock" \
    "/tmp/flywheel-test-slot-${EXTRA_SLOT}" "/tmp/flywheel-test-slot-${LEAD_SLOT}" "/tmp/flywheel-test-slot-${NOLEAD_SLOT}" "/tmp/flywheel-test-slot-${WORKTREE_SLOT}" \
    "/tmp/flywheel-test-slot-${CODEX_SLOT}" "/tmp/flywheel-test-slot-${CODEX_EXTRA_SLOT}" "$SB"
}
trap cleanup EXIT

# Fake repo: real test-deploy/test-teardown + real libs + stub claude-lead.
FR="$SB/repo"
mkdir -p "$FR/scripts/lib" "$FR/packages/teamlead/scripts" \
  "$FR/packages/flywheel-comm" "$FR/packages/inbox-mcp" \
  "$FR/packages/edge-worker/dist" \
  "$FR/node_modules/.pnpm/better-sqlite3@11.0.0/node_modules/better-sqlite3/build/Release"
cp "${SCRIPT_DIR}/test-deploy.sh" "${SCRIPT_DIR}/test-teardown.sh" \
  "${SCRIPT_DIR}/test-cycle-bridge.sh" "$FR/scripts/"
cp "${SCRIPT_DIR}/lib/qa-room.sh" \
  "${SCRIPT_DIR}/lib/qa-multilead.sh" \
  "${SCRIPT_DIR}/lib/qa-generalized.sh" \
  "${SCRIPT_DIR}/lib/qa-launchd-lead.sh" \
  "${SCRIPT_DIR}/lib/qa-lead-artifacts.sh" \
  "${SCRIPT_DIR}/lib/qa-launchd-env.py" \
  "${SCRIPT_DIR}/lib/qa-codex-lead-render.py" \
  "${SCRIPT_DIR}/lib/qa-codex-lead-wrapper.template.sh" \
  "${SCRIPT_DIR}/lib/bounded-run.sh" \
  "${SCRIPT_DIR}/lib/qa-report-host.mjs" \
  "${SCRIPT_DIR}/lib/qa-report-host-bridge-wrapper.sh" \
  "${SCRIPT_DIR}/lib/qa-slot-bridge.sh" \
  "${SCRIPT_DIR}/lib/qa-slot-bridge-spec.mjs" \
  "${SCRIPT_DIR}/lib/cmux-mutator-process-census.sh" \
  "${SCRIPT_DIR}/lib/runner-workspace-trust.sh" \
  "$FR/scripts/lib/"
echo "// fixture" > "$FR/scripts/run-bridge.ts"
echo "FLYWHEEL_RUNNER_START_POINT fixture" > "$FR/packages/edge-worker/dist/WorktreeManager.js"
echo "fake-binding" > "$FR/node_modules/.pnpm/better-sqlite3@11.0.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
cat > "$FR/scripts/lib/qa-reap-codex-slot-daemons.mjs" <<'REAPSTUB'
// This fixture starts no Bridge-owned codex-tmux worker daemon. The separate
// launchd Codex Lead daemon is exercised and reaped through launchd-leads.json.
process.exit(0);
REAPSTUB

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
MANIFEST_PROJECTS_FILE=$(jq -r '.launchEnvironment.FLYWHEEL_PROJECTS_FILE // empty' "$MANIFEST")
if [[ "$MANIFEST_PROJECTS_FILE" != "$PROJECTS_FILE" ]]; then
  echo "identity_launch_env_conflict FLYWHEEL_PROJECTS_FILE expected '$PROJECTS_FILE', got '$MANIFEST_PROJECTS_FILE'" >&2
  exit 86
fi
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

# Codex carrier fixture: keep the real public launcher + canonical resolver.
# The home/daemon adapter and final Node runtime are bounded fakes so the E2E
# can prove launchd, env, tmux, heartbeat, KeepAlive, and teardown without a
# Codex network session.
mkdir -p "$FR/packages/teamlead/scripts/lib" \
  "$FR/packages/teamlead/dist/lead-backends/codex" \
  "$FR/packages/teamlead/lead-rules-base" \
  "$FR/packages/flywheel-comm/node_modules" \
  "$FR/packages/inbox-mcp/node_modules"
cp "${SCRIPT_DIR}/../packages/teamlead/scripts/codex-lead.sh" \
  "$FR/packages/teamlead/scripts/codex-lead.sh"
cp "${SCRIPT_DIR}/../packages/teamlead/scripts/lib/canonical-lead-identity.sh" \
  "$FR/packages/teamlead/scripts/lib/canonical-lead-identity.sh"
ln -s "${SCRIPT_DIR}/../packages/flywheel-comm/dist" \
  "$FR/packages/flywheel-comm/dist"
ln -s "${SCRIPT_DIR}/../packages/flywheel-comm/node_modules/better-sqlite3" \
  "$FR/packages/flywheel-comm/node_modules/better-sqlite3"
ln -s "${SCRIPT_DIR}/../packages/inbox-mcp/node_modules/better-sqlite3" \
  "$FR/packages/inbox-mcp/node_modules/better-sqlite3"
cat > "$FR/scripts/host-tmux-selection-gate.sh" <<'HOSTGATE'
#!/bin/bash
exit 0
HOSTGATE
chmod +x "$FR/scripts/host-tmux-selection-gate.sh"
cp "${SCRIPT_DIR}/../packages/teamlead/scripts/codex-lead-tui-home.sh" \
  "$FR/packages/teamlead/scripts/codex-lead-tui-home-real.sh"
cat > "$FR/packages/teamlead/scripts/codex-lead-tui-home.sh" <<'TUIHOME'
#!/bin/bash
set -euo pipefail
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  source "$(dirname "${BASH_SOURCE[0]}")/codex-lead-tui-home-real.sh"
  return
fi
home="${FLYWHEEL_CODEX_TUI_HOME:?}"
case "${1:-}" in
  ensure-home)
    [[ -f "$home/auth.json" && -x "$home/packages/standalone/current/codex" ]]
    ;;
  ensure-daemon)
    CODEX_HOME="$home" "${FLYWHEEL_CODEX_BIN:?}" remote-control start --json
    ;;
  *) exit 64 ;;
esac
TUIHOME
chmod +x "$FR/packages/teamlead/scripts/codex-lead-tui-home.sh"
cat > "$FR/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js" <<'CODEXRUNTIME'
const { execFileSync } = require("node:child_process");
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");

const required = [
  "FLYWHEEL_CANONICAL_IDENTITY_RESOLVED", "FLYWHEEL_LEAD_ID",
  "FLYWHEEL_PROJECT_NAME", "FLYWHEEL_LEAD_KEY", "FLYWHEEL_LEAD_BACKEND",
  "FLYWHEEL_PROJECTS_FILE", "FLYWHEEL_CODEX_LEAD_STATE_DIR", "CODEX_HOME",
  "DISCORD_BOT_TOKEN", "FLYWHEEL_LEAD_CHAT_CHANNEL_ID",
];
for (const key of required) {
  if (!process.env[key]) throw new Error(`missing canonical env ${key}`);
}
if (process.env.FLYWHEEL_CANONICAL_IDENTITY_RESOLVED !== "1" ||
    process.env.FLYWHEEL_LEAD_BACKEND !== "codex-app-server") {
  throw new Error("canonical identity did not resolve to Codex");
}
const project = process.env.FLYWHEEL_PROJECT_NAME;
const lead = process.env.FLYWHEEL_LEAD_ID;
const row = JSON.parse(readFileSync(process.env.FLYWHEEL_PROJECTS_FILE, "utf8"))[0]
  .leads.filter((candidate) => candidate.agentId === lead);
if (row.length !== 1 || row[0].backend !== "codex-app-server" ||
    row[0].chatChannel !== process.env.FLYWHEEL_LEAD_CHAT_CHANNEL_ID) {
  throw new Error("projects row drift");
}

const tmux = "tmux";
const session = "=flywheel";
const window = `${project}-${lead}`;
const tmuxCall = (...args) => execFileSync(tmux, args, { stdio: "ignore" });
const tmuxText = (...args) => execFileSync(tmux, args, { encoding: "utf8" });
try {
  tmuxCall("has-session", "-t", session);
  const names = tmuxText("list-windows", "-t", session, "-F", "#{window_name}")
    .trim().split("\n").filter(Boolean);
  if (names.includes(window)) {
    if (names.length === 1) tmuxCall("kill-session", "-t", session);
    else tmuxCall("kill-window", "-t", `${session}:${window}`);
  }
} catch {}
try {
  tmuxCall("has-session", "-t", session);
  tmuxCall("new-window", "-d", "-t", session, "-n", window, "sleep", "300");
} catch {
  tmuxCall("new-session", "-d", "-s", "flywheel", "-n", window, "sleep", "300");
}

const brain = join(process.env.FLYWHEEL_CODEX_LEAD_STATE_DIR, "brain");
mkdirSync(brain, { recursive: true, mode: 0o700 });
const heartbeat = join(brain, "heartbeat.json");
const generationId = randomUUID();
const carrierInstanceId = randomUUID();
const publish = (state) => {
  const tmp = `${heartbeat}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({
    v: 1, processPid: process.pid, generationId, threadId: `thread-${lead}`,
    carrierInstanceId, updatedAt: new Date().toISOString(), state,
  }) + "\n", { mode: 0o600 });
  renameSync(tmp, heartbeat);
};
publish("online");
const runtimeEvidence = join(process.env.FLYWHEEL_STATE_DIR, "codex-runtime-env.json");
writeFileSync(runtimeEvidence, JSON.stringify(Object.fromEntries(
  required.map((key) => [key, key === "DISCORD_BOT_TOKEN" ? "[present]" : process.env[key]])
) , null, 2) + "\n", { mode: 0o600 });

const stop = () => {
  try { publish("shutdown"); } catch {}
  try { tmuxCall("kill-window", "-t", `${session}:${window}`); } catch {}
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => publish("online"), 250).unref();
setInterval(() => {}, 60_000);
CODEXRUNTIME

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
cat > "$STUB_BIN/curl" <<'EOF'
#!/bin/bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    https://discord.com/api/v10/channels/*)
      printf '200'
      exit 0
      ;;
  esac
done
exec "${FLY1389_REAL_CURL:?}" "$@"
EOF
cat > "$STUB_BIN/npx" <<'EOF'
#!/bin/bash
# fly1389-stub-bridge-marker — persistent wrapper for a real three-level tree.
set -u
SLOT_DIR="$(dirname "${TEAMLEAD_DB_PATH:?}")"
STUB_DIR="$(cd "$(dirname "$0")" && pwd)"
BOOT_FILE="$SLOT_DIR/bridge-boot-count"
BOOT=$(( $(cat "$BOOT_FILE" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$BOOT" > "$BOOT_FILE"
printf '%s\n' "$$" > "$SLOT_DIR/bridge-wrapper.pid"
printf 'fly1389 boot-%s wrapper=%s\n' "$BOOT" "$$"
env | sort > "$SLOT_DIR/bridge-env.txt"
"${FLY1389_ENV_DUMP_NODE:?}" - "$SLOT_DIR/bridge-env.json" "$SLOT_DIR/bridge-env-${BOOT}.json" <<'NODE'
const fs = require("node:fs");
const value = JSON.stringify(process.env);
fs.writeFileSync(process.argv[2], value);
fs.writeFileSync(process.argv[3], value);
NODE
on_term() {
  printf '%s\t%s\twrapper\n' "$BOOT" "$$" >> "$SLOT_DIR/bridge-term.log"
  printf 'fly1389 term-%s wrapper=%s\n' "$BOOT" "$$"
  exit 0
}
trap on_term TERM
"$STUB_DIR/fly1389-tsx-intermediate" scripts/run-bridge.ts "$BOOT" &
CHILD=$!
wait "$CHILD"
exit $?
EOF
cat > "$STUB_BIN/fly1389-tsx-intermediate" <<'EOF'
#!/bin/bash
set -u
# argv intentionally carries only the repo-relative form under test.
RELATIVE_SCRIPT="${1:?relative script required}"
BOOT="${2:?boot required}"
SLOT_DIR="$(dirname "${TEAMLEAD_DB_PATH:?}")"
STUB_DIR="$(cd "$(dirname "$0")" && pwd)"
printf '%s\n' "$$" > "$SLOT_DIR/bridge-intermediate.pid"
printf '%s\n' "$RELATIVE_SCRIPT" > "$SLOT_DIR/bridge-intermediate-argv.txt"
on_term() {
  printf '%s\t%s\tintermediate\n' "$BOOT" "$$" >> "$SLOT_DIR/bridge-term.log"
  exit 0
}
trap on_term TERM
"$STUB_DIR/fly1389-listener" "$BOOT" &
CHILD=$!
wait "$CHILD"
exit $?
EOF
cat > "$STUB_BIN/fly1389-listener" <<'EOF'
#!/bin/bash
set -u
BOOT="${1:?boot required}"
SLOT_DIR="$(dirname "${TEAMLEAD_DB_PATH:?}")"
# The exec'd listener argv deliberately contains loader flags only and no
# run-bridge.ts bytes, mirroring the real tsx worker process.
exec python3 -c '
import json, os, signal, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
boot, slot_dir = sys.argv[1], sys.argv[2]
with open(os.path.join(slot_dir, "bridge-listener.pid"), "w") as f: f.write(str(os.getpid()) + "\n")
with open(os.path.join(slot_dir, "bridge-listener.cwd"), "w") as f: f.write(os.getcwd() + "\n")
with open(os.path.join(slot_dir, "bridge-listener-argv.json"), "w") as f: json.dump(sys.argv, f)
def term(_sig, _frame):
    with open(os.path.join(slot_dir, "bridge-term.log"), "a") as f:
        f.write(f"{boot}\t{os.getpid()}\tlistener\n")
    raise SystemExit(0)
signal.signal(signal.SIGTERM, term)
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *args): pass
HTTPServer(("127.0.0.1", int(os.environ["TEAMLEAD_PORT"])), H).serve_forever()
' "$BOOT" "$SLOT_DIR" --require preflight.cjs --import loader.mjs
EOF
cat > "$STUB_BIN/ps" <<'EOF'
#!/bin/bash
# The Codex workspace sandbox denies /bin/ps. Keep the fixture's start-identity
# seam deterministic, and derive PPIDs from the real process IDs each level
# publishes. Independent lsof assertions below prove those published edges are
# the actual live OS parent chain before the public cycle command is invoked.
set -u
FORMAT=""
PID=""
[[ -z "${FLY1389_PS_LOG:-}" ]] || printf 'argv:%q ' "$@" >> "$FLY1389_PS_LOG"
[[ -z "${FLY1389_PS_LOG:-}" ]] || printf '\n' >> "$FLY1389_PS_LOG"
if [[ "$*" == "-ww -axo pid=,command=" ]]; then
  exit 0
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) FORMAT="${2:?format required}"; shift 2 ;;
    -p) PID="${2:?pid required}"; shift 2 ;;
    eww) shift ;;
    *) shift ;;
  esac
done
[[ "$PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$PID" 2>/dev/null || exit 1
case "$FORMAT" in
  lstart=)
    printf 'Thu Jan  1 00:00:00 1970 fixture-pid-%s\n' "$PID"
    ;;
  ppid=)
    for slot_dir in /tmp/flywheel-test-slot-*; do
      [[ -d "$slot_dir" ]] || continue
      listener="$(cat "$slot_dir/bridge-listener.pid" 2>/dev/null || true)"
      intermediate="$(cat "$slot_dir/bridge-intermediate.pid" 2>/dev/null || true)"
      wrapper="$(cat "$slot_dir/bridge-wrapper.pid" 2>/dev/null || true)"
      if [[ "$PID" == "$listener" ]]; then printf '%s\n' "$intermediate"; exit 0; fi
      if [[ "$PID" == "$intermediate" ]]; then printf '%s\n' "$wrapper"; exit 0; fi
    done
    exit 1
    ;;
  pgid=)
    # qa-slot-bridge-spec launches every Bridge in a PID-equal isolated group.
    printf '%s\n' "$PID"
    ;;
  stat=|state=)
    printf 'S\n'
    ;;
  command=)
    if [[ -n "${FLY1389_CODEX_RUNTIME:-}" ]]; then
      codex_home=""
      label=""
      for pid_file in "${FLY1389_LAUNCHCTL_STATE:-/nonexistent}"/*.pid; do
        [[ -f "$pid_file" && "$(cat "$pid_file")" == "$PID" ]] || continue
        label="$(basename "$pid_file" .pid)"
        break
      done
      if [[ -n "$label" ]]; then
        for registry in /tmp/flywheel-test-slot-*/launchd-leads.json; do
          [[ -f "$registry" ]] || continue
          codex_home=$(jq -r --arg label "$label" \
            '.[] | select(.label == $label) | .codexHome // empty' "$registry" 2>/dev/null | head -1)
          [[ -z "$codex_home" ]] || break
        done
      fi
      [[ -z "${FLY1389_PS_LOG:-}" ]] \
        || printf 'pid=%s label=%s home=%s\n' "$PID" "$label" "$codex_home" >> "$FLY1389_PS_LOG"
      printf '%s %s' "${FLY1389_REAL_NODE:?}" "$FLY1389_CODEX_RUNTIME"
      [[ -z "$codex_home" ]] || printf ' CODEX_HOME=%s' "$codex_home"
      printf '\n'
    else
      exit 64
    fi
    ;;
  *) exit 64 ;;
esac
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
job_live() {
  local pid="$1" process_state
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null || return 1
  process_state=$(/bin/ps -o stat= -p "$pid" 2>/dev/null || true)
  process_state="${process_state#${process_state%%[![:space:]]*}}"
  [[ -z "$process_state" || "${process_state:0:1}" != Z ]]
}
stop_job() {
  local label="$1" pid_file="$state/$label.pid" pid
  if [[ -f "$pid_file" ]]; then
    pid=$(cat "$pid_file" 2>/dev/null || true)
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
      kill -TERM -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 100); do
        job_live "$pid" || break
        sleep 0.01
      done
      kill -KILL -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
}
spawn_job() {
  local label="$1" plist_file="$state/$label.plist-path" plist
  [[ -f "$plist_file" ]] || return 113
  plist=$(cat "$plist_file")
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
tmp = os.path.join(state, job["Label"] + ".pid.tmp")
with open(tmp, "w") as f: f.write(str(p.pid))
os.replace(tmp, os.path.join(state, job["Label"] + ".pid"))
PY
}
case "$1" in
  bootstrap)
    plist="$3"
    label=$(python3 - "$plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], "rb") as stream:
    print(plistlib.load(stream)["Label"])
PY
    )
    printf '%s\n' "$plist" > "$state/$label.plist-path"
    spawn_job "$label"
    ;;
  print)
    label="${2##*/}"; pid_file="$state/$label.pid"
    if [[ -f "$pid_file" ]]; then pid=$(cat "$pid_file"); else pid=""; fi
    if ! job_live "$pid"; then
      rm -f "$pid_file"
      spawn_job "$label" || exit 113
      pid=$(cat "$pid_file")
      job_live "$pid" || exit 113
    fi
    printf 'pid = %s\n' "$pid"
    ;;
  bootout)
    label="${2##*/}"
    rm -f "$state/$label.plist-path"
    stop_job "$label"
    ;;
  kickstart)
    label="${3##*/}"
    stop_job "$label"
    spawn_job "$label"
    ;;
  *) exit 64 ;;
esac
LAUNCHCTL
chmod +x "$STUB_BIN"/*

# Codex E2E tools keep the test stubs for network/build/Bridge work, but expose
# the real node and tmux so the launcher's argv and private socket are genuine.
CODEX_TOOL_BIN="$SB/codex-tool-bin"
mkdir -p "$CODEX_TOOL_BIN"
for tool in gh pnpm npx curl launchctl ps; do
  ln -s "$STUB_BIN/$tool" "$CODEX_TOOL_BIN/$tool"
done

# A second real repo layout exercises the path class production intentionally
# excludes from its restart helper. The slot cycle must own this QA worktree.
FWR="$SB/worktrees/fly-2237"
mkdir -p "$(dirname "$FWR")"
cp -R "$FR" "$FWR"

# Codex source homes are login-bearing inputs only. The deploy must mint a
# separate home beneath the slot before any launcher sees one of these paths.
CODEX_SOURCE_MAIN="$SB/codex-source-main"
CODEX_SOURCE_EXTRA="$SB/codex-source-extra"
for source_home in "$CODEX_SOURCE_MAIN" "$CODEX_SOURCE_EXTRA"; do
  mkdir -p "$source_home/packages/standalone/releases/fixture"
  printf '%s\n' '{"tokens":{"access_token":"fixture"}}' > "$source_home/auth.json"
  cat > "$source_home/packages/standalone/releases/fixture/codex" <<'CODEXBIN'
#!/bin/bash
set -euo pipefail
home="${CODEX_HOME:?}"
socket="$home/app-server-control/app-server-control.sock"
pid_file="$home/app-server-daemon/app-server.pid"
read_pid_record() {
  python3 - "$pid_file" <<'PY' 2>/dev/null
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    value = json.load(stream)
pid = value.get("pid") if isinstance(value, dict) else None
if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
    raise SystemExit(1)
print(pid)
PY
}
case "${1:-} ${2:-}" in
  "remote-control start")
    if [[ -f "$pid_file" ]]; then
      old_pid=$(read_pid_record || true)
      if [[ "$old_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$old_pid" 2>/dev/null && [[ -S "$socket" ]]; then
        printf '%s\n' '{"status":"connected"}'
        exit 0
      fi
    fi
    mkdir -p "$(dirname "$socket")" "$(dirname "$pid_file")"
    python3 - "$socket" <<'PY' >/dev/null 2>&1 &
import os, signal, socket, sys, time
path = sys.argv[1]
try: os.unlink(path)
except FileNotFoundError: pass
server = socket.socket(socket.AF_UNIX)
server.bind(path)
server.listen(1)
def stop(*_):
    server.close()
    try: os.unlink(path)
    except FileNotFoundError: pass
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while True: time.sleep(1)
PY
    daemon_pid=$!
    printf '{"pid":%s,"processStartTime":"fixture"}\n' "$daemon_pid" > "$pid_file"
    for _ in $(seq 1 100); do [[ -S "$socket" ]] && break; sleep 0.01; done
    [[ -S "$socket" ]]
    printf '%s\n' '{"status":"started"}'
    ;;
  "remote-control stop")
    daemon_pid=$(read_pid_record || true)
    if [[ "$daemon_pid" =~ ^[1-9][0-9]*$ ]]; then
      kill "$daemon_pid" 2>/dev/null || true
      for _ in $(seq 1 100); do kill -0 "$daemon_pid" 2>/dev/null || break; sleep 0.01; done
      kill -9 "$daemon_pid" 2>/dev/null || true
    fi
    rm -f "$pid_file" "$socket"
    printf '%s\n' '{"status":"stopped"}'
    ;;
  *) exit 64 ;;
esac
CODEXBIN
  chmod +x "$source_home/packages/standalone/releases/fixture/codex"
  ln -s releases/fixture "$source_home/packages/standalone/current"
done

# Fake HOME #1 (Lead-ful): identity + shared rules present.
FH1="$SB/home1"
mkdir -p "$FH1/.flywheel/claude-sessions" \
  "$FH1/Dev/GeoForge3D/.lead/product-lead" "$FH1/Dev/GeoForge3D/.lead/ops-lead" "$FH1/Dev/GeoForge3D/.lead/shared"
echo "# prod identity fixture" > "$FH1/Dev/GeoForge3D/.lead/product-lead/identity.md"
echo "# ops identity fixture" > "$FH1/Dev/GeoForge3D/.lead/ops-lead/identity.md"
echo "# shared rule fixture" > "$FH1/Dev/GeoForge3D/.lead/shared/dept.md"
printf '%s\n' '{"granularity":"per-lead","setBy":"test","setAt":"2026-09-03T00:00:00.000Z"}' \
  > "$FH1/.flywheel/summary-config.json"
# Fake HOME #2 (--no-lead): NO ~/Dev/GeoForge3D at all.
FH2="$SB/home2"
mkdir -p "$FH2/.flywheel/claude-sessions"

make_slots_json() {  # slots 30..35 carry real fixture values
  jq -n --argjson leadPort "$LEAD_PORT" --argjson noLeadPort "$NOLEAD_PORT" \
    --arg codexMain "$CODEX_SOURCE_MAIN" --arg codexExtra "$CODEX_SOURCE_EXTRA" '
    { guildId: "g-fixture",
      alertChannel: {
        channelId: "alert-fixture",
        repairBotTokenEnv: "TEST_BOT_TOKEN_31"
      },
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
              channelId: "chan-32", role: "lead", identitySource: "product-lead" },
            { id: 33, bridgePort: ($leadPort + 3), botName: "flywheel-test-33",
              tokenEnvVar: "TEST_BOT_TOKEN_33", botAppId: "3333",
              channelId: "chan-33", role: "lead", identitySource: "product-lead" },
            { id: 34, bridgePort: ($leadPort + 4), botName: "flywheel-test-34",
              tokenEnvVar: "TEST_BOT_TOKEN_34", botAppId: "34343434343434343",
              channelId: "34343434343434344", role: "lead", identitySource: "product-lead",
              backend: "codex-app-server", codexSourceHome: $codexMain,
              codexProfile: "companion" },
            { id: 35, bridgePort: ($leadPort + 5), botName: "flywheel-test-35",
              tokenEnvVar: "TEST_BOT_TOKEN_35", botAppId: "35353535353535353",
              channelId: "35353535353535354", role: "lead", identitySource: "ops-lead",
              backend: "codex-app-server", codexSourceHome: $codexExtra,
              codexProfile: "companion" } ] )
    }'
}
for H in "$FH1" "$FH2"; do
  make_slots_json > "$H/.flywheel/test-slots.json"
  cat > "$H/.flywheel/.env" <<'EOF'
TEST_BOT_TOKEN_31=tok-31
TEST_BOT_TOKEN_32=tok-32
TEST_BOT_TOKEN_30=tok-30
TEST_BOT_TOKEN_33=tok-33
TEST_BOT_TOKEN_34=tok-34
TEST_BOT_TOKEN_35=tok-35
LINEAR_API_KEY=fixture-linear-key
EOF
done

run_deploy() {  # <home> <slot> <stdout-file> <stderr-file> [extra args...]
  local home="$1" slot="$2" out="$3" err="$4"; shift 4
  local caller_cwd="${FLY1608_DEPLOY_CALLER_CWD:-$SB}"
  local repo_root="${FLY1389_REPO_ROOT:-$FR}"
  local tool_bin="${FLY1389_TOOL_BIN:-$STUB_BIN}"
  local child_path="${FLY1389_CHILD_PATH:-$tool_bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v git)"):$(dirname "$(command -v jq)"):$(dirname "$(command -v python3)"):$(dirname "$(command -v curl)"):$(dirname "$FLY1389_REAL_NODE"):$(dirname "$(command -v tmux)") }"
  child_path="${child_path% }"
  ( cd "$caller_cwd" && \
    env -i \
      HOME="$home" \
      PATH="$child_path" \
      TMPDIR="${FLY1389_TMPDIR:-/tmp}" \
      TMUX_STUB_LOG="$home/tmux-calls.log" \
      TMUX_STUB_WINDOW="" \
      FLY1389_LAUNCHCTL_STATE="$SB/launchctl-state" \
      FLY1389_CODEX_RUNTIME="$repo_root/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js" \
      FLY1389_PS_LOG="$SB/codex-ps.log" \
      FLYWHEEL_QA_LAUNCHCTL="$STUB_BIN/launchctl" \
      FLYWHEEL_QA_LEAD_WRAPPER="$repo_root/scripts/flywheel-lead-wrapper-v2.sh" \
      FLYWHEEL_QA_TMUX="${FLY1389_QA_TMUX:-$STUB_BIN/tmux}" \
      FLYWHEEL_QA_LAUNCHD_PATH="$child_path" \
      FLYWHEEL_QA_NODE="$FLY1389_REAL_NODE" \
      FLYWHEEL_QA_LAUNCHD_POLL_INTERVAL=0.01 \
      FLYWHEEL_QA_LEAD_VERIFY_POLLS=100 \
      FLYWHEEL_QA_LEAD_VERIFY_INTERVAL=0.01 \
      FLY1389_REAL_CURL="$FLY1389_REAL_CURL" \
      FLY1389_REAL_NODE="$FLY1389_REAL_NODE" \
      FLY1389_ENV_DUMP_NODE="$FLY1389_REAL_NODE" \
      FLYWHEEL_SANDBOX_REMOTE_URL="$BARE" \
      FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly1389-test-incarnation" \
      LEAD_WORKSPACE="/malicious/prod-workspace" \
      CLAUDE_CONFIG_DIR="/malicious/claude-config" \
      TEST_SKIP_PLUGIN_FORK_CHECK=1 \
      TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR="/malicious/claude-config" \
      TEST_LEAD_CLAUDE_CONFIG_DIR="${TEST_LEAD_CLAUDE_CONFIG_DIR:-}" \
      TEST_REPLY_BY_ISSUE="${TEST_REPLY_BY_ISSUE:-}" \
      TEST_API_TOKEN="${TEST_API_TOKEN:-}" \
      VERCEL_TOKEN="${VERCEL_TOKEN:-}" \
      FLYWHEEL_REPORT_HOST_OVERRIDE_URL="${FLYWHEEL_REPORT_HOST_OVERRIDE_URL:-}" \
      TEAMLEAD_INGEST_TOKEN="${TEAMLEAD_INGEST_TOKEN:-}" \
      FLYWHEEL_CODEX_HOMES_ROOT="${FLYWHEEL_CODEX_HOMES_ROOT:-}" \
      FLYWHEEL_CODEX_SESSION_DIR="${FLYWHEEL_CODEX_SESSION_DIR:-}" \
      FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT="${FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT:-}" \
      FLYWHEEL_NOVEL_WEBHOOK_TOKEN="fixture-novel-webhook-secret" \
      FLYWHEEL_LEAD_MODEL="malicious-model" \
      FLYWHEEL_LEAD_EFFORT="malicious-effort" \
      bash "$repo_root/scripts/test-deploy.sh" "$slot" "$@" \
      > "$out" 2> "$err" )
}

# test-deploy stdout carries a stray `git checkout -B` tracking line before
# the JSON (production shape too — consumers slice from the first '{').
extract_json() { sed -n '/^{/,$p' "$1"; }

run_teardown() {  # <home> <slot>
  local home="$1" slot="$2"
  local repo_root="${FLY1389_REPO_ROOT:-$FR}"
  local tool_bin="${FLY1389_TOOL_BIN:-$STUB_BIN}"
  local child_path="${FLY1389_CHILD_PATH:-$tool_bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v git)"):$(dirname "$(command -v jq)"):$(dirname "$(command -v python3)"):$(dirname "$FLY1389_REAL_NODE"):$(dirname "$(command -v tmux)") }"
  child_path="${child_path% }"
  local out="$SB/teardown-slot-${slot}.stdout.log"
  local err="$SB/teardown-slot-${slot}.stderr.log"
  local rc=0
  ( env -i \
      HOME="$home" \
      PATH="$child_path" \
      TMPDIR="${FLY1389_TMPDIR:-/tmp}" \
      TMUX_STUB_LOG="$home/tmux-calls.log" \
      FLY1389_LAUNCHCTL_STATE="$SB/launchctl-state" \
      FLY1389_CODEX_RUNTIME="$repo_root/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js" \
      FLY1389_PS_LOG="$SB/codex-ps.log" \
      FLY1389_REAL_NODE="$FLY1389_REAL_NODE" \
      FLYWHEEL_QA_LAUNCHCTL="$STUB_BIN/launchctl" \
      FLYWHEEL_QA_TMUX="${FLY1389_QA_TMUX:-$STUB_BIN/tmux}" \
      FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly1389-test-incarnation" \
      FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$home/cmux-mutator.lock" \
      FLYWHEEL_CMUX_MAINTENANCE_MARKER="$home/cmux-maintenance" \
      FLYWHEEL_CMUX_VIEW_WAL_DIR="$home/cmux-view-wal" \
      bash "$repo_root/scripts/test-teardown.sh" "$slot" >"$out" 2>"$err" ) || rc=$?
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

# ── A: --alerts respects wrapper-v2's single Lead identity source ──────────
rm -rf "/tmp/flywheel-test-slot-${LEAD_SLOT}.lock" "/tmp/flywheel-test-slot-${LEAD_SLOT}"
A_OUT="$SB/a-out.json"; A_ERR="$SB/a-err.log"
if run_deploy "$FH1" "$LEAD_SLOT" "$A_OUT" "$A_ERR" --alerts --lead-ready-timeout 1; then
  A_SLOT_DIR="/tmp/flywheel-test-slot-${LEAD_SLOT}"
  A_MANIFEST="$A_SLOT_DIR/launchd/flywheel-test-31/manifest.json"
  A_LE="$A_SLOT_DIR/lead-env.txt"
  A_EXPECTED_PROJECTS="$A_SLOT_DIR/q/${LEAD_SLOT}/projects.json"
  A_OK=1
  jq -e --arg projects "$A_EXPECTED_PROJECTS" '
    .projectsFile == $projects
    and .launchEnvironment.FLYWHEEL_PROJECTS_FILE == $projects
    and (.launchEnvironment | has("TEST_BOT_TOKEN_31") | not)
  ' "$A_MANIFEST" >/dev/null 2>&1 \
    || { A_OK=0; fail "A: --alerts manifest drifted from canonical projects/token identity" "$(cat "$A_MANIFEST" 2>/dev/null || true)"; }
  grep -q "^FLYWHEEL_PROJECTS_FILE=${A_EXPECTED_PROJECTS}$" "$A_LE" \
    || { A_OK=0; fail "A: carrier did not project the canonical projects registry"; }
  grep -q '^DISCORD_BOT_TOKEN=tok-31$' "$A_LE" \
    || { A_OK=0; fail "A: carrier did not resolve the canonical bot token"; }
  ! grep -q '^TEST_BOT_TOKEN_31=' "$A_LE" \
    || { A_OK=0; fail "A: named bot token bypassed wrapper-v2 identity ownership"; }
  grep -q "^FLYWHEEL_CLAIMS_DB=${A_SLOT_DIR}/alerts/claims.db$" "$A_LE" \
    || { A_OK=0; fail "A: --alerts lost slot-local Lead claims isolation"; }
  [[ "$A_OK" == "1" ]] \
    && pass "A: --alerts launchd-v2 Lead starts with one canonical identity source"
  run_teardown "$FH1" "$LEAD_SLOT"
else
  A_SLOT_DIR="/tmp/flywheel-test-slot-${LEAD_SLOT}"
  A_LEAD_DIAGNOSTIC="$(cat "$A_SLOT_DIR/lead.log" 2>/dev/null || true)"
  A_DEPLOY_DIAGNOSTIC="$(cat "$A_ERR" 2>/dev/null || true)"
  if grep -q 'identity_launch_env_conflict FLYWHEEL_PROJECTS_FILE' <<<"$A_LEAD_DIAGNOSTIC"; then
    fail "A: --alerts duplicated the wrapper-v2 projects identity" "identity_launch_env_conflict reproduced"
  else
    fail "A: --alerts hermetic deploy failed before the identity assertion" \
      "carrier=[$A_LEAD_DIAGNOSTIC] deploy=[$(tail -30 <<<"$A_DEPLOY_DIAGNOSTIC")]"
  fi
  run_teardown "$FH1" "$LEAD_SLOT" || true
fi

# ── E: Lead-ful hermetic E2E (slot 31) ──────────────────────────────────────
rm -rf "/tmp/flywheel-test-slot-${LEAD_SLOT}.lock" "/tmp/flywheel-test-slot-${LEAD_SLOT}"
# P0-d fixture: a stale session-id from a "previous round".
echo "a13ca2cd-dead-dead-dead-000000000000" \
  > "$FH1/.flywheel/claude-sessions/test-slot-${LEAD_SLOT}-flywheel-test-31.session-id"

E_OUT="$SB/e-out.json"; E_ERR="$SB/e-err.log"
if FLYWHEEL_CODEX_HOMES_ROOT="$SB/production-codex-homes" \
    FLYWHEEL_CODEX_SESSION_DIR="$SB/production-codex-sessions" \
    FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT="$SB/production-cdx-sock" \
    TEAMLEAD_INGEST_TOKEN='fixture-production-ingest' \
    run_deploy "$FH1" "$LEAD_SLOT" "$E_OUT" "$E_ERR"; then
  E_SLOT_DIR="/tmp/flywheel-test-slot-${LEAD_SLOT}"
  E_OK=1
  E_JSON="$(extract_json "$E_OUT")"
  jq -e '(.bridgeLaunchSpec | type == "string" and startswith("/"))' <<<"$E_JSON" >/dev/null 2>&1 \
    || { E_OK=0; fail "E/FLY-2237: deploy JSON lacks an absolute bridgeLaunchSpec"; }
  E_BRIDGE_SPEC="$(jq -r '.bridgeLaunchSpec // empty' <<<"$E_JSON")"
  [[ -f "$E_BRIDGE_SPEC" ]] \
    || { E_OK=0; fail "E/FLY-2237: bridge launch spec is not a regular file" "$E_BRIDGE_SPEC"; }
  [[ "$(mode_of "$E_BRIDGE_SPEC")" == "600" && "$(mode_of "$E_SLOT_DIR")" == "700" ]] \
    || { E_OK=0; fail "E/FLY-2237: launch spec/slot modes must be 600/700" \
      "spec=$(mode_of "$E_BRIDGE_SPEC") slot=$(mode_of "$E_SLOT_DIR")"; }
  E_CANON_CWD="$(cd "$SB" && pwd -P)"
  E_CANON_NPX="$(cd "$STUB_BIN" && pwd -P)/npx"
  E_CANON_SCRIPT="$(cd "$FR/scripts" && pwd -P)/run-bridge.ts"
  jq -e \
    --argjson slot "$LEAD_SLOT" --argjson port "$LEAD_PORT" \
    --arg bridgeUrl "http://localhost:${LEAD_PORT}" --arg cwd "$E_CANON_CWD" \
    --arg repoRoot "$(cd "$FR" && pwd -P)" \
    --arg logPath "$E_SLOT_DIR/bridge.log" \
    --arg command0 "$E_CANON_NPX" --arg script "$E_CANON_SCRIPT" \
    --arg ownerLock "/tmp/flywheel-test-slot-${LEAD_SLOT}.lock/pid" '
      .schemaVersion == 1 and .slot == $slot and .port == $port and
      .bridgeUrl == $bridgeUrl and .cwd == $cwd and .logPath == $logPath and
      .repoRoot == $repoRoot and .scriptPath == $script and
      .command == [$command0, "tsx", $script] and
      .ownershipPidFiles == [$ownerLock] and
      (.environment | type == "array") and
      (.secretEnvironment | type == "array")
    ' "$E_BRIDGE_SPEC" >/dev/null 2>&1 \
    || { E_OK=0; fail "E/FLY-2237: bridge launch spec schema/coordinates are incomplete"; }
  jq -e \
    --arg home "$FH1" --arg cwd "$E_CANON_CWD" \
    --arg binDir "$E_SLOT_DIR/bin" --arg hooksDir "$E_SLOT_DIR/hooks" \
    --arg homes "$E_SLOT_DIR/state/codex-homes" \
    --arg sessions "$E_SLOT_DIR/state/codex-sessions" \
    --arg sockets "$E_SLOT_DIR/state/cdx-sock" '
      any(.environment[]; . == "HOME=" + $home) and
      any(.environment[]; . == "PWD=" + $cwd) and
      any(.environment[]; startswith("PATH=")) and
      any(.environment[]; . == "FLYWHEEL_BIN_DIR=" + $binDir) and
      any(.environment[]; . == "FLYWHEEL_HOOKS_DIR=" + $hooksDir) and
      any(.environment[]; . == "FLYWHEEL_CODEX_HOMES_ROOT=" + $homes) and
      any(.environment[]; . == "FLYWHEEL_CODEX_SESSION_DIR=" + $sessions) and
      any(.environment[]; . == "FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT=" + $sockets) and
      (any(.environment[]; startswith("FLYWHEEL_QA_NODE=")) | not) and
      ([.secretEnvironment[].name] | index("FLYWHEEL_NOVEL_WEBHOOK_TOKEN") != null) and
      ([.secretEnvironment[].name] | index("LINEAR_API_KEY") != null) and
      ([.secretEnvironment[].name] | index("DISCORD_BOT_TOKEN") != null)
    ' "$E_BRIDGE_SPEC" >/dev/null 2>&1 \
    || { E_OK=0; fail "E/FLY-2237: full environment/secret classification is incomplete"; }
  E_NOVEL_SECRET_PATH="$(jq -r '.secretEnvironment[] | select(.name == "FLYWHEEL_NOVEL_WEBHOOK_TOKEN") | .path' "$E_BRIDGE_SPEC")"
  [[ -f "$E_NOVEL_SECRET_PATH" && ! -L "$E_NOVEL_SECRET_PATH" \
      && "$(mode_of "$E_NOVEL_SECRET_PATH")" == "600" \
      && "$(<"$E_NOVEL_SECRET_PATH")" == "fixture-novel-webhook-secret" ]] \
    || { E_OK=0; fail "E/FLY-2237: novel token was not isolated in a mode-0600 secret file"; }
  ! grep -Fq "fixture-novel-webhook-secret" "$E_BRIDGE_SPEC" \
    || { E_OK=0; fail "E/FLY-2237: launch spec contains novel token bytes"; }
  if ! "$FLY1389_REAL_NODE" - "$E_BRIDGE_SPEC" "$E_SLOT_DIR/bridge-env.json" <<'NODE'
const fs = require("node:fs");
const [specPath, livePath] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const expected = Object.fromEntries(spec.environment.map((assignment) => {
  const split = assignment.indexOf("=");
  return [assignment.slice(0, split), assignment.slice(split + 1)];
}));
for (const ref of spec.secretEnvironment) {
  expected[ref.name] = fs.readFileSync(ref.path, "utf8");
}
const live = JSON.parse(fs.readFileSync(livePath, "utf8"));
delete live._;
delete live.SHLVL;
const names = [...new Set([...Object.keys(expected), ...Object.keys(live)])].sort();
const missing = names.filter((name) => !(name in live));
const extra = names.filter((name) => !(name in expected));
const changed = names.filter((name) => name in expected && name in live && expected[name] !== live[name])
  .map((name) => ({ name, expectedBytes: Buffer.byteLength(expected[name]), liveBytes: Buffer.byteLength(live[name]) }));
if (missing.length || extra.length || changed.length) {
  console.error(JSON.stringify({ missing, extra, changed }));
  process.exit(1);
}
NODE
  then
    E_OK=0; fail "E/FLY-2237: initial live Bridge env differs from the captured full snapshot"
  fi
  jq -e '.noLead == false' <<<"$E_JSON" >/dev/null 2>&1 || { E_OK=0; fail "E: default path must report noLead=false"; }
  jq -e '.leadCarrier == "launchd-v2" and (.leadLaunchdLabel | startswith("com.flywheel.qa.lead.slot-31.")) and (.leadSocket | length > 0)' \
    <<<"$E_JSON" >/dev/null 2>&1 || { E_OK=0; fail "E: deploy JSON lacks launchd-v2 topology evidence"; }
  jq -e 'type == "array" and length == 1 and
      (.[0] | keys | sort) == ["label","manifest","plist"]' \
    "$E_SLOT_DIR/launchd-leads.json" >/dev/null 2>&1 \
    || { E_OK=0; fail "E/FLY-2301: pure Claude registry transcript changed shape"; }
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
    ! grep -q '^TEAMLEAD_INGEST_TOKEN=fixture-production-ingest$' "$BE" \
      || { E_OK=0; fail "E/FLY-2174: default Bridge inherited the ambient production ingest token"; }
    grep -q "^FLYWHEEL_CODEX_HOMES_ROOT=${E_SLOT_DIR}/state/codex-homes$" "$BE" \
      || { E_OK=0; fail "E/FLY-2174: default Bridge retained the production Codex home inventory"; }
    grep -q "^FLYWHEEL_CODEX_SESSION_DIR=${E_SLOT_DIR}/state/codex-sessions$" "$BE" \
      || { E_OK=0; fail "E/FLY-2174: default Bridge retained the production Codex daemon ledger"; }
    grep -q "^FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT=${E_SLOT_DIR}/state/cdx-sock$" "$BE" \
      || { E_OK=0; fail "E/FLY-2174: default Bridge retained the production Codex socket census"; }
    ! grep -Fq "$SB/production-" "$BE" \
      || { E_OK=0; fail "E/FLY-2174: default Bridge can still census production Codex daemons"; }
  else
    E_OK=0; fail "E: Bridge env dump missing" "$BE"
  fi
  E_CYCLE_OUT="$SB/e-cycle.out"
  E_CYCLE_ERR="$SB/e-cycle.err"
  E_OLD_WRAPPER="$(cat "$E_SLOT_DIR/bridge.pid" 2>/dev/null || true)"
  E_OLD_INTERMEDIATE="$(cat "$E_SLOT_DIR/bridge-intermediate.pid" 2>/dev/null || true)"
  E_OLD_LISTENER="$(cat "$E_SLOT_DIR/bridge-listener.pid" 2>/dev/null || true)"
  E_OLD_LEAD="$STUB_LEAD_PID"
  E_OS_LISTENER_PARENT="$(lsof -a -p "$E_OLD_LISTENER" -FpR 2>/dev/null | sed -n 's/^R//p' | head -1)"
  E_OS_INTERMEDIATE_PARENT="$(lsof -a -p "$E_OLD_INTERMEDIATE" -FpR 2>/dev/null | sed -n 's/^R//p' | head -1)"
  [[ "$E_OS_LISTENER_PARENT" == "$E_OLD_INTERMEDIATE" && "$E_OS_INTERMEDIATE_PARENT" == "$E_OLD_WRAPPER" ]] \
    || { E_OK=0; fail "E/FLY-2237: fixture is not a real listener→intermediate→wrapper PPID chain" \
      "listener=${E_OLD_LISTENER}/${E_OS_LISTENER_PARENT} intermediate=${E_OLD_INTERMEDIATE}/${E_OS_INTERMEDIATE_PARENT} wrapper=${E_OLD_WRAPPER}"; }
  [[ "$(cat "$E_SLOT_DIR/bridge-intermediate-argv.txt" 2>/dev/null || true)" == "scripts/run-bridge.ts" ]] \
    || { E_OK=0; fail "E/FLY-2237: intermediate did not receive the repo-relative script path"; }
  ! grep -Fq 'run-bridge.ts' "$E_SLOT_DIR/bridge-listener-argv.json" \
    || { E_OK=0; fail "E/FLY-2237: listener argv unexpectedly carries run-bridge.ts"; }
  sleep 300 & WORKER_SENTINEL_PID=$!
  sleep 300 & DAEMON_SENTINEL_PID=$!
  sleep 300 & TMUX_SENTINEL_PID=$!
  E_WORKER_START="$("$STUB_BIN/ps" -o lstart= -p "$WORKER_SENTINEL_PID")"
  E_DAEMON_START="$("$STUB_BIN/ps" -o lstart= -p "$DAEMON_SENTINEL_PID")"
  E_TMUX_START="$("$STUB_BIN/ps" -o lstart= -p "$TMUX_SENTINEL_PID")"
  if TEAMLEAD_API_TOKEN="cycle-production-api-token" \
      TEAMLEAD_INGEST_TOKEN="cycle-production-ingest-token" \
      FLYWHEEL_CODEX_HOMES_ROOT="/cycle-production-codex-homes" \
      FLYWHEEL_CODEX_SESSION_DIR="/cycle-production-codex-sessions" \
      FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT="/cycle-production-cdx-sock" \
      FLYWHEEL_BIN_DIR="/cycle-production-bin" \
      FLYWHEEL_HOOKS_DIR="/cycle-production-hooks" \
      FLY1389_REAL_CURL="$FLY1389_REAL_CURL" \
      PATH="$STUB_BIN:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v jq)"):$(dirname "$(command -v python3)"):$(dirname "$(command -v curl)")" \
      bash "$FR/scripts/test-cycle-bridge.sh" "$LEAD_SLOT" \
      >"$E_CYCLE_OUT" 2>"$E_CYCLE_ERR"; then
    pass "E/FLY-2237: public slot Bridge cycle succeeds"
  else
    E_OK=0
    fail "E/FLY-2237: public slot Bridge cycle failed" "$(tail -20 "$E_CYCLE_ERR")"
  fi
  E_NEW_WRAPPER="$(cat "$E_SLOT_DIR/bridge.pid" 2>/dev/null || true)"
  E_NEW_INTERMEDIATE="$(cat "$E_SLOT_DIR/bridge-intermediate.pid" 2>/dev/null || true)"
  E_NEW_LISTENER="$(cat "$E_SLOT_DIR/bridge-listener.pid" 2>/dev/null || true)"
  for old_pid in "$E_OLD_WRAPPER" "$E_OLD_INTERMEDIATE" "$E_OLD_LISTENER"; do
    ! kill -0 "$old_pid" 2>/dev/null \
      || { E_OK=0; fail "E/FLY-2237: old Bridge process survived cycle" "$old_pid"; }
    [[ "$(awk -F '\t' -v pid="$old_pid" '$2 == pid { count++ } END { print count+0 }' "$E_SLOT_DIR/bridge-term.log")" == "1" ]] \
      || { E_OK=0; fail "E/FLY-2237: old Bridge process did not receive exactly one TERM" "$old_pid"; }
  done
  [[ "$E_NEW_WRAPPER" =~ ^[1-9][0-9]*$ && "$E_NEW_WRAPPER" != "$E_OLD_WRAPPER" ]] \
    && kill -0 "$E_NEW_WRAPPER" 2>/dev/null \
    || { E_OK=0; fail "E/FLY-2237: replacement wrapper is not a new live PID"; }
  [[ "$E_NEW_INTERMEDIATE" =~ ^[1-9][0-9]*$ && "$E_NEW_INTERMEDIATE" != "$E_OLD_INTERMEDIATE" ]] \
    && kill -0 "$E_NEW_INTERMEDIATE" 2>/dev/null \
    || { E_OK=0; fail "E/FLY-2237: replacement intermediate is not a new live PID"; }
  [[ "$E_NEW_LISTENER" =~ ^[1-9][0-9]*$ && "$E_NEW_LISTENER" != "$E_OLD_LISTENER" ]] \
    && kill -0 "$E_NEW_LISTENER" 2>/dev/null \
    || { E_OK=0; fail "E/FLY-2237: replacement listener is not a new live PID"; }
  [[ "$(cat "/tmp/flywheel-test-slot-${LEAD_SLOT}.lock/pid" 2>/dev/null || true)" == "$E_NEW_WRAPPER" ]] \
    || { E_OK=0; fail "E/FLY-2237: owner lock does not name replacement wrapper"; }
  [[ "$(cat "$E_SLOT_DIR/bridge-boot-count" 2>/dev/null || true)" == "2" ]] \
    || { E_OK=0; fail "E/FLY-2237: cycle did not execute exactly the second Bridge boot"; }
  [[ "$(cat "$E_SLOT_DIR/bridge-listener.cwd" 2>/dev/null || true)" == "$(jq -r '.cwd' "$E_SLOT_DIR/bridge-launch.json")" ]] \
    || { E_OK=0; fail "E/FLY-2237: replacement listener cwd differs from spec cwd"; }
  "$FLY1389_REAL_CURL" -q -fsS --noproxy '*' --max-time 5 "http://localhost:${LEAD_PORT}/health" >/dev/null 2>&1 \
    || { E_OK=0; fail "E/FLY-2237: replacement Bridge is not healthy"; }
  jq -S 'del(._, .SHLVL)' "$E_SLOT_DIR/bridge-env-1.json" > "$SB/e-env-1.normalized.json"
  jq -S 'del(._, .SHLVL)' "$E_SLOT_DIR/bridge-env-2.json" > "$SB/e-env-2.normalized.json"
  cmp -s "$SB/e-env-1.normalized.json" "$SB/e-env-2.normalized.json" \
    || { E_OK=0; fail "E/FLY-2237: replacement Bridge full environment differs from initial boot"; }
  ! grep -Fq 'cycle-production-' "$E_SLOT_DIR/bridge-env-2.json" \
    || { E_OK=0; fail "E/FLY-2237: cycle caller production coordinates leaked into replacement Bridge"; }
  [[ "$E_OLD_LEAD" == "$(cat "$E_SLOT_DIR/lead-shell-pid.txt" 2>/dev/null || true)" ]] \
    && kill -0 "$E_OLD_LEAD" 2>/dev/null \
    || { E_OK=0; fail "E/FLY-2237: cycle changed the in-room Lead identity"; }
  for sentinel_record in \
      "$WORKER_SENTINEL_PID:$E_WORKER_START" \
      "$DAEMON_SENTINEL_PID:$E_DAEMON_START" \
      "$TMUX_SENTINEL_PID:$E_TMUX_START"; do
    sentinel_pid="${sentinel_record%%:*}"
    sentinel_start="${sentinel_record#*:}"
    kill -0 "$sentinel_pid" 2>/dev/null \
      && [[ "$("$STUB_BIN/ps" -o lstart= -p "$sentinel_pid")" == "$sentinel_start" ]] \
      || { E_OK=0; fail "E/FLY-2237: cycle changed worker/daemon/tmux sentinel identity" "$sentinel_pid"; }
  done
  jq -e --argjson slot "$LEAD_SLOT" --argjson old "$E_OLD_WRAPPER" --argjson new "$E_NEW_WRAPPER" '
    keys == ["bridgeUrl","launchSpec","newBridgePid","oldBridgePid","slot"] and
    .slot == $slot and .oldBridgePid == $old and .newBridgePid == $new
  ' "$E_CYCLE_OUT" >/dev/null 2>&1 \
    || { E_OK=0; fail "E/FLY-2237: cycle stdout JSON is not the redacted public contract"; }
  ! grep -Eq 'tok-31|fixture-linear-key|fixture-novel-webhook-secret|cycle-production-.*token' "$E_CYCLE_OUT" "$E_CYCLE_ERR" \
    || { E_OK=0; fail "E/FLY-2237: cycle output leaked a fixture secret"; }
  E_BOOT1_LINE="$(grep -n 'fly1389 boot-1' "$E_SLOT_DIR/bridge.log" | head -1 | cut -d: -f1)"
  E_TERM1_LINE="$(grep -n 'fly1389 term-1' "$E_SLOT_DIR/bridge.log" | head -1 | cut -d: -f1)"
  E_BOUNDARY_LINE="$(grep -n '\[test-cycle-bridge\] cycle boundary' "$E_SLOT_DIR/bridge.log" | head -1 | cut -d: -f1)"
  E_BOOT2_LINE="$(grep -n 'fly1389 boot-2' "$E_SLOT_DIR/bridge.log" | head -1 | cut -d: -f1)"
  [[ -n "$E_BOOT1_LINE" && -n "$E_TERM1_LINE" && -n "$E_BOUNDARY_LINE" && -n "$E_BOOT2_LINE" \
      && "$E_BOOT1_LINE" -lt "$E_TERM1_LINE" && "$E_TERM1_LINE" -lt "$E_BOUNDARY_LINE" \
      && "$E_BOUNDARY_LINE" -lt "$E_BOOT2_LINE" ]] \
    || { E_OK=0; fail "E/FLY-2237: Bridge log is not append-only across boot/TERM/cycle/boot"; }
  for pid in "$WORKER_SENTINEL_PID" "$DAEMON_SENTINEL_PID" "$TMUX_SENTINEL_PID"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  WORKER_SENTINEL_PID=""; DAEMON_SENTINEL_PID=""; TMUX_SENTINEL_PID=""
  [[ "$E_OK" == "1" ]] && pass "E: Lead-ful E2E — sanitize + cwd/PID parity + marker isolation + noLead=false"
  run_teardown "$FH1" "$LEAD_SLOT"
  [[ ! -d "/tmp/flywheel-test-slot-${LEAD_SLOT}.lock" ]] \
    && pass "E2: teardown releases the Lead-ful slot" \
    || fail "E2: teardown left the lock behind"
else
  fail "E: Lead-ful hermetic deploy failed" "$(tail -20 "$E_ERR")"
  run_teardown "$FH1" "$LEAD_SLOT" || true
fi

# ── W: QA cycle owns repos whose real path contains /worktrees/ ────────────
rm -rf "/tmp/flywheel-test-slot-${WORKTREE_SLOT}.lock" "/tmp/flywheel-test-slot-${WORKTREE_SLOT}"
W_OUT="$SB/w-out.json"; W_ERR="$SB/w-err.log"; W_CYCLE_OUT="$SB/w-cycle.out"; W_CYCLE_ERR="$SB/w-cycle.err"
if FLY1389_REPO_ROOT="$FWR" FLY1608_DEPLOY_CALLER_CWD="$FWR" \
    run_deploy "$FH1" "$WORKTREE_SLOT" "$W_OUT" "$W_ERR"; then
  W_SLOT_DIR="/tmp/flywheel-test-slot-${WORKTREE_SLOT}"
  W_OK=1
  W_OLD_WRAPPER="$(cat "$W_SLOT_DIR/bridge.pid" 2>/dev/null || true)"
  W_OLD_INTERMEDIATE="$(cat "$W_SLOT_DIR/bridge-intermediate.pid" 2>/dev/null || true)"
  W_OLD_LISTENER="$(cat "$W_SLOT_DIR/bridge-listener.pid" 2>/dev/null || true)"
  W_OS_LISTENER_PARENT="$(lsof -a -p "$W_OLD_LISTENER" -FpR 2>/dev/null | sed -n 's/^R//p' | head -1)"
  W_OS_INTERMEDIATE_PARENT="$(lsof -a -p "$W_OLD_INTERMEDIATE" -FpR 2>/dev/null | sed -n 's/^R//p' | head -1)"
  [[ "$W_OS_LISTENER_PARENT" == "$W_OLD_INTERMEDIATE" && "$W_OS_INTERMEDIATE_PARENT" == "$W_OLD_WRAPPER" ]] \
    || { W_OK=0; fail "W/FLY-2237: /worktrees/ fixture lacks the real three-level PPID chain"; }
  jq -e '.cwd | contains("/worktrees/fly-2237")' "$W_SLOT_DIR/bridge-launch.json" >/dev/null 2>&1 \
    || { W_OK=0; fail "W/FLY-2237: launch spec does not preserve the /worktrees/ repo path class"; }
  if FLY1389_REAL_CURL="$FLY1389_REAL_CURL" \
      PATH="$STUB_BIN:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v jq)"):$(dirname "$(command -v python3)"):$(dirname "$(command -v curl)")" \
      bash "$FWR/scripts/test-cycle-bridge.sh" "$WORKTREE_SLOT" \
      >"$W_CYCLE_OUT" 2>"$W_CYCLE_ERR"; then
    W_NEW_WRAPPER="$(cat "$W_SLOT_DIR/bridge.pid" 2>/dev/null || true)"
    W_NEW_LISTENER="$(cat "$W_SLOT_DIR/bridge-listener.pid" 2>/dev/null || true)"
    [[ "$W_NEW_WRAPPER" =~ ^[1-9][0-9]*$ && "$W_NEW_WRAPPER" != "$W_OLD_WRAPPER" ]] \
      && kill -0 "$W_NEW_WRAPPER" 2>/dev/null \
      || { W_OK=0; fail "W/FLY-2237: /worktrees/ cycle did not replace the wrapper"; }
    [[ "$W_NEW_LISTENER" =~ ^[1-9][0-9]*$ && "$W_NEW_LISTENER" != "$W_OLD_LISTENER" ]] \
      && kill -0 "$W_NEW_LISTENER" 2>/dev/null \
      || { W_OK=0; fail "W/FLY-2237: /worktrees/ cycle did not replace the listener"; }
    [[ "$(cat "$W_SLOT_DIR/bridge-boot-count" 2>/dev/null || true)" == "2" ]] \
      || { W_OK=0; fail "W/FLY-2237: /worktrees/ cycle did not replay the launch contract"; }
    for old_pid in "$W_OLD_WRAPPER" "$W_OLD_INTERMEDIATE" "$W_OLD_LISTENER"; do
      [[ "$(awk -F '\t' -v pid="$old_pid" '$2 == pid { count++ } END { print count+0 }' "$W_SLOT_DIR/bridge-term.log")" == "1" ]] \
        || { W_OK=0; fail "W/FLY-2237: /worktrees/ old process lacked exactly one TERM" "$old_pid"; }
    done
    "$FLY1389_REAL_CURL" -q -fsS --noproxy '*' --max-time 5 \
      "http://localhost:$((LEAD_PORT + 3))/health" >/dev/null 2>&1 \
      || { W_OK=0; fail "W/FLY-2237: /worktrees/ replacement Bridge is not healthy"; }
  else
    W_OK=0
    fail "W/FLY-2237: /worktrees/ public cycle failed" "$(tail -20 "$W_CYCLE_ERR")"
  fi
  [[ "$W_OK" == "1" ]] && pass "W/FLY-2237: /worktrees/ repo uses the slot-owned PPID cycle"
  FLY1389_REPO_ROOT="$FWR" run_teardown "$FH1" "$WORKTREE_SLOT"
else
  fail "W/FLY-2237: /worktrees/ hermetic deploy failed" "$(tail -20 "$W_ERR")"
  FLY1389_REPO_ROOT="$FWR" run_teardown "$FH1" "$WORKTREE_SLOT" || true
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
I_PRESEEDED_TOKEN='fixture-stale-report-token'
mkdir -p "/tmp/flywheel-test-slot-${LEAD_SLOT}/state/report-host"
printf '%s\n' "$I_PRESEEDED_TOKEN" \
  > "/tmp/flywheel-test-slot-${LEAD_SLOT}/state/report-host/token"
chmod 600 "/tmp/flywheel-test-slot-${LEAD_SLOT}/state/report-host/token"
if FLY1608_DEPLOY_CALLER_CWD="$FR/packages/teamlead" \
    TEST_REPLY_BY_ISSUE=1 \
    TEST_API_TOKEN="fixture-api-token" \
    VERCEL_TOKEN="fixture-production-vercel-token" \
    FLYWHEEL_REPORT_HOST_OVERRIDE_URL="http://127.0.0.1:51234" \
    TEAMLEAD_INGEST_TOKEN="fixture-production-ingest" \
    FLYWHEEL_CODEX_HOMES_ROOT="$SB/production-codex-homes" \
    FLYWHEEL_CODEX_SESSION_DIR="$SB/production-codex-sessions" \
    FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT="$SB/production-cdx-sock" \
    TEST_LEAD_CLAUDE_CONFIG_DIR="$I_CONFIG" \
    run_deploy "$FH1" "$LEAD_SLOT" "$I_OUT" "$I_ERR"; then
  I_SLOT_DIR="/tmp/flywheel-test-slot-${LEAD_SLOT}"
  I_LE="$I_SLOT_DIR/lead-env.txt"
  I_OK=1
  I_JSON="$(extract_json "$I_OUT")"
  I_REPORT_URL="$(jq -r '.reportHost.url // empty' <<<"$I_JSON")"
  I_REPORT_TOKEN_PATH="$(jq -r '.reportHost.tokenPath // empty' <<<"$I_JSON")"
  I_REPORT_SITES_DIR="$(jq -r '.reportHost.sitesDir // empty' <<<"$I_JSON")"
  I_REPORT_PORT="${I_REPORT_URL##*:}"
  [[ "$I_REPORT_URL" =~ ^http://127\.0\.0\.1:[1-9][0-9]*$ \
      && "$I_REPORT_TOKEN_PATH" == "$I_SLOT_DIR/state/report-host/token" \
      && "$I_REPORT_SITES_DIR" == "$I_SLOT_DIR/state/report-host/sites" ]] \
    || { I_OK=0; fail "I/FLY-2270: reply-mode output lacks the ready slot report host"; }
  I_BRIDGE_SPEC="$I_SLOT_DIR/bridge-launch.json"
  I_CANON_BASH="$(PATH="$STUB_BIN:/usr/bin:/bin" command -v bash)"
  I_CANON_NPX="$STUB_BIN/npx"
  I_CANON_SCRIPT="$(cd "$FR/scripts" && pwd -P)/run-bridge.ts"
  jq -e \
    --arg bash "$I_CANON_BASH" --arg wrapper "$FR/scripts/lib/qa-report-host-bridge-wrapper.sh" \
    --arg root "$I_SLOT_DIR/state/report-host" --arg node "$FLY1389_REAL_NODE" \
    --arg npx "$I_CANON_NPX" --arg script "$I_CANON_SCRIPT" '
      .command == [$bash,$wrapper,$root,$node,"--",$npx,"tsx",$script] and
      (any(.environment[]; startswith("FLYWHEEL_REPORT_HOST_OVERRIDE_URL=")) | not) and
      ([.secretEnvironment[].name] | index("VERCEL_TOKEN") != null)
    ' "$I_BRIDGE_SPEC" >/dev/null 2>&1 \
    || { I_OK=0; fail "I/FLY-2270: report wrapper command/secret boundary is incomplete" \
      "command=$(jq -c '.command' "$I_BRIDGE_SPEC") secrets=$(jq -c '[.secretEnvironment[].name]' "$I_BRIDGE_SPEC")"; }
  I_SPEC_TOKEN_PATH="$(jq -r '.secretEnvironment[] | select(.name == "VERCEL_TOKEN") | .path' "$I_BRIDGE_SPEC")"
  I_REPORT_TOKEN="$(<"$I_REPORT_TOKEN_PATH")"
  [[ -f "$I_SPEC_TOKEN_PATH" && "$(<"$I_SPEC_TOKEN_PATH")" == "$I_REPORT_TOKEN" \
      && "$I_REPORT_TOKEN" != "$I_PRESEEDED_TOKEN" \
      && "$I_REPORT_TOKEN" != "fixture-production-vercel-token" ]] \
    || { I_OK=0; fail "I/FLY-2270: report token was not freshly isolated into the launch spec"; }
  grep -q "^FLYWHEEL_REPORTS_DIR=${I_SLOT_DIR}/state/reports$" "$I_LE" \
    || { I_OK=0; fail "I/FLY-2270: Lead reports directory is not slot-local"; }
  grep -q "^TMPDIR=${I_SLOT_DIR}/tmp$" "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I/FLY-2270: reply Bridge did not receive the short slot TMPDIR"; }
  grep -q "^FLYWHEEL_REPORTS_DIR=${I_SLOT_DIR}/state/reports$" "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I/FLY-2270: reply Bridge reports directory is not slot-local"; }
  grep -q "^FLYWHEEL_REPORT_HOST_OVERRIDE_URL=${I_REPORT_URL}$" "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I/FLY-2270: wrapper did not inject the loopback report URL"; }
  I_REPORT_STUB_PID="$(lsof -nP -iTCP:"$I_REPORT_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  I_REPORT_STUB_PARENT="$(lsof -a -p "$I_REPORT_STUB_PID" -FpR 2>/dev/null | sed -n 's/^R//p' | head -1)"
  [[ "$I_REPORT_STUB_PID" =~ ^[1-9][0-9]*$ \
      && "$I_REPORT_STUB_PARENT" == "$(<"$I_SLOT_DIR/bridge.pid")" ]] \
    || { I_OK=0; fail "I/FLY-2270: report host is not the sole direct Bridge child"; }
  [[ "$($FLY1389_REAL_CURL -q -sS -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer ${I_REPORT_TOKEN}" \
      "${I_REPORT_URL}/v13/deployments/self-check")" == "200" \
      && "$($FLY1389_REAL_CURL -q -sS -o /dev/null -w '%{http_code}' \
      "${I_REPORT_URL}/v13/deployments/self-check")" == "401" ]] \
    || { I_OK=0; fail "I/FLY-2270: report host bearer self-check failed"; }
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
  ! grep -q '^TEAMLEAD_INGEST_TOKEN=fixture-production-ingest$' "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I/FLY-2174: reply-by-issue Bridge inherited the ambient production ingest token"; }
  grep -q "^FLYWHEEL_CODEX_HOMES_ROOT=${I_SLOT_DIR}/state/codex-homes$" "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I/FLY-2174: reply Bridge retained the production Codex home inventory"; }
  grep -q "^FLYWHEEL_CODEX_SESSION_DIR=${I_SLOT_DIR}/state/codex-sessions$" "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I/FLY-2174: reply Bridge retained the production Codex daemon ledger"; }
  grep -q "^FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT=${I_SLOT_DIR}/state/cdx-sock$" "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I/FLY-2174: reply Bridge retained the production Codex socket census"; }
  ! grep -Fq "$SB/production-" "$I_SLOT_DIR/bridge-env.txt" \
    || { I_OK=0; fail "I/FLY-2174: reply Bridge can still census production Codex daemons"; }
  [[ "$(cat "$I_SLOT_DIR/state/api-token" 2>/dev/null || true)" == "fixture-api-token" ]] \
    || { I_OK=0; fail "I/FLY-1775: reply-by-issue token was not persisted slot-locally"; }
  [[ "$(stat -c '%a' "$I_SLOT_DIR/state/api-token" 2>/dev/null || stat -f '%Lp' "$I_SLOT_DIR/state/api-token")" == "600" ]] \
    || { I_OK=0; fail "I/FLY-1775: reply-by-issue token file is not mode 0600"; }
  [[ "$(cat "$I_SLOT_DIR/lead-cwd.txt" 2>/dev/null || true)" == "$FR/packages/teamlead" ]] \
    || { I_OK=0; fail "I: package-cwd invocation did not keep production-aligned Lead cwd"; }
  I_OLD_REPORT_URL="$I_REPORT_URL"
  I_OLD_REPORT_STUB_PID="$I_REPORT_STUB_PID"
  I_CYCLE_OUT="$SB/i-cycle.out"; I_CYCLE_ERR="$SB/i-cycle.err"
  if FLY1389_REAL_CURL="$FLY1389_REAL_CURL" \
      PATH="$STUB_BIN:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v jq)"):$(dirname "$(command -v python3)"):$(dirname "$(command -v curl)")" \
      bash "$FR/scripts/test-cycle-bridge.sh" "$LEAD_SLOT" \
      >"$I_CYCLE_OUT" 2>"$I_CYCLE_ERR"; then
    I_NEW_REPORT_PORT="$(<"$I_SLOT_DIR/state/report-host/port")"
    I_NEW_REPORT_URL="http://127.0.0.1:${I_NEW_REPORT_PORT}"
    I_NEW_REPORT_STUB_PID="$(lsof -nP -iTCP:"$I_NEW_REPORT_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
    I_NEW_REPORT_STUB_PARENT="$(lsof -a -p "$I_NEW_REPORT_STUB_PID" -FpR 2>/dev/null | sed -n 's/^R//p' | head -1)"
    kill -0 "$I_OLD_REPORT_STUB_PID" 2>/dev/null \
      && { I_OK=0; fail "I/FLY-2270: old report host survived the Bridge cycle"; }
    "$FLY1389_REAL_CURL" -q -fsS --max-time 1 "$I_OLD_REPORT_URL/v13/deployments/self-check" >/dev/null 2>&1 \
      && { I_OK=0; fail "I/FLY-2270: old report URL still accepts connections after cycle"; }
    [[ "$I_NEW_REPORT_URL" != "$I_OLD_REPORT_URL" \
        && "$I_NEW_REPORT_STUB_PID" =~ ^[1-9][0-9]*$ \
        && "$I_NEW_REPORT_STUB_PARENT" == "$(<"$I_SLOT_DIR/bridge.pid")" \
        && "$($FLY1389_REAL_CURL -q -sS -o /dev/null -w '%{http_code}' \
          -H "Authorization: Bearer ${I_REPORT_TOKEN}" \
          "$I_NEW_REPORT_URL/v13/deployments/self-check")" == "200" ]] \
      || { I_OK=0; fail "I/FLY-2270: replacement report host is not fresh, parented, and authenticated"; }
  else
    I_OK=0; fail "I/FLY-2270: Bridge cycle with report host failed" "$(tail -20 "$I_CYCLE_ERR")"
  fi
  [[ "$I_OK" == "1" ]] \
    && pass "I: reply Bridge uses a fresh slot report host and cycles it with parent ownership"
  I_FINAL_REPORT_STUB_PID="${I_NEW_REPORT_STUB_PID:-$I_REPORT_STUB_PID}"
  I_FINAL_REPORT_PORT="${I_NEW_REPORT_PORT:-$I_REPORT_PORT}"
  run_teardown "$FH1" "$LEAD_SLOT"
  for _poll in $(seq 1 30); do
    kill -0 "$I_FINAL_REPORT_STUB_PID" 2>/dev/null || break
    sleep 0.1
  done
  ! kill -0 "$I_FINAL_REPORT_STUB_PID" 2>/dev/null \
    && [[ -z "$(lsof -nP -iTCP:"$I_FINAL_REPORT_PORT" -sTCP:LISTEN -t 2>/dev/null || true)" \
        && ! -e "$I_SLOT_DIR/state/report-host/port" ]] \
    || fail "I/FLY-2270: teardown left the report host or port file behind"
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
N_LONG_CALLER_TMP="$SB/$(printf 'runner-tmp-x%.0s' {1..12})"
mkdir -p "$N_LONG_CALLER_TMP"
if ( cd "$SB" && \
  env -i \
    HOME="$FH2" \
    PATH="$STUB_BIN:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v git)"):$(dirname "$(command -v jq)"):$(dirname "$(command -v python3)"):$(dirname "$(command -v curl)")" \
    TMPDIR="$N_LONG_CALLER_TMP" \
    TMUX_STUB_LOG="$FH2/tmux-calls.log" \
    FLYWHEEL_SANDBOX_REMOTE_URL="$BARE" \
    FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly1389-test-incarnation" \
    FLY1389_REAL_CURL="$FLY1389_REAL_CURL" \
    FLY1389_ENV_DUMP_NODE="$FLY1389_REAL_NODE" \
    FLYWHEEL_QA_NODE="$FLY1389_REAL_NODE" \
    VERCEL_TOKEN="fixture-production-vercel-token" \
    FLYWHEEL_REPORT_HOST_OVERRIDE_URL="http://127.0.0.1:51234" \
    GEOFORGE3D_LEAD_RULES_SRC="$SENTINEL" \
    bash "$FR/scripts/test-deploy.sh" "$NOLEAD_SLOT" --no-lead \
    > "$N_OUT" 2> "$N_ERR" ); then
  N_SLOT_DIR="/tmp/flywheel-test-slot-${NOLEAD_SLOT}"
  N_OK=1
  N_JSON="$(extract_json "$N_OUT")"
  jq -e '.noLead == true' <<<"$N_JSON" >/dev/null 2>&1 || { N_OK=0; fail "N: JSON noLead must be true"; }
  jq -e '.leadCarrier == "none"' <<<"$N_JSON" >/dev/null 2>&1 || { N_OK=0; fail "N: no-lead carrier must be none"; }
  jq -e --arg slotDir "$N_SLOT_DIR" '
    .reportHost == null and
    .reportsDir == ($slotDir + "/state/reports") and
    .bridgeTmpDir == ($slotDir + "/tmp")
  ' <<<"$N_JSON" >/dev/null 2>&1 \
    || { N_OK=0; fail "N/FLY-2270: default output lacks isolated reports/TMPDIR coordinates"; }
  [[ -d "$N_SLOT_DIR/state/reports" && "$(mode_of "$N_SLOT_DIR/state/reports")" == "700" \
      && -d "$N_SLOT_DIR/tmp" && "$(mode_of "$N_SLOT_DIR/tmp")" == "700" ]] \
    || { N_OK=0; fail "N/FLY-2270: default isolated reports/TMPDIR directories are missing or unsafe"; }
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
  grep -q "^TMPDIR=${N_SLOT_DIR}/tmp$" "$N_SLOT_DIR/bridge-env.txt" \
    || { N_OK=0; fail "N/FLY-2270: no-lead Bridge did not receive the short slot TMPDIR"; }
  grep -q "^FLYWHEEL_REPORTS_DIR=${N_SLOT_DIR}/state/reports$" "$N_SLOT_DIR/bridge-env.txt" \
    || { N_OK=0; fail "N/FLY-2270: no-lead Bridge reports directory is not slot-local"; }
  ! grep -q '^VERCEL_TOKEN=' "$N_SLOT_DIR/bridge-env.txt" \
    || { N_OK=0; fail "N/FLY-2270: default Bridge inherited the production Vercel token"; }
  ! grep -q '^FLYWHEEL_REPORT_HOST_OVERRIDE_URL=' "$N_SLOT_DIR/bridge-env.txt" \
    || { N_OK=0; fail "N/FLY-2270: default Bridge inherited a foreign report-host override"; }
  N_BRIDGE_SPEC="$N_SLOT_DIR/bridge-launch.json"
  jq -e --arg npx "$(cd "$STUB_BIN" && pwd -P)/npx" '
    .command[0] == $npx and
    ([.secretEnvironment[].name] | index("VERCEL_TOKEN") == null)
  ' "$N_BRIDGE_SPEC" >/dev/null 2>&1 \
    || { N_OK=0; fail "N/FLY-2270: default launch spec retained report-host wrapper or VERCEL_TOKEN"; }
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

# ── CX: Codex-shaped launchd Lead (FLY-2301) ──────────────────────────────
REAL_TMUX="$(command -v tmux)"
CODEX_CHILD_PATH="$CODEX_TOOL_BIN:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v git)"):$(dirname "$(command -v jq)"):$(dirname "$(command -v python3)"):$(dirname "$FLY1389_REAL_NODE"):$(dirname "$REAL_TMUX")"
run_codex_drill() {  # <slot> <crash|kickstart> <evidence-root> <stdout> <stderr>
  local slot="$1" mode="$2" evidence="$3" out="$4" err="$5"
  env -i HOME="$FH1" PATH="$CODEX_CHILD_PATH" TMPDIR=/tmp \
    FLY1389_LAUNCHCTL_STATE="$SB/launchctl-state" \
    FLY1389_CODEX_RUNTIME="$FR/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js" \
    FLY1389_REAL_NODE="$FLY1389_REAL_NODE" FLY1389_PS_LOG="$SB/codex-ps.log" \
    FLYWHEEL_QA_LAUNCHCTL="$STUB_BIN/launchctl" FLYWHEEL_QA_TMUX="$REAL_TMUX" \
    FLYWHEEL_QA_LEAD_VERIFY_POLLS=300 FLYWHEEL_QA_LEAD_VERIFY_INTERVAL=0.01 \
    bash "$SCRIPT_DIR/qa-fly-2301-codex-lead-drill.sh" "$slot" "$mode" "$evidence" \
    >"$out" 2>"$err"
}

rm -rf "/tmp/flywheel-test-slot-${CODEX_SLOT}.lock" "/tmp/flywheel-test-slot-${CODEX_SLOT}"
CX_OUT="$SB/cx-out.json"; CX_ERR="$SB/cx-err.log"
if FLY1389_TOOL_BIN="$CODEX_TOOL_BIN" FLY1389_QA_TMUX="$REAL_TMUX" \
    run_deploy "$FH1" "$CODEX_SLOT" "$CX_OUT" "$CX_ERR" --lead-ready-timeout 5; then
  CX_JSON="$(extract_json "$CX_OUT")"
  CX_SLOT_DIR="/tmp/flywheel-test-slot-${CODEX_SLOT}"
  CX_STATE="$(jq -r '.codexLead.stateDir' <<<"$CX_JSON")"
  CX_HOME="$(jq -r '.codexLead.codexHome' <<<"$CX_JSON")"
  CX_SOCKET="$(jq -r '.codexLead.tmuxSocket' <<<"$CX_JSON")"
  CX_LABEL="$(jq -r '.codexLead.label' <<<"$CX_JSON")"
  CX_OK=1
  jq -e --arg slot "$CX_SLOT_DIR" --arg label "$CX_LABEL" '
      .leadCarrier == "launchd-codex-tui" and .leadLaunchdLabel == $label and
      .codexLead.tuiWindow == "present" and .codexLead.agentId == "flywheel-test-34" and
      .codexLead.projectName == "test-slot-34" and
      (.codexLead.codexHome | startswith($slot + "/cdxh/")) and
      (.codexLead.stateDir | startswith($slot + "/q/34/")) and
      .codexLead.commDb == ($slot + "/state/comm/test-slot-34/comm.db")
    ' >/dev/null 2>&1 <<<"$CX_JSON" \
    || { CX_OK=0; fail "CX: Codex-shaped deploy JSON contract"; }
  jq -e --arg label "$CX_LABEL" --arg home "$CX_HOME" --arg state "$CX_STATE" '
      type == "array" and length == 1 and .[0].carrier == "codex-tui" and
      .[0].label == $label and .[0].codexHome == $home and .[0].stateDir == $state and
      (.[0].manifest == "") and
      (.[0] | keys | sort) == ["carrier","codexBin","codexHome","label","manifest","plist","runtimePidFile","stateDir"]
    ' "$CX_SLOT_DIR/launchd-leads.json" >/dev/null 2>&1 \
    || { CX_OK=0; fail "CX: Codex registry lacks its lifecycle authority"; }
  python3 - "$CX_SLOT_DIR/launchd/flywheel-test-34/lead.plist" \
      "$CX_SLOT_DIR/launchd/flywheel-test-34/codex-lead-wrapper.sh" "$CX_SLOT_DIR" <<'PY' \
    || { CX_OK=0; fail "CX: Codex plist argv/env/KeepAlive shape"; }
import plistlib, sys
plist, wrapper, slot = sys.argv[1:]
with open(plist, "rb") as stream: value = plistlib.load(stream)
assert value["ProgramArguments"] == ["/bin/bash", wrapper]
assert value["EnvironmentVariables"]["TMUX_TMPDIR"] == slot
assert value["RunAtLoad"] is True and value["KeepAlive"] is True
assert "FLYWHEEL_PROJECTS_FILE" not in value["EnvironmentVariables"]
PY
  CX_PID="$(jq -r '.processPid' "$CX_STATE/brain/heartbeat.json" 2>/dev/null || true)"
  [[ "$CX_PID" =~ ^[1-9][0-9]*$ \
      && "$(cat "$CX_SLOT_DIR/launchd/flywheel-test-34/pid")" == "$CX_PID" ]] \
    || { CX_OK=0; fail "CX: launchd PID and heartbeat PID disagree"; }
  [[ "$CX_HOME" == "$CX_SLOT_DIR/cdxh/flywheel-test-34" \
      && "$CX_HOME" != "$CODEX_SOURCE_MAIN" \
      && -f "$CX_HOME/auth.json" && -S "$CX_HOME/app-server-control/app-server-control.sock" ]] \
    || { CX_OK=0; fail "CX: Codex home was not minted and daemonized inside the slot"; }
  [[ "$($REAL_TMUX -S "$CX_SOCKET" list-windows -t '=flywheel' -F '#{window_name}')" == \
      "test-slot-34-flywheel-test-34" ]] \
    || { CX_OK=0; fail "CX: main Codex TUI window is not unique on the private socket"; }
  jq -e '.FLYWHEEL_CANONICAL_IDENTITY_RESOLVED == "1" and
      .FLYWHEEL_LEAD_BACKEND == "codex-app-server" and
      .FLYWHEEL_LEAD_ID == "flywheel-test-34" and
      .FLYWHEEL_PROJECT_NAME == "test-slot-34" and
      .DISCORD_BOT_TOKEN == "[present]"' \
    "$CX_SLOT_DIR/q/34/codex-runtime-env.json" >/dev/null 2>&1 \
    || { CX_OK=0; fail "CX: true launcher/canonical resolver did not reach the runtime"; }

  CX_EVIDENCE="$SB/cx-evidence"
  mkdir -p "$CX_EVIDENCE"
  for CX_MODE in crash kickstart; do
    CX_DRILL_OUT="$SB/cx-${CX_MODE}.out"; CX_DRILL_ERR="$SB/cx-${CX_MODE}.err"
    if run_codex_drill "$CODEX_SLOT" "$CX_MODE" "$CX_EVIDENCE" \
        "$CX_DRILL_OUT" "$CX_DRILL_ERR"; then
      CX_DRILL_DIR="$(jq -r '.evidenceDir' "$CX_DRILL_OUT")"
      jq -e --arg mode "$CX_MODE" '
          .mode == $mode and .old.pid != .new.pid and
          .old.generationId != .new.generationId and
          .old.carrierInstanceId != .new.carrierInstanceId and
          (.old.predicates | all) and (.new.predicates | all)
        ' "$CX_DRILL_DIR/restart-drill.json" >/dev/null 2>&1 \
        || { CX_OK=0; fail "CX: ${CX_MODE} drill did not bind old/new topology evidence"; }
      [[ -s "$CX_DRILL_DIR/launch-manifest.json" \
          && -f "$CX_DRILL_DIR/default-tmux-windows.before.tsv" \
          && -f "$CX_DRILL_DIR/slot-tmux-windows.after.tsv" ]] \
        || { CX_OK=0; fail "CX: ${CX_MODE} drill evidence bundle incomplete"; }
    else
      CX_OK=0
      fail "CX: ${CX_MODE} restart drill failed" "$(tail -40 "$CX_DRILL_ERR")"
    fi
  done
  [[ "$CX_OK" == 1 ]] \
    && pass "CX: Codex main launch + canonical env + private TUI + crash/kickstart self-heal"
  if FLY1389_TOOL_BIN="$CODEX_TOOL_BIN" FLY1389_QA_TMUX="$REAL_TMUX" \
      run_teardown "$FH1" "$CODEX_SLOT"; then
    if ! "$STUB_BIN/launchctl" print "gui/$(id -u)/$CX_LABEL" >/dev/null 2>&1 \
        && [[ ! -S "$CX_SOCKET" && ! -e "$CX_HOME/app-server-control/app-server-control.sock" ]]; then
      pass "CX2: Codex teardown converges launchd, runtime, daemon, and private tmux"
    else
      fail "CX2: Codex teardown left a lifecycle coordinate alive" \
        "tmuxSocket=$([[ -S "$CX_SOCKET" ]] && echo alive || echo gone) daemonSocket=$([[ -e "$CX_HOME/app-server-control/app-server-control.sock" ]] && echo alive || echo gone) teardown=$(cat "$SB/teardown-slot-${CODEX_SLOT}.stderr.log" "$SB/teardown-slot-${CODEX_SLOT}.stdout.log" 2>/dev/null | tail -30)"
    fi
  else
    fail "CX2: Codex main teardown"
  fi
else
  fail "CX: Codex-shaped main Lead deploy failed" \
    "$(tail -30 "$CX_ERR") | lead-log: $(tail -40 "/tmp/flywheel-test-slot-${CODEX_SLOT}/lead.log" 2>/dev/null || true) | ps-log: $(tail -80 "$SB/codex-ps.log" 2>/dev/null || true)"
  FLY1389_TOOL_BIN="$CODEX_TOOL_BIN" FLY1389_QA_TMUX="$REAL_TMUX" \
    run_teardown "$FH1" "$CODEX_SLOT" || true
fi

# Main + extra Codex Leads share one Bridge but retain distinct home/state/window
# coordinates and a single convergent lifecycle registry.
rm -rf "/tmp/flywheel-test-slot-${CODEX_SLOT}.lock" "/tmp/flywheel-test-slot-${CODEX_SLOT}" \
  "/tmp/flywheel-test-slot-${CODEX_EXTRA_SLOT}.lock" "/tmp/flywheel-test-slot-${CODEX_EXTRA_SLOT}"
CXX_OUT="$SB/cxx-out.json"; CXX_ERR="$SB/cxx-err.log"
if FLY1389_TOOL_BIN="$CODEX_TOOL_BIN" FLY1389_QA_TMUX="$REAL_TMUX" \
    run_deploy "$FH1" "$CODEX_SLOT" "$CXX_OUT" "$CXX_ERR" \
      --extra-lead "${CODEX_EXTRA_SLOT}:Ops-Test" --lead-ready-timeout 5; then
  CXX_DIR="/tmp/flywheel-test-slot-${CODEX_SLOT}"
  CXX_SOCKET="$CXX_DIR/tmux-$(id -u)/default"
  CXX_WINDOWS="$($REAL_TMUX -S "$CXX_SOCKET" list-windows -t '=flywheel' -F '#{window_name}' | sort)"
  if jq -e 'type == "array" and length == 2 and all(.[]; .carrier == "codex-tui") and
      ([.[].codexHome] | unique | length) == 2 and
      ([.[].stateDir] | unique | length) == 2 and
      ([.[].runtimePidFile] | unique | length) == 2' \
      "$CXX_DIR/launchd-leads.json" >/dev/null 2>&1 \
      && [[ "$CXX_WINDOWS" == $'test-slot-34-flywheel-test-34\ntest-slot-34-flywheel-test-35' ]] \
      && [[ -f "$CXX_DIR/q/34/codex-runtime-env.json" \
          && -f "$CXX_DIR/q/35/codex-runtime-env.json" ]]; then
    pass "CXX: main + extra Codex Leads retain distinct home/state/window coordinates"
  else
    fail "CXX: two-Lead Codex topology collided" "$CXX_WINDOWS"
  fi
  FLY1389_TOOL_BIN="$CODEX_TOOL_BIN" FLY1389_QA_TMUX="$REAL_TMUX" \
    run_teardown "$FH1" "$CODEX_SLOT" || fail "CXX: multi-Codex teardown"
else
  fail "CXX: multi-Codex deploy failed" \
    "$(tail -40 "$CXX_ERR") | lead-log: $(tail -40 "/tmp/flywheel-test-slot-${CODEX_SLOT}/lead.log" 2>/dev/null || true)"
  FLY1389_TOOL_BIN="$CODEX_TOOL_BIN" FLY1389_QA_TMUX="$REAL_TMUX" \
    run_teardown "$FH1" "$CODEX_SLOT" || true
fi

# A production Lead source home is denied before any per-Lead artifact is made.
PROD_CODEX_SOURCE="$FH1/.codex-mufasa"
rm -rf "$PROD_CODEX_SOURCE"
cp -R "$CODEX_SOURCE_MAIN" "$PROD_CODEX_SOURCE"
jq --arg source "$PROD_CODEX_SOURCE" '.slots[33].codexSourceHome = $source' \
  "$FH1/.flywheel/test-slots.json" > "$SB/slots-production-source.json"
mv "$SB/slots-production-source.json" "$FH1/.flywheel/test-slots.json"
rm -rf "/tmp/flywheel-test-slot-${CODEX_SLOT}.lock" "/tmp/flywheel-test-slot-${CODEX_SLOT}"
CXP_OUT="$SB/cxp-out"; CXP_ERR="$SB/cxp-err"
if FLY1389_TOOL_BIN="$CODEX_TOOL_BIN" FLY1389_QA_TMUX="$REAL_TMUX" \
    run_deploy "$FH1" "$CODEX_SLOT" "$CXP_OUT" "$CXP_ERR" --lead-ready-timeout 1; then
  fail "CXP: production Codex source home must be rejected"
  FLY1389_TOOL_BIN="$CODEX_TOOL_BIN" FLY1389_QA_TMUX="$REAL_TMUX" \
    run_teardown "$FH1" "$CODEX_SLOT" || true
elif grep -q 'refusing production Lead codex home' "$CXP_ERR" \
    && [[ ! -e "/tmp/flywheel-test-slot-${CODEX_SLOT}/cdxh" \
        && ! -e "/tmp/flywheel-test-slot-${CODEX_SLOT}/launchd/flywheel-test-34" \
        && ! -e "/tmp/flywheel-test-slot-${CODEX_SLOT}/q/34" ]]; then
  pass "CXP: production Codex source home is rejected before Lead artifacts"
else
  fail "CXP: production-home rejection was late or ambiguous" "$(tail -30 "$CXP_ERR")"
fi
make_slots_json > "$FH1/.flywheel/test-slots.json"
rm -rf "/tmp/flywheel-test-slot-${CODEX_SLOT}"

# Codex is intentionally unsupported in the existing roundtable topology.
jq '.roundtableChannel = {
      channelId:"45454545454545454", hostSlot:34, memberSlots:[35],
      triggerMode:"any_top_level", replyInThread:false, autoContinue:false
    }' "$FH1/.flywheel/test-slots.json" > "$SB/slots-roundtable.json"
mv "$SB/slots-roundtable.json" "$FH1/.flywheel/test-slots.json"
CXR_OUT="$SB/cxr-out"; CXR_ERR="$SB/cxr-err"
if FLY1389_TOOL_BIN="$CODEX_TOOL_BIN" FLY1389_QA_TMUX="$REAL_TMUX" \
    run_deploy "$FH1" "$CODEX_SLOT" "$CXR_OUT" "$CXR_ERR" --mode roundtable --lead-ready-timeout 1; then
  fail "CXR: Codex roundtable topology must be rejected"
  FLY1389_TOOL_BIN="$CODEX_TOOL_BIN" FLY1389_QA_TMUX="$REAL_TMUX" \
    run_teardown "$FH1" "$CODEX_SLOT" || true
elif grep -q 'codex carrier is not supported in roundtable mode' "$CXR_ERR"; then
  pass "CXR: Codex roundtable topology rejects fail-loud"
else
  fail "CXR: Codex roundtable failed at the wrong boundary" "$(tail -30 "$CXR_ERR")"
fi
make_slots_json > "$FH1/.flywheel/test-slots.json"
rm -rf "/tmp/flywheel-test-slot-${CODEX_SLOT}"

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
