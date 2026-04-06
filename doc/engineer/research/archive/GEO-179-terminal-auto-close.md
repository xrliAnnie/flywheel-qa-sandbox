# Research: Terminal Auto-Close Fix — GEO-179

**Issue**: GEO-179
**Date**: 2026-03-16
**Source**: `doc/engineer/exploration/new/GEO-179-terminal-auto-close.md`

## 1. tmux 行为验证

### 1a. `tmux list-clients` 输出格式

| 场景 | Exit Code | Output |
|------|-----------|--------|
| Session 存在，无 attached clients | 0 | 空字符串 (length=0) |
| Session 存在，有 attached clients | 0 | Client 列表（每行一个） |
| Session 不存在 | 1 | `can't find session: ...` |

**结论**: 可以用 `output.trim().length > 0` 判断是否有 client attached。Exit code 0 + 空输出 = 无 client。

### 1b. `tmux attach` 退出码

- 正常 detach（`Ctrl+B d`）：exit code **0**
- Session 被外部 kill（`tmux kill-session`）：exit code **非 0**（shell 收到连接断开信号）
- Session 不存在：exit code **1**

**结论**: `; exit` 会继承 tmux attach 的退出码。当 session 被 `killTmuxSession()` 杀掉时，`exit` 会以 non-zero 退出。Terminal.app 默认 Basic profile (`shellExitAction` 未设置 → 默认值 1 = "Close if clean exit") 不会关闭 non-zero 退出的窗口。**必须用 `; exit 0`**。

## 2. 三处 Viewer 打开代码详细分析

### 2a. `DagDispatcher.openTmuxViewer()` (edge-worker)

```typescript
// packages/edge-worker/src/DagDispatcher.ts:184-196
private openTmuxViewer(): void {
    const s = this.tmuxSessionName;
    execFile("osascript", [
        "-e",
        `tell application "Terminal" to do script "tmux attach -t '=${s}' 2>/dev/null || (echo 'Waiting...' && sleep 2 && tmux attach -t '=${s}')"`,
    ], (err) => { /* warn */ });
}
```

**问题**:
1. 无 `; exit 0` → Terminal 窗口不关闭
2. 无 dedup → 每次 `dispatch()` 都打开新窗口
3. 使用 `execFile`（async callback）→ fire-and-forget
4. import 只有 `execFile`，dedup 需要同步的 `execFileSync`

**调用链**: `dispatch()` → `openTmuxViewer()` → 由 `run-project.ts` 触发

### 2b. `scripts/run-issue.ts:258-266`

```typescript
execFileSync("osascript", [
    "-e",
    [
        'tell application "Terminal"',
        `  do script "echo 'Waiting...' && while ! tmux has-session -t '=${name}' 2>/dev/null; do sleep 1; done && tmux attach -t '=${name}'; exit"`,
        "  activate",
        "end tell",
    ].join("\n"),
]);
```

**状态**: 已有 `; exit`，但应改为 `; exit 0`。有 `activate`（bring to front）。使用 `execFileSync`。无 dedup（但 `run-issue.ts` 通常只运行一次）。

### 2c. `scripts/e2e-tmux-runner.ts:191-194`

```typescript
execFileSync("osascript", [
    "-e",
    `tell application "Terminal" to do script "echo 'Waiting...' && while ! tmux has-session -t flywheel-e2e 2>/dev/null; do sleep 1; done && tmux attach -t flywheel-e2e"`,
]);
```

**问题**: 无 `; exit 0`。硬编码 session name `flywheel-e2e`。

## 3. DagDispatcher 测试基础设施

### 现有 mock 策略

```typescript
vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
        ...actual,
        execFile: vi.fn(),
    };
});
```

**关键发现**: 只 mock 了 `execFile`，`execFileSync` 未被 mock。如果 dedup 用 `execFileSync`，需要在 mock 中添加。

### 建议的 mock 更新

```typescript
vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
        ...actual,
        execFile: vi.fn(),
        execFileSync: vi.fn(() => ""),  // 默认返回空字符串（无 client）
    };
});
```

