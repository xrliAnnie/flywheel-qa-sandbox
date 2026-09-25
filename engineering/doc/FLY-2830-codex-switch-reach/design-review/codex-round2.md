# Design Review — plan.md (Round 2)
Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的 7 项里，W2、W3、W4 已关闭；W5/W6/W7 的大部分修订也正确。剩余 4 个 blocker 都在本轮增量内：W1 仍没有测试 runtime 自己的默认 lsof 接线；W5 把部分瞬态失败算作 completed 并 ack，且 75 秒 deadline 还不是实际硬上界；W8 的快照类型无法表示代码允许的 `pool_exhausted` 形状。没有重新审计其余已接受架构。

本轮只读最新版 `plan.md`、§14、Round 1 报告及上述改动直接相邻的现有源码契约；未运行测试、未修改源码，也未读取真实凭据或发起账号网络请求。

## What's Good (Keep)

- W2 现在明确复用完整 `residentEvidence` 权威链，并拒绝重复、等号形式、缺值或错 socket 的 `--remote`；删除无用途的 `ppid` 也降低了三快照 parser 的改动面。Round 1 #1 已解决。
- 删除 W3 是安全且更小的处理：2h orphan reaper 不再被错误描述为具有 start-identity 门，正常 teardown 由 W1 恢复，剩余 2h 边界也已显式记录。Round 1 #2 已解决。
- W4 的 `OccupancyAnswer`、canonical-unreadable 逐 key 规则、observer detail 通道和写前校验形成了完整契约；测试覆盖了竞态和 fail-closed 分支。Round 1 #3 已解决。
- W5 generation 回退重建基线、两条刷新 lane 隔离、专用 waker、两个 state 字段与旧 V2 兼容，以及未 ack 请求跨重启重试，方向都正确。
- W6 把 scheduler 健康权威固定在 Codex 分路，W7 补齐 null 文案与转义，均关闭了 Round 1 advisory。
- W8 改为 producer 在事务内固化 payload、consumer 只按 payload 重放，不再查询 mutable “latest fact”；删除虚构窗口名和不可达的 unreadable 集成 fixture，解决了 Round 1 #6 的主要问题。

## Issues & Recommendations (numbered: issue, why, fix)

1. **W1 仍未回归测试 runtime 的默认 socket-holder 接线。**

   **Issue:** 修订后的测试用真实 socket 只调用 teamlead reaper 已导出的异步 `defaultSocketHolderPids`；runtime 一侧只有 resolver 纯函数测试和“代码审阅点”（plan.md:47-50）。但生产有两个不同实现：`claude-runner/src/codex-daemon-runtime.ts` 的私有同步 holder，以及 `teamlead/.../codex-runner-orphan-reaper.ts` 的异步 holder。共享 resolver 的单测和 reaper 集成测试无法发现 runtime 忘记调用 resolver、仍把软链原路径交给 lsof 的回归。

   **Why:** R1 的生产根因同时影响 readiness/正常 teardown 的 runtime 探针和 orphan reaper。只证明后一条链会让 W1 在测试全绿时仍可能保留 `daemon_not_alive`，正好漏掉本单打开自动切号所依赖的那一半。

   **Fix:** 增加 runtime 公共入口的真实 socket 回归：构造 expected daemon socket 软链、对应 ledger/真实 PGID，让 `probeCodexDaemonLiveness` 或 `probeCodexDaemonProcessBinding` 使用默认 `socketHolderPids`，断言能证明当前 Node holder；不导出私有 helper。与 reaper 用例采用同样的 CI `lsof` 平台策略。这样 resolver、runtime 接线、reaper 接线三层各自有失败测试。

2. **W5 仍会把没有更新 `lastObservedAt` 的 sweep 标成 completed 并永久 ack。**

   **Issue:** 新 `SweepResult.completed.skipped` 明确包含 `usage` 读取失败，随后 `completed` 无条件 ack，只有 outcome 写成 `partial`（plan.md:140-151）。现有 candidate 路径在 `fetchUsage` 返回 `network`、`rate_limited`、`unauthorized` 等错误时不会写任何 per-account observation；AccountStore 也没有计划中所称可供页面显示本轮 usage 失败原因的字段。即使 GET 成功，`projectObservation` 仍可能返回 `stale_generation`、`missing_account`、`invalid_store`、`write_failed` 等非 `updated` 结果（`quota-monitor.ts:226-243`），当前计划的 `SweepResult` 也没有表示它们。active 号同样存在缺口：正常流程调用 `projectObservation` 后忽略其结果（`:1939-1954`），而 request ack 只看后续 candidate sweep。

   **Why:** requestId 一旦 ack 就不再强制重试，但 QA 3 要求 active 和全部 pool account 的 `lastObservedAt` 都晚于切号时刻。按当前契约，active 写失败或任一 candidate 瞬态读取/写入失败时，state 会说 `partial` 且永久消费请求，实际 store 时间不前进；这正是 Round 1 #4 要消除的假成功。

   **Fix:** 把 request-mode 的完成权威提升到整轮结果，而不只是 candidate 循环：active 的 `projectObservation === "updated"` 必须纳入；每个应读 candidate 也只有 `recordObservation === "updated"` 才算 read。`network`/`rate_limited`/临时 unauthorized、projection 非 updated、锁/写失败都返回 aborted 且不 ack。只有已经存在于 durable AccountStore 的明确终态排除（例如 operator `unavailable`）才可作为 terminal skipped；若保留 partial ack，要精确定义这组闭集。增加 active projection failure、candidate usage error、candidate projection failure 三组“不得 ack、下一轮成功后才 ack”测试。

