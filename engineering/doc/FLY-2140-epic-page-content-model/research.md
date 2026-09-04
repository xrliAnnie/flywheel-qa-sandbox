# FLY-2140 Epic 页面内容模型与首版生成 — 调研
Issue: FLY-2140 (https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳)
日期: 2026-09-02(rev 4:吸收 Codex R1 3B/5H/3M、R2 1B/3H/5M、R3 2B/3H/3M/1L,见 §13)
基于: exploration.md

> 世界标记同 exploration.md:[main] `63154c214` · [prd] `2ad4cc491` · [linear] as-of 2026-09-03T02:37:07Z(复杂度实测 2026-09-03T03:0xZ)。
> 成色:✅ 亲手核过原件;📖 引自上游未复核;⬜ 未验,进 plan 的实现期检查;🔶 本单默认值。
> 本文只记**可执行的合同与数字**;取舍理由在 exploration.md §3–§5,实施序在 plan.md。

---

## 1. 结论先行:六个模块各管一件事

| 模块 | 位置(新增) | 职责 | 依赖方向 |
|---|---|---|---|
| **模型 + 规则 + 标签** | `packages/teamlead/src/epic-page/{model,rules,labels,escape}.ts` | EpicPage v1 类型、schema 守卫、五条规则、显示标签唯一来源、Markdown 表格转义 | 只依赖 `flywheel-config`(canonical digest) |
| **Linear 读取** | `packages/teamlead/src/bridge/linear-epic-query.ts` | 有界分页把 Epic + 子单 + 关系 + 标签读成不可变快照 | `@linear/sdk`(与 `linear-query.ts` 同一用法) |
| **生成器** | `packages/teamlead/src/epic-page/generate.ts` | **纯函数**:`(linearSnapshot, itemFacts[], now) → EpicPage`,`itemFacts` 是存储层**事先一次物化好**的普通数据 | 模型 + 规则;零 IO,零回调 |
| **存储** | `StateStore.ts` 新表 `epic_page` + 方法 + `readEpicItemFacts` 物化器 | 版本化保存/读取/裁剪;按别名把每张子单的六格执行事实一次读成普通数据 | native better-sqlite3 + WAL(`StateStore.ts:328-346` ✅;`save()` 为 no-op `:2408-2415` ✅) |
| **路由 + 渲染** | `packages/teamlead/src/bridge/epic-page-route.ts`、`epic-page/{render-html,render-markdown}.ts` | `POST generate` / `GET` JSON·MD·HTML;转义 | `tokenAuthMiddleware`、`resolveProjectNameParam`、`issueMatchesBinding`、`workflowNodeDisplayLabel`、`escapeHtml` |
| **CLI** | `packages/flywheel-comm/src/commands/epic-page.ts` | `epic-page generate/show/render`,只走 loopback,不 import teamlead(与 `feature-flags.ts` 同一方向约束 ✅) | Bridge HTTP |

⛔ 不新增 flag、不改 patrol、不改 workflow 引擎、不写项目仓库。

---

## 2. Linear 读取合同 ✅(方向与复杂度都用真数据核过)

### 2.1 主查询(有界、每个连接都带 pageInfo)

