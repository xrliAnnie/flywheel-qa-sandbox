# Exploration: Multi-Lead Architecture — GEO-246

**Issue**: GEO-246 (Multi-Lead 架构 — 独立 Discord Bot + Agent + Workspace per Lead)
**Domain**: Infrastructure / Product
**Date**: 2026-03-24
**Depth**: Standard
**Mode**: Both (Product + Technical)
**Status**: final

---

## 0. Product Research

### Problem Statement

当前系统只有一个 Product Lead（PR #43 GEO-234 交付），但 CEO 的愿景是每个项目有多个部门负责人（Product, Operations 等），各自独立运作。CEO 在 OpenClaw 时代已经体验过多 workspace 模式——每个 Lead 有自己的 soul、memory、persona——现在需要在 Claude Code runtime 上复现这个能力。没有 multi-lead，所有事件都路由给同一个 Lead，无法实现部门分工。

### Target User

CEO (Annie) — 像管理真人部门经理一样管理多个 AI Lead。每个 Lead 应该有独立的身份、记忆和沟通渠道，CEO 能在不同的 Discord channel 里跟不同的 Lead 对话。

### Scope Frame

- **Appetite**: M（中等）— 基础设施已就绪（projects.json multi-lead routing、RuntimeRegistry、claude-lead.sh），主要是参数化 + 创建资源
- **Essential core**: 两个 Lead 能同时运行、独立通信、互不干扰
- **Nice to haves**: Lead 间通信、自动健康监控、auto-restart

### Competitive Landscape

| 方案 | 优势 | 劣势 |
|------|------|------|
| OpenClaw (之前) | 成熟的 workspace 隔离、独立 memory | 被 Claude Code runtime 取代 |
| Claude Code --agent | 原生 memory 支持、更轻量 | 需要手动配置 Discord 隔离 |
| Status quo (单 Lead) | 已工作 | 无法部门分工 |

---

## 1. Affected Files and Services

