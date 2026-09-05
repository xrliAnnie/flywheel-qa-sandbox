# FLY-2142 依赖账本 — 调研
Issue: FLY-2142 (https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢)
日期: 2026-09-04
基于: exploration.md

> 世界标记同 exploration.md:[main] `e85eec9a8` · [prd] v2.4 · [linear] as-of 2026-09-04T03:51Z(§9 的历史码另有 04:0x Z 一次复查)。
> 本文档只写**合同与数字**:每条路由、每个字段、每个错误码、每条 SQL/GraphQL、每个上界。取舍理由在 exploration.md,顺序与证明在 plan.md。

---

## 1. Linear 侧的四条查询 / 变更(全部经 `@linear/sdk` 60.0.0,Bridge 持 key)

### 1.1 解析一张单(复用,✅ `bridge/linear-query.ts:196`)
`lookupLinearIssueByIdentifier(apiKey, idOrIdentifier)` → `{ id, identifier, title, state, stateType, labels, project, … } | null`;它已被 `/api/linear/comment` 与 `/api/linear/comments` 用作边界检查输入(`issueMatchesBinding`)。本单每个写路径对 `blocker` 与 `blocked` **各调一次**,两张都必须命中且都在绑定内。

### 1.2 加边(新)—— Codex R2-1 后:relation id 由调用方指定 = 本次 `operation_id`
```ts
const payload = await client.createIssueRelation({
  id: operationId,            // ✅ IssueRelationCreateInput.id:"The identifier in UUID v4 format. If none is provided, the backend will generate one."
  issueId: blocker.id,        // 挡人的
  relatedIssueId: blocked.id, // 被挡的
  type: "blocks",             // 字面量,类型标注 LinearDocument.IssueRelationType
});
if (payload.success !== true) throw …;
const relation = await payload.issueRelation; // { id, createdAt };要求 relation.id === operationId
```
✅ 类型:`_generated_sdk.d.ts:21835`;`IssueRelationCreateInput` = `id? / issueId / relatedIssueId / type`(`_generated_documents.d.ts:7532-7541`)。
方向核对:exploration §2.6 的真数据里 `FLY-2140.relations` 含 `blocks → FLY-2142`,`FLY-2142.inverseRelations` 含 `blocks ← FLY-2140` ⇒ `issueId` = 挡人的那张。
**为什么 id = operation_id**:边已存在时,Bridge 从 `inverseRelations` 读到的 `relation.id` 若等于本次 `operation_id`,就**证明**这条边是本 op 上一次(响应丢失的)写入建的,可以安全补记 `added` 评论;若不相等,这条边是别人建的(founder 直改 / 另一进程),⛔ 不得以本 op 的名义写 `added` 评论(§2.6 第 2 条)。这要求每条边的 `operation_id` 都是**真 uuid v4**(§3 由 CLI 生成;discover 的每条边各自一个,父操作另记 `parent_op`)。
adapter 签名据此为 `createRelation({ id, blockerId, blockedId })`(Codex R3-1)。
**这项能力必须在 M3 之前验证**(plan M0,Codex R3-1):Linear 是否接受调用方 id、`inverseRelations.nodes[].id` 是否原样返回它、同一 id 重复 create 的行为。两个分支的合同**现在都定死**(§2.8),M0 的结果只决定实现走哪个分支,⛔ 不改 plan。

### 1.3 删边(新)
```graphql
query BlockedByRelations($id: String!, $after: String) {
  issue(id: $id) {
    inverseRelations(first: 50, after: $after) {
      nodes { id type issue { id identifier } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```
在 `blocked` 的 `inverseRelations` 里找 `type === "blocks" ∧ issue.id === blocker.id` 的那条 → `client.deleteIssueRelation(relation.id)`(✅ `:21842`,返回 `DeletePayload{ success }`)。分页上界 🔶 10 页(与 epic-page `maxNestedPages` 同值);超界 ⇒ 422 `relations_truncated`,不写。找不到 ⇒ 404 `relation_not_found`,不写。

### 1.4 环检查(新,只读,加边前)
从 `blocker` 出发,沿「谁挡着它」向上 BFS:
```graphql
query BlockersOf($id: String!) {
  issue(id: $id) { id identifier
    inverseRelations(first: 50) { nodes { type issue { id identifier } } pageInfo { hasNextPage } } } }
```
- 访问集合 ≤ 🔶 **200** 个节点;任一节点 `inverseRelations.hasNextPage` 或访问超界 ⇒ 422 `cycle_check_unbounded`,不写(对上界的判断:epic-page 全范围上限 500,单条依赖链在实际里 < 10);
- 遍历中遇到 `blocked.id` ⇒ 409 `dependency_cycle`,响应带 `path: [identifier…]`(从 `blocked` 回到 `blocker` 的链);
- 遍历前:`blocker.id === blocked.id` ⇒ 400 `self_dependency`;`blocked` 已直接挡 `blocker`(第一层就命中)是 `dependency_cycle` 的特例,同一错误码;
- 同一遍历顺带得出「边已存在」(第一层里 `blocked` 的 blocker 集合含 `blocker`)—— 这需要 `blocked` 的第一层,单独查一次 §1.3 的查询即可,总请求数 = 2 + BFS 节点数。
- 总 deadline 🔶 20 s(与 epic-page 同),每次 `rawRequest` 用剩余时间 race(复用 `linear-epic-query.ts:204-232` 的写法,抽成本模块私有 helper,⛔ 不改原文件)。

