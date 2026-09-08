# FLY-2439 Lead 通路现状 UML — 调研(逐箭头取证)

Issue: FLY-2439 (https://linear.app/geoforge3d/issue/FLY-2439/通路实证-lead-通路现状-umlclaude-lead-codex-lead-raya-文字-raya-语音-逐箭头-fileline)
日期: 2026-09-08
基于: exploration.md

> **取证纪律。** 每个行号都用 `grep -n` / `sed -n` 复核过。
> flywheel 主仓引自本 worktree(`flywheel-FLY-2439`,基于 main `790355137`)。
> 插件引自**本机实际运行的字节** `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.6/`(非 fork main)。
> raya 文字引自 PR #26 分支 `fly-2379-raya-text-chat`(scratchpad 只读克隆)。
> raya 语音引自 raya main `b1b5a64` 的 blob。
> 找不到的一律写「**未在代码中找到**」。

---

## 0. 四条通路的共同参考点

### 0.1 统一信箱(CommDB)

A 与 B 共用的那一段是 **flywheel-comm 的统一信箱 + Bridge 的 `LeadInboxLoop` 泵**
(共用范围见 §0.4);两端(入站怎么进信箱、投递怎么进大脑、出站怎么发)各走各的:

- `packages/flywheel-comm/src/discord-chat-ingest.ts:74` — `export function ingestDiscordChat(`
- `packages/flywheel-comm/src/discord-chat-ingest.ts:77` — `const queue = new MailboxQueue(args.dbPath);`(**直接打开 sqlite 文件**,不经任何服务)
- `packages/flywheel-comm/src/discord-chat-ingest.ts:114` — `return queue.claimDiscordLane({`
- `packages/flywheel-comm/src/discord-chat-ingest.ts:127` — `carrier: "inbox",`
- CLI 包装:`packages/flywheel-comm/src/index.ts:270` — `case "chat-ingest":`;`:118` 帮助行「Enqueue one Discord inbound into the unified mailbox」

DB 文件:`${HOME}/.flywheel/comm/${project}/comm.db`(env `FLYWHEEL_COMM_DB`)。

### 0.2 Bridge 的门铃不是数据通路,而且**只有 A 会敲**

写完队列行后对 Bridge 的那次 HTTP 是**门铃**,代码注释自己声明了:

- `packages/flywheel-comm/src/lead-inbox-nudge.ts:34-36` —
  `* Best-effort doorbell for the durable Lead inbox queue. The queue row is the`
  `* authority; this request only shortens the next adaptive poll interval.`
- `packages/flywheel-comm/src/lead-inbox-nudge.ts:41-42` — `const bridgeUrl = args.bridgeUrl?.trim();` / `if (!bridgeUrl) return;`(没配就直接不敲)
- `packages/flywheel-comm/src/lead-inbox-nudge.ts:56` — `` `${bridgeUrl.replace(/\/+$/, "")}/api/lead-inbox/nudge` ``
- Bridge 侧 handler:`packages/teamlead/src/bridge/plugin.ts:3017` — `"/api/lead-inbox/nudge"`;
  `:3014-3016` 注释 —「a best-effort latency hint only. comm.db remains the authority, so a lost/duplicate nudge cannot lose or duplicate delivery.」

🔴 **门铃只存在于 A 这条路上。** 它写在 `flywheel-comm` 的 **CLI 子命令 `runChatIngest`** 里
(`index.ts:781-789`),只有 spawn CLI 的一方才会执行到。B 是**进程内直接调库函数**
`ingestDiscordChat()`(`CodexDiscordMailboxStrategy.ts:72`),函数本身不敲门铃;
`packages/teamlead/src/lead-backends/codex/` 下 `grep -rn "nudgeLeadInbox\|lead-inbox/nudge"` **零命中**(2026-09-08 复核)。

⇒ **门铃丢了不丢消息;门铃没配也不丢消息。** Bridge 在这一步是可选的加速器,而且 B 连这个加速器都没有。

### 0.4 A 与 B 到底共用了什么

共用(同一份代码、同一个 Bridge 进程):
- comm.db 的 `mailbox` 表与 `MailboxQueue.claimDiscordLane`(`discord-chat-ingest.ts:114`;表 `mailbox-schema.ts:193`)
- Bridge 的 `LeadInboxLoop` 轮询、认领、组批(`lead-inbox-loop.ts:29-30,414,444,449`)
- `LeadDeliveryAdapter` 接口与 `deliverBatch` 调用点(`lead-inbox-loop.ts:467`)

不共用:入站怎么进 comm.db(A spawn CLI + 敲门铃;B 进程内调库、不敲门铃)、
投递怎么进大脑(A 写 JSON 文件;B 走 unix socket)、出站怎么发(见 A.3 / B.2)。

### 0.3 「JSON file vs 不一样的方法」——代码里就是这么写的

founder 问的那句话在代码注释里有逐字对应:

- `packages/teamlead/src/bridge/lead-delivery-adapter.ts:29-31` —
  `/** Codex consumes one packaged turn; Claude writes members atomically and`
  `* its stock poller packages the unread snapshot into one turn. */`
- 分叉点:`packages/teamlead/src/bridge/lead-inbox-runtime.ts:1245-1271`(`createProductionAdapter`)
  - `:1252` — `if (backend === "codex-app-server") {`
  - `:1260` — `return new CodexLeadDeliveryAdapter({`  → **unix socket**
  - `:1266-1270` — `const inboxPath = transport.getInboxPath(...); return new ClaudeLeadDeliveryAdapter({ inboxPath, sidecarPath: \`${inboxPath}.flywheel.jsonl\` });` → **JSON 文件 + jsonl sidecar**
- Claude 的 JSON 路径:`packages/agent-team-transport/src/path-helpers.ts:116` —
  `return join(getClaudeTeamsDir(), safeLead, "inboxes", \`${safeAgent}.json\`);`
- Codex 的 socket 路径:`packages/teamlead/src/lead-backends/codex/CodexLeadInboxSocket.ts:64` —
  `return join(stateDir, "lead-inbox.sock");`

后端选择来自 `projects.json` 的 `backend` 字段(实测 2026-09-08:`mufasa-lead` 与
`codex-infra-bot-lead` = `codex-app-server`,其余 14 个 Lead 无 `backend` 字段 ⇒ Claude 分支)。

---

## A. Claude Lead 通路(以 `flywheel-eng-lead` 为例)

### A.0 进程拓扑(实测 2026-09-08T03:13Z)

活体 Lead body 的 argv:

```
64731 claude --agent flywheel-eng-lead --permission-mode bypassPermissions \
  --dangerously-load-development-channels plugin:discord@flywheel-plugins server:flywheel-inbox \
  --append-system-prompt-file ...
```

启动器写死了这两个 channel:
- `packages/teamlead/scripts/claude-lead.sh:2559` — `CLAUDE_ARGS+=(--dangerously-load-development-channels "plugin:discord@flywheel-plugins")`
- `packages/teamlead/scripts/claude-lead.sh:1060` — `DISCORD_PLUGIN_CONTRACT="discord@flywheel-plugins/v1"`(启动前校验 SHA,见 `:1109-1125` 三条拒启动分支)

**Discord gateway websocket 跑在 Lead 自己的 Claude 会话里**,不在 Bridge 里:
- `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.6/.mcp.json` —
  `"command": "/bin/bash", "args": ["${CLAUDE_PLUGIN_ROOT}/start-adapter.sh"]`
- `.../0.0.6/start-adapter.sh:44`(全文件共 44 行)— `exec bun "$DIR/server.ts"`;
  同文件 `:9-14` 注释 —「By `exec`ing into `bun server.ts`, this launcher REPLACES itself, so the adapter becomes a **DIRECT child of Claude**」
- `.../0.0.6/server.ts:1793` — `client.login(TOKEN).catch(err => {`(discord.js 网关登录)

### A.1 入站逐箭头

| # | 箭头 | 证据 |
|---|---|---|
| A1 | founder 在 Discord 频道发消息 → **Lead 会话内的 bun 适配器**(discord.js 网关 websocket)收到 `messageCreate` | 事件处理器 `plugins/.../0.0.6/server.ts:1593` — `client.on('messageCreate', msg => {`;客户端 `:494` `const client = new Client({`;登录 `:1793` `client.login(TOKEN).catch(err => {` |
| A2 | 适配器组装 `BeginArgs` | `server.ts:1719-1748` — `if (RECORDER_MODE.kind === 'enabled') { ingestArgs = buildBeginArgs(...) }` |
| A3a | 适配器**先把意图原子落盘到本地 spool**(崩溃恢复边界) | 目录 `chat-receipt-runtime.ts:92-93` — `this.spoolDir = opts.spoolDir ?? join(opts.stateDir, 'chat-receipt-spool')` / `this.ingestDir = join(this.spoolDir, 'ingest')`;写函数 `:94` — `this.writeIngestIntent = opts.writeIngestIntent ?? writeJsonAtomic`;原子实现 `:439-450`(tmp + `flag: 'wx'` + `renameSync`);调用点 `:106,:116-118` |
| A3a′ | ⚠️ **spool 写失败时会绕过持久化**:直接试一次 CLI,失败就只打一行 `discord_mailbox_ingest_unrecoverable` 并放弃 | `chat-receipt-runtime.ts:119-133` — `catch (error) { ... const command = await this.invokeIngest(args); ... if (!lane) { this.log(JSON.stringify({ event: 'discord_mailbox_ingest_unrecoverable', ... })) } return }` |
| A3b | 正常路径:**spawn `node <flywheel-comm> chat-ingest`** 子进程,正文走 stdin;**共 2 次即时尝试(即 1 次重试)**,都拿不到 lane 才转交 worker 按退避重放 spool | `chat-receipt-runtime.ts:266-274` — `const argv = ['node', this.mode.commCli, 'chat-ingest', '--db', this.mode.dbPath, ...ingestFlags(...)]`;`:407` `'--content-stdin'`;`:349` `const proc = Bun.spawn(argv, {...})`;循环 `:135` — `for (let attempt = 0; attempt < 2; attempt++) {`;退避重放 `:203-263` |
| A4 | `chat-ingest` → `ingestDiscordChat` → `MailboxQueue.claimDiscordLane` 写 **comm.db** | `packages/flywheel-comm/src/index.ts:747` — `const result = ingestDiscordChat({`;`discord-chat-ingest.ts:77,114,127` |
| A5 | 只有 `lane === "inserted_inbox"` 才敲 Bridge 门铃(**此步只在 CLI 路径存在,B 没有**) | `packages/flywheel-comm/src/index.ts:781-789` — `if (result.lane === "inserted_inbox") { await nudgeLeadInboxBestEffort({...}) }` |
| A6 | **Bridge 进程**的 `LeadInboxLoop` 轮询 comm.db(活跃 1s / 空闲 30s) | `packages/teamlead/src/bridge/lead-inbox-loop.ts:29-30` — `ACTIVE_LEAD_INBOX_INTERVAL_MS = 1_000` / `IDLE_LEAD_INBOX_INTERVAL_MS = 30_000`;实例化 `lead-inbox-runtime.ts:341`,启动 `:558` |
| A7 | 打包成一批,拼 `mailbox-batch` 头 | `lead-inbox-loop.ts:444` — `` const header = `[mailbox-batch ${batchId} | ${rows.length} messages | from ${rows[0]?.from_agent}]\nYou must ack this batch with ...` `` |
| A8 | `adapter.deliverBatch(batch)` | `lead-inbox-loop.ts:467` — `const receipt = await this.opts.adapter.deliverBatch(batch);` |
| A9 | `ClaudeLeadDeliveryAdapter` → `writeMailboxBatch({inboxPath, sidecarPath, ...})` | `lead-delivery-adapter.ts:56`(类)、`:75`(调用) |
| A10 | 两阶段落盘:先写 `.flywheel.jsonl` sidecar,再在文件锁内原子改写主 JSON 数组 | `packages/agent-team-transport/src/claude/ClaudeMailboxCodec.ts:268`(入口)、`:273` `prepareBatchSidecar`、`:283` `writeBatchMainUnderLock`、`:290` `finalizeBatchSidecar` |
| A11 | 落盘目标 = `~/.claude/teams/<lead>/inboxes/<lead>.json` + 同名 `.flywheel.jsonl` | `path-helpers.ts:116`;`lead-inbox-runtime.ts:1269` |
| A12 | **Claude Code 二进制内置的 `useInboxPoller`** 读这个 JSON 文件,把未读快照打包成一个 turn 注入模型 | `packages/agent-team-transport/src/claude/ClaudeCodeAdapter.ts:11` —「Wake mode: builtin-receiver — claude-code's internal `useInboxPoller`」;`:255` —「claude-code has builtin useInboxPoller — no external watcher needed.」;`packages/agent-team-transport/src/types.ts:308` — `wakeMode: "builtin-receiver" \| "external-watcher" \| "push-only"` |

> ⚠️ **A12 的读侧不在本仓,且不能当生产判据。** `useInboxPoller` 是 Claude Code 二进制内部实现;
> 本仓只有它的**写侧契约**和多处注释引用(`path-helpers.ts:45,107,154`、
> `mailbox-lead-runtime.ts:4,14`、`plugin.ts:795,1010`)。
> 本机另有一份源码检出 `~/Dev/claude-code`,其中 `src/hooks/useInboxPoller.ts:107` 写着
> `const INBOX_POLL_INTERVAL_MS = 1000`,`:954` `useInterval(() => void poll(), shouldPoll ? INBOX_POLL_INTERVAL_MS : null)`,
> 读路径 `src/utils/teammateMailbox.ts:56-61` 与本仓 `path-helpers.ts:116` 逐字一致。
> **但该检出 `package.json` 的 version 是 `0.0.0-leaked`,生产运行的是 `claude 2.1.263`
> ——两者版本对应关系未验证。** 因此上述间隔只作参考,不作为生产判据。

补充事实:

- 目标表:`packages/flywheel-comm/src/mailbox-schema.ts:193` — `CREATE TABLE IF NOT EXISTS mailbox (`
- DB 文件路径构造:`packages/teamlead/src/bridge/commdb-path.ts:27` — `return join(commDbRootDir(), projectName, "comm.db");`
- 出站还有一层**插件本地白名单**(不打 Bridge):`plugins/.../0.0.6/server.ts:1053` —
  `` throw new Error(`channel ${id} is not allowlisted — add via /discord:access`) ``
- 网关客户端与事件:`plugins/.../0.0.6/server.ts:494` `const client = new Client({`;`:1593` `client.on('messageCreate', msg => {`

`server:flywheel-inbox` 这第二个 channel **不负责送信**,它只提供 ACK 工具:
- `packages/inbox-mcp/src/index.ts:69` — `name: "flywheel-inbox"`
- `:81` `flywheel_inbox_ack_batch`、`:110` `flywheel_inbox_ack_event`

### A.2 fail-open 旁路(重要)

如果适配器没拿到 `FLYWHEEL_COMM_CLI` / `FLYWHEEL_COMM_DB` / `FLYWHEEL_LEAD_ID`,
它**完全绕过 comm.db 和 Bridge**,直接把消息推进模型:

- `chat-receipt-recorder.ts:87-116`(`resolveRecorderMode`)——三个 env 全缺 ⇒ `{kind:'disabled', reason:'stock'}`;缺一部分 ⇒ `{kind:'broken'}`
- `server.ts:1750-1753` — `const delivery = ingestArgs ? await chatIngestRuntime.acceptInbound(ingestArgs) : 'legacy'`
- `server.ts:1768-1782` — `if (delivery === 'legacy') { mcp.notification({ method: 'notifications/claude/channel', ... }) }`
- `server.ts:109-112` — broken 时只打一行 stderr:「DISCORD MAILBOX WIRING BROKEN: ... inbound delivery remains **fail-open**」

⇒ **同一份代码有两条入站车道**:durable 车道(经 comm.db + Bridge)与 legacy 车道(直推模型)。

### A.3 出站逐箭头

| # | 箭头 | 证据 |
|---|---|---|
| A13 | 模型调 MCP 工具 `reply` | `server.ts:1171` — `name: 'reply'` |
| A14 | 发送前**先问 Bridge 守卫** | `server.ts:1308` — `const guardDeny = await callReplyGuard(chat_id, text, {...})`;`server.ts:360-404`(实现),`:365` `const bridgeUrl = process.env.BRIDGE_URL`,`:375-376` — `` const res = await fetch(`${bridgeUrl}/api/discord/reply-guard`, { `` / `method: 'POST',` |
| A15 | Bridge 侧守卫路由 | `packages/teamlead/src/bridge/tools.ts:1276` — `router.post("/discord/reply-guard", (req, res) => {`;纯逻辑 `packages/teamlead/src/bridge/reply-guard.ts:1-22`(规则:带 issue token 的内容禁止发在 chat 频道顶层) |
| A16 | 守卫**未部署 = fail open** | `server.ts:391` — `if (res.status === 404) return null`(`:381-390` 是解释「That is NOT a transient outage, so fail OPEN」的注释);env 缺任一 ⇒ `:370` — `if (!bridgeUrl \|\| !apiToken \|\| !leadId \|\| !projectName) return null` |
| A17 | 放行后 **Lead 会话内的适配器直接 POST Discord REST** | `server.ts:1339-1342` — `const sentIds = await sendReplyChunks(payload => gatewayHealth.trackedSend<Message>(chat_id, () => ch.send(payload)), ...)`;`reply-send.ts:61` `export async function sendReplyChunks(` |
| A18 | 另一条出站车道:**经 Bridge** 的 issue thread 发送 | `packages/teamlead/src/bridge/tools.ts:711` — `router.post("/chat-threads/send", async (req, res) => {`。插件本身**不调**它(`server.ts` 内无调用点);它由 Lead 的提示词引导模型自己发 HTTP —— 引导文本见 `server.ts:443`(守卫不可用时的 guidance)与 `scripts/setup-new-project.sh:406` |

### A.4 Bridge 引擎事件(`session_completed` / 告警等)

走**同一个 JSON 文件**,与 Discord 聊天共用一条 batch 管道:
- `lead-inbox-loop.ts:444` 的 `[mailbox-batch ...]` 头对两类都一样
- 类别区分在 `lead-delivery-adapter.ts:27` — `kind?: "discord_chat" | "model";`
- Discord 批的分区键:`packages/flywheel-comm/src/discord-chat-ingest.ts:130-131` — `if (row.type !== "discord_chat") return "model";`

- 引擎事件由 Bridge 自己入队到**同一个 MailboxQueue**:
  `packages/teamlead/src/bridge/plugin.ts:5825` — `registry.setLeadEventEnqueuer((envelope, content) =>`;
  `packages/teamlead/src/bridge/lead-inbox-runtime.ts:573` — `enqueueLeadEvent(`
- 一个 batch **不允许混装**两类:`lead-inbox-loop.ts:414` —
  `throw new Error("claimed model batch mixes Discord and regular rows");`;
  标签 `:449` — `kind: discord ? "discord_chat" : "model",`

⇒ **引擎事件确实先进 Bridge**(事件由 Bridge 自己产生并入队),**Discord 聊天不是**。
两者之后共用同一条 batch 管道、落进**同一个 JSON 文件**。

### A.5 结论(A)—— 按段说,不要一句话概括

- **Discord → comm.db(入站第一段):不经过 Bridge。** 网关 websocket 和 bot token 都在 Lead 自己的
  Claude 会话里(A1–A4);Bridge 只收到一个可丢弃的门铃(A5)。
- **comm.db → 模型(入站第二段):durable 车道下 Bridge 是必经的数据面泵。**
  没有 `LeadInboxLoop`,队列行永远变不成 JSON 文件里的一条(A6–A11)。
- **legacy fail-open 车道**(A.2)下,消息**从头到尾都不经过 Bridge,也不进 comm.db**。
- **出站:`reply` 这条主路径的数据面不经过 Bridge** —— 只有一次**可 fail-open 的**守卫问询(A14–A16),
  放行后由 Lead 会话内的适配器直发 Discord REST(A17)。
  但**另有一条 issue-thread 路径 `POST /api/chat-threads/send` 的数据面确实经过 Bridge**(A18),
  只是它不是插件工具、靠提示词引导模型自己发 HTTP,因此不是强制环节。

---

## B. Codex Lead 通路(以 `mufasa-lead` 为例)

### B.0 进程拓扑

- 每个 Codex Lead 一个**独立 launchd 守护进程**(不是 Bridge 的一部分):
  `packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh:36` —
  `TUI_RUNTIME="${TEAMLEAD_ROOT}/dist/lead-backends/codex/codex-lead-tui-runtime.js"`;`:140` `exec node "${TUI_RUNTIME}"`
- 该脚本强制 TUI 形态:`:75` `export FLYWHEEL_CODEX_LEAD_MODE=tui`
- **实测 2026-09-08T03:13Z**:`launchctl list` 显示
  `com.flywheel.lead.growth-mufasa-lead` 与 `com.flywheel.lead.flywheel-codex-infra-bot-lead`
  PID 均为 `-`、last exit = `3` ⇒ **当前两个 Codex Lead 守护进程都没在跑**;
  `pgrep -f codex-lead-tui-runtime` 无结果。(运行时观察,非代码结论。)

### B.1 入站逐箭头

| # | 箭头 | 证据 |
|---|---|---|
| B1 | **Lead 守护进程自己 REST 轮询 Discord**(没有网关 websocket) | `packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts:665` — `const source = new RestPollDiscordInboundSource({`;`RestPollDiscordInboundSource.ts:7` 注释 —「`GET /channels/{id}/messages?after=<lastSeenId>` on an interval」 |
| B2 | 轮询间隔默认 3s | `RestPollDiscordInboundSource.ts:121` — `this.pollIntervalMs = opts.pollIntervalMs ?? 3000;` |
| B3 | `CodexDiscordGateway` 做过滤/回声免疫 | `codex-lead-tui-runtime.ts:749` — `const gateway = new CodexDiscordGateway({` |
| B4 | `CodexDiscordMailboxStrategy` **进程内直接调库**写 comm.db(不 spawn CLI) | `CodexDiscordMailboxStrategy.ts:1` — `import { ingestDiscordChat } from "flywheel-comm/discord-chat-ingest";`;`:72` — `ingestDiscordChat({` |
| B5 | 收到 durable 回执就地返回,**不在本进程内直接喂模型**,也**不敲 Bridge 门铃** | `CodexDiscordGateway.ts:233` — `if (durable === "handled") return true;`;`grep -rn "nudgeLeadInbox\|lead-inbox/nudge" packages/teamlead/src/lead-backends/codex/` 零命中 |
| B6 | **Bridge 的 `LeadInboxLoop`** 轮询同一个 comm.db(1s/30s),与 A6 完全同一份代码 | `lead-inbox-loop.ts:29-30`;`lead-inbox-runtime.ts:341,558` |
| B7 | Bridge 选 Codex adapter,解析 per-lead socket | `lead-inbox-runtime.ts:1260` — `return new CodexLeadDeliveryAdapter({`;`lead-delivery-adapter.ts:103` — `this.socketPath = resolveCodexLeadInboxSocketPath(opts.stateDir);` |
| B8 | Bridge 作为**客户端**通过 unix socket 投递;Lead 守护进程是**服务端** | `CodexLeadInboxSocket.ts:64` — `join(stateDir, "lead-inbox.sock")`;`:78` `class CodexLeadInboxServer`;`:230` `submitCodexLeadInboxBatch`;`lead-delivery-adapter.ts:146` `result = await submitCodexLeadInboxBatch({` |
| B9 | 为什么必须走 socket 而不是 Bridge 直写 | `CodexLeadInboxSocket.ts:4-7` —「The Codex Lead router lives in the windowed TUI sidecar process. The Bridge therefore cannot mutate journal.db directly... This newline-delimited Unix socket keeps durable accept + pump in that owning process.」 |
| B10 | socket server → `LeadInputRouter.submitBatch` | `CodexLeadInboxSocket.ts:202` — `const result = this.opts.router.submitBatch(request.batch);` |
| B10b | **先落 `journal.db` durable accept,再进内存队列**(这正是 Bridge 不能直写、必须走 socket 的原因) | `LeadInputRouter.ts:218` — `const result = this.journal.acceptBatch(input);`;`LeadJournal.ts:240` `acceptBatch(args: {`,`:260` `return this.store.insertAcceptedBatch(` |
| B11 | 只有 `accepted_new` 才入队起泵 | `LeadInputRouter.ts:219-225` — `if (result.status === "accepted_new") { ... this.queue.push(result.entry.id); void this.pump(); }` |
| B12 | 泵驱动 `CodexTurnExecutor` | `LeadInputRouter.ts:291` — `const turnId = await this.executor.startTurn({...});`;`:297` `await this.executor.awaitCompletion(turnId)` |
| B13 | Executor → JSON-RPC `turn/start` | `CodexTurnExecutor.ts:156-161`;方法名见 `CodexLeadProcess.ts:372` `thread/start`、`:380/:403` `thread/resume`、`:415` `turn/start` |
| B14 | **TUI 形态**:不 spawn 子进程,而是连到共享的 `codex remote-control` daemon(ws over unix socket) | `codex-lead-tui-runtime.ts:539-541` — `const ws = await connectDaemonWs({ codexHome: config.codexHome }); const transport = new WsTransport(ws); proc = new CodexLeadProcess({ spawnChild: () => transport });`;`daemon-ws.ts:13-14` `export const DAEMON_SOCKET_RELPATH =` `"app-server-control/app-server-control.sock"`;`:36` `` const url = `ws+unix://${sock}:/`; `` |
| B15 | founder 的 `codex resume --remote` TUI 窗口是**同一个 daemon / 同一个 thread 的另一个客户端** | `codex-lead-tui-runtime.ts:1-6` —「One shared `codex remote-control` daemon; this sidecar is the machine client... the founder's TUI (`codex resume --remote`, PR-C window) is the human client of the SAME thread.」 |
| B16 | headless 形态(保留能力,非生产 Lead 形态)则直接 spawn `codex app-server` stdio 子进程 | `CodexLeadProcess.ts:17` 注释 —「The actual argv (`codex app-server --strict-config -c …`)」;headless runtime 的 spawn 实证 `codex-lead-runtime.ts:1297,1321-1323,1548`(`:1699` 是它的 `RestPollDiscordInboundSource` 构造,不是 spawn) |

### B.2 出站逐箭头

| # | 箭头 | 证据 |
|---|---|---|
| B17 | 出站模式二选一 | `codex-lead-tui-runtime.ts:584-593` — `config.outboundMode === "bridge" ? new CodexOutboundSender({...}) : new DirectDiscordOutboundSender({...})` |
| B18 | **生产默认 = `direct`(绕开 Bridge)** | `run-codex-lead-mufasa-tui-fullaccess.sh:104` — `export FLYWHEEL_CODEX_LEAD_OUTBOUND="${FLYWHEEL_CODEX_LEAD_OUTBOUND:-direct}"`;`:101-103` 注释 —「DIRECT (Mufasa's production mode) — ... **bypasses Bridge outbound authorization**」 |
| B19 | direct 模式 = Lead 守护进程用自己的 bot token 直发 Discord REST | `DirectDiscordOutboundSender.ts:4` 注释 —「own bot token (via the raw-REST `postDiscordMessageToChannel`), **WITHOUT the Bridge**」;`:57` `this.postImpl = opts.postImpl ?? postDiscordMessageToChannel;`;`packages/teamlead/src/bridge/discord-utils.ts:10` `DISCORD_API = "https://discord.com/api/v10"` |
| B20 | bridge 模式(存在但生产未启用)才会打 Bridge | `CodexOutboundSender.ts:180` — `` url: `${this.bridgeUrl}/api/lead-outbound/send` `` |
| B21 | Lead 主动发消息的 `discord_send` 动作也是直发 | `discord-send-core.ts:23` `import { postDiscordMessageToChannel }`;`:98` `const post = deps.post ?? postDiscordMessageToChannel;` |

### B.3 一句话结论(B)

> Codex Lead 与 Claude Lead **在 comm.db 之前和之后都各走各的**,只有中间那一段
> (comm.db → Bridge `LeadInboxLoop` → 投递)是同一份代码。
> 差异全部集中在两端:**入站** Claude 是「会话内插件 + 网关 websocket + spawn CLI」,
> Codex 是「独立守护进程 + REST 3s 轮询 + 进程内调库」;
> **投递** Claude 是「JSON 文件 + 内置 poller」,Codex 是「unix socket + 自有 router/executor」;
> **出站** Claude 经一次 fail-open 守卫后直发,Codex 生产默认 `direct` 直发、连守卫都没有。

---

## C. Raya 文字通路(raya PR #26,分支 `fly-2379-raya-text-chat`)

### C.1 逐箭头

| # | 箭头 | 证据 |
|---|---|---|
| C1 | Discord **网关 websocket**(discord.js `Client`)在 raya brain 进程内 | `apps/brain/src/voice-mode.ts:632-638` — `new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })` |
| C2 | `messageCreate` → 分类 → 未归类的转给文字聊天 | `apps/brain/src/voice-mode.ts:643` — `client.on("messageCreate", (message) => {`;`:658` — `void options.onUnhandled(input).catch(onError);` |
| C3 | `onUnhandled` 接到 `TextChatController.handle` | `apps/brain/src/cli.ts:392-404`;控制器构造 `cli.ts:329` |
| C4 | **没有任何 Bridge / flywheel-comm / chat-ingest / comm.db** | `grep -rn "9876\|flywheel-comm\|chat-ingest" apps/brain/src/` ⇒ **零命中**(2026-09-08 复核) |
| C5 | 状态落在自有 JSON/JSONL 文件,不是队列 | `apps/brain/src/text-chat/store.ts:107` — `this.root = join(stateDir, "text-chat");`;`:110-112` — `thread.json` / `asks.json` / `events.jsonl` |
| C6 | events.jsonl **拒绝写正文**(只准元数据) | `store.ts:162-171` — `... /(?:content\|text\|input\|question\|answer\|stderr)/iu ... throw new Error("text chat events must be metadata-only");` |
| C7 | 大脑 = **自己 spawn 的 `codex app-server` stdio 子进程** | `text-chat/codex-client.ts:118-121` — `args: ["app-server", "--strict-config"]`;`:143` `await this.request("initialize", buildInitializeParams(), 30_000);`;`:222` `this.child.stdin.write(...)` |
| C8 | 线程连续性:内存复用 + 落盘 resume | `text-chat/controller.ts:390-393`(内存命中);`:408` `this.requestThread("thread/resume", resumeId, contract)`;`:415/:432/:445` `thread/start` |
| C8b | 每一轮对话真正的执行调用是 **`turn/start`** | `text-chat/controller.ts:587`(`private async runTurn(`)、`:595` — `"turn/start",`,参数 `:597-599` `{ threadId, input: [{ type: "text", text: input }], clientUserMessageId }` |
| C9 | 超时 | `apps/brain/src/config.ts:147` `turnTimeoutMs: 300_000,`;`:148` `heavyTurnTimeoutMs: 900_000,` |
| C10 | 模型 | `packages/contracts/src/codex-session.ts:20` — `model: "gpt-6-astra",`(可被 `RAYA_CODEX_MODEL` 覆盖) |
| C11 | **代码里没有 per-session MCP 注入** | `grep -rni mcp apps/brain/src/text-chat/ runtime.ts cli.ts config.ts` ⇒ **零命中**;`buildInitializeParams` / `buildThreadStartParams`(`packages/contracts/src/codex-session.ts:110-133`)无 `mcpServers` 字段。⚠️ 这只证明**代码不注入**;`RAYA_CODEX_HOME` 下的 `config.toml` 是否另配 MCP **未验证** |
| C12 | 「问 Lead」= **模型在自己回答里写一行文本标记**,由正则解析出来 | `packages/contracts/src/lead-ask.ts:44` — `` const match = /^【问 Lead】\s*(.+?)\s*:\s*(.+)$/.exec(candidate); ``;调用点 `controller.ts:802` |
| C13 | 解析出的问题 = 往 roundtable 频道发一条 **@mention 明文** | `controller.ts:928` — `` content: `<@${ask.leadUserId}> Raya 代 Annie 问(ask ${ask.askId},#raya ${sourceLink}):${sanitizeDiscordText(ask.question)}` `` |
| C14 | Lead 的回答靠**自己 REST 轮询 roundtable thread**捞回来(默认 30s) | `controller.ts:1027` — `const timer = setInterval(callback, this.options.config.textChat.askPollMs);`;`config.ts:151` — `askPollMs: 30_000,` |
| C14b | 轮询拉取 → snowflake/频道过滤 → **校验答复者确实是那个 Lead 的 bot** → 落 `answer_observed` | 拉取 `controller.ts:1054-1057` — `const replies = await this.options.rest.list(ask.threadId, { ...(ask.lastSeenMessageId ? { after: ask.lastSeenMessageId } : {}), limit: 50 });`;过滤 `:1058-1062`;身份校验 `:1063-1071` — `candidate.author?.id === ask.leadUserId && candidate.author.bot === true && ...`;状态落盘 `:1089-1095` — `status: "answer_observed", answerMessageId: answer.id, ...`;转交合成 `:1096-1099` |
| C14c | 把答案**再跑一轮 turn**合成后发回 `#raya` | 入口 `controller.ts:1128` — `private async synthesizeAsk(`;guard `:1132-1133`;真正的执行 `:1170-1180` — `const thread = await this.ensureThread(); const answer = await this.runTurn(thread.threadId, ` `` `Lead ${current.displayName} 在 #leads-roundtable 回复(ask ${current.askId}):${answerText}` `` `, ...); ... await this.sendAnswer(answer, current.sourceMessageId);` |
| C14c′ | ⚠️ **thread 连续性是有条件的,不是保证。** 正常情况复用/恢复现有 thread;只有两种情况会新建:①一开始就没有 `resumeId`;②`thread/resume` 抛的错被判定为 **rollout 不存在**。普通 resume 错误会重连再试一次,第二次仍是普通错误就**抛错**(不新建) | `controller.ts:404` `const resumeId = this.threadId ?? saved?.threadId ?? null;`;`:406-408` 有 id 就 resume;`:410-415` / `:427-432` — `if (this.isMissingRollout(firstError)) { ... this.store.clearThread(); ... "thread/start" }`;`:419-425` 重连重试;`:437-439` — `throw new Error(` `` `会话恢复失败(${this.errorCategory(secondError)})` `` `)`;`:444-445` 无 `resumeId` 时才 `thread/start` |
| C15 | Lead 名册是 Raya **自己的一份 registry**,与 `projects.json` 无关 | `packages/contracts/src/meeting.ts:431` — `export function loadLeadRegistry(`;`:436` — `join(stateDir, "leads")`;实测生产盘上有 14 个 `profile.json`(`~/.flywheel/raya/data/state/leads/`),字段为 `leadId / discordUserId / displayName / aliases / workspaceCwd / identityPath` |
| C16 | 出站 = **brain 进程直接 POST Discord REST** | `text-chat/discord-rest.ts:6` `const API = "https://discord.com/api/v10";`;`:25` `` authorization: `Bot ${token}` ``;`:38-41` `async send(channelId, body) { ... method: "POST" }` |
| C17 | 凭据隔离硬门:必须证明 Codex 沙箱**读不到** `.env` 才允许开文字聊天 | `text-chat/secret-isolation.ts:59-67`;`packages/contracts/src/codex-sandbox-probe.ts:28-37`;门在 `cli.ts:213-217,234`;未证明时 `controller.ts:264-268` 直接拒服务 |
| C18 | 守护进程 = 与 voice 共用的 `com.xrli.raya.brain`,**无独立文字聊天 job** | `apps/brain/src/installer.ts:24` — `label: "com.xrli.raya.brain",`;`:30` — `label: "com.xrli.raya.voice",`;重启策略 `apps/brain/src/launchd.ts:34-37`(brain = `Crashed=true`),`:62-63` `ThrottleInterval 60` |
| C19 | `fallback.ts` 是**死代码** | `apps/brain/src/text-chat/fallback.ts:7` `export function createTextChatFallback(`;全仓引用只有它自己和它的测试 |

### C.2 C vs B 逐项对照(founder 直问:「它和 Codex 的区别是什么」)

| 维度 | B Codex Lead | C Raya 文字 | 相同/不同 | 依据 |
|---|---|---|---|---|
| 入站机制 | REST 轮询 3s | **网关 websocket** | **不同** | `RestPollDiscordInboundSource.ts:121` vs `voice-mode.ts:632-643` |
| 入站落点 | comm.db 统一信箱 | **无信箱**,回调直入控制器 | **不同** | `CodexDiscordMailboxStrategy.ts:72` vs `cli.ts:392-404` |
| Bridge 参与 | 有(`LeadInboxLoop` 泵 + socket 投递) | **完全没有** | **不同** | `lead-inbox-runtime.ts:341` vs `apps/brain/src/` 零命中 |
| 投递给大脑 | unix socket → `LeadInputRouter` → `CodexTurnExecutor` | 直接函数调用 `controller.handle()` | **不同** | `CodexLeadInboxSocket.ts:202` vs `cli.ts:399` |
| 大脑连接 | TUI: ws 连共享 daemon;headless: spawn stdio | **自己 spawn `codex app-server` stdio** | **不同**(与 headless 相同,与生产 TUI 形态不同) | `codex-lead-tui-runtime.ts:539-541` vs `codex-client.ts:118-121` |
| JSON-RPC 方法 | `thread/start`、`thread/resume`、`turn/start` | `thread/start`、`thread/resume`、`turn/start` | **相同** | `CodexLeadProcess.ts:372,380,415` vs `controller.ts:408,415,595` |
| 出站 | 生产默认 direct REST(无守卫) | direct REST(无守卫) | **相同** | `DirectDiscordOutboundSender.ts:57` vs `discord-rest.ts:38-41` |
| 出站守卫 | `bridge` 模式才有;生产未启用 | **无任何守卫** | **实质相同(都没有)** | `CodexOutboundSender.ts:180` vs C 无对应物 |
| 超时 | 由 `CodexTurnExecutor` / router 管 | `turnTimeoutMs 300s` / `heavyTurnTimeoutMs 900s` | **不同(各自一套)** | `config.ts:147-148` |
| 问 Lead | flywheel-comm `ask` / `gate` 走 comm.db,有 admission、有 gate 超时语义 | **文本标记 `【问 Lead】` + @mention 明文 + 30s REST 轮询 + 在(通常是同一个)Codex thread 里再跑一轮合成回灌** | **完全不同** | `lead-ask.ts:44`、`controller.ts:928,1027,1054,1128,1170-1180`;thread 连续性的条件见 C14c′ |
| Lead 名册 | `~/.flywheel/projects.json` | **Raya 自有 `<stateDir>/leads/*/profile.json`** | **不同(重复一份)** | `meeting.ts:436` |
| MCP 注入 | Codex Lead 有 MCP 工具(如 `discord_send`) | **代码里没有 per-session MCP 注入**(不排除外部 `config.toml` 另配,未验证) | **不同** | `discord-send-core.ts:98` vs C11 |
| daemon 监督 | launchd `com.flywheel.lead.<project>-<lead>`,由 flywheel 装 | launchd `com.xrli.raya.brain`,由 raya 自己装 | **不同(两套安装器)** | `run-codex-lead-mufasa-tui-fullaccess.sh` vs `installer.ts:24` |
| 凭据隔离证明 | **未在代码中找到**同等硬门 | 有,且是开服硬门 | **不同** | `secret-isolation.ts:59-67` |

### C.3 生产配置实测

- PR #26 **尚未合并**(分支 `fly-2379-raya-text-chat`,HEAD `34c8794`);生产 `~/.flywheel/raya/code` 在 `b1b5a64`。
- `~/.flywheel/raya/raya.env` 的 key 全集(18 个)里 **没有 `RAYA_LEADS_ROUNDTABLE_CHANNEL_ID`**
  ⇒ 即便合并,`controller.ts:814` 的 roundtable 分支在当前生产 env 下也拿不到频道 id。
- launchd plist 只注入 `RAYA_ENV_FILE`(`~/Library/LaunchAgents/com.xrli.raya.brain.plist`),没有别的 env 来源。

---

## D. Raya 语音通路(raya main `b1b5a64`)

### D.1 音频入

| # | 箭头 | 证据 |
|---|---|---|
| D1 | 用 `@discordjs/voice` 加入语音房 | `apps/voice/src/discord/DiscordAdapter.ts:174-183` — `joinVoice({ guildId, channelId: config.voiceChannelId, adapterCreator: guild.voiceAdapterCreator, ... })` + `waitForVoiceReady(connected, VoiceConnectionStatus.Ready, 15_000)` |
| D2 | 订阅每个说话人的 opus 流并解码 | `DiscordAdapter.ts:201-211` — `new SubscriptionRegistry<EndBehaviorType.Manual>(connected.receiver, () => new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 }), ...)`;`VoiceRoom.ts:283-296` |
| D3 | PCM 推进 Uplink | `apps/voice/src/runtime.ts:1592-1597` — `stream.on("data", (chunk: Buffer) => { ... this.uplink?.pushPcm48Stereo(userId, frame); })` |
| D4 | Uplink → 本地抢话门(Silero VAD) | `apps/voice/src/pipeline/Uplink.ts:96-119` — `this.options.speechGate.push(frame, atMs)`;模型 SHA 钉死 `pipeline/SileroVad.ts:5-6` |
| D5 | 门的开合阈值 | `pipeline/UplinkSpeechGate.ts:403` — `if (result.probability < this.options.threshold - 0.15) {`(负向滞回);`:424` — `if (chain.opened && chain.negativeMs >= 100) chain.opened = false;`;参数来源 `runtime.ts:609-621` |
| D6 | **平台侧抢话**(FLY-2249):app-server 的 `speech_started` 事件 | `codex/RealtimeTransport.ts:340-356` — `itemType === "input_audio_buffer.speech_started"` → `{ type: "speech_started" }` |
| D7 | 收到后做本地让位:清 downlink、估算「听到哪儿」、压制后续音频 | `runtime.ts:1148-1195`(判 stale/not_live/protected/already_yielded)→ `:1191-1195` `this.fireLocalYield("platform_speech_started")`;`runtime.ts:980-1063`;`pipeline/Downlink.ts:12` `SUPPRESSION_MAX_MS = 11_000` |

### D.2 大脑

| # | 箭头 | 证据 |
|---|---|---|
| D8 | `AppServerClient` **spawn `codex app-server` 子进程**,JSON-RPC over stdio | `codex/AppServerClient.ts:91-98` — `spawn(options.bin, options.args, { cwd, env, stdio: ["pipe","pipe","pipe"] })`;`:132-145` `initialize`;`:280-291` `writeControl` 写行分隔 JSON |
| D9 | `CodexLeg` 起进程 + 开 thread + 塞 baseInstructions(含 ACTIONS 提案合同) | `codex/CodexLeg.ts:107-110`、`:112-145`、`:71-83` |
| D10 | 开实时会话 | `codex/RealtimeTransport.ts:191-202` — `this.client.request("thread/realtime/start", { threadId, transport: { type: "websocket" }, outputModality: "audio", voice, version: "v2", prompt })` |
| D11 | 麦克风音频上行(fire-and-forget) | `RealtimeTransport.ts:231-238` — `this.client.writeHot("thread/realtime/appendAudio", { threadId, audio: { data: frame.toString("base64"), sampleRate: 24_000, numChannels: 1, ... } })` |
| D12 | 模型音频下行 | `RealtimeTransport.ts:376-390` — `thread/realtime/outputAudio/delta` |
| D13 | 转写 | `RealtimeTransport.ts:392-416` — `thread/realtime/transcript/delta` / `.../done` |

> **D10 的 `transport: {type:"websocket"}` 是 Codex↔OpenAI Realtime 那一段的传输方式**,
> voice 进程↔app-server 这一段始终是 stdio JSON-RPC(D8)。

### D.3 音频出

| # | 箭头 | 证据 |
|---|---|---|
| D14 | outputAudio → Downlink | `runtime.ts:1719` — `this.downlink?.pushPcm24Mono(chunk.pcm, generation);`(所在的 `transport.on("outputAudio", ...)` 回调起于 `:1710`) |
| D15 | 24k mono 升到 48k stereo 入队 | `pipeline/Downlink.ts:108-124` |
| D16 | tick 出帧写进 PassThrough | `pipeline/Downlink.ts:171-217` |
| D17 | `@discordjs/voice` player 播回房间 | `DiscordAdapter.ts:248-263` — `audioPlayer.play(createAudioResource(rawPcm48kStereo, { inputType: StreamType.Raw, ... }))`;`:222` `connected.subscribe(audioPlayer)` |
| D18 | `speech/Speaker.ts` 不是 PCM 通路,是让模型**说指定文本**的控制层 | `speech/Speaker.ts:394-402`(调 `appendSpeech`);wiring `runtime.ts:570-574` — `this.speaker = new Speaker({ ... appendSpeech: (text, generation) => this.dependencies.transport.appendSpeech(text, generation),` |

### D.4 会议中的「和别人交流 / 做别的事」——founder 直问

#### D.4.1 收:能收,但**没有人在写**

| # | 事实 | 证据 |
|---|---|---|
| D19 | 语音信箱是一个 JSONL 文件 | `packages/contracts/src/voice-inbox.ts:228-235` — `join(stateDir, "voice-inbox")` → `items.jsonl` / `acks.jsonl` |
| D20 | `InboxReader` 定时轮询它 | `inbox/InboxReader.ts:203` — `this.timer = setInterval(() => {`,`:210` — `}, this.options.pollMs);`;`:386-389` `const inbox = readVoiceInbox(this.options.stateDir);` |
| D21 | 未 ack 的条目**分五种处置**,不是一律念出来 | ①`ship_gate` → 单独审批流:`InboxReader.ts:422` — `if (item.kind === "ship_gate") {`<br>②被规则过滤 → `filtered` ack:`:441` — `const acked = this.ack(item.id, "filtered");`<br>③非决策项 → 文字 fallback + `text_fallback` ack:`:450-455`<br>④**决策项但语音稿不合格** → 也走文字 fallback + `text_fallback` ack:`:458-459` `const validation = validateSpeechBrief(item.speechBrief); if (!validation.ok) {`、`:466-468`(播报语「有一件事需要你决定,但语音稿不合格所以没念」)、`:473` `if (delivered) this.ack(item.id, "text_fallback");`<br>⑤只有合格的决策项才进 `speakable` 并 `speak()`:`:476-477` |
| D21b | 念的过程中可被平台抢话打断 | 仲裁 `inbox/InboxArbitrator.ts:26`(`"platform_speech_started"` 是仲裁原因之一);`InboxReader.ts:754` |
| D22 | 🔴 **生产写入方不存在。** `appendVoiceInboxItem` 在 `b1b5a64` 全仓的调用点只有:测试(`InboxReader.test.ts`、`runtime.test.ts`、`voice-inbox.test.ts`)、探针(`probes/fly2031-voice-experience-run.mjs:603`、`probes/fly2178-bargein-room-run.mjs:1316`)、夹具脚本(`scripts/voice-inbox-fixture.mjs:23`)。**没有任何 Lead / Bridge / brain 生产代码写它。** | `git grep -n appendVoiceInboxItem b1b5a64`(2026-09-08 复核) |
| D23 | raya 自己的计划文档就写明 producer 是待办 | `engineering/doc/FLY-2031-raya-mobile-voice/plan.md:399` —「inbox 内容(状态吸收产物) \| **2030** \| `appendVoiceInboxItem`(契约本单定,C1 先行);2030 落地后 rebase 联调,fixture 退役」 |
| D24 | 🔴 **生产盘上 `voice-inbox/` 目录根本不存在** | 实测 2026-09-08:`ls ~/.flywheel/raya/data/state/` → 只有 `leads/`、`voice-evidence/`、`voice-session.json` |

#### D.4.2 发:只有三条,且都不是「Raya 主动去找人」

| # | 出口 | 谁发起 | 能到哪 | 证据 |
|---|---|---|---|---|
| D25 | `relay_to_lead` 动作 | **Codex 模型写一个 `*.action.json` 提案文件** → OutboxWatcher 认领 → 逐字比对 founder 转写取证 → Raya **口头复述** → **等一个「反对窗口」超时**后自动发出 | 预注册 Lead 的 Discord 频道 | `actions/OutboxWatcher.ts:372-396`(认领)、`:444-462`(比对转写);`actions/ReadbackGate.ts:160-174`(复述并确认**自己的复述**被转写捕获)、`:192-194`(`const cancelled = await this.waitForCancellation(current);`)、`:197`(`const sent = await this.sendWithRetry(input, current);`);频道来自 `discord/RoomText.ts:57-103` `loadVoiceLeads`(`voice-leads.json`) |
| D25a | 🔴 **Raya 念给 founder 听的那句话,和真正的执行语义不一致。** 播报稿同时说了「确认后我会真的把消息发给对方」和「如果不对就说取消,我就不发」;执行上只有后半句成立 —— 没有任何代码在等「确认」 | — | — | `actions/ReadbackGate.ts:87-96`(`relaySpeech`),`:94` 逐字 — `"确认后我会真的把消息发给对方;如果不对就说取消,我就不发。"`;与之矛盾的执行路径见下一行 |
| D25b | 🔴 **执行上不是「等 founder 说确认」,而是「founder 不反对就发」。** 反对词只有三个,且必须是 founder 本人说的 | — | — | `actions/ReadbackGate.ts:244-253` — `observe(entry)` 先校 `entry.role !== "user" \|\| !this.options.founderUserIds.has(entry.speakerUserId)`,再 `if (!matchesExactPhrase(entry.text, ["不对", "等等", "取消"])) return;`;`:291-295` — `await Promise.race([active.cancelled, delay(this.options.readbackGraceMs).then(() => false), ...])`,**超时返回 `false` 即「未取消」→ 发送** |
| D25c | 另一类动作 `remember_filter`:模型提案 → 校验 founder 转写 → 写本地筛选状态(不外发) | Codex 模型 | 本地 `voice-filter` 状态 | 合同 `codex/CodexLeg.ts:79` — `'remember_filter: {v,actionId,sessionKey,utterances,kind,rule:{scope:{lead?\|kind?\|keyword?},verdict:"skip"},quote}。'`;排队 `actions/OutboxWatcher.ts:531-540` `enqueueFilterMutation` → `:542` `processFilterMutation`;**真正落盘** `:570` `const loaded = loadFilterState(this.options.filterFile);`、`:583-584` `next.rules.push(action.rule); writeFilterState(this.options.filterFile, next);`、`:585-586` 写 `status: "saved"` 回执 |
| D26 | `VoiceTextMirror` 字幕 | **运行时自动**,不是 Raya 的意图 | 固定一个文本频道 `config.textChannelId` | `discord/VoiceTextMirror.ts:42-100`;`runtime.ts:399-404` |
| D27 | ship 审批投票 | **外部**(一条 `ship_gate` inbox item)armed → founder **口头**说「确认/不批」才发(**这条是真的 affirmative 确认,与 D25 不同**) | 审批 HTTP 服务 `POST {baseUrl}/ship-approval` | `inbox/InboxReader.ts:422` — `if (item.kind === "ship_gate") {` → `runtime.ts:907` — `processShipGate: async (item) => {` → `approval/ShipGateFlow.ts:333-484`、`:541-552`;`approval/ApprovalClient.ts:252-265`;baseUrl 必须以 `/api/voice` 结尾 `ApprovalClient.ts:228-230` |
| D28 | 出站频道有**硬白名单** | — | 只允许 `lead` / `verified-inbox` / `raya` 三类路由,其余抛错 | `discord/RoomText.ts:105-137`,`:136` `"room text route is not authorized"` |

#### D.4.3 明确的「不能」

| 能力 | 结论 | 证据 |
|---|---|---|
| 会议中主动**问** Lead 一个问题并把答案接回本次语音会话 | **未在代码中找到** | `relay_to_lead` 是单向陈述(D25);唯一的回流入口是 D19–D22 那条**没有写入方**的信箱 |
| 会议中查 Flywheel 状态(issue / runner / PR) | **`apps/voice` 里没有专门的 Flywheel 状态集成**;唯一的状态读取只覆盖一条已 armed 的 ship-gate | `git grep -ni "linear\|runner" b1b5a64 -- apps/voice/src` ⇒ 零命中;`ApprovalClient.getGateBinding` / `getContext`(`ApprovalClient.ts:238-250`)只读该 gate 的 `issueId` / `issueIdentifier` / `prHeadSha` 等元数据。⚠️ 本行**不排除** Codex 线程自身的 tool surface(它以 workspace-write + 网络起会话)能做别的事 —— 那超出 `apps/voice` 代码范围,**未验证** |
| 经 flywheel-comm / Bridge 与系统对话 | **未在代码中找到** | `git grep -n "flywheel-comm" b1b5a64 -- apps/voice` ⇒ 零命中;`git grep -ni "bridge" b1b5a64 -- apps/voice/src` 唯一命中是 `config.ts:414` 一个拼出来的废弃配置键名 `["bargeInGate","BridgeMs"].join("")`,不是集成 |
| 发到任意频道 | **不能** | D28 白名单 |

#### D.4.4 生产配置实测(2026-09-08)

`~/.flywheel/raya/raya.env` 的 18 个 key 中:
- **没有** `RAYA_APPROVAL_ENDPOINT_URL` ⇒ D27 的审批客户端在生产未配置;
- **没有** `RAYA_LEADS_ROUNDTABLE_CHANNEL_ID`;
- `voice-inbox/` 目录不存在(D24)。

⇒ 结论(限定在 `apps/voice` 代码范围内):

- **「问别人并把答案接回本次会议」——没有这条路。** 唯一的回流入口是 `voice-inbox/items.jsonl`,而它**没有生产写入方**(D22–D24)。
- **「向别人说一句」——有,但是 opt-out 的。** `relay_to_lead` 需要模型提案 + 转写逐字取证 + Raya 口头复述 +
  一个「反对窗口」超时;founder **不说** `不对 / 等等 / 取消` 就会自动发出(D25/D25b)。
- **「做别的事」——还有一件:改本地筛选规则**(`remember_filter`,D25c),以及在外部 armed 时对 ship gate
  投一票(D27,这一条需要 founder 明确说「确认」)。
- 出站频道受硬白名单约束(D28)。

---

## E. 与 founder 期望的差距(只陈述,不提方案)

founder 期望(2026-09-08 02:48–03:03Z,FLY-2379 thread):
1. **所有 Lead 的 Discord 入站都先进 Bridge,再由 Bridge 进大脑。**
2. **Codex Lead(含 Raya)的文字与语音通路应完全同构,不给 Raya 特殊待遇。**

### E.1 差距逐条

**G1 — 入站第一跳没有一个是 Bridge。**
- Claude Lead:网关 websocket 在 **Lead 自己的 Claude 会话**里(`server.ts:1593,1793`,`start-adapter.sh:9-14,44`)。
- Codex Lead:REST 轮询在 **Lead 自己的 launchd 守护进程**里(`codex-lead-tui-runtime.ts:665`)。
- Raya 文字:网关 websocket 在 **raya brain 进程**里(`voice-mode.ts:632-643`)。
- Raya 语音:`@discordjs/voice` 在 **raya voice 进程**里(`DiscordAdapter.ts:174-183`)。
- 四条通路各自持有一份 bot token,四个进程各自直连 Discord。

**G2 — Bridge 确实在「comm.db → 大脑」这一段是必经的,但只对 A/B 成立,且只覆盖入站的后半段。**
- 必经段:`lead-inbox-loop.ts:29-30,444,449,467` + `lead-delivery-adapter.ts:56/92`。
  这一段没有替代路径 —— 队列行只能由 `LeadInboxLoop` 变成 JSON 文件或 socket 批。
- 写进 comm.db 那一步 **Bridge 不参与**(A3b spawn CLI;B4 进程内调库),二者都直接打开 sqlite 文件(`discord-chat-ingest.ts:77`)。
- A 还有一条 legacy fail-open 车道**整条都不经过 Bridge**(G9)。
- C、D 两条通路 **连 comm.db 都没有**。

**G3 — Bridge 唯一的入站 HTTP 触点是一个可丢弃的门铃,而且只有 A 会敲。**
`lead-inbox-nudge.ts:34-36` 的注释就是判据;没配 `BRIDGE_URL` 时 `:41-42` 直接 return,消息照样送达。
B 走进程内库调用,`packages/teamlead/src/lead-backends/codex/` 下连这个门铃的调用点都没有(§0.2)。

**G4 — 出站基本不经过 Bridge,而且守卫可 fail-open。**
- Claude Lead:出站前问一次 `POST /api/discord/reply-guard`(`server.ts:375-376`),但 404 / env 缺失都 fail open(`server.ts:370,391`);放行后直发 Discord REST(`server.ts:1339-1342`)。
- Codex Lead:生产默认 `direct`,**连守卫都没有**,启动脚本注释自己写着「bypasses Bridge outbound authorization」(`run-codex-lead-mufasa-tui-fullaccess.sh:101-104`)。
- Raya 文字/语音:直发 REST(`discord-rest.ts:38-41`;`RoomText.ts:105-137`)。
- **当前生产配置下**,经 Bridge 的出站只剩 issue thread 一条(`tools.ts:711`),而它靠**提示词**引导模型自己发 HTTP,不是通路里的强制环节。
  代码里还存在一条 Bridge 出站路径 `CodexOutboundSender.ts:180` `POST /api/lead-outbound/send`,但没有任何在用的 launcher 把 `FLYWHEEL_CODEX_LEAD_OUTBOUND` 设成 `bridge`。

**G5 — Claude 与 Codex 的投递机制本来就不同构,而且是设计如此。**
`lead-delivery-adapter.ts:29-31` 的注释把两者写成两种消费语义:Claude 是「原子写成员、由内置 poller 自己打包一个 turn」,Codex 是「消费一个已打包好的 turn」。
`CodexLeadInboxSocket.ts:4-7` 进一步说明 Bridge **不能**直接改 Codex 的 journal.db,所以必须走 socket。

**G6 — Raya 的两条通路与 A/B 都不同构,差异是结构性的,不只是参数不同。**
- 无 comm.db、无 Bridge、无 `LeadInboxLoop`、无 mailbox-batch(C4;D 段 `flywheel-comm` 零命中)。
  ⚠️ 注意:D 的 voice inbox **自己有一套 ack**(`voice-inbox.ts:228-235` 的 `acks.jsonl`,写入点 `InboxReader.ts:441,455`),
  只是与 A/B 的 `mailbox-batch` ack 互不相通、语义也不同。
- 「问 Lead」是另一套协议:文本标记 + @mention + 30s REST 轮询 + 在(通常是同一个)Codex thread 里再跑一轮合成回灌(`lead-ask.ts:44`,`controller.ts:928,1027,1063-1071,1170-1180`;thread 连续性有条件,见 C14c′),
  而 A/B 的问答是 comm.db 里的 `messages` 行 + admission + gate 超时语义。
- Lead 名册重复了一份(`meeting.ts:436` vs `~/.flywheel/projects.json`),两份可以各自漂移。
- 守护进程是另一套安装器(`installer.ts:24` `com.xrli.raya.brain` vs `com.flywheel.lead.*`)。

**G7 — Raya 语音的「收」侧通道在生产是断的;「发」侧存在但是 opt-out 语义。**
- 收:`InboxReader` 完整实现(含自己的 ack 账本),但 `appendVoiceInboxItem` 的生产写入方**不存在**(D22),
  raya 自己的计划文档把 producer 记为待办(D23),生产盘上 `voice-inbox/` 目录不存在(D24)。
- 发:**「Raya 主动向别的 Lead 转达一句话」只有 `relay_to_lead` 一条**,且是**「founder 不反对就发」**
  (反对词 `不对/等等/取消`,超时即发送 —— D25b),不是 founder 明确点头才发;而她**念给 founder 听的那句话
  却说「确认后我会真的把消息发给对方」**(D25a)。没有提问-回答闭环。
  (`apps/voice` 另有两个会往外写的出口,但都不是「Raya 主动找人」:自动字幕 D26、外部 armed 的 ship 审批投票 D27。)
- 审批:`RAYA_APPROVAL_ENDPOINT_URL` 在生产 env 里不存在,该路径当前拿不到 baseUrl。

**G8 — Codex Lead 这条通路当前不在运行。**
实测 2026-09-08T03:13Z:`com.flywheel.lead.growth-mufasa-lead` 与
`com.flywheel.lead.flywheel-codex-infra-bot-lead` 的 launchd PID 均为 `-`、last exit `3`;
`pgrep -f codex-lead-tui-runtime` 无结果。
(这是运行时观察,不是代码结论;它不改变 B 段的代码事实,但意味着 B 段今天没有活体在跑。)

**G9 — Claude Lead 入站存在一条完全绕开 comm.db 与 Bridge 的 fail-open 车道。**
三个 env 缺失时,插件把 Discord 消息用 `notifications/claude/channel` 直推模型
(`server.ts:1768-1782`),只在 stderr 打一行「inbound delivery remains fail-open」(`server.ts:109-112`)。
这条车道存在与否**不体现在任何 Discord 侧可见的信号里**。

### E.2 差距一览

| founder 期望 | 现状 | 四条通路是否符合 |
|---|---|---|
| Discord 入站**第一跳**先进 Bridge | 四条通路的第一跳都在各自的大脑侧进程,各持一份 bot token | A ✗ / B ✗ / C ✗ / D ✗ |
| Bridge 再进大脑 | A、B 的「comm.db → 大脑」这一段**必经** Bridge(A 的 legacy fail-open 车道除外) | A ◐ / B ◐ / C ✗ / D ✗ |
| 出站经 Bridge | 仅 issue thread 一条可选路径,且靠提示词引导 | A ◐ / B ✗ / C ✗ / D ✗ |
| Codex Lead 与 Claude Lead 同构 | 入站/投递/出站三段都不同构(设计如此) | 不符合 |
| Raya 与 Codex Lead 同构 | 结构性不同构:无信箱、无 Bridge、自有名册、自有问 Lead 协议、自有守护进程 | 不符合 |
| Raya 会议中可与他人交流 | 收侧无生产写入方(断);发侧仅单向 `relay_to_lead`,且是「不反对即发」而非明确确认 | 不具备闭环 |

---

## G. 统一化实证(Lead 指令 `9bfc5fe8` 追加)

> founder 2026-09-08 定的方向:**不先合 raya#26 / FLY-2381**,先看这张实证图,
> 再决定把 Raya 统一成一个**普通 Codex Lead**。以下三节按 Lead 的三问逐条落实。
> 行数口径:`.ts` 文件、**只排除 `*.test.ts`**、`wc -l`,2026-09-08 实测。
> 🔴 本节**只陈述现状**。凡是「若统一则会怎样」的话都在 G.2 明确标为**推演**,不是代码事实。

### G.0 先说一件会影响全局判断的事:Codex Lead 壳不是一种形态,是三条 profile

同一份壳按 `codexProfile` 走完全不同的路径,**不能拿其中一条的性质代表整个壳**:

- `codex-lead-runtime.ts:1386-1390` — `const fullAccess = config.codexProfile === "full-access"; const writeCapable = !fullAccess && config.sandboxMode !== "read-only";`
- 同处 `:1385-1387` 注释 —「full-access shares the workspace-write sandbox but takes a SEPARATE path — **NO release gate / gateway / broker / confinement**」
- 生产 Mufasa 就是 full-access(`run-codex-lead-mufasa-tui-fullaccess.sh`),即 **broker / confinement / gateway 那一套对它不生效**。

### G.1 Raya 文字通路 vs flywheel Codex Lead 壳 —— 哪些是同一件事的两份实现

flywheel 的壳:`packages/teamlead/src/lead-backends/codex/`,**57 个非测试 `.ts` / 16 761 行**。
Raya 文字侧:`apps/brain/src/text-chat/`(6 个非测试文件 / 1 964 行)+ `apps/brain/src/{voice-mode,cli,config}.ts` 的相关段
+ `packages/contracts/src/{codex-session,lead-ask}.ts`(241 行)。

| 维度 | flywheel Codex Lead 壳 | Raya 文字 | 判定 |
|---|---|---|---|
| **入站** | `RestPollDiscordInboundSource.ts`(512)REST 轮询 3s(`:121`)+ `CodexDiscordGateway.ts`(285,`:233`)+ `mention-gate.ts`(182) | `voice-mode.ts:626-658` discord.js 网关 websocket + `classify()` 分流 | **同一件事的两份实现**(把频道新消息变成一条待处理输入),机制不同(轮询 vs 网关) |
| **信箱 / durable 入站** | comm.db `mailbox` 表(`mailbox-schema.ts:193`)← `CodexDiscordMailboxStrategy.ts:72`;再加 `LeadJournal.ts`(500)/`SqliteJournalStore.ts`(337)的第二层 durable accept | **没有 durable 入站信箱。** `store.ts`(194)只存三样东西:Codex thread、Lead-ask 状态、metadata-only 事件(`:107,:110-112`);入站消息只在进程内经 `handle()`(`controller.ts:244`)串行处理 | 🔴 **只有一边有。** 不是「两份实现」—— Raya 侧没有可崩溃恢复的入站队列 |
| **路由** | `CodexLeadInboxSocket.ts`(411)→ `LeadInputRouter.ts`(481;`:218` journal accept、`:219-225` 入队起泵)→ `CodexTurnExecutor.ts`(377)→ `TurnDemux.ts`(176) | `controller.ts`(1 291)一个类全包:`handle()`(`:244`)→ `ensureThread()`(`:390-445`)→ `runTurn()`(`:587-624`) | **同一件事的两份实现**;flywheel 多一层跨进程 socket(因为 Bridge 与 Lead 是两个进程) |
| **大脑连接** | `CodexLeadProcess.ts`(642)—— TUI 形态连共享 daemon(`daemon-ws.ts:36`),headless 形态 spawn stdio | `codex-client.ts`(301)—— 只有 spawn stdio(`:118-121`) | **同一件事的两份实现**;Raya 缺 daemon 形态 |
| **出站** | `CodexOutboundSender.ts`(215,bridge 模式,生产未启用)/ `DirectDiscordOutboundSender.ts`(direct,生产默认)+ `discord-send-core.ts`(215)+ `lead-actions/send-guard.ts`(140) | `discord-rest.ts:38-41` 的 `send()` | **同一件事的两份实现**;flywheel 多了 bridge 模式与 send guard |
| **超时** | `CodexLeadProcess.ts:141` `DEFAULT_TIMEOUT_MS = 60_000` —— **每次 JSON-RPC 请求**;`CodexTurnExecutor.awaitCompletion()`(`:177-188`)只 `await a.promise`,**无超时** | `config.ts:147-148` `turnTimeoutMs: 300_000` / `heavyTurnTimeoutMs: 900_000` —— **作用在整轮完成上**,超时触发 `controller.ts:617-619` → `interruptTurn` → `client.notify("turn/interrupt", ...)` | 🔴 **不是同一件事。** flywheel 管单次 RPC,Raya 管整轮生成;flywheel 侧的轮级超时**未在代码中找到** |
| **MCP 注入** | 分两层看。**argv builder** `buildCodexLeadMcpArgv.ts`(363):gateway 分支是严格 allowlist(`:40,:149` 只 `flywheel_gateway`),非 gateway 分支 `:158-159` 注释说「Not a strict allowlist like the gateway ... chrome (below) may coexist」并允许 `lead_actions`(`:163`)+ env-gated `chrome_devtools`(`:181-190`)。**但生产 Mufasa 走 TUI**(`run-codex-lead-mufasa-tui-fullaccess.sh:75`),TUI 路径另有一道 config gate:`lead-actions/mcp-config.ts:204-210` 要求 effective config **EXACTLY** 只含受信任的 full-access `lead_actions`,任何额外 MCP 一律 `ConfigGateError` fail-closed;headless 侧也把 chrome 写死为 `undefined`(`codex-lead-runtime.ts:686`)。共同硬规则:不继承宿主 `~/.codex` 的 `[mcp_servers.*]`(`buildCodexLeadMcpArgv.ts:6-11`)、Discord MCP 永不注入(`:14-17`) | **代码里不注入任何 MCP**(C11) | **只有一边有**。⚠️「Chrome 可共存」只是 builder 的潜在能力,**不是生产 Mufasa 的事实** —— 它被 TUI 的 exact config gate 挡住 |
| **daemon 监督** | launchd `com.flywheel.lead.<project>-<lead>` + `run-codex-lead-*.sh` + `resident-codex-lead-lifecycle.ts`(239)+ `DaemonConnectionSupervisor.ts`(263):WS 断连 → 代际围栏 → 有界退避重建新 `CodexLeadProcess` | launchd `com.xrli.raya.brain`(`installer.ts:24`)+ `launchd.ts`(73,`KeepAlive Crashed=true`、`ThrottleInterval 60`);**进程内也有一层**:`controller.ts:557-571` `client.onExit` → 拒绝 in-flight turn、清 client → 下次 `ensureClient()` 重建;普通 resume 故障 `:419-425` 也会 `resetClient` 后重试 | **同一件事的两份实现**;flywheel 多了代际围栏与有界退避,Raya 是「下次用到时重建」 |
| **凭据隔离** | ⚠️ **按 profile 分叉**:confined write-capable 路径有 `secret-broker.ts`(233)+ `confinement.ts`(141);**生产 full-access 路径两者都没有**(`codex-lead-runtime.ts:1385-1390`),且 TUI 的 daemon env 直接携带 `DISCORD_BOT_TOKEN`(`codex-lead-tui-runtime.ts:215`) | `secret-isolation.ts`(68)+ `codex-sandbox-probe.ts`(44):开服前证明沙箱**读不到** `.env`(`cli.ts:213-217,234` 是硬门) | 🔴 **不是同一件事,且不能说「flywheel 一定更严」** —— 生产 Mufasa 的 profile 下,壳没有 broker/confinement,Raya 反而有一道读隔离硬门 |
| **问 Lead / roundtable** | 壳的 roundtable 能力是**入站方向的**:`RoundtableThreadDiscovery.ts`(224)+ `roundtable-reply-in-thread-wiring.ts`(185)负责发现 thread、订阅、把回复路由回来。**主动发起**要走 `discord_send(target="roundtable")`,而当 roundtable 配置存在时 `autoContinue` 被固定为 `true`(`codex-lead-runtime.ts:676`),此时 `discord-send-core.ts:123-143` **明确拒绝**主动 roundtable 发送(`"REFUSED: proactive roundtable posts are deferred while in-thread auto-continue is on (FLY-680 — cross-process subscribe+seed not yet wired)"`) | 完整的 ask 生命周期:`lead-ask.ts:44` 解析 → `controller.ts:928` 发问 → `:1027` 轮询 → `:1063-1071` 校验答复者身份 → `:1089-1095` 落 `answer_observed` → `:1170-1180` 第二次 `turn/start` 合成 → `sendAnswer` 回 `#raya` | 🔴 **不是「同一件事的两份实现」。** 重叠的部分是「答复的接收与回灌」(壳做 thread 发现/订阅/路由,Raya 做轮询/校验/合成);**不重叠的是主动发起** —— 壳当前的主动 roundtable 发送被 `discord-send-core` 拒着,没有「发起 → 关联答复 → 合成」的完整闭环,Raya 有 |
| **Lead 名册** | `~/.flywheel/projects.json` | `<stateDir>/leads/<id>/profile.json`(`meeting.ts:431-436`),生产盘 14 份,字段含壳没有的 `identityPath` / `memoryPaths` / `workspaceCwd` / `writableRoots` | **同一件事的两份实现,两份数据可各自漂移** |
| **只有壳有** | `CodexLeadInboxSocket.ts`(411)、`CodexDiscordMailboxStrategy.ts`、`ExternalReceiptSaga.ts`(154)、`CodexDiscordRuntimeOwnership.ts`(309)、`CodexLeadOutboundHandler.ts`(287)、`gateway/*`(约 3 300 行)、`lead-actions/*`、`buildCodexLeadMcpArgv.ts`、`tui-window*.ts` | — | Raya 无对应物 |
| **只有 Raya 有** | — | `meeting.ts`(1 230)+ `meeting-calendar.ts`(284)会议编排;`voice-mode.ts` 的语音房编排;身份/记忆文件注入(`cli.ts` → `baseInstructions`);ask 生命周期(见上) | 壳无对应物 |

### G.2 若把 Raya 接到壳上,raya 仓哪些文件会被删/保留

🔴 **这是按 G.1 的对应关系做的归类推演,不是实施计划,没有验证可行性。**
🔴 **凡带「会 / 要 / 换成」的句子都是推演,不是代码事实。**

**壳里有对应物、原则上可由壳承担(按下表自身估值合计 ≈ 890–1 090 行)**

| 文件 | 行 | 壳侧对应物 |
|---|---|---|
| `apps/brain/src/text-chat/codex-client.ts` | 301 | `CodexLeadProcess`(642) |
| `apps/brain/src/text-chat/discord-rest.ts` | 96 | `RestPollDiscordInboundSource` + `DirectDiscordOutboundSender` / `discord-send-core` |
| `apps/brain/src/text-chat/fallback.ts` | 14 | 已是死代码(C19) |
| `apps/brain/src/text-chat/controller.ts` 的**传输与轮次**部分 | 1 291 中约 400–600(`ensureThread` `:390-445`、`runTurn` `:587-624`、通知分发) | `LeadInputRouter` + `CodexTurnExecutor` + `TurnDemux` |
| `apps/brain/src/voice-mode.ts` 的 `messageCreate`/`classify` 分流段 | 691 中约 80 | `CodexDiscordGateway` + `mention-gate` |

**壳里没有对应物,必须保留(≈ 17 950 行)**

| 文件 | 行 | 为什么留 |
|---|---|---|
| `apps/voice/**` 全部 | **13 683**(45 个非测试 `.ts`) | 语音,壳完全不覆盖(G.3) |
| `packages/contracts/src/meeting.ts` | 1 282 | 会议契约 + Lead registry |
| `apps/brain/src/meeting.ts` | 1 230 | 会议编排 |
| `apps/brain/src/metrics.ts` | 293 | Raya 自己的指标口径 |
| `apps/brain/src/meeting-calendar.ts` | 284 | 会议日历 |
| `apps/brain/src/text-chat/secret-isolation.ts` + `packages/contracts/src/codex-sandbox-probe.ts` | 112 | 与 broker/confinement **不是同一件事**,且生产 full-access profile 下壳里没有等价物(G.1) |
| `packages/contracts/src/lead-ask.ts` + `controller.ts` 的 ask 生命周期 | 68 + 约 400 | 壳当前**没有**主动提问闭环(`discord-send-core.ts:123-143` 拒绝主动 roundtable) |
| `apps/brain/src/voice-mode.ts` 的语音房编排段 | 691 中约 600 | 语音 |
| **合计(不含 `apps/voice`)** | **≈ 4 270** | 1 282 + 1 230 + 293 + 284 + 112 + (68 + 约 400) + 约 600 |
| **合计(含 `apps/voice`)** | **≈ 17 950** | 上一行 + 13 683 |

**既不能简单删也不能原样留(需要 founder 定的取舍点)**

| 项 | 现状事实 | 为什么是取舍点 |
|---|---|---|
| `apps/brain/src/launchd.ts`(73)+ `installer.ts`(60) | `installer.ts:24` 生成 `com.xrli.raya.brain`,`:30` 生成 `com.xrli.raya.voice`;`launchd.ts` 是两者共用的 plist renderer | 只要 `apps/voice` 保留,这两个文件就不能整文件删 |
| `apps/brain/src/config.ts`(380) | 同时供应文字、会议、语音三块配置(`config.ts` 内 `textChat`/`meeting`/voice 相关字段共存) | 不是「全部 env 键重映射」那么简单 —— 只有文字那部分与壳的 env 约定重叠 |
| `apps/brain/src/text-chat/store.ts`(194) | 存三样:Codex thread 身份(`thread.json`,`store.ts:15-21,110,115-130` 的 `threadId/codexHome/startedAt/lastTurnAt`)、ask 状态(`asks.json`)、metadata-only 事件(`events.jsonl`) | **只有 `thread.json` 那部分有壳侧对应物,而且对应的不是 `LeadJournal`** —— 是壳里独立的 thread-id 文件:`codex-lead-runtime.ts:891` `threadIdPath: join(stateDir, "thread-id")`、`:1140` `readThreadId`、`:1149` `writeThreadId`(TUI 使用点 `codex-lead-tui-runtime.ts:603-625`)。`LeadJournal.ts:207-273` 存的是入站 batch 的 durable accept,**不存 thread 身份**。ask 状态与事件账本壳里没有 |
| Lead 名册 | 两份数据(`projects.json` vs `<stateDir>/leads/*/profile.json`),后者多 4 个字段 | 合一会丢字段,不合一会继续漂移 |

### G.3 语音(`apps/voice`)能不能同样通用化,阻碍在哪

**结论:按现状不能,阻碍是结构性的,不是配置。**
`apps/voice` 在 `b1b5a64` 共 **45 个非测试 `.ts` / 13 683 行**。

| 阻碍 | 事实 | 依据 |
|---|---|---|
| ① **Codex Lead 壳里没有任何实时音频协议** | `packages/teamlead/src/lead-backends/codex/` 全目录 `grep -rn "realtime\|appendAudio\|@discordjs/voice"` **零命中**。壳封装的 RPC 是 `thread/start`、`thread/resume`、`turn/start`、`thread/read`,另外**还封装了 `turn/steer`(轮次中途注入)但全目录没有调用方** —— 所以准确说法是「当前接线未使用 `turn/steer`」,不是「壳只有四个方法」 | `CodexLeadProcess.ts:372,380,415`、`:427-428` `const res = await this.request("turn/steer", args);`;`CodexTurnExecutor.ts:195`;`LeadInputRouter.ts:21` 注释把 mid-turn `turn/steer` 记为未落地 |
| ② 壳的入站载荷是「文本 + 附件清单」,没有音频通道 | `normalizeChatDeliveryEnvelope({ v: 1, ... text, attachments })` | `flywheel-comm/src/discord-chat-ingest.ts:97-110` |
| ③ 壳的轮次模型是「一问一答、一次一个 active turn」,语音是「连续会话 + 随时抢话」 | 壳:`CodexTurnExecutor.awaitCompletion(turnId)`(`:177-181`)要求 `a.turnId === turnId`,否则抛错;语音:生成途中 `fireLocalYield` 清 downlink 队列并压制最长 11s | `CodexTurnExecutor.awaitCompletion`;`runtime.ts:980-1063`;`Downlink.ts:12` `SUPPRESSION_MAX_MS = 11_000` |
| ④ flywheel **已经有另一套语音栈**,而且它也有实时能力 —— 但**不是 Codex `thread/realtime/*` 那条协议** | `packages/voice-bridge` + `voice-core` + `voice-headphone`:**90 个非测试 `.ts` / 20 319 行**(严格口径:`.ts` 只排除 `*.test.ts`;若再排除两个 9 行的 `vitest.config.ts` 则为 88 / 20 301),依赖 `@discordjs/voice 0.19.2` + `prism-media 1.3.5`。它的实时走 **Gemini Live**:`packages/voice-core/src/backends/gemini/genaiConnector.ts` 用 `sendRealtimeInput` 发实时 PCM/文字/`audioStreamEnd`,另见 `backends/gemini/transport.ts`、`src/types.ts` | `packages/voice-bridge/package.json:23,29`;`voice-core/src/backends/gemini/genaiConnector.ts`;最近改动 `56e1d899a`(2026-08-30) |
| ⑤ 语音的侧通道**方向与壳相反,且一端是断的** | 壳的侧通道是「Bridge → Lead」(事件、门);语音的 `relay_to_lead` 是「Lead → 别的 Lead」,而回流口 `voice-inbox` 没有生产写入方(D22–D24) | 见 D.4 |

**哪些面在结构上是可分离的(只描述现状边界,不给方案)**

- 语音的**文字侧通道**——`voice-inbox/items.jsonl` 的入、`relay_to_lead` 的出、ship 审批的 HTTP——
  载荷都是文本,与音频主链之间只有函数调用耦合(`InboxReader` / `OutboxWatcher` / `ApprovalClient` 各自独立于 `RealtimeTransport`)。
- 语音的**音频主链**(`DiscordAdapter` → `Uplink` → `SileroVad` → `RealtimeTransport` → `Downlink`)
  在 Codex Lead 壳里**没有任何对应物**;flywheel 侧唯一的对应能力在 `voice-bridge`/`voice-core`,但那是 Gemini Live 协议,与 Raya 的 Codex realtime 不是同一条(④)。

---

## F. 取证锚点与方法(供独立复核)

| 项 | 值 |
|---|---|
| flywheel 主仓 | worktree `flywheel-FLY-2439`,基线 main `790355137`,文档 commit 见 git log |
| Discord 插件 | `~/.claude/plugins/cache/flywheel-plugins/discord/**0.0.6**/`(本机实际运行的字节,非 fork main) |
| Claude Code 二进制 | `claude 2.1.263`(`~/.local/bin/claude --version`,2026-09-08) |
| raya 语音 | raya main **`b1b5a64`** 的 blob(`git show b1b5a64:<path>`) |
| raya 文字 | PR **#26** 分支 `fly-2379-raya-text-chat`,HEAD **`34c8794`**(scratchpad 只读克隆) |
| raya 生产 checkout | `~/.flywheel/raya/code` @ `b1b5a64`(只读,未 fetch、未改动) |
| 运行时观察时刻 | 2026-09-08T03:13Z(`launchctl list` / `pgrep` / `ls` 的那几条) |

复核方法:所有行号用 `grep -n` 或 `sed -n` 在上述锚点上取过;
第一轮 Codex 设计评审(xhigh)逐条复算了行号,发现并已修正 9 处引用偏移、
1 处语义反向错误(D25)、3 处结论口径过宽、3 处漏 hop。
