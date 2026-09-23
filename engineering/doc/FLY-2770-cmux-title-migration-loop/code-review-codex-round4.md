# Code Review — FLY-2770 PR #1283 (Round 4)

Date: 2026-09-22
Reviewer: Codex
Head: 314e9e597c90c874fec634069611cc04b5397d34
Status: CHANGES REQUESTED

## Summary

The primitive-level commit hook is correct on the code paths it handles. `_ledger_upsert prepared` does not purge, a failed ledger transaction does not purge, and a successful `committed` upsert followed by purge failure logs while returning the ledger transaction's success rc. `_ledger_transaction` releases its inner lock before the purge, and every production entry into prepared-ledger reconciliation is under the mutator lease; the sweep also rechecks that lease itself. The state rewrite validates the existing file and uses a same-directory temporary plus atomic `mv`, so ordinary write failures preserve the old state. Empty-ledger behavior is correct, whitespace is preserved semantically, and pipe-bearing titles cannot enter a valid ledger/stall tuple.

The lifecycle recovery is still incomplete at the ledger input boundary. A missing ledger returns before the sweep, while an actual `getline` read error inside the sweep is silently treated as EOF and can erase live evidence. The new regression case also omits the assertion that its live prepared row survives and does not pin the new upsert hook's prepared-state or purge-failure rc guards. The supplied suite/lint/negative-control results were treated as reported facts and were not re-run. Static `/bin/bash -n` and `git diff --check` passed at the exact head; an isolated host-`awk` probe confirmed that `getline` returns `-1` for a missing input while `awk` itself exits 0 with the current loop shape.

## Findings

1. **Ledger absence and ledger read errors are not handled as a safe tri-state — MEDIUM**

   - **File:** `scripts/flywheel-cmux-sync.sh:8973`, `scripts/flywheel-cmux-sync.sh:8975`, `scripts/flywheel-cmux-sync.sh:9037`, `scripts/flywheel-cmux-sync.sh:9047`
   - **Evidence:** [verified by reading code and an isolated `awk` probe] `reconcile_prepared_ledger` returns at line 9037 when `VIEW_LEDGER` is missing, before the recovery sweep at line 9047. Therefore the exact missing-ledger residue called out in Round 3 is never retired. Separately, the sweep loops only while `getline > 0`; POSIX awk reports `-1` for an input error, but the program never checks that value. On this host, a missing `ledger` path produced `getline_rc=-1` and overall `awk_rc=0`. The sweep then treats the live-receipt set as empty and atomically replaces the stall file with every lifecycle-owned row removed. The earlier conflict scan normally catches a pre-existing unreadable ledger, but it does not close the check/read race if the ledger disappears or faults between that scan and the sweep.
   - **Failure scenario:** After a two-file crash or external cleanup leaves stall evidence but no ledger file, every later reconcile returns success without sweeping, so the orphan survives indefinitely and can still contribute to the validator-cap/stale-count problem. Conversely, if a valid ledger with a live prepared receipt becomes unreadable or disappears immediately before the sweep's `getline`, the sweep exits successfully and deletes that receipt's `absent|drift|authority|migration` evidence instead of preserving state on uncertainty.
   - **Suggested fix:** Give the ledger source an explicit tri-state. Treat a conclusively absent ledger as an empty readable source (for example `/dev/null`) and run the sweep before the missing-ledger return; reject symlink/non-regular/unreadable existing paths. In awk, store each `getline` result, break only on `0`, and `exit` nonzero on `< 0`, so the temporary is removed and the old stall file survives any read error. Add separate regressions for (a) missing ledger retiring owned orphan rows and (b) injected/read-error ledger preserving the original stall file and logging the unavailable sweep.

2. **The lifecycle regression misses over-deletion and the new upsert rc branches — LOW**

   - **File:** `scripts/test-cmux-sync.sh:12871`, `scripts/test-cmux-sync.sh:12873`, `scripts/test-cmux-sync.sh:12935`, `scripts/test-cmux-sync.sh:12955`, `scripts/test-cmux-sync.sh:12961`
   - **Evidence:** [verified by reading code] The sweep fixture seeds a live `drift|...|workspace:8|live-one` row and its exact prepared receipt, but the assertions check only orphan removal, stale-generation removal, and survival of the foreign `node-absent` kind. There is no assertion that the live drift row survives. Thus replacing the keep predicate with one that deletes every lifecycle-owned row still passes this case; the reported “delete the sweep call” negative control tests under-deletion only. Also, `_fly2770_seed_migration_row` writes evidence and then calls `_ledger_upsert prepared`, but never asserts the evidence remains before exercising branches whose expected result is zero rows. Removing the `state == committed` guard would make those cases pass vacuously. Finally, the purge-failure rc case exercises `_ledger_remove`, not the newly added `_ledger_upsert` hook.
   - **Failure scenario:** A future edit purges evidence on a prepared upsert, drops valid live evidence during the sweep, or propagates cleanup failure after a successful committed upsert. The new lifecycle test can remain green even though the no-over-deletion and primary-transaction rc contracts have regressed.
   - **Suggested fix:** Assert immediately that a prepared upsert leaves the seeded migration row intact; after the sweep, assert the exact live `drift` row remains; and stub `_prepared_stall_purge_ref` around a successful `_ledger_upsert committed` to assert committed ledger state, warning emission, and rc 0. These are the complementary negative controls to the two already reported.

## Verdict

**CHANGES REQUESTED.** The commit-time hook, rc preservation, lease coverage, lock ordering, and atomic rewrite are sound, but the recovery sweep still skips a missing ledger and fails open on an actual ledger read error. Its regression test also does not prove the two no-over-deletion/rc guarantees most exposed by the new primitive-level design.
