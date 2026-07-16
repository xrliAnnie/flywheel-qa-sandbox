# Design Review — FLY-1281 plan.md (Round 9)

Date: 2026-07-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

Draft v9 closes the stale-generation check/write race and now specifies initial ownership, renewal, takeover, and stale-path cancellation. One crash-recovery hole remains: persisting `committed_generation` before writing the release marker is only recoverable if the original gated consumer is still alive; the real Claude gate times out after roughly 30 seconds, so a later marker repair can still produce a committed execution with no runner.

## What's Good (Keep)

- The fenced callback is threaded through the correct real touchpoints—adapter types, Blueprint, and both concrete adapters—and removes direct marker writes from the adapters.
- Exact-current-generation validation inside a SQLite write transaction closes the Round 8 TOCTOU window and gives stale commits a clear fail-closed result.
- Initial launch now acquires generation 1, every re-drive acquires ownership, and takeover is constrained to an exact expired generation.
- Renewal, injectable time, finite timestamp validation, current-generation-only operations, and the paused-owner test make the lease contract implementable and testable.
- `workflow_launch_owner` is correctly described as mutable, has no append-only trigger, and is tied to the immutable execution binding.
- Credential rotation remains output-only for generalized v2 execution, and the additive existing-table contract remains precise.

## Issues & Recommendations

1. **`committed_generation` followed by marker repair can still adopt to zero.** The current `TmuxAdapter` gate waits for its exact token for only 1,500 × 20 ms (about 30 seconds) and then exits. If the Bridge crashes after the SQLite transaction records `committed_generation` but before the marker write, and recovery occurs after that timeout, rewriting the marker releases no process. The durable row nevertheless says committed and the plan forbids a second launch, so subsequent replay adopts a phantom execution. Codex has the analogous requirement to prove that the goal-owning daemon/thread survived before treating marker repair as delivery. Choose and specify a protocol that makes release consumption recoverable, not merely marker creation. Two viable shapes are: (a) while holding the SQLite write transaction/fence, validate the generation, write the generation token first, then record `committed_generation`; a crash after marker write but before DB commit is repaired from the trusted generation-bearing marker, and takeover was blocked during the write; or (b) keep DB-first ordering but add explicit commit-delivery state plus durable gate identity/liveness evidence, and allow recreation of the same committed-generation gate when the original consumer is proven dead. In either design, `workflow_start_stage=launch_committed`, adoption, and response creation must wait until the release is durably delivered or the runner/goal is positively live—not merely until `committed_generation` exists.

2. **Pin the token and terminal-owner invariants needed by that recovery protocol.** `committed_generation` alone cannot reproduce today's random per-launch UUID unless the new marker token is explicitly deterministic from `(execution_id, generation)` or the exact token is stored durably; define the marker format and exact-match validation. Also make committed ownership terminal: acquire, renew, and takeover CAS predicates must require `committed_generation IS NULL`, and add `CHECK (committed_generation IS NULL OR committed_generation = owner_generation)` so an expired committed owner cannot be superseded. Add real-adapter crash tests where recovery is delayed beyond the Claude gate timeout, plus Codex cases with both a surviving and a dead daemon; assert no successful adopt/response without one positively live runner. Mirror these fenced-commit, paused-owner, and delayed-recovery cells into the §4 acceptance matrix, not only Step 6c.

## Verdict

CHANGES REQUESTED — address items above
