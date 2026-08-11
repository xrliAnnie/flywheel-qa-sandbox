#!/bin/bash
# QA FLY-1697 — independent end-to-end verification.
#
# Chain under test (production entry points, nothing stubbed except the Claude
# child itself and the agent-team transport probe):
#   flywheel-lead-wrapper-v2.sh  (the exact script launchd runs)
#     -> real tmux server on an isolated private socket
#       -> real lead-body.sh   (sets FLYWHEEL_LEAD_CARRIER=v2 + BODY_V2=1)
#         -> real claude-lead.sh v2 one-shot block  <-- the fix under test
#           -> fake `claude` child that runs the REAL flywheel-comm
#              handle-receipt --action ack against a real comm.db seeded
#              with a real Discord chat receipt in the production shape.
#
# Deliberately NOT stubbed: ps (so holder liveness is the real process table),
# tmux (so the body is a real pane process), the flywheel-comm CLI, the mailbox
# code paths, the lease store.
set -uo pipefail

ROOT="${QA1697_ROOT:?QA1697_ROOT (flywheel worktree) required}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$ROOT/scripts/flywheel-lead-wrapper-v2.sh"
DIST="$ROOT/packages/flywheel-comm/dist"
COMM_CLI="$DIST/index.js"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }
info(){ printf '  ... %s\n' "$1"; }

PROJECT=qafly
LEAD=qa-eng-lead
LEAD_KEY="${PROJECT}-${LEAD}"
MESSAGE_ID=1536796650813530142
RECEIPT_ID="chat:${LEAD}:${MESSAGE_ID}"

WORK="$(mktemp -d /tmp/qa1697.XXXXXX)"
SOCKET=""
cleanup() {
  [ -z "$SOCKET" ] || tmux -S "$SOCKET" kill-server >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

HOME_DIR="$WORK/home"
PROJECT_DIR="$WORK/project"
BIN_DIR="$WORK/bin"
STATE_DIR="$HOME_DIR/.flywheel"
PROJECTS_FILE="$STATE_DIR/projects.json"
LEASE_DB="$STATE_DIR/lead-lease.db"
COMM_DB="$STATE_DIR/comm/$PROJECT/comm.db"
MANIFEST="$WORK/manifest.json"
CHILD_ENV="$WORK/child.env"
ACK_OUT="$WORK/ack.out"
ACK_RC="$WORK/ack.rc"
RELEASE="$WORK/release"

mkdir -p "$STATE_DIR/claude-sessions" "$STATE_DIR/comm/$PROJECT" \
  "$PROJECT_DIR/.lead/$LEAD" "$BIN_DIR" "$HOME_DIR/claude-config" \
  "$STATE_DIR/alert-queue"
printf '%s\n' '---' "name: $LEAD" '---' 'QA Lead' \
  > "$PROJECT_DIR/.lead/$LEAD/identity.md"
printf 'qa-session-fly1697\n' > "$STATE_DIR/claude-sessions/${PROJECT}-${LEAD}.session-id"

cat > "$PROJECTS_FILE" <<JSON
[{"projectName":"$PROJECT","projectRoot":"$PROJECT_DIR","leads":[{"agentId":"$LEAD","backend":"claude-code","carrier":"v2","botTokenEnv":"QA_TOKEN","chatChannel":"1536630545927245905","match":{"labels":["QA"]}}]}]
JSON
cat > "$STATE_DIR/.env" <<'ENV'
QA_TOKEN=fixture-discord-token
FLYWHEEL_COMM_BACKEND=mailbox
FLYWHEEL_MAILBOX_DISCORD=1
FLYWHEEL_LEAD_RULES_BUNDLE=legacy
ENV

# --- fake Claude child: the real product consumer of the pane claim ----------
cat > "$BIN_DIR/claude" <<CHILD
#!/bin/bash
env | LC_ALL=C sort > "$CHILD_ENV"
if [ -f "$WORK/do-ack" ]; then
  node "\${QA1697_ACK_CLI:-$COMM_CLI}" handle-receipt \\
    --receipt "$RECEIPT_ID" --lead "$LEAD" --project "$PROJECT" \\
    --request-id "qa-fly1697-\$\$" --action ack --json \\
    > "$ACK_OUT" 2>&1
  printf '%s\n' "\$?" > "$ACK_RC"
fi
while [ ! -f "$RELEASE" ]; do sleep 0.05; done
exit 0
CHILD
cat > "$BIN_DIR/agent-team-transport" <<'SH'
#!/bin/bash
case "${1:-}" in
  preflight) exit 0 ;;
  vendor) printf 'claude\n' ;;
  lead-env) printf 'export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\n' ;;
  lead-args) printf 'FLYWHEEL_AGENT_TEAM_ARGS=()\n' ;;
  *) exit 2 ;;
