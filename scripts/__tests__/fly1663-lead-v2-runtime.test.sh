#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WRAPPER="$ROOT/scripts/flywheel-lead-wrapper-v2.sh"
RECEIPT_LIB="$ROOT/packages/teamlead/scripts/lib/lead-body-receipt.sh"
ADDRESS_LIB="$ROOT/scripts/lib/lead-address.sh"
TMP="$(mktemp -d /tmp/fly1663-v2.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

# The wrapper intentionally rejects inherited identity. Keep this harness
# independent from the resident Runner's own Lead environment.
unset LEAD_ID FLYWHEEL_LEAD_ID PROJECT_NAME FLYWHEEL_PROJECT_NAME DISCORD_STATE_DIR

# shellcheck source=../lib/lead-address.sh
source "$ADDRESS_LIB"

mkdir -p "$TMP/home/.flywheel" "$TMP/project/.lead/ops-lead" "$TMP/bin"
cat > "$TMP/bin/ps" <<'PS_STUB'
#!/bin/bash
case "${FLYWHEEL_LEAD_V2_PS_MODE:-ok}" in
  ok) printf 'Mon Aug 11 12:34:56 2026\n' ;;
  empty) exit 0 ;;
  fail) printf 'simulated ps failure\n' >&2; exit 7 ;;
  tabbed) printf 'Mon Aug 11\t12:34:56 2026\n' ;;
  *) exit 64 ;;
esac
PS_STUB
chmod +x "$TMP/bin/ps"
export FLYWHEEL_LEAD_V2_PS_BIN="$TMP/bin/ps"
printf '%s\n' '---' 'name: ops-lead' '---' 'Ops Lead' \
  > "$TMP/project/.lead/ops-lead/identity.md"
cat > "$TMP/home/.flywheel/projects.json" <<JSON
[{"projectName":"demo","projectRoot":"$TMP/project","generalChannel":"123456789012345678","leads":[{"agentId":"ops-lead","chatChannel":"123456789012345678","match":{"labels":["Operations"]},"botTokenEnv":"OPS_TOKEN","botUserId":"22345678901234567","discordStateDir":"$TMP/discord-state"}]}]
JSON
cat > "$TMP/home/.flywheel/.env" <<'ENV'
OPS_TOKEN=discord-secret
TEAMLEAD_API_TOKEN=bridge-secret
FLYWHEEL_COMM_BACKEND=mailbox
ENV
cat > "$TMP/manifest.json" <<JSON
{"leadId":"ops-lead","projectDir":"$TMP/project","projectName":"demo","projectsFile":"$TMP/home/.flywheel/projects.json","workspace":"$TMP/custom-workspace","mcpExclude":"dangerous-mcp,chrome","chromeEnabled":true,"launchEnvironment":{"FLYWHEEL_WRAPPER_ENV_FILE":"$TMP/body.env","FLYWHEEL_LEAD_RULES_BUNDLE":"legacy","FLYWHEEL_LEAD_MODEL":"claude-fable-5","FLYWHEEL_LEAD_EFFORT":"max","FLYWHEEL_TEST_PLIST_ONLY":"preserved","USER":"manifest-user","LOGNAME":"manifest-logname"},"unknown":{"keep":true}}
JSON
mkdir -p "$TMP/custom-workspace"

out="$(
  HOME="$TMP/home" \
  FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
  FLYWHEEL_DIR="$ROOT" \
  FLYWHEEL_LEAD_V2_DRY_RUN=1 \
  bash "$WRAPPER" "$TMP/manifest.json" 2>&1
)" || true

if grep -q '^V2_SOCKET=' <<<"$out" \
  && grep -q '^V2_CONF=' <<<"$out" \
  && jq -e '.unknown.keep == true and (.pid | type == "number") and (.socketPath | type == "string")' \
    "$TMP/manifest.json" >/dev/null; then
  pass "wrapper derives its address and atomically preserves unknown manifest fields"
else
  fail "wrapper dry-run/manifest RMW contract"
  printf '%s\n' "$out"
fi

conf="$(sed -n 's/^V2_CONF=//p' <<<"$out" | tail -1)"
default_shell_line="$(grep -nF 'set -g default-shell /bin/bash' "$conf" 2>/dev/null | cut -d: -f1 || true)"
if [ -f "$conf" ] \
  && [[ "$conf" == */run/leads/demo-ops-lead/tmux.conf ]] \
  && grep -qF 'set -g exit-empty on' "$conf" \
  && [[ "$default_shell_line" =~ ^[1-9][0-9]*$ ]] \
  && grep -qF '#{hook_pane}' "$conf" \
  && grep -qF '= %0' "$conf" \
  && grep -qF 'tmux -S ' "$conf" \
  && ! grep -qF 'new-session' "$conf" \
  && ! grep -qF 'packages/teamlead/scripts/lead-body.sh' "$conf"; then
  pass "wrapper emits policy-only config without a lazy body command"
