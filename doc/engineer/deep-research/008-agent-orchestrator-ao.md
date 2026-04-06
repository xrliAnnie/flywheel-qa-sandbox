---
source:
  - "https://pkarnal.com/blog/open-sourcing-agent-orchestrator"
  - "https://github.com/ComposioHQ/agent-orchestrator"
date: 2026-02-26
updated: 2026-02-27
author: "Piotr Karnal / ComposioHQ"
topic: "Agent Orchestrator (ao) — 可复用的开源多 Agent 编排系统"
relevance: "High — JSONL 内省代码可直接复用，Reactions pattern 可参考；但不适合替代 Cyrus 作为 base"
source_verified: true  # 2026-02-27 实际 clone 并读了核心源码
---

# Agent Orchestrator (ao): 源码级评估

## Repo Health

| 指标 | 数值 |
|------|------|
| Stars | 2,605 |
| Forks | 256 |
| License | MIT |
| Language | TypeScript (ESM, pnpm monorepo) |
| Created | 2026-02-13 (**仅 13 天历史**) |
| Last Push | 2026-02-25 |
| Contributors | 3 人 (prateek/AgentWrapper 为主) |
| Version | v0.1.0 (所有包) |
| Source .ts | ~1.48 MB, 估算 ~15K-18K LOC (core + plugins + CLI + web) |
| Tests | README 声称 3,288 test cases, ~40 test files, vitest |

**关键事实**: 大量 commit 来自 AI agent 用 ao 构建 ao（dog-fooding）。这既证明系统可用，也意味着 AI 生成代码可能有隐含质量问题。

## 核心架构: 8 Plugin Slots

| Slot | 接口 | 已有实现 | Flywheel 对应 |
|------|------|---------|--------------|
| Runtime | `Runtime` | tmux, process | 我们需要 |
| Agent | `Agent` | claude-code, codex, aider, opencode | = 我们的 `IAgentRunner` |
| Workspace | `Workspace` | worktree, clone | Cyrus 没有，ao 有 |
| Tracker | `Tracker` | GitHub, **Linear** | = 我们的 LinearGraphBuilder |
| SCM | `SCM` | GitHub (PR/CI/reviews) | Cyrus 的 github-event-transport |
| Notifier | `Notifier` | **Slack**, desktop, webhook | = 我们的 SlackActivitySink |
| Terminal | `Terminal` | iTerm2, Web | 我们没有 |
| Lifecycle | `LifecycleManager` | 状态机 + reactions | ≈ 我们的 DecisionRouter |

---

## 源码深度分析

### 1. Lifecycle Manager — Reactions 系统

**文件**: `packages/core/src/lifecycle-manager.ts` (~500 行)

15 个 session 状态 (`spawning` → `working` → `pr_open` → `ci_failed`/`review_pending` → `approved`/`mergeable` → `merged`)。基于**轮询机制** (默认 30s) 检测状态变化，触发 reactions。

YAML 配置:
```yaml
reactions:
  ci-failed:
    auto: true
    action: send-to-agent
    retries: 2
    escalateAfter: 30m
  changes-requested:
    auto: true
    action: send-to-agent
    escalateAfter: 30m
  approved-and-green:
    auto: false
    action: notify
    priority: action
  agent-stuck:
    threshold: 10m
    action: notify
    priority: urgent
```

核心执行逻辑:
```typescript
async function executeReaction(sessionId, projectId, reactionKey, reactionConfig) {
  tracker.attempts++;
  // Escalation: 超过重试次数或超时 → 通知人工
  if (tracker.attempts > maxRetries) shouldEscalate = true;
  if (escalateAfter && Date.now() - tracker.firstTriggered.getTime() > durationMs) shouldEscalate = true;
  if (shouldEscalate) {
    await notifyHuman(event, "urgent");
    return { action: "escalated", escalated: true };
  }
  switch (action) {
    case "send-to-agent": await sessionManager.send(sessionId, message); break;
    case "notify": await notifyHuman(event, priority); break;
    case "auto-merge": /* TODO: 目前只是 notify */ break;
  }
}
```

**源码评价**: 实现相当 solid — 有 re-entrancy guard，有 reaction tracker 防重复，有 escalation。但 `auto-merge` **还没实现** (fallback 到 notify)，timeout 用进程内 `Date.now()` 不是 crash-safe 的。