esac
SH
chmod +x "$BIN_DIR/claude" "$BIN_DIR/agent-team-transport"

cat > "$MANIFEST" <<JSON
{"leadId":"$LEAD","projectDir":"$PROJECT_DIR","projectName":"$PROJECT",
 "botTokenEnv":"QA_TOKEN","workspace":"$PROJECT_DIR","mcpExclude":"chrome",
 "chromeEnabled":false,
 "launchEnvironment":{
   "FLYWHEEL_COMM_CLI":"$COMM_CLI",
   "TEST_SKIP_PLUGIN_FORK_CHECK":"1",
   "TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR":"$HOME_DIR/claude-config"
 }}
JSON

wrapper_env() {
  env -i \
    "HOME=$HOME_DIR" \
    "PATH=$BIN_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "USER=$(/usr/bin/id -un)" "LOGNAME=$(/usr/bin/id -un)" \
    "TERM=xterm-256color" "TMPDIR=/tmp" \
    "FLYWHEEL_DIR=$ROOT" \
    "FLYWHEEL_STATE_DIR=$STATE_DIR" \
    "FLYWHEEL_PROJECTS_FILE=$PROJECTS_FILE" \
    "FLYWHEEL_WRAPPER_ENV_FILE=$STATE_DIR/.env" \
    "CLAUDE_CONFIG_DIR=$HOME_DIR/claude-config" \
    "$@"
}

start_body() {
  rm -f "$CHILD_ENV" "$ACK_OUT" "$ACK_RC" "$RELEASE"
  wrapper_env bash "${1:-$WRAPPER}" "$MANIFEST" > "$WORK/wrapper.log" 2>&1 &
  local i=0
  while [ "$i" -lt 400 ] && [ ! -s "$CHILD_ENV" ]; do sleep 0.05; i=$((i + 1)); done
  [ -s "$CHILD_ENV" ]
}
stop_body() { : > "$RELEASE"; sleep 1; }

wait_for_ack() {
  local i=0
  while [ "$i" -lt 600 ] && [ ! -s "$ACK_RC" ]; do sleep 0.05; i=$((i + 1)); done
  [ -s "$ACK_RC" ]
}

body_pid() {
  tmux -S "$SOCKET" list-panes -a -F '#{pane_pid}' 2>/dev/null | head -1
}

# ---------------------------------------------------------------------------
printf '\n== Fixture: production-shaped stale lease + real Discord receipt ==\n'

# Exactly the production incident shape: an unbound generation whose recorded
# supervisor tuple is conclusively dead (the 16 rows frozen at Aug 10 08:36).
if wrapper_env node "$COMM_CLI" lead-lease acquire \
  --lead "$LEAD" --project "$PROJECT" \
  --supervisor-pid 999123 --supervisor-start "Mon Aug 10 08:36:08 2026" \
  --acquired-by "qa-fly1697-fixture" --json > "$WORK/stale.json" 2>"$WORK/stale.err"; then
  STALE_GEN="$(jq -r '.generation' "$WORK/stale.json")"
  info "stale generation = $STALE_GEN (unbound, dead supervisor tuple)"
  ok "fixture reproduces the production stale-unbound lease row"
