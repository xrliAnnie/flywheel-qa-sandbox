#!/bin/bash
# FLY-1697: launchd-native Lead bodies acquire+bind their own lease generation
# before launching Claude, and the exact claim crosses the child env boundary.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEAD_BODY="$ROOT/packages/teamlead/scripts/lead-body.sh"
COMM_CLI="$ROOT/packages/flywheel-comm/dist/index.js"
TMP="$(mktemp -d /tmp/fly1697-v2-lease.XXXXXX)"
BODY_PID=""
PASS=0
FAIL=0

cleanup() {
  if [ -n "$BODY_PID" ]; then
    kill "$BODY_PID" 2>/dev/null || true
    wait "$BODY_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

if [ ! -f "$COMM_CLI" ] || [ ! -f "$ROOT/packages/teamlead/dist/ProjectConfig.js" ]; then
  printf 'FAIL: built flywheel-comm and teamlead artifacts are required\n' >&2
  exit 1
fi

HOME_DIR="$TMP/home"
PROJECT_DIR="$TMP/project"
BIN_DIR="$TMP/bin"
PROJECTS_FILE="$HOME_DIR/.flywheel/projects.json"
LEASE_DB="$HOME_DIR/.flywheel/lead-lease.db"
MODE_FILE="$HOME_DIR/.flywheel/lead-lease-mode.json"
EPISODE_DB="$HOME_DIR/.flywheel/lease-episodes.db"
ALERT_DIR="$HOME_DIR/.flywheel/alert-queue"
MANIFEST="$TMP/manifest.json"
mkdir -p "$HOME_DIR/.flywheel/claude-sessions" \
  "$PROJECT_DIR/.lead/eng-lead" "$BIN_DIR" "$ALERT_DIR" \
  "$HOME_DIR/claude-config"
printf '%s\n' '---' 'name: eng-lead' '---' 'Engineering Lead' \
  > "$PROJECT_DIR/.lead/eng-lead/identity.md"
printf '%s\n' 'session-fly1697' \
  > "$HOME_DIR/.flywheel/claude-sessions/demo-eng-lead.session-id"
cat > "$HOME_DIR/.flywheel/summary-config.json" <<'JSON'
{"granularity":"per-lead","setBy":"test","setAt":"2026-08-28T00:00:00.000Z"}
JSON

cat > "$PROJECTS_FILE" <<JSON
[{"projectName":"demo","projectRoot":"$PROJECT_DIR","leads":[{"agentId":"eng-lead","summaryRole":"producer","backend":"claude-code","carrier":"v2","botTokenEnv":"ENG_TOKEN","botUserId":"22345678901234567","chatChannel":"123456789012345678","match":{"labels":["Engineering"]}}]}]
JSON
cat > "$HOME_DIR/.flywheel/test.env" <<'ENV'
ENG_TOKEN=fixture-discord-token
TEAMLEAD_API_TOKEN=fixture-bridge-token
FLYWHEEL_COMM_BACKEND=mailbox
FLYWHEEL_LEAD_RULES_BUNDLE=legacy
ENV
cat > "$MANIFEST" <<JSON
{"leadId":"eng-lead","projectDir":"$PROJECT_DIR","projectName":"demo","botTokenEnv":"ENG_TOKEN","workspace":"$PROJECT_DIR","mcpExclude":"chrome","chromeEnabled":false}
JSON

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
cat > "$BIN_DIR/claude" <<'SH'
#!/bin/bash
env | LC_ALL=C sort > "$HOME/fly1697-child.env"
while [ ! -f "$HOME/fly1697-release" ]; do sleep 0.05; done
exit 0
SH
cat > "$BIN_DIR/tmux" <<'SH'
#!/bin/bash
exit 0
SH
cat > "$BIN_DIR/ps" <<'SH'
#!/bin/bash
pid=""
previous=""
for token in "$@"; do
  if [ "$previous" = "-p" ]; then pid="$token"; fi
  previous="$token"
done
case " $* " in
  *" state="*) printf 'S\n' ;;
  *" lstart="*) printf 'fixture-start-%s\n' "$pid" ;;
  *" command="*) printf 'bash lead-body.sh\n' ;;
  *) exit 1 ;;
esac
SH
chmod +x "$BIN_DIR/agent-team-transport" "$BIN_DIR/claude" "$BIN_DIR/tmux" "$BIN_DIR/ps"

