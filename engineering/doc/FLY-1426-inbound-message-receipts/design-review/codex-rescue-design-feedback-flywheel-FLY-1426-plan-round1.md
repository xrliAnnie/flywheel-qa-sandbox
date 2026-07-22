# Design Review — FLY-1426 plan.md (Round 1)

Date: 2026-07-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

总体方向可行：在 Discord 插件自己的 `gate()` accept 边界，以 `carrier=external` 写入现有 `lead_inbox`，是当前架构里改动最小、也最符合 FLY-1392 的方案；现有 episode adoption、type-agnostic chase、resend child 和 generic handle 都确实能复用。但当前计划仍有会造成假关账、零收据静默退化、错误 terminal disposal 和非 chat 告警越界发到频道顶层的阻塞问题，尚不能进入实现。

## What's Good (Keep)

- accept 点选对了：fork 的 `gate()` 含进程内 implicit mention/roundtable 状态，第二读者无法无漂移复现；把 `begin` 放在 permission early-return 之后、chat notification 之前符合真实调用链（fork `server.ts:1450-1558`）。
- `id=chat:<leadId>:<msgId>`、`carrier=external`、`refMessageId=NULL` 的组合合理；后者正确避开了全库唯一的 `idx_lead_inbox_ref`（`lead-inbox-queue.ts:191-192`），而所有 queue claim 面也都以 `carrier='inbox'` 排除了 external 行。
- `markExternalDelivered` 的 CAS/幂等语义、active episode 对新 delivered 行的收养、以及 chase selector 的 type-agnostic 性质均与计划假设一致（`lead-inbox-queue.ts:683-720`; `db.ts:3610-3635,3798-3814`）。
- 正确找到了升级链的两个真实缺口：chat payload 的 `projectName="unknown"` 无法通过 `resolveDetectionOwner`，且无 issue thread 会进入 `no_chat_thread`/FLY-915 路径（`plugin.ts:6894-6931,7831-7862`; `founder-thread-notifier.ts:650-660`）。
- PR-1 先于 fork PR-2 的顺序正确；真机验收覆盖 begin/complete、超窗重发、两种 settle 和 crash recovery，方向值得保留。

## Issues & Recommendations

1. **HIGH — 48h 按年龄 `abort` 违反 FLY-1392 R3#3，而且会写入虚假的终态证据。** 计划在 `plan.md:105` 规定 pending 超过 48h 就调用 `abort --reason stale`；但 `markExternalAborted` 会固定写入 `basis:["journal_absent","retention_watermark"]`（`lead-inbox-queue.ts:762-786`）。chat lane 没有 durable journal，也没有 absence watermark；一个 `notify` 已成功但 `complete` 丢失的行与“从未 notify”外观完全相同。FLY-1392 明确规定 TTL 只能触发 reconcile，未知只能 quarantine，不能作为 disposal authority（`design-v2.md:138-149`）。删除按年龄 abort；超龄行保持非终态并 quarantine/告警，或重投后 complete。只有取得可审计的权威 absence proof 时才允许 `markExternalAborted`。同时 pending 查询应排除已 `processed_at` 的行，避免 settle-before-complete 后重启又重投。

2. **HIGH — begin 失败仍会回到“消息已进对话、但没有任何 durable 收据”的原事故形态。** `plan.md:101-103` 对缺 env、spawn 失败、超时均只做零行为或 stderr，然后照常投递；stderr 不是 watchdog 可见的恢复状态，且探索阶段原本承诺的“本地 spool/重试补”在 plan 中消失了。这与项目的“failure path 不得静默”规则及本 issue 的核心目标冲突。保持 founder chat fail-open，但在 notify 前把失败的 begin 意图原子落到 `DISCORD_STATE_DIR` 的最小 recovery spool，并在 ready/有界周期重试入账；spool 持续失败或积压必须产生一次可见 advisory。stock 环境可继续零变化，但 Flywheel-managed 环境若只缺部分必需 env，必须 fail-loud，而不是静默关闭收据。

3. **HIGH — 计划写出的 Bun stdin 调用在真实 runtime 上不可运行。** `plan.md:102` 使用 `Bun.spawn(..., {stdin: content})`；本机与生产事实一致的 Bun 1.3.11 实测直接抛出 `TypeError: stdio must be an array of 'inherit', 'pipe', 'ignore', ...`。可工作的合同是 `stdin:"pipe"`，随后 `proc.stdin.write(content); proc.stdin.end()`；`pending --json` 还必须显式 `stdout:"pipe"`，所有 mutator 子进程都要明确 stdout/stderr 策略，绝不能污染 MCP 的 stdout。把 timeout 的 kill、`proc.exited` 收敛和 stream drain 写进计划，并增加一条“真实 Bun + 真实 build 后 CLI + 临时 comm.db”的集成测试；spawn seam mock 不能发现这个错误。