### 1.5 账本条目(评论,新)—— Codex R1-4 / R2-6 后:「人读首行 + base64url 机器行」
`client.createComment({ issueId: blocked.id, body })`(✅ 与 `/api/linear/comment` 同一调用)。body 由服务端从**已校验字段**拼出,恰好两行:
```
[dependency-ledger] not_needed: FLY-2141 blocks FLY-2143 — removed · 2141 的扫描面已并入 2143 自己的路径
dl1:eyJhY3Rpb24iOiJyZW1vdmVkIiwiYXQiOiIyMDI2LTA5LTA1VDAxOjAyOjAzWiIs…
```
- 第 1 行 = 前缀常量 `DEPENDENCY_LEDGER_PREFIX = "[dependency-ledger]"` + 人读摘要 + `reason` 的展示版(换行折成空格、截到 200 字符);纯展示,解析器不读它。
- 第 2 行 = `dl1:` + **base64url(canonical JSON)**。base64url 字母表是 `A-Z a-z 0-9 - _`(Codex R3-8:准确说法是「含 `-` 与 `_`,不含反引号、星号、井号、方括号、尖括号」);`_` 单独出现且不成对包裹时通常不触发强调,**显示层以 M7 的真实渲染为证据**。这样 `reason` 含任意反引号 / Markdown 都不会破坏机器行(Codex R2-6:单反引号 code span 会被 reason 里的反引号提前闭合)。
- canonical JSON(`canonicalJsonString`,键按字典序)精确键集:`v / op / parent_op / relation_id / evidence / kind / action / blocker / blocked / claimed_actor / at / reason`;`parent_op` 对非 discover 为 `null`;`relation_id` = 这次操作涉及的 Linear relation id(add:建出来的;remove:删掉的;note:当前存在的边 id 或 `null`);`evidence ∈ mutation | state | lead_ack`(§2.6 第 4 条)。
- `parseLedgerComment(body)`:第 1 行必须以前缀开头;第 2 行必须匹配 `^dl1:[A-Za-z0-9_-]+$`;解码 + JSON 解析成功、键集精确、`v === 1`、`op` 是 uuid v4、`parent_op` 是 uuid v4 或 null、`relation_id` 是非空字符串或 null、`evidence` 在枚举内、identifier 匹配正则、`kind/action` 在枚举内且组合合法(§2.6 第 7 条矩阵)、`at` RFC3339;任一不满足 ⇒ 返回 `{ unparseable: true }`(`log` 里以 `source:"ledger_comment", unparseable:true` 原样列出,不丢)。
- **合同常量放 `flywheel-config`**(Codex R3-3:`flywheel-comm` 不依赖 `flywheel-teamlead`,反向 import 成环):新文件 `packages/config/src/dependency-ledger-contract.ts`,从 `packages/config/src/index.ts` 导出 `DEPENDENCY_LEDGER_PREFIX`、`LEDGER_MACHINE_LINE_PREFIX = "dl1:"`、`OPERATION_ID_RE`、`LEDGER_KINDS`、`LEDGER_ACTIONS`、`KIND_ACTION_MATRIX`、`LEDGER_EVIDENCE`、`LEDGER_COMMENT_KEYS`;builder / parser 仍在 teamlead。
| 字段 | 取值 |
|---|---|
| `op` | **operation_id**:uuid v4(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),CLI 生成、随请求体传入;**同时是 add 时交给 Linear 的 relation id**(§1.2,主分支);同一次 Lead 意图无论重试几次都用同一个;服务端据它做「评论已记过 / 内容冲突」与「边是不是本 op 建的」判定(§2.6) |
| `parent_op` | discover 的父操作 uuid v4;其它为 `null` |
| `relation_id` | Linear relation id 或 `null`(见上) |
| `evidence` | `mutation`(评论由做了 mutation 的同一请求写)· `state`(note 核对了当前边状态)· `lead_ack`(note `--backfill`,Lead 显式认账,未核状态) |
| `kind` | `missed` (add) · `not_needed` (remove) · `discovered` (discover 里的每条 add) |
| `action` | `added` · `removed`;合法组合只有 `missed→added`、`discovered→added`、`not_needed→removed` |
| `claimed_actor` | 请求体 `claimed_actor`(🔶 可选,`^[a-z0-9-]{1,64}$`,通常 = `FLYWHEEL_LEAD_ID`);缺省 `unspecified`。**它只是调用者的声明**;真正的作者由 Linear 返回的 `comment.user / botActor` 给出,`log` 两者并列展示 |
| `reason` | 请求体必填;1–2000 字符;去掉 `\r`;禁止 C0 控制字符(`\n`、`\t` 除外) |
评论**在关系 mutation 确认成功之后**再发(§2.6 完成态合同);失败不回滚关系。

### 1.6 读账本(新,只读)
```graphql
query DependencyLog($id: String!, $after: String) {
  issue(id: $id) { id identifier
    history(first: 50, after: $after) {
      nodes { id createdAt actor { name } botActor { name } relationChanges { identifier type } }
      pageInfo { hasNextPage endCursor } } } }
query DependencyLedgerComments($id: String!, $after: String) {
  issue(id: $id) { id
    comments(first: 100, after: $after) {
      nodes { id body createdAt url user { name } botActor { name } }
      pageInfo { hasNextPage endCursor } } } }
```
✅ history 形状已用真数据核过(FLY-2143:4 条,`hasNextPage:false`)。评论查询**写在本模块内**(既有 `listLinearIssueComments` 只回 `{id, body, createdAt}`,没有 `url` 与作者,⛔ 不改 `linear-query.ts`)。只留前缀命中的评论。两路合并按 `(createdAt, source, id)` 升序(同时间戳稳定);分页上界各 🔶 10 页,超界 ⇒ 响应 `truncated: true`(读路径不拒绝)。

---

## 2. Bridge 路由合同(新文件 `packages/teamlead/src/bridge/dependency-route.ts`,挂 `/api/dependency`,`tokenAuthMiddleware(config.apiToken)` **不带** gemini scoped token —— 与 comment 写代理一致,scoped token 403)

挂载位置:`plugin.ts` 紧跟 `/api/epic-page`(✅ `:4149-4158`),同样只在 `config.apiToken` 存在时挂。依赖注入 **七个 Linear adapter**(默认实现走 SDK,测试全部注入 mock,仿 `epic-page-route.test.ts` 的 `fetchSnapshot` 注入):`lookup(idOrIdentifier)` · `listBlockedBy(issueId, after?)` · `createRelation({ id?, blockerId, blockedId })` · `deleteRelation(relationId)` · `createComment(issueId, body)` · `listHistory(issueId, after?)` · `listComments(issueId, after?)`;`walkBlockers` **不是 adapter,是本模块的纯算法**(BFS over `listBlockedBy`)。`now`、`log`(logger)与 `relationIdMode`(§2.8,M0 定)可注入。