**已纳入 Flywheel plan**: Reactions 配置模式和 escalation pattern 已在 Round 11-16 review 中被采纳并改进 — 我们的版本增加了四元 dedup key、crash-safe timeout (基于 DB `started_at`)、显式终态。

### 2. Linear Tracker Plugin

**文件**: `packages/plugins/tracker-linear/src/index.ts` (~550 行)

实现了完整 CRUD:
```typescript
interface Tracker {
  getIssue(identifier, project): Promise<Issue>;
  isCompleted(identifier, project): Promise<boolean>;
  branchName(identifier, project): string;
  generatePrompt(identifier, project): Promise<string>;
  listIssues(filters, project): Promise<Issue[]>;
  updateIssue(identifier, update, project): Promise<void>;
  createIssue(input, project): Promise<Issue>;
}
```

**源码特点**:
- 双 transport: 直接 `LINEAR_API_KEY` 或通过 Composio SDK proxy，运行时自动选择
- 使用 GraphQL `$variables` 防注入（不是字符串拼接）
- 用 `node:https` 原生模块而不是 fetch

**源码缺陷**:
- **没有 dependency/relation 查询** — 不支持 `issue.relations { relatedIssue, type }` GraphQL
- **没有 webhook 接收** — 纯轮询模式
- **没有分页 cursor** — `listIssues` 不支持大量 issue
- State mapping 简单: Linear 6 种状态 → 4 种 (`open`, `in_progress`, `closed`, `cancelled`)

**对 Flywheel**: 可作为 **reference** — GraphQL transport 抽象和 error handling 模式可参考。但缺少 DAG 依赖查询和 webhook，不能直接用。和 Cyrus 的 `linear-event-transport` 互补（Cyrus 有 webhook，ao 有 CRUD）。

### 3. Slack Notifier Plugin

**文件**: `packages/plugins/notifier-slack/src/index.ts` (~150 行)

```typescript
function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = config?.webhookUrl as string;  // Incoming Webhook only
  return {
    notify(event) { /* POST to webhook */ },
    notifyWithActions(event, actions) { /* POST with Block Kit buttons */ },
    post(message, context?) { /* Simple text post, returns null (webhook 不返回 message ID) */ },
  };
}
```

**源码结论**: **单向 webhook-only**。不能读消息、不能维护 thread、不能双向交互。Block Kit 格式化做得不错 (priority emoji, PR links, action buttons)，但架构上**远不如 Cyrus 的 Bolt.js 实现**。

**对 Flywheel**: Block Kit 消息模板可参考，但 webhook-only 不满足双向通信需求。**不推荐使用**。

### 4. Claude Code Agent Plugin — JSONL 内省 (**最有价值**)

**文件**: `packages/plugins/agent-claude-code/src/index.ts` (~700 行)

这是 ao 最值得提取的代码。实现了对 Claude Code 内部格式的 reverse engineering:

**a) 路径编码** — 复现 Claude Code 项目路径编码:
```typescript
// toClaudeProjectPath(): ~/Dev/flywheel → ~/.claude/projects/-Users-xiaorongli-Dev-flywheel/
```

**b) JSONL tail-read** — 高效读取大文件尾部 (Claude Code session 文件可能 100MB+):
```typescript
async function parseJsonlFileTail(filePath, maxBytes = 131_072) {
  const { size } = await stat(filePath);
  if (size > maxBytes) {
    const handle = await open(filePath, "r");
    const buffer = Buffer.allocUnsafe(size - offset);
    await handle.read(buffer, 0, length, offset);
    // Skip first (potentially truncated) line
  }
}
```

**c) Activity Detection** — 双通道:
- Terminal output 模式匹配 (`classifyTerminalOutput`)
- JSONL 最新条目类型 (`getActivityState`)

**d) Cost Estimation** — 从 JSONL 聚合:
```typescript
function extractCost(lines) {
  for (const line of lines) {
    if (typeof line.costUSD === "number") totalCost += line.costUSD;
    if (line.usage) {
      inputTokens += line.usage.input_tokens ?? 0;
      // + cache_read + cache_creation tokens
    }
  }
}
```

