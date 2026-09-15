# FLY-1948 slot Lead Discord 通道活连接 — 探索

Issue: FLY-1948 (https://linear.app/geoforge3d/issue/FLY-1948/529房缺陷-slot-lead-的-discord-通道适配器无活连接-founderlead-整圈验不通)
日期: 2026-09-14
基于: 无

## 0. 一句话

529 房把「slot Lead 起得来」定义成 inbox-mcp 写出 `.inbox-ready-<agentId>` lease 且 pid 存活,整条链上没有任何一处断言 Discord 通道适配器(`bun <plugin>/server.ts`,claude 的直接子进程)已经拉起并持有到 Discord 网关的活连接;因此「横幅打了」与「通道活着」在房里是两个互不蕴含的事实。

## 1. 症状回放(issue 原文 + 本次核实)

- 8-20 FLY-1867 / FLY-1887 两轮 QA 独立实测:slot Lead 起得来、侧边横幅照打,但进程树里没有 discord adapter、没有到 443 的 ESTABLISHED;founder 登录态发消息 5 分钟不进 Lead 会话。
- 8-20 的房间目录(`/tmp/flywheel-test-slot-N/`)早已被 teardown 清掉,当时的 lead.log / gateway-health.log 不可考。Linear MCP 在本 runner 401,issue 评论里的原始证据也读不到。
- 能考的只有 `~/.flywheel/logs/lead-flywheel-test-N-startup.log`(launcher 的 dialog-poller 账本,只保留 09-04 之后)。它显示 dev-channels 对话框自动确认在 slot Lead 上**不是每次都成功**:

| slot | 09-04 至 09-14 的启动次数(有 `start pane` 行) | `confirmed=1` | `DEV_CHANNELS_DIALOG_NOT_SEEN after 90s` |
|---|---|---|---|
| test-1 | 8 | 3 | 4 |
| test-2 | 8 | 5 | 3 |
| test-3 | 7 | 6 | 1 |
| test-4 | 7 | 5 | 2 |

`NOT_SEEN` 的语义是「90 秒内 pane 上没出现过 dev-channels 对话框」。它同时覆盖两种截然相反的现实:(a)对话框根本没弹(通道没加载或不需要确认);(b)对话框弹晚了/文案变了,Lead 从此停在对话框上直到有人按键。launcher 对两种情况都 `return 0`,房间对两种情况都照发 lease、照报 ready。

## 2. 生产链路是什么样(地面真值)

在本机对生产 Lead `claude-infra-bot-lead`(pid 60298,v2 carrier)实测:

```
claude --agent claude-infra-bot-lead --permission-mode bypassPermissions \
  --dangerously-load-development-channels plugin:discord@flywheel-plugins server:flywheel-inbox ...
  ├── node packages/terminal-mcp/dist/index.js
  ├── npm exec @playwright/mcp@latest
  ├── bun ~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts   ← Discord 通道适配器
  ├── node packages/inbox-mcp/dist/index.js                                   ← 写 .inbox-ready lease 的那个
  └── bun ~/.bun/bin/gbrain serve
```

- 适配器 = Claude Code 的 channel 插件 MCP server。`.mcp.json` 让 claude 起 `start-adapter.sh`,脚本 `exec bun server.ts`,所以适配器是 claude 的**直接子进程**,argv 固定为 `bun <abs>/discord/<ver>/server.ts`(FLY-183 定的形状,`reap-orphan-adapters.sh:_is_discord_adapter` 已按此匹配)。
- 活连接形状:`lsof -p <adapter-pid>` 一条 `bun.exe … ->162.159.x.x:443 (ESTABLISHED)`(Cloudflare 上的 gateway.discord.gg)。
- 适配器就绪的日志证据:
  - stderr:`discord channel: gateway connected as <bot#tag>`(`server.ts:1819` `client.once('ready')`);
  - 文件:`$DISCORD_STATE_DIR/gateway-health.log` 追加 `<iso> gateway shard 0 ready`(`gateway-health.ts:90` 经 `GatewayHealthFiles.log`,0600,256KB 轮转)。
- 适配器的配置来源:`DISCORD_STATE_DIR`(默认 `~/.claude/channels/discord`,生产每个 Lead 一个 `discord-<leadId>`),token 从 `$DISCORD_STATE_DIR/.env` 读,真实 env 优先;没 token 直接 `exit 1`。
- 适配器进程只在两处会「不存在」:claude 根本没去起它(通道未加载 / 对话框没过),或它起了立刻死(bun 缺、`bun install` 失败、无 token、login 失败)。两种都只留 stderr,而 stderr 进 claude 的 MCP 日志,不进任何房间证据。

## 3. 529 房是怎么起 slot Lead 的(与生产同链,但没人验通道)

`scripts/test-deploy.sh` → `qa_slot_start_lead()`(`:1556-1712`)→ launchd plist(`com.flywheel.qa.lead.slot-N.<agentId>`)→ `scripts/flywheel-lead-wrapper-v2.sh` 在 slot 私有 tmux socket 起前台 server → `lead-body.sh` source `packages/teamlead/scripts/claude-lead.sh` → 同一条 `claude --dangerously-load-development-channels plugin:discord@flywheel-plugins server:flywheel-inbox`。

与生产的差异只有坐标:`DISCORD_STATE_DIR=<SLOT_DIR>/discord-state`(`.env` 里是 `TEST_BOT_TOKEN_N`,`access.json` 只放 slot 频道),`CLAUDE_CONFIG_DIR` 被 `env -u` 剥掉后仍用生产 `~/.claude` 的插件缓存(除非显式 `TEST_LEAD_CLAUDE_CONFIG_DIR`)。

房间对 Lead 的全部「活」判据(`test-deploy.sh:1808-1857` + `scripts/lib/qa-launchd-lead.sh:qa_launchd_lead_verify`):

| 判据 | 证明了什么 | 没证明什么 |
|---|---|---|
| launchd pid == manifest pid,私有 socket 上有 `=main` session | wrapper 起来了 | claude 起没起都不知道 |
| `<SLOT_DIR>/state/comm/<project>/.inbox-ready-<agentId>` 存在且 `.pid` 存活 | **inbox-mcp** 这个 MCP server 起来了 | Discord 适配器有没有起、有没有连上 |
| dev-channels 对话框 poller(launcher `_poll_dev_channels_dialog_v2` + 房间 `confirm_dev_channels_prompt`) | 若看见对话框就按 `1` | 没看见 = 静默 `return 0`,不区分「没弹」与「弹晚了」 |
| `room-info.json` | slot/port/token 路径/build SHA | 一个 Discord 字段都没有 |

全仓 `scripts/test-deploy.sh`、`scripts/lib/qa-*`、`scripts/qa-529-generalized-e2e.mjs`、`scripts/test-teardown.sh` 里对 `ESTABLISHED`、`:443`、适配器进程 census、`gateway-health.log` 的引用为 **0**。唯一两个适配器 census(`reap-orphan-adapters.sh`、`cutover-discord-plugin.sh:discord_adapter_census`)是生产运维工具,后者明文把 `--agent flywheel-test-*` 排除在外。

「横幅」= `test-identity.md` 里的 `TEST SLOT N — OVERRIDE` 提示块(`test-deploy.sh:1286-1420`),纯 prompt 级频道范围说明,与适配器无关;cmux 侧边栏标题也是 claude 一起来就写,与通道无关。所以「横幅不等于通道活着」在代码层是必然,不是偶发。

## 4. 已排除 / 待定的根因候选

| 候选 | 判定 | 依据 |
|---|---|---|
| FLY-1867 的 `--settings '{"enabledPlugins":{"playwright…":true}}'` 把 `discord@flywheel-plugins` 挤掉 | **排除** | Claude Code settings 合并是 deep-merge(settings-reference:"Deep merge with object values replacing/overriding previous definitions");且 FLY-1887 轮不含该改动仍复现 |
| 生产插件缓存与房间不一致 | **排除** | 房间用同一 `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.7`;`enabledPlugins` 里 `discord@flywheel-plugins: true` |
| slot token 缺失 → 适配器 `exit 1` | **弱** | `test-deploy.sh` 在 `.env` 缺 `TEST_BOT_TOKEN_N` 时前置就退出;wrapper-v2 还把 `DISCORD_BOT_TOKEN` 显式传进 claude 子进程 |
| dev-channels 对话框没被自动确认,claude 停在对话框上(通道没加载) | **主要候选** | 启动账本显示 09-04 以来 30 次 slot 启动里 10 次 `DIALOG_NOT_SEEN`;launcher 与房间 poller 都 fail-open;此状态下 inbox-mcp 照样起(lease 照发)而适配器不起 |
| 多个 slot/生产适配器共用一个 bot token 触发 identify 限流,新适配器连不上 | **次要候选** | slot bot 各自独立 token,但 teardown 不彻底时旧 slot 适配器会成孤儿;launcher 起前会 reap `ppid==1` 的孤儿,理论上覆盖 |
| 适配器起了但 `bun install` 在 MCP spawn 环境失败 | **待定** | 只留 stderr,房间不采;本次复现观察 |

§5 记录本次在当前 main 上的真机复现结果,用来在这些候选里定案。

## 5. 真机复现(2026-09-14,当前分支 HEAD,slot 2,`--generalized --stub-runner`,带 Lead)

命令:`scripts/test-deploy.sh 2 --generalized --stub-runner`(不加 `--no-lead`),前置需先 `pnpm install --frozen-lockfile` + `pnpm -r build`(第一次因 better-sqlite3 未装被 preflight 拒,exit 2)。证据原件拷在本 runner scratchpad `repro/`,房间已 `test-teardown.sh 2` 拆除。

### 5.1 冷启动(20:24:17Z 起 Lead)

| 时刻(UTC) | 事件 | 来源 |
|---|---|---|
| 20:24:30 | `dialog-poller-v2: start pane=%0 timeout=90s` | launcher startup.log |
| 20:24:32 → :33 | `matched dev-channels dialog, sending '1'` → `confirmed=1` | 同上 |
| 20:24:34.234 | inbox-mcp 写 lease `{"pid":87728}` | `.inbox-ready-flywheel-test-2` |
| 20:24:35.459 | `gateway shard 0 ready` | `discord-state/gateway-health.log` |
| 20:24:52 | 房间判 `Lead flywheel-test-2 ready (lease alive, PID 87728)` | test-deploy stderr |
| 20:25:21 | 实测:claude(86588)直接子进程含 `bun …/discord/0.0.7/server.ts`(87270);`lsof -p 87270` 两条 `->162.159.x.x:443 (ESTABLISHED)` | ps / lsof |

同一时刻房间自己的 `confirm_dev_channels_prompt` 打的是 `No dev-channels prompt observed for flywheel-test-2` —— 因为 launcher 的 poller 已经在它开始轮询之前把对话框按掉了。这行日志在 ready 路径上是**噪音**,在故障路径上又**不区分**「没弹」与「弹了没按到」。

### 5.2 launchd 拉回(20:26:15Z `kill -TERM` claude)

| 时刻(UTC) | 事件 |
|---|---|
| 20:26:16.392 | 旧适配器写 `gateway shard 0 reconnecting`(claude 死,适配器随之退出) |
| 20:26:33 → :35 | 新 body 的 poller `start` → `matched` → `confirmed=1`(走 `--resume`) |
| 20:26:36.895 | 新 lease `{"pid":41347}` |
| 20:26:37.157 | 新适配器 `gateway shard 0 ready` |
| 20:27:25 | 实测:新 claude(40029)下适配器 40728 两条 443 ESTABLISHED;**ppid==1 的孤儿适配器 0 个** |

### 5.3 结论

- 当前 main 上,冷启动与 launchd 拉回两条路径的 slot Lead 适配器都**活**,时序上适配器就绪比 lease 晚约 1.2 秒,均远早于房间判 ready 的时刻。
- 8-20 的缺陷在今天**不重现**(2/2)。但 §1 的启动账本证明同一 poller 在 09-04 以来的 30 次 slot 启动里有 10 次 `NOT_SEEN`,而房间对那 10 次照样发 ready —— 无论那 10 次的适配器是死是活,房间都**没有证据**。这就是 issue 要修的东西:不是某一次的拉起链坏了,而是拉起链坏了时**没有任何断言会红**。
- 因此本设计不押注一个未复现的根因去改拉起链的内部,而是:(1)把「通道活连接」做成房间就绪门的硬断言;(2)把 poller 的 `NOT_SEEN` 从静默变成结构化裁决 + pane 快照;(3)给 founder→Lead→founder 整圈一个可执行的探针与可复核的证据。8-20 那类故障再出现时,房间会在 Lead 就绪门直接红,并留下足以定位的快照。

### 5.4 本次没做到的

- founder 登录态发消息的时延基线:claude-in-chrome 扩展未连接(`Browser extension is not connected`),没有起 chrome-repair 流程。「N 秒」阈值在 plan 里按适配器→mailbox 的可测链路定义,founder 手动腿留给 QA 节点。

## 6. 修向(供 research.md 展开)

1. **通道活连接断言**进 529 房的 Lead 就绪门:不看横幅,不看 lease,看三件硬证据——适配器进程是 claude 的直接子进程、该 pid 有一条 `:443 ESTABLISHED`、`$DISCORD_STATE_DIR/gateway-health.log` 有本次启动之后的 `gateway shard 0 ready`。任一缺失 = Lead 不算 ready,房间 fail-closed 退出并留取证快照。
2. **拉起链修复**:dev-channels 对话框 poller 的 `NOT_SEEN` 不再静默——区分「对话框没弹」与「弹晚了」,给房间一个可读的启动结论文件;必要时把 poller 的判定改成「以适配器就绪为终点」而不是「以对话框消失为终点」。
3. **整圈验收**:房间提供一条 founder→Lead→founder 的可执行探针(用 slot bot 自己 REST 发消息 → 适配器入站回执 → Lead 回帖),把「N 秒内进会话」写成可测数字。
