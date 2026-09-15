# FLY-2570 动态设计分流 — 实施记录
Issue: FLY-2570 (https://linear.app/geoforge3d/issue/FLY-2570)
日期: 2026-09-14
基于: plan.md

## Design gate

R3 effective APPROVED, gate c2175f62-c6a2-405f-9457-295fee6f8585, request b13bff6a-1f95-45be-867b-58887dc97f5b; nonblocking advisories sent to Lead (report a649e961-3a65-44e2-ba2d-bdfdf1cc5a7b).

## Task 1 — shared percentage policy

Implemented immutable percentage policy parsing and version derivation, frozen issue-number hash allocation, runtime and registry discriminated types/validation. V1 parser remains intact. New input version is ignored per approved design; receipts derive canonical content version.

TDD evidence:
- /tmp/fly2570-task1-red.log: 5 assertion failures rejecting valid percentage config, 5 negative tests passed.
- /tmp/fly2570-task1-all-red.log: 6 failed / 5 passed including absent allocator module.
- /tmp/fly2570-task1-green.log: 11 passed.
- /tmp/fly2570-task1-build.log: config build exit 0.
- /tmp/fly2570-task1-regression.log: 63 tests in 4 files passed (model-split, model-config, agent-registry, ConfigLoader.agent-registry).
- Golden bucket issue 2570 = 80.939447054086 independently computed using Python hashlib; endpoints tested over 10,000 issues with repeat determinism and 75% approximate population.

## Next

Task 2: menu hot-read fail-closed integration, discriminated persisted receipt, historical replay tests. Downstream consumers have not yet been adapted to the expanded policy union; whole-repo feature build/acceptance is NOT claimed. Tasks 3 operator/locking, 4 SQL history and 5 full verification/review/PR/handoff remain.

## Lead ruling after approval

Response a649e961-3a65-44e2-ba2d-bdfdf1cc5a7b requires this round: wider lock timeout with bounded retry and actionable explicit failure (choose 30s existing default, 50ms retry); clear missing-parent error; concrete corrupted-authority recovery commands in operator runbook. No silent success. Defer operator change audit, generic scope/parser changes, ignored-input-version behavior into follow-ups. PR must be non-draft; milestone literal last commit. Report completion of this instruction after those paths are implemented and verified.

## Task 2 — menu and frozen replay integration

- Scope gate selects current runtime split only for code.eng_design; bundled registry uniqueness regression guards its declaration. Existing implement/QA receipts unchanged across 0→100 update.
- Runtime malformed policy/file now throws MODEL_SPLIT_CONFIG_INVALID rather than silently disabling automatic assignment. Wrong override includes issue, saved-content version, bucket/threshold and expected arm/model.
- Percentage assignment persists percent, bucket and both arm mappings; replay reconstructs the frozen fly2570-v1 policy from stored receipt, validates issue/version/bucket/arm/alias against pinned model, and never consults current percentage. V1 compatibility retained.
- /tmp/fly2570-task2-menu-red.log: 3 failed, 9 passed. /tmp/fly2570-task2-menu-green.log: 12 passed.
- /tmp/fly2570-task2-replay-red.log: new reopen replay failed with workflow_dispatch_model_assignment_invalid (1 failed/8 passed), proving legacy-only guard.
- /tmp/fly2570-task2-regression.log: 54 passed, 2 pre-existing skipped across workflow-model-split, workflow-dispatch-resolution, workflow-template-selection. Real file-backed StateStore reopened after current ratio changed to 0; saved 100% Astra receipt still resolves Astra. Tampered bucket/version/arm/issue and duplicate receipt reject.
- /tmp/fly2570-task2-build.log: teamlead build exit 0. Focused Biome check clean.

Next: Task 3 operator set/show and shared recoverable authority lock, with Lead-required 30s budget and actionable missing-parent/corrupt-authority recovery. SQL version cohorts, full verification, review, non-draft PR and handoff still outstanding.

## Task 3 — resumed operator and shared lock

Resumed at ae570f9a1 with current implement TURN epoch 5. Audited the preserved WIP; kept the shared lock and Fable locked reread. Added strict full candidate validation, atomic 0600 set/show CLI, live/safe file checks, options validation and truthful legacy parity display. Minimal configuration created by set is now accepted by the Fable writer (absent models means empty overlay). Fable writes use the canonical path received from the lock wrapper.

Evidence (scratch files only):
- `/tmp/fly2570-task3-cli-red.log`: missing CLI assertion failure; `/tmp/fly2570-task3-parity-red.log`: constant-A legacy show returned 50 instead of 100.
- `/tmp/fly2570-task3-cli-green.log`: set/show 75/0/100/37.125/reset, modes/uid, preservation, corrupt/invalid inputs, duplicate options, symlink, missing parent, 30s live lock refusal and killed-holder automatic recovery PASS.
- `/tmp/fly2570-task3-sync.log`: preserved WIP's concurrency test failed retained vs updated because absent models was rejected. After fix the test uses the real set CLI inside the API probe.
- `/tmp/fly2570-task3-regression.log`: 40 passed across menu, Fable sync and existing shared mkdir-lock suite. Menu test now consumes actual CLI bytes and matches its version without resetting reader cache.
- `/tmp/fly2570-task3-busy.log`: 10 Fable sync tests passed including 30s bounded contention, retained/authority_busy, actionable error and unchanged bytes.
- `/tmp/fly2570-task3-rollback.log`: verification rollback followed by waiting real CLI writer passed (1 selected, 10 deselected).
- `/tmp/fly2570-task3-config-tests.log`: 38 passed; `/tmp/fly2570-task3-lock.log`: 3 wrapper tests pass including parent alias/absent target, missing parent, empty orphan 120s and EPERM holder protection. Existing lock suite covers PID reuse and replacement release protection.
- `/tmp/fly2570-task3-config-build.log`, `/tmp/fly2570-task3-build.log`: config and teamlead builds passed.

Added operator runbook with concrete corruption restore commands and 30s retry/missing-parent guidance per Lead instruction f31d55d1-86ff-4072-a4ce-9e8038720d96. No production mutation. Live Linear reread unavailable (no Linear connector or LINEAR_API_KEY); injected issue body and approved plan remain task evidence. SQL cohort work, CI registration, whole-repo gates, final review/PR and handoff remain.

## Task 4 — frozen report cohorts

Added optional rule_version filter over persisted assignment basis, requiring one unambiguous receipt per run/node, shared by its design executions. Unfiltered report and all existing attribution exclusions are byte-for-byte regression protected. The 3-Astra/1-Fable cohort yields review N=2/1, QA N=2/1, founder N=3/1, duration N=3/1, preserving different observation windows. Old v1 remains separately queryable; missing, duplicate and mixed-version assignments cannot contaminate it.

`/tmp/fly2570-task4-red.log` shows the old query ignoring version filtering and returning the entire cohort. `/tmp/fly2570-task4-green.log` passes original and version-filtered fixtures. Corrected new review total expectations to existing MAX(round/revision) semantics (6/7), not request-row count (3/2); production review semantics unchanged. `/tmp/fly2570-shell-enumeration.log` passes CI enumeration after registering the new operator shell suite.


Task 4 correction before review: current StateStore.createWorkflowRun writes the run/node assignment before an execution exists (`execution_id` NULL), and replay also keys by run/node. Changed positive fixtures to this actual persisted shape; `/tmp/fly2570-task4-run-receipt-red.log` proves the initial execution-key join wrongly excluded all real-shaped records. The corrected filter groups by run and requires exactly one immutable design-node assignment, preserving existing multi-execution model contamination rules. No production persistence format changed.

## Code review R2 corrective work

Gate d14d923e-845b-4586-9f23-e4c3ee2e91e5 returned effective CHANGES_REQUESTED, request 5d185b9a-172c-48b0-9251-cc9565acee7d, reviewed head 59195965305e39bb29c6e949435e3bad2f25689a. R1 was invalidated by HEAD movement; keep the next reviewed HEAD frozen through its verdict.

- HIGH `statestore-rejects-percentage-assignment`: actual materializeWorkflowRun still rejected percentage despite menu/replay tests passing. `/tmp/fly2570-review-admission-red.log` proves 0/75/100 real selection failures. StateStore now accepts only validated percentage receipts using the same pure frozen-basis validator as dispatch replay. The v1 parity branch remains unchanged. Real file-backed stores admit CLI-produced 0/75/100, persist the run/node receipt, and dispatch its model. Tampering bucket, version, arm, modelAlias, issue number or identifier fails before persistence.
- MEDIUM `idempotent-start-replay-breaks-after-ratio-change`: this overlaps the approved frozen-assignment requirement. `/tmp/fly2570-review-idempotency-red.log` proves changed-ratio retries rejected the original key. Existing reservations now reconstruct their automatic override from the immutable snapshot/assignment, before consulting live percentage policy. Selection digest still checks caller identity/selection fields, and changed issue identifiers or explicit mismatches remain fail-closed. New reservations still read and validate current policy. Tests close/reopen StateStore, change ratio (same-arm and cross-arm), corrupt current config, and verify exact original start replay; new start under corrupt config rejects.
- Real HTTP `/api/runs/start` fixture invokes the actual CLI: 0% odd issue launches Fable, next fresh 100% even issue launches Astra, original key replays original run, corrupt current config permits existing-key response but rejects a new start. No route code changes needed: its existing reserved-response recovery already precedes fresh menu validation.

`/tmp/fly2570-review-admission-green.log`: 45 passed / 2 existing skipped. `/tmp/fly2570-review-idempotency-green.log`: 57 passed / 2 existing skipped. `/tmp/fly2570-review-admission-negative.log`: 3 selected parameter cases passed with six independent tamper probes each. `/tmp/fly2570-review-route.log`: real HTTP case passed. Final broader `/tmp/fly2570-review-regression.log`: 127 passed / 2 existing skipped over template selection, dispatch resolution, menu split and entire DAG-entry route suite. Original aggregate continues independently and remains red; these focused results do not replace the required complete new gate.
