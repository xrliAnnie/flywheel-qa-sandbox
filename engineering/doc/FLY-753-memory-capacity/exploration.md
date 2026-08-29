# FLY-753 Swap/内存容量测算 — 探索

Issue: FLY-753 (https://linear.app/geoforge3d/issue/FLY-753/infraresearch-swap内存容量测算-现在能并发几个-session100-session-需多大内存什么机器配置)
日期: 2026-07-01
基于: 无

## 1. 问题

Annie 的机器(48GB / 18 核 Mac)现在 ~20 个 session 就吃满了 ~14GB swap,系统开始抖。需要算清:

1. **每个 session 真实占多少内存**?拆开算:Claude 主进程(1M-context vs 小 context)+ MCP 子进程套件。
2. **当前 48GB 最多稳定并发几个**(不进 swap / 轻度 swap)?
3. **要跑 100 个 session**:当前 footprint 需多大内存?优化后需多大?机器配置建议(优化前 vs 优化后)。
4. 结论要**可决策**。

Annie 在 brainstorm gate 追加了一条(现在是重点):**把所有 MCP 套件全部列一遍,帮她判断哪些根本用不到、可以直接删。**

## 2. 关键假设(实测前先摆明)

| # | 假设 | 验证方式 |
|---|------|---------|
| A1 | 内存大头是 Claude 的 context(尤其 1M-context) | ❌ 实测推翻 — 见 research.md,大头是 MCP 套件 |
| A2 | 每 session ≈ 1 Claude + ~10 MCP 子进程 | ✅ 实测证实(~15 个进程,含 npx wrapper) |
| A3 | RSS 能代表真实内存占用 | ⚠️ 部分 — RSS 漏算压缩/swap 页,改用 `phys_footprint` |
| A4 | 100 session 的瓶颈只是内存 | ⚠️ 不完全 — active-burst 时 CPU load 也是硬顶(历史 WindowServer panic) |

## 3. 方法学决策:为什么用 phys_footprint 而不是 RSS

- **RSS**(Resident Set Size)= 此刻常驻物理 RAM 的页。在内存吃紧的机器上,大量空闲页被压缩器/swap 拿走 → RSS **低估**真实内存需求;且跨进程重复计算共享库。
- **phys_footprint** = macOS 给进程记的"逻辑私有内存"账(脏页 + 压缩页 + swap 页,排除共享库)= Activity Monitor 里的 **Memory 列**。这才是"这个进程的数据要占多少内存,不管它现在躺在 RAM 还是 swap"。
- **结论**:capacity planning 用 phys_footprint。它衡量的是"必须由 RAM+swap 承载的逻辑内存需求",正是决定何时开始抖的量。

## 4. 交付物

1. `research.md` — 测量方法 + 完整数据 + **MCP 全清单与删除判断** + 容量数学
2. `plan.md` — 可决策建议(删除清单 + 机器配置优化前/后 + 路由到 FLY-751/752 的实施项)
3. **Apple-light HTML 报告** — 给 Annie 看(以 MCP 删除清单 + 优化前后对照 + 机器建议为中心)

## 5. 关联

- **FLY-751** — footprint 优化(小 context 默认 + 共享/按需 MCP)。本研究给它量化的 target。
- **FLY-752** — auto-QA 重设计(最大 spawn 源)。100-session 场景的主要并发来源。
- **FLY-581** — 全局装 chrome-devtools-mcp + 评估 vs Claude-in-Chrome(本研究证明 chrome-devtools 是最重的单项 MCP)。
