# Exploration: Retry API 真正 Requeue 执行 — GEO-168

**Issue**: GEO-168 (Retry API 应真正 requeue 执行，而非仅改状态)
**Date**: 2026-03-15
**Status**: final
**Depth**: Standard
**Mode**: Technical
**Codex Review**: Round 3 feedback incorporated (Round 4 submission)

## 0. Problem Statement

当前 `POST /api/actions/retry` 只调用 `store.forceStatus(executionId, "running")`，把 session status 改成 `"running"` 就返回了。没有任何组件会 pick up 这个 "running" 状态并真正重新执行。CEO 请求 retry 时，实际上什么都没发生。

**期望行为**：
1. 保留旧 execution 原始状态（failed/blocked/rejected），不修改
2. 创建新 execution_id + 新 session（审计链完整）
3. 重新跑 Blueprint（worktree → hydrate → Claude Code → decision → notify）
4. 将上次失败原因注入 Claude prompt（让 Claude 有针对性修复）
5. 在 Linear issue 上留 comment（"Retry triggered"）
6. 通知 agent + CEO 已开始重跑

## 1. Architecture Constraints

### FSM 语义变更

当前 `core/src/workflow-fsm.ts` 定义 retry 为同一 execution 的状态转换：
```typescript
// WORKFLOW_TRANSITIONS — retry 允许从 terminal 回到 running
failed: ["running", "shelved"],
blocked: ["running", "deferred", "shelved"],
rejected: ["running", "shelved"],

// ACTION_DEFINITIONS
{ action: "retry", fromStates: ["failed", "blocked", "rejected"], targetState: "running" }
```

**新语义**：retry 不再是旧 execution 的状态转换。它是：
1. `ACTION_DEFINITIONS.retry.fromStates` 仍用于**资格检查**（旧 execution 必须在这些状态）
2. 旧 execution **保持不变**
3. 新 execution 走 `pending → running`（正常 Blueprint 流程）

**需要变更的文件**：
- `actions.ts` retry case：不再调用 `transitionSession()`/`forceStatus()`
- `WORKFLOW_TRANSITIONS`：`failed`/`blocked`/`rejected` 中移除 `"running"`（retry 不再是同一 execution 的转换）
- `actions.test.ts` 中 retry 测试：改为验证新行为（创建新 execution、旧 execution 不变）
- `resolve-action` + dashboard：eligibility 检查需考虑 in-flight retry（见 Section 2.7）

## 2. Selected Approach: Option A — Blueprint 注入 Bridge

### 2.1 IRetryDispatcher 接口（`packages/teamlead/src/bridge/retry-dispatcher.ts`）

```typescript
export interface RetryRequest {
  oldExecutionId: string;
  issueId: string;
  issueIdentifier?: string;
  issueTitle?: string;
  projectName: string;
  reason?: string;
  previousError?: string;
  previousDecisionRoute?: string;
  previousReasoning?: string;
  runAttempt: number;
}

export interface RetryResult {
  newExecutionId: string;
  oldExecutionId: string;
}

export interface IRetryDispatcher {
  /** 返回新 execution_id。内部做原子 single-flight 检查。 */
  dispatch(req: RetryRequest): Promise<RetryResult>;
  getInflightIssues(): Set<string>;
  stopAccepting(): void;
  drain(): Promise<void>;
}
```

### 2.2 Composition Root — Two-Phase Init（Codex R3 #1 修正）

**问题**：当前 `startBridge()` 在内部创建 `store`（`plugin.ts:196`），而 `DirectEventSink` 需要 `store`。入口脚本无法在调用 `startBridge()` 前构建 retry runtime。

**方案**：将 `startBridge()` 拆为两阶段：

```typescript
// packages/teamlead/src/bridge/plugin.ts — 新增
export async function createBridgeStore(config: BridgeConfig): Promise<StateStore> {
  return StateStore.create(config.dbPath);
}

// startBridge 改为接受外部 store + optional retryDispatcher
export async function startBridge(
  config: BridgeConfig,
  projects: ProjectEntry[],
  opts?: {
    store?: StateStore;              // 外部创建的 store（retry 场景）
    retryDispatcher?: IRetryDispatcher;
  },
): Promise<{ app: express.Application; store: StateStore; close: () => Promise<void> }> {
  const store = opts?.store ?? await StateStore.create(config.dbPath);
  // ... rest of setup, pass retryDispatcher to createBridgeApp/createActionRouter
}
```

