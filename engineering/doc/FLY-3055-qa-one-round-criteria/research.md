# FLY-3055 QA 一轮测全 + 判据清单 — 调研
Issue: FLY-3055 (https://linear.app/geoforge3d/issue/FLY-3055/机制qa-一轮测全问题一次列全再判复验只验改动部分实现体修问题要补相邻路径-写进协议-qa-result-判据清单强制校验founder)
日期: 2026-09-29
基于: exploration.md

调研只回答 exploration §3 的六个问题，每条结论指向本仓库的具体行号。

## R1. 下一轮 QA / 修复到底怎么起跑 —— 注入必须覆盖七个出口

| # | 循环 | 出口 | 代码 | 目标角色 | 现有可用上下文 |
|---|---|---|---|---|---|
| O1 | auto-QA | `retestWakeQa` | `auto-qa-effects.ts:629` | qa | `qaSession`, `parentSession`, `newSha` |
| O2 | auto-QA | `feedbackWakeMain` | `auto-qa-effects.ts:403` | fixer | `session`(parent), `summary` |
| O3 | auto-QA | 死 QA 重起 `spawnQa` | `auto-qa-coordinator.ts:1022` → `startDispatcher.start({qaContext})` `:1077` | qa | `parent`, `sha`, `AutoQaRecord` |
| O4 | 三阶段 keep-alive | `wakePhaseRunner kind=retest` | `plugin.ts:6813`（调用点 `phase-orchestrator.ts:1698`） | qa | `session`(QA), `headSha` |
| O5 | 三阶段 keep-alive | `wakePhaseRunner kind=fix` | 同上（调用点 `:1453`） | fixer | `session`(implement), `round`, `qaSummary` |
| O6 | 三阶段 keep-alive OFF | Implement-fix 新起 | `phase-orchestrator.ts:1316` `phaseFixContext{round,qaSummary}` → Blueprint `:1140` | fixer | `intent().summary` |
| O7 | 三阶段 | QA 重起 | `phase-orchestrator.ts:553` `respawnUnenrolledQa`、`:1515`/`:1792`（FLY-1050 respawn / handoff spawn） | qa | `session`, `shadowContext{node:"qa", attempt}` |

O1/O4 是 wake 文本（已存活进程，只能走消息）；O2/O5 也是 wake；O3/O6/O7 是新起（prompt 可进 Blueprint）。七个出口分属三个文件、两个 effects 层，**必须由一个纯函数产出文本**，出口只做拼接，否则口径漂移（上游同样结论：R1「注入点必须覆盖三条路」）。

wake 通道上限：`wakeRunnerMailbox` 无显式 content 长度限制（`runner-wake.ts` 无 MAX_CONTENT），但 Claude 邮箱消息是 prompt 层级，清单块必须有界（见 R5 预算）。

## R2. 上一轮 verdict 怎么读 —— 三条路径三个落点，一个解析函数

| 路径 | 判定依据 | prior 落点 | 引用 token（注入给 QA、`carried.claim` 必须等于它） |
|---|---|---|---|
| P1 credential（三阶段 + claims write ON） | `getWorkflowSubmissionCredentialByToken` 命中 → `run_id/node_id/attempt` | `workflow_claims`（`decision_kind='qa_verdict'`，同 run+node，`attempt < 当前`，`ORDER BY attempt DESC, server_seq DESC LIMIT 1`；撤销原因另查 `workflow_claim_revocation`） | `String(claim.id)` |
| P2 三阶段 `/events`（claims write OFF 或 keep-alive OFF 重起 QA） | reporting `session_role='qa' && chat_thread_role='qa'` | `session_events`：issue 下所有 `chat_thread_role='qa'` 阶段会话（`getPhaseSessionsForIssue`, `StateStore.ts:3425`）的 `qa_result` 事件，排除当前 event_id，按 `id DESC` 取一条 | 该事件的 `event_id` |
| P3 auto-QA `/events` | 其余（`AutoQaCoordinator`） | `getAutoQaRecordByQaExec(qaExec)`（`:5040`）→ `verdict_event_id`（每次 verdict `COALESCE` 更新，`:4296`；record 跨 head retarget 时 PK 原地改 `:5276`，所以历史沿 record 走）→ `SELECT payload FROM session_events WHERE event_id=?`（`:3511` 已有同形查询） | 该事件的 `event_id` |

三条都产出同一形状 `PriorQaVerdict {ref, source:'claim'|'event', status, headSha, summary?, criteria: QaCriteriaV1|null, revocationReasons: string[]}`（P2/P3 无撤销，空数组）。这就是 `resolvePriorQaVerdict(store, input)`，供校验（R4）与注入（R1）共用。

`carried` 引用只认「紧邻上一轮」：P1 按 attempt；P2/P3 按事件序。链式沿用（A pass → B carried(A) → C carried(B)）在 P1 走整链撤销复核（同上游 `qaCriterionCarryChain`）；P2/P3 无撤销概念，链只查「每跳都存在且状态 pass/carried、每跳事件更早」。

P3 细节：`auto_qa_record` 一条 record 一个 parent；`verdict_event_id` 在 PASS 后 record 终态、QA 被关，不再有下一轮，所以 prior 只会在 `awaiting_retest`→ retest 时被读，落点稳定。

## R3. verdict payload 形状变更的连带点（必须同批改）

| 点 | 现状 | 改法 |
|---|---|---|
| CLI body（credential） | `WorkflowQaDecisionBody{credential, client_request_id, status, client_pr_head_sha?, summary?}` `qa-result.ts:62` | + `qa_criteria?: QaCriteriaV1`（规范形） |
| CLI body（events） | `QaResultBody.payload{status,targetExecutionId,qaExecutionId,prHeadSha?,summary?}` `:45` | + `qa_criteria?` |
| 失败 marker | `buildQaResultFailureMarker` 只存 digest（`:262`） | 不变（digest 自动覆盖清单） |
| decision route | `evidence: summary ? {summary} : undefined` `workflow-decision-routes.ts:237`；event payload `:260`；`onQaResult` 入参 `:272` | 三处改用唯一函数 `workflowDecisionEvidence(summary, criteria)`；无清单时字节与旧一致 |
| `submitWorkflowDecisionByCredential` | `evidence?: unknown`，事务内无家族校验 `StateStore.ts:10481` | + `qaCriteria?`、`enforceQaCriteria?`：事务内、写 claim 前复核（判决规则 + 引用规则）；拒 → 事务回滚、credential 不消费 |
| `canonicalSubmissionDigest` | 含 `evidence` | 自动含清单；同 request id 不同清单 → 现有 `replay_payload_mismatch` 路径 |
| PhaseOrchestrator intent | `ThreeStageVerdictIntent{status,event_id,summary,...}` `phase-orchestrator.ts:110` | 不存清单（清单从 event 读，避免 session_params 膨胀）；O6 的 `phaseFixContext` 增 `qaCriteriaBlock?: string` |
| auto-QA Lead 通知 | `postThread` 600 字 summary `auto-qa-coordinator.ts:1322` | 前置一行 `判据: pass N · fail N · not_run N · carried N · merged N` |
| Blueprint `QaContext` | `Blueprint.ts:375` | + `qaCriteriaBlock?: string`（O3 注入） |
| `RunStartRequest`（retry-dispatcher） | `qaContext`、`phaseFixContext` `:189/:236` | + `qaCriteriaBlock?`（O7；Bridge-INTERNAL，runs-route 不读） |

## R4. 谁在调用 qa-result（必须同批适配）

有效 prompt 里的四处命令模板（都要加 `--criteria-file <criteria.json>`）：

- `Blueprint.ts:449` auto-QA `a. Report your verdict STRUCTURALLY`。
- `:1162` 三阶段 PASS、`:1171-1173` 三阶段 FAIL（三种分支）、`:1187-1188` 5-fb kickback（kickback 清单：`{id:"founder-feedback",status:"fail",evidence:<requested changes>}` + 上一轮全部 id 覆盖）。
- 断言这些字节的测试：`Blueprint.fly579-qa-mode.test.ts:126-136`、`Blueprint.fly859-qa-phase-prompt.test.ts:150-203`、`Blueprint.fly793-phase-prompt.test.ts`。
- 服务端测试里提交 `qa_result` 的 fixtures：`workflow-decision-routes.test.ts`（`status/summary` body）、`event-route-fly579-auto-qa.test.ts`、`event-route-fly859-three-stage-qa.test.ts`、`auto-qa-coordinator.test.ts`、`phase-orchestrator.fly887-keepalive.test.ts` 等 —— 强制后这些 fixture 都要带合法清单（共享 helper `validQaCriteria()`）。
- 529 房驱动脚本：`scripts/qa-fly939-real-discord-wake-not-respawn-e2e.mjs`、`packages/qa-framework/suites/*` 中凡发 `qa-result` 的 stub（grep `qa-result` 命中列表见 exploration §2.2 审计）。

## R5. 校验放哪、预算多大

**三层，同一规则：**

1. CLI 预检（`flywheel-comm index.ts runQaResult`，`:928`）：读文件（≤64KB、严格 UTF-8）→ `parseQaCriteria` → `validateQaCriteriaVerdict(status)`；失败 stderr 中英文指引 + exit 1，**零 HTTP、零 marker**。规则在 `packages/config/src/qa-criteria.ts`（`flywheel-config`），与 `review-family.ts` 同「shared rule + CLI mirror」模式。
2. Bridge 前置：
   - `/api/workflow/decision`：现有 400 校验之后、`resolveWorkflowHeadAuthority` 之前解析清单；`getWorkflowSubmissionCredentialByToken` 之后按 P1 取 prior 做引用规则；家族不是 `qa_verdict` 却带清单 → 400 `qa_criteria_not_applicable`；QA 缺清单 → 400 `qa_criteria_required`。
   - `/events`：`event-route.ts` 头部 `account_rotation` 同位置加 `qa_result` 分支：解析清单 + 判决规则 + 按 P2/P3 取 prior 做引用规则；拒 → 400/409，**不 `insertEvent`**（现在 `/events` 对 qa_result 无任何校验就落库）。
3. P1 事务内复核：`submitWorkflowDecisionByCredential` 内再算一次（防 await 期间账本变化）。P2/P3 落库是单条 `insertEvent`，路由层校验与写入之间无 await（event-route 是同步顺序），不需要第二次。

**预算：** 清单 JSON ≤64KB；非 merged 条目 1..30、merged ≤30；`title` ≤120、`evidence/reason` ≤200、`id` ≤48（全部 UTF-16 code unit）。注入块：每行 ≤ 48+40+120+80+16 ≈ 304，30 行 ≤ 9,120，头部 ≤ 900 → 清单块 ≤ 10,100；超出时先丢 evidence 再也不丢 id。规则块（给部署前已存活的旧 body 用）≤ 2,000。

**拒收 reason（HTTP）：** `qa_criteria_invalid | qa_criteria_required | qa_criteria_not_applicable | qa_criteria_verdict_mismatch` → 400；`qa_criteria_carried_invalid | qa_criteria_merge_invalid | qa_criteria_prior_uncovered` → 409。CLI 对这组 reason **不重试**（`qa-result.ts` 现有 4 次退避重试只对网络/5xx 有意义）并清除本次 marker——服务端在写库前拒收，重试无意义。

## R6. 规矩能防什么、不能防什么（诚实边界）

| 能机械防 | 不能机械防 |
|---|---|
| FAIL 时有判据既没测也没写原因（CLI + Bridge 双拒） | QA 把判据列得太粗（一条「全部功能」） |
| `carried` 没引用紧邻上一轮 / 引用的项上一轮不是 pass | QA 把被 diff 触及的项标 carried（Bridge 不看 diff；注入块给出 `git diff <prev>..HEAD` 指令，靠 QA 判断） |
| 上一轮 id 本轮丢失（覆盖规则） | `not_run` 原因是真话还是搪塞（只能拒占位词） |
| 首轮出现 carried / merged | 实现体是否真的补了相邻路径（协议要求交卷说明列出，QA 复验时按 diff 核） |
| review 类 verdict 混带清单 | — |

已存活的旧 QA body 只能靠 wake 消息拿到新规则块；它第一次交 verdict 会被 `qa_criteria_required` 拒并得到最小示例——刻意的立即生效。

## R7. 工具与测试基线（本机可用性）

- `mmdc` 在 `/opt/homebrew/bin/mmdc`（HTML 图用）。
- Codex：`codex-with-fallback`、`codex-profile` 在 PATH；`codex-companion` 不在 PATH（设计评审用 `codex-design-review` 技能的现有流程）。
- 测试运行遵守 local-test-policy：逐文件 `pnpm --filter <pkg> exec vitest run <file>`；包名 `flywheel-config` / `flywheel-comm` / `flywheel-teamlead` / `flywheel-edge-worker`。
