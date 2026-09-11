# FLY-2504 返工内容送达围栏 — 实施记录
Issue: FLY-2504 (https://linear.app/geoforge3d/issue/FLY-2504)
日期: 2026-09-10
基于: plan.md

## Current cursor

Implementation remains incomplete. Pinned plan.md was not edited. TURN implement epoch 2 granted to execution b154084d-1995-44ff-8bd7-d0ba6ef872ff, workflow run a1570b68-529a-4588-8097-e37bfdd22e55 attempt 1.

Completed batches:
- 68ba25309: shared context construction, launch stable-section/digest helpers, wake/coordinator refactor. Shared context test initially failed because the new module was absent; then 42 tests across context/wake-copy/coordinator passed.
- 43cd0e343: transition-only receipt guard and four StateStore tests. N1a reproduced old acceptance (`ok:true` instead of expected rework_content_not_delivered) before the guard; green after guard with no event/node/delivery mutation. Also checks legacy wake_delivered rejection, stale route identity refusal, and direct exact-receipt acceptance/settlement.
- 5350d722c: CLI rejects both rework reasons without retry/marker. Both RED cases confirmed old code wrote a marker; complete.test.ts now 70/70 green.
- Teamlead typecheck passes. Initial pre-change `pnpm -r build` passed after frozen-lockfile dependency installation. This is NOT final full-repository verification.

Local logs: /tmp/fly2504-context-tests.log, /tmp/fly2504-n1-red.log, /tmp/fly2504-n1-green.log, /tmp/fly2504-transition-tests.log, /tmp/fly2504-cli-red.log, /tmp/fly2504-cli-green.log, /tmp/fly2504-typecheck.log, /tmp/fly2504-initial-build.log.

## Required next work

1. M3 enrolled completion: add N1b/N2/N13 tests and implement typed refusal detail propagation through commitEnrolledCompletion. Current guard returns a detail but the enrolled catch still wraps it generically; no dedicated hold/alert exists yet.
2. Extract the single undeliverable finalizer from holdUndeliverableTx. New rework-content producer must atomically open exact-revision live-attempt episode, hold run, append refusal/operator event, and enqueue exactly one alert. Identity conflict must not mutate run/delivery/episodes. Replays must remain idempotent while held. Update FLY-2278 contract/inventory and test public cancel/resume.
3. M0/M1/M2: query shared persistent rework target; fence before adopt; prepend bounded launch context and optional QA summary; persist digest in prepared/committed issue evidence; atomically mark replacement started only against owner committed generation/delivery attempt. Extract shared run identity fence. No dispatcher or launch-evidence changes have been implemented yet.
4. Current StateStore tests intentionally still call legacy markWorkflowReworkReplacementLaunched in N4e/P3. P3 manually appends the revision receipt to isolate transition validation; replace/add real atomic launch proof for end-to-end acceptance. Legacy fly2096 positive fixtures must be updated with prepared/committed evidence once M2 exists; do not weaken the guard to keep old fixtures green.
5. Complete all N/P cases from pinned plan (including restart/redrive/rollback/negative identity guards), focused suites, production read-only preflight using managed snapshot tooling, exact full-repo lint/build/test gates and new shell tests, registered code review, final milestone commit, PR, report and needs_review completion. No push/PR/review/completion has occurred.

No service restart, deployment, production mutation, or QA dispatch performed.

## 2026-09-11T03:32Z continuation checkpoint (supersedes earlier cursor)

- 75c25cc29 implements M3 enrolled typed refusals, exact-revision operator episode, one shared undeliverable finalizer, atomic hold/refusal/alert, idempotent replay, unchanged-state identity conflict. Public cancel then complete and injected alert-write rollback tests pass. FLY-2278 contract/inventory updated without changing the FLY-2504 approved plan.
- d5d878629 implements M0 persistent target resolution/fence before adoption, M1 bounded prefixed stable context/QA line and prepared digest, M2 shared run identity fence and atomic started projection verified against the committed generation/delivery attempt. Old markWorkflowReworkReplacementLaunched is now a strict compatibility wrapper; dispatcher uses the new atomic API. No production caller retains the old wrapper (only two existing test sites).
- Adoption requires committed launch delivery; uncommitted session falls through to owner recovery. Tests cover crash-before-mark with a single start, repeated bad-digest adoption without start, expired uncommitted owner redrive, invalid/oversized context, generic retry fence, 40k role truncation preserving full rework section, missing/mismatched committed evidence, current repair generation, wrong identity at both shared-fence callers, and legacy wake_delivered rejection.
- Updated fly2096 positive fixture and E2E fake starts to prepare/commit actual digest-bearing evidence; did not relax production validation to accept old bare launches. N4e legacy fixture directly represents historical projection instead of calling the new certifying API.

Current verification: /tmp/fly2504-all-focused.log = 8 files / 307 tests pass; /tmp/fly2504-m0-m2-typecheck.log = tsc passes. Suites: fly2504, fly2096, fly2278-hold-cancel, dispatcher, coordinator, rework E2E, StateStore.workflow-rework, StateStore.generalized-execution. Prior M3 run /tmp/fly2504-m3-focused.log = 77 tests included hold registry and undeliverable regression. CLI 70 tests passed before this StateStore-only batch. RED evidence: /tmp/fly2504-enrolled-red.log (generic transition_refused versus typed refusal); /tmp/fly2504-digest-red.log (committed evidence loses digest); /tmp/fly2504-dispatch-red.log (launch content begins with bare role, not rework); /tmp/fly2504-m2-red.log (new atomic method absent).

Remaining before any completion claim:
1. Audit all plan N/P requirements against current tests. Specifically still add/verify N13 reconstruct_completion held rollback, N14 same-request second-generation receipts through generic rollback/converge, N2b refusal across route revision bump, explicit N6 wake-state controls. Strengthen N4b prepared+session redrive and identity-token assertions if current test is too indirect. N15 combined dispatcher adoption-to-operator recovery is currently covered by separate dispatcher and StateStore tests, not one combined test.
2. Ensure refusal matrix has no blind completed/held bypass. Inspect M0 selector `d.state <> completed` against plan's completed+receipt/cancel text (plan pseudocode excludes completed but separately mentions it). Preserve authorized semantics; do not silently extend scope or weaken receipt guards.
3. Run exact full-repository lint/build/test gates, no new shell tests currently. Run new behavior test matrix and retain honest results. Build dependencies have already been built locally.
4. Run plan §4(a) production preflight query only via managed snapshot workflow; no production mutation. Retain output and rollback limitations.
5. Registered code review via gate/request-review (do not raw codex exec), fix blocking findings and re-request. Full final milestone commit, PR, exact-head CI, Lead report and needs_review completion remain outstanding. No push, PR, review, merge, deploy, or phase completion occurred.

## 2026-09-11T03:48Z continuation checkpoint (supersedes earlier cursor)

M0–M4 code and expanded acceptance matrix complete at 7845850f6 (includes 4d02329ba final matrix and initial report). Registered review gate c33c64f8-3943-409d-bccf-1da174f2a1c1, request f9b08a94-8d0b-4899-8950-2f1aff004cb4 pending against that head. Normal push succeeded; origin/main d964e9fca is an ancestor.

Full lint/build passed. Full package first run failed in Teamlead: 3 files / 11 tests plus onTaskUpdate worker timeout; 969 files / 13083 tests passed. Two transition-loop fixtures now explicitly settle rework using the neighboring existing fixture behavior; their 76-test suite passes. Unchanged quota/router suites pass isolated (32 tests). Full second run is in /tmp/fly2504-full-tests-r2.log, still pending. Do not convert isolated results into full-suite success.

Lead production preflight: question 7f537a8f-bbf0-4c79-9a89-0104989b506c, count=5/17 at 03:37:34Z. Fifth row supplied in message a75ce8f1-c291-4fc5-8703-efe1bf80398e. Exact original reply and supplemental row are in implementation-report.md; report sent with full instruction ID.

Lead ruling 1e48f297 explicitly defers legacy completion-hold-first combined recovery without scope expansion. Documented that public reconstruct resume fails closed; the suggested resume-to-active step is not executable and was reported back. N13 refusal and N15 public cancel recovery are separately proved. No unreachable completed+receipt branch in code; shared selector excludes completed per plan SQL. Pinned plan not edited.

Pending working-tree batch: transition fixture correction, implementation-report and this cursor. Need full test second-run receipt, current review result/fixes, final evidence commit, progress update, milestone literal last commit before PR, normal push, fresh exact-head review if changed, PR CI (3 Teamlead shards), Lead report, needs_review completion and phase park. No merge/deploy/production mutation/QA dispatch.
