# FLY-2096 rework 换体后 60 分钟 stall clock 打 held — 实施计划

Issue: FLY-2096 (https://linear.app/geoforge3d/issue/FLY-2096/病根-rework-换体后-60-分钟-stall-clock-把-run-打成-helddelivery-wake-delivered-无)
日期: 2026-09-03
基于: research.md

## 0. 目标、约束、范围与验收

**目标**:本单点名的机制(30/60 分钟 rework stall 时钟把 run 打成 `held`)已被 FLY-2278(#1053,`069013b25`)退役。本单把这件事**钉成证据**并收尾:一组在退役前代码上会红、在 main 上会绿的回归测试;清掉退役残留的死参数;给存量 FLY-2241 held run 一条可核对的处置建议(不动数据);把「生产还没部署」写成可核对的验收口径。

**约束**:
- 只删不加:0 新 flag / 旋钮 / 表 / 列 / 索引 / 告警层 / hold 形状 / 事件 kind。
- 自托管规则:本单不部署、不重启;生产闭合只由 `com.flywheel.updater` 的 00:00 PT 班车完成。
- 不碰 `workflow_run` / `workflow_rework_delivery` 任何生产数据(Lead 2026-09-03 明令,处置权在 Lead / founder)。
- 不改 `CLAUDE.md`。

**范围**:M1 回归测试(含阳性对照)、M2 死参数删除、M3 rework attempt 完成结算(Lead 2026-09-03 对 question `6d580dc4` 裁 (A),必做,见 §9)、M4 文档与处置建议。**不做**见 §8。

**验收**(PR body 逐条引用证据):
1. `packages/teamlead/src/__tests__/fly2096-rework-stall-hold.test.ts` 在 main 全绿。
2. 同一文件原样拷进 `git worktree add <唯一 scratch 路径> 069013b25^` 的临时 worktree,`describe("FLY-2096 positive control")` 段里**两条独立命名的 `it` 各自红**(其一:run 被打 `held`;其二:完成返回 `engine_run_not_active`;各自独立铸 fixture,不共享 store),main 专属段被存在性守卫跳过而不是 import 失败。两次 vitest 输出与退出码贴 PR body。做不到就在 progress.md 与 PR body 如实写「未做阳性对照」及原因。
3. `grep -rn includeDeferred packages/` 为 0;`fly2278-retirement.test.ts` 继续绿。
4. M3 的 RED→GREEN 留证:`FLY-2096 rework attempt settles on completion` 段在 M3 代码落地前跑一次(**目标 rework attempt** 的 episode 1、同前缀告警 1 → 红),落地后再跑(0、0 → 绿);对照组(delivery 仍 `wake_delivered`、体 absent)修后仍告警。计数一律按 §1「目标 rework attempt 的定位」范围化,不做全局零断言。两次输出贴 PR body。
5. `pnpm --filter teamlead build` 与 `git diff --check` 绿;PR exact-head CI 绿是硬门。
6. progress.md 里写明:生产 Bridge `buildSha=31da17817`(pre-2278),修复只随 updater 班车生效;FLY-2241 数据未动;存量 3 条未结算 rework attempt 数据未动。

## 1. 稳定标识(实现必须逐字使用)

| 类别 | 值 |
|---|---|
| 测试文件 | `packages/teamlead/src/__tests__/fly2096-rework-stall-hold.test.ts` |
| describe 名 | `FLY-2096 positive control`(两树共有段)、`FLY-2096 main-only liveness gate`(main 专属段) |
| fixture run | `runId="run-1"`,`issueId="FLY-1307"`,`projectName="flywheel"`,模板 `tpl_eng_heavy`(复用 `storeWithIntent("qa")` 的铸法,逐行复制进本文件,不 import 其他测试文件) |
| 换体 | `requestId="fly2096-rework"`,`deadExecutionId="qa-1"`,`replacementId="qa-replacement-2"`,`route target_node_id="qa"`,`target_attempt=2`;materialize 后 route revision 变为 2。**版本 fence 只在 main 上存在**:main 会把 rework attempt 重铸成带 `contract_ref.routeRevision=2` 的版本;`069013b25^` 的 attempt 是无版本的 generation-1 行(`contract_ref` 只有 `{table, pk, runId}`),两树共有段**不得**断言 `routeRevision` |
| 目标 rework attempt 的定位 | `family='rework' AND json_extract(contract_ref_json,'$.table')='workflow_rework_delivery' AND json_extract(contract_ref_json,'$.pk')=requestId AND superseded_by_attempt_id IS NULL`(两树共有);main 专属段额外断言 `json_extract(contract_ref_json,'$.routeRevision')=2`。所有 episode / 告警断言都以这条 attempt 的 `attempt_id`(episode 表)与 `delivery_contract_stalled:<attempt_id>:` 前缀(告警 escalation uid)为范围,**不做全局计数** |
| fixture 里的其他 live attempt(必须知道它们存在) | ① `admitGeneralizedWorkflowExecution` 铸 `family='launch'` attempt(`table='workflow_execution_binding', pk='qa-replacement-2'`),由真实路径 `insertEvent({ event_type:"session_started", execution_id:"qa-replacement-2", … })` 消费。**两树的差别**:两树都写 `consumed_at`;只有 main(`069013b25` 起)在同一路径里 `settleWorkflowDeliveryAttemptTx` 并且 `listLiveWorkflowDeliveryAttempts()` 多了 `settlement_reason IS NULL` 过滤——旧树的 launch attempt 消费后仍留在 live 列表(已消费的 attempt 没有阶段 deadline,不会污染旧树的两条 tripwire,旧树也不跑 watch)。所以共有段只断言 `consumed_at` 非空;`settlement_reason==='settled'` 与「不在 live 列表」放 main 专属段;② `qa_pass` 完成时 `createWorkflowGateHolderTx` 铸 `family='gate_holder'` attempt(`minted` deadline 10 分钟),它在完成后的 watch pass 里会合法地产生自己的 warning / severe,**不是**本单断言对象 |
| 换体准入 | `admitGeneralizedWorkflowExecution({ runId:"run-1", nodeId:"qa", executionId:"qa-replacement-2", attempt:2, activationMode:"replacement", reworkRequestId:"fly2096-rework", expiresAt:T0+30m, absoluteDeadlineAt:T0+24h, now:T0-30s })`(两树都有;它铸的 `workflow_execution_binding.mode='replacement'` 是 `markWorkflowReworkReplacementLaunched` 的前置) |
| 验证路径行 | `workflow_rework_verification_path (request_id, run_id, route_revision=1, state='pending', current_node_id='qa', current_attempt=2, updated_at)` 与 request/route/delivery 同批插入;没有它 `commitWorkflowTransitionTx` 走普通 QA 边,永远不执行 rework delivery 的 `completed` 写点 |
| 时间锚 | `T0="2026-08-27T19:28:15.000Z"`(issue 原始换体时刻);baseline `T0-2m`、materialize `T0-1m`、admit `T0-30s`、launched `T0`;之后 `T0+61m`、`T0+95m`、`T0+96m`、`T0+3h`(严格递增,父 attempt 先于 replacement 子 attempt 铸出) |
| commDb | main 专属段与 M3 一律用真 `new CommDB(":memory:")`(`flywheel-comm/db`),teardown `close()`;不再用三方法 stub(`DeliveryProjector.runPass` 无条件调用 `listRunnerPhaseWakeProjectionRows`,stub 会 TypeError) |
| 旧树 scratch | `SCRATCH=$(mktemp -d /tmp/fly2096-old.XXXXXX)`,用完 `git worktree remove --force "$SCRATCH"` |
| 存在性守卫 | `const hasLivenessModule = await import("../bridge/delivery-contract/liveness.js").then(() => true, () => false)`;main 专属段 `describe.skipIf(!hasLivenessModule)` |
| 被删符号 | `StateStore.listWorkflowReworkDeliveries` 的 `includeDeferred?: boolean` 参数、SQL 里 `(? = 1 OR next_retry_at IS NULL OR next_retry_at <= ?)` 的第一个占位与参数数组里的 `input?.includeDeferred ? 1 : 0` |
| 保留符号(明示不删) | `enqueueReworkRecoveredIfAlertedTx` 的 `rework_stalled_alert:` 扫描;`hold-shape-registry.ts` 的 `rework_activation_stalled_held` 形状;`fly2278-retirement.test.ts` |
| 存量 run | `25703777-c780-41a2-8d72-aaa839bcb818`(FLY-2241) |
| M3 写点 | `commitWorkflowTransitionTx` 内 `:46868` 与 `:46947` 两处 `UPDATE workflow_rework_delivery SET state='completed'` 之后,同事务调用既有 `settleWorkflowDeliveryAttemptIfPresentTx({ family:"rework", table:"workflow_rework_delivery", pk: activePath.request_id, version:{ routeRevision: <该 delivery 行的 route_revision> }, reason:"settled", now })`;reason 逐字 `"settled"`(与 carrier `settleWorkflowCarrierDeliveryOnCompletionTx` 同值);**不**新增 run event kind |
| M3 describe 名 | `FLY-2096 rework attempt settles on completion` |

## 2. 里程碑

### M1 — 回归测试(先写,先在旧树上红)

**M1-a 两树共有段(阳性对照)**

脚本(每一步只用 research §1.1 表里两树共有的 API):

共用 fixture `seedLaunchedReplacement()`(每个 `it` 各调一次,不共享 store):

1. `StateStore.create(":memory:")`,按 `storeWithIntent("qa")` 铸 run-1 到 `qa` attempt 1 running。
2. `qa-1` session `status='failed'`;`upsertWorkflowRunNode({ nodeId:"qa", attempt:2, state:"pending", executionId:"qa-1" })`;同批插 `workflow_actor` / `workflow_rework_request` / `workflow_rework_route_revision(revision 1, preferred_actor=qa-1)` / `workflow_rework_delivery(state='replacement_pending', route_revision 1)` / **`workflow_rework_verification_path(state='pending', route_revision 1, current_node_id='qa', current_attempt=2)`**(与 `storeWithMaterializedFounderReplacement` 同形,多一张 path 行)。
3. `baselineWorkflowDeliveryContracts(T0-2m)`;`materializeWorkflowReworkReplacement({ requestId, deadExecutionId:"qa-1", newExecutionId:"qa-replacement-2", reason:"persisted_target_dead", observedAt:T0-1m })` → `ok:true`(route revision → 2)。
4. `admitGeneralizedWorkflowExecution({ …, activationMode:"replacement", reworkRequestId:"fly2096-rework", now:T0-30s })`(§1);`qa-replacement-2` session `status='running'`,`heartbeat_at=T0`,`last_activity_at=T0`;`upsertWorkflowRunNode({ nodeId:"qa", attempt:2, state:"running", executionId:"qa-replacement-2" })`;**用真实路径消费 launch attempt**:`insertEvent({ event_id:"fly2096:session_started:qa-replacement-2", execution_id:"qa-replacement-2", issue_id:"FLY-1307", project_name:"flywheel", event_type:"session_started", source:"test", payload:{} })` 返回 `true`,并断言 `launch` 家族里 `pk='qa-replacement-2'` 的 attempt `consumed_at` 非空(两树共有的事实)。**不在共有段断言它离开 live 列表**(旧树不结算、也不过滤 settled,见 §1)。
5. `markWorkflowReworkReplacementLaunched({ executionId:"qa-replacement-2", now:T0, alertIdentity })`。
6. **fixture 硬断言(先于任何 tripwire,任一失败即 fixture 坏,不算阳性对照;只断言两树共有的事实)**:返回 `{ ok:true, updated:true }`;`getWorkflowExecutionBinding("qa-replacement-2").mode === "replacement"`;`getWorkflowReworkVerificationPath(requestId)` `state==='active'` 且 `route_revision===2`;delivery `state==='wake_delivered'`、`route_revision===2`、`updated_at===T0`、`last_error===null`;按 §1 定位到**恰好一条**当前 rework attempt 且 `received_at===T0`(不断言它的 `routeRevision`);fixture 返回这条 attempt 的 `attempt_id` 供后续范围化断言使用。main 专属段另加一条:该 attempt `contract_ref_json.routeRevision===2`。

`it("keeps the run active past the retired 60-minute clock")`:

7. fixture;把 `qa-replacement-2` 的 `heartbeat_at` / `last_activity_at` 推到 `T0+60m`;`new WorkflowEngineDispatcher({ store, startDispatcher: 惰性 fake, env: WORKFLOW_ON, now: () => T0+61m, reconcileWorkflowRework: async () => ({ kind:"busy" }), probeLaunchLiveness: async () => "alive" })`;`await dispatcher.reconcile()`。
8. **断言 A**:`store.getWorkflowRun("run-1").status === "active"`;`getWorkflowReworkDelivery(requestId).state === "wake_delivered"`;`workflow_run_event` 里 `kind IN ('rework_activation_stalled_alerted','rework_activation_stalled_held')` 计数 0。再以 `now = T0+95m` reconcile 一次,断言 A 不变。

`it("accepts the replacement completion after 96 minutes")`:

9. fixture(独立 store);**不跑** dispatcher 之前先跑一次 `now=T0+61m` 的 reconcile 让旧树有机会 hold(main 上无副作用);然后 `commitWorkflowTransitionTx({ nodeReuseEnabled:false, runId:"run-1", nodeId:"qa", attempt:2, executionId:"qa-replacement-2", outcome:"qa_pass", subjectDigest:HEAD, now:T0+96m })` → **断言 B**:`ok === true`(旧树这里是 `{ ok:false, reason:"engine_run_not_active" }`);delivery `completed`;`rework_verification_completed:<requestId>` 事件存在(证明走的是 rework 验证路径而不是普通 QA 边)。
10. 「8-31 形状」:同一 `it` 里完成后 `now = T0+3h` 再 reconcile,断言 run 仍 `active`、零 held 事件。

旧树预期:第 8 步 `status === "held"` 红(it 一),第 9 步 `engine_run_not_active` 红(it 二)—— 两条独立 `it` 保证两条红都被执行到。main 预期:全绿。

**M1-b main 专属段(活性门)**

1. `seedLaunchedReplacement()`;`commDb = new CommDB(":memory:")`(teardown `close()`);**main 专属前置断言**:launch attempt(`pk='qa-replacement-2'`)`settlement_reason==='settled'` 且不在 `listLiveWorkflowDeliveryAttempts()`(watch 之前先证明它不会参与告警);目标 rework attempt `contract_ref_json.routeRevision===2`。把 `qa-replacement-2` 的 `heartbeat_at` / `last_activity_at` 推到 `T0+60m`。
2. `new DeliveryContractWatch({ store, commDb, projectName:"flywheel", resolveAlertIdentity })`;`runPass(T0+61m)`。
3. **断言 C(alive → 零写入,范围 = 目标 rework attempt)**:`workflow_delivery_contract_episode` 中 `attempt_id = <目标 attempt_id> AND closed_at IS NULL` 为 0;告警 outbox(以 `fly2248-delivery-transition-table.test.ts` 的读法为准)里 escalation uid 以 `delivery_contract_stalled:<目标 attempt_id>:` 开头的行为 0;`workflow_run.status === "active"`。**不断言全局零**(launch attempt 已被真实路径结算;其他家族的 attempt 不在本单范围)。
4. 对照组(独立 `it`、独立 fixture):`heartbeat_at` / `last_activity_at` 留在 `T0-2h`,`commDb` 无该 exec 的消息;`runPass(T0+61m)` → **断言 D(absent → 只告警不 hold)**:目标 attempt 恰好 1 条 open episode(stage `received`),`delivery_contract_stalled:<目标 attempt_id>:` 前缀的告警恰好 1 条(warning);`workflow_run.status === "active"`。
5. **对照组保持在岗**,`runPass(T0+95m)` → 同前缀 severe 告警恰好 1 条(warning 不重复);run 仍 `active`。
6. 只有在第 5 步之后才完成:`commitWorkflowTransitionTx(... now:T0+96m)` → `ok:true`,delivery `completed`,零 held 事件;M3 落地后追加:目标 attempt 不再出现在 `listLiveWorkflowDeliveryAttempts()`,那条 warning episode 已关为 `terminal:settled:settled`,`runPass(T0+3h)` 后同前缀告警计数**不增**、目标 attempt 零新 episode。完成后 `qa_pass` 会铸 `gate_holder` attempt 并可能合法地发它自己的告警,**不对它做任何断言、也不断言全局零**。(顺序是硬约束:完成会结算 attempt 并使其离开 live 列表,所以 severe 断言必须在完成之前。)

**M1-c 阳性对照执行留证**(实现节点做,不是 CI 步骤)

```
SCRATCH=$(mktemp -d /tmp/fly2096-old.XXXXXX)
git worktree add "$SCRATCH" 069013b25^
cp packages/teamlead/src/__tests__/fly2096-rework-stall-hold.test.ts "$SCRATCH/packages/teamlead/src/__tests__/"
( cd "$SCRATCH" && (pnpm install --frozen-lockfile --offline || pnpm install --frozen-lockfile) \
  && pnpm --filter teamlead exec vitest run src/__tests__/fly2096-rework-stall-hold.test.ts; echo "OLD_TREE_VITEST_EXIT=$?" ) 2>&1 | tee "$SCRATCH-vitest.log"
# 期望:positive control 段两条 it 各红(exit 非 0),main-only 段 skipped;把 $SCRATCH-vitest.log 全文贴 PR body
git worktree remove --force "$SCRATCH"      # 拷进去的测试是 untracked,不带 --force 会拒绝
```

不使用任何广域 clean / reset。若旧树装不起依赖,在临时 worktree 里只 `pnpm --filter teamlead install`;仍不行就如实记「未做阳性对照:<原因>」。

### M2 — 只删不加:`includeDeferred`

- `StateStore.listWorkflowReworkDeliveries`:删参数、删 SQL 首个占位、删参数数组里的 0/1;`workflowSelectAll` 参数变成 `[...states, now]`。
- 实现前再 grep 一次 `includeDeferred`(源码 + 测试 + `scripts/` + 插件 fork 三 root,按 FLY-1914 规则在 PR body 写扫描时间戳与结果);有任何调用方就停,回 Lead。
- 回归:`workflow-engine-dispatcher.test.ts` 与 `StateStore.workflow-rework.test.ts` 现有用例全绿(它们覆盖 `next_retry_at` 过滤语义)。

### M3 — rework attempt 完成结算(必做;Lead 裁 (A),理由见 §9)

**改动**:`commitWorkflowTransitionTx` 两处 delivery `completed` 写点(`:46868` 验证路径、`:46947` 链式路径)之后、同事务内调用既有 `settleWorkflowDeliveryAttemptIfPresentTx`(§1 稳定标识),镜像 carrier 的 `settleWorkflowCarrierDeliveryOnCompletionTx`。用 `IfPresent` 变体是因为 FLY-2248 之前铸的 delivery 没有 attempt 行,不能因缺行抛 invariant。不新增事件 kind、列、开关、告警层。

**RED 先行(真事件流,Lead ②)**,`describe("FLY-2096 rework attempt settles on completion")`:

1. 同 M1-a 到第 5 步(换体上岗 `T0`,attempt stage `received`)。
2. `commitWorkflowTransitionTx(... outcome:"qa_pass", now:T0+20m)` → `ok:true`,delivery `completed`。
3. 体收工:`upsertSession({ execution_id:"qa-replacement-2", status:"completed", heartbeat_at:T0+20m, last_activity_at:T0+20m })`(窗口消失后 HeartbeatService 不再刷心跳的真实形状)。
4. `DeliveryProjector.runPass(T0+61m)`(真 `CommDB(":memory:")`,§1;projector 无条件调用三个 list 方法,stub 不可用)→ 再 `DeliveryContractWatch.runPass(T0+61m)`(与 `plugin.ts:7533-7534` 同序)。
5. **断言 E(范围 = 目标 rework attempt)**:目标 attempt 不在 `listLiveWorkflowDeliveryAttempts()`;`workflow_delivery_contract_episode` 中 `attempt_id=<目标> AND closed_at IS NULL` 为 0;`delivery_contract_stalled:<目标 attempt_id>:` 前缀告警 0;attempt `settlement_reason === "settled"` 且 `contract_ref_json.routeRevision === 2`。
   - 修前:projector 只在 run 终态结算 rework,attempt 仍 live、overdue、liveness `absent` → 目标 attempt 开 1 条 `received` episode + 1 条同前缀 warning → **红**。
   - 修后:attempt 在第 2 步同事务结算,`listLiveWorkflowDeliveryAttempts` 不再返回它 → **绿**。
   - 同一轮里 `gate_holder` attempt(`qa_pass` 铸出)可能发自己的 warning,与本断言无关,不计入。
6. `runPass(T0+95m)` → 同前缀 severe 0(修前是 1)。
7. **对照组(别把告警面弄哑,Lead ②)**:同一个 store 里另铸一条 delivery 仍 `wake_delivered`、体 absent(`heartbeat_at=T0-2h`)的 rework(即 M1-b 的 D 形状,独立 requestId / 独立换体 exec),同一 `runPass(T0+61m)` 必须仍给**它的** attempt 开 1 条 episode、发 1 条同前缀 warning。两条 rework 同轮跑,证明结算只作用于已完成的那条。
8. **负向**:完成之前(第 2 步之前)attempt `settlement_reason IS NULL`;链式路径(`:46947`,`supersedingRework` 分支)也要有一条同形断言,不能只测验证路径。

**存量数据**:生产库副本里 3 条 `delivery.state='completed'`、attempt 未结算、run `active` 的 rework attempt **不碰**(Lead ④)。它们会在各自 run 终态时由 projector 以 `run_terminal` 结算;在此之前若体 absent 会继续按既有路径告警,这是已知的存量噪音,不由本单清理。

### M4 — 文档、处置建议与收口

- progress.md 写明部署状态与存量处置边界(§0 验收第 5 条)。
- FLY-2241 处置建议(只读核对 + 建议事务,**本单不执行**):

```sql
-- 只读核对(Lead 执行前先看):
SELECT status FROM workflow_run WHERE run_id='25703777-c780-41a2-8d72-aaa839bcb818';          -- 期望 held
SELECT state, last_error FROM workflow_rework_delivery WHERE request_id LIKE 'rework:fc0f8bd7%';  -- 期望 held / delivery_awaiting_receipt
SELECT node_id, attempt, state FROM workflow_run_node WHERE run_id='25703777-c780-41a2-8d72-aaa839bcb818';  -- general 1,2 done;land 1 pending
-- 建议:不要走 hold resume(resume_receipt_deadlock 会把 rework 重投给已 done 的 general);
-- 按 FLY-2278 之前巡检的一笔断言事务:delivery held→completed、run held→active、追加 Lead 署名事件;
-- 但该 run 还有更早的 land_held(seq 44),先由 Lead 判 land 是否也该解;两个 hold 都解开 run 才 active(FLY-2278 「最后一个 run 级 hold 解除才 active」)。
```

- 里程碑账本 `engineering/doc/milestones/FLY-2096.md`(ship 时新建,不写回 CLAUDE.md 表格)。

## 3. Schema、数据与迁移

无 schema 变更,无迁移,无数据脚本。M2 只改一条 SELECT 的谓词。M3 只在既有事务里多一次既有 helper 调用,写的是 `workflow_delivery_attempt` 既有的 `settlement_reason` 列;helper 自己会把该 attempt 上仍 open 的 episode 关成 `terminal:settled:settled`(`StateStore.ts:36236-36245`),不需要额外写 episode。

## 4. 回滚边界

- 整个 PR 可 `git revert` 一次回滚:测试文件删除、`includeDeferred` 参数恢复、M3 两处 settle 调用移除。
- **删掉 M3 那一处写点(两个调用),行为就回到今天(FLY-2278 合入后)的样子**:未来完成的 rework attempt 不再即时结算;部署期间已被 M3 结算的 attempt 保持 `settled`,不需要也不应做数据修复。无持久化格式变化。
- 本 PR 有一处生产行为变化,只在 M3:已完成的 rework 不再产生完成后的 warning / severe `delivery_contract_stalled` 告警。M1 / M2 不改行为。

## 5. 负向守卫(必须有对应测试)

| 守卫 | 测试 |
|---|---|
| fixture 真的进入了形状 | M1-a 第 6 步六条硬断言:`markLaunched` 返回 `updated:true`、binding `mode='replacement'`、path `active@rev2`、delivery `wake_delivered@rev2` 且 `updated_at=T0`、attempt `received_at=T0`(防「测了个没进入形状的空 run」假绿;防 `markLaunched` 因缺 binding 静默 `updated:false`) |
| 完成真的走了 rework 验证路径 | M1-a 第 9 步断言 `rework_verification_completed:<requestId>` 事件存在(没有 path 行时 completion 走普通 QA 边,M3 写点根本不执行) |
| 阳性对照真的会红,且两条都执行到 | M1-c 旧树 vitest 输出(两条独立 `it` 各红、exit 非 0)贴 PR;缺失则显式写「未做」 |
| 「不 hold」不是因为判活为真 | M1-b 对照组 D:absent 时仍 `active`、完成仍 `ok:true` |
| 告警不重复 | M1-b 第 5 步:warning 1、severe 1 |
| main 专属段不因 import 失败拖垮旧树运行 | 存在性守卫 `describe.skipIf`,旧树输出里必须出现 `skipped` |
| 死参数零调用 | 全仓 grep 结果写 PR body,含插件三 root(FLY-1914) |
| M3 修前真的会开 episode 发告警 | M3 第 5 步在代码落地前先跑,红的输出贴 PR |
| M3 没把告警面弄哑 | M3 第 7 步对照组同轮仍开 1 episode、1 warning |
| M3 两条完成路径都结算 | 验证路径(`:46868`)与链式路径(`:46947`)各一条断言 |
| M3 对无 attempt 行的旧 delivery 不抛 | 一条「delivery 有、attempt 行无」的完成用例,`ok:true` 且不抛 invariant |
| 不把 verdict 写进 plan 自身 | 设计评审结论只在 `codex-review/` 或 PR,不改本文 |

## 6. 显示文案

本单不新增 Lead-facing 文案。M1-b 对照组断言的是既有 `delivery_contract_stalled` 文案路径(`alert-kind-copy.ts` 已含「收件体活性 <verdict>」尾句),只断言条数,不断言正文。

## 7. progress.md chunk 约定

`m1a-positive-control` · `m1b-liveness-gate` · `m1c-old-tree-evidence` · `m2-include-deferred` · `m3-attempt-settle-red` · `m3-attempt-settle-green` · `m4-docs-and-fly2241-note`。每个 chunk 落地后 `progress --set-chunk <id>=done`;M1-c 若未做写 `m1c-old-tree-evidence=skipped:<原因>`;`m3-attempt-settle-red` 必须在 green 之前置 done,并附红输出的文件路径。

## 8. 不做

- 不部署、不重启 Bridge、不催 updater。部署口径两句话,分开说:**「旧的 60 分钟 hold 退役随 FLY-2278 已合入 main,等 00:00 PT 班车部署后生效」**;**「本单 M3 的结算写点要等本 PR 自己合入并部署后才生效」**。核对方法:① `/health.buildSha` 含 `069013b25`(#1053)⇒ 本单形状不再发生;② `/health.buildSha` 等于本 PR 的 merge SHA(或其后代)⇒ 完成后的幽灵告警才停。在 ① 之前不把「不会再 hold」写进 founder 面文案,在 ② 之前不把「幽灵告警已停」写进去。
- 不改 FLY-2241 或任何存量 held run 的数据;不扩 hold 形状注册表。
- 不收敛 coordinator 每 3 分钟 `actor_alive_after_receipt` 重探产生的 `rework_delivery_claimed` 事件噪音(已向 Lead 点出,另开单)。
- 不删 `enqueueReworkRecoveredIfAlertedTx` 的历史前缀扫描,不删 `rework_activation_stalled_held` 形状。
- 不动 FLY-2278 的阈值(30/90 分钟、10 分钟活性窗)。
- 不为 rework 家族补 `consumed_at` 时钟(M3 结算的是 attempt 的 `settlement_reason`,不是再造一个阶段时钟);不给 rework 结算加新的 run event kind。
- 不清理存量 3 条未结算 rework attempt(Lead ④);不对存量 open 的 rework episode(副本里 `granted` 7 条、`sent` 1 条)做任何写。

## 9. Design correction(Lead 裁决 question `6d580dc4`,2026-09-03)

**推翻的条款**:FLY-2278 plan §8「不为 rework 家族补 `consumed_at` 写点(FLY-2248 遗留;received 告警过活性门即止)」。

**为什么推翻**(Lead 原话要点,逐条对应):
1. 活性门对**已收工**的体恒为 `absent`:体完成节点后 tmux 窗口消失,HeartbeatService 不再刷 `heartbeat_at`,10 分钟后 `classifyRecipientLiveness` 只能判 `absent`。§8 的假设「received 告警过活性门即止」只对在岗的体成立,对已完成的体正好反过来 —— 今晚这类幽灵告警已经在 founder 频道刷屏(FLY-2291 / FLY-2278 各若干条 warning / severe `delivery_contract_stalled`)。
2. carrier 家族**早就**在完成事务里结算 attempt(`settleWorkflowCarrierDeliveryOnCompletionTx`,`StateStore.ts:36311`),rework 没有;同一张 `workflow_delivery_attempt` 表、同一个 settle helper、两个家族两套结果,这个不一致本身就是缺陷,不是设计取舍。
3. 修法是复用既有 helper、零新机制,与 FLY-2278 的 0-预算(0 新表 / 列 / 索引 / 旋钮 / 告警层 / 合同 entry)不冲突;§8 想守的是「不再造一个阶段时钟」,M3 也不造(见本文 §8 倒数第二条)。

**Lead 附加要求**:RED 必须是真事件流(换体上岗 → 节点 done → 体收工、窗口消失、心跳过窗),修前开 episode + 告警,修后零;对照组(真未结算)仍要告警;存量 3 条未结算行不碰数据。三条都已落进 M3 与 §5。
