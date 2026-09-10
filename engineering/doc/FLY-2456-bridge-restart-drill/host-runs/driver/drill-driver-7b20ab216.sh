#!/usr/bin/env bash
# GENERATED from host-runbook.md — one block per fly2456-step, in order.
# Usage: OWNER_EXEC=... TEAMLEAD_API_TOKEN=... bash drill-driver.sh [STOP_AFTER_STEP_ID]
set -uo pipefail
STOP_AFTER="${1:-}"
START_FROM="${START_FROM:-}"  # DEVIATION #11 resume: skip execute-NN blocks that sort before START_FROM (their manifest receipts/evidence already exist)
skip_step(){ test -n "$START_FROM" && [ "$1" \< "$START_FROM" ]; }
LOG="${DRILL_LOG:-/tmp/fly2456-drill-driver.log}"
step_begin(){ printf "%s STEP %s (%s) begin\n" "$(date -u +%FT%TZ)" "$1" "$2" | tee -a "$LOG"; }
step_end(){ printf "%s STEP %s rc=%s\n" "$(date -u +%FT%TZ)" "$1" "$2" | tee -a "$LOG"; if [ "$2" -ne 0 ]; then echo "STOP: step $1 failed (路书停手)" | tee -a "$LOG"; exit 70; fi; if [ -n "$STOP_AFTER" ] && [ "$STOP_AFTER" = "$1" ]; then echo "STOP_AFTER reached: $1" | tee -a "$LOG"; exit 0; fi; }

# ---- setup-01 [setup] ----
step_begin "setup-01" "setup"
set -euo pipefail
umask 077
export TOOL_REPO=/Users/xiaorongli/Dev/flywheel-FLY-2456-tools  # DEVIATION #12: Lead-owned detached worktree @7b20ab216 with park-adopt patch (PR worktree stays clean)
export ROUND=r1 SLOT=4 TESTED=/Users/xiaorongli/Dev/flywheel-FLY-2456-r1
export EVIDENCE=/Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/$ROUND
export SLOT_DIR=/tmp/flywheel-test-slot-$SLOT HOST_REPO=/tmp/flywheel-test-slot-$SLOT/project-slot-$SLOT
export TOOLS=$TOOL_REPO/scripts/qa-fly-2456-drill-tools.mjs
: "${OWNER_EXEC:?Lead must supply a live unfinished DAG execution (snapshot owner workflow), not a Lead session or completed execution}"
export OWNER_EXEC OWNER_BRIDGE=http://localhost:9876
: "${TEAMLEAD_API_TOKEN:?Supply the existing owner Bridge API token in the host environment without printing it}"
export TESTED_HEAD=$(git -C "$TESTED" rev-parse HEAD)
export FLYWHEEL_MODELS_CONFIG=/Users/xiaorongli/.flywheel/models.json
export MANIFEST=$EVIDENCE/manifest.json
export SLOT_CONFIG=/Users/xiaorongli/.flywheel/test-slots.json
case "$ROUND:$SLOT" in r1:4|r2:1) ;; *) exit 1;; esac
test -f "$TESTED/packages/teamlead/dist/workflow-template-selection.js"
test -f "$FLYWHEEL_MODELS_CONFIG"
mkdir -p "$EVIDENCE"
chmod 700 "$EVIDENCE"
verify_snapshot_owner() {
  curl --fail --silent --show-error --max-time 10 "$OWNER_BRIDGE/api/sessions/$OWNER_EXEC/snapshot-owner" -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" > "$EVIDENCE/snapshot-owner.json"
  jq -e --arg execution "$OWNER_EXEC" '.ok==true and .owner.kind=="workflow" and .owner.executionId==$execution' "$EVIDENCE/snapshot-owner.json" >/dev/null
}
verify_snapshot_owner
node "$TOOLS" manifest init --manifest "$MANIFEST" --round "$ROUND" --slot "$SLOT" --checkout "$TESTED" --head "$TESTED_HEAD" --issue B1=FLY-202 --issue B2=FLY-145 --issue B3=FLY-146 > "$EVIDENCE/init.json"
python3 - "$EVIDENCE/context.json" <<'PY'
import json,os,sys
keys=['TOOL_REPO','ROUND','SLOT','TESTED','TESTED_HEAD','EVIDENCE','SLOT_DIR','HOST_REPO','TOOLS','OWNER_EXEC','OWNER_BRIDGE','FLYWHEEL_MODELS_CONFIG','MANIFEST','SLOT_CONFIG']
value={k:os.environ[k] for k in keys}
try:
 with open(sys.argv[1],'x') as f: json.dump(value,f)
except FileExistsError:
 assert json.load(open(sys.argv[1]))==value,'context conflict'
PY
step_end "setup-01" "$?"

# ---- setup-02 [setup] ----
step_begin "setup-02" "setup"
stamp_file() {
  python3 - "$1" <<'PY'
import datetime,hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1]); meta={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
with pathlib.Path(str(p)+'.meta.json').open('x') as f: json.dump(meta,f)
PY
}
managed_snapshot() {
  local source=$1 kind=$2 project=$3 receipt=$4 copy_path
  local -a project_args=()
  if test -n "$project"; then project_args=(--project "$project"); fi
  env FLYWHEEL_EXEC_ID="$OWNER_EXEC" FLYWHEEL_BRIDGE_URL="$OWNER_BRIDGE" FLYWHEEL_STATE_DB_PATH="$source" FLYWHEEL_COMM_DB="$source" node "$TOOL_REPO/scripts/flywheel-snapshot-control.mjs" runner --source "$source" --kind "$kind" ${project_args[@]+"${project_args[@]}"} > "$receipt"
  copy_path=$(jq -er 'select(.ok==true).path' "$receipt")
  python3 - "$copy_path" "$OWNER_EXEC" <<'PY'
import pathlib,sys
expected=pathlib.Path('/tmp').resolve()/'flywheel-snapshots'/sys.argv[2]
assert pathlib.Path(sys.argv[1]).resolve().parent==expected,'snapshot owner directory mismatch'
PY
  stamp_file "$copy_path"
  printf '%s\n' "$copy_path"
}
snapshot_release() {
  local receipt=$1
  env FLYWHEEL_EXEC_ID="$OWNER_EXEC" FLYWHEEL_BRIDGE_URL="$OWNER_BRIDGE" node "$TOOL_REPO/scripts/flywheel-snapshot-control.mjs" release > "$receipt"
  jq -e '.ok==true and (.status=="deleted" or .status=="already_absent")' "$receipt" >/dev/null
  test ! -e "/tmp/flywheel-snapshots/$OWNER_EXEC"
}
derive_evidence() {
  node --input-type=module - "$TOOL_REPO" "$@" <<'JS'
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
const [root,source,output,kind,...args]=process.argv.slice(2);
const {values}=parseArgs({args,options:{slot:{type:'string'},lead:{type:'string'},exec:{type:'string',multiple:true}}});
const {deriveEvidence}=await import(pathToFileURL(root+'/scripts/lib/qa-fly-2456-evidence.mjs'));
console.log(JSON.stringify(deriveEvidence(source,output,kind,{slot:values.slot,lead:values.lead,executions:values.exec??[]})));
JS
}
snapshot_exit() {
  local rc=$?
  trap - EXIT
  snapshot_release "$EVIDENCE/exit-snapshot-release-$(date -u +%s).json" || { if test "$rc" -eq 0; then rc=1; fi; }
  exit "$rc"
}
trap snapshot_exit EXIT
slot_snapshots() {
  local tag=$1
  STATE_COPY=$(managed_snapshot "$SLOT_DIR/teamlead.db" teamlead '' "$EVIDENCE/$tag-state-snapshot.json")
  COMM_COPY=$(managed_snapshot "$SLOT_DIR/state/comm/test-slot-$SLOT/comm.db" comm "test-slot-$SLOT" "$EVIDENCE/$tag-comm-snapshot.json")
  export STATE_COPY COMM_COPY
}
intent_file() {
  node "$TOOLS" manifest intent --manifest "$MANIFEST" --step "$1" --file "$2" > "$EVIDENCE/$1-intent.json"
}
adopt_db() {
  local step=$1 tag=$2
  slot_snapshots "$tag"
  node "$TOOLS" manifest adopt --manifest "$MANIFEST" --step "$step" --db "$STATE_COPY" --comm "$COMM_COPY" > "$EVIDENCE/$tag-adopt.json"
  snapshot_release "$EVIDENCE/$tag-release.json"
  ADOPT_ACTION=$(jq -er '.action' "$EVIDENCE/$tag-adopt.json")
  case "$ADOPT_ACTION" in execute|adopt-existing|replay) ;; *) return 1;; esac
}
adopt_file() {
  local step=$1 captured=$2 tag=$3
  stamp_file "$captured"
  node "$TOOLS" manifest adopt --manifest "$MANIFEST" --step "$step" --evidence "$captured" > "$EVIDENCE/$tag-adopt.json"
  ADOPT_ACTION=$(jq -er '.action' "$EVIDENCE/$tag-adopt.json")
  case "$ADOPT_ACTION" in execute|adopt-existing|replay) ;; *) return 1;; esac
}
declare -f stamp_file managed_snapshot snapshot_release derive_evidence snapshot_exit slot_snapshots intent_file adopt_db adopt_file > "$EVIDENCE/snapshot-functions.bash"
step_end "setup-02" "$?"

# ---- setup-03 [setup] ----
step_begin "setup-03" "setup"
slot_runner() {
  local execution=$1 issue=$2 worktree=$3
  shift 3
  local bridge_port ingest slot_api
  bridge_port=$(python3 - "$SLOT" "$SLOT_CONFIG" <<'PY'
import json,sys
v=json.load(open(sys.argv[2]))['slots'][int(sys.argv[1])-1]['bridgePort']
assert isinstance(v,int) and 1024<v<65536
print(v)
PY
)
  ingest=$(cat "$SLOT_DIR/state/bridge-env-secrets/TEAMLEAD_INGEST_TOKEN")
  slot_api=$(cat "$SLOT_DIR/state/api-token")
  (cd "$worktree" && env -i HOME="$HOME" PATH="$PATH" LANG="${LANG:-en_US.UTF-8}" TEAMLEAD_API_TOKEN="$slot_api" FLYWHEEL_EXEC_ID="$execution" FLYWHEEL_ISSUE_ID="$issue" FLYWHEEL_PROJECT_NAME="test-slot-$SLOT" FLYWHEEL_LEAD_ID="flywheel-test-$SLOT" FLYWHEEL_BRIDGE_URL="http://localhost:$bridge_port" FLYWHEEL_COMM_DB="$SLOT_DIR/state/comm/test-slot-$SLOT/comm.db" FLYWHEEL_COMM_ROOT="$SLOT_DIR/state/comm" FLYWHEEL_STATE_DB_PATH="$SLOT_DIR/teamlead.db" TEAMLEAD_DB_PATH="$SLOT_DIR/teamlead.db" FLYWHEEL_STATE_DIR="$SLOT_DIR/state" FLYWHEEL_INGEST_TOKEN="$ingest" FLYWHEEL_COMM_CLI="$TESTED/packages/flywheel-comm/dist/index.js" FLYWHEEL_CODEX_HOMES_ROOT="$SLOT_DIR/state/codex-homes" FLYWHEEL_CODEX_SESSION_DIR="$SLOT_DIR/state/codex-sessions" FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT="$SLOT_DIR/state/cdx-sock" FLYWHEEL_BRIDGE_SYNCOP_DIR="$SLOT_DIR/state/sync-operation-markers" TMUX_TMPDIR="$SLOT_DIR" node "$TESTED/packages/flywheel-comm/dist/index.js" "$@")
}
declare -f slot_runner > "$EVIDENCE/runner-function.bash"
step_end "setup-03" "$?"

