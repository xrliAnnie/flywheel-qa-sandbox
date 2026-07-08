# FLY-978 完成后清理下线逻辑 / 解耦重启 — 探索(current-state 现状调研)

Issue: FLY-978 (https://linear.app/geoforge3d/issue/FLY-978/infrareliability-完成后的清理下线逻辑-解耦重启done-merge-清-runnerworktree)
日期: 2026-07-07
基于: 无(本 issue 是 FLY-964 正确性讨论派生的头号根治)

> 说明:本文是**现状代码调研**(我的功课),不是 PRD 正文。目的是让和 Annie 的
> 共创基于真实代码事实,而不是凭空设计。PRD 收敛在同文件夹 `prd.md`。

---

## 1. Annie 的诊断(原话摘要)

现有理论链路:一件事做完 → runner save 改动 → 清 local worktree + runner → 最后 archive
thread。**但中间耦合了一个『重启』步骤。** 我们又很少为一个小改动就重启整个系统 → 这条
级联经常走不完 → 最后往往变成 Lead 手动 merge + 手动让 runner 下线。后果:① session 桩
还挂着 → 显示成还在跑(ghost,FLY-970);② thread 没归档 → 越堆越多。

**这个诊断经代码核对——非常准。** 下面把"重启耦合"落到具体代码。

---

## 2. 现状:清理下线其实有三条路,可靠性递减

### 路 A — inline 级联(事件驱动,不需要重启)✅ 最可靠,但触发条件苛刻

`bridge/post-ship-finalization.ts:runPostShipFinalization` 是唯一的串行化收尾编排:

1. (0) 原子 claim(`post-ship-finalization-<execId>` UNIQUE 去重,DES / event-route 双路只有一个赢家)
2. (0.5) `markIssueDone` → Linear 翻 Done(bounded 15s)
3. (1) `postMergeTmuxCleanup` → 关 runner tmux + Terminal viewer tab + 删 CommDB session 行(`post-merge.ts`)
4. (1.25) `finalizeThreeStagePhases` → 关 parked design/implement phase
5. (1.3) `refreshIssueDisplay` → 刷终态显示(标题 ✅、状态行 done/done/done)
6. (1.5) **`removeCleanWorktree`** → 清 worktree(FLY-603)
7. (2) `emitRunnerReadyToCloseNotification` → 发「🏁 完工可关闭」
8. (3) **thread archive**(`archiveChatThread` + `markChatThreadArchived`)

**触发门槛:** 由 `isPostApproveShipComplete()` 把关,**硬要求 `landingStatus.status === "merged"`**
且 `shipEligible !== false`。走 `session_completed` 事件(`DirectEventSink.emitCompleted` /
`event-route.ts` postApproveShip 分支)。

→ **只要 runner 走完整 self-ship(:cool: → deploy workflow merge → 重写 land-status.json=merged
→ session_completed),这条 inline 级联全自动、不需要任何重启。** 这是设计上的 happy path。

### 路 B — external-merge 收敛 sweeper(periodic,被限流)⚠️ 慢

`bridge/external-merge-reconcile.ts`(FLY-945 Fix D)。**当 PR 在 runner self-ship 之外被
merge(人 / Lead 手动 `gh pr merge`),session_completed 合并证据链根本不发,inline 级联不触发**,
就靠这个 sweeper 补。它自己的 header 原话:

> "the completion event chain … never fires and **the founder ends up manually asking for
> the archive**."

—— **这就是 Annie 的困扰本身,写在注释里。** 它的问题不是不存在,而是**慢且被限流**:
- 跑在 GatePoller patrol cadence 上;
- budget:每 project 每 pass 最多 3 个 `gh pr view`,rotating;
- TTL 门:parked 要 idle > 30min 才 check;completed 只看 7 天窗口内;
- 只认 `state==="merged"`,还要过 ship-eligibility / head-match / trusted-approval 校验。

### 路 C — boot-only sweeps 家族(**只在 Bridge 重启时跑**)❌ 这就是"重启耦合"

`plugin.ts` boot 段一次性 sweep,**只在 Bridge 启动那一刻执行**,平时不跑:
- `plugin.ts:3476` FLY-172 boot marker drain — replay runner 留下的 complete-failed marker
- `plugin.ts:3495` FLY-892 boot sweep — 清 legacy per-phase thread
- `plugin.ts:3512` **FLY-324 boot sweep — 清 "done-but-running" ghost**(见 §3)
- `plugin.ts:3547` FLY-754 boot sweep — 杀泄漏的 `viewer-<execId>` tmux
- `plugin.ts:3638` FLY-638 boot prune — 清 stale CommDB session 行

**这些泄漏回收都绑在 Bridge boot。** 由于"小改动很少重启整个系统"(合理),这些 boot sweep
很少跑 → 泄漏就一直攒着。**FLY-978 要解耦的"重启",精确来说就是这一层 boot-only 回收。**

### 2.5 "重启"到底是什么 + 一个反直觉的杀手

- Bridge = launchd 常驻 daemon(`com.flywheel.bridge.plist`,`KeepAlive=true`)。重启触发:
  post-merge deploy 调 `scripts/restart-services.sh`、self-ship updater 队列、每天两次
  sweep、crash 后 KeepAlive 重生、手动 kickstart。重启**不 git pull**(deploy 脚本才 pull)。
- `restart-services.sh` 按 diff 分类:改到 `packages/teamlead|core|edge-worker|flywheel-comm`
  等才重启 Bridge;docs/tests/`.claude` 只推进 sha 不重启。→ **几乎每个 merged flywheel 代码
  PR 都会重启一次 Bridge**;但**普通项目 / 文档 / 小改动的 merge 不会**——这正是"很少为小改动
  重启"的技术底座。
- **反直觉的杀手(current-state 真实失败模式):** deploy 的 idle-wait 轮询 `/health`
  `sessions_count` 到 0 才停机,但 `session_completed` 一到就把 session 移出 active 集
  (count→0),而 `runPostShipFinalization` 是 fire-and-forget **还在飞**;idle-wait
  **5 分钟超时会强制重启**。于是**由 merge 触发的那次重启,反而可能打断正在收尾的清理级联**。
  更糟:收尾的**原子 claim 行(`post-ship-finalization-<execId>` UNIQUE)可能已经插进去了**
  → 重启后 marker replay 撞 claim 被丢弃 → **级联永不重跑 → 永久 ghost 桩 + 活 thread,
  现有任何 reconciler 都治不了**(见 §3 场景 3)。这说明"重启耦合"不止是"慢",在最坏情况下
  是"重启主动杀掉清理"。

### 2.6 全景:清理跑在哪些"钟"上 + 一句话结论

系统里没有 cron,所有回收挂在这几个钟上:Bridge boot(每次重启一次)· HeartbeatService
tick(5 min)· GatePoller patrol(≈60s,但被 budget/TTL 限流)· Chrome reaper(60s)·
RunnerIdleWatchdog(≈1h)· 事件触发(closeRunner / `/events` / 409)。共 ~18 个 catcher。

**一句话结论(catcher 全量盘点后):四大类资源 —— Terminal tab · viewer tmux session ·
worktree · CommDB 桩 —— 实际上只有靠 Bridge 重启才被回收。** 其中 **worktree cleanup 是
最依赖重启的一facet**(inline 只在 post-ship-finalization + 正向 tmux close 后跑;其它任何
退出路径都落到 boot-only 的 Layer B / pruneOrphans)。且**一个没发事件就死掉的 runner,
根本没有 inline 翻 status 的路 —— 100% 靠 catcher。** 这就是 Annie 说的"清不干净"的代码全貌。

### 2.7 关键不对称:Flywheel-core vs 普通项目(直接对上 Annie 的两档)

- **Flywheel-core(自托管):deploy == restart。** self-ship 走完 :cool: merge 后,`/spin`
  post-merge 直接排一次 Bridge 重启(FLY-20"merge 后自动重启 Bridge+Lead")。于是**由这次 merge
  触发的重启,会 race/打断它本该触发的 finalization**——`restart-services.sh` 注释自己承认那 2 次
  0-sample 只是"stabilization window, NOT a completion barrier"。agent 三方核对结论:**"清理在重启
  之后才完成"是结构性的,不是偶发。**
- **普通项目:merge 不重启 Bridge。** 所以 inline 级联**能**跑完——**前提是**那次 merge 产出了干净
  的 `session_completed(merged 证据)`(= 完整 self-ship)。一旦是手动/external merge 或 evidence-gap,
  就落到限流 sweeper / boot-only catcher,照样漏。
- → Annie 的两档 restart cadence(普通≤每天一次 / core 更频繁)本质是:**把 deploy 从"merge 事件"
  上摘下来,变成独立定时的事**;而清理级联要做成**跨重启也不丢**(durable/resumable),这样无论重启
  何时发生,都不会吃掉清理。

### 2.8 一处 premise 纠偏(三方核对)

- `actions.ts _onApproved` post-merge 回调是 **dead code**;而"按 Linear 翻 Done 就自动归档"当年被
  **故意否掉**(会误归档还在讨论的 Done issue)。→ **archive 的触发只有 close / ship 两条**,这条护栏
  在设计新方案时不能破(呼应 FLY-962)。

---

## 3. Ghost(FLY-970 那种)的精确机制

`bridge/done-running-reconciler.ts`(FLY-324)注释写得很清楚:

- no-PR / no-code / QA runner 只用 `flywheel-comm stage set completed` 收尾 → 只发 `stage_changed`
  事件 → 只更新 `session_stage`,**从不把 FSM `status` 翻出 `running`**。
- 非-merge 完成的 status 翻转**只走 `session_completed`**(由 `flywheel-comm complete --route` 发),
  而 QA / generic runner **从不调** `complete`。
- 结果:runner 永远卡在 `status=running` → `close_runner` 拒它(`status_not_eligible:running`)→
  **"its tmux session + git worktree linger until the next Bridge restart"**(注释原文)→ idle
  watchdog 还误报 `session_stuck` 刷 Lead。

现有修法两个面:① `event-route` 的 `stage_changed` live handler(往后修);② FLY-324 **boot sweep**
(清存量)。**但 boot sweep 又是路 C —— 依赖重启。** ghost 的根因和清理泄漏是同一个病:关键的
翻转/回收动作绑在了重启时刻,而不是完成时刻 inline 补上。

### 3.1 关键:有**两个** "running" 注册表,都要翻,还会分叉

1. **Bridge StateStore `sessions`** —— FSM `status` 列(`applyTransition` / `WORKFLOW_TRANSITIONS`)。
2. **每 project 的 CommDB `sessions`** —— tmux 桩。schema `status IN ('running','completed','timeout')`
   ——**表达不了 terminated/failed/blocked**,唯一消失方式是 `deleteSession`。**`runner_terminal_list` /
   Lead bootstrap 渲染的就是这张表 —— Annie 眼里"还在跑"的桩就是它。** 二者可以分叉(FSM 已 terminal
   但 CommDB 桩还 running)。

### 3.2 ghost 的 6 种成因(current-state,给 PRD problem/拆分用)

1. **完成时无 merge 证据** —— runner 完成时 `landingStatus` 还是 `ready_to_merge`/缺失 → 映射成
   `completed` 但打 `evidenceGap=true`,**故意抑制 finalization**。唯一活的 heal 是 external-merge
   Path 2,还要求 founder 归属的结构化批准 + `pr_head_sha` 精确匹配 —— 其它一切**永不 heal**。
2. **runner 在 merge 与 session_completed 之间死掉** —— 卡 awaiting_review/approved_to_ship;只有
   限流 sweeper + re-wake 兜;证不出 ship-eligibility 就**永久 park**。
3. **重启 race 掉 finalization**(§2.5 的杀手)—— claim 已插 → replay 被丢 → **永久 ghost,无 reconciler 治**。
4. **CommDB 桩比 FSM 活得久** —— FSM 到 failed/blocked 故意留 CommDB 做取证,其余清理是 FLY-817/638
   **boot-only** → `alive=false status=running` 僵尸显示到下次 deploy。
5. **`stage set completed` 没跟 `complete --route`**(QA/no-code)—— FLY-324 live handler 现在covers,
   但 stage 事件真到 Bridge 才行;漏了又等 boot sweep。
6. **thread archive 失败是"终态但沉默"** —— 记 `chat_thread_archive_failed` 事件后**没有任何重试**;
   非-ship 归档只从 `closeRunner` 触发,ghost 情形下 runner 从没被显式 close → thread 永不归档。

**净诊断:** 系统只有一条**事务性**下线路径(`runPostShipFinalization`,硬 gate 在 merge 证据),
外加一堆 **boot-time** sweep 兜底。凡是漏过那道 gate 的(证据缺口 / 无 founder 归属绑定的 external
merge / 被 deploy 重启打断的 finalization)都会把 CommDB 桩留在 running、thread 不归档,直到下次
重启;其中 3、1(非精确头)两类**没有任何现有 reconciler 能治**。

---

## 4. 边界事实(设计时要尊重的现有合同)

- **merge 是 founder-gated 的**(founder-only-authority + approve_to_ship ship gate;`verify-approval`)。
  FLY-978 的"自动 merge"**不是**要绕过这个 gate——见 §5。
- **archive 只在真 wrap-up + 无其它 active runner 时发**(`done-thread-archiver.ts`
  `archiveIssueThreadIfNoOtherActive`:status 在 allow 集 + 该 issue 没有别的
  running/awaiting_review/approved_to_ship runner)。这是防"Done 了但还在讨论就误归档"
  (FLY-962 关注点)的护栏,不能拆。
- `post-merge.ts` 注释明确:worktree remove / docs archive 当年被划出 Bridge 职责
  ("NOT here … stay with Runner/Orchestrator, future: executor lifecycle contract")。
  FLY-603 后 worktree cleanup 又被 closure 接回 inline 级联——**这条缝就是"清理该由谁、
  何时做"一直没彻底收口的历史根源。**

---

## 5. "自动 merge" 的真实含义(共创要先对齐的关键)

Annie 文本里有一处表面张力:"done → **自动 merge** to main" 却又 "merge/ship **仍 founder-gated**"。
核对上下文,她紧接着写:"『自动 merge』要尊重现有 ship gate … **但一旦 merge 落地,清理 + 归档
就该自动补上、不等重启**"。

→ 我的理解(待 Round 1 与 Annie 确认):**merge 动作本身不变,仍走 founder gate。真正要"自动"的
是 post-merge 的清理+归档——让它对所有 merge 路径(self-ship / Lead 手动 / external)都 inline
可靠补上,而不是绑在重启/boot-sweep/被限流的 sweeper 上。** 换句话说:病不在 merge 门,在 merge
之后那段级联的触发时机。

---

## 6. 设计空间(留给 PRD 逐块收敛,不在本文拍板)

- **A. 清理级联解耦 restart:** 把路 C 的 boot-only 回收改成完成/merge 时刻 inline 触发;路 B 从
  "被限流的 backstop"升级成"及时、覆盖所有 merge 路径"的一等触发。核心子问题:**Bridge 如何及时
  知道一个 merge 发生了**(尤其 Lead 手动 merge / external),而不用等 boot 或等限流 sweeper 轮到。
- **B. Ghost 根除:** 所有完成形态(含 no-PR/QA)都能可靠把 status 翻出 running,不等 boot sweep。
- **C. 重启 = 独立定时事:** 普通项目 ≤ 每天一次;Flywheel-core 更频繁。trigger 是什么、要不要 gate、
  和 founder-only-authority 的关系。
- **D. 可靠性度量:** 什么算一次 leak,如何证明 zero-leak(observability / 审计事件已有大量 `insertEvent`
  可利用)。
- **E. 误归档护栏(FLY-962,次要):** 保 no-other-active 护栏,确认"真 wrap-up 才归档"。

---

## 7. 关联 issue 一族(FLY-978 是根治)

FLY-970(ghost 手动清)· FLY-975(idle-health 盲区)· FLY-638(finalize DONE-but-stuck)·
FLY-369(close→archive cascade)· FLY-942(watchdog 检测残留)· FLY-962(误归档,次要)。
FLY-978 若把"完成时刻 inline 收口"做对,前述几条的病根会被一并端掉——这也是它被定为 FLY-964
状态显示正确性**头号根治**的原因。PM 验收 = 未来 FLY-830。
