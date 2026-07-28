# Design Review — FLY-1505 plan.md (Round 4)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

The two Round 3 issues are substantively resolved: the attempt-time head is now the authority, and reconciliation has an explicit durable settled path with a fully enumerated consumer contract. The design is feasible and close to implementation-ready, but two remaining contracts should be made explicit so the separate Implement phase cannot accidentally defeat the new head-authority rule or send a false recovery message.

## What's Good (Keep)

- The shared three-state attempt-head rule correctly distinguishes current-head, stale-head, and unknown-head completions. In particular, consuming an A-head marker against a B-head session with zero writes prevents the FLY-945 re-lap case from suppressing B.
- Centralizing marker persistence and first-attempt determination in `settleShipAttemptFailed` gives the live sinks and restart reconciler one behavioral authority.
- The reconciler's settled branch is correctly placed before normal expectation/loopback processing, writes durable evidence before unlinking the marker, and retains retryable evidence when that write fails. This closes both documented crash windows without weakening duplicate handling.
- `ReconcileOutcome` and the boot-drain success set are now explicitly updated, and T4 checks the concrete outcome plus scanned/reconciled/quarantined accounting.
- The A-marker/B-current T4 cases and the parser plus GatePoller T7 coverage materially improve protection against stale-head suppression.
- The prior-round safeguards remain sound: attempt-bound receipt polling, raw `approved_to_ship` deflection, bound-session coverage, fail-open stale-approved suppression, advisory-only alerts, and the hard FLY-1448 final-tip re-audit gate.
- Mapping the requested “25-minute job” regression to a workflow/prompt consistency test plus sink/restart integration tests remains honest and sufficient for an LLM-executed protocol.

## Issues & Recommendations

1. **[HIGH] Pin the DirectEventSink call to the completion payload's head and test the stale-attempt case at that sink.** C2(a) and C2(c) explicitly show `attemptHeadSha` coming from the event/marker payload, but C2(b) only describes the DirectEventSink behavior in prose. That omission is risky because the adjacent existing `desPrHead` calculation in `DirectEventSink.ts` is row-first (`preExistingSession.pr_head_sha` before `result.evidence.headSha`); reusing it would turn an A-attempt/B-current completion into a false B marker and suppress the current head. Add the literal helper call contract in C2(b): `attemptHeadSha` must come directly from `result.evidence?.headSha`, while `currentHeadSha` comes from `preExistingSession?.pr_head_sha`; explicitly forbid `desPrHead` for this decision. Extend T3 with a bound A-event/B-current case proving `stale_attempt`, no marker write, no alert, and preserved `approved_to_ship` status. An unknown-payload-head case there would also pin the DirectEventSink argument path.

2. **[MEDIUM] Make the unknown-head alert truthful and add regression coverage for the helper's unknown-state table.** C4 sends the advisory for both `marked` and `unknown_head_marked`, but its proposed text says same-head automatic re-wake “has been paused.” That is false for `(unknown)`, which C7 deliberately ignores and therefore leaves fail-open. Either use outcome-specific text—suppression wording only for `marked`, and explicit “head unavailable; automatic re-wake remains enabled” wording for `unknown_head_marked`—or remove the suppression claim from the shared alert. Also add focused `settleShipAttemptFailed` tests for unknown-on-empty (`unknown_head_marked`), unknown-over-real (`unknown_head_skipped`, real marker unchanged), and repeated unknown behavior, alongside the valid equal/mismatch cases. These are the core no-overwrite and fail-open guarantees and should not depend only on parser tests.

## Verdict

CHANGES REQUESTED — address items above
