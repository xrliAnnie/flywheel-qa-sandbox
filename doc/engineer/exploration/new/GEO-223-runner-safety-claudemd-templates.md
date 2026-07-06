# Exploration: Runner 安全边界 + CLAUDE.md 结构化 — GEO-223

**Issue**: GEO-223 (Runner 安全边界 + CLAUDE.md 结构化 — autoresearch 启发)
**Domain**: Infrastructure / Architecture
**Date**: 2026-03-22
**Depth**: Standard
**Mode**: Technical
**Status**: draft

---

## 0. 问题陈述

### Runner 缺乏安全边界

当前 Runner 使用 `bypassPermissions` 模式，可以修改任何文件、运行任何命令。这在 autoresearch 的对比下尤其明显 — autoresearch 将文件分为只读（`prepare.py`）和可修改（`train.py`），agent 不能通过修改 eval 函数来"作弊"。

Flywheel Runner 没有类似约束。一个被指派修复前端 bug 的 Runner 理论上可以修改数据库 schema。

### Runner 行为定义缺乏结构

Runner 行为由两个源定义：
1. **Blueprint system prompt**（`Blueprint.ts:251-302`）— 硬编码的 6 步流程
2. **产品 repo CLAUDE.md** — 项目级约定

两者都是"一刀切"：不论任务类型（feature 实现 / bug fix / 性能优化 / 探索性调研），Runner 收到的行为指导都相同。autoresearch 的 `program.md` 有清晰的分区（Setup / Constraints / Loop / Tracking / Principles），更结构化。

### 架构过渡期的考量

> **GEO-206 会大改架构**：Blueprint/DAG 被 Lead 吸收，Lead 直接启动 Runner。

GEO-223 的设计必须**同时适用于两种架构**：
- **当前**: Blueprint 构造 system prompt + CLI args → TmuxAdapter 启动
- **未来 (GEO-206+)**: Lead 直接构造 CLI args → tmux 启动

关键洞察：**Runner 的启动参数（`--allowed-tools`、`--permission-mode`、`--append-system-prompt`、`--agent`）在两种架构下完全相同**。变的是"谁构造参数"，不是"参数怎么用"。因此 GEO-223 应该设计在 **CLI 层面**，不绑定 Blueprint 或 Lead。

---

## 1. Affected Files and Services

| File/Service | Impact | Notes |
|-------------|--------|-------|
| `.claude/agents/runner-*.md` | **新增** | Runner agent 定义文件（不同任务类型） |
| `packages/edge-worker/src/Blueprint.ts` | modify | 按任务类型选择 agent/prompt（当前架构） |
| `packages/claude-runner/src/TmuxAdapter.ts` | minimal | 已支持 `--allowed-tools`，可能加 `--agent` |
| `packages/core/src/adapter-types.ts` | minimal | 已有 `allowedTools`、`permissionMode` |
| 产品 repo `.claude/agents/` | **新增** | Runner agent 定义放在产品 repo 中 |
| Lead CLAUDE.md / supervisor | modify | 未来架构：Lead 按任务类型选择 agent |

---

## 2. 现有能力盘点

### 2.1 已有的约束机制

| 机制 | 现状 | 位置 |
|------|------|------|
| `--permission-mode` | ✅ 已用 `bypassPermissions` | `TmuxAdapter.ts:184` |
| `--allowed-tools` | ✅ 已支持但未使用 | `TmuxAdapter.ts:188-189` |
| `--agent` | ❌ 未使用 | `buildClaudeArgs()` 不传递 |
| `--append-system-prompt` | ✅ 已用（Blueprint 构造） | `TmuxAdapter.ts:185-186` |
| `--add-dir` | ❌ 未使用 | CLI 原生，限制工作目录 |
| PreToolUse Hooks | ❌ 未使用 | Claude Code hooks 机制 |
| `AdapterExecutionContext.allowedTools` | ✅ 已定义 | `adapter-types.ts:154` |
| `AdapterExecutionContext.hooks` | ✅ 已定义 | `adapter-types.ts:193` |

### 2.2 Claude Code Agent 定义能力

```yaml
# .claude/agents/runner-feature.md
---
name: runner-feature
description: Runner for implementing new features
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  # 排除: Agent, NotebookEdit, WebSearch 等
---

You are a Flywheel Runner implementing a feature...
```

