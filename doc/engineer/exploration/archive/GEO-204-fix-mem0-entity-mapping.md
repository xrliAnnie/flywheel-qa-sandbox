# Exploration: Fix mem0 Entity Mapping — GEO-204

**Issue**: GEO-204 (Fix mem0 entity mapping — correct app_id/userId/agentId semantics)
**Date**: 2026-03-22
**Depth**: Standard
**Mode**: Technical
**Status**: final

## 0. Product Research

Product research skipped (Technical mode)

## 1. 问题分析

### 当前映射（继承自 v0.3，GEO-198 原样搬迁）

| mem0 字段 | 当前值 | 来源 |
|-----------|--------|------|
| `userId` (一等公民参数) | `projectName` (e.g., `"geoforge3d"`) | MemoryService 方法参数 |
| `app_id` (metadata/filter) | `"flywheel"` | MemoryService 内硬编码 |
| `agentId` (一等公民参数) | Lead agent ID (e.g., `"product-lead"`) | API 请求传入 |
| `runId` | `executionId` | 仅 `addSessionMemory()` |

### mem0 官方语义（Context7 verified — `/mem0ai/mem0`）

| 字段 | 官方语义 | 示例 |
|------|----------|------|
| `app_id` | **应用/产品** — 白标部署或不同产品线 | `"concierge_app"` |
| `user_id` | **个人用户** — 跨所有交互持久化的个人偏好 | `"traveler_cam"` |
| `agent_id` | **AI 角色** — 不同 AI 角色需要独立上下文 | `"travel_planner"` |
| `run_id` | **临时会话** — 应被隔离的单次 session | `"tokyo-2025-weekend"` |

### 语义错误

1. **`app_id: "flywheel"`** — Flywheel 是平台，不是应用。被管理的项目（GeoForge3D）才是 "应用"
2. **`userId: projectName`** — 项目名不是用户。真正的用户是 CEO（Annie）
3. **`agentId`** — 正确 ✅

### 应有映射

| 字段 | 新值 | 理由 |
|------|------|------|
| `app_id` | `projectName` (e.g., `"geoforge3d"`) | 被管理的项目 = mem0 语义中的 "应用" |
| `userId` | 人类用户标识 (e.g., `"annie"`) | CEO 是真正的 "用户" |
| `agentId` | Lead agent ID ✅ | 不变 |

## 2. 影响文件和代码位置

| 文件 | 影响 | 具体位置 |
|------|------|----------|
| `packages/edge-worker/src/memory/MemoryService.ts` | **核心修改** | `searchMemories()` L135-139, `addMessages()` L178-185, `addSessionMemory()` L97-106 |
| `packages/teamlead/src/bridge/memory-route.ts` | **API 参数** | L57, L123 — 传递 `projectName` 到 MemoryService |
| `packages/edge-worker/src/memory/types.ts` | 可能 | 如果需要新增 config 字段 |
| `packages/edge-worker/src/__tests__/MemoryService.test.ts` | 测试更新 | 所有用到 `userId`/`app_id` 的 mock 断言 |
| `packages/teamlead/src/__tests__/memory-route.test.ts` | 测试更新 | 所有 mock 验证的参数 |
| Supabase `memories` 表 | **数据迁移** | 现有记录的 `app_id` 和 `user_id` 字段 |

### 死代码发现

**`addSessionMemory()`** — GEO-198 从 Blueprint 移除 mem0 后，生产环境无任何代码调用此方法。仅存在于测试文件中。

调用方检索：
- `packages/edge-worker/src/__tests__/MemoryService.test.ts` (单元测试)
- `packages/edge-worker/src/__tests__/memory-e2e.test.ts` (E2E 测试)
- `packages/edge-worker/src/__tests__/memory-supabase-live.test.ts` (live 测试)

生产代码 **零调用**。

### `createMemoryService()` 的 `projectName` 参数

`index.ts` 和 `run-bridge.ts` 都传 `projectName: "bridge"`，但此参数 **仅用于 history DB 路径**（`~/.flywheel/memories/bridge/history.db`），与 mem0 entity 映射无关。不需要修改。

## 3. Architecture Constraints

### mem0 JS OSS SDK 限制

- `app_id` **不是** JS SDK 的一等公民参数（不像 `userId`, `agentId`）
- `app_id` 通过 `metadata` 写入，通过 `filters` 查询
- 这意味着 `app_id` 的隔离依赖 filter 正确性，不像 `userId`/`agentId` 有 SDK 级别的强隔离

