# FLY-2142 依赖账本 — 实施计划
Issue: FLY-2142 (https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢)
日期: 2026-09-04(round 4:吸收 Codex R1 2H/5M/1L、R2 1H/7M、R3 2H/5M/1L —— 全部采纳;唯一拒绝的是 R1-1 里「在评论里记 pending-subtraction 意图」的备选方案,理由见 research §5.2 末段;处置表在 review-log.html)
基于: exploration.md, research.md

> 世界标记同 research.md:[main] `e85eec9a8` · [prd] v2.4 · [linear] as-of 2026-09-04T03:51Z。
> 本计划只写**做什么、按什么序、怎么证明**;合同与数字以 research.md 为准,取舍理由以 exploration.md 为准。实现节点 ⛔ 不得改本文件(design-review blob 钉住);实现期发现的事实写 `implementation-notes.md`。
> Lead 裁定(ask `0cb88a08`,2026-09-04T04:01Z):四条默认取向全部批准;**不建 StateStore 账本副本**(founder 9-4 直令:Linear 是唯一账本,她有权直接在里面改依赖/加单);**`ready.v1` 不变、canceled 的 blocker 不自动释放**(自动释放是看不见的减法);**Bridge 永不从正文推断依赖**(文本变权限 = 注入面)。

## 0. 目标与验收(可证伪)

**目标**:任意 Lead 对任意项目,能用三个动词把 PRD R2 的三类依赖更新落进 Linear(漏掉的 = 加边,不需要做的 = 删边,新发现的 = 建单加边),每次更新有 `operation_id`、有理由、能读回来;记录没留成时能补记(默认补记核对当前边状态;边已被再改时用 `--backfill` 由 Lead 显式认账,账本里标 `lead_ack`);并且每次**完整生成** Epic 页面都会确定性地点名三种可观测的坏形状(非终态子单还在等已取消的 blocker、范围内成环、有活却 0 件能开始并列出前沿边),空态明说「不代表没有该减的边」。

**本单保证的边界(Codex R1-1 后收窄,⛔ 不再写「结构上不可能丢」)**:减法是一等动作(`remove` 有动词、有理由、有记录);页面对上述三种形状**每次生成时**必报;但「一条 blocker 既未取消也未完成、Lead 心里已知不再需要的边」机器无法识别,只能由 Lead 用 `remove` 表达;页面 v1 也只有显式生成(自动扫描归 FLY-2141/2143,⛔ 不拿它们补本单的证明)。

**为什么不需要账本副本(写给评审)**:Linear 的 `issue.history[].relationChanges` 已记每条边的增删,带 `createdAt` 与 `actor`(真数据:FLY-2143 上 `ab` 三条为人工登记、`br` 一条为系统记 blocker 完成,research §9);边的现状以 `inverseRelations` 为准。本单只补 Linear 不记的两样(三类中的哪一类、为什么)——用固定前缀评论,仍在 Linear 里。**founder 或 Lead 直接在 Linear 改的边,没有评论也是合法条目**,`log` 必须原样列出。

