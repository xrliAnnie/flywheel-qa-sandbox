---
issue: FLY-795
title: restart-resilient runner
phase: implement
phaseCursor: "6/6 chunks done; 1 activation step remaining"
nextStep: "plugin.ts ACTIVATION: build a live ResumeComputer closure where RunDispatcher is constructed and pass it as the 6th ctor arg, gated on env FLYWHEEL_PROGRESS_RESUME (default ON, =0 => fresh/skip). Closure builds ProgressResumeDeps: branchName = WorktreeManager.worktreeName(issue,role); priorSession = StateStore latest running/terminated session for issue+role (needs plan_path + session_stage + issue_identifier); readBranchFile = `git show <branch>:<path>` in projectRoot; branchTip = `git rev-parse <branch>` in projectRoot. Then: full build (pnpm build) + lint (pnpm lint) -> open PR (branch flywheel-FLY-795 already on origin) -> codex-code-review skill (design already APPROVED) -> independent QA -> HOLD at ship-gate for batch (793+795+799, Annie executes). NEVER self-ship."
chunks:
  - { id: c1, order: 1, deps: [], status: done, done: "shared progress-schema + path-resolver in flywheel-config (packages/config), 12 tests green — 4e554753" }
  - { id: c2, order: 2, deps: [c1], status: done, done: "flywheel-comm progress command (single-writer via StateStore + --file validation + atomic temp/rename + path-limited git commit), 6 tests — 983f4206" }
  - { id: c3, order: 3, deps: [c1], status: done, done: "teamlead computeProgressResume core (branch-blob read, effectiveStage cross-check vs ledger phase fail-closed, reuse 793 startPoint=branchTip + shareParentBranch), 7 tests — 96943ed9; RunDispatcher wiring threads progressResume/startPoint/shareParentBranch, 4 tests — d70a4680. REMAINING: plugin.ts live activation." }
  - { id: c4, order: 4, deps: [c3], status: done, done: "edge-worker resume-mode.ts (resumeModeInstructions: RESUME directive + suppressOnboardBrainstorm when effectiveStage implement|qa, ship-gate preserved) + Blueprint wiring (progressResume field on BlueprintContext, gated onboard-preamble, adapter ctx progressPath), 5 tests — e61cd674" }
  - { id: c5, order: 5, deps: [c4], status: done, done: "adapters FLYWHEEL_PROGRESS_PATH env: AdapterExecutionContext.progressPath (core) + TmuxAdapter + CodexTmuxAdapter push env (mirror FLYWHEEL_STATE_DB_PATH), inject only on resume; full build clean — 2b7c20cc" }
  - { id: c6, order: 6, deps: [c1], status: done, done: "stage-utils badge: pr_created split to 📬PR已开 (STAGE_EMOJI 📬 + STAGE_WORD PR已开), approve keeps ⏳待批, test stays 🧪QA (auto-QA stamps stage=test for real independent QA). Reverse-compat via derived EMOJI_TO_WORDS. 6 tests — 830107f3" }
pointers:
  plan: engineering/doc/FLY-795-restart-resilient-resume/plan.md
  exploration: engineering/doc/FLY-795-restart-resilient-resume/exploration.md
  research: engineering/doc/FLY-795-restart-resilient-resume/research.md
handoff: "FRESH-RUNNER RESUME ANCHOR. All 6 chunks (c1-c6) DONE + committed + green (35 tests total) + full build passes. Branch flywheel-FLY-795 on origin. 793 merged (3ebc6663) and rebased-on. READ plan.md (codex-APPROVED spec) + research.md first. ONE step remains: plugin.ts ACTIVATION — where RunDispatcher is constructed (grep `new RunDispatcher` in packages/teamlead/src), build a ResumeComputer closure {branchName=WorktreeManager.worktreeName(issue,role); priorSession=StateStore latest running/terminated session for issue+role incl plan_path+session_stage+issue_identifier; readBranchFile=`git show <branch>:<path>` in projectRoot; branchTip=`git rev-parse <branch>` in projectRoot} and pass as the RunDispatcher 6th ctor arg; gate on env FLYWHEEL_PROGRESS_RESUME (default ON, =0 => fresh, byte-compat). Then full build+lint (pnpm build; pnpm lint) -> open PR -> codex-code-review skill -> independent QA -> HOLD at ship-gate for batch (793+795+799). NEVER self-ship."
---

# FLY-795 progress — restart-resilient runner

**phase**: implement · **cursor**: 6/6 chunks done, plugin.ts activation remaining
**next**: build the live ResumeComputer closure at the RunDispatcher construction site + FLYWHEEL_PROGRESS_RESUME kill-switch, then build+lint → PR → codex-code-review → QA → hold for batch.

## chunks
- ✅ c1 — shared progress-schema + path-resolver in flywheel-config, 12 tests (4e554753)
- ✅ c2 — flywheel-comm progress command (single-writer + atomic commit), 6 tests (983f4206)
- ✅ c3 — teamlead computeProgressResume core + RunDispatcher wiring, 11 tests (96943ed9 + d70a4680); plugin.ts live activation still remaining
- ✅ c4 — Blueprint resume-mode + effectiveStage suppression + progressPath inject, 5 tests (e61cd674)
- ✅ c5 — adapters FLYWHEEL_PROGRESS_PATH env (Claude + Codex) (2b7c20cc)
- ✅ c6 — stage-utils badge: pr_created → 📬PR已开 split from approve ⏳待批, test stays 🧪QA, 6 tests (830107f3)

## remaining
- ⬜ plugin.ts ACTIVATION — live ResumeComputer closure at RunDispatcher ctor + FLYWHEEL_PROGRESS_RESUME kill-switch (default ON)
- ⬜ full build + lint → PR → codex-code-review → independent QA → HOLD ship-gate (batch 793+795+799). NEVER self-ship.
