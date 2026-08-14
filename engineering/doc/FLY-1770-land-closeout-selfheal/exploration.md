# FLY-1770 land 收尾 held(retryable) 无自愈 — 探索

Issue: FLY-1770 (https://linear.app/geoforge3d/issue/FLY-1770/机制-land-收尾-heldretryable无自愈closeout-撞-linear-瞬时失败-run-永久)
日期: 2026-08-14
基于: 无

**Mode**: Technical · **Depth**: Standard · **Status**: final(headless Runner,决策依据 = issue 交付清单 + 代码审计)

## 0. 实证背景(FLY-1751,2026-08-14)

merge 本身成功(🆒 正规链路),但 land 收尾:

- 16:03 `land_partial` reason=`issue_closeout_incomplete` → 下一个 pass `land_held` reason=`linear_lookup_failed_retryable`
- reason 字面写着 **retryable**,但 held 没有任何重试器 → run 永久 held
- 清理级联全断:close 双体、archive thread、run completed 全没跑;founder 一小时后自己发现
- 反讽:Linear 16:02 已由 GitHub 集成翻好 Done —— 失败的只是一次晚一分钟的**读**操作

## 1. 代码审计 — 机制链现状(全部实读源码验证)

### 1.1 land 收尾执行链

```
workflow engine dispatcher (land node intent)
  → landExecutor = executeLandOperation(operationId)          [land-executor.ts:273]
     state 短路: completed → 返回; held → 返回(死路)
     claim lease (1h) →
     1. authorize(gate holder / head / PR binding / ship claims)
        —— 此处已有 retryable?: boolean 通道(founder_projection_pending 等 → partial)
     2. inspectPr → trigger :cool: → inspectTriggeredWorkflow → merge 确认
     3. requestCleanup —— 一次性 graceful shutdown 广播(step receipt 防重发,30s grace)
     4. finalize = runResumablePostShipFinalization           [post-ship-finalization.ts:576]
        (0.9)  preArbitrate ← ← ← FLY-1751 死因所在
        (claim) PR manifest claim + orchestrator claim
        (1)    tmux cleanup        (1.25) phase finalize      (1.3) display refresh
        (1.7)  issueCloseout —— 每 pass 逐 node: re-read → FSM transition → closeRunner → confirm
               blocked → outcome partial, reason "issue_closeout_incomplete"
        (2)    notifier            (3) thread archive [closeout ok 才走]
        (3.5)  markIssueDone —— best-effort + 15s timeout + 双重 fresh-read fail-closed
               失败 → issueDone=false → partial "land_postconditions_incomplete:linear_done"
        (4)    trailing sweep
  → release(state: "partial" | "held")                        [land-executor.ts:235]
```

### 1.2 partial vs held 的生死差异

| | partial | held |
|---|---|---|
| operation | `listRunnableLandOperations` 捞回(`state IN ('intent','partial')`,StateStore.ts:38996) | **永久排除**;`executeLandOperation` 入口短路返回 |
| 重试者 | `landOperationTick` 30s sweep(plugin.ts:7264)+ dispatcher 对账 tick | **无任何重试器**(全库唯一 held→active 是 pane-loss rework 恢复,StateStore.ts:22119,与 land 无关) |
| run | 保持 active,land node 待重试 | `holdWorkflowLandNode` 翻 `workflow_run.status='held'`,engine 拒 dispatch(`engine_run_not_active`) |
| 告警 | `land_partial` alert(enqueueWorkflowEngineAlertTx) | `land_held` alert(同管道) |

### 1.3 四个缺陷(按因果排序)

- **缺陷 A(FLY-1751 直接死因)**:`post-ship-finalization.ts:611` 把 preArbitrate 的**一切**失败(含字面 `linear_lookup_failed_retryable`、含 `.catch` 包出来的 `arbitration_failed:*`)统一映射为 `outcome: "held"`。而 `plugin.ts:5260` 处 preArbitrate 的注释明确写着「a failed FRESH read is fail-closed BUT retryable — the next finalization attempt re-arbitrates from scratch」——**消费端的 held 映射保证了那个 next attempt 永远不来**。生产者意图(retryable)与消费者语义(terminal)脱节。
- **缺陷 B(结构)**:preArbitrate 在 (0.9) 位置挡住**全部**本地清理(收体/归档/worktree/run completed)。它的唯一职责是拒绝 canceled/founder-parked issue,而 durable floor(park tombstone + persisted `linear_state_observations`)已在 fresh read **之前**查过且干净 —— 一次外部 SaaS 只读失败不该把纯本地清理扣为人质。且 land 是 post-merge:不可逆动作(merge)已发生,剩下全是清理。
- **缺陷 C**:partial 重试无退避、无 attempt 预算、无收敛告警 —— 30s 裸重试,持续故障时永不放弃也永不 fail-loud。
- **缺陷 D**:Linear Done 写失败 → `land_postconditions_incomplete:linear_done` → run 永不完成。Linear 持续不可达时,清理级联的最后一环被一次外部**写**阻塞(与缺陷 B 同族,方向相反)。

### 1.4 可复用的既有模式(不重新发明)

| 模式 | 出处 | 用途 |
|---|---|---|
| durable 退避 1m/2m/4m/8m + 第 5 次转 needs_lead + severe | FLY-1648 / FLY-1612(`workflow_rework_delivery.hold_count`/`next_retry_at` 列形态) | 缺陷 C 的预算形态 |
| 健康恢复重置退避预算 | FLY-1648 R1 advisory | 预算记账规则 |
| `markLinearIssueDone` 的 `already_completed → done:true` + 双 fresh-read fail-closed 拒覆写 canceled | linear-issue-finalizer.ts:56 | 「Done 已由集成翻好」天然消解(Linear 可达时);Done 写自带守卫 |
| `linear_state_observations` 持久观察(monotonic guard) | StateStore.ts:14727,done-thread-reconcile 写入 | preArbitrate 降级的确证来源 |
| `enqueueWorkflowEngineAlertTx` + `workflowEngineAlertPayload` | StateStore land 事件族 | 耗尽转真 held 的 fail-loud 告警管道(已存在) |
| 零新 timer:挂现成 tick | FLY-1560(GatePoller riders)/ `landOperationTick` 30s | deferred Done 队列的执行载体 |
| 归档后 founder 发言重开受保护 | FLY-1709 archive-once | 降级放行安全论证的一环 |

## 2. 方案比较

### Option A:retryable 语义修复 + 有界退避 + Linear 依赖降级(推荐)

**核心思想**:held 语义保持「需要人的真终态」;一切 retryable 失败走既有 partial 重试通道,加 durable 退避预算;preArbitrate 与 linear_done 对 Linear 的依赖降级为「确证才拒、不可达不挡本地」。

三个内聚子改动:

1. **retryable 通道 + 映射修复(杀缺陷 A)**:preArbitrate 返回类型加 `retryable?: boolean`;`linear_lookup_failed_retryable` 与 thrown `arbitration_failed:*` 标 retryable;消费端 retryable refusal → `outcome: "partial"`(refusal 本就发生在 dedupe claim 之前,重跑安全 —— 这正是原注释设想的行为)。
2. **durable 退避预算(杀缺陷 C)**:land operation 增加故障类 reason 的 attempt 记账 + `next_attempt_at` 退避(镜像 FLY-1648 形态);`listRunnableLandOperations` 尊重 next_attempt_at;预算耗尽 → 真 held + fail-loud Lead alert(带 attempt 历史)。等待类 reason(`ship_workflow_pending`/`founder_projection_pending` = 正常等 CI/投影)不烧预算;pass 有前进(新 step receipt)重置预算。
3. **Linear 依赖降级(杀缺陷 B/D)**:
   - preArbitrate fresh read 失败时:先查 persisted observation —— `completed`(Done 已被集成翻好,FLY-1751 即此)= 非 canceled 的确证 → PASS;否则若 durable floor 干净(无 tombstone、无 canceled 观察)→ **降级 PASS**(标记 degraded,审计留痕),本地清理照走;有确证 cancel/park → 照旧拒绝(这不是 retryable,是真终态)。
   - linear_done postcondition 解耦:本地三项(closeout/worktree/thread)全部满足、仅 Done 写因 Linear 不可达类原因未达时 → operation 记 `linear_done_deferred` receipt → operation/run 正常 completed(级联闭合)→ Done 翻转进 durable 重试队列,挂现成 tick 慢周期重试(每次仍走 markLinearIssueDone 全守卫;`already_completed` 即消;持续失败有界告警)。canceled 拒绝不进队列(终态,记录即止)。

- **Pros**:修结构不加报警器(Annie 简单性三连);held 语义纯化;FLY-1751 场景(瞬时失败)第一次重试即自愈;持续不可达场景本地清理不受阻;每条交付逐一落地。
- **Cons**:改动面横跨 preArbitrate 契约、land operation schema(退避列)、finalization postcondition 逻辑 —— 三块都是 ship 关键路径,需完整回归 fixture;deferred Done 队列是新的小状态(尽量以 receipt/现成表承载,不建独立新表则复杂度可控)。
- **appetite**:M(1 个 issue 周期);**affected**:`post-ship-finalization.ts`、`land-executor.ts`、`plugin.ts`(preArbitrate)、`StateStore.ts`(land operation 退避列 + runnable 过滤 + deferred Done 账)、回归 fixture。

### Option B:给 held 建再生器(sweep 扫 held + retryable reason 复活)

- **核心思想**:保留现有 held 映射,新增巡检扫 `land_operation.state='held' AND last_error LIKE '%retryable%'`,复活为 partial。
- **Pros**:不动映射逻辑,增量最小。
- **Cons**:靠 reason 字符串模式匹配(记忆红线:近似检查≠那个属性);held 失去「需要人」终态语义,所有把 held 当终态的消费者(dispatcher 短路、告警语义、founder 心智)被污染;是「加报警器」不是「修结构」。**拒**。

### Option C:只修缺陷 A(retryable → partial),不做预算、不做降级

- **核心思想**:一行级映射修复。FLY-1751 场景(瞬时失败)确实自愈。
- **Pros**:最小刀。
- **Cons**:持续不可达时 30s 裸重试永不收敛也不告警(缺陷 C 全留);「Linear 完全不可达,本地清理照走」(issue 交付 2 明文)不满足;交付 3 的持续不可达 fixture 无法写。作为拆阶段的第一刀可以,但 issue 三条交付明确要求全套。**不足**。

### 推荐:Option A

issue 交付清单三条与 Option A 三个子改动一一对应;A2 降级放行的安全论证见 §3。

## 3. 关键安全论证 — 降级 PASS 为什么不危险

降级 PASS 放弃的唯一保护窗口 = 「founder 刚在 Linear 上 Cancel、observation 尚未落地、且 fresh read 恰好失败」。在这个窗口内本地清理照走的后果逐项检:

1. **merge 已发生**:land 是 post-merge 收尾,不可逆动作早已完成。preArbitrate 拦的从来不是 merge。
2. **收体 / worktree 清理**:canceled 处置(canceled-pr-close 家族)本来也要做同样的动作 —— 做了不亏。
3. **Linear Done 覆写**:唯一真正危险的外部写,由 `markLinearIssueDone` 自身的双重 fresh-read fail-closed 守卫独立把守(canceled → 永不覆写;不可达 → 不写、进队列;队列重试每次全守卫)。降级 PASS 不触碰这道守卫。
4. **thread archive**:FLY-1709 下 founder/human 发言重开受保护,bot-only 可重归档 —— 可恢复。

结论:降级放行的增量风险 ≈ 0,换来的是「本地清理永不被外部 SaaS 只读失败扣为人质」这一结构性保证。

## 4. 用户决策(headless 依据)

- issue 交付清单已 prescriptive(1 = 退避+cap+耗尽才真 held;2 = 降级 + 本地清理不等 Linear + Done 进重试队列;3 = 两个剧本的回归 fixture)→ 直接对应 Option A,无需向 Lead 开阻塞问。
- held 语义(真终态)与预算记账规则(等待类不烧预算、前进重置)为本探索的设计裁量,进 plan 后由 codex-design-review 把关。

## 5. 诚实边界

- **不做**:`:cool:` / merge 判定 / QA verdict / gate 逻辑的任何改动;FLY-1715 外部 merge 变体家族的其它成员;跨 issue 通用的「所有 held 重试框架」或通用 Linear 写队列 —— 只治 land 收尾这一族。
- **不改**:`markLinearIssueDone` 的守卫语义(只消费它)。

## 6. 下一步

- [ ] research.md:落细退避预算记账形态(列 vs receipt)、deferred Done 队列载体选型、runnable 过滤 SQL 变更、告警去重形态、全部触点清单
- [ ] plan.md → codex-design-review 循环至 APPROVED