# ---- setup-04 [setup] ----
step_begin "setup-04" "setup"
room_capture() {
  local kind=$1 output=$2
  ps -axo pid=,ppid=,lstart=,command= > "$output.ps"
  if test -d "$SLOT_DIR" && test "$kind" = deploy; then
    local port
    port=$(python3 - "$SLOT" "$SLOT_CONFIG" <<'PY'
import json,sys
print(json.load(open(sys.argv[2]))['slots'][int(sys.argv[1])-1]['bridgePort'])
PY
)
    curl --fail --silent --show-error --max-time 10 "http://localhost:$port/health" > "$output.health"
  fi
  node --input-type=module - "$kind" "$output" <<'JS'
import {readFileSync,writeFileSync,existsSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [kind,out]=process.argv.slice(2),d=process.env.SLOT_DIR,slot=Number(process.env.SLOT),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const identity=p=>{if(!existsSync(p))return null;const s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink())throw Error('file identity invalid');return {sha256:hash(p),mode:s.mode&0o777,inode:s.ino,mtimeMs:s.mtimeMs};};
const e={scope:{slot,checkout:process.env.TESTED}};
if(kind==='adoption')e.adoptionYaml=readFileSync(process.env.HOST_REPO+'/.flywheel/menus/adoption.yaml','utf8');
else if(kind==='room-info'){e.roomInfo=identity(d+'/room-info.json');e.hiddenRoomInfo=identity(d+'/room-info.json.drill-hidden');}
else {
 e.processes=readFileSync(out+'.ps','utf8').trim().split('\n').map(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+/.exec(line);if(!m)throw Error('ps format invalid');return {pid:Number(m[1]),ppid:Number(m[2]),lstart:m[3]};});
 e.bridgePid=existsSync(d+'/bridge.pid')?Number(readFileSync(d+'/bridge.pid','utf8').trim()):null;
 if(kind==='deploy'){e.slotExists=existsSync(d);e.roomInfo=existsSync(d+'/room-info.json')?JSON.parse(readFileSync(d+'/room-info.json','utf8')):null;e.health=existsSync(out+'.health')?JSON.parse(readFileSync(out+'.health','utf8')):null;}
 else if(kind==='cycle'){e.launchSpecSha256=hash(d+'/bridge-launch.json');e.cycleFailed=[d+'/bridge.pid',d+'.lock/pid'].some(p=>existsSync(p)&&readFileSync(p,'utf8').trim()==='cycle-failed');}
 else throw Error('capture kind unsupported');
}
writeFileSync(out,JSON.stringify(e),{flag:'wx',mode:0o600});
JS
}
new_tag() {
  node -e "console.log(require('node:crypto').randomUUID())"
}
declare -f room_capture new_tag > "$EVIDENCE/room-functions.bash"
step_end "setup-04" "$?"

# ---- setup-05 [setup] ----
step_begin "setup-05" "setup"
start_body() {
  local label=$1 step=start-$1 tag request detail port token
  case "$label" in PRE|B1|B2|B3) ;; *) return 1;; esac
  tag=$(new_tag)
  request=$EVIDENCE/$step-request.json
  detail=$EVIDENCE/$step-detail.json
  python3 - "$MANIFEST" "$label" "$request" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]));label=sys.argv[2];b=(m.get('auxiliaryBodies',{}) if label=='PRE' else m['bodies'])[label];slot=m['config']['slot']
r={'issueId':b['issueId'],'projectName':f'test-slot-{slot}','leadId':f'flywheel-test-{slot}','taskCategory':'simple_code','sessionRole':'main','idempotencyKey':b['idempotencyKey'],'overrides':{'implement':{'model':'codex'}}}
try:
 with open(sys.argv[3],'x') as f:json.dump(r,f)
except FileExistsError:assert json.load(open(sys.argv[3]))==r,'request conflict'
PY
  if ! jq -e --arg s "$step" '.steps[$s].intent' "$MANIFEST" >/dev/null; then
    slot_snapshots "$tag-selection"
    node "$TOOLS" selection-preview --db "$STATE_COPY" --request "$request" --checkout "$TESTED" --host-repo "$HOST_REPO" --model-config "$FLYWHEEL_MODELS_CONFIG" > "$EVIDENCE/$step-selection.json"
  snapshot_release "$EVIDENCE/$tag-selection-release.json"
    jq -n --arg label "$label" --arg issue "$(jq -er .issueId "$request")" --arg digest "$(jq -er 'select(.status=="pass").selectionDigest' "$EVIDENCE/$step-selection.json")" '{kind:"start",label:$label,issueId:$issue,selectionDigest:$digest}' > "$detail"
    intent_file "$step" "$detail"
  fi
  adopt_db "$step" "$tag-before-start"
  if test "$ADOPT_ACTION" = execute; then
    port=$(python3 - "$SLOT" "$SLOT_CONFIG" <<'PY'
import json,sys
print(json.load(open(sys.argv[2]))['slots'][int(sys.argv[1])-1]['bridgePort'])
PY
)
    token=$(cat "$SLOT_DIR/state/api-token")
    curl --fail --silent --show-error --max-time 120 -X POST "http://localhost:$port/api/runs/start" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary "@$request" > "$EVIDENCE/$tag-start-response.json"
    adopt_db "$step" "$tag-after-start"
    test "$ADOPT_ACTION" != execute
  fi
  jq -e --arg s "$step" '.steps[$s].receipt.result' "$MANIFEST" > "$EVIDENCE/$tag-start-identity.json"
}
declare -f start_body > "$EVIDENCE/start-function.bash"
step_end "setup-05" "$?"

# ---- setup-06 [setup] ----
step_begin "setup-06" "setup"
deploy_room() {
  local phase=$1 step=deploy-$1 tag
  tag=$(new_tag)
  jq -n '{kind:"deploy"}' > "$EVIDENCE/$tag-deploy-detail.json"
  intent_file "$step" "$EVIDENCE/$tag-deploy-detail.json"
  room_capture deploy "$EVIDENCE/$tag-deploy-before.json"
  adopt_file "$step" "$EVIDENCE/$tag-deploy-before.json" "$tag-deploy-before"
  if test "$ADOPT_ACTION" = execute; then
    bash "$TESTED/scripts/test-deploy.sh" "$SLOT" --generalized --codex-runner --no-lead --expect-head "$TESTED_HEAD" > "$EVIDENCE/$tag-deploy.log" 2>&1
    room_capture deploy "$EVIDENCE/$tag-deploy-after.json"
    adopt_file "$step" "$EVIDENCE/$tag-deploy-after.json" "$tag-deploy-after"
    test "$ADOPT_ACTION" != execute
  fi
}
adopt_menu() {
  local phase=$1 step=menu-$1 tag
  tag=$(new_tag)
  jq -n '{kind:"adoption"}' > "$EVIDENCE/$tag-menu-detail.json"
  intent_file "$step" "$EVIDENCE/$tag-menu-detail.json"
  room_capture adoption "$EVIDENCE/$tag-menu-before.json"
  adopt_file "$step" "$EVIDENCE/$tag-menu-before.json" "$tag-menu-before"
  if test "$ADOPT_ACTION" = execute; then
    printf 'flywheel-test-%s: [code, simple_code, generic]\n' "$SLOT" > "$HOST_REPO/.flywheel/menus/adoption.yaml"
    room_capture adoption "$EVIDENCE/$tag-menu-after.json"
    adopt_file "$step" "$EVIDENCE/$tag-menu-after.json" "$tag-menu-after"
    test "$ADOPT_ACTION" != execute
  fi
}
declare -f deploy_room adopt_menu > "$EVIDENCE/deploy-functions.bash"
step_end "setup-06" "$?"

# ---- setup-07 [read] ----
step_begin "setup-07" "read"
git -C "$TESTED" status --porcelain > "$EVIDENCE/tested-status.txt"
test ! -s "$EVIDENCE/tested-status.txt"
test "$(git -C "$TESTED" rev-parse HEAD)" = "$TESTED_HEAD"
gh pr list --repo xrliAnnie/flywheel --state merged --search 'FLY-2454 in:title' --json number,mergeCommit,url > "$EVIDENCE/dependency-2454.json"
DEP_SHA=$(jq -er 'select(length==1).[0].mergeCommit.oid' "$EVIDENCE/dependency-2454.json")
git -C "$TESTED" merge-base --is-ancestor "$DEP_SHA" "$TESTED_HEAD"
gh pr view 1128 --repo xrliAnnie/flywheel --json number,headRefOid,mergeCommit,state,url > "$EVIDENCE/pr-1128.json"
FIX_SHA=$(jq -er .headRefOid "$EVIDENCE/pr-1128.json")
if test "$ROUND" = r1; then
  test "$(jq -r .state "$EVIDENCE/pr-1128.json")" != MERGED
  if git -C "$TESTED" merge-base --is-ancestor "$FIX_SHA" "$TESTED_HEAD"; then exit 1; fi
else
  git -C "$TESTED" merge-base --is-ancestor "$FIX_SHA" "$TESTED_HEAD"
fi
if test -z "$START_FROM"; then for n in 1 4; do
  test ! -e "/tmp/flywheel-test-slot-$n.lock"
  test ! -e "/tmp/flywheel-test-slot-$n"
done; fi
command -v codex > "$EVIDENCE/codex-path.txt"
codex --version > "$EVIDENCE/codex-version.txt"
printf '%s\n' "$TESTED_HEAD" > "$EVIDENCE/tested-head.txt"
step_end "setup-07" "$?"

# ---- production-capture [setup] ----
step_begin "production-capture" "setup"
production_databases() (
  set -euo pipefail
  out=$1
  local prod_state prod_comm execution
  local comm_args=(--slot "$SLOT" --lead "flywheel-test-$SLOT")
  python3 - "$MANIFEST" "$EVIDENCE/final-observe.json" > "$out/comm-executions.txt" <<'PY'
import json,pathlib,sys
m=json.load(open(sys.argv[1]));ids=[]
for e in m['steps'].values():
 if e['intent']['detail']['kind'] in ['start','qa-identity'] and e.get('receipt'):ids.append(e['receipt']['result']['executionId'])
observation=pathlib.Path(sys.argv[2])
if observation.exists():
 for body in json.loads(observation.read_text())['bodies'].values():
  if body.get('replacement'):ids.append(body['replacement']['executionId'])
assert all(isinstance(x,str) and x and '\n' not in x and '\r' not in x for x in ids)
for execution in sorted(set(ids)):print(execution)
PY
  while IFS= read -r execution; do comm_args+=(--exec "$execution"); done < "$out/comm-executions.txt"
  trap 'snapshot_release "$out/snapshot-exit-release.json"' EXIT
  prod_state=$(managed_snapshot /Users/xiaorongli/.flywheel/teamlead.db teamlead '' "$out/state-snapshot.json")
  derive_evidence "$prod_state" "$out/state.evidence.json" production > "$out/state-derivation.json"
  snapshot_release "$out/state-release.json"
  prod_comm=$(managed_snapshot /Users/xiaorongli/.flywheel/comm/flywheel/comm.db comm flywheel "$out/comm-snapshot.json")
  derive_evidence "$prod_comm" "$out/comm.evidence.json" comm "${comm_args[@]}" > "$out/comm-derivation.json"
)
production_capture() {
  local tag=$1 out=$EVIDENCE/$1 prod_state prod_comm sensor_pid
  test ! -e "$out"
  mkdir -m 700 "$out"
  bash "$TESTED/scripts/qa-fly-2454-fleet-snapshot.sh" --out "$out/fleet.txt"
  /bin/ps -axo pid=,ppid=,lstart=,command= > "$out/ps.txt" &
  sensor_pid=$!
  wait "$sensor_pid"
  node "$TOOLS" proc-prepare --raw "$out/ps.txt" --sensor-pid "$sensor_pid" --out "$out/ps-comparison.txt" > "$out/ps-derivation.json"
  tmux -S "/private/tmp/tmux-$(id -u)/default" list-windows -a -F '#{@flywheel_exec_id}|#{session_name}|#{window_id}|#{window_name}' > "$out/tmux.txt"
  production_databases "$out"
  node "$TOOLS" fleet-identity --prod-statestore "$out/state.evidence.json" --tmux-inventory "$out/tmux.txt" --prod-socket-root /Users/xiaorongli/.flywheel/cdx-sock --out "$out/identity.json" > "$out/identity-result.json"
  curl --fail --silent --show-error --max-time 10 "$OWNER_BRIDGE/health" > "$out/health.json"
  python3 - "$out" <<'PY'
import hashlib,json,pathlib,re,sys
out=pathlib.Path(sys.argv[1]);base=pathlib.Path('/Users/xiaorongli/.flywheel')
launch=base/'state/launch-commits';names=[]
for p in launch.iterdir():
 assert p.is_file() and not p.is_symlink(),'invalid launch entry'
 names.append(p.name)
(out/'launch-commits.txt').write_text(''.join(x+'\n' for x in sorted(names)))
alerts=[]
for folder in ['meta-alert','alert-deadletter']:
 d=base/folder
 if not d.exists():continue
 for p in sorted(d.iterdir()):
  if p.is_symlink() or not p.is_file():
   with (out/'alerts-skipped.txt').open('a') as sk: sk.write(folder+'/'+p.name+('\tsymlink' if p.is_symlink() else '\tdirectory' if p.is_dir() else '\tother')+'\n')
   continue
  raw=p.read_bytes();alerts.append({'path':folder+'/'+p.name,'content':raw.decode(),'sha256':hashlib.sha256(raw).hexdigest()})
(out/'alerts.json').write_text(json.dumps(alerts))
windows=[x.split('|') for x in (out/'tmux.txt').read_text().splitlines()]
assert all(len(x)==4 for x in windows)
(out/'runner-windows.txt').write_text(str(sum('runner-flywheel' in '|'.join(x[1:]) for x in windows))+'\n')
counts={'prod':0,'slot':0,'other':0}
for line in (out/'ps.txt').read_text().splitlines():
 if re.search(r'(?:^|/)codex\s+app-server\b',line) and re.search(r'--listen(?:=|\s+)unix:',line):
  counts['prod' if '/.flywheel/cdx-sock/' in line else 'slot' if '/flywheel-test-slot-' in line else 'other']+=1
(out/'codex-counts.json').write_text(json.dumps(counts))
PY
}
declare -f production_databases production_capture > "$EVIDENCE/production-function.bash"
step_end "production-capture" "$?"

