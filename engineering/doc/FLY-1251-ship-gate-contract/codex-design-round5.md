# Design Review — FLY-1251 plan.md (Round 5)
Date: 2026-07-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

The Round-4 corrections are now materially present in the normative plan: POST ambiguity is fail-closed, activation ordering is corrected, scanner/edit eligibility is separated, and rejected reactions are explicitly quarantined. Two safety-critical protocols are still not executable as written, however, and a USE-time channel-health race remains; these should be closed before implementation begins.

## What's Good (Keep)

- §4.2 now classifies definitive versus ambiguous POST outcomes in the numbered algorithm. Ambiguous outcomes remain `posting + NULL` until a complete nonce scan establishes identity or absence, which correctly covers accepted-then-timeout, 5xx, and malformed-success-body half-failures.
- The live send order is coherent: persist message ID, establish binding, recheck activation preconditions, CAS active, then write the activation marker. The crash-after-CAS marker repair is explicitly tested.
- Observation and mutation eligibility are cleanly separated. `posting + message_id` remains observable but is never grey-edited, while channel-down can retire identifiable posting messages and cannot discard identity-ambiguous rows.
- The rejected-reaction design correctly recognizes that a denied reaction is consumed input, not a latent approval. Verified removal, durable absent-to-present detection, and retire/repost when freshness cannot be proven are the right fail-closed hierarchy.
- The Git-tree classifier, role-scoped exception boundary, manual-spawn admission reuse, six-route authority matrix, and conflict sequencing remain coherent. The missing FLY-1244 seam is stated honestly as a hard prerequisite rather than hidden behind a transition implementation.
- E7/E11/E13 now cover the important POST ambiguity, activation race, active-held, and carry-forward families rather than only happy-path behavior.

## Issues & Recommendations

1. **[HIGH] Restart reconciliation still has a second, weaker `posting → active` path.** §4.2 step 5 requires a just-in-time channel-health, pending-gate, and unchanged-head check before activation. But §4.2b says `posting + message_id != NULL` repairs the binding and then directly CASes to active; §4.5 merely asserts that step 5 also protects this path. On restart, that wording permits activation after the channel went unhealthy, the gate was answered, or the head changed. **Suggested fix:** define one named `tryActivatePostingCard` transition used by both the live-send path and every reconcile path. It should re-read all step-5 predicates after binding repair and immediately before the CAS, then retire with the appropriate reason (or remain fail-closed where identity is unresolved) if any predicate fails. Add restart tests for `posting+ID` and `posting+ID+binding` under each failed predicate, plus the existing concurrent channel-down race.

2. **[HIGH] The rejected-reaction protocol lacks an executable durable schema and crash ordering.** §4.3b names a tombstone tuple and an absent-to-present history, but the DDL/file contract defines neither the table/columns nor its unique key, lifecycle states, generation source, or CAS operations. It also does not require the tombstone to commit before the blocked response/marker is emitted. A crash after replying but before persisting quarantine can therefore leave the same reaction eligible after activation or hold release—the exact carry-forward failure the section is intended to prevent. **Suggested fix:** add the concrete StateStore DDL and APIs for one uncleared quarantine per `(card_attempt_id, founder_id, emoji)`, with explicit states such as `blocked`, `absent_seen`, and `cleared` (or an equivalent monotonic model); define how `blocked_reason_generation` is allocated and advanced; and specify CAS/idempotency rules. Normatively order blocked handling as durable quarantine first, then best-effort removal/read-back, then founder-visible response/marker. Add restart tests at every boundary: before/after tombstone insert, removal success before read-back, verified absence before state transition, fresh present before authorization, and retire/repost before replacement-card creation.

3. **[MED] Channel health is an activation/sweep condition but not a USE-time approval condition.** `assertActiveCardAuthority` currently checks active-card identity and tombstones, while channel-down retirement occurs asynchronously in GatePoller. Thus actions or founder-consent can pass the hook after health has become unhealthy but before the sweep retires the card. This contradicts the plan's R9 invariant that an active card is an effective, usable authorization surface. **Suggested fix:** include the current durable channel-health predicate in the injected authority decision (and in the shared activation primitive from issue 1), returning a typed non-authorizing result when unhealthy. Test a health flip after activation but before the retirement tick for all non-reaction write-capable routes; reaction handling should remain non-authorizing as well.

4. **[LOW] The acceptance matrix understates the tombstone fallback case.** §4.7 includes removal-failed plus unprovable-edge retirement/repost, but E13 lists only posting carry-forward, held carry-forward, and verified re-click. **Suggested fix:** add the explicit `removal unavailable/failed + fresh edge unprovable → retire old attempt and post a clean attempt, zero approval writes` row/case to E13 so the ship-gate evidence cannot omit it.

## Verdict

CHANGES REQUESTED — address items above
