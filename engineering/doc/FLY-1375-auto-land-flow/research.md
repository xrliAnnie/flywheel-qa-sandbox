# FLY-1375 Ship 后全自动收尾 — land 流程 — 调研

Issue: FLY-1375 (https://linear.app/geoforge3d/issue/FLY-1375/ship-自动化-founder-说-ship-后全自动收尾-land-流程cool-merge-清-worktree-关全部)
日期: 2026-07-21
基于: exploration.md

> 调研方法:4 路并行 codebase 探查(:cool: 级联链路 / session 关闭资格 / worktree 清理 / DAG 模板机制)+ 深诊页提取。本文按主题汇总,全部 file:line 以 worktree `/Users/xiaorongli/Dev/flywheel-FLY-1375`(branch `flywheel-FLY-1375`,base = main@5196c8cd)为准。

## 1. worktree 清理现状(断点③)

### 1.1 创建侧(路径/分支/授权约定)

- 原语:`WorktreeManager.create()` — `packages/edge-worker/src/WorktreeManager.ts:199-275`;由 `Blueprint` 调用(`packages/edge-worker/src/Blueprint.ts:1123-1247`),`DagDispatcher` 持有实例。
- 路径约定:`worktreeName()` = `<repoSlug>-<issueId>`(`WorktreeManager.ts:170-172`);目录 = main repo 兄弟目录(`:179-189`)。分支名与目录 basename 同名(`:206`),startPoint 默认 `origin/main`。
- 角色感知命名:`deriveWorktreeKey(identifier, sessionRole)`(`:80-88`)— main 角色 = `identifier`,其它 = `${identifier}-${role}`;三阶段共享分支走 `resolveWorktreeKey(..., {shareParentBranch})`(`:106-112`)。**create 与 cleanup 共用同一命名源,防漂移。**
- FLY-1185 删除授权:create 时写一次性 nonce `flywheel.generation`(git ADMIN 区,`:257-264`)→ StateStore `bindWorktreeOnce`(set-once,`StateStore.ts:11358-11403`);四路一致(path/branch/generation/binding)才算 owned:`classifyWorktreePath()`(`WorktreeManager.ts:656-682`)。

### 1.2 merge 后清理(FLY-603 Layer A)— 代码在、已接线、默认开,但触发器绑错对象

- 清理闭包:`makeWorktreeCleanup()` — `packages/teamlead/src/bridge/worktree-cleanup.ts:132-372`;生产装配 `makeBridgeWorktreeCleanup()`(`:380-397`)。删除契约:tmux 正向确认关闭 + 树干净 + 路径/分支/binding 校验通过,才 dirty-safe `git worktree remove`(**无 --force**)。
- 调用点:`runPostShipFinalization()` step (1.5) `deps.removeCleanWorktree(...)` — `packages/teamlead/src/bridge/post-ship-finalization.ts:565-606`。
- **触发门:`isPostApproveShipComplete()`(`post-ship-finalization.ts:68-99`)强制要求 `args.landingStatus?.status === "merged"`(`:92`)**,否则整个 post-ship(含 worktree 清理)不跑。三个进程内竞争者都走这道门:
  - `DirectEventSink.emitCompleted`(`packages/teamlead/src/DirectEventSink.ts:1033-1086`)
  - `event-route.ts`(HTTP `/events`,`:1223/1292/1317`)
  - `merge-ship-gate.ts:527`(🆒 recovered-merge 路径)、`external-merge-reconcile.ts:66`(外部合并兜底)
- **未触发根因**:这条链要求 **Runner 自己完成 merge + 把 `land-status.json` 改写为 `status:"merged"` + 带证据干净自退(session_completed)**。Annie 的 :cool: 批准 ≠ 系统事件;Runner 没 merge / 没回传 / 没自退,step (1.5) 永不执行。即便进入闭包,还有多道 fail-closed SKIP(`tmux_not_confirmed_closed` `:158-164`、`path_mismatch`、`branch_mismatch`、`binding_mismatch`、`dirty`/`clean_unknown` `:289-301`)任一不确定即保留。
- FLY-603 无专属 doc 目录,设计在代码注释里;`product/doc/FLY-978-decouple-cleanup-restart/exploration.md:34,180` 指出「FLY-603 后 worktree cleanup 又被 closure 接回 inline 级联」。

### 1.3 FLY-1185(授权化 + 兜底扫描 + 脏树隔离)

- Boot reconciler:`bridge/worktree-reconciler.ts` `reconcileMergedWorktrees()`(`:196-316`)/ `reconcileProjectWorktrees()`(`:398-472`)— 8 道 fail-closed 关卡(live、dirty、open-PR、merged 证据等)。
- lifecycle sweep v2(issue 级):`bridge/lifecycle-sweep.ts` `sweepProjectLifecycle()` — 分类 `clean_merged / qa_ephemeral / dirty_aged / stable_abandoned`,3 天稳定期 + gh 证据。
- 脏树隔离:`bridge/worktree-quarantine.ts` `quarantineWorktree()` + `restoreSmoke()`(`:175-585`)— 归档 + 复原冒烟通过后才许 `removeWorktreeForce()`(= `git worktree remove --force`,`WorktreeManager.ts:689-708`)。
- 远端/本地分支 CAS 删除:`bridge/branch-cleanup.ts` `casDeleteLocalBranch`(attested-sha CAS,防删并发移动后的 tip),Layer A 在 `worktree-cleanup.ts:320-332` 消费。
- issue 级 closeout:`bridge/lifecycle-closeout.ts` `closeoutIssue()` + `collectIssueCloseoutNodes()`(`:136-149`,收集 phases + auto-QA children + launch claims)。
- 触发:事件驱动(post-ship step (4) `postShipSweep`,`post-ship-finalization.ts:753-762`,装配 `plugin.ts:4698-4712, 4848`)+ 周期(heartbeat 每 ~6h,`plugin.ts:5857-5865`)+ boot 兜底(`run-infra.ts:719-753`)。
- 总开关:`worktree_autoclean` **default_on**(`packages/config/src/feature-flags/registry.ts:1676-1693`,env `FLYWHEEL_WORKTREE_AUTOCLEAN=0` 才关);入口 gate `worktreeAutocleanEnabled()`(`worktree-cleanup.ts:63-65`)。
- 注意:FLY-1185 `progress.md:18` 自记「post-deploy 全自动单事件链确认仍是 post-merge 独立 QA 项」— flag 默认开但那条链生产是否真跑通当时未验证(正是本单要坐实的)。

### 1.4 FLY-99 pre-create 防护(「烂 worktree 咬后人」的 reactive 兜底)

- `WorktreeManager.removeIfExists()`(`:382-464`):已注册 → `removeUnlocked`(rename+prune+bg rm);孤儿目录 → awaited `fs.promises.rm`(`:410-421`);无条件 `git worktree prune` 清 admin entry(`:423-442`,含 symlink 路径不匹配根因注释);`git branch -D` 删陈旧分支(`:444-463`)。create 用 `-B`(reset-or-create)防「already exists」(`:222-241`)。调用点 `Blueprint.ts:1225`,新 Runner create 之前。
- 定位:**reactive** — 只在同 issue/分支下一个 Runner 起来时触发。它保证验收③(land 后同分支新 runner 干净起)的最后防线,但不是「merge 后主动删」。land 主删 + FLY-99 兜底,互补。

### 1.5 「烂 worktree」场景全集与分档清理原语

场景:dirty tree(`gitWorktreeClean()` `worktree-cleanup.ts:42-59`,探测失败 = "unknown" = fail-closed)、stale branch、`.git/worktrees/<name>` admin 残留、孤儿目录、symlink 路径不匹配(`canonicalizeWorktreePath()` `WorktreeManager.ts:725-749`)。

清理分档:干净删 `removeCleanWorktreeByPath()`(= `git worktree remove` 无 force + `branch -D`,`WorktreeManager.ts:576-625`);脏树删 = quarantine + restoreSmoke 通过 → `removeWorktreeForce()`;rerun 场景 `removeUnlocked()`(`:319-356`);分支 CAS 删 `casDeleteLocalBranch`。

### 1.6 issue↔worktree/session 映射(land 定位数据通路)

- `sessions` 表(`packages/teamlead/src/StateStore.ts`):`worktree_path`(schema `:1330`,由 `emitWorktreeReady`/`bindWorktreeOnce` 落库,`DirectEventSink.ts:383-450`)、`branch`、`session_role`、`worktree_binding_*` 列组(`:1685-1688`)、`session_params` JSON(`:628/736/1391`)。
- 定位链(现有 Layer A,`worktree-cleanup.ts:172-195`):优先 `session.worktree_path` → 缺失用 `deriveWorktreeKey` + `expectedWorktree` 反推 → `parseWorktreeKeyFromPath` 守卫 + `getRegisteredWorktree` 拿 git 真实注册。
- 按 issue 聚合 session 的现成查询:`getPhaseSessionsForIssue()`(`StateStore.ts:4015`)、`getSessionsForIssueAliases()`(`:6942`)、`listWorktreeProtectionSessions()`(`:4238`)、`collectIssueCloseoutNodes()`(`lifecycle-closeout.ts:136-149`)。
- **「按 issue 一键关全部 session」原语不存在**(全仓 grep 无 `closeAllSessions*` / `runLandFlow`);最接近雏形 = `finalizeThreeStagePhases`(`post-ship-finalization.ts:335-406`,关某 issue 三阶段 parked session),但同样挂在 merge-evidence 触发链下。

### 1.7 小结(对设计的输入)

原语层(create/removeCleanWorktreeByPath/removeWorktreeForce/quarantine、binding、issue 聚合查询)**已就绪**;缺的是 (a) 把扳机从「Runner 自己 merge 并回传证据」搬到「引擎观察到 🆒 merge 成功」,(b) close-all-sessions-of-issue 编排。land 节点应**复用** `runPostShipFinalization` 的既有 steps 而非另起一套,核心改动是给它一个可靠的、引擎侧的触发事件源。

## 2. :cool: sanctioned merge 与级联链路(断点①)

### 2.1 关键澄清:代码里有两个不同的「:cool:」

**(a) Discord founder 批准 reaction — 实际用 ✅,不是 🆒。**
- `packages/teamlead/src/lead-backends/codex/gateway/founder-confirmation.ts:22` `FOUNDER_CONFIRM_EMOJI = "✅"`;`bridge/approval-signal/reaction-approval-source.ts:11` 注释明确「✅ only — 🆒 is not used (Annie)」。
- 入口:`founder-reaction-approval-handler.ts:84` `tryFounderReactionApproval`,由 gate-poller 每 tick 对 pending `approve_to_ship` gate 主动扫(`gate-poller.ts:1168/:3701`;挂载 `plugin.ts:6374/:7263`)。durable 绑定 `(questionId, prHeadSha)→gateMessageId`(`gate-message-binding.ts:19`,写一次不可变),检到 ✅ → 写 `{"approved":true}` → FSM 翻 `approved_to_ship`。

**(b) GitHub PR 评论 `:cool:` — 真正的 merge 扳机,由 Runner 代发。**
- `.github/workflows/ship-on-comment.yml:25`:`on: issue_comment`,body 恰为 `:cool:` 时触发。
- 发评论的是 **Runner**:`Blueprint.ts:2224` ship 步骤 e `gh pr comment <NUMBER> --body ":cool:"`;`Blueprint.ts:2226`「:cool: deploy workflow 是唯一 merge 路径,Runner 绝不可自己 gh pr merge(FLY-248)」。

心智模型:founder 在 Discord ✅/文字批准 → gate 翻 `approved_to_ship` → Runner 醒来跑 `verify-approval` → **Runner 代发 :cool: PR 评论** → GitHub Actions 做 CI gate + merge。

### 2.2 verify-approval(六轴 fail-closed)

- `packages/flywheel-comm/src/commands/verify-approval.ts` — `verifyApproval()`(`:265`)/ `verifyApprovalWithBridgeHead()`(`:136`,Bridge `/api/workflow/head-authority` 权威 head)。
- 绑定 `pr_head_sha`:第④轴(`:466-490`)要求 `session.pr_head_sha === git rev-parse HEAD`(全 40-hex),stale/缺失/歧义一律 fail-closed。
- 六轴(`:284-541`):① StateStore 行 + `review_question_id` 绑定;② CommDB gate 归属;③ 结构化 `{approved:true}`;③.5 founder 归属(`:444`,防 Lead 自批);④ 状态 + head 匹配;⑤ FLY-827 Codex code-review 硬闸(`:496`);⑥ FLY-1314 CI green 现场复探(`:510-541`)。
- 调用者:Runner CLI(`Blueprint.ts:2216` 步骤 d)。故意本地读、不做 Bridge 往返。

### 2.3 ship-on-comment.yml(merge 侧)

`:cool:` 评论触发后同 job 串行:权限 gate(`:34-54`,仅 write/admin)→ PR 状态校验(`:62-83`)→ **CI green gate**(Build/Typecheck/Lint/Test,`:119-129`)→ `pulls.merge` squash、sha 钉 head_sha(`:143-151`)→ PR 评论播报 `✅ CI green — PR merged to main!`(`:152-157`;**GitHub 评论,非 Discord;无 merge→Discord 广播钩子**)→ best-effort 删远端分支(`:159-164`)。

### 2.4 Bridge 侧级联(runPostShipFinalization)— 不是 merge webhook 驱动

- 唯一入口 `post-ship-finalization.ts:422`,由 **Runner 的 `session_completed`(landingStatus="merged")** 驱动。触发点:`DirectEventSink.ts:1052`、`event-route.ts:1711`/`:2167`、`merge-ship-gate.ts:527`、`external-merge-reconcile.ts:425`(兜底)。
- 级联步骤(`runPostShipFinalizationInner`,`:438` 起,全程 per-issue mutex):tmux 清理 → 三段式 parked phase 关闭 → issue-display 刷新 → worktree 清理(FLY-603,step 1.5)→ 远程分支删 → issue closeout → 🏁 ready-to-close 通知 → thread archive(`:702`)→ Linear Done(`:726`)→ 尾部 sweep(step 4)。
- **Runner 必须在 poll 到 PR MERGED 后把 `land-status.json` 改写为 `"merged"` 再 `stage set completed`(`Blueprint.ts:2233` 附近)— 整条链的脆弱耦合点。**

### 2.5 Linear Done(FLY-799,自动)

- `bridge/linear-issue-finalizer.ts`:`markLinearIssueDone()`(`:55`)找 team 的 `type==="completed"` state 并 `updateIssue`;调用点 `post-ship-finalization.ts:726`(级联最后一步),15s 超时、best-effort、`closeoutBlocked` 时跳过。kill-switch `FLYWHEEL_AUTO_LINEAR_DONE=0`(`:126`);fresh-state guard:`canceled` 绝不覆盖成 Done(`:73/:95`)。

### 2.6 thread archive(单一 sink,三条触发路)

- sink:`done-thread-archiver.ts:97` `archiveThreadAndRecord`(per-thread 串行锁 + archive-once 幂等)。
- 触发路:① ship 级联(`post-ship-finalization.ts:702`);② close 事件(FLY-369,`done-thread-archiver.ts:361` `maybeArchiveThreadOnClose`,从 closeRunner 收口,门槛 completed + 无其他 active runner `:275`);③ reconcile 兜底(FLY-1165,`done-thread-reconcile.ts`,boot+周期,双闸 + triple-veto,scheduler `plugin.ts:5970`)。

### 2.7 断点①的实证与「1338 范式」

- `external-merge-reconcile.ts` 文件头原话:PR 在 Runner 自助路径之外被 merge(人肉/Lead `gh pr merge`)时「the completion event chain … never fires and the founder ends up manually asking for the archive」。它是 GatePoller 巡逻兜底(`gate-poller.ts:1205`,kill-switch `FLYWHEEL_EXTERNAL_MERGE_RECONCILE=0`)— **兜底的存在本身就是断点①的证据**。
- 「1338 范式」= FLY-1338 ship 当晚 Lead 人肉走完的整套 land 收尾,**没有成文检查单**(只散见 `FLY-1390-dag-only-audit/plan.md:94`、`research.md:364` 等转述)。Lead 人肉检查单需要本单产出(见 plan)。

## 3. session 关闭原语与资格陷阱(断点②④⑤)

### 3.1 close-runner 与三处拒关闸(断点②精确位置)

- endpoint:`POST /api/sessions/:executionId/close-runner`(`plugin.ts:2251-2368`);实现 `bridge/close-runner.ts`;founder-consent reserved action(`fcMw("close_runner")`,`reserved-endpoints.ts:69-74`)。
- 状态分类(`close-runner.ts:53-95`):`AUTO_CLOSE_STATES`={completed, rejected, deferred, shelved, terminated};`CRASH_PRESERVE_STATES`={failed, blocked};`FINALIZE_DONE_SOURCE_STATES`={running, awaiting_review, approved_to_ship, design_done}。
- **三处拒关闸**:
  1. CRASH_PRESERVE 保留闸(`:298-320`):failed/blocked 且无 `forcePreserved` → preserved。
  2. **资格闸(核心拒关点,`:324-350`)**:`!AUTO_CLOSE_STATES.has(status) && !forceClose && !issueTerminalOverride` → `status_not_eligible:<status>`(`:329`)+ `lead_close_runner_blocked` 事件 — **running/awaiting_review/approved_to_ship/approved 全被拒**。
  3. HTTP 层 409(`plugin.ts:2338-2344`)。
- 既有绕闸出路:`finalizeDone:true`(`:243-292`,先经 FSM 推到 completed 再关 — 正是 land 语义);`issueTerminalOverride:true`(`:322-370`,issue terminal 时连 `approved` husk 也拆,仅拆窗口不改状态)。
- resident Codex phase 另有 controller-lease 闸:`close-runner.ts:409-514` 先走 `prepareCodexPhaseShutdown`,`blocked` 即拒关;lease stale + pane 活 → `phase_shutdown_controller_lease_stale_live_pane`(`codex-phase-shutdown.ts:203-213`)— **深诊「lease 拒关」的命中点**。

### 3.2 状态机与「lease」的真实形态

- FSM 单一真源:`packages/core/src/workflow-fsm.ts:120-184`。终态(无出边):approved/completed/shelved/terminated(`:180-183`)。
- 没有名为 "lease" 的 session 状态;lease 是多个子系统:Lead identity lease(`flywheel-comm/src/lead-lease.ts`)、**resident Codex phase controller lease**(`codex-phase-shutdown.ts:25`,60s,判据 = `heartbeat_at` 新鲜度)、park lease(FLY-626,`flywheel-comm/src/index.ts:617-691`,CommDB parked marker)、inbox-mcp PID lease、三段式 TURN 单写者。

### 3.3 按 issue 批量关 session — 已存在(FLY-1185 lifecycle-closeout)

**最关键发现:`bridge/lifecycle-closeout.ts`(1483 行)就是统一的 issue 级批量关闭执行器**,五入口共用(A ship-terminal / B explicit close / C crash reap / D issue-terminal reconcile / E periodic sweep):

- `closeoutIssue(deps, input)`(`:505-559`):按 `disposition ∈ {shipped, canceled, founder_parked}` 关掉 issue 全部 node,per-issue mutex 内。
- node 收集:`collectIssueCloseoutNodes()`(`:136-199`)= sessions(全 alias,含三段式 phase)∪ auto-QA 子节点 ∪ open launch claims,按 executionId 去重。
- per-node 硬顺序(`closeoutOneNode`,`:1146-1445`):重读状态 → FSM 合法迁移 → closeRunner 拆(MCP reap→cmux→tmux→terminal-view)→ 确认 gone。
- **对资格陷阱的内建绕闸(`:1244-1259/1344-1383`)**:`disposition="shipped"` 时 FINALIZE_DONE 源状态走 `finalizeDone:true`;每个 closeRunner 调用带 `issueTerminalOverride:true + skipLifecycleGuard:true`(`:1360-1362`)→ awaiting_review/approved_to_ship/approved 都能收。
- HTTP:`bridge/lifecycle-routes.ts`(park `:203` / unpark `:306` / dry-run `:240` / lifecycle-apply `:339`),均 reserved action。
- ship 触发点(entry A):`DirectEventSink.ts:1050-1086` post-ship-owned completion → `runPostShipFinalization`(deps 带 `lifecycleInfra`)。

### 3.4 三段式结构与 park/keepalive

- 三段式(FLY-793)= Design→Implement→QA 三个 phase-session,共享 parent issue/thread/worktree;角色 `chat_thread_role ∈ {design, implement, qa}`。策略 `bridge/three-stage-policy.ts`;编排 `bridge/phase-orchestrator.ts`(effects:`closePhaseRunner:284` / `parkPhaseRunner:306` / `wakePhaseRunner:313`)。
- keepalive(FLY-887,`three-stage-policy.ts:286-303`,默认 ON):phase 交接间 park 保活;park = CommDB declared-state marker(`plugin.ts:8180-8280`),wake = 清 marker + mailbox wake(`plugin.ts:8319`)。
- ship 时关三段式 phase 的现行路径:`makeFinalizeThreeStagePhases`(`post-ship-finalization.ts:335-406`,`closeRunner({finalizeDone:true})`);周期兜底 `HeartbeatService.checkStaleParkedPhases`(`:2162-2269`,TOCTOU-safe 两情形自动 reclaim)。

### 3.5 shutdown-request 语义(断点⑤蓝本 = FLY-1269)

- 请求侧:`bridge/codex-phase-shutdown.ts` `prepareCodexPhaseShutdown()`(`:144-328`)— 探活(pane gone → direct 拆;lease stale + pane 活 → blocked)→ CommDB `requestRunnerShutdown(execId, requestId)`(`db.ts:1810`,表 `runner_shutdown_controls`,state requested/acked/failed)→ 轮询 ack,超时 30s(`:24`)→ ack 后验 TUI 真 gone(`validateAcknowledgedTuiGone` `:113-136`)才算 graceful。
- 响应侧:`packages/claude-runner/src/codex-phase-lifecycle.ts` `waitForShutdown()`(`:191`)/`pollShutdown()`(`:485-494`)→ runner 清理后 `ackShutdown(requestId, {ok})`(`:467-483`);实际收尾 `CodexTmuxAdapter.ts:944-961`(ack + 状态落 completed/timeout + scrub credential)。
- **覆盖缺口:当前只对 resident Codex phase(adapter=codex-tmux 且 role∈{design,implement,qa})生效**;Claude phase / 普通 execution 走 close-runner 直接 kill 序列,关前无 cleanup 回调 — 断点⑤的精确所在。
- 配套:FLY-1328 — runner 拆除时级联退休其未答 asks(`flywheel-comm/db.ts:2399-2510`,`resolved_via='owner_closed'`,proven-teardown only)。

### 3.6 终态免疫(Finding K)与 land 的交互

- 免疫位置:`DirectEventSink.ts:754-763` — 终态(FSM 无出边)session 的后续 completion 事件被丢弃不写。**拦的是 completion 覆盖,不是 close/teardown**。
- land 走 lifecycle-closeout / finalizeDone / issueTerminalOverride 路径**不会**被终态免疫或资格闸挡;裸调 close-runner endpoint 对 `approved` husk 会 409。lifecycle-closeout 对 approved 只拆窗口不改状态(`CANCELED_STATUS_ACTIONS.approved="already_terminal"`,`:78`),尊重终态免疫。

### 3.7 小结(对设计的输入)

① 批量关闭原语**不需要新造** — `closeoutIssue({disposition:"shipped"})` 已内建绕闸;缺一个显式「land 这一单」的入口把它接到 merge 成功事件上。② 资格陷阱精确拒关点 = `close-runner.ts:324-350`,land 绝不裸调 endpoint。⑤ cleanup 钩子蓝本 = shutdown-request/ack 协议,需评估是否扩展到非 Codex-phase session(或接受 close-runner 现有 kill 序列 + FLY-1328 asks 级联退休为「够用的收尾」)。

## 4. DAG 模板与节点推进机制

### 4.1 架构澄清:两套 DAG 代码 + three-stage 的关系

- **生产用的工程模板 DAG 引擎 = teamlead workflow engine**(FLY-1135/1281/1372/1385/1396):模板 = YAML manifest,运行态 = `workflow_run` 系列表 + `WorkflowEngineDispatcher`。**本单要接的系统。当前生产 `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=0`,DAG 休眠**(`product/doc/FLY-1396-dag-tier-binding/exploration.md:76`)。
- `packages/dag-resolver` + `edge-worker/DagDispatcher.ts`(FLY-353)只在 `__tests__` 出现,未接生产 Bridge — 不是当前推进机制。
- three-stage(FLY-793/859/887/921)= 生产当前实际在飞的机制(`bridge/phase-orchestrator.ts`);DAG v1 是它的引擎化重实现(`workflow-template-selection.ts:139` 原话「Engineering v1 is an engine implementation of the incumbent three-stage workflow」),经 `workflow_run.engine_owned`/`entry_kind` 互斥共存(phase-orchestrator 里 `if (this.isEngineOwned(...)) return;`,`:1094` 等)。**「legacy 在飞单」= 今天全部真实在飞单**(flag=0)。

### 4.2 模板与节点定义

- 模板文件:`packages/teamlead/src/workflow-seeds/`,6 套(`workflow-template.ts:1085-1092`;FLY-1396 计划收敛 5)。`tpl_eng_heavy.yaml` = `design`(claude)→ `implement`(codex)→ `qa`(claude)→ `founder_gate`(type=gate);edges `design_done`/`implement_done`/`qa_pass`;loop `qa_retry`(qa→implement,max 3,on_limit escalate);`terminal_gate: {node: founder_gate, predicate: founder_approved}`;`ship_claims: [qa_passed, founder_approved]`。
- 校验:`validateWorkflowManifestV1`(`workflow-template.ts:225`)/ V2(`:550`)— acyclic、单起点、恰好 1 个 QA、terminal gate 必须是 gate 节点、**terminal gate 不能有出边(`:494-496`)**。
- 节点类型注册表:`packages/config/src/node-type-registry.ts`(`design|implement|qa|gate|generic|review`);capabilities 已有 `can_ship`/`can_land`/`approval_gate_holder` 字段,**`can_land:true` 目前只挂在 implement 节点上**(`:83`)— 是「runner 有资格 land」的能力标记,不是引擎节点。
- 节点 prompt:`workflow-run-snapshot.ts:107-129`(`BUILTIN_NODE_AGENT`;generic 用 manifest `agent_file`)。模板选中即物化为**不可变 snapshot**(`buildWorkflowRunSnapshotV1/V2`,`:132/174`),运行期只读 snapshot。

### 4.3 引擎:dispatch / 上报 / 推进

- dispatch:`WorkflowEngineDispatcher.consume()`(`workflow-engine-dispatcher.ts:669`)轮询 engine-owned dispatch 意图 outbox(`reconcile()` `:205`,1s),admission → credential → `recoverOrAcquireWorkflowLaunch` → `startDispatcher.start(...)`(`:1003`)。**关键门(`:695`):`if (!node?.dispatch || !agentContent || node.type === "gate") throw "engine_node_not_executable"` — 除 gate 外每个节点必 spawn session。**
- 完成上报两条路:design/implement 走 `flywheel-comm complete --route <route>`(`VALID_ROUTES` = `auto_approve, needs_review, blocked, no_code, pr_handoff, phase_design_complete`,`complete.ts:31-39`)→ `/events` session_completed → `StateStore.commitEnrolledCompletion()`(`:17157`)映射成 engine outcome;qa/review 走 credential 化 `POST /decision`(`workflow-decision-routes.ts:267`)→ `submitWorkflowDecisionByCredential()`(`:17429`)。
- 推进:`commitWorkflowTransitionTx()`(`StateStore.ts:17712`)单一事务 — 按 `(from, condition)` 找唯一 edge/loop → 写 `node_completed`+`edge_traversed` → target 是 gate 则只开门(`gate_opened`,state=review,**不产生 dispatch 意图**,`:17976-17992`);否则 target state=pending + `node_dispatched` 意图;loop 超限 → run `held` + `loop_limit_escalated`。
- 词表三层区分:route(runner→Bridge 完成信号)≠ edge condition(`design_done/implement_done/qa_pass/node_done/review_pass/founder_approved`,`workflow-template.ts:40-46`)≠ claims predicate(`qa_passed` 等,`workflow-claims.ts:14-22`)。

### 4.4 运行态表(StateStore,`migrateWorkflowClaimsLedger()` `:12328` 起)

`workflow_run`(`:12330`,run_id/issue_id/template/snapshot/current_node_id/status active|held|completed/engine_owned/entry_kind;单 issue 单 active run)、`workflow_run_node`(`:12376`,(run_id,node_id,attempt) PK,state pending|running|done|review,**execution_id ↔ session**)、`workflow_run_event`(`:12388`,append-only)、`workflow_dead_execution_watch`(`:12428`,FLY-1385)、`workflow_alert_outbox`(`:12406`)、claims 侧(`workflow_claims:12481`、`workflow_execution_binding:12604`、`workflow_node_completion:12748`、`workflow_start_reservation:12764`、`workflow_category_binding:2709`)。

### 4.5 qa 之后:founder 批准与 merge 在 DAG 内外的分界

- qa PASS → `qa_pass` edge → founder_gate 开门(`gate_opened`,predicate `founder_approved`)。QA runner 继续当 ship-gate holder 走标准 approve-gate。
- founder 批准进 DAG:`bridge/founder-approval-projector.ts`(`drainWorkflowSourceEvents:74`)把 CommDB `founder_approval` 投影 → `applyWorkflowSourceEvent()`(`StateStore.ts:18764`)写 `founder_approved` claim(subject=git_head)。
- **分 schema(`StateStore.ts:18937-18974`,注释原话「Generalized/product v2 has no PR merge tail … Engineering v1 remains merge-gated by the Bridge composite seam and must not complete merely on approval」)**:v2 批准即 `run_completed`;**v1(工程)批准不使 run 完成 — 实际 merge + 收尾走 DAG 之外的 Bridge composite seam**(`merge-ship-gate.ts` `computeShipDecision:64` + `resolveEngineWorkflowShipClaims` → merge → `runPostShipFinalization`)。
- **结论:今天工程 DAG 的「批准→merge→清 worktree/关 session/Done/archive」整段收尾由 DAG 之外的 legacy 收尾机制在做 — 正是 land 节点要收编的空白点。**

### 4.6 「引擎侧自动化节点」无先例;加 land 需要什么

现有节点仅两种形态:agent node(必 spawn)与 gate node(不 spawn 但只是等待外部 claim 的门)。land(引擎跑一段自动化)没有对应形态。需要:
1. 新节点类型(`node-type-registry.ts`)+ 模板校验器放行(V1/V2;terminal 语义重定义 — 现在「terminal gate 不能有出边」);
2. 引擎执行分支:`workflow-engine-dispatcher.ts:695` 为 land 型开「不调 startDispatcher、直接执行引擎侧自动化」的路径;
3. 推进条件:`StateStore.ts:18937-18974` 让 v1 的 `founder_approved` 推进到 land(而非 v2 的直接 completed),land 完成再 `run_completed`;
4. 幂等/恢复语义(见 4.7)。

### 4.7 FLY-1385 dead-exec recovery 与 land 的幂等要求

- 机制:`reconcileDeadExecutions()`(`workflow-engine-dispatcher.ts:413`)— running 节点 session 已 irreversible-terminal 且无 completion receipt → 退避探活(`probeLaunchLiveness:499`)→ 确死则 `rollbackDeadWorkflowNodeExecution`(`:580`)**换新 execution_id 重派同 node/attempt**;disposition retry/hold(quota/auth 不可重试)/design_fallback;`unknown` 3 连 → `workflow_engine_escalation`(alert 走 durable outbox + lease fencing)。误伤防护 tripwire:`workflow_dead_execution_watch` TTL 24h + `reconcileDeadExecutionTripwires()`(`:267`)。alert kind 契约 `arc: human_by_design`(`kind-contract.ts:131-140`)— 引擎不自动杀,升级给人。
- **推论:引擎的 recovery 假设节点是「可重派的 runner」;land 有副作用(merge/archive),重放必须幂等** — 已有先例式防护可参照:`merge_block` marker(phase-orchestrator `tryRedriveImplementHandoff:839`「PR 已 merge → 不再 respawn QA」)、`post_ship_finalization_claim` 幂等键、`archiveThreadAndRecord` archive-once。

### 4.8 FLY-1396 分档 binding 对新增节点的约束

- work-kind decided at dispatch(Lead 派发那刻显式给 `taskCategory`,不读存量 label);required-param gate 只作用于 v2-routed 项目的 master fresh main-role entry — **land 作为 terminal 后段由引擎自动推进,不经 dispatch entry,不受此门约束**(也别给 land 塞新 required param)。
- retry 复用 pinned snapshot 不重解析 → land 节点必须能固化进 snapshot,物化时定死。
- land 改变流程形状(多一个终态节点)→ 属「流程形状不同」:**所有模板 manifest 一致加 land 收尾**,而非模型旋钮。
- 每套模板以 founder_gate 收尾是分档不削弱 ship 安全的依据(`FLY-1396 research.md:75`)— land 排在 founder_gate 之后必须保持这一不变量(founder 批准仍是唯一 merge 授权)。

## 5. 综合结论(设计输入汇总)

1. **收尾链和原语几乎全部已存在**:`runPostShipFinalization`(tmux 清理→关三段式 phase→worktree 清理→分支删→closeout→archive→Linear Done→sweep)、`lifecycle-closeout.closeoutIssue({disposition:"shipped"})`(issue 级批量关,内建绕资格闸)、worktree 分档清理原语、thread-archive 单 sink、Linear Done finalizer。**本单不是新建收尾,是给收尾一个引擎持有的可靠扳机 + 补覆盖缺口。**
2. **断点①的本质**:级联扳机 = Runner 的 `session_completed(landingStatus="merged")`,依赖 Runner 自助 ship 舞蹈(verify-approval → 代发 :cool: PR 评论 → poll MERGED → 改写 land-status → 自退)每步不出错;merge 发生在舞蹈之外(人肉/Lead 直 merge)则链路不起,只剩 reconcile 兜底和 Lead 记性。
3. **DAG 侧的空白**:v1 工程 DAG 在 founder_gate 后没有节点;merge+收尾在 DAG 之外。land 节点 = 新的「引擎执行节点」形态(不 spawn session),把 merge 观察 + 收尾编排收进 DAG,幂等 + 复用 FLY-1385 recovery。
4. **断点②④已有解**:land 绝不裸调 close-runner;走 lifecycle-closeout(finalizeDone + issueTerminalOverride 已内建)。
5. **断点⑤的真实缺口**:shutdown-request/ack 只覆盖 resident Codex phase;Claude/普通 session 关前无 cleanup 回调。
6. **byte-compat 红线**:生产 DAG 休眠、全部在飞单走 legacy three-stage;一切改动对 legacy path 字节兼容,land 自动链只随 DAG 开启生效;legacy 过渡靠 Lead 人肉 1338 范式(检查单要成文,今天不存在)。