else
  bad "could not seed the stale lease row"; cat "$WORK/stale.err" >&2
  STALE_GEN=0
fi

SEED="$(wrapper_env node "$HERE/seed-receipt.mjs" "$DIST" "$COMM_DB" "$LEAD" \
  "$MESSAGE_ID" "I didnt see 1686 design session" 2>&1)"
if printf '%s' "$SEED" | jq -e '.state == "ACKED" and .carrier == "inbox" and .settlement == null' >/dev/null 2>&1; then
  info "$SEED"
  ok "receipt seeded in the production shape (inbox carrier, ACKED, unsettled)"
else
  bad "receipt seeding did not reach the production shape: $SEED"
fi

SOCKET="$(wrapper_env bash -c 'source "$FLYWHEEL_DIR/scripts/lib/lead-address.sh"; derive_lead_socket "'"$PROJECT/$LEAD"'" "$FLYWHEEL_STATE_DIR"')"
info "private socket = $SOCKET"

# ---------------------------------------------------------------------------
printf '\n== A. Fixed code: real launchd-native body binds and settles ==\n'
: > "$WORK/do-ack"
if start_body; then
  BPID="$(body_pid)"
  READINESS="$(wrapper_env node "$COMM_CLI" lead-lease readiness --local-only --json 2>/dev/null)"
  ROW="$(printf '%s' "$READINESS" | jq -c --arg k "$LEAD_KEY" '.local.leads[]? | select(.leadKey == $k)')"
  info "body pane pid = $BPID"
  info "lease row = $ROW"
  if printf '%s' "$ROW" | jq -e --argjson pid "${BPID:-0}" --argjson g "$((STALE_GEN + 1))" \
      '.ready == true and .lease.bound == true and .lease.holderAlive == true
       and .lease.pid == $pid and .lease.generation == $g' >/dev/null 2>&1; then
    ok "A1 lease bound to the live body tuple (real ps), generation advanced to $((STALE_GEN + 1))"
  else
    bad "A1 lease did not bind to the live body: $ROW"
    tail -30 "$WORK/wrapper.log" >&2
  fi
  # Independent liveness confirmation straight from the OS process table.
  LPID="$(printf '%s' "$ROW" | jq -r '.lease.pid')"
  LSTART="$(printf '%s' "$ROW" | jq -r '.lease.lstart' | sed 's/^ *//;s/ *$//')"
  PS_START="$(LC_ALL=C ps -p "$LPID" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//')"
  if [ -n "$PS_START" ] && [ "$PS_START" = "$LSTART" ]; then
    ok "A2 recorded holder tuple matches the live OS process table ($LPID / $PS_START)"
  else
    bad "A2 holder tuple does not match the OS ($LPID: ps='$PS_START' lease='$LSTART')"
  fi
  if grep -q "^FLYWHEEL_LEAD_LEASE_KEY=${LEAD_KEY}$" "$CHILD_ENV" \
    && grep -q "^FLYWHEEL_LEAD_GENERATION=$((STALE_GEN + 1))$" "$CHILD_ENV" \
    && grep -q '^FLYWHEEL_LEAD_CARRIER=v2$' "$CHILD_ENV"; then
    ok "A3 the v2 pane env carries the bound claim across the env -i barrier"
  else
    bad "A3 pane env did not carry the claim"
    grep -E '^FLYWHEEL_LEAD_(LEASE|GENERATION|CARRIER)' "$CHILD_ENV" >&2 || true
  fi
  wait_for_ack || true
  if [ "$(cat "$ACK_RC" 2>/dev/null)" = "0" ]; then
    info "ack output: $(cat "$ACK_OUT")"
    ok "A4 handle-receipt --action ack SUCCEEDS from the real pane (no reply_to)"
  else
    bad "A4 handle-receipt failed: rc=$(cat "$ACK_RC" 2>/dev/null) $(cat "$ACK_OUT" 2>/dev/null)"
  fi
  PROBE="$(wrapper_env node "$HERE/probe.mjs" "$DIST" "$COMM_DB" "$LEAD" "$RECEIPT_ID")"
  info "probe: $PROBE"
  if printf '%s' "$PROBE" | jq -e '.settlement == "processed" and .pendingRedeliverySelected == false' >/dev/null 2>&1; then
    ok "A5 receipt is terminally settled (processed) and no longer selected for redelivery"
  else
    bad "A5 receipt not settled / still redeliverable: $PROBE"
  fi
  stop_body
