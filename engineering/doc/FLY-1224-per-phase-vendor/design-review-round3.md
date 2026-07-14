# Design Review — plan.md (FLY-1224, Round 3)

Date: 2026-07-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 closes all four Round 2 design findings: the two wake sites now make the required direct persisted-target probe, the public config API compiles, retry/rescue preserve durable phase identity, and the deployment ordering is explicit. The implementation plan is feasible and otherwise ready, but the kill-switch runbook still contains one unsafe recovery claim: the normal terminate action does not produce a state accepted by retry, so following it can strand a running implement phase.

## What's Good (Keep)

- C8 now matches the Lead's exact scope and safety constraints. Each approved wake site directly calls the existing `probeGhostTmux(row)` only for `absent + persisted tmux_session`; only confirmed `dead_pin`/`absent` falls through to spawn, while direct `alive`/`indeterminate` retains the current wake/reconcile path. The existing fallback ghost guard remains responsible for other polluted rows.
- T6/T6b provide the right mutation and negative controls: removing the probe revives the deterministic QA-FAIL stall, while Claude-alive, direct-alive, direct-indeterminate, and no-persisted-target cases do not acquire a new spawn path.
- C1 now uses only public display helpers and explicitly exports `RoleEffort` from `flywheel-config`, removing both Round 2 compile hazards. The pending-display fallback remains kill-switch-aware in both issue display paths.
- C4b/C5 correctly make durable `chat_thread_role` authoritative for `sessionRole` as well as dispatch model/vendor/effort, and keep `shareParentBranch`/label bypass phase-scoped. Recording the resulting phase cmux label as an intentional FLY-840 correction, updating the stale comments, and asserting it in T4/T4b is consistent with `runnerDisplayName` at both dispatcher call paths.
- The six phase-capable feeds are covered: three orchestrator starts, three-stage entry, phase retry, and FLY-871 progress-resume successor. Reconcile respawn, FLY-1050 QA respawn, QA-FAIL fix rounds, normal handoff, and resume therefore all inherit the phase dispatch table without a parallel configuration mechanism.
- The Codex effort mechanism remains correct and narrowly placed: `ctx.effort` reaches daemon construction and `-c model_reasoning_effort="xhigh"` supplies a TOML string override on every daemon spawn. Invalid/absent values are explicitly non-fatal.
- The restart default-off rider now has behavior-level shell coverage, explicit opt-in compatibility, updated guard guidance, and an independent commit. The build-first verification order correctly accounts for teamlead consuming config through `dist`.
- The kill-switch, deployment/revert unit, Codex quota limitation, token-accounting blind spot, and non-phase byte-compatibility boundaries are all stated clearly.

## Issues & Recommendations

1. **The active-phase kill-switch runbook still claims that `terminate` creates a retryable terminal state, but the workflow rejects that sequence.** `ACTION_DEFINITIONS` permits retry only from `failed`, `blocked`, and `rejected` (`packages/core/src/workflow-fsm.ts:208-212`), and `handleRetry` enforces that list (`packages/teamlead/src/bridge/actions.ts:671-677`). The founder-gated terminate action moves the row to `terminated`, which is not retryable. FLY-1050's post-terminate recovery is explicitly QA-only (`actions.ts:1390-1406`), so it cannot re-drive a terminated implement. The FLY-871 close-and-successor composition does not make the runbook valid either: it is a dedicated login-expired rescue path, not the ordinary terminate action. Tighten §7 to call retry only for the actual retryable states—especially quota-induced `failed`, not generic “terminal”—and remove terminate as an active-implement recovery option unless this plan explicitly adds and tests a supported phase-successor composition. The simpler in-scope runbook is: let an active phase finish/fail, or use `--bridge-only --wait-idle`; then restart with the switch loaded and retry only a `failed`/`blocked`/`rejected` phase. If urgent active-run cutover is a requirement, treat that as a separate scoped lifecycle change rather than implying existing actions support it.

2. **The C8 Mermaid diagram still describes the superseded Round 2 decision.** Its `absent + persisted target` branch says to spawn and let `ghostGuard` re-check (`plan.md:50`), contradicting C8's direct-probe decision and tests. Update the diagram to show `probeGhostTmux(row)` followed by dead→fallback and alive/indeterminate→current wake/reconcile, so the plan has one unambiguous implementation contract.

## Verdict

CHANGES REQUESTED — address items above
