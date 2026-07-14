# Design Review — plan.md (Round 2)
Date: 2026-07-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 is a substantial improvement. The updated plan closes the architectural shape of most Round 1 findings: admission-time snapshot pinning is now explicit; the preselected edge token is correctly replaced by a node-attempt decision capability; the red-test cutover no longer depends on claim presence; event/projection updates share a transaction; dispatch has a durable intent state machine; FLY-1224 is a hard dependency; the parked-commit conflict has a net-tree integration strategy; and the PR chain now has typed enrollment and separate write/read/revert controls.

The plan still needs changes before implementation. Two security/durability boundaries remain unresolved in the actual architecture: a `0600` runner-state file is not session-private when all runner shells execute as the same Unix user, and a StateStore-side outbox cannot be atomic with an authoritative write made in project CommDB. Product v1 also promotes `workflow_node_outputs` into trusted git writes without defining an attempt-bound authorization and materialization contract. Finally, several old tables/examples/acceptance lines still directly contradict the new rules, including an invalid same-vendor seed example.

These are bounded follow-ups; the founder-decided product direction does not need to be reopened.

## What's Good (Keep)

- Keep the single admission-time version rule. The pinned effective snapshot now governs dispatch, retry, and reconcile, with live controls limited to named safety switches.
- Keep the decision capability bound to run/node/execution/attempt and predicate family, followed by one transactional verify → subject capture → claim → legal-edge selection → capability consumption → event/projection update.
- Keep validation before event insertion and a dedicated decision endpoint. This correctly removes the current `/events` “persist first, authorize later” weakness.
- Keep exact-retry idempotence and conflicting-replay refusal. That preserves marker recovery without weakening one-attempt authority.
- Keep the durable three-stage discriminator for the unchanged FLY-1204 test and the explicit fail-closed re-QA policy for in-flight phases. This is the right exception to legacy byte compatibility.
- Keep the normalized `{claude, codex}` review-family policy derived from the resolved execution, plus admission and claim-time enforcement. The new intended eng lineup is internally valid.
- Keep the event sequence/projection transaction, attempt-keyed run-node rows, reserved execution id, and `intent_recorded → launch_committed → started` reconcile model.
- Keep the corrected founder-guard inventory and FLY-1099 defer/reject semantics. The plan now targets real write boundaries instead of accurate dependency comments.
- Keep append-only publication records, CAS publication, immutable manifest bytes, idempotent seed import, and stale-edit rejection.
- Keep `generic` as `no_code` and move docs-branch writing into a trusted engine component; do not add a template-controlled capability escape hatch.
- Keep the path/hunk integration matrix and the final combined-tree test requirement for the parked FLY-1204 work.
- Keep the recut PR chain and expanded fault matrix. They are now aligned with Gate A before Gate B and with FLY-1224 as a true prerequisite.

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[BLOCKER] The document still contains mutually exclusive normative contracts.**

   **Issue:** The new rules were added, but the old ones were not consistently replaced:

   - Section 1 still defines the credential as bound to `(run, edge, attempt, subject)`, while Section 2.2 correctly says it must not bind an edge.
   - The Section 2.1 claim table still has `edge_token_id` and omits `decision_kind`, `attempt`, server sequence, `expires_at`, `issuer_kind`, and `subject_producer_execution_id`; Section 3.1b again says a node writes with an edge token.
   - The loop text still says each round gets a new “edge token.”
   - E3 says every old-token replay fails, while Section 2.2 requires exact same-payload replay to return idempotent success.
   - The edit matrix still says scalar changes are immediate “派发时读,” while the next paragraph says they affect only the next admitted run.
   - `workflow_template_revision` still carries mutable draft/published status, while the new contract moves publication into an append-only publication row.
   - The storage summary and “six tables” note omit the new capability, publication, node-attempt, output, binding, and outbox/projection structures.
   - The “v1 seed” example still uses Claude/Fable Implement with Claude/Opus QA and `run_42` pins that v1, contradicting the exact valid seed declared in Section 3.1. The top-level “逐字等价” acceptance also remains unscoped even though Section 3.1 correctly limits equivalence to orchestration behavior.

   **Why it matters:** These are not harmless historical notes. They govern DDL, capability issuance, admission, Dashboard behavior, and executable acceptance. Different PR owners can implement opposite contracts while each can point to plan text.

   **Suggested fix:** Make one terminology/schema cleanup pass before coding. Replace every edge-token reference with decision capability terminology; make Section 2.1 the complete canonical claim schema; update E3 to distinguish exact idempotent retry from expired/old-attempt/conflicting reuse; update the edit matrix; add every authoritative table to the storage inventory; remove `status` mutation from revision rows or clearly mark a constrained pre-publication draft store; and replace the v1/run example with the valid Codex-Implement seed. Scope the total acceptance line to orchestration equivalence plus the intentional vendor delta. Add a grep-style doc sentinel that rejects obsolete `edge_token`, “即时(派发时读),” and the invalid seed combination.

