# FLY-2076 Claw 值守席位 — 调研
Issue: FLY-2076 (https://linear.app/geoforge3d/issue/FLY-2076/2073值守-claw-infrabot-值守上岗对整条队列负责-初审三去向宁转勿吞)
日期: 2026-08-26
基于: exploration.md

> 本文回答:exploration.md 选定的方案(接入 = 翻插件门控;落账 = 一条 Bridge 路由 + 一个 CLI;行为 = 角色文件改写)**各自精确落在哪段既有代码上、合同长什么样、测试从哪里长、验收怎么采**。选项 B/C/D 不再展开。代码行号取自本分支(= `main@b889c4b6f`)与运行时插件 `flywheel-plugins/discord/0.0.4`。

## 1. 接入:把告警频道那一组的 `requireMention` 翻成 `false`

### 1.1 精确落点

- 文件:`${DISCORD_STATE_DIR}/access.json`,其中 `DISCORD_STATE_DIR = ~/.claude/channels/discord-${LEAD_ID}`(`claude-lead.sh:248`)。Claw 的就是 `~/.claude/channels/discord-claude-infra-bot-lead/access.json`。
- 改动:`groups["<告警频道 id>"]` 从 `{ requireMention: true, allowFrom: [] }` → `{ requireMention: false, allowFrom: [] }`。**只动这一个 group 的这一个键**;`allowBots`、`dmPolicy`、其他 group、`mentionPatterns` 一律不碰。
- 生效:插件 `gate()` 每条消息都 `loadAccess()`(`server.ts:713`)⇒ **热生效,不用重启插件**。
- 之后的路径逐字不变:`gate() → deliver`(:829)→ hook → `flywheel-comm chat-ingest --msg-kind guild …`(`chat-receipt-runtime.ts:756`)→ `ingestDiscordChat` 写 `mailbox` 一行(`discord-chat-ingest.ts:119-121`,`source_kind='discord_chat'`)→ `LeadInboxLoop` 成批 → `ClaudeLeadDeliveryAdapter.deliverBatch` 写 inbox 文件(`lead-delivery-adapter.ts:56-92`)+ nudge → Claw 会话收到 `<channel chat_id=… message_id=… user=… user_id=… ts=… delivery_id=…>正文</channel>`。

### 1.2 Claw 会收到什么(量与形状)

| 来源 | 作者 | 进不进 Claw | 说明 |
|---|---|---|---|
| ticket 根消息(2075 后) | dispatcher bot `1524831623164596265` | **进**(在 `allowBots`) | 首行 `${sev} **${title}** (${leadId} / ${kind})` + 🎫 行 + body(spec §4)。**kind 从首行括号里取**,是查册子的键 |
| Hub 在 thread 里的帖(ARC 结果 / 状态叙事) | dispatcher bot(`alertDiscordOps` 用发送身份) | 进(thread 继承父 group) | 是上下文,不是要回的东西 |
| 人 / 别的 Lead 在 thread 里的跟帖 | 人 / 各 Lead bot(在 `allowBots`) | 进 | R5 进展同步(2078)对值守可见 |
| 旁路根消息(`mailbox_dead_letter` 等,不开 thread、无账本行) | dispatcher | 进 | **看,不回帖、不记账**(plan D6):没有 thread 可留痕,回根频道违反回环护栏;它是门控的天然探针。入账 / 开 thread 归 Epic |
| Claw 自己的帖 | Claw | **不进**(`server.ts:1517`) | 回环护栏第一层 |
| Codex Infra Bot 的帖 | `1523…` | 进(在 `allowBots`) | 「谁都不救自己」的另一半;Claw 不接它的工单,但看得见 |

量:频道根消息 ≈ 2075 research §3.1 的 83~307 episode/天(限速 20/min,溢出回放)+ thread 跟帖。Claw 今天在信箱里每天收 40~300 行且 ACK 延迟 0.2~0.7 min(2075 exploration §3.2),**量级相同、通道不同**。

### 1.3 落地脚本 `packages/teamlead/scripts/apply-alert-duty-gate.sh`(新)

仿 `apply-core-room-mention-gate.sh`(FLY-898)—— 同一套 `atomic_patch`(temp + rename、`cp -p` 备份、`cksum` 乐观重试 5 次、`jq -e` fail-closed),方向相反:

| 项 | 合同 |
|---|---|
| 用法 | `--access-file <path> --channel-id <alertChannelId> [--allow-bot <dispatcherBotUserId>] [--dry-run]` |
| 变换 | `.groups[$ch].requireMention = false \| .groups[$ch].allowFrom = []`;`--allow-bot` 给出时把该 id **并入** `allowBots`(去重;插件在 `gate()` 之前先按顶层 `allowBots` 过滤 bot 作者,`server.ts:1518-1521`,所以这一步是持续不变量,不能靠「生产快照恰好有」)。**group 不存在 → `skipped:no_alert_group` exit 0**(不创建 group);已是目标态 → `noop` |
| 不碰 | 其他任何字段 / group;`mentionPatterns` 保持原值;`allowBots` 只增不删 |
| 失败 | 无效 JSON / 备份失败 / 5 次乐观重试都撞上并发写 → 非零退出,原文件不动;**stderr 不吞** |
| 输出 | 一行 `[alert-duty-gate] <lead>: channel=<id> requireMention=false allowFrom=[] allowBots+=<id\|none> (changed\|noop\|skipped:<reason>)` |

dispatcher 的 bot user id 从哪来:Lead 侧没有 dispatcher token,不能自己 `/users/@me`;由 Bridge 在 boot 时用 `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 指向的 token 解析一次(模式同 `flag-retirement-production.ts:537`),经 `GET /api/alert-duty/seat` 给出;Bridge 不可达 → `dispatcher=unresolved:bridge_unreachable`,门控照翻(`gate=` 一栏不受影响)。

### 1.4 启动挂钩:独立 helper `lead-duty-provision.sh`,由 `claude-lead.sh` 调用

`claude-lead.sh` 的 dry-run 在 `:2954` 已 `exit`,FLY-282/898 块都在其后 —— 所以启动逻辑要抽成一个**可独立执行**的 helper(测试直接跑它,不经 claude-lead.sh):

```bash
# packages/teamlead/scripts/lead-duty-provision.sh — inputs by env:
#   LEAD_ID PROJECT_NAME DISCORD_STATE_DIR SCRIPT_DIR [FLYWHEEL_ALERT_DUTY_TOKEN] [FLYWHEEL_BRIDGE_URL]
# 1. node dist/alert-duty-seat-cli.js --lead-id --project [--bridge-url]   # stderr 保留
# 2. isDutySeat=false → unset FLYWHEEL_ALERT_DUTY_TOKEN; 打印同一形状的行(seat=false,其余 -); exit 0
# 3. isDutySeat=true 且 FLYWHEEL_ALERT_DUTY_TOKEN 未设 → 不翻门控(gate=skipped:no_duty_token token=unset);听得见却写不了账的席位不上岗
#    isDutySeat=true 且 token 已设 → apply-alert-duty-gate.sh --access-file $DISCORD_STATE_DIR/access.json \
#                         --channel-id <alertChannelId> [--allow-bot <dispatcherBotUserId>]
# 4. echo "[alert-duty] seat=<true|false> lead=<id> channel=<id|-> gate=<changed|noop|skipped:r|-> dispatcher=<id|unresolved:r|-> token=<set|unset>"   # 唯一形状
```

`claude-lead.sh` 在 FLY-898 块之后 `source` 它(`|| true`:与 FLY-282/898 同规矩,失败不阻止启动,但每种失败都有固定 `skipped:<reason>` 且**不 `2>/dev/null`**)。

- `alert-duty-seat-cli.js`(新,仿 `core-room-gate-cli.ts`):纯函数 `resolveAlertDutySeat({ leadId, projectName, projects, env })` → `{ isDutySeat, alertChannelId }`,再向 Bridge `GET /api/alert-duty/seat` 取 `dispatcherBotUserId`。**席位 = 常量** `ALERT_DUTY_SEAT.leadId = "claude-infra-bot-lead"`;频道 id 取 projects.json 该 Lead 的 `alertChannel`,缺省回落 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`。启动脚本、路由横幅、wrapper 白名单共用这一个函数 —— **一个真相源**。
- **专用 token 的投递缝有三处**(都是防误用,不是隔离,见 §2.2 定性):wrapper v2 白名单(`flywheel-lead-wrapper-v2.sh:318-350`)仅席位放行;`lead-body.sh:6-12` 会 `set -a; source .env` 把全部配置再灌一遍 → helper 在非席位分支 `unset`;`claude-lead.sh` `_launch_claude` 的 `env -i` + `env_args`(`:1891-1930`)是最后一道,只对席位显式追加。

### 1.5 启动恢复:按账本欠账,不按频道最近 100 条

Claw 每次会话开始(含 `/clear` 后的 `SessionStart`)做一次:`flywheel-comm alert-ticket outstanding --json --limit 25`(`acked_at IS NULL` 的行,**含离线期间被 ARC 自动 RESOLVED 的**(行带 `resolved` 标记 → 只 ack 不发帖))。服务端 newest-first，default 25 / max 100；响应 `cursor` 是现有 `(opened_at,event_id)` 的 opaque 编码，`--since <cursor>` 解码后作下界，不加表/列。满批 = 可见积压，先报压力，再处置本批并不带 cursor 取下一批；不会首轮把几百条全塞进会话。因为顺序是先发帖后记账,`acked_at` 为空 = 处置未完成 → 重做(最坏多一帖,G1),已记账的不重做。root-only 工单(G3)与被取代的旧 episode(G2)不在这份清单里 —— 如实交 founder(plan §2.5)。旁路根消息(D6)不补扫。

## 2. 落账:写既有账本的三个字段 + 一个窄路由 + 一个 CLI

> v5(Tadashi scope guard):v2~v4 为封住 Codex 指出的每个缺口而层层加的机制(回执表 / intent 表 / 状态机 / Bridge 代发 / 对账)**全部删除**。值守认领 = 写**既有**的 `alert_threads.acked_at`(PRD §1.3 数的正是它,两个月 0 次);转出 = 既有 `ESCALATED` + `owner_ref`;解决 = 既有 `hub.resolve()`。没封住的缺口(G1 多一帖、G2 被取代 episode、G3 root-only 无账本行)**如实列给 founder**(plan §2.5),不设计绕过。

### 2.1 账本动作(不加表、不加列)

| 动作 | 写什么(既有列) | 状态 | 实现 |
|---|---|---|---|
| `ack` | `acked_at = COALESCE(acked_at, now)` | `NEW → ACK`;其余不动(C1:ARC 已在推进的行不回退) | `stampDutyAck(ck, eventId)`:一条 UPDATE,`WHERE correlation_key=? AND event_id=?`(**episode 围栏**,0 行 → 409 `stale_episode`) |
| `handoff --to X` | `acked_at = COALESCE(...)`、`owner_ref = lead:X`、`ticket_status = ESCALATED` | 任意非 RESOLVED → ESCALATED;RESOLVED(含定位后被 ARC 解决)409 `already_resolved` | `handoffTicket(ck, eventId, ownerRef)`:包在 `this.db.transaction()`(`StateStore.ts:350-355`;`save()` 自 FLY-663 是 no-op),谓词 `AND event_id=? AND resolved_at IS NULL AND ticket_status <> 'RESOLVED'` |
| `resolve` | 既有 `hub.resolve(ck, expectedEventId)`:**入口**先比对 `getActiveAlertThread(ck)` 的 `event_id`(不等 → 抛 `stale_episode`,零副作用);再把 eventId 传进末尾的 `setTicketStatus(ck,"RESOLVED",eventId)` 与 `resolveAlertThread(ck,eventId)`(两个既有方法各加一个可选谓词参数) | → RESOLVED + `resolved_at` + 归档;末尾写 0 行 → 重读该 `event_id`:`resolved_at` 非空 → 200 幂等(ARC 在 await 期间先解决了同一 episode;恢复帖 / 归档可能各发生两次 —— 既有 Hub 无串行化,不加);否则 409 `stale_episode`(B 覆盖 A);Hub 缺席 → 503 | 既有方法加一处比对 + UPDATE 加谓词 |

**顺序 = 先发帖、后记账**:🧭 帖发出后才 `ack` / `handoff`,✅ 发出后才 `resolve`;`acked_at` 非空 = **处置完成并已留痕**。重启按 `acked_at IS NULL` 重做 —— 至少一次(可能多一帖,G1),不会丢处置。定位:根消息 id / thread id(同值)或 `event_id`,两个查找都**不过滤** `resolved_at`;找不到 404。`to` 在全舰 roster 一次 lookup 中解析，故任意 project / fleet 工单都能兜底 Tadashi；owner=Codex bot 的工单不 handoff(只 ack)。`listDutyOutstanding(limit,since?)` 只取 `acked_at IS NULL AND ticket_status IS NOT NULL`，可选 composite cursor 下界，`ORDER BY opened_at DESC,event_id DESC LIMIT ?`；含 RESOLVED 标记并排除无 ticket 状态的 legacy 行。🎫 行的 owner 文案(`<@botUserId>`)由路由解析后传给 Hub，Hub 不查 roster。

**`acked_at` 的另一个写入者要删**:rescue 路由的 `ackTicket`(`plugin.ts:10130-10150`,FLY-927 Task 2.3,只覆盖 `login_expired` / `runner_login_expired`)在救援**开始**时就 `setTicketStatus(ck,"ACK")`。生产两个月 0 次 ACK 说明它从未触发,但一旦 `acked_at` 被定义为「值守处置完成」,它就能在 Claw 离线时盖上时间戳、让 `outstanding` 漏掉一条没留痕的工单 —— 按「只删不加」删掉这个写入(plan T14),值守成为唯一认领者。

已知不封(plan §2.5):`alert_threads` 是 active-mapping(`:3628-3634`),同 correlation_key 的新 episode 覆盖旧行 → 旧 episode 无自己的去向(G2);Hub 建 thread 失败直接 `return` 不写账(`AlertChannelHub.ts:409-420`)→ root-only 工单 `ack` 404(G3)。

### 2.2 `/duty` 窄路由与 token

`createAlertDutyRouter()` 只两条:`POST /alert-tickets/transition`(ack | handoff | resolve)、`GET /alert-tickets/outstanding`;`app.use("/duty", dutyAuth, router)` 恰一次,不复挂 `createQueryRouter`。seat 探针 `GET /api/alert-duty/seat` 在既有 `createQueryRouter`(启动 CLI 只有共享 token)。**`/duty` 不是第四层告警**:两条路由只写既有列 / 重渲染 🎫 行 / 走安静的 `hub.resolve`,不发告警、不 @ 任何人。`dutyAuth`:未配置 503;缺失 / 长度不等 / 不等 → 403(先比长度再 `timingSafeEqual`,`tools.ts:952` 已有);对 `/api/*` 无效。config:`FLYWHEEL_ALERT_DUTY_TOKEN` 走 `normalizeOptionalBearer`,与 `apiToken` / ingest / `geminiAgentToken` 相等 → 启动拒绝(`config.ts:99-118` 模式)。

**定性(D3)**:所有 Lead 同一 OS user,`~/.flywheel/.env` 对每个 Lead 进程可读,各 Lead 都有 Bash + bypassPermissions ⇒ 它是**防误用的最小权限 capability**,不是能对抗恶意 Lead 的身份。token 投递缝三处(§1.4)都是防误用。

### 2.3 CLI `flywheel-comm alert-ticket`

```
alert-ticket ack         (--message-id <id> | --event-id <id>) [--wait 30] [--json]   # 发完 🧭 后调;含 🎫 的根消息 404 → 重试 3×10s
alert-ticket handoff     --to <leadId> (locator)                                     # 发完 🧭 后调;自带 acked_at
alert-ticket resolve     (locator)                                                   # 发完 ✅ 后调
alert-ticket outstanding [--json] [--limit 1..100] [--since <cursor>]                # newest-first,含 resolved 标记
```

token 只读 `FLYWHEEL_ALERT_DUTY_TOKEN`;Bridge URL 同 `ack-event`(`index.ts:437`)。退出码:`0` / `2` 用法 / `3` 400·403·409 / `4` 404 / `5` 503·网络。

### 2.4 留痕帖:Claw 用既有 `reply`,规矩在角色文件

**先发帖、后记账**;发帖前 `fetch_messages(channel=<thread>, limit=50)` 看有没有自己的 🧭,有则不再发、直接记账;`fetch_messages` 失败 → 不发帖(fail-closed,留给下一次);🧭 里 @ 只允许一个真 `<@id>`(① / owner=Codex bot 一个不 @);正文 ≤ 1800 字;owner=Codex bot 只 `ack` 不 `handoff`;已自动 RESOLVED(thread 已归档)只 `ack` 不发帖;旁路根消息看而不回(D6)。**多一帖的可能(G1,至少一次)**:「发了帖还没记账就重启」、插件 `reply` 对结果不明的分片会自行重试、「🧭 在最近 50 条之外」—— 不封,交 founder;**不会丢处置**。

## 3. 角色文件 `.lead/claude-infra-bot-lead/identity.md` 改写清单

`claude-lead.sh:865` 每次启动从 `.lead/<id>/identity.md` 取角色文件 ⇒ **改仓库文件 + 下一班重启即生效**,`~/.claude/agents/` 那份是机器副本(FLY-1071 的手补路径),不需要另改。frontmatter 逐字不动(`name` 是 `claude-lead.sh:1613` 的合同)。

| 段 | 现状 | 改成 |
|---|---|---|
| 开头定位 | 「#flywheel-alerts 工单的默认主力 owner」 | 「**alerts 频道值守席位(唯一)**:频道里每条消息都归你先看;Cass 不看、别的 Lead 不被 @ 不看」 |
| 「你的三件事」 | 救 Codex / 救 runner / 发通知 | 前面加 **第 0 件:值守初审**(§3.1),原三件保留为「① 职权内」的具体内容 |
| 回帖纪律 | 只响应显式 @你 | 「你**看**全部;**回**只在工单 thread 里、一条工单一帖定去向(§3.2);绝不回根消息本身、绝不回自己、绝不在根频道闲聊、绝不复述」 |
| 铁律「一条工单只有一个 owner;没被 @ 不动手」 | — | 「一条工单**一个去向**;没被 @ 的**先看**,去向由你定;动手仍受 §3.3 的 allow/deny」 |
| 铁律「修不掉才 @Annie」 | — | 「**你永不自行 @Annie**。兜底是 @Tadashi(③);要不要惊动 founder 是接手的人或 founder 自己翻未解决 thread 时定的(R6)」 |
| 新增 | — | §3.3 不装懂 allow/deny;§3.4 压力自述;§3.5 根因线;§1.5 启动补扫 |
| 不动 | 谁都不救自己 / 不开 Runner / 不碰产品代码 / notify 铁律 / carve-out | — |

### 3.1 值守初审的固定动作序列

```
收到 <channel> 包络(根消息或 thread 跟帖)
├─ 是 thread 跟帖 → 只读入上下文;若是我转出的工单且接手方已宣告解决 → 不动(2078 收尾)
├─ 是旁路通报(dispatcher 作者、无 🎫、无 thread)→ 看,不回帖、不记账(plan D6)
└─ 是工单根消息(dispatcher 作者,含 🎫)
   1. 取 kind ← 首行 `(leadId / kind)`;取 messageId ← 包络 message_id
   2. 只读核实(§3.3 allow 列);工单已自动 RESOLVED(thread 已归档)──▶ 跳到 5 只 ack,不发帖
   3. 定去向:🎫 owner 是 Codex bot ──▶ ②(依据「owner map」,帖内不 @、不 handoff,C4)
              runbook/<kind> 命中且在 carve-out 内 ──▶ ①
              contact-book[kind] 查到 X ──▶ ② @X
              否则 ──▶ ③ @Tadashi,标 📒 册上无此 kind
   4. fetch_messages(channel=<thread>, limit=50):有我的 🧭 → 跳过发帖;失败 → 停,不发;无 → reply 发 🧭(§3.2;恰一个 @ 或没有)
   5. 记账 = 完成:① / owner=Codex → alert-ticket ack --message-id <id> --wait 30;② ③ → alert-ticket handoff --to …
      └─ exit 4(含 🎫 但账本行还没落 / root-only G3)→ 留给下一次 outstanding
   6. ① 后续:动手 → 验证 → reply ✅ → alert-ticket resolve → 写 runbook 草稿(§4)
      失败 → reply ↪ → alert-ticket handoff --to …
   7. 根因线一行在 🧭 帖里(§3.5)
```

**先发帖、后记账**:重启后从 `outstanding`(`acked_at` 为空的)接着走;「发了帖没记账」的窗口会多一帖(G1),不封,但处置不会丢。

### 3.2 🧭 帖模板(逐字段;验收按它核)

```
🧭 值守初审 · <kind> · 去向 ① 自己解决 / ② 转 <@LeadUserId> / ③ 兜底 <@TadashiUserId>
看到:<现象,一两句>
查了:<只读动作清单,含 thread 里 Hub 已做的 ARC>
依据:<runbook/<kind> 命中 | contact-book 命中 X | 册上没有(③)>
根因线:<代码/配置问题 → FLY-xxxx | 判不清,已知到 <步>>
落账:待执行 ack | handoff --to <leadId>(roster id,不是 @;发帖之后调)
```

- ① 后续:`✅ 已解决 · 验证:<命令/观察> · runbook:<草稿路径>`;失败:`↪ 改走 ②/③`(再发一帖,不改旧帖)。
- @ 用真 `<@id>`(FLY-898:光打名字不算);id 从 contact book 取,册子没有 id 的行视为「查不到」→ ③。

### 3.3 不装懂:allow / deny 按「动作是否改变系统状态」切

| 永远允许(只读) | 只在 (a) runbook 有该 kind 条目 **且** (b) 动作在 carve-out 内 时允许 | 永远禁止 |
|---|---|---|
| `fetch_messages`、读 thread;`runner_terminal_status` / `capture` / `list`;`tail` 日志;`sqlite3 … ?mode=ro`;`curl :9876/health` 与其他 GET;读 `$FLYWHEEL_DIR/doc/oncall/*`;`linear-api` 查询 | continue-nudge / respawn 卡死 runner;Codex 侧 relogin;`flywheel-rescue-*` 既有救援;runbook 条目里逐字写明的其他动作 | 任何「试试看」:重启 Bridge / Lead / launchd job;改 `.env` / projects.json / access.json;`git` 写操作;kill 进程;`POST` 到非 runbook 指定的路由;切 Claude 侧账号(永远归 Codex bot) |

(a)(b) 缺一 → 不动手,走 ②/③。「不确定」本身就是走 ②/③ 的充分理由。

### 3.4 压力自述(行为要求,不是指标)

Claw 自己看得见的堆积信号只有两个:

1. **批次接力**:上一批的根消息还没全部发出 🧭 帖,下一批已经送到(会话内可数);
2. **欠账残留**:启动时 `alert-ticket outstanding --limit 25` 返回满批，或欠账大于本次会话能处理的数量。

任一出现 → 在告警频道根频道 `reply` 发**一帖**:`⚠️ 值守积压 · 未初审至少 <N> 条 · 最早 <ts> · kind 分布 <…> · 我按到达顺序处理 · <@Tadashi>`。**同一会话只喊一次**;没有跨重启 latch,重启后若积压仍在可能再喊一次。25/100 只是单次 API 批次边界，不是值守总量阈值、SLA 或考核；B(压垮)仍只有 Claw 自己看得见，所以必须自己说。

### 3.5 根因线(R8)

每条 🧭 帖带一行。判定为代码 / 配置问题 → 用 `linear-api` 建单:team `FLY`、project `Flywheel`、标题 `[alerts·根因] <kind>: <一句>`、正文 = thread 链接 + 已知步骤 + 防复发思路;**建前先搜**同标题前缀且未关闭的单,有则在 thread 贴既有单号不重开。判不清 → 只写「已知到 <步>」,不硬下结论。2075 删掉的「同 kind 7 天 ≥3 次自动建单」由这一行人工接替 —— 差别是它带着「为什么」而不是只数次数。

## 4. 册子接口(最小假设;文件格式与落位归 FLY-2077)

| 项 | 假设 | 2077 若改 |
|---|---|---|
| 根目录 | `$FLYWHEEL_DIR/doc/oncall/`(`FLYWHEEL_DIR` 由 wrapper 导出,`flywheel-lead-wrapper-v2.sh:67,336`;不写死 `~/Dev/flywheel`) | 改角色文件一行 |
| contact book | `contact-book.md`,表行 `\| <kind> \| <leadId> \| <@DiscordUserId> \| 备注 \|`;查找键 = 精确 kind | 改一行 |
| runbook | `runbook/<kind>.md`,frontmatter `kind: <kind>`,三节「现象 / 动作 / 验证」 | 改一行 |
| 「新类别上线前必须在册」 | Claw 遇到册上没有的 kind 走 ③ 时,在帖子里加 `📒 册上无此 kind` 标记 —— 这就是「能被发现」的那条信号(R3),不另做检查器 | — |

**① 之后「立刻写 runbook」怎么落**:Claw 不开 Runner、不碰仓库 git(`$FLYWHEEL_DIR` 是生产检出,必须保持 main + clean)。所以:

- Claw **立刻**把 runbook 条目按三节模板写成完整文本,(i) 贴在 ✅ 帖里,(ii) 写到 `$FLYWHEEL_STATE_DIR/oncall-drafts/<kind>.md`(state dir 已在子进程 env;追加、带时间戳与 thread 链接)。
- **进仓库** = 2077 定义的收割步(runner / Tadashi 开 PR 把草稿合进 `doc/oncall/runbook/`)。Epic §8.3 #3「册子在长」由收割 PR 体现。

反面:两步走,草稿会堆;但另一条路(让 bot 在生产检出上做 git 写操作)踩 FLY-2048 那类 worktree 事故与「不碰产品代码」两条线。**这一条请 Tadashi 拍**;若他要 Claw 直接开 PR,需要额外给 Claw 一个隔离 worktree 与 `gh` 凭据,那是新的授权面,不在本单默认里。

## 5. 与 Cass 的边界(Q3)

exploration §2.7 已证:Cass 没有运行时值守动作可移交。本单只在 Claw 角色文件与 spec 守卫段写明「值守席位唯一 = Claw」;Cass 与各 Lead 的「不被 @ 不看、被 @ 必达」= FLY-2078(R7,`apply-core-room-mention-gate.sh` 那套扩到告警频道)。

## 6. 测试从哪里长(RED 起点)

| 层 | 既有基础 | 新增 |
|---|---|---|
| 门控脚本 | `packages/teamlead/scripts/__tests__/apply-core-room-mention-gate.test.sh`(T1~T11,hermetic 临时 fixture) | `apply-alert-duty-gate.test.sh`:T1 翻转 `true→false` 且 `allowFrom:[]`;T2 幂等;T3 不碰其他字段/group;T4 备份;T5 dry-run;T6 坏 JSON fail-closed;T7 group 缺席 NO-OP;T8 文件缺席 NO-OP |
| 席位解析 | `core-room-gate.ts` 纯函数 + `core-room-gate-cli.ts` | `alert-duty-seat.test.ts`:Claw → `isDutySeat:true` + 频道 id 来自 `alertChannel`;缺 `alertChannel` 回落 env;其他 Lead → false;`dispatcherBotUserId` 解析成功 / 失败 → null |
| StateStore | `bridge/__tests__/alert-threads-tickets.test.ts`(`openAlertThread` fixture;事务用例用**磁盘临时 DB**) | 追加:按 root / thread / event 的查找含已 resolved 行;`stampDutyAck` 首写 / 重放不变 / NEW→ACK / REPAIRING 不动;**围栏**(定位 A 后 B 覆盖 → 0 行、B 不动;定位 A 后 ARC 把 A 置 RESOLVED → handoff 0 行、A 仍 RESOLVED);`setTicketStatus` / `resolveAlertThread` 带 `expectedEventId` 0 行、不带参逐字旧行为;`handoffTicket` 事务故障注入后重开 DB 三字段不变、自带 `acked_at`;`listDutyOutstanding` 含 resolved 行并带标记,**阴性对照**:`ticket_status IS NULL` 的 legacy 行(活跃 / 已 resolved)不出现 |
| 路由 | `alert-ticket-lifecycle.test.ts` 的 Hub fixture | `alert-duty-router.test.ts`:**鉴权矩阵**(shared → 403;duty → 200;duty 打 `/api/*` → 401/403;缺 bearer / 错长度 → 403 无异常;未配置 503;config 碰撞启动拒绝);五类联测(NEW / REPAIRING / MONITORING / 自动 RESOLVED(ack-only)/ owner=codex(不 handoff))按 plan §2.1 表;handoff 后 fake edit 含路由解析的 `<@botUserId>` 与状态段;`resolve`:B 已活跃 / 进 Hub 前被覆盖 → 409 且 fake Discord **零调用**、B 不动;**fake Discord await 之后注入「B 覆盖 A」→ 409 且 B 账本不动**;**同窗注入「ARC 先解决 A」(账本层)→ 200 幂等、账本只写一次(Discord 侧不断言恰一次)**;**「Claw 离线时 owner bot 调 `/api/rescue`」→ `acked_at` 仍 NULL、仍在 outstanding**(T14 对照);Hub 缺席:ack / handoff 仍写账、resolve 503;`to` 不在 roster;locator 校验;「离线 → ARC 已 RESOLVED → outstanding → ack-only」 |
| 启动 helper | `apply-core-room-mention-gate.test.sh` 的 hermetic 形态 | `lead-duty-provision.test.sh`:直接跑 helper —— 席位 → apply 被调一次且带 `--allow-bot`;非席位 → 不调且 `FLYWHEEL_ALERT_DUTY_TOKEN` 被 unset;**席位但 token 未设 → `gate=skipped:no_duty_token token=unset`,access.json 逐字不变**;CLI 缺失 → `gate=skipped:cli_missing` 且 stderr 有内容;Bridge 不可达 → `dispatcher=unresolved:bridge_unreachable` 仍翻门控;launch plan 席位含 token、非席位不含 |
| Hub 渲染 | `alert-ticket-lifecycle.test.ts` | `renderTicketLine(row, ownerText)` 只改 🎫 行、其他行逐字不变;legacy root 跳过;C3 文案两种 ack 帖不含「Cass」 |
| rescue ACK 删除 | 既有 rescue 测试(`grep -rl ackTicket … --include=*.test.ts`) | 改断言:rescue 跑完 `acked_at` 仍 NULL、`ticket_status` 不变;`ackTicket` 在 `plugin.ts` / `rescue-route.ts` 零引用 |
| CLI | `commands/ack-event.ts` 形态 | 四个子命令解析;locator 互斥;`--wait` 仅对含 🎫 的 404;token 只读 `FLYWHEEL_ALERT_DUTY_TOKEN`;退出码 0/2/3/4/5(fake fetch) |
| 角色文件 | `scripts/__tests__/fly1674-residue.test.sh` 这类对 `.lead/*/identity.md` 的文本断言 | 哨兵按 plan §2.7:必含「先发帖再记账」「记账 = 完成」「落账:待执行」「handoff --to <leadId>」等;必不含「只响应 … 显式 @你」「修不掉才 @Annie」「先 ack 再发帖」「账本:<回执」「--to <@」;②/③ fixture 恰一个 `<@id>` |

全仓门:`pnpm lint` → `pnpm -r build` → `pnpm test:packages:run` → 新 shell 测试(FLY-224/248 教训:整仓不只改动文件;生产 host 上全量 vitest 以 CI 为准)。

## 7. 验收怎么采(issue 原文:一条真实告警走完 ①/②/③ 之一并在 thread 留痕)

前提:2075 已部署(频道里有 ticket 根消息 + Hub 开 thread + 不自动 @founder);本单已部署(角色文件新版 + 门控 `false` + 路由在线)。触发点 = 部署后**第一条真实** ticket 根消息,不注入。

| 步 | 证据 | 判 |
|---|---|---|
| 1 | Claw 启动日志:`[alert-duty] seat=… gate=changed\|noop dispatcher=<id> token=set`;`jq` 核 `access.json`:`requireMention=false` **且** `allowBots` 含 dispatcher | 必须 |
| 2 | `comm.db`:该根消息的 `discord_chat` 行到达 Claw 且 ACKED(`chat_id` = 告警频道,`content` 含该 `message_id`) | 必须(证明「看到了」) |
| 3 | thread 里有 `🧭 值守初审` 帖(作者 = Claw 的 bot),去向 ∈ {①,②,③},字段齐(§3.2);恰一个 `<@id>` 或没有 | 必须(留痕) |
| 4 | `teamlead.db`:`alert_threads` 该行 `acked_at` 非空(= 处置完成);`ticket_status` 按 plan §2.1 表;handoff 时 `owner_ref = lead:<to>` | 必须(账本与帖一致) |
| 5 | 根消息 🎫 行 owner / 状态段与账本一致(截图);① 时:✅ 帖 + `resolved_at` + `$FLYWHEEL_STATE_DIR/oncall-drafts/<kind>.md` 新段;②③ 时:帖中真 `<@id>`(**必达**标「待 2078」);owner=Codex bot 的工单:帖内**无** @ | 按去向 |
| 6 | 24h 观察:Claw 在根频道的帖 = 0(除压力自述);同一工单 🧭 帖 = 1(G1 的例外逐条解释);旁路通报**无**回帖;无回自己 / 回 dispatcher 根消息的帖 | 必须(回环护栏) |
| 7 | 重启 Claw 一次(正常班车):`outstanding`(含离线期间被 ARC 自动 RESOLVED 的)欠账被补齐;已记账的不重做 | 必须(恢复) |
| 8 | 6h 内没有任何 ticket 根消息 → `INCONCLUSIVE`,继续等;不注入 | 处置 |

**① 的首选样本**:`bridge_abnormal_exit`(有 ARC:launchd 已复活,验证 = `/health` 的 `buildSha` + 进程启动时间;2077 种子条目之一;近 7 天 17 条)。

## 8. 会过期的结论(as-of 2026-08-26 08:10Z)

| 结论 | 重核 | 何时作废 |
|---|---|---|
| 插件 `gate()` thread 继承父 group、`requireMention ?? true` | `grep -n "isThread() ? msg.channel.parentId" ~/.claude/plugins/cache/flywheel-plugins/discord/0.0.4/server.ts` | 插件升版(`check-discord-plugin.sh --print-install-path` 变) |
| `access.json` 热加载 | `grep -n "loadAccess()" …/server.ts` 在 `gate()` 首行 | 同上 |
| `/api/*` 由 bearer 保护;`archive` 路由 503 形状 | `plugin.ts:2494`;`tools.ts:1059` | 路由重构 |
| `INFRA_ALERT_LAST_MILE_ROUTE` 6 处引用 | `grep -rn INFRA_ALERT_LAST_MILE_ROUTE packages --include=*.ts \| grep -v dist` | 2075 合入后可能增减 |
| `updateRootTicketStatus` 为私有 | `AlertChannelHub.ts:590` | 本单加公开包装后 |
| `FLYWHEEL_DIR` / `FLYWHEEL_STATE_DIR` / `TEAMLEAD_API_TOKEN` 在 Lead 子进程 env | `flywheel-lead-wrapper-v2.sh:318-350`;`claude-lead.sh:238` | wrapper 改 env 白名单 |
