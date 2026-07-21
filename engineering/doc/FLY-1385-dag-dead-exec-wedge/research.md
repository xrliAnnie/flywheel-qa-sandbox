# FLY-1385 死 exec 永久楔死 DAG node — 调研
Issue: FLY-1385 (https://linear.app/geoforge3d/issue/FLY-1385/bugdag引擎-死-exec-永久楔死-node失败无-completion-receipt-teardown-held-node-卡)
日期: 2026-07-20
基于: exploration.md

## 0. Scope 汇总(brainstorm gate 后的完整清单)

exploration §4 的五个修复面 + Lead gate 裁定 + Linear comment 追加,合计 **7 个工作面**:

| # | 面 | 来源 | 裁定 |
|---|----|------|------|
| 1 | reconcile 识别死 exec + node 自动重试 | issue 正文 | sweep 为主、事件驱动只作加速器;attempt=3 + backoff;超限 run→held+告警 |
| 2 | held teardown 出口 | issue 正文 | session 已 terminal + 探针双阴 ⇒ 交回滚域;探不准继续 hold+告警 |
| 3 | run 管理 API(hold/terminate)+ guard 文案 + `terminated` 合法化 | issue 正文 + defect 归档① | master/Lead auth + 强制审计 event(actor/reason/时间) |
| 4 | 影子 run 不占 one-active-run 锁 | issue 正文 | 本单只做锁收窄;影子生命周期重构 defer,但需最小终态语义,不许永生 husk |
| 5 | worktree takeover 允许 fast-forward | issue 正文 | 本单做,严格 merge-base ancestor + clean 双条件,一行不多;要动 binding guard 更多面就拆单 |
| 6 | 删 `FLYWHEEL_WORKFLOW_FORCE_LEGACY` 死 flag | Annie 追加(Linear comment) | 直令;env 行已手工删,代码清理归本单 |
| 7 | vendor-at-dispatch(快照只锁形状,vendor/model 派发时刻解析) | Annie 追加(Linear comment) | 方向认可;**实施前设计稿给 Annie 过目** |
| — | node 终态与 session 终态一致或显式记 divergence | defect 归档② | 验收 fixture 必含 |
| 8 | 混 schema 入口语义补齐(v2 keyless key 合成 / v2+flag off 行为 / v2 auth 面 / no-three-stage 引擎内短路) | Lead design 阶段增补(FLY-1396 Codex 评审抓到,Lead 代码核实,inbox e317d1c6 + 09b153ad) | 是 1396 rollout 链(1380 只建不迁 → 本单 → 迁 binding → 开 flag)的前置 gate;与面 4 同属 selection 语义合并设计;不挂 1396 的 cutover 开关 |
| — | 全单流程硬门 | Annie 直令 | **先出「之前/现在/改后」对照图设计稿 → Annie 批准 → 才动代码** |

协调点:HL 的 FLY-1396(work-kind→模板 binding derive)动同一条 runs-route 派发链;本单 diff 与 selection/binding 逻辑保持正交。

## 1. 生产 DB 取证(`~/.flywheel/teamlead.db`,只读,2026-07-20 采)

### 1.1 五个事故 run 的三本账

| run | issue | run.status | engine | current_node | node 状态 | 绑定 exec | session 真相 |
|-----|-------|-----------|--------|--------------|----------|----------|--------------|
| 3d5a5164 | FLY-1335 | held(手工) | 1 | implement | **running** | 70948f7f | **failed**(zombie @38, 08:36) |
| 42783f7f | FLY-1356 | held(手工) | 0 影子 | design(未跟进) | implement **running** | 41e10dab | **failed**(worktree_takeover_failed) |
| 630728fd | FLY-1335 重开 | **held(复发!)** | 1 | implement | **running** | eac8fcfe | **failed**(zombie @43, 09:28) |
| f1f77c2f | FLY-1356 重开 | **held(复发!)** | 1 | implement | **running** | 578fd285 | **failed**(zombie @44, 09:58) |
| 8c4a01dd | FLY-1378 | terminated(手工) | 1 | founder_gate | qa **done** | 6ebb58f1 | **failed**(tmux server lost,次日 07:46) |

**核心发现 1(复发铁证)**:昨晚手术后重开的两个新 run(630728fd/f1f77c2f)的 implement exec 在 ~21-23min 后**再次 zombie、再次楔死**。wedge 修复(重试)只治"卡死不恢复";必死根因(codex 配额封顶 × 快照烤死 vendor,Annie comment ⑦)不除,attempt=3 也只是 held 得更快。**面 1 与面 7 是同一事故的两半**。

**Annie 2026-07-21 最终裁决(实施权威)**:当前配置(`DEFAULT_PHASE_DISPATCH`/当前 published template)继续决定模型,禁止盲目自动切换;quota/billing/auth 死亡立即 held+告警,不走三次重试;唯一自动 fallback 是 design Fable 不可用 → GPT-5.6,并同步告警;replacement allowlist 为 `{Fable, GPT-5.6}`,其他替补拒绝+告警;vendor-at-dispatch 按「当前配置 → snapshot 兜底 → `FLYWHEEL_VENDOR_AT_DISPATCH=0` 紧急回 pinned」实施。

**核心发现 2(divergence 分两类)**:8c4a01dd 的 qa node=done 是**真实完成**(event log:`claim_written{predicate:qa_passed}` + `node_completed{outcome:qa_pass}` + `gate_opened`,均 2026-07-19 19:40:51)——session 是**次日早**因 tmux server lost 被翻 failed。与 1335 型(running node 的 exec 死)本质不同:
- **A 类:node=running + exec 死** ⇒ 工作没做完 ⇒ 回滚 + 重试(面 1)。
- **B 类:node=done + session 事后死** ⇒ receipt 是权威,node 不回滚 ⇒ 只记 divergence event(defect ② 的"或显式记录 divergence"分支)。8c4a01dd 真正的 wedge 是 flag=0 回滚窗内 founder_gate 无法 converge 且无 operator 终结机制(defect ①→面 3)。

**Annie 2026-07-21 A 加强版裁决(增量)**:dead-exec sweep 必须 default ON,但开关在每次 reconcile tick 现场读取,允许控制台免重启直关/直开。每次成功换人后必须留下 durable 旧 execution watch；旧 exec 后续出现 execution-bound 的 commit marker、session commit 或 CommDB 写入才实锤误判并同时投递 issue thread 与 Lead escalation chain。tmux 输出因物理窗口可被替补复用,只保留 diagnostic log,不作为 severe page 依据。相同 run/node/attempt 第二次死亡仍告警。信号不确定时保持观察；基线无法建立时不得先换人；watch 在 run 终态立即收敛,否则以 24 小时 TTL 有界清理。

### 1.2 手工先例(面 3 的语义参照)

- 1335/1356 型:`UPDATE workflow_run SET status='held'` —— 借 loop-limit escalation 语义(停给人裁,可再 /start 新 run)。
- 8c4a01dd:`status='terminated'` + append `run_terminated` event(payload 含 reason/actor)—— 工作未 ship 不造假 completed。生产 event log 已有 `run_terminated` kind 先例(seq 17)。

## 2. 机制清单(代码级,全部本次审计核实)

### 2.1 事件/投影层
- `DirectEventSink.emitFailed`(:1115-1125)/`emitCompleted`(:505-515)/`event-route.ts:663-692`:enrolled + 无 receipt ⇒ held 早退,session 终态与 session_failed 事件都不落(HTTP 侧回 409 `workflow_completion_receipt_required`)。
- `observeEnrolledTeardown`(StateStore:15584):二元(有 receipt 投影 / 无 receipt hold),**无出口条件**。
- `applyTransition`(applyTransition.ts:42-83):FSM 校验后 `persistTransition` **直写 session status**,不问引擎。zombie 声明(`HeartbeatService.declareZombie` :1341-1450)走此路 ⇒ 三本账脱钩的写入点。
- `commitEnrolledCompletion`(StateStore:15446):receipt 唯一写入点;route 必须等于 node 能力的 `completion_route`(只有 `phase_design_complete|needs_review|no_code`,workflow-run-snapshot.ts:257-261)⇒ 冒名 `--route blocked` 必然 `route_mismatch` 409。

### 2.2 引擎/账本层
- dispatch ledger 状态机(StateStore:18540-18550):`intent_recorded → launch_committed → started(terminal)`;`intent_recorded → abandoned`(仅 pre-commit 阳性失败);**launch_committed 永不能 abandon**。"Rows record launch HISTORY, not liveness"。
- `listNonTerminalWorkflowSideEffects`(:18128):只回 `intent_recorded|launch_committed` ⇒ started 死 exec 引擎失明(子形态 A)。
- `consume()`(workflow-engine-dispatcher.ts:199-202, :328-331):`getSession(execId)` 存在即 markStarted,不看 status(子形态 B)。
- `markStarted`(:147-176):无条件 upsert node (running, intent.execution_id)(除 done 外)——**无 supersession 防护**:若回滚后老 intent 再被消费,会把 node 的新 execution_id 顶回老死 exec。回滚设计必须配套"最高 ordinal 才可消费"守卫。
- `holdStrandedGeneralizedExecutions`(:15221-15255):启动安全网对 engine_owned=1 整体跳过,注释假设"dispatcher 会从 outbox 恢复"——对 started intent 为假。
- `allocateWorkflowLaunchOrdinalTx`(:18516-18538):同 (run,node,attempt) 支持多 launch_ordinal(UNIQUE 含 ordinal)——**重试铸新 ordinal 有现成原语**。
- reconcile 循环(:114-145):每 1s;`consume` 前置 `run.status !== 'active'` 即 throw(held/terminated run 自动免疫)。

### 2.3 admission 与凭据(回滚原语的硬约束)
- `admitGeneralizedWorkflowExecution`(StateStore:14790-14914):新 exec 的 admission 要求 node row 恰好 reserve 成 `(attempt, execution_id, state∈pending|running)`(`reservedSuccessor`,:14891-14899)⇒ **回滚 tx 把 node row 改写为 (attempt, newExecId, pending) 正是 admission 需要的形状**。
- `ux_workflow_submission_live` UNIQUE(run,node,attempt) WHERE 未消费未撤销(:12482-12486)⇒ 死 exec 若留活 submission credential,新 exec admission 时铸新凭据会撞索引 ⇒ **回滚 tx 必须 revoke 旧活凭据**(output credential 同理排查)。
- `same_vendor_review`(:14859):admission 读 **snapshot** 的 `dispatch.vendor` 校验 qa/review 与 producer 异 vendor ⇒ 面 7 把 vendor 挪到派发时刻后,此检查必须跟着挪(用派发时刻的 live 解析结果校验)。
- binding(:12438-12456)immutable、run_event append-only、ledger identity immutable ⇒ 回滚只能 append event + upsert node + update ledger state 列 + insert 新 ordinal 行,**不能改写历史**——正好符合审计要求。

### 2.4 one-active-run 锁(面 4 落点)
- `getActiveWorkflowRunForIssue`(:17640):只认 `status='active'`(held/terminated 自动放锁)。
- 消费者三处:
  1. `workflow-template-selection.ts:193-198` —— **生产闸,不分 engine_owned/entry_kind,影子 run 楔死双路的唯一落点**(FLY-1356 实锤)。收窄点在此。
  2. `recoverWorkflowStartSelection`(:282-284)—— 现自带 `entry_kind === 'pipeline_dag_v1'` 过滤;**W8 后改为通用 marked-engine recovery 分类**(两 entry kind + unmarked v2 窄兼容分类器,按 kind 分策,见 plan W8)。
  3. `workflow-shadow-writer.currentAttempt`(:255)—— 影子记账用,**必须继续看到影子 run**(收窄不能做在 `getActiveWorkflowRunForIssue` 本体)。
- runs-route:822 的 `dagRun` 域现按 entry_kind='pipeline_dag_v1' 过滤(影子 run 不进它;影子楔死走的是消费者 1);**W8 后该域通用化为按两 entry kind + unmarked v2 兼容分类的 marked-engine recovery**(plan W8)。

### 2.5 takeover(面 5 落点)
- `Blueprint.ts:1179`:`!clean || !ctx.startPoint || head !== ctx.startPoint` ⇒ fail。startPoint 来自 `resolvePredecessorHead` → `resolveWorkflowHeadAuthority().prHeadSha`(冻结记录);progress.md 自动 commit 等推进 head 后**永久**不等。放宽为 ancestor 判定(`git merge-base --is-ancestor <startPoint> <head>`)+ clean,不多一行(Lead 裁定)。
- gitChecker 现有能力:`assertCleanTree`/`captureBaseline`;ancestor 判定需加一个只读 git 探针(edge-worker 侧)。

### 2.6 探针基建(面 1/2 复用)
- `probeGeneralizedLaunchLiveness`(bridge/generalized-launch-recovery.ts:22-41):tmux lookup + process probe → `alive|dead|unknown`;lookup 不到/`:pending`/探针错误 → `unknown`(保守)。dispatcher 已注入(`options.probeLaunchLiveness`)。**面 1 的"探针双阴"直接复用**:`dead` 才允许回滚;`unknown` ⇒ 继续 hold + 告警(fail-safe,Lead 裁定 2)。

### 2.7 FORCE_LEGACY 死 flag(面 6,已核)
- 定义:`workflow-claims.ts:134`(`isWorkflowLegacyForced`,dispatch 路径零 runtime caller)。
- 引用:`flywheel-comm/src/ship-eligibility.ts`(`evaluateQaShipGate` 内 forceLegacy 读取 + durableQa 分支)、`config/src/feature-flags/registry.ts:2930`(envVar 注册)。
- 删除三处 + durableQa 的 **force-skip 分支**(非 force 分支字节保持:claims-read disabled / unbound ⇒ fail-closed,ship-eligibility.ts:300-315,不落 legacy record 查询)。注意(codex R2#7):该 flag 在 evaluateQaShipGate 是运行时读取,非纯死代码;生产 env 行已删 ⇒ force 恒 unset,删除 force 分支 = 行为保持型 cutover,详见 plan W5。

### 2.8 vendor 烤死链(面 7 输入)
- 烤入点:`materializeTypedWorkflowSnapshot`(workflow-run-snapshot.ts:199-217)—— schema-2 每 non-gate node **强制** pinned `vendor/model/effort` 进 `resolved.nodes[].dispatch`;schema-1 manifest 同样带 per-node vendor/model(`allowUnsupportedModels` 仅放宽校验)。
- 消费点:dispatcher `consume()` 把 `node.dispatch` 原样放进 `generalizedExecution.dispatch`(workflow-engine-dispatcher.ts:490)→ `run-dispatcher.ts:666-671, :1231-1234`(`generalizedExecution?.dispatch.{model,vendor,effort} ?? req.dispatch*`)→ 决定 runner backend/model。
- 后果:2026-07-20 夜 codex 配额封顶,tpl_eng_heavy 快照把 implement 烤死在 codex vendor ⇒ 重开 run 也必死(§1.1 复发铁证);legacy 三段有 THREE_STAGE_CODEX_IMPLEMENT 类活开关,DAG 路没有任何杠杆。
- Annie 定调:快照锁**形状**并保留 dispatch 兜底;vendor/model/effort 在**该节点派发时刻**优先按当前已配置 source 解析(含紧急回 pinned 开关),但这不授权任意模型替换。唯一自动替补是 design Fable → GPT-5.6;其他资源死亡立即 held+告警。设计稿(前/现/后对照)已过硬门后实施。

### 2.9 混 schema 入口语义(面 8 输入,Lead 引用事实已逐条核实)

- `workflow-template-selection.ts:124-128`:v1 + dispatch flag off ⇒ return null(回落 legacy);**v2 无此回落** —— 落到 :129-130 `workflowTemplateDispatchBlockReason(2,env)` flag off ⇒ throw ⇒ runs-route 409 `GENERALIZED_WORKFLOW_REJECTED`。flag off 对 v2 不是保护而是楔子。
- `:136-138`:v1 需 `allowSchemaV1Dispatch` + idempotencyKey,否则 null(legacy);v2 跳过此闸后 `:140-141` 强制 master auth(throw)、`:143-144` 强制 idempotencyKey(throw)。而 runs-route 只在 dagEntry(v1 政策门内)合成 keyless key(:1148-1149)⇒ **binding 一迁 v2,普通 keyless/非 master 派发全 409**。
- `:66-67` 注释明写 v2 是 "independent schema-v2 entry path",不过 three-stage policy ⇒ `NO_THREE_STAGE_LABEL` 只在 runs-route 的 dagEntry(v1)块判定(:975),**v2 路径静默绕过 no-three-stage**。
- 与面 4/W3 同属 selection 语义;修复不挂 FLY-1396 的 cutover 开关(那开关只管 work-kind binding 解析 + 标签不继承)。

## 3. 关键设计决策(为 plan 铺垫,plan 落细节)

1. **回滚原语**(新 store 方法,单事务,幂等):守卫(run active+engine_owned=1;node=(run,node,attempt,execId,running);无 receipt;session 再核 terminal)→ revoke 旧活凭据 → append `execution_dead_rolled_back` run event → node row 改写 (attempt, newExecId, pending) → `allocateWorkflowLaunchOrdinalTx` 铸新 ordinal(intent_recorded)。attempt 不变(ordinal 即重试代际,与影子 belt 同形)。
2. **supersession 守卫**:reconcile/consume 只消费同 (run,node,attempt) 的**最高 ordinal** intent;非最高 ordinal 的遗留 intent 永久跳过(不 markStarted、不资格化)。堵死 §2.2 markStarted 复活坑。
3. **retry cap/backoff 零 schema**:cap = 同 (run,node,attempt) 的 dispatch ordinal 计数(≤ 1+3);backoff 用上一 ordinal 行的时间戳与 now 差(1/5/15min 指数)。超限 ⇒ run→held + `loop_limit_escalated` 同族的 `retry_limit_escalated` event + 告警 Lead(复用既有告警链)。
4. **divergence 双类**:A 类(running+dead)→ 回滚域;B 类(done node 的 session 事后 terminal)→ 只 append `node_session_divergence` event(投影不回滚,receipt 权威)。写入点(codex R3#4 裁定):**dispatcher reconcile 内独立 B 类查询**(active engine run 的 done node × 不可逆终态且非 completed 的 session),零新 timer/hook;详见 plan W1.6。
5. **面 2 出口**:emitFailed/event-route 的 held 分支不再裸吞:立即落 `session_failed` 事件账(审计),session 终态照写(A 类回滚交给 sweep,同一原语;事件驱动只是把 sweep 会做的事提早,不承担正确性)。探针不准 ⇒ 维持 hold + 告警。**事实澄清(codex R1#5)**:event-route 的 `workflow_completion_receipt_required` 409 只在**非** flywheel-comm 源分支;`flywheel-comm complete` 因 source='flywheel-comm' 走 `commitEnrolledCompletion`,昨晚的重放循环来自其 `route_mismatch` 409(marker reconciler 对非 missing_output 的 4xx 走 quarantine,complete-marker-reconciler.ts:573-592)。迟到完成的收敛用 typed `stale_execution_superseded` + 200-settled,见 plan W1.5。
6. **面 3 API**:`POST /api/runs/:runId/hold`(active→held)+ `POST /api/runs/:runId/terminate`(active|held→terminated),body 必带 reason,append `run_held_by_operator`/`run_terminated` event(actor/reason/时间);master auth;guard 文案(`ACTIVE_DAG_RUN_RECOVERY_HELD` 等)改指真实端点;`terminated` 进 run status 合法词表(查询层核不炸:所有 active-only 查询天然容忍)。
7. **面 4(codex R1#1/R2#1 后修订)**:纯"锁收窄"不可行 —— `idx_workflow_run_active` UNIQUE(project,issue) WHERE active 是 ownership-盲的 DB 级闸(StateStore:17611),影子 run 不终结则 materialize 必撞索引;且影子 writer 的 issue 级 active 查询(applyWorkflowShadowBatch/currentAttempt/onShipFinalized)不分 ownership。改为**原子 supersession handoff + ownership seam**:quiescent 影子 run(run-attributed execution 全集 = node ∪ ledger ∪ binding 的 execId,逐个终态+物理 dead 证据)在新开工时事务性 terminated + 审计;影子 writer issue 级路径只认 engine_owned=0,对 engine run typed no-op。recovery 域随 W8 通用化(两 entry kind + unmarked v2 兼容)。详见 plan W3/W8。
8. **面 7 形状(codex R1#3/R2#3 后修订)**:解析必须**先于 admission**(admission 会把 dispatch 写进 immutable `workflow_execution_runtime`,decision authority 读那张表;consume 时才解析会造成 runtime/launch 分裂);生产 admission/launch 位点共 **3 处**(runs-route start、dispatcher consume、bridge/actions.ts handleRetry :904/:1052)。resolved triple 进 admission 同事务:same-vendor 按 actual predecessor runtime 重校验、写 runtime、审计 event;launch 只读 durable runtime,replay/重启不重解析。详见 plan W6。

## 4. 风险与雷区

- **FLY-1396 正交**:不碰 candidate/binding derive 语义;本单改动 = runs-route 入口编排(W8)+ 有界 selection 语义(W3/W8),均为 Lead 显式划界的 1396 前置 gate(细节见 plan §0.2)。
- **append-only/immutable 触发器**(run_event、binding、ledger identity):回滚原语的写形状已按此设计(§3.1);任何"改历史"的实现都会被触发器 ABORT——测试要覆盖。
- **reverse-compat**:非 enrolled legacy 路径字节不变;影子 writer 继续可见影子 run;`FLYWHEEL_*` 现有 flag 语义不变(除死 flag 删除);dispatcher 对非 active run 照旧 throw。
- **凭据撞索引**(§2.3):回滚不 revoke 旧活凭据 ⇒ 新 exec admission 直接失败,重试机制自锁——必须在同一事务内。
- **探针保守性**:`unknown` 不许回滚(tmux server 抖动、lookup 竞态都会出 unknown);宁可 hold+告警。
- **面 7 的可复现性边界**:形状/digest 校验链(manifest_digest/snapshot_digest)不动;只挪 dispatch triple 的解析时刻;设计稿必须把"哪些字段仍被 digest 锁死"写明,Annie 批准前不动代码。
