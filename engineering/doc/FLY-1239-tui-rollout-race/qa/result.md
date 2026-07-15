# FLY-1239 QA — 真机 E2E FINAL PASS (6/6)

Issue: FLY-1239 (https://linear.app/geoforge3d/issue/FLY-1239/bug-codex-founder-tui-开窗撞-rollout-落盘-race-threadresume-no-rollout)
日期: 2026-07-14
Harness: scripts/qa-fly-1239-e2e.mjs — 驱动**生产 CodexTmuxAdapter.execute()**（默认 real ensureWindow / killWindow / 默认 unref setTimeout retry scheduler）打**真 codex app-server daemon** + **真 git 链接 worktree** + **真 tmux 窗口**。

## 环境
- tmux 3.5a · codex-cli 0.144.4 · 真 ~/.codex auth · load ~4.4
- daemon = flywheelCodexBin (rotation shim) · founder TUI = rawCodexBin（TTY-capable）
- DEST 目录隔离到 /tmp（不碰生产 ~/.flywheel 状态树）；socket 58 bytes（SUN_LEN 103 内）

## 结果 6/6 PASS（Lead 三条断言全绿）

| id | pass | 断言 |
|----|------|------|
| **A3-founder-tui-recovered** | ✅ | ① 窗口活 + ② 内容显示：founder TUI 达 LIVE+rendering 状态（**61** live samples / **53** 行真实 thread 内容）。日志 `founder TUI up (FLY-1239, thread 019f5f90...)` —— 原 `no rollout found` 秒死场景真机**不再发生** |
| **NP-no-pile-up-sampled** | ✅ | ③ 重试期间同名窗口 ≤1：64 次采样 max simultaneous 'FLY-1239' windows = **1** |
| NP-race-diag | ✅ | 2s sampler 未采到瞬时 `no rollout found`（retry/async-first-attempt 恢复够快）；确定性 ≤1 证明 = 单测 multiset-by-window-id |
| G-goal-terminal | ✅ | adapter run success=true, 128s, 无 throw（窗口路径不影响 machine run）|
| H4-worktree-commit | ✅ | daemon 真在链接 worktree 提交：`43a10fe qa 1239` |
| T-clean-teardown | ✅ | socket removed=true；orphan daemons=[]；lingering TUIs=[] |

## before/after 对照
- **修前**（FLY-1236 A3 真机）：同款形态 → `thread/resume failed during TUI bootstrap: no rollout found for thread id ... (-32600)` → `Pane is dead (status 1)`。
- **修后**（本次）：61/64 采样 founder TUI **活着且渲染真实 thread 内容**（见 tui-pane-capture.txt：真 `codex resume --remote` TUI 显示 agent 的 commit 审计 / env 检查等实际工作）。

## 证据文件（本目录）
- `e2e-result.json` — 机器可读结果（6 断言 + 计数）
- `tui-pane-capture.txt` — 最丰富一帧 pane 截取（53 行，证明 TUI 渲染真实 thread）
- `result.md` — 本小结
