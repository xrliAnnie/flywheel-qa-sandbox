# FLY-2140 Epic 页面内容模型与首版生成 — 实施计划
Issue: FLY-2140 (https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳)
日期: 2026-09-02(round 5:吸收 Codex R1 3B/5H/3M、R2 1B/3H/5M、R3 2B/3H/3M/1L、R4 复核轮 1H/1M;处置表在 research.md §13)
基于: exploration.md, research.md

> 世界标记同 research.md:[main] `63154c214` · [prd] `2ad4cc491` · [linear] as-of 2026-09-03T02:37:07Z。
> 本计划只写**做什么、按什么序、怎么证明**;合同与数字以 research.md 为准,取舍理由以 exploration.md 为准。实现节点 ⛔ 不得改本文件(design-review blob 已钉)。

## 0. 目标与验收(可证伪)

**目标**:任意 Lead 对任意已拆完的 Epic(= 有 children 的 Linear issue)执行一条命令,得到一份 **EpicPage v1 文档**(权威副本在 Bridge StateStore),它回答 R1 的四件事,且**每一格都有出处和观察时间**(R5 静态半边);同一文档可渲染成 Lead 视图(Markdown/JSON)与 founder 视图(HTML 快照)。

**验收**:
- **A1(R1 判据,可证伪)**:对 FLY-2108 形状的中性 fixture(5 张子单、5 条 blocks、标签零命中、账面无执行体)生成首版 ⇒ `next_candidates = [EPX-1, EPX-5]`(对应 A、E)、`batches = {1:[A,E], 2:[B,C], 3:[D]}`、`founder_items = []` 且渲染出「0 件」;依次把 A → {B,C} → D 置 `completed` 再生成,每一步 `next_candidates` 非空且与 **默认规则 `next.v1`** 一致,末步为 `[]` 且全部终态。**任一步需要文档之外的信息才能说出下一件 = 不合格**(测试 T4 失败)。⚠️ A1 证明的是「默认规则在 fixture 上自洽、四件事在页面上答得出」,**不是**替 PRD §8-2/§8-3 拍板;页面与 A1 的措辞都写「未获 founder 裁定的默认规则」。
- **A2(R5 静态)**:schema 守卫全部断言通过;结构遍历后 allowlist 之外不存在任何非 `Cell` 的叶子或裸数组,**空集合(零子单、零阻塞、零门、六格全空)也落在带出处与时间的 Cell 里**,`value` 内没有任何 `*_at` 键(T2);R1 第三问的定义在根 `done_definition` 格里而不只在渲染层;golden fixture 对模型的**每一条 Cell 路径**(9 条根/页头路径 + 每张子单 14 条,清单见 research §11 T7)在 MD 与 HTML 都渲染了值/标记、出处与 ISO 时间,三方 item 集合与 next 集合一致(T7)。
- **A3(通用主语)**:代码里零处出现具体 Lead 名或具体 Epic 号(`grep -rn "FLY-2108\|flywheel-eng-lead" packages/teamlead/src/epic-page packages/teamlead/src/bridge/epic-page-route.ts packages/teamlead/src/bridge/linear-epic-query.ts packages/flywheel-comm/src/commands/epic-page.ts` = 0);生成器只收 `(projectName, epic)`;fixture 用 `EPX-n` 中性单号。
- **A4(负向)**:缺 `projectName` / Linear 不可达 / not-found / 超限 / 标签或关系截断 / 项目边界不符 / 文档超限或 schema 失败 ⇒ 对应 400/502/404/422/400 且 **`epic_page` 零新行**(insert spy);StateStore 某格失败 ⇒ 该格与依赖它的格 `missing`(run 失败 ⇒ run/attempt/gates/carriers 四格)、页面照出、**该 item 不进 next**;泄漏哨兵(绝对路径、`Bearer …`)在 JSON/MD/HTML 三方均不出现;「旧 running 行 + 新 completed 行」的子单不进 next;环 ⇒ 环成员 `dependency_cycle`、下游 `blocked_by_dependency_cycle`;标题含 `<script>`、`|`、换行、伪链接的 fixture:HTML 无 `<script`/`on*=`,Markdown 表格行数与小节数不变。
- **A5(真数据,实现节点执行、QA 复核)**:对生产 Bridge 跑 `flywheel-comm epic-page generate --epic FLY-2108`;**同一时刻**记录 Linear 子单状态/关系与六格 StateStore 事实,按 `next.v1` 手算,再断言页面 `next_candidates` 等于手算结果(⛔ 不写死 2140/2144 —— 实现期间 2140 自己就在跑);记录真实调用的 `x-complexity`;`render` → `publish-report --publish-only` 得到一个快照 URL;证据记入 `implementation-evidence.md`。
- **全仓门**:`pnpm lint` · `pnpm -r build` · `pnpm test:packages:run` 全绿;PR 最后一个 commit 只含 `engineering/doc/milestones/FLY-2140.md`。

## 1. 分块与顺序(严格 TDD:每步先写失败测试)

依赖方向:M1 → M2 / M4(可并行)→ M3 → M5 → M6 → M7。

