# FLY-2482 取数层 scope.v2 + parent + counts — 调研
Issue: FLY-2482 (https://linear.app/geoforge3d/issue/FLY-2482/进度页e1前置-取数层-scopev2不再丢-backlog-子单-itemsparent-rootscounts洞-eab)
日期: 2026-09-09
基于: exploration.md

> 成色:✅ 本单亲手核过(file:line / 命令输出);🔶 本单裁定,可推翻。

## 1. Linear 侧:`parent` 一个字段就够,没有分页、没有第二次请求

| 事实 | 出处 |
|---|---|
| GraphQL `Issue.parent: Issue`(「The parent of the issue」) | teamlead 锁定 `@linear/sdk@60.0.0`(`packages/teamlead/package.json:67`、`pnpm-lock.yaml:455-459` ✅),其 `dist/_generated_documents.d.ts:6144-6145` 声明 `parent?: Maybe<Issue>` ✅(主仓 `node_modules/.pnpm/@linear+sdk@60.0.0`;64.0.0 也在 store 里但不是本包依赖) |
| 子单是用 `client.client.rawRequest(ACTIVE_SCOPE_CHILDREN_QUERY)` 裸查的 | `linear-epic-query.ts:141-160, 213` ✅ ⇒ 加字段 = 改查询字符串 + `LinearScopeIssueNode` 接口,不经 SDK 的 typed getter |
| `parent` 是单对象,不是 connection | 无 `pageInfo`,不需要新的 `EpicSnapshotTruncatedError` 分支 |
| 遍历已经知道父 id(`queuedParents.shift()` 得到 `parentId`) | `:280-288` ✅ ⇒ 可与 Linear 返回的 `parent.id` **对账** |

查询改法(只加一行):

```graphql
children(first: 50, after: $after, includeArchived: false) {
  nodes {
    id identifier title description url priority updatedAt
    parent { id identifier }
    state { name type }
    ...
```

`LinearActiveScopeSnapshot.items[]` 新增 `parent: { id: string; identifier: string } | null`。

### 1.1 对账规则(fail-closed,不猜)

| Linear 返回 | 遍历上下文 | 处理 |
|---|---|---|
| `parent.id === parentId` | 一致 | 正常;`parent.identifier` 进 Cell |
| `parent === null` | 从 `issue(id: parentId).children` 拿到的 | 只可能是两次请求之间被挪走 ⇒ 快照项 `parent: null` ⇒ 文档 Cell `missing: { reason: "no_parent" }` + `gaps` face `parent`;**不抛**(PRD §6.1「缺失显式缺」) |
| `parent.id !== parentId` | 不一致 | 快照不自洽(挪到别的父单下)⇒ 抛 `EpicSnapshotTruncatedError("Child parent drifted during snapshot: <identifier>")`,复用 token `structural: scope_snapshot_truncated`(`epic-page-refresher.ts:85-86` ✅ 已映射),等下一次刷新 |

🔶 为什么 null 不抛而 drift 抛:null 仍是一张**在范围内**的单,只是「不知道挂谁」,页面可以如实显示「没挂 Epic」;drift 则意味着我们可能把它算进错的父单,宁可这一轮不出页。

## 2. 去掉过滤后各消费者的精确影响

### 2.1 `linear-epic-query.ts`(取数)

- `:376-378` 删过滤;`includedRawItems` ⇒ 直接用 `uniqueRawItems`。
- `:379` `inScopeIds` 随之覆盖全子树 ⇒ `blockedBy[].inScope` 对 backlog blocker 变 true。
- `:405` `descendantIds` **本来就是**全子树,不动;`dependency-route.ts:813/913/1436` 的范围判定语义不变 ✅。
- `maxItems = 500`(`:174`)与 `MAX_EPIC_SCOPE_ITEMS = 500`(`materialize.ts:11`)不动:今天 ~32–40 张,远低于上限。
- 每张子单要读 6 格 StateStore 事实 + 信号(`materialize.ts:57-71`);backlog 单多 11–20 次本地 SQLite 读,毫秒级,不需要新预算。

### 2.2 `generate.ts`(投影)

| 行 | 改动 |
|---|---|
| `:380-392` | `scope_definition.value = { root_state_type: "started", daily_title_contains: "日常", item_state_filter: "none" }`,`rule: "scope.v2"` |
| `:409-416` | `header.items` 出处 `field: "subtree"` |
| item 映射(`:130-215`) | 新增 `parent` Cell:有值 ⇒ `linearCell(parent.identifier, { entity: "issue", id: child.id, field: "parent", url })`;null ⇒ 同出处 + `value: null, missing: { reason: "no_parent" }` |
| `:216-238` dependents.v1 | 不改代码;backlog 依赖方自然进入 `blocks`(如实变宽) |
| `:257-268` gaps | `computeGaps` 的 faces 表加 `["parent", "parent"]` |
| `:297-345` `sourceCells` | 每张 item 加 `/items/N/parent`(freshness.v1 的「最旧来源」要看得到它) |
| header | 新增 `root_counts: computeRootCounts(...)`(见 §3) |

### 2.3 `model.ts`(合同与校验)

| 位置 | 改动 |
|---|---|
| `:13-23` `RULE_IDS` | `scope.v1` → `scope.v2`;新增 `counts.v1` |
| `:25-36` `MISSING_REASONS` | 新增 `no_parent`、`unknown_state_type` |
| `:121-166` `EpicItem` | 新增 `parent: Cell<string>` |
| `:176-192` `EpicPage.header` | `scope_definition` 字面类型改;新增 `root_counts: Array<Cell<RootCounts>>` |
| `:193-207` `gaps.face` 联合 | 加 `"parent"` |
| `:716-733` `ITEM_CELLS` | 加 `"parent"`(逐格 `assertCell`) |
| `:786-795` header 校验 | `requireExactKeys(header, ["scope_definition","roots","items","root_counts"])`;`root_counts` 逐项 `assertCell`,长度 = `roots.value.length`,第 i 项 `value.root === roots.value[i].identifier`(value 非 null 时),provenance 必须 `derived counts.v1`;值形状 `{ root, counts: { live, waiting, free, idle, done, canceled, total } }` 七个非负整数且 `total` = 六者之和;**重算比对**(同 ready.v1 `:877-882` 的做法) |
| `:934-975` gaps 一致性 | faces 表加 `["parent", "parent"]` |
| `resolvePointer`(`:312-330`) | 已支持数组下标 ⇒ `/header/root_counts/0` 可作 `from` 指针 ✅,不改 |

`EPIC_PAGE_MAX_DOCUMENT_BYTES = 1_507_328`(`:11`,「200 张子单实测再取 64KB 整数倍」):今天 21 张 137,518 B ⇒ ~6.5KB/张;加 `parent`(~200B)与每根一个 counts Cell(~600B)后 200 张 ≈ 1.35MB,仍在界内 🔶(实现时用 200 张 fixture 复测一次,若超出则按同一「64KB 整数倍」规则上调,不是硬编码新数)。

### 2.4 `rules.ts` / `subtraction.ts` / `residual.ts`(计算域钉死)

| 位置 | 今天 | 改动 |
|---|---|---|
| `rules.ts:23-43` computeReady | 行内判 `type === "backlog"` | 抽成 `export function isSchedulable(item)`(= `state.type !== "backlog"`),ready.v1 引用;行为不变 |
| `subtraction.ts:110-113` `nonTerminal` | 非终态 | 非终态 **∧ isSchedulable** |
| `subtraction.ts:22-47` canceled_blocker | 非终态 item | 同上加 isSchedulable |
| `subtraction.ts:48-63` 环图节点/边 | 全 items,边要 in_scope | 节点 = isSchedulable 的 items;边要 blocker 也在该节点集 |
| `subtraction.ts:118-125` `all_blocked` 边 | `in_scope` 抄 `blocked_by.in_scope` | `in_scope` = blocker ∈ 节点集 |
| `generate.ts:281-312` + `model.ts:893-964` signals.v1 | 全部 item | 只遍历 isSchedulable 的 item(生成与校验同改) |
| `residual.ts:242-245` `remainingItems` | 非终态 | 非终态 ∧ isSchedulable |

依据:founder 2026-09-03 裁定「范围 = started 父单子树 ∪ 日常筐 **− backlog**」(FLY-2140 plan §11.4–11.5,FLY-2141 plan §2 表第 34 行 ✅)—— 这三条规则从来就是在「− backlog」的集合上定义的;scope.v2 改的是**页面的 item 集合**(founder 2026-09-09 裁定),不改这三条规则的定义域。把 09-03 的定义域从「取数层的副作用」变成「规则里的一行显式谓词」,就是本单的回归保证。

两处容易漏的口(Codex R1 抓到,plan v2 已补):
- `subtraction.v1` 里 `all_blocked.blocking_edges[].in_scope` 今天**抄** `blocked_by.in_scope`(`subtraction.ts:118-125`)—— blocker 为 backlog 时会 false→true,`dependency_review.value` 就变了。改法:边的 `in_scope` = `blocker ∈ isSchedulable 节点集`,不再抄文档层的位;这样「可排期单被 backlog 单挡」的边与 v1(blocker 在文档外)逐字节相同。09-09 快照无此类边 ✅,但合同要靠测试固定,不靠今天没有。
- `signals.v1`:`stuck_items` 由**全部** item 的信号聚合(`generate.ts:281-312`),校验器也按全部 item 重算(`model.ts:893-964`)。backlog 单若在 14 天窗口内有停机/提问信号(被挪回 backlog 的单会有),`stuck_items.value` 就变了。改法:生成与校验都只遍历 `isSchedulable` 的 item;每张 item 自己的 `signals[]` 照存。今天 11 张 backlog 单在 `sessions` 表零行 ✅(`sqlite3 teamlead.db` 实查),同样靠测试固定。
- 「不变」的定义:三格的 `.value`;`provenance.from` 是按 item 下标的指针,items 变多后必然变。

### 2.5 渲染层(只碰规则号,不碰结构)

| 位置 | 改动 | 为什么不算「改渲染」 |
|---|---|---|
| `render-html.ts:13-17` / `render-markdown.ts:13-17` `FOUNDER_DECIDED_RULES` | `scope.v1` → `scope.v2`,加 `counts.v1` | 否则页面把已裁定规则标成「未获 founder 裁定的默认规则」—— 错话 |
| `labels.ts:24` `page.scope_rule_note` | 文案里的 `scope.v1` → `scope.v2` | 同上 |
| 卡片 / 总览结构、`itemCells(...)` 审计清单(`render-html.ts:97-116`) | **不动** | `parent` / `root_counts` 在 `show --format json` 与回执里可见;进页面是 F2/F9 渲染单的事 |

`render.test.ts:201-227` 的 `ROOT_PATHS / ITEM_PATHS` 是「被渲染的格必须带出处」的对拍清单;新格不在清单里,测试不受影响。

### 2.6 回执 / StateStore / CLI

- `receipt.ts:206-238` `buildEpicPageRenderReceipt` 递归收所有 source 格 ⇒ `parent`(linear)自动进 `sources`;`root_counts`(derived)自动不进 ✅。`COMPUTED_ORDER_FIELD`(`:28-29`)不匹配 `parent` / `root_counts` ✅。
- `source_digest` 随 sources 变 ⇒ 上线后第一次刷新必然产生新版本、重新发布固定页(正常)。
- `epic_page` 表不存文档(`StateStore.ts:6947-6956` ✅)⇒ **零迁移、零 schema_version 升级**。
- `flywheel-comm epic-page show` 透传(`commands/epic-page.ts:188-191` ✅)⇒ 新字段直接可见,CLI 不改。

## 3. `counts.v1` 的精确定义与可重算性

```ts
type RootCounts = { root: string; counts: { live; waiting; free; idle; done; canceled; total } };
```

对每张 item:
1. 归属根:沿 `parent.value` 走;命中 `header.roots.value[].identifier` 即归属;命中另一张 item 则继续;`parent` missing ⇒ 不归属任何根(已在 gaps);走了超过 `items.length` 步仍未命中 ⇒ 抛 `EpicPageSchemaError`(链有环,快照不自洽)。
2. 分类(只看 `state.value.type` 与 `blocked_by.value`):
   - `completed` → done;`canceled` → canceled;`started` → live;
   - `backlog | unstarted | triage` → open,再:`blocked_by` 为空 → idle;存在 `blocker_state_type !== "completed"` → waiting;否则 → free;
   - 其它类型 → 该根的 Cell `missing: { reason: "unknown_state_type", detail: <type> }`(整根缺,不出半对的数)。
3. `total` = 六者之和;无归属子单的根 = 全 0。
4. `provenance = { kind: "derived", rule: "counts.v1", from: ["/header/roots", ...每张 item 的 /parent, /state, /blocked_by] }`;`observed_at = generated_at`。

校验器重算:同一个 `computeRootCounts(items, roots)` 在 `assertEpicPage` 里再跑一次,`canonicalJsonString` 比对(与 ready.v1 同款)。

🔶 与 mock 的一处偏离已在 exploration §2.3 说明(`free` 以 `completed` 为解开判据,对齐 ready.v1)。

## 4. 测试基线(要动的文件与理由)

| 文件 | 今天 | 要做 |
|---|---|---|
| `bridge/__tests__/linear-epic-query.test.ts:107-155` | 「filters Backlog」:`items == ["EPX-1"]`,`inScope: false` | 反转:两张都在 `items`,`parent` 来自查询,`inScope` 按新集合;新增 null-parent、drift 两条 |
| `epic-page/__tests__/fixtures/epic-shape.ts` | 5 张 unstarted 子单,无 `parent` | 每张加 `parent: { id: "epic-uuid", identifier: "EPX-100" }`;新增 `epicShapeSnapshotV2()`:在原 5 张外加 backlog 子单(含「backlog 被 completed 挡」与「backlog 挡 backlog」两种边),模仿 09-09 真形状 |
| `epic-page/__tests__/generate.test.ts` | golden 页断言 `header.items`、`blocks`、provenance | 加 `parent` 与 `root_counts` 的 golden;回归:`generate(v2 fixture)` 与 `generate(v1 过滤后 fixture)` 的 `ready_items / stuck_items / dependency_review` 逐字节相同 |
| `epic-page/__tests__/model.test.ts:120-127` | fixture 写 `scope.v1` + `excluded_item_state_type` | 改 v2;加负向:缺 `root_counts`、长度不等、`total` 不等于和、规则号 `scope.v1` 被拒、`no_parent` 缺 gaps 被拒 |
| `epic-page/__tests__/rules.test.ts` | ready/subtraction 用例 | 加 `counts.v1` 用例(七类 + 未知类型 + 嵌套链 + 环链)、`isSchedulable`、subtraction 对 backlog 的域限定 |
| `epic-page/__tests__/residual.test.ts:35-66` | `remaining=5` | 加一条:同 fixture 加 backlog 子单后八个计数不变 |
| `epic-page/__tests__/render.test.ts` | `page.scope_rule_note` 文案 | 断言含 `scope.v2`;`FOUNDER_DECIDED_RULES` 对 `counts.v1` 给「已裁定」 |
| `__tests__/statestore-epic-page.test.ts` / `bridge/__tests__/epic-page-route.test.ts` / `epic-residual-scan.test.ts` / `drill.test.ts` | 经 `epicShapeSnapshot()` 生成 | fixture 补 `parent` 后应零改动;跑一遍确认 |

`lifecycle-closeout.test.ts:931-943` 的 `blockedBy` 是另一个模型(closeout 检查),与本单无关 ✅。

## 5. HTML 预算的算术(给 plan 的诚实边界)

- 真页 261,181 B = 36,099 B 固定 + 21 × 10,718 B(`epic-page render` 2026-09-10T04:54Z ✅)。
- 加 backlog:09-09 快照 11 张 + FLY-2481 名下未知(Bridge `/api/linear/issues` 不返回 parent ✅,本机无 Linear key ✅,无法在设计期精确数)。按 32–40 张、backlog 卡 ~10.2KB 估:**363–445KB**。
- 天花板:(524,288 − 36,099) / 10,718 ≈ **45 张**;超过即 `structural: epic_html_too_large`,固定页停在上一版(`epic-page-publisher.ts:60-62` ✅)。
- 不在本单:卡片瘦身(渲染层);本单只把「当日字节数」写进 QA 证据。
