# Design Review — FLY-1718 plan.md (Round 5)
Date: 2026-08-12
Author: Codex
Status: APPROVED

## Summary

Both Round 4 blockers are closed. P3 now uses the credential that production runner panes actually possess, without leaking the Bridge master token or manifest contents. P4 now treats lifecycle activation and DOA settlement as one StateStore authority transition and makes startup/periodic repair re-drive that same transition, preserving the park CAS and preventing lease expiry from admitting a second launch over a durable binding.

The revised plan is feasible in the current architecture, internally consistent, and sufficiently explicit for implementation. No blocking design gaps remain.

## What's Good (Keep)

- The P3 endpoint is on the ingest-token surface used by existing runner tooling. `Blueprint` supplies `TEAMLEAD_INGEST_TOKEN`, and both Claude and Codex adapters expose it as `FLYWHEEL_INGEST_TOKEN`; the production-shaped success test now matches that real environment.
- Returning only `allow`/`deny` preserves least privilege despite the ingest token being fleet-scoped. Manifest data and Bridge master authority remain server-side.
- The plan explicitly forbids injecting `TEAMLEAD_API_TOKEN` into runners, preserving the existing credential-isolation boundary.
- P4 no longer infers settlement from a binding alone. The authoritative transition checks the exact reservation owner and binding, wins or observes lifecycle `starting→active`, and settles in the same StateStore transaction under the canonical issue mutex.
- The repair rules correctly distinguish `active`, `cancelled/closed`, and indeterminate activation outcomes. In particular, an expired lease cannot create a second owner while the first owner has a matching durable binding.
- The new tests cover the material crash and race states: binding-before-activation crash, founder park winning the CAS, DB/activation indeterminacy, idempotent repair, and lease expiry with an existing binding.
- The earlier P1/P2 decisions and the Round 1–3 fixes remain intact; the four-package sequencing and P1-first ship strategy are still sound.

## Issues & Recommendations

1. **[NON-BLOCKING IMPLEMENTATION NOTE] Enforce server-side ingest-token configuration explicitly at the new endpoint.**

   **Why it matters:** The existing `tokenAuthMiddleware(undefined)` is intentionally a no-op (`packages/teamlead/src/bridge/plugin.ts:969-975`). The plan already says a missing token must fail closed, so the validation endpoint must not inherit that legacy unauthenticated behavior when `TEAMLEAD_INGEST_TOKEN` is absent from Bridge configuration.

   **Suggested fix:** Add an endpoint-local/configuration guard returning 503/deny when the Bridge ingest token is unset, then apply the normal ingest middleware. Include this server-token-unconfigured case alongside the already specified wrong/missing runner-credential tests. This clarifies implementation of the existing plan requirement; it does not require a design change.

2. **[NIT] Update the plan revision header.**

   **Why it matters:** The `基于:` line currently records acceptance only through R3 even though the body contains the R4 fixes.

   **Suggested fix:** Record “R4 全 2 项采纳” during the next editorial pass so the document provenance matches its contents.

## Verdict

**APPROVED.** The plan now closes the complete review chain: branch continuity is materialized and fail-closed, push protection is self-contained, design review is bound to a Bridge-owned manifest through a production-reachable least-privilege channel, and DOA release/settlement has durable identity, atomic activation, and crash-safe fencing. The two notes above are implementation/editorial reminders, not approval blockers.
