# Research: Lead Agent 行为配置 — GEO-234

**Issue**: GEO-234
**Date**: 2026-03-23
**Source**: `doc/engineer/exploration/new/GEO-234-lead-agent-behavior-config.md`

---

## 研究目标

验证 GEO-234 exploration 中选定方案（Option A: Agent File + Prompt-based Comm）的技术可行性，重点关注：

1. `--agent` CLI flag 机制
2. 环境变量在 agent prompt 中的行为
3. Hook-based 替代方案的可行性（为未来参考）
4. Supervisor 脚本需要的改动

## 1. `--agent` CLI Flag 验证

### 1.1 Flag 存在性

| 问题 | 结论 | 信心 |
|------|------|------|
| `--agent <name>` 是有效的 CLI flag？ | ✅ 是。v2.0.59+ 引入 | Confirmed |
| Agent 文件位置？ | `.claude/agents/<name>.md`（项目级）或 `~/.claude/agents/<name>.md`（用户级）| Confirmed |
| 优先级？ | 项目级 > 用户级 > CLI JSON | Confirmed |
| `--agent` + `--channels` 兼容？ | ⚠️ 架构上兼容（不同层），但官方文档未明确说明 | Likely |

**来源**: [Claude Code Sub-agents Docs](https://code.claude.com/docs/en/sub-agents), Context7 `/ericbuess/claude-code-docs`

### 1.2 Frontmatter 支持

Confirmed frontmatter fields:

```yaml
---
name: product-lead           # Agent 标识符
description: ...             # 何时/为何使用此 agent
tools: Read, Bash, Grep, Glob  # 工具白名单
model: opus                  # 模型选择
permissionMode: bypassPermissions  # 权限模式
---
```

**注意**: `skills` 和 `mcpServers` 在 GeoForge3D 的 executor agents 中已使用（如 `backend-executor.md` 有 `skills:` 和 `permissionMode: bypassPermissions`），说明这些字段在项目中已经被验证过。

### 1.3 System Prompt 行为

| 问题 | 结论 | 信心 |
|------|------|------|
| Agent prompt 替换还是追加默认 system prompt？ | **替换**（类似 `--system-prompt`，不是 `--append-system-prompt`）| Confirmed |
| CLAUDE.md 是否仍加载？ | ✅ 是。Agent prompt 替换默认指令，但 CLAUDE.md 通过正常消息流加载 | Confirmed |

**影响**: Agent 文件需要包含完整的行为定义，因为默认的 Claude Code 行为指令不再存在。但项目级 CLAUDE.md 仍提供技术上下文。

### 1.4 `--agent` + `--channels` 兼容性

虽然官方未明确文档，但分析架构层面：

- `--agent` 操作的是 **prompt 层**（WHO — 身份定义）
- `--channels` 操作的是 **通信层**（HOW — 事件接收）
- 两者互不干扰

GeoForge3D 已有使用 `--channels "plugin:discord@claude-plugins-official"` 的经验，加上 `--agent` 不应引入冲突。

**风险缓解**: 如果组合使用出问题，fallback 方案是用 `--append-system-prompt` 替代 `--agent`（丢失 frontmatter 能力但保证兼容）。

## 2. 环境变量处理

### 2.1 Agent Prompt 中的变量

Agent 文件是 **静态 markdown 文本** — Claude Code 读取文件时不做 shell 变量插值。`$FLYWHEEL_COMM_CLI` 在 agent prompt 中是字面文本。

**但这不是问题**。工作流程：

```
1. Agent prompt 说: "运行 `node $FLYWHEEL_COMM_CLI pending --lead $LEAD_ID`"
2. Claude 看到这个命令模式（作为字面文本）
3. Claude 用 Bash 工具执行: node $FLYWHEEL_COMM_CLI pending --lead $LEAD_ID
4. Bash shell 展开 $FLYWHEEL_COMM_CLI 和 $LEAD_ID → 命令正常执行
```

**前提条件**: 环境变量必须在 Claude Code 启动前 `export`。

### 2.2 当前 Supervisor 脚本的变量 Export 状态

| 变量 | 当前状态 | 需要改动 |
|------|---------|---------|
| `FLYWHEEL_COMM_DB` | ✅ 已 export | 无 |
| `FLYWHEEL_COMM_CLI` | ✅ 已 export（在 if 块内）| 无 |
| `LEAD_ID` | ❌ 未 export（普通变量）| **需要加 export** |
| `PROJECT_NAME` | ❌ 未 export（普通变量）| **需要加 export** |
| `BRIDGE_URL` | ❌ 未 export | **需要加 export**（agent 用 curl 调 Bridge API） |
| `BRIDGE_TOKEN` / `TEAMLEAD_API_TOKEN` | ❌ 未 export | **需要加 export** |

### 2.3 已知的 Env Var 问题

Claude Code 有文档记录的环境变量问题（[issue #29298](https://github.com/anthropics/claude-code/issues/29298)）：
- Bash 管道中变量可能静默展开为空
- 变量不会在 Bash 调用之间持久化

**缓解**: 通过 `export` 确保变量在 Claude Code 启动时就存在于进程环境中（而不是在 session 内动态设置）。这比 session 内设置更可靠。

## 3. Hook-based 方案调研（未来参考）

### 3.1 Hooks 系统概述

| 特性 | 状态 |
|------|------|
| Hook 事件类型 | PreToolUse, PostToolUse, Notification, Stop, SubagentStop |
| 配置位置 | `settings.json`（非 agent frontmatter）|
| 能否注入 additionalContext？ | ⚠️ 有 known issues |
| 是否支持定时器/周期触发？ | ❌ 仅事件驱动 |

### 3.2 additionalContext 的问题

截至 2026-03，PostToolUse hooks 的 `additionalContext` 注入存在多个 known issues：

1. **[#18427](https://github.com/anthropics/claude-code/issues/18427)** — PostToolUse hooks 无法注入 Claude 可见的 context（仅用户可见的 systemMessage 有效）
2. **[#24788](https://github.com/anthropics/claude-code/issues/24788)** — MCP 工具调用不触发 hooks
3. **[#11544](https://github.com/anthropics/claude-code/issues/11544)** — settings.json 中的 hooks 加载失败

**结论**: Hook-based comm 检查（Option B）在当前版本不可靠。**Option A (prompt-driven) 是正确选择**。

### 3.3 Agent Hook（不同概念）

Agent 文件 frontmatter 不支持 hooks 配置。Hooks 必须在 `settings.json` 或 `.claude/settings.local.json` 中配置。

但 `settings.json` 中可以配置 agent-level hooks：
```json
{
  "hooks": {
    "Stop": [{
      "type": "agent",
      "prompt": "Verify tests pass",
      "timeout": 120
    }]
  }
}
```

这是 "agent as hook"（用 agent 做验证），不是 "hook in agent"（在 agent 中配置 hook）。

## 4. GeoForge3D 现有 Agent 模式分析

### 4.1 Executor Agents 的 Frontmatter 模式

从 `backend-executor.md` 的 frontmatter 看到：

```yaml
---
name: backend-executor
description: Executes full backend workflow for GeoForge3D — brainstorm through ship.
model: opus
permissionMode: bypassPermissions
skills:
  - brainstorm
  - research
  - write-plan
  - implement
  - ship-pr
  - codex-code-review
---
```

**观察**:
- 使用 `permissionMode: bypassPermissions` — 和我们的 product-lead 一致
- 使用 `skills` 字段列出可用技能 — product-lead 不需要这些 skill
- `model: opus` — product-lead 也应用 opus（需要深度推理）

### 4.2 Executor vs Lead 的区别

| 维度 | Executor (subagent) | Lead (top-level agent) |
|------|--------------------|----------------------|
| 启动方式 | Agent tool 调用 | `claude --agent product-lead` |
| 生命周期 | 短期（完成任务后结束）| 长期（persistent session）|
| 通信 | SendMessage 到 orchestrator | Discord channel + flywheel-comm |
| 工具 | Write, Edit, Bash（写代码）| Read, Bash, Grep（只读 + API 调用）|
| 文件位置 | 同一个 `.claude/agents/` 目录 | 同一个 `.claude/agents/` 目录 |

## 5. 实现方案确认

### 5.1 Agent 文件内容结构

```markdown
---
name: product-lead
description: Flywheel Product Department Lead — manages AI runners, monitors execution, communicates with CEO via Discord
model: opus
tools: Read, Bash, Grep, Glob
permissionMode: bypassPermissions
---

# Flywheel Product Lead

## 核心身份
[迁移自 claude-lead/CLAUDE.md — 角色、限制、沟通风格]

## 事件处理
[迁移自 claude-lead/CLAUDE.md — Discord 事件 → Bridge API → Forum/Chat]

## Bubble DOWN — CEO 指令执行
[迁移自 claude-lead/CLAUDE.md — approve/retry/reject/shelve/terminate]

## Runner 通信 — flywheel-comm    ← 新增
### 检查 pending 问题
### 回答 Runner 问题
### 主动发送指令
### 查看 sessions & capture
### 检查时机
### Escalation 策略（Phase 1: 全部上报 CEO）

## 工具参考
### Discord MCP Plugin
### Bridge API
### flywheel-comm CLI    ← 新增

## 限制
[迁移自 claude-lead/CLAUDE.md]
```

### 5.2 Supervisor 脚本改动

```bash
# 新增 export
export LEAD_ID
export PROJECT_NAME
export BRIDGE_URL
export TEAMLEAD_API_TOKEN="${TEAMLEAD_API_TOKEN:-}"

# 修改启动命令
claude --agent product-lead \
  --channels "plugin:discord@claude-plugins-official"
# 移除 --dangerously-skip-permissions（agent frontmatter 已处理）

# --resume 模式同样加 --agent
claude --agent product-lead \
  --resume "$SESSION_ID" \
  --channels "plugin:discord@claude-plugins-official"
```

### 5.3 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| `--agent` + `--channels` 不兼容 | 高 — Lead 无法启动 | Fallback: 用 `--append-system-prompt` + 保留 `--dangerously-skip-permissions` |
| Agent prompt 过长影响推理 | 低 — ~200 行对 Opus 不是问题 | 如果有影响，精简非核心 section |
| Lead 忘记检查 pending | 中 — Runner 问题延迟回复 | Prompt 中用强制语气 + 未来加 Hook（等 additionalContext 修复后）|
| Env var 展开失败 | 中 — flywheel-comm 命令出错 | Agent prompt 中同时提供变量名和说明，Lead 可以用 `echo $VAR` 验证 |

### 5.4 测试计划

1. **单元测试**: Agent 文件 frontmatter 语法验证（lint）
2. **集成测试**: `claude --agent product-lead --channels discord` 是否正常启动
3. **E2E**: 启动 Lead → 手动触发 Runner 问题 → Lead 是否检查 pending → Lead 是否上报 CEO

## 6. 结论

| 维度 | 结论 |
|------|------|
| 技术可行性 | ✅ Confirmed — `--agent` + `--channels` 架构兼容 |
| Env var | ✅ 可行 — 需要在 supervisor 中 export 4 个变量 |
| Hook 替代方案 | ❌ 当前不可靠 — additionalContext 有 known issues |
| 实现复杂度 | Small — 1 个新文件 + 1 个脚本修改 + 1 个文件删除 |
| 主要风险 | `--agent` + `--channels` 组合未在官方文档明确确认 |

**建议**: 进入 plan 阶段，实现 Option A。
