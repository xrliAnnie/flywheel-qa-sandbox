# FLY-2211 codex runner 重启隔离 — 调研

Issue: FLY-2211 (https://linear.app/geoforge3d/issue/FLY-2211/引擎重启隔离-重启波会间接杀死-codex-runner工人窗不动但其-app-server-broker-随波死tui-失去传输后-10)
日期: 2026-08-31
基于: exploration.md

## 1. 现有原语盘点(能复用什么)

| 原语 | 位置 | 与本设计的关系 |
|---|---|---|
| detached daemon spawn + 单主锁 + SUN_LEN 短 socket(hash(execId) 决定,**跨重启稳定**) | `packages/claude-runner/src/codex-daemon-runtime.ts:66-75,577-915` | socket 路径可复原 ⇒ 新 Bridge 无需任何新状态即可找到每个 execution 的 daemon |
| 非破坏活性探针 `probeCodexDaemonLiveness`(socket 活 + 持久 pgid 组活的双证) | `codex-daemon-runtime.ts:209-214` | 快速死亡检测直接用它,不新造探针 |
| 孤儿收割 `reapOrphanPid`(两个独立 OS 事实门:lsof holder + ps pgid) | `codex-daemon-runtime.ts:636-716` | 同 execution 复活时清掉活孤儿的既有安全路径 |
| **同 execution 重入 = 官方预期形态**:「a re-execute of the SAME execution resumes the same thread with NO Bridge-side wiring」——adapter 自己从 session.json 读 threadId + daemonPgid | `packages/claude-runner/src/CodexTmuxAdapter.ts:981-996`(HIGH-4 注释) | 本设计主通路的地基:adapter 侧已备好,缺的只是"重启后没人 re-execute" |
| goal-runtime 中途 daemon 横死自愈:`daemon died mid-goal — restart n/m (rotating account) + resume thread` | `packages/claude-runner/src/codex-daemon-goal-runtime.ts:551-561` | 「被无痕杀手杀掉」在**有 runtime 在场**时本来就是分钟级自愈事件;修复归属断裂后此机制自动覆盖 G2 |
| TUI 重开链(restarts>0 时重置窗状态并 `startOpenChain()`;hold-lock、window 复用、fail-open) | `CodexTmuxAdapter.ts:939-959`;`codex-runner-tui-window.ts` | 复活后的工人窗恢复,零新码 |
| 持久 session 状态(threadId、daemonPgid、cwd、tmuxWindow) | `~/.flywheel/state/codex-sessions/<execId>/session.json`,写入点 `CodexTmuxAdapter.persistSessionState` | 重入所需状态的现有载体;缺 objective/kickText(见 §3 RQ2) |
| pane 活性 readopt / zombie 声明(detect-only,x2 连败) | `packages/teamlead/src/HeartbeatService.ts:1113-1200` | 现状死亡检测 9–19 分钟的来源;codex 会话要加 socket 探针提速 |
| 失败节点替换体(8-31 实测 5 秒内自动补发;新 exec/新 home/新 thread,从 progress+branch 续) | workflow 引擎(`workflow-replacement-lead-event.ts` 一族;FLY-2182 血统) | 兜底层已存在且工作;本设计不动它,只避免与 re-own 打架(§4) |
| 5 分钟维护 tick(单飞、detached) | `packages/teamlead/src/bridge/plugin.ts:7083-7220` | 快速检测与 watch 巡逻的既有载体,零新 timer |
| FLY-2169 orphan reaper(fail-closed,active 集合=readopt candidates) | `packages/teamlead/src/bridge/codex-runner-orphan-reaper.ts` | re-own 保持会话 running ⇒ reaper 继续跳过,无冲突 |

## 2. 关键代码事实(决定方案形状)

1. **dispatch 全链路只铸新 executionId**(`retry-dispatcher.ts:154-157` RetryResult.newExecutionId;FLY-245 successorExecutionId 也是预绑的新 id)。同 execution 重入没有 dispatcher 模式;launch claims、CommDB 注册、workflow activation 都按"新 id"假设。⇒ re-own 不能走 dispatch 管道,要做成**独立的启动期 reconciler 直接重入 adapter goal 循环**(S1),或者接受换体语义(S2,损失在飞上下文)。
2. **goal 与 agent loop 都在 daemon 侧**(goals_1.sqlite、`thread/goal/updated`),无主的体能继续自主干活、甚至能靠自己调 flywheel-comm 完成节点上报。Bridge goal-runtime 的增量职责 = 死亡自愈、超时/门等待管理、TUI 重开、teardown、transcript。⇒ re-own 的最小必要集是 **watch + revive-on-death**,attach(实时事件)是增强非前提。
3. **goal 事件按连接定向**(实测 `thread/goal/updated targeted_connections=0`,老 Bridge 连接死后 goal 事件发给空气)。⇒ 新连接能否收到既有 goal 的事件流是未知数,是 attach 增强的核心研究题(RQ1)。
4. **TURN 按 executionId 持有**(commdb-fsm-reconcile:`prune_skipped_turn_holder: <execId> owns the current TURN`)。S1(同 exec)天然保 TURN;S2(换体)需要 TURN 交接,是替换机器已处理但复杂度高的一支。
5. 击杀静默口现状:`createDefaultKillGroup` 的 logger 可选(`codex-daemon-runtime.ts:956-991`);`codex-daemon-teardown.ts` 不传 logger(有 StateStore 事件但无进程级信号账);tmux `killTmuxWindow`(`tmux-lookup.ts:863-898`)只在错误时打日志。⇒ 归因仪表要收敛出"先写账再发信号"的单一 helper。

## 3. 研究问题与答案/探针计划

**RQ1(attach 语义,研究门控)**:codex 0.151.0 `app-server --remote-control` 对第二个/后继连接暴露什么?
- 已知:TUI 作为第二客户端可连同一 socket 并收 item/turn 事件(8-31 全天实证);`thread/resume` 在 client 里注释为"same-account daemon-restart recovery path"(`codex-daemon-client.ts:427-429`),对**活**线程调用的行为未验证;goal 事件定向到发起连接。
- 探针计划(实现阶段第一步,半天):起一个 scratch daemon + 脚本客户端 A 发 goal;断 A;客户端 B 连入,依次探测 `thread/resume(活线程)`、goal 列举/订阅类方法(按 app-server JSON-RPC 表),记录能否 (a) 观察 goal 进度 (b) 接管驱动。结论只影响 M2 增强是否成立,不阻塞 M1。
- 若全部不可行:M1 的 watch 退化为「socket 活性 + rollout mtime 前进」两传感器,revive 时机 = 死亡或 rollout 停滞阈值。

**RQ2(重入上下文)**:同 exec 重入 adapter 需要哪些非持久状态?
- runGoal 入参里 objective/kickText 目前只活在 Bridge 内存(Blueprint 构建)。resumeThreadId/reapOrphanPid/gateHold 已持久。
- 方案:首次 dispatch 时把 objective(及 kick 已送达的事实)追加进 codex-sessions/<execId>/session.json(additive,一次写);re-own 重入时 thread 已含 kick,goal 已在 daemon(或随 thread/resume 恢复)——重入以「不重发 kick,不重 setGoal(除非新 daemon 需要)」为原则,细节进 plan 的 revive 序列。
- 备选(拒):从 workflow 引擎重构建 objective——引擎能重建,但把 revive 与引擎版本耦合,且 phase prompt 演进会造成重入语义漂移。持久化快照更老实。

**RQ3(reconciler 资格判定)**:哪些会话进入 re-own 集合?
- `sessions.adapter_type='codex-tmux' AND status='running'`(与 orphan reaper 的 active 集同源,天然互斥),且 workflow 节点未终局。已被替换体接管的(存在活的同 issue+role 后继)跳过并报告——8-31 型人工/引擎抢救优先。
- 探测顺序:socket 活(`probeCodexDaemonLiveness`)→ 活:进入 watch;死:立即 revive。

**RQ4(revive 与替换体互斥)**:revive(同 exec)失败次数封顶(复用 goal-runtime maxRestarts 语义)后,才把会话翻 failed 交给现有替换体机器。反向:zombie 声明保持不变作为兜底,但 codex 会话的 socket 探针会在它之前几分钟就触发 revive——需要一个 revive 单飞标记防止 zombie 声明与 revive 竞态(revive 中的会话 heartbeat 会被刷新,zombie x2 连败自然不满足,再加 zombieDeclaring 检查确认,plan 里给序列)。

**RQ5(归因仪表形态)**:
- kill-ledger:`~/.flywheel/state/kill-ledger/<yyyymmdd>.ndjson`,行 = {ts, source, signal, pid/pgid, execId?, reason};一个共享 `auditedSignal()`(claude-runner 导出,teamlead 复用;shell 侧给 scripts/lib 一个同名函数)。改造点清单(§2.5 的三处 + orphan/MCP reaper 已有账保持)。
- 死亡现场快照:goal-runtime onClose(re-own 后存在)+ zombie 声明处,采:精确时刻、socket/lsof 状态、`ps -o pid,pgid,etime,command` 中 exec 相关行、最近 3 个维护 tick 时刻。落 session_events(`codex_transport_death_snapshot`)。
- 明确非目标:不做 OS 级 signal sender 追踪(macOS 无 userland 通道;若下波再现且 ledger 干净,则升级为 eslogger/dtrace 专项单)。

## 4. 方案对比(供 plan 定稿)

| 方案 | 内容 | 取舍 |
|---|---|---|
| **S1:启动期 re-own reconciler(选定)** | watch(socket 探针 + rollout 前进)+ revive-on-death(同 exec、同 home、thread/resume 同线程、reapOrphanPid 清孤儿、TUI 重开)+ M2 attach 增强(RQ1 门控) | 满足「工人存活」验收:活 daemon 零接触;被杀分钟级同线程复活;TURN/会话行/worktree 绑定全部无痛。成本:新 reconciler + objective 持久化 + revive 序列的幂等细节 |
| S2:启动即换体 | 启动把 stranded running 翻 failed,交给现有替换机器 | 几乎零新码,但每次波都杀健康体、丢在飞上下文与未提交树(8-31 靠人工救树才零丢活),直接违背验收「存活」;仅作为 S1 revive 封顶后的既有兜底保留 |
| S3:只提速检测不 re-own | socket 探针进 heartbeat,死了走替换 | 修不了 working-dead 搁浅与上下文损失;拒 |
| issue-A(不杀名单) / issue-B(TUI 重连) | 见 exploration §4 | 分别因"凶手未点名无挂靠"与"死因不是超时退出+上游二进制"不对症;A 的精神并入 RQ5 审计收敛 |

## 5. 风险与开放问题

1. RQ1 结论未知 ⇒ M2(attach)可能整体不成立;设计已把它隔离为增强,M1 不依赖。
2. 同 exec revive 与 launch-claim/admission 的交互:revive 不走 admission(不新增体,资源占用不变),但要确认 lifecycleLaunchGuard 对既有 exec 的 activate/commit 状态是幂等可重入的——plan 列为实现期核对项。
3. 无痕杀手若专杀"无主进程",re-own 后它可能不再触发(8-31 替换体全存活的旁证);若它连有主进程也杀,revive 自愈 + kill-ledger 归因,损失被压到单 turn。
4. objective 持久化引入 prompt 快照落盘:内容与 agentContent 同敏感级,放 0700 的 codex-sessions 目录,与现有 session.json 同权限;不进 git。
