# Design Review — FLY-1251 plan.md (Round 11)
Date: 2026-07-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 11 correctly bounds the successful boot-retirement path, defers boot-time reposting until production is enabled, and lands the previously missing checklist edits. Two lane-isolation edge cases remain: a failed retirement is not actually a terminal drain outcome, and a successfully retired unhealthy lane can immediately enter an unbounded post/retire loop because channel health is checked only after Discord POST.

## What's Good (Keep)

- Persistent startup read failures now have a bounded, pure-DB retirement path that does not depend on the broken Discord operation succeeding.
- `boot_reconcile_unresolved` keeps the old message in the retired observation set, preserving stale-click response duties after recovery.
- Boot-time 404 and configuration drift now invalidate only; the normal pending-gate scan owns the later repost after production is enabled.
- The runtime and boot contexts are explicitly distinguished in the 404 outcome table, eliminating the Round-10 producer-exclusion ambiguity.
- The `retire_reason` contract, §4.7 boot suite, and PR-2 file list are now present on disk.
- Same-boot lane/card poison remains part of activation, USE-time authority, reaction processing, and sweeping.
- The incident evidence predicate, docs-only classification, attempt state machine, quarantine episodes, and six-route authority matrix remain technically coherent.
- The FLY-1244 branch still lacks the required route-source/authority-hook seam, and the plan continues to represent §4.3 as blocked rather than silently crossing the forbidden file boundary.

## Issues & Recommendations

1. **[HIGH] The retirement-failure branch is still incompatible with the boot reconciler's drain condition.** §4.5 enumerates only three reconciled terminal outcomes, all of which require a durable 200/quarantine result or durable retirement, and later says every live card must reach a terminal state before approval routes are enabled. If the pure-DB retirement itself fails, however, the card stays live; placing it in the in-memory poison set does not make it one of those terminal outcomes. The same paragraph nevertheless says other lanes and the `startBridge()` lifecycle proceed. An implementer must choose between blocking globally and violating the stated “all live cards terminal” condition. **Suggested fix:** add an explicit fourth startup disposition such as `isolated_for_boot`: retirement failed, the exact card and lane are in the boot-local poison set, and this disposition counts as closed for the global drain while remaining non-authorizing. The shared writer, activation path, reaction path, and sweep already consult poison; on restart the new boot id forces reconciliation again. Alternatively persist a separate authority-blocked marker when storage permits. Add a test where retirement CAS/store fails indefinitely: the healthy lane and `startBridge()` proceed, every bad-lane route refuses, no bad card activates, and restart re-enters reconciliation.

2. **[HIGH] A durably retired unhealthy lane can churn unlimited card attempts and Discord messages immediately after boot.** The bounded reconciler releases the live slot and then starts GatePoller. The ordinary pending-gate scan sees no live card and §4.2 begins with `INSERT posting` followed by Discord POST; the shared channel-health/poison check occurs only at step 5, after the message exists. On a persistently unhealthy lane this becomes a per-tick cycle of post → fail activation/retire → post again, growing retired rows and potentially spamming founder-visible cards even though none can authorize. The new lane-local startup behavior makes this reachable by design. **Suggested fix:** add a pre-send step 0 using the same frozen-lane config check, boot poison check, and durable health predicate before the posting INSERT/Discord POST. Unknown lanes probe with backoff; unhealthy/poisoned lanes create no attempt and no message. Retain the current step-5 just-in-time check to close the race between preflight and activation. Test repeated ticks after `boot_reconcile_unresolved` produce zero new rows/POSTs until a verified same-lane recovery is durably persisted, then exactly one normal attempt is created.

3. **[MED] §8 now lists the names but assigns orchestration logic to the wrong layer and leaves the symbol matrix stale.** The PR-2 line places `tryActivatePostingCard`, `ensureReactionBlocked`, health orchestration, and the networked boot reconciler inside `StateStore.ts`. `tryActivatePostingCard` must inspect gate/head/channel state, and the boot reconciler performs Discord reads and startup coordination; putting those in StateStore would couple persistence to Bridge/network policy and diverge from the existing architecture. The table below still describes the StateStore change only as `snapshot + card + enrollment_source`, and its `plugin.ts` row still mentions only manual-spawn registration. **Suggested fix:** keep tables and atomic CAS/read/write primitives in StateStore; place activation/quarantine/health/boot orchestration in `gate-poller.ts` or a dedicated bridge service, with `plugin.ts` owning boot ordering and dependency injection. Update both integration-matrix rows to match that ownership. This is a placement clarification, not a request for more mechanism.

## Verdict

CHANGES REQUESTED — address items above
