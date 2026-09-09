# Design Review — plan.md (Round 3)
Date: 2026-09-08
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 的两个 BLOCKER 已经实质闭合：v3 给 W-4 定义了完整字段/组合谓词并要求 TS 与 jq 等价，receipt reader 也覆盖全部必需字段、时间 round-trip 和 `run_status` 派生不变量。schema 3 的 `not_started`、Phase A consumer 证明、双 episode 失败转移、writer-lock source guard 和 sink preflight 的总体设计也都正确。

本轮没有新的 BLOCKER，但还不能批准：shell/TS 的 state-root 解析仍不是同一合同，纯空白或带边缘空白的 `FLYWHEEL_STATE_DIR` 会让 watcher 写到一个目录而 Bridge 读另一个目录；此外，几处已经修正的规范没有传播到对应 implementation chunk 和 upstream research，QA 句子也仍自相矛盾。这些都是小范围文档修正，不需要改变已定架构。

## What's Good (Keep)

- 保留完整 W-4 谓词及组合约束。`not_started|invalid => unknown/null` 与 `fresh|stale => ok|degraded + UTC last_run_at` 消除了“键在但 observation 不成立”的绿灯假象。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:40-41`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:148-154`。
- 保留 receipt 的逐字段校验与派生值重算。`run_id`、safe integers、五键 counts、日历 round-trip、future skew 和 `run_status` 一致性现在都有明确拒绝合同。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:99-105`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:150`。
- 保留 schema-aware `not_started`：Phase A/schema 2 静默并人工验收，Phase B/schema 3 立即进入既有 degraded hysteresis，不再把外部 watcher 的宽限绑定到 Bridge uptime。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:41`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:153-154`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:201`。
- 保留 Phase A 的部署正/负对照和 exact artifact evidence。合成 schema 3 正例必须通过、删 W-4 必须失败，再用 checkout HEAD、脚本 hash、mtime 与后续 probe receipt 证明 live consumer 已跨过部署边界，足以作为 C8 硬门槛。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:90-97`。
- 保留双账语义不变量和失败转移。尤其 unobservable enter 失败仍持久化 streak、recover 失败完整保留 episode，避免投递失败重新变成静默。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:57-74`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:140-142`。
- 保留 sink preflight 前置。已有坏 header 或 symlink 在任何 artifact probe、外部 post、状态推进之前 fail-closed，剩余 §2.3 窗口都是运行中真实 IO/crash 窗口。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:76-88`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:170`。

## Issues & Recommendations

