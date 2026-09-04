# Design Review — plan.md (Round 1)
Date: 2026-09-03
Author: Codex
Status: CHANGES REQUESTED

## Summary

The underlying diagnosis and production-code direction are sound. The retired dispatcher path really did scan `wake_delivered` by `updated_at` and hold the run after 60 minutes, and that scanner/mutator is absent on the current tree. M2 is a safe deletion. M3 is also correctly aimed at the two authoritative completion writes and can reuse the existing version-aware settle helper without adding schema, knobs, events, or alert layers.

The plan is not yet implementable as written, however. The shared fixture never creates the replacement activation binding or verification-path row required by the APIs and completion branches it intends to test. Separately, M1-b expects a severe alert after completion even though M3 intentionally removes the completed attempt from the live set. The M3 projector stub is also missing an unconditionally called method. These issues prevent the required RED/GREEN evidence from being produced reliably.

## What's Good (Keep)

- The retirement claim is verified. In `069013b25^`, `WorkflowEngineDispatcher.reconcile()` calls `reconcileWorkflowReworkStalls()` after rework coordination; that scanner includes deferred rows, ages `wake_delivered` from `delivery.updated_at`, and calls `escalateWorkflowReworkStall("hold")` after 60 minutes without fresh `actor_alive_after_receipt` evidence. On the current tree the scanner, thresholds, and mutator are gone, and `fly2278-retirement.test.ts` guards that deletion.
- M2 is precise and low risk. The only current non-document occurrences of `includeDeferred` are the declaration and its SQL/parameter use in `StateStore.listWorkflowReworkDeliveries`; no caller passes it. Removing the first predicate placeholder and changing the arguments to `[...states, now]` preserves the behavior of every current caller.
- M3’s write location and reason are correct. Both `workflow_rework_delivery → completed` writes execute inside the existing `commitWorkflowTransitionTx` transaction. Settling immediately after each successful CAS gives the desired atomicity, and `reason: "settled"` matches a received, successfully completed rework delivery.
- The M3 version fence is correct when it uses the completed delivery row’s `route_revision`. `materializeWorkflowReworkReplacement` remints the live attempt with the incremented route revision, and `settleWorkflowDeliveryAttemptTx` selects exactly that unsuperseded version.
- `settleWorkflowDeliveryAttemptIfPresentTx` is the right compatibility variant here. A pre-delivery-contract authoritative row may legitimately have no attempt, while newly minted/version-upgraded rows do. After settlement, both `listLiveWorkflowDeliveryAttempts` and `listUnsettledWorkflowDeliveryAttempts` exclude the row, so projector cannot later try to replace `settled` with `run_terminal` during an ordinary maintenance pass.
- The M1-b three-method `commDb` stub is sufficient for the watch-only rework path: the watch needs mailbox/turn lists and `hasMessagesFromAfter`; phase-wake lookup is conditional on a phase-wake attempt. The problem is only its proposed reuse by `DeliveryProjector` in M3.
- Scope stays within the repository’s “只删不加” constraint: one dead parameter deletion, two calls to an existing helper, tests, and documentation; no new flag, table, column, index, hold shape, event kind, or alert layer.

## Issues & Recommendations

1. **[HIGH] The shared M1/M3 fixture cannot reach `wake_delivered` or either targeted completion branch.**

   `markWorkflowReworkReplacementLaunched` first requires a `workflow_execution_binding` whose mode is `replacement` and whose `rework_request_id` matches; otherwise it returns `{ ok: true, updated: false }`. Inside the transaction it also requires the replacement node to already be `running`. The plan calls it before making the node running and never creates the replacement binding. In addition, the seed list omits `workflow_rework_verification_path`; without an `active` path for `(qa, attempt 2)`, `commitWorkflowTransitionTx` takes the normal QA edge and never executes either `workflow_rework_delivery SET state='completed'` write. M1’s delivery-completed assertion fails, and M3 never tests the code it changes.

   **Suggested fix:** make one explicit cross-tree fixture that (a) inserts the pending `workflow_rework_verification_path` row alongside request/route/delivery, (b) baselines before materialization in chronological order, (c) materializes revision 2, (d) admits `qa-replacement-2` with `admitGeneralizedWorkflowExecution({ activationMode: "replacement", reworkRequestId: "fly2096-rework", ... })` or drives one real dispatcher launch pass, and (e) establishes session/node `running` before calling `markWorkflowReworkReplacementLaunched`. Assert `updated:true`, binding mode `replacement`, path `active` at revision 2, delivery `wake_delivered`, and the revision-2 attempt’s `received_at=T0` before running the clock tests. `admitGeneralizedWorkflowExecution` exists on both trees. Also change the current backwards timestamps (`baseline T0-30s`, then materialize `T0-1m`) so the parent attempt is minted before its replacement child, for example baseline at `T0-2m` and materialization at `T0-1m`.

