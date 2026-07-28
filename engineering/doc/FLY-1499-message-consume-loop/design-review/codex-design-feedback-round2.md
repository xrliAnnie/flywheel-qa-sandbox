# Design Review — FLY-1499 plan.md (Round 2)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已实质关闭 Round 1 的大多数问题：候选 SQL、配额算法、精确死亡证据、per-recipient 单在途、effect/schema、第五次失败账、canonical conflict 与 fast-path 删减都已对齐当前 kernel/schema。`events` 作为 `pa.injected` 的 durable phase anchor 是可接受的无迁移方案，但当前 marker/timeout/settlement 没有形成互斥状态转换，且按 `messageUid + running` 解析 attempt 会让上一 attempt 的迟到结果结算下一 attempt；disposal 也仍有跨事务 TOCTOU，因此本轮尚不能批准。复核固定在 `b40a1e5f748d`；仓库未安装 `node_modules`，未重跑包测试，但已重读计划与权威设计/实际源码，并用系统 SQLite 独立确认四条 pinned SQL 均可 prepare 且命中指定索引。

## What's Good (Keep)

- §3 的修订合同现已自洽：四条注释与 v10 byte-for-byte 保持，确实只插入 `,created_at` 和 `INDEXED BY`；实际 mailbox 列和四个 partial-index predicate 都匹配，独立 `EXPLAIN QUERY PLAN` 也全部命中目标 `_f/_nf` 索引。保留 free-planner STAT4 阳性对照、pinned/free 同答和缺索引 fail-loud 测试是正确的风险控制。
- `registerConsumerTx` 与 `settleFailureMailboxTx` 的 tx-scoped 分层解决了当前 `Kernel.write` 禁嵌套的问题；网络/LLM 仍在事务外，start/settlement 使用同步 `BEGIN IMMEDIATE` 小事务，整体可建于真实的 1000ms 默认 tx budget 之上。
- `DeathEvidence` 绑定 exact old identity、foreign running row fail-loud、成功入口统一为 `submitProposal` 并逐字段核对 identity/mailbox、per-recipient running 闸与所有 wake source 汇入 coordinator，都是对 Round 1 高风险项的正确收敛方向。
- 公平算法已修正为 `streak >= K && nf 非空` 时无条件从完整 nf 池选取；具名最小反例、连续 skip property、保守恢复为 K 和 v11 的 585min 参数化公式均忠实。
- normalized effects 已补齐真实 schema 的 `tasks.project_id NOT NULL` 与 command 非空 `effect_key`；失败 dead 与 disposal dead 分族、第五次失败同步自增到 5、redirect 清 due/保留失败账也正确。
- enqueue 的 canonical read-back、按 `retention_class` 判 notice、显式 bootstrap，以及删除无场景支撑的 due fast-path，符合 fail-loud 和 anti-over-reaction 原则。
- 新包零接线、kernel add-only、root-only exports、更新现有恰等导出/SQL 快照测试的 blast-radius 处理，以及 kernel-first 的总体实施方向都应保留。

## Issues & Recommendations

1. **[HIGH] `messageUid + 当前 running` 不能把迟到结果绑定到产生它的 processing attempt。** §4.4/§4.5 不再接收 attempt identity，而是按 message UID 解析当下唯一 running 行；`pa_one_running` 只保证“同一时刻一行”，不保证跨 retry 仍是同一行（实际 `0003-activations-processing-attempts.ts:11-23`）。最小反例是：runner 的 `uid#1` 已实际注入，但 marker 尚未提交，deliver deadline 先把 #1 结为 failed；同 generation 到点启动 `uid#2`；随后 #1 的迟到 proposal/failure 带相同 `messageUid + AgentIdentity` 到达，会被错误地解析并结算 #2。这样 v9 要求的 attempt-specific late-success-vs-failure CAS、失败次数和审计归因都失真。建议让 engine 发行不可混淆的 `AttemptHandle`/delivery context（至少含 attemptUid、messageUid、完整 identity），随 runner 注入 envelope 返回；公开 success/failure 入口可以接收该 handle，但事务内必须重新核对 handle 的全部字段、mailbox recipient 和 `outcome='running'`，不能让调用方只给一个未经绑定的裸 attemptUid。补“#1 timeout → #2 start → #1 late success/late failure 均拒且 #2 不动”的回归测试。

