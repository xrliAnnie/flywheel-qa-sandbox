# Design Review — plan.md (FLY-1707 E5) (Round 10)

Date: 2026-08-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 10 successfully lands the five missing Round 9 protocol edits, including physical-launch receipts, marker adoption, launch-fenced invalidation, and a real state-only proof branch. The combined design is feasible, but six remaining persistence, authority, compatibility, and shadow-timing gaps would still allow schema drift, unreplayable frozen input, stale launch effects, or permanently stale rollout verdicts.

## What's Good (Keep)

- The executable V2 proof is now explicitly commit-bound to activation + owner generation + delivery attempt, with a deterministic event UID and latest-committed selection rule.
- The plan correctly recognizes the marker-first cross-store crash seam and requires marker adoption to co-write the same delivery receipt while repairing owner state.
- `frozen_replay` is now a first-class evidence kind bound to the admission/source chain rather than an implicit exception to `authoritative`.
- Delivery-caused invalidation now checks physical launch authority, closing the stale-generation T2 poisoning path identified in Round 9.
- State-only gates now have an honest proof branch with no execution, synthetic runner, or fabricated target-delivery receipt.
- The V1 table, carrier-state paragraph, and canonical union now distinguish terminal invalidity from retryable attachment preparation.
- The solution continues to reuse appropriate house patterns: append-only run events, current launch-owner fences, checked event replay, GatePoller riders, and explicit non-recoverability.

## Issues & Recommendations

1. **The claimed T2 schema CHECK is still only a SQL comment.** In the normative DDL, `-- CHECK (state != 'invalid' OR invalid_reason IS NOT NULL)` is commented out, so SQLite enforces nothing; an `invalid` row with NULL reason remains schema-valid despite the Round 10 claim. Put an actual table constraint after the column list (with the required comma), preferably also rejecting a stray reason on non-invalid states if that is the intended invariant. Execute the exact DDL under SQLite and add negative inserts for invalid/NULL plus resolver tests for NULL and unregistered legacy values—grep presence is not a schema test.

2. **`frozen_replay` promises to replay S3 body bytes that no normative durable record stores.** The baseline payload contains only `{updatedAt, bodyDigest}`, the hydration/marker candidate likewise contains only metadata/digests, and `envelope_stamped_json` is described only as an S3 stamp with no content-bearing schema. After resume admission commits but before its physical launch commits, a Bridge crash plus Linear edit leaves T3/T2 able to identify the frozen input but unable to reconstruct the body that must be placed in the resumed prompt. Define one bounded durable carrier for the exact delivered S3 body (for example, a content-bearing baseline blob or an admission-frozen blob with digest verification), its size/encoding/privacy limits, and reference semantics across W10 chains. If the body cannot be retained, mark that target non-recoverable rather than fetching new bytes. Test response loss/crash after W10 admission but before launch, then change Linear and prove replay still delivers the frozen bytes.

3. **The single baseline-slot writer is not fenced against stale physical launches.** Delivery invalidation now verifies generation/attempt, but §2.3① still lets any hydration path call `ensureWorkflowIssueBaselineTx`. If no slot exists, an expired/taken-over launch can return late and win either an old authoritative baseline or the run-wide `unavailable` outcome; the latter permanently disables recovery even though the stale launch cannot invalidate T2 or commit a runner. Give launch-originated baseline writes the same owner/generation/delivery-attempt lease and cancellation fence as delivery invalidation. State-only W1 uses a separate start/gate authority variant. Extend the takeover test to assert zero baseline-slot mutation—not merely zero T2 mutation—for stale authoritative and fallback observations.

4. **The versioned marker contract lacks an implementable preparation/authentication and backward-compatibility rule.** Current `workflowLaunchToken` binds only execution/generation/deliveryAttempt (`StateStore.ts:19286-19295`), and `readWorkflowLaunchMarker` rejects any key set other than the existing four fields (`:19298-19326`). The candidate is learned later during Blueprint hydration, after the current launch token has already been minted and passed down. Merely adding candidate fields does not authenticate them, and accepting only v2 would turn every pre-deploy marker on an active run into `marker_malformed` while the flag is off. Specify either a durable prepared-candidate record keyed by the physical launch or a post-hydration preparation step that returns a candidate-bound marker credential; adoption must compare the marker to that authority. Define dual-read migration: absent-version v1 markers retain legacy launch adoption but confer no resume evidence, while v2 markers can create `issue_delivery`. Add rolling-upgrade tests for live v1 initial/repair markers and tampered v2 candidate fields, in addition to the crash matrix.

5. **`opportunity_key = attachmentId:T2.state` can consume the only shadow opportunity before its new proof exists.** An executable attachment reaches `ready` before the physical `issue_delivery` commit (W10 is explicitly created ready), and writer liveness can change from live to dead without changing T2. The rider can therefore record a missing-delivery or writer-not-fenced verdict for `attachment:ready`; the partial unique index then prevents re-probing after receipt commit or writer death, corrupting the rollout hit-rate signal. Preserve the simple key by making the opportunity query skip executable targets until a committed receipt exists and the writer is in the recovery-relevant dead/terminal condition, or include a stable proof/lifecycle episode in the opportunity identity. Test ready-before-receipt and live-to-dead transitions and require exactly one eventual, current verdict.

6. **The canonical invalidation/V2 declarations still contradict the new state-only union.** Section 2.1 calls the execution/activation-shaped `invalidateResumeAttachmentTx(...)` the “唯一入口,” while §2.3③ later invokes the same helper without execution/activation; state-machine retry exhaustion and pre-launch attachment failures also need an attachment-reconciler authority. Immediately after the state-only branch, the common V2 tail still says a target without a writer delivery fails, which literally rejects the gate proof just defined. Replace these with one normative discriminated input type (`launch_delivery | gate_target | attachment_reconciler`) and action-specific V2 result union, then change the common tail to “missing required proof for the selected action.” Add compile-time exhaustiveness plus negative cross-kind tests so a gate cannot enter the launch form and vice versa.

## Verdict

CHANGES REQUESTED — address items above
