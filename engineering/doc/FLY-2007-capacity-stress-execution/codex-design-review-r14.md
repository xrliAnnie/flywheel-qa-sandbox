# FLY-2007 Phase-0 statistics tool — Design Review R14

## Snapshot and method

- Branch: `flywheel-FLY-2007`
- Reviewed HEAD: `e6d7eacf66e3094fd1eb45b73bee3d4853cfed7f`
- Repository was treated as read-only. All new fixtures, generators, run outputs, and calculations are under `/tmp/fly2007-r14/`; the pre-existing untracked repository evidence directory was not touched.
- Fixture generator: `/tmp/fly2007-r14/make-fixtures.sh`
- The authoritative counterexamples below ran the real CLI from the reviewed repository, with `--freeze-commit e6d7eacf66e3094fd1eb45b73bee3d4853cfed7f` and the frozen simulator replicate count (no `--sim-m`).

## Findings

### HIGH — per-tick configuration faults can be relabelled as valid blocks and release A

Fixture: `/tmp/fly2007-r14/fixtures/config-fault-marked-valid`

Every one of the 180 `(window, endpoint, block)` units contains a `no_token` sample at tick 0. The remaining rows make the recomputed violation rate exactly 0.5. `summary.csv` reports matching row/count totals and `0.5000`, but falsely says `block_valid=true` for every block.

Executed result:

```json
{"authoritative_outcome":"A","inference_eligible":true,"ineligibility_reasons":[],"applicability_gate":{"pass":true,"problems":[]}}
```

A direct call to `checkIntegrity()` on the first bundle also returned `[]`, even though its first sample is `outcome="no_token"` and its first summary row is `block_valid="true"`.

Cause: `checkIntegrity()` counts configuration faults, but uses that count only in the special `conservative === "NA"` branch. `classifyBlock()` then trusts the summary's `block_valid` literal without reconciling it with the sample outcomes. This violates spec §4/§4.0: `no_token`, `unreachable`, and `invalid_auth` are invalid terminal states, so these are not 30 valid blocks per endpoint.

Minimum closure: derive the eligibility-relevant block state from the samples (at minimum, any configuration-fault outcome must make `block_valid=true` contradictory), require outcome totals to satisfy the collector contract, and add this exact frozen-M negative fixture to CI.

### HIGH — a canonical service/host failure is ignored when `disposition` says `completed`

Fixture: `/tmp/fly2007-r14/fixtures/completed-service-failure`

`attempt-001/state.json` is canonical and internally contradictory:

```json
{"state":"TERMINAL","disposition":"completed","reason":"health_unreachable","exit_code":1}
```

It carries valid hashes for a complete high-violation bundle. The real CLI emitted:

```json
{"authoritative_outcome":"A","inference_eligible":true,"ineligibility_reasons":[]}
```

Cause: `censusProblems()` returns early for every `completed` or `dry_run` disposition before it classifies `reason` or validates `exit_code`. Thus the same canonical record that says `health_unreachable` and exit 1 is treated as a completed measurement window; the recorded failure produces no diagnostic at all.

Minimum closure: validate terminal records as a state machine, not independent strings. A completed attempt must have the exact success reason and exit code; any service/host reason or non-zero exit must poison eligibility regardless of `disposition`. Add contradictory-disposition fixtures for completed and dry-run rows.

### HIGH — a non-numeric conservative point estimate passes the CSV agreement gate and releases A

Fixture: `/tmp/fly2007-r14/fixtures/non-numeric-conservative`

All counts and samples describe an all-violation run, but every `violation_upper_conservative` field is the literal `not-a-number`. `checkIntegrity()` returned `[]`; the full CLI emitted eligible authoritative A with no reason.

Cause: the comparison is `Math.abs(Number(value) - recomputed) > 5e-5`. For a non-numeric value the left side is `NaN`, and `NaN > 5e-5` is false. This violates spec §4.1's requirement that counts and the conservative point estimate agree with the samples.

Minimum closure: reject non-finite numeric fields before comparing them, validate integer/count ranges explicitly, and compare the collector's frozen formatted representation rather than allowing invalid text through a floating-point tolerance.

### MEDIUM — N is mathematically unreachable at the frozen exposure, despite being declared authoritative again

