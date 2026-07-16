# Design Review — FLY-1281 plan.md (Round 6)

Date: 2026-07-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

Draft v6 resolves the three Round 5 findings: v1 is consistently excluded from start-time wiring, the start path now has a credible reservation/re-drive model, and completion markers converge on one canonical audit identity. One credential-recovery hole remains at the admitted-before-launch crash boundary, and the storage/acceptance summaries still describe the retired one-table idempotency design.

## What's Good (Keep)

- Keep the now-consistent v2-only selection contract: no candidate and v1 candidate both return `null` to the exact legacy path under either flag state.
- Keep the three-phase start model—immutable reservation, mutable monotonic stage pointer, immutable response receipt—with run and execution IDs allocated before materialization.
- Keep the generalized-only pre-bound fresh-start seam and reuse of the existing durable launch-claim/commit adoption discipline. This is the correct way to make a Bridge restart converge on one physical execution.
- Keep the canonical `wfca:<run>:<node>:<attempt>` lifecycle-audit identity and digest-aware marker reconciliation. It correctly handles both the original post-core-transaction crash and response loss on a later equivalent completion.
- Keep the typed `missing_output` retry result, output-current attempt/execution checks, and completion receipt/run-node/session projection transaction.
- Keep the capability-driven D2 invariant, typed snapshot, server-derived node identity, and explicit C→D execution boundary.

## Issues & Recommendations

1. **A Bridge crash after generalized admission loses the hash-only output credential needed to resume spawn.** For a `produces_output` start, Step 4a mints the output credential during admission and Step 5 threads its plaintext into the runner environment. By contract the database stores only its hash; the current credential pattern generates random plaintext and cannot reconstruct it. If the Bridge crashes after stage `admitted` (or `commdb_registered`) but before launch commit, v6 re-drives the same execution without a second binding/admission, but it has no credential value to put in `BlueprintContext`. Returning the existing credential row cannot solve this, and persisting plaintext in the reservation/response would violate the hash-only hard line. Add an explicit pre-commit credential-recovery contract. Two safe shapes are: (a) derive the token reproducibly from a versioned server secret plus the immutable reservation tuple while storing only its hash, or (b) under the durable single-owner launch discipline, atomically revoke the unconsumed old ticket and issue a new plaintext ticket for the same execution whenever recovery proves no launch commit exists. For option (b), preserve the binding/runtime rows, enforce exactly one live output ticket, and reject rotation once launch is committed. Add real Bridge-crash tests for an output-producing node after admission and after CommDB registration, proving the resumed runner receives a usable token, the old token is rejected, and output submission/completion succeeds.

2. **The storage summary and transaction acceptance cells still describe the superseded idempotency design.** §3 still lists one append-only `workflow_start_idempotency` table, while Step 6c requires `workflow_start_reservation`, mutable `workflow_start_stage`, and `workflow_start_response`. The selection matrix still says “three loss points” and omits the new reservation/CommDB boundary, Bridge crashes, concurrent retries, and exactly-one response receipt. Replace the stale row with all three tables and their mutability/trigger posture. Also pin the StateStore transaction boundaries: reservation + materialization + initial `materialized` stage are one transaction; admission effects + `admitted` CAS are one transaction; response receipt + `responded` CAS commit together before `res.json`; external CommDB/launch evidence may lead the stage pointer but replay must repair a lagging pointer monotonically. Update the matrix to the four crash/concurrency boundaries stated in Step 6c, including exactly one binding, live credential, physical spawn, canonical response receipt, and monotonic stage history.

## Verdict

CHANGES REQUESTED — address items above
