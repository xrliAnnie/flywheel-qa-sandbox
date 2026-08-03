# FLY-1624 GitHub 配额燃烧根源 — 技术调研

Issue: FLY-1624 (https://linear.app/geoforge3d/issue/FLY-1624/529仪器说谎-pre-flight-用-gh-repo-viewgraphql-查沙箱仓库-配额耗尽被报成仓库不存在-一条跑不通的)
日期: 2026-08-03
基于: exploration.md

## 1. GitHub API 配额事实(Lead 实测 + 本 session 复核)

- REST 与 GraphQL 是**两条独立**的 5000/小时配额。
- `gh <名词> <动词>`(pr view / pr list / issue list / run list / repo view)走 **GraphQL**;`gh api <REST 路径>` 走 **core(REST)**。
- Lead 用 curl 直读 rate_limit 测得的每命令增量:`gh issue list` +6、`gh pr list` +3、`gh run list` +2、`gh api repos/<slug>` +0(GraphQL 侧)。
- 量具纪律:**读配额必须 curl 直打 `https://api.github.com/rate_limit`**,不要用 `gh api rate_limit` 当量具 —— gh 自身的运行会污染 GraphQL 读数。
- 本 session 复核(2026-08-03 ~16:30):`graphql used 4783/5000`,燃烧进行中。

## 2. Bridge 内 gh PR 探测面全量盘点(核心对照表)

| # | 探测面 | 文件 | 节奏 | 每项目预算 | 缓存 | 退避 | 死胡同处理 |
|---|---|---|---|---|---|---|---|
| 1 | external-merge sweeper `pass()` | bridge/external-merge-reconcile.ts | GatePoller 每 20 tick ≈ 60s | 3/pass + rotation | 非 merged 10min negative cache | rotation 即摊薄 | archive/finalization claim 过滤出队 |
| 2 | `classifyShipHandled`(stalled ship-ready 提醒守卫) | bridge/workflow-ship-ready-arm.ts:257 | dispatcher tick 内被调,但面内自限 | 6/min | merged 定格;open/closed 15s TTL | unknown 30s→5min 梯 | founder_approved 短路;active 集合外自动清 state |
| 3 | **`classifyRunnerShipMerged`** | bridge/workflow-ship-ready-arm.ts:185 | **dispatcher 每 1s tick,每 tick 全量** | **无** | **无** | **无** | **无 —— 三个 continue 分支全部裸退,候选永续** |
| 4 | merged-gate-guard | bridge/merged-gate-guard.ts | 各 recovery surface 按需 | 6/min | merged 定格 + TTL | BACKOFF_MS 梯 + FAILURE_DEADLINE terminal | durable failure row,terminal 后停 |
| 5 | `checkPrStateViaGh`(FLY-742 stale-blocker) | bridge/plugin.ts:826 | 仅 parked 且 idle 超 `FLYWHEEL_CRON_STALE_TTL_MIN`(默认 120min)后 | 事件驱动,量极小 | — | — | — |

结论:面 3 是唯一无纪律面。修复即「把面 2/4 已验证的纪律装到面 3」+「补面 3 独有的死胡同停表」。

## 3. 面 3 的完整生命周期(代码级)

### 3.1 候选枚举 — `StateStore.listRunnerShipHoldersForMergeProbe()`(StateStore.ts:31034)

```sql
SELECT h.*, r.issue_id, r.project_name, r.snapshot
  FROM workflow_gate_holder h
  JOIN workflow_run r ON r.run_id = h.run_id
 WHERE h.authority_mode = 'runner_ship'
   AND h.state IN ('materializing','awaiting_review','approved')
   AND r.status = 'active' AND r.engine_owned = 1
   AND r.gate_carrier_epoch = 1 AND r.current_node_id = h.gate_node_id
```

- 排除条件里**没有任何探测历史/观察结果**维度 —— 这是死胡同永续的结构性原因。
- PR 号来自 `getWorkflowRunPrNumber(runId, head)`:先按 `pr_head_sha` 精确匹配 session,失配则回退「该 issue 全部 session 恰好只有一个 PR 号」。head 漂移场景走回退路径(FLY-1603/1608 即如此)。
- 本地同步 SQL,每秒跑没有成本问题;成本全在后面的 gh 调用。

### 3.2 探测 — `classifyRunnerShipMerged(batch)`(workflow-ship-ready-arm.ts:185)

对 batch 每项:`Promise.all` 并发 `checkPrMerge(projectRoot, prNumber, PROBE_TIMEOUT_MS=2500)`。任何错误 → `{state:"unknown"}`。**没有任何状态保留在两次调用之间。**

### 3.3 消费 — `reconcileRunnerShipMerges`(workflow-engine-dispatcher.ts:505)

| 观察 | 分支 | 持久痕迹 | 候选出队? |
|---|---|---|---|
| open / closed / unknown | `continue` | 无 | 否(下秒再探) |
| merged, mergedHead ≠ subjectDigest | log "merged head held" | **无** | **否(永续)** ← #762/#765 |
| merged, head 匹配, state ≠ approved | `recordRunnerShipRogueMerge` | run_event(uid 去重)+ severe 告警一次 | **否(永续)** |
| merged, head 匹配, state = approved | `completeWorkflowGateRunAfterShip` | run completed | 是(唯一出口) |
| complete 返回 not-ok | log "completion held" | 无 | 否 |

### 3.4 节奏 — `WorkflowEngineDispatcher`

- `start(intervalMs = 1_000)`(workflow-engine-dispatcher.ts:249);plugin.ts:5656 用默认值。
- `reconcile()` 首行 `if (this.reconciling) return` —— 防重叠、不产生间隔;pass 结束后下一 tick(≤1s)立刻续。
- `reconcileRunnerShipMerges` 在 `reconcileWorkflowShipReady()` 里位于 `shipReadyNotifyEnabled(this.env)` 检查**之前**,无开关。
- 出处:PR #690「fix: emit ship approval only at terminal DAG Gate」(git log -S classifyRunnerShipMerged)。

## 4. 可复用的既有机制

### 4.1 `workflow_run_event` 的 event_uid 去重(durable memo 的载体)

`appendWorkflowRunEventTx({runId, eventUid, ...})` 返回 `{deduped}` —— 同 uid 二次写入为幂等 no-op。`recordRunnerShipRogueMerge` 已用它做「一次性告警」。**dead-end memo 直接复用此表**:uid 含 (questionId, holder.state, holder.head_sha),holder 状态或 head 变化 ⇒ uid 变 ⇒ 天然重臂,不需要新表、不需要迁移。

排除查询形状(实现节点定稿):枚举后在 store 层按 uid 存在性过滤,或 SQL `NOT EXISTS` 关联 `workflow_run_event`。二者皆 restart-safe(表是持久的)。

### 4.2 `createWorkflowShipReadyHandledClassifier` 的节流五件套(面 2,同文件)

per-key 定格/TTL 缓存 + single-flight(inFlight Map)+ 每项目滑动窗口预算(projectProbeTimes)+ unknown 退避梯(states Map)+ active 集合清理。**同文件、同类型依赖、已被生产验证** —— Fix B 的实现即把 `classifyRunnerShipMerged` 从无状态函数改为同款带状态 closure,或抽一个共享 probe-engine 供两者各自实例化。

### 4.3 关于新增 env 开关的取舍

倾向**不加新 flag**:
- FLY-1456/FLY-1466 的方向是 flag 收敛,Annie 有明确「不加新 flag」铁律先例;
- Fix A 的语义是安全的(memo 只在确证 merged 观察后写;排除即「不再重复问已知答案」),Fix B 是给裸面补上兄弟面同款默认纪律;
- 回退路径 = git revert + Bridge 重启,与其它 Bridge 行为修复一致。
最终由 codex design review 把关;若 review 要求逃生口,再加单一 kill-switch。

## 5. 参数选型依据

| 参数 | 值 | 依据 |
|---|---|---|
| open/closed TTL | 60s | founder 批准→runner merge→engine 收敛,分钟级容忍(FLY-1505 同级);60s ⇒ 单健康候选 60 次/h ≈ 60 点/h |
| unknown 退避梯 | 30s→60s→120s→240s→300s | 与面 2 `UNKNOWN_BACKOFF_MS` 完全一致 |
| 每项目预算 | 6/min,独立实例 | 与面 2/4 一致;独立实例避免分食 `classifyShipHandled` 预算、不改兄弟面行为。上限合计 ≈ 12/min/project = 720 点/h,<15% 预算 |
| merged 缓存 | 定格(active 集合内不再探) | 与面 2 一致;merged 是终态 |
| dead-end memo | 无 TTL,key=(questionId,state,head) | 状态机键控重臂;比 TTL 语义精确 —— 没有任何状态变化时重探只能得到同一答案 |

## 6. 修复后的量化预期

| 场景 | 修前 | 修后 |
|---|---|---|
| 2 个死胡同候选(#762/#765) | ~2,400–3,600 次/h,永续 | **每个 (state,head) 组合恰 1 次探测 + 1 次告警,然后 0** |
| 1 个健康 open 候选(#766) | ~1,200–1,800 次/h | ≤60 次/h |
| 无候选 | 0(本来就 0) | 0 |
| 合计(今日形态) | ≈5,000+ 点/h,烧穿预算 | **<70 点/h** |

验收采样法与 Lead 相同:60s × 0.5s 进程快照,数 gh 命中;修前基线已有(55/52/50 per 120)。

## 7. pre-flight 修复(Fix C)与可选项(Fix D)的现状

- `fix/fly1620-preflight-rest`(head `5dde8e90`,单文件 scripts/test-deploy.sh +11/−2)已把沙箱检查改 REST 且拆了三态文案;已实测:GraphQL 0/5000 时 pre-flight 通过、529 slot 2 部署成功。吸收方式:本单分支 cherry-pick 该 commit(保留原 authorship)。
- Fix D 素材(Lead 已盘):17 处 `gh <名词> <动词>`(排除注释),分布 scripts/test-deploy.sh、self-ship-restart.sh、flywheel-buddy-steps.sh(92/97 行是「查不到就创建」高危同款)、nested-manual-closeout.sh、qa-fly-60-driver.sh、packages/edge-worker/*、packages/teamlead/src/bridge/*;`gh api graphql` 显式用法 0 处。守卫判据(Lead 硬要求,F8 同尺):纯静态、证明会红、baseline 棘轮且条目消失必报。
