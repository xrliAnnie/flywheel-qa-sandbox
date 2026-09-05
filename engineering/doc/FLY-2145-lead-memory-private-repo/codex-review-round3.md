# Design Review — plan.md (Round 3)

Date: 2026-09-03
Author: Codex
Status: CHANGES REQUESTED

## Summary

Rev 5 materially resolves all six Round 2 findings. The immutable index snapshot closes the live-directory TOCTOU gap; the import and smoke commits now have correct actor scope and SHA anchoring; scan disposition has a discriminating two-state control; destructive acceptance moved to an isolated clone; bootstrap/template/version contracts are reconciled; and the live hook evidence now has explicit three-way provenance. The design is feasible in the current shell/Git architecture and is substantially safer for the live memory directory.

One HIGH-severity correctness gap remains in the exact Git-tree identity contract. It is localized and there is no new BLOCKER, but C5/C6 cannot be executed literally until the plan distinguishes the synthetic root tree containing the twelve Lead folders from the twelve individual child-tree OIDs.

## What's Good (Keep)

- Keep the index-first scan: stage the Lead folders, materialize the exact tree, run both scanners on that immutable copy, and leave later live writes unstaged for A2.
- Keep the per-tool terminal criteria, explicit `.gitleaksignore` path, value-free trufflehog fingerprints, prohibition on retaining a true secret, and the green/red mutation-style disposition control.
- Keep the explicit admin scope across add/commit/push, `IMPORT_SHA` acceptance before the smoke commit, separate `SMOKE_SHA`, and the legitimate own-folder cleanup commit.
- Keep all negative write tests in a disposable clone with isolated audit state, plus the three-way live/clone/flywheel hook-hash evidence.
- Keep the exact-root bootstrap cases, preflight-before-mutation rule, restore-on-swap-failure test, runtime-only ledger, synced in-repo bootstrap, and corrected tool-version responsibilities.
- Keep the actor-independent CI range check, root/merge/empty/duplicate-trailer negatives, unconditional non-fast-forward/deletion refusal, and fail-closed admin/sync audit behavior.
- Keep the CI suite inventory, manual-only real dual-scanner suite, and workflow-structure contract test.

## Issues & Recommendations

1. **HIGH — `scanned_tree` is one root tree, not an OID that each of the twelve folder subtrees can equal.** C4's `git write-tree` produces a single synthetic root tree whose entries are the twelve Lead folders. Each folder entry points to its own, generally different, child-tree OID. After C5 stages README, hooks, the ledger, and other top-level files, the full index root tree also has a different OID from `scanned_tree`. Therefore the statements “12 夹的暂存子树 OID == `scanned_tree`” in C5 and “12 个顶层夹的子树 OID == `scanned_tree`” in C6 are not executable as written; a literal implementation either always fails or weakens the binding with an ad hoc comparison. The synthetic `scanned_tree` object also need not be reachable from `IMPORT_SHA`, so a fresh clone is not guaranteed to possess that object merely because it has the same twelve child trees. **Suggested fix:** define one canonical helper/algorithm used by scan, the C5 pre-commit assertion, the mutation test, and C6. Require the exact expected set of twelve top-level `040000 tree` entries; at C5 extract those entries from the full staged candidate tree and reconstruct their synthetic root with `git mktree` (or compare the complete NUL-safe name→child-OID mapping) against `scanned_tree`; at C6 do the same from `IMPORT_SHA^{tree}` in both source and clone. Record the twelve-entry mapping in the ledger/evidence, and change the prose from “each subtree equals `scanned_tree`” to “the reconstructed twelve-folder root tree equals `scanned_tree`.” This preserves the current architecture and makes the mutation control test the exact production check rather than a proxy.

## Verdict

CHANGES REQUESTED — address items above
