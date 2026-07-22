# Design Review — FLY-1426 plan.md (Round 2)

Date: 2026-07-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已实质修正 Round 1 的八类主体问题：总体架构可建，blind abort、Bun stdio、reply evidence、lane-scoped pager、SQL selector、规则加载与发布门的方向都已与 FLY-1392 对齐。但源码复核仍发现三个阻塞性合同错误（角色 env 判定、spool 假 delivered、缺失 `--lead`），另有几处恢复状态与 API 幂等语义需要收口，因此本轮仍不能批准实施。

## What's Good (Keep)

- 删除 age-based abort 是正确修复；超龄 chat pending 只 quarantine、保持非终态且 selector 排除 `processed_at`，符合 FLY-1392 R3#3，也关闭了 settle-before-complete 重启重投。
- 新增 SQL 级 lane selector、`msgClass:"model"` 与 versioned v1 envelope，解决了全局 pending 先 limit 后过滤、上下文不可重建和必填字段缺失的问题；`refMessageId=NULL` 继续正确避开全局唯一索引冲突。
- Bun 合同已改成 `stdin/stdout/stderr:"pipe"`、显式 write/end、超时 kill，并要求真实 Bun + 真实 dist CLI 集成测试；这能覆盖 mock 无法发现的 runtime 错误，同时保护 MCP stdout。
- auto-settle 已限定为真实 Discord reply reference；roundtable strip 不再写假证据，普通/latest/roundtable 正负测试与显式 `handle-receipt ack` 规则方向正确。
- owner fallback 和 founder pager venue 都已严格收窄；仅 `receipt_unprocessed` + `chat:` episode + no-thread 走 Lead chat，失败再回现有 ticket lane，非 chat 反向测试保留既有行为。
- 覆盖矩阵、PR-1 → dist rebuild/capability preflight → PR-2 的顺序、kill switch allowlist 以及 companion/external residual gap 的诚实披露都应保留。

## Issues & Recommendations

1. **HIGH — companion/external 的真实 env 不是“三者全缺”，当前启用矩阵会把合法隔离角色误判为 broken managed environment。** `plan.md:122,139` 把 companion/external 归入三缺零行为；但 launcher 只清空 `FLYWHEEL_COMM_DB`/`FLYWHEEL_COMM_CLI`，仍无条件传 `FLYWHEEL_LEAD_ID=${LEAD_ID}`（`packages/teamlead/scripts/claude-lead.sh:1425-1438`），并另传 `FLYWHEEL_LEAD_COMPANION=1` 或 `FLYWHEEL_LEAD_EXTERNAL=1`（`:1491-1499`）。照计划实现，每个隔离角色都会启动 stderr 告警并在首条 chat 发可见 advisory，违背覆盖矩阵和 byte-compat。启用判定应先识别这两个现成 role marker，将其定义为显式 legal-disabled；只有非隔离角色的部分三件套才 fail-loud，并用真实 launcher env shape 加正反测试。

2. **HIGH — spool drain 的 `begin+complete` 会在没有任何已确认模型注入时制造假的 delivered 证据。** `plan.md:124` 在 begin 失败后写 spool，但可能随后 crash 于 notification 前，或 notification 自身 reject；重启 drain 仍直接 `begin+complete`。这样 `markExternalDelivered` 会启动追办窗口，虽然该条消息从未成功进入 Claude channel，违反 external carrier 的 accept/deliver 边界。最简单的安全状态机是：spool drain 只幂等补 `begin`，成功后删除 intent，再由同轮 pending reconciler 执行 `[redelivery]` notification、await 成功、最后 `complete`；或者在 spool 中持久化 `injected_at` phase，未有该 phase 时必须重投后才能 complete。补两条 crash 测试：spool rename 后/notify 前 kill，以及 notify reject 后重启，二者都不得在成功重投前出现 `delivered_at`。

3. **HIGH — 规则给出的显式关账命令仍不可执行，因为缺少必填 `--lead`。** `plan.md:133` 的示例只有 `--request-id --receipt --action ack`；真实 CLI 在 `packages/flywheel-comm/src/index.ts:627-629` 同时强制 `--receipt`、`--lead`、`--request-id`。把规则改为包含 `--lead "$FLYWHEEL_LEAD_ID"`（以及既有 `node "$FLYWHEEL_COMM_CLI"` 前缀），并让 bundle truth/integration test 实际执行该命令，而不只断言文字存在。

4. **MEDIUM — spool 的“重试 >5 / 只提醒一次”状态目前并不 durable，且 spool 写失败仍会回到 stderr-only。** 文件被定义为仅含 v1 envelope（`plan.md:124`），retry count 和 advisory latch 却都只在进程内；重启会清零计数，也会允许再次提醒。持续故障若每次都在第六次前重启可能永不提示，深积压则可能每次重启都刷一条，这都不等于文档声称的“一次”。用 durable spool control metadata/sidecar 记录 `attempts`、`advisedAt`，串行化 ready 与 piggyback drain；atomic write/rename 本身失败时也要立即走一次可见 advisory，而不是只写 stderr。文件/目录同时应使用 owner-only 权限，因为里面含 founder 原文。

5. **MEDIUM — “真实上线 reference”的验收还需覆盖 `replyToMode:'off'`，不能只检查 roundtable 后的 `reply_to` 变量。** 当前 `sendReplyChunks` 在 `replyMode === 'off'` 时即使 `reply_to` 非空也不会构造 `payload.reply`（fork `reply-send.ts:33-40`; `server.ts:1177-1195`）。settle 条件应以至少一个成功发送的实际 payload 含 `reply.messageReference === inboundMessageId` 为准，并增加 `replyToMode=off → 不 settle` 负测；否则实现者只检查 strip 后变量仍可能写出假 `discord_reply_reference` evidence。

6. **MEDIUM — patrol 尚未说明如何满足新 selector 的必填 `toLead`，也未定义跨 Lead 的有界分页。** 新 API 是 `listExternalPendingForLane({toLead,idPrefix,...})`（`plan.md:104`），但现有 `LeadReceiptPatrolOptions` 只有 `projectNames`/db path，没有 Lead id 来源（`packages/teamlead/src/bridge/lead-receipt-patrol.ts:9-29`）。明确扩展为由 `projects` 注入每项目 Lead ids，逐 Lead 以 `chat:<leadId>:` cursor 分页，并给 patrol 自己设置每 pass cap；测试要覆盖一个项目多个 Lead、前页均 fresh/already-quarantined 时后页旧行仍能被发现。

7. **MEDIUM — `quarantine` 的“幂等”描述与现有 API 在 reason 变化时不一致。** `quarantineExternalDelivery` 会先更新 `last_error`，再 `INSERT OR IGNORE` 固定 outbox id，最后要求存量 payload 与本次 `{reason}` 完全相等才返回 true（`lead-inbox-queue.ts:799-840`）。因此 60min patrol 先 quarantine、48h plugin 再以 `stale-pending` quarantine 时，第二次会提交状态却返回 false。统一两个调用方的 stable reason，或把 wrapper 的成功判定改为“该 receipt 已处于 quarantine 且 one-shot alert 已存在”；补不同 reason 重放测试，并明确 48h quarantine 是附加动作，之后仍必须 redeliver + complete，而不是替代重投。

## Verdict

CHANGES REQUESTED — address items above
