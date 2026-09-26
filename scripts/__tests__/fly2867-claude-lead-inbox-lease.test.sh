#!/usr/bin/env bash
# FLY-2867: a Claude-carrier Lead in a 529 room can only become ready when its
# flywheel-inbox MCP server is registered and writes the .inbox-ready lease at
# the path test-deploy.sh waits on (${SLOT_DIR}/state/comm/<project>/).
#
#   L1  qa_room_claude_lead_mcp_missing: the preflight artifact assertion.
#   L2  qa_room_claude_lease_diagnosis: every timeout reason token, and no
#       .mcp.json value (it carries credentials) is ever printed.
#   L3  real claude-lead.sh dry-run with the 529 room coordinate shape
#       registers flywheel-inbox from this checkout's inbox-mcp dist.
#   L4  the exact flywheel-inbox entry L3 wrote, launched the way Claude Code
#       launches a stdio MCP server, writes a live lease at the room's lease
#       path (with and without an inherited FLYWHEEL_COMM_ROOT) and removes it
#       on SIGTERM.
#
# Requires built packages/teamlead and packages/inbox-mcp dists (CI builds the
# workspace before shell suites). A missing dist FAILS; it is never a skip.
# Discord channel readiness needs a real gateway and is proven only in a room.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; shift; [ $# -gt 0 ] && echo "        $*"; }

SB="$(mktemp -d /tmp/fly2867-lease.XXXXXX)"
INBOX_PIDS=()
cleanup() {
  local pid
  for pid in ${INBOX_PIDS[@]+"${INBOX_PIDS[@]}"}; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  rm -rf "$SB"
}
trap cleanup EXIT

# shellcheck source=../lib/qa-room.sh
source "$ROOT/scripts/lib/qa-room.sh"

# ── L1: preflight artifact assertion ─────────────────────────────────────────
L1_REPO="$SB/l1-repo"
mkdir -p "$L1_REPO"
L1_OK=1
l1_out=$(qa_room_claude_lead_mcp_missing "$L1_REPO"); l1_rc=$?
[[ "$l1_rc" != 0 && "$l1_out" == $'packages/inbox-mcp/dist/index.js\npackages/terminal-mcp/dist/index.js' ]] \
  || { L1_OK=0; fail "L1: empty checkout must report both MCP entries" "rc=$l1_rc out=[$l1_out]"; }
mkdir -p "$L1_REPO/packages/terminal-mcp/dist"
: > "$L1_REPO/packages/terminal-mcp/dist/index.js"
l1_out=$(qa_room_claude_lead_mcp_missing "$L1_REPO"); l1_rc=$?
[[ "$l1_rc" != 0 && "$l1_out" == "packages/inbox-mcp/dist/index.js" ]] \
  || { L1_OK=0; fail "L1: a missing inbox-mcp dist alone must fail" "rc=$l1_rc out=[$l1_out]"; }
mkdir -p "$L1_REPO/packages/inbox-mcp/dist"
: > "$L1_REPO/packages/inbox-mcp/dist/index.js"
l1_out=$(qa_room_claude_lead_mcp_missing "$L1_REPO"); l1_rc=$?
[[ "$l1_rc" == 0 && -z "$l1_out" ]] \
  || { L1_OK=0; fail "L1: a built checkout must pass silently" "rc=$l1_rc out=[$l1_out]"; }
[[ "$L1_OK" == 1 ]] && pass "L1: preflight names each missing Claude Lead MCP dist entry"

# ── L2: lease-timeout diagnosis tokens ──────────────────────────────────────
CANARY="fly2867-canary-token-$$"
L2_WS="$SB/l2-ws"
L2_LEASE="$SB/l2-comm/.inbox-ready-qa-lead"
L2_REF="$SB/l2-lead.plist"
mkdir -p "$L2_WS" "$(dirname "$L2_LEASE")"
L2_OK=1
l2_expect() {  # <expected-token> <label> [launch-ref]
  local got
  got=$(qa_room_claude_lease_diagnosis "$L2_WS" "$L2_LEASE" ${3:+"$3"} 2>&1)
  if [[ "$got" != "$1" ]]; then
    L2_OK=0; fail "L2: $2" "expected=$1 got=[$got]"
  fi
  if [[ "$got" == *"$CANARY"* ]]; then
    L2_OK=0; fail "L2: $2 leaked a .mcp.json value"
  fi
}
l2_expect mcp_config_missing "no .mcp.json"
printf '{"mcpServers": {"flywheel-terminal": {"env": {"TEAMLEAD_API_TOKEN": "%s"}}' "$CANARY" \
  > "$L2_WS/.mcp.json"
