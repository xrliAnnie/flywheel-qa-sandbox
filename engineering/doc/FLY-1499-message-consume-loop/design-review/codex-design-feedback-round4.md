# Design Review — FLY-1499 plan.md (Round 4)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 对七项 Round 3 finding 的主体修复是有效的：phase deadline、runner terminal admission、marker 后 durable redelivery、runner 注册入口收口、canonical marker、真实写锁交错和 transition 导出面都已进入明确合同。当前仍有两个协议级阻断项：runner activation terminal 尚未成为所有消费写路径的提交时 fence，以及“跨进程 ring 全丢仍满足 v11 公式”的验收与强制 owner-route 合同互相冲突；另有三个实现/验收边界需要收紧。本轮审查对象就是当前 HEAD `d7111b7845f7`，工作树干净；仓库未安装 `node_modules`，因此本轮只做了文档、源码、schema 和静态 diff 核验，没有虚报测试结果。

## What's Good (Keep)

- Round 3 的 durable-deliver 偏离已纠正：runner 在 marker 后继续按同一 AttemptHandle 退避重投，直到 mailbox 或 activation terminal；marker 只结束 deliver phase 并锚定 T_max，符合 `design-v8.md:22-24`。
- runner 的 fairness 状态现在只在新 attempt 成功 start 时更新一次，resume/redelivery 不重复计数；T5/T10 也补上了 Lead/runner 选择序列和 marker 后重投合同。
- enqueue 对 runner activation 做同事务 `state='active'` 校验，配合 terminal 后逐行 disposal，正确关闭了 Round 3 的“死信箱继续进水”问题。
- `register()` 已限为 Lead，runner 只能走供批次 3 组合的 `registerConsumerTx`；低层 transition helpers 也已从根导出面移除，符合 root-only、最小公开面原则。
- marker/timeout 的非对称 loser 语义现在与真实 `BEGIN IMMEDIATE` 线性化一致；successor/disposal 交错也改成了第二 writer 等待或 `SQLITE_BUSY` 的真实模型，与 `kernel.ts:291-309` 和批次 1 QA 一致。
- 继续用 `events` 作为 `pa.injected` durable anchor 是可行的：实际 schema 有 `event_uid UNIQUE`、持久 `created_at` 和 append-only UPDATE trigger（`0001-base-schema.ts:55-69`），完整 source/epoch read-back 与 running-attempt retention 约束避免了新增 schema。本报告第 3 项只要求收紧时间值校验，不否定这个选型。
- CANDIDATE_SQL 的修订文本与现有七索引谓词相容；INDEXED BY 在索引缺失或 partial predicate 漂移时 fail-loud，带 STAT4 矩阵、free-query 阳性对照和精确 diff 合同仍然合理。
- 新 FENCE 五成员与实际 mailbox 列/state 完全相容，且保持既有四成员逐字不动；proposal 大小上限、32-effect 上限和逐消息 disposal 仍能遵守默认 1000ms 同步事务预算。

## Issues & Recommendations

1. **[HIGH] runner activation terminal 还不是 start/settlement/phase transition 的提交时 authority fence。** enqueue 已在 `plan.md:312` 检查 activation active，但 `startAttempt` 只做 registry identity（`plan.md:240-249`），success/failure 只做 registry + attempt/mailbox 绑定（`plan.md:251-269`），`recordInjectedTx`/delivery-timeout 也只看 attempt outcome/marker（`plan.md:336-339`）。实际 `requireIdentity` 只比较 meta registry（`kernel.ts:247-252`），不会读取独立的 activation state；而 disposal 又刻意要求 registry 继续等于 terminalIdentity（`plan.md:353-368`）。因此 activation terminal 提交后、disposal 完成前，迟到 runner proposal 仍可成功落 effects/applied；更糟的是 stale coordinator 可在两个 disposal row transaction 之间 start 新 running attempt，直接破坏“先收账后处置、零 running 尾巴”。建议新增包内统一的 active-consumer authority helper：同事务 `requireIdentity`，runner 再校验 activation id/generation 且 `state='active'`；用于 start、success、explicit failure、recordInjected、delivery-timeout 以及任何 runner 发起 mutation。terminal disposal 使用独立的 terminal-authority helper。双连接测试应覆盖 terminal commit 先于各入口时全部拒绝且零 mutation，以及 terminal writer 被既有消费事务阻塞时只允许 terminal commit 前的旧事务完成；特别增加 terminal commit 后、attempt settlement 与 message disposal 之间的 stale start 反例。

