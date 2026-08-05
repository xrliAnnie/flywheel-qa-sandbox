# FLY-1638 self-ship 自动化收尾 — 实施计划

Issue: FLY-1638 (https://linear.app/geoforge3d/issue/FLY-1638/self-ship-自动化收尾1625-修复合一单-ship-绑定修复-重试封顶-防空转-qa-ttl-预配-重启前暂停接活)
日期: 2026-08-04
基于: research.md
状态: **Codex design review 6 轮 APPROVED**(R1 11 项 / R2 6 项 / R3 2 项 / R4 2 项 / R5 1 项全折入;R6 APPROVED);2026-08-05 新增修复面 7 的复审 R1/R2 CHANGES 已折入,待 R3

> **R6 非阻塞实施守则**(不改结论,实施节点必读):
> 1. 仓库枚举失败**不得**丢弃既有 lifecycle worktree binding —— `Blueprint` 现对 `emitWorktreeReady()` 异常是 log+继续 launch;path/branch/generation 照常绑定,baseline 字段落 null(=不合格 no_code),核心 binding 落盘前不抛。
> 2. `repo_baseline_set_json`/`repo_baseline_set_digest` 加进既有 sessions worktree-binding 列组(legacy null);`grant_started_at` 显式进 `workflow_rework_delivery` rebuild/copy/双 boot fixture;baseline digest 用既有 canonical SHA-256 helper **重算比对**,不把存储的 JSON 与 digest 当两个独立可信输入。

## 0. 总原则

- **机制数不升**:修复面 2/3/5 是给既有机制加谓词/收窄判定;唯一新增小机制是修复面 6 的 admission pause(issue 明示的 DR 四步模型缺口);修复面 5③ 反而**删除**一类错误重派行为。
- **不动 `workflow_v2` DAG 引擎本体**;不动 founder-gated merge 权限模型(verify-approval 安全检查逐字保留,只修它读不到数据的断链)。
- **三个前提修正**(research §4 + Codex R1#4):
  1. 子缺陷 ① 真 throw 点在 `workflow-run-snapshot.ts:176-177`(非 workflow-menu.ts);
  2. 子缺陷 ③ 真缺陷是死亡判定把「诚实完成但 receipt 丢失」当死 runner,不是缺 run-status 检查;
  3. replacement 计数**本已持久**(从 `workflow_side_effect_ledger` durable 行派生,`rollbackDeadWorkflowNodeExecution` 独立 count 后执行 `MAX_BLIND_REPLACEMENTS+1`)—— 不随 Bridge 重启清零;8-05 两次 boot 各重派一轮是因为 cap=3 未耗尽(FLY-1606 耗尽即 held)。**不引入第二计数器**,只加两次重启回归测试锁行为。
- TDD:每个 seam 先落失败测试(含 research 点名的零覆盖 seam:真过期凭证 → 409;schema-v2 gate 物化 → /head-authority;以及 R1 新增的 gate-proof / 迁移 / crash 边界组)。

## 1. 修复面 1 + 5①:runner_ship 的 gate 主体与 ship 绑定(合并设计)

两者是同一条 authority 链的两半,合并陈述。

**选型:写入侧补齐 + resolver 对称化**。否决「land_v1 读分支识别 schema-v2 凭证链」:读路径长出第二套 authority 模型,双建模正是病根。

### 1.1 subjectKind 对称化(5①)

`resolveWorkflowGateAuthority`(`workflow-run-snapshot.ts:142-184`):`runner_ship` 模式(唯一 carrier 且能力包完整)**无条件** `subjectKind = "git_head"`,与 `land` 模式(`:149-151`)对称;`engine_terminal` 保持 claims 推导。`:177` 的 throw 随之消失;`:162`(≥2 carrier)与 `:174`(能力包不完整)保留 —— 那两类仍是真不一致。
**理由**:carrier 的存在本身蕴含 ship 主体是 git head(PR 由 carrier 产出);claims 列表回答「ship 需要哪些证据」,不反向决定主体类型。resolver 级修复对**已 pin 的 6 个僵尸快照即时生效**(快照内容不变),并同时治好 `tpl_generic` 与 `tpl_generic_menu` 两个 template id。
**否决:改 seed ship_claims**:治不了已 pin 快照;generic 无 QA 节点,声明 `qa_passed` 永远无法满足;两个 template id 要分别改。

### 1.2 runner_ship 的 gate-proof 规则(R1#1 + R2#1)

`resolveWorkflowGateEvidenceTx` 目前从 claims 推 proof 主体 —— generic 只有 `founder_approved` → 会与 1.1 的 git_head 冲突,gate 物化改抛 `workflow_gate_subject_contract_conflict`(等于换个名字继续 500)。**补 runner_ship 专属 proof 规则**,且规则本身**永不 throw**(R2#1:proof 规则若在 §1.3 建 unbound holder 之前就抛,unbound 路径根本走不到):

- **有匹配 PR binding**(当前 carrier attempt 的不可变 `workflow_node_pr_binding`,run/node/attempt 精确匹配,与 carrier session/activation 交叉核对一致)→ 冻结该 head 为 proof 主体;evidence claims 为空也允许(founder-only generic run 的合法形态)。
- **无匹配 PR binding** → 用 **server-authoritative 临时 head**(transition/worktree head)建 **unbound** holder;若连可信 head 都没有 → hold/escalate,**不建 question**。仅当后续不可变 PR row 匹配时才 freeze/bind。
- `engine_terminal` 的既有 proof 行为不动。审计全部 `resolveWorkflowGateAuthority` 消费点(`StateStore.ts:23261/28028/28145/30367/30532`、`gate-authority-view.ts:63`)确认无隐式依赖旧 subjectKind。

### 1.3 binding 写入(修复面 1,R1#2 + R2#1 事务序)

1. **放宽谓词** `workflowRunRequiresShipTarget`(`StateStore.ts:23343-23355`):schema-v2 且 authority mode 为 `runner_ship` 也返回 true;`engine_terminal` 保持 false。resolver 可能 throw(旧 incoherent 快照)→ 沿用现有 catch→false,谓词永不抛。
2. **immediate-carrier 事务序(R2#1 核心)**:heavy 拓扑里 carrier(implement)早在前一 transition 已 park,gate 由 QA 后续打开;而 **generic carrier 在自己的 completion 事务里直达 gate,session 此刻仍 `running`** —— 若 bound 谓词要求 `ship_parked`,合法 PR binding 也会被判 unbound,且后置 `projectGeneralizedCompletionTx` 还会把新升的 `awaiting_review` 覆盖回 `ship_parked`。**明确同事务内顺序**:记 PR binding → 把当前 carrier 投影到 pre-gate parked 态 → holder 绑定判定 → 升 `awaiting_review`;后置 projector 对已升级 session **不降级**(幂等哨兵)。
3. **bound 谓词收紧**:`carrierBindingState = "bound"` 判定**并入**「存在匹配的当前 PR binding(run/node/attempt/head/repo identity 全对齐)」。缺失/不匹配 → unbound + 既有 `gate_carrier_unbound` 单次升级,**绝不 throw**(否则 gate 创建 fail-closed = complete→500 同形)。
4. **写入 + supersede**:bound 确立后同事务调 `bindWorkflowShipTargetForGateTx({runId, questionId, headSha})`;写入前先调 `supersedeWorkflowShipTargetsForCurrentGateTx`(镜像 land_v1 —— 否则旧 question 的 binding 仍 live)。
5. **手动逃生口同步**:`rebindWorkflowGateCarrier`(`:30583-30603`)同前提、同 supersede、同写入。

### 1.4 测试

- **从真 `running` generic session 出发**(R2#1):合法 PR binding → bound + binding 行 + awaiting_review 不被降级;PR binding 缺失 → unbound + 临时 head + 单次升级,无 500;整事务回滚边界。
- founder-only generic manifest 走完真实 gate 物化:无 throw(两个错误名都不抛)。
- schema-v2 run 真 gate 物化 → 真 `workflow-gate:*` question id 调 `POST /api/workflow/head-authority` → ok + frozen head 一致(research §2.4 零覆盖 seam)。
- 替换 gate 的 supersede;rebind 路径同断言。
- **heavy schema-v2 主路径回归**:普通 implement attempt 以 PR binding/head H 完成,QA 对 H PASS 后开 gate → 仍 bound、session 升 `awaiting_review`、ship-target row 的 frozen head 等于 holder head H。`workflow_node_pr_binding` 是 insert-once,本单**绝不更新/放宽**;binding 为别 head 的负例必须 unbound + 单发升级,不静默绑定错 head。
- resolver 消费点回归:land 与 engine_terminal 行为逐字不变。

## 2. 修复面 2:rework 重试封顶(≤5 → needs_lead,告警走 Lead ticket lane)

### 2.1 状态与迁移(R1#7 契约化)

- `workflow_rework_delivery` 新终态 `needs_lead` + 新列 `hold_count INTEGER NOT NULL DEFAULT 0`、`next_retry_at TEXT`(见 2.2 退避)。这里**复用**既有 `escalateWorkflowReworkStall(action:"hold")` 的 run-held + ticket-lane 事务语义,不是另造 alert/parking 机制;新增 delivery 终态只为把「可由 FLY-1596 pane-loss 自动恢复的 `held`」与「预算耗尽、必须 Lead 明示复活」持久区分。若继续共用 `held`,dispatcher 的 `persisted_target_missing` 特例仍会自动复活预算已耗尽的 delivery,无法满足 issue 明示的 `needs_lead` 终局。
- **迁移契约**(table-rebuild,模板 `StateStore.ts:15009-15090`):`sqlite_master` SQL 嗅探 + 列存在检测 → `workflow_rework_delivery_next` 携带**全部**现约束/外键 + 新 CHECK/新列 → 数据拷贝(`hold_count=0`)→ swap → 外键恢复 → **二次 boot 幂等**。测试:含全部旧 state 与被引用 route 的 fixture、`PRAGMA foreign_key_check`、store 重开两次、零行/零约束丢失。
- 同步更新:`advanceWorkflowReworkDelivery` allowed 表、`claimWorkflowReworkDelivery` claimable 集、`listWorkflowReworkDeliveries` 默认、dispatcher 扫描态(**排除** needs_lead)、row mapper 与 `WorkflowReworkDeliveryRow["state"]` union。

### 2.2 原子封顶(R1#6)

- **单事务 CAS**:新 store 方法(如 `settleWorkflowReworkFailure`)一次事务内:验 owner/generation/state → `hold_count+1` → 若 `< 5`:release + 写 `next_retry_at = now + backoff(hold_count)`(指数:1m/2m/4m/8m,总窗 ~15m —— 1s tick 下裸计数 5 次=5 秒即枯竭,必须退避才配叫「重试 5 次」);若 `>= 5`:state → `needs_lead` + 同事务复用 `enqueueWorkflowEngineAlertTx`(`workflow_engine_escalation`,携带既有 `WorkflowEngineAlertIdentity` 载荷)**恰一次**。预算只计算 **run 仍 active 且本次 delivery 真可重试**的 missing actor/context、corrupt authority、admission、turn grant、projection failure;`run.status !== active` 的 `rework_context_unavailable` 不记次也不二次告警;`persisted_target_missing` 保留既有 FLY-1596 pane-loss `held` 自愈路径并**豁免预算**,绝不转 `needs_lead`。claim/list 查询排除 `next_retry_at > now`。
- **止血刷屏**:删除 rework coordinator 每迭代的 `effects.alertHold` 及 `plugin.ts` 对应**单一发射点**;`three_stage_stuck` kind 与 LeadWatchdog/infra router 等其他发射/消费路径全部保留。告警只在转 needs_lead 时发一次,走 ticket lane(`workflow_engine_escalation` 不在 `ISSUE_PROGRESS_KINDS` → Lead alert channel,不进 founder thread)。
- **时间阈值拆分(R2 复审阻断修正)**:现 `FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS/ROLLBACK_MS` 被 launch 与 rework stall 两个 reconciler 共用,本单必须拆成 launch 专用现名 + 新 `FLYWHEEL_ENGINE_REWORK_ALERT_MS`/`FLYWHEEL_ENGINE_REWORK_HOLD_MS`。默认分别为 **30m/60m**,严格晚于 1+2+4+8≈15m 的五击预算;因此 active budget-managed delivery 必先到 `needs_lead`,generic stall reconciler 不会在第 5 击前发 alert/force-held。legacy/persisted-target 路径仍用 rework 专用阈值。
- **Lead 复活路径:stage-aware 终局(R1#6 + R2#3 + R3#2 crash-safe 三态)**:`openOperatorRework` 现会被 reserved target 的 `target_attempt_already_reserved` 拒;且第 5 次失败发生的阶段不同,预约「从未成功投递」并不总成立。coordinator 实际序:admit(activation+credential)→ 解析 authority context → 外呼 `grantTurn` → 本地记 turn → 外呼 `wakeActor`。终局按**三个显式 disposition** 分派(R3#2:「admitted 但尚未 dispatch」是独立区间,`authority_context_corrupt` 即现例;`grantTurn`/`wakeActor` 抛错即便本地行未推进也是 ambiguous):
  1. **pre-admission**(admit 未发生):直接 settle:target 预约回滚 + verification path settle + `needs_lead`。
  2. **admitted 且可证明未发起 grant**(如 authority context 解析失败):原子 revoke 未用 credential + abandon activation + 预约回滚 + settle + `needs_lead`。
  3. **grant/wake 已投递或 ambiguous**(外呼已发出/抛错/结果不明):`needs_lead` + **fence 后续重试**,**保留预约**。
  - **grant-dispatch intent 持久标记(R4#2)**:`authority_context_corrupt`(→2)与「`grantTurn` 可能成功但 `recordWorkflowActivationTurn` 未跑」(→3)在 StateStore 持久行上**不可分辨**(grant 活在 CommDB/外部效果空间)。外呼 `grantTurn` **之前**,在同一 owner/generation CAS 下持久写 monotonic intent(利用已计划的 rebuild 加 nullable `grant_started_at` 列)。判定规则:**标记不存在的同步失败 → disposition 2;标记一旦存在 → 任何错误/crash 一律 disposition 3**(即便网络调用实际没发出)。wake 无需独立标记 —— grant 已启动即选 retain。
  - **disposition 从 durable facts 推导**:终局 CAS 复查 activation / credential / turn / delivery / reservation / `grant_started_at` 持久行,**不信 coordinator 本地 stage flag**;crash 后证据不足 → 一律取 disposition 3(ambiguous/retain)。
  - **operator 清理事务具名(R3#2)**:扩展 `openOperatorRework` 的 quiescence-authorized 事务(或其调用的既有 operator cleanup 事务):revoke/fence 旧 activation 与 credentials → settle 旧 target/预约 → **然后才**铸后继 attempt。
  预算仍是同一个 hold_count,不加第二计数。

### 2.3 测试

- 连续失败 → hold_count 递进 + backoff 生效(claim 被 `next_retry_at` 挡住)→ 第 5 次转 needs_lead,outbox 恰 1 条,founder thread 0 条。
- crash/race:第 5 次失败与另一 tick 并发 claim → CAS 单赢家。
- **stage-aware 终局(R2#3 + R3#2 + R4#2)**:第 5 次失败分别发生在 admission / turn grant/projection / wake / post-wake projection 各阶段的终局断言;**crash 边界三组(R4#2 修订)**:`grant_started_at` 标记**前**崩、标记**后外呼前**崩、外呼可能成功后本地投影前崩 → 重启后 disposition 从 durable facts 复推(前者 →2,后两者 →3);**迟到的 credential 提交或延迟 wake 不得复活被取代的 attempt;任何测试不得观察到两个可行动 attempt**。
- needs_lead 后 dispatcher 不再扫描;pre-delivery 形 → `openOperatorRework` 可开新单;post-delivery 形 → operator 路径先证 quiescence。
- retryable 类失败同预算断言;run 已 held 不记次/不重复告警;`persisted_target_missing` 连续出现仍保持 held 且可被既有 pane-loss recovery 消费。
- 用**未覆盖 env 的真实默认值**推进 fake clock:第 5 击(~15m)先转 needs_lead并恰一条 Lead alert;30m rework alert与60m force-hold都不得先触发。另测 legacy stall仍在30m/60m生效,证明阈值拆分非删除守护。

## 3. 修复面 3:防空转谓词(R1#8 重定义)

插入点不变(mint 单一闸门 `StateStore.ts:26074`,事务内纯读),**谓词重定义**:

1. **谓词:只封 QA ghost,复用既有 claim resolver,不写弱化 raw query(R2#2)**:仅当 mint flavor 为 **QA kickback**(`authorityKickback === "qa"`)时,从 pinned decision contract 解析 QA 节点与其当前 attempt,调 `resolveWorkflowDecisionClaim({ decisionKind: "qa_verdict", predicate: "qa_passed", requiredAttempt, subjectKind: "git_head", subjectDigest })` —— **仅 `valid: true` 时抑制**。`subjectDigest` 缺失或不是可信 40-hex head 时 fail-open(照铸),不查 `"unavailable"`,不 throw。
   - resolver 已内建:run/node/decision-kind/subject 定界、`requiredAttempt` 的 latest-physical-attempt 铁律、同 attempt 矛盾 predicate 检测、选中后的 revocation + expiry 复查 —— raw「ORDER BY … LIMIT 1」形在 revocation 先于 LIMIT、expiry、同 attempt 冲突、跨 decision family 混比四处都有歧义(R2#2 逐条点名),弃用。
	- 不比较 `activeRequest?.base_revision`(initial kickback 无 activeRequest,R1#8)。attempt-1 PASS + attempt-2 FAIL 同 head → resolver 按 requiredAttempt 解析为 not-valid → 照铸(latest 铁律);幽灵场景(当前 attempt 的 PASS 有效在册还要铸)才被抑制。
	- **四种 mint flavor 明确分流**:QA kickback 走上述 predicate;founder feedback kickback **永远照铸**(gate 打开本来就必有同 head QA PASS,不能把 founder 修改意见变 held);chained verify 与 superseding request 也照铸,除非以后各自引入与其 authority family 对称的独立幂等证据,本单不拿 QA claim 代替它们。
2. **命中后的走向**:transition 照常**原子完成源节点**;跳过 rework 四表 INSERT 与 target 预约;**不** append `edge_traversed`、**不**把 `current_node_id` 指向被跳过的目标(R1#8);记 `rework_suppressed_idle_spin` 幂等事件;除非存在被证明的真实替代边,否则 run → `held` + 复用修复面 2 的单发 ticket-lane 升级。
3. **operator 路径不加谓词**(R1#8):`openOperatorRework` 无 head 输入,且 master 授权 + quiescence 检查的 operator 路径就是预期 escape hatch。

测试:QA flavor 谓词命中/不命中;**founder kickback 在已打开/已批准 gate 且同 head QA PASS 仍照铸**;chained/superseding 各自照铸;subjectDigest 缺失照铸;**同 head PASS-then-FAIL → 照铸**(latest 铁律回归);revoked-latest / expired-latest / 同 attempt PASS+FAIL 冲突 / 其他 subject 上更新的 QA attempt / 无关高 attempt founder/review claims(R2#2 五组)→ 全部照铸;QA 命中 → 无 rework 行、无 target 预约、无 edge_traversed、事件幂等。

## 4. 修复面 4:QA 节点 TTL 预配(qa 默认 6h)

1. **registry 默认**:`node-type-registry.ts` `NodeTypeRegistryEntry` 加平级字段 `submissionWindowMinutes?: number`(不进 capabilities —— 后者序列化进快照);`qa` entry 设 `360`。
2. **解析序**:保留现有 decision-contract topology gate:先要求 `resolveWorkflowDecisionContract(snapshot,nodeId)` 成功;仅 decision node 才用 `manifest 显式值 ?? registry[type] 默认 ?? 60`,非 decision node 一律 60m,避免仅凭 type=qa 给无 verdict topology 的节点扩窗。
3. **语义诚实化(R1#9)**:registry 默认是**可变的 issuance-time 运营策略** —— 明确文档 + 测试:已 pin run 的**新发**凭证也吃新默认(这正是「预配」要的:1628 类存量 run 立即受益);已发凭证不动;snapshot digest 不动(`workflow-run-snapshot.test.ts:63-79` 哨兵)。不做「pin 进新快照」变体 —— 那会让运营调窗永远追不上已 pin run,与验收锚背道而驰。
4. **堵三个旁路发行点**:共享 helper `credentialWindowForNode(snapshot, nodeId, now)`(复用 `computeSubmissionExpiry`),`runs-route.ts:2568-2578`、`workflow-rework-coordinator.ts:380-397`、`actions.ts:989-997` 改走 helper。**明示并测试 actions retry 路径的窗口扩张**(15m/60m → 按节点类型窗 + 24h absolute;qa retry 撞墙与 1628 同病,扩张是修复不是副作用,R1#9)。
5. seed 层不动(heavy tier 180m 显式声明优先于 registry 默认,自然覆盖)。

测试:真过期凭证 → `submitWorkflowDecisionByCredential` / `POST /api/workflow/decision` → 409 `credential_expired`(`StateStore.ts:25252` 首踩);qa 新凭证 6h、非 qa 60m、manifest 显式值优先;digest 哨兵;三旁路各一条窗口断言 + retry 扩张断言。

## 5. 修复面 5(续):僵尸重派根除

### 5② seed 合成断言

- **主守卫(CI 测试)**:table-driven —— 两个 seed 家族(12 file seeds + 全部 menu shapes 经 `compileWorkflowMenuSeed`,用 **live node-type registry** 合成快照)逐个断言 `resolveWorkflowGateAuthority` 不抛。落点 `workflow-menu.test.ts` / `workflow-template.test.ts`。
- **gate-proof 覆盖分离(R2#6)**:1.2 的 proof 规则依赖 runtime 行(`workflow_run_node`/activation/session/PR binding),**合成快照证不了** —— 其覆盖放 seeded StateStore 集成测试(§1.4),不塞进 seed 断言。
- **次守卫**:`scripts/verify-workflow-seeds.mjs` 补**结构断言**(`resolveWorkflowGateAuthority` 不抛,仅此)+ 接入 `package.json` scripts 与 CI。

### 5③ completed-without-receipt:dead-exec 专属分支(R1#3 重设计)

- **不动 `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`** —— 它是共享 FSM primitive(`applyTerminalTimestamp`、lifecycle launch 仲裁、物化、rework 恢复、phase 重入、divergence sweep 都在用);从里面摘 `completed` 会让正常完成 session 拿不到 `terminal_at` 并在无关恢复路径被重判为活。
- **改为 `reconcileDeadExecutions()` 内的专属判定**:`session completed ∧ node running ∧ 无 completion receipt` → **一个原子 StateStore CAS**:复查三事实 → run → `held` → 幂等 `completion_receipt_missing` 事件 → 恰一次 escalation(ticket lane)。**不 respawn**(活已干完,重做永远是错的)。其余 irreversible terminal 状态照旧走既有 dead/liveness 替换路径。
- **replacement 计数**:不改(前提修正 3)。补两次 Bridge 重启回归测试:completed-without-receipt 形不再触发 respawn,`launch_ordinal` 不增。

### 5④ generic 节点 no_code 出口:窄事务闭环(R1#5 + R2#4/#5 完整化)

- **能力面(R2#4 DTO 适配 + 复审 R1 存量策略)**:`GeneralizedExecutionDispatch.capabilities` 与 `BlueprintContext.workflowCapabilities` 现型为 `Record<string, boolean | string>` —— 数组装不进。改用 **boolean capability** `allow_no_code_completion: true`(registry generic entry;现 DTO 零类型改动)。新 pin 快照照常带 capability;为让已 pin 的 `tpl_generic` / `tpl_generic_menu` 在**部署后取得 fresh worktree/baseline 的新或 replacement launch**也能诚实关闭,completion 边界另用**窄 live-policy resolver**:`snapshot template id 属于内建 generic allowlist ∧ live registry 对该 node type 显式 allow_no_code_completion=true` 时,只放宽 `no_code` 这一条备选 route;任意自定义 template、未知 registry、registry 关闭都 fail-closed。它与 TTL 一样是 issuance/completion-time 运营策略,不改旧 snapshot/digest,且不放宽 `needs_review` 的 pinned route。部署前已在跑的 legacy-null worktree 即使 CLI 明示 route也按2.2 fail-closed;已 completed-without-receipt则由5③ held且不重派。1623锚须用部署后 fresh worktree 形验证,不误导 operator 在旧 worktree 上尝试。
- **prompt 贯通(R2#4)**:Blueprint 现只渲染 primary route(`needs_review` + `produces_output: true` → 指示 runner 提交 output 走 needs_review),新出口 runner 根本看不见。渲染显式 no-artifact 完成指令(「确无产出/取消时用 `complete --route no_code`,禁伪造 PR」)。
- **`produces_output` 修正**:no_code 分支放行「无 output credential 提交」的完成形,needs_review 分支维持现约束;**同事务 revoke 未用 output credential**(R2#4 —— 否则 run 完结后旧 credential 仍可被消费)。
- **⚠️ 缺失证据的信任规则(R2#4 安全洞 + R3#1 权威源具体化)**:**不能只信 runner 选的 route** —— 否则产出了 PR 的 runner 可省略 PR 证据、选 no_code、绕过 founder gate。no_code 分支 fail-closed 校验:
  1. 存在当前 output / PR binding / PR 证据 → **拒**(`no_code_artifact_present`)。
  2. **权威源(R3#1 + R4#1 封存点修正)**:admission 时封存**不可行** —— `admitGeneralizedWorkflowExecution` 发生在 `startDispatcher.start()` 之前,generic 无 `startPoint`,worktree 与其 generation 此刻尚不存在;`workflow_execution_binding` 有 no-update 触发器,可空列后补会弱化不可变性;单一 SHA/repo 对也表达不了多仓库。**改在既有权威 worktree-creation seam 封存**:`WorktreeManager.create()` 之后、runner launch 之前,Bridge-local `emitWorktreeReady`/`bindWorktreeOnce` 路径封存 baseline 集合,与 path/branch/generation 一起进**既有 set-once worktree-binding 权威组**;不把 activation binding 变通用可变。**不完整集合与 legacy(null)activation 一律不可用 no_code**(fail-closed;legacy-null 即迁移行为 —— 旧行无集合字段,直接不合格,无需回填)。补 sealing replay/ABA 测试。
  2a. **inventory 与 canonical 编码的具体定义(R5#1)**:**Bridge-owned pre-launch 枚举**,root 在真实 worktree 路径:记录 `__main__`(worktree 根仓库)+ 其内每个**验证过的**嵌套 Git root。每条 entry = `{ relative_path(normalized), remote_identity(normalized), baseline_head(40-hex) }`;按 `relative_path` 字典序排序;持久化 **canonical JSON**(及其 digest)进 worktree-binding 权威组的具名 set-once 字段(如 `repo_baseline_set_json` + `repo_baseline_set_digest`)。**完成时用同一枚举算法重跑,要求集合精确相等** —— 新建的嵌套仓库、消失的仓库、重复 identity、symlink 逃逸、任何 ambiguous 形 → **拒**。不用 EdgeWorker `repositories` map(路由级集合,不代表本 worktree 内的仓库根)、不信 runner 提交的 `targetRepoPath`(no-code caller 可以不给,不能定义缺失权威)。
  3. **完成时 fenced attestation**:no_code 完成前做仓库探测(HEAD、clean/dirty、未合入提交),closeout 事务内**复查 activation/worktree generation** —— generation 不符/证明缺失/过期 → 拒(探针 freshness 边界)。
  4. **仓库范围**:证明覆盖 bound worktree 内**全部已配置仓库**;嵌套仓库 scope 不明 → **fail-closed 拒**,绝不静默只查 root(嵌套仓库可藏 shippable delta)。
  5. 若实施中发现证据链无法在本单范围内补齐 → **`allow_no_code_completion` 保持关闭、出口拆 follow-up**,绝不弱化 founder-gate 边界(R3#1 兜底指令)。
- **窄事务闭环**(enrollment/transition 边界,不进 DAG 引擎核心):`generic + no_code` 完成 → 单事务:验 route/no-artifact 契约(上述规则)→ 写 completion receipt → source attempt 置 done → session 投影 `completed` + `terminal_at` → run 置 terminal `completed` → revoke 未用 credential → 幂等 `completed_no_artifact` 事件 → **不遍历、不物化 gate**。
  **理由**:founder gate 的意义是授权 ship;经证明无产物则无可授权。
- **外部收尾权威(R2#5)**:原子事务**只管** receipt/node/session/run —— `completed_no_artifact` 没有(也不该有)Linear 变更消费者;lifecycle closeout allowlist(`ship_complete | linear_reconcile | founder_park`)里 runner verdict 制造不了权威。1623 形(Linear 已 cancel)依赖**既有** terminal-Linear reconcile closeout 收尾并测试;活 issue 的外部 closeout 留待既有可信 disposition。若产品语义要 runner no-code verdict 推 Linear Done → **新权威机制,单独立项**,不藏在 run event 后面(→ honest boundary)。
- `needs_review` 完成(有 PR)→ 照走 gate → §1 打通的 runner_ship ship 链。
- **诊断步**:实施时读一个 pre-#748 generic run 的 event ledger,确认 engine_terminal 历史停滞点;若属独立断裂,如实报 Lead 拆 follow-up,不静默扩科。

测试:no_code 完成 → run completed、无 gate holder、无 node 预约、replay 幂等;**PR/output 在场 → 拒**;live-policy 对已 pin 两 generic template 放行 no_code、custom template/registry-off 拒绝且旧 snapshot digest 不变;**R3#1 七组**:root 未变 / untracked+dirty / 已提交 delta / 仅嵌套仓库 delta / run 期间目标分支推进 / worktree generation 过期 / 完成-探针竞态;**R5#1 两组**:run 期间新建嵌套仓库 → 拒(集合不等)/ containment+重复 identity → 拒;legacy-null 行不可用 no_code;未用 credential 事务后不可消费;prompt 渲染断言(DTO/build);已 cancel Linear issue 经既有 reconcile 收尾;`produces_output` 两分支;needs_review + PR → gate → binding(接 §1);两 template id 过 5② 断言。

## 6. 修复面 6:admission pause(R1#10 补 bootstrap/覆盖/时长)

1. **持久单行**:新表 `admission_pause(id=1 CHECK, paused_until, set_by, reason)`,镜像 `fleet_pressure_hold`。无 timer:probe 现读比较 now,过期自动失效;durable(重启保刹车)。
2. **执行点(覆盖证明,R1#10)**:
   - `RunnerAdmissionController.tryAdmit()` 加 sibling probe → typed reason `"admission_paused"`;`AdmissionDecision`/`AdmissionDeferredError` 增 `retryAfterSeconds`,`runs-route.ts` 直接 precheck 与 typed-error handler **两处**都带 `Retry-After` 头。
   - retry chokepoint 是 **`RetryDispatcher.dispatch()`**(`runnerAdmission` 现只属 `RunDispatcher`,R1#10 纠正)—— probe 穿线进基类(或显式 override)。**engine auto-advance 必须在 `admitGeneralizedWorkflowExecution` 写 activation/credentials 之前先 probe pause**;命中 pause 时本 tick 零 durable admission/credential/launch-owner 写入,避免制造 admitted-but-unlaunched stall。以测试证明七类 lane(HTTP start、**engine auto-advance**、phase handoff、auto-QA、rescue、retry、dead-exec replacement)全部过闸。
   - pause 检查放在 untyped `accepting` shutdown 判定**之前** —— 重启窗口的契约统一为 429,不落 500。
3. **端点**:`POST /api/admission/pause {durationSeconds}` / `POST /api/admission/resume`。独立前缀(gemini scoped token 够不着)+ Bearer master token + fail-closed 503 包装(`plugin.ts:2122-2134` 习语)。durationSeconds 上限 1h。
4. **restart-services.sh + staged rollout(R1#10 bootstrap 悖论)**:
   - **本单(阶段 1)**:land 端点 + probe + 脚本 Step 0(`deploy_and_verify` 内、self-detach 块之后,`notify_routine` 后 `stop_bridge` 前)POST pause,**默认 lease = 1800s(30m,大于既有 15m health gate、小于 1h cap)**;post-health 后显式 resume(失败不致命,TTL 兜底);`rollback_and_restart` 同 Step 0。**脚本侧 best-effort**:首次自部署时旧 Bridge 没有 pause 端点,失败必须放行 —— 并在输出里明示「pause unavailable (pre-feature Bridge), proceeding without brake」。首次部署的一次性人工 quiesce 要求写进 ship 备注。
   - **防静默冻结**:Bridge `/health` 暴露 `admissionPause: {active, remainingSeconds}`(无 secret/reason 原文);pause-aware Bridge boot 后若 pause 连续 active 5m,复用 durable `workflow_engine_escalation` 向 Lead ticket lane 发按 pause generation 去重的单次告警。健康检查仍可判 Bridge 存活,operator 同时能看到刹车状态;resume/TTL 过期自动清 active 状态。
   - **阶段 2(follow-up,兼容性确立后)**:pause 确认失败转 fail-closed。本单不做,写进 honest boundary。
   - **回滚边界措辞(R2#6 修正)**:回滚到前置版 Bridge 后,该 Bridge 在其运行期间**立即且无限期**无视 pause row —— TTL 只防「pause-aware 版本回来后的陈旧刹车」,**不防**回滚期间的 admission。如实记为已知边界。
5. 测试:pause → `/api/runs/start` 429 + Retry-After;retry lane 同拒;**七 lane** 覆盖证明且 engine auto-advance 命中时无 activation/credential 写入;TTL 过期放行;mid-boot 持久;resume 即时;health 显示 remainingSeconds;boot 后 5m 仍 active 只发一条 Lead alert;无 token → 503;`test-restart-services.sh` 补 Step 0 时序、secret 不进 argv、1800s>health-timeout、确认失败放行、rollback 行为。

## 7. 修复面 7:launch(点火)孤儿自锁

本节是 2026-08-05 06:27 后追加范围,来自 FLY-1572 三连挂。边界仍是既有 generalized launch owner + tmux launch gate,不另造第二套点火状态机。

### 7.1 completed 代同名 tmux 窗口冲突

- **病灶前置顺序**:在会抛 `TmuxSessionHoldError` 的 `ensureSession()` **之前**执行 `purgeTerminalSameNameWorkflowWindows`:若目标 tmux session 存在,按精确窗口名列出不可变 window id + 既有 `@flywheel_exec_id` + 新增 `@flywheel_launch_generation`/非秘密 fingerprint,由 Bridge 注入的只读 predicate 查询不可变 execution/generation authority;只有「不同 execution 已 terminal」或「同 execution 的旧 generation 已 durable released/fenced」且 identity 三元组全对齐时,才按 window id 逐个关闭,随后 re-list 证明候选归零。`needs_lead` 不算 terminal;5③ 的 completed-without-receipt 只有 dead-exec CAS 已提交后才算 terminal。session 不存在则直接进入 ensure。顺序固定为 **purge → ensure → verify-zero → new-window**,与 `codex-runner-tui-window.ts` 的既有 precedent 对齐。
- 若首次 ensure 仍返回 hold,只允许再做一次 bounded purge + re-ensure;第二次失败转 7.4 typed error + 7.2 owner release,不无限 rescue。测试 fixture 必须让「stale terminal windows 存在时 ensure 会 hold、purge 后 ensure 成功」,不能只测 non-saturated duplicate-name。
- **仅 terminal + identity 对齐**时自动关闭;活跃、无 execution identity、多个候选或探针异常都不得猜杀。predicate 未注入的 adapter caller 默认是 **cannot prove terminal**(绝不 fail-open kill)。legacy/option-write 失败导致无 `@flywheel_exec_id` 是正常形,走不杀分支。
- ensure 成功后若仍有不可证明可杀的同名窗,新 generation 使用包含 **execution 短 hash + owner generation** 的确定性 suffix;先为 suffix 在 50-char sanitize 上限内预留空间再截 canonical 部分,并对最终选择名再 preflight,避免 suffix 被截掉。实际窗口名与 launch fingerprint 写入 CommDB / StateStore;同时发一次去重 Lead orphan-window alert。后续 generation 清掉可证 stale 窗后应回归 canonical label,不永久漂移。suffix 只解决 name collision,**不宣称解决 server capacity**;若 capacity 已 hold,仍走 bounded failure/release。
- 不按模糊名字批量 `kill-window`,不关闭共享 tmux session,不把一个窗口冲突升级成 server rescue。`@flywheel_exec_id` 已由 FLY-1374 存在,本单是**复用并加固**:generalized 窗在 launch commit 前必须成功发布 execution + generation/fingerprint。publish 失败时 adapter 手上已有 immutable window id,必须先对 `=${sessionName}:${windowId}` 精确 kill 并 verify absent,再报告 pre-commit failure/release;cleanup 失败或 indeterminate则保留 owner并返回 pending + 单发Lead alert,绝不制造无identity且已release的永久 orphan。legacy caller 保留 best-effort兼容,无identity自然不杀。

### 7.2 内联点火失败释放未提交 owner(≤5min)

- **先打通 pre-commit outcome seam**:`RunDispatcher.start()` 返回一个 launch handle,其可选 `outcome` field 只覆盖 Blueprint/adapter 的 pre-commit生命周期(不是runner lifetime)。`outcome` **never rejects**,永远 resolve typed union `committed | precommit_failed`;这样九个 caller 中不消费它的 legacy/auto-QA/rescue/phase 路径不会产生 floating rejection,现有 scaffold/test dispatcher 也因字段 optional保持可编译。`Blueprint` 早到 `session_started` 逻辑行不算 physical launch;`TmuxAdapter` ensure/window/identity failure穿过 background catch resolve到outcome,HTTP route与engine successor dispatch共用。HTTP可bounded wait后返回typed pending,只有precommit failure且release成功才`retryable:true`;不再用`waitForSession()`逻辑行判断物理出生。
- 把真正的 uncommitted owner lease 收口成 `UNCOMMITTED_WORKFLOW_LAUNCH_LEASE_MS = 5min`,只用于 initial acquire/renew;output credential TTL 与 committed delivery-repair lease 原样。pause 必须在 owner acquire 之前 probe,命中 pause 时 owner generation/credential 零 churn。
- outcome in-flight 期间启动 **≤60s cadence heartbeat**,每次用 execution + owner id + generation + delivery attempt CAS renew;任一 renew 失败即 fence 本地 launch、不得越过下一 side-effect boundary。engine reconcile 的同 stable owner polling**不得隐式续租**,只能由这个明确 in-flight heartbeat renew。pre-commit hard deadline <10min tripwire;合法 210s ensure 可跨 5min 持续 renew,Bridge crash则 heartbeat 停止。
- owner 表加显式 released-generation tombstone(如 `released_generation` + `released_at/reason`)。`releaseFailedWorkflowLaunch` 单事务复查 execution + owner id + generation + delivery attempt、`committed_generation IS NULL`、marker 缺失、pane/window callback 无匹配 physical generation,然后把 generation 标成永久不可 renew/commit、lease 立即到期并 revoke 本 generation 未消费 credential。**早到逻辑 session 行不否决 release**。保留 immutable execution/admission/reservation,下一 acquire 无论 random route owner 还是同 stable engine owner都 CAS 到恰好 generation+1;绝不 DELETE owner,不用永久 cancellation。
- outcome 报同步 throw/ensure hold/identity publish failure或 hard deadline 前确认无 physical commit时调 release。若 CAS 发现 marker/physical window/commit 已出现,说明越过回滚边界,返回既有 `GENERALIZED_LAUNCH_PENDING` 收敛,不得误回滚真实 runner。
- generation 1 的迟到 renew/commit/marker/window-publish 全部检查 `generation > released_generation` 并拒绝;generation 2 token不释放 generation 1 gated shell。自然接管也复查无 durable marker/physical-generation/committed generation。Bridge crash无显式 release时,5min lease到期即可 generation+1 接管;10min tripwire另清 admission residue,两锚分开。
- **tri-state 物理证据谓词(item-7 R2#1,immediate release 与 crash tripwire 共享同一条规则)**:现 `persistPaneLossGenerationCredential` 只存 socket + server start time —— 那是 server 代身份,不是精确窗口凭证;且 `beginUnlaunchedWorkflowCancellation` 在查 `launch_owner_live` **之前**就因 `lifecycle_claim_present`/`session_present` 拒绝(`StateStore.ts:17547-17561`)—— 而逻辑 session/lifecycle claim 在 adapter 之前**总是**已存在,crash 型孤儿 tripwire 永远清不掉。统一谓词:
  1. marker 或 committed generation 存在 → **committed,绝不 release**;
  2. 精确持久 `(socket, server start, window id, execution, owner generation/fingerprint)` 在册、或其探针 indeterminate → **pending/held,绝不 release**(callback 持久化随本单扩到含 window id + generation,凭证才成「精确窗口」级);
  3. 无 callback 记录、或该精确记录窗已 fenced/清理并**证明缺席** → pre-commit release/cancellation 放行,**早到逻辑 session 行与 lifecycle claim 不构成否决**;放行的 rollback 在同事务内原子关闭/fence 这些 pre-commit 逻辑残迹(session 行、lifecycle claim),之后 generation+1 才可 launch。

### 7.3 attempt=1 design 的 predecessor 合法空态

- `workflow-engine-dispatcher` predecessor resolver 先排除 `startRetryExecutionId === intent.execution_id` 的自指。`node.type === "design" && attempt === 1` 且 snapshot 无入边时是 root launch:不查 predecessor、不填 `startPoint`,直接走项目默认 base。
- implement / qa、design attempt>1、或 manifest 声明有 predecessor 的 design 仍 fail-closed `engine_predecessor_unavailable`;不把缺失证据普遍放宽。
- 剩余 fail-closed predecessor 错误不计入 §2 rework delivery budget、也不直接改 `needs_lead`;按 run/node/attempt 去重并退避日志,由 unlaunched tripwire 在 10min 边界做 durable 升级/rollback,消除 1s 空转。

### 7.4 start 错误合同与诊断

- generalized start 边界消费 7.2 outcome 并统一返回 machine-readable body:`code`(稳定顶层错误码)、`reason`(稳定分类)、`executionId`、`retryable`;已知 tmux hold/窗口 identity/launch timeout 映射到 typed 409/503;仍在 in-flight 则 202/pending。未分类异常可保留结构化 500,但不得再是裸 `internal error`。
- server log 用 `console.error` 记录 issue/run/node/execution/owner generation + 原始 error stack;HTTP body 不回传 stack、路径或 secret。
- 结构化失败只有在 7.2 原子 release 成功后才声明 retryable;release 竞态失败而 durable launch 可能已前进时返回 pending,避免客户端重试制造双 launch。

### 7.5 审计补注(research §6,四点增量 —— 不改写 7.1-7.4 的设计)

1. **病灶阶段核实(机制注记)**:审计确认 `tmux new-window -n` 同名**不报错**;事故的 throw 来自 **session 级** `ensureRunnerSession`(`TmuxAdapter.ts:1509-1620`,hold kinds 是 rescue helper 的 server 分类)—— stale 窗与 500 的关联机制是「窗堆积 → server/命令队列饱和 → ensure held」(research §6.1)。因此 7.1 已把清理固定前移到 ensure 之前;实施第一步真机复现并记录精确 hold 分类,但不得把清理退回 ensure 之后。
2. **identity 契约加固**:`@flywheel_exec_id` 已存在且 lookup 已消费,但当前写入 best-effort、execution-only。generalized 路径新增 generation/fingerprint 并在 commit 前 fail-closed 发布;legacy caller 无变量/写失败仍落「不猜杀 → generation suffix」分支,不误杀。
3. **tripwire 与 owner 接管分工**:launch 专用 `FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS` 默认 **5min**、`...ROLLBACK_MS` 从60min降到 **10min**(> lease5min);rework reconciler改读§2独立30m/60m knobs,绝不共用。5min锚针对live owner lock;10min只清admission/credential residue。同时把引擎对`launch_owner_live`静默吞改为计数+结构化日志可见。operator手动触发若默认时序已达锚则不加。
4. **5min lease 与慢 launch 的时序核对**:早到逻辑 session 使现有 `waitForSession` 90s 不能当物理 budget;权威 budget 改为 outcome seam 的 pre-commit deadline(<10min)。heartbeat 从 pre-worktree 开始、≤60s renew,在 outcome settle/finally 停止。测试覆盖跨完整 ensure budget的合法慢 launch、Bridge crash、stuck in-process launch与 stable engine owner。

### 7.5a 测试

- adapter/dispatcher seam:**可复现 ensure-hold 的 stale terminal window fixture**在 pre-ensure purge 后正常 launch;terminal 同名窗仅按 immutable id 关闭;活窗口不关闭且新窗用确定性后缀;identity 缺失/多候选/uninjected predicate 不误杀并发单次 Lead alert;第二次 ensure hold typed fail,无无限循环。
- identity publish失败→精确kill刚创建的window并verify absent后才release;kill失败→pending/owner保留/单发alert。非消费caller触发precommit failure时outcome仍resolve且零`unhandledRejection`。
- terminal predicate:workflow `needs_lead` 不可杀;completed-without-receipt 在 dead-exec CAS 前不可杀、提交后可按 exact identity 清;released older generation 可杀当前 execution 的旧 pane。
- route + StateStore:真实 typed `TmuxSessionHoldError` 穿过 background dispatcher outcome → generation 1 立即 tombstone/release → HTTP typed retryable;早到逻辑 session 不阻止 release;同 key分别用 random route owner与同 stable engine owner取得 generation 2;generation 1 迟到 renew/commit/marker失败;release 与 physical commit race单赢家;Bridge crash无 release时 clock +5min 可接管。
- engine root:attempt=1 无入边 design 可 dispatch 且 `startPoint` 缺省;implement、qa、design retry 缺 predecessor 仍拒绝;start reservation 自指回归。
- HTTP:每个已知 failure/pending 的 status + `code/reason/executionId/retryable` 精确断言,未知异常有结构化 500且日志含 stack、响应不含 stack;engine auto-advance用同 outcome补偿且 pause命中时不 acquire owner。
- 补注组(7.5):crash 型孤儿在 10min rollback 内被 tripwire 回收(lease 5min < rollback 10min 时序断言);合法慢 launch 经 renew 不被误回收;`launch_owner_live` 吞噬计数可见;legacy 无变量窗走换名分支不被杀。
- 默认时序交叉断言:launch alert/rollback=5m/10m;rework budget≈15m < rework alert/hold=30m/60m,两 reconciler互不读错 knob。

## 8. 验收锚映射(全部活体)

| 锚 | 修复面 | 验证方式 |
|---|---|---|
| 1631 approve 后 verify 撞 binding_unavailable → 零人工 | 1+5① | 真机:schema-v2 DAG run QA PASS → founder approve → verify-approval ok → merge 全程零人工 |
| 1631/1596 held 刷屏 → 停在 5、告警只到 Lead | 2 | 注入连续 hold 失败 → backoff 递进 → needs_lead;Lead channel 恰 1 条、founder thread 0 条 |
| 1631 implement@3 幽灵 rework → 不铸 | 3 | 同 head latest=PASS 重放 → 无 rework 行 + suppressed 事件;PASS-then-FAIL 对照 → 照铸 |
| 1628 QA 凭证 1h 墙 → 6h 窗 | 4 | 新 qa 凭证 expires-issued=6h;3.7h 模拟不过期;真过期 → 409 回归 |
| 1634 部署期间派发 → 明确稍后再试 | 6 | restart 窗口内 /api/runs/start → 429 typed + Retry-After |
| 6 个 generic 单零重派 | 5③(+1/5①) | 重放 completed∧无receipt 形 → held 不 respawn;双重启 → launch_ordinal 不增 |
| tpl_generic_menu completed > 0 | 5④ | 真机 generic 单 no_code 收尾 → run completed |
| 取消单(1623 形)正常关闭 | 5④ | no_code 完成,无伪造 PR |
| 96 快照普查 6 例 incoherent_ship_bundle 归零 | 5① | 普查重跑 → 0 |
| FLY-1572 旧 run 判终后立即重派 | 7 | terminal 同名窗自动清理/换名;attempt=1 design 零前任可点火;失败 owner ≤5min 或立即 release;start 返回 typed error |
| 真机 E2E:完整 DAG run QA PASS → 自 ship → 收尾级联 | 全部 | 一条真 issue 走全链 |

## 9. 实施切分与顺序(R1#11 重排)

单 PR,提交按依赖序,每步测试先行:

1. **gate-proof + resolver**(1.1+1.2,含消费点回归测试)——一切 ship 链的地基。
2. **seed 合成断言**(5②)——立即锁住 1 的成果。
3. **binding 写入 + supersede + rebind**(1.3,bound 谓词收紧)。
4. **generic no_code 出口**(5④)—— 内部顺序:**authority capture 先行**(worktree-creation seam 的 baseline 集合封存,R4#1)→ capability/prompt → closeout 事务(含 produces_output 修正)。
5. **completed-without-receipt 专属分支**(5③,不动共享终态常量)+ 双重启回归。
6. **rework 迁移**(2.1)→ **原子封顶 + backoff + 预约回滚**(2.2)。
7. **防空转谓词**(3,在 latest-claim 规则确立后)。
8. **TTL**(4)。
9. **launch 孤儿闭环**(7),内部依赖序:**released-generation tombstone + 5min owner/heartbeat** → **pre-commit outcome plumbing**(adapter→Blueprint→dispatcher,route/engine共用)→ root predecessor + bounded tripwire → generation-safe window identity/name + pre-ensure purge → typed route mapping。pause-before-owner 与 §6 交叉测试先过,再接 window side effect。
10. **pause API/probe → 脚本 Step 0**(6,API 先于脚本依赖)。
11. docs/milestone 尾提交。

专项测试组(R1#11):boot/migration 组、crash 边界/幂等组、旧 pin 快照组、restart/rollback 组;全过后才跑活体锚 + 96 快照普查。
全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + `scripts/test-restart-services.sh`。
Codex code review(`codex:rescue`)循环至 APPROVED;真机 E2E 由独立 QA 节点承接(本设计节点不 ship)。

## 10. Honest boundary

- 消息层展示形态(通知折叠、held 告警措辞)→ FLY-1569 D/E。
- runner no-code verdict 推动**活** Linear issue 到 Done = 新权威/effect 机制 → 单独立项(R2#5);本单只做 DB 侧原子闭环 + 已终态 issue 的既有 reconcile 收尾。
- no_code baseline sealing 只在 Bridge-local `emitWorktreeReady`/`bindWorktreeOnce` 权威路径可用;HTTP `ExecutionEventEmitter` 为避免 runner-visible token 篡改 binding 会接受但不传 baseline,该模式因此 fail-closed 不可 no_code(仍可 needs_review),另行补可信 server-side binding transport 前不放宽。
- pause 的 fail-closed enforcement(阶段 2)与「回滚到前置版 Bridge 运行期间无视 pause row」边界 → 兼容性确立后的 follow-up;本单 best-effort + TTL 自愈。
- pre-#748 generic run 的 engine_terminal 历史停滞若属独立断裂 → 诊断后如实上报拆单。
- `held` 既有语义、`MAX_BLIND_REPLACEMENTS` 数值与其 ledger 计数权威、founder-only merge 契约、`verify-approval` 安全检查、`ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES` 常量:全部不动。
- 96 快照普查中非本六单的 `:162`/`:174` 类 incoherent 形(若有)不在本单 —— 真不一致,保留 fail-closed。