else
  fail "wrapper tmux config contract"
fi

# The private socket is the only body-ownership boundary. A second carrier
# must refuse an already-running server before it publishes its own PID.
mkdir -p "$TMP/home/.local/bin"
occupied_tmux="$TMP/home/.local/bin/tmux"
cat > "$occupied_tmux" <<'TMUX_OCCUPIED'
#!/bin/bash
exit 0
TMUX_OCCUPIED
chmod +x "$occupied_tmux"
jq '.pid = 4242' "$TMP/manifest.json" > "$TMP/manifest.occupied" \
  && mv "$TMP/manifest.occupied" "$TMP/manifest.json"
set +e
HOME="$TMP/home" \
  FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
  FLYWHEEL_DIR="$ROOT" \
  FLYWHEEL_LEAD_V2_TMUX_BIN="$occupied_tmux" \
  bash "$WRAPPER" "$TMP/manifest.json" >"$TMP/occupied.out" 2>&1
occupied_rc=$?
set -e
if [ "$occupied_rc" -ne 0 ] \
    && grep -qF 'private socket already has a live tmux server' "$TMP/occupied.out" \
    && [ "$(jq -r '.pid' "$TMP/manifest.json")" = 4242 ]; then
  pass "wrapper refuses a second private-socket body without changing manifest PID"
else
  fail "wrapper private-socket occupancy guard"
  cat "$TMP/occupied.out" 2>/dev/null || true
fi

# If the foreground exec cannot start, the launch attempt never owns a live
# server. It must leave the previous PID untouched so fleet classification is true.
failing_tmux="$TMP/home/.local/bin/tmux"
cat > "$failing_tmux" <<TMUX_FAILS
#!/bin/bash
if [[ "\$*" == *"has-session"* ]]; then exit 1; fi
if [[ "\$*" == *"new-session"* ]] && [[ " \$* " != *" -N "* ]]; then
  : > "$TMP/helper-daemonized-server"
  exit 0
fi
exit 42
TMUX_FAILS
chmod +x "$failing_tmux"
jq '.pid = 4242' "$TMP/manifest.json" > "$TMP/manifest.failing" \
  && mv "$TMP/manifest.failing" "$TMP/manifest.json"
set +e
HOME="$TMP/home" \
  FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
  FLYWHEEL_DIR="$ROOT" \
  FLYWHEEL_LEAD_V2_TMUX_BIN="$failing_tmux" \
  bash "$WRAPPER" "$TMP/manifest.json" >"$TMP/exec-fail.out" 2>&1
exec_fail_rc=$?
set -e
if [ "$exec_fail_rc" -eq 42 ] \
    && [ "$(jq -r '.pid' "$TMP/manifest.json")" = 4242 ] \
    && [ ! -e "$TMP/helper-daemonized-server" ]; then
  pass "failed tmux exec preserves manifest PID and the bootstrap client cannot daemonize"
else
  fail "wrapper failed-exec manifest PID rollback: rc=$exec_fail_rc pid=$(jq -r '.pid' "$TMP/manifest.json")"
  cat "$TMP/exec-fail.out" 2>/dev/null || true
fi

