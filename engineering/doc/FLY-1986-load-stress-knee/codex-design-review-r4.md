# Design Review — plan.md (Round 4)

Date: 2026-08-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

V4 closes most of Round 3 at the conceptual level: the sham arm, fail-closed baseline gate, three-stage pre-registration, Q1 split, and one-hour lease handling are all material improvements. It is not yet executable as written because diagnostics can cross supposedly disjoint sub-blocks, the sentinel allocation cannot power L2 at the stated floor, the restored L4 request does not match the source route, and the E1/E2/Q1-full protocols still contain initialization or authorization gaps.

## What's Good (Keep)

- Keep the explicit distinction between the historical 62.3% transaction-time occupancy and the scheduled-tick `b`; the old evidence is now correctly motivational rather than a Phase 0 verdict.
- Keep the randomized `N=0` sham arm and the causal contrast against sham within cycle. This repairs the missing untreated measurement window.
- Keep `contaminated_next` separate from `persistent_effect`, and keep the rule that persistent harm cannot disappear through exclusion.
- Keep deletion of Outcome C and the use of a confidence upper bound for the Phase 0 gate. A baseline that fails the production SLO cannot yield a production admission threshold.
- Keep the separation of ASC and DESC initialization, the no-restart reset rule, and the explicit inconclusive outcome when recovery cannot be established.
- Keep L4 diagnostic-only. The documented 39.30% upper bound for zero failures in six observations correctly demonstrates why it cannot participate in a 5% block verdict.
- Keep the three pre-registration freezes and permanent exclusion of pilot observations from primary inference.
- Keep the distinction between Q1-concurrent and Q1-full, especially the warning that concurrent separability cannot positively validate a pre-admission policy.
- Keep the source-derived one-hour admission-pause limit, 50-minute session cap, continuous lease monitoring, and independent supervisor.
- Keep `exploration.md` as explicitly superseded historical material rather than silently editing away the reasoning trail.

## Issues & Recommendations

1. **[HIGH] A 60-second diagnostic can still escape a 30-second “disjoint” sub-block.**

   **Why it matters:** A diagnostic launched 10 or 20 seconds into a diagnostic sub-block may remain client-side in flight for another 50 or 40 seconds, overlapping the next sentinel sub-block. Canceling it at the boundary would change the declared 60-second censoring contract, and even cancellation would not stop synchronous Bridge work already running. Therefore “only one collector type is ever active” and “no sentinel tick is skipped because of diagnostics” do not follow from assigning 30-second labels. The powered sparse/full A/A test can bound an observed difference between probe modes, but it cannot prove absence of server-side outstanding work or an absolute no-probe observer effect.

   **Suggested fix:** Define boundary admission and drain semantics. The cleanest design is to randomize collector types in separate measurement blocks long enough for their timeout, followed by a pre-registered quiet/washout interval; otherwise prohibit starting a diagnostic unless its entire timeout fits before the boundary, which makes 30-second sub-blocks incompatible with a 60-second timeout. Treat A/A as an empirical no-harm comparison under specified probe cadences, not proof that no server pile-up exists.

2. **[HIGH] The post-split sample-size arithmetic cannot certify the L1/L2 block verdict, and `timer_late` is informative missingness.**

   **Why it matters:** The n=90 example assumes all 180 measurement seconds are L1 sentinel time. With the example 70/30 split, only about 126 seconds remain: roughly 63 L1 ticks and only 25 L2 ticks. Even with zero violations, the independent-sample one-sided 95% upper bounds are about 4.64% for L1 and **11.29% for L2**, before accounting for serial correlation. Thus the three-minute floor cannot certify both §5.2 endpoints. Separately, removing `timer_late` ticks from the denominator is not neutral: host load can cause scheduler lateness, so treatment-dependent ticks are preferentially removed. Voiding high-`timer_late` blocks can then discard exactly the harmful high-load observations.

   **Suggested fix:** Derive exposure separately for L1 and L2 after the final sentinel/diagnostic allocation and correlation adjustment; update §4.4/§5.3 with actual scheduled counts. For the safety/certification analysis, include `timer_late` in a worst-case bound or count it as a violation; report the best-case bound separately. A block voided because instrumentation failed must be “not certified safe” and constrain the threshold below it, never simply disappear from the dose-response evidence.

3. **[HIGH] The L4 “executable protocol” does not match the code, and the claimed idempotency does not exist.**

   **Why it matters:** Source verification shows `POST /api/chat-threads/send` requires `issueIdentifier` or `issueId` plus **`channelId`, `leadId`, `projectName`, and `text`**. V4 specifies `{issueIdentifier, message}`, which will return 400. The route resolves/reuses a thread; it does not accept a pinned thread identifier directly. A successful reuse response should be checked as `200 {threadId, messageIds, created:false}`. Putting a unique string in `text` provides a reconciliation nonce, not idempotency—the route has no deduplication contract, so retrying can send a duplicate.

   **Suggested fix:** Make the table byte-accurate to `LeadReplyByIssueRequest`: name every required field and the exact token environment variable, pre-seed the issue-to-thread row, require the expected `threadId` and `created:false`, and call the unique value a correlation nonce. Prohibit automatic retry after timeout; reconcile the nonce first, and classify late/duplicate/failed delivery explicitly. A `late_delivered` observation should remain censored/lower-bounded diagnostic evidence rather than being omitted from the tail entirely.

