# Design Review — plan.md (Round 4)
Date: 2026-09-08
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮严格只复核 Engineering Lead 限定的四项。v4 已解决实现计划中的 state-root 语义、C1/C5/C6 合同传播和 §6.2 QA 矛盾；`research.md` 的 probe、receipt 四态、SQL 安全合同及 Lead 裁定正文也已同步。不过，`research.md` 仍有两处旧表述与 v4 合同直接冲突，因此 Round 3 的 research 同步项尚未完全关闭。

## What's Good (Keep)

- state-root 现在在 shell 与 TypeScript 两侧定义为同一套 trim/default 语义，并用五组输入做跨语言逐字路径断言；计划明确禁止 shell 退回 `${VAR:-default}`。`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:34`, `engineering/doc/FLY-2134-monitor-the-monitors/plan.md:175`
- C1 已列全三个 source 前置锁全局；C5 直接引用 §2 的完整 W-4 谓词；C6 函数签名已去掉 grace 参数；文件清单也改成 W-4 四态。`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:124`, `engineering/doc/FLY-2134-monitor-the-monitors/plan.md:133`, `engineering/doc/FLY-2134-monitor-the-monitors/plan.md:149`, `engineering/doc/FLY-2134-monitor-the-monitors/plan.md:153`
- research 的 schema-aware `not_started`、四态 reader 测试和固定 SQL 模板合同已经与 v4 对齐。`engineering/doc/FLY-2134-monitor-the-monitors/research.md:101`, `engineering/doc/FLY-2134-monitor-the-monitors/research.md:113`, `engineering/doc/FLY-2134-monitor-the-monitors/research.md:129-130`
- §6.2 现在明确区分 `_af_post` seam 调用与真实网络调用：失败路径要求恰好三次 `_af_post`、零次网络、`post_status=failed` 和 `run_status=degraded`；`none` 仅允许零 action。`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:192`

## Issues & Recommendations

1. **MEDIUM — `research.md` 仍保留两处已失效的权威表述，Round 3 #3 尚未完全解决。**

   - **Issue:** 状态目录行仍写 `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}`，这不会 trim，也会把纯空白当成有效路径；它与 plan v4 的统一语义相反。另一个标题仍写“Lead 未答按此”，但紧接着的正文已经记录 Lead 于 2026-09-08 完成四项裁定。
   - **Why:** `plan.md` 明示基于 `research.md`，而 research 的事实表和治理状态标题仍给实现者两个错误信号。五输入测试行不能消除前面状态目录合同本身的冲突。
   - **Suggested fix:** 将 research 的状态目录行改为与 plan §2 相同的“trim 后为空则默认，否则用 trimmed value”合同（或明确引用 plan §2）；将 §10 标题改为“Lead 裁定与剩余假设”等不再声称未答的名称。无需改变其他设计。
   - **Evidence:** `engineering/doc/FLY-2134-monitor-the-monitors/research.md:85`, `engineering/doc/FLY-2134-monitor-the-monitors/research.md:136-138`; 对照 `engineering/doc/FLY-2134-monitor-the-monitors/plan.md:18`, `engineering/doc/FLY-2134-monitor-the-monitors/plan.md:34`。

## Verdict

CHANGES REQUESTED — address item above