# A carrier cutover must preserve the existing plist EnvironmentVariables
# contract across the wrapper's env -i boundary. The manifest carries the
# transactionally captured dict, so values remain authoritative even when the
# selected .env contains conflicting assignments.
cat > "$TMP/home/.local/bin/tmux" <<TMUX_STUB
#!/bin/bash
if [[ "\$*" == *"has-session"* ]]; then exit 1; fi
if [[ " \$* " == *" -N "* ]]; then exit 1; fi
env | sort > "$TMP/server.env"
TMUX_STUB
chmod +x "$TMP/home/.local/bin/tmux"
cat >> "$TMP/body.env" <<'ENV'
OPS_TOKEN=discord-secret
FLYWHEEL_LEAD_ROLE=lead
FLYWHEEL_LEAD_RULES_BUNDLE=bundle
ENV
os_user="$(/usr/bin/id -un)"
if HOME="$TMP/home" \
  USER=untrusted-user \
  LOGNAME=untrusted-logname \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
  FLYWHEEL_DIR="$ROOT" \
  FLYWHEEL_WRAPPER_ENV_FILE="$TMP/body.env" \
  bash "$WRAPPER" "$TMP/manifest.json" >"$TMP/wrapper.out" 2>&1 \
  && grep -qF "FLYWHEEL_WRAPPER_ENV_FILE=$TMP/body.env" "$TMP/server.env" \
  && grep -qF 'FLYWHEEL_LEAD_ROLE=cos' "$TMP/server.env" \
  && grep -qF 'FLYWHEEL_LEAD_RULES_BUNDLE=legacy' "$TMP/server.env" \
  && grep -qF 'FLYWHEEL_LEAD_MODEL=claude-fable-5' "$TMP/server.env" \
  && grep -qF 'FLYWHEEL_LEAD_EFFORT=max' "$TMP/server.env" \
  && grep -qF 'FLYWHEEL_TEST_PLIST_ONLY=preserved' "$TMP/server.env" \
  && grep -qF "DISCORD_STATE_DIR=$TMP/discord-state" "$TMP/server.env" \
  && grep -qF 'FLYWHEEL_LEAD_ID=ops-lead' "$TMP/server.env" \
  && grep -Eq '^FLYWHEEL_LEAD_CARRIER_PID=[1-9][0-9]*$' "$TMP/server.env" \
  && grep -qF 'FLYWHEEL_LEAD_CARRIER_START=Mon Aug 11 12:34:56 2026' "$TMP/server.env" \
  && grep -qF "USER=$os_user" "$TMP/server.env" \
  && grep -qF "LOGNAME=$os_user" "$TMP/server.env" \
  && ! grep -qF 'USER=untrusted-user' "$TMP/server.env" \
  && ! grep -qF 'LOGNAME=untrusted-logname' "$TMP/server.env" \
  && ! grep -qF 'USER=manifest-user' "$TMP/server.env" \
  && ! grep -qF 'LOGNAME=manifest-logname' "$TMP/server.env" \
  && ! grep -qF 'TEAMLEAD_API_TOKEN=bridge-secret' "$TMP/server.env"; then
  pass "wrapper preserves required launch identity without trusting inherited names"
else
  fail "wrapper plist environment projection"
  cat "$TMP/wrapper.out" 2>/dev/null || true
  cat "$TMP/server.env" 2>/dev/null || true
fi

# Carrier provenance is observational. If ps cannot produce one trustworthy
# start identity, the wrapper must still exec the Lead and omit only the two
# tuple fields so downstream reporting degrades to unknown.
for ps_mode in empty fail tabbed; do
  rm -f "$TMP/server.env"
  set +e
  HOME="$TMP/home" \
    USER=untrusted-user \
    LOGNAME=untrusted-logname \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
    FLYWHEEL_DIR="$ROOT" \
    FLYWHEEL_WRAPPER_ENV_FILE="$TMP/body.env" \
    FLYWHEEL_LEAD_V2_PS_MODE="$ps_mode" \
    bash "$WRAPPER" "$TMP/manifest.json" >"$TMP/wrapper-$ps_mode.out" 2>&1
  probe_rc=$?
  set -e
  if [ "$probe_rc" -eq 0 ] \
      && [ -f "$TMP/server.env" ] \
      && ! grep -q '^FLYWHEEL_LEAD_CARRIER_PID=' "$TMP/server.env" \
      && ! grep -q '^FLYWHEEL_LEAD_CARRIER_START=' "$TMP/server.env" \
      && grep -q 'WARNING: carrier identity probe unavailable' "$TMP/wrapper-$ps_mode.out"; then
    pass "wrapper carrier probe $ps_mode fails open to unknown provenance"
  else
    fail "wrapper carrier probe $ps_mode blocked launch or published an invalid tuple (rc=$probe_rc)"
    cat "$TMP/wrapper-$ps_mode.out" 2>/dev/null || true
    cat "$TMP/server.env" 2>/dev/null || true
  fi
done
rm -f "$TMP/home/.local/bin/tmux"

# The Claude child crosses a second env -i boundary inside claude-lead.sh.
# Its structured dry-run plan is the authoritative projection consumed by the
# direct-child path. It must carry the OS identity and the v2 carrier marker.
identity_json="$(node "$ROOT/packages/flywheel-comm/dist/index.js" lead-identity resolve \
  --projects-file "$TMP/home/.flywheel/projects.json" --project demo --lead ops-lead --format json)"
