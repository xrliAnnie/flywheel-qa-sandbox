# FLY-1005 多机部署 (multi-machine) — 探索

Issue: FLY-1005 (https://linear.app/geoforge3d/issue/FLY-1005/多机部署-multi-machine-runner-分散到多台机器跑-research-prd)
日期: 2026-07-08
基于: 无 (本 issue 为该主题的首份过程文档;收敛已有 backlog,见 §2)

---

## 1. 为什么现在做

Annie 2026-07-08 从 PRD 总览把「多机部署」选为 5-day-window 大方向之一。目标:把 runner 从『只在主开发机跑』扩展到**分散到多台机器**,突破单机资源上限 + 隔离风险。research → 值得就出 PRD → Tadashi。

**直接 driver = FLY-517**(16GB 机器装不下当前 fleet):实测 fleet 负载需约 25GB(swap 用满 = 物理 RAM 的 2.5×)→ 永久 swap thrash、极慢。**无内存泄漏、无跑飞进程** —— 13 lead + 一堆 runner + Chrome 这套本身就装不进 16GB。今天 load 54→71 + swap tripwire(<400M free)又验证一次。这是一个**结构性容量约束**,不是 bug。

> 关键:Annie 明确「不预设答案」。本 research 的第一问就是「到底做不做」,可能的诚实结论包括「先别做多机、先换台大机器」。

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

逐个在 research.md 诚实回答,查不到标 UNKNOWN。

1. **到底做不做?** 单机真实瓶颈是什么(资源/额度/稳定性)?多机能解决哪些、代价多大?
2. **怎么做?** 部署架构:runner 怎么分发到多机、状态/记忆怎么同步、Bridge/Lead 怎么跨机协调、失败怎么 failover。
3. **和沙箱化(FLY-346)的关系**(开放,不预设):多机要不要/怎么用沙箱?
4. **和架构进化(FLY-353)/ fleet 规模(FLY-916)的关系:** 353 的 session-log 解耦是不是多机前提?树 vs 多机怎么协调、别重复?
5. **参考 homerail**(GitHub xiaotianfotos/homerail):Home=跑自家 NAS/homelab + 沙箱,看它多机/隔离怎么做。

---

## 4. 关键区分(想清楚再答,避免混谈)

多机这个词底下缠了好几个不同的问题,先拆开:

- **瓶颈的三种可能** —— 内存 ≠ 额度 ≠ 稳定性。三者的最优解不同(见 research §2):
  - 内存不够 → 换大机 or 加机器都行。
  - 额度不够 → **多机没用**(Claude 额度是 per-账号,不是 per-机器;加机器不加额度)。
  - 稳定性(一台崩全崩)→ 只有多机(隔离爆炸半径)能治。
- **纵向 vs 横向 scale:**
  - 纵向 = 换更大的机器(32-64GB Mac Studio)。零代码,直接治内存,但有上限 + 单点。
  - 横向 = 多台机器。突破上限 + 隔离,但分布式复杂度大。
- **物理机 vs 云:** Annie 先物理机(安全考虑,自己买几台),成熟后考虑云端(FLY-559/648)。两条路的隔离/provision 手段不同。
- **「跑在哪台」(placement)vs「隔离多强」(sandbox):** 多机 = runner 跑在**哪台物理机**;FLY-346 沙箱 = runner 在一台机上被**隔离多强**(Docker)。正交,可组合(research §5)。

---

## 5. 显式假设

1. **额度不是瓶颈可通过多机解的** —— Claude 是订阅制、额度按账号算;多机不增加额度。若真瓶颈是额度,答案是「加账号/加 codex fallback」不是「加机器」。(research 会验证瓶颈到底是不是内存。)
2. **Discord 控制面已经解耦、可跨机复用** —— Bridge 只出站连 Discord,不需要公网入站;每台机器可独立连 Discord。(codebase 已确认。)
3. **runner↔Bridge 控制通道「半 HTTP」** —— stage/complete/heartbeat/events 已走 HTTP(`FLYWHEEL_BRIDGE_URL` + `FLYWHEEL_INGEST_TOKEN` 注入 runner env);但 ask/gate 问答态 + mailbox wake 仍走本地 CommDB,阶段1 需路由到 hub。(codebase 已确认,见 research §1.3。)
4. **Annie 的物理机场景是「自己的几台 Mac + 可能一台 Windows」**,不是先上云;安全/隔离是她说的主因。
5. **本任务产出 = 诚实 research + 分阶段 PRD 草案**;最终主线由 Annie 拍板后 Lead 再收(已与 Lead 确认,这是她点名最重要的方向)。

---

## 6. 初步 thesis(将在 research 论证,非预设)

> 多机**值得做,但不是主要为了治内存** —— 治内存最便宜的是先换台大机器(阶段0)。多机真正不可替代的价值是**隔离/爆炸半径 + 无上限横向 scale + 异构放置**,这些随 fleet 变大和「对外/不可信 agent(如 Anna 访谈 bot)」到来而变成硬需求。推荐**分阶段**:阶段0 换大机救急 → 阶段1 最小 remote-runner(单 Bridge brain + StateStore 留主机 + 无状态卫星 runner,复用已有 HTTP 通道 + Tailscale 内网,刻意回避跨机 StateStore 一致性)→ 阶段2 沙箱+云。这正是 homerail 的架构。

---

## 关联

FLY-555(父 epic)· FLY-556/557/558/561(子)· FLY-517(driver)· FLY-519(provision,done)· FLY-17(relay 草案)· FLY-346(沙箱)· FLY-353(session-log)· FLY-916(树/纵轴)· FLY-648/559(可移植/云)· FLY-287/215(Lead scale)