IDENTITY_JSON="$(HOME="$HOME_DIR" node "$COMM_CLI" lead-identity resolve \
  --projects-file "$PROJECTS_FILE" --project demo --lead eng-lead)" || {
  printf 'FAIL: could not compile the fixture identity\n' >&2
  exit 1
}
IDENTITY_DIGEST="$(jq -r '.identityDigest' <<<"$IDENTITY_JSON")"
PROJECTS_DIGEST="$(jq -r '.projectsDigest' <<<"$IDENTITY_JSON")"
DISCORD_STATE="$(jq -r '.discordStateDir' <<<"$IDENTITY_JSON")"
SUMMARY_ROLE="$(jq -r '.summaryRole' <<<"$IDENTITY_JSON")"
SUMMARY_GRANULARITY="$(jq -r '.summaryGranularity' <<<"$IDENTITY_JSON")"
HAS_SUMMARY_DUTY="$(jq -r 'if .hasSummaryDuty then "1" else "0" end' <<<"$IDENTITY_JSON")"
SUMMARY_ASSIGNMENT_DIGEST="$(jq -r '.summaryAssignmentDigest' <<<"$IDENTITY_JSON")"

BODY_ENV=(
  env -i
  "HOME=$HOME_DIR"
  "PATH=$BIN_DIR:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  "USER=$(/usr/bin/id -un)"
  "LOGNAME=$(/usr/bin/id -un)"
  "FLYWHEEL_STATE_DIR=$HOME_DIR/.flywheel"
  "FLYWHEEL_WRAPPER_ENV_FILE=$HOME_DIR/.flywheel/test.env"
  "FLYWHEEL_PROJECTS_FILE=$PROJECTS_FILE"
  "FLYWHEEL_LEAD_ID=eng-lead"
  "LEAD_ID=eng-lead"
  "FLYWHEEL_PROJECT_NAME=demo"
  "PROJECT_NAME=demo"
  "FLYWHEEL_LEAD_KEY=demo-eng-lead"
  "FLYWHEEL_LEAD_ROLE=dept"
  "FLYWHEEL_LEAD_SUMMARY_ROLE=$SUMMARY_ROLE"
  "FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=$HAS_SUMMARY_DUTY"
  "FLYWHEEL_SUMMARY_GRANULARITY=$SUMMARY_GRANULARITY"
  "FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST=$SUMMARY_ASSIGNMENT_DIGEST"
  "FLYWHEEL_LEAD_BACKEND=claude-code"
  "DISCORD_STATE_DIR=$DISCORD_STATE"
  "DISCORD_EXPECTED_BOT_USER_ID=22345678901234567"
  "DISCORD_IDENTITY_MODE=managed"
  "DISCORD_BOT_TOKEN=fixture-discord-token"
  "FLYWHEEL_LEAD_IDENTITY_DIGEST=$IDENTITY_DIGEST"
  "FLYWHEEL_LEAD_PROJECTS_DIGEST=$PROJECTS_DIGEST"
  "FLYWHEEL_LEAD_LEASE_DB=$LEASE_DB"
  "FLYWHEEL_LEAD_LEASE_MODE_FILE=$MODE_FILE"
  "FLYWHEEL_LEAD_EPISODE_DB=$EPISODE_DB"
  "FLYWHEEL_ALERT_QUEUE_DIR=$ALERT_DIR"
  "FLYWHEEL_COMM_CLI=$COMM_CLI"
  "CLAUDE_CONFIG_DIR=$HOME_DIR/claude-config"
  TEST_SKIP_PLUGIN_FORK_CHECK=1
  "TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR=$HOME_DIR/claude-config"
)

body_env() { "${BODY_ENV[@]}" "$@"; }

start_body() {
  local body_script="${1:-$LEAD_BODY}"
  rm -f "$HOME_DIR/fly1697-child.env" "$HOME_DIR/fly1697-release"
  "${BODY_ENV[@]}" bash "$body_script" "$MANIFEST" > "$TMP/body.log" 2>&1 &
  BODY_PID=$!
  local i=0
  while [ "$i" -lt 200 ] && [ ! -s "$HOME_DIR/fly1697-child.env" ]; do
    kill -0 "$BODY_PID" 2>/dev/null || break
    sleep 0.05
    i=$((i + 1))
  done
  [ -s "$HOME_DIR/fly1697-child.env" ]
}

stop_body() {
  : > "$HOME_DIR/fly1697-release"
  wait "$BODY_PID" 2>/dev/null || true
  BODY_PID=""
}

# Reproduce the production incident shape: an unbound generation whose
# supervisor tuple is conclusively dead. The v2 body must advance and bind it.
if body_env node "$COMM_CLI" lead-lease acquire \
  --lead eng-lead --project demo \
  --lead-key demo-eng-lead --identity-digest "$IDENTITY_DIGEST" \
  --supervisor-pid 999999 --supervisor-start dead-start \
  --acquired-by fly1697-fixture --json > "$TMP/stale.json" 2> "$TMP/stale.err" \
  && [ "$(jq -r '.generation' "$TMP/stale.json")" = 1 ]; then
  ok "fixture starts from one stale unbound generation"
