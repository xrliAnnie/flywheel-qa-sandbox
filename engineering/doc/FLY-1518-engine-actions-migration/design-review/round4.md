# Design Review — FLY-1518 plan.md (Round 4)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 closes both Round 3 findings as written: the free conversion-settlement exports are retired, and E10 now covers the requested lead/direct/late-context branches. The plan remains feasible and aligned with the actions black box, but the barrier is still not a complete driver invariant because action work can begin before its promise is registered and existing lifecycle paths can settle or discard the guarded state while an action is pending.

## What's Good (Keep)

- `submitProposal` and `reportConversionFailure` are now explicitly removed from the package root, retained only as package-private helpers, and protected by exact runtime/type negative assertions. The plan also records the supersession of FLY-1499's former free-settlement decision and correctly notes that the repository has no external callers to migrate.
- E10 now covers both direct settlement methods, lead success and failure exits, late use of a captured context, action rejection, unhandled-rejection prevention, and the public-surface negative assertion. These are the distinct branches requested in Round 3.
- The driver-owned registry remains the right-sized mechanism. Immediate rejection observation, context closure, and result retention support the stated ordering without introducing dispatch, scanning, probes, or automatic retries.
- The action identity, epoch fence, runner binding, replay/supersede behavior, typed serialization fallback, generation-succession semantics, and E1-E9 remain consistent with the founder-approved black-box model.
- M5 and the design-FINAL recovery runbook still specify an actual runtime-path restore, including migrated DB/WAL/SHM isolation, paired code rollback, and verification of the 0007 ledger and old-table rows.
- A fresh execution of the proposed 0008 DDL against the current 0001..0007 schema—with two commands, one dependency edge, and a depth-1 obligation—produced receipt counts `2/1/2`, removed all retired table/trigger/index objects, left foreign keys enabled, and returned zero `foreign_key_check` violations. The checksum-locked 0001/0002 files remain byte-identical to baseline.
- No new overlap with FLY-1520 and no dispatcher, executor registry, intended-row scanner, retry loop, or reconciliation path was introduced.

## Issues & Recommendations

1. **[HIGH] The plan does not establish registration-before-execution, leaving a reentrant settlement window.**

   Why it matters: The barrier says to register each action promise, but it does not define the required happens-before edge. Current `runRecordedAction` invokes `options.perform()` at `packages/v2-actions/src/index.ts:39` before its async function returns the promise to its caller. A natural implementation—call `runRecordedAction(...)`, receive its promise, then put that promise in `AgentState`—therefore runs the synchronous prefix of user `perform()` before the registry contains anything. That callback can reentrantly call `driver.submitProposal`, `driver.reportConversionFailure`, or `driver.stop`; the guard sees no in-flight action and settlement can precede `recordActionOutcome`. A direct JavaScript execution of this async shape confirms that `perform` observes the pre-registration state.

   Suggested fix: Require the driver to reserve/register a tracked placeholder before invoking `runRecordedAction` or any user `perform` code. For example, register a wrapper promise first and start the internal action on a subsequent microtask, with the observer attached to that wrapper before it is scheduled. Add an E10 regression whose synchronous `perform` prefix attempts driver settlement and proves it is fenced until the action outcome is recorded. This is an ordering rule inside the existing barrier, not a new mechanism.

2. **[HIGH] `stop()` and same-driver state replacement still bypass or destroy the barrier.**

   Why it matters: The current public `EngineDriver.stop()` sets `#stopped`, stops each `AgentState`, crash-settles every running attempt, updates the mailbox, and clears the state map (`driver.ts:190-250`) without consulting in-flight actions. `registerLead` invokes `registerAgentTx` before replacing the old state (`driver.ts:83-108`), and that transaction crash-settles running attempts (`registration.ts:113-137`); `attachRunner` also stops and replaces an existing state (`driver.ts:115-143`). Thus an action can still complete after a graceful stop/cutover settlement, or its registry can be discarded and a resumed handle settled by the replacement state. These are real driver-owned settlement/lifecycle paths, not the unavoidable cross-process “old process is confirmed dead” E6 window.

   Suggested fix: Apply the same per-handle guard to every local state-destroying or settling transition. With the current synchronous `stop()` API, preflight all states and throw `FenceViolation` before setting `#stopped` or mutating the database if any action is in flight; retrying stop after completion can preserve existing semantics. In `registerLead` and `attachRunner`, check the existing local state before `registerAgentTx`, `#stopState`, or map replacement. Add E10 cases proving stop and same-driver replacement are zero-mutation while pending and work after completion. Also clarify that the still-public `registerAgentTx` is a privileged confirmed-dead cross-process cutover primitive governed by E6—not a live-conversion settlement surface—or route that cutover through a driver-owned API; otherwise the statement that the two driver methods are the “only public settlement surface” remains behaviorally inaccurate.

3. **[LOW] Three execution-scope references still describe the pre-Round-4 test set.**

   Why it matters: §1.1 still says “回归两条,” §1.3 assigns only E1-E7 to `conversion-actions.test.ts`, and TDD step 3 still says “E10 barrier 双回归,” while §4 now defines a six-part E10 matrix and completion requires E1-E10. An implementer following the vertical-slice section can therefore under-implement the acceptance matrix.

   Suggested fix: Change those three references to the full E1-E10 / E10 guard matrix and name the file(s) that own the lifecycle and API-surface cases.

## Verdict

CHANGES REQUESTED — address items above
