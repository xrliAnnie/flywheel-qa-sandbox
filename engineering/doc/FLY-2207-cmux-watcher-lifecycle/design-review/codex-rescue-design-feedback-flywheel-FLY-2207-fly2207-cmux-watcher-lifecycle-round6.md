# Design Review — design-correction.md FLY-2207 cmux-watcher-lifecycle (Round 6)

Date: 2026-08-31
Author: Codex
Status: APPROVED

## Summary

Revision R3 closes all three Round 5 blockers and is feasible within the existing architecture. T7 now has an exact, replayable terminal-teardown transaction; T8 explicitly composes the three existing durable authorities through a pre-mutation episode intent; and the source predicate refuses ambiguity across the entire workspace title rather than only within one execution id.

## What's Good (Keep)

- The correction remains an incremental appendix committed at `7d2233793b2416a06c79b054c71487e5aded6105`; the approved `plan.md` blob remains exactly `0ff5370d0ff88e325f79aa012aaa90ef7a3bc944`.
- T7 now proves both lifecycle facts needed for safe teardown: N complete terminal observations and a complete active roster proving the exact execution absent. The mutation guard revalidates terminal evidence, tmux generation, exact session/window/exec identity, pane state, mirror title, and unique workspace ownership before source teardown.
- T7 orders the irreversible action correctly: persist the episode, tear down and verify the exact source window, then enter the existing workspace cleanup path. Episode replay closes the crash gap between source teardown and marker/close-request delivery, and QA proves no pane-alive cancellation or additive recreation.
- T8 no longer overstates the viewer WAL. The persistent full-key intent composes viewer WAL, UUID receipt ledger, and attach-heal state; pre-mutation failures remain retryable, while ambiguous post-mutation failures latch fail-closed until the identity key changes.
- T8 now requires one candidate across the whole title and recomputes that count inside the mutation guard. Two distinct live executions mapped to the same mirror title are explicitly tested and refused.
- The previously accepted T6 minimum secret projection, T7 snapshot-stall episode, workspace-side UUID ownership, active kill-switch registration, no-new-alert-layer constraint, FLY-913 boundary, and hermetic QA remain intact.

## Issues & Recommendations

1. **Non-blocking implementation watchpoint:** `cleanup_stale_conservative` requires an existing `cmux-*` linked session, while an exact global window teardown can remove both the source and sole-holder view. For the hook-drop/both-anchors-gone case, make the documented terminal episode replay (or the existing FLY-293 anchor-independent orphan-pin reaper) the authoritative fallback rather than relying only on the conservative scan. Include the crash cut immediately after verified source teardown and before marker delivery in the hermetic T7 test matrix. This does not change the approved authority or architecture.

## Verdict

APPROVED — ready to implement