### 搜索隔离策略

当前：`filters: { app_id: "flywheel" }` — 所有项目的记忆混在一起（因为 `app_id` 统一是 "flywheel"）
修复后：`filters: { app_id: projectName }` — 按项目自然隔离

### API 调用者

Bridge Memory API 的调用者是 OpenClaw Lead agents（product-lead, ops-lead）。它们通过 Discord 与 CEO 交互，**已经知道** agent_id 和 project context。需要新增传入 `user_id` 的能力。

## 4. Options Comparison

### Option A: API-Driven user_id（推荐）

**Core idea**: 在 API contract 中新增 `user_id` 字段，让 Lead agent 传入实际用户标识。

**变更清单**:

1. **MemoryService**: 所有方法的 `userId` 参数从 `projectName` 改为新的 `userId` 参数；`app_id` 从 `"flywheel"` 改为 `projectName`
2. **memory-route.ts**: API request body 新增 `user_id` 字段（required non-empty string），传递给 MemoryService
3. **addSessionMemory()**: 决定保留或删除（死代码）
4. **测试**: 更新 mock 断言
5. **数据迁移**: Supabase SQL 更新现有记录

**Pros**:
- 完全对齐 mem0 官方语义
- 多用户 ready — 未来多人管理同一项目时天然隔离
- Lead agent 已经有 Discord 用户上下文，传入 `user_id` 很自然

**Cons**:
- API breaking change（新增 required field）
- Lead agent 的 TOOLS.md 需要更新

**Effort**: Small（~2-3 小时）

### Option B: Config-based user_id（简单但有限）

**Core idea**: 通过环境变量 `FLYWHEEL_CEO_ID` 或 projects.json 配置提供 user_id，API 不变。

**变更清单**:

1. **MemoryService**: 构造函数新增 `defaultUserId` 配置；方法内部 `userId` 使用此配置值
2. **memory-route.ts**: 不变（仍传 `project_name`）
3. **createMemoryService()**: 接受 `defaultUserId` 参数

**Pros**:
- API 不变，Lead agent 不需要改
- 改动量最小

**Cons**:
- 硬编码假设单用户
- 无法区分多个操作者
- 与 mem0 语义不完全对齐（userId 应该由调用者决定，不是服务端配置）

**Effort**: Small（~1-2 小时）

### Recommendation: Option A

变更量差异很小，但 Option A 的语义正确性和扩展性明显更好。Lead agent 在 Discord 场景中天然有用户上下文，传 `user_id` 是零成本的。

## 5. Clarifying Questions

### Scope

Q1: `addSessionMemory()` 是死代码。删除还是保留？
- 删除：减少维护负担，entity mapping 只需改 2 个方法
- 保留：如果未来 runner 需要重新记录 session memory

### API Design

Q2: `user_id` 在 API 中是 required 还是 optional with fallback？
- Required: 强制调用者提供，语义最清晰
- Optional with fallback (e.g., `"anonymous"`): 向后兼容，但可能产生无用记忆

### Data Migration

Q3: Supabase 现有记录（`app_id: "flywheel"`, `user_id: "geoforge3d"`）如何处理？
- A: SQL 批量更新（`UPDATE memories SET ... WHERE app_id = 'flywheel'`）
- B: 不迁移，旧记录自然被新 filter 排除（隔离但不可见）
- C: 删除旧记录（数据量少，重新积累）

## 6. User Decisions

**Selected Approach**: Option A — API-Driven user_id

| Question | Decision | Rationale |
|----------|----------|-----------|
| Q1: `addSessionMemory()` | **删除** | 死代码，减少维护负担，entity mapping 只需改 2 个方法 |
| Q2: `user_id` required? | **Required** | 强制调用者提供，语义清晰。Lead agent 有 Discord 用户上下文 |
| Q3: 数据迁移 | **删除旧记录** | 数据量少，干净重来更可靠 |
| Q4: ID 验证策略 | **Config 校验** | agentId + project_name 校验 projects.json；userId 校验新增 `allowedUsers` 白名单。Google OAuth 对内部 API 过重 |

## 7. Suggested Next Steps

- [ ] 进入 /research 阶段（验证 mem0 SDK 行为 + 具体实施细节）
- [ ] 写实施 plan
- [ ] 实施 + PR
