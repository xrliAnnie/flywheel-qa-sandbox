# Design Review — FLY-1502 plan.md (Round 5)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 5 closes the exact migration-manifest requirement and carries the Codex journal account through the stop, snapshot, archive, and Go/No-Go paths. The plan is materially stronger, but three launch-critical contracts remain underspecified or non-total against the current code: backend delivery evidence, the exact 0009/capability representation, and the migration-domain partition; the rollback primitive is also still duplicated despite being declared single-source.

## What's Good (Keep)

- The ordered migration ID+checksum manifest ending at 0009 is now a shared prerequisite for create, promote, backup/open, and Go/No-Go, with an explicit 0001–0008 rejection fixture across all five readers (`plan.md:38-44`, `216-228`, `408-411`). This closes R4-1's version-skew hole without modifying 0001–0008.
- The hold-until-settlement IPC boundary is coherent: the host computes the canonical digest, commits mailbox application and processing-attempt settlement before replying, and retries compare against the settled row (`plan.md:53-71`). Crash-after-settlement-before-response now has a durable answer.
- Step 8a provisions addresses only, while registration/reattach waits for a real session at 8b; generation-scoped null binding and absence-evidenced replacement are stated consistently (`plan.md:45-47`, `101-113`).
- The migration input, unfinished external obligations, and archive population are now named as separate accounting domains, and journal obligations have a dedicated zero gate (`plan.md:232-243`, `304-306`).
- Every journal path is now present in the target manifest, lsof stop proof, WAL-safe snapshot, archive/fence step, and named Go/No-Go evidence. R4-7 is resolved.
- WAL-safe promotion, two founder decisions, held-start probing, zero-old-write post-start acceptance, and the no-effect T1 boundary remain intact.

## Issues & Recommendations

1. **BLOCKER — R4-3 is not yet an executable, fail-closed delivery-reconciliation contract for either backend.**

   The plan says Claude checks whether an envelope is present in the main inbox/sidecar and Codex performs an “equivalent inbox-path check” (`plan.md:77-84`). Codex has no inbox path in this runtime: its exact session reference contains only `socketPath` and `threadId` (`packages/v2-engine/src/injection/session-ref.ts:11-16`, `82-100`), and the current shim merely calls `turn/start` without a stable `clientUserMessageId` (`packages/v2-engine/src/injection/codex-shim.ts:54-75`; `packages/claude-runner/src/codex-daemon-client.ts:499-512`). A usable precedent exists in `CodexTurnExecutor`: it sends `clientUserMessageId` and reconciles with `thread/read` (`packages/teamlead/src/lead-backends/codex/CodexTurnExecutor.ts:114-148`, `173-188`, `273-322`), but the plan does not select or specify that seam. Treating an RPC error, malformed response, or unsupported read as confirmed absence would permit a duplicate turn.

   Claude also needs a precise truth table. Its writer first appends a `pending` sidecar record, then writes the main file, then finalizes the sidecar (`packages/agent-team-transport/src/claude/ClaudeMailboxCodec.ts:167-232`); a pending sidecar alone explicitly does not prove that the main write landed (`:186-195`). The existing probe validates a pending record against the exact main entry and fingerprint before repairing it to finalized (`:419-476`). “Present in main/sidecar” is therefore too coarse to distinguish delivered, absent, conflict, and ambiguous.

   **Suggested fix:** freeze the concrete probe for each backend. For Codex, extend the v2 daemon client to submit a stable delivery correlation ID as `clientUserMessageId`, expose `thread/read`, and require a strict matching parse; RPC/shape/identity failures are `ambiguous`, never `absent`. For Claude, specify the sidecar/main/fingerprint state table and the exclusive-lock/writer-death precondition under which absence is conclusive; reuse the existing pending-record repair semantics. Add fixtures for every evidence state, not only the two crash locations.

