# FLY-2456 529 房真机重启演练(2352 reown)— 探索
Issue: FLY-2456 (https://linear.app/geoforge3d/issue/FLY-2456/529-房演练-2352-真机重启演练slot-里起-2-3-具-codex-体-重启-slot-bridge-测-reown)
日期: 2026-09-10
基于: 无

## 0. 一句话

在 529 隔离房里用真 Codex 体复现「Bridge 重启后多 activation 体 reown 必败」(修前)与「同形状全部认回」(修后)两轮对照,并交出生产零影响证据;审计发现房内 reown 被 `room-info.json` 整体排除,演练必须先解决这一道门。

## 1. 被测病灶(来自 FLY-2352,不再重复调查)

| 事实 | 来源 |
|---|---|
| 病根:`prepareCodexRecoveryCapabilities` 用 FLY-1423 的单 activation 老钥匙 `getWorkflowExecutionBinding`;`workflow_execution_binding` 行数 ≠ 1 ⇒ `undefined` ⇒ 算成非 workflow 体 ⇒ 现算两个布尔为 `false/false` ⇒ `buildCodexRecoveryContext` 抛 `workflow capability drift` | `StateStore.ts:10408-10418`、`codex-session-reown.ts:209-217` |
| 预算:`recovery_claim.episode_attempts`,`maxAttempts:2`;capability 失败**不退还** attempt ⇒ 两次即 `episode_exhausted` ⇒ `runtime.failExhausted` ⇒ `sessions.status='failed'`,`last_error='Codex recovery exhausted after 2 attempts'`,`failureKind='reown_exhausted'` ⇒ 引擎铸替换体 | `codex-session-reown.ts:570-596`、`run-infra.ts:236-257` |
| 生产形状:15 体 / 10 issue,drift 时 100% 多 activation(`spawn`+`wake` 或 `replacement`+`wake`);54 个成功恢复 100% 发生在单 activation 时;**多 activation 状态下零成功** | FLY-2352 exploration §3 |
| 修法(PR #1128 头 `b3ed3cc97`):activation 解析改用 `resolveCurrentWorkflowActivation`,新增 `activation_ambiguous` / `activation_invalid` 两个 fail-closed reason;drift 文案带值;协调器不改 | PR #1128 diff:`StateStore.ts` +24/−?、`codex-session-reown.ts` 1 行 |

**多 activation 的唯一生产者**是 rework 唤醒:`workflow-rework-coordinator.ts:606-651` 对**同一个** `preferred_actor_execution_id` 以 `activationMode:"wake"`、`attempt = max+1` 再 admit 一次 ⇒ 同一 execution 两行 binding。rework 请求有三种 authority:engine(QA 判 fail 的 loop)、lead(`openOperatorRework`,HTTP `POST /api/runs/:runId/rework`)、founder(gate 回炉)。

## 2. 529 房现状审计(2026-09-10,main = `42869f935`)

### 2.1 已有原语,直接复用

| 需要 | 已有 | 备注 |
|---|---|---|
| 只重启房内 Bridge、不碰 Lead / Runner / daemon / tmux / 生产 launchd | `scripts/test-cycle-bridge.sh <slot>`(FLY-2237) | 只 TERM `lsof` 找到的 listener 沿 PPID 上溯到 `bridge.pid` 的那条链;按 `bridge-launch.json` 的同一份 `env -i` 合同重启;输出 `{oldBridgePid,newBridgePid}`;不含任何 FLY-913 护栏触发词 |
| 真 Codex 体房型 | `scripts/test-deploy.sh <slot> --generalized --codex-runner --no-lead` | FLY-2211 为重启演练加的 opt-in;`runnerMode:"real"`;项目配置 `runners.default: codex`、`roles.runner.backend: codex-tmux` |
| slot 隔离(FLY-2454 已合入 main) | `scripts/lib/qa-slot-env-contract.json` + `FLYWHEEL_ISOLATION_ROOT` | tmux socket、comm.db、codex homes / sockets / sessions、kill ledger 全在 `${SLOT_DIR}` 下;boot 违约 exit 78;kill 前逐次校验,拒绝落 `state/kill-ledger/*.ndjson` |
| 生产零影响快照 | `scripts/qa-fly-2454-fleet-snapshot.sh --out <file>` | 两节:生产 `codex app-server` 的 socket 列表、生产默认 tmux 的 `session|window_id|window_name`;路书 §7 判据 = `diff` 为空 |
| Bridge 重启后立即跑 reown | `plugin.ts:9151-9156` boot pass(在 heartbeat 之前);此后每次维护 tick(默认 5 分钟,`TEAMLEAD_STUCK_INTERVAL`)再跑 | 事件写 `session_events`,`source='bridge.codex-session-reown'` |

### 2.2 🔴 发现 1:generalized 房里 Codex 体被 reown **整体排除**

`codex-session-reown.ts:356` `isCodexReownExcluded(session, roomInfo)`:只要 `$FLYWHEEL_STATE_DIR/room-info.json` 存在、`generalized:true`、`projectName == session.project_name`,就返回 `true`(FLY-2211 引入,注释:"The 529 room is an isolated stub topology, not production daemon authority")。

- `--codex-runner` 强制 `--generalized`,generalized 房必写 `${SLOT_DIR}/room-info.json`(`test-deploy.sh:2266-2287`);
- Bridge 的 `FLYWHEEL_STATE_DIR=${SLOT_DIR}` 从 FLY-2211 那一版 `test-deploy.sh:1750` 起就有 ⇒ 这条排除从第一天起就在真 Codex 房里生效;
- `git log -S isCodexReownExcluded` 只有 `e3554c812`,FLY-2237 没动它;
- Bridge 侧 `room-info.json` 的**唯一**读者就是这个 predicate(`plugin.ts:7862`),且是每次 `isExcluded` 调用时现读(read-on-use);scripts 侧读者:`test-deploy.sh`(写)、`qa-529-generalized-e2e.mjs` / `qa-generalized-e2e-lib.mjs`(driver 校验)、`inject-linear-issue.sh`(拒绝 generalized)、`qa-generalized.sh`(拆房 `rm -f`)。

⇒ 按 issue 原话「在 529 slot 里起 Codex 体 → 重启 slot Bridge → 测 reown」直接跑,**boot pass 与所有维护 pass 对房内体一律 skip,零事件、零信号**,修前修后都是「什么都没发生」。这不是被测缺陷,是台架排除。

两条出路(已非阻塞报 Lead,question `aa0f4fe9`):

| | 做法 | 代价 |
|---|---|---|
| **A(推荐,本轮采用)** | 体就位后、cycle 之前把 `${SLOT_DIR}/room-info.json` 改名隐藏(`mv room-info.json room-info.json.drill-hidden`);演练窗口结束、拆房前改回。predicate 见文件缺失返回 `false`,不需重启 Bridge;`test-cycle-bridge.sh` 不读它 | 零产品代码;报告里必须写明这是夹具;隐藏期间不能跑九步 driver(它会拒) |
| B | `isCodexReownExcluded` 对 `roomInfo.runnerMode === "real"` 豁免(`test-deploy` 已写该字段)+ 单测 | 是 2352 同一文件;本单边界「不改 2352 的代码」⇒ 只能另立 follow-up |

### 2.3 🔴 发现 2:#1128 头不含 FLY-2454,不能从它起房

`git merge-base --is-ancestor 5cbd540f1 b3ed3cc97` ⇒ **否**(#1128 基于 `ee113cab9`,早于 FLY-2454 合入)。从 `b3ed3cc97` 的 worktree 跑 `test-deploy.sh` = 用**没有隔离修复**的脚本起房 = issue 依赖段明说的「击杀生产 Codex 舰队 / 生产 tmux」。

`git merge-tree --write-tree origin/main b3ed3cc97` ⇒ **clean**(tree `3a4fc804f`)。⇒ 修后轮用一个**本地一次性 merge commit**(`origin/main` ⊕ `b3ed3cc97`,不推 origin)起房;`--expect-head` 锁该 sha;报告里核对 `packages/` 相对 main 的 diff 恰好等于 #1128 的两文件 diff。若 #1128 在演练前已合入 main,则直接用 main。

### 2.4 发现 3:「生产 comm.db 前后逐字相同」在活库上不可达

`~/.flywheel/comm/flywheel/comm.db-wal` 的 mtime 在 5 秒采样内已变(生产 11 个 session、30 个 codex app-server 持续写 mailbox lease)。逐字节相同只对**空闲**库成立。改判据(已报 Lead):
- 演练前后各 `sqlite3 "file:...?mode=ro" "VACUUM INTO '<snap>'"`;
- 两份快照里凡是含 slot 标识(`test-slot-<N>`、房内每个 execution id、`flywheel-test-<N>`)的行数 **= 0**(前后都要为 0,不是「差集为 0」);
- 生产 comm.db 的行数增量只能由生产 agent 名解释(列出 `from/to` 分布)。
另加两条生产面:`~/.flywheel/state/launch-commits/`(路书 §7 明写的 unconfined consumer,generalized dispatch **一定**写它)前后新增的 executionId 必须**全部属于**房内登记集、无未归属项(bounded delta,不是零;Codex R1 更正);`~/.flywheel/meta-alert/` 与 `~/.flywheel/alert-deadletter/` 前后计数 / 内容按 `leadId` 归属核对(FLY-2182 实测房会漏死信)。

### 2.5 发现 4:预算与时间线的房内形状

- `test-cycle-bridge.sh` 只 TERM Bridge 链;Codex daemon 由 adapter 以独立进程组起(`codex-daemon-runtime.ts` `killGroup(pgid)` 语义),不在 Bridge 的 PPID 链上 ⇒ **daemon 活过重启**。这正是生产 `7c64f6cc` 的 attempt=1 形状(`liveness=alive gateHeld=true`),reown 会先 `reap` 再重建 context(FLY-2352 §7 风险 1 的「次生伤害」也会被复现,属预期)。
- 修前:attempt 1 在 boot pass 当场 drift;attempt 2 要等下一个维护 tick(默认 5 分钟)或 claim TTL(60s)后的下一次 pass ⇒ `episode_exhausted` 最迟约 5–10 分钟;替换体由 `execution_dead_rolled_back → rework_replacement_materialized → rework_replacement_launched` 链铸出。
- 修后:boot pass 当场 `reown_revive_succeeded`,并新增 `workflow_run_event.kind='codex_recovery_capabilities_prepared'` 且 `payload.attempt = 2`(修前该事件为 0 条,这是最锋利的对照)。
- `DirectEventSink.emitFailed` 对多 activation 体走 legacy 分支(同一把老钥匙),这是 2352 §7 已登记的现象,不是本演练要修的。

## 3. 体的形状:怎么在房里造出来

### 3.1 菜单选择:`simple_code`(implement 打头,无 design 节点)

- `code` 菜单第一节点 eng_design 是 Claude(fable)真体,要走完 DOC-FLOW + founder HTML 门(FLY-1404),一具就要几十分钟且不可控;`simple_code`(`tpl_simple_code`:implement → qa → founder_gate → land)implement 直接是 Codex(`registry.yaml:130-136` `defaultModel: codex`),体在 run-start 后立刻出生。
- `test-deploy` 写 adoption 为 `flywheel-test-<N>: [code, generic]`,需在 `${HOST_REPO}/.flywheel/menus/adoption.yaml` 加 `simple_code`(热读,不重启;FLY-2182 实证);category 键 = `simple_code`(`WORK_KIND_CATEGORIES = workflowRegistryShapes()`),六个 canonical binding 由 `qa-generalized.mjs seedBindings` 在装房时全部写入(`length !== 6` 即拒)。
- QA 节点 vendor 由模板 `node.dispatch.vendor` 决定(`resolveNodeDispatchAtLaunch`),`--codex-runner` 只改项目 runner 默认,不改模板 ⇒ QA 仍是 Claude,`same_vendor_review` 不会卡。

### 3.2 三具体(每具一张沙箱 issue,一 issue 一 run)

| 体 | 形状 | 造法 | 重启时状态 |
|---|---|---|---|
| **B1(靶)** | 多 activation:`spawn`(implement@1)+ `wake`(implement@2) | run-start → 体出生 → 代 runner `complete --route needs_review --pr <沙箱 PR>`(implement@1 done,体 `ship_parked`,daemon 进 phase hold)→ 开 rework 唤醒同一体(§3.3)→ `workflow_execution_binding` 两行 | attempt 2 进行中或再次 parked;daemon 活 |
| **B2(对照)** | 单 activation:`spawn`(implement@1) | run-start → 体出生,不动它 | running,attempt 1 |
| **B3(可选对照)** | 单 activation + parked | run-start → 代 runner `complete --route needs_review` | `ship_parked`,gate 在手 |

**资格更正(Codex R1)**:`codex-session-reown.ts:462-527` 对「daemon 活 + 无 open gate + running」的体只记 `reown_watch_started`,不进恢复;recovery 内非 TURN holder 的 parked 体记 `reown_skipped_not_turn_holder`。所以 B1 / B2 在 cycle 前必须各开一个 `gate question --no-block`(生产 15 具 drift 体的 attempt 1 都是 `gateHeld=true`),B3(停驻、TURN 已交 QA)变成阴性对照、不进成功率分母;单变量对照是 B1 vs B2。

### 3.3 唤醒(第二条 activation)的两条路

| | 路径 | 前置 | 证据 | 风险 |
|---|---|---|---|---|
| **P1(主)** | 引擎 rework:QA 节点判 FAIL | implement done 后 QA Claude 体自动出生;从 QA 进程 env 取 `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL` 代 runner `qa-result --status fail` | `workflow_rework_delivery.state='wake_delivered'`(FLY-1768 实测 +1 秒) | 多起一具真 Claude 体;FLY-1768 / FLY-2182 已在真房走通 |
| **P2(备)** | operator rework:`POST /api/runs/:runId/rework`(slot master token,loopback) | run active、implement 最新 attempt 已 ended、无 open rework、`selectPreferredWorkflowActor` 能选到 B1;`validateRunQuiescenceEvidenceTx` 对 active run 恒 ok | 同上 | 房里没跑过;body 需 `targetNodeId/feedback/clientRequestId` |

两条都落到同一个 coordinator 的 `activationMode:"wake"`。plan 以 P1 为主、P2 为备,并要求在修前轮先单独验证唤醒后 `SELECT COUNT(*) FROM workflow_execution_binding WHERE execution_id=B1` = 2 且 `mode` 为 `spawn,wake`,再动 Bridge(FLY-1373 纪律:复活证明与被测动作分开跑)。

### 3.4 房与头

| 轮 | Bridge 代码 | 起房 worktree | slot |
|---|---|---|---|
| R1 修前 | `origin/main`(含 FLY-2454,不含 #1128) | `worktrees/fly2456-r1-main` @ `origin/main` detached | 4 |
| R2 修后 | 本地 merge `origin/main` ⊕ `b3ed3cc97`(或 #1128 合入后的 main) | `worktrees/fly2456-r2-fix` @ merge commit detached | 1 |

- 两轮用不同 slot,R2 不依赖 R1 拆房成功(teardown 撞 cmux lease 是老坑);两轮**串行**不并行(Codex 额度与生产零影响归因都要单变量)。
- 不用 slot 2 / 3:FLY-2454 QA 记录生产默认 tmux 上残留 `runner-test-slot-2/3` 同名 session,会污染 decoy 对照。
- `--no-lead`:Bridge-only 演练不需要常驻 Lead(九步路书同款);顺带绕开 FLY-2455(PR #1145 仍 OPEN,main 上 slot Lead 120s 起不来)。若 Lead 要求带 Lead 的房型,则 FLY-2455 变成硬依赖。
- 沙箱 issue:FLY-202(fixture)、FLY-145、FLY-146(generalized 房关闭 dept-scope reject,标签无关;PreHydrator 需 `LINEAR_API_KEY`,已在 `.env`)。

## 4. 生产零影响证据(五条,前后各一次,同一 checkout 的脚本)

(v3/v4 更正:改为「四次快照、三组对照」矩阵,判据以 plan §3.2/§4.4 为准)

1. `qa-fly-2454-fleet-snapshot.sh`(codex app-server socket 列表 + 生产默认 tmux 窗口):**活着时**只允许多出登记过的 slot socket、不允许 before 行消失;**拆房后** `pass` / `needs-attribution`(消失行由生产 StateStore 终态事件解释且 slot kill-ledger 无目标)/ `fail`;`fly2454-decoy` 窗口每份都在(路书 §7);
2. 全量 `ps` 按 PID 归属 SLOT / NONSLOT,三组对照(before→live-after / before→post-teardown / pre-teardown→post-teardown);
3. 生产 comm.db 快照按 §2.4 判据(schema-driven 全表扫描,带哨兵表);
4. `~/.flywheel/state/launch-commits/` 是 **bounded delta,不是零**:新增 basename 全部属于带来源的声明集(B1/B2/B3/QA/前置一次性体 + 由事件因果链收养的 replacement),无未归属项;
5. 生产 Bridge `/health` 的 `uptime` 单调(证明生产 Bridge 没重启)+ 生产 `~/.flywheel/teamlead.db` 的在线快照(`mode=ro` + `VACUUM INTO`,WAL 库不能复制主文件)里 `session_events` 无 `source='bridge.codex-session-reown'` 且 execution 属房内的行;另加 `runner-flywheel` 窗口计数、alert 目录按 `leadId` 归属、slot kill-ledger 零越界拒绝。

## 5. 不做什么

- 不改 #1128 的代码;不在生产 Bridge 上做任何重启;不跑 `restart-services.sh` / `request-restart.sh`;不碰 `com.flywheel.*`。
- 不把 QA 判决送进引擎;报告交 Lead,按 ship report 骨架、零表格,投 FLY-2352 thread。
- 不验 L1(恢复凭据未投影到 CommDB current activation)—— 房内 Codex 节点无 `produces_output`,与生产同,若撞见 `credential_revoked` 要单独归因,不算 2352 的病。
- 不修 `isCodexReownExcluded`;只做夹具(§2.2 A)。