# ---- decoy-helper [setup] ----
step_begin "decoy-helper" "setup"
capture_decoy() {
  local socket=$1 output=$2
  tmux -S "$socket" list-windows -a -F '#{@flywheel_exec_id}|#{session_name}|#{window_id}|#{window_name}' > "$output.inventory"
  jq -n --argjson slot "$SLOT" --arg checkout "$TESTED" --arg socket "$socket" --rawfile inventory "$output.inventory" '{scope:{slot:$slot,checkout:$checkout},tmuxSocket:$socket,tmuxInventory:$inventory}' > "$output"
}
ensure_decoy() {
  local tag socket
  tag=$(new_tag)
  socket=/private/tmp/tmux-$(id -u)/default
  jq -n --arg socket "$socket" '{kind:"decoy",tmuxSocket:$socket}' > "$EVIDENCE/$tag-decoy-detail.json"
  intent_file decoy "$EVIDENCE/$tag-decoy-detail.json"
  capture_decoy "$socket" "$EVIDENCE/$tag-decoy-before.json"
  adopt_file decoy "$EVIDENCE/$tag-decoy-before.json" "$tag-decoy-before"
  if test "$ADOPT_ACTION" = execute; then
    tmux -S "$socket" new-window -d -n fly2454-decoy
    capture_decoy "$socket" "$EVIDENCE/$tag-decoy-after.json"
    adopt_file decoy "$EVIDENCE/$tag-decoy-after.json" "$tag-decoy-after"
    test "$ADOPT_ACTION" != execute
  fi
}
declare -f capture_decoy ensure_decoy > "$EVIDENCE/decoy-functions.bash"
step_end "decoy-helper" "$?"

# ---- teardown-helper [setup] ----
step_begin "teardown-helper" "setup"
capture_teardown() {
  local step=$1 output=$2
  node --input-type=module - "$step" "$output" <<'JS'
import {existsSync,readdirSync,lstatSync,readFileSync,writeFileSync} from 'node:fs';
const [step,out]=process.argv.slice(2),m=JSON.parse(readFileSync(process.env.MANIFEST,'utf8')),intent=m.steps[step].intent,root=intent.detail.archiveRoot;
const dirs=existsSync(root)?readdirSync(root).map(name=>root+'/'+name).map(path=>({path,s:lstatSync(path)})).filter(x=>x.s.isDirectory()&&!x.s.isSymbolicLink()&&x.s.birthtimeMs>Date.parse(intent.createdAt)):[];
if(dirs.length>1)throw Error('archive ambiguous');
const x=dirs[0],e={scope:{slot:Number(process.env.SLOT),checkout:process.env.TESTED},slotExists:existsSync(process.env.SLOT_DIR),archive:x?{exists:true,path:x.path,isDirectory:true,birthtimeMs:x.s.birthtimeMs}:null};
writeFileSync(out,JSON.stringify(e),{flag:'wx',mode:0o600});
JS
}
teardown_room() {
  archive_slot_logs "pre-teardown-$1"
  local phase=$1 step=teardown-$1 tag
  tag=$(new_tag)
  jq -n --arg root "/Users/xiaorongli/.flywheel/qa-evidence/slot-$SLOT" '{kind:"teardown",archiveRoot:$root}' > "$EVIDENCE/$tag-teardown-detail.json"
  intent_file "$step" "$EVIDENCE/$tag-teardown-detail.json"
  capture_teardown "$step" "$EVIDENCE/$tag-teardown-before.json"
  adopt_file "$step" "$EVIDENCE/$tag-teardown-before.json" "$tag-teardown-before"
  if test "$ADOPT_ACTION" = execute; then
    env FLYWHEEL_QA_EVID_DIR=/Users/xiaorongli/.flywheel/qa-evidence bash "$TESTED/scripts/test-teardown.sh" "$SLOT" > "$EVIDENCE/$tag-teardown.log" 2>&1
    capture_teardown "$step" "$EVIDENCE/$tag-teardown-after.json"
    adopt_file "$step" "$EVIDENCE/$tag-teardown-after.json" "$tag-teardown-after"
    test "$ADOPT_ACTION" != execute
  fi
}
declare -f capture_teardown teardown_room > "$EVIDENCE/teardown-functions.bash"
step_end "teardown-helper" "$?"

# ---- room-info-helper [setup] ----
step_begin "room-info-helper" "setup"
room_transfer() {
  local action=$1 step=room-info-$1 tag source destination
  case "$action" in hide|restore) ;; *) return 1;; esac
  tag=$(new_tag)
  if jq -e '.steps["room-info-hide"].intent.detail.identity' "$MANIFEST" > "$EVIDENCE/$tag-room-identity.json"; then
    :
  else
    test "$action" = hide
    node "$TOOLS" room-info hide-precheck --slot-dir "$SLOT_DIR" > "$EVIDENCE/$tag-hide-precheck.json"
    jq -e '.identity' "$EVIDENCE/$tag-hide-precheck.json" > "$EVIDENCE/$tag-room-identity.json"
  fi
  jq -n --arg action "$action" --slurpfile identity "$EVIDENCE/$tag-room-identity.json" '{kind:"room-info",action:$action,identity:$identity[0]}' > "$EVIDENCE/$tag-room-detail.json"
  intent_file "$step" "$EVIDENCE/$tag-room-detail.json"
  room_capture room-info "$EVIDENCE/$tag-room-before.json"
  adopt_file "$step" "$EVIDENCE/$tag-room-before.json" "$tag-room-before"
  if test "$action" = hide; then
    source=$SLOT_DIR/room-info.json
    destination=$SLOT_DIR/room-info.json.drill-hidden
  else
    source=$SLOT_DIR/room-info.json.drill-hidden
    destination=$SLOT_DIR/room-info.json
  fi
  if test "$ADOPT_ACTION" = execute; then
    node "$TOOLS" room-info "$action-precheck" --slot-dir "$SLOT_DIR" --identity "$EVIDENCE/$tag-room-identity.json" > "$EVIDENCE/$tag-room-precheck.json"
    mv -n "$source" "$destination"
    node "$TOOLS" room-info "$action-postcheck" --slot-dir "$SLOT_DIR" --identity "$EVIDENCE/$tag-room-identity.json" > "$EVIDENCE/$tag-room-postcheck.json"
    room_capture room-info "$EVIDENCE/$tag-room-after.json"
    adopt_file "$step" "$EVIDENCE/$tag-room-after.json" "$tag-room-after"
    test "$ADOPT_ACTION" != execute
  fi
}
declare -f room_transfer > "$EVIDENCE/room-info-function.bash"
step_end "room-info-helper" "$?"

# ---- cycle-helper [setup] ----
step_begin "cycle-helper" "setup"
archive_slot_logs() {
  # DEVIATION #17: test-teardown archives only boundary-events/launch-manifest/kill-ledger; keep the slot Bridge and report-host logs for reown failure text
  local tag=$1; for f in bridge.log report-host.log; do test -f "$SLOT_DIR/$f" && cp "$SLOT_DIR/$f" "$EVIDENCE/slot-$tag-$f"; done; return 0
}
cycle_room() {
  local number=$1 step=cycle-$1 tag port listener
  case "$number" in 1|2) ;; *) return 1;; esac
  tag=$(new_tag)
  if ! jq -e --arg step "$step" '.steps[$step].intent' "$MANIFEST" >/dev/null; then
    slot_snapshots "$tag-cycle-bounds"
    node "$TOOLS" bounds --db "$STATE_COPY" --runs "$(jq -er '.steps["start-B1"].receipt.result.workflowRunId' "$MANIFEST")" --runs "$(jq -er '.steps["start-B2"].receipt.result.workflowRunId' "$MANIFEST")" --runs "$(jq -er '.steps["start-B3"].receipt.result.workflowRunId' "$MANIFEST")" > "$EVIDENCE/$tag-cycle-bounds.json"
    snapshot_release "$EVIDENCE/$tag-cycle-bounds-release.json"
    ps -axo pid=,ppid=,lstart=,command= > "$EVIDENCE/$tag-cycle-ps.txt"
    port=$(python3 - "$SLOT" "$SLOT_CONFIG" <<'PY'
import json,sys
print(json.load(open(sys.argv[2]))['slots'][int(sys.argv[1])-1]['bridgePort'])
PY
)
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t | sort -u > "$EVIDENCE/$tag-cycle-listeners.txt"
    node --input-type=module - "$tag" "$number" <<'JS'
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [tag,number]=process.argv.slice(2),e=process.env.EVIDENCE,d=process.env.SLOT_DIR;
const rows=readFileSync(e+'/'+tag+'-cycle-ps.txt','utf8').trim().split('\n').map(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+/.exec(line);if(!m)throw Error('ps invalid');return {pid:Number(m[1]),ppid:Number(m[2]),lstart:m[3]};});
const listeners=readFileSync(e+'/'+tag+'-cycle-listeners.txt','utf8').trim().split(/\s+/).map(Number);
if(listeners.length!==1||!Number.isSafeInteger(listeners[0])||listeners[0]<=0)throw Error('listener ambiguous');
const oldPid=Number(readFileSync(d+'/bridge.pid','utf8').trim()),old=rows.find(p=>p.pid===oldPid),chain=[];
let pid=listeners[0];
while(true){const p=rows.find(p=>p.pid===pid);if(!p||chain.some(x=>x.pid===pid))throw Error('listener chain conflict');chain.push({pid:p.pid,ppid:p.ppid});if(pid===oldPid)break;pid=p.ppid;}
if(!old)throw Error('old Bridge missing');
const detail={kind:'cycle',number:Number(number),preState:{oldPid,oldLstart:old.lstart,listenerChain:chain,logOffset:statSync(d+'/bridge.log').size,bounds:JSON.parse(readFileSync(e+'/'+tag+'-cycle-bounds.json','utf8')),launchSpecSha256:createHash('sha256').update(readFileSync(d+'/bridge-launch.json')).digest('hex')}};
writeFileSync(e+'/'+tag+'-cycle-detail.json',JSON.stringify(detail),{flag:'wx',mode:0o600});
JS
    intent_file "$step" "$EVIDENCE/$tag-cycle-detail.json"
  fi
  room_capture cycle "$EVIDENCE/$tag-cycle-before.json"
  adopt_file "$step" "$EVIDENCE/$tag-cycle-before.json" "$tag-cycle-before"
  if test "$ADOPT_ACTION" = execute; then
    sleep 1
    bash "$TESTED/scripts/test-cycle-bridge.sh" "$SLOT" > "$EVIDENCE/$tag-cycle.log" 2>&1
    room_capture cycle "$EVIDENCE/$tag-cycle-after.json"
    adopt_file "$step" "$EVIDENCE/$tag-cycle-after.json" "$tag-cycle-after"
    test "$ADOPT_ACTION" != execute
  fi
  slot_snapshots "$tag-cycle-observe"
  node "$TOOLS" observe --db "$STATE_COPY" --manifest "$MANIFEST" --step "$step" > "$EVIDENCE/$tag-observe.json"
  snapshot_release "$EVIDENCE/$tag-cycle-observe-release.json"
}
declare -f cycle_room > "$EVIDENCE/cycle-function.bash"
step_end "cycle-helper" "$?"

