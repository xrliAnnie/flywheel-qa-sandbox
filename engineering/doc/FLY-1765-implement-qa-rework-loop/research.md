# FLY-1765 implement↔QA 返工环断裂 — 调研

Issue: FLY-1765 (https://linear.app/geoforge3d/issue/FLY-1765/implementqa-返工环断裂qa-fail-后原-implement-体已-completed-不可复活state-not)
日期: 2026-08-14
基于: exploration.md

## 1. 返工投递全链(现状代码位点)

QA FAIL → `workflow_rework_request` + `workflow_rework_route_revision`(target=implement attempt 2,preferred actor=原 exec)→ dispatcher 周期 reconcile → `WorkflowReworkCoordinator.reconcile()`(`packages/teamlead/src/bridge/workflow-rework-coordinator.ts`):

1. `claimWorkflowReworkDelivery`(lease 30s,防并发)
2. 上下文校验:request/route/delivery/run active;`workflow_run_node` 预留仍绑 preferred actor 且 state ∈ {pending, admitted}(`:320-335`)
3. `classifyPhaseActorReentry`(`phase-actor-reentry.ts:30-67`):
   - registered probe alive → **wake**;dead_pin → **replace**;indeterminate → hold
   - 无 tmux target:不可逆终态 + host 进程缺席(正向死亡证据)→ **replace**(`terminal_actor_target_and_host_absent`,FLY-1462 revert 后的重立形态);否则 hold(`persisted_target_missing`)
   - persisted probe alive → wake;dead/absent → replace;indeterminate → hold
4. `assertWorktreeReady`(base_revision 比对;8-11/8-12 的 `head_mismatch` 卡在这层,FLY-1686 家族,另案)
5. **`activateActorForWake` → `activateHolderForWake`(`holder-wake-activation.ts:26-132`)——本 bug 断点**:
   - StateStore 现读 session;`approved_to_ship` 单独拒;其余仅 `{running, ship_parked, design_done, awaiting_review}` 可复活(`:44-51`),否则 `state_not_revivable:<status>`
   - 通过后:CommDB `activateSessionForWake`(原子重挂 comm 注册)→ `applyTransition` 到 `running`(`awaiting_review` 先过 `ship_parked`)
6. admission(`admitGeneralizedWorkflowExecution`, activationMode="wake")→ TURN grant → mailbox wake(`plugin.ts:8410` → `deliverDurableTurnWake`,backend 按 `EXECUTOR_TO_TRANSPORT[adapter_type]`;codex-tmux → codex mailbox,FLY-1643/1142)→ delivery `wake_delivered`
7. 失败分支 `releaseRetryable`(`:241-277`):run active 时 `settleWorkflowReworkFailure`(`StateStore.ts:22612+`):
   - `exhausted = terminal !== undefined || holdCount >= 5`(`:22682`)
   - `state_not_revivable:<status>` 且 `isStateStoreIrreversibleTerminalForZombie(status)`(`StateStore.ts:416`)→ coordinator 传 `terminal:{kind:"irreversible_actor"}`(`workflow-rework-coordinator.ts:398-416`)→ **首跳即 needs_lead**(1759 的 holdCount=1 由此而来)
   - `persisted_target_missing` 耗尽 → `handoff_held_pane_loss` → held(FLY-1596/1628/1648 退避族)
8. `replacement_pending` 分支:dispatcher(`workflow-engine-dispatcher.ts:968-983`)→ `materializeWorkflowReworkReplacement(newExecutionId)` → 正常节点派发路径起新体,FLY-1718 reconcile 续接既有分支/PR。**自动重生机制已存在且在用。**

## 2. 完工投影(账面终态从哪来)

`projectGeneralizedCompletionTx`(`StateStore.ts:26556-26640`),generalized 完工唯一 session 状态写点:

```
projectedStatus =
  route === "no_code"                    → "completed"
  gateAuthority.mode === "runner_ship"
    && carrierNodeId === node_id         → previousStatus==="awaiting_review" ? "awaiting_review" : "ship_parked"   // + park_opened 台账
  else                                   → "completed"(+ applyTerminalTimestamp)
```

`resolveWorkflowGateAuthority`(`workflow-run-snapshot.ts:165-206`):**terminal-land manifest 先行返回 `mode:"land"`**(`:173-175`,`isWorkflowManifestLand` 早退;生产 compiled menu 逐个断言 authority=`land`,`workflow-menu.test.ts:293-305`);非 land 时才筛「runner ship carrier」;零 ship-capable 候选才是 `engine_terminal`(此形态无 PR 无返工目标,与本 bug 无关)。

- **1655 前**:tpl_code implement 即 carrier(`mode:"runner_ship"`)→ 完工 `ship_parked`(park 台账 `appendWorkflowEngineParkEventTx`,reason `runner_ship_gate_wait`)→ 可复活。
- **1655 后**(#795 改 seed:加 `land` 节点 + `approval_gate.node=land`;run a65fd4fe snapshot 实证 implement `can_ship=false`):authority=`mode:"land"` → 投影函数的 carrier 分支不再命中 → implement 完工走 else 分支投 `completed` 终态,completion_disposition receipt 为 `terminal_no_gate`(`StateStore.ts:28299-28316`;既有测试 `StateStore.workflow-engine-transition.test.ts:469-518` 同形)。design(`phase_design_complete`)、qa(`no_code`)同样投 `completed`,但它们不是 QA-FAIL 返工的账面断点:qa 体按 runner 协议 verdict 后不 complete(session 持 running,retest wake 可达);design 目标返工在台账中无案例。

补充:`workflowCompletionDispositionForContext`(`StateStore.ts:28298-28316`,FLY-1731)把完工分类为 `runner_ship_park` / `engine_gate_handoff` / `terminal_no_gate` 并落 immutable receipt;受影响路径的 receipt 实为 **`terminal_no_gate`** —— 它如实记录「该次完工没有打开 gate」,**不是** engine-handoff 证据。返工可达性缺口不在 receipt,而在 session 被投影成 `completed`。

## 3. 相关前科与不变量(修法边界)

| 前科 | 内容 | 对本设计的约束 |
|---|---|---|
| FLY-939 | wake 停驻体,绝不 respawn(原体持上下文) | 主修必须恢复 wake,respawn 只做兜底 |
| FLY-1462 #700→#704 revert | 「把 FSM 终态当死亡证据授权 replace」被否;重立时要求正向死亡证据;设计原话「completed deliberately excluded (parked-alive shape)」 | completed=停驻活体是既有共识;**不能**把 completed 直接当死亡证据无差别 replace |
| FLY-1228/1229 Finding K | 终态免疫:terminal session 不被误判/误清 | 大量 reaper/巡检依赖「终态不可逆」;**不宜**开 completed→running 复活边 |
| FLY-1731 | completion_disposition receipt;「Bridge 误判终态」修复靠不让 completed 投影堵门,而非复活终态 | 同上:方向是"别错误终态化",不是"终态可逆" |
| FLY-1612 | rework 告警 episode 收敛 + terminal 立即耗尽 | 保留其告警形态;Fix 2 改 terminal 分支为**受控收体 + 非终 retry**(不再首跳 needs_lead;耗尽仍走既有 needs_lead) |
| FLY-1718 | re-dispatch 先对账存量分支/PR | replacement 起新体时续接分支/PR 的既有基建 |
| FLY-1648 | held pane-loss materialize 1m/2m/4m/8m 退避,5 次 needs_lead | replacement 物化失败已有收敛,Fix 2 不需要新退避机制 |
| FLY-1466 | Annie「不加新 flag」铁律 | 本修不引入新 env/flag |

## 4. 修法候选空间

### A′ 账面停驻(主修推荐)— 恢复 1655 前的 known-good 账面形态
engine-owned + gate_carrier_epoch=1 的 run 中,authority `mode==="land"` 且 `creates_pr && completion_route==="needs_review"` 的节点体(= implement 类,QA-FAIL/founder 返工的目标人群)完工投影 **`ship_parked`**(park reason 新值 `rework_reachable_wait`,沿用既有 park 台账;disposition receipt 维持 `terminal_no_gate`),不投 `completed`;ship finalization(post-ship finalizer 的 `RECLAIMABLE_PHASE_STATUSES ∋ ship_parked` 既有回收链)或其余 run 终态写点结算 park → session `completed` + 拆体;被 replacement 取代时在 materialize 同事务清 park。
- ✅ wake 闸零改动(`ship_parked` 本在集合内);FSM 无新边;终态免疫不变;物理体与账面一致
- ✅ 正是 1655 前生产运行了数周的账面形态(回归到 known-good,消费者兼容性已被历史证明)
- ⚠️ 非 finalizer 覆盖的终态写点需要账面结算 helper(writer matrix 详见 plan §2.2)
- ✅ codex 体完工后驻留 + mailbox 消费已由 FLY-1269 resident controller 实现(Blueprint `phaseKeepAlive` + `CodexPhaseLifecycleController` + daemon phase hold);活体演练做定向回归,alive-but-nonconsuming = 演练 FAIL 停发(该情形系统行为为 retry×5 → needs_lead,不存在自动兜底)

### B 复活终态(否)
给 `completed→running` 开受控 FSM 边。违背 §3 三条不变量前科,reaper/receipt-lineage/巡检大面积依赖终态不可逆;审校文化必否。**拒绝。**

### C 终态 holder 受控收体 → 自然 replacement(安全网采纳,即 Fix 2;design review R1-2 修正形态)
coordinator 的 `holder_activation_failed:state_not_revivable:<不可逆终态>` 分支不再 settle(terminal→needs_lead 首跳挂死),但也**不能**直跳 `replacement_pending` —— `materializeWorkflowReworkReplacement` 是 proven-dead 契约(`StateStore.ts:21691-21711`,会写 `execution_dead_rolled_back` + `livenessEvidence:{liveness:"dead"}`),此刻 actor 刚被 probe 证明活着,直跳=伪造死亡账。修正形态:在 rework claim fence 内先用既有 `closeRunner` 受控收体 → releaseRetryable(非终,留退避梯)→ 下一轮 probe 见真死 → classifier 自然 `replace` → 既有 proven-dead materialize + FLY-1718 reconcile —— 把 1759 当晚 Lead 的手工救援(清体+重派+续接分支)机制化,且每步复用既有安全链、crash 后从 durable liveness 重放收敛。
- ✅ 零新机器;死亡证据永远真实;部署窗遗留(completed 体 + active run)也接住
- ⚠️ 单独使用会违背 FLY-939(丢原体上下文),所以只做 A′ 的兜底,不做主修

### D 只改 codex runner 驻留协议(否)
让 codex goal runner 完工后进 QA 体式驻留循环 —— 审计证实**该能力已存在**(FLY-1269 resident controller),无需新建;且单改 runner 侧不修引擎账面(wake 闸依旧拒 completed),治标不治本。**不采纳**;若真机回归发现驻留契约与源码不符,停发本单相关发布并**另立经评审的最小 delta 单**,不在本单扩 scope。

**结论:A′(主)+ C(兜底)= issue 修法候选 (c)「两者结合」的精确化。**

## 5. 现存台账的收尾(非代码修复的一次性运维)

8-10 以来 needs_lead/held 的存量 rework(1574/1680/1708/1686/1710/1718/1715/1726/1674 等)所属 run 多已由 Lead 判终/重派收口;本单不做批量复活手术。上线后新增案例自然走新机制;个别仍 active 的挂死 run 由 Lead 按 1759 现成救援序列处理(或等 Fix 2 部署后自动 replacement)。