### 2.1 `POST /api/dependency/add`
请求 `{ projectName: string, blocker: string, blocked: string, reason: string, operation_id: string, claimed_actor?: string, kind?: "discovered", parent_op?: string }`;多余键 ⇒ 400 `unsupported_option`(与 epic-page 同法)。`parent_op` 与 `kind` 绑定(Codex R3-4):`kind:"discovered"` 时 **必填** uuid v4,否则 400 `invalid_parent_op`;`kind` 缺省(missed)时 `parent_op` **必须缺席**,携带 ⇒ 400 `invalid_parent_op`;机器记录里非 discover 一律归一为 `null`。

| 顺序 | 检查 | 失败 |
|---|---|---|
| 1 | `projectName` 非空字符串 → `resolveProjectNameParam`;**写路径不允许省略**(与 comment 代理的「可省略」不同,本单是新合同) | 400 `project_required` / 404 `unknown_project` / 404 `project_unbound` |
| 2 | `blocker`、`blocked` 匹配 `^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,6}$` | 400 `invalid_identifier` |
| 3 | `reason` §1.5 规则;`operation_id` uuid 形状;`claimed_actor` 正则;`kind` 只允许缺省或 `"discovered"`;`parent_op` 与 `kind` 绑定 | 400 `invalid_reason` / `invalid_operation_id` / `invalid_actor` / `invalid_kind` / `invalid_parent_op` |
| 4 | `blocker === blocked` | 400 `self_dependency` |
| 5 | `LINEAR_API_KEY` 未配 | 501 `linear_not_configured` |
| 6 | 两张单 lookup;任一 null | 404 `issue_not_found`(响应带 `which: "blocker"|"blocked"`) |
| 7 | 任一不在绑定内(`issueMatchesBinding`) | 403 `issue_outside_project`(带 `which`) |
| 8 | 边已存在(fresh read,拿到 `relation.id`) | **不写关系**。`relation.id === operation_id` ⇒ 是本 op 上次写成功但响应丢失 ⇒ 继续第 11 步补评论,`status:"already_exists", attribution:"this_operation"`;否则 ⇒ `status:"already_exists", attribution:"foreign"`,**不写评论**(不能以本 op 名义记 `added`;Lead 若确认要记理由,用 `note --action added`,那是他显式断言) |
| 9 | 环 / 超界(best-effort preflight,§2.7) | 409 `dependency_cycle` `{ path }` / 422 `cycle_check_unbounded`;零写入 |
| 10 | `createIssueRelation({ id: operation_id, … })`:抛错 ⇒ 502;resolved 但 `payload.success !== true` 或 `issueRelation` 为空/`id !== operation_id` ⇒ 502 `linear_write_unconfirmed`;**写后 fresh read** `blocked` 的第一层必须含 `blocker` 且该条 `id === operation_id`,否则同样 `linear_write_unconfirmed` | 502(日志只记分类 + operation_id,⛔ 不记 upstream 文本) |
| 11 | 账本评论(§2.6):先查该 `operation_id` 是否已记;未记则 `createComment`;抛错 / `success !== true` / 无 `comment.id` ⇒ 响应 `ledger: { ok:false, error:"ledger_unrecorded" }`,HTTP 仍 200(真相已落),CLI **退出 2** 并打印补记命令 | — |
| 12 | 写后环复查(§2.7) | `post_write_check` 三态;`cycle:true` 与 `cycle:null` 都让 CLI 退出 2 |

成功:`200 { ok:true, status:"added"|"already_exists", attribution?:"this_operation"|"foreign", kind:"missed"|"discovered", operation_id, parent_op:null|uuid, relation_id, blocker:{identifier,url}, blocked:{identifier,url}, ledger:{ok:true, comment_id, comment_url, recorded:"now"|"already"} | {ok:false, error} | {ok:false, skipped:"foreign_relation"}, post_write_check:{cycle:false} | {cycle:true, path} | {cycle:null, reason:"unbounded"}, observed_at }`。

### 2.2 `POST /api/dependency/remove`
同请求形(`kind` 不允许)。检查 1–7 同上;8:找关系(§1.3)⇒ 404 `relation_not_found`(响应带 `hint:"若上一次 remove 已提交但响应丢失,用 note 补记"`)/ 422 `relations_truncated`;9:`deleteIssueRelation`:抛错 ⇒ 502;`success !== true` ⇒ 502 `linear_write_unconfirmed`;写后 fresh read `blocked` 第一层必须**不含** `blocker`;10:评论 `kind:"not_needed"`,幂等同 §2.6。成功 `status:"removed"`。

### 2.3 `GET /api/dependency/log?projectName=&issue=&kindOnly=`
检查 1、2(只一张单)、5、6、7;返回
```json
{ "issue":"FLY-2143", "entries":[
  { "at":"2026-09-03T02:35:28.270Z", "source":"linear_history", "id":"…", "code":"ab", "meaning":"blocker_added", "other":"FLY-2142", "author":"Xiaorong Li" },
  { "at":"…", "source":"linear_history", "id":"…", "code":"br", "meaning":"blocker_completed", "other":"FLY-2140", "author":"Linear" },
  { "at":"…", "source":"ledger_comment", "id":"…", "op":"<uuid>", "kind":"not_needed", "blocker":"FLY-2141", "blocked":"FLY-2143", "action":"removed", "reason":"…", "claimed_actor":"flywheel-eng-lead", "author":"Flywheel Bridge", "comment_url":"…" },
  { "at":"…", "source":"ledger_comment", "id":"…", "unparseable":true, "author":"…", "comment_url":"…" }
 ], "truncated": false }
```
`meaning` 来自 §9 的码表;未知码 ⇒ `meaning:"unknown"`,`code` 原样。`author` = Linear 的 `actor.name ?? botActor.name ?? "unknown"`(history)/ `user.name ?? botActor.name ?? "unknown"`(comment);`claimed_actor` 是请求方声明,两者并列。`kindOnly=1` 只返回评论条目。没有评论的裸历史条目(founder 直接改 Linear)照常出现。