### M1 · 模型、规则、标签、转义(纯逻辑,零 IO)
文件:`packages/teamlead/src/epic-page/model.ts`、`rules.ts`、`labels.ts`、`escape.ts`;测试 `packages/teamlead/src/epic-page/__tests__/{model,rules,escape}.test.ts`。
1. `model.ts`:research §4 的类型逐字落为 `type`(`null` 只表示 missing;`run`/`attempt`/`land`/`session.latest` 是 0/1 元素数组;根上有 `done_definition`);导出 `assertEpicPage(doc)`(research §4 全部断言,每条抛带 `code` 的 `EpicPageSchemaError`;**结构遍历**:遇 Cell 即停,结构容器的键只允许 allowlist / Cell / `items`,其它裸叶子与裸数组一律拒;RFC3339 正则;value 内禁止 `*_at` 键;`items[].identifier` 集合 == `header.children.value` 集合;`EPIC_PAGE_MAX_DOCUMENT_BYTES` 是可由实现期证据选定的常量,合同只冻结「有界 + 超限 422」)、`stripTimestamps(doc)`(递归删 `observed_at`/`source_updated_at`/`generated_at` **三个键,只这三个**)、`contentDigest(doc) = canonicalSubmissionDigest(stripTimestamps(doc))`(文档本身**不含** digest)。
2. `rules.ts`:`computeBatches(items)`(Tarjan SCC:环成员 → `dependency_cycle`,环的下游 → `blocked_by_dependency_cycle`;`released` 由 `blocked_by.value[].blocker_state_type` 在读时算,⛔ 不存派生字段)、`computeNext(items)`(research §5.2:`static ∧ known(六格) ∧ idle(ledger_live_count = 0 ∧ run = [] ∧ attempt 不 open ∧ land = [])`,fail-closed)、`doneDefinition(generatedAt)`(根 `done_definition` 格)、`isFounderNamed(labels)`、`extractAcceptance(description)`(research §5.4 正则,无 `\b` 中文分支;4096 UTF-8 字节、字符边界截断)、`computeGaps(items)`。常量 `FOUNDER_REVIEW_LABEL = "founder-review"`、`RULE_IDS`。
3. `labels.ts`:research §10 的表,`label(key, params?)`;缺 key 抛错(⛔ 不回落到 key 字符串,防新格漏标签)。
4. `escape.ts`:`escapeMarkdownTableCell(s)`(反斜杠、`|`、CR/LF、`[]()` 按 research §9.3);HTML 侧复用既有 `escapeHtml`,⛔ 不再造一个。
RED 用例(先写):分层 {A,E}/{B,C}/{D};`A↔B, B blocks C` ⇒ A、B `dependency_cycle`(detail 含 A、B)而 C 是 `blocked_by_dependency_cycle`(detail 含 B);外部阻塞不改批次但挡 next;canceled 阻塞者释放;priority 0 排最后;next 的 fail-closed 七例(见 T4b);`extractAcceptance` 对 `# 验收`、`## 验收:`、`## 验收标准`、`## Acceptance`、`### Definition of Done` 混级、无标题、>4096 字节多字节截断;`stripTimestamps` 不动 `created_at` 之类的其它键;digest 对只改时间戳的两份文档相等、对改了 value 的不等;守卫对零子单/零阻塞/六格全空文档**通过**、对裸数组/裸叶子/value 内 `*_at` 键/缺 `done_definition`/children 与 items 不一致**拒绝**;`escapeMarkdownTableCell` 对 `a|b`、`a\nb`、`[x](javascript:alert(1))`、`\\` 四例。
完成判据:T1、T2 绿;`labels.ts` 是全模块唯一出现中文标签的文件(测试 grep 断言)。

### M2 · Linear 快照读取
文件:`packages/teamlead/src/bridge/linear-epic-query.ts`;测试 `bridge/__tests__/linear-epic-query.test.ts`(mock `client.client.rawRequest`,与 `linear-query.ts` 同注入方式)。
1. `fetchLinearEpicSnapshot(apiKey, epicKey, {deadlineMs=20_000, maxChildPages=10, maxNestedPages=10, now})` → `LinearEpicSnapshot`(research §2.6);主查询 = research §2.1(Epic 与子单 `labels(first:50)` 带 `pageInfo`;`inverseRelations(first:25)` 带 cursor;关系条目只取直接值),补页 = §2.2(只补关系)。
2. 方向:`blockedBy` 只来自 `inverseRelations` 中 `type === "blocks"`;`isSibling = issue.parent?.id === epic.id`;条目只有 `id/identifier/stateType/isSibling`,⛔ 不带时间键(年龄由格的 `observed_at` 表达)。
3. 子单分页到 `hasNextPage=false`;第 11 页仍有 ⇒ `EpicTooLargeError`;任一子单关系 `hasNextPage` ⇒ 补页直到 false,补 10 页用尽仍有 ⇒ `EpicSnapshotTruncatedError`;Epic 或任一子单 `labels.hasNextPage` ⇒ 同一错误(⛔ 不为标签造 pager)。
4. **一个总 deadline**:每次 `rawRequest` 的 race 超时 = `deadlineAt - now`;到点 ⇒ `LinearUpstreamError`;catch 里消息匹配 `/entity not found|could not be found/i` ⇒ `EpicNotFoundError`(与 `lookupLinearIssueByIdentifier` 同映射 ✅);`issue == null` 亦 ⇒ `EpicNotFoundError`。
5. 快照含 Epic 的 `project.name` 与 `labels`(项目边界用);`description` 只经 `extractAcceptance` 后丢弃(测试断言 `JSON.stringify(snapshot)` 不含 fixture 描述正文的哨兵串)。
RED 用例:方向(fixture 里同时给 `relations` 与 `inverseRelations`,断言只用后者);快照 JSON 里关系条目不含时间键;两页子单拼接;第 11 页抛超限;关系 hasNextPage ⇒ 补页并合并两页;补页 10 页用尽 ⇒ truncated;Epic 标签溢出 ⇒ truncated;子单标签溢出 ⇒ truncated;总 deadline 跨页递减(第二页的超时更短);`issue:null` 与 reject「entity not found」都 ⇒ `EpicNotFoundError`;描述哨兵不泄漏。
完成判据:T8 绿。

