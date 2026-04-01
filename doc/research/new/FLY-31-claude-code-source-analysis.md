# Research: Claude Code 源码分析 — FLY-31

**Issue**: FLY-31
**Date**: 2026-03-31
**Source**: `/Users/xiaorongli/Dev/claude-code/` (本地克隆)

## Executive Summary

Claude Code 的多 agent 架构比 Flywheel 当前的 bash + SQLite orchestrator 复杂得多，但核心通信机制出奇地简单——**基于文件的 mailbox + file locking**。Agent Team 支持三种 backend（tmux / iTerm2 / in-process），通过 `~/.claude/teams/` 目录下的 JSON 文件管理状态，通过 `~/.claude/tasks/` 管理任务。最有价值的发现是：(1) Channel 系统通过 MCP notification 注入消息，Flywheel 的 Discord 通信可以直接复用这套模式；(2) auto-compact 和 session memory 的完整实现可以指导 Flywheel Lead 的 context window 管理；(3) hook 系统的 `additionalContext` 注入机制已被 Flywheel 用于 inbox-check.sh，但还有更多可利用空间。

---

## 1. Agent Team 架构

### 1.1 发现

Claude Code 的 Agent Team（内部称为 "swarm"）通过以下工具实现多 agent 协调：

| Tool | 用途 |
|------|------|
| `TeamCreateTool` | 创建 team，生成 config.json |
| `SendMessageTool` | Agent 间发消息（支持单播、广播、shutdown） |
| `TaskCreateTool` / `TaskUpdateTool` / `TaskListTool` | 任务分配与追踪 |
| `AgentTool` | 生成子 agent（subagent 或 teammate） |
| `TeamDeleteTool` | 清理 team 资源 |

**Team 的本质**是一个 **leader + N members** 结构：
- Leader 是创建 team 的 session
- Members 通过 `AgentTool` + `name` 参数 spawn
- **扁平结构**：members 不能再 spawn 其他 teammates（line 273: "Teammates cannot spawn other teammates — the team roster is flat"）

**三种 Backend**:

| Backend | 运行方式 | 通信 | 隔离 |
|---------|---------|------|------|
| `tmux` | 独立 OS 进程（tmux pane） | 文件 mailbox | 完全隔离 |
| `iterm2` | 独立 OS 进程（iTerm2 pane） | 文件 mailbox | 完全隔离 |
| `in-process` | 同一 Node.js 进程 | 文件 mailbox + AppState queue | AsyncLocalStorage 隔离 |

### 1.2 关键数据结构

**TeamFile**（存储在 `~/.claude/teams/{team_name}/config.json`）:
```typescript
type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string              // "team-lead@teamName"
  leadSessionId?: string
  members: Array<{
    agentId: string                // "name@teamName"
    name: string
    agentType?: string
    model?: string
    prompt?: string
    color?: string
    joinedAt: number
    tmuxPaneId: string
    cwd: string
    worktreePath?: string
    sessionId?: string
    subscriptions: string[]
    backendType?: 'tmux' | 'iterm2' | 'in-process'
    isActive?: boolean
    mode?: PermissionMode
  }>
}
```

**Task**（存储在 `~/.claude/tasks/{task_list_id}/{task_id}.json`）:
```typescript
type Task = {
  id: string                       // "1", "2", etc (high water mark)
  subject: string
  description: string
  activeForm?: string              // 进行中的动态描述
  owner?: string                   // Agent name
  status: 'pending' | 'in_progress' | 'completed'
  blocks: string[]                 // 阻塞其他 task 的 ID
  blockedBy: string[]              // 被阻塞的 task ID
  metadata?: Record<string, unknown>
}
```

### 1.3 代码位置

| 组件 | 文件 | 关键行 |
|------|------|--------|
| TeamCreate | `src/tools/TeamCreateTool/TeamCreateTool.ts` | call() @ 128 |
| SendMessage | `src/tools/SendMessageTool/SendMessageTool.ts` | call() @ 741 |
| Task 管理 | `src/utils/tasks.ts` | getTaskListId() @ 199, createTask() @ 284 |
| In-Process Spawn | `src/utils/swarm/spawnInProcess.ts` | spawnInProcessTeammate() @ 104 |
| In-Process Runner | `src/utils/swarm/inProcessRunner.ts` | startInProcessTeammate() |
| Mailbox | `src/utils/teammateMailbox.ts` | writeToMailbox() @ 134 |
| Team Helpers | `src/utils/swarm/teamHelpers.ts` | TeamFile 类型 @ 64-90 |
| Backend Registry | `src/utils/swarm/backends/types.ts` | BackendType @ 9 |

