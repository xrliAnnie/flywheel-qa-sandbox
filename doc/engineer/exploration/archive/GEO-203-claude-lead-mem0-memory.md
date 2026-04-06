# Exploration: Claude Lead mem0 Memory Integration — GEO-203

**Issue**: GEO-203 (Claude Lead mem0 memory integration)
**Date**: 2026-03-22
**Depth**: Standard
**Mode**: Technical
**Status**: final

## 0. 背景

GEO-198 (PR #36) 将 mem0 记忆层从 Blueprint/Runner 迁移到 Bridge API，暴露了两个 REST endpoint：

- `POST /api/memory/search` — 搜索记忆
- `POST /api/memory/add` — 写入记忆

GEO-195 (PR #37) 引入了 Claude Discord Lead Runtime — Claude Code CLI session 通过 Discord 控制频道接收事件、与 CEO 对话。

**当前缺口**: Claude Lead session 没有任何方式调用 Bridge Memory API。Bootstrap generator 的 `memoryRecall` 字段为 `null`。OpenClaw Lead 通过 TOOLS.md 知道 API 存在，但 Claude Discord Lead 完全没有记忆能力。

## 1. Affected Files and Services

| File/Service | Impact | Notes |
|-------------|--------|-------|
| `packages/teamlead/src/bridge/bootstrap-generator.ts` | modify | `memoryRecall: null` → 分层 recall（角色优先 + 全局补充） |
| `packages/teamlead/src/bridge/lead-runtime.ts` | modify | LeadBootstrap 类型增加 memory 字段 |
| `packages/teamlead/src/bridge/claude-discord-runtime.ts` | modify | Bootstrap 格式化包含 memory context |
| Claude Lead 行为配置文件 | modify | 添加 Memory API 使用说明 + curl 示例 |
| `packages/edge-worker/src/memory/MemoryService.ts` | no change | 已有 `searchMemories()` + `addMessages()` |
| `packages/teamlead/src/bridge/memory-route.ts` | no change | 已有完整 REST API |

## 2. Architecture Constraints

### 现有基础设施

```
Bridge (localhost:9876)
├── /api/memory/search   — POST, token auth, {query, project_name, agent_id, limit?} → {memories: string[]}
├── /api/memory/add      — POST, token auth, {messages: [{role,content}], project_name, agent_id} → {added, updated}
├── /api/bootstrap/:leadId — POST, generates crash recovery snapshot
└── MemoryService        — mem0 OSS + Supabase pgvector + Gemini embeddings
```

### Claude Lead Session 能力

Claude Code CLI session 运行在 `bypassPermissions` 模式下（`--dangerously-skip-permissions`）：
- `Bash` tool — 可执行 shell 命令（包括 curl），**无需权限确认**
- `Read`/`Write`/`Edit` — 文件操作
- `--append-system-prompt` — 注入系统指令
- Discord plugin — 收发 Discord 消息
- 环境变量 — supervisor script 可注入 `BRIDGE_URL`、`BRIDGE_TOKEN` 等

### 多层 Context 架构

记忆不只是 mem0 — 是多层 context 的有机组合：

```
Claude Lead 的 context 来源:

1. mem0 (pgvector)     — 结构化经验记忆（决策记录、项目历史、教训）
2. Codebase            — CLAUDE.md, design docs, code（Claude 已有 Read/Grep 能力，on-demand）
3. Linear              — issue 历史（可通过 CLI/API 查询，on-demand）
4. Bootstrap payload   — 当前活跃 session、pending decisions、recent failures
5. 行为配置            — Claude Lead: codebase 文件; OpenClaw Lead: SOUL.md + TOOLS.md
```

Bootstrap 只需预加载**不能 on-demand 获取的东西**（mem0 记忆 + 运行状态）。

### 关键约束

1. **Auth**: Bridge API 需要 `TEAMLEAD_API_TOKEN` header
2. **Scope isolation**: `project_name` + `agent_id` 用于记忆隔离
3. **Bootstrap 时序**: Lead 启动时需要先 recall 再接收新事件
4. **两种 Lead 共存**: OpenClaw Lead 和 Claude Discord Lead 可能同时运行，需共享记忆池
5. **bypassPermissions**: Claude Lead 的所有 Bash 命令自动执行，curl 调用零摩擦

## 3. External Research

### MCP vs CLI/API：社区共识（2026）

基于广泛的社区讨论，当前共识是**按场景选择，不是非此即彼**：

| 维度 | Bash/CLI/API | MCP |
|------|-------------|-----|
| I/O 复杂度 | 简单文本 in/out | 结构化 typed schema |
| 使用者 | 个人/小团队 | 团队共享、需分发 |
| 持久状态 | 无状态 | 连接池/session |
| 构建成本 | 零（API 已存在） | 需构建 + 维护 server |
| Token 消耗 | 较低 | Tool schema 占 context window |
| 自主发现性 | 需系统提示指导 | 自动出现在工具列表 |

**对 Flywheel memory 的评估**: 4:1 倾向 Bash/API（I/O 简单、个人使用、无状态、不需分发）。

**关键洞察**: LLM 在 CLI/curl 使用上训练充分，配合好的系统提示指导，自主使用效果与 MCP 差距不大。API 直调更快、更省 token、更精准。

Sources:
- [Why CLIs Beat MCP for AI Agents](https://medium.com/@rentierdigital/why-clis-beat-mcp-for-ai-agents-and-how-to-build-your-own-cli-army-6c27b0aec969)
- [MCP Servers vs CLI Tools: When to Use Which](https://systemprompt.io/guides/mcp-vs-cli-tools)
- [MCP is dead. Long live the CLI](https://ejholmes.github.io/2026/02/28/mcp-is-dead-long-live-the-cli.html)

## 4. Options Comparison

### ~~Option A: Bridge Memory MCP Server~~ (排除)

构建轻量 MCP server 包装 Bridge Memory API。经社区调研和 Flywheel 场景评估后排除 — 对于简单 JSON API、个人使用、无状态的场景，MCP 增加了不必要的复杂度（额外进程、依赖、context window 开销），收益有限。

### Option B: System Prompt + Bash curl (选定方案)

**Core idea**: 在 Claude Lead 行为配置中添加 Memory API 使用说明，Claude 通过 `Bash("curl ...")` 直调 Bridge API。Bootstrap generator 启动时预加载 mem0 记忆。

**实现**:
1. **行为配置**（Claude Lead 的 CLAUDE.md 或等效文件）中加入 Memory API 文档 + curl 示例
2. **环境变量注入**: supervisor script 设置 `BRIDGE_URL`、`BRIDGE_TOKEN`、`PROJECT_NAME`、`AGENT_ID`
3. **Bootstrap generator**: 分层 recall — 角色优先 + 少量全局记忆

**curl 示例**:
```bash
# 搜索记忆
curl -s -X POST "$BRIDGE_URL/api/memory/search" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"...","project_name":"'"$PROJECT_NAME"'","agent_id":"'"$AGENT_ID"'","limit":10}'

# 写入记忆
curl -s -X POST "$BRIDGE_URL/api/memory/add" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}],"project_name":"'"$PROJECT_NAME"'","agent_id":"'"$AGENT_ID"'"}'
```

**Pros**:
- 零额外代码/进程
- 直调 API，最快、最省 token
- bypassPermissions 模式下 curl 零摩擦
- 环境变量注入简化命令，减少出错

**Cons**:
- Claude 需要被系统提示引导使用
- JSON 拼接略繁琐（但 env vars 缓解了大部分）

**Effort**: Small (~0.5-1 天)

### ~~Option C: Claude Code Custom Commands~~ (排除)

Skill 本质是 prompt template → 内部还是执行 curl，多了一层间接。不如直接在行为配置里写清楚。

## 5. User Decisions

### Q1: 方案选择
**决定**: Option B — System Prompt + Bash curl 直调 Bridge Memory API。
**理由**: API 直调更快、更省 token、更精准。MCP 对此场景 over-engineering。

### Q2: Bootstrap recall 范围
**决定**: 分层 recall — 整个 project 的记忆，但角色优先。
- **Primary**: 按 `agent_id` 搜索，limit 较高（~10 条）— focus 本角色
- **Secondary**: 不带 `agent_id` 搜整个 project，limit 较低（~3-5 条）— 全局视野
- **理由**: 希望 agent focus 在自己的领域（如 product），但也需要一些跨团队 context。记忆空间有限，不能全部加载。

### Q3: 记忆写入时机
**决定**: A + B 混合 — 系统提示定义 must-write 节点 + Claude 自行判断补充。
- **Must-write**: 重要决策后、发现新约束/pattern 后、获得 CEO 关键指示后
- **自主补充**: Claude 判断有值得记录的内容时可随时写入

### Q4: 双 Lead 共存
**决定**: 各自独立 `agent_id`（如 `product-lead-claude` / `product-lead-openclaw`），共享同一个 mem0 记忆池。
- Bootstrap recall 的 secondary query（不带 agent_id）让双方能看到彼此的记忆
- 行为配置各自独立（Claude Lead: codebase 文件; OpenClaw Lead: SOUL.md + TOOLS.md）

### 多层 Context 架构
**共识**: 记忆 = mem0 + Codebase + Linear + Bootstrap payload + 行为配置，不只是 mem0。Bootstrap 只预加载不能 on-demand 获取的东西。

## 6. Scope Definition

### 本次实施范围 (GEO-203)

1. **Bootstrap memory recall** — 填充 `memoryRecall: null`，分层 recall 策略
2. **Claude Lead 行为配置** — Memory API 使用说明 + curl 示例 + 写入时机指导
3. **环境变量注入** — supervisor script 设置 memory 相关 env vars

### 不在范围

- MCP server 构建
- OpenClaw Lead 的 memory 集成变更（已通过 TOOLS.md 可用）
- mem0 数据模型变更
- 跨项目记忆共享

## 7. Suggested Next Steps

- [x] 回答 clarifying questions
- [x] 确认方案选择（Bash curl）
- [ ] 进入 `/research` 阶段：调研 bootstrap generator 代码细节、supervisor script 结构、行为配置注入方式
- [ ] 编写实现计划
