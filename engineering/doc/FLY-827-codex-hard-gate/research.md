# FLY-827 Codex code review 硬门 — 调研

Issue: FLY-827 (https://linear.app/geoforge3d/issue/FLY-827/infrap1hard-gate-codex-code-review-必须是硬门-任何-pr-没过-codex-approved-就卡住)
日期: 2026-07-03
基于: exploration.md

## 1. 精确集成点(file:line,已审计)

### 1.1 Codex 触发(现有,保留 + 扩展)
- `packages/teamlead/src/bridge/event-route.ts:1503-1511` — stage_changed==design_review|pr_created → `handleCodexAutoTrigger`。
- `event-route.ts:244-358` `handleCodexAutoTrigger` — codex_skip→写 skip.json;否则往 CommDB 写 `/codex-code-review` + `await-codex-gate code` 指令。**这里加**:pr_created(reviewType=code)时,登记 `codex_review_record=pending`(或 codex_skip→`skipped`),keyed 到 session 当前 pr_head_sha。
- `event-route.ts:191-235` `codexReviewTypeFor` + `buildCodexInstruction` — 指令文案。**这里加**:指令里追加「await-codex-gate 会向 Bridge 上报 verdict」的说明(runner 无需额外命令)。

### 1.2 runner 自阻塞门 + 上报(现有 + 新上报)
- `packages/flywheel-comm/src/commands/await-codex-gate.ts` — 轮询本地 `.flywheel/runs/<execId>/codex/<type>-review.json`,valid=exit0。**这里加**:code review 本地校验通过后,发 `codex_review_result` 事件给 Bridge(mirror qa-result 的 retry+fail-close;head=`git rev-parse HEAD`)。design review 不上报(不在门范围)。
- `packages/flywheel-comm/src/commands/qa-result.ts` — **参照模板**:`buildQaResultBody` 纯函数 + retry(4 次,backoff 1/2/4s)+ fail-close marker(`~/.flywheel/state/qa-result-failed/<exec>.json`)。新的 `codex-review-result.ts` 精确镜像。
- 上报所需 env(qa-result 已用):`FLYWHEEL_BRIDGE_URL` / `FLYWHEEL_ISSUE_ID` / `FLYWHEEL_PROJECT_NAME` / `FLYWHEEL_INGEST_TOKEN` / `FLYWHEEL_EXEC_ID`。await-codex-gate 当前只吃 execId+worktree → 上报做成 best-effort:env 缺失时 log 但仍 exit0(不破坏本地门;Bridge 侧 fail-closed 会兜住)。

### 1.3 Bridge 事件入口(新 handler)
- `event-route.ts:621-633` — `event.event_type === "qa_result"` → `onQaResult`,早返回。**这里加**同款分支:`codex_review_result` → `onCodexReviewResult`,早返回。
- `event-route.ts:601-615` — `insertEvent` 幂等(event_id dedup)已覆盖重放。

### 1.4 auto-QA spawn gate(新前置检查)
- `packages/teamlead/src/bridge/auto-qa-coordinator.ts:233-318` `onMainAwaitingReview` — QA claim/spawn/retest 入口。**这里加**:在 policy 检查后、claim/spawn/retest 之前,先查 codex gate(`codexApproved(exec, sha)`)。未过 → codex-hold(发 thread + 重发 codex 指令 + 限频告警),return。**独立于 QA policy**(codex 全队通用)。
- `event-route.ts:1789-1807` — session_completed+awaiting_review+main → `onMainAwaitingReview({freshTransition})` 调用点(不改)。

### 1.5 founder 挂起谓词(扩展)
- `packages/teamlead/src/bridge/auto-qa-held.ts` `isQaHeld` — 单一谓词。**新增** `isReviewHeld(store, session) = codexNotApproved(exec, head) OR isQaHeld`。3 处消费点改用 `isReviewHeld`:
  - `event-route.ts:1903-1906`(always-deliver 压制)
  - `packages/teamlead/src/bridge/gate-poller.ts:394`(approve gate 不 relay + 不 evict)
  - `packages/teamlead/src/HeartbeatService.ts:298`(gate_timed_out 不催)
- 注意:`isReviewHeld` 也要 `session.status==="awaiting_review"` 且 main 才 held(codex 分支同样只对 in-review main 生效),否则破坏无关 session 的 byte-compat。

### 1.6 merge gate(扩展 verify-approval)
- `packages/flywheel-comm/src/commands/verify-approval.ts:106-269` — 读 teamlead.db(better-sqlite3 readonly)查 founder gate + head SHA。**这里加**:在 head 匹配后,SELECT `codex_review_record WHERE execution_id=? AND target_pr_head_sha=? AND status IN ('approved','skipped')`,无 → `notApproved("codex_review_not_approved")`。新 reason 枚举 + 新错误。
- `packages/flywheel-comm/src/index.ts:754-773` — CLI 输出 JSON+exitCode(不改结构,reason 会带上)。
- 注:verify-approval 已按项目解析 teamlead.db 路径(`resolveStateDbPath`),能直读新表。

### 1.7 告警(复用)
- `packages/teamlead/src/bridge/auto-qa-effects.ts:266-306` `alertLeadPipelineError` → `LeadAlertNotifier.alert()`(FLY-368 统一 Alerts 频道,eventId 去重)。codex-hold 复用它(或新增 `alertCodexGateBlocked`,eventType `codex_gate_blocked`,eventId 每 head 只报一次)。

### 1.8 StateStore 表 + 迁移模式
- `packages/teamlead/src/StateStore.ts:1242-1266` — `auto_qa_record` 建表(**镜像模板**:PK=parent_execution_id+target_pr_head_sha)。新表 `codex_review_record` 同款,在 `initSchema` 里 `CREATE TABLE IF NOT EXISTS` + index。
- `StateStore.ts:2580-2740` — auto_qa_record 的 claim/set/get 方法(**镜像模板**)。新增 `upsertCodexReviewPending` / `setCodexReviewApproved` / `getCodexReviewRecord` / `listCodexReviewRecordsByStatus`(reconcile 用)。
- `StateStore.ts:4026-4055` `migrateAutoQaRecordQaIssueColumns` — 迁移模式参考(新表不需迁移,`CREATE TABLE IF NOT EXISTS` 即可)。

### 1.9 coordinator 接线
- `packages/teamlead/src/bridge/plugin.ts:3612-3664` — `new AutoQaCoordinator({store, startDispatcher, resolveQaPolicy, effects, logger})`。**这里加** codex gate 所需 deps(store 已有;codex-hold 的重发指令 + 告警走 effects/新 helper)。`onCodexReviewResult` 也挂在 coordinator 上,与 onQaResult 对称。
- coordinator 需要一个「重发 codex 指令」的 effect(复用 `handleCodexAutoTrigger` 的 CommDB 写逻辑;抽一个可复用函数 `queueCodexCodeReviewInstruction(projectName, execId)`)。

## 2. 关键竞态与 fail-closed 边界

1. **complete 先到、report 后到**:runner 若在 await-codex-gate 上报前就 complete(理论上 await-codex-gate 在 complete 前 block,但防御)→ onMainAwaitingReview 时 codex 未 approved → codex-hold(founder 挂起,不 spawn QA)。随后 `codex_review_result` 到 → `onCodexReviewResult` 记 approved → 若 parent 仍 awaiting_review → 重驱动 `onMainAwaitingReview` → 此刻 codex 过 → spawn QA。闭合。
2. **head 变(#430 补 entry)**:record keyed 到旧 head;新 head 无 approved → onMainAwaitingReview / verify-approval 都 fail-closed。runner fix-loop push 新 head → onMainAwaitingReview(driveRetest 之前先 codex gate)→ 未过 → codex-hold + 重发指令 → runner 重跑 Codex → 上报新 head → 重驱动 → 过 → 继续 retest QA。
3. **runner 压根没跑 Codex(#430)**:无 `codex_review_result` → codex-hold + 告警 + 重发「去跑 Codex」指令(Lead D3 补充:闭环,让 runner 知道被卡去补跑)。
4. **上报网络失败**:mirror qa-result 的 retry+marker;耗尽 → runner 本地门过了但 Bridge 不知 → codex-hold(fail-closed)+ 告警,Lead 介入。可接受。
5. **restart reconcile**:Bridge 重启后,`onMainAwaitingReview` 由现有 auto-QA reconcile / gate-poller 自然重评(codex gate 是纯查表,幂等)。pending 记录 + approved 记录都在 durable 表里,重启不丢。**不需要**给 codex 单开 reconcile timer(查表即真相)。

## 3. kill-switch / byte-compat

- `FLYWHEEL_CODEX_HARD_GATE`(默认 ON;`=0` → 门全放行 = 命门,Lead 要求可靠):
  - onMainAwaitingReview 的 codex 前置检查:`=0` → 跳过(回退到原 QA 直 spawn 行为)。
  - verify-approval 的 codex 检查:`=0` → 跳过。
  - isReviewHeld 的 codex 分支:`=0` → 只用 isQaHeld(回退)。
  - pr_created 登记 pending / await-codex-gate 上报:与 kill-switch 无关(登记/上报无害;门本身放行即可)。
- codex-skip label/flag → `skipped` 记录 → 门放行(合法豁免,现成)。
- 默认 ON = 行为变化(非 byte-compat)。这是 Annie 要的强制。逃生口 = kill-switch。QA 必证:(a) 无 Codex 被卡 (b) 有 Codex approved 不误卡 (c) kill-switch 一开立即放行。

## 4. 测试位置

- `packages/flywheel-comm/src/__tests__/` — codex-review-result body/上报、verify-approval codex 分支、await-codex-gate 上报。
- `packages/teamlead/src/bridge/__tests__/` — onCodexReviewResult、onMainAwaitingReview codex-hold、isReviewHeld、event-route codex_review_result 路由、StateStore codex_review_record 方法。
- 参照现成:`auto-qa-coordinator.test.ts` / `verify-approval.test.ts` / `await-codex-gate.test.ts` / `event-route.codex-trigger.test.ts`。

## 5. 出范围(确认)

- design review 门:保持现状(await-codex-gate design 已管,implement 前门)。
- 补今天的洞(#430 重跑 Codex、#802/#807 核实)= 运营,非本 PR 代码(Lead 已核实 #802/#807 都过了,#430 让 793 跑)。
- 防恶意 runner 伪造 verdict:出范围(同 verify-approval/qa-result 的「可信本地进程」威胁模型)。本 issue 是**强制执行**,非 anti-forgery。
