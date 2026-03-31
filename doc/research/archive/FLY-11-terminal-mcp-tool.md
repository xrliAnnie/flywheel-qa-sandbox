# Research: Terminal Observation MCP Tool — FLY-11

**Issue**: FLY-11
**Date**: 2026-03-31
**Source**: `doc/exploration/new/FLY-11-terminal-mcp-tool.md`

---

## 1. Annie 确认的方向

| 决策 | 选择 | 理由 |
|------|------|------|
| Read/Write | **Read-only**（Phase 1） | Write 需要 agent status detection 作为前置条件 |
| 架构 | **Option A**（flywheel-comm CLI + thin MCP wrapper） | 复用现有通信层，CLI 可独立测试 |
| Tool 粒度 | **3 个 tool**（capture + list + search） | capture+list 是 P0，search 实现简单且实用 |
| 数据模式 | **Snapshot**（快照） | Agent 用快照够了，MCP 原生支持 request-response |

## 2. 现有代码分析

### 2.1 flywheel-comm 架构

```
packages/flywheel-comm/
├── src/
│   ├── index.ts          # CLI 入口 (parseArgs, switch/case)
│   ├── db.ts             # CommDB class (better-sqlite3, WAL mode)
│   ├── lib.ts            # Library export (CommDB re-export)
│   ├── types.ts          # Session, Message, CheckResult
│   ├── resolve-db-path.ts
│   ├── commands/
│   │   ├── ask.ts        # Runner → Lead 提问
│   │   ├── check.ts      # Runner 检查回复
│   │   ├── pending.ts    # Lead 查看待答
│   │   ├── respond.ts    # Lead 回答
│   │   ├── send.ts       # Lead → Runner 指令
│   │   ├── inbox.ts      # Runner 收指令
│   │   ├── sessions.ts   # 列出 session
│   │   ├── capture.ts    # tmux capture-pane
│   │   └── stage.ts      # Pipeline stage 上报
│   └── __tests__/        # 7 test files
└── package.json          # deps: better-sqlite3
```

**关键模式**：
- 每个 command 是独立文件，export 一个函数
- 函数接收 typed args，return 结果（不做 console.log）
- `index.ts` 负责 parseArgs + console output + error handling
- CommDB 通过 `resolveDbPath()` 统一解析路径
- 同步操作为主（`execFileSync`），stage 是唯一的 async command

### 2.2 capture.ts 实现（模板）

```typescript
// 40 行，极简
export function capture(args: CaptureArgs): string {
  // 1. Check DB exists
  // 2. Open CommDB (read-only mode)
  // 3. getSession(execId) → get tmux_window target
  // 4. execFileSync("tmux", ["capture-pane", "-t", target, "-p", "-S", `-${lines}`])
  // 5. Return raw text
}
```

新 command（search, info）将沿用这个模式。

### 2.3 sessions.ts 实现

```typescript
// 24 行
export function sessions(args: SessionsArgs): Session[] {
  // 1. Check DB exists (return [] if not)
  // 2. Open CommDB
  // 3. activeOnly ? getActiveSessions() : listSessions()
  // 4. Return Session[]
}
```

`runner_terminal_list` MCP tool 会复用这个实现。

### 2.4 CommDB Session schema

```sql
sessions (
  execution_id  TEXT PRIMARY KEY,
  tmux_window   TEXT NOT NULL,      -- e.g., "GEO-208:@0"
  project_name  TEXT NOT NULL,
  issue_id      TEXT,
  lead_id       TEXT,               -- scope filtering
  started_at    DATETIME,
  ended_at      DATETIME,
  status        TEXT ('running'|'completed'|'timeout')
)
```

`lead_id` 字段支持 scope 过滤——Lead 只能看自己的 Runner session。

### 2.5 MCP SDK

`@modelcontextprotocol/sdk` 已在 monorepo pnpm overrides 中（`>=1.25.2`）。MCP server 可以用 TypeScript 实现，通过 stdio transport 与 Claude Code 通信。

## 3. 新增 CLI 命令设计

### 3.1 `search` command

```bash
flywheel-comm search --exec-id <id> --pattern <regex> [--lines <N>] [--db <path>] [--project <name>] [--json]
```

实现步骤：
1. CommDB lookup → tmux target
2. `tmux capture-pane -t target -p -S -${lines}` 获取终端文本
3. 逐行 `RegExp.test()` 过滤匹配行
4. 返回匹配行（带行号）

