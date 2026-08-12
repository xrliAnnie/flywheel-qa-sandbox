# FLY-1715 Runner 不应加载 Discord plugin — 调研

Issue: FLY-1715 (https://linear.app/geoforge3d/issue/FLY-1715/runner-进程不应加载-discord-plugin-server-个例-roguefly-1704-runner-名下-bun)
日期: 2026-08-12
基于: exploration.md

逐条代码事实(全部在本 worktree HEAD 实读核对,file:line 可点),按病灶链三条件组织。

## 1. 条件 A:plugin 为什么被每个 claude 进程加载

### 1.1 user 级 settings 现状(实机读取)

`~/.claude/settings.json` `enabledPlugins`(2026-08-12 实读):

```json
"discord@claude-plugins-official": false,
"discord@flywheel-plugins": true        ← 生产在用的是 fork key
```

⇒ 机器上每个 claude 进程默认加载 `discord@flywheel-plugins`,其 MCP server 组件即 `bun ~/.claude/plugins/cache/flywheel-plugins/discord/0.0.4/server.ts`(巡检 pgrep 的目标)。

**key 命名陷阱**:runner-mcp-profile 的既有测试样例写的是 `discord@claude-plugins-official`(`packages/claude-runner/test/TmuxAdapter.test.ts:657`)——若禁用列表只写 official key,fork 照常加载,**空过**。任何禁用都必须两个 key 同时写。

### 1.2 per-launch 禁用机制(已存在,FLY-751/812/1185)

- `packages/config/src/runner-mcp-profile.ts:70-72` — 默认禁用列表**只剩 serena**:
  ```ts
  export const DEFAULT_RUNNER_DISABLED_PLUGINS: readonly string[] = [
      "serena@claude-plugins-official",
  ];
  ```
  头注(:59-68)记录了 FLY-812 founder 裁定史:discord 曾在 FLY-751 默认禁用列表里,2026-07-03 founder review 以「runners sometimes need discord during testing」为由移除。**本单事故即该裁定的代价面**;issue 文本「违反 Runner 不直接碰 Discord 设计」构成 supersede 依据,plan 中显式呈请翻案。
- `packages/claude-runner/src/TmuxAdapter.ts:1019-1035` — disabledPlugins/enabledPluginsExtra 合并为单个 `--settings {"enabledPlugins":{…}}` flag;头注记录真机 spike(2026-07-01)结论:**`false` 条目确实阻止该 plugin 的 MCP server 子进程 spawn**。
- `packages/config/src/runner-mcp-profile.ts:104` — `FLYWHEEL_RUNNER_SLIM_MCP=0` kill-switch → 返回 null profile → 无 `--settings` flag(**已知限制**,FLY-1185 §2.7 同款:kill-switch 下 per-launch 禁用全失效,只剩机器级默认兜底——这正是 A1+A2 要双做的理由)。
- `resolveRunnerMcpProfile` 的 opt-in 逃生口:`full-mcp` label(:120-126)、`playwright` label(:116)。**注意(r2 修正)**:`full-mcp` 只正向启用 playwright,**不会**正向启用 discord——机器 default-off 下它保持 off;它也不构成「测试用 discord runner」通道。且这些逃生口全部可绕(kill-switch/override)——所以 discord 禁用**不进**该机制,走独立的不可逃逸 forbidden 合同(plan §3 Phase 1);v1 不为 runner 预留任何 discord opt-in。

### 1.3 FLY-1185 极性翻转先例(A1 的可行性证据)

`runner-mcp-profile.ts:46-53` 头注:playwright 的机器级 default-off 由 ops step 写进 `~/.claude/settings.json`,per-launch `--settings` 正向 `true` 是「最高非 managed 优先级」(FLY-615/751 实测)——**机器 default-off + 单点 per-launch 正向 enable 的组合已在生产验证过**。A1 对 discord 复刻同款。

### 1.4 Lead 侧加载路径(A1 的待验证面)

- `packages/teamlead/scripts/claude-lead.sh:2068` — `CLAUDE_ARGS+=(--dangerously-load-development-channels "plugin:discord@flywheel-plugins")`。
- `claude-lead.sh:1196-1345`(FLY-1679)— 该 flag 触发 TUI 确认框,v2 载体内有 dialog 自动确认 poller。
- **未知点**:机器级 `enabledPlugins:false` 时,`--dangerously-load-development-channels` 显式点名 plugin 是否仍加载(该 flag 语义是「加载开发 channel」,可能绕过 enabledPlugins,也可能不绕)。真机 spike 必验;两分支的处置都已在 exploration §3.1 写明。
- Lead 子进程 env 边界:`claude-lead.sh:1614-1640` — Lead 的 claude 用 `env -i` + 显式 env_args 启动(DISCORD_BOT_TOKEN / DISCORD_STATE_DIR / LEAD_ID / FLYWHEEL_LEAD_ID / TEAMLEAD_API_TOKEN / BRIDGE_URL 全显式)。**Lead 侧已经是「显式注入」范式**——本单是把同款纪律带给 runner spawn。
- `scripts/flywheel-lead-wrapper-v2.sh:221-222` — v2 载体 SERVER_ENV 缺省补 `DISCORD_STATE_DIR`。

## 2. 条件 B:adapter 为什么无条件连 gateway

`~/.claude/plugins/cache/flywheel-plugins/discord/0.0.4/server.ts`(实读):

```
:74  const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
:79-86  load ${STATE_DIR}/.env 进 process.env(真 env 优先)
:90  const TOKEN = process.env.DISCORD_BOT_TOKEN
:458 无 token 则报错退出("DISCORD_BOT_TOKEN required")
:353-356 读 BRIDGE_URL / TEAMLEAD_API_TOKEN / LEAD_ID / PROJECT_NAME(reply-guard 等)
```

- 有 token 就连,**没有任何「持有者角色」判断**。
- 默认 state dir `~/.claude/channels/discord/` 实存,`.env`(mode 600,2026-05-01)含 token,`access.json` 最后写于 2026-05-10 —— **3 个月无活动**。含义:(a) 即使 runner env 干净,adapter 也会拿这个默认 token 连 gateway(增殖体≠都是 Lead 身份,还有「默认身份」形态);(b) A1 关掉 Annie 终端会话的 Discord channel 的实际影响≈0(报备即可);(c) 该 .env 本身是一个静置的暴露面,ops 清理项。

## 3. 条件 C:tmux server env 继承与 spawn 显式注入现状

### 3.1 TmuxAdapter 显式注入清单(`packages/claude-runner/src/TmuxAdapter.ts`)

窗口经 `tmux new-window -e KEY=VAL …`(:613-626)创建;pane 进程 env = **tmux server 进程 env**(fork 来源)+ `-e` 显式覆盖。现有 `-e` 注入(:360-554):

`FLYWHEEL_EXEC_ID`(:360)、`TMPDIR`(FLY-766)、`FLYWHEEL_BRIDGE_URL`(:465)、`FLYWHEEL_INGEST_TOKEN`(:468)、workflow 三凭据(:470-484)、`FLYWHEEL_STATE_DB_PATH`(:489)、`FLYWHEEL_COMPLETE_MARKER_DIR`(:496)、`FLYWHEEL_PROGRESS_PATH`(:500)、`FLYWHEEL_PROJECT_NAME`(:503)、**`FLYWHEEL_LEAD_ID`(:510,来自 ctx.leadId=registry 派生)**、`FLYWHEEL_COMM_CLI`(:516)、`FLYWHEEL_LAND_STATUS_PATH`(:530)、`BASH_MAX_TIMEOUT_MS`(:538)、transport env(:542-546)、per-adapter extra(:552-554)。

**从不触碰**:`LEAD_ID` / `DISCORD_STATE_DIR` / `DISCORD_BOT_TOKEN` / `TEAMLEAD_API_TOKEN` / `BRIDGE_URL` —— 全部 ambient 继承。Cass 抓获的三重嵌合体(pid 59595:`FLYWHEEL_LEAD_ID=product-lead` × `LEAD_ID=eng-lead` × `DISCORD_STATE_DIR=eng-lead`)即「一个显式 × 两个继承」的直接后果。

### 3.2 窗口启动命令结构(剥离的落点)

- claude 路径永远走 launch-gate shell(:580 `generationGated = this.type === "claude-tmux"`;:590-609):`sh -c 'cf=…; …; exec claude "$@"' …` —— 在 `exec ${binaryName}` 前插 `env -u NAME…` 即完成剥离,gated 语义零扰动。
- agy / kimi 走非 gated 直接 `[binaryName, ...claudeArgs]`(:609)——剥离需同时覆盖该分支(包一层 `env -u …`)。
- 子类现状:`AntigravityTmuxAdapter` / `KimiTmuxAdapter` 复用同一 spawn(仅覆写 buildCliArgs/binaryName/preflight);`KimiTmuxAdapter` 有 `extraPaneEnv()` 注入 seam(:548-554)。它们不加载 claude plugins(条件 A 与其无关),但**凭据继承(条件 C)同样命中**——剥离应在共享 spawn 层做。
- Codex 路径:`codex-daemon-*` 不走 tmux 继承,FLY-1643 已把 daemon env 改为「host 安全 base + 显式字段重建,继承的 FLYWHEEL_* 全丢」——同族先例,证明「显式重建」在本 repo 是已接受的范式。

### 3.3 tmux server 出生 env(病灶宿主的成因)

`ensureRunnerSession`(TmuxAdapter.ts:1477-1488 → tmux-session-ensure)在 base session 不存在时创建——**server 的 env 就是当时调用 tmux 的进程的 env**。88723 由 `tmux new-session -d -s recovery-anchor` 从带 eng-lead env 的上下文启动(运维恢复动作),此后 17 个 session 全长在这台 server 上。结构含义:**server env 是不可信的 ambient,任何靠它的正确性都靠不住**(下一次 rescue/恢复动作随时可能再造一台污染 server)——所以治本在 spawn 边界显式化,而非追求「server 永远干净」。

## 4. 凭据依赖面盘点(剥离清单逐项安全性)

| env | runner 侧合法读者 | 剥离影响 | 处置 |
|-----|------------------|----------|------|
| `LEAD_ID` | 无(flywheel-comm 用 `FLYWHEEL_LEAD_ID`/`--lead`;plugin server.ts:355 读它——正是要断的) | 无 | 剥离 |
| `DISCORD_STATE_DIR` | 无(仅 plugin server.ts:74) | 无 | 剥离 |
| `DISCORD_BOT_TOKEN` | 无(仅 plugin server.ts:90) | 无 | 剥离 |
| `TEAMLEAD_API_TOKEN` | **两个 runner 必经读者(r2 补全)**:① `flywheel-comm publish-report`(publish-report.ts:186-187 Bearer;Bridge plugin.ts:3824-3831 无 token 整路由 503);② **`ask`/gate/ack 的 lead-inbox nudge**(index.ts:385,455,682,1925-1931 传 env token;helper 在 401/403 时**从磁盘 `~/.flywheel/.env` 回读 master 再试**——lead-inbox-nudge.ts:67-79;服务端 `/api/lead-inbox/nudge` 为 master middleware,plugin.ts:2329-2350)。founder-ux.ts:143-178 注释明确设计意图:Lead-only,「Runner 的 ingest token 必须不能做特权写」 | **断 runner 的 DESIGN-HTML 交付 + ask/gate nudge**;且裸剥无效——nudge 的磁盘回读会把 master 捡回来(env -u 被运行时旁路) | 剥离 + **配套 C1b**(reports;§5)+ **nudge 收编**(plan §3 Phase 3.5:端点收 ingest、磁盘回读仅限 master-tier 初始凭据) |
| `BRIDGE_URL` | fallback only(publish-report.ts:148 `FLYWHEEL_BRIDGE_URL ?? BRIDGE_URL`;index.ts:386,456 同款;respond.ts:63,113 的 approve_to_ship/source-thread 路由是 **Lead 侧**动作) | 无(runner 有显式 `FLYWHEEL_BRIDGE_URL`) | 剥离 |
| `PROJECT_NAME` | flywheel-comm index.ts:685(`--project` 缺席 fallback);plugin server.ts:353-358(要断的) | ambient 值在污染 server 上本就是错的 | **无条件剥 + 有 ctx 显式重设**(ctx.projectName optional——adapter-types.ts:253-256;ctx 缺席=变量缺席,显式定义) |

结论:六件套全可剥;`TEAMLEAD_API_TOKEN` 需要 reports C1b + nudge 收编**两个**配套(只做 reports 会留下 nudge 磁盘回读旁路);`PROJECT_NAME` 需显式重设保 CLI 兼容。

## 5. C1b 配套:reports 路由的 runner 级鉴权

现状(r2 修正:端点结构按源码核准):

- reports 路由**只有两个端点**:`POST /publish`(reports-route.ts:210)与 `POST /deliver`(:311)。screenshot 在 **CLI 本地**采集(publish-report.ts:235-275,ProofShot),作为 `/deliver` body 的 `screenshotPath` 传入——**不存在独立 screenshot 端点**。
- 鉴权归属:reports-route.ts:12-14 明确「auth 属 plugin mount 层」;`packages/teamlead/src/bridge/plugin.ts:3795-3831` 现为整面 master middleware,Bridge 未配置 apiToken 则整路由 503(FLY-203「必须 apiToken,绝不裸跑」)。
- `/deliver` 的 channel 解析(reports-route.ts:397-423):显式 channelId → issue thread → **project generalChannel fallback**——即「不带 --channel/--issue」也是投递动作,不是安全形态。
- runner 已持有的显式凭据:`FLYWHEEL_INGEST_TOKEN`(TmuxAdapter:468 注入)——注意它是 **fleet-shared** 进程级 token(Blueprint 同值发给每个 runner),非 per-runner。
- token 碰撞面:`loadConfig()`(config.ts:126-134)分别读 `TEAMLEAD_INGEST_TOKEN` / `TEAMLEAD_API_TOKEN`,**无不等式约束**;若两值相等,任何「ingest 不得 deliver」的 403 都会被 master 比较先放行。既有先例:founder-ux routes 碰撞 503(founder-ux/routes.ts:130-150)、gemini scoped token 启动拒等(config.ts:75-100)。
- 语义拆分依据:publish(部署 HTML 到不可猜 URL)无 Discord 出站;deliver(发 Discord 消息)才是 Lead 特权动作。三条既有合同互证:runner 只跑 `--publish-only`(节点合同)、founder 物料 Lead-only 投递(团队纪律)、Runner 不直接碰 Discord(本单)。
- `PROJECT_NAME` 的 runner 侧读者:flywheel-comm index.ts:685(`--project` 缺席时 fallback `process.env.PROJECT_NAME`)——ambient 剥离需配显式重注,不能裸剥。

方案(细节见 plan §3 Phase 3):mount 层分路由鉴权(`/publish` = master∨ingest;其余含 `/deliver` = master-only,ingest 打 deliver 403);config 启动不变量 ingest≠master;CLI 凭据先判级、ingest-only 且非 `--publish-only` 一律前置 fail-fast(拒绝条件不看 channel/issue——generalChannel fallback 使默认调用也是投递)。

## 6. 现有清理器的边界(为什么不能靠它)

`packages/teamlead/scripts/lib/reap-orphan-adapters.sh`(FLY-183):kill gate = 「是 discord adapter **且 ppid==1**(孤儿)」。活父进程名下的增殖体(本单形态,父=活 runner claude)**结构性不在其射程内**——这是刻意的安全设计(绝不动活 agent 的 adapter),不是漏洞。⇒ 存量增殖体的收尾只能靠:部署修复后自然代谢(session 终结即消亡)+ 一次性人工 sweep(ops)。

## 7. 部署面(给 plan 的输入)

| 改动 | 生效条件 |
|------|----------|
| `~/.claude/settings.json` enabledPlugins 翻转(经幂等脚本,含 `--restore` 回滚接口) | ops 一次性动作,**即时**对新 spawn 的 claude 生效(存量进程不回收) |
| forbidden 常量 / TmuxAdapter / reviewer / classifier / SDK(ClaudeRunner) | Bridge(edge-worker)重启后生效——走正常 ship 部署车 |
| voice brains(Headless/Resident) | **voice-bridge 是独立 launchd daemon**(wrapper 独立 exec run-voice-bridge.ts)——需单独受管重启 + `:9878/health` 复验 + 既有 child 回收证明,Bridge 重启不覆盖它 |
| claude-lead.sh(若 spike 分支 b) | 各 Lead 重启后生效(launchd v2 载体,滚动重启) |
| Bridge reports+nudge 鉴权 + flywheel-comm CLI | Bridge 重启 + runner 用 main dist(spawn 时现读) |
| **默认 `~/.claude/channels/discord/.env`(+`.env.bak`)token 吊销** | **部署前置(plan Phase 0.5)**——不吊销它,剥 `DISCORD_STATE_DIR` 会把误加载的 plugin 推向默认 token,纵深防御不成立 |
| 88723 退役 / TEAMLEAD_API_TOKEN 轮换 / 存量 sweep | ops checklist,顺序约束:**C1b+nudge 收编先落地,再做 token 轮换与干净 server 迁移**(否则先断 publish-report 与 ask/gate) |

## 8. 验收判据素材(全舰口径)

- 巡检口径(与事故取证同尺):`pgrep -f 'discord/0\.0\.4/server\.ts'` 全舰计数 == 活跃 Lead 数(每 Lead 恰 1);runner / QA 体 / headless `-p` 名下 0。
- 对照组(修前基线,已有):16 Lead 各 1 + runner d71d5740 名下 1(rogue)+ 普查若干。
- 嵌合口径(Cass 已标定的尺,只读脚本 `/tmp/cass-adapter-audit.sh` 形态):新 spawn runner 的 pane env 实测无六名 ambient 身份/凭据、`FLYWHEEL_LEAD_ID` 与 team 一致。
- publish-report 回归:剥离后的 runner 真跑 `publish-report --publish-only` 成功(ingest token 路径);**任何非 publish-only 调用**(含不带 `--channel/--issue` 的默认形态——它经 generalChannel fallback 仍是投递)被前置 fail-fast 拒绝。
- ask/gate 回归:剥离后 runner `ask`→`check`→gate 全链可用(nudge 走 ingest),`~/.flywheel/.env` 零读取(fs 探针)。
