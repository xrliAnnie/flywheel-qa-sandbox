# Exploration: cmux workspace attach 自愈 — FLY-169

**Issue**: FLY-169 (cmux workspace attach self-heal — workspaces show bare zsh when tmux attach fails at create)
**Date**: 2026-05-26
**Status**: Draft

---

## 1. 问题

cmux workspace 间歇性显示**裸 zsh 登录 shell**（`xiaorongli@MacBook-Pro-7 ~ %`），而不是 `tmux attach` 后的 Lead/Runner 内容。Annie 反复看不到 Peter/Oliver/Simba。

2026-05-26 确认：三个 Lead 的 cmux view session（`cmux-geoforge3d-{product,ops,cos}-lead`）**0 个 client attached**，尽管 tmux session 存在、Lead Claude 跑在 window 1/2/3。cmux workspace 的 surface 启动了一个默认 shell，没有 attach 到 tmux。

team-lead 的手动 workaround（`cmux send` attach + `send-key Enter` + `select-window` + `refresh-surfaces`）每次重启都复发，不持久。

## 2. 根因（已审计确认）

`scripts/flywheel-cmux-sync.sh:create_workspace_for_window`（line ~593）：

```bash
cmux_call new-workspace --command "tmux attach -t '=${view_session}'"
```

`new-workspace --command` 确实存在（已验证 `cmux --help`），但 **attach 在 workspace 创建时可能失败**（race：tmux session 尚未 ready；或 `=` 前缀引号问题）。attach 失败时 cmux fallback 到裸登录 shell——**没有重试、没有校验**。workspace 永久卡在裸 zsh，直到手动 re-attach。

FLY-129（cmux 集成重写）修了 watcher / ghost / refresh 三层，但**没覆盖 attach-on-create 这条路径**。本 issue 是 FLY-129 的续集。

## 3. Codebase 审计

`flywheel-cmux-sync.sh`（1342 行）核心结构：

```
watch_loop()  每 15s tick
  ├─ cmux_health_check_or_die   健康门禁（rc=1 socket 缺失 / rc=3 unhealthy → skip 本 tick）
  ├─ drain_events               处理 tmux session-hook 事件
  ├─ process_pending_cleanups
  └─ tick % 4 == 0 (≈60s) → sync_additive()
                               ├─ register_hooks_on_new_sessions
                               ├─ reconcile_existing_workspaces  关掉 linked-session 已死的破 workspace（让 create 重建）
                               ├─ refresh_linked_sessions        按 name 重选 window（修 FLY-98 stale 指针）
                               ├─ create_workspace_for_window    建缺失的 workspace ← BUG 在这里
                               ├─ reap_ghost_workspaces
                               ├─ dedup_workspaces_by_title
                               └─ cleanup_stale_conservative

sync_additive_bootstrap()  --watch 启动时跑一次（additive-only，不做激进清理）
```

关键 helper：
- `cmux_call <args>` — 包 `cmux --socket`，stderr → log，返回 cmux 退出码，stdout passthrough。
- `get_tmux_agent_windows` — 返回 `session|window_id|window_name`，扫 `flywheel`（Leads）+ `runner-*`（Runners），过滤掉 `zsh`/`bash` 默认窗口。
- `get_cmux_workspaces_json` — `cmux --json list-workspaces`，fail-closed（rc≠0 时空 stdout，调用方禁止把空当 "无 workspace"）。
- view session 命名：`VIEW_PREFIX="cmux-"` + window_name，即 `cmux-geoforge3d-product-lead`。
- workspace title == window_name（如 `geoforge3d-product-lead`）。

**重点**：`reconcile_existing_workspaces` 已经处理了"linked session 死了"的情况（关掉重建），`refresh_linked_sessions` 已处理"window 指针 stale"。**唯独缺一层**：linked session 活着、workspace 存在，但 **cmux surface 没 attach 上去**（裸 zsh）。这正是 FLY-169。

