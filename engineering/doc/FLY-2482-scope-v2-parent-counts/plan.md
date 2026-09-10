# FLY-2482 取数层 scope.v2 + items[].parent + roots[].counts — 实施计划
Issue: FLY-2482 (https://linear.app/geoforge3d/issue/FLY-2482/进度页e1前置-取数层-scopev2不再丢-backlog-子单-itemsparent-rootscounts洞-eab)
日期: 2026-09-09
基于: research.md

> 版本:**v3**(2026-09-09;**Codex 设计评审 R3 APPROVED**;Codex R2 四条全部采纳:§7 生产回归断言改为逐字段判定(blocker 可为 backlog 但 `in_scope:false`);QA 查询补 `inverseRelations.pageInfo` 并用 `ACTIVE_SCOPE_RELATIONS_QUERY` 翻页到底;分块改为四个**编译切片**,typecheck 只在切片末尾要求绿;Linear `state` 格改为校验器要求非 null,删掉 counts 的 state-null 降级路径)。
> v2(2026-09-09,Codex R1 六条全部采纳:回归域补齐 subtraction 边 `in_scope` 与 signals.v1 两处漏口并把「不变」定义为三格 `.value`;测试命令改实际包名 `flywheel-teamlead`;校验器补 roots / parent 输入形状,`computeRootCounts` 改纯函数并前移到校验器之前;QA 对账改用与引擎同构的递归查询、residual 对拍改冻结快照;fixture 期望值改正(EPX-100 基线 idle 2 / waiting 3)并拆成四种边形状;SDK 版本依据改 `@linear/sdk@60.0.0`)。
> Lead 已于 2026-09-09 书面同意四条裁定(回归域钉「非 backlog」/ counts 词汇沿 mock 且 `free` 对齐 ready.v1 / 44 卡天花板只记录不瘦身、瘦身列为 E3 候选 / 验收按 QA 当日 Linear 实数)。
> 成色:✅ 亲手核过(file:line);🔶 本单裁定。

## 0. 一句话

在 `linear-epic-query.ts` 删掉那一行 backlog 过滤、给子单查询加 `parent { id identifier }`,文档合同升 `scope.v2` 并新增 `items[].parent`(Linear 出处)与 `header.root_counts[]`(派生 `counts.v1`);同时把 ready.v1 / subtraction.v1 / signals.v1 / Lead 巡检 residual 的定义域用**一个**谓词 `isSchedulable` 钉在「非 backlog」,使 `ready_items.value` / `dependency_review.value` / `stuck_items.value` 对同一份 Linear + StateStore 输入逐字节不变。零表迁移、零 schema_version 升级、渲染层只改两处规则号常量与一条文案。

## 1. 稳定身份与显示标签

| 类别 | 标识 | 说明 |
|---|---|---|
| 规则号 | `scope.v2` | 替换 `scope.v1`;`RULE_IDS` 不再含 v1(任何仍写 v1 的路径被校验器拒绝 = fail-loud) |
| 规则号 | `counts.v1` | 新;`header.root_counts[i].provenance.rule` |
| 谓词 | `isSchedulable(item)` | `rules.ts` 导出;`= item.state.value.type !== "backlog"`(校验器保证每张 item 的 `state.value` 非 null,见 §2.2);ready.v1 / subtraction.v1 / signals.v1 / residual 四处唯一引用点 |
| 「不变」的定义 | `ready_items.value`、`dependency_review.value`、`stuck_items.value` 三者的 `canonicalJsonString` | 只比 `.value`;`provenance.from` 是按 item 下标的指针,items 变多后指针必然变,不在「不变」范围 |
| 缺失原因 | `no_parent` | `items[].parent` 值 null 时;`parent` 格**只允许**这一种缺失原因 |
| 缺失原因 | `unknown_state_type` | `root_counts[i]` 遇到六种之外的 `state.type`;`detail` = 该 type |
| gaps face | `parent` | `computeGaps` 新面;对应 `items[].parent` |
| 快照错误 | `EpicSnapshotTruncatedError("Child parent drifted during snapshot: <identifier>")` | 已有类,已映射 token `structural: scope_snapshot_truncated`(`epic-page-refresher.ts:85-86` ✅) |
| 文档错误 | `EpicPageSchemaError` | parent 链走不到根 / 链成环 / root_counts 重算不符 / 形状不合 ⇒ 已有 token `structural: epic_page_invalid` |
| 出处字段 | `header.items.provenance.field = "subtree"` | 原 `"subtree,state.type!=backlog"` |
| 出处字段 | `items[].parent.provenance = { kind:"linear", entity:"issue", id:<child uuid>, field:"parent", url }` | `id` 必须等于同一 item `title.provenance.id`(校验器核) |
| subtraction 边的 `in_scope` | `blocker ∈ isSchedulable 的 identifier 集合` | **不再抄** `blocked_by[].in_scope`;定义域内的「范围」就是可排期集合 |
| 显示文案 | `labels.ts` `page.scope_rule_note` = `已获 founder 裁定的规则 scope.v2` | 唯一文案改动 |
| 已裁定规则集 | `FOUNDER_DECIDED_RULES = {scope.v2, ready.v1, dependents.v1, counts.v1}` | `render-html.ts:13-17` / `render-markdown.ts:13-17` 两处同改 |
| 包名 / 命令 | `pnpm --filter flywheel-teamlead test:run` / `typecheck`;根 `pnpm lint` | 包名是 `flywheel-teamlead`(`packages/teamlead/package.json:2` ✅);`--filter teamlead` 匹配零项目且 exit 0 |
| 依赖 | `@linear/sdk@60.0.0`(`packages/teamlead/package.json:67` ✅) | 60.0.0 生成类型含 `Issue.parent`(`_generated_documents.d.ts:6144-6145` ✅) |
| 不变 | `schema_version: 1`、`generator.version: "epic-page/1"`、`EPIC_PAGE_MAX_HTML_BYTES`、`MAX_EPIC_SCOPE_ITEMS`、`daily_title_contains: "日常"`、`descendantIds` 语义、`items[].signals`(每张 item 自己的信号照存) | 无存量文档(`epic_page` 表只存回执 ✅),语义版本已由 `scope.v2` 承载 |

## 2. 数据模型

### 2.1 快照(`LinearActiveScopeSnapshot.items[]`,`linear-epic-query.ts:41-59`)

```ts
parent: { id: string; identifier: string } | null;   // 新增;Linear issue.parent 原话
```

### 2.2 文档(`model.ts`)

```ts
// EpicItem 新增
parent: Cell<string>;                                  // 值 = 父单 identifier

// header
scope_definition: Cell<{ root_state_type: "started"; daily_title_contains: "日常"; item_state_filter: "none" }>;
root_counts: Array<Cell<RootCounts>>;                  // 与 header.roots.value 同序同长

export interface RootCounts {
  root: string;                                        // = header.roots.value[i].identifier
  counts: { live: number; waiting: number; free: number; idle: number; done: number; canceled: number; total: number };
}
```

`RULE_IDS`:`scope.v2, ready.v1, dependents.v1, founder.v1, done.v1, gaps.v1, subtraction.v1, freshness.v1, signals.v1, counts.v1`。
`MISSING_REASONS` += `no_parent`, `unknown_state_type`。
`gaps[].face` 联合 += `"parent"`。`ITEM_CELLS` += `"parent"`。
**新增校验不变量**:每张 item 的 `state.value` 与 `blocked_by.value` 必须非 null(它们是 Linear 格,`generate.ts` 从不产生 null;今天 `computeDependencyReview` 的前置守卫 `subtraction.ts:10-20` 已经在缺失时抛错,本单把它抬成校验器的显式规则,并删除任何「state 缺失时降级」的路径)。

### 2.3 `counts.v1`:纯函数 + Cell 包装(实现与校验器共用)

```ts
// rules.ts —— 无时间戳、无 Cell,只吃文档里已有的值
export interface RootCountsResult {
  root: string;
  value: RootCounts | null;                            // null ⇔ missing
  missing?: { reason: "unknown_state_type"; detail: string };
  from: string[];                                      // provenance.from,确定序
}
export function computeRootCounts(
  items: EpicItem[],
  roots: Array<{ identifier: string }>,
): RootCountsResult[];
```

1. **归属**:对每张 item 沿 `parent.value` 走:命中 `roots[].identifier` ⇒ 归属;命中另一张 item 的 identifier ⇒ 继续;`parent.value === null` ⇒ 不归属(已在 gaps);走 > `items.length` 步(环)或指向既非 root 也非 item 的 identifier ⇒ `throw new EpicPageSchemaError("counts.v1: parent chain does not reach a root: <identifier>")`。
2. **分类**(只读 `state.value.type` 与 `blocked_by.value`):`completed`→done;`canceled`→canceled;`started`→live;`backlog|unstarted|triage`→open,open 且 `blocked_by` 为空→idle,open 且存在 `blocker_state_type !== "completed"`→waiting,否则→free;其它 type ⇒ 该根 `value: null, missing: { reason: "unknown_state_type", detail: type }`。`state.value === null` 不是合法输入(§2.2 不变量);`computeRootCounts` 遇到即 `throw new EpicPageSchemaError("counts.v1: state cell must be known: <identifier>")`,不降级。
3. `total` = 六者之和;无归属 item 的根 = 全 0。
4. `from` = `["/header/roots", ...所有 item 的 "/items/N/parent"(按 N 升序), ...归属该根的 item 的 "/items/N/state", "/items/N/blocked_by"(按 N 升序)]`;parent 指针全量,因为「谁不归属」也要读全部 parent。
5. `generate.ts` 包装:`{ value, provenance: { kind:"derived", rule:"counts.v1", from }, observed_at: generatedAt, ...(missing ? { missing } : {}) }`。
6. 校验器:对 `page.header.root_counts` 逐项 `assertCell` 后,取 `{ root: value?.root ?? <roots[i].identifier>, value, missing, from: provenance.from }` 与 `computeRootCounts(page.items, roots.value)` 的结果 `canonicalJsonString` 比对(value / missing / from 三者都比)。

### 2.4 `isSchedulable` 钉域后的四条规则

| 规则 | 定义域 | 代码位置 |
|---|---|---|
| ready.v1 | `isSchedulable ∧ 非终态 ∧ 全部 blocker completed` | `rules.ts:23-43`(行为不变,改为调用谓词) |
| subtraction.v1 | `nonTerminal` = 非终态 ∧ isSchedulable;canceled_blocker 同;环图节点 = isSchedulable 的 items,边要求 blocker 在节点集内;**`all_blocked.blocking_edges[].in_scope` = blocker identifier ∈ 节点集**(不抄 `blocked_by.in_scope`) | `subtraction.ts:22-63, 110-128` |
| signals.v1 | `stuck_items.value` 只聚合 isSchedulable 的 item 的非 `waiting_founder` 信号;`provenance.from` 只列这些 item 的信号指针与 `signal_sources` 两格;校验器的 `expectedStuck / expectedStuckPointers` 循环同样过滤 | `generate.ts:281-312`;`model.ts:893-964` |
| residual | `remainingItems` = 非终态 ∧ isSchedulable | `residual.ts:242-245` |

`dependents.v1`(`blocks`)与 `blocked_by[].in_scope` **不钉域**:backlog 单进了文档,依赖关系如实变宽(Lead 同意,不在回归清单)。`gaps.v1` / `founder_items` 同理如实变宽(backlog 单缺验收节、带 `founder-review` 标签时会出现),不在回归清单。`items[].signals` 照存每张 item 自己的信号(包括 backlog),只是不进 `stuck_items`。

## 3. 改动清单(按依赖顺序)

**编译切片**(`typecheck` 只在每个切片末尾要求绿;切片内部各块仍先红后绿):

| 切片 | 含 | 为什么合并 |
|---|---|---|
| S1 | C1 + 所有构造 `LinearActiveScopeSnapshot` 的测试 fixture 补 `parent`(`fixtures/epic-shape.ts` 的 `child()`、`linear-epic-query.test.ts` 的 `child()`、`residual.test.ts:303`、`render.test.ts:40`) | 快照类型加必填字段,构造点必须同一切片补齐 |
| S2 | C2 + C3 + C4 + C5 | `EpicItem.parent` / `header.root_counts` 成为必填后,规则、校验器、投影与页面 fixture 互相引用,拆开任一块都编译不过;整个切片是一个红绿循环:先写 C2–C5 的全部红测试,再按 C2→C3→C4→C5 的顺序实现到绿 |
| S3 | C6 | 只改常量与文案 |
| S4 | C8 | 只加测试与证据 |

### C1 · 取数:`packages/teamlead/src/bridge/linear-epic-query.ts`
- `ACTIVE_SCOPE_CHILDREN_QUERY`(`:141-160`)nodes 加 `parent { id identifier }`。
- `LinearScopeIssueNode`(`:84-101`)加 `parent: { id: string; identifier: string } | null`。
- 遍历循环(`:302-340`):每张 child 在 `rawItems.push` 前对账:`child.parent && child.parent.id !== parentId` ⇒ `throw new EpicSnapshotTruncatedError(\`Child parent drifted during snapshot: ${child.identifier}\`)`。
- `:376-378` 删过滤(`includedRawItems` 变量随之消失,`inScopeIds` 直接由 `uniqueRawItems` 算)。
- items 映射(`:380-400`)加 `parent: item.parent ? { id, identifier } : null`。
- 测试 `bridge/__tests__/linear-epic-query.test.ts`:
  - `:107-155` 改名「discovers started root subtrees, includes 日常, and keeps Backlog children」:`items == ["EPX-1","EPX-2"]`,EPX-1 的 blocker EPX-2 `inScope: true`,两张 `parent.identifier === 各自根`;fixture `child()` 默认 `parent` = 所在根。
  - 新增「represents a null Linear parent without inventing one」:`parent: null` ⇒ 快照项 `parent: null`,不抛。
  - 新增「fails closed when a child's Linear parent drifts from the traversal parent」:`parent.id = "elsewhere"` ⇒ `EpicSnapshotTruncatedError`,消息含 identifier。
  - 嵌套用例(`:157-190`)补断言:孙单 `parent.identifier` = 中间子单,不是根。

### C2 · 纯规则:`packages/teamlead/src/epic-page/rules.ts`(先于校验器,独立可编译)
- 导出 `isSchedulable`;`computeReady` 改用它(行为不变)。
- 新增 `RootCounts` / `RootCountsResult` 类型(放 `model.ts` 的类型区,`rules.ts` 只 `import type`)与 `computeRootCounts`(§2.3)。
- `computeGaps` faces 表加 `["parent","parent"]`;`RULE_IDS` 对象加 `counts: "counts.v1"`。
- 测试 `rules.test.ts` 新 `describe("counts.v1")`:七类各一张(live / waiting / free / idle / done / canceled + 第二根全 0);`free` 只认 `completed`(canceled blocker ⇒ waiting);未知 type ⇒ 整根 `value: null` + missing,其它根照算;`state.value === null` ⇒ `EpicPageSchemaError`;孙单沿链归根;链指向未知 identifier ⇒ `EpicPageSchemaError`;链成环 ⇒ `EpicPageSchemaError`;`from` 指针精确(parent 全量升序 + 成员 state/blocked_by 升序);同输入两次输出逐字节相同。
- `rules.test.ts` `ready.v1`:加「isSchedulable is the single backlog predicate」(backlog ⇒ false;unstarted / triage / started / completed / canceled ⇒ true)。

### C3 · 合同与校验:`packages/teamlead/src/epic-page/model.ts`
- 常量与类型按 §2.2。
- `assertEpicPage`:
  - header `requireExactKeys(..., ["scope_definition","roots","items","root_counts"])`。
  - `scope_definition`:`assertCellValueShape(..., ["root_state_type","daily_title_contains","item_state_filter"])`,三个字面值 `"started"` / `"日常"` / `"none"`,`provenance.rule === "scope.v2"`,`value` 不得为 null。
  - `roots`:`value` 必须是数组(不得 null);每项 `requireExactKeys(["identifier","title","url","state"])`,`identifier/title/url` 非空字符串,`state` 形状 `{name,type}`;identifier 在 roots 内唯一,且与 `items[].identifier` 无交集。
  - 每张 item 的 `state.value` 与 `blocked_by.value` 非 null(否则拒绝;错误路径稳定为 `EpicPageSchemaError`,不是原生 TypeError)。
  - 每张 item 的 `parent`:`value` 为非空字符串或 null;null 时 `missing.reason === "no_parent"`;`provenance` 必须 `{ kind:"linear", entity:"issue", field:"parent" }` 且 `provenance.id === item.title.provenance.id`。
  - `root_counts`:必须为数组、长度 === `roots.value.length`;逐项 `assertCell`;provenance 必须 `derived counts.v1`;value 非 null 时 `requireExactKeys(value, ["root","counts"])`、`root === roots.value[i].identifier`、`counts` `requireExactKeys` 七键、每个 `requireNonNegativeInteger`、`total === 六者之和`;missing 时 reason 必须 `unknown_state_type`;最后按 §2.3 第 6 条与 `computeRootCounts` 重算比对。
  - signals.v1 重算循环(`:893-964`)只遍历 `isSchedulable` 的 item(value 与 pointers 同)。
  - gaps faces 表(`:934-975`)加 `["parent","parent"]`。
- 测试 `model.test.ts`:fixture(`:120-127`)改 v2 + `root_counts` + item `parent`;新增负向:`scope.v1` 被拒(`unknown derived rule`)、`excluded_item_state_type` 键被拒、`item_state_filter: "backlog"` 被拒、缺 `root_counts` 被拒、长度不等被拒、`root` 与 roots 错位被拒、`total` ≠ 和被拒、篡改某根一个计数被拒(重算不符)、`roots.value` 为 null 被拒、roots identifier 重复被拒、root identifier 与 item identifier 碰撞被拒、`parent.value` 为数字被拒、`parent` missing 原因写 `statestore_error` 被拒、`parent.provenance.id` 与 `title.provenance.id` 不同被拒、`no_parent` 缺 gaps 被拒、backlog item 的信号出现在 `stuck_items` 被拒(重算不符)、`state.value` / `blocked_by.value` 为 null 被拒(table-driven,两个字段各一行,`EpicPageSchemaError`;Codex R3 非阻塞提示)、正向:未知 `state.type` 的 item 只令所属根的 `root_counts[i]` missing,整页通过 `assertEpicPage`。

### C4 · 域钉死:`subtraction.ts` / `residual.ts` / `generate.ts` 的 stuck 聚合
- `subtraction.ts`:`nonTerminal`、canceled_blocker、环图节点/边、`blocking_edges[].in_scope` 按 §2.4。
- `residual.ts:242-245`:加 `isSchedulable`。
- `generate.ts:281-312`:`stuckItems` / `stuckPointers` 只遍历 `isSchedulable` 的 item。
- 测试:
  - `rules.test.ts` `subtraction.v1`:「backlog items do not enter non_terminal, canceled_blocker, or cycles」(backlog↔backlog 互挡不报环;backlog 被 canceled 挡不报);「a schedulable item blocked by a backlog item yields the same all_blocked edge as when the blocker was outside the document」:两张 item(A unstarted ← B backlog)⇒ `all_blocked { non_terminal: 1, blocking_edges: [{ blocker: B, blocked: A, blocker_state_type: "backlog", in_scope: false }] }`,与仅含 A、blocker B `in_scope:false` 的输入逐字节相同。
  - `residual.test.ts`:「backlog children change nothing in the residual fact」(v2 fixture 八计数与 `:35-66` 完全相同,运行于**同一份**冻结快照与 facts);「an unreadable session on a backlog child does not fail the residual」。
  - `generate.test.ts`:见 C5 回归条。

### C5 · 投影:`generate.ts` + fixture + golden
- 按 research §2.2 逐行改;`header.root_counts = computeRootCounts(items, snapshot.roots).map(wrap)`。
- fixture `fixtures/epic-shape.ts`(5 张的 `parent: { id: "epic-uuid", identifier: "EPX-100" }` 已在 S1 补):新增 `epicShapeSnapshotV2()`,在 v1 之上追加四种边形状:
  - `EPX-6` backlog,归 EPX-100,被**范围外** completed 的 `EPX-90` 挡(`inScope:false`)⇒ free;
  - `EPX-7` backlog,归 EPX-200「日常」,无依赖 ⇒ idle;配套 `itemSignals` 给它一条 `question_pending`(commdb)信号;
  - `EPX-8` backlog,归 EPX-100,被 EPX-6 挡(backlog 挡 backlog)⇒ waiting;
  - `EPX-9` unstarted(可排期),归 EPX-100,被 EPX-7 挡(backlog 挡可排期)⇒ waiting;
  - 导出 `filterV1(snapshot)`:去掉 backlog 并按剩余集合重算 `inScope`(= 旧取数层的行为),供回归对拍。
- 测试 `generate.test.ts`:
  - golden(`:47-117`)补:每张 `parent` Cell 形状;`root_counts` = `[EPX-100: {idle 2, waiting 3, free 0, live 0, done 0, canceled 0, total 5}, EPX-200: 全 0]`;`scope_definition` 新值与 `scope.v2`;`header.items.provenance.field === "subtree"`。
  - v2 fixture golden:`root_counts` = `[EPX-100: {idle 2, waiting 5, free 1, total 8}, EPX-200: {idle 1, total 1}]`;`EPX-9.blocked_by[0].in_scope === true`;`EPX-7.blocks.value` 含 EPX-9、`EPX-6.blocks.value` 含 EPX-8(dependents.v1 变宽);`EPX-7.signals.length === 1` 而 `stuck_items.value` 为空;`ready_items.value` 不含 EPX-6/7/8/9。
  - 回归(同一份原始快照与同一份 facts/signals):`generate(v2)` 与 `generate(filterV1(v2))` 的 `ready_items.value`、`stuck_items.value`、`dependency_review.value` `canonicalJsonString` 相等;`header.items.value` 前者多且仅多 EPX-6/7/8。
  - `parent: null` 的快照项 ⇒ item `parent` missing `no_parent`、gaps 含 `{item, face:"parent", reason:"no_parent"}`、不归任何根。
- `drill.test.ts` / `statestore-epic-page.test.ts` / `epic-page-route.test.ts` / `epic-residual-scan.test.ts` / `epic-page-refresher.test.ts` 经 fixture 变更预期零改动 —— 全跑一遍确认;`typecheck` 抓漏掉的快照构造点。

### C6 · 渲染层最小改动
- `render-html.ts:13-17`、`render-markdown.ts:13-17`:`scope.v1`→`scope.v2`,加 `counts.v1`。
- `labels.ts:24`:文案 `scope.v2`。
- `render.test.ts`:加断言 HTML/MD 含新文案且不含 `scope.v1`;`derivedRuleNote` 对 `counts.v1` 输出「已获 founder 裁定」。
- ⛔ 不加卡片、不加 `itemCells` 条目、不改排序/attention。

### C7 · PRD F3 残留(✅ 已在设计提交完成)
`product/doc/FLY-2457-founder-progress-page/prd.md:101` F3 行改为指向 §6.2 已裁定结论。实现 PR 不再动它。

### C8 · 容量复测与证据
- 用 `epicShapeSnapshotV2()` 复制到 200 张(每张带 parent、6 根)生成文档,记录 `canonicalJsonString` 字节;若 > `EPIC_PAGE_MAX_DOCUMENT_BYTES`(1,507,328)则按既有「实测 200 张再取 64KB 整数倍」规则上调常量并同步 `model.test.ts:566-568` —— 不是拍脑袋改数。
- 生产验证命令见 §7。

## 4. 迁移与回滚

| 项 | 内容 |
|---|---|
| 数据迁移 | **无**。`epic_page` 只存回执 + digest(`packages/teamlead/src/StateStore.ts:6947-6956` ✅),文档每次现算。 |
| 首次刷新 | `sources` 多出 `/items/N/parent` ⇒ `source_digest` 变 ⇒ 新版本、固定页重发布(同 token,`reserveEpicPageToken` 复用 ✅)。正常的一次版本推进。 |
| 回滚(代码) | `git revert` 整个 PR;无表、无常量文件残留;固定页下一次刷新回到 v1 形状。 |
| 回滚边界 | F2/F9/F10 渲染单开始读 `parent` / `root_counts` 后,回滚需与它们一起裁;本单单独可回滚。 |
| 部署 | 走独立 updater 窗口;本单不重启服务。 |

## 5. 负向守卫(每条必须有测试)

| # | 条件 | 行为 | 测试位置 |
|---|---|---|---|
| G1 | Linear 返回 `parent: null` | 快照 `parent: null` → item Cell `no_parent` + gaps face parent;不抛 | C1 / C5 |
| G2 | Linear `parent.id` ≠ 遍历父 id | `EpicSnapshotTruncatedError`,本轮不出页 | C1 |
| G3 | 文档里 parent 指向既非 root 也非 item 的 identifier | `EpicPageSchemaError` | C2 |
| G4 | parent 链成环 | 同 G3 | C2 |
| G5 | `state.type` 未知 | 该根 `root_counts[i]` missing `unknown_state_type`;其它根正常;整页仍通过校验 | C2 / C3 |
| G5b | `state.value` 或 `blocked_by.value` 为 null | 校验拒绝(`EpicPageSchemaError`);`computeRootCounts` 同样抛 | C2 / C3 |
| G6 | `root_counts` 长度或 `root` 顺序与 `roots` 不符 | 校验拒绝 | C3 |
| G7 | 任一计数非整数/负数,或 `total` ≠ 和 | 校验拒绝 | C3 |
| G8 | 任何格标 `scope.v1` | `unknown derived rule` 拒绝 | C3 |
| G9 | `scope_definition` 出现 `excluded_item_state_type` 或 `item_state_filter !== "none"` | 拒绝 | C3 |
| G10 | backlog item 出现在 `ready_items` | 重算不符,拒绝 | C3(已有 ready 重算) |
| G11 | `root_counts` 某根被篡改一个数 | 重算不符,拒绝 | C3 |
| G12 | `item.parent` missing 但 gaps 无对应条目 | 拒绝 | C3 |
| G13 | backlog 子单 session 格不可读 | residual **不**抛(它不在 remaining) | C4 |
| G14 | 可排期子单被 backlog 子单挡 | `blocked_by.in_scope === true`(文档层);ready.v1 不列它;subtraction 边 `in_scope: false`(定义域层)⇒ `dependency_review.value` 与 v1 逐字节相同 | C4 / C5 |
| G15 | backlog 子单带活信号 | `items[].signals` 照存;`stuck_items.value` 不含它;校验器重算一致 | C3 / C5 |
| G16 | `roots.value` null / identifier 重复 / 与 item identifier 碰撞 | 拒绝 | C3 |
| G17 | `parent` 值非字符串 / 缺失原因不是 `no_parent` / 出处 id 与本 item 不符 | 拒绝 | C3 |
| G18 | HTML > 512KB | 既有 `structural: epic_html_too_large`,固定页停上一版 | 已有测试,不动 |

## 6. 测试计划(TDD,先红后绿)

顺序 S1 → S2 → S3 → S4(见 §3 切片表)。每个切片先写红测试,再最小实现,切片末尾 `typecheck` 绿。

```bash
pnpm --filter flywheel-teamlead list --depth -1          # 必须打印 flywheel-teamlead,否则过滤器写错
pnpm --filter flywheel-teamlead test:run -- src/epic-page src/bridge/__tests__/linear-epic-query.test.ts
pnpm --filter flywheel-teamlead test:run                 # 整包
pnpm --filter flywheel-teamlead typecheck
pnpm lint
```

Codex 代码评审(PR 建立后自动触发)照常。

## 7. 验收证据(QA 节点要拿到的;报告按 ship report 骨架,**零表格**)

1. **子单总数对账**(QA 当日,不写死 28):
   - 新页:`flywheel-comm epic-page show --project flywheel --format json | jq '.result.document.items | length'`;
   - Linear:用与引擎**同构**的递归查询(不是每根一次直接 children):对 `header.roots.value[].identifier` 每个根,`issue(id){ children(first:50, after, includeArchived:false){ nodes{ id identifier parent{identifier} state{type} inverseRelations(first:25){ nodes{ type issue{identifier state{type}} } pageInfo{hasNextPage endCursor} } children(first:1){ nodes{id} pageInfo{hasNextPage} } } pageInfo{hasNextPage endCursor} } }`,children 翻页到底;每张子单若 `inverseRelations.pageInfo.hasNextPage`,用引擎同款 `ACTIVE_SCOPE_RELATIONS_QUERY`(`linear-epic-query.ts:162-171`)按 `endCursor` 翻到底,只保留 `type === "blocks"`;凡 `children.nodes` 非空或 `hasNextPage` 的子单再递归,汇成「全部后代」名单(Linear key 在 Bridge 进程环境,QA 经 Lead 取用);
   - `items | length` == 全部后代数;逐张 `parent.value` == Linear `parent.identifier`(不只抽样,jq 一行比对)。
2. **counts 对账**:用上一步拿到的后代名单(含 `state.type` 与 `blocks` 型 inverseRelations 的 blocker state)按 §2.3 分类,每个根六个数与 `root_counts[i].counts` 逐个相等,`total` = 后代数。
3. **回归**:
   - 单测:C5 的同快照 v1/v2 对拍与 C4 的 residual 冻结快照对拍全绿(命令输出贴报告);
   - 生产(逐字段,与 G14 合同一致):`ready_items.value` 不含任何 backlog item;`stuck_items.value[].item` 不是 backlog;`dependency_review.value` 里 `canceled_blocker.item`、`dependency_cycle.members[]`、`all_blocked.blocking_edges[].blocked` 都是可排期 item,`blocking_edges[].blocker` **可以**是 backlog 单但此时必须 `in_scope: false`;上线后第一封 `[patrol_tick]` 的「范围内 N 张未完成」等于时间上最近一份 show 文档中 `isSchedulable ∧ 非终态` 的 item 数(两者 generated_at 相差 > 一个刷新周期时,报告如实写明并以单测为准)。
4. **HTML**:`flywheel-comm epic-page render --project flywheel --out /tmp/epic.html` 打印的 `bytes` ≤ 524,288,并把该数字写进报告(设计期估 363–445KB)。
5. **单测**:§6 全部命令的输出。
6. **固定页**:`epic-page status` 显示 `last_version` 前进。

## 8. 诚实边界

- 本单**不**渲染 `parent` / `root_counts`(F2/F9 渲染单的事);它们今天只在 `show --format json/md` 的原始 JSON 与回执里可见。
- HTML 天花板 ≈ 45 张卡(`(524,288 − 36,099) / 10,718`);超过即固定页停更并留 `structural: epic_html_too_large`。瘦身不在本单,**列为 E3 候选后续**(Lead 2026-09-09)。
- `dependents.v1`、`blocked_by.in_scope`、`gaps.v1`、`founder_items` 会如实变宽;不在验收回归清单,由 C5 golden 固定新形状。
- backlog 子单自己的 `signals[]` 照存但不进 `stuck_items`:一张被挪回 backlog 的单若还有 14 天窗口内的停机信号,Lead 巡检不会看到它 —— 与 v1 完全一致,是本单刻意保持的;要把它们抬进巡检是另一张单。
- 「Linear 返回 null parent」在正常运行里几乎不会发生(子单是从父单的 children 里取到的);守卫存在是为了不静默,不是预期路径。
- 设计期无法数出 FLY-2481 名下的 backlog 子单数(Bridge issues 路由不返回 parent,本机无 Linear key);预算区间按 32–40 张估,QA 记实数。
- 不动 attention、排序、`daily_title_contains`、`descendantIds`、StateStore、CLI。
