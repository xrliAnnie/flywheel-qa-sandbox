---
issue: FLY-795
title: restart-resilient runner
phase: code_review
phaseCursor: "impl + plugin.ts activation DONE; Codex code review APPROVED (3 rounds)"
nextStep: "PR #436 open; Codex code review APPROVED after 3 rounds (R1 CHANGES 2H+3M → R2 CHANGES 1H+1M+1L, real-git-caught fresh-commit bug → R3 APPROVED). All fixes committed (bb63b808 R1, 845b36fb R2). Full build + repo lint clean; suites green (config 306, edge-worker Blueprint 109, teamlead 132, comm 14 incl 3 real-git). NEXT: approve gate (--no-block) + complete --route needs_review → HOLD at ship-gate for batch (793+795+799, Annie executes). Independent QA (529 Room) does the real restart-resume E2E. NEVER self-ship."
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
handoff: "FRESH-RUNNER RESUME ANCHOR. IMPLEMENTATION COMPLETE — all 6 chunks (c1-c6) + live plugin.ts activation (run-infra.ts ResumeComputer closure at the RunDispatcher ctor, 6th arg, FLYWHEEL_PROGRESS_RESUME kill-switch default ON) DONE + committed + pushed. Full build clean; repo-wide lint clean on my 21 files; 40 FLY-795 tests green (config 12 + comm 6 + edge-worker 5 + teamlead 17). Branch flywheel-FLY-795 on origin; 793 merged (3ebc6663) is the base. READ plan.md (codex-APPROVED spec) first. REMAINING (process only, no more code): open PR (flywheel-FLY-795 -> main) -> stage set pr_created (Bridge auto-triggers Codex code review) -> approve gate (--no-block) + complete --route needs_review -> HOLD at ship-gate for batch (793+795+799, Annie executes). NEVER self-ship. Independent QA verifies the real restart-resume E2E (real git re-dispatch on a branch carrying committed progress.md — the live git/StateStore wiring is not unit-mocked by design; computeProgressResume pure core has 7 unit tests)."
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

- ✅ activation — live ResumeComputer closure at RunDispatcher ctor + FLYWHEEL_PROGRESS_RESUME kill-switch (default ON) (b6410aaf); full build + repo-wide lint clean (e2d61166)

## remaining (process only — no more code)
- ⬜ open PR (flywheel-FLY-795 → main) → stage set pr_created (Bridge triggers Codex code review) → approve gate + hold
- ⬜ independent QA (real restart-resume E2E) → HOLD ship-gate (batch 793+795+799, Annie executes). NEVER self-ship.
