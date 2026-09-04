# Design Review — plan.md (Round 2)
Date: 2026-09-03
Author: Codex
Status: CHANGES REQUESTED

## Summary

Rev3 addresses all six Round 1 findings in substance. The replacement fixture now reaches the real rework verification path, the positive controls are independent, the absent control preserves the warning-to-severe timeline, `CommDB` is real, deployment/rollback language is accurate, and scratch-worktree cleanup is bounded.

Two test-design blockers remain. First, the shared old-tree fixture requires a versioned rework attempt that does not exist on `069013b25^`. Second, the watch assertions count all delivery-contract alerts even though this fixture also creates live launch and gate-holder attempts. As written, those assertions can fail for correct unrelated behavior and cannot provide the specified RED→GREEN evidence.

## What's Good (Keep)

- Keep `seedLaunchedReplacement()` and its path/binding/delivery guards. Inserting the pending verification path before materialization, admitting the replacement, moving the node to `running`, and then calling `markWorkflowReworkReplacementLaunched` matches the production preconditions.
- Keep the two independent positive-control `it` cases. They ensure the old-tree hold and completion-rejection tripwires are both reached and reported.
- Keep completion proof via `rework_verification_completed:<requestId>`; it correctly prevents a false green through the ordinary QA edge.
- Keep the absent control in flight through `T0+95m` before completing it. That ordering correctly preserves the warning/severe assertions.
- Keep real `CommDB(":memory:")` instances and teardown. `DeliveryProjector.runPass` does require methods that the earlier stub omitted.
- Keep M3 immediately after each successful delivery `completed` CAS, in the same transaction, with `version: { routeRevision: delivery.route_revision }`, `reason: "settled"`, and the existing `IfPresent` helper. The version fence selects the current reminted attempt; `IfPresent` preserves completion of pre-attempt deliveries. A later projector pass will not revisit a settled attempt because unsettled/live selectors exclude non-null `settlement_reason`.
- Keep the revised two-SHA production checks and honest rollback boundary, and keep the `mktemp`/forced worktree cleanup sequence.

## Issues & Recommendations

1. **[HIGH] The shared fixture's revision-2 attempt assertion cannot pass on the positive-control tree.**

   Why it matters: §1 says the delivery and attempt both use revision 2 as their version fence, and M1-a step 6 requires a “revision-2 attempt” with `received_at === T0`. On `069013b25^`, `mintWorkflowReworkDeliveryAttemptTx` serializes only `{ table, pk, runId }`; it has no `routeRevision`, and that tree has no `remintWorkflowReworkDeliveryAttemptTx` call when materialization advances the delivery to route revision 2. The old tree therefore retains its versionless generation-1 attempt. The fixture guard will fail before either intended hold/completion tripwire, so the required two-red positive control is not valid evidence.

   Suggested fix: make the two-tree fixture assert only the facts common to both implementations: the one current rework attempt for `{ table: "workflow_rework_delivery", pk: requestId }` exists and has `received_at === T0`. Keep the path and delivery `route_revision === 2` guards. Move the exact `contract_ref_json.routeRevision === 2` assertion into a main-only/M3 test, where FLY-2278's version upgrade and remint behavior exists. Update the §1 wording and §5 guard accordingly.

2. **[HIGH] Watch/outbox expectations are global even though the fixture creates unrelated live delivery attempts.**

   Why it matters: `admitGeneralizedWorkflowExecution` mints a `family='launch'` attempt at `T0-30s`; the fixture does not emit a launch-consumption event, so that attempt is overdue when the watch first runs at `T0+61m` and can produce its own `delivery_contract_stalled` alert. Separately, the copied `storeWithIntent("qa")` run has `gate_carrier_epoch=1`, and `qa_pass` calls `createWorkflowGateHolderTx`, which mints a `family='gate_holder'` attempt. Its `minted` deadline is 10 minutes, so the first post-completion pass can emit a gate-holder warning and the later pass can emit its severe alert. Consequently M1-b's global “outbox zero” / “`T0+3h` zero writes” and M3's unscoped warning/severe counts are false even when rework settlement is correct; before the fix the RED side may also observe more than the promised one alert.

   Suggested fix: complete the launch attempt through the real existing session-start/launch-consumption path in `seedLaunchedReplacement()` (and assert it is no longer live), then scope every M1-b/M3 episode and alert assertion to the target rework `attempt_id`/`root_id` or its exact `delivery_contract_stalled:<attempt_id>:...` escalation UID. Do the same for the in-flight rework control's one warning/one severe. After QA completion, assert that the completed rework attempt is absent from the live list, its prior rework episode is closed as `terminal:settled:settled`, and no new **rework-scoped** alert appears; do not assert a global watch/outbox zero while the legitimate gate-holder contract is live. Update acceptance item 4 and §5 so the RED→GREEN evidence explicitly counts the completed rework attempt only.

## Verdict

CHANGES REQUESTED — address items above
