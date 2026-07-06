# Exploration: cmux Integration Overhaul — FLY-129 (expanded)

**Issue**: FLY-129
**Date**: 2026-05-17
**Status**: Complete (brainstorm)

---

## 0. 背景

FLY-129 最初写于 2026-05-05, 标题 "Runner sessions not appearing in cmux sidebar". 2026-05-14 晚上 Annie 在使用过程中连续撞到一组 cmux ↔ flywheel 集成问题, 原始 scope 明显过窄. 本 exploration 由 worker-fly-129 在 2026-05-17 通过命令行 audit + 与 Annie (via team-lead) 多轮交互完成, 用于:

1. 把 Annie 观察到的现象逐项亲自验证 (绝不直接相信 list).
2. 找出代码里其它一并出问题但 Annie 还没看见的 rot vector.
3. 给 plan 阶段一个**已被证据支撑的 scope**, 不是凭印象拍.

cmux 是 Annie 日常用来看 Lead/Runner 跑成什么样的桌面 UI. 它跟 tmux 的关系是: 我们的 sync 脚本 `flywheel-cmux-sync.sh` 把 `flywheel` (Lead) + `runner-*` (Runner) 这两类 tmux session 里每个 agent 窗口, **一对一** 复制成 cmux 的一个 workspace tab. cmux 自己跑 `tmux attach -t cmux-<window_name>` 把 tab 内容渲染出来.

整体架构 + 各 rot vector 的位置:

```mermaid
flowchart LR
    subgraph "Source (我们的)"
      Lead[Lead daemon<br/>session=flywheel]
      Runner[Runner daemon<br/>session=runner-*]
    end

    subgraph "Sync layer (本 issue 修这里)"
      Auto[flywheel-cmux-autostart.sh<br/>mkdir lock]
      Watch[flywheel-cmux-sync.sh --watch<br/>event 15s + sync_additive 60s]
      Linked[Linked sessions<br/>cmux-&lt;window_name&gt;]
    end

    subgraph "cmux app (Electron, 第三方)"
      Sock[/tmp/cmux.sock<br/>IPC]
      Workspaces[Workspaces<br/>workspace:N]
      Viewer[Viewer sessions<br/>viewer-UUID]
    end

    Lead -->|tmux 窗口| Watch
    Runner -->|tmux 窗口| Watch
    Auto -->|spawn| Watch
    Watch -->|new-workspace<br/>close-workspace| Sock
    Watch -->|创建/维护| Linked
    Sock --> Workspaces
    Workspaces -->|attach| Linked
    Workspaces -.创建.-> Viewer

    classDef rot fill:#fff4e6,stroke:#ff9500;
    class Auto,Watch,Linked,Workspaces rot
```

红圈 (`rot` class) 区域里有 6 个并存的 rot vector. cmux app 自身的 200GB 内存 leak 在第三方代码 (Electron 渲染端), 不在 FLY-129 范围.

---

## 1. Verified Problem Inventory

每项都在 2026-05-17 PDT 下午亲自跑了命令验证. 不打算让 plan 阶段重复劳动 — Reproduction 命令写出来供回归验证.

### 1.1 双 watcher 并发 — mkdir lock 形同虚设

**症状**: 同一时刻有两个 `flywheel-cmux-sync --watch` 进程在跑, 共享 `$EVENT_FILE` (`/tmp/flywheel-cmux-events`) 和 cmux IPC. 两个 watcher 都会响应同一个 hook 事件, race 出多余 workspace + 重复 close.

**Evidence (实测)**:
```
PID 81431  PPID 1 (launchd, orphan)  uptime 16h+  /bin/bash flywheel-cmux-sync --watch
PID 82480  PPID 82477 (autostart)    uptime 16h+  /bin/bash flywheel-cmux-sync --watch
```

`/tmp/flywheel-cmux-watcher.lock` 只 gate `flywheel-cmux-autostart.sh` (检查 lock dir + 写 PID file + EXIT trap). 直接调用 `flywheel-cmux-sync.sh --watch` 完全不过 lock — 任何手动/脚本直接拉起的 watcher 都绕开了.

**Reproduction**:
```bash
ps -eo pid,ppid,etime,command | grep flywheel-cmux-sync | grep -v grep
```

