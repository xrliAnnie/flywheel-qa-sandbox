# Design Review — FLY-1251 plan.md (Round 6)
Date: 2026-07-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

All four Round-5 corrections are present in the normative plan, and the single activation primitive now closes the live-versus-reconcile divergence. One new safety flaw remains in the quarantine state machine: a per-attempt row that can only move monotonically to `cleared` cannot represent a second rejected reaction episode on the same card. The channel-health check also needs a concrete durable backing contract before the plan is executable across restarts.

## What's Good (Keep)

- `tryActivatePostingCard` is now explicitly the only `posting → active` transition and is shared by live send and reconciliation. It rechecks channel health, gate pending state, and head identity immediately before CAS, with predicate-specific retirement.
- The POST ambiguity contract remains correct: accepted-then-timeout, connection loss, 5xx, and an unparseable success body stay identity-unresolved until a complete nonce scan proves found or absent.
- The quarantine write is correctly ordered before reaction removal, read-back, founder response, and response marker. Crashes after that first durable write remain on the non-authorizing side.
- USE-time channel health is now part of `assertActiveCardAuthority`, closing the health-flip-before-sweep window in the intended design.
- Current FLY-1244 source confirms that the shared writer already performs a live hold check. The plan accurately preserves that guard and requires the future seam to widen `ReviewHoldReason` and classify the two new reasons as reject rather than defer.
- The FLY-1244 seam is still absent on the sibling branch, and the plan continues to state that honestly as a pinned-commit prerequisite for §4.3 rather than silently crossing the forbidden file boundary.

## Issues & Recommendations

1. **[HIGH] The quarantine row cannot be re-armed for a second blocked reaction episode.** The DDL primary key permits one row total per `(card_attempt_id, founder_id, emoji)`, while the only allowed transitions are `blocked → absent_seen → cleared` and blocked handling is `INSERT or no-op if exists`. Consider: a held click creates `blocked`; verified removal moves it to `absent_seen`; the founder re-adds the reaction while the hold is still active; the blocked handler's insert is a no-op; removal now fails; after the hold clears, that hold-time reaction appears as `absent_seen → present` and can authorize. A crash after `cleared` but before the approval write followed by a new hold has the same problem—the row can never return to `blocked`. **Suggested fix:** make monotonicity apply per rejection episode, not per card attempt. Either add an episode/version dimension with at most one open episode, or use a versioned re-armable row where every blocked observation CASes `absent_seen|cleared → blocked`, increments the version, and resets episode timestamps; already-`blocked` observations remain idempotent. Every absent/clear CAS must include the expected version. Specify that reaction authorization requires a present observation that cleared the current episode, followed by the writer's existing live hold recheck. Add tests for re-add while still held, two late-hold cycles on one card, and crash after clear before write followed by a new hold.

2. **[MED] “Current durable channel health” has no durable state or recovery contract.** §4.3 now reads a durable health predicate, but §4.5 and the DDL define no key, table/columns, update API, unhealthy latch, or verified recovery transition for the consecutive reaction-read failures. Current source keeps reaction throttles/watchdog episode state in memory; it does not provide this persisted authority input. An active card survives Bridge restart, so an in-memory unhealthy episode can be forgotten and actions/founder-consent can pass before new failures accumulate or the sweep runs. **Suggested fix:** define the StateStore representation keyed to the stable approval channel identity, atomically persist failure count/state/reason, latch unhealthy at the threshold, and clear it only after a defined successful reaction read/probe. Store-read failure must itself make activation/authority fail closed. Require `tryActivatePostingCard`, `assertActiveCardAuthority`, and the channel-down sweep to call the same predicate, and test restart both below and above the threshold plus verified recovery.

3. **[LOW] E13 still does not enumerate the two newly claimed acceptance cases.** The E13 row on disk omits both the health-flip-before-sweep case and `removal unavailable/failed + edge unprovable → retire/repost`; the latter appears only in §4.7, while the former appears only in §4.3 prose. **Suggested fix:** add both to E13, together with the repeated-quarantine-cycle cases from issue 1, so the QA matrix—not scattered prose—is the authoritative ship evidence checklist.

## Verdict

CHANGES REQUESTED — address items above
