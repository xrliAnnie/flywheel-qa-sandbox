# Exploration: Port Paperclip Adapter Protocol + Heartbeat Service — GEO-157

**Issue**: GEO-157 (Port Paperclip Adapter Protocol + Heartbeat Service)
**Date**: 2026-03-15
**Depth**: Deep
**Mode**: Technical
**Status**: draft

## 0. Executive Summary

GEO-157 提出统一 Flywheel 的三套 runner 接口为一个 `IAdapter`。深入研读代码后发现：**三套接口服务于根本不同的执行模型，强行统一会造成 leaky abstraction。** 需要重新界定 scope。

## 1. Affected Files and Services

| File/Service | 当前接口 | 执行模型 | 消费者 |
|-------------|---------|---------|--------|
| `core/src/flywheel-runner-types.ts` | `IFlywheelRunner` | 自治执行（fire-and-forget） | `Blueprint.ts:88`, `DagDispatcher.ts` |
| `core/src/agent-runner-types.ts` | `IAgentRunner` | 交互式 session（streaming） | `EdgeWorker.ts`, `AgentSessionManager.ts:1578`, `ChatSessionHandler.ts:38` |
| `core/src/simple-agent-runner-types.ts` | `ISimpleAgentRunner<T>` | 枚举决策（query → response） | Decision Layer |
| `claude-runner/src/TmuxRunner.ts` | implements `IFlywheelRunner` | tmux spawn + 多路完成检测 | `Blueprint` via `getRunner()` |
| `claude-runner/src/ClaudeRunner.ts` | implements `IAgentRunner` | Claude SDK session (streaming) | `AgentSessionManager` |
| `teamlead/src/StuckWatcher.ts` | N/A | 定时轮询 + webhook 通知 | `startBridge()` |
| `teamlead/src/StateStore.ts` | N/A | SQLite (sql.js) 3表 | Bridge API, StuckWatcher |
| `edge-worker/src/Blueprint.ts` | consumes `IFlywheelRunner` | DAG node → runner.run() → evidence → decision | `DagDispatcher` |

## 2. Architecture Constraints — 为什么不能简单统一

### 2.1 三套接口的本质差异

```mermaid
graph TD
    subgraph "IFlywheelRunner (DAG Path)"
        A[DagDispatcher] --> B[Blueprint]
        B --> C["runner.run(request)"]
        C --> D[FlywheelRunResult]
        D --> E[GitResultChecker → Evidence → Decision]
    end

    subgraph "IAgentRunner (Edge Worker Path)"
        F[Linear @ mention] --> G[EdgeWorker]
        G --> H[ChatSessionHandler]
        H --> I["runner.startStreaming()"]
        I --> J["runner.addStreamMessage()"]
        J --> K["runner.getMessages()"]
        K --> L["runner.getFormatter()"]
    end

    subgraph "ISimpleAgentRunner (Decision Path)"
        M[Execution Evidence] --> N["runner.query(question)"]
        N --> O["response ∈ validResponses"]
    end
```

| 维度 | `IFlywheelRunner` | `IAgentRunner` | `ISimpleAgentRunner` |
|------|-------------------|----------------|---------------------|
| 生命周期 | 一次性 run() → result | 持久 session (streaming) | 一次性 query() → response |
| 交互性 | 无（autonomous） | 有（addStreamMessage） | 无 |
| 消息管理 | 无 | getMessages(), getFormatter() | messages 在 result 中 |
| SDK 耦合 | 无（CLI spawn） | 强（Claude SDK types） | 中（SDKMessage in result） |
| 并行场景 | DAG 并行多 node | 同 issue 多 session | 每次 triage 一个 |

**核心问题**：`IAgentRunner` 是为 Linear agent session 设计的交互式接口，它需要 streaming、message management、formatter。这些在自治 DAG 执行路径中完全不需要。统一会导致要么接口臃肿，要么实现者塞满 no-op。

### 2.2 Paperclip 的上下文差异

Paperclip 能用一个 adapter 接口统一，因为它的所有执行都是 **heartbeat-scheduled, fire-and-forget**：adapter.execute() → result。它没有交互式 streaming session 的概念。

