# Exploration: Runner tmux session 用 issue ID + title 命名 — GEO-269

**Issue**: GEO-269 (Runner tmux session 用 issue ID + title 命名)
**Date**: 2026-03-27
**Status**: Draft

## Problem

当 Flywheel 同时运行多个 Runner 时，操作员需要快速识别每个 tmux session/window 在处理哪个 issue。

当前状态：
- `tmux ls` → `GEO-265: 1 windows` — 只有 issue ID，看不出内容
- `tmux list-windows` → `claude:Add-version-display-to-footer` — 有标题但没 issue ID
- Claude Code 内部 session 无 display name → `/resume` 列表难以区分

## Questions to Research

### Q1: Claude Code 内建命名能力

Claude Code CLI 有 `-n, --name` 参数和 `--tmux` flag。需要搞清楚：

- `--name` 设置的 "terminal title" 在 tmux 环境下表现如何？
- `allow-rename off`（TmuxAdapter 当前设置）是否会阻止 `--name` 生效？
- `--tmux` flag 是否创建独立的 tmux session 并自带命名逻辑？可以替代 TmuxAdapter 吗？
- `--name` 对 Claude 内部 session 管理（`/resume` picker）的影响？

### Q2: tmux 命名机制

tmux 有多种命名方式，需要理解它们的交互：

- `new-session -s name` — session 创建时命名
- `new-window -n name` — window 创建时命名
- `rename-session` / `rename-window` — 运行时重命名
- `allow-rename on/off` — 控制程序是否能通过 escape sequence 修改 window 名
- `automatic-rename on/off` — tmux 自动根据运行程序命名
- Session 名合法字符：不能包含 `.` 和 `:`，不能以 `-` 开头

### Q3: 下游依赖分析

改变命名会影响哪些组件：

- `run-issue.ts` 的 auto-interaction（`tmuxTarget` 拼接）
- `session-capture.ts`（Lead 读取 Runner tmux 输出）
- CommDB `registerSession`（存储 tmux target）
- Terminal viewer AppleScript（等待 session 出现）
- Slack notification（包含 session name）
- `killTmuxSession` 清理逻辑

### Q4: `sessionDisplayName` 历史

这个字段已存在但未使用，原始设计意图是什么？是否有未完成的计划？

### Q5: 命名策略选项

至少有几种方案：

**A) Flywheel 自己控制命名** — 改 `run-issue.ts` + `buildWindowLabel()`
- 优点：完全掌控，不依赖 Claude CLI 行为
- 缺点：维护成本，需要同步多处命名逻辑

**B) 利用 Claude Code `--name`** — 传 `--name` 给 Claude CLI，靠 Claude 设置 terminal title
- 优点：利用现有能力，Claude session 管理也受益
- 缺点：`allow-rename off` 可能阻止 tmux 层面的效果

**C) 混合方案** — Flywheel 控制 tmux 层命名 + 传 `--name` 给 Claude
- 优点：两层都有好命名
- 缺点：命名可能不一致（tmux 名和 Claude session 名格式不同）

**D) 切换到 Claude `--tmux`** — 让 Claude 自己管理 tmux session
- 优点：减少 TmuxAdapter 复杂度
- 缺点：可能失去 Flywheel 的 session 控制能力（heartbeat、dynamic timeout、comm DB 注入等）

## Scope Boundaries

- 本 issue 只做命名改善，不重构 TmuxAdapter
- GEO-270（session 自动清理）是独立 issue
- 不改变 session/window 的创建/销毁逻辑
