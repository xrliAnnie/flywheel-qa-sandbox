# FLY-3055 QA 一轮测全 + 判据清单强制校验 — 调研

Issue: FLY-3055 (https://linear.app/geoforge3d/issue/FLY-3055/机制qa-一轮测全问题一次列全再判复验只验改动部分实现体修问题要补相邻路径-写进协议-qa-result-判据清单强制校验founder)
日期: 2026-09-29
基于: exploration.md

## 1. 参考实现：真仓 `qa-criteria/v1`（对齐目标）

QA 房 Bridge 来自真仓 `flywheel-FLY-3055` 分支（v1.57.0）。下面是必须字节对齐的部分（来源：`packages/config/src/qa-criteria.ts`、plan.md v4.1）。

### 1.1 Schema

```json
{
  "version": 1,
  "items": [
    { "id": "A1", "title": "FAIL 缺 reason 被 CLI 拒收", "status": "pass", "evidence": "qa-result exit 1, stderr 含 refused locally" },
    { "id": "A2", "title": "carried 缺 claim 被拒", "status": "fail", "evidence": "期望 exit 1 实际 exit 0" },
    { "id": "B1", "title": "529 房复验注入", "status": "not_run", "reason": "529 房 host slot 被 FLY-3043 占用到 14:00" },
    { "id": "C1", "title": "协议文字 grep 核对", "status": "carried", "claim": 41, "evidence": "claim 41 evidence C1 pass; 本轮 diff 未碰 md" },
    { "id": "old-B2", "status": "merged", "into": "B1" }
  ]
}
```

| 规则 | 取值 |
|---|---|
| 顶层键 | 只允许 `version`（必须是 `1`）和 `items`；未知键拒收 |
| 文件 | ≤ 65536 字节；严格 UTF-8 |
| 条目键 | 只允许 `id / title / status / evidence / reason / claim / into` |
| `id` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$`，清单内唯一 |
| 数量 | 非 merged 1..30；merged 0..30；总数 ≤ 60 |
| `status` | `pass \| fail \| not_run \| carried \| merged` |
| `title` | 去空白后 1..120（UTF-16 code unit） |
| `evidence` / `reason` | ≤ 200 |
| 文本 | 拒 C0 控制字符（`\t` 除外）、U+2028/2029、孤立代理项 |

各状态字段义务：

| status | 必填 | 可选 | 禁止 |
|---|---|---|---|
| `pass` | `title` | `evidence` | `reason` `claim` `into` |
| `fail` | `title` `evidence` | 无 | `reason` `claim` `into` |
| `not_run` | `title` `reason`（非占位词） | 无 | `evidence` `claim` `into` |
| `carried` | `title` `evidence` `claim`（正整数） | 无 | `reason` `into` |
| `merged` | `into`（指向本清单另一条非 merged，不能自指） | `title` | `evidence` `reason` `claim` |

`reason` 占位词（不区分大小写）：`n/a na none skip skipped todo tbd - 无 略`。

verdict 一致性（只看非 merged 条目）：FAIL 需 ≥ 1 条 `fail`；PASS 需 0 条 `fail` 且 ≥ 1 条 `pass` 或 `carried`。

### 1.2 拒收 reason 与 HTTP 状态

| reason | HTTP | detail |
|---|---|---|
| `qa_criteria_invalid` | 400 | `{index?, id?, field, message}` |
| `qa_criteria_required` | 400 | 有 credential 的 QA verdict 没带清单 |
| `qa_criteria_not_applicable` | 400 | 非 `qa_verdict` 家族带了清单 |
| `qa_criteria_verdict_mismatch` | 400 | status 与清单不一致 |
| `qa_criteria_carried_invalid` | 409 | cause ∈ `no_prior \| not_latest_prior \| criterion_missing \| criterion_not_passed \| chain_revoked_incompatible \| chain_broken` |
| `qa_criteria_merge_invalid` | 409 | cause ∈ `not_in_prior \| unresolved_into_passing_target \| chain_revoked_incompatible` |
| `qa_criteria_prior_uncovered` | 409 | `{priorClaimId, missing:[...]}` |

carried 兼容的撤销原因白名单 `QA_CARRY_COMPATIBLE_REVOCATION_REASONS`：`materialized_head_superseded`、`operator_rework_superseded`、`founder_feedback_before_land_departure`、`engine_land_conflict_rework`、`engine_land_merge_ticket_reapproval`。

### 1.3 CLI 文案（对齐）

- 本地拒收：`[qa-result] refused locally: no request was sent and no marker was written.`
- 拒收首行：`[qa-result] criteria refused: <reason>`，固定跟一行 `  先把剩下的判据测完或写明为什么没测 (finish the remaining criteria, or state why each was not tested).`
- 服务端拒收：`[qa-result] REFUSED before the credential was consumed; no marker kept. Fix --criteria-file and rerun the same command.`
- 成功：`[qa-result] criteria pass=N fail=N not_run=N carried=N merged=N`

### 1.4 注入块（对齐标记）

- 清单块标题：`## QA re-verification context (qa-criteria/v1, FLY-3055)`，含 `Previous QA verdict: claim <id> = qa_passed|qa_failed` 与固定长度的 `MUST-REVERIFY` 标记；预算 ≤ 10100 字符，超预算先丢 evidence 绝不丢 id。
- 规则块标题：`## Platform rule update (qa-criteria/v1)`，只在角色文件不含 `qa-criteria/v1` 标记时注入（旧 snapshot 兜底），≤ 2000 字符。
- Blueprint QA 命令行在 `qa_verdict` 家族时追加 ` --criteria-file <criteria.json>`。

529 桩用正则 `/Previous QA verdict: claim (\d+) = /` 从唤醒文本里取上一轮 claim id —— 这行文本是**跨仓契约**，本仓必须逐字输出。

## 2. 本仓落点（v1.55.0）

### 2.1 共享规则模块（新建）

`packages/config/src/qa-criteria.ts`，从 `packages/config/src/index.ts` 导出。纯函数、零 I/O（`loadQaCriteriaFile` 除外，它只做读文件 + 大小/UTF-8 检查再交给 `parseQaCriteria`）。

导出面（与真仓同名，方便以后两仓合流）：

| 导出 | 职责 |
|---|---|
| `QA_CRITERIA_SCHEMA = "qa-criteria/v1"` | schema 名 |
| `QA_CRITERIA_MAX_FILE_BYTES / _TITLE_MAX / _TEXT_MAX / _ID_MAX / _MAX_ACTIVE_ITEMS / _MAX_MERGED_ITEMS / _MAX_TOTAL_ITEMS` | 上限常量 |
| `QA_CRITERIA_REJECTION_REASONS` | reason 集合 |
| `QA_CARRY_COMPATIBLE_REVOCATION_REASONS` | 撤销白名单 |
| `parseQaCriteria(raw)` | 形状校验 → `{ok, criteria} \| {ok:false, rejection}` |
| `validateQaCriteriaVerdict(criteria, status)` | verdict 一致性 |
| `qaCriteriaCounts(criteria)` | 五种状态计数 |
| `workflowDecisionEvidence({summary, criteria})` | 生成 `evidence` JSON |
| `qaCriteriaFromEvidence(evidence)` | 反向读取（容忍旧 `{summary}` 形态） |
| `checkQaCriteriaAgainstPrior({criteria, prior, loadChainClaim})` | carried / merged / prior_uncovered 三类账本检查 |
| `evaluateQaCriteriaSubmission(input)` | 上面几步的编排；CLI 传不进账本时跳过账本检查 |
| `formatQaCriteriaRejection(rejection)` | 人类可读文案 |
| `qaCriteriaRejectionHttpStatus(reason)` | 400/409 |
| `loadQaCriteriaFile(path, status)` | CLI 用 |
| `QA_CRITERIA_MINIMAL_EXAMPLE` | 拒收提示里附的最小样例 |

### 2.2 CLI：`packages/flywheel-comm`

| 文件 | 改动 |
|---|---|
| `src/index.ts:95` help | 加一行 `--criteria-file <json> (qa-criteria/v1, FLY-3055): one complete list; pass\|fail\|not_run(+reason)\|carried(+claim)\|merged; refused locally first` |
| `src/index.ts:930` `runQaResult` | `parseArgs` 加 `"criteria-file": { type: "string" }`；调用 `loadQaCriteriaFile` **在** `qaResult()` 之前；失败 → 打印 `formatQaCriteriaRejection` + `refused locally` 行、`process.exitCode = 1`、return |
| `src/commands/qa-result.ts` | `QaResultOpts.criteria?: QaCriteria`；`WorkflowQaDecisionBody.qa_criteria?`；credential 通道把 `qa_criteria` 放进 body；legacy 通道把 `qa_criteria` 放进 `payload`；成功后打印 counts 行；服务端返回 `QA_CRITERIA_REJECTION_REASONS` 内的 reason 时**不重试、不写 marker**，打印 `REFUSED before the credential was consumed` 并 exit 1 |

现状 `qaResult()` 对任何非 2xx 都重试 4 次再写 marker（`qa-result.ts:161-205`）。判据类拒收是确定性的，重试无意义，写 marker 更会让后续 replay 卡在同一份错清单上，所以要在重试循环里识别 `response.status ∈ {400, 409}` 且 body.reason 在判据 reason 集合内，直接短路。

### 2.3 Bridge 路由：`packages/teamlead/src/bridge/workflow-decision-routes.ts`

`/decision`（137 行起）新增：

1. `WorkflowDecisionBody.qa_criteria?: unknown`。
2. 解析：`body.qa_criteria` 存在 → `parseQaCriteria`；失败 400 `qa_criteria_invalid`。
3. 家族判定：credential 行 `family === "qa_verdict"`（`workflow_submission_credential.family`）且缺清单 → 400 `qa_criteria_required`；非 `qa_verdict` 带清单 → 400 `qa_criteria_not_applicable`。
4. `validateQaCriteriaVerdict` 不一致 → 400 `qa_criteria_verdict_mismatch`。
5. 账本预检（路由层，事务外，为了早拒）：`store.getLatestPriorWorkflowQaVerdictClaim({runId, nodeId:"qa", beforeAttempt: credentialRow.attempt})` + `store.loadQaCriteriaChainClaim(id)` 传给 `checkQaCriteriaAgainstPrior`；拒收 → 409。
6. 通过后 `evidence: workflowDecisionEvidence({summary, criteria})` 传给 `submitWorkflowDecisionByCredential`，并加 `enforceQaCriteria: true`。
7. 响应里回 `criteriaCounts`。
8. `insertEvent` 的 payload 加 `criteriaCounts`（不放全清单，session_events 是审计流不是账本）。

### 2.4 Bridge 事务：`packages/teamlead/src/StateStore.ts`

`submitWorkflowDecisionByCredential`（约 10290 行起）新增入参 `enforceQaCriteria?: boolean; qaCriteria?: QaCriteria`：

- 在 `binding_not_current` 检查之后、插 claim 之前，`enforceQaCriteria && family === "qa_verdict"` 时在**同一事务内**再跑一次 `evaluateQaCriteriaSubmission`（含账本检查）；拒收 → `result = { ok:false, reason, detail }` 并 return（事务回滚，credential 未消费）。
- 新增查询：
  - `getLatestPriorWorkflowQaVerdictClaim({runId, nodeId, beforeAttempt})`：`SELECT * FROM workflow_claims WHERE workflow_run_id=? AND decision_kind='qa_verdict' AND node_id=? AND attempt < ? ORDER BY attempt DESC, server_seq DESC LIMIT 1`。**不过滤撤销**，撤销兼容性由 `checkQaCriteriaAgainstPrior` 判。
  - `loadQaCriteriaChainClaim(claimId)`：claim 行 + 其撤销原因列表，供 carried 链回溯。
- `WorkflowCredentialSubmissionResult` 联合类型加 `detail?` 字段。

为什么路由层和事务层各跑一次：路由层拒收快、错误信息全；事务层是权威（防路由层被绕过、防两次请求之间账本变化）。规则同一份函数，不会漂移。

### 2.5 上一轮清单注入

新建 `packages/teamlead/src/workflow-qa-criteria-context.ts`：

```ts
resolveQaCriteriaPromptSection(store, { executionId, role: "qa" | "fixer" })
  → { criteriaBlock?: string; priorClaimId?: number; counts?: QaCriteriaCounts }
```

- 通过 `store.getWorkflowRunNodeForExecution(executionId)` 找 `run_id / attempt`；`role="qa"` 取 `beforeAttempt = attempt` 的最近 claim；`role="fixer"` 取 QA 节点最新 claim 且 `predicate === "qa_failed"` 才注入。
- 无 workflow 投影（legacy 单会话）→ 返回空，出口按原文案走（字节兼容）。
- 渲染：标题行、`Previous QA verdict: claim <id> = <predicate>`、然后每条 `- <id> [<status>] <title> — <evidence|reason>`，`fail`/`not_run` 条目前缀 `MUST-REVERIFY`，`pass` 条目标 `carry-eligible (cite claim <id>)`。预算 10100 字符：先丢 evidence，再丢 title，绝不丢 id。

五个出口：

| 出口 | 文件:行 | 改动 |
|---|---|---|
| 三段式 fix 起新 implement | `phase-orchestrator.ts:1529` | `phaseFixContext` 加 `qaCriteriaBlock?: string`；Blueprint `## QA Fix Round` 段后追加该块与「相邻路径」要求 |
| 三段式 fix 唤醒 parked implement | `plugin.ts:6830` `wakePhaseRunner` kind=fix | 文案末尾追加 criteriaBlock + 相邻路径一句 |
| 三段式 QA 复验唤醒 | `plugin.ts:6831` kind=retest | 文案末尾追加 criteriaBlock（含 `Previous QA verdict: claim N = ...` 行）+ `--criteria-file` 提醒 |
| DAG re-QA 换 attempt | `phase-orchestrator.ts:545` `respawnUnenrolledQa` | `startDispatcher.start` 加 `qaCriteriaContext`，Blueprint QA 提示词追加块 |
| auto-QA 复验唤醒 | `auto-qa-effects.ts:664` `retestWakeQa` | legacy 通道无 claim；只追加「一轮测全 + 只验改动」规则句，不注入清单 |

`resolveQaCriteriaPromptSection` 抛错时：wake 出口返回 `{ok:false, error:"qa_criteria_context_unavailable"}`（held for reconcile，与现有 wake 失败语义一致）；spawn 出口 fail-closed 不起 runner（`failClosed` 路径已存在）。

### 2.6 Blueprint 提示词（`packages/edge-worker/src/Blueprint.ts`）

| 位置 | 改动 |
|---|---|
| `buildQaModeSystemPromptLines` 449 行 verdict 命令 | 追加 `--criteria-file <criteria.json>`；步骤 2 后插「先列判据清单」；c 项改为「记 fail 继续测其余判据，全部测完再判」 |
| 三段式 QA 1150-1173 行 | 步骤 2 加「先建判据清单」；步骤 4/5 的 `qa-result` 命令追加 `--criteria-file`；步骤 5 改为「阻断记 fail 不停测」；新增步骤 6「复验只验 `git diff <prev-head>..HEAD` 碰到的 + 上一轮 fail/not_run；其余 carried 引用 claim id；小修真房豁免」 |
| `ctx.phaseFixContext` 1140-1148 行 | `fix exactly what they name` 改为「修点名场景 + 同一段逻辑的相邻状态路径（排队中 / 已起 / 已死 / 被取代 / 重试 / 并发）一起补测；交卷说明列出补了哪些相邻路径」；追加 `qaCriteriaBlock` |
| `BlueprintContext` 220 行 | `phaseFixContext.qaCriteriaBlock?: string`；新增 `qaCriteriaContext?: { block: string }` |

真仓的 `QA_CRITERIA_FILE_INSTRUCTION` / `QA_REVERIFY_SCOPE` 常量放在 Blueprint 顶部，本仓同名。

### 2.7 角色文件

| 文件 | 改动 |
|---|---|
| `.flywheel/agents/engineering/qa-executor.md` | Work loop 第 2 步加「先建判据清单」；第 3 步改为「阻断记 fail 继续测，不停」；第 4 步加 `--criteria-file`；新增「复验」小节（只验改动 + carried + 小修真房豁免）；Reporting 段加 `qa-criteria/v1` 标记 |
| `agents/qa-executor.md`（shipped default） | 同上，措辞项目无关 |
| `.flywheel/agents/engineering/engineer-executor.md` | Work loop 加「QA fix rounds (qa-criteria/v1, FLY-3055)」一段：相邻路径 + 交卷说明列相邻路径 |

两份 qa-executor 都含字面 `qa-criteria/v1`，供 Blueprint 判「角色文件已更新，不再注入规则块」。

### 2.8 Lead 可见面

`workflow-decision-routes.ts` 响应与 `insertEvent` payload 带 `criteriaCounts`；Lead 侧 hook-payload 本仓没有 claim 渲染入口（`hook-payload.ts` 无 claim 相关代码），**不加**新的 Lead 事件，只保证 counts 进 `session_events.payload`，Lead 用 `flywheel-comm inbox` 已能看到。

## 3. 既有测试 seam

| 测试文件 | 复用方式 |
|---|---|
| `packages/flywheel-comm/src/commands/__tests__/qa-result.test.ts` | 已有 fetch mock + env stub 模式；加 criteria 通过/拒收/短路不重试用例 |
| `packages/teamlead/src/__tests__/workflow-decision-routes.test.ts` | `fixture()` 已建好 impl/qa session + run + node + credential admission + git worktree；直接加 `qa_criteria` body 用例；第二轮用 `upsertWorkflowRunNode(attempt 2)` + 再 admit |
| `packages/edge-worker/src/__tests__/Blueprint.fly859-qa-phase-prompt.test.ts` | 断言三段式 QA/fix 提示词行；加 `--criteria-file` 与相邻路径断言 |
| `packages/edge-worker/src/__tests__/Blueprint.fly579-qa-mode.test.ts` | auto-QA 提示词；加清单步骤断言 |
| `packages/teamlead/src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts` | 已 mock `wakePhaseRunner`；断言 fix/retest 唤醒参数含 criteriaBlock |
| `packages/edge-worker/src/__tests__/AgentDispatcher.test.ts` + `scripts/__tests__/package-onboard-smoke.test.sh` | 已读 `qa-executor.md`；确认改文字不破坏它们 |

新增测试文件：

- `packages/config/src/__tests__/qa-criteria.test.ts`（schema 全表 + verdict 一致性 + prior 检查 + 撤销白名单 + 预算裁剪）
- `packages/flywheel-comm/src/__tests__/qa-result-criteria-cli.test.ts`（真 CLI 子进程：缺 reason 的 not_run → exit 1、stderr 含「先把剩下的判据测完或写明为什么没测」、无 HTTP、无 marker）
- `packages/teamlead/src/__tests__/StateStore.qa-criteria.test.ts`（事务内拒收不消费 credential；prior 查询；chain 加载）
- `packages/teamlead/src/__tests__/workflow-qa-criteria-context.test.ts`（qa/fixer 角色、无投影为空、预算裁剪保 id、`Previous QA verdict: claim N = ` 逐字）
- `scripts/__tests__/fly3055-qa-protocol-text.test.sh`（grep 核对：两份 qa-executor.md + engineer-executor.md 含新规矩、Blueprint 不再含 `fix exactly what they name`）

## 4. 字节兼容与回滚边界

| 面 | 不配置 / 不传时 |
|---|---|
| CLI 不传 `--criteria-file` | legacy `/events` 通道行为逐字不变；credential 通道被 Bridge 拒 `qa_criteria_required`（**这是有意的行为变化**，就是本 issue 的目的） |
| 非 `qa_verdict` 家族（codex review 等） | 逐字不变 |
| 无 workflow 投影的 session（单会话 / auto-QA） | 注入函数返回空，五个出口原文案 |
| 数据库 | 零迁移；`evidence` 列已存在，旧行 `{summary}` 形态被 `qaCriteriaFromEvidence` 容忍 |
| 回滚 | revert PR 即可；已写入的 `evidence.qa_criteria` 对旧代码只是多余 JSON 键 |

## 5. 风险

1. **对齐漂移**：本仓 schema 若与真仓差一个字段名，沙箱 QA 节点提交会被真 Bridge 拒。缓解：`qa-criteria.test.ts` 里放一份与真仓相同的 fixture（§1.1 样例）做 golden。
2. **预算**：清单块 10100 + 规则块 2000 加在 wake 文本上，mailbox 单条上限需核对（`wakeRunnerMailbox` 无显式上限，CommDB `content TEXT`）。缓解：裁剪函数单测。
3. **legacy 通道漏洞**：runner 去掉 credential 走 `/events` 绕过强制。缓解：credential 通道的 session 在 `AutoQaCoordinator.onQaResult` 会因 `chat_thread_role="qa"` 的三段式会话不在其记录里而被丢弃（现有行为，`auto-qa-coordinator.ts:1237`）；本 issue 不再加锁。
