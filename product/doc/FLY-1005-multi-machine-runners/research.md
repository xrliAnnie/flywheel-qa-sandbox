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

## 2. 为什么是横向扩展 → 上云(而非纵向加内存)

**重要定位(Annie 2026-07-08 校正):** 『换大机救急』**已经单独做完、与本 issue 无关** —— 内存瓶颈已被 vertical scale(换大机)解决。**FLY-1005 不讨论『多机值不值得做 / 内存该怎么治』**,而是专攻 **multi-machine 本身:横向扩展 → 把 Provision + Deploy 搬上云 → 真正无上限的 horizontal scale。**

战略框架(Annie 原话精神):

| | 纵向 vertical(加内存/换大机) | 横向 horizontal(多机 → 云)= 本 issue |
|---|---|---|
| 手段 | 一台机器堆更大 RAM | 多台机器 + 弹性开云节点 |
| 上限 | **有天花板**(买不到无限大的机;单点) | **无上限**(按需开/关节点) |
| 状态 | ✅ 已做(separate,非 1005 命题) | ⬅ 1005 命题 |
| 爆炸半径 | 单点(再大也一台崩全崩) | 隔离(失败域拆开) |
| 弹性 | 无(固定容量) | 有(按需 scale up/down) |

→ 所以本 research 的命题不是『做不做』,而是『**怎么做好横向扩展 → 上云**』。诚实前提:横向的代价是**分布式复杂度**(跨机状态、调度、失败域),要设计好、UNKNOWN 标清(§7)。

**关于额度(顺带澄清,不是命题):** 多机不增加 Claude 额度(额度 per-账号,同账号无论几台机都是同一 5h/7d 滚动上限)。横向 scale 是加**算力/节点**,不是加额度;额度到顶是加账号 / codex multi-account fallback(已有)。别让『多机』背额度的锅。

**顺带保留的另两个横向价值(非命题、但真实):** 爆炸半径隔离(一台崩不再全崩)+ 异构/隔离放置(对外 agent 如 Anna 访谈 bot 单独节点)。它们是横向天然带来的红利,cloud 化后更强。

---

## 3. 方案空间(回答问题②:怎么做)

### 3.1 起点不是『换大机』,是『第一台卫星 / 云节点』

纵向(换大机)**已做且有天花板**(§2),不在本 research 的路线里。**1005 的分阶段从第一台卫星节点起**:先在一台额外机器(家里第二台 Mac,或第一个云节点)跑无状态 runner,把最小 remote-runner 架构(§3.2 Option A)在两台机上打通,再走向**弹性云 provision + deploy**(§3.6)。终点是「Discord 一处集中控制,底下按需开关云节点跑 runner」的无上限 horizontal scale。

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
- **⭐ 升级为一等选型(Annie 2026-07-08 co-eval):** Annie 说**联邦本来是她最早想的方案**。→ 联邦 vs 非联邦不是「主线 + 小路」,而是要她**明确选主线**的对照题:

  | | 非联邦(Option A,单 hub) | 联邦(Option B,各自完整) |
  |---|---|---|
  | 大脑 | 1 个中央 hub | 每节点各有 |
  | 跨机协作 | ✓ hub 调度任意节点 runner | ✗ 各跑各的 |
  | 复杂度 | 中(要破 3 锚点) | 低(每台=今天单机,复制即可) |
  | 弹性云 scale | ✓ 强(无状态节点按需开关) | 弱(每个是完整重实例) |
  | 爆炸半径 | 节点崩 hub 重派 | 天然完全隔离 |
  | 最适合 | 一个大 fleet 弹性摊开 / 无上限 scale | 隔离放置(对外 agent/独立项目)、异构 OS、快速独立扩 |

  **⭐ 推荐(诚实、分层组合,非二选一 — v4 co-eval):**
  - **一个 team 内部要 scale → 非联邦(单 hub + 无状态节点)。** 只有它给「一个 fleet 弹性、无上限」= 1005 原目标;联邦给不了(N 个独立 fleet、不能池化算力)。
  - **跨 team / 多租户 / 给别人用 → 联邦(每 team 自己一套 = §3.7c)。** 隔离最干净、契合 FLY-648;**正是 Annie 最早的直觉、且对。**
  - → **主 fleet 非联邦拿弹性;对外 agent / 独立项目 / 别人用走联邦拿隔离。** Annie 的联邦直觉没错,只是它解「隔离/多租户」不是「一个 fleet 无上限 scale」——两个都要、在不同层级。
  - **Honey Lemon(Lead)推荐:** 正交、都要 —— **先做非联邦横扩(眼前 scale),联邦 = productization 后续**(给别人用那步再上)。最终主线待 Annie 拍。

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

