# FLY-1832 Ship 卡去重 + 合入后 thread 自动归档收口 — 实施计划

Issue: FLY-1832 (https://linear.app/geoforge3d/issue/FLY-1832/shipux-ship-卡重复投递两条都能点-合入成功后-thread-不自动归档要-founder-每次提醒)
日期: 2026-08-17
基于: 无

---

## 0. 一句话

两条缺陷都已用生产事件账 + 代码逐行实证到唯一根因:**缺陷 1** = engine gate materializer 与 GatePoller founder-thread fallback 两条投卡路径各持独立 dedup 账本、对同一 gate question 各发一张卡;**缺陷 2** = 自动归档其实每次都成功了,但 land-executor 在归档 **1 秒后**把 `land completed` 叙事消息发进同一 thread,Discord 规则使 thread 自动解除归档 —— founder 看到的"不归档"是"归档后被自己的尾巴重新打开"。修法都是**修结构、删多于加**:一 gate 一投手、归档成为 thread 的最后一次写入。

---

## 1. 缺陷 1:同一张 ship 卡投两条

### 1.1 生产实证(teamlead.db `session_events`,只读)

FLY-1455(founder 截图那单):

| UTC 时间 | 事件 | gateMessageId | 投递方 |
|---|---|---|---|
| 08-17 06:23:40 | `founder_thread_notified` (approve_to_ship) | `…067670` | **gate materializer**(裸标题,ageMinutes=0,不写 notify marker) |
| 08-17 06:23:56 | `founder_thread_notified`(同一 questionId `workflow-gate:8348…`) | `…991602` | **GatePoller fallback**(带 `[QA·Opus]` phasePrefix,恰好 15s ship-card grace 后) |
| 08-17 06:23:56 | `founder_thread_notify_done`(fallback 专属 marker) | — | fallback |

按 questionId 聚合 08-10 以来全部 approve_to_ship 卡:**08-12 21:41 之前基本恰 1 条;之后绝大多数恰 2 条、间隔 15–17s**(= fallback 的 `shipGateCardGraceMs` 默认 15_000);少数 1 条(FLY-1809/1811/1810/1834);一例 9 连发(FLY-1759,见 §1.4)。回归窗口与 engine-owned gate materialization(FLY-1441/1655 一族)上线时间吻合。

### 1.2 根因(代码级)

两条合法投卡路径,各自 dedup、互不知晓:

1. **Materializer 路**(`plugin.ts` workflow gate materialization loop → `gate-materializer.ts` `materializeWorkflowGateHolder`):
   - 自己把 question 写进 CommDB(`insertQuestion`,id=`workflow-gate:<hash>`,checkpoint=approve_to_ship,from_agent=holder.source_execution_id);
   - `postCard` → `emitFounderThreadNotification`(**不传 phasePrefix** → 裸标题);
   - 幂等账本 = `workflow_gate_holder.materialization_stage` + `card_message_id`。
2. **GatePoller fallback 路**(`gate-poller.ts` `maybeEmitFounderThreadFallback`):
   - 扫 CommDB pending questions,扫到 materializer 刚写入的**同一条** question;
   - 单一所有权围栏 `StateStore.workflowGatePresentationDisposition`(FLY-1441)对 holder 匹配的 question 返回 `{allow: true, reason: "holder_authoritative"}` —— 该函数的 `allow` 语义是"这是当前权威 ship question(非 stale/superseded)",被 fallback 误当成"我可以投卡";
   - 15s grace 后投第二张卡,`phasePrefix = phaseMessageTag(session.chat_thread_role, session.runner_model, …)` —— holder.source_execution_id 是刚发 verdict 的 QA exec(session.chat_thread_role=qa, runner_model=claude-opus-5)→ `[QA·Opus]`;
   - 幂等账本 = session_events 里的 `founder-thread-notify-${questionId}` marker,materializer 从不写它。

**为何多数 2 条、少数 1 条**:fallback 入口有 `ACTIVE_SESSION_STATUSES.has(session.status)` 存活检查。DAG 单的 QA-PASS holder 依约 park 存活到 post-ship(status=awaiting_review,active)→ fallback 放行 → 双卡;单 session menu 单(FLY-1809/1811/1810/1834)在 gate 打开时 source session 已 `completed`(engine handoff 终态)→ fallback 被存活检查拦下 → 恰 1 条(且那 1 条是 materializer 发的,无 fallback marker 为证)。

**"两条都能点"的实际语义**:`writeGateMessageBinding` 是 write-once —— 只有先落的 binding(通常是 materializer 卡)对 ✅ reaction 有效;第二张卡的 ✅ 是**死入口**(reaction pass 只 fetch bound message 的 reactions)。founder 无从分辨,若她恰好只点了第二张,批准会被静默忽略 —— 比 issue 里写的"行为未定义"更糟,是"看似可点、实际无效"。

### 1.3 修复 Fix 1A(主修):holder-backed gate 的卡唯一由 materializer 投

改动点:`gate-poller.ts` `maybeEmitFounderThreadFallback` —— 在拿到 disposition 后:

```ts
if (cp === "approve_to_ship" && gateOwnership.reason === "holder_authoritative") {
    return; // 卡的投递权在 gate materializer(有 severe fail-loud 兜底),fallback 不再补投
}
```

- **共享的 `workflowGatePresentationDisposition` 函数一字不动** —— 其余 5 个消费者(relay 腿、question-admission、event-route、DirectEventSink、terminal-gate-retirement、bootstrap-generator)靠 `allow` 判"该 question 是否权威可答/可转",语义正确,不能改共享返回值,只能在 fallback 这个投卡消费点按 `reason` 细分。
- 其余 reason 行为不变:`legacy` / `legacy_epoch`(无 holder 或旧代 run)→ fallback 仍是唯一投卡人(FLY-1811 型 runner-ship 兼容边界里 carrier unbound 时 disposition 本就 deny);`holder_missing` / `holder_mismatch` / `before_gate` / `activation_ambiguous` → 本就 deny。
- **不做 fallback 兜底补投**:materializer 持续失败已有 `materializeWorkflowGateWithFailLoud` → severe alert 到 Lead(workflow-gate-materialization-alert.ts),不会静默丢卡。fallback 补的卡 reaction-dead(见 §1.2),留着它才是危害。
- phasePrefix 不迁移到 materializer 卡:ship gate 是 run 级终局门,不属于任何 phase,裸标题是对的(也与单 session 单现状一致)。

### 1.4 修复 Fix 1B(硬化):materializer 卡投递做到 effect-level exact-one(9 连发根治)

FLY-1759 实证:9 张卡里前 8 张 `founder_thread_notified.gateMessageId = NULL` —— `postFounderThreadCore` 的 5s AbortController 预算覆盖 fetch **加 body 读取**,高负载日(08-14 restart storm)2xx 后 `res.json()` 被同一 timer abort → messageId undefined → plugin 的 `postCard` 视为失败 throw → stage 停在 card_posted 之前 → 下一 tick **重新 POST**。Discord 端每次都真发了。

核心合同(Codex R1 #1):**验收就是"恰一张卡",所以 ambiguous outcome 绝不盲重投**。三件套:

1. **分阶段有界超时**(`founder-thread-notifier.ts` `postFounderThreadCore`,Codex R1 #2):headers 沿用现有 5s 预算;`res.ok` 后**换一个独立的 body-read 预算**(新 timer,仍可 abort body,绝不允许 body 无限挂起 —— 该 core 被 gate / milestone / stuck / issue-thread infra 四条路径共用,挂起会顺带挂死 land 通知与 fail-loud 通道)。body 超时/解析失败归类为新 outcome **`posted_ambiguous`**(POST 已被 2xx 确认、message id 未知),与普通 transient 失败区分。
2. **POST 前持久 attempt claim + ambiguous 走 fail-closed reconciliation,不走重投**(`gate-materializer.ts` + `StateStore.ts`;Codex R2 #1):
   - **卡片正文携带唯一关联标记**:card content 追加一行短标记 `gate:<questionId 哈希前 12 位>`(founder 无感的小字 footer)。issue+head 不是 attempt 唯一(同 head 可铸新 questionId),必须有 per-question 可回读身份,reconciliation 才能精确匹配。**标记在 `buildBody()` 作为独立字段渲染,置于 `truncate(summary, 1500)` 之外**(Codex R3 #1:exact-one 身份不得依赖正文长度恰好没被截断)。
   - card POST 步骤:先在 holder 上**持久 CAS 写入 post-intent**(intent 序号 + 时间 + 关联标记,写盘成功才允许 POST)→ POST → 成功且拿到 id 才 advance `card_posted`。
   - **Reconciliation 是 fail-closed 的,且负证明是可测试算法**(Codex R3 #1):下一 tick 看到 post-intent 存在但 `card_message_id` 缺失 → 分页 GET `/channels/{threadId}/messages` **完整覆盖 intent 时间窗**,按 bot 作者 + 关联标记精确匹配。命中恰一条 → 用它 advance,不再 POST。**零匹配升格为"效果未发生"的确定规则**:intent 时持久化 `reconcile_not_before = intent_at + 静默期`(默认 60s);到点后做**两次相隔明确 quiet interval(默认 30s)的完整扫描**,两次都零匹配**且**窗口边界与 thread 消息 frontier(最新 message id)未变 → 才判 no-effect,允许恰一次重 POST(重新 CAS intent)。GET 非 2xx、超时、单页满/截断、总页数或总时长超预算(page cap 默认 4 页、单轮 deadline 默认 10s)、多匹配、两次扫描结果不一致、frontier 变化 → 一律维持 `posted_ambiguous`,不授权新 POST。**ambiguous probe 不刷新 holder.updated_at**(否则 `materializeWorkflowGateWithFailLoud` 按 updated_at 计的 10 分钟 severe 门槛被无限续命,卡死变成静默)。
   - 只有**已证明效果未发生**的失败(4xx 拒绝、network error 且 reconcile 确证无卡)才消耗重试预算;intent 序号 ≥3 → 不再 POST,走既有 `materializeWorkflowGateWithFailLoud` severe 通道(reason=`workflow_gate_card_post_budget_exhausted`);ambiguous 停在 reconciliation 循环里不烧预算也不发新卡。
   - **部署迁移(legacy in-flight holder)**:上线时已存在、stage < card_posted 且**无 intent 记录**的 holder,不得当 fresh intent —— 旧代码可能已 POST 成功只是没落 id。它们标记 `legacy_unknown`,从 holder `created_at` 起做同样的保守 reconciliation(此时无关联标记,退化为 bot 作者 + issue/head 正文 + 时间窗,多匹配/不可判 → severe fail-loud 交 Lead),证明无卡才允许首次 intent。
   - **legacy 审计收敛(append-only,不改历史)**(Codex R3 #2):旧 notifier 在 durable bind 之前就用随机 event id 写过 `founder_thread_notified`(可能带 id 也可能 NULL)。`legacy_unknown` reconcile 找回 id 后,先按 execution/questionId 查已有成功事件:**已有一条 → 不再新增同类型事件**,改写确定性的 `workflow_gate_card_reconciled` repair 事件携带找回的 id;已有多条、或旧事件 id 与 reconcile id 冲突 → severe fail-loud,不自动收敛。§1.5 的"恰一条带 id 成功事件"验收**限定为新式 intent holder**;历史 audit 永不改写。新式路径同样要求:binding 后、audit 前崩溃的 replay 会补写确定性 audit,且 `materializeWorkflowGateHolder` 的 completed early-return 不得跳过该补写。
3. **`posted_ambiguous` 的逐 caller 消费合同**(Codex R2 #2):`postFounderThreadCore` 四个共享 caller 里,**只有 gate(materializer)caller 需要 message id**,它把 2xx-no-id 交给上面的 reconciliation;milestone / stuck / issue-thread infra 不需要 id,**2xx headers 即视为 posted**(body 超时不改变已投递事实),`emitIssueThreadInfraNotification` 的调用内重试循环对 `posted_ambiguous` **不得重投**。任何 caller 都不许盲重试 ambiguous。
4. **成功审计移到收敛点**:materializer gate 卡的 `founder_thread_notified` 成功事件不再在 notifier 内用随机 event id 写(那发生在 durable bind 之前,network-after-send 会漏、2xx-no-id + reconcile 会双写)。改为在"message id 已取得(直接或 reconcile 找回)并持久绑定"这一收敛点,用 questionId 派生的确定性 event id **恰写一次**。legacy fallback 路径审计保持原样。
5. **测试覆盖 crash 窗口**(§4):intent 后 POST 前崩溃;POST 成功落 id 前崩溃;2xx 无 id → reconcile 命中零新 POST;delayed visibility / 窗口满页 / 多匹配 / 同 head 新 attempt → 维持 ambiguous 零 POST;network-after-send;body 永不 settle(gate 与 infra 两 caller 有界返回、fail-loud 可达,且 infra 只发一次);legacy holder 迁移(pre-deploy 已 POST 的 crash 场景);direct/reconciled 两路各恰一条带 id 的成功事件;预算耗尽。

### 1.5 缺陷 1 验收

- 任一 ship gate:`session_events` 里同 questionId 的 `founder_thread_notified` **恰 1 条**;Discord thread 里恰 1 张卡。DAG 单(QA holder park 存活)与 menu 单都要验。
- 卡上 ✅ / 回复 → 批准链路不回归(binding 恰由 materializer 写,verify-approval 通过)。
- materializer 人为致瘫(测试注入)→ 无卡但有 severe alert,fallback 不补投。

---

## 2. 缺陷 2:合入 + 清理后 thread 不(保持)归档

### 2.1 生产实证 —— issue 里三个假设 (a)(b)(c) 全部排除

昨晚四单事件账(FLY-1811 为例,其余三单 pattern 逐字一致):

| UTC 时间 | 事件 |
|---|---|
| 01:48:38–47 | land cleanup:close runner、worktree cleanup、ready-to-close 通知(发进 thread) |
| 01:48:47 | `chat_thread_archived` source=`bridge.post-ship-finalization` status=200 **← 级联真的跑了、也真的成功了** |
| 01:48:48 | `issue_thread_infra_notified` kind=`land_completed` **← 归档 1 秒后,`🏁 land completed` 发进同一 thread** |
| 01:59:01 | `chat_thread_archived` source=`bridge.done-thread-archiver` `reArchived:true` **← Lead 手动 API(founder 提醒后;FLY-1809/1811 两条相隔 2s = 连点两下)** |

Discord 规则:archived(未 locked)thread 收到任何新消息即自动 unarchive(`chat-thread-utils.ts` 注释亦明确承认)。所以:
- (a) close 走错分支?否 —— post-ship finalization 正常归档,200 ok;
- (b) 活 holder 挡住?否 —— 归档成功了,holder 在 finalization 前已收(finalizeWorkflowPhaseRoles);
- (c) land 与 close 没接上?否 —— 接上了;
- **真根因 = land-executor.ts 的步序**:`finalize(operation)`(内含归档,post-ship-finalization.ts §(2)(3) 有明确"notifier MUST run BEFORE archive"纪律)→ 返回后 `announce(deps, operation, claim, "completed", …)`(land-executor.ts:580)→ plugin.ts `notify` → `emitIssueThreadInfraNotification` → 打进已归档 thread → unarchive。
- unarchive 后**无自动纠偏**:FLY-1282 targeted archive 只在 completion 事件时 enqueue(早已消费);FLY-1165 sweep 6h 太慢;于是每单都要 founder 提醒 + Lead 手动 `POST /api/chat-threads/archive`。
- **不能用 Discord `locked` 修**:FLY-1709 的 founder-reopen 保护依赖"founder 在归档 thread 里说话即重开、机器不与之对抗"。锁了她就说不了话。

### 2.2 修复 Fix 2A(主修):归档成为 thread 的最后一次写入,终局通知是独立的 resumable 步骤

1. **`land_completed` 叙事不再写 thread,且收据必须说真话**(Codex R1 #4):`announce()` 现在对任何 `notify` 正常返回都硬写 `{delivered: true}`。改法:`LandExecutorDeps.notify` 返回结构化 disposition(`posted | suppressed_archived | covered_by_terminal_notification`),`announce` 如实落 receipt(`delivered` 只在 `posted` 为 true,附 `disposition` 字段)。plugin 的 `notify` 对 `stage === "completed"` 返回 `covered_by_terminal_notification`、不 POST —— 不再产生假 `issue_thread_infra_notified`,也不制造假 delivered。
2. **终局消息 = finalization 内新增的独立 resumable 步骤,不复用 ready-to-close 的 claim**(Codex R1 #3:`emitRunnerReadyToCloseNotification` 是 claim-first、失败即永久吞;且它在 `closeoutBlocked` / worktree 未收时也会跑,复用会在 partial pass 上说假话)。新步骤 **terminal-notification** 的合同:
   - **共同 readiness predicate**(Codex R2 #3):现状 archive 只查 `thread && botToken && !closeoutBlocked`、Linear Done 只查 `!closeoutBlocked`,而 `worktreeRemoved=false` 到函数尾部才返回 partial —— worktree 失败的 partial pass 现状会**先归档、先写 Done**。修法:显式抽一个 readiness 谓词(resumable land 至少 `!closeoutBlocked && worktreeRemoved`),**同时围住 terminal-notification、archive、Linear Done 三者**;thread 存在时,archive 的前置再加"terminal receipt 已 settled"。partial pass 三者全部零调用;下一 pass cleanup 成功后严格按 terminal → archive → Linear Done 收敛。
   - **收据落账**(Codex R2 #4):复用既有 generation-fenced `land_operation_step`(`recordLandOperationStep`,带 operationId/ownerId/generation CAS),**不另造无 owner fence 的隐式账本**。为此 `plugin.ts` 的 land `finalize:` 需把 `landOperationId` + 当前 claim(ownerId/generation)显式传入 `runResumablePostShipFinalization`(或传一个 generation-fenced receipt callback);stale generation 写入被拒 → finalization 保持 partial。
   - **收据语义**:**post-success receipt**(确认 Discord 2xx 后才持久化 step `terminal_notified`),绝不 claim-first;未送达 → finalization 返回 partial(land 既有 retry/held 机制接管,fail-loud),**不带着未送达的终局消息去归档**。
   - **crash 窗口**(显式声明):POST 后 receipt 前崩溃 → 重放可能重发一条终局消息(informational at-least-once,可接受,不承载权威);receipt 后崩溃 → 幂等跳过。
   - **作用域**(Codex R2 #4 纠错):非-resumable `runPostShipFinalization` 仍被 event-route / DirectEventSink / merge-ship-gate / external-merge-reconcile 等活跃入口调用并共享 `runPostShipFinalizationInner` —— §5 原稿"唯一调用方"陈述**错误,予以更正**。新的 terminal/waiver 行为一律显式 gated 到 `resumable && landOperationId`,legacy 非-resumable 入口**字节不变**(测试直接调用至少一个真实 non-resumable 入口证明零新文案/零新 receipt/partial 语义不变)。
   - **文案**(founder 可读):
     > ✅ **已合入 PR #N — <identifier>**
     > 清理完成(worktree / runner 已收),本 thread 将自动归档;Linear 状态随后落 Done。
   - 现有 Lead-facing ready-to-close 通知**原样保留**(scope discipline,其 claim 语义不动)。
3. **步序结果**:… `cleanup_requested` → finalize [ready-to-close(Lead-facing,现状)→ readiness 谓词 → **terminal-notification(founder 终局,post-success receipt)** → **archive(最后一次写入)** → Linear Done(纯 Linear,无 thread 写)] → `completed`(仅审计,`covered_by_terminal_notification`)。归档后再无任何 Bridge 侧 thread 写入。

### 2.3 修复 Fix 2B(结构护栏,非报警器):land 叙事腿继承 FLY-1709 的 archived_at 硬零写纪律

守卫判据**只看 `chat_threads.archived_at`**(Codex R1 #5:founder 在 Discord 发言自动 reopen 不清 `archived_at`,本地猜"founder-reopened"不可靠;FLY-1709 的既有模式就是 archived_at 非空 ⇒ 一切自动 display 写硬跳过,直到显式 session-start reactivation 清 epoch)。`plugin.ts` 的 land `notify` 在 POST 前:`archived_at` 非空 → 返回 `suppressed_archived`、零写入(console log + 真实 disposition 落 receipt)。恢复写入**只**经由既有 session-start reactivation,不新增任何本地判断。作用域:land 叙事腿全部 stage(含 `execution_retry` / `finalization_partial` 等后续可能新增的),防 crash-resume 重放与未来 stage 重犯。

### 2.4 "不能归档要说明"(验收第二句)

finalization 归档被 **policy waive**(`founder_reopened` / `in_active_use`)时,现状只写 console log。补:向 thread 发一条一次性说明:

> ⏸️ 本 thread 未自动归档:<原因:founder 已重新打开 / 仍有活 runner `<execution_id>`>。

合同(Codex R1 #5 + R2 #5):land operation 进入 `completed` 后**没有"下一 pass"**(`listRunnableLandOperations` 只扫 intent/partial/过期 running),"非阻塞 + 事后重试"不可达。按"修结构、少加状态机"取 Codex 建议的最简诚实合同:**waiver 说明与终局通知同等待遇** —— 未送达 → finalization 返回 partial,沿用既有 land retry;Discord 2xx 后才写 generation-fenced receipt(`land_operation_step`,step=`archive_waiver_notified`,含 reason + archive epoch),receipt settled 后 finalization 才可完成。语义明确为 **informational at-least-once**:POST 后 receipt 前崩溃可能重发一条,验收措辞为"receipt settled 恰一次",不承诺消息恰一条。**policy waive ≠ 真实 Discord 归档失败**:后者维持现状(`threadArchived=false` → finalization partial → land retry),不发说明。

### 2.5 缺陷 2 验收

- 合入 → 清理 → thread **archived 且保持 archived**(归档后 ≥10 分钟事件账无 `issue_thread_infra_notified`、Discord 侧无 unarchive),founder 零提醒;
- 事件账顺序断言:`chat_thread_archived`(ok)之后同 issue **零** Bridge 侧 thread 写入事件;
- 归档被 waive 时:原因说明**至少一条**(informational at-least-once,POST 后 receipt 前崩溃可重发),`archive_waiver_notified` receipt settled **恰一次**;无 crash 的正常路径消息恰一条;
- founder 在归档 thread 里说话 → 照旧自动重开且机器不对抗(FLY-1709 回归)。

---

## 3. 改动清单(全部 `packages/teamlead/src/`)

| 文件 | 改动 | 归属 |
|---|---|---|
| `bridge/gate-poller.ts` | fallback 对 `holder_authoritative` 让位(~4 行) | Fix 1A |
| `bridge/founder-thread-notifier.ts` | `postFounderThreadCore` 分阶段有界超时(headers 预算 + 独立 body-read 预算)+ `posted_ambiguous` outcome | Fix 1B-1 |
| `bridge/gate-materializer.ts` + `StateStore.ts` | 卡片正文加 `gate:<hash12>` 关联标记;POST 前持久 CAS post-intent;ambiguous → fail-closed 分页 reconciliation(不可判恒不 POST);legacy holder `legacy_unknown` 保守迁移;确证未发生的重试 ≥3 → fail-loud;成功审计移到收敛点、确定性 event id 恰一次(幂等 ADD COLUMN) | Fix 1B |
| `bridge/land-executor.ts` | `notify` 返回结构化 disposition;`announce` 如实落 receipt(`delivered` 只在 posted 为真) | Fix 2A-1 |
| `bridge/plugin.ts`(land wiring) | `completed` 返回 `covered_by_terminal_notification` 不 POST;`archived_at` 非空 → `suppressed_archived` 硬零写;`finalize:` 显式传 landOperationId + claim(ownerId/generation) | Fix 2A / 2B |
| `bridge/post-ship-finalization.ts` | 共同 readiness 谓词围住 terminal-notification / archive / Linear Done;新增 terminal-notification resumable 步骤(post-success `land_operation_step` receipt,未送达 → partial);waive 说明同合同(step=`archive_waiver_notified`);全部 gated 到 `resumable && landOperationId`,非-resumable 入口字节不变 | Fix 2A-2 / 2.4 |

**不动**:`workflowGatePresentationDisposition` 及其余消费者、`archiveChatThread`(不加 locked)、FLY-1709 reopen 保护与 reactivation 机制、FLY-1165/1282 sweep 兜底、approve/verify-approval 链路、ready-to-close 通知及其 claim、`land-executor.ts` 的 claim/receipt 状态机骨架。

## 4. TDD

- **RED**:
  1. 双卡复现 —— 真实 StateStore epoch-1 holder materialize 完成后,构造 active 状态 source session,跑 GatePoller tick 过 grace:现状断言第二次 POST 发生,修后断言 fallback **零 POST**(非真空:同一用例里 legacy question 必须仍投,证明尺子有效)。
  2. unarchive 尾巴复现 —— land executor 全链 mock Discord:现状断言归档后仍有一次 thread POST,修后断言归档即最后一次写入;`completed` receipt 的 disposition = `covered_by_terminal_notification` 且无 `issue_thread_infra_notified` 假事件。
  3. exact-one 卡:2xx 无 id → `posted_ambiguous` → reconcile 命中 → 复用 id、零新 POST;**负证明算法**:第一次扫描零匹配、第二次出现延迟可见消息 → 维持 ambiguous 零 POST;两次静默扫描 + frontier 不变 → 恰一次重 POST;page cap / 单轮 deadline 超限 → ambiguous;ambiguous probe 不刷新 holder.updated_at(10 分钟 severe 仍会触发);intent 后 POST 前崩溃、POST 后落 id 前崩溃两个窗口;确证失败 ≥3 → fail-loud 且不再 POST;body 永不 settle → gate 与 infra 两 caller 都有界返回、fail-loud 可达;**legacy 审计迁移三态**(旧成功事件无 id / id 匹配 / id 冲突)+ 新式路径 binding 后 audit 前崩溃 replay 补写、completed early-return 不跳过。
  4. terminal-notification 与 readiness 谓词:worktree cleanup 未收/失败的 partial pass → terminal / archive / Linear Done **三者零调用**(非真空:下一 pass cleanup 成功后严格按 terminal → archive → Done 收敛);POST 失败 → finalization partial、不归档;POST 成功 receipt 前崩溃 → 重放至多重发一条、仍归档;receipt 后幂等;stale generation 写 receipt 被拒 → 保持 partial。
  5. Fix 2B/2.4:归档后 crash replay(`notification:completed` receipt 缺失)零写入;`execution_retry`/`finalization_partial` 叙事同受 `archived_at` 硬零写;founder reopen(发言不清 archived_at)不被写入打扰、不 re-archive 对抗;session-start reactivation 后恢复正常写;waiver 两个非真空用例:(a) 无 crash:policy waive → 恰一条消息 → 恰一条 `archive_waiver_notified` receipt → finalization complete;(b) 首 pass POST 2xx 后、receipt 写入前注入崩溃 → finalization partial;第二 pass 同一 reason/archiveEpoch 允许再发第二条消息且只落**一条** generation-fenced receipt(`land_operation_step` 该 step 恰 1 行,payload 的 reason/epoch 与 replay 逐字一致,不一致 → receipt conflict 保持 partial/fail-loud);第三次 replay 零 POST 且 complete。
  6. 回归:legacy(无 holder)/ runner_ship carrier 行为字节不变;**直接调用至少一个真实非-resumable finalization 入口**(event-route / DirectEventSink / external-merge-reconcile 之一)证明零新文案、零新 receipt、partial 语义不变。
- **GREEN/REFACTOR**:vitest 在 `packages/teamlead`(定向文件,不在生产 host 跑全量);既有 gate-poller / gate-materializer / post-ship-finalization / land-executor 套件全绿。
- **真机 QA**(独立 QA 节点,本节点不做):529 房或生产下一单 land 全链,断言 §1.5 / §2.5;founder-reopen 对抗回归。

## 5. 风险与边界

- Fix 1A 后若 materializer 与其 fail-loud 通道**同时**瘫痪,founder 收不到卡 —— 接受:该组合已是 severe alert 缺失级事故,归 FLY-1687 巡检面;不为它保留一个 reaction-dead 的第二投手。
- Fix 2A 只改 resumable land 驱动路径,显式 gated 到 `resumable && landOperationId`;非-resumable `runPostShipFinalization` 仍有多个活跃调用方(event-route / DirectEventSink / merge-ship-gate / external-merge-reconcile),它们**字节不变**并有回归测试背书(§2.2 作用域条,更正了本计划初稿"唯一调用方"的错误陈述)。
- terminal-notification 把 archive 与 Linear Done 增加了一个 Discord 依赖:Discord 长时间不可用会让 land 停在 partial(fail-loud 可见)而非"静默归档不通知"。这是刻意取舍 —— founder 视角"归档但没告诉我"比"晚一点归档"更糟。
- 存量已双卡/已解归档的旧 thread 不迁移,自然消亡(Lead 手动收口一次即可);存量 in-flight holder 走 §1.4 的 `legacy_unknown` 保守迁移。
