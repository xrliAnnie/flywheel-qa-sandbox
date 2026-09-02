# FLY-2211 codex runner 重启隔离:re-own + 快检 + 击杀归因 — 实施计划

Issue: FLY-2211 (https://linear.app/geoforge3d/issue/FLY-2211/引擎重启隔离-重启波会间接杀死-codex-runner工人窗不动但其-app-server-broker-随波死tui-失去传输后-10)
日期: 2026-08-31(round 5,吸收 Codex R1 3B+5H、R2 3B+3H+1M、R3 4B+1H、R4 4B+1H;R5 为 Lead 裁定的终局轮)
基于: exploration.md, research.md

## 0. 目标与验收

目标:Bridge 重启波之后,在飞 codex 工人(TUI + detached app-server daemon)不再变成无主进程 —— **gate-free running 活体**零接触看护(parked/gate-held 活体走有意的带账 recycle);死体在一个维护节拍内以**同 execution、同 thread、重发同一 kick**(现行已验证的 proven-dead restart 合同)复活;所有 flywheel 侧 runner 相关杀伤动作先写账再发信号。

验收(按 cohort 拆分,Codex R3#5——parked/gate-held 的有意 recycle 与 gate-free 的零接触是两种合同):
- A1 真机重启波后:
  - **gate-free running+alive cohort**:daemon **pid 不变**、rollout 持续前进 ≥30min(零接触);
  - **parked / gate-held cohort(波时活体)**:同 execution、同 thread、新 daemon pid、paused/park 态完整重建,且**恰好一次**带账 recycle;波时已死的 parked/gate-held 走 revive,无 recycle 信号可计(Codex R4#5);
  - 波后让一个工人自然完成其节点 ⇒ 该节点经 flywheel-comm 通路**恰好推进一次**。
- A2 谋杀演练:波后手工 `kill -9 -<pgid>` 一个 gate-free 工人 daemon 组 ⇒ **≤1 个维护节拍(5min+抖动,上限 6min)**内同 thread 复活(新 daemon、同 socket、同 execution、同一 kick 重发),TUI 窗自动重开,rollout 继续;断言**无第二 execution 诞生、无双 daemon 并存、CommDB TURN holder 不变**。(≤2min 需 M5 attach 实时 close 通知,attach 落地前不承诺。)
- A3 kill-ledger:范围与 M4 fixture 的 **mutation 条目**同义(signal-0 probe / QA-only / out-of-scope 单列不计);演练窗口内每个 mutation 信号有先行账目;波本身 **计划外** runner 侧信号数为 0,计划内 `reown_parked_recycle` 信号单列计数并逐一有账。
- A4 codex 会话 daemon 死亡 → 被**唯一死检 owner**(re-own reconciler)察觉并触发 revive ≤1 个维护节拍(现状 9–19 分钟)。

## 1. M1 — 启动期 codex re-own reconciler(核心)

新文件 `packages/teamlead/src/bridge/codex-session-reown.ts`,startBridge 完成 run-infra 后先跑一次 boot pass,此后 watch 挂现有 5 分钟维护 tick(零新 timer)。**boot pass 固定排在首次 orphan sweep 与首次 heartbeat zombie pass 之前**(顺序进测试)。

资格集(Codex #4):对**同一次** `store.getReadoptCandidateSessions()` snapshot(状态集 running/ship_parked/awaiting_review/design_done/approved_to_ship,与 FLY-2169 reaper 的 active 集**同一来源同一快照**)过滤:
- `adapter_type='codex-tmux'`;
- 该 execution 仍是当前 workflow run+node+attempt 的 binding(非最新 dispatch ⇒ `reown_skipped_superseded`);
- 529/test-slot 项目排除。

**第 0 维:本 Bridge 已拥有者先出列**(Codex R4#3 —— `getReadoptCandidateSessions()` 会返回新派发与已被 rescue 的行,不加此维会把刚救活的执行体在下一个 tick 再杀一遍,并与活 owner 的内建 restart(`codex-daemon-goal-runtime.ts:551-560`)互相踩):run-infra 的共享 registry 同时接收首派与 rescue 两种 handle,暴露 `isExecutionOwned(execId)`;ownership 只在 owner 的最终 cleanup 里移除;**owned 的执行体留给其现有 runtime,reconciler 永不 recycle/revive 它**。并发 Bridge 进程按 Lead 裁定**不造 durable instance lease**:本设计显式记录「单 Bridge 排他」为架构假设(与 restart-services 的单 Bridge 定位、launchd 单 label 一致),该假设本身进测试(双 boot 测试改述为「同一 Bridge 进程内 boot pass 与 periodic pass 并发」+「假设失守时 recovery claim 的 CAS 仍保证单胜者」)。

其余候选按 **workflow 姿态 × daemon 活性 × gate 姿态** 分派(Codex R2#2 —— parked 的 wake/hold 驱动在 Bridge 内的 phase controller 循环里,Bridge 死后活 daemon 会永久停在 paused,watch-only 覆盖不了 parked):

| 姿态 | daemon 活 | daemon 死 |
|---|---|---|
| running·**gate-free**(goal 自驱,完成经 flywheel-comm 上报,不依赖 Bridge 侧 goal 循环) | **watch**(每 tick:socket 活性 + rollout mtime 双传感器,零接触) | **revive**(§2) |
| running·**gate-held / open gate**(Codex R3#2:durable gate fallback 的 latch/pause 与 marker 解决后的 active 迁移都由 Bridge 侧 goal 循环拥有,`codex-daemon-client.ts:1016-1101,1333-1345`,不能 watch-only) | **归属恢复**:审计式 recycle(M1–M4 主路径)或 attach(M5 落地后) | **revive**(gateHold latch 随 §2 恢复) |
| parked(keep-alive phase:wake 消费需要 Bridge 侧 controller) | **审计式 recycle**:见下方固定顺序 → 同 thread rescue owner 复活回 parked 等待态(phase lifecycle 完整重建) | **revive** 回 parked 等待态 |

审计式 recycle 的固定顺序(Codex R3#5,与 `codex-daemon-runtime.ts:632-712` 的 fail-closed 门一致):持有 recovery claim → 双 OS 事实证明活 socket holder 属于持久 PGID(lsof+ps)→ ledger append+fsync → 发信号 → 证明 socket 与进程组双亡 → 才 spawn。periodic pass 对 boot 后**新出现**的 gate episode 同样按上表升级处置(不是只在 boot 分类一次)。

unknown ⇒ 不动手,连续 x2 升级 Lead 告警。**reconciler 是 codex 会话唯一的死检 owner**(Codex R1#6):不在 HeartbeatService 里加第二套 socket 探针;既有 pane-probe zombie 声明保留为终极兜底,但与 revive 用同一 authority fence 互斥(§3)。

事件账(session_events,source=`bridge.codex-session-reown`):`reown_watch_started / reown_revive_started / reown_revive_succeeded / reown_revive_failed / reown_skipped_superseded / reown_probe_unknown / reown_fence_lost`。

## 2. M2 — rescue owner API 与 revive 序列(Codex #1/#2)

### 2.1 持久化前置(首次 dispatch 时一次写,additive)
`CodexTmuxAdapter` 在构建 runGoal 入参处把**精确 `objective` 与精确 `kickText`**、launch 上下文摘要(sandbox writable roots、effort、appsApprovalMode)追加进 `~/.flywheel/state/codex-sessions/<execId>/session.json`(0700 目录,与现有同权限,不进 git)。旧会话缺字段 ⇒ 拒绝 revive + 告警(负防护,不瞎猜 prompt);一代班车波后自然消失。

### 2.2 revive 协议 = 现行 proven-dead restart 合同,显式 **at-least-once** kick 语义(Codex R1#1 / R2#1)
显式采用 goal-runtime 已被测试锁死的合同(`codex-daemon-goal-runtime.test.ts:279-306`):确认旧进程组已死(reapOrphanPid 双 OS 事实门)→ 新 daemon 绑同一 socket → `thread/resume` 同 thread → **`goal/set` + 重发同一 kick(kickText 逐字节相同)**。kick 交付语义**明确定为 at-least-once**:daemon 已接受 kick 而 Bridge 在 receipt 前崩溃 ⇒ 下次 revive 会再发同一 kick,thread 历史里 kick 重复出现是可接受的既有形态;crash 测试据此断言「不产生第二 execution/owner/daemon;kick ≥1 次且每次字节相同」,**不承诺 exactly-once**(exactly-once 需要 durable kick operation id + 查询式 adopt,归 M5 研究门控)。「绝不 re-kick 的 adopt 模式」同归 M5,不在本单承诺。
TUI:`onThreadReady` 每次都会启动 open chain(首次 spawn `restarts=0` 同样开窗;`restarts>0` 分支只是重置窗状态以便重开)——表述修正,进单测断言。

### 2.3 rescue owner:`resumeExistingExecution`(adapter/run-infra 边界的新入口)
裸调 goal-runtime 会绕开 adapter 的其余职责(credential/CODEX_HOME、sandbox roots、CommDB 注册、gate deadline watcher、heartbeat、phase lifecycle、TUI/transcript、终态 cleanup;`CodexTmuxAdapter.ts:548-670,910-1355,1727-1798`),直接重跑 Blueprint 又会重复 `emitStarted`。因此在 `CodexTmuxAdapter` 上新增显式入口 `resumeExistingExecution(ctx)`:
- **可信输入 = 显式 rehydration matrix**(Codex R2#5,实现时逐字段落表并进负例测试):
  - 来自 **session 行 / workflow 快照**(可变权威):worktree、plan_path、issue/labels、model、phase role(chat_thread_role)、skill-framework arm、capabilities/agentContent digest、CommDB/state DB/progress 路径、lead/team/agent 身份、timeouts;
  - 来自 **session.json 不可变 launch 快照**:threadId、daemonPgid、objective、kickText、gateHold、sandbox roots、effort、appsApprovalMode;
  - **绝不持久化、按同 run/node/attempt binding 重新签发**:output/submission credentials(一次性凭据按现行签发路径重铸;无法安全续发 ⇒ spawn 前 fail-closed);
  - 任一必需字段缺失或与 workflow binding 漂移(capability digest / model / phase role / skill arm 不一致)⇒ 拒绝 revive + 告警,零副作用。
- **复用 execute() 的全部资源绑定路径**(credential 按上表重铸、CODEX_HOME 校验、CommDB re-register(幂等 upsert,不新建行)、heartbeat、gate watcher、phase lifecycle、TUI、transcript);**跳过** session 行创建与 `emitStarted`(会话已 running;禁止把 failed/replaced 写回 running —— fence §3 保证)。
- **启动 commit 点**(Codex R2#1→R3#1 两次修正定稿):现有 `onGoalActive` 在 `goal/set` 后、`startTurn` 前触发且回调异常被吞(`codex-daemon-client.ts:1103-1130,1270-1275`),**不能**用作恢复提交点。新增一个**硬性、awaited 的 recovery commit seam**:running revive 在 `startInitialTurn` 返回 receipt/turn id(或权威 terminal 响应证明 kick 已被接受)**之后**提交;提交失败必须向上传播并触发 cleanup(不允许吞异常);daemon 已接受 kick 而崩溃发生在 receipt 前的窗口,按 §2.2 的 at-least-once 合同覆盖。parked recycle/revive 的 commit = paused goal 与 phase controller **双确认后**的同等硬 seam。fence 复验(§3)发生在 commit 事务内。此前任何失败都走 cleanup(杀掉刚 spawn 的 daemon 组、释放锁)不落任何状态变更。
- **终态出口** = 现有 canonical 路径:generalized 执行走 `recordEnrolledTerminalSignal`(经 DirectEventSink 同一事务含 leadIntent);legacy 会话走既有 emitCompleted/emitFailed 等价接线 —— rescue owner 持有的完成/失败与首派完全同路(Codex #2/#5)。
- **Bridge shutdown 行为**:rescue handle 注册进现有 drain 集合;bounded-shutdown 下与首派 runner 同等 drain,force-exit 后 daemon 照旧 detached 存活,下次 boot pass 重新接管(结构上就是本设计的稳态循环)。

### 2.4 revive 预算(Codex R1#5 / R2#1 / R2#4)
预算**按 recovery episode 计,且数据模型 crash-atomic 地活在 StateStore**(Codex R3#4→R4#4 定稿):episode(episode_id/state/attempts)存于 `recovery_claim` 表(§3);**claim 获取 + attempt 预占 = 一个 StateStore 事务**(spawn 之前);**成功 recovery commit 在递增 `lifecycle_revision` 的同一事务里 close/reset episode**;TTL 接管**延续同一 open episode**(不重置计数);session.json 只保存不可变 launch 快照,不再承载任何预算计数。episode 内封顶 N=2;runtime 内部 `maxRestarts`(默认 5)只作用于单个 owner 生命周期内的 transport 级重启,两层预算独立、各自入账。测试含双向不变量与两个 crash barrier:≥3 次成功班车波不烧穿同一 parked 执行体;单 episode 内反复 pre-commit 崩溃仍封顶;崩在「attempt 预占后」与「成功事务后、任何文件镜像/cleanup 前」各一测。封顶终局:**generalized 执行**用确定性 source event id(`reown-exhausted-<execId>-<attempt>`)走 `recordEnrolledTerminalSignal(signal:'failed', leadIntent)`,失败语义以**新增共享 `failureKind:'reown_exhausted'`** 承载(扩展 `packages/core/src/adapter-types.ts` 的 TerminalFailureKind、normalizer 与 DirectEventSink —— 现行 API 只保留 `codex:unauthorized` 一种 failureCode,裸传字符串会被静默丢弃,Codex R2#4;round-trip + idempotent-conflict 测试保证 event payload 与 workflow teardown fact 均能读回);这是替换体机器的**唯一**合法入口,裸 `applyTransition/forceStatus` 不产生 replacement intent。legacy 会话走既有 zombie 同款终局 API。

## 3. M3 — recovery authority fence(Codex R1#3 / R2#3:token-bound、release 必须使旧读失效)

StateStore 原子原语组(单表 `recovery_claim`,兼任 mutation lease 与 episode 账本:execution_id PK、claim_token、holder、acquired_at、expires_at、**episode_id、episode_state(open|closed)、episode_attempts**;Codex R4#4 —— attempts 放 session.json 会在「StateStore 成功提交 ↔ JSON 复位」之间的崩溃里假烧穿下一个健康波,故预算数据**只**活在 StateStore):
- **acquire**:`claimCodexRecovery(executionId, expectedLifecycleRevision)` → 事务内 CAS lifecycle_revision + 写入带随机 token 的 claim(TTL > 最坏 spawn+setup 时间,支持续租);当刻存在进行中的 zombie/terminal 变更 ⇒ 拒绝。
- **commit**(revive 成功,提交时点 = §2.3 的**硬 awaited seam**,即 `startInitialTurn` receipt 之后;Codex R4#1 清除旧 onGoalActive 残留):StateStore **单库事务**内只复验 **StateStore 事实**(session status/lifecycle revision、当前 workflow run+node+attempt binding、latest launch ordinal、launch claim 仅 absent-by-contract 或 active、无 successor)加上**事务前按 mutation lease 协议捕获的 CommDB TURN holder 观测值**(见下条,不假称跨库原子)→ **递增 `lifecycle_revision`** → 刷新 liveness → 清 claim。递增是关键:claim 前读到旧 revision、期间被推迟、release 后重试的 zombie/replacement 变更会因 revision 已前进而自然落败——「等 claim 过期」本身不构成权威。测试必须**调用真实 seam 本体**(不是断言其位置描述),防实现回退到 onGoalActive。
- **abort**:token-bound 清 claim,零状态副作用(先 stop+drain 刚 spawn 的 daemon)⇒ `reown_fence_lost`。owner crash ⇒ TTL 过期后可被接管(进测试)。
- **消费方合同**:`declareZombie` 的 transition、terminal signal/replacement eligibility 与 enrollment 的**每次实际变更**都必须携带 observed revision 并在事务内复验「无活跃 claim + 仍是当前 binding」;不允许仅在外层等待。in-memory `zombieDeclaring` 不作为跨组件依据(HeartbeatService 私有内存集,TOCTOU)。
- **统一 per-execution mutation lease**(Codex R3#3→R4#2 定稿——「writer 只 check fence」有 TOCTOU,「writer 持锁 + 中间插入转移成功」又自相矛盾,故合并为**一把锁**,这是净简化):`recovery_claim` 表升级为通用 **execution mutation lease**;TURN grant/transfer 写方(现盘点:`workflow-turn-bundle.ts:25`、`workflow-rework-coordinator.ts:48`、`workflow-ship-carrier-coordinator.ts:31`、`plugin.ts:9715`,实现期机械扫描定稿)对当前 holder execution **原子获取同一把 lease,持有它跨越 CommDB 变更与 StateStore 投影,推进 observed revision 后才释放**;recovery 从 pre-spawn 预占起持同一把 lease 直到 commit/cleanup。两个合法序都进测试:writer 先到 ⇒ recovery 在 spawn 前落败;recovery 先到 ⇒ writer 等待/落败直到 recovery commit 并推进 revision。另测 writer 崩在「CommDB 已变更、StateStore 投影未落」中间:lease 过期后 recovery 必须看见 holder 不一致而 abort,由现有 source-event replay/projector 修复投影。旧 §6.10「转移恰好插在读与 commit 之间」的措辞废弃(在单一 lease 下该交错不可能发生,以两合法序测试取代)。
- barrier tests(§6):replacement 落在 preflight 后、TURN 在 spawn 中转移、zombie 在 commit 前声明、双 Bridge boot 同抢同 exec、**旧 waiter 在成功 release 后仍必须输**、**owner crash→TTL 接管** —— 每个竞态恰好一方胜出且败方零副作用。

## 4. M4 — kill 路径审计收敛(Codex #7)

- `auditedSignal()`(`packages/claude-runner/src/kill-ledger.ts`;shell 版进 `scripts/lib/`):**typed result;默认 fail-closed —— ledger append+fsync 失败则不发信号**;仅显式标记的 forced-shutdown 调用点(如 restart-services 的 Bridge KILL 逃生线)允许 fail-open,且必须写 stderr fallback receipt 并在 A3 断言中单列。
- 账目 schema:`{ts, source, signal, targetKind:'pid'|'pgid'|'tmux-window', target, execId?, reason, schemaVersion}`;NDJSON O_APPEND 单行写,目录 0700;Node/shell 两实现 schema parity 进测试。
- **入口清单 = 机械扫描基线 + 人工分类,入库为测试 fixture**(Codex R2#6):实现第一步对 production roots(packages/、scripts/、packages/teamlead/scripts/)机械扫描 `process.kill`/`child.kill`/shell `kill`/`tmux kill-window|kill-session` 全部命中,逐项分类为 mutation / signal-0 probe / QA-only 并写入 committed fixture;CI 对比扫描结果与 fixture,**任何未分类新增即失败**。已知必入清单(R1+R2 并集):`codex-daemon-runtime.ts`(killGroup/killPid/默认 seam)、`codex-daemon-teardown.ts`、`codex-runner-orphan-reaper.ts`、`mcp-descendant-reaper.ts`、`codex-runner-tui-window.ts:1023-1041`、`TmuxAdapter.ts` 与 `Blueprint.ts:2935,3064,3088-3091` 的 kill-window 位点、`tmux-lookup.ts killTmuxWindow`、`post-merge.ts`、`edge-worker/src/worktree-process-reaper.ts:150-175`、`scripts/hooks/runner-stop-notify.sh:40-60`、`scripts/lib/codex-guard.sh:126-205`、`packages/teamlead/scripts/lib/reap-orphan-adapters.sh:303-327`、services 重启脚本的 Bridge TERM/KILL。范围声明(与 §0 A3 逐字一致,Codex R4#5):A3 覆盖范围 = 该 fixture 中分类为 **runner-affecting mutation** 的条目;signal-0 probe / QA-only / out-of-scope(如 chrome-reaper)在 fixture 里显式分类但不计入 A3 断言。
- 死亡现场快照:goal-runtime transport onClose + zombie 声明两处,采精确时刻、socket/lsof 状态、exec 相关 ps 行、最近 3 个维护 tick 时刻 → session_events `codex_transport_death_snapshot`。

## 5. M5 —(研究门控)attach / adopt 模式(零 re-kick、kick exactly-once)

实现期第一步半天真机探针(scratch daemon + 双客户端):后继连接能否观察/接管活 goal(`thread/resume` 对活线程的行为、goal 列举/订阅、durable kick operation id/receipt 的可行性)。成立 ⇒ watch 升级为真连接(实时 close 通知使 A2 收紧到 ≤2min;活体零 re-kick adopt、kick exactly-once 成为可选模式;parked-alive 可免 recycle 直接接管);不成立 ⇒ 记录结论,维持 M1–M4 交付形态。不阻塞主体。

## 6. 测试与证据(Codex #8)

单元/集成(注入 seam):
1. 资格集:superseded / 529 slot 排除 / unknown fail-closed / **姿态×活性×gate 三维分派表**逐格判定(含 boot 后新出现 gate episode 的升级);
2. revive 协议:kickText 逐字节重发合同;setGoal→turn/start→receipt 各 crash 点 —— 断言 **at-least-once**(无第二 execution/owner/daemon;kick ≥1 次且每次字节相同),不断言 exactly-once;recovery commit seam 在 startInitialTurn receipt 之后、提交失败必须传播并 cleanup;
3. **拆分两个独立状态的测试**(Codex R3#2:`clearGateEpisode()` 进 phase hold 时会清 gate latch,两态不可合并):(a) running + open-gate 跨 Bridge restart 的归属恢复;(b) parked-phase 跨 Bridge restart 的 rescue owner 重建;另加 parked-alive 审计式 recycle 全序(claim→双 OS 事实→ledger append+fsync→signal→双亡证明→spawn);
4. fence 四竞态 barrier tests(§3);
5. orphan reaper 在 revive 前/spawn 中/thread-ready 后的 active recheck 一致性;
6. revive 后自然完成 ⇒ 经 canonical terminal path 恰好推进一次;
7. kill-ledger:并发 writer、append 失败 fail-closed、forced-shutdown 例外单列、Node/shell parity、清单 fixture 防漂移;
8. `onThreadReady(restarts=0)` 开 TUI 窗断言;
9. revive 预算:episode 内跨两次 Bridge 崩溃仍封顶、≥3 次成功班车波不烧穿同一 parked 执行体、terminal receipt 重放幂等、replacement 恰好派发一次;
10. mutation lease 序测试(替代旧「插入交错」措辞):writer-first ⇒ recovery 在 spawn 前落败;recovery-first ⇒ writer 等待/落败至 revision 推进;writer 崩于 CommDB 变更后投影前 ⇒ lease 过期后 recovery 见 holder 不一致而 abort、replay/projector 修复投影;
11. ownership 维度:成功 rescue / 新派发后,连续多个 periodic tick 不改 PID、不追加 recycle 账行、不产生第二 owner;单 Bridge 排他假设失守时 recovery claim CAS 仍单胜者。

真机(QA 节点执行):A1/A2/A3 按 §0;负例:关 `codex_reown_enabled` flag 重跑谋杀演练 ⇒ 回现状路径(zombie→Lead 裁量),证明 flag 是真实回滚边界。529 stub 房测不到 A1(真 launchd/tmux 全舰语义),QA 以真机窗口执行并遵守 alerts 隔离配方。

## 7. 稳定标识/迁移/回滚

- 标识:source=`bridge.codex-session-reown`;共享 `failureKind:'reown_exhausted'`(§2.4);last_error 前缀 `reown:`;kill-ledger source 短名固定。
- 迁移:全部 additive(session.json 新字段、session_events 新类型、NDJSON、`recovery_claim` 新列/表 + lifecycle_revision CAS 复用现有列);旧会话负防护拒 revive。
- 回滚(Codex R2#7,按仓库唯一 flag authority 落地):`codex_reown_enabled` 注册进 flywheel-config 的 `FEATURE_FLAGS` registry(scope=global、default=**off**、toggleable),新增 `storeCodexReownEnabled()` resolver,boot pass 与 periodic pass **read-on-use** 同一 authority,纳入现有 feature-flag drift suite。发布策略:随班车部署后保持 off,真机 A1/A2 演练通过后由 Lead 翻 on;关闭即回现状。kill-ledger 无 flag(纯账目)。
- 自托管:合并与部署分离,仅 updater 窗口部署;本单不请求 ship。

## 8. 失败路径(显式)

| 失败 | 处置 |
|---|---|
| revive 预算封顶 | canonical enrolled terminal(`reown_exhausted`+leadIntent)→ 替换体机器;legacy 走既有终局 API |
| session.json 缺 threadId/objective/kickText | 拒绝 revive + Lead 告警 |
| fence 复验失败 | stop+drain 刚 spawn 的 daemon → `reown_fence_lost`,零状态副作用 |
| probe unknown 持续 | 不动手,x2 后 Lead 告警 |
| ledger append 失败(非 forced-shutdown 点) | **不发信号**,告警(fail-closed) |

## 8.5 R5 非阻塞实现注记(Codex 终审附带,属已批合同的实现解释、非新增范围)

- ownership 注册必须发生在对应 session 对 periodic candidate scan 可见**之前**;获取 recovery lease 前与执行破坏性 recycle 前都要**再查一次** `isExecutionOwned(execId)`。
- 单 Bridge 排他假设是真正的跨进程安全边界;recovery-claim CAS 保证的是**单次获取竞争只有一个 lease holder**,不是 commit 之后的持久 owner lease。

## 9. 明确不做

追杀未知杀手本体(仪表点名)、codex 二进制/TUI 行为、cxc companion broker 生命周期(另立卫生 issue)、claude vendor runner、HeartbeatService 第二套 socket 探针(单一死检 owner)、非 runner 信号的 ledger 覆盖。
