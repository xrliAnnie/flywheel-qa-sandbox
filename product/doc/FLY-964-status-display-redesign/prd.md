# FLY-964 三段式(Design→Implement→QA)状态显示重设计 — 产品需求 PRD

Issue: FLY-964 (https://linear.app/geoforge3d/issue/FLY-964/三段式designimplementqa状态显示重设计-让-annie-一眼看懂现在在哪一步pm-共创)
日期: 2026-07-07
基于: mockup.html(v5,共创定稿)、progress.md;上游 FLY-560 / FLY-793·887 / FLY-907 / FLY-962
状态: draft(验收 = Annie + HL,无 QA)

---

## 0. 一句话

让 Annie 扫一眼 Discord 就知道**每个 issue 现在在哪一步、卡没卡、有没有在返工** —— 粗信号放标题(侧边栏可扫),细信号放置顶(每段一行),两者同源永不打架;并把「显示要**准 + 可信**」立为头号硬指标(不准的状态 = 她懒得看)。

设计已跟 Annie 逐块共创定稿(v5)。本 PRD 收口:锁定设计 + 提出 build 拆分(**只提议,不建 issue**),交 Tadashi 落地。

**v5 定稿 mockup(高保真真实 Discord 深色 = 还原 Annie 实际 Discord)**:
https://fw-reports-a53de2.vercel.app/r/fdeec5dde207639ab1a2fbca7d9fe896/

---

## 1. 背景与问题

三段式 pipeline = 一个 Linear issue、一条分支 B 上 3 个 phase-session 依次交接 **Design → Implement → QA**(FLY-793/887)。状态显示(FLY-560)把 stage 映射成 emoji+词 徽章、前缀到 `[FLY-XX]` thread 标题。

**Annie 的痛(2026-07-07)**:状态显示乱、看不出现在在哪一步。两处最困扰:① thread 标题;② 置顶消息。三条根因:
1. 标题把 12 个 stage 聚类成 9 个(避 Discord 改名限流 2/10min),多 stage 共享一词 → 歧义。
2. 标题与置顶各说各的、拼不出一个清楚的「你在这里」。
3. 整体没收敛成「一眼看懂 + 准 + 可信」。

**方向**:粗放标题(受改名限流)、细放置顶(不受限流),两者由**同一份真实状态**派生所以 cohere;并把「准」当头号硬指标(接 FLY-942 通知准确性同根)。

---

## 2. 设计锁定(v5) — 显示形态

### 2.1 标题 = 方案 A(只显当前段)

- 只显当前那一段的**段徽章**:`🎨设计` / `🔨实现` / `🧪QA`,带 `[FLY-XX]` + issue 标题。
- **没有「未开始」标题态** —— 没开始就没有这条 thread。
- 只在**跨 phase** 时改名(全程 ≤2 次)→ 绕开 Discord 改名限流,标题永不卡。
- 目标:侧边栏一眼看到每个 issue 在哪一段,不用点进去。

### 2.2 置顶 = 每段一行(4 态 + exec + cmux attach)

置顶消息是机器人真会发的 **markdown 文字**(Discord 只渲染 markdown+emoji,塞不了自定义控件 —— 这是硬约束,决定了细粒度状态必须能用 markdown 表达)。形态:

```
📌 [FLY-964] 三段流水线
[设计·Fable] ✅ 已完成 · exec a1b2c3
env -u TMUX tmux attach -t '=cmux-fly-964-design'
[实现·Fable] ▶ 进行中 · exec d4e5f6
env -u TMUX tmux attach -t '=cmux-fly-964-implement'
[QA·Opus] ◻ 未开始（计划 Opus）
```

- 每段一行:`[段·模型] <状态图标> · exec <id>`,下面一条它对应的 **cmux session attach 引用**。
- **有 session 的段**(exec 存在)才带 attach 行;`◻ 未开始` 段没有 attach。
- **砍掉了** v2 曾有的「球在谁 / 下一步」两行(Annie:越复杂越显得不对;越简越不容易错)。

### 2.3 状态词表 = 锁定 4 态

| 图标 | 词 | 含义 |
|------|------|------|
| ◻ | 未开始 | 还没轮到这段 |
| ▶ | 进行中 | 正在做(**正在返工的那段也算进行中**) |
| ✅ | 已完成 | 这段过了 |
| 🔁 | 等待中 | 做完过一轮、因为在返工在等下一轮 |

**返工模型(核心)**:QA 验过一轮没过 → 打回实现返工。此时 **实现段 = ▶ 进行中**(返工不另设图标),**QA 段 = 🔁 等待中**(它验过一轮、在等实现改完再验),标题回到 `🔨实现`。
「怎么知道是返工不是首次实现」→ 看 QA 段:首次实现时 QA 是 `◻ 未开始`,返工时 QA 是 `🔁 等待中`。

> 注:4 态里**没有「受阻 🔴」phase 图标**。终态失败(terminated/取消)不显受阻,而是归档清桩(见 §4 edge case ①)。

### 2.4 侧边栏 = 每 thread 当前段徽章

Discord 左侧每条 thread 前带当前段徽章(`🎨设计`/`🔨实现`/`🧪QA`)→ 扫一眼侧边栏就知道每个 issue 在哪段。

**返工不进侧边栏(Annie 定)**:返工时标题按方案 A 显当前段 `🔨实现`,和「首次实现」同徽章;**不给返工加侧边栏标记**。返工的可见性放在置顶(QA 段 🔁 等待中),侧边栏保持只显当前段、干净。

### 2.5 真 markdown + 真实 Discord 深色

- 置顶用真 Discord markdown 渲染(粗体 / inline code / emoji),不是网页控件。
- mockup 按 Annie 实际 Discord 的**深色主题**还原(消息区 #313338 / 侧栏 #2b2d31 / 白·浅灰字 / 蓝 accent #5865f2 / 圆头像 / 彩色用户名 / 时间戳灰 / 📌 pin)。深色是 mockup **内容**(还原她的 Discord),不是「报告别 dark」那条规则。

### 2.6 模式范围:本次锁三段式;两段式 = 方向说明、不进本次 build

- **本次 964 锁定 = 三段式显示**(设计 / 实现 / QA,3 行;§2.1–2.5 全部针对三段式)。
- **两段式**(`[设计+实现]` 合并 / `[QA]` 单独)**仅作 mockup / 方向说明保留,不纳入 964 本次实现验收**;待 **FLY-830** 定义两段式 pipeline 结构后再实现。合并段标题显哪个徽章等细节一并 deferred,本次不纠结。
- (与 §5(a)、§6.3 一致 —— 两段式统一划在本次 build scope 外,不在显示层 build checklist 里。)

---

## 3. CMux 导航

- **跳转机制 = cmux 内置 ⌘P(零开发)**:在 cmux 里按 ⌘P 搜索/切换到任意 session。这是产品决策,无需开发,一句 doc 说明即可。
- **置顶保留每段 cmux attach 引用**:每段那条 `env -u TMUX tmux attach -t '=cmux-…'` 是**该段 session 的引用**(让 Annie 知道每段是哪个 cmux session、可复制 attach),与 ⌘P 快速跳转**并存不冲突**。

---

## 4. 正确性 — 头号硬指标(Annie 的第一验收标准)

> Annie:现在置顶经常不对;状态显示骗你一次你就再也懒得看。

### 4.1 硬指标

**显示永远反映真实 + 自愈**:任何一次显示写失败都被 sweep 补回,**绝不永久停在错误状态**。这是本 issue 高于一切的验收线。

### 4.2 现状好消息(FLY-907 已修一半根)

FLY-907 已根治「只在 `stage_changed` 时刷新 → 卡住」:三个显示面(标题 / 置顶 / 状态行)现在由**同一个状态机**从真实状态派生,且**每个生命周期事件(park/wake/kill/finalize/…)都触发一次「从真实状态重算」的刷新**,写结果分 `changed/noop/deferred/failed`,只有全部 `changed/noop` 才落 reconcile 指纹 —— **`deferred/failed` 不落指纹 → 被 sweep 重试补回**。即「同源不打架 + 自愈」的地基已在。(`packages/teamlead/src/bridge/issue-display.ts` + `issue-display-refresher.ts`)

### 4.3 归档策略约束(喂 FLY-962)

- **只有 issue 真 done / shipped 才归档;活跃线程绝不归档**(重启也不碰)。
- 根因:重启 archive-cascade 曾把活跃 thread 归档 → Discord 拒绝改归档线程标题 → 今早改名失败 6060 次 → 状态卡旧。这是「显示不准」的头号来源,必须堵死。

### 4.4 根治机制 → FLY-978

「done → 清桩 + 归档、解耦重启」的根治机制在 **FLY-978**(cleanup / decouple-restart)co-create + 落地。本 PRD 只把**正确性需求**指过去,不重复定义 978 的机制。

### 4.5 Edge case / 边界(标 owner)

| # | 场景 | 处理 | Owner |
|---|------|------|-------|
| ① | phase terminated / 取消 | **归档 + 清桩,不显受阻**(不 lingering 停在错态) | 产品已定;落地 → 978/显示层 |
| ② | park-probe = unknown(探不到 park 状态) | 保守推导,不把「探不到」当「已唤醒」 | **Tadashi(机制)** |
| ③ | 显示写失败 → 重试 | sweep 补回(§4.2 指纹机制) | **Tadashi(机制)** |
| ④ | 误归档(活跃被归档) | **次要**;§4.3 约束堵住主路径后剩余边角 | Tadashi(低优先) |
| ⑤ | 逃生开关(feature flag / kill switch) | 显示层可一键回退,不硬故障 | **Tadashi(机制)** |

---

## 5. 拆 build 方案(**只提议,不 create-issue**)

> 交 HL/Annie 过目后再由 Tadashi 决定建几个 eng issue、怎么排。

### (a) 显示层 — 把 v5 设计落到 issue-display 代码
- **状态词表 4 态**:当前代码 `PhaseDisplayState = pending | active | done | blocked`;需重映射到 Annie 的 4 态 —— `pending→◻未开始 / active→▶进行中 / done→✅已完成`,**新增 `🔁等待中`**(某段做完一轮、因返工在等);`blocked` 的终态失败改走**归档清桩**(edge ①)而非显受阻。
- **置顶每段一行**:`[段·模型] <4态图标> · exec` + 有 session 段带 cmux attach 引用行;去掉「球在谁/下一步」。
- **标题方案 A**:只显当前段徽章(🎨/🔨/🧪),跨 phase 才改名。
- **侧边栏徽章**:thread 名带当前段徽章;**返工不进侧边栏**。
- **本次不含两段式渲染** —— deferred 到 FLY-830 定义 pipeline 结构后再做(见 §2.6 / §6.3),**不在本次 build checklist**。
- Owner:**Tadashi**(纯显示层,不碰 pipeline 引擎)。

### (b) CMux 导航 — 零开发
- cmux 内置 ⌘P 作跳转;置顶保留每段 cmux attach 引用。**一句 doc**,无代码。
- Owner:doc only。

### (c) 正确性 — 自愈 + 归档约束
- 复用/收紧 §4.2 sweep 自愈(edge ②③⑤ 机制)。
- 归档约束(§4.3,喂 FLY-962):只真 done/shipped 才归档、活跃线程绝不归档、重启不碰。
- 根治(done→清桩+归档、解耦重启)**指向 FLY-978**,不在本 issue 重做。
- Owner:**Tadashi**;根治机制走 **FLY-978**。

### Owner 速览
- **产品/UX(本 PRD,HL)**:显示形态锁定、4 态词表、返工模型、edge ①/④ 的产品取舍。
- **Tadashi(eng)**:(a) 显示层落地、(c) 正确性机制 edge ②③⑤、归档约束落地。
- **FLY-978**:正确性根治机制(清桩/解耦重启)。
- **FLY-830**:两段式 pipeline 结构定义(本 PRD 只锁其显示形态)。

---

## 6. Buildability 规格补充(codex R1 — 5 项)

> 照 `issue-display.ts` 状态机如实写、不靠猜;补完可 build。

### 6.1 状态行(face C)规格化

- **形态**:紧凑单行、三段一览 —— `🎨设计<态>·🔨实现<态>·🧪QA<态>`(现 `renderPhaseStatusLine`,`issue-display.ts`)。例:`🎨设计✅·🔨实现▶·🧪QA◻`。
- **4 态图标映射**(与置顶 per-phase 图标**同一套**):◻未开始 / ▶进行中 / ✅已完成 / 🔁等待中。现 `PHASE_DISPLAY_GLYPH_PARTS` 用 ◾(pending)且无 🔁 → build 需把 pending 图标 ◾→◻、并新增 🔁(见 §6.4)。
- **placement**:face C 与 v5 置顶 per-phase 明细**同源**(FLY-907 已把 face C 收进置顶 header)—— 作置顶顶部的一览摘要行(per-phase 明细行在下)。两者渲染同一份 phase-state 向量,永不打架。**不改 v5 已批的 per-phase 明细**,face C 只是它的紧凑摘要。
- **更新频率 / 失败重试**:与标题 + 置顶**完全一致** —— 都由 `issue-display-refresher` 同源刷新,每个生命周期事件触发「从真实状态重算」,写结果 `changed/noop/deferred/failed`,`deferred/failed` 不落指纹 → sweep 补回。face C 不是特例,是同一 refresher 写的三面之一。

### 6.2 964 验收边界 vs FLY-978 / FLY-962

- **964 = 显示层**。验收 = **显示永远反映真实 + 自愈(refresher + sweep 独立达标)**,**不 block 在 978/962**。
- FLY-978(清桩 / 解耦重启)、FLY-962(归档约束)= 修根,让「需要被显示的错误状态」变少;但**不是 964 验收的前置**。964 的自愈保证:即使根没修完,任何写失败也被 sweep 补回、绝不永久停错态。
- 一句话:**964 独立可验收、可 ship;978/962 是并行降噪,不是门槛。**

### 6.3 两段式显示 — 明确划出本次 scope

- 两段式(`[设计+实现]` 合并段)显示**不纳入 964 本次实现验收,待 FLY-830 定义**两段式 pipeline 结构后再定。
- 本次 build **不实现**两段式渲染,也不纠结 `[设计+实现]` 合并段标题显哪个徽章 —— 明确 scope 外。v5 mockup 的两段式卡仅为「显示形态示意」,非本次交付。

### 6.4 4 态完整转移表(照 `derivePhaseDisplayState` 状态机)

**现状态机(事实基线)** — 输入 `(status, park)` → 现输出 `PhaseDisplayState`:

| 输入 | 现输出 |
|---|---|
| 无 session | pending |
| completed / merged | done |
| failed / terminated / blocked / rejected | blocked |
| park=parked(任何 live status) | done |
| boundary(design_done / awaiting_review / approved_to_ship)+ park=unknown | done |
| boundary + park=not_parked(FLY-543 唤醒) | active |
| running / 其它有 session | active |

**目标 4 态映射 + 新增 🔁 规则**:
- `pending → ◻未开始`;`active → ▶进行中`;`done`(仅 completed/merged 终态)`→ ✅已完成`。
- **新增 `🔁等待中`**:某段处于「本轮做完 / parked」形态(经 park / boundary 判 done、**非** completed/merged 终态)**且序列中更早的段当前为 ▶进行中**(pipeline 回退返工)→ 显 `🔁等待中`(而非 ✅)。**这修的正是现状 bug**:现在 parked QA 判 done → 错显「QA 已过」,返工时状态不实。
- **终态失败**(terminated / rejected / 取消)→ **不显 🔴**,走归档清桩(edge ①,§4.5)。现 `blocked→🔴受阻` 改为归档。

**事件 →(设计, 实现, QA)+ 标题徽章**(覆盖 Lead 点名的所有组合):

| # | 场景 | 设计 | 实现 | QA | 标题 |
|---|---|:--:|:--:|:--:|---|
| 1 | 设计中 | ▶ | ◻ | ◻ | 🎨设计 |
| 2 | 实现中(首次) | ✅ | ▶ | ◻ | 🔨实现 |
| 3 | 实现完成、等 QA(handoff gap) | ✅ | ✅ | ◻ | 🔨实现 ¹ |
| 4 | QA 中(首次) | ✅ | ✅ | ▶ | 🧪QA |
| 5 | QA 打回 → 返工中 | ✅ | ▶ | 🔁 | 🔨实现 |
| 6 | 多轮返工(第 N 轮) | ✅ | ▶ | 🔁 | 🔨实现 ² |
| 7 | 返工完成、QA 重开 | ✅ | ✅ | ▶ | 🧪QA |
| 8 | 设计被打回返工 | ▶ | 🔁 | 🔁 | 🎨设计 ³ |
| 9 | 三段全绿 | ✅ | ✅ | ✅ | 🧪QA(→ completed) |
| 10 | 人工 kill / 取消中途 | — | — | — | **归档清桩,不显受阻**(edge ①) |

- 注 ¹:handoff gap 无 active 段,`deriveIssueTitleBadge` 取第一个 pending 段之前一段 = 实现 → 🔨实现;QA session 一起就 ▶ → 🧪QA。
- 注 ²:多轮返工显示形态与第 1 轮同(第几轮靠 exec / round 区分,不是新态)。
- 注 ³:设计被打回 → 设计段 active、后续已跑过的段回落 🔁。设计是否会被打回属 pipeline(FLY-793)行为,显示层如实反映即可。

### 6.5 exec / attach 行生命周期(最小规则)

- **有 live / parked cmux session 的段** → 显 `· exec <id>` + 下面一条 attach 行。
- **完成段(✅已完成)**:其 session 还在(parked keep-alive)→ 保留 exec + attach;session 已结束(finalize 后)→ 保留 `exec <id>`、**去掉 attach 行**(可标 `session 已结束`)。
- **parked session** → 保留 attach(仍可 attach)。
- **未开始段(◻)** → 无 exec、无 attach。
- **清桩后**:清桩(stub cleanup)交互属 FLY-978;**964 最小规则** = 置顶随 thread 存续到 issue 真 done / shipped → 按 §4.3 随 thread 归档;未 done 前置顶持续反映当前 sessions。

---

## 7. 非目标 / 边界

- 不改 pipeline **引擎/相位**本身(FLY-793/887 是 eng;产品线 pipeline 形态 + PM 验收 = FLY-830)。
- 不在本 issue 定义 FLY-978 的根治机制细节。
- 两段式渲染不纳入本次实现(§6.3)。
- 本 issue 只定 **状态显示 UX + 正确性产品需求 + build 拆分提议**。
- 验收 = Annie + HL(product PRD,无 QA)。
