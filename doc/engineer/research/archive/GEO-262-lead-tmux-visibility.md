# Research: Lead tmux 可见性 — GEO-262

**Issue**: GEO-262
**Date**: 2026-03-25
**Source**: `doc/engineer/exploration/new/GEO-262-lead-tmux-visibility.md`

---

## 1. 核心发现

### 1.1 flywheel-comm CLI `capture` 已存在

**无需新建 CLI 子命令** — `flywheel-comm capture` 已在 GEO-206 Phase 2 中实现：

```bash
flywheel-comm capture --exec-id <execution_id> [--lines N] [--db path] [--project name]
```

位置: `packages/flywheel-comm/src/index.ts:321-344` + `packages/flywheel-comm/src/commands/capture.ts`

实际工作减少一项。

### 1.2 flywheel-comm `./db` 已有 library export

```json
// packages/flywheel-comm/package.json
"exports": {
  ".": "./dist/index.js",
  "./db": "./dist/lib.js"   // ← 导出 CommDB class + types
}
```

```typescript
// packages/flywheel-comm/src/lib.ts
export { CommDB } from "./db.js";
export type { CheckResult, Message, PendingQuestion, Session } from "./types.js";
```

**TmuxAdapter 已在使用**（`packages/claude-runner/src/TmuxAdapter.ts:4`）:
```typescript
import { CommDB } from "flywheel-comm/db";
```

所以 Bridge 可以用同样的方式导入，这是已验证的模式。

### 1.3 teamlead 当前无 flywheel-comm 依赖

```json
// packages/teamlead/package.json - dependencies
{
  "express": "^5.2.1",
  "flywheel-core": "workspace:*",
  "flywheel-edge-worker": "workspace:*",
  "@linear/sdk": "60.0.0",
  "sql.js": "^1.14.1"
  // 无 flywheel-comm
}
```

需要添加 `"flywheel-comm": "workspace:*"`。better-sqlite3 是 flywheel-comm 的依赖，会被传递引入。

---

## 2. 精确接口分析

### 2.1 CommDB Session 接口 (flywheel-comm)

```typescript
// packages/flywheel-comm/src/types.ts
interface Session {
  execution_id: string;
  tmux_window: string;        // ← 完整 tmux 目标，如 "flywheel:@42"
  project_name: string;
  issue_id: string | null;
  lead_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: "running" | "completed" | "timeout";
}
```

### 2.2 CommDB 关键方法

```typescript
// 只读模式 — Bridge 应使用此方法
static openReadonly(dbPath: string): CommDB   // 跳过 schema/migration/purge

// 查询 session
getSession(executionId: string): Session | undefined
```

**注意**: 现有 `capture.ts` 使用 `new CommDB(dbPath, false)` 而非 `openReadonly()`。Bridge 应使用 `openReadonly()` 避免执行 schema migration。

### 2.3 StateStore Session 接口 (teamlead)

```typescript
// packages/teamlead/src/StateStore.ts
interface Session {
  execution_id: string;
  project_name: string;       // ← 用于派生 CommDB 路径
  tmux_session?: string;      // ← 仅 session 名（如 "flywheel"），不含 window
  // ...其他字段
}
```

### 2.4 createQueryRouter 签名

```typescript
// packages/teamlead/src/bridge/tools.ts
export function createQueryRouter(
  store: StateStore,
  retryDispatcher?: IRetryDispatcher,
): Router
```

**需要扩展**: 添加参数使 capture 路由能访问 CommDB。

### 2.5 CommDB 路径约定

```typescript
// packages/flywheel-comm/src/resolve-db-path.ts
// 路径: ~/.flywheel/comm/{projectName}/comm.db
join(homedir(), ".flywheel", "comm", projectName, "comm.db")
```

---

## 3. 测试模式分析

### 3.1 现有 tools.test.ts 模式

```typescript
// 测试结构
describe("Query tools", () => {
  let store: StateStore;      // 内存 StateStore
  let server: http.Server;    // 随机端口 HTTP 服务
  let baseUrl: string;

  beforeEach(async () => {
    store = await StateStore.create(":memory:");
    const app = createBridgeApp(store, [], makeConfig());
    server = app.listen(0, "127.0.0.1");
    // ...
  });

  // 使用 fetch() 做集成测试，无 mock 框架
  it("GET /api/sessions/:id returns session", async () => {
    store.upsertSession({ ... });
    const res = await fetch(`${baseUrl}/api/sessions/exec-uuid`);
    expect(res.status).toBe(200);
  });
});
```

### 3.2 Capture 测试策略

Capture 端点需要 mock 两个外部依赖：
1. **CommDB** — 不能依赖真实 CommDB 文件
2. **tmux capture-pane** — 不能依赖真实 tmux