# ---- terminate-helper [setup] ----
step_begin "terminate-helper" "setup"
terminate_session() {
  local purpose=$1 execution=$2 step=terminate-$1 tag port token reason
  case "$purpose" in precondition|qa-fallback) ;; *) return 1;; esac
  tag=$(new_tag)
  reason="FLY-2456 $ROUND $purpose session-only"
  jq -n --arg purpose "$purpose" --arg execution "$execution" --arg reason "$reason" '{kind:"terminate",purpose:$purpose,executionId:$execution,reason:$reason}' > "$EVIDENCE/$tag-terminate-detail.json"
  intent_file "$step" "$EVIDENCE/$tag-terminate-detail.json"
  adopt_db "$step" "$tag-terminate-before"
  if test "$ADOPT_ACTION" = execute; then
    jq -n --arg execution "$execution" --arg reason "$reason" '{execution_id:$execution,reason:$reason}' > "$EVIDENCE/$tag-terminate-request.json"
    port=$(python3 - "$SLOT" "$SLOT_CONFIG" <<'PY'
import json,sys
print(json.load(open(sys.argv[2]))['slots'][int(sys.argv[1])-1]['bridgePort'])
PY
)
    token=$(cat "$SLOT_DIR/state/api-token")
    # DEVIATION #5 (Lead, 2026-09-10): wait until the slot Bridge has bound the session tmux window before terminating;
    # terminating while the window is still :pending yields "cleanup failed ... tmux window identity is still pending" (HTTP 400).
    bound=0
    for _i in $(seq 1 120); do
      _w=$(sqlite3 -readonly "$SLOT_DIR/state/comm/test-slot-$SLOT/comm.db" "select coalesce(tmux_window,'') from sessions where execution_id='$execution';" 2>/dev/null)
      case "$_w" in ''|*:pending) ;; *) bound=1; break;; esac
      sleep 1
    done
    printf '%s terminate-wait execution=%s bound=%s\n' "$(date -u +%FT%TZ)" "$execution" "$bound" >> "$EVIDENCE/terminate-wait.log"
    test "$bound" = 1
    curl --fail --silent --show-error --max-time 60 -X POST "http://localhost:$port/api/actions/terminate" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary "@$EVIDENCE/$tag-terminate-request.json" > "$EVIDENCE/$tag-terminate-response.json"
    adopt_db "$step" "$tag-terminate-after"
    test "$ADOPT_ACTION" != execute
  fi
}
declare -f terminate_session > "$EVIDENCE/terminate-function.bash"
step_end "terminate-helper" "$?"

# ---- precondition-clock [setup] ----
step_begin "precondition-clock" "setup"
wait_precondition() {
  python3 - "$MANIFEST" "$EVIDENCE" <<'PY'
import datetime,json,pathlib,sys,time
m=json.load(open(sys.argv[1]));e=pathlib.Path(sys.argv[2]);r=m['steps']['terminate-precondition']['receipt']['result']
assert r['purpose']=='precondition' and r['status']=='terminated' and r['noop'] is False
p=e/'pre-wait-start.json';end=e/'pre-wait.json'
if not p.exists():
 with p.open('x') as f:json.dump({'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds'),'executionId':r['executionId'],'actionEventId':r['actionEventId']},f)
start=json.loads(p.read_text());assert start['executionId']==r['executionId'] and start['actionEventId']==r['actionEventId']
at=datetime.datetime.fromisoformat(start['startedAt']);assert at.tzinfo is not None
if end.exists():
 proof=json.loads(end.read_text());assert proof['startedAt']==start['startedAt'] and proof['waitedMs']>=600000
else:
 while (datetime.datetime.now(datetime.timezone.utc)-at).total_seconds()<600:time.sleep(10)
 finished=datetime.datetime.fromisoformat(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds'))
 proof={'status':'pass','startedAt':start['startedAt'],'endedAt':finished.isoformat(),'waitedMs':(finished-at)//datetime.timedelta(milliseconds=1),'maintenanceTicks':None,'tickEvidence':{'status':'unavailable','reason':'no_unconditional_tick_observable','rulingQuestionId':'c7791d8e-0d58-44d2-af0f-28b371382737'}}
 with end.open('x') as f:json.dump(proof,f)
assert proof['waitedMs']>=600000
print(json.dumps(proof))
PY
}
declare -f wait_precondition > "$EVIDENCE/precondition-wait-function.bash"
step_end "precondition-clock" "$?"

# ---- park-capture-helpers [setup] ----
step_begin "park-capture-helpers" "setup"
export SANDBOX_REPOSITORY=xrliAnnie/flywheel-qa-sandbox
body_context() {
  local label=$1 tag identity_step
  case "$label" in B1|B2|B3) identity_step=start-$label;; QA) identity_step=qa-identity-B1;; *) return 1;; esac
  tag=$(new_tag)
  slot_snapshots "$tag-body-context"
  node --input-type=module - "$TOOL_REPO" "$STATE_COPY" "$MANIFEST" "$identity_step" "$SLOT_DIR" <<'JS' > "$EVIDENCE/$tag-body-context.json"
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [tools,path,manifestPath,step,slotDir]=process.argv.slice(2);
const {openSnapshot}=await import(pathToFileURL(tools+'/scripts/lib/qa-fly-2456-db.mjs'));
const m=JSON.parse(readFileSync(manifestPath)),r=m.steps[step]?.receipt?.result;
if(!r?.executionId||!r.workflowRunId)throw Error('missing adopted identity');
const {db}=openSnapshot(path,{maxAgeMs:600000});
try {
 const s=db.prepare('SELECT execution_id,issue_id,project_name,worktree_path,COALESCE(branch,worktree_binding_branch) AS branch,branch AS branch_raw,worktree_binding_branch FROM sessions WHERE execution_id=?').get(r.executionId); // DEVIATION #8: codex bodies never populate sessions.branch on main; worktree_binding_branch is the bound branch and is cross-checked against git branch --show-current below
 if(!s||s.issue_id!==r.issueId||s.project_name!==`test-slot-${m.config.slot}`||typeof s.worktree_path!=='string'||!s.worktree_path.startsWith(slotDir+'/')||typeof s.branch!=='string'||!/^[-\w/]+$/.test(s.branch)||s.branch.includes('..'))throw Error('body context mismatch');
 console.log(JSON.stringify({...s,runId:r.workflowRunId}));
}finally{db.close();}
JS
  snapshot_release "$EVIDENCE/$tag-body-context-release.json"
  BODY_EXEC=$(jq -er .execution_id "$EVIDENCE/$tag-body-context.json")
  BODY_ISSUE=$(jq -er .issue_id "$EVIDENCE/$tag-body-context.json")
  BODY_RUN=$(jq -er .runId "$EVIDENCE/$tag-body-context.json")
  BODY_WORKTREE=$(jq -er .worktree_path "$EVIDENCE/$tag-body-context.json")
  BODY_BRANCH=$(jq -er .branch "$EVIDENCE/$tag-body-context.json")
  test "$(git -C "$BODY_WORKTREE" branch --show-current)" = "$BODY_BRANCH"
  test "$(git -C "$BODY_WORKTREE" remote get-url origin)" = "https://github.com/$SANDBOX_REPOSITORY.git" || test "$(git -C "$BODY_WORKTREE" remote get-url origin)" = "git@github.com:$SANDBOX_REPOSITORY.git"
}
capture_marker() {
  local branch=$1 marker=$2 output=$3 tag head tree blob
  tag=$(new_tag)
  git ls-remote --heads "https://github.com/$SANDBOX_REPOSITORY.git" "refs/heads/$branch" > "$EVIDENCE/$tag-refs.txt"
  head=$(awk 'NR==1 {print $1}' "$EVIDENCE/$tag-refs.txt")
  printf 'null\n' > "$EVIDENCE/$tag-commit.json"
  printf 'null\n' > "$EVIDENCE/$tag-tree.json"
  printf 'null\n' > "$EVIDENCE/$tag-blob.json"
  if test -n "$head"; then
    gh api "repos/$SANDBOX_REPOSITORY/git/commits/$head" > "$EVIDENCE/$tag-commit.json"
    tree=$(jq -er .tree.sha "$EVIDENCE/$tag-commit.json")
    gh api "repos/$SANDBOX_REPOSITORY/git/trees/$tree?recursive=1" > "$EVIDENCE/$tag-tree.json"
    blob=$(jq -er --arg p "$marker" '[.tree[]|select(.path==$p)]|if length==0 then "" elif length==1 then .[0].sha else error("duplicate marker") end' "$EVIDENCE/$tag-tree.json")
    if test -n "$blob"; then
      gh api "repos/$SANDBOX_REPOSITORY/git/blobs/$blob" > "$EVIDENCE/$tag-blob.json"
    fi
  fi
  jq -n --argjson slot "$SLOT" --arg checkout "$TESTED" --arg repository "$SANDBOX_REPOSITORY" --rawfile remoteRefs "$EVIDENCE/$tag-refs.txt" --slurpfile commit "$EVIDENCE/$tag-commit.json" --slurpfile tree "$EVIDENCE/$tag-tree.json" --slurpfile blob "$EVIDENCE/$tag-blob.json" '{scope:{slot:$slot,checkout:$checkout},repository:$repository,remoteRefs:$remoteRefs,commit:$commit[0],tree:$tree[0],blob:$blob[0],treeRecursive:true}' > "$output"
}
capture_park_pr() {
  local branch=$1 output=$2 tag
  tag=$(new_tag)
  gh pr list --repo "$SANDBOX_REPOSITORY" --head "$branch" --state open --json number,url,title,headRefName,state > "$EVIDENCE/$tag-prs.json"
  jq -n --argjson slot "$SLOT" --arg checkout "$TESTED" --arg repository "$SANDBOX_REPOSITORY" --arg head "$branch" --slurpfile prs "$EVIDENCE/$tag-prs.json" '{scope:{slot:$slot,checkout:$checkout},repository:$repository,query:{repository:$repository,head:$head,state:"open"},prs:$prs[0]}' > "$output"
}
declare -f body_context capture_marker capture_park_pr > "$EVIDENCE/park-capture-functions.bash"
step_end "park-capture-helpers" "$?"

