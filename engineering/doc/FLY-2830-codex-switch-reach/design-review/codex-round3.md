# Design Review — plan.md (Round 3)
Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

按最终轮约定，本轮只复核 Round 2 的四项意见及本轮编辑引入的回归。W1 的 runtime 默认探针回归、§6.3 的 best-effort 时间契约、W8 的 nullable 恢复时间都已解决；W5 也已修正“部分失败却标记 swept”的核心语义。但新加的三次尝试上限缺少“当前待处理 requestId”的持久身份，现有三个 state 字段无法同时实现同一请求续计数、新请求归零和重启续跑。因此仍有一个实现阻断项。

## What's Good (Keep)

- W1 现在从公共入口覆盖真实软链 socket、真实 pgid ledger、默认 holder probe 及普通文件负例，不依赖导出私有 helper；这正面覆盖了 Round 2 指出的 runtime 接线缺口（§2:45–50）。
- W5 将请求轮明确为“在用号 + 全部应读候选号”，并把 `recordObservation === "updated"` 作为成功条件；持久化 `unavailable` 才是终态排除，第三轮失败使用独立的 `partial` outcome，不再伪装成 `swept`（§6.2:140–154）。
- §6.3 已删除不可兑现的 75 秒硬 deadline，把两分钟目标限定在 wake、接口和锁均正常的前提下；QA 同时要求日志与逐号时间戳，契约和验收口径一致（§6.3:157–166，§11:247）。
- W8 已能表达 null reset、`reached=true` 但没有 100% 窗口，以及全舰队最早恢复不可判定；生产与消费边界都有上限和重验，且明确禁止用 `nextAttemptAt` 代替恢复时间（§9:198–230）。
- Round 2 的 advisory 已正确传播到键数、回滚顺序、快照校验和 `wake=` 日志契约；除下述状态身份问题外，没有发现这些编辑引入的新回归。

## Issues & Recommendations (numbered: issue, why, fix)

1. **`sweepRequestAttempts` 没有关联待处理的 requestId，三次上限无法按计划可靠实现。**

   **Why:** 计划只持久化“最后已 ack 的” `lastSweepRequestId`、outcome 和一个裸计数（§6.2:136–155）。请求 A 首轮失败后不 ack，所以后续每轮仍满足 `A.requestId !== lastSweepRequestId`；这与文件被新请求 B 覆盖时的状态完全相同。若每次满足该条件都按“新请求”把 attempts 归零，A 永远到不了第三轮；若不归零，B 会继承 A 的尝试次数并可能过早被标记 `partial`。守护进程重启也无法仅凭这三个字段判断计数属于哪个请求，因此 §6.4 的“重启后 attempts 延续”测试不能闭合。这个缺口是本轮新增三次上限直接引入的，会破坏其防刷新风暴目的。

   **Fix:** 把计数与 pending request 身份一起持久化。最直接的是增加 `pendingSweepRequestId: string | null`（或把 attempts 改成 `{requestId, count}`）：已 ack 的 ID 直接跳过；读到与 pending 不同的新 ID 时设置 pending 并归零；只有该 pending 请求实际完成失败轮才增计数；`swept`、第三轮 `partial` 或 `blocked_monitor_only` ack 后写 last 字段并清空 pending/计数。同步更新 V2 白名单/default/parser、§10 的新增键数与回滚删除列表。补一个关键测试：A 已失败两轮后请求文件被 B 覆盖，B 从第 1 轮计数；同时保留“同一 A 跨重启从原次数继续”的测试。另一可行方案是把 `lastSweepRequestId` 重定义为“当前/最后看见的 ID”，用 `outcome=null` 表示 pending，但必须相应重写 §6.2 的触发条件和 ack 状态机，不能保留当前 `req.requestId !== lastSweepRequestId` 规则。

## Advisory

无。本轮边界内其余三项及 W5 的逐号完成判定均可保留。

## Verdict

CHANGES REQUESTED

Round 2 的第 1、3、4 项已解决；第 2 项的完成判定已解决，但其新增三次重试策略缺少 request-scoped 的持久计数身份。补齐该状态关联及覆盖/重启测试后，本轮所审范围即可通过。