1. **HIGH — shell 与 TS 的 state-root 解析仍不等价，会让 producer/consumer 分叉。**

   **Issue:** watcher 侧仍定义为 `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}`，只把 unset/空串视为默认值；Bridge helper 定义为 `env.FLYWHEEL_STATE_DIR?.trim() || default`，会先去掉前后空白，并把纯空白视为默认值。计划却同时声称“空/空白回退”和两侧路径逐输入相等。仓内现有 plugin 也确实采用 `.trim() ||`。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:34`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:149-150`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:175`、`packages/teamlead/src/bridge/plugin.ts:5294-5301`。

   **Why:** [verified by executing] `FLYWHEEL_STATE_DIR='   '` 时，计划中的 shell 表达式得到三个空格，而 TS 表达式得到 `/Users/xiaorongli/.flywheel`；`' /tmp/x '` 也会分别保留与移除边缘空白。watcher 因而可能成功写 receipt，但 Bridge 永远在另一路径返回 `not_started`。这不是测试风格差异，而是跨语言生产合同不一致。

   **Suggested fix:** 选择一个语义并两侧严格实现。若保持仓内 TS 约定，shell 先用纯 Bash helper trim `FLYWHEEL_STATE_DIR`，trim 后为空才回退，非空则使用 trim 后值；不要继续把 `${VAR:-default}` 写成等价表达式。把跨语言测试明确落到 C3/C5：unset、空串、纯空白、带前后空白的绝对路径、普通绝对路径五组输入，两侧输出必须逐字相等。

2. **MEDIUM — v3 的总合同已修好，但 C1/C5/C6 implementation bullets 仍保留旧指令。**

   **Issue:** 总表要求同时拒绝 PID 与 writer lock，但 C1 实现行仍只检查 `LM_PID_LOCK_PATH`；完整 W-4 谓词要求 `effective_enabled===true`、class/switch/path/time与组合约束，但 C5 实现行仍只列 partial fields 且只要求 `effective_enabled` 是 boolean；文件清单还称 W-4 “三态”；W-4 已无 boot-grace 参数，C6 函数签名却仍是 `<grace_sec> <body>`。测试段虽然覆盖了正确合同，implementation 段与之冲突。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:24`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:36-41`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:124`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:131-134`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:148-154`。

   **Why:** Chunks 是实施者直接执行的规范。按 C5 文字实现会接受 `effective_enabled=false` 和缺少 class/switch/path 的 W-4；按测试实现才会拒绝。writer-lock 测试同样会要求 C1 未写出的 guard。无用的 grace 参数则会继续暗示一个已删除的生命周期概念。

   **Suggested fix:** 将 C1 source 前置逐字同步为三个 lock global；C5 直接引用“§2 完整谓词”而不再重复 partial list，并把“三态”改为四态；将 reason 签名简化为 `w4_freshness_unhealthy_reason <body>`。保留现有逐字段负测，不改变设计。

3. **MEDIUM — `research.md` §6–§8 尚未真正同步，且 §9 仍恢复了已否决的 raw-SQL 合同。**

   **Issue:** research 的 probe 行仍要求 `not_started && Bridge uptime > 10800s`，与 v3 的 schema 2 静默/schema 3 立即 unhealthy 相反；测试表仍写“坏 receipt ⇒ not_started”与“W-4 三态”；安全章节仍写“SQL 以 select 开头、禁分号”，这是 Round 1 已证明不能防 `writefile/load_extension` 的旧方案。research 的未决章节也仍称 Lead 未答，而 plan 已记录四项裁定。证据：`engineering/doc/FLY-2134-monitor-the-monitors/research.md:94-101`、`engineering/doc/FLY-2134-monitor-the-monitors/research.md:106-116`、`engineering/doc/FLY-2134-monitor-the-monitors/research.md:127-138`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:18`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:30-31`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:41`、`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:99-105`。

   **Why:** plan 明确标注“基于 research.md”；upstream 仍给出相反的告警、测试和安全规则，会让实现/后续维护重新引入本轮刚关闭的缺口。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:4`。

   **Suggested fix:** 把 research §6 的 probe 行改成 schema-aware `not_started`，§7 reader 测试改成 missing=`not_started`、present-invalid=`invalid` 并称四态，§9 改成固定 `<path>::<table>::<column>` + identifier + script-built SQL；§10 记录 Lead 已裁定。无需扩写，直接引用 plan §2/§2.5 可减少再次漂移。

4. **MEDIUM — §6.2 仍同时要求 `_af_post` 零调用和恰好三次调用。**

   **Issue:** QA 句首的旧 parenthetical 仍写“unset 三元组后断言发帖 seam 零调用、零网络”，同一行后半又正确要求 unset credentials 时 `_af_post` 恰调用 3 次、network seam 0 次。首轮本来就预期三个 incident enter。证据：`engineering/doc/FLY-2134-monitor-the-monitors/plan.md:181-192`。

   **Why:** 两个判据不能同时成立，会让 acceptance evidence 无法唯一判定。

   **Suggested fix:** 删除前半句的“发帖 seam 零调用”，统一为：`_af_post` 恰 3 次、实际 network seam 0 次、`post_status=failed`、`run_status=degraded`；stub 返回 0 的独立路径则为 3 次且 `post_status=success`。

## Verdict

CHANGES REQUESTED — address items above
