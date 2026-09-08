# FLY-2442 mailbox → harness 适配器接口合同 — 合同页
Issue: FLY-2442 (https://linear.app/geoforge3d/issue/FLY-2442/通路codex-codex-lead-出站改走-bridgelauncher-配置-mailbox-harness)
日期: 2026-09-08
基于: research.md

> Epic FLY-2441 的通用形状:**信先进 mailbox,再按 harness 投递;只有最后一跳因 harness 不同而分叉。** 本页是那个形状的接口合同。以后任何 harness、任何仓的 Lead 照它接。① Codex 出站改 Bridge(本单)、② Claude fail-open、④ Raya 迁移都以本页为准。文件:行号以 2026-09-08 main 为准。

## 0. 五段一图

```
Discord ──① ingest──▶ ② mailbox(comm.db) ──③ 投递泵(Bridge LeadInboxLoop)──▶ ④ 最后一跳适配器 ──▶ Lead 模型
                                                                                       ▲
Discord ◀──────────────────────── ⑤ 回程(经 Bridge 授权)◀───────────────────────────┘
```

| 段 | 谁拥有 | Claude Lead | Codex Lead | 新 harness 必须提供 |
|---|---|---|---|---|
| ① ingest | 各 harness 自带取信器 | Discord 插件 gateway websocket(`flywheel-plugins/discord@0.0.6 server.ts:1593`)→ spool → spawn `flywheel-comm chat-ingest` | TUI 进程内 REST 轮询(`codex-lead-tui-runtime.ts:665`)→ `CodexDiscordMailboxStrategy.accept`(`:70-89`) | 一个能调 `ingestDiscordChat` 的取信器 |
| ② mailbox | flywheel-comm(共用) | 同 | 同 | 无(不许绕过) |
| ③ 泵 | Bridge(共用) | 同 | 同 | 无(不许自己写泵) |
| ④ 最后一跳 | 各 harness 一个适配器 | `ClaudeLeadDeliveryAdapter`:两阶段写 JSON + jsonl 边车 | `CodexLeadDeliveryAdapter`:HMAC 签名 unix socket → TUI 进程内 journal | 一个 `LeadDeliveryAdapter` 实现 + 一个 ack 通道 |
| ⑤ 回程 | Bridge 授权(共用);发送者按 harness | 插件 `POST /api/discord/reply-guard` 问 → 自己 `ch.send`(`server.ts:375`, `:1342`) | `CodexOutboundSender` → `POST /api/lead-outbound/send`,Bridge 代发(本单起为生产默认) | 必须经 Bridge 授权;推荐直接用 `/api/lead-outbound/send` |

## ① ingest(取信)

**接口**(`packages/flywheel-comm/src/discord-chat-ingest.ts`):

```ts
ingestDiscordChat({ dbPath, leadId, chatId, originChannelId, messageId, authorId, authorName, ts,
                    msgKind: "guild" | "roundtable" | …, attachments, text,
                    founderId?, replyChannelId?, replyRoute? })
```

**不变量**
- 幂等键是 Discord `messageId`;重复 ingest 不产生第二行。
- 取信器只负责「写进 comm.db」,**不触碰模型**(FLY-2439 A3)。
- 门铃(`POST /api/lead-inbox/nudge`,`bridge/plugin.ts:3040-3057`)可丢;丢了只是慢 ≤30 s,不丢信。

**两边为什么不同**:Claude 的取信器住在 Lead 的 claude 会话里(插件子进程),Codex 的住在 TUI 守护进程里。两者都不在 Bridge 里。这一段**原则上可以收敛成一份**(FLY-2439 B3 的判断),但不在本单。

**新 harness 提供**:任何能拿到消息并调用 `ingestDiscordChat` 的进程。不要求 websocket,REST 轮询即可(Codex 就是)。

## ② mailbox(CommDB)

**结构**(`packages/flywheel-comm/src/mailbox-schema.ts:193` `MAILBOX_CORE_SCHEMA`,表 `mailbox`):

| 列 | 含义 |
|---|---|
| `id` / `delivery_id` | 行身份;投递 id 冻结后跨重试不变 |
| `from_agent` / `to_agent` / `recipient_kind ∈ {lead, runner, bridge}` | 收发方 |
| `type`(如 `discord_chat`)/ `msg_class ∈ {protocol, model}` | protocol 行由 Bridge 自己消费;model 行投给模型 |
| `content` / `delivery_content` | 原文 / 投递用渲染 |
| `state`(`LEASED` / `ACKED` / `DEAD` …)/ `batch_id` / `claimed_by` | 泵的租约状态 |
| `retry_count` / `lease_retry_count` / `dead_reason` | 重试与死信 |
| `replyChannelId` / `replyRoute`(在 `content` 的路由头里,`parseDiscordChatRoute`) | 回程去哪 |

**不变量**
- 权威在 comm.db,**直到适配器返回持久回执**(`lead-inbox-loop.ts:1-7` 原注释:*Authority stays in comm.db until a backend adapter returns a durable receipt*)。
- 单例 `loop_owner` 租约(`mailbox-queue.ts:1055-1080`):同一时刻只有一个泵拥有一个 Lead 的队列;丢失 owner fence 的写入一律作废。

## ③ 投递泵(Bridge `LeadInboxLoop`)

**参数**(`bridge/mailbox-queue-config.ts:13-23`,env 可调、越界回默认):

| 参数 | 默认 | env |
|---|---|---|
| 批窗 | 30 s | `FLYWHEEL_MAILBOX_BATCH_WINDOW_MS` |
| 批上限 | 10 条 | `FLYWHEEL_MAILBOX_BATCH_MAX` |
| **在飞批(槽)** | **3** | `FLYWHEEL_MAILBOX_INFLIGHT_BATCHES` |
| ack 租约 | 30 min | `FLYWHEEL_MAILBOX_ACK_LEASE_MS` |
| 租约重试 | 3 次 → `lease_expired_unacked` 死信 | `FLYWHEEL_MAILBOX_LEASE_RETRY_MAX` |
| 节奏 | 活跃 1 s / 空闲 30 s | `lead-inbox-loop.ts:29-30` |

**行为**
- 每 tick:先消费 protocol 行(`:281-318`),再 `claimLeadBatchQueue` 认领一批 model 行(`:320-333`);该 Lead 未 ack 的在飞批 ≥3 时不再认领(`mailbox-queue.ts:1297-1305`)。
- 拼 `[mailbox-batch <id> | n messages | from <agent>]` 头 + ack 指令(`:444`),交给适配器。
- 回执必须与冻结的成员名单**逐个一致**,否则视为失败、下 tick 重投(`:471-478`)。
- `membership_conflict` → 隔离(死信),不重投。

**新 harness 提供**:无。泵不许复制。

## ④ 最后一跳适配器

**接口**(`bridge/lead-delivery-adapter.ts:16-54`):

```ts
interface LeadDeliveryBatch {
  batchId: string;            // `<batch>#r<attempt>`
  leadId: string;
  ownerEpoch: string;         // 泵的 owner fence
  kind?: "discord_chat" | "model";
  members: readonly { deliveryId; content; priority; seq }[];
  modelPayload: string;       // Codex 一次性消费的整轮;Claude 由内置 poller 自己打包
  replyChannelId?: string;
  replyRoute?: RoundtableReplyRoute;
}
interface DurableAcceptReceipt { batchId; memberIds: string[]; status: BatchAcceptStatus }
interface LeadDeliveryAdapter { deliverBatch(batch): Promise<DurableAcceptReceipt> }
class LeadDeliveryUnavailableError extends Error { scope: "lead" | "discord" }
```

**不变量**
- 回执只能在**持久接受之后**返回(写盘/入 journal 之后)。
- `batchId` 与 `memberIds` 必须原样回显。
- Lead 整体不可达 → 抛 `LeadDeliveryUnavailableError("lead")`,泵保留队列行;不许静默丢。
- 选型只看 `lead.backend === "codex-app-server"`(`bridge/lead-inbox-runtime.ts:1252-1270`)。

**Claude 实现**(`ClaudeLeadDeliveryAdapter` → `ClaudeMailboxCodec.ts:268 writeMailboxBatch`):Phase A 边车 `<inbox>.flywheel.jsonl` 记成员 → Phase B 文件锁内原子替换 `~/.claude/teams/<lead>/inboxes/<lead>.json` → Phase C finalize 边车。读的是 Claude Code 二进制**内置** poller(`agent-team-transport/src/types.ts:308` `wakeMode: "builtin-receiver"`)。

**Codex 实现**(`CodexLeadDeliveryAdapter` → `CodexLeadInboxSocket.ts`):capabilities 探测(v2 才能带 `replyChannelId/replyRoute`,`:311-317`)→ HMAC-SHA256(以 Lead bot token 为密钥,`:341-348`)签名的 `submitBatch` 走 `<stateDir>/lead-inbox.sock`(`:63-65`)→ TUI 进程内 `router.submitBatch` 入 journal(`:202`)→ 回执。

### 为什么 Codex 这一段砍不掉(原注释)

1. `agent-team-transport/src/types.ts:308`:
   > `builtin-receiver`: vendor binary polls mailbox itself (claude-code). `external-watcher`: needs `IMailboxWatcher` + tmux send-keys (codex). `push-only`: no polling at all.

   Codex 二进制不会自己读文件,必须有人把包好的一轮**推**进去。
2. `bridge/lead-delivery-adapter.ts:29-31`:
   > Codex consumes one packaged turn; Claude writes members atomically and its stock poller packages the unread snapshot into one turn.
3. `CodexLeadInboxSocket.ts:4-7`:
   > The Codex Lead router lives in the windowed TUI sidecar process. The Bridge therefore cannot mutate journal.db directly: doing so would durably accept a row without waking the router's in-memory pump.

   journal 属于 TUI 进程;Bridge 是另一个进程。所以必须有一条 socket 把批交过去,由拥有它的进程自己入账。
4. `LeadJournal.ts:5-9`(journal 本身为什么存在):
   > a Codex app-server thread can execute arbitrary shell/MCP side-effects (gh merge, flywheel-comm). On a crash, naively replaying an input could double-fire those side-effects.

   Claude 侧对应物是 jsonl 边车(也是第二层记账),只是不是 sqlite。

**新 harness 提供**:一个 `LeadDeliveryAdapter`;若二进制自带 poller,照 Claude 写文件;若不自带,照 Codex 给一个进程内 socket 与幂等入账。另需一个 ack 通道(`flywheel_inbox_ack_batch` 或 `lead_actions.ack_batch`)让 ③ 释放槽。

## ⑤ 回程(出站)

**规则**:每一条回复都必须经 Bridge 授权;授权集 = Lead 自有频道(`chatChannel` + `generalChannel`)∪ **该 Lead 在 projects.json 声明的** `roundtableChannel` ∪ 父频道属于前者的线程(本单 FLY-2442 扩到后两项)。不通配:没声明圆桌的 Lead 往圆桌发 → 403。线程父频道查询遇到 429/5xx/timeout → 503 `channel_parent_lookup_unavailable`(可重试);Discord 明确 401/403、频道不存在或父频道不在授权集 → 403 fail-loud,都不回落 direct。

### 5.1 Claude 与 Codex 今天的回程为什么不一样(显式写出,供 Lead 向 founder 更正)

| | Claude Lead | Codex Lead(bridge 模式,本单起为 Mufasa 生产默认) |
|---|---|---|
| 谁发 | **Lead 自己**:插件先 `POST /api/discord/reply-guard` 问 Bridge 允不允许(`flywheel-plugins/discord@0.0.6 server.ts:375`),允许后自己 `ch.send`(`:1342`) | **Bridge 代发**:Lead 把回复放进持久 outbox,POST `/api/lead-outbound/send`,Bridge 授权、去重、用服务端解析的 token 发 |
| token 在哪 | Lead 进程里(插件的 gateway 连接) | 只在 Bridge(`leadDiscordSend.ts:8-10`);请求里不带 |
| Bridge 不可达时 | 按内容 fail-open / fail-closed(`server.ts:420-447`,Epic ②) | 发不出去 → 行留 pending、journal 记 ambiguous,不会绕过 Bridge |
| 跨重启去重 | 无(插件进程内) | 有:`outbound_dedup` 持久表 + `in_flight` 标记永不盲重发 |
| 授权粒度 | reply-guard 只判「顶层是否含 issue 号」(`reply-guard.ts:9-14`),不判频道归属 | 按 `(project, lead, channel)` 判归属,403 拦截 |

所以「与 Claude 一致」的准确说法是:**两边都必须经 Bridge 授权**;Codex 的路径更强(代发 + 服务端 token + 持久去重),Claude 的 fail-open 是 ② 要收紧的对象。

**推荐路径 = Bridge 代发**(`POST /api/lead-outbound/send`,`CodexLeadOutboundHandler.ts`):

```
body { projectName, leadId, channelId, text, idempotencyKey, nonce, probe? }
401 unauthorized → 400 校验 → 403 lead_channel_unauthorized / 503 channel_parent_lookup_unavailable → 去重(200 deduped / 409 ambiguous)→ 原子 claim → 发送 → 200 sent {messageId}
probe: true → 只走到授权,200 {status:"authorized"};不去重不发送
```

- token 在服务端按 `(projectName, leadId)` 解析,永不在请求里(`leadDiscordSend.ts:8-10`)。
- `idempotencyKey` 持久去重(`~/.flywheel/codex-lead-outbound-dedup.db`),跨 Bridge 重启;发送抛错保留 `in_flight` 标记 → 之后一律 ambiguous,**永不盲重发**(`CodexLeadOutboundHandler.ts:196-217`)。
- 客户端持久 outbox(`CodexOutboundSender.ts`,`<stateDir>/outbox.db`),`enqueue` 幂等、`deliver` 可重试。

**Claude 今天的形状**(② 的对象,本单不动):插件先问 reply-guard,再自己直发;Bridge 不可达时按内容 fail-open/fail-closed(`server.ts:420-447`)。

**新 harness 提供**:一个 `OutboundSender { enqueue, deliver, close? }` 实现,直接复用 `CodexOutboundSender` 即可(它不依赖 Codex)。

## 6. 主动发言与其他不在合同内的路径

- `lead_actions.discord_send`(FLY-350,Codex full-access 的主动发言):MCP 子进程直发,alias 服务端解析、metadata-only 审计 jsonl。不走 outbox,不在本页 ⑤ 的授权集内。收敛它是另一张单。
- Raya(④,`xrliAnnie/raya`):今天入站直接进自己的控制器、出站自己的 REST,没有 ②③;迁移 = 把入站接到 `ingestDiscordChat`、把最后一跳做成一个 `LeadDeliveryAdapter`。

## 7. 检查清单(接新 harness 时逐条打勾)

- [ ] 取信器调 `ingestDiscordChat`,不直接推模型
- [ ] 不自建泵、不绕过 `mailbox` 表
- [ ] `deliverBatch` 只在持久接受后回执,回显 `batchId` + `memberIds`
- [ ] Lead 不可达抛 `LeadDeliveryUnavailableError`,不吞
- [ ] 有 ack 通道,ack 后槽被释放
- [ ] 回复经 `POST /api/lead-outbound/send`(或至少经 Bridge 授权),token 不在客户端请求里
- [ ] 启动期对每个配置频道 `probe`,403 就 fail-loud
