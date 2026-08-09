#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WRAPPER="$ROOT/scripts/flywheel-lead-wrapper-v2.sh"
RECEIPT_LIB="$ROOT/packages/teamlead/scripts/lib/lead-body-receipt.sh"
TMP="$(mktemp -d /tmp/fly1663-v2.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

mkdir -p "$TMP/home/.flywheel" "$TMP/project" "$TMP/bin"
cat > "$TMP/home/.flywheel/projects.json" <<JSON
[{"projectName":"demo","projectRoot":"$TMP/project","leads":[{"agentId":"ops-lead"}]}]
JSON
cat > "$TMP/home/.flywheel/.env" <<'ENV'
OPS_TOKEN=discord-secret
TEAMLEAD_API_TOKEN=bridge-secret
FLYWHEEL_COMM_BACKEND=mailbox
ENV
cat > "$TMP/manifest.json" <<JSON
{"leadId":"ops-lead","projectDir":"$TMP/project","projectName":"demo","botTokenEnv":"OPS_TOKEN","workspace":"$TMP/custom-workspace","mcpExclude":"dangerous-mcp,chrome","chromeEnabled":true,"launchEnvironment":{"FLYWHEEL_WRAPPER_ENV_FILE":"$TMP/body.env","FLYWHEEL_LEAD_ROLE":"cos","FLYWHEEL_LEAD_RULES_BUNDLE":"legacy","FLYWHEEL_LEAD_MODEL":"claude-fable-5","FLYWHEEL_LEAD_EFFORT":"max","FLYWHEEL_TEST_PLIST_ONLY":"preserved"},"unknown":{"keep":true}}
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
if [ -f "$conf" ] \
  && [[ "$conf" == */run/leads/demo-ops-lead/tmux.conf ]] \
  && grep -qF 'set -g exit-empty on' "$conf" \
  && grep -qF '#{hook_pane}' "$conf" \
  && grep -qF '= %0' "$conf" \
  && grep -qF 'tmux -S ' "$conf" \
  && grep -qF 'new-session -d -s main -n main' "$conf" \
  && grep -qF 'packages/teamlead/scripts/lead-body.sh' "$conf"; then
  pass "wrapper emits the body-pane-bound three-layer shutdown config"
else
  fail "wrapper tmux config contract"
fi

# A carrier cutover must preserve the existing plist EnvironmentVariables
# contract across the wrapper's env -i boundary. The manifest carries the
# transactionally captured dict, so values remain authoritative even when the
# selected .env contains conflicting assignments.
mkdir -p "$TMP/home/.local/bin"
cat > "$TMP/home/.local/bin/tmux" <<TMUX_STUB
#!/bin/bash
env | sort > "$TMP/server.env"
TMUX_STUB
chmod +x "$TMP/home/.local/bin/tmux"
cat >> "$TMP/body.env" <<'ENV'
FLYWHEEL_LEAD_ROLE=lead
FLYWHEEL_LEAD_RULES_BUNDLE=bundle
ENV
if HOME="$TMP/home" \
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
  && grep -qF 'FLYWHEEL_LEAD_ID=ops-lead' "$TMP/server.env" \
  && ! grep -qF 'TEAMLEAD_API_TOKEN=bridge-secret' "$TMP/server.env"; then
  pass "wrapper preserves the plist launch environment without leaking the sourced secret set"
else
  fail "wrapper plist environment projection"
  cat "$TMP/wrapper.out" 2>/dev/null || true
  cat "$TMP/server.env" 2>/dev/null || true
fi
rm -f "$TMP/home/.local/bin/tmux"

cat > "$TMP/unsafe-manifest.json" <<JSON
{"leadId":"ops-lead","projectDir":"$TMP/project","projectName":"../demo","botTokenEnv":"OPS_TOKEN"}
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
  --arg chromeEnabled "${FLYWHEEL_LEAD_CHROME_ENABLED:-}" \
  --arg alertChannel "${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID:-}" \
  '{token:$token,workspace:$workspace,mcpExclude:$mcpExclude,chromeEnabled:$chromeEnabled,alertChannel:$alertChannel}' \
  > "${FLY1663_BODY_OUT:?}"
BODY_STUB
cat > "$TMP/body.env" <<'ENV'
DISCORD_BOT_TOKEN=wrong-global-token
OPS_TOKEN=right-lead-token
FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=alert-channel-123
ENV
FLY1663_BODY_OUT="$TMP/body.out" \
  FLYWHEEL_WRAPPER_ENV_FILE="$TMP/body.env" \
  bash "$TMP/body-fixture/lead-body.sh" "$TMP/manifest.json"
if jq -e \
    --arg workspace "$TMP/custom-workspace" \
    '.token == "right-lead-token"
      and .workspace == $workspace
      and .mcpExclude == "dangerous-mcp,chrome"
      and .chromeEnabled == "true"
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

if command -v tmux >/dev/null 2>&1; then
  mkdir -p "$TMP/live"
  cat > "$TMP/live/lead-body.sh" <<'BODY'
#!/bin/bash
exec sleep 30
BODY
  chmod +x "$TMP/live/lead-body.sh"
  cat > "$TMP/live-manifest.json" <<JSON
{"leadId":"ops-lead","projectDir":"$TMP/project","projectName":"demo","botTokenEnv":"OPS_TOKEN"}
JSON
  HOME="$TMP/home" \
    FLYWHEEL_STATE_DIR="$TMP/home/.flywheel" \
    FLYWHEEL_DIR="$ROOT" \
    FLYWHEEL_LEAD_V2_TEST_MODE=1 \
    FLYWHEEL_LEAD_V2_TEST_BODY_SCRIPT="$TMP/live/lead-body.sh" \
    bash "$WRAPPER" "$TMP/live-manifest.json" >"$TMP/live-wrapper.log" 2>&1 &
  wrapper_pid=$!
  live_socket=""
  for _ in {1..50}; do
    live_socket="$(jq -r '.socketPath // ""' "$TMP/live-manifest.json" 2>/dev/null)"
    [ -n "$live_socket" ] && tmux -S "$live_socket" has-session -t '=main' 2>/dev/null && break
    sleep 0.1
  done
  live_pane="$(tmux -S "$live_socket" list-panes -t '%0' \
    -F '#{pane_id}|#{session_name}|#{window_name}|#{pane_start_command}' 2>/dev/null || true)"
  if [[ "$live_pane" == '%0|main|main|'*lead-body.sh* ]]; then
    pass "real private server exposes immutable main/main/%0 body identity"
  else
    fail "real private body pane identity: [$live_pane]"
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
