# QA Report: FLY-858 — FLY-849 combined-batch QA round 4 (FLY-856 handoff-leadid-fix verification)

**Issue**: FLY-858 (QA·FLY-849 harness round 4 — verify FLY-856 handoff-leadid fix: tmux self-close + no unarchive)
**Branch**: `project-slot-2-FLY-858` → PR #47 → base `qa/fly849-793-batch-combined`
**Verifies**: FLY-856 (PR #442, `resolveLeadId` fix, commit `eb4d4f5`) as merged into the FLY-849 combined-batch (793+795+799+cmux+856)
**Date**: 2026-07-04
**Verifier**: runner-ebe73483 (QA phase, Sonnet — independent of the Design/Implement phases of this same three-stage run)
**Status**: ✅ PASS on everything checkable from the PR/repo side; the round's two real verification points are **out-of-band Bridge/cmux runtime behavior** and are explicitly NOT asserted here (see §3)

---

## 0. What this round actually tests

Per the issue and the Design-phase exploration (`engineering/doc/FLY-858-round4-marker/exploration.md`), the deliverable (a one-file doc marker) is deliberately trivial — **the subject under test is the pipeline's own multi-model phase-handoff and finalization behavior**, run for real (no manual simulation) through Design=Fable → Implement=Opus → QA=Sonnet. This QA session's job is to (a) verify the trivial deliverable against the plan, (b) sanity-check that the FLY-856 code fix it is meant to exercise is structurally sound on this combined branch, and (c) NOT fabricate any assertion about the two harness-side observations, which this session cannot see (they concern this session's own tmux window and Discord thread lifecycle, observed from outside after this session ships).

## 1. Deliverable verification (in-band, this session can assert these)

| Check | Result |
|---|---|
| `doc/qa/harness/FLY-849-round4-marker.md` exists | ✅ |
| Heading is exactly `# FLY-849 round 4 marker` (`grep -Fx`) | ✅ |
| Body sentence matches `FLY-856 handoff-leadid-fix verification round.*Design=Fable.*Implement=Opus.*QA=Sonnet.*no manual simulation` | ✅ |
| PR #47 base branch | `qa/fly849-793-batch-combined` ✅ |
| PR #47 diff vs base (`git diff --name-status qa/fly849-793-batch-combined...HEAD`) | Exactly 4 files: the marker + this run's own process docs (`engineering/doc/FLY-858-round4-marker/{exploration,plan,progress}.md`) + this report + progress update below — no stray files, no round 1–3 leftovers (expected: base branch was rebuilt on top of FLY-856, so `doc/qa/harness/` was an empty/new directory on this lineage; confirmed via `git ls-tree` before implement wrote the file) |

## 2. FLY-856 code-fix sanity check (in-band, since this round exists specifically to exercise it)

The trivial deliverable doesn't exercise FLY-856 by itself — the actual exercise is this whole session running as a real phase in the three-stage pipeline. What this QA session *can* verify from the repo side is that the fix committed at `eb4d4f5` is intact and correct on the combined branch it now sits on:

- **Root cause reviewed**: `PhaseSession` used to carry a `lead_id?: string` field read from `prev.lead_id` at handoff — but the `sessions` table has no `lead_id` column, so it was always `undefined`. That silently skipped `TmuxAdapter`'s CommDB registration, so `postMergeTmuxCleanup` found no tmux target at ship time → the phase-runner window never auto-closed, and a leaked runner un-archived the Discord thread by continuing to post (this is exactly the FLY-855 round-3 finding this round exists to verify the fix for).
- **Fix reviewed**: phantom `lead_id` field removed from `PhaseSession`; new required `PhaseOrchestratorDeps.resolveLeadId(session)` resolves the real leadId live via `resolveLeadForIssue(projects, project_name, sessionLabels)` in `plugin.ts:3815`, mirroring the existing post-ship finalization path. `onPhaseComplete` (phase-orchestrator.ts:212) calls it and warns loudly on `undefined` instead of silently degrading. `reconcileOnStartup` shares the same `onPhaseComplete` code path, so its handoffs get the same fix for free (no separate code path to regress).
- **Build / typecheck**: `pnpm -r build` — clean. `tsc --noEmit` on `packages/teamlead` — clean.
- **Lint**: `biome check` on the 3 files touched by `eb4d4f5` — clean, no fixes needed.
- **Targeted tests**: `packages/teamlead/src/bridge/__tests__/phase-orchestrator.test.ts` — **15/15 passed** (includes the 3 tests added by FLY-856: live-resolved leadId on handoff, resolver-undefined still dispatches with `leadId: undefined`, `reconcileOnStartup` handoffs carry the resolved leadId).
- **The two other files directly implementing the round's subject matter** (tmux window close + thread archive), run in isolation:
  - `src/__tests__/close-runner.test.ts` (the actual tmux-window-close logic) — **34/34 passed**.
  - `src/__tests__/post-ship-finalization.test.ts` (tmux cleanup → notifier → archive ordering, exactly-once dedup, FLY-292 thread-missing handling) — **19/19 passed**.
- **`flywheel-comm` package suite** (the CLI this pipeline's `stage`/`complete`/`qa-result`/`progress` commands live in): **47 test files, 688/688 passed**.
- **Full `teamlead` package suite** (all ~280 files): attempted twice; both times a subset of unrelated files (`codex-lead-runtime.test.ts`, `LeadAlertNotifier.test.ts`, `stage-status-emoji.test.ts`) plus transient timeouts in `post-ship-finalization.test.ts`/`close-runner.test.ts` showed up under full parallel load (~17 worker threads). Re-running each of those files **in isolation** showed:
  - `post-ship-finalization.test.ts` and `close-runner.test.ts` — **pass cleanly (19/19, 34/34)**, confirming the full-suite failures there were load-induced timeout flakiness (each failing case took exactly ~5000ms = the default test timeout), not a real regression.
  - `codex-lead-runtime.test.ts` (22 failures) — root cause identified: this QA session's own sandboxed `TMPDIR` resolves under `~/.flywheel/runner-state/<execId>/browser-tmp/…`, which trips that file's own safety guard (`FLYWHEEL_CODEX_LEAD_WORKSPACE must not overlap ~/.flywheel`). This is a property of *this specific runner sandbox's* temp-dir location, unrelated to FLY-856/phase-orchestrator/tmux/thread-archive, and pre-existing (the file touched by `eb4d4f5` is not this one).
  - `LeadAlertNotifier.test.ts` / `stage-status-emoji.test.ts` — unrelated subsystems (alert notification / stage badge rendering), not touched by FLY-856, not investigated further as out of this round's scope.
  - None of these four files were modified by FLY-856 (`eb4d4f5` only touched `phase-orchestrator.ts`, `plugin.ts`, `phase-orchestrator.test.ts`) — so none of them bear on this round's verdict.

## 3. The two real verification points — explicitly out of scope for this report

The issue's actual pass/fail criteria are:

1. Implement and QA phase runner tmux windows self-close automatically after ship completes.
2. The archived Discord thread is NOT re-opened (unarchived) by a residual runner posting after archive.

Both are **Bridge/cmux-side runtime behavior about this session's own lifecycle after it ships** — a QA Runner cannot observe its own post-ship tmux teardown or the Discord thread's state from inside its own session. Per the Design-phase plan (`engineering/doc/FLY-858-round4-marker/plan.md`, "本轮验证点归属"), this is intentional: this session's only job toward those two points is to run the standard pipeline for real — no manual simulation, no skipped gates, no self-verification theater — so the harness/Lead observing from outside has a genuine signal to check. **This report does not claim PASS/FAIL on those two points; that verdict belongs to the out-of-band harness observation**, per the plan's explicit design.

## 4. Verdict

- Deliverable + PR shape: ✅ matches plan exactly.
- FLY-856 fix as it sits on the combined branch: ✅ structurally sound (build/typecheck/lint/tests all clean, including its own added coverage, plus the two adjacent finalization files that implement the round's subject matter).
- Out-of-band tmux self-close / no-unarchive: **not asserted here — harness-side observation, see §3**.
- Other findings (4 pre-existing, unrelated test files/timeouts under heavy parallel load) — documented in §2 for transparency, do not affect this round's verdict.

**`flywheel-comm qa-result --status pass`** reported for this round.

No missing test coverage identified for the in-scope (doc-only) deliverable; FLY-856's own coverage (added in its original PR) was exercised and passes on this branch.