### M3 · 生成器(纯函数)+ R1 演练
文件:`packages/teamlead/src/epic-page/generate.ts`;测试 `epic-page/__tests__/{generate,drill}.test.ts`;fixture `epic-page/__tests__/fixtures/epic-shape.ts`(⚠️ 中性单号 `EPX-1…5`,⛔ 不写真实 FLY 号,守 A3)。
1. `generateEpicPage({snapshot, itemFacts, now, projectName, trigger:"manual"})`:`itemFacts: EpicItemFacts[]` 是 M4 **事先一次物化好**的普通数据(每张子单六格,每格 `{ok:true, value} | {ok:false, table}`);生成器零 IO、零回调。`{ok:false}` ⇒ 该格 `missing: statestore_error`,`detail` 只写 `table`(⛔ 不写异常文本);空数组是值。M4 已按依赖传播填好 `{ok:false}`(run 失败 ⇒ 四格),生成器不再猜。
2. 组装顺序:header(含 `children` 观察格)→ items(linear 格 + 六个 statestore 格)→ `done_definition` → batches → founder_items → next_candidates → gaps → `assertEpicPage`;digest 由存储层算(不在文档里)。
3. 演练测试(T4):同一 fixture 的状态机四步(见 §0 A1),每步断言 `next_candidates` 与 `gaps`;末步断言全部 `state.type ∈ {completed, canceled}`。
4. fail-closed 测试(T4b):`session` 格 `statestore_error` ⇒ 该 item 不进 next;`run` 为 active(session latest 空)⇒ 不进;`run` 为 held ⇒ 不进;session latest 终态 + `attempt[0].ledger_open` ⇒ 不进;`land` 非空 ⇒ 不进;**session `ledger_live_count = 1` 而 latest 是 completed(旧 running + 新 completed)⇒ 不进**;两个别名各一行且一行 live ⇒ 不进;**run 格 `{ok:false}` ⇒ run/attempt/gates/carriers 四格 missing ⇒ 不进**;gate/carrier 两格同时 `{ok:false}` ⇒ 不进;六格全空(空数组)⇒ 进且通过 `assertEpicPage`。
RED 用例:golden(A1 首版);零 children ⇒ `header.children.value = []`、`items = []`、`gaps` 含 `no_children`;标签零命中 ⇒ `founder_items.value = []`(不是 missing);`signals` 恒 `[]`;`generator.trigger = "manual"`;`done_definition` 存在、provenance `done.v1`、`observed_at === generated_at`;gate 与 carrier 同时开着 ⇒ 落在两格且 provenance 各指 `workflow_gate_holder` / `workflow_carrier_delivery`;**泄漏哨兵**:fixture 的 session 行 `last_error` 列放绝对路径与 `Bearer …` 串(物化器不投影它),投影方法的 mock `throw` 消息里也放同样哨兵(物化器只输出 `{ok:false, table}`,异常文本只进日志),断言 `JSON.stringify(doc)` 不含任一哨兵。
完成判据:T3、T4、T4b 绿。

### M4 · 存储(StateStore additive,native better-sqlite3 + WAL)
文件:`packages/teamlead/src/StateStore.ts`(新表 + 版本方法 + 四个 facts 投影方法 + `readEpicItemFacts(store, projectName, child)` 物化器);测试 `packages/teamlead/src/__tests__/statestore-epic-page.test.ts`(`StateStore.create(":memory:")` ✅ 既有用法;持久性用例用临时文件)。
1. DDL = research §6.1,放在既有建表序列末尾(additive;`CREATE TABLE IF NOT EXISTS`)。
2. `insertEpicPageVersion`:**一个 `this.db.transaction()`** 内 allocate(`COALESCE(MAX(version),0)+1`)→ INSERT → prune(`version <= new-20`);事务返回即持久(WAL);保留 `this.save()` 调用只为风格一致,**它是 no-op**(✅ `StateStore.ts:2408-2415`),⛔ 不把它写成持久化步骤。`content_digest` 在此处由 `contentDigest(document)` 算出并与 `canonicalJsonString(document)` 一起入行。
3. 读取:私有 `resolveEpicPageKey(project, epicKey) → uuid | null`(uuid 直通;identifier ⇒ 该 identifier 最新一行的 uuid);`getLatestEpicPage(project, epicKey)`、`getEpicPageVersion(project, epicKey, version)`(返回含 `epic_issue_id`)、`listEpicPageVersions(project, epicKey, limit≤50)` 三者共用它。
4. facts 投影(research §3,全部新方法、只读、参数化、双别名、按 `project_name` 过滤、**输出时间列一律 `strftime('%Y-%m-%dT%H:%M:%SZ', col)`、排序一律 `julianday(col)`**):`getEpicPageSessionFact(project, keys)`(同一查询给「最新一行」+ `ledger_live_count` 聚合;⛔ 不投影 `last_error`)、`getEpicPageRunFact(project, keys)`(含 `snapshot` 与 `template_id`;标签 = `parseWorkflowRunSnapshot(snapshot).manifest.nodes.find(id)` → `workflowNodeDisplayLabel(template_id, node)`,解析失败回落 id 并标 `label_source:"id"`)、`getEpicPageAttemptFact(run_id, node_id)`(含时间列)、`getEpicPageLandFact(project, keys)`(含 `pr_number`);`gates`/`carriers` 复用 `listOpenGateAuthorities` 按 `kind` 分两格。`readEpicItemFacts` 把调用包成 `{ok,value}|{ok:false,table}`,⛔ 不抛出、⛔ 不带异常文本(异常只进 Bridge 日志);**依赖传播**:run 查询失败 ⇒ run/attempt/gates/carriers 四格都 `{ok:false}`;UNION 查询失败 ⇒ gates/carriers 两格都 `{ok:false}`;路由对全部子单跑完一遍再交给生成器。
RED 用例:版本单调(含裁剪后);第 21 版写入后只剩 20 行且最新在;**临时文件建库写入后 `StateStore.create` 重开能读到同一行**;digest round-trip(`row.content_digest === contentDigest(JSON.parse(row.document))` 且 `row.document === canonicalJsonString(doc)`);identifier 改名后三个读取方法按旧名与 uuid 都取到同一版本链;facts:跨 project 同别名只取本项目;同时间 tie-break 按 execution_id 稳定;「旧 running + 新 completed」⇒ latest 为 completed 且 `ledger_live_count = 1`;**混合时间格式**:同一子单一行 `…T02:00:00Z`、一行 `2026-09-03 03:00:00`,latest 必须是后者;custom 模板的 label 来自 manifest node(不是 legacy 表也不是 id);land 按 identifier / uuid 两种写法都命中;**用 DDL 默认 `datetime('now')` 写入的 run/attempt 行,投影出的时间通过 RFC3339 守卫**;SQL 异常映射为 `{ok:false, table}` 而非抛出,且 run 异常时四格同时 `{ok:false}`。
完成判据:T5 绿;`sqlite3 … ".schema epic_page"` 与 research §6.1 逐字一致(实现期贴进 evidence)。

