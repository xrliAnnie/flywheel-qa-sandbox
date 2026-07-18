# Design Review — FLY-1336 plan.md (Round 4)

Date: 2026-07-17
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 closes all three substantive Round 3 findings: the safe rollback values are coherent, the cross-layer tuple tests are assigned to suites that can observe their respective contracts, total-budget parsing is defined, and bookkeeping failures are independently shielded. One arithmetic typo remains in the operator-facing rollback proof; because budget coherence is the core safety argument of this plan, the equation should be corrected before approval.

## What's Good (Keep)

- The safe rollback values are now correct in substance: with lock base 5, factor 1, total budget 8, and startup margin 5, the required attempt cap is 18 seconds, so `ATTEMPT=20000` has 2 seconds of headroom. `DEADLINE=90000` comfortably covers two attempts plus overhead.
- `ATTEMPT=10000` is now honestly labeled as a control-experiment-only exact-legacy setting that deliberately abandons the invariant and can reproduce outer SIGKILL behavior. This prevents it from being mistaken for a safe production rollback.
- The non-default tuple proof is now split along the real architecture boundary: the shell suite proves the inner wall-clock bound, while `TmuxAdapter.test.ts` verifies the paired outer attempt/deadline contract and includes a cap-shrink mutation check.
- `FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC` now has a Bash 3.2-safe, deterministic contract: positive integer seconds only, with zero/negative/empty/non-numeric inputs falling back to 60 before `awk` arithmetic. The listed malformed-input tests cover the relevant cases.
- The actions bookkeeping writes are now independently guarded, so a `setRetrySuccessor` exception cannot suppress the WAL attempt. Healthy-store and store-exception guarantees are clearly separated in §4.3, §4.4, and the acceptance criteria.
- The earlier core fixes remain coherent: one inherited budget anchor covers nested recovery, pending responses are never cached, 202 uses `success:true` end to end, outer SIGKILL risk is described accurately, parked lifecycle semantics are preserved, and true saturated/split-brain/ambiguous holds remain fail-closed.
- Scope and sequencing remain appropriate: the rescue script plus both TS callers land atomically, Bridge semantic work follows separately, inflight cleanup remains isolated, and case 2/sentinel/process-group redesign stay outside the approved boundary.

## Issues & Recommendations

1. **MEDIUM — The safe rollback equation is arithmetically false as written.** The rollback line says `ATTEMPT=20000 (10+8+5=18 <= 20)` (`plan.md:197`). `10+8+5` equals 23, which would make a 20-second cap unsafe. The configured tuple is actually safe because §3.2’s first term is `lock_base * factor_max = 5 * 1`, not 10. **Fix:** replace the parenthetical with the exact invariant substitution: `5×1 + 8 + 5 = 18 ≤ 20 ✓`. No value or design change is otherwise required.

## Verdict

CHANGES REQUESTED — address item above
