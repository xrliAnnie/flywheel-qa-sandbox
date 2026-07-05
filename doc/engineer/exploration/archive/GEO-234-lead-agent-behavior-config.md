# Exploration: Lead Agent 行为配置 — flywheel-comm 集成 — GEO-234

**Issue**: GEO-234 (Lead Agent 行为配置 — flywheel-comm 集成)
**Domain**: Infrastructure / Agent Configuration
**Date**: 2026-03-23
**Depth**: Standard
**Mode**: Technical
**Status**: final

---

## 背景

GEO-206 Phase 1+2 建了完整的 Lead ↔ Runner 通信管道（flywheel-comm CLI + SQLite）：

| 方向 | 命令 | 作用 |
|------|------|------|
| Runner → Lead | `ask`, `check` | Runner 提问 + 轮询答案 |
| Lead → Runner | `respond` | Lead 回答 Runner 问题 |
| Lead → Runner | `send` | Lead 主动发指令 |
| Runner ← Lead | `inbox` | Runner 检查 Lead 指令 |
| Lead 监控 | `pending` | 查看待回答问题 |
| Lead 监控 | `sessions` | 查看 Runner sessions |
| Lead 监控 | `capture` | 抓取 Runner tmux 输出 |

**问题**: 管道建好了，但 Lead agent 不知道它存在。当前 Lead 以通用 Claude Code session 启动（`claude --channels discord`），没有任何 flywheel-comm 行为指令。

本 issue 同时吸收了 GEO-205（agent identity）— 创建 agent 文件 + 修改启动脚本。

## 1. 现状分析

### 1.1 Lead 启动方式

`packages/teamlead/scripts/claude-lead.sh`:

```bash
claude \
  --channels "plugin:discord@claude-plugins-official" \
  --dangerously-skip-permissions
```

- 没有 `--agent` flag — Lead 用默认 system prompt
- 环境变量已设置：`FLYWHEEL_COMM_DB`, `FLYWHEEL_COMM_CLI`
- Session 恢复支持已有（`--resume $SESSION_ID`）

### 1.2 已有的行为定义（未生效）

`geoforge3d/product/.lead/claude-lead/CLAUDE.md` — 5KB 详细的 Lead 行为定义：
- 身份（Product Lead，管理者不是开发者）
- 事件处理流程（Discord control channel → Bridge API → Forum/Chat）
- Bubble DOWN 指令执行（approve/retry/reject/shelve/terminate）
- 汇报风格（中文，简洁，消化后汇报）
- 工具使用（Discord MCP + Bridge API）
- Discord Channel IDs（硬编码）
- 限制清单

**问题**: 这个文件放在 `product/.lead/` 目录下，Claude Code 不会自动读取它。需要迁移到 agent 文件。

### 1.3 GeoForge3D 的 .claude/agents/ 目录

已有 7 个 executor agents（backend, frontend, designer, product, qa 等）。这些是 subagents，由 orchestrator 通过 Agent tool 调用。

`product-lead.md` 还不存在 — 需要新建。

### 1.4 Runner 侧已就绪

- Blueprint 已注入 flywheel-comm ask/inbox 指令到 Runner prompt
- TmuxAdapter 已实现 session 注册、动态超时、comm DB 集成
- Runner 会在任务边界检查 inbox

## 2. 架构约束

### 2.1 Claude Code `--agent` 机制

从 Context7 文档确认：
- `--agent <name>` 是有效的 CLI flag
- Agent 文件放在 `.claude/agents/<name>.md`
- YAML frontmatter 支持：`name`, `description`, `tools`, `model`, `permissionMode`
- Agent prompt **替换**默认 system prompt，但 **CLAUDE.md 仍正常加载**
- `--agent` 和 `--channels` 完全兼容

### 2.2 环境变量传递

`claude-lead.sh` 已 export：
- `FLYWHEEL_COMM_DB` — comm.db 路径
- `FLYWHEEL_COMM_CLI` — flywheel-comm CLI 路径

Agent 文件中可以引用 `$FLYWHEEL_COMM_CLI` 和 `$FLYWHEEL_COMM_DB`。但 agent prompt 是静态文本 — 变量替换需要由 shell 或 Claude Code 本身处理。

**约束**: Agent 文件是 markdown，不支持 shell 变量插值。CLI 路径需要在 prompt 中用通用描述或绝对路径。

**解法**:
- 方案 1: Agent prompt 中写 "运行 `node $FLYWHEEL_COMM_CLI`" — Claude Code 在 Bash 中执行时会展开环境变量
- 方案 2: 在 supervisor 脚本中用 `--append-system-prompt` 注入变量化的路径

### 2.3 Discord Channel IDs

现有 CLAUDE.md 硬编码了 Discord Channel IDs。这些 ID 是固定的（不会变），但不同项目的 Lead 会有不同的 channel。