Flywheel 有两个执行引擎：
1. **DAG engine**（Blueprint + DagDispatcher）— 自治的，和 Paperclip 对齐
2. **Edge Worker**（Linear webhook → streaming session）— 交互式的，Paperclip 没有等价物

### 2.3 StuckWatcher vs HeartbeatService

当前 StuckWatcher 很轻量（65 行），只做：
- 定时扫描 `sessions WHERE status = 'running' AND last_activity_at < threshold`
- 对每个 stuck session 发 webhook 通知（dedup via in-memory Set）

Paperclip 的 HeartbeatService 做的更多：
- Atomic task checkout（我们的 DAG + Semaphore 已实现等价功能）
- Orphan run reaping（我们没有，crash 后 session 永远 stuck）
- Session persistence 跨 heartbeat（我们没有）
- Max concurrent runs（Semaphore 已实现）

**真正缺失的是 orphan reaping + session persistence，不是整个 heartbeat 架构。**

## 3. External Research

### Paperclip Adapter Protocol（已由 deep dive agent 研究）

核心发现：
- `AdapterExecutionContext` 提供 `runtime: AdapterRuntime`（session state 跨 heartbeat 持久化）
- `AdapterExecutionResult` 返回 `sessionParams`（保存到下次）
- Adapter 是 pure function 风格：execute(context) → result
- 和 `IFlywheelRunner` 的 `run(request) → result` 高度对齐

### Industry Practice

- **Temporal.io** workflows: Activity 接口是 fire-and-forget，Worker 是 heartbeat-based
- **GitHub Actions**: Runner 是 checkout → execute → report，orphan detection 通过 timeout
- **Kubernetes Jobs**: pod-based execution，liveness probe = heartbeat，restart policy = orphan handling

所有成熟系统都把"交互式 session"和"自治执行"分开抽象。

## 4. Options Comparison

### Option A: 全面统一（Issue 原始方案）

**Core idea**: 定义 `IAdapter` 统一替代三套接口。

**Pros**:
- 概念上最简洁（一个接口 rule all）
- Paperclip 证明了统一 adapter 可行

**Cons**:
- **Leaky abstraction**: `IAgentRunner` 的 streaming/message/formatter 需求塞不进 execute() → result
- Edge Worker 大面积重构（AgentSessionManager 1600+ 行依赖 `IAgentRunner`）
- 风险高：改动面 ~15 个文件，包括 EdgeWorker.ts（1300+ 行）
- Paperclip 没有等价的交互式 session，其成功不可类比

**Appetite**: 3-4 weeks
**What gets cut**: 稳定性。边际收益不足以覆盖大规模重构风险。

### Option B: Scoped Adapter（只重构 DAG 路径）⭐ 推荐

**Core idea**: 只在 DAG 执行路径引入 `IAdapter`（替代 `IFlywheelRunner`），保留 `IAgentRunner` 给 Edge Worker，保留 `ISimpleAgentRunner` 给 Decision Layer。同时增强 StuckWatcher → HeartbeatService。

```typescript
// 新接口：只替代 IFlywheelRunner
interface IAdapter {
  readonly type: string;
  checkEnvironment(): Promise<AdapterHealthCheck>;
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  cleanup?(ctx: AdapterExecutionContext): Promise<void>;
}

interface AdapterExecutionContext {
  runId: string;
  issueId: string;
  prompt: string;
  cwd: string;
  previousSession?: Record<string, unknown>;  // 跨 execution 恢复
  timeoutMs: number;
  model?: string;
  permissionMode?: string;
  appendSystemPrompt?: string;
  sentinelPath?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => void;
}

interface AdapterExecutionResult {
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  sessionId: string;
  tmuxWindow?: string;
  resultText?: string;
  costUsd?: number;
  sessionParams?: Record<string, unknown>;  // 持久化到下次
}
```

**改动范围**:
- `core/src/adapter-types.ts`（新文件）
- `claude-runner/src/TmuxAdapter.ts`（新文件，wrap TmuxRunner）
- `edge-worker/src/Blueprint.ts`（`getRunner` → `getAdapter`）
- `teamlead/src/StateStore.ts`（+4 columns）
- `teamlead/src/StuckWatcher.ts` → `HeartbeatService.ts`（增强）

