# Exploration: Fix mem0 Memory Layer — GEO-198

**Issue**: GEO-198 (Fix mem0 memory layer: move from runner to Lead agents)
**Date**: 2026-03-20
**Depth**: Deep
**Mode**: Technical
**Status**: final

---

## 1. Current State Analysis

### 1.1 mem0 在 Blueprint (Runner 层) 的集成

mem0 MemoryService 当前通过 DI 注入 Blueprint 构造函数（最后一个参数），在两个时机触发：

**读取（Memory Retrieval）** — `Blueprint.runInner()` L253-272：
```
Runner 启动前 → memoryService.searchAndFormat({query, projectName}) → 注入 <project_memory> 到 system prompt
```

**写入（Memory Extraction）** — `Blueprint.extractMemory()` L628-681：
```
Runner 完成后 → memoryService.addSessionMemory({projectName, executionId, issueId, ...}) → 存储 session 结果
```

### 1.2 Identity Model（错误）

| 参数 | 当前值 | 问题 |
|------|--------|------|
| `userId` | `projectName` (e.g., "geoforge3d") | 合理——项目维度隔离 |
| `agentId` | `undefined` | **错误** — 应该是 lead agent ID（"product-lead", "ops-lead"），现在没有隔离 |

### 1.3 Affected Files

| File | Impact | Role |
|------|--------|------|
| `packages/edge-worker/src/Blueprint.ts` | **Remove** mem0 integration | Runner 编排器 |
| `packages/edge-worker/src/memory/MemoryService.ts` | **Keep** — 核心服务不变 | mem0 wrapper |
| `packages/edge-worker/src/memory/createMemoryService.ts` | **Keep** — factory 不变 | 工厂函数 |
| `packages/edge-worker/src/memory/types.ts` | **Keep** | 配置类型 |
| `packages/edge-worker/src/memory/index.ts` | **Keep** — 导出不变 | barrel |
| `packages/edge-worker/src/__tests__/Blueprint.memory.test.ts` | **Remove/Rewrite** | 测试文件 |
| `scripts/lib/setup.ts` L481-508 | **Remove** memoryService 创建 + 注入 Blueprint | 启动脚本 |
| `packages/teamlead/src/bridge/` | **Add** 新 API 端点 | Bridge 层 |

### 1.4 DI Chain

```
scripts/lib/setup.ts
  → createMemoryService({googleApiKey, supabaseUrl, supabaseKey, projectName})
  → new Blueprint(..., memoryService)  // 第12个构造函数参数
  → Blueprint.runInner() 调用 searchAndFormat + extractMemory
```

---

## 2. Architecture Constraints

1. **Bridge 是 Lead agent 的后端**: Lead agent (OpenClaw) 通过 webhook 接收事件，通过 HTTP 回调 Bridge 执行 action。所有 Lead 交互都经过 Bridge。

2. **per-Lead 隔离已有基础**: `MemoryService.searchAndFormat()` 和 `addSessionMemory()` 都支持 `agentId` 参数，当前传 `undefined`。只需在调用时传入 lead agent ID 即可实现隔离。

3. **Bridge 已有 auth 机制**: `apiToken` 用于 action API 鉴权，新 memory endpoint 可复用。

4. **OpenClaw → Bridge 调用路径**: Lead agent 已经可以通过 OpenClaw action API 调用 Bridge 的 `/api/action/{approve,reject,retry,...}`。新增 `/api/memory/search` 和 `/api/memory/add` 是同一模式。

5. **GEO-195 兼容性**: 无论 Lead 最终用 OpenClaw 还是 Claude Code persistent session，Bridge REST API 都能作为统一的 memory 接口。

6. **Blueprint 构造函数已经有 12 个参数**: 移除 `memoryService` 参数可以简化 DI chain，但需要同步更新所有测试。

---

## 3. External Research

### 业界 mem0 集成模式

mem0 官方推荐将记忆层接在 "agent" 而非 "executor" 层——agent 做决策时搜索记忆，决策后存储学习。这与 GEO-198 的目标一致。

### 关键约束

- mem0 `add()` 调用涉及 LLM（Gemini）做 fact extraction，延迟 ~5-15s
- mem0 `search()` 涉及 embedding + 向量搜索，延迟 ~1-3s
- 两者都应是 best-effort、non-fatal（当前 Blueprint 已按此模式实现）

---

## 4. Options Comparison

### Option A: Bridge REST API（推荐）

**Core idea**: 在 Bridge 新增 `/api/memory/search` 和 `/api/memory/add` 端点，Lead agent 通过 HTTP 调用。从 Blueprint 完全移除 mem0。

**架构变化**:
```
Before:
  Runner 启动 → Blueprint.searchAndFormat() → 注入 prompt
  Runner 完成 → Blueprint.extractMemory() → 存储结果

After:
  Lead 收到事件 → POST /api/memory/search → 获取历史上下文
  Lead 处理完毕 → POST /api/memory/add → 存储决策/学习
```

**API 设计**:
```
POST /api/memory/search
Body: { query: string, project_name: string, agent_id: string, limit?: number }
Response: { memories: string[] } | { memories: [] }

POST /api/memory/add
Body: { messages: [{role, content}], project_name: string, agent_id: string, metadata?: object }
Response: { added: number, updated: number }
```

