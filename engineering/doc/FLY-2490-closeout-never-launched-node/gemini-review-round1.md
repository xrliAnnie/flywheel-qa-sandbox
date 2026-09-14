# plan.md — FLY-2490 (Gemini Design Review, Round 1)

Date: 2026-09-11
Author: Gemini
Status: APPROVED

## Summary
The implementation plan for FLY-2490 is highly feasible, elegant, and conceptually robust. By decoupling "zero daemon evidence" (never launched, missing pgid, and inactive socket) from "indeterminate daemon state" and gating it under `CRASH_PRESERVE_STATES` (`failed`/`blocked`), the plan cleanly resolves the long-standing bug where early worktree-takeover failures were permanently locked in a closeout-blocked state. The separation of the state constants into a leaf module and the addition of the specific `nodes_not_confirmed_gone` land cause are both beautifully aligned with existing architectural patterns and conventions.

## What's Good (Keep)
- **Precise Liveness Decoupling (Issue C)**: Differentiating between a lack of a persisted group (`persistedGroup: false`) plus an inactive socket and an indeterminate daemon state is the correct surgical fix. Bypassing to the existing, highly robust `probeGeneralizedLaunchLiveness` (triple-veto check) under this exact condition guarantees correctness without duplicate code or brittle filesystem hacks.
- **Strict Status Gating**: Restricting the generic probe bypass strictly to `CRASH_PRESERVE_STATES` (`failed|blocked`) ensures that active/pending/completed runners remain fully protected under the strict FLY-1940 fail-closed guidelines. This avoids any race conditions during standard launcher spawn windows.
- **Circular Dependency Elimination (Issue 4/C1)**: Relocating the FSM state constants into a dedicated leaf module (`close-runner-states.ts`) and re-exporting them from `close-runner.ts` keeps existing files unchanged while eliminating any risk of circular TypeScript imports between `close-runner.ts` and `run-quiescence.ts`.
- **Honest Cause Labeling (Issue D)**: Moving away from the blind fallback of `lifecycle_conflict` in `post-ship-finalization.ts` and correctly deducing `nodes_not_confirmed_gone` from `NodeClosureReport` statuses greatly improves observability, accurately feeding the workflow alert system.
- **Thorough and Backwards-Compatible Test Plan**: The proposed test matrices (T-CR, T-RQ, T-LC, T-CC, T-PS, T-ST) cover both positive path verification and negative guard conditions. The legacy inject parameter `probeCodexDaemon` is also simulated perfectly, ensuring zero regression across legacy test suites.

## Issues & Recommendations

### 1. Type Assertions on Mock Objects in Tests (LOW)
- **Why it matters**: In test mocks for `NodeOutcome` (e.g., `transition` and `teardown`), TypeScript strict mode requires literal types like `"failed"` or `"blocked"`. Incomplete or typed-as-string properties could lead to compilation issues during `pnpm -r typecheck`.
- **Suggested Fix**: Always append `as const` or use explicit typings on test inputs representing FSM states, e.g., `{ state: "failed" as const, error: "..." }`, as seen in the existing `land-closeout-cause.test.ts`.

### 2. Sandbox and Env Isolation in Tests (LOW)
- **Why it matters**: The tests mock custom environments `FLYWHEEL_CODEX_SESSION_DIR` and `FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT`. If these point to stale directories or aren't thoroughly torn down, transient side-effects may cross-contaminate adjacent test executions in parallel.
- **Suggested Fix**: Use `mkdtempSync` in `node:os` inside a `try/finally` structure or vitest's `afterEach` blocks to cleanly dispose of temporary state and socket folders for `T-LC-1..3` and `T-CR-1..4`.

### 3. Verification of Re-exports in Build Output (LOW)
- **Why it matters**: Re-exporting constants via `export { ... } from "./close-runner-states.js"` in an ES Modules context (`"type": "module"`) is perfectly correct but requires matching file extensions in import specifiers.
- **Suggested Fix**: Double-check that all imports and exports between `close-runner.ts`, `close-runner-states.ts`, and `run-quiescence.ts` use the `.js` extension explicitly in their import paths to fully satisfy Node's native ES Module resolution.

## Verdict
APPROVED — ready to implement
