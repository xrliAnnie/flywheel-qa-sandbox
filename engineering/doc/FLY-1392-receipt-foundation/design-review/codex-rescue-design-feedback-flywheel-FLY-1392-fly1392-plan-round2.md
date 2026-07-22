# Design Review — FLY-1392 plan.md (Round 2)

Date: 2026-07-20
Author: Codex
Status: CHANGES REQUESTED

## Summary

draft v2 对 Round 1 的 11 项逐项作了实质修订：同连接 UOW、typed provenance、hub-root 生命周期、wake schema、Lead-keyed resolver、cursor bootstrap、route scope、dead-letter outbox 与 flag-first 都已进入可实现形态，整体明显接近可批准状态。但组合这些修订后仍剩 5 个 blocking 冲突：wake 预算不是 crash-safe 硬上限、同一 founder 事件仍有多个 retry owner、`already_answered` 会制造错误 evidence、terminal/outbox race 会吞或误发升级，以及新 reconcile 若复用现有全量 pass 会重新开启旧 detection rows。修正这些机械合同后，不需要推翻当前方向。

## What's Good (Keep)

- §2.5 把四类复合写明确收口到同一 `CommDB` connection/transaction，并允许扩展 trusted-writer transaction body；这真正修正了“同库即同事务”的错误前提。
- §3 将 provenance 按 producer 冻结，推导只复制既存 actor/fence，缺失即不填；owner takeover 与 null provenance 负测方向正确。
- `hub_recorded` 同时设置 delivered/consumed，使 founder root 不污染 LeadInboxLoop/ProtocolIngress/health pending，同时保留独立 processed 轴。
- cursor watermark、空 matching、F-3/F-4 分治、结构化 frozen candidates、scope revalidation 与封闭 emoji allowlist 均落实了 D-1/D-7 和 FLY-1099 边界。
- wake 已恢复 durable columns、observedAt/ack_scope、sanctioned `wake_pointer`、teardown retention 与 T3 outbox；不再依赖 metadata 充当状态机。
- Lead-keyed resolver、独立 feature flag 装配、outcome-gated `escalated_at`、batch dead-letter transaction，以及 S1 先落 flag/sentinel，均直接解决了 Round 1 的实现阻塞。

## Issues & Recommendations

1. **[Blocking — Wake storm / crash correctness] `push_attempts` 在 I/O 之后才递增，因而不是硬预算；admission 也仍缺跨 intent 的风暴上限。** §5.2 的顺序是 claim → push → `push_attempts++`。若 transport 抛错，或 main inbox 已 append 后在 ledger completion 前崩溃，claim 到期后可用未变化的预算再次调用 transport。稳定 `flywheelId` 不能完全封住这个窗：Claude sidecar 的 stale pending 在 60s 后会被删除并重新执行 main write（`ClaudeMailboxCodec.ts:688-749`），而 main append 与 sidecar finalize 本来就是两阶段（`:209-232`）；因此 crash-after-main/before-finalize 仍可产生第二次真实写。持续错误下也可无限产生 transport attempts，与 §2/§8 的 `PUSH_BUDGET=2` 和 DB-failure storm claim 不符。另一个维度是 plan 只有 per-intent budget，没有 FLY-1339 absorbed design 的 per-exec admission cap；N 个不同 causal keys 仍允许 2N 次 push。§5.1 还写“ledger insert 失败但业务写照常提交”，此时既无法写 `suppressed_ledger_unavailable`，也没有持久化 `envelope_json`；恢复腿只说扫描“有 intentKey 痕迹”的业务行，尚未逐 causal type 冻结 backend/envelope/recovery query。**建议：**claim transaction 必须在 I/O 前分配单调 attempt ordinal 并消耗 `push_attempts`；completion 只按 ordinal/token 合并 result/释放 lease，失败或 crash 也占预算，stale success 只补真实 delivery fact。恢复 per-exec 滑窗 cap（或给出其它可证明的全局 admission bound）与 persisted suppressed reason。对 ledger-unavailable 明确二选一：整个 UOW 回滚；或把每类业务行正式定义为 recovery outbox，逐 `gate-answer/instruction/founder-route/ship-hint` 写出可重建的 versioned envelope/backend/source query 与冲突处理。增加 crash-after-main/before-sidecar-finalize、不同 key 负载、ledger row 缺失且 session 已清理的测试。

2. **[Blocking — Resend spam / state ownership] 同一 founder 消息现在仍会产生两个 canonical retry owners，F-4 promotion 也与通用 resend 共用同一个 due。** §3.3 要求 `founder_reply` hub-root 和 `founder_reply_ambiguous` model-row 都有 processed；§6.1 又把所有 `resend_of IS NULL` 的 required rows当 root。F-6/A-3 后，这两行在 route CLI 处置前会各自推进 `resend_round`、生成 resend family 和 `episodeFingerprint=id`，所以同一 founder 消息可被重发/升级两次。F-4 的 root 同时用 `next_unprocessed_at` 表示“到期晋升模型巷”（§4.2）和“到期发第 N 次 resend”（§6.1），没有 routing state/exclusive predicate 时两个 patrol action 可竞态。还有一个明确的 cap off-by-one：§6.1 先 `resend_round++`/插入，再以 `resend_round > RESEND_CAP` 升级；cap=2 时会插入 r3 后才升级，违背“root 字段=已发轮数”。**建议：**增加 `receipt_family_root_id`/`retry_owner_id`（或等价状态），规定一个 founder msg 的 hub/model rows只有一个 reminder/escalation owner；另一行仍需 processed evidence，但 `next_unprocessed_at` 必须为 NULL/不入 patrol，route UOW 双标收口。给 F-4 增加明确 `routing_state=awaiting_rebind|model_promoted|bound`，promotion CAS 与 resend selector互斥。cap 判断在递增前执行：`round < cap` 才插入 `round+1`，否则只 enqueue escalation，不再改 round/发 r3。测试断言每个 Discord msgId 在全链上只有一个 family、一个 outbox、精确 cap 次 resend。

