# Design Review — FLY-1505 plan.md (Round 5)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Both Round 4 findings are semantically resolved: DirectEventSink now uses the completion event's head rather than `desPrHead`, and the alert/helper contracts correctly distinguish known- and unknown-head behavior. The overall design remains sound, but the authoritative plan still has two compile-level boundary mismatches plus two prompt/test sequencing omissions that should be corrected before handing it to the Implement phase.

## What's Good (Keep)

- C2(b) now pins the correct authority literally: `result.evidence?.headSha` is the attempt head and `preExistingSession?.pr_head_sha` is only the comparison head. The explicit ban on `desPrHead` addresses the A-attempt/B-current corruption mode directly.
- T3 now covers the primary bound session, compatibility behavior, stale A/B completion, and missing-head carrier. That is the right sink-level protection for the DirectEventSink-specific risk.
- C4's outcome-specific tails are truthful: only a real current-head marker suppresses automatic re-wake, while an unknown-head marker remains fail-open.
- T8 captures the important helper state table, including stale-attempt zero-write behavior and preservation of an existing real-head entry.
- The explicit reconciler settled branch, marker write-before-unlink ordering, boot-drain outcome accounting, C7 parser/GatePoller seam, and FLY-1448 final-tip audit remain well designed.
- The “25-minute job” mapping remains honest: prompt/workflow budget consistency plus false-blocked approval-preservation tests are the appropriate deterministic substitute for an LLM-driven wall-clock test.

## Issues & Recommendations

1. **[HIGH] Make the newly literal sink calls type-correct at their actual carrier boundaries.** `BlueprintResult.evidence` is `ExecutionEvidence`, whose `headSha` is `string | null`; therefore C2(b)'s literal `attemptHeadSha: result.evidence?.headSha` has type `string | null | undefined`, while C3 declares `attemptHeadSha?: string`. The pinned call does not compile as written. In the reconciler, `MarkerBody.payload` has an `[k: string]: unknown` index signature and no declared `summary`, so C2(c)'s `summary: body.payload?.summary` likewise passes `unknown` to `summary?: string`. Make the contract explicit rather than leaving casts to the implementer: either accept `attemptHeadSha?: string | null` in the helper (natural for its unknown-head normalization) or use `result.evidence?.headSha ?? undefined`; and validate/narrow marker summary at the boundary (or declare and validate `summary?: string` in `MarkerBody`). Have T3's unknown case use the real `null` DirectEventSink shape so this exact seam stays pinned.

2. **[MEDIUM] Put the COOL_ID-capture failure fallback into the actual prompt replacement and pin it in C5.** Line 71 says the text explicitly instructs “if COOL_ID capture fails, skip early-stop and wait the full window,” but that sentence is absent from the authoritative replacement text at lines 59–67, and C5 does not assert it. A separate Implement phase could faithfully copy the code block and omit the safeguard, leaving the LLM to improvise when `gh pr comment` output cannot be parsed. Add the fallback sentence to the receipt-check bullet (including “do not inspect/use old receipts”) and add a prompt assertion for it.

3. **[MEDIUM] Include T8 in the TDD and final-tip execution contracts, and phrase its repeat assertion in helper-observable terms.** Section 5's RED list still names C5 plus T2/T3/T4/T5/T7, omitting the newly added T8 before C3 implementation; the FLY-1448 hard gate likewise says to rerun T2–T7. Add T8 to both lists. Because `settleShipAttemptFailed` does not itself send alerts, T8 should assert `firstAttemptForHead === false` for repeated unknown and same-head inputs; if actual “no second alert” behavior is required, retain that assertion in a sink-level test where the alert callback is observable.

## Verdict

CHANGES REQUESTED — address items above
