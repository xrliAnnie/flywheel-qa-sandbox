# FLY-1343 持续周期时间采集与分析 — PRD

Issue: FLY-1343 (https://linear.app/geoforge3d/issue/FLY-1343/prdhl-per-issue-cycle-time-持续研究-并发-load-周期时间采集与分析)
日期: 2026-07-17
基于: exploration.md, research.md

## 0. 一句话

给每张 issue 的耗时**建一套可靠的记录机制**(收口即持久化落库),并在**管理台常驻一个 Dashboard**展示这些数据,同时把 per-issue 耗时**接进已有的每日完成报告**——让「每张单跑多久」被系统性记下来、随时看得见、每天收得到。**不重做「为什么慢」的诊断(Tadashi 已研究过)。**

## 1. Problem(收窄为三个真问题)

**主线**:今天 issue 的耗时**没有被系统性记录、没有常驻展示、每天也收不到**。具体三个缺口:

1. **耗时没被记录** —— issue 收口后,它这一趟花了多久、花在哪,没有任何地方持久化。想知道就得手工重跑 FLY-1327 的一次性工具(`--issues X,Y,Z`),算完即弃。历史无法回看,趋势无从谈起。
2. **没有常驻展示** —— FLY-1327 产出的是一张一次性 HTML 快照,看完就过期。没有一个「随时打开就能看每张单时间线 + 趋势」的地方。
3. **每日完成报告是 dark 的** —— Annie 记得有个「每天告诉我今天完成了哪些 issue」的报告(FLY-727 每日完成 digest)。核实:代码全建好(digest-service + `/api/digest/render` + daily-digest.sh + plist 源 + channel 已配),**但 plist 从没装进 LaunchAgents、launchctl 里没有 → 从没真跑过**。她想在这个每天的报告里加上 per-issue 耗时,好每天 track 效率,但这个报告本身还没开。

**背景与动机(降级,非主线)**:为什么值得记录 —— Tadashi 已把「为什么慢」研究透(六大时间黑洞,交接空窗 0-13h/单为最大头);FLY-1327 一次性快照测出 8 张真实单里空转/排队等待占 62%、慢主要在机制。**这些是「值得记录 + 展示能看出什么」的动机,不是本 PRD 要重做的诊断。** 本 PRD 只负责把这类洞察**可持续地记下来 + 展示出来**,诊断结论引用即可。

## 2. 目标 & 非目标

**目标**
- 每张 issue 收口时,其分段耗时可靠地落库一行,累积成可回看的时间序列。
- 管理台常驻一个「时间线」Dashboard,随时可看每单时间线 + 趋势 + 瓶颈,in-flight 单也可见。
- 把 per-issue 耗时接进每日完成报告(先把这个 dark 的报告开起来)。

**非目标(简化红线)**
- ❌ 不重做「为什么慢」的诊断(Tadashi 已完成,引用即可)。
- ❌ 不发明新站/新服务:复用管理台 + 已有 digest + FLY-1327 采集引擎。
- ❌ 不为「演进」度量扩第一版采集面(见 §4.1 最小集纪律)。
- ❌ 不改任何生产机制、不写入除本机制新表以外的生产数据。

## 3. 成功指标(North Star,两层分开)

**产品北极星**(本机制服务的最终目标,由记录+展示来追踪):
- 每单周期时间(中位)**下降**;机制浪费占比**下降**。

**本机制自身的成功指标**(可验收):
- **记录覆盖率 → 100%**:每张收口的 issue 都有一行耗时记录(必需源可用时),失败显式标注而非静默丢。
- **Dashboard 常驻可用**:随时打开管理台「时间线」页签能看到最新数据;in-flight 单可见。
- **每日报告每天真出**:daily-digest 从 dark 变成每天按时投递,且含 per-issue 耗时列。
- **可辨认性**:一次机制修复能在 ≤N 天内在趋势视图(视图 B)曲线上被肉眼辨认(N 由改进单上线频率与单量定,建议 7 天;上线后按真实数据校准)。

## 4. 主体三章

### 4.1 第一条腿 — 记录机制

**触发(收口增量 + in-flight 轻量)**
- 主路径:issue 到达终态(Done / 终态 session_completed)时,对该单跑一次分析,**增量**落库一行。天然去重、不重算全历史。触发点接线在 Bridge 侧 issue 终态事件(`session_completed` / `isIssueTerminal`),并由每日 cron 做兜底补算(catch-up 漏算的单)。
- in-flight 轻量路径:对 running 单,Dashboard 加载时(或几分钟级 tick)做 as-of 现算,单独走轻量口径(不进「已完成」聚合)。**成本边界**:in-flight 现算只对当前 running 单(数量有限),绝不触发全量重算。

**存储**
- 新增一张 `cycle_time_snapshot` 表(SQLite,StateStore 载体),每 issue 收口一行:as-of、T0/T_end、总墙钟、各分类段时长(value_work/necessary_process/mechanism_waste/execution_waste/human_wait/unknown)、各 label 段时长、诊断计数(pr_count/ci_rounds/review_rounds/head_churn_count/…)、覆盖率、verdict 依据。
- 幂等:同 issue 同 as-of 重跑逐字节一致(复用 FLY-1327 manifest 契约);重复收口以 issue+收口时刻为键 upsert。

**采集引擎(数据源见 §5)**
- 复用 FLY-1327 五源 extractor(纯函数已测,PR #630;需先合入或本机制内联同一套逻辑),方法学内核(归段/归类)不重造。

**度量最小集(每度量绑决策,窄 MVP)**

| 度量 | 支撑决策 / 前后验证 | MVP? | 来源 |
|------|-----------|------|------|
| 每单总周期时间(中位趋势) | 产品北极星 | ✅ | 分段(T_end−T0) |
| 等待 vs 干活 时间比 | 交接空窗/spawn 修完应掉 | ✅ | (mech+human)/value |
| idle_gap(handoff+park)趋势 | FLY-1339 交接接力 / 1336 spawn | ✅ | 已有分段 |
| ci_waiting 趋势 | FLY-1338 CI 砍半 | ✅ | 已有分段 |
| rework_loop 趋势 + review 轮数 | FLY-1340 review 前移 | ✅ | 分段 + diagnostics.review_rounds |
| infra_incident 趋势 | FLY-1345 重启事务化 / 1346 auth | ✅ | 指纹聚类分段 |
| head-churn 次数/单 | FLY-1342 head 漂移治理(应趋零) | ✅ | buildHeadChanges 计数暴露(无新埋点) |
| per-phase 时间分布 | 「下一个修什么」指南针 | ✅ | stage 分段聚合 |
| 机制浪费占比 | 治理判断 | ✅ | 已有归类 |
| 并发数 + load 曲线 | 甜点并发数(达门槛才定量) | ✅ | sessions 叠加 + health load |
| 首轮架构 finding 占比 | review 前移「问题多早暴露」 | ⏳ 演进 | **需新埋点**:给 review finding 分类 |
| 逐 head 文件类型(doc-only 快路径) | doc-only 免全套 review | ⏳ 演进 | 需新埋点 |

**吸收纪律**:①④+②③(轮数)全部由已有五源可推导 → 进 MVP;只有「首轮架构 finding 占比」「逐 head 文件类型」需新埋点 → 演进、注明缺口。**第一版采集面不为演进项扩宽。**

**不烂自检(硬需求,回应 FLY-614 / daily-digest 两个静默坑)**
- 采集失败(必需源 failed)或覆盖率低于阈值 → 该单/该视图**显式标「数据不可用 + 原因」**(复用 FLY-1327 SourceCoverage/no_verdict 语义),**绝不静默出空图或旧图**。
- 采集管线自身故障(收口未触发算、cron 未跑)→ 报错到 `#flywheel-alerts`(复用 LeadAlertNotifier / lead-alert.sh)。
- Dashboard 显示「最后成功采集时刻」,过期即高亮 —— 让退化**可见**。

### 4.2 第二条腿 — Dashboard 展示

**载体**:折进现有管理台(Bridge `GET /`,`bridge/plugin.ts:1320`,端口 9876,localhost)新增「时间线 / Cycle-Time」页签,复用现有 Apple 浅色 + live SSE(`GET /sse`)+ versioned snapshot,不新起站。数据从 §4.1 的表读(live 部分走 SSE)。

**四视图**(形状经 Annie 认可,详见 mockup.html):
- **A 每单时间线**:每行一 issue,横条 = 开单→ship 墙钟,分段着色;in-flight 斜纹 + as-of 截断;点段看证据。最长在上、在跑单高亮。
- **B 趋势 & 改进单前后对比**:X=ship 日期,Y=分类中位墙钟 / 总周期时间;竖线标注改进单上线锚点 → 肉眼看断点(核心用户故事)。
- **C 并发 × load**:双曲线(并发 + load_1m);未达门槛诚实显示「样本累积中·暂不定量」。
- **D 瓶颈排行**:最近窗口各分类总墙钟排行 + 趋势箭头。

**in-flight 可见**(Annie 明确要):正在跑十几小时的单(如 1314)必须当场看得见,标「进行中(as-of 截断)」。

### 4.3 第三条腿 — 每日完成报告集成

**现状事实(已核实,写进 PRD)**:FLY-727 每日完成 digest 代码全建好(digest-service + `/api/digest/render` + daily-digest.sh + plist 源 + `FLYWHEEL_DIGEST_CHANNEL` 已配),**但 `~/Library/LaunchAgents/com.flywheel.daily-digest.plist` 未安装、`launchctl list` 无此项 → 从没真跑过(dark)**。

**需求**:
- (a) **开起来**:安装 plist + `launchctl load`,让每日完成 digest 每天按时真投递。
- (b) **加 per-issue 耗时列**:在这个每日报告里,对当天完成的每张 issue 附上它的总周期时间 + 等待/干活比(数据来自 §4.1 记录机制),好每天 track 效率。

**边界**:开机 + 改报告本身是 **eng build task,交 Tadashi**;PRD 只写需求 + 依赖(**依赖记录机制 §4.1 先落库**,报告才有数据可取)。

## 5. 数据源(五源融合 + DAG 补强,为什么不只用 DAG)

- **主 = FLY-1327 五源**:Linear 生命周期 / teamlead(sessions+events+review+QA)/ CommDB(闸门+唤醒)/ GitHub(PR+CI)/ system-health(load)。gate 等人 / CI / review 轮 / rework / load 的富分解全靠它。
- **补强 = FLY-1307 DAG**:`workflow_run_node`(节点起止耗时)+ `workflow_run_event`(gate_opened/node_completed)。**但它是与 sessions 并行的新系统,只对真走 DAG 编排的 issue 落数**(多数单仍单节点)。→ **只用 DAG 节点耗时会丢维度**;DAG 事件作随采用率增长的补强,不作替代。(此节明确写清,防工程侧走回头路。)
- 运行位置固定在仓库工作目录内(`gh pr list` 靠 cwd git remote 解析仓库,否则 gh 源 failed → no_verdict)。

## 6. 里程碑 & build issues 拆分(交 Tadashi)

按三条腿 + 前后验证消费者拆分(均打 `Flywheel` label 进 Tadashi 队列):

| Build issue(建议) | 内容 | 依赖 |
|--------------------|------|------|
| B1 记录机制 | 采集引擎接入(合 PR #630 或内联)+ `cycle_time_snapshot` 表 + 收口触发 + in-flight 轻量 + 幂等 + 不烂自检 | PR #630 |
| B2 Dashboard 时间线页签 | 管理台新增页签 + 四视图 + SSE + in-flight 可见 | B1 |
| B3 每日报告集成 | 装 daily-digest plist(开起来)+ 报告加 per-issue 耗时列 | B1、FLY-727 |

**前后验证消费者(7 张改进单)**:记录机制上线后,视图 B / 每日报告对以下改进单做 before/after:FLY-1336 spawn 基建 / 1338 CI 砍半 / 1339 交接接力 / 1340 review 前移 / 1342 head 漂移治理 / 1345 重启事务化 / 1346 codex auth 根治(每张绑一个度量,见 research §4)。

## 7. 风险 & 开放问题

1. **「空转」口径**:等 founder ship / 合理夜间等待 vs 机制卡住,记录时至少显式分层标注,展示时可切换,避免高估机制浪费(度量口径细化)。
2. **PR #630 未合**:记录机制依赖 FLY-1327 采集引擎;B1 需先合 #630 或内联同一套逻辑。
3. **DAG 覆盖率**:补强源随采用率增值;MVP 主靠五源,演进路径写清。
4. **daily-digest 开机副作用**:装 plist 是 eng task,需 Tadashi 确认与现有 launchd(token 报告 00:30 / standup 03:00)不撞时;PRD 标依赖。
5. **存储增长**:每单一行,量小;保留策略(全留 vs 滚动窗口)留 eng 定,PRD 不硬性约束。
