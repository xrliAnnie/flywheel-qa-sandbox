# Design Review — FLY-1914 plan.md (Round 3)

Date: 2026-08-19
Author: Codex
Status: APPROVED

## Summary

The Round 3 plan closes both remaining deployment-order gaps. The authoritative sequence now installs and proves the dual-marker checker while fork main is still 0.0.4, and both repository heads are audited, frozen, and re-read before updater enqueue, making the inherited exact-head QA and terminal receipts executable end to end.

## What's Good (Keep)

- Section 8 is now a single, explicit Phase A→B→C sequence with the correct hard invariant: fork main cannot change before the production checker converges.
- Main convergence happens first, followed by `install-discord-plugin-ops.sh` and a real pass against live 0.0.4; only then do the final P1-P3 checks and fork merge occur.
- Delta-4 now obtains remote truth before auditing, verifies deployed-sha ancestry, audits an immutable full-SHA range, accounts for the one docs-PR exception, and freezes main through the deployment window.
- Both remote heads are re-read immediately before Phase-B enqueue, so drift stops before plugin or fleet mutation rather than being discovered only by a terminal receipt.
- The original four deployment receipts and Delta-5's three supplemental receipts jointly bind the result to the exact updater wave, main SHA, fork SHA/version, healthy fleet result, consumed request marker, and absence of degraded restart output.
- Post-wave census, collision-safe archive, A1-A5, Phase-C unlock, and freeze release are correctly sequenced after byte convergence.
- Live verification still matches the expected adoption path: Flywheel remote main is `f8f2176e2a1b37374210bdb134e738b9c74bec95`; fork main remains `49c8c478542532cb37df0a6d39af62f09c0897d8`; PR #23 remains OPEN/MERGEABLE/CLEAN with successful checks at `a3117e1cfef448304cf16d461d87ec5a874afbea`.

## Issues & Recommendations

1. **Non-blocking editorial cleanup:** §2.2 and Delta-4 describe the fork/main freezes as ending at the Phase-B terminal receipt, while authoritative §8.12 releases both only after A1-A5 and Phase C. The §8 behavior is safer and explicitly authoritative; align the earlier wording when implementing the docs so operators see one release boundary everywhere.

## Verdict

APPROVED — ready to implement