### 2.4 `discover` 不是路由
它是 CLI 组合(§3.3);服务端只给 `create-issue` 加 `parentId`(§4)。

### 2.5 并发
按 `(projectName)` 的进程内 promise 链串行(与 epic-page `generationTails` 同法)。**这只约束同一 Bridge 进程**;跨进程 / founder 直改 Linear 的并发见 §2.7。

### 2.6 完成态与幂等(Codex R1-2)—— `POST /api/dependency/note` 是补记与重试的唯一出口
一次 Lead 意图 = 一个 `operation_id`。两次 Linear 写(关系、评论)不是原子的,合同如下:
1. **顺序**:mutation → 确认(`success === true` + 实体 id + 写后 fresh read 状态符合预期)→ 评论。
2. **评论幂等 = 同 op 且同内容**(Codex R3-5):发评论前先扫 `blocked` 的评论(§1.6 查询,≤ 10 页)。存在 `op === operation_id` 的可解析条目 ⇒ 比较其 canonical payload 与本次请求的 payload(**排除**服务端字段 `at`、`relation_id`、`evidence`):完全相同 ⇒ 不再写,`ledger.recorded = "already"`;**不同** ⇒ 409 `operation_id_conflict`(响应带已记录的那份),**零写入**(add/remove 在校验阶段就做这次扫描,所以关系也不会写)。扫描超界 ⇒ 视为未记(宁可重复一条评论,不可漏记),并在响应里 `ledger.scan_truncated:true`。
3. **评论失败**:响应 `ledger.ok:false` + `relation_id`,CLI 退出 **2**(`repair_required`)并打印 `dependency note --operation-id <op> --kind <kind> --action <action> --blocker Y --blocked X --relation-id <id> --reason '…'`(参数经 §3 的 shell 引用)。
4. **`POST /api/dependency/note`** `{ projectName, blocker, blocked, kind, action, reason, operation_id, parent_op?, relation_id?, backfill?: true, claimed_actor? }`(Codex R3-6,两种语义):
   - **默认(`evidence:"state"`)**:检查 1–7 同 add;先核 `kind/action` 组合(400 `invalid_kind_action`);再 **核对边的当前状态与 `action` 一致**(`added` ⇒ 边存在,并把当前 relation id 写进 `relation_id`;`removed` ⇒ 边不存在),不一致 ⇒ 409 `ledger_state_mismatch`(带当前状态与提示「若要补记一次已确认发生过的操作,加 --backfill」);再按第 2 条幂等写评论。这是「对当前边作声明」—— 所以它**可以**为别人建的边记 `added`。
   - **`backfill:true`(`evidence:"lead_ack"`)**:跳过边状态核对,`relation_id` 必填(来自失败那次命令的回执),写评论时 `evidence:"lead_ack"`。这是「补记一次 Lead 确认已发生的 mutation」—— 服务端无法核实(边可能已被再改),所以账本里明确标 `lead_ack`,`log` 原样展示。
   - 两种都只写评论,永不动关系。
5. **响应丢失(超时 / 502)后的重试**:Lead 用**同一个 `operation_id`** 重跑同一条命令。add:边已在且 `relation.id === op` ⇒ `already_exists/this_operation` 且补评论;边已在但 id 不同 ⇒ `already_exists/foreign`、不记;边不在 ⇒ 正常走一遍。remove:边已不在 ⇒ 404 `relation_not_found` + hint,Lead 若确认自己删过就用 `note --action removed` 补记;边还在 ⇒ 正常删。`discover`:建单没有幂等键,CLI **不自动重试**;响应丢失时 envelope 写 `outcome_unknown` 并指示先用 **`GET /api/linear/issue?query=<title>&projectName=<project>`**(✅ 单数路由,`plugin.ts:3878`,identifier 精确匹配优先、否则按关键字匹配并按 `projectName` 限定;复数 `/api/linear/issues` 不读 `query`,Codex R2-8)查重再决定。
6. 502 **不是**「零写入」的证据;文档与测试里「零写入」只对**校验阶段拒绝**(第 1–9 步)成立(spy = 0);mutation 阶段的失败只保证「不发评论、不声称成功」。
7. **`kind × action` 兼容矩阵**(Codex R2-7):`missed→added`、`discovered→added`、`not_needed→removed`;其它组合在 add/remove/note 路由校验阶段 400 `invalid_kind_action`,在 `parseLedgerComment` 里视为 `unparseable`。

### 2.8 客户端 relation id:M0 探针与两条分支合同(Codex R3-1)
**M0(实现节点第一步,M3 之前)**:在 Lead 授权的两张测试单上,用 SDK 直接 `createIssueRelation({ id: <uuid v4>, … })` 一次,记录:是否接受;`inverseRelations.nodes[].id` 是否等于传入值;同 id 再 create 一次的报错形状;然后删掉。结果写 `implementation-notes.md`,决定走哪个分支。**两条分支的合同都在这里定死,M0 不产生 plan 变更。**

| | **主分支:Linear 接受调用方 id** | **fallback:Linear 拒绝调用方 id** |
|---|---|---|
| add 首次写 | `createRelation({ id: op, … })`;验 `payload.success`、`issueRelation.id === op`;写后 fresh read 那条边 `id === op` | `createRelation({ blockerId, blockedId })`(不传 id);验 `success`、`issueRelation.id` 非空;写后 fresh read 存在 `blocker → blocked` 的边,取其 `id` 作 `relation_id` |
| `already_exists` 归因 | `existing.id === op` ⇒ `this_operation`;否则 `foreign` | 扫评论:存在 `op === operation_id` 的可解析评论且其 `relation_id === existing.id` ⇒ `this_operation`(已记过 ⇒ `already`);**否则一律 `foreign`,不自动补记**(响应丢失且评论未写成的情形下,Lead 用 `note --backfill` 认账) |
| 评论里的 `relation_id` | = op | = 服务端生成的 id |
| adapter | `createRelation({ id?, blockerId, blockedId })`(`id` 可选,主分支传、fallback 不传) | 同一签名 |
| 测试 | T5 主分支用例 | T5 增加 fallback 用例(注入 `createRelation` 忽略 `id` 并返回服务端 id 的 mock),两套用例都必须绿,实现按 M0 结果选默认分支 |