### 1.4 对 Flywheel 的价值

**高价值**：
- **任务阻塞图**（Task.blocks / Task.blockedBy）比 Flywheel Orchestrator 的 SQLite state 更灵活，支持动态依赖关系
- **AgentId 格式**（`name@teamName`）可以直接复用于 Lead/Runner 的唯一标识
- **File locking**（proper-lockfile, 10 retries, 5-100ms backoff）——Flywheel 的 flywheel-comm 用 WAL 模式 SQLite 做并发控制，但如果迁移到文件 inbox，这个策略值得参考

**中等价值**：
- In-process teammate 用 AsyncLocalStorage 做上下文隔离——Flywheel 的 Lead 和 Runner 是独立进程，不需要这个模式
- Team Memory Sync（`src/services/teamMemorySync/`）把 team 级 memory 同步到 Claude.ai 后端——Flywheel 用 Supabase pgvector 做 memory，但同步协议值得参考

**本质区别**：
- Claude Code 的 Team 是**临时的**（session 级生命周期），而 Flywheel 的 Orchestrator 是**持久的**（跨 session）
- Claude Code 的 agent 间通信是**文件 IPC**，Flywheel 用 **SQLite WAL**（flywheel-comm）——SQLite 在并发读写和查询能力上更强

---

## 2. Agent 通信机制

### 2.1 Channel 系统（`--channels discord`）

Channel 是 Claude Code 接收外部推送消息的标准机制。实现流程：

```
MCP Plugin (e.g., Discord)
  → 发送 notifications/claude/channel 通知
  → MCP Client 接收 notification
  → gateChannelServer() 7 层安全检查
  → wrapChannelMessage() 包装为 <channel source="discord" ...meta...>content</channel>
  → enqueue({ mode: 'prompt', value: wrapped, priority: 'next' })
  → Model 看到 channel-wrapped 消息作为下一个 prompt
  → Model 用 MCP tool 回复
```

**7 层 Gate**（`src/services/mcp/channelPermissions.ts:191-315`）:
1. Server 声明 `capabilities.experimental['claude/channel']`
2. Runtime feature gate（`tengu_harbor`）
3. OAuth token 存在
4. Org policy 允许
5. `--channels` flag allowlist
6. Marketplace 版本匹配
7. GrowthBook / org allowlist

**消息格式**:
```typescript
// channelNotification.ts
{
  method: 'notifications/claude/channel',
  params: {
    content: string,
    meta?: Record<string, string>  // thread_id, user, etc.
  }
}
```

### 2.2 Teammate 通信（文件 Mailbox）

Team 内 agent 间通信通过 **文件 mailbox**：

```
~/.claude/teams/{teamName}/inboxes/{agentName}.json
```

**TeammateMessage**:
```typescript
{
  from: string
  text: string
  timestamp: string
  read: boolean
  color?: string
  summary?: string        // 5-10 word preview
}
```

**结构化消息类型**：
- `shutdown_request` / `shutdown_response` — 优雅关闭
- `plan_approval_response` — Leader 批准/拒绝 plan
- Permission requests/responses — Worker 请求权限

**投递路径**：
- In-process teammate: 直接写入 `AppState.pendingUserMessages` 队列
- Process-based teammate: 写入文件 mailbox
- Remote peer: 通过 bridge messages

**轮询频率**：
- Inbox poller: 1000ms（`useInboxPoller.ts:107`）
- Permission poller: 500ms（`useSwarmPermissionPoller.ts:28`）

### 2.3 Coordinator Mode

`src/coordinator/coordinatorMode.ts` 是 Agent Team 的替代模式：
- 通过 `CLAUDE_CODE_COORDINATOR_MODE` env var 激活
- 主 agent 自动扮演 orchestrator，spawn worker agents
- Worker 只能用受限工具集（Bash, Read, Edit 或 ASYNC_AGENT_ALLOWED_TOOLS 子集）
- 有 **shared scratchpad**（跨 worker 的持久存储目录）

### 2.4 代码位置