2. **BLOCKER — migration 0009 and the proposal capability do not yet define one implementable storage/fence contract.**

   Section 2.2 says 0009 adds “consumer binding columns” for `instance_id` and “host_epoch/session identity,” while section 9 calls these exactly two columns (`plan.md:101-110`, `408-411`). It never fixes their exact names, types, encoding, null-totality rule, or DDL enforcement for same-generation immutability versus atomic generation advancement. That matters because the current `agents` table has only a monotonic-generation trigger (`packages/v2-kernel/src/migrations/0005-agents-config-mailbox-rebuild.ts:3-21`); the new reattach guarantee cannot be inferred from it. Likewise, `proposal_digest` lacks its success/null and immutability constraints even though the settled row is now the authoritative receipt.

   The capability mapping is internally incomplete. The plan stores `subject_digest=canonical({attempt_uid,message_uid})`, `attempt_generation=generation`, and an unspecified “agent identity” audience (`plan.md:63-74`), but then claims the token itself binds `instance_id` and, for runners, `activation_id`. The existing capability row has no dedicated instance or activation columns (`packages/v2-kernel/src/migrations/0001-base-schema.ts:129-142`), and `FENCE.capabilityConsume` checks action/audience plus optional task/generation—not token hash, subject digest, instance, message, attempt UID, or activation (`packages/v2-kernel/src/fence.ts:183-193`). Those checks can be composed around the CAS, but the normative plan must say exactly how.

   **Suggested fix:** make 0009's exact DDL normative: column names/types, versioned binding encoding if composite, null-all-or-none constraints, generation-scoped update triggers/CAS, and `proposal_digest` outcome/immutability rules. Define the complete capability field mapping and transaction order, including lookup by raw-token hash, exact issuer/audience/subject/generation checks, and the processing-attempt/activation joins that complete the binding before `capabilityConsume`. Either include the full tuple in a versioned `subject_digest` or explicitly state that the capability row plus named binding queries jointly constitute the token binding. Add direct DDL-negative fixtures and stale-instance/stale-activation token tests.

3. **BLOCKER — the three migration domains and overlap table are still not constructively disjoint and total.**

   Domain A includes every `lead_inbox` row with `carrier='inbox' AND consumed_at IS NULL`, while domain C separately includes `processed/disposed` rows (`plan.md:232-243`). The legacy schema enforces that processed and disposed are mutually exclusive, but it does not make either imply `consumed_at`; `markProcessed` can set `processed_at` without setting `consumed_at` (`packages/flywheel-comm/src/lead-inbox-queue.ts:387-415`, `932-968`). Such a row matches both A and C. Domain B also says only “external nonterminal,” but a delivered external row is consumed while it can still have an outstanding unprocessed receipt (`markExternalDelivered`, `lead-inbox-queue.ts:711-748`), so “terminal” needs an exact predicate rather than an implementation interpretation.

   Row 11 has a separate loss case: any unread JSON row linked to a comm row is declared an overlap copy and inherits the comm classification (`plan.md:253-255`, `276`). It does not require that the comm row itself belongs to domain A. If the linked comm row is read or terminal in domain C while the JSON main-file row remains `read=false`, the JSON row is the only live input; treating it as an overlap has no canonical domain-A row to classify and can drop it from conservation. Step 2 also still references deleted “table row 2” (`plan.md:175`).

   **Suggested fix:** publish exact, mutually exclusive SQL/state predicates for all `lead_inbox` combinations. At minimum, exclude processed/disposed rows from A (or make an explicit invariant failure), define external unfinished as the exact union of delivery and receipt obligations, and make C the complement after A/B. Restrict row 11 to a linked comm row that is itself in domain A; when the linked comm row is in C, preserve the inherited key but classify the unread JSON as a JSON-only live row. Add fixtures for processed-but-unconsumed inbox, delivered-but-unprocessed external, and unread JSON linked to a read/terminal comm row, then assert each raw record enters exactly one domain/account.

4. **HIGH — `rollbackGateCas` is declared single-source but the plan still contains independent predicate copies and unnamed consumers.**

   Section 4.7 says step 9, W4, tests, and the runbook must reference `rollbackGateCas` and must not restate its predicate (`plan.md:309-317`). Step 9 nevertheless repeats the full predicate instead of naming the primitive (`plan.md:203-214`); W4 points indirectly to section numbers (`plan.md:332-337`), and the test matrix names `rollback-t1` but not the primitive (`plan.md:367-368`). The copies currently agree, but this is precisely the drift surface R4-6 intended to remove.

   **Suggested fix:** retain the predicate only at the primitive's normative definition. Replace step 9, W4, the CLI verb table, tests, and runbook wording with calls/references to `rollbackGateCas`, and add a source-level assertion that rollback CLI and every external-effect fence import/use the same kernel primitive.

## Verdict

CHANGES REQUESTED — address items above
