# Exploration: Remove deprecated sessions.thread_id physical column — FLY-NEW

**Issue**: FLY-NEW (Annie to file in Linear)
**Date**: 2026-05-21
**Status**: Draft (placeholder — file Linear issue + populate)

---

## Context

FLY-163 v1.28.0 removed the Discord forum channel concept (see archived plan
`doc/engineer/plan/archive/v1.28.0-FLY-163-remove-forum-concept.md`).

The TS layer no longer reads or writes `sessions.thread_id`:
- `Session` / `SessionUpsert` interfaces dropped the field
- `StateStore.upsertSession` / `persistTransition` / `patchSessionMetadata`
  removed the column from INSERT/UPDATE paths
- `StateStore.rowToSession` no longer maps it back into the TS object
- `setSessionThreadId` / `getThreadByIssue` / `getThreadIssue` / `upsertThread`
  / cleanup methods deleted

The physical column was intentionally kept (`@deprecated FLY-163`) for one
release to avoid running an SQLite table-rename migration in the same PR. This
follow-up issue removes the column entirely.

## Scope

1. Drop `sessions.thread_id` via the SQLite table-rename / recreate pattern
   (SQLite does not support `ALTER TABLE ... DROP COLUMN` portably across
   versions; `StateStore.migrate()` should detect the column and apply the
   recreate).
2. Update `ProjectConfig.ts` Q4 phase 2 — change the `forumChannel` / `statusTagMap`
   deprecation `console.warn` strip into a hard `throw` so fork users surface
   stale config.
3. Re-run the FLY-163 §AC #3 grep to confirm zero `sessions.thread_id`
   references remain in `packages/teamlead/src` (only the migration code path
   may reference it for the recreate).

## Out of scope

- Re-introducing any forum behavior
- Other deprecated-field cleanups unrelated to FLY-163

## References

- Source plan: `doc/engineer/plan/archive/v1.28.0-FLY-163-remove-forum-concept.md`
- FLY-163 brainstorm: `doc/engineer/exploration/archive/FLY-163-remove-forum-channel-concept.md`