- 卫星/云节点的 provision 比主机轻:只要 node/pnpm/tmux/claude CLI + runner-agent + Tailscale 入网,**不需要** Discord bot / Lead / 全套 launchd。
- FLY-519 provisioning 脚本(已 done)是起点;加一个「卫星子集」模式(见 plan §4.4)。这条脚本正是**云节点镜像**的雏形(§3.6)。

### 3.6 走向云:Provision + Deploy 上云 = 无上限 horizontal scale(1005 战略核心)

家里几台物理机只是第一步(受物理机数量限制);**真正的 horizontal scale 是把 provision + deploy 搬上云 —— 按需弹性开/关云节点**。

**(a) 节点来源可选(Annie v5):云 OR 用户自己物理机(开源自管)。** 两种都接进同一个 hub 池:云节点 = 弹性、无上限(on-demand 稳、spot 便宜但会被抢);自管物理机 = **没 spot 消失问题**、代价是 uptime/维护/固定容量自担。要弹性用云,要省心/隐私用自己的机。

**(a) 云节点 = 容器镜像(阶段2,讲细,Annie co-eval 要求):**
- **「固化成容器镜像」啥意思:** 今天开一台节点要手动装 node/claude CLI/runner-agent/tailscale(FLY-519 脚本)。容器镜像 = 把这些**一次性烤进一个 Docker 镜像**;以后开节点 = 一条 `docker run <镜像>`(拉镜像 + 起 runner-agent),不用每台重装。
- **还要不要 provision?** 要,但**从「每台手动」变成「构建镜像时一次性(写进 Dockerfile)」** → build 一次、deploy 很多次;单台手动 provision 消失。
- **要不要 Docker?** 云/Linux 节点**要**(容器就是 Docker),homerail 的 Worker-in-Docker(§4)正是这个形态,**容器化(FLY-346)在这步从可选变必需**;家里 Mac 卫星(阶段0/1)可**裸跑不用 Docker**,Docker 是上云这步才必需。

**(b) 弹性 provision/deploy —— 按需自动开/关(阶段3,四步闭环,讲细):**
1. **触发:** 队列积压 / 现有节点都满过阈值 → 该扩。
2. **provision:** hub 调云 API 从镜像开一台实例(或起一个容器)。
3. **入池:** 新节点 boot → runner-agent 向 hub 注册 → hub 加进可用池、开始派活。
4. **销毁:** 节点闲置超时 → hub 把它上面的活收干净 → 关实例(省钱)。
- **实例选型 = memory-optimized 高 RAM**(fleet 是内存游戏,每 runner ~1.3-1.4GB;不是 CPU-optimized)。参照 FLY-559。

**(c) 关键澄清:不是每 issue 开一台新节点(Annie co-eval 5.1):** 那样冷启动几分钟又贵。是 hub 维护一个**温着的节点池**:issue 来先派给池里**有空位**的节点;**只有池满**才开新节点;**闲了**回收。= 每 issue 复用现有节点,池子整体弹性伸缩。

**horizontal scale 架构的硬问题(诚实):**
1. **调度/placement:** 池里怎么选节点、何时扩/缩、冷启动(开实例+拉镜像+登录态就绪,可能分钟级)怎么靠预热池摊平。[UNKNOWN,§7]
2. **跨机状态:** 沿用 Option A「单 hub brain + state 留 hub」→ 云节点无状态、可随时开关(刻意为弹性)。**这是为什么不走 Option C**:跨机共享 DB 会让「随手关一个节点」变危险。
3. **失败域:** 云节点比家里机器更会「无预警消失」(spot 回收/网络分区)。heartbeat(FLY-172)+ 从 session-log(FLY-353)重建是**弹性云的刚需**(不再是可选升级)。
4. **安全/网络 = 不是难点(Annie co-eval 5.3 降级):** 云节点入 tailnet(私有 mesh、无公网入站)接 hub;secret(登录态/token)用**成熟方案**(AWS Secrets Manager / Vault):节点 boot 时经 tailnet 拉、随实例销毁一起没。标准做法,不当难点夸大。

