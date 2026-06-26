# Implementation: Founder-gate-pending auto-notify — FLY-523

**Issue**: FLY-523 ([infra] ship-ready / founder-gate-pending 不自动通知 founder)
**Date**: 2026-06-25
**Related**: FLY-579 (auto-QA pipeline — the broader "code-review pass → auto QA → notify founder" loop; 523 is the *notify* segment), FLY-368 (unified alert channel), FLY-163 (Bridge does not auto-post runner status to Discord)

## Problem

When a runner finishes — implemented + code-review-passed — it completes `--route needs_review`, the session goes to `awaiting_review`, and it posts a non-blocking `approve_to_ship` gate question. Today the founder only learns about this if the **Lead remembers to relay** the pending question (GatePoller delivers it to the Lead's mailbox **once**). If the Lead forgets, the finished work sits silently in `awaiting_review` forever — the founder has to *ask* "is anything waiting for me?" (Annie's example: FLY-349 render sat after it was done). `HeartbeatService.checkAwaitingReviewTimeout` only fires at **48h** and escalates a `gate_timed_out` — far too late, and still routed through the Lead.

This is "靠纪律不靠机制" — the founder-notify depends on Lead discipline, not on a mechanism.

## Approach

Notify the founder **directly** (her Discord, not via the AI-Lead relay) the moment a run is founder-gate-pending, reusing the FLY-368 unified alert channel.

- **Signal** = `session.status === "awaiting_review"` (the canonical "waiting for the founder to approve the ship" state). Anchored on the persisted `awaiting_review_entered_at`, which survives Bridge restarts and is re-stamped on a re-review.
- **Delivery** = `LeadAlertNotifier` (the FLY-368 unified "founder action needed" channel + send-chain). A new `AlertEventType` value `"founder_action_needed"` is added. The alert posts via the project Lead's own bot to the channel the founder watches — **no dependence on the Lead relaying**.
- **Dedup + reliability** = entirely owned by `LeadAlertNotifier` (claims.db cross-process claim + `lead_events` UNIQUE + queue / dead-letter / drain). The eventId is window-keyed: `founder-gate-pending:${execId}:${awaiting_review_entered_at}:${review_question_id}`. It fires **once per review window**; a re-review re-stamps `awaiting_review_entered_at` AND binds a fresh `review_question_id` → new eventId → re-notifies (correct: the work is ready again). Both parts are combined because `awaiting_review_entered_at` is only SQLite second-precision — a feedback → re-request cycle inside the same second would otherwise collide on the timestamp and suppress the re-notify (Codex R1 MEDIUM); the bound `review_question_id` (fresh uuid per `needs_review` completion) disambiguates same-second re-reviews.
- **Driver** = a new `HeartbeatService.checkFounderGatePending()` called on the **existing** heartbeat timer (no new periodic load — FLY-169/172 norm). Latency = one heartbeat interval (seconds–a minute), a massive improvement over "never / 48h".

### Why a periodic sweep (not an immediate emit in event-route)

The sweep is idempotent (stamp-keyed dedup in the notifier), survives a Bridge restart (catches any `awaiting_review` session that was never notified — including a one-time catch-up for runs already waiting at deploy time), and catches *every* entry path into `awaiting_review` without threading a hook through the multi-branch event-route logic. The latency cost (one heartbeat tick) is irrelevant for a founder who is otherwise told *nothing*.

## Changes

| File | Change |
|------|--------|
| `packages/teamlead/src/LeadAlertNotifier.ts` | Add `"founder_action_needed"` to `AlertEventType`. |
| `packages/teamlead/src/LeadWatchdog.ts` | Add the exhaustiveness `case` to `titleFor` / `bodyFor` (LeadWatchdog never emits this type — mirrors the `runner_stuck_unhandled` precedent). |
| `packages/teamlead/src/StateStore.ts` | `getAwaitingReviewSessions()` — all `awaiting_review` sessions (no age threshold). |
| `packages/teamlead/src/HeartbeatService.ts` | `FounderGateNotifier` interface + optional field + `setFounderGateNotifier()` setter + `checkFounderGatePending()` (called in `check()`). No-op when no notifier is wired. |
| `packages/teamlead/src/FounderGatePendingNotifier.ts` | New. Resolves the project Lead, builds the window-keyed `founder_action_needed` `AlertPayload`, calls `LeadAlertNotifier.alert()`. Owns no state. |
| `packages/teamlead/src/bridge/plugin.ts` | Wire `FounderGatePendingNotifier` into `HeartbeatService` after `LeadAlertNotifier` is constructed. Gated by `FLYWHEEL_FOUNDER_GATE_NOTIFY` (default ON; `=0` hard-disables → byte-compat). |

## Config / rollout

- **Default ON** (Annie's explicit ask: "机制层应自动化"). `FLYWHEEL_FOUNDER_GATE_NOTIFY=0` is the kill switch (HeartbeatService is left without a notifier → `checkFounderGatePending` is a no-op → byte-identical behavior).
- Requires an alert channel to actually reach the founder: in production the FLY-368 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` is set. With no channel configured the alert dead-letters (logged + meta-alert) rather than spamming the wrong place.
- **Severity** `warning` → prominent in the unified channel, no DM-spam (only `severe` DMs `alertDmUserId`). Dialing it up to a DM ping is a one-line follow-up if Annie wants device pings.
- **Bridge-side change** → takes effect on the next Bridge restart (Lead-coordinated). First restart after deploy does a one-time catch-up notify for runs already in `awaiting_review`.

## Scope

v1 covers the dominant, well-defined case Annie named: **ship-approval pending** (`awaiting_review`). Other "founder decision pending" gates (e.g. a `gate question` awaiting a founder call) are out of scope here and can extend the same mechanism later.

## Tests

- `StateStore.test.ts` — `getAwaitingReviewSessions` returns only `awaiting_review`.
- `HeartbeatService.founder-gate.test.ts` — notifies once per awaiting_review session; no-op (and does not touch the store) when no notifier is wired (byte-compat); one failure doesn't stop the rest; `check()` drives it.
- `FounderGatePendingNotifier.test.ts` — `founder_action_needed` payload routed to the project Lead; window-keyed eventId (stable within a window, changes on re-review); skips quietly on unresolved project/lead; never throws on `alert()` rejection.
