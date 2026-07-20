# FLY-1343 持续周期时间采集与分析 — 调研

Issue: FLY-1343 (https://linear.app/geoforge3d/issue/FLY-1343/prdhl-per-issue-cycle-time-持续研究-并发-load-周期时间采集与分析)
日期: 2026-07-17
基于: exploration.md

本调研结论来自真机核实(只读)+ 代码定位,无推测。

> **重心重定向(Annie,2026-07-17 看样子稿后)**:PRD 主体 = ①记录机制 + ②Dashboard 展示 + ③每日报告集成(§2.5)三条腿,**不重做「为什么慢」的诊断**(Tadashi 已研究过)。本调研里的六黑洞 / 62% 空转(§5)自此**降级为背景与动机**(说明「值得记录、展示能看出什么」),不作为 PRD 主线。

## 1. 数据源逐一核实

### 1.1 复用源 = FLY-1327 五源(采集引擎骨架)

FLY-1327 的 `scripts/cycle-time/lib/collect.mjs` 已把下列 5 源做成 as-of 时点正确的只读快照抽取(I1 无逻辑写入):

| 源 | 位置 | 提供 |
|----|------|------|
| Linear GraphQL | `LINEAR_API_KEY`(~/.flywheel/.env) | issue createdAt/completedAt + 状态转换史(T0/T_end) |
| teamlead.db | ~/.flywheel/teamlead.db | sessions(started_at/terminal_at/status/session_role/pr_number)、session_events(stage_changed/qa_result/…)、codex_review_job(review 轮)、auto_qa_record(独立 QA) |
| CommDB | ~/.flywheel/comm/flywheel/comm.db | messages(brainstorm/approve gate 问答)、runner_phase_wakes(唤醒排队延迟,epoch ms) |
| GitHub(gh CLI) | — | PR createdAt/mergedAt、每轮 CI run createdAt→updatedAt+结论 |
| system-health log | ~/Library/Logs/system-health/*.log | load_1m 60s 曲线(load 饱和标注) |

真机验证:本调研用该工具跑 8 张真实 issue 全部 `analyzed` 出真实分段(§3 exploration)。**采集引擎直接复用,不重写。**

> 注意坑(已踩):`gh pr list` 靠 cwd 的 git remote 解析仓库 —— 采集必须在仓库工作目录内运行,否则 gh 源 failed → required 源失败 → 整单 no_verdict。持续机制的运行位置要固定在仓库内。

### 1.2 补强源 = FLY-1307 DAG 落库(随采用率增值)

FLY-1307 的 DAG 节点耗时(schema 全在 `packages/teamlead/src/StateStore.ts`):

- `workflow_run`(:11879)—— run→issue 映射(`issue_id`)。
- `workflow_run_node`(:11929)—— 每节点 `started_at`(admit 时写)/ `ended_at`(state='done' 时写)/ `execution_id` / `state`。**耗时 = ended_at − started_at,非预存列,要现算。**
- `workflow_run_event`(:11944)—— append-only 事件流,kind ∈ {node_dispatched, node_completed, gate_opened, edge_traversed, loop_iteration, …},是 DAG 运行最富的阶段时间线。
- join:`workflow_run_node.execution_id` → `sessions.execution_id`;`workflow_run.run_id` → `workflow_run.issue_id`。

**关键真相**:`workflow_run_node` 与 `sessions`/`session_events` 是**两套并行系统**,只对真走 DAG 编排的 issue 落数;多数 issue 仍单节点。→ MVP 主靠五源(§1.1),DAG 事件作为 `gate_opened`/`node_completed` 的**精化补强**,随 DAG 采用率增长而增值。**不作替代**(Q2 冻结)。

### 1.3 stage 转换事件(段切点主力)

`session_events`(StateStore.ts:1291,索引 `idx_events_type_ts` :1676 支持按 ts range-scan)关键 event_type:`stage_changed`(onboard/brainstorm/…/completed)、`session_started/completed/failed`、`qa_result`、`three_stage_fix_round`、`codex_review_result`、`gate_question`。归段所需切点已全部可得(FLY-1327 §4 已验证)。

## 2. 持续机制的技术形态

### 2.1 触发(Q3:收口增量)

- **主路径 = issue 收口即算一次**:issue 到达终态(Done / 终态 session_completed)时,对该单跑一次 FLY-1327 分析,把结果**增量**落库一行。天然去重、不重算全历史。
- **in-flight 轻量路径(Q5)**:对 running 单,dashboard 页面加载时(或几分钟级 tick)做 as-of 现算,单独走轻量口径(不进「已完成」聚合)。成本边界写进 PRD:in-flight 现算只对当前 running 单(数量有限),不触发全量重算。
- 触发点接线候选:Bridge 侧 issue 终态事件(`session_completed` / `isIssueTerminal`)钩子,或复用现有 launchd digest cron 做兜底补算(catch-up 漏算的单)。

### 2.2 存储(累积成时间序列)

- 新增一张 `cycle_time_snapshot`(或类似)表:每 issue 收口一行,存 as-of、T0/T_end、总墙钟、各分类段时长(value_work/necessary_process/mechanism_waste/execution_waste/human_wait/unknown)、各 label 段时长、诊断(pr_count/ci_rounds/review_rounds/…)、覆盖率、verdict 依据字段。存 SQLite(与 teamlead.db 一致的 StateStore 载体)。
- 幂等:同 issue 同 as-of 重跑逐字节一致(FLY-1327 manifest 契约已保证);增量写用 issue+收口时刻做键,重复收口 upsert。
- 趋势(视图 B)= 按 issue ship 日期读这张表;瓶颈榜(视图 D)= 按最近窗口聚合;并发×load(视图 C)= 由全量 sessions 区间叠加重建并发曲线 + system-health load 曲线(门槛满足才定量)。

### 2.3 呈现载体(已核实)

- 管理台在 **Bridge `GET /`**(`packages/teamlead/src/bridge/plugin.ts:1320`,默认端口 9876 loopback),现有两个 HTML 面:`dashboard-html.ts`(运营 dashboard,指标卡+session 列表,`GET /sse` live)与 `fleet-console-html.ts`(FLY-1262 统一管理台,versioned snapshot + stage→confirm→apply)。
- **新增「时间线 / Cycle-Time」页签** = 在这套管理台里加一个视图,数据从 §2.2 的表读(+ live 部分走 SSE)。复用现有 Apple 浅色 + SSE + versioned snapshot 基建,不新起站。
- 兜底/补充:趋势摘要可同时经 `POST /api/digest/render` 折进 FLY-727 每日 digest(publish-report 投递),给「不在电脑前也能收到」的场景。

### 2.4 不烂自检(Q4 硬需求)

FLY-614 token 报告今早被抓到静默退化。本机制的硬需求:

- 采集失败(某 required 源 failed)或覆盖率低于阈值 → 该单/该视图**显式标「数据不可用 + 原因」**(复用 FLY-1327 的 SourceCoverage / no_verdict 语义),**绝不静默出空图或旧图**。
- 采集管线自身故障(收口未触发算、cron 未跑)→ 报错到 `#flywheel-alerts`(复用现有 LeadAlertNotifier / lead-alert.sh 告警通道)。
- 视图上显示「最后成功采集时刻」,过期即高亮 —— 让退化**可见**而非隐形。

## 2.5 每日完成报告集成(第三条腿)— 现状核实

Annie 记得有个「每天告诉我今天完成了哪些 issue」的报告(明确不是每日 token 报告),要把每 issue 耗时加进去,好每天 track 效率。核实 = **FLY-727 每日完成 digest**:

| 组件 | 状态(2026-07-17 真机核实) |
|------|---------------------------|
| `packages/teamlead/src/bridge/digest-service.ts`(aggregateDeploymentDigest / renderDigestHtml) | ✅ 存在 |
| `POST /api/digest/render`(digest-route.ts) | ✅ 存在 |
| `scripts/daily-digest.sh`(渲染 → publish-report) | ✅ 存在 |
| `scripts/com.flywheel.daily-digest.plist`(源) | ✅ 在仓库 |
| `FLYWHEEL_DIGEST_CHANNEL` | ✅ 已配 |
| **`~/Library/LaunchAgents/com.flywheel.daily-digest.plist`(实际安装)** | ❌ **不存在** |
| **`launchctl list` 里的 daily-digest** | ❌ **无(未加载)** |

**结论:代码全建好,但 plist 从没装进 LaunchAgents、launchctl 里没有 → 这个报告是 dark 的(silent no-op,从没经 cron 真跑过)。** 这与 FLY-614 token 报告静默退化是同类坑的另一面:一个退化、一个从没开过。

**第三条腿的 PRD 需求**:(a) 如实记录「该报告目前 dark」这一事实;(b) 需求 = 开起来(装 plist + launchctl load)+ 报告里加 per-issue 耗时列(依赖记录机制 §2.2 先落库)。**开机本身是 eng build task 交 Tadashi,PRD 只写需求 + 依赖,不写实现。**

## 3. 度量最小集(每度量绑决策,Q1 窄 MVP)

按 Honey Lemon 吸收纪律:已有五源分段能直接推导的进 MVP;需新埋点的进「演进」并注明缺口,不为它们扩第一版采集面。每条绑「支撑哪个决策」。

| 度量 | 支撑的决策 / 前后验证 | 消费视图 | MVP? | 采集来源 |
|------|-----------|----------|------|----------|
| 每单总周期时间(墙钟,中位趋势) | 整体是否变快 = 产品北极星 | B | ✅ | 五源分段(T_end−T0) |
| **① 每单「等待 vs 干活」时间比** | 黑洞 1+2(交接空窗+spawn 失败)修完应显著掉 | A/B/D | ✅ | 已有分段:(mechanism_waste+human_wait)/value_work |
| idle_gap(handoff+park)段趋势 | 验证 **FLY-1339 交接接力** + **FLY-1336 spawn 基建** | B/D | ✅ | 已有分段 |
| ci_waiting 段趋势 | 验证 **FLY-1338 CI 砍半** | B/D | ✅ | 已有分段 |
| rework_loop 段趋势 | 验证 **FLY-1340 review 前移** | B/D | ✅ | 已有分段 |
| infra_incident 段趋势 | 验证 **FLY-1345 重启事务化** + **FLY-1346 codex auth** | B/D | ✅ | 已有分段(指纹聚类) |
| **② head-churn 次数/单** | 验证 **FLY-1342 head 漂移治理**(应趋零) | B/D | ✅ | `buildHeadChanges` 已采,只需计数暴露(无新埋点) |
| **③ 单均 review 轮数** | 验证 **FLY-1340 review 前移**(轮数应降) | B/D | ✅ | `diagnostics.review_rounds` 已算 |
| 机制浪费占比(mechanism_waste/可分类) | 「慢在机制还是执行」治理判断 | A/D | ✅ | 已有归类 |
| **④ per-phase 时间分布**(design/implement/QA/等批) | 「下一个修什么」指南针 | A/D | ✅ | 已有 stage 分段聚合 |
| 并发数 + load 曲线(达门槛后) | 甜点并发数 → 并发策略 | C | ✅(门槛满足才定量) | 全量 sessions 区间叠加 + health load |
| **③′ 首轮架构 finding 占比** | 验证 review 前移「问题多早暴露」 | D | ⏳ 演进 | **需新埋点**:给 codex_review finding 分类(架构级 vs 局部);当前 `codex_review_job` 只有 verdict/round,无 finding 类型 |
| 逐 head 文件类型分类(doc-only 快路径) | doc-only 免全套 review | — | ⏳ 演进 | 需新埋点:逐 head diff 文件类型 |

**吸收纪律落地**:Tadashi 的 3+1 需求 ①④ + ②③(轮数)全部落在「已有五源可推导」→ 进 MVP;只有 ③ 的「首轮架构 finding 占比」需给 review finding 分类,进演进、注明缺口。**第一版采集面不为演进项扩宽。**

## 4. 改进单前后验证机制(消费者从 4 张扩到 7 张)

Tadashi 的在修机制清单 = **7 个前后验证消费者**(每个绑一个度量):

| 改进单 | 治的黑洞 | 验证度量 |
|--------|----------|----------|
| **FLY-1336** spawn 基建 | 黑洞 2(满载 spawn 随机失败) | idle_gap(park_wake)+ infra_incident 段趋势;等待/干活比 |
| **FLY-1338** CI 砍半 | 黑洞 5(CI 全量重跑 ~19min) | ci_waiting 段趋势 |
| **FLY-1339** 交接接力 | 黑洞 1(交接空窗,最大头 0-13h/单) | idle_gap(phase_handoff)段趋势;等待/干活比 |
| **FLY-1340** review 前移 | 黑洞 4(架构问题 R3/R4 才暴露) | 单均 review 轮数 + rework_loop 段趋势 |
| **FLY-1342** head 漂移治理 | 黑洞 3(head 漂移重跑税 30-90min/例) | head-churn 次数/单(应趋零)+ ci_waiting |
| **FLY-1345** 重启事务化 | 黑洞 1/2 的重启损耗 | infra_incident 段趋势 |
| **FLY-1346** codex auth 根治 | 黑洞 6(配额/认证撞墙,一撞全队停) | infra_incident 段趋势 |

本机制上线后:视图 B 竖线标注每个改进单的**上线锚点**(取其 merge 日期);上线后新收口的单,对应度量落在锚点右侧;对比锚点前后中位值 → 肉眼/定量看断点。dashboard 自身成功指标 = 一次机制修复能在 ≤N 天内在曲线上被辨认(N 由上线频率与单量决定,PRD 给具体值)。

## 5. Tadashi「为什么长 / 怎么修」想法 — 必收项(已收,2026-07-17 经 HL 转)

工程侧直觉与本调研的数据结论(空转/等待主导)**一致**:六大时间黑洞里,量级最大的两个(交接空窗 + spawn 失败)都是「等待」类,坐实 verdict=mechanism。

### 5.1 六大时间黑洞(Tadashi 按量级排序)

| # | 黑洞 | 量级 / 实录 | 归到本机制的段 |
|---|------|-------------|----------------|
| 1 | **交接空窗**(最大头) | 1327 测算 0-13h/单;phase 完成后等下一段 spawn/唤醒,靠 Lead 人肉发现。今晨:1347 implement 连死 3 次、1327 QA 段 28 分钟没起 | idle_gap(phase_handoff / park_wake) |
| 2 | **spawn 基建随机失败**(满载时) | tmux 起进程即死 / API 超时但其实起了→诱导重试撞锁;今晨 5+ 例 → FLY-1336 | idle_gap(park_wake)+ infra_incident |
| 3 | **head 漂移重跑税** | QA 报告/账本 commit 进 PR 分支 → 整轮 review+QA+批准作废重来;昨晚 3 例(1328/1307/1323)每例 30-90min | head-churn 计数 + ci_waiting + rework_loop |
| 4 | **review 串行返工轮** | 架构级问题 R3/R4 才暴露,每多一轮=改版+重排队 | rework_loop + review 轮数 |
| 5 | **CI 全量重跑** | ~19min/次 × head 前移次数 | ci_waiting |
| 6 | **配额/认证撞墙** | 5h 窗口、codex auth 漂移,一撞全队 merge 停 | infra_incident |

### 5.2 Tadashi 要 dashboard 验证的 3+1(= 最小集直接需求方)

- **① 每单「等待 vs 干活」时间比**(黑洞 1+2 修完应显著掉)→ 已有分段直接推导,**进 MVP**(§3)。
- **② head-churn 次数/单**(1342 落地后应趋零)→ `buildHeadChanges` 已采,计数暴露即可,**进 MVP**。
- **③ 单均 review 轮数**(1340 前后对照)→ `diagnostics.review_rounds` 已算,**进 MVP**;其「**首轮架构 finding 占比**」需给 review finding 分类的新埋点 → **进演进**(§3 注明缺口)。
- **④ per-phase 时间分布**(design/implement/QA/等批)= 「下一个修什么」的指南针 → 视图 A/D 的聚合,**进 MVP**。

### 5.3 对 mockup / 视图 D 的印证

视图 D(瓶颈排行)当前用 8 张真实单的实测段聚合,头号 = 空转/排队等待(125h46,62%)—— **正是 Tadashi 的黑洞 #1「交接空窗」**,数据与工程直觉互相印证。他的六黑洞排序可作为视图 D 的注解叙事(把实测 label 映射到人话黑洞名),PRD/mockup 迭代时加。

## 6. 对 PRD 的输入(要点)

- 采集引擎 = 复用 FLY-1327 五源 extractor(需先合入 PR #630,或本机制内联同一套逻辑);DAG 事件补强源随采用率增值。
- 触发 = issue 收口增量 + in-flight 轻量 as-of 现算(成本边界写清)。
- 存储 = 新表累积 per-issue 段汇总,幂等+去重。
- 呈现 = 管理台「时间线」页签(复用 GET / :9876 + SSE + versioned snapshot),趋势摘要可折进 FLY-727 digest 作补充。
- 不烂自检 = 覆盖率/失败显式「数据不可用」+ alerts + 「最后成功采集」可见,硬需求。
- 度量最小集 = §3 七条,每条绑决策/改进单。
- 演进(非 MVP)= 七类瓶颈全谱系、逐 head 文件类型 doc-only 快路径、DAG 深度分段、甜点并发数定量。
