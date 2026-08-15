# FLY-1770 land 收尾自愈:retryable 重试 + Linear 依赖降级 — 实施计划

Issue: FLY-1770 (https://linear.app/geoforge3d/issue/FLY-1770/机制-land-收尾-heldretryable无自愈closeout-撞-linear-瞬时失败-run-永久)
日期: 2026-08-14
基于: research.md

**Status**: 原稿 codex-approved(4 轮 design review 对旧 blob `5adde5bb`:R1 七项 → R2 四项 → R3 一项 → R4 APPROVED;变更摘要见 §7/§8/§9。R4 non-blocking 备注:helper 保持单一来源;timeout/迟到 branch 测试用 fake timers + 显式 microtask flush,防测试自身悬挂 handle)。**重派确认复审**(2026-08-14,HEAD `15a4ef70a`,Bridge fail-closed design gate):确认轮 R5 三项 + R6 三项全部折入(刀 7 / §10);当前修订版的终局 verdict 以本 exec 的 Bridge design gate 回执(`.flywheel/runs/<exec>/codex/design-review.json`)为准,不在本行自证。

## 0. 一句话

held 语义纯化为「需要人的真终态」:一切 retryable 失败走既有 partial 重试通道并加 **progress-epoch 绑定**的 durable 退避预算(耗尽才转真 held + fail-loud);preArbitrate 与 Linear Done 写对外部 SaaS 的依赖降级 —— 确证才拒、不可达不挡本地清理,Done 义务以三态 durable disposition 落账、deferred 队列由带 authority 重仲裁的慢扫消化。

## 1. 目标 / 非目标

**目标**(与 issue 交付一一对应):
1. `held` + retryable reason ⇒ 自动重试(1m/2m/4m/8m/15m/30m/60m/120m 退避、epoch 内单调计数 cap=9;耗尽才转真 held + fail-loud 告警 Lead)。
2. closeout 对 Linear 依赖降级:lookup 失败先查「Done 是否已由集成翻好」;Linear 完全不可达时本地清理(收体/归档/run completed)照走;Done 义务转为 durable 三态 disposition,deferred 走带 park/cancel 重仲裁的重试队列。
3. 回归 fixture:瞬时失败自愈全级联(provider 级真实重放);持续不可达本地照走 + Done 入队 + 告警;预算耗尽;crash-point 可重放。

**非目标**:不改 `:cool:`/merge 判定/QA verdict/gate 逻辑;不碰 FLY-1715 外部 merge 变体家族其它成员;不建跨 issue 通用 held 重试框架或通用 Linear 写队列;不改 `markLinearIssueDone` 守卫语义(只消费);**不加任何新 env flag**(FLY-1466 铁律);**legacy(非 land)finalization 路径字节兼容**(degraded-PASS 只对 resumable/land 生效,见刀 4)。

## 2. 改动清单(8 刀,依赖序)

### 刀 0 — 存量 held 行的显式裁定(R1#2)

**不做自动迁移、不做通用 held 复活器。** FLY-1751 的 held run 账已按 issue 原文「held run 账保留为证据」人工裁定保留;本改动只治**未来**进入 retryable 失败的 operation。实现时随 PR 附一段**只读 census**(SQL + 输出贴进 PR body):`SELECT operation_id, run_id, issue_id, state, last_error FROM land_operation WHERE state='held'`,逐行标注裁定(`evidence_keep` / `manually_closed` / `needs_lead`);若 census 发现除 FLY-1751 之外仍卡着 retryable-reason 的 held 行,报 Lead 人工裁定,**不写代码复活**。F5 哨兵(存量行为逐字不变)与交付 1 由此并存不矛盾:交付 1 的语义是「今后 retryable 失败不再落入 held」。

### 刀 1 — StateStore schema:land_operation 幂等新列

`packages/teamlead/src/StateStore.ts`(建表处 :16679 + 既有幂等 ADD COLUMN 迁移形态,FLY-267 同款):

```sql
retry_count                 INTEGER NOT NULL DEFAULT 0  -- epoch 内单调 attempt 计数(fault+progress 合计)
retry_epoch_key             TEXT                        -- 进展指纹;变化 = 可证明的 durable progress → 计数归零
next_attempt_at             TEXT                        -- 退避闸;NULL = 随时 runnable(存量行为)
linear_done_disposition     TEXT                        -- NULL | 'done' | 'canceled_refused' | 'deferred'
linear_done_deferred_at     TEXT                        -- 入队时刻(disposition='deferred' 时非空)
linear_done_settled_at      TEXT                        -- 出列时刻(done / canceled_refused / 慢扫成功)
linear_done_last_reason     TEXT                        -- 最近一次 markIssueDone 失败原因(经刀 7 归一化,≤200 字符)
linear_done_retry_count     INTEGER NOT NULL DEFAULT 0  -- deferred 慢扫轮转计数(code review R1 收口)
linear_done_next_attempt_at TEXT                        -- deferred 慢扫退避闸(15m/30m/1h/2h/4h/8h/24h)
linear_done_last_attempt_at TEXT                        -- deferred 慢扫最近尝试时刻
```

(共 10 列为最终规范;后三列由 code review R1 收口补入,此处折回刀 1 作唯一合同 —— R5#2。)

存量行全 NULL/0 → 行为逐字不变(F5 哨兵)。新时间戳走 `workflowFiniteTimestamp` 校验。索引:对 runnable 查询与 deferred 慢扫查询各跑 EXPLAIN 实测;如需新索引用**新名字**建(`idx_land_operation_work` 系 `IF NOT EXISTS`,无法原地换定义,R1#7)。

### 刀 2 — reason 分类 + progress-epoch 退避记账(单写者)(R1#1/#7)

新纯函数模块 `packages/teamlead/src/bridge/land-retry-policy.ts`:

```ts
export type LandRetryClassification = "waiting" | "retryable" | "terminal";
export function classifyLandRetryReason(reason: string): LandRetryClassification;
// 8 档退避(code review R1 加宽窗口后的最终合同;约 4 小时恢复窗):
const RETRY_DELAYS_MS = [60_000, 120_000, 240_000, 480_000,
                         900_000, 1_800_000, 3_600_000, 7_200_000] as const;
// 耗尽规则:同 epoch 内 retryCount 超过 8(= 第 9 次)→ state:"held",
// lastError 前缀 `retry_exhausted:` + 原 reason 截断编码(合计 ≤500 字符)。
export function nextLandRetry(input: {
  classification: LandRetryClassification;
  reason: string;
  now: string;               // ISO 时间戳
  epochKey: string;          // 见下:进展指纹
  priorRetryCount: number;
  priorRetryEpochKey: string | null;
}): {
  state: "partial" | "held";
  retryCount: number;
  retryEpochKey: string | null;
  nextAttemptAt: string | null;   // waiting/terminal/耗尽 = null
  lastError: string;
};
```

(以上为最终合同 —— 早稿的四档 backoff / `LAND_RETRY_CAP = 5` 草图已被 code review R1 的加宽裁定取代,R5#2 折回本刀,消除自相矛盾。)

**分类表(逐个枚举实际 producer,消灭「按类猜」)**:

| class | reason(producer 定位) | 语义 |
|---|---|---|
| waiting | `ship_workflow_pending`(land-executor:419)、`founder_projection_pending`(authorize :154)、`workflow_pr_manifest_partial:*`(post-ship-finalization:641,等声明的多 PR 合入)、**verdict waiting 三字面 exact-match**:`founder_review_missing` / `founder_review_not_passed` / `founder_review_stale_artifact`(真实 `FounderReviewVerdict` 非通过状态,`packages/flywheel-comm/src/founder-review.ts:72-97`;等 founder 动作,无 SLA)(R2#4) | 正常等待外部推进:**不记账不退避**,维持 30s sweep 现状(merge 靠它被及时发现);不清空既有预算字段(冻结,防洗账) |
| retryable | `linear_lookup_failed_retryable`、`arbitration_failed:*`(thrown)、`land_execution_error:*`、`issue_closeout_incomplete`、`land_postconditions_incomplete:*`、**structural 三字面 exact-match**:`founder_review_authority_unavailable` / `founder_review_artifact_binding_missing` / `founder_review_producer_ambiguous`(infra/结构未就绪但可能收敛)、`land_source_session_unavailable`、**其余 `founder_review_*` 与一切未知 reason(fail-closed 归此类:有界重试后 fail-loud,绝不静默永挂 —— 不用 wildcard 归 waiting,R2#4)** | epoch 内单调记账 + 退避 |
| terminal | `pr_head_mismatch`、`pr_closed_unmerged`、`ship_workflow_failed:*`、`cool_trigger_receipt_corrupt`、`land_step_receipt_conflict`、authorize 的非 retryable 拒绝、确证 canceled/parked 拒绝 | 直接 held(现状不变,不经 nextLandRetry) |

实现时以 grep 全量核对三个 producer(land-executor authorize/主体、post-ship-finalization、preArbitrate)的 reason 字面,表有遗漏以「未知归 retryable」兜底。

**预算规则(反震荡,R1#1;code review R1 加宽窗口)**:`retry_count` 是 **epoch 内所有 retryable reason 的合计单调计数** —— reason 文本变化**不**归零。归零唯一条件 = `retry_epoch_key` 变化,而 epoch key = **可证明的 durable progress 指纹**:`{land_operation_step 行数}:{最新 step 名}`。新 step receipt 落账(cool_triggered→merge_confirmed→cleanup_requested→…)才算前进;reason 在 `issue_closeout_incomplete` ↔ `land_execution_error` 间震荡而 step 无前进 → 计数持续累加。实现退避为 1m/2m/4m/8m/15m/30m/60m/120m,第 9 次才 `held_exhausted`;约 4 小时的恢复窗避免 Discord/worktree/Linear 等外部依赖在 15 分钟抖动后过早转人工。对抗测试:任意无进展 reason 交替序列必在有界 9 次内停手。

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

### 刀 7 — durable reason 归一化 + 慢扫轮转对全失败模式成立(R5#1;重派确认轮新增)

**问题(重派确认 review 在当前分支实证)**:`markIssueDone` 家族原样返回 `(err as Error).message`,主路径与慢扫把它未截断地传入 StateStore;而 `recordLandLinearDoneDisposition` / `deferLandLinearDoneRetry` 对 `reason.length > 500` fail-closed 拒绝(`invalid_land_linear_done_*`)。超长 SaaS 错误(长 HTML 错误页等)→ disposition 落账失败 → 主路径按刀 5 表返回 partial → 持续烧 retry 预算 → 最终 held —— 在这一窄边界上复活了本 issue 要杀的 bug 类,直接违反目标 2。慢扫侧同因:defer 写被拒 → 单行隔离 catch 只打日志、不推进 `linear_done_next_attempt_at` → 该行每轮重新占住固定 batch(≤10)队头,R1 收口「失败后让出队头」的轮转承诺在 reason 校验拒绝这一失败模式下不成立,且到不了 24h aged alert。

**合同**:
1. 新共享纯函数 `normalizeLandLinearDoneReason(reason: unknown): string`(落 `land-retry-policy.ts`,与既有 `exhaustedReason` 同居):非字符串/空串/纯空白 → `"unknown"`(空白视为 empty,R6#3);确定性截断至 **≤200 字符**(刀 1 既定上限,保留稳定前缀;同输入输出字节一致);输出恒满足 StateStore 的 ≤500 门(留余量)。
2. **一切** `linear_done_*` 写边界统一先归一化再入库:主路径步骤 (3.5) → `recordLandLinearDoneDisposition`;慢扫 defer → `deferLandLinearDoneRetry`;settle 路径同。StateStore 的 >500 fail-closed 门**保留**作纵深(callers 归一化后永不因长度触发)。
3. 慢扫 per-candidate **闭合状态机**(R6#1;「泛化 outer catch 推进」不闭合 —— Store `{ok:false}` 正常拒绝不抛异常、alert 抛错会造成双推进):
   - **全部出口分类**:settle / defer / disposition 的 Store `{ok:false}` 返回与 thrown 异常一律进入同一 fallback 处置,不允许「fail-closed 返回 → 直接 return → 行留在队头且无告警」。
   - **fallback reschedule 前先重读精确 operation 行**:已 settled / 不再 deferred → 幂等结束(零写);仍 `completed + deferred + unsettled` → 才 fallback 推进 `linear_done_next_attempt_at`(按其轮转档位)。
   - **单次 attempt 至多推进一次**:fallback 推进以 expected `linear_done_retry_count` 作 CAS token(等价条件更新)—— 覆盖「Store 提交成功但 caller 见到异常」的歧义,`linear_done_retry_count` 恰增一次,不跳退避档。
   - **aged alert 独立隔离**:24h aged 检查放在错误隔离的 post-outcome 阶段(不与 schedule 写耦合),执行前重确认仍 deferred;alert 失败仅日志,**不得**触发第二次 schedule;candidate 每次被 reschedule 也必须仍能到达 aged 检查(不被前段失败短路)。
   - **保证边界(诚实)**:以上为 best-effort —— 持久化层完全不可写时 fallback 推进同样失败,仅日志;该模式下行会重占队头,由 landOperationTick 15min 节流限频,不在本刀承诺内。
4. 回归(F4 增):(a) 主路径 markIssueDone 拒绝且 reason >500 字符 → run 照常完成、disposition=`deferred`、`linear_done_last_reason` 为归一化后缀本;(b) 慢扫撞 >500 字符 reason → 该行让位轮转、不占队头、24h aged alert 仍可达;(c) arbitration reject 超长 reason 变体同断言;(d) **settle `{ok:false}`** → 行不占队头(fallback 轮转)且幂等重放安全;(e) **defer 返回失败/抛错** → 轮转 + aged alert 可达;(f) **defer 成功后 alert 抛错** → `linear_done_retry_count` 恰增一次、无二次 schedule(R6#1 三组)。

## 3. TDD 顺序(RED → GREEN)

1. **刀 2 纯函数**:`land-retry-policy.test.ts` —— 分类表逐 reason;退避序列 1m/2m/4m/8m/15m/30m/60m/120m;**对抗测试:reason 震荡(closeout_incomplete ↔ land_execution_error 交替、step 无前进)第 9 次耗尽转 held(`retry_exhausted:` 前缀)**;epoch key 变化(新 step receipt)归零;未知 reason 归 retryable;waiting 不记账。**刀 7 归一化 helper 表驱动(R6#3,先于集成 RED)**:`undefined`/`null`/非字符串/空串/纯空白(均 → `"unknown"`,空白视为 empty);199/200/201 字符边界;超长 `arbitration_failed:` 前缀截断后稳定前缀保持;同输入重复调用输出字节一致(确定性)。
2. **刀 1+3 StateStore**:`StateStore.land-lifecycle.test.ts` 增:新列迁移幂等(建两次);NULL 列行 runnable 语义逐字不变(F5);括号化谓词下 partial 未到点不被捞/不可 claim,`running` 过期 lease 分支不受 `next_attempt_at` 影响;到点可 claim;claim 预读与 UPDATE 同条件。
3. **F1(FLY-1751 真实重放,provider 级,R1#5)**:
   - F1a:provider fresh read reject + observation=`completed` → 同 pass PASS → 本地级联全走(closeout→thread archive→run completed,Done 经 `already_completed` settled)。
   - F1b:provider fresh read reject + 无 observation → degraded PASS(审计事件在)→ 同 pass 本地级联全走;markIssueDone 同 fail → disposition=`deferred`;注入恢复 → 慢扫 settled。
   - F1c:provider fresh read **悬挂(never-resolving)** → 10s timeout → 走 F1b 路径(本地清理不被挂死)。
4. **F2(consumer thrown → 退避恢复)**:preArbitrate thrown(`arbitration_failed:*`)一次 → operation `partial` + `retry_count=1` + `next_attempt_at≈+1m`(**断言非 held、run 仍 active**);推时钟 → 重试 → 级联全走。
5. **F3(耗尽)**:arbitration 持续 thrown ×9 → 退避时间戳序列断言 → 第 9 次 operation `held`(`retry_exhausted:` 前缀)+ run `held` + alert payload 含 `{attempts, epochKey}`。

### Code review R1 收口(2026-08-14)

- `post-ship-finalization` 的 manifest-completed / already-completed 两条 replay 短路也必须先重放并持久化 Linear disposition;记录失败返回 retryable partial,不允许被 `finalization_completed` 硬门确定性推成 held。
- 已 settled 的 `done` / `canceled_refused` 单调不降级;后续 Linear 读失败算幂等成功。finalizer 被 kill switch 关闭或未配置时结算为 operator-refused,不创建永不出列的 deferred。
- deferred sweep 增 `retry_count` / `next_attempt_at` / `last_attempt_at`,按 15m/30m/1h/2h/4h/8h/24h 轮转;固定前 10 条失败后会让出队头。24h 日告警只使用 operation/Lead/day 的稳定 payload,动态错误文本不参与 UID。
- legacy finalizer 的 timeout/rejection 日志恢复;terminal classifier 同时识别带 `land_execution_error:` 包装的永久 receipt conflict。
6. **F4(守卫)**:canceled observation / park tombstone → 拒绝不降级;markIssueDone 撞 canceled → `canceled_refused` 且零 Done 写;**defer 后 founder park → 慢扫重仲裁 → `canceled_refused`、零 Linear write**;慢扫 finalizer 悬挂 → 15s abort、单行隔离、rider 不卡死;**迟到写两例(R2#2)必须落在生产调用点级(R5#3 锐化):`post-ship-finalization.test.ts`(主路径)与 `land-linear-done-sweep.test.ts`(慢扫)各覆盖 (a) never-settle → 有界返回 + latch/mutex 释放、(b) timeout 后 client 恢复 + 插入 founder park → `updateIssue` 零调用 —— helper 级(`linear-issue-finalizer.test.ts`)只证局部算法,不能防调用点漏用 helper / 传错 finalizer / 在 helper 外继续等待,不算满足;按 R4 备注用 fake timers + 显式 microtask flush**;**刀 7 归一化三例(R5#1):主路径 >500 字符 reason → run 照常完成 + deferred 归一化落账;慢扫 >500 字符 → 让位轮转 + aged alert 可达;arbitration reject 超长变体**;reason 分类六个 `founder_review_*` 字面 + 一个未来未知字面逐一断言(R2#4)。
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

- 代码 + 测试(刀 0-7 + F1-F5)。
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

## 10. 重派确认复审(R5/R6,2026-08-14)变更摘要

背景:原 workflow run 因载体基建缺陷被判终,新 run 重派 design 节点;Bridge fail-closed design gate 要求对当前 HEAD(`15a4ef70a`,已 merge origin/main)做真实确认 review。Codex 独立复审判 CHANGES REQUESTED,三项全部经代码实读核实属实:

1. **R5#1(实现缺口,新增刀 7)**:超长 Linear 错误 reason 未归一化即入库,撞 StateStore >500 fail-closed 门 → 主路径烧预算终至 held(在这一窄边界复活本 issue 要杀的 bug 类)、慢扫中毒行永占队头。合同见刀 7。
2. **R5#2(plan 自相矛盾,已折回)**:刀 2 早稿四档 backoff / CAP=5 草图与 code review R1 加宽后的权威散文(8 档 / 第 9 次耗尽)冲突 —— 已把最终合同(实际导出名/签名/8 档数组/耗尽规则)折回刀 2,刀 1 折齐 10 列 schema。本 plan 恢复为唯一可执行合同。
3. **R5#3(测试缺口,F4 锐化)**:F4 承诺的「主路径、慢扫各一」timeout/迟到写用例在分支上只落到 helper 级 —— F4 已锐化为点名两个生产调用点测试文件(`post-ship-finalization.test.ts` / `land-linear-done-sweep.test.ts`),helper 级不算满足。

确认轮 R6(Round 2)追加三项,全部折入:

4. **R6#1(刀 7 状态机闭合)**:「泛化 outer catch 推进」不闭合 —— Store `{ok:false}` 正常拒绝不抛异常(settle 分支直接 return 留行于队头)、alert 抛错会致同一 attempt 双推进跳档。刀 7 第 3 条改为闭合 per-candidate 状态机:全部出口分类、fallback 前重读精确行幂等结束、expected `linear_done_retry_count` CAS 单推进、aged alert 独立错误隔离且不触发二次 schedule、best-effort 边界诚实声明;F4 增 (d)/(e)/(f) 三组。
5. **R6#2(顶层 scope 折齐)**:§2 标题 8 刀、交付物刀 0-7;Status 行按 blob 诚实分账(旧 R4 approval 属旧 blob `5adde5bb`,当前修订版 verdict 以 gate 回执为准,不自证)。
6. **R6#3(归一化 helper 纯函数合同)**:TDD 步骤 1 增表驱动用例(non-string/空/纯空白 → `"unknown"`、199/200/201 边界、前缀保持、确定性字节一致),共享单一来源自身有直接验收。

**对本 run 后继节点的 binding delta**:分支 HEAD(`15a4ef70a`)尚未满足刀 7 与 F4 的 R5#1/R5#3(含 R6 增补)用例 —— implement 节点的「代码零改动」假设作废,须按刀 7 + F4(R5/R6 增补)TDD 收口;QA 节点须知代码将变、既往 PASS 需按新 head 复验。其余全部刀(0-6)与现有实现经确认轮核实一致,不重做。合并 origin/main 带入的 #843/#844/#848 经确认轮核实未触碰 land 链路(StateStore/plugin 差异分别局限于 runner mailbox 状态与 Lead inbox 清理)。
