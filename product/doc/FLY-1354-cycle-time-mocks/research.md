# FLY-1354 Cycle-Time Dashboard + 三合一每日报告 — 调研

Issue: FLY-1354 (https://linear.app/geoforge3d/issue/FLY-1354/designerhl-cycle-time-dashboard-三合一每日报告-mock-长相喂-fly-1343-prd-交)
日期: 2026-07-17
基于: exploration.md

> 本调研全部结论来自 repo 内真实代码/文档审计。目的:mock 的每个数字/图表都能追到一个真实数据源,让 Tadashi 建造时不用猜。**本 issue 不建库不采集**,只确认「按 FLY-1343 建库后这些长相填得出数」。
>
> **R2 修订(2026-07-17)**:FLY-1343 的 **prd.md(§4.1 `cycle_time_snapshot` 表 + 度量最小集)** 与 **mockup.html(8 张真实 issue 的 A/B/C/D 四视图)** 已在 `flywheel-FLY-1343` 分支存在(非未写)。数据模型以 §4.1 为权威;dashboard mock 复用 mockup.html 的真实数据 + 9 色分类配色;**Dashboard = B/C/D + P50/P90(View A 逐单不进 dashboard,Annie 红线)**。见下 §1.5。

---

## 1. 面 1(Cycle-Time Dashboard)的数据来源

### 1.1 阶段归段算法 = FLY-1327 已真机验证(scripts/cycle-time/,PR #630)

`scripts/cycle-time/lib/` 已实现「每单 → 各阶段耗时」的归段器(纯函数 + 合成 fixture 单测)。段标签与切点(research.md@FLY-1327 §4):

| Dashboard 阶段(本 mock 用) | FLY-1327 段标签 | 切点来源(已验证可得) |
|---|---|---|
| 工作 | 工作中 | design/implement session active 且 stage∈工作段(brainstorm/research/plan/implement/test) |
| CI | CI 等待 | `gh run` createdAt→updatedAt |
| 审查 | review 运行 | `codex_review_job` created→terminal updated_at(design+code) |
| QA | 独立 QA 运行 | `auto_qa_record` + qa session started/terminal |
| 返工 | 返工循环 | `codex_review_job` CHANGES_REQUESTED + `qa_result` FAIL + `three_stage_fix_round` |
| gate 等批 | gate 等人 | CommDB `question`→`response`(brainstorm / approve_to_ship 人工 gate) |
| 空转 | 空转 gap | handoff 间隙 + park 等 wake(`checkpoint_park_*` / `runner_phase_wakes`)+ 等 dispatch |
| (事故) | 基建事故 | 同项目 60s 窗 ≥3 session 非正常 terminal 且指纹一致的聚类 |

`classifyVerdict`(metrics.mjs)已把段分成 `necessary_process`(审查)/ `mechanism_waste`(空转)/ `execution_waste`(返工)三类 —— **mock 的 waste 占比 KPI 直接复用这个分类**。

### 1.2 周期时间 P50/P90 与两端

- T0 = Linear issue `createdAt`;T_end = `completedAt`(FLY-1327 §1.6 已验证,Annie 口径,与「Backlog→Done ~9h」吻合)。
- P50/P90 = 对某天窗口内完成的单的周期时间取分位。**样本量**:2026-07-16 起单项目已有 60+ session;每日完成单数是个位到十位级 → 趋势按**天**聚合(单日 P90 可能样本少,mock 里标注「样本 < N 时置灰/合并窗口」的诚实边界,沿用 FLY-1327 §1.8「样本不足以定量」的纪律)。

### 1.3 「是不是省了时间」= 变更标注线

FLY-1327 已产出七项瓶颈 + 四个改进单(FLY-1338 CI 砍半 / 1339 handoff 自动接力 / 1340 review 前移 / 事务化续跑)。Dashboard 的核心增量 = 在趋势图上**标注这些改进的上线日**(竖线),让断点可见。

- 标注数据源(plan 里记为开放):改进单的 ship 时间(Linear completedAt)或人工标注表。mock 里写死示意(如「7/12 CI 砍半上线」),真实机制留 FLY-1343/建造侧定。

### 1.4 load / 并发叠加(可选增强)

FLY-1327 §1.7/1.8:`~/Library/Logs/system-health/` 有 60s 粒度 load,session 区间可重建并发曲线。**mock 可选**放一条 load/并发底纹或副图,回答「段变长是机制问题还是机器饱和」。诚实边界:并发-段时长定量需 ≥60 覆盖分钟 + ≥2 issue/档,单日样本不够 → 只作描述性(mockup.html View C 定版:「样本累积中·暂不定量」占位)。

### 1.5 FLY-1343 mockup.html 的真实数据 + 配色(一致性基准,直接复用)

**9 色分类图例**(label 段 → 颜色,与 §4.1 的 6 大分类映射):

| 图例(mockup) | 颜色 | §4.1 分类桶 |
|---|---|---|
| 工作(设计/实现) | `#7CA982` | value_work |
| CI 等待 | `#8FB8DE` | mechanism_waste(必要但可优化)|
| 审查(Codex) | `#6B8FC7` | necessary_process |
| QA 运行 | `#5FB3A9` | necessary_process |
| 空转/排队等待 | `#E0A458` | mechanism_waste |
| 基建事故 | `#C1666B` | mechanism_waste |
| 返工循环 | `#D16666` | execution_waste |
| 等人(闸门) | `#A98FC7` | human_wait |
| 不可测 | `#C9C9C9` | unknown |

**8 张真实 issue**(as-of 2026-07-17,FLY-1327 采集):已完成 FLY-1252(57h52)/1272(45h03)/1307(32h26)/1309(9h06);在跑 FLY-1314(23h25)/1319(16h20)/1333(9h52)/1334(9h51)。

**View D 真实瓶颈排行**(最近 8 单总墙钟):空转/排队等待 **125h46·62%** / QA 41h51·21% / 工作 25h44·13% / 审查 3h26·2% / 返工 2h49·1% / CI 2h40·1% / 等人 1h39·1%。→ dashboard mock 直接复用这些真实值。

**Apple 浅色**(mockup):`--bg:#f5f5f7 --card:#fff --ink:#1d1d1f --dim:#86868b --line:#d2d2d7`,accent `#6B8FC7`。**折进管理台时**:外壳用 FLY-1038 console 的 cool-slate + 左侧 nav(§3),视图内的**分类段配色沿用上表 9 色**(数据语义色,跨两处一致)。

**互动评审模式**(mockup 已实现,本 mock 逐字复用):每 section `.cbox`(建/不建/待定 单选 + textarea,localStorage 自动保存)+ 底部 sticky「复制全部反馈」按钮 + 签名。**`<script nonce="__CSP_NONCE__">` + addEventListener,零 inline handler**(FLY-930 nonce 契约)。

---

## 2. 面 2(三合一每日报告)的三个维度数据来源

### 2.1 ① 整体 token — `flywheel-token-usage`(FLY-614,packages/token-usage/)

`aggregator.ts` 已按天聚合五个维度(注释 §70-76):

- `total` — 全 fleet 当天(含 sandbox/other,保证总额对账)
- `project` — 每项目(runner + main)
- `lead` — 每 lead(归属其项目 1:1)
- **`issue` — 每 issue(所有 issue,render 时套 completion),带 project** ← **③ 每单 token 的现成数据源**
- `model` — 每模型

每桶含 `input/output/cacheRead/cacheWrite/totalTokens/freshTokens` + **cost(USD,`pricing.ts` per-model 定价)**。→ ① 段可展示:当天总 token、按项目条、按模型条,带估算成本。

### 2.2 ② 做了哪些事 — `session_completed` 事件(FLY-727,teamlead.db)

FLY-727 已设计好 digest 聚合(`deriveDigestOutcome` / ship-state):

- 数据 = `session_events` 表 `event_type='session_completed'`,payload 富含 `decision.route`(auto_approve/needs_review/blocked/no_code/pr_handoff)、**`summary`(runner 一句话)**、`evidence`(commit/files/lines)、`sessionRole`、`landingStatus.status/prNumber`。
- ship-state 分档:`🚀 live`(flywheel mergeCommitSha ancestor-of deployed-sha 真判定)/ `❔ live_unverified`(mtime 代理)/ `⏳ merged 待部署`/ `📝 进行中`/ footer `no_code/blocked`。
- **⚠️ dark 现状**:代码建好但 launchd plist 从没装、没人见过样子 → 本 mock **从零画干净的**,不逆向。
- 去重:同 issue 当天取最后一次 `sessionRole=main`,qa 排除。

### 2.3 ③ 每单(ECU)时间 + token — join

每个完成单一行,三处 join(on issue identifier):

| 列 | 来源 |
|---|---|
| identifier + 标题 + route + PR + summary | ②(session_completed / sessions) |
| token + 成本 | ①(token-usage `issue` 桶) |
| cycle-time(墙钟)+ 阶段 mini-bar | 面 1 归段器(FLY-1327,per-issue segments) |

→ 三合一 = 头部 headline(总 token/总单数/总墙钟) + **完成清单(②+③ 合并一张表)** + Token 全景(①)。三维度齐全不重复。

---

## 3. 视觉系统 = 复用现有管理台(FLY-1038 原型)

`product/doc/FLY-1038-unified-management-dashboard/prototype/dashboard.html`:

- **主题**:cool-slate 浅色(刻意单主题 ops-console),核心 CSS 变量:
  - `--bg:#eef0f4` `--paper:#fff` `--nav:#f7f8fb` `--ink:#191b22` `--dim:#656a75` `--line:#e4e6ec`
  - 品牌焦点色 = indigo-violet **`--blue:#5646d6`**(◆ flywheel),所有「我在哪」提示都用它;`--blue-soft:#ecebfb`
  - 语义色:`--green:#1f9d47` `--amber:#e8850c` `--red:#d1382b` `--purple:#7b40d6` `--teal:#0b95ab`
  - 字体 `-apple-system/SF Pro`;mono `SF Mono`;卡片 `border-radius:14px` + 轻阴影
- **结构**:左 158px 侧栏 nav(`.nv`,选中态 `.nv.sel` = blue-soft 底 + 左 3px blue 边)+ 右 main。顶部 macOS 窗控条(`.barw`)+ `◆ Flywheel 管理台` + `原型` pill。
- **Cycle-Time 折进方式**:侧栏新增一项 `📈 周期时间`,右侧新 `.page`,复用 `.frame`/`.dtabs`/卡片/pill 组件。

> ⚠️ FLY-1038 硬约束(Annie 2026-07-13):**生产实现前端直读干净后端 SSOT 自动反映真实状态,无 LM 在回路手工汇总**。mock 数据是一次性脚手架仅表达长相 —— 本 mock 同样**显著标注「原型/示意数据」**,交付说明里写明真实来源(本 §1/§2 表)。

## 4. 图表实现约束(dataviz + CSP)

- 纯 **HTML/CSS + 内联 SVG** 画图,**不引第三方图表库**(CSP 自含,与 FLY-1038/FLY-1327 报告一致 —— 后者时间轴就是纯 HTML/CSS 横向 stacked bar)。
- 遵循 `dataviz` skill + `html-report-style`(Apple 浅色)。趋势线/堆叠面积/sparkline/KPI tile 全手写 SVG/CSS。
- 单文件自含(内联 CSS/JS),≤512 KiB(publish-report 预算,若走该通道)。

## 5. 对 plan 的输入

- 两个单文件 HTML mock + index + serve.mjs,放 `prototype/`。
- plan.md 逐图列「字段 → §1/§2 来源 + 可测性」表,交 Codex design review 确认可建性(重点:FLY-1343 §4.1 未写,验证我推断的字段都能从已验证数据源落库)。
- 数据全 mock 且标注;变更标注线的真实数据机制记为开放。