| 组件 | 文件 | 关键行 |
|------|------|--------|
| Channel Notification | `src/services/mcp/channelNotification.ts` | 37-116 |
| Channel Gating | `src/services/mcp/channelPermissions.ts` | 191-315 |
| MCP Handler 注册 | `src/services/mcp/useManageMCPConnections.ts` | 470-603 |
| Inbox Poller | `src/hooks/useInboxPoller.ts` | 107-600+ |
| Mailbox Bridge | `src/hooks/useMailboxBridge.ts` | 1-22 |
| Coordinator Mode | `src/coordinator/coordinatorMode.ts` | 36-110 |
| Teammate Mailbox | `src/utils/teammateMailbox.ts` | 43-192 |

### 2.5 对 Flywheel 的价值

**高价值**：
- **Channel 消息格式**（`<channel>` XML tag wrapping）是 Flywheel Lead 收到 Discord 消息的标准格式。了解这个格式有助于 debug Lead 行为
- **结构化消息类型**（shutdown_request 等）——Flywheel 的 flywheel-comm 可以借鉴，加入 `directive_type` 字段
- **Coordinator Mode 的 shared scratchpad** 概念——类似 Flywheel Orchestrator 的 `~/.flywheel/orchestrator/` 共享状态

**低价值**：
- 文件 mailbox + polling 机制——Flywheel 的 SQLite WAL + PostToolUse hook 方案更可靠（支持查询、过期、持久化）

---

## 3. Session / Context 管理

### 3.1 Auto-Compact

**触发条件**（`src/services/compact/autoCompact.ts`）:
- 计算公式：`effectiveContextWindow = modelContextWindow - min(outputTokens, 20000)`
- **Auto-compact 触发点**：tokens > `effectiveContextWindow - 13,000`
- **Warning 阈值**：tokens > `effectiveContextWindow - 20,000`
- **Error 阈值**：接近 blocking limit

**关键常量**:
```typescript
AUTOCOMPACT_BUFFER_TOKENS = 13,000      // 距离上限 13K 时触发
WARNING_THRESHOLD_BUFFER_TOKENS = 20,000 // 距离上限 20K 时警告
MANUAL_COMPACT_BUFFER_TOKENS = 3,000     // 手动 /compact 阈值
```

**两种压缩策略**:

1. **Session Memory Compaction**（首选，`sessionMemoryCompact.ts`）:
   - 保留最近 10K-40K tokens 的消息原文
   - 早期消息提取为 session memory summary
   - 不破坏 tool_use / tool_result 配对（自动调整边界）
   - 从 `lastSummarizedMessageId` 标记点开始

2. **Legacy Compaction**（fallback，`compact.ts`）:
   - Fork 一个无工具 agent 生成摘要
   - Strip images 防止 prompt 超限
   - 替换早期消息为摘要

**Circuit breaker**: 连续 3 次 compact 失败后停止重试

**环境变量覆盖**: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 可设百分比阈值

### 3.2 Session 恢复

**Session ID**（`src/bootstrap/state.ts`）:
- 每个 session 一个 `randomUUID()`
- 支持 parent-child 关系（`parentSessionId`）
- `switchSession(sessionId, projectDir)` **原子切换**（session ID + project dir 不分离）

**Transcript 存储**:
```
~/.claude/projects/<hash>/<sessionId>.jsonl
```

**恢复流程**:
1. `switchSession()` 原子切换到目标 session
2. 加载 `.jsonl` transcript
3. 执行 `processSessionStartHooks('resume')`
4. 恢复 CLAUDE.md 和 context

### 3.3 Token 估算

**精确计算**（`tokenEstimation.ts:124-201`）:
- 调用 Claude API 的内置 token counter
- 处理 thinking blocks（TOKEN_COUNT_THINKING_BUDGET = 1024）
- 支持 Bedrock / Vertex

**粗略估算**:
- 默认：`content.length / 4`（4 bytes/token）
- JSON/JSONL：`content.length / 2`（2 bytes/token，语法密集）
- Image/Document：固定 2000 tokens
- Tool_use：序列化为 JSON 后按文本计算

### 3.4 Session Memory

