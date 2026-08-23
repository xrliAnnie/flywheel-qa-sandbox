# Design Review — plan.md (Round 1)

Date: 2026-08-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

Adding Phase 0 is the right response to the surprising production observation, but the plan currently over-promotes one short, post-restart episode into a causal model and then proposes an experiment that cannot distinguish that model from time drift, observer effect, or workload-shape effects. The ordered single scan, invalid background-subtraction rule, external “event-loop” proxies, same-host “isolated” stress phase, and several source-contract mismatches mean the design cannot yet produce a defensible knee or admission threshold.

## What's Good (Keep)

- Keep Phase 0 as a hard gate. Measuring the untreated production process before applying load is exactly the right correction to FLY-1971's single-sample anchors.
- Keep the explicit evidence caveats in `research.md` B.3/F: one observed episode is hypothesis-generating, not causal proof.
- Keep raw per-sample output, sample counts, timeout/censoring counts, intervals, build identity, and exact process identity as mandatory evidence rather than publishing only percentile summaries.
- Keep the addition of a local-only L2 endpoint between `/health` and external-dependency probes, but correct the claim that the endpoints form a strictly nested cost ladder.
- Keep workload-shape validation. Comparing repository workload with real runners can test whether load average is a sufficient predictor, provided the comparison is replicated and time-matched.
- Keep an up/down design for hysteresis, the hard refusal to approach the historical load-88 crash, and the separation of read-only Phase 0 from write-path probes.
- Keep the explicit no-restart/no-production-config boundary and the rule that a lingering `pressure_hold` is reported rather than silently cleared.
- Keep the `test-deploy.sh` source-checkout/build-SHA warning. The source confirms that `--from-branch` selects the sandbox clone while the slot Bridge runs the script checkout's bytes.

## Issues & Recommendations

1. **[HIGH] Q1 is causal, but §2.3 cannot measure event-loop occupancy or identify it as the driver.**

   **Why it matters:** `top` reports process-wide CPU, not main-thread event-loop utilization; Node may consume CPU in native or worker-pool threads. Similar latency for concurrent requests shows a common server-side queue, but does not uniquely identify event-loop blockage. `/health`/`sessions` latency and process CPU are also outcomes of the same episode, so “whichever correlation is higher is the variable” is not a causal test. M1 and M2 are not mutually identifiable from these proxies, and a near-zero contemporaneous `load1` correlation would not exclude lagged, nonlinear, or range-restricted load effects.

   **Suggested fix:** Reframe Q1 as “Is load average sufficiently predictive for admission?” and label CPU/common-queue observations as mechanism clues only. For mechanism attribution, add an instrumented QA Bridge using `perf_hooks.monitorEventLoopDelay()`/`eventLoopUtilization()` plus a controlled suspect-work toggle (for example SSE off/on); only expose equivalent production telemetry under separately approved work. Fit lagged/nonlinear models and report “inconclusive” unless interventions distinguish M1/M2.

2. **[HIGH] The claimed parallel zero-load control arm does not exist, and the single ordered scan is confounded by time.**

   **Why it matters:** Phase 0 is a historical baseline, not a contemporaneous control. The observed bad/good cycle is roughly the same length as a six-minute tier, so an ascending then descending scan can manufacture a knee or hysteresis from phase alignment alone. A second Bridge on the same host would not be an untreated host control because whole-machine load reaches both processes.

   **Suggested fix:** Use replicated, counterbalanced blocks with interleaved zero-added-load periods (for example `0-A-0-B-0`, randomized within safe bands), and run at least three independent up/down cycles before calling hysteresis. Match treatment and control blocks by time and recorded fleet state. If the plan truly requires a simultaneous untreated control, use a separate comparable host and describe the transfer limits.

3. **[HIGH] The sampling loop is vulnerable to observer effect, pile-up, and response-dependent sampling.**

   **Why it matters:** Source inspection shows `/health` performs two synchronous main-StateStore reads and then one synchronous heartbeat query per configured Lead through `buildLivenessManifest`; the live response currently contains 16 Leads, not one additional query. Calling L1 and L2 every two seconds while spawning `top -l 2`, `lsof`, `vm_stat`, `ps`, and `sysctl` can become meaningful load. If the loop waits for each response, slow periods are sampled less often; if it maintains a fixed launch cadence, 10–26 second responses create an artificial request backlog. Neither design estimates the advertised distribution without bias.

   **Suggested fix:** Specify scheduling precisely and split collection into (a) a bounded availability sentinel with a short SLO deadline and at most one in-flight request per endpoint, and (b) lower-cadence latency samples with explicit censoring. Record scheduled/start/connect/end timestamps and in-flight count. Sample expensive OS covariates independently at a lower cadence or from a long-running sampler. Run an A/A calibration comparing sparse and full probe modes; abort if the harness measurably changes latency/CPU.