这样 dedup 检查在测试中默认通过（无 client → 允许打开），需要 dedup 测试时可以 mock 返回值。

## 4. 实现细节研究

### 4a. Dedup 实现方案

**选项 1: `execFileSync` 同步检查（推荐）**

```typescript
private openTmuxViewer(): void {
    const s = this.tmuxSessionName;
    // Dedup: skip if already attached
    try {
        const clients = execFileSync("tmux", ["list-clients", "-t", `=${s}`], {
            encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        });
        if (clients.trim().length > 0) {
            console.log(`[DagDispatcher] Viewer already attached to ${s}, skipping`);
            return;
        }
    } catch {
        // Session doesn't exist yet — proceed to open (tmux attach will wait/retry)
    }
    // ... open Terminal
}
```

**优势**: 简单、同步、可测试。`openTmuxViewer()` 本身被同步调用（dispatch() line 66），加一个同步前置检查语义一致。

**选项 2: 把 dedup 嵌入 shell 命令**

```bash
tmux list-clients -t '=${s}' 2>/dev/null | grep -q . && exit 0; tmux attach -t '=${s}'; exit 0
```

**劣势**: 逻辑藏在 shell 字符串里，不可测试，难以 log。

### 4b. `; exit 0` 放置位置

在 osascript 的 shell 命令末尾：

```
tmux attach -t '=${s}' 2>/dev/null || (echo 'Waiting...' && sleep 2 && tmux attach -t '=${s}'); exit 0
```

注意 `; exit 0` 在整个命令链之外，确保无论 tmux attach 以何种方式退出都执行 `exit 0`。

### 4c. Import 变更

```typescript
// DagDispatcher.ts line 3
- import { execFile } from "node:child_process";
+ import { execFile, execFileSync } from "node:child_process";
```

## 5. 影响范围总结

| 文件 | 变更类型 | 变更内容 |
|------|---------|---------|
| `packages/edge-worker/src/DagDispatcher.ts` | modify | 加 `execFileSync` import, dedup check, `; exit 0` |
| `scripts/e2e-tmux-runner.ts` | modify | 加 `; exit 0` |
| `scripts/run-issue.ts` | modify | `; exit` → `; exit 0` |
| `packages/edge-worker/src/__tests__/DagDispatcher.test.ts` | modify | mock `execFileSync`, 加 dedup 测试 |

**不需要改的**:
- `run-project.ts` — 通过 `DagDispatcher` 间接受益
- `run-bridge.ts` — 无 viewer 代码
- `TmuxAdapter.ts` — 不涉及 viewer 逻辑
- `packages/edge-worker/src/index.ts` — DagDispatcher 已导出，无新 export

## 6. 测试策略

### 新增测试

1. **dedup test**: mock `execFileSync` 返回 client 列表 → verify `execFile`（osascript）不被调用
2. **non-dedup test**: mock `execFileSync` 返回空字符串 → verify `execFile`（osascript）被调用
3. **dedup error test**: mock `execFileSync` throw → verify fallthrough 到 open（session 可能还未创建）

### 验证 `; exit 0`

这需要 manual/E2E 验证（不能在 unit test 中验证 Terminal 行为）：
1. 运行 `run-project.ts`，确认 Terminal 窗口打开
2. 等 Blueprint 完成或手动 `killTmuxSession()`
3. 确认 Terminal 窗口自动关闭

## 7. 风险评估

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| `execFileSync` 阻塞 dispatch | Low | `tmux list-clients` 执行 < 10ms，且只在 dispatch 开头调用一次 |
| `exit 0` 掩盖真实错误 | Low | 这只是 Terminal viewer shell 的退出码，不影响 Blueprint 执行或结果判断 |
| 测试 mock 不完整 | Low | 现有测试已 mock `execFile`，加 `execFileSync` mock 是增量变更 |
| macOS-only 限制 | N/A | 项目当前只在 Mac 运行，这是已知约束 |