2. **[HIGH] §9-6 的“owner 进程内必 ring”与 T7 的“全部跨进程 ring 丢失仍满足 v11 公式”是两个互斥的故障合同。** `plan.md:304,406` 正确要求 proposal 路由到 owning EngineDriver 并在 settlement commit 后立即推进；但 `plan.md:426` 又故意丢掉所有 ring，只靠 tick fallback，同时仍要求满足原样 v11 公式。该公式只有一个初始 `T_tick`，以及目标 retry 的 `(R−1)×T_tick`，没有为每个 successful slot 的 handoff 另付 tick。一个合法缩参反例是 `q=1,R=1,K=4,tTick=60s,tSwitch=1ms`：A=6，五次 slot 间 ring 丢失可多出近 5×60s，而公式每槽只有 1ms switch 预算。T_max callback 丢失后“下一 tick 再发”也必须明确算入从 deadline 开始的 T_switch，而不能在 T_switch 之外再加一个未预算 tick。这里也需要说明：Round 3 的建议同时写了“强制 owner route”和“所有 ring 丢失测试”，本身混合了两种替代方案；v4 不应继续同时承诺。建议二选一：(a) owner-route/ring 是 SLA 前提，owner handler 在本地 settlement 返回后同步 ring，T7 改测错误进程不可直接提交、删除 ring 会致红，并明确进程崩溃的 SLA 假设；同时规定 deadline→T_max lifecycle request（含重试）整体受 T_switch 约束；或 (b) 正式修订设计公式，为每槽丢失 handoff/回调增加 tick。不能保留当前文字并宣称 v11 原公式已证明。

3. **[MEDIUM] marker collision 对唯一 T_max 时间锚只做“格式合法”仍不够 fail-closed。** `plan.md:336-337` 对 kind/payload/source/epoch 做等值核对，但 existing `created_at` 只验格式；实际 events schema 对 created_at 没有 CHECK。预置一个其他字段全对、`created_at='2099-01-01T00:00:00.000Z'` 的同 event_uid 行会被当作幂等成功，并把 T_max 推迟数十年。建议在一次 txNow 快照下验证 canonical ISO 且 `attempt.started_at <= marker.created_at <= txNow`（若允许时钟回拨，明确有限 skew policy），并明确 `task_id`/`attempt_id` 对该内部 marker 的预期值。T6 collision matrix 增加 malformed、早于 started_at、晚于 now 三类时间锚，以及 source_kind/source_id 分别错误的反例；每类都断言整个 recordInjectedTx 零残留。

4. **[MEDIUM] 注册必拉的 post-commit 边界仍含混，按当前步骤直译会撞 Kernel 非重入/同步事务合同。** `registerConsumerTx` 在批次 3 的外层 `Kernel.write` 回调中返回时，事务尚未 commit；`plan.md:202` 却笼统写“调用方在 register 返回后必拉”，而 `register()` 的签名本身也没有 EngineDriver/coordinator。若在 tx callback 内 pull，会嵌套 write 或启动 async 工作并违反 `kernel.ts:273-309`；若只靠调用方口头纪律，又无法证明注册必拉。建议写死：tx helper 绝不 ring/pull；Lead wrapper 以及批次 3 runner composer 都必须等最外层 `Kernel.write` 成功返回后，再由 owning EngineDriver 同步 ring 并安装 phase timers。T1/T5 增加“commit 前零 candidate read/deliver，commit 返回后立即一次 pull”；outer transaction 回滚时不得产生 post-commit action。

5. **[MEDIUM] 新增的 phase timer 还缺可实现、可测的生命周期合同，且决策日志仍自相矛盾。** `EngineRuntime` 只有 config/clock（`plan.md:133-135`），§5.1 却直接依赖全局 `setTimeout`，§11 又声称“时间全走注入 clock”；计划也没规定 marker/terminal/settlement/driver stop 时如何 cancel/replace timer。若不取消，快速成功的历史 attempt 会在 10 分钟窗口内积累大量 stale T_max timers，“每收件人至多一个 timer”的成本论证不成立；early/stale callback 也需要重新核验并按剩余时间 re-arm/no-op。建议把 scheduler（set/clear timeout）纳入可注入 runtime，或明确统一的 fake-timer 合同；EngineDriver 维护 per-agent+attempt+phase timer registry，marker 时取消 deliver timer，attempt terminal/activation terminal/driver stop 时清理全部，callback 总是按 AttemptHandle 和 durable deadline 重验。T6 覆盖 replace/cancel、stale callback、restart rebuild 和 stop 无遗留 timer。最后把 `plan.md:468` 的 E10 从“tick 为唯一活性机制”改成“mailbox retry-due 不设精确 fast-path；phase deadline 例外见 E22”，并同步收窄 §13 的同类措辞。

## Verdict

CHANGES REQUESTED — address items above
