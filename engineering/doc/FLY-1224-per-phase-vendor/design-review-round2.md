# Design Review — plan.md (FLY-1224, Round 2)

Date: 2026-07-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 resolves the substantive architecture and coverage gaps from Round 1: the six phase-capable feeds are inventoried, retry/rescue regain shared-branch identity, pending display and behavior-level restart tests are covered, and the operational/observability boundaries are explicit. Four narrower corrections remain before implementation, including one liveness safety hole: the existing ghost guard does not guarantee that it directly re-probes the wake target whose CommDB lookup returned `absent`.

## What's Good (Keep)

- C4b correctly adds the previously missed FLY-871/FLY-795 rescue-successor lane and re-derives phase model/vendor/effort from `chat_thread_role` instead of trusting usually-null `dispatch_model`.
- C5's phase-scoped `shareParentBranch: true` is the correct fix for retry branch continuity. The request and retry dispatcher already carry the field, so this is a small change at the missing producer rather than a new mechanism.
- Reconcile, FLY-1050 QA respawn, legacy/keep-alive QA-FAIL respawn, and normal handoff remain covered by the three orchestrator start sites. FLY-579 auto-QA is still correctly excluded.
- The graded C8 decision is directionally right: `dead_pin` is authoritative, while a bare CommDB-derived `absent` is not. Keeping `absent` without a persisted target and `indeterminate` on the current wake/reconcile path avoids licensing a duplicate from uncertainty.
- C1/C2 now include both active and pending/fallback display paths and make the planned display kill-switch-aware. That closes the Round 1 user-visible Fable lie in both issue-display implementations.
- C9 now names the real hermetic suite and tests runtime behavior rather than dry-run narration. Updating the usage text, restart guard guidance, and legal command tests is the right compatibility surface.
- `RoleEffort`, the topological build-first verification order, the commit 1+2 deployment unit, and the explicit token-usage limitation all improve the plan without expanding it into a general phase configuration or liveness framework.
- The Codex daemon mechanism remains correct: `model_reasoning_effort="xhigh"` is a valid TOML-valued app-server `-c` argument, and applying it on each daemon spawn preserves it across runtime rotation.

## Issues & Recommendations

1. **C8 still assumes `ghostGuard` will directly re-probe the selected wake row, but the implementation does not guarantee that.** `ghostGuard` re-queries `listPhaseSessionRows` (`phase-orchestrator.ts:746-756`), explicitly proceeds with spawn if that query throws, and probes only the three newest rows carrying `tmux_session` (`:757-759`). The `impl`/`target` that produced `absent` can therefore be skipped by a transient query error or the row cap, even though its persisted target may still be live. At each of the two approved wake sites, when the CommDB probe returns `absent` and `row.tmux_session` exists, call the already-available `deps.effects.probeGhostTmux(row)` directly before deciding: direct `dead_pin`/`absent` may fall into the existing spawn fallback; direct `alive`/`indeterminate` must retain the current wake/reconcile path. The fallback should still run the existing ghost guard to protect against other polluted rows. Update T6/T6b/T8 so `absent + persisted target + direct alive` proves wake (and no spawn), direct indeterminate proves the current path, and only a direct dead result authorizes fallback. This stays within the Lead's two-wake-site constraint and makes the original Claude-alive path genuinely unchanged.

2. **Two plan snippets are not compilable as written.** C1 references `SHORT_CODE_DISPLAY_NAME` from `three-stage-phases.ts`, but that constant is private to `model-tiers.ts:117` and is neither imported nor exported. Keep the private implementation detail private and express the final fallback through the public helper, for example: `modelDisplayName(runnerModel) ?? modelDisplayName(resolvePhaseDispatch(role).model, DEFAULT_PHASE_TIER[role])`. Also, `RoleEffort` currently exists in `packages/config/src/types.ts` but is not re-exported from `packages/config/src/index.ts`; the new `retry-dispatcher.ts` and resolver package imports will fail unless C1 explicitly adds `RoleEffort` to the index type exports. Add both details to the file list and compile expectations.

3. **The “durable `chat_thread_role`” identity should also drive `sessionRole`, and the recorded FLY-840 residual is factually stale.** C4b's shown object retains `sessionRole: s.session_role`, and C5 currently passes the separately computed `sessionRole`; if an older/polluted row has `chat_thread_role=implement` but `session_role=main`, the new code derives Codex phase fields yet still launches a non-phase role. Use `sessionRole: phaseRole ?? existingSessionRole` in both phase rescue and phase retry and assert it in T4/T4b. Separately, once C5 supplies `shareParentBranch: true`, retry already computes `runnerName` through `runnerDisplayName(req.sessionRole, req.shareParentBranch)` at `run-dispatcher.ts:440`, so the cmux label becomes `implement`/`design`/`qa`; it does not remain `claude`. Remove that claimed §9 limitation and update the now-stale comments in `actions.ts:854-859` and `run-dispatcher.ts:87-94`. A retry test should assert the resulting phase runner name/window label so the expanded behavior is intentional.

4. **The kill-switch runbook orders the Bridge restart before waiting for or terminating an in-flight Codex phase.** `--bridge-only` sends SIGTERM; Bridge shutdown waits for dispatcher drain but has a default 20-second hard ceiling, after which it force-exits. With C9's default no-idle-wait, a long-running Codex phase cannot safely be told to “finish or close” after the restart has already begun. Split the runbook by state: if the Codex phase is already failed/terminal from quota, edit the env, restart, then phase-retry; if it is still active, first let it finish or move it to a supported retryable terminal state, or use `--bridge-only --wait-idle`, then restart so the new process loads the switch, then retry only when needed. Name the supported terminate/retry action rather than the ambiguous `close-runner`, and note that `--wait-idle` protects all active sessions, not just the affected phase.

## Verdict

CHANGES REQUESTED — address items above
