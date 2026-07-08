# FLY-1005 多机部署 (multi-machine) — 实施计划 / PRD 草案

Issue: FLY-1005 (https://linear.app/geoforge3d/issue/FLY-1005/多机部署-multi-machine-runner-分散到多台机器跑-research-prd)
日期: 2026-07-08
基于: exploration.md, research.md (同文件夹)
Status: **draft PRD — 主线待 Annie 拍板后由 Lead 收口**(这是她点名最重要的方向,最终方向 lock 在她拍板后)

> 本文是**分阶段 PRD 草案**。§1 结论、§3 路线、§6 开放决策是要 Annie 拍的;§4 阶段1 详细设计是给 Tadashi 照着能建的深度。凡未验证处标 UNKNOWN,不硬编答案。

---

> **命题(Annie 2026-07-08 校正):** 『换大机救急』已单独做完、与本 issue 无关;**1005 不是『多机值不值得』,而是『怎么做好横向扩展 → 上云(无上限 horizontal scale)』。** 分阶段从『第一台卫星/云节点』起,不从换大机起。

## 1. 结论 (TL;DR)

- **战略:横向 → 云 = 无上限。** 纵向(换大机)有天花板 + 单点、且已做;1005 = 横向:多台 → **弹性云节点** → 按需 scale、无上限、失败域隔离。额度不在此列(多机不加额度,per-账号)。
- **架构主线 Option A:单 Bridge hub(state 留 hub)+ 无状态卫星/云节点 runner**,复用已有**出站 HTTP**(stage/complete/heartbeat/events)+ Tailscale 内网,**刻意回避跨机 StateStore 一致性——无状态才敢弹性开关节点**。被 homerail(Manager/Node/Worker + callback URL)产品级验证。**注意**:ask/gate 问答态 + wake 现仍依赖本地 CommDB,阶段1 要补路由到 hub(不是「改个 URL」)。
- **路线:第一台卫星(打通架构)→ 云 provision+deploy(战略终点)。** 同一套骨架,云只是把「卫星」换成「弹性镜像节点」。
- **云阶段:沙箱(FLY-346)从可选变必需**(云节点 = Linux + 容器);**session-log(FLY-353)从可选升级变刚需**(云节点朝生暮死,runner 要能从 hub 日志无损重启)。

---

## 2. 目标 / 非目标

**目标**
- G1 **横向扩展 runner 容量到无上限** —— 多台机器 + 弹性开/关云节点,不受单机/物理机数量限制。
- G2 **Provision + Deploy 上云** —— 把节点 setup 固化成可复现镜像,能按需弹性开云实例(scale up/down)。
- G3 降低爆炸半径:失败域拆开,一个节点崩不再让整个 fleet 同时崩。
- G4 Discord 仍是唯一集中控制 UI,手机一个 Discord 控全部(现已解耦,天然满足)。
- G5(红利,非主目标)异构/隔离放置(对外 agent 单独节点)。

**非目标(本轮明确不做)**
- N1 **不做**跨机 StateStore 强一致(Option C);单 hub brain 绕过(且无状态才好弹性)。
- N2 **不解决**额度瓶颈(那是加账号,不是加机器/节点)。
- N3 **不做**树状 Lead 层级(FLY-916,正交纵轴,另走)。
- N4 **不重复**换大机 / 内存优化(已单独做完,separate)。

---

## 3. 分阶段路线

```mermaid
graph LR
    P1["阶段1 第一台卫星<br/>单 hub + 无状态卫星 runner<br/>(打通 Option A 架构)"] --> P2["阶段2 云节点镜像<br/>provision+deploy 上云<br/>(FLY-346 容器 + FLY-559)"]
    P2 --> P3["阶段3 弹性 horizontal scale<br/>按需开/关云节点 + 调度"]
    P1 -.并行小路.-> PB["联邦 Option B<br/>异构放置最省力(对外 agent/独立项目)"]
    P3S["FLY-353 session-log"] -.阶段1 enable failover / 阶段3 刚需.-> P1
```

| 阶段 | 内容 | 前置 | 判定 |
|---|---|---|---|
| **1 第一台卫星** | 单 Bridge hub + 无状态卫星 runner-agent(§4),两台机 + Tailscale 打通架构 | Tailscale | 本 PRD 主体、架构最小验证 |
| **2 云节点镜像** | 卫星 provision 固化成云节点镜像(容器,FLY-346)+ 弹性 provision/deploy(§4.6) | 阶段1 | 战略核心:上云 |
| **3 弹性 scale** | 按需开/关云节点 + 跨机调度/placement + 云失败域(§4.6) | 阶段2 + FLY-353 | 无上限 horizontal scale |
| **1' 联邦(可选并行)** | 每机/节点独立完整 Flywheel,各连 Discord(Option B) | 无(=复制单机) | 只为异构放置,不等主线 |
| **(横切) session-log** | FLY-353 事件日志 → 无状态 runner 可重建 | 独立 | 阶段1 给 failover;阶段3 刚需 |

---

## 4. 阶段1 详细设计(给 Tadashi 照着能建)

> 原则:**主机是唯一 brain,卫星是纯执行器。** 复用现有件,最小新增。所有跨机只走 HTTP over Tailscale。

### 4.1 拓扑

```mermaid
graph TB
    subgraph HUB["主机 (hub) — 唯一 brain"]
        BR["Bridge/TeamLead (tailnet 暴露 + auth)"]
        SS[("StateStore teamlead.db (留主机)")]
        LEADS["Leads (Claude CLI panes)"]
        AC["per-node AdmissionController"]
    end
    subgraph SAT1["卫星机 1"]
        RA1["runner-agent daemon"]
        RUN1["runner (本地 tmux + worktree)"]
        RA1 -->|本地 spawn / wake→本地 inbox| RUN1
    end
    BR -->|HTTP dispatch (选机)| RA1
    RUN1 -->|FLYWHEEL_BRIDGE_URL→hub tailnet: stage/complete/heartbeat/events| BR
    RUN1 -->|阶段1 新增: ask/gate/wake 路由到 hub| BR
    RA1 -->|上报 load/free-RAM/runner 数| AC
    LEADS --> BR
```

### 4.2 五个要建的件

**(1) runner-agent daemon(新增,卫星机每台一个)**
- 一个轻量常驻进程(node/launchd),向 hub Bridge 注册自己(node-id + tailnet 地址 + 容量)。
- 接 hub 的 dispatch(HTTP)→ 在本地 `tmux new-session` 起 runner(复用 `TmuxAdapter` 逻辑,只是运行在卫星侧)。spawn 环境要点:在 spawn 侧(runner-agent/Blueprint)设 `TEAMLEAD_URL`(或直接传 `bridgeUrl`),让 runner 最终拿到 `FLYWHEEL_BRIDGE_URL=<hub tailnet>`(否则 Blueprint.resolveBridgeUrl 在非 loopback host 下拒绝推导);再注入 **`FLYWHEEL_INGEST_TOKEN`**(runner 的 stage/complete/heartbeat/events 走它)。**token 两侧名字不同:hub/Bridge 端配 `TEAMLEAD_INGEST_TOKEN`(`/events` 鉴权),spawned runner 拿同一密钥叫 `FLYWHEEL_INGEST_TOKEN`。** 若卫星要调 `/api/*` 才需 `TEAMLEAD_API_TOKEN`。
- **满足卫星职责清单(明确、别藏在「runner-agent」四个字里):** 工具链 provision、Claude/Codex 登录态、repo checkout + worktree 创建、tmux/session 生命周期、event/heartbeat 上报、日志可见性、失败清理、以及 hub UI 是否/如何 attach 远程 tmux(见 §4.5)。
- 周期上报 load / free-RAM / 当前 runner 数(喂 admission)。
- **破锚点 C 的 spawn 半边。** 复用 `packages/claude-runner/src/TmuxAdapter.ts` + heartbeat(FLY-172)。

**(1b) ask/gate 问答态 + wake 路由到 hub(新增,一等公民 —— 不是脚注)**
- 现状(research §1.3 已核):`ask` 写**本地** CommDB、`gate` 核心问答**轮询本地** CommDB、mailbox wake 身份来自**本地** CommDB。卫星 runner 默认没有 hub 的 CommDB。
- 阶段1 必须二选一(D-新 决策):(a) 让卫星的 ask/gate 走 HTTP 到 hub 的 CommDB(runner 侧 CLI 加 --bridge-url 路由 + hub 侧收口),或 (b) 给卫星一份可路由的 comm 视图。**倾向 (a)**:与出站事件同一套 HTTP 姿态,hub 仍是唯一 CommDB 权威。
- wake:hub 判目标 runner 在哪台 node → 经 HTTP 发给该 node 的 runner-agent → agent 写**卫星本地** inbox 文件(transport 抽象是 seam,但 forBackend 目前只 claude-code/codex,新增远程分支或走 runner-agent adapter,见 research §1.3)。
- **破锚点 C 的问答/唤醒半边。这块工作量不小,PRD 明确列出、不低估。**

**(2) Bridge 内网暴露(改造,hub)**
- 现状:`config.ts` 硬绑 loopback(锚点 A)。阶段1 要让卫星能连到 hub Bridge。
- **[开放决策 D1]** 两条路(§6,要 Annie/Codex 定):
  - (a) 允许绑 tailnet IP(放宽 `ALLOWED_HOSTS` 到 tailscale 网段)+ 强制 `TEAMLEAD_API_TOKEN`;
  - (b) 保留 loopback + 在 hub 上前置一个只监听 tailnet 的反代 → 转发到 127.0.0.1:9876。
- (b) 改动更小、Bridge 代码零改、安全边界更清楚(反代做认证 + path allowlist)。**倾向 (b)**,但要 spike。
- **阶段1 安全合同(硬要求,不能只靠 loopback 假设了):**
  - 多机模式必须 **fail-start** 除非 **hub 端 `TEAMLEAD_INGEST_TOKEN`**(+ 需要时 `TEAMLEAD_API_TOKEN`)已配置——现状 `tokenAuthMiddleware` 在无 token 时 **no-op 放行**(`plugin.ts:609-618`);注意 hub 只配 runner 侧的 `FLYWHEEL_INGEST_TOKEN` 是**无效的**(`/events` 读的是 `TEAMLEAD_INGEST_TOKEN`)。暴露到 tailnet 前必须堵上。
  - 只暴露**卫星真正需要的端点**(`/events`/heartbeat + dispatch/wake 收口),经反代 path allowlist;**`/actions` 无鉴权 dashboard 别名 + 宽 `/api/*` 保持 loopback-only**(它们当前正是靠「只在 loopback」才不加 Bearer)。
  - PRD 明确列出卫星需要哪些端点 + 各用哪个 token。
  - **强能力路由**(`/api/actions/*`、close-runner 等)风险边界要 Codex/安全过一遍(FLY-175 founder-consent 已是一层防护);考虑多机模式下进一步收紧到 hub-local 触发(见 §6 D5)。
- **破锚点 A(3 步):** 绑/暴露 Bridge + 在 spawn 侧设 `TEAMLEAD_URL`(或传 `bridgeUrl`)让 runner 拿到 `FLYWHEEL_BRIDGE_URL=<hub 地址>` + 保留本地默认的安全兜底(Blueprint.resolveBridgeUrl 现拒非 loopback 推导)。

**(3) dispatch 选机 + per-node admission(改造,hub)**
- `/api/runs/start` 现在只在本机起 runner;阶段1 加一步「选哪台卫星」。
- 扩 `RunnerAdmissionController`(`packages/teamlead/src/bridge/runner-admission.ts`,现有 load + 可选 memory-pressure 闸门)成 per-node:按各 node 上报的 free-RAM + runner 数选最空的;都满则排队(治今天的 swap thrash)。
- 起步策略可以土:free-RAM 优先 + 硬上限 per-node。
- **对齐 FLY-557。**

**(4) 跨机 wake(改造,hub + 卫星)**
- 现状 `wake.ts` 写本地 `~/.claude/teams/<lead>/inboxes/<agent>.json`(锚点 C)。
- 阶段1:hub 判断目标 runner 在哪台 node → 若在卫星,把 wake 经 HTTP 发给该 node 的 runner-agent → 由 agent 写**卫星本地**的 inbox 文件。
- transport 有抽象(`AgentTeamTransportFactory`,FLY-142,目前只 claude-code/codex)→ **可新增 remote-http transport,或走 runner-agent adapter**;两者都利用 transport/role seam,但需 spike 决定选哪个(D6)。
- **[UNKNOWN]** 也可让 runner 直接联网收 wake(不落本地文件);哪个更稳看 Agent Team inbox 轮询实现(未深挖)。
- **破锚点 C 的唤醒半边。**

**(5) failover(改造,hub)**
- 卫星死 → heartbeat(FLY-172)超时 → hub 把该 node 的在飞 issue 重新 dispatch 到别的 node。
- **无 session-log 时** = 重跑该 phase(可接受但浪费);**有 FLY-353 session-log 时** = 从日志续跑(无损)。→ 这条随 353 升级。

### 4.3 state:刻意不跨机(破锚点 B 的替代=绕过)
- StateStore / CommDB / 各 audit db **全部留 hub**,卫星零权威状态。
- 出站事件(stage/complete/heartbeat/events)已走 HTTP 到 hub;阶段1 把剩下的 ask/gate/wake 也收口到 hub 的 HTTP/CommDB(§4.2 1b)→ 卫星零权威状态,**天然无需跨机 DB**(避开 Option C 分布式一致性)。
- 这是本设计避开分布式一致性泥潭的关键决定。

### 4.4 provision(对齐 FLY-558 / FLY-519)
- 卫星 provision 比主机轻:node/pnpm/tmux/claude CLI + runner-agent + Tailscale 入网 + `claude login`(per 机登录态)。**不需要** Discord bot / Lead / 全套 launchd。
- 复用 FLY-519 脚本,加一个「卫星子集」模式。

### 4.5 可观测(对齐 FLY-561)
- 多机后 Discord thread 要标 runner 在**哪台机/节点** + tmux attach 命令(FLY-561)。
- **[UNKNOWN]** cmux GUI 跨机看不到卫星 pane(cmux 桌面 app,不跨机);手机场景靠 `ssh <卫星> + tmux attach`(FLY-561 已指此方向)。统一多机可观测需单独设计。

---

## 4B. 阶段2-3 详细设计:Provision + Deploy 上云 + 弹性 horizontal scale(1005 战略核心)

> 阶段1 在两台物理机上打通 Option A 骨架后,**同一套骨架把「卫星」换成「弹性云镜像节点」** —— 这才是 Annie 说的无上限 horizontal scale。

**(6) 云节点镜像(阶段2)**
- 把 §4.4 的卫星 provision **固化成一个可复现节点镜像**(容器 / VM image):base OS(Linux)+ node/pnpm + claude CLI + runner-agent + tailscale。
- **容器化(FLY-346)在这里从可选变必需** —— 云节点天然 Linux + 容器;homerail 的 `homerail_node` 起 Docker Worker、Worker 经 callback URL 回连 Manager,正是这个形态(research §4)。runner-agent ≈ `homerail_node`,容器 runner ≈ `homerail_worker`。
- 开一个云节点 = 拉镜像 + 起 runner-agent + 入 tailnet + 向 hub 注册(§4.2 1)。

**(7) 弹性 provision/deploy —— scale up/down(阶段3)**
- hub 的 admission(§4.2 3)从「在固定几台里选」升级成一个 **node pool 管理器**:队列积压/现有节点满 → **开一台新云节点**;节点闲置超时 → **关掉**。
- 实例选型 = **memory-optimized 高 RAM**(fleet 是内存游戏,每 runner ~1.3-1.4GB;别选 CPU-optimized)。对齐 FLY-559。
- **调度/placement**(D7):issue 派到哪个节点、何时预热节点池摊平冷启动延迟(开实例+拉镜像+登录态就绪可能分钟级)。

**(8) 云失败域 + 无损重启(阶段3,依赖 FLY-353)**
- 云节点比家里机器更会**无预警消失**(spot 回收 / 网络分区)。heartbeat(FLY-172)察觉 → 从 **session-log(FLY-353)重建** runner → 在另一节点续跑。**这里 session-log 从「可选升级」变「刚需」**:节点朝生暮死,runner 必须能从 hub 日志无损重启,否则弹性 = 频繁丢 WIP。

**(9) 云 secret / 登录态分发(阶段2-3,安全面)**
- token / claude 登录态怎么安全推到一个临时云节点、销毁时怎么擦除?(D8)复用 FLY-245 gateway/broker 思路还是新机制,要 Codex/安全设计。云节点入 tailnet(私有 mesh、无公网入站)接 hub。

**(10) 成本 model(阶段3 决策输入)**
- memory-optimized 云实例按小时计费 + always-on hub;弹性开关省多少 vs 冷启动/预热浪费多少,要真实算账,决定「云 vs 多买几台物理机」哪个更值(D9)。

---

## 5. 落地 sub-issue 映射(交 Tadashi)

阶段1 直接落到已有 FLY-555 子票,**不新开并行**:

| 已有 issue | 本 PRD 对应 | 备注 |
|---|---|---|
| FLY-556 跨机 comm/StateStore | §4.2(1)(2)(4) + §4.3 | **改口径**:不做跨机 StateStore(N1),改成「单 hub + 无状态卫星/节点 + HTTP/wake 跨机」 |
| FLY-557 per-machine load + dispatch | §4.2(3) + §4B(7) | admission per-node → 阶段3 升级成 node pool 弹性调度 |
| FLY-558 migration vs provision | §4.4 | 卫星子集 provision(搬大机已 separate、非本 issue) |
| FLY-561 tmux/机器可观测 | §4.5 | 多机后标机器/节点 |
| FLY-519 provisioning(done) | §4.4 + §4B(6) | 卫星子集模式 → 云节点镜像雏形 |
| FLY-559 云端弹性 scale | §4B(6)(7)(10) | **阶段2-3 战略核心**(上云 + 弹性),不再是「远期非目标」 |
| FLY-346 AIO Sandbox / 容器 | §4B(6) | 云节点阶段**必需**(节点=容器) |
| **新增建议** | runner-agent daemon | FLY-556 里没有独立列;建议单开一个 sub |
| **新增建议** | Bridge tailnet 暴露 + 安全过审 | D1 决策后开 |
| **新增建议** | 云 node pool 管理器 + 镜像 | 阶段3;可挂 FLY-559 |

**横切依赖:** FLY-353 session-log(阶段1 failover / 阶段3 刚需)· FLY-916 树(正交纵轴,不阻塞)· FLY-648 可移植/核心-项目分离(云镜像的前置思路)。

---

## 6. 开放决策(要 Annie / Codex 拍)

- **D1 Bridge 暴露方式:** (a) 放宽 loopback + token,还是 (b) tailnet 反代?(倾向 b,要 spike)—— 安全 sensitive,建议 Codex/安全过。
- **D2 云 vs 更多物理机的先后:** 阶段1 用家里第二台物理机打通架构后,阶段2 直接上云,还是先多摆两台物理机?(战略终点是云,但物理机验证更快/更省;要 Annie 拍节奏。)
- **D3 联邦 Option B 要不要作为并行小路先上?** 若近期就要「对外 agent / 独立项目单独节点」,B 比主线省力得多,可先做。
- **D4 session-log(FLY-353)排序:** 先落 353 再多机(无损 failover 从第一天有),还是阶段1 先上、353 到位再升级?(注意:阶段3 云弹性时 353 是刚需,不是可选。)
- **D5 强能力 API 暴露到 tailnet 的风险边界** —— `/api/actions/*` 要不要在多机/云模式下进一步收紧(只允许 hub-local 触发)?
- **D6 ask/gate/wake 路由方式:** 卫星/节点 runner 的 ask/gate 问答态 + wake 现依赖本地 CommDB(§4.2 1b)。走 (a) HTTP 到 hub CommDB(倾向,同出站姿态),还是 (b) 给节点一份可路由 comm 视图?阶段1 真正的工程量所在,要 Tadashi/Codex 定。
- **D7 云调度/placement + 冷启动:** issue 派到哪个节点、何时开新节点/回收、要不要预热节点池摊平冷启动延迟?(阶段3)
- **D8 云 secret 分发:** 登录态/token 怎么安全推到临时云节点、销毁怎么擦除?复用 FLY-245 broker 还是新机制?(安全,阶段2-3)
- **D9 成本 model:** 云 memory-optimized 弹性开关 vs 多买物理机,哪个更值?要真实算账。(阶段3 决策输入)

---

## 7. 验收 / QA 思路

- **阶段1 真机 E2E(两台物理机 + Tailscale):**
  1. hub dispatch → 卫星起 runner → runner 走 HTTP 回报 stage/complete/events 全链通。
  2. 跨机 ask/gate/wake:hub 收到卫星 runner 的 ask/gate、唤醒卫星 idle runner,runner 醒(§4.2 1b)。
  3. admission:卫星满 → 新 dispatch 排队/转另一台。
  4. failover:kill 卫星 → hub 察觉 → 重派;(有 353 则验无损续跑)。
  5. Discord 集中控制:手机 Discord 能看到并驱动跨机 runner(标了机器)。
  6. 安全:未配 token 时多机模式 fail-start;`/actions` 不可从 tailnet 到达。
- **阶段2-3 E2E(云):**
  1. 从镜像开一个云节点 → 自动入 tailnet + 注册 hub + 起 runner,全自动(冷启动计时)。
  2. 弹性:队列积压 → 自动开新节点;闲置 → 自动回收。
  3. 云失败域:强杀/回收一个云节点 → hub 从 session-log 无损重启 runner 到另一节点。
  4. secret:登录态安全分发 + 节点销毁后擦除验证。
- 独立 QA(非实现者自验),对齐项目 auto-QA 政策。

---

## 关联

FLY-555(父 epic)· FLY-556/557/558/561· FLY-517(driver)· FLY-519(provision)· FLY-17(relay 草案)· FLY-346(沙箱/阶段2)· FLY-353(session-log/横切)· FLY-916(树/纵轴)· FLY-648/559(可移植/云)· homerail(架构参照)
