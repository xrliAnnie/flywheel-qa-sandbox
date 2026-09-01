# FLY-127 部门范围启动守卫 — 实施计划
Issue: FLY-127 (https://linear.app/geoforge3d/issue/FLY-127/lead-spawns-runner-for-tasks-not-assigned-to-its-department)
日期: 2026-08-30
基于: research.md

> **For agentic workers:** Use `superpowers:executing-plans`, `superpowers:test-driven-development`, and `superpowers:systematic-debugging` as needed. Execute inline; this DAG node must not dispatch subagents or successor nodes.

**Goal:** Close the `leadId`-omission authorization bypass so an Oliver-only Ops issue can never reach initial Runner dispatch through Peter or an identity-less built-in caller.

**Architecture:** Protect public, Lead-triggered `POST /api/runs/start`. Validate malformed identity at the input boundary; preserve existing omission failure precedence through Linear preflight; then require a nonblank caller identity immediately before legacy owner auto-resolution. Trusted non-Claude callers attach identity from server/session config. Retry, phase handoff and auto-QA continue existing sessions and are out of this initial-admission change.

**Tech Stack:** TypeScript, Express, Vitest, Bash, jq, pnpm monorepo, Flywheel Lead rule Markdown.

---

## Locked acceptance criteria

1. Identify where Lead decides to spawn Runner (`claude-lead.sh` loads `department-lead-rules.md`; `runs-route.ts` is the server admission boundary).
2. Department mismatch does not spawn.
3. One Oliver-only issue yields Peter 403, Oliver 200, and exactly one Ops dispatcher call.
4. Update rule docs and milestone; do not touch `CLAUDE.md` per the implementation-node hard rule.

## File map

| Path | Planned responsibility |
|---|---|
| `packages/teamlead/src/bridge/runs-route.ts` | Validate type; require nonblank identity before auto-resolve; retain flag-off rollback |
| `packages/teamlead/src/__tests__/start-e2e.test.ts` | RED/GREEN identity, precedence, rollback, caller migration, paired acceptance |
| `packages/teamlead/src/bridge/__tests__/runs-route.stale-blocker.test.ts` | Make the helper an explicit Lead caller |
| `packages/gemini-agent/src/tools/{registry,schemas}.ts` | Bind identity; remove model-owned project identity |
| `packages/gemini-agent/src/__tests__/{registry.test,fixtures/mock-bridge}.ts` | Binding/no-leak/schema assertions and realistic 403 fixture |
| `scripts/inject-linear-issue.sh` | Slot Lead identity, jq-safe payload, explicit scope-reject diagnostic |
| `scripts/__tests__/inject-linear-issue-lead-id.test.sh` | Hermetic payload and 403 branch proof |
| `packages/teamlead/src/__tests__/fly247-bash-suites.test.ts` | Register the new shell suite in CI |
| `packages/teamlead/lead-rules-base/{department-lead-rules,doc-flow-rules}.md` | Own-identity rule, no-retry diagnostic, corrected example |
| `packages/teamlead/src/__tests__/lead-rules-bundle.test.ts` | Assert identity requirement survives bundling |
| `engineering/doc/FLY-127-department-scope-spawn/*` | Durable design/progress evidence |
| `engineering/doc/milestones/FLY-127.md` | Literal final commit with delivery evidence and residual follow-up |

### Task 0: Resolve baseline governance and keep design pinned

- [ ] Treat old waiver question `61b39bc0-f774-4d1d-8f39-aff33aca5a5a` as retracted. Poll replacement `64213dc8-a8a7-4ac0-bbd8-5c8dd4107e4b`: changed/focused tests + lint/build green, exact full commands recorded honestly, local TeamLead full-suite environmental results non-authoritative, Linux CI required before merge.
- [ ] Keep writer-state question `2b9dafc0-2400-4e07-a161-873181aa15b1` open; attempt the mandated progress CLI after batches and preserve manual ledger commits if it still refuses the active TURN.
- [ ] Re-run the configured-project literal audit before code review. Default-on release is blocked by any complete start literal that omits `leadId`; rollback remains flag off + Bridge restart.

### Task 1: Require identity at `/api/runs/start` (strict TDD)

**Files:** route, start e2e, stale-blocker test.

- [ ] **RED — omission contract.** Change the existing omission test to “requires explicit Lead identity” and expect 403 `DEPT_SCOPE_REJECT`, `lead_identity_required`, `canonicalLeadId:null`, `silent:false`, no `message`, no dispatcher. Because the guard intentionally follows Linear preflight, assert the Linear issue/labels call occurred.
- [ ] **GREEN — exact ordering.** After required issue/project validation, store `rawLeadId`. If present/non-null and not a string, return 400 `INVALID_LEAD_ID/wrong_type` before agent/doc/model validation. Define `hasLeadIdentity` as string with `trim().length > 0`, but retain the original nonblank string byte-for-byte. Use it for membership checks so whitespace is not mistaken for an id.
- [ ] Immediately after successful Linear issue/label hydration and before the existing FLY-80 `resolveLeadForIssue()` block: if scope enforcement is on and `hasLeadIdentity` is false, return the stable 403. If flag off, retain auto-resolution. Compute the flag once per request.
- [ ] **RED/GREEN input matrix.** Add null/empty/whitespace parameterized cases for the 403 and numeric/object cases for the early 400; prove zero dispatcher calls and exact response shape.
- [ ] **Precedence regression.** Preserve/add cases proving omission does not mask: no API key 503, invalid issue/project and existing field errors 400, active session 409, admission 429, Linear missing/failure 404/502. Explicitly state the intentional exception: non-string `leadId` is always the early 400.
- [ ] **Caller migration.** Add `leadId:"product-lead"` to every start-e2e request expected to reach a normal 200 path (docTier/model/project-case and base success cases); keep only omission, rollback, and precedence probes identity-less. Add `leadId` to the stale-blocker POST helper.
- [ ] **Rollback.** With `BRIDGE_DEPT_SCOPE_REJECT=off`, omitted/blank identity still auto-resolves Ops owner and returns 200.
- [ ] **Acceptance pair.** Mock the same Ops issue twice: Peter gets `label_mismatch`; Oliver returns 200; only dispatcher call has `leadId:"ops-lead"` and `owningDept:"ops"`.
- [ ] Run focused RED/GREEN commands, then full route files:

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/start-e2e.test.ts -t "requires explicit Lead identity"
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/start-e2e.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/runs-route.stale-blocker.test.ts
```

- [ ] Commit: `fix(FLY-127): require Lead identity for Runner start`.

### Task 2: Bind Gemini dispatch identity (strict TDD)

- [ ] **RED/GREEN binding.** Extend the existing dispatch test with spoofed raw `projectName/leadId`; expect binding-owned values in outbound body while retaining the explicit `deptLabel` absence invariant. Implement binding fields last.
- [ ] **RED/GREEN schema.** Expect `dispatch_runner` schema to omit `projectName` and require only `issueId`; update description to say project/Lead identity is session-bound.
- [ ] **RED/GREEN mock.** Add a mock-Bridge test/path for missing/blank identity → exact 403, while bound registry dispatch remains 200. This prevents integration fixtures from accepting a request production rejects.
- [ ] Run registry and full-stack/mocked-bridge affected tests; commit `fix(FLY-127): bind Gemini Runner dispatch identity`.

### Task 3: Make the QA injection caller explicit (strict TDD)

- [ ] **RED payload.** New hermetic shell test uses temporary HOME, owned slot fixture and curl capture. Assert `.leadId == slot.botName` plus valid issue/project/role JSON. Never reuse or delete a pre-existing fixed test-slot directory.
- [ ] **GREEN payload.** Read/validate `LEAD_ID` from slot `botName`; build `START_PAYLOAD` with `jq -nc --arg`; POST it.
- [ ] **RED/GREEN reject diagnostics.** Stub HTTP 403 with `DEPT_SCOPE_REJECT`; require stderr to show `code`, `reason`, `canonicalLeadId` and nonzero exit instead of generic “unexpected”.
- [ ] Register the shell test as a `runSuite()` case in `fly247-bash-suites.test.ts`, then run both direct Bash and the focused wrapper case.
- [ ] Commit `fix(FLY-127): identify test-slot Runner injections`.

### Task 4: Pin Lead transport rules (strict TDD)

- [ ] **RED.** Bundle assertions require every `/api/runs/start` call to carry the current Lead's own non-empty `leadId`, forbid canonical/other-Lead substitution, and require the doc-flow example to include identity.
- [ ] **GREEN.** Update `department-lead-rules.md` beside Action Gate step 4 and diagnostic table; update `doc-flow-rules.md` example. Preserve passive cross-department silence and no-retry semantics.
- [ ] Run focused and complete bundle tests; commit `docs(FLY-127): require scoped Lead identity on spawn`.

### Task 5: Verification and migration gate

- [ ] Check Lead inbox/poll open questions before long runs. Re-scan repo literals plus configured project roots; record no missing complete start callers.
- [ ] Run affected tests:

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/start-e2e.test.ts src/bridge/__tests__/runs-route.stale-blocker.test.ts src/__tests__/department-registry.test.ts src/__tests__/lead-rules-bundle.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly247-bash-suites.test.ts -t "inject-linear-issue"
pnpm --filter flywheel-gemini-agent exec vitest run src/__tests__/registry.test.ts src/__tests__/full-stack-integration.test.ts
bash scripts/__tests__/inject-linear-issue-lead-id.test.sh
pnpm --filter flywheel-teamlead test:run
pnpm --filter flywheel-gemini-agent test:run
```

- [ ] Run exact repository gates, recording exit/output truthfully:

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

Lint/build/changed tests must exit 0. Local full-suite variance follows Lead governance question `64213dc8-a8a7-4ac0-bbd8-5c8dd4107e4b`; it must never be reported as green if nonzero. PR handoff requires authoritative `ubuntu-latest` CI green before merge.

- [ ] Discover and run every new shell test:

```bash
git diff --name-only origin/main...HEAD -- 'scripts/__tests__/*.test.sh' 'packages/*/scripts/__tests__/*.test.sh' 'packages/*/__tests__/*.test.sh'
```

### Task 6: Code review loop

- [ ] Read/use verification-before-completion and requesting-code-review skills.
- [ ] Enter `code_review`; open a new `review_code` gate with positional message and register `request-review --type code`. Never raw `codex exec`.
- [ ] On CHANGES, verify/fix with TDD, rerun affected/full gates, commit/push and request a new gate. On APPROVED, report advisories.

### Task 7: PR and bounded handoff

- [ ] Check inbox; ensure `CLAUDE.md` unchanged. Record residual shared-token and unauthenticated dashboard `/actions/retry` + missing-identity `checkLeadScope()` issue in milestone/report; ask Lead for follow-up governance rather than silently expanding scope.
- [ ] Create `engineering/doc/milestones/FLY-127.md` as literal last commit with RED/GREEN, caller audit, exact gate outcomes, baseline governance, review and residual evidence. No later commits.
- [ ] Push normally; open PR with `## Summary`, `## Test plan`, `Linear Issue: FLY-127`.
- [ ] Report via `ask --report`; run `complete --route needs_review --pr <number>`; park/end this phase. Never dispatch QA, request ship approval, merge or deploy.

## Plan self-review

- Every behavior change has an isolated RED before GREEN.
- Default-on identity enforcement includes every known repository and configured-project caller migration.
- Guard location and response precedence are explicit; wrong-type early 400 is intentional.
- Shell JSON uses jq; 403 has executable negative coverage and CI wiring.
- Baseline evidence is honest and Linux CI is named as authoritative instead of inventing a local allowlist.
- The residual `/actions/retry` authentication gap is named without widening this issue.
