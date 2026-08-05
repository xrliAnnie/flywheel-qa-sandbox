# FLY-1638 self-ship 自动化收尾 — 调研

Issue: FLY-1638 (https://linear.app/geoforge3d/issue/FLY-1638/self-ship-自动化收尾1625-修复合一单-ship-绑定修复-重试封顶-防空转-qa-ttl-预配-重启前暂停接活)
日期: 2026-08-04
基于: exploration.md

> 本文是五路并行代码审计的汇总。所有 file:line 均对着 branch `flywheel-FLY-1638`(base = main `779ebc21`)核实。

## 1. QA 节点 TTL(修复面 4)— 审计完成

### 1.1 现状机制

- **表**:`workflow_submission_credential`(`StateStore.ts:15218-15247`)。存 `node_id` 不存 node type;`expires_at` + `absolute_deadline_at` 双栏;live-credential 唯一索引 `(run_id,node_id,attempt) WHERE consumed_at IS NULL AND revoked=0`。
- **1h 常量**:`bridge/workflow-engine-dispatcher.ts:105-122` `credentialExpiryForNode()`:
  ```ts
  const configuredWindow = snapshot.manifest.nodes.find(n => n.id === nodeId)?.submissionWindowMinutes;
  const windowMinutes = decisionContract ? (configuredWindow ?? 60) : 60;
  ```
  `?? 60`(行 115)即 1h 窗;仅 decision(出 verdict)节点可被 manifest override,非 decision 节点硬钉 60。绝对上限 `now + 24h`(行 110),由 `workflow-submission-expiry.ts:1-13` `computeSubmissionExpiry` 取 min。
- **绝对 TTL,非滑动**:runner 心跳/活动不续期。仅 dispatcher 两处 re-dispatch 轮换会重算(`workflow-engine-dispatcher.ts:1994` idempotent-replay、`:2031` delivery repair)。这就是 1628 机制:3.7h 真机 QA 跑赢不了 dispatch 时一次性发的 1h 窗。
- **发行点共 4 个**:
  1. 引擎主路径 `workflow-engine-dispatcher.ts:1856-1884` → `store.admitGeneralizedWorkflowExecution({expiresAt, absoluteDeadlineAt})`(INSERT 在 `StateStore.ts:20839-20867`;StateStore 从不自算窗口,全由 caller 传入)。
  2. `bridge/runs-route.ts:2568-2578` — 硬编码 `now + 60m`。
  3. `bridge/workflow-rework-coordinator.ts:380-397` — 硬编码 `now + 60m`(rework/wake activation)。
  4. `bridge/actions.ts:989-997` — `now + 15m`(retry dispatch,deadline `now+60m`)。
  旁路 2-4 完全绕过 `credentialExpiryForNode` —— **修复必须覆盖它们,否则 qa 节点经 rework/retry 路径进来还是撞旧窗**。

### 1.2 过期后 runner 看到什么

- 拒绝发生在 verdict 提交(`flywheel-comm qa-result` → `POST /api/workflow/decision`),非 `complete`。
- Store 检查:`StateStore.ts:25246-25254`(`submitWorkflowDecisionByCredential`)→ `{ok:false, reason:"credential_expired"}`;到达 expiry 瞬间即算过期(`:15564-15567`)。
- HTTP 映射:`workflow-decision-routes.ts:458-462` → **409 credential_expired**。
- Runner 侧:`qa-result.ts:37` 把 `credential_expired` 列为确定性拒绝 → 不重试,写 fail-close marker 后 `exit(1)`。过期后 verdict 无合法逃生口(legacy `/events` 回 409 `workflow_submission_required`,`event-route.ts:1000-1006`)—— verdict 丢失,只能 Lead 侧 rework/重派。

### 1.3 node type 是否在发行点可得

**可得,零新 plumbing**:`credentialExpiryForNode` 已经 `find` 出 manifest node 对象(`workflow-engine-dispatcher.ts:112-114`),`.type` 就在同一对象上。node type 全集:`packages/config/src/node-type-registry.ts:1-8`(design/implement/qa/gate/land/generic/review)。

### 1.4 配置面与 pin 语义

- 自然归宿:`node-type-registry.ts` 的 `NodeTypeRegistryEntry`(`:34-40`)加 `submissionWindowMinutes` 字段(qa entry 在 `:92-103`)。TTL 是默认值不是 capability,放 entry 平级字段,不动 capabilities 形状(它会被序列化进快照比较)。
- **pin 语义关键区分**:manifest 声明的 `submissionWindowMinutes` 是 digest-pinned(改了会动 `workflow-run-snapshot.test.ts:63-79` 的 digest);registry 默认值在 dispatch 时现读,**不进 digest** —— 新默认对新发凭证立即生效、不动已 pin 的 run。这正是「预配」想要的语义。
- 既有约束:validator `assertSubmissionWindowsTargetDecisions`(`workflow-template.ts:208-234`)只允许 decision 节点带窗口 —— qa 是 decision 节点,不需放宽。
- 既有部分修复(FLY-1501):仅 heavy tier 把 qa 窗设到 180m(`tpl_eng.yaml:50` 等);light/trivial/generic/product 模板全是 60m 默认。3.7h 实测连 180m 都不够,支撑 6h 默认。

### 1.5 测试缺口

现有测试覆盖 `computeSubmissionExpiry`、pinned-digest、rotation、409 分类;**但没有任何测试驱动真·时间过期凭证走 `submitWorkflowDecisionByCredential` / `POST /api/workflow/decision` 断言 409 credential_expired**(`StateStore.ts:25252` 无人踩)。这正是 1628 回归用例,本单补上。

## 2. RC-B ship 绑定断链(修复面 1)— 审计完成

### 2.1 根因一句话

`workflowRunRequiresShipTarget`(`StateStore.ts:23343-23355`)把**所有** binding 写入钉死在 `schema_version === 1 && manifest_variant === "land_v1"`;而 `/head-authority` 读路径(`workflow-decision-routes.ts:311-322`)对**任何**带 `approve_question_id` 的请求都要求 binding 行存在 —— schema-v2 run 的 gate 物化把 `workflow-gate:*` question id 写进 `sessions.review_question_id`(raw UPDATE,`StateStore.ts:28188-28203`,绕过 `setReviewBinding`),但**不写 binding 行**。founder 批准本身成功(approval-signal 侧不读 binding 表),runner 随后的 `verify-approval` 撞 409 —— 与「第 17 个撞墙者」症状完全吻合。

### 2.2 关键机制

- **表**:`workflow_ship_target_binding`(DDL `StateStore.ts:14676-14692`,PK = `approve_question_id`;`target_repo_path` / `target_repo_identity` / `probe_repo_slug` / `frozen_head_sha`(40-hex CHECK)/ `worktree_binding_generation`)。
- **唯一 INSERT 点**:`recordWorkflowShipTargetBindingTx`(`StateStore.ts:23357-23423`)。两条到达路径:
  (a) legacy session 路径 `setReviewBinding`(`:5782-5836`,生产 caller 仅 `event-route.ts:1788-1794`);
  (b) 引擎 land 路径 `bindWorkflowShipTargetForGateTx`(`:23425-23446`)—— 第一行就被 `workflowRunRequiresShipTarget` 短路,schema-v2 直接 return。
- **读路径**:`POST /api/workflow/head-authority`(`workflow-decision-routes.ts:304`,loopback-only)。带 `approve_question_id` 时:无 binding 或 superseded → throw `ship_target_binding_unavailable`(`:322`)→ HTTP 409。不带 question id 时 fall through 到 `resolveWorkflowHeadAuthority`(纯 `git rev-parse HEAD`)—— schema-v2 只有 binding 分支坏。
- **caller**:`flywheel-comm verify-approval`(`verify-approval.ts:137-266`)从 sessions 表读 `review_question_id`,绑定时**总是**带上 question id;非 ok 原因被折叠成 `head_authority_unavailable`,具体错误串只在 stderr / Bridge 409 body。
- **authority 双建模不对称**:`resolveWorkflowGateAuthority`(`workflow-run-snapshot.ts:142-183`)对 schema-v2 返回 `runner_ship` / `engine_terminal`,驱动 gate-holder 创建与 `gate-authority-view.ts`;但 `/head-authority` 的 binding 分支只认 land 语义 —— 权限模式在两处建模,只有一处教过 runner_ship。

### 2.3 修复插入点(数据已存在,纯接线)

schema-v2 的 completion 路径已写 `workflow_node_pr_binding`(`recordWorkflowNodePrBindingTx`,`StateStore.ts:24593-24680`;`generalizedExecutionContextForBinding` 明确放行 schema-v2,`:20512-20520`),该表正好携带 binding 需要的全部字段,可经 `getCurrentWorkflowNodePrBindingForHead`(`:30253-30262`)读出。三个插入点:

1. `StateStore.ts:23343-23355` — 放宽 `workflowRunRequiresShipTarget`:schema-v2 且 `resolveWorkflowGateAuthority(snapshot).mode === "runner_ship"` 也返回 true(`engine_terminal` 保持 false,无 repo 可绑)。
2. `StateStore.ts:28203-28218` — `createWorkflowGateHolderTx` 在 `carrierBindingState = "bound"` 确立后调 `bindWorkflowShipTargetForGateTx`,镜像 land_v1 在 `:26361` 的调用;必须同事务,且对 `engine_terminal`/`unbound` 情况不抛(否则 gate 创建自身 fail-closed)。
3. `StateStore.ts:30583-30603` — 手动逃生口 `rebindWorkflowGateCarrier`(`/api/workflow/gate-carrier-rebind`)同样只写 `review_question_id` 不写 binding,今天连手工修复都救不回 verify-approval,需同样补写。

### 2.4 测试缺口

现有 `/head-authority` binding 测试全部手工种行(raw SQL 或 legacy `setReviewBinding`);**没有任何测试驱动 schema-v2 / `gate_carrier_epoch=1` / runner_ship run 走完 gate 物化后拿真 `workflow-gate:*` question id 调 `/head-authority`**。这条 seam 上的回归测试是修复的最便宜守卫。

## 3. rework 重试封顶 + 防空转(修复面 2/3)— 审计完成

### 3.1 redelivery 机制与刷屏根因

- **表**:`workflow_rework_delivery`(`StateStore.ts:15174-15187`),state enum = `pending / turn_granted / wake_delivered / replacement_pending / completed / held`。姊妹表 `workflow_rework_request` 不可变(no-update/no-delete 触发器 `:15201-15214`)。
- **驱动**:Bridge 1 秒 timer(`workflow-engine-dispatcher.ts:259-274` → `reconcile()`;redelivery 循环 `:698-820`,扫 `pending/turn_granted/held`)。boot 无独立 drain,就是重启同一 timer → 重启后重捡所有非终态行。
- **attempt 计数:不存在** —— 只有 `generation`(每次 claim +1,`StateStore.ts:20012`),无上限。失败行**每秒**被重 claim。
- **刷屏本体**:`releaseAndHold`(`workflow-rework-coordinator.ts:210-233`)每次失败迭代都 `effects.alertHold` 发一发告警;且命名陷阱 —— 返回 `kind:"held"` 但**行仍留在 pending/turn_granted**(release UPDATE `:20062-20066` 只碰这两态)→ 下一 tick 又 claim 又 alert。502 代/980 代刷屏即此。循环型 hold 原因:`rework_reentry_disabled` / reentry `hold` / `worktree_not_ready:*` / `holder_activation_failed:*`。
- **现成封顶模板**:同引擎的 `workflow_alert_outbox`(`StateStore.ts:14899-14912`)claim 查询就是 `WHERE attempt < 3`(`:22543`),`finishWorkflowAlertDelivery` 做 `attempt >= 3 ? "failed" : "pending"`(`:22612`)—— ≤5 封顶照抄此形。

### 3.2 告警去向:现在 vs 应该

- 现在:`alertHold` 发 `eventType: "three_stage_stuck"`(`plugin.ts:8601-8624`)—— 属 `ISSUE_PROGRESS_KINDS`(`infra-event-router.ts:100-108`)→ 绑了 `[FLY-XX]` thread 时路由 `issue_thread` → **founder thread 刷屏管道本尊**。
- 应该:封顶终态告警走 **ticket lane** —— `enqueueWorkflowEngineAlertTx`(`StateStore.ts:22125-22152`,与状态变更同事务)+ `eventType: "workflow_engine_escalation"`(不在 ISSUE_PROGRESS_KINDS → 默认 `ticket` → 统一 Lead alert channel;`LeadAlertNotifier.ts:114` 已在 allowlist,channel 解析 `:1390-1403`:unified channelId → lead.alertChannel → generalChannel)。现成镜像:stall 升级 `escalateWorkflowReworkStall`(`StateStore.ts:18081-18114`)。同时**停掉每迭代 alertHold**。

### 3.3 `needs_lead` 状态

- 目前**不存在**(全仓 grep 只命中 issue 文本)。最近似的 `held` 不是真终态:dispatcher 扫描集明确含 `held`(为 FLY-1596 pane-loss 恢复分支,`workflow-engine-dispatcher.ts:706-777`)。
- 加 `needs_lead` = 真终态、被扫描集排除。需改:CHECK 约束迁移(现成迁移模板 `StateStore.ts:15009-15090` 的 table-rebuild 形)、`advanceWorkflowReworkDelivery` allowed 表(`:20115-20126`)、`claimWorkflowReworkDelivery` claimable 集(`:19983-19992`)、`listWorkflowReworkDeliveries` 默认(`:19527-19531`)、dispatcher 扫描态(`:706-708`)、类型 `WorkflowReworkDeliveryRow["state"]`(`:33810`)。
- `workflow_run.status` 是自由 TEXT 无 CHECK(观测值 active/held/completed/terminated);run 级别继续用 `held` 即可(`runs-route.ts:419` 的 operator terminate 已 gate 在 `held` 上)。

### 3.4 rework mint 与防空转谓词

- **mint 只有两处**:`openOperatorRework`(founder/operator,`StateStore.ts:21966-21971`;已有 `rework_already_open`/`target_attempt_already_reserved` 守卫 `:21815-21840`)与 `commitWorkflowTransitionTx`(引擎,delivery INSERT `:26219-26223`)—— **1631 幽灵 rework 出自后者**。
- **mint 单一闸门**:`StateStore.ts:26074` `if (reworkAuthority && reworkRequestId)`;四种 mint 味道(qa kickback / founder kickback / chained / superseding)全经此闸。既有唯一 cap 是 loop 迭代上限(`:25971-26014`,只 cap QA-fail loop,不 cap chained/superseding mint,更不 cap delivery retry)。
- **mint 时无任何 head/PASS 比较**(head 只记录不比较,`:26095`)。谓词所需数据全在事务内 scope:当前 head = `input.subjectDigest`(40-hex 已验),先前 head = `activeRequest?.base_revision`;PASS 查询 = `workflow_claims` 表(predicate `qa_passed`,revocation 联查,raw 形 `:29060-29070`)或公共 resolver `resolveWorkflowDecisionClaim`(`:28342`,注意其「superseded PASS 不算证据」契约与 `requiredAttempt` 语义)。**纯事务内读,零新 I/O,满足机制数不升。**
- **⚠️ 设计决定点**:谓词命中时不能简单 `{ok:false}`(会变 `transition_refused`,`:25432-25443`,丢 verdict)—— 必须仍完成源节点 + 边遍历,只**抑制 rework 铸造**,改走 gate/`held` 收尾,保证不再调度零改动 actor wake。

## 4. 僵尸重派根除(修复面 5)— 审计完成(含 live-DB 铁证)

> **审计推翻了 issue 的两个前提**,修法要对着真机制设计:
> ① throw 点不在 `workflow-menu.ts:368-371`;② terminated run 其实进不了 dead-exec 重派通道 —— 真缺陷在死亡谓词。

### 4.1 complete → 500 的真回归链(子缺陷 ①)

- **真 throw 点**:`resolveWorkflowGateAuthority`(`workflow-run-snapshot.ts:142-184`)的 `:176-177` —— carrier 存在但 `ship_claims` 只蕴含 `snapshot_digest` → `throw new Error("incoherent_ship_bundle")`(三个 throw 点 `:162`/`:174`/`:177`,命中的是最后一个;FLY-1590 的 progress.md:232-256 已独立撤回过对 `:162` 的误判)。
- **2ed08e54(PR #748)实际改的**:`node-type-registry.ts:125-150` —— generic 节点获得 `creates_pr/can_ship/can_land/approval_gate_holder` + `completion_route: "needs_review"`。**没碰 workflow-menu.ts**。commit message 论证了四个下游契约,唯独没论证 `ship_claims`。
- **矛盾的另一半**:seed 侧 `workflow-menu.ts:368-372` —— `shape !== "code"` → `ship_claims: ["founder_approved"]`(file seed 双胞胎 `tpl_generic.yaml:31-32` 同)。generic 变 carrier 后,`subjectKind` 仍算出 `snapshot_digest` → `:177` 抛。
- **500 链路**:throw 发生在 `StateStore.projectGeneralizedCompletionTx`(`:23259-23262`,gate_carrier_epoch=1 才走)← `commitEnrolledCompletion`(`:24878/25011/25071`)← `event-route.ts:861`,无人 catch → Express 兜底(`plugin.ts:3789-3801`)→ **HTTP 500**。receipt 写在同事务内 → `workflow_node_completion` 空、node state 留 `running`。runner 已诚实退出,StateStore 认为还在跑。
- **live-DB 边界铁证**:`tpl_generic_menu` 的 run 快照里,恰好 FLY-1590/1591/1597/1606/1623/1625 六单是 `needs_review + creates_pr=1 + ship_claims=[founder_approved]`;更早的 1578/1579/1580/1581/1587 是 pre-#748 pin(`no_code + creates_pr=0`)→ engine_terminal 不抛。Bridge cutover 在 8-01 03:29 与 07:52 之间。

### 4.2 seed 合成断言缺口(子缺陷 ②)

- seeds 在 **Bridge boot** 导入(`plugin.ts:3961-3962`:`importBundledWorkflowSeeds` + `importWorkflowMenuSeeds`),两个家族:file seeds(12 个 YAML,`workflow-template.ts:1430-1478`)与 menu seeds(`menus/shapes/*.yaml` → `compileWorkflowMenuSeed`,`workflow-menu.ts:333-393`)。
- 2ed08e54 自带的 `scripts/verify-workflow-seeds.mjs` 差一步:只做 manifest 验证,**从不合成 snapshot、从不调 `resolveWorkflowGateAuthority`** —— 所以「all 12 seeds validate」为真而缺陷照样上船(manifest 合法性与 gate-authority 一致性是不相交的检查)。且该脚本**没接 package.json scripts 也没进 CI**,纯手动。
- 断言归宿:主推**测试**(table-driven:每个 seed → 合成 snapshot → `expect(() => resolveWorkflowGateAuthority(snap)).not.toThrow()`,`workflow-menu.test.ts` 已有 round-trip 骨架);次选扩 mjs 并接 CI。**必须覆盖两个家族**,且 menu 家族要用 live node-type registry 合成(那正是 2ed08e54 动的输入)。
- `tpl_generic`(file seed)与 `tpl_generic_menu`(menu 编译)是**两个 template id 同一缺陷**,只修一个留一个照样坏。

### 4.3 dead-exec 重派通道:真缺陷是死亡谓词(子缺陷 ③)

- **run status 检查其实存在且多处**(sweep 侧 `listActiveWorkflowRuns` 只取 `status='active'`,commit 侧 `:22832-22836` 复查)—— 六单现在显示 terminated 是**事后**被终止的;`workflow_side_effect_ledger` 证明每次重派都发生在 run 仍 `active` 时。issue 前提 ③ 需修正表述。
- **真缺陷**:死亡谓词 `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`(`StateStore.ts:312-320`)**含 `"completed"`** —— sweep 的"死"定义 = terminal session status + 无 completion receipt。complete 吃 500 的诚实 runner 留下的正是 `session.status='completed' ∧ node.state='running' ∧ 无 receipt`,与 crashed runner **字节不可分** → liveness probe 也如实确认进程没了 → `rollbackDeadWorkflowNodeExecution`(attempt 不变,launch_ordinal+1)→ 新 runner 重做已 merge 的活 → complete 再 500 → 闭环。
- **重启触发签名**:`start()` 构造即打 `reconcile()`(`workflow-engine-dispatcher.ts:260-274`)—— ledger 里两簇密集爆发(03:03:49-03:06:14 与 03:50:44-03:53:17,六单同 node 同 attempt、launch_ordinal 递增)= 连续两次 Bridge boot。引擎自己都发过 `repeated_dead_execution_pattern`(deathNumber: 2)—— 报警响了,循环照跑。
- **既有刹车**:`MAX_BLIND_REPLACEMENTS = 3`(`StateStore.ts:88`,backoff 60s/5m/15m,耗尽 → run held + founder alert,FLY-1606 就是跑满的那个)。
  > **更正(Codex design review R1#4)**:初判「计数按 Bridge 生命周期、重启清零」有误 —— 计数从 `workflow_side_effect_ledger` durable 行派生,`rollbackDeadWorkflowNodeExecution` 独立 count 同一账本后执行 cap,**跨重启持久**。8-05 两次 boot 各重派一轮是 cap=3 尚未耗尽,非清零。修复不需要动计数,只需 5③ 的 completed-without-receipt 分支阻断错误 respawn。

### 4.4 generic 节点出口(子缺陷 ④)

- route 三层校验:CLI 7 路由集(`complete.ts:46-57`);Bridge legacy 同集(未知 route 竟回 200+warning 静默跳过,`event-route.ts:1401-1423`);**StateStore 泛化路径把 route 钉死为 snapshot 冻结的单值**(`:24757-24759` `route_mismatch`)—— post-#748 generic 只剩 `needs_review` 一条腿。
- 取消/无产出单的困境:`no_code` 语义正确(CLI 文档明说此场景)但 `route_mismatch` 拒;`needs_review` 过 route 检查却撞 §4.1 的 500(即便修好也会把「空产出」park 进 founder review);`blocked` 既 mismatch 又谎报失败。**唯一绿灯路 = 伪造 PR** —— 反模式本尊。
- `--pr` 语义:`pr_handoff` 硬要 `--pr`;`no_code`/`phase_design_complete` 禁 `--pr`;`needs_review` CLI 不强制但 Bridge 从 server authority 重推导 PR 证据,且不在 `NO_QA_ROUTES`(`ship-eligibility.ts:253-254`)→ 带 PR 必须过 QA ship gate。
- 修法形状(审计建议):carrier 节点声明**合法终态 route 集**而非单值 pin + `resolveWorkflowGateAuthority` 容忍 carrier 无 ship bundle 完成的路径。
- **template 完成计数铁证**(live DB):`tpl_code` completed=8;`tpl_generic_menu` 19 个 run **completed=0,从未成功过** —— pre-#748 也只是 session 级 `no_code` 收尾、run 本体从未过 founder gate。#748 把静默 stall 升级成了 500+复活循环。

### 4.5 修复面 5 的真修点汇总(对照 issue 原文修正)

| issue 原文 | 审计后的真修点 |
|---|---|
| ① menu.ts:368-371 carrier→git-head claim | seed/registry 矛盾:generic 是 carrier 但 `ship_claims` 无 git_head 蕴含。修 = 让 generic seed 的 ship_claims 与 carrier 能力一致(或 generic 不再当 carrier)—— 两个 template id 都要修 + 已 pin 的旧 run 快照要能收尾 |
| ② seed 合成断言 | 成立,归宿 = table-driven 测试(两 seed 家族 × live registry)+ mjs 接 CI |
| ③ terminated run 不得再 spawn | 表述修正:真修点 = 死亡判定区分「诚实完成但 receipt 丢失」与「真死」(dead-exec 专属分支,不动共享终态常量);replacement 计数**本已持久**(ledger 派生,见 §4.3 更正),不需要改 |
| ④ generic 非 needs_review 出口 | 成立,修法 = 合法终态 route 集(至少放行 `no_code`)|

## 5. admission pause(修复面 6)— 审计完成

### 5.1 `/api/runs/start` 与 spawn 汇聚点

- 路由:`runs-route.ts:945`(handler 长达 ~2450 行),mount 在 `plugin.ts:3613-3621`(`tokenAuthMiddleware`)。响应在 spawn + session 注册**之后**才发 —— pause 若落在 `:1344`(resource admission)之前则零副作用;落在 `:2831`(spawn)之后 StateStore 已写行,正是 1634 乱账形态。
- **所有 spawn 面汇聚于 `IStartDispatcher.start()` / `IRetryDispatcher.dispatch()`**(`run-dispatcher.ts:489-495` 注释明言):HTTP start ×2、engine auto-advance(`workflow-engine-dispatcher.ts:2049`)、phase handoff(`phase-orchestrator.ts` ×4)、auto-QA(`auto-qa-coordinator.ts:1100`)、rescue(`plugin.ts:8980`)、retry(`actions.ts:1204` → `dispatch`)、dead-exec 再入(`StateStore.ts:19552-19830` + `dead-exec-activity.ts`)。
- **既有全局刹车的覆盖缺口**:`runnerAdmission.tryAdmit()` 只在 `runs-route.ts:1347` 与 `run-dispatcher.ts:1208`(`start()` 内)被调 —— **`dispatch()`(`run-dispatcher.ts:578-582`)只看 shutdown `accepting` flag,不走 tryAdmit**。纯 tryAdmit 级 pause 会漏 retry 通道和 dispatch 型 dead-exec 再入——恰是部署期乱账的形态。

### 5.2 现成模板:`fleet_pressure_hold`(FLY-1082)

- 持久单行表(`StateStore.ts:2633-2645`,`CHECK (id=1)`,注释明言「While present, runner admission defers every new dispatch…Durable so a Bridge restart mid-episode keeps the brake on」)。
- 消费点:`RunnerAdmissionController.tryAdmit()`(`runner-admission.ts:228-241`),typed reason `"pressure_hold"`;probe 接线 `plugin.ts:4009-4017`。
- **admission pause 结构上就是同一件事加 TTL**。但 `setPressureHoldProbe` 是单槽、已被 swap sensor 占用(`fleet-sensors.ts:268`)—— 需要 sibling probe 或组合 probe 列表,不能复用同一槽。
- 拒绝形状的直接先例:`runs-route.ts:1352-1357` **429 + typed reason**(`AdmissionDeferredError` → 429 在 `:3373-3381`);Lead 侧对 `/api/runs/start` 可重试拒绝已有既定反应契约(`lead-rules-base/runner-reengage-rules.md:32`)。
- 对比:shutdown 的 `stopAccepting()`(`run-dispatcher.ts:1088`)拒绝是 untyped Error → 落进 500 fallback —— 正是「没有明确稍后再试」的反面教材。

### 5.3 restart-services.sh 插入点

- 停机序列:`deploy_and_verify()`(`restart-services.sh:1669-1686`)→ Step 1 就是 `stop_bridge`(`:952-1001`,TERM→poll 120s→KILL→port-release 确认)。**pause 作为新 Step 0 插在 `:1673` 附近**(`notify_routine` 之后、`stop_bridge` 之前),best-effort 非致命(同 `record_deployed_range` 习语)。`rollback_and_restart` 的 `stop_bridge`(`:1624`)是第二可选位点。
- 脚本已会说 Bridge HTTP:`BRIDGE_URL`(`:118`)、`/health` curl(`:834`、`:1718`)。凭证已在 scope:`source ~/.flywheel/.env`(`:170-176`)+ `TEAMLEAD_API_TOKEN`;token 不进 argv 的先例 `curl -K -`(`:242-244`)。
- **FLY-1634 self-detach 约束**(`:609-620`):父进程立即 exit 0,真正干活的是 detached child —— pause 调用必须在 detach 块之后(`deploy_and_verify` 内),否则父进程退出与 pause 竞态;新 flag 要进 `RESTART_ARGS` 透传。

### 5.4 auth 习语选择

- 机器调用 → **习语 A:Bearer master token**(`tokenAuthMiddleware`,`plugin.ts:957-987`)+ fail-closed 503 包装(`plugin.ts:2122-2134`,无 token 时不静默裸奔)。fleet-console 的 loopback+confirmToken 习语是浏览器专用,脚本用不了。
- 注意:若挂在 `/api/runs` 前缀下,gemini scoped token 也够得着 —— 要么挂独立前缀(如 `/api/admission/pause`),要么加 `MASTER_AUTH_REQUIRED` 内层校验(`runs-route.ts:371-384` 先例)。
- 审计建议的执行位点:`run-dispatcher.ts:1208`(覆盖 `start()` 全部六 lane)**加上** `dispatch()`(`:578`)补检,闭合 retry/dead-exec 缺口;429 响应带 `Retry-After` 头(剩余 pause 窗口)。

## 6. launch 点火孤儿自锁(修复面 7,2026-08-05 追加)— 审计完成

> **一个机制修正**:「同名撞名 → 500」不是 `tmux new-window -n` 的字面拒绝 —— tmux 同名窗**不报错**。真因见 §6.1。

### 6.1 撞名的真机制:session 级饱和,非 window 级拒绝

- 窗名是 (Linear identifier, role, title) 的纯函数(`tmux-naming.ts:36-42` `buildWindowLabel`,`Blueprint.ts:2597` 调用)—— **不含 execution id、不含代数**,两代 design 窗名字节相同。
- `ensureRunnerSession`(`TmuxAdapter.ts:1509-1620`)是 **session** 级 ensure(经 `tmux-server-rescue ensure`,1s 重试至 210s deadline);hold kinds = saturated/split_brain/ambiguous/…(`:68-74`)。`TmuxSessionHoldError` 即 `tmux session ensure held: <kind>`(`:76-85`)。
- 因果链:上代 completed 窗未收 → stale 窗堆积在共享 `runner-<project>` session → server/命令队列**饱和** → ensure held → throw。**修法 = 收掉同名 completed 窗以消除饱和源**,不是给 new-window 加改名。
- 窗创建(`TmuxAdapter.ts:595-608`)前**没有任何** list-windows/同名检查。
- **现成先例(照抄)**:`purgeSameNameWindowsAsync`(`codex-runner-tui-window.ts:608-649`,FLY-1239)—— list → 按不可变 `@id` kill 同名窗 → re-ensure → 复查为零否则拒建;现只用于 founder TUI 窗,runner launch 路径没有。结构同 FLY-99 worktree 前置回收(`WorktreeManager.ts:382-421`)。

### 6.2 launch owner 孤儿:无补偿写 + 永不能自我接管

- owner INSERT:`recoverOrAcquireWorkflowLaunch`(`StateStore.ts:18128-18281`,`owner_generation=1` 即错误串里的 generation 1)。
- **60min 租约是 5 处内联字面量**(`runs-route.ts:2663/2718/2758/2781`、`workflow-engine-dispatcher.ts:1911`)—— 降租约要么全改要么抽常量。
- retry 每次 mint 新 `launchOwnerId = randomUUID()`(`runs-route.ts:2650`)→ `owner_id !== input.ownerId` 恒真(`StateStore.ts:18240-18246`)→ typed 409 `GENERALIZED_LAUNCH_HELD`;**重试永远无法收养自己上一次的死租约**,只有 60min 到期或显式 cancellation 行能放。
- **generalized 路径无回滚**:`runs-route.ts:2831` 的 `startDispatcher.start` **不在任何 try/catch 内**(仅 legacy 路径 `:3153-3343` 有 catch 并 `casLaunchClaimState("starting","cancelled")` 回滚 `:3344`)。owner 行在 `:2659` 已 durable(`StateStore.ts:18279` 无条件 save),三行后 start 抛 → run+owner 在盘、session 永不降生、零补偿写。

### 6.3 `engine_predecessor_unavailable`:两种状态混判 + 1s 无限重试

- throw 点 `workflow-engine-dispatcher.ts:1814-1817`:three-stage 角色(含 design)要求 predecessor 存在。
- `startRetryExecutionId`(`:1773-1787`):首节点无 `edge_traversed` → transition undefined → start reservation 指向本 node/attempt/execution → **predecessor = 自己**(start-retry 场景的有意设计,用于从自身 session 分支头解 startPoint)。缺陷:`:1815` 把「无前任(attempt=1 合法态)」与「前任 session 行缺失」混为一谈 —— 孤儿(session 无行)→ throw。
- throw 后 `:325-336` 只 log+计数,side-effect 行留在 `intent_recorded` → 下一 tick 重选 → **1s 无限重试**,无退避、无 attempt 计数、无状态转移(与修复面 2 的刷屏同形)。

### 6.4 tripwire 存在但被租约互锁 + 无 operator 触发

- `reconcileUnlaunchedWorkflowStalls`(`workflow-engine-dispatcher.ts:1090-1100`):alert 10min / rollback 60min,env `FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS`/`..._ROLLBACK_MS` 已可调(call-time 读)。
- **真自锁**:`beginUnlaunchedWorkflowCancellation` 被 `launch_owner_live` 守卫挡(`StateStore.ts:17560-17561`),且引擎侧**静默吞**该 reason(`:1211-1222` 不升级)。rollback 阈值与租约同为 60min → 两个定时器精确互锁,tripwire 到点撞上恰好还活着的租约 no-op。**只降 `ROLLBACK_MS` 没用** —— 会更早撞 `launch_owner_live`;租约必须一起降,或教守卫识别「路由已返回错误的 owner」为可回收。
- **operator 触发不存在**:`beginUnlaunchedWorkflowCancellation` 唯一 caller 是引擎 tick;无 HTTP 路由/CLI。最干净插入点 = `runs-route.ts:792` `router.post("/:runId/rework")` 旁新增 master-auth 路由。

### 6.5 500 形状与 typed 化模式

- 现状:`:2831` 无 catch → express 5 async 冒泡 → `plugin.ts:3788-3801` 兜底 `{error:"internal error"}`,**只打 err.message 不打 stack**,`TmuxSessionHoldError.kind/evidence` 全丢。
- 照抄模式:typed error class → typed 响应(`InvalidAgentNameError` → 400+code,`AdmissionDeferredError` → 429+reason,`runs-route.ts:3352-3381`);hold 类 409+code+reason 家族(`GENERALIZED_LAUNCH_HELD` 等 5 个)。`TmuxSessionHoldError` → 409 + `code:"LAUNCH_TMUX_SESSION_HELD"` + `reason: err.kind` + evidence。
- 反例明示:`:3382-3390` 的字符串匹配 fallback(FLY-123 注释点名要避免)。
