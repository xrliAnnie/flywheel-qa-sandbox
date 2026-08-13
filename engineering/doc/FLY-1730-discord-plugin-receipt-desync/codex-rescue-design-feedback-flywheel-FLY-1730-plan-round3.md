# Design Review — FLY-1730 plan.md (Round 3)

Date: 2026-08-12
Author: Codex
Status: APPROVED

## Summary

The Round 3 plan closes all four Round 2 findings and is feasible against the current updater, restart-status, checker, and production process-ownership architecture. The design now has a fail-closed, wave-bound deployment receipt, preserves the no-channel-advisory invariant through rollback, directly tests both production checker implementations, and protects the required cross-project ordering window.

## What's Good (Keep)

- The Phase B boundary is captured before enqueue and both independent completion signals must be newer than it. This prevents Phase A's same-main-SHA, same-`reason=updater` terminal state from satisfying Phase B.
- Completion still requires the exact fork SHA, merged manifest version, single user-scope registry entry, cache residue checks, and a healthy restart-status record; enqueue or command success cannot produce a false completion.
- Tier-1 recovery is correctly defined as a corrective roll-forward. It may repair logging or latch details but cannot restore `AdviseFn`, an `advise` runtime option, plumbing `channel.send`, or an advise injection seam.
- B1 now requires hermetic, direct execution of both canonical checkers for old-only, new-only, and double-missing marker states. Explicitly excluding the cutover suite's fake checker as behavior evidence closes the prior vacuous-test gap.
- The two owner-visible HOLDs begin before Phase A and span deployment and QA, while PR #21 remains compatible through the already-defined rebase, version recomputation, retest, and re-review path.
- The earlier managed-updater discipline, exact completion predicate, delayed `.env` closeout, JIT patch versioning, global process census, fail-closed parasite handling, and collision-safe spool archive remain intact.

## Issues & Recommendations

1. No blocking design issues remain. Implementation and code review should enforce every stated test and production receipt gate before the deployment is declared complete.
2. Non-blocking execution note: compare `phase_b_started_at`, Discord delivery time, and `recordedAt` as parsed UTC instants rather than raw strings; treat an equal or unparsable timestamp as failure. Preserve the request marker/nonce, founder message ID and timestamp, status JSON snapshot, and census timestamps in one deployment evidence bundle.
3. Non-blocking closeout note: when Phase C is executed, record the release of both named HOLDs explicitly, in addition to the FLY-1645 and FLY-1676 notifications, so the operational record cannot leave either dependency ambiguously frozen.

## Verdict

APPROVED — ready to implement