**入口脚本组装流程**（`packages/teamlead/src/index.ts` 或 `scripts/daemon.ts`）：

```typescript
async function main() {
  const config = loadConfig();
  const projects = loadProjects();

  // Phase 1: Create store
  const store = await createBridgeStore(config);

  // Phase 2: Build per-project retry runtime
  const projectRuntimes = new Map();
  for (const project of projects) {
    const directSink = new DirectEventSink(store, config);
    const components = await setupComponents({
      projectRoot: project.projectRoot,
      projectName: project.projectName,
      tmuxSessionName: project.projectName,
      fetchIssue: linearFetchIssue,     // Linear SDK fetch
      eventEmitterOverride: directSink,
    });
    projectRuntimes.set(project.projectName, {
      blueprint: components.blueprint,
      projectRoot: project.projectRoot,
    });
  }
  const retryDispatcher = new RetryDispatcher(projectRuntimes);

  // Phase 3: Start bridge with injected store + dispatcher
  const { close } = await startBridge(config, projects, { store, retryDispatcher });

  // Signal handlers
  process.on("SIGINT", () => close().then(() => process.exit(0)));
  process.on("SIGTERM", () => close().then(() => process.exit(0)));
}
```

**注意**：现有 `packages/teamlead/src/index.ts`（无 retry 能力）继续工作（`opts` 全部可选）。新入口脚本才有 retry 能力。向后兼容。

### 2.3 DirectEventSink — 完整 ExecutionEventEmitter 实现（Codex R3 #2 修正）

