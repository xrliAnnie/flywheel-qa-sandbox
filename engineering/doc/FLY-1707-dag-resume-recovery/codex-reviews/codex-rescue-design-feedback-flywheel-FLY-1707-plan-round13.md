# Design Review — plan.md (FLY-1707 E5) (Round 13)

Date: 2026-08-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

All four Round 12 mechanisms are now present and technically feasible: marker adoption is bound to the accepted marker tuple, evidence conflicts no longer have to roll back a healthy launch, T2 has a real revision fence, and terminal collect-only covers zero history. Two contradictory remnants still survive elsewhere in the normative plan, though, so the implementation sequence and force-cancel state dispatch are not yet single-valued.

## What's Good (Keep)

- The marker protocol now handles the real `markerIsExpectedPriorRepair` shape. It keys evidence from the accepted marker, keeps prepared attempt N separate from marker N-1, and reconstructs frozen-replay lineage from immutable T3 state.
- The non-throwing evidence outcome closes the marker-versus-SQLite rollback loop while preserving the important rule that a successful delivery receipt exists only for a physically committed launch.
- The conflict tests now use a real checked-event UID/payload conflict across initial, repair, and adoption paths rather than relying on a mock that could bypass transaction behavior.
- T2's monotonic `revision` is the right minimal fence. A representative SQLite CAS shows that after a partial stamp increments revision, a stale invalidation using the old revision affects zero rows even while the state remains `intent`.
- The terminal collect-only branch now explicitly allows episode 0 before the first sweep tick and has the right concurrent-first-request coverage.
- The design continues to honor the locked product boundaries: current-step recovery only, suffix quarantine then rerun, no template-head fallback, no approval/land/fail-verdict reuse, and no reopening `completed` writers.
- The one registered flag, GatePoller riders, append-only receipts, CAS ownership, and fail-closed V0-V5 probes remain consistent with existing patterns and the founder's simplicity mandate.

## Issues & Recommendations

1. **The old impossible sweep-adoption story still remains in Phase B and conflicts with the corrected status split.** Section 4 now correctly says active/held Phase A is always the episode creator and terminal collect-only is the only request branch that can adopt a sweep-created open receipt (`plan.md:408,411`). But Phase B still says “sweep creates the receipt first, then the request aliases to it in Phase A” (`:409`), and Phase A itself still says `create/adopt` even while its new parenthetical says adoption is impossible. These are different implementations: the stale version encourages an unreachable branch in the atomic terminate transaction and misclassifies the valid sweep-first test at `:413`. **Fix:** make Phase A say `create` only. Rewrite Phase B in status-neutral terms: an active/held request aliases to the receipt it created in Phase A; a terminal collect-only request may alias to an open receipt created by the sweep; both replay through T7b. Label the sweep-first test explicitly as a terminal collect-only case and add a static prose/contract guard forbidding “sweep -> Phase A adoption.”

2. **The plan claims the preparation/commit/adoption protocol is named in S2, but the actual slice row was not updated.** Section 2.7 says this protocol is explicitly in the S2 row and must precede S3 (`plan.md:389`), while the normative slicing table still lists only W1-W10, T2, checkpoint store, reconciler, and the W inventory tests (`:450`). Since S3 depends on S2 and consumes `issue_delivery`, this omission permits S2 to be declared complete without the Blueprint/core/adapter preparation seam or the non-throwing initial/repair/adoption co-write—exactly the launch-wide work that R12-2 intended to make a sequencing gate. **Fix:** expand S2's content and acceptance text to name `prepareWorkflowIssueDelivery`, all three launch surfaces, initial/repair/marker-adoption evidence handling, accepted-marker tuple tests, and real conflict compatibility tests. Keep S3 dependent on that complete S2 contract; no new slice or timer is needed.

## Verdict

CHANGES REQUESTED — address items above
