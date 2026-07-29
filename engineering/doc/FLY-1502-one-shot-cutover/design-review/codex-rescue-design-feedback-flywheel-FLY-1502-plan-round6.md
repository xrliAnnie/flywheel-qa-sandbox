# Design Review — FLY-1502 plan.md (Round 6)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 6 fully resolves the backend delivery-evidence and single rollback-primitive findings. Two launch-blocking gaps remain: the claimed verbatim 0009 DDL is not yet executable or complete SQLite DDL, and the supposedly exact migration-domain predicates contradict reachable legacy states, allowing unfinished external receipts and disposed inbox rows to be misclassified.

## What's Good (Keep)

- The Claude probe now follows the real pending-sidecar → main-file → finalized-sidecar ordering and distinguishes delivered, conclusive absence, conflict, and ambiguity. The exclusive-lock plus writer-death condition makes automatic supersession fail closed (`plan.md:90-109`; `packages/agent-team-transport/src/claude/ClaudeMailboxCodec.ts:167-232`, `419-476`).
- The Codex probe selects a feasible seam: stable `clientUserMessageId` at `turn/start`, followed by strict `thread/read` reconciliation, with RPC/shape/identity failures classified as ambiguous (`plan.md:100-109`). This matches the existing `CodexTurnExecutor` precedent rather than inventing an inbox path.
- Capability consumption now has an explicit transactional order, hashes the presented raw token, recomputes a versioned full-tuple subject digest in the host, checks the attempt/activation binding, consumes once, and settles in the same transaction (`plan.md:75-89`).
- JSON overlap row 11 is correctly limited to a linked comm row in domain A; a JSON-live/comm-terminal pair now goes through row 12, retaining the comm-resolved key without discarding the live JSON record (`plan.md:285-310`).
- `rollbackGateCas` has one normative predicate definition. Step 9 and W4 reference it by name, and the test matrix requires every caller/fence to use the shared primitive (`plan.md:228-239`, `343-353`, `366-372`, `402-405`). R5-4 is resolved.
- The exact migration manifest, journal clearing, WAL-safe promotion, held-start/final-GO sequence, and machine authority safeguards remain intact.

## Issues & Recommendations

1. **BLOCKER — the “verbatim normative” 0009 DDL is still prose, and the shown SQL cannot enforce the stated binding/receipt invariants.**

   `plan.md:63-72` literally shows three bare `ALTER TABLE ... ADD COLUMN ... NULL` statements, then describes a CHECK and triggers without giving their SQL. SQLite cannot add the omitted table constraint afterward with `ALTER TABLE ... ADD CONSTRAINT`; the shown two `agents` statements therefore leave `(instance_id, session_binding)` unconstrained. The trigger semantics are also incomplete: the current 0005 trigger only prevents generation rollback (`packages/v2-kernel/src/migrations/0005-agents-config-mailbox-rebuild.ts:19-21`), while the proposed wording does not mechanically reject a generation jump, a generation increment that retains the old binding, malformed/non-version-1 `session_binding` JSON, or a non-null binding on generation 0. Similarly, “NULL→value only with running→settled” does not identify the actual allowed outcome (`succeeded`) or provide the trigger that makes a settled `processing_attempts` receipt immutable.

   The capability mapping is almost complete but still says only to check an “exact issuer” without defining the expected issuer (`plan.md:75-84`). Since the capability is minted by a recorded delivery action, its issuer must be deterministically tied to that action/successor; otherwise different implementations can accept different capability authorities.

   **Suggested fix:** put the complete 0009 SQL in the normative section (or a named checked-in schema artifact that the plan declares authoritative), including an inline CHECK on the second added binding column or insert/update triggers, strict versioned JSON validation, generation-0/null and generation+1/replacement rules, and exact `proposal_digest` transition/immutability triggers. Define `issuer` exactly, preferably as the durable delivery action ID (including the successor action after supersession). Run the real 0001–0009 migration in tests, then issue direct invalid SQL for every invariant; do not test only the typed registration/settlement APIs.

2. **BLOCKER — the exact A/B/C predicates still misclassify reachable production rows.**

   The domain-B receipt predicate requires `disposition IS NULL` (`plan.md:265-270`), but the real successful transition sets `delivered_at`, `consumed_at`, and `disposition='external_delivered'` together while deliberately leaving `processed_at` null until the receipt is handled (`packages/flywheel-comm/src/lead-inbox-queue.ts:711-748`). Consequently, every normal delivered-but-unprocessed external receipt misses B and falls into archive-only C. The delivery predicate has the same problem for quarantined obligations: `quarantineExternalDelivery` leaves `delivered_at`/`disposed_at` null but sets `disposition='delivery_quarantined'` (`lead-inbox-queue.ts:889-929`), so an unresolved ambiguous delivery also falls into C.

   Domain A says disposed-but-unconsumed anomalies go to C, but its exact predicate omits `disposed_at IS NULL` (`plan.md:259-264`). `markDisposed` sets only `disposed_at`/evidence and does not set `consumed_at` or `disposition` (`lead-inbox-queue.ts:971-1004`), so that reachable row currently satisfies A and is treated as a live inbox message. Finally, A and B do not include a production-source scope even though C declares every QA/test and top-level legacy database archive-only (`plan.md:257-275`); under the stated “A first, then B” precedence, an unread QA row matches A before it can reach C.

   **Suggested fix:** make A require `disposed_at IS NULL` as well as `processed_at IS NULL`; scope A/B to manifest entries classified as production migration sources. Define external delivery obligations from durable terminal evidence, not `disposition IS NULL`—for example, undelivered and not disposed remains an obligation, with quarantined rows blocking/manual—and define receipt obligations as delivered, not processed/disposed, and not receipt-exempt, accepting the normal `external_delivered` disposition. Make the anomaly/manual cases explicit instead of silently assigning them to archive-only C. Build fixtures through the real legacy mutators (`markExternalDelivered`, `quarantineExternalDelivery`, and `markDisposed`) plus a genuinely unread QA database, then assert each lands in the intended account exactly once.

## Verdict

CHANGES REQUESTED — address items above
