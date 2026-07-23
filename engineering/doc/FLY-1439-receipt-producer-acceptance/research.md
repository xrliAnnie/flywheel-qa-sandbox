# FLY-1439 插件收据核销 producer 独立真机验收 — 调研
Issue: FLY-1439 (https://linear.app/geoforge3d/issue/FLY-1439/qafly-1437-独立真机验收-插件收据核销-producerfork-pr-17-bb0a1509)
日期: 2026-07-23
基于: exploration.md

以下事实全部经本会话在真代码/真脚本上核对(worktree = flywheel-FLY-1439 @ main 近 HEAD;fork 分支已作为 `plugins-fork` remote fetch 进本仓)。

## 1. 被测物事实

- head 核实:`git log plugins-fork/feat/FLY-1437-chat-receipt-producer` 顶 = `bb0a1509` "fix(discord): make settle proof write-ahead durable"。与 code-review.md 钉死的 head 逐字一致;base = `ff159052`(fork main)。
- 三条腿接线(fork `server.ts`):
  - `RECORDER_MODE = resolveRecorderMode(process.env)`(`server.ts:91`,进程启动时快照);
  - founder id:`server.ts:92-93` — `readEnvFile: () => readFileSync(join(homedir(), '.flywheel', '.env'))`,**硬编码生产路径,live 文件优先于继承 env**(`chat-receipt-recorder.ts:134-156`)→ 真机上 founder 恒 = Annie;driver bot 消息恒 P1(`buildBeginArgs` priority 判定 `recorder.ts:177`);
  - spool:`STATE_DIR = process.env.DISCORD_STATE_DIR ?? ~/.claude/channels/discord`(`server.ts:73`);begin intent = `${STATE_DIR}/chat-receipt-spool/<msgId>.json`,settle intent = `${spool}/settle/<msgId>.json`(`chat-receipt-runtime.ts:117-119`);
  - **settle write-ahead(R1 HIGH 修复)**:`chat-receipt-runtime.ts:187-233` — intent 在 CLI 调用**之前** 0600 原子落盘("proof must be durable BEFORE the settle CLI runs"),CLI 幂等成功后才 `rmSync`;写失败 fail-open + 可见 advisory;
  - advisory 出口:`server.ts` advise 回调 → `channel.send({ content: '⚠️ <text>' })` → **真 Discord 消息,可由 Discord API 断言**;
  - worker:单 dirty 状态机,`drainSpoolPass + drainSettlePass + pending reconcile`(`runtime.ts:296-301`),入站消息 finally piggyback kick + `client.once('ready')` kick。

## 2. CLI / DB / patrol 事实(main 仓,均已 merge)

- CLI:`packages/flywheel-comm/src/commands/chat-receipt.ts`(begin/complete/settle/pending/quarantine);FLY-1426 QA 报告(PASS)已实证 begin→pending / 幂等 / complete→delivered+SLA 窗 / settle→processed(`discord_explicit_reply`)/ quarantine 非终态。
- 行状态与 resend 形态:`lead_inbox` 表,resend child 由 `resend_of`/`resend_round` 标记(`lead-inbox-queue.ts:65-66,310-311`),`receipt_resend_deliveries` 账本(`:351`)。**「patrol 零重发」的 DB 级断言 = 无 `resend_of = <收据id>` 的行**;阳性对照 = 未 settle 行必须长出 resend child。
- patrol:Bridge 内 `LeadReceiptPatrol`(`packages/teamlead/src/bridge/plugin.ts:7854-7870`),`receiptWindowsMs = receiptPriorityWindowsMs()`(Bridge boot 时读 env)、per-project lead ids 来自 projects registry、`commDbPathForProject` 按项目定位 comm.db;经 GatePoller `onReceiptWakePatrolTick`(`plugin.ts:7966-7969`)驱动,GatePoller tick = 3s × `receiptWakePatrolEveryNTicks`(`gate-poller.ts:679-680`)。
- 总开关:`FLYWHEEL_RECEIPT_FOUNDATION` **默认 ON**(=0 是应急回滚态,`gate-poller.ts:1339`)→ slot Bridge 无需额外开关。
- 窗口 env:`FLYWHEEL_RECEIPT_WINDOW_P0_MIN…P3_MIN`。**两个消费点都要收窄**:插件侧(complete 时写 `next_unprocessed_at`,env 经 launcher 进 Lead)与 Bridge 侧(patrol advanceDue,env 在 Bridge fork 前 export)。

## 3. 529 房环境通路事实

### 3.1 slot 部署形态

- `scripts/test-deploy.sh` = 「Bridge + 真 Lead」单 slot 部署;`--no-lead` 可只起 Bridge(`:150`);slot 目录 `/tmp/flywheel-test-slot-N/`。
- slot Lead 启动 env 块(`test-deploy.sh:1112-1129`):`env -u DISCORD_BOT_TOKEN -u LEAD_WORKSPACE -u CLAUDE_CONFIG_DIR -u FLYWHEEL_LEAD_MODEL -u FLYWHEEL_LEAD_EFFORT` 后设 `DISCORD_BOT_TOKEN=<TEST_BOT_TOKEN>`、`DISCORD_STATE_DIR=${SLOT_DIR}/discord-state`、`BRIDGE_URL=localhost:<slot port>`、`FLYWHEEL_PROJECTS_FILE=${SLOT_DIR}/flywheel-projects.json`、`${LEAD_EXTRA_ENV[@]}`(**在 -u 之后展开,后写胜出** → 注入口)→ `claude-lead.sh`。
- **`-u CLAUDE_CONFIG_DIR` = slot Lead 默认吃生产 `~/.claude/plugins/`**;`test-deploy.sh:539-544` 甚至断言生产缓存含 allowBots——房间现状依赖生产插件版本。`LEAD_EXTRA_ENV` 现仅由 roundtable/alerts 特性块喂(`:633-701`),无通用注入口 → **需要加 default-off 钩子(exploration §4.1 选项 C)**。
- launcher(`packages/teamlead/scripts/claude-lead.sh`):
  - `FLYWHEEL_COMM_DB = ~/.flywheel/comm/<PROJECT_NAME>/comm.db`(`:471`,test project 名自然隔离);`FLYWHEEL_COMM_CLI` **无条件覆写**为启动 checkout 的 `packages/flywheel-comm/dist/index.js`(`:473-477`)→ 故障注入只能落在「Lead 启动 checkout 的 dist」层;
  - tmux `-e` allowlist 显式透传:COMM_DB/CLI、`FLYWHEEL_CHAT_RECEIPTS`、`FLYWHEEL_RECEIPT_WINDOW_P0..P3_MIN`(`:1437-1446`)、`DISCORD_STATE_DIR`(`:1434`)——FLY-1426 S5 已铺好;
  - companion 形态:projects.json 里 `companion:true` → `IS_COMPANION_ROLE=true`(`:378-383`,检测 inconclusive 直接 fail-STOP)→ pane 注入 `FLYWHEEL_LEAD_COMPANION=1`(`:1499-1501`)+ launcher 自身的 COMM 清空合同 → **真 companion env shape 由 launcher 生产,QA 只需给 slot 的 `flywheel-projects.json` 写 companion lead 条目**;
  - 启动时跑 `check-discord-plugin.sh`/`update-discord-plugin.sh` 完整性检查(`:706-737`)——两脚本硬编码 `$HOME/.claude`/fork **main**(`update-discord-plugin.sh:5-7,36`),不会碰隔离目录,也不可能把生产刷成 PR #17(PR 不在 main)。风险仅为把生产缓存例行刷回 fork main(其常态行为,无害)。
- 插件生产安装结构(镜像目标):cache dir(由 `installed_plugins.json` 解析)+ `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord`(**MCP server 实际从 marketplace dir 跑**,`update-discord-plugin.sh:33-36`)+ `bun install` + `.fork-sha` 戳。

### 3.2 隔离硬规则(队规,踩过的雷)

- **`FLYWHEEL_DELIVERY_SECRET_PATH` 必设**指向 slot 内路径,否则隔离 Bridge `removeOrphanVersions()` 会清掉生产 delivery secret(潜伏损坏,生产下次重启才炸);
- **短 `TMPDIR`**(如 `/tmp/fly1439t`)必设,否则继承的长路径撞 tsx IPC unix-socket 104 字符上限,Bridge 秒死;
- 部署前 grep slot `bridge.log` 有无 `No project runtimes initialized`(生产 `audit.db` 损坏会让全部 slot 瘫;先查再折腾);
- 本单**不注入 Linear issue、不起 runner** → dept-scope/inject 等坑不适用;chat 消息链即可。
- bot-to-bot:driver bot 的消息要被 slot Lead 插件放行,需在 slot Lead 的 access allowBots 内(529 房 mirror 模式既有机制;`test-deploy` identity staging + `DISCORD_STATE_DIR/access.json`)。

## 4. 故障注入面(shim 规格的依据)

- 插件 spawn 合同:`["node", commCli, "chat-receipt", <sub>, ...flags]`,stdin pipe 喂 content,5s 超时 kill,exit code 判定(fork runtime;1437 plan §3.2)。`commCli` = 进程启动时快照的 `FLYWHEEL_COMM_CLI`。
- → shim = 替换 **Lead 专用 worktree** 的 `packages/flywheel-comm/dist/index.js`:默认 spawn 真 dist(argv/stdin/stdout/stderr/exit 全镜像)+ 逐调用追加 JSONL 账本(ts/subcommand/argv);旗标文件(`$SLOT_DIR/shim-mode`)切 `fail-begin`(begin exit 1)/`hang-complete`(complete sleep>5s)/`hang-settle`(settle sleep 600)。Bridge 不经 CLI 入口(库 import),且跑在另一 checkout → 零影响。
- kill 面:Lead session = tmux window(`flywheel` session 内 `<project>-<agentId>` 窗named,`test-deploy.sh:1143`)→ `tmux kill-window` / 对 MCP 子进程 `kill -9` 均可;重启 = 重跑 Lead 启动(带同 env)。

## 5. 172 测试口径复核面(验收 #5)

- 复现基线:fork checkout @ bb0a1509,`external_plugins/discord` 下 `bun test`,预期 172 pass / 411 assertions(codex R2 独立复跑口径;前提 = 真 built PR-1 CLI 在位 + `/usr/bin/sqlite3`)。**R1#4 纪律:集成测试必须真跑;`FLYWHEEL_COMM_CLI` 未配的 loud-skip 不算绿** → 复核时必须确认集成用例实际执行数非零。
- FLY-1435 教训的具体形态:测试 fixture 用「显式 null」冒充「省略字段」→ 被断言机制根本没开启 → 空过绿。审计动作:对关键断言(write-ahead、byte-compat 快照、settle 谓词、幂等)各做一次**定向 mutation 探针**——手工反转被测机制(如注释掉 settle intent 落盘行),对应测试必须变红;不红 = 空过绿,记 FAIL 证据。
- byte-compat 快照的对照物:fork main(`ff159052`)的 server.ts 三处字符串——快照内容应与之逐字一致,否则快照锚的是自己不是 stock。

## 6. 待验假设(计划里全部立为门)

| # | 假设 | 验法 | 失败退路 |
|---|---|---|---|
| A1 | `CLAUDE_CONFIG_DIR` 指向隔离目录时,`--channels plugin:discord@claude-plugins-official` 从隔离目录的 marketplace 解析插件 | G0 冒烟:`ps eww` 抓 MCP server 进程 argv/cwd,脚本路径必须在隔离目录下,且该目录 git HEAD = bb0a1509 | 退路 = 抛弃 config-dir 方案,改「隔离 HOME」形态(重、但确定);二者都不行 → 上报 Lead,绝不动生产缓存 |
| A2 | 隔离 config dir 可带登录态(既有 recipe:isolated logged-in CLAUDE_CONFIG_DIR) | 启动即知(登录墙 = 失败) | 按 recipe 重做登录态;不行 → 上报 |
| A3 | slot Lead(真模型)看到带 receipt_id 的消息会按 MCP instructions 用显式 reply_to 回复 | S1 主线直接验;失败本身是**产品级发现**(instructions 引导力不足),记录进 verdict 而非当 harness 故障 | 复跑 1 次排除偶然;仍不带 → 该腿 FAIL 证据 + settle 机制腿改用 MCP 客户端直调 reply 工具补充隔离定位(标注为机制级证据,不替代能力级) |
| A4 | driver bot 消息过 gate(allowBots + 频道 allowlist) | 部署后先发一条冒烟消息看 Lead 是否收到 | 按 529 房 access.json 既有配方修 |
| A5 | shim 透明模式下全链与真 CLI 无差(不引入 Heisenbug) | G0 里 shim passthrough 跑一条完整链与直连对照 | shim 仅在故障场景挂载,健康场景直连真 dist |

## 7. 取证面汇总(断言的四路独立来源)

1. **slot comm.db**(`~/.flywheel/comm/<test-project>/comm.db`,sqlite 只读查询):行状态三迁移、`resend_of` 子行、evidence JSON、时间戳(`next_unprocessed_at - delivered_at` 验窗口透传);
2. **spool 目录**(`$SLOT_DIR/discord-state/chat-receipt-spool{,/settle}/`):intent 出现/消失/权限位(0700/0600)/`.corrupt`/meta latch;
3. **Discord API**(bot token,只读 fetch):入站消息、Lead 回复的 `message_reference`、`⚠️` advisory、`[redelivery]` 前缀消息;
4. **shim 调用账本 + lead.log/bridge.log**:CLI 调用序列(begin/complete/settle 次序与次数)、插件 stderr(broken 告警、诊断行)。

每条断言至少两路来源交叉;「工具说它成了」不算证据。
