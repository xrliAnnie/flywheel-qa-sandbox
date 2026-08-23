# Design Review — plan.md (Round 5)

Date: 2026-08-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

V5 closes the most serious Round 4 gaps: the sentinel estimator is now conservative about scheduler lateness, the L4 protocol matches the code, E1 has a real ramp and session structure, E2 sessions are independently initialized, and the lease supervision is substantially safer. The plan is still not ready to implement because the new diagnostic blocks are absent from the experiments and budgets, the stated recovery window cannot certify its own L2 criterion, the sample-size claim does not yet account for the observed serial dependence, and E2 still confounds load direction with the transient after each load step.

## What's Good (Keep)

- Keep the block-level collector separation and the explicit launch rule that a diagnostic request's full timeout must fit inside its block. This resolves the client-side boundary contradiction from v4.
- Keep counting `timer_late` as a violation in the certification analysis, reporting the exclusion-based result only as a best case, and treating an instrument-failed block as not certified safe rather than deleting it.
- Keep the source-accurate L4 request contract, pre-seeded issue-to-thread assertion, correlation nonce terminology, no-automatic-retry rule, and conservative accounting of unreconciled deliveries. These now match the route's actual semantics.
- Keep E1's separate washout, non-inferential ramp, and measurement stages; the randomized sham in every session; and `session` as a required blocking factor.
- Keep treating `persistent_effect` as treatment harm that can disqualify a nominally compliant dose. This is a material improvement over treating all carryover as removable contamination.
- Keep E2's independently initialized sessions, recovery gate, prohibition on restart-based resetting, and explicit inconclusive outcome when recovery cannot be shown.
- Keep Q1-full out of scope unless an authorized mechanism can exercise the real selective-admission action. The potential-outcome framing correctly avoids assigning individual counterfactual labels.
- Keep the supervisor-local monotonic lease deadline and fail-closed behavior. This no longer depends on `/health` remaining responsive during the induced failure.
- Keep the explicit cost disclosure and the rule that tier count, not replication, is the first cost lever.

## Issues & Recommendations

1. **HIGH — The diagnostic blocks are not part of any executable treatment schedule or time budget.**

   **Issue:** Section 2.2 defines 180-second diagnostic blocks followed by at least 60 seconds of quiet, and Q4 depends on L3/L4 diagnostic distributions by load. But an E1 arm in section 4.1 contains only 180 seconds of baseline, 180 seconds of ramp, and a 300-second sentinel block. Section 4.4 therefore budgets only 11 minutes per arm. The plan never says what treatment is active during a diagnostic block, how that block is paired with a sentinel observation, or where its ramp, washout, drain, and randomization occur. Adding even the declared 180-second diagnostic block and 60-second drain makes an arm 15 minutes; four such arms no longer fit the 50-minute same-host session cap.

   **Why it matters:** As written, the implementer must either omit the observations needed for Q4 or invent a second experimental schedule after pre-registration. The latter can change treatment exposure, carryover, Discord/Linear budgets, session counts, and the total risk window.

   **Suggested fix:** Define diagnostic data as a separate, executable experiment or as explicit diagnostic arms. For every diagnostic observation, specify the active `N`, ramp/stability rule, ordering/randomization, washout/carryover rule, quiet quarantine, and matching to sentinel evidence. Then recompute session feasibility and all time/side-effect budgets. If the diagnostic experiment is optional, say so and remove Q4 from the required claims when it is not run.

2. **HIGH — The 120-second post-stress recovery gate cannot certify L2 at the stated SLO.**

   **Issue:** L2 runs every 3 seconds, so 120 seconds supplies at most 40 scheduled ticks. Even with zero violations and independent observations, the exact one-sided 95% upper bound is about 7.22%, above the 5% SLO. At least 59 independent zero-failure observations—177 seconds at this cadence—are needed merely to get below 5%, before any correlation adjustment. The phrase “held continuously for at least 120 seconds” also leaves unclear whether certification is calculated over that same window, a growing window, or a rolling window.

   **Why it matters:** The supervisor could never prove the declared recovery condition from the declared recovery exposure, or an implementation could silently use a weaker point estimate. This is a safety-path defect, not just an analysis-detail defect.

   **Suggested fix:** Write an exact recovery estimator and derive its minimum observation duration from the L2 confidence method plus the pre-registered correlation/design-effect allowance. A coherent contract would first accumulate enough post-stress observations to certify both L1 and L2, then require all recovery conditions to remain satisfied for a separately defined 120-second sustain period. Prove that the worst-case total fits the reserved ten minutes; otherwise increase the reserve or shorten the stress portion of the session.

3. **HIGH — The nominal tick counts do not establish the claimed “headroom for correlation.”**

   **Issue:** The plan correctly says the observations are strongly serially correlated and that the preliminary episodes have a roughly 190-second period, yet section 2.2 says `n=150` and `n=100` certify 5% with correlation headroom. Section 5.3 still presents the old `n=90` table and only says effective sample size will be smaller. With zero failures, 5% certification requires an effective sample size of roughly 59; L2 therefore tolerates a design effect of only about `100/59 = 1.69`, and L1 about `150/59 = 2.54`. A 300-second block covers only about 1.6 of the observed 190-second cycles, so neither allowance is self-evidently conservative.

   **Why it matters:** Nominal request count is not the information size for clustered failures. If the effective sample size falls below the required level, a block cannot certify safety even when all ticks succeed, and the fixed 300-second blocks and current budget may be too short.

   **Suggested fix:** Label the 1.98% and 2.95% figures as independence-only bounds. Before stress testing, use a pre-registered Phase 0 method to estimate or conservatively bound the design effect/cluster process, then derive the number and duration of blocks needed for each endpoint. Update section 5.3 with the actual `n=100`/`n=150` design and an explicit decision rule for cases where the required effective exposure does not fit a session. Do not assert correlation headroom until the bound demonstrates it.

