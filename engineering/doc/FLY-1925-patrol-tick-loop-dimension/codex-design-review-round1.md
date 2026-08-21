# Design Review — FLY-1925 plan.md (Round 1)
Date: 2026-08-20
Author: Codex
Status: CHANGES REQUESTED

## Summary

The feature is feasible in the current architecture: `patrol-tick.ts` already has the right per-project/per-Lead pass and durable journal boundary, `formatPatrolTick` is the shared renderer, `StateStore` can expose read models without a migration, and `CommDB.openReadonly` is an established integration seam. The plan also preserves the important FLY-1687 boundaries: no new timer, flag, alert channel, Lead-side rule, or write-side recovery behavior.

I am not approving the plan yet because the proposed red-light predicate is not complete against the current state machines. As written, it has deterministic false-red paths (notably generic/Auto-QA `park`) and false-green paths (`pending` attempts are omitted; session status S5 and unscoped issue-level wakes/rework can mask a missing loop). The fail-honest promise is also contradicted by APIs that collapse a missing table into an empty ledger. Those issues affect the founder-visible trust signal, not just implementation detail.

## What's Good (Keep)

- Keep the change read-only and piggybacked on the existing patrol pass. The current GatePoller cadence, single-flight guard, delivery settlement, journal idempotency, and event ID chain should remain untouched.
- Keep `HookPayload.loops` optional and retain the byte-for-byte old rendering path when it is absent. That is the right replay-compatibility boundary.
- Keep one shared `formatPatrolTick` implementation for Mailbox and CommDB runtimes, with malicious-field fixtures and explicit token sanitization.
- Keep `judgeLoopLight` pure and dependency-injected. A table-driven predicate is the right place to make the safety policy auditable.
- Keep the acceptance anchor that recreates the FLY-1855 shape in real test databases and proves both the positive red row and a negative open-rework control.
- Keep the per-source/collector degradation concept and the rule that loop enrichment must never prevent the original roster tick from being delivered.

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **`parked` is not TURN-wait evidence by itself, so W2 will create repeatable false reds.**

   Why it matters: `declare-state park` is a generic “done-but-alive, idle by design” marker, not a TURN-specific contract (`packages/flywheel-comm/src/commands/declare-state.ts:1-23`). Auto-QA deliberately parks a failed QA for retest, and that QA runs on a separate QA issue from the parent (`StateStore.ts:1128-1157`; `auto-qa-coordinator.ts:1371-1389`). On the QA issue, S1-S5 can all be empty, so the plan would label a healthy `awaiting_retest` loop as “waiting for a nonexistent TURN loop.” Ordinary non-DAG parked runners have the same problem.

   Suggested fix: do not let a generic `runner_declared_states.kind='parked'` trigger red. It may still be displayed as `parked`. For the first implementation, make the high-confidence red trigger the exact, aged W1 tuple only; this still satisfies the FLY-1855 acceptance anchor. If parked must participate in red, require exact provenance that it is a current workflow/TURN park (for example, a current workflow activation plus current `workflow_engine_park_outbox` evidence), and explicitly recognize Auto-QA `awaiting_retest` as an existing non-TURN loop rather than joining it through the QA issue.

2. **S1-S5 is not a complete or accurate inventory of the current workflow state machines.**

   Why it matters:

   - S1 omits `pending`, but `pending` is a real successor reservation. The current node enum is `pending | admitted | running | review | done | failed | completed | superseded` (`StateStore.ts:49806-49816`), and admission explicitly recognizes `pending`/`running` before converting the reservation to `admitted` (`StateStore.ts:27815-27820`, `27863-27875`). A normal handoff window can therefore be falsely red.
   - S5 treats session projections (`awaiting_review`, `ship_parked`, `approved_to_ship`) as if they were loop authority. They are not. `ship_parked` is written when a node completes and is accompanied by a park projection (`StateStore.ts:32544-32628`); the actual durable next-work authorities live in current gate-holder, carrier-delivery, wake-send, rework, and land ledgers. A stale `ship_parked` row can hide the exact “park exists but its next loop was never materialized” defect this feature is meant to expose.
   - Runner-ship has a first-class `workflow_carrier_delivery` state machine (`StateStore.ts:17614-17645`; `workflow-ship-carrier-coordinator.ts:278-330`) that is absent from the source inventory. The current gate-holder state machine is also absent.

   Suggested fix: rewrite the source table against durable authorities, not session status. At minimum: S1 = current-run node states `pending | admitted | running`; S2 = current rework delivery plus its latest route; S3 = current non-superseded land operation; S4 = current, deliverable wake rows; S5 = current gate/carrier authority appropriate to the workflow mode. Use current workflow park evidence to classify a parked waiter, not to prove that a next loop exists. Document how Auto-QA is classified. Add one transition-table row and one negative test for every source.

3. **The issue-level suppressors are not scoped tightly enough to the waiter/current activation, creating false greens.**

   Why it matters: `countPendingWorkflowNodeAttempts(runId)` counts the waiting execution's own `running`/`admitted` row, even though that row can itself be blocked on TURN. `listOpenReworkDeliveryStates` discards `preferred_actor_execution_id`, target node/attempt, and route revision. `countLiveTurnWakesForIssue` discards `execution_id`, epoch, activation, push count, and retryability. A stale or unrelated row for the same issue can therefore suppress a real dead-wait. In particular, `turn_wake_outbox` only automatically claims rows with `push_count < 2` (`db.ts:5011-5018`), while the proposed count treats every `sent` row as live forever.

   Suggested fix: return structured rows, not counts/state strings. Preserve target execution, node/attempt, route revision, epoch/activation, and wake retryability. Evaluate each red candidate against current authority: the waiter's own blocked attempt must not count as its source; a rework/wake must be current for the selected run/turn tuple; stale outbox rows must remain visible but not prove a live source. It is fine to conservatively suppress red when a different current actor is genuinely doing work, but that must be an explicit rule rather than an accidental issue-level `COUNT(*)`.

