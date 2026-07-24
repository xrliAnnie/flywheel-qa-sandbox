# FLY-1441 Gate 到达发射 — 调研(design epoch 4)
Issue: FLY-1441 (https://linear.app/geoforge3d/issue/FLY-1441/规则回迁-qa-绿了才发-ship-gate-把-fly-579-定过的规矩在-dag-引擎上重新落地-加防丢测试)
日期: 2026-07-23
基于: exploration.md

全部行号在本 worktree(branch = main + docs)三路只读审计核验。

## R1. gate holder 骨架:哪些点要变 mode-aware

- **schema**(`StateStore.ts:13008-13037`):`(run_id, gate_node_id, attempt, head_sha)` PK;`source_execution_id`(注释明言 attribution only)、`question_id` UNIQUE、`state`(materializing|awaiting_review|approved|superseded)、`materialization_stage`(question_intent→…→completed);partial unique `ux_workflow_gate_holder_current(run_id, gate_node_id) WHERE state IN 活跃三态`(13030-13034)。骨架本身无 land 耦合,可直接承载泛化。
- **创建位**:`commitWorkflowTransitionTx` gate 分支(22121)内,land-only 守卫 `schema_version===1 ∧ manifest_variant==="land_v1"`(22138-22142);内含 40-hex head 强制(22143-2148)、旧 holder supersede(22156-2162)、`gate_holder_created` 事件。另有同形 `ensureWorkflowGateHolder`(25329-25399)备用路径。
- **land-only 假设清单(要改的锁点)**:
  1. `gate-authority-view.ts:53-63` —— 唯一 authority 锁点:非 `isWorkflowManifestV1Land` 直接返回 undefined;`expectedCurrentNode` 用 land 专属 `terminal_node`。**mode-aware 化的主战场**。
  2. `applyWorkflowSourceEvent` 批准后分支(23455-23521 land → land 节点;23522-23546 v2 → run completed;23281-23412 founder feedback kickback 也 land 门禁 23296-23301)。
  3. `gate-materializer.ts`:结构上 mode-agnostic,但 `checkpoint:"approve_to_ship"`(94,150)与卡文案硬编码 ship 语义;**`session_bound` stage 是 no-op**(106-115)—— runner_ship 模式要在这一 stage 真正做 session 绑定。
  4. `plugin.ts workflowGateMaterializeTick`(7621-7687):mode-agnostic 循环,`listWorkflowGateHoldersForMaterialization(20)`。

## R2. verify-approval / session FSM:runner_ship 模式的三道硬约束

- **verify-approval**(`flywheel-comm/src/commands/verify-approval.ts:265-552`):要求 ①session `review_question_id` 真实绑定(363-372);②CommDB question `checkpoint==="approve_to_ship"` 且 **`question.from_agent === args.execId`**(385-393)—— 今天 land holder 的 question `from_agent` = QA source exec,自 ship 的 runner 传自己的 execId 会撞死;③founder-attributed `{approved:true}`;④**session.status === "approved_to_ship"**(467-473);⑤`pr_head_sha === prHead`(474-490);⑥Codex 记录 + 活 CI 探针。
  ⇒ runner_ship holder 的 question 必须以 **ship-capable implement execution** 为 `from_agent`,并在 `session_bound` stage `setReviewBinding(implementExecId,{questionId,prHeadSha})`(`StateStore.ts:4933-4946`,无条件覆写,无状态守卫)。
- **session FSM**(`core/src/workflow-fsm.ts:120-184`):`awaiting_review→approved_to_ship` 是唯一合法入边(approve 动作 206-211);**`completed` 无出边**(181,overwrite-immune)。批准 flip 守卫只认 `awaiting_review`(`wiring.ts:142`)。⇒ **载体绑定对象 = gate 到达时状态仍为 `awaiting_review` 的最新 ship-capable 节点 execution**(DAG implement 走 `complete --route needs_review`+park,正是此态);若该 session 已 terminal/被清 → 载体无法绑定,必须 fail-loud 告警而非静默。
- **批准 hook 双路**(`write-gate-response.ts:293-324`):`gateAuthorityView.resolve` 命中即短路(land 现状,跳过 flip/wake,走 source-event 投影);未命中走 `buildGateResponsePostWriteHook`(`wiring.ts:98-224`):approved ∧ awaiting_review → `applyTransition(approved_to_ship)` + `sendRunnerWake("approval_wake")`(209-222)。⇒ runner_ship 模式 = authority view 命中(记权威事实/推 holder approved)**且**执行 flip+wake(不能照抄 land 的短路)。
- **wake**(`runner-wake.ts:105-243`):mailbox 路由按 transport backend;no-transport(antigravity/kimi)跳过并记 `runner_wake_no_transport` ⇒ runner_ship 模式对 no-transport runner 的 gate 需按 pr_handoff 语义处理(FLY-493 先例,mode 推导时归 engine_terminal-或-手动,plan 定)。

## R3. 批准后三模式的现状锚点

- **land**:批准 → `insertFounderApprovalResponseWithSource`(write-gate-response 521-609)→ source event → `applyWorkflowSourceEvent` land 分支(23455-23521):holder→approved、`commitWorkflowTransitionTx(founder_approved)`(target 必须 land)。零改动目标。
- **v2 terminal**:同函数 else 分支(23522-23546):`resolveEngineWorkflowShipClaims` 过 → run completed。engine_terminal 模式即它,去掉「schema v2」字面判定改为 mode 驱动。
- **v1 non-land 收口缺失(已核)**:merge 后唯一记录是 `recordWorkflowShipReadyHandledObserved(pr_merged)`(24080-24101,仅压告警);run **永远 active 停在 gate**。runner_ship 模式必须补 merge 证据 → run completed 投影(evidence-gap finalization 先例:FLY-208 5a 的 merged-evidence 收口)。
- **founder feedback**:kickback 分支(23281-23412)land 门禁;通用化条件 = manifest 声明 `founder_feedback_kickback` loop(gate→回退目标)。非 land eng 模板今天**没有**声明该 loop(仅 land 变体有)⇒ 补声明是纯拓扑改动;loop 重入即现有 rework/attempt 机器。

## R4. Blueprint prompt 冲突与手术点(全部已核)

- generalized 主合同:1537 / 1553-1601(1573 DAG owns advancement;1584-1586 不得 request ship approval);checkpoint 跳过 2153-2158;MERGE-AUTHORITY 排除 2115-2139。
- **泄漏点**:FLY-887 epilogue `1771`(implement,「ran/repeat the APPROVE GATE flow」)与 `1757`(design),门条件只有 `threeStageKeepAlive ∧ is*Phase`,**不排除 generalized**;`isImplementPhase`(1453-1456)、`threeStageKeepAlive`(1471-1473)均不看 generalized。landing-signal 块 `1716`(ready_to_merge/landing signal)同样不排除。
- 同文件已有排除先例:legacy CI/stop tail `1738` 带 `!isGeneralizedExecution`。⇒ 手术 = 给 1757/1771/1716 补同款守卫;**保留** `phaseKeepAlive` 字段计算(1474-1483)与 adapter 接线(2583)、`sentinelPath`(2586)—— TURN/park keep-alive 是字段驱动,与 epilogue 文案无关。
- 测试缺口确认:`Blueprint.generalized-workflow.test.ts` 全文件无 `shareParentBranch`/`sessionRole`,生产组合从未被构造。

## R5. 越权 question 的呈现面(fence 落点,全部已核)

写入侧无闸(`flywheel-comm gate` 直写 sqlite,`db.ts:581/1101`;Bridge 无 question-ingest API)⇒ fence 建在消费侧,分类 helper 现成:`getGeneralizedWorkflowNodeForExecution`(19187-19197)+ `getCurrentWorkflowGateHolderByQuestionId`(25461-25469)。

| # | 呈现面 | fence 插入点 |
|---|---|---|
| 1 | QuestionAdmission.eligibility(172-199,materializePending 47-58) | session 解析(178)后 |
| 2 | GatePoller 主 relay 循环(882-1070) | getSession(921)后、QA-hold skip(945-958)同位 |
| 3 | GatePoller founder-thread fallback(2589-2700) | scope 判定(2598-2606)后 |
| 4 | GatePoller founderReactionApprovalPass(3866-3900+) | 候选收集(3891-3893)处 |
| 5 | bootstrap-generator(212-315,gate 分支 251-282) | push(282)前 |
| 6 | event-route always-deliver(2833-2895) | 扩 2833 条件(与 isReviewHeld 并列);注:enrolled generalized completion 已在 825-852 短路,漏的是未 enroll 的 out-of-band |
| 7 | DirectEventSink parity(1040-1053) | 扩 1047 守卫(531-533 已算过 generalized lookup,复用) |

fence 分类规则(deadlock-free,过渡窗口安全):
- execution 无 typed engine binding → `legacy`,全量放行(byte-compatible);
- engine-owned ∧ run 未在 terminal gate → **suppress**(gate 前本就无合法批准物;正是 FLY-1364 类);
- engine-owned ∧ run 在 gate:question === 当前 holder question → 放行;holder 存在且 question ≠ holder → suppress;**holder 不存在(cutover 前开的 gate attempt / flag off)→ 放行**(legacy 过渡语义,不 backfill 不误杀在途)。

## R6. canonical ship_ready scanner 现状与让位点

- 白名单硬编码 `{tpl_eng_heavy,light,trivial}`(24250-24254);land 已排除(24266);qa_passed claim 条件(24268)。
- holder 泛化后,非 land gate 由 holder→materializer 发权威卡 ⇒ scanner 对 holder-backed gate 必须让位(exactly-once):候选过滤加「当前 gate attempt 存在 holder → skip」(索引现成);无 holder 的在途旧 gate 继续走 scanner(过渡)。终态(全部 gate holder 化后)scanner 退役 = follow-up,删除条件写明。

## R7. loop 计数与重入(去特化的事实底座)

- **通用 per-loop 计数已存在**:`loop_iteration` 事件 `edge_id=loop.id`,COUNT(*) 派生(21821-21829),max_iterations 执法(21830-1834)、`loop_limit_escalated`(21835-1877)全在用。所有 bundled seed 的 loop 都有稳定显式 id(qa_retry / review_kickback / founder_feedback)。**无需新存储**。
- **`current_qa_attempt` = QA 特化冗余指针**(列 12941/12950-56;类型 26602):写入 = admit 时 `CASE WHEN nodeId='qa'`(17485-91, 19072-79);4 个消费者:stale-attempt 闸(17397-1740x)、decision-binding currency SQL(21390)、ship-eligibility join(`ship-eligibility.ts:167-172`)、`/re-qa` 幂等(workflow-decision-routes 565)。语义 = 「最新 admit 的 qa 节点 attempt」,等价信息在 `workflow_run_node` 的 MAX(attempt) 里 ⇒ 4 处全部可改为**按节点 id 通用查询**(无数据迁移;列保留为休眠兼容,删除条件文档化)。无 dashboard/API/telemetry 暴露(已核)。
- **`/api/workflow/qa-retest` 溯源翻案**:源码零存在(git log --all -S 零命中),仅 stale dist/ 残留(第一轮 revert 原型)。真实源码面 = `/re-qa` + `/re-qa/stage`(483-633;loopback+same-origin+confirm-token;无持久 receipt;无测试),语义 = legacy durable QA session 收编(`resolveReQaCanonical` 171-207,`qa_already_enrolled` = 已 enroll 拒双收)。⇒ 通用 loop 重入是**新设操作**,无历史别名负担;`/re-qa` 原样保留、文档区分。
- **grep 验收 hit 清单(四级分类)**:(a) 条件词汇表(qa_pass/qa_fail 等 edge/loop/ship_claims 词)= 模板声明,保留;(b) `node.type===` executor/decision-family 绑定(16928/17026/18830/19039/21068 等)= 绑定用途,保留但注明其超出「只绑 executor」(还选 decision family);(c) **引擎控制流按节点名特化 = 必改**:17406、17488、19076、21390、`ship-eligibility.ts:171`、workflow-decision-routes 189/568/576/610/616、rework scope 列表 21991-21992(`["design","implement","qa"]`)、单 QA 节点 find 23770/24313;(d) 迁移兼容字面量 = `current_qa_attempt` 列本体(删除条件:4 消费者迁完 + 生产无老 run 依赖)。另:validator 的 type→条件词汇 pinning(workflow-template 600-635)属模板结构层,单独归档不入引擎 grep 面。

## R8. rollout 事实约束

- 生产现役 engine run 全部 tpl_eng_heavy(工作副本核账);当前 `workflow_gate_holder` 表零行(前轮核账)—— 泛化上线无存量 holder 兼容负担。
- 首 tick 不得回填历史 gate(rework-notes 六:批量惊动 founder + 无细粒度回滚);carrier 只作用于 **flag 开启后新到达的 gate attempt**。
- fence 与 carrier 必须同 flag 联动(fence 单独开 = Codex HIGH 的 ship 死锁;carrier 单独开 = 双发)。
- **勘误(开工令 08a1cf06 后补):prompt / fence / carrier / scanner 四件必须按 `gate_carrier_epoch` 整体切换,prompt 修复不得独立上线。** 早稿 R8 的「prompt 独立无 flag」与最终 plan 的 run-frozen rollout 已不一致,以 plan 为准。理由:epoch=0/OFF 若 prompt 已去掉 legacy epilogue,runner 不再自建 ship approval、引擎又不造 carrier,run 到 Gate 后无门可批,形成 `ship-approval-carrier-removed` 型死锁。
