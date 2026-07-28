# Design Review — FLY-1518 plan.md (Round 3)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 substantively closes all four Round 2 findings: the in-flight barrier now has an explicit lifecycle, M5 exercises a real restore, Z1b is coherent, and the TDD order follows the actual dependency graph. The design is otherwise implementable and aligned with D1/D2/D3, but the claimed driver invariant is still bypassable through the existing package-root free settlement functions, so it is not yet safe to approve.

## What's Good (Keep)

- The barrier has the right core mechanics: register every action promise before returning it, attach a rejection observer immediately, close the lead context before draining, and make settlement wait for the complete registered set. These rules directly address the enumerated missing-`await` failure without adding a dispatcher, retry loop, or probe.
- The epoch fence, per-action invocation identity, runner binding, replay/supersede rules, and typed serialization boundary remain internally consistent with the actions-black-box contract.
- M5 is now a recovery test rather than a backup readability test. It names the migrated database/WAL/SHM isolation, restores the snapshot into the runtime path, reopens that path, and verifies the 0007 ledger plus retired-table data. The matching design-FINAL §4 runbook correctly pairs data restore with code rollback.
- M3/M4/M5 and Z1b now distinguish historical migration evidence from production runtime SQL. The allowlist includes the unavoidable 0008 DDL and negative schema assertions without weakening Z1a.
- The revised TDD sequence puts `ActionSerializationError` before its v2-actions consumer and includes E8/E9/E10 before settlement narrowing. This respects both package dependencies and the new engine dependency/lockfile work.
- The proposed 0008 SQL remains mechanically sound. A fresh probe against the current 0001..0007 schema, including two commands, one dependency edge, and a depth-1 obligation, produced the exact receipt counts, removed all six retired table/trigger/index objects, left foreign keys enabled, and returned zero `foreign_key_check` violations.
- No new executor registry, intended-row scanner, automatic retry, reconciliation loop, or FLY-1520 file/migration overlap was introduced.

## Issues & Recommendations

1. **[HIGH] The package-root free settlement APIs bypass the new `AgentState` barrier.**

   Why it matters: The plan defines the barrier as a driver invariant stored in `AgentState`, and adds guards to `EngineDriver.submitProposal` / `EngineDriver.reportConversionFailure`. Current `packages/v2-engine/src/index.ts:23-27`, however, also exports the free `submitProposal(kernel, runtime, proposal)` and `reportConversionFailure(kernel, runtime, handle, error)` functions implemented at `settlement.ts:128` and `settlement.ts:167`; the exact API-surface test requires both exports. Those functions have no access to the driver's in-flight registry. A caller holding `kernel` and `runtime` can therefore start `driver.performConversionAction(...)` without awaiting it, call the free settlement function, and commit mailbox/attempt settlement while the action outcome is still pending—the exact E10/D1 failure the barrier is meant to prevent. The plan scopes API-surface updates but never retires these exports; §1.2 otherwise promises to leave the settlement path unchanged. A repository sweep found no caller outside `packages/v2-engine`, so compatibility does not justify leaving the bypass open.

   Suggested fix: Explicitly remove both free settlement functions from the package root and make them package-private implementation helpers. Keep `EngineDriver.submitProposal` and `EngineDriver.reportConversionFailure` as the only public settlement surface, update the exact runtime export and public type tests, add negative API assertions, and record that FLY-1518 supersedes FLY-1499's original “public free settlement entry” decision because action/settlement ordering now requires driver-owned state. If a free API truly must remain, it needs an opaque driver-issued settlement permit bound to the barrier; with no current external callers, removing the exports is the smaller mechanism.

2. **[MEDIUM] E10 does not cover all barrier branches the plan claims as invariants.**

   Why it matters: E10 currently tests only (a) a successful lead converter that forgets to await a deferred action and (b) `submitProposal` while a runner action is pending. The plan also promises that `reportConversionFailure` fails closed while an action is pending, a captured `ConversionContext` cannot be used after close, and every lead exit—including converter throw / `{ok:false}`—drains registered actions before failure settlement. These are distinct branches in the current `#runLead` structure; testing the success path does not prove that an early failure branch cannot settle while an action remains in flight.

   Suggested fix: Expand E10 into a small guard matrix: pending action rejects both driver settlement methods; a context captured by the converter rejects late `performAction` with `FenceViolation` and creates/performs nothing; and a converter that starts a deferred action then throws or returns `{ok:false}` does not failure-settle until the action resolves, with an action rejection producing exactly one failure settlement and no unhandled rejection. Keep this within the existing barrier—no new mechanism is required.

## Verdict

CHANGES REQUESTED — address items above
