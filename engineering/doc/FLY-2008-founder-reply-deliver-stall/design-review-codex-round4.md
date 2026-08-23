# FLY-2008 plan.md — Codex Design Review (Round 4)

Date: 2026-08-23
Author: Codex
Status: APPROVED

## Summary

The plan is internally consistent, scoped to the two founder-ratified disease tracks, and implementable against the current codebase. All prior gating findings are resolved: query semantics and planner coverage are sound, founder scanning is fairly budgeted without weakening question delivery, probe forensics preserve behavior, and production health wiring and ownership paths have executable tests.

## What's Good (Keep)

- A1 preserves the original claim set and ordering exactly: `QUEUED` and reclaimable `LEASED` are mutually exclusive, each branch supplies its `(priority, seq)` minimum, and their minimum is the old union's global winner. The fenced update remains unchanged.
- The three partial indexes match SQLite's implication rules and their production predicates. In particular, omitting state from `mailbox_legacy_adopt` is necessary because the adoption query's state condition is nested in an OR term; the bound-parameter EQP guard correctly prevents literal-plan false confidence.
- `ORDER BY +seq` addresses the rowid-order planner trap without changing row order, and the full per-tick query-plan inventory includes the previously missed `claimQueueBatch` head query.
- B1 preserves all question-bound work while applying an independent budget only to pure ingress scans. The strict upper-bound cursor, wrap rule, per-attempt advancement, and insertion/deletion/restart tests provide a credible no-starvation contract.
- B2 now has explicit and type-safe ownership. The default lease retains today's open/use/close lifetime, the pass lease lends the real shared `CommDB`, and only the outer owner performs the real close; tests cover founder-review, ship-gate, normal, and exceptional paths.
- The detailed tmux-probe sibling retains and forwards `runTmux`, preserves the legacy four-state API, and exposes timeout versus empty-output evidence at the only layer where that distinction still exists.
- Pending is correctly modeled as an orthogonal target classification. It increments once per probe and annotates failure evidence while the `found` lookup, detailed probe call, and final verdict remain unchanged for absence, timeout, and normal pane outcomes.
- The forensic snapshot has a stable zero-filled shape and is wired through the late-bound HeartbeatService reference, real manifest builder, optional validator contract, and `/health` HTTP response without a schema-version bump.
- The plan introduces no new flag or environment variable and does not implement the forbidden threshold-versus-period mitigation. Its acceptance criteria match `event-loop-attribution.ts`: 30-second windows mint episodes at max delay ≥1,000 ms, while >500 ms spans are attribution context only.
- Sequencing is now TDD-complete: the lower probe, pending characterization, and HTTP health states are RED before forensic implementation, and A2b is explicitly included in the query GREEN phase.

## Issues & Recommendations

1. **Non-blocking implementation note — bind the default lease release callback.** `CommDB.close()` reads `this.db`, so assigning the method as an unbound function would lose its receiver. **Suggested fix:** construct the default lease with `release: () => db.close()` (or an equivalently bound callback), while the borrowed pass lease keeps its intentional no-op release. This does not change the approved design.

## Verdict

APPROVED — ready to implement