**Auto Memory 系统**（`src/memdir/`）:
- 入口文件：`MEMORY.md`（max 200 lines, 25KB）
- 目录：`~/.claude/projects/<hash>/memory/`
- Feature gate: `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 可关闭

**提取频率**（`src/services/SessionMemory/sessionMemoryUtils.ts`）:
```typescript
minimumMessageTokensToInit: 10000   // 首次提取需累计 10K tokens
minimumTokensBetweenUpdate: 5000    // 每增长 5K tokens 提取一次
toolCallsBetweenUpdates: 3          // 或每 3 次 tool call
```

**互斥规则**: 如果主 agent 在本 turn 已写入 memory 文件，background extraction 跳过该范围

### 3.5 代码位置

| 组件 | 文件 | 关键行 |
|------|------|--------|
| Auto-Compact 触发 | `src/services/compact/autoCompact.ts` | 33-145 |
| Session Memory Compact | `src/services/compact/sessionMemoryCompact.ts` | 324-630 |
| Legacy Compact | `src/services/compact/compact.ts` | 18-56 |
| Post-Compact Cleanup | `src/services/compact/postCompactCleanup.ts` | 31-77 |
| Session State | `src/bootstrap/state.ts` | 100-479 |
| Token Estimation | `src/services/tokenEstimation.ts` | 124-435 |
| Memory Paths | `src/memdir/paths.ts` | 30-150 |
| Memory Extraction | `src/services/SessionMemory/sessionMemory.ts` | 80-150 |

### 3.6 对 Flywheel 的价值

**高价值**：
- **Auto-compact 阈值策略**（13K buffer, 20K warning）——Flywheel 的 PostCompact hook（GEO-285）可以参考这些精确数值来优化 Lead 的 context 管理
- **Session Memory Compaction 的边界对齐**（不破坏 tool_use/tool_result 配对）——这是一个 Flywheel 目前没有处理的 edge case
- **Token 估算公式**（4 bytes/token default, 2 for JSON）——可以用在 flywheel-comm 的消息大小预估

**中等价值**：
- Session 恢复的原子切换——Flywheel Lead 的 crash recovery supervisor（GEO-285）已实现类似功能，但可以参考 `switchSession()` 的原子性保证

---

## 4. Hook 系统

### 4.1 Hook 类型和生命周期

**Hook 事件**（从 `src/utils/hooks.ts` 推导）:

| Event | 触发时机 | 可返回 |
|-------|---------|--------|
| `PreToolUse` | Tool call 之前 | allow / deny / additionalContext |
| `PostToolUse` | Tool call 之后 | additionalContext |
| `Notification` | 通知事件 | — |
| `Stop` | Session 结束 | — |

### 4.2 AdditionalContext 注入机制

**核心实现**（`hooks.ts:2783-2788`）:
```typescript
if (result.additionalContext) {
  logForDebugging(
    `Hook ${hookEvent} (${getHookDisplayText(result.hook)}) provided additionalContext (${result.additionalContext.length} chars)`,
  )
  // additionalContexts 数组注入到下一个 prompt
  additionalContexts: [result.additionalContext],
}
```

**Hook 输出格式**（JSON stdout）:
```json
{
  "hookSpecificOutput": {
    "additionalContext": "string content to inject"
  }
}
```

**Hook 输入结构**（`hooks.ts:347-367`）:
```typescript
{
  toolName: string
  toolInput: object
  additionalContext?: string      // 之前 hook 注入的 context
  additionalContexts?: string[]   // 多个 hook 注入的 context 数组
}
```

### 4.3 Hook 加载和配置

- 从 `settings.json` 的 `hooks` 字段加载
- 通过 `captureHooksConfigSnapshot()` 在 session 启动时快照
- 支持通过 SDK 的 `sessionHooks.ts` 编程注册
- Agent definition 的 `hooks` 字段可以添加 agent-scoped hooks

### 4.4 代码位置

| 组件 | 文件 | 关键行 |
|------|------|--------|
| Hook 执行引擎 | `src/utils/hooks.ts` | 299-400 (executeHooks), 4157-4192 (permission hooks) |
| AdditionalContext 处理 | `src/utils/hooks.ts` | 621-652 (提取), 2783-2788 (注入) |
| Hook Input Schema | `src/utils/hooks.ts` | 347-367 |
| Permission Hooks | `src/utils/hooks.ts` | 4157-4192 |

### 4.5 对 Flywheel 的价值

**高价值**：
- Flywheel 的 `inbox-check.sh`（GEO-266）已利用 PostToolUse + additionalContext 注入——完全对齐 Claude Code 的设计
- **PreToolUse hook 可以实现 tool-level 权限控制**——Flywheel Lead 可以用 PreToolUse hook 限制 Runner 的危险操作
- **Agent-scoped hooks**（agent definition 的 hooks 字段）——Flywheel 的 Lead agent.md 可以内嵌 hook 定义，不需要全局配置

**中等价值**：
- Hook 的 JSON stdout 协议——Flywheel 的 hook 脚本已遵循这个协议

---

## 5. Tool / MCP 系统

### 5.1 MCP Server 管理

**配置来源**:
1. `.mcp.json`（项目根目录）
2. `~/.claude/settings.json`（用户级）
3. Managed settings（企业级）
4. `--mcp-config` CLI flag
5. Agent definition 的 `mcpServers` 字段

**Agent MCP Servers**（`src/tools/AgentTool/runAgent.ts:95-100`）:
- Agent 可以定义自己的 MCP servers（在 frontmatter 中）
- **Additive**: 合并到 parent 的 MCP clients 上
- Agent 结束时自动清理

**MCP 连接管理**（`src/services/mcp/`）:
- `MCPConnectionManager.tsx` 管理生命周期
- `client.ts` 实现连接（10,000+ lines）
- 支持 stdio / HTTP / SSE / WebSocket 传输

### 5.2 Tool Permission Model

**权限检查流程**（`src/utils/permissions/permissions.ts:473`）:

```
hasPermissionsToUseTool()
  → hasPermissionsToUseToolInner()  // 初始判断
  → 根据 mode 转换:
      dontAsk → convert 'ask' to 'deny'
      auto    → AI classifier 判断
      plan    → delegate
      regular → 弹 prompt
  → AcceptEdits fast-path (safe file ops)
  → Safe-tool allowlist
  → Return: 'allow' | 'deny' | 'ask'
