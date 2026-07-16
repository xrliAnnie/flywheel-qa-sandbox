# Design Review — FLY-1281 plan.md (Round 10)

Date: 2026-07-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

Draft v10 fixes the DB-first delivery gap by making the generation-bearing marker the first durable commit evidence and correctly requires positive liveness before adoption or response. Two serialization gaps remain in recovery: marker repair must win before an expired-generation takeover, and same-generation delivery repair needs its own durable single-owner attempt rather than relying on death proof alone.

## What's Good (Keep)

- Marker-first commit under the SQLite write fence is the correct direction: a written token can release the gate, while the database projection can be repaired afterward.
- Adoption, `launch_committed`, and response creation now require positive runner/goal evidence instead of treating a committed owner row as proof of delivery.
- The deterministic `(execution_id, owner_generation)` token removes the unreconstructible random-token problem from Round 9.
- Committed ownership is terminal, with acquire/renew/takeover guarded by `committed_generation IS NULL` and a consistency CHECK tying the committed generation to the owner generation.
- Delayed Claude recovery and live/dead Codex daemon cases are now explicit acceptance cells and are mirrored into the main test matrix.
- The prior typed-snapshot, output, completion, v2-only start, default-off, and C-to-D scope contracts remain intact.

## Issues & Recommendations

1. **Marker repair must be serialized before owner takeover, not checked after it.** The stated order is still “acquire owner/fence → recheck launch commit.” Consider generation 1 writing its valid token and then crashing before `committed_generation` is updated: SQLite rolls back the row, but the marker remains and may already have released the runner. After the lease expires, a recovery caller can CAS the row to generation 2 before inspecting the marker. It can no longer repair generation 1 because `CHECK (committed_generation IS NULL OR committed_generation = owner_generation)` now requires generation 2, and treating the generation-1 marker as stale risks launching a second runner. Replace the separate acquire-then-recheck operations with one `recoverOrAcquireWorkflowLaunch` critical section: begin the SQLite write transaction, inspect and exact-validate the marker for the row's current generation while takeover is blocked, repair `committed_generation` and return if it matches, and only when no valid marker exists may the transaction insert/acquire/take over an expired generation. A corrupt or mismatched marker must hold fail-closed. Add a test that crashes after marker write/before DB projection, waits beyond lease expiry, then races two recovery callers; both must converge on committed generation 1 with no generation-2 launch.

2. **Death proof is not an exactly-once claim for delivery repair.** Once ownership is committed, acquire/renew/takeover are intentionally disabled. Two concurrent recovery callers can therefore both observe the same dead gate, both “recreate the gated shell,” and both shells will immediately match the same deterministic `(execution_id, committed_generation)` token already on disk. Positive death evidence prevents collision with the old consumer, but does not serialize the two repairers. Add a durable delivery-attempt CAS under the terminal committed generation—either columns on `workflow_launch_owner` or a separate `workflow_launch_delivery` pointer—with an attempt number, repair owner/lease, and state. Derive the gate token from `(execution_id, committed_generation, delivery_attempt)`, so only the winning repair attempt's shell can consume it; stale repair shells must never match a later token. Liveness probing must be tri-state: positive-live → adopt, positive-dead → one CAS winner may repair, unknown/probe-error → hold. Add a two-dispatcher barrier test at the positive-dead boundary, plus crashes before and after the repair shell is created, asserting one repair claim, one matching token, and one runner. Reflect the new delivery state in the storage summary.

## Verdict

CHANGES REQUESTED — address items above
