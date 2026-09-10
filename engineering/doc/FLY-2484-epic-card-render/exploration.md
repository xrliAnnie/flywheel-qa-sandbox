# FLY-2484 进度页渲染层:Epic 卡 + 子单行 — 探索
Issue: FLY-2484 (https://linear.app/geoforge3d/issue/FLY-2484/进度页e3-渲染层epic-徽标照抄-linear-子单计数分组稳定排序依赖徽标等-fly-xxxx整块在等跨-epic)
日期: 2026-09-10
基于: 无(上游为 `product/doc/FLY-2457-founder-progress-page/prd.md` v2.1 §5–§9 / §12 与 E1 `engineering/doc/FLY-2482-scope-v2-parent-counts/{plan,implementation-evidence}.md`)

> 成色:✅ 本单亲手核过(file:line / 命令输出 / 字节实测);📖 引自上游未复核;🔶 本单裁定,可推翻;⬜ 待 Lead 裁定。

## 0. 一句话

E1 已把 `parent` 与 `root_counts` 放进文档,今天的 HTML 仍是「17 格平铺、36 张同款卡、不分 Epic」的机器页(✅ 本地重放 469,843 B);本单只改 `render-html.ts` 一层,把它重排成「Epic 卡(徽标照抄 Linear + 计数,默认收起)→ 子单行(在跑 → 未开始,徽标写『等 FLY-XXXX』)」,终态子单不列、全做完的 Epic 不出现,排序是文档的纯函数;每张子单行仍带全部出处格,但审计格瘦身,把每张子单成本从 ~10.7KB 压到 ~5KB,天花板从 45 张抬到 ~90 张未完成子单。

## 1. 现状实核

### 1.1 渲染层的结构(`packages/teamlead/src/epic-page/render-html.ts` ✅)

| 位置 | 事实 |
|---|---|
| `:13-18` | `FOUNDER_DECIDED_RULES = {scope.v2, counts.v1, ready.v1, dependents.v1}`(E1 已改) |
| `:98-117` `itemCells` | 每张 item 渲染 14 格审计(不含 `parent`);`render.test.ts:211-227` `ITEM_PATHS` 与之对拍 |
| `:119-153` `executionSummary` | 机器话:`completed/design(deadbeef) · ledger_live_count=2 · 实现/active · implement#1 · PR #12/open` |
| `:369-410` `renderItem` | 一张 item 一张 `<article class="item-card">`,h3 = `ID · 标题 · 状态名`,9 行 card-row + footer 内 `<details class="audit">` 全部格 |
| `:486-491` | roots 只渲染成一排 `root-pill`(identifier · title · state.name),**不消费 `root_counts`,不消费 `parent`** |
| `:468-532` `renderEpicPageHtml` | 顺序:header → freshness → ready → stuck → waiting_founder → dependency_review → scope → (founder / done / gaps) → 全部 item 卡按文档 `items` 原序(= Linear 遍历序)平铺 |
| `:531` | 唯一 `<script nonce="__CSP_NONCE__">`:只更新「你打开时它已 N 分钟旧」 |
| 消费者 | `bridge/epic-page-publisher.ts:39`(固定页)与 `bridge/epic-page-route.ts:272`(`format=html`)✅;Markdown 走 `render-markdown.ts`,Lead 巡检读的是 md/JSON(`hook-payload.ts:637`)✅ |

⇒ **E3 的改动面 = `render-html.ts` 一个文件 + `labels.ts` 词表 + `rules.ts` 导出一个已存在的分类逻辑;不动文档合同、不动取数、不动 Markdown。**

### 1.2 数据已经够了(E1 合同,`model.ts` ✅)

| 字段 | 位置 | 本单怎么用 |
|---|---|---|
| `items[].parent: Cell<string>` | `model.ts:162` | 子单归属:沿 parent 链走到 `header.roots.value[].identifier`(与 `computeRootCounts` 同一走法 `rules.ts:264-289`) |
| `header.root_counts[i]: Cell<RootCounts>` | `model.ts:141-152, :265` | Epic 头部计数行;`missing.reason === "unknown_state_type"` 时整格缺 |
| `header.roots.value[i].state {name,type}` | `model.ts:256-263` | **Epic 徽标 = `state.name` 原话**(§6.2 照抄);分组键 = `state.type` |
| `items[].state / blocked_by[].{identifier,in_scope,blocker_state_type}` | `model.ts:118-124, :166-168` | 子单徽标:「等 FLY-XXXX」= 存在 `blocker_state_type !== "completed"` 的 blocker |
| `items[].run[0].current_node_label / attempt[0].attempt / session.latest[0].status` | `model.ts:179-200` | F5 「在跑到哪一步」 |

分类逻辑今天**内嵌**在 `computeRootCounts`(`rules.ts:307-318`):started→live;completed→done;canceled→canceled;backlog/unstarted/triage→ 无 blocker=idle / 有未完成 blocker=waiting / 否则 free;其它→unknown。它没有被导出,渲染层若自己再写一份就是第二套真相。

### 1.3 字节构成(✅ 本地重放 E1 冻结快照 `linear-snapshot.json` 2026-09-10T06:09:09Z,`replay-linear.ts` 输出 469,843 B,与 E1 证据逐字节相同)

```
total 469843  fixed(非卡片) 83435  cards 36
backlog    n=14 card_avg=10566 audit_avg=8095 code_avg=1285 visible_avg=2471
canceled   n= 2 card_avg=10793 audit_avg=8278 code_avg=1361 visible_avg=2515
completed  n=16 card_avg=10885 audit_avg=8233 code_avg=1423 visible_avg=2652
started    n= 4 card_avg=10678 audit_avg=8036 code_avg=1437 visible_avg=2641
非终态卡 18 张 190,649 B;终态卡 18 张 195,759 B
审计格字节(全部卡合计):acceptance 31.6K · title 27.3K · url 25.8K · blocked_by 24.2K · state 23.3K · founder_named 21.5K · priority 20.9K · carriers/attempt/gates/run/land/session/blocks 各 ~12K
style 3,762 B;header + 总览卡 79,184 B;尾 489 B
```

三个结论:
1. **每张卡 76% 是审计格的样板字**(出处字符串把 issue uuid 与 URL 在 14 格里各重复 14 次,`<code>` 值本身只占 1.4KB)。
2. **终态子单占了一半字节**(18 张 / 196KB),而 PRD R3 说终态默认不列。
3. 总览区 79KB 里大头是派生格的 `from` 指针清单(`ready_items` 108 个指针、`gaps` 324 个……),随 items 线性增长(≈250 B/张)。

### 1.4 两个并行 PR 改同一个函数(✅ `git diff main...` 实核)

| PR | 分支 | 对 `render-html.ts` 的改动 | 对合同的改动 |
|---|---|---|---|
| #1147 FLY-2483(E2「现在要你看」) | `flywheel-FLY-2483` | 新增 `renderAttention(page, now)` 插在 `<main>` 最前;`scopeUnavailable`(`schema_version===2 && epic_scope.value===null`)时只出 header 与 attention,不出任何卡 | `schema_version: 1 \| 2`,`EpicPage = EpicPageV1 \| EpicPageV2`,新 `attention[] / discord / epic_scope`;⚠️ 其 `epic_scope` 缺席分支仍断言 `excluded_item_state_type: "backlog"`(写于 E1 合入前,需其自行 rebase) |
| #1148 FLY-2485(E4 Lead 判断格) | `flywheel-FLY-2485` | `renderItem` 多一个 `fadeDays` 参数,卡内插 `renderLeadNotes(item.lead_note, ...)`;roots 那一排每个 root 旁插 `renderLeadNotes(root.lead_note, ...)`;script 里多一段淡化逻辑 | `items[].lead_note?: Cell<string>[]`、`roots.value[i].lead_note?`、`lead_note_policy?`,provenance 新增 `kind: "lead_note"` |

两者都在 implement 5/5、PR 开放待评审。E3 是**整个 `renderEpicPageHtml` 函数体重写**:三方同时改一个函数,后合的一方必然手工解冲突。⇒ 本单设计为两者各留**一个固定插槽**,不复制它们的代码;实现顺序见 §3.8(已向 Lead 通报,非阻塞)。

### 1.5 会被本单改动打破的既有测试(✅ `render.test.ts`)

| 用例 | 依赖 | 处置 |
|---|---|---|
| `renders one concise card per item…`(:339) | `<article class="item-card` 数 == items 数;文案「是什么 / 为什么 / 做完你看到 / 等谁 / 谁在等我」;`EPX-1 · Task A · Todo` | 改写:卡数 = 未终态子单数;新文案 |
| `keeps item provenance and timestamps in a compact card footer`(:359) | `card-meta` footer | 改写:出处进子单行的审计 details |
| `puts ready first, then the active scope, above all item cards`(:378) | ready 在 scope 前、都在卡前 | 改写:Lead 诊断面板在 Epic 卡之后 |
| `renders all 8 root and 14 item Cell paths…`(:452) | `data-cell="/items/0/<field>"` 14 格 | 保留并加 `parent` ⇒ 15 格;fixture 子单必须非终态才会被渲染 |
| `keeps a 60-item HTML snapshot within the 512 KiB…`(:544) | 60 张 unstarted | 保留;另加更严的预算用例 |
| `shows ledger_live_count in both first-screen execution summaries`(:566) | HTML 首屏含 `ledger_live_count=2` | 改写:机器话进审计格,首屏是 F5 人话 |
| `shows concrete issue titles on both sides of each dependency`(:583) | 「谁在等我」 | 改写:子单行只写「等谁」;「谁在等我」进审计格(`blocks` 仍渲染) |
| Markdown 相关用例 | 不动 | 不动 |

`labels.test.ts` 只测 `label()` 机制;`epic-page-route.test.ts:326` 只测 content-type ✅。

## 2. 需求逐条落地(对应 issue「要做」1–6)

| # | 要求 | 数据来源 | 页面落点 |
|---|---|---|---|
| 1 / F1 | 范围 = started 且有子单的父单 | `header.roots.value`(取数层已保证 `state.type=started,parent=null,children!=null` ✅ `generate.ts:425`) | 每个 root 一张 Epic 卡 |
| 1 / F4 | 全做完的 Epic 不出现 | `root_counts[i].counts`:`live+waiting+free+idle === 0` | **不渲染**;页尾一行「另有 N 个 Epic 全做完,不列」(只给数,不给单号) |
| 2 / F3 | 徽标照抄 Linear state | `roots.value[i].state.name` 原话 | 卡头徽标;颜色只按 `state.type` 分 |
| 2 | 计数留在徽标旁 | `root_counts[i].counts` | 「N 在跑 · N 等依赖 · N 可起跑 · N 未开始 · 共 N」(零值段省略,「在跑」与「共」恒显) |
| 2 / F6 | 默认收起 | — | `<details class="epic">` 不带 `open`;⛔ 页面脚本不改 `open`(E2 的「现在要你看」不在卡里,不受影响) |
| 3 / R2 | Epic 按状态分组、组内 identifier 稳定 | `roots.value[i].state.type` | 组序 started → unstarted → backlog/triage → 其它;组内 `(team, number)` 数值序 |
| 3 / R3 | 子单 在跑 → 未开始;终态不列,折叠区一行计数 | 子单分类(§1.2)+ `root_counts` | 行序:live → waiting → free → idle,各组内 identifier 数值序;终态 = 卡尾一行「另有 N 张已完成 · M 张已取消(不列)」 |
| 4 / R4-1 | 被挡子单徽标「等 FLY-XXXX」 | `blocked_by.value` 里 `blocker_state_type !== "completed"` 的 identifier(升序,最多列 3 个,多则「等 FLY-A / FLY-B 等 N 张」) | 子单行徽标 |
| 4 / R4-2 | 全被挡 ⇒ Epic 头「整块在等 XXX」 | `counts.live === 0 && free === 0 && idle === 0 && waiting > 0`;XXX = 该 Epic 所有 waiting 子单的未完成 blocker 并集(去重升序) | 卡头(summary 内,收起也可见) |
| 4 / R4-3 | 跨 Epic 依赖标出 | blocker `in_scope=false` ⇒「(范围外)」;`in_scope=true` 且 blocker 归属的 root ≠ 本子单的 root ⇒「(在 FLY-ROOT)」 | 徽标后缀 |
| 4 | ⛔ 不画依赖图 | — | 只有徽标文字 |
| 5 / F5 | 在跑到哪一步 | `run[0].current_node_label` + `attempt[0].attempt` + `session.latest[0].status` | 「到「实现」· 第 1 次 · 会话 running」;缺哪段写哪段缺 |
| 6 / §12 | 每格保留出处 / observed_at | 15 格 item Cell + roots + root_counts[i] | 每张子单行一个 `<details class="audit">`(15 格,瘦身格式);每张 Epic 卡一个(`/header/roots` + `/header/root_counts/i`) |
| 6 / F13 | 零人名 | — | 页面自身文案全部经 `labels.ts`;Linear 标题是数据不改 |

## 3. 候选与裁定

### 3.1 R2 分组键:Linear `state.type`,不用 counts

| 候选 | 说明 | 取舍 |
|---|---|---|
| A · 按 `roots.value[i].state.type` 分组 | 唯一真相;今天所有 root 都是 started ⇒ 只有一组,组内 identifier 序 | ✅ **选**(✅ Lead 2026-09-10 裁定同意,见 §5) |
| B · 按 `counts.live > 0` 分「在做 / 还没开始」 | 更像 mock(`build-progress-page.py:89` 用 state,但 mock2 的 `e-live/e-idle` 类是按 live 数) | ✗ 这就是 §6.2 否掉的「第二个状态」:「还没开始」是一句状态话,却由 counts 算出 |
| C · 按 Linear state **name** 分组 | — | ✗ name 是自由文本,跨项目不稳定;type 是 Linear 固定枚举 |

选 A 的代价:今天页面看不出「哪些 Epic 没人在动」的排序差异 —— 但计数行「0 在跑」就在同一行,信息没丢。F8「在做的在上」在范围只含 started 时恒成立。

### 3.2 子单徽标词汇的真相来源:复用 counts.v1 的分类

| 候选 | 取舍 |
|---|---|
| A · 从 `computeRootCounts` 抽出 `classifyItem(item): "live"\|"waiting"\|"free"\|"idle"\|"done"\|"canceled"\|null`,`computeRootCounts` 与渲染层都调它 | ✅ **选**:徽标与计数**按构造一致**,测试断言「每个 Epic 的行数按徽标数出来 == `root_counts[i].counts` 六个数」 |
| B · 渲染层自己按 state/blocked_by 判 | ✗ 两套分类;E1 exploration §2.3 已为 `free` 的判据(只认 completed)打过一次架,不能再来一次 |

徽标词表(🔶,走 `labels.ts`):live「在跑」· waiting「等 FLY-XXXX」· free「可起跑」· idle「未开始」· null(未知 type)「<state.name>(未知类型)」。issue 只点名了「等 / 未开始 / 在跑」,「可起跑」沿用 mock 与 counts 词汇(E1 Lead 已同意的 counts 词汇),不是新状态。

### 3.3 跨 Epic 的判法:两种,都标

issue 把跨 Epic 写成 `in_scope=false`;但 E1 之后 `in_scope` 的含义是「blocker 在**整份文档**的 item 集合里」,同范围内**另一个 Epic** 的子单也是 `in_scope=true`。只按 `in_scope=false` 标会漏掉「FLY-2441 的子单在等 FLY-1143 的子单」这种最常见的跨 Epic。⇒ 🔶 两种都标,措辞区分:`in_scope=false` →「(范围外)」;in_scope 但归属 root 不同 →「(在 FLY-1143)」。归属 root 用与 §3.2 同一条 parent 链函数。

### 3.4 终态子单:不出行,不出格,只出数

| 候选 | 取舍 |
|---|---|
| A · 不渲染终态子单任何 DOM,卡尾一行「另有 N 张已完成 · M 张已取消(不列)」,数来自 `root_counts[i]`(带出处的派生格) | ✅ **选**:PRD R3 / Q2 工程默认;省一半字节;出处仍在(那一行挂在 Epic 卡的审计 details 上) |
| B · 渲染成折叠的 `<details>` | ✗ 字节不省,F4/F6「清爽」目的落空 |
| C · 完全不提 | ✗ 她抽查「全做完的不在页面上」时看不出是没做完还是没取到 |

代价:终态子单的 15 格出处只在 JSON / Markdown 里;HTML 不再是「文档每一格都可见」。§12 的原则是「不许有只存在于页面里的事实」,方向是页面 ⊆ 文档,不是文档 ⊆ 页面 ⇒ 不违反。

### 3.5 Lead 诊断区(ready / stuck / waiting_founder / dependency_review / scope / founder / done / gaps)

| 候选 | 取舍 |
|---|---|
| A · 整体移到 Epic 卡之后,包进一个收起的 `<details class="lead-panel">`「给 Lead 看的诊断」,内容与 data-cell 标记原样不动 | ✅ **选**:founder 首屏只剩 Epic 卡;8 个根格出处不丢(`ROOT_PATHS` 测试仍过);字节不变 |
| B · 从 HTML 删除,只留 Markdown | ✗ 固定页是唯一 hosted 形态,Lead 也会点开看;删了就是页面 ⊂ 文档得太多 |
| C · 留在顶部 | ✗ 违背 F6 首屏意义 |

freshness 卡同样折进去;「你打开时它已 N 分钟旧」提到页头常显(G3)。

### 3.6 审计格瘦身(§12 与 512KB 同时满足)

今天每格 ≈580 B,其中 Linear 出处把 `issue:<uuid> · <field> · <url> · <a href=url>url</a>` 重复 14 次。🔶 瘦身格式:
- 子单审计 details 顶部一行**共享出处**:「Linear issue `<uuid>` · `<url>`(链接)」;每格只写 `field`、值、观测时间、来源更新时间;statestore/commdb 格写表名与 key(与今天同);derived 格写规则号 + `from` 指针(与今天同,子单级的 `blocks` 指针很短)。
- 值:`acceptance` 只出 ≤240 字预览(与今天首屏 `acceptanceSummary` 同界);其余格值全量(都是小 JSON)。
- 保留 `data-cell="/items/N/<field>"` 属性与 `observed_at` 原文 ⇒ 既有「值 / 出处 / 时间」对拍测试逐格仍过。

估算:15 格 × ~230 B ≈ 3.5KB + 可见行 ~1.2KB ≈ **5KB / 未完成子单**;Epic 卡壳 ~0.8KB;总览诊断区 ~45KB + 250 B × 全部 items。⇒ 天花板 ≈ (524,288 − 45K − 250×N_all) / 5K ≈ **90 张未完成子单**(N_all=60 时)。今天 18 张未完成 ⇒ 估 ~160KB。实现单以 fixture 复测,把实数写进 plan §7。

### 3.7 未知状态类型 / 没挂 Epic 的子单:显示,不隐藏

- `root_counts[i]` 缺(`unknown_state_type`):Epic 卡照出,计数行写「计数缺失:不认识状态类型 <type>」,子单行照列,未知 type 的那张徽标写 state.name 原话 +「(未知类型)」;⛔ 不因为算不出计数就把 Epic 藏起来(藏 = 静默丢)。「整块在等」判断在计数缺时不做(写「不判」)。
- `parent` 缺(`no_parent`,取数中途被挪走):这些 item 归不到任何 root,单独一张「没挂 Epic(取数时它的父单为空)」卡放在最后,同样的子单行格式,只在非空时出现。E1 已在 gaps 里记 `parent/no_parent`。

### 3.8 与 #1147 / #1148 的关系:插槽,不复制(✅ Lead 2026-09-10 裁定同意,见 §5)

- **attention 插槽**:`<main>` 最前,`renderAttention(page, now)` 若存在则调用;E3 自身不定义 attention。`scopeUnavailable` 时 E3 的 Epic 区渲染「Epic 范围不可用」一句,不出卡(沿用 #1147 的判据)。
- **lead_note 插槽**:Epic 卡 body 顶部一个 `renderLeadNotes(root.lead_note, …)` 调用点;子单行展开区一个 `renderLeadNotes(item.lead_note, …)` 调用点;E3 自身把它们定义为「若合同里有该字段则渲染,否则空串」。
- 推荐实现顺序:E3 implement 在 #1147、#1148 合入后 rebase 开工;若 Lead 决定 E3 先合,则 E2/E4 的 render 部分需在本设计的骨架上重挂(它们的 render 改动各 ~40 行,数据层不受影响)。

### 3.9 Markdown 不动

`render-markdown.ts` 是 Lead / 巡检 / `show --format md` 的形态,不是 founder 页;E1 也只改了它的规则号。本单不动它,parity 测试里凡「两种输出都含 X」的断言,HTML 侧通过诊断面板保留 X 即可。要把 md 也排成 Epic 树是另一张单。

### 3.10 留言层不在本单

PRD G4 / T4(每个 Epic 一个留言框 + 一键复制)不在 F1/F3/F4/F6/F8/F9/F10 里,FLY-2481 名下也没有这张单(✅ 快照:2481 只有 2482/2483/2484/2485 四张子单)。本单页面脚本只保留「多旧」计时;留言层列为**候选后续**,页面结构给它留位(每张 Epic 卡 body 末尾),不实现。

## 4. 不做(边界)

- 不改文档合同(`schema_version`、任何 Cell、`assertEpicPage`)、不改取数、不改 StateStore、不改 CLI。
- 不改 `render-markdown.ts`。
- 不做留言层、不做 Discord 跳转(E2)、不做 Lead 判断格(E4)、不画依赖图。
- 不改 `EPIC_PAGE_MAX_HTML_BYTES`;超限仍 `structural: epic_html_too_large` 停上一版。
- 不用 counts 参与排序;不给 Epic 算任何第二状态。

## 5. Lead 裁定(question b9194189-12bb-4665-8ed4-777c3ffa908c,2026-09-10 已答复,两条均按推荐)

1. **合入顺序**:E3 implement 在 #1147 与 #1148 合入后再以 main 为基线动手;设计里为 attention 区与 lead_note 各留一个固定插槽,**接口写清输入字段 / 渲染位置 / 空值行为**,不复制它们的代码;设计阶段可以先做,交接进 implement 时若两张还没合入,实现体先等再动。
2. **分组键** = Linear `state.type`(started → unstarted → backlog/triage → 其余),组内 identifier 数值序稳定排;counts 只显示,不参与排序,不造第二个状态(§6.2)。