identity_digest="$(jq -r '.identityDigest' <<<"$identity_json")"
projects_digest="$(jq -r '.projectsDigest' <<<"$identity_json")"
child_plan="$({
  env -i \
    HOME="$TMP/home" \
    PATH="$PATH" \
    USER=untrusted-user \
    LOGNAME=untrusted-logname \
    FLYWHEEL_LEAD_DRY_RUN=1 \
    FLYWHEEL_LEAD_BODY_V2=1 \
    FLYWHEEL_LEAD_CARRIER=v2 \
    FLYWHEEL_PROJECTS_FILE="$TMP/home/.flywheel/projects.json" \
    FLYWHEEL_LEAD_ID=ops-lead \
    LEAD_ID=ops-lead \
    FLYWHEEL_PROJECT_NAME=demo \
    PROJECT_NAME=demo \
    FLYWHEEL_LEAD_KEY=demo-ops-lead \
    FLYWHEEL_LEAD_ROLE=cos \
    FLYWHEEL_LEAD_BACKEND=claude-code \
    DISCORD_STATE_DIR="$TMP/discord-state" \
    DISCORD_EXPECTED_BOT_USER_ID=22345678901234567 \
    DISCORD_IDENTITY_MODE=managed \
    FLYWHEEL_LEAD_IDENTITY_DIGEST="$identity_digest" \
    FLYWHEEL_LEAD_PROJECTS_DIGEST="$projects_digest" \
    OPS_TOKEN=fixture-token \
    DISCORD_BOT_TOKEN=fixture-token \
    bash "$ROOT/packages/teamlead/scripts/claude-lead.sh" \
      ops-lead "$TMP/project" demo
} 2>&1)" || true
if grep -qF $'PANE_ENV\tUSER\tset' <<<"$child_plan" \
    && grep -qF $'PANE_ENV\tLOGNAME\tset' <<<"$child_plan" \
    && grep -qF $'PANE_ENV\tFLYWHEEL_LEAD_CARRIER\tset' <<<"$child_plan" \
    && grep -qF $'PANE_ENV\tFLYWHEEL_LEAD_IDENTITY_DIGEST\tset' <<<"$child_plan" \
    && grep -qF $'PANE_ENV\tDISCORD_EXPECTED_BOT_USER_ID\tset' <<<"$child_plan" \
    && grep -qF $'PANE_ENV\tDISCORD_IDENTITY_MODE\tset' <<<"$child_plan"; then
  pass "Claude child keeps the complete canonical identity and carrier marker"
else
  fail "Claude child identity/carrier contract"
  printf '%s\n' "$child_plan"
fi

set +e
env -i \
  HOME="$TMP/home" PATH="$PATH" \
  FLYWHEEL_LEAD_BODY_V2=1 \
  FLYWHEEL_LEAD_ID=foreign-lead \
  FLYWHEEL_PROJECT_NAME=demo \
  bash "$ROOT/packages/teamlead/scripts/claude-lead.sh" \
    ops-lead "$TMP/project" demo >"$TMP/a1-conflict.out" 2>&1
a1_rc=$?
set -e
if [ "$a1_rc" -ne 0 ] && grep -qF 'identity_env_conflict' "$TMP/a1-conflict.out"; then
  pass "Claude A1 rejects a selector/environment chimera before startup"
else
  fail "Claude A1 identity conflict guard"
  cat "$TMP/a1-conflict.out" 2>/dev/null || true
fi

cat > "$TMP/unsafe-manifest.json" <<JSON
{"leadId":"ops-lead","projectDir":"$TMP/project","projectName":"../demo","projectsFile":"$TMP/home/.flywheel/projects.json"}
JSON
if HOME="$TMP/home" \
  FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
  FLYWHEEL_DIR="$ROOT" \
  FLYWHEEL_LEAD_V2_DRY_RUN=1 \
  bash "$WRAPPER" "$TMP/unsafe-manifest.json" >"$TMP/unsafe.out" 2>&1; then
  fail "wrapper must reject an unsafe projectName"
elif grep -qF 'Invalid projectName' "$TMP/unsafe.out"; then
  pass "wrapper rejects path-bearing project identity before filesystem use"
else
  fail "wrapper unsafe projectName diagnostic"
fi