# ---- park_metadata [setup] ----
step_begin "park_metadata" "setup"
park_marker() {
  local label=$1 step=park-marker-$1 tag marker text expected
  case "$label" in B1|B3) ;; *) return 1;; esac
  body_context "$label"
  tag=$(new_tag)
  marker=doc/qa/sandbox-notes.md
  text="FLY-2456 drill marker $ROUND $label"
  if jq -e --arg s "$step" '.steps[$s].intent' "$MANIFEST" >/dev/null; then
    jq -e --arg s "$step" '.steps[$s].intent.detail' "$MANIFEST" > "$EVIDENCE/$tag-marker-detail.json"
  else
    # DEVIATION #10: a fresh body's branch is local-only until it pushes; publish HEAD (clean tree, no commits of ours) before the baseline capture
    git -C "$BODY_WORKTREE" ls-remote --heads origin "refs/heads/$BODY_BRANCH" > "$EVIDENCE/$tag-marker-remote-before.txt"
    if test ! -s "$EVIDENCE/$tag-marker-remote-before.txt"; then
      test -z "$(git -C "$BODY_WORKTREE" status --porcelain)"
      git -C "$BODY_WORKTREE" push origin "HEAD:refs/heads/$BODY_BRANCH" > "$EVIDENCE/$tag-marker-publish.txt" 2>&1
    fi
    capture_marker "$BODY_BRANCH" "$marker" "$EVIDENCE/$tag-marker-baseline.json"
    expected=$(jq -er '.blob.sha | select(test("^[a-f0-9]{40}$"))' "$EVIDENCE/$tag-marker-baseline.json")
    jq -n --arg kind park-marker --arg repository "$SANDBOX_REPOSITORY" --arg branch "$BODY_BRANCH" --arg markerPath "$marker" --arg markerText "$text" --arg expectedBaseBlobSha "$expected" '{kind:$kind,repository:$repository,branch:$branch,markerPath:$markerPath,markerText:$markerText,expectedBaseBlobSha:$expectedBaseBlobSha}' > "$EVIDENCE/$tag-marker-detail.json"
  fi
  expected=$(jq -er .expectedBaseBlobSha "$EVIDENCE/$tag-marker-detail.json")
  intent_file "$step" "$EVIDENCE/$tag-marker-detail.json"
  capture_marker "$BODY_BRANCH" "$marker" "$EVIDENCE/$tag-marker-before.json"
  adopt_file "$step" "$EVIDENCE/$tag-marker-before.json" "$tag-marker-before"
  if test "$ADOPT_ACTION" = execute; then
    test -z "$(git -C "$BODY_WORKTREE" status --porcelain)"
    test -f "$BODY_WORKTREE/$marker"
    test "$(git -C "$BODY_WORKTREE" hash-object -- "$marker")" = "$expected"
    printf '\n- %s\n' "$text" >> "$BODY_WORKTREE/$marker"
    git -C "$BODY_WORKTREE" add -- "$marker" && git -C "$BODY_WORKTREE" commit -m "test(FLY-2456): drill marker $ROUND $label" && git -C "$BODY_WORKTREE" push origin "HEAD:refs/heads/$BODY_BRANCH"
    capture_marker "$BODY_BRANCH" "$marker" "$EVIDENCE/$tag-marker-after.json"
    adopt_file "$step" "$EVIDENCE/$tag-marker-after.json" "$tag-marker-after"
    test "$ADOPT_ACTION" != execute
  fi
}
park_pr() {
  local label=$1 step=park-pr-$1 tag title
  case "$label" in B1|B3) ;; *) return 1;; esac
  body_context "$label"
  tag=$(new_tag)
  title="test(FLY-2456): restart drill fixture $label (do not merge)"
  jq -n --arg repository "$SANDBOX_REPOSITORY" --arg branch "$BODY_BRANCH" --arg title "$title" '{kind:"park-pr",repository:$repository,branch:$branch,title:$title}' > "$EVIDENCE/$tag-pr-detail.json"
  intent_file "$step" "$EVIDENCE/$tag-pr-detail.json"
  capture_park_pr "$BODY_BRANCH" "$EVIDENCE/$tag-pr-before.json"
  adopt_file "$step" "$EVIDENCE/$tag-pr-before.json" "$tag-pr-before"
  if test "$ADOPT_ACTION" = execute; then
    gh pr create --repo "$SANDBOX_REPOSITORY" --base main --head "$BODY_BRANCH" --title "$title" --body 'FLY-2456 529 drill; do not merge.' > "$EVIDENCE/$tag-pr-create.txt"
    capture_park_pr "$BODY_BRANCH" "$EVIDENCE/$tag-pr-after.json"
    adopt_file "$step" "$EVIDENCE/$tag-pr-after.json" "$tag-pr-after"
    test "$ADOPT_ACTION" != execute
  fi
}
park_complete() {
  local label=$1 step=park-complete-$1 tag pr
  case "$label" in B1|B3) ;; *) return 1;; esac
  body_context "$label"
  tag=$(new_tag)
  pr=$(jq -er --arg s "park-pr-$label" '.steps[$s].receipt.result.number' "$MANIFEST")
  jq -n --arg label "$label" --arg issueId "$BODY_ISSUE" --arg executionId "$BODY_EXEC" --arg runId "$BODY_RUN" '{kind:"park-complete",label:$label,issueId:$issueId,executionId:$executionId,runId:$runId}' > "$EVIDENCE/$tag-complete-detail.json"
  intent_file "$step" "$EVIDENCE/$tag-complete-detail.json"
  adopt_db "$step" "$tag-complete-before"
  if test "$ADOPT_ACTION" = execute; then
    slot_runner "$BODY_EXEC" "$BODY_ISSUE" "$BODY_WORKTREE" complete --route needs_review --pr "$pr" --session-role implement --summary 'FLY-2456 drill implement attempt 1' > "$EVIDENCE/$tag-complete-response.json"
    # DEVIATION #13: the engine opens the park projection asynchronously after session_completed; wait (bounded) before the after-snapshot
    local _i=0 _open=0
    while [ $_i -lt 60 ]; do
      _st=$(sqlite3 "$SLOT_DIR/teamlead.db" "select status from sessions where execution_id='$BODY_EXEC';" 2>/dev/null)
      _pk=$(sqlite3 "$SLOT_DIR/state/comm/test-slot-$SLOT/comm.db" "select state from workflow_engine_park where execution_id='$BODY_EXEC';" 2>/dev/null)
      if [ "$_st" = ship_parked ] && [ "$_pk" = open ]; then _open=1; break; fi
      sleep 2; _i=$((_i+1))
    done
    printf '%s park-wait exec=%s iterations=%s status=%s park=%s open=%s\n' "$(date -u +%FT%TZ)" "$BODY_EXEC" "$_i" "$_st" "$_pk" "$_open" >> "$EVIDENCE/park-wait.log"
    test "$_open" = 1
    adopt_db "$step" "$tag-complete-after"
    test "$ADOPT_ACTION" != execute
  fi
}
declare -f park_marker park_pr park_complete > "$EVIDENCE/park-effect-functions.bash"
step_end "park_metadata" "$?"

# ---- qa_metadata [setup] ----
step_begin "qa_metadata" "setup"
adopt_qa_identity() {
  local tag issue
  tag=$(new_tag)
  issue=$(jq -er .config.issues.B1 "$MANIFEST")
  jq -n --arg issueId "$issue" '{kind:"qa-identity",label:"B1",issueId:$issueId}' > "$EVIDENCE/$tag-qa-identity-detail.json"
  intent_file qa-identity-B1 "$EVIDENCE/$tag-qa-identity-detail.json"
  adopt_db qa-identity-B1 "$tag-qa-identity"
  test "$ADOPT_ACTION" != execute
}
qa_fail_b1() {
  local step=qa-fail-B1 tag b1 issue run qa worktree
  tag=$(new_tag)
  b1=$(jq -er '.steps["start-B1"].receipt.result.executionId' "$MANIFEST")
  issue=$(jq -er .config.issues.B1 "$MANIFEST")
  run=$(jq -er '.steps["start-B1"].receipt.result.workflowRunId' "$MANIFEST")
  adopt_qa_identity
  body_context QA
  qa=$BODY_EXEC
  worktree=$BODY_WORKTREE
  jq -n --arg issueId "$issue" --arg runId "$run" --arg preferredActorExecutionId "$b1" --arg qaExecutionId "$qa" '{kind:"qa-fail",label:"B1",issueId:$issueId,runId:$runId,preferredActorExecutionId:$preferredActorExecutionId,qaExecutionId:$qaExecutionId,targetNodeId:"implement",targetAttempt:2}' > "$EVIDENCE/$tag-qa-detail.json"
  intent_file "$step" "$EVIDENCE/$tag-qa-detail.json"
  adopt_db "$step" "$tag-qa-before"
  if test "$ADOPT_ACTION" = execute; then
    slot_runner "$qa" "$issue" "$worktree" qa-result --status fail --target-exec "$b1" --summary 'FLY-2456 drill: deliberate FAIL to wake implement attempt 2' > "$EVIDENCE/$tag-qa-response.json"
    # DEVIATION #14: the rework wake is delivered asynchronously (claimed -> awaiting_receipt -> wake_delivered once the woken body acks); wait (bounded) before the after-snapshot
    local _i=0 _ok=0 _ds=""
    while [ $_i -lt 300 ]; do
      _ds=$(sqlite3 "$SLOT_DIR/teamlead.db" "select d.state from workflow_rework_delivery d join workflow_rework_request q on q.request_id=d.request_id where q.run_id='$run' order by d.updated_at desc limit 1;" 2>/dev/null)
      if [ "$_ds" = wake_delivered ]; then _ok=1; break; fi
      sleep 2; _i=$((_i+1))
    done
    printf '%s rework-wait run=%s iterations=%s delivery=%s ok=%s\n' "$(date -u +%FT%TZ)" "$run" "$_i" "$_ds" "$_ok" >> "$EVIDENCE/rework-wait.log"
    test "$_ok" = 1
    adopt_db "$step" "$tag-qa-after"
    test "$ADOPT_ACTION" != execute
  fi
}
operator_rework_b1() {
  local step=operator-rework-B1 tag b1 issue run actor request token port
  tag=$(new_tag)
  b1=$(jq -er '.steps["start-B1"].receipt.result.executionId' "$MANIFEST")
  issue=$(jq -er .config.issues.B1 "$MANIFEST")
  run=$(jq -er '.steps["start-B1"].receipt.result.workflowRunId' "$MANIFEST")
  actor=flywheel-test-$SLOT
  request=$EVIDENCE/$tag-operator-request.json
  node --input-type=module - "$TESTED" "$MANIFEST" "$EVIDENCE/$tag-operator-detail.json" "$request" "$actor" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const [tested,path,detailPath,requestPath,actor]=process.argv.slice(2);
const require=createRequire(tested+'/packages/teamlead/package.json');const {canonicalSubmissionDigest}=require('flywheel-config');
const m=JSON.parse(readFileSync(path)),r=m.steps['start-B1'].receipt.result;
const feedback='FLY-2456 drill wake';
writeFileSync(detailPath,JSON.stringify({kind:'operator-rework',label:'B1',issueId:r.issueId,runId:r.workflowRunId,preferredActorExecutionId:r.executionId,targetNodeId:'implement',targetAttempt:2,actor,leadFeedback:feedback,principal:'master',founderQuote:null,founderAuthorEvidenceIdentityDigest:canonicalSubmissionDigest({kind:'operator',principal:'master'})}),{flag:'wx'});
writeFileSync(requestPath,JSON.stringify({targetNodeId:'implement',feedback,leadId:actor,clientRequestId:m.bodies.B1.clientRequestId}),{flag:'wx'});
JS
  intent_file "$step" "$EVIDENCE/$tag-operator-detail.json"
  adopt_db "$step" "$tag-operator-before"
  if test "$ADOPT_ACTION" = execute; then
    port=$(python3 - "$SLOT_CONFIG" "$SLOT" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['slots'][int(sys.argv[2])-1]['bridgePort'])
PY
)
    token=$(cat "$SLOT_DIR/state/api-token")
    curl --fail --silent --show-error --max-time 120 -X POST "http://localhost:$port/api/runs/$run/rework" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary "@$request" > "$EVIDENCE/$tag-operator-response.json"
    adopt_db "$step" "$tag-operator-after"
    test "$ADOPT_ACTION" != execute
  fi
}
declare -f adopt_qa_identity qa_fail_b1 operator_rework_b1 > "$EVIDENCE/qa-rework-functions.bash"
step_end "qa_metadata" "$?"