**选择**:
- 硬编码在 agent 文件中（简单，当前只有一个项目）
- 通过 Bridge API 查询（灵活，但多一次 API 调用）

### 2.4 `permissionMode`

GEO-205 决策：`permissionMode: bypassPermissions`（无人值守运行）。
等价于 `--dangerously-skip-permissions`，但在 agent frontmatter 中设置更干净。

## 3. Options Comparison

### Option A: Agent File + Prompt-based Comm（推荐）

**Core idea**: 创建 `.claude/agents/product-lead.md`，包含完整 identity + flywheel-comm 行为指令。Lead 基于 prompt 指令自主检查 comm DB（在空闲时、收到事件后、任务边界）。

**Agent 文件结构**:
```markdown
---
name: product-lead
description: Flywheel Product Department Lead
model: opus
tools: Read, Bash, Grep, Glob
permissionMode: bypassPermissions
---

# 你是 Flywheel Product Lead

## 身份
[迁移自 claude-lead/CLAUDE.md]

## flywheel-comm — Runner 通信
- 检查 pending 问题: `node $FLYWHEEL_COMM_CLI pending --lead $LEAD_ID`
- 回答问题: `node $FLYWHEEL_COMM_CLI respond --lead $LEAD_ID <question-id> "答案"`
- 发送指令: `node $FLYWHEEL_COMM_CLI send --from $LEAD_ID --to <exec-id> "指令"`
- 查看 sessions: `node $FLYWHEEL_COMM_CLI sessions --project $PROJECT_NAME`
- 抓取 tmux: `node $FLYWHEEL_COMM_CLI capture --exec-id <exec-id>`

## 检查时机
1. 收到 Discord 事件后 → 检查该 issue 的 Runner 是否有 pending 问题
2. 空闲时（无事件处理中）→ 定期检查 pending
3. CEO 提到某个 issue 时 → 查看其 session + capture
```

**Pros**:
- 最简单 — 一个文件搞定
- Claude Code 原生机制，idiomatic
- Prompt 即行为 — 容易迭代调整
- 不需要额外 hooks 或基础设施
- 版本控制在 GeoForge3D repo

**Cons**:
- 依赖 LLM "记住"检查 — 如果 Lead 忙于 Discord 对话，可能忘记轮询
- 没有硬保证检查频率
- Agent 文件会比较长（~200 行）

**Effort**: Small（2-4 小时）

### Option B: Agent File + PostToolUse Hook

**Core idea**: Agent 文件只定义 identity + tools。额外配置 PostToolUse hook，每次工具调用后自动运行 `flywheel-comm pending`，如果有 pending 问题就注入 additionalContext 提醒 Lead。

**Hook 配置**（settings.json 或 agent frontmatter）:
```json
{
  "hooks": {
    "PostToolUse": [{
      "type": "command",
      "command": "flywheel-comm pending --lead $LEAD_ID --json",
      "matchTools": ["Bash", "Read"],
      "onOutput": "inject"
    }]
  }
}
```

**Pros**:
- 自动化 — Lead 不可能"忘记"检查
- 实时性高 — 每次工具调用后都检查
- 和现有 Codex review hook 模式一致

**Cons**:
- 检查太频繁 — 每次工具调用都查 DB，可能影响性能
- Hook 配置复杂 — 需要处理环境变量传递
- Hook 的 `additionalContext` 注入可能干扰 Lead 的思路
- Claude Code hook 格式可能不完全支持这种用法（需要验证）
- 额外的配置散布在多个地方

**Effort**: Medium（4-6 小时）

### Option C: `--append-system-prompt` 替代 Agent 文件

**Core idea**: 不创建 agent 文件。在 `claude-lead.sh` 中用 `--append-system-prompt` 注入 identity + flywheel-comm 指令。保留项目 CLAUDE.md 提供上下文。

```bash
claude \
  --channels "plugin:discord@claude-plugins-official" \
  --append-system-prompt "$(cat $FLYWHEEL_DIR/prompts/product-lead.txt)" \
  --dangerously-skip-permissions
```

**Pros**:
- 配置完全在 Flywheel repo 内（不跨 repo）
- Shell 变量可以直接插值
- 不需要理解 `--agent` 机制

**Cons**:
- 不能设置 `tools` 限制（Lead 能访问所有工具）
- 不能设置 `model` 限制
- 不能用 agent persistent memory
- 长 prompt 在 bash 脚本中维护困难
- 不是 Claude Code 推荐的方式
- `--append-system-prompt` 是追加不是替换 — 无法去掉默认行为

**Effort**: Small（1-2 小时）

### Recommendation: Option A

