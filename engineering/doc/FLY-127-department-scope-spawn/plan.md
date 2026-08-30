# FLY-127 部门范围启动守卫 — 实施计划
Issue: FLY-127 (https://linear.app/geoforge3d/issue/FLY-127/lead-spawns-runner-for-tasks-not-assigned-to-its-department)
日期: 2026-08-30
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task in the current implementation node. Do not dispatch subagents; the injected DAG role requires inline execution.

**Goal:** Preserve the existing FLY-127 department-scope hard guard and add direct executable evidence that one Ops-labelled issue can dispatch only through Oliver/`ops-lead`, never Peter/`product-lead`.

**Architecture:** The production boundary remains `runs-route.ts` → `DepartmentRegistry.isLeadInScope()` → `StartDispatcher.start()`. The only code delta is a paired route-level regression in the existing TeamLead e2e suite. Existing Lead rule injection and runtime code are verification targets, not rewrite targets.

**Tech Stack:** TypeScript, Express, Vitest, pnpm monorepo, Flywheel Lead rule Markdown.

---

## File map

| Path | Responsibility | Planned action |
|---|---|---|
| `packages/teamlead/src/__tests__/start-e2e.test.ts` | HTTP `/api/runs/start` integration coverage with mocked Linear and dispatcher | Add one paired Peter-reject/Oliver-allow acceptance test |
| `packages/teamlead/src/department-registry.ts` | Canonical department classification and spawn authorization | Read/verify only; modify only if the new test exposes a real defect |
| `packages/teamlead/src/bridge/runs-route.ts` | Enforce authorization before dispatcher start | Read/verify only; modify only after a failing regression proves a defect |
| `packages/teamlead/lead-rules-base/department-lead-rules.md` | Lead-side passive mismatch silence and Bridge reject handling | Read/verify only |
| `packages/teamlead/scripts/claude-lead.sh` | Inject rules into department Leads | Read/verify only |
| `engineering/doc/FLY-127-department-scope-spawn/{exploration,research,plan,progress}.md` | Durable process and restart cursor | Create/update before implementation |
| `engineering/doc/milestones/FLY-127.md` | Founder-facing merged-doc summary | Create as the literal final commit |

### Task 1: Add the exact acceptance regression

**Files:**

- Modify: `packages/teamlead/src/__tests__/start-e2e.test.ts` inside `describe("FLY-127 — department scope reject")`
- Test: `packages/teamlead/src/__tests__/start-e2e.test.ts`

- [ ] **Step 1: Confirm the baseline focused suite is green**

Run:

```bash
pnpm --filter flywheel-teamlead test:run -- src/__tests__/start-e2e.test.ts
```

Expected: the existing FLY-127 Peter-reject and Oliver-allow cases pass. Record this as proof that the runtime behavior predates this PR.

- [ ] **Step 2: Add the paired regression test**

Insert this test after the existing `label_mismatch` case:

```ts
it("Oliver-only issue: Peter is rejected and only Oliver reaches dispatch", async () => {
	await mockIssueLabels(["Ops"]);
	const peterResponse = await fetch(`${baseUrl}/api/runs/start`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			issueId: "GEO-FLY127-OLIVER-ONLY",
			projectName: "TestProject",
			leadId: "product-lead",
		}),
	});

	expect(peterResponse.status).toBe(403);
	expect(await peterResponse.json()).toMatchObject({
		success: false,
		code: "DEPT_SCOPE_REJECT",
		reason: "label_mismatch",
		canonicalLeadId: "ops-lead",
	});
	expect(mockDispatcher.start).not.toHaveBeenCalled();

	await mockIssueLabels(["Ops"]);
	const oliverResponse = await fetch(`${baseUrl}/api/runs/start`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			issueId: "GEO-FLY127-OLIVER-ONLY",
			projectName: "TestProject",
			leadId: "ops-lead",
		}),
	});

	expect(oliverResponse.status).toBe(200);
	expect(mockDispatcher.start).toHaveBeenCalledOnce();
	expect(mockDispatcher.start.mock.calls[0]?.[0]).toMatchObject({
		issueId: "GEO-FLY127-OLIVER-ONLY",
		leadId: "ops-lead",
		owningDept: "ops",
	});
}, 15_000);
```

This is a characterization/regression addition for behavior already present in the audited baseline, so its first run is expected to be green. Do not manufacture a runtime failure. If it fails, preserve that genuine RED output, use `superpowers:systematic-debugging` to isolate the cause, make the smallest production fix, and rerun to GREEN.

- [ ] **Step 3: Run the focused test**

Run:

```bash
pnpm --filter flywheel-teamlead test:run -- src/__tests__/start-e2e.test.ts
```

Expected: PASS, including `Oliver-only issue: Peter is rejected and only Oliver reaches dispatch`.

- [ ] **Step 4: Commit the regression**

```bash
git add packages/teamlead/src/__tests__/start-e2e.test.ts
git commit -m "test(FLY-127): prove only owning Lead dispatches"
```

### Task 2: Verify all locked acceptance surfaces

**Files:**

- Test: `packages/teamlead/src/__tests__/department-registry.test.ts`
- Test: `packages/teamlead/src/__tests__/lead-rules-bundle.test.ts`
- Test: `packages/teamlead/src/__tests__/start-e2e.test.ts`
- Verify: `packages/teamlead/lead-rules-base/department-lead-rules.md`
- Verify: `packages/teamlead/scripts/claude-lead.sh`

- [ ] **Step 1: Run the department authorization unit suite**

```bash
pnpm --filter flywheel-teamlead test:run -- src/__tests__/department-registry.test.ts
```

Expected: PASS for `label_mismatch`, exact-match `ok`, no-label, multi-label, unknown and cannot-spawn precedence.

- [ ] **Step 2: Run rule-bundle injection coverage**

```bash
pnpm --filter flywheel-teamlead test:run -- src/__tests__/lead-rules-bundle.test.ts
```

Expected: PASS; department Leads receive the base Action Gate and role ordering stays pinned.

- [ ] **Step 3: Run the launcher contract shell suite**

```bash
bash packages/teamlead/scripts/test-fly26-rules-split.sh
```

Expected: PASS, including FLY-127 base-before-project ordering assertions.

- [ ] **Step 4: Record restart-safe progress**

```bash
node "$FLYWHEEL_COMM_CLI" progress --exec-id b9541631-b28d-465a-aad0-aff162a115fd --file engineering/doc/FLY-127-department-scope-spawn/progress.md --phase implement --cursor 3/5 --set-chunk acceptance_regression=completed --next "Run full-repository verification"
```

Expected: progress ledger commit succeeds. If writer state still reports `status=terminated`, retain the exact error, continue safe verification, and check the outstanding Lead question before handoff.

### Task 3: Run full-repository gates

**Files:**

- Verify only: whole repository

- [ ] **Step 1: Check Lead inbox before the long gate batch**

```bash
node "$FLYWHEEL_COMM_CLI" inbox --exec-id b9541631-b28d-465a-aad0-aff162a115fd
```

- [ ] **Step 2: Run lint**

```bash
pnpm lint
```

Expected: exit 0.

- [ ] **Step 3: Run all package builds**

```bash
pnpm -r build
```

Expected: exit 0 for every package.

- [ ] **Step 4: Run all package tests**

```bash
pnpm test:packages:run
```

Expected: exit 0 and explicit execution of the TeamLead package suite.

- [ ] **Step 5: Discover and run every new shell test**

No new `scripts/__tests__/*.test.sh` file is planned. Confirm with:

```bash
git diff --name-only origin/main...HEAD -- 'scripts/__tests__/*.test.sh'
```

Expected: empty. If non-empty, run every listed file with `bash <path>` and require exit 0.

### Task 4: Code review and blocking-finding loop

**Files:**

- Review: `origin/main...HEAD`

- [ ] **Step 1: Enter code review and register the required gate**

```bash
node "$FLYWHEEL_COMM_CLI" stage set code_review
node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-test-2 --exec-id b9541631-b28d-465a-aad0-aff162a115fd --no-block "Code review requested for FLY-127"
```

Capture the returned `questionId`, then register the cross-family rescue review:

```bash
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id <captured-question-id>
```

- [ ] **Step 2: Poll the exact review handle**

```bash
node "$FLYWHEEL_COMM_CLI" check <captured-question-id>
```

Expected: `reviewVerdict=APPROVED`. Poll across turns while pending. On `CHANGES_REQUESTED`, read `findings`, apply only evidence-backed blocking fixes, rerun affected/full gates, push the new head, and open a new review gate with a new question id.

### Task 5: PR and bounded handoff

**Files:**

- Create last: `engineering/doc/milestones/FLY-127.md`

- [ ] **Step 1: Commit process docs before the milestone**

```bash
git add engineering/doc/FLY-127-department-scope-spawn
git commit -m "docs(FLY-127): record department spawn verification"
```

- [ ] **Step 2: Create the milestone document**

The file must summarize the existing three-layer implementation, the paired regression, focused/full gate evidence, and code-review verdict without claiming deployment or merge.

- [ ] **Step 3: Make the milestone the literal last commit**

```bash
git add engineering/doc/milestones/FLY-127.md
git commit -m "docs(FLY-127): record implementation milestone"
```

Do not commit anything after this point.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin project-slot-2-FLY-127
gh pr create --base main --head project-slot-2-FLY-127 --title "test(FLY-127): prove department-scoped Runner spawn" --body-file engineering/doc/FLY-127-department-scope-spawn/research.md
```

- [ ] **Step 5: Report and complete the implementation node**

```bash
node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-test-2 --exec-id b9541631-b28d-465a-aad0-aff162a115fd --report "DONE: FLY-127 implementation node verified the existing department-scope hard guard and added the paired Peter-reject/Oliver-only-dispatch regression; full gates and code review passed; PR: <url>"
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr <number>
```

Do not dispatch QA, request ship approval, merge, deploy, or touch `CLAUDE.md`.

## Plan self-review

- Acceptance 1 maps to the audited `claude-lead.sh`, base rule file, route and registry paths.
- Acceptance 2 maps to existing server-side enforcement plus focused unit/route verification.
- Acceptance 3 maps directly to Task 1's paired same-issue test.
- Acceptance 4 maps to the existing runtime rule doc plus the new milestone; `CLAUDE.md` is intentionally excluded by the implementation-role hard rule.
- No production rewrite, new API, migration, secret, external input surface or rendered UI is introduced.
- No unresolved placeholders or unspecified implementation steps remain; review question ids and PR values are runtime-captured handles, not design ambiguity.
