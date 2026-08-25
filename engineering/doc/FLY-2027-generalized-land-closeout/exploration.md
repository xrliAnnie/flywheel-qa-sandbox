# FLY-2027 generalized land 收尾链 — 探索

Issue: FLY-2027 (https://linear.app/geoforge3d/issue/FLY-2027/engine收尾-generalized-land-路径缺-fly-369-收尾链ship-后停驻体不收thread-不自动归档8-24-双)
日期: 2026-08-24
基于: 无

---

## 1. Issue 断言 vs 生产账本 —— 逐条对照(审计推翻部分假设)

Issue 断言(依据 8-24 双 ship 实证 FLY-2000 / FLY-2015):

1. implement 体(97bef349 / 7f497306)ship 后滞留 `ship_parked` 未收;
2. issue thread 未自动归档(founder 连问两次,Lead 手动扫);
3. 对照:老 🆒 路径带完整 FLY-369 cascade,generalized land 缺这条链。

**生产账本(`~/.flywheel/teamlead.db` 只读,2026-08-24 UTC)重建的真实时间线:**

### FLY-2000(run `ea76818d`, template `tpl_simple_code`, PR #935)

| 时刻 (UTC) | 事件 |
|---|---|
| 05:57:22 | implement(97bef349, Codex)完成 → 投影 `ship_parked`(等 gate)|
| 07:44:30 | QA pass → founder_gate 开门,卡片建立 |
| **17:12:00** | founder 批准落账(claim 413, `founder_direct_signal`, actor = founder Discord ID)|
| 17:12:36 | PR #935 merged(GitHub `mergedAt` 实测)|
| 17:13:39 | implement 体 `ship_parked → completed`(trigger `fly638_close_runner_done`)= **merge 后 63 秒收体** |
| 17:14:09 | QA 体(f716d1f0)收编 completed |
| 17:14:41 | **thread 1541197904373481502 自动归档(status 200)** |
| 17:14:42 | `post_ship_finalization_completed` + `land_completed` + `run_completed` |

### FLY-2015(run `b11cb238`, template `tpl_simple_code`, PR #937)

| 时刻 (UTC) | 事件 |
|---|---|
| 06:09:55 | implement(7f497306)完成 → `ship_parked` |
| 08:20:31 | QA pass → founder_gate 开门 |
| **17:13:07** | founder 批准落账(claim 414)|
| 17:15:20 | PR #937 merged |
| 17:15:55 | implement 体 + QA 体收编 completed(merge 后 35 秒)|
| 17:16:50 | **thread 1541226848413810719 自动归档(status 200)** |
| 17:16:54 | finalization completed + run_completed |
| 17:24:35 / 17:32:13 | 再归档尝试被 `founder_reopened` 拒绝(founder 在归档后 thread 内发话 → Discord 自动 unarchive → FLY-1709 保护 fail-closed 不再归档)|

### 17:24-17:32 的两轮批量归档 sweep(即 "Lead 手动扫" 的账面痕迹)

- 17:24:34-17:24:36 与 17:32:13-17:32:19,source = `bridge.done-thread-archiver`,批量输出 `already_archived` / `reArchived:true` / `founder_reopened`。
- FLY-2000 thread 在 17:24:34 被 `reArchived`(17:14 首归档后有 bot-only 消息重开过,bot_only → 允许重归档)。
- FLY-2015 thread 两轮都被 `founder_reopened` 拒绝——**founder 归档后在 thread 里发话(时间落在 17:16:50-17:24:35 与 17:24:35-17:32:13 两个窗口,与"连问两次"吻合)**。

### 当前终态(审计时刻 2026-08-24 ~17:40 UTC)

- 两单全部 session `completed` + `terminal_at` 已落;宿主 tmux 无 FLY-2000/FLY-2015 残留窗。
- `chat_threads` 账面均 archived;FLY-2015 thread 的 Discord 实况因 founder 发话重开后受 FLY-1709 保护,不再自动归档(**这是 issue 验收②明确要求保留的语义**)。

### 对照结论

| Issue 断言 | 账本证据 | 判定 |
|---|---|---|
| ① implement 体滞留 ship_parked 未收 | merge 后 63s / 35s 内 `ship_parked → completed`,进程 reap + tmux 收窗有收据 | **不成立**(除非观察恰落在分钟级执行窗口内)|
| ② thread 未自动归档 | 两 thread 均自动归档 200;FLY-2015 归档后被 founder 发话重开,此后按 FLY-1709 保护不归档 | **表象成立、机制不同**——不是"缺链",是 founder_reopened 保护的设计行为 |
| ③ generalized land 缺 FLY-369 cascade | land 走 `runResumablePostShipFinalization`,与老 🆒 路径**同一个** `runPostShipFinalizationInner` 编排器 | **不成立**(对 tpl_simple_code / implement producer 而言)|

> 佐证细节:两单 land 各有一次 `land_partial`(`issue_closeout_incomplete:cause=unknown` / `mergeability` / `ship_workflow_pending`),由 FLY-1770 resumable retry 在 ~30-90 秒内补完——自愈机制在工作,但 `cause=unknown` 暴露诊断信息缺失。

## 2. 代码审计:generalized land 与老 🆒 路径的真实关系

三路并行审计(land 执行路径 / 老 🆒 FLY-369 cascade / ship_parked 机制)的关键结论:

### 2.1 两条路共用同一个收尾编排器

`packages/teamlead/src/bridge/post-ship-finalization.ts` `runPostShipFinalizationInner`(:668)是唯一收尾 DAG:

- 老 🆒 路径:runner 自 ship → `session_completed` → `DirectEventSink`/`event-route` → `runPostShipFinalization`(resumable=false)。
- engine land 路径:`land-executor.ts:1822 deps.finalize` → `runResumablePostShipFinalization`(resumable=true, landManaged=true),加了 FLY-1770 退避重试与 step receipt。

步骤(简化):husk 强收(1a, 仅 landManaged)→ 收 land 源 session tmux(1)→ 收停驻 phase 体 design/implement/qa(1.25, `RECLAIMABLE_PHASE_STATUSES` 含 `ship_parked`)→ display 终态(1.3)→ issue closeout 全量兜底(1.7)→ worktree/remote 分支清理(1.8)→ ready-to-close 通知(2)→ land terminal 消息(2.5)→ **thread 归档(3)** → **Linear Done(3.5, 三态 disposition, 失败不阻塞)** → run_completed 时 `settleReworkParksForRunTx` 清 park 账。

### 2.2 真正的结构性缺口:generic 节点(非 implement)的收体覆盖薄一层

这是审计发现的**代码层真实缺口**(与 8-24 实证无关——那两单是 implement producer):

| 缺口 | 位置 | 后果 |
|---|---|---|
| G1: `ship_parked` 只投影给 `implement` 节点 | `StateStore.ts:33277 projectGeneralizedCompletionTx`(`node?.type === "implement"` 硬条件) | generic/prd/design/prototype 的 producer 节点完成即 `completed`,founder gate kickback 时**无停驻活体可返工** |
| G2: generic 体 `chat_thread_role='main'`,逃过 phase 收编 | `workflow-engine-dispatcher.ts:2732`(`isWorkflowPhaseRole` 只认 design/implement/qa)→ `getPhaseSessionsForIssue` WHERE role IN ('design','implement','qa') | step 1.25 `finalizeWorkflowPhaseRoles` 与 FLY-1992 `forceShippedHusks` **都收不到 generic 体**;只剩 step 1(依赖 `resolveLandSourceSession` 选对体)+ step 1.7 issueCloseout 兜底 |
| G3: `land_partial` 的 `cause=unknown` | `land-closeout-cause.ts` 11 种 typed cause 未覆盖当日失败形态 | 诊断信息缺失,复盘只能靠猜 |

### 2.3 founder_reopened 后的"永不归档"死角(设计语义,非 bug)

`done-thread-archiver.ts`:归档 epoch 后存在任何非 bot 作者消息 → `founder_reopened` → 不归档且算"义务已结算"。founder 的消息不会消失 ⇒ 该 thread 永远不会再自动归档,唯一出口是 Lead 手动归档端点或后续新 run 复活再走完整生命周期。豁免时会发一条说明消息("原因解除后会由清理流程重试")——**但"原因"事实上不可解除,这句话对 founder 是误导**。

## 3. 待 Lead 澄清的事实缺口

已用非阻塞 `ask` 上报(证据并排,不替 Lead 下结论):

1. founder "连问两次" 的原文与位置(FLY-2015 thread?问的是归档还是别的)。
2. "滞留 ship_parked" 的观察时刻与观察面(账本?cmux 侧栏?若是 17:12-17:16 窗口内的观察则与账本相容)。
3. 断言被推翻后,本单 scope 是否转向:收敛 §2.2 的 G1/G2/G3 + §2.3 的说明消息诚实化。

## 4. 设计方向候选(供 research/plan 收敛)

- **方向 A(推荐):按审计后的真实缺口收敛** —— G1(generic 节点纳入 ship_parked/park 语义或显式声明不 park 并保证 kickback 路径可用)、G2(收体覆盖补齐:land closeout 对 generic producer 的显式收编 + husk 强收纳管)、G3(closeout cause 枚举补齐)、§2.3 豁免消息诚实化。老 🆒 路径零改动(验收③)。
- **方向 B:按 issue 字面做"补链"** —— 审计证明链已存在且工作,字面照做会是空转;不推荐。
- **方向 C:仅可见性** —— 只修 founder 可见性(豁免说明、land 进度消息),不动收体。覆盖不了 G1/G2 的真实缺口;作为 A 的子集存在。

## 5. 边界(本单不做)

- 不动 FLY-1709 founder_reopened 保护语义(验收②要求保留)。
- 不动老 🆒 路径行为(验收③,字节兼容)。
- FLY-1770 retry 预算跨 epoch 收敛归 FLY-1940,不在本单。