3. **W5 的“75 秒总 deadline”按计划写法不是硬 deadline，§6.3 与无条件 QA 3 仍互相矛盾。**

   **Issue:** plan.md:150 只要求在“逐号循环前检查”deadline。一次循环随后可串行执行 10 秒 token verify + 10 秒 usage GET；`readCandidateCredential` 还会进入默认最长 30 秒的 account lock acquisition。deadline 前 1 ms 进入这些 await，实际轮次仍可越过 75 秒很多，测试里“各网络调用贴 10 秒”也没有覆盖 lock contention。另 plan.md:163 已承认 wake 失败时可能超过 120 秒，但 plan.md:10 和 QA 3（:235）仍无条件声称每次切号 ≤2 分钟。

   **Why:** 预算表把 75 秒当作可并行取 max 的真实上界，实际实现却只做边界前抽样；因此 `≤10+90≈100s` 不是代码可保证的结论。这个差异会让正常依赖慢/锁争用时出现设计已经知道、QA 却没有定义如何判定的失败。

   **Fix:** 从 request 被识别时生成绝对 `deadlineAt`，把剩余预算传入 lock acquisition、token verify、identity/usage fetch，并在每个 await 后再次检查；任何越界返回 `aborted:deadline` 且不 ack。测试加入 30 秒 lock contention 和“deadline 前进入、调用后越界”。如果不准备为这些依赖增加 deadline-aware API，就把表中的 75 秒硬上界和无条件 120 秒验收改成明确的 best-effort/健康依赖前提，并在 QA 3 写出该前提；两种契约只能选一种。

4. **W8 的 `alertSnapshot` 不能表示合法的 pool-exhausted observation。**

   **Issue:** 快照把每个 window 的 `resetsAt`、每号 `recoveryAt` 和 fleet `earliestRecovery.at` 都定义为必填 number（plan.md:194-202）。但现有 `CodexQuotaWindow.resetsAt` 是 `number | null`；selector 的 `windowsValid` 明确接受 null，而且 `pool_exhausted` 在任一 exhausted window reset 为 null 时仍成立，只把下一次尝试设为 `now + 60s`（`candidate-selector.ts:125-141,179-196`）。`reached=true` 甚至可以让一个没有任何 100% window 的 valid observation 进入 limited/pool-exhausted。两种形状都无法计算计划中的 `Math.max` recoveryAt，却能合法到达 `recordPoolExhausted`。

   **Why:** 这会在真实 pool exhaustion 时产生 TypeScript/运行时不一致，或把 `nextAttemptAt=now+60s` 错当成真实恢复时刻。后者会向 founder 报一个不存在的额度恢复承诺。

   **Fix:** 快照保留 `resetsAt: number | null`；只有至少一个 exhausted window 且所有 exhausted reset 都已知时，`recoveryAt` 才为 number，否则为 null。只要任一账号 recovery 未知，就不能把已知账号的最小值称为 fleet “最早可恢复”；应输出“无法确定”（可另列“已知最早”但需改文案），`earliestRecovery` 也应可空。测试至少增加“100% + null reset”和“`reached=true`、无 100% window”两个真实可达 fixture，并证明不会伪造恢复时间。

## Advisory

- §10 仍写“quota-monitor state 加一个可空键”，实际是两个键；改正文避免迁移说明漂移。
- 回滚不能只写“与 quota-monitor 重启同时进行”：旧 binary 一旦先读到新 V2 keys，会把严格 state 判 corrupt，可能丢掉 alertOutbox/confirmation。应写成“先停 daemon → 原子删除两个键并校验 → 启动旧版本”，并给出可复核命令。
- W8 producer 应给 `alertSnapshot` 明确总字节/账号/窗口上限，outbox consumer 仍需严格校验 durable payload；“producer 生成过”不能替代跨持久化边界的解析。
- §6.1 日志格式没有 `wake=<outcome>`，§6.3 又依赖该字段解释超时；统一成一个固定日志契约。

## Verdict

CHANGES REQUESTED

Round 1 的高风险身份边界已经修好；本轮只需收紧上述测试、ack、deadline 和 nullable-recovery 契约，不需要重开整体设计。
