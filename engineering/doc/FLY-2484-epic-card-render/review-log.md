# FLY-2484 进度页渲染层:Epic 卡 + 子单行 — Codex 设计评审记录
Issue: FLY-2484 (https://linear.app/geoforge3d/issue/FLY-2484/进度页e3-渲染层epic-徽标照抄-linear-子单计数分组稳定排序依赖徽标等-fly-xxxx整块在等跨-epic)
日期: 2026-09-10
基于: plan.md

Codex 线程 01a08a6b-a360-7243-8b96-1d400af816c8,effort xhigh,四轮;条数 6 → 4 → 3 → 0,终判 **APPROVED**(v4,提交 fb24ade69)。每轮反馈原文附后;处置全部「采纳」,其中 R1-5 采纳精神(用页面展示规则号 + 输入格路径给页面级结论出处,不改文档合同)。

| 轮 | 条 | 处置摘要 |
|---|---|---|
| R1 | 6 | ① `/header/roots` 全格只在 Lead 面板出一次,Epic 卡改本 root 投影;② 插槽 A 无条件委托 `renderAttention`,B2 紧跟机器行;③ 排序键改全序元组,稳定性测试改按 UUID 同步重排两份 raw snapshot;④ `computeRootCounts` 钉调用顺序 + 错误文案断言 + 逐根 golden;⑤ 页面级结论带 `view.*.v1` 展示规则出处;⑥ 88 张预算撤回,改实测容量 |
| R2 | 4 | ① 隐藏 Epic 改结构断言;② 统一 `ViewProvenance`,`from` 展开具体路径,导出 `resolvePointer`,时间按 `Date.parse`;③ 容量改最终模型离散搜索 + notes-per-issue 边界 + 多 role fail-closed;④ `rootOf` 合同改「链最终到 null」 |
| R3 | 3 | ① `FounderView` 改 union,`hiddenDoneEpics.count`,unattached 三张;② `view.progress.v1` 固定五格;③ 容量搜索页改为最小截断警告页,触顶例外 |
| R4 | 0 | APPROVED,无阻塞项;实施期按 C5 记实数、保留 sibling 回归门禁 |


---

## 附:Round 1 原文

### Design Review — plan.md (Round 1)

Date: 2026-09-10
Author: Codex
Status: CHANGES REQUESTED

#### Summary

总体方向可实施：以 E1 文档为唯一输入、抽纯视图模型、只改 HTML，并等 #1147 / #1148 合入后再接线，边界清楚。但当前计划仍有六处会使既定验收失败或无法证明，其中包括隐藏 Epic 从审计格泄漏、两个 sibling slot 与已写测试不兼容、排序非全序、E1 错误合同未被精确锁定、页面派生事实缺出处，以及 88 张预算按计划自己的估算已超线；因此尚不能进入实现。

#### What's Good (Keep)

- 保留 E1 的 `items[].parent`、`header.root_counts` 和 `counts.v1`，并让子单徽标与计数共用同一分类函数，能避免渲染层与数据层分类漂移（`packages/teamlead/src/epic-page/rules.ts:260-333`）。
- `buildFounderView` 不读时钟，固定分组后再排 identifier；同文档、同 `now` 的 HTML 逐字节测试，以及 hostile text / URL、未知状态、断链、范围外 blocker、运行事实缺失等守卫，覆盖面合理。
- 15 个 item Cell（补上 `parent`）继续逐格携带 value / provenance / `observed_at`，且 acceptance 只压缩显示值、不删 `data-cell`。只要每格完整内容仍位于下一个 `data-cell=` 之前，现有 `htmlBlock` 切片方式可继续工作（`packages/teamlead/src/epic-page/__tests__/render.test.ts:169-175,448-475`）。
- 明确先等 #1147、#1148 合入 main，再以合入后的实现和测试为基线， sequencing 正确；Epic 徽标只照抄 Linear `state.name`、counts 只并列显示，也没有发明第二个 Epic status，符合 PRD §6.2。

#### Issues & Recommendations

1. **隐藏 Epic 与 `/header/roots` 审计设计互相矛盾。** 计划要求每张可见 Epic 都用现有 `renderAuditCell` 渲染完整 `/header/roots` Cell（`engineering/doc/FLY-2484-epic-card-render/plan.md:68-69`）；该 Cell 的 value 是所有 roots 的数组（`packages/teamlead/src/epic-page/generate.ts:415-428`），而 `renderAuditCell` 会把整个 value 写入 HTML（`packages/teamlead/src/epic-page/render-html.ts:83-95`）。因此 fixture 中被隐藏的 `EPX-300` 会出现在每张可见 Epic 的折叠审计里，C4 的“HTML 不含 EPX-300”（plan:113）、G1 的“识别符不出现在页面”（plan:145）都会失败，而且重复的 `data-cell="/header/roots"` 只会被 `htmlBlock` 校验到第一处。建议只在 `lead-panel` 中保留一次完整 `/header/roots` Cell；每张 Epic 改为只显示对应 root 的投影，并用不冒充 Cell 路径的唯一标记（例如 `data-source-cell="/header/roots"` + `data-source-value="/header/roots/value/N"`）携带原 Cell 的 provenance/time。若选择允许审计区出现隐藏 identifier，则必须同步收窄 C4/G1/QA 的断言为“不出现 Epic 卡或 `data-root`”，不能继续声称全文不出现。

2. **三个 slot 目前不能保持两个 sibling PR 的既有合同。** #1147 的实际 `renderAttention` 对 schema v1 会渲染“旧版尚未采集”，不是空串（`flywheel-FLY-2483:packages/teamlead/src/epic-page/render-html.ts:476-480`），其测试还要求 `epic_scope=null` 时保留 attention、同时不出现“执行范围总览”“要做的事”和任一 Epic identifier（`flywheel-FLY-2483:packages/teamlead/src/epic-page/__tests__/attention-render.test.ts:251-305`）。计划的 v1 空 slot / `scopeUnavailable` 普通 header + freshness 约定没有锁住这些负向要求。#1148 则把 item lead note 紧贴机器执行句之后（`flywheel-FLY-2485:packages/teamlead/src/epic-page/render-html.ts:421-424`），并用 `previousElementSibling` 精确断言该相邻关系（对应测试 `:54-90`）；plan:62 却把 B2 放在信号行之后，会直接破坏测试，也不符合 PRD F12 的“贴在机器那句旁边”（`product/doc/FLY-2457-founder-progress-page/prd.md:110,228-235`）。建议把 A 定义为对合入版 `renderAttention(page, now)` 的无条件委托（含 v1 legacy 行为），为 scope unavailable 原样保留 #1147 的最小 header 和全部负向断言；把 B2 移到 `.kid-a` 之后、信号行之前，并保留 #1148 的 fade 脚本及现有测试不改。

3. **排序比较器不是全序，倒序测试也没有按真实生成 API 构造。** plan:21 的规则在合法与不匹配 identifier 混排时不传递：实跑得到 `EPX-2 < EPX-10`、`EPX-10 < EPX-1x`、同时 `EPX-1x < EPX-2`；三种输入排列经该 comparator 排出了两种结果。模型只要求 identifier 为非空字符串，并未保证正则必匹配（`packages/teamlead/src/epic-page/model.ts:849-861,876`），所以这不是不可达输入。另一个问题是 `generateEpicPage` 接受 snapshot + 与 items **按索引对齐**的 facts/signals（`packages/teamlead/src/epic-page/generate.ts:28-42,101-121`），并自行生成 roots/root_counts（`:393-428`）；plan:105 所说先倒 `items`、`roots.value`、`root_counts` 再调用它并无对应 API，且不同输入顺序会合法地改变 `/items/N`、`/header/root_counts/N` 与 `from` 指针，故 G7 也不能要求两份重排文档的完整 HTML 逐字节相同。建议先把 identifier 映射为全序 key：匹配/不匹配类别、前缀码元、无精度丢失的数字键（BigInt 或长度+字典序）、原串 tie-break；加入上述混排及多排列测试。稳定性 fixture 应构造两份 raw snapshot，连同 facts/signals 按 UUID 一起重排后分别调用 generator；只比较去掉 source index 的语义 FounderView 和最终 `data-root`/`data-item` 顺序。同一文档的 HTML `toBe` 应保留为另一条独立测试。

4. **`computeRootCounts` 的“逐字节不变”没有覆盖最容易回归的错误优先级与文案。** 当前实现先检查 `state/blocked_by` 是否 known，再走 parent 链（`packages/teamlead/src/epic-page/rules.ts:267-283`）；如果一个 item 同时有 null state 和 dangling parent，旧行为必须先抛 `counts.v1: state/blocked_by cell must be known: <id>`。抽出 `rootOf` 后若先调用它，错误会变成 parent-chain 文案。现有测试对断链、环、null cell 都只断言错误类型（`packages/teamlead/src/epic-page/__tests__/scope-v2.test.ts:269-305`），plan:84 新增测试也只写“抛”，不足以证明 plan:83 的 throw message 合同。建议明确 `computeRootCounts` 保留“known-cell validation → rootOf → classifyItem”的原顺序，并为 dangling、cycle、null state、null blocked_by、二者与 dangling 同时存在逐一断言完整 message；再用 committed golden 对拍每个 root 的 `value`、`missing` 和有序 `from` 数组。

5. **`allWaitingOn` 等页面新结论没有满足 PRD §12 的来源合同。** `allWaitingOn`、`blockers.where/otherRoot`、压缩后的 `progress` 都只存在于 `FounderView`（plan:41-56），但计划同时声明 `RULE_IDS`、receipt 和文档不变（plan:30），这些 view 字段也没有 source path 或 `observed_at`。例如 EPX-400 summary 的“整块在等 X”是一个新的派生判断，仅在各子单折叠审计里散落原始 `blocked_by` 并不能说明该 summary 由哪些格、哪条规则、哪个观察时刻得出；这与“不得有只存在于页面里的事实，derived 写规则号”的 PRD §12 冲突（`product/doc/FLY-2457-founder-progress-page/prd.md:252-256`）。建议在实施前明确二选一：若这些只是允许的确定性 display projection，则在 FounderView 中为每条结论携带固定 display-rule id、精确 Cell paths 和观察时间，并在相邻 compact audit 中呈现；若仍被视为业务事实，则先由数据合同增加 Cell/规则，再由 E3 消费。不能一边保持全部 provenance 合同不变，一边新增无出处的 Epic 级结论。

6. **88 张预算按计划自己的数字已不成立，且 fallback 会破坏现有 provenance 测试。** research 的估算给出 style 5KB、header 2KB、Lead 区 `45KB + 250B × items`、每个 open child 5KB、每张 Epic 约 1.8KB（`engineering/doc/FLY-2484-epic-card-render/research.md:235-248`）。代入 88 child / 8 roots 已约为 `5 + 2 + 67 + 440 + 14.4 = 528.4KB`，超过 524,288B，尚未计 #1147 attention、#1148 root/item notes 及其样式/脚本；所以 plan:122/154 的“估不会超”没有可信余量。plan:129 的唯一 fallback 是删 derived `from` 明细，但现有 render 测试明确要求每个 source path 都出现在相应 Cell block（`packages/teamlead/src/epic-page/__tests__/render.test.ts:440-445`），也会削弱 §12。建议把预算 fixture 放在两个 sibling 合入后的最终模型上，覆盖有界最大 attention、root/item lead notes 和脚本；先通过去掉重复 `/header/roots`、压缩重复标签/DOM 外壳等不损 provenance 的方式留出明确余量（建议门槛低于硬上限），再以实测的 fixed bytes + per-child slope 定容量。若 88 是硬验收，应写出可重复的第二、第三级压缩方案，而不是在超限后删来源指针。

#### Verdict

CHANGES REQUESTED — address items above

---

## 附:Round 2 原文

### Design Review — plan.md (Round 2)

Date: 2026-09-10
Author: Codex
Status: CHANGES REQUESTED

#### Summary

v2 已实质关闭 Round 1 的 slot 接线、非全序 comparator、重排 fixture 和 `computeRootCounts` 错误优先级问题，完整 roots Cell 单点渲染的方向也正确。仍有四个可构造的合同缺口：隐藏 Epic 的全文切片断言仍会误伤合法 attention/依赖引用，展示规则的 path/time 结构目前无法满足自己的 G15，容量算法没有按 #1147/#1148 的真实模型测量，以及 `rootOf` 尚未锁定“父链最终到 null”的既有行为；因此还不能批准实施。

#### What's Good (Keep)

- `/header/roots` 完整 Cell 只在折叠的 `lead-panel` 出现一次，Epic 内使用不冒充 Cell 的 root projection；再加 `data-cell` page-wide uniqueness 测试，正确解决了 Round 1 的重复 Cell 与审计泄漏主体问题（`engineering/doc/FLY-2484-epic-card-render/plan.md:29-33,79-90,142-145`）。
- Slot A 现在无条件复用 #1147 的 `renderAttention`，包含 v1 legacy 行；`scopeUnavailable` 也保留最小 header、freshness 和 sibling 的负向断言。B2 紧邻 `.kid-a` 且仅调整 sibling 测试中的机器行标签，符合 #1148 与 PRD F12（plan:36-40,75-86,151-154）。
- `identifierKey` 用匹配类别、码元前缀、数字长度/数字串和 raw tie-break 构成全序，不再有精度或传递性问题；两份 raw snapshot 连同 facts/signals 按 UUID 同步重排、分别走 generator，再只比较语义视图和 DOM 顺序，测试形态可执行（plan:22-23,124-130,184-186）。
- `computeRootCounts` 明确保持逐 item 的 known-cell validation → `rootOf`，再逐 root `classifyItem`，并补完整 message、混合错误优先级和有序 `from` golden，足以锁住 Round 1 指出的主要 E1 回归面（plan:19-20,109-115,192）。
- 页面结论明确标为 `view.*` display projection，不混入 `RULE_IDS`、receipt 或第二个 Epic status；这个边界诚实且没有扩大数据合同（plan:26,35,225-234）。

#### Issues & Recommendations

1. **隐藏 Epic 的“lead-panel 前全文不含 identifier”仍不是正确的显隐判据。** HTML 顺序是 attention 在最前（plan:75），而 #1147 的 renderer会直接输出 `attention[].identifier`（`flywheel-FLY-2483:packages/teamlead/src/epic-page/render-html.ts:476-491`）；attention 又与 Epic 范围解耦，所以一条合法 attention 完全可以引用已隐藏的 `EPX-300`。同样，plan:88 会在可见子单的 blocker 徽标中输出 identifier，可见子单也可能依赖该 root。此时没有 `data-root="EPX-300"` 或 EPX-300 卡，但 C4/G1/QA 的 lead-panel 前字符串断言仍会失败（plan:142,178,214）。建议把测试和 QA 改为 DOM/结构断言：可见 `data-root` 集合精确等于 open roots，且不存在 `details.epic[data-root="EPX-300"]`、不存在该 rootIndex 的 root projection；允许 attention、依赖徽标和 Lead 文本独立提及同一个 identifier。

2. **新增的 display-provenance 形状目前既不自洽，也不能通过 G15。** `FounderView.order.from` 使用 `/header/root_counts/*`、`/items/*/...`（plan:47-48），但同一计划要求每个 `from` 都解析到 Cell（plan:58,145,194）；现有 pointer resolver 对数组只接受数字索引，`*` 必然返回 undefined，而且它是 `model.ts` 私有函数，并不能直接从新测试导入（`packages/teamlead/src/epic-page/model.ts:381-395,692-697`）。同时 `order` 和 `blockers[]` 的类型都没有 `observedAt`（plan:47-54），却要求每条 `data-view-rule` 都有 `data-view-observed`；`view.blocker_scope.v1` 的来源也缺 `/header/items`（证明 `in_scope=true` 但 item 不存在）以及当前 item/root 的 parent/root 输入。最后，plan:58 用字符串取最大时间并不正确：模型允许同一秒有或没有小数（`model.ts:295`），`2026-09-10T12:00:00Z` 会被字典序错误地判为晚于 `2026-09-10T12:00:00.999Z`。建议统一定义 `ViewProvenance { rule, from: string[], observedAt }`，让 order、每个 child 的聚合 blockerScope、progress、allWaitingOn 都携带它；构建时展开全部具体数字路径，并用本地测试 helper（或有意导出的公共 helper）断言指向 Cell。blockerScope 应包含 `/header/items`、`/header/roots`、当前 item parent 链和 blocker parent 链；时间按 `Date.parse` 比较并用 raw string 稳定 tie-break。另需给 `epic-hidden` 数以及 counts 缺失时本地计算的 terminal 尾数绑定一个明确的 view rule，否则这两个新页面结论仍没有相邻出处。

3. **C5 的 fixed/slope/capacity 不是最终模型的保守容量测量。** `bytes(0)` 时所有 roots 都因 open=0 被隐藏，所以它不含 8 张 Epic 卡、B1 notes、root projection 和 root-count audit 的固定成本；用它作截距、再用 30→60 的斜率会高估容量（plan:156-158）。更关键的是 #1147 会针对最终 renderer 动态二分保留 attention 行，child 数改变时 attention 行数也会改变；其实现明确要求实际复测候选，禁止从平均行大小推断是否可容纳（`flywheel-FLY-2483:packages/teamlead/src/epic-page/attention-budget.ts:83-139`）。此外所谓“最大 lead notes”实际只放每 root/item 一条，但 #1148 按 `(project, issue, role)` 保存，role 是任意非空字符串，generator 会保留同一 issue 的全部不同 role notes，model 只约束唯一且排序、没有数量上限（`flywheel-FLY-2485:packages/teamlead/src/StateStore.ts:6927-6987`; `.../epic-page/generate.ts:115-132`; `.../epic-page/model.ts:774-801`）。建议取消线性公式：固定 8 个可见 roots，以“最小 attention warning + 声明清楚的 notes-per-issue 支持边界”实际渲染每个候选 n，用离散/二分搜索得到 capacity，并验证 `bytes(capacity) <= limit` 与下一候选不满足。`bytes(60) <= 480KiB` 应作为不含可选 attention rows 的基础页余量测试；另用 #1147 的真实 `applyAttentionBudget` 验证最大候选 attention 会整行截断且最终 HTML ≤512KiB。若 E4 不增加 note 数上限，本计划必须把 capacity 明确写成 notes cardinality 的条件函数，并增加多 role notes 的 fail-closed 边界测试，不能称一条 note 为最大值。

4. **`rootOf` 仍缺一个会影响 byte-identical membership 的合法父链用例。** 当前 `computeRootCounts` 不只在“当前 item 的 `parent.value` 为 null”时得到 null；若 `A.parent=B` 且已知 item `B.parent=null`，循环也会正常走到 null，不抛错，并把 A、B 都排除在所有 root counts 之外（`packages/teamlead/src/epic-page/rules.ts:273-288`）。plan:19 的“null ⇔ parent.value === null”容易被实现成只看起点，而 C1 的 rootOf 测试只有直接 parent null、到根、断链和成环（plan:111-115），golden fixture 也没有声明该链形。建议把合同改成“null ⇔ parent 链最终到达 null”，新增 A→B→null 测试，断言 `rootOf(A) === null`、不抛、两项不进入 root counts，且有序 `from` 仍包含两项的 parent 指针。

#### Verdict

CHANGES REQUESTED — address items above

---

## 附:Round 3 原文

### Design Review — plan.md (Round 3)

Date: 2026-09-10
Author: Codex
Status: CHANGES REQUESTED

#### Summary

已按实际提交 `d43cf815487a2e15cd49baff2416921497358974` 复核；v3 正确关闭了 Round 2 的隐藏-Epic 结构判据和 `rootOf` 深层 null 父链问题，ViewProvenance 与离散预算的总体修法也对。仍有三组会直接造成类型/测试冲突或预算验收失败的内部不一致：新对象形状与 V3 fixture 留有旧断言、`view.progress.v1` 的来源表不覆盖实际分支优先级、以及空-attention 算出的极限 cap 没给 #1147 的最小截断警告留空间，因此尚不能批准。

#### What's Good (Keep)

- 隐藏 Epic 已改成 happy-dom 结构断言：精确比较 `details.epic[data-root]` 集合，并单独排除隐藏 root 的卡与 projection；允许 attention、blocker 和 Lead 文本合法提及相同 identifier，正确关闭 R2-1（`engineering/doc/FLY-2484-epic-card-render/plan.md:158-163,200,236`）。
- `rootOf` 现在明确为“父链最终到 null 即返回 null”，并要求 A→B→null 不抛、两项不入任何 root、`from` 仍保留两条 parent pointer，和现有循环完全一致（plan:20,128-131,148,202；`packages/teamlead/src/epic-page/rules.ts:273-288`）。
- `ViewProvenance` 已统一成 rule/from/observedAt，路径不再使用通配符；`resolvePointer` 只增加 export、不改变校验行为，时间也改用 `Date.parse` + raw tie-break，解决了 Round 2 的 pointer 与同秒时间排序反例（plan:28-30,49-73,147,216）。
- `blocker_scope` 已补 `/header/items`、`/header/roots`、当前 item 与 in-scope blocker 的 parent 链；`epic-hidden` 和 counts 缺失时的 terminal 尾数也各有独立 view rule，出处边界比 v2 完整（plan:67-71,82-84,98-103）。
- 容量不再冒充多 note 的全域保证：明确限定每 issue ≤1 note，并为超界的多 role notes保留 publisher fail-closed；离散真渲染与 `bytes(cap+1)` 边界比 slope 推算可靠（plan:174-180,211,254-256）。

#### Issues & Recommendations

1. **`FounderView` 和 V3 fixture 仍混用了 v2 的标量/旧数量，计划照写会类型失败或测试自相矛盾。** 新类型把 `hiddenDoneEpics` 定义为 `{ count, view }`（plan:49-59），但 HTML 条件仍写 `hiddenDoneEpics > 0`（plan:33），构建规则仍写 `hiddenDoneEpics++`（plan:78），`scopeUnavailable` 返回数字 `0`（plan:86），测试仍断言 `hiddenDoneEpics === 1`（plan:142）。这在 #1147 unavailable 文档上更无法含糊处理：其生成器会把 `header.roots/items` 等 Cell 的 value 置 null 且 items 为空（`flywheel-FLY-2483:packages/teamlead/src/epic-page/generate.ts:539-563`），所以不能先按正常路径建 root-derived provenance。另一个直接冲突是 V3 原有一张 no-parent item（plan:139），又新增 A→B→null 两张且明确二者进入 unattached（plan:148），但下一条仍要求 `unattached` 恰一张（plan:151）；progress 测试也仍断言顶层 `from`，而新形状是 `progress.view.from`（plan:58,152）。建议把 FounderView 定义成以 `scopeUnavailable` 为判别键的 union，并在函数入口先分支：unavailable 分支的 `order`/`hiddenDoneEpics.view` 为 null（不能把未知范围陈述成“隐藏 0 张”）；available 分支统一使用 `.count`，count=0 时要么 view=null，要么把 `/header/roots` 加进 `view.epic_hidden.v1` 以便空 root_counts 仍有 observedAt。同步把测试改为 `.count === 1`、`progress.view.from`，并将 unattached 期望改成三张（或删掉旧 no-parent item）。

2. **`view.progress.v1` 的 `from` 表仍不能证明 plan:85 实际输出的进度结论。** 规则先无条件检查 `run / attempt / session`，任一 null 就输出 `missing`，之后才按 cls 分 live/waiting/free/idle（plan:85；G5 在 plan:204 也写成任一 item）。但来源表按 cls 给 waiting/free 仅 state+blocked_by，idle/unknown 仅 state（plan:71）。可构造一张 `state=backlog, blocked_by=[]` 的 idle item 且 `run.value=null`：页面会显示 `progress.missing(statestore_error)`，其 ViewProvenance 却完全不引用 run；即使三个运行格都 known，判定 idle 也依赖 `blocked_by=[]`，表里仍缺该 Cell。G15 只验证现有 path 能解析，抓不到“该引用的输入没引用”。建议二选一并写死：若保留全局 missing 优先级，则按最终 `ProgressLine.kind` 构造 from，所有走过 missing guard 才到达的分支都纳入 run/attempt/session，idle 另纳入 blocked_by；若运行事实只应影响 live，则把 missing 检查移进 live 分支，并收窄 G5。无论选哪条，都新增 idle+run-error、waiting+session-error、idle+empty-blockers 三个 exact-from 测试。

3. **在“attention 为空”的页面上求出的最大 `cap`，不能保证 #1147 在同一 cap 上还能生成最小截断警告页。** C5 先取 attention empty 的最大 n，使 `bytes(cap) <= 524,288`（plan:176-177），随后才在 `pageForBudget(cap)` 加满 attention 并要求预算器成功截断（plan:178）。但 #1147 截断时会先把 attention 变为 0 行并重建带 `source_truncated`/警告的候选；若这个最小 warning candidate 都不 fit，它会直接抛 `Epic document plus minimum attention warning exceeds size budget`，不会返回可发布页面（`flywheel-FLY-2483:packages/teamlead/src/epic-page/attention-budget.ts:111-119`）。在刚好顶住硬上限的 cap 上，空列表文案能放下并不保证更长的“不完整”警告也能放下，因此 G10 的 attention 断言没有构造保证。建议用“0 attention 行 + budget missing + 实际 warning 文案”的最小候选来定义 `bytesForCapacity(n)` 并搜索 cap，再在同一 cap 上放入最大候选、调用真实 `applyAttentionBudget`，这样 prefix(0) 的可容纳性由构造保证；或者把 attention 联合测试固定在有 32KiB 余量的 n=60，并明确 cap 只代表 confirmed-empty attention 的条件容量。另请让 G10 同步保留 C5 的 `cap==200 ⇒ 只报告 ≥200` 例外，不能在触顶搜索上界时仍强制 `bytes(cap+1)>limit`。

#### Verdict

CHANGES REQUESTED — address items above

---

## 附:Round 4 原文

### Design Review — plan.md (Round 4)

Date: 2026-09-10
Author: Codex
Status: APPROVED

#### Summary

已按提交 `fb24ade694b940f4f9beac6ee0844b0e32c2a4bc` 复核完整 v4、v3→v4 差异及 #1147 的真实 unavailable/attention-budget 代码。Round 3 的三项阻塞均已闭合，且修改没有破坏此前已通过的隐藏-Epic、排序、slot、provenance 和 fail-closed 合同；计划可以进入实现。

#### What's Good (Keep)

- `FounderView` 现在是以 `scopeUnavailable` 判别的 union，unavailable 分支在入口直接返回，`order` 与 `hiddenDoneEpics` 都为 null，不读取 value 为 null 的 roots/items；available 分支从渲染条件、构建规则到测试均统一使用 `hiddenDoneEpics.count`（`engineering/doc/FLY-2484-epic-card-render/plan.md:32,52-53,80,86,88,144,214`）。这与 #1147 在 scope 不可用时把依赖 Cell 置 null、要求 items 为空的合同一致（`flywheel-FLY-2483:packages/teamlead/src/epic-page/generate.ts:549-563`; `model.ts:917-937`）。
- V3 fixture 的遗留矛盾已清干净：unattached 明确为原 no-parent 加 A→B→null 共三张，progress 断言改为 `progress.view.from`，hidden count 改为 `.count`；G11 也要求验证 unavailable union 的 null 字段与 HTML 负向行为（plan:144,150,153-155,214）。
- `view.progress.v1` 统一引用 state、blocked_by、run、attempt、session 五格，准确覆盖当前“先检查三个执行格，再按 state/blocked_by 分类”的读取顺序；idle+run-error、waiting+session-error、idle+empty-blockers 三个 exact-from 用例能防止再次漏源（plan:73,83,87,154,206）。
- 容量边界现在由真正需要保留的最小截断告警页定义，而不是 confirmed-empty attention 页；`cap < 200` 才要求 `bytes(cap+1)` 越界，触顶则诚实报告 `≥ 200`（plan:176-180,213）。#1147 的预算器确实先构造 `prefix(page, 0)`，该候选放不下即抛错（`flywheel-FLY-2483:packages/teamlead/src/epic-page/attention-budget.ts:111-119`）；v4 又在同一 cap 上调用真实 `applyAttentionBudget`，同时验证整行截断、告警和最终 HTML 上限，因此构造假设不会静默失真。
- 每 issue ≤1 条 lead_note 的容量条件和超界后的 publisher fail-closed 仍写得清楚；没有把测试容量扩大成无上限 notes 的产品承诺，也不删除 `data-cell` 或 `observed_at`（plan:177-186,213,258）。

#### Issues & Recommendations

1. 无阻塞问题。实施与 evidence 阶段按 C5 记录实际 `cap`、边界字节和冻结快照重放值，并保留计划规定的 #1147/#1148 sibling 回归门禁即可。

#### Verdict

APPROVED — ready to implement