### M5 · 路由 + 两种渲染
文件:`packages/teamlead/src/bridge/epic-page-route.ts`、`epic-page/render-html.ts`、`epic-page/render-markdown.ts`;`plugin.ts` 挂载(仿 `/api/runs` ✅ L4213-4222,`config.apiToken` 缺失时不挂载);测试 `bridge/__tests__/epic-page-route.test.ts`、`epic-page/__tests__/render.test.ts`。
1. `createEpicPageRouter({store, projects, linearApiKey, fetchSnapshot, now})`;路由与状态码 = research §7;POST 先判 `projectName` 为非空字符串(否则 400 `project_required`,⛔ 不把 `undefined` 交给 helper),再 `resolveProjectNameParam`(未知 404 / 无绑定 404 ✅ `linear-scope.ts:41-79`);`epic` 正则;快照后 `issueMatchesBinding(epic, binding)` 三项(✅ `:113-123`),不符 ⇒ 400 `epic_outside_project`;GET/versions 把 `:epic` 当 `epicKey` 交存储层解析,⛔ 不解析 document。
2. generate 串行:按 `(project, epic)` 键的进程内 promise 链;**任何失败路径都不调 `insertEpicPageVersion`**(测试用 spy 断言零调用);生成后 `assertEpicPage` 失败 ⇒ 422 `epic_page_too_large` / `epic_page_invalid`。
3. `render-markdown.ts` / `render-html.ts`:输入 `EpicPage`,输出字符串;小节顺序与标题**只**来自 `labels.ts`;「做完算什么样」小节只从 `done_definition` 格读;Markdown 表格之后每张子单一个小块:验收全文、全部阻塞者、六个执行格、每格「出处 · 时间」(表格只是索引);HTML 全部动态文本经 `escapeHtml`(`bridge/xhs-review-html.ts:24` ✅),url 只在 `startsWith("https://linear.app/")` 时成 `<a>`;Markdown 全部动态表格值经 `escapeMarkdownTableCell`;无 `<script>`;样式内联 Apple-light;每格渲染「出处 · 看到它的时间」;next 小节带「未获 founder 裁定的默认规则 next.v1(PRD §8-2)」与「账面状态,不代表进程一定活着」两句(labels `section.next`、`cell.ledger_note`)。
4. parity 与全 Cell 渲染门(T7):同一 golden fixture 对模型的每一条 Cell 路径(`header.title` `header.url` `header.state` `header.children` `done_definition` `batches` `founder_items` `next_candidates` `gaps` 与每张子单的 `title` `url` `state` `priority` `blocked_by` `batch` `acceptance` `founder_named` `session` `run` `attempt` `gates` `carriers` `land`(共 9 + 14 条路径,与 §4 模型逐一对应))各放唯一哨兵值/标记,逐路径断言 MD 与 HTML 都含它且旁边有 provenance 标识与 ISO observed_at,漏一条即失败;`done_definition` 的值与规则号在 JSON/MD/HTML 一致;泄漏哨兵不出现;identifier 集合与 next 集合三方相等。
RED 用例:401(无 token)/403(scoped token)/400(`project_required` 缺失与空串两例;坏 epic 格式;`epic_outside_project` 三例:跨 team、同 team 不同 project、缺 scope label)/404(unknown_project;已知项目无绑定;no_page;`epic_not_found` 由 `issue:null` 与 reject 两种触发)/422(`epic_too_large`;`epic_snapshot_truncated` 三种触发;`epic_page_too_large`;`epic_page_invalid`(注入非 size 的 schema 失败))/501(无 LINEAR_API_KEY)/502(Linear 超时)各一,**每个失败断言 insert spy = 0**;两次并发 generate 版本号 1、2 不交错;`?format=md|html|json` 的 Content-Type;用 DDL 默认时间的 run/attempt 行走一遍 generate 通过守卫;`<script>` 与 `onerror=` 注入 fixture 被转义;`javascript:` url 不成链接;Markdown 对 `|`、换行、`[x](javascript:…)` 标题行数与小节数不变;标签零命中渲染含「0 件」;派生格渲染含规则号与「未获 founder 裁定」字样。
完成判据:T6、T7 绿;`plugin.ts` 改动 ≤ 15 行(只挂载)。

