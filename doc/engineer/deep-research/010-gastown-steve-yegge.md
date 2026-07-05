---
source: "https://github.com/steveyegge/gastown"
date: 2026-02-26
updated: 2026-02-27
author: "Steve Yegge"
topic: "Gastown — Multi-Agent Workspace Manager (Go)"
relevance: "Medium — Go 语言无法直接复用代码，但 DispatchCycle、状态机、checkpoint pattern 值得在概念层面借鉴"
source_verified: true  # 2026-02-27 实际 clone 并读了核心源码
---

# Gastown: 源码级评估

## Repo Health

| 指标 | 数值 |
|------|------|
| Stars | 10,418 |
| Forks | 822 |
| License | MIT |
| Language | **Go** (100%) |
| Created | 2025-12-16 |
| Last Push | 2026-02-27 (持续活跃) |
| Contributors | 30+ (steveyegge: 3,595 commits 为主) |
| Go Source Files | 477 |
| Go Test Files | 361 (**75.7% test-to-source ratio**) |
| Repo Size | ~16 GB |
| Distribution | Homebrew + npm |

Steve Yegge (ex-Google, ex-Amazon senior engineer) 的正式项目，有完整 CI/CD (GitHub Actions)、CodeCov、goreleaser、shell completions、daemon (launchd/systemd)。**这是 production software，不是原型。**

---

## 它到底是什么

Gastown (`gt`) 是一个 **workspace-level 多 agent 管理器** — 管理 tmux sessions + git worktrees + 持久化状态。

**和 Flywheel 的根本区别**:
- Gastown = workspace manager (管理本地机器上的多个 agent 并行工作)
- Flywheel = issue-level orchestrator (Linear → DAG → Agent → PR → Decision Layer)
- 重叠区域: 两者都需要 dispatch work to agents、track agent state、handle failures

## 源码架构

```
Town (~/gt/)
  |-- Mayor (全局 coordinator, Claude session in tmux)
  |-- Deacon (daemon beacon, heartbeat/monitoring)
  |-- Rig (project container, wraps git repo)
  |     |-- mayor/rig/ (canonical git clone, beads DB)
  |     |-- crew/<name>/ (human workspace, full git clone)
  |     |-- polecats/<name>/ (worker agents, git worktrees)
  |     |-- witness/ (health monitor agent)
  |     |-- refinery/ (merge queue processor)
  |     +-- .beads/ (per-rig issue tracker, redirected to Dolt)
  +-- .dolt-data/ (centralized Dolt SQL Server data)
```

---

## 源码深度分析

### 1. Agent 状态机 (Polecat Manager)

**文件**: `internal/polecat/manager.go` (~1,900 行) + `internal/polecat/types.go`

```go
type State string
const (
    StateWorking State = "working"
    StateIdle    State = "idle"
    StateDone    State = "done"
    StateStuck   State = "stuck"
    StateZombie  State = "zombie"
)
```

Agent (Polecat) 生命周期:
1. `AllocateName()` — 从名字池分配 (Toast, Nux 等)
2. `AddWithOptions()` — 创建 git worktree from `mayor/rig`，设置 shared beads redirect，在 Dolt 创建 agent bead
3. Work 通过 "sling" 分配 (写 bead 到 agent 的 hook)
4. Agent session 在 tmux 启动，通过 `gt prime` 读取 hook
5. 完成后 agent 调用 `gt done`，状态转为 Idle
6. Worktree **保留供复用** (不需要重建)

**关键**: Stuck vs Zombie 的区分 — `stuck` = agent 主动求助，`zombie` = 外部检测到无响应。这个区分对 Flywheel 的 agent-stuck detection (Phase 3) 有参考价值。

**并发处理**: Dolt optimistic lock errors 用 exponential backoff + jitter:
```go
const doltMaxRetries = 10
const doltBaseBackoff = 500 * time.Millisecond
const doltBackoffMax = 30 * time.Second
```

**对 Flywheel**: 状态机设计值得参考。我们的 `reaction_runs` 有 `running | completed | failed | escalated`，可以考虑增加 `stuck` 和 `zombie` 的区分（Phase 3）。

### 2. Capacity Dispatch System (**最值得借鉴的 pattern**)

**文件**: `internal/scheduler/capacity/dispatch.go` + `pipeline.go`

```go
type DispatchCycle struct {
    AvailableCapacity func() (int, error)    // 有多少空闲 slot
    QueryPending      func() ([]PendingBead, error)  // 待处理的 work items
    Execute           func(PendingBead) error         // 执行分配
    OnSuccess         func(PendingBead) error         // 成功回调
    OnFailure         func(PendingBead, error)        // 失败回调
    BatchSize         int
    SpawnDelay        time.Duration
}
```

**源码评价**: 这个 callback-based dispatch pattern 非常干净:
- 分离 planning (dry-run) 和 execution
- Readiness filtering (blocker-aware，不会 dispatch blocked items)
- Failure policies (retry vs quarantine)
- Capacity-controlled batching

**对 Flywheel**: 这个 pattern **直接映射**到我们的 DAG resolver → Claude Code dispatch loop。我们的 `DagResolver` 找到 ready nodes → capacity check → dispatch to `IAgentRunner` → onSuccess/onFailure。建议在实现 Phase 1 Task 3 (DagResolver) 时参考这个 callback 结构。

### 3. Session Lifecycle

**文件**: `internal/session/lifecycle.go`

Session 启动流程:
```
Resolve config → Ensure settings → Build command → Create tmux session
→ Set env → Apply theme → Wait for agent → Verify survived
```

**源码评价**: 最干净的 Claude Code session 启动抽象。每一步都有明确的 error handling 和 recovery。

