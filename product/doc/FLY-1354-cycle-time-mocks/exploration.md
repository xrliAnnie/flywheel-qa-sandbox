# FLY-1354 Cycle-Time Dashboard + 三合一每日报告 — 探索

Issue: FLY-1354 (https://linear.app/geoforge3d/issue/FLY-1354/designerhl-cycle-time-dashboard-三合一每日报告-mock-长相喂-fly-1343-prd-交)
日期: 2026-07-17
基于: 上游 FLY-1343(记录机制 + 高层指引,PRD 未启动)· FLY-1327(已真机验证的采集/分析工具)

---

## 1. 目标 / 交付边界

Annie 直令(2026-07-17,FLY-1343 thread):把 cycle-time 的**两个展示面的具体长相 mock 出来**。

- 本 issue 只做**视觉设计(mockup)**:交付 = HTML mock。**不碰采集 / 建库**(那是 FLY-1343 记录机制)。
- 流程 = **designer 出 mock → Annie co-eval 过方向 → 交 Tadashi 建**。
- 纪律 = **mockup-first**(FLY-1038):低保真样子稿(结构真、数据 mock、一次 clean pass)→ Annie 确认方向 → 再细化。**不在 Annie 见到一个像素前重投入。**

## 2. 要 mock 的两个面

### 面 1 — Cycle-Time Dashboard(折进现有管理台的新页签)

- **载体**:现有 Bridge GET / :9876 管理台(FLY-1038 原型)的**一个新页签**,复用它的 cool-slate 浅色 + ◆ indigo 强调色,视觉与现有 nav(🗂 实例 / 🚩 Feature Flags)一致。
- **只放统计维度**(Annie 明确:不放 1000+ 单逐条明细,不现实也没必要)。
- **核心问题**:「我们做了某个改动/优化,是不是真的省了时间?」→ 趋势曲线上看得出**断点**。
- **必备视图**:
  1. 顶部 KPI:每单周期时间 **P50 / P90**(+ 环比箭头),昨日/本周 ship 单数,waste 占比(空转+返工+基建)。
  2. **周期时间趋势**(按天):P50 线 + P90 带 + **变更标注竖线**(某优化上线日,如「FLY-1338 CI 砍半」)→ 这是「是不是省了时间」的直接答案。
  3. **阶段构成趋势**(按天堆叠面积):排队 / 工作 / CI / 审查 / QA / 返工 / 空转 / gate 等批 —— 时间都花哪、waste 是否在缩。
  4. (可选)**每阶段 sparkline 小图**:CI 等待、审查、返工各自随天走势,单看某一项优化前后。

### 面 2 — 三合一每日报告(从零 clean HTML,一份读全昨天)

完成 digest 目前 **dark**(FLY-727:代码建好但 plist 从没装、没人见过样子)→ **从零 mock 干净的三合一,不逆向现有报告**。三个维度整合进同一份:

- **① 整体 token**(FLY-614 每日 token 报告):昨天整个 fleet 花了多少 token,按项目/模型分。
- **② 做了哪些事**(FLY-727 完成 digest):昨天哪些单完成了 —— identifier + 标题 + route + PR + 一句话 summary。
- **③ 每单(ECU)分别花了多少**:每个完成单的**时间 + token**。

**布局取向**(待 Annie co-eval):头部 headline 数字条 → **完成清单**(把 ② digest 与 ③ 每单花销**合并成一张表**:每单 route/PR/summary/cycle-time/token,一行看全)→ **Token 全景**(①,按项目/模型,含未 ship 的 idle/QA/research 消耗,因为 token 不只花在 ship 的单上)。这样三维度齐全且不重复。

## 3. 数据模型 = FLY-1343 PRD §4.1(已写,权威)+ mockup.html(真实数据)

> **R2 修订(2026-07-17,Lead brief + 找到真实文档后)**:早先误以为 FLY-1343 §4.1 未写。实为 **`flywheel-FLY-1343` 分支** `product/doc/FLY-1343-continuous-cycle-time/` 已有 **prd.md(§4.1 记录机制 + 度量最小集)** 与 **mockup.html(8 张真实 issue 的 A/B/C/D 四视图样子稿,Annie 已认可形状)**。Annie 红线:**用真实数据/真实结构,不发明新指标**。本 mock 照 §4.1 度量最小集设计,复用 mockup.html 的真实数据与配色。

**存储 = `cycle_time_snapshot` 表**(每 issue 收口一行,§4.1):as-of、T0/T_end、总墙钟、**6 大分类段时长** `value_work / necessary_process / mechanism_waste / execution_waste / human_wait / unknown`、各 label 段时长、诊断计数(pr_count / ci_rounds / review_rounds / head_churn_count)、覆盖率、verdict 依据。

**度量最小集(§4.1,只用这些,不发明)**:①每单总周期时间中位趋势 ②等待 vs 干活比 ③idle_gap 趋势 ④ci_waiting 趋势 ⑤rework_loop+review 轮数 ⑥infra_incident 趋势 ⑦head-churn/单 ⑧per-phase 分布 ⑨机制浪费占比 ⑩并发+load(达门槛才定量)。(演进项「首轮架构 finding 占比」「逐 head 文件类型」需新埋点,**不进本 mock**。)

**§4.2 四视图**(mockup.html,Annie 认可形状):A 每单时间线 / B 趋势&改进单前后对比 / C 并发×load / D 瓶颈排行。**Lead steer:View A(逐单)不进 dashboard(Annie 红线:不放 1000+ 逐单),dashboard = B/C/D + P50/P90;逐单明细归三合一报告那份。**

→ **mock 只表达长相**;每图字段来源 / 可测性由 plan.md 逐项列,交 Codex design review 把关可建性(重点:§4.1 表 + FLY-1327 五源已覆盖这些字段)。**token 无现成真值 → 报告里 token 数字显式标 MOCK**(结构真、数字示意)。

## 4. 方案取向

- **A(采纳)**:两个独立单文件 HTML mock,放 `prototype/`,视觉沿用管理台 cool-slate 浅色 + dataviz 规范,图表纯 HTML/CSS/内联 SVG(CSP 自含,不引第三方库)。数据全 mock 且**显著标注**「原型/示意数据」。
  - `cycle-time-dashboard.html` — 完整管理台外壳 + 新页签选中态(让 Annie 看到它嵌进去的样子)。
  - `daily-report.html` — 三合一报告独立页。
  - `index.html` + `serve.mjs` — 本地一键看两个 mock。
- **B(否决)**:高保真 pixel-perfect —— 违反 mockup-first(方向未定前不细化)。
- **C(否决)**:只交静态图片 —— HTML 可交互(切页签/hover)更利于 Annie 判断方向,且直接是 Tadashi 的建造参照。

## 5. 开放问题(mockup-first:先 mock,Annie 见样子后再定)

- Q1 Cycle-Time 是**新顶层 nav 项**还是挂在某页下的子 tab?→ 默认新 nav 项(📈 周期时间)。
- Q2 三合一报告 ② digest 与 ③ 每单花销**合并一张表**还是分两段?→ 默认合并(更「一眼看全」)。
- Q3 变更标注线的数据(哪天上线了哪个优化)从哪来?→ mock 里写死示意;真实可来自 issue ship 时间或人工标注,plan 里记为开放。
- 这些都**不拦 mock**:先按默认出样子,Annie co-eval 时一起定。

## 6. 下一步

→ research.md(数据源 / 视觉系统 / 现有报告结构的审计结论)→ plan.md(两个 mock 的分区规格 + 字段来源表 + 交 Tadashi 的建造说明)→ Codex design review(把关可建性)→ 建 mock → 交 Lead 投 Annie co-eval。