## 4. cmux CLI 能力核实（live 实测）

issue 假设 `cmux list-clients` 存在——**实际不存在**。真实可用 primitive：

| 命令 | 用途 |
|------|------|
| `read-screen --workspace <ref>` | 读 surface 当前屏幕文本（含 tmux 状态栏） |
| `list-pane-surfaces --workspace <ref>` | surface 列表，含 `title`（= 创建时的 `--command` 文本） |
| `surface-health [--workspace <ref>]` | surface 类型 / in_window |
| `send --workspace <ref> <text>` | 往 surface 输入文本 |
| `send-key --workspace <ref> <key>` | 往 surface 发按键（如 Enter） |
| `refresh-surfaces` | 刷新 surface 渲染 |
| `--json list-workspaces` | workspace 列表（title/ref/index/selected） |

### 检测信号对比

**信号 A — tmux-native client count（推荐）**：
```bash
tmux list-clients -t '=cmux-geoforge3d-product-lead' | wc -l
```
attached → ≥1；裸 zsh fallback → 0。实测三个 Lead 都返回 1。这是 tmux 原生命令，不依赖 cmux socket，不需要屏幕抓取，**最 robust**。issue 里"0 clients attached"的确认本身就是用这个信号得到的。

**信号 B — read-screen 抓 tmux 状态栏**：attach 成功的 surface，`read-screen` 末尾必有 tmux 状态栏行：
```
[cmux-geof0:zsh- 1:geoforge3d-product-lead* 2:geoforge3d-cos-lead  ...] 17:16 26-May-26
```
裸 zsh 没有这行。但状态栏格式可被 tmux 配置改写 → 抓取脆弱，**仅作辅助验证**。

**信号 C — surface title = intent**：`list-pane-surfaces` 的 surface `title` == `tmux attach -t '=cmux-geoforge3d-product-lead'`，反映**创建意图**（即"这个 workspace 本就该 attach"）。注意：title 是创建时的 command，attach 失败 fallback 后 title 不变 → **只能表意图，不能表当前状态**。

### 两信号门控模型（核心设计）

```
意图（信号 C）: surface.title == "tmux attach -t '=<view_session>'"   ← 这个 workspace 本该 attach
状态（信号 A）: tmux list-clients -t '=<view_session>' 数量 == 0       ← 当前没 attach 上

意图 AND 未attach  →  自愈（send attach + Enter + select-window + refresh）
```

这样**只重连"本该 attach 但掉了"的 workspace**，绝不劫持用户故意开的裸 shell——避免误杀（false positive 会破坏真 session，是本 issue 最大风险）。

**关键安全约束**：`cmux send` 文本**只在 0 client 时发**。若已 attached 还 send "tmux attach…"，文本会打进 Lead 的 Claude Code 输入框 → 灾难。所以 send 必须严格门控在"检测到未 attach"之后。

## 5. 候选方案

### 方案 1 — create 时 verify-and-retry
`new-workspace --command` 后立即校验是否 attach（list-clients / read-screen），裸 zsh 则 send attach + Enter 重试 N 次。
- ✅ 在源头修
- ❌ create 后立即检查有 timing 风险（surface 可能还没渲染完）；只覆盖 create 路径，重启/reboot 后已存在的破 workspace 不管

### 方案 2 — reconcile 每 tick 自愈（**首选**）
每个 additive tick（60s）扫所有受管 workspace，检测"意图=attach 但 0 client"的，自动 send attach + Enter + select-window + refresh-surfaces。
- ✅ **自愈**：无论 attach 在 create 时成不成，下个 tick 都会修
- ✅ 覆盖所有触发场景（create / cmux 重启 / Lead 重启 / reboot）
- ✅ 复用现有 watcher 节奏，无新进程
- ❌ 最坏 60s 延迟（可接受；裸 zsh 是间歇问题不是常态）

