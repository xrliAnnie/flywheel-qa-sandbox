# FLY-3055 QA 一轮测全 + 判据清单 — 实施计划
Issue: FLY-3055 (https://linear.app/geoforge3d/issue/FLY-3055/机制qa-一轮测全问题一次列全再判复验只验改动部分实现体修问题要补相邻路径-写进协议-qa-result-判据清单强制校验founder)
日期: 2026-09-29
基于: exploration.md、research.md

版本: v1（待 Codex design review）

## 0. 一句话

QA 交判决必须带一份结构化判据清单（`qa-criteria/v1`，`--criteria-file`）：CLI 先拒、Bridge 在两条 ingest 路径都在写库前权威校验并把清单和 verdict 原子存进现有落点；下一轮 QA（和修它的实现体）开局由 Bridge 从落点读**紧邻上一轮**清单注入七个出口，未被改动碰到的 pass 项用 `carried` 引用沿用，不重跑。

## 1. 边界与不变量

- **目标文件映射**（本仓库无 `phase-protocols/`、无 `agents/nodes/`，见 exploration §2.1）：QA 协议 = `Blueprint.ts` 两段 QA prompt + `.flywheel/agents/engineering/qa-executor.md`；implement 协议 = Blueprint `## QA Fix Round` 块 + `engineer-executor.md`。已非阻塞问 Lead（question `e8517948`），无异议按此。
- **一份规则，三处执行。** 解析、判决规则、引用规则全在 `packages/config/src/qa-criteria.ts`（`flywheel-config`）；CLI 预检、Bridge 路由前置、P1 事务内复核调用同一函数。
- **唯一真相 = verdict 现有落点。** P1 `workflow_claims.evidence.qa_criteria`；P2/P3 `session_events.payload.qa_criteria`。不建新表；不改 `auto_qa_record`、`sessions` 列。
- **拒收发生在写库之前。** `/events` 拒 → 不 `insertEvent`；`/api/workflow/decision` 拒 → credential 不消费、事务回滚。被拒 = 什么都没写，修正后同一 credential / 同一 event_id 重交。
- **只对 QA verdict 强制。** `codex-review-result`、founder gate 等不带清单；credential 家族非 `qa_verdict` 却带清单 → 拒。
- **注入只有一个入口** `resolveQaCriteriaContext`；七个出口只拼接。
- 参数化 SQL；注入文本去控制字符、按字段截断；纯文本 prompt。
- 不改 claim 谓词、不改 FSM、不改 AutoQaRecord 状态机、不改 ship 判定、不新增/删除 CLI 子命令、不设 feature flag（founder 要强制机制；回滚 = revert）。

## 2. 数据契约 `qa-criteria/v1`

CLI 输入 `--criteria-file <path>`（≤64KB，UTF-8 严格解码），JSON：

```json
{
  "version": 1,
  "items": [
    { "id": "AC1", "title": "FAIL 时未测且无原因 → CLI 拒收", "status": "pass", "evidence": "qa-criteria.test.ts + real CLI exit 1" },
    { "id": "AC2", "title": "复验开局可见上一轮清单", "status": "fail", "evidence": "expected wake lists AC1..AC4; actual: none" },
    { "id": "AC3", "title": "529 真房复验", "status": "not_run", "reason": "依赖 AC2 的注入，随 AC2 下一轮一起测" },
    { "id": "AC4", "title": "协议 grep 核对", "status": "carried", "claim": "3f1c…-event-id-or-812", "evidence": "上一轮 grep 输出；本轮 diff 未触及协议文件" },
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
| `claim` | 仅 `carried`，必填。**正整数或字符串**（`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`），规范化为字符串；语义 = Bridge 注入的「上一轮 verdict 引用」（P1 claim id 数字 / P2、P3 事件 id） |
| `into` | 仅 `merged`，必填，指向本清单内另一条非 merged 条目 id，不可自指 |
| 文本 | 拒 C0 控制字符（`\t` 除外）、U+2028/2029、孤立代理项 |

`merged` 退役/合并旧判据不丢账：源 id 必须在紧邻上一轮清单里（服务端查）；源上一轮为 `pass`/`carried`（链可沿用）→ 目标任意非 merged 状态；源为 `fail`/`not_run` → 目标本轮必须是 `fail`/`not_run`（承接未解决义务）。首轮不得出现 `carried`/`merged`。

**判决规则 `validateQaCriteriaVerdict(status, criteria)`**（只看非 merged）：`fail` 需 ≥1 条 `fail`；`pass` 需 0 条 `fail` 且 ≥1 条 `pass`/`carried`；否则 `qa_criteria_verdict_mismatch`。形状错误 → `qa_criteria_invalid`（detail：第几条、哪个字段、原因）。

**规范形** `parseQaCriteria` → 固定键序、trim、保持提交顺序；`qaCriteriaCounts` → `{pass,fail,not_run,carried,merged}`；`workflowDecisionEvidence(summary, criteria)` → `{summary?, qa_criteria?}`，无清单时与旧 `{summary}` / `undefined` 字节一致。

**引用规则 `checkQaCriteriaAgainstPrior(criteria, prior, loadChain)`**（服务端，`prior: PriorQaVerdict | undefined`）：

- `carried.claim` 必须等于 `prior.ref`（紧邻上一轮），且 prior 清单里同 id 状态为 `pass`/`carried`；沿 carried 链走到 `pass` 终点，每跳 `loadChain(ref)` 必须存在、同源（P1 同 run+node 且 attempt 严格递减；P2/P3 同 issue 且事件序更早）、每跳撤销原因都在白名单 `QA_CARRY_COMPATIBLE_REVOCATION_REASONS`（沿用上游五个 reason；P2/P3 恒空）。拒 → `qa_criteria_carried_invalid`，detail `{id, claim, cause: no_prior|not_latest_prior|criterion_missing|criterion_not_passed|chain_broken|chain_revoked_incompatible, priorRef}`。
- `merged` 规则如上；拒 → `qa_criteria_merge_invalid`，detail `{id, into, cause: not_in_prior|unresolved_into_passing_target|chain_*}`。
- 覆盖：prior 有清单时其每个非 merged id 必须出现在本清单（任意状态）；缺 → `qa_criteria_prior_uncovered`，detail `{priorRef, missing:[...]}`（全部列出）。prior 无清单（上线前 verdict）→ 跳过覆盖。
- 首轮（无 prior）出现 carried → `no_prior`；merged → `not_in_prior`。

`evaluateQaCriteriaSubmission({family, status, criteria, loadPrior, loadChain})` 把「家族 → 必填 → 判决 → 引用」串成一个调用，三处执行点都用它。

## 3. 共享模块 `packages/config/src/qa-criteria.ts`（flywheel-config）

导出：`QA_CRITERIA_SCHEMA="qa-criteria/v1"`、常量上限、类型 `QaCriteriaV1/QaCriterion/QaCriterionStatus/PriorQaVerdict/QaCriteriaRejection`、`parseQaCriteria`、`validateQaCriteriaVerdict`、`qaCriteriaCounts`、`workflowDecisionEvidence`、`qaCriteriaFromEvidence`（从 claim evidence / event payload 读回，解析失败读作 null）、`qaCriterionCarryChain`、`checkQaCriteriaAgainstPrior`、`evaluateQaCriteriaSubmission`、`QA_CRITERIA_REJECTION_REASONS`、`qaCriteriaRejectionHttpStatus`、`formatQaCriteriaRejection`（中英文指引 + 最小示例，含「先把剩下的判据测完或写明为什么没测」）、`loadQaCriteriaFile(path, status)`（CLI 预检：读 + 解码 + parse + 判决）。`index.ts` 全部导出。纯函数、无 I/O（除 `loadQaCriteriaFile`）。

## 4. CLI（`packages/flywheel-comm`）

- `index.ts runQaResult`（`:928`）：新增 `"criteria-file"`；status/target-exec 校验后、任何网络/marker 之前调用 `loadQaCriteriaFile`；失败 → stderr `formatQaCriteriaRejection` + `[qa-result] refused locally: no request was sent and no marker was written.`，exit 1。成功把规范形传 `qaResult({..., criteria})`。help 加一行。
- `qa-result.ts`：`QaResultOpts.criteria?`；`buildQaResultBody` payload + `qa_criteria`；credential body + `qa_criteria`；成功后打印 `[qa-result] criteria pass=N fail=N not_run=N carried=N merged=N`。
- 拒收分类：响应体 `reason` ∈ `QA_CRITERIA_REJECTION_REASONS` → **不重试、不写 marker**，stderr 打印服务端 detail（`missing` 列表 / carried cause）+ 本地指引，exit 1。其余 4xx/5xx/网络维持现有 4 次退避 + marker。
- 无 `--criteria-file` 时 CLI **不**本地拒（家族由服务端判定；review 类 verdict 也走这条 CLI）——服务端对 QA verdict 拒 `qa_criteria_required`。

## 5. Bridge 校验（`packages/teamlead`）

### 5.1 `StateStore`（只读查询 + 事务内复核）

- `getPriorQaVerdictClaim({runId, nodeId, beforeAttempt})` → `PriorQaVerdict|undefined`：`workflow_claims` 同 run+node、`decision_kind='qa_verdict'`、`attempt < ?`，`ORDER BY attempt DESC, server_seq DESC LIMIT 1`；撤销原因 `SELECT reason FROM workflow_claim_revocation WHERE claim_id=? ORDER BY id`。`loadQaVerdictClaimByRef(ref)` 同形按 id。
- `getPriorQaVerdictEventForPhaseQa({issueId, projectName, excludeEventId?})` → 对 `getPhaseSessionsForIssue(issueId)` 中 `session_role='qa' && chat_thread_role='qa'` 的会话，`session_events.event_type='qa_result'` 且 `event_id != ?`，`ORDER BY id DESC LIMIT 1`（一条参数化 SQL，`execution_id IN (...)`）。
- `getPriorQaVerdictEventForAutoQa(qaExecutionId)` → `getAutoQaRecordByQaExec` → `verdict_event_id` → `SELECT event_id, payload FROM session_events WHERE event_id=?`。record 缺 `verdict_event_id` → undefined（首轮）。
- `loadQaVerdictEventByRef(eventId)` 供链查询；P2/P3 链的「更早」用 `session_events.id` 比较。
- `submitWorkflowDecisionByCredential` 增 `qaCriteria?: QaCriteriaV1`、`enforceQaCriteria?: boolean`：事务内、写 claim 前，用 credential 的 `family/run_id/node_id/attempt` 调 `evaluateQaCriteriaSubmission`；拒 → `{ok:false, reason, detail}`，不消费 credential。已消费 credential 的精确重放仍先于所有新校验返回原结果（现有 `:10520-10540` 顺序不动）。

### 5.2 `workflow-decision-routes.ts`（P1）

1. 现有 400 校验后：`body.qa_criteria !== undefined` → `parseQaCriteria` → 失败 400 `qa_criteria_invalid`。
2. `getWorkflowSubmissionCredentialByToken` 之后、`resolveWorkflowHeadAuthority` 之前：`evaluateQaCriteriaSubmission({family: credentialRow.family, ...loadPrior: getPriorQaVerdictClaim(run,node,attempt)})` 前置拒（400/409，body 含 `hint = formatQaCriteriaRejection`）。已消费 credential（`consumed_at`）跳过前置，直接进 submit 走重放。
3. `submitWorkflowDecisionByCredential({..., evidence: workflowDecisionEvidence(summary, criteria), qaCriteria: criteria, enforceQaCriteria: true})`。
4. `insertEvent` payload 与 `onQaResult` 入参都带 `qa_criteria`。

### 5.3 `event-route.ts`（P2/P3）

在 `account_rotation` 分支后、required-field 校验前加 `qa_result` 分支：

1. required 字段照旧校验（execution_id/issue_id/project_name/event_id）。
2. `payload.qa_criteria !== undefined` → `parseQaCriteria`；失败 400。
3. reporting = `store.getSession(event.execution_id)`；`session_role !== 'qa'` → 交给下游现有「非 QA 会话」拒绝逻辑（不在此拦）。
4. prior：`chat_thread_role==='qa'` → `getPriorQaVerdictEventForPhaseQa`；否则 → `getPriorQaVerdictEventForAutoQa(execution_id)`。
5. `evaluateQaCriteriaSubmission({family:'qa_verdict', status, criteria, loadPrior, loadChain: loadQaVerdictEventByRef})`；拒 → `qaCriteriaRejectionHttpStatus` + `{ok:false, reason, detail, hint}`，**return，不 insertEvent**。
6. 通过 → 现有流程不变（`insertEvent` 落库的 payload 就含 `qa_criteria`）。

### 5.4 Lead 可见

- auto-QA FAIL `postThread`（`auto-qa-coordinator.ts:1322`）与三阶段对应通知：summary 前加一行 `判据: pass N · fail N · not_run N · carried N · merged N`（从 event payload 算，无清单不输出）。
- `phase-orchestrator.ts` 不把清单存进 `three_stage_verdict` intent。

## 6. 注入（新文件 `packages/teamlead/src/qa-criteria-context.ts`）

**唯一入口** `resolveQaCriteriaContext(store, input) → { qaBlock?: string; fixerBlock?: string } | undefined`，input 三选一：`{kind:'claim', runId, nodeId, attempt}` / `{kind:'phase-events', issueId, projectName}` / `{kind:'auto-qa', qaExecutionId}`；内部用 §5.1 查询得到 `prior`；无 prior → `undefined`（合法首轮）。store 抛错向上抛：wake 出口返回 `{ok:false, error:'qa_criteria_context_unavailable'}` 走现有 fail-loud/重试；spawn 出口按现有 dispatch 失败路径。

**qaBlock 渲染（纯函数 `renderQaReverificationBlock(prior)`）：**

```
## QA re-verification context (qa-criteria/v1, FLY-3055)
Previous QA verdict: <ref> = <pass|fail> on head <sha>[; revoked: <reasons>].
Scope: run `git diff <sha>..HEAD`. Re-test only criteria that diff touches plus every criterion marked fail, not_run or MUST-REVERIFY below. Do NOT re-run untouched passes: submit them as {"status":"carried","claim":"<ref>","evidence":"..."}. carried may cite ONLY <ref>. Every non-merged id below must appear in your new --criteria-file. You may add ids, or retire an id with {"status":"merged","into":"<id>"}: a previously passed id may merge into any target; a fail/not_run id may merge only into a target that is fail/not_run this round.
- AC1 [pass] <title ≤120> — <evidence ≤80>
- AC2 [fail] <title ≤120> — <evidence ≤80>
- AC3 [not_run] <title ≤120> — reason: <reason ≤80>
- AC4 [pass, MUST-REVERIFY] <title ≤120>
MUST-REVERIFY = the carry chain behind that previous pass is revoked/broken: re-test it; it cannot be carried.
```

prior 无清单 → head + summary(≤600) + 「上一轮没有判据清单：本轮从 issue 验收项建立完整清单」。预算：清单块 ≤10,100 UTF-16 units（超出先丢 evidence/reason，永不丢 id）；全部 id/status/ref 必出现。

**fixerBlock（`renderQaFixerBlock(prior)`）**：只在 prior 为 FAIL 时渲染：头 + 「Fix every criterion below. For each, also fix and add tests for the same logic's adjacent state paths (queued / started / dead / superseded / retried / concurrent, as applicable), not only the reported scenario, and list the adjacent paths you covered in your completion summary. The next QA round re-verifies only what your diff touches.」+ 上一轮 `fail`/`not_run` 条目行。

**规则块 `QA_CRITERIA_RULES_V1_QA` / `_FIXER`（≤2,000）**：与 §7 协议文本同义的英文常量，只在 wake 出口（O1/O2/O4/O5）附带——已存活的旧 body 系统层无法更新，规则只能随消息到；新起出口不附带（系统层已含）。§9 静态检查锁两者关键短语一致。

**七个出口：**

| 出口 | 改法 |
|---|---|
| O1 `retestWakeQa` | `content += "\n\n" + rulesQa + "\n\n" + qaBlock`（input `auto-qa`） |
| O2 `feedbackWakeMain` | `feedbackText` 末尾 + rulesFixer + fixerBlock（input `auto-qa`，qaExec 取 `getAutoQaRecord(parent, head).qa_execution_id`） |
| O3 `spawnQa` → `startDispatcher.start({qaContext})` | `QaContext.qaCriteriaBlock = qaBlock`；Blueprint `buildQaModeSystemPromptLines` 在 Steps 前插入该块（无则不插） |
| O4 `wakePhaseRunner kind=retest` | `content += rulesQa + qaBlock`（input：QA 会话有 `getWorkflowExecutionBinding` → `claim`；否则 `phase-events`） |
| O5 `wakePhaseRunner kind=fix` | `content += rulesFixer + fixerBlock`（input `phase-events` by issue） |
| O6 `phaseFixContext` 新起 | `phaseFixContext.qaCriteriaBlock = fixerBlock`；Blueprint `## QA Fix Round` 块把 `QA summary:` 行后追加该块 |
| O7 `respawnUnenrolledQa` / FLY-1050 respawn / handoff spawn | `RunStartRequest.qaCriteriaBlock`（Bridge-INTERNAL，runs-route 不读）→ `BlueprintContext.qaCriteriaBlock` → 三阶段 QA 段 step 2 后插入（input：有 shadowContext → `claim` by (run of issue, node, attempt)；否则 `phase-events`） |

Blueprint 只新增一个可选 ctx 字段 `qaCriteriaBlock?: string` 与 `QaContext.qaCriteriaBlock?`、`phaseFixContext.qaCriteriaBlock?`；不设时所有 prompt 字节与改动前一致（golden 测试锁）。

## 7. 协议文本（有效 prompt 字节 + role 文件）

### 7.1 Blueprint auto-QA `buildQaModeSystemPromptLines`（`:395-473`）

- Step 2 后插入：`2b. ONE-ROUND VERDICT (qa-criteria/v1, FLY-3055, mandatory): build a criteria list from the issue acceptance items, the plan, and any injected re-verification context BEFORE testing. Test every criterion you can in this round. A blocker on one criterion is recorded as fail and you keep testing the independent criteria — never stop at the first blocker, and never submit FAIL while testable criteria remain untested. Write <criteria.json>: every criterion is pass | fail | not_run (with a concrete reason) | carried (cites the injected previous verdict ref + evidence) | merged; the CLI refuses a verdict whose untested criteria lack a reason.`
- `:449` 命令模板改为 `qa-result --exec-id … --target-exec … --status pass|fail --criteria-file <criteria.json> --summary "<evidence and verdict>"`（去掉 `any blocking issue`）。
- `:461` c. FAIL：`with a specific report (exact scenario …)` → `with the COMPLETE criteria list (every fail has expected-vs-actual + severity in evidence; nothing left untested without a reason)`。
- `:463-464` d. RE-TEST：`re-run your scenarios` → `re-verify per the injected re-verification context: only what the fix touched plus previous fail/not_run criteria; carry untouched passes (status carried, claim = the injected ref). Small-fix real-room exemption: when the core behavior was already proven live on the previous verified head, this round's diff only fixes a small bug, the fix is covered by a unit or e2e test, and exact-head CI is green, do not rerun the live room — carry that criterion and name the new test + CI run in its evidence and in your report. Not for a first round or a diff that changes the core behavior.`
- codex 变体同义改写（不承诺 park/wake，与 FLY-1188 一致）。

### 7.2 Blueprint 三阶段 QA 段（`:1149-1190`）

- Step 2 后插入同 7.1 的 ONE-ROUND VERDICT 句。
- `:1162/:1171-1173/:1187-1188` 四处命令模板加 `--criteria-file <criteria.json>`；5-fb kickback 附注 `(its <criteria.json> holds {"id":"founder-feedback","status":"fail","evidence":"<requested changes>"} plus every id of your previous list, carried where untouched)`。
- `:1171-1172` `re-run your scenarios directly` → 同 7.1 d 的复验句。

### 7.3 Blueprint 三阶段 implement `## QA Fix Round`（`:1140-1147`）

`QA summary:` 行后追加固定句：`QA FIX ROUNDS (qa-criteria/v1, FLY-3055): when fixing a QA-reported failure, fix and test the same logic's adjacent state paths too (queued / started / dead / superseded / retried / concurrent, as applicable), not only the reported scenario. Your completion summary lists the adjacent paths you added tests for; the next QA round re-verifies only what your diff touches.` 再追加 `ctx.phaseFixContext.qaCriteriaBlock`（有则）。

### 7.4 `.flywheel/agents/engineering/qa-executor.md`

- Work loop 3 后加 **3b. 一轮测全**（中文 + 关键英文短语 `never stop at the first blocker`、`qa-criteria/v1`、`Small-fix real-room exemption`）。
- Work loop 4：`On FAIL, hand specifics to the dev Runner and re-verify after the fix.` → `On FAIL, hand the COMPLETE criteria list to the dev Runner; re-verify only the changed parts per the injected re-verification context (carry untouched passes).`
- Reporting 段：`qa-result --status pass|fail --target-exec <parent>` → 加 `--criteria-file <criteria.json>`。

### 7.5 `.flywheel/agents/engineering/engineer-executor.md`

Work loop 加 **2b. QA fix rounds（`qa-criteria/v1`, FLY-3055）**：相邻状态路径一并补测试（含英文短语 `adjacent state paths`），交卷说明列出。

## 8. 测试（红→绿；遵守 local-test-policy：逐文件运行，不跑全套）

| 文件 | 覆盖 |
|---|---|
| `packages/config/src/__tests__/qa-criteria.test.ts`（新） | 形状矩阵（每字段缺/多/超长/控制字符/重复 id/占位 reason/merged 自指或指向 merged/不存在）；容量边界（30+2 合并+1 新增合法；31 拒）；判决真值表；规范化字节稳定；`workflowDecisionEvidence` 无清单时与旧字节一致；`claim` 数字与字符串都规范为字符串；引用规则全 cause；三轮反例 A(AC1 pass) → B(AC1 fail) → C carried(A.AC1) 拒 `not_latest_prior`；三代链合法；撤销白名单内可 carry、外拒；merged 反例（fail 并进 pass 目标拒）；满额未通过合并合法；`loadQaCriteriaFile` 非 UTF-8 / 超 64KB / 非文件 拒 |
| `packages/flywheel-comm/src/commands/__tests__/qa-result.test.ts` | 坏清单 → exit 1、`fetch` 零调用、零 marker；合法 → 两种 body 都带规范化 `qa_criteria`；服务端 `qa_criteria_prior_uncovered` → 不重试、无 marker、stderr 含 missing ids；服务端 503 仍 4 次重试 + marker（回归） |
| `packages/flywheel-comm/src/__tests__/qa-result-criteria-cli.test.ts`（新） | 真 dist 入口 `node dist/index.js qa-result --status fail … --criteria-file bad.json`（含缺 reason 的 not_run）→ exit 1、中英文指引、无网络（BRIDGE_URL 指向不存在端口且断言未尝试连接）；正控：合法文件 + mock Bridge → 200 |
| `packages/config` `vitest related src/qa-criteria.ts src/index.ts` | 导出面 |
| `packages/teamlead/src/__tests__/StateStore.qa-criteria.test.ts`（新） | 三条 prior 查询（P1 含撤销、排除他节点/≥当前 attempt；P2 排除当前事件、只看 qa 阶段会话；P3 沿 record.verdict_event_id）；事务内复核拒 → credential 未消费、零 claim；通过 → evidence 规范形；已消费精确重放先返回；不同清单同 request id → `replay_payload_mismatch` |
| `packages/teamlead/src/__tests__/workflow-decision-routes.qa-criteria.test.ts`（新）+ 既有 `workflow-decision-routes.test.ts` | QA 缺清单 400；review 家族带清单 400；verdict mismatch 400；carried 各 cause 409；覆盖缺 id 409；首轮 carried 409；合法 → claim evidence + event payload + `onQaResult` 入参都带清单；拒后同 credential 修正重交成功；既有用例 fixture 补 `validQaCriteria()` |
| `packages/teamlead/src/__tests__/event-route-fly3055-qa-criteria.test.ts`（新）+ 既有 fly579/fly859 route 测试 | `/events` qa_result 缺清单 → 400、`insertEvent` 未调、coordinator/orchestrator 未调；carried 引用非紧邻事件 → 409；合法 → 落库 payload 含清单、下游调用不变；非 qa_result 事件字节不变；既有 fixture 补清单 |
| `packages/teamlead/src/__tests__/qa-criteria-context.test.ts`（新） | 三种 input 的 prior 解析；最大合法清单（补充平面字符）块 ≤10,100 且含全部 id；prior 无清单分支；fixer 只列 fail/not_run、prior 为 PASS 不渲染；MUST-REVERIFY 标记；store 抛错向上抛 |
| `auto-qa-effects.test.ts`、`auto-qa-coordinator.test.ts`、`phase-orchestrator.fly887-keepalive.test.ts`、plugin wake 测试 | O1/O2/O4/O5 wake 文本末尾含规则块 + 清单块/fixer 块；无 prior 时字节与改动前一致；入口抛错 → `{ok:false}` 不静默；O3/O6/O7 start 请求带 `qaCriteriaBlock` |
| `Blueprint.fly579-qa-mode.test.ts`、`Blueprint.fly859-qa-phase-prompt.test.ts`、`Blueprint.fly793-phase-prompt.test.ts` | 命令模板含 `--criteria-file`；`never stop at the first blocker`、`Small-fix real-room exemption`、`adjacent state paths` 出现在对应段；`qaCriteriaBlock` 设置时出现在指定位置、未设时 prompt 字节与改动前一致（golden） |
| `scripts/__tests__/test-qa-criteria-protocol-contract.sh`（新，接 CI） | grep：`qa-executor.md` 含 `qa-criteria/v1` + `never stop at the first blocker` + `Small-fix real-room exemption`、不含 `hand specifics to the dev Runner and re-verify after the fix`；`engineer-executor.md` 含 `adjacent state paths`；Blueprint 两段 QA 与 fix 块含同短语；`QA_CRITERIA_RULES_V1_*` 常量与 role 文件共享关键短语一致（静态互斥检查） |

负控（删接线即红）：event-route 拒收分支、事务内复核、O1/O4 注入拼接。

## 9. 验收（对应 issue）

1. **CLI 拒收**：受影响包 build 后真入口跑 `qa-result --status fail --target-exec x --exec-id y --criteria-file bad.json`（含无 reason 的 not_run）→ exit 1、指引「先把剩下的判据测完或写明为什么没测」、无 marker、无网络（单测 + 真 CLI 记录输出为证据）。
2. **复验开局看到上一轮清单**：529 房（本沙箱 legacy auto-QA 路径）跑一次真 QA 复验：第一轮 FAIL 带清单 → 实现体 push → `retest_wake` 文本含 `Previous QA verdict: <ref>` 与 `[pass]` 项；第二轮用 `carried` 引用该 ref 被接受（截 wake 文本、清单文件、Bridge 日志、Lead 通知 `判据:` 行）。三阶段路径用单测 + route 测试证明同规则。
3. **协议 grep**：`grep -n "qa-criteria/v1\|never stop at the first blocker\|Small-fix real-room exemption" .flywheel/agents/engineering/qa-executor.md packages/edge-worker/src/Blueprint.ts` 命中 role 一处 + Blueprint 两段；`grep -n "adjacent state paths" .flywheel/agents/engineering/engineer-executor.md packages/edge-worker/src/Blueprint.ts` 各一处；`! grep "hand specifics to the dev Runner and re-verify after the fix" qa-executor.md`；`! grep "any blocking issue" Blueprint.ts`。
4. `pnpm lint`、`pnpm --filter "flywheel-config..." build` 等受影响包 build；exact-head PR CI 全绿为全量证据。

## 10. 上线、兼容、回滚

- 生效：merge + 生产 `git pull` + Bridge 重启（校验与注入在 Bridge；prompt 在 spawn 时现读）。部署前已在跑的 QA body：下一次 wake 附带规则块；它若先交 verdict 会被 `qa_criteria_required` 拒并得到最小示例——刻意立即生效，PR 描述写明，Lead 知悉。
- 上线前的 verdict 无清单：覆盖跳过，注入只渲染 summary。
- 回滚 = revert PR。已写入的 `{summary, qa_criteria}` claim/event 保留；旧代码只读 `summary`；跨部署边界的同 request id 重放判 `replay_payload_mismatch`（仅影响丢响应重试）。
- 不设 feature flag。

## 11. Chunks

| chunk | 内容 | 依赖 |
|---|---|---|
| C1 | `flywheel-config` `qa-criteria.ts` + 测试 + 导出 | — |
| C2 | CLI `--criteria-file` 预检、body、拒收分类、计数行 + 单测 + 真入口测试 | C1 |
| C3 | StateStore 三条 prior 查询 + 事务内复核 + decision route 前置 + event-route 前置 + Lead 计数行 + 既有 fixture 补清单 | C1 |
| C4 | `qa-criteria-context.ts` 入口 + 渲染 + 规则块常量 + 七个出口 + Blueprint 三个可选字段 | C3 |
| C5 | 协议文本（Blueprint 三段 + 两个 role 文件）+ golden/prompt 测试 + shell 合同测试接 CI | C2 |

## 12. 风险

- R-a：`/events` 拒收会让部署前已在跑的 QA 首次交卷失败一次——刻意；hint 自带示例。
- R-b：P2 prior 按 issue 下 qa 阶段会话事件序取「最近一条」；若同 issue 曾有被 supersede 的旧 run 的 QA 事件，也会被当 prior——覆盖规则只要求「id 出现」，不阻塞；注入块会标 head，QA 按 diff 判断。可接受，写进 R6 边界。
- R-c：wake 文本变长（≤ 2,000 + 10,100）；邮箱无硬上限，Claude 消息层级可承受。

## 13. 修订轨迹

- v1 2026-09-29 初稿。
