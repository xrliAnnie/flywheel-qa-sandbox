# FLY-2922 529 外层证据边界 — 实施计划
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-28
基于: research.md

> **For agentic workers:** 按本计划逐项 TDD 实施。当前 DAG 的 Implement 节点拥有执行权；不要由 Design 节点派发子 agent，也不要扩大到产品恢复状态机。

**Goal:** 给 generalized 529 real-runner driver 增加一个显式、tuple-bound 的外层证据责任边界，解除房内 QA 等待外层最终回执造成的递归死锁，同时保持生产 QA 与 strength-two 规则原样。

**Architecture:** driver 在看到每个 current QA execution 后，以 slot Lead 的既有授权通过 `flywheel-comm send` 投递 durable instruction；只有消息绑定 exact run/attempt/execution 且已投递，driver 才进入该 QA attempt 的 verdict wait。边界消息只规定证据 owner，不产生 PASS；外层 driver 仍必须跑完所有步骤并另行记录最终证据。

**Tech Stack:** Node.js ESM、`better-sqlite3` 只读检查、`flywheel-comm` mailbox CLI、`node:test`、现有 generalized 529 shell harness。

---

## 1. Scope and File Map

只允许修改 harness：

- Modify: `scripts/qa-529-generalized-e2e.mjs` — CLI flag、QA attempt 边界调用、owner/step evidence。
- Modify: `scripts/lib/qa-generalized-e2e-lib.mjs` — canonical tuple、正文、重入分类和 delivery 判定的纯函数。
- Create: `scripts/__tests__/qa-529-generalized-outer-evidence.test.mjs` — 递归等待 RED、边界 GREEN、stale/foreign/dead 负控与完整 step trace。
- Modify: `scripts/__tests__/qa-generalized-e2e-lib.test.mjs` — helper 合同单测。
- Modify: `scripts/__tests__/test-deploy-generalized.test.sh` — CLI/help/real-only 兼容守卫。
- Modify if the repo playbook currently documents this driver: `doc/qa/framework/529-room-playbook.md` — 新 flag、责任边界和“不算 PASS”说明。

禁止修改：`packages/teamlead/src/StateStore.ts`、workflow dispatcher、`.flywheel/agents/nodes/qa.md`、`packages/edge-worker/src/Blueprint.ts`、strength-two judge/evidence route、产品 feature flags。若实现发现必须改这些文件，停止并向 Lead 报告设计假设失效，不自行扩范围。

## 2. Preconditions and Baseline

- [ ] **Step 1: Acquire TURN and sync without rebase**

Run:

```bash
node "$FLYWHEEL_COMM_CLI" turn
git fetch origin
git merge origin/main
```

Expected: `turn` prints `yours`; merge preserves the approved FLY-2922 product behavior. Resolve only merge conflicts required by current main. Do not rebase or force-push.

- [ ] **Step 2: Verify exact starting head and no product delta**

Run:

```bash
git status --short --branch
git diff --name-only origin/main...HEAD
git log --oneline -10
```

Expected: the starting branch includes the existing FLY-2922 implementation; this task adds harness/docs only. Record the exact SHA in progress/evidence.

- [ ] **Step 3: Discover related tests before testing**

Run every search and save the matches in the implementation report:

```bash
git grep -lF -- 'qa-529-generalized-e2e.mjs'
git grep -lF -- '--real'
git grep -lF -- 'qaFailReady'
git grep -lF -- 'qaReady'
git grep -lF -- '--outer-evidence-boundary'
git grep -lF -- 'scripts/lib/qa-generalized-e2e-lib.mjs'
```

Expected: enumerate retained concrete tests and explicitly list every excluded match with reason. An empty new-literal result before implementation is expected and is not permission for a broad suite.

## 3. Task 1 — Write the Failing Boundary Tests

### Files

- Create: `scripts/__tests__/qa-529-generalized-outer-evidence.test.mjs`
- Modify: `scripts/__tests__/qa-generalized-e2e-lib.test.mjs`
- Modify: `scripts/__tests__/test-deploy-generalized.test.sh`

- [ ] **Step 1: Add the recursive-wait RED case**

Build a deterministic fake real QA transport around the same attempt sequence used by the driver. The fake starts in `awaiting_host_529_receipt`; it only emits its normal QA verdict after receiving an exact boundary instruction. Assert that boundary disabled preserves the wait and never invents a verdict:

```js
test("real inner QA recursively waits when no outer evidence boundary is enabled", async () => {
  const result = await runBoundaryScenario({ enabled: false });
  assert.deepEqual(result.steps, [1, 2, 3]);
  assert.equal(result.qaState, "awaiting_host_529_receipt");
  assert.equal(result.driverState, "waiting_for_qa_verdict");
  assert.equal(result.instructions.length, 0);
  assert.equal(result.finalEvidenceRecorded, false);
});
```

