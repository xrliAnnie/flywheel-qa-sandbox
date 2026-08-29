# FLY-1022 树状 Lead 带很多 runner（层级化 runner 管理）— 探索（current-state 现状审计）

Issue: FLY-1022 (https://linear.app/geoforge3d/issue/FLY-1022/lead-scaling-one-lead-managing-many-runners-via-a-tree-hierarchical)
日期: 2026-07-08
基于: 无（本 issue 是 Annie 2026-07-08 从 PRD 总览重新拎出的方向；与 FLY-916 是同一个问题的再开）

> 说明：本文是**现状代码审计 + 问题定位**（我的功课），不是 research 正文、更不是 PRD。
> 目的是让「要不要 / 怎么给一个 Lead 加树状层级」这条建议**建立在 Flywheel 真实代码事实 +
> 已有 issue 判断上**，而不是凭空对着「树」这个词设计。深调研收敛在同文件夹 `research.md`；
> 交互 co-eval 收敛在 `hierarchical-runner-tree-design.html`（给 Annie 逐节批注）；PRD 待 co-eval 后再写。

---

## 0. 一句话结论（审计后）

**这不是一个「缺功能」的问题，是一个「一个 Lead 的注意力/上下文是有限的，runner 一多就摊薄」的问题。**
今天一个 Lead **直接、平铺**地带所有 runner：每个 runner 的每一次状态变化、每一个 ask、每一条 relay 都
要**这一个 Lead 的同一个 context/同一条单线程**去处理。runner 数一大（实证 **5-6 个就吃力**，FLY-916），
Lead 的注意力被 O(N) 摊薄 + context 被 N 个 runner 的细节塞满 → 变慢、漏事、挨个重启。

**树（Lead → sub-lead → runners）的核心价值 = 一个 facade / 压缩层**：Lead 只跟少数 sub-lead 谈、只看
**摘要**，不看每个 runner 的细节；sub-lead 各带一摊 runner。这样 Lead 的注意力/context 跟 runner 总数
**解耦**。—— 这句话是 Tadashi 在 FLY-916 里的关键洞察，本 issue 直接继承。

但审计也给出**两条克制**（Annie 的「别过度设计」红线，本文全程服从）：
1. 树是**放大器**：多一层 = 多一处能藏「静默卡住的 agent」。可靠的静默失败检测是树的**近乎前置** ——
   而这半边 **FLY-942（看门狗 + Lead 主动汇报 PRD）已 Annie-approved 做完**（PR #506），树**不重造、直接 lean 上去**。
2. 树**不一定现在就要**：353 的自动派发 + 942 的自动检测，可能已经把「>5 runner 就累」的**近期**痛扛住一大半；
   树真正不可替代是在 **多机（1005）铺开到几十上百 agent** 之后。所以本 explainer 的头号 co-eval 问题就是
   **「现在做树，还是先靠 353+942 扛、把树 scale-gated 放后面？」**

---

## 1. 这个 issue 在整张图里的位置（五根轴，别搞混）

Annie 这几天把「Flywheel 怎么 scale」拆成了几根**正交**的轴，各自一条 co-eval/PRD 线。搞清楚 1022 是哪根轴、
不碰别的轴，是本文第一要务：

| 轴 | 回答的问题 | Issue | 状态 |
|---|---|---|---|
| **派什么**（Layer 2 引擎） | 做**哪些** issue、自动挑/派/推进 | FLY-353 | co-eval 中（PR #511） |
| **每个怎么跑**（Layer 1 模板） | 选中一条 issue **怎么编排**（三段式/短模板） | FLY-1020 | co-eval 中（PR #514） |
| **谁来指挥**（指挥结构 · 纵轴） | 一个 Lead 怎么**命令/关照**很多 runner | **FLY-1022（本）= FLY-916** | 本轮 |
| **在哪跑**（部署 · 横轴） | runner 铺到**几台机器**上跑 | FLY-1005 | co-eval 中（PR #512） |
| **谁卡了会被发现**（可观测） | 静默停车/卡住的检测 + Lead 响应 | FLY-942（+878/927） | **PRD 已 done（PR #506）** |

**一句话记法**：353 挑活 → 1020 定每条怎么跑 → **1022 是这些活派下去时的「指挥树」结构** → 1005 决定 runner 在哪台机器上 →
942 保证没人静默卡死。**1022 = 353 引擎在其上派发的那棵「指挥/命令树」的结构本身。**

### 1.1 跟 FLY-916 的关系（关键：同一个问题）

FLY-916（2026-07-06，Annie + Cass + Tadashi）标题就是
「单 Lead 带 5-6 session 就吃力 → fleet 规模瓶颈（**树状 Lead 层级 + 可观测**，design-first）」。
**FLY-1022 = Annie 2026-07-08 把这个方向重新拎出来、跟多机（1005）绑在一起再开。** 内容是同一个。
FLY-916 里已经有 Tadashi 的核心设计判断（下 §4 引用），本 issue 直接继承、不推倒重来。

### 1.1b 跟 FLY-353 的分界（两种互补的「Lead 不够用」解，方向相反）—— Cass dedup 划的界

**1022 是 lead-tree 的 canonical**（原 FLY-916 lead-tree 已并入本 issue、标 dup）。跟 353 别抢地盘：

| | 353 的 scale 答案 | 1022 的 scale 答案（本 issue） |
|---|---|---|
| 方向 | **抬高「一个脑」的天花板** | **加更多「脑」，每个装更少** |
| 手段 | offload session（把记忆挪出 context）+ 自动派发 DAG 编排 → **单 Lead 拿更多** | 分 sub-lead / 树状指挥 → **每个 Lead 拿更少** |
| 归属 | FLY-353（**我不碰它的 DAG 编排 / session-decouple**） | FLY-1022（我专注） |

两者**互补、不互斥**：可以「一个更强的 Lead（353）+ 再把它拆成树（1022）」叠着用。本文只谈树；353 的 offload/DAG 只引用、不覆盖。

### 1.2 跟 FLY-1005（横轴）的关系（明确分工，别打架）

FLY-1005 的 plan.md（PR #512）**非目标 N3 白纸黑字写着：「不做树状 Lead 层级（FLY-916，正交纵轴，另走）」。**
也就是说 **1005 刻意保留「单个 Lead brain」**：它只把 runner 从「一台机」铺到「多台机 / 云节点」（横向、突破容量），
state 全留 hub、runner 变无状态卫星。**它把 runner 的「手」铺开，但没动 Lead 的「脑」能不能顾得过来。**

→ 两轴**正交、互补、可独立推进**：
- **1005（横）让 runner 数量能上去**（多机 → 无上限）。
- **1022（纵）让一个 Lead 的脑子真的够得着那么多 runner**（树 → 注意力/context 与 runner 数解耦）。
- 合起来才是「一个人指挥一大片 fleet」。**1005 先落地也 OK**（单 Lead brain 先扛着）；runner 真多到单 Lead 顾不过来，1022 才成为瓶颈。

---

## 2. 现状（核过码 · 诚实）：今天一个 Lead 到底怎么「带」runner

> 结论先行：**今天没有任何「树 / sub-lead / 分组」的概念。** 一个 dept Lead 直接、平铺地面对它启动的每一个 runner；
> 唯一像「上一层」的东西是 CoS（Simba / Aunt Cass）→ dept Lead 的**人类组织层**，但那是「派活给哪个部门」，
> 不是「帮 Lead 分担带 runner 的注意力」。

### 2.1 Lead 怎么把一个 runner 起起来（dispatch/spawn）

- Linear issue 的 **label → agent/Lead 路由**：`AgentDispatcher` + 项目 `config.yaml` 的 `agents[].match.labels` /
  `default_agent`（eng label → Tadashi 线、product label → HL 线）。这挑的是**哪个部门/agent 跑**。
- 起 runner = Bridge `/api/runs/start` → Blueprint 组装提示词 + `TmuxAdapter` 在本机 `tmux new-session` 起一个
  Claude/Codex CLI 进程（`packages/claude-runner` 家族的 adapter；FLY-493/494 起 agy/kimi 也走同一 seam）。
- 起不起得来受 `RunnerAdmissionController`（`packages/teamlead/src/bridge/runner-admission.ts`）的 load / 内存闸门。
- **[待审计确认具体行数/函数名 — 见 research.md §1]**

### 2.2 ⭐ Lead 怎么「知道」runner 的进展 —— 这才是瓶颈所在

这是「>5 就吃力」的病根。核心事实（待 dedicated 审计逐条钉死行号，framing 已确定）：

- runner 的每一次状态变化（stage 变、干完 parked、ask 问 founder、gate 等批准、失败）都通过 **flywheel-comm →
  Bridge 事件 / mailbox / CommDB** 汇到 **Lead 这一个 session**。
- Lead 是**一条单线程**在处理这些事件（MEMORY: 「FLY-85: Lead 单线程阻塞（架构限制）」）。runner 越多，
  事件流越密、relay 越多、context 里塞的 runner 细节越多 → **每个 runner 摊到的注意力 ≈ O(1/N)，Lead 的 context ≈ O(N)**。
- 系统级的**看门狗**（LeadWatchdog / FLY-878/927）在检测 runner 静默卡住；FLY-942 把「检测 = 看门狗系统级的活、
  Lead = 响应」这条产品契约定死了。**但看门狗解决的是「没人漏检」，不解决「Lead 一个脑子带不动那么多」** —— 那正是 1022。
- **[待 dedicated 审计补：GatePoller 轮询节奏、每 runner 的具体 relay 成本、context 增长的实测点]**

### 2.3 今天唯一像「层级」的东西：CoS → dept Lead

- 产品体验 spec §1.4 / §5：Simba（CoS）是所有 Lead 的总 Lead，做 triage / 全局调度 / 跨部门协调；
  dept Lead（Peter/Tadashi/Oliver）各带自己的 runner。
- 这**已经是一棵两层树**，但它分的是**部门/职责**（CoS 决定「这活归产品还是运维」），
  **不是**「帮某一个 Lead 把它那一摊 runner 拆成几组、各设一个 sub 帮它盯」。
- 也就是说：**横向已经有「多个 Lead 分工」，纵向（一个 Lead 内部再分层带 runner）今天完全没有。** 1022 要补的是后者。

---

## 3. 痛的实证（不是预建，是眼前的痛）

- FLY-916 原文：「单个 Lead 同时带 **5-6 个 session 就已经很吃力**（今天 fleet 吃紧、leads 挨个重启、
  Tadashi 来回忙不过来 = 实证）。」Annie + Cass + Tadashi 三方确认。
- **⭐ 活的 dogfood 证据（就在今晚）**：产品 Lead Honey Lemon **此刻正一个人平铺带着 ~10 个 runner**
  （1005 / 353 / 347 / 1020 / **1022（就是这个）** / 910 / 1004 / 1032 …）。O(N) context + O(1/N) 注意力
  **今晚就在真实发生** —— 她甚至差点漏掉一个终端 prompt。这不是假想的未来，是**现在**这个 session 就是 §2 现状的活样本。
- 高杠杆：自主性北极星 = **一个人管更多 = 少 human-in-loop**。Lead 能带的 runner 越多，Annie 越省心。
- 够挑战：架构硬活（通信层加一层角色、facade 压缩、dispatch 路由），正好 Fable。

---

## 4. FLY-916 里已经沉淀的设计判断（直接继承，别重推）

Tadashi 在 FLY-916 给的关键洞察 + 依赖初判（本 issue 的设计起点）：

- **树**：Lead 下挂 sub-lead，Lead **只跟 sub-lead 谈**（facade / 压缩层：只看摘要、不看每个 runner 细节
  = **树的核心价值**），sub-lead 各带一摊 runner。
- **树 = 放大器**：多一层 = 多一处能藏「静默卡住的 agent」，底子不稳会被放大。**反过来**：可靠的静默失败检测
  （看门狗/健康扫描）是树的**近乎前置**——带 50+ agent 跨 sub-lead，得先能测出谁悄悄卡了。
- **所以树 + 可观测是同一个问题**，一起设计：树从第一天把可观测烤进去（每个 sub-lead 自报健康、汇总上来）。
- **依赖（Tadashi 初判）**：① 通信层支持「Lead 当另一个 Lead 的孩子」（sub-lead 向上汇报 + 向下派 runner）——
  加一层角色，中等改动；② facade / 压缩层 = 核心设计 + 树的主要价值；③ Bridge dispatch 路由到 sub-lead，中等。

> **本文的增量**（相对 FLY-916）：把「可观测是前置」这句**收口到 FLY-942 已 done 的看门狗 PRD** ——
> 观测半边**不用在 1022 里重新设计**，1022 只需让「健康摘要沿 sub-lead 往上汇总」这条路接上看门狗即可。
> 这就是 Annie「别过度设计」红线下最大的一处「可以砍」。

---

## 5. 待 co-eval 的开放问题（喂给设计 HTML，别预设答案）

1. **要不要现在做树？** 还是先靠 353（自动派发）+ 942（自动检测）扛住近期 fleet，树 scale-gated 放到多机铺开后？
2. **树的第一刀多小？** 一层 sub-lead 够不够（Lead → sub-lead → runner，就两层）？还是要可递归多层？
3. **sub-lead 是什么？** 一个精简版 Lead agent（同代码、换角色 prompt）？还是一个更轻的「组协调器」进程？
4. **facade 摘要长什么样？** sub-lead 往上汇报的「压缩」到底压掉什么、保留什么（Annie 要能一眼看懂哪组出事）？
5. **跟 1005 的接缝**：多机时 sub-lead 跟它那摊 runner 是否同机？树的层级和机器的分布怎么对齐（还是完全正交）？
6. **别过度设计**：起步坚决不做——递归任意深树 / sub-lead 自己再开 sub-lead / 复杂负载均衡调度。够用就好。

---

## 附：审计信息来源

- 兄弟 co-eval 审计已核过的代码事实（复用、不重复 grep）：FLY-1005 plan.md（`config.ts` loopback、`wake.ts` 本地 inbox、
  CommDB 本地、`RunnerAdmissionController`、`TmuxAdapter`、heartbeat FLY-172、`AgentTeamTransportFactory`）；
  FLY-1020 HTML（`AgentDispatcher`、`config.yaml agents[].match.labels`、`three-stage-policy.ts`、`three-stage-phases.ts`）。
- 本 issue 专属的 Lead↔Runner 协调审计（GatePoller / 单线程 Lead / 每 runner relay 成本 / context 增长）→ research.md §1。
