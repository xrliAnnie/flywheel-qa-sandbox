# Research Plan R4: Skill 注入系统设计

> 优先级：🟡 Medium
> 影响 Phase：v0.2
> 输入：`doc/exploration/new/v0.2-trending-repo-survey.md`（claude-scientific-skills 部分）
> 预期产出：`doc/exploration/new/v0.2-skill-system.md`

## 目标

设计 Flywheel 专用的 Claude Code skill 注入系统，利用 claude-scientific-skills 的 SKILL.md 格式，让每个 TmuxRunner session 启动时自动注入项目相关的 context skills。

## 研究任务

### 1. 深入分析 claude-scientific-skills 格式

- 读取 `/tmp/claude-scientific-skills/` 的 skill 文件结构
- 分析 SKILL.md 格式：
  - YAML frontmatter（name, description, allowed-tools）
  - Markdown body（When to Use, NOT to Use, steps）
  - 分层文档引导（references/ 按需加载）
  - Skill 互操作引用
- 分析安装机制（文件复制到 `~/.claude/skills/` 或 `.claude/skills/`）

### 2. 设计 Flywheel 专用 Skills

设计以下 skill 模板：

- **`flywheel-context`**：项目 context 注入（codebase 概述、tech stack、coding conventions）
- **`linear-issue-context`**：Linear issue 相关信息（issue 描述、依赖关系、历史 PR）
- **`flywheel-git-workflow`**：Flywheel 的 git 工作流（branch naming、commit format、PR template）
- **`flywheel-escalation`**：遇到问题时的升级流程（什么时候 shelve、什么时候继续尝试）
- **`flywheel-tdd`**：TDD 工作流强化（RED → GREEN → REFACTOR）

### 3. 设计注入机制

- TmuxRunner 启动前，将 skills 写入 worktree 的 `.claude/skills/`
- 模板化：skill 内容根据 project config 动态生成
- 生命周期：session 开始时注入，session 结束后保留（为下次复用）

### 4. 评估 CLAUDE.md vs SKILL.md

- 当前 Flywheel 用 CLAUDE.md 注入 context
- SKILL.md 提供更细粒度的控制
- 两者如何共存？

## 产出

### 主要文件
- `doc/exploration/new/v0.2-skill-system.md` — Skill 注入系统设计

### 文件内容要求
1. **SKILL.md 格式规范** — 从 claude-scientific-skills 提取的最佳实践
2. **5 个 Flywheel 专用 skill 模板** — 完整的 SKILL.md 文件内容
3. **注入机制设计** — TmuxRunner 如何在 session 启动前注入 skills
4. **动态模板化** — 如何根据 project config 生成 skill 内容
5. **CLAUDE.md + SKILL.md 共存方案**

### 更新
- 更新 `MEMORY.md`：新增 skill 系统设计决策

## 参考资料

- `/tmp/claude-scientific-skills/`（已 clone）
- `doc/exploration/new/v0.2-trending-repo-survey.md`（survey 中 skill 部分）
- 当前 Flywheel CLAUDE.md（作为对比参考）
