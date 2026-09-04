# Design Review — plan.md (Round 4)

Date: 2026-09-03
Author: Codex
Status: APPROVED

## Summary

Rev 6 resolves the sole Round 3 HIGH finding. `lead_tree <tree-ish>` now gives scan, the pre-import assertion, the mutation test, and clone acceptance one canonical identity algorithm: reconstruct the synthetic root from the exact twelve name→child-tree-OID entries, then compare both the root OID and the complete mapping. The plan also correctly states that the synthetic object need not be reachable from `IMPORT_SHA`, so acceptance reconstructs it rather than assuming the clone already contains it.

The overall design is feasible in the current POSIX-shell/Git architecture, the first-import scan is bound to the committed Lead-folder bytes, and the live-memory blast radius is appropriately constrained. No blocking issues remain.

## What's Good (Keep)

- Keep `lead_tree` as the single production implementation used by `scan.sh`, C5, the mutation test, and C6; this prevents test/acceptance logic from drifting away from the import guard.
- Keep both identity checks: the reconstructed synthetic root OID and the twelve-entry name→child-OID mapping. The mapping makes the evidence human-auditable while the OID provides exact Git-object identity.
- Keep materializing and scanning the synthetic tree itself, then leaving writes that arrive later unstaged for A2.
- Keep the explicit `IMPORT_SHA`/`SMOKE_SHA` sequencing, actor scope on every hook-bearing command, disposable negative-test clone, and three-way hook provenance evidence.
- Keep the per-tool scan terminal criteria, mutation-style disposition control, exact tool versions, private atomic reports, and value-free ledger.
- Keep the exact-root bootstrap protections, fail-closed audit paths, actor-independent CI range validation, CI suite registration, and honest statement that CI detects rather than prevents a pushed violation.

## Issues & Recommendations

1. **LOW — The risk table retains the pre-rev-6 shorthand for tree identity.** Section 8 still says the staged subtree OID is compared directly with the terminal-scan tree OID. The normative C4, C5, C6, and negative-guard text now define the correct reconstruction algorithm, so this does not block implementation. **Suggested fix:** replace that shorthand with “run `lead_tree` on the staged candidate tree and require the reconstructed synthetic-root OID and twelve-entry mapping to equal the terminal scan evidence,” keeping every summary of the invariant aligned.

## Verdict

APPROVED — ready to implement
