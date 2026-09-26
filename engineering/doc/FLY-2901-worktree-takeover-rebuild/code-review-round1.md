# Code Review — FLY-2901 (Round 1)
Date: 2026-09-25 / Reviewer: Codex (companion via codex:rescue, xhigh, read-only) / Status: CHANGES REQUESTED

> 以下为 Codex 输出原文。

# Summary

Reviewed `origin/main...HEAD` at `b1fd2e1d4d76bed2ac33a85ddcfc82b6b2f17a74`.

The manifest-digest contract is correctly implemented: canonical bytes are produced in `packages/edge-worker/src/worktree-takeover-rescue.ts:202-224`, the digest exists only in the event payload, and re-entry verifies raw-byte SHA-256 before parsing and cross-checking identity fields at `:282-312`. The one-byte mutation test at `packages/edge-worker/src/__tests__/WorktreeManager.takeover-rescue.test.ts:1155-1183` is substantive and confirms refusal before destruction while the untouched manifest re-enters successfully.

Both affected packages pass `tsc --noEmit --incremental false`; `git diff --check origin/main...HEAD` also passes. Integration tests were not executed because this review environment is filesystem-read-only.

Three real defects remain, including two paths that violate the zero-loss/crash-reentry contracts.

# Findings

1. **[HIGH] A transient local-branch probe failure is treated as “branch absent,” allowing unique commits to be destroyed.**  
   `packages/edge-worker/src/worktree-takeover-transaction.ts:884-904` catches every failure from `git rev-parse --verify --quiet refs/heads/<branch>^{commit}` and returns `null`; it does not distinguish the legitimate exit-1 “missing ref” result from a timeout, spawn failure, repository read error, or malformed output. Both callers interpret `null` as authoritative absence. The unregistered/absent path immediately invokes destructive cleanup and creation at `:594-603`; cleanup can run `branch -D` at `packages/edge-worker/src/WorktreeManager.ts:1709-1713`, while creation resets the branch with `worktree add -B` at `:1287-1297`. The registered-but-missing path likewise omits `L` from the zero-loss set and rescue refs before rebuilding.  
   **Failure scenario:** the branch is the only named reference to unpublished commits; the branch-tip probe suffers a one-shot timeout, but subsequent Git commands succeed. The transaction concludes that `L === null`, writes no rescue ref for it, and deletes/resets the branch. The commits become merely dangling objects.  
   **Minimal fix:** return a three-state result (`found | missing | indeterminate`), treating only Git exit status 1 as missing, as already modeled by `packages/teamlead/src/bridge/phase-branch-tip.ts:33-70`. Any other failure must refuse before prune, `removeIfExistsUnlocked()`, or `create()`. Add injected-failure tests for both `unregistered + absent` and `worktree_missing`, asserting the original branch tip remains named and no destructive command runs.

2. **[HIGH] Missing recorder capability bypasses pending-rescue lookup and can enter the legacy create/reuse paths.**  
   `packages/edge-worker/src/worktree-takeover-transaction.ts:336-378` queries pending events only when both a recorder and `runId` are present. Otherwise execution silently continues into classification. In particular, an unregistered/absent state can execute the legacy create path at `:594-603` before `gateRescueAllowed()` ever checks for `rescue_event_capability_missing`; a clean registered state similarly returns `reused` at `:418-423`.  
   **Failure scenario:** a `worktree_missing` rescue records its durable event and crashes after `worktree prune`. On restart with an HTTP/NoOp or incompletely wired emitter, the pending event is never loaded. If the surviving local branch is already contained in `S`, the code takes the fresh-create path, issues a new generation instead of carrying `generationBefore`, and leaves the durable rescue event unresolved. A crash after cleanup but before the cleaned receipt can instead be mistaken for ordinary reuse, omitting the rescue evidence and prompt entirely. This is exactly the state the pending-event gate is intended to prevent.  
   **Minimal fix:** for a shared takeover candidate, require recorder capability and `runId` before any classification result that can create, mutate, or return ordinary reuse; otherwise refuse with `rescue_event_capability_missing`. Add post-`pruned` and post-clean/pre-receipt re-entry tests with the capability absent, asserting no create/reuse occurs.

3. **[MEDIUM] Rescue pushes are not actually create-only under a remote race.**  
   `packages/edge-worker/src/worktree-takeover-transaction.ts:1301-1312` checks that each remote ref is absent, but `:1313-1326` later performs a normal push without an atomic nonexistence lease. If another Bridge or host creates the same ref after the preflight, Git may accept this push as a fast-forward update when that new tip is an ancestor of the rescue tip. The final `ls-remote` then validates the updated value, so the code reports success despite having modified an existing rescue ref. This breaks the immutable/create-only rescue-ref contract and can make the other transaction’s recorded `branch@tip` evidence stale. The in-process repo lock does not serialize separate Bridge processes or hosts.  
   **Minimal fix:** add one `--force-with-lease=refs/heads/<remoteBranch>:` expectation for every `toPush` ref (empty expected value means the ref must not exist), retaining `--atomic` and the post-push verification. Add a race test that creates an ancestor-valued remote ref between preflight and push and expects `rescue_ref_conflict`/push refusal.

# Verdict

The manifest hashing and tamper test meet the Lead requirement, but the local-branch probe can cause irreversible loss of unpublished commits, and crash re-entry can bypass the durable pending event when recorder capability is absent.

VERDICT: CHANGES REQUESTED
