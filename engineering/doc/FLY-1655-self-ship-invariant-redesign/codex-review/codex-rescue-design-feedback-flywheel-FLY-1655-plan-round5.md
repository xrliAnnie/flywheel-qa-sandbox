# Design Review — plan.md (FLY-1655) (Round 5)

Date: 2026-08-08
Author: Codex
Status: APPROVED

## Summary

Round 5 closes all three remaining Round 4 blockers: approval-winner adjudication now shares the canonical production policy, gate-reissue convergence is atomic and repairable, and built deployment identity is immutable and can advance only through a real rebuild. The full plan is feasible in the current architecture, preserves founder-only authority and anti-stale guarantees, and is ready to implement with the stated sequencing and mutation tests.

## What's Good (Keep)

- Keep R1's single shared approval-policy function, including the production structured-response parser, trusted writer set, founder-id resolution, effective attribution-gate behavior, and fail-closed typed result when the policy cannot be conclusively evaluated. This removes policy drift between canonical verification and recovery adjudication.
- Keep the winner matrix for founder id, `bridge`, `bridge-founder-consent`, untrusted Lead, malformed JSON, explicit rejection, and unresolved policy. It directly protects the rule that recovery can never invalidate a completed founder decision.
- Keep R3's completed-stage CAS and `gate_reissue_converged:<requestId>` append in one StateStore transaction, with exact tuple matching and repair of an already-completed holder missing its receipt. This fits the existing transactional run-event pattern and closes both crash windows identified in Round 4.
- Keep the immutable `artifactBuildSha` model. Forcing a rebuild whenever built-mode intent differs from the embedded SHA makes `/health`, ancestry validation, and `deployed-sha` describe executable truth rather than mutable metadata; retaining source-mode doc-only skips is consistent with the current `tsx` deployment.
- Keep F2's fresh internal capability bound `issued_at < expires_at <= absolute_deadline_at`, permanent derived claim, byte-identical bounded replay digest, and exact-replay migration fixture.
- Keep the broader invariant design: A1's strict full-tuple proof does not mint authority from intent alone; E1b rotates transport identity without transferring an old founder card; C and D provide durable, classified exits; no new environment flag/table is introduced; `workflow_v2`, FLY-1436 RESERVED flags, and founder-only authority remain untouched.
- Keep the implementation order `F → B → A → C → D → E → G+B3`, separate A/E commits, per-layer reversibility, production-shape fixtures, and mutation-style positive controls.

## Issues & Recommendations

1. **No blocking design issues remain.** During implementation, make the extracted approval classifier the sole code path used by both `verify-approval` and R1, and keep the plan's unresolved-policy equivalence test so later refactors cannot silently recreate two effective policies. This is an implementation guard already implied by the plan, not an additional design change.

## Verdict

APPROVED — ready to implement