The fixture must call the same exported boundary orchestrator used by `scripts/qa-529-generalized-e2e.mjs`; a test-only duplicate implementation is not acceptable.

- [ ] **Step 2: Add the enabled GREEN expectation before code exists**

```js
test("explicit outer boundary lets the driver finish all nine steps", async () => {
  const result = await runBoundaryScenario({ enabled: true });
  assert.deepEqual(result.steps, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(result.qaAttempts.map((x) => x.verdict), ["fail", "pass"]);
  assert.equal(result.instructions.length, 2);
  assert.equal(result.instructions[0].tuple.qaAttempt, 1);
  assert.equal(result.instructions[1].tuple.qaAttempt, 2);
  assert.notEqual(
    result.instructions[0].tuple.qaExecutionId,
    result.instructions[1].tuple.qaExecutionId,
  );
  assert.equal(result.finalEvidenceRecorded, true);
});
```

The final fixture transition may only set `finalEvidenceRecorded=true` after step 9; receiving the instruction itself must leave it false.

- [ ] **Step 3: Add fail-closed negative cases**

Cover, as separate table rows: stub mode + flag, non-generalized room, foreign run, nodeId other than `qa`, wrong attempt, stale/replaced execution, `resolved_to` mismatch, mailbox `DEAD`, `torn`, timeout before `delivered_at`, duplicate matching row, and conflicting multiple rows. Expected result is a named error and zero QA verdict/final evidence.

- [ ] **Step 4: Add CLI compatibility assertions**

Extend `test-deploy-generalized.test.sh`:

```bash
assert_contains "$driver_help" '--outer-evidence-boundary' \
  'real generalized driver publishes the explicit outer evidence boundary'

if node "$ROOT/scripts/qa-529-generalized-e2e.mjs" 2 \
  --issue FLY-2922 --outer-evidence-boundary >/tmp/fly2922.out 2>&1; then
  echo 'FAIL: outer evidence boundary accepted without --real' >&2
  failures=$((failures + 1))
else
  assert_contains "$(</tmp/fly2922.out)" \
    '--outer-evidence-boundary requires --real' \
    'outer evidence boundary is real-runner-only'
fi
```

Use a test-specific temp directory, not a shared `/tmp/fly2922.out`, in the implementation; the snippet shows only the required assertion shape.

- [ ] **Step 5: Run the new concrete test files and confirm RED**

Run one file at a time:

```bash
node --test scripts/__tests__/qa-529-generalized-outer-evidence.test.mjs
node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs
bash scripts/__tests__/test-deploy-generalized.test.sh
```

Expected before implementation: failures identify missing exports/flag/boundary transition, not fixture syntax or unrelated environment failures.

- [ ] **Step 6: Commit the RED tests**

```bash
git add scripts/__tests__/qa-529-generalized-outer-evidence.test.mjs \
  scripts/__tests__/qa-generalized-e2e-lib.test.mjs \
  scripts/__tests__/test-deploy-generalized.test.sh
git commit -m "test(FLY-2922): reproduce nested 529 evidence wait"
```

## 4. Task 2 — Add Pure Boundary Contracts

### Files

- Modify: `scripts/lib/qa-generalized-e2e-lib.mjs`
- Test: `scripts/__tests__/qa-generalized-e2e-lib.test.mjs`

- [ ] **Step 1: Add canonical tuple validation**

Implement one pure constructor with strict fields and no secret-bearing free text:

```js
export function buildOuterEvidenceBoundaryTuple(input) {
  if (input.runnerMode !== "real") {
    throw new Error("--outer-evidence-boundary requires --real");
  }
  if (input.nodeId !== "qa") throw new Error("outer evidence boundary requires qa node");
  if (!Number.isInteger(input.qaAttempt) || input.qaAttempt < 1) {
    throw new Error("outer evidence boundary requires a positive QA attempt");
  }
  return {
    schemaVersion: 1,
    kind: "qa529_outer_evidence_boundary",
    issue: requiredString(input.issue, "boundary.issue", "outer evidence boundary"),
    slot: input.slot,
    runId: requiredString(input.runId, "boundary.runId", "outer evidence boundary"),
    qaExecutionId: requiredString(
      input.qaExecutionId,
      "boundary.qaExecutionId",
      "outer evidence boundary",
    ),
    qaAttempt: input.qaAttempt,
    evidenceDir: requiredString(
      input.evidenceDir,
      "boundary.evidenceDir",
      "outer evidence boundary",
    ),
  };
}
```

Also validate `slot` as a positive integer and `issue` as canonical `[A-Z]+-\d+`.

- [ ] **Step 2: Add deterministic instruction rendering**