mkdir -p "$TMP/body-fixture"
cp "$ROOT/packages/teamlead/scripts/lead-body.sh" "$TMP/body-fixture/lead-body.sh"
cat > "$TMP/body-fixture/claude-lead.sh" <<'BODY_STUB'
#!/bin/bash
jq -n \
	--arg token "${DISCORD_BOT_TOKEN:-}" \
	--arg workspace "${LEAD_WORKSPACE:-}" \
	--arg mcpExclude "${FLYWHEEL_LEAD_MCP_EXCLUDE:-}" \
	--arg alertChannel "${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID:-}" \
	'{token:$token,workspace:$workspace,mcpExclude:$mcpExclude,alertChannel:$alertChannel}' \
  > "${FLY1663_BODY_OUT:?}"
BODY_STUB
cat > "$TMP/body.env" <<'ENV'
DISCORD_BOT_TOKEN=wrong-global-token
OPS_TOKEN=right-lead-token
FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=alert-channel-123
ENV
FLY1663_BODY_OUT="$TMP/body.out" \
  FLYWHEEL_WRAPPER_ENV_FILE="$TMP/body.env" \
  DISCORD_BOT_TOKEN=right-lead-token \
  bash "$TMP/body-fixture/lead-body.sh" "$TMP/manifest.json"
if jq -e \
    --arg workspace "$TMP/custom-workspace" \
	'.token == "right-lead-token"
	  and .workspace == $workspace
	  and .mcpExclude == "dangerous-mcp,chrome"
	  and .alertChannel == "alert-channel-123"' \
    "$TMP/body.out" >/dev/null; then
  pass "body preserves v1 manifest projection and exports launcher configuration to helpers"
else
  fail "body manifest/environment projection"
  cat "$TMP/body.out" 2>/dev/null || true
fi

if grep -qF 'restart-storm-gate' "$WRAPPER" \
  || grep -qF 'PID_FILE' "$WRAPPER" \
  || grep -Eq '^[[:space:]]*(tmux|\$TMUX_BIN)[[:space:]].*kill-server' "$WRAPPER"; then
  fail "wrapper must not contain storm gate, PID arbitration, or preflight kill-server"
else
  pass "wrapper contains no lifecycle arbitration"
fi

# shellcheck source=/dev/null
source "$RECEIPT_LIB"
receipt="$TMP/receipt.json"
session="$TMP/session-id"
printf 'session-1\n' > "$session"

for expected in 1 2 3; do
  lead_body_write_receipt "$receipt" demo/ops-lead session-1 1 10 true "$session"
  actual="$(jq -r '.consecutiveQuickResumeFailures' "$receipt")"
  if [ "$actual" != "$expected" ]; then
    fail "resume receipt quick-failure count $expected"
    break
  fi
done
if [ ! -f "$session" ] && [ "$(jq -r '.action' "$receipt")" = fresh-next-launch ]; then
  pass "third quick resume failure atomically forces a fresh next launch"
else
  fail "resume three-strike circuit breaker"
fi

printf 'session-2\n' > "$session"
lead_body_write_receipt "$receipt" demo/ops-lead session-2 1 61 true "$session"
if [ "$(jq -r '.consecutiveQuickResumeFailures' "$receipt")" = 0 ] \
  && [ -f "$session" ]; then
  pass "healthy-duration resume resets the persistent failure count"
else
  fail "healthy resume reset"
fi

if bash "$WRAPPER" --publish-and-start \
      "$TMP/manifest.json" "$TMP/direct.sock" 4567 /usr/bin/false /dev/null \
    && [ "$(jq -r '.pid' "$TMP/manifest.json")" = 4567 ] \
    && [ "$(jq -r '.socketPath' "$TMP/manifest.json")" = "$TMP/direct.sock" ]; then
  pass "tmux-side runtime publisher atomically records the live server identity"
else
  fail "tmux-side runtime publisher"
fi

if command -v tmux >/dev/null 2>&1; then
  mkdir -p "$TMP/live"
  cat > "$TMP/live/lead-body.sh" <<'BODY'
