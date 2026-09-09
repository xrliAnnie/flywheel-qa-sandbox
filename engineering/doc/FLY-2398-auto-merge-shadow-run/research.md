# FLY-2398 自动合并影子跑(两周) — 调研
Issue: FLY-2398 (https://linear.app/geoforge3d/issue/FLY-2398/2309b4-自动合并影子跑两周-四条记录线-错判率表一次都不真的自动合并p1-依赖-b1b2b3)
日期: 2026-09-08
基于: exploration.md

行号以 `main` @ `ee113cab9`(本 worktree 基线)为准。库数据来自 2026-09-08 12:23 PT 的 `teamlead.db` 只读副本(`sqlite3 ".backup"` → scratchpad,`?immutable=1` 查询,未碰生产库)。

---

## 1. 线①:判定核可以在 StateStore 内调用,且输入在判决事务里齐备

### 1.1 判定核是纯函数 + 只读 store 接口

`bridge/run-ship-relevance.ts`:
- `resolveRunShipRelevance(store: RunShipRelevanceStore, session: RunShipRelevanceSession, now = new Date()): RunShipRelevance`(`:282`)。
- `RunShipRelevanceSession = { execution_id, pr_number?, pr_head_sha? }`(`:87`)—— **不需要整条 Session 行**。
- `RunShipRelevanceStore`(`:50`)的 7 个方法全部是 `StateStore` 已有的只读方法(`resolveWorkflowRunForExecution` / `resolveWorkflowNodePrBindingForSession` / `projectCurrentShipRelevantCandidates` / `listNestedCodexReviewHeadsForRun` / `listNestedCodexReviewHeadsForExecution` / `getShipRelevantPrSnapshot` / `resolvePrimaryShipRelevantPrSnapshot`)。
- 模块 import 只有 `import type` 自 `StateStore.js` 与三个常量自 `./ship-relevant-diff.js`(`:1-12`);`ship-relevant-diff.ts` 对 StateStore 也只是 `import type`(`:1`)。
  ⇒ StateStore 运行时 import `./bridge/run-ship-relevance.js` **无循环依赖**。先例:StateStore 已运行时 import `./bridge/resident-hold.js`(`:53`)、`./bridge/founder-notify-utils.js`(`:80`)、`./bridge/review-verdict-policy.js`(`:104`)、`./strength-two/judge.js`(`:45`)。
- 返回三态:`docs_only {fileCount, prs}` / `ship_relevant {reason ∈ primary_ship_relevant|declared_ship_relevant|file_budget_exceeded, prs}` / `unknown {reason ∈ 9 个 RunShipRelevanceUnknownReason, prs}`(`:104-131`)。`prs: RunShipRelevancePrView[]` 每个候选带 `role / repoIdentity / repoSlug / prNumber / headSha / shipRelevant? / fileCount? / missingReason?`(`:93-102`)—— **这就是要冻结的输入事实**。
- 时效判定(`classificationFromSnapshot`,`:229-281`):`|now − computed_at| > SHIP_RELEVANT_SNAPSHOT_MAX_AGE_MS(60_000)` ⇒ `*_snapshot_stale`;version ≠ 2 ⇒ `*_version_mismatch`;head / repo / pr 不等 ⇒ `*_snapshot_missing`。**`prs` 视图里没有 `computed_at`**,冻结「快照年龄」要在 StateStore 侧自己再读一次 `getShipRelevantPrSnapshot` 拿 `computed_at`(同事务内,同一份数据)。

### 1.2 判决事务里线①的三个输入都在

`recordFounderGateVerdictTx`(`StateStore.ts:54286`)入参 `binding: ReturnType<resolveFounderGateBindingTx>` = `{questionId, gateNodeId, attempt, repoIdentity, repoSlug, prNumber, headSha}`(`:54209-54284`)。
`workflow_gate_holder.source_execution_id`(DDL `:23156`)按 `question_id` 唯一可查。
⇒ `session = { execution_id: holder.source_execution_id, pr_number: binding.prNumber, pr_head_sha: binding.headSha }`。

`recordFounderGateVerdictTx` 的四个调用点(`:39490` `openOperatorRework`;`:54060` `openPendingCarryoverFounderFeedbackTx`;`:54923` / `:55147` `applyWorkflowSourceEvent` 的 founder_feedback / founder_approval 分支)全部位于 `this.db.transaction(() => {…})` 之内(`applyWorkflowSourceEvent` 的事务开在 `:54398`)。

### 1.3 快照为什么在报表时刻会丢

- `plugin.ts:5113 / 5118 / 5126 / 5154`:刷新时候选不合法(head 非 40hex、run 多义、绑定不匹配)⇒ `deleteShipRelevantPrSnapshotsExcept(executionId, [])` 清空该 execution 的全部快照。
- 刷新只针对**仍 pending 的 approve_to_ship 问题**(`gate-poller.ts` `refreshShipRelevanceBeforeRelay`),判决之后不再刷新 ⇒ 60 秒后必 `stale`,再往后可能被清。
- 实测(§3)19 条判决 12 条还有快照。

### 1.4 review-hold 不变

`review-hold.ts:153-165`:`if (!mainRole) return null;` → `resolveRunShipRelevance` → `docs_only → null` / `ship_relevant → qa_evidence_missing` / `unknown → qa_evidence_unknown`(version mismatch 例外)。B4 **不读不写**这段。

## 2. 线③:`evaluateStrengthTwo` 是 B4 的唯一入口,SQL 可重算

- `StateStore.listStrengthTwoRecordsForHead(runId, targetRepoIdentity, headSha)`(`:50797`),`ORDER BY recorded_at, record_id`。
- `evaluateStrengthTwo(rows)`(`strength-two/judge.ts`,FLY-2397 §4.3):空集 ⇒ 两半 `no_ledger_row` / `unsatisfied` / `basisRecordId=null`;有 `verdict='satisfied'` 行 ⇒ 取 `recorded_at` 最大(并列 `record_id` 最大);否则取 `recorded_at` 最大的行照抄两半。
- 表不可变(触发器 `strength_two_evidence_record_no_update/no_delete`),`target_repo_identity` v1 恒 `'__main__'`(FLY-2397 §10.8),`head_sha` = QA worktree authority HEAD(§10.4)。ship 卡 head = `workflow_ship_target_binding.frozen_head_sha` = `binding.headSha`。**同一把键**。
- 判决时刻冻结 = 对 `recorded_at ≤ verdict.recorded_at` 的行集求值;SQL 用同规则(`MAX(recorded_at), MAX(record_id)` 两级)可复算 —— 一致性断言进 SQL 包。
- `probeRecordLiveness(row, deps)`(§4.4)发网络请求(fetch / `gh api`),**不能进只读 SQL**。

## 3. 线④:`workflow_founder_gate_verdict` 实况

DDL `StateStore.ts:3165`;`recorded_at` ISO 毫秒;`author_evidence_json.kind ∈ gate_response | gate_response_legacy_payload | founder_message | operator`。
只读副本(19 行,2026-09-07T22:50Z – 09-08T17:22Z):

| verdict | founder_authored | kind | 条 |
| ------- | ---------------- | ---- | -- |
| approved | 1 | gate_response | 12 |
| rework | 1 | gate_response | 1 |
| rework | 0 | operator | 6 |

判决 → `workflow_gate_holder(question_id)` 19/19 可绑,`source_execution_id` 19/19 非空(全部 `sessions.session_role ∈ {qa, main}`)。
判决 → 该 execution 下主 PR 快照:**12/19 存在,11/19 head 相同**。缺的 7 条:3 approved + 4 operator rework。

`workflow_rework_request.authority` 落库字面:founder_feedback 路径 `'founder'`(`:54046`);`openOperatorRework` 路径 `'lead'`(`:39469`)。**PRD 的 N2「`authority='founder'`」在今天的库里 = 她本人 + Lead 附引用/不附引用走 founder_feedback 路径的那部分;operator 重开不在 N2 里。**

## 4. 线②:Lead 写入面先例与鉴权边界

### 4.1 `review-ruling`(FLY-1278)
- CLI `packages/flywheel-comm/src/commands/review-ruling.ts`:`FLYWHEEL_BRIDGE_URL` 必填,`Authorization: Bearer ${FLYWHEEL_INGEST_TOKEN}`(`:37-44`);exit 0/1/2 = 接受 / 用法 / Bridge 拒绝。
- 路由 `plugin.ts:2499`:`app.post("/review-rulings", tokenAuthMiddleware(config.ingestToken), handler)`;`tokenAuthMiddleware`(`:1161`)**token 未配置时 no-op 放行**。
- 校验在 coordinator(`review-request-coordinator.ts:483-600`):`validPrivilegedText(ruledBy, 64)`、`disposition` 枚举、定位器互斥;`404 / 400 / 409` 语义。
- 表 `review_finding_ruling` 归 `protectedAuthority`。

### 4.2 `evidence-run`(FLY-2397)—— 更严的形状
- `plugin.ts:2070-2096`:`config.ingestToken` **未配置 ⇒ 路由直接 503**(不 no-op);配置了 ⇒ `tokenAuthMiddleware` + 路由内 `rejectNonLoopback`(`strength-two-evidence-route.ts:311`)。
- body 键白名单(`BODY_REQUIRED_KEYS` / `BODY_OPTIONAL_KEYS`),`record_id` 客户端给 canonical UUID v4 作幂等键,同 id 全等 ⇒ `replayed`,任一不等 ⇒ `409 record_conflict`。
⇒ 线②照 4.2 的形状(503-when-unconfigured + loopback + 客户端幂等 id),鉴权沿 4.1(Lead 已持有 ingest token 是既成事实:Lead 今天就在跑 `review-ruling`)。

### 4.3 Lead 什么时候看见卡
`hook-payload.ts:1393 formatGateQuestion`:`checkpoint === "approve_to_ship"` ⇒ 文本含 `Question ID: <qid>` 与 FLY-2427 的 relay 指令;golden 测试 `__tests__/gate-question-render.test.ts`。**founder 的 Discord 卡不经这段文本**(卡由 Bridge 直发)。

## 5. 表登记、不变性、保留期(必须照做的三处)

- `scripts/lib/fly-2006-retention-registry.mjs`:新表进 `protectedCurrentOrReference`(`:54-55` 同族 `ship_relevant_*` / `strength_two_evidence_record`);**不许**进 `deleteTarget`(`RETENTION_MS = 14 天`,会吃掉窗口)。
- `scripts/__tests__/fixtures/fly-2006-teamlead-production-tables.json`:加表名。
- `packages/teamlead/src/__tests__/fly-2006-database-retention-sweep.test.ts:275`:`protectedCurrentOrReference` 硬计数 118 → **120**。
- 不可变触发器写法照 `founder_review_card_binding_no_update/no_delete`(`StateStore.ts:22741-22750`)。
- `SAVEPOINT` 先例:`StateStore.ts:24899-24906`(`SAVEPOINT` / `RELEASE` / `ROLLBACK TO` + `RELEASE`),引擎 better-sqlite3(FLY-663),嵌套在 `this.db.transaction` 内可用。
- migration receipt 先例:`fly-2396-founder-gate-verdict-v1`(ISO 毫秒 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`,与 `recorded_at` 同形可比)。

## 6. 只读报表脚本先例

- `scripts/fly2396-retro-report.mjs`:`--db`(默认 `~/.flywheel/teamlead.db`)、`--sql`、`--sqlite`;以 `sqlite3 "file:<snapshot>?immutable=1"` **单连接**执行 `engineering/doc/FLY-2396-*/retro-bind.sql`(TEMP 表只对创建连接可见);`STRICT_UTC_INSTANT` 校验时间参数;输出首行标模式。
- `scripts/fly-2397-strength-two-acceptance.mjs`:`createRequire` 拿 teamlead 的 `better-sqlite3`,从 `dist/strength-two/judge.js` import 纯函数跑阳性对照;对照行集 sha256 版本化(`STRENGTH_TWO_ACCEPTANCE_ROWS_SHA256`)。
- 隔离测试 `__tests__/fly2396-no-gating-readers.test.ts`:正则扫 `packages/` + `scripts/` 所有源文件,引用集合必须 `toEqual(ALLOWED)`,且不含 `land-executor / approval-signal / post-ship-finalization / external-merge-reconcile`。

## 7. 规模估计(定报表形状,不定结论)

过去两周 founder_gate 卡 6–38 张/天(中位 ~14 张 / ~12 单);回溯 docs_only 占比 33/245 ≈ 13% ⇒ 两周 N1 分母预计 **20–30 单**。
v2 快照上线以来 docs_only 快照 **0 / 15**,强度二台账 **0 行** —— 影子跑起跑时线③几乎必然全是 `no_ledger_row`。**这不是 B4 的 bug,是台账刚上线的事实;报表必须把它作为数报出来,而不是折进「不满足」。**

## 8. 调研结论(进 plan 的硬约束)

1. 线①③在 `recordFounderGateVerdictTx` 同事务、判决 INSERT 之后、`SAVEPOINT` 内冻结;计算用现成判定核,不复制逻辑。
2. 线②独立只追加表,question_id 定位,枚举四值,零自由文本,客户端 UUID 幂等,ingest-token + loopback + 未配置 503。
3. 报表 = 一份 `.sql`(只读、单连接、TEMP 表)+ 一个 `.mjs` 包装(参数校验、窗口必填、`immutable=1`、可选 liveness 探测单列标注);任何 0 都带全集。
4. 三处登记 + 两个不可变触发器 + 一个 migration receipt;no-gating-readers 同款隔离测试。
5. B4 不改 B1/B2/B3 的任何行为,不改 review-hold,不改 founder 卡文案。
