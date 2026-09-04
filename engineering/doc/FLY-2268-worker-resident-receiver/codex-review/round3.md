# Design Review — plan.md (Round 3)

Date: 2026-09-03
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 正确闭合了 legacy `phaseRole` digest、multi-binding activation 解析、同步构造器/异步备份的基本装配方向，以及 guard 文案冲突；这些修正与 HEAD 的类型和调用面相符。但迁移窗口仍建立在不真实的停机顺序上，receipt 也没有绑定备份时的数据状态；同时 turn barrier 的 await 语义和 `thread/read` parser 仍无法兑现 restart/mid-turn 的 fail-closed 合同。因此本轮仍不能进入实现。

## What's Good (Keep)

- 保留 `capabilityDigest` 的键集合和算法，并用 parser 已验证的旧 `phaseRole` 仅重建 digest，是正确的双向兼容方式；它没有重新进入 loop eligibility。
- resident adopt 改用 hold 行的 exact `activation_id`，其他 reown/receiver 改用 `resolveCurrentWorkflowActivation` 且 ambiguous fail-closed，正确处理了同 execution 多 binding。
- 不把 `CommDB` 构造器改成 async 是对的；`startBridge` 本身是 async，因此 boot preflight 有可落地的 await seam（`packages/teamlead/src/bridge/plugin.ts:4520-4536,6810-6827`）。
- drain challenge CAS 已进入 `commitEnrolledCompletion` 的同一 StateStore 事务，且 `drainReceipt` 在业务 digest 前剥离，关闭了核验与完成提交之间的 crash window。
- expiry operation 的 `run_id`、canonical digest 与 poison 行为已明确；shutdown exact-request、多 pending ACK、caller sweep 和回滚逆序仍与母单裁定一致。
- A7(d)/(e) 已收敛为本单构造点和逐文件常量 allowlist，没有新增表、flag、env knob 或告警面。

## Issues & Recommendations

1. **[BLOCKER] 所谓“部署窗口内所有 CommDB writer 已停”与真实 updater 顺序不符。** 计划明确声称 preflight 前 updater 已停 Bridge、gateway 和全部 runner（`engineering/doc/FLY-2268-worker-resident-receiver/plan.md:67,116`; `engineering/doc/FLY-2268-worker-resident-receiver/research.md:326-331`），但实际脚本在 Step 1 只停 Bridge（`scripts/restart-services.sh:2981-3008`），Step 3 已启动并验活新 Bridge（`scripts/restart-services.sh:3065-3069`），到 Step 4 才重启 Leads（`scripts/restart-services.sh:3160-3172`）；在飞 adapter 还会直接写 CommDB（`packages/claude-runner/src/CodexTmuxAdapter.ts:2280-2303`; `packages/claude-runner/src/TmuxAdapter.ts:1042-1059`）。writer 清单也不完整：`send`、`ask`、`gate`、`notify` 等 CLI 都可独立打开并写库（`packages/flywheel-comm/src/commands/send.ts:18-34`; `packages/flywheel-comm/src/commands/ask.ts:33-42`; `packages/flywheel-comm/src/commands/gate.ts:133-143`; `packages/flywheel-comm/src/commands/notify.ts:258-271`）。这会让备份与重建之间出现已提交写，回滚时丢数据，也使“独立合入 M3-1”的部署 blast radius 未被控制。建议撤回“既有顺序已冻结”的断言：要么把 deploy 脚本改成可证明、可测试的全 writer quiescence，并保持到所有项目重建完成；要么使用下条所述的精确 source binding，在 `BEGIN IMMEDIATE` 内验证后才重建。补 deploy-order/census 测试，并逐项覆盖所有生产 `new CommDB` writer，而非只列三个样例。