### M6 · CLI(flywheel-comm)
文件:`packages/flywheel-comm/src/commands/epic-page.ts`;`index.ts` 加 `case "epic-page"`;测试 `packages/flywheel-comm/src/commands/__tests__/epic-page.test.ts`(注入 `fetchFn`/`writeFile`/`exit`,仿 `feature-flags.ts` 的 deps 形状 ✅)。
1. 三个子命令与参数 = research §8;URL/项目/Token 解析顺序 = research §8;缺 token ⇒ envelope `{ok:false, error:"missing_token"}` + exit 1;缺 project(无 `--project` 且无 `FLYWHEEL_PROJECT_NAME`)⇒ `{ok:false, error:"missing_project"}` + exit 1。
2. stdout 恒一行 JSON envelope;`show --format md` 时 envelope 里 `markdown` 字段带正文,同时 stderr 打印正文供人读(⛔ 不破坏 stdout 单行合同)。
3. `render --out` 落盘后回读并断言字节相等;>512KB 时 stderr 警示「超过 publish-report 托管上限」;⛔ 不发布、不投递。
4. `flywheel-comm --help` 的命令表加一段(与既有格式一致)。
RED 用例:三子命令各一条 happy path;缺 token;缺 project;Bridge 4xx/5xx 透传成 `{ok:false,status,error}`;`render` 回读一致;>512KB 警示。
完成判据:T9 绿;`node packages/flywheel-comm/dist/index.js epic-page --help` 有输出。

### M7 · 真数据演练与证据(A5)
1. 本机对生产 Bridge(只读 Linear、写一版到 `epic_page`)跑 `generate/show/render`;**同一时刻**用 Linear API 与只读 SQL 记下每张子单的状态/关系与六格事实,按 `next.v1` 手算 next,与页面比对;把 `show --format md` 输出、`SELECT version, generated_at, content_digest FROM epic_page` 结果、真实调用的 `x-complexity`、canonical JSON 与 HTML 字节数、快照 URL 记入 `engineering/doc/FLY-2140-epic-page-content-model/implementation-evidence.md`。
2. ⛔ 不给 FLY-2108 子单打标签、不改 Linear 关系(那是 Lead 的运维动作,§7);演练只读 Linear。
3. 若生产 Bridge 未部署新版(合并 ≠ 部署,仅 updater 窗口部署),演练在 529 房或本机临时 Bridge 上做,并在 evidence 里写明「非生产实例」。
完成判据:evidence 文件含上述各项 + `pnpm lint/build/test` 三条命令的原始尾部输出。

## 2. 稳定标识与显示标签

| 类 | 稳定标识(⛔ 不改) | 显示标签(只在 `labels.ts`) |
|---|---|---|
| 表 | `epic_page` | — |
| 规则 | `batch.v1` · `next.v1` · `founder.v1` · `done.v1` · `gaps.v1` | 「未获 founder 裁定的默认规则 next.v1」等 |
| 标签常量 | `founder-review` | 「这个 Epic 里要回来找她的」 |
| 路由 | `/api/epic-page/generate` · `/api/epic-page/:projectName/:epic[/versions]` | — |
| CLI | `epic-page generate\|show\|render` | — |
| 文档键 | `schema_version:1` · `generator.version:"epic-page/1"` · `trigger ∈ manual\|event\|scan` · `header.children` · `done_definition` · item 格 `title/url/state/priority/blocked_by/batch/acceptance/founder_named/session/run/attempt/gates/carriers/land`(执行格值为 0/1 元素数组) | — |
| 常量 | `FOUNDER_REVIEW_LABEL` · `EPIC_PAGE_MAX_DOCUMENT_BYTES`(值由实现期证据选定,写进 milestone;合同只冻结「有界 + 超限 422」) | — |
| 错误码 | `project_required` · `unknown_project` · `epic_outside_project` · `epic_not_found` · `linear_unavailable` · `epic_too_large` · `epic_snapshot_truncated` · `epic_page_too_large` · `epic_page_invalid` · `no_page` · `missing_token` · `missing_project` | — |
| missing 原因 | `no_acceptance_section` · `dependency_cycle` · `blocked_by_dependency_cycle` · `statestore_error` · `no_children` | 「缺什么、缺在哪」小节 |

节点显示标签**不**在本单定义:一律 `workflowNodeDisplayLabel(template_id, manifestNode)`(`workflow-display-labels.ts` ✅),node 来自 pinned snapshot 的 `manifest.nodes`。

## 3. 迁移与回滚

- 迁移:全部 additive —— 一张新表(`IF NOT EXISTS`)、新方法、新路由、新 CLI 子命令;不改任何既有表、既有方法签名、既有路由、既有 flag registry、patrol、workflow 引擎。
- 回滚:revert PR 即回现状;`epic_page` 表留在库里无人读写,无害;⛔ 不加 flag(铁律,且没有需要开关的运行时行为:不调用就不发生)。
- 自托管:合并与部署分离;本单不请求 ship;部署由 updater 窗口完成。

## 4. 失败路径(显式)

