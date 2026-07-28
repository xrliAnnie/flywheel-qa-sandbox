---
issue: FLY-1505
phase: implement
phaseCursor: 4/5
updated: 2026-07-28T09:52:00.000Z
nextStep: Commit and push the live-sink binding fix, then wait for green CI
  and a fresh cross-family review
chunks:
  - { id: qa_fix_inspection, order: 1, deps: [], status: done, done: "Confirmed M1-M4 and two LOW findings against production paths; old approval explicitly void" }
  - { id: qa_fix_tdd, order: 2, deps: [qa_fix_inspection], status: done, done: "Added red-to-green regressions for boot ordering, alert acceptance, event-bound approval identity, unknown-head preservation, payload PR evidence, and exhaustive Heartbeat consumption" }
  - { id: qa_fix_validation, order: 3, deps: [qa_fix_tdd], status: done, done: "Lint, recursive build, package typechecks, and affected suites passed; broad tests passed except pre-existing macOS Terminal integration and two default-timeout flakes that passed serially with diagnostic margin" }
  - { id: qa_b2_fix, order: 4, deps: [qa_fix_validation], status: done, done: "Restored row-binding fallback only in the two live sinks; true qid-less blocked regressions failed before the fix and passed after it; delayed marker reconciliation remains event-only" }
pointers: {}
---

# FLY-1505 progress
**phase**: implement (4/5)
**next**: Commit/push the live-sink binding fix, wait for CI, and request fresh cross-family code review before QA re-verification.
