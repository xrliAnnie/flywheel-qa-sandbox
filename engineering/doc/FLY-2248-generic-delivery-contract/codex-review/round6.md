# Design Review — plan.md (Round 6)

Date: 2026-09-02
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 6 的拆单边界总体合理：FLY-2248 已收敛为 M0/M1/M2/M4，R5 #1 的物化 attempt FK 与 #4 的真实 push outcome 均已闭合，M3 也没有残留 schema 变更在父单验收里。但 R5 #2 仍与当前 CommDB 写入拓扑和 mailbox 字段语义冲突，双向崩溃矩阵还缺少 orphan attempt 的可观察路径；同时 research 的父单回放仍要求已迁出的 supervisor，因此本轮仍不能批准。

## What's Good (Keep)

- `attempt_id TEXT NOT NULL UNIQUE` 在 INSERT 时物化，`parent_attempt_id` / `superseded_by_attempt_id` 单列引用它，同时保留 Lead 指定的复合主键；这解决了 Round 5 的不可建 FK。
- attempt id 不可更新、dangling child 被 FK 拒绝、CommDB child 必须能回到 attempt 的阴阳测试已经列入 M0。
- `DeliveryProjector` 被明确为维护 pass 中 watch 之前的持续、幂等投影 owner；watch 继续只读，职责边界清楚。
- phase wake 的 `first_push_at` 现在只认 `delivered | verified`，与 `runner-wake.ts` / `completeRunnerReceiptWakePush` 的真实词汇一致；claim 仍不推进阶段。
- completion settlement 不再依赖已删除的 `settled_at`，live attempt 由 set-once `settlement_reason` 终结。
- schema 已收窄到 3 张 StateStore 新表和 1 个 CommDB 新列；`three_stage_turn`、shutdown PK、drain、resident hold 等 M3 变更均明确移交 FLY-2268。
- A7 的查询、列 delta、二次启动一致性和三个 alert prefix 仍是可执行的封顶守卫。
- M1+M2 的原子部署/回滚组、22 个 hold shape、现有鉴权正门和无节点名硬编码要求均保留。

## Issues & Recommendations

1. **[BLOCKER] R5 #2 的“所有 CommDB 家族先写 StateStore g1、再写 CommDB”无法覆盖当前 mailbox 写入拓扑，且 `mailbox.ref_id` 不能承载 root。** `flywheel-comm send` 直接打开 CommDB 并写 instruction，没有 Bridge/StateStore 调用；普通 `respond` 也走本地 `insertGuardedResponse`，多个 response writer 在 CommDB 事务内部才生成 response id。更直接的是，`ref_id` 已是 response 指向 question 的权威父引用，受 `mailbox_unique_response`、`getResponse()`、runner doorbell 和过期协调器共同依赖；按 plan 把它改成 `<project>:<issue>:<id>` 会立即破坏 response 查找和唯一性。请在不新增表/告警的前提下固定一种可实现合同：推荐保留 `ref_id` 原义，原始 mailbox attempt 由 per-project DB + recipient session 的 issue + `mailbox.id` 推导 root，直接 CommDB writer 由现有 `DeliveryProjector` 补 g1；只有本来就在 Bridge 内且持有 StateStore 的写点采用 attempt-first。若 Lead 坚持每个 writer 都必须 StateStore-first，则必须明确把 `send/respond` 路由到现有 Bridge 权威入口及其 fail-closed 行为，这已不是当前“零新机制”计划。增加经真实 `commands/send.ts` 与非 Bridge `commands/respond.ts` 的测试，并断言 response 的 `ref_id` 仍等于 question id。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:33,74-78,96`；`packages/flywheel-comm/src/commands/send.ts:18-36`；`packages/flywheel-comm/src/commands/respond.ts:37-40,98-135`；`packages/flywheel-comm/src/db.ts:1803-1846,1955-2009,2127-2143`；`packages/flywheel-comm/src/mailbox-schema.ts:79-95,162-165`；`packages/flywheel-comm/src/mailbox-queue.ts:169-198,3010-3031`。

2. **[HIGH] R5 #2 的两条 crash 路径还没有足够合同保证计划声称的恢复结果。** Window B 的 missing-g1 INSERT 没有说明 `minted_at` 必须取 CommDB 的 immutable creation time，也没有列出 projector 如何得到 `family/contract_ref_json/project/issue`；若仅“按主键 INSERT”，attempt 不能形成可计时快照。Window A 更关键：物理 CommDB 行不存在时，按 CommDB 行扫描的 source 根本看不到这张 attempt；计划虽说它会在 10 分钟后告警，测试却只验证 retry 复用 g1，没有要求 watch 从 attempt 表枚举 orphan。请明确 CommDB source 以 attempt 为驱动、LEFT JOIN 物理 IOU，或给出等价只读枚举规则；projector 补 g1 时必须写 source 的原始 `created_at/queued_at` 为 `minted_at`。两条验收补为：(A) 不重试也会产生 minted-stall episode；(B) projector 从真实 CommDB row 完整重建 g1，第二次 pass 0 rows。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:36,74-83,86`；`engineering/doc/FLY-2248-generic-delivery-contract/research.md:31-36,55-60`。

3. **[HIGH] 拆单后，父单的 authoritative replay #4 仍依赖已移出的 `ResidentReceiverSupervisor`，M0 无法按 research §5 在本 PR 内转绿。** plan 把 #4 完整留给父单并要求 M0 fixture 以 research §5 为准，但 research #4 的 GREEN 仍包含“supervisor 检出 receiver_missing 并重武装”；research 的 generality test 也仍扫描 `resident-receiver-supervisor.ts`。这与 plan M3 明确“不实现 supervisor”及父单 A1 文件集合矛盾。请像 #7 一样拆半：父单 #4 只验 attempt/projector/watch 的 minted-stall、真实 `runner-wake.ts` 成功后推进 sent 与 episode recovery；receiver missing/rearm 半边明确标记由 FLY-2268 验收。同步 research 的测试文件和 generality scan，避免父单测试引用尚未实现的子单文件。证据：`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:12-13,18-19,55,86,103-107`；`engineering/doc/FLY-2248-generic-delivery-contract/research.md:75-92,174,181,187`。

4. **[MEDIUM] R5 #6 的 research/schema 文字仍有几处旧合同，实施者会得到两套合法答案。** Episode DDL 注释仍使用已废弃的 `<family>:<contractId>:...`；launch consumed 一处仍说 source 查询时联结，而 plan 要求写 attempt 的 `consumed_at`；rework settlement 段写“新增列 settlement_reason”但没有指明列属于 attempt；此外 stable table 说 operation 只有两种 kind、由子单追加 `resident_expiry`，实际 §3 DDL 已预留三种。请做纯文档收口：统一 episode id、明确所有阶段钟以 attempt 为权威，并把 operation kind 写成“父单实现两种，DDL 预留第三种”。无需新增任何机制。证据：`engineering/doc/FLY-2248-generic-delivery-contract/research.md:52,60,62-72,124-129`；`engineering/doc/FLY-2248-generic-delivery-contract/plan.md:36-40,47,63,133`。

## Verdict

CHANGES REQUESTED — address items above
