# Research: Linear Query API + Discord Report Format — GEO-276

**Issue**: GEO-276
**Date**: 2026-03-28
**Source**: `doc/exploration/new/GEO-276-pm-auto-triage.md`

---

## 1. Linear SDK Issue Query

### 现有 Bridge 模式

Bridge 已用 `@linear/sdk` 做三件事（全部 `await import()` 延迟加载）：
- `plugin.ts`: `POST /api/linear/create-issue` — `client.createIssue()`
- `plugin.ts`: `PATCH /api/linear/update-issue` — `client.updateIssue()`
- `runs-route.ts`: Pre-flight check — `client.issue(issueId)`

模式一致：`await import("@linear/sdk")` → `new LinearClient({ apiKey })` → 调用方法。

### `client.issues()` 查询 API

```typescript
const issues = await client.issues({
  first: 100,          // 每页最多
  orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
  filter: {
    // 按状态类型（backlog/started/completed/canceled）
    state: { type: { eq: "backlog" } },
    // 按 label 名称
    labels: { name: { eq: "Product" } },
    // 按优先级（1=Urgent, 2=High, 3=Medium, 4=Low, 0=None）
    priority: { lte: 2 },
    // 按 project
    project: { id: { eq: "project-uuid" } },
  },
  after: cursor,       // 分页游标
});
```

**返回 `IssueConnection`**:
```typescript
{
  nodes: Issue[],     // 当页数据
  pageInfo: {
    hasNextPage: boolean,
    endCursor: string,
  }
}
```

### Issue 字段

每个 Issue node 包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID |
| `identifier` | string | `GEO-276` |
| `title` | string | Issue 标题 |
| `description` | string? | Markdown 描述 |
| `priority` | number | 0-4 (0=None, 1=Urgent) |
| `url` | string | Linear web URL |
| `createdAt` | Date | 创建时间 |
| `updatedAt` | Date | 更新时间 |
| `state` | async → WorkflowState | 需要 await，包含 name/type |
| `labels()` | async → LabelConnection | 需要 await，返回 nodes |
| `assignee` | async → User? | 需要 await |
| `project` | async → Project? | 需要 await |

**关键注意**: `state`、`labels()`、`assignee` 是 **async 属性**，需要额外 API 调用。对于 Bridge 端点，我们应该用 **GraphQL rawRequest** 一次获取所有需要的字段，避免 N+1 查询。

### 推荐：GraphQL rawRequest