2. **[HIGH] M1-b’s final severe-alert assertion is incompatible with mandatory M3.**

   M1-b currently opens a warning at `T0+61m`, then completes the QA node, then runs the watch at `T0+95m` expecting one severe alert. After M3, completion sets `settlement_reason='settled'` and closes any open episode in the same transaction. The attempt is no longer returned by `listLiveWorkflowDeliveryAttempts`, so the `T0+95m` watch correctly emits no severe alert. M1-b and M3 therefore cannot both be green.

   **Suggested fix:** keep the absent control in flight through `T0+95m`; assert warning=1, severe=1, no duplicate warning, and run still active. Only then complete it at `T0+96m` and assert `ok:true`, delivery `completed`, and no hold event. Optionally assert the warning episode is closed as `terminal:settled:settled`. A separate in-flight control is also acceptable, but completion must not precede the severe-escalation assertion.

3. **[HIGH] The M3 `DeliveryProjector` stub throws before it reaches rework settlement logic.**

   `DeliveryProjector.runPass` unconditionally calls `listRunnerDeliveryProjectionRows`, `listRunnerPhaseWakeProjectionRows`, and `listRunnerTurnWakeProjectionRows`. The “same as M1-b” stub lacks `listRunnerPhaseWakeProjectionRows`, so M3 fails with a `TypeError` before projector/watch can create the intended RED episode.

   **Suggested fix:** use a real `new CommDB(":memory:")` and close it in teardown, as the FLY-2278 projector tests do. If a stub is retained, implement the full projector surface used by the pass: all three list methods returning `[]` and the projection-row getters returning `undefined`, plus `hasMessagesFromAfter` for the watch.

4. **[MEDIUM] The old-tree acceptance does not guarantee two reported failing assertions.**

   A normal Vitest `expect` aborts the current `it` on the first failure. If steps 7–10 are implemented as one test, the first `status === "active"` failure prevents the later `commitWorkflowTransitionTx(...).ok === true` assertion from executing. The required “at least two assertions red” evidence is therefore dependent on an unstated test layout.

   **Suggested fix:** specify two independently named `it` cases with independently built fixtures—one for the 61-minute hold and one for completion rejection—or require `expect.soft` for both old-tree tripwires. Keep the fixture-shape guards as hard assertions before those tripwires so a malformed fixture cannot count as a positive control.

5. **[MEDIUM] Deployment and rollback text incorrectly says this PR has no production behavior change and uses the FLY-2278 SHA as the only health gate.**

   M3 deliberately changes production behavior for future completed rework deliveries: they settle immediately and no longer produce post-completion warning/severe alerts. A Bridge containing `069013b25` proves only that the legacy hold scanner is retired; it does not prove that this PR’s M3 completion settlement is deployed. Section 4’s “部署前后无差” and section 8’s `buildSha ≥ 069013b25` wording conflate the two fixes.

   **Suggested fix:** state two distinct deployment checks: a build containing `069013b25` closes the original 60-minute hold mechanism, while M3 is live only when `/health.buildSha` is this PR’s merge SHA (or a verified descendant). Describe rollback honestly: reverting removes settlement for future completions, while attempts already settled during deployment remain settled and need no data repair.

6. **[LOW] The old-tree cleanup command will normally fail because the copied test is untracked.**

   `git worktree remove /tmp/fly2096-old` refuses a worktree containing the newly copied untracked test file. The hard-coded path also makes reruns collide with residue from a prior attempt.

   **Suggested fix:** allocate a unique scratch path, capture the nonzero Vitest exit status/output explicitly, and remove the known temporary worktree with `git worktree remove --force <exact-scratch-path>` after evidence capture. Do not use a broad clean/reset operation.

## Verdict

CHANGES REQUESTED — address items above
