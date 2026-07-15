# FLY-1070 替身 QA 设计评审 Round 2 — 评审记录
Issue: FLY-1070 (URL 不可得,只写 issue 号)
日期: 2026-07-09
基于: plan.md, design-review-round1.md

Author: Codex
Status: APPROVED

## Summary
Round 2 addresses all three Round 1 blockers. The updated plan is feasible, source-aligned, provenance-honest, and specific enough for Implement to execute without guessing while preserving the substitute-QA boundaries: no PR source edits, no push to `flywheel-FLY-1050`, no production DB writes, and no ship.

## What's Good (Keep)
- F8 construction is now correctly split by storage reality: CommDB-only owns `issue_id=NULL`, while StateStore real-store cases use constructible shapes only. This matches PR head, where `StateStore.sessions.issue_id` is `TEXT NOT NULL` and CommDB `sessions.issue_id` is nullable.
- The query-exception case is now explicitly labeled `fault-injected` via a dependency-level throwing seam, so the plan no longer overclaims real-store coverage.
- Step 4 now handles the real fire-and-forget behavior of `/api/actions`, `/actions`, and the crash-reaper plugin callback with bounded polling before assertions. This matches the existing `actions-fly1050-terminate-qa-loss.test.ts` pattern.
- Provenance labels are now required for every F8/F10 subcase and must survive into `qa-report.md`, which closes the prior false-confidence risk.
- The rest of the plan still covers the critical surfaces: targeted test reruns, F1-F7/F9 mapping, independent F8 behavior checks, F10 Done-gap proof, module-driven E2E, cap=3 fail-closed, escape hatch, and reuse of full-suite triage.

## Issues & Recommendations
No blocking issues remain.

Non-blocking implementation note: keep the bounded quiet window for negative assertions long enough to cover the same async surfaces as positive polling, and record the chosen timeout in evidence so later reviewers can distinguish “no event happened” from “we looked too early.”

## Verdict
APPROVED — ready to implement