| 失败 | 处置 | 证据 |
|---|---|---|
| POST 缺 `projectName` / 空串 / 非字符串 | 400 `project_required`;零写入 | T6 |
| Linear 不可达 / 总 deadline 到点 | 502 `linear_unavailable`;零写入 | T6/T8 |
| Epic 不存在(`issue:null` 或 SDK reject not-found) | 404 `epic_not_found`;零写入 | T6/T8 |
| 项目未知 / 已知但无 linear 绑定 | 404;零写入 | T6 |
| Epic 不在项目绑定内(team / project / label 任一不符) | 400 `epic_outside_project`;零写入 | T6 |
| 子单 > 500 | 422 `epic_too_large`;零写入 | T8 |
| Epic 或子单标签 > 50;关系补页 10 页用尽仍有下一页 | 422 `epic_snapshot_truncated`;零写入 | T6/T8 |
| 文档超过 `EPIC_PAGE_MAX_DOCUMENT_BYTES` / schema 守卫失败 | 422 `epic_page_too_large` / `epic_page_invalid`;零写入 | T2/T6 |
| `LINEAR_API_KEY` 未配 | 501 | T6 |
| StateStore 某格查询异常 | 该格与依赖它的格 `missing: statestore_error`(run ⇒ 四格;UNION ⇒ gates+carriers),`detail` 只含表名;页面照出并写版本;**该 item 不进 next** | T3/T4b/T5 |
| 同一子单账面同时有旧 live 行与新终态行 | `ledger_live_count ≥ 1` ⇒ 不进 next(展示仍是最新行) | T4b/T5 |
| StateStore 时间列是 `datetime('now')` 格式 | 投影 `strftime` 出 RFC3339;解析失败 ⇒ 不填 `source_updated_at` | T5/T6 |
| 依赖成环 | 环成员 `dependency_cycle`(点名环),下游 `blocked_by_dependency_cycle`;next 仍按可解除性算 | T1 |
| 标签不存在或零命中 | `founder_items = []`,渲染「0 件」;⛔ 不 missing、不隐藏 | T3/T7 |
| 并发 generate | 串行;版本单调 | T6 |
| CLI 缺 token / 缺 project / Bridge 错误 | exit 1 + envelope 错误码 | T9 |

## 5. 负向守卫(边界校验)

- 外部输入:`projectName`(非空字符串 + 配置命中 + 绑定存在)、`epic`(正则)、`version`(正整数)、`format`(枚举);其余一律 400。
- SQL:全部参数化(`?` 绑定;IN 列表按 key 数展开占位符,与 `getSessionsForIssueAliases` 同法 ✅),⛔ 无字符串拼接(测试 grep 断言 `epic_page` 相关 SQL 无 `${`)。
- HTML:Linear/StateStore 文本一律 `escapeHtml`;url 白名单前缀;零 `<script>`、零内联事件;founder 视图不含任何令牌/路径/环境值。
- Markdown:动态表格值一律 `escapeMarkdownTableCell`;小节标题只来自 `labels.ts`。
- 泄漏:文档不含 `description` 正文、不含 worktree 路径(只保留 `branch`)、**不含 `last_error`**、`missing.detail` 不含异常文本;错误响应不含内部路径;T3/T7 用绝对路径与 `Bearer …` 哨兵断言 JSON/MD/HTML 三方都不出现。
- 权限:master token 才能生成/读取;scoped token 403;ingest token 401(runner 打不开这个面是有意的)。
- 措辞:页面对执行体的判断只说「账面」,⛔ 不说「进程活着/死了」。

## 6. 测试与证据矩阵

| # | 内容 | 位置 |
|---|---|---|
| T1 | 规则:分层/SCC 环 + 下游/外部/取消/排序/验收段抽取六例;Markdown 转义四例 | `epic-page/__tests__/{rules,escape}.test.ts` |
| T2 | schema 守卫各一反例(裸叶子/裸数组/坏时间/坏 provenance/坏 pointer/null 无 missing/value 内 `*_at` 键/signals 非空/children≠items/缺 done_definition/超过上限常量);零子单、零阻塞、六格全空通过;`stripTimestamps` 只删三键;digest 稳定 | `epic-page/__tests__/model.test.ts` |
| T3 | 生成器 golden + 零 children + 标签零命中 + 空是值 + gate/carrier 两格 + done_definition + 泄漏哨兵 | `epic-page/__tests__/generate.test.ts` |
| T4 | **R1 演练四步** | `epic-page/__tests__/drill.test.ts` |
| T4b | next.v1 fail-closed 十例(含失败传播两例) | 同上 |
| T5 | 存储版本/裁剪/重开可读/digest round-trip/epicKey 三方法改名/facts 投影(跨项目、tie-break、live 聚合、混合时间格式排序、manifest label、land 双别名、strftime 穿透、失败传播) | `src/__tests__/statestore-epic-page.test.ts` |
| T6 | 路由状态码矩阵(含 `project_required`、边界三例、not-found 两种、截断三种、`epic_page_invalid`)+ 每个失败零写入 + 串行 + Content-Type + DDL 默认时间穿透 | `bridge/__tests__/epic-page-route.test.ts` |
| T7 | HTML 转义 + url 白名单 + Markdown 转义 + **全 Cell 路径渲染门(9 + 14 条,值/标记 + 出处 + ISO 时间)** + done_definition 三方一致 + 泄漏哨兵 + parity + 规则号与「未获 founder 裁定」可见 + 「0 件」 | `epic-page/__tests__/render.test.ts` |
| T8 | Linear 查询方向/关系条目无时间键/分页/补页/三种截断/总 deadline/not-found 两种/描述不泄漏 | `bridge/__tests__/linear-epic-query.test.ts` |
| T9 | CLI 三子命令 + 缺 token + 缺 project + 透传 + 回读 + 512KB 警示 | `flywheel-comm/src/commands/__tests__/epic-page.test.ts` |
| T10 | 真数据演练(同一时刻证据 → 手算 → 比对;`x-complexity`;字节数) | `implementation-evidence.md` |
| A3 | 通用主语 grep = 0 | 实现节点收尾脚本一行,输出贴 evidence |

