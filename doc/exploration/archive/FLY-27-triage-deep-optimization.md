# Exploration: Triage Deep Optimization — FLY-27

**Issue**: FLY-27 (Triage 深度优化)
**Date**: 2026-03-30
**Status**: Draft
**Depends on**: FLY-21 (PR #85, 基础查询优化)

## Background

FLY-21 把 Simba 的 3 次 HTTP 调用合并为 1 次，加了可选 slim mode。但 benchmark 发现 Bridge API 只占 300-600ms，12 分钟中 99.9% 是 Simba 的 LLM 处理时间。

Annie 要求两个追加优化方向，目标是大幅缩减 LLM 处理量。

## 优化方向 1: HTML 模板 — 避免 LLM 从零写 HTML

### 问题分析

Simba 当前生成 HTML 报告的流程：
1. LLM 从零写 ~300 行 HTML + CSS（暗色主题、响应式、分组卡片、Linear hyperlink）
2. 每次 triage 都重新生成全部 CSS + HTML 结构
3. 仅数据部分（issue 列表、分组结果）是变化的

**预估耗时**: ~4 分钟写 HTML（占总 triage 的 ~33%）

### 方案

提供一个 **静态 HTML 模板**，Simba 只负责填充数据部分。

#### 模板存放位置

| 方案 | 路径 | 优点 | 缺点 |
|------|------|------|------|
| A. GeoForge3D 共享目录 | `.lead/shared/triage-template.html` | Simba 可直接 `cat` 读取，版本控制 | 只有 GeoForge3D 能用 |
| B. Bridge API 提供 | `GET /api/triage/template` | 多项目复用 | 需要新端点，过度工程 |
| **C. agent.md 内嵌** | `cos-lead/agent.md` HTML section | 零额外文件/端点，Simba 启动时自动加载 | agent.md 会更长（~100 行 HTML） |

**推荐方案 A**: 独立文件，Simba 启动时 `cat` 读取。理由：
- 模板 ~200 行，放 agent.md 太长
- 独立文件方便迭代 CSS（不用改 agent.md）
- `.lead/shared/` 已经是跨 Lead 共享的约定位置

#### 模板设计

模板应该是一个**带占位符**的完整 HTML 文件，Simba 只需要替换数据区域：

```html
<!-- .lead/shared/triage-template.html -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Triage — {{DATE}}</title>
  <style>
    /* 完整的暗色主题 CSS，对齐 pm-triage 的设计语言 */
    /* 但适配 Simba 的分组：马上做 / 本周完成 / 进行中 / Backlog */
  </style>
</head>
<body>
  <h1>📋 Triage — {{DATE}}</h1>
  
  <!-- Simba 替换以下内容 -->
  {{TRIAGE_CONTENT}}
  
</body>
</html>
```

**Simba 的工作量**从"写 300 行 HTML"变为"生成 ~50 行纯数据 HTML 片段"。

#### CSS 设计对齐

从 `pm-triage` skill 提取关键设计要素：
- 暗色背景 `#1a1a2e`，白色文字 `#eee`
- 品牌深蓝 `#1a365d` 用于强调
- 优先级色：red=Urgent, amber=High, blue=Medium, gray=Low
- 状态标签：In Progress (blue), Todo (gray), Backlog (light gray)
- 分组卡片带左边框色（红/黄/蓝/灰）
- 响应式 `max-width: 800px; margin: auto`
- Issue ID 等宽字体
- Linear hyperlink 可点击

#### Agent.md 更新

Simba 的 triage Step 4a 从"你自己生成 HTML"改为：

```
1. cat .lead/shared/triage-template.html → 获取模板
2. 生成数据 HTML 片段（只有 <div> 列表，无 CSS）
3. 用模板包裹数据片段
4. POST 到 /api/publish-html
```

### 预期收益

| 指标 | Before | After |
|------|--------|-------|
| LLM HTML 生成量 | ~300 行 (CSS+结构+数据) | ~50 行 (纯数据片段) |
| 预计节省时间 | — | ~3 分钟 |
| 视觉一致性 | LLM 每次略有差异 | 100% 一致 |

### 风险

- Simba 可能不精确遵守占位符替换指令 → 需要明确的 agent.md 指令
- 模板更新需要 GeoForge3D PR → 但 CSS 改动很少

---

## 优化方向 2: Scope 优化 — 减少 Issue 数量

### 问题分析

当前 triage 查询：`state=backlog,unstarted,started`，拉取 project=GeoForge3D 的全部 issue。

实际数据分布（基于 benchmark）：
- 总数 61 个 issue
- 其中 Backlog + Low priority: **~30 个**（长期积压的低优先级 issue）
- In Progress: ~5 个（已在运行中的）
- Urgent/High priority: ~15 个（真正需要 triage 的）

**问题**：Simba 每次都要 LNO 分类全部 61 个 issue，但低优先级 Backlog issue 几乎不会进入"马上做"/"本周完成"。

### 方案

#### 方案 A: Bridge 端预过滤（推荐）

在 `/api/triage/data` 添加 **priority 过滤参数**：

```
GET /api/triage/data?project=GeoForge3D&priority=urgent,high
```

Linear GraphQL 支持 priority filter：
```graphql
filter: {
  priority: { lte: 2 }   // 1=Urgent, 2=High
}
```

同时，对 In Progress 状态不做 priority 过滤（已经在跑的不管优先级都要显示）。

**实现思路**：
```
GET /api/triage/data?project=GeoForge3D
```

加入新的 triage-specific filter 逻辑（二选一）：

**子方案 A1: 单查询 + 复合 filter**
```graphql
filter: {
  or: [
    { state: { type: { eq: "started" } } },                              // In Progress: 全部
    { state: { type: { in: ["backlog", "unstarted"] } }, priority: { lte: 2 } }  // 非 In Progress: 只拉 Urgent+High
  ]
}
```

优点：一次 GraphQL 调用。缺点：Linear GraphQL `or` 的嵌套支持需要验证。

**子方案 A2: 双查询合并**
```
Promise.all([
  queryLinearIssues({ states: ["started"] }),                           // In Progress 全部
  queryLinearIssues({ states: ["backlog", "unstarted"], priority: 2 })  // 其他只拉 Urgent+High
])
```

优点：简单可靠。缺点：两次 Linear API 调用。

**子方案 A3: 保持单查询 + 新参数**
```
GET /api/triage/data?project=GeoForge3D&minPriority=high
```

给 `queryLinearIssues` 加 `minPriority` filter，直接在 GraphQL filter 里加 `priority: { lte: N }`。

但 In Progress 的 issue 需要全部返回不管 priority。这意味着需要两种 filter 逻辑，A1 或 A2 的问题又出现了。

**推荐 A2**: 简单可靠。两次 Linear API 调用都走 Promise.all，总耗时不会增加。

#### 方案 B: Simba 端过滤（不推荐）

保持查询不变，在 agent.md 里告诉 Simba "跳过 Low priority Backlog issue"。

- 问题：LLM 仍然要读完全部 61 个 issue 才能判断哪些跳过
- 传输 payload 不变
- 与方向 1 不冲突但收益更小

#### 方案 C: 新参数 `triageMode`（远期）

```
GET /api/triage/data?project=GeoForge3D&triageMode=focused
```

Bridge 端内置"triage 智能过滤"逻辑：
- `triageMode=focused`: In Progress 全部 + 非 In Progress 只拉 Urgent/High
- `triageMode=full`: 现有行为不变

优点：Simba agent.md 不需要改 filter 参数，一个 flag 搞定。缺点：业务逻辑泄漏到 Bridge。

### 推荐方案

**方案 A2**：`/api/triage/data` 添加 `minPriority` 参数。当 `minPriority=high` 时：
- 内部执行两个 Linear 查询 (Promise.all)
- Query 1: `state=started` (In Progress, 无 priority 过滤)
- Query 2: `state=backlog,unstarted` + `priority <= 2` (Urgent+High)
- 合并去重后返回

Simba agent.md 更新调用为：
```bash
curl -s -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
  "$BRIDGE_URL/api/triage/data?project=GeoForge3D&minPriority=high"
```

### 预期收益

| 指标 | Before | After |
|------|--------|-------|
| Issue 数量 | ~61 | ~20 |
| LLM 输入 token 减少 | — | ~65% |
| LLM 分类耗时 | ~6 分钟 | ~2 分钟 |

### 风险

- Annie 偶尔可能想看低优先级 issue → `minPriority` 是可选参数，默认不过滤
- Linear GraphQL priority filter 语法需要验证 → research 阶段确认
- Simba 需要知道"有些 issue 被过滤了"，避免汇报"只有 20 个 issue"时让 Annie 困惑 → response 加 `filtered: true` 标记

---

## 两个方向的叠加效果

| 阶段 | 时间 (Before) | 时间 (After 方向 1+2) | 改善 |
|------|--------------|---------------------|------|
| HTTP 调用 | ~1s (已优化) | ~1s | — |
| LLM 读取 issue 数据 | ~2 分钟 (61 issues) | ~40 秒 (20 issues) | -60% |
| LLM 分类+分析 | ~4 分钟 | ~1.5 分钟 | -62% |
| LLM 生成 HTML | ~4 分钟 | ~1 分钟 (只填数据) | -75% |
| LLM 生成 Discord 报告 | ~1 分钟 | ~1 分钟 | — |
| **总计** | **~12 分钟** | **~4-5 分钟** | **~60% 提升** |

## 实施范围

### 方向 1 (HTML 模板)

| 文件 | 变更 |
|------|------|
| `GeoForge3D/.lead/shared/triage-template.html` | 新建：完整 HTML+CSS 模板 |
| `GeoForge3D/.lead/cos-lead/agent.md` | 更新 Step 4a：模板填充流程 |

**无 Flywheel 代码变更**。纯 GeoForge3D agent 配置改动。

### 方向 2 (Scope 优化)

| 文件 | 变更 |
|------|------|
| `packages/teamlead/src/bridge/linear-query.ts` | 添加 `minPriority` filter |
| `packages/teamlead/src/bridge/triage-data-route.ts` | 双查询逻辑 + `minPriority` param |
| `packages/teamlead/src/__tests__/triage-data.test.ts` | 新增 minPriority 测试 |
| `packages/teamlead/src/__tests__/linear-issues.test.ts` | 新增 priority filter 测试 |
| `GeoForge3D/.lead/cos-lead/agent.md` | 更新 Step 1 查询参数 |

## Open Questions for Annie

1. **模板位置**: `.lead/shared/triage-template.html` 可以吗？还是放其他位置？
2. **Scope 过滤规则**: "Urgent + High 的所有状态 + In Progress 的所有 priority"对吗？Medium priority 的 Backlog/Todo 是否也要排除？
3. **两个方向的优先级**: 先做哪个？还是同一个 PR 一起做？
4. **`minPriority` 默认值**: 默认不过滤（向后兼容），还是 triage 端点默认开启过滤？
