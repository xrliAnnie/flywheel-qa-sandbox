# FLY-1426 入站消息 generic 收据 — 调研
Issue: FLY-1426 (https://linear.app/geoforge3d/issue/FLY-1426/infrabug3-founderlead-discord-chat-零-durable-收据-入站消息-generic-收据)
日期: 2026-07-22
基于: exploration.md

> 方法：全部结论带 `file:line` 锚点；运行时事实读**活进程 env**（非代码默认值），已做阳性对照。

## 1. 现行收据机器 API 面（FLY-1392 已 merge，全部现成可复用）

### 1.1 入账（producer 只需调这个）

`LeadInboxQueue.enqueue(EnqueueLeadInboxInput)`（`packages/flywheel-comm/src/lead-inbox-queue.ts:75-95, 486-575`）：
- **caller-supplied `id`**（幂等：`INSERT OR IGNORE` + 同 id 异字段抛错 `:552-573`）；
- `carrier: "external"` 直接支持（`:491-493` 校验）；
- `priority` 显式（P0–P3，缺省 P2）；`refMessageId`（UNIQUE 偏索引 = 二级幂等键）；
- 入账时 `delivered_at`/`next_unprocessed_at`/`receipt_episode_id` 均为 NULL —— pending 态。

### 1.2 delivered 转换（external 族）

`markExternalDelivered(id, {now, receiptWindowsMs})`（`lead-inbox-queue.ts:684-720`）：
- CAS `carrier='external' AND delivered_at IS NULL` → 同一 UPDATE 写 `delivered_at + consumed_at + disposition='external_delivered' + next_unprocessed_at = now + priorityWindow`；
- 幂等（已 delivered 返回 true `:711-717`）；pending 行**永不被 queue 承运面选中**（`countPending :312` 只看 carrier='inbox'）。

### 1.3 追办（零改动即覆盖新 lane）

- patrol：`LeadReceiptPatrol.pass()`（`packages/teamlead/src/bridge/lead-receipt-patrol.ts:47-98`，GatePoller 每 ~60s）每轮先 `reconcileReceiptActivation` 再 `advanceDueUnprocessedReceipts` 再 drain alerts。
- **episode 收养**：`reconcileReceiptActivation`（`db.ts:3411`）把「delivered ∧ 未 processed ∧ episode NULL」的行盖上 active episode 印章（`db.ts:~3615-3626`：`UPDATE lead_inbox SET receipt_episode_id = ? ... WHERE receipt_episode_id IS NULL`）→ 新 producer 的行**自动**进入追办 cohort，无需自己管 episode。
- 追办选择器（`db.ts:3798-3812`）：纯状态谓词（resend_of NULL / processed NULL / delivered 非 NULL / escalated NULL / next_unprocessed_at 到期 / 非豁免 / 非 disposed）—— **零类型**，对 carrier 无歧视。到期 → 物化 resend child（carrier=inbox，经 LeadInboxLoop 真投 Lead 收件箱）→ 超 `resendCap`（默认 2，env `FLYWHEEL_RECEIPT_RESEND_CAP`）→ `receipt_unprocessed` alert。
- 窗口：P0/P1=30min、P2=240min、P3=24h（`lead-inbox-queue.ts:14-19`，env `FLYWHEEL_RECEIPT_WINDOW_P<n>_MIN`）。

### 1.4 升级（到 founder）

patrol `notifyUnprocessed`（`packages/teamlead/src/bridge/plugin.ts:7831-7862`）→ `detection_escalation` 状态机（`bridge/detection-escalation.ts`）：Lead-first → 30min grace（`DEFAULT_DETECTION_LEAD_GRACE_MS :273`）→ founder page（issue thread @founder）→ 每 episode 恰一次 + fleet 聚合（≥4 同类进聚合工单）。**issue 验收的「超时升级」链路现成。**

### 1.5 Lead 办结（收据关闭）

- CLI `flywheel-comm handle-receipt`（`commands/handle-receipt.ts`）→ `db.handleReceipt`（`db.ts:2393-2470+`）：动作 `relay/respond/no-route/ack`；**对任意 receipt row 通用**（含 external）；要求 `delivered_at` 非空、`to_lead === authenticatedLead`、有效 Lead lease；per-request 幂等（requestId + payload digest，冲突→`idempotency_conflict`）。
- 授权 auto-settle 先例：`ExternalReceiptSaga.handle`（`lead-backends/codex/ExternalReceiptSaga.ts:70-99`）直接 `markProcessed` + typed evidence（`kind:"journal_outbound", basis:["journal_inbound_turn_outbound"]`）—— evidence 类别①（可证明因果）可由 transport 侧代码直写，无需经 handle-receipt。
- evidence 形状：`ProcessedEvidenceV1 {v,kind,ref,actor,actor_kind,fence,basis}`（`lead-inbox-queue.ts:137-147`）。

### 1.6 saga/孤儿 reconcile 先例

`ExternalReceiptSaga.reconcile`（`ExternalReceiptSaga.ts:101-160`）：`listExternalDeliveryPending`（`lead-inbox-queue.ts:722-740`）→ journal 反查：在→补 delivered；watermark 后确证缺席→`markExternalAborted`；journal 不可读→`quarantineExternalDelivery`（绝不盲删，R3#3）。patrol 的 alert drain 已认 `external_saga_unknown` kind（`lead-receipt-patrol.ts:105-113`）。

## 2. Discord 插件侧事实（Claude Lead 腿）

### 2.1 运行时真相（活进程实证 2026-07-22）

- **运行路径 = cache 目录**：`~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts`（1583 行 fork 版，含 allowBots/roundtable/mention 补丁）；8+ 个活 bun 进程逐一确认 argv。⚠️ marketplace 目录副本是 900 行 stock 旧版（≠运行时），旧 memory「从 marketplaces 运行」已过时。
- **运行时 = bun**（`.mcp.json`: `bun run start`）→ 不能加载 better-sqlite3 等 native node 模块；但可以 `Bun.spawn(["node", ...])`。
- **活插件进程 env 实测**（Tadashi 的插件进程，`ps eww`）：
  `FLYWHEEL_COMM_DB=~/.flywheel/comm/flywheel/comm.db` · `FLYWHEEL_COMM_CLI=<flywheel>/packages/flywheel-comm/dist/index.js` · `FLYWHEEL_LEAD_ID=flywheel-eng-lead` · `BRIDGE_URL=http://localhost:9876` · `DISCORD_OWNER_USER_ID=1138241636057481306` —— **收据 producer 需要的所有信息已在插件进程内**，零新接线。

### 2.2 accept 边界（唯一注入点）

`messageCreate` handler（server.ts fork 版 ~:1440-1576）：
```
gate()（channel opt-in / allowFrom / allowBots / requireMention+mentionPatterns）
→ roundtable 入站路由（FLY-314，可改 chat_id）
→ permission-reply 拦截（结构化 permission 事件，非 chat，early return）
→ typing keepalive + ack reaction
→ mcp.notification('notifications/claude/channel', {content, meta:{chat_id, message_id, user, user_id, ts, attachments…}})
   —— fire-and-forget，失败仅 stderr（:1558-1576）
```
gate() 的 implicit-mention（回复 bot 自己的消息算点名）依赖插件进程内 `recentSentIds` + `fetchReference` —— **accept 判定只在插件进程内可完整复现**（第二读者必然漂移，佐证 FLY-1392 R1#6「记账判定=transport 自身 accept 判定」）。

### 2.3 plugin→Bridge HTTP 先例

出站 reply-guard：`POST ${process.env.BRIDGE_URL}/api/discord/reply-guard`（server.ts:314-396），带 FLY-173/314 fail-open（core/roundtable）/fail-closed（issue 文本）分档。证明 fork 内做 HTTP + 失败分档是既有模式。

### 2.4 分发链路（fork 改动怎么上生产）

fork repo `xrliAnnie/claude-plugins-official`（本机镜像 `~/.flywheel/repos/claude-plugins-official`，近史含 FLY-898/314/676/576/569 补丁）→ PR merge → `update-discord-plugin.sh` rsync 到 cache+marketplace → `check-discord-plugin.sh` 为 lead 启动 preflight（断言 allowBots + fork SHA）。**插件进程随 Lead session 重启才加载新代码**（bun 进程是 Claude Code 的 MCP 子进程）。

## 3. 方案收敛

### 3.1 结构：方案 A（插件 accept 边界记账，镜像 ExternalReceiptSaga）✅

exploration §4 的 B（Bridge 第二读者）因 accept 判定漂移否决；C（整体迁移 gateway 承运）因破坏现有插件体验+改动面否决；D（hook）因无 begin/complete 两相+触发未证否决。A 与 FLY-1392 已批设计同构：

```
begin：gate() deliver 判定后、notify 前 → enqueue(id=chat:<leadId>:<msgId>, carrier=external, pending)
complete：notification promise resolve 后 → markExternalDelivered（开追办窗）
settle：Lead reply(reply_to=入站 msgId)（证据①）或 handle-receipt ack/relay
逾期：patrol resend（现成）→ receipt_unprocessed → detection-escalation → founder page（现成）
```

### 3.2 写入通道：A1（spawn node CLI）vs A2（POST Bridge）

| 维度 | A1 `Bun.spawn(["node", $FLYWHEEL_COMM_CLI, "chat-receipt", …])` | A2 `POST $BRIDGE_URL/api/…` |
|---|---|---|
| Bridge down 时 | **照常记账**（直写 comm.db；patrol 恢复后接着追） | 记账丢失,需本地 spool + drain（新机器） |
| 新增面 | flywheel-comm 新子命令（本仓，全逻辑可测） | Bridge 新端点 + 鉴权面 + spool 协议 |
| 一致性 | 与 Codex saga 同构（transport 进程直写 comm.db 是既有惯例——runner CLI 同样直写） | Bridge 中转是新形态 |
| 延迟 | ~100-300ms node 启动 ×2 次/消息（founder chat 低频，可接受；complete 可 fire-and-forget） | ~10ms,但可用性换的 |
| 失败面 | node/dist 缺失（launcher 已探测并 export,缺失即无 env → 优雅降级） | Bridge 可用性耦合 |

**推荐 A1**。fail-open 红线：begin 失败（spawn 错误/超时/非零退出）→ 记 stderr + **消息照样投递**（founder chat 可用性 > 记账），一致于 reply-guard fail-open 精神；begin 成功是常态路径，保住「先落 queue 再进对话」的 founder 裁定顺序。

### 3.3 各设计问题的答案

| # | 问题（exploration §5） | 结论 |
|---|---|---|
| 1 | enqueue 支持面 | ✅ caller id + carrier=external + 显式 priority 全支持（§1.1） |
| 2 | 办结适配 | `handle-receipt` 对 external 行原生可用（§1.5）；收据 id 经 notification `meta.receipt_id` 呈现给 Lead（渲染进 channel 标签,Lead 可直接引用） |
| 3 | auto-settle | Lead `reply(reply_to=<入站 msgId>)` 时插件观察到 explicit reply reference → CLI `settle`,evidence `kind:"discord_explicit_reply", ref:<出站 msgId>, actor:<leadId>, actor_kind:"lead", basis:["discord_reply_reference"]` —— FLY-1392 §2.4b 证据①；同频道非 reply_to 回复**不** settle（R1#7 禁止时间接近推断） |
| 4 | pending 孤儿 reconcile | Claude 腿无 journal 可反查。插件自身即「journal 等价物」：**启动时 reconcile** —— 对本 lead 的 `listExternalDeliveryPending` 行,经 Discord REST 按 msgId 重取消息,gate() 重判后**重投递**（notify + complete）,取不到（已删）→ `markExternalAborted`；插件不在场时 patrol 只发 `external_saga_unknown` advisory（现成 kind,绝不盲删）——细化进 plan |
| 5 | priority | `msg.author.id === DISCORD_OWNER_USER_ID` → P0；其余（他 lead bot/外人过 gate）→ P1。env 已在插件进程（§2.1） |
| 6 | 双 lane 重叠 | founder 在 issue thread 内消息:founderReplyDeliverer（Bridge poll,thread 维度）与插件（要求 thread 父频道 opt-in 且 @点名）可同时投递 → 两次真实 delivery = 两行,FLY-1392 不变式下合法;id 前缀不同（`founder_msg:` vs `chat:`）不冲突。生产 access 配置下 core channel requireMention=true,重叠仅发生在显式 @ 场景,接受并写进诚实边界 |
| 7 | QA 隔离 | 插件继承 Lead env;QA slot 覆盖 `FLYWHEEL_COMM_DB`/`BRIDGE_URL` per slot → 记账天然进隔离库,零专门处理 |
| 8 | permission-reply | 不入账:未作为 chat 投递给模型,由 permission 机器消费且有 ✅/❌ reaction 可见回执 —— 记为刻意边界（同 FLY-1392「非真实投递」豁免精神,但无需豁免行:根本不 enqueue） |

## 4. 改动面清单（→ plan）

| 仓 | 改动 | 量级 |
|---|---|---|
| flywheel（本仓） | `flywheel-comm` 新子命令 `chat-receipt`（begin/complete/settle/reconcile-list/abort,薄封装 §1.1-1.2 API + evidence 构造） | 小 |
| flywheel（本仓） | patrol/alert 面**零改动**（episode 收养+追办+升级全自动覆盖）;可能补 `external_saga_unknown` payload 的 lead 归属字段(若缺) | 零~微 |
| plugin fork | messageCreate 内 begin/complete 两相 + reply handler 内 settle 观察 + 启动 reconcile + fail-open 降级 | 中（~150-250 行） |
| 文档/规则 | Lead 规则:收据 id 语义 + `handle-receipt ack` 用法(不 reply 时如何关账) | 小 |

## 5. 留给 plan 的裁量

1. `chat-receipt` 子命令参数面与错误码；begin 是否内联 complete(单命令两相 vs 两命令)——倾向两命令保 crash 窗口语义。
2. 启动 reconcile 的节流与安全阈（重投上限、只回看 N 小时）。
3. fork 与本仓的合入顺序（CLI 先行,fork 后行——fork 调不存在的子命令必须优雅失败）。
4. 真机验收脚本形态（issue 验收:founder chat 一条真实消息全链）。
