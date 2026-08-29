# FLY-1005 多机部署 (multi-machine) — 探索

Issue: FLY-1005 (https://linear.app/geoforge3d/issue/FLY-1005/多机部署-multi-machine-runner-分散到多台机器跑-research-prd)
日期: 2026-07-08
基于: 无 (本 issue 为该主题的首份过程文档;收敛已有 backlog,见 §2)

---

## 1. 为什么现在做

Annie 2026-07-08 从 PRD 总览把「多机部署」选为 5-day-window 大方向之一。目标:把 runner 从『只在主开发机跑』扩展到**分散到多台机器**,突破单机资源上限 + 隔离风险。research → 值得就出 PRD → Tadashi。

**命题(Annie 2026-07-08 校正):** 历史 driver 是 FLY-517(16GB 装不下 fleet 的内存瓶颈),但**换大机救急已单独做完、与本 issue 无关**——内存瓶颈已被 vertical scale 解决。**1005 不讨论『多机值不值得 / 内存怎么治』**,而是专攻 **multi-machine 本身:横向扩展 → 把 Provision + Deploy 搬上云 → 真正无上限的 horizontal scale**(纵向加内存有天花板 + 单点;只有横向无上限)。

> 关键:命题从「到底做不做」改成「**怎么做好横向扩展 → 上云**」。分阶段**从第一台卫星/云节点起,不从换大机起**。诚实、UNKNOWN 标清。

---

## 2. 已有资产盘点 —— 这不是新地

多机/远程 runner 在 backlog 里已经被想过多轮。本 issue 的定位 = **把这些收敛成一份统一 research + 分阶段 PRD,不另开并行一套**(已与 Lead 确认)。

| Issue | 是什么 | 状态 | 与 FLY-1005 的关系 |
|---|---|---|---|
| **FLY-555** | 🖥️ EPIC · Multi-machine 分布式 fleet(leads/runners 跨机、Discord 集中控制),Annie 已 approve | Backlog | **本 research 的父容器**;FLY-1005 = 给这个 epic 做 research → PRD |
| FLY-556 | 跨机 Lead↔Runner 编排(comm/StateStore 跨机化) | Backlog(555 子) | PRD 阶段1 核心;research 给出「怎么跨机」 |
| FLY-557 | 每台 load/内存管理 + 跨机 dispatch 分配(per-machine admission) | Backlog(555 子) | PRD 阶段1;research 给 dispatch 策略 |
| FLY-558 | 新机 setup 策略:Migration(搬大机)vs Provision(拆子集) | Backlog(555 子) | 对齐 FLY-519 |
| FLY-561 | lead/runner 在 Discord 显示 tmux session + attach(+ 所在机器) | Backlog(555 子) | 可观测性;多机后需标「哪台机」 |
| FLY-559 | Multi-machine · 云端未来探索(Claude 云服务、弹性 scale) | Backlog(→FLY-648) | PRD 远期阶段 |
| **FLY-517** | 16GB 装不下 fleet — 结构性容量约束(near-OOM 根因) | Backlog | **driver/why**;根治方向①换大机 ②常驻 lead ③多机 |
| FLY-519 | fleet provisioning 脚本(自动化机器 setup) | ✅ Done | 阶段1 的新机 setup 已有工具 |
| FLY-17 | 远程/多机 Runner(Relay 架构),参考 Claude Code Remote Session(WebSocket+HTTP 双通道) | Backlog | 早期架构草案,并入本 research |
| FLY-287 | Lead horizontal scaling via DB-replica multi-replica | Backlog | 相关但属「Lead 扩展」纵向轴 |
| FLY-215 | 规模化编排架构 research(100+ runner 怎么控制) | Backlog | 相关;先区分「慢在哪一层」 |
| FLY-648 | 🚀 EPIC · Flywheel 可移植+可部署产品(Windows→云端→给别人用) | ✅ Done(epic) | 核心/项目分离原则;异构放置(老公 Windows) |
| GEO-271 / FLY-7 | 多机部署 / 远程 Runner daemon | Duplicate | 已并入 FLY-17 |
| FLY-348 | XHS 多 Mac 协同/远程控制方案(tailscale / jump desktop / 屏幕共享) | Canceled | 工具参考(tailscale 组内网) |

**关联但不在本 research 主线**(§见 research.md 关系章):
- **FLY-346** AIO Sandbox(沙箱化)—— 开放问题:多机要不要/怎么用沙箱,不预设。
- **FLY-353** 架构进化(session/记忆解耦成事件日志)—— 可能是多机 failover 的 enabler。
- **FLY-916** 树状 Lead 层级(fleet 规模瓶颈)—— **纵轴**;多机 = **横轴**(FLY-916 自己这么说)。

---

## 3. 五个开放问题(research 提纲)

逐个在 research.md 诚实回答,查不到标 UNKNOWN。(原始 issue 的 Q1『到底做不做』已被 Annie 校正为『怎么做好横向 → 上云』;下面按校正后命题组织。)

1. **横向 → 云怎么做好?** 部署架构:runner 怎么分发到多机/云节点、Provision+Deploy 怎么上云弹性 scale、状态怎么处理、Bridge/Lead 怎么跨机协调、失败(尤其云节点无预警消失)怎么 failover。
2. **横向 scale 的三大硬问题:** 调度/placement + 冷启动、跨机状态、失败域。
3. **和沙箱化(FLY-346)的关系**(开放,不预设):多机要不要/怎么用沙箱?(云节点阶段是否必需?)
4. **和架构进化(FLY-353)/ fleet 规模(FLY-916)的关系:** 353 的 session-log 解耦对云弹性 failover 是不是刚需?树 vs 多机怎么协调、别重复?
5. **参考 homerail**(GitHub xiaotianfotos/homerail):Manager-hub + 无状态 Worker 容器 + callback URL,看它多机/云/隔离怎么做。

---

## 4. 关键区分(想清楚再答,避免混谈)

多机这个词底下缠了好几个不同的问题,先拆开:

- **纵向 vs 横向 scale(核心区分):**
  - 纵向 = 换更大的机器。**有天花板 + 单点,且已单独做完**(非本 issue)。
  - 横向 = 多台机器 + **弹性云节点**。**无上限 + 失败域隔离** = **本 issue 命题**。代价 = 分布式复杂度(跨机状态/调度/失败域)。
- **物理机 → 云(路线,不是二选一):** 先物理机(第一台卫星打通架构),再上云(provision+deploy 上云 = 真正无上限的弹性 scale)。不是「先物理再看看云」,云是战略终点(见 research §3.6)。
- **额度 ≠ 算力:** 多机加的是**算力/节点**,不加 Claude 额度(额度 per-账号)。额度到顶是加账号,别让多机背这个锅。
- **「跑在哪台」(placement)vs「隔离多强」(sandbox):** 多机 = runner 跑在**哪个节点**;FLY-346 沙箱 = runner 被**隔离多强**(容器)。正交但**云节点阶段沙箱变必需**(节点=容器,research §5)。

---

## 5. 显式假设

1. **额度不是多机能解的** —— Claude 是订阅制、额度按账号算;多机加的是算力/节点,不增加额度。若瓶颈是额度,答案是「加账号/加 codex fallback」不是「加机器」。(内存/换大机已 separate、不在 1005;1005 只处理 runner placement / cloud scale。)
2. **Discord 控制面已经解耦、可跨机复用** —— Bridge 只出站连 Discord,不需要公网入站;每台机器可独立连 Discord。(codebase 已确认。)
3. **runner↔Bridge 控制通道「半 HTTP」** —— stage/complete/heartbeat/events 已走 HTTP(`FLYWHEEL_BRIDGE_URL` + `FLYWHEEL_INGEST_TOKEN` 注入 runner env);但 ask/gate 问答态 + mailbox wake 仍走本地 CommDB,阶段1 需路由到 hub。(codebase 已确认,见 research §1.3。)
4. **Annie 的物理机场景是「自己的几台 Mac + 可能一台 Windows」**,不是先上云;安全/隔离是她说的主因。
5. **本任务产出 = 诚实 research + 分阶段 PRD 草案**;最终主线由 Annie 拍板后 Lead 再收(已与 Lead 确认,这是她点名最重要的方向)。

---

## 6. 初步 thesis(将在 research 论证,非预设)

> **横向扩展 → 上云是主线**(换大机纵向已单独做完、有天花板,非本 issue)。架构主线 = 单 Bridge hub(state 留 hub)+ 无状态卫星/云节点 runner,复用已有出站 HTTP + Tailscale,刻意回避跨机 StateStore 一致性(无状态才敢弹性开关节点)—— 正是 homerail 的 Manager-hub + 无状态 Worker。**分阶段:阶段1 第一台卫星打通架构 → 阶段2 provision+deploy 上云(容器镜像 + 弹性)→ 阶段3 按需开关云节点的无上限 horizontal scale。** 云阶段沙箱(346)变必需、session-log(353)变刚需。详见 research + plan。

---

## 关联

FLY-555(父 epic)· FLY-556/557/558/561(子)· FLY-517(driver)· FLY-519(provision,done)· FLY-17(relay 草案)· FLY-346(沙箱)· FLY-353(session-log)· FLY-916(树/纵轴)· FLY-648/559(可移植/云)· FLY-287/215(Lead scale)
