# FLY-752 Auto-QA 重复 spawn 修复 — 探索

Issue: FLY-752 (https://linear.app/geoforge3d/issue/FLY-752/infrap0-auto-qa-重复-spawn-是错的-一个-issue-一个-qa-fix-loop-复用-铺到所有项目)
日期: 2026-07-02
基于: 无

## 1. 问题(Annie 2026-07-01,极度不满)

FLY-579 auto-QA pipeline 设计错了:main session 每进一次 `awaiting_review`(code
review 过一轮)就 spawn 一个**全新的 QA**。一个 issue 改 3 轮 → QA1/QA2/QA3;最后一
个 issue 能堆 10 个 QA。5 个真在做的 issue → ~50 个 QA session,每个 1M-context → 把机
器 swap 撑爆(FLY-751)+ 侧栏一排 + Discord pin 堆死。

## 2. 当前架构(已从代码核实)

- **触发点**:`event-route.ts:1784` + `DirectEventSink.ts:586` —— 每个
  `session_completed` 事件,若 session 是 `main` 且 status=`awaiting_review`,调用
  `AutoQaCoordinator.onMainAwaitingReview(session)`。
- **`onMainAwaitingReview`**(`auto-qa-coordinator.ts:192`):policy 检查 →
  fail-closed(缺 `pr_head_sha` 不 spawn)→ `supersedeOtherAutoQaRecords(exec, sha)`
  → `claimAutoQaRecord({parentExecutionId, targetPrHeadSha})` → **每个新 head 建新
  record** → `spawnQa`:**createQaIssue(建新 `QA·FLY-XX` Linear issue)** +
  startDispatcher.start(**spawn 新 QA runner**)。
- **AutoQaRecord**(`StateStore.ts:463`)PRIMARY KEY = `(parent_execution_id,
  target_pr_head_sha)`。→ **同一 parent 每换一次 head 就是一条新 record + 新 QA issue +
  新 QA runner**。这就是 QA1/QA2/QA3 的根。
- **QA runner 生命周期**(`agents/qa-executor.md`):测 → `flywheel-comm qa-result
  --status pass|fail` → `flywheel-comm complete --route no_code` → session=`completed`。
  prompt 第 55 行白纸黑字:「FAIL → 修完 re-review → **a fresh QA is spawned**」——
  当前设计**明确**每轮重开 QA。
- **QA FAIL**(`onQaResult`,coordinator:484):`feedbackWakeMain` 唤醒实现 runner →
  实现 runner 修 → push 新 head → re-review 过 → `onMainAwaitingReview` **再次触发** →
  supersede 旧 record → claim 新 sha → **新 QA issue + 新 QA runner**。
- **完成后无 cleanup**:QA runner `completed` 后,**没有任何东西自动调用 closeRunner**。
  `closeRunner` 只在 Lead MCP / endpoint / actions 手动触发(`plugin.ts:1341`、
  `actions.ts:529/687`)。→ QA 的 cmux workspace + tmux window + Terminal tab + Discord
  thread/pin 全部残留。旧 QA 一个个 `completed` 但不撤 → 累积。

**两条叠加成因**:① 每轮 re-spawn(QA1/QA2/QA3 顺序产生);② 无 cleanup(每个完成的 QA
残留 cmux/tmux/thread/pin)→ 累积成 ~50 个。

## 3. 已有可复用原语(关键)

- **`closeRunner`**(`bridge/close-runner.ts`)已完整实现 item 4 需要的全部动作:杀
  per-runner cmux linked session(撤 workspace)+ 杀 tmux window + 关 Terminal tab +
  **FLY-369 `maybeArchiveThreadOnClose`**(归档 Discord thread)+ 删 CommDB session row。
  只接受 `AUTO_CLOSE_STATES`(completed/rejected/deferred/shelved/terminated)。QA
  passed 后走 `complete --route no_code` → `completed` → **已经符合 closeRunner 资格**。
- **`sendRunnerWake`**(`bridge/runner-wake.ts`):`feedback_wake` / `approval_wake`
  两种 mailbox wake。可加一种 `retest_wake` 唤醒既存 QA runner。
- **`RunnerIdleWatchdog`**(FLY-92/626):只 poll `running` session,靠 pane-content
  `quietSignalsProbe` 决定是否压制 idle 告警(非 DB flag)。
- **`done-running-reconciler`**(FLY-324)已明确承认「parked QA runner 持有 live
  browser / 等待 re-engage」是**合法保活模式** —— 直接支撑「QA 复用保活」的设计。

## 4. 四项需求 → 设计草案

### 需求 1:一个 issue 一个 QA + fix-loop 复用(核心)

record 的身份从 `(parent_exec, sha)` 改为 **按 parent execution**(一 parent = 一 QA
issue = 一 QA runner,`target_pr_head_sha` 随轮次更新)。`onMainAwaitingReview` 改成
**「复用 or 首次 spawn」**:已有存活 QA record → 更新 target sha + 给既存 QA runner 发
`retest_wake`(**不 spawn**);无 record → 建 QA issue + spawn(仅首次)。

reuse 机制两个方案(**待 gate 定**):

- **方案 A(字面复用 · 推荐)**:QA runner FAIL 后**不 complete**,停在 `running` 保活
  idle,等 `retest_wake` → 重新 `git fetch` pin 到新 head → 重测 → 重报。**仅 PASS**
  才 `complete --route no_code` → 终态 → cleanup。契合 Annie 原话「同一个 QA 复测、不重
  开」;任一时刻每 issue 只有 1 个 QA + 1 个 implementer(一个 active 一个 idle,对称,
  这就是稳态最小值,不是 50)。代价:实现者修复窗口内 QA idle 保活(需接 idle-watchdog
  的 quiet-probe 压制,避免 idle 告警刷屏)。
- **方案 B(复用 issue/thread、重开 runner)**:QA FAIL 后 `complete` + **立即
  closeRunner**(不残留),但**复用同一个 QA issue/thread**(dedup on parent),下一轮把
  新 QA runner spawn 进**同一个 QA issue**。修复窗口内零 QA 保活(footprint 最优),但每
  轮重载 QA context——违反「不重开」字面。

> 倾向 A(契合 Annie 字面 + footprint 有界)。但 A 有 idle-watchdog 交互;B 更简单/修复
> 窗口 footprint 更低。footprint 是 Annie 的根本诉求(FLY-751),需 Lead 拍。

### 需求 2:铺到所有项目(fleet-wide)

现状:`resolveAutoQaPolicy`(`auto-qa-policy.ts`)要求 `qa.auto === true`,只有
flywheel 的 `.flywheel/config.yaml` 有(FLY-707)。其它项目(geoforge3d/sub/tidal-echo/
joycon/growth)都是独立 repo,**本 PR 改不到它们的 config**。

→ 唯一在 flywheel 单点 code 就能 fleet-wide 的做法:**把 policy 默认翻成 opt-out**
(`qa.auto !== false` 才开;缺省=开)。对齐 `default-enable-policy`(auto-QA 不在
founder_consent/founder_ux_gate/branch-protection 豁免名单里)。全局 kill-switch
`FLYWHEEL_AUTO_QA=0`、per-issue `no-qa` label、`qa.skip_labels` 三条 opt-out 保留。**这
是行为/scope 变更,需 Lead/founder 拍**。

### 需求 3:parked-等-founder 的 issue 不该 auto-QA

「ship 还没批就不用测(现在 gate 一开就 spawn QA,纯浪费)」。语义**待澄清**——最可能
是:一个已 QA 过/已 surface 给 founder、正 parked 等 ship 批准的 session,被某种 re-trigger
(Bridge restart reconcile / re-surface)又 spawn 了 QA。需求 1 的 dedup(按 parent、
record 存活即复用)已经覆盖大部分:record 已 `passed` → 不再 spawn。但**首次**触发也要能
识别「这不是新 code-review、是 parked 等 founder」→ 跳过。需要一个 guard 判断 session 是
「fresh code-review pass」还是「parked-for-founder」。**精确语义须 gate 确认**。

### 需求 4:QA 收尾 cleanup

QA 过 / superseded / parent gone → coordinator 自动调 `closeRunner`(带 `archive`
deps)→ 撤 cmux workspace + 关 tmux + 归档 thread + 删 CommDB row。复用现成
`closeRunner`,只需在 coordinator 的 PASS 分支、supersede 分支、reconcile 的
superseded 分支接线。方案 A 下 FAIL **不** cleanup(runner 保活复用);仅终态 cleanup。

## 5. 影响面(方案 A)

- `StateStore`:AutoQaRecord 键改按 parent;新增「更新 target sha」「找 parent 的存活
  record」等方法;可能新增 parked/idle-suppress 标记列。
- `auto-qa-coordinator.ts`:onMainAwaitingReview 改「复用 or spawn」;onQaResult FAIL
  分支改「park QA、不期待终止」;PASS/supersede 分支接 closeRunner。
- `runner-wake.ts`:新 `retest_wake` kind。
- `agents/qa-executor.md`:prompt loop 改——FAIL 后不 complete、等 retest_wake;仅 PASS
  complete。
- `auto-qa-policy.ts`:默认翻 opt-out(需求 2)+ parked-for-founder guard(需求 3)。
- `RunnerIdleWatchdog` / quiet-probe:识别 parked QA,压 idle 告警。
- cleanup 接线 + closeRunner 的 `archive` deps 注入(coordinator 目前无 closeRunner
  依赖,需在 plugin.ts 注入)。

## 6. 风险 / 需在 gate 确认

1. **A vs B**(reuse 机制)—— footprint tradeoff,Annie 根本诉求。
2. **需求 2 默认翻 opt-out**—— 全 fleet 行为变更 + byte-compat 影响。
3. **需求 3 语义**—— 「parked-等-founder」精确定义。
4. **保活 QA 与 idle-watchdog / done-running-reconciler / crash-reaper 的交互**——
   不能让保活 QA 被误杀,也不能刷 idle 告警。
5. **byte-compat / rollout**—— Bridge boot 读 qaConfig,需 Tier-3 重启部署。
