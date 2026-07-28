# Design Review — FLY-1518 plan.md (Round 5)

Date: 2026-07-28
Author: Codex
Status: APPROVED

## Summary

Round 5 closes all three Round 4 findings: action registration now happens before any user code, every local settlement/state-destruction path shares the barrier, and the full E10 ownership is consistent across the plan. The plan is feasible, sufficiently complete for implementation, and remains within D1/D2/D3 and the actions-black-box/FLY-1520 boundaries.

## What's Good (Keep)

- The wrapper-placeholder rule establishes the exact happens-before edge the JavaScript execution model requires: the registry and rejection observer exist before the microtask that enters `runRecordedAction`, so even the synchronous prefix of `perform` is fenced.
- Lifecycle handling is now closed over the current driver architecture. `stop()` preflights every state before setting `#stopped` or writing, while `registerLead` and `attachRunner` inspect the prior local state before registration, stopping, or map replacement. The retry-after-completion behavior preserves the existing synchronous API.
- The E6 distinction is sound: same-process live state uses the barrier, whereas `registerAgentTx` remains the DeathEvidence-gated confirmed-dead cross-process succession primitive for the founder-approved honest crash window.
- E10 now covers all nine meaningful branches, including reentrant settlement, both direct settlement methods, lead success/failure exits, late context use, stop, state replacement, rejection observation, and the package-surface negative assertion. Test ownership and TDD sequencing now match the acceptance matrix.
- Removing the free conversion-settlement exports leaves the two `EngineDriver` methods as the only normal public conversion-settlement surface. The exact runtime/type negative assertions and the lack of external repository callers make this a safe pre-launch API contraction.
- The per-action invocation identity, epoch fence, runner lineage binding, replay/supersede rules, A1-A5 advisories, and result-serialization fallback continue to match the kernel's current contracts.
- M1-M5 and Z1-Z3 are coherent. M5 tests an actual runtime-path restore and the runbook correctly pairs snapshot restoration with code rollback rather than treating the discard receipt as recovery data.
- A fresh execution of the proposed 0008 DDL against the current 0001..0007 schema—with two commands, one dependency edge, and a depth-1 obligation—produced receipt counts `2/1/2`, removed all retired table/trigger/index objects, left foreign keys enabled, and returned zero `foreign_key_check` violations. Migration files 0001/0002 remain byte-identical to baseline.
- No dispatcher, executor registry, intended-row scanner, automatic retry, reconciliation loop, or FLY-1520 file/migration overlap has been introduced.

## Issues & Recommendations

1. **[LOW, non-blocking] Mirror the `registerAgentTx` qualification in §1.2.**

   Why it matters: §1.1 says the E6/DeathEvidence qualification will be written into §1.2 and design-FINAL, but §1.2 still says without qualification that the two driver methods are the “唯一公开结算面.” The intended distinction is already unambiguous in §1.1, so this does not block implementation, but leaving both phrasings makes the public cutover primitive look contradictory.

   Suggested fix: In §1.2, say “唯一公开的活转化/正常 conversion settlement 面,” and explicitly cross-reference `registerAgentTx` as the confirmed-dead E6 cutover exception. Carry the same wording into design-FINAL as already planned.

## Verdict

APPROVED — ready to implement