#!/bin/bash
exec sleep 30
BODY
  chmod +x "$TMP/live/lead-body.sh"
  cat > "$TMP/live-manifest.json" <<JSON
{"leadId":"ops-lead","projectDir":"$TMP/project","projectName":"demo","projectsFile":"$TMP/home/.flywheel/projects.json"}
JSON
  HOME="$TMP/home" \
    FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
    FLYWHEEL_DIR="$ROOT" \
    FLYWHEEL_LEAD_V2_TEST_MODE=1 \
    FLYWHEEL_LEAD_V2_TEST_BODY_SCRIPT="$TMP/live/lead-body.sh" \
    bash "$WRAPPER" "$TMP/live-manifest.json" >"$TMP/live-wrapper.log" 2>&1 &
  wrapper_pid=$!
  live_socket="$(derive_lead_socket demo/ops-lead "$TMP/home/.flywheel")"
  # This is the production launchd shape: observe only the manifest and the
  # wrapper PID. No tmux client may touch the private socket to wake the body.
  manifest_pid=""
  manifest_socket=""
  for _ in {1..100}; do
    manifest_pid="$(jq -r '.pid // ""' "$TMP/live-manifest.json" 2>/dev/null)"
    manifest_socket="$(jq -r '.socketPath // ""' "$TMP/live-manifest.json" 2>/dev/null)"
    [ "$manifest_pid" = "$wrapper_pid" ] && [ "$manifest_socket" = "$live_socket" ] && break
    sleep 0.1
  done
  if kill -0 "$wrapper_pid" 2>/dev/null \
      && [ "$manifest_pid" = "$wrapper_pid" ] \
      && [ "$manifest_socket" = "$live_socket" ]; then
    pass "private Lead body self-starts without any external socket client"
  else
    fail "unattended private body start: wrapper=$wrapper_pid manifest=$manifest_pid socket=$manifest_socket"
    cat "$TMP/live-wrapper.log" 2>/dev/null || true
  fi
  for _ in {1..50}; do
    tmux -S "$live_socket" has-session -t '=main' 2>/dev/null && break
    sleep 0.1
  done
  live_pane="$(tmux -S "$live_socket" list-panes -t '%0' \
    -F '#{pane_id}|#{session_name}|#{window_name}|#{pane_start_command}' 2>/dev/null || true)"
  live_default_shell="$(tmux -S "$live_socket" show-options -gv default-shell 2>/dev/null || true)"
  if [[ "$live_pane" == '%0|main|main|'*lead-body.sh* ]] \
      && [ "$live_default_shell" = /bin/bash ]; then
    pass "real private server exposes immutable main/main/%0 body identity without user shell startup"
  else
    fail "real private body pane identity: [$live_pane] default-shell=[$live_default_shell]"
    cat "$TMP/live-wrapper.log" 2>/dev/null || true
    cat "$TMP/home/.flywheel/run/leads/demo-ops-lead/tmux.conf" 2>/dev/null || true
  fi
  server_pid="$(tmux -S "$live_socket" display-message -p '#{pid}' 2>/dev/null || true)"
  for _ in {1..20}; do
    manifest_pid="$(jq -r '.pid // ""' "$TMP/live-manifest.json" 2>/dev/null)"
    manifest_socket="$(jq -r '.socketPath // ""' "$TMP/live-manifest.json" 2>/dev/null)"
    [ "$manifest_pid" = "$server_pid" ] && [ "$manifest_socket" = "$live_socket" ] && break
    sleep 0.05
  done
  if [ -n "$server_pid" ] \
      && [ "$manifest_pid" = "$server_pid" ] \
      && [ "$manifest_socket" = "$live_socket" ]; then
    pass "live tmux server publishes its actual PID and private socket"
  else
    fail "live runtime identity: server=$server_pid manifest=$manifest_pid socket=$manifest_socket"
  fi
  tmux -S "$live_socket" new-window -d -t '=main' 'sleep 0.1' 2>/dev/null || true
  sleep 0.3
  if kill -0 "$wrapper_pid" 2>/dev/null \
      && tmux -S "$live_socket" has-session -t '=main' 2>/dev/null; then
    pass "an extra pane/window exit cannot kill the Lead server"
  else
    fail "extra pane/window exit killed the private server"
  fi
  tmux -S "$live_socket" kill-pane -t '%0' 2>/dev/null || true
  for _ in {1..30}; do
    kill -0 "$wrapper_pid" 2>/dev/null || break
    sleep 0.1
  done
  if ! kill -0 "$wrapper_pid" 2>/dev/null; then
    pass "body %0 exit tears down the foreground server for launchd restart"
  else
    fail "body %0 exit left the foreground server alive"
    kill "$wrapper_pid" 2>/dev/null || true
  fi
  wait "$wrapper_pid" 2>/dev/null || true
else
  pass "real private tmux test skipped (tmux unavailable)"
fi

if grep -q '_launch_claude .*|| _v2_launch_rc=' \
    "$ROOT/packages/teamlead/scripts/claude-lead.sh"; then
  pass "v2 launch failures remain inside the receipt path"
else
  fail "v2 launch failure can bypass the receipt path under set -e"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
