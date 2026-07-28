# Design Review — FLY-1499 plan.md (Round 7)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 7 已正确关闭 sessionRef 双真相、deliver 前 authority gate、事务最终身份返回，以及独立 `register()` 残留等 Round 6 问题。当前还剩三个相互关联的生命周期矛盾：现有 map 规则会阻止合法 successor 接管，Lead 的启动恢复调用与“绝不重新 cutover”无法同时成立，且 T1 对 foreign in-flight 的零 map/timer 断言没有对应的 attach 前置校验。

## What's Good (Keep)

- `attachRunner` 不再接受 sessionRef；它从 `activations.session_ref` 派生 vendor 目标，并在挂接前核对 subject、current registry、activation active/generation，正确恢复了 durable single source of truth。
- runner 首投与每次重投现在都在外部 `shim.deliver` 前经过 `startAttempt` 的 active-consumer + resume exact-owner gate；授权失败发生在不可撤销外部注入之前，Round 6 的最高风险窗口已被正面修复。
- `LeadIdentityDraft` / `RunnerIdentityDraft` / `IdentityDraft` 不携带 generation，`registerConsumerTx` 返回 `RegisteredConsumer.identity`，使 generation 只由事务内 current registry 推导；这些类型也已进入 §10/T9。
- `registerLead` 已明确 commit 前零 coordinator/map 副作用，commit 后使用事务返回的最终身份建 coordinator；无崩溃单次调用与崩溃恢复语义也不再混称“全局 exactly-once”。
- 独立 `register()` 已从包结构、§4.1、§5.2、E25 和 runtime 白名单中清理；T9 还增加了明确的负断言。
- R1-R6 已闭合的 AttemptHandle 结算绑定、统一 active authority gate、两阶段 marker、timer 生命周期、disposal interleaving、公平性、INDEXED BY 统计矩阵和 v11 SLA 公式均未回退。
- 当前 HEAD 正是 `aadc2c5a`，工作树 `plan.md` 与提交内容逐字一致；该提交 `git diff --check` 通过。

## Issues & Recommendations

1. **[HIGH] “不同 identity 永不替换现有 coordinator”会阻止合法 successor 挂接，破坏换代后的活性。**  
   §4.1-200 先要求 incoming identity 恰等 durable current registry，这是正确的；但随后又规定，只要 driver map 已有不同 identity 就拒绝且绝不替换。真实换代恰好会产生这个状态：旧 runner coordinator 已在 map；批次3 原子事务把旧 activation 置 terminal 并把 registry 切到新 identity；计划只要求 activation terminal 时清 timer/停止重投，没有任何删除旧 map entry 的合同；此时合法 `attachRunner(newIdentity)` 虽通过 DB 校验，却因 map 中仍是 oldIdentity 被拒。旧 coordinator 的 `startAttempt` fence 会持续失败，新的推进者又进不来，tick/owner-route/SLA 全部失去承载者。迟到旧 attach 与新 attach 的交错也可能让最终 map 取决于进程调度，而不是 durable current identity。  
   **建议修复：**把 map 决策改为以 durable current identity 为唯一仲裁：incoming 不等 current → 拒且零变化；incoming 等 current 且 map 已是同 identity → 幂等 reconcile/no-op；incoming 等 current 且 map 是不同的 stale identity → 先 stop 旧 coordinator、清其 timer，再原子替换为 current coordinator。对同 agent 的 attach/map mutation 做 driver-local serialization，避免“旧 attach 已校验后暂停、新 attach 安装、旧 attach 再覆盖”的竞态。T1 增加双向矩阵：(a) old map + successor committed + attach new → new 必须接管；(b) new map 已安装 + late attach old → old 必须拒且 new 不动；并对 stop/timer cleanup/map identity/pull 做 mutation 验证。

2. **[HIGH] §9-7 的 Lead 启动恢复调用在现有 API 下不可执行。**  
   §9-7 要求枚举 current registry 后“幂等 `registerLead` 重挂”且“绝不重新 cutover”。但 §4.1 明确规定 `registerLead` 总是调用 `registerConsumerTx`；该 helper 看到已有 registry 时要求 DeathEvidence，并固定生成 `old.generation+1` 后写回 registry。`LeadIdentityDraft` 又刻意不携带 generation，因此 `registerLead` 不可能只重挂 current Lead identity：它要么因缺 evidence 拒绝，要么执行一次新的 cutover。当前文字同时要求互斥的两种行为，T1 的 commit→attach 恢复也无法据此写出诚实断言。  
   **建议修复：**选择一种明确语义。更贴合 §1.2c 的方案是：runner 的 committed-but-unattached 恢复走 `attachRunner`，不改 registry；Lead 进程崩溃后的恢复必须凭 DeathEvidence 调 `registerLead`，合法切到新 instance/generation，并由 T_switch 支付这次换代。若确实需要同一 current Lead identity 的非 cutover 重挂，则新增与 `attachRunner` 同形的 `attachLead(agent, currentIdentity, converter)`，exact-read registry 后只装 coordinator。无论选哪种，都把 §4.1-201、§9-7 和 T1 分成 Lead/runner 两条可执行路径，不能继续写“registerLead 重挂且绝不 cutover”。

3. **[MEDIUM] T1 对 foreign in-flight 的“零 timer/map 变化”不能由当前 `attachRunner` 顺序实现。**  
   §4.1-200 的 attach 前事务只检查 subject、registry 与 activation，不查询 `processing_attempts`。因此 registry/activation 都合法但存在 foreign running attempt 时，`attachRunner` 会先写 coordinator map并开始 post-commit 流程；直到 ring 后的 runner resume 调 `startAttempt`，exact-owner gate 才拒绝并保证零 shim 调用。T1 却把 foreign in-flight 与 attach-time 绑定失败放在同一矩阵，要求零 shim、零 timer、零 map 变化；后两项按已写顺序并不成立。  
   **建议修复：**若要保留 T1 的强断言，就在 attach 校验事务内同时查询该 agent 的 running attempt，并要求其 owner 三元组恰等 incoming identity，否则在 map mutation 前 fail-loud；这也与 `registerConsumerTx` 对 foreign running rows 的既有哲学一致。若不增加该检查，则应把 foreign in-flight 从 attach 绑定矩阵移到 T5，仅断言 pre-deliver gate 导致零 shim 调用，并明确失败后 coordinator/map/timer 如何清理，不能保留一个实现机制无法满足的验收。

## Verdict

CHANGES REQUESTED — address items above
