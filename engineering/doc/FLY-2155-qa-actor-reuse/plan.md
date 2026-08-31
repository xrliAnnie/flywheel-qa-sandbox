# FLY-2155 QA 侧 actor 复用对齐 implement 侧 — 实施计划

Issue: FLY-2155 (https://linear.app/geoforge3d/issue/FLY-2155/引擎不对称-体做完留着继续用只对-implement-生效qa-侧新一轮必须换体而活着的旧体反过来把起跑道占死-死结)
日期: 2026-08-29(R6,吸收 Codex R1×8 + R2×7 + R3×4 + R4×3 + R5×1)
基于: research.md

## 0. 设计原则

**「新一轮 = 复用请求」。** QA 的新一轮本质是「同一节点的下一个 attempt」,与返工在机制上无异。不新造任何投递/存活判定机制 —— 全部复用 implement 侧已在生产验证的 rework request → coordinator probe → wake / replacement 通道。存活判定天然异步,留在 coordinator;`commitWorkflowTransitionTx`(引擎推进的同步事务;下文简称「transition 事务」)里只做「目标 qa 节点有历史 actor 就造复用请求,没有才铸新体」这一个决策。

不做的方向(exploration.md 已论证否决):execution 换绑旧 pane(第二套身份映射)、放宽 runway 释放判据(双活 runner 数据损坏风险)、只修门不修引擎(浪费照旧)。

## 1. 工作流(七个 WS,按依赖排序)

### WS1 — 共享 preferred actor 选择器(病根 B,三处)
**文件**:`packages/teamlead/src/StateStore.ts`

新增事务内 helper `selectPreferredWorkflowActorTx(runId, nodeId)`,按**三档分层**(不是单纯 attempt 倒序):
1. **known_nonterminal**:session 状态存在且非不可逆终态(`isStateStoreIrreversibleTerminalForZombie`=false)—— 档内按 attempt 倒序;
2. **unknown**:session 行整体缺失 —— 仅当第 1 档为空才用(防止「更新的缺失行」压过「更老的已知非终态体」——FLY-2139 `actor_session_missing` 重试地狱的直接来源);
3. **dead_seed**:已知不可逆终态 —— 仅作 dead-probe 种子,coordinator 会即刻走 replacement。
额外规则:存在该 execution 的 `unlaunched_admission_rolled_back` 回执 ⇒ 无论 session 状态,归入 dead_seed(rollback 回执是「从未启动」的持久证明)。
返回 `{ executionId, classification: 'known_nonterminal'|'unknown'|'dead_seed' }`(Codex R2 #7:第一档只证明「session 非终态」,物理存活仍归 coordinator probe —— 命名不夸大证据,禁止任何调用方据此绕过 probe)。

替换**三处**同型选择器:transition 事务 chained 分支(~L38566)、`openOperatorRework`(~L32095)、`openEngineLandConflictRework`(~L31411 内部的第三处 latest-attempt 选择器)。

### WS2 — transition 事务 fallback 分支复用(病根 A,本单主体)
**文件**:`StateStore.commitWorkflowTransitionTx`(~L38467)、`bridge/plugin.ts`、`bridge/event-route.ts`、`bridge/workflow-decision-routes.ts`、`bridge/flag-store-runtime.ts`(+ flag registry/codec 所在文件)

**范围收窄(Codex R1 #4)**:复用分支只对 `target.type === 'qa'`(wake 型 phase actor)生效;land / review / design / gate / 引擎自执行节点一律保持现状。active verification path 存在时走既有 `chainedRework`,一行不动。

fallback 分支(`target.type === 'qa' && !reworkAuthority && flag ON`)改为:
- WS1 选择器对 qa 节点返回历史 actor → **先解析 base**(Codex R4 #2:引擎分支的链独立于 WS4 operator 链,**不含**目标节点旧 QA 头 —— 旧 QA session 头属于上一轮,不得压过刚完工的上游 producer):`input.subjectDigest`(40-hex 校验)→ 唯一上游 producer 节点最近一次 done execution 的头 → receipt-backed materialized head → **链穷尽则 fail-closed**(Codex R2 #4):返回显式 transition 拒绝(新 reason `reuse_base_unavailable`),**零写入**(不动源节点、不 reserve、不建任何 rework 行)——绝不让 `"unavailable"` 流进 `assertWorkflowWorktreeReady` 的 Git ancestry 检查去烧重试预算。base 解析成功才原子落 **rework 四表 + 目标节点 reservation**(Codex R4 #1:此前漏列 verification_path —— 没有它,wake receipt 无从激活(L26823–26835)、QA PASS 找不到 active rework(L38224–38240)、delivery 永远停在 wake_delivered 毒化后续 open-delivery 检查):
  - `workflow_rework_request`:`authority='engine'`(CHECK 约束已含 'engine',无 migration);`authority_context` 记 `{kind:'node_reuse', outcome, sourceNodeId, sourceAttempt, targetNodeId, targetAttempt, baseRevision, baseRevisionSource, actorClassification: 'known_nonterminal'|'unknown'|'dead_seed'}`,其中 `baseRevisionSource` 是**判别式 provenance 记录**(`{kind:'subject_digest'} | {kind:'producer_head', nodeId, attempt, executionId} | {kind:'materialized_head', effectId, outputId}` —— 与引擎分支链一一对应,无 session_head 变体);
  - `workflow_rework_route_revision`:`invalidation_scope=[target.id]`,`verification_policy=["qa_retest","founder_gate"]`(与 FLY-2139 `rework:ed1cf8faa` 同形),`interpreted_by='engine:node_reuse'`;
  - `workflow_rework_delivery` state='pending';
  - `workflow_rework_verification_path` state='pending'(current=target/targetAttempt;与既有三处请求创建者同形:L31629/L32234/L38719);
  - 另加目标节点 reservation(`rework_target_reserved`);receipt 沿用**既有 `reworkRequestId` 字段**(不新增 reuseRequestId,不长平行协议)。
- 无任何历史 actor(节点首轮)→ 现状铸新体。
- coordinator 既有 tick 接手:probe 活 → wake(同 execution 在新 attempt re-admit + turn,FLY-2139 seq 35–41 已验证);dead → materialize 替身(现状路径)。生命周期收尾走既有 CAS:wake ACK 把 path pending→active(L26823–26835),QA PASS→gate 的 transition 把 path+delivery 同步 CAS 到 completed(L38913–38945)。

**`authority='engine'` 冲突处置(Codex R1 #1 + R2 #5,已验证)**:`openEngineLandConflictRework` 以 `COUNT(*) WHERE authority='engine'` 做 3 次 land-conflict 熔断(L31474)—— 复用请求会误耗该预算。cap 过滤**钉死在不可变根标记**:land-conflict 请求的 `source_event_id` 恒以 `engine_land_rework:` 开头(L31433),cap 查询改为 `AND source_event_id LIKE 'engine_land_rework:%'`(不用 `interpreted_by` join —— 它随 replacement route revision 漂移会漏数)。测试:3 个根 land-conflict 周期 + 混入 engine 子返工/复用请求/replacement revision,断言只数根周期。wake 文案渲染在 `bridge/plugin.ts` ~L9736,按 `authority_context.kind==='node_reuse'` 分支为「新一轮复验」措辞(非「返工」),单测锁关键词。审计范围(R2 #5):全仓 grep `authority`、`authority_context_json`、`interpreted_by`、`source_event_id` 四个标识(含 SQL 字面量如 `authority = 'engine'`,不止 `.authority` 属性访问),逐消费者记录处置。

**replay 幂等契约(Codex R1 #2 + R2 #4,已验证 L38040-38075)**:现有 replay 校验 `request.base_revision !== (input.subjectDigest ?? "unavailable")` 会拒掉 base 来自权威链 fallback 的复用请求;且携带 provisional `successorExecutionId` 的 replay 在首次执行选择了 rework 分支时会被 successor 不匹配误拒。修订(**兼容优先**,Codex R3 #3:此 replay 分支为 QA/founder/chained/node_reuse 四族共用):新的 provenance 感知校验**仅在** `authority_context.kind==='node_reuse'` 验证通过后启用;旧 context 形状(无 kind/无 baseRevisionSource 的 QA/founder/chained receipt)保持既有校验路径逐字不变 —— 既不误拒历史耐久 receipt,也不放松其冲突检查。node_reuse 分支:replay 校验 committed request/context 与(若输入携带)subject digest 的一致性,**不重新解析可变的 head authority**;committed 分支为 rework(无 successor)时忽略输入侧的 successor 提案。测试矩阵:node_reuse 族 —— 同参 replay / 换 provisional successor / subjectDigest 缺失走权威链 / 权威源前进后 replay / 重启后 replay / 五表零重复行;**兼容族 —— QA、founder、chained-verification 三种无新字段的存量 receipt 各配 replay 通过 + 冲突拒绝双用例**(现有「active path 不受影响」的首提交用例不覆盖共享 replay 面)。

**开关(Codex R1 #3 + R2 #1,调用图已核对)**:`workflowReworkReentryEnabled` 是 dispatcher 回调,够不到 StateStore 同步事务。改为**输入线程化**:`commitWorkflowTransitionTx` 增加输入 `nodeReuseEnabled: boolean`,**六个**调用点(L37059/L37635/L37899/L40631/L40892/L41014)全部显式传值 —— 不允许默认参数(缺省即编译错,防「漏穿一处静默回退」)。真实生产 ingress 是三个文件(`workflow-engine-dispatcher.ts` 不调用此事务):`event-route.ts`(`commitEnrolledCompletion`)、`workflow-decision-routes.ts`(`submitWorkflowDecisionByCredential` / `commitWorkflowLoopReentryRequest`)、`founder-approval-projector.ts`(`applyWorkflowSourceEvent`)。接线:`plugin.ts` 把**活回调**(每次调用现读动态 flag,不许 boot 时捕获快照)注入 `createEventRouter` deps 与 `WorkflowDecisionRouterDeps` 两个 Bridge 依赖缝 —— founder-approval projector **不加**任何 flag 依赖或运行时读(其三处 transition 结构上进不了新分支);flag key `workflow_node_reuse`,bridge 全局作用域,**默认 OFF**。flag 落地必须走仓库的**完整授权链**(Codex R3 #1;`doc/engineer/implementation/flag-authoring-runbook.md`):registry spec(env 名 `FLYWHEEL_WORKFLOW_NODE_REUSE`)→ `STORE_MANAGED_FLAGS` 成员 → `getFlagStoreCodec` 的 opt-in/default-OFF codec 分支 → `flag-store-runtime.ts` 具名 wrapper `storeWorkflowNodeReuseEnabled`(镜像 `storeWorkflowReworkReentryEnabled` L104)→ 调用点 call-time 委托读 → 启动 row/management-route 覆盖 + registry/store/drift/route 四类测试。founder-approval projector 的三处 transition 调用**钉死**(Codex R4 #3 / R5 #1):founder feedback 路径本就产生 `reworkAuthority='founder'`(分支谓词不触发),两条 approval 路径目标为非 QA 终态 —— `StateStore.applyWorkflowSourceEvent` 内三处均显式传字面 `false` 并注释,projector 文件零改动。热读 ON/OFF 测试恰覆盖三个 eligible 操作:`commitEnrolledCompletion`、`submitWorkflowDecisionByCredential`、`commitWorkflowLoopReentryRequest`(经 `event-route` 与 `workflow-decision-routes` 两个依赖缝)。语义:flag 只门控「新决策」——OFF 前已落库的复用请求由 coordinator 继续走完,不悬空。

### WS3 — rollback 同事务重置 node + 存量幽灵按需自愈(病根 D)
**文件**:`StateStore.rollbackUnlaunchedWorkflowAdmission`(L24338–24575)

- 主路径(node 已验证 `state='admitted'` 且绑定匹配)追加:
  ```sql
  UPDATE workflow_run_node SET state='failed', ended_at=?
   WHERE run_id=? AND node_id=? AND attempt=? AND execution_id=? AND state='admitted'
  ```
  CAS 失败 → invariant 抛错(同相邻风格)。
- **replay 分支自愈(Codex R1 #6c)**:幂等 replay 分支(existing-receipt 早退)在返回前检查 node 若仍 admitted+绑定该 execution,同样应用上述重置。
- **存量幽灵的真实触发器(Codex R2 #2)**:replay 自愈**不是**回填 —— 老 rollback 的 dispatch ledger 已是 `abandoned`,`listNonTerminalWorkflowSideEffects()` 只返回 `intent_recorded`/`launch_committed`,hard-TTL reconciler 永远不会对老幽灵再调 rollback。有界触发器放在 WS4 的 `heldUnlaunchedRollback` operator 门里:识别幽灵**不解析复合 event_uid**(node id 仅校验非空、可含 `:`,无转义 —— 拆串会错位):`latestHold` 查询加选 `workflow_run_event` 的结构化列 `run_id/node_id/execution_id`,`attempt` 从已校验的 receipt payload 读;四元组 + 事件 kind 全部一致才执行 admitted/绑定匹配的 CAS 自愈,再走 reservation 检查;任何缺失/不一致 → fail-closed(不猜)。测试含 node id 带 `:` 的用例。不做全库扫描/一次性迁移(改动面最小,且幽灵只在有人对该 run 开门时才需要修)。测试:只预置「老 rollback 回执 + admitted 幽灵」(不重放 rollback),直接调 `openOperatorRework`,断言门开。
- **与 issue 文本的偏差**:保留 execution_id(取证需要);WS1 分层 + state='failed' 已消除幽灵的全部毒性。

### WS4 — openOperatorRework:base revision 权威链 + rollback-held 准入(病根 E)
**文件**:`StateStore.openOperatorRework`(~L31761–32200)

- base revision 解析链(Codex R1 #6a,FLY-2139 快照 produces_output=false 实证 materialized head 对 legacy phase workflow 不可用):
  1. 目标节点上任执行者 session 的 `pr_head_sha`(现状);
  2. **唯一上游 producer 节点最近一次 done attempt 执行者的 `pr_head_sha`**(经同一 40-hex 校验;legacy phase workflow 的可用权威源);
  3. materialized-head 回执(`getWorkflowMaterializedHead`,generalized manifest 的 receipt-backed 源);
  4. 皆不可得 → 保持 `base_revision_unavailable`。
  事件 payload 记 `baseRevisionSource: 'session_head'|'producer_head'|'materialized_head'`。
- **准入修正(Codex R1 #6b,已验证 L31855-31905)**:`run_not_reworkable` 的 held 白名单不含 rollback 冻结的 run —— 增加 `heldUnlaunchedRollback` 类别(latestHold.kind='unlaunched_admission_rolled_back'),走与其他 held 类别相同的 quiescence evidence 门,不新开旁路;准入时解析该回执四元组并对仍 admitted 的匹配幽灵 node 先 CAS 自愈(WS3 的存量触发器,详见 WS3)。
- 测试必须用 **FLY-2139 形状的 snapshot fixture**(produces_output=false、rollback-held),不只用 generalized fixture。

### WS5 — materialize 落死体终态(经 CAS 终态 helper)+ 幽灵 probe 短路(病根 F/G)
**文件**:`StateStore.materializeWorkflowReworkReplacement`(L26999–)、`workflow-rework-coordinator.ts`

- 不裸写 `UPDATE sessions`(Codex R1 #8:绕过 `applyTerminalTimestamp`/lifecycle 记账,且 cancelled/merged/superseded 不在 zombie 终态集里会留下永不释放的 runway)。新增事务内 CAS helper `terminalizeProvenDeadSessionTx(executionId, reason)`:已是 zombie 终态 → no-op;否则(含 cancelled/superseded 缺口)迁移到 'failed' 并走既有终态时间戳/lifecycle 记账;逐状态单测 + `currentInflightEntry` 释放断言。materialize 事务内对 `deadExecutionId` 调用之。
- coordinator probe 前短路:preferred actor 的 session 已是 zombie 终态,或存在其 `unlaunched_admission_rolled_back` 回执 → **即刻** `replacement_pending`(FLY-2139 的 55 分钟幽灵重试归零)。session 行整体缺失保持现有 hold 行为(不可区分,fail-closed)。

### WS6 — runway 复用收敛:不加新判据,补齐断言与回归(issue 要做#4)
**文件**:仅测试 + 注释

- 明确决定:**不**给 in-memory runway 增加第二释放条件。issue 要做#4 的实质由两条既有路径覆盖:复用 wake 不经过 `start()`(WS2);替身 launch 前死体已落终态(WS5)。
- `start()` 同 executionId 收敛路径(run-dispatcher L1459–1474)加注释指明它就是「既有 actor 即目标 actor」的收敛点,补单测锁行为。

### WS7 — wake_delivered 误冻结收窄(Codex R1 #7,已验证)
**文件**:`workflow-engine-dispatcher.ts`(stall 扫描 L1160–1243)

生产实证:seq 67 `wake_delivered` 15:59 → seq 91 `rework_activation_stalled_held` 16:59 整点 —— 已 ACK、活着、正干活的 actor 干满一小时就把 run 冻住;WS2 之后每次 QA 复用都会继承这一误伤。

修订(Codex R2 #3:`reconcileWorkflowReworkStalls()` 是同步函数且每秒被调,不能塞异步 probe 造出无节流探测环)—— **不在 stall 扫描里发起任何新 probe**,改为消费 coordinator 已经落库的证据:coordinator 每轮 receipt-probe 对活着的 actor 经 `deferReceiptProbe` → `scheduleWorkflowReworkReceiptProbe` 持久化 `reason='actor_alive_after_receipt'` + `nextRetryAt`(coordinator L304–324/L469)。stall 扫描对 `delivery.state==='wake_delivered'` 的行,当持久化 reason 恰为 `actor_alive_after_receipt`(注意 `actor_session_missing` 走同一函数,必须精确匹配)且证据仍新鲜(`next_retry_at` 尚未过期,即 coordinator 正常在巡)→ 跳过 `escalate("hold")`,保留 alert 节奏;证据缺失/过期/为其他 reason → 照旧 hold。扫描保持同步、零新 IO;actor 死了 → coordinator 下轮 probe 判 dead 走 replacement,本就不依赖 stall hold。pre-ACK(`awaiting_receipt`)行为不动。测试:证据新鲜不 hold、证据过期 hold、probe 抛错(coordinator 未落 alive 证据)hold、连续每秒 reconcile 不产生新探测。

## 2. 测试计划(TDD,先红后绿)

**单元(vitest,packages/teamlead)**
- WS1:三档分层矩阵 —— 新缺失行 vs 老已知非终态(后者胜)、新 rollback 回执 vs 老已知非终态(后者胜)、全终态取 dead_seed、无候选;classification 枚举值断言(known_nonterminal 不得被任何调用方当 liveness 用)。
- WS2:qa 目标 + 有历史 actor → 零新 execution、四表落齐、receipt 幂等矩阵(见 §1 WS2);base 链穷尽 → fail-closed 零写入(reuse_base_unavailable);旧 QA session 头存在 + 更新的 implement producer 头 + 无输入 digest → producer 元组胜且 replay 稳定;非 qa 目标 / 首轮 / flag OFF → 现状;active path → chainedRework 不受影响(分支矩阵);engine 复用请求不耗 land-conflict 预算(根前缀阳性对照:3 根周期 + 混入子请求/replacement revision)、不触 founder 分支(L28603/L38050 阳性对照);wake 文案关键词;三 ingress 热读 ON/OFF。
- WS3:主路径与 replay 分支双双重置 node;存量幽灵:只预置老 rollback 回执 + admitted 幽灵(不重放 rollback)直接 `openOperatorRework` → 门开;CAS 竞态。
- WS4:四级链逐级 fallback;producer 歧义/缺失 → unavailable;rollback-held 准入过 quiescence 门;FLY-2139 形状 fixture。
- WS5:terminalize helper 逐状态(含 cancelled/superseded 缺口)+ lifecycle 记账 + runway 释放;coordinator 短路 vs session 整行缺失仍 hold。
- WS7:alive 证据新鲜 → 不 hold 仍 alert;证据过期 / probe 抛错(未落 alive 证据)/ reason 为 actor_session_missing → 照旧 hold;连续每秒 reconcile 零新探测 IO。

**集成(扩展 `workflow-rework.e2e.test.ts`)**
- **FLY-2139 复盘剧本**:implement done → qa fail(kickback 复用 implement)→ implement 再 done 且 path 非 active → 断言 qa 复用请求 preferred=活着的旧 QA execution、无新 execution、无 TTL 路径;wake 后同 execution 新 attempt re-admit → PASS 判决可提交;**verification_path 生命周期全程断言:落库 pending → wake ACK 后 active → QA PASS 后与 delivery 同步 completed,且该 run 无残留 open delivery**。
- **幽灵剧本**:造 rollback 幽灵 → 选择器跳过幽灵选活体;活体不存时即刻 materialize 替身(无 55 分钟重试)。

**全仓门禁**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(注意 teamlead 包失败即停假绿坑,逐包确认真跑到)。

## 3. 交付与顺序

1. WS1+WS3 → 2. WS5 → 3. WS4 → 4. WS7 → 5. WS2(主体,flag 默认 OFF)→ 6. WS6 断言 → 7. e2e 剧本。单 PR 交付(改动同心圆,拆开无可运行中间态);PR 末 commit 附 `engineering/doc/milestones/FLY-2155.md`。

**上线序(Codex R2 #6:flag 是 bridge 全局,不引入 project 级 flag 机制,给出可执行且不循环的序列)**:
1. merge → 部署班车(flag OFF:WS1/3/4/5/7 止血立即生效,WS2 复用不生效);
2. **隔离 529-only Bridge**(按 `doc/qa/framework/529-room-playbook.md` 与 slot 脚本;隔离四件套一个不缺:harness 自有 HOME/环境边界、`TEAMLEAD_DB_PATH`、`FLYWHEEL_DELIVERY_SECRET_PATH`、`FLYWHEEL_STATE_DIR`)以 flag ON 跑完整 qa_fail→implement 复用→qa 复用 wake→PASS 提交周期,取证 `rework_requested(engine:node_reuse)`、零新 execution、runway 无占用告警;
3. 生产 Bridge 由 Lead 翻 flag ON,进入**受监护 canary 窗口**(下一个自然发生的 qa 新一轮),观察同组证据;
4. **回滚判据**:canary 内出现 reuse 请求 retry_exhausted / runway 占用告警 / land-conflict 预算异常消耗任一 → 翻回 OFF(在飞请求由 coordinator 收尾,不悬空),带证据回 FLY-2072。

## 4. 风险与边界(honest boundary)

- **本单做**:run 内 qa 节点新一轮的 actor 复用;死结全件套(幽灵 node 重置+按需自愈、base revision 权威链、rollback-held 准入、死体终态化、幽灵短路、wake_delivered 误冻结收窄)。
- **本单不做**:跨 run 复用(同 issue 新 run 收养旧体 —— 身份/凭证问题,另立 issue);非 qa 节点的复用推广(等 qa 侧生产验证后再议);`deps.reQa` 生产接线(WS2 落地后引擎自走,留 FLY-2072 统筹);FLY-2154 released_reason;`submission_credential_rotated` 每秒热循环(FLY-2139 seq 101–399,应在 FLY-2072 下立案)。
- **残余风险**:authority='engine' 的审计清单外动态读法 —— 按 §1 WS2 的四标识全仓审计(authority / authority_context_json / interpreted_by / source_event_id,含 SQL 字面量)兜底;land-conflict cap 根前缀过滤对存量行为的等价性 —— 改前改后阳性对照;flag 默认 OFF 意味着复用在翻 ON 前不生效 —— WS3/4/5/7 不上开关,先行止血。
