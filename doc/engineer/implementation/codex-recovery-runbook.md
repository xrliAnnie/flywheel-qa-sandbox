# Codex Runner Crash-Recovery — Safe Committed-Adopt Redesign (FLY-1212)

**Issue**: **FLY-1212** (the fast-follow that implements this) ← split out of FLY-1188
**Date**: 2026-07-13
**基于**: FLY-1188 full-PR Codex review R2/R3 + Lead ruling

> **Scope contract**: FLY-1188 ships the SAFE half (fail-closed reap, no data loss,
> no wrong-process kill). The committed-adopt-codex safe recovery below is
> deliberately carved out to **FLY-1212** — it touches the FLY-245 durable-launch-claim
> convergence invariants (high-risk zone) and must not be rushed into FLY-1188.

## Why this is a separate issue

FLY-1188 ships the resident codex `/goal` runner. Its full-PR Codex review (R3)
surfaced a crash-recovery gap that must NOT be rushed into that PR — it touches the
FLY-245 durable-launch-claim convergence invariants (the highest-risk zone), and a
first attempt introduced a **data-loss** bug. Per the Lead's ruling the attempt was
reverted and the safe redesign carved out here.

## The problem (confirmed)

A resident codex daemon is a CHILD of the Bridge, spawned with `detached:false`.
On Unix that does NOT kill the child when the Bridge dies — it is reparented to
init and keeps running (orphaned) on EVERY Bridge restart, still holding its
execution-private control socket.

Two recovery paths exist:

1. **Crash BEFORE the launch commit** → the dispatcher re-drives the same execId.
   The resuming spawn is blocked by the orphan's live socket. **Handled in
   FLY-1188** by the adapter-side FAIL-CLOSED reap
   (`spawnCodexDaemon` + `socketHolderPids` via `lsof`): the orphan is SIGKILLed
   ONLY if the OS proves the persisted pid holds THIS socket; otherwise refuse.

2. **Crash AFTER the launch commit** → `run-dispatcher.ts` (the FLY-245 gateway
   pre-bound-successor REPLAY path) bare-ADOPTS the committed runner without
   re-running the adapter. For a Claude runner this is correct (its detached tmux
   window survives). For a **codex** runner it leaves the orphaned daemon running
   with **no heartbeat / gate-timeout watcher / teardown** — it can run
   indefinitely, unmonitored. **This is the gap this issue fixes.**

## Why the naive "codex re-drives instead of adopting" fix is WRONG (data loss)

Making a committed codex runner re-drive routes it through the normal
`Blueprint.run()`, whose non-shared-branch worktree setup does
`worktreeManager.removeIfExists(...)` **then** `create(...)`
(`packages/edge-worker/src/Blueprint.ts` ~line 813). That **deletes the worktree
and force-deletes the local branch BEFORE the orphaned daemon is safely stopped** —
the daemon may still be writing there, and any un-pushed commits / uncommitted work
are lost. Reverted. Never ship a recovery path that can destroy in-flight work.

A second defect of that approach: the adopt decision re-resolved the executor
backend from the CURRENT labels / roles config / env, not from the committed
execution's persisted backend. If the routing drifted between the original dispatch
and the replay, the adopt/re-drive decision could be made for the wrong backend and
break the exactly-one-started invariant.

## The safe redesign (design points — implement in FLY-1212)

1. **Persist the executor backend with the launch claim / commit.** The recovery
   decision must read the committed execution's OWN backend, never re-resolve it
   from current config (which can drift). Store `backend` alongside the launch
   claim (or in the commit file) at first dispatch; read it back on replay.

2. **Safely stop / take over the daemon BEFORE any worktree mutation.** For a
   committed codex replay:
   - Read the persisted daemon pid + socket (session.json).
   - Prove ownership (the same `lsof` socket-holder check the FLY-1188 reap uses),
     then either (a) reconnect to the live daemon and resume monitoring in-place, or
     (b) reap it FAIL-CLOSED and respawn+resume the persisted thread. NEVER kill an
     unproven pid.
   - Only after the daemon is confirmed stopped/owned may recovery touch files.

3. **Reuse the existing worktree in-place — do NOT remove+recreate.** Recovery must
   NOT call the destructive `removeIfExists`+`create`. Model it on the three-stage
   shared-branch takeover path (`Blueprint.ts` ~795-810), which refuses to reuse an
   unclean/mismatched worktree and otherwise reuses it in place — so un-pushed
   commits survive.

4. **Preserve the FLY-245 R5 invariant.** A recorded-but-never-committed window must
   still NOT be mistaken for a started Runner. Only the committed-codex branch
   changes; the claim/commit accounting and the claude adopt path stay byte-stable.

5. **Bound the residual.** Until FLY-1212 lands, a committed codex daemon orphaned by a
   Bridge crash on the FLY-245 replay path keeps running unmonitored. Mitigations to
   consider in the fast-follow: a boot-time reconcile that reaps/reattaches orphaned
   codex daemons by their persisted (proven) pid, and/or killing owned daemons on a
   graceful Bridge shutdown so only a hard crash can orphan one.

## What FLY-1188 keeps (safe, shipped)

- Adapter-side FAIL-CLOSED reap of a crash-before-commit orphan (path 1 above).
- Daemon pid persistence in session.json (feeds both the reap and this redesign).
- The honest comment correcting the false "daemon dies with the Bridge" premise.
