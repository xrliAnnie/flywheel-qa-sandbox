# Research: cmux Integration Overhaul — Open Question Follow-up — FLY-129

**Issue**: FLY-129
**Date**: 2026-05-18
**Source**: `doc/engineer/exploration/new/FLY-129-cmux-integration-overhaul.md` (§3 Open Questions, §2 Annie 观察 C)
**Status**: Complete

---

## 1. Research Question

Brainstorm (FLY-129 expanded) 锁定了 7 项 scope, 但留下 4 个 open question 需要在写 plan 前澄清, 否则会导致以下风险:

- **Scope item #4 ("用 window ID 而非 name 匹配")** 语义不明 — 是 tmux `@N` 还是 cmux `workspace:N`? 走错方向会 regress FLY-98 之前修过的 Lead-restart cmux UI 不刷新问题.
- **§2-C "cmux UI 显示 window 0 (空 zsh) 而不是活的 Claude window"** 这条 Annie 实际撞过、当时无法 repro 的现象, 缺乏可落地的 fix 路径. 不解 plan 阶段就只能写"留待复现", scope 会一直缺一块.
- **`--once` + `--watch` 并发安全** — deploy / CI 路径上的真实风险, 但 brainstorm 没收敛到一个选项.
- **cmux app state 文件存不存在 / 在哪** — ghost reaper (scope #2) 设计 audit log 需要 cross-check 数据源, 缺了等于盲做.

本 research 把这 4 项各自跑一遍 evidence-driven 验证, 收敛到一组可写进 plan 的明确结论 + 新增 scope item.

---

## 2. Methodology

- 所有结论 == "实际跑过命令 / 看过代码" 才下笔. hypothesis 留在 §6 而不是结论里.
- 用 `git log` + `git show` 查 FLY-98 commit history 还原 Annie 真实意图.
- 用 `cat ~/Library/Application\ Support/cmux/session-com.cmuxterm.app.json | python3` 直接读 cmux Electron 持久化状态, 不只依赖 `cmux list-workspaces` IPC.
- §3.2 H2 通过 Annie 2026-05-17 现场观察 + 实际 workaround 跑通的方式来验证 (close-and-recreate workspace 后 cmux UI 恢复正常).
- 不做新的破坏性操作 (workaround 已在 brainstorm 阶段做过, 数据已采到).

---

## 3. Findings

### 3.1 Scope item #4 — "用 ID 而非 name 匹配" = cmux `workspace:N`, 不是 tmux `@N`

**Brainstorm §3.1 的二选一**:

- (A) tmux window ID (`@N`)
- (B) cmux workspace ID (`workspace:N`)

**结论: (B). 选 (A) 等于 regress FLY-98.**

**证据 — FLY-98 commit history**:

```
$ git log --oneline --all | grep -i "FLY-98"
7812188 fix: cmux auto-sync on Lead restart (FLY-98) (#145)
915c0b8 fix: use repo script directly in trigger_cmux_refresh (FLY-98)
f48c85f fix: cmux auto-sync on Lead restart — use window name instead of ID (FLY-98)
```

FLY-98 commit `f48c85f` body 直说:

> - Fix stale window ID: use tmux **=name exact match instead of @N window ID**

FLY-98 当初是**从 `@N` 改成 by-name** 的方向. 改回 `@N` 会再次撞到 commit 里描述的 root cause: Lead daemon 重启后 tmux 同名窗口拿到新 `@N`, linked session 的 select-window pointer 失效, cmux UI 渲染失败 (老 SIGPIPE 路径).

**真正要修的是 cmux 侧 (workspace:N) 内部 state 索引**, 不是 tmux 侧 (@N):
- 当前 dedup / cleanup (`workspace_exists_for`, `cleanup_workspace_for`, `cleanup_stale_workspaces`, `cleanup_stale_conservative`) 全部按 **title 字符串匹配** cmux workspace.
- title 在 `cmux new-workspace` (默认 `~`) → `cmux rename-workspace` (设成 tmux window name) 之间有一段非原子的窗口 — 第二个 watcher 在这段窗口里 `workspace_exists_for(name)` 会返回 false, 然后 race 出第二个 workspace.
- 修法: 在内存里维护 `tmux_window_name → cmux workspace:N` 反向索引, 之后所有 cmux 操作 (close / rename / re-attach) 都按 `workspace:N` 精确寻址.

**Plan-phase implication**: scope item #4 写成 "**内部 state 索引由 title-match 改为 cmux `workspace:N` reverse-index; tmux 侧保留 FLY-98 的 by-name (`=name`) 路径不动**". 严禁同时改 tmux side.

---

### 3.2 §2-C / H2 — cmux UI 缓存 confirmed, 修法 = close-and-recreate workspace

**Brainstorm §2-C 现象**: Lead daemon (ops-lead) 重启后, cmux UI 显示 workspace 内是 window 0 (空 zsh), 而不是 active 的 Claude window. brainstorm 当时无法 repro.

**结论: H2 confirmed — cmux app 渲染端缓存了 pane snapshot, `tmux select-window` 不会触发 cmux 重新拉数据.** 修法是 **close-and-recreate workspace**, 不能只 detach+re-attach.

**证据 — 2026-05-17 Annie 现场观察 + workaround**:

1. ops-lead daemon 重启后, Annie 在 cmux UI 截图看到: `geoforge3d-ops-lead` workspace 显示空 zsh, 不是 active Claude.
2. CLI 侧实测 `tmux select-window -t flywheel:claude-ops-lead` 是成功的, `tmux list-windows -t flywheel` 能看到正确的 active marker — **tmux 侧 state 是对的**.
3. 这说明 cmux Electron 渲染端把上次 attach 时的 pane snapshot 缓存了, sync 脚本调 `tmux select-window` 不会触发 cmux 那侧 re-attach / re-render.
4. Annie 跑的 workaround: 关掉所有 dup ops-lead workspace (workspace:1 + workspace:29) → sync 脚本在下一个 tick **重建** workspace:40 (新 ID) → fresh attach → cmux UI 显示 active Claude 正常.
5. 重建用时 ~51s (一个 sync tick + 一次 cmux new-workspace + linked session attach).

**为什么是 close-and-recreate, 不是 detach+re-attach**:
- cmux IPC API 没有 "force re-render" 或 "detach pane" 入口 (我们看 `cmux --help` + 当前 `flywheel-cmux-sync.sh` 调过的所有动词只有 `list-workspaces / new-workspace / close-workspace / rename-workspace`).
- 唯一能让 cmux app 端 invalidate 缓存并重新拉 tmux state 的可观察手段, 是把 workspace close 掉 → 让 sync 脚本下一个 additive 循环重新 `cmux new-workspace` (新的 `workspace:N`) + 重新建 linked session.
- Annie 的 workaround 跑通了这条路径, 即是 fix 设计的存在性证明.

**触发条件 (plan 阶段实现要 gate)**:
- Lead daemon 重启后 (`flywheel` session 被 kill + 重新 spawn).
- Runner reuse 一个老 tmux session name (Runner crash 重建).
- 任何 "tmux window 同名但 pane 被换掉" 的场景.

**Plan-phase implication**: **新增 scope item #8 — "Lead-restart cmux UI 缓存 fix: 在 Lead daemon 重启钩子检测到 source session 重建时, 主动 close + 让 watcher additive loop 重建对应 workspace"**. 必须 dry-run + audit log (close reason: `lead-restart-cache-invalidate`), 避免误关用户在看的 workspace.

---

### 3.3 H3 — `--once` + `--watch` 并发 → 选 Option (b) `--once` detect watcher → exit 0 + suggest `--refresh`

**Brainstorm §3.3 三选一**:
- (a) `--once` 也走 lock, 等 watcher 退 — deploy 会被无限期阻塞.
- (b) `--once` detect watcher → exit 0 + 提示用 `--refresh` — 最安全, ~10 行代码.
- (c) `--once` 跟 `--watch` 共享 event/cleanup-pending state — 复杂, 收益不大.

**结论: (b). 理由 + 实现 sketch 如下.**

**理由**:

- **(a) deploy 阻塞**: restart-services.sh + CI 脚本路径上调过 `--once` 的地方 (FLY-98 `trigger_cmux_refresh` 等) 都期望快速完成. 把它 block 在 watcher 后面会让 Lead restart cycle 不可预测.
- **(b) 已有等价语义**: `--refresh` 在 FLY-98 引入时本来就是 "tmux-only 修复, 不碰 cmux socket, 任何地方都安全" — 跟 `--watch` 共存零冲突 (`cleanup_stale_workspaces` 这条 aggressive 路径根本不跑). `--once` 在 watcher 已经在跑的情况下, 该做的事 (additive create + tmux-side 修复) `--watch` 已经在做, `--once` 加做的只有 aggressive `cleanup_stale_workspaces` — 而这正是 race 风险源.
- **(c) state 共享**: 要在两个进程之间共享 cleanup-pending 队列, 需要原子写文件 + race-safe 读, 还要处理 `--once` crash 之后 leaked pending entry — 工程量不小. 这条 brainstorm 也明说 "复杂", 不值得.

**实现 sketch (~10 行)**:

```bash
# 在 sync_once() 开头, cleanup_stale_workspaces() 调用之前:
if pgrep -f "flywheel-cmux-sync(\.sh)? +--watch" >/dev/null 2>&1; then
  echo "[flywheel-cmux-sync] --watch is running; --once would race." >&2
  echo "                    Use 'flywheel-cmux-sync --refresh' for tmux-only repair," >&2
  echo "                    or kill the watcher first if you really need aggressive cleanup." >&2
  exit 0   # exit 0 so restart-services.sh / CI 不报错
fi
```

注意: pgrep 要排除 self (sync_once 不会自己叫 `--watch`, 但 `--once|""` 路径上有可能在 hook 链里被自调用); 上面 regex 显式带 `--watch` 关键字, 安全.

**Plan-phase implication**: scope item #3 (dedup) 路径上其实也部分依赖 "只有一个进程能调 cmux IPC" — `--once` exit-fast 是个低成本的额外护栏, 应该跟 scope #1 (mkdir lock 真生效) 一起在 plan 阶段写.

---

### 3.4 cmux app state file — `~/Library/Application Support/cmux/session-com.cmuxterm.app.json`, 20KB, ghost = `customTitle: null`

**Brainstorm §3.4 spike**: 找 cmux app 持久化 workspace list 的磁盘文件.

**结论: 找到, 文件唯一**.

**证据 (实测 2026-05-18)**:

```
$ ls -la ~/Library/Application\ Support/cmux/
-rw-r--r-- 1 xiaorongli staff 20077 May 18 16:33 session-com.cmuxterm.app.json
```

文件结构 (用 python3 json.load 解析):

```
top keys: ['createdAt', 'version', 'windows']
windows count: 1
windows[0] keys: ['display', 'frame', 'sidebar', 'tabManager']
total nested workspace records: 34
sample record keys: ['currentDirectory', 'focusedPanelId', 'isPinned', 'layout',
                     'logEntries', 'panels', 'processTitle', 'statusEntries',
                     'customTitle', ...]
customTitle: None=26, ~=0, empty=0, total=34
```

**两条 plan 阶段必须知道的事**:

1. **Ghost workspace 的真实 marker = `customTitle: null` (JSON), 不是 `~` (UI 显示).**
   - 我们之前在 brainstorm §1.2 看到 `cmux list-workspaces` 输出 `~` — 那是 cmux UI 在 customTitle=null 时的 fallback 渲染, 不是真值.
   - ghost reaper 的判定逻辑可以 (优先) 直接读 JSON 文件做 source-of-truth cross-check; 或者继续靠 `cmux list-workspaces` 但理解 `~` ≡ `customTitle == null`.
2. **workspace ID 单调递增, 不复用**:
   - brainstorm baseline: max_id=34, total=34, ghosts=26.
   - 2026-05-17 PDT 同一天后续观察 GEO-372 workspace ID 从 34 跳到 38 (4 个 ID 之间没间隔时间内被消耗掉), 强烈支持 "cmux 内部不复用 closed workspace 的 ID, 每次 new 都拿 max+1".
   - 这条直接巩固 scope item #4 (按 `workspace:N` 索引): ID 永远唯一, 用它做 key 安全, 没 ABA 问题.

**Plan-phase implication**:
- ghost reaper (scope #2) 可以**额外** 5 行加个 paranoid cross-check: 读 JSON file → 拿到 workspace_id + customTitle 对照表 → 跟 `cmux list-workspaces` 输出比对, 不一致就 abort + Discord 告警 (cmux app 跟 IPC 不同步是真 bug, 不应该 silently 继续 close).
- audit log schema 用 `{workspace_id, customTitle (real, from JSON), close_reason, dry_run_diff}`.

---

## 4. Recommendations (写进 Plan 时直接抄)

### 4.1 Open question 收敛结果

| Open Q | 结论 | 信心 |
|---|---|---|
| 3.1 #4 ID 语义 | **cmux `workspace:N`**, 不是 tmux `@N`. tmux 侧保留 FLY-98 by-name 路径. | High (commit 历史明确) |
| 3.2 H2 cmux UI 缓存 | **Confirmed**. 修法 = **close-and-recreate workspace** (不是 detach+re-attach). | High (Annie workaround 已跑通) |
| 3.3 `--once`+`--watch` | **Option (b)** — detect watcher → exit 0 + 提示 `--refresh`. ~10 行 bash. | High |
| 3.4 cmux state file | **`~/Library/Application Support/cmux/session-com.cmuxterm.app.json`** (20KB), ghost = `customTitle: null`, workspace ID 单调递增不复用. | High (实测) |

### 4.2 Scope 增量 — 在 brainstorm §4.1 的 7 项基础上追加

| # | 新增 / 修订 | 内容 |
|---|---|---|
| 4 (修订) | scope #4 改写 | "**内部 state 索引由 title-match 改为 cmux `workspace:N` reverse-index**; 所有 cmux IPC 操作按 workspace:N 精确寻址. **不动** tmux 侧 by-name 路径 (FLY-98 已修)." |
| 8 (新增) | Lead-restart cmux UI 缓存 fix | "Lead daemon 重启钩子检测 source session 重建 → 主动 **close** 对应 cmux workspace → 让 watcher additive loop 用新 `workspace:N` 重建 + 重 attach. dry-run + audit log (reason: `lead-restart-cache-invalidate`)." |

scope item #2 (ghost reaper) 实现层面增加: 可选地 cross-check `session-com.cmuxterm.app.json` 文件, 不一致时 abort + alert.

scope item #3 (dedup) 路径上, plan 应顺手把 `--once` exit-fast 写进 patch (Option b, ~10 行), 跟 scope #1 (lock 下沉) 配对.

---

## 5. Risk Notes

- **scope #4 修法**: 内部状态从 title 索引切到 `workspace:N` 索引 — 需要全面 grep `workspace_exists_for` / `cleanup_workspace_for` / `cleanup_stale_workspaces` / `cleanup_stale_conservative` 的所有调用点, 不能漏改. plan 阶段写明文件:行号清单.
- **scope #8 H2 fix**: close-and-recreate workspace 在 Lead 重启窗口期间, Annie 如果正好在看那个 workspace, UI 会闪一下 (workspace 消失 → ~51s 后重新出现新 ID). 写入 plan 时需明确这是 acceptable trade-off (vs. 完全不渲染), 并 surface 给 Annie.
- **3.4 state file 直读**: cmux app 的 schema 是第三方, 没有承诺向后兼容. 我们应只读 `customTitle` 和 `windows[*].tabManager` 路径下的 ID, 任何 schema 变化 fail-safe (abort cross-check, 不 abort cleanup). 把这条写进 audit log 的 metadata.
- **§2-A "list-workspaces spawns ghost"**: brainstorm 把这条 mitigate 到 orphan watcher kill 上, 当前未复现. 如果 plan 阶段 controlled test 又撞到, 升级为独立 scope item; 现阶段不进 FLY-129.

---

## 6. Open Hypotheses (not blocking plan)

- **H4**: cmux app 内存 leak (Adjacent issue, brainstorm §1.7) 跟我们 `customTitle: null` ghost 累积是否相关? 26 个 ghost workspace 都有自己的 `panels / layout / logEntries` 子树, 即便 RSS 不直接 explode, 也意味着 cmux app 加载时要 deserialize + 实例化 26 个无用 workspace 对象. ghost reaper 修了之后, 可以 (separately) 观察 cmux app cold-start RSS / load time 是否下降. 这条 **不进 FLY-129 scope**, 留作 cmux upstream bug report 的 supporting evidence.
- **H5**: workspace ID 跳号 (34 → 38) 中间消耗的 ID 是否来自 brainstorm §1.3 怀疑的 orphan watcher? log 没记录, 不可复现; 留作 plan 阶段 controlled test 时 sanity-check (kill orphan, 观察 ID 增长速率).

---

## 7. References

- Brainstorm: `doc/engineer/exploration/new/FLY-129-cmux-integration-overhaul.md`
- FLY-98 commit: `f48c85f fix: cmux auto-sync on Lead restart — use window name instead of ID (FLY-98)`
- FLY-110 (event-driven cleanup): brainstorm §1.4 引用
- Sync script: `scripts/flywheel-cmux-sync.sh` (`sync_once` line 726, `watch_main` line 715, `cleanup_stale_workspaces` line 264, `cleanup_stale_conservative` line 582)
- Autostart script (lock 当前位置): `scripts/flywheel-cmux-autostart.sh:6-32`
- cmux state file: `~/Library/Application Support/cmux/session-com.cmuxterm.app.json` (20077 bytes, 34 workspaces, 26 ghost on 2026-05-18)