| File/Service | Impact | Notes |
|-------------|--------|-------|
| `packages/teamlead/scripts/claude-lead.sh` | **修改** | 参数化 agent name、bot token、workspace 路径 |
| `packages/teamlead/agents/product-lead.md` | **修改** | 添加 `memory: user` frontmatter |
| `packages/teamlead/agents/ops-lead.md` | **新建** | Ops Lead 人格 + channel IDs |
| `~/.flywheel/projects.json` | **修改** | 更新 channel IDs 到 claude's server |
| `~/.claude/channels/discord/access.json` | **已就绪** | GEO-234 已配置 4 个 channel |
| Discord Developer Portal | **手动** | 创建 2 个 Application + Bot |
| Discord Server (claude's server) | **修改** | 设置 bot role + channel 权限 |

---

## 2. Architecture Constraints

### 2.1 已有基础设施（不需要改）

- **projects.json**: 已支持 multi-lead（`leads[]` 数组 + label routing）
- **RuntimeRegistry**: 已支持 N 个 lead runtime 注册
- **resolveLeadForIssue()**: 已实现 label-based routing（case-insensitive）
- **Discord channels**: claude's server 已有 product-forum/chat + ops-forum/chat
- **access.json**: 已配置 4 个 channel groups

### 2.2 需要改的

- **claude-lead.sh**: 硬编码 `--agent product-lead`，不支持不同 agent name
- **Agent file sync**: 硬编码 `product-lead.md` source/target 路径
- **Workspace**: 硬编码 `~/.flywheel/lead-workspace/$LEAD_ID`
- **Bot token**: 进程级 `DISCORD_BOT_TOKEN` env var — 需要 per-lead 设置
- **Agent memory**: product-lead.md 缺少 `memory` frontmatter

### 2.3 Claude Code Agent Memory 机制

Claude Code v2.1.33+ 支持 agent memory frontmatter:

```yaml
memory: user    # → ~/.claude/agent-memory/<agent-name>/MEMORY.md
memory: project # → .claude/agent-memory/<agent-name>/MEMORY.md
```

- 每个 agent name 自动独立的 memory 目录
- Memory 在 session 启动时注入 system prompt（前 200 行）
- Agent 可跨 session 读写、维护 MEMORY.md

### 2.4 Discord Multi-Bot 隔离

- 每个 bot 有独立的 token、Application ID
- Channel 权限隔离：Category-level deny + channel-level allow per bot
- Claude Code Discord plugin 读取 `DISCORD_BOT_TOKEN` env var → 每个 Lead 进程设置不同值即可
- `access.json` 是全局共享的（`~/.claude/channels/discord/access.json`），但 Discord-level 权限确保 bot 只收到有权限的 channel 的消息

### 2.5 Workspace 与 CLAUDE.md

- 用户要求 workspace 在项目目录内（如 `geoforge3d/.flywheel/lead/product-lead/`）
- 好处：Claude Code 会向上遍历查找 CLAUDE.md，Lead 自动获得项目上下文
- 风险：Lead 有 Bash + bypassPermissions，CWD 在项目内增加意外修改代码的风险（GEO-234 已接受此 trade-off）
- 需要 `.gitignore` 该目录

---

## 3. External Research

### Claude Code Agent Memory

- `memory: user` scope 推荐用于跨项目知识积累（`~/.claude/agent-memory/<name>/`）
- `memory: project` scope 用于项目特定知识（`.claude/agent-memory/<name>/`，可 version control）
- Agent name 自动隔离 memory — 无需额外配置

### Discord Multi-Bot Best Practices

- **Principle of Least Privilege**: 不授予 Administrator 权限
- **Category-level deny + Channel-level allow**: 在 Category 上 deny bot role，在特定 channel 上 allow
- **独立 role per bot**: 便于管理权限
- **测试**: 用非 admin 视角验证权限

---

## 4. Options Comparison

### Option A: Parameterize Supervisor Script（推荐）

- **Core idea**: 参数化 `claude-lead.sh`，接受 agent name 参数。Bot token 通过环境变量或参数传入。每个 Lead 一个 tmux session + 一次 `claude-lead.sh` 调用。
- **Pros**:
  - 最小改动量（改一个脚本 + 新建一个 agent 文件）
  - 复用已有基础设施（projects.json、RuntimeRegistry）
  - 每个 Lead 是独立的 Claude Code 进程，天然隔离
  - `--agent <name>` 自动隔离 memory
- **Cons**:
  - 需要手动启动每个 Lead（各自的 tmux session）
  - Bot token 管理靠 env var（需要文档说明）
- **Effort**: Small（~2-3 hours）
- **Affected files**: `claude-lead.sh`, `product-lead.md`, new `ops-lead.md`
- **What gets cut**: 自动启停、健康监控、Lead 间通信

### Option B: Lead Config File

- **Core idea**: 新建 `~/.flywheel/leads.yaml` 配置文件，映射 lead-id → agent name, bot token, workspace, channels。supervisor 脚本从配置文件读取。
- **Pros**: 集中管理、易于添加新 Lead
- **Cons**: 新增配置层、与 projects.json 有信息重复、增加复杂度
- **Effort**: Medium
- **Affected files**: 新增 config file、修改 `claude-lead.sh`
- **What gets cut**: 同 Option A

### Option C: Lead Orchestrator Service

- **Core idea**: 构建 `lead-manager` 守护进程，自动从 projects.json 发现 leads、启动 Claude Code 进程、监控健康、auto-restart。
- **Pros**: 全自动化、生产级健壮性
- **Cons**: 大量新代码、过度工程化、当前只有 2 个 lead
- **Effort**: Large
- **What gets cut**: 无

### Recommendation: Option A

**Rationale**: 基础设施已经就绪（projects.json multi-lead routing、RuntimeRegistry），只需要参数化 supervisor 脚本 + 创建资源。Option B 引入不必要的 config 层（projects.json 已有 lead 配置）。Option C 过度工程化——2 个 Lead 手动启动完全可接受。

---

## 5. Clarifying Questions

### Bot 创建
- Q1: Discord bot 命名——ProductBot / OpsBot，还是其他名字（如 GeoForge Product Lead / GeoForge Ops Lead）？

### Ops Lead 人格
- Q2: Ops Lead 的职责和人格应该是什么样的？它跟 Product Lead 有什么不同？（例：Product Lead 关注 feature execution + code review，Ops Lead 关注什么？）

### Workspace 位置
- Q3: 确认 Lead workspace 放在 `geoforge3d/.flywheel/lead/<lead-id>/`？这意味着 Lead 的 CWD 在项目内部，能读到 CLAUDE.md 但也有意外修改代码的风险（GEO-234 已用 disallowedTools 缓解，但 Bash 仍可用）。

### Memory Scope
- Q4: Agent memory 用 `user` scope（`~/.claude/agent-memory/<name>/`，跨项目）还是 `project` scope（`geoforge3d/.claude/agent-memory/<name>/`，项目内 + 可 version control）？

---

## 6. User Decisions

### Selected Approach: Option A — Parameterize Supervisor Script

### Q1: Bot 命名
- **决定**: 人类名字模式 — 首字母对应部门
  - Product Lead → **Peter** (Discord bot 名称)
  - Ops Lead → **Oliver** (Discord bot 名称)
  - 未来部门同理（Finance → F 打头名字，etc.）

### Q2: Ops Lead 人格
- **决定**: 产品运营方向
  - Product Lead: 负责产品开发，管理 Engineer、PM、Designer。对外产品由 Product Lead 负责。
  - Ops Lead: 负责 3D 打印运营、订单处理、客户服务。
  - MBTI/性格设定: 未来阶段，暂不实现。

### Q3: Workspace 位置
- **决定**: 放在对应 org 目录下的 `.lead/` 目录
  - Product Lead CWD: `geoforge3d/product/.lead/product-lead/` (已存在)
  - Ops Lead CWD: `geoforge3d/operations/.lead/ops-lead/` (新建)
  - 好处：语义清晰，每个 Lead 在自己的部门目录下
  - `.gitignore` 需要更新以覆盖 `operations/.lead/`

### Q4: Memory 方案
- **决定**: 两套都用
  - mem0 (Supabase pgvector): 结构化知识、项目上下文（已有）
  - Claude Code `memory: user` frontmatter: Agent 自己的学习笔记、行为模式
  - 两者互补，不冲突

### Q5: Bot Token 传递
- **决定**: 环境变量（最便携）
  - 每个 Lead 在独立 tmux session 启动，`DISCORD_BOT_TOKEN=xxx` 传入
  - 远程部署同样用 env var（systemd/docker 支持）
  - supervisor 脚本接受 agent name 参数，不硬编码

---

## 7. Suggested Next Steps

- [ ] 进入 /research 阶段 — 确认 Claude Code agent memory 机制 + supervisor 脚本改动细节
- [ ] 在 Discord Developer Portal 手动创建 2 个 Application（Peter + Oliver）
- [ ] Write implementation plan → `/write-plan`
- [ ] 实现 + 测试
