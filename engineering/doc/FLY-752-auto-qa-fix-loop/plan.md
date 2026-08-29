# FLY-752 Auto-QA 重复 spawn 修复 — 实施计划

Issue: FLY-752 (https://linear.app/geoforge3d/issue/FLY-752/infrap0-auto-qa-重复-spawn-是错的-一个-issue-一个-qa-fix-loop-复用-铺到所有项目)
日期: 2026-07-02
基于: research.md, exploration.md
Review: Codex design review R1 CHANGES REQUESTED → 本版并入 6 项修正

## 0. 目标 & 决策(Lead 已批)

修 FLY-579 auto-QA:(1) 一 issue 一 QA、fix-loop **复用同一 QA runner**(方案 A,不重开);
(2) fleet-wide(policy 默认翻 opt-out);(3) 只在 **fresh review-pass** 触发,parked-等-founder
不 QA;(4) QA 终态自动 cleanup(closeRunner:撤 cmux + 归档 thread + 删 row)。

## 1. 状态机(auto_qa_record,方案 A)

新增 record 状态 `awaiting_retest`(非-terminal)+ 新列 `retest_wake_pending_at`(durable
crash-recovery marker)。一 parent = 一 QA issue = 一 QA runner。

```
claim ────► running ──qa_result(pass)──► passed ──closeRunner(finalizeDone)──► cleanup+archive
 (首次fresh)   │  ▲                          (surface founder)
              │  │ retest_wake OK (清 pending)
  qa_result   │  └───────────────┐
  (fail)      ▼                  │ head 变(onMainAwaitingReview)
        awaiting_retest ──retarget──► running + retest_wake_pending_at
        (QA idle 保活,             │        ├─ QA alive → retestWakeQa(fail-loud)→ok 清 pending
         declare park)             │        └─ QA dead  → spawnQa(复用 qa_issue_id)
  任意 ──parent gone/superseded──► superseded ──closeRunner(finalizeDone, if QA alive)
  spawn/create 失败 / QA 死无 verdict ──► stuck ──► Lead alert(founder held)
```

`isQaHeld`(auto-qa-held.ts)保持 `record.status !== "passed"` → held;`running`/
`awaiting_retest`/`stuck` 全 hold。held-first ordering(event-route 在 always-deliver 抑制前调
coordinator;DirectEventSink 在 pushNotification 前)——已核实,retarget 必须在同步路径内先跑完
(测试锚定)。

## 2. onMainAwaitingReview 新逻辑(核心)——修正 issue #3

签名加 `freshTransition: boolean`(调用点算 `preExistingSession?.status !== "awaiting_review"`,
共享 helper,双点一致)。用 **`getLatestAutoQaRecordByParent`**(含 running/awaiting_retest/
**passed/stuck**,排除 superseded,latest by started_at)——避免旧 passed/stuck record 遇新 head
漏 QA + 漏 hold founder。

```
onMainAwaitingReview(session, { freshTransition }):
  role != main → return
  policy = resolveQaPolicy(session); !enabled → return              # §5.5 默认 opt-out
  sha = pr_head_sha; invalid → alertLead(fail-closed) return         # 不变
  rec = store.getLatestAutoQaRecordByParent(exec)
  if rec:
    if rec.target_pr_head_sha === sha:                                # 同 head
       running/awaiting_retest → dedup no-op                          # Q3(a) parked/重发
       passed  → no-op(founder 已 surface)
       stuck / failed(legacy) → no-op(hold 中,Lead 处理)              # failed=旧部署遗留,held
       return
    # head 变 = 真 fix / 新一轮(不需要 freshTransition)
    ok = store.retargetAutoQaRecord({exec, oldSha:rec.target, newSha:sha,
              expectStatuses:[running,awaiting_retest,passed,stuck,failed]})  # CAS §5.1;failed=legacy
    if !ok: log stale-race; return                                    # 并发/状态漂移安全退出
    qa = store.getSession(rec.qa_execution_id)
    if qa && !TERMINAL(qa.status):
       effects.retestWakeQa({qaSession:qa, parent:session, newSha:sha})  # fail-loud §5.3
         → ok  → store.clearRetestWakePending(exec, sha); postThread(🧪复测); stamp test
         → fail→ 留 retest_wake_pending_at(reconcile 重试); alertLead(founder held)
    else:                                                              # QA 已 close(上轮 passed)或死
       spawnQa(session, sha)  # 复用 rec.qa_issue_id re-spawn 新 QA runner;清 pending
    return
  # 无 record
  if !freshTransition: log skip(parked-for-founder/非 fresh); return   # Q3(b)
  claimAutoQaRecord(...); spawnQa(session, sha)                         # 首次 fresh spawn
```

`spawnQa` 复用现有 qa_issue_id 逻辑;spawn 成功后 `clearRetestWakePending`。

## 3. onQaResult 改动 —— 修正 issue #2

- 保留全部现有校验(linkage / freshness / idempotency / parent-state / record==running)。
- **PASS**:`setAutoQaStatus(passed, verdictEventId)` → `notifyShipReady` → **`closeQaRunner`**
  (见 §5.3,`closeRunner({finalizeDone:true, transitionOpts, archive, executorType:"qa"})`:
  running→completed→撤 cmux/tmux/tab + FLY-369 archive + 删 row)→ `setAutoQaStatus(notifiedAt)`。
  **QA prompt PASS 不再 `complete`**(§5.6):只报 qa-result(pass) + 释放资源 + 停;coordinator
  finalize+close 之(无 race)。
- **FAIL**:`setAutoQaStatus(awaiting_retest)`(**非** failed,不停 verdict-accept;不 close)→
  `feedbackWakeMain`(唤醒 implementer)→ stamp implement → postThread(QA thread 🔴)。QA prompt
  FAIL:报 qa-result(fail) + 释放重资源(关 Chrome)+ `declare-state park` + 停等 retest_wake。
- `awaiting_retest` record 不接 verdict(它等新 head,非等 verdict)——onQaResult 的
  `record.status !== "running"` 短路已覆盖。

## 4. reconcileOnStartup 适配 —— 修正 issue #2/#6

- **passed 且 QA 仍 live**(crash 在 notify 后 close 前):扫**所有** passed record(不止
  passed-unnotified),若 qa_execution_id session 非-terminal → `closeQaRunner`;未 notify 的补
  notify。
- **running + retest_wake_pending_at 已设**(crash 在 retarget 后 wake 前):QA alive →
  重发 retestWakeQa;QA dead → re-spawn(复用 qa_issue_id)。
- **running(无 pending)**:同现逻辑(claimed-unspawned → spawn;QA 死无 verdict → stuck)。
- **awaiting_retest**:parent moved/gone → superseded(+ closeQaRunner if QA alive);QA session
  死 → stuck + Lead alert(founder held;dead parked QA 亦被 orphan/crash reaper 清);QA alive →
  保留(等新 head)。

## 5. 逐文件改动

### 5.1 `StateStore.ts` —— 修正 issue #6
- record 状态 union 加 `awaiting_retest`(`setAutoQaStatus` terminal 判定**不**含它)。
- 新列 `retest_wake_pending_at TEXT`,migration 沿用 `migrateAutoQaRecordQaIssueColumns` 的
  PRAGMA table_info + ALTER 模式。
- `getLatestAutoQaRecordByParent(exec)`:`WHERE parent_execution_id=? AND status !=
  'superseded' ORDER BY started_at DESC LIMIT 1`。
- `retargetAutoQaRecord({exec, oldSha, newSha, expectStatuses})`:**CAS 事务** —— (a) 若
  oldSha row 状态 ∉ expectStatuses(含 **legacy `failed`**,见 issue #2)→ return false(并发/漂移);
  (b) DELETE 冲突的 (exec, newSha) **terminal/superseded 历史行**(force-push 回旧 sha 场景);
  (c) UPDATE oldSha row SET target_pr_head_sha=newSha, status='running',
  retest_wake_pending_at=datetime('now'), verdict_event_id=NULL, completed_at=NULL,
  **notified_at=NULL**(通知状态 scoped 到 (parent,sha) 非 row;不清则旧 passed 的 notified_at
  残留 → 新 head PASS 后若 notify 前 crash,reconcile 的 passed-unnotified 扫描会跳过 → founder
  通知丢失。issue R3-1);(d) return getRowsModified()>0。捕获 SQLITE_CONSTRAINT → false + warn。
- **legacy `failed` 处理(issue #2)**:已部署 pipeline 把 FAIL 写成 `status='failed'`(terminal)。
  新设计不再写 failed(FAIL→awaiting_retest),但升级时 DB 里存量 `failed` 行会被 getLatest 选中。
  `failed` 纳入 getLatest 处理 + retarget expectStatuses,语义同 awaiting_retest/stuck:同 head→held
  no-op;不同 head→retarget→running + 复用 qa_issue(QA 死则 re-spawn)。避免旧 failed 遇新 head 漏
  hold → founder leak。
- `clearRetestWakePending(exec, sha)`:UPDATE ... SET retest_wake_pending_at=NULL。
- `listPassedAutoQaRecords()` / 复用 `listRunningAutoQaRecords()` + `listAutoQaRecordsByParent`
  供 reconcile 扫 passed-with-live-QA / pending。
- 测试(StateStore.auto-qa-record.test.ts):retarget CAS(状态漂移 no-op / 历史 newSha 行冲突 /
  正常 in-place 单行)、getLatest 含 passed/stuck、awaiting_retest 非-terminal、
  clear/list pending。

### 5.2 `auto-qa-coordinator.ts`
- onMainAwaitingReview §2、onQaResult §3、reconcile §4。
- `AutoQaSideEffects` 加 `retestWakeQa`(返回 `{ok, error?}`)+ `closeQaRunner`。
- 测试(auto-qa-coordinator.test.ts):首次 spawn / 同 head×4 状态 dedup / head 变→retest(QA alive)/
  head 变→re-spawn(QA dead 或 passed-closed)/ 非-fresh→skip / FAIL→awaiting_retest 不 close /
  PASS→closeQaRunner+notified 顺序 / retarget CAS 失败安全退出 / wake fail→留 pending+alert /
  reconcile 三分支(passed-live-QA close、pending 重发/re-spawn、awaiting_retest)。

### 5.3 `auto-qa-effects.ts` —— 修正 issue #1/#2
- `retestWakeQa({qaSession, parent, newSha})` **fail-loud**:从 `qaSession.adapter_type` 经
  `EXECUTOR_TO_TRANSPORT` 解析 transport;no-transport QA → 返回 `{ok:false, error:"no-transport"}`
  (**legacy/corruption guard** —— §5.9 已在 spawn 时强制 mailbox-capable QA,正常不会到这);
  `db.clearDeclaredState(qa.execution_id)`(清 park marker,让 watchdog 恢复);
  `wakeRunnerMailbox({..., backend, content:<retest 指令含 newSha+parentExec>})`;返回
  `{ok, error}`。**不复用** `sendRunnerWake` 的 void best-effort。
- `closeQaRunner({qaSession, transitionOpts})`:`closeRunner({executionId:qa.execution_id,
  issueId:qa.issue_id, projectName, executorType:"qa", finalizeDone:true, transitionOpts,
  archive:<deps>}, store)`。running QA → finalizeDone 转 completed → close + archive(completed
  才 archive-eligible,已核 done-thread-archiver)。
- 测试(auto-qa-effects.test.ts):retestWakeQa 清 marker / 传 codex backend / no-transport
  fail-closed / wake 失败返回 ok:false;closeQaRunner 传 finalizeDone+transitionOpts。

### 5.4 `runner-wake.ts`
- 不加 `retest_wake` 到 `sendRunnerWake`(retest 走专用 `retestWakeQa`,§5.3)。仅在
  effects 内直接调 `wakeRunnerMailbox` + clearDeclaredState。若需要文案 helper 则本地化。

### 5.5 `auto-qa-policy.ts` + `packages/config` —— 修正 issue #4(fleet-wide)
- `packages/config/src/types.ts`:`QaConfig.auto` 改 `auto?: boolean`。
- `ConfigLoader.ts`:`qa` block 存在但 `auto` 非 boolean 且非 undefined → **malformed**(区分
  absent vs malformed,不再一律 throw)。
- `auto-qa-config-source.ts`:返回 tri-state `{kind:"absent"} | {kind:"malformed",reason} |
  {kind:"config", auto?, skip_labels?}`;非-ENOENT/解析错 → malformed(不再塌成 undefined)。
- `auto-qa-policy.ts`:`FLYWHEEL_AUTO_QA=0` → off;`no-qa` label → off;`malformed` →
  **fail-closed off**(reason);`config.auto === false` → off;`absent` 或 `auto` 未设 → **on**;
  `skip_labels` 命中 → off。
- 测试:policy 默认 opt-out sentinel(absent→on / malformed→off / auto:false→off /
  三 opt-out 逐条);`fly707-enablement.test.ts` 重写为 default-on + explicit-opt-out sentinel;
  config types/ConfigLoader 测试补 optional auto + malformed。

### 5.6 QA prompt 契约 —— 修正 issue #5(真实注入点 = Blueprint)
- `packages/edge-worker/src/Blueprint.ts` `buildQaModeSystemPromptLines`(硬契约):
  PASS → `qa-result --status pass` + 释放重资源 + **停**(不 complete,pipeline 收尾);
  FAIL → `qa-result --status fail` + 关 Claude-in-Chrome/释放浏览器(必要时 /compact)+
  `flywheel-comm declare-state park --reason "auto-QA awaiting retest"` + 停等 `retest_wake`;
  retest_wake → re-fetch + re-pin 新 head + 重跑。删「FAIL 后 fresh QA re-spawn」旧语义。
- 同步:`agents/qa-executor.md`(shipped)、`.flywheel/agents/engineering/qa-executor.md`
  (flywheel project override,现写 `flywheel-comm ask` 也要对齐)、
  `lead-rules-base/auto-qa-pipeline.md`。
- 测试:`Blueprint.fly579-qa-mode.test.ts` 断言改为新契约(PASS 不 complete、FAIL park+wait)。

### 5.7 `plugin.ts`
- coordinator effects 注入:`closeRunner` + `archive` deps(复用 plugin.ts:1341 处组装)+
  `transitionOpts`(applyTransition opts)+ store,使 closeQaRunner/retestWakeQa 可用。
- 两调用点传 `freshTransition`。RunnerIdleWatchdog quiet-probe 无需改(declare park → self_parked
  已覆盖,已核 quiet-classifier)。

### 5.8 `event-route.ts` / `DirectEventSink.ts`
- 共享 helper 算 `freshTransition = preExistingSession?.status !== "awaiting_review"` 传入。
  DirectEventSink 有 `preExistingSession`;event-route 在 upsert 前捕获旧 status。

### 5.9 spawn 强制 mailbox-capable QA backend —— 修正 issue #1
现状:QA spawn 只设 `ignoreRunnerLabelSelection: true`,只跳过 **label** 层;`roles.runner.backend`
+ `FLYWHEEL_RUNNER_BACKEND` env default 仍生效(run-dispatcher-backend.test 锚定 project role 赢)。
`antigravity-tmux` / `kimi-tmux` → `transport:"none"`(role-adapter-resolver:47-54)。→ default-on
项目若 runner role/env 是 no-transport,会 spawn 出**永远收不到 retest_wake** 的 QA → 首次 FAIL
后 wedge founder gate。
- 加 spawn-time 契约 `requireMailboxTransport?: boolean` 到 `StartRequest` /
  `buildRunnerSpawnFields`;auto-QA spawn 设 true。role-adapter-resolver 解析 backend 后:
  `if requireMailboxTransport && EXECUTOR_TO_TRANSPORT[backend] === "none"` → 强制改
  `claude-tmux`(mailbox-capable lane,与 fleet-wide default-on 一致)。
- **强制 claude-tmux 时同时清/重解析 `runnerModel`**(R3 note):`RoleBackendConfig.model` 是任意
  字符串、Blueprint 会透传给 adapter;原 no-transport role/env 的 model 对 Claude lane 不兼容 →
  forced QA lane 用 Claude account default(除非 model 已知 Claude 兼容)。
- `retestWakeQa` 的 no-transport 分支降级为 legacy/corruption guard(正常到不了)。
- 测试:`roles.runner.backend: antigravity-tmux` / `kimi-tmux` / `FLYWHEEL_RUNNER_BACKEND=
  antigravity-tmux` 下 auto-QA spawn 被强制 claude-tmux(有 mailbox)。

## 6. 测试计划(TDD,RED→GREEN)

单测每文件先写失败测:policy 默认 opt-out + malformed fail-closed + sentinel;config types/loader
optional+malformed;StateStore retarget CAS / getLatest / pending / **legacy failed**;coordinator
全场景(§5.2)+ **legacy failed same-head hold / old→new head retarget+re-spawn**;effects
retestWakeQa(backend/marker/no-transport/fail)+ closeQaRunner;Blueprint QA 契约;reconcile
三分支;held-first ordering 锚定;**spawn requireMailboxTransport(antigravity/kimi/env →强制
claude-tmux)**;**retarget 清 notified_at 回归(旧 passed→新 sha→新 PASS,notify 前 crash→reconcile
仍认 unnotified re-notify)**。

真机 QA(独立 QA Runner,529 Room / 隔离):一整轮 FAIL→retest(**同一** QA runner,exec-id 不变)→
PASS→cleanup 落地(cmux workspace 真撤 + thread 真归档 + 无 pin 残留)+ 非-fresh session 不 spawn +
passed-旧-head→新-head 复用同 QA issue 且 hold founder + fleet-wide(非-flywheel 项目 stub 触发)+
idle QA declare park 后无 idle 告警。

## 7. Rollout / byte-compat

- Q2 默认翻转 = 行为变更 → reverse-compat sentinel 锚定三 opt-out + malformed fail-closed。
- Bridge boot 读 qaConfig → 部署 = canonical root `git pull` + Bridge 重启(Tier-3)+ 补 dist。
- 保活 QA 新形态 → 真机 QA 过一整轮再 ship。FLY-766(Chrome reaper)未建 → 不依赖;QA prompt 自释放。

## 8. 风险

1. retarget CAS + 历史行冲突 → 事务 + DELETE 冲突历史行 + CAS 状态断言,测试三情形。
2. 保活 QA 长期 idle → 有界(1/issue)+ declare park + orphan reaper 兜底 dead QA。
3. held-first ordering:retarget 在 always-deliver 抑制前同步完成(测试锚定)。
4. wake 不可靠 → fail-loud + durable retest_wake_pending_at + reconcile 重试,绝不静默释放 founder。
5. default-on 后 malformed/写错 opt-out config → fail-closed off(不误 enable)。
6. QA transport(Codex-role 项目 QA)→ **spawn 时**强制 mailbox-capable(§5.9),retestWakeQa
   no-transport 分支仅 legacy guard。
7. legacy `failed` record(旧部署遗留)→ 纳入 getLatest + retarget expectStatuses,同
   awaiting_retest/stuck 处理,避免升级后旧 failed 遇新 head 漏 hold → founder leak。