# ---- gate_metadata [setup] ----
step_begin "gate_metadata" "setup"
hold_gate() {
  local label=$1 step=gate-$1 tag
  case "$label" in B1|B2) ;; *) return 1;; esac
  body_context "$label"
  tag=$(new_tag)
  jq -n --arg label "$label" --arg issueId "$BODY_ISSUE" --arg executionId "$BODY_EXEC" '{kind:"gate",label:$label,issueId:$issueId,executionId:$executionId,checkpoint:"question"}' > "$EVIDENCE/$tag-gate-detail.json"
  intent_file "$step" "$EVIDENCE/$tag-gate-detail.json"
  adopt_db "$step" "$tag-gate-before"
  if test "$ADOPT_ACTION" = execute; then
    slot_runner "$BODY_EXEC" "$BODY_ISSUE" "$BODY_WORKTREE" gate question --lead "flywheel-test-$SLOT" --exec-id "$BODY_EXEC" --no-block 'FLY-2456 drill hold' > "$EVIDENCE/$tag-gate-response.json"
    adopt_db "$step" "$tag-gate-after"
    test "$ADOPT_ACTION" != execute
  fi
}
declare -f hold_gate > "$EVIDENCE/gate-function.bash"
step_end "gate_metadata" "$?"

# ---- shape-capture-helper [setup] ----
step_begin "shape-capture-helper" "setup"
capture_shape() {
  local tag b1 b2 b3
  tag=$(new_tag)
  b1=$(jq -er '.steps["start-B1"].receipt.result.executionId' "$MANIFEST")
  b2=$(jq -er '.steps["start-B2"].receipt.result.executionId' "$MANIFEST")
  b3=$(jq -er '.steps["start-B3"].receipt.result.executionId' "$MANIFEST")
  node "$TOOLS" liveness-command --runtime-module "$TESTED/packages/claude-runner/dist/codex-daemon-runtime.js" --state-dir "$SLOT_DIR/state/codex-sessions" --socket-root "$SLOT_DIR/state/cdx-sock" --marker-dir "$SLOT_DIR/state/sync-operation-markers" --exec "$b1" --exec "$b2" --exec "$b3" > "$EVIDENCE/$tag-liveness-command.json"
  jq -er '.command' "$EVIDENCE/$tag-liveness-command.json" > "$EVIDENCE/$tag-liveness-command.bash"
  bash "$EVIDENCE/$tag-liveness-command.bash" > "$EVIDENCE/$tag-liveness.json"
  slot_snapshots "$tag-shape"
  node "$TOOLS" campaign-shape --db "$STATE_COPY" --comm "$COMM_COPY" --liveness "$EVIDENCE/$tag-liveness.json" --body "B1=$b1" --body "B2=$b2" --body "B3=$b3" > "$EVIDENCE/$tag-shape.json"
  node --input-type=module - "$TOOL_REPO" "$STATE_COPY" "$b1" <<'JS' > "$EVIDENCE/$tag-wake-window.json"
import {pathToFileURL} from 'node:url';
const [root,path,execution]=process.argv.slice(2),{openSnapshot}=await import(pathToFileURL(root+'/scripts/lib/qa-fly-2456-db.mjs'));
const {db}=openSnapshot(path,{maxAgeMs:600000});
try {const rows=db.prepare("SELECT bound_at FROM workflow_execution_binding WHERE execution_id=? AND attempt=2 AND mode='wake'").all(execution);if(rows.length!==1)throw Error('wake binding ambiguous');const raw=rows[0].bound_at,at=Date.parse(/^\d{4}-\d\d-\d\d /.test(raw)?raw.replace(' ','T')+'Z':raw),now=Date.now();if(!Number.isFinite(at)||now<at||now-at>300000)throw Error('wake-to-cycle window exceeded');console.log(JSON.stringify({executionId:execution,boundAt:raw,observedAt:new Date(now).toISOString(),elapsedMs:now-at,limitMs:300000}));}finally{db.close();}
JS
  snapshot_release "$EVIDENCE/$tag-shape-release.json"
  CURRENT_SHAPE=$EVIDENCE/$tag-shape.json
}
declare -f capture_shape > "$EVIDENCE/shape-function.bash"
step_end "shape-capture-helper" "$?"

# ---- observe-helper [setup] ----
step_begin "observe-helper" "setup"
observe_campaign() {
  local minutes=${1:-15} tag path start deadline now done
  case "$minutes" in 15|30) ;; *) return 1;; esac
  test ! -e "$EVIDENCE/final-observe.json"
  start=$(jq -er '.steps["cycle-2"].intent.createdAt' "$MANIFEST")
  deadline=$(python3 - "$start" "$minutes" <<'PY'
import datetime,sys
print(int(datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00')).timestamp())+int(sys.argv[2])*60)
PY
)
  while true; do
    tag=$(new_tag)
    path=$(managed_snapshot "$SLOT_DIR/teamlead.db" teamlead '' "$EVIDENCE/$tag-observe-state-snapshot.json")
    node "$TOOLS" observe --db "$path" --manifest "$MANIFEST" --step cycle-2 > "$EVIDENCE/$tag-observe.json"
    done=$(jq -r --arg round "$ROUND" 'if (.bodies.B2.classification=="succeeded" and .bodies.B3.classification=="skipped_not_holder" and .bodies.B1.classification==(if $round=="r1" then "replaced" else "succeeded" end)) then "yes" else "no" end' "$EVIDENCE/$tag-observe.json")
    now=$(date -u +%s)
    if test "$done" = yes || test "$now" -ge "$deadline"; then
      derive_evidence "$path" "$EVIDENCE/final-observe.evidence.json" observation > "$EVIDENCE/final-observe-derivation.json"
      snapshot_release "$EVIDENCE/$tag-observe-release.json"
      cp "$EVIDENCE/$tag-observe.json" "$EVIDENCE/final-observe.json"
      cp "$EVIDENCE/$tag-observe-state-snapshot.json" "$EVIDENCE/final-observe-state-snapshot.json"
      jq -n --arg start "$start" --argjson minutes "$minutes" --arg endedAt "$(date -u +%FT%TZ)" --arg expectedTerminal "$done" '{startedAt:$start,endedAt:$endedAt,limitMinutes:$minutes,extended:($minutes==30),expectedTerminal:($expectedTerminal=="yes")}' > "$EVIDENCE/observe-wait.json"
      break
    fi
    snapshot_release "$EVIDENCE/$tag-observe-release.json"
    sleep 30
  done
}
declare -f observe_campaign > "$EVIDENCE/observe-function.bash"
step_end "observe-helper" "$?"

# ---- comparison-helper [setup] ----
step_begin "comparison-helper" "setup"
record_check() {
  local output=$1 rc
  shift
  test ! -e "$output"
  if node "$TOOLS" "$@" > "$output"; then rc=0; else rc=$?; fi
  jq -e --argjson rc "$rc" '(.status|type)=="string" and (if .status=="pass" then $rc==0 else $rc==1 end)' "$output" >/dev/null
}
comparison_window() {
  local before=$1 after=$2 output=$3
  jq -n --slurpfile before "$before/identity.json" --slurpfile after "$after/identity.json" '{from:$before[0].metadata.observedAt,to:$after[0].metadata.observedAt}' > "$output"
}
archive_ledger() {
  local archive=$1 output=$2
  python3 - "$archive" "$output" <<'PY'
import datetime,hashlib,json,pathlib,sys
archive=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2]);folder=archive/'kill-ledger'
assert archive.is_absolute() and archive.is_dir() and not archive.is_symlink()
assert folder.is_dir() and not folder.is_symlink(),'archive ledger missing'
files=[];rows=[];chunks=[]
for p in sorted(folder.iterdir()):
 assert p.is_file() and not p.is_symlink(),'invalid ledger entry'
 raw=p.read_bytes();files.append({'path':str(p),'sha256':hashlib.sha256(raw).hexdigest()})
 for line in raw.decode().splitlines():
  r=json.loads(line);assert r.get('schemaVersion')==1 and r.get('targetKind') in ['pid','pgid','tmux-window','none']
  assert all(isinstance(r.get(k),str) and r[k] for k in ['ts','source','signal','reason'])
  at=datetime.datetime.fromisoformat(r['ts'].replace('Z','+00:00'));assert at.tzinfo is not None
  if r['targetKind']=='none':
   # DEVIATION #6: reapMcpOrphans inside an isolation root records a no-op boundary refusal (targetKind none, target null) every periodic pass
   assert r.get('refusal')=='isolation_boundary' and r.get('target') is None and r['signal']=='none'
  else:
   assert (isinstance(r.get('target'),str) and r['target']) if r['targetKind']=='tmux-window' else (type(r.get('target')) is int and r['target']>1)
  rows.append(r)
 chunks.append(raw+(b'\n' if raw and not raw.endswith(b'\n') else b''))
combined=b''.join(chunks)
with out.open('xb') as f:f.write(combined)
all_refusals=[r for r in rows if 'isolation_boundary' in json.dumps(r)]
noop_refusals=[r for r in all_refusals if r.get('targetKind')=='none' and r.get('target') is None and r.get('reason')=='periodic_orphan_pass']
refusals=[r for r in all_refusals if r not in noop_refusals]
summary={'status':'fail' if refusals else 'pass','archivePath':str(archive),'ledgerDirectory':str(folder),'files':files,'combinedPath':str(out),'sha256':hashlib.sha256(combined).hexdigest(),'rowCount':len(rows),'refusals':refusals,'noopRefusals':noop_refusals,'noopRefusalCount':len(noop_refusals),'deviation':'#6 noop boundary refusal rows classified informational'}
with pathlib.Path(str(out)+'.summary.json').open('x') as f:json.dump(summary,f)
PY
}
declare -f record_check comparison_window archive_ledger > "$EVIDENCE/comparison-functions.bash"
step_end "comparison-helper" "$?"