**验收**:
- **A1(减法真的减、且被点名)**:fixture(FLY-2140 的 `epic-shape`,5 张子单、EPX-1 挡 EPX-2/3/4)把 EPX-1 置 `canceled` 后生成 ⇒ `dependency_review.value` 含 `{kind:"canceled_blocker", item:"EPX-2", blocker:"EPX-1"}`(EPX-3、EPX-4 同)且 `ready_items` 不含 EPX-2/3/4;模拟 `remove(EPX-1, EPX-2)`(fixture 里删掉那条 blockedBy)再生成 ⇒ EPX-2 进 `ready_items`,审阅格里不再有 EPX-2 的条目。**任一步靠自动释放而不是显式删边得到 ready = 不合格。**
- **A2(全部收死会报警,并摆出前沿边)**:三张非终态子单成环 ⇒ `dependency_cycle{members:[…3 张]}`;`ready_items = []` 且仍有活 ⇒ 恰一条 `all_blocked{non_terminal:n, blocking_edges:[…未解除的前沿边,每条带 blocker_state_type 与 in_scope,排序], blocking_edges_truncated:false}`;前沿边 > 50 ⇒ 截到 50 且 `blocking_edges_truncated:true`;全部终态时 ⇒ 不报 `all_blocked`;渲染文案对范围外 blocker 标「(范围外)」且措辞中性(「等它做完,还是删边」);守卫对篡改后的审阅格(research §8 T2 的每个 mutant)逐一拒绝。
- **A3(写路径:校验阶段零写入;mutation 阶段完成态明确;归因不伪造)**:add/remove 在校验阶段(research §2.1 第 1–9 步)的每一个失败分支 `createIssueRelation` / `deleteIssueRelation` spy = 0;两端任一张不在绑定 ⇒ 403 零写入;`projectName` 缺失 ⇒ 400。`createIssueRelation` 的 `id` 参数 === `operation_id`。mutation 阶段:`success !== true`、实体缺 id、`relation.id !== operation_id`、写后 fresh read 不符 ⇒ 502 `linear_write_unconfirmed` 且**不发评论**。`already_exists` 三源区分:`relation.id === operation_id` ⇒ `attribution:"this_operation"` 并补评论;不等 ⇒ `attribution:"foreign"` 且评论 spy = 0。preflight 后被外部写入抢先成环 ⇒ 200 + `post_write_check.cycle:true`(CLI 退出 2);复查超界 ⇒ `cycle:null`(CLI 同样退出 2);⛔ 不自动删。**「409 且零写入」只对本进程 preflight 能看见的环成立**(research §2.7)。
- **A4(账本读得回、写不丢、记录不自相矛盾)**:`log` 对 mock 历史 `ab / br / rb` + 两条前缀评论 + 一条无关评论 + 一条被改坏的前缀评论(base64 坏 / 键集不对 / `not_needed+added` 非法组合各一例)⇒ 输出按 `(createdAt, source, id)` 升序、无关评论被过滤、改坏的那些 `unparseable:true`、`rb` 映射 `blocker_removed`、未知码 `meaning:"unknown"` 且原码透传、`author` 与 `claimed_actor` 并列、`parent_op` 透传;没有评论的裸历史条目照常出现;恶意 `reason`(换行、`\nby: forged`、JSON 字样、Markdown、单个与连续反引号、`dl1:` 字样)round-trip 后字段逐字相等。同一 `operation_id` **同内容**重放 add ⇒ 评论只有一条;同 op **改内容** ⇒ 409 `operation_id_conflict` 且关系与评论 spy = 0;评论失败 ⇒ CLI 退出 2 并给出经 shell 引用的 `note` 命令(含 `--relation-id`),`note` 后再 `log` 能读到该 op;边在补记前被外部改掉 ⇒ 默认 `note` 409 并提示 `--backfill`,`note --backfill` 写入 `evidence:"lead_ack"` 且 `log` 可见;`note` 对非法 `kind/action` 组合 400;CLI 打印的每条命令在 reason 含 `'`、`"`、换行、`$(id)`、反引号时反解析后参数逐字相等。
- **A5(通用主语)**:`grep -rn "FLY-2108\|FLY-21[0-9][0-9]\|flywheel-eng-lead" packages/teamlead/src/bridge/dependency-route.ts packages/teamlead/src/epic-page/rules.ts packages/flywheel-comm/src/commands/dependency.ts` = 0;fixture 只用 `EPX-n`。
- **A6(不越界)**:`ready.v1` / `dependents.v1` / `scope.v1` 既有测试零改动全绿;`receipt.ts` 零改动且含 `dependency_review` 的文档的回执通过守卫、`sources` 不含派生格;`/api/linear/create-issue` 不传 `parentId` 时 `createIssue` spy 参数逐字节不变。
- **A7(真数据,实现节点执行、QA 复核;需 Lead 授权两张一次性测试单)**:M0 探针(research §2.8 三问)的原始结果;然后对生产或本机 Bridge 跑 `dependency add → show → remove → note(重放同 op)→ log`,记录:两次 `inverseRelations` 前后差、删边在 `history` 里的码、评论在 Linear 上的渲染截图(确认首行与 `dl1:` base64url 行都原样可复制、未被 markdown 改写)、`note` 重放返回 `recorded:"already"`;证据进 `implementation-evidence.md`。若 Lead 不授权写生产 Linear,M0 与 A7 都记「未执行 + 原因」并按 fallback 分支实现默认值,⛔ 不伪造。
- **全仓门(四条)**:`pnpm lint` · `pnpm -r build` · `pnpm -r typecheck` · `pnpm test:packages:run` 全绿(resident 主机上既知的两个 Terminal.app 用例除外,按 FLY-2144 evidence 同口径如实记录);PR 最后一个 commit 只含 `engineering/doc/milestones/FLY-2142.md`。

## 1. 分块与顺序(严格 TDD:每块先写失败测试)

依赖方向:M0(能力探针)与 M1 先行 → M1b(合同常量)→ M2(页面)与 M3(路由)可并行 → M4(create-issue parentId)→ M5(CLI)→ M6(Lead 规则)→ M7(真数据 + 证据)。

### M0 · 客户端 relation id 能力探针(research §2.8;Codex R3-1)
在写任何路由代码之前:向 Lead 用 `ask --report` 申请两张一次性测试子单;拿到后用 SDK 直接 `createIssueRelation({ id: randomUUID(), … })` 做一次,记录 research §2.8 的三问答案,删掉测试边,把原始输出写进 `implementation-notes.md`。结果只决定 M3 走**主分支**还是 **fallback 分支**(两条合同都已定死,T5 两套用例都要绿);⛔ 不改 plan。Lead 未授权 ⇒ 记「未执行」,默认按 fallback 分支实现(它对两种 Linear 行为都安全)。

### M1b · 合同常量(`flywheel-config`;Codex R3-3)
文件:`packages/config/src/dependency-ledger-contract.ts`,从 `packages/config/src/index.ts` 导出 `DEPENDENCY_LEDGER_PREFIX`、`LEDGER_MACHINE_LINE_PREFIX`、`OPERATION_ID_RE`、`LEDGER_KINDS`、`LEDGER_ACTIONS`、`KIND_ACTION_MATRIX`、`LEDGER_EVIDENCE`、`LEDGER_COMMENT_KEYS`;测试 `packages/config/src/__tests__/dependency-ledger-contract.test.ts`(T0)。`flywheel-comm` 与 `flywheel-teamlead` 都只从这里 import(两者都已依赖 `flywheel-config` ✅ `package.json`)。