2. **[HIGH] `pa.injected` 与 deliver-timeout 失败仍不是线性化的互斥转换。** §5.4 的 watcher 先在读路径观察“无 marker”，再调用通用 `reportConversionFailure`；该失败事务不重查 marker 缺失。因而可发生“watcher 读无 marker → deliver 成功并提交 marker → watcher 仍把 attempt 结为 failed”。反向交错中 timeout 先结算，§5.3 的裸 `INSERT OR IGNORE` 又可给 terminal attempt 写 marker；`OR IGNORE` 还会把同 event_uid 的错误 kind/payload/cutover 冲突静默当成幂等。建议定义两个 tx-scoped phase transition：`recordInjectedTx` 必须核对 exact running attempt/identity 后，用 targeted `ON CONFLICT(event_uid)` 并 read-back 验证已有事件逐字段一致；`reportDeliveryTimeoutTx` 必须在同一 `Kernel.write` 内重查 `outcome='running' AND marker 不存在` 后再做 attempt/mailbox CAS。Lead 的 start/resume 也复用同一 marker helper。加入 marker-first/timeout-first 真双连接交错测试，并把 §5.4 的 crash window 改成真实顺序（外部注入后、deliver Promise 返回前；Promise 返回后、marker commit 前；marker commit 后）。此外在 §9 记录 batch 3 retention 约束：matching PA 仍 running 时不得只从 hot `events` 删除 marker，或 driver 必须走冷热统一 reader。满足这些条件后，使用 append-only `events(event_uid UNIQUE, created_at NOT NULL)` 作 durable anchor 是合理且不需要 schema change 的。

3. **[HIGH] terminal disposal 的 authority 只在调用开头检查一次，逐 attempt/逐消息事务仍可被 successor cutover 穿透。** `plan.md:339-348` 先跑一个前置事务，之后另开 crash-settlement 和每消息事务；successor 可在前置提交后注册、但在第一条 disposal CAS 前尚未 start。此时 mailbox 的 `to_agent` 仍是同一个 agent ID，所以 `to_agent=:oldAgent` 并不是 generation fence，陈旧 disposal 仍会 redirect/dead/tombstone 新 generation 应消费的消息。建议每一个 attempt settlement 和每一个 per-message disposal 事务都在 mutation 前同事务重验 registry exact `terminalIdentity`、runner activation terminal，以及 redirect target 当前可路由；一旦 successor 注册，后续 row 立即停止并报告 stale。删除“registry 已被显式清除也放行”，除非另有绑定 terminalIdentity 的 durable clear receipt，因为 null 已丢失处置权证明。T8 要把 successor commit 精确插在“一次性 precheck 与首个 mutation 之间”，证明零行被陈旧处置。

4. **[HIGH] coordinator 伪码与 runner durable-deliver 协议仍是两套互相冲突的执行模型。** §4.6 对所有 agent 无条件 `await converter(msg)` 并立即 success/failure settlement；§5.3 又要求 runner 走 `shim.deliver` 后异步等待会话调用公开 settlement。按当前文字，runner 要么错误调用 Lead converter，要么同时跑 converter 与 pump；若 pump 在 marker 后按 §5.3-7 重入，计划也没有规定 cadence/backoff，可能形成紧循环重复注入。建议把 coordinator 写成显式 kind 分支：Lead=`start(with marker) → converter → settle`；runner=`start/resume → 按 durable-deliver backoff 调 shim → guarded marker → 观察异步 terminal/继续设计要求的重投递`，绝不调用本地 converter，且重复 deliver 永远沿用同一个 AttemptHandle、不会重置 T_max anchor。明确异步 submit/failure 后如何 ring coordinator 处理下一条（或声明最多等下一 tick，并计入 SLA），并用 T5/T6 覆盖 runner 无 converter、marker 前后重投递节奏及无 busy loop。

