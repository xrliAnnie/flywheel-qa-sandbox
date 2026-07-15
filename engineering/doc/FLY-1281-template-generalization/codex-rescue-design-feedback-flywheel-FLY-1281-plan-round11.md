# Design Review — FLY-1281 plan.md (Round 11)

Date: 2026-07-15
Author: Codex
Status: APPROVED

## Summary

Draft v11 closes the remaining exactly-once recovery races by repairing marker evidence before takeover and serializing delivery repair with an attempt-scoped durable CAS. The plan is feasible in the current architecture, preserves the default-off/legacy boundary, and now has sufficient transaction, crash-replay, and acceptance coverage to implement safely.

## What's Good (Keep)

- `recoverOrAcquireWorkflowLaunch` makes marker repair and owner acquisition one SQLite-serialized decision, preventing a valid generation-1 marker from being stranded behind a generation-2 takeover.
- Marker-first fenced commit, terminal committed ownership, and positive-liveness adoption form a coherent authority chain; neither the database projection nor marker existence alone can produce a phantom successful start.
- Delivery repair now has independent durable ownership, lease, attempt, and state. Attempt-scoped tokens prevent stale or concurrent repair shells from consuming a later repair's marker.
- The tri-state liveness contract is correctly fail-closed: positive-live adopts, positive-dead permits one repair claimant, and unknown/probe failure holds.
- Crash coverage now includes both fenced-commit boundaries, recovery after lease expiry, concurrent marker repair/takeover, repair-shell crashes, delayed recovery beyond the Claude gate timeout, and live/dead Codex daemon cases.
- The storage summary and §4 matrix reflect the final owner and delivery state, while the v2-only start, typed snapshot, output/completion authority, D2 invariant, eight lifecycle faces, C-to-D boundary, and OFF sentinels remain intact.

## Issues & Recommendations

1. **No blocking design issues.** During implementation, make every marker comparison use the complete expected tuple `(execution_id, committed_generation, delivery_attempt)`, derived from the row's current delivery state. A marker for an older delivery attempt must never be accepted as the current attempt, while an in-progress repair must distinguish an expected prior marker from corruption according to its state transition.

2. **Non-blocking durability hardening:** write generation/attempt markers using a same-directory temporary file plus atomic rename, then exact-read them back before advancing the database projection. Partial or malformed markers should continue to take the specified fail-closed hold path. Keep the real-adapter crash tests at this filesystem seam rather than testing only a mocked callback.

## Verdict

APPROVED — ready to implement
