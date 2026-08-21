# Design Review — FLY-1925 plan.md (Round 2)
Date: 2026-08-20
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 is materially stronger and remains feasible in the current architecture. The revised plan correctly narrows the founder-visible red signal to an aged, exact W1 TURN wait; keeps generic `parked` display-only; uses stable `issueId` joins; includes `pending` and `review` node states; scopes StateStore reads; distinguishes missing CommDB ledgers from empty ledgers; preserves the FLY-1687 delivery contract; and drives the real pass in the acceptance test. Those changes remove the deterministic false-red paths from Round 1.

I am still requesting changes because two proposed suppressors are broader than their real authority. S4 can treat a stale or unrelated wake from the same issue as a live source because the snapshot drops its epoch and activation. S5 treats an `approved` gate holder as an active loop even though approval has already fired: current code atomically creates the downstream carrier, successor attempt, or terminal transition. In both cases, historical evidence can hide the exact missing-handoff shape this red light is intended to expose. The run/waiter cardinality and predicate-vs-display availability rules also need to be made explicit before implementation.

## What's Good (Keep)

- Keep red v1 anchored only on a roster W1 whose `(holder_exec_id, epoch)` exactly matches the current TURN and whose `first_seen_at` is at least the fixed 30-minute threshold. Keeping `parked` visible but non-triggering is the right trust-preserving ruling.
- Keep S1's full active set `pending | admitted | running | review`, including unbound `pending` reservations, and keep a blocked waiter's own attempt from proving that a producer exists.
- Keep the patrol-specific CommDB snapshot API, preflight schema inspection, one read transaction, `available:false` result, and legacy API semantics unchanged.
- Keep all StateStore reads scoped by project and issue, the non-superseded land filter, structured rework route data, and exported-state-derived rendering allowlists.
- Keep `issueId` as the join key and `identifier` as display-only data. The optional payload additions and byte-identical legacy rendering path are the correct replay boundary.
- Keep structured, sanitized, deduplicated, capped loop rows; issue grouping; the five-row red cap; and fixed-template red explanations.
- Keep the TDD order: pure predicate matrix first, source readers next, pass/render integration after that, and a real StateStore plus temporary CommDB FLY-1855 acceptance test last.
- Keep the scope boundary: read-only, no new alert path, timer, flag, migration, Lead-side patrol rule, or recovery write.

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **S4 still accepts stale or unrelated wake residue as a live loop source.**

   Why it matters: `turn_wake_outbox` durably stores `execution_id`, `issue_id`, `epoch`, and `activation_id` (`packages/flywheel-comm/src/db.ts:141-163`), and receipt acknowledgment is deliberately exact on execution, epoch, and activation (`db.ts:5181-5193`). The proposed snapshot reduces a wake to `{state, pushCount, executionId}`, while the predicate checks only issue, state, and retry budget. A `pending` wake for epoch N-1, a wrong activation, or a different target execution can therefore suppress a real epoch-N dead-wait. `claimDueTurnWake`'s `push_count < 2` condition establishes retry budget only; the Bridge's later `inspectWorkflowTurnWakeRetry` guard is what establishes target currentness.

   Suggested fix: include at least `epoch` and `activationId` in every snapshot wake. Count S4 only when the wake is retryable **and** its execution, epoch, and activation match the current TURN target tuple. For an activation-backed TURN, also require its target run/node/attempt to be the selected current attempt; define the exact legacy-null rule for recovery wakes. Keep mismatched rows display-only as `wake:stale` and exhausted rows as `wake:exhausted`. Add T0 cases for old epoch, wrong execution, wrong activation, exact-current wake, and exact-current exhausted wake; assert the richer shape in T2.