### 2.7 环检查是 best-effort(Codex R1-3)
preflight(§1.4)只能挡住**本进程内**看得见的环。写前做最后一次 fresh read;`createIssueRelation` 成功后再读一次 `blocker` 的 blocker 链(同一 `walkBlockers`,同上界):若此时发现 `blocked` 已在链上(有人在校验与写入之间从另一端加了反向边)⇒ 响应 `post_write_check: { cycle:true, path }`,HTTP 200,CLI 退出 2 并打印「已成环,用 remove 解开其中一条」;⛔ 不自动删。超界 ⇒ `post_write_check: { cycle:null, reason:"unbounded" }`,**同样让 CLI 退出 2**(Codex R2-3:关系已写而复查没做完,不能以 0 退出让人以为已核过),stderr 说「写入成功但环复查未完成,请生成页面核对」。页面的 `dependency_cycle` 条目是第二道网。

---

## 3. CLI 合同(新文件 `packages/flywheel-comm/src/commands/dependency.ts`,`index.ts` 加 `case "dependency"`,help 表加一段)

deps 注入形状、token / project / bridge-url 解析顺序、单行 JSON envelope、退出码 —— **逐字沿用** `epic-page.ts`(✅ `:35-108`)。

| 子命令 | 参数 | 调用 | envelope / 退出码 |
|---|---|---|---|
| `add` | `--blocker <ID> --blocked <ID> --reason <text> [--operation-id <uuid>] [--project] [--actor]` | `POST /add` | `{ok, command:"add", operation_id, result}`;`ledger.ok:false`、`post_write_check.cycle:true` 或 `cycle:null` ⇒ 退出 **2** 并在 stderr 打印补记 / 解环 / 复核提示;`attribution:"foreign"` ⇒ 退出 0 但 stderr 提示「边已由他人建立,未记理由;要记就用 note」 |
| `remove` | 同上 | `POST /remove` | 同上 |
| `note` | `--blocker <ID> --blocked <ID> --kind missed\|not_needed\|discovered --action added\|removed --reason <text> --operation-id <uuid> [--parent-op <uuid>] [--relation-id <id>] [--backfill] [--project] [--actor]` | `POST /note` | `{ok, command:"note", result}`;400 `invalid_kind_action` / 409 `ledger_state_mismatch`(stderr 附「加 --backfill 可补记已确认发生过的操作」)/ 409 `operation_id_conflict` 透传,退出 1;`--backfill` 要求 `--relation-id` |
| `discover` | `--parent <ID> --title <t> [--description <d>] [--priority 0-4] [--blocks <ID>]… [--blocked-by <ID>]… --reason <text> [--operation-id <uuid>]` | ① `POST /api/linear/create-issue` `{projectName, title, description, priority, parentId}` ② 对每个 `--blocks X`:`add(blocker=new, blocked=X, kind:"discovered", parent_op:<op>)`;每个 `--blocked-by Y`:`add(blocker=Y, blocked=new, kind:"discovered", parent_op:<op>)`;**每条边各自一个新 uuid v4 作 `operation_id`**(CLI 生成并在 envelope 的 `edges[]` 里逐条回显,重试某条边就用 `add --operation-id <那条的 uuid>`);`--operation-id` 给的是父操作 `parent_op` | 成功 `{ok:true, parent_op, created:{identifier,url}, edges:[{operation_id,…}]}`;任一边失败 ⇒ `{ok:false, error:"partial_failure", parent_op, created, edges:[{…,ok:false,error}]}` 退出 1,**不删已建的单**;建单请求本身响应丢失 ⇒ `{ok:false, error:"outcome_unknown", next:"GET /api/linear/issue?query=<title>&projectName=<project> 查重后再决定"}` 退出 1,⛔ 不自动重试 |
| `log` | `--issue <ID> [--project] [--kind-only]` | `GET /log` | `{ok, command:"log", result}`;同时 stderr 打印人读时间线(与 `show --format md` 同法,stdout 仍单行) |
| `show` | `[--project]` | `POST /api/epic-page/generate` `{projectName}` | 只投影 `ready_items.value` 与 `dependency_review.value` 到 `{ok, command:"show", ready:[…], review:[…], generated_at}` |

`--operation-id` 缺省由 CLI 生成 uuid v4(`node:crypto randomUUID`,可注入)并回显在 envelope 与 stderr(重试时 Lead 原样带上);CLI 与服务端共用 `flywheel-config` 里的同一个 `OPERATION_ID_RE`(§1.5),⛔ 没有 `<uuid>:<n>` 这类派生形状(Codex R2-5)。**CLI 打印到 stderr 的一切可复制命令**(补记、解环、查重)的每个参数都经 POSIX 单引号引用(把 `qa-result.ts:1276` 的 `shellQuote` 抽到 `packages/flywheel-comm/src/shell-quote.ts` 共用,⛔ 不再各写一份),URL 的 query 用 `URLSearchParams` 编码(Codex R3-7);`reason` 里的单引号、双引号、换行、`$()`、反引号、`&`、`#` 都不得改变参数或成为执行面(T9)。`--actor` 缺省取 `env.FLYWHEEL_LEAD_ID`,进请求体 `claimed_actor`。`--reason` 对 add/remove/note/discover **必填**(缺 ⇒ `invalid_arguments` + USAGE)。`--blocks` / `--blocked-by` 至少一个(否则 discover 退化成普通建单,那不是本 CLI 的事 ⇒ `invalid_arguments`)。退出码:0 成功 · 1 拒绝/错误 · **2 真相已落但需补记 / 解环 / 人工复核**。

---

## 4. `create-issue` 追加 `parentId`(`plugin.ts:3413-3650`,改动 ≤ 25 行)

