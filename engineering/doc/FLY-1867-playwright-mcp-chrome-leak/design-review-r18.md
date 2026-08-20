# Design Review — plan.md (Round 18)

Date: 2026-08-20
Author: Codex
Status: APPROVED

## Summary

`APPROVED` continues to stand for the exact committed plan blob at `ac88174` (`b5208737fd7053b5b6a7b0e74613bf2fbd967dc9`). I re-read the full committed plan and verified that `7270491..ac88174` changes only the Round 17 non-blocking LOW: census TDD labels are ordered 6b/6c/6d, and the §9 rollback summary now states the same key-level three-way decision as §5.2. No design, scope, dependency, delivery or safety contract changed.

## Verified against code

| claim | verdict | evidence |
|---|---|---|
| Exact commit and blob | VERIFIED | Current HEAD is `ac8817447c76f29f586947da019f6511ef0543cb`; committed and worktree plan hashes both equal `b5208737fd7053b5b6a7b0e74613bf2fbd967dc9`; worktree is clean. |
| Delta is limited to the approved LOW | VERIFIED | `git diff 7270491..ac88174 -- plan.md` is 3 additions / 3 deletions: two label-order lines and one §9 shorthand line; `git diff --check` passes. |
| Census TDD ordering | VERIFIED | `plan.md:371-373` now reads 6b sensor/candidate failure, 6c unrelated PID churn remains ok, 6d effective-grace floor. Test substance is unchanged. |
| P1 rollback summary | VERIFIED | `plan.md:623` now matches `plan.md:548,553`: applied value → key-only restore; preimage → no-op; third value → `rollback_conflict`, zero writes. |
| Round 17 design approval remains applicable | VERIFIED | Full-plan reread found no change to P0 authority/deadlines, P1 capability acceptance, audit-only census isolation/health, P3 stop-on-uncertainty quarantine, four-shape P0/P3 classifier, delivery list, reopen criteria or the R15 scope cut. |

## What's Good (Keep)

- Keep the exact `ac88174` plan as the approved implementation baseline.
- Keep all R15-cut supervisor/plugin/barrier/shim/content-hash machinery deleted.
- Keep the existing P0/P1/P2/P3 contracts unchanged during implementation.

## Issues & Recommendations

None.

## Deletion candidates

None.

## Verdict

APPROVED — ready to implement