### M1 · 规则与模型追加(纯逻辑,零 IO)
文件:`packages/teamlead/src/epic-page/model.ts`、`rules.ts`、`labels.ts`;测试 `epic-page/__tests__/{rules,model}.test.ts` 追加。
1. `model.ts`:`RULE_IDS` 追加 `"subtraction.v1"`;新类型 `DependencyReviewEntry`(research §5.1 三种 `kind`,字段精确,`all_blocked` 带 `blocking_edges[]{blocker, blocked, blocker_state_type, in_scope}` 与恒存在的 `blocking_edges_truncated: boolean`);`EpicPage` 追加根格 `dependency_review: Cell<DependencyReviewEntry[]>`;`ROOT_CELLS` 追加它;`assertEpicPage` 对它做**重算比对**(research §5.1:provenance 必须是 `derived` + `subtraction.v1`;`value` 的 canonical JSON 必须与 `computeDependencyReview(items, ready_items.value)` 逐字节相等;任一 item 的 `state`/`blocked_by` 不 `known` ⇒ 拒)。为避免 `model.ts → rules.ts → model.ts` 循环 import,把 `computeDependencyReview` 放在新文件 `epic-page/subtraction.ts`(只 import 类型),`rules.ts` 与 `model.ts` 都从它 import。
2. `subtraction.ts`:`computeDependencyReview(items, ready)`(research §5.2:known 前置 → canceled_blocker → 范围内边 Tarjan SCC(含自环)→ all_blocked + 前沿边 ≤ 50;全部确定性排序、去重);`rules.ts` 只 re-export 并把 `RULE_IDS.subtraction = "subtraction.v1"` 加进常量。
3. `labels.ts`:追加 `section.review`(「依赖审阅:该减的、该判断的」)、`review.canceled_blocker`、`review.cycle`、`review.all_blocked`(中性措辞)、`review.blocking_edge`(「{blocked} 在等 {blocker}(状态:{state}{scope})」)、`review.blocking_edges_truncated`、`review.none`(「0 个可观测警报。这不代表没有该减的边:…只能由 Lead 用 remove 说出来」,Codex R3-2)、`cell.dependency_review`(「依赖审阅」)(文案 = research §5.5;规则注记用既有 `page.default_rule_note`)。
RED 用例(先写):canceled_blocker 一条 / item 已终态则不报 / 两节点环 / 三节点环 / 自环 / 范围外 blocker 不成环 / all_blocked 带前沿边(含范围外与 backlog blocker,各带 in_scope 与状态)且排序、`blocking_edges_truncated:false` / 前沿边 > 50 截断并 `blocking_edges_truncated:true` / ready 空但全部终态不报 / state 或 blocked_by missing ⇒ 抛错 / 同一输入两次调用输出逐字节相同;守卫(T2):缺格拒、规则号不对拒、research §8 T2 列的每个 mutant 各一例拒(含 `blocking_edges_truncated` 翻转)、golden(含空审阅格)通过;`labels.ts` 仍是唯一含中文标签的文件(既有 grep 断言不变)。
完成判据:T1、T2 绿。

### M2 · 生成与渲染追加
文件:`epic-page/generate.ts`、`render-html.ts`、`render-markdown.ts`;测试 `generate.test.ts`、`drill.test.ts`、`render.test.ts`、`receipt` 相关测试追加。
1. `generate.ts`:`ready_items` 之后加 `dependency_review`(research §5.3;`from` = 每张子单的 `state`、`blocked_by` + `/ready_items`)。
2. `render-html.ts`:`/dependency_review` 总览卡放在 `/ready_items` 与 `/header/roots` 之间;三种条目各一行人话,`all_blocked` 下逐条列前沿边(`review.blocking_edge`,范围外 blocker 带「(范围外)」,`blocking_edges_truncated` 时加 `review.blocking_edges_truncated`);零条渲染 `review.none`;规则注记「未获 founder 裁定的默认规则 subtraction.v1」;动态文本一律 `escapeHtml`。
3. `render-markdown.ts`:`## 依赖需要减法的地方` 放在 `section.ready` 之后;同样零条也出。
4. parity 根路径清单 +1(`/dependency_review`)。
RED 用例:golden 含空审阅格;A1 四步演练(取消 → 报 → 删边 → ready);gate/carrier 等既有断言不动;receipt:含该格的文档 `buildEpicPageRenderReceipt` 通过且 `sources` 里无 `/dependency_review` 路径;HTML/MD 都含新小节、三种条目文案含 identifier、`<script>` 注入标题在新小节里也被转义;零条时含「0 处」。
完成判据:T3、T4、T10 绿;`ready.v1` / `dependents.v1` 既有测试零改动。

