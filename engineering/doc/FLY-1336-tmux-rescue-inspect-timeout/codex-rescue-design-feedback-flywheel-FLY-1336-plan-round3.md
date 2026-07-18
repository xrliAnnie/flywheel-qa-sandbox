# Design Review — FLY-1336 plan.md (Round 3)

Date: 2026-07-17
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 correctly closes the six Round 2 findings: the shared Bash budget anchor, non-cached pending response, honest SIGKILL semantics, post-dispatch exception shield, default-only budget proof, and invalid-override behavior all match the current architecture. One operationally material arithmetic error remains: the documented “full rollback” tuple violates the very budget invariant introduced in this revision, and its proposed test sits in a suite that cannot observe the TS limits. Two smaller contract inconsistencies should be corrected at the same time.

## What's Good (Keep)

- The single `_TMUX_RESCUE_BUDGET_ANCHOR` design is now compositional. Bash 3.2 verification confirms command substitutions inherit an unexported ordinary variable and the current `SECONDS` progression while child mutations do not propagate back, so nested recovery can consume the parent’s remaining budget without opening a second clock.
- The new composition mutation test is the right proof: it exercises actual `ensure -> nested recover` behavior and fails if recovery is given a private anchor. This is stronger than isolated N/recovery wall-clock tests.
- Pending responses are now correctly excluded from `recordWorkflowStartResponse`. This matches the delivered-evidence guard at `StateStore.ts:13193-13220`, the append-only response table, and the status-losing replay at `runs-route.ts:721-727`; the planned 202-to-200 same-key replay test covers the complete idempotency contract without adding a mutable store.
- The process-tree description is now accurate. The plan preserves the intentionally inherited lock fd (`tmux-server-rescue.sh:568-574`), treats direct-child SIGKILL as a last-resort risk, and adds a regression for “child finishes under its own bound; lock is not released early” without expanding into process-group redesign.
- The actions control flow now preserves the existing rule that every error after `dispatch()` returns is non-terminalizing. Returning 202 with `success:true` continues to map through the real gateway as dispatched/no-redrive.
- The default budget proof is valid: `90 >= 5 * 4 + 60 + 5 = 85`, and 210 seconds leaves room for two 90-second attempts plus retry overhead. The 90-second session guard does not need to cover the 210-second ensure deadline because the real flow writes the session row before the adapter’s blocking spawn work (`runs-route.ts:1284-1303`).
- Invalid explicit load-factor behavior is now one unambiguous contract: ignore it and sample; only a malformed/unavailable sample falls back to 1. The revised mutation test distinguishes those branches.
- Scope remains disciplined: true holds stay fail-closed, classic/session-wait semantics and workflow-engine repair authority remain unchanged, case 2 and sentinel work remain outside the PR, and the three commit units have sound dependencies.

## Issues & Recommendations

1. **HIGH — The documented rollback tuple violates §3.2’s operator invariant, and the proposed test cannot catch that cross-layer error.** The plan says every override set must satisfy `attempt >= lock_base * factor_max + total_budget + startup_margin` (`plan.md:88-97`), then recommends `LOCK=5` (unchanged), `LOAD_FACTOR=1`, `TOTAL_BUDGET=8`, and `ATTEMPT=10` as a paired rollback (`plan.md:193-198`). Substitution gives `10 >= 5 * 1 + 8 + 5 = 18`, which is false; using that recipe restores the outer-SIGKILL failure mode the PR is meant to remove. Test row 3 places the “MAX=8 plus scaled attempt/deadline” tuple in `tmux-server-rescue.test.sh` (`plan.md:177-182`), but that shell suite does not execute `TmuxAdapter` or the TUI caller, so the TS attempt/deadline values are inert and cannot prove the inequality. **Fix:** either make the safe rollback attempt at least 18 seconds (prefer a round 20,000ms; the 90,000ms deadline remains sufficient) or explicitly label 10,000ms as an unsafe exact-legacy rollback that abandons coherence. Move the non-default tuple proof to a caller/script integration test (or split it into a shell inner-bound test plus a TS cap/deadline assertion) so mutating the outer cap actually turns the test red.

2. **MEDIUM — The new total-budget env lacks a parsing/fallback contract.** The plan precisely defines validation for timeout bases, factor, and factor max, but `FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC` is only given a default (`plan.md:42`, `161-170`). Its value feeds `awk` arithmetic and the outer invariant; zero, negative, non-numeric, NaN-like, or empty input must not acquire accidental awk coercion semantics. **Fix:** define it as a finite positive seconds value (integer is simplest with Bash `SECONDS`; positive decimal is also feasible with documented sub-second tolerance), with invalid input falling back to 60. Add hermetic cases for zero, negative, empty, non-numeric, and a valid non-default value. Large valid values may remain operator-controlled, subject to the paired outer-budget invariant.

3. **MEDIUM — The plan still contains unconditional lineage/WAL-completeness claims after explicitly acknowledging store-write failure.** Section 4.3 correctly says a rejected bookkeeping write is incomplete and must not flip the response (`plan.md:129-136`), but §4.4 still requires “lineage/WAL 已落地” without qualification and acceptance criterion 2 says “lineage/WAL 完整” (`plan.md:138-140`, `200-204`). Also, if both writes share one `try`, a `setRetrySuccessor` throw prevents `markRetryDispatchDispatched` from being attempted, even though the control-flow prose says to attempt both. **Fix:** distinguish the healthy-store assertion from injected-failure behavior: normal pending must persist both; on a store exception, the API remains accepted/pending and reconciliation owns the incomplete bookkeeping. Put the two writes behind independent best-effort guards (or otherwise guarantee the second is attempted after the first throws), and make the injected `setRetrySuccessor` failure test assert that the WAL update was still attempted.

## Verdict

CHANGES REQUESTED — address items above
