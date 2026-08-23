# Design Review — plan.md (Round 3)

Date: 2026-08-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

V3 resolves the stated Round 2 findings in direction and is substantially closer to a defensible experiment: E1/E2 are separated, production thresholding has a replicated phase, and the analysis/safety contracts are much more explicit. Approval is still blocked by internal contradictions in the collector schedule and L4 inference, an E1 control arm that does not identify the zero-load contrast, and an E2 counterbalancing scheme that cannot be initialized as written; the Phase 0 gate and admission decision estimand also need tightening before this can be called executable.

## What's Good (Keep)

- Keep E1 dose-response and E2 hysteresis as separate experiments. That is the correct structural repair to the central Round 2 problem.
- Keep scheduled sentinel ticks as the availability denominator, explicit met/missed/error outcomes, and censored long-tail samples as diagnostic rather than verdict data.
- Keep the arithmetic table for zero-failure upper bounds, the statement that serial correlation reduces effective sample size, and the requirement that duration and replication come from SLO/MIE/power rather than the three-minute/three-cycle floors.
- Keep the versioned single-primary-method analysis specification, block-level inference, equivalence tests, multiplicity rule, and out-of-sample evaluation requirement.
- Keep Phase 2 as transferability-only and Phase 3 as the replicated production threshold phase. This now matches what each phase can support.
- Keep L5's pre-stimulus clock, nonce, primary enqueue-to-ACK metric, 200 ms precision disclosure, and the explicit invalidation of the post-CLI metric when ACK already happened.
- Keep the engine-enforced `mode=ro` pressure-hold read, PID/start-time fencing, independent process-group supervisor, pinned resource limits, and mechanism-based no-write acceptance tests.
- Keep the corrected 62.3% arithmetic alongside the superseded estimator, the committed independent-client output, and the explicit record of previously circulated corrections.
- Keep the honest cost statement and the rule to reduce tiers before reducing inferential replication.

## Issues & Recommendations

1. **[HIGH] The two-collector schedule cannot satisfy its own no-skip and one-in-flight guarantees.**

   **Why it matters:** The sentinel runs every two seconds, while a diagnostic request may remain in flight for 60 seconds. Starting a diagnostic merely because the sentinel is idle at that instant does not help: at the next sentinel tick, the harness must either skip the tick, exceed the shared per-endpoint in-flight budget, or cancel the diagnostic after less than two seconds. L4 is an additional direct contradiction: its sentinel deadline is five seconds, longer than the claimed two-second tick interval, while §2.3 separately says L4 runs every 30 seconds. Client-side abort also does not cancel work already running in the Bridge; `/health` ignores the request object and performs synchronous work, so an abort can settle `fetch` while server-side work or queued sockets remain.

   **Suggested fix:** Put sentinel and long-tail diagnostics in disjoint, randomized collection blocks, or define an explicit preemption policy and accept the resulting diagnostic censoring bound. Give every endpoint its own interval strictly longer than its deadline, anchor ticks to a monotonic schedule, and define timer-late/missed-schedule outcomes. Call the budget client-side unless server instrumentation proves request completion; test server-side outstanding work or rely on the powered sparse/full A/A gate before claiming that cancellation prevents probe pile-up.

2. **[HIGH] E1 still lacks an untreated treatment-window arm, and its washout rule does not prove return to baseline.**

   **Why it matters:** Every randomized measurement window receives a nonzero worker treatment. A preceding zero block controls level, but not the generic zero-to-next-window time transition; with the observed roughly 190-second spontaneous cycle, conditioning on a recovered pre-block can create regression-to-the-mean even without added load. Randomization among nonzero `N` identifies contrasts among those levels, not the absolute effect versus no treatment. Although §4.2 lists `N=0`, §4.4 budgets six treatments plus seven controls, so `N=0` is not actually a randomized sham arm. The recovery rule—L1 violation rate no greater than the Phase 0 upper bound—is neither an equivalence test nor a multi-endpoint/covariate washout proof, and `carryover` does not unambiguously say whether the preceding causal treatment or the following contaminated block is being labeled.

   **Suggested fix:** Randomize sham `N=0` measurement windows alongside nonzero `N`, with identical ramp/rest/measurement timing, and update the diagram and budget. Pre-register a powered baseline-equivalence washout test using the outcomes needed for inference, identify the contaminated next block separately from the preceding treatment's persistent-effect outcome, and count persistent degradation as harm rather than silently excluding it.

3. **[HIGH] E2's “direction counterbalancing” is not a physically defined experiment.**

   **Why it matters:** The specified trajectory starts at baseline, rises to the peak, then descends. A “down-then-up” trajectory cannot start from baseline without first conditioning the system at the peak; that conditioning creates a different history and is currently absent from the protocol. If every run is up-then-down, direction is confounded with elapsed time, thermal state, and accumulated exposure. If a trajectory ends without recovery, the next trajectory is also not independent, yet the plan requires at least three independent trajectories and forbids a Bridge restart.

   **Suggested fix:** Define independently initialized ascent and descent sweeps: ascent begins after a proven baseline; descent begins after a fixed peak-conditioning dwell. Counterbalance the order of these sweep pairs, require a powered washout/independence gate between them, and stop with an inconclusive/absorbing-state result when recovery cannot be established. State exactly which matched-load block pairs estimate hysteresis.