Fixture: `/tmp/fly2007-r14/fixtures/valid-n-candidate`

All gates and all integrity/ledger conditions pass. W1/W3 have rate 0; W2 uses a fixed 8%/12% block sequence with mean 10% and lag-1 ACF −0.30, which is inside the applicability domain. The real result is eligible U:

```json
{"authoritative_outcome":"U","inference_eligible":true,"point_estimates":[0,0.10000000000000006,0],"range_lb":0}
```

This is not merely one low-power fixture. `/tmp/fly2007-r14/n-envelope.json` computes the global envelope at `J=30` and `A_RANGE=0.0004166667`:

```json
{"max_possible_window_lower":0.15429657560173085,"min_possible_window_upper":0.22851712199157242,"max_possible_range_lower":0,"N_reachable":false}
```

For any input, a window lower bound cannot exceed the all-violation value and a window upper bound cannot go below the all-clean value. Since `0.15430 < 0.22852`, `max(L)-min(U)` is always negative and the clamp makes `range_lb` identically zero. Therefore `range_lb > DELTA` can never occur.

The N coverage simulation is correspondingly vacuous: every N point reports `5000/5000` coverage because the procedure can never exclude the true range 0. It cannot support the spec's claim that passing configuration #4 falsified N's structural unreachability. Also, the sensitivity output says top-level `M=20000` while every `range_lb_N` point actually uses `m=5000` (`runSensitivity()` calls it with `m/4`), contrary to spec §7's frozen M statement.

This U is fail-closed rather than an unsafe false claim, but it is a dead authoritative outcome and a contract/utility defect. Closure requires either honestly declaring N unavailable at this exposure (as B already is) or re-preregistering exposure/grid/error allocation that gives N a non-empty rejection region; simulator coverage and positive power/reachability must be kept distinct.

### MEDIUM — the `WEAK` parameter-set disclosure is factually true but omits that the current gate has no rejection region

Evidence: `/tmp/fly2007-r14/runs/valid-a/sensitivity.json`

The stated facts are accurate: only three pilot summaries exist, the per-tick pilot series was not committed, and this is not a distributional goodness-of-fit test. However, the realized grid envelope is exactly `[0,1]`:

```json
{"pilot_block_rates":[0.6444,0.2889,1],"grid_rate_range":[0,1],"outside":[],"pass":true}
```

Every legal block rate is in `[0,1]`, so no possible pilot rate can fail this gate. `ALPHA_PARAM=0.025` is printed but is not consumed by `parameterSetGate()`. Calling this merely “WEAK” understates the operative limit: it is a support-envelope assertion with zero discriminating power for the frozen pilot values, not statistical evidence that the parameter set fits them.

Minimum closure: make that non-discriminating status explicit in the output/contract and do not cite this pass as substantive fit evidence. A real distributional/parameter-set gate requires new pilot information and a new preregistration; the missing per-tick series cannot be reconstructed after the fact.

## Reverse and diagnostic controls

- `/tmp/fly2007-r14/fixtures/valid-a` is a fully valid all-violation fixture. The real frozen-M CLI emitted `inference_eligible=true`, no reasons, and `authoritative_outcome=A`. The A branch is therefore reachable; there is no “always U” defect for A.
- `/tmp/fly2007-r14/fixtures/legal-replacement-a` has one `operator_credential` failure followed by exactly one completed same-window attempt naming `replacement_of: 1`, plus W2/W3. It also emitted eligible A, so the legal replacement graph is live rather than fail-closed forever.
- `/tmp/fly2007-r14/fixtures/failure-without-reason` adds an ordinary aborted attempt with no `reason`. It emitted U and included `ledger: attempt 4 failed for an unclassified reason '' - refusing by default`. I found no separate silent-no-reason path beyond the contradictory completed service failure described above.
- The repository's focused suite passed fresh: `84 passed, 0 failed`. Its green result does not cover the three false-A fixtures above.

## Verdict

The current HEAD can emit authoritative A while required block validity/CSV agreement is false, and while a canonical service/host failure is explicitly recorded. Those are direct violations of the requested safety property. N is additionally a dead branch, and the declared parameter-set limitation is incomplete.

VERDICT: CHANGES REQUESTED
