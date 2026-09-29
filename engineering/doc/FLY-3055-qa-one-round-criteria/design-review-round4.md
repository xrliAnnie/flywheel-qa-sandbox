# Design Review — plan.md (Round 4)
Date: 2026-09-29
Author: Codex
Status: CHANGES REQUESTED

## Summary

评审基于本沙箱提交 `ba0efd2af9c68e215970d099c3e4837ddda7b4e6`，plan blob 为 `5f00b474953db32f5a2ffa5236e6875182ba2131`。已完整重读 v4 的 291 行、exploration.md、research.md，并核对修订涉及的事务、在线消费者、启动 sweep、CLI、retry 和回滚代码。相对 Round 3 的提交只改设计文档；工作树干净，`git diff --check` 无输出。未运行测试、build 或 lint，未修改源码。

Round 3 的 #1、#2、#4、#5 已在设计层面解决。#3 的首次忽略结果持久化和 auto-QA holder 缺失分类也已修正，但回执仍有两个 MED 问题：启动消费后的 pending 没有终结接线，以及提交成功后的异常会被误报为未接受。没有新增 HIGH；不要求扩大范围去修复已声明的 O2 投递缺口。

## What's Good (Keep)

- §5.0 明确先查已接受行、核对规范提交、复用 ref，再进入 legacy/首次接受分支；配合 `UNIQUE(event_id)`，解决 P1 镜像对自身重新检查 prior 的问题。完整 P1 carried 路线和 claim→intent 崩溃测试应保留。
- legacy 首次消费与新 HTTP 提交分开：缺键旧事件可受限恢复，带键损坏不降级；已有清单的 scope 不被 NULL 清单覆盖。
- 账本与状态/intent/claim 同事务、最新 prior 事务内复核、共享 decoder 覆盖启动 sweep，这些核心设计保持一致。
- 回滚集合已包含全部非终态 QA 和 pending launches，最后一起撤 C2b/C2a/C1；O9 implement retry 已明确复用 `phaseFixContext` 和既有 Fix Round renderer。
- 注入继续使用统一 resolver，O2 保持截断后的独立追加位，O5/O6 读取 intent 对应的确切事件，避免新增另一套上下文来源。

## Issues & Recommendations

1. **[MED] 启动 sweep 的最终结果没有更新持久回执，已拒收事件仍会永久重放为 pending。**

   **问题与证据：** `engineering/doc/FLY-3055-qa-one-round-criteria/plan.md:141` 只规定在 HTTP“每次响应前”写 `qa_result_outcome`，`:138` 则直接重放最新 outcome。启动恢复没有 HTTP 响应：当前 `packages/teamlead/src/bridge/phase-orchestrator.ts:914-928` 调用 `onQaResult` 后丢弃返回值，`:929-933` 只记录异常；计划 `:124` 对该调用点只补共享 decoder。计划 `:112`、`:282` 为延迟拒收规定的是 `qa_verdict_stale_prior` 事件和 Lead 告警，没有更新 `qa_result_outcome`。

   **影响：** 按计划 R-f 已定义的路径，C 在 holder 缺失时得到并持久化 pending；启动 sweep 随后因 latest prior 已改变而拒收 C。C 没有 ledger 行，最新 outcome 仍是 pending，因此精确重试继续 exit 0，并声称启动时会消费、下一次 wake 会给 ref，尽管此次消费已经拒收。类似地，现有恢复只取每个 execution 的最新 `qa_result`（`packages/teamlead/src/StateStore.ts:3376-3382`）；同一 QA 在 holder 缺失期间提交两条事件，较早 pending 连消费机会都没有，不能无限保留相同承诺。

   **建议：** 把回执终结接到现有消费边界，而非只接 HTTP 响应：sweep 的拒收、忽略、异常结果也应持久化可重放的 `not_accepted` 和 reason/detail；接受仍由 ledger 决定。对 latest-only sweep 不会再处理的旧 pending，明确返回 superseded/not_accepted，或收窄 pending 的承诺，不必新增调度器。补两条端到端设计用例：pending→启动 stale-prior 拒收→精确重放为 not_accepted；同 execution 两条 pending→启动只处理最新→旧条不再宣称待自动消费。也可选择简化无 ledger 行的回执，避免维护未闭合的 pending 状态。

2. **[MED] 在线路径把所有 consumer 异常归为 not_accepted，会错误否认已提交的接受事务。**

   **问题与证据：** `engineering/doc/FLY-3055-qa-one-round-criteria/plan.md:141` 把 consumer 抛错统一归入 not_accepted，`:238` 的测试矩阵也未区分异常发生在接受前还是接受后；重放却在 `:138` 优先查 ledger。两个消费者都在采纳 verdict 后继续 await 副作用：`packages/teamlead/src/bridge/auto-qa-coordinator.ts:1300-1311` 先写 awaiting_retest 再调用 feedbackWakeMain；其实现 `packages/teamlead/src/bridge/auto-qa-effects.ts:407-424` 在没有 catch 的情况下打开/关闭 CommDB，错误可向外传播。三阶段同样先写 intent（`packages/teamlead/src/bridge/phase-orchestrator.ts:1161-1175`），再执行 fail flow（`:1192`）。这些异常会被 `packages/teamlead/src/bridge/event-route.ts:585-604` 捕获。计划正是在上述首次状态/intent 写入点提交 ledger。

   **影响：** auto-QA FAIL 的状态和 ledger 已原子提交，随后 O2 打开 CommDB 失败。按 v4，首次响应是 not_accepted，CLI exit 2、不给 accepted ref；同一请求重放却因 ledger 有行变成 accepted。QA 被告知 verdict 未采用，而 pipeline 和下一轮覆盖已采用它。这是新增回执对既有副作用失败的错误分类，不是要求修复 O2 的投递保证。

   **建议：** 在线首次响应、异常分支和精确重放共用同一判定顺序：先按 event_id 查已接受账本，有行就返回 accepted + 真实 ref；只有无行时才使用 consumer 的拒收/异常原因或合法 pending。接受后的副作用错误继续按现有告警/恢复语义处理，不撤销接受事实。恢复 v3 中“消费者返回后先查 ledger”的顺序即可。增加故障注入：接受事务提交后 feedbackWakeMain 抛错，首次响应与重放均为 accepted、ref 相同、ledger 仅一行；另保留事务提交前抛错 → not_accepted 的对照。顺带将 `plan.md:18` 残留的 stored/ignored 名称统一到最终回执契约。

## Verdict

CHANGES REQUESTED — 0 HIGH / 2 MED。请补齐回执终结与接受事实优先级；其余 Round 3 修订可保留，核心存储与注入方案不需要重做。
