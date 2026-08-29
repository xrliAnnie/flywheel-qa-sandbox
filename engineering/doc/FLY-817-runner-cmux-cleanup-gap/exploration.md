# FLY-817 收口 runner/cmux 清理缺口 — 探索(诊断)

Issue: FLY-817 (https://linear.app/geoforge3d/issue/FLY-817/infracleanup-收口-runnercmux-清理缺口-验证已上线的-crash-reaper-真在工作-清现存-100-僵尸记录)
日期: 2026-07-03
基于: 无

---

## 0. 结论先行(TL;DR)

对活生产数据(`~/.flywheel/teamlead.db` = Bridge FSM;`~/.flywheel/comm/flywheel/comm.db` = CommDB)做了 join 诊断,三个子问题的答案:

1. **~100 僵尸的真因 = 显示层/同步 gap(疑点 b),不是 reaper 漏(疑点 a)。** flywheel CommDB 有 **112** 行 `status=running`,但按 `execution_id` join Bridge FSM 后,其中 **104 行(93%)FSM 已是终态**(completed 47 / terminated 34 / failed 17 / blocked 6),只有 **8 行 FSM 非终态**(running 4 + awaiting_review 4 = 真活的,含本 runner 自己)。→ FSM 权威早已转终态,CommDB `sessions.status` 从没跟着同步/删除,`runner_terminal_list`(只读 CommDB + tmux 探活,**看不到 FSM**)于是把它们渲染成 `alive=false status=running` 僵尸。

2. **crash-reaper(FLY-720)在生产从没 fire 过。** `session_events` 里零 `runner_crash_reaped` / `runner_crash_teardown_transition_skipped` 事件、`~/.flywheel/crash-logs/` 目录空。reaper 上线约一周,从没撞上它要处理的精确崩溃路径(FSM=running + dead-pin + 超 grace),因此**完全未经真机验证**。这与 104 僵尸**无关**(那 104 是 FSM 终态,压根不在 reaper 的候选集 `getOrphanSessions` 里)—— 但 FLY-724 QA 仍必须补跑,证明 reaper 真会工作。

3. **cmux 死 tab 确实存在。** `runner-flywheel` window group 里 3 个 `pane_dead=1`:window 4/12 = FLY-787、window 13 = FLY-806。787 对应 FSM 终态(completed/failed)残留 → 可安全清;806 对应 FSM=`awaiting_review`(parked 但 pane 已死)→ 边缘 case,非终态,不擅自清。

---

## 1. 架构前提:两个独立的 sessions 表

| | Bridge FSM (StateStore) | CommDB |
|---|---|---|
| 文件 | `~/.flywheel/teamlead.db` | `~/.flywheel/comm/<project>/comm.db` |
| status 取值 | 全套 FSM 态(running/awaiting_review/completed/terminated/failed/blocked/…) | **CHECK 约束只允许 `running`/`completed`/`timeout`** |
| 谁读 | Bridge 内部逻辑(权威) | `runner_terminal_list` / Lead bootstrap(terminal-mcp,**读不到 FSM**) |
| 谁写终态 | 所有 FSM transition | 只有 runner 自己 `flywheel-comm complete`(completed/timeout)+ `deleteCommDbSession` 删除 |

关键点(`packages/terminal-mcp/src/lifecycle.ts:6-8` 明确写了):terminal-mcp **只能**读 CommDB status + tmux 探活,**无法**看 Bridge FSM。所以 CommDB 一旦和 FSM 不同步,`runner_terminal_list` 就会失真。

---

## 2. 诊断证据(活生产数据,只读查询)

### 2.1 FSM vs CommDB 全景

```
StateStore FSM status 分布(全项目):
  completed 275 · terminated 236 · blocked 95 · failed 61 · awaiting_review 44 · running 5 · shelved 3 · approved_to_ship 2 · rejected 1

CommDB flywheel status 分布:
  running 112 · completed 3
```

FSM 全项目才 **5** 个 running,CommDB flywheel 却有 **112** 个 running → 巨大落差。

### 2.2 112 个 CommDB running 行 join FSM

```
FSM status of the 112 CommDB running rows:
  completed        47   ← 终态,CommDB 没同步
  terminated       34   ← 终态,CommDB 没同步
  failed           17   ← 终态,CommDB 没同步
  blocked           6   ← 终态,CommDB 没同步
  running           4   ← 真活(FLY-793/795/811/817=本 runner)
  awaiting_review   4   ← 真活/parked(FLY-314/766/799/807)
```

- **104 终态僵尸**,日期范围 06-16 ~ 07-02 —— 完全对上 Issue 说的「~100 个 2026-06-16~07-02 的老 runner」。
- **8 非终态 = 真活的**,heartbeat 都是今天(running 4 个 16:48-16:50,含本 runner)。全部结构性受保护(见 §4)。

### 2.3 reaper 从没 fire(生产)

```
session_events 里 crash/reap 相关:
  terminal_tab_reaped   8   ← 别的 reaper(boot terminal-tab)
  viewer_session_reaped 2
  runner_crash_reaped   0   ← FLY-720 reaper 从没 fire
~/.flywheel/crash-logs/  →  空目录
```

### 2.4 cmux 死 pin

```
tmux list-panes -s -t runner-flywheel | grep dead=1:
  window 4  FLY-787  dead=1
  window 12 FLY-787  dead=1
  window 13 FLY-806  dead=1
```
- FLY-787 两行 FSM=completed/failed,CommDB tmux_window=`runner-flywheel:pending`(从没解析到真 @N)→ 终态残留。
- FLY-806 FSM=`awaiting_review`,pane 死在 @710 → parked-but-pane-dead 边缘 case。

### 2.5 跨项目规模(佐证 gap 是普遍且无界的)

```
CommDB running by project:
  TestProject 4849 · proj 912 · flywheel 112 · geoforge3d 43 · joycon-typeless 16 · tidal-echo 13 · growth 5 · sub 3 · qa-fly-123 1
```
TestProject/proj 是测试 scratch(大概率无对应 FSM 行);生产真僵尸约 ~190。**关键**:安全 reconcile 只删「CommDB=running **且** FSM 有终态行」的,天然把无 FSM 行的测试 scratch 排除(无终态证据 → 保留)。

---

## 3. 根因

CommDB `sessions.status` 的 CHECK 约束只允许 `running`/`completed`/`timeout`,**根本无法表示** `terminated`/`failed`/`blocked`/`rejected`/`shelved`。因此对这些终态,CommDB 唯一的清理方式是 **DELETE**(`deleteCommDbSession`)。而 DELETE 只在这些路径发生:

- `close_runner` / `terminate` / `post-merge` teardown(FLY-638 live 清理)
- crash-reaper reap(FSM running→terminated)
- FLY-638 **boot sweep** `pruneDeadTerminalCommDbSessions` —— 但它 `listSessions(project, ["completed","timeout"])` **只扫 CommDB status ∈ {completed,timeout}**,**不碰 CommDB `running` 行**。

于是任何「FSM 转终态但没走上面 DELETE 路径」的 session,CommDB 行就永远卡在 `running`:
- **failed(17):** `reapOrphans`→failed **不调** `deleteCommDbSession`(设计如此,failed 是 CRASH_PRESERVE 保留态)。
- **blocked(6):** `complete --route blocked` 把 FSM 设 blocked;CommDB 连 `blocked` 都写不进(CHECK 拒),行留 `running`。
- **terminated(34):** 经 FLY-369 中央 archive / 早于 deleteCommDbSession 接线的老终态路径转的,没删 CommDB。
- **completed(47):** runner 崩溃/退出前没写 `flywheel-comm complete`,FSM 靠 Bridge 侧 session_completed / QA finalize / Lead 收口转 completed,但 Lead 从没显式 close → CommDB 没删。

**FLY-638 boot sweep 的盲区正是「CommDB=running 但 FSM=终态」这一类 —— 它只看 CommDB 自身 status,从不 cross-reference FSM。这就是同步 gap 的根。**

---

## 4. 安全边界(purge 绝不能碰的)

reconcile/purge 的删除条件必须是:**CommDB `status='running'` AND 该 execution_id 在 StateStore FSM 里存在且 status ∈ 终态集**。

终态集 = 复用 `close-runner.ts` 的 `CLOSE_ELIGIBLE_STATES`(= `AUTO_CLOSE_STATES` {completed,rejected,deferred,shelved,terminated} ∪ `CRASH_PRESERVE_STATES` {failed,blocked}),**不手搓**。

结构性安全,不靠白名单:
- FSM 行 **缺失** → 无终态证据 → **保留**(测试 scratch DB 天然豁免)。
- FSM 非终态(pending/running/reconnecting/awaiting_review/approved_to_ship)→ **保留**(§2.2 的 8 个真活全在此,含本 runner)。
- 终态不可逆转回 running;retry successor 是**不同** execution_id → 按 execId 删除永不会误伤活 runner。
- 早删一步无害(与 `deleteCommDbSession` 幂等,删同一行)。

Issue 点名要护的 793/795/799/811/812/815-QA/535/529-Room:793/795/811(running)、799/807/314/766(awaiting_review)全在 §2.2 的 8 非终态里,自动受保护;812/815/535/529 不在 flywheel CommDB running 集或本就非僵尸。

---

## 5. 修复选项空间(留给 brainstorm gate 定)

**问题 1 —— reaper 验证(task 1):** 补跑 FLY-724 式 529-Room 真机 QA。合成 `alive=false + FSM=running + 无 marker + 超 grace` → 断言 reaper 真转 terminated + 撤 cmux + archive thread。这是独立 QA,不改产品码。

**问题 2 —— 结构性修复(task 2,根治 b):**
- **选项 A(推荐):CommDB↔FSM reconcile sweep。** 新增 `reconcileCommDbRunningAgainstFsm(store, project)`:删除 CommDB `running` 行中 FSM ∈ 终态集的。接进 FLY-638 那个 boot sweep 的兄弟位(那时已有 `store`)。最小、boring、对齐现有形态,复用 `deleteCommDbSession` 原语 + `CLOSE_ELIGIBLE_STATES`。kill-switch env。
- 选项 B:每条终态 transition 都删 CommDB —— 触面广、回归风险高,否。
- 选项 C:让 `runner_terminal_list` 读 FSM —— terminal-mcp 刻意 CommDB-only(可能跨机),否为主方案。

**问题 3 —— 一次性 purge(task 3):** 选项 A 的 boot sweep 在下次 Bridge 重启(本就 restart-gated 部署)时**自动清掉 104 backlog**,不需要单独的破坏性脚本。若要立即清,同一 reconcile 函数可独立跑一次(仍 founder-gated)。

**问题 4 —— cmux 死 tab(task 4):** 787(FSM 终态)的死 window 可随 reconcile/terminal-tab-reaper 收;806(awaiting_review,parked-but-pane-dead)非终态,标记出来交 Lead 判断,不擅自 kill。是否把「FSM 终态但 cmux window 仍在的死 pin」纳入本 issue 的 sweep,待 gate 定。

---

## 6. 待 gate 确认的开放问题

1. 结构性修复走**选项 A(boot sweep reconcile)**,同意?
2. purge 范围:只清 **flywheel** 的 104,还是把所有**生产**项目(geoforge3d/joycon/tidal-echo/growth/sub)的同类僵尸一起收(reconcile 天然覆盖,只是要不要一次全开)?
3. reconcile 只在 **boot** 跑(对齐 FLY-638),还是也 piggyback crash-reaper 的 heartbeat tick 做持续 reconcile(近零成本、防重启间累积)?
4. cmux 死 tab:本 issue 收「FSM 终态残留死 pin」到什么程度?806 这类 parked-but-pane-dead 是否留给单独 issue?
