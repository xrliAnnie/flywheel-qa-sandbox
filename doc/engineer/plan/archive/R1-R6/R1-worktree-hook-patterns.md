# Research Plan R1: Worktree + Hook 模式 → v0.2 并行执行设计

> 优先级：🔴 High
> 影响 Phase：v0.2
> 输入：`doc/engineer/research/new/004-superset-worktree-hook-patterns.md`
> 预期产出：`doc/engineer/exploration/new/v0.2-parallel-execution.md`

## 目标

为 Flywheel v0.2 设计基于 git worktree 的并行执行架构，整合 superset-ai 的 worktree 管理和 hook 注入模式，以及 ruflo 的 SDK session forking。

## 研究任务

### 1. 深入分析 superset-ai worktree 实现

- 读取 `/tmp/superset-ai/apps/desktop/src/lib/trpc/routers/workspaces/utils/git.ts`
- 提取 `createWorktree`、`removeWorktree`、`isWorktreeRegistered` 的完整实现
- 分析 macOS rename trick（避免 EXDEV error）和 background rm -rf 模式
- 分析 `resolve-worktree-path.ts` 路径策略
- 分析 `workspace-init-manager.ts` 的 per-project mutex

### 2. 深入分析 superset-ai hook 注入

- 读取 `/tmp/superset-ai/apps/desktop/src/main/lib/agent-setup/agent-wrappers-claude-codex-opencode.ts`
- 提取 `claude-settings.json` hook 注入完整实现
- 分析 `templates/notify-hook.template.sh` 的 HTTP callback 模式
- 对比 Flywheel v0.1.1 的 marker file 方案，评估是否升级为 HTTP callback

### 3. 分析 ruflo session forking

- 读取 `/tmp/ruflo/v2/src/sdk/session-forking.ts`
- 验证 `@anthropic-ai/claude-code` SDK 的 `forkSession` API 是否 stable
- 评估 Present mode（tmux 可见）vs Away mode（SDK 高效）的切换设计

### 4. 设计 v0.2 并行执行架构

基于以上分析，设计：

- **Worktree lifecycle**: 创建 → 执行 → 清理
- **路径策略**: `~/.flywheel/worktrees/{project}/{issueId}/`
- **并发控制**: 最大并行 session 数、per-project mutex
- **Hook 升级方案**: marker file → HTTP callback（或两者共存）
- **Present/Away 模式**: tmux（可见）vs SDK forkSession（高效）
- **错误恢复**: worktree 残留清理、orphan session 检测

## 产出

### 主要文件
- `doc/engineer/exploration/new/v0.2-parallel-execution.md` — 完整的并行执行架构设计

### 文件内容要求
1. **Architecture overview**（Mermaid 图）
2. **Worktree management** — TypeScript interface 定义 + 从 superset-ai 移植的核心函数
3. **Hook 升级方案** — 对比 marker file vs HTTP callback，给出建议
4. **Present/Away 模式** — 切换逻辑 + 实现建议
5. **并发控制** — mutex、最大并行数、资源限制
6. **Migration path** — 从 v0.1.1 sequential → v0.2 parallel 的迁移步骤
7. **Follow-up** — 需要 implementation plan 的具体任务列表

### 更新
- 更新 `MEMORY.md`：新增 v0.2 设计决策
- 更新 survey doc（如有新发现）

## 参考资料

- `doc/engineer/research/new/004-superset-worktree-hook-patterns.md`（已有研究摘要）
- `/tmp/superset-ai/`（已 clone）
- `/tmp/ruflo/`（已 clone）
- `doc/engineer/exploration/archive/v0.1.1-interactive-runner-architecture.md`（当前架构）
