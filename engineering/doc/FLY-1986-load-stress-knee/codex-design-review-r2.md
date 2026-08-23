# Design Review — plan.md (Round 2)

Date: 2026-08-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

V2 substantively resolves most Round 1 findings: Phase 0 is now appropriately cautious, the endpoint/source audit is much more accurate, and the control, safety, and evidence plans are markedly stronger. Approval is still blocked because the interleaved design cannot measure hysteresis as claimed, the stated cadence/duration cannot statistically certify the SLO, and the one-cycle production phase cannot produce the uncertainty-bounded production threshold promised to FLY-1971.

## What's Good (Keep)

- Keep Q1 as a decision about whether load average is an adequate admission signal, with mechanism attribution explicitly moved to Q6/another issue.
- Keep the explicit limits on process-wide CPU, common-queue latency, and `lsof`; these are mechanism clues, not event-loop measurements.
- Keep the multi-window Phase 0, including a window more than four hours after restart and a legitimate nonstationary/inconclusive outcome.
- Keep state-isolation versus resource-isolation explicit for the 529 room, and retain the separate-host versus founder-gated same-host choice.
- Keep interleaved contemporaneous controls for the dose-response experiment, achieved-load analysis, unstable-block retention, and repeated cycles.
- Keep the correction from individual-sample tests to block/episode-aware analysis, equivalence testing, MIE/power planning, and confidence-bounded knees.
- Keep the per-endpoint auth/side-effect table, dedicated L4 reuse path, L5 nonce, token-redaction contract, configurable target, and corrected `/health` query accounting.
- Keep the independent stress-process supervisor, exact PID/start-time fencing, admission quiescence before production stress, launchd-respawn detection, and acknowledgment that alert notice is coordination rather than protection.
- Keep the re-entry path for outcomes A/N and the explicit statement that this milestone does not close FLY-1986.
- The committed CSV reproduces the reported sample count, latency percentiles, load range, and the document's stated 63.56% calculation exactly; this is a major auditability improvement.

## Issues & Recommendations

1. **[HIGH] The interleaved-control design and the hysteresis design are mutually incompatible.**

   **Why it matters:** A zero-added-load block between every treated block is a washout/reset attempt. If it succeeds, each treatment starts near baseline and there is no continuous rising/falling state trajectory from which to estimate hysteresis. If it does not succeed, the post-treatment zero block is contaminated by carryover and is not an untreated control for the next treatment. Randomizing tier order within a cycle further removes the meaning of “upward” and “downward” curves. Section 9's claim that failure to recover at zero means “not a load phenomenon” is also too strong: load may trigger a durable positive-feedback state even when current load no longer maintains it.

   **Suggested fix:** Split this into two experiments. Use randomized/interleaved, fully washed-out blocks for Q1/Q2 dose response; require baseline recovery before the next treatment and use pre-treatment controls for causal contrasts. Separately run repeated monotone up-then-down trajectories for Q3, with only pre/post baseline blocks and direction order counterbalanced across runs. If zero does not recover, report recovery below the observed range/carryover or an absorbing state—not proof that load did not trigger it.

2. **[HIGH] `skipped_inflight` does not by itself produce the claimed unbiased availability estimate, and the two collectors have no shared concurrency contract.**

   **Why it matters:** During a 30-second request, fourteen scheduled two-second probes are skipped precisely because the system is slow; excluding them biases availability upward, while automatically labeling them failures assumes the server could not have served another request. The plan does not define how skipped ticks enter `b` or block SLO probability. It also allows a 60-second low-cadence latency request and the availability sentinel to overlap unless “one in flight” is global across both collectors, recreating probe pile-up.

   **Suggested fix:** Define the wall-time estimator exactly. Prefer an endpoint-SLO-deadline sentinel (for example 500 ms for L1 and 2 s for L2) that cancels at the decision deadline, so it cannot overlap the next scheduled tick; measure long-tail latency in separate diagnostic blocks. If both collectors remain concurrent, enforce one global per-endpoint in-flight budget and predefine how every scheduled, skipped, canceled, failed, and completed tick contributes to the estimator and exposure time.

3. **[HIGH] The sample cadence and block duration cannot certify §5.2's p95 and ≤1% failure-probability requirements.**

   **Why it matters:** A three-minute measurement block yields at most 90 two-second sentinel opportunities and only 18 ten-second latency samples before skips/censoring. Even under an unjustified independence assumption, zero failures in 90 observations has a one-sided 95% upper bound of about 3.27%, not 1%; pooling three repeats gives 270 and still about 1.10%. Serial correlation makes the effective sample size smaller. A p95 from 18 observations is effectively the maximum, and a censored p95 may be unidentified. Three blocks per tier are also too few for a reliable block bootstrap unless a power calculation proves otherwise.

   **Suggested fix:** Derive measurement duration and repetitions from the final SLO/MIE and correlation assumptions, with three cycles only a floor. Either lengthen exposure enough to certify 1%, relax the 1% requirement, or report that it cannot be certified. Express p95 compliance as the equivalent probability `P(latency > SLO) <= 5%` using scheduled sentinel outcomes; use survival bounds or report percentiles as lower bounds when censoring prevents identification.