```

**权限存储**: `settings.json` 的 `permissions` 字段
```
"Bash(git:*)"     → 只允许 git 命令
"Edit(*.md)"      → 只允许编辑 markdown
"*"               → 全部允许
```

### 5.3 Agent 文件加载

**`--agent` flag 处理**（`src/main.tsx`）:
1. Line 1115: 提取 `options.agent`
2. Line 1116-1118: 设置 `CLAUDE_CODE_AGENT` env var
3. Line 1929-2029: 加载 agent definitions（`getAgentDefinitionsWithOverrides()`）
4. Line 2056-2065: 匹配 agent definition
5. Line 2140-2173: 注入到 system prompt：
   ```typescript
   const customInstructions = `\n# Custom Agent Instructions\n${customPrompt}`;
   appendSystemPrompt = appendSystemPrompt ? 
     `${appendSystemPrompt}\n\n${customInstructions}` : customInstructions;
   ```

**Agent Definition 结构**（`src/tools/AgentTool/loadAgentsDir.ts:106-133`）:
```typescript
{
  agentType: string           // 唯一标识
  whenToUse: string           // 描述
  tools?: string[]            // 允许的工具列表
  disallowedTools?: string[]  // 禁止的工具列表
  skills?: string[]           // 允许的 skill
  mcpServers?: Record<string, McpServerConfig>  // Agent 私有 MCP
  hooks?: HooksSettings       // Agent-scoped hooks
  model?: string              // 模型覆盖
  effort?: string             // 努力级别
  permissionMode?: string     // 权限模式
  memory?: object             // 持久化 memory scope
  isolation?: 'worktree' | 'remote'  // 隔离模式
}
```

**`--append-system-prompt-file` 注入**（`main.tsx:1364-1382`）:
- 读取文件内容
- 追加到 system prompt 末尾
- 不能和 `--append-system-prompt` 同时使用

### 5.4 代码位置

| 组件 | 文件 | 关键行 |
|------|------|--------|
| MCP Config | `src/services/mcp/config.ts` | 62-150 |
| MCP Client | `src/services/mcp/client.ts` | 大文件（10K+ lines） |
| Permission Check | `src/utils/permissions/permissions.ts` | 473-700 |
| Agent Loading | `src/tools/AgentTool/loadAgentsDir.ts` | 106-200 |
| Agent MCP Init | `src/tools/AgentTool/runAgent.ts` | 95-100 |
| System Prompt Build | `src/utils/systemPrompt.ts` | — |

### 5.5 对 Flywheel 的价值

**高价值**：
- **Agent-scoped MCP servers**——Flywheel Lead 可以为每个 Lead 配置独立的 MCP servers（已经在做，但这确认了方向）
- **Agent Definition 的 `disallowedTools` 字段**——Flywheel 的 Lead agent 已经用这个（GEO-234），对齐 Claude Code
- **`--append-system-prompt-file` 机制**——Flywheel 的 `claude-lead.sh` 已使用这个注入 common-rules.md + department-lead-rules.md（FLY-26），完全匹配

**中等价值**：
- Permission rule 的 glob 语法（`Bash(git:*)`）——Runner 可以用这种模式限制危险操作

---

## 6. CLI 启动流程

### 6.1 完整启动链

```
cli.tsx:main()
  ├── Fast path: --version (零模块加载)
  ├── Fast path: --dump-system-prompt
  ├── Special: --claude-in-chrome-mcp / --chrome-native-host / --computer-use-mcp
  ├── Special: remote-control / rc / remote / sync / bridge
  ├── Special: daemon mode
  └── Normal path:
      ├── init.ts:init()
      │   ├── 启用 config 系统
      │   ├── 安全环境变量
      │   ├── OAuth / JetBrains / GitHub 检测
      │   ├── Remote managed settings
      │   └── mTLS / proxy 配置
      ├── main.tsx: Commander.js program
      │   ├── 解析 --agent → CLAUDE_CODE_AGENT env var
      │   ├── 解析 --channels → ChannelEntry[]
      │   ├── 解析 --mcp-config → merge configs
      │   ├── 解析 --append-system-prompt-file → 读文件内容
      │   ├── 设置 permission mode
      │   └── 加载 agent definitions
      ├── Trust dialog
      ├── Setup screens
      └── Start REPL