**修复方向 (locked FLY-129 scope #1)**: lock 移到 sync 脚本本体, 或改用更强的单实例机制 (e.g. file lock + PID 校验 + 自我 kill stale).

---

### 1.2 Ghost workspace — 26 个 title=`~` 工作区, sync 看不见

**症状**: `cmux list-workspaces` 返回 34 个 workspace, 其中 26 个 title 是 `~` (cmux 表示"无 source"的占位符), 8 个有真名. ghost 永远不被清理.

**Evidence (实测)**:
```
total=34 ghosts=26 named=8  max_id=34
```

**根因 (hypothesis — 待 plan 阶段验证)**:
- 当前 sync 所有 cleanup 路径 (`cleanup_workspace_for`, `cleanup_stale_workspaces`, `cleanup_stale_conservative`) 都是**按 title 匹配** linked session/workspace. ghost 没 title (是 `~`), 在我们代码里完全不可达.
- 来源最可能是 cmux app 把 workspace list 持久化到磁盘 (`~/Library/Application Support/cmux` 之类), 历次启动累加而不清理. 这条 plan 阶段需要先做 5 分钟 spike 确认.

**Reproduction**:
```bash
cmux list-workspaces | awk '{$1=""; sub(/^[* ]*workspace:[0-9]+/,""); print}' | sort | uniq -c | sort -rn | head
# 看到 ~ 出现 26 次
```

**修复方向 (locked FLY-129 scope #2)**: ghost reaper 必须按 **workspace ref (workspace:N)** 而不是 title 匹配, 才能 close `~`. 关闭前 dry-run 写 audit log (workspace_id + title + reason).

---

### 1.3 Sidebar dedup — 同 title 多个 workspace

**症状**: 同一个 tmux 窗口在 cmux sidebar 出现 ≥2 次. Annie 在 GEO-372 Runner 刚 spawn 时实时观察到; 我审计时也看到 `geoforge3d-ops-lead` (workspace:1 + :29) 和 `test-slot-2-flywheel-test-2` (workspace:13 + :14) 两组遗留 dup.

**Evidence (实测, baseline 时)**:
```
workspace:1   geoforge3d-ops-lead
workspace:29  geoforge3d-ops-lead          ← dup
workspace:13  test-slot-2-flywheel-test-2
workspace:14  test-slot-2-flywheel-test-2  ← dup
workspace:34  GEO-372-claude-Add-printable-...
workspace:35  GEO-372-claude-Add-printable-...   ← Annie 观察到, 后续自行消失
```

**根因 (hypothesis)**: watcher log 显示对 GEO-372 只有 **1** 次 `Creating workspace` (14:59:51 → workspace:34). workspace:35 不是我们 sync 创建的. 强烈怀疑是被 kill 掉的 orphan watcher (PID 81431) 在另一份 event 流里也响应了一遍 hook → 调了 `cmux new-workspace` 又落了一个. 这跟 1.1 是同根问题, 但即便 1.1 修了, 历史遗留的 dup 还在; 同时 `workspace_exists_for` 用 title 精确 match, 一旦 title 在 create + rename 之间有空窗, 第二次 check 就会触发 re-create.

**Reproduction (历史现象)**: orphan watcher 被 kill 后再跑 5 次 `cmux list-workspaces`, 计数稳定不增 — 单 watcher state 下没再看到新 dup. 进一步 repro 留到 plan 阶段做 controlled test (Q5 决定不在 brainstorm 做).

**修复方向 (locked FLY-129 scope #3 + #4)**:
- (#3) 在 `create_workspace_for_window` 加去重保护: create 前用 `get_all_workspace_refs` snapshot + retry safety check; 或在每个 tick 跑 dedup 扫描 (按 title 分组, 保留有效 linked session 那个, 其它 close).
- (#4) 把内部 state 从 "title 索引" 改成 "workspace ID 索引" — 见 §3 Open Question 关于 ID vs name 的 nuance.

---

### 1.4 STALE_STATE 文件 leak

**症状**: `/tmp/flywheel-cmux-stale.state` 累积 23 行 (最老 2026-05-08, 最新 2026-05-17 ~12h 前), 含字面重复 (`qa-test-explicit` x2, `test-spawn` x2). 含一行 `GEO-372-claude-...` 但该 pane 当前活着 (`pane_dead=0`).

**Evidence**:
```
$ wc -l /tmp/flywheel-cmux-stale.state
      23
$ cat /tmp/flywheel-cmux-stale.state | sort -t'|' -k2 -n | head -3
FLY-138-claude-Issue-FLY-138|1778097234   # 2026-05-08
tmux|1778097310                            # 2026-05-08
FLY-138-claude-QA-FLY-127-sandbox-Product-Test-lab|1778101683
```

**根因 (已识别, 不是 hypothesis)**: 看 `flywheel-cmux-sync.sh:582-616 cleanup_stale_conservative`:
- 它**只**遍历当前 `linked_sessions=$(... | grep "^cmux-")`. 对没有当前 linked session 的过期行, 完全跳过.
- FLY-110 引入的 event-driven `cleanup_workspace_for` 在 kill linked session 时**没有**同步删 state 文件里对应行.
- 结果: 每次 event-driven cleanup 完成, state 文件就多一行孤儿. 时间一长就累成现在这样.

**Reproduction**:
```bash
cat /tmp/flywheel-cmux-stale.state | wc -l   # 看行数随天增长
```

**修复方向 (locked FLY-129 scope #5)**: 把 state 文件清理动作下沉到 `cleanup_workspace_for` (event-driven 和 conservative 都用同一条路径). 顺手在 watcher 启动时做一次性 GC (drop 对应 linked session 已不存在的行).

---

### 1.5 Log spam — `Hooks registered on session` 31,894 行

**症状**: `/tmp/flywheel-cmux-watcher.log` 里 "Hooks registered on session: ..." 出现 31,894 次. 这是 `register_hooks_on_new_sessions` 每 60s tick 都 unconditionally 打的两行 (flywheel + runner-*).

**Evidence**:
```
$ grep -c "Hooks registered" /tmp/flywheel-cmux-watcher.log
31894
```

**根因**: `register_session_hooks` 用 `tmux set-hook` 改写 array index `[500]`, 是幂等的 — 重复调没副作用. 但它无差别地 `log "Hooks registered on session: $session"`. 想做"每分钟 safety net"的初衷没错, 但每次都打日志的实现等于在 debug log 里淹没真正有意义的信号 (e.g. Creating workspace, ERROR).

**Reproduction**:
```bash
grep -c "Hooks registered" /tmp/flywheel-cmux-watcher.log
# 看长期跑下来的累积量
```

**修复方向 (locked FLY-129 scope #6)**: `register_session_hooks` 检测 hook 是否真的没注册过 (e.g. `tmux show-hooks -t $session | grep -q '500'`), 只在首次/恢复时 log; 后续 idempotent 调用静默.

---

### 1.6 cmux app 挂时无 backoff — 8.5 min 内 33 行 ping 失败日志

**症状**: Annie 把 cmux app 杀掉后 (200GB 内存事件), watcher 在 cmux 不存在的整段时间里, 每 15s 一次 ping 失败:

```
[14:47:34] WARN: cmux ping failed transiently (rc=1, err='Error: Failed to connect to socket at /tmp/cmux.sock')
... 33 行 ...
[14:55:50] Hooks registered on session: flywheel       ← cmux 回来了
```

8.5 分钟内 33 行噪声. 如果 Annie 没立刻重启 cmux, 一晚上能淹掉几千行.

**Evidence**:
```bash
grep -c "Failed to connect to socket" /tmp/flywheel-cmux-watcher.log
# (按这次事件来看 ≥ 33)
```

**根因**: `cmux_health_check` 返回 rc=1 (socket missing) → `cmux_health_check_or_die` 直接 `return 1` + 一行 INFO + `log WARN`. 没有 backoff 状态, 也不区分 "刚挂掉" vs "已挂了 N 分钟".

**Reproduction**:
```bash
# 关 cmux app, 等 1 分钟
killall cmux
sleep 60
grep "Failed to connect" /tmp/flywheel-cmux-watcher.log | tail -10
# 看到每 15s 一行重复 ping
```

**修复方向 (locked FLY-129 scope #7)**: 加指数 backoff (15s → 30s → 1min → 5min cap). 同时, **同样的错误连续出现时只 log 一行** "cmux unavailable since T (N ticks)", 恢复时 log 一行 "cmux recovered after Ns". 静默 + 显式状态转换.

---

### 1.7 (Adjacent — 不在 FLY-129 scope) cmux app Electron 200GB 内存 leak

**症状**: Annie 在 2026-05-14 PDT 晚上观察到 cmux app 进程 RSS 涨到 ~200GB, 不得不强 kill. 这是 cmux app 自己 (Electron 渲染端) 的问题, 跟我们的 sync 脚本无关.

**Evidence**: Annie 的直接观察. 我没复现, 但当前实例 RSS 已是 ~100MB (重启后), 没必要再复现.

**修复方向**: **新开 FLY-XXX, 走 upstream cmux GitHub issue 路径**. flywheel codebase 不修. 短期 mitigation 可在 Lead daemon healthcheck 里加 "cmux RSS > N GB 警报", 但这是 v0.x 优化, 不挡 FLY-129.

---

## 2. Annie 观察 vs Hypothesis

收集了三条 Annie 在使用中报告但**当前已不可重现**的现象. 不进 inventory (没法用代码 fix 一个无法 repro 的现象), 但留给 plan 阶段做 controlled test.

| Annie 观察 | 我的 hypothesis | 现状 |
|---|---|---|
| **A. 跑 `cmux list-workspaces` 会 spawn 一个新 ghost workspace** | 我 kill 了 orphan watcher (PID 81431) 后连跑 5 次 `cmux list-workspaces` — 计数稳定 (total=34, max_id=34, ghosts=26). 强烈怀疑 Annie 当时撞到的是: orphan watcher 在响应自己 event file 的过时事件, 顺便对每次 IPC 活动 race 出新 workspace. 单 watcher state 下未复现. | **已 mitigated** (orphan killed). plan 阶段加 controlled test 二次确认. |
| **B. workspace:35 (GEO-372 dup) 自行消失** | 在 Annie 观察到 workspace:34 + :35 之后约 10 分钟, 我抓 baseline 时只剩 :34. watcher log 没有 close-workspace 记录. 唯二可能: (1) cmux app 内部 reconciliation; (2) orphan watcher PID 81431 close 了它 (它 stdout 进了虚空 — 不写共享 log). | 不可复现, 留作 plan 阶段 controlled test 题材. |
| **C. cmux UI 显示 window 0 (空 zsh) 而不是活的 Claude window** | `reconcile_existing_workspaces` 和 `refresh_linked_sessions` (FLY-98) 应该 cover Lead daemon 重启后 select 到正确 window. 怀疑: (1) linked session 本身 attach 时 cmux app 端做了 selected-window 缓存, 我们 `tmux select-window` 不影响 cmux 显示; (2) 或 reconcile 路径在某些 race 下没真跑. 需要 Annie 描述具体哪个 Lead, 我观察当时 watcher log 才能 narrow down. | 现在 cmux UI 显示正常 (我看 GEO-372 在 sidebar). 复现要 Annie 再撞一次或我们 deliberately reproduce. |

---

## 3. Open Questions for Plan / Research Phase

### 3.1 Scope item #4 nuance — "window ID 而非 name 匹配" 指什么 ID?

Annie 锁定的 scope item #4 字面是 "用 window ID 而非 name 匹配". 这里有歧义需要 plan 阶段澄清:

- **tmux window ID (`@N`)** — FLY-98 当初是**反向修**的: 从 `@N` 改成 by-name. 因为 tmux window ID 在 Lead daemon 重启后会变 (新窗口同名但 @N 不同, linked session 的 select-window pointer 失效). 如果现在改回 ID 匹配, 必须同时解决 Lead restart 后 workspace 找不到对应 source window 的问题. **如果这是 Annie / Bar-Raiser 真意, plan 阶段要重新设计 Lead restart 处理.**
- **cmux workspace ID (`workspace:N`)** — 我们当前 dedup / cleanup 用 title match. 如果改成在内存里维护 `title → workspace:N` 反向索引, 用 `workspace:N` 精确操作 cmux, 能避免 title race. **我赌这是 Annie 真意 — 跟 1.3 dedup 修法直接对得上.**

**Plan 阶段需先确认哪个语义.**

### 3.2 H2 — Lead daemon 重启时的 cmux UI 缓存

cmux UI 是否在 app 端缓存了 "this workspace is showing tmux window @N"? 如果是, 我们 `tmux select-window` 改了 linked session 的当前窗口, cmux 那侧渲染可能没刷新. 如果真这样, fix 需要让 cmux app 重新拉一次 (e.g. detach + re-attach 或调 cmux CLI 命令).

### 3.3 H3 — 并发 `--once` + `--watch`

当前 `--once` 跑 aggressive `cleanup_stale_workspaces` (无延迟), `--watch` 跑 conservative (5min 延迟). 在 deploy/restart 路径上 (e.g. CI 调 `--once` 做一次性 sync), 如果跟 `--watch` 同时跑, `--once` 可能过早 close 一个 `--watch` 还在 cleanup-pending 队列里的 workspace.

**修法选项 (plan 阶段决):**
- (a) `--once` 也走 lock, 等 `--watch` 退出再跑 — 简单但 deploy 会被 watcher 阻塞.
- (b) `--once` 在 `--watch` 跑时直接退出 + 提示用 `--refresh` — 最安全.
- (c) `--once` 跟 `--watch` 共享 event/cleanup-pending state — 复杂但最优雅.

### 3.4 cmux app state 文件位置

为给 §1.2 ghost reaper 设计写 close audit log, plan 阶段需要 5 分钟 spike 确认 cmux app 是否真在某磁盘文件持久化 workspace list. 候选路径:
```bash
ls -la ~/Library/Application\ Support/cmux*/
ls -la ~/Library/Preferences/com.cmuxterm.app*
defaults read com.cmuxterm.app 2>/dev/null | head
```

如果找到, 还可以直接读那个文件做 cross-check (而不只是靠 `cmux list-workspaces`).

---

## 4. Scope Decision

### 4.1 FLY-129 (expanded) — 锁定 7 项

按 Annie 2026-05-17 PDT 锁定的 scope, 修复优先级排序:

| # | 修复项 | 对应 inventory | 影响面 |
|---|--------|---------------|--------|
| 1 | mkdir lock 真生效 (lock 下沉到 sync 脚本本体, 不只 autostart) | §1.1 | 防 watcher race, 治本 |
| 2 | Ghost reaper 能清 `~` workspace (按 workspace ref 而非 title 匹配, 关闭前 dry-run + audit log) | §1.2 | 清掉 26 个历史 ghost + 防累积 |
| 3 | Dedup 同 title 多 workspace (create 路径 + 周期扫描) | §1.3 | 防 sidebar 重复条目 |
| 4 | 用 window ID 而非 name 匹配 (语义待 §3.1 澄清) | §1.3 / §1.2 | 内部 state 模型升级 |
| 5 | STALE_STATE 文件清理 (event-driven cleanup 同步 drain state) | §1.4 | FLY-110 side-effect 修补 |
| 6 | Hooks registered log spam 静默 (only-on-change) | §1.5 | 让 debug log 重新可读 |
| 7 | cmux ping 失败指数 backoff + 状态转换 log | §1.6 | 防长期 cmux down 期间 log 淹没 |
| 8 | Lead-restart cmux UI 缓存 fix — close-and-recreate workspace pattern (Lead daemon 重启检测 source session 重建 → 主动 close 对应 cmux workspace → watcher additive loop 重建 + 重 attach; dry-run + audit log) | §2-C / H2 (per research follow-up FLY-129-cmux-research-followup.md §3.2) | 修复 Lead 重启后 cmux UI 显示 window 0 (空 zsh) 而不是 active Claude 的缓存问题 |

### 4.2 新开 FLY-XXX — cmux app Electron 内存 leak

| 项目 | 内容 |
|---|---|
| Repo | upstream cmux (第三方) |
| Bug | Electron 渲染端 RSS 涨到 200GB |
| Action | 给 cmux GitHub 上 bug report, 附 Annie 的现场截图/数据 |
| Mitigation in flywheel (可选) | Lead daemon healthcheck 加 cmux RSS 警报, > 5GB 给 Annie Discord push |

### 4.3 不进 scope 的项

- `viewer-*` linked session (cmux 自身创建, 跟我们无关, RSS 影响 < 1MB, 我们 sync 不 scan) — §2 验证过.
- LeadWatchdog 585+ stale `pane_hash_stuck` events — 在原始 Tonight's incident list 第 7 条, 经讨论与 cmux 集成无直接关系, 走 LeadWatchdog 自己的 issue (可能 FLY-83 后续).
- §2 Annie 观察 A / B / C — 已无法 repro, plan 阶段 controlled test 中复现再决定是否要 narrow code-path 修.

---

## Appendix — Brainstorm 过程数据点

为后续 retrospective 留个记录:

- 用时: 约 60 分钟 worker audit + 6-7 轮 worker ↔ team-lead ↔ Annie 互动.
- 验证命令全部跑过: `cmux list-workspaces`, `tmux ls`, `tmux list-windows -a`, `ps -eo pid,rss,etime,command`, `cat /tmp/flywheel-cmux-*`, `tail /tmp/flywheel-cmux-watcher.log`, `grep -c "Hooks registered" /tmp/flywheel-cmux-watcher.log`.
- 唯一 destructive action: kill orphan watcher PID 81431 (Annie 批准). 副效果: workspace 计数稳定下来, ghost spawn 现象在 single-watcher state 下未复现.
- 不在 brainstorm 做的事 (按 Annie 规则): repro test bench (留 plan 阶段), 写代码, 改 production config.
