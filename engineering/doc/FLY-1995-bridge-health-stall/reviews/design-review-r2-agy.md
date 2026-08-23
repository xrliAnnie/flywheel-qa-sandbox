# plan.md (FLY-1995) — Antigravity Design Review (Round 2, standing in for Codex R2)

Date: 2026-08-22
Author: Antigravity (agy)
Status: CHANGES REQUESTED

## Summary

The revised plan successfully and completely folds all 11 items from Codex's Round 1 review. It introduces a robust, fail-closed set of guards for the `zombie-gate-hygiene.ts` logic, explicitly defines the `--apply` dry-run cohort boundaries for the DB surgery, carefully navigates the Node 25 inspector gaps, and honors the sequence of rollout to preserve crash-attribution evidence. 

However, there is one critical risk introduced in Fix C's dry-run definition that needs addressing before this plan is implemented.

## What's Good (Keep)

- **Fix B (Z1 Extension)**: The new `retireSessionlessNonRunnerAsks` lane perfectly complements the existing `sweepOwnerlessAsk` by catching non-UUID actors without disrupting the existing triple guards. The fallback to the guarded `db.retireQuestionGuarded` on the base table fully satisfies R1 #1 and #2.
- **Fix A (Profiler & Ledger)**: Safely acknowledges the >60s stall gap with `SIGKILL` (R1 #3) and correctly renames the span log to "rider wall-span correlation log" to distinguish it from a proper event loop profiler (R1 #5). Crash-safe profile limits (`PROFILE_KEEP`) and atomic rename logic are correct.
- **Fail-Closed API**: Explicit 503/401/403/200 HTTP codes on the diagnostic route properly bypass the silent no-op of `tokenAuthMiddleware` for a missing master token (R1 #6).
- **Execution Discipline**: The strict sequence of Fix A/B → profiler validation → evidence capture → operator surgery (Fix C) guarantees the bug is properly measured before the potential trigger (storm residue) is cleaned (R1 #9).
- **Rate-Limiter Constraint**: The in-memory TTL/LRU Map cleanly provides best-effort sampling to cap the infra-notify DB storm without over-promising exact conservation (R1 #10).
- **Feature Flag Truth**: Correctly registers the flag as `kill_switch`, `object_construction`, and non-direct toggleable. 

## Issues & Recommendations

1. **Fix C: Dry-run snapshot copying creates a torn database if Bridge is live.**
   The plan proposes copying the `main`/`WAL`/`SHM` files via the OS for the dry-run snapshot: "先把 main/WAL/SHM 三件套快照拷到临时目录,对快照查询". Because SQLite writes to these files asynchronously and concurrently, an OS-level copy (`cp`) performed while Bridge is running can capture a torn, corrupt state where the WAL and main DB are out of sync. This could cause the dry-run to crash or emit a baseline receipt with incorrect counts.
   **Recommendation**: Either specify that the dry-run must *also* only be run during a maintenance window while Bridge is stopped, OR use `VACUUM INTO` (or the `better-sqlite3` backup API) to create the dry-run snapshot. `VACUUM INTO` safely creates a unified snapshot while the DB is live without touching `-shm` read marks in a destructive way.

## Verdict
CHANGES REQUESTED — address items above
