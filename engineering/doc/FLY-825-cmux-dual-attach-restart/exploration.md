# FLY-825 cmux 重启后同一 lead session 冒出两个 attach 视图 — 探索

Issue: FLY-825 (https://linear.app/geoforge3d/issue/FLY-825/infracmux-重启后同一-lead-session-冒出两个-attach-视图重复-tab-命令当-tab-名-heal-send)
日期: 2026-07-03
基于: 无（首个文档，纯代码审计 + 生产日志取证）

## 背景

Annie 在今天（2026-07-03）一次 fleet restart 之后观察到：Mufasa（growth-mufasa-lead）
和 Sub（sub-sub-lead）的 cmux 侧栏各自冒出了**两个 tab**，都挂在同一个 lead tmux
session 上，其中一个的名字显示成原始 attach 命令
`env -u TMUX tmux attach -t '=cmux-…'`（而不是正常的 `<project>-<lead>` 标题）。

Issue 里 Cass + Tadashi 给出的初步假设是"`heal_send_attach` 自愈路径与重启的正常
attach 撞车"。本次探索的目标是：**不满足于假设，直接从当前生产环境的日志 + 实时进程状态
取证**，把根因钉死到具体代码路径，再决定修哪里。

## 关键发现（按取证顺序）

### 发现 1：重启的真实机制（`packages/teamlead/scripts/claude-lead.sh`）

每次 Lead 重启（不管是 launchd `kickstart -k` 还是别的触发方式），`_launch_claude()`
函数会：

```bash
tmux kill-window -t "=flywheel:=${window_name}" 2>/dev/null || true   # 杀旧窗口
sleep 0.5
reap_orphan_adapters || true
...
LEAD_WINDOW_ID=$(tmux new-window -d -P -F '#{window_id}' -t =flywheel ... -n "$window_name" ...)  # 建新窗口，同名，新 window_id
```

即：**同名、新 ID** 的窗口重建，中间有约 0.5s 的窗口不存在的间隙。这是 issue 里说的
"重启 attach" 的字面来源——但它本身只是杀窗口再建窗口，不直接创建 cmux tab。

### 发现 2：cmux tab（workspace）只有一条创建路径

全仓搜索 `cmux new-workspace` / `cmux_call new-workspace`，唯一调用点是
`scripts/flywheel-cmux-sync.sh` 的 `create_workspace_for_window()`。也就是说：**要冒出
两个 tab，`create_workspace_for_window` 必须被调用两次**，而且两次调用时各自的
"这个 workspace 是否已存在"判断（按 cmux workspace 的 `title` 字段精确匹配 window
name）都必须判定为"不存在"。

### 发现 3：`create_workspace_for_window` 有两个独立调用点，且 watch_loop 内**同一个 tick
可以两个都跑**

```
watch_loop():
  每 15s tick:
    drain_events()          # 消费 tmux hook 事件（after-new-window → "create" 事件）
      → 若 workspace_exists_for(wname) 判"不存在" → create_workspace_for_window(...)
      → 若判"存在"                              → self_heal_one_workspace(wname)（仅自愈，不建新 tab）
    process_pending_cleanups()
    process_close_requests()
    if tick % 4 == 0:       # 每 60s（即每 4 个 tick）
      sync_additive()
        → reconcile_existing_workspaces()   # 若 linked session 已死 → 关闭该 workspace
        → refresh_linked_sessions()
        → 对每个当前 tmux 窗口，若 workspace_exists_for(wname) 判"不存在" → create_workspace_for_window(...)
        → reap_ghost_workspaces() + dedup_workspaces_by_title()
```

`drain_events()` 和 `sync_additive()` 在**同一个进程、同一次 tick 内顺序执行**——没有
真正的多线程竞态——但它们各自独立地对同一个 `wname` 做"是否存在"判断，**中间没有互相
感知**。当某个 tick 恰好同时满足"事件队列里有这个窗口的 create 事件"和"tick % 4 == 0"
时，两条路径会**先后**、**各自认为对方还没建**，都调用一次
`create_workspace_for_window`。

`create_workspace_for_window` 内部：
1. 若 linked session（`cmux-<wname>`）不存在才新建——**第二次调用会发现它已存在**（第一
   次调用刚建的），于是跳过这一步，直接复用。
2. 无条件执行 `cmux_call new-workspace --command "env -u TMUX tmux attach -t '=${view_session}'"`
   ——**这一步两次调用都会做**，各自建一个新 cmux tab，各自的 attach 命令各自 spawn 一个
   新 tmux client，都挂到**同一个**已存在的 linked session 上。
3. 建完之后靠"建前/建后 workspace ref 集合做差集"来找到刚建的 ref 并 rename 成
   `wname`。当两次调用的"建前/建后"快照发生交叠（第二次调用的"建前"快照可能已经包含
   第一次调用刚建的、还没 rename 完的那个 ref），差集逻辑至少有一次会算错/找不到新
   ref，rename 就不会发生——**这正是"其中一个 tab 名字是原始 attach 命令"的来源**（cmux
   对未 rename 的 workspace 默认用创建时的 `--command` 当标题）。

### 发现 4：生产日志直接抓到了这个时序（今天的 fleet restart）

`/private/tmp/flywheel-cmux-watcher.log`（当前唯一运行中 watcher pid=64108，
`launchctl print` 确认它是唯一持锁进程）里，今天 14:22–14:31 这段 fleet restart
窗口，`growth-mufasa-lead` 精确复现：

```
[cmux-sync 14:25:40] Creating workspace for: growth-mufasa-lead (@1210) from session flywheel
[cmux-sync 14:25:41] Creating workspace for: growth-mufasa-lead (@1210) from session flywheel
```

**同一个 window_id `@1210`，两条创建日志，相隔 1 秒**——这与"同一 tick 内 drain_events
先建、sync_additive 紧接着又建一次"完全吻合（若是两个不同窗口/两次真实重启，
window_id 必然不同；若是 60s 周期性重复，间隔应该接近 60s 而不是 1s）。同一时间窗口内，
`sub-sub-lead`、`flywheel-flywheel-cos-lead`、多个 Runner 窗口（FLY-787/FLY-803/
FLY-806/FLY-811 等）也全部出现了同样"同一 @id、相隔 1 秒"的双重 `Creating workspace
for` 日志——**这是 fleet restart 时段内的系统性双建，不是某个 lead 特有的偶发**。

大部分重复 tab 之后被 `dedup_workspaces_by_title`（按标题去重，"newest wins"）自动收敛
掉了（日志里能看到 `[audit] close workspace=... reason=dedup-newest-wins`）——但
`dedup_workspaces_by_title` 按**标题**匹配，若两个重复 tab 中有一个 rename 失败（标题
还是原始 attach 命令），它和"正常命名"的那个标题不相等，去重逻辑就抓不到，于是**残留
成 Annie 看到的两个 tab**。这解释了为什么只有 growth-mufasa-lead / sub-sub-lead
这两个卡住了，而其它窗口大多被自动清理。

### 发现 5（相邻但独立的问题）：孤儿 watcher 进程

取证过程中顺带发现：当前机器上有**两个** `flywheel-cmux-sync --watch` 进程活着：

```
64108  ppid=1  started 00:01  ← launchd 已不再追踪它（launchctl list 只认 57958）；lock 文件的 owner 仍是它
57958  ppid=1  started 14:31:48 ← launchctl list 里 com.flywheel.cmux-watcher 当前追踪的 PID
```

`acquire_watcher_lock()` 的 supervised 分支设计是对的：57958 发现 64108 还活着，正确地
一直 `sleep 15; continue` 卡在"等待接管"循环里（日志里从 14:31 到现在每 15s 一条
"waiting 15s to take over"，从未真正跑过 `watch_main`）——**57958 本身没有造成任何双建**，
是安全的。但这暴露了另一个问题：**今天 14:31:48 launchd 显然重新拉起了这个 job（新
PID），却没能真正杀掉旧的 64108**，导致 64108 变成了一个游离于 launchd 管理之外、
可能跑着旧代码的孤儿常驻进程。64108 的启动时间（00:01，刚过午夜）也暗示这不是第一次
发生——不确定是每天的例行重启都在产生孤儿，还是巧合。

**这个孤儿进程发现和 FLY-825 报告的双 tab 症状没有直接因果关系**（64108 从头到尾是唯一
真正在跑 watch_loop 的进程，双建是它自己一个 tick 内两条路径撞车，不是两个进程互相
踩踏）。但它是同一个"cmux 簇"下的另一个真实可靠性缺口，值得一并汇报，由 Tadashi 决定
是否并入本 issue 还是另开 follow-up。

## 待 Lead 确认的问题

1. **主修复方向**：`create_workspace_for_window` 的"建前快照判断是否存在"在
   `drain_events`（事件驱动）和 `sync_additive`（60s 周期）两条路径之间没有互斥。倾向
   于在 `create_workspace_for_window` 内部加一个"创建前再次确认"或者给这两条路径加一个
   进程内互斥/去重键（例如：正在创建中的 window_name 集合，第二个调用者直接跳过），
   而不是 issue 原描述的"重启中标记 re-attach in progress 让 heal 让路"（那个方向对应的
   是 heal_send_attach 单点注入竞态，FLY-756 昨天已经修过一次类似问题；今天这次复现的
   是 create-vs-create，不是 heal-vs-create）。
2. 孤儿 watcher 进程（发现 5）是否并入本次修复范围，还是单独开一个 follow-up issue？
3. 是否需要同时给 `dedup_workspaces_by_title` 补一个"按 linked view_session 而非按
   title 去重"的兜底，这样即使将来还有类似的 rename 竞态漏网，至少不会让用户看到两个
   tab（这属于"消灭症状"的第二道防线，不是根治，需要跟 Lead 讨论要不要做）。

## 下一步

- 待 Tadashi 通过 BRAINSTORM GATE 确认理解和修复方向后，写 research.md（读
  `create_workspace_for_window` / `sync_additive` / `drain_events` 附近现有测试
  覆盖、`test-cmux-sync.sh` 里已有的 mock 框架能否复现这个 in-tick 双触发场景）+
  plan.md（具体改动 + TDD 测试设计），然后走 Codex design review。
