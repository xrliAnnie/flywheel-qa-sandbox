# Cyrus — Reference Overview

> Source: [github.com/ceedaragents/cyrus](https://github.com/ceedaragents/cyrus) | [atcyrus.com](https://www.atcyrus.com/) | Apache 2.0

## What It Is

Cyrus 是一个 **AI development agent for Linear**。核心流程：

```
Linear issue (assigned to Cyrus)
  → 创建 isolated Git worktree
  → 启动 Claude Code session
  → 执行代码修改 + 跑测试
  → 创建/更新 PR
  → 在 Linear comment 里汇报进度
```

支持多种 AI backend（Claude Code, Cursor, Codex, Gemini）和多种 issue tracker（Linear, GitHub, Slack）。

## Key Capabilities

| Feature | Detail |
|---------|--------|
| Issue processing | 监控 Linear/GitHub，自动处理 assigned issues |
| Orchestrator mode | 把大 epic 拆成 sub-issues，逐个执行 |
| Git worktree isolation | 每个 issue 一个独立 worktree，不互相干扰 |
| Interactive approvals | 通过 Linear comment 做 human-in-the-loop（dropdown, buttons） |
| Quality gates | 自动跑 tests, checks, linting |
| Self-hosted | Mac, Linux, VPS，或 managed hosting |

## Architecture (from research)

核心 interfaces：

| Interface | Role |
|-----------|------|
| `IIssueTrackerService` | Linear issue CRUD + relation access |
| `IAgentRunner` | Claude Code session lifecycle (spawn, monitor, kill) |
| `IActivitySink` | Event logging + notification routing |

这些 interface 是 Cyrus 的扩展点 — 加新功能（比如 Discord sink）不需要改核心代码。

## What Cyrus Does vs What We Need

```
                        Cyrus 已有        Flywheel 需要补
                        ─────────        ───────────────
Linear → Issue fetch      ✅               ✅ (直接用)
Issue → Claude Code       ✅               ✅ (直接用)
Claude Code → PR          ✅               ✅ (直接用)
Dependency DAG            ❌               ✅ (新建)
Auto-loop (next issue)    ⚠️ (epic only)   ✅ (跨 epic, 基于 DAG)
Discord notifications     ❌               ✅ (新建)
Memory isolation          ❌               ✅ (新建)
Approval via Discord      ❌               ✅ (替代 Linear comment)
```

## Verdict

Cyrus 覆盖了 Flywheel ~60% 的需求（Linear 集成 + Claude Code session management + PR creation）。
我们需要补的 ~40% 是差异化部分：DAG、Discord、memory、auto-loop。

**Open question**: Fork Cyrus（full control, 可能有维护负担）vs 作为 npm dependency（cleaner, 但受限于其 API）。
