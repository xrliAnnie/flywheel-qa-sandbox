# FLY-1426 入站消息 generic 收据 — 探索
Issue: FLY-1426 (https://linear.app/geoforge3d/issue/FLY-1426/infrabug3-founderlead-discord-chat-零-durable-收据-入站消息-generic-收据)
日期: 2026-07-22
基于: 无（上游输入 = issue 描述 + FLY-1391 审计图 + FLY-1392 设计 v2）

## 1. 问题（founder 原话 + 事故）

Founder 裁定（2026-07-22）：「所有 message 的处理都应该是一样的：都进 message queue，进 queue 之后都要有收据。不应该出现我在 Chat 里让你 build 一个报告，你居然没有收据的情况。」并在 review HTML comment 里确认：「我和 Lead 的 Discord 都不落任何表——对，这里是有问题的呀，这里必须要真正 generic 化。」

事故：founder 在 chat 里交代「更新 batch 报告」，Lead 只记工作记忆，被诊断救火冲掉，founder 追问才发现漏。

## 2. Ground truth：入站两条腿的真实现状（2026-07-22 实证）

### 2.1 有账的腿 —— Bridge 事件（runner ask / gate / 汇报 / 告警）

FLY-1392「category-agnostic 收据地基」已 merge（PR #661）且**生产默认 ON**（`FLYWHEEL_RECEIPT_FOUNDATION !== "0"`，`packages/config/src/feature-flags/receipt-foundation.ts:5`；活 Bridge 未设该 env）。核心器官全部现成：

| 器官 | 位置 | 说明 |
|---|---|---|
| canonical receipt row | `lead_inbox` 表（per-project comm.db，`packages/flywheel-comm/src/lead-inbox-queue.ts:149-216`） | 每次真实 Lead delivery 恰一行；`carrier IN ('inbox','external')` |
| 投递 | `LeadInboxLoop`（`bridge/lead-inbox-loop.ts`）→ mailbox / unix socket | carrier=inbox 行由 queue 承运 |
| external 族 | `carrier='external'`：外部 transport 自己承运，row 只是收据 | `markExternalDelivered` / `listExternalDeliveryPending` / `quarantineExternalDelivery` / `markExternalAborted` 全套 API 已在 |
| 追办 patrol | `bridge/lead-receipt-patrol.ts`（GatePoller 每 ~60s）：`advanceDueUnprocessedReceipts` + resend + 升级 alert drain | 状态+priority+豁免选择器，零类型 |
| priority 窗口 | P0/P1=30min、P2=240min、P3=24h（`lead-inbox-queue.ts:14-19`，env 可调） | founder=P0 |
| Lead 办结 | `flywheel-comm handle-receipt`（`commands/handle-receipt.ts`）：`relay/respond/no-route/ack`，lease 授权 | 通用动作，非 per-type |
| Codex 跨部门记账 | `ExternalReceiptSaga`（`lead-backends/codex/ExternalReceiptSaga.ts`）：begin(pending)→complete(delivered)→handle(journal 证据 processed)+reconcile | FLY-1392 §2.4a 两库 saga 的已落地形态 |

注：issue 文本里说的「lead_events 表 + ack token + 30min 看门狗」是 FLY-1279 时代的机制；FLY-1373 cutover 后新事件 `ack_required=0`（`bridge/lead-event-ack-policy.ts:24-36`），HMAC-ack/死信机器对新事件休眠。**现行收据体系 = FLY-1392 的 lead_inbox 窗口/重发/升级模型**，「统一、不造第二套」应对齐它。

### 2.2 无账的腿 —— Discord chat（founder / 其他 lead → Claude Lead）

部署实证（运行时真路径 = `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts`，1583 行 fork 版；8+ 个活 bun 进程确认）：

```
Discord gateway messageCreate（discord.js，插件进程内）
  → gate()：channel opt-in / allowFrom / allowBots / requireMention+mentionPatterns
  → roundtable 路由（FLY-314，改 chat_id）
  → mcp.notification('notifications/claude/channel', {content, meta:{chat_id, message_id, user, user_id, ts}})
      ← fire-and-forget；失败仅 stderr（server.ts:1558-1576）
  → Claude Code 把它包成 <channel source="discord" …> 注入 Lead 对话
```

- **零持久化**：无表、无 journal、无 cursor。消息丢失面：①投进对话后 Lead 工作记忆冲掉（本次事故）；②notification 失败仅 stderr；③session/插件 down 期间 gateway 消息整体丢失（无 backfill）。
- 插件运行环境：**bun**（`.mcp.json`: `bun run start`）→ 不能 require better-sqlite3 等 native node 模块。
- 插件继承 Lead launcher env（`claude-lead.sh`）：`BRIDGE_URL`、`FLYWHEEL_COMM_DB`（=`~/.flywheel/comm/<project>/comm.db`）、`FLYWHEEL_COMM_CLI`（node dist 入口）、`FLYWHEEL_LEAD_ID`、`DISCORD_STATE_DIR`。
- 插件已有 plugin→Bridge HTTP 先例：出站 reply-guard `POST ${BRIDGE_URL}/api/discord/reply-guard`（server.ts:314-396，FLY-173/314 fail-open/fail-closed 分档）。
- **Codex Lead 没有这个缺口**（FLY-224）：RestPoll（durable cursor `inbound-cursor.json`）→ `CodexDiscordGateway` → `LeadJournal`（journal.db，at-least-once）→ `ExternalReceiptSaga` 记账。差的只是 Claude Lead 这条腿。

### 2.3 相邻但不重叠的腿

- founder 在 [FLY-XXX] issue thread 的回复：Bridge `founderReplyDeliverer`（GatePoller）→ FLY-1392 founder lane 单行 canonical + Lead-only 路由。**已有账**。
- Bridge→Lead 事件投递：inbox-mcp（`server:flywheel-inbox`）经同一个 `notifications/claude/channel` 机制注入 + at-least-once（inserted→delivered→ack）。证明「channel 注入 + 收据」组合已有活样板。

## 3. Gap 的精确定义

FLY-1392 设计 v2 §2.4 lane 表里「跨部门 Lead 消息 → accept 边界记账」只在 **Codex backend** 落地（ExternalReceiptSaga）。**Claude Lead 的 Discord chat 入站（founder chat / 其他 lead @ / 核心频道点名 / DM）没有任何 accept 边界记账** —— 这是 FLY-1392 大厦缺的最后一面墙，也是 founder 本次拍板要求补的。

## 4. 方案空间（探索级，研究阶段收敛）

| # | 方案 | 形态 | 初判 |
|---|---|---|---|
| A | **插件 accept 边界记账（镜像 ExternalReceiptSaga）** | fork 在 gate() 通过后、notify 前写 pending 行（begin）；notify 成功后标 delivered（complete）；carrier=external；patrol/升级/handle 全复用 | ✅ 倾向。与 FLY-1392 结构同构，改动面最小，记账判定=transport 自身 accept 判定（零漂移） |
| B | Bridge 第二读者（RestPoll Claude 频道独立记账） | Bridge 自己 poll，插件不动 | ❌ accept 判定漂移（gate() 的 implicit-reply mention 依赖插件进程内 state），且双读者去重复杂 |
| C | Claude chat 入站整体迁移到 Codex 式 gateway（queue 承运） | Bridge poll + lead_inbox carrier=inbox 承运 + mailbox 注入 | ❌ 重写整条通路,破坏现有插件体验（typing/ack reaction/attachment/权限拦截）,违反「谨慎不破坏现有 discord 插件通路」 |
| D | UserPromptSubmit hook 记账 | Claude Code hook 在注入时写收据 | ❌ hook 只在「已注入」后触发,丢 begin/complete 两相；且 channel 注入是否触发该 hook 未证实 |

方案 A 内部的**写入通道**待研究收敛：A1 = 插件 spawn `node $FLYWHEEL_COMM_CLI <新子命令>`（直写 comm.db，不依赖 Bridge 存活）；A2 = 插件 POST Bridge 新端点（复用 reply-guard 先例，但 Bridge down 时需 spool）。

## 5. 待研究问题（→ research.md）

1. `LeadInboxQueue.enqueue` 是否支持 caller-supplied id + carrier=external 的完整参数面（FLY-1392 R2#3 说要加，落地形态核实）。
2. `handle-receipt` 四动作对 chat 收据的适配（ack 的幂等键/授权链路）；收据 id 如何随消息呈现给 Lead。
3. auto-settle：Lead 用 reply(reply_to=入站 msg id) 回复时,插件观察到 explicit reply reference（FLY-1392 §2.4b 证据①）→ settle 的落点与授权。
4. pending 孤儿 reconcile：Claude 腿没有 journal 可反查（R3#3 的反查对象缺位）→ 备选：patrol 把超时 pending 行改走 carrier=inbox 重投（family-linked 新行）vs 仅 `external_saga_unknown` advisory。
5. priority 判定：founder user id 从哪来（插件侧 env/access.json）；founder→P0、其他→P1。
6. 双 lane 重叠：founder 在 issue thread @ Lead 时 founderReplyDeliverer 与插件是否同时投递（两次真实 delivery = 两行,按 FLY-1392 不变式合法,但要确认生产 access 配置下是否真发生）。
7. QA 隔离：QA slot 的 env 覆盖（FLYWHEEL_COMM_DB per slot）是否让新记账天然进隔离库。
8. fork 变更的发布链路：fork repo PR → update-discord-plugin.sh 分发 → cache 目录热更?（插件进程重启时机）。

## 6. 风险与红线

- **不破坏现有通路**：begin 写账失败时消息**必须照样投递**（fail-open on delivery），账走本地 spool/重试补——founder chat 可用性 > 收据完整性；但 begin 成功路径必须先于 notify（queue-first 顺序 = founder 裁定）。
- **不造第二套**：所有行进 lead_inbox，patrol/升级/handle 零新机器；只新增 producer。
- 插件是 fork 外仓：跨仓交付（fork PR + 本仓 CLI/patrol 适配 PR），需同步节奏。
- bun 运行时：受限依赖面（无 native 模块）。