**对 Flywheel**: 我们用 Agent SDK 而不是 tmux，但 lifecycle pattern 的 step decomposition 值得参考（特别是 "verify survived" — 确认 agent 真的启动成功了）。

### 4. Checkpoint/Recovery

**文件**: `internal/checkpoint/checkpoint.go`

```go
type Checkpoint struct {
    MoleculeID    string    // current work item
    CurrentStep   string    // step in progress
    ModifiedFiles []string  // files modified since last commit
    LastCommit    string    // SHA of last commit
    Branch        string    // current git branch
    HookedBead    string    // work item ID on agent's hook
}
```

Simple JSON file persistence, save on session boundaries, reload on restart.

**对 Flywheel**: 和我们的 `run-state.json` 设计目标一致。Gastown 的实现验证了 "simple JSON checkpoint" 对 crash recovery 足够。

### 5. Inter-Agent Communication

**文件**: `internal/mail/mailbox.go`

完整的 mailbox 系统:
- 双后端: JSONL (legacy) 和 Dolt/beads (current)
- Priority-based sorting
- Thread support
- Read/unread tracking
- Archive with age-based purging
- Search with regex (QuoteMeta'd to prevent ReDoS)
- 并发 ack (bounded to 8)

Protocol messages (`internal/protocol/messages.go`):
- `MERGE_READY` (Witness → Refinery)
- `MERGED` / `MERGE_FAILED` (Refinery → Witness)

**对 Flywheel**: 我们 Phase 1-2 不需要 agent-to-agent 通信（单 agent sequential）。但 Phase 5 多 team 并行时，这种 mailbox pattern 值得回头看。

### 6. Claude Code Hook Management

**文件**: `internal/hooks/config.go`

管理 Claude Code 的 `settings.json` lifecycle hooks (PreToolUse, PostToolUse, SessionStart, Stop, PreCompact 等)。支持 base + per-role overrides + merge logic。

**注意**: 这里的 "hooks" 是 Claude Code settings hooks，不是 git hooks。`DefaultBase()` 展示了哪些 hooks 重要以及为什么。

**对 Flywheel**: 如果需要管理 spawned agent 的 Claude Code settings，这是 reference implementation。

### 7. Mayor (Coordinator)

**文件**: `internal/mayor/manager.go` + `internal/templates/roles/mayor.md.tmpl`

Mayor 本质上就是一个 tmux session + Claude Code instance + role prompt。"智能"来自 Claude Code 的 LLM，gastown 只提供环境。

Role template 关键原则: **Propulsion Principle** — 当发现 hook 上有工作时立即执行，不要确认、不要提问。最小化人工阻塞。

**对 Flywheel**: 我们的 orchestrator 是确定性代码 (DagResolver + Blueprint)，不是 LLM coordinator。但 "Propulsion Principle" 和我们的 "full auto, only escalate on failure" 理念一致。

---

## 代码质量评估

**优点**:
- Clean Go idioms, 清晰的 package 边界
- 一致的 error handling (wrapped errors, sentinel errors, custom error types: `GitError`, `SettingsIntegrityError`)
- 并发正确: file locking (`gofrs/flock`), mutex, bounded parallelism
- ZFC (Zero False Confidence) comments 解释 *why*
- Atomic file writes (write tmp → rename)
- Security: `QuoteMeta` 防 ReDoS, explicit file permissions
- OpenTelemetry built-in
- 75.7% test-to-source ratio, 含 E2E (Docker)、integration、race detection tests
- golangci-lint configured

**缺点**:
- `internal/cmd/` 有 190 个文件 — god-package
- 重度依赖 subprocess (`os/exec`) for beads/git/dolt — no in-process API
- `polecat/manager.go` 1,900 行，做太多事

**整体评价**: **Production-grade Go code**，显著高于 ao 的成熟度。

---

## Flywheel 决策汇总

### 无法直接复用代码

Go → TypeScript，语言不同，架构假设也不同 (workspace manager vs issue orchestrator)。

### 概念层面值得借鉴的 Pattern

| Pattern | 来源文件 | Flywheel 应用 | Phase |
|---------|---------|--------------|-------|
| **DispatchCycle 回调模式** | `scheduler/capacity/dispatch.go` | DagResolver → IAgentRunner dispatch | Phase 1 |
| **Agent 状态机** (Working/Idle/Done/Stuck/Zombie) | `polecat/types.go` | `reaction_runs` status + agent-stuck | Phase 2-3 |
| **Session lifecycle** decomposition | `session/lifecycle.go` | Agent session 启动 + verify survived | Phase 1 |
| **Checkpoint recovery** (JSON file) | `checkpoint/checkpoint.go` | `run-state.json` crash recovery | Phase 1 |
| **Stuck vs Zombie 区分** | `polecat/manager.go` | agent-stuck detection (主动 vs 被动) | Phase 3 |
| **Propulsion Principle** | `templates/roles/mayor.md.tmpl` | "full auto, only escalate on failure" | 理念验证 |

### 不适用的

| 组件 | 原因 |
|------|------|
| Dolt (MySQL-compatible version-controlled DB) | Overkill, 我们用 SQLite + sqlite-vec |
| tmux session management | 我们用 Agent SDK |
| Beads (自建 issue tracker) | 我们用 Linear |
| Town/Rig/Polecat 命名体系 | 增加认知负担，无架构优势 |
| Mailbox inter-agent comms | Phase 1-2 不需要 (single agent sequential) |
| Refinery (merge queue) | 我们的 `approved-and-green` Phase 2 只 notify |

### 验证了我们的方向

- Multi-runtime (`IAgentRunner` model-agnostic) ✓
- Persistent work state (`run-state.json`) ✓
- Capacity-controlled dispatch (DagResolver) ✓
- Agent state tracking with terminal states ✓
- "Full auto, minimal human blocking" philosophy ✓
