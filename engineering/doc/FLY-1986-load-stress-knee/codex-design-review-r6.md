# Design Review — plan.md (Round 6)

Date: 2026-08-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

V6 substantively resolves all eight Round 5 findings: E3 now has an explicit optional role, the nominal recovery arithmetic is corrected, dependence is acknowledged, E2 has stabilized tiers, quarantine no longer claims server drain, and the joint Phase 0 gate is coherent. Approval is still blocked by statistical and safety contracts that are not executable as written—most importantly sequential use of fixed-horizon confidence bounds, an externally unavailable “authoritative” lease expiry, the disappearance of the admission-quiescence precondition, and a single ordered Phase 2 run that cannot establish transferability.

## What's Good (Keep)

- Keep E3 optional and make “Q4 not measured” a required report outcome when it is omitted. This is the right cost boundary.
- Keep E3 separate from E1. The explicit baseline, ramp, diagnostic exposure, quarantine, and carryover concepts are the correct ingredients even though their timing still needs correction.
- Keep labeling the 1.98% and 2.95% bounds as independence-only and deriving the nominal effective-sample-size target explicitly.
- Keep the stabilized-tier version of E2. Using the same ramp/stability contract as E1 makes contractor execution and interpretation materially safer.
- Keep the two-endpoint Phase 0 conjunction and the rule that L1 passing cannot mask L2 failing.
- Keep quarantine terminology and the post-quarantine carryover test; the document now correctly refuses to infer server drain from a client timeout.
- Keep the expanded block/session schema and the new positive acceptance tests for timeout fit, `timer_late`, and contamination.
- Keep research section B.3’s bounded non-replication claim. It now distinguishes “not frequent in this context” from “never occurred or cannot recur.”

## Issues & Recommendations

1. **HIGH — The plan still lacks a confidence procedure with valid coverage under serial dependence.**

   **Issue:** Sections 2.2 and 5.3 use an effective sample size of about 59 and convert the nominal tick counts into design-effect tolerances. That is useful planning arithmetic, but there is no general rule under which replacing `n` with `n/deff` makes the exact binomial upper bound retain 95% coverage for clustered Bernoulli failures. Section 5.4’s block bootstrap/randomization language concerns treatment effects; it does not define the per-window/per-block one-sided SLO bound used by Phase 0, recovery, and the final threshold.

   **Why it matters:** Every “certified safe” decision rests on that upper bound. A variance-inflation heuristic can underestimate tail risk when failures arrive in long episodes—the exact behavior the preliminary evidence suggests.

   **Suggested fix:** State that `n/deff` is planning-only. Require `spec-baseline.md` and `spec-stress.md` to freeze a one-sided procedure whose coverage is justified for the declared dependence structure and independent unit, plus a simulation or calibration check against the pre-registered worst-case episode process. The method may be a defensible cluster/block procedure or another dependence-aware model, but it must directly produce the SLO upper bound; it cannot obtain “exact” coverage by inserting an effective `n` into a binomial formula.

2. **HIGH — The recovery and carryover gates are ambiguous sequential tests, and “worst case ≈300 seconds” is false.**

   **Issue:** Section 6.1 says to accumulate recovery ticks until ordinary one-sided 95% bounds fall below the SLO, then sustain the conditions for 120 seconds. Repeatedly checking a fixed-horizon confidence interval and stopping when it first passes is optional stopping; its nominal coverage does not survive that rule. Also, 180 seconds of certification plus 120 seconds of sustain is the zero-failure, independence-only minimum—not a worst case. With failures or a larger dependence allowance, certification can take longer or never occur. The post-quarantine rule similarly says to extend recovery or stop without defining subsequent looks.

   **Why it matters:** The safety supervisor can falsely certify recovery through repeated looks, or different executors can make different decisions from the same trace. The ten-minute reserve has no defined fail outcome when recovery is not certified before the lease boundary.

   **Suggested fix:** Choose one contract before execution: either collect a precomputed fixed exposure and evaluate once, or use an anytime-valid confidence sequence/alpha-spending rule with a hard deadline. Define exactly what is recomputed during the 120-second sustain phase and what happens when the deadline arrives: stress remains stopped, the session is not certified/reusable for a threshold, and the inability to recover is reported as harm. Replace “worst case” with “nominal zero-failure minimum.” Apply the same fixed-look or sequential-valid rule to washout and post-quarantine gates.

