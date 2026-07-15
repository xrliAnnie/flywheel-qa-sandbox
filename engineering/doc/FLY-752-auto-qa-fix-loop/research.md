# FLY-752 Auto-QA 重复 spawn 修复 — 调研

Issue: FLY-752 (https://linear.app/geoforge3d/issue/FLY-752/infrap0-auto-qa-重复-spawn-是错的-一个-issue-一个-qa-fix-loop-复用-铺到所有项目)
日期: 2026-07-02
基于: exploration.md

## 0. Brainstorm gate 决策(Lead 已拍)

- **Q1 = 方案 A**(QA 保活复用):一 parent 一 QA issue/runner;FAIL 不 complete、idle 保活等
  retest_wake;只 PASS 才终态。**附加纪律**:idle 保活期间必须释放重资源(尤其
  Chrome/claude-in-chrome)、必要时 compact,别让 idle QA 变成新内存包袱;接 idle-watchdog
  quiet-probe 压制。
- **Q2 = 翻 opt-out**(缺省全开):对齐 default-enable 政策;保留三条 opt-out
  (FLYWHEEL_AUTO_QA=0 / no-qa label / qa.skip_labels)。
- **Q3 = 两 guard 都要**:auto-QA **只在真正的 fresh review-pass 触发**,不在任何
  awaiting_review 就 spawn。

## 1. Q3 判别信号(核实过代码)

`onMainAwaitingReview` 仅在 `session_completed` 事件 + status=`awaiting_review` +
role=main 时被调(event-route.ts:1784、DirectEventSink.ts:586)。判别用两个信号:

- **`pr_head_sha` 变化**:fix 轮次 = 实现者 push 新 head 后 re-request review,
  `session.pr_head_sha` 刷新为新 head(FAIL-CLOSED 检查已依赖它、supersede 已按新 sha,证明
  每次 needs_review completion 都刷新 pr_head_sha)。→ record.target != session.pr_head_sha
  即真 fix 轮次。同 head 再触发 = parked / 重发。
- **fresh-transition**:`preExistingSession.status !== "awaiting_review"`(DirectEventSink 已有
  此判据用于别处,435-438)= 从非-awaiting_review 转入 = 真新 review-pass。已经 parked 在
  awaiting_review 的 session 再收到 completed 事件 = 重发,非新 pass。

**统一规则**(onMainAwaitingReview):
1. policy(含 Q2 opt-out 默认)+ fail-closed(缺 pr_head_sha 不动)。
2. 查 parent 的存活 QA record(按 parent_execution_id)。
3. record 存在:
   - `target_pr_head_sha === sha` → dedup no-op(同 head:running/passed 都不重复)。[Q3(a)]
   - `target != sha`(head 变)→ **retest**:更新 record target=新 sha(重置 running),给
     record.qa_execution_id 发 `retest_wake`;若该 QA runner 已被清理(上轮 PASS 后
     closeRunner)→ 复用**同一 qa_issue** re-spawn 新 QA runner(非累积,老的已清)。[fix loop]
4. record 不存在:
   - `freshTransition` → 首次 spawn(建 QA issue + spawn QA runner)。
   - 否则 → **SKIP**(parked-for-founder / 非-fresh、无 record → 不 QA)。[Q3(b) guard]

两个调用点都要算 `freshTransition` 并传入 `onMainAwaitingReview(session, {freshTransition})`:
DirectEventSink 有 `preExistingSession`;event-route 需在 upsert 前捕获旧 status(见 plan)。

## 2. 保活 QA 与各 reaper 的交互(全部核实过)

方案 A 让 QA runner FAIL 后停在 `running`(从不 complete,直到 PASS)+ 活 pane idle。核查:

- **crash-reaper(FLY-720)**:只 own+reap `probeRunnerProcessLiveness === "dead_pin"` 的
  running session。保活 QA = 活进程活 pane,liveness ≠ dead_pin → **不会被 reap**。✓
- **done-running-reconciler(FLY-324)**:只处理发过 `stage set completed`(stage_changed)
  的 running session。保活 QA 轮次间不 complete → **不触碰**。✓ 且它的注释已明确承认「parked
  QA runner 持有 live browser、等待 re-engage」是合法保活模式,直接背书本设计。
- **RunnerIdleWatchdog(FLY-92/626)**:poll running+idle → 发 `runner_idle_detected`。保活
  QA 会命中 → 用 `isWakeSuppressed`(FLY-626 `quietSignalsProbe` pane-content 探针)压制。
  QA 保活时 pane 需呈现「quiet/parked」信号 → prompt 指示 QA idle 前打印静默标记(见 plan
  §prompt)。
- **HeartbeatService**:running session 走心跳;保活 QA 心跳正常(活进程)→ 不误判 orphan。

## 3. 复用原语(直接用,不重造)

- **`closeRunner`**(close-runner.ts):QA 终态(passed → completed)后调它 = 撤 cmux linked
  session + 杀 tmux window + 关 Terminal tab + **FLY-369 archive thread** + 删 CommDB row。
  需传 `archive: CloseArchiveDeps`(plugin.ts:1341 已有可复用的 archive deps 组装)。QA passed
  走 `complete --route no_code` → `completed` ∈ AUTO_CLOSE_STATES → 合格。
- **`sendRunnerWake`**(runner-wake.ts):现 `approval_wake`/`feedback_wake`。加
  `retest_wake`。QA 是 claude-transported(有 mailbox),`isNoTransportBackend` 守卫不拦。
- **StateStore auto_qa_record**:PK=(parent_execution_id, target_pr_head_sha)。复用设计需:
  - 新方法 `getActiveAutoQaRecordByParent(parentExecutionId)`:返回该 parent 非-superseded 的
    record(不变式:一 parent 至多一条存活)。
  - 新方法「更新 record 的 target_pr_head_sha + 重置 running」(retest)。
  - `setAutoQaStatus` 现有;新增 `qa_execution_id` 复位/保留逻辑。
  - migration:沿用 `migrateAutoQaRecordQaIssueColumns` 的 ALTER 模式;PK 不改(仍
    composite,retest 时原地 UPDATE target_pr_head_sha 保持单行)。

## 4. FLY-766(Chrome reaper)—— 外部依赖,不阻塞

grep 全仓无 FLY-766 代码 = 未建。本 PR **不依赖**它:QA prompt 自足——idle 前自己关
Chrome/claude-in-chrome 标签、释放浏览器资源。766 真的建好后作为二层兜底。plan 里把「QA idle
前释放重资源」写进 qa-executor.md,不引 766 代码依赖。

## 5. Byte-compat / rollout

- Q2 默认翻转是**行为变更**:缺省 = 全项目开 auto-QA。加 reverse-compat sentinel 测试
  锚定:`FLYWHEEL_AUTO_QA=0` / `no-qa` / `qa.auto: false` / `skip_labels` 四条 opt-out
  逐条仍生效。
- Bridge boot 读 qaConfig(`loadQaConfigByProject`)→ 部署要 canonical root `git pull` +
  Bridge 重启(Tier-3)。
- 保活 QA 是新的运行时形态 → 需真机 QA 验证一整轮 fix-loop(FAIL→retest→PASS)+ cleanup 落地
  (cmux/thread/pin 真撤)。

## 6. 影响文件清单(据此写 plan)

| 文件 | 改动 |
|------|------|
| `StateStore.ts` | 新方法 getActiveAutoQaRecordByParent / updateAutoQaTargetHead(retest 重置);测试 |
| `auto-qa-coordinator.ts` | onMainAwaitingReview 改「复用/retest/首spawn/skip」;onQaResult FAIL→park+不清、PASS→closeRunner;reconcile 适配保活 QA;新增 closeQaRunner effect 调用 |
| `auto-qa-effects.ts` | 新 effects:`retestWakeQa`(retest_wake)、`closeQaRunner`(调 closeRunner 带 archive)、`releaseQa`(FAIL park 后的 thread 提示 + stage) |
| `runner-wake.ts` | 加 `retest_wake` WakeKind + 文案 |
| `auto-qa-policy.ts` | 默认翻 opt-out(`cfg?.auto !== false`);保留三 opt-out |
| `agents/qa-executor.md` | prompt loop:FAIL 后不 complete、释放 Chrome、打印静默标记、等 retest_wake;仅 PASS complete no_code |
| `auto-qa-pipeline.md`(lead-rules) | 文档改述:一 QA 复用、不重开、fleet-wide、fresh-pass-only |
| `plugin.ts` | 给 coordinator 注入 closeRunner+archive deps;两调用点传 freshTransition;RunnerIdleWatchdog quiet-probe 认保活 QA |
| `event-route.ts` / `DirectEventSink.ts` | 捕获并传 freshTransition |
| `RunnerIdleWatchdog` quiet-probe | 认保活 QA 的静默标记 |
