# FLY-2152 判决投递与巡检闭环 — 实施计划
Issue: FLY-2152 (https://linear.app/geoforge3d/issue/FLY-2152/巡检缺口-判决层不在巡检清单verdict-落库但无人推送静默压单2139-三小时无人动)
日期: 2026-08-29
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and execute this plan task-by-task. This resident DAG node executes inline; it must not dispatch successor or review nodes.

**Goal:** 让每条 workflow verdict claim 都有 Bridge 主动投给 owning Lead 的 durable event，并让 Lead 巡检能发现 active run 中未投递的 claim，同时强制 QA verdict 后立即走 `ask --report`。

**Architecture:** `workflow_claims.id` 是唯一事实身份。StateStore 在 first write 前校验 owner identity，并在 claim transaction 内写稳定的 `workflow_claim_recorded` Lead event；同事务既有 `claim_written` payload 以 `leadEventRequired=true` 标记 post-change contract。route 在 commit 后即时 enqueue，现役 `LeadInboxRuntime.admit()` owner/project-scoped journal redrive 负责已注册 runtime 的崩溃/暂时失败恢复。patrol 保持六步，把第六维度的 facts 放入现有 Step 4 delivery/verdict consistency；Step 6 disposition 原样保留。

**Tech Stack:** TypeScript、Express、sql.js/SQLite、Vitest、Bash hermetic harness、pnpm workspace。

---

## 文件职责

- `packages/teamlead/src/StateStore.ts`：claim 与 Lead event 的原子耐久写入、exact replay 幂等 receipt。
- `packages/teamlead/src/bridge/workflow-decision-routes.ts`：claim commit 后从 journal 重建 envelope 并即时 enqueue。
- `packages/teamlead/src/bridge/plugin.ts`：把 `createBridgeApp()` 已有的 RuntimeRegistry 直接接到 decision router。
- `packages/teamlead/src/bridge/lead-inbox-runtime.ts`：现役 owner/project-scoped journal redrive 扩到 claim event。
- `packages/teamlead/src/bridge/hook-payload.ts`：typed claim payload 与共享 renderer。
- `packages/teamlead/src/bridge/mailbox-lead-runtime.ts`、`commdb-lead-runtime.ts`：两种 Lead runtime 复用同一 renderer。
- `scripts/lead-patrol-snapshot.sh`：在 owner-scoped Step 4 增加判决层，报告仍恰好六步。
- `packages/teamlead/lead-rules-base/runner-patrol-rules.md`：第六维度的判据/动作；Step 6 与 A/B 处置合同不动。
- `packages/edge-worker/src/Blueprint.ts`：QA verdict 后立即 `ask --report` 的 prompt 合同。

### Task 1: RED — 原子 claim event 与 renderer 合同

**Files:**
- Modify: `packages/teamlead/src/__tests__/StateStore.workflow-admission.test.ts`
- Modify: `packages/teamlead/src/__tests__/workflow-decision-routes.test.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/lead-inbox-runtime.test.ts`
- Create: `packages/teamlead/src/bridge/__tests__/fly2152-claim-enqueue-priority.test.ts`
- Modify: `packages/teamlead/src/__tests__/commdb-lead-runtime.test.ts`
- Modify: `packages/teamlead/src/__tests__/mailbox-lead-runtime.test.ts`

- [ ] 在 StateStore fixture 的 fresh submission 传入：

```ts
alertIdentity: {
  leadId: "flywheel-eng-lead",
  projectName: "flywheel",
  leadResolution: "resolved",
},
```

并断言 success result 含 `leadEventSeq`、`countLeadEvents("flywheel-eng-lead", "workflow_claim_recorded") === 1`，且对应 `claim_written` payload 含 `leadEventRequired: true` / `leadEventId: workflow_claim:<claimId>`。exact replay 的 seq 不变且计数仍为 1；同 claim replay 时把 resolver 从 resolved Lead 改成 fallback/另一 Lead，仍返回原 seq 且两个 Lead 合计只有一条 event。手工删除 event 后的 exact replay 用同一稳定 id 补写一次。invalid/blank identity 返回 `alert_identity_invalid`，并对 capability、claim、credential consumption、`claim_written` run event 与 Lead event 全部断言零新增，证明 guard 在 first write 前执行。

- [ ] 在 route test 注入 required `resolveAlertIdentity` 与 `enqueueLeadEvent: vi.fn()`，提交 verdict 后断言一次调用，envelope 的 `eventId` 为 `workflow_claim:<claimId>`，payload 的 `project_name/issue_id` 正确；response-loss replay 仍使用相同 delivery identity。invalid resolver identity 返回 HTTP 503 `alert_identity_invalid`，不是 401 credential error。
- [ ] 在两个 runtime test 用同一 payload 断言输出包含 `workflow_claim_recorded`、claim id、`qa_verdict`、`qa_failed`、issue id，并用长 emoji summary 断言 Unicode-safe 有界渲染。
- [ ] 在 `lead-inbox-runtime.test.ts` 注入一条 undelivered claim journal row，先让 direct enqueue 缺席，
  启动 runtime 后断言 `admit()` redrive 同一个 event id、delivery adapter 收到一次、最终调用
  `markLeadEventDelivered(seq)`；另放一条 wrong-project payload，断言永不进入该 runtime。该测试是
  恢复 owner 的行为证据，不用 dead constant 假代。
- [ ] 增加跨缝集成回归：用真实 workflow decision route + StateStore 生成并直投 claim envelope，
  把它写进真实 `MailboxQueue`，再让 `admit()` 的 durable-row envelope 对同一 queue 重驱。两次投递
  必须产生完全相同的 delivery identity/projection，第二次不得抛 `mailbox identity conflict`。
- [ ] 在 `lead-inbox-runtime.test.ts` 再注入“第一条 claim 重驱失败、第二条有效”的两行，断言第一行只产生
  scoped structured warning，第二行仍进入 queue，且后续 `runnerLane.tick()` / delivery pass 继续执行。
  失败行保持 `delivered_at IS NULL`，由既有判决层持续暴露；本单不新增第二本 failure-counter/
  dead-letter 状态账，也不把未投递伪装成已投递。逐行隔离只覆盖本单新增的
  `workflow_claim_recorded`；既有 `workflow_replacement_eligibility` 继续沿用 loop-stale 的失败可见性。
- [ ] 运行：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/StateStore.workflow-admission.test.ts \
  src/__tests__/workflow-decision-routes.test.ts \
  src/bridge/__tests__/fly2152-claim-enqueue-priority.test.ts \
  src/bridge/__tests__/lead-inbox-runtime.test.ts \
  src/__tests__/commdb-lead-runtime.test.ts \
  src/__tests__/mailbox-lead-runtime.test.ts
```

预期：新增断言 RED；失败原因分别是 `leadEventSeq`、event、renderer、现役 redrive contract 尚不存在；命令逐一列出真实存在的文件，禁止非匹配 filter 假绿。

### Task 2: GREEN — claim transaction 与即时 Lead enqueue

**Files:**
- Modify: `packages/teamlead/src/StateStore.ts`
- Modify: `packages/teamlead/src/bridge/workflow-decision-routes.ts`
- Modify: `packages/teamlead/src/bridge/legacy-lead-event-reconciler.ts`
- Modify: `packages/teamlead/src/bridge/plugin.ts`
- Modify: `packages/teamlead/src/bridge/lead-inbox-runtime.ts`
- Modify: `packages/teamlead/src/bridge/hook-payload.ts`
- Modify: `packages/teamlead/src/bridge/mailbox-lead-runtime.ts`
- Modify: `packages/teamlead/src/bridge/commdb-lead-runtime.ts`
- Modify: `packages/teamlead/src/__tests__/StateStore.engine-invariant.test.ts`
- Modify: `packages/teamlead/src/__tests__/StateStore.fly1686-gate-entry-binding.test.ts`
- Modify: `packages/teamlead/src/__tests__/StateStore.founder-kickback-newcard-loop.test.ts`
- Modify: `packages/teamlead/src/__tests__/StateStore.workflow-admission.test.ts`
- Modify: `packages/teamlead/src/__tests__/StateStore.workflow-engine-transition.test.ts`
- Modify: `packages/teamlead/src/__tests__/StateStore.workflow-rework.test.ts`
- Modify: `packages/teamlead/src/__tests__/StateStore.workflow-ship-ready.test.ts`
- Modify: `packages/teamlead/src/__tests__/StateStore.workflow-source-projector.test.ts`
- Modify: `packages/teamlead/src/__tests__/workflow-decision-routes.fly1686.test.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/merge-ship-gate.integration.test.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/question-admission.test.ts`
- Modify: `packages/teamlead/src/bridge/__tests__/workflow-engine-runner-ship-probe.test.ts`

- [ ] 给 `HookPayload` 增加 allowlist 字段：

```ts
workflow_claim_id?: number;
workflow_decision_kind?: string;
workflow_predicate?: string;
workflow_issued_at?: string;
```

- [ ] 为 claim event builder 定义收窄类型，强制 `event_type/execution_id/project_name/issue_id` 与上述
  四个 claim 字段存在；在 `hook-payload.ts` 实现共享 `formatWorkflowClaimRecorded()`，固定显示
  issue/run/node/attempt、claim id、decision kind、predicate、issued_at 与经
  `truncateCodePoints(summary, 300)` 处理的 summary，并提示 Lead 立即推进返工、结果汇报或 ship。
- [ ] 把 `submitWorkflowDecisionByCredential().alertIdentity` 与
  `WorkflowDecisionRouterDeps.resolveAlertIdentity` 改为 required；方法开头在进入 transaction 前运行：

```ts
if (!StateStore.workflowAlertIdentityValid(input.alertIdentity)) {
  return { ok: false, reason: "alert_identity_invalid" };
}
```

fresh path 的 claim insert 后、transaction commit 前才用稳定 id 写 journal：

```ts
const leadEventSeq = this.appendLeadEvent(
  input.alertIdentity.leadId,
  `workflow_claim:${claimId}`,
  "workflow_claim_recorded",
  JSON.stringify(claimPayload),
  `wf:${credential.run_id}`,
);
```

claim payload 必含 `project_name: input.alertIdentity.projectName` 与 persisted `issue_id`。exact replay 按
`event_type/event_id` 全局找 row：恰一条则返回既有 seq；零条则在 replay transaction 内用 persisted
claim/run + exact input 补写；多条视为 `credential_receipt_corrupt`。success result 增加必有的
`leadEventSeq`，不改变现有 HTTP success response 字段。
- [ ] fresh path 的既有 `claim_written` payload 同事务增加
  `leadEventRequired: true, leadEventId: workflow_claim:<claimId>`；不加 table/column/migration channel。
  pre-change event 无 marker，巡检不重复报；exact replay 可补 event，但不篡改 immutable 历史 event。
- [ ] 上述 Files 清单枚举了当前所有 11 个 direct StateStore test callers；逐一补有效
  `alertIdentity` fixture。两个 router test files 及 founder-kickback route fixture 也补 required resolver；
  TypeScript 编译用来兜住未来漏传，生产调用不得省略 identity。
- [ ] 在 canonical journal-envelope builder 旁定义唯一的 mailbox priority 常量 `2`；route 直投、
  `LeadInboxRuntime.admit()` 重驱与既有 replacement event producer 都必须用这个常量，禁止调用点各写
  `1`/`2`。在 route deps 增加 required `enqueueLeadEvent: (envelope: LeadEventEnvelope) => void`。result 有 seq
  时用 `getLeadEventBySeq()` + canonical priority 重建 envelope 并即时 enqueue；enqueue 异常记录
  claim/event/lead 的 structured warning 后 HTTP 仍回 claim 成功，因为 journal row 已 durable。不要声称
  route 能判断 runtime 是否存在，也不要把 warning 当恢复证据。
- [ ] 把上一条的恢复依据改成现役 redrive：`StateStore.listUndeliveredLeadInboxEvents()` 只 allowlist
  `workflow_replacement_eligibility|workflow_claim_recorded`，按 lead/project 过滤；
  `LeadInboxRuntime.admit()` 每次用 durable row + canonical priority 重建并 enqueue。对
  `workflow_claim_recorded` 每行单独 `try/catch`：失败只记录 allowlisted
  lead/project/seq/event_type/error-name 后继续下一行与 tick 的后续 lane，绝不能让一个 verdict poison row
  关闭整个 Lead inbox；失败行不 mark delivered，继续作为 durable pending fact。replacement event 的异常
  仍向外抛出，保留既有 loop-stale detector。它只保证已注册 runtime 的 recovery；
  runtime 未注册时 row 留在 journal，Step 4 判决层以 `CLAIM_DELIVERY_PENDING` durable 暴露，待后续 boot
  成功注册后再 redrive。
- [ ] 在 `createBridgeApp()` 直接使用 positional `registry`，adapter 若缺 registry 就显式 throw
  `RuntimeRegistry unavailable`，否则调用 `registry.enqueueLeadEvent(envelope)`；这让非生产 test mount
  留下 structured warning 与 pending journal row。生产 `startBridge()` 已在构造 app 前创建并传入
  registry，不引入 mutable closure，也不 silent optional-chain。
- [ ] 两种 runtime 增加 `workflow_claim_recorded` special branch。
- [ ] 重跑 Task 1 命令，预期全部 PASS。
- [ ] 再运行 `pnpm --filter flywheel-teamlead exec vitest run`，覆盖 Files 清单里所有 identity/resolver
  callsites，避免只在 Task 5 才发现 mandatory type/fixture 破坏。
- [ ] 提交：

```bash
git add \
  packages/teamlead/src/StateStore.ts \
  packages/teamlead/src/__tests__/StateStore.engine-invariant.test.ts \
  packages/teamlead/src/__tests__/StateStore.fly1686-gate-entry-binding.test.ts \
  packages/teamlead/src/__tests__/StateStore.founder-kickback-newcard-loop.test.ts \
  packages/teamlead/src/__tests__/StateStore.workflow-admission.test.ts \
  packages/teamlead/src/__tests__/StateStore.workflow-engine-transition.test.ts \
  packages/teamlead/src/__tests__/StateStore.workflow-rework.test.ts \
  packages/teamlead/src/__tests__/StateStore.workflow-ship-ready.test.ts \
  packages/teamlead/src/__tests__/StateStore.workflow-source-projector.test.ts \
  packages/teamlead/src/__tests__/commdb-lead-runtime.test.ts \
  packages/teamlead/src/__tests__/mailbox-lead-runtime.test.ts \
  packages/teamlead/src/__tests__/workflow-decision-routes.fly1686.test.ts \
  packages/teamlead/src/__tests__/workflow-decision-routes.test.ts \
  packages/teamlead/src/bridge/__tests__/lead-inbox-runtime.test.ts \
  packages/teamlead/src/bridge/__tests__/merge-ship-gate.integration.test.ts \
  packages/teamlead/src/bridge/__tests__/question-admission.test.ts \
  packages/teamlead/src/bridge/__tests__/workflow-engine-runner-ship-probe.test.ts \
  packages/teamlead/src/bridge/commdb-lead-runtime.ts \
  packages/teamlead/src/bridge/hook-payload.ts \
  packages/teamlead/src/bridge/lead-inbox-runtime.ts \
  packages/teamlead/src/bridge/legacy-lead-event-reconciler.ts \
  packages/teamlead/src/bridge/mailbox-lead-runtime.ts \
  packages/teamlead/src/bridge/plugin.ts \
  packages/teamlead/src/bridge/workflow-decision-routes.ts
git commit -m "fix(teamlead): deliver workflow claims to owning leads"
```

### Task 3: RED/GREEN — 巡检第六维度

**Files:**
- Modify: `scripts/__tests__/lead-patrol-snapshot.test.sh`
- Modify: `scripts/lead-patrol-snapshot.sh`
- Modify: `packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts`
- Modify: `packages/teamlead/lead-rules-base/runner-patrol-rules.md`

- [ ] 在 shell fixture 增加带 `claim_written.leadEventRequired=true` marker 的 credential-backed
  `runner_node` active claims：无 event、event `delivered_at IS NULL`、owner-mismatch、已 delivered；
  再加 unmarked legacy、foreign Lead、terminal-run、founder-source 与 `bridge_policy/qa_exempt` claims。
  断言只出现 marked missing/pending/mismatch 三条，且
  输出包含 claim id/decision kind/predicate/issued_at，不包含 evidence/summary/foreign identifier；
  所有 nullable node/attempt/execution 字段都有 `coalesce` 对照。
- [ ] 先运行：

```bash
bash scripts/__tests__/lead-patrol-snapshot.test.sh
```

预期：RED，Step 4 没有 `CLAIM_DELIVERY_MISSING` / `CLAIM_DELIVERY_PENDING`。
- [ ] 在 snapshot 的 Step 4 新增 verdict SQL：只选 active project run 且
  `issuer_kind='runner_node' AND client_request_id IS NOT NULL AND issuer_execution_id IS NOT NULL`
  的 non-revoked claim，并精确 join 同 run 的 `claim_written` event，要求
  `json_extract(payload,'$.claimId')=claim.id`、`leadEventRequired=1`、`leadEventId` 等于稳定 id；再与
  `lead_events event_id=claim_written.leadEventId` 联查。marker malformed/duplicate 只关闭 claim 分支并
  输出聚合 `CLAIM_ATTRIBUTION_INCOMPLETE reason=claim_delivery_marker_invalid`。复用
  `OWNER_ATTRIBUTION_CTES` 但使用**独立 claim subject/resolution guard**，不把 claim 放进 Step 4 既有
  shared `attribution_subjects`；只输出 attributed owner 的 missing/pending/owner-mismatch delivery。
  claim owner 不完整时输出聚合 `CLAIM_ATTRIBUTION_INCOMPLETE`，mailbox/wake/dead-letter/head 四类仍
  正常产出。字符串拼接一律 `coalesce`。
- [ ] **保持六步且 Step 6 byte-compatible**：verdict facts 与 Step 4 原 delivery facts 合并决定同一个
  Step 4 candidate；Step 6 的 disposition、`linear_epic_unavailable` 与 A/B 规则不改。不要生成 Step 7，
  不改 `FINAL_STEP_COUNT=6` / `[1-6]` validators。
- [ ] 在巡检规则中新增命名的第六维度“判决层”，明确它由 Step 4 承载；每 tick 查 marked claim 的
  `decision_kind/predicate/issued_at`。缺 event、event 未 delivered 或 owner mismatch 都是 finding；
  missing 是 marker+event 原子不变量破坏的 restore/tamper/corruption canary，Lead 必须带账本证据升级，
  不能假装持有已消费 credential 自愈；pending 是真实 FLY-2139 信号，要恢复 runtime/投递；owner
  mismatch 要按 stable event identity 修 owner resolver 而不是另铸 event。
- [ ] 规则测试证明 rollout contract：最终报告仍恰有 `STEP 1`–`STEP 6`、没有 `STEP 7`；把改动前
  completion/finding validator 作为 golden consumer 跑新 finalized fixture 仍通过。另让七步 mutant
  在旧 validator 下响亮失败，证明 renumber 会阻断。断言 Step 4 判决层必备 claim 字段、禁
  evidence/summary；加一条 invalid claim attribution + stale mailbox/unacked wake fixture，断言聚合
  `CLAIM_ATTRIBUTION_INCOMPLETE` 不压掉既有 facts。Step 6 规则与 `linear_epic_unavailable` literals
  byte-compatible。
- [ ] 运行：

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly369-patrol-rule.test.ts
bash scripts/__tests__/lead-patrol-snapshot.test.sh
```

预期：全部 PASS。
- [ ] 提交：

```bash
git add scripts/lead-patrol-snapshot.sh scripts/__tests__/lead-patrol-snapshot.test.sh packages/teamlead/lead-rules-base/runner-patrol-rules.md packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts
git commit -m "fix(patrol): surface undelivered workflow verdicts"
```

### Task 4: RED/GREEN — QA verdict 后立即报告 Lead

**Files:**
- Modify: `packages/edge-worker/src/__tests__/Blueprint.fly859-qa-phase-prompt.test.ts`
- Modify: `packages/edge-worker/src/Blueprint.ts`
- Modify: `packages/teamlead/src/__tests__/StateStore.workflow-engine-transition.test.ts`

- [ ] 给 generalized credential prompt、QA PASS、QA FAIL（Codex/Claude keep-alive、non-keep-alive）及 founder feedback kickback 加顺序断言：同一个 command block 内 `qa-result` 后紧接 `&& node ... ask --lead ... --report`，compound block 在 gate/park/wait 前。generalized 使用准确的 “workflow verdict”，legacy QA 使用 “QA verdict”。加 missing `leadId` 兼容用例：不 throw，Bridge event 保持唯一保证。
- [ ] 运行：

```bash
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.fly859-qa-phase-prompt.test.ts
```

预期：RED，prompt 没有 verdict 后报告命令。
- [ ] 在 `Blueprint.ts` 定义可复用的 exact report 指令文本，让调用者传入准确 label、status 与同一
  summary placeholder：

```ts
const verdictAndLeadReport = (input: {
  qaResult: string;
  label: "workflow verdict" | "QA verdict";
  status: "pass" | "fail" | "pass|fail";
  summary: string;
}) =>
  ctx.leadId?.trim()
    ? `${input.qaResult} && node ${commCliPath} ask --lead ${ctx.leadId.trim()} --exec-id ${executionId} --report "DONE: ${input.label} recorded; status=${input.status}; evidence=${input.summary}; blocking priority=<none|priority>"`
    : input.qaResult;
```

PASS compound action 在 approve gate 前、FAIL/kickback compound action 在 park/wait 前；缺 lead 的
历史 dispatch 不新增 hard failure。紧邻指令补充：compound 非零时先读 `qa-result` receipt；若 verdict
已 accepted，只以完全相同 report message 重跑 `ask --report` 半段，绝不重提 `qa-result` 或改
summary。
- [ ] 在 `StateStore.workflow-engine-transition.test.ts` 的 QA verdict fixture 断言 submission 成功后 reporting `sessions.status` 仍为 `running`，证明 `commitWorkflowTransitionTx()` 不会在 `qa-result` HTTP 返回前同步终结当前 shell；compound command 因而是可执行双保险，不只是 prompt 排序。
- [ ] 重跑 edge-worker focused suite，预期 PASS。
- [ ] 提交：

```bash
git add packages/edge-worker/src/Blueprint.ts packages/edge-worker/src/__tests__/Blueprint.fly859-qa-phase-prompt.test.ts packages/teamlead/src/__tests__/StateStore.workflow-engine-transition.test.ts
git commit -m "fix(edge-worker): report QA verdicts to leads immediately"
```

### Task 5: 验证、审查与交付

**Files:**
- Modify: `engineering/doc/FLY-2152-verdict-delivery-patrol/progress.md`
- Create: `engineering/doc/milestones/FLY-2152.md`

- [ ] 运行 changed-surface 定向测试、dual-path identity 回归与 shell harness，确认不是零测试假绿。
- [ ] 运行全仓门：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/lead-patrol-snapshot.test.sh
```

预期：四条命令 exit 0；若 `test:packages:run` 在目标 package 前中止，单独运行 teamlead 与 edge-worker suites 并把缺席写入验收证据，不能称为全仓通过。
- [ ] stage set `code_review`，用 `review_code` gate + `request-review --type code` 注册 Codex review；CHANGES_REQUESTED 则修复后开新 gate，直到 `reviewVerdict=APPROVED`。
- [ ] 按 `engineering/doc/milestones/README.md` 创建 `engineering/doc/milestones/FLY-2152.md`；在 milestone
  与 PR 正文显式列 FLY-2134 遗留边界：(1) `delivered_at` 不证明 Lead 已行动，run-event 判据对
  engine/legacy 两类结构性反转；(2) ordinary `ask --report` 仍显示 `[ASK]`，Lead respond 会生成
  `ask_answered` wake。说明本 PR 没有新增 unactioned 状态机或 report message family。确保 milestone
  与任何 doc archive 是 PR 的最后一个 commit，且不修改 `CLAUDE.md`。
- [ ] 更新 progress 到 qa 5/5，查 inbox，确认 worktree clean，push 当前 branch，创建 base `main` 的 PR。
- [ ] 执行：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js complete --route needs_review --pr "$(gh pr view --json number --jq .number)"
```

不请求 ship approval，不 merge。
