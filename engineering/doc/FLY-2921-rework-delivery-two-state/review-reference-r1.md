# Design Review — plan.md (Round 1)

Date / Reviewer: 2026-09-26 / independent Claude (fable), substituting for the Codex reviewer pool at the same pass bar
Status: **CHANGES REQUESTED**

Scope reviewed: `engineering/doc/FLY-2921-rework-delivery-two-state/{plan,exploration,research}.md`, repo `CLAUDE.md`, triage `fixclasses.json` K05 + `tickets.json` (FLY-2330/2821/2185/2473/2202/2092/2472), sibling plans `origin/flywheel-FLY-2922` and `origin/flywheel-FLY-2919`, and the source at baseline `d52df7841` (all cited line numbers were re-verified against the worktree; the plan's line numbers match the baseline).

## Summary

The direction is right and most of the plan is sound: the 5-state vocabulary is coherent, every deleted state has a mapped destination, the Lead door via the existing delivery-scope hold machinery genuinely works end to end on an ACTIVE run (verified `listWorkflowHolds` 58099 → no `run_held` precondition for `scope: "delivery"`; `resumeWorkflowHold` 59480ff only touches `workflow_run.status` when `hold.runLevel`; `runs-route.ts` 448–545 only requires master + loopback + confirm token), the migration/skip-predicate trap is correctly identified, and the C7 head check is placed at the right seam.

Approval is blocked by one design element that cannot be implemented as written: **C2's "TURN source per route revision with an unchanged activationId"**. `workflow_activation_turn` is `activation_id PRIMARY KEY`, `source_event_id UNIQUE`, protected by a `BEFORE UPDATE` trigger; `recordWorkflowActivationTurn` returns `activation_turn_conflict` for a second source on the same activation, and admission returns `activation_conflict` for a second activationId on the same `(execution, run, node, attempt)`. The Lead re-delivery door (the whole point of `returned_to_lead`) would therefore fail deterministically and loop back to `returned_to_lead` after 5 backoffs. There is a much smaller fix (vary the wakeId, not the TURN source) — see Issue 1.

Six MAJOR items follow: a stranding path created by the migration's double door on held runs, an unbounded "replacement launching" loop with no alert and no backoff primitive, a phantom run-scope hold left by the replacement rollback, a C4.4 re-delivery path that the admission table refuses, loss of all escalation on "unknown liveness" waits, and two concrete contract gaps with FLY-2922. All are fixable without changing the chosen direction.

## What's Good (Keep)

- **State vocabulary and diagram (§1/§2).** Keeping the literal `wake_delivered` (event name consumed by 529 scripts) and replacing `awaiting_receipt` with a `wake_sent_at` fact is the right call. C1.7 also fixes a real race (receipt arriving before the `awaiting_receipt` advance) — verified at `projectWorkflowReworkWakeReceiptTx` 43923.
- **Lead door reuse (C3.2/C3.3).** Verified end-to-end: delivery-scope shape → `resumable` without `run_held` → `operationState = "projected"` (state authoritative, no `deliveryResume`) → `applyStateWorkflowHoldResumeActionTx` `resume_rework` case → new `engine:hold_resume` revision + `remintWorkflowReworkDeliveryAttemptTx` + path reset. No new API needed.
- **Migration trap (C1.3, §5).** Correct: `migrateWorkflowReworkDeliveryBudget` (7411–7417) keys its skip on the literal strings `needs_lead`/`awaiting_receipt`; without the column-only predicate it would rebuild the 8-state CHECK on every boot. The new predicate is a safe superset. `assertMaintenanceSchema` 7041–7046 correctly listed.
- **FLY-2092 root cause.** Deleting the `superseded` node cleanup in `settleWorkflowReworkFailure` (45998–46013) is exactly the break in the resume path; correct.
- **FLY-2821 chain (C5).** The research §4 chain is accurate (`enterResidentHoldForCompletionTx` 64660 returns false on activation mismatch; nothing updates `workflow_resident_hold.activation_id`). Re-parking on the current activation and letting `woken` deliver is the minimal correct fix.
- **C6.1/C6.2 guard on the generic dead sweep.** `rollbackDeadWorkflowNodeExecution` (61670) has no rework awareness today; fencing it and handing to the coordinator is the right ownership.
- **C7 seam.** `commitWorkflowTransitionTx` 67928–67979 already resolves `activeRequest.base_revision` and `activePathCurrentIndex`; refusing before `completesConflictResolution` with `retryable:true` and relying on 69238–69246 to roll back the implied receipt is correct. Fail-open on `reworkDelta.unavailable` (head differs) is the right trade-off.
- **§7 negative guards and §8.3** (isolated `FLYWHEEL_CODEX_HOMES_ROOT`, tmux-viewer exclusion, exit-code lint judging) follow the project's recorded lessons.

## Issues & Recommendations

### 1. BLOCKER — C2 "TURN source per route revision" cannot be recorded: `workflow_activation_turn` is one immutable row per activation

**Evidence.**
- `StateStore.ts:35050–35062`: `workflow_activation_turn (activation_id TEXT PRIMARY KEY, …, source_event_id TEXT NOT NULL UNIQUE, …)` plus `CREATE TRIGGER workflow_activation_turn_no_update BEFORE UPDATE`.
- `recordWorkflowActivationTurn` (grep `recordWorkflowActivationTurn(input`): `SELECT … WHERE activation_id = ? OR source_event_id = ?`; if a prior row exists and epoch/source differ → `{ ok:false, reason:"activation_turn_conflict" }`.
- Coordinator `workflow-rework-coordinator.ts:1033–1046`: `recordWorkflowActivationTurn` failure → `releaseRetryable("turn_projection_failed:…")` → `settleWorkflowReworkFailure` counts a failure.
- Alternative of rotating `activationId` is also closed: `admitGeneralizedWorkflowExecution` 47180–47191 returns `activation_conflict` when `existingBinding.activation_id !== activationId`, and `workflow_execution_binding` has `UNIQUE (execution_id, run_id, node_id, attempt)`.

**Why it matters.** Every Lead re-delivery to a live body whose TURN was already granted once (the FLY-2473 scenario the plan targets; also the crash window "已授权、未推送") will go: new `sourceEventId` → `grantTurn` mints epoch+1 in CommDB → `recordWorkflowActivationTurn` → `activation_turn_conflict` → 5 backoffs (~15 min) → `returned_to_lead` again with a new alert. CommDB is left with an epoch/activation row the StateStore never acknowledged. The door is dead by construction, and the §8.1 FLY-2473 row ("用真实 CommDB 回归…得到新 epoch、新 wakeId 并推送成功") would be red against the plan itself.

**Suggested fix (smaller than the plan's).** The failure the plan diagnosed is the *outbox* cap (`turn_wake_outbox.push_count BETWEEN 0 AND 2`, `claimTurnWakeById` refuses at `push_count >= 2`), not the TURN. Keep `sourceEventId = rework-turn:<req>:<activationId>` and the epoch stable (so `grantTurn` replays idempotently and `hasTurnSource` keeps credential rotation untouched), and vary only the wake identity: `wakeId = buildReworkWakeId({requestId, activationId, epoch, routeRevision})`. Each `engine:hold_resume` / replacement revision then gets a fresh outbox row. Update the retirement-proof check at `flywheel-comm/src/db.ts:6009` (`proof.wakeId !== buildReworkWakeId(proof)`) and `workflow_rework_wake_retirement.wake_id` derivation accordingly. If a genuine re-grant is ever required (TURN moved to another holder), that needs a multi-row redesign of `workflow_activation_turn` (PK `(activation_id, epoch)`, "latest" reads in `projectWorkflowReworkWakeReceiptTx` 43893, `settleWorkflowReworkOnCompletionTx` 44085, `settleWorkflowReworkFailure` 45945) — call that out explicitly as out of scope or design it; do not leave it implicit.

### 2. MAJOR — §5 migration creates two doors for the same delivery on held runs; taking the delivery-scope door first strands the run

**Evidence.**
- §5: "迁移为每一条「非终态 run 上变成 returned_to_lead 的行」补写一个 rework_returned_to_lead delivery 作用域事件" and, for the same rows, "它们的 run 仍然 held，由原来的 hold 事件和门处理 … 前置条件 … 期望状态改为 returned_to_lead".
- `listWorkflowHolds` 58099 lists every un-resumed hold event; the old run-level `rework_retry_exhausted` / `rework_pane_loss_handoff` / `rework_activation_stalled_held` events remain open alongside the new migrated delivery-scope event.
- `applyStateWorkflowHoldResumeActionTx` 58633–58700 (`resume_rework`) throws `workflow_hold_rework_changed` unless delivery state is in the accepted set; `workflowHoldAuthoritativePrecondition` 57903–57927 (as amended by C3) expects `returned_to_lead`.
- `workflow-engine-dispatcher.ts:1372–1378` skips deliveries whose run is not `active`.

**Why it matters.** Lead runs `hold resume` on the new delivery-scope hold (the alert tells them to): delivery → `pending`, run stays `held`, coordinator never claims it. The run-level door now fails `stage` with `hold_changed` (expected `returned_to_lead`, is `pending`). Only FLY-2922's unified entry or `terminate` remains — a new K05-class dead end introduced by the migration itself, on the 8 live rows the plan enumerates.

**Suggested fix.** Either (a) do not write the migrated `rework_returned_to_lead` event for rows whose run is `held` (they already have a door; document that those 8 rows go through the run-level shapes or 2922), or (b) make the run-level `resume_rework` accept `pending` when the latest route revision is `engine:hold_resume` created after the hold event (then it only un-holds the run). (a) is simpler and keeps one door per row.

### 3. MAJOR — "替身启动中" (C2 step 3) has no bound, no alert, and no backoff primitive

**Evidence.**
- Plan step 3: `replacement_launching` → release owner, `next_retry_at = now + 30s`, "不计失败", with no upper bound.
- `releaseWorkflowReworkDelivery` (grep): only clears owner/lease and sets `last_error`; it does **not** set `next_retry_at`, and it appends `rework_delivery_released:<req>:<generation>` on every call. `scheduleWorkflowReworkReceiptProbe` only accepts `awaiting_receipt|wake_delivered`. `claimWorkflowReworkDelivery` 45415ff bumps `generation` on every claim.
- Dispatcher launch fences that can refuse a replacement intent forever: `engine_rework_target_launch_fenced` (2805–2821), `engine_rework_replacement_context_invalid` (2848ff, fail-closed by design), `codex_quota_paused`, capacity. Only `admitted` nodes reach the unlaunched rollback (dispatcher 1808/1884/1991); a `pending` node with an unconsumed `intent_recorded` ledger row is never reconciled.

**Why it matters.** (i) A permanently fenced replacement makes the coordinator loop at 30 s forever with `pending` delivery, no failure count, no `returned_to_lead`, no alert — the FLY-2185 "半铸体搁浅" symptom returns wearing a new state name. (ii) Without a dedicated "defer pending" primitive the implementer will reach for `releaseWorkflowReworkDelivery`, which yields a 1 Hz claim/release loop and one `workflow_run_event` row per second per launching replacement.

**Suggested fix.** Add a `deferWorkflowReworkDelivery({requestId, ownerId, generation, nextRetryAt, reason})` CAS for `pending` that writes no event. In the launching predicate, read the dispatch ledger for `(node, attempt, preferred_actor)`: `abandoned` → treat as dead (step 4); `intent_recorded` older than the existing `unlaunchedThresholdMs` (dispatcher 1808) → count one failure with reason `replacement_launch_stalled` (feeds the 5× budget → `returned_to_lead`). Have the dispatcher record its fence reason into `workflow_rework_delivery.last_error` so the Lead alert says why.

### 4. MAJOR — C4.1 leaves a phantom run-scope hold (`unlaunched_admission_rolled_back`) on an active run, and the run-hold UPDATE it must skip is outside the replacement branch

**Evidence.**
- `rollbackUnlaunchedWorkflowAdmission` 41258–41261: `UPDATE workflow_run SET status='held'` runs for **all** bindings; the replacement-specific branch is 41262–41280. The plan (C4.1, §4 table) names only 41262–41280.
- `hold-shape-registry.ts:101–105`: `unlaunched_admission_rolled_back` is a `scope: "run"` shape. `listWorkflowHolds` will list it with `run_held` precondition false → `resumable:false`, never closed by `hold_resumed`.
- `hasUnlaunchedWorkflowRollbackFact` 50819 reads that same event kind, so the event cannot simply be dropped.
- FLY-2922 plan §3.1 treats open hold events as episode inputs ("不能仅以缺少 hold_resumed 判断开放" — but it also has no supersession rule for this case).

**Why it matters.** After each replacement rollback the run shows a permanent non-resumable hold in `hold list`; 2922's classifier will see an open execution fault on an active run with no recorded resolution; the alert body (41296) still says "held run".

**Suggested fix.** For `binding.mode === "replacement"`, emit a distinct kind (e.g. `rework_replacement_launch_rolled_back`, not registered as a hold shape) and teach `hasUnlaunchedWorkflowRollbackFact` to accept both kinds; or keep the kind and have `replaceWorkflowReworkActor` append the matching `hold_resumed` receipt in the same transaction. State explicitly in C4.1 that the 41258 run-hold UPDATE becomes conditional on `binding.mode !== "replacement"`.

### 5. MAJOR — C4.4 re-delivery to a running replacement via wake-mode admission is refused by the admission table

**Evidence.**
- Plan C4.4: content-missing → delivery back to `pending` on the same execution → "让协调器用 TURN 上下文把返工内容重新送到这个活替身手里".
- Coordinator step 7 admits with `activationId = activation:<req>`, `activationMode: "wake"` (coordinator 862–874). The replacement body's binding is `mode='replacement'` with the dispatcher's activation id. `admitGeneralizedWorkflowExecution` 47180–47191 → `activation_conflict` (different activation id, different mode) — deterministic.

**Why it matters.** Every content-missing replacement (the FLY-2472 transcript-replay case) burns 15 minutes of backoff and lands in `returned_to_lead` instead of self-healing; the plan text promises a path that does not exist. Not a strand (it ends at the Lead), but it contradicts §1's "投给死体不再是失败" narrative for this sub-case and the §8.1 FLY-2330 assertion "投递回 pending" is only half the story.

**Suggested fix.** Treat content-missing as a replacement failure: in `openReworkContentUndeliverableTx` retire the replacement's activation (revoke unconsumed credentials, mark node `failed` with a rollback-style fact) and let step 4 mint a new replacement under the budget; or deliver via the replacement's *own* activation id (`binding.activation_id`) with a `replacement` mode wake. Pick one and add the matching §8.1 assertion ("再送达" or "再换体").

### 6. MAJOR — "unknown liveness" waits become silent: no escalation path survives for sent/alive-unknown deliveries

**Evidence.**
- Plan step 5/6: `turn_granted+wake_sent_at` or `wake_delivered` with reentry `hold` (incl. `persisted_target_missing`) or `!actor` → `receipt_pending` every 3 min, "不计数", no deadline (§7 explicitly).
- The only remaining unknown-liveness alert is the dead sweep's `probe_unknown` (dispatcher 2439–2478), which C6.1 makes skip rework targets.
- No producer of `rework_activation_stalled_held` or `rework_stalled_alert:*` exists in `src` (grep: only registry, precondition, `openOperatorRework` allowlist, and the reader `enqueueReworkRecoveredIfAlertedTx` 44996). C3 removes `rework_pane_loss_handoff`, the last escalation for `persisted_target_missing`.
- Coordinator 621–634: `!actor` (session row gone) → `deferReceiptProbe` forever; C4.3 now routes the undeliverable turn_wake case (recipient session missing/terminal, `holdUndeliverableTx` 57216–57221) into exactly this branch.

**Why it matters.** The plan replaces a loud stuck state (held + severe alert) with a quiet one (patrol ledger only). Under FLY-2919 "unknown" is a legitimate long-lived verdict for legacy bodies without a process binding (2919 §4 "旧运行迁移 … 无匹配 … 均 unknown"). The K05 complaint was "Lead cannot get out"; "Lead does not know" is worse.

**Suggested fix.** In the observing branch, count consecutive unknown probes per `(requestId, routeRevision)` and enqueue one warning alert (deduped by UID) at N=3 and a severe one at ~30 min, with no state change; a missing session row should be consumed as 2919's body verdict (dead → step 4) rather than as `unknown`. Add a §8.2 negative-control that the alert fires exactly once per revision.

### 7. MAJOR — §6 contracts miss two concrete FLY-2922 conflicts that will only surface at rebase

**Evidence.**
- 2922 plan §3.6: pre-admission failures including `engine_rework_replacement_context_invalid` → `run_recovery_required` + `run held` after 3 observations. This directly violates 2921 invariant 2 ("返工投递的任何失败都不写 workflow_run.status='held'") for `rework_replacement:*` intents.
- 2922 plan references `replacement_pending` in §2 (FLY-2116 row), §3.4, §5 table ("replacement 回滚再额外 delivery held") and §7 (row 2116: "同 requestId 新 actor/revision + replacement_pending"). 2921 §6.1 invariant 4 only says "2922 plan §3.3「恢复 replacement_pending」一句改为此形态".
- 2922 §7 "活体返工唤醒" row assumes the three old rework hold shapes can be produced and resumed "alive 仅重臂 wake"; after 2921 they are history-only (2921 §4).

**Why it matters.** "谁后合入谁 rebase" only works if the invariants list is complete; the §3.6 clause would silently reintroduce run-held-from-rework-delivery through 2922's producer.

**Suggested fix.** Add to §6.1: (a) pre-admission failure of an intent whose `reason` starts with `rework_replacement:` is routed to the coordinator (delivery failure count / `last_error`), never to `run_recovery_required`; (b) enumerate all four 2922 locations that must change from `replacement_pending`; (c) state that the three old shapes are no longer produced so 2922's "alive → 重臂" case only applies to migrated rows.

### 8. MINOR — Default authoritative precondition returns `true` for the new shape

`workflowHoldAuthoritativePrecondition` falls through to `result(true, "run-level hold … remains current")` (57935–58099 tail) for any shape without a branch. Add a branch for `rework_returned_to_lead`: delivery `state === 'returned_to_lead'` and `route_revision === payload.routeRevision`; otherwise a stale hold (already re-delivered by 2922 or replaced) stages fine and then throws `workflow_hold_rework_changed` inside `resumeWorkflowHold`'s transaction (uncaught → 500 at `runs-route.ts:538`).

### 9. MINOR — `rework_replacement:<requestId>` resume-evidence UID is per request, not per revision

`materializeWorkflowReworkReplacement` 44966–45045 uses `resumeTransitionUid = rework_replacement:${requestId}` for the `rework_replacement` event and the resume attachment. The second replacement collides; `recordWorkflowResumeEvidenceSafelyTx` swallows `WorkflowEventUidConflictError` and records a `receipt_digest_mismatch` probe, so the second replacement silently has no resume attachment. Since C2 already re-keys `rework_replacement_materialized` by `deadRouteRevision`, re-key this one too (`rework_replacement:<req>:<newRevision>`); 2922 §3.5 lineage relies on these receipts.

### 10. MINOR — FLY-2910 dedup is content-fingerprinted, not UID-keyed

`alert-wake-dedup.ts:117–125`: fingerprint = hash(kind, title, context, normalized body lines) with a 6 h window. The plan's claim "身份按事件 UID … 不共用去重键" only holds if the route revision / event UID appears in the **body text** (the copyable `--hold-event <UID>` line does this — make it a requirement, not a coincidence, and add a test that two `returned_to_lead` alerts for consecutive revisions both wake).

### 11. MINOR — Unspecified counters and clocks

- `hold_count` on `replaceWorkflowReworkActor`: the plan resets it on Lead resume but is silent on replacement; state whether a replacement inherits the retry count.
- Within one revision the 5-retry budget is effectively 2 transport pushes (`push_count` cap 2 + `claimTurnWakeById` T1 rule); retries 3–5 are no-ops that still count. Acceptable, but say so in C3.1.
- `claimWorkflowReworkDelivery` preserves `updated_at` only for `awaiting_receipt|wake_delivered`; extend to `turn_granted AND wake_sent_at IS NOT NULL` or patrol staleness will reset on every probe.
- `wake_sent_at` duplicates the existing `sent_at` delivery clock (`projectWorkflowDeliveryClockTx` 46243). Keeping a column on the row is fine for CAS; note the redundancy so the two are written in the same transaction.

### 12. MINOR — C7 details

- TOCTOU: `reworkDelta` binds to `baseRevision` only; also bind `head` and require `reworkDelta.head === input.subjectDigest` (the body may commit between the diff and the transaction).
- `subjectDigest` cannot distinguish the 65626 session fallback from the server head inside the transaction; carry the server head in `reworkDelta` and refuse when it is absent, rather than relying on `input.subjectDigest` absence.
- The CLI hint "请用 `complete --route blocked`" points at a route that today is refused by `commitEnrolledCompletion` route mismatch (2922 plan §4 confirms and adds `commitEnrolledFailure`). Until 2922 lands, a body with a legitimately unchanged head (flaky QA FAIL) has no exit other than a dummy commit. Either sequence 2921 after 2922's `blocked` registration or word the hint conditionally.
- Verify the retryable refusals do not leave a completion marker that the slow marker reconciler re-drives (the invariant-refusal alert at 64866ff says markers are retried); the body needs a clean re-`complete` with a new head.
- `base_revision` = `nodeReuseBase?.baseRevision ?? input.subjectDigest ?? activeRequest?.base_revision ?? "unavailable"` (68589): for `authority='qa'` that is the QA completion's server head. Add a §8.1 assertion that it equals the implement-delivered head for qa / founder-kickback / land-conflict authorities; if QA runs in a separate worktree the equality is an assumption, not a fact.

### 13. MINOR — Consider `returned_to_lead` + `grant_started_at` in the completion-implied set (C1.8)

FLY-2473 evidence lists live-body triggers (`wake_failed`, `context_changed`). If the TURN was granted and the body completes while delivery is `returned_to_lead`, `settleWorkflowReworkOnCompletionTx` 44140ff will refuse (`rework_delivery_not_projectable`, non-retryable) and the body is stuck until the Lead presses resume. Accepting the completion as an implied receipt in that exact case (TURN granted, same epoch, same revision) is a cheap self-heal and closes the hold via the same `hold_resumed` receipt.

### 14. MINOR — Rollback script limits should be stated

`claimWorkflowReworkDelivery` sets `last_error = NULL` on every claim, so the `migrated:replacement_pending:` marker survives only until the new coordinator first touches the row. Rows that reached `returned_to_lead` on an ACTIVE run map to `needs_lead` under old code, which has no door on an active run (`openOperatorRework` 53740 requires `run.status === 'held'` for `heldNeedsLead`). Document that rollback is clean only before the first Bridge tick on the new build, and what the operator does for the rest.

### 15. MINOR — Test-plan strength

- FLY-2092 row: after resume, assert the coordinator reaches `wake_sent` (not just "正常认领"); this exercises credential rotation on revoked `rework_retry_exhausted_before_grant` credentials, a path that FLY-2092 proved was never reachable before.
- §8.2 concurrency: add "replacement launching vs `markWorkflowReplacementStartedTx`" (coordinator snapshot says `pending`, dispatcher moves to `wake_delivered` between reads) and assert the coordinator's defer/replace CAS is refused.
- C2 step 7 wording ("wake 成功：若原为 pending 先推进到 turn_granted") reverses today's order (advance before wake, coordinator 1120–1135). Either order is safe under the idempotent wakeId; say which one is intended so the crash-window test matches.

## Verdict

**CHANGES REQUESTED.** Issue 1 must be redesigned (recommend: stable TURN source/epoch, wakeId keyed by route revision). Issues 2–7 need concrete plan text before implementation starts; each has a small, local fix. The MINOR items are advisory but 8, 9 and 12 are cheap to fold in now. The overall approach (five states, delivery-scope Lead door, inline replacement, head check) is approved in principle and should not change.