- 请求体新增可选 `parentId: string`(identifier 或 uuid);非字符串 ⇒ 400 `parentId must be a string`。
- 解析:`lookupLinearIssueByIdentifier` → null ⇒ 404 `parent "<x>" not found`;带 `projectName` 时 `issueMatchesBinding(parent, binding)` 不符 ⇒ 403(措辞与 comment 代理一致);父单的 team 必须等于 `targetTeam.key`(否则 400 `parent is in team X, issue would be created in team Y`)。
- `client.createIssue({ …既有字段, ...(parentUuid && { parentId: parentUuid }) })`。✅ `IssueCreateInput.parentId` 存在于 SDK(`_generated_documents.d.ts` 里 `IssueCreateInput` 含 `parentId?: InputMaybe<Scalars["String"]>`;实现期再 grep 一次核行号)。
- 既有调用方不传 `parentId` ⇒ 字节级不变。

---

## 5. 页面模型追加(`packages/teamlead/src/epic-page/`,只追加)

### 5.1 类型(`model.ts`)
```ts
export const RULE_IDS = [ …既有六个, "subtraction.v1" ] as const;
export type DependencyReviewEntry =
  | { kind: "canceled_blocker"; item: string; blocker: string }          // 非终态 item 仍等着已取消的 blocker
  | { kind: "dependency_cycle"; members: string[] }                       // 范围内成环,members 按 identifier 排序
  | { kind: "all_blocked"; non_terminal: number;                          // ready 为空且仍有活
      blocking_edges: Array<{ blocker: string; blocked: string; blocker_state_type: string; in_scope: boolean }>; // 阻塞前沿,≤ 50 条,排序
      blocking_edges_truncated: boolean };                                 // 恒存在(Codex R2-2)
export interface EpicPage { …; dependency_review: Cell<DependencyReviewEntry[]>; }
const ROOT_CELLS = ["done_definition","founder_items","ready_items","gaps","dependency_review"] as const;
```
守卫(Codex R1-5 后改为**重算比对**,不再逐条弱断言):`assertEpicPage` 对 `dependency_review` 做 —— `provenance.kind === "derived" ∧ rule === "subtraction.v1"`;`from` 路径都存在(既有 `assertCell`);**`value` 必须与 `computeDependencyReview(items, ready_items.value)` 的结果 canonical JSON 逐字节相等**。这一条同时覆盖:单节点伪环、`non_terminal` 乱写、终态 item 带 canceled 条目、重复条目、乱序、`all_blocked` 与非空 ready 同现、`blocking_edges` 伪造。前置:每张 item 的 `state` 与 `blocked_by` 必须 `known`(非 null、无 missing),否则守卫抛 `dependency_review requires known state/blocked_by`(Codex R1-6:这两格是生成的必备 Linear 数据,快照本来就 fail-loud;⛔ 不用 `known()` 静默跳过)。

### 5.2 规则(`rules.ts`)
```ts
export function computeDependencyReview(items: EpicItem[], ready: string[]): DependencyReviewEntry[]
```
0. 任一 item 的 `state` / `blocked_by` 不 `known` ⇒ 抛错(生成失败,不出半页)。
1. `canceled_blocker`:遍历每张**非终态** item 的 `blocked_by`,`blocker_state_type === "canceled"` ⇒ 一条;按 (item, blocker) 排序;去重。
2. `dependency_cycle`:节点 = 范围内 items;边 = `blocked_by` 中 `in_scope === true` 的 blocker → item;Tarjan SCC;|SCC| ≥ 2,或 |SCC| = 1 且有自环 ⇒ 一条,`members` 排序;多环按首成员排序。(⚠️ 只用范围内边:范围外 blocker 没有它自己的 `blocked_by`,无法闭环;写路径的 §1.4 / §2.7 才是全图检查。)
3. `all_blocked`:`ready.length === 0 ∧ 非终态 item 数 > 0` ⇒ 恰一条,`non_terminal` = 该计数,`blocking_edges` = 所有非终态 item 的**未解除** `blocked_by` 边(`blocker_state_type !== "completed"`),每条带 `blocker_state_type` 与 `in_scope`,按 (blocked, blocker) 排序,最多 50 条,`blocking_edges_truncated` 恒存在(超出 ⇒ true)。**语义是中性的「阻塞前沿」**(Codex R2-4):范围外 / backlog 的 blocker 也列,但文案是「等它做完,还是删边——由你判断」,⛔ 不暗示外部依赖该删;这与 exploration §3 Q3「不把范围外 blocker 当减法候选」不冲突——那条说的是不单独为它们造条目,这里是在「全部收死」时把前沿摆出来给 Lead 看。
纯函数、零 IO、确定性排序(digest 稳定)。

⚠️ **这三种是「可观测的坏形状」,不是「所有该减的边」**(Codex R1-1):一条 blocker 既未取消也未完成、但 Lead 心里已知不再需要的边,机器无法识别 —— 它只能由 Lead 用 `remove` 表达。本单不为「Lead 想删还没删」造意图记录(那是评论里的第二套状态机,且 Lead 已裁不做自动化)。plan §0 的措辞据此收窄。

### 5.3 生成(`generate.ts`)
在 `ready_items` 之后:
```ts
dependency_review: { value: computeDependencyReview(items, ready), provenance: { kind:"derived", rule:"subtraction.v1", from: [ ...itemPointers(["state","blocked_by"]), "/ready_items" ] }, observed_at: generatedAt }
```

### 5.4 回执(`receipt.ts`)
不改。派生格不进 `sources`;`COMPUTED_ORDER_FIELD` 正则不匹配 `dependency_review`(它匹配的是 `batch|next_candidates|ready_items|order`),测试里加一条断言证明含该格的文档产出的回执仍通过守卫。

