# FLY-753 Swap/内存容量测算 — 实施计划(建议)

Issue: FLY-753 (https://linear.app/geoforge3d/issue/FLY-753/infraresearch-swap内存容量测算-现在能并发几个-session100-session-需多大内存什么机器配置)
日期: 2026-07-01
基于: research.md

> 这是 research 任务,"实施"= 产出可决策结论 + 给 Annie 的 HTML 报告 + 把行动项路由到已有 issue(FLY-751/752/581)。**本任务不改任何生产代码**;删除/降级 MCP 的落地由 FLY-751 执行(需 Annie 拍板具体删哪些)。

## 1. 给 Annie 的可决策结论

> **想稳定跑 100 个 session,两条路:**
> - **换机器**:不优化 → 256 GB 内存的 Mac Studio(~$7–8k)。
> - **砍 footprint(推荐,先做)**:把每 session 从 1.4 GB 砍到 ~0.4 GB(删 audible/pencil、浏览器 MCP 改 QA 按需、serena/context7 改共享、Runner 不挂 discord)→ **96 GB 机器就够跑 100 个**;连现在这台 48GB 都能从 ~18 提到 ~40–50 个。
> - **最省**:两个都做 → 96 GB 机器 + 优化,100 session 舒适有余。

**当下最痛的 swap 抖动**:不用换机器,先删/降级 MCP,当前 48GB 并发上限 ~18 → ~40,直接缓解。

## 2. MCP 删除 / 降级清单(交给 FLY-751 落地,Annie 逐项拍)

| 动作 | MCP | 省/session | 落地位置 | 风险 |
|------|-----|-----------|---------|------|
| ⛔ 删 | audible / pencil / bambu-h2d | ~69 MB | 从 Runner/Lead 继承的 MCP 配置中移除 | 无(eng 零用) |
| 🔄 QA 按需 | chrome-devtools / playwright | ~422 MB | Runner 默认 MCP 不含,仅 QA 角色注入 | 需确认非 QA Runner 真不开浏览器 |
| 🔀 共享单例 | serena / context7 | ~323 MB | 机器级共享 MCP,而非每 session 一份 | 需 FLY-751 支持共享 MCP 架构 |
| 🔀 仅 Lead | discord | ~120 MB(Runner) | Runner 启动配置去掉 discord 插件 | 确认 Runner 无直连 Discord 需求(应无,走 relay) |
| 🔀 确认后移出 | gbrain | 76 MB | 确认 gbrain 是内容侧,非 eng 依赖 | 低 |
| ✅ 保留 | terminal-mcp / inbox-mcp / linear-api | — | Flywheel 核心 | — |

**保守首刀(零风险,立即可做)**:删 audible + pencil + Runner 去 discord ≈ 省 ~190 MB/session。
**大刀(需 FLY-751 架构支持)**:浏览器 QA-按需 + serena/context7 共享 ≈ 再省 ~745 MB/session。

## 3. 机器配置建议(优化前 vs 优化后)

| 目标 | 优化前 | 优化后(推荐) |
|------|-------|--------------|
| 跑 100 session | Mac Studio 256 GB / 24–32 核(~$7–8k) | Mac Studio 96 GB / M2·M3 Max |
| 当前 48GB 机器上限 | ~18 个 | ~40–50 个 |

## 4. 路由到其他 issue

- **FLY-751**(footprint 优化)← 本研究给出量化 target:per-session 1.4 → 0.4 GB;删除清单见 §2。
- **FLY-752**(auto-QA 重设计,最大 spawn 源)← 100-session 主要并发来源;QA session 才是唯一真需要浏览器 MCP 的,重设计时把浏览器 MCP 收进 QA-only 路径。
- **FLY-581**(全局 chrome-devtools-mcp 评估)← 本研究实证 chrome-devtools 是最重单项 MCP(272 MB/session);评估结论应含"默认不挂、QA 按需"。

## 5. 交付

- ✅ exploration.md / research.md / plan.md(本三件)
- ⏳ Apple-light HTML 报告(给 Annie),以删除清单 + 优化前后对照 + 机器建议为中心 → 经 `founder-html-delivery` 发布并直接打开给 Annie。

## 6. 明确不做

- 不改生产代码(不动 MCP 配置、不动 Runner 启动)。删除动作是 FLY-751 的活,且要 Annie 逐项确认。
- 不做真机"删了再测"验证(那属于 FLY-751 实施验收)。本研究止于测量 + 建议。
