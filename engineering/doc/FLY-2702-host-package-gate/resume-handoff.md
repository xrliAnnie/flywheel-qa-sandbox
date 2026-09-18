# FLY-2702 resumed design handoff

Issue: FLY-2702
Date: 2026-09-18
Source: plan.md, review-followups.md, PR #1257, current review and hosted-page receipts

## Continuity

Execution `d9fb0d9a-6815-4b74-8cdc-d959fc08a493`, run `27ca0f42-a513-4531-bf61-5123fe7fa610`, design attempt 1, TURN epoch 6 resumes inherited head `d1ec3644316e5988dea1f09090a2c488f75598ad`.
Lead messages `ab36b689-c21f-4770-be84-b15786990e1a` and `5ad2d5e8-ed66-4fce-8574-0d9b5782157f` require reuse of the completed design and implementation. No redesign, local full package gate, stash mutation, or implementation is authorized for this node.

The inherited implementation cursor remains available at `d1ec36443:engineering/doc/FLY-2702-host-package-gate/progress.md`: implement 4/4, exact-head code review and CI still required. The resumed progress file tracks only this design handoff; it does not reset implementation work.

## Design completion evidence

- Exploration, research, plan, founder HTML, Mermaid source, review findings, and validation records are already committed and pushed on the inherited branch.
- Plan SHA-256 remains `8a92b854f8b708803d4165ab707c9577573b4c5854212bf558a7302494f61186`, identical to the approved design. The frozen plan's historical `review-pending` text and unchecked boxes are superseded by the structured review receipt and phase-specific evidence, not permission to redo completed work.
- Live `check 0dc1b6ae-8aa5-4534-bb68-1550f7be53e1` returned effective `APPROVED` for request `384bd7ed-b0e5-405c-b22a-574e3969d4f7`. Non-blocking findings remain in `review-followups.md`.
- New execution review binding: question `b2d64abe-70c4-4d21-b913-1d685f11ceb3`, accepted request `483175f7-567a-4a78-ba55-7f6e094c22c4`; effective verdict **CHANGES_REQUESTED**, one HIGH implementation finding and ten non-blocking advisories. The request preserves the same plan and explicitly excludes redesign. Full response: `evidence/resume-review-round-1.json`.
- HTML SHA-256 remains `4e406f1f5fd3c3a17038da7b7a2a6b36262603f6fd107fe1e6fbc635f4ce5cf0`. Fresh `verify-report` on the inherited hosted URL returned HTTP 200 and passing nonce-placeholder, script CSP, script nonce, and comment marker checks.
- Prior controller verification covered all ten comment inputs, pathname-isolated storage, denied-storage behavior, marker-prefixed chunks, and both clipboard fallback cases. Source bytes are unchanged; this is inherited controller evidence, not a new browser run.
- Local Mermaid rendering previously failed twice with Chromium MachPort permission denial. The source and visible `DIAGRAM PENDING LOCAL RENDER` remain intact under the explicit fallback contract. No remote rendering or browser-execution claim.
- Current execution published the unchanged HTML using publish-only: https://fw-reports-42fba7.vercel.app/r/2bab608294a4b61f44ed408bc4669b68/ . Lead report receipt: `c824cda5-c20d-42b7-b4e6-78f3ce04f753`. Fresh HTTP/CSP/nonce, hosted body/script equality, and external-asset checks passed; see `evidence/resume-hosted-validation.json`. This intentionally sent no channel message. Round 2 is now effectively APPROVED; exact `phase_design_complete` follows the final committed/pushed receipts.

## Concrete implementation and QA continuation

The existing code implements the opt-in queue, supervision, patrol integration, and calibration evaluator. Do not infer missing implementation from the frozen plan's unchecked boxes. Consult the actual code and prior commits before changing anything.