```typescript
interface SearchResult {
  matches: Array<{ line: number; text: string }>;
  total_lines: number;
  pattern: string;
}
```

### 3.2 `list` command 增强

现有 `sessions` command 已基本满足 `runner_terminal_list` 需求。需要增强：
- 添加 `--lead` 过滤参数（scope filtering）
- 添加 tmux alive 检测（`tmux has-session -t target` 验证 session 是否真正存活）

```bash
flywheel-comm sessions --project geoforge3d --active --lead product-lead --json
```

### 3.3 不新增 `info` command

`runner_terminal_info`（P2）暂不实现。Terminal size / process tree 是 nice-to-have，不是 Phase 1 必须。

## 4. MCP Server 设计

### 4.1 位置

新建 `packages/terminal-mcp/`，与 flywheel-comm 同级。

### 4.2 技术选型

- **Transport**: stdio（Claude Code `--mcp` 标准）
- **SDK**: `@modelcontextprotocol/sdk`
- **与 flywheel-comm 的关系**: 直接 import flywheel-comm 的 command 函数（同 monorepo），不 spawn CLI 进程

**关键修正**：之前 brainstorm 说"spawn flywheel-comm CLI"（有 ~50ms overhead）。更好的做法是直接 import 函数——monorepo 内部可以 cross-package import，零额外开销。CLI 和 MCP 共享同一份底层实现。

```
packages/terminal-mcp/
├── src/
│   ├── index.ts         # MCP server entry (stdio transport)
│   └── tools.ts         # Tool definitions + handlers
├── package.json         # deps: @modelcontextprotocol/sdk, flywheel-comm
└── tsconfig.json
```

### 4.3 Tool 定义

```typescript
// Tool 1: runner_terminal_capture
{
  name: "runner_terminal_capture",
  description: "Capture the last N lines of a Runner's terminal output",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Execution ID of the Runner session" },
      lines: { type: "number", description: "Number of lines to capture (1-500, default 100)" }
    },
    required: ["session_id"]
  }
}

// Tool 2: runner_terminal_list
{
  name: "runner_terminal_list",
  description: "List all observable Runner sessions",
  inputSchema: {
    type: "object",
    properties: {
      active_only: { type: "boolean", description: "Only show running sessions (default true)" },
      lead_id: { type: "string", description: "Filter by Lead ID for scope isolation" }
    }
  }
}

// Tool 3: runner_terminal_search
{
  name: "runner_terminal_search",
  description: "Search Runner terminal output for a pattern (regex)",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Execution ID of the Runner session" },
      pattern: { type: "string", description: "Regex pattern to search for" },
      lines: { type: "number", description: "Lines of history to search (default 500)" }
    },
    required: ["session_id", "pattern"]
  }
}
```

### 4.4 Lead 加载方式

在 Lead 启动脚本（`claude-lead.sh`）中添加 `--mcp` 参数：

```bash
claude --agent ... --mcp "terminal-mcp: node packages/terminal-mcp/dist/index.js --project $PROJECT_NAME"
```

或通过 `.claude/settings.json` 的 `mcpServers` 配置。

### 4.5 环境变量

MCP server 需要知道 project name 来解析 CommDB 路径。通过启动参数或环境变量传入：

```
FLYWHEEL_PROJECT_NAME=geoforge3d
```

## 5. 安全考量

| 风险 | 缓解 |
|------|------|
| Path traversal（project name 包含 `../`） | 复用 flywheel-comm 现有 `resolveDbPath` 验证 |
| Lead 看其他 Lead 的 Runner | `lead_id` scope 过滤（CommDB sessions 表已有 lead_id） |
| tmux command injection | `execFileSync` 不走 shell（已有模式） |
| Regex DoS（search pattern）| 限制 pattern 长度 + 超时 |

## 6. 测试策略

### 6.1 flywheel-comm 新命令

- Unit tests for `search()` function（mock tmux output）
- Unit tests for `sessions()` 增强的 lead_id filtering
- 沿用现有 `commands.test.ts` 的 round-trip 模式

### 6.2 MCP server

- Unit tests: tool handler 逻辑（mock flywheel-comm functions）
- Integration test: MCP protocol round-trip（stdio transport）

### 6.3 E2E

- 手动验证：启动 Lead with `--mcp`，调用 tool 观察 Runner 终端
