# FLY-2332 重放凭据轮换 — 实施计划
Issue: FLY-2332 (https://linear.app/geoforge3d/issue/FLY-2332/引擎urgent-rework-coordinator-重试-admit-走-idempotent-replay-时不-rotate)
日期: 2026-09-04
基于: research.md

> **For agentic workers:** 在当前 implement TURN 内按本计划逐项执行；严格使用 systematic-debugging、test-driven-development 和 verification-before-completion。不得调度 successor node。

**Goal:** rework coordinator 在 admission 成功但 TURN grant 失败后的幂等重放中，向新 activation 交付与 StateStore 最新未撤销行一致的 submission/output credential。

**Architecture:** coordinator 解析 pinned workflow snapshot，按 decision contract 与 `produces_output` 能力决定需要的凭据；仅当 admission 是 replay 且缺少对应明文时调用现有 rotation API。StateStore rotation API 接受可选 exact activation identity，并对 rework wake 走当前 delivery claim 的 owner/generation/lease/route fence；非 rework 调用仍走原 launch-owner fence。

**Tech Stack:** TypeScript, Vitest, sql.js StateStore, better-sqlite3 CommDB, pnpm。

---

## 文件职责

- `packages/teamlead/src/bridge/__tests__/workflow-rework.e2e.test.ts`：真实 StateStore + CommDB 的 lease-held → replay 回归测试，分别锁定 submission/output credential。
- `packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts`：rotation exact activation 与 rework claim 的负向授权守卫。
- `packages/teamlead/src/StateStore.ts`：exact activation 上下文解析及 rework delivery claim fence；credential revoke/mint transaction 保持不变。
- `packages/teamlead/src/bridge/workflow-rework-coordinator.ts`：replay 检测、能力判断、rotation、错误前缀与 grant payload。
- `engineering/doc/FLY-2332-replay-credential-rotation/progress.md`：阶段游标和验证证据。
- `engineering/doc/milestones/FLY-2332.md`：PR 前最后一个 literal commit。

### Task 1: submission credential replay — RED → GREEN

**Files:**

- Modify: `packages/teamlead/src/bridge/__tests__/workflow-rework.e2e.test.ts`
- Modify: `packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts`
- Modify: `packages/teamlead/src/StateStore.ts`
- Modify: `packages/teamlead/src/bridge/workflow-rework-coordinator.ts`

- [ ] **Step 1: 扩展 E2E harness，让指定 execution 的第一次 TURN grant 抛 lease-held**

在 `createHarness` options 增加：

```ts
failGrantOnceFor?: string;
```

在真实 `comm.grantTurn` 前只失败一次：

```ts
const failedGrantExecutions = new Set(
  options.failGrantOnceFor ? [options.failGrantOnceFor] : [],
);
// inside effects.grantTurn
if (failedGrantExecutions.delete(input.executionId)) {
  throw new Error("execution mutation lease refused: lease_held");
}
```

- [ ] **Step 2: 写 QA decision activation 的失败回归测试**

从现有 rework E2E 流程得到 QA attempt 2 request 后：

```ts
await expect(coordinator.reconcile(qaRequestId)).resolves.toMatchObject({
  kind: "retryable",
  reason: "turn_grant_failed:execution mutation lease refused: lease_held",
});
current = new Date("2026-07-23T00:24:00.000Z");
await expect(coordinator.reconcile(qaRequestId)).resolves.toMatchObject({
  kind: "awaiting_receipt",
  executionId: "qa-exec",
});
const activation = comm.getCurrentRunnerWorkflowActivation("qa-exec");
expect(activation?.submission_credential).toEqual(expect.any(String));
expect(
  store.getWorkflowSubmissionCredentialByToken(
    activation!.submission_credential!,
  ),
).toMatchObject({
  activation_id: activation!.activation_id,
  revoked: 0,
});
```

同时通过测试内只读 SQL 断言该 execution 只有一条未撤销 submission row，且旧 row 已撤销。

- [ ] **Step 3: 运行单测并确认 RED 原因正确**

Run:

```bash
VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/workflow-rework.e2e.test.ts -t "rotates submission credential after a lease-held replay"
```

Expected: FAIL；CommDB activation 的 `submission_credential` 为 null/undefined，而不是 fixture/setup error。

- [ ] **Step 4: 给 StateStore submission rotation 增加 exact activation + rework claim fence**

输入扩展保持向后兼容：

```ts
activationId?: string;
```

上下文选择：

```ts
const context = input.activationId
  ? this.generalizedExecutionContextForActivation(input.activationId)
  : this.generalizedExecutionContext(input.executionId);
if (!context || context.binding.execution_id !== input.executionId) {
  return { ok: false, reason: "not_enrolled" };
}
```

在 transaction 中，`mode === "wake" && rework_request_id` 时验证 live delivery claim 与 latest route 的 execution/node/attempt；否则执行现有 launch-owner判断。rework mismatch 返回 `stale_rework_owner`，不撤销任何 credential。

- [ ] **Step 5: coordinator 在 decision replay 上 rotation**

缓存 parsed snapshot 并解析 contract：

```ts
const snapshot = parseWorkflowRunSnapshot(run.snapshot!);
const node = snapshot.resolved.nodes.find(
  (candidate) => candidate.id === route.target_node_id,
);
const decisionContract = resolveWorkflowDecisionContract(
  snapshot,
  route.target_node_id,
);
let submissionCredential = admission.submissionCredential;
if (admission.idempotentReplay && decisionContract && !submissionCredential) {
  const rotated = this.deps.store.rotateGeneralizedWorkflowSubmissionCredential({
    executionId: actor.execution_id,
    activationId,
    ownerId: this.deps.ownerId,
    generation: claim.generation,
    now: now.toISOString(),
    ...credentialWindow,
  });
  if (!rotated.ok) {
    return this.releaseRetryable({
      requestId,
      generation: claim.generation,
      reason: `engine_submission_rotation_${rotated.reason}`,
    });
  }
  submissionCredential = rotated.submissionCredential;
}
```

grant payload 改用局部变量 `submissionCredential`。

- [ ] **Step 6: 运行 targeted test，确认 GREEN**

Run 同 Step 3。Expected: PASS；CommDB 明文能命中 StateStore 最新未撤销 row。

- [ ] **Step 7: 写 StateStore 负向 guard 测试并保持绿色**

覆盖 wrong activation、stale owner/generation、expired lease、route target drift；每个用例断言 `{ ok: false, reason: "stale_rework_owner" | "not_enrolled" }` 且 credential rows 未变化。

- [ ] **Step 8: 提交 submission batch**

```bash
git add packages/teamlead/src/StateStore.ts packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts packages/teamlead/src/bridge/workflow-rework-coordinator.ts packages/teamlead/src/bridge/__tests__/workflow-rework.e2e.test.ts
git commit -m "fix(teamlead): rotate replayed rework submission credential"
```

### Task 2: output credential replay — RED → GREEN

**Files:**

- Modify: `packages/teamlead/src/bridge/__tests__/workflow-rework.e2e.test.ts`
- Modify: `packages/teamlead/src/StateStore.ts`
- Modify: `packages/teamlead/src/bridge/workflow-rework-coordinator.ts`

- [ ] **Step 1: 写 produces-output activation 的同形失败测试**

由 QA fail 创建 implement attempt 2 rework request，并让 `implement-exec` 首次 grant 抛 lease-held：

```ts
await expect(coordinator.reconcile(requestId)).resolves.toMatchObject({
  kind: "retryable",
  reason: "turn_grant_failed:execution mutation lease refused: lease_held",
});
current = new Date("2026-07-23T00:12:00.000Z");
await expect(coordinator.reconcile(requestId)).resolves.toMatchObject({
  kind: "awaiting_receipt",
  executionId: "implement-exec",
});
const activation = comm.getCurrentRunnerWorkflowActivation("implement-exec");
expect(activation?.output_credential).toEqual(expect.any(String));
expect(
  store.getWorkflowOutputCredentialByToken(activation!.output_credential!),
).toMatchObject({ activation_id: activation!.activation_id, revoked: 0 });
```

- [ ] **Step 2: 运行用例并确认 RED**

```bash
VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/workflow-rework.e2e.test.ts -t "rotates output credential after a lease-held replay"
```

Expected: FAIL；CommDB activation 的 `output_credential` 为 null/undefined。

- [ ] **Step 3: 实现 output rotation**

对 `rotateGeneralizedWorkflowOutputCredential` 复用 Task 1 的 exact activation/rework claim fence。coordinator 条件严格为：

```ts
if (
  admission.idempotentReplay &&
  node.capabilities.produces_output &&
  !outputCredential
) {
  // rotate; on failure releaseRetryable with engine_output_rotation_<reason>
}
```

grant payload 改用局部变量 `outputCredential`。

- [ ] **Step 4: 运行 targeted test，确认 GREEN**

Run 同 Step 2。Expected: PASS，旧 output row revoked，新 row 与 CommDB 明文匹配。

- [ ] **Step 5: 提交 output batch**

```bash
git add packages/teamlead/src/StateStore.ts packages/teamlead/src/bridge/workflow-rework-coordinator.ts packages/teamlead/src/bridge/__tests__/workflow-rework.e2e.test.ts
git commit -m "fix(teamlead): rotate replayed rework output credential"
```

### Task 3: 回归、类型与 fail-closed 验证

**Files:**

- Modify: `engineering/doc/FLY-2332-replay-credential-rotation/progress.md`

- [ ] **Step 1: 跑 coordinator 与 StateStore 相关测试**

```bash
VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/workflow-rework-coordinator.test.ts src/bridge/__tests__/workflow-rework.e2e.test.ts src/__tests__/StateStore.generalized-execution.test.ts
```

Expected: 0 failures。

- [ ] **Step 2: 跑 teamlead typecheck/build 范围验证**

```bash
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-teamlead build
```

Expected: exit 0。

- [ ] **Step 3: 检查 diff 与 scope**

```bash
git diff --check
git status --short
git diff origin/main...HEAD -- packages/teamlead/src/StateStore.ts packages/teamlead/src/bridge/workflow-rework-coordinator.ts
```

确认不包含 delivery semantics、authority/claim schema、历史 wake 回填或 `CLAUDE.md` 改动。

### Task 4: 代码审查、PR 与 implement handoff

**Files:**

- Create last: `engineering/doc/milestones/FLY-2332.md`

- [ ] **Step 1: 通过 codex:rescue 执行 code review**

定位仓库既有 `codex:rescue` 入口并对当前 code head 运行；不得直接调用 `codex exec`。

- [ ] **Step 2: 注册 code review gate**

```bash
node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-eng-lead --exec-id 98481940-6d41-4ee8-ab83-90aa65a06cc6 --no-block "Code review requested for FLY-2332"
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id <returned-question-id>
```

轮询到 APPROVED；若 CHANGES_REQUESTED，修复 blocking finding，重新验证并开新 gate/request。

- [ ] **Step 3: 创建并推送 PR（milestone literal last commit）**

先提交所有实现与文档，再创建 `engineering/doc/milestones/FLY-2332.md` 并作为 literal 最后一个 commit；push feature branch，使用 `gh pr create` 创建 PR。

- [ ] **Step 4: 完成 bounded implement node**

```bash
node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-eng-lead --exec-id 98481940-6d41-4ee8-ab83-90aa65a06cc6 --report "DONE: FLY-2332 replay credential rotation implemented, reviewed, and opened as PR <url>"
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr <number>
```

不得请求 ship approval、dispatch QA、merge 或 deploy。

## 自审

- Spec coverage：submission、output、rotation fail-closed、credential row/CommDB 一致性、scope exclusions 均有对应任务。
- Placeholder scan：实施步骤均给出具体文件、代码形状、命令与预期结果；运行时 review/PR identity 由对应命令输出绑定。
- Type consistency：coordinator 与 StateStore 均使用 `activationId`, `ownerId`, `generation`, `expiresAt`, `absoluteDeadlineAt`；错误前缀与现有 dispatcher 保持一致。
- Scope：只扩展现有 rotation seam 与两类测试，不改 workflow 状态机或 schema。
