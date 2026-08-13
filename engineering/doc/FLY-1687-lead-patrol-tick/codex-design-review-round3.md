# Design Review — plan.md (FLY-1687) (Round 3)

Date: 2026-08-13
Author: Codex
Status: APPROVED

## Summary

Round 3 closes all remaining blockers: settlement now distinguishes true append→enqueue gaps from archived terminal receipts, every dispatch is reconstructed from the durable journal winner, and roster-derived text is constrained to a bounded single-line representation. Together with the Round 1 fixes already retained, the plan is feasible in the current architecture, restart-safe, hot-adjustable, mailbox-first, and ready to implement without a new flag or timer.

## What's Good (Keep)

- The `absent_identity | live(state) | archived_terminal` contract matches the actual mailbox lifecycle: only a genuinely unreserved identity is replayed, while an archived ACKED/DEAD row remains settled and preserves cadence continuity after the 72-hour live-row retention window.
- The dedicated archive tests cover both important long-gap cases—zero runners followed by reappearance and Bridge downtime across retention—and require the next chained tick rather than accepting a vacuous no-op.
- Reading the persisted `lead_events` row after every append and rebuilding through `leadEventEnvelopeFromJournalRow()` makes payload, content, seq, session key, and timestamp authoritative and byte-stable. UNIQUE plus the journal now closes the producer race structurally; the in-flight guard is correctly reduced to load shedding.
- The adversarial two-producer test is non-vacuous: different in-memory roster/time inputs must converge to the journal winner without a mailbox projection conflict, and the second enqueue must be idempotent.
- The roster renderer now treats status as a closed set and bounds identifier/role to a canonical single line, preventing dynamic ledger text from adding template lines or smuggling control characters into the patrol body.
- The fixed patrol body remains shared across Mailbox and CommDB runtimes, while the FLY-1573 batch header/ACK instruction is explicitly treated as transport framing and verified separately.
- Exact `session_key` scoping, SQLite UTC parsing, settlement-time cadence, per-project atomic config snapshots, snapshot-bound warning behavior, and mainline-only project config reads remain intact.
- Extending `runner-patrol-rules.md` continues to be the smallest correct Lead-side change: it preserves existing wiring and guard anchors while keeping every actual patrol decision on independent sources.

## Issues & Recommendations

1. **No blocking issues.** Implement the three-state settlement reader as a read-only API owned by `flywheel-comm` / `MailboxQueue` (or an equivalently encapsulated seam exposed through `LeadInboxRuntime`), rather than issuing raw mailbox-schema SQL from `patrol-tick.ts`. The current public `getById()` alone cannot distinguish a true absent identity from an archived terminal row or expose its terminal timestamp; the plan's typed result must remain the contract.

2. **Implementation guardrail:** make the single-line canonicalizer fail closed for values outside the accepted identifier/role grammar—for example, substitute a visibly escaped bounded token—rather than merely deleting CR/LF. Keep the malicious directive-word fixture and whole-body deny-list together so the test proves both structural single-line safety and the founder's no-directive invariant.

## Verdict

APPROVED — ready to implement
