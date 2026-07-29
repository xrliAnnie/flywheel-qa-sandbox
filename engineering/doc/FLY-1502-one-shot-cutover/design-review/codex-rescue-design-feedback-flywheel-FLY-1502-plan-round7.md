# Design Review — FLY-1502 plan.md (Round 7)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 7 fixes the major legacy-state mistakes in the A/B/C partition and provides syntactically executable 0009 SQL. The review still finds two launch-critical specification gaps: the triggers accept states that the prose calls impossible, and the “exact” receipt-obligation predicate omits its external-carrier fence and current exemption authority.

## What's Good (Keep)

- Source scope now precedes all state predicates, so QA/test and top-level legacy databases cannot leak into the migration set merely because they contain unread rows (`plan.md:299-309`).
- Domain A now excludes both processed and disposed inbox rows, matching the fact that `markDisposed` can set `disposed_at` without setting `consumed_at` or `disposition`.
- Domain B now recognizes the real `external_delivered` state and treats `delivery_quarantined` as blocking manual rather than archive-only (`plan.md:310-321`).
- The plan requires the domain fixtures to use real legacy mutators rather than hand-shaped rows (`plan.md:326-328`). This is the right way to prevent another schema-versus-runtime predicate mismatch.
- The capability issuer is now deterministically the durable delivery action ID, including successor actions (`plan.md:112-114`).
- The 0009 block uses legal SQLite constructs and preserves the 0005 generation monotonicity trigger. A direct SQLite probe confirmed that the DDL itself parses and installs.
- The backend reconciliation, settlement ownership, promotion sequence, journal account, authority file, and `rollbackGateCas` contracts remain coherent.

## Issues & Recommendations

1. **BLOCKER — the executable 0009 triggers still do not enforce the invariants claimed immediately below them.**

   The update guard permits `generation=OLD.generation+1` while retaining the exact old `instance_id` and `session_binding`; it only checks that both remain non-null (`plan.md:82-97`). This contradicts the stated requirement that generation advancement replace the binding (`plan.md:106-108`). The JSON checks are also not “strict”: they verify only `v` by value and the presence of five paths. They accept wrong JSON types, empty identities, extra keys, and values such as a string PID or object `pid_start`.

   The processing-attempt trigger has two receipt holes (`plan.md:98-104`). It is an UPDATE-only trigger, so a running row can be inserted with a pre-populated digest. It also permits `running→succeeded` with `proposal_digest` still null, even though that digest is the durable retry receipt. A direct SQLite probe using the plan's SQL accepted all four counterexamples: loose/wrong-type JSON, generation advancement with an unchanged binding, a running INSERT with a digest, and success settlement without a digest.

   There is also an upgrade-state ambiguity: adding nullable columns to a populated 0008 database leaves existing generation≥1 agents with null bindings because triggers are not retroactive, while the text calls generation≥1/null invalid and elsewhere says old rows are backfilled to null (`plan.md:168-177`). The migration must choose and test one policy.

   **Suggested fix:** make the guards match the prose exactly. Require a generation+1 update to change the binding tuple; validate JSON key set, `json_type`, non-empty identities, PID domain, and the frozen `pid_start` representation. Add an INSERT guard for `processing_attempts` requiring `outcome='running'`, `settled_at IS NULL`, and `proposal_digest IS NULL`; require a successful transition to set both `settled_at` and a non-null canonical digest, while failed/crashed transitions retain a null digest. For pre-0009 agents, either reject non-empty upgrades because production supports fresh staging only, or explicitly grandfather null bindings and define the mandatory register-only remediation. Add the populated-0008 upgrade case to the direct-SQL matrix.

2. **BLOCKER — the receipt-obligation predicate is still not exact SQL and can select the wrong carrier.**

   The delivery predicate explicitly starts with `carrier='external'`, but the receipt predicate at `plan.md:316-318` omits that condition. Legacy inbox delivery also sets `delivered_at` while `processed_at` can remain null (`packages/flywheel-comm/src/lead-inbox-queue.ts:1358-1366`), so the literal predicate can count ordinary `carrier='inbox'` rows as domain-B external obligations. Because this section declares its predicates normative and exact, the external restriction cannot be left implicit from the heading.

   “No corresponding receipt exemption record” is also ambiguous. The runtime's current-state authority is `lead_inbox.receipt_exempt_reason IS NULL`; the audit table is append-only history, and production eligibility queries use the row column (`lead-inbox-queue.ts:721-728`, `1326-1330`). An implementation that searches for any historical audit record can classify a different set.

   **Suggested fix:** write the full receipt predicate as SQL, including `carrier='external'` and `receipt_exempt_reason IS NULL` (plus the existing delivered/processed/disposed terms). State separately that the exemption audit row is evidence to validate, not the current-state predicate. Add a negative fixture for a delivered-but-unprocessed `carrier='inbox'` row and an exempt external row, both constructed through real APIs.

## Verdict

CHANGES REQUESTED — address items above
