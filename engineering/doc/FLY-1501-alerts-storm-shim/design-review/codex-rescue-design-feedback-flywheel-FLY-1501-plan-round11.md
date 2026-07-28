# Design Review — plan.md (FLY-1501) (Round 11)

Date: 2026-07-27
Author: Codex
Status: APPROVED

## Summary

Round 11 closes the remaining quarantine TOCTOU gap: the typed fingerprint union and `lstat`-based six-branch state machine now cover regular/nonregular replacement, absence, retryable errors, and same-invocation recovery without moving a valid replacement. Across the full plan, the engineering placement, cross-issue contracts, failure semantics, and acceptance coverage are faithful to the approved R13 mechanism and implementable against the current codebase; the unresolved C4/C5/C7 dependencies remain correctly represented as implementation gates.

## What's Good (Keep)

- The frozen `sha256:<hex> | nonregular` union removes the ambiguous sentinel and is consistent across validation output, diagnostic identity, quarantine input, and the CLI contract.
- Quarantine now linearizes canonical basenames with the same child lock as the gate, uses the root quarantine lock only when no legal child can be derived, and uses `lstat` without following symlinks.
- The six in-lock branches are exhaustive for the relevant entry states. In particular, both regular-byte replacement and `nonregular`→regular replacement return the distinct nonterminal code 6 and never move the replacement.
- Exit 6 has an explicit bounded same-invocation recovery path: revalidate, then either project and mark applied or diagnose and retry quarantine. Exit 75 preserves retryability without mutating the live entry.
- The helper's successful validation record is the sole input to the projection transaction, so TypeScript neither duplicates the grammar nor reopens mutable spool bytes.
- A12 now exercises the decisive real-process interleavings, including the symlink/nonregular-to-valid-regular flip, same-invocation convergence, child-lock contention, post-commit helper failure, invalid-spool disposal, and historical exactly-once projection.
- The broader plan retains clear ownership boundaries with FLY-1499/FLY-1500, explicit blockers for unsigned contracts, deterministic full-history projection identity, send-time recipient resolution, and pinned-snapshot workflow-window semantics.

## Issues & Recommendations

No blocking issues. Keep C4, C5, and C7 as explicit implementation gates: do not land the dependent W2 recipient integration or W4 vendor shims until their named owners have signed the frozen contracts.

## Verdict

APPROVED — ready to implement
