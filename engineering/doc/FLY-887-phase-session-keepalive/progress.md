---
issue: FLY-887
phase: qa
phaseCursor: 4/4
updated: 2026-07-06T05:05:00.000Z
nextStep: re-request review at new head (dca5f5a4) after Finding B fix —
  waiting for founder approval
chunks:
  - id: reconcile-replay-fix-verify
    status: done
  - id: shipped-issue-edge-case-fix
    status: done
  - id: 529-room-real-machine-e2e
    status: done
  - id: founder-visibility-status-line
    status: done
pointers: {}
---

# FLY-887 progress
**phase**: qa (4/4) — PASS
**done**: (1) verified round-1 reconcileOnStartup fix (0d51ea3c) — 14/14.
(2) found+fixed a second edge case (hasShipFinalizationClaim, 19ead1d6).
(3) 529 Room real-machine E2E — all 5 target-behavior points PASS incl. two
real Bridge restarts mid-pipeline; two pre-existing orthogonal findings
noted as follow-up (not blockers). (4) Annie asked for a founder-visibility
status line built directly into 887 (not a follow-up) — implemented
(ffa72f65), real-machine verified across two more rounds (full-Discord
narrative re-run FLY-895, then a dedicated status-line check FLY-896):
edit-in-place confirmed via Discord message id + edited_timestamp, 3-way
phase coexistence confirmed via tmux/ps snapshot. Found + fixed a real gap
(Finding B: line went stale on ship, dca5f5a4) with 3 new tests. A separate,
pre-existing (not this PR's regression) retest-wake race (Finding A) flagged
for a follow-up issue, not a blocker. Full writeup in qa-report.md.
**next**: CI on dca5f5a4, then re-request review (gate approve_to_ship
--no-block + complete --route needs_review) — the prior approval was bound
to a stale head (56c9317f) so verify-approval correctly refuses to ship
until this round is re-approved.
