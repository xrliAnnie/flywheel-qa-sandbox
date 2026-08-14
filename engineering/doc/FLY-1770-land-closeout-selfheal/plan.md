# FLY-1770 land 收尾自愈:retryable 重试 + Linear 依赖降级 — 实施计划

Issue: FLY-1770 (https://linear.app/geoforge3d/issue/FLY-1770/机制-land-收尾-heldretryable无自愈closeout-撞-linear-瞬时失败-run-永久)
日期: 2026-08-14
基于: research.md

**Status**: codex-approved(4 轮 design review:R1 七项 → R2 四项 → R3 一项 → R4 APPROVED;变更摘要见 §7/§8/§9。R4 non-blocking 备注:helper 保持单一来源;timeout/迟到 branch 测试用 fake timers + 显式 microtask flush,防测试自身悬挂 handle)

## 0. 一句话

held 语义纯化为「需要人的真终态」:一切 retryable 失败走既有 partial 重试通道并加 **progress-epoch 绑定**的 durable 退避预算(耗尽才转真 held + fail-loud);preArbitrate 与 Linear Done 写对外部 SaaS 的依赖降级 —— 确证才拒、不可达不挡本地清理,Done 义务以三态 durable disposition 落账、deferred 队列由带 authority 重仲裁的慢扫消化。

## 1. 目标 / 非目标

**目标**(与 issue 交付一一对应):
1. `held` + retryable reason ⇒ 自动重试(1m/2m/4m/8m 退避、epoch 内单调计数 cap=5;耗尽才转真 held + fail-loud 告警 Lead)。
2. closeout 对 Linear 依赖降级:lookup 失败先查「Done 是否已由集成翻好」;Linear 完全不可达时本地清理(收体/归档/run completed)照走;Done 义务转为 durable 三态 disposition,deferred 走带 park/cancel 重仲裁的重试队列。
3. 回归 fixture:瞬时失败自愈全级联(provider 级真实重放);持续不可达本地照走 + Done 入队 + 告警;预算耗尽;crash-point 可重放。

**非目标**:不改 `:cool:`/merge 判定/QA verdict/gate 逻辑;不碰 FLY-1715 外部 merge 变体家族其它成员;不建跨 issue 通用 held 重试框架或通用 Linear 写队列;不改 `markLinearIssueDone` 守卫语义(只消费);**不加任何新 env flag**(FLY-1466 铁律);**legacy(非 land)finalization 路径字节兼容**(degraded-PASS 只对 resumable/land 生效,见刀 4)。

## 2. 改动清单(7 刀,依赖序)

### 刀 0 — 存量 held 行的显式裁定(R1#2)

**不做自动迁移、不做通用 held 复活器。** FLY-1751 的 held run 账已按 issue 原文「held run 账保留为证据」人工裁定保留;本改动只治**未来**进入 retryable 失败的 operation。实现时随 PR 附一段**只读 census**(SQL + 输出贴进 PR body):`SELECT operation_id, run_id, issue_id, state, last_error FROM land_operation WHERE state='held'`,逐行标注裁定(`evidence_keep` / `manually_closed` / `needs_lead`);若 census 发现除 FLY-1751 之外仍卡着 retryable-reason 的 held 行,报 Lead 人工裁定,**不写代码复活**。F5 哨兵(存量行为逐字不变)与交付 1 由此并存不矛盾:交付 1 的语义是「今后 retryable 失败不再落入 held」。

### 刀 1 — StateStore schema:land_operation 幂等新列

`packages/teamlead/src/StateStore.ts`(建表处 :16679 + 既有幂等 ADD COLUMN 迁移形态,FLY-267 同款):

```sql
retry_count             INTEGER NOT NULL DEFAULT 0  -- epoch 内单调 attempt 计数(fault+progress 合计)
retry_epoch_key         TEXT                        -- 进展指纹;变化 = 可证明的 durable progress → 计数归零
next_attempt_at         TEXT                        -- 退避闸;NULL = 随时 runnable(存量行为)
linear_done_disposition TEXT                        -- NULL | 'done' | 'canceled_refused' | 'deferred'
linear_done_deferred_at TEXT                        -- 入队时刻(disposition='deferred' 时非空)
linear_done_settled_at  TEXT                        -- 出列时刻(done / canceled_refused / 慢扫成功)
linear_done_last_reason TEXT                        -- 最近一次 markIssueDone 失败原因(≤200 字符截断)
```

存量行全 NULL/0 → 行为逐字不变(F5 哨兵)。新时间戳走 `workflowFiniteTimestamp` 校验。索引:对 runnable 查询与 deferred 慢扫查询各跑 EXPLAIN 实测;如需新索引用**新名字**建(`idx_land_operation_work` 系 `IF NOT EXISTS`,无法原地换定义,R1#7)。

### 刀 2 — reason 分类 + progress-epoch 退避记账(单写者)(R1#1/#7)

新纯函数模块 `packages/teamlead/src/bridge/land-retry-policy.ts`:

```ts
export type LandReasonClass = "waiting" | "retryable" | "terminal";
export function classifyLandReason(reason: string): LandReasonClass;
export const LAND_RETRY_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000] as const;
export const LAND_RETRY_CAP = 5;
export function nextLandRetry(input: {
  class: LandReasonClass;
  priorCount: number;
  priorEpochKey: string | undefined;
  currentEpochKey: string;   // 见下:进展指纹
  now: Date;
}):
  | { disposition: "partial"; retryCount: number; epochKey: string; nextAttemptAt?: string }
  | { disposition: "held_exhausted"; retryCount: number; epochKey: string };
```

**分类表(逐个枚举实际 producer,消灭「按类猜」)**:

| class | reason(producer 定位) | 语义 |
|---|---|---|
| waiting | `ship_workflow_pending`(land-executor:419)、`founder_projection_pending`(authorize :154)、`workflow_pr_manifest_partial:*`(post-ship-finalization:641,等声明的多 PR 合入)、**verdict waiting 三字面 exact-match**:`founder_review_missing` / `founder_review_not_passed` / `founder_review_stale_artifact`(真实 `FounderReviewVerdict` 非通过状态,`packages/flywheel-comm/src/founder-review.ts:72-97`;等 founder 动作,无 SLA)(R2#4) | 正常等待外部推进:**不记账不退避**,维持 30s sweep 现状(merge 靠它被及时发现);不清空既有预算字段(冻结,防洗账) |
| retryable | `linear_lookup_failed_retryable`、`arbitration_failed:*`(thrown)、`land_execution_error:*`、`issue_closeout_incomplete`、`land_postconditions_incomplete:*`、**structural 三字面 exact-match**:`founder_review_authority_unavailable` / `founder_review_artifact_binding_missing` / `founder_review_producer_ambiguous`(infra/结构未就绪但可能收敛)、`land_source_session_unavailable`、**其余 `founder_review_*` 与一切未知 reason(fail-closed 归此类:有界重试后 fail-loud,绝不静默永挂 —— 不用 wildcard 归 waiting,R2#4)** | epoch 内单调记账 + 退避 |
| terminal | `pr_head_mismatch`、`pr_closed_unmerged`、`ship_workflow_failed:*`、`cool_trigger_receipt_corrupt`、`land_step_receipt_conflict`、authorize 的非 retryable 拒绝、确证 canceled/parked 拒绝 | 直接 held(现状不变,不经 nextLandRetry) |

实现时以 grep 全量核对三个 producer(land-executor authorize/主体、post-ship-finalization、preArbitrate)的 reason 字面,表有遗漏以「未知归 retryable」兜底。

**预算规则(反震荡,R1#1)**:`retry_count` 是 **epoch 内所有 retryable reason 的合计单调计数** —— reason 文本变化**不**归零。归零唯一条件 = `retry_epoch_key` 变化,而 epoch key = **可证明的 durable progress 指纹**:`{land_operation_step 行数}:{最新 step 名}`。新 step receipt 落账(cool_triggered→merge_confirmed→cleanup_requested→…)才算前进;reason 在 `issue_closeout_incomplete` ↔ `land_execution_error` 间震荡而 step 无前进 → 计数持续累加 → 第 5 次 `held_exhausted`。对抗测试:任意无进展 reason 交替序列必在 5 次内停手。

**记账写点 = 一个 StateStore 原子方法(R2#1)**:现状 `land-executor.ts release()` 在 StateStore 事务之外调用 store,「同事务读指纹」与「executor 预计算传参」不能同时成立 —— 收敛为新方法 `releaseLandOperationWithRetryAccounting({operationId, ownerId, generation, class, reason, now})`:在**同一 `db.transaction` 内**验证 running/owner/generation → 读 operation 行 + step 指纹 → 调纯函数 `nextLandRetry` → 执行 disposition CAS → 返回终局 `{state, retryCount, epochKey, nextAttemptAt, lastError}`。executor 只消费结果,不在事务外预计算;waiting/terminal 走该方法内的字段冻结分支(waiting:预算三字段不动、`next_attempt_at` 置 NULL;held:全字段冻结 forensic)。现有 `setLandOperationDisposition` 签名保持字节兼容(legacy/测试调用不动)。StateStore 级测试:指纹读取、cap 决策、release 同一提交单元(注入并发扰动验证 CAS)。`held_exhausted` → 写 held 且 `last_error` 前缀 `retry_exhausted:`(原 reason 截断编码,合计 ≤500 字符,兼容 holdWorkflowLandNode 的 500 上限,R1#7)。

### 刀 3 — 退避闸设在 claim 层(防 dispatcher 击穿)(R1#7 SQL 修正)

- `listRunnableLandOperations`(StateStore.ts:38996)完整括号化谓词(现状 `A OR B` 无外层括号,直接 `AND` 会只约束 B 分支):

```sql
WHERE (
        (state IN ('intent','partial') AND (next_attempt_at IS NULL OR next_attempt_at <= :now))
     OR (state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= :now))
      )
```

- `claimLandOperation`(StateStore.ts:39044):预读判定与最终 CAS UPDATE 使用**同一** due 条件(partial 行 `next_attempt_at IS NULL OR next_attempt_at <= :now`);未到点 → claim 失败 → executor 返回 `busy`(dispatcher 现状:intent 留待下 tick)。

### 刀 4 — preArbitrate 降级 + 消费端映射修复(杀 FLY-1751 死因;degraded 只对 land 生效)(R1#4/#5/#6)

**契约**(post-ship-finalization.ts:360 类型 + plugin.ts:5219 唯一 provider):

```ts
preArbitrate?: (issueId, projectName, alreadyLocked?) => Promise<
  | { ok: true; degraded?: "linear_unreachable" }
  | { ok: false; reason: string; retryable?: boolean }>;
```

**provider(plugin.ts:5241-5262)**:
- fresh SDK read 包 **固定 10s timeout**(`Promise.race`,常量,不可配)—— SaaS 悬挂(不 reject 只 hang)同样进入降级分支,本地清理不被挂死(R1#4)。
- timeout/reject 分支按序:① `getLinearStateObservation(...)?.lastStateType === "completed"` → `{ok:true}`(Done 已被集成翻好 = 非 canceled 确证;FLY-1751 即此);② durable floor 干净(park tombstone 与 canceled observation 在 fresh read 前已查)→ `{ok:true, degraded:"linear_unreachable"}`;③ 确证 cancel/park 分支不变(不带 retryable 的拒绝)。

**consumer(post-ship-finalization.ts:589-616)**:
- `.catch` 包装 `arbitration_failed:*` → `retryable: true`(refusal 在 dedupe claim 之前,重跑安全 —— plugin.ts:5257 原注释设想的行为)。
- `!arb.ok && arb.retryable`:`resumable`(land)→ `outcome:"partial"`(reason 透传,归 retryable class);**非 resumable(legacy)→ 维持现状 `outcome:"held"` 短路零 mutation**(report 本被丢弃,字节兼容)。
- `arb.ok && arb.degraded`:**仅 `resumable` 时**继续执行 + 幂等审计事件 `post_ship_arbitration_degraded`;**非 resumable(legacy:DirectEventSink.ts:1186 与 event-route.ts:2245/2716 两处 spread lifecycleInfra 的 caller)→ 视同 refusal 短路零 mutation,行为逐字不变**(R1#6;`merge-ship-gate.ts:575` 与 `external-merge-reconcile.ts:463` 本就不传 preArbitrate,零影响 —— 实现时以现场 grep 复核此事实)。

### 刀 5 — Linear Done 义务三态化:durable disposition 替代 postcondition(R1#3)

**原则**:run completion 不再要求「Linear 已 Done」,但**必须**要求弱化条件 —— `linear_done_disposition ∈ {done, canceled_refused, deferred}` 已 durable 落账。报告不说谎:`details.issueDone` 只在真 Done 时为 true,新增 `details.linearDoneDisposition` 如实上报。

**Linear 写的 aborting deadline race(R2#2 + R3#1,主路径与慢扫共用一个 helper)**:两条性质必须同时成立 —— (a) **有界返回**:Linear SDK 的 `rawRequest` 不接受 AbortSignal(仓内 `linear-query.ts:115-129` 已记录),`client.issue()`/`team.states()` 一旦 pending 就永不 settle 时,光 abort 标记救不了正卡着的 await;(b) **零迟到写**:timer 赢了之后底层 finalizer 照跑,mutex 已释放、founder 随后 park,第 16 秒迟到的 `updateIssue` 就是越权写。合同:共享 helper `raceMarkIssueDoneWithAbort(finalizer, 15_000)` —— 启动 `finalizer(signal)`;15s 分支**先 `controller.abort()` 再让 `Promise.race` 以 `{done:false, reason:"mark_issue_done_timeout"}` 有界返回**(rider latch 必然释放);被遗留的 finalizer branch 接住迟到 rejection(不得成为 unhandled);finalizer 内**每次 client 调用(issue 读、team/states 读、`updateIssue`)前检查 `signal.aborted`,已 abort → 立即抛、零新 dispatch** —— 该 branch 日后恢复也永远到不了 update;底层 transport 将来能消费 signal 时再作 best-effort 真取消。清理 timer,无新 flag。**不变量:timeout 之后零新 mutation dispatch + caller 有界返回**;已在 wire 上的请求系 abort 前、于 mutex 内合法仲裁下发出,其迟到完成与今日主路径语义相同(founder 中途 cancel 的固有 race,`markLinearIssueDone` 的双 fresh-read 已尽力收窄),诚实记为已知边界。read-only 的 preArbitrate 10s race 无外部副作用,保留 bare race。测试分开钉两条性质(主路径、慢扫各一组):(a) 正在 await 的 client call 永不 settle → 15s 后 caller 返回、rider latch 释放;(b) client call 在 timeout 后恢复、尚未到 update → pre-dispatch check 使 `updateIssue` 永远零调用(含 timeout 后插入 founder park 的变体)。

**post-ship-finalization.ts 步骤 (3.5)** 结果分类 → disposition:

| markIssueDone 结果 | disposition | run 阻塞? |
|---|---|---|
| `done:true`(含 `already_completed`) | `done`(settled_at 同写) | 否 |
| `issue_canceled_never_overwritten` | `canceled_refused`(settled_at 同写;founder Cancel 权威,不入队不告警) | 否 |
| 不可达类 / timeout / thrown / 解析类(无 completed-type state 等) | `deferred`(deferred_at + last_reason 同写;解析类同样入队 —— 重试无害,由告警引人来看) | 否 |
| **disposition 落账本身失败** | — | **是:返回 partial**(义务未 durable,不得完成 run) |

**绑定与围栏**:land 路径的 finalize 闭包(plugin.ts:5703)已握有精确 `operation` 行 —— disposition 写入以**闭包捕获的 `operation_id`** 定位,新 store 方法 `recordLandLinearDoneDisposition({operationId, ownerId, generation, disposition, reason, now})` 带 **owner+generation fence**(running 阶段单写者;fence 失败 → 返回 partial)。**绝不用 `getLatestLandOperationForIssue` 按 issue 猜行**。legacy 路径(无 operation)→ 完全不触新方法,postcondition 行为字节兼容(legacy 本无 postcondition 循环)。

**deferred 与告警同事务**:disposition='deferred' 的写入与 informational alert 的 `enqueueWorkflowEngineAlertTx` 在**同一事务**提交(队列已写而告警丢失 / 反向重复皆不可能);alert 只在**首次进入 deferred** 时以稳定 operation-scoped UID 入队(后续 `linear_done_last_reason` 变化不再入队 —— 同 UID 不同 payload 会撞既有 outbox 的 UID conflict,R2#3)。

**disposition 状态机(精确 CAS,R2#3)**:首次 defer 写 `linear_done_deferred_at = COALESCE(linear_done_deferred_at, :now)`(episode 起点不被覆盖);慢扫成功 = `deferred → done` CAS + settled_at 同写;park/cancel = `deferred → canceled_refused` CAS + settled_at 同写;全部 CAS 带 `WHERE linear_done_disposition='deferred' AND linear_done_settled_at IS NULL`,重放幂等。

**completion 不变量下沉到 StateStore(R2#3)**:`recordLandOperationStep('finalization_completed')` 的 fenced transition(StateStore.ts:39170-39189 现无条件把 operation 转 completed)硬性要求 `linear_done_disposition ∈ {done, canceled_refused, deferred}`,否则拒绝 —— 备用/注入 `finalize()` 误回 `{complete:true}`、未来 caller 漂移都无法绕过义务落账;部署前已 completed 的 NULL disposition 行仅保留 idempotent read/replay 兼容。StateStore 负例测试:NULL disposition 不能记录新的 `finalization_completed`。

**慢扫(T9,plugin.ts:7267 landOperationTick 内追加段,独立 15min 节流常量,零新 timer)**:
- 取 `state='completed' AND linear_done_disposition='deferred' AND linear_done_settled_at IS NULL` 的**有界 batch(≤10)**。
- **逐行在 canonical issue mutex 内重跑 arbitration**(park tombstone + canceled observation + fresh read 带同款 10s timeout)—— run 完成后 founder 再 park/cancel 的,慢扫**必须**尊重(R1#4:`markLinearIssueDone` 只认 Linear 的 canceled,不认 `issue_disposition_intents`,故 authority 重仲裁不可省):park/cancel 确证 → disposition 改 `canceled_refused` + settled(零 Linear write)。
- 仲裁过 → 经共享 `raceMarkIssueDoneWithAbort`(15s,见上)调 finalizer —— 有界返回保证 `landOperationSweepRunning` 不被 never-resolving Promise 拖垮,pre-dispatch 门保证 timeout 后零新 mutation。
- settled 写入按上文 disposition 状态机 CAS,重放幂等。单行 timeout/异常隔离并留队,不阻塞整批。
- 未 settled 满 24h → 提醒 alert(episode uid 带 day bucket 去重)。

### 刀 6 — 耗尽转 held 的 fail-loud 告警

`holdWorkflowLandNode` 既有 alert 管道(→ `enqueueWorkflowEngineAlertTx` → routedAlertSink,FLY-1764)不动;`retry_exhausted:` 前缀的 hold,alert payload 附 `{attempts: retry_count, epochKey: retry_epoch_key}`(从 operation 行读;**不承诺 firstFailureAt** —— 无列支撑,R1#7)。无新告警面。

## 3. TDD 顺序(RED → GREEN)

1. **刀 2 纯函数**:`land-retry-policy.test.ts` —— 分类表逐 reason;退避序列 1m/2m/4m/8m;**对抗测试:reason 震荡(closeout_incomplete ↔ land_execution_error 交替、step 无前进)5 次内 `held_exhausted`**;epoch key 变化(新 step receipt)归零;未知 reason 归 retryable;waiting 不记账。
2. **刀 1+3 StateStore**:`StateStore.land-lifecycle.test.ts` 增:新列迁移幂等(建两次);NULL 列行 runnable 语义逐字不变(F5);括号化谓词下 partial 未到点不被捞/不可 claim,`running` 过期 lease 分支不受 `next_attempt_at` 影响;到点可 claim;claim 预读与 UPDATE 同条件。
3. **F1(FLY-1751 真实重放,provider 级,R1#5)**:
   - F1a:provider fresh read reject + observation=`completed` → 同 pass PASS → 本地级联全走(closeout→thread archive→run completed,Done 经 `already_completed` settled)。
   - F1b:provider fresh read reject + 无 observation → degraded PASS(审计事件在)→ 同 pass 本地级联全走;markIssueDone 同 fail → disposition=`deferred`;注入恢复 → 慢扫 settled。
   - F1c:provider fresh read **悬挂(never-resolving)** → 10s timeout → 走 F1b 路径(本地清理不被挂死)。
4. **F2(consumer thrown → 退避恢复)**:preArbitrate thrown(`arbitration_failed:*`)一次 → operation `partial` + `retry_count=1` + `next_attempt_at≈+1m`(**断言非 held、run 仍 active**);推时钟 → 重试 → 级联全走。
5. **F3(耗尽)**:arbitration 持续 thrown ×5 → 退避时间戳序列断言 → 第 5 次 operation `held`(`retry_exhausted:` 前缀)+ run `held` + alert payload 含 `{attempts, epochKey}`。
6. **F4(守卫)**:canceled observation / park tombstone → 拒绝不降级;markIssueDone 撞 canceled → `canceled_refused` 且零 Done 写;**defer 后 founder park → 慢扫重仲裁 → `canceled_refused`、零 Linear write**;慢扫 finalizer 悬挂 → 15s abort、单行隔离、rider 不卡死;**迟到写两例(R2#2):延迟到 timeout 后才推进到 update 的 client + timeout 后插 founder park → 断言 `updateIssue` 零调用(主路径、慢扫各一)**;reason 分类六个 `founder_review_*` 字面 + 一个未来未知字面逐一断言(R2#4)。
7. **F5(crash-point + 哨兵)**:disposition 落账失败 → 返回 partial、run 未完成;deferred 已写但 run completion 未写 → 重放收敛;settled 重放幂等;**StateStore 负例:NULL disposition 不能记录新的 `finalization_completed`(R2#3);retry 记账原子性(指纹读取+cap 决策+release 同一提交单元,R2#1)**;既有 post-ship-finalization.test.ts(30)/StateStore.land-lifecycle(18)/dispatcher land 段全绿 + legacy 路径(DirectEventSink/event-route)对 degraded/retryable 维持零 mutation 短路(字节兼容断言)。

全仓门:`pnpm lint` + `pnpm -r build` + 定向 vitest(host 全量套件不当验收门 —— 记忆红线)。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 降级 PASS 撞「刚 Cancel + observation 未落 + read 恰失败」窗口 | exploration §3 论证:merge 已发生;收体/归档为 canceled 处置同款动作;Done 写有独立双 fresh-read 守卫 + 慢扫 authority 重仲裁;归档 FLY-1709 可重开。增量风险 ≈ 0 |
| class 震荡刷预算 | 已根治:epoch 内合计单调计数,归零仅凭 durable step 前进指纹(R1#1);对抗测试钉死 |
| 退避闸拖慢正常 CI 等待 | waiting class 零记账零退避,`ship_workflow_pending`/`workflow_pr_manifest_partial:*` 维持 30s 现状 |
| deferred 义务丢失 / 虚报 | 三态 disposition 是 run completion 的 durable 弱化条件;落账失败 → partial;deferred+alert 同事务;报告新增 linearDoneDisposition 如实上报(R1#3) |
| 慢扫越权 / 卡死 | 逐行 canonical issue mutex + park/cancel 重仲裁;10s/15s 固定 timeout;有界 batch;单行隔离(R1#4) |
| legacy caller 行为漂移 | degraded/retryable 语义仅 `resumable` 生效;legacy 两处(DES/event-route)零 mutation 短路逐字保留 + 回归断言;merge-ship-gate/external-merge-reconcile 不传 preArbitrate,实现时 grep 复核(R1#6) |
| 存量 held 行 | 刀 0 显式裁定:census + 不迁移;超预期发现 → 报 Lead(R1#2) |
| `thread_archive` postcondition 耗尽转 held 是行为收紧 | 附带修复,明示;比静默永挂诚实 —— review 把关 |

## 5. 验收(独立 QA 可执行)

1. F1-F5 全绿 + 全仓门绿。
2. 真机(529 房或隔离 Bridge):注入 Linear 读失败一次 → 同 pass 本地级联完成(operation completed、run completed、thread 归档、体收干净);`land_held` 一条不发。
3. 真机持续断 Linear:本地级联完成,`linear_done_disposition='deferred'` 有账 + informational alert 恰一条;恢复后 ≤15min 翻 Done 并 settled。
4. 真机 defer 后 founder park:慢扫零 Linear write,disposition 转 `canceled_refused`。

## 6. 交付物

- 代码 + 测试(刀 0-6 + F1-F5)。
- 刀 0 census 输出贴 PR body。
- 本 doc 文件夹三件套随分支合入 main;CLAUDE.md 里程碑行 + doc 归档 = PR 最后一 commit(`feedback_archive_docs_in_main_pr`)。

## 7. Round 1 → Round 2 变更摘要

1. R1#1 预算防震荡:reason-class 归零 → **progress-epoch(step receipt 指纹)归零 + epoch 内合计单调计数**;分类表逐 producer 枚举,`workflow_pr_manifest_partial:*`/founder-review 各 reason 显式归位;新增对抗测试。
2. R1#2 存量 held:新增刀 0 —— census + 显式「不迁移」裁定(FLY-1751 held 账按 issue 原文保留为证据),不做通用复活器。
3. R1#3 deferred Done 升格:新增 `linear_done_disposition` 三态列,run completion 以 durable disposition 为弱化条件;落账失败 → partial;精确 operation_id + owner/generation fence 绑定(弃 getLatestLandOperationForIssue);deferred+alert 同事务;报告不虚报 issueDone。
4. R1#4 authority + timeout:慢扫逐行 issue mutex + park/cancel 重仲裁;preArbitrate fresh read 10s timeout;慢扫 finalizer 15s timeout + 单行隔离。
5. R1#5 fixture 重构:F1 拆 provider 级 F1a/F1b/F1c(FLY-1751 真实重放 = 同 pass 自愈,非 partial 重试);consumer thrown 独立为 F2;新增 crash-point 族。
6. R1#6 legacy 收界:degraded/retryable 新语义仅 resumable 生效;legacy 两处字节兼容 + 回归断言;merge-ship-gate/external-merge-reconcile 事实修正。
7. R1#7 合同精化:括号化 SQL 谓词;claim 预读=UPDATE 条件;waiting/terminal 字段冻结语义;`retry_exhausted:` ≤500 编码;弃 firstFailureAt;EXPLAIN 定索引、新索引新名。

## 8. Round 2 → Round 3 变更摘要

1. R2#1 retry 记账事务边界:弃「executor 预计算 + 传参」,收敛为 StateStore 原子方法 `releaseLandOperationWithRetryAccounting`(同一 db.transaction 内:fence 验证 → 读指纹 → nextLandRetry → CAS → 返回终局);`setLandOperationDisposition` 签名字节兼容;补原子性测试。
2. R2#2 迟到写越权:`makeLinearDoneFinalizer` 接受 AbortSignal,每次 client 调用前置 aborted 检查(**timeout 后零新 mutation dispatch** 不变量);主路径与慢扫改 AbortController + 定时 abort;已在 wire 上的请求 = mutex 内合法仲裁时发出,迟到完成与今日主路径 race 同语义,诚实记为已知边界;F4 增迟到写两例。preArbitrate 只读 10s race 保留。
3. R2#3 completion 不变量下沉:`recordLandOperationStep('finalization_completed')` 硬性要求 disposition 三态已落账(NULL 拒绝;存量 completed 行仅 idempotent replay 兼容);disposition 状态机精确 CAS(首次 defer COALESCE 保 episode 起点;deferred→done / deferred→canceled_refused 两条单向边);首次 deferred 才入 alert(稳定 operation-scoped UID,防 outbox UID conflict);StateStore 负例测试。
4. R2#4 founder-review 枚举闭合:waiting = exact-match `founder_review_missing`/`not_passed`/`stale_artifact`(真实 verdict 状态,flywheel-comm/founder-review.ts:72-97);structural 三字面 exact-match 归 retryable;其余 `founder_review_*` 与未知一律 retryable(不用 wildcard);六字面 + 未知字面全测。

## 9. Round 3 → Round 4 变更摘要

1. R3#1 timeout 合同补全:AbortController 单独不能让不吃 signal 的 Linear SDK promise 有界返回(`linear-query.ts:115-129` 已记录 rawRequest 无 AbortSignal)→ 改为共享 **aborting deadline race** helper:15s 分支先 abort 再 race 有界返回 `mark_issue_done_timeout`(rider latch 必然释放);遗留 branch 接住迟到 rejection;pre-dispatch abort check 继续保证恢复后零新 `updateIssue` dispatch;transport 支持 signal 时再作 best-effort 真取消。测试拆两条性质分别钉死(never-settle → 有界返回;timeout 后恢复 → 零 update)。