l2_expect mcp_config_unreadable "truncated .mcp.json"
printf '["%s"]\n' "$CANARY" > "$L2_WS/.mcp.json"
l2_expect mcp_config_unreadable "non-object .mcp.json"
printf '{"mcpServers": {"flywheel-terminal": {"env": {"TEAMLEAD_API_TOKEN": "%s"}}}}\n' "$CANARY" \
  > "$L2_WS/.mcp.json"
l2_expect inbox_mcp_unregistered "flywheel-inbox not registered (the FLY-2867 shape)"
# A config written before this launch's plist belongs to an earlier run.
# Fixed mtimes keep the comparison deterministic on any filesystem.
: > "$L2_REF"
touch -t 202609240100.00 "$L2_REF"
touch -t 202609240059.00 "$L2_WS/.mcp.json"
l2_expect mcp_config_stale "config older than this launch" "$L2_REF"
touch -t 202609240100.00 "$L2_WS/.mcp.json"
l2_expect mcp_config_stale "config from the same instant as the launch" "$L2_REF"
touch -t 202609240101.00 "$L2_WS/.mcp.json"
l2_expect inbox_mcp_unregistered "fresh config newer than this launch" "$L2_REF"
l2_expect inbox_mcp_unregistered "an absent launch reference skips the staleness check" "$SB/no-such.plist"
# A find that fails proves nothing about age: fall through to the key set
# instead of reporting a stale config.
touch -t 202609240059.00 "$L2_WS/.mcp.json"
find() { return 1; }
l2_expect inbox_mcp_unregistered "a failing freshness probe is not read as stale" "$L2_REF"
unset -f find
touch -t 202609240101.00 "$L2_WS/.mcp.json"
printf '{"mcpServers": {"flywheel-inbox": {"env": {"FLYWHEEL_COMM_DB": "%s"}}}}\n' "$CANARY" \
  > "$L2_WS/.mcp.json"
l2_expect lease_absent "registered but no lease"
printf '{"flywheel-inbox": {"env": {"FLYWHEEL_COMM_DB": "%s"}}}\n' "$CANARY" > "$L2_WS/.mcp.json"
l2_expect lease_absent "flat server map is accepted like claude-lead.sh's launch plan"
sleep 60 & l2_live=$!
INBOX_PIDS+=("$l2_live")
printf '{"pid": %s, "startedAt": "2026-09-24T00:00:00.000Z"}\n' "$l2_live" > "$L2_LEASE"
l2_expect lease_live "lease with a live pid"
kill -TERM "$l2_live" 2>/dev/null; wait "$l2_live" 2>/dev/null
l2_expect lease_pid_dead "lease with a dead pid"
[[ "$L2_OK" == 1 ]] && pass "L2: lease-timeout diagnosis names every cause without printing values"

# ── L3: real claude-lead.sh registers flywheel-inbox in the room shape ──────
LEAD_SH="$ROOT/packages/teamlead/scripts/claude-lead.sh"
INBOX_BIN="$ROOT/packages/inbox-mcp/dist/index.js"
if [[ ! -f "$ROOT/packages/teamlead/dist/ProjectConfig.js" || ! -f "$INBOX_BIN" ]]; then
  fail "L3: teamlead and inbox-mcp dists must be built (pnpm build) — refusing to skip"
  echo ""; echo "Results: ${PASSED} passed, ${FAILED} failed"; exit 1
fi
H="$SB/home"
SLOT="$SB/slot"
PROJECT="geoforge3d"
AGENT="product-lead"
WS="$SLOT/extra-leads/slot-9/lead-workspace"
COMM_ROOT="$SLOT/state/comm"
COMM_DB="$COMM_ROOT/$PROJECT/comm.db"
LEASE="$COMM_ROOT/$PROJECT/.inbox-ready-$AGENT"
mkdir -p "$H/proj-gf/.lead/$AGENT" "$H/.flywheel" "$WS" "$COMM_ROOT/$PROJECT"
printf '%s\n' '{"granularity":"per-lead","setBy":"test","setAt":"2026-08-28T00:00:00.000Z"}' \
  > "$H/.flywheel/summary-config.json"
