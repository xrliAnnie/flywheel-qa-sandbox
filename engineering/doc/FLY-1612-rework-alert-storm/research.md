# FLY-1612 rework 告警风暴治理 — 调研

Issue: FLY-1612 (https://linear.app/geoforge3d/issue/FLY-1612/告警治理-workflow-rework-held-重试无去重无退避直发-issue-thread-同一句话对-founder)
日期: 2026-08-12
基于: exploration.md

## 1. 调研方法

- 代码审计基线:worktree `flywheel-FLY-1612`,base = main `4f246f52`(含 FLY-1648 #788、FLY-1638 #779)。
- 生产数据:`~/.flywheel/teamlead.db`(1.7GB,sql.js 全量落盘)复制到 scratchpad 后以 `sqlite3 -readonly "file:...?immutable=1"` 只读查询,不触生产文件。
- 历史考古:`git log -S` 追踪第一口消息文本的生灭。

## 2. 生产数据铁证

### 2.1 全库告警家族普查(发射侧,非频道侧抽样)

```sql
SELECT uid 前缀家族, count(*) FROM workflow_run_event
WHERE kind IN ('workflow_engine_alert_posted','workflow_engine_alert_enqueued') ...
```

| 家族 | 已投递条数 | 占比 |
|---|---|---|
| `rework_stalled_alert:*` | **11,714** | **99.9%** |
| `unlaunched_*` | 28 | — |
| `probe_unknown_*` | 25 | — |
| `runner_ship_*` | 17 | — |
| `rework_stalled_hold:*` | 15 | — |
| 其余全部家族 | ≤14 各 | — |

**结论:病灶唯一。** 其余 emitter 家族键形态健康(见 §3.4),历史总量可忽略。

### 2.2 逐 issue 爆发窗(`alert_posted:rework_stalled_alert%`)

| Issue | 条数 | 窗口 (UTC) | 形态 |
|---|---|---|---|
| FLY-1686 | 1628 | 08-11 13:31 → 08-12 06:15 | 多个 request 连环爆发 |
| FLY-1680 | 1272 | 08-11 12:02:58 → 12:32:56 | **恰好 30:00 分钟** |
| FLY-1150 | 1154 | 07-24 → 07-25 | 最早病例 |
| FLY-1655 | 1143 | 08-09 10:16 → 10:46 | 恰好 30 分钟 |
| FLY-1574 | 1045 | 08-10 21:47 → 22:17 | 恰好 30 分钟 |
| FLY-1671 | 1001 | 08-11 10:31 → 11:01 | 恰好 30 分钟 |
| FLY-1573 | 994 | 08-10 22:25 → 22:55 | 恰好 30 分钟 |
| FLY-1614 | 896 | 08-11 11:43 → 12:13 | 恰好 30 分钟 |
| **FLY-1710** | **874** | **08-12 07:40 → 08:10(今晨)** | 病是活的 |
| FLY-1596 / FLY-1708 / FLY-1571 | 480 / 430 / 423 | — | — |

爆发窗恒等于 [30min alert 阈值, 60min hold 阈值) —— 与 §3.3 机制推导完全吻合。

### 2.3 单 request 显微解剖(FLY-1680, run `c79c6f10`, request `rework:73d4d2df…`)

| 事件 kind | 条数 | 时间窗 |
|---|---|---|
| `rework_delivery_claimed` / `released` | 各 **2423** | 11:32:56 → 12:32:55(60 分钟,~1.5s/圈)|
| `rework_activation_stalled_alerted` | **1272** | 12:02:58 → 12:32:55(30 分钟,~0.7 条/秒)|
| `rework_activation_stalled_held` | **1** | 12:32:55(hold 即止)|

delivery 终态:`state=held, generation=2423, hold_count=0, next_retry_at=NULL, last_error=holder_activation_failed:state_not_revivable:completed`。
**`hold_count=0` + `next_retry_at=NULL` 直接证明 held 家族从未进入 strike/退避机制。**

## 3. 代码路径逐段核实

### 3.1 驱动:dispatcher tick = 1 秒

`workflow-engine-dispatcher.ts:275` `start(intervalMs = 1_000)` → 每秒 `reconcile()` → 依次跑 `reconcileWorkflowEngineAlerts`(outbox 投递,max=20/tick)、`reconcileWorkflowReworks`(驱动 coordinator)、`reconcileWorkflowReworkStalls`(stall 扫描)。

### 3.2 缺陷 A:`releaseAndHold` 家族无退避、无 strike、无终局

`workflow-rework-coordinator.ts`:
- 四个 held 出口(行号为当前 main):`rework_reentry_disabled`(L352)、reentry classify hold(L366)、`worktree_not_ready:*`(L399)、`holder_activation_failed:*`(L409)。
- `releaseAndHold`(L237)→ `releaseWorkflowReworkDelivery`(StateStore L20844):只清 owner/lease、写 last_error/updated_at;**state 留 `pending`、不碰 hold_count、不写 next_retry_at** → 下一 tick 立即可再 claim。
- `claimWorkflowReworkDelivery`(StateStore L20745):**每次 claim `generation + 1`**(L20805);唯一的节流是 `next_retry_at`(`delivery_backoff`,L20780)—— 但 held 家族从来不写它。

**对照组(retryable 家族,已治)**:`releaseRetryable`(L253)→ `settleWorkflowReworkFailure`(StateStore L21113):`hold_count++`、`next_retry_at = now + 60s × 2^(holdCount-1)`(1/2/4/8 分钟)、第 5 击 → `needs_lead` + 清 verification path + **单条** severe 告警(uid `rework_held_recovery_exhausted:${requestId}`,episode 稳定)+ 分级 cleanup disposition。`claim` 与 `listWorkflowReworkDeliveries`(L20301,`next_retry_at IS NULL OR <= now`)双侧尊重退避。

### 3.3 缺陷 B:stall 告警去重键 = claim 计数器

`reconcileWorkflowReworkStalls`(dispatcher L1081):
- 阈值:`FLYWHEEL_ENGINE_REWORK_ALERT_MS`(默认 30 分钟)/ `FLYWHEEL_ENGINE_REWORK_HOLD_MS`(默认 60 分钟)。
- guard `if (delivery.hold_count > 0) continue;`(L1106,FLY-1648 注:strike 预算 owner 不与 legacy stall clock 竞速)—— **但 held 家族 hold_count 恒为 0,永远不被这个 guard 保护**。
- `state === "pending"` 时 `sourceAt = request.requested_at`(固定)→ age 单调增长 → 30 分钟起每 tick 都触发 `escalate("alert")`。

`escalateWorkflowReworkStall`(StateStore L18597):
- `eventUid = rework_stalled_alert:${requestId}:${generation}:${executionId}`(L18651)。generation 每秒被 claim 循环推高 → **每 tick 铸新 uid** → `workflow_run_event` 唯一键去重形同虚设 → `enqueueWorkflowEngineAlertTx` 每秒入队一条。
- hold 路径(60 分钟):run → `held`、delivery → `held`,run 不再 active → 扫描停止。这就是每个爆发窗恰好 30 分钟的原因。

### 3.4 健康对照组:姊妹 emitter 的键形态

`escalateWorkflowStalledLaunch`(StateStore,同文件):`eventUid = ${prefix}:${runId}:${nodeId}:${attempt}:${executionId}` —— **无 generation,episode 稳定**,历史仅 28 条。修复方向就是向它看齐。

### 3.5 缺陷 C:僵尸激活的判定与现有 helper

`holder-wake-activation.ts` `activateHolderForWake`:目标 session 非 `running|ship_parked|design_done|awaiting_review` → `state_not_revivable:${status}`。当 status ∈ `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`(StateStore L386:`completed|failed|terminated|blocked|rejected|deferred|shelved`,FLY-1099 定义,注释逐值论证)时,该激活**永不可能成功** —— 现状白烧满 60 分钟撞 hold。判定 helper `isStateStoreIrreversibleTerminalForZombie`(L408)已导出、已被 dispatcher 复用两处。
注意 `state_not_revivable:approved_to_ship`(L42 单列)**不是**不可逆(ship 流程中,状态还会迁移),不得进快速终局。

### 3.6 通道侧为何救不了

outbox 投递(dispatcher L1551):claim-before-send,**刻意**给每次 attempt 造新 transport eventId(`${claim.escalationUid}:${claim.attempt}`,注释:失败重试不能被 ClaimsDB 误抑)。所以 ClaimsDB / LeadAlertNotifier 侧的既有去重对该风暴结构性失效;**唯一有效的去重层是源头 escalationUid**。escalationUid 稳定后,通道侧机制自动恢复为纵深防线。

### 3.7 第一口的考古结论

`git log -S "could not safely re-enter"`:该文本最后一次变更 = **#779(f02ecbc8,FLY-1638,08-05)整体删除 `alertHold` effect**(连同 `workflow-rework-held:${requestId}:${reason}` 的 eventId)。当前 main 上 rework 协调器路径**没有任何 issue-thread 逐次发信点**;rework 相关通知全部走 `workflow_engine_escalation`(Lead 告警面 → alerts 频道)。历史上第一口走的是 `three_stage_stuck` eventType 直发,已不可复现。

### 3.8 outcome 消费面(改动安全性)

dispatcher 对 coordinator outcome 的消费(L940+):`held` / `retryable` / `invalid` **同等对待**(`result.held += 1`),无分支差异。held→retryable 语义并轨在 dispatcher 侧零影响。`plugin.ts` L8893 构造 coordinator,effects 内已无 alertHold。

## 4. 关联工程的边界核实

| 单 | 已治范围 | 与本单关系 |
|---|---|---|
| FLY-1648 (#788, 08-06) | held **pane-loss** rework(`persisted_target_missing`,state=held)的 materialize 重试:`settleHeldReworkRecoveryFailure` 1/2/4/8 退避 + 5 击 needs_lead;dispatcher 侧 60s probe 节流 | 同思想、不同家族。本单不动它;它的 CAS 条件绑死 `last_error='persisted_target_missing'`,与本单家族零交集 |
| 4e3c94ba "cap workflow rework retries" (08-05) | retryable 家族的 `settleWorkflowReworkFailure` strike 机制 | **本单要复用的机制本体** |
| #779 (FLY-1638, 08-05) | 删除第一口 `alertHold` | 已完成的历史;本单只需守住"不再回来"的 invariant |

## 5. 调研结论(设计输入)

1. 修复面 = 三点:held 家族并入 strike 机制(缺陷 A)、stall uid 去 generation(缺陷 B)、不可逆终态激活快速终局(缺陷 C)。
2. 全部复用现有机制:`settleWorkflowReworkFailure`、`isStateStoreIrreversibleTerminalForZombie`、episode 稳定键形态(§3.4)。**无新表、无新 env flag、无 DB migration**(存量 pending 行下一次失败自然进入新路径)。
3. 告警量结构上界(每 rework episode):strike 耗尽 severe ×1 + stall alert ×≤1 + stall hold ×≤1 + 解堵收口 ×≤1 ≈ **≤4 条 vs 现状 1272 条**。
4. issue 字面的通用 (run_id, reason, target_node) 去重层不建(病灶唯一 + raw reason 入键有振荡风险),但 (requestId, route.revision, executionId) 键在语义上等价于 (run, target_node, actor) 粒度 —— 符合 issue 意图。