**e) PostToolUse Hook** — 注入 `.claude/settings.json` 的 bash hook:
```bash
# 自动检测 gh pr create → 写入 PR URL 到 metadata
# 自动检测 git checkout -b → 写入 branch
# 自动检测 gh pr merge → 写入 status=merged
```

**f) 进程检测** — 通过 `ps -eo pid,tty,args` + tmux pane TTY 查找 claude 进程

**对 Flywheel**: **可直接 copy-paste** (~200 行)。以下函数在 Phase 3 agent-stuck 检测和 cost tracking 中必须做同样的事:
- `toClaudeProjectPath()` (20 行)
- `parseJsonlFileTail()` (30 行)
- `extractSummary()` (15 行)
- `extractCost()` (30 行)
- `findClaudeProcess()` (40 行)
- PostToolUse metadata hook (~100 行 bash)

### 5. Plugin Registry

**文件**: `packages/core/src/plugin-registry.ts` (~120 行)

简单的 Map-based registry with dynamic import。16 个内置插件，key = `"slot:name"`。

**源码评价**: 功能有限 — 没有 lifecycle hooks (init/destroy)、没有 DI、没有运行时 plugin 加载 (`loadFromConfig` 是空的 TODO)。对 MVP 足够，但扩展能力弱。

**对 Flywheel**: 参考价值有限。`satisfies PluginModule<T>` 模式值得借鉴（编译时类型检查），但 Cyrus 的 package 结构更匹配我们的需求。

---

## 代码质量评估

**优点**:
- TypeScript strict mode, ESLint enforced no-any
- `import type` enforced
- Zod schema validation
- Shell 安全: `execFile` (not `exec`)
- `types.ts` 1,086 行, 8 plugin slot 完整 interface + const enum patterns
- Core 只有 2 个 runtime 依赖 (yaml, zod)

**缺点**:
- 所有包 v0.1.0，13 天历史，未经生产验证
- Stateless 架构 — flat key=value 文件存 metadata，没有数据库，并发/crash recovery 可能有问题
- 大量 `catch { }` 空 catch（吞错误）
- Web dashboard 没有 auth/authz
- `auto-merge` 未实现, `loadFromConfig` 是 TODO

**整体评价**: 代码质量好（strict TS, 干净 interface），但处于 **原型-到-MVP 阶段**。

---

## Flywheel 决策汇总

### 不换 base (保持 Cyrus fork)

| 维度 | ao 缺失 | Cyrus 提供 |
|------|---------|-----------|
| 双向 Slack | webhook-only | Bolt.js 双向 |
| Linear webhook | 无 | 有 event transport |
| Agent SDK | 无 (terminal-based) | `claude-runner` |
| DAG | 无 | 无 (但 edge-worker 可扩展) |
| 成熟度 | 13 天, v0.1.0 | 产品级 |

### Cherry-pick 清单

| 组件 | 复用方式 | Phase | 价值 |
|------|---------|-------|------|
| JSONL 内省 (~200 LOC) | **直接复用** | Phase 3 | agent-stuck 检测 + cost tracking |
| PostToolUse Hook (~100 LOC bash) | **直接复用** | Phase 3 | 自动捕获 PR URL / branch / merge |
| Reactions escalation pattern | **参考** | Phase 2 (已纳入) | retries + timeout → escalate |
| 15-state 状态机 | **参考** | Phase 2+ | session lifecycle 建模 |
| Block Kit 消息模板 | **参考** | Phase 2 | Slack notification 格式 |
| Linear GraphQL fragments | **参考** | Phase 1 | issue CRUD 查询模式 |
| `satisfies PluginModule<T>` | **参考** | Phase 2+ | 编译时插件类型检查 |

### 我们有而 ao 没有的 (Flywheel 差异化)

1. **依赖 DAG** — ao 的 issues 互相独立，没有 blocking 关系
2. **Decision Layer** — ao 靠人手动处理所有决策；我们有 CIPHER + dual-gate 学习
3. **Blueprint 混合编排** — ao 把整个 issue 交给 agent；我们的确定性+agent 混合节省 token
4. **Pre-hydration** — ao 不做 context 预加载
5. **Cost learning** — ao 没有预算学习
6. **Crash-safe reactions** — ao 的 timeout 用进程内 `Date.now()`；我们用 DB `started_at`
