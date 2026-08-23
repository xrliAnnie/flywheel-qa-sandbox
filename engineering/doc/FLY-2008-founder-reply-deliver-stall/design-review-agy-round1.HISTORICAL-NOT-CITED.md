# FLY-2008 plan.md — Antigravity Design Review (Round 1)

Date: 2026-08-23
Author: Antigravity
Status: APPROVED

## Summary
This implementation plan accurately identifies the root causes of the 70s `gate-poller.founder-reply-deliver` stall and the repeated 5–12s `gate-poller.tick` event loop blocks. The proposed fixes—combining precise partial-index schema changes to eliminate synchronous SQLite full table scans and a bounded budgeting strategy for thread processing—are sound, completely aligned with existing codebase constraints, and solve both the CPU and wall-clock issues comprehensively. No new flags are introduced and semantics are properly preserved.

## What's Good (Keep)
* **Root Cure (Fix A):** The strategy to break `OR` conditions into separate SQL statements (e.g., in `claimBridgeProtocol`) paired with carefully constrained partial indexes perfectly aligns with SQLite's query planner mechanics, effectively eliminating the massive `SCAN` overhead.
* **Precise Index Definitions:** Leaving out the `state` from the `mailbox_legacy_adopt` index correctly circumvents the SQLite planner's limitation with evaluating `OR` inside complex updates.
* **Bounded Budgeting (Fix B):** Segregating pure ingress-scan threads under a strict, cursor-based budget while prioritizing `question-bound` threads ensures responsiveness for critical founder reactions without starving the loop.
* **Database Connection Reuse:** Hoisting `CommDB.openReadonly()` to be per-project instead of per-lead effectively slashes unnecessary database construction overhead over a 506MB database.
* **Compatibility & Governance:** The plan introduces zero new configuration flags, honoring the founder's governance rules perfectly, and sets up exact test criteria reflecting `EPISODE_MS=1000` from `event-loop-attribution.ts`.

## Issues & Recommendations
None. The plan is exceptionally thorough, the root cause analysis holds up perfectly against the codebase, and all proposed remediations are safe, effective, and correctly scoped.

## Verdict
APPROVED