理由：
1. **简单优先** — GEO-205 已决定用 agent 文件，Option A 是最直接的实现
2. **Prompt-based polling 够用** — Lead 的工作节奏本身就是事件驱动（Discord 消息到来），在处理事件的间隙检查 pending 是自然的行为
3. **如果不够再加 Hook** — Option A 不排斥以后追加 Hook，但现在不需要过度工程
4. **单一文件** — 所有行为定义在一个 agent 文件中，容易理解和维护

## 4. 关键设计细节

### 4.1 Agent 文件内容组织

建议结构（迁移 + 新增）：

| Section | 来源 | 内容 |
|---------|------|------|
| 身份 & 限制 | 迁移自 claude-lead/CLAUDE.md | 角色、不做什么、汇报风格 |
| 事件处理 | 迁移自 claude-lead/CLAUDE.md | Discord 事件 → Bridge API |
| Bubble DOWN | 迁移自 claude-lead/CLAUDE.md | CEO 指令执行 |
| Runner 通信 | **新增** | flywheel-comm CLI 用法 |
| 检查策略 | **新增** | 何时检查、自答 vs 上报 |
| 工具参考 | 迁移自 claude-lead/CLAUDE.md | Discord MCP + Bridge API + flywheel-comm |

### 4.2 Runner 通信检查策略

Lead 需要知道**何时检查**和**如何决策**：

**何时检查 pending 问题**:
1. 处理完一个 Discord 事件后
2. 空闲等待时（无事件处理中）
3. CEO 提到某个 issue 时
4. 收到 session_completed/session_failed 事件后

**自答 vs 上报 CEO**:
- **自答**: 技术问题（API 用法、代码风格、依赖选择）、可从 CLAUDE.md/项目上下文推断的答案
- **上报**: 需要产品决策、涉及范围变更、影响用户可见行为、需要 CEO 确认

### 4.3 Supervisor 脚本修改

```bash
# Before
claude --channels "plugin:discord@claude-plugins-official" \
  --dangerously-skip-permissions

# After
claude --agent product-lead \
  --channels "plugin:discord@claude-plugins-official"
# permissionMode: bypassPermissions 已在 agent frontmatter 中设置
```

### 4.4 旧文件处理

| 文件 | 操作 |
|------|------|
| `product/.lead/claude-lead/CLAUDE.md` | 内容迁移到 agent 文件后删除 |
| `product/.lead/product-lead/` | OpenClaw 遗留，可归档 |

## 5. Clarifying Questions

### Scope

Q1: Agent 文件创建在**哪个 repo**？GEO-205 决定放 GeoForge3D（`.claude/agents/product-lead.md`）。但 flywheel-comm 是 Flywheel 的组件 — agent 文件引用 `$FLYWHEEL_COMM_CLI`（Flywheel 编译产物）。跨 repo 依赖可以接受吗？还是要改放在 Flywheel repo 用 `--append-system-prompt` 注入？

Q2: 现有的 `product/.lead/claude-lead/CLAUDE.md` 有 5KB 内容。全部迁移到 agent 文件会让 agent prompt 很长（~200 行）。是否需要精简？还是保持完整迁移？

### 行为策略

Q3: Lead 检查 pending 问题的频率 — 是信任 LLM 在 prompt 指导下自主判断（Option A），还是需要机械化保证（Option B hook）？

Q4: Lead 发现 Runner 有问题时，默认行为是**自己回答还是先问 CEO**？建议规则：技术问题自答，产品/范围问题上报。你同意吗？

## 6. User Decisions

1. **Agent 文件位置**: GeoForge3D `.claude/agents/product-lead.md` — Claude Code 原生位置，和其他 executor agents 放一起。通过环境变量引用 Flywheel 组件。

2. **内容迁移**: 完整迁移 `product/.lead/claude-lead/CLAUDE.md` 的全部内容到 agent 文件，追加 flywheel-comm 行为指令。Agent prompt 会比较长（~200 行）但保持完整。

3. **Comm 检查机制**: Option A — Prompt 驱动。Agent prompt 中写明检查时机，信任 LLM 自主判断。不加 Hook。如果实际效果不好再考虑追加。

4. **Escalation 策略 — 渐进式自主权**:
   - **Phase 1（当前）**: 所有 Runner 问题都上报 CEO，Lead 作为中继。Lead 不自行回答。
   - **未来**: 逐步让 Lead 判断哪些问题可以自答（技术问题先放开），减少 CEO 负担。
   - 这是一个 iterate 的过程，不是一步到位。

5. **选定方案**: Option A — Agent File + Prompt-based Comm

## 7. Suggested Next Steps

- [ ] 进入 /research 阶段 — 验证 `--agent` + `--channels` 组合、测试 env var 在 agent prompt 中的行为
- [ ] 实现 agent 文件 + 修改 supervisor 脚本
- [ ] E2E 验证 — 启动 Lead，验证它主动使用 flywheel-comm
