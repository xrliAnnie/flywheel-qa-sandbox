# Research: Fix mem0 Memory Layer — GEO-198

**Issue**: GEO-198
**Date**: 2026-03-20
**Source**: `doc/engineer/exploration/new/GEO-198-fix-mem0-memory-layer.md`

---

## 研究目标

验证 exploration 中 Option A（Bridge REST API）的可行性，回答 4 个开放问题：

1. `withTimeout` helper 是否可以安全移除？
2. Bridge 的 router 注册模式 + 新增 memory route 的接入点
3. OpenClaw Lead → Bridge HTTP 调用路径是否已 work
4. MemoryService 在 Bridge 生命周期中如何初始化

---

## 1. `withTimeout` 移除安全性

### 结论：**安全移除**

`withTimeout()` 定义在 `Blueprint.ts:31-43`，仅在两处被调用：
- `Blueprint.ts:258` — `withTimeout(memoryService.searchAndFormat(...), MEMORY_TIMEOUT_MS, "Memory retrieval")`
- `Blueprint.ts:648` — `withTimeout(memoryService.addSessionMemory(...), MEMORY_TIMEOUT_MS, "Memory extraction")`

两处都是 memory 专用。移除 mem0 集成时，`withTimeout` 和 `MEMORY_TIMEOUT_MS` 都应一并删除。

**注意**: Bridge 端的 memory API 也需要超时保护，但应该在 route handler 中用 Express 中间件或 `AbortController` 实现，不需要复用 Blueprint 的 `withTimeout`。

---

## 2. Bridge Router 注册模式

### 现有模式（`packages/teamlead/src/bridge/plugin.ts`）

`createBridgeApp()` 函数签名：
```typescript
createBridgeApp(
  store: StateStore,
  projects: ProjectEntry[],
  config: BridgeConfig,
  broadcaster?: SseBroadcaster,
  transitionOpts?: ApplyTransitionOpts,
  retryDispatcher?: IRetryDispatcher,
  cipherWriter?: CipherWriter,
): express.Application
```

Router 注册层级：
| Path | Auth | Router |
|------|------|--------|
| `/health` | 无 | inline |
| `/` (dashboard) | 无 | inline |
| `/sse` | 无 | inline |
| `/actions` | 无 (loopback) | `createActionRouter()` |
| `/events` | `ingestToken` | `createEventRouter()` |
| `/api` | `apiToken` | `createQueryRouter()` |
| `/api/actions` | `apiToken` | `createActionRouter()` |
| `/api/forum-tag` | `apiToken` | inline |
| `/api/cipher-principle` | `apiToken` | inline (conditional) |

### 新增 memory route 的接入方式

推荐模式（与现有 API 一致）：

```typescript
// 在 createBridgeApp 中新增：
if (memoryService) {
  app.use(
    "/api/memory",
    tokenAuthMiddleware(config.apiToken),
    createMemoryRouter(memoryService),
  );
}
```

**需要修改的函数签名**：
- `createBridgeApp()` — 新增 `memoryService?: MemoryService` 参数
- `startBridge()` — 新增 `opts.memoryService`
- `packages/teamlead/src/index.ts` `main()` — 创建 `MemoryService` 并传入

---

## 3. OpenClaw Lead → Bridge 调用路径

### 结论：**已经 work**

**关键证据**: `~/clawdbot-workspaces/product-lead/TOOLS.md` 明确记录了 Lead agent 调用 Bridge API 的方式：

```
Base URL: http://localhost:9876
Auth: -H 'Authorization: Bearer $TEAMLEAD_API_TOKEN'
```

Lead agent 已经在使用以下 Bridge API：
- `GET /api/sessions` — 查询 session
- `POST /api/actions/{approve,reject,retry,defer,shelve}` — 执行 action
- `POST /api/threads/upsert` — 管理 thread
- `GET /api/resolve-action` — 预检 action 可行性
- `POST /api/linear/create-issue` — 创建 Linear issue

**同一模式下新增 memory API**：只需在 TOOLS.md 中添加 memory endpoint 文档，Lead agent 即可调用。无需改动 OpenClaw 侧配置。