Read-only GitHub inspection confirmed run [35316958443](https://github.com/xrliAnnie/flywheel/actions/runs/35316958443) completed with **failure** on exact inherited head `d1ec3644316e5988dea1f09090a2c488f75598ad`:

- Script Tests 2/5 failed its elapsed-time tripwire: `elapsed=1042s budget=1020s cap=1200s usage=86%`. The log asks for whole-suite rebalancing or an additional shard; it is not a passing aggregate.
- Script Tests 4/5 received a runner shutdown signal and cancellation. No test assertion failure is established by that observation.
- Quick Gate, NPM payload, remaining shell shards, and all reported unit jobs passed. Those partial passes do not override the failed aggregate.
- An `EEXIST` trace in kill-ledger output belongs to its negative test: that suite reports `kill-ledger shell parity: PASS`; do not mistake it for the shard failure.

Implement must finish the outstanding exact-head review/CI work, using the Lead-authorized aggregate lane and focused local tests. This design node does not alter CI or run package tests.

Lead response to report `fa6602c4-7666-4a5e-a1c4-44a42d69cebc` directs Implement to run `gh run rerun --failed` without moving the implementation head, inspect again only if still red, and classifies these failures as the FLY-2714/2592 infrastructure family. This is the Lead's disposition, separate from the observed log facts above. Design receipt commits necessarily advance the inherited branch; the successor must bind review/CI to the actual final head and must not use a rerun on `d1ec36443` as proof for a different SHA. Response to `171ca6f8-806e-49b8-a632-265834b42dfc` explicitly confirms reuse plus handoff/gate binding, with no redesign.

Deployment-time QA remains required: two real Runner sandboxes and caller-group death recovery; N+1 zero-spawn and <=5s handoff; deployed STEP 2 queue recognition; six fixed workloads with independently frozen baseline, N=2/3 comparison, <=1.2 theoretical span, no RPC false red, raw before/after process samples and per-gate wall-time table. Queue enablement and capacity calibration are not claimed. These remain the original acceptance scope.

## Resumed review disposition

**HIGH `supervisor-exit-status-discarded` is confirmed and unfixed.** The existing plan already requires cleanup failure to return a host_queue infrastructure failure, and cancellation to preserve 130/143. The inherited Node close callback ignores the supervisor exit status and accepts the worker's successful result file. An isolated reproduction (no build, Vitest, or production queue) returned passed/0 for supervisor exits 1, 70, 130, and 143; exit 0 was the positive control. See `evidence/resume-supervisor-reproduction.json`.

Implement must reconcile the supervisor's final code/signal with the worker result before declaring overall success, preserve genuine test failure/RPC-artifact semantics and cancellation, and retain diagnostic receipts. Required negative regression: successful worker result followed by cleanup failure or infrastructure failure must not return passed/0; cancellation must preserve 130/143. Include successful cleanup control and missing/malformed result coverage. This handoff does not claim the bug fixed or authorize a passing code review/QA.

Current design-only mandate forbids implementation. Governance question `090668b6-e85e-41ce-b4ba-f148e8431d0e` asks Lead to record a supervised finding-key follow-up to Implement, then a new design review request. A prose reply alone does not settle this finding; a new effective APPROVED is required before completion.

Lead recorded active ruling `29aa397c-baf3-4d52-b631-451a1670662a` at 2026-09-18 16:58:04 UTC, disposition `follow_up`, follow-up issue `FLY-2702`. Its rationale explicitly assigns the fix to this issue's Implement node and does not waive code review or QA. Read-only authoritative-store evidence is saved in `evidence/resume-lead-ruling.json`. New design review: question `1d7f426d-a002-4e4a-908b-dcbbca428e48`, request `02f41b27-c719-4000-8e12-26ba4f6c5e9f`, **effective APPROVED**. Full response is `evidence/resume-review-round-2.json`; new MEDIUM `qa-harness-not-bound-to-host-ledger` is appended to `review-followups.md`, bringing current advisories to eleven. No implementation fix or live acceptance is claimed.

All ten non-blocking advisories remain visible below; these are follow-ups, not claims of verified fixes or amendments to the frozen plan:

| Finding key | Severity | Handoff disposition |
|---|---|---|
| plan-boundary-locked-at-unparseable | MEDIUM | Reconcile strict UTC boundary with current implementation and explicitly document legacy limits; retain deployed STEP 2 acceptance. |
| queue-unknown-marks-sources-incomplete | MEDIUM | Inspect unrelated-versus-unknown queue disposition without hiding genuine incomplete sources. |
| stale-heartbeat-demotion-unbounded | MEDIUM | Verify bounded fairness under sustained contention; no starvation claim from idle-only tests. |
| plan-ancestry-check-not-existing-capability | MEDIUM | Distinguish current process/env probe from real ancestry evidence; do not claim the latter is proven. |
| ci-bypass-not-announced | MEDIUM | Make bypass observability explicit and exclude uncontrolled calls from acceptance samples. |
| host-disabled-bypass-receipt-unmarked | MEDIUM | Preserve machine-readable bypass reason for host-disable paths before accepting throughput evidence. |
| plan-statestore-citation-wrong | LOW | Use symbol names/current source for StateStore boundary fields; inherited line numbers have drifted. |
| plan-control-fd-and-status-source-divergence | LOW | Record actual result-file and refreshed projection mechanisms; distinguish them from original design text. |
| env-limit-accepts-more-than-plan | LOW | Reconcile accepted environment values with documented configuration contract. |
| plan-watchdog-ready-receipt-impossible | LOW | Preserve watchdog-before-GO guarantee and actual DB binding sequence; do not claim launcher READY contains a later watchdog PID. |
