# Exploration: Claude Lead Agent Identity — GEO-205

**Issue**: GEO-205 (Claude Lead agent identity — --agent persona + --channels integration)
**Domain**: Infrastructure / Agent Configuration
**Date**: 2026-03-22
**Depth**: Standard
**Mode**: Technical
**Status**: final

---

## 背景

GEO-195 (PR #37) 引入了 Claude Code 作为 Lead runtime。需要给 Claude Lead 定义"身份"——它是谁、怎么行为、用什么工具。

最初方案是把 persona 放在 CLAUDE.md 里，但 CLAUDE.md 是项目级指令文件，不适合定义 agent 人格。Claude Code 原生有 `--agent` 机制，专门解决这个问题。

## 关键发现

### `--agent` 机制

Claude Code 支持用 markdown 文件定义 custom agent，通过 `--agent <name>` 启动：

```bash
claude --agent product-lead --channels "plugin:discord@claude-plugins-official"
```

- **Agent prompt 替换默认 system prompt**，但 **CLAUDE.md 仍然正常加载**
- Agent file 用 YAML frontmatter 配置 tools、model、permissions、hooks、memory
- 支持 persistent memory（跨 session 保留）
- 支持 mcpServers scoping（agent 级 MCP 配置）

### Agent 文件格式

```markdown
---
name: product-lead
description: Flywheel Product Department Lead
model: opus
tools: Read, Bash, Grep, Glob, Agent
permissionMode: bypassPermissions
memory: project
mcpServers:
  - discord
---

你是 Flywheel 的 Product 部门负责人...
```

**关键 frontmatter 字段**：

| 字段 | 用途 | Lead 场景 |
|------|------|-----------|
| `tools` | 工具白名单 | Lead 不需要 Write/Edit（不写代码）|
| `model` | 模型选择 | `opus` for reasoning |
| `permissionMode` | 权限模式 | `bypassPermissions`（无人值守）|
| `memory` | 持久记忆 | `project`（checked in）或 `local`（git-ignored）|
| `mcpServers` | MCP 服务 | Discord plugin |
| `maxTurns` | 最大轮次 | 不限（persistent session）|
| `hooks` | 生命周期钩子 | 可用于 audit logging |

### 存储位置与优先级

| 位置 | 范围 | 推荐场景 |
|------|------|----------|
| `.claude/agents/product-lead.md` | 项目级（GeoForge3D repo） | **推荐** — checked in，团队共享 |
| `~/.claude/agents/product-lead.md` | 全局 | 适合个人 agent |
| CLI `--agents` JSON | 临时 | 适合测试 |

### 与 `--channels` 的兼容性

**完全兼容。** `--agent` 控制身份（WHO），`--channels` 控制通信（HOW），互不干扰。

### 与 CLAUDE.md 的关系

**两者共存。** Agent prompt 替换默认 system prompt，但 CLAUDE.md 仍作为 "observed content" 加载。这意味着：
- Agent 文件：定义 Lead 的角色、行为规范、沟通风格
- 项目 CLAUDE.md：提供项目技术上下文（架构、部署、规则等）
- 两者互补，不冲突

### Agent Persistent Memory

```yaml
memory: project  # → .claude/agent-memory/product-lead/
```

- 跨 session 保留记忆（MEMORY.md + memory files）
- 类似 Claude Code 的 auto memory 系统
- 这可能部分解决 GEO-203（mem0 集成）的需求 — agent 原生就有记忆层

---

## 影响分析

### 需要修改的文件

| 文件 | 操作 | 说明 |
|------|------|------|
| GeoForge3D `.claude/agents/product-lead.md` | 新增 | Agent 身份定义 |
| Flywheel `scripts/claude-lead.sh` | 修改 | 加 `--agent product-lead` flag |
| GeoForge3D `product/.lead/claude-lead/CLAUDE.md` | 删除或重构 | 内容迁移到 agent file |

### 不需要改动

- Bridge 代码（GEO-195 的 RuntimeRegistry 等）
- projects.json 配置
- Discord control channel 设置

---

## Options Comparison

### Option A: 项目级 Agent 文件（推荐）

**Core idea**: 在 GeoForge3D repo 的 `.claude/agents/product-lead.md` 创建 agent 文件。Supervisor 脚本加 `--agent product-lead`。

```bash
# 启动方式
claude --agent product-lead \
  --channels "plugin:discord@claude-plugins-official" \
  --dangerously-skip-permissions
```

**Pros**:
- Claude Code 原生机制，最 idiomatic
- Checked into version control，团队可共享
- CLAUDE.md 仍提供项目上下文
- 支持 persistent memory（agent 自带）
- 可以限制 tools（Lead 不需要 Write/Edit）
- `permissionMode: bypassPermissions` 在 agent 级别设置，不需要 CLI flag

**Cons**:
- Agent 文件放在 GeoForge3D repo，但行为定义其实是 Flywheel 的关注点
- 需要验证 `--agent` + `--channels` + `--dangerously-skip-permissions` 三者同时使用

**Effort**: Small（1-2 小时）

### Option B: 全局 Agent 文件

**Core idea**: 放在 `~/.claude/agents/product-lead.md`，不依赖任何 repo。

**Pros**:
- 不污染产品 repo
- 跨项目复用（如果有多个 product repo）

**Cons**:
- 不在版本控制中
- 不能团队共享
- 换机器需要重新配置

**Effort**: Small（1-2 小时）

### Option C: Supervisor 脚本内联 JSON

**Core idea**: 用 `--agents '{"product-lead": {...}}'` 在脚本里直接定义。

**Pros**:
- 无需额外文件
- 全部配置在 Flywheel repo

**Cons**:
- JSON 嵌入 bash 脚本，维护困难
- 不支持 persistent memory
- 不支持 mcpServers scoping

**Effort**: Small（30 分钟）

### Recommendation: Option A

项目级 agent 文件是 Claude Code 推荐的方式。Checked in + persistent memory + tool restriction + native support。

---

## Clarifying Questions

### Scope

1. **Agent 文件放哪个 repo？** GeoForge3D（`.claude/agents/product-lead.md`）是 Claude Code 原生推荐的位置，但行为定义逻辑上属于 Flywheel。你觉得放哪里合适？

2. **之前 push 到 GeoForge3D main 的 `product/.lead/claude-lead/CLAUDE.md` 怎么处理？** 删掉（内容迁移到 agent file）、保留（作为补充）、还是重构为其他用途？

3. **`permissionMode: bypassPermissions`** — 这等价于 `--dangerously-skip-permissions`。如果在 agent 文件里设置，CLI flag 就不需要了。你倾向于哪种方式？

4. **Agent persistent memory** — Claude Code agent 自带 memory 系统（`project` → `.claude/agent-memory/product-lead/`）。这和 GEO-203 的 mem0 集成有重叠。要不要先用 agent 原生 memory，mem0 后续再加？

---

## User Decisions

1. **选择 Option A** — 项目级 agent 文件，放 GeoForge3D `.claude/agents/product-lead.md`
2. **删除旧 CLAUDE.md** — `product/.lead/claude-lead/CLAUDE.md` 内容迁移到 agent file 后删除
3. **先用 agent 原生 memory** — `.claude/agent-memory/product-lead/`，mem0 (GEO-203) 后续再加
4. **`permissionMode: bypassPermissions`** — 在 agent file 里设置，CLI 不需要额外 flag

## Suggested Next Steps

- [ ] 回答 clarifying questions
- [ ] 根据决策写 agent 文件
- [ ] 更新 supervisor 脚本
- [ ] 本地测试 `--agent + --channels` 组合
