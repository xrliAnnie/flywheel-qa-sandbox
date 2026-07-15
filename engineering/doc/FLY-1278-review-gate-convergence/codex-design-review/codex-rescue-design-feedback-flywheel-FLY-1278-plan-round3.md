# Design Review — FLY-1278 plan.md (Round 3)

Date: 2026-07-15
Author: Codex
Status: APPROVED

## Summary

Round 3 resolves all five Round 2 findings, and the plan is now internally consistent, feasible in the current Bridge/StateStore architecture, and ready to implement. The convergence policy, ruling authority, exact-head binding, canonical outbox delivery, production alerting, and rollback behavior now form one testable design without weakening the settled FLY-827/FLY-1188 protections. The remaining recommendations below are non-blocking implementation guardrails.

## What's Good (Keep)

- The ruling snapshot now has one unambiguous lifecycle: resolve aliases and load once before `buildPrompt`, feed that same immutable object to GOVERNANCE prompt rendering and post-review policy computation, and defer mid-round creates/revokes to the next round. The two-direction blocked-review tests correctly pin this behavior.

- Classification is now independent of the gate decision. APPROVED remains non-tightened while MEDIUM/LOW findings still become frozen, keyed advisories and generate the Lead notification expected by the runner contract; HIGH/unknown findings remain visible without changing the approved governance rule.

- Effective APPROVED code verdicts—including downgraded verdicts—retain the exact frozen-head echo requirement. Gate revalidation, current-head re-derivation, fail-close parsing, delivery ownership, and deliver-before-authority ordering remain intact.

- `response_json` and `payload_version` provide a single byte source for live delivery and redrive, while the policy-off sentinel proves legacy prompt, verdict, payload, and alert behavior together. Restricting legacy ownership to NULL-version rows preserves the anti-forgery boundary.

- The ruling channel is now mechanically bounded: server-derived finding provenance, deterministic issue identity, ambiguity rejection, a partial unique active-ruling index, semantic idempotency, revocation audit, prompt limits, and automatic HIGH-dispute alerting all align with the existing fail-closed posture.

- The structured asynchronous alert dependency, deterministic event ids, late-bound routed sink, and explicit at-least-once Discord semantics are implementable with the current notifier architecture. Accepting a correlated duplicate post is a clear and proportionate tradeoff.

- The production R6-R9 fixture remains valid at SHA-256 `ccc985af7072d392aac34178ad544b2120ae43b6abc5207d8e903065a138447f`, and the revised plan contains no literal control bytes. The three-part replay model directly proves convergence and rollback attribution.

## Issues & Recommendations

1. **Non-blocking migration syntax guard:** change the ordinary index statement in §3.5 to `CREATE INDEX IF NOT EXISTS idx_review_ruling_issue ...`. The partial unique index already uses `IF NOT EXISTS`, but the preceding ordinary index does not; without it, the named repeated-initialization migration test would fail on the second initialization.

2. **Non-blocking alias-evolution guard:** add a case where a ruling is created while the local cluster contains only `FLY-XXXX`, then a later execution introduces the UUID↔identifier edge. The alias-aware active lookup/check should reuse the existing ruling and revoke it correctly rather than insert a second row under the newly preferred UUID canonical value. This pins the intended behavior when the deterministic cluster representative becomes better informed over time.

3. **Non-blocking slice sequencing guard:** Slice 1 currently names the full §3.1 `runJob` refactor, while the ruling table/list method arrives in Slice 2 and GOVERNANCE prompt wiring arrives in Slice 3. Keep every commit group buildable by either landing the shared ruling type/read seam before the coordinator change or explicitly deferring snapshot loading/wiring to Slice 2/3; Slice 1 can test policy computation with an injected empty snapshot.

4. **Non-blocking alert wording guard:** §3.1 says an APPROVED+HIGH/unknown anomaly is seen by the Lead “from the alert,” while the corresponding test only guarantees that the original findings stay visible. Either add a deterministic anomaly alert assertion without changing the verdict, or change that sentence to promise payload visibility only. This does not affect gate semantics.

## Verdict

APPROVED — ready to implement
