# Design Review — FLY-1774 plan.md (Round 2)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的六项问题均有实质修订：Fix A 已缩为单状态 carve-out，Fix B/C 已脱离 legacy 自动 ACK 路径，hook 部署与真实租约失败 QA 也写实，整体架构仍可行。当前仍不能交给 implement node：新 doorbell helper 尚未定义 batch 与 sweep 跨腿共享的稳定 delivery-attempt 身份，陈旧 batch callback 的收敛语义也会让 watcher 永久重试；此外 sweep 目前会作用于没有 resident hold 的非 `phaseKeepAlive` Codex runner。

## What's Good (Keep)

- Fix A 现在只从 mailbox terminal 判定中剔除 `awaiting_review`；`OUTCOME_STATUSES − approved_to_ship`、I7、Claude blast radius 和 QA 矩阵彼此一致，未再误用 `WAKE_TERMINAL_STATUSES`。
- Fix B 使用 `source_instruction_id = NULL` 并建立零 mailbox settlement 的专用事务路径，正确避开 `idx_runner_phase_wakes_source` 和 legacy `enqueueRunnerPhaseWake()` 的自动 ACK；在此前提下，“无 schema 变更”成立。
- 保留 legacy 单条路径、单一 daemon hold-loop 注入者且不增加 delivery-time RPC，范围和现有 `observe() → reactivateWake()` 生命周期一致。
- Fix C 已把 mailbox 资格谓词、response-only 的 `check <refId>` 指针、环境绑定身份和 Claude 分支阴性对照写入计划；Fix D 也完整覆盖 allowlist、头注释、测试断言、权限/原子替换与两个独立监督预算。
- 租约 QA 改为 callback failure/暂停消费的真实失败态，并保留 CommDB 与 codex-teams 耐久状态及 frozen-resend 阴性用例，解决了 Round 1 的造假路径问题。
- FLY-1731 的 JIT reconcile 条款仍合理；本轮源码未发现其改动已进入当前 `main` 的 Fix A 判定点。

## Issues & Recommendations

1. **doorbell 去重仍缺一个 batch 与 sweep 共享的稳定 delivery-attempt 身份，因而 R1-2 的“无 stale 二次注入”尚未闭合。** Batch 的逻辑 attempt 已存在于 `metadata.flywheelId = <durableBatchId>#r<lease_retry_count>`（`runner-mailbox-lane.ts:163-188`），但 Codex JSON 的 `message.id` 是写入时另造的随机 UUID（`CodexAdapter.ts:156-160`）；sweep 更没有这个 transport UUID。按现文把“同 `message_id` 永久幂等”作为合同 1，batch wake finished 后同一 LEASED attempt 触发的 turn-end sweep 必然只能生成另一个 ID，而合同 2 只拦 pending/started，于是 sweep 可为同一次投递再建 wake，正好重现计划要消除的下一次 hold stale 注入。建议显式定义 `doorbellAttemptId`：batch 从已验证的 `flywheelId` 得到，sweep 对同一 LEASED batch 必须推导出完全相同的值；QUEUED sweep 也需按稳定的 delivery identity + retry epoch 定义一次 attempt。把该逻辑 ID（带 doorbell namespace）落到现有 `(execution_id, message_id)` 唯一键或 metadata 中并做等价查重，transport UUID 仅留作审计。另需定义 doorbell 的耐久分类（例如 namespaced message ID/明确 metadata marker），避免把现有 source-null `park_wake`、gate/retest wake 当作“已有 doorbell”；“每 execution 至多一个 non-finished doorbell”的检查必须用 `transaction(...).immediate()` 或等价写锁，普通 deferred transaction 不足以证明跨连接并发复用。新增三项测试：batch 成功但 agent 未 ACK 后的 sweep 不新增；sweep-first 与同 attempt watcher callback 不叠加；已有非-doorbell source-null wake 不得抑制 mailbox doorbell。

2. **Batch callback 的校验没有绑定到具体 batch/retry attempt，且把预期陈旧回调当 fail-loud 会形成永久 poison JSON。** §3-B 当前只要求 delivery ID 能解析且行处于 QUEUED/LEASED，并校验 recipient/kind/carrier；这会让旧 JSON 在租约回 QUEUED、甚至成员已被新 `batch_id` 重新 LEASED 后仍冒充当前 attempt。生产 envelope 已携带 `durableBatchId`、`flywheelId` 和完整 member delivery IDs（`runner-mailbox-lane.ts:173-188`），helper 应校验 canonical rows 的 batch ID、解析出的 retry ordinal、精确成员集合及当前可消费子集。与此同时，ACK 可以在 watcher 启动前由 active runner 自己完成，暂停 watcher 的旧 envelope 也可在租约推进后才被扫描；这些是正常 stale 状态，不应抛错。`CodexMailboxWatcher` 只有 callback 成功才把 JSON 标成 read（`CodexAdapter.ts:458-475`），所以当前 fail-loud 合同会每秒重试同一旧消息。建议把结果分为 `queued/reused/already_settled/stale_attempt`（均允许 watcher ACK transport）与真正的 malformed/recipient-ownership violation（抛错）；若同 attempt 中仅部分成员仍 eligible，则只覆盖剩余成员。增加“active runner 已 ACK 后首次进 hold”“暂停 watcher 跨 lease expiry 同时看到旧/新 JSON”测试，断言旧 envelope 被消费、只有当前 attempt 能形成 wake、无持续错误循环。

3. **Sweep 缺少 `phaseKeepAlive`/park 资格闸，会越过计划自己的范围边界。** `runner-stop-notify.sh` 被写进每个 Codex CODEX_HOME（`CodexTmuxAdapter.ts:404-412`），而 `CodexPhaseLifecycleController` 只在 `ctx.phaseKeepAlive` 存在时创建（`:515-540`）。§3-C 当前原子谓词只有 mailbox recipient/carrier/state/expiry，因此普通非-keep-alive Codex 的每次 notify 也能插入 source-null wake，但该 execution 没有 resident hold 消费者，造成孤儿行并违反 §6“非 phaseKeepAlive 零 lifecycle 放宽”。无需新增 env flag：同一 CommDB 已有 hold loop 使用的 durable `runner_declared_states`，建议 sweep 在同一事务里要求 `getEffectiveDeclaredState(execId).kind === 'parked'`（或另一个现有、等价的 durable phase eligibility fact）；这也让“turn-ended re-injection”只作用于真正声明 park 的边界。补非-phase runner、phase runner 仍 active/long_task 均 no-op，以及 declared parked 才入队的测试。

4. **I1 的绝对表述与明确保留的 legacy 行为矛盾。** I1 写“所有唤醒腿零 ack”，但 §3-B 同时要求 queue-OFF 的 legacy `enqueueRunnerPhaseWake()` 逐字节保留，而该函数在 `db.ts:2712-2720` 仍会自动 ACK bound instruction。既然本单已明确不扩张 legacy seam，建议把 I1 精确限定为“queue-enabled batch/sweep doorbell legs 零 settlement，ACK 只由 agent 完成”，并在 I8 保留 legacy queue-OFF 例外；不要让 implement/QA 被两个无法同时成立的验收条件夹住。

## Verdict

CHANGES REQUESTED — address items above