else
  bad "could not create the stale unbound generation"
  cat "$TMP/stale.err" >&2 2>/dev/null || true
fi

if start_body; then
  readiness="$(body_env node "$COMM_CLI" lead-lease readiness --local-only --json 2>/dev/null || true)"
  lead_row="$(jq -c '.local.leads[]? | select(.leadKey == "demo-eng-lead")' <<< "$readiness" 2>/dev/null || true)"
  if jq -e --argjson pid "$BODY_PID" \
    '.ready == true and .lease.bound == true and .lease.holderAlive == true and .lease.generation == 2 and .lease.pid == $pid' \
    <<< "$lead_row" >/dev/null 2>&1; then
    ok "live v2 body advances the stale row and readiness proves its exact PID"
  else
    bad "v2 readiness did not prove the live body tuple: $lead_row"
    cat "$TMP/body.log" >&2 2>/dev/null || true
  fi
  if grep -q '^FLYWHEEL_LEAD_LEASE_KEY=demo-eng-lead$' "$HOME_DIR/fly1697-child.env" \
    && grep -q '^FLYWHEEL_LEAD_GENERATION=2$' "$HOME_DIR/fly1697-child.env" \
    && grep -q '^FLYWHEEL_LEAD_SUMMARY_ROLE=producer$' "$HOME_DIR/fly1697-child.env" \
    && grep -q '^FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1$' "$HOME_DIR/fly1697-child.env" \
    && grep -q '^FLYWHEEL_SUMMARY_GRANULARITY=per-lead$' "$HOME_DIR/fly1697-child.env" \
    && grep -Eq '^FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST=[a-f0-9]{64}$' "$HOME_DIR/fly1697-child.env"; then
    ok "Claude child receives the bound lease and canonical summary projections"
  else
    bad "Claude child did not receive the bound generation claim"
  fi
  stop_body
else
  bad "real lead-body entry did not launch its Claude child"
  cat "$TMP/body.log" >&2 2>/dev/null || true
  [ -z "$BODY_PID" ] || { kill "$BODY_PID" 2>/dev/null || true; wait "$BODY_PID" 2>/dev/null || true; BODY_PID=""; }
fi

# Mutation control: remove only the v2 identity invocation in a scratch copy.
# The same real entry must then lose both the row and the child claim, proving
# the positive assertions above are sensitive to the fix.
SCRATCH="$TMP/scratch"
mkdir -p "$SCRATCH/packages/teamlead"
cp -R "$ROOT/packages/teamlead/scripts" "$SCRATCH/packages/teamlead/scripts"
ln -s "$ROOT/packages/teamlead/dist" "$SCRATCH/packages/teamlead/dist"
ln -s "$ROOT/packages/teamlead/lead-rules-base" "$SCRATCH/packages/teamlead/lead-rules-base"
ln -s "$ROOT/scripts" "$SCRATCH/scripts"
sed -i.bak 's/^[[:space:]]*lead_identity_v2_acquire_bind \\/    true \\/' \
  "$SCRATCH/packages/teamlead/scripts/claude-lead.sh"
rm -f "$LEASE_DB" "$LEASE_DB-wal" "$LEASE_DB-shm"
if start_body "$SCRATCH/packages/teamlead/scripts/lead-body.sh"; then
  if ! grep -q '^FLYWHEEL_LEAD_LEASE_KEY=' "$HOME_DIR/fly1697-child.env" \
    && [ ! -f "$LEASE_DB" ]; then
    ok "mutation control catches removal of the v2 identity step"
  else
    bad "mutation control stayed green without the v2 identity step"
  fi
  stop_body
else
  bad "mutation control did not reach the Claude child"
  cat "$TMP/body.log" >&2 2>/dev/null || true
fi

# Store failure remains fail-open only at launch: child gets a loud degraded
# marker and no generation claim, so write/receipt boundaries can fail closed.
rm -f "$LEASE_DB" "$LEASE_DB-wal" "$LEASE_DB-shm"
mkdir -p "$LEASE_DB"
if start_body; then
  if grep -q '^FLYWHEEL_LEAD_LEASE_DEGRADED=store_error$' "$HOME_DIR/fly1697-child.env" \
    && ! grep -q '^FLYWHEEL_LEAD_LEASE_KEY=' "$HOME_DIR/fly1697-child.env" \
    && ! grep -q '^FLYWHEEL_LEAD_GENERATION=' "$HOME_DIR/fly1697-child.env"; then
    ok "store failure launches with only the degraded identity marker"
  else
    bad "degraded body leaked or omitted lease identity evidence"
  fi
  stop_body
else
  bad "degraded store prevented the one-shot body from launching"
  cat "$TMP/body.log" >&2 2>/dev/null || true
fi

printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
