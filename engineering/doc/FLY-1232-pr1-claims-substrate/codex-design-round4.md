# Design Review — FLY-1232 plan.md (Round 4)
Date: 2026-07-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 substantively resolves all five Round 3 findings: the evidence predicate now matches both adapters, distinct-execution replay is representable, wake handoffs retain their edge, backfill limits are honest, and the transaction API is unified. The architecture is feasible and the acceptance strategy is strong, but two bounded normative inconsistencies remain in the implementation contract and should be corrected before coding begins.

## What's Good (Keep)

- Keep the dual-evidence `started` rule: the ledger must already be `launch_committed` and a durable non-pending CommDB row must exist. The row-only Codex negative case and the declared forever-unknown pre-goal failure are both accurate.
- Keep `checkStartedEvidence` out of ledger reconciliation. Its live-window result is useful for production re-drive safety, not historical launch-state reconstruction.
- Keep writer-allocated `launch_ordinal`, with one ordinal per distinct execution id and convergence only for a true same-execution replay. The new crash-before-pre-registration/new-execution acceptance case closes the concrete fresh-start gap from Round 3.
- Keep the T3b composite edge plus wake event. Spawn and wake now express the same logical Implement→QA edge while preserving the no-side-effect-row rule for wakes.
- Keep T4's explicit partial-recovery boundary. Declaring repeated keep-alive completions non-reconstructible is safer than inferring history from a mutable session projection and avoids pulling sink/route source plumbing into this sub-issue.
- Keep `applyWorkflowShadowBatch` as the single StateStore transaction surface, including delegated reconcile conveniences, transaction fault injection, and B6's no-bypass assertion.
- Keep the T9 hook plus claim repair, the active-run partial unique index, default-off injection, and the expanded B2–B7 acceptance coverage.

## Issues & Recommendations

1. **Several normative plan lines still tell callers to supply an ordinal, contradicting writer-only allocation.** Item 9 and the Step 4 preamble still define `shadowContext` as containing `ordinal`, and T7 says the context marks `ordinal+1`. The standalone attempt/ordinal paragraph also still describes only post-start replacement and same-id pre-commit replay, omitting the newly accepted distinct-id pre-commit case. T8's row names only wake gaps even though T4 now declares an additional repeated-completion gap. These stale statements sit in the implementation contract beside the corrected item 8/research rule, so an implementer could reasonably build the forbidden caller-precomputed path. **Suggested fix:** remove `ordinal` from `StartRequest.shadowContext` everywhere; make the context carry only semantic node/attempt/edge data; state that T7 requests a same-attempt replacement while the writer discovers/returns the next ordinal; update the standalone ordinal paragraph to the distinct-execution rule; and make T8 enumerate both wake and repeated-T4 gaps. Keep B3 as written.

2. **The side-effect state-transition audit contract is still undefined.** Item 13 requires every `launch_committed`/`started`/`abandoned` transition to append a deterministic `workflow_run_event` in the same batch, but Step 4 defines no owner, UID formula, or event kind for those transitions, and B6/B7 do not assert their replay behavior. B9 simultaneously forbids event kinds outside the umbrella vocabulary. This leaves implementation with incompatible choices: invent a kind, misuse a lifecycle kind such as `node_dispatched`, or silently omit the promised event. **Suggested fix:** choose one explicit contract. Prefer the simpler umbrella-aligned option: make `workflow_side_effect_ledger` itself the state audit, add any required per-state timestamps, and remove the deterministic run-event requirement from item 13. If run events are required, add named transition rows with allowed kinds, deterministic run/attempt/ordinal/state UIDs, owners, and replay tests, and demonstrate B9 compliance.

## Verdict

CHANGES REQUESTED — address items above