```typescript
const result = await client.client.rawRequest(`
  query ListIssues($filter: IssueFilter, $first: Int) {
    issues(filter: $filter, first: $first, orderBy: updatedAt) {
      nodes {
        id
        identifier
        title
        description
        priority
        url
        createdAt
        updatedAt
        state { name type }
        labels { nodes { name } }
        assignee { name }
        project { name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`, { filter, first });
```

**优点**: 单次请求获取所有字段，无 N+1 问题。
**缺点**: 需要手写 GraphQL query string。

### 按 Project 过滤

两种方式：
1. `filter: { project: { id: { eq: "uuid" } } }` — 需要 project UUID
2. `filter: { project: { name: { eq: "Flywheel" } } }` — 按名称

项目 Flywheel UUID: `764d7ab4-9a3b-43ea-99d9-7e881bb3b376`

### 分页策略

Flywheel backlog 当前 ~20-30 个 issue，`first: 100` 单页足够。
如果未来增长，支持 `after` cursor 分页。Phase 1 不需要复杂分页。

---

## 2. Discord 消息长度限制

| 限制 | 值 |
|------|-----|
| 消息正文 | **2,000 字符**（Nitro: 4,000） |
| Embed 数量 | 10 per message |
| Embed title | 256 字符 |
| Embed description | 4,096 字符 |
| Embed fields | 最多 25 个 |
| Field name | 256 字符 |
| Field value | 1,024 字符 |
| 所有 embed 总字符 | **6,000 字符** |

### Triage Report 格式策略

**方案：纯文本 + Markdown（推荐 Phase 1）**

Discord Markdown 支持表格吗？**不支持**。Discord 不渲染 Markdown 表格。

最佳格式：**有序列表 + 代码块对齐**

```
📋 Triage 报告 — 2026-03-28
Backlog: 15 个 issue (Product 10 / Operations 5)
当前运行中: 2 个 session

🔴 Leverage (直接推进 North Star)
1. GEO-280 Sprint 收尾 — Runner post-merge 自动关闭 [Product] P1
2. GEO-285 Context Window 管理 — Lead auto-compact [Product] P2

🟡 Neutral
3. GEO-283 Discord typing indicator [Product] P3
4. GEO-264 Bot Token 管理 [Product] P3

⚪ Overhead (当前不做)
5. GEO-150 Voice Interface — 暂不需要

建议先做 #1 #2，容量够再排 #3。
需要你确认或调整。@Peter @Oliver 有意见吗？
```

**字符预估**: 每个 issue 约 60-80 字符，30 个 issue ≈ 2,400 字符 → 需要分 2 条消息。

**分页策略**: 如果超过 1,800 字符，自动拆分：
- 消息 1: 概况 + Leverage
- 消息 2: Neutral + Overhead + 建议

---

## 3. Bridge 端点设计

### `GET /api/linear/issues`

**Query Parameters**:

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `project` | string | — | Project 名称 (e.g., "Flywheel") |
| `state` | string | — | 状态类型: backlog/started/completed/canceled，逗号分隔 |
| `labels` | string | — | Label 名称，逗号分隔 |
| `limit` | number | 100 | 最多返回数量 |

**Response**:
```json
{
  "issues": [
    {
      "id": "uuid",
      "identifier": "GEO-280",
      "title": "Sprint 收尾流程",
      "description": "...",
      "priority": 2,
      "priorityLabel": "High",
      "state": "Backlog",
      "stateType": "backlog",
      "labels": ["Product"],
      "assignee": null,
      "url": "https://linear.app/...",
      "createdAt": "2026-03-20T...",
      "updatedAt": "2026-03-28T..."
    }
  ],
  "total": 15
}
```

**实现要点**:
- 用 GraphQL rawRequest 避免 N+1
- `linearApiKey` 已在 config 中，复用现有 pattern
- 认证沿用 `tokenAuthMiddleware`
- 无 `linearApiKey` 时返回 501

### 与现有端点对比

| 端点 | Method | 场景 |
|------|--------|------|
| `create-issue` | POST | Bridge 创建 issue |
| `update-issue` | PATCH | Bridge 更新 issue |
| **`issues` (新)** | GET | **Lead 查询 backlog** |

---

## 4. Simba Agent 行为设计

### 触发词

Simba 在 #geoforge3d-core 或 ops/product chat 看到以下消息时触发 triage：
- "Simba, triage" / "triage"
- "看看 backlog" / "有什么要做的"
- "帮我排个优先级"

### Triage 工作流

1. **查询 Linear** — `curl $BRIDGE_URL/api/linear/issues?project=Flywheel`
2. **查询当前状态** — `curl $BRIDGE_URL/api/sessions` + `curl $BRIDGE_URL/api/runs/active`
3. **LNO 分类** — 根据 agent.md 中的 North Star 和标准
4. **ICE 打分** — 仅对 Leverage 项打分 (Impact x Confidence x Ease, 1-10)
5. **格式化报告** — 按模板生成 Discord 消息
6. **发送** — 在 #geoforge3d-core 发送，@Peter @Oliver 征求意见
7. **等待 CEO 确认** — CEO 说 "OK" / "改 XX" / "加 YY"
8. **分配** — 按 label 发到各 Lead 的 chat channel

### 分配消息格式

```
CEO 确认了今日 triage，分配给你：

1. GEO-280 Sprint 收尾 — Runner post-merge 自动关闭
2. GEO-285 Context Window 管理

请按优先级顺序启动 Runner。
```

---

## 5. 技术决策总结

| 决策 | 选择 | 理由 |
|------|------|------|
| Linear 数据获取 | Bridge GraphQL rawRequest | 避免 N+1，复用 linearApiKey |
| Report 格式 | 纯文本 Markdown | Discord 不支持表格，纯文本最可靠 |
| 超长 report | 自动拆分多条消息 | 2,000 字符限制 |
| Triage 逻辑 | Agent.md 内嵌 | Phase 1 最简，Claude 擅长分类 |
| 分配方式 | Discord MCP → Lead chat channel | 现有能力，无需新建 |
