# Design Review — FLY-1336 plan.md (Round 5)

Date: 2026-07-17
Author: Codex
Status: APPROVED

## Summary

The sole Round 4 finding is resolved. Section 8 now substitutes the safe rollback values correctly into the §3.2 invariant, and no further changes are required for this incremental review.

## What's Good (Keep)

- The rollback proof now reads `5×1 + 8 + 5 = 18 ≤ 20`, correctly accounting for lock base 5, load factor 1, total budget 8, startup margin 5, and a 20-second attempt cap.
- The safe rollback tuple remains coherent: `ATTEMPT=20000` covers the 18-second inner requirement, while `DEADLINE=90000` covers two attempts plus retry overhead.
- `ATTEMPT=10000` remains explicitly isolated as an unsafe control-experiment-only legacy setting that intentionally reproduces the outer-SIGKILL failure mode.
- Section 8 continues to require paired attempt/deadline changes when total budget or maximum load factor is increased, preserving the operator invariant.

## Issues & Recommendations

- None.

## Verdict

APPROVED — ready to implement
