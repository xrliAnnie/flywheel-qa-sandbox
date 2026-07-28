# Design Review — FLY-1499 plan.md (Round 5)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 5 已实质关闭 R4-1、R4-2、R4-3，并把 R4-5 的 timer 生命周期补到了可验收的程度；`events` 表作为 `pa.injected` 的 durable phase anchor 仍然是与现有 schema 相容且无需扩表的合理选择。当前还剩两个落地合同缺口和一个验收矩阵缺口：Lead 注册后的必拉动作无法由已声明的公开签名执行，新调度器类型没有形成可编译/可导出的 API 闭环，且计划声称覆盖的 disposal 期间 stale-start 反例没有进入 T8。

## What's Good (Keep)

- `requireActiveConsumerTx` 现在把 registry identity 与 runner activation 的 `state='active'`/generation 校验放进每一条消费 mutation 的同一 `BEGIN IMMEDIATE` 事务；它与 disposal 的 terminal-authority gate 互斥，正确关闭了 activation terminal 后迟到 start/settlement/marker/timeout 写入的窗口。
- SLA 选择已经一致：公式保持 v11 原文，owner-route + post-settlement ring 被明确列为成立前提，tick 只保活、不再被错误地声称为每槽 SLA 预算；“删除 ring 后 SLA 断言转红、最终仍可达”是有价值的承重件 mutation test。
- `recordInjectedTx` 对 marker 的 canonical row、冲突 read-back 与时间锚约束已经完整：`started_at <= created_at <= txNow`、单次 `txNow` 快照、`task_id/attempt_id=NULL` 以及全字段碰撞矩阵共同避免了预置/污染事件被误认成有效 phase anchor。
- `EngineScheduler` 注入、per-attempt timer registry、replace/cancel/stop/restart/stale-callback 重验的方向正确；它保留的是 SLA deadline 调度，而非已经删除的 mailbox due 时延优化，符合 §8 的反 over-reaction 原则。
- Candidate SQL 的两处受批 revision、kernel add-only 边界、同步 `Kernel.write`/1s budget 约束、失败 fail-closed 语义及 runner marker 后持续 redelivery 均未在本轮回退。
- 评审对象已冻结到 `36759ba4`：当前 HEAD 仅比它多一个 `progress.md` 提交，`plan.md` 内容相同；该 docs commit 的 `git diff --check` 通过。

## Issues & Recommendations

1. **[HIGH] Lead `register()` 的公开签名无法兑现“commit 返回后由 owner driver 恰一次必拉”的承诺。**  
   §4.1 声明 `register(kernel, rt, agent, identityDraft, evidence?)`，其参数没有 `EngineDriver`、`ConsumerCoordinator`、converter 或 post-commit callback；`EngineRuntime` 也只有 config/clock/scheduler。可是 §4.1-8 又要求这个 convenience API 自己封装“最外层 `Kernel.write` 返回后，owner driver ring 一次并安装 timer”。按当前签名，函数既找不到 owner driver，也无法建立 Lead coordinator；若靠未声明的全局 singleton/隐式注册表实现，又违反本计划的显式依赖与可测性原则。`Kernel.write` 的实际实现确实是同步、非重入并在回调返回后才结束 immediate transaction（`packages/v2-kernel/src/kernel.ts:273-309`），所以 post-commit 边界本身正确，缺的是可执行的 ownership/API 连接。  
   **建议修复：**选择并写死一种签名闭环，例如把 Lead 注册做成 `EngineDriver.registerLead(...)`，或令公开 `register(driver, ...)` 显式接收 owning driver/coordinator；如果保留纯函数，则返回明确的 post-commit token/action，并由一个有 driver 引用的公开 wrapper 在成功 commit 后执行。随后让 T1 通过真实公开入口验证 commit 前零 candidate read/deliver、成功后恰一次 ring/pull、rollback 后零动作；不要只用测试夹具手工模拟一个当前 API 无法实施的顺序。

2. **[MEDIUM] 新增 scheduler 合同目前不是完整的 TypeScript/root-export 合同。**  
   §4.0 的 `EngineScheduler` 使用 `TimerHandle`，但该名字在计划和仓库中均无定义；它不是 TypeScript 标准全局类型。与此同时，外部调用者必须构造公开的 `EngineRuntime`，其中含 `scheduler: EngineScheduler`，但 §10 type-only 白名单没有 `EngineScheduler` 或其 handle 类型，T9 也只泛称“导出恰等 §10”。这会让实现阶段要么直接编译失败，要么临时发明 deep-import/隐式类型，破坏 root-only export 与恰等断言。E20 仍写成 `EngineRuntime {config,clock}`，§11 末尾也仍说“时间全走注入 clock”，与新合同不一致。  
   **建议修复：**定义一个与 Node/DOM 无关的 handle 合同（或把 scheduler API 改成返回 cancel closure，避免暴露 handle），并把 `EngineScheduler` 及必要的 handle type 加入 §10 type-only 白名单和 T9 type fixture；同步把 E20 与 §11 改为 `{config,clock,scheduler}` / “clock + scheduler 全注入”。这应在实现前钉死，避免导出恰等测试与消费方写法再次变更。

3. **[MEDIUM] R4-1 声称覆盖的 disposal 行事务之间 stale-start 反例没有落实到 T8。**  
   §4.2a 明确声称 T4/T6/T8 覆盖“activation terminal 后，stale coordinator 在 disposal 行事务之间 start 新 attempt 必拒”；但 T6 只列出了 terminal 先于五类消费入口的矩阵，T8 列出的双连接边界则只有 successor registration 位于 attempt/message 或两条 message 事务之间，没有列出 stale `startAttempt` 插入 disposal 两阶段之间的反例。按 §11 的“claimed scope 必须枚举并做 mutation verification”纪律，这个关键的“先收账后处置仍保持零 running 尾巴”闭环不能只存在于叙述中。  
   **建议修复：**在 T8 明列双连接测试：terminal activation 与 terminal identity 已成立，disposal 完成 running-attempt settlement 后、首个 message-disposal transaction 前触发旧 coordinator `startAttempt`；断言 active-consumer gate 拒绝、零新 running attempt，随后 disposal 完成且无 running 尾巴。对该 guard 做删除/降级 mutation 后，此断言必须转红；并把 T4/T6/T8 各自承担的矩阵范围写清，避免重复描述掩盖缺口。

## Verdict

CHANGES REQUESTED — address items above