3. **HIGH — Mandatory gates and recovery remain missing from the arm/session and total-time arithmetic.**

   **Issue:** An E3 arm is declared to be `180 + 180 + 180 + 60 = 600` seconds, yet the diagram and prose include a powered post-quarantine control gate after those 60 seconds. That gate has no duration in the sum. Four nominal E3 arms therefore consume the entire advertised 40 minutes before any gate time or final recovery. E2’s 35/40-minute figures omit its required final recovery proof, and the Phase 1 “total” excludes the mandatory post-session recovery windows. More broadly, every 180-second baseline/washout gate is called powered even though its required exposure has not yet been derived under the dependence rule.

   **Why it matters:** The document calls E3 executable and claims compliance with the 50-minute stress-session/one-hour lease envelope, but the required work does not fit the stated arithmetic. It also understates founder/contractor time by at least the mandatory recovery time for each session.

   **Suggested fix:** Give every gate an explicit observation window and count it once. If the next arm’s baseline doubles as the preceding arm’s post-quarantine gate, state that identity and separately budget the final arm’s gate. Recompute session wall time—including pause/quiescence setup and final recovery—and the Phase 1 total. Mark current figures as provisional until the dependence-aware power calculation is frozen, then reduce arms or tiers per session when the powered gates do not fit; do not preserve “four arms” as a requirement.

4. **HIGH — The harness cannot obtain the “authoritative pause expiry” from the HTTP contract described by the source.**

   **Issue:** `StateStore.setAdmissionPause()` internally returns `paused_until`, but `packages/teamlead/src/bridge/plugin.ts` strips that field and returns only `admissionPause.remainingSeconds`. On the POST path that value is the requested duration, not the remaining duration at response receipt. If a supervisor records `response_time_monotonic + remainingSeconds`, it overestimates the real server expiry by the request/processing latency—the dangerous direction, especially on a Bridge already experiencing spontaneous stalls.

   **Why it matters:** The supervisor may believe the pause still protects admissions after it has expired. V6’s fail-closed claims do not cure a locally computed deadline that was optimistic from creation.

   **Suggested fix:** Specify an obtainable conservative deadline. Without changing production code, record the local monotonic time immediately **before** sending the pause POST and set the supervisor deadline to `request_start + granted_duration`; this expires no later than the server lease. A read-only `paused_until` database read can be an additional cross-check, or a later API change can expose the exact timestamp. Add an acceptance test that deliberately delays the POST response and proves the supervisor never extends its deadline by that delay.

5. **HIGH — Admission pause has replaced, rather than accompanied, the required quiescence proof.**

   **Issue:** Section 6.1 only proves that no new runner will be admitted. It does not prove that already admitted/crossing work, dispatcher inflight work, durable launch claims, or readoption candidates have drained. The codebase already exposes authenticated `GET /api/admission/quiescence`, which requires the pause to be active and reports exactly those components; `scripts/host-terminal-cutover.sh` demonstrates two stable-zero snapshots. This precondition was present conceptually in an earlier round but is absent from v6.

   **Why it matters:** Existing work can overlap the treatment, confounding achieved load and service outcomes while also increasing production risk. An admission lease is not a resource-quiescence certificate.

   **Suggested fix:** For same-host stress phases, require: create the pause, establish the conservative deadline, then obtain the authoritative quiescence proof (preferably two zero snapshots separated by a pre-registered interval) before launching any stress worker. A 409/503, nonzero component, timeout, or stale snapshot must fail closed. Budget this setup time inside the lease and preserve the exemption for read-only Phase 0.