```js
export function renderOuterEvidenceBoundaryInstruction(tuple) {
  return `[qa529-outer-evidence-boundary/v1] This QA execution is inside the generalized real-runner campaign named below. The outer driver is the sole producer of the campaign's final 529 evidence. Do not start or wait for a nested 529 campaign. Still verify the exact head and this node's required scenarios, then submit the normal qa-result. This instruction is not PASS and is not an evidence receipt. tuple=${JSON.stringify(tuple)}`;
}
```

Tests must assert deterministic bytes, exact tuple, absence of token/credential values, and explicit `not PASS` / `not an evidence receipt` language.

- [ ] **Step 3: Add read-only reconciliation helpers**

Add pure classification for existing mailbox rows:

```js
export function classifyOuterEvidenceBoundaryRows(rows, expected) {
  const exact = rows.filter((row) =>
    row.type === "instruction" &&
    row.from_agent === expected.fromAgent &&
    row.to_agent === expected.toAgent &&
    row.content === expected.content
  );
  if (exact.length > 1) throw new Error("outer evidence boundary is ambiguous");
  if (exact.length === 0) return { kind: "missing" };
  const row = exact[0];
  if (row.state === "DEAD") throw new Error("outer evidence boundary delivery is dead");
  if (row.state === "ACKED" || row.delivered_at) return { kind: "delivered", row };
  return { kind: "pending", row };
}
```

Foreign/stale rows never count. A current execution replacement yields a different expected tuple and therefore a new instruction.

- [ ] **Step 4: Run the concrete lib test GREEN**

```bash
node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs
```

Expected: all tests in that single file pass.

- [ ] **Step 5: Commit the pure contract**

```bash
git add scripts/lib/qa-generalized-e2e-lib.mjs \
  scripts/__tests__/qa-generalized-e2e-lib.test.mjs
git commit -m "feat(FLY-2922): define outer 529 evidence boundary"
```

## 5. Task 3 — Wire the Real Driver

### Files

- Modify: `scripts/qa-529-generalized-e2e.mjs`
- Test: `scripts/__tests__/qa-529-generalized-outer-evidence.test.mjs`
- Test: `scripts/__tests__/test-deploy-generalized.test.sh`

- [ ] **Step 1: Parse an explicit real-only flag**

Extend args with `outerEvidenceBoundary: false`; set true on `--outer-evidence-boundary`; after parsing reject it unless `runnerMode === "real"`. Update help with one sentence saying it is an evidence-owner boundary, not PASS.

- [ ] **Step 2: Implement send-or-reuse with exact recipient proof**

Add `ensureOuterEvidenceBoundary(context, qaNode, attempt)` in the driver. It must:

1. rebuild the current tuple from StateStore;
2. query slot `mailbox` read-only for exact `from_agent`, `to_agent`, `type='instruction'`, and deterministic content;
3. reuse one exact row, reject more than one;
4. if missing, call existing `runComm(... ["send", "--from", room.agentId, "--to", executionId, "--json", content])`;
5. parse JSON and require `resolved_to === executionId`;
6. persist `{tuple,instructionId}` to `owner.outerEvidenceBoundaries` immediately;
7. poll `message-status <id> --json` until `delivered_at` or `state==='ACKED'`; reject DEAD/torn/absent after send or timeout.

Do not mark the instruction consumed and do not synthesize the inner QA's DONE report.

- [ ] **Step 3: Place the boundary before each QA verdict wait**

For QA attempt 1 and attempt 2, resolve current execution first, then:

```js
if (context.outerEvidenceBoundary) {
  await ensureOuterEvidenceBoundary(context, qaNode, qaAttempt);
}
```

Only after this returns may the driver wait for that attempt's normal QA outcome. If a dead-exec replacement changes `execution_id`, loop back and bind the new execution; never reuse the old instruction as authority.

- [ ] **Step 4: Preserve evidence semantics**

Write a step attachment such as `qa-outer-evidence-boundary-attempt-<n>.json` containing only tuple, instruction id, delivery state and timestamps. Do not change step numbers 1–9, `qa-result`, founder approval, land, or final evidence recording logic. The driver exit code remains non-zero on any boundary failure.

- [ ] **Step 5: Run focused tests GREEN**

```bash
node --test scripts/__tests__/qa-529-generalized-outer-evidence.test.mjs
node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs
bash scripts/__tests__/test-deploy-generalized.test.sh
```

Expected: disabled trace stops at the modeled recursive wait; enabled trace reaches steps 1–9; every negative guard fails closed; existing generalized shell assertions remain green.

- [ ] **Step 6: Commit driver wiring**

```bash
git add scripts/qa-529-generalized-e2e.mjs \
  scripts/__tests__/qa-529-generalized-outer-evidence.test.mjs \
  scripts/__tests__/test-deploy-generalized.test.sh
git commit -m "fix(FLY-2922): bound nested QA evidence to outer driver"
```

## 6. Task 4 — Document the Operator Contract

