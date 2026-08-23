# FLY-2008 plan.md — Codex Design Review (Round 3)

Date: 2026-08-23
Author: Codex
Status: CHANGES REQUESTED

## Summary

The Round 3 core design is now technically sound: the lower-layer forensic seam preserves liveness behavior, pending is correctly orthogonal, the DB lease preserves the full concrete call graph, and the health wiring reaches the HTTP boundary. The A-side query/index work, scan-lane budget, governance, and acceptance semantics remain ready to implement. One contradictory TDD instruction still tells the implementer to add the rejected `unresolved` branch, so the plan is not yet safe to execute verbatim.

## What's Good (Keep)

- The corrected pending mechanism matches the code. `lookupTmuxTarget` remains `found | gone | error`; a `found` target ending in `:pending` increments the independent counter and annotates forensic records, then follows the unchanged process-probe and verdict path.
- `probeRunnerProcessLivenessDetailed(tmuxWindow, runTmux?)` is the right observation seam. Forwarding the existing runner injection through the legacy four-state wrapper supports real lower-layer tests while preserving every existing caller's return contract.
- The four forensic dimensions are now coherent: lookup failures, tmux throws, empty output, and the orthogonal pending-target count are distinguishable without changing alerting, heartbeat writes, probe cadence, or liveness verdicts.
- The lease-based CommDB contract resolves the transitive-type problem cleanly. Default calls retain a real per-thread connection and close it on release; the pass borrows the real per-project connection with a no-op release, while the outer owner closes exactly once in `finally`.
- The expanded B2 tests cover the important transitive branches—founder-review and ship-gate writes—as well as default ownership and exceptional cleanup. That is the correct regression surface for the resource hoist.
- The B1 upper-bound cursor, independent pure-scan budget, question-bound exemption, churn tests, and restart behavior preserve semantics and make fairness explicit.
- The `/health` plan now covers the complete path: HeartbeatService snapshot, late-bound composition, real manifest builder, validator, and HTTP response before and after service population.
- A1's two-branch minimum remains equivalent to the original query and retains the fence update. The partial indexes, bound-parameter EQP discipline, `ORDER BY +seq`, absence of new flags/env, and event-loop acceptance thresholds all remain correct.

## Issues & Recommendations

1. **MAJOR — Section 5.3-2 still mandates the invalid `unresolved` implementation.** Section 4.1 now correctly says there is no unresolved branch and that pending must continue through the existing probe. However, the TDD step still says: “GREEN 后显式 `unresolved` 分支…”. This directly contradicts the approved mechanism and would either fail TypeScript's closed-union check or broaden `lookupTmuxTarget` in violation of the zero-behavior-change ruling. **Suggested fix:** replace the GREEN clause with an explicit assertion that the lookup remains `found`, the detailed probe is invoked with the unchanged pending target, absence/timeout/normal outcomes preserve their existing verdicts, `pending_sentinel` increments once per attempt, and any failure record includes `pendingTarget: true`. State again that no unresolved branch is added.

2. **MINOR — finish the related cross-reference and sequencing cleanup.** Section 4.2 points its HTTP route test to §5.3-2, but the route test is now §5.3-3. Section 8's RED phase names only §5.3-1 before implementing all B forensics, omitting the pending characterization and health-path tests, and the Round 1 convergence note still repeats the now-refuted pending/TypeError claim without marking it superseded by Round 2. These stale references weaken the otherwise clear TDD order and historical record. **Suggested fix:** change the route reference to §5.3-3, make the RED step include §5.3-1 through §5.3-3 before forensic implementation, and annotate or replace the obsolete Round 1 pending statement with the corrected Round 2 disposition.

## Verdict

CHANGES REQUESTED — address items above
