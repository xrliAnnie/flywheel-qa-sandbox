# Design Review — FLY-1499 plan.md (Round 6)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 6 已完整关闭 R5-2 与 R5-3，并把 R5-1 从无 owner 的纯函数推进到了可持有 `Kernel`/runtime/coordinator 的 `EngineDriver` 方法，方向正确。剩余阻断点集中在新 runner 挂接边界：`attachRunner` 尚未把 registry identity、activation 和 `session_ref` 绑定起来，runner resume 路径又会在重新验证 authority 之前调用外部 `deliver`；此外注册方法的最终身份/崩溃重放合同和文档中的旧 `register()` 决策仍未收口。

## What's Good (Keep)

- `EngineDriver.registerLead` / `attachRunner` 解决了 Round 5 指出的 owner 引用缺失；独立 `register()` 已从 §10 runtime 白名单移除，tx-scoped `registerConsumerTx` 仍是唯一 registry cutover 原语，runner 原子换代边界没有被绕开。
- `CancelTimer = () => void` 是干净的平台无关合同；`EngineScheduler`/`CancelTimer` 已进入 type-only 白名单和 T9，E20 与测试 footer 也统一为 clock + scheduler 全注入。
- T8 已逐字纳入 disposal 两阶段之间的 stale-start 双连接反例，并要求 active-consumer gate 的删除/降级 mutation 使断言转红；T4/T6/T8 的矩阵分工也已明确。
- `requireActiveConsumerTx`、AttemptHandle 全字段结算绑定、marker/timeout 线性化、marker 时间锚、terminal disposal 重验、runner marker 后 durable redelivery、公平性与 v11 SLA 公式均未回退。
- `pa.injected` 继续使用 append-only `events` 行作为 durable phase anchor，与现有字段、UNIQUE(event_uid) 和 FK nullable 约束一致；当前选择仍然合理。
- 评审对象就是当前 HEAD `1748bbe5`，工作树中的 `plan.md` 与该提交逐字一致；该提交 `git diff --check` 通过。

## Issues & Recommendations

1. **[HIGH] `attachRunner` 没有把公开参数绑定到 durable runner authority，且 resume 分支会在重新 fence 前产生不可撤销的外部注入。**  
   §4.1 只声明 `EngineDriver.attachRunner(agent, identity, shim, sessionRef)` 在 cutover 后挂 coordinator、且“不碰 registry”，没有要求当前 `consumer_registry:agent` 恰等 `identity`，也没有要求 activation 行的 id/generation/state/**session_ref** 与参数一致。实际迁移中 `activations.session_ref` 是 `NOT NULL`，并有 active-session 唯一索引（`packages/v2-kernel/src/migrations/0003-activations-processing-attempts.ts:1-9`）；而 `AgentIdentity` 只含 activationId，不含 sessionRef（`packages/v2-kernel/src/fence.ts:3-16`），所以这个绑定不能靠类型自动成立。更危险的是 §4.6 runner 分支读到任意 in-flight 后直接 `shim.deliver(sessionRef, ...)`，没有像 Lead 分支那样先走 `startAttempt` 的 exact-owner/active-consumer 校验；迟到的 `attachRunner`、错误 sessionRef 或被旧调用覆盖的 coordinator 因而可以先把 payload 注入错误 vendor session，之后 `recordInjectedTx` 即使 fence 失败也无法撤销该外部副作用。每 agent 恰一 coordinator 的 map 若被 stale attach 覆盖，还会让正确世代失去推进者。  
   **建议修复：**让 `attachRunner` 在写入 driver coordinator registry 和触发任何 pull/timer 前 fail-closed 校验：agent subject、registry exact identity、activation id/generation/state='active'、activation.session_ref；最好从 activation 行派生 sessionRef，而不是接受第二份可漂移真相。相同 identity 的重复 attach 定义为幂等，不同/较旧 identity 一律拒且不得替换现有 coordinator。runner 的 in-flight/resume 路径也必须在每次外部 `deliver` 前经过 `startAttempt(...messageUid)` 的 resume exact-owner gate，或等价的专用 authority/owner 校验，不能只靠 deliver 后的 marker 事务。T1/T5 增加 stale identity、wrong activation、terminal activation、wrong sessionRef、successor 后迟到 attach、foreign in-flight 的矩阵，逐项断言零 shim 调用、零 timer/map 变化；移除绑定时测试必须转红。

2. **[MEDIUM] 注册 API 还没有钉死“事务生成的最终身份”和 post-commit 崩溃重放，因而所谓签名闭环仍不完整。**  
   `registerConsumerTx` 在 §4.1-5 内根据旧 registry 计算 `generation=(old?.generation ?? 0)+1`，但计划没有声明 `identityDraft` 的精确类型、helper 的返回类型或 `RegisteredConsumer` 的结构；后者虽列在 §10 type-only exports，却在全文没有定义。与此同时，`registerLead` 的顺序写成“先建 Lead coordinator，再执行 transaction”，没有说明 coordinator 如何获得事务内才确定的最终 identity，也没有说明失败 transaction 后该预建对象是否已进入 per-agent map。另一个不可避免的窗口是 registry commit 已成功、但进程在 coordinator attach/ring/timer install 前崩溃；当前 T1 只覆盖 rollback，不覆盖这个 committed-without-post-commit-actions 状态，tick 也只枚举“本进程已注册”的消费者，无法自行发现尚未 attach 的 runner。  
   **建议修复：**定义 lead/runner draft 类型与 `RegisteredConsumer`，让 `registerConsumerTx` 明确返回最终 canonical identity；`registerLead` 先完成所有可能失败的输入校验，commit 后用返回身份构造/安装 coordinator，再 ring/重建 timer，commit 前不得写 driver map。把“恰一次”限定为无进程崩溃的单次调用，并给 batch 3 写死启动恢复合同：枚举已提交的 current registry + active activation，幂等调用 `attachRunner`，不再次 cutover。T1 增加 commit→attach、attach→ring/timer 两个 crash 点及重放，断言最终恰一 current coordinator、registry 不被 attach 改写、必拉/timer 至少一次且无 stale timer。

3. **[MEDIUM] 已删除的 `register()` 仍在实施结构和决策记录中，直接冲突于新的导出合同。**  
   §1 的 `registration.ts` 注释仍列 `register()/registerConsumerTx()`；§4.1 开头仍说 helper “供本包 register()”；§5.2 仍写“register 返回后”；E25 仍裁决“register() 便捷入口仅 lead”。这些不是单纯措辞，其中 E25 与 §4.1-195、§10、E32 的“独立 register() 删除”是互斥决策，实施者可能据此重新引入一个 T9 本应拒绝的 runtime export。  
   **建议修复：**全篇清理或改写旧入口：registration.ts 只含 `registerConsumerTx`，Lead 注册归 `driver.ts/registerLead`，§5.2 改为 `registerLead/attachRunner` post-commit pull；E25 改成“runner registry cutover 只经 composed transaction，driver 仅 attach”，或标记被 E32 supersede。T9 明确增加负断言：runtime export 中不存在独立 `register`。

## Verdict

CHANGES REQUESTED — address items above
