# Design Review — FLY-1774 plan.md (Round 3)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 的 attempt namespace、跨腿幂等、stale-envelope typed convergence 和 legacy ACK 例外已写成可实现合同，原四项中三项可以关闭。仍有一个 lifecycle blocker：`runner_declared_states.kind='parked'` 不是 `phaseKeepAlive` 消费者的权威证明，计划对 `send` 清 marker 的“良性交互”论证与当前 hold 进入路径相反；此外 sweep 尚未定义同一快照含多个 LEASED batch/QUEUED frontier 时如何选择唯一 attempt。

## What's Good (Keep)

- `doorbellAttemptId` 已与 Codex transport UUID 解耦：batch 使用验证后的 `<durableBatchId>#r<lease_retry_count>`，LEASED sweep 可推导同一逻辑值，`doorbell:` message ID 直接复用现有 `(execution_id, message_id)` 唯一约束；这个方案无需新增索引。
- `doorbell:` namespace 同时给出耐久分类，覆盖查询不会再与既有 source-null park/gate/retest wake 互相抑制；`transaction(...).immediate()` 也补齐了跨连接并发检查与 INSERT 的序列化边界。
- Batch callback 已绑定 canonical batch/retry/member set，并把 `already_settled`、`stale_attempt` 当作 transport 可 ACK 的正常收敛结果；只有 malformed/ownership 违规抛错，解决了旧 JSON 每秒 poison-loop 的问题。
- 新增的 batch-success-unacked、跨腿同 attempt、非-doorbell 干扰、active-runner 先 ACK、暂停 watcher 跨 lease expiry 等测试，正面覆盖 Round 2 的失效状态，而不是只测成功路径。
- I1 现在准确限定 queue-enabled batch/sweep 零 settlement，并显式保留 queue-OFF legacy 自动 ACK；Fix A、Fix D、真实租约 QA、单一 hold-loop 注入者和无 direct RPC 的已关闭结论继续成立。

## Issues & Recommendations

1. **`declared parked` 既不是 `phaseKeepAlive` 的必要条件，也不是充分条件，R2-3 尚未关闭。** `flywheel-comm declare-state park` 是所有 runner 都可写的通用 liveness intent；实现只按 execId upsert `runner_declared_states`，没有 phase-capability 校验（`packages/flywheel-comm/src/commands/declare-state.ts:75-106`）。因此非-phase runner 也能满足计划的新 gate，仍可生成无人消费的 wake。反方向上，Lead `send` 在落 instruction 后无条件执行 `clearDeclaredState(toAgent)`（实际是 `send.ts:33`，计划写的 `:32` 也需修正），但 phase controller 在 native goal 进入 `complete` 时会直接 `enterPhaseHold()`，并不要求 marker 仍存在（`codex-daemon-client.ts:1061-1067`）；marker 只是 loop/startup 的另一条提前进入路径（`:1093-1101`、`:1233-1235`）。所以“无 marker 时 runner 本就不会进 hold”不成立：Lead send 可清 marker，runner 随后仍进入 resident hold，而 turn-end sweep 因 gate no-op，正好失去它要提供的 watcher-failure 兜底；“in-turn polling covers”也没有对应的自动新 turn/消费证据。建议选一个真正的 phase-lifecycle authority：例如由 `CodexPhaseLifecycleController` 在 start/stop 边界持久注册 active consumer，并让 sweep 在同一 CommDB 事务验证；或把 sweep 触发移到只有 phase controller 才能到达的 hold-entry seam。若这需要表/迁移、能力 env 或 notify argv 变化，应诚实更新“无 schema/零新 env/config 字节不变”声明，而不是继续让 liveness marker 承担错误职责。测试至少覆盖：非-phase runner 自己声明 park 仍 no-op；phase runner park→Lead send 清 marker→goal complete 仍进 hold且 sweep 可入队；已 paused hold 的 marker 被清后仍可 sweep；restart 恢复的 phase hold 仍有同一资格事实。

2. **Sweep 的 attempt 推导对真实的多批次快照不是全函数，implement node 仍无法唯一决定 message ID。** Runner lane 默认允许 3 个、配置上限 20 个并行 in-flight batch（`mailbox-queue-config.ts:14-20,81-87`），`claimQueueBatch()` 也按该上限允许同一 recipient 同时存在多个 delivered LEASED `batch_id`（`mailbox-queue.ts:1070-1096`）。因此一次 sweep 可同时看到 batch A `#r1`、batch B `#r0` 和未领批 QUEUED 行；计划分别定义了“LEASED 用 batch+retry”和“QUEUED 用 max(seq)”，但没有规定这种混合快照选择哪个单一 `doorbellAttemptId`、文案/metadata 覆盖哪些成员，以及已有另一 attempt 的 pending/started wake 时新 attempt 是合并覆盖还是留给下一轮。建议按 attempt 分组并定死顺序与结果：例如事务内选择最老 eligible attempt 作为本次 durable ID、只记录其成员，其他组保持未覆盖供后续 callback/sweep；或定义一个可跨组的 deterministic frontier ID 和完整 covered-attempt set。无论选择哪种，都要让“reused”不会静默丢掉 response ref，并补“两条不同 LEASED batch + QUEUED 行”“instruction/response 分属不同 attempt”“第一条 wake finished 前后第二 attempt 到达”的测试。另外把 I9/自循环文字从“只随新投递 attempt”精确改成计划实际允许的“新验证 batch attempt 或新 QUEUED sweep frontier”；`max(seq)` 因 eligible 集合收缩也可能产生不同 frontier，并不等同于新邮件投递。

## Verdict

CHANGES REQUESTED — address items above