else
  bad "A0 real wrapper chain never reached the Claude child"
  tail -40 "$WORK/wrapper.log" >&2
fi

# ---------------------------------------------------------------------------
printf '\n== B. Control: shell half removed (mutation) ==\n'
SCRATCH="$WORK/scratch"
mkdir -p "$SCRATCH/packages/teamlead" "$SCRATCH/scripts"
cp -R "$ROOT/packages/teamlead/scripts" "$SCRATCH/packages/teamlead/scripts"
ln -s "$ROOT/packages/teamlead/dist" "$SCRATCH/packages/teamlead/dist"
cp "$ROOT/scripts/flywheel-lead-wrapper-v2.sh" "$SCRATCH/scripts/"
ln -s "$ROOT/scripts/lib" "$SCRATCH/scripts/lib"
sed -i.bak 's/^[[:space:]]*lead_identity_v2_acquire_bind \\/    true \\/' \
  "$SCRATCH/packages/teamlead/scripts/claude-lead.sh"
rm -f "$LEASE_DB" "$LEASE_DB-wal" "$LEASE_DB-shm"
# Run the mutated body through its own copied tree (FLYWHEEL_DIR must point at
# the scratch so lead-body.sh + claude-lead.sh resolve to the mutated copies).
start_body_in() {
  rm -f "$CHILD_ENV" "$ACK_OUT" "$ACK_RC" "$RELEASE"
  env -i \
    "HOME=$HOME_DIR" \
    "PATH=$BIN_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "USER=$(/usr/bin/id -un)" "LOGNAME=$(/usr/bin/id -un)" \
    "TERM=xterm-256color" "TMPDIR=/tmp" \
    "FLYWHEEL_DIR=$1" \
    "FLYWHEEL_STATE_DIR=$STATE_DIR" \
    "FLYWHEEL_PROJECTS_FILE=$PROJECTS_FILE" \
    "FLYWHEEL_WRAPPER_ENV_FILE=$STATE_DIR/.env" \
    "CLAUDE_CONFIG_DIR=$HOME_DIR/claude-config" \
    bash "$1/scripts/flywheel-lead-wrapper-v2.sh" "$MANIFEST" > "$WORK/wrapper.log" 2>&1 &
  local i=0
  while [ "$i" -lt 400 ] && [ ! -s "$CHILD_ENV" ]; do sleep 0.05; i=$((i + 1)); done
  [ -s "$CHILD_ENV" ]
}
# reset the receipt for the control run
rm -f "$COMM_DB" "$COMM_DB-wal" "$COMM_DB-shm"
wrapper_env node "$HERE/seed-receipt.mjs" "$DIST" "$COMM_DB" "$LEAD" \
  "$MESSAGE_ID" "control run" > "$WORK/seed2.json" 2>&1