### 5.5 渲染(`render-html.ts` / `render-markdown.ts` / `labels.ts`)
- 新标签(Codex R3-2 后措辞中性、空态带限定语):`section.review: "依赖审阅:该减的、该判断的"`、`review.canceled_blocker: "{item} 还在等已取消的 {blocker} —— 删这条边,或改指别的单"`、`review.cycle: "{members} 互相等,谁都不会开始 —— 至少删一条边"`、`review.all_blocked: "{n} 件没做完、0 件能开始 —— 下面是它们各自在等的边,逐条判断:等它做完,还是删边"`、`review.blocking_edge: "{blocked} 在等 {blocker}(状态:{state}{scope})"`(`{scope}` = 空或 `page.external_dependency` 的「(范围外)」)、`review.blocking_edges_truncated: "…只列前 50 条"`、**`review.none: "0 个可观测警报。这不代表没有该减的边:blocker 还活着、但已经不需要等它的那种,页面看不出来,只能由 Lead 用 remove 说出来"`**、`cell.dependency_review: "依赖审阅"`;规则注记用既有 `page.default_rule_note`(规则号 `subtraction.v1`,⚠️ 本单默认值、**未获 founder 裁定**)。T10 断言空态渲染含「不代表没有该减的边」这一限定语。
- HTML:`renderOverviewCell("/dependency_review", …)` 放在 `/ready_items` 之后、`/header/roots` 之前(✅ `render-html.ts:310-311` 之间);零条也渲染。
- Markdown:`## 依赖需要减法的地方` 放在 `section.ready` 之后(✅ `render-markdown.ts:210-214` 之间)。
- parity 测试的根路径清单(✅ `render.test.ts:109-112, 192-195`)追加 `/dependency_review`。

---

## 6. Lead 规则(`packages/teamlead/lead-rules-base/runner-patrol-rules.md` 追加一节;⛔ 不新增文件,免改 `claude-lead.sh` 与 README 表)

小节标题 🔶「依赖账本(FLY-2142)」,内容只有:三个动词的命令模板(占位 `<project>` 与 `$FLYWHEEL_LEAD_ID`)、「取消一张单不等于减法,页面『依赖需要减法的地方』非空时先审边再拉活」、「Runner 发现依赖只提议,不自己写」、「拆 Epic 时:先建子单,再逐条 `dependency add`,然后 `dependency show` 核第一波」。
内容合同测试:`packages/teamlead/src/__tests__/fly2142-dependency-ledger-rule.test.ts`(仿 `fly369-patrol-rule.test.ts` ✅),断言小节存在、三个动词、`dependency show`、「不等于减法」字样。

---

## 7. 权限与边界(汇总)

| 面 | 合同 |
|---|---|
| 鉴权 | master token 才能写/读;scoped token 403;ingest token 401(runner 打不开,与 epic-page 同边界) |
| 外部输入 | `projectName`(非空 + 配置命中 + 绑定存在)、identifier 正则、`reason` 长度与控制字符、`actor` 正则、`parentId` 字符串;其余 400 |
| 项目边界 | 两端 issue 都 `issueMatchesBinding`;跨项目边一律 403 —— 跨 Epic 但同项目的边允许(那是范围外 blocker 的合法来源) |
| Linear 写 | 只有 `createIssueRelation(blocks)`、`deleteIssueRelation(id)`、`createComment`、`createIssue(+parentId)` 四种;⛔ 不改状态、不改标签、不删 issue |
| 泄漏 | 错误响应**与 Bridge 日志**都不含 upstream 异常文本、路径、key(日志只记 `[dependency] <op> <stage> <classification>`;Codex R1-7);评论 body 不含 token/路径(body 只由校验过的字段拼) |
| 自动化 | Bridge 不在任何巡检/事件里调用这四种写;它们只由 Lead 的 CLI 触发 |

---

## 8. 测试矩阵(编号供 plan 引用)

