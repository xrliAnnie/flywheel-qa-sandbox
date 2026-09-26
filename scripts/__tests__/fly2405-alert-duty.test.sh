#!/usr/bin/env bash
# Hermetic C7 contracts: no launchd, real tokens, or Discord requests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT=$(mktemp -d /tmp/fly2405-duty.XXXXXX)
trap 'rm -rf "$TEST_ROOT"' EXIT
source "$ROOT/scripts/lib/qa-room.sh"
source "$ROOT/scripts/lib/qa-generalized.sh"
source "$ROOT/scripts/lib/qa-lead-artifacts.sh"
source "$ROOT/scripts/lib/qa-slot-env-contract.sh"
source "$ROOT/scripts/lib/qa-launchd-lead.sh"
failures=0
check() {
  if ( set -e; "$@" ); then echo "PASS: $*";
  else echo "FAIL: $*" >&2; failures=$((failures + 1)); fi
}
cat > "$TEST_ROOT/slots.json" <<'JSON'
{"alertChannel":{"channelId":"999","repairBotTokenEnv":"TEST_BOT_TOKEN_3"},"slots":[{"id":1,"tokenEnvVar":"TEST_BOT_TOKEN_1","botAppId":"111"},{"id":2,"tokenEnvVar":"TEST_BOT_TOKEN_2","botAppId":"222"},{"id":3,"tokenEnvVar":"TEST_BOT_TOKEN_3","botAppId":"333"}]}
JSON
flags() {
  declare -F qa_room_validate_alert_duty >/dev/null || return 1
  ! qa_room_validate_alert_duty 1 0 0 claude-code || return 1
  ! qa_room_validate_alert_duty 1 1 1 claude-code || return 1
  ! qa_room_validate_alert_duty 1 1 0 codex-app-server || return 1
  qa_room_validate_alert_duty 1 1 0 claude-code
}
check flags
config_validation() {
  declare -F qa_room_alert_dispatcher_config >/dev/null || return 1
  local cfg
  cfg=$(qa_room_alert_dispatcher_config "$TEST_ROOT/slots.json" 1 '[{"slotId":2}]') || return 1
  [[ $(jq -r '.tokenEnvVar' <<<"$cfg") == TEST_BOT_TOKEN_3 ]] || return 1
  ! qa_room_alert_dispatcher_config "$TEST_ROOT/slots.json" 3 '[]' || return 1
  ! qa_room_alert_dispatcher_config "$TEST_ROOT/slots.json" 1 '[{"slotId":3}]' || return 1
  for bad in CASS_BOT_TOKEN FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN CLAUDE_INFRA_BOT_TOKEN TEST_BOT_TOKEN_99; do
    jq --arg bad "$bad" '.alertChannel.dispatcherSlot=3 | .alertChannel.repairBotTokenEnv=$bad' "$TEST_ROOT/slots.json" > "$TEST_ROOT/bad.json"
    ! qa_room_alert_dispatcher_config "$TEST_ROOT/bad.json" 1 '[]' || return 1
  done
}
check config_validation
identity_validation() {
  declare -F qa_room_alert_dispatcher_identity >/dev/null || return 1
  local cfg
  cfg=$(qa_room_alert_dispatcher_config "$TEST_ROOT/slots.json" 1 '[]') || return 1
  TEST_BOT_TOKEN_3=fixture-dispatcher
  curl() { printf '{"id":"%s"}\n' "${ME_ID:-333}"; }
  [[ $(qa_room_alert_dispatcher_identity "$cfg" '["111","222"]') == 333 ]] || return 1
  ! qa_room_alert_dispatcher_identity "$cfg" '["111","333"]' || return 1
  ME_ID=444
  ! qa_room_alert_dispatcher_identity "$cfg" '["111"]'
}
check identity_validation
access_group() {
  declare -F qa_room_alert_duty_access >/dev/null || return 1
  qa_room_alert_duty_access 999 333 <<<'{"allowBots":["111"],"groups":{"888":{"requireMention":true}}}' > "$TEST_ROOT/access.json" || return 1
  jq -e '.allowBots == ["111","333"] and .groups["999"].requireMention == false and .groups["888"].requireMention == true' "$TEST_ROOT/access.json" >/dev/null
}
check access_group
generalized_boundary() {
  env FLYWHEEL_ALERT_SENDER_TOKEN_ENV=TEST_BOT_TOKEN_3 TEST_BOT_TOKEN_3=fixture \
    bash "$ROOT/scripts/lib/qa-generalized-bridge-wrapper.sh" --alert-dispatcher-env TEST_BOT_TOKEN_3 /usr/bin/env > "$TEST_ROOT/env" || return 1
  rg -q '^TEST_BOT_TOKEN_3=fixture$' "$TEST_ROOT/env" || return 1
  ! env FLYWHEEL_ALERT_SENDER_TOKEN_ENV=TEST_BOT_TOKEN_2 \
    bash "$ROOT/scripts/lib/qa-generalized-bridge-wrapper.sh" --alert-dispatcher-env TEST_BOT_TOKEN_3 true || return 1
  ! env FLYWHEEL_ALERT_SENDER_TOKEN_ENV=CASS_BOT_TOKEN \
    bash "$ROOT/scripts/lib/qa-generalized-bridge-wrapper.sh" --alert-dispatcher-env CASS_BOT_TOKEN true || return 1
  ! env FLYWHEEL_ALERT_SENDER_TOKEN_ENV=TEST_BOT_TOKEN_3 CLAUDE_INFRA_BOT_TOKEN=production \
    bash "$ROOT/scripts/lib/qa-generalized-bridge-wrapper.sh" --alert-dispatcher-env TEST_BOT_TOKEN_3 true
}
check generalized_boundary
# Extract the actual guards, not replicas of their logic. The wrapper loop is
# exercised on real manifest JSON and its own environment comes from a plist.
python3 - "$ROOT" "$TEST_ROOT" <<'PY'
from pathlib import Path
import sys
root, tmp = map(Path, sys.argv[1:])
s=(root/'scripts/flywheel-lead-wrapper-v2.sh').read_text()
a=s.index('_alert_duty_lead_id='); b=s.index('\nif [ -n "$V2_QA_DIAGNOSTICS_DIR"',a)
(tmp/'wrapper.sh').write_text(s[a:b])
s=(root/'packages/teamlead/scripts/lead-body.sh').read_text()
a=s.index('# FLY-2076: .env'); b=s.index('\nSUBDIR=',a)
(tmp/'body.sh').write_text(s[a:b])
s=(root/'packages/teamlead/scripts/claude-lead.sh').read_text()
a=s.index('\t# FLY-2076: final'); b=s.index('\n  # FLY-1697:',a)
(tmp/'pane.sh').write_text(s[a:b])
PY
carrier_pipeline() {
  declare -F qa_room_alert_duty_lead_env >/dev/null || return 1
  local assignments=() line launch_env manifest plist
  while IFS= read -r line; do assignments+=("$line"); done < <(qa_room_alert_duty_lead_env 1 "$TEST_ROOT" flywheel-test-1 flywheel-test-1 fixture-duty http://localhost:19801)
  (( ${#assignments[@]} == 4 )) || return 1
  [[ -z $(qa_room_alert_duty_lead_env 1 "$TEST_ROOT" flywheel-test-2 flywheel-test-1 fixture-duty http://localhost:19801) ]] || return 1
  [[ -z $(qa_room_alert_duty_lead_env 0 "$TEST_ROOT" flywheel-test-1 flywheel-test-1 fixture-duty http://localhost:19801) ]] || return 1
  launch_env=$(qa_slot_launch_env_json "${assignments[@]}") || return 1
  manifest="$TEST_ROOT/manifest.json"; plist="$TEST_ROOT/lead.plist"
  qa_lead_write_manifest "$manifest" flywheel-test-1 "$TEST_ROOT" room "$TEST_ROOT/projects.json" "$TEST_ROOT/workspace" '' "$launch_env" || return 1
  FLYWHEEL_DIR="$ROOT" qa_launchd_render_plist "$plist" com.flywheel.test "$ROOT/scripts/flywheel-lead-wrapper-v2.sh" "$manifest" "$TEST_ROOT" "$TEST_ROOT/state" "$TEST_ROOT/projects.json" "$TEST_ROOT/.env" "$TEST_ROOT/lead.log" || return 1
  python3 - "$plist" "$TEST_ROOT/plist-env.sh" <<'PY'
import plistlib, shlex, sys
with open(sys.argv[1],'rb') as f: env=plistlib.load(f)['EnvironmentVariables']
for name in ['FLYWHEEL_ISOLATION_ROOT','FLYWHEEL_ALERT_DUTY_LEAD_ID','FLYWHEEL_ALERT_DUTY_TOKEN','FLYWHEEL_BRIDGE_URL']: assert env.get(name), name
with open(sys.argv[2],'w') as f:
 for k,v in env.items(): f.write('export '+k+'='+shlex.quote(v)+'\n')
PY
  [[ $? == 0 ]] || return 1
  # Stale token fields on an extra or production manifest cannot grant a
  # launchd wrapper the capability; an ordinary non-duty manifest has none.
  local negative negative_env negative_agent
  for negative in extra ordinary production_override; do
    negative_agent=flywheel-test-2
    negative_env="$launch_env"
    if [[ "$negative" == ordinary ]]; then negative_env='{}'; fi
    if [[ "$negative" == production_override ]]; then
      negative_env=$(jq -c 'del(.FLYWHEEL_ISOLATION_ROOT) | .FLYWHEEL_ALERT_DUTY_LEAD_ID="flywheel-test-2"' <<<"$launch_env")
    fi
    qa_lead_write_manifest "$TEST_ROOT/negative.json" "$negative_agent" "$TEST_ROOT" room "$TEST_ROOT/projects.json" "$TEST_ROOT/workspace" '' "$negative_env" || return 1
    FLYWHEEL_DIR="$ROOT" qa_launchd_render_plist "$TEST_ROOT/negative.plist" com.flywheel.negative "$ROOT/scripts/flywheel-lead-wrapper-v2.sh" "$TEST_ROOT/negative.json" "$TEST_ROOT" "$TEST_ROOT/state" "$TEST_ROOT/projects.json" "$TEST_ROOT/.env" "$TEST_ROOT/lead.log" || return 1
    python3 - "$TEST_ROOT/negative.plist" <<'PYCODE'
import plistlib, sys
with open(sys.argv[1],'rb') as f: env=plistlib.load(f)['EnvironmentVariables']
assert 'FLYWHEEL_ALERT_DUTY_TOKEN' not in env
PYCODE
    [[ $? == 0 ]] || return 1
  done
  source "$TEST_ROOT/plist-env.sh"
  LEAD_ID=flywheel-test-1; LAUNCH_ENVIRONMENT="$launch_env"; BOT_TOKEN_ENV=TEST_BOT_TOKEN_1
  source "$TEST_ROOT/wrapper.sh"
  unset FLYWHEEL_ALERT_DUTY_TOKEN FLYWHEEL_ALERT_DUTY_LEAD_ID FLYWHEEL_ISOLATION_ROOT FLYWHEEL_BRIDGE_URL
  for line in "${SERVER_ENV[@]}"; do export "$line"; done
  source "$TEST_ROOT/body.sh"
  local env_args=() FLYWHEEL_ROOT="$ROOT"
  source "$TEST_ROOT/pane.sh"
  [[ " ${env_args[*]} " == *' FLYWHEEL_ALERT_DUTY_TOKEN=fixture-duty '* ]] || return 1
  [[ " ${env_args[*]} " == *' FLYWHEEL_ALERT_DUTY_LEAD_ID=flywheel-test-1 '* ]] || return 1
  PROJECT_NAME=room; DISCORD_STATE_DIR="$TEST_ROOT"; SCRIPT_DIR="$ROOT/packages/teamlead/scripts"
  FLYWHEEL_ALERT_DUTY_SEAT_CLI="$TEST_ROOT/seat.cjs"
  cat > "$TEST_ROOT/seat.cjs" <<'JS'
const fs=require('node:fs');
const path=require('node:path');
const root=process.env.FLY2405_TEST_REPO_ROOT;
const {tsImport}=require(require.resolve('tsx/esm/api',{paths:[root]}));
const url=process.env.FLYWHEEL_BRIDGE_URL;
const argv=process.argv;
if(url !== 'http://localhost:19801' || argv[argv.indexOf('--bridge-url')+1] !== url) process.exit(3);
// Exercise the real CLI and resolver; stub only the external project source
// and fetch, recording the endpoint actually requested by production code.
tsImport(path.join(root,'packages/teamlead/src/alert-duty-seat-cli.ts'),__filename).then(async ({runAlertDutySeatCli})=>{
  process.exitCode=await runAlertDutySeatCli(argv.slice(2),{
    loadProjects:()=>[{projectName:'room',leads:[{agentId:'flywheel-test-1',alertChannel:'999'}]}],
    fetchImpl:async target=>{
      fs.writeFileSync(path.join(process.env.FLYWHEEL_ISOLATION_ROOT,'fetch-url'),target);
      return new Response(JSON.stringify({dispatcherBotUserId:'333',dutyWritePath:'configured'}),{status:200});
    },
  });
}).catch(error=>{console.error(error);process.exitCode=1;});
JS
  local pane_entries=() pane_i
  for ((pane_i=1; pane_i<${#env_args[@]}; pane_i+=2)); do pane_entries+=("${env_args[$pane_i]}"); done
  env -i HOME="$TEST_ROOT" PATH="$PATH" LEAD_ID="$LEAD_ID" PROJECT_NAME=room \
    DISCORD_STATE_DIR="$TEST_ROOT" SCRIPT_DIR="$SCRIPT_DIR" \
    FLY2405_TEST_REPO_ROOT="$ROOT" \
    FLYWHEEL_ALERT_DUTY_SEAT_CLI="$FLYWHEEL_ALERT_DUTY_SEAT_CLI" "${pane_entries[@]}" \
    /bin/bash -c 'source "$1"; /usr/bin/env > "$2"' _ \
    "$ROOT/packages/teamlead/scripts/lead-duty-provision.sh" "$TEST_ROOT/pane.env" > "$TEST_ROOT/status"
  rg -q '^FLYWHEEL_ALERT_DUTY_TOKEN=fixture-duty$' "$TEST_ROOT/pane.env" || return 1
  rg -q 'seat=true.*token=set' "$TEST_ROOT/status" || return 1
  [[ $(cat "$TEST_ROOT/fetch-url") == http://localhost:19801/api/alert-duty/seat ]] || return 1
  jq -e '.groups["999"].requireMention == false and (.allowBots | index("333") != null)' "$TEST_ROOT/access.json" >/dev/null || return 1
  for LEAD_ID in flywheel-test-2 ordinary-production; do
    FLYWHEEL_ALERT_DUTY_TOKEN=fixture-duty
    [[ "$LEAD_ID" != ordinary-production ]] || unset FLYWHEEL_ISOLATION_ROOT
    FLYWHEEL_ALERT_DUTY_LEAD_ID="$LEAD_ID"
    [[ "$LEAD_ID" != flywheel-test-2 ]] || FLYWHEEL_ALERT_DUTY_LEAD_ID=flywheel-test-1
    source "$TEST_ROOT/wrapper.sh"
    [[ " ${SERVER_ENV[*]} " != *FLYWHEEL_ALERT_DUTY_TOKEN=* ]] || return 1
    source "$TEST_ROOT/body.sh"
    [[ -z ${FLYWHEEL_ALERT_DUTY_TOKEN:-} ]] || return 1
    env_args=(); FLYWHEEL_ALERT_DUTY_TOKEN=fixture-duty
    source "$TEST_ROOT/pane.sh"
    [[ " ${env_args[*]-} " != *FLYWHEEL_ALERT_DUTY_TOKEN=* ]] || return 1
  done
}
check carrier_pipeline
routing_single_source() {
  ! rg -n 'claude-infra-bot-lead' "$ROOT/packages/teamlead/src/bridge/infra-event-router.ts" "$ROOT/packages/teamlead/src/bridge/infra-alert-mailbox.ts" "$ROOT/packages/teamlead/src/bridge/lead-inbox-runtime.ts"
}
check routing_single_source

deploy_wiring() {
  python3 - "$ROOT" "$TEST_ROOT" <<'PYCODE'
from pathlib import Path
import sys
root,tmp=map(Path,sys.argv[1:])
s=(root/'scripts/test-deploy.sh').read_text()
a=s.index('if [[ "$ALERTS" == "1" ]]; then',s.index('# ── FLY-529: QA Room'))
b=s.index('\n# FLY-1165:',a)
(tmp/'deploy-alerts.sh').write_text(s[a:b])
assert '--alert-duty)' in s, 'CLI flag missing'
assert 'qa_room_alert_duty_lead_env' in s, 'primary carrier integration missing'
assert 'alertDutyTokenPath' in s, 'room JSON missing token path'
a=s.index('# Preserve ordinary caller compatibility')
b=s.index('# The hermetic Bridge carrier',a)
(tmp/'scrub.sh').write_text(s[a:b])
PYCODE
  [[ $? == 0 ]] || return 1
  local ALERTS=1 ALERT_DUTY=1 SLOT=1 SLOT_PORT=19801 SLOT_DIR="$TEST_ROOT/deploy-room" AGENT_ID=flywheel-test-1 BOT_TOKEN_ENV=TEST_BOT_TOKEN_1
  local SLOTS_FILE="$TEST_ROOT/slots.json" EXTRA_LEADS_JSON='[]' TEST_BOT_TOKEN=primary TEST_BOT_TOKEN_1=primary TEST_BOT_TOKEN_3=dispatcher
  local TEST_TEAMLEAD_API_TOKEN=master TEST_TEAMLEAD_INGEST_TOKEN=ingest QA_SLOT_BRIDGE_NODE
  QA_SLOT_BRIDGE_NODE=$(command -v node)
  local BRIDGE_EXTRA_ENV=() LEAD_EXTRA_ENV=() ALERT_DUTY_TOKEN_PATH='' ALERT_DUTY_TOKEN='' ALERT_DISPATCHER_CONFIG
  ALERT_DISPATCHER_CONFIG=$(qa_room_alert_dispatcher_config "$SLOTS_FILE" "$SLOT" "$EXTRA_LEADS_JSON") || return 1
  mkdir -p "$SLOT_DIR"
  log() { :; }
  campaign_abort() { echo "$*" >&2; return 1; }
  qa_release_slot_lock() { return 1; }
  curl() {
    case "$*" in
      *users/@me*)
        if [[ "$*" == *'Bot primary'* ]]; then echo '{"id":"111"}'; else echo '{"id":"333"}'; fi ;;
      *) printf 200 ;;
    esac
  }
  source "$TEST_ROOT/deploy-alerts.sh"
  [[ -n "$ALERT_DUTY_TOKEN" && "$ALERT_DUTY_TOKEN" != master && "$ALERT_DUTY_TOKEN" != ingest ]] || return 1
  [[ $(cat "$ALERT_DUTY_TOKEN_PATH") == "$ALERT_DUTY_TOKEN" && $(qa_generalized_file_mode "$ALERT_DUTY_TOKEN_PATH") == 600 ]] || return 1
  [[ " ${BRIDGE_EXTRA_ENV[*]} " == *" FLYWHEEL_ALERT_DUTY_TOKEN=${ALERT_DUTY_TOKEN} "* ]] || return 1
  [[ " ${BRIDGE_EXTRA_ENV[*]} " == *' FLYWHEEL_ALERT_SENDER_TOKEN_ENV=TEST_BOT_TOKEN_3 '* ]] || return 1
  [[ " ${BRIDGE_EXTRA_ENV[*]} " == *' TEST_BOT_TOKEN_3=dispatcher '* ]] || return 1
  [[ " ${LEAD_EXTRA_ENV[*]} " != *FLYWHEEL_ALERT_DUTY_TOKEN=* ]] || return 1
  export CASS_BOT_TOKEN=production-cass CLAUDE_INFRA_BOT_TOKEN=production-infra FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN=production-dispatch
  export FLYWHEEL_ALERT_SENDER_TOKEN_ENV=CASS_BOT_TOKEN FLYWHEEL_ALERT_DUTY_TOKEN=production-duty TEST_BOT_TOKEN_99=unselected
  local BRIDGE_ENV_UNSET_ARGS=() UNCLASSIFIED_COORDINATES_CLEARED=()
  source "$TEST_ROOT/scrub.sh"
  env "${BRIDGE_ENV_UNSET_ARGS[@]}" "${BRIDGE_EXTRA_ENV[@]}" /usr/bin/env > "$TEST_ROOT/bridge.env"
  ! rg -q 'production-(cass|infra|dispatch|duty)|TEST_BOT_TOKEN_99=' "$TEST_ROOT/bridge.env" || return 1
  rg -q '^TEST_BOT_TOKEN_3=dispatcher$' "$TEST_ROOT/bridge.env" || return 1
  for key in FLYWHEEL_ALERT_DUTY_TOKEN FLYWHEEL_ALERT_DUTY_LEAD_ID FLYWHEEL_ALERT_SENDER_TOKEN_ENV; do
    jq -e --arg key "$key" 'any(.[]; .name == $key and .disposition == "clear" and .boot == "unchecked")' "$ROOT/scripts/lib/qa-slot-env-contract.json" >/dev/null || return 1
  done
}
check deploy_wiring
nested_room_toggle() {
  python3 - "$ROOT" "$TEST_ROOT" <<'PYCODE'
from pathlib import Path
import re,sys
root,tmp=map(Path,sys.argv[1:])
s=(root/'scripts/test-deploy.sh').read_text()
m=re.search(r'^if \[\[ "\$\{TEST_QA_ROOM_SERVICE:-0\}" == 1 \]\]; then\n.*?^fi',s,re.M|re.S)
assert m, 'nested room service toggle missing'
(tmp/'room-service-toggle.sh').write_text(m[0])
PYCODE
  [[ $? == 0 ]] || return 1
  local BRIDGE_EXTRA_ENV=() TEST_QA_ROOM_SERVICE=1
  source "$TEST_ROOT/room-service-toggle.sh"
  [[ " ${BRIDGE_EXTRA_ENV[*]} " == *' TEST_QA_ROOM_SERVICE=1 '* ]] || return 1
  TEST_QA_ROOM_SERVICE=0; BRIDGE_EXTRA_ENV=()
  source "$TEST_ROOT/room-service-toggle.sh"
  (( ${#BRIDGE_EXTRA_ENV[@]} == 0 )) || return 1
  jq -e 'any(.[]; .name == "TEST_QA_ROOM_SERVICE" and .disposition == "clear" and .boot == "unchecked")' "$ROOT/scripts/lib/qa-slot-env-contract.json" >/dev/null
}
check nested_room_toggle
(( failures == 0 ))