**Affected files**:
- `packages/teamlead/src/bridge/memory-route.ts` — **新增** memory API router
- `packages/teamlead/src/bridge/plugin.ts` — 注册 memory router
- `packages/teamlead/src/index.ts` — 传入 memoryService
- `packages/edge-worker/src/Blueprint.ts` — **移除** memoryService 参数 + 所有 memory 逻辑
- `packages/edge-worker/src/__tests__/Blueprint.memory.test.ts` — **删除或重写**
- `scripts/lib/setup.ts` — 移除 memoryService 创建 + Blueprint 注入

**Pros**:
- 最干净的分离——Blueprint 回归纯 runner，不再关心记忆
- Lead agent 可以主动搜索记忆（不只是被动注入）
- per-lead 隔离自然——每个请求携带 `agent_id`
- GEO-195 兼容——REST API 不依赖 OpenClaw

**Cons**:
- 额外 HTTP hop（但 bridge 和 lead 在同一机器，延迟可忽略）
- 需要处理 Bridge 中 MemoryService 的生命周期

**Effort**: Medium

---

### Option B: Event-driven Injection（Bridge 自动注入）

**Core idea**: 不暴露 API。Bridge 在处理事件（session_completed/failed）时自动搜索 mem0，将相关记忆附加到 hook payload 中发送给 Lead。Lead 无需知道 mem0 的存在。

**架构变化**:
```
Event → Bridge event-route → mem0.search() → enriched hook payload → Lead
Lead response (action) → Bridge action handler → mem0.add() → 存储
```

**Affected files**:
- `packages/teamlead/src/bridge/event-route.ts` — 添加 mem0 search 逻辑
- `packages/teamlead/src/bridge/actions.ts` — 添加 mem0 add 逻辑
- `packages/teamlead/src/bridge/hook-payload.ts` — 扩展 HookPayload
- 同样需要从 Blueprint 移除 mem0

**Pros**:
- Lead 不需要学新 API——记忆自动到达
- 更简单的 Lead agent prompt（不需要教 Lead 怎么调 memory API）

**Cons**:
- Lead 不能主动搜索记忆（被动模式）
- 记忆只在事件触发时可用——Lead 在 chat 中回答 CEO 问题时没法查历史
- 耦合到事件流——如果事件格式变，memory 逻辑也要跟着变
- 不满足 Linear issue 描述的 "Lead Agent 收到事件 → mem0.search()" 模式

**Effort**: Medium

---

### Option C: Hybrid（A + B）

**Core idea**: 同时暴露 REST API 和在 event 中注入记忆。

**Pros**: 最灵活
**Cons**: 两条路径 = 双倍维护成本，过度工程化

**Effort**: Large

---

### Recommendation: Option A

**Rationale**:
1. 与 Linear issue 描述的目标模型完全一致（"Lead Agent → mem0.search()"）
2. 最干净的架构分离——职责清晰
3. 向前兼容 GEO-195（无论 Lead 用 OpenClaw 还是 Claude Code session）
4. 复杂度适中——新增一个 route 文件，移除 Blueprint 中的 memory 逻辑

---

## 5. Clarifying Questions

### Scope

**Q1**: Blueprint 中 mem0 的移除策略？
- **A) 完全移除** — 删掉 `memoryService` 构造函数参数 + 所有 memory 逻辑（clean break）
- **B) 降级为 disabled** — 保留参数但默认不传（`undefined`），代码路径仍在

**Q2**: 已有的 Supabase `memories` 表中的数据（由 runner 写入，`agentId = undefined`）如何处理？
- **A) 保留** — 旧数据不影响新 Lead 记忆（`agentId` 不同，搜索时自然过滤）
- **B) 清理** — 写迁移脚本删除或标记旧数据
- **C) 迁移** — 将旧数据的 `agentId` 更新为 default lead agent ID

### API Design

**Q3**: Memory API 是否需要独立的鉴权 token，还是复用现有的 `apiToken`？

### Integration

**Q4**: 当前 OpenClaw Lead agent 已经能调用 Bridge action API 吗？（确认 Lead → Bridge 的调用路径已经 work）

---

## 6. User Decisions

- **Selected approach**: Option A — Bridge REST API
- **Q1 Blueprint 移除策略**: A) 完全移除 — clean break，删掉 `memoryService` 构造函数参数 + `MEMORY_TIMEOUT_MS` + `extractMemory()` + `withTimeout` helper + 所有 memory 逻辑。测试文件 `Blueprint.memory.test.ts` 删除。
- **Q2 旧数据处理**: B) 清理旧数据 — 写迁移脚本删除 `agentId = null` 的记忆记录。
- **Q3 鉴权**: 复用现有 `apiToken`。
- **Q4 Lead → Bridge 调用路径**: 不确定 — 需要在 Research 阶段验证 OpenClaw Lead agent 是否已经能主动调用 Bridge HTTP API。

---

## 7. Suggested Next Steps

- [ ] 确认以上问题后，进入 /research 阶段
- [ ] Research: 验证 MemoryService 在 Bridge 生命周期中的初始化方式
- [ ] Research: 确认 OpenClaw action API 的调用模式（Lead → Bridge）
- [ ] Plan: 基于 Option A 制定实施计划
