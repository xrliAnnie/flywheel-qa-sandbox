# FLY-1390 DAG-only 清算审计 — 调研(证据卷)

Issue: FLY-1390 (https://linear.app/geoforge3d/issue/FLY-1390/auditdag-only-清算-在飞-issuepr设计全量重判-legacy-冻结令下的还要改造删逐单裁定证据级)
日期: 2026-07-20
基于: exploration.md

> 本文是证据卷。裁定表在 plan.md。凡本文写 `unverified` 的,plan.md 不得给出确定裁定。

## ⚠️ 引用 provenance(复核 MEDIUM-1;**核对前必读**)

本文有一部分 `file:line` 指向的是**未合并 PR 的分支**,不是 main。**照着 main 去核会核不到、
或核到完全无关的代码**,进而误以为审计在编造。对照表:

| 引用所在 | 实际所在分支 | 在 main 上是什么 |
|----------|-------------|------------------|
| `runs-route.ts:812`(A-1) | `origin/flywheel-FLY-1293` | main 的 `:812` 是 `DAG_RUN_STATE_CORRUPT` 处理里的 `).schema_version;`,**无关** |
| `phase-orchestrator.ts:665-667`(A-1) | `origin/flywheel-FLY-1293` | **main 上 `admitManualPhase` 根本不存在**(grep 零命中);`:665` 是 re-QA 派发代码 |
| `wake.ts` / `wake-*.ts` / `registry.ts` 的 `wake_ledger`(A-2、R-1) | `origin/flywheel-FLY-1339` | **`wake_ledger` flag 在 main 上不存在** |

核这几条请用 `git show origin/flywheel-FLY-1293:packages/...` 形式。
**其余所有引用(B/C/D 批、引擎层、StateStore、tmux-lookup 等)均在 main 上成立。**

## 0. 全局前提(先核的,影响所有裁定)

`.flywheel/config.yaml:250-260`:

```yaml
pipeline:
  three_stage: true
  three_stage_channels: ["1516209714097291335"]   # #flywheel-engineer
  dag: true                                        # FLY-1372 灰度,仅 flywheel
```

**两条 pipeline 当前同时开着。** DAG 是灰度试点,legacy 三段式仍在 #flywheel-engineer
的实际派单路径上。冻结是方向决策,不是代码现状。

⇒ 每条 "legacy-only → 弃" 的裁定,风险列必须写明「legacy 完全退役前,该缺陷裸奔」。

## A 批 · 停在 founder gate 的四个 PR

### A-3. PR #647 / FLY-1340 — code review 架构面前移

**本来做什么**:第一轮 code review 的 prompt 面改为「带 design 文档对照实现,优先查
架构/耦合/契约偏离」,风格问题降级后置。

**证据 · 判定为 pipeline-agnostic(不是 legacy-only)**:

1. `packages/teamlead/src/bridge/review-request-coordinator.ts` 全文
   `grep -n "three-stage\|threeStage\|phase\|workflow\|dag"` → **零命中**。imports
   (`:26-46`)是 StateStore / claude-review-runner / review-governance-prompt /
   review-verdict-policy,**没有** phase-orchestrator、**没有** three-stage-policy。
2. 入口是 HTTP 路由不是 phase 转换:`plugin.ts:1474` 挂 `/review-requests`;调用方是
   runner 侧 CLI `flywheel-comm/src/commands/request-review.ts:128`。
3. 路由键是**作者 family**,不是 pipeline stage:`review-request-coordinator.ts:504-509`
   `adapterTypeToFamily(session.adapter_type)`;`event-route.ts:335` 按
   `adapter_type === "codex-tmux"` 分流。`adapter_type` 是 session 属性,**DAG 下继续存在**。
4. **DAG 派单走同一条 start 路径**:`workflow-engine-dispatcher.ts:450` 调
   `this.options.startDispatcher.start({...})`,payload 与 legacy run-start 同构。
   DAG 节点派给 codex vendor → 产生 `codex-tmux` session → 跳过 legacy Codex 触发 →
   **必须**走 `request-review` → 命中本 coordinator。**即本文件在 DAG 关键路径上。**

**源码改动量**:`review-request-coordinator.ts` +44/-6。新增 `resolveHumanIssueRef()`,
prompt 拆成 `legacyCodeTarget` vs `architectureFirstCodeTarget` +
`architectureFirstSeverityPolicy`,均由既有 `policyEnabled` flag 门控。
kill switch:`FLYWHEEL_REVIEW_SEVERITY_POLICY=0` 逐字还原旧 prompt(plan.md §0 不变量 I3)。

**一个真实的 DAG 时代假设问题(在文档里,不在代码里)**:
`exploration.md §6` 原文:「**假设**:三段式项目的 design 文档在 PR 分支上可读(design
phase 先 commit docs 再 implement —— 三段式共享分支保证了这点)」。该假设**显式以三段式
共享分支语义为依据**。而 DAG 下 trusted docs materializer 写的是**独立 ref**:
`workflow-docs-materializer.ts:227` `` const ref = `refs/heads/flywheel/docs/${safeProject}/${safeIssue}`; ``
—— 引擎物化的文档**不落 PR 分支**。

好消息是实现是安全降级而非失效:`architectureFirstCodeTarget` 写明
"If no design doc exists, state that in your review and skip the design-conformance layer."
⇒ DAG run 得到的是「正确但空转」的 review(第一层静默跳过),不是错误 review。

**附带事实**:dispatcher 仍用 `isThreeStagePhaseRole(node.type)` 决定 `sessionRole`
(`workflow-engine-dispatcher.ts:449,457`)—— **DAG 复用了 phase 角色名**。所以
"design/implement/qa" 作为节点类型本身**并未随冻结令作废**。这条对 B 批也有意义。

**unverified**:Lane 1(Claude 作者 → Codex 审)改的是机器级
`~/.claude/commands/codex-code-review.md`,仓内无 canonical 副本(exploration.md §2.2
自承)。未读该机器文件 ⇒ **Lane 1 的实际效果本仓无法审计**。

---

### A-4. PR #641 / FLY-1342 — head-churn 治理设计 + founder HTML

**本来做什么**:Annie 直令(2026-07-17)「head-churn 不做独立小修,重新设计并进 DAG
语义,出 founder 可读 HTML 她拍板后再实施」。交付 = 设计文档 + founder brief(7 个
build/don't-build 决策项)。

**证据 · 纯 docs**:`gh pr diff 641 --name-only` → 11 文件,全在
`engineering/doc/FLY-1342-head-churn-binding-hygiene/` 下。**零 `packages/` 改动。**

**证据 · 「并进 DAG 语义」的自我申报**属实(独立核过,不只采信申报):

- plan.md 首行:`# FLY-1342 head-churn 治理并进 DAG — 实施计划`,日期 `2026-07-17`
- §2 标题:「目标态 · 引擎规则四件套(落 FLY-1135/1307 workflow 引擎)」
- §2.1 提的是 DAG 原生原语:node-type registry 新增闭集字段
  `git_write_surface ∈ {branch_writer, none}`、`workflow_node_outputs`、claims 证据、
  trusted materializer。且引用活的 DAG 代码作基线:
  `packages/config/src/node-type-registry.ts:91-100`、
  `packages/teamlead/src/workflow-run-snapshot.ts:187-196`、`StateStore.ts:12053-12054`、
  `workflow-docs-materializer.ts:214-231`
  - registry 那条**已独立核实**:`node-type-registry.ts` 的 qa 条目确有
    `shared_branch_writer: true` 与 `qa_verdict_emitter: true`,与设计所述一致
- §2.2 写在 FLY-1135 loop-edge 语义内:「不新增 loop 条件、不扩 FLY-1135 闭集
  (qa_fail / review_fail / founder_feedback_kickback 原样)」
- §8 验收第 2 条:「设计与 FLY-1135 已批不变量零冲突」

**证据 · 承重的绑定概念是通用的,不是 phase 概念**(research.md §1 三条绑定全锚在 PR head sha):

| 绑定 | 锚点 | file:line |
|------|------|-----------|
| founder 批准 | `pr_head_sha`,失败态 `pr_head_sha_mismatch` | `verify-approval.ts:270-519`(:483-490);写入 `StateStore.setReviewBinding` `StateStore.ts:4196-4209` |
| codex review | 主键 `(execution_id, target_pr_head_sha)` | `StateStore.ts:2140-2156` |
| QA | `auto_qa_record` held 谓词严格按 `(execution_id, 当前 pr_head_sha)` | `auto-qa-held.ts:87-227` |

三者**均非三段式概念,DAG 下原样成立**。research.md §5 已把它们映射到 DAG claims ledger
(`workflow_claims`,`subject_kind ∈ {git_head, snapshot_digest}`,USE-time 复验)。

**证据 · 唯一焊死在 legacy 的部分 = §3「过渡期轻规矩包」(子单 B1)**:

- §3.1 要改的 writer 清单:「phase-orchestrator.ts 把 QA 当 branch writer / 要求 findings
  已推送的位点(**:1351, :1435, :1485-1496, :1646**)」→ **直接修理被冻结的 legacy 协调器**
- §3.1 另一目标:`Blueprint.ts QA phase 指令(:1230-1255)`
- §3.3 验收:「**真机一条三段式全链**」→ 验收定义在三段式 run 上
- §0 产物表:「过渡态 = 三段式 QA phase 直接 commit 测试代码(现状)」
- §7 风险 1:「过渡包改 Blueprint/phase-orchestrator 提示词 = 改生产行为」

⇒ **§2(目标态,DAG 原生)+ §4/§6-B3 完好;§3 / 子单 B1 在冻结令下已死。**

**证据 · 与 FLY-1385 的关系 = 正交,无冲突**:

- FLY-1385 治的是 **liveness**:node 卡 `running`、exec 已死、无重试无杠杆
- FLY-1342 治的是 **binding integrity**:过程产物动 head → 使 head-bound claims
  (`codex_review_record` / `auto_qa_record` / founder `pr_head_sha`)失效
- 机制零重叠。轻微邻接一处:1385 第 5 项讲 `Blueprint.ts:847` `ctx.startPoint` 是冻结记录
  非分支 tip;1342 §2.2 引入 `expected_old_head` + branch-writer lease + push 回执。
  两者都在推理「哪个 head 对本次尝试有权威」。B3 定 scope 时值得交叉引用 —— 但
  **是否真会冲突 = unverified**(1385 尚无设计文档)。

**核到的一个空缺**:`grep -rln "FLY-1385"` 全树只命中
`.claude/skills/linear-issue-context/SKILL.md`(即本审计任务简报自身)。本地与 origin
**无 `*1385*` 分支**,任何分支上**无 `engineering/doc/FLY-1385-*` 目录**。
⇒ FLY-1385 目前只有 Linear issue,尚无任何代码/设计产物。

**unverified**:1385 issue 引用 `DirectEventSink.ts:1112-1118`,但本仓该文件在
`packages/teamlead/src/DirectEventSink.ts`(不在 `bridge/` 下)。held-teardown 机制
本身未由本 lane 读代码复核 —— 交由 B/D lane 核(见下)。

---

## C 批 · Batch 4.3 五单

### C-1. FLY-1374 — Discord 显示与 session 现实对齐(双对账器)

**⚠️ 本单最重要的发现:它的事实前提大面积过期。**

**前提证伪 1 — 对账器(a)「进程现实 → sessions 表」已存在,且比 1374 的草图更完善**:

`packages/teamlead/src/bridge/tmux-lookup.ts:371` `probeRunnerProcessLiveness()` 就是
1374 要的 pane_dead 探针(逐 pane 读 `#{pane_dead}` 的四态探针):

```
tmux-lookup.ts:399-401
	return panes.every((p) => p === "1") ? "dead_pin" : "alive";
```

已被常驻循环消费:`HeartbeatService.ts:1227, :1765, :2435`、
`bridge/terminal-thread-archive.ts:137`。周期驱动 = `reconcileMonitorLoss()`
(`HeartbeatService.ts:897`,分派 `:909` legacy / `:975` readopt),在 heartbeat tick
`HeartbeatService.ts:643` 调用。`bridge/crash-reaper.ts:1-25`(FLY-720)文档化了纠正
`status=running` 僵尸的两阶段 reap。

真实缺口(小):**无** `pgrep -f runner-<exec>`、**无** CPU-delta 佐证腿。
`pgrep` 全仓只出现在 `bridge/fleet-data.ts:951,958` 且是 `pgrep -P`(枚举子进程),
不是 runner 匹配。⇒ pane_dead 腿已发货,pgrep + CPU-delta 两条佐证腿确实缺。

**前提证伪 2 — 对账器(b)「sessions 表 → Discord 标题幂等重渲染」已作为 FLY-907 发货**:

`bridge/issue-display-refresher.ts:1-20` 是统一 refresher,覆盖「A 标题 badge / B 置顶
pipeline header / C 三段式状态行」,且**显式由每个生命周期源触发而非只由 `stage_changed`
触发** —— 这逐字就是 1374 的诉求。幂等 sweep = `runSweep()`(`:538`),接进 GatePoller
tick(`plugin.ts:7086`)。

**前提证伪 3 — `display_reconciled_at` 不是半截,已建完并在写**:

```
StateStore.ts:1830        display_reconciled_at TEXT                     (schema)
StateStore.ts:11206-11208 ALTER TABLE ... ADD COLUMN                     (迁移)
StateStore.ts:7065        SET display_fingerprint = ?, display_reconciled_at = ?  (写)
```
写方法 `setChatThreadDisplayFingerprint`(`StateStore.ts:7057`)有真实调用方
`issue-display-refresher.ts:919`;读侧 `listDisplayReconcileCandidates`
(`StateStore.ts:7080`)被 `issue-display-refresher.ts:546` 调用;测试在
`__tests__/issue-display-refresher.test.ts:237,849,895,920,933`。
⇒ **1374 里「半截建设的列」这个前提为假。**

**前提证伪 4 — 1374 点名的两个「上游」并不是覆盖它的那两个**:

- FLY-1373(`88cfecce9`)= 113 文件 / +9627,内容是 Lead inbox consume loop
  (`lead-inbox-loop.ts` / `lead-inbox-runtime.ts` / `protocol-ingress.ts` /
  `legacy-lead-event-reconciler.ts` / `CodexLeadInboxSocket.ts`)
- FLY-1099(PR #545,merged 2026-07-11)= founder-reply ingest
  (`founder-reply-deliverer.ts` / `deferred-approval.ts` / `zombie-gate-hygiene.ts`)
- **两者都没碰** `issue-display-refresher.ts` 或 pane 探针

⇒ 真正覆盖 1374 的是 **FLY-907 与 FLY-720**,不是 issue 里写的 1373/1099。

**三段式耦合:有,而且恰在已发货的那一半**:
```
issue-display-refresher.ts:6    C three-stage status line
issue-display-refresher.ts:32   type ThreeStagePhase,
issue-display-refresher.ts:173  // FLY-892 (Step 6): ... three-stage issue the title prefix is the STAGE-level
issue-display-refresher.ts:642  const isThreeStage = latestPhase.length > 0;
issue-display-refresher.ts:655  new Map<ThreeStagePhase, PhaseDisplayState>();
```
从 `flywheel-config` import `THREE_STAGE_PHASE_SEQUENCE` / `ThreeStagePhase`。
⇒ DAG-only 下,1374 想重算的「应有标题前缀」是**从一个被冻结的概念推导出来的**。
对账器(a)则不耦合(pane liveness 与 pipeline 无关)。

**仍 unverified 的三个小项**(1374 顺带折入的 Discord 卫生族):
- 路由守卫钝化:`grep -rln "route-guard\|routeGuard"` 在 `packages/teamlead/src` **零命中**
- chat-threads/send 长文 thread-split:无 `chat-threads/send` 模块,只有
  `chat-thread-register.ts` / `chat-thread-utils.ts`
- 重启 archive 级联锁死活单(403 locked):thread-archive 路径未找到 403/locked 处理

---

### C-3. FLY-1363 — comm.db 弄脏 main 挡住 6am 部署

**当前状态:已被忽略,但走的是机器本地、不传播的机制。**

```
$ cd /Users/xiaorongli/Dev/flywheel && git check-ignore -v .flywheel/comm.db
.git/info/exclude:60:.flywheel/comm.db	.flywheel/comm.db     (exit=0)
```

是 `.git/info/exclude` 第 60 行,**不是 `.gitignore`**。被追踪的 `.gitignore` 只有
`packages/*/.flywheel/`(第 36 行),匹配不到根部 `.flywheel/comm.db`。
`git status --short`(main)当前干净 ⇒ **症状只在这台机器上被压住;任何新 clone 或
换机器即复发。**

**preflight 逻辑** `scripts/update-flywheel.sh:78-81`:
```bash
  # Clean-checkout preflight (single-writer; rollback also requires it).
  if [[ -n "$(git -C "$FLYWHEEL_DIR" status --porcelain 2>/dev/null)" ]]; then
    log "main checkout dirty — refusing deploy (single-writer preflight)"; return 3
```
**不区分** untracked-runtime 与源码改动 —— 裸 `--porcelain`,有任何输出即拒。
且告警是**阈值门控而非即时**:`ssq_record_failure` → 只有 `rec == 10` 才触发
`ssq_block` + `severe_alert`(`:183-186`)⇒ 前 N 次 dirty-checkout 拒绝是静默的,
这正是本单命名的「静默失败」。

**暂留工作**:`/Users/xiaorongli/Dev/flywheel-FLY-1363`,分支 `flywheel-FLY-1363`,
HEAD `9b344744b`,领先 main **14 个 commit,全是设计文档、零实现**:
```
9b344744b chore(progress): FLY-1363 design 3/4
cbd17ad45 FLY-1363: plan R7 revision — parked no-deploy loop closes the cross-process hot-loop
53a572c51 FLY-1363: plan R6 revision — side-effect-free pnpmfile guard
... (R5..R1, research+plan, exploration)
d2f243cb9 FLY-1363: exploration — updater silent failure root-cause reconstruction
```
`git status --short` → ` M engineering/doc/FLY-1363-updater-silent-failure/plan.md`(未提交的 plan 编辑)。
plan scope(按 commit message):分级 preflight、calendar-path 告警、gitignore 采纳、plist 对账。
**未 merge 到 main**(main 上不存在 `engineering/doc/*1363*`)。

**三段式耦合:无。** `scripts/update-flywheel.sh` 零 `phase-orchestrator` /
`three-stage-policy` / `pipeline.three_stage` 引用。

---

### C-4. FLY-1364 — cmux 死 tab 不清理

**⚠️ 前提部分证伪:现象为真,但点名的文件是错的。**

`packages/teamlead/src/bridge/repo-mutation-lock.ts`(全文 90 行已读)**完全没有 lease
逻辑**。它是基于 `AsyncLocalStorage` 的、按 canonical 主仓路径分键的**进程内可重入
异步互斥锁**:
```
repo-mutation-lock.ts:1-3   FLY-1185 §2.11 — per-main-repo mutation coordinator.
                            In-process async mutex keyed by the CANONICAL main-repo path.
repo-mutation-lock.ts:41    const tails = new Map<string, Promise<void>>();
```
无 "unverifiable" 分支、无 fail-safe 方向、**没有可反转的东西**。它只有创建它的那一个
commit(`1b94701ae fix(FLY-1185) ... (#564)`),没有后续修复 —— 因为那里本就没东西要修。

**真正的 fail-closed-on-unverifiable 行为在别处**:`bridge/tmux-lookup.ts:363-366`
```
 *   - `indeterminate` — timeout / ENOENT / EACCES / unparseable: could NOT
 *                       determine liveness → caller treats as alive-for-suppression
 *                       (never reap), GEO-374 guard.
```
实现在 `tmux-lookup.ts:387-390`,log `pane-dead probe INDETERMINATE (fail-closed)` 后返回
`"indeterminate"`。`crash-reaper.ts:23-24` 确认后果:「`absent` / no-target /
indeterminate are NOT owned here」。第二处 fail-closed 在 `bridge/kind-contract.ts:228`
(「identity/lease incidents are deliberately fail-closed」)。
⇒ 「验证不了 → 当作锁着/活着 → 永不清理」**在当前 main 仍然为真**,只是不在本单点名的文件里。

**关键判断修正**:这个 fail-closed 方向是**刻意的、承重的** —— 它是有名的回归守卫
(GEO-374)。**反转它不是简单换极性**,需要有界逃生口(如连续 N 次 indeterminate 后按
时龄放行),而不是取反。

**可能已部分缓解**:`bridge/cmux-close-request.ts:1-27`(FLY-685)已提供权威的
「立刻关这个 pin」marker,约 15s 排空一次,并有 FLY-293 的 5 分钟 orphan reaper 兜底。
⇒ 残留死 tab 究竟是 indeterminate-probe 情形还是另一个 watcher bug = **unverified**。

**三段式耦合:无。** `repo-mutation-lock.ts` 对
`three_stage|three-stage|phase-orchestrator|ThreeStage` 零命中。worktree/cmux/tmux
生命周期与 pipeline 无关。

---

### C-5. FLY-802 — roundtable topic thread 1h 自动归档

**⚠️ 本单出现过一次「代码已发货但不满足现行规格」的错位,必须讲清时间线。**

**已发货的部分**(PR #423,`cf422a671`,merged 2026-07-03T08:31Z):
- 创建路径:`bridge/roundtable/ensure-thread-from-message.ts:76-78`
  `auto_archive_duration: ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES`;常量定义
  `roundtable-text.ts:25` = **60**,断言 `__tests__/roundtable-text.test.ts:10`
- 已存在-恢复路径:`RoundtableThreadManager.ts:446-461`,单次收敛 PATCH
- 测试断言创建为 60(`RoundtableThreadManager.test.ts:166`、
  `ensure-thread-from-message.test.ts:36`)与从 4320 收敛(`:665`, `:690`)
- merge 后无任何 802 代码落地:`git log --all --grep=802 --since=2026-07-01` 只有 `cf422a671`

**但 issue 在 2026-07-11 被重开,且 2026-07-17 换了规格。**(Linear comment 已直接读取核实)

- 2026-07-11 重开理由:堆了 86 条 thread 一条没归档,查证「很多 thread 的
  `auto_archive_duration` 还是 4320」⇒ 合了 PR ≠ 真生效
- 2026-07-17 Cass 现场诊断**纠正了根因框架**:roundtable 频道的
  `default_auto_archive_duration` **本来就是 60**(`GET /channels/...` 确认,Annie 设对了)。
  真因是 **Discord 不把频道的 `default_auto_archive_duration` 应用到 API/gateway 创建的
  thread** —— 该字段按 Discord 文档是「**clients** 用的默认值(not the API)」。
  插件的实时 gateway 赢得 create-race 且**未显式传** `auto_archive_duration` 时,
  Discord 给的是 API 默认 **4320**。现场证据:52 条活跃 roundtable thread → **48 条 4320,
  只有 4 条 60**(那 4 条是老的、host-bot 显式建的);最新的错 thread 只有 0.5h 龄 ⇒ 持续中,非遗留。
- **Annie 2026-07-17 的新要求(与已发货代码冲突)**:
  1. 多数频道**保持** 3 天,不动全局默认
  2. roundtable 是特例(1h)
  3. **不要在代码里硬编码 roundtable 的频道名/id**
- 新规格 = **读父频道自己的 `default_auto_archive_duration` 并显式传**,
  null → 显式 4320(2026-07-17 后续 comment:全 guild 29 个频道中 **28 个该字段为 null**,
  仅 #leads-roundtable = 60);外加一个 converge 对账器
- **对账器必须由带 `MANAGE_THREADS` 的 bot 跑**(否则对非自己创建的 thread 403 —— Cass 实撞)。
  已核 claw-infra-bot(`1524829037825101975`)有该权限;Lead bot 没有 ⇒ 必然 403

⇒ **已发货代码硬编码常量 60,恰恰违反 Annie 7/17 的第 3 条「不要硬编码」。**
本单不是「已覆盖」,而是**规格已变、代码需按新规格重做**。

**三段式耦合:无。** `packages/teamlead/src/bridge/roundtable/` 全目录零三段式命中。

**范围外(勿误伤)**:`ChatThreadCreator.ts:435` 的 `auto_archive_duration: 4320`(issue chat
thread,FLY-292 管)与 `AlertChannelHub.ts:87` 的 `1440`(alert thread)是不同 surface。

---

### C-2. FLY-1375 — ship 自动化 land 流程

见 plan.md 裁定。要点:issue 自身 §「DAG 形态」已写明「land 作为 DAG 工程模板的最后一个
节点(design→implement→qa→land);legacy 在飞单由 Lead 人肉执行 1338 范式过渡」
⇒ **天然 DAG 语境,冻结令不伤其主体**;只有「legacy 在飞单人肉过渡」那半句随 legacy 退役。

---

## A 批 · #642 / #648(源码逐文件追调用链)

### A-1. PR #642 / FLY-1293 — 三段式协调器交接完整性批修

**判定:mixed,约 80% 源码面 legacy-only。**

| 文件 | 改什么 | 判定 | 证据 |
|------|--------|------|------|
| `bridge/runs-route.ts` | +181,`POST /api/runs/start` 上新增「显式 phase 入册」块 | **legacy-only** | 整块门控在 `runs-route.ts:812` `isThreeStagePhaseRole(requestedRoleAtEntry) && candidateSchemaAtEntry !== 2` —— **schema-2(DAG workflow template)被显式排除**;再门控于 `:829` `if (policy.enabled)`(来自 `three-stage-policy.ts`) |
| `bridge/phase-orchestrator.ts` | +372,`admitManualPhase()` / `reconcileResident()` / `reconcileMissingTurnRows()` | **legacy-only** | `admitManualPhase` 硬拒 DAG 行:`:665-667` `if (rows.some((row) => this.isEngineOwned(row.execution_id))) return { ok:false, reason:"workflow-engine-owned phase history" }`。唯一调用方 `plugin.ts:6957`、`plugin.ts:8320`、`runs-route.ts:~880` |
| `bridge/run-dispatcher.ts` | 三件事 | **mixed** | (1) `postAdmissionInflight` 双启动去重 `:1160-1181` = **pipeline-agnostic**(无条件,位于 `RunDispatcher.start`,DAG 走同一入口 `workflow-engine-dispatcher.ts:450`);(2) `explicitPhaseAdmission` CAS + `compensateExplicitTurn` `:1369-1420`、(3) `probePhaseStartPoint()` `:488` = legacy-only(全部键于 `req.explicitPhaseAdmission`,仅由 `:812` 那个门控块设置) |
| `flywheel-comm/src/db.ts` | +351,`grantTurnIfMissing` `:2241` / `grantTurnIfParkedPredecessor` `:2327` / `restoreTurnIfCurrent` `:2385` | **legacy-only(就接线而言)** | 唯一非测试调用方:`run-dispatcher.ts:1226/1370/1393`(全 `explicitPhaseAdmission` 门控)+ `plugin.ts:8273`(PhaseOrchestrator `turnBelt` dep 块内)。**注**:TURN 表本身是共享的(DAG 经 `grantTurn` + `targetRunId` 授予,`run-dispatcher.ts:1414`)⇒ **原语语义中立,接线才是 legacy** |
| `bridge/plugin.ts` | `onThreeStageReconcileTick` 接线 `:6950-6963`、turnBelt deps `:8255-8290` | **legacy-only** | 全在 `new PhaseOrchestrator({...})`(`plugin.ts:7559`)构造内 / 为其服务 |
| `bridge/gate-poller.ts` | 新增通用 `onThreeStageReconcileTick` / `threeStageReconcileEveryNTicks` 槽 `:772-785`, `:1262` | **mixed** | 槽机制是通用 GatePoller slot(与既有 `onQaReconcileTick` 同形),但唯一生产者是 legacy reconcile(`plugin.ts:6953`)⇒ 可复用的缝,legacy 的载荷 |
| `bridge/retry-dispatcher.ts` | `ExplicitPhaseAuthorityChangedError` / `ExplicitPhaseAdmissionReceipt` / `probePhaseStartPoint?` | **legacy-only** | 类型只为承载三段式手动入册回执;`:44` 注释「RunDispatcher consumes it at the pre-launch TURN seam」 |
| `bridge/auto-qa-coordinator.ts` | `isCodexRecordableRole = isReviewableRole(role) \|\| role === "qa"` `:72` | **legacy-only** | 唯一行为差量针对 `session_role === "qa"`,而 qa 是 `THREE_STAGE_PHASE_SEQUENCE` 角色。`isReviewableRole`(`codex-gate.ts:50`)仍守着共享 auto-QA release 契约(`:1008`)⇒ **main/DAG 行为字节相同** |
| `bridge/issue-display.ts` | `deriveIssueTitleBadge` 里把 `blocked` 检查移到 `active` 之后 | **legacy-only** | 被移动的代码在 `phaseStates.size > 0` 分支内;`issue-display.ts:161` 文档化「an empty map = a non-three-stage issue」 |
| `edge-worker/src/Blueprint.ts` | 新增 `onAdapterDispatchStarted?: () => void` 钩子 `:230`,在 `:2089` `adapter.execute` 前触发 | **pipeline-agnostic** | Blueprint 是所有派单的共享执行引擎,钩子对所有 run 触发;只有**订阅方**是 legacy(`run-dispatcher.ts:1529`,spread 门控于 `req.explicitPhaseAdmission`) |
| `agent-team-transport/.../ClaudeCodeAdapter.ts` | 每次 Claude spawn env 设 `CLAUDE_CODE_TASK_LIST_ID: ctx.runnerName` | **pipeline-agnostic** | `buildSpawnArgs` 内无条件,hunk 内无任何 pipeline 谓词。**这正是 1293 缺陷④(Lead 任务清单注入 runner)的修复** |

**无 feature flag**:#642 未向 `feature-flags/registry.ts` 加任何条目,只加了调参旋钮
`FLYWHEEL_THREE_STAGE_RECONCILE_EVERY_N_TICKS` 的 allowlist(`feature-flags-drift.test.ts:254`),
默认 cadence 100 ticks(`gate-poller.ts:1263`)。其余全部搭在既有 `three_stage` policy +
`threeStageKeepAliveEnabled()` 门上。

**值得抢救的三件(DAG-only 下仍有价值)**:
1. `run-dispatcher.ts:1160-1181` 的 `postAdmissionInflight` 双启动去重 —— 关的是**共享**
   `RunDispatcher.start` 上首次去重读与生命周期准入之间的真实 TOCTOU,而
   `workflow-engine-dispatcher.ts:450` 走同一入口
2. `Blueprint.onAdapterDispatchStarted`(`Blueprint.ts:230/2089`)—— 通用的
   「adapter 已进入,birth 从此不确定」边界,DAG 引擎做自己的 launch 补偿时需要它
3. `ClaudeCodeAdapter` 的 `CLAUDE_CODE_TASK_LIST_ID` —— per-runner 任务清单命名空间,
   与 pipeline 完全正交(= 缺陷④的修复)

`db.ts` 的 CAS 原语(`grantTurnIfMissing` / `restoreTurnIfCurrent`)接线是 legacy,但语义
pipeline 中立;可作为库面保留,**但今天 DAG 路径无任何调用方**。

---

### A-2. PR #648 / FLY-1339 — phase handoff / park-wake 自动接力

**判定:mixed,但比例与 #642 相反 —— 约 85% 是 pipeline-agnostic 的共享 wake 基建。**

这是本审计**最反直觉**的一条:issue 标题写「三段式 phase handoff」,issue 描述自己也说
「引擎化后此层由引擎负责」,但**源码的绝大部分根本不是 phase 层的东西**。

| 文件 | 判定 | 证据 |
|------|------|------|
| `flywheel-comm/src/wake.ts` | **pipeline-agnostic** | `wakeRunnerMailbox` 是**全 fleet 的 wake 原语**。非-phase 调用方:`commands/send.ts:102`(Lead 指令)、`commands/respond.ts:128/223/294`(gate 回答)、`runner-wake.ts:168`、`gate-poller.ts:2170`(checkpoint-park 推)、`gate-poller.ts:3573`(founder action)、`founder-reply-deliverer.ts:621`(ship-gate 回复)。**只有 `plugin.ts:8385` 一处是 phase handoff** |
| `flywheel-comm/src/db.ts` | **pipeline-agnostic** | +901。`runner_phase_wakes` 表**键在 `execution_id`,不是 phase**。上面每个 `wakeRunnerMailbox` 调用方现在都往里写行 |
| `bridge/wake-recovery-patrol.ts`(新 361) | **pipeline-agnostic** | 接线在 `plugin.ts` 的 `projects.map(...)`,经 `store.getSession` 解析 —— **无任何 phase/role 过滤** |
| `bridge/wake-escalation-patrol.ts`(新 241) | **pipeline-agnostic** | 只按 `state === "pending" && admission_state === "queued"` 过滤(`:33-38`);终态集是通用 session status(`:23-31`) |
| `bridge/wake-terminal-fallback.ts`(新 122) | **pipeline-agnostic** | 门控在 **adapter 而非 pipeline**:`:57` `if (session.adapter_type !== "claude-tmux") return {...}`。`causalQuestionId` 处理 `gate-answer:` / `review-answer:`(`:39-45`)—— 都是通用 gate 通道 |
| `flywheel-comm/src/wake-ack.ts`(新 47) | **pipeline-agnostic** | runner 侧 ACK,由 `ask` / `inbox` / `park` / `turn` / `complete` / `qa-result` 调用(`index.ts:419/595/685/746/980/1071`)—— `inbox`/`ask`/`complete` 每个 runner 都用 |
| `config/feature-flags/registry.ts` | **mixed** | `wake_ledger`(`:106-136`,**默认 true**)/ `wake_escalation`(`:138`,默认 true)/ `wake_terminal_fallback`(`:159`,默认 true)三者 agnostic;`handoff_patrol`(`:180`,默认 true)legacy-only,唯一读点 `phase-orchestrator.ts:84` |
| `bridge/phase-handoff-backoff.ts`(新 141) | **legacy-only** | 唯一消费者 `phase-orchestrator.ts:41/373/924/935/1309`;只在 `plugin.ts:7958` 的 PhaseOrchestrator deps 内构造 |
| `bridge/phase-orchestrator.ts` | **legacy-only** | +377。`reconcilePeriodic` 首行 `if (process.env.FLYWHEEL_HANDOFF_PATROL === "0") return;`(`:84`);其下全部作用于 Design→Implement→QA 边界 |
| 告警 kinds | **mixed** | 5 个 wake kind agnostic(`lead-runtime.ts:26-30`);2 个(`three_stage_policy_off_at_boundary`、`three_stage_handoff_backoff`)legacy-only(`LeadAlertNotifier.ts:110-112`) |

**⚠️ 发现一个具体缺陷(阻塞级,且在 DAG 下同样咬人)**:

`bridge/founder-reply-deliverer.ts:621` 调 `wakeImpl({ db, execId, fromAgent, content, metadata })`
**没有传 `intentId`**,而该文件**未被 #648 改动**
(`git diff --stat origin/main...origin/flywheel-FLY-1339 -- .../founder-reply-deliverer.ts` 为空)。
由于 `FLYWHEEL_WAKE_LEDGER` **默认 true**,`wake.ts` 对每一次 founder ship-gate 回复都会返回
`{ ok:false, admissionKind:"ledger_unavailable", error:"wake ledger requires a stable causal intentId" }`。
调用方 `:635-643` 的注释块随即把它当作「没有投递 wake」,拒写持久 marker、并阻住 cursor
⇒ **默认配置下 founder 的 ship 回复会永久重试卡死**。
这条在**完全 pipeline-agnostic 的路径**(founder → runner ship gate)上,**DAG-only 下照样发生**。

**unverified**:`runner_phase_wakes` 的 `ALTER TABLE ... RENAME TO ..._fly1339_legacy` + 重建
是**破坏性迁移**,而 `claude-runner/src/codex-phase-lifecycle.ts:382` 已在写该表。
在飞的 codex phase wake 是否能挺过重建 —— **未追踪,视为 unverified**。

---

## B 批 · 942 三单 × FLY-1385 重叠矩阵

> **每条建议均标注「需与 HL 协调」**(Lead 2026-07-20 gate 确认)。本节只给证据与建议,
> 不代 HL 决定、不越权删单。

### B-0. 先核 FLY-1385 自己的机制断言(它是本批的对照基准)

| 1385 的断言 | 结论 | 证据 |
|-------------|------|------|
| `consume()` 只查 session 行**存在**,不查是否 failed → 永远重新 markStarted | **VERIFIED** | `workflow-engine-dispatcher.ts:199-202` `if (store.getSession(intent.execution_id)) { this.markStarted(intent); return true; }` —— **全程不读 `status`**。姊妹处 `:328-330`(`launch.status === "committed"` 分支)同形。`markStarted()` `:143-171` 无条件写节点 `state: "running"` |
| held teardown 在 receipt 缺失时提前 return | **VERIFIED,行号精确命中** | `packages/teamlead/src/DirectEventSink.ts:1109-1119`(`emitFailed`)log `generalized failure held … explicit completion receipt missing` 后裸 `return;`。**另发现 1385 未报的姊妹处** `:499-509`(完成路径,`generalized completion held`)同形。根在 `StateStore.ts:15513-15547` `observeEnrolledTeardown`:无 `workflow_node_completion` 行则追加 `generalized_teardown_hold` 事件并返回 `held: true`,节点永不推进。HTTP 侧同样 409:`event-route.ts:658-663`, `:680-685`(`workflow_completion_receipt_required`) |
| 无 Lead 级 run 管理 API | **VERIFIED(确实缺)** | `bridge/runs-route.ts` 只暴露 `router.post("/start")` `:208` 与 `router.get("/active")` `:1743`。**无 `/hold`,无 retry** |
| 影子 run(`engine_owned=0`)占住 one-active-run 锁 | **PARTIALLY REFUTED** | 锁在 `runs-route.ts:782-790` 读 `getActiveWorkflowRunForIssue`(`StateStore.ts:17569-17576`,选**任何** `status='active'` run,不看 `engine_owned`),但随即收窄:`const dagRun = activeRun?.entry_kind === "pipeline_dag_v1" ? activeRun : undefined`,**只有 `dagRun` 产生 409**。⇒ 阻塞谓词是 **`entry_kind`,不是 `engine_owned`**。1385 的表述用错了判别式。影子 run 能否带 `entry_kind='pipeline_dag_v1'` = **unverified**,这才是真正要落定的问题 |

### B-1. 【本审计最值钱的一条】DAG 引擎知不知道「有意 parked」vs「真卡死」?

**答案:不知道。已 VERIFIED。引擎是 receipt 驱动的,只有一个窄的、且内容盲的例外。**

引擎学到的一切都来自「活 runner 必须写的行」:

- `consume()` 只读 `getWorkflowRun` / `getWorkflowRunNode` / `getSession` /
  `listWorkflowRunEvents`(`workflow-engine-dispatcher.ts:178-230`)
- `observeEnrolledTeardown` 要求一条 `workflow_node_completion` 行
  (`StateStore.ts:15519-15522`)—— **楔死的 runner 恰恰产不出这行**,这正是节点吊在
  `running` 的原因
- `listNonTerminalWorkflowSideEffects`(`StateStore.ts:18057-18068`)只按账本
  `state IN ('intent_recorded','launch_committed')` 选 —— 纯记账,**零 OS 感知**

**唯一的例外,而且帮不上忙**:`probeGeneralizedLaunchLiveness`
(`bridge/generalized-launch-recovery.ts:22-40`)→ `probeRunnerProcessLiveness`
(`bridge/tmux-lookup.ts:371-401`)。它跑 `tmux list-panes -F '#{pane_dead}'` ——
**只读 pane 存活位,从不读 pane 内容**,返回 alive/dead_pin/absent/**indeterminate**
(第四态 indeterminate 见 §C-4,它是 FLY-1364 裁定的承重点)。两条硬限制:

1. **从引擎可达的调用点只有一个**:`workflow-engine-dispatcher.ts:332-335`,且只在
   `launch.status === "committed"` 的恢复分支内 —— 即只针对「压根没注册 session 的 launch」。
   **引擎从不对一个正常 running 的节点运行它。**
   ⚠️ 措辞精确性(对抗性复核 HIGH-1 指出并已改):`probeRunnerProcessLiveness` 本身
   **全仓有约 20 个非测试调用点**(`HeartbeatService.ts:1227/1765/2435`、`plugin.ts` 多处、
   `lifecycle-closeout.ts:1159` 等,见 §C-1)。这里说的「唯一」指的是**从 DAG 引擎可达的
   那条路径**,不是这个函数的全部调用者 —— 两者不可混淆。
2. 即便运行,对「有意 parked 的 runner」与「turn 中途冻住的 runner」**一律返回 alive**。
   `probeGeneralizedLaunchLiveness`(`generalized-launch-recovery.ts:41-59`)进一步把四态
   压成 `alive|dead|unknown`(`dead_pin`/`absent`→dead,其余→unknown)。
   它**结构性地无法**区分 b 与 c。

**补强(对抗性复核在试图证伪本条时发现,结论比原文更强)**:OS-liveness 那一层
**本身是引擎盲的**。`HeartbeatService` 既常驻跑 pane 探针,又**确实有** park 感知助手
(`declaredStateIsParked`,`HeartbeatService.ts:2400-2418`)—— 但
`grep -Ei "engine_owned|engineOwned|workflow" HeartbeatService.ts` **零命中**,
`crash-reaper.ts` / `done-running-reconciler.ts` 同样零 `workflow` 引用。
⇒ 引擎不但自己分不清 parked/stuck,**还消费不到下面一层已经存在的 park 感知**。
两层之间唯一的桥就是那条 held 路径(`DirectEventSink` → `observeEnrolledTeardown`,
`StateStore.ts:15529-15538`)。

> **⇒ 结论:FLY-1386 的「判死不依赖申报」原则在 DAG 下不但没被取代,反而更必要。**
> **FLY-1385 自己的症状就是证明 —— 节点吊在 `running`,正是因为引擎唯一接受的死亡信号,
> 是那个已死的 runner 发不出来的 receipt。**

**分层已确认,三层无共享代码路径**:

- **FLY-1385 = 引擎记账层**:碰的全是 SQLite 行(`workflow_side_effect_ledger` /
  `workflow_run_node` / `workflow_node_completion` / `sessions`)。无 tmux,无 Discord。
- **FLY-1386/87 = 其下一层**(OS/pane/进程 + CommDB 现实):`tmux-lookup.ts`、
  `LeadWatchdog.ts` pane 正则、`detection-gap-scan.ts` 只读打开 comm.db。
- **FLY-1388 = 其上一层**(Discord 路由):`detection-escalation-sinks.ts`
  (`chatChannel`/`botToken`/`addThreadMember`)、`founder-reply-deliverer.ts`。

### B-2. 【第二重要】942 三单的约 70% 已作为 FLY-1048 代码存在,但**默认关着**

这条改写整个 PRD 的性质:**不是 build,是 re-enable + 迁出退役通道。**

| 1386-88 的诉求 | 已存在的实现 | file:line |
|----------------|--------------|-----------|
| 三态 a/b/c 判定 | verdict enum **恰好** `a_working` / `b_parked` / `c_stuck` / `suspicious` | `bridge/watchdog-judge.ts:43-48` |
| 机械快路 + 只对可疑用 LLM | 一次性 `codex exec`,「Invoked ONLY when the mechanical fast path is uncertain」 | `watchdog-judge.ts:6-9`;fail-closed 到 null → fail-suspicious `:16-18` |
| 喂给判官的 pane 富态 | frames + `stage` + `fsmStatus` + `park` 元组 + `commEvents` + `errorSignatureKinds` | `watchdog-judge.ts:29-39` |
| 零 token 的 CommDB-only gap 扫描 | 「cheap gap/state scan — zero token, zero pane capture」;读 `runner_declared_states` `:323` | `bridge/detection-gap-scan.ts:1-17`, `:45-68` |
| pane 抓取保持稀疏 | 1h sweep「deliberately untouched」;frames 走独立 ~4min / 每 tick 2 抓预算 | `bridge/focused-frame-scheduler.ts:4`;`plugin.ts:6691-6705` |
| Lead-first 再 founder 的升级流 | 「the unified ~30min reconcile owns Lead + founder paging」+ `createFounderPager` | `stuck-escalation.ts:706-710`;`detection-escalation-sinks.ts:100-118, 165+` |

**但**:`plugin.ts:7039`(`onGapScanTick`)、`:7049`(`onDetectionReconcileTick`)、
`:7019`(`onParkWatchTick`)**全部门控在** `legacyDeliveryWatchdogsOn` =
`env.FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS === "1"`(`legacy-delivery-watchdog-policy.ts:6-10`)
—— **默认 false**,在 `feature-flags/registry.ts:105-127` 注册为 `polarity: "opt_in", default: false`。
**FLY-1373(Lead-inbox/mailbox 切换)把整个检测栈扫进了一条退役通道。**

### B-3. 常量核实(1387 的算术断言)

| 符号 | file:line | 值 |
|------|-----------|-----|
| `DEFAULT_IDLE_POLL_MS` | `bridge/stuck-escalation.ts:91` | `3_600_000`(~1h)。override `FLYWHEEL_IDLE_POLL_MS` `:112`。`:82-105` 注释显式点名 FLY-626 为「the follow-up rethink」 |
| `STUCK_COMM_ACTIVITY_MS` | `stuck-escalation.ts:120` | `1_800_000`(30min) |
| `stuckThresholdMs` | `stuck-escalation.ts:81` | 600_000(10min)默认 |
| `isIdleHealthyPane` | `LeadWatchdog.ts:891-907` | **单帧布尔**,over `ownStateRegion(pane)`;另在 `LeadWatchdog.ts:478`、`bridge/AlertChannelHub.ts:988` 消费 |
| `runner_declared_states` | schema `flywheel-comm/src/db.ts:56`;写 `:2016`, `:2031`;读 `:2053`;消费方 `detection-gap-scan.ts:323`, `issue-display-refresher.ts:593` | — |

**⇒ 1387 的算术断言 CONFIRMED**:1h 轮询 vs 30min 升级阈值。用来修它的 gap scan 已存在,
但 cadence 是 `gate-poller.ts:1260-1262` `gapScanEveryNTicks ?? 100`(GatePoller 间隔的 100 倍),
且整个 tick 默认关闭。

### B-4. 重叠矩阵

| # | 能力项 | DAG 引擎内建覆盖? | FLY-1385 scope 覆盖? | 仍唯一需要? |
|---|--------|-------------------|----------------------|-------------|
| 1386-a | 三态 a/b/c 判定 | **否** — 引擎只有 running/done/failed,全无 b-vs-c 轴 | **否** — 1385 加的是**二元**死-exec 检查 | **是,但属 re-enablement**(`watchdog-judge.ts:43-48` 已有,关着) |
| 1386-b | per-pane 富态(token-flow + FSM) | **否** — 只有 `#{pane_dead}` 位,单调用点 | **否** | **是**(`watchdog-judge.ts:29-39` 已有,接线在停用通道) |
| 1386-c | 机械快路 + LLM 兜可疑 | **否** | **否** | **re-enablement**(契约见 `watchdog-judge.ts:6-9`) |
| 1386-d | 修 `isIdleHealthyPane` 单帧误压 | **否** — 引擎从不读 pane 文本 | **否** | **是,唯一**。`LeadWatchdog.ts:891-907` 仍是纯单帧布尔 |
| 1386-e | 扩错误串 | **否** | **否** | **是,唯一** — `BLOCKED_KEYWORDS` / `WORKING_MARKERS` |
| 1386-f | 不静默丢(`fail-suspicious`) | **反证 —— 引擎做的恰恰相反**:`DirectEventSink.ts:1113-1118` 与 `:503-508` 只 `console.error` + 裸 return,无告警无 episode | **部分** — 1385 的 held-teardown 修复正对此,但在引擎层 | **是**(watchdog 层);`watchdog-judge.ts:16-18` 已 fail-closed |
| 1386-g | fixture:主动 parked + 声明唤醒条件 → 判 b 永不进 c | **否**。引擎**从不读** `runner_declared_states` —— 该表只被 `flywheel-comm` / `detection-gap-scan.ts:323` / `issue-display-refresher.ts:593` 触碰,**`workflow-engine-dispatcher.ts` 内零引用** | **否** | **是**。注:`destructive-verdict.ts:25` + `registry.ts:159` 已给 park 声明对破坏性清扫的**否决权** —— 好先例,但不等于分类 |
| 1387-a | 修 1h-vs-30min 不可能 | **否** — 引擎 reconcile 是 1s 循环,但**从不评估 staleness**,故其 cadence 与检测无关 | **否** | **是**。`DEFAULT_IDLE_POLL_MS` 未变 |
| 1387-b | 高频 CommDB-only 扫描 | **否** — 引擎读 state.db 的 workflow 表,从不读 comm.db | **否** | **大体已建**,但 cadence ×100 且通道默认关 |
| 1387-c | pane 抓取保持稀疏 | N/A | **否** | **已达成** |
| 1388-a | 先通知责任 Lead,进 `[FLY-XX]` thread | **否** — 引擎不向 Discord 发任何东西 | **否** | **已建但关着**(`detection-escalation-sinks.ts:100-118`) |
| 1388-b | ~30min 未解决才 @founder | **否** | **否** | **已建但关着**(`stuck-escalation.ts:706-710`) |
| **1388-c** | **反方向:founder 在 thread 的回复 → 责任 Lead** | **否** | **否** | **是,且是真实未覆盖缺口 —— VERIFIED**。**主证据**:该文件唯一的 Lead 通知路径是 `deliverAmbiguousToLead`(`:190`, `:737-741`),被 `const ambiguous = matching.length >= 2`(`:734`)门控 ⇒ **只有歧义分支通知 Lead**。**清晰无歧义的 founder 回复到达 runner,而 Lead 永远不被告知 —— 这正是 2026-07-18 事故,代码库中无任何东西覆盖它**。(背景:文件头 `:1-19` 讲的是「Lead 不会把 founder 回复转达**给 runner**」= 自动投递的动机,**不等于**「Lead 不知情」;原文此处过度解读,复核 LOW-1 已改为以 `:734-741` 为主证据。) |

**⇒ B 批与 1385 的重叠近乎为零**,唯一概念触点是 1386-f(都要「不静默丢」),但在不同层、
不同文件、无共享代码 ⇒ **可完全并行推进**。

---

## D 批 · 协调器续单两个候选缺陷

### D-a. qa-result credential 邮路 —— **方向与 issue 的猜测相反**

**判定:不是 legacy-only。这是 DAG 路径的缺陷,而那个「解法」恰恰是退回 legacy 路径。**

`flywheel-comm/src/commands/qa-result.ts:126-155`:
```ts
const workflowCredential = process.env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL?.trim();  // :126-127
const endpoint = workflowCredential
    ? `${bridgeUrl}/api/workflow/decision`   // :151  ← DAG 路径
    : `${bridgeUrl}/events`;                 // :152  ← legacy 路径
```
body 形状也随之切换(`:138-150`)。

- credential **只在 DAG launch 路径注入**:`claude-runner/src/TmuxAdapter.ts:447-450` 与
  `CodexTmuxAdapter.ts:1410`,均来自 `generalizedExecution.submissionCredential`,由
  `workflow-engine-dispatcher.ts:400-420 / 437-455` 对 `node.type === "qa" || "review"` 铸造
- **409 全在 DAG 端点上**:`bridge/workflow-decision-routes.ts:294-308`(decision-authority-unavailable)、
  `:312-318`(`head_authority_mismatch`)、`:332-336`、`:363-365`(**`not_durable_qa_execution`**)、
  `:376-380`、`:382-388`
- ⇒ unset `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL` 把 verdict 改道 `/events`,落进
  `session_events` 的 `qa_result` 行 —— **与报告的症状逐字吻合**。那是**从 DAG 路径降级到
  legacy 路径**当 409 的 workaround。

两点值得标记:
1. `not_durable_qa_execution`(`:361-365`)要求 `session_role === "qa" && chat_thread_role === "qa"`
   —— 一个**三段式形状的假设**,但它位于**非引擎回退分支**(仅当 `engineCanonical` 未定义,
   即 `context.run.engine_owned !== 1` 时到达,`:62`)。⇒ 这个特定 409 是 legacy 形状的检查,
   而一个 DAG-邻接的请求**仍可能掉进去**。
2. **DAG 路径并未天然绕开 —— 它就是那条 409 的路径。**

**unverified**:生产上实际命中的是 7 个 409 分支中的哪一个 —— 这决定它是 head-authority
竞态(可重试)还是 `not_durable_qa_execution` 角色形状检查(真 DAG bug)。需要生产错误原文。

### D-b. `qa_required` 快照接线 —— **legacy-only,DAG 天然绕开(带一个待核 caveat)**

- **唯一写方是 legacy auto-QA 协调器**:`setQaRequiredSnapshot` 定义在
  `StateStore.ts:5341-5350`(`WHERE qa_required IS NULL`,不可变),**只被一个文件调用** ——
  `bridge/auto-qa-coordinator.ts:524, :557, :2071, :2087, :2106, :2115`。
  `workflow-engine-dispatcher.ts` / `workflow-decision-routes.ts` / `runs-route.ts` /
  `DirectEventSink.ts` 内**零调用点**
- **DAG 写方显式声明其在 scope 外**:`bridge/workflow-shadow-writer.ts:5-7`
  「every gate keeps reading its legacy source (verify-approval / codex_review_record /
  **qa_required untouched**)」
- **读方有显式引擎旁路**:`flywheel-comm/src/ship-eligibility.ts:300-314` —— 当
  `session_role === "qa" && chat_thread_role === "qa"` 且非 `forceLegacy` 时返回
  `resolveEnrolledQaClaim(...)`(workflow-claims 账本),**根本不到达** `:335-341` 的
  `qa_required` 读或 `:319-326` 的 `auto_qa_record` 查询
- **ship gate 处第二道独立旁路**:`bridge/merge-ship-gate.ts:146`
  `if (run?.engine_owned !== 1) return { engineOwned: false }`;engine-owned run 走
  `evaluateEngineShipClaims`(`:159-173`),与 `qa_required` 完全分离

**caveat(必须在关单前核)**:`ship-eligibility.ts:301` 的旁路键在
`session_role` / `chat_thread_role === "qa"`,**不是** `engine_owned`。⇒ 一个 DAG QA 节点若其
session 行没把两个 role 字段都设成 `"qa"`,会掉回 legacy `qa_required` 分支并命中
`qa_snapshot_missing_failclosed`(`:260-262` 有文档)。引擎 dispatcher 是否**总是**设这两个字段
= **unverified**(`workflow-engine-dispatcher.ts:465` 算的是
`const role = isThreeStagePhaseRole(node.type) ? node.type : "main"`,而 `chat_thread_role`
写在哪里未追踪)。**这与 D-a 的 `not_durable_qa_execution` 依赖的是同一类角色形状假设。**

---

## 附:VERIFIED vs INFERRED 分野

**已在代码中核实**:1385 全部机制断言(含它未报的 `DirectEventSink.ts:499-509` 姊妹处);
引擎的 receipt-only 认知模型与那唯一一个内容盲 tmux 探针;hold/retry 路由确实不存在;
全部常量值;FLY-1048 检测栈的存在性与默认关闭门控;qa-result 端点分叉;`qa_required`
写/读拓扑与两条引擎旁路;founder-reply → runner-而非-Lead 的路由;#642/#648 全部
逐文件调用链;C 批四单的当前代码状态。

**推断而非核实(plan.md 不得据此给确定裁定)**:
- D-a 生产 409 具体是哪一个分支
- FLY-1048 栈「直接打开就能正常工作」—— 它是在 FLY-1373 mailbox 切换期间被停用的,
  其 Lead 投递 sink 可能指向已退役通道,需要移植到 Lead inbox
- 影子 run 能否带 `entry_kind='pipeline_dag_v1'`(决定 1385 第 4 项断言是否成立)
- DAG dispatcher 是否总设 `chat_thread_role='qa'`
- `runner_phase_wakes` 破坏性迁移对在飞 codex phase wake 的影响
- FLY-1374 的三个 Discord 卫生小项(路由守卫 / 403 locked / 长文 split)—— 全部
  grep 零命中,状态不明
- PR #647 Lane 1(机器级 `~/.claude/commands/codex-code-review.md`)本仓无法审计