**方案**: 依赖注入 — `createQueryRouter` 接受一个 `captureSession` 函数，测试时注入 mock。

```typescript
// 签名
type CaptureSessionFn = (
  executionId: string,
  projectName: string,
  lines: number
) => { output: string; tmuxTarget: string } | { error: string; status: number };

export function createQueryRouter(
  store: StateStore,
  retryDispatcher?: IRetryDispatcher,
  captureSession?: CaptureSessionFn,
): Router
```

**测试 mock 示例**:
```typescript
const mockCapture: CaptureSessionFn = (execId, project, lines) => {
  if (execId === "exec-1") return { output: "test output\n", tmuxTarget: "flywheel:@42" };
  return { error: "tmux window not found", status: 502 };
};

const app = createBridgeApp(store, [], makeConfig(), undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, mockCapture);
```

**但 createBridgeApp 参数已经很多了** — 考虑使用 options 对象重构？不，scope discipline — 本次只加 captureSession。

---

## 4. 实现路径（精确到行）

### 4.1 `packages/teamlead/package.json`

```diff
  "dependencies": {
    "express": "^5.2.1",
    "flywheel-core": "workspace:*",
    "flywheel-edge-worker": "workspace:*",
+   "flywheel-comm": "workspace:*",
    "@linear/sdk": "60.0.0",
    "sql.js": "^1.14.1"
  },
```

### 4.2 `packages/teamlead/src/bridge/tools.ts`

在 `createQueryRouter` 中添加 `GET /sessions/:id/capture` 路由（在现有 `/sessions/:id/history` 之后）。

关键实现逻辑：
```typescript
router.get("/sessions/:id/capture", (req, res) => {
  // 1. 从 StateStore 解析 session（复用现有 exec_id + identifier fallback 逻辑）
  // 2. 校验 lines 参数 (1-500, default 100)
  // 3. 派生 CommDB 路径: ~/.flywheel/comm/{project_name}/comm.db
  // 4. CommDB.openReadonly(dbPath) → getSession(exec_id) → tmux_window
  // 5. execFileSync("tmux", ["capture-pane", "-t", tmuxWindow, "-p", "-S", `-${lines}`])
  // 6. 返回 JSON { execution_id, tmux_target, lines, output, captured_at }
});
```

### 4.3 `packages/teamlead/src/bridge/plugin.ts`

`createQueryRouter` 调用点（line 282）：
```typescript
// 现在:
createQueryRouter(store, retryDispatcher)
// 改为（传递 capture 依赖）:
createQueryRouter(store, retryDispatcher, captureSessionFn)
```

### 4.4 `doc/reference/product-lead-TOOLS.md`

在 "Session Queries" 部分后添加：
```markdown
### Session Capture (GEO-262)

```
GET /api/sessions/:id/capture?lines=100
  Returns tmux terminal output of a running session

Response: {
  execution_id: "...",
  tmux_target: "flywheel:@42",
  lines: 100,
  output: "... terminal text ...",
  captured_at: "2026-03-25T12:00:00Z"
}
```
```

---

## 5. 风险和 Edge Cases

### 5.1 CommDB 不存在

项目没有运行过 flywheel-comm 的情况下，`~/.flywheel/comm/{project}/comm.db` 不存在。

**处理**: 返回 404 + 明确错误: `"Communication database not found for project '{name}'"`

### 5.2 CommDB 存在但 session 不在其中

Session 在 StateStore 中但不在 CommDB 中（老 session、CommDB 被清理、Runner 未注册）。

**处理**: 返回 404: `"No tmux window registered for execution {id}"`

### 5.3 tmux window 已关闭

Session 标记为 completed/timeout 但 `remain-on-exit` 保留了 pane，或 pane 已被手动关闭。

**处理**: Best-effort — 尝试 capture，失败返回 502: `"tmux window not found: {target}"`

### 5.4 CommDB 被 Runner 锁住

CommDB 使用 WAL 模式 + `busy_timeout = 5000`。`openReadonly()` 打开的只读连接不会被写锁阻塞（WAL 的设计优势）。

**结论**: 无风险。

### 5.5 createBridgeApp 参数膨胀

当前 `createBridgeApp` 已有 12 个参数。添加第 13 个不理想。

**方案**: 传递 capture 函数作为可选参数，遵循现有模式。如果未来继续增长，考虑 options 对象重构（但不在本次 scope 内）。

---

## 6. 不在 Scope 内（明确排除）

- ❌ ANSI escape code 处理 — `capture-pane -p` 默认返回纯文本
- ❌ flywheel-comm CLI capture 子命令 — **已存在**
- ❌ HTTP Hooks 结构化监控 — 后续新 issue
- ❌ createBridgeApp 参数重构 — 不在本次 scope
- ❌ 多机部署支持 — 后续