### M3 · Bridge 路由 `/api/dependency`
文件:`packages/teamlead/src/bridge/dependency-route.ts`(新)、`plugin.ts`(挂载 ≤ 12 行,紧跟 `/api/epic-page`);测试 `bridge/__tests__/dependency-route.test.ts`(新,仿 `epic-page-route.test.ts` 的 `createServer` + 注入)。
1. `createDependencyRouter(deps)`:`deps.linear` **七个 adapter**(`lookup / listBlockedBy / createRelation({ id?, blockerId, blockedId }) / deleteRelation / createComment / listHistory / listComments`,research §2 开头)全部可注入,默认实现在同文件内用 SDK;`walkBlockers` 是本模块纯算法(BFS over `listBlockedBy`,`maxNodes:200`,顺序稳定);`now`、`logger` 与 `relationIdMode: "client" | "server"`(M0 结果,默认 `"server"`)可注入。
2. `POST /add`、`POST /remove`、`POST /note`、`GET /log`:检查顺序、状态码、错误码逐条 = research §2.1–2.3、§2.6、§2.8;`(projectName)` 串行链(research §2.5);add 的 `parent_op` 与 `kind` 绑定校验(400 `invalid_parent_op`)。
3. **完成态与归因合同**(research §1.2、§2.6、§2.8):主分支 `createRelation({ id: operation_id, … })` 并要求返回与 fresh read 的 `id === op`;fallback 分支不传 id、以 fresh read 到的服务端 id 作 `relation_id`;`already_exists` 归因两分支各按 §2.8 表;mutation `success !== true` / 实体缺 id / 写后 fresh read 不符 ⇒ 502 `linear_write_unconfirmed` 且不发评论。**幂等**:校验阶段就扫已有评论(≤ 10 页),同 op 且 payload(去 `at/relation_id/evidence`)相同 ⇒ `recorded:"already"`,同 op 不同内容 ⇒ 409 `operation_id_conflict` 零写入;评论失败 ⇒ 200 + `ledger.ok:false` + `relation_id`。`note` 只写评论:先核 `kind/action` 矩阵(400 `invalid_kind_action`);默认核边状态与 `action` 一致(409 `ledger_state_mismatch`,hint 提 `--backfill`)并写 `evidence:"state"`;`backfill:true` 要求 `relation_id`、跳过状态核对、写 `evidence:"lead_ack"`。
4. **写后环复查**(research §2.7):add 成功后再 `walkBlockers(blocker)` 一次,三态 `post_write_check`:`{cycle:false}` / `{cycle:true, path}` / `{cycle:null, reason:"unbounded"}`;不删。
5. 评论体:`buildLedgerComment(entry)` / `parseLedgerComment(body)` 放在 `packages/teamlead/src/bridge/dependency-ledger-comment.ts`(纯函数,零 IO;research §1.5 的两行格式:前缀人读首行 + `dl1:` base64url(canonical JSON),键集含 `relation_id` 与 `evidence`);常量一律从 `flywheel-config` 的 `dependency-ledger-contract` import(M1b);解析失败(含非法 kind/action 组合、非法 evidence)返回 `{ unparseable: true }`。
6. 历史码表 `LINEAR_RELATION_HISTORY_CODES = { ab:"blocker_added", br:"blocker_completed", rb:"blocker_removed" }`,其它 `unknown`;`log` 的评论查询写在本模块(含 `url / user / botActor`,⛔ 不改 `linear-query.ts`)。
7. 日志:只记 `[dependency] op=<operation_id> stage=<validate|mutate|verify|ledger> result=<classification>`;⛔ 不记 upstream `err.message`、路径、token(Codex R1-7)。
8. `kind` 只允许请求体覆盖为 `"discovered"`(discover 用);其它值 400 `invalid_kind`;`operation_id` 与 `parent_op` 只接受 uuid v4(⛔ 没有派生形状)。
RED 用例(T5–T7,清单 = research §8):401 / 403 scoped / 400 十例(含 `invalid_parent_op` 两例)/ 404 三例(带 `which`)/ 403 outside 带 `which` / 409 两层环与三层环(带 `path`)/ 409 `operation_id_conflict` 两例(关系 spy = 0)/ 422 unbounded(第 201 个节点)与 hasNextPage / 502 五例(throw、`success:false`、getter undefined、`relation.id ≠ op`、写后 fresh read 不符)且都不发评论 / `createRelation` spy 参数 `id === op`(主分支)/ `already_exists` 三源(this_operation 补评论一次;foreign 评论 spy = 0)/ **fallback 分支**同组用例(mock 忽略 id)/ 同 op 同内容重放评论只一条 / 评论扫描超界仍写并标 `scan_truncated` / 评论失败 200 + `ledger.ok:false` + `relation_id` / preflight 后注入外部反向边 ⇒ `post_write_check.cycle:true` 且 delete spy = 0 / 复查超界 ⇒ `cycle:null` / remove:relation_not_found 带 hint、relations_truncated、成功 + 评论 kind not_needed + `relation_id`、delete 三种失败、同 op 改内容 409 / note:非法组合 400、mismatch 409(hint 含 `--backfill`)、foreign 边显式 added 补记(`evidence:"state"`)、removed 补记、backfill 状态相反仍写且 `evidence:"lead_ack"`、backfill 缺 relation_id 400、端到端修复链(add → 评论失败 → 边被外删 → note 409 → backfill 成功 → log 可见)、同 op 二次 already / log:A4 全部 + 恶意 reason(含反引号、`dl1:`)round-trip + 三种改坏评论 unparseable + 同时间戳稳定 + parent_op / 并发两条 add 串行 / **校验阶段每个失败分支 create/delete spy = 0** / logger spy:响应与日志都不含注入哨兵(绝对路径、`Bearer …`、原始异常文本)。
完成判据:T5、T6、T7 绿;`plugin.ts` 改动只有挂载。

### M4 · `create-issue` 追加 `parentId`
文件:`plugin.ts:3413-3650`(≤ 25 行);测试:`packages/teamlead/src/__tests__/create-issue.test.ts` 追加(既有 create-issue 测试所在,✅)。
1. research §4:非字符串 400;lookup null 404;`projectName` 绑定不符 403;父单 team ≠ 目标 team 400;通过则 `createIssue({..., parentId: parent.id})`。
RED 用例(T8):缺省参数逐字节不变(spy 参数深比较)/ identifier → uuid / uuid 直通 / not found / 跨绑定 / 跨 team。
完成判据:T8 绿;`gemini-scoped-token.test.ts` 不动仍绿。