## 7. 运维说明(写给任意 Lead)

1. **一次性**:在项目的 Linear 团队里创建标签 `founder-review`(名字逐字);给这个 Epic 里「她点过名要回来找她」的子单打上它;非 issue 形态的事(某个待她拍的问题)建成一张带该标签的子单。标签不存在时页面不会报错,只会显示「0 件」—— 那是在提醒你去建。
2. **依赖**:在 Linear 上用 blocks 关系表达先后(A blocks B = B 排在 A 之后)。页面**不会**从正文猜依赖;零关系时显示「未登记依赖」,所有子单落在第 1 批。
3. **项目绑定**:页面只为 `~/.flywheel/projects.json` 里有 `linear` 绑定的项目生成,Epic 必须落在该绑定的 team / project / scope label 内;不符会被拒(`epic_outside_project`),不会生成一页错项目的页面。
4. **生成/查看**:`flywheel-comm epic-page generate --epic <EPIC> --project <project>` → `epic-page show --epic <EPIC> --project <project> --format md`;第一行「现在可以开始的」是**默认规则 next.v1** 推出的候选(PRD §8-2 尚未由 founder 裁定,规则可换);它判的是「账面上有没有执行体」,不代表进程一定活着。
5. **给她看**:`epic-page render --epic <EPIC> --project <project> --out /tmp/epic.html` → `publish-report --html /tmp/epic.html --project <project>`;托管链接是快照,7 天过期(已知,活页面归 FLY-2143)。
6. 每一格旁边的「出处 · 看到它的时间」就是它的可信度;看到时间旧了,再生成一次即可(自动刷新归 FLY-2143)。

## 8. 明确不做

事件/扫描自动更新与过期告警(D);残余扫描与空位拉活、派发/容量判断(B/E);依赖账本与三类更新(C);quota/内存输入与 dag-resolver 退役(E);修 `LinearGraphBuilder` 的方向(随 E 退役);Discord 投递(既有 publish-report);孙单展开;已归档计数;标签分页;OS 进程活性探测;任何 flag。

## 9. 给实现节点的实现期检查(research §12 盲区)

1. 用生产库只读查一次 `SELECT issue_id FROM workflow_run LIMIT 20`、`SELECT issue_id FROM land_operation LIMIT 20` 与 `sessions`,确认 uuid/identifier 分布,证明双别名查询覆盖;结果贴 evidence。
2. 第一条真 API 测试:对 FLY-2108 跑 M2 的 `fetchLinearEpicSnapshot`,核 `includeArchived` 与嵌套 `first/pageInfo` 被接受、方向与 research §2.3 一致、记录 `x-complexity`。
3. 用 fixture 生成器造一份 ≥200 子单的 synthetic 文档,量 canonical JSON 与 HTML 字节;按 research §4 第 7 条的公式选定 `EPIC_PAGE_MAX_DOCUMENT_BYTES`,值与实测写进 `engineering/doc/milestones/FLY-2140.md`(合同只冻结「有界 + 超限 422 + 零写入」,评审过的 acceptance 不变)。
4. `plugin.ts` 挂载后确认 `GET /api/epic-page/…` 在无 `apiToken` 配置时为 404(未挂载),有配置无 header 时 401。
5. `parseWorkflowRunSnapshot` 对 v1/v2 快照都返回 `manifest.nodes`(带可选 `label`);写测试前先各拿一份真实 snapshot 行核形状。
6. 生产库里 `sessions.last_activity_at` / `workflow_run.created_at` 各抽 5 行看实际格式(`datetime('now')` 还是 ISO),确认 `strftime` 两种都吃。

## 10. 与兄弟单的冻结点(本单交付后不再变的合同)

`EpicPage` 的字段名与 `Cell` 结构(含 `header.children`、`done_definition`、`blocked_by` 只含直接值、item 六个执行格为 0/1 元素数组、`null` 只表示 missing、value 内无 `*_at` 键);五个规则号;`trigger` 三值;`epic_page` 表名与主键;`content_digest` 只在行/envelope 且去时间戳;`/api/epic-page` 路径;`FOUNDER_REVIEW_LABEL`;`signals: []` 预留位。B/C/D/E 只能**追加**字段与值,⛔ 不改上述。

## 11. Design correction · 2026-09-03 founder 裁定（implement@7）

> 本节是 2026-09-03 12:44–12:50 PT 的 founder 新裁定，明确覆盖上文已经钉住但现已被否决的批次、单 Epic 范围和 StateStore 页面权威副本设计。旧段落保留为审计历史；实现与验收一律以本节为准。

### 11.1 Founder 逐字原话

> 「为什么他那个第一批、第二批、第三批，每一批只有一件事情？…我们不一定非要分 batch。…基本上不用分所谓的 batch，做完一件补一件，一直保证项目内有足够多的 issue 在跑就可以了。所以我们可能不需要分批，唯一要理清的就是 dependency。」

> 「它就像一个数据库或者 DAG…到时候 Lead 去执行的时候，更多是看当前所有没有 dependency 的事情，抓一个排在前面的来做，跟我们有多少个 epic 没关系。」

> 「整个 HTML 主要是给我看的…但对 Lead 来说，这其实是把 Linear 里的东西又拿出来做了一遍，增加了 multiple source of truth。」

范围选项由 founder 逐字回复「C」：范围 = 当前 active 的几个 Epic 的子树 ∪ 一个常驻「日常」筐（bug / 小需求），再过滤掉 Backlog；优先级只用于在「现在能做的」里排先后，不用于定义范围。

