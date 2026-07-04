---
issue: FLY-795
title: restart-resilient runner
phase: implement
phaseCursor: "2/6"
nextStep: "POST-COMPACT RESUME: do c3-wiring next. Wire computeProgressResume (packages/teamlead/src/bridge/progress-resume.ts) into RunDispatcher.start (packages/teamlead/src/bridge/run-dispatcher.ts): build real deps (git show/rev-parse + StateStore priorSession), set req.startPoint=info.startPoint + req.shareParentBranch=true, add progressResume to BlueprintContext. Then c4 Blueprint resume-mode + FLYWHEEL_PROGRESS_PATH inject, c5 adapters env, c6 badge (pr_created ONLY, test stays 🧪QA). Then full build+lint (pnpm -w) -> PR -> codex-code-review -> independent QA -> hold for batch. plan.md = codex-approved spec. NOT self-ship."
chunks:
  - { id: c1, order: 1, deps: [], done: "shared progress-schema + path-resolver in flywheel-config, 12 tests green", status: done }
  - { id: c2, order: 2, deps: [c1], done: "flywheel-comm progress command (single-writer + atomic commit)", status: done }
  - { id: c3, order: 3, deps: [c1], done: "teamlead progressResume core logic (branch-blob detect + effectiveStage authority + shareParentBranch reuse), 7 tests; WIRING into RunDispatcher remaining", status: doing }
  - { id: c4, order: 4, deps: [c3], done: "Blueprint resume-mode + effectiveStage suppression + FLYWHEEL_PROGRESS_PATH inject", status: todo }
  - { id: c5, order: 5, deps: [c4], done: "adapters FLYWHEEL_PROGRESS_PATH env (Claude + Codex)", status: todo }
  - { id: c6, order: 6, deps: [c1], done: "stage-utils badge fix — CORRECTION: test stays 🧪QA (auto-qa-coordinator stamps stage=test for REAL QA, auto-qa-coordinator.ts:370/501; Annie校正基于我图误标test在Implement下); ONLY pr_created→📬PR已开 + legacy strip. surface to Lead/Annie.", status: todo }
pointers:
  plan: engineering/doc/FLY-795-restart-resilient-resume/plan.md
  exploration: engineering/doc/FLY-795-restart-resilient-resume/exploration.md
handoff: "RESUME ANCHOR for /compact. DONE+committed+green: c1 (config schema+resolver, 4e554753), c2 (flywheel-comm progress cmd, 983f4206), c3-core (teamlead computeProgressResume, 96943ed9) = 25 tests. Branch flywheel-FLY-795 rebased on origin/main (793=3ebc6663). KEY: reuse 793 shareParentBranch/startPoint (zero worktree change). REMAINING: c3-wiring, c4, c5, c6. Read plan.md (codex-approved) + this file to continue."
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