6. **HIGH — Phase 2’s single ordered sweep cannot validly decide transferability.**

   **Issue:** Phase 2 remains “four tiers, one pass, pre/post baseline, about 40 minutes,” and Phase 3 only runs if Phase 2 passes. No Q5 estimand, equivalence margin, randomization, or replication is defined. A monotone production sweep again aliases tier with wall-clock order and with the roughly 190-second spontaneous process that motivated abandoning the original scan.

   **Why it matters:** Calling the output a shape-transferability check does not remove the confound. A false failure can block valid production calibration, while a phase-aligned false pass can authorize it; neither direction has quantified uncertainty.

   **Suggested fix:** Pre-register a Q5 estimand and equivalence/non-inferiority criterion. Use a small randomized, replicated subset of E1-style sham/treatment arms on production, with ramps and session blocking, sufficient to test the claimed shape feature. If the cost only permits one ordered sweep, label Phase 2 exploratory/feasibility-only and prohibit it from being a pass/fail gate for Phase 3.

7. **MEDIUM — E3’s serial diagnostic scheduler can manufacture the endpoint ordering Q4 is supposed to describe.**

   **Issue:** The diagnostic collector is serial, nominally runs every 10 seconds, and permits each request to occupy 60 seconds. A slow/censored endpoint can therefore suppress scheduled opportunities for endpoints later in a fixed order. The claimed six L3 and six L4 observations per block are not guaranteed, and realized probe workload can vary with treatment. The proposed pairing to sentinel evidence “by N and session” is also not executable if E1 and E3 use separate sessions unless a matched-session-pair unit is defined.

   **Why it matters:** Apparent “L1 degrades before L4” can be a consequence of request order and informative missingness rather than an endpoint pattern. That would defeat the sole purpose of optional E3.

   **Suggested fix:** Freeze a per-endpoint opportunity schedule and randomized/counterbalanced order, record every scheduled-but-not-launched opportunity, and define the censoring/missingness summary for Q4. Alternatively use endpoint-specific diagnostic blocks, acknowledging the extra matching uncertainty. Define whether E1/E3 sessions are actually mixed or introduce an explicit matched-session-pair identifier; do not claim same-session pairing when the observations cannot coexist in one session.

8. **MEDIUM — Several current contracts were not propagated to the executive and pre-registration sections.**

   **Issue:** The summary still says there are two experiments, the Q4 ownership row and E1 heading say Q4 comes from E1, and section 4.1 is still titled as a split into two experiments, although E3 is now Q4’s only source. The exact sentinel estimator that an earlier round registered has also disappeared: the plan names four outcomes but never writes the worst-case numerator and scheduled-tick denominator. Finally, the `spec-baseline.md` freeze table does not list the newly required design-effect method, joint-endpoint multiplicity, minimum episode rate, or sequential/fixed-look rule.

   **Why it matters:** These are the sections the founder, contractor, and harness implementer are most likely to treat as normative. The current text permits an L1/L2-only E1 report to claim Q4 and permits analysis choices required before Phase 0 to be filled in after seeing Phase 0.

   **Suggested fix:** Update the Q table, summary, headings, and Q4 section to say “two required experiments plus optional E3.” Restore explicit formulas, for example the certification estimate using `(missed + error + timer_late) / scheduled_ticks`, with the best-case diagnostic variant separately defined. Expand the `spec-baseline.md` row to enumerate every rule that must be frozen before the first window.

9. **MEDIUM — Research still grades numerical resemblance from two uncontrolled episodes as a “strong association.”**

   **Issue:** Research B.3 row 1 calls the similarity between the FLY-1971 episode and the new low-load episode a strong association, while the same cell correctly admits different times, different conditions, and no controlled comparison. Two selected episode summaries do not establish association; they establish numerical resemblance.

   **Why it matters:** “Strong association” is likely to be repeated by reviewers without the caveat and again turn an `n=1 + n=1` clue into evidence for a common mechanism.

   **Suggested fix:** Grade it as “cross-episode numerical resemblance / weak mechanism clue” and retain the current caveats. Reserve “association” for repeated paired variation or a controlled comparison.

## Verdict

CHANGES REQUESTED — address items above