# ---- finalize-precondition-helper [setup] ----
step_begin "finalize-precondition-helper" "setup"
finalize_precondition() {
  local out=$EVIDENCE/precondition-checks archive db
  test "$ROUND" = r1
  mkdir -m 700 "$out"
  archive=$(jq -er '.steps["teardown-precondition"].receipt.result.archivePath' "$MANIFEST")
  archive_ledger "$archive" "$out/kill-ledger.ndjson"
  comparison_window "$EVIDENCE/pre-before" "$EVIDENCE/pre-after" "$out/window.json"
  db=$EVIDENCE/pre-after/state.evidence.json
  record_check "$out/fleet.json" fleet-diff --before "$EVIDENCE/pre-before/fleet.txt" --after "$EVIDENCE/pre-after/fleet.txt" --mode post-teardown --decoy fly2454-decoy --sidecar "$EVIDENCE/pre-before/identity.json" --prod-statestore "$db" --kill-ledger "$out/kill-ledger.ndjson" --window "$out/window.json"
  record_check "$out/proc-full.json" proc-attribution --baseline "$EVIDENCE/pre-before/ps-comparison.txt" --after "$EVIDENCE/pre-after/ps-comparison.txt" --slot-dir "$SLOT_DIR" --checkout "$TESTED" --mode post-teardown
  record_check "$out/proc-teardown.json" proc-attribution --baseline "$EVIDENCE/pre-pre-teardown/ps-comparison.txt" --after "$EVIDENCE/pre-after/ps-comparison.txt" --slot-dir "$SLOT_DIR" --checkout "$TESTED" --mode post-teardown
  # DEVIATION #7: Lead attribution layer over needs-attribution proc output (tool ownership = executable path only; codex bodies always NONSLOT)
  python3 "$HOME/.flywheel/qa-evidence/FLY-2456/driver/lead-proc-attribution.py" "$out/proc-full.json" "$EVIDENCE/pre-before/ps-comparison.txt" "$EVIDENCE/pre-after/ps-comparison.txt" "$SLOT_DIR" "$TESTED" "$out/proc-full.lead-attribution.json"
  python3 "$HOME/.flywheel/qa-evidence/FLY-2456/driver/lead-proc-attribution.py" "$out/proc-teardown.json" "$EVIDENCE/pre-pre-teardown/ps-comparison.txt" "$EVIDENCE/pre-after/ps-comparison.txt" "$SLOT_DIR" "$TESTED" "$out/proc-teardown.lead-attribution.json"
  record_check "$out/windows.json" runner-windows --before "$EVIDENCE/pre-before/runner-windows.txt" --after "$EVIDENCE/pre-after/runner-windows.txt" --before-identity "$EVIDENCE/pre-before/identity.json" --after-identity "$EVIDENCE/pre-after/identity.json" --db "$db" --window "$out/window.json"
  python3 - "$MANIFEST" "$EVIDENCE/pre-wait.json" "$out" "$EVIDENCE/precondition.json" <<'PY'
import datetime,json,pathlib,sys
m=json.load(open(sys.argv[1]));wait=json.load(open(sys.argv[2]));d=pathlib.Path(sys.argv[3]);read=lambda p:json.loads((d/p).read_text())
termination=m['steps']['terminate-precondition']['receipt']['result'];archive=m['steps']['teardown-precondition']['receipt']['result']['archivePath'];fleet=read('fleet.json')
failures=[]
try:
 start=datetime.datetime.fromisoformat(wait['startedAt'].replace('Z','+00:00'));end=datetime.datetime.fromisoformat(wait['endedAt'].replace('Z','+00:00'))
 clock_ok=(wait.get('status')=='pass' and start.tzinfo is not None and end.tzinfo is not None and type(wait.get('waitedMs')) is int and wait['waitedMs']>=600000 and end-start==datetime.timedelta(milliseconds=wait['waitedMs']) and end<=datetime.datetime.now(datetime.timezone.utc))
except (KeyError,TypeError,ValueError,AttributeError):clock_ok=False
if not clock_ok:failures.append('wallclock wait')
tick=wait.get('tickEvidence',{})
if wait.get('maintenanceTicks','missing') is not None or tick!={'status':'unavailable','reason':'no_unconditional_tick_observable','rulingQuestionId':'c7791d8e-0d58-44d2-af0f-28b371382737'}:failures.append('UNAVAILABLE tick ruling')
if termination.get('purpose')!='precondition' or termination.get('status')!='terminated' or termination.get('noop') is not False:failures.append('terminate authority')
if fleet.get('status') not in ['pass','needs-attribution']:failures.append('fleet')
for name in ['windows.json','kill-ledger.ndjson.summary.json']:
 if read(name).get('status')!='pass':failures.append(name)
lead_attr={}
for name in ['proc-full.json','proc-teardown.json']:
 st=read(name).get('status');la=read(name.replace('.json','.lead-attribution.json'));lead_attr[name]={'toolStatus':st,'leadStatus':la.get('status'),'counts':la.get('counts'),'path':str(d/name.replace('.json','.lead-attribution.json'))}
 if not (st=='pass' or (st=='needs-attribution' and la.get('status')=='pass')):failures.append(name)
value={**wait,'status':'fail' if failures else 'pass','termination':termination,'fleet':fleet,'archivePath':archive,'failures':failures,'leadAttribution':lead_attr,'deviations':['#6','#7'],'proofPaths':{name:str(d/name) for name in ['fleet.json','proc-full.json','proc-teardown.json','windows.json','kill-ledger.ndjson.summary.json']},'waitPath':sys.argv[2]}
with open(sys.argv[4],'x') as f:json.dump(value,f)
PY
  jq -e '.status=="pass"' "$EVIDENCE/precondition.json" >/dev/null
}
declare -f finalize_precondition > "$EVIDENCE/precondition-finalizer.bash"
step_end "finalize-precondition-helper" "$?"

# ---- compare-round-helper [setup] ----
step_begin "compare-round-helper" "setup"
compare_round() {
  local out=$EVIDENCE/comparisons archive slot_db phase dir db comm label precondition
  local -a exec_args
  mkdir -m 700 "$out"
  archive=$(jq -er '.steps["teardown-main"].receipt.result.archivePath' "$MANIFEST")
  slot_db=$EVIDENCE/final-observe.evidence.json
  archive_ledger "$archive" "$out/kill-ledger.ndjson"
  comparison_window "$EVIDENCE/before" "$EVIDENCE/post-teardown" "$out/full-window.json"
  comparison_window "$EVIDENCE/pre-teardown" "$EVIDENCE/post-teardown" "$out/teardown-window.json"
  record_check "$out/revalidated-observe.json" observe --db "$slot_db" --manifest "$MANIFEST" --step cycle-2
  python3 - "$EVIDENCE/final-observe.json" "$out/revalidated-observe.json" "$MANIFEST" "$SLOT_DIR" "$out" <<'PY'
import hashlib,json,pathlib,sys
actual=json.load(open(sys.argv[1]));verified=json.load(open(sys.argv[2]));assert actual==verified and verified.get('status')=='pass','observation source changed'
m=json.load(open(sys.argv[3]));ids=[]
for e in m['steps'].values():
 if e['intent']['detail']['kind'] in ['start','qa-identity'] and e.get('receipt'):ids.append(e['receipt']['result']['executionId'])
for body in verified['bodies'].values():
 if body.get('replacement'):ids.append(body['replacement']['executionId'])
ids=sorted(set(ids));assert ids and all(isinstance(x,str) and x for x in ids)
out=pathlib.Path(sys.argv[5]);(out/'executions.json').write_text(json.dumps(ids));(out/'declared-sockets.json').write_text(json.dumps([sys.argv[4]+'/state/cdx-sock/'+hashlib.sha1(x.encode()).hexdigest()[:16]+'.sock' for x in ids]))
PY
  exec_args=()
  while IFS= read -r label; do exec_args+=(--exec "$label"); done < <(jq -r '.[]' "$out/executions.json")
  record_check "$out/fleet-live.json" fleet-diff --before "$EVIDENCE/before/fleet.txt" --after "$EVIDENCE/live-after/fleet.txt" --mode live --declared-sockets "$out/declared-sockets.json" --decoy fly2454-decoy
  db=$EVIDENCE/post-teardown/state.evidence.json
  record_check "$out/fleet-post.json" fleet-diff --before "$EVIDENCE/before/fleet.txt" --after "$EVIDENCE/post-teardown/fleet.txt" --mode post-teardown --decoy fly2454-decoy --sidecar "$EVIDENCE/before/identity.json" --prod-statestore "$db" --kill-ledger "$out/kill-ledger.ndjson" --window "$out/full-window.json"
  record_check "$out/proc-live.json" proc-attribution --baseline "$EVIDENCE/before/ps-comparison.txt" --after "$EVIDENCE/live-after/ps-comparison.txt" --slot-dir "$SLOT_DIR" --checkout "$TESTED" --mode live
  record_check "$out/proc-post.json" proc-attribution --baseline "$EVIDENCE/before/ps-comparison.txt" --after "$EVIDENCE/post-teardown/ps-comparison.txt" --slot-dir "$SLOT_DIR" --checkout "$TESTED" --mode post-teardown
  record_check "$out/proc-teardown.json" proc-attribution --baseline "$EVIDENCE/pre-teardown/ps-comparison.txt" --after "$EVIDENCE/post-teardown/ps-comparison.txt" --slot-dir "$SLOT_DIR" --checkout "$TESTED" --mode post-teardown
  record_check "$out/windows-full.json" runner-windows --before "$EVIDENCE/before/runner-windows.txt" --after "$EVIDENCE/post-teardown/runner-windows.txt" --before-identity "$EVIDENCE/before/identity.json" --after-identity "$EVIDENCE/post-teardown/identity.json" --db "$db" --window "$out/full-window.json"
  record_check "$out/windows-teardown.json" runner-windows --before "$EVIDENCE/pre-teardown/runner-windows.txt" --after "$EVIDENCE/post-teardown/runner-windows.txt" --before-identity "$EVIDENCE/pre-teardown/identity.json" --after-identity "$EVIDENCE/post-teardown/identity.json" --db "$db" --window "$out/teardown-window.json"
  for phase in before live-after post-teardown; do
    dir=$EVIDENCE/$phase
    db=$dir/state.evidence.json
    comm=$dir/comm.evidence.json
    record_check "$out/comm-$phase.json" comm-scan --db "$comm" --slot "$SLOT" --lead "flywheel-test-$SLOT" ${exec_args[@]+"${exec_args[@]}"}
    record_check "$out/prod-state-$phase.json" prod-statestore-check --db "$db" ${exec_args[@]+"${exec_args[@]}"}
  done
  for phase in live-after post-teardown; do
    record_check "$out/launch-$phase.json" launch-commits-delta --before "$EVIDENCE/before/launch-commits.txt" --after "$EVIDENCE/$phase/launch-commits.txt" --manifest "$MANIFEST" --db "$slot_db" --step cycle-2
    record_check "$out/alerts-$phase.json" alert-dirs-attribution --before "$EVIDENCE/before/alerts.json" --after "$EVIDENCE/$phase/alerts.json" --slot-lead "flywheel-test-$SLOT"
  done
  precondition=$EVIDENCE/precondition.json
  if test "$ROUND" = r2; then precondition=/Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/precondition.json; fi
  python3 - "$EVIDENCE" "$MANIFEST" "$precondition" <<'PY'
import datetime,hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);out=root/'comparisons';m=json.load(open(sys.argv[2]));prepath=pathlib.Path(sys.argv[3]);pre=json.loads(prepath.read_text());shape=json.loads((root/'campaign-shape.json').read_text());cycle1=json.loads((root/'cycle1-observe.json').read_text())
p=lambda name:str(out/name)
zero={'fleet':{'live':p('fleet-live.json'),'postTeardown':p('fleet-post.json')},'proc':{'live':p('proc-live.json'),'postTeardown':p('proc-post.json'),'teardown':p('proc-teardown.json')},'comm':{'before':p('comm-before.json'),'liveAfter':p('comm-live-after.json'),'postTeardown':p('comm-post-teardown.json')},'prodState':{'before':p('prod-state-before.json'),'liveAfter':p('prod-state-live-after.json'),'postTeardown':p('prod-state-post-teardown.json')},'launchCommits':{'liveAfter':p('launch-live-after.json'),'postTeardown':p('launch-post-teardown.json')},'alerts':{'liveAfter':p('alerts-live-after.json'),'postTeardown':p('alerts-post-teardown.json')},'runnerWindows':{'full':p('windows-full.json'),'teardown':p('windows-teardown.json')},'health':{key:str(root/phase/'health.json') for key,phase in [('before','before'),('liveAfter','live-after'),('preTeardown','pre-teardown'),('postTeardown','post-teardown')]},'killLedger':p('kill-ledger.ndjson.summary.json')}
hide=m['steps'].get('room-info-hide',{});restore=m['steps'].get('room-info-restore',{});c1=m['steps'].get('cycle-1',{});c2=m['steps'].get('cycle-2',{})
def at(value):
 d=datetime.datetime.fromisoformat(value.replace('Z','+00:00'));assert d.tzinfo is not None;return d
try:
 h=hide['receipt']['result'];r=restore['receipt']['result'];identity=h.get('identity')
 hidden=(h.get('action')=='hide' and r.get('action')=='restore' and isinstance(identity,dict) and all(k in identity for k in ['sha256','mode','inode','mtimeMs']) and r.get('identity')==identity and at(c1['receipt']['recordedAt'])<=at(hide['intent']['createdAt'])<=at(hide['receipt']['recordedAt'])<=at(c2['intent']['createdAt'])<=at(c2['receipt']['recordedAt'])<=at(restore['intent']['createdAt'])<=at(restore['receipt']['recordedAt']))