```graphql
query EpicSnapshot($id: String!, $after: String) {
  issue(id: $id) {                      # id 接 identifier("FLY-2108")或 uuid
    id identifier title url updatedAt
    state { name type }
    team { key }
    project { name }                    # 项目边界校验用(§2.5)
    labels(first: 50) { nodes { name } pageInfo { hasNextPage } }      # 有下一页 ⇒ 直接 fail-closed(§2.2)
    children(first: 50, after: $after, includeArchived: false) {
      nodes {
        id identifier title description url priority updatedAt
        state { name type }
        labels(first: 50) { nodes { name } pageInfo { hasNextPage } }  # 同上
        inverseRelations(first: 25) {
          nodes { type issue { id identifier state { type } parent { id } } }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

### 2.2 补页查询(**只**给 `inverseRelations`;在某张子单的关系 `hasNextPage` 时按子单逐个补)

```graphql
query ChildRelations($id: String!, $after: String) {
  issue(id: $id) {
    inverseRelations(first: 50, after: $after) {
      nodes { type issue { id identifier state { type } parent { id } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```
标签**不补页**:Epic 或任一子单的 `labels.hasNextPage == true`(>50 个标签)⇒ 直接抛 `EpicSnapshotTruncatedError`(fail-closed;一张单 50 个标签不是正常形状,⛔ 不静默当不存在,也⛔ 不为它另造一套 pager)。关系补页最多 `maxNestedPages = 10` 页;用尽仍 `hasNextPage` ⇒ 同一个 `EpicSnapshotTruncatedError`。

### 2.3 规则
- **谁挡着我 = `inverseRelations` 里 `type == "blocks"` 的 `issue`**(exploration §2.3;PromptBuilder 同读法 ✅)。`relations` 不读。`isSibling = issue.parent?.id === epic.id`。关系条目只保留**直接值**(阻塞者 identifier、`state.type`、是否兄弟);它们的年龄由 `blocked_by` 格自己的 `observed_at`(= 同一次快照的时间)表达,⛔ value 里不嵌第二套时间键(会绕过 RFC3339 守卫、又让无关更新污染 digest —— rev 3 的两个嵌套时间已删)。
- 子单分页:`first:50`,最多 10 页(500 张);第 11 页仍 `hasNextPage` ⇒ `EpicTooLargeError`。
- **每个嵌套连接都检查 `hasNextPage`**:关系 ⇒ §2.2 补页;标签 ⇒ fail-closed(§2.2)。
- **整次快照一个总 deadline 20s**(不是每页 10s):用一个 `deadlineAt`,每次 `rawRequest` 的 race 超时 = `max(0, deadlineAt - now)`;超时/网络 ⇒ `LinearUpstreamError`。
- **Epic 不存在**:`issue == null` **或** catch 里消息匹配 `/entity not found|could not be found/i`(与 `lookupLinearIssueByIdentifier` 同映射 ✅ `linear-query.ts:190-241`)⇒ `EpicNotFoundError`,⛔ 不是 502。
- `includeArchived:false`:已归档不读、不计数。
- `description` 只用来抽验收段(§5.4),抽完即丢,**不进快照、不进文档**。
- 任一失败 ⇒ **整次生成失败,不写版本**。

### 2.4 复杂度与预算(实测 ✅,2026-09-03,对 FLY-2108 用 `curl -i`)

| 查询形状 | HTTP | `x-complexity` | 小时预算(`x-ratelimit-complexity-limit`) |
|---|---|---|---|
| `children(first:100)` + 嵌套 labels / inverseRelations **不带 first**(rev 1 的形状) | 200 | 187 | 3,000,000 |
| `children(first:50)` + `labels(first:20)` + `inverseRelations(first:20)` 带 pageInfo(≈ §2.1) | 200 | 104 | 3,000,000 |

⇒ Linear 文档写的「单请求 10,000 点」上限📖 **在这两个形状上都没有触发拒绝**,实测成本按返回节点数计。**采用 §2.1 有界形状的理由不是复杂度,而是嵌套连接不带 `first`/`pageInfo` 时超过默认 50 条会静默截断**(把真实 blocks 或 `founder-review` 当成不存在)。T10 把真实调用的 `x-complexity` 记进证据。

### 2.5 项目边界(与既有 Linear 代理同一语义 ✅ `linear-scope.ts:41-79,113-123`)
- `projectName` 经 `resolveProjectNameParam(projects, raw)`:未知 ⇒ 404;**已知但无 `linear` 绑定 ⇒ 404 `has no linear binding`**(既有语义,fail-closed)。
- 快照拿到 Epic 的 `identifier` / `labels` / `project.name` 后,`issueMatchesBinding(epic, binding)` 三项(team 前缀、project 名、scope label)**全部**成立才继续;否则 400 `epic_outside_project`,零写入。

### 2.6 快照类型

```ts
interface LinearEpicSnapshot {
  fetchedAt: string;                       // ISO,= 所有 linear 格的 observed_at
  epic: { id; identifier; title; url; updatedAt; state: {name;type}; teamKey: string|null; project: string|null; labels: string[] };
  children: Array<{
    id; identifier; title; url; priority: number; updatedAt;
    state: {name; type};
    labels: string[];
    blockedBy: Array<{ id; identifier; stateType: string; isSibling: boolean }>;
    acceptance: { text: string; truncated: boolean } | null;   // §5.4
  }>;
}
```

---

## 3. StateStore 事实读取合同 ✅(物化器,零回调)

**键域**:`sessions.issue_id` / `workflow_run.issue_id` / `land_operation.issue_id` 可能是 Linear **uuid 或 identifier**(`lifecycle-root-key.ts` 顶部注释 ✅;`getSessionsForIssueAliases` 注释 ✅ `StateStore.ts:12220-12226`)。⇒ 每张子单用 **`[uuid, identifier]` 两个别名**查,并按 `project_name` 过滤。

**时间格式**:StateStore 的 `created_at` / `started_at` / `ended_at` / `last_activity_at` 默认由 SQLite `datetime('now')` 写入,形如 `2026-09-03 02:48:37`(无 `T`、无 `Z`,✅ 建表 DDL);而 Cell 的时间字段要求 RFC3339 UTC。⇒ **所有投影 SQL 统一用 `strftime('%Y-%m-%dT%H:%M:%SZ', col)` 输出**(SQLite 同时接受 `YYYY-MM-DD HH:MM:SS`、`…THH:MM:SS.SSS` 与尾随 `Z`);解析不出 ⇒ NULL ⇒ 该格不填 `source_updated_at`(只有 `observed_at`)。T5 用 DDL 默认时间写入的行做一次穿透测试。

**物化器**:`readEpicItemFacts(store, projectName, child: {uuid, identifier}) → EpicItemFacts`,在路由里对全部子单**一次性**跑完再交给生成器;每格 `{ok:true, value} | {ok:false, table}`(`table` = 失败的那张表名;**原始异常文本只进 Bridge 日志,⛔ 不进返回值**),⛔ 不抛出。既有 `getSessionsForIssueAliases` 只投影 execution_id/status/project/别名/revision(✅ `:12228-12266`)且**特意返回全部行**(liveness veto 不能只看一行);`listOpenLandOperations` 只收一个 key、不返回 `pr_number`(✅ `:8930-8953`)。⇒ 本单新增四个精确投影方法,不改旧方法:

| 格 | 新方法 / 查询 | 取什么 | source_updated_at |
|---|---|---|---|
| `session` | `getEpicPageSessionFact(project, keys)`:**同一条查询**给出两样 —— ① 最新一行(展示):`ORDER BY julianday(COALESCE(last_activity_at, started_at)) DESC, execution_id ASC LIMIT 1`(⚠️ 排序必须走 `julianday`,同一列混有 `YYYY-MM-DD HH:MM:SS` 与 `…T…Z` 两种写法时文本倒序会选错行);② 聚合:对**全部**别名行 `COUNT(*) WHERE status IN (<CMUX_LIVE_SESSION_STATUSES>)` | `latest: [] \| [{status, session_role, branch, execution_id8}]`(0 或 1 个元素)、`ledger_live_count`(⚠️ 账面状态,不是 OS 进程活性;规则只读聚合数,展示才用最新行 —— 「旧的 running 行 + 新的 completed 行」必须挡住)。**⛔ 不投影 `last_error`**:它是调用方任意写入的原始字符串(`StateStore.ts:8564-8587`),可能带本机路径/令牌,页面不要它 | 最新行的 `COALESCE(last_activity_at, started_at)` |
| `run` | `getEpicPageRunFact(project, keys)`:`SELECT run_id, status, current_node_id, template_id, snapshot, created_at … WHERE project_name=? AND issue_id IN (…) AND status IN ('active','held') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, julianday(created_at) DESC, run_id ASC LIMIT 1` | `[] \| [{run_id, status, current_node_id, template_id, current_node_label, label_source}]`(0 或 1 个元素);标签 = `parseWorkflowRunSnapshot(snapshot).manifest.nodes.find(n => n.id === current_node_id)` 交给 `workflowNodeDisplayLabel(template_id, node)`(✅ `workflow-display-labels.ts:35-44`);解析失败 ⇒ 回落 id 并 `label_source:"id"` | `created_at` |
| `attempt` | `getEpicPageAttemptFact(run_id, node_id)`:`SELECT state, attempt, started_at, ended_at FROM workflow_run_node … ORDER BY attempt DESC LIMIT 1`(run 为 `[]` 时该格值为 `[]`,不查) | `[] \| [{state, attempt, ledger_open}]`,`ledger_open = state ∈ {pending, admitted, running, review}`(`workflow-ledger-states.ts` ✅) | `ended_at ?? started_at` |
| `gates` | 既有 `listOpenGateAuthorities(run_id)` ✅ `:8957`,取 `kind === "gate"` 的行(表 `workflow_gate_holder`) | `[{state}]`(空 = 观察到没有) | —(只有 observed_at) |
| `carriers` | 同上,取 `kind === "carrier"` 的行(表 `workflow_carrier_delivery`)—— 两张表两格,provenance 各点名自己的表 | `[{state}]` | — |
| `land` | `getEpicPageLandFact(project, keys)`:`SELECT pr_number, state, current_step FROM land_operation WHERE project_name=? AND issue_id IN (…) AND state != 'completed' AND superseded_at IS NULL ORDER BY operation_id DESC LIMIT 1` | `[] \| [{pr_number, state, current_step}]` | — |

「查到没有」是值(空数组),⛔ 不是 missing;只有查询抛错才是 `missing: statestore_error`。**失败传播(诚实,不假装观察到空)**:`run` 查询失败 ⇒ `run`/`attempt`/`gates`/`carriers` 四格全部 missing(后三格依赖 run_id);gate/carrier 来自同一条 UNION 查询,它失败 ⇒ 两格都 missing;`session`、`land` 各自独立。`missing.detail` 只写稳定的格名/表名(例如 `workflow_run`),⛔ 不放原始异常文本(只进 Bridge 日志)。全部只读 SELECT,参数化(IN 列表按 key 数展开占位符,与 `getSessionsForIssueAliases` 同法)。

---

## 4. EpicPage 文档 v1(JSON,权威形态)

```ts
type Provenance =
  | { kind: "linear"; entity: "issue" | "relation" | "label" | "children"; id: string; field?: string; url?: string }
  | { kind: "statestore"; table: string; key: Record<string, string> }   // 一格只点名一张表
  | { kind: "derived"; rule: RuleId; from: string[] };          // from = 文档内 JSON Pointer
type RuleId = "batch.v1" | "next.v1" | "founder.v1" | "done.v1" | "gaps.v1";

interface Cell<T> {
  value: T | null;                     // null 只表示 missing;「观察到没有」一律用空数组 / 空集合表达
  provenance: Provenance;
  observed_at: string;                 // RFC3339 UTC:/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
  source_updated_at?: string;          // 同格式;来源自报的变更时间
  missing?: { reason: MissingReason; detail?: string };
}
type MissingReason =
  | "no_acceptance_section" | "dependency_cycle" | "blocked_by_dependency_cycle"
  | "statestore_error" | "no_children";

interface EpicPage {
  schema_version: 1;                                              // 结构元数据(allowlist)
  key: { project_name: string; epic_issue_id: string; epic_identifier: string };   // allowlist
  generated_at: string;                                           // allowlist
  generator: { version: "epic-page/1"; trigger: "manual" };       // allowlist;"event"|"scan" 由 D 追加
  header: {
    title: Cell<string>; url: Cell<string>; state: Cell<{ name: string; type: string }>;
    children: Cell<string[]>;                                     // linear:children 的观察记录:子单 identifier 列表;零子单 ⇒ value: [](有出处有时间,⛔ 不是 missing)
    excludes: ["archived"];                                       // allowlist 常量
  };
  items: EpicItem[];                   // 结构容器;顺序 = header.children.value
  done_definition: Cell<{ terminal_state: "completed" }>;         // derived done.v1(from: []);observed_at = generated_at;「做完 = Linear state.type 为 completed」的权威落点,三种渲染只从这里读;标注「未获 founder 裁定的默认规则」
  batches: Cell<Array<{ batch: number; items: string[] }>>;      // derived batch.v1
  founder_items: Cell<string[]>;       // derived founder.v1;标签零命中 ⇒ value: [](⛔ 不是 missing)
  next_candidates: Cell<string[]>;     // derived next.v1
  gaps: Cell<Array<{ item: string; face: "what" | "order" | "done" | "founder"; reason: MissingReason }>>;  // derived gaps.v1
}

interface EpicItem {
  identifier: string;                  // 稳定标识(allowlist)
  title: Cell<string>; url: Cell<string>;
  state: Cell<{ name: string; type: string }>;                   // linear:issue.state
  priority: Cell<number>;
  blocked_by: Cell<Array<{                                       // linear:relation(field inverseRelations);零阻塞 ⇒ value: []
    identifier: string; sibling: boolean; blocker_state_type: string;   // 只有直接值;年龄 = 本格 observed_at;「是否已解除」由规则在读时算,⛔ 不存派生字段、不嵌时间键
  }>>;
  batch: Cell<number>;                                           // derived batch.v1(环 ⇒ missing)
  acceptance: Cell<{ text: string; truncated: boolean }>;        // linear:issue(field description);无验收段 ⇒ missing no_acceptance_section
  founder_named: Cell<boolean>;                                  // linear:label
  session:  Cell<{ latest: Array<{ status; role; branch: string|null; execution_id8 }>; ledger_live_count: number }>;   // statestore:sessions;latest 0 或 1 个元素;⛔ 无 last_error
  run:      Cell<Array<{ run_id; status: "active"|"held"; current_node_id; current_node_label; label_source: "manifest"|"legacy"|"id"; template_id }>>;   // statestore:workflow_run;0 或 1 个元素
  attempt:  Cell<Array<{ state; attempt: number; ledger_open: boolean }>>;   // statestore:workflow_run_node;0 或 1 个元素
  gates:    Cell<Array<{ state }>>;                              // statestore:workflow_gate_holder
  carriers: Cell<Array<{ state }>>;                              // statestore:workflow_carrier_delivery
  land:     Cell<Array<{ pr_number: number; state; current_step: string|null }>>;   // statestore:land_operation;0 或 1 个元素
  signals: [];                         // allowlist;预留给 D(R6),v1 恒空
}
```
`content_digest` **不在文档里**:它是 `epic_page` 行与 HTTP envelope 的字段(§6.3)。「做完 = Linear `state.type` 为 completed」是规则 `done.v1` 的陈述,它的**权威落点是根上的 `done_definition` 格**(有 provenance、有 observed_at),⛔ 不只活在渲染层;item 上关于「做完」的直接事实是 `state` 与 `acceptance` 两格。

**Schema 守卫(`assertEpicPage(doc)`,plan 里是单测 + 路由写入前断言)**:
1. **结构遍历**:从根开始,遇到 Cell(同时有 `value`/`provenance`/`observed_at` 三键)即停;否则该对象是结构容器,它的每个键要么在 allowlist,要么是 Cell,要么是 `items` 这个结构数组;**任何其它裸叶子或裸数组一律拒绝**。allowlist = `schema_version, key.*, generated_at, generator.*, header.excludes, items[].identifier, items[].signals`。集合的「空」都落在 Cell 的 value 里(`header.children`、`blocked_by`、`gates`、`carriers`),所以零命中也有出处与时间。
2. `observed_at` / `source_updated_at` / `generated_at` 匹配上面的 RFC3339 UTC 正则(⛔ 不用 `Date.parse`)。
3. `provenance.kind ∈ {linear, statestore, derived}`;`statestore.table` 非空且一格只一张表;`derived.from` 的每个 JSON Pointer 在文档内可解析且指向一个 Cell。
4. `value === null` ⇔ `missing` 存在;「观察到没有」一律是空数组(`[]`、`{latest: [], …}`),是值不是 missing —— 运行时没有泛型信息,所以 null 只许有一个意思。
4b. Cell 的 `value` 内(递归)**不得出现以 `_at` 结尾的键**:时间只允许出现在 Cell 自己的 `observed_at` / `source_updated_at`(否则既绕过 RFC3339 守卫,又让 `stripTimestamps` 漏删而污染 digest)。
5. 每张子单四个面(`title`/`batch`/`acceptance`/`founder_named`)要么有值要么在 `gaps.value` 有对应行;`items[].identifier` 集合 == `header.children.value` 集合;根上必须有 `done_definition` 且 `value.terminal_state === "completed"`。
6. `items[].signals` 必须是 `[]`。
7. 文档**有界**:canonical JSON 超过常量 `EPIC_PAGE_MAX_DOCUMENT_BYTES` ⇒ `EpicPageSchemaError{code:"size"}`,路由映射 422 `epic_page_too_large`,零写入。**本合同冻结的是「有界 + 超限 422 + 零写入」,不冻结那个数**:常量值由实现期对 ≥200 子单的 synthetic fixture 实测后选定(取实测 canonical 字节的 2 倍向上取整到 64KB 倍数),写进 milestone;评审过的 acceptance 不因此改变。

---

## 5. 推导规则(🔶 默认规则;页面每处显示都带规则号)

### 5.1 `batch.v1`
```
released(b) := b.blocker_state_type ∈ {completed, canceled}     # 读 blocked_by 格里的直接事实,不存派生字段
sib(i)      := { b ∈ i.blocked_by.value | b.sibling ∧ ¬released(b) }
batch(i)    := 1                          if sib(i) = ∅
             = 1 + max{ batch(b) | b ∈ sib(i) }   otherwise
```
- 只对兄弟递归;Epic 外的阻塞不影响批次号,但进 `next.v1`。
- **环:用 Tarjan SCC**。非平凡 SCC 的成员 ⇒ `batch.missing = dependency_cycle`,`detail` = 该 SCC 全部单号;从环**可达但不在环上**的下游 ⇒ `batch.missing = blocked_by_dependency_cycle`,`detail` = 它依赖的环成员(反例 `A↔B, B blocks C`:A、B 是环,C 是下游,⛔ 不把 C 点成环)。
- `batches` 格 = 按批次号分组,组内按 `priority`(1→4,0 最后)再按 identifier。
- 已完成/已取消的子单照样有批次号(历史仍成立),只是不再挡人。

### 5.2 `next.v1`(🔶 **未获 founder 裁定的默认候选规则**;PRD §8-2「哪些算还没做、可以往外放」§8-3「怎么算做完了」仍开放 ⛔ 不得当已定;页面每次渲染这一节都带这句话)
```
static(i)   := i.state.type ∈ {backlog, unstarted, triage}
             ∧ ∀ b ∈ i.blocked_by.value: released(b)   # 兄弟 + Epic 外都要解除
known(i)    := i.session, i.run, i.attempt, i.gates, i.carriers, i.land 六格都不 missing
idle(i)     := i.session.ledger_live_count = 0         # 聚合数,⛔ 不是「最新一行是否 live」(旧 running + 新 completed 必须挡)
             ∧ i.run = []                              # active/held run 一律挡
             ∧ (i.attempt = [] ∨ ¬i.attempt[0].ledger_open)
             ∧ i.land = []
next(i)     := static(i) ∧ known(i) ∧ idle(i)          # fail-closed:任一执行格 missing ⇒ 不推荐
```
- 「挡住」判的是**账面执行体**(sessions / workflow_run / workflow_run_node / land_operation 的行),⛔ 不声称 OS 进程活性(终态 session 行仍可能拥有活进程,`StateStore.ts:12220-12226` ✅);页面用词是「账面上还有执行体」。`gates`/`carriers` 只展示,不参与 idle(开着的门本身不代表有人在做,run/attempt 已经覆盖)。
- 排序:batch ↑ → priority(1→4,0 最后)→ identifier。
- 它回答的是「按默认规则,哪些**候选**可以开始」,⛔ 不是「可以派发」——派发判断(容量)归 B/E。

### 5.3 `founder.v1`
`founder_named(i) := "founder-review" ∈ i.labels`(逐字、大小写敏感)。标签名是**常量**(`FOUNDER_REVIEW_LABEL`),⛔ 不做开关。`founder_items = [i | founder_named(i)]`;零命中 ⇒ `value: []`,渲染为「0 件」并附一句「标签 founder-review 当前无命中」(Lead 硬约束:不隐藏这一格)。

### 5.4 `done.v1`
- 规则陈述落在根 `done_definition` 格(`provenance = derived done.v1, from: []`,`observed_at = generated_at`):「做完 = Linear `state.type` 为 completed」;三种渲染只从这一格读,并标注「未获 founder 裁定的默认规则(PRD §8-3 的『位子空出来』另议)」;item 的 `state` 格给出当前值。
- 验收原文(`acceptance` 格,provenance `linear:issue` field `description`):在子单 `description` 里找**第一个**标题行匹配
  `/^#{1,6}[ \t]*(?:验收|acceptance\b|definition of done\b|dod\b)/im`
  (中文分支**不用 `\b`** —— JS 的 `\b` 是 ASCII 边界,`验收` 后接行尾/空格没有边界,rev 1 的正则实测 `## 验收` 为 false ✅;「验收标准」「验收:」都算,判据 = 标题以「验收」开头),取到下一个**同级或更高级**标题为止;去首尾空白;**> 4096 UTF-8 字节**时在字符边界截断并标 `truncated:true`;找不到 ⇒ `acceptance` 格 `missing: no_acceptance_section` 且 `gaps` 记一行。
- ⛔ 不做任何摘要、改写、翻译。

### 5.5 `gaps.v1`
`gaps = [{item, face, reason}]`,来自各 item 的四个面格的 `missing`;`provenance.from` 列出这些格。

---

## 6. 存储合同(StateStore,additive;native better-sqlite3 + WAL)

### 6.1 DDL
```sql
CREATE TABLE IF NOT EXISTS epic_page (
  project_name    TEXT NOT NULL,
  epic_issue_id   TEXT NOT NULL,            -- Linear uuid(稳定键)
  epic_identifier TEXT NOT NULL,            -- 显示用(可变,不做键)
  version         INTEGER NOT NULL CHECK (version > 0),
  generated_at    TEXT NOT NULL,
  trigger         TEXT NOT NULL CHECK (trigger IN ('manual','event','scan')),
  content_digest  TEXT NOT NULL,            -- sha256(canonical JSON 去时间戳)
  document        TEXT NOT NULL,            -- canonical JSON(EpicPage v1,不含 digest)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_name, epic_issue_id, version)
);
CREATE INDEX IF NOT EXISTS idx_epic_page_latest
  ON epic_page(project_name, epic_issue_id, version DESC);
```
`trigger` 的 `event`/`scan` 值现在就进 CHECK,D 落地时不改 schema。

### 6.2 方法
- `insertEpicPageVersion({projectName, epicIssueId, epicIdentifier, trigger, document}) → {version, generated_at, content_digest}`:**一个 `this.db.transaction()`** 内:`version = COALESCE(MAX(version),0)+1` → INSERT → `DELETE … WHERE version <= version-20`(裁剪到最近 20 版)。事务返回即持久(WAL);保留 `this.save()` 调用只为与既有写路径风格一致,**它是 no-op,不是持久化步骤**(✅ `StateStore.ts:2408-2415`)。持久性证据 = 测试里用临时文件建库、写入、**重开**后能读到(⛔ 不拿 `save()` 调用当证据)。
- 三个读取方法**统一收 `epicKey`**(uuid 或 identifier),共用一个私有解析 `resolveEpicPageKey(project, epicKey) → uuid | null`(identifier ⇒ 取该 identifier 最新一行的 uuid;identifier 改名后旧名仍能解析到同一条版本链):`getLatestEpicPage(project, epicKey)`、`getEpicPageVersion(project, epicKey, version)` 返回 `{epic_issue_id, epic_identifier, version, generated_at, trigger, content_digest, document}`;`listEpicPageVersions(project, epicKey, limit≤50)` 返回 `[{version, generated_at, trigger, content_digest}]`。路由⛔ 不解析 `document` 找 uuid。

### 6.3 `content_digest`
`contentDigest(doc) = canonicalSubmissionDigest(stripTimestamps(doc))`(`packages/config/src/canonical-json.ts:29` ✅);`stripTimestamps` 递归删 `observed_at` / `source_updated_at` / `generated_at` **三个键,只这三个**。digest 不在文档里 ⇒ 无循环;round-trip 断言:`row.content_digest === contentDigest(JSON.parse(row.document))` 且 `row.document === canonicalJsonString(doc)`。用途:D 区分「内容变了」和「只是刷新了时间」。

---

## 7. 路由合同(Bridge)

挂载:`app.use("/api/epic-page", tokenAuthMiddleware(config.apiToken, config.geminiAgentToken), createEpicPageRouter(deps))`(与 `/api/runs` 同式 ✅ `plugin.ts:4213-4222`)。scoped token 不在可达集 ⇒ 403(现有行为)。`config.apiToken` 缺失时**不挂载**。

| 路由 | 入参校验 | 成功 | 失败 |
|---|---|---|---|
| `POST /generate` | `projectName` **必须是非空字符串**(缺失/空/非字符串 ⇒ 400 `project_required`,在调用 helper 之前判 —— `resolveProjectNameParam` 对 `undefined` 会放行,✅ `linear-scope.ts:51`),再经 `resolveProjectNameParam`(未知 404;无绑定 404);`epic` 匹配 `/^[A-Z][A-Z0-9]+-\d+$/`(否则 400);快照后 `issueMatchesBinding` 三项(否则 400 `epic_outside_project`) | 200 `{version, generated_at, content_digest, item_count, next_candidates}` | Linear 不可达/超时 502 `linear_unavailable`;Epic 不存在 404 `epic_not_found`;无 children 200 但 `gaps` 含 `no_children`;>500 子单 422 `epic_too_large`;Epic 或子单 >50 标签、或关系补页用尽仍有下一页 422 `epic_snapshot_truncated`;文档超过 `EPIC_PAGE_MAX_DOCUMENT_BYTES` 或 schema 失败 422 `epic_page_too_large` / `epic_page_invalid`;`LINEAR_API_KEY` 未配 501。**所有失败零写入**(测试用 insert spy 断言) |
| `GET /:projectName/:epic` | 同上校验(不做 Linear 调用);`:epic` 作为 `epicKey` 交给存储层解析;`?version=n`(正整数)、`?format=json\|md\|html`(默认 json) | 200,`Content-Type` 按格式;JSON 形态 = `{epic_issue_id, epic_identifier, version, generated_at, trigger, content_digest, document}` | 404 `no_page`(从未生成) |
| `GET /:projectName/:epic/versions` | 同上;同一 `epicKey` 解析 | `[{version, generated_at, trigger, content_digest}]` | 404 `no_page` |

单飞:同一 `(project, epic)` 的 generate 串行(进程内 promise 链,仿 reports 的 `publishChain` ✅),避免并发两版交错。

---

## 8. CLI 合同(flywheel-comm)

```
flywheel-comm epic-page generate --epic FLY-2108 [--project <name>] [--bridge-url <url>]
flywheel-comm epic-page show     --epic FLY-2108 [--project <name>] [--format json|md] [--version n]
flywheel-comm epic-page render   --epic FLY-2108 [--project <name>] --out <file.html>
```
- `--project` 缺省取 `FLYWHEEL_PROJECT_NAME`;两者都没有 ⇒ 单行 envelope `{ok:false, error:"missing_project"}` + exit 1(普通参数错误,⛔ 不猜项目);URL 取 `--bridge-url` → `FLYWHEEL_BRIDGE_URL` → `BRIDGE_URL`(与 `feature-flags.ts` 同序 ✅);token 取 `TEAMLEAD_API_TOKEN`(master;runner 的 ingest token 打不开这个面,这是有意的:页面给 Lead 用)。
- stdout 恒一行 JSON envelope(与 publish-report 同合同);人读诊断走 stderr;退出码 0/1。
- `render` 只把 Bridge 返回的 HTML 原样落盘;发布仍用既有 `publish-report --publish-only`(⛔ 不重造投递)。

---

## 9. 渲染合同(同一文档两种渲染)

### 9.1 共同规则
- 标题、标签、小节顺序来自 `labels.ts` **唯一来源**;MD 与 HTML 各自只是排版。
- 小节固定顺序:① 页头(Epic、生成时间、不含已归档)② 要做的事(全部子单表)③ 先后(批次)④ 做完算什么样 ⑤ 要回来找她的 ⑥ 现在可以开始的(标「未获 founder 裁定的默认规则 next.v1(PRD §8-2)」)⑦ 缺什么(gaps)。
- **每格都渲染出处与时间**:Linear 格 = 链接 + `source_updated_at`;StateStore 格 = 表名 + 键 + 读时刻;derived = 规则号 + 「由 … 推出」。
- 时间显示 ISO UTC + 相对「N 分钟前」(相对值在渲染时算,只是显示;权威仍是 ISO)。

### 9.2 HTML 特有
- 小节标题永远来自 `labels.ts`,⛔ 不用动态文本拼标题;全部动态文本经 `escapeHtml`(复用 `bridge/xhs-review-html.ts:24` 导出 ✅);链接只在 `url` 以 `https://linear.app/` 开头时渲染成 `<a>`,否则纯文本;无 `<script>`、无外链资源、无内联事件属性;Apple-light 样式内联。
- 体积:Bridge 直出不设上限;`publish-report` 的 512KB 是**托管**上限,`render` 落盘后 >512KB 时 CLI 在 stderr 警示(实现期检查 §12 量真实体积)。

### 9.3 Markdown 特有(给 Lead)
- **动态表格值一律经 `escapeMarkdownTableCell`**(`epic-page/escape.ts`:反斜杠 → `\\\\`、`|` → `\\|`、CR/LF → 空格、`[` `]` `(` `)` → HTML 实体),防 Linear 标题里的 `|`/换行/伪链接把表格拆行或伪造小节;小节标题只来自 `labels.ts`。
- 每张子单一行:`| FLY-2141 | 标题 | 状态(Linear, 02:35Z) | 第 2 批 ← 2140 | 验收:有/缺 | 找她:否 | 账面执行体:running/实现(a1b2c3d4, 5 分钟前) |`;表格之后**每张子单一个小块**,原文列出验收段全文(经转义)、全部阻塞者(含 Epic 外)、六个执行格的值,以及每格的「出处 · 看到它的时间」—— 表格只是索引,⛔ 不是四问的全部答案。
- 表格前一行写「现在可以开始的(默认规则 next.v1,未获 founder 裁定):FLY-2140, FLY-2144」,这是 Lead 最先看的一行。

---

## 10. 显示标签(`labels.ts`,唯一来源)

| key | 标签 | 说明 |
|---|---|---|
| `section.what` | 要做的事 | R1 ① |
| `section.order` | 它们的先后(批次) | R1 ② |
| `section.done` | 每件做完算什么样 | R1 ③ |
| `section.founder` | 这个 Epic 里要回来找她的 | R1 ④(⛔ 不叫「什么时候该找她」) |
| `section.next` | 现在可以开始的(默认规则 next.v1,未获 founder 裁定) | 推导 |
| `section.gaps` | 缺什么、缺在哪 | gaps.v1 |
| `cell.provenance` | 出处 | R5 |
| `cell.observed_at` | 看到它的时间 | R5 |
| `cell.ledger_note` | 账面状态,不代表进程一定活着 | next.v1 措辞 |
| `batch.n` | 第 {n} 批 | |
| `batch.cycle` | 依赖成环:{ids} | dependency_cycle |
| `batch.after_cycle` | 上游依赖成环,无法定批次 | blocked_by_dependency_cycle |
| `founder.none` | 0 件(标签 founder-review 当前无命中) | Lead 硬约束 |
| `excludes.archived` | 不含已归档 | |

---

## 11. 测试与证据(plan 逐条落)

| # | 证据 | 命令/形态 |
|---|---|---|
| T1 | 规则单测:批次分层、SCC 环 + 下游、外部阻塞、取消释放、排序、验收段抽取(含 `## 验收`、`## 验收:`、`## 验收标准`、英文、混级、多字节截断) | `pnpm --filter flywheel-teamlead test:run -- epic-page/rules` |
| T2 | schema 守卫各一反例(裸叶子 / 裸数组 / 坏时间格式 / 坏 provenance / 坏 pointer / null 无 missing / **value 内含 `*_at` 键** / signals 非空 / children 集合与 items 不一致 / 缺 `done_definition` / 超过 `EPIC_PAGE_MAX_DOCUMENT_BYTES`);**零子单、零阻塞、六格全空(空数组)**的文档必须通过;`stripTimestamps` 只删三键;digest round-trip | 同上 `epic-page/model` |
| T3 | 生成器 golden:FLY-2108 形状 fixture ⇒ 批次 {1:[A,E],2:[B,C],3:[D]},next=[A,E];标签零命中 ⇒ founder_items=[] 且渲染含「0 件」;六格全空是值(空数组);gate 与 carrier 同时开着时落在两格、各点名自己的表;`done_definition` 存在且 provenance 为 `done.v1`;**泄漏哨兵**:fixture 的 session 行 `last_error` 列放绝对路径与 `Bearer …` 串(物化器不投影它),投影方法的 mock `throw` 消息里也放同样哨兵(物化器只输出 `{ok:false, table}`),断言生成的 JSON 不含任一哨兵 | 同上 `epic-page/generate` |
| T4 | **R1 演练**(集成):同一 fixture 依次把 A→B,C→D 置 completed 再生成,每步 next 非空且与默认规则一致;最后一步 next=[] 且全终态 | 同上 `epic-page/drill` |
| T4b | next.v1 fail-closed:`statestore_error` 排除;active run 无 session 排除;held run 排除;终态 session 行 + open attempt 排除;open land 排除;**旧 running 行 + 新 completed 行(ledger_live_count=1)排除**;两个别名各一行且一行 live 排除;**run 查询失败 ⇒ run/attempt/gates/carriers 四格 missing 且排除**;gate/carrier UNION 失败 ⇒ 两格 missing 且排除 | 同上 |
| T5 | 存储:版本单调(含裁剪后)、裁剪到 20、digest round-trip、identifier 改名后 `getLatest`/`getVersion`/`listVersions` 三个方法按旧名与 uuid 都取到同一版本链、**临时文件建库写入后重开可读**;facts 物化:跨 project 同别名只取本项目、同时间 tie-break 稳定、custom 模板 label 来自 manifest、land 按 identifier/uuid 两种写法、**DDL 默认 `datetime('now')` 写入的 run/attempt 行经 strftime 后通过 RFC3339 守卫**、session 聚合数对「旧 live + 新 terminal」为 1;**混合时间格式排序**:同一子单一行 `2026-09-03T02:00:00Z`、一行 `2026-09-03 03:00:00`,latest 必须是后者(julianday);失败传播:注入 run 查询异常 ⇒ 四格 `{ok:false}`,`missing.detail` 只含表名不含异常文本 | `StateStore.create(":memory:")` + 临时文件 |
| T6 | 路由:401/403/400(`project_required` 缺失与空串两例;坏 epic;`epic_outside_project` 三例:跨 team、同 team 不同 project、缺 scope label)/404(unknown_project;已知项目无绑定;no_page;`epic_not_found` 两种触发)/422(`epic_too_large`;`epic_snapshot_truncated` 三种触发:Epic 标签溢出、子单标签溢出、关系补页用尽;`epic_page_too_large`;**`epic_page_invalid`(注入一个非 size 的 schema 失败)**)/501/502 各一;每个失败断言 insert spy 零调用;并发两次 generate 串行;GET 三种 format 的 Content-Type;用 DDL 默认时间的 run/attempt 行走一遍 generate 通过守卫 | express + `node:http`(仿 `runs-route.run-management.test.ts` ✅) |
| T7 | HTML:标题含 `<script>` 的 fixture 渲染后无 `<script`、无 `on*=`;非 linear.app 的 url 不成 `<a>`;规则号与「未获 founder 裁定」字样可见;**Markdown:标题含 `\|`、换行、`[x](javascript:…)` 时表格行数与小节数不变**;**全 Cell 渲染门**:golden fixture 对模型里的**每一条 Cell 路径** —— `header.title` `header.url` `header.state` `header.children` `done_definition` `batches` `founder_items` `next_candidates` `gaps` 与每张子单的 `title` `url` `state` `priority` `blocked_by` `batch` `acceptance` `founder_named` `session` `run` `attempt` `gates` `carriers` `land`(共 9 + 14 条路径,与 §4 模型逐一对应) —— 各放一个唯一哨兵值(或可识别标记),逐路径断言 MD 与 HTML 都含该值/标记、并在其旁渲染 provenance 标识与 ISO `observed_at`;漏渲染任一路径即失败;`done_definition` 的值、规则号在 JSON/MD/HTML 三方一致;泄漏哨兵(绝对路径、`Bearer …`)在 MD/HTML 均不出现;MD/HTML/文档三方 identifier 集合与 next 集合一致(parity) | 字符串断言 + 一次 headless 载入 |
| T8 | Linear 查询:方向(inverseRelations);关系条目只有直接值(快照 JSON 不含任何 `updatedAt` 以外的时间键);子单分页拼接;第 11 页超限;关系 `hasNextPage` ⇒ 补页并合并;补页 10 页用尽仍有 ⇒ truncated;Epic 标签溢出 / 子单标签溢出 ⇒ truncated;总 deadline 跨页递减;`issue:null` 与 reject「entity not found」都 ⇒ `EpicNotFoundError`;描述哨兵不泄漏;mock `rawRequest` | 同上 `linear-epic-query` |
| T9 | CLI:三子命令的 envelope、缺 token、缺 project(无 `--project` 且无 env)两条失败路径、`render` 落盘字节等于响应、>512KB 警示 | `packages/flywheel-comm` vitest |
| T10 | 真数据手工演练(实现节点做,QA 复核):对 FLY-2108 `generate`,**同一时刻**记录 Linear 子单状态/关系与六格 StateStore 事实,再断言页面的 `next_candidates` 等于由这些证据按 `next.v1` 手算的结果(⛔ 不写死 2140/2144 —— 本单实现期间 2140 自己就在跑);记录真实调用的 `x-complexity`;`render` → `publish-report --publish-only` 出一个快照 URL;canonical JSON 与 HTML 字节数 | 记进 implementation-evidence.md |
| 全仓 | `pnpm lint` · `pnpm -r build` · `pnpm test:packages:run` | 实现节点收尾门 |

---

## 12. 未查 / 盲区

- `workflow_run.issue_id` / `land_operation.issue_id` 实际写入的是 uuid 还是 identifier,本单只从注释推断「两者皆可能」;⬜ 实现期用生产库只读查一次分布确认双别名查询覆盖。
- Linear `children(includeArchived:false)` 与嵌套 `first/after` 的行为按 §2.4 的两次真实调用确认可执行;⬜ 补页路径(§2.2)未对真数据跑过(FLY-2108 没有 >25 条关系的子单),只有 mock 测试。
- Linear 文档的「单请求 10,000 复杂度上限」📖 未在实测中触发;⬜ 若将来某个 Epic 的真实调用被拒,先看 `x-complexity`。
- 本单没有量过一份 200 子单 Epic 的 HTML / canonical JSON 体积;⬜ 实现期用 fixture 生成器量一次,按 §4 第 7 条的公式选定 `EPIC_PAGE_MAX_DOCUMENT_BYTES`,写进 milestone(合同只冻结「有界 + 超限 422」)。

---

## 13. rev 1 → rev 2 变更(吸收 Codex R1)

| # | 严重度 | 处置 | 落点 |
|---|---|---|---|
| 1 | BLOCKER | **采纳**:execution 拆成 session/run/attempt/gates/land 五格;`blocked_by` 每条关系一格;allowlist 之外裸叶子一律拒;RFC3339 正则;none/[] 是值 | §3、§4 |
| 2 | BLOCKER | **采纳**:`content_digest` 移出文档,只在行与 envelope;round-trip 断言 | §4、§6.3 |
| 3 | BLOCKER | **部分采纳**:嵌套连接全部带 `first` + `pageInfo`,补页查询,总 deadline;⛔ **未采纳「必超 10,000 复杂度」**——真 API 实测 187/104 且 200(§2.4),截断风险才是真问题 | §2.1–2.4 |
| 4 | HIGH | **采纳**:`resolveProjectNameParam` + `issueMatchesBinding` 三项;无绑定 404;四个路由用例 | §2.5、§7 |
| 5 | HIGH | **采纳**:catch 里映射 not-found | §2.3 |
| 6 | HIGH | **采纳**:next.v1 fail-closed(五格 known + run/attempt/land 都挡);措辞改「账面执行体」「未获 founder 裁定的默认规则」 | §5.2、§9、§10 |
| 7 | HIGH | **采纳**:正则去 `\b`,4096 UTF-8 字节,六个用例 | §5.4 |
| 8 | HIGH | **采纳**:三个新投影方法;run 标签走 pinned snapshot 的 manifest node;land 双别名 + pr_number | §3 |
| 9 | MEDIUM | **采纳**:better-sqlite3 + WAL 叙述;持久性证据 = 重开可读 | §6.2 |
| 10 | MEDIUM | **采纳**:Tarjan SCC;新增 `blocked_by_dependency_cycle` | §5.1 |
| 11 | MEDIUM | **采纳**:422 `epic_page_too_large` / `epic_page_invalid`;两种上限分开说 | §4、§7、§9.2 |

### rev 2 → rev 3 变更(吸收 Codex R2)

| # | 严重度 | 处置 | 落点 |
|---|---|---|---|
| 1 | BLOCKER | **采纳(按只删不加)**:集合改成 Cell(`header.children`、`blocked_by`、`gates`、`carriers`),空集合也有出处与时间;`blocked_by` 每条带关系时间 + 阻塞者 state 及其时间,**删掉** `released` 派生字段(规则读时算);**删掉** `done_means` 合成格,只留 `state` 与 `acceptance` 两个直接格;gate/carrier 两表两格;守卫改为结构遍历 | §2.1、§2.6、§4、§5 |
| 2 | HIGH | **采纳**:session 格同时给「最新一行(展示)」与「live 行计数(聚合)」,idle 只读聚合数 | §3、§5.2 |
| 3 | HIGH | **采纳(简化)**:标签不补页、`first:50` 有下一页直接 fail-closed;补页只管关系,用尽仍有 ⇒ 同一错误 | §2.1–2.3 |
| 4 | HIGH | **采纳**:POST `projectName` 非空字符串先判(400 `project_required`);CLI 缺 project ⇒ `missing_project` | §7、§8 |
| 5 | MEDIUM | **采纳**:投影 SQL 统一 `strftime` 出 RFC3339 UTC;DDL 默认时间行做穿透测试 | §3 |
| 6 | MEDIUM | **采纳**:保留「纯」——存储层先把全部子单的六格事实一次物化成普通数据,生成器零 IO 零回调 | §1、§3 |
| 7 | MEDIUM | **采纳**:T10 改为「同一时刻记证据、按规则手算、再比对」,exact 答案只留 fixture | §11 |
| 8 | MEDIUM | **采纳**:三个读取方法统一收 `epicKey`,共用一次解析,返回含 uuid | §6.2、§7 |
| 9 | MEDIUM | **采纳**:`escapeMarkdownTableCell`;小节标题只来自 labels | §9.3 |

### rev 3 → rev 4 变更(吸收 Codex R3)

| # | 严重度 | 处置 | 落点 |
|---|---|---|---|
| 1 | BLOCKER | **采纳(统一)**:`null` 只表示 missing;`run`/`attempt`/`land` 与 `session.latest` 改成 0/1 元素数组,「观察到没有」= 空数组 | §3、§4、§5.2 |
| 2 | BLOCKER | **采纳**:根上新增唯一共享格 `done_definition`(derived done.v1,observed_at = generated_at);三种渲染只从它读 | §4、§5.4 |
| 3 | HIGH | **采纳(删除)**:删掉 `blocked_by` 条目里的两个嵌套时间键,查询也不再取它们;新增守卫 4b:value 内禁止 `*_at` 键 | §2.1–2.3、§2.6、§4 |
| 4 | HIGH | **采纳(删除)**:`last_error` 不投影;`missing.detail` 只写表名;T3/T7 放泄漏哨兵 | §3、§4、§11 |
| 5 | HIGH | **采纳**:失败传播写实(run 失败 ⇒ 四格 missing;UNION 失败 ⇒ 两格 missing) | §3、§11 |
| 6 | MEDIUM | **采纳**:排序走 `julianday(...)`;混合格式测试 | §3、§11 |
| 7 | MEDIUM | **采纳**:Markdown 表格后每单一个小块放验收全文/阻塞者/六格 + 出处时间;T7 四问哨兵 | §9.3、§11 |
| 8 | MEDIUM | **采纳**:合同只冻结「有界 + 超限 422 + 零写入」,常量由实现期实测选定并写进 milestone | §4、§12 |
| 9 | LOW | **采纳**:T6 加 `epic_page_invalid` 零写入用例 | §11 |

### rev 4 → rev 5 变更(吸收 Codex R4 复核轮的两条残留)

| # | 严重度 | 处置 | 落点 |
|---|---|---|---|
| R4-1 | HIGH | **采纳**:失败载荷统一为 `{ok:false, table}`;泄漏哨兵改放在 session 行的 `last_error` 列与投影方法的 mock throw 里,断言物化器只输出表名 | §3、§11 T3 |
| R4-2 | MEDIUM | **采纳**:T7 改为全 Cell 路径渲染门(9 + 14 条路径逐一断言值/标记 + 出处 + ISO 时间) | §11 T7 |

