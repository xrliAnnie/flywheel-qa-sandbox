# Cyrus Contract Snapshot — Flywheel Compatibility Spike

**Date**: 2026-02-26
**Cyrus Version**: 0.2.24
**Flywheel Branch**: `feat/v0.1.0-core-loop`

## Executive Summary

Fork 完成，rename `@cyrus` → `@flywheel`。Build pass (14 packages)，795 tests pass (62 test files)。

Transport 包（GitHub / Linear / Slack）几乎可以直接复用（95%）。Core 需要 SDK 解耦（70% 复用）。Claude-runner 和 edge-worker 需要重写核心逻辑（20-30% 复用）。

**总体预估复用率**: ~45%（按 LOC 加权）

## IAgentRunner Interface — Gap Analysis

### Current Interface (`packages/core/src/agent-runner-types.ts`)

```typescript
interface IAgentRunner {
  readonly supportsStreamingInput: boolean;
  start(prompt: string): Promise<AgentSessionInfo>;  // { sessionId, startedAt, isRunning }
  startStreaming?(initialPrompt?: string): Promise<AgentSessionInfo>;
  addStreamMessage?(content: string): void;
  completeStream?(): void;
  isStreaming?(): boolean;
  stop(): void;
  isRunning(): boolean;
  getMessages(): AgentMessage[];     // AgentMessage = SDKMessage (Claude Agent SDK)
  getFormatter(): IMessageFormatter;
}
```

### Flywheel Target Contract

```typescript
interface IFlywheelRunner {
  run(prompt: string, opts: RunOpts): Promise<{ success: boolean; costUsd: number; sessionId: string }>;
  stop(): void;
  isRunning(): boolean;
}
```

### Gap Matrix

| Aspect | IAgentRunner | Flywheel Target | Gap |
|--------|-------------|----------------|-----|
| Execution model | In-process SDK (`query()` loop) | Spawn CLI child process | **HIGH** — completely different |
| Return type | `AgentSessionInfo { sessionId, startedAt, isRunning }` | `{ success, costUsd, sessionId }` | **MEDIUM** |
| Cost tracking | Buried in `SDKResultMessage.total_cost_usd` | First-class `costUsd` | **LOW** — extractable |
| Streaming | 5 optional methods for real-time I/O | Not applicable (CLI) | N/A |
| Message types | `AgentMessage = SDKMessage` (SDK-coupled) | CLI stdout (JSON or text) | **HIGH** |
| Formatter | `IMessageFormatter` for Linear activity rendering | Not needed | N/A |

### Decision

**不修改 `IAgentRunner`**。保留作为 reference，Phase 2 multi-runner 可能用得上。Phase 1 创建新的 `IFlywheelRunner` 接口，匹配 CLI spawn 模式。

## Per-Package Compatibility

### Transport Packages — KEEP_AS_IS (95% reuse)

| Package | LOC | Depends On | Edge-worker coupling | Verdict |
|---------|-----|------------|---------------------|---------|
| `github-event-transport` | 1,281 | `flywheel-core`, `fastify` | **None** | KEEP_AS_IS |
| `linear-event-transport` | 1,698 | `flywheel-core`, `@linear/sdk`, `fastify` | **None** | KEEP_AS_IS |
| `slack-event-transport` | 828 | `flywheel-core`, `fastify` | **None** | KEEP_AS_IS |

Transport 包是 codebase 最干净的部分。Self-contained，只依赖 core + fastify。直接用。

**`LinearIssueTrackerService`** (911 lines) 特别关键 — 提供 issue CRUD、status update、comment、label 操作，正是我们 DAG + Blueprint 需要的。

### Core — MODIFY (70% reuse)

**保留**:
- `ILogger` / `createLogger` — logging 抽象
- `PersistenceManager` — 文件级状态持久化
- `config-types.ts` / `config-schemas.ts` — Zod schema
- `issue-tracker/` — `IIssueTrackerService`, `Issue`, `Label`, `WorkflowState`
- `messages/` — 内部消息总线类型
- `constants.ts`

