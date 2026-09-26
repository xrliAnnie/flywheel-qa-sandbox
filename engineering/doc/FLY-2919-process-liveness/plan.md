# FLY-2919 进程生死单一真源 — 实施计划
Issue: FLY-2919 (https://linear.app/geoforge3d/issue/FLY-2919/病根修复-2-体的生死只认一个真源死体当场终结活体不再按窗口判死9-张-68)
日期: 2026-09-26
基于: research.md

状态: APPROVED — gate f4e94872-60c5-49a3-9d47-89a63b8264f6 / request 7c112571-183b-46a4-969a-04b78a2d9cf4 有效通过；full DOC-FLOW 的 exploration.md、research.md 与本计划共同交付。
续接说明：上述为原设计判决；2026-09-26 17:0xZ 重开指定的 FLY-2921 替身协调器职责边界与继承核验见 design-correction.md，本次附录的评审回执另行记录。
审计基线: `af853328d`，分支 `flywheel-FLY-2919`。原设计执行 `416169c3-8d61-4fc1-b20a-3e2263115f31`；续稿执行 `1b78af3a-1a6f-4ee1-8061-a92d4e8338df`，继承 `7520e274b`。

## 1. 给 founder 的说明

**一句话：体是否还活着只问它自己的进程；窗口只是观察入口，停驻只是工作安排，二者都不能替进程作生死决定。**

本单覆盖盘点 K02 的全部九张单、68 次记录。进程已证死时，当次处理就结束该物理体、结清通信投影；仍需工作时才按原工作流恢复。进程活着但窗口丢失时保留工作与写入资格，并显式报告窗口缺失；保留 founder 可见窗口的产品要求。读取进程证据失败时显示“无法确认”，不能判死或造第二个写入者。

“当场”指第一次取得当前身份的可靠死亡证据的处理轮次，不再等停驻超时、两次缺窗或人工改账；不承诺进程退出与巡检之间零毫秒。后台清理窗口失败不能反过来让死体继续显示正在运行。

```mermaid
flowchart TD
  A[按执行身份读取进程证据] --> B{进程结果}
  B -->|活着| C[保留体与工作资格]
  B -->|未知| D[保留现场并报告无法确认]
  B -->|已死| E[核对当前代次与退出回执]
  E -->|批准退下| F[结束旧进程 保留待命会话]
  E -->|意外退出| G[结束死体 结清通信记录]
  G --> H[有未完成工作时按原流程恢复]
```

进程代次是同一执行身份第几次实际启动，用来避免旧进程的迟到消息关掉新进程。完成回执是控制器已经接受交卷的记录，进程退出本身不是交卷。

## 2. 范围、选择与相邻设计

选用“一个进程证据接口 + 六组消费者收敛”。不选“给 pane 缺失多加一次确认”：仍会双向误判；不选“账面终态就当物理死亡”：会在活进程旁造替身；不选“全删业务等待状态”：会破坏等审与正常待命恢复。

删除的是 parked / ship_parked / awaiting_review **对意外证死体的生死豁免**，以及窗口参与生死的分支；不全局删除这些业务枚举、review gate、route、TURN 或历史事件。TURN 是工作树写入权，不能因窗口消失转交。

基线已经含 FLY-2808（`a084f3a99`）的 controller-approved retiring → standby → resume。standby 指已批准退下、可按原会话恢复；它证明旧物理代次结束，不伪称进程还活着。本单不打开默认关闭的 standby flag，也不改变已有 snapshot 的入组规则。仅有 parked 自报不是批准退下回执。

FLY-2903 PR #1343 已于 2026-09-26T15:15:00Z 合并，merge SHA `cfc8d52d81ed0f4f2a0d79bc3825ae22107a4bba`（本轮 gh 与 git show 核验）。当前设计分支尚不含该提交；实现开工先同步并复用 stop-owner-before-reap、runtime drained 与 closeRunner/controller 回收原语，补本单进程判据、正常重启与跨库负控，不另造回收器。合并不证明已部署，不可将 FLY-2512/2690 验收划掉。

已通过非阻塞问题向 Lead 报告两项差异：九单实际横跨超过 5–6 个文件；K02 快照里“终态直接视死”和“全删 completion_receipt_missing”不能直接照做。原任务的九单验收与单一物理真源优先。问题 ID：`2c84cc0d-af3c-43c0-91ad-6363e170589d`、`2909bd8f-dcfb-4351-9bdf-5ecb31872e5e`。

不涉及：Bridge 崩溃原因、全局调度重构、全部告警重写、生产清库、自动关闭九张 Linear 单、合并部署。涉及单由 Lead 在合入后逐张复核关闭。

## 3. 源码调研与必须改变的入口

下列行号以审计基线为准；实现时用符号查找，禁止凭行号直接修改。

| 入口 | 当前事实 | 处置 |
|---|---|---|
| `packages/teamlead/src/HeartbeatService.ts:847,963,1204,1987` | parked 另走报告路径；pending/absent pane 判 dead；最终复核仍是同一窗口探针 | 全部改读执行身份的进程证据，证死不受 parked 分流影响 |
| `packages/teamlead/src/bridge/tmux-lookup.ts:790` | 名为 probeRunnerProcessLiveness，实际只读 pane_dead | 保留为窗口观察工具并明确命名/注释；本单所有死亡授权调用方迁走，不能只改名字 |
| `packages/teamlead/src/bridge/generalized-launch-recovery.ts:145`、`run-quiescence.ts:41,80` | 通用恢复还信窗口；Codex daemon absent 后又受窗口/host-shell 否决 | 统一适配层；精确 worker absence 不被 viewer/poll shell 覆盖 |
| `packages/claude-runner/src/codex-daemon-runtime.ts:260–395` | 活=socket 持有者属于持久化 group；死=socket 不活且 group 不在；no_group/missing 未知 | 复用，保留身份、权限错误和 pre-spawn 边界 |
| `packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:927,1984,2076` | held recovery 限 persisted_target_missing；dead sweep 先要求账面终态；alive+终态静默等待 | 删账面终态前置，按进程证据收敛；活的残留先请求收体再证死 |
| `packages/teamlead/src/StateStore.ts:44324,61335` | heldPaneLossRecovery 与 rollbackDeadWorkflowNodeExecution 再要求终态 | 以当前进程证据代替；保留精确 request/route/node/attempt 和 CAS |
| `StateStore.ts:16411` | terminalizeProvenDeadSessionTx 已维护时间戳、版本与资格撤销 | 扩展现有事务路径，不用裸 UPDATE 绕过不变量 |
| `packages/teamlead/src/bridge/commdb-fsm-reconcile.ts:207–350`、`packages/flywheel-comm/src/db.ts:9435` | 先等窗口死，再由 parked 声明否决；活窗口也阻挡结账 | 进程证明进入受信结账；自报 parked 不再有否决权 |
| `packages/flywheel-comm/src/db.ts:9267` | finalizeProvenGoneSession 已有 identity epoch、过期校验、幂等回执、TURN/创始人唤醒保护，但上下文是 land reservation | 提取内部受信 finalization 核心供生命周期协调器用，不伪造 land reservation |
| `packages/teamlead/src/bridge/delivery-operations.ts:167`、`StateStore.ts:49521` | CommDB running 可阻止到期探测；释放只结算特定 ship_parked | 到期走同一收体/结账路径，两载体均覆盖 |
| `packages/claude-runner/src/TmuxAdapter.ts:1301,1408,2120,2188` | 两条 wait 路径都把 pane 丢失当正常完成，返回 success:true | 窗口失联继续进程探测；无完成回执的真实异常退出记 failed |
| `packages/teamlead/src/DirectEventSink.ts:695,966`、`packages/edge-worker/src/Blueprint.ts` | adapter success 可落 session_completed | 增加异常退出分类，直接/HTTP 两入口同义，已接受交卷不被覆盖 |
| `StateStore.ts:50886,51872`、`packages/teamlead/src/bridge/plugin.ts:1911` | terminate 候选只收非终态；缺 session 直接当已收走 | collection 专用全归属候选，逐具核验物理体与通信残留 |
| `packages/teamlead/src/bridge/codex-phase-shutdown.ts:104,166` | 缺窗可绕协作关停，ACK 仅查窗消失 | 活控制器先协作停止；ACK 后仍核进程退出；窗口是另项清理 |
| `packages/claude-runner/src/CodexTmuxAdapter.ts:1727,2278` | runEnded/finally 已取消 TUI 恢复 | 让真关闭到达该路径；恢复前重核当前 run/owner 关闭事实 |
| `packages/teamlead/src/bridge/plugin.ts:15839`、`server-loss.ts` | tmux 服务损失可按窗口 gone 强制 failed | 服务损失只触发共同进程探测，不直接判死 |
| `packages/teamlead/src/bridge/crash-reaper.ts`、`zombie-scan.ts:93` | dead_pin / 24h 心跳 + pane 决定尸体 | 分离进程死亡与窗口清理；生命判断共用接口 |
| `packages/teamlead/src/bridge/pane-loss-reconcile.ts:510` | server generation + 窗口缺失仍可直接 applyTransition failed | 窗口事件只能触发共同进程探测；没有死亡证明只报窗口缺陷 |
| `packages/teamlead/src/bridge/execution-closeout-evidence.ts:126,470`、`lifecycle-closeout.ts:1799` | window/heartbeat 可以 veto gone，另有只按窗确认 gone 的分支 | body verdict 统一来源，拆开物理体终结与 UI 残留；保留 land reservation/归属与消息保护 |
| `packages/teamlead/src/bridge/commdb-session-prune.ts:503` | point/sweep parked veto、窗口探针仍独立决定 eligible_dead | 共用受信证据和结账义务，不保留旁路收账 |
| `packages/teamlead/src/bridge/patrol-process-liveness.ts:58`、`scripts/lead-patrol-snapshot.sh:432` | 巡检按窗判死/活，MISSING_PANE 被当“未工作”线索 | 进程结论与窗口缺失分别输出；窗口缺失仍须修复，但不导出体死或 TURN 无人 |

## 4. 单一证据契约

新增 `packages/claude-runner/src/execution-process-liveness.ts`，作为两载体可用的底层接口；由 `packages/teamlead/src/bridge/execution-body-liveness.ts` 组装 StateStore 当前身份。包导出随接口一起更新。所有新接口仅 Bridge/adapter 内部调用，不新增 Runner 可提交 dead=true 的 HTTP/CLI 入口。

```ts
type BodyIdentity = {
  executionId: string;
  activationId: string | null;
  generation: number;
  lifecycleRevision: number;
  adapter: "codex-tmux" | "claude-tmux" | "kimi-tmux" | "antigravity-tmux";
};
type BodyObservation = {
  identity: BodyIdentity;
  verdict: "alive" | "dead" | "unknown";
  observedAt: string;
  expiresAt: string;
  bindingDigest: string;
  reason: string;
};
```

`bindingDigest` 绑定实际 OS 进程身份（pid、开始时间、host boot、执行/代次、原生会话或 daemon group）；不是把窗口名哈希。探测总上限 5 秒、证据有效期 10 秒，进入持久化事务前重核身份与版本。超时、解析失败、权限不足、身份冲突一律 unknown；现有有去重的三次 unknown 升级路径复用，不借故重新 spawn。读证据不发信号。

**Codex：**复用 probeCodexDaemonEvidence/ProcessBinding。socket+group 与身份一致才 alive；原 group 确认不存在且 socket 不活仅证明 daemon absent，必须再通过 §4.1 的 controller/spawn 守卫才可得 body dead。活窗口、tail、Reconnect failed TUI、带 execId 的 shell 不参与结果。PGID 复用/开始时间不符不授权 signal；socket 暂不可达而 group 仍在是 unknown。控制器可重建 daemon 时，恢复/启动 lease 是写前竞争守卫，须先关闭旧 generation 的启动所有权，再提交死亡/替换。缺 group 文件不是死；保留 PRE_ADAPTER_FAILURE_KINDS + closed launch claim + 两次零证据的既有例外，不能由 home 路径推定从未启动。

**Claude：**现有 `TmuxAdapter.persistClaudeSessionState` 的 session.json 只有会话/工作树，无 PID/start，必须补足真实启动绑定。启动脚本在最终 `exec claude` 的同一进程上登记 pid/start/boot、executionId、generation、sessionId；adapter 从 OS 独立核对命令路径、精确 native session 参数、cwd 与启动身份后，原子保存 versioned process binding。登记必须在宣告启动成功前，且窗口创建失败不能成为运行绑定缺失的成功启动。不能把 pane_pid、wrapper PID 或 `pgrep -f execId` 命中直接当 worker。worker 退出但仍有能写工作树的自有子进程时返回 unknown 并走原收体，直到该代次 writer tree 退出；viewer 属展示残留不算 writer。

启动登记文件使用现有执行隔离目录、0600、临时文件 rename，只作未受信输入；Bridge 独立核验后将 accepted binding 存入 StateStore，后续生死判断读取这份被接纳的绑定。读取限制大小、不跟随软链/非普通文件，所有外部数字/身份字符串在边界校验。same-UID 文件权限不宣称构成安全隔离，OS 复核与生命周期 CAS 仍必需。同一执行 resume 必须先持有已有 generation claim，登记新代次后旧证据自动失效。进程缺失只有在该代次启动已绑定且未进入新启动竞争时才是可靠死亡。KimiTmuxAdapter / AntigravityTmuxAdapter 继承同一个 TmuxAdapter 启动壳，必须共用 PID/start/boot/exec-generation 绑定与 OS 探测；它们没有 Claude native session 参数，不能要求一个不存在的参数，应按真实 executable、启动 nonce、cwd、注册 executionId 关联。保留各自合法完成协议，不扩张到会话恢复功能。未知未注册 adapter 才返回 unknown。A 组加四载体参数化回归，不能给现存载体留下永久 unknown 退化。

**旧运行迁移：**不因绑定缺失判死。对存活 Claude 由原生 sessionId + canonical cwd + executable + OS start/boot 唯一匹配补采绑定，经当前 activation/generation CAS 接纳；无匹配/多匹配/读取失败均 unknown，报告待收体清单。确已消失但从未留下绑定的历史记录，只能走已有独立受信退出回执/受控恢复门，不凭空造死证。新版本所有新启动必须绑定。529 验证一个旧存活体的补采与一个未知旧体的拒绝。此迁移限制必须在 QA 报告量化，不能将未知旧体计为已修复。

### 4.1 Codex 原地重启的必需守卫（R1 HIGH）

源码 `codex-daemon-goal-runtime.ts:639,763,788` 会 killSession → drainExit → startSession → onSpawnIdentity，最多既有 maxRestarts=5 次、resume 同一 thread；当前账号选择语义不变。旧 daemon 退出不是整个 resident 控制器的死亡。不能依赖当前不存在的“持久重启 lease”，也不能通过关掉正常重启来让测试变绿。

新增 StateStore `execution_process_owner` 身份/启动所有权记录（不是第二份生命判定）：`execution_id TEXT PRIMARY KEY`、`activation_id TEXT NULL`、`generation INTEGER NOT NULL`、`owner_token TEXT NOT NULL`、`controller_pid INTEGER`、`controller_start TEXT`、`host_boot_id TEXT`、`spawn_epoch INTEGER NOT NULL DEFAULT 0`、`restart_in_progress INTEGER NOT NULL DEFAULT 0`、`spawn_inflight INTEGER NOT NULL DEFAULT 0`、`close_requested INTEGER NOT NULL DEFAULT 0`、`binding_json TEXT`、`binding_digest TEXT`、`owner_drained_at TEXT NULL`、`owner_drained_receipt TEXT NULL`。正整数/0或1 CHECK，参数化写入。generation 是逻辑物理代次，spawn_epoch 是其内部 daemon 的第几次启动；替换不得复用旧 owner_token。表只记录身份与排他资格，不存 alive/dead，不能用旗标代替 OS 进程探测。

- Bridge 在调用 runtime.runGoal 前登记自己的 PID/start/boot 与 owner_token。复用 FLY-2903 的 `CodexExecutionOwnershipRegistry.claim(...,{onStopRequested})` 与 lease.stopRequested/requestStop；现有 registry 不暴露 runtime handle 或 token，需扩展 lease 接受受控 ownerToken/返回绑定身份，由 adapter 的 stop callback 连接 runtime，不再造 registry。所有 launch/rescue 都走这个门，spawn 前缺 accepted owner 就失败关闭。旧控制器未持久登记时先登记/核验，不开放新死亡消费者。Bridge 重启不能仅因内存 registry 空就判死，须验证旧 controller 的实际进程身份。
- **活 owner 的守卫覆盖整个 runGoal**：daemon absent、而该 exact controller 仍活且没有 close/drained 证据时返回 unknown，reason 为 `controller_recovery_active`。这也覆盖异常 transport close 到 catch 尚未写 restart 标记的短窗。当前 probe 的 dead 指该执行已没有可续写/可重启的控制器和 worker，不只是一个 daemon 曾退出。
- catch 在 `killSession` 前调用 await `beginDaemonRestart(ownerToken, expectedSpawnEpoch)`，CAS 同代 owner 且 close_requested=0，设置 restart_in_progress=1；拒绝则调用 runtime.stop，不再进入 retry。预算用尽仍走原失败/stop/drained，而非提前释放 owner。
- **每一次** startSession（初启、同线程 restart、rescue）经 `beforeCodexDaemonStart` 等所有可等待步骤后，在真正 native spawn 前调用 `beginSpawn`；用现有 mutation lease 串行化、校验 ownerToken/generation/close_requested，再令 spawn_epoch+1、spawn_inflight=1。将同一 permit 传到低层 spawnCodexDaemon（在 `codex-daemon-runtime.ts`）的实际 spawn 调用前校验；不得在校验和实际 spawn 之间留下未被 permit 覆盖的 await。onSpawnIdentity 必须绑定该 permit 并保存新 group/PID/start 后才清 spawn_inflight/restart_in_progress。
- death/terminal close 与 beginSpawn 共用同一 execution 的底层同步 fail-closed CAS。正常自动重启期间不夺权、不写 failed、不耗 fault-replacement 预算。只有显式 terminal/terminate/批准退下才 CAS close_requested=1，发既有 cooperative shutdown，runtime.stop → await runtime.drained → 独立探测 group/writer gone 后终结。spawn 已在途则 close 等它归档或 drain 掉部分 newborn；不能因租约到时、回调超时就宣称 drain 完成。
- controller 真死时，由 OS PID/start/boot 证明后 CAS 关闭旧 owner；核验最后一份 accepted daemon binding 与 socket/group。beginSpawn 在途中而绑定缺失时保持 unknown，走现有受控残留恢复，不能从空表补造死亡。任何新代次/新 owner 接纳前必须先解决旧 spawn 的物理去向。close_requested 提交后旧 token 的 startSession 必须拒绝；若低层已经 spawn，则该在途 handle 必须先 drain、零工作 turn 才允许死亡提交。
- 死亡事务必须检查 `spawn_inflight=0`、旧 owner 已 stopped+drained 或其 OS 身份已确认 gone、观察绑定的 spawn_epoch 未变，再提交 body_death。R1 原来的“一句 lease 守卫”由以上具体写点替代。

**必须实现的收尾与异步边界：**

- `execution-mutation-lease.ts` 的现有 helper 接受同步 `mutate: () => T`，且缺 session 会直接执行回调；禁止把 async spawn/drain 放进它来假定锁仍有效。beginSpawn/close/death 直接使用拒绝 session_missing 的底层 claim 与同步事务，缺 session/owner 一律拒绝。短 lease 只保护同步 CAS，跨 await 靠 durable spawn_inflight/ownerToken/spawn_epoch 排他；60 秒 TTL 到期也不能清除在途资格。
- 当前 `onSpawnIdentity(pgid): void` 是同步回调。本单采用完整 awaited 身份提交：改 runtime options、底层 spawn 调用、adapter 及所有注入调用点为 `Promise<void>` 并 await。独立读取 start/boot 后提交 StateStore accepted binding，成功前 permit 始终在途，不进行 socket admission 或模型 turn。任一步失败先停并 drain newborn；session.json 已写但 StateStore 未写只能视为恢复候选，经同 permit/OS 复核补交，不能直接清 in-flight 或判死。
- 在 runGoal 正常返回、预算耗尽、非 transport 错误与显式 stop 的所有 adapter finally 路径，await `runtime.drained()`，独立确认该 worker/group gone，再 CAS 写入 `owner_drained_at/receipt`（绑定 execution/generation/ownerToken/spawn_epoch 和退出原因），最后 release ownership lease。失败不写 drained；共享 Bridge PID 存活不能覆盖这一精确收尾收据。没有收尾收据而活 Bridge 中的 execution handle 确认缺失时，先沿相同 stop/drain 协调器恢复收尾，不永久 unknown，也不把“内存缺失”当物理死亡。
- FLY-2903 `requestStop` 的 stopped 仅表示 lease 已释放，timeout/not_owned/reserved_fenced 同样不是进程死亡证据；所有返回后仍需要上述 OS 验证。`process_retirement` 不永久 fence execution_id；本单 close_requested 限旧 generation/token。旧体 drained 且有批准 resume 后，同 execution 的新 generation 可以接纳，旧 token 永久拒绝。
- 新增负控：共享 Bridge 仍活而该 execution 已正常收尾，daemon gone 能得 dead；spawn 跨 mutation TTL 仍零死亡/零第二 writer；批准 process_retirement 后新 generation 成功恢复、旧 token 拒绝；异步 identity 提交失败时零模型 turn、部分 session.json 不获死亡或启动权。

A/B/E 明确加入 `codex-daemon-goal-runtime.ts`、`codex-daemon-runtime.ts`、`codex-execution-ownership.ts`、`CodexTmuxAdapter.ts`、StateStore 与 Bridge wiring。红测阻塞 killSession/drainExit/startSession/onSpawnIdentity 四个边界并同时运行 Heartbeat/dispatcher：有重启预算时零死亡写、零后继、仍同 thread，恢复后新 group 被接受；预算用尽才按原失败处理；已提交 close/death 的旧 token 在任意边界恢复后都零模型 turn；stop 与在途 spawn 竞态必须等 drain，拒绝第二 writer。Bridge 在四边界重启的恢复分支也进 529。

### 4.2 TmuxAdapter writer 集合与探测预算（R1 advisories）

Claude/Kimi/Antigravity 启动绑定记录 **独立进程组 PGID + leader PID/start/boot**，不得复用 tmux server 的进程组；adapter 核验组 leader 的真实命令才接纳。所有在该组的非展示进程（包括 MCP server 与 dev server）都算待收体 writer，不按进程名“看起来像工具”豁免。在 worker 还活时记录已观察到的后代 `{pid,start,boot}`，并携带该 execution/generation 的启动 nonce。父退出后按这些身份和组成员查找，不能依赖已断掉的 PPID 树。setsid/detached 后代用已绑定 PID/start 或精确继承 nonce 独立核验；只有显式创建并登记为纯 TUI/viewer 的进程可排除。不能归属的进程不授权 signal；存在无法核清的自有残留则 unknown、可见收体失败，不以组空掩盖漏扫。新启动运行壳要保证可追踪的 detached launch；不宣称对任意绕过登记且清掉身份的同 UID 恶意 fork 提供隔离保证。测试包含父退出后被收养、MCP/dev server、setsid 后代、nonce 缺失且已绑定的后代、PID复用与外人同名进程；必须证明本仓 Runner shell 的真实后台任务仍被追踪。

进程采样从 dispatcher 热 tick 移到现有 Heartbeat 采样链，共享每 execution/generation/owner/spawnEpoch 的 in-flight Promise（不做第二套判定缓存）。每轮最多 8 个候选、并发 2、总采样窗口 5 秒；未轮到的按稳定游标跨轮公平处理，优先显式 exit/terminal/rework 需求。dispatcher 只消费仍在 10 秒有效期内且身份匹配的观测，缺观测排入下一轮、当前 launch/rework 调度继续，不串行 await N 个 5 秒探针。同代重复来源 coalesce，代次变化丢弃旧结果。确认可靠死亡后本轮收敛，不增加等待轮次。fake timers 测 100 个候选/慢探针，断言并发≤2、每轮开始≤8、dispatch 热 tick 不被全部探针拖住、游标无饥饿；超时任务要可取消并等待子进程回收，不能用 Promise.race 遗留后台探针。

心跳和信箱活跃时间只作诊断与采样排程；不覆盖当前代次可靠死亡证据。显示 DTO（传给页面的数据）分别有 bodyVerdict 与 windowState；不把一个字段复制成另一份生命账。

## 5. 死亡与正常退下的持久化顺序

单一真源指所有生命结论来自同一证据契约；不声称跨两个 SQLite 文件能做一笔原子事务。复用现有 mutation lease、workflow events、park projection 与 wake retirement，不创建平行调度器。

1. Bridge 获取 exact execution 的 mutation lease；收集证据，核对 run/node/attempt/activation/generation/lifecycleRevision 与 launch/resume owner。提交前再核新代次与证据时效，变化则放弃并重新采样。
2. 对 `dead`：若存在当前代次已经批准的 retirement request，关闭旧物理代次并沿 FLY-2808 确认 standby；若已经有有效完成回执，保留 node 完成结果，关闭其物理体，不重跑已交卷阶段；其余意外退出使用 terminalizeProvenDeadSessionTx 记 failed（已不可逆终态保持原结局）。同一事务写 `body_death:<exec>:<generation>` 幂等事件和待投影结账义务，保存证据身份/原因、旧版本、需要保留/重路由的工作。
3. 若死体持 TURN，在死亡义务持有 mutation lease 且核对当前节点归属后用 CommDB `deleteTurnIfCurrent(issueId, deadExecutionId, observedEpoch)` 比较撤销；新 grant 使用现有控制器授予路径，禁止无条件 deleteTurn。CAS 失败则重新核对，不删除新 owner。重工唤醒使用既有 `recordReworkWakeRetirementsTx` / CommDB retirement proof。founder wake 不存在通用重绑 API，因此无论是否有后继，都先调用 `completeRunnerPhaseWakeTerminal`，绑定原 messageId 与死亡 terminalLifecycleId，reason=body_gone_before_started，写 durable wake_failed 告警并保留原文来源；合法后继若需接收，由原有新 wake 入口发新消息，不把失败旧消息伪成 consumed。无后继也可以完成这一交代并结账。告警尚未投递由原 outbox 重试，不阻止 session 投影从 running 结束。
4. CommDB 在同一事务验证其 identity epoch 和 StateStore 内部提供的死亡义务身份，清除 parked 声明并将 running 投影结束。将 finalizeProvenGoneSession 的内部核心与通用生命周期义务接通：输入须含受信 obligationId/exec/generation/expectedIdentityRevision/evidenceId/有效期；不可把任意字符串当 land reservation。普通状态驱动 finalizer 仍无杀活体权限。保留身份行时镜像主账结局：意外退出 failed，原 blocked 保持 blocked，已接受交卷/批准 standby 才投影 completed；显式 terminate 使用既有终止映射且携带原因，不能把崩溃报成 done（CommDB CHECK 已支持 failed/blocked，不新增枚举）。直到 TURN/唤醒全部处理才删除身份；不为赶清库删除恢复信息。
5. 只有旧 writer 已证死、TURN/旧启动所有权已 fenced、原有 dispatch/rework 约束通过，才创建一个后继。物理窗口清理单独重试，不作为生命结论或换体前置；新后继不得与旧可写进程重叠。
6. 进程证死到 StateStore 提交前崩溃：无副作用，重探。StateStore 已提交到 CommDB 前崩溃：重放同一义务，幂等键不变；旧 running 行不能作为新生命权威。投影后回执前崩溃：读 CommDB 幂等结果补投影完成。身份在任一步改变：CAS 拒绝，不能将旧证据重绑给新代次。

上述协调器建议落在 `packages/teamlead/src/bridge/execution-body-convergence.ts`，仅封装当前死亡/结账调用链；StateStore 新公共入口命名 `convergeProvenDeadExecution`，禁止公开 HTTP 原样透传 BodyObservation。现有恢复预算、hold 决策、归属、审批、完成回执校验全部保留。

**FLY-2512 的终态活体：**终态标签不能充当死亡证据。先查确有不可逆 terminal intent 且当前无更新 activation/TURN；发送既有 cooperative shutdown，停止 controller 和窗口恢复，再精确 reap daemon/writer tree，重新探测。若无法停止，使用现有持久 closeout 重试与告警，禁止静默无限等待；达到已有 retry budget 进入可见 recovery hold，不替换、不重新开启旧任务。只有 viewer 活着则无需等待它“自然死”。

**FLY-2474 的到期退场：**到期只提出收体需求，不能先把 holder 的 run 权限删掉；当前有 TURN/新工作/新 activation 时拒绝过期请求。允许退场时用正常退出的同一顺序；两载体 StateStore 与 CommDB 都记录结果，不另留一条 grace timeout 的独立 completed 写法。

**FLY-2528 的无判决退出：**两个 TmuxAdapter wait 分支均返回明确 exitKind；`abnormal_process_exit` 经 Blueprint → DirectEventSink/HTTP event-route 映射 failed。只针对本单 DAG 执行的无判决异常退出；legacy blueprint 的合法 decision/GitResultChecker 成功语义不改。已接受 complete receipt 或匹配批准 retirement 则保留原结果。只删“pane 丢失→正常完成”与“无判决自然退出→完成”的生产分支。保留真实交卷投影丢失的 completion_receipt_missing / reconstruct_completion，且该恢复仍要原始真实 receipt，不能补造成功。历史错误 completed+held 仅在独立异常退出证据、无 accepted completion、当前 attempt 与 hold 匹配时由受控迁移切至失败恢复；不能按 completed 一刀切重跑。

## 6. 六组实施任务（均先红测，再最小实现，最后相关回归）

| 组 | 修改文件/职责 | 必须先失败的测试与具体断言 |
|---|---|---|
| A 统一物理证据 | 新 `execution-process-liveness.ts`、`execution-body-liveness.ts`；`codex-daemon-runtime.ts`、`codex-daemon-goal-runtime.ts`、`codex-execution-ownership.ts`、`TmuxAdapter.ts` 启动绑定与包导出 | 新 `packages/claude-runner/test/execution-process-liveness.test.ts`：两载体 alive/dead/unknown × absent/present/pending window 恒等结果；PID/start/boot/generation 变更拒绝；viewer-only 不算 worker；旧绑定补采唯一匹配才成功 |
| B 检测与恢复 | HeartbeatService、generalized-launch-recovery、run-quiescence、dispatcher、StateStore exact death事务；server-loss/plugin、pane-loss-reconcile、crash-reaper、zombie-scan | `HeartbeatService.zombie-reconcile`、`StateStore.fly1385-dead-exec`、`workflow-engine-dispatcher`：非终态证死本轮 failed；终态活 worker 先 close；单一后继；死亡前后 generation 竞争不写；服务重启+活 daemon 不迁 failed |
| C 双库收敛 | 新 convergence 协调器、StateStore events/投影义务、commdb-fsm-reconcile、commdb-session-prune、execution-closeout-evidence、lifecycle-closeout、done-thread-reconcile、state-store-ghost-reconcile、CommDB trusted finalizer 与既有 wake retirement | 新 `packages/teamlead/src/bridge/__tests__/execution-body-convergence.test.ts`：parked 不否决死亡；三个崩溃切点重放一次；旧 epoch 拒绝；死 TURN 先有合法交接；founder wake 不丢；projection pending 不当 alive |
| D 退出与到期 | TmuxAdapter 两 wait 分支、Blueprint、DirectEventSink、event-route、delivery-operations、StateStore resident expiry；不删除 receipt-repair registry | `TmuxAdapter.test`、`DirectEventSink.test`、`fly2268-resident-expiry`、`fly2478-resident-release`：窗丢但进程活继续；真实无判决退出 failed；已交卷保持；Claude/Codex running 投影不能挡住死亡 |
| E 终止与残留 | StateStore collection 专用候选、plugin collection、codex-phase-shutdown、CodexTmuxAdapter/codex-runner-tui-window 既有取消路径、close-runner | `StateStore.workflow-run-collection` 改 completed exclusion；`codex-runner-tui-window.test`：completed 标签但进程活仍入清单，shutdown→进程 gone→结账，重放不恢复窗；无 session 但有进程不能 already-gone |
| F 巡检与验收 | patrol-process-liveness、lead-patrol-snapshot 及对应规则/测试，逐消费者 sweep 与九单证据 | 巡检返回 body alive + window missing；不得建议以缺窗终结/换体；有关窗口缺失的报告仍在；九单逐条 before/after 记录 |

每组执行顺序固定：添加表中 fixture → 精确文件 vitest 记录旧版本失败断言 → 最小实现 → 同一断言通过 → 跑下列受影响回归 → 提交。不允许先改全部代码再补镜像测试。生命周期/land closeout 中仍保留已有 authority、reservation 与完整 UI 清理交付要求；只将“身体已死”和“展示清理完成”拆成独立事实，不能因窗口没清掉阻止身体终结，也不能因身体终结谎报整个 land closeout 完成。post-merge、done-thread-archiver、terminal-thread-archive、shipped-husk-escalation 的窗口调用逐一标为仅 UI 资源观察；若某调用仍据窗升级/收体，则在 B/C 同步迁走，不创建新告警项目。

新共用接口附加“任何 windowState 变化不改变 bodyVerdict”的性质测试；让旧 pane 实现跑该 fixture，必须出现反例。

### 6.1 删除/保留清单（实现提交中逐项列出最终符号与行号）

删除：Heartbeat parked 死亡豁免；pane-absence streak 与 server-up 死亡前置；窗口 absent/dead_pin → body dead 映射；StateStore/dispatcher “必须账面已终态才能处理证死”前置；commdb reconcile window-first + parked veto 组合；resident expiry registry-running 跳过探测；无 verdict 的 exit→completed；collection 按 completed 排除物理候选；ACK/closeout 用无窗代替无进程；巡检 MISSING_PANE→不活/不工作推断。

保留：业务等审/交卷枚举；FLY-2808 精确批准退下与同会话 resume；完成回执恢复；TURN/epoch/generation/生命周期版本；消息来源与 founder wake；失败预算、环境失败、dispatch quota；窗口查找与清理（仅展示定位）；生产必须有可见 TUI 的要求。

不得将 `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES` 加上 ship_parked/awaiting_review 草草了事；这会将活等审体变成不可逆终态。不得为删分支全局改掉 liveRunAttributedExecutionsTx，因为 sessionless-gate 也消费它。

## 7. 九单验收矩阵

盘点来源 `engineering/doc/FLY-2072-triage/fixclasses.json` K02、`tickets.json`，仓库提交 `eabcd72a5`。每行须独立 fixture/测试名与日志；次数是历史盘点数，不是本轮实测数。

| 单 / 次数 | 构造原现象 | 修后必须观察到 | 负控 |
|---|---|---|---|
| FLY-2083 /25 | ship_parked、awaiting_review 目标已死，rework held/persisted_target_missing | 无人工改终态即终结、原请求生成一个替身、旧 wake 有 retirement receipt | 活停驻/旧 route/replayed death 不替换 |
| FLY-2537 /16 | 真死体 CommDB running + parked 声明，窗口也可残留 | StateStore 终结、CommDB 不再 running、声明清掉；重复扫无重复副作用 | FLY-2555 的历史反例：无窗但 daemon/socket 活，必须保留 |
| FLY-2474 /7 | Claude/Codex resident grace 到期，旧实现只结束一侧 | 通过统一退场完成两库收敛，window-cleanup 失败另报 | 新工作/TURN、未知进程、已更新 activation 拒绝过期收体 |
| FLY-2193 /7 | worker 死但 tail/viewer pane 活；反向窗死 worker 活 | 前者本轮终结，后者仍 alive，两者用同一探针 | 心跳旧新都不能翻转精确进程结果 |
| FLY-2690 /5 | terminate collectExecutions，completed 设计体仍有 daemon/controller/TUI | 进入 frozen target list，controller 停、daemon gone、TUI retry 取消、CommDB 结清 | 不属于该 run 的进程不动；重复收集不重新恢复 |
| FLY-2512 /4 | failed + Reconnect failed TUI/poll shell、daemon absent；另测真活 daemon | UI 壳不阻挡恢复；真活 daemon 先精确关停验证再造一个替身 | stop/reap 未证成功时零替身且有可见 hold/告警 |
| FLY-2618 /2 | :pending + 活 daemon，模拟 Bridge 崩溃与重连期间扫两轮 | 零 force-fail/替身，写入资格保留，窗口异常可见 | dead daemon + pending 也能可靠终结 |
| FLY-2528 /1 | tmux server 消失、worker 真退出且无 complete receipt | adapter→Blueprint→sink 为 failed，恢复入口可达，非假 completed | 活 worker 不退出；真 complete receipt 与批准 retirement 不覆写 |
| FLY-2529 /1 | 重建 tmux server、旧 @window，原 worker 活 | roster/tick 显示 alive+缺窗，无“棒持有者已死”推断 | 同样窗口观测、worker 死时得出 dead |

共 68 次；重复 FLY-2710 并入 2474，不另计一张。全部 fixture 绑定执行/代次、before 与 after SHA。单测不是生产修复证明。

## 8. 相关测试与 529 真机验收

本机仅精确文件集合，禁止 `pnpm test` / 全包 / `vitest related` 枢纽扩张。不在设计阶段执行故障注入或改活库。实现/QA 根据实际改动补充具体文件清单，遗漏的消费者不能靠全绿掩盖。

在仓库根用隔离临时根，避免 startBridge 测试触碰生产 Codex homes：

```sh
export FLYWHEEL_CODEX_HOMES_ROOT="$(mktemp -d /tmp/fly2919-homes.XXXXXX)"
pnpm --filter flywheel-claude-runner exec vitest run test/execution-process-liveness.test.ts test/codex-daemon-runtime.test.ts test/codex-daemon-goal-runtime.test.ts test/codex-execution-ownership.test.ts test/KimiTmuxAdapter.test.ts test/AntigravityTmuxAdapter.test.ts test/TmuxAdapter.test.ts test/CodexTmuxAdapter.test.ts test/codex-runner-tui-window.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/HeartbeatService.zombie-reconcile.test.ts src/__tests__/HeartbeatService.monitor-loss.test.ts src/__tests__/HeartbeatService.fly1329-readopt-parked.test.ts src/__tests__/StateStore.fly1385-dead-exec.test.ts src/__tests__/workflow-engine-dispatcher.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/execution-body-convergence.test.ts src/__tests__/commdb-fsm-reconcile.test.ts src/bridge/__tests__/commdb-fsm-reconcile.fly1329-parked-veto.test.ts src/bridge/__tests__/workflow-engine.fly2302-dead-body-commdb.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly2268-resident-expiry.test.ts src/__tests__/fly2478-resident-release.test.ts src/__tests__/workflow-process-retirement.test.ts src/__tests__/DirectEventSink.test.ts src/__tests__/StateStore.workflow-run-collection.test.ts src/__tests__/hold-shape-registry.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/generalized-launch-recovery.test.ts src/bridge/__tests__/run-quiescence.test.ts src/bridge/__tests__/patrol-process-liveness.test.ts src/bridge/__tests__/zombie-scan.test.ts src/bridge/__tests__/server-loss.test.ts src/bridge/__tests__/codex-phase-shutdown.test.ts src/bridge/__tests__/pane-loss-reconcile.test.ts src/bridge/__tests__/execution-closeout-evidence.test.ts
pnpm --filter flywheel-comm exec vitest run src/__tests__/db.fly1238.test.ts src/__tests__/db.fly2517-wake-retirement.test.ts
```

补充精确命令：`pnpm --filter flywheel-teamlead exec vitest run src/__tests__/event-route.test.ts src/__tests__/crash-reaper.test.ts`；Blueprint 在 `packages/edge-worker` 内执行 `pnpm exec vitest run src/__tests__/Blueprint.test.ts`。不把“文件不存在所以零测试”算通过。排除任何 `tmux-viewer.macos.test.ts`。改变公共 finalizer 后补跑该方法实际调用者的精确测试，并报告未执行范围。

529 房使用新的隔离 slot，绑定本分支实际 build SHA、Bridge 路径/版本与载体身份。至少实测 Claude、Codex 各一组：

1. 保留真实 worker，删除/重建其房内窗口或使注册 target 失效；跨 Heartbeat、server-loss、patrol 观察，worker 继续工作且不被 failed/替换；窗口缺失仍可见。
2. 仅结束房内 worker，保留 viewer/TUI 窗；第一次可靠证死后查两库/死亡义务/TURN/后继，旧 worker 无继续写入，恰一后继恢复。
3. 正常 resident 到期和 run terminate 各一次；验证 controller 不重建窗口、两载体两库终态收敛；过一个原恢复重试周期再次观察，不能只截瞬时截图。
4. 进程异常退出无 verdict → failed；批准退下 → standby → 原会话恢复，二者都验证身份。新 generation 起后注入旧退出回调，当前体不受影响。
5. 在 StateStore 提交后/CommDB 提交前模拟房内 Bridge 重启，验证相同义务幂等重放、founder wake 来源保留、无第二写入者。真实 daemon socket 在房外时不得绕过隔离；记录该验收未完成并修正房内布置。

保留实际命令、时间、进程 start/boot 绑定、两次观察、前后库查询、controller 与 worker 退出证据、窗口缺陷与恢复日志。live DB 只用 snapshot-control runner 取得快照，禁止 cp。QA 不能把静态探针 mock 当以上真机证据。

## 9. 迁移、回滚与交付

实现不强制重启存活 Runner。新绑定是兼容性增量，现有表与历史事件保留；不批量把 parked/awaiting_review 改终态。历史 CommDB running 残留按当前代次证据逐条收敛，未知清单显式留下。完成事件与已交卷节点不回滚。

回滚代码只影响以后探测；已提交死亡和通信回执不可撤销/复活。若新版探针有误，停止其新增死亡写入并交 Lead 处理；不得回放旧 pane 判死补账。通过现有可控部署/回滚流程交独立 updater，设计节点不操作服务。新 schema 的增量字段旧版本可忽略，死亡义务要保留以供恢复；部署前兼容性测试验证旧版本读取不崩溃。

设计节点交付：exploration.md、research.md、本 plan、Mermaid 源、最终 founder HTML（各节评论、路径隔离存储、汇总复制）、有效 design-review APPROVED、全部提交推送、静默发布并验证托管内容/CSP、向 Lead 报告 URL，然后 exact phase_design_complete 与 park。没有实现/生产验收完成的声明。

实现节点交付：六组改动、精确删除清单、九行 before/after 证据与相关回归；QA 节点补 529 真机验收。所有未知/未跑项显式列出，不能用“单测全绿”代替九单及专项验收。

## 10. 评审处置记录

R1 gate `15661cf1-6968-4f0c-b402-0f616d0ec462` / request `dc7b19ef-84d8-48a7-9286-1da87bb8cddd`：effective CHANGES_REQUESTED。唯一 HIGH `codex-inprocess-restart-gap` 在 §4.1 明确修复，新增真实运行时写点与四边界竞态负控。R2 gate `3a74d1a4-b2c6-438a-8812-2f6a88918e3b` / request `fc83e506-8079-4972-921d-ed4053010eb8` 在收到 R1 前已注册，现也返回 CHANGES_REQUESTED（同一 HIGH）；本次实质修订必须再提交新请求，不沿用旧 verdict。R2 新增 MEDIUM `commdb-retained-status-completed` 已改为镜像 failed/blocked/completed 等既有结局并保留具体原因，增加 runner-stopped reason=error 负控。

MEDIUM：消费者遗漏纳入 §3/§6 与后附映射；无后继 wake/TURN 以 §5 第 3 步具体 API 处置；writer 集合锚点与 probe budget 纳入 §4.2；现有 Kimi/Antigravity 纳入共用启动壳。LOW：binding 文件仅输入、accepted binding 入 StateStore；STATUSES 符号已纠正；代码测试未执行是设计阶段的诚实限制，后继需先安装仓库依赖，再跑列出的精确文件，不能把本轮文档检查当实现回归。

### 10.1 旁路消费者分组（R1/R2 medium 的落实）

以下调用不能笼统称“仅 UI”。`done-thread-reconcile.ts`、`state-store-ghost-reconcile.ts` 的状态/结账授权归 C；`close-runner.ts` 的实际收体准入归 E；`gate-poller.ts` stale-approved 判断与 `complete-failed-marker-reconciler.ts` 的失联处置归 B/F，保留原 ship approval 守卫。`post-merge.ts`、`done-thread-archiver.ts`、`terminal-thread-archive.ts`、`shipped-husk-escalation.ts` 的纯窗口定位/清理保留 UI 观察，但凡其 dead/gone 结果会触发收体、状态写、重唤醒或消息结账，授权必须共用 body observation；窗口缺失只能报告窗口缺陷，不能报 worker 死亡。全部属于本单，不以“后续再审计”推迟不变式。

`plugin.ts` 在本基线的三种窗口探针共有 16 处调用/注入（另有 3 处 import），逐处分组如下；实现必须用同一搜索命令附修后完整处置表，数量变化须解释。

| plugin.ts 基线位置 | 当前消费者 | 处置组 |
|---|---|---|
| 4402 | stale-session 展示与通知中的 tmux_alive | F：窗口字段保留，body 另取共同判据，通知不再用它推断体活 |
| 8078 | StateStore ghost 收账 | C：getProvenDeadTmuxTarget 不再是死亡授权 |
| 8278 | pane-loss reconcile | B：改共同 body probe |
| 9417 | Claude resident expiry probeTarget | D：共同进程证明，UI 清理另记 |
| 10546 | crash reaper | B/E：证死先收敛，UI 清理不 veto |
| 11241 | done-thread reconcile | C：所有状态/finalize 决策改 body proof |
| 11291 | terminal thread archive | C/F：收账授权改 body，纯窗口清理保留 |
| 11971 | external merge TURN-holder liveness | B/C：按 body，原 epoch/ship 权限保留 |
| 14228 | complete-failed marker recovery | B：移除窗口生死授权，保留 marker authority |
| 14298 | completion recovery discovered target | B：discovery 只定位 UI，恢复用 body |
| 14381、14383 | phase actor probeActorAlive 两个分支 | B：统一执行身份，不回退窗口或无行即死 |
| 14513、14517 | rework probeRegistered/probePersisted | B：两分支统一 body，保持 request/route fence |
| 15800 | fleet zombie scan | B/F：统一进程，ledger desync 另报 |
| 15846 | server-loss targetGone | B：服务重启不能直接 fail 活 worker |

搜索：`rg -n 'probeRunnerProcessLiveness|probeTmuxWindowLiveness|isTmuxWindowAlive' packages/teamlead/src/bridge/plugin.ts`。并全仓检索 `pane_dead|isSessionTmuxAlive|dead_pin` 审计被封装调用的返回值消费点；测试注入与纯 UI 使用逐条标清。增加每个有状态写入口的参数化反向 fixture：body alive/window absent → 零死亡或收账，body dead/window alive → body 终结，controller restarting → 零 gone；不只测 Heartbeat。