if start_body_in "$SCRATCH"; then
  wait_for_ack || true
  if ! grep -q '^FLYWHEEL_LEAD_LEASE_KEY=' "$CHILD_ENV" \
    && [ "$(cat "$ACK_RC" 2>/dev/null)" != "0" ] \
    && grep -q "requires a validated Lead lease generation" "$ACK_OUT"; then
    ok "B1 without the v2 identity step the pane has no claim and ack fails with the exact production error"
    info "control error: $(head -c 200 "$ACK_OUT")"
  else
    bad "B1 mutation control stayed green: claim=$(grep -c '^FLYWHEEL_LEAD_LEASE_KEY=' "$CHILD_ENV") rc=$(cat "$ACK_RC" 2>/dev/null) out=$(head -c 200 "$ACK_OUT" 2>/dev/null)"
  fi
  stop_body
else
  bad "B1 mutation control body never launched"
  tail -30 "$WORK/wrapper.log" >&2
fi

# ---------------------------------------------------------------------------
printf '\n== C. Control: TypeScript half reverted (pre-fix authorize) ==\n'
PREFIX_DIST="$WORK/prefix/dist"
mkdir -p "$WORK/prefix"
cp -R "$DIST" "$PREFIX_DIST"
ln -sfn "$ROOT/packages/flywheel-comm/node_modules" "$WORK/prefix/node_modules"
python3 - "$PREFIX_DIST/lead-lease.js" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p).read()
needle = """        env.FLYWHEEL_LEAD_CARRIER === "v2" &&
        !env.FLYWHEEL_LEAD_LEASE_KEY &&
        !env.FLYWHEEL_LEAD_GENERATION &&
        !env.FLYWHEEL_LEAD_LEASE_DEGRADED) {"""
repl = """        env.FLYWHEEL_LEAD_CARRIER === "v2") {"""
if needle not in s:
    sys.stderr.write("PATCH-TARGET-NOT-FOUND\n"); sys.exit(3)
open(p, "w").write(s.replace(needle, repl, 1))
PY
if [ $? -ne 0 ]; then
  bad "C0 could not build the pre-fix dist control"
else
  rm -f "$LEASE_DB" "$LEASE_DB-wal" "$LEASE_DB-shm"
  rm -f "$COMM_DB" "$COMM_DB-wal" "$COMM_DB-shm"
  wrapper_env node "$HERE/seed-receipt.mjs" "$DIST" "$COMM_DB" "$LEAD" \
    "$MESSAGE_ID" "prefix control" > "$WORK/seed3.json" 2>&1
  # Fixed shell (claim IS in the pane env) + pre-fix authorize => passthrough.
  cat > "$BIN_DIR/claude" <<CHILD
#!/bin/bash
env | LC_ALL=C sort > "$CHILD_ENV"
node "$PREFIX_DIST/index.js" handle-receipt \\
  --receipt "$RECEIPT_ID" --lead "$LEAD" --project "$PROJECT" \\
  --request-id "qa-fly1697-prefix-\$\$" --action ack --json \\
  > "$ACK_OUT" 2>&1
printf '%s\n' "\$?" > "$ACK_RC"
while [ ! -f "$RELEASE" ]; do sleep 0.05; done
exit 0
CHILD
  chmod +x "$BIN_DIR/claude"
  if start_body; then
    wait_for_ack || true
    if grep -q "^FLYWHEEL_LEAD_LEASE_KEY=${LEAD_KEY}$" "$CHILD_ENV" \
      && [ "$(cat "$ACK_RC" 2>/dev/null)" != "0" ] \
      && grep -q "requires a validated Lead lease generation" "$ACK_OUT"; then
      ok "C1 with a valid claim in the pane, the PRE-FIX authorize still passthroughs and ack fails — the TS half is load-bearing"
      info "control error: $(head -c 200 "$ACK_OUT")"
    else
      bad "C1 pre-fix dist control did not reproduce the failure: rc=$(cat "$ACK_RC" 2>/dev/null) out=$(head -c 200 "$ACK_OUT" 2>/dev/null)"
    fi
    stop_body
  else
    bad "C1 pre-fix control body never launched"
    tail -30 "$WORK/wrapper.log" >&2
  fi
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
