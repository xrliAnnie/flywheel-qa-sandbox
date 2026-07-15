# Design Review — FLY-1281 plan.md (Round 8)

Date: 2026-07-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

Draft v8 correctly adds a durable owner generation before credential rotation, narrows rotation to generalized output credentials, and fixes the additive-DDL wording. The remaining blocker is at the other end of the fence: the plan does not define an atomic generation-aware protocol between the SQLite owner row and the adapters' filesystem launch-commit marker, so stale-owner and adopt-to-zero races remain possible.

## What's Good (Keep)

- The plan now explicitly acknowledges that `LaunchClaimStore.claim()` is find-or-create rather than a recovery lease; the new owner generation addresses the exact race identified in Round 7.
- Owner acquisition is correctly ordered before commit recheck, credential rotation, CommDB registration, and launch, and the generation is intended to fence the final side-effect commit.
- The two-dispatcher barrier test and crash-takeover test are the right acceptance shapes for proving concurrent exclusion and recovery.
- Rotation is now limited to the only C-reachable credential kind, output. An unexpected decision credential fails closed, leaving B's legacy admission seam untouched.
- The storage contract now accurately distinguishes two additive nullable column groups from modifications to pre-existing columns, CHECK constraints, and triggers.
- The rest of the plan continues to honor the typed-snapshot, v2-only start, default-off, completion-receipt, and C-to-D boundary decisions from prior rounds.

## Issues & Recommendations

1. **The generation fence is not yet connected atomically to the real adapter commit point.** `workflow_launch_owner` can serialize a SQLite CAS, but today `TmuxAdapter` releases its gated shell by writing a per-launch token directly to `launchCommitPath`, while `CodexTmuxAdapter` writes the marker directly after the goal becomes active. A design that checks `owner_generation` and then separately writes that file has a TOCTOU window: the lease can be taken over after the check, allowing the stale adapter to overwrite the marker and release its shell. The opposite ordering is also unsafe if SQLite is marked committed before the file write: a crash in between can make replay adopt an execution whose runner was never released. Specify one authoritative fenced commit primitive and thread it through `adapter-types`, `Blueprint`, `TmuxAdapter`, and `CodexTmuxAdapter`. One feasible shape is a Bridge-owned synchronous commit callback that, under a SQLite write transaction, verifies the exact live generation, prevents takeover, writes a generation-bearing launch token, and records the committed generation; recovery must define how a crash after marker write but before the bookkeeping commit is detected and repaired without launching twice. Alternatively, make the durable row itself the gate the runner waits on and remove the filesystem marker as an independent authority. Add crash tests on both sides of the authoritative commit, plus a stale-generation test that attempts to overwrite an already committed newer-generation marker. The existing barrier test proves owner acquisition, but not this cross-store commit boundary.

2. **Pin the lease lifecycle and stale-owner behavior, not only the table shape.** Step 6c names acquisition and expiry but does not say whether the initial launch also acquires generation 1, how a live owner renews, the exact CAS predicates for acquisition/renewal/takeover, or what happens when a lease expires while the old owner is still executing pre-commit `Blueprint.run()` worktree/tmux setup. Final-commit rejection prevents two agents from starting only if every earlier stale path remains safely gated; it does not by itself prevent two owners from performing destructive pre-commit setup. Require initial launch and every re-drive to acquire the owner, permit takeover only from the exact expired generation, renew while pre-commit work is active, and make failed renewal/current-generation checks abort the stale path before rotation and each irreversible launch step. Define an injectable time source, finite timestamp validation, TTL/renewal cadence, and current-generation-only release/commit rules. Add a paused-owner test: generation 1 loses its lease, generation 2 takes over, then generation 1 resumes and must be unable to rotate, mutate the committed launch, or start a runner. Also declare `workflow_launch_owner` mutable with no append-only trigger and give `execution_id` a foreign key to `workflow_execution_binding` plus positive-generation/NOT-NULL lease constraints.

## Verdict

CHANGES REQUESTED — address items above