2. **An `approved` gate holder is durable approval evidence, not an active handoff source.**

   Why it matters: the plan and corrected research count every non-`superseded` gate holder as S5. In the real approval transaction, however, the holder becomes `approved` and the same transaction either reserves the land successor (`StateStore.ts:38855-38894`), completes an engine-terminal run (`38895-38928`), or inserts a `workflow_carrier_delivery(state='pending')` row (`38929-38948`). The holder does not subsequently issue a TURN by itself. Consequently, `approved` with no successor attempt, land operation, or non-completed carrier is ledger inconsistency—not a conservative source—and counting it masks a missing post-approval loop.

   Suggested fix: let gate-holder S5 suppress red only in `materializing | awaiting_review`. Render `approved` as historical/current authority, but require S1, S3, or the carrier half of S5 to prove its downstream loop. Add predicate cases for `approved` alone → red, `approved + carrier pending` → `not_triggered`, `approved + pending land successor` → `not_triggered`, and retain `awaiting_review` → `not_triggered`. Correct the S5 statement in both plan.md and research.md.

3. **The selected-run and multiple-waiter reductions are not fully specified.**

   Why it matters: `getPatrolWorkflowRuns` intentionally returns every `active | held` row, but all subsequent run-scoped readers accept one `runId`. The plan defines only “no active plus multiple held” as ambiguous. A historical held run must not contribute attempts, rework, gate, or carrier rows when one active run exists, or it can create a false green. Separately, S1 says only “the waiter's own” attempt is excluded. If E1 and E2 are both qualified W1 waiters and each has an active attempt, a per-candidate implementation can let E2 suppress E1 and E1 suppress E2 even though every purported actor is blocked.

   Suggested fix: specify a deterministic reducer: exactly one active row wins and all held rows are display-only; with no active, exactly one held is selected; more than one candidate active or held is `unknown(ambiguous_runs)`; no run remains a valid “no run-scoped source” observation. Define the qualified W1 execution set `W` once per issue and count S1 only for an unbound `pending` reservation or an active attempt whose execution is not in `W`. Add active+held, zero-run, and two-waiter cross-suppression tests.

4. **Fail-honest availability currently treats display-only ledgers as red-predicate dependencies.**

   Why it matters: after the W1-only ruling, `runner_declared_states` supplies only the optional `parked` display. Nevertheless, `readPatrolTurnSnapshot` requires all four CommDB tables and returns one all-or-nothing `available:false`; a missing declared-state table would hide an otherwise fully provable FLY-1855 red behind `unknown`. The same distinction applies to display enrichment such as latest terminal attempt details. This is safe from false red but unnecessarily increases false negatives, contrary to the plan's explicit concern about false greens hiding dead-waits.

   Suggested fix: separate judgment-critical availability from display enrichment. TURN, wait, wake, and S1-S5 failures remain `unknown`; declared-state failure should mark only parked display unavailable and must not prevent W1 judgment. Represent this explicitly in the snapshot/facts type rather than relying on catch behavior. Add a test proving “missing `runner_declared_states` + complete W1/S1-S5 facts” still evaluates red while parked display is unavailable.

5. **The final revalidation checks only the TURN tuple, not the other mutable CommDB facts used by the verdict.**

   Why it matters: the one-transaction initial snapshot is internally consistent, but a same-tuple wake state change is invisible to `rereadTurnTuple`. The StateStore reads are also described as six independent calls rather than one stated snapshot/no-yield critical section. Under the current single-Bridge event-loop architecture the false-red window is narrow, but the plan currently claims the race is closed without recording the invariant that makes it safe.

   Suggested fix: either (a) reread and compare a small judgment fingerprint—current TURN plus the qualified wait and current-target retryable wakes—after the synchronous StateStore collection, returning `unknown` on drift, or (b) explicitly require the collector to contain no `await`/yield, document StateStore's single-writer assumption, and call this a bounded residual race rather than a closed one. Add a same-epoch wake mutation test if choosing the fingerprint route. This does not require a timer, migration, or write path.

## Verdict

CHANGES REQUESTED — address items above