4. **[HIGH] The 529 room is state-isolated, not resource-isolated; Phase 1 is not “zero production risk.”**

   **Why it matters:** `test-deploy.sh` creates slot-local ports, DBs, identities, directories, and process records, but starts the slot Bridge and workload on the same machine as production. Concurrent Vitest/fork/I/O/memory load therefore competes directly with the production Bridge. The plan also does not name an exact hermetic test suite; repository tests may use tmux, ports, external services, shared caches, or host state and are not automatically safe to run concurrently in loops.

   **Suggested fix:** Run calibration on separate hardware/VM, or classify it as a founder-approved production-impacting window with the same guards as Phase 2. Pre-register an exact allowlisted, concurrency-safe workload and per-worker isolated temp/repo paths. Put all stress descendants in a recorded process group with an independent wall-clock watchdog that kills that exact group on controller exit, signal, deadline, or guard failure. Avoid the 00:00/12:00 restart windows and prove cleanup by PID/start-time identity.

5. **[HIGH] §5.3's background “subtraction” and Phase-0 A/B/C rules are statistically invalid as written.**

   **Why it matters:** Individual two-second samples within a multi-minute episode are autocorrelated, so a two-proportion test treats pseudoreplicates as independent. Non-overlapping 95% intervals are an overly conservative heuristic, not the stated test. Mann–Whitney non-significance and overlapping IQRs do not establish equivalence or independence from load. The claim that `b > 20%` necessarily makes the sample size impractical is false without a minimally relevant effect: distinguishing 20% from 40% is cheap compared with distinguishing 20% from 25%.

   **Suggested fix:** Define the unit of analysis as independent time blocks or episodes, estimate treatment-minus-contemporaneous-control risk difference, and use a block bootstrap or randomization test that preserves serial correlation. Pre-register alpha, power, a minimum practically important increase, and sample-size/stop rules. Replace “not significant” with an equivalence test using a declared margin. Make the boundaries inclusive (`<=5`, `>5 and <=20`, `>20`) and permit “inconclusive/nonstationary.”

6. **[HIGH] One scan cannot estimate a knee or hysteresis, and the 15%/0.7 rules are unsupported.**

   **Why it matters:** A single trip level and recovery level have no uncertainty and are inseparable from order/carryover. Nominal tiers may not equal achieved load, Vitest jobs may finish before a six-minute block stabilizes, and `0` means zero added load—not machine load zero. With at most about 90 fast samples per three-minute measurement block, p99 is effectively an extreme observation; under slow responses there are far fewer samples. `(T-R)/T = 15%` and multiplying by `0.7` are policy constants with no calibration or false-admission guarantee.

   **Suggested fix:** Repeat scans, use achieved load with a stability tolerance, and estimate SLO-failure probability with uncertainty at each level. Pre-register a segmented/logistic/isotonic knee estimator and what happens when its interval spans multiple tiers. Define the admission recommendation as the highest load whose one-sided upper confidence bound meets the SLO, followed by a separately justified safety margin. Phase 2's four-level sequence must include replicated rise/recovery observations if it is expected to validate production hysteresis.

7. **[HIGH] Several probe and guard contracts do not match the source, so the proposed harness cannot yet collect what the plan promises.**

   **Why it matters:** `/health` exposes `admissionPause`, but not `pressure_hold`; `sessions_count` is the count returned by `getActiveSessions()` (including parked/review/approved-to-ship states), not an authoritative count of currently executing runners. Production `/api/sessions` and `/api/linear/issues` require the master Bearer token. L3 does not execute “L2 + Linear”; it is a separate Linear query. L4 changes path after thread creation/reuse and may itself create feedback/rate-limit load. L5 has no exact stimulus, timestamps, query, or completion contract. Finally, `lsof` can count TCP connections but cannot tell whether a connection is `/sse`, so it cannot directly measure `SseBroadcaster.clientCount`.

   **Suggested fix:** Write an endpoint-by-endpoint protocol: URL/query/body, auth source and secret-redaction rules, expected status/body, timeout, reuse state, and side effects. Obtain `pressure_hold` through an approved read-only source (for example a rigorously read-only DB query, or a separately approved read-only status field); do not claim it comes from `/health`. Use a bounded L3 query such as `limit=1&slim=1`, pre-seed and pin the L4 reuse path, and fully specify L5. For M6, use an instrumented client count or a controlled SSE toggle; call socket count only a weak proxy. Make target URL/port configurable.