2. **[BLOCKER] A permission-restricted runner-state file is not a private capability channel in this runtime.**

   **Issue:** Claude/Codex/other runners are co-resident processes under the same Unix account. Mode `0600` or `0700` excludes other OS users, not another runner under the same user, and an unguessable filename can still be discovered by directory enumeration. The existing FLY-245 `secret-broker.ts` states this threat model explicitly: the model can read any file the Unix user can read, so a secret that touches the filesystem is burned; its boundary is memory-to-memory delivery plus sandbox denial of Unix-socket `connect()`. The updated plan instead places the raw capability in a runner-state file. Current `qa-result-failed` markers also persist the full submission body and do not set restrictive modes, so simply adding a token to that body would leak it further.

   **Why it matters:** The capability is intended to prove that runner A cannot submit a verdict for runner B. If A can enumerate and read B’s token file, the redesign retains the same cross-run forgery class as the shared bearer, only with more steps.

   **Suggested fix:** Define the adversary and a channel that isolates **same-user runner processes**. Reuse the FLY-245 principle, not just its directory convention: keep the secret in Bridge/parent memory and give the authorized session a non-exportable submission path, such as an inherited descriptor/helper or a broker whose connection is prevented for model shells and whose caller is bound to the reserved execution. Claude and Codex need separately proven paths because their sandbox/connect behavior differs; fail admission for any backend without a proven path. The CLI/marker should persist an opaque idempotency request or encrypted/Bridge-held reference, never the raw capability. Add a real-machine negative test: runner A, knowing B’s execution id/head and able to enumerate `~/.flywheel`, still cannot produce or replay a valid B decision.

3. **[BLOCKER] Claim resolution and retry identity still permit divergent implementations.**

   **Issue:** “Take the highest valid attempt” can fall back to an older PASS when the newest attempt is expired or revoked: after filtering invalid rows, the older attempt becomes the highest valid one. The same paragraph says expiry must fail closed, which implies the opposite algorithm. Exact same-payload idempotence also lacks a persisted canonical submission digest/request id, and “server captures subject” does not identify the authoritative subject resolver for each decision kind (reporter worktree, producer execution worktree, PR head, or materialized docs head).

   **Why it matters:** Falling back to stale PASS evidence reopens the ship bypass. Payload equality based on ad hoc JSON comparison will disagree across clients/retries. Capturing the reporter’s head instead of the target producer’s head can produce a cryptographically authorized claim over the wrong artifact.

   **Suggested fix:** Resolve the maximum attempt/decision sequence for the current decision family and subject **before** validity filtering, then require that exact decision to be unexpired, unrevoked, non-conflicting, and passing; never fall back to an older attempt. Persist a canonical `submission_digest` and client request id so consumed-capability replay has one deterministic comparison. Put a `subject_resolver` in the core decision/evidence schema, with Bridge deriving the authoritative worktree/PR/materialization from run and execution records; runner-provided subject remains comparison-only. Bound heartbeat extension by the node’s absolute timeout/deadline so a compromised live session cannot renew forever. Add these rules to E2/E3 and the acceptance matrix.

4. **[BLOCKER] The proposed cross-database outbox is on the wrong side of the authority boundary.**

   **Issue:** The plan keeps `three_stage_turn` and founder responses authoritative in project CommDB, then says StateStore writes a transactional outbox/projection request. A StateStore transaction cannot be atomic with the preceding authoritative CommDB write. A crash after CommDB commit but before StateStore enqueue still loses the projection request. Founder responses are append-only and can be rediscovered by a sweep, but `grantTurn` currently overwrites one row and increments an epoch; missed intermediate TURN transitions cannot be reconstructed from the final row.

   **Why it matters:** This leaves the exact half-write gap Round 1 asked the outbox to close and can make the supposedly authoritative run-event history omit a writer handoff. Dual-read does not repair missing audit history by itself.

   **Suggested fix:** Put a stable source event/outbox row in the **same CommDB transaction** as each authoritative response/TURN mutation, then let a projector idempotently append to StateStore using `(project, source_event_id)`. For TURN, preserve an append-only source history rather than relying only on the mutable current-holder row. If modifying CommDB transaction boundaries is intentionally deferred, explicitly downgrade StateStore events to a rebuildable current-state projection and specify a full sweep/cursor that guarantees discovery; do not call it a transactional outbox. Define the versioned dual-read exit criterion, the eventual authority after cutover, and crash tests proving both current authority and historical ledger survive every boundary.

5. **[BLOCKER] `workflow_node_outputs` and the trusted docs materializer need their own authority and transaction contract.**

   **Issue:** Product v1 now relies on runner-written structured outputs that Bridge validates and commits to a docs branch, but the plan does not bind output writes to run/node/execution/attempt, protect the `workflow-output` channel from the same shared-bearer forgery, or define the materializer’s validation and crash semantics. The PRD’s old `(run_id,node_id)` upsert also lets a late stale attempt overwrite a newer attempt’s artifact.

   **Why it matters:** A different runner could forge or replace a product artifact that the trusted Bridge then writes with repository credentials. Path traversal, symlink targets, oversized payloads, duplicate materialization, concurrent docs-branch writers, or a crash after commit/before event can produce an unreviewed subject or make review/founder claims refer to a different commit.

   **Suggested fix:** Add an output-write capability (or an explicitly scoped operation on the node-attempt capability) bound to run/node/execution/attempt and an output schema/digest. Store outputs by `(run_id,node_id,attempt)` and promote only the current legal attempt transactionally; stale attempts cannot overwrite. Define schema/size/path allowlists, canonical serialization, server-derived repo/branch, symlink/traversal rejection, branch serialization/TURN ownership, and content-addressed idempotency. Give materialization the same intent/commit/reconcile state machine as dispatch. Make the product order explicit: accepted Produce output → one materialized/pushed head → Design Review claim for that head → Founder claim for the identical head; any rematerialization invalidates review and starts a new attempt. Extend S11–S16 and the fault matrix with forged output, stale-attempt output, materializer crash, and concurrent materializer tests.

## Verdict

CHANGES REQUESTED — address items above