### Files

- Modify if present: `doc/qa/framework/529-room-playbook.md`

- [ ] **Step 1: Add the exact real-room invocation**

Document:

```bash
node scripts/qa-529-generalized-e2e.mjs <slot> \
  --issue FLY-2922 \
  --real \
  --outer-evidence-boundary
```

State plainly: the flag is valid only for an outer generalized real campaign; inner QA still verifies and emits `qa-result`; only the outer QA/operator records final strength-two evidence after successful driver exit.

- [ ] **Step 2: Document failure diagnostics**

List instruction id, exact tuple, `message-status`, QA execution replacement, step trace and evidence directory as required diagnostics. Never print token or submission credential.

- [ ] **Step 3: Commit docs**

```bash
git add doc/qa/framework/529-room-playbook.md
git commit -m "docs(FLY-2922): explain outer 529 evidence ownership"
```

If the playbook path is absent on the exact implementation head, record that fact and do not create a duplicate guide elsewhere.

## 7. Task 5 — Targeted Verification and Review

- [ ] **Step 1: Re-run discovery after the literal change**

```bash
git grep -lF -- '--outer-evidence-boundary'
git grep -lF -- '[qa529-outer-evidence-boundary/v1]'
git diff --name-only origin/main...HEAD
```

Compare against the pre-change inventory. Record all excluded test matches and why they do not exercise the changed harness.

- [ ] **Step 2: Run retained tests one concrete file at a time**

```bash
node --test scripts/__tests__/qa-529-generalized-outer-evidence.test.mjs
node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs
bash scripts/__tests__/test-deploy-generalized.test.sh
```

Do not invoke bare `vitest`, package test aliases, directories, globs, full repository suites, or `vitest related` across teamlead.

- [ ] **Step 3: Run lint and affected build**

```bash
pnpm lint
pnpm --filter "flywheel-teamlead..." build
```

Expected: both exit 0. This is not full-suite evidence.

- [ ] **Step 4: Verify no product-code drift**

```bash
git diff --name-only origin/main...HEAD | rg -v '^(scripts/qa-529-generalized-e2e\.mjs|scripts/lib/qa-generalized-e2e-lib\.mjs|scripts/__tests__/qa-529-generalized-outer-evidence\.test\.mjs|scripts/__tests__/qa-generalized-e2e-lib\.test\.mjs|scripts/__tests__/test-deploy-generalized\.test\.sh|doc/qa/framework/529-room-playbook\.md|engineering/doc/FLY-2922-unified-node-recovery/)'
```

Expected: no output. Existing pre-task product files already on the branch are compared separately; the new commits themselves must remain harness/docs-only.

- [ ] **Step 5: Push and request exact-head code review**

Push normally, never `--no-verify` or force-push. Register a new code review gate/request bound to the pushed exact head, fix blocking findings only, and require effective APPROVED before completion.

- [ ] **Step 6: Hand off to QA**

Run the injected completion route `complete --route needs_review --pr 1374` only after exact-head review APPROVED. QA then runs a fresh room with two real Leads and the new flag; required evidence is all driver steps, held → unified recovery → new dispatch, dispatch ledger proof, exact-head CI, mergeable state and final outer strength-two receipt.

## 8. Rollback and Tradeoffs

Rollback is one harness commit revert: removing the CLI flag and boundary send restores byte-compatible prior behavior, including the known recursive wait. No database migration, production config, state vocabulary or product rollback is involved.

Rejected hybrid QA-only stub remains a fallback only if a future QA proves mailbox delivery cannot wake the real inner QA. It is not implemented now because it weakens the exact behavior this campaign needs to observe and expands mixed-runner deployment state.

## 9. Acceptance Matrix

| Requirement | Proof |
|---|---|
| 无开关仍可复现递归等待 | focused harness test stops at step 3/QA verdict boundary with zero invented evidence |
| 有开关 driver 完整结束 | focused scenario traces 1–9; fresh real room exits 0 |
| 房内 QA 仍是真 Runner | real room actor/session evidence and normal `qa-result`; no QA stub process |
| 生产 QA 规则不变 | forbidden-file diff guard; no role/judge/evidence-route changes |
| 边界不等于 PASS | message text + negative tests + no final evidence before step 9 |
| replacement 安全 | attempt/execution-specific messages; stale execution negative test |
| 真正验证 FLY-2922 | fresh room shows held → unified recovery → new dispatch and dispatch ledger receipt |
| 回归受控 | three concrete related tests, lint, affected build, exact-head CI |

## 10. Follow-ups Not in This Change

- 不把 outer-evidence 概念推广成通用生产 flag。
- 不重写 QA role 的 529 ownership 规则。
- 不增加 mixed real/stub node selection。
- 不把之前 INCONCLUSIVE campaign 追认成 PASS；必须在新 exact head 上重跑。