### M5 · CLI `flywheel-comm dependency`
文件:`packages/flywheel-comm/src/commands/dependency.ts`(新)、`index.ts`(`case "dependency"` + help 一段);测试 `commands/__tests__/dependency.test.ts`(新,注入 `fetchFn / log / errorLog / env`,仿 `epic-page.test.ts`)。
1. 六个子命令(`add / remove / note / discover / log / show`)与参数 = research §3;deps/envelope 逐字沿用 `epic-page.ts`;退出码 0 / 1 / **2**(真相已落但需补记或解环)。
2. `--operation-id` 缺省由 CLI 生成 uuid v4(`node:crypto randomUUID`,可注入),回显在 envelope 与 stderr;重试时 Lead 原样带上;校验用与服务端相同的 `OPERATION_ID_RE`。
3. `discover`:① create-issue(+`parentId`)② 逐条 add(请求体 `kind:"discovered"`,每条边一个**新** uuid v4 作 `operation_id`,`parent_op` = 本次 discover 的 op;各边 op 逐条回显在 `edges[]`);部分失败 ⇒ `partial_failure` envelope + 退出 1,⛔ 不删单;建单请求响应丢失 ⇒ `outcome_unknown` 退出 1,⛔ 不自动重试,stderr 给出精确查重命令 `GET /api/linear/issue?query=<title>&projectName=<project>`。
4. `ledger.ok:false` ⇒ stderr 打印完整 `dependency note …` 补记命令(含 `--relation-id`),退出 2;`post_write_check.cycle:true` ⇒ stderr 打印路径与「用 remove 解开一条」,退出 2;`post_write_check.cycle:null` ⇒ stderr 「写入成功但环复查未完成,请 dependency show 核对」,退出 2;`attribution:"foreign"` ⇒ 退出 0,stderr 提示「边已由他人建立,未记理由;要记就用 note --action added」。**所有 stderr 里的可复制命令**:每个参数经 `packages/flywheel-comm/src/shell-quote.ts` 的 `shellQuote`(从 `qa-result.ts:1276` 抽出共用,POSIX 单引号;`qa-result.ts` 改为 import 它,行为不变)引用;查重 URL 的 query 用 `URLSearchParams`(Codex R3-7)。`note --backfill` 要求 `--relation-id`。
5. `log`:stderr 人读时间线(`author` 与 `claimed_actor` 并列,`unparseable` 条目标出),stdout 单行 envelope。
6. `show`:调 `/api/epic-page/generate`,只投影 `ready_items.value` 与 `dependency_review.value`。
RED 用例(T9 = research §8):六个 happy path / 缺 `--reason` / 缺省 op 生成(uuid v4 正则)与回显、显式 op 透传、非 uuid 拒 / discover 无 `--blocks` 且无 `--blocked-by` / discover 每条边 op 各异、请求体带 `parent_op` 与 `kind:"discovered"` / discover 建单成功第二条边失败 / discover 建单响应丢失 ⇒ `outcome_unknown`、create-issue fetch 只调一次、stderr 查重 URL 精确且 title/project 经 `URLSearchParams` 编码 / `ledger.ok:false` ⇒ 退出 2 + 含 `--relation-id` 的补记命令 / **shell 引用七例**(`'`、`"`、换行、`$(id)`、反引号、`&`、`#`)反解析后逐字相等 / `post_write_check.cycle:true` 与 `cycle:null` 都 ⇒ 退出 2 / `attribution:"foreign"` ⇒ 退出 0 + 提示 / `note --backfill` 缺 `--relation-id` ⇒ `invalid_arguments` / log stdout 恒一行 / show 输出不含 items 全文 / 缺 token / 缺 project / Bridge 4xx 透传;`shell-quote.test.ts`:`qa-result` 既有引用行为逐字节不变。
完成判据:T9 绿;`node packages/flywheel-comm/dist/index.js dependency --help` 有输出。

### M6 · Lead 规则
文件:`packages/teamlead/lead-rules-base/runner-patrol-rules.md` 追加一节「依赖账本(FLY-2142)」(research §6);测试 `packages/teamlead/src/__tests__/fly2142-dependency-ledger-rule.test.ts`(新,仿 `fly369-patrol-rule.test.ts`)。
内容四条:拆 Epic 时先建子单再逐条 `dependency add`、再 `dependency show` 核第一波;执行中三类各用哪个动词;**取消一张单不等于减法**,页面「依赖需要减法的地方」非空时先审边再拉活;Runner 只提议(`ask --report`),不自己写。
完成判据:T11 绿;`lead-rules-bundle.test.ts` 不动仍绿。

### M7 · 真数据演练与证据(A7)
1. 向 Lead 用 `ask --report` 申请两张一次性测试子单(或由 Lead 指定);授权后在生产 Bridge(或本机临时 Bridge,写明「非生产实例」)跑 `add → show → remove → note(同 op 重放)→ log`;同一时刻用 GraphQL 直查 `inverseRelations` 与 `history` 作对照;记录删边历史码并回填 `implementation-notes.md`(若不是 `rb`,只改码表常量,不改合同)。
2. 看一次真评论的渲染,确认首行 `[dependency-ledger]` 与 `dl1:` base64url 行都原样可复制、未被 markdown 改写;若首行方括号被吃掉,前缀改为反引号包裹,`parseLedgerComment` 同时认两种,记 notes。
3. ⛔ 不动 FLY-2108 现有四条边、不给真实子单加评论。
完成判据:evidence 含上述各项 + **四条**全仓门命令原始尾部输出。

## 2. 稳定标识与显示标签