**关键限制**:
- `tools:` 字段可以限制可用工具列表（白名单）
- `Bash(git:*)` 语法可以限制 Bash 子命令
- **不能限制文件路径** — 没有 `Write(src/**)` 这样的语法
- Agent 定义是静态文件，不能动态生成

### 2.3 PreToolUse Hooks 能力

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{
          "type": "command",
          "command": "echo 'approve'"
        }]
      }
    ]
  }
}
```

- 可以在 Write/Edit 前验证文件路径
- 通过 `AdapterExecutionContext.hooks` 传递
- TmuxAdapter 当前不传递 hooks（只有 ClaudeRunner SDK 用）
- **TmuxAdapter 用 CLI 模式，hooks 通过 `.claude/settings.json` 或项目配置生效**

---

## 3. 外部研究

### Claude Code --agent 能力（2026 Q1）

| 能力 | 支持 | 备注 |
|------|------|------|
| 工具白名单 (`tools:`) | ✅ | agent 定义 YAML 字段 |
| 工具黑名单 | ❌ | 只有白名单模式 |
| Bash 子命令限制 (`Bash(git:*)`) | ✅ | 粒度可控 |
| 文件路径限制 | ❌ | 无原生支持 |
| 工作目录限制 (`--add-dir`) | ✅ | 限制可访问目录 |
| model override | ✅ | agent 定义可指定 model |
| 系统 prompt | ✅ | agent 定义 body 即 system prompt |
| skills 注入 | ✅ | agent 定义可引用 skills |

### autoresearch 的安全模式

| 机制 | autoresearch | Flywheel 对标 |
|------|-------------|--------------|
| 只读文件 | `prepare.py` 不可改 | 需要 hooks 或 prompt 约束 |
| 可改文件 | 仅 `train.py` | 需要 hooks 或 prompt 约束 |
| eval 防作弊 | eval 在只读文件中 | CI/test 不受 Runner 控制（已有） |
| 时间预算 | 5 min wall-clock | `timeoutMs`（已有，45 min） |
| 自动 revert | regression → `git revert` | 无（GEO-222 后续） |

---

## 4. Options Comparison

### Option A: Agent 定义文件 + 系统 prompt 模板（推荐）

**Core idea**: 在产品 repo 的 `.claude/agents/` 下创建不同任务类型的 Runner agent 定义。每个定义包含工具白名单 + 结构化系统 prompt。Blueprint（当前）或 Lead（未来）按任务类型选择 agent。

```
产品 repo/.claude/agents/
├── runner-feature.md      # 实现功能：完整工具集，one-shot 模式
├── runner-bugfix.md       # 修复 bug：完整工具集，focused scope
├── runner-explore.md      # 探索调研：Read-only 工具，记录发现
└── runner-optimize.md     # 性能优化：完整工具集，iterative 模式
```

每个 agent 定义的 body 即结构化 prompt（autoresearch `program.md` 模式）：

```markdown
---
name: runner-feature
tools: [Read, Write, Edit, Bash, Glob, Grep]
---

## Setup
Read CLAUDE.md and understand the project context.

## Constraints
- Create a feature branch, never commit to main
- Follow TDD: write tests first
- Do not modify files outside the scope of this issue

## Execution Loop
1. Read codebase → understand context
2. Write tests → RED
3. Implement → GREEN
4. Refactor → CLEAN
5. Create PR

## Tracking
- Commit messages: `feat: description (GEO-XXX)`
- PR description: summary + test plan

## Principles
- Simpler is better
- Do not ask questions — implement your best judgment
```

**Pros**:
- **架构无关** — agent 定义是 Claude Code 原生机制，Blueprint 和 Lead 都可以用 `--agent runner-feature`
- **版本控制** — agent 定义跟产品代码一起管理
- **工具白名单** — `runner-explore` 可以排除 Write/Edit，做真正的只读探索
- **零代码改动** — TmuxAdapter 已支持 `--allowed-tools`，只需传 `--agent` 即可
- **增量可实施** — 先做一个 `runner-feature.md`，逐步加更多类型

**Cons**:
- 文件路径限制仍然是软约束（prompt 里说"不要改 X"，不是硬性阻止）
- Blueprint/Lead 需要知道如何选择 agent 类型（需要任务分类逻辑）
- agent 定义是静态的，不能动态注入 issue-specific 内容（需要配合 `--append-system-prompt`）

**Effort**: Small（1 周）— 主要是设计 agent 定义内容 + 修改 Blueprint 传递 `--agent`

**What gets cut**: 文件路径级别的硬性约束

---

### Option B: PreToolUse Hooks 硬约束

**Core idea**: 通过 Claude Code hooks 机制，在 Write/Edit 操作前验证文件路径。只允许修改指定范围内的文件。

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.flywheel/scripts/validate-scope.py --scope '$SCOPE' --file '$TOOL_INPUT.file_path'"
      }]
    }]
  }
}
```