```typescript
// packages/teamlead/src/DirectEventSink.ts
import type { ExecutionEventEmitter, EventEnvelope } from "flywheel-edge-worker";
import type { BlueprintResult } from "flywheel-edge-worker";
import type { StateStore } from "./StateStore.js";
import type { BridgeConfig } from "./bridge/types.js";
import { buildSessionKey, buildHookBody } from "./bridge/hook-payload.js";
import { sqliteDatetime } from "./bridge/types.js";

export class DirectEventSink implements ExecutionEventEmitter {
  private pending: Promise<void>[] = [];

  constructor(private store: StateStore, private config: BridgeConfig) {}

  async emitStarted(env: EventEnvelope): Promise<void> {
    const now = sqliteDatetime();
    // 1. Upsert session (aligned with event-route.ts:136-148)
    this.store.upsertSession({
      execution_id: env.executionId,
      issue_id: env.issueId,
      project_name: env.projectName,
      status: "running",
      started_at: now,
      last_activity_at: now,
      heartbeat_at: now,
      issue_identifier: env.issueIdentifier,
      issue_title: env.issueTitle,
      // Retry lineage (from extended envelope)
      retry_predecessor: (env as any).retryPredecessor,
      run_attempt: (env as any).runAttempt,
    });

    // 2. Insert event (aligned with event-route.ts:116-129)
    this.store.insertEvent({
      event_id: randomUUID(),
      execution_id: env.executionId,
      issue_id: env.issueId,
      project_name: env.projectName,
      event_type: "session_started",
      payload: { issueIdentifier: env.issueIdentifier, issueTitle: env.issueTitle },
      source: "retry-dispatcher",
    });

    // 3. Thread inheritance (aligned with event-route.ts:149-152)
    const existingThread = this.store.getThreadByIssue(env.issueId);
    if (existingThread) {
      this.store.setSessionThreadId(env.executionId, existingThread.thread_id);
    }

    // 4. Notify agent (aligned with event-route.ts:222-243)
    await this.notifyAgent(env, "session_started");
  }

  async emitCompleted(env: EventEnvelope, result: BlueprintResult, summary?: string): Promise<void> {
    // Status mapping (aligned with event-route.ts:154-197)
    const decision = result.decision;
    const route = decision?.route;
    let status: string;
    if (route === "needs_review") status = "awaiting_review";
    else if (route === "auto_approve") {
      const landingStatus = result.evidence?.landingStatus as { status?: string } | undefined;
      status = landingStatus?.status === "merged" ? "approved" : "awaiting_review";
    }
    else if (route === "blocked") status = "blocked";
    else status = "completed";

    this.store.upsertSession({
      execution_id: env.executionId,
      issue_id: env.issueId,
      project_name: env.projectName,
      status,
      last_activity_at: sqliteDatetime(),
      decision_route: route,
      decision_reasoning: decision?.reasoning,
      commit_count: result.evidence?.commitCount,
      files_changed: result.evidence?.filesChangedCount,
      lines_added: result.evidence?.linesAdded,
      lines_removed: result.evidence?.linesRemoved,
      summary,
      diff_summary: result.evidence?.diffSummary,
      commit_messages: result.evidence?.commitMessages?.join("\n"),
      changed_file_paths: result.evidence?.changedFilePaths?.join("\n"),
      issue_identifier: env.issueIdentifier,
      issue_title: env.issueTitle,
    });

    this.store.insertEvent({
      event_id: randomUUID(),
      execution_id: env.executionId,
      issue_id: env.issueId,
      project_name: env.projectName,
      event_type: "session_completed",
      payload: { evidence: result.evidence, decision, summary },
      source: "retry-dispatcher",
    });

    await this.notifyAgent(env, "session_completed");
  }

  async emitFailed(env: EventEnvelope, error: string): Promise<void> {
    this.store.upsertSession({
      execution_id: env.executionId,
      issue_id: env.issueId,
      project_name: env.projectName,
      status: "failed",
      last_activity_at: sqliteDatetime(),
      last_error: error,
      issue_identifier: env.issueIdentifier,
      issue_title: env.issueTitle,
    });

    this.store.insertEvent({
      event_id: randomUUID(),
      execution_id: env.executionId,
      issue_id: env.issueId,
      project_name: env.projectName,
      event_type: "session_failed",
      payload: { error },
      source: "retry-dispatcher",
    });

    await this.notifyAgent(env, "session_failed");
  }

  async emitHeartbeat(env: EventEnvelope): Promise<void> {
    // Lightweight — aligned with event-route.ts heartbeat handler (line 89-97)
    this.store.updateHeartbeat(env.executionId);
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pending);
    this.pending = [];
  }

  private async notifyAgent(env: EventEnvelope, eventType: string): Promise<void> {
    if (!this.config.gatewayUrl || !this.config.hooksToken) return;
    const session = this.store.getSession(env.executionId);
    if (!session) return;
    const sessionKey = buildSessionKey(session);
    const hookPayload = { /* same fields as event-route.ts:225-240 */ };
    const body = buildHookBody("product-lead", hookPayload, sessionKey);
    // Fire-and-forget with 3s timeout
    const p = fetch(`${this.config.gatewayUrl}/hooks/ingest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.hooksToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    this.pending.push(p as Promise<void>);
  }
}
```

**CIPHER note**：`event-route.ts:86` 中 `_cipherWriter?: unknown` 是未使用的占位符参数（prefixed with `_`）。当前没有 CIPHER 副作用需要复制。CIPHER 集成（GEO-149）仍在 backlog。

### 2.4 retryContext 穿过 Blueprint 的精确 plumbing（Codex R3 #3 修正）

**Step 1: BlueprintContext 新字段**（`edge-worker/src/Blueprint.ts`）：

```typescript
// BlueprintContext 扩展
export interface BlueprintContext {
  teamName: string;
  runnerName: string;
  projectName?: string;
  sessionTimeoutMs?: number;
  consecutiveFailures?: number;
  executionId?: string;
  // NEW — retry metadata
  retryContext?: {
    previousError?: string;
    previousDecisionRoute?: string;
    previousReasoning?: string;
    attempt: number;
    reason?: string;
  };
}
```

**Step 2: EventEnvelope 扩展**（`edge-worker/src/ExecutionEventEmitter.ts`）：

```typescript
export interface EventEnvelope {
  executionId: string;
  issueId: string;
  projectName: string;
  issueIdentifier?: string;
  issueTitle?: string;
  // NEW — retry lineage
  retryPredecessor?: string;
  runAttempt?: number;
}
```

**Step 3: Blueprint.run() 传递 retryContext → EventEnvelope → prompt**：

```typescript
// Blueprint.ts — run() method, after creating env
const env: EventEnvelope = {
  executionId,
  issueId: node.id,
  projectName: projectScope,
  // NEW — pass retry lineage to event sink
  retryPredecessor: ctx.retryContext ? /* old execution ID from caller */ undefined : undefined,
  runAttempt: ctx.retryContext?.attempt,
};
```

**Step 4: Blueprint.ts — prompt construction**（在 `systemPromptLines` 组装后）：

```typescript
// After existing systemPromptLines.push("Do not ask questions...");
// NEW — Retry context injection
if (ctx.retryContext) {
  const rc = ctx.retryContext;
  const retryLines = [
    "",
    `## Retry Context (Attempt #${rc.attempt})`,
    `This is a retry of a previous execution that ${rc.previousDecisionRoute === "blocked" ? "was blocked" : "failed"}.`,
  ];
  if (rc.previousError) retryLines.push(`Previous error: ${rc.previousError}`);
  if (rc.previousReasoning) retryLines.push(`Previous decision reasoning: ${rc.previousReasoning}`);
  if (rc.reason) retryLines.push(`CEO instruction for retry: ${rc.reason}`);
  retryLines.push("Please address the issues from the previous attempt.");
  systemPromptLines.push(...retryLines);
}
```

### 2.5 Single-Flight — 原子化 guard（Codex R3 #4 修正）

Guard 收口到 `dispatch()` 内部：

```typescript
// RetryDispatcher.dispatch()
async dispatch(req: RetryRequest): Promise<RetryResult> {
  if (!this.accepting) throw new Error("RetryDispatcher is shutting down");

  // Atomic single-flight: check + reserve in one step (no await between)
  if (this.inflight.has(req.issueId)) {
    throw new Error(`Retry already in progress for issue ${req.issueId}`);
  }

  const runtime = this.blueprintsByProject.get(req.projectName);
  if (!runtime) throw new Error(`No runtime for project: ${req.projectName}`);

  const newExecutionId = randomUUID();

  // Reserve BEFORE any async work — prevents race
  const entry = { executionId: newExecutionId, promise: null! as Promise<void> };
  this.inflight.set(req.issueId, entry);

  entry.promise = runtime.blueprint.run(...)
    .finally(() => this.inflight.delete(req.issueId));

  // Fire-and-forget
  entry.promise.catch(err =>
    console.error(`[RetryDispatcher] ${newExecutionId} failed:`, err)
  );

  return { newExecutionId, oldExecutionId: req.oldExecutionId };
}
```

**actions.ts retry handler** 变为：

```typescript
case "retry": {
  if (!retryDispatcher) {
    res.status(501).json({ error: "retry not available" });
    return;
  }
  // Source status check
  if (!["failed", "blocked", "rejected"].includes(session.status)) {
    res.status(400).json({ error: `Cannot retry: status is "${session.status}"` });
    return;
  }
  // Compute attempt
  const history = store.getSessionHistory(session.issue_id);
  const runAttempt = history.length + 1;

  try {
    const result = await retryDispatcher.dispatch({
      oldExecutionId: eid,
      issueId: session.issue_id,
      issueIdentifier: session.issue_identifier,
      issueTitle: session.issue_title,
      projectName: session.project_name,
      reason,
      previousError: session.last_error,
      previousDecisionRoute: session.decision_route,
      previousReasoning: session.decision_reasoning,
      runAttempt,
    });

    // Write retry_successor AFTER successful dispatch
    store.setRetrySuccessor(eid, result.newExecutionId);

    // Linear comment (best-effort)
    postRetryComment(session.issue_id, runAttempt, reason).catch(() => {});

    res.json({
      success: true,
      message: `Retry dispatched for ${session.issue_identifier}`,
      action: "retry",
      newExecutionId: result.newExecutionId,
      oldExecutionId: eid,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Single-flight rejection or other dispatch error
    const status = msg.includes("already in progress") ? 409 : 500;
    res.status(status).json({ success: false, message: msg, action: "retry" });
  }
  return;
}
```

**No dangling successor**: `setRetrySuccessor()` only called after dispatch succeeds. If dispatch throws, no write happens.

### 2.6 resolve-action + Dashboard Eligibility（Codex R3 #5 修正）

**resolve-action**（`tools.ts:160-188`）：retry eligibility 额外检查 in-flight：

```typescript
// tools.ts — resolve-action handler, after finding session
if (action === "retry" && retryDispatcher?.getInflightIssues().has(session.issue_id)) {
  res.json({
    can_execute: false,
    reason: `Retry already in progress for issue ${issueId}`,
  });
  return;
}

// Also check no active execution
const activeExecution = store.getLatestSessionByIssueAndStatuses(issueId, ["running", "awaiting_review"]);
if (action === "retry" && activeExecution) {
  res.json({
    can_execute: false,
    reason: `Issue ${issueId} already has an active execution`,
  });
  return;
}
```

**Dashboard**（`dashboard-data.ts`）：`allowedActions` 列表中 retry 需要同样的 eligibility 过滤。在 `buildDashboardPayload()` 中，如果 retryDispatcher 可用，检查 in-flight。

**实现方式**：`createBridgeApp()` 和 `createQueryRouter()` 接受可选 `retryDispatcher` 参数，传递到 resolve-action handler。

### 2.7 Linear Comment

使用 `accessToken`（与 `LinearIssueTrackerService.ts:65` 一致）：

```typescript
async function postRetryComment(issueId: string, attempt: number, reason?: string): Promise<void> {
  const accessToken = process.env.LINEAR_API_KEY;
  if (!accessToken) return;
  const client = new LinearClient({ accessToken });
  await client.createComment({
    issueId,
    body: `🔄 Retry triggered (attempt #${attempt})${reason ? `: ${reason}` : ""}`,
  });
}
```

### 2.8 StateStore Schema + Shutdown

**Schema migration**：
```sql
ALTER TABLE sessions ADD COLUMN retry_predecessor TEXT;
ALTER TABLE sessions ADD COLUMN retry_successor TEXT;
ALTER TABLE sessions ADD COLUMN run_attempt INTEGER DEFAULT 1;
```

**Shutdown**（`plugin.ts` close path）：
```typescript
const close = async () => {
  retryDispatcher?.stopAccepting();
  if (retryDispatcher) {
    const result = await Promise.race([
      retryDispatcher.drain().then(() => "drained" as const),
      new Promise<"timeout">(r => setTimeout(() => r("timeout"), 60_000)),
    ]);
    if (result === "timeout") {
      for (const issueId of retryDispatcher.getInflightIssues()) {
        const session = store.getLatestSessionByIssueAndStatuses(issueId, ["running"]);
        if (session) {
          store.forceStatus(session.execution_id, "failed", sqliteDatetime(), "Bridge shutdown");
        }
      }
    }
  }
  heartbeatService?.stop();
  broadcaster.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  store.close();
};
```

## 3. Affected Files Summary

| File | Change | Notes |
|------|--------|-------|
| `teamlead/src/bridge/retry-dispatcher.ts` | NEW | IRetryDispatcher interface |
| `teamlead/src/DirectEventSink.ts` | NEW | Bridge-local event emitter → StateStore (full ExecutionEventEmitter) |
| `teamlead/src/bridge/actions.ts` | MODIFY | retry = composite action (validate + dispatch + linear comment) |
| `teamlead/src/bridge/plugin.ts` | MODIFY | Two-phase init, accept store + retryDispatcher, drain in close() |
| `teamlead/src/bridge/tools.ts` | MODIFY | resolve-action retry eligibility (in-flight + active execution check) |
| `teamlead/src/StateStore.ts` | MODIFY | 新列 retry_predecessor, retry_successor, run_attempt; setRetrySuccessor() |
| `teamlead/src/index.ts` | MODIFY | 可选 two-phase init (向后兼容) |
| `edge-worker/src/Blueprint.ts` | MODIFY | BlueprintContext.retryContext + prompt injection |
| `edge-worker/src/ExecutionEventEmitter.ts` | MODIFY | EventEnvelope + retryPredecessor, runAttempt |
| `core/src/workflow-fsm.ts` | MODIFY | 移除 failed/blocked/rejected → running 转换 |
| `scripts/lib/setup.ts` | MODIFY | eventEmitterOverride param |
| Tests: `actions.test.ts`, `WorkflowFSM.test.ts` | MODIFY | 适配新 retry 语义 |

## 4. User Decisions

- **Selected approach**: Option A — Blueprint 注入 Bridge（经 Codex 3 轮修订）
- **Q1 (worktree)**: 丢弃上一次 worktree，全新开始
- **Q2 (failure reason)**: 是，via `BlueprintContext.retryContext` → system prompt injection
- **Q3 (Linear 通知)**: 是，`@linear/sdk` `createComment({ accessToken })`

## 5. Suggested Next Steps

- [x] Option A 选定，经 Codex 3 轮修订
- [x] 所有 runtime wiring 路径明确
- [x] FSM 语义变更 + resolve-action/dashboard 联动明确
- [ ] 进入 /research → /write-plan → /implement
