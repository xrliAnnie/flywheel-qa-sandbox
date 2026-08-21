# Design Review — FLY-1925 plan.md (Round 5)
Date: 2026-08-20
Author: Codex
Status: APPROVED

## Summary

The plan is feasible, complete enough to implement, and now conservative at the right boundaries. The three Round 4 issues are resolved in both `plan.md` and `research.md`: the cross-database fingerprint covers every raw wait row that can change `W_blocked`; activation-less wakes follow the production irreversible-terminal guard without inventing a roster requirement; and the run reducer is stated consistently as four explicit branches.

The resulting red predicate has a defensible trust posture. It requires durable, aged, exact-TURN wait evidence; excludes every blocked attempt through `W_blocked`; recognizes the durable S1–S5 loop authorities; and becomes `unknown` when judgment data is unavailable, run selection is ambiguous, relevant comm state drifts, or a required session-status read fails. The FLY-1855 acceptance case remains direct and testable through the real patrol pass and real snapshot reader.

## What's Good (Keep)

- Keep the separation between `W_blocked` and `W_red`. It closes the mixed-age cross-suppression hole without making a fresh waiter independently red-eligible.
- Keep the raw-wait fingerprint definition: holder, epoch, and `first_seen_at` for all roster execution IDs, canonically sorted. Insertions, deletions, tuple changes, and threshold-affecting timestamp changes can no longer silently cross the teamlead collection window.
- Keep S4 aligned to actual deliverability rather than outbox transport state. Exact TURN identity, activation-aware current-target checks, push exhaustion, and the production-compatible legacy-null rule sharply reduce stale-wake false greens and false reds.
- Keep the explicit run reducer. One active run wins regardless of held history; multiple active or multiple held-only candidates fail honest; zero candidates is a valid observation.
- Keep availability layered between judgment and display. Missing declared-state data is visible through `displayWarnings` but cannot hide an otherwise provable red condition.
- Keep structured loop rows, stable `issueId` joins, fixed rendering text, sanitization/allowlists, caps, and the byte-identical legacy rendering branch.
- Keep the TDD sequence and the T5 acceptance anchor. The table-driven predicate tests establish the safety contract first, while T5 proves the original incident shape through real storage and pass wiring.

## Issues & Recommendations

1. **Non-blocking: make the CommDB test explicitly cover raw-wait fingerprint drift.**

   Why it matters: T0-23 specifies that a fresh wait inserted during collection produces `unknown`, but T2 currently names only same-epoch wake mutation for `rereadJudgmentFingerprint`. A reader-level assertion is the strongest proof that the implementation actually selects and canonically fingerprints fresh raw waits rather than relying on the pure predicate fixture. The risk table also still says “合格 wait,” which conflicts editorially with the normative “全部原始 wait 行” contract.

   Suggested fix: extend T2 with at least a fresh raw-wait insertion comparison (ideally table-driven insert/delete/change cases), and change the risk-table parenthetical to “TURN tuple + 全部原始 wait + current-target retryable wakes.” This is a test-description and wording cleanup, not a blocker to implementation because Sections 4 and 5.1 and T0-23 already define the required behavior unambiguously.

## Verdict

APPROVED — ready to implement
