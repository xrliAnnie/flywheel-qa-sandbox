# Design Review — plan.md (Round 4)
Date: 2026-07-13
Author: Codex
Status: APPROVED

## Summary

The plan is now ready to implement. All prior blocking findings are closed in the actual normative text, not merely in the change summary.

The claims model has one complete schema, issuer-specific constraints, explicit subject kinds, append-only revocation, deterministic newest-decision-first resolution, and server-derived subjects. The capability boundary now addresses co-resident same-user runners and makes backend-specific proof a prerequisite. Cross-database writes have a mandatory source-side transactional outbox/history, an explicit final authority, objective dual-read exit criteria, and ship gates preventing an intermediate projection from masquerading as completion. Template bindings, output attempts, materialization, side effects, revocations, and CommDB source history all have authoritative storage homes.

The design is feasible on the current better-sqlite3 StateStore plus per-project CommDB architecture, and the PR order now respects its dependencies: edge-contract substrate and migration first, Gate A before generic dispatch, FLY-1224 before template execution, and default-off enablement last.

## What's Good (Keep)

- The unchanged FLY-1204 red test remains the first chapter’s acceptance line, while capability-forgery tests independently cover the second root cause.
- Claim resolution selects the newest attempt/sequence before validity checks and never falls back to an older PASS.
- Claims remain append-only; revocation is also append-only and auditable.
- Runner-node, Bridge-policy, and founder-challenge authorities now have explicit field constraints and authority identifiers.
- Capability plaintext never relies on same-user filesystem permissions. Each backend must prove an isolated submission path or fail admission.
- Capability verification precedes event insertion, and claim/edge/capability/event/loop/projection changes share one transaction.
- Dispatch and docs materialization use a typed durable side-effect ledger with reconcile semantics.
- CommDB source events and TURN history are committed with their authoritative mutations; projection into teamlead.db is idempotent.
- Admission pins a complete validated snapshot. Template publication affects only newly admitted runs, with immutable revisions and CAS publication.
- The eng seed is valid under the cross-vendor invariant, and the intentional vendor change is separated from orchestration compatibility.
- Product v1 keeps generic nodes `no_code`; output writes are attempt-authorized and only the trusted materializer owns git writes.
- Project/category binding, bare fallback, per-run Lead override, and post-override revalidation now form a deterministic selection contract.
- The parked FLY-1204 commits have a net-tree integration strategy rather than an unsafe chronological cherry-pick.
- The acceptance matrix covers replay, expiry, stale heads, crash boundaries, cross-DB reconciliation, loops, malformed schemas, both sinks, retries, and S1–S16.

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[NON-BLOCKING] Encode the prose invariants directly in PR-1/PR-5 DDL.**

   **Issue:** The plan deliberately defers executable DDL to the named implementation PRs.

   **Why it matters:** The security model depends on issuer-kind nullability, subject formats, one capability consumption, monotonic sequences, append-only rows, current-attempt promotion, and idempotency uniqueness.

   **Suggested fix:** Implement these as CHECK/UNIQUE/FK constraints, append-only triggers, and indexes—not only StateStore validation. Include migration/readonly compatibility tests and query plans for use-time gate reads.

2. **[NON-BLOCKING] Keep the security proof as a merge gate, not a follow-up.**

   **Issue:** The plan correctly permits different non-exportable mechanisms for Claude and Codex because their sandbox/connect behavior differs.

   **Why it matters:** A mechanism that is safe for the Codex sandbox may not isolate an unrestricted Claude shell under the same Unix user.

   **Suggested fix:** Select and document each backend’s concrete path in PR-1, run the specified real-machine A-cannot-forge-B test, and leave every unproven backend disabled. Do not weaken this to a unit-test-only claim.

3. **[NON-BLOCKING] Clean the last descriptive wording while implementing the doc sentinel.**

   **Issue:** A few non-normative summaries still use generic “token/credential” wording, and the convergence section retains an older “Annie v5 pending” status line.

   **Why it matters:** They no longer create a technical ambiguity because Sections 2.1/2.2 are explicitly canonical, but stale narrative text can confuse future audits.

   **Suggested fix:** Normalize those phrases to “decision capability,” update convergence status, and make the scoped parser/test part of the documentation test suite.

## Verdict

APPROVED — ready to implement
