# FLY-1005 多机部署 (multi-machine) — 实施计划 / PRD 草案

Issue: FLY-1005 (https://linear.app/geoforge3d/issue/FLY-1005/多机部署-multi-machine-runner-分散到多台机器跑-research-prd)
日期: 2026-07-08
基于: exploration.md, research.md (同文件夹)
Status: **SUPERSEDED — 正式 PRD 已定稿并经 Annie 确认。** 本文是 research/co-eval 阶段的收敛草稿(历史记录);**权威文档 = `engineering/doc/FLY-1005-multi-machine/prd.md`(详细版 PRD,含 Phase 1/2/2.1/3 + 11 条 build-issue)**。主线已定(见下)——eng 照正式 PRD 的 BI-1..BI-11 执行。

> 本文是**分阶段 PRD 草案**。§1 结论、§3 路线、§6 开放决策是要 Annie 拍的;§4 阶段1 详细设计是给 Tadashi 照着能建的深度。凡未验证处标 UNKNOWN,不硬编答案。

---

> **命题(Annie 2026-07-08 校正):** 『换大机救急』已单独做完、与本 issue 无关;**1005 不是『多机值不值得』,而是『怎么做好横向扩展 → 上云(无上限 horizontal scale)』。** 分阶段从『第一台卫星/云节点』起,不从换大机起。
>
> **⭐ 分阶段收敛(Annie 2026-07-08,co-eval 9 轮后,重新编号 Phase 1 = 今天):**
> - **Phase 1 = 今天:** 单机 —— hub(Bridge+DB+Leads)+ 所有 runner 一台机(worktree/tmux),单租户。(起点)
> - **Phase 2 = 自己多机(核心 1005):** 共享 hub(我们的 team 仍共用一套 Bridge+Leads,**hub+DB 最好拆云**)+ 多机**无状态卫星节点容器**(profile 预登录、每 session sync-to-latest),横向扩展。delta = runner 从本机 worktree/tmux → 多机无状态容器化卫星,突破单机容量 + 失败域隔离。(自然子步:先起云节点跑通、再 hub+DB 拆云;主线仍一个 Phase。)
> - **⭐ Phase 2.1 = 拆出高 churn 的 Flywheel hub(Annie v10 加):** 把 **Flywheel 的 hub(Bridge+Lead)从共享 hub 单独拆出来**,跟稳定 team(Jolt 3D/Tidal Echo)分开;**runner 仍分散**。驱动 = Flywheel 高频改(4 次/天)vs 其他 team 稳(1 次/天),拆开后 Flywheel 频繁重启**不再逼其他 team 跟着重启** = **decouple-restart(FLY-978)在多机上的延伸**。踏脚石:Phase 2(共享 hub)→ Phase 2.1(**先拆最高 churn 的**)→ Phase 3(每 team 一整套=C),按「谁最需要独立先拆」。
> - **Phase 3 = 产品化:** 把容器化栈打包 → 别人自部署一份 = **C 联邦(每租户一整套硬隔离)= FLY-648**。delta = 从内部按 churn 逐个拆 hub → 每租户(含外部付费客户)各自一整套。**Phase 2 容器化 = 种子;Container 贯穿 = must-have。**
> - **⭐ 为什么跳过 B:** 区分——**内部我们的 team 共享一个 hub(Phase 1-2)是现状、低风险、可接受**(Phase 2.1 在此基础按 churn 逐个拆);**B 特指「给外部多个租户共享一个 hub」** → 对外付费必须硬隔离 = C(Phase 3),所以**跳过对外 B**(只在专做 hosted 共享服务才有意义)。
> - 下方 §3 的阶段0-3 是 **Phase 2/2.1** 的内部细化。
>
> **状态:✅ 正式 PRD 已写并经 Annie 确认** —— 权威文档 `engineering/doc/FLY-1005-multi-machine/prd.md`(详细版)。本节 3-Phase 已被 PRD 收编(PRD 重编号 Phase 1=今天 / Phase 2=自己多机 / Phase 2.1=拆 Flywheel hub / Phase 3=产品化)。

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
    P0["阶段0/近期 摆几台物理机<br/>横向摊开 fleet(Annie lean)<br/>非换大机"] --> P1["阶段1 第一台卫星<br/>单 hub + 无状态 runner<br/>(打通 Option A 架构)"]
    P1 --> P2["阶段2 云节点镜像<br/>provision+deploy 上云<br/>(FLY-346 容器 + FLY-559)"]
    P2 --> P3["阶段3 弹性 horizontal scale<br/>节点池按需开/关 + 调度"]
    P0 -.并行小路.-> PB["联邦 Option B<br/>各自完整(对外 agent/独立项目)"]
    P3S["FLY-353 session-log"] -.阶段1 enable failover / 阶段3 刚需.-> P1
```

> **主线已定(Annie 确认,见正式 PRD §3):team 内部 scale 走非联邦(单 hub + 无状态节点)= Phase 2 主线;跨 team/给别人用走联邦(每 team 一套=C)= Phase 3。** 两者分层组合、不是二选一。下表按非联邦主线列。

| 阶段 | 内容 | 前置 | 判定 |
|---|---|---|---|
| **0/近期 物理机** | 横向多摆几台物理机(非换大机)+ Tailscale,摊开 fleet | 无 | Annie lean、稳定 baseline + 上云前验证台 |
| **1 第一台卫星** | 单 Bridge hub + 无状态卫星 runner-agent(§4),打通 Option A | 阶段0 + Tailscale | 架构最小验证 |
| **2 云节点镜像** | 节点 provision 固化成容器镜像(FLY-346)+ 弹性 provision/deploy(§4B) | 阶段1 | 战略核心:上云 |
| **3 弹性 scale** | 节点池按需开/关 + 跨机调度/placement + 云失败域(§4B) | 阶段2 + FLY-353 | 无上限 horizontal scale |
| **联邦(= Phase 3 路径 / 可选并行小路)** | 每机/节点独立完整 Flywheel,各连 Discord(= C) | 无(=复制单机) | 跨 team/给别人用的隔离(= Phase 3 productization);**非 Phase 2 主线候选**(主线已定=非联邦) |
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

**(6b) 容器镜像讲细(Annie co-eval):** 「固化成镜像」= 把手动 provision 一次性烤进 Dockerfile,开节点 = `docker run <镜像>`,不用每台重装;provision 逻辑从「每台手动」变「构建镜像时一次(build 一次、deploy 多次)」。Docker 只在云/Linux 节点必需;家里 Mac 卫星可裸跑。

**(7) 弹性 provision/deploy —— 四步闭环 + ⭐ profile 分池(阶段3)**
- hub 的 admission(§4.2 3)升级成 **node pool 管理器**,四步:**触发**(队列积压/节点满过阈值)→ **provision**(调云 API 从镜像开实例)→ **入池**(节点 boot + runner-agent 注册 → 加进可用池)→ **销毁**(闲置超时 → 收干净 → 关实例)。
- **不是每 issue 开新节点**(冷启动几分钟又贵),是**节点池复用**:issue 先派给池里有空位的节点;**只有池满**才开新节点;闲了回收。
- **⭐ 按 profile 分池(Annie v5 采纳):** profile = 节点预装/预登录的账号+工具集(Cloud CLI/Chrome/Suno/Linear/GitHub);项目带 profile 需求 → hub 匹配那类池(解决「多数节点不需 Suno」浪费)。每 profile = 一份**预烤登录态镜像**;**站在 FLY-346 AIO Sandbox 上做「预登录层」,不自写沙箱**(research §3.7d)。
- **节点来源可选(Annie v5):云 OR 用户自己物理机(开源自管)**,都接进同一 hub 池;自管物理机无 spot 消失问题、uptime 自担。
- 实例选型 = **memory-optimized 高 RAM**(每 runner ~1.3-1.4GB)。对齐 FLY-559。
- **调度/placement**(D7):池里怎么选、何时预热摊平冷启动。

**(7b) ⭐ 状态 sync + 清理(一等硬要求,Annie v5)**
- N 台机汇同一 GitHub、profile 池复用节点 → **每次起 session 前必须 sync-to-latest**(git pull + 最新依赖 + 其它状态),绝不拿 outdated 树干活(呼应 QA fetch-HEAD + 防撞车 FLY-1002);**session-exit 清本地残留**(worktree/临时文件),不污染下一个 issue。runner-agent 负责(§4.2 1)。

**(8) 云失败域 + 无损重启(阶段3,依赖 FLY-353)**
- 云节点比家里机器更会**无预警消失**(spot 回收 / 网络分区)。heartbeat(FLY-172)察觉 → 从 **session-log(FLY-353)重建** runner → 在另一节点续跑。**这里 session-log 从「可选升级」变「刚需」**:节点朝生暮死,runner 必须能从 hub 日志无损重启,否则弹性 = 频繁丢 WIP。

**(9) 云 secret / 登录态分发 —— 不是难点(Annie co-eval 5.3 降级)**
- 有成熟方案:节点 boot 时从 **AWS Secrets Manager / Vault** 经 tailnet 拉登录态/token,随实例销毁一起没。标准做法,不当难点夸大;选型(哪家 / 是否复用 FLY-245 broker)是实现细节。云节点入 tailnet(私有 mesh、无公网入站)接 hub。

**(10) 成本 model(D9,已做一版粗估;精确需真实报价 + runner-hours)**
- 假设:每 runner ~1.3-1.4GB;32GB 节点 ~15-20 runner。

| 方案 | 成本形态 | 粗估 | 适合 |
|---|---|---|---|
| 物理机(Mac 32-64GB) | 一次性 ~$1.3k-2.5k/台,always-on | 摊 3 年 ≈ $40-70/月/台 | 稳定 baseline |
| 云 on-demand(32GB 内存优化) | ~$0.2-0.4/hr | always-on ≈ $150-290/月;scale-to-zero 只付活跃小时 | 突发/弹性 |
| 云 spot | ~$0.07-0.13/hr(会被回收) | 更便宜,需 session-log failover | 可容忍中断批量 |

- **结论:baseline 用物理机更省(amortized capex 便宜),突发峰值用云弹性(scale-to-zero)→ 支持「近期物理机 + 云补弹性」(D2 + D9)。**

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

## 6. 决策(✅ = 已定,均已收进正式 PRD)

- **✅ D0 主线选型:联邦 vs 非联邦 —— 已定(Annie 确认)。** 分层组合:team 内部 scale 走非联邦(单 hub + 无状态节点,= Phase 2 主线,唯一给一个 fleet 无上限弹性);跨 team/给别人用走联邦(每 team 一套=C,= Phase 3,隔离/productization=FLY-648)。两个都要、不同层级。
- **✅ 状态 sync + 清理(Annie v5 一等要求)** —— 每 session 前 sync-to-latest、exit 清残留(§4B 7b)。
- **✅ 节点来源可选(Annie v5)** —— 云 OR 用户自己物理机(自管);profile 分池 + 站 346 沙箱(§4B 7)。
- **✅ D10 多租户(§4B / research §3.7c):** 我们现状=单租户 (a);产品化/多项目走 (c) 每 team 自己一套(= team 级联邦);(b) 共享 hub 除非做 SaaS 否则别碰(安全最难)。
- **✅ D11 Hub+DB 一体 vs 分离(research §3.7b):** Annie 直觉对——「不共享 DB」只指「不做多 hub 写一个 DB」;单 hub + 云 DB(单写者)是好的。建议家里阶段用一体 SQLite、上云换分离云 DB(独立存活+备份+HA)。
- **✅ warm pool(research §3.7d):** warm 的是节点(开机+登录+注册),每 issue 起新 session(干净 context)做完 exit,非挂 session 复用。
- **✅ D2 近期先摆几台物理机**(Annie lean)—— 横向多摆物理机(非换大机)当阶段0/近期 baseline + 上云前验证台;云补弹性峰值(成本 §4B(10) 支持)。
- **✅ D9 成本估算** —— 已做粗版(§4B(10)):物理机 amortized $40-70/月 vs 云 on-demand $150-290/月 vs spot;结论 baseline 物理 + 突发云弹性。精确待真实报价。
- **✅ D8 secrets** —— 非难点,用 AWS Secrets Manager/Vault 标准方案(§4B(9))。
- **D1 Bridge 暴露方式:** (a) 放宽 loopback + token,还是 (b) tailnet 反代?(倾向 b,要 spike)—— 安全 sensitive,建议 Codex/安全过。(工程向,交 Tadashi/Codex)
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
