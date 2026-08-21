# Design Review — FLY-1925 plan.md (Round 4)
Date: 2026-08-20
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 correctly applies all four substantive Round 3 changes in the main implementation contract. The dual waiter sets now separate alarm age from blockedness; activation-backed wakes are checked against the current TURN target attempt; parked-display availability has an explicit payload representation; and the pass DI contract consistently uses judgment-fingerprint revalidation. The architecture remains feasible, read-only, bounded, and consistent with FLY-1687.

Two narrower correctness gaps remain. Because `W_blocked` now changes S1, the revalidation fingerprint must cover every exact-tuple wait row, not only the aged/“qualified” rows named in the current text. Also, the legacy-null S4 rule does not quite mirror `inspectWorkflowTurnWakeRetry`: production checks irreversible terminal status and then permits an activation-less wake, whereas the plan requires membership in the narrower patrol roster. That can create a false red for a deliverable legacy recovery wake targeting a live but non-roster session. A residual run-reducer sentence in research.md also still contradicts the explicit active-wins rule.

## What's Good (Keep)

- Keep `W_blocked` as every exact current-tuple waiter and `W_red` as its aged subset. Red requires `W_red`, while S1 excludes all of `W_blocked`.
- Keep the mixed-age regression test and fresh-only negative control.
- Keep activation-backed wake validation against the TURN target run/node/attempt and selected active attempt; terminal/non-current residues remain display-only `wake:stale`.
- Keep the exact-null legacy rule, exhausted-wake handling, structured wake identity, and same-tuple wake fingerprint test.
- Keep `displayWarnings` independent of `light`, with a closed `parked_unavailable` value and fixed rendering.
- Keep the explicit run reducer in plan §4, including active-over-held precedence, defensive multiple-active unknown, one-held fallback, and zero-run observation.
- Keep the narrowed S5 rule and corrected gate-holder research: `approved` is evidence, not a producer.
- Keep the layered snapshot availability, synchronous collector, scoped StateStore reads, stable `issueId` join, capped/sanitized renderer, legacy byte compatibility, and real-database T5 acceptance anchor.
- Keep the no-write/no-alert/no-timer/no-flag/no-migration/no-Lead-rule scope boundary.

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **The judgment fingerprint has not been expanded from `W_red`/“qualified waits” to all of `W_blocked`.**

   Why it matters: S1 now depends on membership in `W_blocked`, including fresh exact-tuple waiters. CommDB is written by runner CLI processes, so a runner can add an exact-tuple wait row while the synchronous Bridge collector is reading StateStore. The plan and research still describe the fingerprint as TURN + “qualified wait rows” + wakes. If “qualified” means aged W1/W_red, a newly inserted fresh row is invisible even though it changes whether that execution's active attempt is an S1 source. The result can remain `not_triggered` when the final ledger would be red—a false green not covered by the same-tuple wake mutation test.

   Suggested fix: define the fingerprint's wait component as all raw wait rows for the issue's roster execution IDs, including holder, epoch, and `first_seen_at`, canonically sorted. The caller can derive both `W_blocked` and `W_red` with the fixed `nowMs`; any row insertion, deletion, or tuple/first-seen change between snapshots becomes `unknown`. Update §4, §5.1, research §3, and the risk table to say `W_blocked wait rows`, and add T0/T2 coverage for a same-TURN fresh wait row appearing during collection.

2. **The activation-null S4 rule is stricter than the production delivery guard it claims to mirror.**

   Why it matters: `inspectWorkflowTurnWakeRetry` looks up the StateStore session, cancels only when its status is in `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`, and then immediately returns `deliver` when no activation ID exists (`StateStore.ts:43580-43587`). It does not require the target to appear in `getPatrolRosterSessions`; a reversible legacy status such as `approved`, or even an absent StateStore session backed by Comm transport state, is not cancelled by this guard. The patrol roster is narrower than that boundary. Therefore an exact, retryable recovery wake can be deliverable in production but treated as nonexistent by S4, yielding a founder-visible false red after an aged waiter appears.

   Suggested fix: for null-activation wakes, mirror the actual guard: require both TURN and wake activation to be null plus exact execution/epoch, then use the target session's StateStore status only to reject `isStateStoreIrreversibleTerminalForZombie(status)`. Do not require patrol-roster membership. Add the read-only session lookup to the injected facts (failure → unknown); preserve the production behavior for `undefined` unless the plan explicitly chooses and documents a more conservative unknown. Add tests for an exact wake targeting a reversible non-roster status, a missing StateStore session, and each irreversible terminal class versus a live roster target.

3. **The supporting research still contains the old ambiguous run-reducer rule.**

   Why it matters: plan §4 is now precise, but research.md still says that more than one candidate “active or held” run yields `ambiguous_runs`. That contradicts the accepted rule that exactly one active run wins regardless of how many held residues exist. Plan §5.2 retains similarly compressed “candidate count >1” wording. An implementer following those summaries instead of T0-11 can make active+held unknown and hide useful loop output.

   Suggested fix: copy the explicit four-branch reducer from plan §4 into research.md and use the same wording in §5.2. While doing the final assertion-guarded sweep, update the risk-table test range from T0 ①-⑳ to include ㉑/㉒ and make the early research statement about `pending`/`sent` wakes clear that those are outbox states, not sufficient live-source authority by themselves.

## Verdict

CHANGES REQUESTED — address items above