**Pros**:
- **硬性约束** — hook 返回 deny 则操作不执行
- **文件级精度** — 可以精确到"只允许改 `src/components/`"
- **防作弊** — Runner 无法绕过

**Cons**:
- **TmuxAdapter 当前不传递 hooks** — CLI 模式下 hooks 通过 settings.json 生效，不是通过 API
- **动态 scope 注入复杂** — 每个 Runner 的 scope 不同，需要动态生成 hook 配置
- **调试困难** — hook 失败时 Runner 可能卡住或反复重试
- **需要额外脚本** — `validate-scope.py` 需要维护
- **与 GEO-206 耦合** — Lead 启动 Runner 时需要动态设置 per-session hooks

**Effort**: Medium（2 周）— hook 机制 + scope 脚本 + 动态配置

**What gets cut**: 简单性。增加了一个移动部件。

---

### Option C: 纯 System Prompt 软约束（最小方案）

**Core idea**: 不引入新机制，只改善 Blueprint system prompt 的结构和内容。按 autoresearch `program.md` 的模式分区。

**Pros**:
- **零新依赖** — 只改 prompt 文本
- **最快** — 半天可完成
- **与 GEO-206 兼容** — Lead 的 CLAUDE.md 天然是 system prompt

**Cons**:
- **纯软约束** — Claude 可能不遵守"不要改 X 文件"
- **没有工具限制** — Runner 仍然可以做任何事
- **Blueprint 硬编码** — 当前 prompt 在 Blueprint.ts 里硬编码，换架构要重写

**Effort**: XS（0.5 天）

**What gets cut**: 所有硬性约束

---

### Recommendation: Option A（Agent 定义文件 + 系统 prompt 模板）

**理由**:

1. **架构无关** — `--agent runner-feature` 在 Blueprint 和 Lead 下都能用，不怕 GEO-206 改架构
2. **工具白名单是真正的硬约束** — `runner-explore` 没有 Write/Edit 就是不能写文件
3. **增量可实施** — 先做 `runner-feature.md`（当前唯一的任务类型），后续逐步加
4. **复用 Claude Code 原生机制** — 不自建新系统
5. **版本控制** — agent 定义跟代码一起 review 和 merge

文件路径级约束（Option B）可以作为 **Phase 2 增强**，在 Option A 的基础上叠加。

---

## 5. Clarifying Questions

### Scope

1. **Phase 1 需要几种 Runner 类型？** 建议从 `runner-feature`（当前唯一场景）开始，还是一次定义所有类型（feature / bugfix / explore / optimize）？

2. **Agent 定义放哪里？** 产品 repo 的 `.claude/agents/`（跟代码一起）还是 Flywheel repo 的某个目录（集中管理）？

### 架构过渡

3. **Blueprint 需要改吗？** 如果 GEO-206 很快就会淘汰 Blueprint，是否跳过 Blueprint 改造，直接为 Lead 设计？还是两边都改（保证过渡期可用）？

4. **TmuxAdapter 要加 `--agent` 支持吗？** 当前 `buildClaudeArgs()` 不传 `--agent`。需要加吗？还是通过 `.claude/settings.json` 的 default agent 实现？

### 内容

5. **Runner CLAUDE.md vs agent 定义 — 内容边界？** 产品 repo 的 CLAUDE.md 已经有项目约定。agent 定义的 prompt 应该包含什么？建议：
   - **CLAUDE.md**: 项目约定（代码风格、测试要求、PR 规范）— 所有 Runner 共享
   - **Agent 定义**: 任务类型特定的行为模式（one-shot vs iterative、scope、tracking）

---

## 6. User Decisions

(待 Q&A 填充)

## 7. Suggested Next Steps

- [ ] 确认 Option A 方向
- [ ] 回答 clarifying questions
- [ ] `/research` — 深入研究 agent 定义最佳实践 + 测试 `--agent` 在 tmux session 中的行为
