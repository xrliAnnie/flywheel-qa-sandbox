# FLY-293 cmux 死 pane 不自动消失 — 探索

Issue: FLY-293 (https://linear.app/geoforge3d/issue/FLY-293/cmux-pane-不自动消失close-runner-后渲染层残留死-paneclose-触发-refresh-surfaces-清理)
日期: 2026-06-30
基于: 无

## 1. 现象（founder 视角）

`close_runner`（`close_runner` action / flywheel-terminal MCP 工具）关掉 runner 后，cmux
侧栏里对应的 workspace tab（死 pane）**不会自动消失** —— runner 实际已停，但视觉上残留，需要
Annie 手动关。她印象中以前会「过一会自动消失」，现在不会了 = 明确的回归。

纯 **cosmetic**（runner 确实已关，无正确性/安全影响），但残留 pin 越积越多，founder 需手动清，
正是她想保持干净的东西。

## 2. 实证：这些死 pin 到底是什么状态（只读查生产 cmux）

关键——先分清两种可能，因为修法完全不同：
- **A. 「关了但没重绘」**：workspace 已从 cmux 模型里 close 掉，只是 Electron 渲染层没刷新 →
  修法 = `refresh-surfaces` 重绘。
- **B. 「根本没被 prune」**：workspace 还在 cmux 的 workspace 列表里，从没被 close →
  修法 = 补一个能关它的清理路径。

只读查生产（`cmux --json list-workspaces` + `tmux list-sessions`，2026-06-30）：

| 指标 | 数量 |
|------|------|
| cmux workspace 总数 | 47 |
| 有活的 `cmux-<name>` linked session 的 | 18 |
| **orphaned 死 pin（在 workspace 列表里但无后台 session）** | **~29** |

死 pin 样本（**完整 title**，均为 `{issueId}-claude-{slug}` 形态 —— 见 §3.2 producer 契约）：
`FLY-637-claude-FLY-626-follow-up-deferred-normaliz`、`FLY-694-claude-hotfix-FLY-676-388-broke-codex-lead`、
`FLY-698-claude-enablement-PonyTail-Token-Monitorin`（甚至 `selected=True`）、
`FLY-697-claude-infra-Codex-TRACE-…`、`LEARN-143-claude-LEARN-141-30-45`、
`LEARN-144-claude-Research-1-lofi-YouTube`、`FLY-650-claude-provisioning-Linux-…`、`FLY-684-claude-…` …
逐个 spot-check：它们**既没有** `cmux-<title>` linked session，源 `runner-*` / `flywheel` 会话里**也没有**
同名活窗口。**全部匹配** managed-runner-title gate `^[A-Z][A-Z0-9]*-[0-9]+-claude(-|$)` → Q1 backlog 被覆盖。

→ **结论 = B（根本没被 prune）**。死 pin 仍实打实躺在 cmux workspace 列表里，不是渲染残留。
（这也修正了纯代码推导得出的「关了没重绘」猜测——生产真相是没关。）

## 3. 根因（代码 + git 实证）

### 3.1 谁负责关 cmux workspace pin

`close_runner`（`packages/teamlead/src/bridge/close-runner.ts`）本身**不**关 cmux workspace，它只：
1. `killCmuxLinkedSession(cmux-<name>)`（FLY-638 加的，先杀 linked session）
2. `killTmuxWindow`（杀源窗口）
3. `closeRunnerTerminalView`（关 macOS Terminal tab）

真正 close cmux workspace 的唯一函数是 watcher（`scripts/flywheel-cmux-sync.sh`）里的
`cleanup_workspace_for(agent_name)` → `workspace_refs_for` → `close_workspace_by_ref`
（`cmux close-workspace`，按 workspace **title** 解析，与 tmux 是否还在无关）。它被三处调用：

| 调用点 | 触发条件 | 依赖 |
|--------|----------|------|
| `process_pending_cleanups`（一次性事件路径，~30s） | `mark_for_cleanup` 记录的 `exited`/`unlinked` 事件 | tmux hook 事件必须命中 |
| `cleanup_stale_conservative`（周期兜底，5min） | 遍历活的 `cmux-*` linked session | **需要 linked session 还在** |
| `cleanup_stale_workspaces`（仅 `--once`） | 同上，遍历 `cmux-*` | **需要 linked session 还在** |

另一条关 workspace 的路径 `reconcile_existing_workspaces`：遍历**源** agent 窗口
（`get_tmux_agent_windows`，flywheel/runner-*），**需要源窗口还在**。

### 3.2 回归点：FLY-638

- **FLY-638 之前**：`close_runner` 只杀源窗口 + Terminal tab，**不碰 linked session**。所以
  `cmux-<name>` linked session 残留（带一个 dead 源窗口）。watcher 的 `cleanup_stale_conservative`
  遍历 `cmux-*` session 时**能看到它**，靠它当锚点，`is_pane_alive` 判死 → 5 分钟内
  `cleanup_workspace_for` → 关掉 workspace。**周期兜底可靠地清理了 pin。**
- **FLY-638 之后**（commit `a1752eee`, PR #378）：`killCmuxLinkedSession` 在 close 时把
  `cmux-<name>` session 一并杀了。现在关完 runner，**linked session + 源窗口同时没了**。这个
  orphan workspace pin：
  - `cleanup_stale_conservative`（遍历 `cmux-*`）看不到（linked session 没了）❌
  - `reconcile_existing_workspaces`（遍历源窗口）看不到（源窗口没了）❌
  - `reap_ghost_workspaces` 只清 title 为 null/空/`~` 的（死 pin title 是真窗口名）❌
  - `dedup_workspaces_by_title` 只清同名重复 ❌
  → **pin 清理只剩一条脆弱的一次性 `window-unlinked` 事件**（`killTmuxWindow` = `kill-window`
    → 全局 `window-unlinked[500]` hook → `mark_for_cleanup` → 30s 后 `process_pending_cleanups`）。
    watcher 重启 / event-file 竞态 / hook 尚未注册 / tmux server 重启 …任一让事件漏掉，pin 就
    **永久残留**。天长日久累积到 ~29 个。

这条时间线和「以前 work、最近才坏」+「越积越多」完全吻合（FLY-638 是近期改动）。

### 3.3 与 Lead 猜测的 FLY-623 / 与 FLY-720 的关系

- Lead 猜的 **FLY-623 dead-pin-reads-as-alive** 在 TS Bridge 侧（`isTmuxWindowAlive` 用窗口存在判活），
  影响的是 **crash 路径**（FSM 卡 `running`、heartbeat 一直 re-adopt 死 pin）。shell watcher 的
  `is_pane_alive` 用 `#{pane_dead}`、判断是对的。所以 FLY-623 是 crash 变体、与本 issue 这批
  **clean-close** pin 互补，但不是主因。
- **FLY-720**（crash-runner-liveness-reaper，in-progress/已 QA）在 crash 时也调
  `killCmuxLinkedSession + killTmuxWindow`，同样**不**关 cmux workspace pin。所以 720 跑完后仍会
  留下 orphan pin —— 本 issue 的 reaper 正好把 clean-close **和** crash 两条路径的残留 pin 都收掉。
  两者互补：720 拆 tmux 侧，293 收 cmux pin。

## 4. 备选方案

### 选项 A（推荐）：watcher 加 anchor-independent 的 orphan-pin reaper
在 `flywheel-cmux-sync.sh` 里加一个新清理函数，和 `reap_ghost_workspaces` / `dedup_workspaces_by_title`
同层，跑在 `sync_additive`（周期）+ `sync_once`（手动）。判定一个 workspace 是 orphan 死 pin：
- title 非空（空/`~` 归 ghost reaper），AND
- 没有同名活 agent 窗口（`get_tmux_agent_windows` field 3），AND
- 没有 `cmux-<title>` linked session，AND
- 已连续 orphan 满 grace（复用 5min 模式，用独立 state 文件防创建竞态），
- JSON 不可用 → fail-closed 跳过。

命中 → `close_workspace_by_ref` → 补一次 `cmux refresh-surfaces` 重绘。

- **优点**：结构上不可能误关 Lead / 活 runner（它们永远有活源窗口 + 活 linked session）；对**漏事件**
  免疫（不依赖一次性 hook）；单一 owner（watcher 有 cmux socket 权限）；byte-compat env 开关兜底；
  同时覆盖 clean-close + crash 两条路径；现有 ~29 个死 pin 会在 deploy+重启后首轮被清掉。
- **缺点**：多一次周期 JSON 扫描（已有 `sync_additive` 里就在扫 JSON，增量极小）。

### 选项 B：给 `close_runner`（Bridge/TS）加 cmux workspace close
close 时直接调 cmux CLI 关 workspace。
- **缺点**：Bridge 不在 cmux 内跑、未必有 cmux socket 权限；把 cmux 编排逻辑泄进 Bridge，破坏
  「watcher 是 cmux 单一 owner」的分层；且**只覆盖事件到达的那次**，漏事件/历史 pin 依旧无救。
  不推荐单用（可作为 A 的可选补充，但会引入分层与权限风险）。

### 选项 C：只加 `refresh-surfaces`（纯代码推导得出的方案）
- 已被 §2 实证否定：死 pin 是没被 close、不是没重绘。单加 refresh-surfaces 不解决问题。
  （refresh-surfaces 仍作为 A 关完 pin 后的重绘补刀保留。）

## 5. 推荐

**选项 A**。它是唯一对「漏事件 + 历史累积」都免疫、且结构上安全（绝不误关活 Lead/runner）的修法，
落在正确的分层（watcher = cmux 单一 owner），并天然把现存 ~29 个死 pin 在下次 watcher 起来时清掉。

## 6. 待确认（已发 brainstorm gate 给 Lead）

1. 现存 ~29 个死 pin 的立即清理：靠 deploy+重启 watcher 首轮自动清（我不手动动生产 cmux socket）。
2. 修复归属：只在 watcher 加 reaper，`close_runner` 保持现状。