**(d) 成本估算(D9,粗版):** 假设每 runner ~1.3-1.4GB、一台 32GB 节点 ~15-20 runner;数字为 2026 粗估,精确需真实报价 + 实际 runner-hours [UNKNOWN-精度]。

| 方案 | 成本形态 | 粗估 | 适合 |
|---|---|---|---|
| 物理机(Mac 32-64GB) | 一次性 ~$1.3k-2.5k/台,always-on | 摊 3 年 ≈ $40-70/月/台(用不用都在) | 稳定/高负载 baseline |
| 云 on-demand(32GB 内存优化) | ~$0.2-0.4/hr | always-on ≈ $150-290/月/节点;scale-to-zero 只付活跃小时 | 突发/弹性 |
| 云 spot | ~$0.07-0.13/hr(会被回收) | 更便宜,需 session-log failover | 可容忍中断的批量 |

→ **结论:稳定 baseline 用物理机更省(amortized capex 便宜);突发峰值用云弹性(scale-to-zero)。支持「近期物理机(D2)+ 云补弹性」。**

> **定位:** 家里物理机(阶段0-1)= 打通架构 + 稳定 baseline;云 provision+deploy(阶段2-3)= 弹性 + 无上限。同一套 Option A 骨架,云只是把「卫星」换成「弹性镜像节点」。

### 3.7 Hub+DB / 多租户 / warm pool(Annie v4 co-eval 深挖)

**(a) Hub 在不在容器 + 通信:** 在不在容器 = 部署选择(云上放容器最自然、家里可裸进程);关键是 hub 唯一。通信 = 节点→hub 走 HTTP(现成 `/events`),唤醒可选加 WebSocket 做 push(homerail 用 WS)。

**(b) ⭐ Hub+DB 一体 vs 分离 —— 澄清「不共享 DB」的真正含义(Annie 直觉正确):**
- 之前 §2.2 说的「不跨机共享 DB」**只指「不做多个 hub 同时写一个 DB」**(= Option C 的分布式一致性大坑:选主/锁/防撞)。
- **一个 hub + 一个独立/云 DB 是完全不同的事:仍是单写者(那唯一的 hub),没有共识问题。** 「不共享」≠「不能有一个中心云 DB」。**Annie 的「DB 分离」直觉对。**

  | | 一体(hub 进程内 SQLite,今天) | 分离(hub + 独立/云 DB,单写者不变) |
  |---|---|---|
  | 优 | 简单、快、无网络往返 | DB 独立存活(hub 崩状态还在)、托管备份、可做 hub 接管(HA)、状态不绑机 |
  | 劣 | DB 跟 hub 同生共死、绑那台机、不好备份/接管 | 多一跳网络延迟、要 SQLite→Postgres 迁移、多一个服务/成本 |
- **建议:家里阶段0-1 用一体 SQLite(简单够用);上云阶段换分离云 DB**(独立存活 + 备份 + hub 可接管,也让 hub 更接近无状态)。单写者不变 → 不碰一致性坑。

**(c) ⭐ 多租户 3 模型(「team」= 租户,真实例:Flywheel / GeoForge3D / Tidal echo):**
- **(a-单租户)** 一个 team 一套 = 今天(已有多 team 概念、但全在一套 hub 上);最简单。
- **(b-共享 hub 多租户)** 各 team 的 Lead+Bridge 跑在**同一容器/机器**,所有 Runner 共用这个 hub、经它通信(**仍一个 Bridge 连所有 Runner**,Annie 理解正确);省资源但 hub 要做多租户鉴权/隔离、一崩全崩、安全最难。
- **(c-每 team 自己一套)** 每 team 独立 Bridge+DB+专属 Runner 容器 = **team 级联邦**;隔离最干净、契合 FLY-648「给别人用」。
- **⭐ C 下跨 team Lead 怎么通信(Annie 尖问):所有方案 UI 都落 Discord → Discord 就是跨栈互联层**;C 里各 team 互不直连,跨 team Lead 通信走 **Discord 共享层(如 leads-roundtable)**。
- **建议(Annie v8 大收敛 —— 内部甚至不需要 B):** 内部 = **单租户(就我们)+ 多机 = 非联邦「单 hub + 无状态卫星」(a 的多机版)**,不涉及多租户 → **跳过 B**。**B(共享 hub 多租户)只在「多租户共享同一套」时才要**,而真要给别人用则数据/凭据/blast-radius 必须硬隔离 = C。→ **对外付费 SaaS 用 C**。⭐ **C = 联邦 = productization(FLY-648);容器化 = 让 C 规模化 provision 的手段**(每客户自动开一套容器化完整栈)。注意 (c) = team 级联邦 → 多租户与联邦是同一问题(见 §3.2 + §8 分阶段)。