### 调用链

```
Lead agent (OpenClaw/Claude Session)
  → fetch("http://localhost:9876/api/memory/search", {
      headers: { "Authorization": "Bearer $TEAMLEAD_API_TOKEN" },
      body: JSON.stringify({ query, project_name, agent_id })
    })
  → Bridge memory-route.ts handler
  → MemoryService.searchAndFormat()
  → mem0 → Supabase pgvector
```

---

## 4. MemoryService 在 Bridge 生命周期中的初始化

### 当前（runner 侧）

`scripts/lib/setup.ts:481-508`:
```typescript
const memoryService = await createMemoryService({
  googleApiKey: process.env.GOOGLE_API_KEY,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  projectName,
  llmModel: process.env.FLYWHEEL_MEMORY_MODEL,
});
```

`createMemoryService()` 的行为：
1. 检查 3 个 env var 是否都存在（否则 return `undefined`）
2. 创建 `~/.flywheel/memories/<projectName>/history.db` 目录
3. `new MemoryService(config)` — 初始化 mem0 `Memory` 实例
4. 等待 Supabase vectorStore `ready` promise（10s 超时）
5. 检查 `initError`
6. 返回 service 或 `undefined`

### Bridge 侧的调整

**问题**: `createMemoryService` 需要 `projectName` 参数用于 history DB 路径。但 Bridge 服务于多个 project。

**解决方案**:
- history DB 路径改为 `~/.flywheel/memories/bridge/history.db`（Bridge 是单一进程，不需要 per-project history DB）
- 或者传 `"bridge"` 作为 projectName
- mem0 的 per-project 隔离由 `userId`（= projectName）参数在 `search/add` 调用时传入，不依赖构造时的 projectName

**初始化位置**: `packages/teamlead/src/index.ts` 的 `main()` 函数，与 `CipherWriter` 的初始化模式一致：

```typescript
// Memory service (advisory — bridge starts without it)
let memoryService: MemoryService | undefined;
try {
  memoryService = await createMemoryService({
    googleApiKey: process.env.GOOGLE_API_KEY,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
    projectName: "bridge",  // Bridge-wide history DB
  });
  if (memoryService) console.log("[Memory] Service enabled");
} catch (err) {
  console.warn("[Memory] Failed to initialize:", (err as Error).message);
}
```

---

## 5. Blueprint 改动清单（完全移除）

### 删除的代码

| File | What to remove |
|------|---------------|
| `Blueprint.ts` L24 | `import type { MemoryService }` |
| `Blueprint.ts` L29 | `const MEMORY_TIMEOUT_MS = 30_000` |
| `Blueprint.ts` L31-43 | `function withTimeout()` |
| `Blueprint.ts` L126 | `private memoryService?: MemoryService` 构造函数参数 |
| `Blueprint.ts` L253-272 | memory retrieval block |
| `Blueprint.ts` L380 | `memoryBlock` 在 systemPrompt 拼接中的引用 |
| `Blueprint.ts` L466-476 | fallback 路径中的 `extractMemory` 调用 |
| `Blueprint.ts` L589-597 | decision 路径中的 `extractMemory` 调用 |
| `Blueprint.ts` L628-681 | `private async extractMemory()` 方法 |
| `Blueprint.memory.test.ts` | **整个文件删除** |
| `scripts/lib/setup.ts` L35 | `import { createMemoryService }` |
| `scripts/lib/setup.ts` L480-494 | memoryService 创建块 |
| `scripts/lib/setup.ts` L508 | `memoryService` 传入 Blueprint 构造函数 |

### 需要更新的代码

| File | Change |
|------|--------|
| `Blueprint.ts` constructor | 移除最后一个参数后，调用处都需要更新 |
| 所有 Blueprint 测试 | 移除传入 `memoryService` 的位置 |
| `scripts/lib/setup.ts` | `new Blueprint(...)` 调用少传一个参数 |

### 影响的测试文件

