# FLY-1204 三段式 phase session 交接/终态后不回收 → 内存泄漏 → OOM — 探索

Issue: FLY-1204 (https://linear.app/geoforge3d/issue/FLY-1204/bug-三段式-designqa-阶段-session-交接后不被收掉-内存泄漏累积-oomclose-runner-也拒关-design)
日期: 2026-07-12
基于: 无（本 issue 的第一份文档）

---

## 1. 症状回顾（Tadashi 2026-07-12 实证）

机器 OOM：free 跌到 70MB、compressor 22GB、持续 swap、Bridge 被 OOM-kill。根因**不是并发太多真活**，而是三段式 phase session 泄漏：

- 24 个 alive session 里，**7 个是 `design_done` / `completed` 的僵尸**（FLY-545/1062/1182/1185/1188/1189 各 1 个 `design_done` design 段 + 1 个 `completed` qa 段），共 ~1.9GB。手动 kill 后 free 立刻 70MB → 2.8GB、pageout 归零。
- 最老的 FLY-545 `design_done` 从 **2026-07-09** 挂着（3 天）。
- 第二个 bug：`close_runner` 关不掉这些，只能 `kill -9`。

---

## 2. 关键机制审计（代码为准，精确到文件行号）

### 2.1 三段式 keep-alive 下，交接后是「PARK」而不是「close」——这是 FLY-887 的设计意图

`PhaseOrchestrator.handoff()`（`packages/teamlead/src/bridge/phase-orchestrator.ts:1441-1488`）：

- keep-alive **OFF** → 旧路径：交接时 `closePhaseRunner(prev)`（关掉上一段），再 spawn 下一段。
- keep-alive **ON**（flywheel 生产当前 ON）→ 探活 `probePhaseAlive(prev)`：
  - `alive` → `parkPhaseRunner(prev)`（**PARK，不关**），作为 context holder 保活到 ship。
  - `dead_pin`/`absent` → close-clean。
  - `indeterminate` → fail-closed，留给 reconcile。

`parkPhaseRunner`（`plugin.ts:5604-5623`）**只做**：
```
db.upsertDeclaredState(execId, "parked", "three-stage <role> parked awaiting pipeline", ...)
```
**它不 kill 进程，也不清 CommDB 的 tmux registration。** 进程继续 alive（这正是 200-360MB 占用来源）——保活是为了 wake 时零 token re-onboard（FLY-887 动机）。

> 结论：交接后 design 段 `status=design_done` + CommDB `declared_state=parked` + **tmux/claude 进程 alive**。这是**故意**的，直到 ship 才该回收。所以 issue 诉求 1「交接后自动收上一段」的真正含义**不是**把 PARK 改成 close（那会毁掉 FLY-887 的 keep-alive + fix-loop wake），而是**终态/ship 后必须回收这些 parked 段**——而这条回收链有三个缺口。

### 2.2 缺口 A — ship 时 `finalizeThreeStagePhases` 漏掉 qa 段

`makeFinalizeThreeStagePhases`（`post-ship-finalization.ts:207-269`）在 ship 成功后回收 parked 段，但 filter 是：
```
.filter(s =>
    (s.chat_thread_role === "design" || s.chat_thread_role === "implement") &&
    FINALIZE_DONE_SOURCE_STATES.has(s.status))
```
- **`qa` 被排除**（filter 只列 design / implement）。
- `FINALIZE_DONE_SOURCE_STATES`（`close-runner.ts:68-78`）= `{running, awaiting_review, approved_to_ship, design_done}` —— **不含 `completed`**。

设计假设：qa 段本身就是**触发** finalization 的那个 session（`opts.executionId`），由 `runPostShipFinalization` 的 step-1 `postMergeTmuxCleanup(opts.executionId)` 关掉（`post-merge.ts:49-125`，`getTmuxTargetFromCommDb` → `killTmuxWindow`）。

但这条假设脆弱：只有当 QA 的 completion event 满足 `isPostApproveShipComplete`（`existingStatus/route/landingStatus=merged` 组合，`post-ship-finalization.ts:68-99`）**且触发者恰好是 QA execId** 时才成立。一旦 ship 由 external-merge / 别的路径触发，或 QA 完成后自己也进入 keep-alive park（`completed` 但进程 alive），qa 段就**没有任何回收路径**——`completed` 的 qa 僵尸即由此而来。

### 2.3 缺口 B — 周期兜底 `getStaleCompletedSessions` 漏掉 `design_done`

FLY-867 已经有一个周期兜底：`HeartbeatService.checkStaleCompleted()`（`HeartbeatService.ts:886-964`），每 `staleCheckIntervalMs`（默认 6h）扫一次，把 terminal-status + tmux 仍 alive + 超 `staleThresholdHours`（默认 24h）的 session `closeStale`。

但它扫的候选集 `getStaleCompletedSessions`（`StateStore.ts:3418-3420`）SQL 写死：
```
WHERE status IN ('completed', 'failed', 'blocked') AND last_activity_at < datetime('now', '-N hours')
```
**`design_done` 不在其中。** 卡在 `design_done` 的 parked 段（尤其一直没 ship 的慢 issue，如 FLY-545 挂 3 天）**永远扫不到**，无任何兜底。

### 2.4 缺口 C — 即便扫到，`closeStale → closeRunner(design_done)` 会被 eligibility gate 拒

`closeStale`（`plugin.ts:3927-3947`）调 `closeRunner({ forcePreserved: true })`，**但没传 `finalizeDone: true`**。而 `design_done`：
- 不在 `AUTO_CLOSE_STATES`（`close-runner.ts:45-51` = completed/rejected/deferred/shelved/terminated）；
- `forcePreserved` 只对 `CRASH_PRESERVE_STATES`（failed/blocked）生效。

→ 走到 eligibility gate 返回 `status_not_eligible:design_done`（`close-runner.ts:233-250`），**关不掉**。（`completed` 在 AUTO_CLOSE_STATES，所以 completed qa 超 24h 能被这条兜底收——但主路径缺口 A 漏 + 24h 窗口内先残留。）

### 2.5 第二个 bug（close_runner 拒关）的真实情况——与 issue 描述有出入

- **`completed`**：**已在** `AUTO_CLOSE_STATES` 且在 `CLOSE_ELIGIBLE_STATES`（issue_identifier lookup 也含它）。普通 `close_runner` **本来就能关**。issue 说的「completed 不在列」**不准确**（可能看的是旧代码或别的报错）。
- **`design_done`**：普通 `close_runner` **确实拒关**（不在 AUTO_CLOSE / CRASH_PRESERVE，issue_identifier lookup 集合也不含它）。**但** `done=true`（FLY-638 → `finalizeDone`）**技术上已能关它**——因为 `FINALIZE_DONE_SOURCE_STATES` 含 `design_done`（`close-runner.ts:72-77`，FLY-793 加的）。缺的是：`close_runner` MCP tool 的**文档**（`terminal-mcp/src/index.ts:457/489`）只提 running/awaiting_review/approved_to_ship，**没告诉运维 `design_done` 也能用 `done=true`**——运维不知道 → 只能 `kill -9`。

---

## 3. 三类泄漏路径小结

| 僵尸 | 状态 | 为何 alive | 为何不被回收 |
|------|------|-----------|-------------|
| design 段 | `design_done` | keep-alive PARK（故意，FLY-887） | ship 时 finalize 本应关它（filter 含 design ✓），但若 issue 一直没 ship 就永久 parked；兜底 `getStaleCompletedSessions` **漏 design_done**（缺口 B）+ 即便扫到 closeStale **不传 finalizeDone** 关不掉（缺口 C） |
| qa 段 | `completed` | ship executor 完成后进程仍 alive（park / 触发路径漏） | ship 时 `finalizeThreeStagePhases` filter **漏 qa**（缺口 A）；只能靠兜底（completed 在 SQL ✓、closeStale 能关 ✓），但主路径漏 + 24h 窗口内先堆积 |

---

## 4. 核心设计张力：如何区分「健康 parked」vs「泄漏 parked」

这是本 bug 最需要想清楚的一点。

`design_done` / parked 段在一个**还在跑**的 pipeline 里是**正常状态**——一个 issue 从 design 到 ship 可能跨越数天（QA fix-loop、等 founder ship gate）。期间 design + implement 段一直 parked 保活。**不能**简单地「parked 超 N 小时就杀」——那会误杀正在慢慢跑的 issue 的 context holder，破坏 FLY-887 的 keep-alive 语义与 fix-loop wake。

判据应该是 **pipeline 是否已终结 / 该段是否已孤立**，而不是单纯时长：

- **健康 parked**：issue 还活着——有 alive 的下游 phase（`getAlivePhaseSession(issue, implement|qa)`），或 pipeline 最近有活动。→ 留。
- **泄漏 parked**：pipeline 已 ship（有 `post_ship_finalization_claim`，即 `hasShipFinalizationClaim`）却没回收该段；或所有 phase 都已终态/进程死了但该段残留。→ 收。
- 再叠加一个**保守的超长时长阈值**兜底真正卡死、既没 ship 也没明确终态的 orphan（如 FLY-545 挂 3 天）——阈值要足够长（避免误杀慢 pipeline），但有界（避免无限累积）。

> 注：Annie 原话「我们根本没跑多少东西，快去修好」。本质是 keep-alive 的 parked 段生命周期**无界**——7 个并发慢/已 ship issue × ~300MB = ~2GB → OOM。根因修 = ship/终态后必回收（缺口 A/C）+ 卡死/漏网有兜底（缺口 B/C），而**不**牺牲 FLY-887 keep-alive 的正常语义。

---

## 5. 修复方向（初步，待 brainstorm gate 确认）

对应 issue 三个诉求：

**诉求 1 —— 交接/终态后自动收上一段：**
- 不改交接期的 PARK（保 FLY-887）。补 ship 回收链的缺口 A：`finalizeThreeStagePhases` 的 filter **加 qa 段**（`chat_thread_role === "qa"`），并让终态 `completed` 也进入可回收集合（qa 段 completed 后回收）。close 幂等（target=null → alreadyGone），补 qa 安全无副作用。

**诉求 2 —— close_runner 接受 design_done/completed：**
- `completed` 确认已能关（补测 + 文档明确）。
- `design_done`：`done=true` 已能关（`finalizeDone` 覆盖）——**文档化**它（MCP tool 描述 + issue_identifier lookup 让 done-mode 能按 identifier 找到 design_done，见 `lifecycle.ts:94`），让运维不用 `kill -9`。是否要让**普通** close 也直接接受 design_done 存疑（design_done→completed 需 FSM transition，不能裸 kill）——倾向保留 done-mode，只是让它可发现/可达。

**诉求 3 —— 周期兜底清扫：**
- 扩 `getStaleCompletedSessions` SQL 覆盖 `design_done`（+ 现有 completed/failed/blocked）。
- `closeStale` 对 `design_done` 段带 `finalizeDone: true` + `transitionOpts`（否则缺口 C，扫到也关不掉）。
- 兜底判据加上「pipeline 已终结 / 段已孤立」的守卫（§4），避免误杀健康 parked；阈值可复用 `TEAMLEAD_STALE_THRESHOLD_HOURS` 或给 parked-phase 单列。

---

## 6. 待确认 / research 阶段进一步核实的点

1. **completed qa 的精确主路径**：ship 时为什么没被 `postMergeTmuxCleanup(opts.executionId)` 关？—— 需在 research 阶段追 `event-route.ts` / `DirectEventSink` 里 `session_completed → runPostShipFinalization` 的触发条件，确认 QA-driven ship 的触发者到底是不是 QA execId、以及 QA `stage set completed` 后是否 park。（兜底 + finalize-qa 补漏已覆盖，但要确认主路径修得对。）
2. **兜底阈值与守卫**：区分健康/泄漏 parked 的判据（`hasShipFinalizationClaim` / 无 alive 下游 / 超长时长）具体如何组合？阈值多长算安全（不误杀慢 pipeline，又能有界回收）？
3. **byte-compat / kill-switch**：所有改动需保 keep-alive OFF / 非三段式路径不变；扩兜底建议带 env kill-switch（对齐 FLY-867 `FLYWHEEL_STALE_TERMINAL_CLOSE`）。
4. **FLY-887 / FLY-603 关系**：本 bug 来源侧 = FLY-887 keep-alive；FLY-603（worktree 清理没触发）是同类生命周期泄漏——确认两者回收链是否该合并到同一个「pipeline 终结 → 统一回收」收口。

---

## 7. 关联

- **FLY-887**（三段式 keep-alive）——本 bug 的来源侧（parked 语义）。
- **FLY-867**（stale-terminal 兜底关）——已有的周期兜底，需扩到 design_done。
- **FLY-603**（worktree 清理没触发）——同类生命周期泄漏。
- **FLY-517**（容量）、**FLY-793**（三段式 finalizeDone 引入 design_done）。
