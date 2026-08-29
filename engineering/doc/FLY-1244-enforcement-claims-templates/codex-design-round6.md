# Design Review — FLY-1244 plan.md (Round 6)
Date: 2026-07-14
Author: Codex
Status: APPROVED

## Summary

Round 6 closes all four bounded Round 5 findings. The ship-gate identity boundary now has an explicit run-level `current_qa_attempt`, an exact binding/current-projection/enrollment join, claim issuer matching, and enrollment-scoped migration checks. The template audit and override contracts now agree with their DDL and validation order. The TURN projector has one A/B-decoupled project-history contract and a typed result. The remaining head-authority, Option B test, and canonical-digest choices are single-path rather than forks.

The finalized plan is feasible against the current StateStore and flywheel-comm architecture. Its deliberate security limitation is accurately represented: Option B reduces the shared-bearer blast radius but does not provide same-user isolation; production claims READ remains off until both fresh-spawn evidence and the peer-credential hardening follow-up exist. No unresolved governance or implementation-design blocker remains.

## What's Good (Keep)

- Keep `workflow_run.current_qa_attempt` as an admission/re-QA transaction output, and keep the exact SQL join through immutable execution binding, the current `workflow_run_node` projection, run enrollment, and claim issuer execution/attempt.
- Keep migration preflight scoped to the row being enrolled or backfilled; legacy and non-enrolled null execution IDs must remain harmless while the feature is off.
- Keep the Option B-only credential schema, durable exact-replay transaction, server-derived issuer/head, and explicit same-user TTL-window forgery limitation.
- Keep the Bridge endpoint as the sole CLI head authority and the per-sink HEAD acceptance matrix.
- Keep the template audit `run_override` action and `run_id`, the pre-validation skip overlay with no residual `skip` key, and the all-DDL `IF NOT EXISTS` migration requirement.
- Keep the projector tagged union and the commit-A invariant that TURN writes a project/issue-level receipt/history disposition only—never a `workflow_run_event` and never a B-era run lookup.
- Keep production READ disabled for this sub-issue, FORCE_LEGACY as the actual rollout path, and peer-credential hardening as a hard prerequisite for production READ.

## Issues & Recommendations

1. **[LOW, non-blocking] Remove one stale `authority_kind` field reference.**

   **Issue:** Section 4.1 describes `workflow_submission_credential` as having `authority_kind='bearer'`, while the finalized Option-B-only DDL in §4.1b intentionally has no `authority_kind` column.

   **Why it matters:** The schema is otherwise unambiguous—all rows in this table are Option B bearer credentials—but the stray field name could mislead a literal implementation or test.

   **Suggested fix:** Delete the parenthetical `authority_kind='bearer'` in §4.1, or add the column only if a concrete consumer is identified. This is editorial cleanup and does not block implementation or approval.

No blocking issues found.

## Verdict

APPROVED.

The plan is ready to enter implementation with the stated commit gates, fail-closed rollout, fresh-spawn/crash/replay evidence, and production-READ prerequisites enforced as written.
