# Exploration: Terminal Windows Not Auto-Closing — GEO-179

**Issue**: GEO-179 (Fix: Terminal windows not auto-closing after tmux session ends)
**Date**: 2026-03-16
**Depth**: Standard
**Mode**: Technical
**Status**: final

## 0. Product Research

Product research skipped (Technical mode).

## 1. Affected Files and Services

| File/Service | Impact | Notes |
|-------------|--------|-------|
| `packages/edge-worker/src/DagDispatcher.ts` | modify | `openTmuxViewer()` 缺少 `; exit`，无 dedup |
| `scripts/e2e-tmux-runner.ts` | modify | 同样缺少 `; exit` |
| `scripts/run-issue.ts` | no change | 已有 `; exit`，可作为参考实现 |
| `scripts/run-project.ts` | no change | 通过 `DagDispatcher` 间接受益 |
| `packages/edge-worker/src/__tests__/DagDispatcher.test.ts` | modify/add | 需要 viewer 相关测试 |

## 2. Architecture Constraints

### 问题分析

**问题 1: Terminal 窗口不自动关闭**

`DagDispatcher.openTmuxViewer()` 使用 osascript 打开 Terminal.app 并执行 `tmux attach`：

```typescript
// DagDispatcher.ts:186-188
execFile("osascript", [
    "-e",
    `tell application "Terminal" to do script "tmux attach -t '=${s}' 2>/dev/null || (...)"`,
]);
```

当 `run-project.ts` 的 `finally` 块调用 `killTmuxSession()` 时，tmux session 被杀，但 Terminal 窗口保持打开，显示 `can't find session: flywheel-geoforge3d`。

