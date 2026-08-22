# FLY-1961 双 vendor 工作区信任 — 调研
Issue: FLY-1961 (https://linear.app/geoforge3d/issue/FLY-1961/spawn信任-双-vendor-信任预置新-worktree-的-codex-体出生即卡信任目录提示生产-22-实证)
日期: 2026-08-21
基于: exploration.md

## 1. 生产现象与本次现场快照

Issue 给出的生产样本是 Codex implement 1756、1728 两个新 worktree 2/2 静默约 15 分钟，直到 Lead 人工 Enter；529 `--real` 的三轮房内 Claude/Codex 也各撞一轮。

本执行体在进入实现前做了只读、脱敏探针（只打印目标 workspace 的信任值，不打印 config 其他内容）：

```text
workspace=/Users/xiaorongli/Dev/flywheel-FLY-1961
claude_hasTrustDialogAccepted=None
codex_home_scope=/Users/xiaorongli/.flywheel/codex-homes/c7f7f428-fa43-4fb3-864b-0f505b820e28
codex_trust_level=None
```

这说明“进程现在能跑”不能证明启动前信任已预置；人工 Enter/交互继续只解除当前启动阻塞，没有给 execution-scoped Codex home 留下可复用的 `trusted` 证据。

## 2. 根因追踪

### 2.1 worktree 到 adapter 的调用链

`packages/edge-worker/src/Blueprint.ts:1289-1480`：

1. `runnerBackend` 是实际 executor discriminant；`codex-tmux` 与 `claude-tmux` 已在这里明确区分。
2. `WorktreeManager.create()`/takeover/rebuild 先产出 `worktreeInfo.worktreePath`，随后 `cwd` 指向它。
3. `packages/edge-worker/src/Blueprint.ts:2820-2995` 才把同一 `cwd` 交给 `adapter.execute()`。

因此可靠时序点是“worktree 已存在、CLI 尚未启动”的 adapter boundary。`WorktreeManager` 自身只有 repo/path/issue，没有 backend 或 execution home。

### 2.2 Claude 路径

`scripts/inject-linear-issue.sh:133-265` 已有一套 Claude-only QA workaround：按未来 worktree path canonicalize parent，在 mkdir mutex 中原子 merge

```json
{
  "projects": {
    "/absolute/worktree": { "hasTrustDialogAccepted": true }
  }
}
```

它对 missing/empty 初始化，对 invalid JSON fail loud，并在 POST `/api/runs/start` 前完成。`scripts/test-teardown.sh:581-668` 也只清这份 Claude trust。

但 live production adapter 路径没有调用者。`packages/claude-runner/src/TrustPromptHandler.ts` 只有独立单测和 export，仓库 grep 没有生产接线。`doc/engineer/research/new/FLY-228-qa-findings-E-and-I.md` 也已把这点记录为 latent gap：生产只是长期借用了机器已有 global state。

### 2.3 Codex 路径

`packages/claude-runner/src/CodexTmuxAdapter.ts:431-470` 在 `execute()` 内先 realpath worktree，然后调用 `provisionCodexHome()` 创建 execution-scoped home。`packages/claude-runner/src/codex-home.ts:784-918` 从 host source `~/.codex/config.toml` 复制 base，再只处理 GH token、skills 与 notify managed blocks；它没有接收 workspace，也没有生成 `[projects]` trust。

所以只改 host `~/.codex/config.toml` 仍不是完整 production 修复：每个 runner 的权威配置是 `$CODEX_HOME/config.toml`，且该 home 可能在 host config 改写前后以不同快照生成。

### 2.4 529 generalized real 路径

`scripts/qa-529-generalized-e2e.mjs:650-690` 直接 POST `/api/runs/start`。stub 模式由 `test-deploy.sh` 安装 fake binaries；`--real` 则走真实 Blueprint/adapter。这个 driver 当前没有任何 trust setup。legacy `inject-linear-issue.sh` 的 Claude-only prewrite 不会帮助 generalized driver，也不会帮助 Codex。

### 2.5 已有可复用模式

- TOML 语义判断：`packages/teamlead/scripts/codex-lead-tui-home.sh:360-402` 已用 `tomllib` 判 `trusted|absent|empty|drift`；absent 才 append，existing non-trusted/empty fail loud，避免 duplicate table。
- TOML 保真 merge：`renderCodexHomeConfig()`（FLY-1604）以 parsed TOML 为语义权威，以受管 block 做 surgical append，并验证新输出未改无关配置。
- Claude writer 并发协议：`flywheel-claude-profile`、inject 与 teardown 都约定 `${CLAUDE_JSON}.lock` mkdir mutex；新 writer 必须加入同一个临界区。
- 新 worktree path：`resolveWorktreeKey()` 在 DAG `shareParentBranch=true` 时固定 parent main key；529 generalized 三阶段共享 `${hostRepo}-${issue}`，不是 role suffix。

## 3. 单一根因假设与最小验证

**假设**：目录信任阻塞的唯一缺口是 spawn 前没有把“刚建好的 canonical worktree path”写入将被该 backend 实际读取的信任库；Claude QA workaround 只覆盖一个入口，Codex per-runner config 完全未覆盖。

支持证据：

1. issue 的 2/2 与 529 双 vendor 现象都只发生在 fresh worktree。
2. 当前 execution-scoped Codex config 对当前 workspace 的 `trust_level` 实测为 `None`。
3. `provisionCodexHome()` 的输入和 renderer options 中不存在 workspace 字段。
4. 仓库已有 Codex Lead 的相同 `[projects] trust_level` 预置会消除 boot trust menu；不是未验证的新格式。

最小验证将由 TDD 完成：先让新测试证明 renderer/adapter 对 fresh path 没有 trust（RED），再只增加 workspace trust input 与 pre-launch call（GREEN）。不先改 prompt watcher、WorktreeManager 或 daemon lifecycle。

## 4. 失败语义与安全要求

| 边界 | 必须行为 |
|---|---|
| Claude JSON parse/schema drift | 原文件 byte-unchanged，spawn fail loud |
| Claude 并发 writer | 同锁串行，两条 workspace key 都保留 |
| Codex base TOML parse/schema drift | 不生成半个 per-runner home config；credential scrub 仍执行 |
| Codex exact path already trusted | 幂等，不重复 table |
| Codex exact path existing untrusted/empty | fail loud；不写 invalid duplicate table |
| 529 helper | POST 前双写；任一侧失败则不启动 run |
| teardown | 只删带 helper marker 且位于 slot prefix 的 Codex entry；不删用户原有 trusted entry |

## 5. 需求—证据映射

| 明确需求 | 实现后权威证据 |
|---|---|
| 新 Codex spawn 零提示 | Codex adapter test + execution `$CODEX_HOME/config.toml` parsed target=`trusted`; QA 后续真 spawn |
| Claude 不回归 | Claude writer/adapter tests +现有 claude-runner suite |
| per-runner CODEX_HOME | `provisionCodexHome({trustedProjectPath})` 落盘单测，不以 global config 代替 |
| 529 `--real` 不撞提示 | generalized driver 在真实 POST 前 dual helper 契约 +后续 QA 真房 |
| 治具无持久污染 | managed-marker prune shell test + teardown 接线 |

## 6. 调研结论

根因已追到两个缺失的写入点，而不是 TUI watcher 或 worktree creation 本身。实现应保持 `WorktreeManager` vendor-neutral，把 workspace pretrust 作为 adapter execution 明示能力：Claude 写共享 JSON，Codex 写本 runner home；529 driver 另外做双写的 setup/cleanup，确保真房在 CLI spawn 前就具备两侧状态。
