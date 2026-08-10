# FLY-1574 Discord 收编:不再直推,统一走 mailbox — 调研

Issue: FLY-1574 (https://linear.app/geoforge3d/issue/FLY-1574/消息层重构-e-批次2-discord-收编不再直推统一走-mailbox)
日期: 2026-08-10
基于: exploration.md

---

## 0. 依赖与环境事实(全部实测,非转述)

| 事实 | 证据 |
| -- | -- |
| C 单(FLY-1572,合表)已 Done,PR #780 已 merge | Linear 状态 + `packages/flywheel-comm/src/mailbox-schema.ts` 在 main |
| **生产 11 个 shard 全部已在 mailbox,`lead_inbox` 表已不存在** | 逐库只读查询:`flywheel` 7,683 行、`growth` 105 行等;`lead_inbox_table=0` 全部 shard |
| D 单(FLY-1573,租约/合批/死信)**还在 Backlog**,与本单并行 | Linear 状态;`~/Dev/flywheel-FLY-1573` worktree 干净、无文档(刚起步) |
| 影子收据机制在生产活跃 | flywheel shard:`carrier='external'` 行 452(ACKED 290 / DEAD 162),最近一条 2026-08-08 founder→flywheel-eng-lead |
| `mailbox` 表**仍有 `carrier` 列**(`'inbox'|'external'`) | `mailbox-schema.ts:41` + 四个 partial index 按 `carrier='inbox'` 过滤 |
| Bridge 已有门铃端点 `/api/lead-inbox/nudge`(Bearer token) | `plugin.ts:2263-2281`,`tokenAuthMiddleware(config.apiToken, ...)` |
| Discord 插件进程已持有 `BRIDGE_URL` + `TEAMLEAD_API_TOKEN` + `LEAD_ID` + `PROJECT_NAME` | 插件 `server.ts:353-356`(reply-guard 调用已在用同一组 env) |
| Codex TUI runtime 已托管 mailbox 最后一公里;headless 缺失 consumer | TUI:`codex-lead-tui-runtime.ts:612-758`;headless `codex-lead-runtime.ts` 无 `CodexLeadInboxServer`(实施记账) |
| 同链路延迟实测:Runner 报告经 mailbox → Lead 眼前 2~3.5s | FLY-208 QA 真机重放记录(vs 事故前 9 分钟) |

## 1. 现状代码审计 — 直推链路逐跳

### 1.1 Claude Lead(Discord 插件 fork,部署于 `~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/`)

入站主函数 `handleInbound(msg)`(`server.ts:1524-1704`),顺序:

| # | 步骤 | 位置 | E 是否动它 |
| -- | -- | -- | -- |
| 1 | `gate(msg)`:allowlist / pairing / core-channel / reply-guard / mention 判定 | `server.ts:712-830` | ❌ 不动 |
| 2 | Roundtable 路由:顶层消息 chat_id 改写进 topic thread(FLY-314) | `server.ts:1541-1585` | ❌ 不动 |
| 3 | permission-reply 拦截(`yes/no <id>` → 结构化事件,不是聊天) | `server.ts:1593-1608` | ❌ 不动 |
| 4 | 附件元数据收集(不下载) | `server.ts:1613-1622` | ❌ 不动 |
| 5 | **`chatReceiptRuntime.begin(args)`** → spawn `flywheel-comm chat-receipt begin` → `beginChatReceipt()` → `MailboxQueue.enqueue({carrier:'external', type:'external_delivery', id:'chat:<leadId>:<msgId>', fromAgent:'founder', priority: founder?0:1})` — **影子行** | runtime `:131`;`chat-receipt.ts:163-209` | ✅ 分叉点 |
| 6 | typing keepalive + ack reaction | `server.ts:1650-1660` | ❌ 不动 |
| 7 | **`chatReceiptRuntime.deliver(args)`** → `notify()` = MCP notification `notifications/claude/channel`(meta 带 chat_id/message_id/user/ts/附件)→ **直推进 Lead 上下文**(Lead 看到 `<channel source="discord" ...>`)→ 内联 `complete()` → `markExternalDelivered`(external 行 → ACKED) | runtime `:172-185`;`mailbox-queue.ts:404-425` | ✅ 分叉点 |
| 8 | Lead 用 reply 工具回复 → 插件 reply handler → `settle(messageId, replyId)` → processed evidence(write-ahead intent + settle CLI) | runtime `:187+` | ✅ ON 时不再产生(见 §3.4) |
| 9 | 重投 worker `reconcilePendingPass()`:轮询 `chat-receipt pending`(= `listExternalPending()`,只看 `carrier='external'` 未 ACKED),重发 + complete;FLY-1646 后有 replay-bound | runtime `:420-483` | ✅ ON 行对它不可见(carrier 隔离) |
| 10 | begin 失败 → spool intent 文件 + **照样直推**(fail-open:founder 可用性 > 记账) | runtime `:131-160` | ✅ ON 语义反转(见 §3.5) |

**要点:今天的「投递真相」在第 7 步(MCP notification),mailbox 里那行只是账。** 第 9/10 步是缝合两本账的机器 —— FLY-1646 风暴的确切位置(谓词 `listExternalPending` 少了一道闸,重投循环失去终止条件)。

### 1.2 Codex Lead(TUI,生产 = Mufasa)

`codex-lead-tui-runtime.ts:548-660`:

```
RestPollDiscordInboundSource(per-channel cursor)
  → mention-gate(共享频道点名判定)
  → LeadInputRouter.route(entry)          ← 直推等价物:排进 journal、注入 TUI turn
  → onEntryCompleted(entry)
      → ExternalReceiptSaga.handle()      ← 影子行:begin 写 carrier='external'
                                             (type='external_delivery', from='discord-cross-department')
  → boot 时 saga.reconcile() 收敛悬挂行
```

同一个「直推 + 影子行」形态,只是载体从 MCP notification 换成 TUI turn。

### 1.3 收编后要走的现成流水线(C 单已在生产)

```
MailboxQueue.enqueue(carrier='inbox', recipient_kind='lead', msg_class='model', state=QUEUED)
  → LeadInboxLoop(每 Lead 一个;活跃 1s / 空闲 30s;nudge() 立即 tick)
      claimLeadBatch(打批,当前一 tick 一批,maxBatchSize 默认 10,000)
  → LeadDeliveryAdapter.deliverBatch()
      Claude: writeMailboxBatch → inbox.json + sidecar → Lead 官方 poller 注入
      Codex : unix socket → CodexLeadInboxServer(TUI/headless 唯一 owner 托管)→ journal → turn
  → durable-accept receipt → markAuditDelivered → ackBatch(C 期口径:ACKED)
  失败:recordLeadDeliveryFailure(退避重试,maxModelAttempts=5,death→quarantine 告警)
```

投递内容渲染:`[receipt:<delivery_id>]\n<content>`(`lead-inbox-loop.ts:323-330`)。
**入队即 nudge** 是既有惯例:`LeadInboxRuntime.enqueueLeadEvent()` 写完行立刻 `nudge(leadId)`(`lead-inbox-runtime.ts:223-235`)。跨进程等价物 = `POST /api/lead-inbox/nudge`。

### 1.4 生产 mailbox 实况(flywheel shard,只读)

```
carrier='inbox'  :question ACKED 2450 / DEAD 1544;instruction LEASED 101 …(正常流水)
carrier='external':external_delivery ACKED 290 / DEAD 162(影子账)
```

## 2. 「谁在读 external 行」盘点(删除面 = 清理单的清单)

| 读者 | 位置 | 作用 |
| -- | -- | -- |
| 插件重投 worker | `chat-receipt-runtime.ts:420+` → `chat-receipt pending` → `listExternalPending()`(`mailbox-queue.ts:460-470`) | 补投 begin 了但没 complete 的行 |
| `markExternalDelivered` | `mailbox-queue.ts:404-425` | complete 的落地写(唯一把 external 行推进 ACKED 的写者) |
| `settleChatReceipt` / `quarantineChatReceipt` | `chat-receipt.ts:230-333` | 回复证据 / 毒行隔离 |
| `ExternalReceiptSaga`(begin/handle/reconcile) | `lead-backends/codex/ExternalReceiptSaga.ts` | Codex 侧同套账 |
| 投递环 | 四个 partial index 全部 `WHERE carrier='inbox'` | **对 external 行结构性视而不见**(这是双轨共存能安全的根据) |

## 3. 收编方案的技术依据(逐条对应 plan)

### 3.1 分叉点唯一化

两个后端各只有一个「投递动作」位点(§1.1 第 5+7 步合并成一个函数调用、§1.2 的 router 入口)。flag ON 时该位点改为:

```
enqueue({ carrier:'inbox', recipient_kind:'lead', msg_class:'model',
          type:'discord_chat', id:'chat:<leadId>:<discordMessageId>',
          from_agent:<founder|lead-id|discord-cross-department>,
          priority:1(保持 Discord 到达 seq,不按发件人重排),
          collapse_key:null,
          content:<含 route/附件真相的 machine envelope>,
          delivery_content:<复刻直推格式的干净 <channel> 文本> })
→ POST /api/lead-inbox/nudge(尽力而为,失败只记日志 —— comm.db 是权威,丢 nudge 最多慢一个 tick)
→ 结束(不 notify、不 complete、不 settle、不进重投 worker)
```

- **幂等**:`id` 沿用 `chat:<leadId>:<messageId>` 决定论构造;`MailboxQueue.enqueue` 对重复 id 返回 archived/已存在 → Discord Gateway 重连重放同一条消息不会双投。
- **优先级**:Discord 统一为 1,仍抢在普通 lead event(priority 2)前面,但允许用户与 founder 在同会话里严格按 seq 出现。

### 3.2 内容格式:复刻直推

MCP notification 的 meta(chat_id / message_id / user / user_id / ts / attachments)如今由 claude-code 渲染成 `<channel source="discord" ...>` 标签注入。收编后由**发送端**把同等信息渲染进 mailbox `delivery_content`;Claude 最后一公里写 raw delivery content,所以 mailbox id 在 `<channel receipt_id="...">` 里;Codex model batch 另有既有 `[receipt:<delivery_id>]` 头。Lead 的回复纪律零改动。DB `content` 单独持久化 resolver 已算好的 `replyChannelId/replyRoute` 与附件 machine envelope,供 Bridge claim/socket/journal 恢复;claim 从 envelope 导出 route key,不同 route 不合批,不借用预留的 `collapse_key`。

### 3.3 flag:`FLYWHEEL_MAILBOX_DISCORD`

- 极性:**opt-in**(`=== '1'` 才 ON),缺省 OFF = 字节等价旧流 —— 与 FLY-709 registry 的 opt-in 习语一致;
- 读法:**每条入站消息现读 `~/.flywheel/.env`**(registry 时序类 `dotenv_live`)。插件与 Codex runtime 都是独立长活进程,process.env 是启动快照,不满足「运行时可切」;dotenv 现读一行即可全舰队即时切换;
- 注册:进 `packages/config/src/feature-flags/registry.ts`(声明 read-site 与 timing,受 drift scanner 管);
- 寿命:验证窗后由全家族清理单删除(连同 §2 全表)。

### 3.4 ON 路径下 settle/processed 语义去哪了

影子机制里 settle 记「Lead 回了这条」的证据。收编后:
- 队列层:行在 durable-accept(C 期)/ agent-ack(D 后)即 ACKED —— 队列只管「送到没送到」(总纲铁律 1);
- 「回没回」的把门:reply-guard Stop hook(既有)继续拦「没回复就想停」;「办没办」的账本 = F 单 task 表(在 ack 事务里自动建)。E 不需要为 settle 造替代品 —— 造了反而违背铁律 1。

### 3.5 fail 方向反转(必须在 plan 里写死并测死)

- 旧流 fail-open:「记账失败 → 照样直推」(可用性优先,代价是账缺一行);
- 新流唯一入口:**enqueue 失败 = 投递尚未提交**。插件在第一次 CLI 前先落 durable ingest intent,无权威 verdict 就保留 intent 按有界退避重放;Codex RestPoll 以 cursor 不前移作 durable NACK。**ON 绝无 fallback raw 直推**,flag OFF 才是唯一旧流逃生口。

### 3.6 硬检查(mailbox id)落地口径

1. Codex 内容带 `[receipt:<delivery_id>]`;Claude `<channel>` 带 `receipt_id=<delivery_id>`;
2. 对账查询:Claude sidecar flywheelId / Codex journal batch member id ⟕ `mailbox.delivery_id`;
3. ON 分叉的结构测试证明无 lane verdict 保护的 raw notify/router.submit 调用不可达。

## 4. 延迟预算(验收 5 的定量依据)

| 段 | 旧(直推) | 新(mailbox) |
| -- | -- | -- |
| 适配器 → Lead 可见 | MCP notify,亚秒 | enqueue(~ms)+ nudge(HTTP,~ms)+ 投递环 tick(nudge 后立即)+ adapter 写 inbox.json(~ms)+ Lead 官方 poller 注入(秒级) |
| 实测同链路 | — | 2~3.5s(FLY-208 真机:Runner 报告到 Lead 眼前) |
| 最坏(nudge 丢失) | — | ≤30s(空闲 tick 兜底;有新行后转 1s 活跃档) |

typing indicator(第 6 步,不动)从收到消息起持续到 reply,UX 上盖住 2~3.5s 间隙。**QA 必须实测 ON 前后 founder 观感延迟并给数**。

## 5. 风险清单

| # | 风险 | 缓解 |
| -- | -- | -- |
| R1 | 翻转窗口双轨:OFF 期欠账(external pending)在 ON 后仍需收尾 | 重投 worker 只认 `carrier='external'`(现状谓词),ON 行结构性不可见;flip 前跑一次 `chat-receipt pending` 清账(runbook 步骤) |
| R2 | nudge 端点鉴权失败(env 缺)→ 30s 最坏延迟 | 插件 env 已实测持有 token(reply-guard 同源);缺 env 时记日志并依赖 tick 兜底,不 fail |
| R3 | Codex socket 不在(TUI/headless 重启窗口)→ 通用 model lane 5 次后静默 DEAD | headless 补同构 consumer + typed/retrying 常驻 socket-owner 锁与认证 live probe;helper unavailable 时 OFF 仅 legacy Discord fail-open并持续告警;暂态 `discord_chat` 不耗尽,确定性 poison 先告警再 quarantine |
| R4 | Lead 官方 poller 对「非 bridge 来源」内容的注入形态差异 | content 由我们渲染,poller 只是搬运文本;QA 真机验 `<channel>` 形态与 reply 工具可用性 |
| R5 | 罕见类型(DM、attachment-only、permission reply)走错道 | permission reply 在分叉点之前拦截(不变);DM/attachment 全走信道,附件仍是元数据+按需下载 |
| R6 | flag 极性/读点写错 → 「以为 OFF 其实 ON」 | registry 声明 + reverse-compat 哨兵测试(OFF = 逐字节旧行为);QA ON→OFF→ON 三段真机 |

## 6. 与 D 单(FLY-1573)的接口约定(并行开发不打架)

- E 写入队侧普通行,并补两个 Discord 正确性 fence:从 machine envelope 导出的同 route 才可合批、D 未接管前 `discord_chat` 不静默 DEAD;不实现租约/60s 窗/通用死信闸;
- D **只改投递环与状态机**:租约/合批窗/死信闸对「从哪来的行」无感 —— E 的行天然被 D 的能力覆盖;
- 两单共享 mailbox 行语义(C 单 schema,双方都不改列);E 不占预留 `collapse_key`,route 真相留在 machine envelope。
- 验收交叉项:E 的验收 2(60s 合批)在 D 合入后才可完整验证;E 先落地时按 C 期语义验「同 tick 到达合为一批」。