8. **[MEDIUM] Service failure, experiment trip, and safety abort are conflated.**

   **Why it matters:** §5.1 defines block-level p95 SLOs, then defines “unavailable” as two consecutive individual violations, while §6 uses three 60-second timeouts as an abort. “Zero 000/timeouts” becomes stricter merely by collecting more samples and is incompatible with variable sample counts. L3/L4 external failure can also trip the whole Bridge criterion while L1/L2 remain healthy.

   **Suggested fix:** Define three separate contracts: per-request censoring/deadline, emergency abort, and block-level service verdict. Use a fixed observation budget or a one-sided upper confidence bound for timeout probability. Attribute external-only failures separately and require local L1/L2 evidence before labeling the Bridge's local service knee.

9. **[MEDIUM] The production finding is important but the plan overreacts to n=1 and does not preserve auditable evidence.**

   **Why it matters:** The data establish that one low-load window contained severe latency correlated with high process CPU. They do not establish that event-loop occupancy is the new independent variable, that load is generally irrelevant, or that the episode was not post-restart/transient periodic work. “No applied load” also means no test treatment, not no ambient machine workload. No raw timestamped file, exact command, timeout behavior, percentile convention, or CPU/latency alignment evidence is present with the docs, so the contractor cannot audit the 62% wall-time calculation.

   **Suggested fix:** Rephrase the summary as a premise-threatening hypothesis that justifies Phase 0, not as a replacement causal model. Commit the raw evidence and reproducibility metadata, including Bridge boot age/SHA, listener PID plus start time/command, request schedule and censoring, load/CPU sample timestamps, and the exact wall-time formula. Repeat Phase 0 in multiple windows before generalizing prevalence.

10. **[MEDIUM] §9 is neither complete nor logically symmetric as a falsifiability register.**

   **Why it matters:** Agreement between A and B at two or three matched load points does not prove load average is sufficient or that FLY-1971's original fix is correct. Correlation with an SSE socket does not prove payload caching/slow polling is the remedy. The table omits observer effect, nonstationary baseline, failure to hold target load, workload non-representativeness, unstable PID, insufficient independent episodes, and a knee interval too wide to choose a threshold.

   **Suggested fix:** Add a validity-failure table with explicit “supports,” “contradicts,” and “inconclusive” outcomes for every question. Require controlled SSE on/off evidence before recommending an SSE fix, and repeated matched A/B agreement within a declared equivalence margin before calling load average sufficient.

11. **[MEDIUM] Safety has good intentions but lacks authoritative and fail-safe enforcement.**

   **Why it matters:** The plan cannot currently observe `pressure_hold` through its declared endpoint; “disk space sufficient” and “load stable” have no numeric definitions; and aborting when a new production runner appears does not prevent that runner from being harmed first. A shell trap alone will not stop descendants after terminal loss or a wedged controller. Alert notice/mirroring is operational coordination, not a guard. The Bridge may also be auto-respawned by launchd if the test crashes it despite the plan saying “do not restart.”

   **Suggested fix:** Pre-register numeric disk, output-rate, memory, deadline, achieved-load, and recovery limits. Use an independent supervisor and exact PGID/PID-start identities. For production, either obtain authority to use the existing admission pause plus quiescence proof for the window, or do not run while new work can be admitted. Snapshot scheduled restarts/jobs and SSE clients, verify the authoritative hold source before/during/after, and continue to report rather than clear any durable hold without separate authority.

12. **[MEDIUM] Phase 0 is sequenced correctly, but the outcome and delivery boundary do not close the founder's issue.**

   **Why it matters:** Outcome A says “fix first” but does not define the re-entry gate; after a fix, Phase 0 must be repeated before stress results become interpretable. Section 10 labels plan+harness as the boundary of “FLY-1986 execute” while explicitly excluding the load generator and all multi-gear execution, even though the issue directive is to run the test and feed a threshold to FLY-1971. That is acceptable as the first deliverable, not as completion of FLY-1986.

   **Suggested fix:** Rename §10 as the current review/PR milestone. Keep FLY-1986 open through Phase-0 execution and whichever conditional phases remain. For outcome A, specify: open/own the diagnosis-fix work, rerun Phase 0, require a pre-registered stable-baseline gate, then resume Phase 1/2. Name the follow-up artifact/owner for the gated load generator now, without implementing it prematurely.

13. **[LOW] The synchronous-subprocess count overstates the audited evidence.**

   **Why it matters:** The reported 56 is the count of source lines containing the identifiers `execFileSync`/`execSync`/`spawnSync`, including imports; there are 36 actual non-test call sites by call-expression search, 18 under `src/bridge`, and several are CLI/cold route paths rather than periodic riders. Existence of synchronous calls is a real risk, but the current count implies a larger hot path than was verified.

   **Suggested fix:** Report call sites, not identifier mentions, and classify each as periodic, request-triggered, startup-only, or CLI-only. Use the periodic/reachable subset as the M2 evidence and retain the broader set only as an inventory.

## Verdict

CHANGES REQUESTED — address items above
