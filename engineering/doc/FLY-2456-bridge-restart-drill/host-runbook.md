# FLY-2456 529 房真机重启演练 — 宿主路书
Issue: FLY-2456 (https://linear.app/geoforge3d/issue/FLY-2456/529-房演练-2352-真机重启演练slot-里起-2-3-具-codex-体-重启-slot-bridge-测-reown)
日期: 2026-09-10
基于: plan.md

Shell：兼容宿主 `/bin/bash` 3.2 与 Bash 5；下列命令在同一 Bash 会话中执行。

**宿主 R1/R2 已完成，原始判定与报告保存在 host-runs/r1、host-runs/r2；本次修正等待新头评审与 CI。** 本文件由 implement 交付、Lead 在宿主执行；工具单测不能替代真机结果。以下命令须在同一个 Bash 会话中按顺序运行。每次恢复从 context 和最新权威证据重新收养；不能因为终端输出丢失重做副作用。工具 checkout 与被测 checkout 分开：前者提供本次工具，后者提供被测 Bridge 和实际 selection resolver。R1/R2 均使用固定 SHA；不向任一被测分支 push。

`adopt` 的 `execute` 才允许执行随后的单次副作用；`adopt-existing` / `replay` 跳过它；`conflict` 或命令非零立即停止。证据目录权限 0700，默认文件权限 0600。不得将 token、activation 原始 credential 或带认证的完整进程环境写进报告。

#11 重入：在同一轮原有 slot、context、manifest 与被跳步骤的 receipt/证据仍在且经 Lead 核对时设置 `START_FROM=execute-16`（或后续编号）。只跳过 execute-01..15 中编号更小的块；16 起仍逐步 exact-key adopt/replay，不重复效果。不得用此开关接管失踪的 slot 或填补缺失证据。为空则按原顺序从干净宿主起跑；context/SHA/owner 校验仍执行。

## 01 — 固定本轮路径与 owner 上下文

命令（R1 使用 slot 4；R2 只将 ROUND 改为 r2、SLOT 改为 1、TESTED 改为修后本地 merge checkout。路径须已经存在，不能指向工具分支充当修前）：

<!-- fly2456-step {"id": "setup-01", "kind": "setup"} -->

```bash
set -euo pipefail
umask 077
export START_FROM="${START_FROM:-}"
case "$START_FROM" in ''|execute-0[1-9]|execute-[12][0-9]|execute-3[0-9]) ;; *) exit 70;; esac
skip_step() { test -n "$START_FROM" && [ "$1" \< "$START_FROM" ]; }
export TOOL_REPO=/Users/xiaorongli/Dev/flywheel-FLY-2456
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
if test -n "$START_FROM"; then
  test -f "$EVIDENCE/context.json"
  test -f "$MANIFEST"
  test -d "$SLOT_DIR"
fi
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
```

期望输出: snapshot-owner HTTP 200/ok:true 且 owner.kind=workflow、executionId 与显式 OWNER_EXEC 相同（该端点只返回 current owner）；init 原样创建或重放；context 与 manifest 的 SHA/slot/path/owner 一致。OWNER_EXEC 必须是当前活着且未完成的 DAG 节点 execution，整轮保持固定。Lead 自己的会话返回 session，已完成节点返回 none，都会被上述 jq 拒绝。
落盘: `$EVIDENCE/context.json`、`manifest.json`、`init.json`、`snapshot-owner.json`，无 token。
停手: OWNER_EXEC 未提供或不是当前活着且未完成的 DAG 节点 execution（Lead 会话 session / 已完成节点 none 均不合格）、owner 非 current/错 execution、owner token 不在当前环境、build 不存在、context 冲突、slot/round 配对错误。工具 init 不是装房许可；依赖与残锁检查仍须通过。

## 02 — 定义一致性快照与副本时间戳命令

命令（只定义函数；数据库读取仍由每次显式调用触发。snapshot owner 始终是本次执行，source 根据所采数据库单独配置）：

<!-- fly2456-step {"id": "setup-02", "kind": "setup"} -->

```bash
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
```

期望输出: 无数据库访问、只保存函数定义。实际 snapshot 返回 ok:true；副本严格留在本执行的 2GB 受管目录。
落盘: `snapshot-functions.bash`；每次后续采集各有独立 `*-snapshot.json`、派生判据、release 回执；原副本及 `.meta.json` 随该批 release 删除。
停手: snapshot owner 不可取、预算拒绝、命令非零、副本不在本 execution 目录、meta 已存在。恢复时使用新 tag 捕获新副本，禁止更新旧副本时间戳使其变“新鲜”。不能复制活 DB 主文件，也不能用旧副本判 execute。

### 快照生命周期（Lead 953b3f3a / HIGH managed-snapshot-budget-blocks-drill）

production_capture 串行执行 StateStore 受管采样 → 派生 → 关闭句柄 → release，再执行 CommDB；2GB 是同一 OWNER_EXEC 的硬上限，不分造 owner、不外移 DB、不改护栏。production_databases 的 EXIT trap 覆盖导出失败，主会话 EXIT trap 覆盖 slot 任一步失败；release 失败即停手，不能继续下一次采样。恢复先执行 `snapshot_release "$EVIDENCE/resume-release-$(date -u +%s).json"`，确认上次会话已停止且无 reader 后再采样。不要并行执行本路书。

后续比较读派生证据文件，不再持有受管快照。production 派生只含 sessions/session_events 的身份、终态及事件判据列；observation 派生只含 observe 的五表判据列；comm 派生保留每个物理表的 TEXT/JSON 列值、声明类型、原始存储类型及 view 名称（不读取 view），因此最终才获得的 executionId 也能反查 before。派生不包含源 DB 的索引、触发器、约束和非判据列；消费时只重建内存查询面，保留原 SQL 的全表扫描和负例语义。源 SHA/observedAt 与派生 SHA 分别保留并验证，不能用“派生时间”刷新原证据。私有派生文件按 0600 保留，不提交或发布其原文；报告只使用判据结果。原快照 receipt 的 path 是历史来源，不是可再次读取的路径。

slot 双库只在同一收养/shape 批次内并存；最后一个 reader 后 release。普通 observe 轮询每轮释放，终局先派生再释放，后续 replacement 因果链重验读同一派生，不重采活库。预算拒绝、导出失败、哈希失配或 release 失败均停手，绝不伪造空证据。

## 03 — 显式绑定 slot runner 环境

命令（定义代 runner 的唯一入口；不读 `ps -E`，不输出 ingest token）：

<!-- fly2456-step {"id": "setup-03", "kind": "setup"} -->

```bash
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
```

期望输出: 仅定义函数。调用使用 env -i，仅重建列出的环境；owner API token 与继承的 workflow capability 不进入 slot CLI。真正调用时 exec/issue/worktree 必须来自已收养 receipt 与新鲜 slot StateStore；不使用生产 runner 环境。
落盘: `runner-function.bash`，函数中没有展开后的凭据。
停手: slot token、slot 配置或 worktree 不存在；调用前没有对应 intent/adopt 证据。该函数没有绕过 TURN、QA credential 或收养检查。

## 04 — 捕获房身份，不执行生命周期动作

命令：

<!-- fly2456-step {"id": "setup-04", "kind": "setup"} -->

```bash
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
```

期望输出: 只定义函数；每次捕获输出 scope、文件身份与原始 ps 对应的 PID/lstart。launch spec 只记录 hash，绝不把其环境内容写出。
落盘: `room-functions.bash`；每次 capture 的 JSON、原始 `.ps` 和部署 health。随后 `adopt_file` 添加唯一 meta。
停手: ps 无法读取、格式不符、health 不可用、文件 symlink/缺失、重复输出路径。失败不等于房不存在。

## 05 — 定义 start 的完整 intent → adopt → effect → adopt 流程

命令（定义函数，PRE/B1/B2/B3 每次实际调用均按同一协议；已有 intent 时不得重新预检或重写 selectionDigest）：

<!-- fly2456-step {"id": "setup-05", "kind": "setup", "functions": [{"name": "start_body", "intent": "intent_file \"$step\" \"$detail\"", "adopt": "adopt_db \"$step\" \"$tag-before-start\"", "effect": "curl --fail --silent --show-error --max-time 120 -X POST \"http://localhost:$port/api/runs/start\" -H \"Authorization: Bearer $token\" -H 'Content-Type: application/json' --data-binary \"@$request\" > \"$EVIDENCE/$tag-start-response.json\"", "action": "ADOPT_ACTION"}]} -->

```bash
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
```

期望输出: 已收养的 actual start 身份。响应超时不重发；下一次调用从新快照确认 reservation 四态。
落盘: 固定 request/detail/selection 与 manifest intent、随机 tag 的前后快照和响应、权威收养回执。
停手: preview 非 pass、已有其他 run/reservation、intermediate stage、响应/权威不一致。原始响应 success 不能替代 authoritative adopt。QA 不调用本函数。

## 06 — 定义装房与菜单收养

命令：

<!-- fly2456-step {"id": "setup-06", "kind": "setup", "functions": [{"name": "deploy_room", "intent": "intent_file \"$step\" \"$EVIDENCE/$tag-deploy-detail.json\"", "adopt": "adopt_file \"$step\" \"$EVIDENCE/$tag-deploy-before.json\" \"$tag-deploy-before\"", "effect": "bash \"$TESTED/scripts/test-deploy.sh\" \"$SLOT\" --generalized --codex-runner --no-lead --expect-head \"$TESTED_HEAD\" > \"$EVIDENCE/$tag-deploy.log\" 2>&1", "action": "ADOPT_ACTION"}, {"name": "adopt_menu", "intent": "intent_file \"$step\" \"$EVIDENCE/$tag-menu-detail.json\"", "adopt": "adopt_file \"$step\" \"$EVIDENCE/$tag-menu-before.json\" \"$tag-menu-before\"", "effect": "printf 'flywheel-test-%s: [code, simple_code, generic]\\n' \"$SLOT\" > \"$HOST_REPO/.flywheel/menus/adoption.yaml\"", "action": "ADOPT_ACTION"}]} -->

```bash
late_residue_guard() {
 (
  set -euo pipefail
  test -e "$SLOT_DIR" || return 0
  local out copy
  out=$EVIDENCE/late-residue-$(new_tag)
  mkdir -m 700 "$out"
  # Raw argv/env stays in memory; retain only matched process identities.
  python3 - "$SLOT_DIR" "$SLOT" "$SLOT_CONFIG" "$out" <<'PY'
import json,os,pathlib,re,subprocess,sys
root=pathlib.Path(sys.argv[1]);slot=int(sys.argv[2]);out=pathlib.Path(sys.argv[4])
assert slot in [1,4] and str(root)==f'/tmp/flywheel-test-slot-{slot}'
assert not root.is_symlink() and root.is_dir()
assert not pathlib.Path(str(root)+'.lock').exists(),'lock_present'
port=json.load(open(sys.argv[3]))['slots'][slot-1]['bridgePort']
r=subprocess.run(['lsof','-nP',f'-iTCP:{port}','-sTCP:LISTEN'],capture_output=True,text=True)
assert r.returncode==1 and not r.stdout and not r.stderr,'port_listening_or_probe_failed'
ps=subprocess.run(['ps','-axE','-o','pid=,ppid=,command='],capture_output=True,text=True,check=True)
rows={}
for line in ps.stdout.splitlines():
 m=re.match(r'^\s*(\d+)\s+(\d+)\s+(.+)$',line);assert m,'process_inventory_invalid'
 rows[int(m[1])]=(int(m[2]),m[3])
assert os.getpid() in rows,'self_missing'
chain=set();pid=os.getpid()
while pid>1 and pid in rows:
 assert pid not in chain,'self_cycle'
 chain.add(pid);pid=rows[pid][0]
# Same self-chain exclusion as the host driver; never export the matched environment.
refs=[{'pid':pid,'ppid':ppid} for pid,(ppid,cmd) in rows.items() if str(root) in cmd and pid not in chain and ppid not in chain]
(out/'processes.json').write_text(json.dumps(refs));assert not refs,'process_references_slot'
allowed={'state','state/comm',f'state/comm/test-slot-{slot}',*[f'state/comm/test-slot-{slot}/comm.db{x}' for x in ['', '-wal','-shm']]}
listing=[]
for p in root.rglob('*'):
 rel=p.relative_to(root).as_posix();assert rel in allowed and not p.is_symlink(),'unexpected_content'
 assert p.is_file() if '/comm.db' in rel else p.is_dir(),'unexpected_type'
 listing.append({'path':rel,'size':p.stat().st_size})
assert (root/f'state/comm/test-slot-{slot}/comm.db').is_file(),'comm_missing'
(out/'listing.json').write_text(json.dumps(listing))
PY
  trap 'snapshot_release "$out/release.json"' EXIT
  copy=$(managed_snapshot "$SLOT_DIR/state/comm/test-slot-$SLOT/comm.db" comm "test-slot-$SLOT" "$out/snapshot.json")
  node --input-type=module - "$TOOL_REPO" "$copy" "$out/inspection.json" <<'JS'
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [tools,path,out]=process.argv.slice(2);
const {openSnapshot}=await import(pathToFileURL(tools+'/scripts/lib/qa-fly-2456-db.mjs'));
const {db,metadata}=openSnapshot(path,{maxAgeMs:600000});
try {
 const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
 if(!tables.some(t=>t.name==='sessions'))throw Error('comm schema missing');
 const rows=tables.map(t=>({...t,rowCount:db.prepare('SELECT COUNT(*) AS n FROM "'+t.name.replaceAll('"','""')+'"').get().n}));
 const occupied=rows.filter(t=>t.name!=='mailbox_migration_meta' && t.rowCount!==0);
 writeFileSync(out,JSON.stringify({status:occupied.length?'fail':'pass',metadata,tables:rows}));
 if(occupied.length)throw Error('db_has_rows');
} finally {db.close();}
JS
  snapshot_release "$out/release.json"
  trap - EXIT
  # Re-check the disappearance guards immediately before deletion; any changed content stops.
  test ! -e "$SLOT_DIR.lock"
  python3 - "$SLOT_DIR" "$out/listing.json" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1]);before=json.load(open(sys.argv[2]));after=[]
for p in root.rglob('*'):
 assert not p.is_symlink(),'late_symlink'
 after.append({'path':p.relative_to(root).as_posix(),'size':p.stat().st_size})
assert sorted(before,key=lambda x:x['path'])==sorted(after,key=lambda x:x['path']),'residue_changed'
PY
  rm -r -- "$SLOT_DIR"
  printf '{"status":"removed","evidence":"%s"}\n' "$out"
 )
}
deploy_room() {
  if test "$1" = main && ! jq -e '.steps["deploy-main"].intent' "$MANIFEST" >/dev/null; then late_residue_guard; fi
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
```

期望输出: 仅定义函数。#9 main 首次 deploy 前若出现迟到空 CommDB，先验无 lock/端口/进程引用/非预期文件，再用 managed_snapshot 验所有表为空（仅 mailbox_migration_meta 元数据除外），归档 schema/rowcounts/hash 后 release；任一查询失败或库有业务行即停手，绝不把错误当零、不 cp 原库。原始宿主 driver 只作历史对照。调用后 readoption 证明真实模式、双 build SHA、Bridge 身份与 simple_code 菜单。菜单热读，无额外 cycle。
落盘: `deploy-functions.bash`；每次运行的 deploy/menu intent、前后证据、日志、manifest receipt。
停手: slot 残锁、装房非零、部分 room-info/health 不一致、菜单畸形。官方原语报错后不能自己拆服务；只走后文诊断与官方 teardown。

## 07 — 核验依赖、测试 SHA 与空房边界

命令（预检不生成或替换被测 checkout；Lead 提前准备 R1 frozen main、R2 仅本地 merge 的两个独立 checkout）：

<!-- fly2456-step {"id": "setup-07", "kind": "read"} -->

```bash
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
if test -z "$START_FROM"; then
for n in 1 4; do
  test ! -e "/tmp/flywheel-test-slot-$n.lock"
  test ! -e "/tmp/flywheel-test-slot-$n"
done
else
  test -f "$EVIDENCE/context.json"
  test -f "$MANIFEST"
  test -d "$SLOT_DIR"
fi
command -v codex > "$EVIDENCE/codex-path.txt"
codex --version > "$EVIDENCE/codex-version.txt"
printf '%s\n' "$TESTED_HEAD" > "$EVIDENCE/tested-head.txt"
```

期望输出: 2454 已在被测 SHA 中；R1 仍为修前，R2 包含固定 #1128 头；两 slot 都空。使用 no-lead，所以不要求 2455 的 Lead 启动路径，也不声称覆盖它。
落盘: dependency/pr/SHA/status/version 文件。
停手: 依赖查询多条/无条、PR 已合入导致无法用当前 main 复现修前、SHA 不匹配、checkout dirty、任何残锁。残锁交 Lead 诊断后走官方 teardown 的 intent/adopt 流程，不手删。此处只核版本，隔离 auth 的 `codex doctor` 前置尚待补入完整步骤。

## 08 — 定义生产四次采样

命令（同一 tested checkout 的 fleet 原语、显式默认 tmux socket；采集只读，绝不以静态进程总数替代身份差异）：

<!-- fly2456-step {"id":"production-capture","kind":"setup"} -->

```bash
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
```

期望输出: 每次获得完整 fleet、原始 ps、tmux 身份、不可变 sidecar、两库一致性副本的派生证据、生产 health、launch 与 alert 清单、分桶计数。运行阶段依次使用 before/live-after/pre-teardown/post-teardown 四个唯一 tag。
落盘: `$EVIDENCE/<tag>/` 下文本与 JSON，原副本只在本执行 managed 目录短暂存在；串行派生后释放，不跨采样持有。
停手: 任何采集失败、tmux 身份不唯一、live window 缺失、预算拒绝、重复 tag。不得忽略 ps/tmux 错误后写零计数。Lead cb217d8d 允许仅排除直接启动的采集 ps 自身 PID；ps-comparison.txt 头记录原始行、理由和源/派生 hash，ps-derivation.json 另含完整 artifact hash。其他 NONSLOT 不豁免。alert 原文仅保留私有证据，报告使用分类结果。

## 09 — 定义生产默认 tmux decoy 的收养

命令（只定义函数；前置与 R1 共用同一 decoy，R2 重新收养已存在的同名唯一窗口）：

<!-- fly2456-step {"id":"decoy-helper","kind":"setup","functions":[{"name":"ensure_decoy","intent":"intent_file decoy \"$EVIDENCE/$tag-decoy-detail.json\"","adopt":"adopt_file decoy \"$EVIDENCE/$tag-decoy-before.json\" \"$tag-decoy-before\"","effect":"tmux -S \"$socket\" new-window -d -n fly2454-decoy","action":"ADOPT_ACTION"}]} -->

```bash
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
```

期望输出: 定义函数；实际调用收养恰好一个 fly2454-decoy，并保存 session/window id/name。它必须在生产基线之前已存在，在所有对照采样中存活。
落盘: `decoy-functions.bash`；实际运行时 intent、默认 socket 原始 inventory、收养 receipt。
停手: 默认 tmux server 不可读、多个同名窗口、窗口身份与旧 receipt 冲突。不能为“凑一个”先删旧窗口。

## 10 — 定义拆房收养与归档捕获

命令（拆房前必须已经恢复 room-info、完成严格 pre-teardown 采样；该函数不代替这两个前置）：

<!-- fly2456-step {"id":"teardown-helper","kind":"setup","functions":[{"name":"teardown_room","intent":"intent_file \"$step\" \"$EVIDENCE/$tag-teardown-detail.json\"","adopt":"adopt_file \"$step\" \"$EVIDENCE/$tag-teardown-before.json\" \"$tag-teardown-before\"","effect":"env FLYWHEEL_QA_EVID_DIR=/Users/xiaorongli/.flywheel/qa-evidence bash \"$TESTED/scripts/test-teardown.sh\" \"$SLOT\" > \"$EVIDENCE/$tag-teardown.log\" 2>&1","action":"ADOPT_ACTION"}]} -->

```bash
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
archive_slot_logs() {
  # DEVIATION #17: test-teardown archives only boundary-events/launch-manifest/kill-ledger; keep the slot Bridge and report-host logs for reown failure text
  local tag=$1; for f in bridge.log report-host.log; do test -f "$SLOT_DIR/$f" && cp "$SLOT_DIR/$f" "$EVIDENCE/slot-$tag-$f"; done; return 0
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
```

期望输出: 调用后 slot 消失且唯一新 archive 在 intent 之后产生，权威回执记录 archivePath。官方原语负责 lease 重试，禁止另写循环强拆。
落盘: `teardown-functions.bash`；实际运行的 intent、前后文件证据、原语完整日志、archive receipt。
停手: room-info 尚隐藏、pre-teardown 证据未完成、原语非零、archive 多条或身份不明。不要因 receipt 缺失再运行 teardown；先新捕获再 adopt。归档中 ledger 的 isolation_boundary 仍须单独检查，slot 消失不等于零影响。

## 11 — 定义 room-info 无覆盖转移与紧急恢复

命令（restore 在任何停手交接前优先执行；若 precheck 冲突，保留两份文件并上报，不执行移动）：

<!-- fly2456-step {"id":"room-info-helper","kind":"setup","functions":[{"name":"room_transfer","intent":"intent_file \"$step\" \"$EVIDENCE/$tag-room-detail.json\"","adopt":"adopt_file \"$step\" \"$EVIDENCE/$tag-room-before.json\" \"$tag-room-before\"","effect":"mv -n \"$source\" \"$destination\"","action":"ADOPT_ACTION"}]} -->

```bash
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
```

期望输出: hide/restore 均沿同一持久 identity 收养；原始 inode、mode、mtime、sha256 保持一致。重复调用不再次移动。
落盘: `room-info-function.bash`；identity、intent、pre/postcheck、前后捕获与 receipt。
停手: 双文件并存、缺失、身份变化或 precheck 非零。`mv -n` 即使退出 0 也不直接视为成功，必须 postcheck 与 adopt。恢复失败时不得继续 teardown。

## 12 — 定义 cycle 的完整 pre-state 与恢复收养

命令（同一 step 只允许一个固定 pre-state；已有 intent 时只用原下界，不捕获新下界掩盖第一次执行）：

<!-- fly2456-step {"id":"cycle-helper","kind":"setup","functions":[{"name":"cycle_room","intent":"intent_file \"$step\" \"$EVIDENCE/$tag-cycle-detail.json\"","adopt":"adopt_file \"$step\" \"$EVIDENCE/$tag-cycle-before.json\" \"$tag-cycle-before\"","effect":"bash \"$TESTED/scripts/test-cycle-bridge.sh\" \"$SLOT\" > \"$EVIDENCE/$tag-cycle.log\" 2>&1","action":"ADOPT_ACTION"}]} -->

```bash
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
```

期望输出: 官方 cycle 原语完成，新 Bridge PID/lstart 与原 spec 一致；观察文件保留 intent 原始下界后的全部相关事件。observe 的 pass 只代表解析成功，具体恢复结果在每具 classification。
落盘: `cycle-function.bash`，listener PID、完整 ps、log offset、bounds、spec hash、intent、前后身份、原语日志与 observe JSON。
停手: listener 不唯一或祖先链不到 bridge.pid、pre-state 不全、原语非零、cycle-failed、PID/spec 冲突。无 receipt 时必须 adopt；不得自动启动第二次同编号 cycle。1 秒延迟只避免 lstart 秒精度与 intent 毫秒同秒，不代替 identity 核验。

## 13 — 定义单个 session terminate 的收养

命令（只接受 PRE 前置体，或明确登记的 QA fallback；不调用 run terminate）：

<!-- fly2456-step {"id":"terminate-helper","kind":"setup","functions":[{"name":"terminate_session","intent":"intent_file \"$step\" \"$EVIDENCE/$tag-terminate-detail.json\"","adopt":"adopt_db \"$step\" \"$tag-terminate-before\"","effect":"curl --fail --silent --show-error --max-time 60 -X POST \"http://localhost:$port/api/actions/terminate\" -H \"Authorization: Bearer $token\" -H 'Content-Type: application/json' --data-binary \"@$EVIDENCE/$tag-terminate-request.json\" > \"$EVIDENCE/$tag-terminate-response.json\"","action":"ADOPT_ACTION"}]} -->

```bash
slot_scalar() {
  node --input-type=module - "$TESTED" "$@" <<'JS'
import {createRequire} from 'node:module';
const [tested,path,sql,...parameters]=process.argv.slice(2);
const require=createRequire(tested+'/packages/flywheel-comm/package.json');
const Database=require('better-sqlite3');
const db=new Database(path,{readonly:true,fileMustExist:true});
try { const row=db.prepare(sql).get(...parameters); console.log(row ? Object.values(row)[0] ?? '' : ''); }
finally {db.close();}
JS
}
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
      _w=$(slot_scalar "$SLOT_DIR/state/comm/test-slot-$SLOT/comm.db" "select coalesce(tmux_window,'') from sessions where execution_id=?" "$execution")
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
declare -f slot_scalar terminate_session > "$EVIDENCE/terminate-function.bash"
```

期望输出: PRE 必须是 intent 后真实 terminated + 对应 lead_events action_executed；自然结束不算前置成功。QA 已不可恢复时明确记录 noop / not-executed。
落盘: `terminate-function.bash`；请求、前后副本、action identity 与 manifest receipt，不记录 token。
停手: execution 未由 PRE start/QA identity 收养、session 自然终态不满足 PRE、action 冲突、API 非零。动作 receipt 不代表 orphan cleanup 或维护 tick 完成，后续仍需等待并取证。

## 14 — PRE 终止后的持久墙钟等待

命令（定义前置等待函数；Lead question c7791d8e 裁定：无无条件 tick 观察面时只记录结构性 UNAVAILABLE，不伪造计数）：

<!-- fly2456-step {"id":"precondition-clock","kind":"setup"} -->

```bash
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
```

期望输出: waitedMs ≥600000、持久化起止 UTC 时间；maintenanceTicks=null，tickEvidence 明确 unavailable。它不声称 orphan sweep 已执行两次。
落盘: `pre-wait-start.json`、`pre-wait.json`，都独占创建；恢复继续同一时钟，不重置起点。
停手: PRE 终止未被收养、事件身份变化、时钟记录冲突。Lead 允许的结构性例外只免除不可观察的 tick 计数，不免墙钟等待与后续 teardown/fleet/ledger 检查。

## P1 — 从新鲜副本取得靶体工作树并捕获远端 marker / PR

命令（只定义函数；SANDBOX_REPOSITORY 固定为隔离沙箱，不从生产 remote 推断）：

<!-- fly2456-step {"id":"park-capture-helpers","kind":"setup"} -->
```bash
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
 const s=db.prepare('SELECT execution_id,issue_id,project_name,worktree_path,COALESCE(branch,worktree_binding_branch) AS branch,branch AS branch_raw,worktree_binding_branch FROM sessions WHERE execution_id=?').get(r.executionId);
 if(!s||s.issue_id!==r.issueId||s.project_name!==`test-slot-${m.config.slot}`||typeof s.worktree_path!=='string'||!s.worktree_path.startsWith(slotDir+'/')||typeof s.branch!=='string'||!/^[-\w/]+$/.test(s.branch)||s.branch.includes('..'))throw Error('body context mismatch');
 console.log(JSON.stringify({...s,runId:r.workflowRunId}));
}finally{db.close();}
JS
  snapshot_release "$EVIDENCE/$tag-body-context-release.json"
  BODY_EXEC=$(jq -er .execution_id "$EVIDENCE/$tag-body-context.json")
  BODY_ISSUE=$(jq -er .issue_id "$EVIDENCE/$tag-body-context.json")
  BODY_RUN=$(jq -er .runId "$EVIDENCE/$tag-body-context.json")
  BODY_WORKTREE=$(jq -er .worktree_path "$EVIDENCE/$tag-body-context.json")
  # #8 Codex branch 真相在 worktree_binding_branch；COALESCE 后仍与 git 实际分支交叉校验。
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
```
期望输出: 无宿主动作；后续 capture 保留 ls-remote、commit→tree→blob 全链与 PR 查询 scope。
落盘: `park-capture-functions.bash`；调用时各自随机 tag 的副本/远端响应。
停手: execution/run/issue、slot 工作树或 sandbox remote 不匹配；多远端 ref/marker/PR；API 非零。不通过 production remote 提交。

## P2 — B1/B3 marker、PR 与 complete 的分步收养

命令（每个函数独立 intent/adopt；只允许 B1/B3）：

<!-- fly2456-step {"id": "park_metadata", "kind": "setup", "functions": [{"name": "park_publish", "intent": "intent_file \"$step\" \"$EVIDENCE/$tag-publish-detail.json\"", "adopt": "adopt_file \"$step\" \"$EVIDENCE/$tag-publish-before.json\" \"$tag-publish-before\"", "effect": "git -C \"$BODY_WORKTREE\" push origin \"HEAD:refs/heads/$BODY_BRANCH\" > \"$EVIDENCE/$tag-marker-publish.txt\" 2>&1", "action": "ADOPT_ACTION"}, {"name": "park_marker", "intent": "intent_file \"$step\" \"$EVIDENCE/$tag-marker-detail.json\"", "adopt": "adopt_file \"$step\" \"$EVIDENCE/$tag-marker-before.json\" \"$tag-marker-before\"", "effect": "git -C \"$BODY_WORKTREE\" add -- \"$marker\" && git -C \"$BODY_WORKTREE\" commit -m \"test(FLY-2456): drill marker $ROUND $label\" && git -C \"$BODY_WORKTREE\" push origin \"HEAD:refs/heads/$BODY_BRANCH\"", "action": "ADOPT_ACTION"}, {"name": "park_pr", "intent": "intent_file \"$step\" \"$EVIDENCE/$tag-pr-detail.json\"", "adopt": "adopt_file \"$step\" \"$EVIDENCE/$tag-pr-before.json\" \"$tag-pr-before\"", "effect": "gh pr create --repo \"$SANDBOX_REPOSITORY\" --base main --head \"$BODY_BRANCH\" --title \"$title\" --body 'FLY-2456 529 drill; do not merge.' > \"$EVIDENCE/$tag-pr-create.txt\"", "action": "ADOPT_ACTION"}, {"name": "park_complete", "intent": "intent_file \"$step\" \"$EVIDENCE/$tag-complete-detail.json\"", "adopt": "adopt_db \"$step\" \"$tag-complete-before\"", "effect": "slot_runner \"$BODY_EXEC\" \"$BODY_ISSUE\" \"$BODY_WORKTREE\" complete --route needs_review --pr \"$pr\" --session-role implement --summary 'FLY-2456 drill implement attempt 1' > \"$EVIDENCE/$tag-complete-response.json\"", "action": "ADOPT_ACTION"}]} -->
```bash
park_publish() {
  local label=$1 step=park-publish-$1 tag expected marker=doc/qa/sandbox-notes.md
  tag=$(new_tag)
  if jq -e --arg s "$step" '.steps[$s].intent' "$MANIFEST" >/dev/null; then
    jq -e --arg s "$step" '.steps[$s].intent.detail' "$MANIFEST" > "$EVIDENCE/$tag-publish-detail.json"
  else
    expected=$(git -C "$BODY_WORKTREE" rev-parse HEAD)
    jq -n --arg repository "$SANDBOX_REPOSITORY" --arg branch "$BODY_BRANCH" --arg expectedHead "$expected" '{kind:"park-publish",repository:$repository,branch:$branch,expectedHead:$expectedHead}' > "$EVIDENCE/$tag-publish-detail.json"
  fi
  intent_file "$step" "$EVIDENCE/$tag-publish-detail.json"
  capture_marker "$BODY_BRANCH" "$marker" "$EVIDENCE/$tag-publish-before.json"
  adopt_file "$step" "$EVIDENCE/$tag-publish-before.json" "$tag-publish-before"
  if test "$ADOPT_ACTION" = execute; then
    test -z "$(git -C "$BODY_WORKTREE" status --porcelain)"
    test "$(git -C "$BODY_WORKTREE" rev-parse HEAD)" = "$(jq -er .expectedHead "$EVIDENCE/$tag-publish-detail.json")"
    git -C "$BODY_WORKTREE" push origin "HEAD:refs/heads/$BODY_BRANCH" > "$EVIDENCE/$tag-marker-publish.txt" 2>&1
    capture_marker "$BODY_BRANCH" "$marker" "$EVIDENCE/$tag-publish-after.json"
    adopt_file "$step" "$EVIDENCE/$tag-publish-after.json" "$tag-publish-after"
    test "$ADOPT_ACTION" != execute
  fi
}
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
    park_publish "$label"
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
      _st=$(slot_scalar "$SLOT_DIR/teamlead.db" "select status from sessions where execution_id=?" "$BODY_EXEC")
      _pk=$(slot_scalar "$SLOT_DIR/state/comm/test-slot-$SLOT/comm.db" "select state from workflow_engine_park where execution_id=?" "$BODY_EXEC")
      if [ "$_st" = ship_parked ] && [ "$_pk" = open ]; then
        _open=1; break
      fi
      sleep 2; _i=$((_i+1))
    done
    printf '%s park-wait exec=%s iterations=%s status=%s park=%s open=%s\n' "$(date -u +%FT%TZ)" "$BODY_EXEC" "$_i" "$_st" "$_pk" "$_open" >> "$EVIDENCE/park-wait.log"
    test "$_open" = 1
    adopt_db "$step" "$tag-complete-after"
    test "$ADOPT_ACTION" != execute
  fi
}
declare -f park_publish park_marker park_pr park_complete > "$EVIDENCE/park-effect-functions.bash"
```
期望输出: marker 与 PR 回执独立；complete 权威为 ship_parked + implement1 done + park_opened 投影，不以 CLI success 代替。
落盘: 三种 intent、首次 intent 前的远端 baseline blob SHA 与凭据、complete 前后副本与收养 receipt。
停手: 脏工作树或本地 notes blob 不等于首次 intent 固定的 expectedBaseBlobSha，停止人工对照，不追加第二个 commit；不 reset/force push。部分 complete 或 held 停手。

## P3 — 引擎 QA 身份、一次 QA fail 与显式 operator 备选

命令（QA 身份只从引擎 qa1 与 CommDB activation 收养；不 start QA）：

<!-- fly2456-step {"id": "qa_metadata", "kind": "setup", "functions": [{"name": "qa_fail_b1", "intent": "intent_file \"$step\" \"$EVIDENCE/$tag-qa-detail.json\"", "adopt": "adopt_db \"$step\" \"$tag-qa-before\"", "effect": "slot_runner \"$qa\" \"$issue\" \"$worktree\" qa-result --status fail --target-exec \"$b1\" --summary 'FLY-2456 drill: deliberate FAIL to wake implement attempt 2' > \"$EVIDENCE/$tag-qa-response.json\"", "action": "ADOPT_ACTION"}, {"name": "operator_rework_b1", "intent": "intent_file \"$step\" \"$EVIDENCE/$tag-operator-detail.json\"", "adopt": "adopt_db \"$step\" \"$tag-operator-before\"", "effect": "curl --fail --silent --show-error --max-time 120 -X POST \"http://localhost:$port/api/runs/$run/rework\" -H \"Authorization: Bearer $token\" -H 'Content-Type: application/json' --data-binary \"@$request\" > \"$EVIDENCE/$tag-operator-response.json\"", "action": "ADOPT_ACTION"}]} -->
```bash
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
      _ds=$(slot_scalar "$SLOT_DIR/teamlead.db" "select d.state from workflow_rework_delivery d join workflow_rework_request q on q.request_id=d.request_id where q.run_id=? order by d.updated_at desc limit 1" "$run")
      if [ "$_ds" = wake_delivered ]; then
        _ok=1; break
      fi
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
```
期望输出: qa-fail 或 operator 请求最终由 request→route revision→wake_delivered 证明，同一 B1 被 wake 到 implement2。
落盘: QA engine 身份 receipt；不输出 credential；稳定 clientRequestId 与逐次副本、QA/HTTP 响应。
停手: QA 尚未出现、credential 中间态、已有 rework、run held 或 delivery 未完成，停止并重新采集，不重发随机 QA request。operator 是显式备选，不能在 qa-fail conflict 后自动调用。需要清理 QA attempt1 时先使用主路书的 session 级 `purpose=qa-fallback` terminate 流程，报告 noop 时写明未执行 terminate；重新 campaign-shape 后才继续。operator source 固定 principal=master、founderQuote=null、不伪造 founder consent 或 escalationAck。真实 route 的 Lead 配置/consent/quiescence 拒绝都保持停手。

## P4 — B1/B2 持有固定 gate

命令（checkpoint question，问题归属该体的隔离环境）：

<!-- fly2456-step {"id": "gate_metadata", "kind": "setup", "functions": [{"name": "hold_gate", "intent": "intent_file \"$step\" \"$EVIDENCE/$tag-gate-detail.json\"", "adopt": "adopt_db \"$step\" \"$tag-gate-before\"", "effect": "slot_runner \"$BODY_EXEC\" \"$BODY_ISSUE\" \"$BODY_WORKTREE\" gate question --lead \"flywheel-test-$SLOT\" --exec-id \"$BODY_EXEC\" --no-block 'FLY-2456 drill hold' > \"$EVIDENCE/$tag-gate-response.json\"", "action": "ADOPT_ACTION"}]} -->
```bash
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
```
期望输出: 唯一同 owner/recipient/checkpoint/content 的 open gate 被收养，持有 questionId。
落盘: gate intent、前后两套新鲜副本、gate 响应和 receipt。
停手: 多 gate、字段不符、TURN/holder 不符或 cycle 前 campaign-shape 非 pass。此处不为 B3 创建 gate。

## O1 — 实际 daemon 探针、activation 与资格快照

命令（定义函数；生成的探针命令由宿主明确执行，工具自身不 spawn）：

<!-- fly2456-step {"id":"shape-capture-helper","kind":"setup"} -->
```bash
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
```
期望输出: B1 spawn@1+wake@2 同 execution、B2/B3 单 activation；B1/B2 open gate+TURN holder，B3 parked 非 holder；真实 probe/PGID/socket holder 符合资格，wake 距本次捕获不超过五分钟。
落盘: 实际 probe 脚本与结果、两库副本、shape 与 wake-window JSON；CURRENT_SHAPE 指向本次不可变文件。
停手: probe unknown、形状不符、错 TURN、bound_at 异常或超窗。不能把重试制造的第三 activation 当作同形状；停手交 Lead 决定新试次，不能覆盖旧 manifest。

## O2 — 固定 cycle 2 下界观察第一 episode

命令（定义函数；默认十五分钟，三十分钟只通过显式参数 30 选择并记录，不自动延长）：

<!-- fly2456-step {"id":"observe-helper","kind":"setup"} -->
```bash
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
```
期望输出: final-observe 保留第一 episode 的实际分类与原始序列，修前换体来自 rollback→materialized→launched 因果链；超时也保存真实未达标结果，不写 success。
落盘: 每次 observe JSON 与 release 回执（源副本不保留）；最终 `final-observe.json`、对应 snapshot receipt、`final-observe.evidence.json` 及哈希和 `observe-wait.json`。
停手: snapshot/解析非零、预算拒绝、已有 final 文件。超时后先按恢复/采样/拆房流程收证，最后 verdict 判失败或不足；不盲目追加 cycle 或延长等待。


## C1 — 比较辅助函数与 archive ledger 证据

命令（只定义；这些函数不采集活服务，不把命令 exit 1 改写成 pass）：

<!-- fly2456-step {"id":"comparison-helper","kind":"setup"} -->
```bash
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
```
期望输出: 只保存定义；record_check 保留原始 status 与 exit。空 ledger 仅来自存在且完整枚举的 archive/kill-ledger，不能由缺失目录补造。
落盘: `comparison-functions.bash`；调用时原始文件 SHA、派生 NDJSON SHA、逐条拒绝记录。#6 的 none/null/signal=none/periodic_orphan_pass 空转拒绝单列 noopRefusals，不作越界杀；带目标拒绝仍失败。
停手: 缺目录/副本、畸形 JSON、未知 ledger schema、工具无结构化结果或 exit/status 不匹配。正常 fail/needs-attribution 被保留，汇总最终仍非 pass 时停止。

## C2 — 汇总 R1 的真实 PRE 前置证据

命令（在 pre-before、pre-pre-teardown、pre-after 与 teardown-precondition receipt 都完成后调用 finalize_precondition；R2 引用这个归档，不重做 PRE）：

<!-- fly2456-step {"id":"finalize-precondition-helper","kind":"setup"} -->
```bash
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
  python3 "$TOOL_REPO/scripts/lib/qa-fly-2456-lead-proc-attribution.py" "$out/proc-full.json" "$EVIDENCE/pre-before/ps-comparison.txt" "$EVIDENCE/pre-after/ps-comparison.txt" "$SLOT_DIR" "$TESTED" "$out/proc-full.lead-attribution.json"
  python3 "$TOOL_REPO/scripts/lib/qa-fly-2456-lead-proc-attribution.py" "$out/proc-teardown.json" "$EVIDENCE/pre-pre-teardown/ps-comparison.txt" "$EVIDENCE/pre-after/ps-comparison.txt" "$SLOT_DIR" "$TESTED" "$out/proc-teardown.lead-attribution.json"
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
```
期望输出: 原样保留 pre-wait 的 UTC 起止、waitedMs、maintenanceTicks=null 与结构性 UNAVAILABLE ruling，不伪造 tick。PRE terminate、fleet、archive 与 ledger 同时落入 summary。
落盘: `precondition-checks/*`、`precondition.json`。
停手: 任一比较/墙钟/动作证据不满足。即使输出已写入也停止，不把 needs-attribution proc 解释为空。fleet needs-attribution 必须由真实逐行终态证据支持，verdict 会再次检查。

## C3 — 四次生产比较、fixture 与双轮报告输入

命令（只定义；compare_round 的输入固定为四个采集目录与已完成的观察文件，不从当前活房补证据）：

<!-- fly2456-step {"id":"compare-round-helper","kind":"setup"} -->
```bash
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
  python3 "$TOOL_REPO/scripts/lib/qa-fly-2456-lead-proc-attribution.py" "$out/proc-live.json" "$EVIDENCE/before/ps-comparison.txt" "$EVIDENCE/live-after/ps-comparison.txt" "$SLOT_DIR" "$TESTED" "$out/proc-live.lead-attribution.json"
  python3 "$TOOL_REPO/scripts/lib/qa-fly-2456-lead-proc-attribution.py" "$out/proc-post.json" "$EVIDENCE/before/ps-comparison.txt" "$EVIDENCE/post-teardown/ps-comparison.txt" "$SLOT_DIR" "$TESTED" "$out/proc-post.lead-attribution.json"
  python3 "$TOOL_REPO/scripts/lib/qa-fly-2456-lead-proc-attribution.py" "$out/proc-teardown.json" "$EVIDENCE/pre-teardown/ps-comparison.txt" "$EVIDENCE/post-teardown/ps-comparison.txt" "$SLOT_DIR" "$TESTED" "$out/proc-teardown.lead-attribution.json"
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
zero['procLead']={key:p('proc-'+name+'.lead-attribution.json') for key,name in [('live','live'),('postTeardown','post'),('teardown','teardown')]}
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
```
期望输出: 先保留全部比较状态，再由 verdictRound 决定 pass/fail/needs-attribution；任何不可解析输入直接停止，不填默认零值。R2 用真实 R1 precondition 原件及 hash。
落盘: `comparisons/*`、`zero-impact.json`、`fixture.json`、`verdict.json/md/html`。两轮结束后 pair composer 输入分别为固定 r1/verdict.json 与 r2/verdict.json；root 的发布序列另行调用，不从这里投递报告。
停手: 所有最终非 pass。fleet 的已证明终态归因由 verdict 保留且可能允许 pass；proc 原始判定保持不变；按 #7 运行 Lead 机械归因层，逐行保留 rule/evidence，只有工具 pass 或 needs-attribution 且 Lead 层 pass 才通过归因门。工具 fail、生产伤亡或未归因 removed 行仍停手。final-observe-state-snapshot.json 仅保留原始受管 receipt，不再解引用已释放的 path；重验与 replacement 收养读取同源 final-observe.evidence.json（源 observedAt/SHA 保留、派生 SHA 单独验证），禁止换用新采样。

## E01 — 隔离 auth 的 doctor 前置

命令：

<!-- fly2456-step {"id": "execute-01", "kind": "read"} -->
```bash
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
```
期望输出: doctor 返回 0，输出为 CLI 明确标注的 redacted JSON；复制的 auth 已删除。
落盘: doctor.json；临时诊断目录不作为报告附件。
停手: doctor 非零、复制/清理失败；不进入装房。若中断在 doctor 中途，先删除该临时 auth 文件，禁止把它归档。

## E02 — 在生产基线前收养 decoy

命令：

<!-- fly2456-step {"id": "execute-02", "kind": "effect", "call": "ensure_decoy"} -->
```bash
if ! skip_step "execute-02"; then
ensure_decoy
fi
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E03 — R1 前置生产基线

命令：

<!-- fly2456-step {"id": "execute-03", "kind": "read"} -->
```bash
if ! skip_step "execute-03"; then
if test "$ROUND" = r1; then
  production_capture pre-before
fi
fi
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: r1/pre-before/ 全部采样。R2 复用已验证的 r1 前置结论。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E04 — R1 前置装房

命令：

<!-- fly2456-step {"id": "execute-04", "kind": "effect", "call": "deploy_room precondition"} -->
```bash
if ! skip_step "execute-04"; then
if test "$ROUND" = r1; then
deploy_room precondition
fi
fi
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E05 — R1 前置菜单

命令：

<!-- fly2456-step {"id": "execute-05", "kind": "effect", "call": "adopt_menu precondition"} -->
```bash
if ! skip_step "execute-05"; then
if test "$ROUND" = r1; then
adopt_menu precondition
fi
fi
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E06 — 登记独立 PRE 请求身份

命令：

<!-- fly2456-step {"id": "execute-06", "kind": "read"} -->
```bash
if ! skip_step "execute-06"; then
if test "$ROUND" = r1; then
  node "$TOOLS" manifest precondition-body --manifest "$MANIFEST" --issue FLY-202 > "$EVIDENCE/pre-body.json"
fi
fi
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E07 — R1 起一次性 PRE 真体

命令：

<!-- fly2456-step {"id": "execute-07", "kind": "effect", "call": "start_body PRE"} -->
```bash
if ! skip_step "execute-07"; then
if test "$ROUND" = r1; then
start_body PRE
fi
fi
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E08 — 只终止已收养的 PRE session

命令：

<!-- fly2456-step {"id": "execute-08", "kind": "effect", "call": "terminate_session precondition \"$(jq -er '.steps[\"start-PRE\"].receipt.result.executionId' \"$MANIFEST\")\""} -->
```bash
if ! skip_step "execute-08"; then
if test "$ROUND" = r1; then
terminate_session precondition "$(jq -er '.steps["start-PRE"].receipt.result.executionId' "$MANIFEST")"
fi
fi
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E09 — 等待真实墙钟下限

命令：

<!-- fly2456-step {"id": "execute-09", "kind": "read"} -->
```bash
if ! skip_step "execute-09"; then
if test "$ROUND" = r1; then
  wait_precondition > "$EVIDENCE/pre-wait-output.json"
  production_capture pre-pre-teardown
fi
fi
```
期望输出: 墙钟 >=600s；tick 计数结构性 UNAVAILABLE；严格拆房前采样完整。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E10 — R1 前置官方拆房

命令：

<!-- fly2456-step {"id": "execute-10", "kind": "effect", "call": "teardown_room precondition"} -->
```bash
if ! skip_step "execute-10"; then
if test "$ROUND" = r1; then
teardown_room precondition
fi
fi
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E11 — 前置零影响与归档验收

命令：

<!-- fly2456-step {"id": "execute-11", "kind": "read"} -->
```bash
if ! skip_step "execute-11"; then
if test "$ROUND" = r1; then
  production_capture pre-after
  finalize_precondition
else
  test -f /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/precondition.json
fi
fi
```
期望输出: 前置 fleet、严格 proc 比较、archive/ledger 与墙钟全部有证据；任何未解释项不能进 R1。
落盘: r1/precondition.json 与源采样/比较文件。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E12 — 本轮生产 before 基线

命令：

<!-- fly2456-step {"id": "execute-12", "kind": "read"} -->
```bash
if ! skip_step "execute-12"; then
production_capture before
fi
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本轮 before/，decoy 必须存在。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E13 — 装主演练房

命令：

<!-- fly2456-step {"id": "execute-13", "kind": "effect", "call": "deploy_room main"} -->
```bash
if ! skip_step "execute-13"; then
deploy_room main
fi
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E14 — 收养主房菜单

命令：

<!-- fly2456-step {"id": "execute-14", "kind": "effect", "call": "adopt_menu main"} -->
```bash
if ! skip_step "execute-14"; then
adopt_menu main
fi
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E15 — 起 B3 单 activation 阴性对照

命令：

<!-- fly2456-step {"id": "execute-15", "kind": "effect", "call": "start_body B3"} -->
```bash
if ! skip_step "execute-15"; then
start_body B3
fi
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E16 — B3 marker

命令：

<!-- fly2456-step {"id": "execute-16", "kind": "effect", "call": "park_marker B3"} -->
```bash
park_marker B3
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E17 — B3 sandbox PR

命令：

<!-- fly2456-step {"id": "execute-17", "kind": "effect", "call": "park_pr B3"} -->
```bash
park_pr B3
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E18 — B3 parked 并交出 TURN

命令：

<!-- fly2456-step {"id": "execute-18", "kind": "effect", "call": "park_complete B3"} -->
```bash
park_complete B3
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E19 — 起 B2 单 activation 正对照

命令：

<!-- fly2456-step {"id": "execute-19", "kind": "effect", "call": "start_body B2"} -->
```bash
start_body B2
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E20 — B2 固定 gate

命令：

<!-- fly2456-step {"id": "execute-20", "kind": "effect", "call": "hold_gate B2"} -->
```bash
hold_gate B2
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E21 — 起 B1 多 activation 靶体

命令：

<!-- fly2456-step {"id": "execute-21", "kind": "effect", "call": "start_body B1"} -->
```bash
start_body B1
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E22 — B1 marker

命令：

<!-- fly2456-step {"id": "execute-22", "kind": "effect", "call": "park_marker B1"} -->
```bash
park_marker B1
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E23 — B1 sandbox PR

命令：

<!-- fly2456-step {"id": "execute-23", "kind": "effect", "call": "park_pr B1"} -->
```bash
park_pr B1
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E24 — B1 完工进入引擎 QA

命令：

<!-- fly2456-step {"id": "execute-24", "kind": "effect", "call": "park_complete B1"} -->
```bash
park_complete B1
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E25 — 一次 QA fail 唤醒 B1 attempt 2

命令：

<!-- fly2456-step {"id": "execute-25", "kind": "effect", "call": "qa_fail_b1"} -->
```bash
qa_fail_b1
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E26 — B1 固定 gate

命令：

<!-- fly2456-step {"id": "execute-26", "kind": "effect", "call": "hold_gate B1"} -->
```bash
hold_gate B1
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E27 — cycle 1 前资格证明

命令：

<!-- fly2456-step {"id": "execute-27", "kind": "read"} -->
```bash
capture_shape
cp "$CURRENT_SHAPE" "$EVIDENCE/shape-before-cycle1.json"
```
期望输出: B1/B2 持 gate 与 TURN；B3 非 holder；实际 probe 合格，wake 不超五分钟。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E28 — room-info 仍在时的排除对照

命令：

<!-- fly2456-step {"id": "execute-28", "kind": "effect", "call": "cycle_room 1"} -->
```bash
cycle_room 1
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E29 — 核 cycle 1 三体零事件

命令：

<!-- fly2456-step {"id": "execute-29", "kind": "read"} -->
```bash
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
```
期望输出: 三个已绑定 execution 的 reown source 零行；仅解析 pass 不够。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E30 — 启用已批准 room-info 夹具

命令：

<!-- fly2456-step {"id": "execute-30", "kind": "effect", "call": "room_transfer hide"} -->
```bash
room_transfer hide
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E31 — cycle 2 前再验形状与时间窗

命令：

<!-- fly2456-step {"id": "execute-31", "kind": "read"} -->
```bash
capture_shape
cp "$CURRENT_SHAPE" "$EVIDENCE/campaign-shape.json"
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: campaign-shape.json 与 probe/副本/wake-window 原始文件。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E32 — 实际恢复 cycle

命令：

<!-- fly2456-step {"id": "execute-32", "kind": "effect", "call": "cycle_room 2"} -->
```bash
cycle_room 2
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E33 — 观察第一 episode

命令：

<!-- fly2456-step {"id": "execute-33", "kind": "read"} -->
```bash
observe_campaign 15
```
期望输出: 保存实际终局或超时结果；若显式选择30分钟，改调用参数为30并重新运行路书 guard 生成相应回执。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E34 — 房和体仍在时生产采样

命令：

<!-- fly2456-step {"id": "execute-34", "kind": "read"} -->
```bash
production_capture live-after
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: live-after/。此时不先拆房或清理证据。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E35 — 恢复原 room-info 身份

命令：

<!-- fly2456-step {"id": "execute-35", "kind": "effect", "call": "room_transfer restore"} -->
```bash
room_transfer restore
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E36 — 严格拆房前生产基线

命令：

<!-- fly2456-step {"id": "execute-36", "kind": "read"} -->
```bash
production_capture pre-teardown
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: pre-teardown/，这是 teardown 因果比较基线。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E37 — 主房官方拆除

命令：

<!-- fly2456-step {"id": "execute-37", "kind": "effect", "call": "teardown_room main"} -->
```bash
teardown_room main
```
期望输出: 命令退出 0，实际结果满足上述 helper 判据。
落盘: 本步骤的随机 tag 证据与 manifest receipt。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E38 — 拆房后采样与本轮判定

命令：

<!-- fly2456-step {"id": "execute-38", "kind": "read"} -->
```bash
production_capture post-teardown
compare_round
```
期望输出: 所有比较生成真实输出；fail/needs 保留。单轮 verdict 不授予 FLY-2352 approval。
落盘: post-teardown/、zero-impact.json、fixture.json、verdict.json 与报告。
停手: 命令非零或 conflict 即停；不执行后续副作用。

## E39 — 两轮齐全后生成 founder 对照

命令：

<!-- fly2456-step {"id": "execute-39", "kind": "read"} -->
```bash
test "$ROUND" = r2
if node "$TOOLS" report-pair --r1 /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r1/verdict.json --r2 /Users/xiaorongli/.flywheel/qa-evidence/FLY-2456/r2/verdict.json > "$EVIDENCE/pair.json"; then PAIR_STATUS=0; else PAIR_STATUS=$?; fi
jq -er .markdown "$EVIDENCE/pair.json" > "$EVIDENCE/drill-report.md"
jq -er .html "$EVIDENCE/pair.json" > "$EVIDENCE/founder-report.html"
test "$PAIR_STATUS" -eq 0
```
期望输出: 哈希重验与双轮重算通过；零表格 markdown/html 含实际事件、成功率、例外和盲区。
落盘: r2/pair.json、drill-report.md、founder-report.html；Lead 将内容交原 FLY-2352 thread。发布稿只含白名单状态/计数、进程身份与归因摘要、事件 id/时间/类型/execution/attempt；不含 command/env/raw payload 或任意嵌套对象。单轮与双轮 Markdown/HTML 同样投影；私有原始文件仍为 0600，仅以 path+SHA256 引用，不能把原始 proof JSON 替换发布稿。
停手: 缺任一源文件/哈希漂移/任一轮不足时不作为通过报告交付。两轮失败报告仍保留 pair.json，不能删除失败证据。


## 恢复与紧急停手

首次执行先完成 01–O2 和 C1–C3 的上下文、只读检查与函数定义，再按 E01–E39 执行。本轮的 ROUND、SLOT、TESTED 和 manifest 不得中途更换。R1 收证完成后，另开 Bash 会话，以 R2 上下文重复；E03–E11 中的 PRE 仅 R1 执行。

中断后保留原证据目录。读取 manifest 中每一步 intent/receipt 和最后成功的 E 步，重新载入相同上下文及函数定义；已有房间时不能重跑要求空房的首次检查。只从中断的具体步骤恢复：副作用由原 intent 和新鲜权威证据收养；已有只读输出文件不得覆盖，先核对其哈希及对应步骤。遇到冲突停手，由 Lead 对照原始证据决定后续动作，不能删除 intent 来换取 execute。

room-info 已隐藏时，优先在原会话调用上面定义的 room_transfer restore；它核对原文件 identity，以无覆盖移动恢复。该调用只使用已登记的恢复路径，不另发重启。恢复拒绝时保留隐藏文件、manifest 和错误，由 Lead 处理；不直接覆盖 room-info。

发现生产异常、scope 不匹配或任何 guard 拒绝，立即停止后续副作用并保留当前证据。只在房间身份可验证、room-info 已恢复且 pre-teardown 采样齐全时，使用本轮已定义的 teardown_room；不得使用生产 launchd、全局进程清理、run terminate 或未登记的紧急重启。无法满足这些前置时由 Lead 人工处置，报告写明未拆房及原因。

判据 5 的「零影响」是演练窗口内零新增，不要求生产历史绝对零命中。基线为本轮 `before` 捕获，分别与 `live-after`、`post-teardown` 比较：comm 按 `(table, 原 rowid, column)` 命中集合差；prodState 按 sessions.execution_id / session_events.id 的稳定主键命中集合差；alerts 按 slot lead 命中的文件名集合差。before 的历史命中数写入 verdict 与报告，不作失败；after 新增命中才失败，删除旧命中不能抵销新增项。单份 comm/prodState 扫描的非零结果由 record_check 保留，最终门以 verdict 的基线差分为准。

Alert 读取将非 flywheel-* leadId 归 foreign（保留原 leadId 计数），非 JSON 与 *.tmp.* 原子写残留归 unparsed（只输出文件名和 SHA256，不输出原文）；既有记录保留为披露，新出现且无法归因的记录仍为 needs-attribution。目录不可读、路径穿越或证据哈希不符仍 fail-closed。

所有 fail / needs-attribution / unavailable 都进入最终报告；工具通过不代表生产零影响或 reown 验收通过。最终报告由 Lead 交 FLY-2352 原 thread，founder 的 ship 决定独立于本路书交付。


## 宿主偏差 #1–#17 对照（返工 #5）

本段对应 host-runs/driver/DEVIATIONS.md，原始 R1/R2 判定不重新计算、不改数字。

1. #1：§01 使用 owner.kind=workflow，明确 owner 是活着且未完成的 DAG execution。
2. #2：宿主前置清理实测 78 个无活进程的 runner-fly1674-* 残留；历史记录在 Lead 的 host-precheck/。每轮起房前 production_capture 的真实 inventory/StateStore 映射必须 pass；新残留由 Lead 逐个确认无活子进程后清理，未映射 exec 或无标记窗口不可私自忽略（FLY-2500）。演练窗口内不关宿主终端。
3. #3：StateStore 派生产物宿主实测 245668155 bytes；comm 派生为 1012034 bytes。unbounded-production-evidence-projection 留给 FLY-2503 增加上限，本 PR 不改生产投影。原始大型投影不提交。
4. #4：production_capture 跳过目录、symlink 等非常规 alerts 条目，记录 alerts-skipped.txt；常规非 JSON 文件继续交 alerts 分类器。
5. #5/#5b：terminate 前最多等 120 秒，直接检查 slot CommDB sessions.tmux_window 为非空且非 :pending；不依赖 StateStore tmux_session。
6. #6：archive_ledger 计数 no-op reaper 拒绝，真实带目标拒绝仍失败。
7. #7：precondition 与三组 proc 比较均运行已归档 Lead 归因脚本，保留工具结果与逐行 rule/evidence。工具 fail 不被覆盖；needs-attribution 只有完整匹配的 Lead pass 可收养。生产伤亡、未解释 removed 行仍失败。
8. #8：body_context 使用 COALESCE(branch,worktree_binding_branch)，保留两列原值，空值显式拒绝并与 git 分支核对。
9. #9：main deploy 前对迟到残留执行四项停手守卫；按 Lead 414b4a59 裁定使用 managed_snapshot、查询错误停手、release 后仅清理未变化的空目录。历史 driver 保留原样供对照，不作为新版操作入口。
10. #10：park_publish 独立记录 intent/adopt，确认干净树与预期 HEAD 后发布沙箱分支，再捕获 marker 基线；远端不同 HEAD 不覆盖。
11. #11：START_FROM 允许重入；只跳 early execute-01..15，后续效果仍逐步收养，不重跑前置。
12. #12：park-adopt 容忍入场时 cleared 投影及全部 park_cleared 历史；已有 open/部分效果不允许重新 complete。
13. #13：complete 后最多 120 秒等 ship_parked 与 park=open，再采 after。
14. #14：qa-result 后最多 600 秒等 wake_delivered，再采 after；超时停手，不重发请求。
15. #15：观察工具新增 failed_exhausted_no_replacement（明确 owner-before-commit 失败、两次 attempt 与 exhausted 终态证据）；B3 holder skip 后的 superseded skip 保持阴性分类。drift_exhausted/replaced 仍保留原含义，历史报告不改写。
16. #16：launch-delta 的 activationId 接受冒号/点，execution 文件名校验不放宽。
17. #17：teardown_room 之前归档 slot bridge.log 与 report-host.log；原始日志留私有证据目录，R2 本轮缺失的根因原话不能补造。


#7 新审 HIGH 修正（Lead 300233ea）：以上操作命令使用 scripts/lib/qa-fly-2456-lead-proc-attribution.py。A/B 的 slot 归因后，removed 自身的生产 Flywheel 体/Bridge/Lead/tmux server/Codex 生产 socket 签名先于任何瞬态匹配；瞬态只保留精确形状，只有 Claude shell-snapshots 工具壳的直接子进程可继承该归因。取消宽泛 ~/.claude/、git/tmux 任意命令以及任意瞬态祖先豁免。host-runs/driver/ 原文件不动；R1/R2 verdict 是历史原件计算的结果，不代表本操作版重算已通过，复算属于下一轮 Lead 宿主演练。