3. **[Blocking — Evidence correctness] `already_answered` 不能靠赢家 response 自动证明这条 founder message 已处理。** §4.5 说 question 被他人先答时返回幂等 `already_answered`，并让 root 按 §3.2 推导收口。但那个 response 可能来自另一 actor、发生在 founder message 之前或回答了不同语义；它只证明 question 已终态，不证明该 founder 回复被绑定，也不等于 Lead 显式作出了 `no_route` 决策。这重新引入蓝图 §2.4 明令排除的“别的 actor 造成状态变化却被拿来当本消息 evidence”。**建议：**区分两类：若重试发现同一个 route UOW 已提交（root/model evidence 已存在），返回真正 idempotent success；若是竞争者先答，只返回 `stale_candidate/already_answered` 并保持 model row pending，要求 Lead 选其它 frozen candidate 或显式 `--no-route --reason already_answered`。若产品选择让当前 CLI 自动收口，也必须由本次已授权 Lead 在同一 UOW 写 typed evidence（如 `kind=lead_no_route, basis=already_answered, ref=<winningResponse>`）并双标两行，不能把 winning response 本身当路由证据。加入“另一 actor 在 CLI 前答复”和“同 CLI commit 后重试”两条区分测试。

4. **[Blocking — Escalation loss / false page] “session 终态即 stand-down”与 kill-pane 验收冲突，outbox drain 也缺 source revalidation/cancel 状态。** §2.2/§5.4 规定 session 终态后取消所有梯级，但验收 #3 要求 pane 被杀、T2 健康门失败后产生 `wake_failed` 并进 T3。当前已有 terminal sync 会把 failed/blocked 写回 CommDB；若它先于 patrol 发生，v2 会保留 intent 行却立即 stand-down，正好静默吞掉应升级的失败。反向 race 也存在：root 在 `unprocessed:*` outbox 提交后、drain 前获得 evidence，或 wake 在 `wake_failed:*` outbox 提交后标 started，现 outbox 只有 `delivered_at`，consumer 未被要求在外部通知前重验 source，仍会发一条已经过时的升级。**建议：**把 terminal 分成 outcome：`started`/业务已完成/明确 superseded 才 cancel；runner failed/dead/target disappeared 且 intent 从未 started，应直接形成 `wake_failed:terminal_before_started`，而不是 stand-down。`receipt_alert_outbox` 增加 terminal cancellation（如 `canceled_at/cancel_reason`），consumer 在每次外部 effect 前事务性重验：unprocessed root 仍 NULL 且 owner active；wake intent 仍 pending 且失败条件仍成立；否则持久 cancel、不通知。测试 outbox-commit 后 response/started、terminal sync 先于 T2、clean issue completion 与 dead runner 两种 terminal 分支。

5. **[Blocking — Scope / legacy reactivation] “新 reconcile callback 只处理 receipt/wake kinds”尚未落成可调用的过滤合同；直接复用现有 pass 会重新启用旧 detection rows。** GatePoller 当前只有一个 `onDetectionReconcileTick` slot（`gate-poller.ts:199-206`），production `runDetectionReconcileTick` 最终调用 `reconcileDetectionEscalations`；后者通过 `getDetectionEscalationsForReconcile()` 读取全部 non-RESOLVED rows（`detection-escalation.ts:339-400`; `StateStore.ts:9979-9995`），会推进所有 kind 的 CLEARING rebound、fleet/group 与 founder page。因为 receipt flag 默认 ON，若 v2 仅把该全量 pass 从 `legacyDeliveryWatchdogsOn` 下移出，就会在旧 flag=false 时重新处理历史 legacy LEAD_NOTIFIED rows；两 flag 都开时还可能装配/运行两次。这违反 §6.3“不开旧检测簇”和 §7 flag-off byte compatibility。**建议：**在 plan 定义机械过滤面：新增 kind-scoped StateStore query/`rowFilter`，本功能只允许 `wake_failed` 与 `receipt_unprocessed:*`（及其明确枚举子类）进入 C3；旧 pass 仍只受 legacy flag 控制。plugin 将两个 pass组合进一个 callback/single-flight，但各自读取互斥 kind 集，不能用一次 unfiltered run 代替。测试预置 legacy 与 receipt 两类 LEAD_NOTIFIED/CLEARING rows，覆盖 flag 00/01/10/11，证明 receipt-only 不 page/重置旧 row、legacy-only 不消费新 row、双开各行只推进一次。

## Verdict

CHANGES REQUESTED — address items above
