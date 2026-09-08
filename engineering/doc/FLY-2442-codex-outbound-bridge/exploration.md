# FLY-2442 Codex Lead 出站改走 Bridge + mailbox→适配器合同 — 探索
Issue: FLY-2442 (https://linear.app/geoforge3d/issue/FLY-2442/通路codex-codex-lead-出站改走-bridgelauncher-配置-mailbox-harness)
日期: 2026-09-08
基于: 无

## 0. 一句话

Codex Lead(Mufasa)现在拿自己的 bot token 直发 Discord;代码里早就有一条经 Bridge 代发的出站,只是 launcher 没打开。打开它有一个真障碍:runtime 对「bridge 模式 + 跨部门频道」硬 throw,而 Mufasa 配了 #leads-roundtable。本设计解决这个障碍,然后翻 launcher,并把「mailbox → 最后一跳适配器」写成一页合同。

## 1. 审计:出站现状(逐行核过,2026-09-08 本机)

### 1.1 Mufasa 今天怎么出站

| 事实 | 位置 |
|---|---|
| launcher 默认 `FLYWHEEL_CODEX_LEAD_OUTBOUND=direct`,注释原话 *bypasses Bridge outbound authorization* | `packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh:101-104` |
| 同一 launcher 配了跨部门频道 `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS`(#leads-roundtable `1512578695468941333`),聊天频道 `FLYWHEEL_LEAD_CHAT_CHANNEL_ID`(#mufasa `1500600400238084307`) | 同文件 `:59-61` |
| 生产 launchd job `com.flywheel.lead.growth-mufasa-lead` → `~/.flywheel/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh` → source `~/.flywheel/.env` → exec 主仓 `/Users/xiaorongli/Dev/flywheel` 下的这个 launcher | plist ProgramArguments;wrapper `:8-22` |
| 生产日志三次启动 banner 都是 `outbound=direct` | `/tmp/flywheel-lead-growth-mufasa-lead.log` |
| runtime 解析:非 `"bridge"` 一律 direct;Bridge URL/token 只在 bridge 模式必填 | `codex-lead-runtime.ts:528-529`, `:547-553` |
| **硬门**:`crossDeptChannelIds.length > 0 && outboundMode === "bridge"` → throw,注释原话 *buildAuthorizeLeadChannel authorizes only the Lead's chatChannel + project generalChannel, so a roundtable send 403s and the journal row goes ambiguous … server-side shared-channel authorization for bridge mode is a follow-up* | `codex-lead-runtime.ts:619-633`;测试 `__tests__/codex-lead-runtime.test.ts:230-242` |
| sender 二选一:bridge → `CodexOutboundSender`,否则 `DirectDiscordOutboundSender` | `codex-lead-runtime.ts:1592-1604`;TUI 同形 `codex-lead-tui-runtime.ts:583-595` |
| direct 的代价(模块注释):dedup 只是进程内 sent-marker,跨重启无持久去重;*Switch to CodexOutboundSender (FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge) for production exactly-once* | `DirectDiscordOutboundSender.ts:8-13`;实际直发 `:92-98` |

### 1.2 经 Bridge 的出站已经存在(两端都在,从未在生产通电)

| 事实 | 位置 |
|---|---|
| 客户端:持久 outbox(better-sqlite3,`<stateDir>/outbox.db`),`enqueue` 按 idempotencyKey 幂等,`deliver` POST `/api/lead-outbound/send`,带 `idempotencyKey` + 确定性 `nonce` | `CodexOutboundSender.ts:107-121`, `:133-164`, `:171-209`;路径 `codex-lead-runtime.ts:890` |
| 服务端:route 只在 `config.apiToken` 存在时挂载,`tokenAuthMiddleware` 守门 | `bridge/plugin.ts:3059-3084` |
| 服务端 handler:401 → 400 校验 → **403 `lead_channel_unauthorized`** → 持久去重(SENT 返回旧 messageId;IN_FLIGHT → 409 ambiguous;原子 claim)→ 服务端解析该 Lead 的 token 发送 | `CodexLeadOutboundHandler.ts:139-218`;`leadDiscordSend.ts:28-55` |
| 授权集 = `(projectName, leadId)` → `{lead.chatChannel, project.generalChannel}`,**没有 roundtable** | `codexLeadBridgeWiring.ts:49-66` |
| 去重库 `~/.flywheel/codex-lead-outbound-dedup.db` 表 `outbound_dedup`:今天 **0 行**(证明这条路生产从未用过) | `SqliteOutboundDedupStore.ts:31-49`;`sqlite3` 查询 |
| Bridge 的 apiToken 来自 `TEAMLEAD_API_TOKEN` | `packages/teamlead/src/config.ts:57` |
| runtime 在 bridge 模式要的是 `FLYWHEEL_API_TOKEN`;`~/.flywheel/.env` 里有 `TEAMLEAD_API_TOKEN` 和 `FLYWHEEL_BRIDGE_URL=http://127.0.0.1:9876`,**没有** `FLYWHEEL_API_TOKEN` | `.env` 键名核对;`run-codex-lead-mufasa-fullaccess.sh:84-88` 注释也提到这个别名 |
| Mufasa 在 projects.json:`chatChannel == growth.generalChannel == 1500600400238084307`。所以今天 Bridge 对 Mufasa 的授权集只有 #mufasa 一个频道 | `~/.flywheel/projects.json` |
| Bridge 自己知道 roundtable:`FLYWHEEL_ROUNDTABLE_CHANNEL_ID=1512578695468941333`(与 Lead 的 cross-dept 同值) | `bridge/roundtable/roundtable-config.ts:76`;`.env` |

### 1.3 回复会落到哪些频道(授权集必须覆盖的范围)

- 普通聊天:`channelId` 省略 → sender 默认 chat 频道(`LeadInputRouter.ts:332-339`)。
- 跨部门(roundtable 顶层):`replyChannelId` = 入站来源频道(`CodexDiscordGateway.ts:211-213`)。
- roundtable 话题**线程**(FLY-314,Mufasa 生产默认开:FLY-1243 之后「有可解析的 roundtable 父频道」即开,`codex-lead-runtime.ts:646-660`):`replyChannelId` = 线程 id(`roundtable-reply-route.ts:34,105`)。线程 id 不是配置里的任何频道,授权必须能认「父频道属于授权集的线程」。

### 1.4 还有一条直发路径不在本单范围

主动发言 `lead_actions.discord_send`(FLY-350):MCP 子进程用按名注入的 bot token 直发,alias 服务端解析,metadata-only 审计 jsonl,进程内限速+幂等(`discord-send-core.ts:1-23`;`lead-actions-main.ts:60-110`)。它绕过 `LeadInputRouter`,不走 outbox。本单只改**回复**出站;主动发言留在 honest boundary。

## 2. 审计:入站四段(合同页的素材)

两个 harness 共用前三段,只在第四段分叉。

| 段 | Claude Lead | Codex Lead | 共同点 |
|---|---|---|---|
| ① ingest(取信) | 插件 `flywheel-plugins/discord@0.0.6 server.ts:1593` 收 gateway websocket → 本地 spool → spawn `flywheel-comm chat-ingest` 子进程 → 可丢的门铃 `POST /api/lead-inbox/nudge`(`plugin.ts:3040-3057`) | TUI 进程内 `RestPollDiscordInboundSource`(3 秒 REST 轮询,`codex-lead-tui-runtime.ts:665`)→ `CodexDiscordGateway` → `CodexDiscordMailboxStrategy.accept` | 两边最终都调 **同一个** `ingestDiscordChat`(`flywheel-comm/discord-chat-ingest.ts`),写同一张表 |
| ② mailbox(CommDB) | 同 | 同 | `mailbox` 表(`mailbox-schema.ts:193` `MAILBOX_CORE_SCHEMA`):`recipient_kind ∈ {lead,runner,bridge}`,`msg_class ∈ {protocol,model}`,`state`/`batch_id`/`claimed_by`/`lease_retry_count`;单例 `loop_owner` 租约(`mailbox-queue.ts:1055-1080`) |
| ③ 投递泵 | 同 | 同 | Bridge `LeadInboxLoop`:活跃 1s / 空闲 30s(`lead-inbox-loop.ts:29-30`);`claimLeadBatchQueue` 批窗 30s、批上限 10、**在飞批 3**、ack 租约 30 min、租约重试 3 次后 `lease_expired_unacked` 死信(`mailbox-queue-config.ts:13-23`;`mailbox-queue.ts:2086`);拼 `[mailbox-batch …]` 头(`lead-inbox-loop.ts:444`);回执必须与冻结成员名单一致(`:471-478`) |
| ④ 最后一跳适配器 | `ClaudeLeadDeliveryAdapter` → `writeMailboxBatch` 两阶段写 JSON + `.flywheel.jsonl` 边车(`ClaudeMailboxCodec.ts:268`);Claude Code 二进制内置 poller 读(`types.ts:308` `builtin-receiver`) | `CodexLeadDeliveryAdapter` → capabilities 探测 → HMAC 签名的 `submitBatch` 走 unix socket `<stateDir>/lead-inbox.sock`(`CodexLeadInboxSocket.ts:63-65, :230-258, :341-348`)→ TUI 进程内 `router.submitBatch` → journal(`:202`) | 接口同一个:`LeadDeliveryAdapter.deliverBatch(batch) → DurableAcceptReceipt`(`lead-delivery-adapter.ts:46-54`);按 `backend === "codex-app-server"` 选型(`lead-inbox-runtime.ts:1252-1270`) |

**为什么 Codex 的第四段砍不掉(原注释,合同页要引):**
- `agent-team-transport/src/types.ts:308`:`wakeMode: "builtin-receiver" | "external-watcher" | "push-only"` —— *builtin-receiver: vendor binary polls mailbox itself (claude-code). external-watcher: needs IMailboxWatcher + tmux send-keys (codex).*
- `lead-delivery-adapter.ts:29-31`:*Codex consumes one packaged turn; Claude writes members atomically and its stock poller packages the unread snapshot into one turn.*
- `CodexLeadInboxSocket.ts:4-7`:*The Codex Lead router lives in the windowed TUI sidecar process. The Bridge therefore cannot mutate journal.db directly: doing so would durably accept a row without waking the router's in-memory pump.*
- `LeadJournal.ts:5-9`:*a Codex app-server thread can execute arbitrary shell/MCP side-effects (gh merge, flywheel-comm). On a crash, naively replaying an input could double-fire those side-effects.*

## 3. 审计里的两个「前提修正」(必须如实写给 founder)

### 3.1 「与 Claude Lead 一致」不等于「Claude 也是 Bridge 代发」

FLY-2439 v3 的 A 时序图与插件源码都证实:Claude Lead 的回复是 **插件先 `POST /api/discord/reply-guard` 问 Bridge 允不允许(`server.ts:375`),然后 `ch.send` 自己直发(`server.ts:1342`)**;Bridge 不可达时按内容分类 fail-open/fail-closed(`server.ts:420-447`,即 Epic 的 ②)。而 Codex 的 bridge 模式是 **Bridge 代发**:服务端解析 token、持久去重、403 拦截。

所以本单把「一致」定义为:**出站必须经 Bridge 授权**。Codex 用已有的代发路径(比 Claude 更强),不给 Codex 另造一套 reply-guard。已向 Lead 非阻塞确认(question `c135988f`)。

### 3.2 翻 launcher 不等于 Mufasa 立刻切换

`scripts/restart-services.sh:1936-1975 classify_changes`:`packages/teamlead/*` 只触发 **Bridge** 重启;只有 `claude-lead.sh` / `post-compact*` / `lead-rules-base/*` / `flywheel-comm/*` 才触发全体 Lead 重启。launcher 脚本改动 → Bridge 重启、**Mufasa 不重启**。Mufasa 在**下一次**重启(founder 窗口、崩溃、整机重启)时才读到新 launcher。这恰好给出安全顺序:Bridge 先带上新授权,Mufasa 后翻。但验收「Mufasa 一条回复 = Bridge 出站」需要一次 Mufasa 重启,这是 Lead/founder 窗口的操作,不在本设计节点也不在 implement 节点自作。

## 4. 方案空间

### 方案 A:翻 launcher 到 bridge,同时去掉 Mufasa 的 cross-dept(丢 #leads-roundtable)
- 零代码,只改 launcher。
- **否决**:founder 在用 roundtable(`run-codex-lead-mufasa-tui.sh:105-116` 原注释「which Annie actively uses」);把 Mufasa 从圆桌踢出去是回归,不是「一致」。

### 方案 B(选中):Bridge 侧把共享频道纳入授权,runtime 的硬门改成「向 Bridge 探测」
- Bridge 授权集 = `{chatChannel, generalChannel}` ∪ `{该 Lead 在 projects.json 声明的 roundtableChannel}` ∪ `{父频道 ∈ 前述集合的线程}`。**按 Lead 裁定(§6):只认 projects.json 里为该 Lead 声明的那一个圆桌频道,不通配、不从 Bridge 全局 env `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` 推断。** 线程父频道用 Discord REST `GET /channels/{id}` 查 `parent_id`(服务端用该 Lead 的 token),内存缓存,查不到 → 拒绝(fail-closed)。
- runtime:`crossDept>0 && bridge` 从「假定会 403 就 throw」改成「启动时对每个配置频道向 Bridge 发 `probe`(同一 route、同一授权函数、不去重不发送)」:Bridge 明确 403 → 仍 throw(配置错误,fail-loud,和今天一样);Bridge 不可达 → 有界重试后 **警告并继续**(瞬时故障不该让 KeepAlive 的 Mufasa 崩溃循环;真正的发送失败本来就会在 journal 记 ambiguous 并 error 日志)。
- launcher:默认 `bridge`;`FLYWHEEL_API_TOKEN` 从 `TEAMLEAD_API_TOKEN` 别名;`direct` 仅作显式回滚,启动 banner 大写提示。
- Bridge 加一行审计日志(project/lead/channel/status/messageId/idempotencyKey,**永不含正文**),配合 `outbound_dedup` 表与 Mufasa `outbox.db` 作验收证据。

### 方案 C:把 Lead 的 cross-dept 频道搬进 projects.json,Bridge 与 launcher 都从那里读
- 一个真源,理论上最干净。
- **不选(本单)**:要动 launcher 的频道来源、registry 解析器、Claude 侧同名 env 的消费者,超出「launcher 配置选择」的范围,且 Codex 评审条数会随范围涨(FLY-2382 教训)。记入「以后」。

### 方案 D:Codex 也做成「reply-guard 问一下 + 自己直发」(和 Claude 字面一致)
- **否决**:这是退化——放弃已有的持久去重与服务端 token,还得新写一套 guard 客户端。Epic 的方向是各 harness 都收敛到 Bridge 授权,② 是要把 Claude 的 fail-open 收紧,不是把 Codex 放松。

## 5. 范围与边界(honest boundary 草稿)

做:
- Mufasa launcher 出站默认改 bridge;runtime 硬门改探测;Bridge 授权集覆盖 roundtable 与其线程;Bridge 出站审计日志;合同页一页;founder HTML。

不做(写明):
- 不动 journal / socket / Claude 侧 reply-guard(②)/ Raya(④)。
- `codex-infra-bot-lead` 的 launcher(cross-dept = Alerts 频道 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`,不在本单授权集内)保持 direct;机制通用,但翻它是另一张单。
- 主动发言 `lead_actions.discord_send` 保持直发(FLY-350 设计,独立审计)。
- Mufasa 的实际重启(切换生效)由 Lead/founder 窗口执行;implement 与 QA 节点不自作 kickstart。
- Epic FLY-2441 引用合同页:本机 Linear key 与 MCP 均 401,由 Lead 在 Linear 补链接。

## 6. Lead 裁定(question `c135988f-a8b9-4873-8ace-821b5c633ddb`,2026-09-08)

1. 「与 Claude 一致」= **出站必须经 Bridge 授权**,不是逐字节同构;Codex 走已有 `/api/lead-outbound/send`,不另造 reply-guard。Lead 昨晚对 founder 说的是「Claude 经 Bridge 出站」,事实是「先问 reply-guard 再自己 ch.send」——合同页要把这个差异写成显式一节(已写:合同页 §5.1),Lead 据此向 founder 更正。
2. 范围 OK:只翻 Mufasa;`codex-infra-bot-lead`(Claw 席位)与 `lead_actions.discord_send` 不动,写进 honest boundary。
3. cross-dept 硬门在本单内改,三条约束:Bridge 只授权该 Lead 在 projects.json **已声明**的 roundtable 频道及其子线程(不通配);必须有阴性对照测试(未声明 → 403);启动探测遇 deterministic 403 必须 fail-loud,不许静默回落 direct。
4. 停下来的条件:若必须动 Claude 侧 reply-guard 或收据机制 → 停下报 Lead。本设计不碰这两处。