4. **[HIGH] Outcome C passes Phase 0 even though its baseline already fails the final SLO.**

   **Why it matters:** Outcome C is `5% < b <= 20%` and proceeds to stress, but §5.2 defines acceptable service as a one-sided upper bound at or below 5%. If zero-added-load service already violates that SLO, there is no load threshold whose upper confidence bound can pass; subtracting background may estimate incremental harm but cannot manufacture an admissible operating point. The recovery guard can likewise call a zero block “recovered” at a baseline near 20%, which is not a safe recovered state under the plan's own SLO.

   **Suggested fix:** Use confidence bounds, not a point estimate, for the Phase 0 gate. Any baseline whose upper bound exceeds the production SLO should enter the diagnose/fix/retest path for a threshold-producing run. If the team still wants a scientific stress run under Outcome C, label it separately, require explicit risk approval, and state that it cannot emit an admission threshold until baseline service passes.

5. **[HIGH] Q1 is not yet operationalized as the admission decision the gate actually makes.**

   **Why it matters:** The current gate reads `loadavg()[0]` before admitting a runner. V3 proposes classifying service from concurrent achieved load after worker treatment, but does not define the feature timestamp, forecast horizon, unit/label for false-admit and false-refuse, or whether the target is current health versus the consequence of admitting one more runner. Leave-one-cycle-out validation cannot repair a label that is unavailable at decision time. A/B agreement at the same achieved load tests workload transferability; it does not alone prove that pre-admission load predicts the marginal admission outcome.

   **Suggested fix:** Pre-register the exact policy estimand: for example, “given load1 immediately before an admission opportunity, predict whether admitting one additional representative runner causes the Bridge SLO to fail within H minutes.” Record that pre-action feature and randomized admission increment, define false-admit/refuse labels and horizon, and evaluate the complete threshold-plus-margin policy out of sample. If only concurrent service classification is feasible, narrow Q1 and explicitly say it cannot by itself calibrate FLY-1971's admission action.

6. **[HIGH] L4 cannot meet the block SLO at its declared cadence, and its executable protocol has regressed.**

   **Why it matters:** Six L4 observations per block with zero violations have a one-sided 95% zero-failure upper bound of **39.30%**, not 5%. Thus no L4 block can pass §5.2 as written. Treating L4 as a two-second sentinel would violate its six-per-block/500-message budget and its five-second deadline. In addition, §2.1 no longer contains the full protocol promised after Round 1: exact request body/thread identifier, token environment source, expected success/error response, connection-reuse policy, idempotency/reconciliation after client timeout, and diagnostic timeout are missing. A canceled POST may still send to Discord, so attempted requests are not the same as realized side effects.

   **Suggested fix:** Either power L4 over a pre-registered higher-level aggregation with cluster-aware uncertainty or demote it to a diagnostic outcome that cannot determine the block SLO. Restore a per-endpoint executable protocol table. For L4, use a unique idempotency/reconciliation key, count realized Discord sends against the budget, and define how late server completion after client cancellation is classified.

7. **[MEDIUM] The pre-registration freeze occurs too late for Phase 0 and A/A decisions.**

   **Why it matters:** `analysis-spec.md` is frozen “before the first treated block,” but Phase 0 data are already used to choose A/B/C/N, estimate correlation, test A/A equivalence, set sample size, and decide whether stress is allowed. That permits margins and analysis rules for those gates to be chosen after observing the very data they judge. The current milestone also requires the harness to emit an A/A equivalence conclusion while the no-harm margin is only an example and the numeric spec is explicitly excluded.

   **Suggested fix:** Split pre-registration in two. Freeze a baseline/A/A spec before the first Phase 0 window, including the exact `b` estimand, confidence method, nonstationarity and no-harm margins, and gate rules. Pre-register the tier-mapping pilot and how it may change the final design, permanently exclude pilot data from primary inference, then freeze the stress-analysis spec before the first inferential treated block.

8. **[MEDIUM] The admission-quiescence guard expires before the proposed same-host sessions end.**

   **Why it matters:** Source verification shows both `StateStore.setAdmissionPause()` and `POST /api/admission/pause` reject durations above **3,600 seconds**. The proposed 6.6 hours split into three sessions averages about 132 minutes per session, yet §6.2 does not abort on pause expiry. The alternative “run when no new work can arrive” is not a mechanically provable guard. A lease can therefore expire mid-stress and expose a newly admitted runner to the experiment.

   **Suggested fix:** For same-host phases, require an active pause and authoritative quiescence throughout, continuously monitor `remainingSeconds`, and abort with enough recovery time before expiry. Constrain sessions below the lease or specify an explicitly authorized, independently supervised renewal protocol; remove the unverifiable scheduling alternative.

9. **[MEDIUM] The evidence package still overstates the 62.3% estimand and retains contradictory mechanism claims.**

   **Why it matters:** The corrected 62.3% is the share of this serial probe run's elapsed time spent inside requests whose latency was at least one second. It is not directly the new sentinel estimand `P(latency > 500 ms)` at scheduled arrival times, so the existing data cannot be declared an Outcome A under the v3 gate. `research.md` still says the initial measurement “overturned” the independent variable, says load and service can be “completely decoupled,” and claims high process CPU weakens M1; process CPU near one core does not exclude host scheduling contention. `exploration.md` still says the stress test must distinguish M1/M2/M4, describes `/health` as roughly three queries, equates `R << T` with a switch, and retains stale after-the-fact runner and production-order guards despite its partial supersession warning.

   **Suggested fix:** Rename 62.3% as transaction-time occupancy and treat it only as motivation; define and compute the v3 `b` separately, at the v3 deadline, from scheduled sentinel ticks. Downgrade “overturned/decoupled/weakens M1” to premise-threatening observations unless a controlled exclusion supports them. Make `exploration.md` consistently historical with explicit strike-throughs, or update its active requirements and safety sections to match plan v3 so the founder and contractor receive one coherent package.

## Verdict

CHANGES REQUESTED — address items above
