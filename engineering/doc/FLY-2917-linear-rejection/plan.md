# FLY-2917 Linear rejection — 实施计划
Issue: FLY-2917 (https://linear.app/geoforge3d/issue/FLY-2917/病根bridge-崩溃-linear-sdk-的fetch-failed未被接住-unhandledrejection-把整个-bridge)
日期: 2026-09-25
基于: research.md

## Goal and locked scope

Eliminate the unnecessary project request and own the finalizer state request, preserve local fallback/fail-closed behavior, and add a narrow last-resort Linear transport rejection guard. No product redesign, schema/API changes, service restart, or broad exception swallowing. Execute with TDD after effective design approval.

## Task 1 — causal regression and minimal fixes

- [ ] Extend `packages/teamlead/src/__tests__/createFetchIssue.test.ts` with a fresh rejecting `project` getter, asserting zero project getter reads, preserved authoritative fields via synchronous projectId, and no unhandled rejection. Independently inject issue/labels fetch failures and assert StateStore fallback; cover absent projectId. Reproduce failure before editing production code.
- [ ] Add a real DirectEventSink + ChatThreadCreator scenario using the fallback output and mocked Discord HTTP responses, asserting canonical thread persistence and completed creation. Let the event loop advance to expose orphan rejection.
- [ ] Extend finalizer tests with a fresh rejecting `state` getter on first and pre-write second checks, asserting one read per check, `state_unreadable_fail_closed`, and no mutation; keep cancel/completed/abort tests.
- [ ] Fix `bridge/run-infra.ts` with `projectId: issue.projectId` and `bridge/linear-issue-finalizer.ts` with `const current = await issue.state`. Existing catch boundaries now own the only request. Re-run those targeted tests and commit.

## Task 2 — narrow process guard

- [ ] Add `packages/teamlead/src/bridge/linear-transport-rejection-guard.ts` and its `bridge/__tests__/linear-transport-rejection-guard.test.ts` (Vitest plus child processes; no new shell suite). Start with child-process expectations before production implementation: SDK response-less fetch failure and SDK network failure survive through a timer; plain Error(`Fetch failed`), SDK auth/input/unknown failures, non-Error rejection, and synchronous exceptions exit nonzero. SDK GraphQL errors remain fatal. Assert fixed diagnostic, no sensitive error payload in recoverable logs.
- [ ] Guard classification uses real pinned SDK classes, excludes GraphQL errors, accepts NetworkLinearError or response-less UnknownLinearError whose raw Error has exactly `fetch failed` ignoring case. Install one `unhandledRejection` listener; known transport errors log a fixed marker and return, other Error reasons are thrown unchanged, and non-Error reasons are wrapped with an explicit unhandled-rejection diagnostic before throwing. This changes the fatal monitor origin to uncaughtException; document it. Export installation with a disposer for testing.
- [ ] Import/install from `scripts/run-bridge.ts` via `../packages/teamlead/dist/bridge/linear-transport-rejection-guard.js` before `main()`, and from `packages/teamlead/src/index.ts` before its main call; keep `uncaughtExceptionMonitor` and normal fatal behavior. Verify startup wiring and the child-process tests, including the default `throw` mode and the documented strict-mode limitation. No process-global handler in library import side effects. The package-relative import is rewritten by po_compile_run_bridge and shares teamlead SDK resolution (including its nested v60 copy in payloads with root v64). Add a test using the SDK resolved from teamlead, extend existing run-bridge-isolation-boot.test.sh to exercise both source and compiled entry paths, and run package-onboard.test.sh (includes A3). No payload whitelist change or new shell inventory entry is needed.

## Task 3 — inventory, verification, review, handoff

- [ ] Complete the direct-await/fire-and-forget SDK inventory, tracing callers to rejection owners; add only proven same-class holes and failing tests. Specifically reproduce the starter abort window between its eager state getter and awaitUnlessAborted; if confirmed, make all three state reads lazy inside that helper. Inventory every rawRequest and lead-capability call, whose untyped failures intentionally remain outside the process guard. Record safe/excluded sites explicitly.
- [ ] Install locked dependencies and build `pnpm --filter "flywheel-teamlead..." build`; run `pnpm lint`. No exported type/API changes expected; if introduced, typecheck dependents.
- [ ] Discover consumers with `git grep -lF` for changed full paths, file names, and parent directories. Record all excluded matches; run retained direct tests and owning-package `vitest related <changed TS files> --run` with explicit excludes for unrelated files from the consumer audit. run-infra is a hub; do not expand this into its near-full-package transitive graph. Run the affected existing shell tests (package-onboard and run-bridge-isolation-boot); no new shell suite. No full local package/repo suites or full-CI request.
- [ ] Write verification evidence and update progress ledger. Add `engineering/doc/milestones/FLY-2917.md` as the literal last commit before opening the PR. Push feature branch; PR body includes the call inventory, tradeoffs, local artifacts, and scoped-CI results.
- [ ] Register injected code gate + request-review, obtain effective current-head APPROVED, fix blockers and re-review as needed. Report through `ask --report`, then `complete --route needs_review --pr <number>` and controller park as applicable.

## Acceptance boundaries

Tests prove the deterministic bug mechanism and fixed failure path, not unique attribution of the historical SDK-only stack or production rollout. QA owns frozen-head full CI. Scoped CI and review do not authorize shipping.

## Design review revision

Round 1 request `0e7e5eab-c355-4875-a486-aeb110ea6eb5` returned CHANGES_REQUESTED for `packaged-bridge-guard-path`. Verified package-onboard.sh:278-313 and dependency-union-exceptions.tsv:21. Revised guard location, imports, SDK identity testing, and compiled boot coverage above. Also incorporated synchronous projectId, explicit rawRequest coverage limits, both entrypoints, non-Error diagnostic, empty errors-array tests, and scoped related-test execution. No SDK upgrade or unrelated packaging change.

## Lead-authorized QA rework (2026-09-26)

The current re-dispatch supersedes Task 2's narrow/fatal policy: all unhandled
Promise rejections must log a stack and source marker and preserve process
liveness, including strict rejection mode. Synchronous uncaught exceptions
remain fatal. Keep the existing entrypoint/module wiring. This is execution of
the explicit three-item repair, not a product redesign or a new design gate.

1. Reproduce FLY-1560 residue; replace the child timeout diagnostic wording
   without weakening the enforcement test.
2. Reproduce record-body timeout in a child without the global guard. Own
   rejected reader cancellation at its source and preserve timeout/failure
   outcomes, including the body-size cleanup branch.
3. Update guard child tests before replacing the narrow classification. Verify
   arbitrary Error/non-Error/AbortError/SDK rejections, stacks/source markers,
   strict/default modes, synchronous fatal behavior, and listener disposal.
4. Run lint, affected build, bounded related/direct tests, and wiring tests.
   Update PR inventory/tradeoffs, push, request effective code review for the
   final head, and complete needs_review. QA owns frozen-head full CI.
