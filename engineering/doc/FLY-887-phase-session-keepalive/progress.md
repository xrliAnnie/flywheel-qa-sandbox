---
issue: FLY-887
phase: qa
phaseCursor: 2/3
updated: 2026-07-06T00:15:00.000Z
nextStep: 529 Room real-machine E2E running in background (park/wake/TURN/
  fail-loop/Bridge-restart/ship/teardown) — verdict + qa-result pending its
  completion
chunks:
  - id: reconcile-replay-fix-verify
    status: done
  - id: shipped-issue-edge-case-fix
    status: done
  - id: 529-room-real-machine-e2e
    status: in_progress
pointers: {}
---

# FLY-887 progress
**phase**: qa (2/3)
**done**: (1) verified round-1 reconcileOnStartup fix (0d51ea3c) resolves the
regression — 14/14 → still green after round 2 additions; full
teamlead/flywheel-comm/config/edge-worker suites green, lint clean.
(2) found + fixed a second edge case via code review (Lead-approved, small
addition): reconcile couldn't tell a genuine crash remnant from an
already-shipped issue stranded mid-`finalizeThreeStagePhases` —
`hasShipFinalizationClaim` closes it, 2 new sentinel tests, committed+pushed
as `19ead1d6`.
**in progress**: 529 Room real-machine E2E (Lead-mandated hard gate before
ship) — deployed via a disposable `qa-e2e-887-scratch` sandbox branch
(fake test-fixture secrets neutered for push-protection only, never touches
the real PR branch), running in a background agent covering park→wake→
TURN→fail→fix→retest→Bridge-restart-mid-flight→ship→teardown.
**next**: synthesize E2E result into final QA report + qa-result + (if PASS)
approve-gate flow.