4. **[HIGH] E1 has no treated ramp/stabilization interval, and persistent harm does not yet constrain the threshold.**

   **Why it matters:** The E1 budget is `rest 3 min + measurement 3 min`. The rest must be at `N=0` to prove washout, but the plan does not then allow the nonzero workers to run for the required load1 stabilization period before measurement. Starting workers at measurement onset mixes ramp/transient behavior with the steady-state response; starting them during rest invalidates washout. Adding the missing three-minute treated ramp makes a seven-arm cycle about 63 minutes, exceeding the 50-minute same-host session cap. In addition, §5.6 still defines the safe threshold only from in-window SLO probability; an `N` that passes during measurement but causes `persistent_effect` afterward can still be labeled safe.

   **Suggested fix:** Give every arm three distinct stages: baseline/washout, treatment ramp with no inferential sampling, then measurement after the achieved-load stability gate. Re-budget and either reduce arms per session with session-stratified randomization plus a sham in every session, or use the separate-host option. Make persistent-effect probability/recovery time part of the primary safety rule: a level with unbounded or excessive persistent harm cannot define a safe threshold even if its treatment window passes.

5. **[HIGH] E2's sweeps are not independently initialized under the stated pair protocol.**

   **Why it matters:** Only a between-pair washout gate is specified. In an ASC→DESC pair, DESC inherits the entire ASC history before its peak dwell; in a DESC→ASC pair, ASC requires a proven return to baseline after DESC, but no within-pair recovery gate is defined. Those are different initial conditions, so pair-order “counterbalancing” does not make the ASC/DESC contrast exchangeable. A complete 11-block pair also exceeds 50 minutes, so same-host sweeps must span sessions, introducing another time/session effect that the estimand does not address.

   **Suggested fix:** Initialize each sweep independently: prove baseline, run its prescribed conditioning, collect the sweep, then prove recovery before any next sweep. Pair adjacent/time-matched independently initialized sweeps and stratify/randomize order by session; include session/pair in the analysis. If instead the desired estimand is a continuous up-then-down trajectory, say so and accept that order cannot be counterbalanced—then control time effects through replicated sham trajectories rather than claiming independent initialization.

6. **[HIGH] Q1-full is not executable under the admission guard, and its false-refuse label is counterfactual.**

   **Why it matters:** Same-host stress requires an active admission pause that rejects all new runners, while Q1-full requires randomly admitting one representative runner. The plan does not specify an authorized path that admits only the experimental candidate while keeping unrelated work quiescent; bypassing the gate would test a different action. Also “false refusal = did not admit, but it actually would have been safe” is not observable for an individual no-admit opportunity. Randomization identifies group-level potential-outcome risks, not both outcomes for the same opportunity.

   **Suggested fix:** Give Q1-full its own execution and authorization protocol: environment, candidate-workload distribution, mechanism for isolating unrelated admissions, randomization unit, horizon, stopping rules, and whether the real admission path is exercised. Define causal policy error estimands in potential-outcome terms and estimate them from randomized arms with stated assumptions; do not attach an observed individual false-refuse label to controls. If no safe selective-admission mechanism exists, leave Q1-full explicitly out of scope and retain only the negative Q1-concurrent result.

7. **[MEDIUM] The admission-lease and recovery guard still fail open when `/health` is unavailable.**

   **Why it matters:** `remainingSeconds` is read from the L1 response body. Under the very failure being induced, L1 may time out and provide no body, so an independent supervisor cannot rely on that field to know when the lease is approaching expiry. The preconditions also do not require enough remaining lease at stress start. Finally, §6.6 says L1 must recover to “the §6.1 recovery criterion,” but v4 no longer defines any recovery criterion there and says nothing about L2 or a sustained recovery duration.

   **Suggested fix:** At pause creation/preflight, capture the authoritative expiry and convert it to a conservative supervisor-local monotonic deadline; require `remaining >= planned_stress + recovery_budget` before launch and fail closed on missing/stale health. Define a numeric, sustained post-stress recovery gate for both L1 and L2, plus memory/pressure state, that fits inside the reserved ten-minute window.

8. **[MEDIUM] Q4 and the evidence register still make mechanism claims that the plan says external probes cannot support.**

   **Why it matters:** §5.7 says endpoint order implies queue saturation or a shared resource, contradicting §2.4's correct mechanism boundary. L3 and L4 no longer have verdict thresholds, so they cannot “cross their own thresholds” as written; their randomized diagnostic sub-blocks are not simultaneous with sentinel observations either. `research.md` also retains a final sentence saying B.2 “weakens M1,” directly contradicting its corrected M1 row, and its proposed falsifier—monotonic degradation under added load—would not refute the existence of separate spontaneous low-load episodes. Section 9 row 1 should not send the team back to the original unreplicated design merely because the historical episode does not recur.

   **Suggested fix:** Keep Q4 purely descriptive: pre-register diagnostic degradation summaries and timing uncertainty, and call endpoint patterns mechanism clues only. Remove the residual “weakens M1” and use a genuine falsifier for the low-load prediction. If Phase 0 passes, proceed with the rigorous v4 E1/E2 design; do not revive the original single-scan design.

## Verdict

CHANGES REQUESTED — address items above
