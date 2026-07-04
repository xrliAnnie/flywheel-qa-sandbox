---
issue: FLY-795
title: restart-resilient runner
phase: implement
phaseCursor: "1/6"
nextStep: build the flywheel-comm progress write command (StateStore single-writer + path-limited atomic commit)
chunks:
  - { id: c1, order: 1, deps: [], done: "shared progress-schema + path-resolver in flywheel-config, 12 tests green", status: done }
  - { id: c2, order: 2, deps: [c1], done: "flywheel-comm progress command (single-writer + atomic commit)", status: doing }
  - { id: c3, order: 3, deps: [c1], done: "teamlead progressResume (branch-blob detect + effectiveStage authority + shareParentBranch reuse)", status: todo }
  - { id: c4, order: 4, deps: [c3], done: "Blueprint resume-mode + effectiveStage suppression + FLYWHEEL_PROGRESS_PATH inject", status: todo }
  - { id: c5, order: 5, deps: [c4], done: "adapters FLYWHEEL_PROGRESS_PATH env (Claude + Codex)", status: todo }
  - { id: c6, order: 6, deps: [c1], done: "stage-utils badge fix (test/pr_created) + legacy strip", status: todo }
pointers:
  plan: engineering/doc/FLY-795-restart-resilient-resume/plan.md
  exploration: engineering/doc/FLY-795-restart-resilient-resume/exploration.md
handoff: "impl phase — foundation (c1) done; c2-c6 remaining. 793 alignment: schema in flywheel-config, phase field = ThreeStagePhase, worktree reuses 793 shareParentBranch/startPoint."
---

# FLY-795 progress — restart-resilient runner
**phase**: implement (1/6) · **next**: build the flywheel-comm progress write command
## chunks
- ✅ c1 — shared progress-schema + path-resolver in flywheel-config, 12 tests green
- 🔨 c2 — flywheel-comm progress command (single-writer + atomic commit)
- ⬜ c3 — teamlead progressResume (branch-blob detect + effectiveStage authority + shareParentBranch reuse)
- ⬜ c4 — Blueprint resume-mode + effectiveStage suppression + FLYWHEEL_PROGRESS_PATH inject
- ⬜ c5 — adapters FLYWHEEL_PROGRESS_PATH env (Claude + Codex)
- ⬜ c6 — stage-utils badge fix (test/pr_created) + legacy strip