4. **HIGH — “reply_to auto-settle 覆盖大多数对话”与当前插件指令正面相反，roundtable 还存在假证据风险。** 当前 MCP instructions 明确告诉 Lead：最新消息的普通回复要省略 `reply_to`（fork `server.ts:952-957`），tool schema 也把它定义为 optional（`:1020-1035`）；因此 `plan.md:168` 的噪音缓解前提不成立。还要注意 roundtable handler 会在发送前把跨频道 `reply_to` 清成 `undefined`（`:1143-1152`）：若 settle 读修改后的变量则不关账；若仍写 `basis:["discord_reply_reference"]`，实际出站消息又没有 Discord reply reference，证据是假的。应修改 MCP instructions/tool description 和 Lead 规则：receipt-bearing 普通 chat 回复必须显式带原始 `message_id`。普通频道发送成功后可按真实 Discord reference settle；roundtable 要么保留并持久恢复 routed-source 映射、定义经设计批准的独立 causal evidence，要么不 auto-settle、明确走 `handle-receipt ack`。补 latest-message 与 roundtable-strip 两个负/正测试。

5. **HIGH — 新建 `chat-receipt-rules.md` 本身不会被任何生产 Lead 自动加载，且计划误用了 `handle-receipt relay`。** 当前 Claude launcher 逐个显式 `rules_bundle_add` 文件（`claude-lead.sh:2172-2489`），共享 resolver 也逐个 `_lrb_emit`（`lead-rules-bundle.sh:336-389`）；目录扫描不存在，所以 `plan.md:107-109` 所说“经统一 bundle 加载”不足以接线。计划必须列出实际 loader 与 bundle truth tests 的改动，或把规则放进已加载的 `discord-reply-contract.md`。规则还要给出必需的 `--request-id`；`relay/respond` 实际要求一个仍 pending 的 `--to-question` 和 content（`index.ts:610-650`; `db.ts:2411-2422,2481+`），不能代表“把 founder 新任务启动/派给一个 Runner”。一般任务应先完成真实派发副作用，再用 `ack` 关账；只有回复既有 Runner question 时才用 `relay/respond`。

6. **HIGH — founder chat-channel fallback 必须限定为 chat receipt；当前文字会改变所有 detection 的 venue。** `createFounderPager` 是 `wake_failed`、stuck 和普通 receipt 等所有 detection 共用的 sink（`plugin.ts:7311-7346`; `detection-escalation-sinks.ts:205-299`）。若照 `plan.md:94` 写成“无 thread 且有 chatChannel 就顶层发”，任何缺 thread 的非 chat episode 都会绕过现有 FLY-915 undeliverable lane，和 `plan.md:135` 的 reverse-compat 声明冲突。fallback 应在调用 issue-thread emitter 之前，严格限定 `row.kind === "receipt_unprocessed"` 且该 episode 的 root 是 `chat:` lane（例如持久、可测试的 lane 标识/前缀）；非 chat 行仍走原 `onUndeliverable`。fallback 成功不能先创建 ticket，失败才回落 ticket，并补一条非 chat no-thread 反向测试。

7. **HIGH — startup/patrol reconcile 的查询、分页和 envelope 合同不足，按现有 API 会漏行或丢上下文。** `listExternalDeliveryPending` 只有全局 `before+limit`，先在 SQL 中 limit，再由命令过滤 `chat:<lead>:` 会被更早的 xdept/其他 Lead pending 行长期遮住；它也不排除 processed 行（`lead-inbox-queue.ts:722-738`）。`LeadReceiptPatrol` 手里是 `CommDB`，而 `listExternalDeliveryPending`/`quarantineExternalDelivery` 只暴露在 `LeadInboxQueue`，计划没有给出 S2 的可调用 seam。一次 ready 最多 20 行也没有剩余 backlog 的 drain 规则。请增加 DB 级 `toLead + idPrefix/lane + processed_at IS NULL` 选择器和稳定 cursor/pagination，并明确 patrol wrapper/connection lifecycle、只 quarantine 一次及剩余页如何有界收敛。此外 `enqueue` 实际必填 `msgClass`（`lead-inbox-queue.ts:75-95`），计划未给值；现有 machine header/pending JSON 也没有足够字段重建 attachment meta 与 roundtable 的 source/routed channel。冻结一个 versioned、可 round-trip 的 envelope（含 `msgClass:"model"`、原/路由 channel、author、attachments、receipt id），再声称“不需要 REST”。

8. **HIGH — “所有过 gate 的 Claude chat”覆盖和回退开关在 launcher 层尚未成立，发布顺序也少了 dist capability gate。** `claude-lead.sh` 会为 companion/external 角色刻意清空 `FLYWHEEL_COMM_DB`/`FLYWHEEL_COMM_CLI`（`:1417-1430`），所以至少 Claude companion 仍会完全绕过此方案；这与 `plan.md:19` 的全覆盖表述冲突。相同 tmux env allowlist 也没有传 `FLYWHEEL_CHAT_RECEIPTS`（`:1432-1474`），因此 §7 的 kill switch 不保证到达插件。先给出 standard/companion/external 的覆盖矩阵：若隔离角色不能拿 comm.db，就用受限 broker/独立 spool producer，或把它列为 founder 明确认可的剩余 gap，不能静默称为全覆盖。PR-1 还应显式部署并重建 `flywheel-comm/dist`，在 PR-2 rollout 前逐 Lead preflight `node "$FLYWHEEL_COMM_CLI" chat-receipt ...` capability 与 kill-switch env；否则“先 merge PR-1”不等于 live plugin 已能调用该子命令。

## Verdict

CHANGES REQUESTED — address items above
