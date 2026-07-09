---
issue: FLY-1048
phase: qa
phaseCursor: 1/1
updated: 2026-07-09
nextStep: "E2E round 3 PASS (real Discord in 529 Room) → wait CI green on new head → re-affirm qa-result pass → report DONE to Tadashi (he re-surfaces #522)"
chunks: []
pointers:
  qa_report: engineering/doc/FLY-1048-watchdog-detection-remaining/qa-report.md
  e2e_driver: scripts/qa-fly-1048-real-discord-e2e.mjs
---

# FLY-1048 progress
**phase**: qa (verdict = PASS — code-level + real-machine E2E)
**round 1**: FAIL — config drift guard (6 unregistered FLYWHEEL_* env)
**round 2**: PASS — implement 496c245d fixed registry; CI green at 496c245d
**round 3 (Annie/Tadashi 补测)**: real Discord E2E in 529 Room — scripts/qa-fly-1048-real-discord-e2e.mjs
  16/16 PASS: pane_error_stalled real messages in isolated #test-flywheel-alerts (links in qa-report §7)
  + repeated-error-sig CANDIDATE + gap-scan 漏①漏② detection fired; prod alert dirs/claims.db untouched
**next**: wait CI green on new head → re-affirm qa-result pass → DONE report to Tadashi (#522 HELD by him, he re-surfaces)
