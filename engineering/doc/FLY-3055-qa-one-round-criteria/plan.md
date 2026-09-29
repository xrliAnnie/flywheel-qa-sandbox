# FLY-3055 QA 一轮测全 + 判据清单 — 实施计划
Issue: FLY-3055 (https://linear.app/geoforge3d/issue/FLY-3055/机制qa-一轮测全问题一次列全再判复验只验改动部分实现体修问题要补相邻路径-写进协议-qa-result-判据清单强制校验founder)
日期: 2026-09-29
基于: exploration.md、research.md

版本: v4（Codex R1 10 项 + R2 6 项 + R3 5 项全部处理，见 §13 修订轨迹）

## 0. 一句话

QA 交判决必须带一份结构化判据清单（`qa-criteria/v1`，`--criteria-file`）：CLI 先拒、Bridge 在两条 ingest 路径都在写库前权威校验；**被消费者接受**的 verdict 连同清单在**接受状态的同一事务**里登记进一张 append-only 的「已接受 QA verdict」账本；下一轮 QA（和修它的实现体）开局由 Bridge 从这张账本读**紧邻上一条已接受 verdict** 注入全部出口，未被改动碰到的 pass 项用 `carried` 引用沿用，不重跑。

## 1. 边界与不变量

- **目标文件映射**（本仓库无 `phase-protocols/`、无 `agents/nodes/`，见 exploration §2.1）：QA 协议 = `Blueprint.ts` 两段 QA prompt + `.flywheel/agents/engineering/qa-executor.md`；implement 协议 = Blueprint `## QA Fix Round` 块 + `engineer-executor.md`。已非阻塞问 Lead（question `e8517948`），无异议按此。
- **一份规则，三处执行。** 解析、判决规则、引用规则全在 `packages/config/src/qa-criteria.ts`（`flywheel-config`）；CLI 预检、Bridge 路由前置、P1 事务内复核调用同一函数。
- **「上一轮」= 紧邻的上一条已接受 verdict，不是任意落库事件。**（R1#1/#5/#8）接受点 = 消费者真正采纳 verdict 的那一行代码；账本按接受顺序（自增 id）排序，不按 attempt、不按 `verdict_event_id`（后者在 retarget/reopen 时被清空，`StateStore.ts:5307-5316,5351-5363`）。
- **ingest 与消费者用同一身份。**（R1#3）`/events` 的 qa_result：`payload.qaExecutionId` 必须等于 `execution_id`，否则 400；prior scope 从持久关联（AutoQaRecord / 阶段会话）确定，不由请求字段选择。
- **拒收发生在写库之前；精确重放先于所有校验返回原结果。**（R1#4）**回执只说真话**（R2#4）：`/events` 响应区分 `accepted`（账本有行，附 ref）/ `stored`（已落库、消费者未接线，启动 sweep 消费）/ `ignored`（消费者按其规则丢弃）；ref 永远从账本读，不由 event_id 拼。
- **接受 = 一个 StateStore 原子操作。**（R2#1）三条路径各有一个窄事务：状态/intent/claim 与账本行同提交，事务内按当前最新 prior 复核；没有半写。
- **只对 QA verdict 强制。** `codex-review-result`、founder gate 不带清单；credential 家族非 `qa_verdict` 却带清单 → 拒。
- **注入只有一个入口** `resolveQaCriteriaContext`；出口只拼接；每个出口的传输通道有独立有界追加位，不进任何既有截断（R1#2）。
- 参数化 SQL；注入文本去控制字符、按字段截断；纯文本 prompt。
- 不改 claim 谓词、不改 FSM、不改 AutoQaRecord 状态机、不改 ship 判定、不新增/删除 CLI 子命令、不设 feature flag（founder 要强制机制；回滚顺序见 §10）。

## 2. 数据契约 `qa-criteria/v1`

CLI 输入 `--criteria-file <path>`（≤64KB，UTF-8 严格解码），JSON：

```json
{
  "version": 1,
  "items": [
    { "id": "AC1", "title": "FAIL 时未测且无原因 → CLI 拒收", "status": "pass", "evidence": "qa-criteria.test.ts + real CLI exit 1" },
    { "id": "AC2", "title": "复验开局可见上一轮清单", "status": "fail", "evidence": "expected wake lists AC1..AC4; actual: none" },
    { "id": "AC3", "title": "529 真房复验", "status": "not_run", "reason": "依赖 AC2 的注入，随 AC2 下一轮一起测" },
    { "id": "AC4", "title": "协议 grep 核对", "status": "carried", "claim": "qv:3f1c9a2e-…", "evidence": "上一轮 grep 输出；本轮 diff 未触及协议文件" },
    { "id": "AC5", "title": "旧拆分项", "status": "merged", "into": "AC1" }
  ]
}
```

| 字段 | 规则 |
|---|---|
| 顶层 | 只允许 `version`(=1)、`items`；未知键拒 |
| `items` | 非 merged 1..30；merged 0..30；总数 ≤60 |
| 长度单位 | 一律 JavaScript `String.length`（UTF-16 code unit） |
| `id` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$`，清单内唯一 |
| `title` | 非 merged 必填，trim 后 1..120；merged 可选 |
| `status` | `pass \| fail \| not_run \| carried \| merged` |
| `evidence` | `fail`、`carried` 必填；`pass` 可选；其余禁止；≤200 |
| `reason` | 仅 `not_run`，必填，≤200，不等于占位词（大小写不敏感：`n/a` `na` `none` `skip` `skipped` `todo` `tbd` `-` `无` `略`） |
| `claim` | 仅 `carried`，必填。正整数或字符串（`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`），规范化为字符串；语义 = Bridge 注入并在接受回执里返回的**上一条已接受 verdict 的 ref**（§5.0） |
| `into` | 仅 `merged`，必填，指向本清单内另一条非 merged 条目 id，不可自指 |
| 文本 | 拒 C0 控制字符（`\t` 除外）、U+2028/2029、孤立代理项 |

`merged` 退役/合并旧判据不丢账：源 id 必须在紧邻上一轮清单里（服务端查）；源上一轮为 `pass`/`carried`（链可沿用）→ 目标任意非 merged 状态；源为 `fail`/`not_run` → 目标本轮必须是 `fail`/`not_run`。首轮不得出现 `carried`/`merged`。**满员（30 条非 merged）时要加新判据**（如 founder-feedback）：先把一条已通过的旧 id `merged` 进相邻判据腾位，再添加（R1#7）。

**判决规则 `validateQaCriteriaVerdict(status, criteria)`**（只看非 merged）：`fail` 需 ≥1 条 `fail`；`pass` 需 0 条 `fail` 且 ≥1 条 `pass`/`carried`；否则 `qa_criteria_verdict_mismatch`。形状错误 → `qa_criteria_invalid`（detail：第几条、哪个字段、原因）。

**规范形** `parseQaCriteria` → 固定键序、trim、保持提交顺序；`qaCriteriaCounts`；`workflowDecisionEvidence(summary, criteria)` → `{summary?, qa_criteria?}`，无清单时与旧 `{summary}` / `undefined` 字节一致；`canonicalQaResultPayload(payload)` → 用于 `/events` 重放比较（§5.3）。

**引用规则 `checkQaCriteriaAgainstPrior(criteria, prior, loadByRef)`**（服务端，`prior: AcceptedQaVerdict | undefined`）：

- `carried.claim` 必须等于 `prior.ref`，且 prior 清单里同 id 状态为 `pass`/`carried`；沿 carried 链走到 `pass` 终点，每跳 `loadByRef(ref)` 必须存在、**同 scope 且 seq 严格更小**（不用 attempt，R1#8）、每跳撤销原因都在白名单 `QA_CARRY_COMPATIBLE_REVOCATION_REASONS`（P1 claim 的撤销原因；其余 source 恒空）。拒 → `qa_criteria_carried_invalid`，detail `{id, claim, cause: no_prior|not_latest_prior|criterion_missing|criterion_not_passed|chain_broken|chain_revoked_incompatible, priorRef}`。
- `merged` 规则如上；拒 → `qa_criteria_merge_invalid`，detail `{id, into, cause: not_in_prior|unresolved_into_passing_target|chain_*}`。
- 覆盖：prior 有清单时其每个非 merged id 必须出现在本清单（任意状态）；缺 → `qa_criteria_prior_uncovered`，detail `{priorRef, missing:[...]}`（全部列出）。prior 无清单（上线前 verdict）→ 跳过覆盖。
- 首轮（无 prior）出现 carried → `no_prior`；merged → `not_in_prior`。

`evaluateQaCriteriaSubmission({family, status, criteria, loadPrior, loadByRef})` 把「家族 → 必填 → 判决 → 引用」串成一个调用。

## 3. 共享模块 `packages/config/src/qa-criteria.ts`（flywheel-config）

导出：`QA_CRITERIA_SCHEMA="qa-criteria/v1"`、上限常量、类型 `QaCriteriaV1/QaCriterion/QaCriterionStatus/AcceptedQaVerdict/QaCriteriaRejection`、`parseQaCriteria`、`validateQaCriteriaVerdict`、`qaCriteriaCounts`、`workflowDecisionEvidence`、`qaCriteriaFromEvidence`（读回，解析失败 → null）、`canonicalQaResultPayload`、`qaCriterionCarryChain`、`checkQaCriteriaAgainstPrior`、`evaluateQaCriteriaSubmission`、`QA_CRITERIA_REJECTION_REASONS`（含 `qa_result_reporter_mismatch`、`qa_result_target_unbound`、`qa_result_replay_mismatch`）、`qaCriteriaRejectionHttpStatus`、`formatQaCriteriaRejection`、`loadQaCriteriaFile`。纯函数、无 I/O（除 `loadQaCriteriaFile`）。

## 4. CLI（`packages/flywheel-comm`）

- `index.ts runQaResult`（`:928`）：新增 `"criteria-file"`；status/target-exec 校验后、任何网络/marker 之前调用 `loadQaCriteriaFile`；失败 → stderr `formatQaCriteriaRejection` + `[qa-result] refused locally: no request was sent and no marker was written.`，exit 1。
- `qa-result.ts`：`QaResultOpts.criteria?`；events payload 与 credential body 都带 `qa_criteria`（规范形）。**回执按响应 `outcome` 分三种**（R2#4）：`accepted` → 打印 `[qa-result] accepted ref=<ref> criteria pass=N …`（ref 来自账本，QA 记下它，founder-feedback kickback 时引用）；`pending`（仅三阶段 holder 缺失，Bridge 启动 sweep 会消费）→ `[qa-result] stored; pipeline consumes it on Bridge startup — the ref arrives in your next wake`，exit 0；`not_accepted` → `[qa-result] NOT accepted: <reason> <detail>`，exit 2、label `not_accepted`、无 marker、不重试（reason 来自消费者：stale head / not the bound QA / lifecycle closed / stale prior …）。响应无 `outcome` 字段（旧服务端）→ 沿用旧 `delivered` 文案（回滚兼容）。
- 拒收分类：响应 `reason` ∈ `QA_CRITERIA_REJECTION_REASONS` → **不重试、不写 marker**，stderr 打印服务端 detail + 本地指引，exit 1。其余 4xx/5xx/网络维持 4 次退避 + marker。
- 无 `--criteria-file` 不本地拒（家族由服务端判）。
- 回滚兼容（R1#9）：`--criteria-file` 的 **parseArgs 声明与文件读取保留为独立最小 commit**（C2a），§10 回滚时最后撤。

## 5. Bridge（`packages/teamlead`）

### 5.0 已接受 verdict 账本 `qa_verdict_accepted`（新表，append-only；R1#1/#5/#8）

```sql
CREATE TABLE IF NOT EXISTS qa_verdict_accepted (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,            -- 'qv:<event_id>' | 'claim:<claim_id>'
  scope TEXT NOT NULL,                 -- 'auto-qa:<parent_execution_id>' | 'issue:<project>/<issue_id>'
  source TEXT NOT NULL CHECK (source IN ('auto-qa','three-stage','claim')),
  event_id TEXT NOT NULL UNIQUE,
  claim_id INTEGER,
  qa_execution_id TEXT NOT NULL,
  parent_execution_id TEXT,
  issue_id TEXT NOT NULL, project_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass','fail')),
  pr_head_sha TEXT NOT NULL,
  summary TEXT,
  criteria JSON,                       -- 规范形或 NULL（上线前 verdict）
  accepted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_qa_verdict_accepted_scope ON qa_verdict_accepted(scope, seq);
-- 触发器：拒绝 UPDATE/DELETE（与 workflow_claims 同款 append-only）
```

- `insertAcceptedQaVerdictRow(row)`（私有，只在下面三个事务内调用）：普通 `INSERT`；仅 `UNIQUE(ref)` / `UNIQUE(event_id)` 冲突视为幂等命中（读回已有行并核对 scope/status 一致，否则抛）；NOT NULL / CHECK 失败照常抛，事务回滚（R2#1：不用 `INSERT OR IGNORE` 吞错）。返回实际行。
- **三个原子接受操作（R2#1、R3#1/#2，全部 `StateStore` 方法，better-sqlite3 同步事务 `StateStore.ts:30-48`）。每个事务按固定顺序分流：**
  1. **已接受？** `getAcceptedQaVerdictByEvent(event_id)`（或 P1 的 `claim:` ref）命中 → 核对规范提交（reporter execution、issue/project、head、status、`canonicalQaResultPayload` 含规范 criteria）一致 → **复用该 ref、只补写尚未写入的状态/intent、跳过 prior 校验**；不一致 → 抛（同 event_id 不同内容，账本损坏级别）。这解决 P1 镜像先在 claim 事务入账、再进 phase 接受事务的正常顺序（R3#1），以及 claim 后 / intent 前崩溃的恢复。
  2. **legacy 事件？** 解码结果 `criteriaKeyPresent === false`（部署前落库、intent/账本都没有的旧事件，经启动 sweep 首次消费，`event-route.ts:590-595` → `phase-orchestrator.ts:892-928`）→ **受限 legacy 分支**（R3#2）：跳过 evaluator；若 scope 最新已接受 prior **带清单** → 拒（`{accepted:false, reason:'qa_verdict_legacy_refused'}`，写 session_event + Lead 告警：旧事件不能压掉新协议的覆盖义务，QA 需带清单重交）；否则登记 `criteria=NULL` 行，现有 consumer guard 照旧，下游注入 summary + 规则块。新 HTTP 提交永远要求清单（§5.3），带键但损坏的事件仍抛。
  3. **首次接受**：`evaluateQaCriteriaSubmission` 对**此刻**的 `getLatestAcceptedQaVerdict(scope)` 重跑（纯函数 + 一条查询）；不通过 → 事务回滚、返回 `{accepted:false, reason, detail}`（在线路径由 route 同步返回给 CLI，见 §5.3；延迟消费路径写 `qa_verdict_stale_prior` session_event + `alertLeadPipelineError`），verdict 不采纳、QA 保活。通过 → 写状态/intent + 账本行。
  ingress 校验（§5.2/§5.3）仍保留，负责即时 CLI 反馈；事务内复核只堵「延迟消费 / await 期间账本变化」的窗口。
  - `acceptAutoQaVerdictTx({parentExec, head, status, verdictEventId, ledgerRow})`：`setAutoQaStatus(...)` + 账本行。调用点 `auto-qa-coordinator.ts:1277`（PASS）/`:1300`（FAIL），替换原 `setAutoQaStatus` 首次调用；scope `auto-qa:<targetExec>`。
  - `acceptThreeStageQaVerdictTx({execId, intentPatch, ledgerRow})`：`patchSessionParams(three_stage_verdict ← intentPatch ∪ {ledger_ref})` + 账本行。`phase-orchestrator.ts` deps `qaVerdicts.acceptVerdict(...)` 替换 `:1161` 的首次 `patchIntent`（后续 `patchIntent` 不变）；scope `issue:<project>/<issue_id>`；被 intent 规则忽略的事件不登记。intent 新增字段 `ledger_ref`（有 = 新协议 verdict；无 = 部署前 legacy intent，R2#3）。
  - P1：账本行插入放进 `submitWorkflowDecisionByCredential` 的现有事务（`StateStore.ts:10517,10638-10705`），claim id 在事务内已知 → ref `claim:<id>`、event_id = 镜像事件 id `workflow-decision:<cred>:<req>`（路由随后 `insertEvent` 该 id）。同一 verdict 进 orchestrator 的 `acceptVerdict` 时按 event_id 命中已有行 → 幂等（intent 仍写、`ledger_ref` 取已有行 ref）。
- **接受时的清单来源**：三个事务都从 `ledgerRow.criteria` 取，而 `ledgerRow` 由**唯一解码函数** `qaVerdictFromStoredEvent(event)`（§5.1）构建；`criteria` 为 NULL 仅当持久 payload **没有 `qa_criteria` 键**（部署前事件）；键存在但解析失败 → 抛（不降级为 legacy，R2#2）。
- 查询：`getLatestAcceptedQaVerdict(scope)`、`getAcceptedQaVerdictByRef(ref)`、`getAcceptedQaVerdictByEvent(eventId)`；P1 ref 的撤销原因由 `loadByRef` 附查 `workflow_claim_revocation`。
- 迁移：`CREATE TABLE IF NOT EXISTS`，无数据回填；上线前的 verdict 不在账本 → 首轮语义（覆盖跳过、注入渲染「无清单」）。

### 5.1 `StateStore` 其他 + 唯一解码函数

- `getEventById(eventId)` → 完整 envelope `{event_id, execution_id, issue_id, project_name, event_type, payload}`（现有 `getEventPayloadById` `:3509` 只回 payload，重放身份比较需要 envelope，R2#4）。
- `qaVerdictFromStoredEvent(event)`（`packages/teamlead/src/qa-verdict-decode.ts`，纯函数）→ `PhaseQaVerdict`（新增字段 `qaCriteria: QaCriteriaV1 | null`、`criteriaKeyPresent: boolean`）。**三处调用同一函数**（R2#2）：`event-route.ts:564-580` 在线转发、`workflow-decision-routes.ts:272` 转发、`phase-orchestrator.ts:914-928` `reconcileQaVerdicts` 启动 sweep（现在各自手写解码，sweep 会丢清单）。
- `submitWorkflowDecisionByCredential` 增 `qaCriteria?`、`enforceQaCriteria?`：事务内、写 claim 前，`loadPrior = getLatestAcceptedQaVerdict('issue:…')`，调 `evaluateQaCriteriaSubmission`；拒 → `{ok:false, reason, detail}`，credential 不消费。已消费 credential 的精确重放仍先返回（`:10520-10540` 顺序不动）。

### 5.2 `workflow-decision-routes.ts`（P1）

1. 现有 400 校验后：`body.qa_criteria` → `parseQaCriteria` → 失败 400。
2. credential 命中且未消费：`evaluateQaCriteriaSubmission({family: credentialRow.family, loadPrior: issue scope})` 前置拒；已消费 → 直接进 submit 走重放。
3. submit 带 `qaCriteria/enforceQaCriteria`（账本行在同一事务内写入，§5.0）；`insertEvent` payload 带 `qa_criteria`；`onQaResult` 入参由 `qaVerdictFromStoredEvent` 构建；响应体加 `outcome:'accepted'`、`ref:'claim:<id>'`（从账本读）。

### 5.3 `event-route.ts`（P2/P3）——顺序：身份 → 重放 → 校验 → 落库

在 `account_rotation` 分支后、required-field 校验后加 `qa_result` 分支：

1. **身份**（R1#3）：`payload.qaExecutionId` 存在且 ≠ `event.execution_id` → 400 `qa_result_reporter_mismatch`（CLI 恒相等，`qa-result.ts:89`）。reporter = `store.getSession(event.execution_id)`；不是 `session_role='qa'` → 409 `qa_result_reporter_not_qa`（下游本就拒，前移为显式拒，零副作用）。
2. **重放**（R1#4、R2#4）：`getEventById(event.event_id)` 命中 → 比较 envelope 身份（`execution_id/issue_id/project_name/event_type`）+ `canonicalQaResultPayload`；全同 → `{ok:true, duplicate:true, outcome, ref?, reason?}`，`outcome` 按步骤 5 的持久化规则解析（账本行 → accepted+ref；否则最新 `qa_result_outcome` 事件；否则 not_accepted）；任一不同 → 409 `qa_result_replay_mismatch`；**不做 prior 校验**。
3. **scope**：reporter `chat_thread_role='qa'` → `issue:<project>/<issue_id>`；否则 auto-QA：`listAutoQaRecordsByQaExec(reporter)` 中 `parent_execution_id === payload.targetExecutionId` 的 record 必须存在 → scope `auto-qa:<parent>`；不存在 → 409 `qa_result_target_unbound`。
4. `payload.qa_criteria` → `parseQaCriteria`；`evaluateQaCriteriaSubmission({family:'qa_verdict', loadPrior: getLatestAcceptedQaVerdict(scope), loadByRef})`；拒 → 400/409 `{ok:false, reason, detail, hint}`，**不 insertEvent**。
5. 通过 → 现有 `insertEvent` + 下游（`event-route.ts:564-606` 同步 await 消费者）。两个消费者的 `onQaResult` 改为返回 `QaVerdictOutcome = {outcome:'accepted'|'not_accepted'|'pending', reason?, detail?}`（现有每条 ignore/warn 分支各给一个 reason 字符串；事务内复核拒 → 其 reason/detail）。响应在消费者返回**之后**决定（R3#3）：`accepted` → `{ok:true, outcome:'accepted', ref}`（ref 从账本读）；三阶段 holder 缺失（`:590-595`，启动 sweep **确实**会重放）→ `outcome:'pending'`；其余（consumer 返回 not_accepted、抛错被 `:597-606` 吞、auto-QA holder 缺失——auto-QA 启动恢复**不重放**原始事件，`auto-qa-coordinator.ts:1795-1844`）→ `outcome:'not_accepted'` + reason/detail。**每次响应前把 outcome 持久化**为 session_event `qa_result_outcome`（event_id `outcome:<verdict event_id>:<seq>`，payload `{outcome, reason}`），重放（步骤 2）按「账本行 → 最新 outcome 事件 → 无记录视为 not_accepted」回答，缺账本行**绝不**回 pending。
6. 「被拒 = 什么都没写」只对**新** event 的拒收成立；`pending` 只在有恢复 consumer 的三阶段 deferred 路径出现。

### 5.4 Lead 可见

auto-QA FAIL `postThread`（`auto-qa-coordinator.ts:1322`）、三阶段对应通知：summary 前加 `判据: pass N · fail N · not_run N · carried N · merged N`，计数从**账本行**算（启动恢复路径同源，R1#5）。

## 6. 注入（新文件 `packages/teamlead/src/qa-criteria-context.ts`）

**唯一入口** `resolveQaCriteriaContext(store, input) → QaCriteriaContextResult`，input 三种：`{scope}`（取最新已接受）、`{ref}`、`{eventId}`（经 `getAcceptedQaVerdictByEvent` 得真 ref，R2#3）。结果三态（R2#3）：
- `{kind:'none'}`：scope 无历史 → 合法首轮，不注入；
- `{kind:'found', qaBlock?, fixerBlock?, rules}`；
- `{kind:'missing'}`：调用方**声明**该 verdict 属新协议（intent 有 `ledger_ref` / 事件 payload 有 `qa_criteria` 键）但账本无行 → fail-closed（O5/O6 走 `refuse`）。调用方声明为 legacy（intent 无 `ledger_ref`）→ 入口返回 `found` 的 legacy 形态：只有 summary + 规则块，不终止。
store 抛错向上抛。

**qaBlock 渲染 `renderQaReverificationBlock(prior)`：**

```
## QA re-verification context (qa-criteria/v1, FLY-3055)
Previous QA verdict: <ref> = <pass|fail> on head <sha>[; revoked: <reasons>].
Scope: run `git diff <sha>..HEAD`. Re-test only criteria that diff touches plus every criterion marked fail, not_run or MUST-REVERIFY below. Do NOT re-run untouched passes: submit them as {"status":"carried","claim":"<ref>","evidence":"..."}. carried may cite ONLY <ref>. Every non-merged id below must appear in your new --criteria-file. You may add ids, or retire an id with {"status":"merged","into":"<id>"}: a previously passed id may merge into any target; a fail/not_run id may merge only into a target that is fail/not_run this round.
- AC1 [pass] <title ≤120> — <evidence ≤80>
- AC3 [not_run] <title ≤120> — reason: <reason ≤80>
- AC4 [pass, MUST-REVERIFY] <title ≤120>
```

prior 无清单 → head + summary(≤600) + 「上一轮没有判据清单：本轮从 issue 验收项建立完整清单」。预算：≤10,100 UTF-16 units（超出先丢 evidence/reason，永不丢 id）。

**fixerBlock `renderQaFixerBlock(prior)`**：仅 prior 为 FAIL：头 + 「Fix every criterion below. For each, also fix and add tests for the same logic's adjacent state paths (queued / started / dead / superseded / retried / concurrent, as applicable), not only the reported scenario, and list the adjacent paths you covered in your completion summary. The next QA round re-verifies only what your diff touches.」+ `fail`/`not_run` 行。

**规则块 `QA_CRITERIA_RULES_V1_QA` / `_FIXER`（≤2,000）**：与 §7 同义的英文常量，只随 wake 出口附带（旧 body 系统层无法更新）。

**出口与传输通道（每个出口独立有界追加位，不进既有截断）：**

| 出口 | prior 来源 | 通道改法 |
|---|---|---|
| O1 `retestWakeQa` | scope `auto-qa:<parent>` | `content` 末尾追加（该函数自拼 content，无截断） |
| O2 `feedbackWakeMain` | **就地**：`onQaResult` FAIL 分支刚登记的行（ref + 规范形清单，零额外查询 → 无新失败路径，R1#6） | 新 `WakeDetail.qaCriteriaSection`；`runner-wake.ts wakeText` 在 `FEEDBACK_TEXT_MAX` 截断**之后**追加，自身上限 12,500（R1#2） |
| O3 `spawnQa` | scope `auto-qa:<parent>` | `QaContext.qaCriteriaBlock` → Blueprint `buildQaModeSystemPromptLines` Steps 前 |
| O4 `wakePhaseRunner kind=retest` | scope `issue:…`（QA 会话 issue；不用 binding/attempt，R1#8） | `content` 末尾追加 |
| O5 `wakePhaseRunner kind=fix` | `{eventId: intent.event_id}` 精确读取（真 ref 可能是 `claim:` 或 `qv:`，R2#3）；legacy intent（无 `ledger_ref`）→ summary 形态 | orchestrator 在 `:1451-1457` 算好 `qaCriteriaSection` 传入 `WakePhaseRunnerArgs`（新字段），plugin `wakePhaseRunner` 拼到 `content` 末尾 |
| O6 `phaseFixContext` 新起（`:1330-1333` 与 `:1529` 两处） | 同 O5 | `phaseFixContext.qaCriteriaBlock` → Blueprint `## QA Fix Round` |
| O7 `respawnUnenrolledQa` / FLY-1050 respawn / handoff spawn | scope `issue:…` | `RunStartRequest.qaCriteriaBlock`（Bridge-INTERNAL）→ `BlueprintContext.qaCriteriaBlock` → 三阶段 QA 段 step 2 后 |
| **O9 actions retry**（R2#5、R3#5）：`actions.ts:826-886 handleRetry` → `retryDispatcher.dispatch(RetryRequest)` → `run-dispatcher.ts:583-638` 独立构建 BlueprintContext | phaseRole=`qa` → scope `issue:…`（qaBlock）；phaseRole=`implement` 且 issue 最新已接受为 FAIL → fixerBlock（scope 最新，非精确；写进边界） | `RetryRequest.qaCriteriaBlock`（QA）与 `RetryRequest.phaseFixContext = {round: runAttempt, qaSummary: <最新 FAIL summary>, qaCriteriaBlock: fixerBlock}`（implement），都由 `handleRetry` 调 resolver 填、HTTP body 不可注入；run-dispatcher 的 retry 映射把二者传到 BlueprintContext 的**既有**字段（`qaCriteriaBlock` / `phaseFixContext`），Blueprint 不新增顶层 fixer 字段——implement 侧复用 `## QA Fix Round` 块渲染。非 phase row 不填 |
| **O8 founder-feedback kickback**（R1#7） | scope `issue:…`（最新 = 刚 PASS 的 verdict） | `runner-wake.ts sendRunnerWake`：目标会话是三阶段 QA（`session_role='qa' && chat_thread_role='qa'`）且 kind=feedback_wake → 用 `WakeDetail.qaCriteriaSection` 追加（覆盖 `founder-consent/wiring.ts:205-217`）；`founder-action-drain.ts:218-239` 的 `feedbackWakeContent` 路径同样追加（drain deps 增 `store`） |

O2/O5/O6 的错误契约：O2 无新查询；O5/O6 结果为 `missing`（新协议 verdict 却无账本行）→ `runFailFlow` 现有 `refuse()` fail-closed 分支（`phase-orchestrator.ts:1198-1245`），不静默；legacy intent 不走 refuse。O1/O4/O8 查询失败 → 该 wake 返回 `{ok:false, error:'qa_criteria_context_unavailable'}`，走各自现有 fail-loud（O1：`driveRetest` 告警 + reconcile 重试；O4：`:1711` 告警；O8：`sendRunnerWake` 记 `runner_wake_failed` 事件）。**O2 现有 best-effort 语义不变**：crash-after-accept-before-wake 是既有缺口（`:1847-1895` 不重发实现体反馈），本计划不扩大也不修复，写进 R6 边界。

Blueprint 只新增可选 `qaCriteriaBlock?`（ctx / `QaContext` / `phaseFixContext`）；不设时的字节差异**只来自 §7 协议文本**（golden 重钉，R1#10）。

## 7. 协议文本（有效 prompt 字节 + role 文件）

### 7.1 Blueprint auto-QA `buildQaModeSystemPromptLines`（`:395-473`）

- Step 2 后插入 `2b. ONE-ROUND VERDICT (qa-criteria/v1, FLY-3055, mandatory): build a criteria list from the issue acceptance items, the plan, and any injected re-verification context BEFORE testing. Test every criterion you can in this round. A blocker on one criterion is recorded as fail and you keep testing the independent criteria — never stop at the first blocker, and never submit FAIL while testable criteria remain untested. Write <criteria.json>: every criterion is pass | fail | not_run (with a concrete reason) | carried (cites the injected previous verdict ref + evidence) | merged; the CLI refuses a verdict whose untested criteria lack a reason. The CLI prints \`accepted ref=<ref>\` — keep it; a founder-feedback kickback cites it.`
- `:449` 命令模板加 `--criteria-file <criteria.json>`，summary 占位改 `"<evidence and verdict>"`。
- `:461` c. FAIL：`with a specific report (exact scenario …)` → `with the COMPLETE criteria list (every fail has expected-vs-actual + severity in evidence; nothing left untested without a reason)`。
- `:463-464` d. RE-TEST：`re-run your scenarios` → `re-verify per the injected re-verification context: only what the fix touched plus previous fail/not_run criteria; carry untouched passes (status carried, claim = the injected ref). Small-fix real-room exemption: when the core behavior was already proven live on the previous verified head, this round's diff only fixes a small bug, the fix is covered by a unit or e2e test, and exact-head CI is green, do not rerun the live room — carry that criterion and name the new test + CI run in its evidence and in your report. Not for a first round or a diff that changes the core behavior.`
- codex 变体同义（不承诺 park/wake）。

### 7.2 Blueprint 三阶段 QA 段（`:1149-1190`、`:1762-1763`）

- Step 2 后插入 7.1 的 ONE-ROUND VERDICT 句。
- `:1162/:1171-1173/:1187-1188/:1762-1763` 六处命令模板加 `--criteria-file <criteria.json>`；kickback 附注 `(its <criteria.json> holds {"id":"founder-feedback","title":"founder feedback","status":"fail","evidence":"<requested changes>"} plus every id of your previous list, carried where untouched, claim = your last accepted ref; if the list is full, merge one passed id into a neighbour first)`。
- `re-run your scenarios directly` → 7.1 d 的复验句。

### 7.3 Blueprint 三阶段 implement `## QA Fix Round`（`:1140-1147`）

`QA summary:` 行后追加 `QA FIX ROUNDS (qa-criteria/v1, FLY-3055): when fixing a QA-reported failure, fix and test the same logic's adjacent state paths too (queued / started / dead / superseded / retried / concurrent, as applicable), not only the reported scenario. Your completion summary lists the adjacent paths you added tests for; the next QA round re-verifies only what your diff touches.` 再追加 `qaCriteriaBlock`（有则）。

### 7.4 auto-QA effects 命令模板（`auto-qa-effects.ts:666,781`）

`retestWakeQa` 文本与 QA issue 描述里的 `qa-result --status pass|fail --target-exec <parent>` 都加 `--criteria-file <criteria.json>`（R1#7）。

### 7.5 `.flywheel/agents/engineering/qa-executor.md`

- Work loop 3 后加 **3b. 一轮测全**（中文 + 英文短语 `never stop at the first blocker`、`qa-criteria/v1`、`Small-fix real-room exemption`）。
- Work loop 4：`On FAIL, hand specifics to the dev Runner and re-verify after the fix.` → `On FAIL, hand the COMPLETE criteria list to the dev Runner; re-verify only the changed parts per the injected re-verification context (carry untouched passes).`
- Reporting 段命令加 `--criteria-file <criteria.json>`。

### 7.6 `.flywheel/agents/engineering/engineer-executor.md`

Work loop 加 **2b. QA fix rounds（`qa-criteria/v1`, FLY-3055）**：`adjacent state paths` 一并补测试，交卷说明列出。

## 8. 测试（红→绿；local-test-policy：逐文件运行，不跑全套；选择清单在实现时按字面量/路径发现记录）

| 文件 | 覆盖 |
|---|---|
| `packages/config/src/__tests__/qa-criteria.test.ts`（新） | 形状矩阵；容量边界（30+2 合并+1 新增合法；31 拒）；判决真值表；规范化字节稳定；`workflowDecisionEvidence` 无清单时与旧字节一致；`claim` 数字/字符串规范为字符串；引用规则全 cause；三轮反例 A(AC1 pass)→B(AC1 fail)→C carried(A) 拒 `not_latest_prior`；三代链合法；链 seq 不递减 → `chain_broken`；撤销白名单内可 carry、外拒；merged 反例；满员合并腾位合法；`loadQaCriteriaFile` 非 UTF-8/超限/非文件拒；`canonicalQaResultPayload` 键序无关 |
| `packages/flywheel-comm/src/commands/__tests__/qa-result.test.ts` | 坏清单 → exit 1、零 fetch、零 marker；合法 → 两种 body 带规范化 `qa_criteria`；成功打印 `accepted ref=`；服务端 `qa_criteria_prior_uncovered`/`qa_result_replay_mismatch` → 不重试、无 marker、stderr 含 detail；503 仍 4 次重试 + marker |
| `packages/flywheel-comm/src/__tests__/qa-result-criteria-cli.test.ts`（新） | 真 dist 入口 + 缺 reason 的 not_run → exit 1、中英文指引、零连接（BRIDGE_URL 指向监听器计数为 0 的本地 server）；正控 200 |
| `packages/teamlead/src/__tests__/StateStore.qa-verdict-accepted.test.ts`（新） | 账本 append-only 触发器；UNIQUE 冲突幂等、NOT NULL/CHECK 失败抛且事务回滚（状态/intent/claim 都不落）；三个原子接受操作各自的**故障注入**（账本插入抛 → 状态未写；事务内复核拒 → 零写入 + `qa_verdict_stale_prior`）；两条待处理事件 B、C 都按 A 校验、先接受 B 后 C 被事务内复核拒；**P1 B carried(A) 整条路线** route→claim/ledger→phase 接受事务命中已入账行 → 复用 ref、补写 intent、零 stale-prior 告警、账本恰一行；claim 后 intent 前崩溃恢复同；legacy（无 `qa_criteria` 键）事件首次消费：scope 无新协议 prior → NULL 行 + summary 注入；scope 已有带清单 prior → `qa_verdict_legacy_refused` + 告警；scope 最新/精确 ref/按 event；**retarget 后仍可读到上一条**（`retargetAutoQaRecord` 前后）；reopen 后仍可读；同 exec 多历史 record 不影响；事务内复核拒 → credential 未消费、零 claim、零账本行 |
| `packages/teamlead/src/__tests__/workflow-decision-routes.qa-criteria.test.ts`（新）+ 既有 | QA 缺清单 400；review 带清单 400；mismatch 400；carried 各 cause 409；覆盖缺 id 409；首轮 carried 409；合法 → claim evidence + 账本行 + event payload + `onQaResult` 入参 + 响应 `ref`；拒后修正重交成功；既有 fixture 补 `validQaCriteria()` |
| `packages/teamlead/src/__tests__/event-route-fly3055-qa-criteria.test.ts`（新）+ 既有 fly579/fly859 | reporter 不一致 400 且零落库零下游；非 QA reporter 409；target 无 record 409；缺清单 400 `insertEvent` 未调；carried 引用非紧邻 409；**同 event_id 精确重放**（B carried(A) 已接受后重放）→ 200 duplicate + ref，不重新校验；同 id 改内容 → 409；合法 → 落库 + 下游不变 + 响应 ref；非 qa_result 事件字节不变；部署前无清单事件重放 200 |
| `auto-qa-coordinator.test.ts`、`auto-qa-effects.test.ts` | **真实路线**：FAIL 接受 → 账本行 → `driveRetest`(retarget) → O1 wake 文本含 `Previous QA verdict: qv:<A>` 与全部 id；死 QA → O3 start 请求 `qaContext.qaCriteriaBlock`；crash-after-retarget 重启 sweep 同样注入；同 head reopen 后注入；O2：最大清单 + 2,000 字 summary → **最终 mailbox content** 含全部 fail/not_run id（`runner-wake.ts` 层断言）；O1 查询失败 → `{ok:false}` + 告警 |
| `phase-orchestrator.fly887-keepalive.test.ts`、fly1050、plugin wake 测试 | **启动恢复**：带清单事件已入库、intent/账本未写 → 新 orchestrator `reconcileQaVerdicts` → 账本行含同一清单、O5/O6、Lead 计数、下一轮覆盖同源（R2#2）；A=FAIL intent 后 B=PASS 事件到达 → 账本只有 A → O5/O6 fixer 块来自 A（真 `qv:`/`claim:` ref）；部署前 legacy intent（无 `ledger_ref`）→ summary 形态不 refuse；新协议 intent 无行 → refuse；同 attempt 替换 QA（O7）拿到上一条 PASS 清单；O4 无 binding 也注入；O5/O6 精确读取失败 → `refuse` 路径 |
| `actions-retry-route.test.ts` | 已有 accepted A → phase QA failed → `/actions/retry` → 新 QA 最终 prompt 含 A ref + 全部 id（O9）；implement 重试带 fixer 块；HTTP body 里的 `qaCriteriaBlock` 被忽略；非 phase row 字节不变 |
| `event-route-fly3055-qa-criteria.test.ts`（续） | 回执三态：accepted（ref 来自账本）/ pending（仅三阶段 holder 缺失）/ not_accepted（intent 忽略 B、auto-QA guard 丢弃、消费者抛错、auto-QA holder 缺失，各带 reason）；`qa_result_outcome` 事件落库；**ignored 响应丢失后精确重试 → not_accepted 而非 pending**；P1 镜像事件重放 → ref 为 `claim:`；同 id 同 payload 异 envelope → 409；部署前无账本事件重放 → not_accepted |
| `runner-wake.test.ts` | `qaCriteriaSection` 在 1,500 截断后追加、上限 12,500；三阶段 QA 目标 feedback_wake 自动附带（O8）；非 QA 目标字节不变；`founder-action-drain` feedback_wake 同 |
| `Blueprint.fly579-qa-mode.test.ts`、`fly859`、`fly793`、golden | 新 golden（协议文本更新后）；`qaCriteriaBlock` 缺省不引入额外字节；非 QA/非 fix 角色 prompt 与改动前逐字相同；命令模板六处含 `--criteria-file`；三条关键短语出现在对应段 |
| `scripts/__tests__/test-qa-criteria-protocol-contract.sh`（新，接 CI） | grep 合同（§9.3）+ `QA_CRITERIA_RULES_V1_*` 与 role 文件关键短语一致 |

负控（删接线即红）：event-route 拒收分支、身份检查、事务内复核、账本登记（删掉后 O1 注入消失）、O2 的截断后追加。

## 9. 验收（对应 issue）

1. **CLI 拒收**：真入口 `qa-result --status fail … --criteria-file bad.json`（无 reason 的 not_run）→ exit 1、指引「先把剩下的判据测完或写明为什么没测」、无 marker、零连接。
2. **复验开局看到上一轮清单**：529 房（legacy auto-QA）：第一轮 FAIL 带清单（回执 `accepted ref=qv:…`）→ 实现体 push → `retest_wake` 文本含 `Previous QA verdict: qv:<same ref>` 与 `[pass]` 项 → 第二轮 `carried` 引用该 ref 被接受；截 wake 文本、清单文件、Bridge 日志、Lead 通知 `判据:` 行。三阶段与 P1 路径由 §8 测试证明。
3. **协议 grep**：`grep -n "qa-criteria/v1\|never stop at the first blocker\|Small-fix real-room exemption" .flywheel/agents/engineering/qa-executor.md packages/edge-worker/src/Blueprint.ts` 命中 role 一处 + Blueprint 两段；`grep -n "adjacent state paths" .flywheel/agents/engineering/engineer-executor.md packages/edge-worker/src/Blueprint.ts` 各一处；`! grep "hand specifics to the dev Runner and re-verify after the fix" qa-executor.md`；`! grep "any blocking issue" Blueprint.ts`；`grep -c -- "--criteria-file" packages/edge-worker/src/Blueprint.ts` ≥ 7。
4. `pnpm lint`、受影响包 build；exact-head PR CI 全绿为全量证据。

## 10. 上线、兼容、回滚（R1#9）

- 生效：merge + `git pull` + Bridge 重启。部署前已在跑的 QA body：下一次 wake 附带规则块；它若先交 verdict 会被 `qa_criteria_required` 拒并得到最小示例——刻意立即生效。
- 上线前 verdict 不在账本 → 首轮语义。
- **回滚顺序**（R1#9、R2#6；不是一次 revert）：
  ① revert C3/C4/C5（服务端强制 + 注入 + 协议文本）并重启 Bridge → 从此不再产生新协议 prompt/wake；账本表留着不读。
  ② **冻结受影响集合（保守，不按时间筛，R3#4）**：对运行实例**实际**的 `TEAMLEAD_DB_PATH`（默认 `~/.flywheel/teamlead.db`，`config.ts:130-132`；沙箱为 slot 的 teamlead.db，`scripts/test-deploy.sh:1400,1427`）只读查询 `sessions` 中 `session_role='qa'` 且状态非终态的**全部** execution（部署前启动、部署后经 O1/O4/O8 wake 学到新语法的旧 QA 也在内；`sessions` 只有 `started_at` 无 `created_at`，本就不该按时间筛），**并**用 `flywheel-comm sessions --project <p>` 列出 CommDB 已注册但 StateStore 尚无行的 pending launch（`run-dispatcher.ts:570-582,706-730`）。
  ③ **退出条件** = 集合为空：每个执行已终态（PASS 后被 pipeline 关闭、或 Lead 用现有 close-runner/terminate 动作关闭）。FAIL 后 park 等复测的 auto-QA **仍持有新语法**，不算退出；要么等它复测到 PASS 关闭，要么关闭它。
  ④ 集合为空后才一起 revert **C2b + C2a + C1**（C2b 依赖 C2a/C1 的 parser、拒收常量、计数逻辑，不能单独留下）。过渡期（①–③之间）C2b 对旧服务端响应兼容：无 `outcome` → 旧 `delivered` 文案（§4）。
  跨部署边界的同 request id 重放判 `replay_payload_mismatch`（仅影响丢响应重试）。
- 不设 feature flag。

## 11. Chunks

| chunk | 内容 | 依赖 |
|---|---|---|
| C1 | `flywheel-config` `qa-criteria.ts` + 测试 + 导出 | — |
| C2a | CLI 参数声明 + 文件读取 + payload 转发（独立最小 commit，回滚最后撤） | C1 |
| C2b | CLI 预检拒收、拒收分类、接受回执打印 + 单测 + 真入口测试 | C2a |
| C3 | 账本表 + 三个原子接受操作（含事务内复核）+ `getEventById` + `qaVerdictFromStoredEvent` 三处接线（含 `reconcileQaVerdicts`）+ intent `ledger_ref` + decision route + event-route（身份/重放/校验/三态回执）+ Lead 计数 + 既有 fixture | C1 |
| C4 | `qa-criteria-context.ts`（三态入口）+ 规则块 + 九个出口（含 O9 actions retry）+ `runner-wake.ts` 追加位 + `WakePhaseRunnerArgs.qaCriteriaSection` + `RetryRequest`/`RunStartRequest`/Blueprint 可选字段 + drain deps | C3 |
| C5 | 协议文本（Blueprint 三段 + effects 两处 + 两个 role 文件）+ golden 重钉 + shell 合同测试接 CI | C2b |

## 12. 风险与诚实边界

- R-a：`/events` 拒收会让部署前已在跑的 QA 首次交卷失败一次——刻意；hint 自带示例。
- R-b：`issue:` scope 包含同 issue 旧 run 的已接受 verdict；覆盖规则只要求 id 出现，不阻塞；注入块标 head，QA 按 diff 判断。
- R-c：O2 crash-after-accept-before-wake 不重发实现体反馈，是既有缺口，本计划不修。
- R-d：Bridge 不看 diff；「carried 是否真未被触及」靠 QA 判断（R6）。
- R-e：wake 文本变长（≤2,000 + 10,100 + 12,500 上限）；邮箱无硬上限。
- R-f：事务内复核拒收：在线路径（route 同步 await 消费者）→ CLI 当场收到 `not_accepted` + reason/detail；延迟消费路径（三阶段启动 sweep）→ CLI 早已返回 `pending`，Bridge 写 `qa_verdict_stale_prior` 事件 + Lead 告警，QA 靠下一次 wake 拿到当前 prior 重交。极少见，边界写明。
- R-h：legacy 首消费在 scope 已有新协议 prior 时被拒（`qa_verdict_legacy_refused`）→ 需要该 QA 重交带清单的 verdict；仅影响部署前落库、部署后首次消费的事件。
- R-g：O9 implement 重试的 fixer 块取 issue scope 最新 FAIL（非 intent 精确），与 O5/O6 略有差异；重试本就是人工动作，写明。

## 13. 修订轨迹

- v1 2026-09-29 初稿。
- v2 2026-09-29 Codex R1（4H/5M/1L）全部处理：#1 新增 append-only `qa_verdict_accepted` 账本，prior 不再沿 `verdict_event_id`（retarget/reopen 清空）；#2 O2 走 `WakeDetail.qaCriteriaSection` 在 1,500 截断后追加；#3 `/events` 身份一致性检查 + scope 从持久关联取；#4 重放先于校验；#5 三阶段接受点 = intent 首写，fixer 按 intent.event_id 精确读；#6 O2 就地取块零新失败路径，O5/O6 走 refuse；#7 新增 O8 founder-feedback 出口 + 接受回执 ref + title 修正 + 满员合并策略 + 命令模板补全；#8 seq 排序取代 attempt；#9 回滚顺序 + C2a 拆分；#10 golden 重钉 + 显式测试文件清单。
- v3 2026-09-29 Codex R2（2H/4M）全部处理：#1 三个原子接受操作（状态/intent/claim 与账本同事务 + 事务内复核 + 普通 INSERT 只吞 UNIQUE）；#2 唯一解码函数 `qaVerdictFromStoredEvent` 三处接线含启动 sweep，`PhaseQaVerdict.qaCriteria`，legacy 仅按键缺失判定；#3 resolver 三态 + `{eventId}` 入口 + intent `ledger_ref` 区分 legacy，O5 经 `WakePhaseRunnerArgs.qaCriteriaSection`；#4 回执三态 accepted/stored/ignored，ref 只从账本读，重放比较 envelope + payload，CLI `not_accepted` exit 2；#5 新增 O9 actions retry 出口；#6 回滚用实际 dbPath + 冻结集合含 pending launch + 退出条件 = 集合为空（FAIL 保活不算）。
- v4 2026-09-29 Codex R3（1H/3M/1L）全部处理：#1 接受事务三分流「已接受 → legacy → 首次」，已入账行复用 ref 跳过 prior 校验，DDL `UNIQUE(event_id)`；#2 legacy 事件首消费受限分支（scope 已有新协议 prior 则拒 + 告警）；#3 消费者返回 `QaVerdictOutcome`，回执 accepted/pending/not_accepted 持久化为 `qa_result_outcome` 事件，缺账本行绝不回 pending，R-f 措辞修正；#4 回滚冻结集合不按时间筛（`sessions` 无 `created_at`），C2b 与 C2a/C1 同步撤；#5 O9 implement 走 `RetryRequest.phaseFixContext` 复用既有 Fix Round 渲染，不加顶层 fixer 字段。
