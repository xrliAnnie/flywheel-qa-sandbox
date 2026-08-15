# FLY-1770 land 收尾 held(retryable) 无自愈 — 调研

Issue: FLY-1770 (https://linear.app/geoforge3d/issue/FLY-1770/机制-land-收尾-heldretryable无自愈closeout-撞-linear-瞬时失败-run-永久)
日期: 2026-08-14
基于: exploration.md

## 实施前存量 census（2026-08-14）

对生产 `~/.flywheel/teamlead.db` 做只读查询：`land_operation` 共 14 条 `completed`、10 条 `held`，无 `partial`。10 条 `held` 中只有 1 条属于本次可安全自动分类的 `retryable` 存量：FLY-1751 / PR #835，`current_step=notification:finalization_partial`、`merge_confirmed_at=2026-08-14T16:02:28.325Z`、`last_error=linear_lookup_failed_retryable`。其余 9 条均为 `ship_workflow_failed` 或 `pr_head_mismatch`，继续按 terminal 存量保留，不做启动迁移或自动释放。

## 1. 精确触点清单(全部实读源码定位)

| # | 文件 · 位置 | 现状 | 改动方向 |
|---|---|---|---|
| T1 | `bridge/plugin.ts:5219-5262` `lifecycleInfra.preArbitrate` | fresh Linear read `.catch` → `{ok:false, reason:"linear_lookup_failed_retryable"}`;唯一 provider | 返回类型加 `retryable?: boolean` + 降级判定(observation `completed` → PASS;durable floor 干净 → degraded PASS) |
| T2 | `bridge/post-ship-finalization.ts:589-616` preArbitrate 消费 | 一切失败 → `outcome:"held"`(含 `.catch` 的 `arbitration_failed:*`) | retryable → `outcome:"partial"`;degraded → 继续执行 + 审计事件 |
| T3 | `bridge/post-ship-finalization.ts:926-960` 步骤 (3.5) markIssueDone | 失败 → `issueDone=false` → `land_postconditions_incomplete:linear_done` → run 永不完成 | 失败原因分类:cancel-拒绝 → settled;不可达类 → deferred 记账 + 不阻塞 run 完成 |
| T4 | `bridge/land-executor.ts:235-266` `release()` | 写 `partial`/`held`,无记账 | fault-class 记账(attempt++ / next_attempt_at 退避 / cap 耗尽转 held+告警)在同一 CAS UPDATE 内 |
| T5 | `StateStore.ts:39221` `setLandOperationDisposition` | `state/last_error/owner/lease` 单 UPDATE | 承载 T4 的记账列写入 + 耗尽判定 |
| T6 | `StateStore.ts:38996` `listRunnableLandOperations` | `state IN ('intent','partial')`,不看时间 | 加 `AND (next_attempt_at IS NULL OR next_attempt_at <= ?)` |
| T7 | `StateStore.ts:39044` `claimLandOperation` | partial 随时可 claim | 尊重 `next_attempt_at`(dispatcher 直呼 `landExecutor` 会绕过 T6,**闸必须设在 claim 层**) |
| T8 | `StateStore.ts:16679` `land_operation` 表 | 无退避列 | 幂等 ADD COLUMN:`retry_count`、`next_attempt_at`、`retry_epoch_key`、`linear_done_deferred_at`、`linear_done_settled_at`;deferred sweep 另有 `linear_done_retry_count` / `linear_done_next_attempt_at` / `linear_done_last_attempt_at`(FLY-267 同款迁移形态) |
| T9 | `bridge/plugin.ts:7267` `landOperationTick`(GatePoller rider,30s) | 只扫 runnable | 追加慢周期段:扫 `completed AND linear_done_deferred_at NOT NULL AND settled IS NULL` → 重跑 `markLinearIssueDone`(零新 timer) |
| T10 | `StateStore.ts:39335` `holdWorkflowLandNode` / alert 管道 | held 已 enqueue alert(routedAlertSink,FLY-1764) | 耗尽转 held 的 alert payload 附 attempt 历史;沿用现有投递 |
| T11 | 测试:`__tests__/post-ship-finalization.test.ts`(30 tests)、`StateStore.land-lifecycle.test.ts`(18)、`workflow-engine-dispatcher.test.ts`(land 段) | 无 retryable/退避/降级覆盖 | 交付 3 的回归 fixture 落点 |

### 爆炸半径核查

- `preArbitrate`:**恰好 1 provider(plugin.ts:5219)、1 consumer(post-ship-finalization.ts:589)** —— 契约改动收敛。
- legacy 调用方(`DirectEventSink.ts:1163`、`event-route.ts:2222/2689`、`merge-ship-gate.ts:575`、`external-merge-reconcile.ts:463`)spread `...lifecycleInfra` 带入 preArbitrate,但 `runPostShipFinalization` 返回 void、outcome 被丢弃 —— retryable→partial 的映射改动对 legacy 路径**零行为变化**(refusal 依旧零 mutation 短路;重试由各自事件面驱动)。degraded PASS 会让 legacy 路径在 Linear 不可达时也继续本地清理 —— 与 land 路径同语义,是修复不是回归。
- `land_execution_error:*`(thrown,land-executor.ts:491-515)现已走 partial —— 归入 fault-class 记账即可;`land_step_receipt_conflict` → held 保持不变(真终态)。

## 2. reason 分类学(退避预算的记账对象)

| class | 成员(现有 reason 字面) | 记账 | 退避 |
|---|---|---|---|
| **waiting**(正常等待外部推进) | `ship_workflow_pending`(等 CI)、`founder_projection_pending`、founder-review precondition retryable 族 | 不烧预算 | 无(维持 30s sweep 现状 —— merge 靠它被及时发现) |
| **fault-retryable**(瞬时故障,期望自愈) | `linear_lookup_failed_retryable`、`arbitration_failed:*`(thrown)、`land_execution_error:*`(gh/网络等) | attempt++,**同 durable progress epoch 合计** | 1m/2m/4m/8m/15m/30m/60m/120m,第 9 次耗尽 → 真 held + fail-loud(code review R1 从原 15 分钟窗加宽到约 4 小时) |
| **progress-tracked**(级联推进中) | `issue_closeout_incomplete`、`land_postconditions_incomplete:*` | 同 fault-retryable 记账;只有新 `land_operation_step` receipt 改变 durable progress epoch 才重置 | 同上 |
| **terminal**(真终态,不重试) | `pr_head_mismatch`、`pr_closed_unmerged`、`ship_workflow_failed:*`、`cool_trigger_receipt_corrupt`、`land_step_receipt_conflict`、确证 canceled/parked 拒绝 | — | 直接 held(现状不变) |

计数键 = `retry_epoch_key`(列),由 `{land_operation_step 行数}:{最新 step 名}` 组成。只有 durable step receipt 前进才令 `retry_count` 归零;reason 或 class 单独变化不会重置,避免两种错误交替时永远不耗尽。FLY-1751 的正常级联每完成一步都会落新 receipt,因此真实进展不会被跨阶段累计误杀。

## 3. Linear 依赖降级的两个判定点

### 3.1 preArbitrate(读依赖,T1)

fresh read 失败时按序:
1. `getLinearStateObservation` 显示 `lastStateType === "completed"` → **PASS**(Done 已被集成翻好 = 非 canceled 确证;FLY-1751 正是此况 —— observation 由 `done-thread-reconcile.ts:438/855` 的 Linear 对账 sweep 写入,monotonic guard 防回退)。
2. durable floor 干净(无 park tombstone、无 canceled observation —— 这两项在 fresh read **之前**已查)→ **degraded PASS**:继续本地清理,写 `post_ship_arbitration_degraded` 审计事件(insertEvent,幂等 event_id)。
3. 有确证 cancel/park → 照旧拒绝(terminal,非 retryable)。

安全论证见 exploration.md §3(merge 已发生;唯一危险外部写有独立双 fresh-read 守卫;归档可重开)。

### 3.2 markIssueDone(写依赖,T3)

`markLinearIssueDone`(linear-issue-finalizer.ts)现有结果分类 → 新消费方式:

| 结果 | 现状 | 新行为 |
|---|---|---|
| `done:true`(含 `already_completed`) | issueDone=true | 不变 |
| `issue_canceled_never_overwritten` | partial 永挂 | **settled-by-refusal**:founder 的 Cancel 是权威,记 receipt,run 正常完成,不进队列不告警 |
| `state_unreadable_fail_closed` / `mark_issue_done_timeout` / thrown | partial 永挂 | **deferred**:`linear_done_deferred_at` 记账,run 正常完成;T9 慢扫重试(每次仍走全守卫;`already_completed` 即消) |
| 解析类失败(无 completed-type state 等) | partial 永挂 | deferred + 告警(重试无害,但需要人看) |

即:`linear_done` 从 run-blocking postcondition 中**整体移除** —— 三种出路(成功/refusal-settled/deferred)都不再扣住 run。`worktree`/`thread_archive` 两项 postcondition 保持 blocking(它们是本地/Discord 清理,归 progress-tracked 预算,耗尽转 held+告警 —— 比现状的静默永挂更诚实)。

### 3.3 deferred Done 队列载体选型

| 方案 | 评价 |
|---|---|
| 新表 `linear_done_queue` | 新状态面,杀鸡用牛刀 |
| **land_operation 行自身两列**(`linear_done_deferred_at` / `linear_done_settled_at`)+ T9 慢扫(15min 段,复用 30s rider 内部节流) | **选此**:队列 = operation 行,零新表零新 timer;settled 即出列 |
| GatePoller 新 rider | 与 landOperationTick 重复,无必要 |

告警纪律:deferral 当刻一条(informational,Lead 知道 Done 进了队列);未 settled 满 24h 再一条(episode uid 带 day bucket 去重)。不刷屏。

## 4. 关键工程约束

1. **闸在 claim 层(T7)**:dispatcher `consume()`(workflow-engine-dispatcher.ts:2050)直呼 `landExecutor`,绕过 `listRunnableLandOperations` —— `next_attempt_at` 若只挂在 T6,退避会被 dispatcher tick 击穿。`claimLandOperation` 拒绝 `next_attempt_at > now` 的 partial → 两条路径统一受闸。dispatcher 拿到 busy 维持现状(intent 留待下 tick)。
2. **单写者**:记账(attempt++/退避/耗尽转 held)全部收在 `setLandOperationDisposition` 的同一 owner+generation CAS UPDATE 内 —— 不引入第二个写者。
3. **幂等迁移**:5 个新列走既有幂等 ADD COLUMN 形态(FLY-267 `reply_channel_id` 同款);存量行 NULL → 行为与今天逐字一致(NULL next_attempt_at = 随时 runnable)。
4. **无新 env flag**:founder 铁律(FLY-1466「不加新 flag」)。这是 bug 修复,行为由回归 fixture 守护,不设逃生口。
5. **告警复用**:耗尽转 held 走既有 `holdWorkflowLandNode` → `enqueueWorkflowEngineAlertTx` → routedAlertSink(FLY-1764)管道,payload 附 `{attempts, firstFailureAt, reasonClass}`;不建新告警面。
6. **`workflowFiniteTimestamp` 校验**:所有新时间戳列写入沿用现有校验函数。

## 5. 回归 fixture 设计(交付 3)

| # | 剧本 | 断言 | 落点 |
|---|---|---|---|
| F1 | Linear lookup 失败一次 → 恢复(FLY-1751 重放) | 第一次 pass → operation `partial`(**非 held**)+ `retry_count=1` + `next_attempt_at≈+1m`;时钟推进后 sweep 重试 → preArbitrate 过 → 级联全走(closeout/thread/run completed,Done 经 `already_completed` 消)| `workflow-engine-dispatcher.test.ts` land 段 或新 `land-selfheal.test.ts` |
| F2 | Linear 持续不可达(fresh read + markIssueDone 全 fail) | preArbitrate degraded PASS(审计事件在);本地清理全完成、run `completed`;`linear_done_deferred_at` 有账 + informational alert 恰一条;注入 Linear 恢复后 T9 慢扫翻 Done → `settled` | 同上 + `post-ship-finalization.test.ts` |
| F3 | fault-class 持续故障(arbitration thrown ×9) | 退避时间戳序列 1m/2m/4m/8m/15m/30m/60m/120m;第 9 次 → operation `held` + run `held` + alert payload 含 attempt 历史 | `StateStore.land-lifecycle.test.ts` + dispatcher 测 |
| F4 | 守卫:canceled observation / park tombstone;markIssueDone 撞 canceled | 前两者 → 拒绝(held,不降级);后者 → settled-by-refusal,**零 Done 写** | `post-ship-finalization.test.ts` |
| F5 | 字节兼容哨兵 | 无故障路径(全部成功)行为逐字不变;存量 NULL 列行 runnable 语义不变 | 各文件既有测试保持全绿即哨兵 |

## 6. 未解决 / 交给 plan 的裁量

- 退避形态镜像 FLY-1648 的有界持久化做法,但 code review R1 将本单恢复窗定为 1m/2m/4m/8m/15m/30m/60m/120m、cap=9,约 4 小时后才转人工;plan 中定死,不留可调 knob(无新 flag 铁律)。
- deferred Done 慢扫周期(15min)与 24h 提醒 bucket —— plan 定死为常量。
- `thread_archive` postcondition 耗尽转 held 是行为收紧(现状静默永挂)—— plan 中明示为附带修复,codex-design-review 把关。