2. **[BLOCKER] rebuild receipt 只绑定 schema，没有证明可恢复备份属于待迁移的精确数据状态。** receipt 虽记录 `backupSha256`，但构造器合同只校验当前 `runner_shutdown_controls` 的 `sourceSchemaDigest`（`engineering/doc/FLY-2268-worker-resident-receiver/plan.md:29,47,109,136`; `engineering/doc/FLY-2268-worker-resident-receiver/research.md:326-330`）；同一旧 schema 下任意行写入都不会改变该摘要，而且计划没有要求构造器重新核验 backup 文件存在、其 SHA 匹配或其 `quick_check` 仍通过。于是 preflight 后一次写入、同 schema 的旧 receipt、或 receipt 后损坏/删除的 backup 都仍可放行不可安全回滚的重建。仓库现有 swap intent 已用 source main/WAL hash 防 stale adoption，并在恢复时重新断言绑定（`packages/flywheel-comm/src/mailbox-migration.ts:1611-1628,1918-1935`）；本单至少应等价地记录并验证 source logical/content binding 与 backup SHA，在获得迁移写锁后的同一事务内复验 source binding，再重建，并把成功 receipt 标记为已消费而保留回滚定位信息。新增“备份后源库追加一行”“同 schema 不同库 receipt”“backup 缺失/篡改”“成功后旧 prepared receipt 不可复用”四个负例。

3. **[BLOCKER] `CodexTurnBarrier.settled()` 仍不是边界 barrier，`startTurn` 后的 started 写可以逃出 await。** §9.4 把 `settled()` 定义成“返回链尾”，并只要求在每次 `startTurn` **之前** await（`engineering/doc/FLY-2268-worker-resident-receiver/research.md:336-340`; `engineering/doc/FLY-2268-worker-resident-receiver/plan.md:23,132,138`）。如果 await 时尾为 P1、期间通知追加 P2，P1 resolve 后调用方会在 P2 尚未执行时继续；更直接地，JSON-RPC response 可先在 `handleFrame` 的 response 分支 resolve 并 return，`turn/started` 是后续独立 frame（`packages/claude-runner/src/codex-daemon-client.ts:258-306`），而现有 `reactivateWake` 在 `startTurn` 返回后立即 `setGoal(active)` 并最终 `finishWake/leaveHold`（`packages/claude-runner/src/codex-daemon-client.ts:1007-1024,1047-1068`），初次 turn 也在 claim 后直接返回（`packages/claude-runner/src/codex-daemon-client.ts:1243-1269`）。此时 `active_turn_id` 仍为空，mid-turn 到件会被错误按边界信处理。应让 `settled()` drain 到稳定链尾，并在 RPC turn id 已 claim、对应 `onTurnStarted` 已入链后再 await；最好直接用 response turn id 提交幂等 started 写，迟到 notification 仅作重复确认。还要让 barrier 的 `setup_failed` 永远压过已流入的 terminal，避免现有 setup catch 的“有 terminal 就吞掉其他错误”路径（`packages/claude-runner/src/codex-daemon-client.ts:1452-1483`）。测试必须覆盖 response-before-notification、notification-before-response、P2 在等待 P1 时入链，以及 terminal 与 barrier failure 同时出现。

4. **[BLOCKER] `thread/read` 的严格 parser 按错了 0.153.2 协议 envelope，合法恢复响应会被全部拒绝。** 计划要求顶层 `threadId` 与顶层 `turns`（`engineering/doc/FLY-2268-worker-resident-receiver/plan.md:23`; `engineering/doc/FLY-2268-worker-resident-receiver/research.md:339`），但本机同一 0.153.2 binary 生成的官方 `ThreadReadResponse` 唯一顶层必填字段是 `thread`（`/tmp/fly2268-schema.bNEbTA/v2/ThreadReadResponse.json:2691-2700`），`id` 和 `turns` 位于该 `thread` 内（`/tmp/fly2268-schema.bNEbTA/v2/ThreadReadResponse.json:1060-1079,1242-1247`）。仓库既有 reconcile parser 也明确从 `result.thread.turns` 读取，并仅为兼容旧形状再接受顶层 `turns`（`packages/teamlead/src/lead-backends/codex/CodexTurnExecutor.ts:300-315`）。按当前计划实现会让每次 Bridge 重启都进入 `reown_turn_reconcile_failed`，supervisor 永不重武装，直接违反 A3(b)/(f)。请把 parser 定义为严格验证 `result.thread.id === requestedThreadId`、`result.thread.turns[]` 的官方字段/状态枚举；如确需兼容已证明的旧 envelope，显式列成受测 union。用生成的 0.153.2 fixture 加合法、wrong-thread、缺 turns、坏 status 四类测试。

## Verdict

CHANGES REQUESTED — address items above