### 11.2 废除的概念

- 废除 `batch`。内容模型删除 item `batch`、根 `batches` 和 `batch.v1`；HTML / Markdown 删除「批次顺序」「第 N 批」「依赖 · 批次」及按批次分组。依赖边不再被投影成一层额外数据。
- 废除单 Epic children 就是全范围的假设。页面范围改为项目级显式声明，横跨多个 active Epic，并包含常驻日常筐。
- 废除把页面文档当计划权威副本、把计算后的顺序写入 StateStore 的做法。Linear 是范围、状态、优先级和 `blocked_by` 边的唯一真相；页面是按请求生成的只读投影，不写新的计划数据库，也不持久化 ready 排序。
- `next.v1` 及其「未获 founder 裁定的默认规则」文案废除；本次 founder 已经裁定 ready 规则，不能再称默认规则。

### 11.3 保留的器官

- 每张范围内 issue 一张卡，保留「是什么 / 为什么 / 做完你看到 / 状态 / 账面执行体 / 是否回来找 founder」。验收缺失仍逐字显示「缺验收」。
- 每一格仍必须有出处锚点、`observed_at`，Linear 可提供更新时间的格仍有 `source_updated_at`；无出处即 schema / generation fail-loud。
- 每张卡底部用一行小字收口出处链接、看到时间、来源更新时间；完整逐格审计仍可折叠查看。Markdown / HTML 两种形态保持同一模型。
- `founder-review` 标签、验收提取、StateStore 六格执行事实、转义边界、大小上限和所有负向 fail-closed 守卫保留。

### 11.4 新范围合同：Linear 父单状态是显式声明

实现期向 Lead 核实后，**不**把绑定的 Linear Project membership 当 active 范围：本工作区的 `Flywheel` Project 装着数千张历史与当前 issue，只按 Project 会错误地把它们全算成要做。选择 founder 允许的最简单 Linear 原生载体：**父单自身的 workflow state**。

- 普通 active Epic = 一张状态 `type === "started"` 且有子单的父单；把 Epic 拖进 / 拖出 In Progress 一族就是唯一范围维护动作。
- 日常筐 = 标题包含「日常」、状态同样是 `started` 的常驻父单；bug / 小需求挂在它下面。它与普通 Epic 使用同一 parent / child 结构，不增加 label 或配置。
- 范围 = 上述所有父单的完整子树，再过滤子单中 `state.type === "backlog"` 的 issue；父单本身只出现在范围总览，不作为子单卡。
- 查询仍受既有 `projectName → linear` team / project / scope-label 边界约束，但这些绑定只防跨项目读取，不定义 active 集合。零个 active 父单、声明父单或子树读不到、分页/关系读取不完整时，生成失败并且不猜、不回退成全 Project。
- `blocked_by` 是唯一持久化的先后关系，来自 Linear relation；卡片把它渲染成「等谁」，并由同一组边反向推导「谁在等我」，两边都引用具体 issue identifier + title。
- 页面 key 改为 Flywheel project + 本次 active root 集合的观测身份；原 `epic` 请求参数不再定义范围，避免调用者另传一份范围。

### 11.5 Ready set（首屏第一块）

根派生格改为 `ready_items`，规则号 `ready.v1`。一张 issue 进入 ready set 当且仅当：

1. 它在上述显式范围内；
2. 它不是 Backlog，且自身不是 `completed` / `canceled` 终态；
3. 它的每一条 `blocked_by` 所指 issue 的 Linear state 都是 `completed`。

结果只在生成时计算，按 Linear priority（1→4，0 无优先级排最后）再按 identifier 稳定排序，不写回 Linear 或 StateStore。首屏顺序固定为：现在可以开始的 → 项目范围总览 → 必须回来找 founder → 做完定义 / 缺口。执行六格只提供上下文，不参与 ready 规则；这避免让页面里的第二份执行状态覆盖 Linear 的可执行关系。

既有 `epic_page` 表降级成**只写的渲染回执**：只记录这一版何时生成、基于哪些 Linear / StateStore 源，不保存 `ready_items` 或任何 batch / next / 排序推导，也没有渲染代码从该表回读。其唯一用途是给 FLY-2143 留下“这张页面多旧”的地基，不是计划或调度权威。

`ready_items` 的 derived provenance 必须列出每张 issue 的 `state`、`priority`、`blocked_by` 输入 Cell 路径并写明 `ready.v1`；反向「谁在等我」必须列出它读取的 `blocked_by` Cell 路径。因为 `ready.v1` 已获 founder 裁定，渲染不得再附「未获 founder 裁定的默认规则」。

### 11.6 纠偏后的 TDD 与门禁

1. 先以 schema / rule 测试证明 `batch` / `batches` / `batch.v1` 被拒绝或不存在，`ready_items` 严格按三条条件和 priority 排序，canceled blocker 不会错误释放下游。
2. Linear 读取测试证明 Project 声明缺失 fail-loud、完整分页、Backlog 过滤、依赖标题与状态齐全、截断/超限不生成半页。
3. 生成器与 route / CLI 测试证明不要求单 Epic 参数；渲染每次走 live query；渲染回执若出现 `batch` / `next_candidate` / `ready_items` 任一字段即失败；错误路径零回执写入。
4. HTML / Markdown parity 测试证明首屏 ready 为第一块，每张卡只有「等谁 / 谁在等我」而零「批次」字样，所有 Cell 的出处与时间仍可见。
5. 重新执行精确全仓门、exact-head code review、CI、截图/视觉核验；本节不扩到 FLY-2141/2142/2143 的自动更新、巡检拉活或过期自报。
