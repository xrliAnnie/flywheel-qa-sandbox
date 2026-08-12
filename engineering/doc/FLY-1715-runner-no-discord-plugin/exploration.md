# FLY-1715 Runner 不应加载 Discord plugin — 探索

Issue: FLY-1715 (https://linear.app/geoforge3d/issue/FLY-1715/runner-进程不应加载-discord-plugin-server-个例-roguefly-1704-runner-名下-bun)
日期: 2026-08-12
基于: 无

## 1. 问题是什么

FLY-1704 的 runner(d71d5740)名下发现一个 `bun …/discord/0.0.4/server.ts` 进程(Discord plugin 的 MCP server,下称 **adapter**),持 bot token、与 Discord gateway 保持 2 条 ESTABLISHED 连接——runner 以 Lead bot 的身份挂在 Discord 上。杀掉后 ~15 分钟被父进程(runner 的 claude 进程)复活,whack-a-mole 无效。

后续两轮取证把病面扩大、病灶层修正:

1. **增殖普查(8-11 22:2x PT)**:病面不止 runner——QA 体、auto-QA 体、甚至 headless `claude -p` 交叉评审进程,**每个新 spawn 的 claude 进程都长 adapter**。结论:修复必须覆盖**所有 claude 调用的 spawn 配置层**,而非仅 runner 路径。
2. **Cass 三连纠错(8-12,定谳)**:嵌合(身份拼错)的载体不是 adapter、不是某个会话,是**整台 tmux server(pid 88723,`recovery-anchor` 启动)**。该 server 自身 env 带 `FLYWHEEL_LEAD_ID=LEAD_ID=DISCORD_STATE_DIR=eng-lead` + 明文 `TEAMLEAD_API_TOKEN`;在这台 server 上出生的任何 `team ≠ eng-lead` 的 runner **出生即嵌合**(实测 9/9 结构性:product-lead 3/3 嵌合、eng-lead 6/6 一致)。杀 adapter 无效,因为 adapter 身份从 runner 继承,runner 身份从 tmux server 继承。

**两个病要分开叫**(Cass 审计方法论,本单沿用):

- **增殖(proliferation)**:不该有 adapter 的进程长了 adapter——本单主治。
- **嵌合(chimerism)**:某个进程的身份字段互相打架(`FLYWHEEL_LEAD_ID` × `LEAD_ID` × `DISCORD_STATE_DIR` 不同源)——本单治 spawn 层的显式化(Cass 处置建议③「spawn 时显式覆盖,不依赖继承」);身份单一权威源的地基归 FLY-1726。

## 2. 病灶链:三个共同必要条件

审计(见 research.md 的逐条代码事实)确认 rogue adapter 的出现需要三个条件**同时成立**,当前生产三条全部成立:

```
条件 A:user 级 ~/.claude/settings.json enabledPlugins."discord@flywheel-plugins" = true
        → 机器上每一个 claude 进程(runner / QA / headless -p / ad-hoc)启动即加载 plugin,
          spawn 一个 adapter(bun server.ts)。
        → runner-mcp-profile(FLY-751/812)默认只禁 serena:FLY-812 founder 裁定把
          discord 从默认禁用列表移除(「runners sometimes need discord during testing」)。

条件 B:adapter 启动即自动连 gateway,无任何「我是谁/我该不该连」判断
        → server.ts 读 DISCORD_STATE_DIR(env 继承,缺省 ~/.claude/channels/discord)
          → load ${STATE_DIR}/.env 进 process.env → 取 DISCORD_BOT_TOKEN → connect。
        → 默认 state dir 的 .env 真实存在(含某个 bot token)——即使 env 干净的
          claude 进程,adapter 也会拿默认 token 连上 gateway。

条件 C:tmux server env 继承
        → tmux 窗口/pane 由 server 进程 fork,继承 server 的 env。
        → TmuxAdapter spawn 时显式注入 FLYWHEEL_* 若干变量,但从不清除/覆盖
          LEAD_ID / DISCORD_STATE_DIR / DISCORD_BOT_TOKEN / TEAMLEAD_API_TOKEN / BRIDGE_URL
          —— 这五件套全靠「出生在哪台 server」决定。
```

### 活体证据:本设计会话自己就是标本

本 design runner(exec c12a06d4,eng-lead 名下,出生于共享 tmux server)自检:

```
DISCORD_BOT_TOKEN=<present>          ← Lead 的 bot token,ambient 继承
TEAMLEAD_API_TOKEN=<present>         ← Lead-only 特权 API token,ambient 继承
LEAD_ID=flywheel-eng-lead            ← ambient 继承
DISCORD_STATE_DIR=~/.claude/channels/discord-flywheel-eng-lead   ← ambient 继承
FLYWHEEL_LEAD_ID=flywheel-eng-lead   ← TmuxAdapter 显式注入(ctx.leadId)
BRIDGE_URL=http://localhost:9876     ← ambient 继承
```

且本会话的 claude 进程加载了 discord plugin(session 内可见 `mcp__plugin_discord_discord__*` 工具)。「一致」只是因为我恰好是 eng-lead 的 runner 生在 eng-lead 味的 server 上——身份正确纯属巧合,这正是结构病。

## 3. 方案空间与取舍

### 3.1 条件 A 层:plugin 加载在哪关?

| 选项 | 覆盖面 | 取舍 |
|------|--------|------|
| **A1. 极性翻转(推荐)**:机器级 `~/.claude/settings.json` 置 `discord@flywheel-plugins: false`,Lead 启动器 per-launch 正向启用 | **所有** claude 调用(runner / QA 体 / headless `-p` / ad-hoc)默认无 plugin;只有显式 opt-in 的 Lead 有 | 精确复刻 FLY-1185 playwright 已验证模式(per-launch `--settings` 是最高非 managed 优先级,机器级 default-off + 单点正向 enable)。默认 deny,不用逐个拦 spawn 点。代价:Annie 终端会话的 Discord channel 一并关闭(默认 state dir 已 3 个月无写入,5-10 后无痕迹,判定影响≈0,显式向 founder 报备) |
| A2. 生产 spawn 面 per-launch 禁用(最终形态见 plan §3 Phase 1:**独立于 slim profile 的 `NON_LEAD_FORBIDDEN_PLUGINS` 安全常量** + canonical security-last merge helper,覆盖 TmuxAdapter + headless reviewer + classifier + SDK(ClaudeRunner)+ voice brains(Headless/Resident),任何 slim 逃生口不可翻) | 我们代码控制 argv 的全部非 Lead 生产面 | 修不到 ad-hoc 裸 `claude`(那由 A1 兜)。**单独不够**,作为 A1 的冗余安全合同(防 settings.json 手工漂移)。注:初稿曾想放进 runner slim 禁用列表——Codex R1 指出该机制有 kill-switch/override 逃生口,安全合同不能寄生在可逃逸机制里,故独立成常量 |
| A3. managed settings 机器级强制 | 全机 | 会连 Lead 一起杀死(managed 优先级最高,per-launch 无法翻回),不可行 |

**A1 的一个待真机验证点**:Lead 今天靠 `--dangerously-load-development-channels "plugin:discord@flywheel-plugins"` 加载 channel(claude-lead.sh:2068)。机器级 default-off 后该 flag 是否仍足以加载 plugin 未知——spike 两分支:足够则 Lead 侧零改动;不够则 claude-lead.sh 补 per-launch `--settings` 正向启用(FLY-1185 已证可行)。

### 3.2 条件 C 层:spawn 身份/凭据显式化(scope B,治嵌合的 spawn 形态)

**C1(推荐)**:TmuxAdapter 窗口启动命令在 exec 前显式剥离 ambient 身份/凭据 deny-list(六名:`LEAD_ID`、`DISCORD_STATE_DIR`、`DISCORD_BOT_TOKEN`、`TEAMLEAD_API_TOKEN`、`BRIDGE_URL`、`PROJECT_NAME`——后者无条件剥、有 ctx 时显式重设),身份只从 ctx(registry 派生)显式注入(`FLYWHEEL_LEAD_ID` 已是)。效果:**已知事故凭据集**不再随「runner 出生在哪台 tmux server」走——88723 这类污染 server 对这组凭据从「必须根除的病灶」降级为「普通运维卫生」。诚实边界:deny-list 是闭集,未列名的 ambient 变量仍会继承(开集安全=整 env 重建,归 FLY-1726);且 `TEAMLEAD_API_TOKEN` 的裸剥会被 flywheel-comm nudge 的磁盘回读旁路(401/403 时读 `~/.flywheel/.env` 重取 master)——必须连同 nudge 收编一起做,见 plan §3 Phase 3.5。

- 覆盖所有 TmuxAdapter 子类(claude / agy / kimi);Codex daemon 已被 FLY-1643 结构性治过(env 从 host base 重建、继承的 FLYWHEEL_* 全丢),是本方案的同族先例。
- 替代 C2(整体 `env -i` 重建,claude-lead.sh 的 Lead 侧做法):对 runner 爆炸半径太大(PATH/HOME/登录态/各 vendor CLI 依赖),v1 不取;精确 deny-list + 显式注入已达成「不靠继承」的合同。

**C1 的连带炸点(本探索最重要的发现)**:runner 的 `flywheel-comm publish-report`(design 节点交付 founder HTML 的必经命令)对 Bridge `/api/reports/*` 的鉴权**完全依赖 ambient 继承来的 TEAMLEAD_API_TOKEN**(Bridge 侧无 token 直接 503,CLI 侧只认这一个 env)。也就是说:

- 今天 runner 能交付 DESIGN-HTML,**靠的正是本单要堵的凭据泄漏**;
- 若只做「换干净 server」(处置③)或只剥 token 而不配套,**全舰 design 节点交付静默断裂**;
- 而 `founder-ux.ts` 的注释白纸黑字写着设计意图:「Runner 的 ingest token 必须不能做特权写」——即 runner 本就不该持有 TEAMLEAD_API_TOKEN,现状违反了该威胁模型。

**配套(C1b)**:Bridge reports 面在 mount 层做分路由鉴权——`/publish` 接受 runner 侧 `FLYWHEEL_INGEST_TOKEN`(注意:fleet-shared 进程级凭据,非 per-runner),**`/deliver`(出 Discord 消息)仍 master-only**,并以「ingest≠master」启动不变量保证该边界真实存在(r2 修正:无独立 screenshot 端点,截图在 CLI 本地采集后随 `/deliver` 传入;详见 research §5 / plan §3 Phase 3)。这同时对齐三条既有合同:runner 只 publish-only、founder 物料由 Lead 投递(记忆条目)、Runner 不直接碰 Discord(本单)。

### 3.3 条件 B 层:plugin 侧 default-deny?

改我们自己的 fork(flywheel-plugins)让 server.ts 要求显式 `DISCORD_ADAPTER_ALLOWED=1` 或见 `FLYWHEEL_EXEC_ID` 即拒连。**v1 不做,记 follow-up**:

- Fix A1 落地后,非 Lead 进程根本不加载 plugin,B 层门是第三重皮带;
- 该门单独不自立(Lead 的 Bash 子进程会继承 allow env);
- fork 改动要走 flywheel-plugins repo + FLY-1676 sync 通道,跨 repo 成本;
- 简单性纪律(修结构别加报警器):三重结构已经够,先落前两重。

同理 rejected:per-state-dir flock singleton(每个 bot 身份全机一条 gateway 连接)——结构更强,但与 Lead 重启时序、FLY-183 孤儿 reaper 的交互复杂,v1 不取。

## 4. 与在飞单的边界

| 单 | 关系 |
|----|------|
| FLY-1710(已 Canceled 并入 1726) | 其「chat-receipt 按在场频道铸」前提被 Annie 驳回;错账元凶=嵌合体 pid 59595(已击杀)。本单不做回执/归属逻辑 |
| FLY-1726(统一 Identity,同批 E1.75) | 身份**单一权威源**(候选=registry 行)+ 全派生+启动断言是 1726 的地基工程。本单 C1 的「身份只从 ctx 显式注入」是该合同在 spawn 链的落地切片,接口对齐:ctx.leadId 即 registry 派生值;1726 未来若换权威源,C1 的注入点不变 |
| 88723 退役 + TEAMLEAD_API_TOKEN 轮换 | 运维处置,team-lead 已排(task:等 product-lead 三 runner 收工后端掉)。本单 plan 只列验收判据与顺序约束,不执行 |
| FLY-1719(publish-report --channel 语义) | 相邻但不同层:1719 治「不带 --channel 默认投 core」;本单 C1b 治鉴权。互不阻塞 |

## 5. 结论(带入 research/plan)

推荐组合:**A1(极性翻转)+ A2(独立 forbidden 安全常量,覆盖全部非 Lead 生产 spawn 面)+ C1(spawn 显式化,六名剥离)+ C1b(reports+nudge 鉴权配套)**,B 层与 fork 改动 defer。

三重结构性效果(边界按 plan 定稿口径):
1. 非 Lead claude 进程不再加载 plugin(增殖断根:A1 兜 ad-hoc,A2 覆盖全部我们控制 argv 的生产面);
2. 即使有人手工把 settings 翻回来,A2 的 forbidden 合同(不可被 slim 逃生口翻转)仍兜住全部生产 spawn 面;
3. 已知事故凭据集(六件套)不再随 tmux server 继承——嵌合的 spawn 形态断根;误加载 plugin 的默认 token 回退由部署前置(默认 `.env` 吊销,plan Phase 0.5)排除。**不声称**「plugin 误加载也安全」与开集 env 安全(见 plan 非目标)。
