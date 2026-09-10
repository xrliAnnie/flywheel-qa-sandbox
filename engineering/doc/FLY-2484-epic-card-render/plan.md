# FLY-2484 进度页渲染层:Epic 卡 + 子单行 — 实施计划
Issue: FLY-2484 (https://linear.app/geoforge3d/issue/FLY-2484/进度页e3-渲染层epic-徽标照抄-linear-子单计数分组稳定排序依赖徽标等-fly-xxxx整块在等跨-epic)
日期: 2026-09-10
基于: research.md

> 版本:**v4**(2026-09-10;Codex 设计评审 R3 三条全部采纳,均为 v3 补丁留下的内部不一致:① `FounderView` 改为以 `scopeUnavailable` 判别的 union,unavailable 分支 `order` / `hiddenDoneEpics` 为 null,available 分支统一 `hiddenDoneEpics.count`,`view.epic_hidden.v1` 的 `from` 加 `/header/roots` 保证 count=0 也有 observedAt;测试改 `.count === 1`、`progress.view.from`、`unattached` 三张;② `view.progress.v1` 的 `from` 固定为五格(state / blocked_by / run / attempt / session,全部被读过),补 idle+run-error、waiting+session-error、idle+empty-blockers 三个 exact-from 用例;③ 容量搜索改在「0 attention 行 + budget missing + 真实截断警告文案」的最小候选页上进行,再在同一 cap 放最大候选调真 `applyAttentionBudget`,prefix(0) 可容纳由构造保证;G10 保留触顶上界例外)。
> v3(2026-09-10;Codex 设计评审 R2 四条全部采纳:① 隐藏 Epic 改为结构断言(可见 `data-root` 集合 == open roots、无该 root 的 `details.epic` 与投影行),attention / 依赖徽标 / Lead 文本可独立提及同一 identifier;② 统一 `ViewProvenance {rule, from, observedAt}`,`from` 全部展开为具体数字路径、用导出的 `resolvePointer` 断言指向 Cell,时间按 `Date.parse` 比较 + 原串 tie-break,`blocker_scope` 补 `/header/items` `/header/roots` 与两条 parent 链,`epic-hidden` 数与 counts 缺时的终态尾数各绑一条 view rule;③ 容量改为最终模型上的离散搜索:固定 8 个可见 root、声明 notes-per-issue 边界、渲染每个候选 n,断言 `bytes(cap) ≤ limit` 且 `bytes(cap+1) > limit`,attention 用 #1147 的 `applyAttentionBudget` 实测整行截断,多 role notes 加 fail-closed 边界测试;④ `rootOf` 合同改为「null ⇔ parent 链最终到达 null」,补 A→B→null 用例)。
> v2(2026-09-10;Codex 设计评审 R1 六条全部采纳:① `/header/roots` 全格只在 Lead 面板出一次,Epic 卡改为本 root 投影并用不冒充 Cell 路径的 `data-source-cell` 标记,隐藏 identifier 的断言收窄到 Epic 区;② 插槽 A 改为无条件委托合入版 `renderAttention`(含 v1「旧版尚未采集」行),`scopeUnavailable` 原样保留 #1147 的最小 header 与全部负向断言,插槽 B2 移到机器进度行之后、信号行之前;③ 排序键改为全序元组(匹配类 / 前缀 / 无精度丢失的数字键 / 原串),稳定性测试改为两份按 UUID 同步重排的 raw snapshot 各自走 generator、只比语义视图与 `data-root`/`data-item` 序;④ `computeRootCounts` 明写「known-cell 校验 → rootOf → classifyItem」原顺序,逐条断言完整错误文案并加逐根 golden;⑤ 页面级派生结论(整块在等 / blocker 归属 / 进度行 / 顺序)各带页面展示规则号 + 输入格路径 + 观测时间,作为 display projection 呈现在相邻审计里,不改文档合同;⑥ 预算不再承诺 88 张:以合入两个 sibling 后的最终模型实测 fixed + 每张斜率算容量,断言容量 ≥ 60 且预算 fixture ≤ 480KB 软线,并列出不损出处的二、三级压缩)。
> v1(2026-09-10)。Lead 2026-09-10 已书面裁定两条(exploration §5):E3 implement 在 #1147(E2)与 #1148(E4)合入后以 main 为基线动手,设计留固定插槽;分组键 = Linear `state.type`,counts 只显示不排序。
> 成色:✅ 亲手核过(file:line / 字节实测);🔶 本单裁定。

## 0. 一句话

只改渲染层:新增纯函数 `buildFounderView(page)` 把 E1 文档排成「Epic 卡(徽标 = Linear `state.name` 原话 + `root_counts` 计数行,默认收起,全做完的不出现)→ 未终态子单行(在跑 → 等依赖 → 可起跑 → 未开始,徽标『等 FLY-XXXX』并标跨 Epic / 范围外,Epic 全被挡时头部『整块在等 XXX』)」,`renderEpicPageHtml` 消费它;子单徽标与 Epic 计数共用从 `computeRootCounts` 抽出的 `classifyItem`;终态子单不出行只出数,审计格瘦身;页面自己推出的结论各带页面展示规则号与输入格路径。零文档合同改动、零取数改动、Markdown 不动、不画依赖图、不做留言层。

## 1. 稳定身份与显示标签

| 类别 | 标识 | 说明 |
|---|---|---|
| 纯函数 | `classifyItem(item): ItemClass \| null` | `rules.ts` 导出;从 `computeRootCounts`(`rules.ts:307-318` ✅)抽出;`ItemClass = "live" \| "waiting" \| "free" \| "idle" \| "done" \| "canceled"`;null ⇔ 未知 `state.type` |
| 纯函数 | `rootOf(item, byId, rootIds): string \| null` | `rules.ts` 导出;从 `computeRootCounts` 的 parent 链走法(`:264-289` ✅)抽出;**null ⇔ 沿 `parent.value` 走的链最终到达 null**(起点为 null,或 A→B 且 B.parent 为 null 等任意深度;与今天 `:273-288` 循环行为相同,不抛、不归任何 root);链指向既非 root 也非 item / 成环 ⇒ `EpicPageSchemaError("counts.v1: parent chain does not reach a root: <id>")`(文案与今天逐字相同)(Codex R2-4) |
| 调用顺序 | `computeRootCounts`:对每张 item **先** known-cell 校验(`state/blocked_by` 非 null,否则抛 `counts.v1: state/blocked_by cell must be known: <id>`)**再** `rootOf` **再** `classifyItem` | 与 `rules.ts:267-283` 今天顺序一致;错误优先级不变(Codex R1-4) |
| 纯函数 | `buildFounderView(page): FounderView` | 新文件 `epic-page/founder-view.ts`;确定序;不读时钟 |
| 全序键 | `identifierKey(id): [cls: 0\|1, prefix: string, numLen: number, numDigits: string, raw: string]` | 匹配 `^([A-Za-z]+)-(\d+)$` ⇒ `[0, 前缀, 去前导零后的位数, 去前导零后的数字串, 原串]`;不匹配 ⇒ `[1, "", 0, "", 原串]`;元组逐位比较(字符串用码元序 `<`,数字用 `-`)。位数 + 数字串 = 无精度丢失的数值序;原串兜底 ⇒ 全序(Codex R1-3) |
| 纯函数 | `compareIdentifier(a, b)` | = 比较 `identifierKey(a)` 与 `identifierKey(b)`;⛔ 不用 `localeCompare` |
| 排序常量 | `ROOT_GROUP = {started:0, unstarted:1, backlog:2, triage:2}`,其它 3 | Epic 分组键(Lead 裁定) |
| 排序常量 | `CHILD_GROUP = {live:0, waiting:1, free:2, idle:3, unknown:4}` | 子单行分组键 |
| 页面展示规则号 | `view.order.v1` / `view.epic_waiting.v1` / `view.blocker_scope.v1` / `view.progress.v1` / `view.epic_hidden.v1` / `view.terminal_tail.v1` | **不进** `RULE_IDS`、不进文档、不进回执;只出现在 HTML 审计里,前缀 `view.` 与文档规则 `*.v1` 区分;文案标「页面展示规则」(Codex R1-5);每条结论一律带 `ViewProvenance`(§2.1)(Codex R2-2) |
| 类型 | `ViewProvenance { rule: ViewRuleId; from: string[]; observedAt: string }` | `founder-view.ts` 导出;`from` 只含**具体数字路径**(⛔ 无 `*`),每条必须 `resolvePointer` 到 Cell;`observedAt` = `from` 各 Cell `observed_at` 按 `Date.parse` 取最大,相等时原串码元序取大(有小数与无小数同秒不混判) |
| 导出 | `resolvePointer(root, pointer)` 从 `model.ts` 改为 `export` | 今天是私有(`model.ts:381-397` ✅);测试与 `founder-view.ts` 共用同一解析器,不复制 |
| HTML 结构 | `<details class="epic" data-root=… data-state-type=…>` 无 `open` | 每个已列 Epic 一张;`<summary>` 内 `.e-st`(徽标)`.e-id` `.e-n` `.e-c`(计数)`.e-wait`(整块在等,可缺) |
| HTML 结构 | `<div class="kid" data-item=… data-class=…>` | 每张未终态子单一行;`.kid-h` 内 `.s.s-{cls}` 徽标;`.kid-a`(机器进度行,`data-machine-line`);插槽 B2;信号行;`<details class="audit">` 15 格 + 展示规则行 |
| HTML 结构 | `<details class="lead-panel">` 无 `open` | 今天的 freshness + 8 个根格总览卡原样搬入,在全部 Epic 卡之后;`/header/roots` 全格**只在这里**出一次 |
| HTML 结构 | `<p class="epic-hidden">` | 全做完 Epic 的**数**;仅 `hiddenDoneEpics.count > 0`(available 分支) |
| 出处标记(Cell) | `data-cell="/items/N/<15 格>"`、`data-cell="/header/root_counts/N"`、8 个根格(含 `/header/roots`,仅 lead-panel) | `render.test.ts` 逐格对拍靠它;每个 `data-cell` 路径全页**恰出现一次** |
| 出处标记(投影) | `data-source-cell="/header/roots" data-source-value="/header/roots/value/N"` | Epic 卡审计里本 root 的投影行:只含本 root 的 identifier / title / url / state,附 `/header/roots` 的 provenance 与 `observed_at`;⛔ 不用 `data-cell`(不冒充 Cell)(Codex R1-1) |
| 出处标记(展示规则) | `data-view-rule="view.*.v1" data-view-from="<逗号分隔的具体 Cell 路径>" data-view-observed="<ViewProvenance.observedAt>"` | 每条页面级结论一行(Codex R1-5);六种规则各自的 `from` 定义见 §2.1 |
| 文案 | research §4 全表 + 本版新增(§2.4),全部进 `labels.ts` | 页面自身文案的唯一来源(F13) |
| 不变 | `page.title`、`schema_version`、`generator.version`、`assertEpicPage` 行为(仅新增 `export` `resolvePointer`)、`RULE_IDS`、`EPIC_PAGE_MAX_HTML_BYTES = 524,288`、`render-markdown.ts`、`receipt.ts`、回执 `sources`、`source_digest` | 渲染层纯改动;固定页下一次刷新自然换形 |
| 插槽 A | `renderAttention(page, now)`(#1147 的函数,原样) | `<main>` 第一个子节点;**无条件委托**:v1 文档出「不知道(旧版尚未采集)」段(#1147 行为),v2 出其列表;E3 不另写 `renderAttentionSlot` |
| 插槽 B1 | `renderLeadNotes(root.lead_note, now, fadeDays)`(#1148 的函数,原样) | Epic 卡 `.e-b` 第一个子节点 |
| 插槽 B2 | `renderLeadNotes(item.lead_note, now, fadeDays)`(同上) | **紧跟** `.kid-a` 机器进度行之后、信号行之前(PRD F12「贴在机器那句旁边」;#1148 `previousElementSibling` 断言) |
| 包名 / 命令 | `pnpm --filter flywheel-teamlead exec vitest run src/epic-page`、`pnpm --filter flywheel-teamlead typecheck`、根 `pnpm lint` | ✅ E1 evidence:`test:run -- <path>` 会触发整包;typecheck 前先 `pnpm --filter 'flywheel-teamlead^...' build` |
| 前置 | #1147、#1148 合入 main | Lead 裁定;implement 开工前 `git log main` 核两个 merge commit,没合就等,不先动 |

## 2. 视图模型与渲染契约

### 2.1 `FounderView`(research §3 为基,本版加出处字段)

```ts
ViewProvenance { rule; from: string[]; observedAt }          // §1;from 全部为具体数字路径
FounderView = { scopeUnavailable: true; epics: []; unattached: []; hiddenDoneEpics: null; order: null }      // #1147 unavailable 文档:roots/items 等 Cell value 为 null、items 为空(flywheel-FLY-2483:generate.ts:539-563),不建任何 root 派生出处
            | { scopeUnavailable: false; epics: EpicView[]; unattached: ChildView[]; hiddenDoneEpics: { count: number; view: ViewProvenance }; order: ViewProvenance }
EpicView   { rootIndex; identifier; title; url; state{name,type}; counts | null; countsMissing?;
             allWaitingOn: { blockers: string[]; view: ViewProvenance } | null;
             children: ChildView[]; terminal: { done; canceled; view: ViewProvenance | null } }   // view 非 null ⇔ counts 缺、由 classifyItem 现数
ChildView  { itemIndex; identifier; title; url | null; cls: ItemClass | null; stateName;
             blockers: { identifier; where: "same_epic"|"other_epic"|"outside"; otherRoot? }[];
             blockerScope: ViewProvenance | null;                                              // blockers 非空时非 null(一条,聚合全部 blocker)
             progress: ProgressLine & { view: ViewProvenance };
             signals }
```

各规则的 `from`(全部展开为具体路径,升序去重):

| rule | from |
|---|---|
| `view.order.v1`(全页一次) | `/header/roots`、每个 `/header/root_counts/i`、每张 item 的 `/items/j/parent` `/items/j/state` `/items/j/blocked_by` |
| `view.epic_hidden.v1`(全页一次) | `/header/roots` + 每个 `/header/root_counts/i`(root 为 0 时仍有 `/header/roots` ⇒ observedAt 有定义) |
| `view.epic_waiting.v1`(每个整块在等的 Epic) | `/header/root_counts/i` + 该 Epic 每张 waiting 子单的 `/items/m/blocked_by` `/items/m/state` |
| `view.terminal_tail.v1`(仅 counts 缺的 Epic) | 该 Epic 每张子单的 `/items/m/state` + `/items/m/parent` |
| `view.blocker_scope.v1`(每张有 blocker 的子单一条) | `/header/items`、`/header/roots`、本单 `/items/n/blocked_by`、本单 parent 链上每张 item 的 `/items/k/parent`、每个 in-scope blocker 及其 parent 链上每张 item 的 `/items/k/parent` |
| `view.progress.v1`(每张已列子单) | **固定五格**:`/items/n/state` `/items/n/blocked_by` `/items/n/run` `/items/n/attempt` `/items/n/session` —— 无论最终 kind 是什么,这五格都被读过(missing 守卫读三个运行格,分类读 state + blocked_by),所以 `from` 不按 kind 分支(Codex R3-2) |

`observedAt`:对 `from` 逐条取 Cell 的 `observed_at`,`Date.parse` 最大者;相等时原串码元序取大。测试:每条 `from` `resolvePointer(page, path)` 满足 `isCell`;`observedAt` 与手算一致(fixture 里刻意给一格 `…:00.999Z`、一格 `…:00Z` 同秒)。

### 2.2 `buildFounderView` 的规则(逐条可测)

1. `byId = Map(items by identifier)`,`rootIds = Set(roots.value[].identifier)`;每张 item `rootOf` ⇒ 归 root 或进 `unattached`。
2. Epic 显隐:`counts = root_counts[i].value?.counts ?? null`;`open = counts ? live+waiting+free+idle : children.filter(cls ∉ {done,canceled}).length`;`open === 0` ⇒ 不列;若 `counts` 非缺 ⇒ `hiddenDoneEpics.count++`。
3. Epic 序:`(ROOT_GROUP[state.type] ?? 3, identifierKey(identifier))`。
4. 子单行:只含 `cls ∉ {done, canceled}`(含 null);序 `(CHILD_GROUP[cls ?? "unknown"], identifierKey)`。
5. `blockers`:`blocked_by.value.filter(b => b.blocker_state_type !== "completed")`,按 research §3.3 判 `where`,`compareIdentifier` 升序。
6. `allWaitingOn`:`counts && live===0 && free===0 && idle===0 && waiting>0` ⇒ 该 Epic waiting 子单 `blockers[].identifier` 并集升序 + `ViewProvenance(view.epic_waiting.v1)`;否则 `null`。
7. `terminal`:`counts ? {done, canceled, view: null} : {按 classifyItem 现数, view: ViewProvenance(view.terminal_tail.v1)}`。
7b. `hiddenDoneEpics = { count, view: ViewProvenance(view.epic_hidden.v1) }`;`order = ViewProvenance(view.order.v1)`;每张有 blocker 的子单 `blockerScope = ViewProvenance(view.blocker_scope.v1)`;每张子单 `progress.view = ViewProvenance(view.progress.v1)`。
8. `progress`:research §5;`run / attempt / session` 任一 `value === null` ⇒ `missing`(reasons 去重升序);`cls === "live"` 且 `run.value` 空 ⇒ `live_no_run`;live 且有 run ⇒ `{node, attempt?, status?}`;`waiting/free` ⇒ blockers;`idle` 与 `cls === null` ⇒ `idle`。
9. `scopeUnavailable`:`page.schema_version === 2 && page.epic_scope.value === null`(#1147 类型);**函数入口先分支**:为 true 时直接返回 `{scopeUnavailable: true, epics: [], unattached: [], hiddenDoneEpics: null, order: null}`,不读 roots / items / root_counts(它们的 value 为 null);⛔ 不把未知范围陈述成「隐藏 0 个」。
10. 全程不读 `Date`、不读 `now`;不读输入数组顺序以外的任何东西决定输出顺序。

### 2.3 渲染契约(research §6 标记为基,本版修正)

- 顺序:插槽 A(`renderAttention`)→ header → 「在做的 Epic」标题行 → Epic 卡 × N → `epic-hidden`(非零才有)→ unattached 卡(非空才有)→ `lead-panel` details → 唯一 nonce 脚本(E3 的「多旧」计时 + #1148 的淡化段合并为一块)。
- **`scopeUnavailable`**:输出 = 插槽 A + #1147 的最小 header(`h1` + `epic.scope_unavailable` 一句 + 生成时间)+ `renderFreshness`;**不出**「执行范围总览」「现在可以开始的」「要做的事」「个 active 父单」、任何 Epic / item identifier、任何 Epic 卡、lead-panel(#1147 `attention-render.test.ts:251-273` 负向断言原样成立)。
- `epics.length === 0 && !scopeUnavailable` ⇒ `epic.none` 一句。
- Epic `<summary>`:`.e-st` 文本 = `state.name` 原话,`data-state-type` = `state.type`;计数行段序 `live → waiting → free → idle → total`,`waiting/free/idle` 为 0 省略,`live` 与 `total` 恒出;缺 ⇒ `counts.missing`;`.e-wait` 仅 `allWaitingOn` 非 null。
- Epic `.e-b`:插槽 B1 → 子单行 × N → 终态尾行(非零才有)→ Epic 审计 details:
  - 投影行 `data-source-cell="/header/roots" data-source-value="/header/roots/value/N"`:本 root 的 identifier / title / url(`safeLinearLink`)/ state.name,后接 `/header/roots` 的 `htmlProvenance` 与 `observed_at`(+ `source_updated_at`);
  - `data-cell="/header/root_counts/N"`:沿用 `renderAuditCell` 全款(其 value 只含本 root);
  - 展示规则行 `data-view-rule="view.epic_waiting.v1"`(仅 `allWaitingOn` 非 null)与 `view.terminal_tail.v1`(仅 counts 缺):文案 `view.rule_note`「页面展示规则 {rule} · 由 {from} 推出 · 输入最新观测 {at}」。
- 子单行:`.kid-h`(徽标 + 链接 + 标题)→ `.kid-a`(进度行 + `<span class="src">机器测的</span>`,`data-machine-line`)→ **插槽 B2** → 信号行(非空才有,`signalList` 两行:非 waiting_founder / waiting_founder)→ `<details class="audit">`:
  - `audit-head`:`safeLinearLink(url)` + 机器原话 `executionSummary(item)`(含 `ledger_live_count=`);
  - 15 格 `audit-cell data-cell="/items/N/<field>"`:标签、`<code>` 值(`acceptance` ≤240 字预览,其余全量 JSON;缺格写 `missing.reason`)、出处(`issue:{uuid} · {field}` / `{table} · {key}` / 规则号 + 全部 `from`)、`看到 {observed_at}`、`源 {source_updated_at}`(有则出);
  - 展示规则行 ×2:`view.blocker_scope.v1`(仅 blockers 非空)、`view.progress.v1`。
- 页面级:「在做的 Epic」标题行下一行 `data-view-rule="view.order.v1"`(一次);`epic-hidden` 段落内 `data-view-rule="view.epic_hidden.v1"`(仅非零)。
- 徽标文案:`child.live / child.waiting(blockers) / child.free / child.idle / child.unknown_type(state.name)`;waiting 的 blockers 文本 = `identifier + where 后缀`,`/` 连接,>3 个截断为前 3 + `等 {n} 张`。
- 转义:一切文本与属性值 `escapeHtml`;`href` 只经 `safeLinearLink`。
- 每个 `data-cell` 路径全页恰出现一次(测试用正则数)。

### 2.4 本版新增文案(`labels.ts`)

| key | 文案 |
|---|---|
| `view.rule_note` | 页面展示规则 {rule} · 由 {from} 推出 · 输入最新观测 {at} |
| `view.order.v1` 说明(`view.order_desc`) | Epic 按 Linear 状态分组、组内按单号;子单 在跑 → 等依赖 → 可起跑 → 未开始、组内按单号 |
| `audit.root_projection` | 本 Epic 在「active 父单」格里的那一项 |

## 3. 改动清单(按依赖顺序;编译切片)

| 切片 | 含 | typecheck 要求 |
|---|---|---|
| S1 | C1 `rules.ts` 抽函数 + C2 `labels.ts` 词表 | 末尾绿 |
| S2 | C3 `founder-view.ts` + fixture V3 + `founder-view.test.ts` | 末尾绿 |
| S3 | C4 `render-html.ts` 重写 + `render.test.ts` 改写 + 插槽接线 + sibling 测试复核 | 末尾绿 |
| S4 | C5 预算实测 + 真数据重放 + evidence | 只加测试与证据 |

### C1 · `packages/teamlead/src/epic-page/rules.ts`
- 新导出 `ItemClass`、`classifyItem`、`rootOf`;`computeRootCounts` 改为:对每张 item 按 §1「调用顺序」行 —— known-cell 校验 → `rootOf` → 归属;然后逐根 `classifyItem` 累加;`from` 指针构造、`missing` 判定、`total` 求和逐字不动。
- 测试 `rules.test.ts`:既有 `counts.v1` 用例一字不改;新增:
  - `describe("classifyItem")`:六类各一 + `triage` 归 open + canceled blocker ⇒ waiting + 未知 type ⇒ null;
  - `describe("rootOf")`:直达根 / 孙单沿链 / 起点 `parent` null ⇒ null / **A→B 且 B.parent null ⇒ `rootOf(A) === null` 且 `rootOf(B) === null`,不抛,`computeRootCounts` 两张都不进任何 root,有序 `from` 仍含两张的 parent 指针**(Codex R2-4)/ 链指向未知 ⇒ 抛且 message === `counts.v1: parent chain does not reach a root: EPX-8` / 成环 ⇒ 同文案;
  - `describe("computeRootCounts error precedence")`(Codex R1-4):null state ⇒ `counts.v1: state/blocked_by cell must be known: EPX-1`;null blocked_by ⇒ 同;**null state + dangling parent 同时存在 ⇒ 必须是 known-cell 文案**;dangling 单独 ⇒ parent-chain 文案;每条 `toThrow(new EpicPageSchemaError(<完整文案>))` 级别比对;
  - golden:`epicShapeSnapshotV2()` 生成后 `header.root_counts` 每根的 `{value, missing, from}` 与提交的 JSON 常量 `toEqual`(有序 `from`)。

### C2 · `packages/teamlead/src/epic-page/labels.ts`
- 加 research §4 全表 + §2.4;既有 key 不改。
- 测试 `labels.test.ts`:新 key 逐个可渲染;`child.waiting` 缺 `blockers` 抛错;`view.rule_note` 三参数。

### C3 · `packages/teamlead/src/epic-page/founder-view.ts`(新)+ fixture
- 按 §2.2 实现;导出 `buildFounderView / identifierKey / compareIdentifier / ROOT_GROUP / CHILD_GROUP` 与类型。
- `fixtures/epic-shape.ts` 新增 `epicShapeSnapshotV3()`:根 `EPX-100`(started,未做完)、`EPX-200`「日常」(started,一张 idle)、`EPX-300`(started,子单全 completed/canceled ⇒ 隐藏)、`EPX-400`(started,两张子单都 waiting ⇒ 整块在等);子单覆盖 live(配真 facts)/ waiting 被同 Epic 挡 / waiting 被 EPX-200 的子单挡(跨 Epic)/ waiting 被范围外 `EPX-90` 挡 / free / idle / backlog idle / done / canceled / `parent: null` 一张 / `state.type: "future"` 一张归 EPX-100;identifier 含 `EPX-999` 与 `EPX-1000`;导出 `v3ItemFacts(snapshot)`。
- 新导出 `permuteSnapshot(snapshot, facts, signals, seed)`:按 UUID 同步重排 `items / facts / signals`(以及 `roots` 顺序),返回三者;供稳定性测试用(Codex R1-3)。
- 测试 `__tests__/founder-view.test.ts`:
  - 序:`epics.map(identifier) === ["EPX-100","EPX-200","EPX-400"]`;`hiddenDoneEpics.count === 1` 且 `hiddenDoneEpics.view.from` 含 `/header/roots`;每 Epic `children` 的 `cls` 按 `CHILD_GROUP` 单调,组内 `compareIdentifier` 升序;`EPX-999` 在 `EPX-1000` 前;
  - **全序**:对集合 `["EPX-2","EPX-10","EPX-1x","epx-3","ZZZ","EPX-02","EPX-0"]` 的全部排列(7! = 5040,一次跑 <1s)`sort(compareIdentifier)` 结果逐个 `toEqual`;`identifierKey("EPX-02")` 与 `"EPX-2"` 数字键相同、原串区分;传递性随机对 1,000 组三元断言;
  - **稳定**:`permuteSnapshot` 两个 seed ⇒ 两份 raw snapshot 各自 `generateEpicPage` ⇒ `stripIndexes(buildFounderView(a))` 与 `stripIndexes(buildFounderView(b))` `toEqual`(去掉 `itemIndex / rootIndex / from / observedAt`;`from` 另断言长度与解析后指向同一 identifier 的格);两份 HTML 的 `data-root` 序列与 `data-item` 序列相同;
  - 行数按徽标 + `terminal` == `root_counts[i].counts`(counts 非缺的根);
  - `EPX-400.allWaitingOn.blockers` = 两张子单 blocker 并集升序;`EPX-100.allWaitingOn === null`;
  - **ViewProvenance**:遍历视图里全部六种 `ViewProvenance`(order / epic_hidden / 每个 epic_waiting / 每个 terminal_tail / 每个 blockerScope / 每个 progress),每条 `from` 无 `*`、升序去重、`resolvePointer(page, path)` 满足 `isCell`;`blockerScope.from` 含 `/header/items` `/header/roots` 与跨 Epic 用例两条 parent 链;`observedAt` 与手算一致,含同秒 `…:00Z` vs `…:00.999Z` 用例(fixture 给两格不同 `observed_at`);
  - A→B→null 链:V3 再加一对 `EPX-1x`(不匹配正则)→ `EPX-77`(parent null),两张进 `unattached`,任何 Epic 不含它们;
  - blocker `where` 三种各命中一次,`otherRoot === "EPX-200"`;
  - `EPX-100.counts === null && countsMissing.reason === "unknown_state_type"`,EPX-100 仍在 `epics`,未知类型子单 `cls === null` 且在末组;
  - `unattached` 恰三张(原 no_parent 一张 + A→B→null 两张),按 `compareIdentifier` 序;
  - `progress`:live ⇒ `{kind:"live", node:"实现", attempt:2, status:"running", view:{rule:"view.progress.v1", from:[五格], observedAt}}`;`run` 格 `statestore_error` ⇒ `missing`;`run.value=[]` ⇒ `live_no_run`;**exact-from 三例**(Codex R3-2):idle 子单 + `run` 格 error ⇒ `kind:"missing"` 且 `view.from` 恰为五格;waiting 子单 + `session` 格 error ⇒ 同;idle 子单 `blocked_by=[]` 三格全 known ⇒ `kind:"idle"` 且 `view.from` 仍恰为五格(含 `/items/n/blocked_by`);
  - `scopeUnavailable`:构造 v2 文档(#1147 fixture)`epic_scope.value=null` ⇒ `epics=[]`。

### C4 · `packages/teamlead/src/epic-page/render-html.ts` + `render.test.ts` + sibling 测试
- 按 §2.3 重写 `renderEpicPageHtml`;新增 `renderEpic / renderChild / renderChildAudit / renderRootProjection / renderViewRule / renderCountsLine / renderProgress`;保留复用 `renderAuditCell / renderOverviewCell / renderFreshness / renderDependencyReview / stuckSummary / waitingFounderSummary / signalList / executionSummary / safeLinearLink / htmlProvenance / derivedRuleNote`,以及 #1147 的 `renderAttention` 与 #1148 的 `renderLeadNotes / leadNoteRoleLabel` 原样;删除 `renderItem / itemCells / whySummary / dependentList / blockerList`(删前 grep 零引用)。
- 样式并入一个 `<style>`;脚本并入一块 nonce 脚本(E3 计时 + #1148 淡化)。
- `render.test.ts` 改写(exploration §1.5)并新增:
  - `first screen has zero expanded details`:`/<details\b[^>]*\sopen\b/` 不匹配;
  - `renders one epic card per root with open children and hides finished roots`(Codex R2-1,结构断言):用 happy-dom 解析,`[...querySelectorAll('details.epic')].map(e => e.dataset.root)` **精确等于** `view.epics.map(identifier)`;`querySelector('details.epic[data-root="EPX-300"]') === null`;不存在 `data-source-value="/header/roots/value/<EPX-300 的 index>"`;`.epic-hidden` 文本含「1」;⛔ 不再断言全文不含 `EPX-300`(attention / 依赖徽标 / Lead 面板可合法提及它,fixture 里故意让一张可见子单被 EPX-300 的子单挡住以固定这一点);
  - `every data-cell path appears exactly once`:正则收集全部 `data-cell="…"`,`new Set` 大小 === 数组长度,且 `/header/roots` 恰一次、在 lead-panel 内;
  - `epic audit carries a root projection, not a second roots cell`:每张 Epic 有 `data-source-cell="/header/roots"` 与 `data-source-value="/header/roots/value/N"`,含本 root identifier 与 `/header/roots` 的 `observed_at`,不含其它 root 的 identifier;
  - `view rules carry rule id, from paths, and observed time`:每个 `data-view-rule` 的 `data-view-from` 逐条 `resolvePointer` 到 Cell,`data-view-observed` 与视图一致;六种规则各至少出现一次(fixture 保证);
  - `badge copies Linear state name verbatim`;`counts line omits zero open buckets but always shows live and total`;`child badges say 等 FLY-XXXX and mark cross-epic and outside blockers`;`whole-epic waiting line sits inside the summary`;
  - `terminal children render no row and no audit cells, only the tail count`;
  - `lead panel follows the last epic card and keeps all 8 root cells`;
  - `renders all 8 root and 15 item Cell paths…`:`ITEM_PATHS` 加 `parent`,fixture 用 V3 且 `/items/0` 非终态;
  - `renders byte-identical HTML for the same document`(同 `now` 两次 `toBe`;与 C3 的重排测试分开);
  - `lead note sits right after the machine line`(B2):`.kid-a` 的下一个兄弟是 `.lead-note`;
  - 安全用例沿用 + blocker identifier 含 `<script>` 时徽标转义;
  - `progress line words map to fields`:含「到「实现」· 第 2 次 · 会话 running」;`ledger_live_count=` 只在 `<details class="audit">` 内。
- **sibling 测试复核**(接线后必须绿):#1147 `attention-render.test.ts` 全部(含 :251-273 负向、:275-305 legacy「不知道(旧版尚未采集)」);#1148 `render.test.ts` 的 lead-note 用例。允许的唯一改动:#1148 `previousElementSibling` 断言的期望文本从 `page.accounted_execution` 改为 `progress.source`(机器行在新骨架里叫「机器测的」,语义不变:紧邻机器那句);其它 sibling 断言一字不改,若还有不绿的 ⇒ 是 E3 骨架错,不改测试。

### C5 · 容量实测(Codex R1-6 / R2-3):最终模型上的离散搜索,不用线性公式
- **支持边界(明写进 evidence 与 §8)**:每个 issue(root 或 item)**≤ 1 条 lead_note**(280 字)。#1148 按 `(project, issue, role)` 存、model 只要求 role 唯一有序、没有数量上限(✅ `flywheel-FLY-2485:model.ts:774-801`);超出边界不是本单容量承诺的范围,行为是既有 fail-closed(见下)。
- `pageForBudget(n)`:固定 **8 个可见 root**(每个至少 1 张 open 子单,合计 n 张 open 子单,轮流分配)、每 root / 每子单各 1 条 280 字 lead_note、标题 120 字、验收 4,096 B、每子单 3 条 blocker(含跨 Epic)、live 子单带 facts、每子单 1 条信号;**attention 取空**(attention 的字节由 #1147 的预算器自己在最终 renderer 上二分保证,见下一条)。
- **搜索页 = 最小截断警告页**(Codex R3-3):`bytesForCapacity(n)` 渲染 `pageForBudget(n)` 时 attention 取 **0 行 + `attention_sources.budget` 为 `source_truncated` + 真实警告文案**(即 #1147 预算器截断到 0 行时重建的那个最小候选,✅ `flywheel-FLY-2483:attention-budget.ts:111-119`:它放不下就抛 `Epic document plus minimum attention warning exceeds size budget`,不出页)。对候选 n 逐个真渲染取 `Buffer.byteLength`,二分求最大 `cap` 使 `bytesForCapacity(cap) ≤ 524,288`;断言 `bytesForCapacity(cap) ≤ 524,288`,且(cap < 搜索上界 200 时)`bytesForCapacity(cap + 1) > 524,288`;cap 触顶上界 ⇒ 记「≥ 200」,不断言 `cap+1`;断言 **`cap ≥ 60`**;基础页余量:`bytesForCapacity(60) ≤ 491,520`(480KiB 软线)。
- attention 复测:在同一 `pageForBudget(cap)` 上放入 #1147 上限条数的 attention 候选,调真 `applyAttentionBudget`;因为 prefix(0) 的可容纳性已由 `bytesForCapacity(cap)` 构造保证,预算器必不抛;断言结果 HTML ≤ 524,288、attention 按整行截断、页面带「体积上限,部分事项未显示」。`cap` 的含义 = **带最小截断警告的条件容量**;confirmed-empty attention 的页更小,不另测。
- 多 role notes 的 fail-closed 边界测试:`pageForBudget(cap)` 上给一张 issue 塞 50 条不同 role 的 note 直到超限 ⇒ `publishHosted` 返回 `structural: epic_html_too_large`(✅ `epic-page-publisher.ts:60-62`),固定页停在上一版,**不截断 note、不发坏页**。
- 记录进 evidence:`cap`、`bytes(cap)`、`bytes(cap+1)`、`bytes(60)`、E1 冻结快照重放字节(✅ 本单已复现基线 469,843 B)。
- 若 `cap < 60`,按序执行、每级重新搜索并写进 evidence:
  - L1(不损出处):去掉审计格里重复的标签外壳(标签改 `data-label` 由 CSS 显示)、`source_updated_at === observed_at` 时省略「源」段、`audit-head` 机器原话只保留 `ledger_live_count` 与 latest 会话;
  - L2(不损出处):lead-panel 内派生格的 `from` 指针以 `<details>` 折叠但仍逐条输出(字节不省,只省首屏)—— **不算压缩**,列出是为了说明它不能用;
  - L3(需 Lead 同意,改一条既有测试):lead-panel 内派生格的 `from` 指针用区间写法(`/items/0..N/state`)并把 `render.test.ts:440-445` 改为按区间解析核对;⛔ 不删任何 `data-cell`、不删任何 `observed_at`。

## 4. 迁移与回滚

| 项 | 内容 |
|---|---|
| 数据迁移 | **无**。文档、回执、`source_digest` 不变;`epic_page` 表不存 HTML(✅ E1 plan §4)。 |
| 首次上线 | 下一次刷新固定页换形;同 token;`last_version` 前进。 |
| 回滚 | `git revert` 整个 PR ⇒ 下一次刷新回旧形;无残留。 |
| 回滚边界 | 与 #1147 / #1148 的 render 插入点耦合;revert E3 后它们回到各自合入时的旧骨架位置,其测试在旧骨架下本来就绿(#1148 那一条期望文本随 revert 一起回退)。 |
| 部署 | 独立 updater 窗口;本单不重启。 |

## 5. 负向守卫(每条必须有测试)

| # | 条件 | 行为 | 测试 |
|---|---|---|---|
| G1 | root 全部子单终态(counts 非缺,open=0) | 无 `details.epic[data-root=它]`、无它的投影行;`epic-hidden` +1;可见 `data-root` 集合 == open roots;attention / 徽标 / Lead 面板可合法提及它 | C3 / C4 |
| G2 | `root_counts[i]` 缺 | Epic 照列;`counts.missing`;`allWaitingOn` 不判;未知类型子单徽标 `child.unknown_type` | C3 / C4 |
| G3 | item `parent` 缺,或 parent 链任意深度到达 null | 进 `unattached`;不进任何 Epic;不抛;`computeRootCounts` 行为不变 | C1 / C3 |
| G4 | blocker `in_scope=true` 但不在 items | 当 `outside`,不抛 | C3 |
| G5 | 任何已列子单(不限 cls)`run / attempt / session` 任一 statestore_error | `progress.missing` 列 reason;`view.from` 仍为五格 | C3 / C4 |
| G6 | live 子单 `run.value` 空 | `progress.live_no_run` | C3 |
| G7a | 同一文档同 `now` 两次渲染 | HTML `toBe` | C4 |
| G7b | 两份按 UUID 同步重排的 raw snapshot 各自生成 | 语义视图相等;`data-root` / `data-item` 序相同 | C3 |
| G7c | identifier 混合合法 / 不合法 / 大小写 / 前导零 | 全部排列排序结果相同 | C3 |
| G8 | 标题 / blocker identifier 含 HTML 或 `javascript:` URL | 转义;`href` 无 `javascript:` | C4 |
| G9 | 首屏 | 无 `<details open>`;attention 在最前且不在 details 内 | C4 |
| G10 | 最终模型预算 fixture(8 root、每 issue ≤ 1 note、最小截断警告页) | 离散搜索 `cap ≥ 60`;`cap < 200` 时 `bytesForCapacity(cap+1) > limit`,触顶只报「≥ 200」;`bytesForCapacity(60) ≤ 480KiB`;同一 cap 上 attention 经 #1147 预算器整行截断后 ≤ limit 且不抛;多 role notes 超限 ⇒ `epic_html_too_large` 不发布 | C5 |
| G11 | `scopeUnavailable` | 视图为 unavailable 分支(`order` / `hiddenDoneEpics` 为 null);页面仅 attention + 最小 header + freshness,无 `epic-hidden`、无 `view.order.v1` 行;#1147 负向断言全过 | C3 / C4 |
| G12 | `epics.length===0` 且范围可用 | `epic.none` | C4 |
| G13 | `computeRootCounts` 重构 | E1 全部 golden / scope-v2 37 条不改全绿;错误优先级与文案逐条相同 | C1 |
| G14 | `data-cell` 覆盖与唯一 | 8 根格 + 每已列子单 15 格 + 每 Epic 1 格(`root_counts/N`),每路径恰一次 | C4 |
| G15 | 展示规则出处 | 六种 `ViewProvenance` 每条 `from` 无通配、`resolvePointer` 到 Cell;`observedAt` 按 `Date.parse` 最大 + 原串 tie-break;`data-view-*` 与视图一致 | C3 / C4 |
| G16 | HTML 超限 | 既有 `structural: epic_html_too_large`(`epic-page-publisher.ts:60-62` ✅)不动 | 既有测试 |

## 6. 测试计划(TDD,先红后绿)

顺序 S1 → S2 → S3 → S4。每切片先写红测试,再最小实现,切片末尾 typecheck 绿。

```bash
pnpm --filter flywheel-teamlead list --depth -1                 # 必须打印 flywheel-teamlead
pnpm --filter 'flywheel-teamlead^...' build                     # typecheck 前置(E1 evidence)
pnpm --filter flywheel-teamlead exec vitest run src/epic-page   # 聚焦(⛔ 不用 test:run -- <path>)
pnpm --filter flywheel-teamlead exec vitest run src/epic-page src/bridge/__tests__/epic-page-route.test.ts src/__tests__/epic-page-publisher.test.ts src/__tests__/statestore-epic-page.test.ts
pnpm --filter flywheel-teamlead typecheck
pnpm lint
```

整包与全仓门禁以 exact-head CI 为准;本地全仓跑必须排除 `**/tmux-viewer.macos.test.ts`,并在 evidence 写明。Codex 代码评审照常。

## 7. 验收证据(QA 节点;报告按 ship report 骨架,**零表格**)

1. **Epic 集合 == Linear**:`epic-page render --out <html>` 与同刻 `show --format json`;页面 `data-root` 集合 == JSON `header.roots.value[]` 中 `root_counts[i].counts` 有未终态者;再与 Linear `state.type=started` 且有子单的父单对账(E1 plan §7 的同构递归查询,QA 当日实数)。全做完 root 数 == `epic-hidden` 的数;对每个全做完 root:`grep -c 'data-root="<id>"' <html>` == 0 且无其投影行(`data-source-value="/header/roots/value/<i>"`);报告写明 attention / 依赖徽标 / Lead 面板出处格若提及它属合法引用。
2. **子单集合 == Linear children**:任取一个 Epic,`data-item` 集合 ∪ 尾行数 == 该 Epic 在 Linear 的全部后代;逐张徽标与 Linear state / blocker state 对得上。
3. **顺序稳定**:同一份文档渲染两次 `cmp` 相同;`data-root` 序 == identifier 数值序。
4. **依赖徽标**:生产若无被挡子单,用 V3 fixture 单测截图为证(四种);有则同时贴生产例。
5. **首屏零展开**:`grep -c '<details[^>]* open' <html>` == 0;attention 区在最前。
6. **HTML ≤ 512KB**:`render` 的 `bytes`、离散搜索的 `cap / bytes(cap) / bytes(cap+1) / bytes(60)`,都写进报告,并写明支持边界(每 issue ≤ 1 条 lead_note)。
7. **固定页**:`epic-page status` `last_version` 前进;真机手机宽截图(收起态 + 展开一张 Epic)由 QA 出。
8. **零人名**:按 PRD 样子稿方法(`build-progress-page.py:271-284` ✅)剥掉 Linear 数据串后 grep,页面自身文案零命中。
9. **回归**:`show --format json` 的 `root_counts` 与合入前同输入逐字段相同;scope-v2 37 条全绿输出。
10. **sibling 不回归**:#1147 attention 用例、#1148 lead-note 用例在 E3 头上全绿(命令输出)。

## 8. 诚实边界

- 本单只改 HTML。Markdown 不变;md 排成 Epic 树是另一张单。
- 不做留言层(PRD G4 / T4);结构留位。
- 不做 Discord 跳转、不做 Lead 判断格:它们通过插槽进入;**E3 implement 必须等 #1147 / #1148 合入**。插槽接口按它们 PR 当前 diff 与测试写,若评审后改了签名,implement 按合入版本接;唯一允许改的 sibling 断言是 §3 C4 写明的那一条期望文本。
- 终态子单的 15 格出处 HTML 里不再出现(只在 JSON / Markdown);HTML 是文档的子集。
- 页面级结论(整块在等 / blocker 归属 / 进度行 / 顺序)是**展示投影**,不是文档事实:它们带页面展示规则号、输入格路径与输入最新观测时间,但不进文档合同、不进回执、不受 `assertEpicPage` 重算保护;若 founder / Lead 认定其中某条是业务事实(例如要在 Linear 里对账「整块在等」),那要先由数据层加 Cell + 规则号,再由渲染层消费,不在本单。
- 「整块在等」按 Epic 级(含 backlog 子单)判,与 Lead 诊断里范围级、只看可排期子单的 `all_blocked` 是两个定义域。
- 跨 Epic 判法比 issue 原文宽(`in_scope=true` 但归属不同 root 也标);若只要 `in_scope=false` 一种,去掉 `other_epic` 分支即可。
- **容量不承诺具体张数**:以最终模型离散实测定 `cap`,门槛是 ≥ 60 张未终态子单(今天 18);**容量是「每 issue ≤ 1 条 lead_note」条件下的数**,#1148 没有 note 数量上限,超出时页面走既有 fail-closed(`epic_html_too_large`,固定页停上一版),不截断也不发坏页;`EPIC_PAGE_MAX_HTML_BYTES` 不动。
- `resolvePointer` 从 `model.ts` 导出是本单对 `model.ts` 的唯一改动(纯导出,不改行为)。
- 分组键按 Linear `state.type`,今天恒为单组。
- 不改 `page.title`。
