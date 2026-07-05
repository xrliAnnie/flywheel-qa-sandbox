---
issue: FLY-887
phase: qa
phaseCursor: 3/3
updated: 2026-07-06T02:55:00.000Z
nextStep: qa-result PASS + APPROVE GATE (this QA session is the ship
  executor) — round-3 full-Discord E2E re-run done (thread link given to
  founder), waiting for founder approval
chunks:
  - id: reconcile-replay-fix-verify
    status: done
  - id: shipped-issue-edge-case-fix
    status: done
  - id: 529-room-real-machine-e2e
    status: done
pointers: {}
---

# FLY-887 progress
**phase**: qa (3/3) — PASS
**done**: (1) verified round-1 reconcileOnStartup fix (0d51ea3c) resolves the
regression — 14/14, full teamlead/flywheel-comm/config/edge-worker suites
green, lint clean. (2) found + fixed a second edge case via code review
(Lead-approved, small addition): `hasShipFinalizationClaim` (19ead1d6),
2 new sentinel tests. (3) 529 Room real-machine E2E — all 5 target-behavior
points PASS with real tmux/worktree/CommDB TURN table + TWO real Bridge
restarts mid-pipeline exercising the exact fix scenario; two pre-existing
orthogonal findings noted as follow-up (config cached at Bridge boot;
FLY-827 codex-gate ↔ three-stage QA-as-ship-executor interaction gap — both
predate this PR, not blockers). Full writeup in qa-report.md.
**next**: qa-result --status pass, then APPROVE GATE flow (this session ships
FLY-887 once founder approves).
