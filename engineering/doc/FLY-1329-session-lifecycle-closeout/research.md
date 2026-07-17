# FLY-1329 session 生命周期底座收口 — 调研

Issue: FLY-1329 (https://linear.app/geoforge3d/issue/FLY-1329/infra-session-生命周期底座收口-重启收尾路径不得杀-park-aliveexecutor-merge-必须)
日期: 2026-07-16
基于: exploration.md

> brainstorm gate 已过(Tadashi 批准,含三点补充:合法 executor-merge 不得报违规且要有测试 / docs-only 不可被卡死 / 与 #627 merge 顺序对齐)。本文档钉死实现所需的全部代码事实与约束,行号以 FLY-1329 分支(= main 02db0327)为准。

## 1. 子系统清单(实现刀口索引)

### 1.1 D1 — handoff 判死 / re-adopt / prune

| 事实 | 位置 |
|---|---|
| handoff park-vs-close 决策:alive→park;indeterminate→fail-closed;**absent/dead_pin→closePhaseRunner** | packages/teamlead/src/bridge/phase-orchestrator.ts `handoff()`(prod head :1640 起;main 同构,新增 engine-owned 守卫不影响) |
| `probePhaseAlive` = CommDB `tmux_window` 名 → `probeRunnerProcessLiveness`;**名字 miss → `absent`** | plugin.ts:7496(prod head);tmux-lookup.ts:371 `probeRunnerProcessLiveness`,4 态 `alive/dead_pin/absent/indeterminate` |
| `closePhaseRunner` effect:closeRunner(finalizeDone, executorType:"phase") + **worktree/branch teardown**(FLY-793 R1#1 handoff 拥有 teardown) | plugin.ts(prod head :7336 起,`reason: three-stage ${role} handoff`) |
| `parkPhaseRunner`(keep-alive 正路)只写 `runner_declared_states` parked 标记 | plugin.ts:7833;`flywheel-comm park` 同款(declare-state.ts:84,**不改任何 status**) |
| keep-alive 开关默认 ON | three-stage-policy.ts:299 `FLYWHEEL_THREE_STAGE_KEEPALIVE !== "0"`(生产未设 → ON;事故走的是 keep-alive 分支的 absent 误判,不是 legacy 分支) |
| re-adopt 只认 running:boot `seedReconnecting` filter `status==="running"`;周期 `reconcileMonitorLossReadopt` 经 `getOrphanSessions`(`WHERE status='running'`) | HeartbeatService.ts:1437-1439 / :904;StateStore.ts:4462-4464 |
| implement park 态 = `awaiting_review`(HANDOFF_STATUS.implement);design park 态 = `design_done` | phase-orchestrator.ts:507 |
| CommDB row 删除三口:`finalizeSession`/`deleteSession`/`deleteSessionAndRunnerPhaseLifecycle` | flywheel-comm/src/db.ts:2093/2143/2150 |
| boot CommDB 清理:`reconcileCommDbRunningAgainstFsm`(FSM ∈ deletable 且 tmux 验尸 dead → 删)+ `pruneDeadTerminalCommDbSessions` | commdb-fsm-reconcile.ts:109(deletable 集 :60,`completed` 在内)、commdb-session-prune.ts:132;**验尸同样用窗名 probe** |
| park 声明表 `runner_declared_states`(kind parked/long_task, expires_at NULL=无限期);Bridge 读 `getEffectiveDeclaredState` | db.ts:43-50 / :1734;park-watch.ts:304 |
| FLY-324 done-but-running 扫(boot):`running`+stage=completed+无 route+无 pr → 强转 completed,唯一豁免是手工 env 名单,**不读 parked 声明** | done-running-reconciler.ts:71/104/152;plugin.ts:5676-5692 |
| 事故审计账本(532c634b):04:47:31 `awaiting_review→completed` trigger=`fly638_close_runner_done` + `lead_close_runner_finalized{reason:"three-stage implement handoff"}`;04:48:00 `worktree_cleanup_done{branchDeleted:true}`;之后 boot `FLY-638 CommDB prune scanned=2 pruned=2` | teamlead.db session_events #72793-72816;/tmp/flywheel-bridge.log |

### 1.2 D2 — executor-merge finalize / merge_actor

| 事实 | 位置 |
|---|---|
| 收口唯一门 `isPostApproveShipComplete`:硬要求 landing merged + shipEligible | post-ship-finalization.ts:68-99;编排器 `runPostShipFinalization` :422-763 |
| 三个消费口:DirectEventSink:1003 / event-route:1584(session_completed)/ event-route:1938(W2 stage_changed+merged) | 同名文件 |
| **W2 看到 merge 但拒收**:`FLY-869 merge_without_approval — NOT ship-eligible; parked (no finalize)`(FLY-1283 铁证) | event-route W2 分支;日志 951021 行 |
| Fix D `external-merge-reconcile.ts`(FLY-945):`checkPrMergeViaGh` :85-123;`handleParked` :295-342(同过 ship-eligibility);`handleCompletedUnfinalized` :344-414;**候选硬要求 `pr_number`**(:440/:457);TTL 30min + 每 project 每 pass 3 gh;dedupe event `external-merge-finalized-${execId}`;kill `FLYWHEEL_EXTERNAL_MERGE_RECONCILE=0` | 接线 plugin.ts:6193/:6916,gate-poller.ts:1155-1168(patrol ≈60s) |
| main 新增:Fix D finalize 前还需 `computeEngineWorkflowShipPrecondition`(FLY-1307 PR-7.5 engine 前置)——**D2 改动必须保留该前置**(engine-owned 行以 engine 快照为准) | external-merge-reconcile.ts(main delta +25 行) |
| `merge_actor` 概念全库不存在;`gh pr view --json mergedBy` 可得;`mergeCommitSha` 在 W2 是 payload-only(event-route.ts:2011 明示非列) | — |
| 记账落点先例:`session_params` JSON evidence-marker(`markEvidenceGapCompletion`,fly208 模式) | post-ship-finalization.ts:113-126 |
| FSM 边已合法:`awaiting_review→completed`(FLY-60 W2)、`approved_to_ship→completed` | core/src/workflow-fsm.ts:146-174 |
| 差点 page Annie 的 pager = park-watch(awaiting_review + 绑定 review 问题,N1/N2 各 10min,无 merge/liveness 检查) | park-watch.ts:180/:223/:268-277 |
| founder 授权痕迹(Tadashi 补充 a 的判据源):`workflow_source_event` founder_approval 行 / `verify-approval` 链(`ship_approval_requests`)/ founder_action_ledger | StateStore 表;verify-approval.ts |

### 1.3 D3 — session-independent finalize

| 事实 | 位置 |
|---|---|
| "No session found" 真实抛出点 = **Lead MCP 工具层**:按 issue+`fromStates`+role 找 session,awaiting_review 不在 close 的候选集合 → `No session found for issue X in status: ...`(还没到 close-runner.ts) | tools.ts:380-398;另 actions.ts:230/516/659/1318 按 exec_id 直查 miss 时同文案 |
| close-runner 本体:`store.getSession` miss → `session_not_found`(:222-228);`finalizeDone` 源状态集 `{running,awaiting_review,approved_to_ship,design_done}`(:76-86),trigger `fly638_close_runner_done` | close-runner.ts |
| 无活 session 的 FSM 收口先例:`finalizeStaleBlocker`(merged/closed PR → applyTransition→completed) | stale-blocker-guard.ts:199/:325 |
| reconciler 家族公共形状:纯核心 + boot drain/patrol 搭车(不加 timer)+ `insertEvent` 稳定 event_id 去重 + fail-closed 不抛 + env kill 开关 + 变更前重读行 | external-merge-reconcile / complete-marker-reconciler / stale-approved-ship-reconciler / statestore-ghost-reconcile 等(exploration 附录清单) |

### 1.4 D4 — QA-first hold

| 事实 | 位置 |
|---|---|
| hold 单一谓词 `reviewHoldReason`,四消费口(GatePoller relay / event-route 投递抑制 / DirectEventSink push 抑制 / Heartbeat gate_timed_out 跳过) | auto-qa-held.ts:124-193;gate-poller.ts:861-874;event-route.ts:2527;DirectEventSink.ts:981;HeartbeatService.ts:719 |
| 三个放行窗口:非 awaiting_review 直接不 hold(:139);无 record 落 FLY-1251 snapshot 兜底,docs-only fail-open(:185);record 要等 `claimAutoQaRecord`(coordinator :647,晚于 codex-hold :503 与多个 await) | 同上 |
| `qa_required` 不可变快照:policy-off → required=0(`policy_off:*`,:520-528);适用 → required=1(:557);**「无 review 证据」skip(:543-553)不写快照 → NULL 永存**——这类 session 走 pre-FLY-579 老路径,**不能被 NULL-hold 卡死**(判据 `hasReviewEvidence` = 绑定 qid 非 UNBOUND 或 pr_number 非空) | auto-qa-coordinator.ts:505-570 |
| codex-hold 窗口内 qa_required=NULL 但 :156 的 codex_pending 已 hold(NULL-hold 与之一致,非新增阻塞) | auto-qa-held.ts:156 |
| approve gate row 是 runner 写 CommDB(gate.ts),Bridge 只能管 founder 面浮出;FLY-1314 已论证并放弃 gate-open 原子守卫 | FLY-1314 exploration §3.1 |

### 1.5 D5 — turn/complete 滞后

| 事实 | 位置 |
|---|---|
| `turnStatus`:getSession(exec)→getTurn(issue)→比对 holder;**不看 session 状态** | flywheel-comm/src/commands/turn.ts:36-53 |
| TURN 只被两处删:post-ship-finalization.ts:396(merged ship)与 `reconcileOneTurn`(仅 stale 无活 phase);**completed 的 qa holder 被明确豁免**(:2007-2009,注释假设 finalization 马上删) | phase-orchestrator.ts:1925-2058 |
| `session_completed` 只写 StateStore;CommDB sessions.status 无人更新(status CHECK 集合表达不了多数终态,离场唯有 DELETE);CommDB 有现成 `markSessionTerminalStatus`(db.ts:2038-2079) | complete.ts:256;db.ts |
| 铁证:fbe23871 StateStore completed(05:34)而 CommDB 至今 running、three_stage_turn holder 至今是它(epoch 8),后继 a5910ea6 拿不到 turn | 生产双库只读查询 |
| FLY-1314 PR-2 将做 merge-gated TURN 回收(`deleteTurnIfCurrent` CAS 进 db.ts)——**非 merge 完成仍不覆盖**,且不改 turn.ts | FLY-1314 plan;PR #627 OPEN(MERGEABLE,2026-07-16 查) |

## 2. 开放问题结论(exploration §7 逐条)

1. **"No session found" 刀口** = tools.ts:380-398 的 issue+fromStates 候选过滤(awaiting_review 僵尸在工具层就不可见),而非 close-runner.ts 的 getSession。修法归入 D3:close_runner(done=true) 的候选查找在带终局证据时放宽到非终态,或直接提供 fsm-only 收口动作。
2. **main vs prod head(99 commits)**:相关文件 delta 仅 FLY-1307 PR-7.5(materialized-head-authority / engine-owned 守卫)与 FLY-1272(linked-view kill 安全),事故机制路径行为一致。约束:D2 改 Fix D 时保留 `computeEngineWorkflowShipPrecondition` 前置与 engine-owned 语义;phase-orch 改动避开 `isEngineOwned` 短路分支的语义。
3. **A2 活动性证据**:双源取最新——StateStore `sessions.heartbeat_at` + CommDB `messages` 中该 exec 最近一条时间戳;阈值 env `FLYWHEEL_LIVENESS_ACTIVITY_WINDOW_MS`(默认 10min)。`absent` + 窗口内有活动 → 改判 `indeterminate`(fail-closed 留 reconcile)。
4. **NULL-hold 回归面**:fail-closed 仅在 `hasReviewEvidence(session)` 为真时生效(coordinator 必然会对这类 session 落一次 qa_required 决策,含 policy-off 的 required=0);无 review 证据的 session 保持既有行为(pre-FLY-579 老路径不受影响)。docs-only 项目由 required=0 快照放行(Tadashi 补充 b 满足)。
5. **FLY-1314 #627**:OPEN。plan 排序:D5 的 TURN 放宽设计为「若 #627 先合,复用其 `deleteTurnIfCurrent`;若本单先合,自带最小 CAS 删除,#627 rebase」——merge 顺序 ship 时与 Tadashi 对齐(补充 c)。

## 3. 约束与不变量(plan 必须满足)

- **C1 字节兼容**:所有行为改动带 env kill-switch,默认新行为 ON 仅限「不误杀」类(A1/A2/A4 fail-closed 方向);影响 founder 面的 D4 hold 收紧默认 ON 但保留 `FLYWHEEL_QA_FIRST_HOLD=0` 逃生口;D2 finalize 语义变化(merged 一律收敛)带 `FLYWHEEL_EXTERNAL_MERGE_FINALIZE` 开关,默认 ON(Annie 直令 fix now)。
- **C2 无新 timer**:一切周期性工作搭 GatePoller patrol / Heartbeat tick 便车(reconciler 家族既有形状)。
- **C3 审计**:每一次破坏性生命周期动作已有 session_events;新增:`park_liveness_downgrade`(absent→park 时)、`external_merge_finalized`(带 merge_actor/authorized)、`prune_skipped_parked_conflict`(A4 矛盾告警)。
- **C4 单一 finalize 路径**:D2/D3 全部汇入 `runPostShipFinalization`,不新增第二套收尾。
- **C5 授权判定(Tadashi 补充 a)**:merge_actor 合法性 = 「存在 founder 授权痕迹」——verify-approval 绑定链(`ship_approval_requests` 对该 head 的 approved 记录)或 founder_action_ledger/workflow_source_event founder_approval;命中 → 正常 finalize + 记账;未命中 → finalize + violation 告警。**两侧都要有测试**(合法 executor-merge 不报违规;无痕迹 merge 报违规但仍收敛)。
- **C6 测试红线**(memory 教训):fixture 按生产形态构造;负向断言(「不得 close」「不再滞留」)必须配突变验证;1319/1283 两个重演形态为回归底线。
- **C7 三段式共享分支**:keep-alive ON 时 handoff 任何分支不得删 branch B/共享 worktree;teardown 只属于 ship finalization。

## 4. 风险清单

| 风险 | 缓解 |
|---|---|
| A1 把真死 runner park 住 → 尸体滞留 | dead_pin 仍即时 close;absent 的尸体由既有 reconcile(FLY-1204 reclaim / crash-reaper)按其 TOCTOU 守则收,延迟收尸无害;告警可见 |
| D4 hold 收紧误伤老路径 / docs-only | `hasReviewEvidence` 前置 + required=0 快照放行 + 逃生 env;对 auto-QA 未接线的部署,NULL-hold 不生效(coordinator 不在场则无快照写手,必须以 hasReviewEvidence+coordinator 在场双条件) |
| D2 「merged 一律收敛」被滥用为绕批准 | 收敛 ≠ 豁免:violation 告警 + merge_actor 永久记账 + founder-only-authority 合同仍禁 runner 自 merge;FLY-827/verify-approval 的 merge 前防线不动(本单只管 merge 后收口) |
| 与 #627 改同文件冲突 | plan 排 PR 序 + ship 窗与 Tadashi 对 merge 顺序;TURN 原语复用策略双向写明 |
| Fix D gh 预算被扩大的候选面撑爆 | 候选扩面只去 pr_number 硬前提(branch 推导),TTL/预算/轮转保留 |

## 4.5 ⚠️ 勘误增补(Codex design review R1-R4 推翻的本文结论 — 冲突处一律以 plan.md 最新版为准,当前 = v5/R4 已折入)

| 本文原结论 | 状态 | 替代结论(plan v3) |
|---|---|---|
| §2.3 「absent + 活动窗口内有活动 → 改判 indeterminate」 | **作废** | 活动证据只作告警注释;absent 在 handoff 语境一律 park + 继续 dispatch(indeterminate 保持现状 fail-closed);裁决 = action+authority+declared+liveness 四输入 |
| §3-C5 「授权痕迹 = ship_approval_requests / founder_action_ledger / workflow_source_event」 | **部分作废** | 前两者不是授权证据(outbox / delivered ≠ approval);只认 verify-approval 同源 gate-response 链或 workflow_source_event founder_approval canonical claim,且绑定 exact merged head |
| §4 风险表「absent 的尸体由既有 reconcile(FLY-1204/crash-reaper)收」 | **作废** | FLY-1204 对非终态 parked 是 alert-only;absent 尸体 = 人工经 closeSessionResidue 收,明确非目标自动收尸 |
| §2.1 D3 根因「tools.ts:380-398 的 issue+fromStates 候选过滤」 | **作废** | 该处是通用 /resolve-action,无 close_runner action;terminal-mcp DONE_STATUS_SET 已含相关状态。D3 改为证据先行:当前 head 重演 "No session found",区分 StateStore-row-缺失 / 仅 tmux-CommDB-缺失 / Terminal-MCP-scope 三形态后定刀口 |
| §3(D2/D3)「一律走 runPostShipFinalization」 | **收窄** | 只有 exact merge 证据 + 授权链的 finalizeMergedSession 可跑 post-ship DAG;issue-terminal/Lead 明示走 closeSessionResidue,绝不合成 shipped;blocked 保持 preserve |
| §2 D5 修法「complete.ts 双写 CommDB + turn 看终态」 | **作废** | CLI 不猜终态(route≠终态,HTTP 200≠FSM 落地);改为 Bridge 侧 terminal-commdb-sync 严格扩 failed\|blocked\|completed,turn 只读 Bridge 镜像 |
| §1.4 D4 修法「qa_required IS NULL → hold;=0 → 放行」 | **部分作废** | qa_required 完全退出 founder 放行判定(FLY-1251 不变量:只有 same-head PASS 或 exact-head docs-only snapshot 放行);NULL/未决窗口 → qa_pending_decision hold |

## 5. 测试策略(plan 细化基线)

- 单元(v3 语义,见 §4.5):destructive-verdict 四输入矩阵——**活动证据变化不得改变 verdict**(absent 一律 park/hold,活动只改告警措辞);reviewHoldReason 组合矩阵含 **qa_required 维度只验证「对 founder 放行结果无影响」**(放行仅 same-head PASS / exact-head docs-only snapshot);merge_actor 授权判定两侧。
- 集成(重演形态,fixture 生产形态 + 突变验证):
  - R-1319:park-alive implement(awaiting_review + parked 声明 + CommDB 窗名指向不存在窗)→ 触发 handoff → 断言 park 且 FSM 不动、分支 B 未删;突变(把 A1 改回 close)必须红。
  - R-1283:awaiting_review + PR merged(gh stub 带 mergedBy)+ 无 landing 信号 → patrol 一轮 → 断言 FSM completed + merge_actor 记账 + park-watch 不再告警;无授权痕迹变体断言 violation 告警。
  - boot 序:重启后全角色 re-adopt(awaiting_review/design_done 进入候选)+ prune 的 parked-veto——**parked 声明命中即 skip+告警,与活动新旧无关**(活动只进告警正文);fresh terminal + 无 parked 冲突的 residue 照常可清。
- 真机(独立 QA phase 承担):529 Room 或 real-tmux 探针配方(memory: FLY-1269 三点探针 / FLY-1282 真 freeze 教训)。
