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

`resolveWorkflowGateAuthority`(`workflow-run-snapshot.ts:165-206`):在 snapshot 节点里筛「runner ship carrier」(需 `creates_pr && can_ship && can_land && approval_gate_holder && needs_mailbox_transport && completion_route==="needs_review"` 全真);零候选 → `engine_terminal`。

- **1655 前**:tpl_code implement 即 carrier → 完工 `ship_parked`(park 台账 `appendWorkflowEngineParkEventTx`,reason `runner_ship_gate_wait`)→ 可复活。
- **1655 后**(#795 改 seed:加 `land` 节点 + `approval_gate.node=land`;run a65fd4fe snapshot 实证 implement `can_ship=false`):零 carrier → `engine_terminal` → implement 完工 `completed` 终态。design(`phase_design_complete`)、qa(`no_code`)同样投 `completed`,但它们不是 QA-FAIL 返工的账面断点:qa 体按 runner 协议 verdict 后不 complete(session 持 running,retest wake 可达);design 目标返工在台账中无案例。

补充:`workflowCompletionDispositionForContext`(`StateStore.ts:28298-28316`,FLY-1731)已把每次完工分类为 `runner_ship_park` / `engine_gate_handoff` / `terminal_no_gate` 三种 disposition 并落 immutable receipt —— **引擎其实"知道"这是 engine handoff 而非真终结**,只是投影仍打成 completed。

## 3. 相关前科与不变量(修法边界)

| 前科 | 内容 | 对本设计的约束 |
|---|---|---|
| FLY-939 | wake 停驻体,绝不 respawn(原体持上下文) | 主修必须恢复 wake,respawn 只做兜底 |
| FLY-1462 #700→#704 revert | 「把 FSM 终态当死亡证据授权 replace」被否;重立时要求正向死亡证据;设计原话「completed deliberately excluded (parked-alive shape)」 | completed=停驻活体是既有共识;**不能**把 completed 直接当死亡证据无差别 replace |
| FLY-1228/1229 Finding K | 终态免疫:terminal session 不被误判/误清 | 大量 reaper/巡检依赖「终态不可逆」;**不宜**开 completed→running 复活边 |
| FLY-1731 | completion_disposition receipt;「Bridge 误判终态」修复靠不让 completed 投影堵门,而非复活终态 | 同上:方向是"别错误终态化",不是"终态可逆" |
| FLY-1612 | rework 告警 episode 收敛 + terminal 立即耗尽 | 保留其告警形态;Fix 2 改的是 terminal 分支的**去向**(replacement 而非 needs_lead) |
| FLY-1718 | re-dispatch 先对账存量分支/PR | replacement 起新体时续接分支/PR 的既有基建 |
| FLY-1648 | held pane-loss materialize 1m/2m/4m/8m 退避,5 次 needs_lead | replacement 物化失败已有收敛,Fix 2 不需要新退避机制 |
| FLY-1466 | Annie「不加新 flag」铁律 | 本修不引入新 env/flag |

## 4. 修法候选空间

### A′ 账面停驻(主修推荐)— 恢复 1655 前的 known-good 账面形态
engine-owned run 中,`engine_gate_handoff` 且 `creates_pr` 的节点体(= implement 类,QA-FAIL/founder 返工的目标人群)完工投影 **`ship_parked`**(park reason 新值 `rework_reachable_wait`,沿用既有 park 台账),不投 `completed`;run 到达终态(land done / terminated)或该体被 replacement 取代时,park 结算 → session `completed` + 既有回收链拆体。
- ✅ wake 闸零改动(`ship_parked` 本在集合内);FSM 无新边;终态免疫不变;物理体与账面一致
- ✅ 正是 1655 前生产运行了数周的账面形态(回归到 known-good,消费者兼容性已被历史证明)
- ⚠️ 需要新增「run 终态 → 结算本 run 全部 parked 体」的收尾腿(1655 前由 ship carrier 的 post-ship-finalization 承担,现在没有)
- ⚠️ codex 体完工后 mailbox 轮询可达性未证实 → 活体演练必验;若不可达,wake 失败落 retry/hold,由 Fix 2/replace 兜底,不再挂死

### B 复活终态(否)
给 `completed→running` 开受控 FSM 边。违背 §3 三条不变量前科,reaper/receipt-lineage/巡检大面积依赖终态不可逆;审校文化必否。**拒绝。**

### C 终态 holder 降级受控 respawn(安全网采纳,即 Fix 2)
coordinator 的 `holder_activation_failed:state_not_revivable:<不可逆终态>` 分支不再 settle(terminal→needs_lead),改 advance 到 `replacement_pending` → 既有 `materializeWorkflowReworkReplacement` + FLY-1718 reconcile 自动重生 —— 把 1759 当晚 Lead 的手工救援(判终原体+重派+续接分支)机制化。
- ✅ 复用既有机器,改动一个分支;把「体可用却死路」之外的所有终态残局(体被 Lead 清、crash、部署窗遗留)也接住
- ⚠️ 单独使用会违背 FLY-939(丢原体上下文),所以只做 A′ 的兜底,不做主修

### D 只改 codex runner 驻留协议(否,作为可选后续)
让 codex goal runner 完工后进 QA 体式驻留循环。跨包改 codex daemon 运行时,且不修引擎账面(wake 闸依旧拒 completed),单独做治标不治本。**不采纳为主修**;若演练证实 codex 完工后 mailbox 不可达,以最小腿形态并入(见 plan §风险)。

**结论:A′(主)+ C(兜底)= issue 修法候选 (c)「两者结合」的精确化。**

## 5. 现存台账的收尾(非代码修复的一次性运维)

8-10 以来 needs_lead/held 的存量 rework(1574/1680/1708/1686/1710/1718/1715/1726/1674 等)所属 run 多已由 Lead 判终/重派收口;本单不做批量复活手术。上线后新增案例自然走新机制;个别仍 active 的挂死 run 由 Lead 按 1759 现成救援序列处理(或等 Fix 2 部署后自动 replacement)。