| 类 | 稳定标识(⛔ 不改) | 显示标签(只在 `labels.ts`) |
|---|---|---|
| 路由 | `/api/dependency/add` · `/api/dependency/remove` · `/api/dependency/note` · `/api/dependency/log` | — |
| CLI | `dependency add|remove|note|discover|log|show`;退出码 0 / 1 / 2 | — |
| 三类 token | `missed` · `not_needed` · `discovered`;动作 `added` · `removed` | 「漏掉的 / 不需要做的 / 新发现的」只出现在 Lead 规则与 help 文案 |
| 评论格式 v1 | `DEPENDENCY_LEDGER_PREFIX = "[dependency-ledger]"` 人读首行 + `LEDGER_MACHINE_LINE_PREFIX = "dl1:"` + base64url(canonical JSON),键集 `v/op/parent_op/relation_id/evidence/kind/action/blocker/blocked/claimed_actor/at/reason`,`v:1`;常量在 `flywheel-config/dependency-ledger-contract` | 首行人读摘要 |
| 操作标识 | `operation_id`(uuid v4,`OPERATION_ID_RE`;主分支下同时是 add 交给 Linear 的 relation id);`parent_op`(discover 父操作 uuid v4 或 null;add 请求里与 `kind:"discovered"` 绑定);`relation_id`;`evidence ∈ mutation | state | lead_ack`;请求字段 `claimed_actor`;`attribution ∈ this_operation | foreign`;`relationIdMode ∈ client | server`(M0 定) | — |
| kind × action | `missed→added` · `discovered→added` · `not_needed→removed`(`KIND_ACTION_MATRIX`) | — |
| 规则 | `subtraction.v1`(⚠️ 未获 founder 裁定,渲染用 `page.default_rule_note`) | 「依赖审阅:该减的、该判断的」;空态「0 个可观测警报…不代表没有该减的边」 |
| 审阅格 | 根格 `dependency_review`;`kind ∈ canceled_blocker | dependency_cycle | all_blocked`;`all_blocked.blocking_edges[]{blocker, blocked, blocker_state_type, in_scope}` ≤ 50 + `blocking_edges_truncated: boolean` | 三条人话文案 + 前沿边行(中性措辞) |
| 历史码表 | `LINEAR_RELATION_HISTORY_CODES`(`ab / br / rb`;其它 `unknown`) | `log` 的 `meaning` |
| 错误码 | `project_required` · `unknown_project` · `project_unbound` · `unsupported_option` · `invalid_identifier` · `invalid_reason` · `invalid_operation_id` · `invalid_parent_op` · `invalid_actor` · `invalid_kind` · `invalid_kind_action` · `operation_id_conflict` · `self_dependency` · `linear_not_configured` · `issue_not_found` · `issue_outside_project` · `dependency_cycle` · `cycle_check_unbounded` · `relation_not_found` · `relations_truncated` · `linear_unavailable` · `linear_write_unconfirmed` · `ledger_unrecorded` · `ledger_state_mismatch` · CLI:`missing_token` · `missing_project` · `invalid_arguments` · `partial_failure` · `outcome_unknown` · `repair_required` · `bridge_unreachable` | — |
| 上界 | 环检查 200 节点(写前、写后各一次)· 关系/历史/评论分页各 10 页 · 总 deadline 20 s · `reason` ≤ 2000 字符 · 前沿边 50 条 | — |
| create-issue | 新可选字段 `parentId` | — |

## 3. 迁移与回滚

- 迁移:全部 additive —— 新路由、新 CLI 子命令、`create-issue` 一个可选字段、页面模型一个新根格 + 一个规则号 + 若干标签、Lead 规则一节。⛔ 不改任何表、既有路由签名、`ready.v1` / `dependents.v1` / `scope.v1`、回执守卫、patrol、workflow 引擎;⛔ 不加 flag。
- 页面根格是**精确键集**,所以这是 `EpicPage` 文档形状的一次变更;文档不持久化(只写 source-only 回执),没有旧文档需要迁移;B/D 尚未开工,没有下游消费者要同步。
- 回滚:revert PR 即回现状。已写进 Linear 的关系与评论**不回滚**(它们是 Lead 的决定,不是本代码的状态);`log` 消失后评论仍可在 Linear 上人读。
- 自托管:合并与部署分离;本单不请求 ship;部署由 updater 窗口完成。

## 4. 失败路径(显式)

