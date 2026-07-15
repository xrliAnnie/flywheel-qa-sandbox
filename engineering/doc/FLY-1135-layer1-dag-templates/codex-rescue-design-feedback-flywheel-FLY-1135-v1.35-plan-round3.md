# Design Review — plan.md (Round 3)
Date: 2026-07-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 resolves the substance of all five Round 2 blockers. The capability channel now uses the correct same-Unix-user threat model; claim resolution chooses the newest decision before validating it; authoritative CommDB writes own their source outbox/history; output writes are attempt-authorized; and the materializer has bounded validation, serialization, ownership, idempotency, and recovery rules. The resulting architecture is feasible on the current Bridge/StateStore/CommDB design.

Three narrower normative gaps remain. Most importantly, Section 2.1 calls itself the complete canonical claim schema but cannot represent its own `qa_exempt` and server-owned founder claims. The cross-DB section describes what must later be defined rather than selecting the final authority/cutover contract, and it retains a downgrade path incompatible with the plan’s authoritative event-history promise. Finally, the authoritative storage inventory still omits the category binding and two newly required durable side-effect/source ledgers, while retaining the obsolete “six tables” note.

This needs one focused consistency pass, not another architecture redesign.

## What's Good (Keep)

- Keep the corrected decision-capability identity: run, node, execution, attempt, and predicate family, with legal edge selection only after a result.
- Keep capability plaintext exclusively in parent/Bridge memory and require a separately proven non-exportable path for Claude and Codex. The real-machine A-cannot-forge-B test is the correct security acceptance.
- Keep marker payloads capability-free and require unproven backends to fail admission.
- Keep canonical submission digests/client request ids and absolute-deadline-bounded renewal.
- Keep the “select newest attempt/sequence first, then validate that exact decision” rule. This closes fallback to an older PASS.
- Keep authoritative server-side subject resolvers and comparison-only runner subjects.
- Keep source events in the same CommDB transaction as TURN/founder writes and append-only TURN history.
- Keep attempt-keyed outputs, current-attempt promotion, trusted materialization, and the exact Produce → materialize/push → Design Review → Founder sequence.
- Keep the corrected template publication model, admission-time snapshot pinning, valid cross-vendor eng seed, and orchestration-only compatibility scope.
- Keep the recut PR dependency chain and expanded real-machine/fault-injection matrix.

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[BLOCKER] The “complete canonical” claim schema cannot represent all declared claim kinds.**

   **Issue:** Section 2.1 defines `subject_kind / subject_digest` only as `git_head + SHA`, but Section 2.4 defines `qa_exempt` as a Bridge policy claim bound to a snapshot digest rather than a head. `bridge_policy` and `founder_challenge` claims also do not necessarily have runner issuer execution/node/vendor/model values or a `decision_capability_id`, yet the canonical table does not state which fields are nullable or the per-issuer constraints. The schema dropped `issued_at`, although claims feed the audit/timeline and carry expiry. The resolver additionally requires a claim to be “not revoked,” but the append-only claim schema has no revocation/supersession record; only the pre-consumption capability has a `revoked` field.

   The older summary in Section 2.4 still says “highest valid attempt,” which contradicts the canonical select-first algorithm, and the founder paragraph links to nonexistent Section 2.6.

   **Why it matters:** PR-1 cannot produce unambiguous DDL or CHECK constraints from this “single truth.” Implementers may force `qa_exempt` into a fake git head, make server claims look runner-issued, mutate claims to revoke them, or reintroduce fallback to an older PASS.

   **Suggested fix:** Expand the canonical schema with an explicit subject-kind enum at least covering `git_head` and `snapshot_digest`; restore `issued_at`; state nullability/CHECK rules by `issuer_kind`; make `decision_capability_id` required only for runner-node claims and use the server-owned challenge/policy id for the other kinds. Either remove claim revocation from the read algorithm or define an append-only revocation/supersession record and its ordering rule. Delete the duplicate “highest valid attempt” summary in Section 2.4 in favor of a direct reference to Section 2.1, and fix the Section 2.6 reference to Section 2.4b.

2. **[BLOCKER] The cross-DB section still does not choose a ship-ready authority/cutover contract.**

   **Issue:** The source-side CommDB outbox design is now correct, but the text then permits an alternative where CommDB transaction changes are deferred and StateStore events are only a rebuildable current-state projection. That alternative cannot preserve intermediate TURN transitions and conflicts with Section 3.1b’s statement that run events are the authoritative history. The paragraph says to “define” the dual-read exit criterion and post-cutover authority, but does not actually define either.

   **Why it matters:** PR-3 can choose the cheaper projection fallback and still appear compliant, while PR-5/FLY-1038 later assumes a complete authoritative ledger. Readers can also switch away from CommDB at different times without an objective readiness condition.

   **Suggested fix:** Choose the source-side CommDB event/outbox + append-only TURN history as mandatory for the epic’s ship path. If a current-state projection is useful as an intermediate PR state, label it explicitly non-shippable and gate PR-4/PR-8 acceptance on the source outbox. State the final authority after cutover (consistent with the founder decision, teamlead.db for workflow claims/events while CommDB remains the legacy compatibility source) and concrete exit criteria: protocol version coverage for all active writers/readers, zero durable outbox lag, successful full reconcile, no legacy in-flight sessions outside the dual-read adapter, and rollback verification. Assign those gates to PR-3/PR-4.

3. **[HIGH] The storage inventory and acceptance sentinels have not caught up with the new authoritative components.**

   **Issue:** Template selection now depends on a `project + task-category` binding, but no authoritative binding table/API appears in the teamlead.db inventory. The correct CommDB source outbox/TURN-history rows are also absent, as is a materializer intent/commit/reconcile ledger (the listed `workflow_dispatch_outbox` is dispatch-specific). The example still says DDL consists of six tables even though the normative inventory now has ten teamlead.db tables before bindings/materialization and requires additional CommDB source tables. E3 still uses old “token” wording, the `run_42` example says only “一次性凭证,” and the proposed grep sentinel literally contains the forbidden `edge_token` string, so a naïve sentinel fails its own source.

   **Why it matters:** The “complete DDL + StateStore API” PR can omit data needed for deterministic selection or crash-safe materialization, and the documentation sentinel will either be disabled or produce false positives.

   **Suggested fix:** Add the project/category/default binding storage and API; add the CommDB source-event/TURN-history schemas to the cross-DB inventory; either generalize the dispatch outbox into a typed side-effect ledger that also supports materialization or add a separate materializer ledger. Replace the six-table note with links to both authoritative inventories. Rewrite E3 as exact-idempotent retry versus old-attempt/expired/conflicting capability reuse. Implement the doc sentinel with scoped patterns/exclusions (or a small parser/test) so its own declaration does not match, and remove the remaining duplicate terminology from examples.

## Verdict

CHANGES REQUESTED — address items above