except (KeyError,TypeError,ValueError,AssertionError,AttributeError):hidden=False
gated=shape.get('status')=='pass' and all(shape.get('bodies',{}).get(k,{}).get('openGateIds') for k in ['B1','B2'])
fixture={'roomInfoHidden':bool(hidden),'gateHeld':bool(gated),'cycle1':cycle1,'precondition':pre,'preconditionSource':{'path':str(prepath),'sha256':hashlib.sha256(prepath.read_bytes()).hexdigest()}}
for name,value in [('zero-impact.json',zero),('fixture.json',fixture)]:
 with (root/name).open('x') as f:json.dump(value,f)
PY
  record_check "$EVIDENCE/verdict.json" verdict --round "$ROUND" --manifest "$MANIFEST" --shape "$EVIDENCE/campaign-shape.json" --observe "$EVIDENCE/final-observe.json" --zero-impact "$EVIDENCE/zero-impact.json" --fixture "$EVIDENCE/fixture.json"
  jq -er .markdown "$EVIDENCE/verdict.json" > "$EVIDENCE/verdict.md"
  jq -er .html "$EVIDENCE/verdict.json" > "$EVIDENCE/verdict.html"
  jq -e '.status=="pass"' "$EVIDENCE/verdict.json" >/dev/null
}
declare -f compare_round > "$EVIDENCE/round-comparison-function.bash"
step_end "compare-round-helper" "$?"

# ---- execute-01 [read] ----
step_begin "execute-01" "read"
if ! skip_step "execute-01"; then
DOCTOR_HOME=$(mktemp -d /tmp/fly2456-doctor.XXXXXX)
chmod 700 "$DOCTOR_HOME"
python3 - "$DOCTOR_HOME" <<'PYCODE'
import os,pathlib,sys
source=pathlib.Path('/Users/xiaorongli/.codex/auth.json');target=pathlib.Path(sys.argv[1])/'auth.json'
with target.open('xb') as f:f.write(source.read_bytes())
os.chmod(target,0o600)
PYCODE
DOCTOR_STATUS=0
env -i HOME="$HOME" PATH="$PATH" CODEX_HOME="$DOCTOR_HOME" codex doctor --json > "$EVIDENCE/doctor.json" || DOCTOR_STATUS=$?
python3 - "$DOCTOR_HOME" <<'PYCODE'
import pathlib,sys
(pathlib.Path(sys.argv[1])/'auth.json').unlink()
PYCODE
test "$DOCTOR_STATUS" -eq 0
fi
step_end "execute-01" "$?"

# ---- execute-02 [effect] ----
step_begin "execute-02" "effect"
if ! skip_step "execute-02"; then
ensure_decoy
fi
step_end "execute-02" "$?"

# ---- execute-03 [read] ----
step_begin "execute-03" "read"
if ! skip_step "execute-03"; then
if test "$ROUND" = r1; then
  production_capture pre-before
fi
fi
step_end "execute-03" "$?"

# ---- execute-04 [effect] ----
step_begin "execute-04" "effect"
if ! skip_step "execute-04"; then
if test "$ROUND" = r1; then
deploy_room precondition
fi
fi
step_end "execute-04" "$?"

# ---- execute-05 [effect] ----
step_begin "execute-05" "effect"
if ! skip_step "execute-05"; then
if test "$ROUND" = r1; then
adopt_menu precondition
fi
fi
step_end "execute-05" "$?"

# ---- execute-06 [read] ----
step_begin "execute-06" "read"
if ! skip_step "execute-06"; then
if test "$ROUND" = r1; then
  node "$TOOLS" manifest precondition-body --manifest "$MANIFEST" --issue FLY-202 > "$EVIDENCE/pre-body.json"
fi
fi
step_end "execute-06" "$?"

# ---- execute-07 [effect] ----
step_begin "execute-07" "effect"
if ! skip_step "execute-07"; then
if test "$ROUND" = r1; then
start_body PRE
fi
fi
step_end "execute-07" "$?"

# ---- execute-08 [effect] ----
step_begin "execute-08" "effect"
if ! skip_step "execute-08"; then
if test "$ROUND" = r1; then
terminate_session precondition "$(jq -er '.steps["start-PRE"].receipt.result.executionId' "$MANIFEST")"
fi
fi
step_end "execute-08" "$?"

# ---- execute-09 [read] ----
step_begin "execute-09" "read"
if ! skip_step "execute-09"; then
if test "$ROUND" = r1; then
  wait_precondition > "$EVIDENCE/pre-wait-output.json"
  production_capture pre-pre-teardown
fi
fi
step_end "execute-09" "$?"

# ---- execute-10 [effect] ----
step_begin "execute-10" "effect"
if ! skip_step "execute-10"; then
if test "$ROUND" = r1; then
teardown_room precondition
fi
fi
step_end "execute-10" "$?"

# ---- execute-11 [read] ----
step_begin "execute-11" "read"
if ! skip_step "execute-11"; then
if test "$ROUND" = r1; then
  production_capture pre-after
  finalize_precondition
else
  test -f /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/precondition.json
fi
fi
step_end "execute-11" "$?"

# ---- execute-12 [read] ----
step_begin "execute-12" "read"
if ! skip_step "execute-12"; then
production_capture before
fi
step_end "execute-12" "$?"

# ---- execute-13 [effect] ----
step_begin "execute-13" "effect"
if ! skip_step "execute-13"; then
bash "$HOME/.flywheel/qa-evidence/FLY-2456/driver/late-residue-guard.sh" > "$EVIDENCE/late-residue-guard.json" && deploy_room main
fi
step_end "execute-13" "$?"

# ---- execute-14 [effect] ----
step_begin "execute-14" "effect"
if ! skip_step "execute-14"; then
adopt_menu main
fi
step_end "execute-14" "$?"

# ---- execute-15 [effect] ----
step_begin "execute-15" "effect"
if ! skip_step "execute-15"; then
start_body B3
fi
step_end "execute-15" "$?"

# ---- execute-16 [effect] ----
step_begin "execute-16" "effect"
if ! skip_step "execute-16"; then
park_marker B3
fi
step_end "execute-16" "$?"

# ---- execute-17 [effect] ----
step_begin "execute-17" "effect"
if ! skip_step "execute-17"; then
park_pr B3
fi
step_end "execute-17" "$?"

# ---- execute-18 [effect] ----
step_begin "execute-18" "effect"
if ! skip_step "execute-18"; then
park_complete B3
fi
step_end "execute-18" "$?"

# ---- execute-19 [effect] ----
step_begin "execute-19" "effect"
if ! skip_step "execute-19"; then
start_body B2
fi
step_end "execute-19" "$?"

# ---- execute-20 [effect] ----
step_begin "execute-20" "effect"
if ! skip_step "execute-20"; then
hold_gate B2
fi
step_end "execute-20" "$?"

# ---- execute-21 [effect] ----
step_begin "execute-21" "effect"
if ! skip_step "execute-21"; then
start_body B1
fi
step_end "execute-21" "$?"

# ---- execute-22 [effect] ----
step_begin "execute-22" "effect"
if ! skip_step "execute-22"; then
park_marker B1
fi
step_end "execute-22" "$?"

# ---- execute-23 [effect] ----
step_begin "execute-23" "effect"
if ! skip_step "execute-23"; then
park_pr B1
fi
step_end "execute-23" "$?"

# ---- execute-24 [effect] ----
step_begin "execute-24" "effect"
if ! skip_step "execute-24"; then
park_complete B1
fi
step_end "execute-24" "$?"

# ---- execute-25 [effect] ----
step_begin "execute-25" "effect"
if ! skip_step "execute-25"; then
qa_fail_b1
fi
step_end "execute-25" "$?"

# ---- execute-26 [effect] ----
step_begin "execute-26" "effect"
if ! skip_step "execute-26"; then
hold_gate B1
fi
step_end "execute-26" "$?"

# ---- execute-27 [read] ----
step_begin "execute-27" "read"
if ! skip_step "execute-27"; then
capture_shape
cp "$CURRENT_SHAPE" "$EVIDENCE/shape-before-cycle1.json"
fi
step_end "execute-27" "$?"

# ---- execute-28 [effect] ----
step_begin "execute-28" "effect"
if ! skip_step "execute-28"; then
cycle_room 1
fi
step_end "execute-28" "$?"

# ---- execute-29 [read] ----
step_begin "execute-29" "read"
if ! skip_step "execute-29"; then
python3 - "$MANIFEST" "$EVIDENCE" <<'PY'
import datetime,json,pathlib,sys,time
manifest=json.loads(pathlib.Path(sys.argv[1]).read_text());step=manifest['steps']['cycle-1']
receipt=datetime.datetime.fromisoformat(step['receipt']['recordedAt'].replace('Z','+00:00'))
assert receipt.tzinfo is not None and receipt.timestamp()<=time.time(),'invalid cycle-1 receipt time'
deadline=receipt.timestamp()+60
path=pathlib.Path(sys.argv[2])/'cycle1-wait.json'
expected={'cycleReceiptAt':step['receipt']['recordedAt'],'deadlineEpoch':deadline,'minimumSeconds':60}
if path.exists():assert json.loads(path.read_text())==expected,'cycle-1 wait conflict'
else:
 with path.open('x') as f:json.dump(expected,f)
while time.time() < deadline:time.sleep(min(5,max(0,deadline-time.time())))
with (path.parent/'cycle1-wait-completed.json').open('x') as f:
 json.dump({**expected,'observedEpoch':time.time()},f)
PY
tag=$(new_tag)
slot_snapshots "$tag-cycle1-final"
node "$TOOLS" observe --db "$STATE_COPY" --manifest "$MANIFEST" --step cycle-1 > "$EVIDENCE/cycle1-observe.json"
  snapshot_release "$EVIDENCE/$tag-cycle1-final-release.json"
jq -e '.status=="pass" and (.timeline.sessionEvents|length)==0' "$EVIDENCE/cycle1-observe.json" >/dev/null
fi
step_end "execute-29" "$?"

# ---- execute-30 [effect] ----
step_begin "execute-30" "effect"
if ! skip_step "execute-30"; then
room_transfer hide
fi
step_end "execute-30" "$?"

# ---- execute-31 [read] ----
step_begin "execute-31" "read"
if ! skip_step "execute-31"; then
capture_shape
cp "$CURRENT_SHAPE" "$EVIDENCE/campaign-shape.json"
fi
step_end "execute-31" "$?"

# ---- execute-32 [effect] ----
step_begin "execute-32" "effect"
if ! skip_step "execute-32"; then
cycle_room 2
fi
step_end "execute-32" "$?"

# ---- execute-33 [read] ----
step_begin "execute-33" "read"
if ! skip_step "execute-33"; then
observe_campaign 15
fi
step_end "execute-33" "$?"

# ---- execute-34 [read] ----
step_begin "execute-34" "read"
if ! skip_step "execute-34"; then
production_capture live-after
fi
step_end "execute-34" "$?"

# ---- execute-35 [effect] ----
step_begin "execute-35" "effect"
if ! skip_step "execute-35"; then
room_transfer restore
fi
step_end "execute-35" "$?"

# ---- execute-36 [read] ----
step_begin "execute-36" "read"
if ! skip_step "execute-36"; then
production_capture pre-teardown
fi
step_end "execute-36" "$?"

# ---- execute-37 [effect] ----
step_begin "execute-37" "effect"
if ! skip_step "execute-37"; then
teardown_room main
fi
step_end "execute-37" "$?"

# ---- execute-38 [read] ----
step_begin "execute-38" "read"
if ! skip_step "execute-38"; then
production_capture post-teardown
compare_round
fi
step_end "execute-38" "$?"

# ---- execute-39 [read] ----
step_begin "execute-39" "read"
if ! skip_step "execute-39"; then
test "$ROUND" = r2
if node "$TOOLS" report-pair --r1 /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/verdict.json --r2 /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/verdict.json > "$EVIDENCE/pair.json"; then PAIR_STATUS=0; else PAIR_STATUS=$?; fi
jq -er .markdown "$EVIDENCE/pair.json" > "$EVIDENCE/drill-report.md"
jq -er .html "$EVIDENCE/pair.json" > "$EVIDENCE/founder-report.html"
test "$PAIR_STATUS" -eq 0
fi
step_end "execute-39" "$?"