4. **HIGH — E2 still mixes direction effects with load-step transients.**

   **Issue:** E1 now has a 180-second non-inferential ramp and an achieved-load stability gate, but E2 changes worker count between consecutive 300-second measurement blocks and samples immediately. `load1` is smoothed, and the Bridge may also have state carried from the preceding tier. Consequently, an ASC block and a DESC block matched to the same achieved-load band can contain different mixtures of the prior dose, current dose, and time since transition.

   **Why it matters:** The registered ASC-minus-DESC contrast could report ordinary step-response lag as hysteresis. Independent initialization of each sweep does not remove this within-sweep confound.

   **Suggested fix:** Add a non-inferential ramp/stability stage before every E2 measurement block, using the same achieved-load contract as E1, or redefine E2 as a dynamic trajectory experiment whose estimand explicitly includes time since step and prior dose. Recompute the sweep/session budget; if stable tiers no longer fit under 50 minutes, reduce the number of tiers or redesign the session structure rather than omitting stabilization.

5. **MEDIUM — A 60-second quiet interval is a quarantine, not a guarantee that server work has drained.**

   **Issue:** Section 2.2 correctly states that cancelling `fetch` does not stop Bridge-side work, but the diagram labels the 60-second interval as guaranteeing drain because it equals the client timeout. A diagnostic request launched near the last permitted instant can time out at the block boundary and continue in the Bridge or downstream after that timeout; no server-side maximum execution time or completion signal establishes a 60-second upper bound.

   **Why it matters:** Residual diagnostic work can contaminate the following treatment or sentinel block. The powered A/A comparison only tests harm under two probe cadences; as the plan itself now says, it does not prove absence of outstanding server work.

   **Suggested fix:** Rename this interval a minimum quarantine and add a post-diagnostic baseline-equivalence/carryover gate over the inferential outcomes. If the gate fails, mark the next block contaminated and extend recovery or stop. Alternatively, add server-side request-completion instrumentation in the later instrumented work. Do not use elapsed client timeout alone as proof of drain.

6. **MEDIUM — The Phase 0 gate is defined for L1 while the final service contract requires both L1 and L2.**

   **Issue:** Section 0 defines `b` as `P(L1 latency > 500 ms)`, and sections 3/3.1 use the singular `b_ub <= SLO` gate. Phase 0 nevertheless collects L1 and L2, and section 5.2 requires both endpoint bounds to meet 5% for a safe block. The plan does not say what happens if L1 passes and L2 fails, nor how the cross-window equivalence and multiplicity rules apply to the two endpoints.

   **Why it matters:** Phase 0 could admit stress testing from a baseline that is already incapable of satisfying the final two-endpoint threshold contract.

   **Suggested fix:** Define the Phase 0 and re-entry gates as a conjunction: every required window must certify both L1 and L2, and both endpoints must satisfy the pre-registered nonstationarity/equivalence rule. Put the confidence/multiplicity treatment for this joint gate in `spec-baseline.md`.

7. **MEDIUM — The current-milestone deliverables and acceptance criteria still describe the superseded sub-block architecture.**

   **Issue:** Section 11 still asks the harness for non-overlapping “sub-block” scheduling; section 15 expects a `sub-block type` CSV field and tests that sentinel and diagnostic sub-blocks do not overlap; section 2.3 says L3 runs in diagnostic sub-blocks. Section 6.6 also still calls the L4 nonce an idempotency key, and the L4 text points to the superseded `analysis-spec.md` rather than the three-file freeze contract.

   **Why it matters:** These are executable acceptance requirements for the node currently being delivered. An implementer can satisfy them while rebuilding the rejected v4 design or adding a retry/dedup assumption the route does not provide.

   **Suggested fix:** Sweep the entire plan for the old vocabulary and contract. Make the schema record `block_id`, `block_type`, treatment/session/pair identity, quarantine intervals, and block validity. Add acceptance tests for full-timeout launch fit, no collector overlap, conservative `timer_late` accounting, and diagnostic quarantine/carryover handling. Replace every idempotency reference with correlation/reconciliation semantics and point to the correct frozen spec.

8. **MEDIUM — Two falsifiability statements still overstate what finite observation can refute.**

   **Issue:** The validity register says a `timer_late > 2%` block is void, but it does not carry forward the earlier rule that such a block constrains the threshold below its achieved load. Separately, research section B.3 calls the absence of spontaneous low-load episodes in a finite multi-window baseline a “true falsifier” of the prediction that a low load threshold may miss such episodes. Three clean windows can contradict a claim that episodes are currently frequent, but they cannot falsify the historical observation or the possibility of rarer episodes without a pre-registered frequency/duty-cycle estimand and adequate exposure.

   **Why it matters:** The first omission permits unsafe missing-data handling in the final register; the second converts non-replication into a stronger universal claim than the experiment supports.

   **Suggested fix:** In the register, state explicitly that instrumentation-invalid blocks are “not certified safe” and cap the threshold below their achieved load. In research, replace “true falsifier” with a bounded claim: Phase 0 estimates an upper bound on episode frequency or duty cycle over a defined operating context. Pre-register the minimum episode rate the exposure is intended to exclude; otherwise report non-replication as inconclusive about rare recurrence.

## Verdict

CHANGES REQUESTED — address items above