对比 `run-issue.ts:262` 已经正确处理：
```typescript
`... && tmux attach -t '=${tmuxSessionName}'; exit"`
```

**关键差异**：`; exit` 让 shell 在 tmux detach/session-end 后自动退出，Terminal 检测到 shell 退出后会关闭窗口（取决于 Terminal 设置 "When the shell exits: Close the window"）。

**问题 2: 无去重**

`openTmuxViewer()` 在每次 `dispatch()` 调用时无条件执行。如果 `run-project.ts` 多次运行（或 retry runtime 触发），每次都会打开一个新的 Terminal 窗口。

可以用 `tmux list-clients -t '=${s}'` 检查是否已有 client attached。

### 约束

- osascript 是 macOS-only — 这是已知的限制，项目目前只在 Mac 上运行
- Terminal.app 的 "When shell exits" 设置会影响 `; exit` 的效果 — 但这是合理的默认行为
- `tmux list-clients` 只检测 tmux 级别的 attach，不检测 Terminal 窗口是否仍打开但 detached
- `execFile` 是异步的（fire-and-forget），failure 是 non-fatal

## 3. External Research

External research skipped — 这是一个内部 bug fix，不涉及外部库。

## 4. Options Comparison

### Option A: Minimal Fix — `; exit` + client dedup

**Core idea**: 在 `openTmuxViewer()` 的 osascript 命令中追加 `; exit`，并在打开前检查是否已有 client attached。

**实现**:
1. 修改 `DagDispatcher.ts:openTmuxViewer()`：
   - 在 tmux attach 命令后加 `; exit`
   - 先执行 `tmux list-clients -t '=${s}'`，如果已有 client 则 skip
2. 修改 `e2e-tmux-runner.ts` 同理加 `; exit`

**Pros**:
- 最小改动，2-3 行核心变更
- 直接解决两个问题
- `run-issue.ts` 已验证 `; exit` 方案有效

**Cons**:
- dedup 用 `tmux list-clients` 只能检测 tmux-level clients，如果 Terminal 窗口打开但 detached 状态，检测不到
- osascript viewer 逻辑散落在 3 个文件中（DagDispatcher, run-issue, e2e-tmux-runner），没有统一

**Effort**: Small (1-2 小时)
**Affected files**: `DagDispatcher.ts`, `e2e-tmux-runner.ts`, tests

### Option B: Extract Shared `TmuxViewer` Utility

**Core idea**: 将 Terminal viewer 逻辑提取到 `packages/edge-worker/src/TmuxViewer.ts`，所有 caller 共用。

**实现**:
1. 新建 `TmuxViewer` class：
   - `open(sessionName)` — 带 `; exit` + dedup
   - `isAttached(sessionName)` — 检查 client 数
   - Static helper，无状态
2. `DagDispatcher`, `run-issue.ts`, `e2e-tmux-runner.ts` 统一调用 `TmuxViewer.open()`

**Pros**:
- DRY，统一行为
- 未来修改只需改一处
- 可以更容易测试

**Cons**:
- Over-engineering — 3 处调用中只有 1 处有 bug
- `run-issue.ts` 的逻辑更复杂（wait loop + activate），不完全能统一
- 新增一个文件

**Effort**: Medium (3-4 小时)
**Affected files**: 新增 `TmuxViewer.ts`, 修改 `DagDispatcher.ts`, `run-issue.ts`, `e2e-tmux-runner.ts`, tests

### Option C: 移除自动 open，改为 opt-in

**Core idea**: 默认不打开 Terminal viewer，通过环境变量 `FLYWHEEL_OPEN_VIEWER=true` opt-in。

**Pros**:
- 彻底消除 orphan 窗口问题
- Headless/daemon 模式（run-bridge.ts）天然不受影响
- 最简单的代码

**Cons**:
- UX 退步 — 用户需要手动 `tmux attach`
- run-issue.ts 的 viewer 是 UX 关键（用户需要看到 Claude 在做什么）
- 对 DagDispatcher 有意义但对 run-issue 不合理

**Effort**: Small
**Affected files**: `DagDispatcher.ts`, `run-project.ts` (env check)

### Recommendation: Option A

Option A 最务实 — 直接修复 bug，改动最小，风险最低。`; exit` 方案已在 `run-issue.ts` 验证可行。dedup 用 `tmux list-clients` 虽不完美但足以解决常见场景。不需要为 3 处调用建立抽象。

## 5. Clarifying Questions

### Scope

- Q1: 是否需要同时修复 `e2e-tmux-runner.ts`，还是只修 `DagDispatcher.openTmuxViewer()`？（e2e 脚本是手动运行的测试工具，影响较小）

### Behavior

- Q2: 对于 dedup，如果检测到已有 attached client 时的行为是什么？静默跳过（log warning），还是完全不 log？

### Terminal Settings

- Q3: `; exit` 的效果依赖 Terminal.app 的 "When the shell exits" 设置。是否需要在 osascript 中额外设置 Terminal profile 来确保窗口自动关闭？还是假设用户已正确配置？

## 6. User Decisions

**Selected approach**: Option A (Minimal Fix)

**Q1 — Scope**: 同时修复 `e2e-tmux-runner.ts`。

**Q2 — Dedup behavior**: 检测到已有 attached client 时跳过并 log（`console.log` 级别，非 warn）。

**Q3 — Terminal settings**: 实际检查了用户的 Terminal.app 配置：
- 默认 profile = Basic, `shellExitAction` 未显式设置（默认值 = 1 = "Close if clean exit"）
- 因此需要使用 `; exit 0`（而非 `; exit`）来强制 clean exit code
- `run-issue.ts:262` 现有的 `; exit` 也应改为 `; exit 0` 以保持一致性
- 不需要额外设置 Terminal profile

**额外发现**: `run-issue.ts` 已有 `; exit` 但应改为 `; exit 0` 以兼容默认 Terminal 设置。

## 7. Suggested Next Steps

- [ ] Write implementation plan based on Option A
- [ ] Implement: `; exit 0` in `DagDispatcher.openTmuxViewer()`, `e2e-tmux-runner.ts`, `run-issue.ts`
- [ ] Implement: `tmux list-clients` dedup check in `openTmuxViewer()`
- [ ] Test: verify Terminal window auto-closes after `killTmuxSession()`
- [ ] Test: verify second `dispatch()` call doesn't open duplicate viewer