```
packages/edge-worker/src/__tests__/Blueprint.memory.test.ts  — 删除（~620 行）
packages/edge-worker/src/__tests__/MemoryService.test.ts     — 保留（测试 MemoryService 本身）
packages/edge-worker/src/__tests__/memory-e2e.test.ts        — 保留
packages/edge-worker/src/__tests__/memory-supabase-live.test.ts — 保留
```

---

## 6. 新增 Bridge Memory Router 设计

### API 定义

```typescript
// POST /api/memory/search
// Body: { query: string, project_name: string, agent_id: string, limit?: number }
// Response: { memories: string[] }

// POST /api/memory/add
// Body: { messages: Array<{role: "user"|"assistant", content: string}>,
//         project_name: string, agent_id: string,
//         metadata?: Record<string, unknown> }
// Response: { added: number, updated: number }
```

### 超时策略

Bridge 端需要自己的超时保护（mem0 调用可能卡住）：

```typescript
const MEMORY_TIMEOUT_MS = 30_000; // 与原 Blueprint 一致

// 在 handler 中使用 AbortController 或 Promise.race
const result = await Promise.race([
  memoryService.searchAndFormat({ query, projectName, agentId }),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Memory search timeout")), MEMORY_TIMEOUT_MS)
  ),
]);
```

### 错误处理

Memory API 应返回明确的 HTTP 状态码：
- `200` — 成功
- `400` — 参数缺失或无效
- `503` — MemoryService 未初始化（env vars 缺失）
- `504` — 超时

---

## 7. 旧数据清理

### Supabase memories 表结构

mem0 使用 `memories` 表，字段包含 `user_id`（= projectName）、`agent_id`、`metadata`。

旧数据特征：`agent_id IS NULL`（Blueprint 从未传入 agentId）。

### 清理方案

```sql
-- 确认影响范围
SELECT COUNT(*) FROM memories WHERE agent_id IS NULL;

-- 清理
DELETE FROM memories WHERE agent_id IS NULL;
```

可以在迁移脚本或 Supabase SQL Editor 中执行。不可逆但安全——旧数据是 runner 的 session 结果记忆，对 Lead agent 没有价值。

---

## 8. product-lead TOOLS.md 更新

需要在 `~/clawdbot-workspaces/product-lead/TOOLS.md` 添加：

```markdown
### Memory
- `POST /api/memory/search` — `{"query":"...", "project_name":"...", "agent_id":"product-lead", "limit": 10}`
  - Returns: `{"memories": ["memory1", "memory2", ...]}`
- `POST /api/memory/add` — `{"messages": [{"role":"user","content":"..."}, {"role":"assistant","content":"..."}], "project_name":"...", "agent_id":"product-lead"}`
  - Returns: `{"added": N, "updated": M}`
```

---

## 9. 风险评估

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Blueprint 构造函数参数变化导致其他测试失败 | Medium | Low | `memoryService` 是最后一个 optional 参数，不传不影响 |
| mem0 在 Bridge 进程中初始化失败 | Low | Low | 与 CipherWriter 同模式——advisory，失败不影响启动 |
| 旧数据清理误删 | Low | Low | 先 `SELECT COUNT(*)` 确认范围再执行 |
| Lead agent 调用 memory API 超时 | Medium | Low | 30s timeout + HTTP 504 响应，Lead 可重试 |
| `createMemoryService` 的 `projectName` 在 Bridge 中语义变化 | Low | Low | 传 `"bridge"` 作为 history DB 的目录名，不影响 mem0 的 search/add |

---

## 10. 结论

**Option A 完全可行，无阻塞风险。** 关键发现：

1. **Lead → Bridge HTTP 调用路径已 work** — TOOLS.md 明确记录，Lead 已经在用 Bridge API
2. **`withTimeout` 仅 memory 使用** — 安全删除
3. **Bridge router 注册模式清晰** — 新增 `createMemoryRouter()` + `app.use("/api/memory", ...)`
4. **MemoryService 初始化模式有现成参考** — 与 CipherWriter 在 `index.ts` 中的 advisory 初始化一致
5. **`MemoryService` 和 `createMemoryService` 已从 `flywheel-edge-worker` 包导出** — teamlead 可以直接 import

可以进入 Plan 阶段。