printf -- '---\nname: %s\n---\nPeter\n' "$AGENT" > "$H/proj-gf/.lead/$AGENT/identity.md"
PROJECTS=$(jq -cn --arg root "$H/proj-gf" --arg agent "$AGENT" --arg project "$PROJECT" '
  [{projectName: $project, projectRoot: $root, leads: [{
    agentId: $agent, summaryRole: "producer", chatChannel: "222",
    match: {labels: ["Product"]}, botTokenEnv: "PETER_BOT_TOKEN",
    botUserId: "10000000000000002", canSpawnRunners: true}]}]')
L3_OUT="$SB/l3.out"
env -i HOME="$H" PATH="$PATH" \
  FLYWHEEL_LEAD_DRY_RUN=1 FLYWHEEL_PROJECTS="$PROJECTS" \
  DISCORD_BOT_TOKEN="$CANARY" TEAMLEAD_API_TOKEN="$CANARY" \
  LEAD_WORKSPACE="$WS" FLYWHEEL_COMM_DB="$COMM_DB" FLYWHEEL_COMM_ROOT="$COMM_ROOT" \
  bash "$LEAD_SH" "$AGENT" "$H/proj-gf" "$PROJECT" > "$L3_OUT" 2>&1
L3_OK=1
grep -qF $'MCP_SERVER\tflywheel-inbox' "$L3_OUT" \
  || { L3_OK=0; fail "L3: launch plan does not register flywheel-inbox" "$(grep -E 'MCP|inbox' "$L3_OUT" | head -5)"; }
jq -e --arg bin "$INBOX_BIN" --arg db "$COMM_DB" --arg agent "$AGENT" --arg project "$PROJECT" '
  .mcpServers["flywheel-inbox"] as $s
  | $s.command == "node" and $s.args == [$bin]
    and $s.env.FLYWHEEL_COMM_DB == $db and $s.env.FLYWHEEL_LEAD_ID == $agent
    and $s.env.FLYWHEEL_PROJECT_NAME == $project
' "$WS/.mcp.json" >/dev/null 2>&1 \
  || { L3_OK=0; fail "L3: .mcp.json flywheel-inbox entry is not bound to this checkout and room coordinates"; }
[[ "$(qa_room_claude_lease_diagnosis "$WS" "$LEASE")" == lease_absent ]] \
  || { L3_OK=0; fail "L3: diagnosis of the generated config should be lease_absent"; }
[[ "$L3_OK" == 1 ]] && pass "L3: real claude-lead.sh registers flywheel-inbox for the room coordinates"

# ── L4: that exact entry writes the lease where test-deploy waits ───────────
l4_run() {  # <label> [extra env assignment...]
  local label="$1" pid i ok=1 lease_pid line fifo="$SB/l4-$1.stdin"
  local entry_env=()
  shift
  rm -f "$LEASE"
  while IFS= read -r line; do
    entry_env+=("$line")
  done < <(jq -r '.mcpServers["flywheel-inbox"].env | to_entries[] | "\(.key)=\(.value)"' "$WS/.mcp.json")
  # A stdio MCP server lives as long as its client keeps stdin open; hold the
  # write end of a FIFO the way Claude Code holds the pipe.
  mkfifo "$fifo"
  env -i HOME="$H" PATH="$PATH" "${entry_env[@]}" "$@" \
    "$(jq -r '.mcpServers["flywheel-inbox"].command' "$WS/.mcp.json")" \
    "$(jq -r '.mcpServers["flywheel-inbox"].args[0]' "$WS/.mcp.json")" \
    <"$fifo" 2>"$SB/l4-$label.err" &
  pid=$!
  INBOX_PIDS+=("$pid")
  exec 9>"$fifo"
  for i in $(seq 1 100); do
    [[ -f "$LEASE" ]] && break
    sleep 0.1
  done
  lease_pid=$(jq -r '.pid // empty' "$LEASE" 2>/dev/null || true)
  [[ "$lease_pid" == "$pid" ]] && kill -0 "$pid" 2>/dev/null \
    || { ok=0; fail "L4 ($label): no live lease at the room lease path" "lease_pid=${lease_pid:-none} pid=$pid stderr=$(tail -3 "$SB/l4-$label.err")"; }
  [[ "$(qa_room_claude_lease_diagnosis "$WS" "$LEASE")" == lease_live ]] \
    || { ok=0; fail "L4 ($label): diagnosis of a live lease"; }
  kill -TERM "$pid" 2>/dev/null
  for i in $(seq 1 50); do
    [[ -f "$LEASE" ]] || break
    sleep 0.1
  done
  [[ ! -f "$LEASE" ]] || { ok=0; fail "L4 ($label): SIGTERM left the lease behind"; }
  exec 9>&-
  wait "$pid" 2>/dev/null
  [[ "$ok" == 1 ]]
}
L4_OK=1
l4_run entry-env || L4_OK=0
l4_run inherited-comm-root "FLYWHEEL_COMM_ROOT=$COMM_ROOT" || L4_OK=0
[[ "$L4_OK" == 1 ]] && pass "L4: the registered inbox MCP writes a live lease at the room lease path and removes it on SIGTERM"

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]] || exit 1
