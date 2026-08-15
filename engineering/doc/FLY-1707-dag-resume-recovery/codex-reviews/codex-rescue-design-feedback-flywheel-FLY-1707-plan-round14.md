# Design Review — plan.md (FLY-1707 E5) (Round 14)

Date: 2026-08-15
Author: Codex
Status: APPROVED

## Summary

Round 14 resolves both remaining Round 13 inconsistencies: the force-cancel state split is now single-valued, and S2 explicitly owns the complete delivery-evidence protocol that S3 consumes. After rereading the full normative plan and rechecking the affected StateStore seams, the design is feasible, internally consistent, and ready to implement in the proposed slice order.

## What's Good (Keep)

- Phase A is now unambiguously create-only for active/held runs, with no sweep-adoption branch; terminal collect-only is the sole request path that can adopt a sweep-created open receipt.
- Phase B now describes T7b aliasing without conflating run states, and the sweep-first replay test is correctly scoped to terminal collect-only.
- The explicit static guard against “sweep → Phase A adoption” protects the corrected state partition from drifting back during implementation.
- S2 now names `prepareWorkflowIssueDelivery`, the Blueprint → core/adapter → three-launch-surface seam, non-throwing initial/repair/adoption evidence handling, accepted-marker tuple coverage, and real pre-existing-conflict compatibility tests.
- S3 remains directly dependent on S2, so the resolver and shadow rider cannot ship against incomplete physical-launch evidence.
- The consolidated plan continues to honor the locked boundaries and existing patterns: current-step-only recovery, quarantine then rerun, no template-head fallback, append-only receipts, transaction-local/CAS authority, GatePoller riders, one registered flag, and no approval/land/fail-verdict reuse.

## Issues & Recommendations

1. **No blocking issues.** Keep the new Phase-A static guard and the complete S2 acceptance contract as executable implementation tests, not prose-only checks.

## Verdict

APPROVED — ready to implement
