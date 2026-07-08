# FLY-1005 多机部署 (multi-machine) — 调研

Issue: FLY-1005 (https://linear.app/geoforge3d/issue/FLY-1005/多机部署-multi-machine-runner-分散到多台机器跑-research-prd)
日期: 2026-07-08
基于: exploration.md (同文件夹)

> 方法:先摸 codebase 的机器本地耦合点(§1,file:line 为证),再诚实诊断瓶颈(§2),再列方案空间(§3),拆 homerail 对照(§4),回答沙箱/session-log/树三个关系问题(§5-6),标 UNKNOWN(§7),给结论(§8)。

---

## 1. 现状架构:哪些东西钉死在「本地这一台」

### 1.1 一张图看清

```mermaid
graph TB
    subgraph MAC["主开发机 (唯一一台, 16GB)"]
        DC["Discord 插件<br/>(只出站连 Discord)"]
        BR["Bridge / TeamLead HTTP<br/>127.0.0.1:9876 (硬绑 loopback)"]
        SS[("StateStore<br/>~/.flywheel/teamlead.db<br/>单进程 better-sqlite3 + WAL")]
        CD[("CommDB / 各 audit db<br/>~/.flywheel/comm/*.db")]
        subgraph TMUX["本地 tmux server + cmux GUI"]
            L1["Lead pane (Claude CLI)"]
            R1["Runner pane (Claude CLI)<br/>+ git worktree(本地盘)"]
        end
        MB[("mailbox 文件<br/>~/.claude/teams/&lt;lead&gt;/inboxes/*.json")]
    end
    DC -->|出站| DISCORD[("Discord (控制面)")]
    L1 -->|本地 tmux send-keys / 文件 mailbox| R1
    R1 -->|HTTP: stage/complete/heartbeat/events<br/>FLYWHEEL_BRIDGE_URL| BR
    R1 -.->|ask/gate: 本地 CommDB(非 HTTP)| CD
    BR --> SS
    BR --> CD
    L1 -.->|写| MB
    MB -.->|runner 轮询本地文件| R1
```

### 1.2 三个硬单机锚点(要跨机必须先破)

**锚点 A — Bridge 硬绑 loopback。**
`packages/teamlead/src/config.ts:9,25-28`:
```
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const host = process.env.TEAMLEAD_HOST ?? "127.0.0.1";
if (!ALLOWED_HOSTS.has(host)) throw new Error("TEAMLEAD_HOST must be loopback…");
```
默认端口 9876。**而且不止一处**:`Blueprint.ts:476-499` 的 `resolveBridgeUrl()` 在 host 非 loopback 且没显式 `TEAMLEAD_URL` 时,**拒绝**从 host 推导 Bridge URL(runner 拿不到 bridgeUrl)。→ 另一台机的 runner/lead **现在根本连不到** Bridge。破锚点 A 不是「改 TEAMLEAD_HOST」一步,而是三步:(i) 让 Bridge 绑/暴露到内网、(ii) 在 **spawn 侧(Bridge/Blueprint/runner-agent)** 设 `TEAMLEAD_URL`(或直接传 `bridgeUrl`)——`TEAMLEAD_URL` 由 Blueprint.resolveBridgeUrl 消费算出 `ctx.bridgeUrl`,再由 TmuxAdapter 注入成 runner 的 `FLYWHEEL_BRIDGE_URL=<hub tailnet>`(不是 runner runtime 直接读 `TEAMLEAD_URL`)、(iii) 保留本地默认的安全兜底。这是刻意的安全设计(Bridge 有强能力的 `/api/actions/*` + 无鉴权的 `/actions` dashboard 别名,见 §3.3-安全),不是疏漏。

**锚点 B — StateStore 是单进程本地 SQLite。**
`packages/teamlead/src/StateStore.ts:620,679-690` + `config.ts:103-105`:DB 文件默认 `~/.flywheel/teamlead.db`,`new BetterSqlite3(dbPath)`,WAL 模式。FLY-663 刚把它从 sql.js WASM 换成 better-sqlite3(治 2GB WASM 堆损坏)。better-sqlite3 技术上可多连接,但架构上**这个 Bridge-本地文件就是 fleet 的唯一权威状态**,没有网络/跨机访问路径。这是 **fleet 的唯一权威状态**(sessions / stages / runs / gates)。CommDB(`~/.flywheel/comm/*.db`)、cipher.db、claims.db、token-usage.db 同理——全是 `~/.flywheel/*` 本地文件,Bridge + CLI 靠**同一台的本地文件系统**共享。→ 跨机要么共享/联网这个 DB(重),要么所有状态操作都走那一个 Bridge 的 HTTP。

**锚点 C — runner 是本地 tmux 进程 + 本地盘 + 本地文件唤醒。**
- spawn:`packages/claude-runner/src/TmuxAdapter.ts:1165,1179` shell 出 `tmux new-session -d -s …`,靠本地 tmux server;cmux GUI 镜像也在本机。
- 工作区:runner 在本地盘的 `worktrees/<slug>` git worktree 干活,repo checkout 本地。
- 唤醒:`packages/flywheel-comm/src/wake.ts:57-116` 的 `wakeRunnerMailbox` **从本地 CommDB 取 session 身份**(`deriveRunnerMailboxIdentity`)后经 `AgentTeamTransportFactory` 写 `~/.claude/teams/<lead>/inboxes/<agent>.json`,runner(Claude CLI)轮询**本地**这个文件。→ 在另一台机起 runner = 需要远程执行(ssh)或**每台一个 runner-agent 常驻**;唤醒要么走 HTTP 到那台由 agent 写本地 inbox,要么换成联网 transport。注意:身份来自本地 CommDB,卫星机默认没有这份 CommDB(见 §1.3 的 HTTP 澄清)。

### 1.3 已经跨机友好的(好消息:控制面基本就绪)

- **runner→Bridge 控制链是「半 HTTP」(重要澄清,不要过度声称)。** `TmuxAdapter.ts:385-411` 把 `FLYWHEEL_BRIDGE_URL` + `FLYWHEEL_INGEST_TOKEN` 注入 runner env。**已经走 HTTP 的**:`stage`(`commands/stage.ts:171-240`)、`complete`(`complete.ts:147-224`)、heartbeat、以及 `gate` 的辅助 best-effort 事件(`gate.ts:276-369`)—— 这些 POST 到 Bridge 的 `/events`,鉴权用 **`FLYWHEEL_INGEST_TOKEN`(不是 `TEAMLEAD_API_TOKEN`)**。**仍是本地的**:`ask` 直接写本地 CommDB(`ask.ts:22-28`)、`gate` 的核心问答流是**轮询本地 CommDB**(`gate.ts:97-119,174-193`)、mailbox wake 的身份也来自本地 CommDB。→ **所以「改个 URL 就能跨机」是错的**:卫星 runner 的 ask/gate 问答态 + wake 目前依赖本地 CommDB,阶段1 必须**把这部分路由到 hub 或替换**(列为阶段1 一等公民工作项,见 plan §4.2)。
  - **token 是两侧、名字不同(别配错):** hub/Bridge 端从 **`TEAMLEAD_INGEST_TOKEN`** 读 `config.ingestToken`,`/events` 用它做 `tokenAuthMiddleware`(`config.ts:106`、`plugin.ts:1023-1026`);spawned runner 拿到的**同一个密钥**注入成 **`FLYWHEEL_INGEST_TOKEN`**(`Blueprint.ts:1706-1707` → `TmuxAdapter.ts:406-411`)。**若 hub 只配了 `FLYWHEEL_INGEST_TOKEN`,`/events` 仍无鉴权**。另外 `/api/*`(含 `/api/actions`)用 **`TEAMLEAD_API_TOKEN`**,且 `tokenAuthMiddleware` 在未配置 token 时 **no-op 放行**(`plugin.ts:609-618`)。
- **Discord 已解耦。** Bridge 只**出站**连 Discord,不需要公网入站端口;每台机器可各自独立连 Discord。Annie「Discord = 集中控制 UI」的前提已经成立。
- **Tailscale 已有先例。** `packages/edge-worker/src/SlackInteractionServer.ts:17-42` 绑 `0.0.0.0` 且注释「needs external access via Tailscale Funnel」;FLY-348(XHS)也调研过 tailscale 组内网。→ 内网 mesh 的手段项目里已经在用(但这只证明「可以刻意暴露某个端口」,不等于「可以整个 Bridge 暴露」)。
- **transport 有抽象、但措辞要准。** wake 走 `AgentTeamTransportFactory.forBackend(...)`,该 factory **目前只支持 `claude-code` 和 `codex` 两种**(`packages/agent-team-transport/src/AgentTeamTransportFactory.ts:23,81-96`);「no-transport」(antigravity/kimi)不是 factory backend,而是在 `role-adapter-resolver.ts:27-54` / `run-dispatcher.ts:219-235` 里解析的执行模式。→ 阶段1 加远程 runner 时要**明确决定**:是新增一个 transport backend、一个 runner-agent adapter、还是一层 admission/spawn?(是真扩展点,但不是「改一行」。)
- **heartbeat 已有。** FLY-172 runner heartbeat + orphan reconcile(`TmuxAdapter.ts:57,592-593` 客户端;`StateStore.ts:3076-3088`、`HeartbeatService.ts`、`event-route.ts:424-437` 服务端),是 failover 的基础件。

**一句话:出站控制面(stage/complete/heartbeat/events 走 HTTP + Discord 出站 + transport 抽象 + heartbeat)大体就绪;但 ask/gate 问答态 + wake 仍是本地 CommDB,必须补一层路由到 hub。真正要破的锚点 A(Bridge 暴露,3 步)、锚点 C(卫星 spawn + wake + 本地 CommDB 依赖);锚点 B 靠『state 只留主机』刻意绕过。**

---

## 2. 单机瓶颈的诚实诊断(回答问题①)

| 瓶颈类型 | 是不是真瓶颈 | 多机能治吗 | 更便宜的解 |
|---|---|---|---|
| **内存** | ✅ 是(结构性容量约束,非泄漏) | ✅ 能(把 runner 摊到多台) | **先榨干单机:换大机 AND/OR 减 footprint**(阶段0) |
| **Claude 额度** | ⚠️ 是个真约束,但 **per-账号不 per-机器** | ❌ **不能**(加机器不加额度;同账号无论几台机都是同一 5h/7d 滚动上限) | 加账号 / codex multi-account fallback(已有) |
| **CPU** | 🟡 次要(N 个 Claude+Chrome 抢核,但主要压力是 RAM/swap) | ✅ 能 | 换大机也能 |
| **稳定性 / 爆炸半径** | ✅ 是(nightly「crash」= load 飙高 + WindowServer panic;一台崩 = 整个 fleet 同时崩) | ✅ **只有多机能治** | 无(单机再大也是单点) |
| **安全 / 隔离** | ✅ Annie 说的主因(对外/不可信 agent 与主机同盘) | ✅ 多机 or 沙箱 | 沙箱(FLY-346)是另一条 |

> **容量证据(2026-07 现状,已核):** driver 是 FLY-517(当时 16GB 机装不下 fleet)。但更近的实测在 `engineering/doc/FLY-753-memory-capacity/research.md` 与 `FLY-751-runner-memory-footprint/research.md`:每 session 约 **1.3-1.4GB**,一台 **48GB** host 在**优化前约 15-22 session 饱和**;而 **runner footprint 优化(FLY-751 slim MCP,默认给非-QA runner 拿掉 Chrome,已部分落地)可显著抬高单机容量**。→ 结论:**「16GB 需 25GB」是 FLY-517 旧测量,现状已在 48GB + footprint 优化的轨道上**;research 用当前证据,别引旧数字当唯一依据。

**诚实结论(问题①):**
1. **当下最痛的瓶颈是内存,而治内存最便宜的不是多机、是先榨干单机容量**——即 **runner footprint 减负(FLY-751,已部分做)+ 换/用更大 host(48GB→更大)**。只为治内存上多机 = 用分布式系统的复杂度换本可靠单机优化解决的问题,不划算。→ **阶段0 应该先榨干单机(footprint + 大机),对齐 FLY-517 ①/② + FLY-751/753。**
2. **额度这条要澄清:多机不解决额度。** 若哪天真瓶颈变成额度,方向是加账号,不是加机器。别让「多机」背这个锅。
3. **多机真正不可替代的价值 = 爆炸半径隔离 + 无上限横向 scale + 异构放置(老公 Windows / 对外 agent 单独一台)。** 这些**不是现在最痛、但随 fleet 变大和对外 agent(Anna 访谈 bot)到来会变成硬需求**。→ 所以多机**值得做**,但要**为对的理由做、分阶段做**。

---

## 3. 方案空间(回答问题②:怎么做)

### 3.1 纵向(阶段0):先榨干单机 —— footprint 减负 + 大机

- 做法两条并行:(a) **runner footprint 减负**(FLY-751 slim MCP 已部分落地;继续减非必要进程 = 同机塞更多 session,零硬件成本);(b) **换/用更大 host**(48GB→更大 Mac Studio,Apple Migration Assistant 全套搂过去 = FLY-558「搬大机」+ FLY-519 补 fleet 启动)。
- 优点:(a) 零成本;(b) 零代码、立即治内存、当天见效。
- 缺点:有上限(footprint 减到头 + 买不到无限大的机)、单点(还是一台崩全崩)、无隔离。
- 定位:**先做这个救急 + 给多机争取时间**,不是终点。

### 3.2 横向物理多机 —— 三个架构选项

```mermaid
graph LR
    subgraph OptA["Option A ✅ 推荐: 单 hub brain + 无状态卫星"]
        A_BR["主机 Bridge (唯一 brain)<br/>StateStore 留主机"]
        A_N1["卫星机 1: runner-agent<br/>只跑无状态 runner"]
        A_N2["卫星机 2: runner-agent"]
        A_BR -->|HTTP dispatch (Tailscale)| A_N1
        A_BR -->|HTTP dispatch| A_N2
        A_N1 -->|HTTP 回报 + heartbeat| A_BR
    end
```

**Option A(推荐)— 单 Bridge hub + 无状态卫星 runner。**
- 主机 = 唯一 brain:Bridge + StateStore + 所有 Lead 都留主机(或若干「Lead 机」,但 state 单一权威)。**刻意不做跨机 StateStore 一致性。**
- 卫星机 = 只跑一个轻量 **runner-agent 常驻进程**,接收主机的 dispatch → 本地 `tmux new-session` 起 runner → runner 用注入的 `FLYWHEEL_BRIDGE_URL`(指向主机 Tailscale 地址)走 HTTP 回报。
- 破锚点:A(Bridge 经 Tailscale 暴露给内网 + 认证)、C(卫星的 runner-agent 负责本地 spawn + 把 wake 路由到本地);B **不用破**(state 只留主机)。
- 代价:中等。新增 runner-agent daemon + Bridge 内网暴露 + dispatch 选机 + wake 跨机路由。**不碰分布式一致性。**
- **这就是 homerail 的 Manager/Node/Worker 模型(§4),被现成产品验证过。**

**Option B — 每机独立完整 Flywheel(联邦 / federation)。**
- 每台机跑自己完整的一套(Bridge + Lead + runner + 自己的 StateStore),各自连同一个 Discord,按项目/部门切分(如「主机跑 flywheel,Windows 跑老公项目」)。
- 优点:最简单、天然隔离、零跨机编排(每台就是今天的单机)。契合 FLY-648「核心/项目分离」+ 异构放置。
- 缺点:不是「一个 fleet 摊开」,而是「N 个独立 fleet」;跨机协作(主机 Lead 驱动 Windows runner)做不到;状态各自为政。
- 定位:**异构放置 / 对外 agent 隔离的最省力解**;不满足「一个大 fleet 弹性摊开」。

**Option C — 跨机共享 StateStore(networked DB)。**
- 把 teamlead.db 换成一个联网 DB(Postgres/Supabase),多台 Bridge 共读写。这是 FLY-556「StateStore 跨机化」的字面解。
- 优点:真正的「一个 fleet 跨机一致」。
- 缺点:**最重**。要解分布式一致性、锁、崩溃恢复(FLY-1002 防撞车已经是单机版的一角);teamlead.db 的写模式(高频、事务性)搬到网络 DB 有延迟/一致性坑。**不推荐作为起步。**
- 定位:远期(真要几十上百 Lead 跨机协同时)才考虑;先被 Option A 的「单 brain」绕过。

### 3.3 dispatch / admission(FLY-557)

- Option A 下,dispatch 要多一步「选哪台机」:主机 Bridge 按各卫星上报的 load/free-RAM 选一台起 runner(per-machine admission)。
- 现有 `RunnerAdmissionController`(`packages/teamlead/src/bridge/runner-admission.ts`;现有 load + 可选 memory-pressure 闸门)是单机 admission,可扩成 per-node。
- 策略起步可以很土:每台报 free-RAM + 当前 runner 数,Bridge 选最空的;撑不下就排队(今天单机 swap thrash 就是缺这层)。

### 3.4 failover

- 卫星机死 = 它上面的在飞 runner 丢。主机靠 heartbeat(FLY-172)察觉 → 把那些 issue 重新 dispatch 到别的卫星。
- **但「重派」会不会丢 WIP?** 这里接上 FLY-353(§6):有 session-log 才能「从日志重建」而非从零重跑。没有 session-log 时,failover = 重跑该 phase(可接受但浪费)。

### 3.5 provision / setup(FLY-558 / FLY-519)

- 两条路别混:**搬大机** = Migration Assistant 全克隆(阶段0);**拆多机** = 每台 provision 一个子集(FLY-519 脚本,已 done)。
- 卫星机的 provision 比主机轻:只要 node/pnpm/tmux/claude CLI + runner-agent + Tailscale 入网,**不需要** Discord bot / Lead / 全套 launchd。

---

## 4. homerail 拆解(回答问题⑤)

homerail(GitHub xiaotianfotos/homerail)= 一个 TypeScript 编排 runtime,形态和 Flywheel 惊人相似,但**已经是多机 + 容器原生**。五个包:

| homerail 包 | 职责 | 对照 Flywheel |
|---|---|---|
| `homerail_manager` | 协调 DAG 执行、owns 权威状态 + voice/UI 契约。**Manager 是本地服务、不进 Worker 镜像。** 默认绑 `127.0.0.1:19191` | ≈ Bridge/TeamLead(也默认 loopback!同一个安全直觉) |
| `homerail_node` | 在一台机上 **provision Docker Worker 容器** | ≈ 我推荐的 **runner-agent daemon**(每台一个) |
| `homerail_worker` | 运行时 harness(适配 Claude Agent SDK),**每个 DAG 节点一个独立容器 + 独立 context** | ≈ runner(但容器化 + 无状态) |
| `homerail_protocol` | 共享消息契约 | ≈ flywheel-comm 契约 |
| `homerail_cli` (`hr`) | 配置/执行/查看 | ≈ flywheel-comm CLI |

**多机怎么做的:** Manager 绑一个可配地址;Node 起的 Worker 容器通过**可配的 callback URL** 回连 Manager(Docker Desktop 用 `host.docker.internal`;Linux 用 `host-gateway` 或显式 `HOMERAIL_MANAGER_WORKER_WS_BASE_URL`)。→ **和 Flywheel 的 `FLYWHEEL_BRIDGE_URL` callback 完全一个套路。**

**状态怎么处理:** 权威状态在 Manager;每个 run 的产物集中在 `${HOMERAIL_HOME}/workspace/<run_id>/`(HOMERAIL_HOME 建议指 NAS 挂载)。**Worker 无状态、每节点独立容器、context 不 balloon。** → **验证了 Option A「单 brain + 无状态 worker」是对的方向。**

**隔离怎么做:** 靠容器 —— 每个 DAG 节点跑在自己的 Docker 容器里,独立 context window,workspace per-run 隔离。→ 这是「沙箱 per runner」,正是 FLY-346 的思路。

**与 Flywheel 的关键差异:**
1. **homerail 是 Docker/Linux 原生;Flywheel 是 macOS + tmux + cmux GUI 原生。** homerail 的 Worker-in-Docker 直接映射到 Flywheel 的**云/Linux 阶段**;Annie 的物理 Mac fleet 阶段更像「Node 起本地 tmux runner」而非「Node 起 Docker 容器」。
2. homerail 是 DAG 编排(节点间显式 handoff);Flywheel 是 issue→runner→PR 的 pipeline + Lead 对话。形态不同,但**「有状态 Manager hub + 无状态 Worker + callback URL」这层完全可借鉴**。

**takeaway:** homerail 就是「Flywheel 如果一开始就为多机 + 容器设计会长成的样子」。它给了 Option A 一个**产品级的存在性证明**,并指明容器化(FLY-346)是**云阶段**的自然形态。

---

## 5. 与沙箱化 FLY-346 的关系(回答问题③,不预设)

**结论:正交但可组合。Annie 说的对——多机 technically 不一定用 346 的沙箱。**

- **正交:** 多机 = runner 跑在**哪台物理机**(placement);沙箱 = runner 在一台机上被**隔离多强**(Docker)。
  - 多机**无沙箱**:一台卫星 Mac 跑裸 tmux runner —— 它和主机已经靠「是两台物理机」天然隔离了。✅ 可行,near-term 推荐。
  - 沙箱**无多机**:一台机上跑 Docker runner —— 隔离但没突破单机内存。
- **可组合、且沙箱让多机更好运维:** 容器化 runner 可移植、可复现、不用每台机 provision 全套工具链 → **沙箱把多机的 placement 成本降下来**,并且是**云阶段(FLY-559/648 per-project container)的前提**。
- **macOS 现实(重要 nuance):** Docker 在 macOS 上跑在一个 Linux VM 里(重、慢、和原生 Claude CLI + cmux GUI 不契合)。所以 **FLY-346 的 AIO Sandbox(Linux Docker)更贴云/Linux 节点,不太贴 Annie 的物理 Mac fleet。** 在 Mac 卫星上强上 Docker 反而增负担。
- **建议:** near-term 物理多机(阶段1)**不强制上 346 沙箱**(物理机即隔离);沙箱留给**阶段2 云/Linux 节点**,那时它从「可选」变「必需」。

---

## 6. 与 FLY-353 / FLY-916 的关系(回答问题④)

### 6.1 FLY-353 session-log 解耦 = failover 的 enabler,不是阶段1 硬前提

- FLY-353 的核心:把 runner 的记忆/事件从 context 里拆出来做成 **context 外 append-only 事件日志** → 无状态 runner 可安全 respawn + 从日志重建。
- **对多机的意义:**
  - 阶段1 最小 remote-runner(hub 留全部 state、node 只跑进程)**不需要** session-log 就能跑 —— 状态本就在 hub。
  - 但**稳健的 failover**(卫星死 → 在别处「续」而非「从零重跑」)**需要** session-log 才能无损重建。→ session-log 是 **failover 保证**的前提,不是**基本分布**的前提。
- **协调、别重复:** FLY-353 整体杠杆更高(一箭治 context 饱和 FLY-916 + respawn 丢状态 FLY-939 + 重启丢 WIP),而且**正好去掉多机 failover 最难的一块**。→ 建议 **FLY-353 session-log 先落或与多机并行**;多机阶段1 可先在现架构上 ship(node 死则该 run 重跑),session-log 到位后升级成「node 死则续」。两条 research(FLY-353 / 1005)要互引、不重写 session-log 设计。

### 6.2 FLY-916 树 = 纵轴;多机 = 横轴。正交,别混。

- FLY-916 自己就说:**多机 = fleet scale 的横向轴,树 = 纵向轴。**
- 树解决的是「**一个 Lead 的注意力**只能带 5-6 session」(压缩/facade 层),和 RAM/物理机无关 —— 一棵 Lead 树可以整个跑在一台大机上。
- 多机解决的是「**一台机的物理容量/爆炸半径**」—— 一组扁平 Lead 可以摊在多台机上。
- **组合但互不依赖:** 大 fleet 最终要「树 × 多机」(层级 Lead + 跨机 runner),但两者各自独立成立,任一先做都有价值。**别把多机做成必须先有树,或反之。**

---

## 7. UNKNOWN / 需 spike 验证

- **[UNKNOWN] Tailscale 下 Bridge 暴露的确切认证/网络形态** —— 是去掉 loopback guard + 绑 tailnet IP + 强制配 `TEAMLEAD_INGEST_TOKEN`(/events)(+ 需要时 `TEAMLEAD_API_TOKEN`),还是保留 loopback + 前置一个 tailnet 反代?两者安全性/改动量不同,要一个真机 spike 才能定。`/api/actions/*`(强能力)+ 无鉴权 `/actions` dashboard 别名暴露到 tailnet 的风险边界也要 Codex/安全过一遍。
- **[UNKNOWN] 卫星 runner 的 mailbox 唤醒的确切落地** —— 是「wake 走 HTTP 到卫星的 runner-agent、由它写本地 inbox 文件」,还是「新增一个网络 transport 让 runner 直接联网收 wake」?transport 已抽象(§1.3)使两者都可行,但哪个更稳要看 Agent Team inbox 轮询的实现细节(未深挖到轮询频率/文件锁)。
- **[UNKNOWN] cmux GUI 的跨机可观测** —— Annie 现在靠 cmux 看所有 pane;卫星机的 tmux 不在主机 cmux 里。FLY-561(tmux attach + 标机器)是方向,但「手机/主机怎么统一看多台的 runner」需要单独设计。tmux 支持远程 attach(ssh),cmux 不行(桌面 app)。
- **[已知约束,非 UNKNOWN] git/worktree 跨机** —— 卫星 runner 在本地 checkout 干活、push 分支、开 PR;这条本来就走 GitHub(云),跨机无碍。**已知设计约束**:worktree 是 runner 本地的,GitHub/PR 态天然共享,但「主机 Lead / Annie 想看卫星 runner 的本地 diff / handoff」要走 GitHub(不是本地文件)——这是个**产品决策点**(diff 观感/handoff UX 怎么呈现),不是技术未知。
- **[UNKNOWN] Claude CLI 登录态跨机** —— 每台卫星要各自 `claude login`(或复制 CLAUDE_CONFIG_DIR)。多机 = 多套登录态维护;和 codex multi-account 一样要 per-机管理。运维成本项,未量化。

---

## 8. 诚实结论

1. **做不做?** **做,但分阶段、为对的理由做。** 当下最痛是内存,而内存最便宜的解是**先榨干单机(阶段0):runner footprint 减负(FLY-751,已部分做)+ 换/用更大 host**——不要用多机的分布式复杂度去背内存的锅,更不要用它背「额度」的锅(多机不加额度)。多机真正的价值是**隔离/爆炸半径 + 无上限横向 scale + 异构放置**,这些随 fleet 变大 + 对外 agent 到来会变硬需求。
2. **怎么做?** **Option A:单 Bridge hub(state 留主机)+ 无状态卫星 runner-agent + 复用已有出站 HTTP + Tailscale 内网。刻意回避跨机 StateStore 一致性(Option C)。** 这被 homerail(Manager/Node/Worker + callback URL)产品级验证。**出站控制面**(stage/complete/heartbeat/events 走 HTTP、Discord 出站、transport 抽象、heartbeat)大体就绪;**但要补一层把 ask/gate 问答态 + wake(现依赖本地 CommDB)路由到 hub**。要破:锚点 A(Bridge 暴露,3 步:绑内网 + 显式 TEAMLEAD_URL + 保本地兜底)+ 锚点 C(卫星 spawn + wake + 本地 CommDB 依赖)。**安全前置**:多机模式必须 fail-start 除非配了 token;`/actions` 等宽 dashboard 路由保持 loopback-only(见 plan §4.2)。
3. **沙箱(346)?** near-term 物理多机**不强制**(物理机即隔离);沙箱留给云/Linux 节点阶段(那时必需)。macOS 上 Docker 是 Linux VM,别在 Mac 卫星硬上。
4. **session-log(353)?** 不是基本分布的前提,是**稳健 failover 的前提**;353 杠杆更高、正好去掉多机最难一块 → 先落或并行,两 research 互引。
5. **树(916)?** 正交横纵轴,别互相绑死。
6. **异构放置(老公 Windows / 对外 agent)** 若只需要「各跑各的、Discord 集中看」,**Option B(联邦)比 Option A 更省力** —— 值得在 PRD 里作为一条并行小路(不用等阶段1 的跨机编排)。

→ 具体分阶段路线 + 阶段1 给 Tadashi 的可建设计 + sub-issue 映射,见 plan.md。
