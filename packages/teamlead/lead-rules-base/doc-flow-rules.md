# Doc-Flow：难度判档 + 知会义务（FLY-205 base layer）

> **适用条件（先自查，不满足则本文件整体无效）**：
> 本规则只对启用了 doc-flow 的项目生效。判定方法：读
> `$FLYWHEEL_PROJECT_DIR/.flywheel/config.yaml`，其中存在
> `doc_flow:` 块且 `enabled: true` 才适用。
> `$FLYWHEEL_PROJECT_DIR` 环境变量缺失、文件不存在、或 `enabled` 不为
> true —— 一律视为**未启用**：本文件零行为变化，按你原有流程 spawn，
> 不传 docTier、不发知会消息（fail-safe）。
>
> 本文件是 base 层（抽象行为约定），随 Flywheel 升级演进；项目侧数据
> （部门名、频道）来自项目配置。

## 你的职责

启用 doc-flow 的项目里，每次 spawn Runner 前你要做两件事：

1. **判档**：按 issue 难度判定文档档位（三档，见下）
2. **知会**：中等与简单档必须在你的部门 chat 频道发一条知会消息（格式见下）

Runner 侧的文档产出指令由 Bridge 按你传的档位自动注入，你不需要教 Runner 怎么写文档。

## 三档判定标准

| 档位 | docTier 值 | 什么样的 issue | 文档产出 |
|------|-----------|---------------|---------|
| 复杂 | `full` | 新架构 / 跨系统 / 多文件改动 / 风险未知 / 你说不清它会碰到什么 | exploration + research + plan 三份齐全 |
| 中等 | `plan_only` | 边界清楚的已知形态改动（改动面明确、不碰陌生子系统）| 只写 plan（Codex 设计审查照跑）|
| 简单 | `none` | 琐碎修复 / 文案改动 / 配置一行 / 半小时内能完的活 | 零文档直接实现 |

**判不准 → 往高档判**（宁多勿漏）。docTier 只控制文档产出 ——
brainstorm gate、approve gate、executor 自带的硬性确认环节**任何档位都照常执行**，
不因 `none` 而跳过。

## Spawn 传参

`POST /api/runs/start` 的 body 里带 `docTier` 字段：

```json
{ "issueId": "...", "projectName": "...", "leadId": "<your-agentId>", "docTier": "plan_only" }
```

合法值：`"full"` / `"plan_only"` / `"none"`。不传 = `full`（系统缺省，宁多勿漏）。
判为复杂档时可以不传（缺省即 full），但建议显式传，留下判档记录。

## 知会义务（中等 + 简单档，缺一不可）

**时机**：spawn 的同时发（不等 Annie 回复，Runner 直接开干）。
**位置**：你的部门 chat 频道顶层。
**格式**（两档同构，注明档位）：

```
LEARN-25 播放列表重排 — 判档:简单,跳过文档,Runner 直接实现。
理由:纯重排序,不碰数据结构,半小时的活。有异议回这条。
```

```
LEARN-31 按键映射修复 — 判档:中等,只写 plan。
理由:改动面清楚(单文件映射表),不碰输入子系统其他部分。有异议回这条。
```

要素：issue 号 + 短标题、档位、一句话理由、"有异议回这条"。复杂档（full）不需要知会。

## Annie 否决处理

Annie **任何时候**回复你的知会消息（"补文档"、"走完整流程"等）：

1. 立即用你的 Runner 消息通路（`flywheel-comm send`）指示 Runner：
   暂停实现，先按要求的档位补齐文档（写进同一个 issue 文件夹），再继续。
2. 若 Runner 已经走到 needs_review：补的文档进**同一个 PR**，不开新 PR。
3. 回复 Annie 确认已安排（一句话即可）。

不回复 = 默认同意，正常推进。merge 永远等 founder 批准（FLY-175 不变，与本规则无关）。

## 非 spawn 角色

本文件只应被会 spawn Runner 的 dept lead 加载（claude-lead.sh 已按角色分支）。
若你是不 spawn Runner 的角色却读到了本文件：忽略全部内容。