| 失败 | 处置 | 证据 |
|---|---|---|
| 写路径校验阶段任一不过 | 对应 4xx;`createIssueRelation` / `deleteIssueRelation` 零调用 | T5/T6 |
| preflight 发现环 / 超界 | 409 `dependency_cycle{path}` / 422 `cycle_check_unbounded`;零写入(⚠️ 只对本进程可见的环) | T5 |
| preflight 后被外部写入抢先成环 | 关系已写;200 + `post_write_check.cycle:true, path`;CLI 退出 2;⛔ 不自动删 | T5/T9 |
| 写后环复查超界 | 关系已写;`post_write_check.cycle:null, reason:"unbounded"`;CLI 退出 2 并提示生成页面核对 | T5/T9 |
| add 时边已存在但 `relation.id ≠ operation_id`(founder / 他人建的) | `already_exists / foreign`;**不写评论**;CLI 退出 0 + 提示;Lead 要记理由用 `note --action added`(显式断言) | T5/T6/T9 |
| `note` / add 的 `kind × action` 不在矩阵 | 400 `invalid_kind_action`;评论里出现的非法组合在 `log` 里 `unparseable` | T5/T6/T7 |
| 同一 `operation_id` 带不同内容重来 | 409 `operation_id_conflict`(响应附已记录的那份);关系与评论零写入 | T5/T6 |
| 评论失败后、补记前边被外部改掉 | 默认 `note` 409 `ledger_state_mismatch` + hint;`note --backfill --relation-id <id>` 写入 `evidence:"lead_ack"`(Lead 显式认账,服务端不核状态) | T6/T9 |
| Linear 拒绝调用方 relation id(M0 探出) | 实现走 fallback 分支(research §2.8):首次写不传 id;`already_exists` 只在同 op 评论的 `relation_id` 相等时归本 op,否则 `foreign` 不自动补记 | M0/T5 |
| Linear 不可达 / 超时(mutation 前) | 502 `linear_unavailable`;日志只记分类 + op | T5/T6 |
| mutation 抛错 / `success:false` / 实体无 id / 写后 fresh read 不符 | 502 `linear_write_unconfirmed`;**不发评论**;Lead 用同一 `operation_id` 重跑(research §2.6 第 5 条) | T5/T6 |
| 关系写成功、评论失败 / 未确认 | 200 + `ledger.ok:false`;CLI 退出 2 并打印 `note` 补记命令;`note` 幂等 | T5/T6/T9 |
| 评论扫描超界(查「已记过」时) | 仍写评论,响应 `ledger.scan_truncated:true`(宁重复不漏记) | T5 |
| `note` 的 action 与当前边状态不符 | 409 `ledger_state_mismatch`(带当前状态) | T6 |
| discover 建单成功、加边失败 | `partial_failure`,列出已建单与失败边;不删单 | T9 |
| discover 建单响应丢失 | `outcome_unknown`,不自动重试,提示查重 | T9 |
| `log` 分页超界 | `truncated:true`,已取到的照出 | T7 |
| 评论被人工改坏 | `log` 里 `unparseable:true` 原样列出 | T7 |
| 页面:任一 item 的 `state` / `blocked_by` 不 known | 生成失败(抛错,不出半页);它们是快照 fail-loud 的必备数据,⛔ 不静默跳过 | T1/T2 |
| 评论首行被 Linear markdown 改写 | 前缀改反引号包裹,解析器双认;记 notes | M7-2 |
| Lead 不授权生产写 | A7 记「未执行」,其余门照过 | evidence |

## 5. 负向守卫(边界校验)

- 外部输入:`projectName`、两个 identifier 正则、`reason` 长度/控制字符、`operation_id` 形状、`claimed_actor` 正则、`kind`/`action` 枚举、`parentId` 字符串、`issue` 查询参数;其余一律 400。
- 项目边界:两端 issue 都 `issueMatchesBinding`;跨项目边 403(测试:同 team 不同 project、缺 scope label 两例)。
- Linear 写:只有四种调用(research §7);测试用 spy 断言路由模块内没有别的 SDK 写方法被调用;每次写都验 `success === true` + 实体 id + 写后 fresh read。
- 注入:评论机器行是 base64url(canonical JSON),字母表里没有 Markdown 元字符,`reason` 里的换行 / `by:` / `reason:` / JSON 字样 / 反引号 / Markdown 都只是内容(T7 round-trip);`claimed_actor` 只是声明,作者取 Linear 的 `user/botActor`;`kind × action` 非法组合进不了账本;HTML/MD 渲染动态文本一律转义(既有 `escapeHtml` / `escapeMarkdownTableCell`)。
- 泄漏:错误响应**和 Bridge 日志**都不含异常文本、路径、token(T5 对响应与 logger spy 同时断言);`log` 输出只含 Linear 返回的 identifier / 作者名 / 评论正文。
- CLI 输出面:stderr 里打印给人复制的命令,参数一律 POSIX 单引号引用(共享 `shellQuote`),URL query 一律 `URLSearchParams`;`reason` / `title` 不得成为 shell 或 URL 的执行/结构面(T9 七例)。
- 权限:master token;scoped 403;ingest 401。
- 自动化:grep 断言 `patrol-tick.ts`、`fleet-sensors.ts`、`gate-poller` 相关文件零处 import `dependency-route`(Bridge 不自己调用写路径)。

## 6. 测试与证据矩阵

| # | 内容 | 位置 |
|---|---|---|
| T0 | `flywheel-config` 合同常量(正则 / 矩阵 / 键集) | `packages/config/src/__tests__/dependency-ledger-contract.test.ts` |
| T1 | `computeDependencyReview` 九例 | `epic-page/__tests__/rules.test.ts` |
| T2 | 守卫六例 + golden + 回执不含派生格 | `epic-page/__tests__/model.test.ts`(回执断言放既有 receipt 测试) |
| T3 | 生成器:审阅格出处路径完整;canceled 一例 | `epic-page/__tests__/generate.test.ts` |
| T4 | A1 四步演练 + A2 两例 | `epic-page/__tests__/drill.test.ts` |
| T5 | add 路由矩阵 + 校验阶段零写入 + 完成态四例 + 幂等重放 + 写后环复查 + 串行 + 响应/日志哨兵 | `bridge/__tests__/dependency-route.test.ts` |
| T6 | remove 路由矩阵 + note(mismatch / 补记 / 幂等) | 同上 |
| T7 | log 合并/过滤/码表/unparseable/恶意 reason round-trip/同时间戳/author 并列/truncated | 同上 |
| T8 | create-issue parentId 六例 | `src/__tests__/create-issue.test.ts` |
| T9 | CLI 全部用例 + shell 引用七例 + `shell-quote` 回归 | `flywheel-comm/src/commands/__tests__/dependency.test.ts` · `src/__tests__/shell-quote.test.ts` |
| T10 | 渲染:新小节 HTML/MD、零条、转义、parity +1、默认规则注记 | `epic-page/__tests__/render.test.ts` |
| T11 | Lead 规则内容合同 | `src/__tests__/fly2142-dependency-ledger-rule.test.ts` |
| T12 | 真数据演练(A7) | `implementation-evidence.md` |
| A5 | 通用主语 grep = 0 | 收尾脚本一行,输出贴 evidence |
| A6 | 既有 epic-page 测试零改动全绿;`receipt.ts` `git diff` 为空 | evidence |

