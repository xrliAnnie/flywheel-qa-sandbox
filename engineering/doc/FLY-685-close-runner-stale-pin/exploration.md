# FLY-685 close_runner 留 stale cmux tab — 探索

Issue: FLY-685 (https://linear.app/geoforge3d/issue/FLY-685/bug-close-runner-不自动从-cmux-移除-runner-tab-关了的-runner-还留-stale-tab)
日期: 2026-07-02
基于: 无

---

## Problem

Annie 观察 (2026-06-29): runner 跑完 + `close_runner` 关掉后，它的 tmux 窗口确实关了，但 **cmux 左边 tab 列表里还留着一个指向已关窗口的 stale tab**，founder 得手动清。高频小烦恼，非阻塞但影响体验。跟 task #64 (`close_runner` leaves stale cmux pin) 同一件事。

## 关键概念 — 三种「东西」，别混

| 名字 | 是什么 | 谁能删 |
|------|--------|--------|
| tmux **window** | runner 进程跑的窗口 (base session `runner-*` / `flywheel` 里的一个 window) | Bridge (`kill-window`) |
| cmux **linked session** `cmux-<window_name>` | cmux-sync 为每个 runner window 建的独立 tmux linked session，让 founder 能把它当一个 cmux tab 看 | Bridge (`kill-session`, FLY-638) |
| cmux **workspace pin** (= 左边那个 tab) | cmux app 自己的 workspace 对象 | **只有 cmux-sync watcher (有 cmux socket) 能关** |

**issue 说的 "stale tab" = cmux workspace pin。**

## 代码审计 — 现状

### close_runner (`packages/teamlead/src/bridge/close-runner.ts`)
跑在 Bridge (Node)，**没有 cmux socket**。成功路径做两件事：
1. `killCmuxLinkedSession(target.tmuxWindow)` — 杀 `cmux-<window_name>` linked session (FLY-638，line 282)
2. `killTmuxWindow(target.tmuxWindow)` — 杀 base session 里那个 window (line 287)

**它关不了 cmux workspace pin** —— 没 socket，也从不调 cmux CLI。pin 的清理 100% 甩给 watcher。

### watcher (`scripts/flywheel-cmux-sync.sh`) 关 pin 的四条路径

1. **Event-driven (主路径)**: tmux hook (`pane-died` / `window-unlinked`) 写 `$EVENT_FILE` → `drain_events` (每 15s) → `mark_for_cleanup` → `$CLEANUP_PENDING` → `process_pending_cleanups` (等 `CLEANUP_DELAY_SECONDS`=30s) → `cleanup_workspace_for` → `cmux close-workspace`。代码自己注释叫它 **"fragile one-shot"** (line 603)。事件掉一次就没了。
2. **`cleanup_stale_conservative`**: 遍历**现存**的 `cmux-*` linked session，源 pane 死 ≥300s → 清。**anchor = linked session 还在**。
3. **`reconcile_existing_workspaces`**: 遍历**现存**的源 window。**anchor = 源 window 还在**。
4. **FLY-293 orphan pin reaper (`reap_orphan_workspace_pins`)**: anchor-independent 兜底。关掉「managed runner title + 没 live agent window + 没 `cmux-<title>` linked session」的 pin。带 **grace = `CONSERVATIVE_CLEANUP_SECONDS` = 300s (5 分钟)**，跑在 60s additive scan。

### 为什么 close_runner 的 pin 会留下 (核心)

close_runner **先杀 linked session、再杀 window** —— 正好把路径 2、3 依赖的两个 anchor 都毁了：

- 路径 2 (conservative): close_runner 已经杀了 `cmux-<name>` linked session → 没得遍历 → **永远抓不到**。
- 路径 3 (reconcile): close_runner 已经杀了源 window → 没得遍历 → **永远抓不到**。
- 路径 1 (event-driven): kill-window 会触发 `window-unlinked` hook，理论上能清；但它是 fragile one-shot —— watcher 那 tick 没在 drain / cmux JSON 那刻不可用 (cmux flap) / 事件被丢，pin 就留下了。`process_pending_cleanups` 里若 `cleanup_workspace_for` 因 JSON 不可用跳过了 cmux close，pending 条目还是被消费掉 → 永久 orphan。
- 路径 4 (FLY-293 reaper): **唯一确定能兜到的**，但要等 5 分钟 grace + 60s scan。

**结论**：close_runner 没有一条「权威、即时、定向」的信号去关那个具体的 pin。它靠 best-effort 事件 (会丢)，唯一确定兜底要 5 分钟。→ 关掉的 tab 最多留 ~5 分钟，founder 等不及就手动清。

## issue 要求的修复方向

- close_runner (成功终结 runner 后) 应**同步移除 cmux tab/pin** —— 不只关窗口。
- 找 pin 的注册机制 → close 时反注册。
- 边界: runner 异常死 (非 close_runner 路径) 也应被某个 reaper 清 —— **这条 FLY-293 orphan reaper 已经在做** (带 grace)。所以 FLY-685 的活是把 **close_runner 这条路径** 变即时。

## 相关历史

- **FLY-293** (`engineering/doc/FLY-293-cmux-stale-pin-reaper`): 建了 anchor-independent orphan reaper (路径 4)。它是异常死的兜底，但对 close_runner 这条「已知刚杀掉」的路径来说 5 分钟太慢。
- **FLY-638**: close_runner 加了 `killCmuxLinkedSession`。杀 linked session 反而毁了路径 2 的 anchor（副作用，非本 issue 引入）。
- **FLY-758** (`cmux-win0-scaffold-pin`): 另一类 cmux pin 问题，参考其 test 手法。