**(d) warm pool 生命周期 + ⭐ profile 分池(Annie v4/v5 co-eval):**
- **warm 的是「节点」不是「session」:** warm 池 = 开好机 + 已登录 claude CLI + runner-agent 注册 + 入 tailnet 的节点,空转待命。来一个 issue → 在 warm 节点上起**全新 Claude session**(干净 context)→ 做完 **exit**、节点续 warm。**不是**挂一个 session 注 context 复用(会串味 + 违背 Flywheel「一 issue 一 session」)。贵的是开节点(分钟)、起 session 便宜(秒)。
- **⭐ 按 profile 分池 = 一个 mapping(采纳 Annie 点子,v6 澄清):** profile = 该节点预装/预登录了哪些账号+工具(Cloud CLI / Chrome / Suno / Linear / GitHub)。**它是一个映射:每 team lead → 他能指挥哪些 profile**;派活带 profile 需求(「要带 Suno 的 profile」)→ 命中「lead 有权 + 有该 profile 的 warm 节点」。→ 解决「多数节点不需要 Suno」的浪费。**profile 分池正交于 B/C、两种都能用**(B 在一个 hub 内按 lead→profile 分派;C 各自 hub 内同样)。
- **provisioning = 预烤登录态(bake)+ 载体是 container(非沙箱)(Annie v6/v7 尖问):** 跟 346 一致区分——**沙箱 sandbox = 全套交互开发环境**(浏览器+终端+VSCode+Jupyter+MCP);**container = 轻隔离执行单元**。**要隔离看容器、要浏览器看 provisioning(预装什么)——两件事分开。** warm-node 载体 = **container 镜像/快照**,profile = 不同预登录层。
  - **⭐ 要浏览器的活不必上整套 AIO(Annie v7):做「瘦容器」就够** —— 浏览器 + headless Chrome + 终端,**去掉 IDE/Jupyter**,更轻。接 profile 池:「带浏览器 profile」节点 = 预装+预登录 Chrome 的瘦容器,要浏览器的活派给它、其它用纯执行 container。**要的是「容器(隔离)+ 浏览器(provision)」,非整套 AIO**;346 AIO 只在「要全套交互环境」时才上。

**(e) spot/抢占为啥消失 + 兜底(Annie v5:spot 特性非架构必然):** spot = 云商骨折卖闲置算力、随时(几十秒~2 分钟甚至无通知)收回 + 网络分区/硬件故障。**这只是 spot 的代价、不是架构注定** —— on-demand 不会被抢;**用户自己的物理机更没这问题**(§3.6a 节点来源可选)。兜底:heartbeat(FLY-172)发现 → session-log(FLY-353)无损重建续跑;关键/长任务用 on-demand、可容忍中断批量用 spot;有预警时 drain。