4. **The fail-honest tri-state cannot be implemented with the proposed CommDB API semantics.**

   Why it matters: the plan promises “any required ledger read failure => unknown,” but it also specifies `no such table => 0` for wakes. Existing `getTurn` and `getEffectiveDeclaredState` similarly turn a missing table into `null` (`db.ts:4340-4371`, `4620-4637`). Conversely, `listTurnWaitLedger` is not readonly-tolerant at all—it directly queries the table and throws (`db.ts:4878-4903`), contrary to plan line 119. Thus a partially old/corrupt schema can be interpreted inconsistently and can still produce a founder-visible red from incomplete evidence.

   Suggested fix: add one patrol-specific, read-only CommDB snapshot API that first verifies the required tables/columns and returns a typed `{ available: true, ...facts } | { available: false, missingOrFailedSources }`. Do not change the legacy APIs' tolerant semantics. A missing required patrol source must become `unknown`, never “empty.” Rename the non-red state from `ok` to `not_triggered`/`no_red_evidence`; the plan correctly says absence of red is not proof of health, while `ok` communicates the opposite.

5. **The plan does not close the fresh-wait and mixed-snapshot race windows.**

   Why it matters: a `turn_wait_ledger` row is written on the first `not-yours` poll. The proposed API does not even return `first_seen_at`, so a tick coinciding with an ordinary handoff can immediately print red. CommDB is written by external runner CLI processes, and the plan reads turn, wait, declared state, and wakes in separate statements; an epoch/holder change can occur between them. teamlead.db and comm.db cannot provide one atomic cross-database snapshot.

   Suggested fix: include `first_seen_at` (and preferably `asked_at`) and require a documented minimum age before W1 is red. Read all Comm facts in one read transaction/snapshot, then synchronously read StateStore sources, and revalidate the exact turn tuple before emitting red; a changed tuple becomes stale/unknown, not red. Bias unavoidable races toward false green/unknown. Add tests that mutate the turn epoch/source between reads and a fresh-wait test that cannot red. This requires no timer, flag, or schema change.

6. **`identifier` is not a safe join key between issue-level loop facts and roster rows.**

   Why it matters: the existing roster falls back to each session's `execution_id.slice(0, 8)` when `issue_identifier` is absent. Two sessions for the same issue can therefore have different display identifiers, while `PatrolLoopEntry` has only one `identifier`. The renderer cannot reliably attach the issue fact, and “no loop entry” intentionally falls back to the old four-column row, silently hiding the condition.

   Suggested fix: add optional `issueId` (or another stable opaque issue key) to both `PatrolRosterEntry` and `PatrolLoopEntry`, and join on it. This is still backward-compatible because the fields are optional; old payloads continue down the exact legacy renderer. Keep `identifier` only for sanitized display. Add a multi-session, missing-identifier test.

7. **Several proposed StateStore reads are under-scoped or ignore current schema semantics.**

   Why it matters: `getPatrolWorkflowRunForIssue(issueId)` omits `project_name` and collapses potentially multiple `held` rows to an arbitrary latest row; only `active` is protected by a unique partial index. The proposed land query omits `project_name` and `superseded_at IS NULL`, even though superseded land operations remain non-`completed` and current production readers explicitly filter them (`StateStore.ts:48175-48201`). Those choices can either mask a dead-wait or manufacture an open loop from historical residue. The payload comment/allowlist for `currentAttemptState` also omits legitimate current states such as `pending`, `review`, `failed`, and `completed`.

   Suggested fix: scope every read by `(projectName, issueId)` and define ambiguity behavior. Prefer the unique active run; if there is no active run and multiple held runs, render all relevant residues or return `unknown:ambiguous_runs` rather than silently choosing one. Land reads must exclude `superseded_at IS NOT NULL` and consider all current open operations. Derive renderer allowlists from the exported state constants where possible.

8. **The payload/rendering shape is not actually bounded or structurally sanitized, and the TDD matrix misses the dangerous cases above.**

   Why it matters: `openLoops: string[]` combines kinds, states, and free-form/current step values into strings, while the plan simultaneously calls the result a closed enum. Land steps include dynamic values, so one whole-string allowlist will either hash legitimate values or become prefix-based and fragile. Open-loop and waiter lists are uncapped, and the example repeats issue-level facts on every session row despite the exploration choosing issue grouping; the “~120 chars” claim is therefore not enforced.

   Suggested fix: keep loop facts structured (`{kind,state,target?,step?}`), sanitize each rendered component, dedupe, and cap per-issue loops/waiters with `+N more`. Render one issue header with nested session rows, or explicitly cap repeated columns. Move the pure predicate contract tests before query implementation, then add negative tests for: `pending` reservation; self-target attempt; stale/wrong-target wake; generic parked runner; Auto-QA `awaiting_retest`; `ship_parked` with missing gate/carrier/land authority; missing table => unknown; superseded land; multiple held runs; fresh wait; epoch mutation during collection; and missing issue identifier. T6 should drive the real patrol pass with a real StateStore and temporary CommDB through the new snapshot reader, not only append a prebuilt payload.

## Verdict

CHANGES REQUESTED — address items above