### 方案 3 — 修 create race
`new-workspace` 前 poll `tmux has-session -t '=<view_session>'` 确认 session ready。
- ✅ 减少 race 发生率
- ❌ 不能根治（quoting / 渲染时序等其它 fallback 原因仍在）

**初始倾向**：方案 2（自愈）+ 方案 3。

**Annie 最终拍板（2026-05-27，product 硬约束）**：方案 2 的"每 60s tick 扫所有 workspace"被**否决** — Annie 机器持续 crash（watchman load spike / reboot），不接受任何周期性 polling 负载。改为 **event-driven**：
- **Verify-at-create + retry**（方案 1 的精神）— attach 最常失败点，create 时校验一次 + 有界 retry。
- **Sweep-on-event** — 只在 `register`（Lead/Runner restart 重建 session）/ `create`（已存在 workspace）/ watcher bootstrap（cmux restart）事件触发一次性 sweep，**不进周期路径**。
- 方案 3（create 前门禁）保留降噪。
- 两信号门控（INTENT + STATE）+ 范围 = 全部（lead+runner+test-slot）保留。

详见 plan v1.28.3。**idle 零自愈负载** 是硬指标。

## 6. 待与 Codex 讨论的设计点

1. **检测信号**：tmux `list-clients`（信号 A，tmux-native）vs `read-screen` 抓状态栏（信号 B）。倾向 A，B 仅辅助。Codex 是否认同 list-clients 对 linked session 的语义可靠？
2. **意图门控**：是否用 `list-pane-surfaces` 的 surface title == `tmux attach…` 作为"只自愈本该 attach 的"门禁？还是只要 workspace title ∈ 受管 window name 集合就自愈？
3. **send 安全**：确认"只在 0 client 时 send"是否足够防止打进 Claude 输入框。是否需要额外校验（send 前再 read-screen 确认是 shell prompt）？
4. **自愈落点**：新建 `self_heal_unattached_workspaces()`，在 `sync_additive` + `sync_additive_bootstrap` 的 `refresh_linked_sessions` 之后调用？
5. **节奏**：60s additive tick（够）vs 15s 每 tick（过激 + send 风险）。
6. **重试 / 日志**：每 tick 即天然重试。是否加 per-workspace 尝试计数避免无限刷屏？transition-only 日志（attach 成功/失败转换时各打一行）。
7. **窗口选择**：自愈时除 attach 外，是否也 `tmux select-window -t '=<view_session>:=<window_name>'` 保证 active window 指向 Lead/Runner 窗口（非 window 0 zsh）——acceptance 明确要求。

## 7. 验收对齐

issue acceptance：
- [x] 设计目标：cmux 重启 / Lead 重启 / reboot 后，workspace 在一个 reconcile cycle 内自动 attach（无需手动 `cmux send`）→ 方案 2
- [x] 裸 zsh 的 workspace 被检测 + 自动 re-attach → 两信号门控
- [x] active window 指向 Lead/Runner 窗口（非 window 0 zsh）→ 自愈含 select-window
- [ ] 回归/spike 证明自愈能恢复一个**故意 detach 的 workspace** → QA spike：人为 `tmux detach` 一个 view session 的 client / kill 掉 attach，观察下个 tick 自愈

## 8. 测试策略

- **单元测试**：检测/意图判定逻辑（解析 list-clients count、list-pane-surfaces title）抽成可测函数；mock cmux/tmux 输出。CI 无 cmux/GUI，纯解析逻辑可测。
- **Spike（手动 E2E）**：本机 cmux 内，人为制造裸 zsh（kill 掉某 view session 的 attach client，或新建 workspace 让 attach 故意失败），跑 watcher，观察 ≤1 个 additive cycle 内自愈、active window 正确、Annie 能看到 Lead 内容。
- **误杀防护验证**：开一个故意的裸 shell workspace（surface title 不是 `tmux attach…`），确认自愈**不碰它**。