5. **[HIGH] 新 registry authority 本身仍缺少 subject/activation 校验，且 resume 可复用 foreign attempt。** `writeRegistry` 只验证 JSON shape（`fence.ts:138-154`），不会证明 `consumer_registry:A` 内的 leadId/agentId 就是 A；§4.1 也没有落实 Round 1 已指出的 runner activation 必须存在、`state='active'`、generation 与新 identity 一致。首次注册时旧 registry 为 null 但库中已有 running PA 的分支也未定义；§4.3 对“同 message 的既有 running”直接 resume，未验证该 PA 的 instance/generation/activation 与当前 identity 相等。这些情况会建立指向错误/terminal activation 的 authority，或把新代 deliver 绑定到旧代账，随后 proposal 永久 fence 失败。建议 register 同事务校验 identity subject 与 `agent` 相等；runner 还需校验新 activation row active 且 generation 相等（若便捷 `register()` 无法满足原子换代，就限制 runner 只能由组合事务调用）。旧 registry 为 null 但存在任何该 recipient running row 应 fail-loud；start 的 resume 分支也必须 exact-owner match，否则拒绝。同步把 §4.1 的换代 owner 从含混的“1500/批次3”改成与既定 FLY-1498 gates/dispatch-model 及 batch 3 wiring 边界一致的明确责任人。

6. **[MEDIUM] `expectedCutoverEpoch` 仍是可选字段，旧 caller 可以通过省略它绕过 epoch fence。** §4.7 在缺省时读取当前 meta 并盖章，这保证了列非空，却没有验证 producer 观察到的 epoch；设计链要求 envelope 带 epoch 且 mismatch fail-closed。建议公开 enqueue envelope 将 `expectedCutoverEpoch` 改为必填，缺失与不匹配都拒绝；若确有 kernel 内部可信 producer 需要“使用当前值”，给它单独的非公开 tx helper，不能让外部入口以 omission 升权。T8 增加“字段缺失也拒绝”的断言。

7. **[MEDIUM] EngineConfig/clock 依赖没有贯穿实际写路径，当前签名无法实现计划声称的缩参 SLA 与统一退避。** `settleFailureMailboxTx(tx, agent, messageUid, clock)` 计算 retryBase/retryCap 却不接收 config；`registerConsumerTx/register/reportConversionFailure/disposeTerminalRecipient` 的签名也没有共享 runtime context，但它们都可能调用失败结算。若内部偷偷使用 default，T7 的缩参不会驱动真实调度；若临时加参数，§10 导出和调用合同又会漂移。建议定义并统一传递不可变 `EngineRuntime {config, clock}`（或逐个显式参数），tx helper 同样接收该 context。构造校验还应固定 `leadPullIntervalMs <= 30s`（或直接常量化），否则 Lead 丢 hint 后可能晚于设计的 30s pull，SLA 起始 `T_tick` 项不成立。TDD 顺序也应先实现共享 failure transition/runtime context，再做依赖它的 registration；当前 §12 的 T1 registration GREEN 早于 T4 settlement GREEN 是倒置的。

8. **[MEDIUM] 256KB 限制只统计 `payload`，尚不能支撑“外部输入有界、默认 1s tx budget 可验”的结论。** `commandKind/effectKey/taskKind/projectId/lineageRootTaskId/eventKind` 等字符串仍可任意大；32 个超大非-payload 字段依然能让 INSERT 超出预算，且这些 proposal 来自 vendor boundary。建议限制整个规范化 proposal 的 UTF-8 总字节数，并给 ID/kind/effectKey/projectId 等字段定义合理单字段上限与格式；所有校验/哈希仍在 `Kernel.write` 前完成。负向测试应至少包含“小 payload + 巨大 effectKey/projectId”的事务外拒绝，而不只测 payload 合计。

## Verdict

CHANGES REQUESTED — address items above