```

### 6.2 关键参数影响

| 参数 | 影响 |
|------|------|
| `--agent <name>` | 设 CLAUDE_CODE_AGENT env var → 匹配 agent definition → 注入 system prompt |
| `--agent-id <id>` | 设置 agentId 标识（用于 team 内识别） |
| `--team-name <name>` | 激活 swarm 模式，设 team context |
| `--parent-session-id <id>` | 关联 parent session（用于 session 树追踪） |
| `--session-id <id>` | 恢复指定 session（加载 transcript） |
| `--channels <servers>` | 注册 MCP server 的 channel notification |
| `--dangerously-skip-permissions` | 跳过所有权限检查 |
| `--append-system-prompt-file <path>` | 注入额外 system prompt |
| `--mcp-config <json-or-path>` | 追加 MCP server 配置 |

### 6.3 代码位置

| 组件 | 文件 | 关键行 |
|------|------|--------|
| Entry | `src/entrypoints/cli.tsx` | main() @ 33 |
| Init | `src/entrypoints/init.ts` | init() @ 57-151 |
| Main Setup | `src/main.tsx` | 1000-2230 |
| Agent Flag | `src/main.tsx` | 1115-1118, 1929-2029, 2056-2065 |
| Channel Parsing | `src/main.tsx` | 1635-1710 |
| Permission Setup | `src/main.tsx` | 1390-1398 |

### 6.4 对 Flywheel 的价值

**高价值**：
- Flywheel 的 `claude-lead.sh` 组装的参数（`--agent`, `--channels`, `--append-system-prompt-file`, `--session-id`）现在有了完整的理解链路
- 知道 `--agent` 注入发生在 system prompt 末尾（line 2140-2173），可以指导 agent.md / identity.md 的优先级排列

---

## 7. 其他有价值的发现

### 7.1 DreamTask（自动 Memory 整合）

`src/tasks/DreamTask/DreamTask.ts`——background memory consolidation agent：
- 在 idle 时自动运行
- 四阶段流程：orient → gather → consolidate → prune
- 有 circuit breaker（consolidation lock）

**对 Flywheel 的价值**: 可以参考这种模式让 Lead 在 idle 时自动整理 memory

### 7.2 Worktree 管理

`src/utils/worktree.ts`——Agent 可以在 git worktree 中隔离运行：
- 支持 `isolation: 'worktree'` 参数
- 自动创建/清理 worktree
- 通过 `hasWorktreeChanges()` 检测是否有改动

**对 Flywheel 的价值**: Flywheel Orchestrator 已有类似功能，但 Claude Code 的 worktree slug 验证（防止 path traversal）值得参考

### 7.3 Agent Summary Service

`src/services/AgentSummary/`——Agent 完成后自动生成摘要：
- `startAgentSummarization()` 在 agent 结束时触发
- 用于向 parent 报告结果

**对 Flywheel 的价值**: Flywheel 的 session_completed 事件可以借鉴这种自动摘要模式

### 7.4 Remote Agent Task

`src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`——在远程 CCR 环境运行 agent：
- `checkRemoteAgentEligibility()` 检查是否可以远程执行
- 支持 `isolation: 'remote'` 参数
- 通过 bridge 通信

**对 Flywheel 的价值**: 长期可能用于跨机器执行 Runner

### 7.5 Tool 搜索与延迟加载

`src/tools/ToolSearchTool/`——Tool 可以延迟加载（deferred tools）：
- 只在 system prompt 中列出名称
- 实际 schema 在 `ToolSearch` 时才获取
- 减少初始 system prompt 大小

**对 Flywheel 的价值**: 如果 Lead 的工具太多导致 context 膨胀，可以参考这种 deferred loading 模式

---

## 8. 可复用能力清单

| 能力 | Claude Code 实现 | Flywheel 当前 | 建议 Action |
|------|-----------------|--------------|-------------|
| Agent 间消息 | 文件 mailbox + file locking | flywheel-comm SQLite WAL | **保持现状**——SQLite 更适合 Flywheel 的查询+持久化需求 |
| Task 依赖图 | Task.blocks / Task.blockedBy（JSON 文件） | Orchestrator SQLite state | **考虑采用**——给 orchestrator 加 blocks/blockedBy 字段 |
| AgentId 格式 | `name@teamName` | `product-lead` / `ops-lead` | **考虑采用**——统一为 `peter@geoforge3d` 格式 |
| Auto-compact 阈值 | 13K buffer, 20K warning | PostCompact hook（GEO-285） | **参考数值**——优化 Lead context warning 策略 |
| Session Memory Compact | 保留最近 10K-40K tokens，提取 summary | 无 | **新 feature**——Lead long-running session 需要 |
| Channel 消息格式 | `<channel>` XML wrapping | Discord MCP plugin 原生 | **已对齐**——无需改动 |
| Agent-scoped hooks | Agent definition 的 hooks 字段 | settings.json 全局 hooks | **考虑采用**——per-Lead hook 配置 |
| Agent-scoped MCP | Agent definition 的 mcpServers | claude-lead.sh --mcp-config | **已对齐**——Terminal MCP（FLY-11）|
| Tool deferred loading | ToolSearch 延迟 schema | 无 | **长期考虑**——如果 Lead 工具太多 |
| DreamTask（idle 整合）| 4 阶段 memory consolidation | 无 | **新 feature idea**——Lead idle 时整理 memory |
| Structured shutdown | shutdown_request/response | SIGTERM | **考虑采用**——优雅 Lead 关闭协议 |
| Permission glob | `Bash(git:*)` pattern | disallowedTools 列表 | **低优先**——当前够用 |
| Token 估算 | 4 bytes/token default | 无估算 | **考虑采用**——flywheel-comm 消息预估 |
| Worktree slug 验证 | Path traversal 防护 | sanitizeTmuxName | **已有类似**——可以加强 |

---

## 9. Follow-up Issues（建议）

| 优先级 | 建议 Issue | 描述 |
|--------|-----------|------|
| P1 | FLY-32: Task 依赖图 | 给 Orchestrator 加 blocks/blockedBy 字段，支持动态依赖 |
| P1 | FLY-33: Lead Context Compact 策略 | 参考 Claude Code 的 13K/20K 阈值，优化 Lead 的 PostCompact hook |
| P2 | FLY-34: Lead Session Memory Extraction | 实现类似 Claude Code 的 session memory compaction，自动提取早期 context |
| P2 | FLY-35: Structured Shutdown Protocol | 用 flywheel-comm 实现 shutdown_request/response，替代 SIGTERM |
| P3 | FLY-36: Lead Idle Memory Consolidation | 参考 DreamTask，Lead 空闲时自动整理 memory |
| P3 | FLY-37: AgentId 统一格式 | 采用 `name@project` 格式统一 Lead/Runner 标识 |
| Low | FLY-38: Token 估算工具 | 在 flywheel-comm 中加入消息 token 估算 |
