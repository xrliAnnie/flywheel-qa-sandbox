---
issue: FLY-1224
phase: qa
phaseCursor: 9/10
updated: 2026-07-13T22:54:00.000Z
nextStep: awaiting Tadashi decision on Annie live-watch delivery (stable cmux window now vs FLY-1225 A-smoke); gate 7be85b5c held on head b4afda889 (do NOT move head)
chunks: []
pointers: {}
---

# FLY-1224 progress
**phase**: qa (9/10)
**code verdict**: PASS (build/typecheck/tests green; mutation α/β/γ verified; real-dist 10/10) — qa-result PASS emitted.
**529-B real-machine (Tadashi directive d162c25a, path B)**: PROVEN via module-driven harness on #576 dist —
  - live daemon argv has `-c model_reasoning_effort="xhigh"` (FLY-1224 effort override on the REAL codex daemon)
  - model gpt-5.6-sol; real codex WROTE smoke-fly1224.md (correct 3-model content); goal succeeded (18767 tokens)
  - live codex TUI window renders (`f24-ttytest:codextui`) showing "model: gpt-5.6-sol xhigh" + Codex actively working
  - evidence durable at engineering/doc/FLY-1224-per-phase-vendor/e2e-evidence/ (screenshot + daemon-argv-ps + written file + logs)
  - harness first attempt window died (detached-session pty quirk in ensureRunnerTuiWindow, NOT FLY-1224 code); renders fine in a proper tmux pane
**pending**: Tadashi decision (ask d73b540f) — deliver Annie's LIVE watch now (stable long-lived daemon + cmux attach) OR captured evidence suffices for B + live watch via FLY-1225 A-smoke.
**HEAD DISCIPLINE**: gate 7be85b5c bound to b4afda889 — B evidence NOT committed to branch yet (would move head, break founder approval binding / FLY-921). Fold in after gate resolves.
**do NOT ship** (not approved).