**不动**:
- `IAgentRunner` + `ClaudeRunner` + `AgentSessionManager`（Edge Worker 路径）
- `ISimpleAgentRunner`（Decision Layer 路径）
- `EdgeWorker.ts`（无改动）

**Pros**:
- 精准解决 DAG 路径的问题（session persistence, health check, multi-adapter）
- 改动面小（~6-8 文件 vs ~15+）
- 保留 Edge Worker 稳定性
- `IFlywheelRunner` → `IAdapter` 是自然演化，not forced unification
- 为 GEO-158 (Directive Pattern) 打好基础

**Cons**:
- 三套接口仍然存在（但职责明确）
- 未来加 Codex/Gemini interactive session 仍需要 `IAgentRunner` 的实现

**Appetite**: 1-2 weeks
**What gets cut**: Edge Worker 路径的重构（有风险，收益低）

### Option C: 最小增强（不引入新接口）

**Core idea**: 不改 `IFlywheelRunner` 接口，只在 StateStore + StuckWatcher 层添加 session persistence 和 orphan reaping。

**改动**:
- `StateStore.ts`（+4 columns: session_params, heartbeat_at, adapter_type, run_attempt）
- `StuckWatcher.ts` → 增加 orphan reaping（heartbeat_at 超时 → force status to failed）
- `Blueprint.ts`（run 前读 session_params，run 后写 session_params）

**Pros**:
- 最小改动（3 文件）
- 立即可用
- 不引入新抽象

**Cons**:
- 没有 adapter 抽象，加 Codex/Gemini runner 时还是要改多处
- 没有 health check
- `IFlywheelRunner` 的 `run(request)` 没有 previousSession 参数（需要侧加载）

**Appetite**: 3-5 days
**What gets cut**: Adapter 抽象和 health check

### Recommendation: Option B (Scoped Adapter)

**Rationale**:
1. 精准解决 issue 中描述的核心 gap（session persistence, health check, orphan reaping, multi-adapter）
2. 不碰 Edge Worker 路径，避免高风险重构
3. 为 GEO-158（Directive + FSM）和未来 Codex/Gemini adapter 打好基础
4. 1-2 周可完成，ROI 最高

## 5. Clarifying Questions

### Scope
- Q1: Edge Worker 的 `IAgentRunner` 路径是否需要在此 issue 中改动？还是保持不动，只重构 DAG 路径？
- Q2: `IFlywheelRunner` 接口是否需要保留（deprecated）一段时间，还是可以直接替换为 `IAdapter`？

### Session Persistence
- Q3: session_params 的具体内容是什么？目前 TmuxRunner 的 run() 完成后没有保留任何 agent 内部状态。Claude Code CLI 的 session resume（`--session-id`）已经在用 `sessionId`。除了 sessionId，还需要持久化什么？

### Orphan Reaping
- Q4: Orphan session 被 reap 后应该做什么？设为 `failed` + 通知 Slack？还是尝试 retry？
- Q5: Heartbeat 更新机制：TmuxRunner 如何定期向 StateStore 报告"我还活着"？是 pane_dead 检测的反向（如果 pane alive → update heartbeat_at）？

### Multi-Adapter
- Q6: 短期内除了 Claude Code CLI，还计划支持哪些 adapter？Codex、Gemini、Cursor？还是先只做 Claude？

## 6. User Decisions

**方案选择**: Option A — 全面统一（原始方案）
- 用户偏好保持 issue 原始设计，统一三套接口为 `IAdapter`
- 虽然存在 leaky abstraction 风险，用户接受这个 trade-off

**Orphan reaping**: 标记 failed + 通知 Slack
- Reap 后将 session 状态设为 `failed`，通过 webhook 通知 CEO（走现有 OpenClaw 通路）
- CEO 手动决定是否 retry

**Adapter 范围**: 先只做 Claude
- 只实现 `ClaudeCliAdapter`，验证接口设计后再扩展 Codex/Gemini

**Migration 策略**: 直接替换
- `IFlywheelRunner` 不保留 deprecated 过渡期，直接替换为 `IAdapter`
- 使用面不大（Blueprint + 测试），一步到位

**Status**: final

## 7. Suggested Next Steps

- [ ] 运行 /research 进入结构化代码研究
- [ ] 写 implementation plan
- [ ] 实施
