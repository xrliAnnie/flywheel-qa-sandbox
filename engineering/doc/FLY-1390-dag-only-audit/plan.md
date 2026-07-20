# FLY-1390 DAG-only 清算 — 裁定表(交 Annie 终审)

Issue: FLY-1390 (https://linear.app/geoforge3d/issue/FLY-1390/auditdag-only-清算-在飞-issuepr设计全量重判-legacy-冻结令下的还要改造删逐单裁定证据级)
日期: 2026-07-20
基于: research.md

> **本文只出建议,不执行。** 关单 / 弃 PR / 改 scope 一律 Lead + Annie 终审后执行
> (Lead 2026-07-20 gate 确认)。B 批每条已标「需与 HL 协调」。

> ⚠️ **引用 provenance**:A-1 的 `runs-route.ts:812` / `phase-orchestrator.ts:665-667` 只在
> `origin/flywheel-FLY-1293` 上成立(main 上 `admitManualPhase` **不存在**);A-2/R-1 的
> `wake_ledger` 相关只在 `origin/flywheel-FLY-1339` 上成立(该 flag main 上**不存在**)。
> **照 main 核这几条会核不到 —— 那不是引用编造,是分支不同。** 详见 research.md 顶部对照表。
> 其余引用均在 main 成立。

> **本表编号与 research.md 一致**(C 批编号已对齐,复核 MEDIUM-3)。

## 0. 三条要先讲给 Annie 的话

**① 冻结令能落地,但四批里只有一批是真 legacy。** 逐调用链核完:B 批(watchdog 三单)、
C 批(基建五单)、D-a 全都**不是** legacy。真正随 legacy 退役的,主要是 PR #642 的大部分
和 PR #648 的一小部分。

**② 有两条发现推翻了 issue 自己的假设,方向是相反的:**
- **PR #648 不是「整体过时」** —— 它约 85% 是全 fleet 共用的 wake 基建。issue 描述
  「引擎化后此层由引擎负责」这句自我申报,与源码不符。
- **D-a(qa-result 邮路)不是 legacy 缺陷** —— 它是 **DAG 路径**的缺陷;那个「解法」
  (unset credential)恰恰是**从 DAG 降级回 legacy**。按「不修,随 legacy 退役」处理会
  把一个活的 DAG bug 一起埋掉。

**③ 审计顺手挖出一个阻塞级现存缺陷,与冻结令无关但更急**(见 R-1)。

## 1. 裁定表

判定四档:**照做** / **重述成 DAG 语境** / **并入他单** / **删**

### A 批 · 停在 founder gate 的四个 PR

| # | 对象 | 本来做什么 | 证据 | DAG-only 判定 | 建议动作 | 风险 |
|---|------|-----------|------|--------------|---------|------|
| A-1 | **PR #642 · FLY-1293**<br>协调器交接完整性批修 | 5 条缺陷批修:手动派单入册 / 接力棒常驻对账 / QA record 入账 / 任务清单注入隔离 / 显示族 | 约 **80% 源码面 legacy-only**:入册块门控 `runs-route.ts:812`(**schema-2 = DAG 被显式排除**);`phase-orchestrator.ts:665-667` 硬拒 engine-owned 行;`db.ts` 三个 CAS 只被 `explicitPhaseAdmission` 门控路径调用 | **大部分删,拆出 3 件** | **弃 PR 主体**,把 3 件 pipeline-agnostic 的改动拆成一张小单:① `run-dispatcher.ts:1160-1181` 双启动去重(共享 `RunDispatcher.start` 上的真 TOCTOU,DAG 走同一入口)② `Blueprint.onAdapterDispatchStarted`(`:230/2089`,DAG 做 launch 补偿要用)③ `ClaudeCodeAdapter` 的 `CLAUDE_CODE_TASK_LIST_ID`(= 缺陷④修复,与 pipeline 正交) | 拆单有工作量;若整体弃,缺陷④(Lead 任务清单注入 runner、烧 token)会继续存在于**所有** runner,与 pipeline 无关 |
| A-2 | **PR #648 · FLY-1339**<br>phase handoff / park-wake 自动接力 | phase 交接与 park-wake 全自动、有回执 | **约 85% pipeline-agnostic**(与 issue 自我申报相反):`wake.ts` 的 `wakeRunnerMailbox` 是全 fleet wake 原语,**只有 `plugin.ts:8385` 一处是 phase handoff**;三个新 patrol 无任何 phase/role 过滤;`wake-terminal-fallback.ts:57` 门控在 **adapter 而非 pipeline**。legacy-only 的仅:`phase-handoff-backoff.ts`(141 行)、`phase-orchestrator.ts` 的 +377、`handoff_patrol` flag、2/7 告警 kind | **重述成 DAG 语境**(保主体) | **保留并 land wake 基建主体**,剥掉 phase-handoff 那 ~15%。**land 前必须先修 R-1**(见下),并核 `runner_phase_wakes` 破坏性迁移对在飞 codex wake 的影响 | 破坏性迁移 `ALTER TABLE ... RENAME TO ..._fly1339_legacy` + 重建,而 `codex-phase-lifecycle.ts:382` 已在写该表 —— **unverified**,land 前必须核 |
| A-3 | **PR #647 · FLY-1340**<br>code review 架构面前移 | 第一轮 code review 带 design 文档、优先查架构/耦合 | **pipeline-agnostic**:`review-request-coordinator.ts` 对 `three-stage\|phase\|workflow\|dag` **全文零命中**;入口是 HTTP 路由 `plugin.ts:1474` 非 phase 转换;路由键是 `adapter_type`(DAG 下继续存在);**DAG 派 codex vendor 必然命中本 coordinator**(`workflow-engine-dispatcher.ts:450`) | **照做(有条件)** | **land Lane 2(仓内那 44 行);Lane 1 不在本审计的可判范围内。** 源码仅 +44/-6,有 kill switch(`FLYWHEEL_REVIEW_SEVERITY_POLICY=0` 逐字还原) | ⚠️ **本单是全表唯一一条「裁定强于证据」的地方,复核 HIGH-2 揪出,已降级为有条件**:PR #647 有两条 lane,**Lane 1 改的是机器级 `~/.claude/commands/codex-code-review.md`,仓内无 canonical 副本 ⇒ 本审计无法审计它**(research.md §A-3 标 `unverified`)。原表给的是无条件「原样 land」,等于对一条自己看不见的 lane 下了确定裁定。失效模式是「review 质量下降」而非数据损坏,但**land 前应由人过一眼 Lane 1 的 patch**(`qa-evidence/lane1/codex-code-review.patch`)。<br>另:文档 §6 假设「design 文档在 PR 分支可读」以三段式共享分支为依据;DAG materializer 写独立 ref(`workflow-docs-materializer.ts:227`)⇒ DAG run 得到「正确但空转」的 review(安全降级,非错误)。**建议开一张小 follow-up** |
| A-4 | **PR #641 · FLY-1342**<br>head-churn 治理设计 + founder HTML | 绑定卫生引擎化设计 + founder 决策 brief(7 项) | 纯 docs+HTML,**零 packages 改动**。「并进 DAG 语义」**属实,已独立核**:§2 目标态用 DAG 原生原语并引用活代码(`node-type-registry.ts:91-100` 等,registry 那条已核对上);三条绑定全锚 `pr_head_sha`(`verify-approval.ts:483-490` / `StateStore.ts:2140-2156` / `auto-qa-held.ts:87-227`),**均非 phase 概念**。唯一焊死处 = **§3 过渡期轻规矩包**,其 writer 清单直指 `phase-orchestrator.ts:1351,1435,1485-1496,1646`,验收是「真机一条三段式全链」 | **设计仍有效,需局部改** | **保留 §0-§2、§4-§6(B2/B3/B4)、§7-§8;砍掉 §3 / 子单 B1。** ⚠️ **§4 founder HTML 的决策项 D7(过渡期轻规矩包)必须在给 Annie 之前拿掉或重写** —— 它现在是在请她批准对一条已冻结 pipeline 的施工。D1-D6 不受影响 | 与 FLY-1385 **正交无冲突**(一个治 liveness,一个治 binding integrity)。轻微邻接:1385 第 5 项的 `Blueprint.ts:847` `startPoint` vs 1342 §2.2 的 `expected_old_head` —— 是否真冲突 **unverified**(1385 尚无设计文档) |

### B 批 · HL 的 942 PRD 三单 —— **每条均「需与 HL 协调」**

> **本批总结论:与 FLY-1385 的重叠近乎为零,可完全并行。但整批性质应从「build」改为
> 「re-enable + 迁出退役通道 + 三件真新增」。**

**先讲最值钱的一条(Lead 指定重点,已代码核实 + 已过独立对抗性复核的证伪尝试):**

> **DAG 引擎不知道「有意 parked」vs「真卡死」。** 引擎学到的一切都来自活 runner 必须写的
> 行(`workflow-engine-dispatcher.ts:178-230`;`observeEnrolledTeardown` 要求
> `workflow_node_completion` 行,`StateStore.ts:15519-15522`)。唯一的 OS 感知是
> `probeRunnerProcessLiveness`(`tmux-lookup.ts:371-401`),它**只读 `#{pane_dead}` 位、
> 从不读 pane 内容**;**从引擎可达的调用点只有一个**
> (`workflow-engine-dispatcher.ts:332-335`)、只对「压根没注册 session 的 launch」运行 ——
> **引擎从不对正常 running 的节点运行它**。即便运行,对「有意 parked」与「冻在 turn 中途」
> **一律返回 alive**,**结构性无法区分 b 与 c**。另:引擎内**零引用**
> `runner_declared_states`。
>
> ⚠️ 措辞边界(别被一条 grep 推翻):`probeRunnerProcessLiveness` **全仓约 20 个非测试
> 调用点**(见 §C-1 —— 常驻 HeartbeatService 就在用它)。上面说的「唯一」严格指
> **从 DAG 引擎可达的那条路径**,不是这个函数的全部调用者。
>
> **补强(复核在试图证伪本条时反而发现结论更强)**:OS-liveness 那层**本身是引擎盲的** ——
> `HeartbeatService` 有 park 感知助手(`declaredStateIsParked`,`HeartbeatService.ts:2400-2418`),
> 但该文件 `engine_owned|workflow` **零命中**。⇒ 引擎不但自己分不清,**还消费不到下面一层
> 已经存在的 park 感知**。
>
> **⇒「判死不依赖申报」在 DAG 下不但没被取代,反而更必要。FLY-1385 自己的症状就是证明:
> 节点吊在 `running`,正是因为引擎唯一接受的死亡信号,是那个已死的 runner 发不出的 receipt。**

**第二条:约 70% 的 1386-88 已作为 FLY-1048 代码存在,但默认关着。**
verdict enum 恰好是 `a_working`/`b_parked`/`c_stuck`/`suspicious`(`watchdog-judge.ts:43-48`);
机械快路 + 只对可疑用 LLM 的契约已写死(`:6-9`);零 token CommDB 扫描已存在
(`detection-gap-scan.ts`)。但 `plugin.ts:7019/7039/7049` 全部门控在
`FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS === "1"`,**默认 false**
(`registry.ts:105-127`,`polarity: "opt_in"`)—— FLY-1373 的 mailbox 切换把整个检测栈
扫进了退役通道。

| # | 对象 | 本来做什么 | 证据 | DAG-only 判定 | 建议动作 | 风险 |
|---|------|-----------|------|--------------|---------|------|
| B-1 | **FLY-1386**<br>三态判定 + LLM 兜可疑<br>**【需与 HL 协调】** | a/b/c 三态 + LLM 兜可疑 + 修 `isIdleHealthyPane` + 扩错误串 + fail-suspicious | DAG 引擎**零覆盖**(见上)。1385 **零覆盖**(它加的是二元死-exec 检查)。约 70% 已有代码但默认关 | **重述成 DAG 语境(保留,不删)** | 保留。**re-scope 为**:①「re-enable + 把 Lead 投递 sink 从退役通道移植到 Lead inbox」②三件真新增:`isIdleHealthyPane` 单帧误压(`LeadWatchdog.ts:891-907`)、扩错误串、parked-fixture。**把「判死不依赖申报」写进 re-scope 说明**,并附上面那段引擎证据链 | FLY-1048 栈「打开就能用」= **unverified** —— 它是在 FLY-1373 切换期间被停用的,sink 可能指向已退役通道,需要移植而非单纯翻 flag |
| B-2 | **FLY-1387**<br>检测 cadence<br>**【需与 HL 协调】** | 修 `DEFAULT_IDLE_POLL_MS=1h` 使 30min 阈值不可能 | **算术断言 CONFIRMED**:`stuck-escalation.ts:91` = `3_600_000`,vs 30min 阈值。修它的 gap scan 已存在,但 cadence `gapScanEveryNTicks ?? 100`(`gate-poller.ts:1260-1262`)且整 tick 默认关。引擎 reconcile 虽是 1s 循环但**从不评估 staleness**,其 cadence 与检测无关 | **重述成 DAG 语境(保留)** | 保留。re-scope 为「re-cadence + 开通道」而非新建。pane 抓取保持稀疏这条**已达成**(`focused-frame-scheduler.ts:4`),可从 scope 移除 | 低。这是 B 批里最接近「改个数 + 开个门」的一单 |
| B-3 | **FLY-1388**<br>统一升级流<br>**【需与 HL 协调】** | 检测即通知责任 Lead,~30min 未解决才 @Annie;**+ 反方向:founder 回复送达 Lead** | Lead-first 升级流**已建但关着**(`stuck-escalation.ts:706-710`、`detection-escalation-sinks.ts:100-118,165+`)。**但反方向是真实未覆盖缺口 —— VERIFIED**:该文件唯一的 Lead 通知路径是 `deliverAmbiguousToLead`(`:190`, `:737-741`),被 `matching.length >= 2`(`:734`)门控 ⇒ **只有歧义分支通知 Lead;清晰的 founder 回复到达 runner,Lead 永不被告知**。这正是 2026-07-18 事故 | **重述成 DAG 语境(保留)** | 保留。re-scope:正方向 = re-enable + 移植;**反方向(1388-c)= 真新增,建议单独拎出来做**,因为它是 Annie 亲历过的、founder 白等 40 分钟的那个缺口 | 正方向依赖 B-1/B-2 先落地(三态分类 + 时延契约) |

### C 批 · Batch 4.3 五单

| # | 对象 | 本来做什么 | 证据 | DAG-only 判定 | 建议动作 | 风险 |
|---|------|-----------|------|--------------|---------|------|
| C-1 | **FLY-1374**<br>状态真相双对账器 | 进程→DB + DB→Discord 幂等重渲染 | **⚠️ 事实前提大面积过期(4 条全证伪)**:① 对账器(a)已存在 —— `tmux-lookup.ts:371` `probeRunnerProcessLiveness` + 常驻 `reconcileMonitorLoss()`(`HeartbeatService.ts:897/643`)② 对账器(b)已作为 FLY-907 发货 —— `issue-display-refresher.ts:538` `runSweep()` 接进 `plugin.ts:7086`,且**已显式由每个生命周期源触发而非只由 `stage_changed`** ③ `display_reconciled_at` **不是半截**,schema+迁移+写方+读方+测试齐全(`StateStore.ts:1830/11206/7065/7057/7080`)④ 覆盖它的是 **FLY-907/720,不是 issue 里写的 1373/1099**(两者 diff 都没碰这些文件) | **重述(主体已覆盖)** | **不要照原样派单。** 杀掉 `display_reconciled_at` 项(前提为假)与标题重渲染项(已发货)。re-scope 后只剩:pgrep+CPU-delta 佐证腿(锦上添花)+ 三个 grep 零命中的小项 + **一件真活:`issue-display-refresher.ts:642` 的 `isThreeStage` 分支需要 DAG 原生的标题前缀推导** | **这是 C 批唯一有三段式耦合的地方,且恰在已发货的那一半** —— `issue-display-refresher.ts` 从 `flywheel-config` import `THREE_STAGE_PHASE_SEQUENCE`。DAG-only 下「应有前缀」是从冻结概念推导的。建议**这条单独拎出来做**,否则 DAG run 的 Discord 标题会失准 |
| C-2 | **FLY-1375**<br>ship 自动化 land 流程 | founder 说 ship 后全自动收尾 | issue 自身已写「land 作为 DAG 工程模板的最后一个节点(design→implement→qa→land)」⇒ **天然 DAG 语境**。三段式耦合仅存在于「legacy 在飞单由 Lead 人肉执行 1338 范式过渡」那半句 | **照做** | **原样保留。** 只删掉「legacy 在飞单人肉过渡」那半句(随 legacy 退役) | 低。与 A-1 拆出的第 ① 件(双启动去重)有邻接,排期时留意 |
| C-3 | **FLY-1363**<br>6am 重启静默失败 | comm.db 未 gitignore 弄脏 main → preflight 拒部署 | **根因仍活,只是被本机机制压住**:`git check-ignore -v` → **`.git/info/exclude:60`,不是 `.gitignore`** ⇒ 任何新 clone/换机即复发。preflight `update-flywheel.sh:78-81` 裸 `--porcelain` **不分 untracked-runtime 与源码**;告警**阈值门控**(`rec == 10` 才 `severe_alert`,`:183-186`)⇒ 前 N 次静默。**已有 R7 全审设计停在 worktree**(`flywheel-FLY-1363`,HEAD `9b344744b`,领先 main 14 commit,**全是文档、零实现**,另有 1 个未提交的 plan 编辑) | **照做** | **原样保留,优先级可提。** 三段式耦合 = **零**。设计已过 7 轮 review 且停在 worktree,落地便宜 | 不修则每次换机/新 clone 复发,且失败继续静默。⚠️ worktree 有未提交编辑,续做前先收 |
| C-4 | **FLY-1364**<br>cmux 死 tab 不清理 | 单写锁「lease unverifiable」挡死 cleanup | **现象为真,但点名文件错了**:`repo-mutation-lock.ts`(全 90 行已读)是 `AsyncLocalStorage` 进程内互斥锁,**完全没有 lease 逻辑、没有 unverifiable 分支、没有可反转的东西**。真正的 fail-closed 在 `tmux-lookup.ts:387-390`(`indeterminate` → 当作 alive,**GEO-374 守卫**)+ `crash-reaper.ts:23-24` | **重述** | **不要删,但按原文无法执行。** 重新指向 `tmux-lookup.ts:387` / `crash-reaper.ts`,并把诉求从「反转 fail-safe」改为「**加有界 indeterminate 逃生口**」(如连续 N 次后按时龄放行) | ⚠️ **这个 fail-closed 方向是刻意的、承重的**(GEO-374 回归守卫)。**直接反转 = 重新引入被它防住的回归**。另:`cmux-close-request.ts:1-27`(FLY-685)已有权威关闭 marker + FLY-293 5min orphan reaper,残留死 tab 是否属 indeterminate 情形 = **unverified** |
| C-5 | **FLY-802**<br>roundtable thread 1h 归档 | 1h 自动归档 + 描述性命名 | **代码已发货但不满足现行规格。** PR #423(`cf422a671`)已 land,创建+恢复两路都设 60、有测试。**但 2026-07-11 重开、2026-07-17 换了规格**:Cass 现场诊断纠正了根因(Discord **不**把频道 `default_auto_archive_duration` 应用到 API 创建的 thread —— 该字段按文档是 clients 用的),Annie 新要求 = **读父频道默认值并显式传、且不要硬编码频道名/id**;全 guild 29 频道中 28 个该字段为 null ⇒ null 需显式回落 4320。**已发货代码硬编码常量 60,恰恰违反「不要硬编码」这条** | **重述** | **不是「已覆盖」,是规格已变需重做。** 按 7/17 的 channel-default-driven 规格重写 + 加 converge 对账器 | ⚠️ **对账器必须由带 `MANAGE_THREADS` 的 bot 跑**(否则对非自建 thread 403 —— Cass 实撞)。已核 claw-infra-bot(`1524829037825101975`)有该权限,**Lead bot 没有,必然 403**。范围外勿误伤:`ChatThreadCreator.ts:435`(4320,FLY-292 管)与 `AlertChannelHub.ts:87`(1440) |

### D 批 · 协调器续单两个候选缺陷

| # | 对象 | 本来做什么 | 证据 | DAG-only 判定 | 建议动作 | 风险 |
|---|------|-----------|------|--------------|---------|------|
| D-a | **qa-result credential 邮路** | 修 qa-result 409 / 凭据邮路 | **⚠️ 方向与猜测相反。** `qa-result.ts:126-155` 按 credential 有无分叉:有 → `/api/workflow/decision`(**DAG**),无 → `/events`(legacy)。credential **只在 DAG launch 路径注入**(`TmuxAdapter.ts:447-450` / `CodexTmuxAdapter.ts:1410`,由 `workflow-engine-dispatcher.ts:400-420/437-455` 铸造)。**7 个 409 分支全在 DAG 端点上**(`workflow-decision-routes.ts:294-388`)。⇒ unset credential = **从 DAG 降级回 legacy** 的 workaround | **不可按 legacy 关闭** | **保留并重新定性为 DAG 缺陷。** 下一步只需一件事:**取生产错误原文**,确定命中的是 head-authority 竞态(可重试)还是 `not_durable_qa_execution`(真 DAG bug) | 若按原计划「不修,随 legacy 退役」处理,**会连带埋掉一个活的 DAG bug**。注:`not_durable_qa_execution`(`:361-365`)要求 `session_role==="qa" && chat_thread_role==="qa"` —— 三段式形状的检查,却在**非引擎回退分支**里,DAG-邻接请求仍可能掉进去 |
| D-b | **`qa_required` 快照接线** | 修 qa_required 快照未接线 | **legacy-only 成立。** 唯一写方是 `auto-qa-coordinator.ts`(6 处),引擎侧零调用点;DAG 写方显式声明其在 scope 外(`workflow-shadow-writer.ts:5-7`「qa_required untouched」);读方有引擎旁路(`ship-eligibility.ts:300-314`)+ ship gate 第二道独立旁路(`merge-ship-gate.ts:146`) | **删(随 legacy 退役)** | 可按「不修」关闭 —— **但先做下面这一次核查** | ⚠️ **caveat**:`ship-eligibility.ts:301` 的旁路键在 `session_role`/`chat_thread_role === "qa"`,**不是** `engine_owned`。若 DAG QA 节点没把两个 role 字段都设成 `"qa"`,会掉回 legacy 分支撞 `qa_snapshot_missing_failclosed`。引擎是否**总是**设 `chat_thread_role='qa'` = **unverified**。**与 D-a 是同一类角色形状假设,建议一起核一次** |

## 2. 顺手挖出的、与冻结令无关但更急的东西

### R-1 · 【阻塞级】founder ship 回复在默认配置下会永久卡死

`bridge/founder-reply-deliverer.ts:621` 调 `wakeImpl({...})` **没传 `intentId`**,且该文件
**未被 PR #648 改动**(diff 为空)。而 #648 引入的 `FLYWHEEL_WAKE_LEDGER` **默认 true**
⇒ `wake.ts` 对每一次 founder ship-gate 回复返回
`{ ok:false, admissionKind:"ledger_unavailable", error:"wake ledger requires a stable causal intentId" }`;
调用方 `:635-643` 把它当「没投递」,拒写持久 marker 并阻住 cursor。

- **影响面**:完全 pipeline-agnostic 的 founder → runner ship gate 路径,**DAG-only 下同样发生**
- **触发条件**:PR #648 一旦 land(该 flag 默认开)
- **建议**:列为 #648 的 **land 前置硬条件**,不作为独立单排期

### R-2 · 1385 有一处未报的姊妹缺陷,以及一处判别式写错了

- **未报的姊妹处**:`DirectEventSink.ts:499-509`(完成路径 `generalized completion held`)
  与 issue 点名的 `:1109-1119`(失败路径)**同形**。修 1385 时若只修失败路径会漏掉一半。
- **判别式写错**:1385 第 4 项说影子 run 按 `engine_owned=0` 占锁,但代码里阻塞谓词是
  **`entry_kind === "pipeline_dag_v1"`**(`runs-route.ts:782-790`),不是 `engine_owned`。
  影子 run 能否带该 `entry_kind` = **unverified** —— 这才是要落定的真问题。
- 另:1385 目前**只有 Linear issue,仓内无任何代码/设计产物**(全树 grep 只命中本审计的
  任务简报文件;本地与 origin 无 `*1385*` 分支)。

## 3. 建议的执行顺序(若 Annie 认可上述裁定)

1. **先修 R-1**(阻塞 #648)
2. **A-3(#647)原样 land** —— 四个 PR 里最干净的一个
3. **A-4(#641)拿掉 D7 后**再把 founder HTML 给 Annie
4. **A-2(#648)**:核破坏性迁移 → 剥 phase 部分 → land wake 主体
5. **A-1(#642)**:弃主体,拆 3 件成小单
6. **C-3 / C-2 照做**;**C-1 / C-4 / C-5 按重述后的 scope 重新派单**
7. **B 批与 HL 对齐后**再动;三单都保留,性质改为 re-enable + 三件真新增
8. **D-a 取生产错误原文**后定性;**D-b 连同 D-a 的角色形状 caveat 一起核一次**再关

## 4. 本审计明确没做的事

- **未动任何代码、未关任何单、未改任何 Linear 状态**(只读)
- **未碰 FLY-1356**(E2E 进行中)与 **FLY-1335**(已 QA PASS 停 gate,Annie 已单独认可)
- **未代 HL 决定 B 批任何一单**
- research.md 末尾列了 7 项 **INFERRED 而非 VERIFIED** 的事,本表凡依赖它们的地方都已
  在「风险」列标出 —— 那些地方**不应被当作已定论**
