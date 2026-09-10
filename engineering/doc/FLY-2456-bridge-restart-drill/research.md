# FLY-2456 529 房真机重启演练(2352 reown)— 调研
Issue: FLY-2456 (https://linear.app/geoforge3d/issue/FLY-2456/529-房演练-2352-真机重启演练slot-里起-2-3-具-codex-体-重启-slot-bridge-测-reown)
日期: 2026-09-10
基于: exploration.md

本篇只记**可执行的合同**(命令、路径、表、字段、判据),给 plan 直接引用;推理与取舍在 exploration.md。所有行号基于 `origin/main = 42869f935`。

## 1. 房:装、验、藏、循环、拆

### 1.1 装房(每轮一次,从被测 worktree 执行)

```bash
cd <被测 worktree>            # R1: origin/main detached;R2: merge(origin/main, b3ed3cc97) detached
pnpm install --frozen-lockfile && pnpm -r build
bash scripts/test-deploy.sh <slot> --generalized --codex-runner --no-lead --expect-head "$(git rev-parse HEAD)"
```

- `--codex-runner` 需 `--generalized`,与 `--stub-runner` 互斥(`test-deploy.sh:256-261`);写入项目配置 `runners.default: codex` / `roles.runner.backend: codex-tmux` / DAG `runner: codex`(`qa-multilead.sh:138-170`)。
- `--no-lead` 与 `--extra-lead` 互斥;跳过 identity staging 与 Lead launchd(`test-deploy.sh:1254`)。
- `--expect-head` 在任何 mutation 前锁 HEAD;readiness 再核 `/health.buildSha == artifactBuildSha == HEAD`。
- 产物(`SLOT_DIR=/tmp/flywheel-test-slot-<slot>`,0700):

| 文件 | 用途 |
|---|---|
| `room-info.json`(0600) | `{schemaVersion:1, slot, projectName:"test-slot-<N>", generalized:true, runnerMode:"real", bridgeUrl, ...}`;**Bridge 侧唯一读者 = reown 排除 predicate** |
| `bridge-launch.json`(0600) | FLY-2237 启动合同,`test-cycle-bridge.sh` 用它 `env -i` 重放 |
| `bridge.pid`、`/tmp/flywheel-test-slot-<N>.lock/pid` | 所有权;cycle 期间写 `cycle-failed` 哨兵 |
| `bridge.log` | Bridge stdout/stderr,append;reown 行前缀 `[codex-session-reown]`,fleet 行 `[fleet-sensors]` |
| `teamlead.db` | slot StateStore(`TEAMLEAD_DB_PATH`) |
| `state/comm/test-slot-<N>/comm.db` | slot CommDB(`FLYWHEEL_COMM_ROOT=${SLOT_DIR}/state/comm`) |
| `state/api-token`(0600) | slot master token(`/api/runs/*` 的 Bearer) |
| `state/bridge-env-secrets/TEAMLEAD_INGEST_TOKEN` | runner 侧 `FLYWHEEL_INGEST_TOKEN` 的来源 |
| `state/codex-homes/<execId>`、`state/codex-sessions/<execId>/session.json`、`state/cdx-sock/<sha1(execId)[:16]>.sock` | 每具 Codex 体的家 / 账本 / socket(`FLYWHEEL_CODEX_HOMES_ROOT` / `_SESSION_DIR` / `_DAEMON_SOCKET_ROOT`) |
| `tmux-$(id -u)/default` | slot 私有 tmux server(`TMUX_TMPDIR=${SLOT_DIR}`) |
| `state/kill-ledger/*.ndjson` | 破坏性原语账本;`refusal:"isolation_boundary"` = 被拒 |
| `project-slot-<N>/` | HOST_REPO(`xrliAnnie/flywheel-qa-sandbox` clone);runner worktree 在其下 |

- Bridge 端口:`~/.flywheel/test-slots.json` 的 `slots[N-1].bridgePort`(1987N);`BRIDGE_URL=http://localhost:1987N`。
- Codex 体的凭据来源:`FLYWHEEL_CODEX_SOURCE_HOME` 未设则 `~/.codex/auth.json`(`codex-home.ts:688-699`)⇒ **与生产共用同一份 auth**(FLY-2358/0.153.2 共享刷新协议安全),额度同池。装房前用隔离 `CODEX_HOME` 拷贝跑 `codex doctor` 探活(memory 配方),不烧额度。

### 1.2 装房后置(`simple_code` 菜单)

```bash
HOST=/tmp/flywheel-test-slot-<N>/project-slot-<N>
printf 'flywheel-test-%s: [code, simple_code, generic]\n' <N> > "$HOST/.flywheel/menus/adoption.yaml"   # 热读,不重启
sqlite3 "file:/tmp/flywheel-test-slot-<N>/teamlead.db?mode=ro" \
  "SELECT task_category, template_id FROM workflow_category_binding WHERE project='test-slot-<N>'"        # 应含 simple_code → tpl_simple_code(六条全在)
```

`tpl_simple_code` = implement(codex)→ qa(claude)→ founder_gate → land,loop `qa_retry: qa→implement`(`registry.yaml:130-175`)。QA vendor 由模板 `node.dispatch.vendor` 决定(`workflow-dispatch-resolution.ts:125-128`),`--codex-runner` 不改它。

### 1.3 起一具体(每张沙箱 issue 一 run)

```bash
TOKEN=$(cat /tmp/flywheel-test-slot-<N>/state/api-token)
curl -s -X POST http://localhost:1987N/api/runs/start -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "issueId":"FLY-202","projectName":"test-slot-<N>","leadId":"flywheel-test-<N>",
  "taskCategory":"simple_code","sessionRole":"main","idempotencyKey":"fly2456-r1-b1-<uuid>",
  "overrides":{"implement":{"model":"codex"}}
}'
# 响应必须 success:true, generalized:true, 且带 executionId / workflowRunId / workflowNodeId(lib validateGeneralizedStartResponse)
```

- `overrides` 只能点名图内可执行节点,否则 400 `MENU_NODE_NOT_FOUND`(`workflow-menu.ts:645-652`)—— 不要带 `eng_design`。
- 不传 `templateId`(传了必须同时给 `selectionReason`);category → binding 解析。
- 同一 issue 同时只能一个 active run(`issue_has_active_run`);B1/B2/B3 用三张 issue:FLY-202、FLY-145、FLY-146(generalized 房 `BRIDGE_DEPT_SCOPE_REJECT=off`,标签无关)。
- 体出生判据(三处都要):`sessions.adapter_type='codex-tmux' AND status='running'`;`state/codex-sessions/<execId>/session.json` 存在;`ps` 里有 `codex app-server … --listen unix:///tmp/flywheel-test-slot-<N>/state/cdx-sock/…`;slot tmux `list-windows -a` 有该 window。

### 1.4 代 runner 推进(不等真跑手干完活;FLY-2182 实证配方)

runner 环境的取法(二选一,结果要逐键对照):
1. `ps -Eww -p <codex app-server pid> | tr ' ' '\n' | grep ^FLYWHEEL_`(FLY-2182 实测可取);
2. 从 slot 重建:`FLYWHEEL_EXEC_ID=<execId> FLYWHEEL_ISSUE_ID=<issue> FLYWHEEL_PROJECT_NAME=test-slot-<N> FLYWHEEL_BRIDGE_URL=http://localhost:1987N FLYWHEEL_COMM_DB=${SLOT_DIR}/state/comm/test-slot-<N>/comm.db FLYWHEEL_INGEST_TOKEN=$(cat ${SLOT_DIR}/state/bridge-env-secrets/TEAMLEAD_INGEST_TOKEN) FLYWHEEL_STATE_DB_PATH=${SLOT_DIR}/teamlead.db FLYWHEEL_LEAD_ID=flywheel-test-<N> FLYWHEEL_COMM_CLI=<被测 worktree>/packages/flywheel-comm/dist/index.js`(`CodexTmuxAdapter.buildDaemonEnv` 2382-2440 的键集)。

**implement 完工(B1、B3)**,cwd = 该体的 worktree(`sessions.worktree_path`):
```bash
git checkout -q <体的分支> && printf '\n- FLY-2456 drill marker %s\n' "$(date -u +%FT%TZ)" >> doc/qa/sandbox-notes.md \
 && git add -A && git commit -qm "test(FLY-2456): drill marker" && git push -q origin HEAD
PR=$(gh pr create -R xrliAnnie/flywheel-qa-sandbox --base main --head "$(git branch --show-current)" \
      --title "test(FLY-2456): restart drill fixture (do not merge)" --body "FLY-2456 529 drill; do not merge." | grep -oE '[0-9]+$')
env <runner env> node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr "$PR" --session-role implement --summary "FLY-2456 drill implement attempt 1"
```
判据(FLY-1768 步骤 4 四条):`sessions.status='ship_parked'`(不是 completed)、`workflow_engine_park_*` 有 `park_opened reason='rework_reachable_wait'`、`terminal_at IS NULL`、daemon 仍活(socket 仍被持有)。

**QA 判 FAIL(P1,产生 wake)**:implement 完工后引擎自动派 QA(Claude 真体)。等 QA session `running` 且 CommDB `runner_workflow_activation` 有它的 `submission_credential` 行,再以 **QA 进程的 env**(同上两法取;凭据由 `currentWorkflowCredentialFromEnv` 从 CommDB current activation 读,不用手填 `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL`,`workflow-activation.ts:48-68`)执行:
```bash
env <QA env> node "$FLYWHEEL_COMM_CLI" qa-result --status fail --target-exec <B1 execId> --summary "FLY-2456 drill: deliberate FAIL to wake implement attempt 2"
```
判据:`workflow_rework_delivery.state='wake_delivered'`(FLY-1768 实测 +1 秒);`workflow_execution_binding` 对 B1 两行:`(attempt=1,mode='spawn')`、`(attempt=2,mode='wake',activation_id LIKE 'activation:rework:%')`;`workflow_run_node(implement, attempt 2).execution_id == B1`(**同一 execution**;若是新 id 就是换体,不是 wake)。QA 攻略失败反例:`holder_activation_failed:state_not_revivable:*`、run `held`。

**P2 备选(不经 QA)**:`POST /api/runs/<runId>/rework`,Bearer = master token,loopback,body `{"targetNodeId":"implement","feedback":"FLY-2456 drill wake","clientRequestId":"fly2456-<uuid>"}`(`runs-route.ts:1007-1080`)。前置:run `active`、implement 最新 attempt 已 ended(`target_attempt_already_reserved` 否则 409)、无 open rework(`rework_already_open`)、`selectPreferredWorkflowActorTx` 能选到 B1(`target_actor_history_missing` 否则)(`StateStore.ts:41130-41175`)。同样落到 coordinator 的 `activationMode:"wake"`(`workflow-rework-coordinator.ts:639-651`)。

### 1.5 藏 room-info(夹具,方案 A)

```bash
mv /tmp/flywheel-test-slot-<N>/room-info.json /tmp/flywheel-test-slot-<N>/room-info.json.drill-hidden   # cycle 之前
# …演练窗口…
mv /tmp/flywheel-test-slot-<N>/room-info.json.drill-hidden /tmp/flywheel-test-slot-<N>/room-info.json   # 拆房之前
```
- `readCodexReownRoomInfo()` 每次 `isExcluded` 现读(`plugin.ts:7862-7876`),缺文件 ⇒ `undefined` ⇒ 不排除;不需重启。
- 隐藏期间**不得**跑 `qa-529-generalized-e2e.mjs`(它 `validateRoomInfo` 会拒)。
- 正对照(证明夹具在起作用):在**藏之前**先做一次 cycle,`session_events` 里应 **0** 条 `source='bridge.codex-session-reown'`;藏之后再 cycle 才出现事件。这一步区分「排除生效」与「体不合格」。

### 1.6 循环 Bridge

```bash
bash scripts/test-cycle-bridge.sh <slot>     # stdout JSON {slot,bridgeUrl,oldBridgePid,newBridgePid,launchSpec}
```
- 只 TERM listener→`bridge.pid` 的 PPID 链;不 SIGKILL;不碰 tmux / launchd / daemon(`test-cycle-bridge.sh:330-362`);同一 `bridge-launch.json` `env -i` 重放;新 Bridge 起后 `bridge.pid` 与 lock 改成新 PID。
- 可调:`FLYWHEEL_QA_BRIDGE_TERM_TIMEOUT_SEC`(默认 30)、`FLYWHEEL_QA_BRIDGE_HEALTH_TIMEOUT_SEC`(默认 60)。
- Bridge 自身是 `os.setsid()` 独立 session;Codex daemon 由 adapter 以独立 pgid 起 ⇒ daemon 活过 cycle。复活硬判据:`/health` 200 **且** `bridge.pid` 变新 **且** `bridge.log` 出现第二次 boot 段。
- 新 Bridge boot 顺序:project runtimes → `codexSessionReowner.runPass(boot:readopt-candidates)`(`plugin.ts:9151-9156`)→ heartbeat;之后每个维护 tick(`TEAMLEAD_STUCK_INTERVAL` 默认 300000ms;该变量属 `TEAMLEAD_*` 家族,被 contract 的 fail-closed sweep 清掉,**房里不可缩短**)再 pass。
- 修前的 attempt 2 时点:claim TTL 60s(`CODEX_RECOVERY_CLAIM_TTL_MS`)之后的下一次 pass ⇒ 第一个维护 tick(≈ 5 分钟)。等待上限设 15 分钟。

### 1.7 拆房

```bash
bash scripts/test-teardown.sh <slot>     # 撞 cmux maintenance lease 自动重试一次;两次失败停手上报,不手拆
```
拆房前证据归档到 `${FLYWHEEL_QA_EVID_DIR:-~/.flywheel/qa-evidence}/slot-<N>/<UTC>/`(kill-ledger、`boundary-events.json`、`launch-manifest.json`);另手工复制 `bridge.log`、`teamlead.db`(`VACUUM INTO`)、`state/comm/.../comm.db`(`VACUUM INTO`)、三份 `session.json`。

## 2. 观察面:表、字段、查询

### 2.1 体的形状(cycle 前必须先固化)

```sql
-- slot teamlead.db(mode=ro)
SELECT execution_id, status, adapter_type, last_error, terminal_at FROM sessions WHERE adapter_type='codex-tmux';
SELECT execution_id, attempt, mode, activation_id, bound_at FROM workflow_execution_binding ORDER BY execution_id, attempt;
SELECT run_id, node_id, attempt, state, execution_id FROM workflow_run_node ORDER BY run_id, node_id, attempt;
SELECT execution_id, episode_state, episode_attempts, holder FROM recovery_claim;
```
B1 期望:binding 2 行(`spawn@1`,`wake@2`),`resolveCurrentWorkflowActivation` 的等价 SQL(node 最新 attempt 的 execution_id == B1)成立;B2/B3:1 行。

### 2.2 reown 事件(cycle 后)

```sql
-- 真实列名(StateStore.ts:4922-4935 / 24753-24766):session_events 无 created_at,用 id / ts;workflow_run_event 用 seq / at
-- 每次 cycle 前先取下界:SELECT MAX(id) FROM session_events;  SELECT run_id, MAX(seq) FROM workflow_run_event GROUP BY run_id;
SELECT id, event_id, ts, execution_id, event_type, payload FROM session_events
 WHERE source='bridge.codex-session-reown' AND id > :sessionEventsMaxId AND execution_id IN (:bodies) ORDER BY id;
SELECT seq, event_uid, at, kind, execution_id, payload FROM workflow_run_event
 WHERE run_id = :runId AND seq > :runEventMaxSeq
   AND kind IN ('codex_recovery_capabilities_prepared','execution_dead_rolled_back','rework_replacement_materialized','rework_replacement_launched') ORDER BY seq;
SELECT execution_id, episode_id, episode_state, episode_attempts FROM recovery_claim WHERE execution_id IN (:bodies);
```
用 `id > 下界` / `seq > 下界` 而不是时间戳:`ts` 是秒级,cycle ① / ② 与维护 tick 的事件会相邻。

**因果链只按真实 payload 关联**(Codex R2 更正;`codex-session-reown.ts:583-592`、`StateStore.ts:34625-34668, 34968-34990`):两条 drift 的 `reown_revive_failed` 带 `payload.episodeId`,必须等于 `recovery_claim.episode_id`;`episode_exhausted` 那条**只有** `reason, attempts`,靠同 execution + id 顺序 + `attempts=2` 关联;`execution_dead_rolled_back` 记在旧 execution 上,payload `newExecutionId, launchOrdinal`;`rework_replacement_materialized` 记在旧 execution 上,payload `requestId, newExecutionId, launchOrdinal`;`rework_replacement_launched` 记在**新** execution 上,只有 `requestId`。replacement 的身份只能从这条链收养,不能手填。

### 2.2a reown 资格(cycle 前必须满足,否则根本不进恢复)

`codex-session-reown.ts:462-527`:`liveness=='alive' && !gateHeld && !isParked(session)` ⇒ 只记 `reown_watch_started`,**不 claim 不 revive**;其余(gateHeld、或 parked、或 daemon absent)进 `beginRecovery`。`beginRecovery` 内(`:627-649`)`readTurnHolder(session) !== execution_id` ⇒ parked 体 `reown_skipped_not_turn_holder`、running 体 `reown_fence_lost`(都退还 attempt,不算失败)。

- `gateHeld` = `plugin.ts:7906-7913` `hasOpenGate`:gate-hold latch **或** slot CommDB `getOpenGatesByRunner(exec)` 非空。该函数的完整 SQL(`db.ts:4104-4119`,收养与资格检查必须逐字复用):
  ```sql
  SELECT q.* FROM mailbox_message_projection q
   WHERE q.from_agent = ? AND q.type = 'question' AND q.checkpoint IS NOT NULL
     AND q.relay_state != 'terminal_disposed' AND q.superseded_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM mailbox_message_projection response WHERE response.parent_id = q.id AND response.type = 'response')
   ORDER BY q.created_at ASC, q.id ASC
  ```
  `mailbox_message_projection` 是 view(物理表是 `mailbox`);`messages` / `lead_inbox` 是 poison view,查询必报错(`mailbox-schema.ts:297-300, 425-429`)。
- 让体持 gate 的代 runner 命令(用该体的 env,尤其 `FLYWHEEL_EXEC_ID` / `FLYWHEEL_COMM_DB`):
  ```bash
  env <runner env> node "$FLYWHEEL_COMM_CLI" gate question --lead flywheel-test-<N> --exec-id <exec> --no-block "FLY-2456 drill hold"
  ```
  `--no-block` 只插入 pending question 并返回 questionId(`gate.ts:40-49`);`--no-lead` 房里没人应答,它永远 pending = 永远 gateHeld。这与生产 15 具 drift 体 attempt 1 的 `liveness=alive gateHeld=true` 同形。
- TURN holder:`three_stage_turn.holder_exec_id`(slot CommDB);wake 后 B1 是 holder(`activation_turn_granted`);B2 出生即 holder;B3 完工后 TURN 交给 QA ⇒ 非 holder ⇒ 阴性对照。
- daemon liveness **必须用产品探针语义**(Codex R2 更正):`probeCodexDaemonLiveness(executionId, deps)`(`codex-daemon-runtime.ts:115-222`)读 `session.json` 持久化 PGID → `kill(-pgid, 0)` → socket 存活 → 至少一个 socket holder 的进程组 == PGID 才 `alive`;`lsof -t <sock>` 只证明有人持 socket。**公开探针只返回字符串** `"alive"|"absent"|"unknown"`(Codex R3 更正;详情在未导出的 `inspectCodexDaemonOwnership`,且它也不返回 holder PIDs),所以路书用一段只读 evidence wrapper 独立取证(全部在 slot 合同 env 下):
  ```bash
  export FLYWHEEL_CODEX_SESSION_DIR=/tmp/flywheel-test-slot-<N>/state/codex-sessions FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT=/tmp/flywheel-test-slot-<N>/state/cdx-sock
  D=<tested-checkout>/packages/claude-runner/dist/codex-daemon-runtime.js
  node --input-type=module -e "import { readFileSync } from 'node:fs'; import { execFileSync } from 'node:child_process';
    import { probeCodexDaemonLiveness, resolveDaemonSocketPath, codexSessionStateDir } from '$D';
    const exec = process.argv[1]; const env = process.env;
    const readPgid = () => { const s = JSON.parse(readFileSync(codexSessionStateDir(exec, env) + '/session.json', 'utf8')); return s.daemonPgid ?? s.daemonPid ?? null; };
    const persistedPgidBefore = readPgid();
    const verdict = await probeCodexDaemonLiveness(exec, { env });
    const persistedPgidAfter = readPgid();
    const socketPath = resolveDaemonSocketPath(exec, env);
    const holderPids = execFileSync('lsof', ['-t', socketPath], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map((pid) => ({ pid: Number(pid), pgid: Number(execFileSync('ps', ['-o', 'pgid=', '-p', pid], { encoding: 'utf8' }).trim()) }));
    let groupState = 'unknown'; try { process.kill(-persistedPgidBefore, 0); groupState = 'alive'; } catch (e) { groupState = e.code === 'ESRCH' ? 'absent' : e.code === 'EPERM' ? 'alive' : 'unknown'; }
    console.log(JSON.stringify({ executionId: exec, verdict, socketPath, persistedPgidBefore, persistedPgidAfter, groupState, holderPids }));" -- <exec>
  ```
  一条命令输出完整 JSON(Codex R4 MEDIUM #4 修正:ESM 下用 `import`,PGID 字段是 `daemonPgid ?? daemonPid`,holder / groupState 合并进同一条命令);工具复核:`verdict=='alive'` 且 holderPids 中至少一个 `pgid==persistedPgid` 且前后 persistedPgid 相同。测试要执行这条真实命令(对一个临时 daemon fixture),不只喂手造 JSON。`process.kill(pgid, 0)` 是探针不是终止信号;路书正文避免让终止动词与进程标识同句出现,以免误触 FLY-913 P2。

| 结果类 | `session_events`(source=`bridge.codex-session-reown`) | 其他 |
|---|---|---|
| **认回成功** | `reown_revive_started` → `reown_revive_succeeded`(payload `attempt`, `threadId`, `lifecycleRevision`) | `recovery_claim.episode_state='closed'`;修后多 activation 体另有 `codex_recovery_capabilities_prepared` 且 `payload.attempt=2` |
| **capability drift(2352 病)** | `reown_revive_failed` payload.reason 以 `workflow capability drift for <exec>` 开头(修后文案带 `snapshot=…current=…`) | `codex_recovery_capabilities_prepared` 对该体 **0 条** |
| **exhausted → 换体** | `reown_revive_failed reason='episode_exhausted' attempts=2` | `sessions.status='failed'`, `last_error='Codex recovery exhausted after 2 attempts'`;随后 `execution_dead_rolled_back` → `rework_replacement_materialized` → `rework_replacement_launched`,新 execution 出生 |
| 修后新 fail-closed 类 | `reown_revive_failed reason='capabilities_activation_ambiguous' / 'capabilities_activation_invalid'` | main 上不可能出现;出现即证明跑的是修后字节 |
| 未进入恢复 | `reown_watch_started`(daemon 活且 rollout 在动)、`reown_skipped_superseded`、`reown_probe_unknown`(连续 2 次告警) | |
| **排除(夹具没生效)** | 该 source **0 行** | 与「体不合格」同痕,靠 §1.5 正对照区分 |

`bridge.log` 对照行:`[codex-session-reown] <exec>: <reason>`(`plugin.ts:8135`);drift 还会发 meta-alert `reason: codex_reown_failed`(房内 `FLYWHEEL_STATE_DIR` 已隔离,落 slot 的 meta-alert 目录)。

### 2.3 成功率的定义

每具体一条结论,取 cycle ② 下界之后**第一个 episode** 的终局:`succeeded` / `drift_exhausted`(→`replaced`)/ `watch_only` / `skipped_not_holder` / `excluded_or_ineligible` / `other(原文)`。轮成功率分母只含**有资格**的体(B1、B2:gateHeld + TURN holder);B3(parked 非 holder)单独一行,预期 `skipped_not_holder`,不进分母。修前预期:多 activation 0/1、单 activation 1/1;修后预期:2/2。

## 3. 生产零影响证据(五面,前后各一次,同一 checkout)

```bash
S=<被测 worktree>/scripts
$S/qa-fly-2454-fleet-snapshot.sh --out /tmp/fly2456-<round>-before.txt          # 1. socket + 生产默认 tmux 窗口
ps -axo pid=,command= | grep -E '(^|/)codex[[:space:]]+app-server' | grep -E -- '--listen(=| )unix://' \
  | awk '{ if ($0 ~ /\/\.flywheel\/cdx-sock\//) p++; else if ($0 ~ /flywheel-test-slot-/) s++; else o++ } END { print "prod="p+0, "slot="s+0, "other="o+0 }'   # 2. 分桶计数
sqlite3 "file:$HOME/.flywheel/comm/flywheel/comm.db?mode=ro" "VACUUM INTO '/tmp/fly2456-<round>-comm-before.db'"   # 3. comm.db 快照
ls ~/.flywheel/state/launch-commits/ | sort > /tmp/fly2456-<round>-lc-before.txt                                   # 4. unconfined consumer
curl -s localhost:9876/health | jq '{uptime,buildSha}' > /tmp/fly2456-<round>-health-before.json                    # 5. 生产 Bridge 未重启
```
判据:
1. `diff -u before after` 为空,且 `fly2454-decoy` 窗口(演练前在生产默认 tmux 上 `new-window -d -n fly2454-decoy`,只此一次写生产 tmux,演练后手工关)在两份里都在;若生产 runner 在窗口期自然完成,逐条用生产 StateStore 事件解释并核 slot kill-ledger 无对应目标;
2. `prod` 计数只允许被 1 解释的变化;`slot` 计数在体出生后 = 房内体数,拆房后 = 0;
3. 两份 comm.db 快照做 schema-driven 扫描:只枚举 `sqlite_master.type='table'` 的**物理表**(`mailbox`、`sessions`、`three_stage_turn`、`runner_workflow_activation`、`mailbox_terminal_archive`、`mailbox_log` 等),对每张表的 TEXT/JSON 列 `LIKE` 扫 `test-slot-<N>` / 房内 execId / `flywheel-test-<N>`;**`messages` 是 poison view,查它必报错**(Codex R3 更正),view 一律不扫;**查询报错 ≠ 0 行** —— 前后都必须为 0;并列出前后 `mailbox` 行数增量的 `from_agent` 分布全是生产 agent;
4. **bounded delta,不是零**:generalized dispatch 一定把每个 execution 写进 `$HOME/.flywheel/state/launch-commits/<executionId>`(`run-dispatcher.ts:210-212,1644-1653`;`workflow-engine-dispatcher.ts:255-263`;路书 §7 登记的 unconfined consumer)。判据 = `comm -13 before after` 的新增 basename **全部属于**事先登记的本轮 execution 集(B1/B2/B3 + QA + replacement + 前置一次性体),无未归属项;这些宿主回执拆房后保留,报告披露;
5. `after.uptime > before.uptime` 且 `buildSha` 不变。

另:`~/.flywheel/meta-alert/` 与 `~/.flywheel/alert-deadletter/` 前后文件清单按**内容里的 `leadId`** 归属核对(FLY-2182:房会漏 `leadId=flywheel-test-N` 的死信;FLY-2163:老版会覆盖生产 meta-alert;FLY-2454 后 `FLYWHEEL_STATE_DIR` 已隔离,此处是验证不是假设)。

## 4. 修后头的构造与身份核验

```bash
git fetch origin main flywheel-FLY-2352
git worktree add worktrees/fly2456-r2-fix --detach origin/main
cd worktrees/fly2456-r2-fix && git merge --no-ff -m "drill: main + PR #1128 head (throwaway, never pushed)" b3ed3cc97
git diff origin/main...HEAD --stat -- packages/   # 必须恰好是 StateStore.ts + codex-session-reown.ts + 3 个测试文件
git diff b3ed3cc97 origin/main --stat -- packages/teamlead/src/StateStore.ts packages/teamlead/src/bridge/codex-session-reown.ts | tail -1   # 与 PR diff 一致
```
`git merge-tree --write-tree origin/main b3ed3cc97` 2026-09-10 实测 clean(tree `3a4fc804f`)。若 #1128 已先合入 main,R2 直接用 main,跳过 merge。`/health.buildSha` 必须 == 该 merge commit。

## 5. FLY-913 护栏下的措辞与命令形状

- 允许:`scripts/test-deploy.sh …`、`scripts/test-cycle-bridge.sh N`、`scripts/test-teardown.sh N`、`qa-fly-2454-fleet-snapshot.sh`、`sqlite3 …`、`curl …`、`gh pr create …`。
- 禁止在同一条命令串里出现:终止信号动词 + `run-bridge`/`claude-lead.sh`/`flywheel-bridge-wrapper`/`com.flywheel`;`launchctl` 变更子命令 + `com.flywheel.`;首 token 为 node/npx/tsx 且串里含 `run-bridge`(`flywheel-restart-guard.py:91-122`)。
- `flywheel-comm ask --report` / `qa-result --summary` 的**正文**同样被扫描:报告里写「Bridge 启动脚本」「cycle 原语」,不写那几个字面量。

## 6. 已知盲区(报告里必须声明)

1. 房内 `TEAMLEAD_STUCK_INTERVAL` 不可缩短 ⇒ 修前 attempt 2 与替换体最迟约 5–15 分钟,演练窗口按此预算;
2. 房里 QA 是真 Claude 体,它被 wake 后的 attempt 2 行为不在本演练观察范围(FLY-2208 的 (issue, role) 跑道占用问题可能让 run 在 wake 后 10 分钟内 `held`;所以 **cycle 必须在 wake 后 5 分钟内完成**,或先用 **session 级** `POST /api/actions/terminate`(Bearer master token,body `{"execution_id":"<QA attempt-1 exec>","reason":"FLY-2456 drill"}`,`actions.ts createActionRouter` case `terminate`;**不是** run 级 `/api/runs/:runId/terminate`,那会终止整个 run)收掉 QA attempt-1 再 cycle,之后重跑资格断言并确认 run 仍 `active`;两种做法都要写进报告);
2a. running 且无 open gate 的体只会 `reown_watch_started`(§2.2a);所以 B1/B2 必须先开 `gate --no-block`,B3(parked 非 holder)是阴性对照,预期 `reown_skipped_not_turn_holder`;
3. `DirectEventSink.emitFailed` 对多 activation 体走 legacy 分支(2352 §7 已登记),换体链路的事件形状以实测为准;
4. 演练只证明「529 房 + 本机」形状,不代替 2352 §4 第 2 条(生产首次重启窗口的形状对照)。
