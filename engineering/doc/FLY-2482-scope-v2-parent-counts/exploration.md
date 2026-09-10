# FLY-2482 取数层 scope.v2 + parent + counts — 探索
Issue: FLY-2482 (https://linear.app/geoforge3d/issue/FLY-2482/进度页e1前置-取数层-scopev2不再丢-backlog-子单-itemsparent-rootscounts洞-eab)
日期: 2026-09-09
基于: 无(上游为 `product/doc/FLY-2457-founder-progress-page/prd.md` v2.1 §6.1 / §6.2 / §6.5 / §11)

> 成色:✅ 本单亲手核过(file:line / 命令输出 / 真页字节);📖 引自 PRD 未复核;🔶 本单裁定,可推翻。

## 0. 一句话

今天的 `epic-page` 引擎在 **取数那一层**就把 backlog 子单扔掉了(`linear-epic-query.ts:376-378` ✅),文档里的 item 也**没有 parent**、父单没有子单计数;本单只动数据层:范围规则升 `scope.v2`(不再按状态排除)、每张 item 加一格 `parent`、每个父单加一格派生 `counts`,同时把 `ready.v1 / signals.v1 / subtraction.v1` 与 Lead 巡检 residual 的**计算域显式钉在「非 backlog」**,让它们对同一份 Linear 数据的输出逐字节不变。

## 1. 现状实核(file:line)

### 1.1 backlog 是在取数层被丢的,不是渲染层

| 位置 | 事实 |
|---|---|
| `packages/teamlead/src/bridge/linear-epic-query.ts:376-378` ✅ | `uniqueRawItems.filter(item => item.state.type !== "backlog")` —— 子树遍历完成后**过滤掉 backlog**,再算 `inScopeIds`。 |
| 同文件 `:379` ✅ | `inScopeIds` 由过滤后的集合算 ⇒ 一张非 backlog 单被 backlog 单挡住时,`blockedBy[].inScope === false`(被当成范围外)。 |
| 同文件 `:405` ✅ | `descendantIds` 用的是**未过滤**的 `uniqueRawItems` —— 依赖账本(`dependency-route.ts:813/913/1436`)靠它判「是否在范围」,所以依赖账本今天**已经**认 backlog 子单。 |
| `packages/teamlead/src/epic-page/generate.ts:380-392` ✅ | `header.scope_definition` 值写死 `excluded_item_state_type: "backlog"`,规则号 `scope.v1`。 |
| `generate.ts:409-416` ✅ | `header.items` 的 Linear 出处 `field: "subtree,state.type!=backlog"`。 |
| `packages/teamlead/src/epic-page/model.ts:13-23` ✅ | `RULE_IDS` 含 `scope.v1`;`:25-36` `MISSING_REASONS` 无 `no_parent`。 |
| `model.ts:179-183` ✅ | `scope_definition` 的 TS 字面类型把 `excluded_item_state_type: "backlog"` 钉死。 |
| `model.ts:121-166` ✅ | `EpicItem` 无 `parent`;`header.roots` 是**一个** `Cell<Array<{identifier,title,url,state}>>`,值里放不下第二个 Cell。 |

### 1.2 谁消费 item 集合(改范围会波及谁)

| 消费者 | 今天怎么用 | scope.v2 后 |
|---|---|---|
| `rules.ts:23-43` `computeReady`(ready.v1) ✅ | 已显式排除 `backlog` | **不变** |
| `subtraction.ts:110-128`(subtraction.v1) ✅ | `nonTerminal` = 非 completed/canceled ⇒ backlog 会被算成「没做完」;`:56-63` 环检测只走 `in_scope` 边 | 若不加域限定,`all_blocked.non_terminal` 会膨胀、backlog 之间的环会新出现 ⇒ **必须显式钉域** |
| `generate.ts:216-238`(dependents.v1 `blocks`) ✅ | 只在 items 里找 `in_scope` 依赖方 | backlog 依赖方会新出现在 `blocks` —— **如实变宽**(不在验收回归清单) |
| `residual.ts:242-245` ✅ | `remainingItems` = 非 completed/canceled ⇒ Lead 巡检行 `hook-payload.ts:656`「范围内 N 张未完成 · 等前置的 M」会膨胀 | **必须显式钉域**,否则 Lead 每轮看到的数字变了 |
| `signals.ts` ✅ | 按 item uuid 读 sessions/mailbox 信号 | backlog 单通常无会话 ⇒ 0 信号;`stuck_items` 不变 |
| `render-html.ts:13-17` / `render-markdown.ts:13-17` ✅ | `FOUNDER_DECIDED_RULES` 硬编码 `scope.v1` | 规则号一换,不改这两行页面会把新规则标成「未获 founder 裁定的默认规则」 |
| `labels.ts:24` ✅ | `"page.scope_rule_note": "已获 founder 裁定的规则 scope.v1"` | 同上,文案要跟规则号 |
| `receipt.ts` ✅ | 只收 source(非 derived)格 | 新的 `parent` 格(Linear 出处)会自然进入回执;`counts` 是 derived,不进 |
| `epic-page-route.ts:275` / `flywheel-comm epic-page show` ✅ | 原样透传 document | 新字段自然可见 |
| StateStore `epic_page` 表 ✅ | 只存 `receipt` + `source_digest`(`StateStore.ts:6947-6956`),**不存文档** | **没有存量文档要迁移**;`schema_version` 不必升 |

### 1.3 今天的真数据(✅ 本单实核)

| 来源 | 数 |
|---|---|
| `flywheel-comm epic-page show`(2026-09-10T04:54Z) | 6 个 active 父单(2481 / 2441 / 2369 / 2355 / 2309 / 1143),items **21**(started 3 · completed 16 · canceled 2),ready 3,dependency_review 空,stuck 2 |
| `epic-page render` 真页字节 | **261,181 B** = 固定部分 36,099 B + 21 张卡 × 平均 10,718 B(min 9,985 / max 12,621) |
| PRD runner 2026-09-09 的 Linear 快照(`roots3.json`) | 5 个有子单的父单共 **29** 张子单,其中 backlog **11**(2441:3 · 2369:1 · 2355:1 · 2309:1 · 1143:5);**无嵌套孙单**;涉及 backlog 的依赖边只有 2 条,且 backlog 都在**被挡**一侧、blocker 均已 completed(2459←2445、2360←2357) |

⇒ PRD 写的「28」是 09-09 04:40Z 的数;之后 FLY-2481 进了 In Progress。**验收不能写死 28,按 QA 当日 Linear 实数对账。**

### 1.4 HTML 预算

- 上限 `EPIC_PAGE_MAX_HTML_BYTES = 512 × 1024`(`epic-page-publisher.ts:9` ✅);超限时 `publishHosted` 返回 `"structural: epic_html_too_large"`(`:60-62` ✅)—— fail-loud,固定页停在上一版。
- 投影:固定 36KB + 每卡 ≈10.7KB。backlog 卡没有执行事实,略小(取 10.2KB)。加回 11 张 09-09 的 backlog 再加 FLY-2481 名下未知数量的 backlog 子单,估 32–40 张 ⇒ **363–445KB**,仍 ≤512KB;**天花板约 44 张**。
- 瘦身不在本单(「不改渲染」);天花板与 token 写进 plan 的诚实边界。

## 2. 三个洞的候选与裁定

### 2.1 洞 E · 范围规则升 scope.v2

| 候选 | 说明 | 取舍 |
|---|---|---|
| A · 取数层去掉 backlog 过滤,规则号 `scope.v2`,规则**内部**不再有任何按状态的排除 | 与 PRD §6.5 一字不差 | ✅ **选** |
| B · 取数层保留,只在文档里加一份「被排除的 backlog 名单」 | 不用动下游 | ✗ 仍是「取数层静默丢弃」,F9/F10 依赖边还是拿不到 |
| C · 顺手把 `daily_title_contains` 一起改成配置 | — | ✗ 议题 ⛔ 保留不动 |

`scope_definition` 的值改成 `{ root_state_type: "started", daily_title_contains: "日常", item_state_filter: "none" }` —— 用**显式的 "none"** 表达「不排除」,不用「字段消失」表达(读者看不出是忘了还是不排)。`RULE_IDS` 去掉 `scope.v1`(没有存量文档,校验器拒绝旧号是好事:任何还写 v1 的代码路径会立刻 fail-loud)。`header.items` 出处 `field` 改为 `"subtree"`。

### 2.2 洞 A · `items[].parent`

| 候选 | 说明 | 取舍 |
|---|---|---|
| A · 从遍历上下文推(我是从 `issue(id: P).children` 里拿到的,所以 parent = P) | 零查询成本 | ✗ PRD §6.1 明写出处 = Linear `issue.parent`;推出来的不是「读来的」 |
| B · children 查询里加 `parent { id identifier }`,值取 Linear 原话,**并与遍历上下文对账** | 出处诚实 + 一致性守卫 | ✅ **选** |

- `parent` 是 `Cell<string>`(值 = 父单 identifier),出处 `{ kind: "linear", entity: "issue", id: <child uuid>, field: "parent", url }`。
- Linear 返回 `parent: null`(只可能是取数中途被人挪走)⇒ `value: null, missing: { reason: "no_parent" }`,并进 `gaps`(新增 face `parent`),⛔ 不静默、不猜。
- Linear 返回的 `parent.id ≠ 遍历时的父 id` ⇒ 快照不自洽,抛 `EpicSnapshotTruncatedError`(已有 token `structural: scope_snapshot_truncated`),等下一次刷新;不发布一份自相矛盾的页。
- 嵌套孙单(今天没有,但遍历支持)的 `parent` 指向中间那张子单,不是根;根的归属由「沿 parent 链走到 `header.roots` 里的 identifier」得到。

### 2.3 洞 B · `roots[].counts`

**形状**。`header.roots` 是单个 Linear Cell,里面放不下第二个带出处的格;新增 `header.root_counts: Array<Cell<{ root, counts: { live, waiting, free, idle, done, canceled, total } }>>`,与 `header.roots.value` **同序同 identifier、同长**。每根一个 Cell 的好处:某一根算不出(见下)时只缺那一根,不拖垮整页。

**词汇**。沿用 founder 已在样子稿上看过的分法(`product/doc/FLY-2457-founder-progress-page/build-progress-page.py:35,90-111` ✅:`OPEN = backlog|unstarted|triage`;`live = started`;open 再按依赖分 waiting / freed / idle),一个偏离:样子稿把 canceled blocker 当「解开」,而 ready.v1 只认 `completed`;counts 对齐 ready.v1,避免两套「解开」。

| 键 | 判据(只看 Linear 格:`state` + `blocked_by` + `parent`) |
|---|---|
| `live` | `state.type === "started"` |
| `done` | `completed` |
| `canceled` | `canceled` |
| `waiting` | open ∧ 存在 blocker `blocker_state_type !== "completed"` |
| `free` | open ∧ `blocked_by` 非空 ∧ 全部 blocker `completed`(依赖已解开·可起跑) |
| `idle` | open ∧ `blocked_by` 为空(未开始,没人挡) |
| `total` | 六者之和 = 归属该根的 item 数 |

- 只用 Linear 格 ⇒ **不依赖 sessions**,没有 `statestore_error` 把计数弄缺的情况;这也符合 PRD §4「排期决定唯一真相 = Linear state」。
- `state.type` 不在六种已知类型里(Linear 将来加类型)⇒ 该根 Cell `missing: { reason: "unknown_state_type", detail: <type> }`,不猜。
- 无子单 ⇒ 全 0(PRD §11 G)。
- 规则号 `counts.v1`,`provenance.from` = `/header/roots` + 每张 item 的 `parent / state / blocked_by` 指针;校验器像 ready.v1 一样**重算比对**。

### 2.4 `rollup` 不新增

PRD §6.2 已裁定 Epic 徽标照抄 Linear;本单不加任何「第二个状态」。

## 3. 回归边界(哪些输出变、哪些不变、为什么)

| 输出 | 变不变 | 依据 |
|---|---|---|
| `ready_items`(ready.v1) | **不变** | 规则已排除 backlog |
| `stuck_items`(signals.v1) | **不变** | 🔶 聚合与校验都只遍历「非 backlog」item(backlog 单自己的 `signals[]` 照存);今天 11 张 backlog 单 `sessions` 零行,但靠谓词不靠运气 |
| `dependency_review`(subtraction.v1) | **不变**(`.value` 逐字节) | 🔶 规则内部显式钉域「非 backlog」= v1 的集合;`all_blocked` 边的 `in_scope` 改为「blocker 在该集合内」而不再抄 `blocked_by.in_scope`,否则 backlog blocker 会让这一位 false→true |
| residual fact(Lead 巡检行) | **不变** | 🔶 `remainingItems` 显式排除 backlog |
| `blocks`(dependents.v1) | **如实变宽** | backlog 依赖方进文档了;不在验收回归清单 |
| `blocked_by[].in_scope` | backlog blocker false→true | 同上;F10 正需要这一位 |
| `gaps` / `founder_items` | **如实变宽** | backlog 单缺验收节、带 `founder-review` 标签时会出现;不在回归清单 |
| `header.items` / `items[]` | 变宽 +backlog | 本单目的 |
| 回执 `sources` | 每张 item 多一条 `/items/N/parent` | receipt 只收 source 格 |

一个共同的「可排期」谓词放在 `rules.ts`(`isSchedulable(item) = state.type !== "backlog"`),ready.v1 / subtraction.v1 / residual 三处都引用它 —— **一处真相**,不各写各的。

## 4. 不做(边界)

- 不改渲染层的卡片结构、排序、attention;渲染层只改**两行规则号常量 + 一条文案**(否则页面把 scope.v2 标成「未裁定」是错话)。
- 不给 backlog 卡瘦身、不动 512KB 上限。
- 不动 `daily_title_contains`。
- 不动 `descendantIds` 语义(依赖账本已经认全子树)。
- 不升 `schema_version`(无存量文档),不动 StateStore 表。
- 不改 `flywheel-comm epic-page` CLI(透传)。

## 5. 已向 Lead 通报的非阻塞裁定

1. 回归边界靠「显式钉域」实现(§3)。
2. counts 词汇沿用 mock,`free` 的判据对齐 ready.v1。
3. HTML 预算 363–445KB,天花板约 44 张卡。
4. 验收按 QA 当日 Linear 实数,不写死 28。