## 7. 运维说明(写给任意 Lead)

1. **前置(一次性,本单代码之外)**:`projects.json` 里该项目要有 `linear` 绑定;Epic 父单拖到 In Progress;有一张标题含「日常」的常驻父单。没有这些,`dependency show` 会 422 `active_scope_not_found`,`add/remove` 会 404 `project_unbound`(这两条错误码就是在提醒你去做前置)。
2. **拆 Epic 时**:先建子单;再对每一条「做 X 之前先做 Y」跑 `flywheel-comm dependency add --blocker Y --blocked X --reason "…"`;最后 `dependency show` 看第一波(`ready`)是不是你想的那几张。
3. **执行中**:漏了一条 ⇒ `add`;一条不需要了 ⇒ `remove`(**取消 issue 不等于减法**:被它挡着的单不会自己放行);发现新活 ⇒ `discover --parent <Epic> --title … --blocks X`。命令退出码 2 = 边已经改了、但理由没记上或刚好成环:照 stderr 打印的 `note` / `remove` 命令补一次即可;重试同一次意图时带上它回显的 `--operation-id`,不会记重。
4. **每次巡检**:页面「依赖审阅」非空 ⇒ 先审边(删、或改指别的单),再拉活;它列的是「已取消却仍挡人」「互相等」「全部收死(并列出在等的边,范围外的会标出来)」三种。**它看不见「blocker 还活着、但你已知不需要」的边** —— 那种只能靠你 `remove`;空态那句「不代表没有该减的边」就是在提醒这个。补记命令 409 说「状态不符」时,若你确认那次操作发生过,加 `--backfill --relation-id <回执里的 id>`,账本会标明这是你认的账。
5. **读账**:`dependency log --issue X` 看这张单的边什么时候被谁加/删/解,以及每条的理由;founder 直接在 Linear 改的边也在里面,只是没有理由行;被人改坏的记录会标 `unparseable`,不会消失。
6. **Runner** 发现依赖:用 `ask --report` 告诉你,由你判断后落账;Runner 的令牌打不开这些路由。

## 8. 明确不做

自动删边或自动释放(Lead 裁定);StateStore 账本副本(Lead 裁定);在评论里记「想删还没删」的意图状态机(Codex R1-1 备选,拒绝:第二套状态、且 Lead 想删直接 `remove`);改 `ready.v1` / `dependents.v1` / `scope.v1`;从正文推断依赖;把「blocker 在 backlog / 范围外」列为减法候选;残余扫描与拉活(B);事件/扫描自动更新与过期告警(D);Linear MCP 侧的关系工具;批次对象;任何 flag;删除 issue;非 `blocks` 类型的关系。

## 9. 给实现节点的实现期检查(research §10)

1. `IssueRelationType` 的运行时取法:`linear-epic-query.ts` 只 import 了 `type { LinearDocument }`;若顶层无运行时枚举,传字面量 `"blocks"` 并以 `LinearDocument.IssueRelationType` 标注类型(SDK `_generated_documents.d.ts:7566-7571` 枚举值就是 `"blocks"`)。
2. 同一对 issue 重复 `createIssueRelation` 的真实行为,写进 notes(本单靠前置检查规避)。
3. 删边历史码(§9 表 `rb` 为预期),M7 实测后定。
4. 评论首行 markdown 渲染,M7 看一次。
5. `create-issue` 对 `Flywheel` 项目的 team-scoped 解析是否唯一(既有 ambiguous 分支),补绑定后跑一次。
6. 既有 epic-page 测试里是否有 `state` / `blocked_by` 为 missing 的 fixture:预期为零(生成器从不产出);若有,那个 fixture 描述的是生成器不会产生的文档,以生成器不变量为准处理,并在 notes 里写明。
7. `IssueRelationPayload.success` / `CommentPayload.success` / `IssuePayload.success` 与各自 getter 的 SDK 形状(`_generated_sdk.d.ts` ~L1159-1169、~L2482-2489、~L5918-5928、~L6010-6020,Codex R1 给的位置),写测试前先核。
8. **调用方指定 relation id** 已提前为 M0 探针(research §2.8),两条分支合同已定;M0 只选分支,不改 plan。
9. base64url 机器行在 Linear 评论里的渲染(M7-2):确认整行原样可复制、未被当成链接或强调(字母表含 `_`,以真实渲染为准)。
10. `qa-result.ts:1276` 的 `shellQuote` 抽到共享模块时,先给现有行为写回归测试(逐字节),再搬。

## 10. 与兄弟单的冻结点(本单交付后不再变的合同)

根格 `dependency_review` 的名字与三种 `kind` 的字段(含 `all_blocked.blocking_edges[]` 四字段与 `blocking_edges_truncated`);规则号 `subtraction.v1`;四条路由路径与错误码;CLI 六个子命令名与退出码 0/1/2;评论格式 v1(前缀首行 + `dl1:` base64url canonical JSON 的十二键精确键集);`flywheel-config/dependency-ledger-contract` 的导出名;`operation_id` = uuid v4(主分支下 = relation id)、`parent_op`、`relation_id`、`evidence` 三值;`attribution` 两值;`kind × action` 矩阵;`create-issue.parentId`。B/D 只能**追加**(例如 B 在 `all_blocked` 时选择提醒 Lead 而不是拉活;D 把 `log` 时间线当「这一格何时变的」来源),⛔ 不改上述。