**(f) ⭐ 状态 sync + 清理(立为一等硬要求,Annie v5):** N 台机最后都汇到**同一个 GitHub**,节点复用(profile 池)更要防「过时」:
- **每次起 session 前:节点必须 sync-to-latest** —— git pull 到最新 + 装最新依赖 + 拉其它需要的状态,**绝不拿 outdated 树干活**(否则基于旧代码出错/撞车)。呼应 QA fetch-HEAD 纪律 + 防撞车 FLY-1002。
- **session 结束后:清本地残留** —— 删该 issue 的 worktree/临时文件,别污染下一个 issue。
- **时序(Annie v6 sequence 图确认):取节点 → ① sync-to-latest → ② 起全新 session 跑 → ③ cleanup → 回池。** 含义:**session 结束不能原样立刻复用,每次起前必须先 sync** —— 这正是「一 issue 一干净 session」的**代价 + 正确性来源**(不拿旧代码干活/撞车)。

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
- **[UNKNOWN] Claude CLI 登录态跨机 / 云** —— 每台卫星要各自 `claude login`(或复制 CLAUDE_CONFIG_DIR)。多机 = 多套登录态维护;云弹性节点更棘手:临时节点怎么安全拿到登录态、销毁时怎么擦除(见下一条 secret)。运维成本项,未量化。
- **[UNKNOWN·云] 冷启动延迟** —— 开一个云实例 + 拉镜像 + runner-agent 注册 + 登录态就绪要多久?若是分钟级,弹性 scale 的响应性 / 何时预热节点池要设计。
- **[UNKNOWN·云] spot / 抢占式回收的失败率** —— 用便宜的 spot 实例省钱但会被无预警回收;回收率多高、是否值得用,取决于 session-log(FLY-353)重建的成熟度。要 model。
- **[已解·非难点] secret 分发到临时节点(Annie co-eval 5.3 降级)** —— 有成熟方案:节点 boot 时从 **AWS Secrets Manager / Vault** 经 tailnet 拉登录态/token,随实例销毁一起没。标准做法,不当难点夸大;选型(哪家 / 是否复用 FLY-245 broker)是实现细节,非阻塞未知。
- **[UNKNOWN·云] 成本 model** —— memory-optimized 云实例按小时计费 + always-on hub;弹性开关省多少、冷启动/预热浪费多少,要真实算一笔账才知道云 vs 多买几台物理机哪个更值。

---

## 8. 诚实结论

> **命题已校正(Annie 2026-07-08):** 不是『多机做不做 / 内存怎么治』(换大机已单独做完),而是『**怎么做好横向扩展 → 上云**』。以下是「怎么做」的诚实结论。

1. **战略框架:横向 → 云 = 无上限。** 纵向(换大机)有天花板 + 单点、且已做;1005 = 横向:多台 → 弹性云节点 → 按需 scale、无上限、失败域隔离。额度不在此列(多机不加额度)。
2. **怎么做(架构主线)?** **Option A:单 Bridge hub(state 留 hub)+ 无状态卫星/云节点 runner + 复用已有出站 HTTP + Tailscale 内网。刻意回避跨机 StateStore 一致性(Option C)——无状态才敢弹性开关节点。** 被 homerail(Manager/Node/Worker + callback URL)产品级验证。**出站控制面**(stage/complete/heartbeat/events 走 HTTP、Discord 出站、transport 抽象、heartbeat)大体就绪;**但要补一层把 ask/gate 问答态 + wake(现依赖本地 CommDB)路由到 hub**。要破:锚点 A(Bridge 暴露,3 步:绑内网 + spawn 侧 TEAMLEAD_URL + 保本地兜底)+ 锚点 C(节点 spawn + wake + 本地 CommDB 依赖);锚点 B(本地 SQLite)靠 state 只留 hub 绕过。**安全前置**:多机模式必须 fail-start 除非配了 token;`/actions` 等宽 dashboard 路由保持 loopback-only(见 plan §4.2)。
3. **路线:从第一台卫星起、终点在云。** 阶段1 = 家里第一台卫星机打通 Option A(最小验证);阶段2 = 把卫星 provision 固化成**云节点镜像 + 弹性 provision/deploy**(§3.6)= 战略终点。同一套骨架,云只是把「卫星」换成「弹性镜像节点」。
4. **沙箱(346)?** 家里物理卫星**不强制**(物理机即隔离);**云节点阶段变必需**(云节点 = Linux + 容器,homerail 的 Worker-in-Docker 就是这个形态)。macOS 上 Docker 是 Linux VM,别在 Mac 卫星硬上;云节点则天然容器。
5. **session-log(353)?** 家里卫星阶段是「稳健 failover 的前提」;**云弹性阶段变刚需**——云节点朝生暮死(spot 回收),runner 必须能从 hub 日志无损重启。353 杠杆更高 → 先落或并行,两 research 互引。
6. **树(916)?** 正交:树 = 纵轴(一个 Lead 注意力),多机 = 横轴(物理/云容量),别互相绑死。
7. **横向的三大硬问题(诚实):** 调度/placement + 冷启动、跨机状态(选 Option A 无状态)、失败域(云更会无预警消失)——见 §3.6 + §7 UNKNOWN。

→ 具体分阶段路线 + 阶段1 给 Tadashi 的可建设计 + sub-issue 映射,见 plan.md。