**需要修改**:
- `agent-runner-types.ts` — import `SDKMessage`, `HookCallbackMatcher` etc from `@anthropic-ai/claude-agent-sdk`。**Action**: SDK types 改为 optional，定义 Flywheel 自己的消息类型
- `CyrusAgentSession` → `FlywheelSession`（已 rename）

**风险**: `@anthropic-ai/claude-agent-sdk` 在 `package.json` 里是直接依赖，会拉一个大 SDK。改为 `peerDependency` 或提取 types-only。

### Claude-runner — MAJOR MODIFY (20% reuse, effectively rewrite)

**Current**: 用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 函数做 in-process 执行。`startWithPrompt()` 是 ~340 行的 async loop。

**SDK Coupling Points**:
```typescript
import { query, type CanUseTool, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
```

**保留**: Session logging infra (`.jsonl` + `.md`)、`.env` loading、MCP config parsing

**重写**: `startWithPrompt()` 整个替换为 `child_process.spawn('claude', ['--print', '--output-format', 'json', ...])`

### Edge-worker — HEAVY MODIFY (30% reuse)

**当前架构**: 5,956-line monolith，处理 webhook routing + runner selection + session lifecycle + prompt rendering + procedure orchestration。

**保留**:
- `RepositoryRouter` — issue → repo mapping
- `GitService` — Git operations
- `SharedApplicationServer` — Fastify server setup
- `UserAccessControl`
- `LinearActivitySink` / `IActivitySink`
- Prompt template loading pattern

**替换**:
- Runner instantiation（4-way if/else → single ClaudeCodeRunner）
- `RunnerSelectionService`（536 lines → ~30 lines for Phase 1）
- `AgentSessionManager`（1,984 lines）— 基于 `SDKMessage` 的 Linear activity pipeline，CLI mode 完全不适用
- Procedure/Subroutine system → 用 DAG resolver 替代
- Webhook-driven model → DAG-based dispatch

**Critical Insight**: EdgeWorker 是 sequential webhook-driven（一个 webhook → 一个 session），Flywheel 是 DAG-driven（poll → dependency graph → batch dispatch）。模型不兼容，需要新建 `BlueprintDispatcher`。

### DELETE Packages

| Package | LOC | Imported By | Safe to Delete |
|---------|-----|-------------|----------------|
| `codex-runner/` | 1,626 | edge-worker | YES (after edge-worker cleanup) |
| `cursor-runner/` | 2,343 | edge-worker | YES |
| `gemini-runner/` | 3,758 | edge-worker | YES |
| `simple-agent-runner/` | 544 | edge-worker | YES |
| `cloudflare-tunnel-client/` | 283 | edge-worker, apps/cli | YES |
| `config-updater/` | 315 | edge-worker | YES |
| `mcp-tools/` | ~100+ | edge-worker | DEFER (may port for Flywheel MCP) |
| `apps/cli/` | 504+ | none (entry point) | YES |
| `apps/f1/` | N/A | none (not copied) | Already excluded |

**Deletion Order**: 先 clean edge-worker imports → 再删包 → 更新 pnpm-workspace.yaml

## Key Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| SDK coupling in core types | HIGH | Task 2: decouple `agent-runner-types.ts`, make SDK types optional |
| EdgeWorker monolith surgery | MEDIUM | Build new BlueprintDispatcher alongside, phase out EdgeWorker methods |
| `@anthropic-ai/claude-agent-sdk` version drift | LOW | Pin version, only used for type reference in Phase 1 |
| Transport packages assume webhook-driven model | LOW | We add polling (Task 4 LinearGraphBuilder), transports still work for outbound |
| mcp-tools unclear value for CLI mode | LOW | Defer decision, keep package temporarily |

## Build & Test Status

```
Build: 14 packages — ALL PASS
Tests: 795 tests across 62 test files — ALL PASS

Key packages:
  flywheel-core:                     42 tests ✓
  flywheel-claude-runner:            63 tests ✓
  flywheel-edge-worker:             537 tests ✓
  flywheel-linear-event-transport:   18 tests ✓
  flywheel-github-event-transport:   73 tests ✓
  flywheel-slack-event-transport:    53 tests ✓
  flywheel-mcp-tools:                 9 tests ✓
```
