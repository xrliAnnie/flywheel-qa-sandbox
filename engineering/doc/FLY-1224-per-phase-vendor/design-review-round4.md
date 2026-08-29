# Design Review — plan.md (FLY-1224, Round 4)

Date: 2026-07-13
Author: Codex
Status: APPROVED

## Summary

Round 4 resolves both remaining findings: the kill-switch runbook now respects the workflow's actual retryable states, and the C8 diagram matches the direct persisted-target probe contract. The plan is feasible, complete for the approved scope, and ready to implement; no blocking correctness, sequencing, or compatibility issues remain.

## What's Good (Keep)

- The six phase-capable dispatch feeds are explicitly covered: the three orchestrator starts, three-stage entry, phase retry, and FLY-871 progress-resume successor. Reconcile respawn, FLY-1050 QA respawn, QA-FAIL fix rounds, normal handoff, and resume therefore inherit one dispatch table without a parallel configuration path.
- `resolvePhaseDispatch` is a small, kill-switch-aware extension of the existing config boundary. Keeping `DEFAULT_PHASE_TIER` as a legacy display fallback, using public display helpers, and exporting the existing `RoleEffort` type avoids a config/teamlead build-order trap.
- Resolver layer 1b uses the existing `VENDOR_TO_EXECUTOR` map and preserves the dispatch-model-only Claude behavior. Optional vendor/effort fields plus byte-compatibility tests keep the blast radius bounded for all non-phase callers.
- Retry and rescue correctly derive phase identity from durable `chat_thread_role`, including drifted `session_role=main` rows. Phase-scoped `sessionRole`, `shareParentBranch`, and label-bypass propagation preserve branch B and intentionally settle the FLY-840 cmux-label debt without changing non-phase retry behavior.
- Codex effort propagation is placed at the daemon boundary where app-server configuration actually applies. The TOML-valued `-c model_reasoning_effort="xhigh"` argument, daemon-respawn propagation, allowlist behavior, and absent-value compatibility are all covered by focused tests.
- C8 now satisfies all three Lead constraints. It changes only the two wake sites, documents that the primary probe reads real tmux pane process state, directly re-probes a persisted target when CommDB returns `absent`, and retains the current wake path for every alive/indeterminate or unprovable case.
- The C8 mutation tests are meaningful: removing the probe restores the deterministic dead-runner wake stall, while T6b/T7/T8 protect the existing Claude-alive and uncertainty paths from accidental spawn behavior.
- Display behavior is honest for active and pending rows under both the Codex default and Claude kill-switch. The accepted `modelShortCode` and token-usage limitations are called out rather than silently expanded into this ticket.
- The restart-services rider is isolated in its own commit and tested at the behavior level for full, bridge-only, opt-in, environment, and force-precedence cases. Commit 1+2 are correctly treated as one deployment/revert unit.
- The corrected §7 runbook now calls retry only from `failed`, `blocked`, or `rejected`, explicitly rejects `terminate` as an implement recovery mechanism, and makes urgent active cutover a separate lifecycle concern. This aligns with `ACTION_DEFINITIONS`, `handleRetry`, and the QA-only FLY-1050 terminate hook.

## Issues & Recommendations

1. **Non-blocking editorial cleanup:** §0 still says “本版为 R3 送审版” and records review history only through Round 2. Update it to Round 4 and record the Round 3 findings as accepted before archiving the design record. This does not affect implementation approval.

## Verdict

APPROVED — ready to implement
