# Design Review — FLY-1925 plan.md (Round 3)
Date: 2026-08-20
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 incorporates the five Round 2 rulings in the main predicate and test matrix, and the architecture remains feasible without a migration or write-side change. In particular, the plan now preserves wake identity, excludes `approved` holders as producers, selects one authoritative run, separates judgment from parked-display availability, and revalidates a judgment fingerprint. The FLY-1855 full-pass acceptance anchor and FLY-1687 boundary remain sound.

I am still requesting changes because source verification found two remaining false-green paths. First, S1 excludes only aged/qualified W1 waiters, so a fresh waiter on the same exact TURN can masquerade as the actor that will eventually hand off to an older waiter. Second, exact wake identity is necessary but not sufficient: the production wake patrol cancels exact-identity wakes whose session or activation target is terminal/non-current, while S4 currently counts them as sources. There are also two bounded contract-cleanup items: the payload has no way to render the promised parked-display-unavailable marker, and stale Round 2 text still contradicts the new API and S5 ruling.

## What's Good (Keep)

- Keep the aged, exact W1 wait as the sole red trigger and generic `parked` as display-only.
- Keep wake epoch and activation in the typed CommDB snapshot, exact tuple comparison, `wake:stale`/`wake:exhausted` display states, and the same-tuple wake mutation fingerprint test.
- Keep gate-holder suppression limited to `materializing | awaiting_review`; `approved` must remain display-only and require a successor attempt, land operation, or carrier row.
- Keep the deterministic run precedence: one active run wins over held residue; one held run is selected only when there is no active run; zero runs is a valid observation; true cardinality ambiguity becomes unknown.
- Keep judgment-critical and display-only availability separate. Missing `runner_declared_states` must not hide a provable W1 red.
- Keep synchronous collection plus post-StateStore judgment fingerprint revalidation, with drift biased to unknown.
- Keep the structured, sanitized, capped renderer, stable `issueId` join, byte-identical legacy path, real-database T5 acceptance test, and unchanged patrol cadence/settlement behavior.
- Keep the read-only scope and the prohibition on new alerts, timers, flags, migrations, or Lead-side patrol rules.

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **S1 conflates red eligibility with “this execution is blocked,” leaving a mixed-age waiter false green.**

   Why it matters: the plan defines `W` as the qualified W1 set, and qualification includes the 30-minute age threshold. Consider E1 waiting on the current holder/epoch for two hours and E2 first observing the same exact tuple five minutes ago; both have `running` attempts and every other source is absent. E1 is red-eligible, but E2 is outside `W`, so E2's attempt satisfies S1 and suppresses the red. E2 cannot issue the belt—it has just durably observed `not-yours`; freshness should prevent E2 from triggering red, not turn its blocked attempt into a producer.

   Suggested fix: compute two sets once per issue. `W_blocked` contains every roster execution with an exact current `(holder, epoch)` wait row, regardless of age. `W_red` is `W_blocked` filtered by `first_seen_at <= now - PATROL_RED_MIN_WAIT_MS`. Require `W_red` to be nonempty to trigger red, but exclude every execution in `W_blocked` from S1. Add a mixed-age case (E1 aged, E2 fresh, both active attempts) that remains red because E1 is eligible and neither blocked attempt is a source; retain fresh-only → `not_triggered`.

2. **Exact Comm wake identity does not prove that the wake is deliverable under the real wake state machine.**

   Why it matters: `inspectWorkflowTurnWakeRetry` first cancels terminal sessions, then—for activation-backed wakes—requires a current active run/node/attempt and matching execution; terminal or non-current targets are cancelled (`StateStore.ts:43566-43649`). `drainTurnWakeOutbox` invokes that guard before delivery (`turn-wake-patrol.ts:41-63`, wired at `plugin.ts:8259-8268`). S4 checks only Comm identity and retry budget. An exact `(execution, epoch, activation)` wake left behind after its target node completed, or an exact legacy-null wake targeting a terminal session, can therefore suppress red until the patrol cancels it. This is the same “durable residue is not live authority” class fixed for approved gates.

   Suggested fix: make S4 mirror the read-only deliverability boundary without invoking a write path. For a non-null activation, count the wake only if the TURN's target run/node/attempt selects the current active attempt for that execution (otherwise S1/S5 must prove the loop). For a null recovery wake, require both TURN and wake activation to be null, exact execution/epoch, and a nonterminal/current roster target. Rows that the production guard would cancel remain `wake:stale`, not sources. Add cases for exact identity plus terminal node, exact identity plus non-current run/node, null wake against non-null TURN activation, and exact legacy recovery targeting a terminal session.

3. **The layered display-unavailable state cannot be represented by the proposed payload.**

   Why it matters: T0-20 promises that missing `runner_declared_states` still permits red while parked display is “marked unavailable.” `PatrolLoopEntry` has no display-availability field, and its waiter kind is limited to `turn-poll | turn-poll-stale | parked`. The collector can know `display.available:false`, but it cannot journal or render that fact without overloading `light`, `unknownReason`, or an undocumented string. Omitting parked silently is implementable; marking it unavailable is not.

   Suggested fix: add one optional closed field such as `displayWarnings?: Array<"parked_unavailable">` or `parkedDisplayAvailable?: boolean`, define its fixed sanitized rendering, and cover it in T3/T4. If the intended behavior is silent omission, remove “marked unavailable” from T0-20 and the prose instead. Do not turn a display failure into `light=unknown`.

4. **Residual Round 2 text contradicts the Round 3 implementation contract.**

   Why it matters: plan §5.4 still defines `PatrolCommReader` as `readPatrolTurnSnapshot + rereadTurnTuple + close`, although §5.1/§5.3 and T2 require `rereadJudgmentFingerprint`. Research §1.2 still says every non-`superseded` gate holder—including `approved`—conservatively counts as an open loop, directly contradicting corrected S5. The reducer prose also says “candidate active or held count >1” is ambiguous immediately after saying one active wins over held rows; only T0-11 disambiguates active+held. These are implementation-facing contradictions, not historical commentary.

   Suggested fix: replace the stale reader method in §5.4, correct research §1.2 to classify `approved` as display-only authority, and state the reducer as explicit branches: `active.length === 1` wins regardless of held rows; `active.length > 1` is unknown; otherwise select exactly one held, treat zero held as no run, and treat multiple held as unknown. Also update the §4 `LoopFacts` preamble from “turn tuple revalidation” to “judgment fingerprint revalidation.”

## Verdict

CHANGES REQUESTED — address items above
