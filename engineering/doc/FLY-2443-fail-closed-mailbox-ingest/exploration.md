# FLY-2443 Claude Lead fail-open 旁路改 fail-closed — 探索

Issue: FLY-2443 (https://linear.app/geoforge3d/issue/FLY-2443/通路claude-claude-lead-的-fail-open-旁路改-fail-closed缺-env-不再绕过-mailbox)
日期: 2026-09-08
基于: 无(上游为 FLY-2439 v3 §A3 的通路审计,见 `origin/flywheel-FLY-2439:engineering/doc/FLY-2439-lead-paths-uml/lead-paths.md:56-58`)

## 1. 问题一句话

Claude Lead 的 Discord 插件在启动时若发现三个 Flywheel env(`FLYWHEEL_COMM_CLI` / `FLYWHEEL_COMM_DB` / `FLYWHEEL_LEAD_ID`)缺任一,就把自己标成 `broken`,之后**每一条**入站消息都绕过 mailbox,用 MCP `notifications/claude/channel` 直接推进模型会话;只在 stderr 打一行,Discord 侧完全看不出来。founder 2026-09-08 直令:改成 fail-closed —— 缺 env 就拒收 + 告警 + dead-letter,「所有信先进 mailbox」不留例外。

## 2. 现状(逐行核过,插件字节 = 生产在跑的 `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.6/`)

代码不在本仓:插件源码在 fork 仓 `xrliAnnie/claude-plugins-official` 的 `external_plugins/discord/`(marketplace `flywheel-plugins` 以 git-subdir 指向 fork `main`)。本仓只有部署脚本 `scripts/discord-plugin/{update,cutover,check}-discord-plugin.sh` 和设计文档。

| 环节 | 位置 | 行为 |
|---|---|---|
| 模式判定 | `chat-receipt-recorder.ts:87-116` `resolveRecorderMode(env)` | 四态:`disabled/isolated`(companion 或 external lead 显式隔离)、`disabled/stock`(三 env 全空 = 非 Flywheel 原版安装)、**`broken`(三缺一或二)**、`enabled`(三齐) |
| 判定时机 | `server.ts:104` | 进程启动时一次性读 `process.env`;之后不再重判 |
| broken 的唯一动作 | `server.ts:109-113` | stderr 一行 `DISCORD MAILBOX WIRING BROKEN: missing …; inbound delivery remains fail-open` |
| 入站分叉 | `server.ts:1719-1752` | 只有 `enabled` 才 `buildBeginArgs` → `acceptInbound`;其余 `delivery='legacy'` |
| 直推 | `server.ts:1767-1782` | `delivery==='legacy'` → `mcp.notification({method:'notifications/claude/channel', …})`,不进 comm.db、不经 Bridge |
| 运行时 | `chat-receipt-runtime.ts:100-104` | `acceptInbound` 在非 enabled 时直接返回 `'legacy'`;enabled 时 spool intent → spawn `chat-ingest` → 落 `mailbox` 表(`mailbox-schema.ts:193` 起) |
| 回执 | `server.ts:1763-1765` | 无论走哪条路都打同一个 ack reaction —— founder 看到的回执一模一样 |

生产实况(2026-09-08,只看变量名):6 个在跑的 `bun …/discord/0.0.6/server.ts` 进程三 env 全齐;20 个 lead 的 `STATE_DIR/.env` **没有任何一个**配了 `DISCORD_ALERT_CHANNEL`。也就是说旁路今天没在触发,但一旦触发,现有告警频道机制也送不出去。

env 从哪来:Lead 启动器把三者注入 Claude Code 进程环境,插件作为 MCP 子进程继承 `process.env`(`start-adapter.sh` 直接 `exec bun server.ts`)。`FLYWHEEL_LEAD_ID` 由 `scripts/flywheel-lead-wrapper-v2.sh:440` 强制断言;`FLYWHEEL_COMM_CLI` 在 Runner 侧的注入(`packages/claude-runner/src/TmuxAdapter.ts:760-768`)是「`require.resolve` 失败就静默不注入」—— 这正是「缺一」最现实的来源形态:解析失败无声,插件随后无声 fail-open。

## 3. 为什么现在要改(而不是「反正没触发」)

- FLY-2439 审计把「Bridge 是否必经」当作通路可信度的硬指标;A 路线唯一的例外就是这条车道。留着它,「所有信先进 mailbox」就是一句带脚注的话。
- 旁路触发时零可观测:无 mailbox 行、无 Bridge 事件、Discord 回执与正常路一样。出了事没法从任何账本里发现。
- 「缺 env」是配置事故,不是流量事故。配置事故的正确反应是**响亮地拒绝**,让人来修,而不是悄悄换一条没人看的路继续跑。

## 4. 方案空间

### O1 启动即退出(broken → `process.exit(1)`)

最硬的 fail-closed。**否决**:插件死了 Lead 就完全收不到 Discord,MCP 会反复重启;而且死进程什么都发不出去 —— Discord 侧照样看不见「为什么」。它把「看不见的旁路」换成「看不见的黑洞」。

### O2 进程存活、逐条拒收 + 可见回执 + dead-letter(推荐)

插件照常连上 Discord 网关、照常注册 reply 等工具(模型还可能在回旧消息),但 `broken` 模式下入站消息:

1. **不推会话**:`acceptInbound` 返回新值 `'rejected'`,`server.ts` 对 `rejected` 既不 MCP 直推也不 kick worker。
2. **Discord 可见「未投递」**:用 ⛔ reaction 取代 ack reaction(逐条可见、零文字刷屏);外加每个 (channel, 进程生命期) 一条文字通知,说明缺哪个 env、消息已 dead-letter、修复后会重放。
3. **告警**:配了 `DISCORD_ALERT_CHANNEL` 就发一条(按进程生命期去重);没配就走既有 `gateway-health-dead-letter.jsonl` 本地 dead-letter,同 FLY-2226 的 `GatewayFailureAlerter` 形状。
4. **dead-letter**:把 `BeginArgs` 以 write-ahead intent 形式写进既有 `chat-receipt-spool/ingest/`(带 `rejection` 标记),但**不**spawn CLI(不知道 CLI/DB 在哪);健康重启后既有 worker 自动 drain → 迟到但经 mailbox 投递,零丢信。

### O3 broken 时「猜」缺失值继续走 mailbox

例如从 `LEAD_ID`/项目名推导 comm.db 路径。**否决**:猜路径 = 换了皮的 fail-open;写错库比不写更糟(信进了别人的信箱)。

### 可见性方式的取舍(与 FLY-1730 的红线)

FLY-1730 把所有 plumbing advisory(`channel.send('⚠️ …')`)净删,并用结构测试锁死「频道零 ⚠️ 广播」(`chat-receipt-runtime.test.ts` 首个用例)。那次删的是**健康消息**因 receipt CLI 失步而被逐条打 ⚠️ 的噪音。本单是**消息真的没投递**,性质不同:founder 必须知道。折中:逐条只用 reaction;文字通知按 (channel, 进程生命期) 只发一条;不复活 `advise*` 命名与注入面,让 FLY-1730 的结构负测继续绿。这一条已作为非阻塞问题问 Lead(question `82731579`),Lead 答复后按答复改。

### dead-letter 要不要自动重放

倾向自动重放:dead-letter queue 的意义就是「修好后能回放」;复用既有 intent/worker 零新机制;信件带原始 `ts`,模型看得到它是迟到的。风险:env 长期缺失时 intent 累积(每条一个小 JSON,stall 日志一次性 latch,可接受)。同样交 Lead 裁定。

## 5. 与「不改 Codex 侧」的关系

Codex Lead 的入站是 `RestPollDiscordInboundSource` + `CodexDiscordMailboxStrategy`(FLY-2439 §B),与本插件无关。本单只碰 fork 仓的 Discord 插件;主仓只加设计文档与部署记录,不动 `packages/teamlead/src/lead-backends/codex/`。

## 6. 诚实边界(本单不做)

- `disabled/stock`(三 env 全空)与 `disabled/isolated`(companion / external lead)仍走 legacy 直推:前者是非 Flywheel 原版安装,后者是 FLY-569 有意隔离的 companion。三全空在 Flywheel Lead 下几乎不可能(wrapper 强制注入 `FLYWHEEL_LEAD_ID`),但要写明这不是本单覆盖的形态。
- 不给 20 个 lead 配 `DISCORD_ALERT_CHANNEL`(那是 FLY-2226 灰度前置,运维动作)。本设计在没配时靠 ⛔ reaction + 一次性文字通知 + 本地 dead-letter 文件保证可见与不丢。
- 不做「重放成功后撤 ⛔ 换 ✅」的回执修正;重放后的信在 mailbox 与 Bridge 账本可查。
- 启动后 env 不会变,所以不做运行时重判;修复 env 必须重启 Lead,这是既有事实。

## 7. 待 Lead 裁定(非阻塞,已发问)

1. 一次性文字通知是否保留(vs 只 reaction)。
2. dead-letter 自动重放 vs 只留档。
