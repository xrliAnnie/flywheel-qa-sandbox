# Exploration: Lead Data Isolation — GEO-259

**Issue**: GEO-259 (Lead 查询 session 时应按 project + label 过滤)
**Date**: 2026-03-25
**Status**: Complete

## 问题本质

GEO-259 表面上是 "session 查询过滤" 问题，但根因更深：**Lead 的整个数据视野缺少默认 scope**。

Peter (Product Lead) 被问 "现在在跑的有哪些 issue" 时，返回了所有项目所有 Lead 的 session——这不是权限问题，是**噪音问题**。每个 Lead 日常应该只看到自己负责的 project + label 范围内的数据。

## 设计原则

1. **Noise reduction, not access control** — 不是 Lead "不能" 看其他数据，而是默认不需要看
2. **Default scope, optional override** — 带 leadId 参数就过滤，不带就返回全部
3. **向后兼容** — Dashboard / CEO 视角保持全局，现有不带参数的调用行为不变
4. **复用现有机制** — scope 定义来自 `projects.json` 的 `LeadConfig.match.labels`，过滤逻辑复用 `resolveLeadForIssue()`

## 现有隔离状态

### 已隔离 (不需要改动)

| 数据面 | 机制 |
|--------|------|
| Bootstrap (`/api/health/bootstrap/:leadId`) | 按 label routing 过滤 sessions/decisions/failures/events |
| Memory API (`/api/memory/*`) | project + agentId + userId 三重校验 |
| Forum Posts | per-Lead channel + bot token (GEO-252) |
| Forum Tags | per-Lead statusTagMap (GEO-253) |
| flywheel-comm | 消息按 `to_agent` 定向 |
| Lead Event Journal | `lead_events` 表按 `lead_id` 查询 |
| Runtime Registry | 每个 Lead 独立 runtime |

### 未隔离 (需要加默认过滤)

| 端点 | 现状 | 影响 |
|------|------|------|
| `GET /api/sessions` | 返回所有项目所有 Lead 的 session | **高** — Lead 查 session 状态时最常用 |
| `GET /api/sessions/:id/history` | 返回该 issue 所有 session 历史 | 中 — issue 可能跨 Lead |
| `GET /api/actions` / `POST /api/actions` | 可操作任何 session | 中 — Lead 可能误操作他人 session |
| `POST /api/threads/upsert` | 可绑定任何 thread | 低 — 内部调用为主 |
| `GET /api/thread/:thread_id` | 返回任意 thread 绑定 | 低 |
| `GET /api/resolve-action` | 可 resolve 任何 issue 的 action | 低 |
| `GET /sse` | 广播所有 session 状态变更 | 低 — Dashboard 用，给人看 |

### 保持全局 (不做 scope 过滤)

| 数据面 | 理由 |
|--------|------|
| Linear proxy (`/api/linear/*`) | 全局 API key 没问题，Lead 创建 issue 的场景不多 |
| Dashboard (`GET /`, `GET /health`) | CEO / 人类操作者看全局 |
| Discord guild ID | 全局配置 |
| CIPHER principles | 全局共享 |
| `POST /api/forum-tag` | 已通过 per-Lead bot token 隔离 |

## 方案选择

### Path A: Optional `leadId` query parameter (推荐)

所有需要过滤的端点加 `?leadId=xxx` 可选参数：
- 传了就按 Lead scope 过滤
- 不传就返回全部（向后兼容）
- Lead 的 agent file / TOOLS.md 里写明 "查询时带上 leadId"

**优点**: 简单、非破坏性、一个参数搞定
**缺点**: 依赖 prompt 规范，Lead 可能忘记带参数

### Path B: Per-Lead API token

每个 Lead 一个 token，Bridge 自动识别身份。

**优点**: 更 robust，Lead 不需要 "记得" 带参数
**缺点**: 增加配置复杂度（每个 Lead 多一个 token env var），对于噪音过滤来说 overkill

### 决策: Path A

噪音过滤不需要强制鉴权层。Path A 简单直接，与现有架构一致（Bootstrap 已经用 `:leadId` path param），复杂度最低。

## 过滤逻辑

### 核心函数：`matchesLead(session, leadId, projects, store)`

已存在于 `bootstrap-generator.ts`，逻辑：
1. 获取 session 的 labels（`store.getSessionLabels(execution_id)`）
2. 调用 `resolveLeadForIssue(projects, projectName, labels)`
3. 比较 resolved lead 的 `agentId` 是否匹配请求的 `leadId`

需要提取为公共函数，供所有 API 端点复用。

### Session Labels 来源

StateStore 的 `session_labels` 表存储每个 session 的 labels（在 session_started 事件时写入）。这是过滤的数据基础。
