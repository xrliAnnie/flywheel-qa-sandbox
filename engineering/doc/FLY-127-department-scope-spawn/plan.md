# FLY-127 部门范围启动守卫 — 实施计划
Issue: FLY-127 (https://linear.app/geoforge3d/issue/FLY-127/lead-spawns-runner-for-tasks-not-assigned-to-its-department)
日期: 2026-08-30
基于: research.md

> **For agentic workers:** Use `superpowers:executing-plans`, `superpowers:test-driven-development`, and `superpowers:systematic-debugging` as needed. Execute inline; this DAG node must not dispatch subagents or successor nodes.

**Goal:** Close the `leadId`-omission authorization bypass so an Oliver-only Ops issue can never reach initial Runner dispatch through Peter or an identity-less built-in caller.

**Architecture:** The protected boundary is the public, Lead-triggered `POST /api/runs/start` admission path. Scope enforcement requires an explicit caller `leadId` before legacy owner auto-resolution, then uses `DepartmentRegistry.isLeadInScope()` before `StartDispatcher.start()`. Trusted non-Claude callers attach identity from their server-side/session configuration. Internal retry, phase handoff, and auto-QA continue from an already admitted session and are not claimed as registry callers.

**Tech Stack:** TypeScript, Express, Vitest, Bash, jq, pnpm monorepo, Flywheel Lead rule Markdown.

---

## Locked acceptance criteria

1. Identify where Lead decides to spawn Runner (handler in claude-lead.sh / department-lead-rules.md).
2. Add scope check: department mismatch → don't spawn.
3. Verify with: Annie addresses Oliver-only issue → only Oliver spawns Runner.
4. Update CLAUDE.md / docs with department-scope-spawn rule.

Criterion 4 uses the allowed docs path: update `department-lead-rules.md` and the FLY-127 milestone; do not touch `CLAUDE.md` per the implementation-node hard rule.

## File map

| Path | Planned responsibility |
|---|---|
| `packages/teamlead/src/bridge/runs-route.ts` | Validate caller identity and fail closed before Linear/admission/dispatch when enforcement is on; retain flag-off auto-resolve rollback |
| `packages/teamlead/src/__tests__/start-e2e.test.ts` | RED/GREEN for omitted, blank, wrong-type and rollback identities; paired Peter-reject/Oliver-allow acceptance |
| `packages/gemini-agent/src/tools/registry.ts` | Attach binding-owned `projectName` and `leadId` to `dispatch_runner`, overriding raw args |
| `packages/gemini-agent/src/tools/schemas.ts` | Remove `projectName` from the model-facing dispatch identity surface |
| `packages/gemini-agent/src/__tests__/registry.test.ts` | RED/GREEN for binding override and schema contract |
| `scripts/inject-linear-issue.sh` | Read slot `botName` as Lead id and build escaped start JSON with jq |
| `scripts/__tests__/inject-linear-issue-lead-id.test.sh` | Hermetic curl-capture proof that the QA helper sends the configured Lead id |
| `packages/teamlead/lead-rules-base/department-lead-rules.md` | Require own `leadId`; document missing-identity response and no-retry behavior |
| `packages/teamlead/src/__tests__/lead-rules-bundle.test.ts` | Assert the identity requirement survives runtime rule bundling |
| `engineering/doc/FLY-127-department-scope-spawn/*` | Durable research, approved plan and progress |
| `engineering/doc/milestones/FLY-127.md` | Literal final commit with delivery evidence |

### Task 0: Resolve the known baseline gate exception

- [ ] Register a non-blocking Lead question with the exact baseline evidence: on the docs-only pre-change HEAD, `pnpm test:packages:run` fails only the 2 real-osascript tests in `packages/core/test/tmux-viewer.macos.test.ts` because the managed runner has no usable Terminal Apple Events session. Capture its question id.
- [ ] Continue independent work while polling. No FLY-127 PR completion may claim the exact full gate passed; final evidence must report its actual exit code and prove no new failure. A Lead response is required to waive only those two unchanged baseline failures.
- [ ] Keep the existing writer-state question `2b9dafc0-2400-4e07-a161-873181aa15b1` open and continue manual `progress.md` updates if `flywheel-comm progress` still refuses the active TURN.

### Task 1: Require caller identity at `/api/runs/start` (strict TDD)

**Files:** `packages/teamlead/src/__tests__/start-e2e.test.ts`, `packages/teamlead/src/bridge/runs-route.ts`

- [ ] **RED 1 — omitted identity.** Change the existing omission test to expect `403 DEPT_SCOPE_REJECT`, reason `lead_identity_required`, `canonicalLeadId:null`, no Linear client call, and no dispatcher call. Run only this test:

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/start-e2e.test.ts -t "requires explicit Lead identity"
```

Expected RED on baseline: actual status 200 and dispatcher called.

- [ ] **GREEN 1 — minimum presence guard.** After `issueId`/`projectName` validation and canonical project resolution, compute the enforcement flag once. If enforcement is on and `leadId` is missing/null/empty, return the stable machine-only reject payload before admission and Linear hydration. Keep FLY-80 auto-resolve only inside the flag-off path. Rerun the one test to GREEN.

- [ ] **RED/GREEN 2 — whitespace identity.** Add one test for all-whitespace `leadId`; verify RED, then extend the presence guard with `trim().length === 0` and verify GREEN. Do not trim or rewrite valid ids.

- [ ] **RED/GREEN 3 — wrong type.** Add one test for a numeric `leadId` expecting `400 {code:"INVALID_LEAD_ID", reason:"wrong_type"}` and zero downstream calls; verify RED, implement explicit type validation, verify GREEN.

- [ ] **Rollback guard.** Add/adjust the flag-off test so omitted `leadId` still auto-resolves the Ops owner and returns 200. This characterizes the pre-existing rollback path; it should be green after the minimum implementation.

- [ ] **Acceptance pair.** Add one same-issue scenario: mock Ops labels twice; Peter/`product-lead` gets `403 label_mismatch`; Oliver/`ops-lead` gets 200; the only dispatcher call carries `leadId:"ops-lead"` and `owningDept:"ops"`.

- [ ] Run the complete route file with the correct focused command (not the package script passthrough that expands to the entire suite):

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/start-e2e.test.ts
```

- [ ] Commit only this batch: `fix(FLY-127): require Lead identity for Runner start`.

### Task 2: Bind Gemini dispatch identity (strict TDD)

**Files:** `packages/gemini-agent/src/__tests__/registry.test.ts`, `packages/gemini-agent/src/tools/registry.ts`, `packages/gemini-agent/src/tools/schemas.ts`

- [ ] **RED/GREEN 1.** Replace the old “deptLabel never leaks” dispatch assertion with a test that passes spoofed raw `projectName`/`leadId` and expects the outbound body to contain the session binding values plus allowed dispatch args. Run:

```bash
pnpm --filter flywheel-gemini-agent exec vitest run src/__tests__/registry.test.ts -t "dispatch_runner binds"
```

Expected RED: current body is raw args. Implement `{...args, projectName: binding.projectName, leadId: binding.leadId}` with binding fields last; rerun GREEN.

- [ ] **RED/GREEN 2.** Add a schema test expecting `dispatch_runner` to omit model-facing `projectName` and require only `issueId`. Verify RED; remove the property/required entry and update the description to say project/Lead identity is session-bound; verify GREEN.

- [ ] Run the complete registry file, then commit: `fix(FLY-127): bind Gemini Runner dispatch identity`.

### Task 3: Make the QA injection caller explicit (strict TDD)

**Files:** `scripts/__tests__/inject-linear-issue-lead-id.test.sh`, `scripts/inject-linear-issue.sh`

- [ ] **RED.** Add a hermetic shell test with temporary `HOME`, a sparse test-slot config, a stubbed healthy/POST curl, and a curl payload capture. It must assert `.leadId == .slots[slot-1].botName` and verify issue/project/role remain valid JSON. Refuse to reuse a pre-existing fixed `/tmp/flywheel-test-slot-<N>` fixture and clean only the directory created by the test.
- [ ] Run `bash scripts/__tests__/inject-linear-issue-lead-id.test.sh`; expected RED because the current payload has no `leadId`.
- [ ] **GREEN.** In the script, read and validate `LEAD_ID` from the same slot `botName` source as `test-deploy.sh`. Construct `START_PAYLOAD` with `jq -nc --arg` for issue, project, role, and lead id; pass that value to curl. Rerun the shell test GREEN.
- [ ] Commit: `fix(FLY-127): identify test-slot Runner injections`.

### Task 4: Pin the Lead transport rule (strict TDD)

**Files:** `packages/teamlead/src/__tests__/lead-rules-bundle.test.ts`, `packages/teamlead/lead-rules-base/department-lead-rules.md`

- [ ] **RED.** Add a bundle assertion requiring the rendered department rules to say every `/api/runs/start` call carries the current Lead's own non-empty `leadId` and may not substitute another/canonical Lead. Run:

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/lead-rules-bundle.test.ts -t "own leadId"
```

- [ ] **GREEN.** Add the explicit transport rule next to Action Gate step 4 and add `lead_identity_required` to the diagnostic table. Preserve passive cross-department silence and no-retry semantics. Rerun the one test, then the full bundle file.
- [ ] Commit: `docs(FLY-127): require scoped Lead identity on spawn`.

### Task 5: Affected-surface and full-repository verification

- [ ] Check the Lead inbox and poll both open question ids before the long batch.
- [ ] Run affected suites:

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/start-e2e.test.ts src/__tests__/department-registry.test.ts src/__tests__/lead-rules-bundle.test.ts
pnpm --filter flywheel-gemini-agent exec vitest run src/__tests__/registry.test.ts
pnpm --filter flywheel-teamlead test:run
pnpm --filter flywheel-gemini-agent test:run
bash scripts/__tests__/inject-linear-issue-lead-id.test.sh
```

- [ ] Run the exact repository gates:

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

`lint` and build must exit 0. The package gate must be recorded verbatim: exit 0 is ideal; otherwise its failure set must be exactly the two pre-registered baseline macOS tests, with no FLY-127 or additional failure, and the Lead waiver must be approved.

- [ ] Discover every new shell test across root and package test directories, then run each result:

```bash
git diff --name-only origin/main...HEAD -- 'scripts/__tests__/*.test.sh' 'packages/*/scripts/__tests__/*.test.sh' 'packages/*/__tests__/*.test.sh'
```

- [ ] Update durable progress after each meaningful batch with the required `flywheel-comm progress` command. If writer state remains inconsistent, preserve exact CLI output and commit the manual ledger update without representing the transport as successful.

### Task 6: Code review loop

- [ ] Read/use `superpowers:verification-before-completion` and `superpowers:requesting-code-review` before making any completion claim.
- [ ] Enter `code_review`, open a new `review_code` gate with the required positional message, and register it using `request-review --type code --question-id <id>` (the cross-family rescue path; never raw `codex exec`).
- [ ] Poll the exact id. `APPROVED` permits continuation; report advisories to the Lead. On `CHANGES_REQUESTED`, verify each blocking finding, fix with TDD, rerun affected/full gates, commit/push, and request a fresh gate with a new id.

### Task 7: PR and bounded handoff

- [ ] Check inbox, ensure all code/process-doc commits precede the milestone, and ensure `CLAUDE.md` is unchanged.
- [ ] Create `engineering/doc/milestones/FLY-127.md` with implementation, RED/GREEN, exact gate, baseline-waiver, and review evidence. Commit it as the literal last commit: `docs(FLY-127): record implementation milestone`. Make no later commit.
- [ ] Push normally (never `--no-verify`, never force without explicit Lead ACK).
- [ ] Open a PR with a purpose-built body containing `## Summary`, `## Test plan`, and `Linear Issue: FLY-127`; do not use `research.md` as the PR body.
- [ ] Report the self-contained result through `ask --report`, including PR URL, commit shas, exact package-gate status/waiver, review verdict, and the residual shared-token/per-Lead-auth follow-up concern.
- [ ] Run `complete --route needs_review --pr <number>`, then park/end only this implementation turn. Do not dispatch QA, request ship approval, merge, deploy, or modify the shared branch after the milestone.

## Plan self-review

- Every behavior change has an isolated failing test before its minimum fix.
- External identity input is validated; shell JSON uses jq escaping; no query, HTML, migration, secret, or rendered surface is introduced.
- The plan no longer calls the registry the sole lifecycle boundary and does not hide the omitted-identity bypass.
- Focused Vitest commands use `pnpm --filter <pkg> exec vitest run <file>` so they do not accidentally expand to the full package suite.
- The exact repository test gate is mandatory and its known baseline failure requires explicit, narrowly scoped governance rather than a false green claim.
