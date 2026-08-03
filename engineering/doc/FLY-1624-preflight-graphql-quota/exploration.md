# FLY-1624 GitHub 配额燃烧根源 + pre-flight 仪器说谎 — 探索

Issue: FLY-1624 (https://linear.app/geoforge3d/issue/FLY-1624/529仪器说谎-pre-flight-用-gh-repo-viewgraphql-查沙箱仓库-配额耗尽被报成仓库不存在-一条跑不通的)
日期: 2026-08-03
基于: 无

## 0. 目标变更(founder 直令,2026-08-03)

本单原始 scope 是「pre-flight 用 `gh repo view`(GraphQL)查沙箱仓库,配额耗尽被误报成仓库不存在」。Annie 追问后主目标改为:

> 「我唯一想搞清楚的是,为什么我们会超过每小时 5000 的限额,这个才是最大的问题。用不用 GraphQL 其实都不重要。」

即:**修掉配额燃烧的真源头**。Lead(Tadashi)采样定位到生产 Bridge 自己(run-bridge.ts 子进程)在近乎连续地跑:

```
gh pr view 765 --json state,mergedAt,mergeCommit,headRefOid   — 55/120 次快照命中
gh pr view 766 --json ...                                      — 52/120
gh pr view 762 --json ...                                      — 50/120
```

其中 PR #762 早在 07:05 就 merge 了,#765 在 15:05 merge —— **merge 完 9 小时 / 1 小时后还在被连续轮询**。实测舰队燃烧速度 5,640 点/小时 > 5,000 预算。

优先级(Lead 指令 81e2aaa6):
1. 找到 Bridge 里这个轮询循环,回答 (a) 为什么 PR merge 了还不停 (b) 为什么背靠背无间隔;
2. 修复:merge 检测到位后停表;轮询加合理间隔 + backoff;结果落持久状态,不靠无限轮询兜底;
3. 吸收已完成的 pre-flight 一行修复(分支 `fix/fly1620-preflight-rest`);
4. 原 scope(17 处 REST 迁移 + CI 守卫)降级为可选。

## 1. 侦查路径(全部有据可查)

### 1.1 字段组合定位代码

采样命令的字段组合 `state,mergedAt,mergeCommit,headRefOid` 全仓只有一处产生:

- `packages/teamlead/src/bridge/external-merge-reconcile.ts:100` — `checkPrMergeViaGh()`,拼出 `gh pr view <N> --json state,mergedAt,mergeCommit,headRefOid`。

`checkPrMergeViaGh` 是导出函数,有三个消费面:
1. `external-merge-reconcile.ts` 自己的 `pass()` — GatePoller 每 20 tick(≈60s)跑一次,每项目每 pass 预算 3 次 gh、带 10 分钟 negative cache + rotation。**有纪律,不是燃烧源。**
2. `workflow-ship-ready-arm.ts` 的 `classifyShipHandled`(经 `createWorkflowShipReadyHandledClassifier`)— merged 定格缓存、open/closed 15s TTL、unknown 退避梯(30s→5min)、每项目每分钟 6 次预算、single-flight。**有纪律。**
3. `workflow-ship-ready-arm.ts` 的 **`classifyRunnerShipMerged`**(第 185–222 行)— 对 batch 里每个候选**无条件** `Promise.all` 各打一发 gh。**零缓存、零预算、零退避、零间隔 —— 燃烧源。**

### 1.2 调用链与节奏

```
WorkflowEngineDispatcher.start(intervalMs = 1_000)        ← 每 1 秒一个 tick
  └─ reconcile()                                          ← this.reconciling 串行守卫
       └─ reconcileWorkflowShipReady()
            └─ reconcileRunnerShipMerges(arm, nowIso)     ← 无条件,先于 shipReadyNotifyEnabled 检查
                 ├─ store.listRunnerShipHoldersForMergeProbe()
                 └─ arm.classifyRunnerShipMerged(candidates)
                      └─ Promise.all(每候选一发 gh pr view ...)
```

- `workflow-engine-dispatcher.ts:249` — `start(intervalMs = 1_000)`;`plugin.ts:5656` — `workflowEngineDispatcher?.start()`(用默认 1s)。
- `reconcile()` 有 `this.reconciling` 守卫:pass 不重叠,但**结束即接续**——每 pass 时长 ≈ 最慢那发 gh(1~2.5s,`PROBE_TIMEOUT_MS = 2500`),下一 tick ≤1s 后又发起下一 pass。三个候选并发探测,故单 PR 占空比 ≈ 40–60%,与 Lead 采样的 50–55/120 完全吻合。
- 燃烧速度量级:3 候选 × 每 ~2–3s 一轮 ≈ 3,600–5,400 次/小时,`gh pr view` 走 GraphQL 每次 ~1 点 → 与实测 5,640 点/小时同量级(余量来自 runner 的 gh pr list 等正常流量)。

### 1.3 候选是谁 —— 生产 ground truth

候选 SQL(`StateStore.listRunnerShipHoldersForMergeProbe`, StateStore.ts:31034):`workflow_gate_holder` 里 `authority_mode='runner_ship'`、state ∈ (materializing, awaiting_review, approved)、run active + engine_owned + 当前节点=gate 节点。

生产 `~/.flywheel/teamlead.db` 实查(2026-08-03 快照):

| holder (question_id 前缀) | state | 冻结 head | carrier | created | issue | 映射 PR | PR 实际状态(REST 实查) |
|---|---|---|---|---|---|---|---|
| workflow-gate:c55ee7bb… | materializing | 59fea1c3 | unbound | 06:40 | FLY-1603 | #762 | **merged 07:05,head=70963adc ≠ 59fea1c3** |
| workflow-gate:10fb6e6f… | materializing | de75bb37 | unbound | 09:28 | FLY-1608 | #765 | **merged 15:05,head=a94fcf36 ≠ de75bb37** |
| workflow-gate:5535e0e1… | awaiting_review | 8906cee1 | bound | 09:46 | FLY-1609 | #766 | open,head=8906cee1(一致) |

PR 号映射经 `getWorkflowRunPrNumber`:按 issue 的 session 集合唯一 PR 号回退推导。

## 2. 回答 Lead 的两个问题

### (a) 为什么 PR 已 merge 它还不停?

dispatcher 拿到 merged 观察后(`workflow-engine-dispatcher.ts:528` 起):

```
if (probe.state !== "merged") continue;                          // open → 什么都不记,下秒再探
if (mergedHead !== candidate.subjectDigest) { log("merged head held"); continue; }   // ← #762/#765 卡死在这
if (holderState !== "approved") { recordRunnerShipRogueMerge(); continue; }          // 事件+告警一次,但 run 保持 active
completeWorkflowGateRunAfterShip(...)                            // 唯一让候选出队的路
```

- **#762(FLY-1603)与 #765(FLY-1608)**:gate holder 在 PR 早期就冻结了 subjectDigest(head_sha),之后 runner 又 push 过(review 修复),merge 时的真实 head 已漂移 → 走 `merged head held` 分支:**只打一行 log 就 continue**。这个观察不落任何持久标记,holder 行原封不动,下一 pass(≈2 秒后)候选原样回来,再探一发。merge 后 9 小时的连续轮询 = 这个死胡同每 2 秒转一圈。
- **rogue 分支同病**:`recordRunnerShipRogueMerge` 写入 event(按 event_uid 去重)+ 一次 severe 告警,但按设计「run 保持 active、绝不 finalize」→ 候选照样在列,照样每秒探测。事件表里明明已经有「见过 merged」的持久证据,**探测列表不查它**。
- 一句话:**死胡同观察没有停表机制** —— 探测结果除了用来尝试状态转移之外全部被丢弃,`listRunnerShipHoldersForMergeProbe` 没有任何「已观察到 merged / 已告警」的排除条件。
- 关于「session 曾在 ship_parked」:那是 session/receipt 层的现象;直接原因在 engine 层 —— `workflow_gate_holder` 行是死胡同,与 session 状态无关。FLY-1603/FLY-1608 的 PR 实际经典 ship 路径已 merge,engine-owned run 却还挂在 gate 节点上等一个永远不会匹配的 head。

### (b) 为什么轮询背靠背无间隔?

三层叠加:
1. **节奏源**:`WorkflowEngineDispatcher` 的 tick 是 1 秒(为 dispatch intent 响应性设计),`reconcileRunnerShipMerges` 搭在每个 tick 上,且在 `shipReadyNotifyEnabled` 开关**之前**执行(无开关可关)。
2. **面内零节流**:`classifyRunnerShipMerged` 是 Bridge 五个 gh PR 探测面里唯一没有任何缓存/预算/退避的(对照表见 research.md §2)。同文件 40 行之上的兄弟函数 `classifyShipHandled` 五种纪律齐全 —— 这个面在 PR #690(emit ship approval only at terminal DAG Gate)落地时漏装了。
3. **串行即接续**:`this.reconciling` 守卫防重叠但不产生间隔;pass 时长(≈gh 调用时长)一结束,下一 tick 立刻开下一轮 → 观察上就是背靠背。

### 当下仍在烧(本 session 实测)

- 6 秒进程采样(2026-08-03 ~16:30)抓到 `gh pr view 762` 与 `gh pr view 765` 进行中;
- 配额 curl 直读(不经 gh api rate_limit,避免污染读数):`graphql used 4783/5000`。

## 3. 修复方向(候选与取舍)

### Fix A — 死胡同停表:durable dead-end memo(推荐)

merged 观察落到不能完成的分支(head mismatch / rogue / completion 被拒)时,把观察**持久化**(复用 `workflow_run_event` 的 event_uid 去重语义),候选枚举时排除「memo 与当前 (state, head_sha, mergedHead) 匹配」的 holder:
- **正确性保持**:run 依然 active、绝不自动 finalize(rogue/mismatch 的安全语义原封不动);只是**不再重复问 GitHub 一个已经知道答案的问题**。
- **自动重臂**:memo 按 (holder state, holder head) 键控 —— founder 后来批准(state→approved)或 head 重绑(re-push 重冻结)都会让 key 失配,探测自动恢复,一发就能走完 `completeWorkflowGateRunAfterShip`。
- head-mismatch 死胡同目前只有 log,**升级为一次性 severe 告警**(与 rogue 同级):「PR merged 但 head 与 gate 冻结值不一致」本来就是需要人看的异常,今天这两单没人知道。

### Fix B — 健康路径节流:给 classifyRunnerShipMerged 装兄弟面同款纪律

open PR 的合法等待(如 #766)也不该被 1 秒一发地探测。把 `createWorkflowShipReadyHandledClassifier` 已验证的纪律搬过来:merged 定格缓存、open/closed 短 TTL(默认 60s)、unknown 退避梯(30s→5min)、每项目每分钟预算(6 次)、single-flight。效果:单个健康候选 ~60 次/小时,三个候选 <200 点/小时,<预算 4%。

### Fix C — 吸收 pre-flight 一行修复

`fix/fly1620-preflight-rest`(已实测有效:GraphQL 0/5000 时 pre-flight 过、529 slot 2 部署成功)吸收进本单分支:`gh repo view` → `gh api repos/<slug>`,报错三态拆分(存在 / 确认不存在 / **查不成 ≠ 不存在**)。

### Fix D(可选,时间够才做)— 17 处 gh 名词动词 → gh api 迁移 + CI 静态守卫

Lead 已数出 17 处(排除注释;检查类必迁,动作类如 gh pr create/merge 无等价 REST 时显式豁免+写理由)。守卫必须:纯静态扫描(不联网)、**证明会红**(造违规必红、删之必绿)、baseline 棘轮(条目消失也报错)。时间不够 → 记回 issue。

### 已否决的方向

- **把 dispatcher tick 放慢**:1s tick 服务 dispatch intent 响应性,动它伤及无辜;燃烧问题在面内纪律,不在 tick 本身。
- **只加节流不加停表**:死胡同候选即使 60s 一探也是永续浪费,且掩盖「merged-but-stranded run」这个真实异常 —— 停表 + 一次性告警才是对的语义。
- **探测到 merged+mismatch 就自动完成 run**:违反 PR #690/FLY-1462 的安全边界(未经证明的 head 不得 finalize),绝不做。

## 4. 边界(本单不做)

- 不解决「gate holder 的 subjectDigest 为什么不随 re-push 重冻结」(FLY-1603/1608 死胡同的上游成因)—— 单独记 follow-up;本单保证它不再烧配额、且有一次性告警可见。
- 不清理已 stranded 的 FLY-1603/FLY-1608 两条 run(运维动作,告警后由 Lead/founder 决定);
- 「定期从 main 起一次 529 房」归 FLY-1235。