4. **[HIGH] Phase 2's one-cycle/42-minute design cannot produce the production threshold the plan promises.**

   **Why it matters:** Phase 1 explicitly cannot set the production threshold, yet Phase 2 has only one pass over three treated tiers. That is insufficient for the confidence interval, block-level uncertainty, hysteresis, or false-admit/false-refuse claims in §5. It also contradicts §11's correct rule to reduce tiers rather than replications.

   **Suggested fix:** Make Phase 2 replication power-driven and never less than the minimum used for threshold inference; reduce it to fewer strategically selected tiers if necessary. Alternatively define Phase 2 as a transferability check only and do not emit a production threshold from it—but then add a later replicated production-calibration phase that does.

5. **[MEDIUM] The analysis is still a menu of methods rather than an executable pre-registration.**

   **Why it matters:** “Segmented / logistic / isotonic,” “block bootstrap or randomization test,” “acceptable” classification errors, and unspecified α/power/MIE/equivalence bounds leave enough researcher degrees of freedom to change the conclusion after seeing data. Selecting and evaluating a load threshold on the same cycles will also understate false-admission/rejection error. The A/A gate says “measurable difference,” which can pass merely because the test is underpowered; it needs an equivalence/no-harm margin.

   **Suggested fix:** Require a versioned analysis-spec artifact before the first treated block: one primary model/estimator, breakpoint definition, resampling unit/count, missing/censored/unstable-block rules, multiplicity rule, α/power/MIE/equivalence margins, and numeric acceptable false-admit/refuse bounds. Evaluate Q1 out of sample, for example leave-one-cycle-out, and make A/A a powered equivalence test. Exploratory alternatives may be reported but cannot select the verdict.

6. **[MEDIUM] L3/L4/L5 still lack an execution cadence and L5 starts its clock too late.**

   **Why it matters:** The endpoint table specifies timeout but not samples per block, so L3/L4 p95 power and external quota/message side effects cannot be assessed. Repeated L4 sends can themselves create Discord rate limiting, channel/Lead feedback, and a new workload. For L5, `t0 = CLI return` excludes enqueue/CLI time and may occur after the recipient has already ACKed; that measures residual post-return time and can collapse a real delivery to approximately zero.

   **Suggested fix:** Pre-register per-block cadence/count and a total side-effect budget for L3–L5, with rate-limit responses separated from Bridge delay. Set L5 `t0` immediately before the stimulus, or use the nonce row's authoritative `created_at`; report enqueue-to-ACK and, if useful, CLI-return-to-ACK as distinct metrics. Confirm whether `delivered_at` was already set when the CLI returned.

7. **[MEDIUM] `research.md` still contradicts the corrected non-causal framing, and the 63.6% wall-time denominator is misaligned.**

   **Why it matters:** B.2/B.3 still call process CPU a single worker thread, infer that load 8–9 means only 8–9 cores were busy, declare that the Bridge was not CPU-starved, and name Bridge thread occupancy as the control variable. Load average is not a count of busy cores, and `top` is process-wide; these claims contradict plan §2.4 and research B.5/F. Section C still says the plan must distinguish mechanisms and gives the old strong M1/M2/M6 remedies. Separately, the 63.6% formula includes the first request's 20.95 seconds in the numerator but starts its denominator at that request's completion timestamp. Using the approximate request-start boundary gives about 62.3%, subject to the CSV's one-second timestamp precision. The independent-client result is asserted but only its script—not timestamped output—is committed.

   **Suggested fix:** Make all of research B/C consistent with the “mechanism clue only” boundary; say “process CPU” and remove busy-core/control-variable conclusions and remedy claims. Recalculate the wall-time fraction on aligned start/end boundaries, label the old value as the original estimator, and preserve the conclusion's unchanged evidence grade. Commit the second client's actual output/metadata if it remains cited as observed evidence.

8. **[MEDIUM] Safety and acceptance still contain unresolved or non-causal checks.**

   **Why it matters:** The production `pressure_hold` read is a safety-critical prerequisite but remains undecided while this milestone promises an implementable harness. Output-rate and RSS “numeric” limits are still placeholders. Section 6 does not say whether admission pause/quiescence applies only to stress phases; applying it to three one-hour read-only Phase-0 windows contradicts “no founder window” and materially blocks real work. Acceptance item 5 treats unchanged `pressure_hold`/pause/session counts as proof of zero writes, but those values may legitimately change due to concurrent production activity and equality neither proves nor is required for harness read-only behavior.

   **Suggested fix:** Resolve the hold source before harness implementation (a tested SQLite URI `mode=ro` path is sufficient if approved), pin all numeric guards, and scope admission pause/quiescence explicitly to same-host stress phases. Prove zero-write behavior with endpoint/method allowlisting, read-only DB-open enforcement, isolated-slot mutation sentinels, and tests that fail on any mutating call; treat production before/after state changes as observed context, not causal proof.

9. **[LOW] Time-budget and tier semantics need mechanical correction.**

   **Why it matters:** `3 × (6 + 7) × 6 minutes` is 3.9 hours, not 7.8; 7.8 hours corresponds to six directional cycles, consistent with “up and down each ≥3.” Also the overshoot rule “1.5× target” is undefined for the zero-added-load tier, and nominal values 8/12/etc. are not clearly absolute load targets or added-load targets when ambient load already spans 5–11.

   **Suggested fix:** Recompute the budget after separating dose-response and hysteresis runs. Define tiers as absolute achieved-load bands or as worker-count treatments with achieved load only as the measured x-axis; give the zero-control block its own ambient-load stability/abort rule.

## Verdict

CHANGES REQUESTED — address items above
