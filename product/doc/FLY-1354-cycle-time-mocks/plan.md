# FLY-1354 Cycle-Time Dashboard + 三合一每日报告 — 实施计划(mock 规格)

Issue: FLY-1354 (https://linear.app/geoforge3d/issue/FLY-1354/designerhl-cycle-time-dashboard-三合一每日报告-mock-长相喂-fly-1343-prd-交)
日期: 2026-07-17
基于: exploration.md, research.md · 上游 FLY-1343 prd.md §4.1/§4.2/§4.3 + mockup.html

> 本文件 = **低保真 mock 的屏级规格 + 逐值字段来源表 + 数据诚实契约**。交付物是 mock(HTML),不建库不采集。字段来源表交 Codex design review 把关可建性。
> **R2(Codex design review 后)采纳 6 条**:①删总墙钟汇总(并发下误导)②§3 补全为逐值精确表 ③锚点来源=未定+逐处 MOCK ④真值/示意边界就地标 MOCK ⑤报告加「等待/干活比」列 ⑥in-flight 重构为有界 live-state。P50/P90 保留(见 §3 注)、in-flight 保留(见 §1.5,PRD §4.2 Annie 明确要)——两处附 reconciliation。
>
> **R3(Annie co-eval 第 1 轮 + Lead/Tadashi 定向后重构)**:
> - **面 2 三合一报告重构为「现有 FLY-614 token dashboard + 两处增补」**:Annie「Token 全景 不建 —— 已有 Token Dashboard 不用再新建」。**砍 Token 全景**;报告沿用现有 FLY-614 token dashboard(已 review 多次·不改),只加两块:**①做了哪些事(digest,形状对齐 FLY-727『今日上线 Digest』)②每单花了多少时间(cycle-time,接在现有 per-issue token+cost 旁)**。已获 Annie 认可的「完成清单+每单花销」表 = 这两块合并的形状。见 §2(重写)。
> - **面 1 大 Cycle-Time Dashboard = 新单**(Tadashi 拍,同意我判断:独立上游 FLY-1343 §4.2 + 自己要一轮 co-eval)。**现冻结**(Tadashi 记入重启后队列);现有 `cycle-time-dashboard.html` 保留作新单的种子,mock 索引里留占位说明。本 FLY-1354 收敛到「每日报告 = token dashboard 加两块」。
> - **现有产物已核**:FLY-614 token dashboard(`packages/token-usage/src/report/render-html.ts`)已有 当日总量/趋势/按项目(项目→Leads+当天已完成 issues 的 token+cost)/Leads 排名/按模型/改动前后对比 —— 故 Token 全景确实重复;它有 per-issue token+cost 但**缺 digest(route/PR/summary)+ 每单时间**。FLY-727 digest(`digest-service.ts`)= 「🚀今日上线 Digest」:按项目 shipped issues + 徽章 + PR# + summary。
>
> **R4(Annie 直令:报告并入 Codex 用量)+ homework 结论**:现有报告只算 Claude Code(脚注已标 Codex 暂未并入,见 FLY-714)。**核 codex CLI/日志能给什么**(已真机核):
> - **codex 无 `usage`/`history` 子命令**;但 **rollout 日志有富 token 数** —— `~/.codex*/sessions/YYYY/MM/DD/rollout-*.jsonl` 的 `token_count` 事件 `info.total_token_usage`(**每 session 取最后一条=累计快照**;per-turn 用 `last_token_usage`)= {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens(GPT 特有), total_tokens}。**语义(Codex R7 校正)**:`total = input + output`,**`cached ⊂ input`、`reasoning ⊂ output`(父项子集,不可相加)** —— 要堆叠用 **3 个互斥桶**(uncached input / output-非reasoning / reasoning)+ cache 单列。→ **token 可跟 Claude Code 并列**。
> - **散在 ~19 个 codex home**(`.codex`/`.codex-mufasa`/`.codex-infra-bot`/…,18 含 sessions)→ 聚合需扫全部。真机今日实测:~18M 新增 token(uncached input 16M + output 1.3M;+ cached input 262M 每轮重发)。
> - **review 次数用独立源(R7 校正)**:不是数 rollout session(那只证 Codex session 数、且缺日志时无法自数);用 **`codex_review_job` 表**(teamlead.db,独立追踪 design/code review job,有 `review_type`/`round`/`verdict`,可过滤;今日实测 **55 次 code review**)。日志降级只限「rollout 存在但缺 `token_count`」。
> - **诚实边界**:Codex = ChatGPT 订阅、**非按 token 计费 API** → token = 模型自报用量(非账单),$ = 按 `turn_context.model` × 互斥 token 桶(uncached input / cached input / output 各不同单价)的**公开价估算**;未知价 model 标 N/A 不硬凑(同现有 Claude Code $ 口径,都是订阅参考成本)。
> - **落点**:报告加 **新增③ Codex 用量卡**(新增 token 3 互斥桶 split + cache 单列 + `codex_review_job` 次数 + 参考 $ + 口径注),放在现有 Claude Code「当日总量」后。**建造并入 = FLY-714**。

## 0. 交付物 & 载体

| 文件 | 是什么 |
|------|--------|
| `prototype/cycle-time-dashboard.html` | 面 1:Cycle-Time 视图**折进现有管理台外壳**(cool-slate + 左侧 nav),新 `📈 周期时间` 页签选中态 |
| `prototype/daily-report.html` | 每日报告 v2:现有 FLY-614 token dashboard(不改)+ 两处增补(做了哪些事 + 每单时间);已砍 Token 全景(与现有 dashboard 重复) |
| `prototype/index.html` + `serve.mjs` | 本地一键看两个 mock(参照 FLY-1038 prototype) |

- **交付流程**:commit + **先 push 我的分支** → 交 Lead(Honey Lemon)publish 给 Annie co-eval。**我不 publish、不 founder-facing**。
- **低保真纪律**:结构真;**cycle-time/分段 = FLY-1343 8 单真值**;**其余(token/环比箭头/趋势箭头/日期分组/in-flight 当前态/no-op 计数)= 就地标 MOCK**。一次 clean pass,Annie 过方向再细化。

## 1. 面 1 — Cycle-Time Dashboard(屏级低保真结构)

**外壳**:复用 FLY-1038 `dashboard.html` console chrome + 左侧 nav,新增 `📈 周期时间`(选中态)。视图内分类段沿用 FLY-1343 9 色(数据语义色)。

**自上而下**:

1. **KPI 条(4 tile)**:周期时间 **P50** · **P90**(总墙钟列分位,真值)· **机制浪费占比**(真值)· **在跑单数**(live 计数,MOCK 标注)。**不放「总墙钟汇总」**(并发下求和误导,Codex R1)。ship 单数不作 cycle-time KPI,仅作吞吐上下文另置(见 §1.5)。
2. **视图 B — 周期时间趋势 & 改进单前后对比**(核心「是不是省了时间」):内联 SVG,X=ship 日期,Y=总墙钟(h)。8 真实点(1252→57.9h…1309→9.1h,真值)。**竖虚线锚点标 `MOCK·示意锚点`**(真实改进单尚未 ship,来源未定)。Y 可切:总周期时间 / idle_gap 中位 / ci_waiting 中位 / rework 中位(均总墙钟列/label 段分位)。
3. **视图 D — 瓶颈排行**:横向条,各 **label 段**最近窗口总墙钟 + 占比(真值:空转 125h46·62% / QA 21% / 工作 13% / 审查 2% / 返工 1% / CI 1% / 等人 1%)。趋势箭头位标 MOCK(需持续采集)。
4. **视图 C — 并发 × load**:「样本累积中·暂不定量」占位卡(mockup.html 定版)。
5. **在跑单 live 条**(见 §1.5):有界 live-state。
6. 每视图下 `.cbox` 留言 + 页底 sticky「复制全部反馈」+ 签名。

**明确不放**:View A 每单历史时间线(逐单→归报告)。

### 1.5 in-flight 的处理(Codex R6 + PRD §4.2 reconciliation)

PRD §4.2 明确:「正在跑十几小时的单(如 1314)必须当场看得见」= Annie 的直接要求。Codex R6 提醒逐单枚举与「逐单不进 dashboard」张力。**解**:保留 in-flight,但重构为**有界 live-state 条**——只列**当前 running**单(天然少数,非 1000+ 历史):每行 issue 号 + as-of 墙钟 + 主导分类 + 细条,标「进行中(as-of 截断)」。这是按 PRD §4.2 的**窄例外**(live 态 ≠ 历史逐单明细),在 mock 里当**确定设计**呈现 + 该节 comment 框请 Annie 确认形态。数字标 MOCK(当前态非真采)。

## 2. 每日报告(R3 重构)— 「现有 FLY-614 token dashboard + 两处增补」

**沿用现有 FLY-614 token dashboard 的真实结构/CSS**(Annie 认得出、已 review 不改),只加两块。自上而下:

1. **抬头**:沿用现有 `每日 Token 用量报告 FLY-614` 抬头 + 大日期;副标注明「designer 迭代 v2:现有 dashboard 不改,只加两块」。
2. **现有 Token Dashboard(不改·示意)**:忠实复现现有关键卡 —— 当日总量(input/output/cache split)+ 按项目卡(项目→已完成 Issues 的 token+cost)。标「现有·不改」。
2b. **➕ 新增③ Codex 用量卡**(Annie 直令,放在现有 Claude Code 当日总量后 —— 两个 AI 用量相邻):新增 token(3 互斥桶 uncached input / output-非reasoning / reasoning,**cache 单列不相加**)+ **review 次数(`codex_review_job` 独立源)** + 参考 $(按 model×token 桶公开价)。**口径注就地标**:ChatGPT 订阅非计费 API、token=模型自报用量累计快照、$=参考估算非账单、跨 ~19 codex home 聚合、含 GPT reasoning token(∈output)。建造并入 FLY-714。数字 MOCK(源真可得)。
3. **➕ 新增:做了哪些事 & 每单花了多少(一张表)**——已获 Annie 认可的「完成清单+每单花销」表,= 两块增补合并:
   - `identifier`(真)+ 标题(真)+ **① 做了哪些事**:ship-state 徽章(形状对齐 FLY-727『🚀今日上线』,MOCK)+ PR#(MOCK)+ summary(MOCK);
   - **② 每单花了多少**:**cycle-time 墙钟(真值)** + 阶段 mini-bar(真分段)+ 等待/干活比(真值 `(mechanism_waste+human_wait)/value_work`)+ **token+cost**(现有 dashboard 已有 per-issue,这里并列,MOCK 数字)。
   - 数据 = FLY-1343 4 已完成单示意(cycle-time/分段/比值=真值;日期分组/token=MOCK,不谎称当日完成)。
   - 落点说明:现有 dashboard 「已完成 Issues」只有 token+cost → 本增补给它接上 digest + 时间。
4. **面 1 大 Cycle-Time Dashboard 已拆开**:Annie co-eval round 2 拍「把每日报告和 Dashboard 拆开」→ 报告**不含**大 dashboard 内容,仅页尾一行注记指向 **独立新单**(P50/P90 + 趋势/瓶颈 + in-flight;冻结中,Tadashi 重启后队列);种子 mock 见同目录 `cycle-time-dashboard.html`。
5. 每 section `.cbox` 留言 + 页底「复制全部反馈」+ 签名(nonce 交互)。**砍 Token 全景**(与现有 dashboard 重复,Annie 不建)。

## 3. 逐值字段来源表(交 Codex design review,每个展示值→精确字段/窗口/聚合/真or MOCK)

**窗口约定(Codex R2:所有「窗口」定死)**:
- **KPI / 瓶颈排行 / 机制浪费占比**默认窗口 = **最近 7 天完成单**(rolling 7d,mock 里 KPI/瓶颈排行标「近 7 天」)。
- **视图 B 趋势**:每点 = 一单(散点)或按天聚合的当天 P50(两种呈现,mock 用散点);**Y 切换的分段中位** = 该窗口内对应 `label 段时长` 的分位。
- **趋势箭头(环比)** = 本 7 天窗口 vs **前 7 天窗口**的 Δ。
- **报告**:窗口 = **昨天当日**(PT);每单列 = **该单单次**(非窗口聚合)。
- 窗口大小为建造侧可配参数(mock 取 7 天作示意,与 §4.1「可辨认性 N=7 天」一致)。

**P50/P90 注**:二者均 = `cycle_time_snapshot.总墙钟` 列在窗口内的 50/90 分位——**同一字段不同聚合,无新埋点**;§4.1 最小集列「中位趋势」,P90 是同列另一分位(FLY-1354 issue 明确要 P50/P90)。非发明新度量。

**面 1 Dashboard**:

| 展示值 | 精确字段 · 窗口 · 聚合 | 采集源 | mock 标注 |
|------|------------------|--------|------|
| P50 / P90 周期时间 | `总墙钟`(=T_end−T0),窗口内 50/90 分位 | Linear createdAt/completedAt(§4.1 落列)| 真值 |
| 机制浪费占比 | `mechanism_waste ÷ 总墙钟`(§4.1 ⑨)| 归类聚合 | 真值 |
| 在跑单数 | count(status=running) | sessions | MOCK(live 态)|
| 视图 B 各点 y | 单 `总墙钟` | Linear | 真值(8 单)|
| 视图 B 锚点竖线 | 改进单上线时刻 —— **来源未定**(completed≠live;需 live/部署时间或人工审定,建造侧 FLY-1343 B2 定)| — | MOCK·示意 |
| 视图 B Y 切换(idle/ci/rework 中位)| 对应 `label 段时长` 窗口分位 | 分段聚合 | 真值 |
| 视图 D 各行 | **`label 段时长`**(空转/QA/工作/审查/返工/CI/等人)最近窗口 sum + 占比 | 归段聚合(§4.1「各 label 段时长」)| 真值 |
| 视图 D 趋势箭头 | Δ vs 上一窗口 | 需 ≥2 窗口持续采集 | MOCK |
| 视图 C 并发×load | 度量⑩ | sessions 叠加 + system-health | 占位(未达门槛)|
| in-flight 行(id/as-of/主导分类)| running 单现算(§4.1 in-flight 轻量)| sessions | MOCK(当前态)|

**面 2 报告**:

| 展示值 | 精确字段 · 聚合 | 采集源 | mock 标注 |
|------|------------|--------|------|
| 现有卡:当日总量/split | token-usage `total`(input/output/cacheRead/cacheWrite)| FLY-614(不改)| MOCK 数字 |
| 现有卡:项目→已完成 issues token+cost | token-usage `project`/`issue` 桶(含 cost)| FLY-614(不改)| MOCK 数字 |
| **③** Codex token(3 互斥桶 + cache)| `token_count.info.total_token_usage` **每 session 末条累计快照**求和;`total=input+output`,cache⊂input、reasoning⊂output → 拆 uncached input / output-非reasoning / reasoning + cache 单列(**不相加**)| `~/.codex*/sessions/**/rollout-*.jsonl`(跨 ~19 home)| MOCK 数字(源真可得)|
| **③** Codex review 次数 | count(`codex_review_job`)可按 `review_type`/`verdict` 过滤(**独立源**,缺 rollout 也可数)| teamlead.db `codex_review_job` 表 | MOCK 数字(源真可得)|
| **③** Codex 参考 $ | Σ(各互斥 token 桶 × `turn_context.model` 对应公开单价);未知价 model→N/A | 派生(rollout model + 公开价表)| MOCK · 参考非账单 |
| 每单 identifier / 标题 | issue | Linear / sessions | 真 |
| **①** 每单 route | `payload.decision.route`(或 join `sessions.decision_route`)| session_completed | MOCK |
| **①** ship-state 徽章(🚀已上线/*推断)| **`deployment_events`**(FLY-727 digest 的上线真值源;`session_completed` 只证完成、**不证已上线**)| deployment_events | MOCK |
| **①** 每单 PR | `payload.evidence.landingStatus.prNumber` | session_completed | MOCK |
| **①** 每单 summary | `payload.summary`(或 join `sessions`)| session_completed | MOCK |
| **②** 每单 cycle-time | `总墙钟` | snapshot(§4.1)| 真值 |
| **②** 每单 阶段 mini-bar | `各 label 段时长` | snapshot | 真分段 |
| **②** 每单 等待/干活比 | `(mechanism_waste+human_wait)/value_work`(§4.1 分类桶,§4.3 要求)| snapshot | 真值 |
| **②** 每单 token / 成本 | token-usage `issue` 桶(含 project+cost;现有 dashboard 已有)| FLY-614 | MOCK |
| no-op/blocked 计数 | count(route∈no_code/blocked)| session_completed / sessions | MOCK |

→ 结论:两处增补都可建 —— **①做了哪些事** = FLY-727 digest 已有(**上线真值走 `deployment_events`,非 session_completed**;route/PR/summary 走 session_completed payload 的精确字段);**②每单时间** = FLY-1343 §4.1 `cycle_time_snapshot`;token+cost = 现有 FLY-614。**不发明新指标**;**不新建 Token 全景**(现有 dashboard 已覆盖 total/project/model,Annie 不建)。

## 4. 互动评审 + 技术契约(Annie 硬规矩)

- 每 section `.cbox`:建/不建/待定 单选 + textarea,**localStorage 自动保存**;页底 sticky「📋 复制全部反馈」→ 汇总一键复制回传;末尾签名。逐字复用 mockup.html 模式。
- **FLY-930 nonce**:`<script nonce="__CSP_NONCE__">` + 全 `addEventListener`,**零 inline handler**(grep `onclick=`/`oninput=` 应为 0)。
- **Apple 浅色零暗色**;单文件自含;纯 HTML/CSS/内联 SVG,不引第三方库;≤512 KiB。
- 顶部 `样子稿` banner + 脚注**明确区分真值 vs MOCK**(cycle-time/分段=真;token/日期/箭头/live 态/锚点=MOCK)。

## 5. 开放问题(Annie co-eval 时定,不拦 mock)

- **Q1**:in-flight live 条形态 OK?(mock 已按 PRD §4.2 呈现有界 live-state;Annie 确认留/改)。
- **Q2**:增补(做了哪些事 + 每单时间)作独立表接在现有「已完成 Issues」下方,还是把 digest/时间列直接并进现有 per-issue 行?(mock 用独立表;Annie 可选)
- **Q3**:视图 B 锚点竖线真实数据机制(可验证 live/部署时间 vs 人工审定)——建造侧 FLY-1343 B2 定。

## 6. 建造说明(交 Tadashi,FLY-1343 B2/B3)

- 面 1 = FLY-1343 §4.2 B2「Dashboard 时间线页签」长相定稿(去 View A 历史、加 P50/P90 KPI、in-flight 有界 live 条、折进 console 外壳)。读 `cycle_time_snapshot` + live SSE。
- 面 2 = FLY-1343 §4.3 B3「每日报告集成」长相定稿:在现有 FLY-614 token dashboard 上加两块 —— ①做了哪些事(digest:上线真值走 `deployment_events`[FLY-727 已 live,Tadashi 核] + route/PR/summary 走 session_completed)②每单 cycle-time(§4.1,含等待/干活比)接现有 per-issue token+cost。**不新建 Token 全景**。
- 分类段配色沿用 research §1.5 的 9 色;互动/nonce 按 §4;**所有汇总避免跨并发单求和墙钟**(Codex R1)。

## 7. 验证(mock 无单测,有可验证契约)

mock = 静态 HTML,验证 = **真 CSP 下交互可用**(FLY-930:内联 JS 走 nonce;突变对照——去 nonce 应失效)。Runner 侧自检:本地 serve 打开确认留言/复制/localStorage 可用 + `grep -c 'on[a-z]*=' *.html` inline handler = 0。Lead publish 后可在托管 URL 复验。

---

## R5(推翻 v1-v6,Annie+HL 定向):mock = 真实 Daily Report + 3 原地新增

**根子**:v1-v6 都是我们**自己造的报告壳**,跟 Annie 每天看的真实 Daily Report「驴唇不对马嘴」。**改为:拿真实产物当字面底座,只在上面加东西。**

- **真实底座** = `packages/token-usage/src/report/render-html.ts` 的 `renderReportHtml`(FLY-614 每日 Token 报告)。**照抄它的 CSS+DOM 结构别改样**:h1『每日 Token 用量报告 FLY-614』+ bigdate + sub(范围注:仅 Claude Code,Codex 暂未并入见 FLY-714)+ 改动前后对比 + 总用量随时间(SVG 柱+每项目折线)+ 当日总用量(大数+split)+ 按项目展开(项目→Leads+当天已完成 Issues[现只 token+$])+ Leads 排名 + 按模型。
- **生成方式**:`prototype/render-real-report.mjs` 直接 import 编译版 `renderReportHtml` + 喂 populated fixture ReportModel(真实 7 项目 geoforge3d/joycon-typeless/personal-assistant/growth/flywheel/tidal-echo/polaris + 真 issue id + 真 leads)→ 得到 CSS/结构与真实报告**字节一致**的 base;再 post-process 原地注入 3 新增。(真实每日 per-day 数据当前为 0[FLY-713 采集空态],故用 fixture 填内容看形状;结构=真。)
- **3 原地新增**(轻标『新增』):
  ① **做了哪些事** = 每项目『已完成 Issues』每行补一句『🆕 做了啥』(FLY-727 digest 形状:结果/上线态/一句话)。建造真值:route/summary 走 `session_completed`,上线态走 `deployment_events`(FLY-727)。
  ② **每单耗时** = 同行补 cycle-time(⏱ 墙钟)。建造真值:FLY-1343 §4.1 `cycle_time_snapshot.总墙钟`。
  ③ **Codex 当日用量** = 一块仿 summaryCard 的卡(一个大数 + split[uncached input/cache/output/reasoning] + 参考$ + review 次数)。建造真值见 R4(rollout `token_count` 累计快照 / `codex_review_job` 次数 / 订阅参考成本 / FLY-714 并入)。
- **纪律**:方法论/口径/建造注**全在本 plan.md**;founder-facing mock **只留样子**、页面不塞口径注(只一行『细节在 plan』)。数字 fixture=示意,结构/耗时逻辑=真;大 dashboard 已拆 FLY-1360、不在日报里。

---

## R6(v8 handoff spec — Annie v7 反馈,HL green-light 的 6 条钉死)

**接手方式**:改 `prototype/render-real-report.mjs`(fixture)+ post-processor(base HTML 上原地改),重生成 `prototype/daily-report.html`。底座仍 = 真 `renderReportHtml`(FLY-614)字节一致。**建完 push + 贴 HL preview,别 push founder、别 ship。**

Annie v7 反馈,6 条(HL 核过 22:53/22:55 原话钉死):
1. **Codex 在【所有维度】和 Claude Code 并排** —— 不只『当日总用量』一张卡:
   - **总用量随时间(趋势)**:趋势图加一条 Codex 序列(fixture 给 Codex 一份 trend 数据;post-process 往 trendBars/trendLines 的 SVG 注入 Codex 线/柱,或复制趋势卡做 Claude vs Codex 双图)。
   - **按模型**:加 Codex 的模型(gpt-5.x 等)行。
   - **Leads 排名 / 排名 list**:加 Codex 维度(Codex 无 Lead 概念→可改成『按 Claude Code / Codex 分』或加 Codex 一行)。
2. **issue『做了啥』去 label**:不写『🆕 做了啥:』前缀,直接把它做的事写在 issue 行下面。
3. **描述多留 context 写详实**:每个 issue 做了什么写清楚(不然看不懂),别截断。
4. **去 per-issue 价钱『<$0.01』**:mock 里直接去掉 issue 行的 `.su`($)列(拿不到 per-issue 有意义的 $)。
5. **去『新增/耗时多少』这类 label**:耗时直接放时间数,不加 label。
6. **去所有多余解释文字**:banner 说明、Codex 卡口径注、ph2『新增』标 全撤,页面只留干净报告样子。方法论/口径仍留本 plan.md。

**注意**:renderReportHtml 原生不支持 Codex 平行序列 → 走 post-process 注入(参照现 post-processor 的 srowp/Codex 卡注入法)。Codex 数据用 fixture/示意(结构真、数值 MOCK,但页面不标 MOCK label 因 Annie 要去解释 —— 数值示意性靠 plan 记,页面干净)。

---

## R7(Annie 结构性重构,lead-instruction b605b021,2026-07-20)— 两层拆分

**根因**:老「按项目展开」把两种口径混在一起 → 一个 issue 被两个 agent 干,就在 Codex/Claude 底下各写一遍 = 重复。Annie 的刀:token 是【按 agent、可重复=对】,完成工作是【按 issue、只一次】,必须彻底分开。

**重做成两层**(交付 = `prototype/daily-report-multiagent.html`,报告改名「每日报告」):
- **① Token 用量报告**(纯按 agent 账):改动前后 / 总用量随时间 / 当日四色拆 / 按模型 / Leads 排名 + 按项目·纯token(项目→按 agent 堆叠,**不含 issue**)。一个 issue 两 agent 各自计入这层=对的(是账不是重复)。**不讲每个 issue 做了啥。**
- **② 今日完成工作**(按 issue,每个只一次):按项目分组,每 issue = id+跳链+agent 色点(谁碰过)+总 token(跨 agent 汇总)+墙钟+描述;**三段式(design·claude/implement·codex/qa·claude)= 该 issue 的展开细节**,放它下面(一次),既看到谁做哪段又不重复写。
- **判断点**:①里保留「按项目·纯token」小卡(纯账,非老混写卡)——待 Annie 定去留;三段式放 ② 当 issue 展开(Annie 默认,待她最终确认)。
- **加 Kimi 第三 agent**(示意)实证 E 自动扩展(FLY-494 kimi 后端已上)。nonce/数据驱动/Apple 浅色不变。数据自洽(每 agent 当日=项目和=模型和;fleet 5.20B)。

---

## R8(Annie 质疑三段式粒度 → 后端核实,lead-instruction adde9e35,2026-07-20)

**Annie**:『design·Claude/implement·Codex/qa·Claude 这么细的按段 token,我们什么时候展开到这么细?我没看到。』—— 对。诚实页原则:别展示后端不一定有的粒度。

**核实结论 = 没有 per-stage + per-agent token 能 join 到 issue**(file:line 铁证):
- token-usage 存储维度写死 `Scope = total|project|lead|issue|model`(`packages/token-usage/src/types.ts:9`);`aggregateDaily` 只吐这 5 个 scope(`aggregator.ts:151-155`)。**无 stage,无 agent。**
- issue 档 token 拍平:一个 issue 的所有 runner token 加进一个桶(`aggregator.ts:133-134`),不分段不分 agent。
- 分类器算了 `role`(qa 后缀)但 `UsageRecord` 丢弃它(`types.ts:28-43` 无 role 字段 vs `Classification.role` `types.ts:22`);聚合里零处用 role。
- 整条管线只吃 Claude Code jsonl(`types.ts:4`)→ Codex/Kimi token 未并入(FLY-714)→ per-agent token 现不存在。
- design/implement/qa 只活在编排层:FLY-887 三段式 TURN 是 worktree 独占锁 `grantTurn(issueId,holderExecId,phase)`(`db.ts:2073`),**零 token**;phase keep-alive 是 zero-token phase control(`codex-daemon-client.ts:615/1201`)。

**决定(honest-page)**:② 今日完成工作 **砍掉按段 token 拆**,也不显示 per-agent 的 per-issue token(同因缺粒度)。② 保留:issue id + Linear 跳链 + **谁做的(agent 色点+名字 —— 真实 issue↔agent 关系,来自会话/FLY-887 TURN)** + 墙钟 + 描述。token 账全在 ① 层。
- **未来若要按段 token**:需新埋点(token 管线加 stage+agent 维度、join FLY-887 TURN 的 phase+holderExecId + 并入 Codex/Kimi 采集 = FLY-714/新单)。
- **label-only 中间态**(『谁做了 design/implement/qa 哪一段』无 token):可由 FLY-887 TURN 表(issueId+phase+holderExecId)join 出来,是真实关系但需新 join,现未接 —— 留作 Annie 若要的后续。

---

## R9(Annie 两条改法,lead-instruction 9afde2ce,2026-07-20)— 嵌套页签 + per-issue token 回归

**① 嵌套 tab(不再一条长滚动)**。Annie:『而不是像现在这样,把所有东西都融合在一起』。
- **第一层**:【今日完成工作】|【Token 使用】。
- **第二层**(只在 Token 使用内):按 agent 分 —— 全部 / Claude Code / Codex / Kimi,**从 `DATA.agents` distinct 自动生成**(加 agent 前端零改 = E)。
- 两个页签内容互斥:完成工作页签无 token 账卡片,Token 页签无 issue 行 —— 就是「不融合」。

**② per-issue token 回归**(上一轮 Lead 砍多了)。Annie:『每一个 issue 它都有用到多少 token,这一层的东西你完全都没有体现出来,明明之前都是有体现出来的呀』。
- 复盘:她当初质疑的是**三段式按段拆 token**(后端确实没有 → **继续砍,不回来**),**不是** per-issue 总量。
- 故 ② 每个 issue 恢复显示:**这单用了多少 token** + 谁做的(agent 色点+名) + 墙钟 + 描述 + 可点跳 Linear。数据层 `it.tokens` 恢复;`it.by` 仍是 presence-only 列表(不按 agent 拆 token —— 那个粒度后端没有)。

**诚实口径(页面就地标,别丢)**:② 段末 `.honest` 注 —— 每单 token = 这单总量;**当前只有 Claude Code 的 per-issue 是真实采集**,Codex/Kimi 的 per-issue **后端尚未并入**(FLY-714),此处按**设计目标/示意**呈现,不代表已有真数据。①层账不变。

**验证**:两层 tab 真机点过 —— 默认完成工作(9 单各一次 + 9 个 per-issue token)→ 点 Token 使用(work 行归零、账卡出现、L2 四个 agent tab)→ L2 切 Codex / Kimi(各自账)→ 切回完成工作(9 单恢复);零 inline handler、nonce 单一。

---

## R10(Annie 截图指问题,lead-instruction 46ee8c79,2026-07-20)— ① 恢复「项目→issue」细粒度

**问题**:①「按项目·纯 TOKEN」退化成每项目一条总量条,标题还写『不含 issue 明细』—— **细粒度就丢在这**。Annie:『我们不是按项目分的话,每个项目底下还要细分说每一个 issue 用了多少 token 吗?』

**口径对齐(之前理解偏了)**:她说 ① 不用『详细讲每个 issue 做了什么』= 不要重复**工作描述**(归 ②);但**每个 issue 用了多少 token 是【账】**,本来就该在 ① 按项目往下细分 —— 真日报 FLY-614 就是 项目→展开→issue。我们把「描述」和「账」当成一件砍了,整层 issue 从 ① 消失。

**逐分区对照真实 daily-report.html(防再丢别的)**:改动前后 ✓ / 总用量随时间 ✓ / 当日总量+Codex当日 ✓(合并成每-agent 四色拆) / **按项目展开 ✗ ← 唯一缺口** / Leads 排名 ✓ / 按模型 ✓。确认只缺这一处。

**改法(已落地)**:① 的 `projectAccountSection()` 对齐真实结构 —— 项目总量条(按 agent 分色) → 两列 **Leads（本项目）** + **已完成 Issues（当天用量,每单 token)** → **+N 个进行中 issue** muted 行。**跟随二级 agent 页签**:切 Codex 显示 Codex 在这些 issue 上的量(FLY-1307=180M 而非 340M 合计),切「全部」显示合计;非-Claude agent 的 Leads 列如实显示『无 Lead 概念』。**只有数字/条,不带工作描述**。标题去掉『不含 issue 明细』。
- 数据层:issue 恢复 `byAgent:{claude:N,codex:M}`(per-agent-per-issue,示意),② 的总量/色点由它求和/取键派生。
- **诚实注**(① 段末):这里是账(项目→issue→数字),描述在 ②、两边不重复;当前只有 Claude Code 的 per-issue 是真采集,Codex/Kimi 的 per-issue **以及按 agent 切到单个 issue** 都要等后端并入 + 加 agent 维度(FLY-714)→ 按**设计目标/示意**呈现。
- ② 今日完成工作**不动**;三段式仍不做;nonce 硬门照旧。

**踩到的真 bug(验证抓出)**:两层 tab 重写时 `bars()` helper 被丢了,新 `projectAccountSection()` 调它会直接抛 —— 补回后真机零 JS 错。
