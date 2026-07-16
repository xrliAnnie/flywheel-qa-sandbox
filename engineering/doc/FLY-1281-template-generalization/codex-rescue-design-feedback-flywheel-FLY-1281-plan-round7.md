# Design Review — FLY-1281 plan.md (Round 7)

Date: 2026-07-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

Draft v7 closes the plaintext-credential recovery gap and now describes the three-piece start reservation/state/response model consistently. One correctness blocker remains: the plan assumes a durable single-owner recovery boundary that the current `LaunchClaimStore` does not provide, so concurrent same-key re-drives can rotate each other's credentials and both proceed toward launch.

## What's Good (Keep)

- The controlled-rotation approach preserves the hash-only credential contract: plaintext is never persisted or server-derived, the binding/runtime identity remains stable, and post-launch rotation is explicitly forbidden.
- The three storage objects and their transaction boundaries are now aligned across Step 6c, the storage summary, and the acceptance matrix.
- Treating CommDB registration and the launch commit as authoritative external evidence, then monotonically repairing a lagging stage pointer, is the right recovery model for the cross-store boundary.
- The crash matrix is substantially stronger: it covers response loss, Bridge-process failure, and concurrent retries at reservation, admission, CommDB registration, and launch commit, while asserting one binding, live credential, spawn, and response receipt.
- The v2-only start contract, typed snapshot, fail-closed review boundary, completion receipt authority, and default-off/legacy split remain well preserved.

## Issues & Recommendations

1. **The claimed durable single-owner boundary does not exist in the current launch substrate.** `LaunchClaimStore.claim(executionId)` is an `INSERT OR IGNORE`; after the row exists, `RetryDispatcher.dispatch` treats `exists + no commit marker` as permission to re-drive. It does not acquire a recovery lease, owner generation, or fence. Therefore two same-key callers can both observe no commit, both enter recovery, and both proceed. The second rotation can revoke the first caller's newly issued credential; the partial-unique index only guarantees one live row at an instant, not that the live token belongs to the sole launcher. Absence of a commit marker is also only a snapshot—it does not prove that another owner will not commit immediately afterward. Add an explicit ownership/fencing design before credential rotation and all launch side effects. For example, extend the durable launch claim with a CAS-acquired owner generation/lease and carry that generation through the adapter commit so stale owners cannot commit, or explicitly enforce a single live Bridge process and acquire a pre-await per-execution mutex that is held through commit/adoption (with an inter-process fence if overlapping Bridge processes are possible). Pin the ordering as: acquire owner/fence → recheck commit → rotate credential → register/launch → commit under the same fence. Add a barrier-controlled test with two dispatcher instances sharing the durable stores, both reaching the no-commit boundary, and assert exactly one rotation, one `Blueprint.run()`, and rejection of a stale owner's commit; retain the crash-takeover test.

2. **Credential rotation crosses the declared C/B scope boundary.** Sections 0.5 and 4a say generalized v2 execution can issue only zero or an output credential, while decision credentials remain exclusively on B's legacy enrolled three-stage seam. Step 6c nevertheless says recovery rotates “output and decision alike.” In C, rotate only the credential kind required by the typed v2 snapshot—currently output—or none; finding a live decision credential for a generalized binding should fail closed as an invariant violation. Defer generalized decision-ticket recovery until that credential shape becomes reachable in D, rather than touching the legacy B seam from this path.

3. **Correct the “zero existing table changes” wording.** The plan adds `sessions.workflow_node_id` and three `workflow_run.selection_*` columns, but §§0.8, 4b, 3, and 5 still claim zero changes to existing tables. The approved hard line is satisfied by not modifying any existing column, CHECK, or trigger; describe the two additive nullable migrations explicitly and reserve “zero modification” for pre-existing columns/constraints/triggers. This removes an audit and rollout contradiction without changing the design.

## Verdict

CHANGES REQUESTED — address items above