| # | 内容 | 位置 |
|---|---|---|
| T1 | `computeDependencyReview`:canceled_blocker(含 item 已终态则不报)、两节点环、三节点环、自环、范围外 blocker 不构成环、all_blocked(ready 空 + 有活)、ready 空但全部终态 ⇒ 不报、排序稳定 | `epic-page/__tests__/rules.test.ts` 追加 |
| T2 | 守卫(重算比对):缺 `dependency_review` 拒;规则号不对拒;以下 mutant 各一例全部拒 —— 单节点伪环、`non_terminal` 改数、终态 item 带 canceled 条目、重复条目、乱序、`all_blocked` 与非空 ready 同现、`blocking_edges` 多一条/少一条、canceled 条目指向不存在的 blocked_by;item `state` 或 `blocked_by` missing ⇒ 拒;含该格的 golden(含空数组)通过;回执守卫对含该格文档通过且 `sources` 不含它 | `model.test.ts` / `receipt` 测试追加 |
| T3 | 生成器:fixture `EPX-2` 的 blocker `EPX-1` 置 canceled ⇒ review 含一条且 ready 不含 EPX-2;`from` 路径完整 | `generate.test.ts` 追加 |
| T4 | 演练:同 fixture 上「取消 EPX-1 → review 报 → 模拟删边(blockedBy 清空)→ review 空、EPX-2 ready」 | `drill.test.ts` 追加 |
| T0 | `flywheel-config` 合同常量:`OPERATION_ID_RE` 对 v4 通过、对 v1/v5/`<uuid>:1`/大写拒;`KIND_ACTION_MATRIX` 三合法六非法;键集常量与 parser 键集一致 | `packages/config/src/__tests__/dependency-ledger-contract.test.ts` |
| T5 | 路由 add:401/403(scoped)/400×10(project_required、unsupported_option、invalid_identifier、invalid_reason、invalid_operation_id(含 `<uuid>:1` 形状被拒)、invalid_kind、invalid_kind_action、invalid_parent_op ×2(discovered 缺 parent_op;missed 带 parent_op)、self_dependency)/404×3/403(outside)/409 cycle(两层与三层)/**409 `operation_id_conflict`(同 op 改 reason / 改端点 各一例,关系 spy = 0)**/422 unbounded/502 throw/**502 `success:false`**/**502 getter undefined**/**502 relation.id ≠ op**/**502 写后 fresh read 不含边**;**校验阶段每个失败 `createRelation` spy = 0**;`createRelation` 被调用时 spy 参数 `id === operation_id`;`already_exists` 三源区分:relation.id === op ⇒ `this_operation` + 补评论一次;relation.id ≠ op ⇒ `foreign` + 评论 spy = 0;**同一 `operation_id` 同内容重放** ⇒ 评论只写一次(`recorded:"already"`);评论扫描超界 ⇒ 仍写并 `scan_truncated`;评论失败 ⇒ 200 + `ledger.ok:false` + `relation_id`;**preflight 后、mutation 前注入外部反向边** ⇒ 200 + `post_write_check.cycle:true` 且不自动删;复查超界 ⇒ `cycle:null`;**fallback 分支**(mock 忽略 `id`、返回服务端 id):首次 add 成功且评论 `relation_id` = 服务端 id;already_exists 时有同 op 评论且 `relation_id` 相等 ⇒ `this_operation`、否则 `foreign`;logger spy:响应与日志都不含路径 / `Bearer …` / 原始异常文本 | `bridge/__tests__/dependency-route.test.ts` |
| T6 | 路由 remove:relation_not_found(带 hint)/ relations_truncated / 成功 + 评论 kind not_needed + `relation_id` = 被删 id / delete throw 502 / `success:false` 502 / 写后 fresh read 仍含边 502 / 同 op 改内容 409 conflict;note:`not_needed+added` 等非法组合 400 `invalid_kind_action`;`added` 但边不在 ⇒ 409 `ledger_state_mismatch`(hint 含 `--backfill`);`added` 且边是别人建的 ⇒ 写评论(`evidence:"state"`);`removed` 且边不在 ⇒ 写评论;**`backfill:true` 且边状态相反** ⇒ 写评论且 `evidence:"lead_ack"`;`backfill` 缺 `relation_id` ⇒ 400;**端到端修复链**:add 成功 → 评论失败 → 边被外部删掉 → 默认 note 409 → `note --backfill` 成功 → `log` 读到 `lead_ack` 条目;同 op 二次 ⇒ `already` | 同上 |
| T7 | 路由 log:历史 `ab/br/rb`(rb 为预期码)与两条前缀评论合并排序;非前缀评论被过滤;**恶意 reason(含换行、`\nby: forged`、`{"kind":...}` 字样、Markdown、单个与连续反引号、`dl1:` 字样)round-trip 后字段逐字相同**;被人工改坏的评论(base64 坏、键集不对、非法 kind/action 组合)⇒ `unparseable:true` 条目;同时间戳按 (source, id) 稳定;`author` 与 `claimed_actor` 并列;`parent_op` 透传;`comment_url` 存在;`truncated` 传播;`kindOnly` | 同上 |
| T8 | `create-issue` parentId:缺省不变(spy 参数无 `parentId`);identifier → uuid;not found 404;跨绑定 403;跨 team 400 | `bridge/__tests__/linear-create-issue-parent.test.ts`(或既有 create-issue 测试追加) |
| T9 | CLI 六个子命令 happy path;缺 reason;缺省 operation_id 生成(uuid v4 正则)且回显、显式传入原样透传;`ledger.ok:false` ⇒ 退出 2 + stderr 补记命令(含 `--relation-id`);`post_write_check.cycle:true` 与 `cycle:null` 都 ⇒ 退出 2;`attribution:"foreign"` ⇒ 退出 0 + stderr 提示;discover 每条边 uuid 各不相同、请求体带 `parent_op` = 父 op 与 `kind:"discovered"`;discover 部分失败 envelope 与退出码;discover 建单响应丢失 ⇒ `outcome_unknown` 退出 1、`create-issue` fetch 只调一次、stderr 里的查重 URL 精确为 `/api/linear/issue?query=<URLSearchParams 编码的 title>&projectName=<编码的 project>`;**shell 引用**:reason 含 `'`、`"`、换行、`$(id)`、反引号、`&`、`#` 时,stderr 命令里的每个参数都是 POSIX 单引号形式且反解析后逐字等于原值;note `--backfill` 缺 `--relation-id` ⇒ `invalid_arguments`;log 的 stderr 人读输出不破坏 stdout 单行;show 只投影两格 | `flywheel-comm/src/commands/__tests__/dependency.test.ts`(+ `src/__tests__/shell-quote.test.ts`) |
| T10 | 渲染:HTML/MD 都含新小节(标题「依赖审阅」)、零条渲染「0 个可观测警报」且含「不代表没有该减的边」限定语、三种条目各含 identifier、范围外 blocker 带「(范围外)」、规则号与「未获 founder 裁定的默认规则」可见、parity 根路径 +1 | `render.test.ts` 追加 |
| T11 | Lead 规则内容合同 | `__tests__/fly2142-dependency-ledger-rule.test.ts` |
| T12 | 真数据演练(需 Lead 授权两张测试单):M0 探针(客户端 relation id 三问)→ add → show → remove → note(同 op 重放)→ log;记录删边历史码与两行评论的真实渲染;结果进 `implementation-evidence.md` | 实现节点 |

---

## 9. Linear 历史码表(账本读口的 `meaning` 映射)

| 码 | 观测 | 含义 |
|---|---|---|
| `ab` | ✅ 真数据(FLY-2143 ← 2140/2141/2142,actor 为人) | `blocker_added`:本单多了一个 blocker |
| `br` | ✅ 真数据(2026-09-04T02:35:45Z,`botActor: Linear`,紧随 FLY-2140 转 Done) | `blocker_completed`:某个 blocker 完成了 |
| `rb` | ⬜ 预期(a=add / r=remove 的对偶),**T12 实测后定** | `blocker_removed` |
| 其它 | ⬜ | `unknown`,原码透传 |

⚠️ 这张表只影响 `log` 的人读标签;账本的**事实**(边在不在)永远以 `inverseRelations` 当前值为准,不从历史重放。

---

## 10. 盲区(实现节点开工先核)

1. `IssueCreateInput.parentId` 与 `IssueRelationType` 的 import 路径(`@linear/sdk` 顶层是否 re-export 枚举;否则用字面量 `"blocks"`)。
2. 同一对 issue 重复 `createIssueRelation` 的真实行为(§1.2);本单靠前置检查规避,但要写进 evidence。
3. `history` 是否包含关系被**删除**的条目及其码(§9 `rb`)。
4. Linear 评论 body 的 markdown 渲染:`[dependency-ledger]` 首行里的方括号是否被当成链接语法 —— 用真评论看一眼;若被吃掉,前缀改为反引号包裹并同步常量(`log` 识别两种)。
5. `projects.json` 的 `flywheel` 条目补 `linear` 绑定后,`/api/linear/create-issue` 的 team-scoped project 解析对 `Flywheel` 是否唯一(既有 400 ambiguous 分支)。
