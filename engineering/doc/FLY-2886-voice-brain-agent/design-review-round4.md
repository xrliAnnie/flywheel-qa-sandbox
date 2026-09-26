# Design Review — plan.md (Round 4)
Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮仅核验 R3 第 1–4 项及 v4 新增阻塞，不重开已关闭事项或固定决策。R3 第 3、4 项已在设计层面关闭；第 2 项的取消、幂等、崩溃和重启规则已补齐，但新回滚规则引入绕过存量锁的问题；第 1 项的解锁证据仍不足。因此保留 2 项阻塞。

基线：HEAD `7e345cc0408bf825150117f029b6df4ef786e96c`；v4 plan SHA-256 `d6539bee68fb1c7b65a8afb9527982ca0046cab68a2f3adba5886661b5bd84dd`。已核对 v3→v4 差异、R3 报告及相关生产调用链；这一提交范围仅变更文档。结论来自静态阅读，未运行订阅实验、真实写入或仓库测试。

下文 `P` = `engineering/doc/FLY-2886-voice-brain-agent/plan.md`，`T` = `packages/teamlead/src`，`V` = `packages/voice-codex/src`。

| R3 项 | 关闭判定 | v4 证据 |
|---|---|---|
| 1 unknown 双方阻断 | **未关闭** | P:111–114 已取消常驻直接放行和 TTL 解锁，但“连接中止即解锁”仍不证明远端写结束，见本轮 1 |
| 2 锁生命周期 | **部分关闭** | P:115–121 已补幂等、派发标记、匹配释放、等待期限/清理和重启；P:108、292、310 补齐两表与迁移声明。P:122–123 的新回滚绕过仍阻塞，见本轮 2 |
| 3 迟到写请求诱导重做 | **关闭** | P:59–60 区分已有写/unknown 回执，优先播已有结果，重复请求携带原义务及账本，并要求不产生第二次写 |
| 4 静音帧刷新兜底计时 | **关闭** | P:231 明确补静音前的原始接收入口、本地段结束条件、旧 provider 段清理及静音 tick 持续的用例；入口与 V/pipeline/Uplink.ts:117–135 相符 |

## What's Good (Keep)

- unknown 对双方返回 `target_pending_reconcile`，正常超时不再直接放行常驻写；禁止按 TTL 释放已派发操作。
- waiter 独立记录、绑定操作剩余期限、finally 清理及 Bridge 兜底清理，解决 R3 指出的过期排队标记。
- release 校验 holder/request/fence，区分已/未派发的崩溃恢复；两张表均纳入 retention。
- 迟到交办携带操作账本、地板使用原始输入计时，两条 R3 建议已落实到明确规则与测试。

## Issues & Recommendations

1. **[blocking] [HIGH] 连接中止或 promise 落定仍被当作远端操作终态，R3#1 尚未闭合。**

   **问题与证据：** P:112 明确把“HTTP 响应或连接中止”均作为 promise 真正落定，并规定落定即写终态回执、解锁。现有 T/lead-capabilities/handlers/bridge-read.ts:265–277 在 abort 时会让等待 promise 返回 `status:unknown`；T/lead-capabilities/broker.ts:350–375 同样把派发后的超时/中止记为 unknown。T/lead-capabilities/handlers/linear.ts:297–299 只在发出更新前检查取消，已经提交的远端请求不受 Bridge 锁 fence 约束。保留 promise 有助于收集迟到结果，但 promise 的 rejection 或一个 unknown 响应都不是副作用已停止的证明。

   **为何重要：** “语音请求已被远端接收 → 连接中止、promise 结束 → 按 P:112 解锁 → 常驻写完成 → 原语音写才落地”的交错仍然成立。P:113 仅读取目标当前状态也不能证明旧请求将来不会提交：此刻看不到更新可能只是尚未执行。由常驻 Lead 发起对账能证明操作者身份，不能替代操作终态证据。

   **建议：** 把释放条件写成“取得与原请求关联的可信终态证据”，明确区分成功、确定未执行/已取消，以及仍然 unknown。网络中止、超时、含糊的错误响应、目标当前未变化均继续保留 unknown；保留原 promise 后也必须按结果类别处理，不能在 finally 中无条件解锁。对账清锁必须证明旧请求已经完成或不能再执行；缺少该证据时保持待对账。补“连接中止但远端随后提交”和“对账读到旧值后原请求才提交”的负向用例。无需新增业务 agent 或重审锁架构，只需修正解除条件。

2. **[blocking] [HIGH] 关闭开关后常驻跳过 acquire，使保留的 held/unknown 锁失去作用。（v4 新增阻塞，关联 R3#2）**

   **问题与证据：** P:122–123 新规定常驻仅在 `voiceBackground.enabled` 时调用锁，关开关后不再 acquire；同段又保留 held/unknown 行等待释放或对账。P:86 的关场动作会关闭 providers 并把在途 dispatched 回执标为 unknown，这本身并不证明远端写已结束；现有代码也没有已派发 Linear 写的远端取消保证（T/lead-capabilities/handlers/linear.ts:297–299）。

   **为何重要：** “语音写已派发 → 关开关，存量锁仍 held/unknown → 常驻因开关关闭直接写 → 旧语音写晚到”会绕过 P:111 的双方阻断。保留数据库行和发送 Lead 提醒不能阻止常驻副作用，回滚反而重新引入 R3#1 的覆盖窗口。

   **建议：** 开关关闭应立即停止新的语音工作，但对存量未终结目标继续执行锁检查/待对账约束，直到它们可靠结束。可让曾启用的 Lead 在存量锁清空前处于收尾状态，或让常驻在关闭档仍拒绝命中持有/unknown 目标的写；从未启用且无存量锁的 Lead 保持原路径。同步 §4.3/§11，补“已派发或 unknown → 关开关 → 常驻同目标写 → 旧请求晚完成”的测试，确认未对账前不会绕过保护。

**advisory / follow-up：** 无新增非阻塞事项。

## Verdict

CHANGES REQUESTED

R3 第 3、4 项关闭；第 2 项生命周期主体已补齐，但回滚新规则需修正；第 1 项仍需区分本地调用结束与远端操作终态。本轮只保留上述两项阻塞，未重开其他事项。仅写本 Round 4 反馈文件，未修改仓库文件。

