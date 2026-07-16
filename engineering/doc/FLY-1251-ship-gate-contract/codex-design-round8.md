# Design Review — FLY-1251 plan.md (Round 8)
Date: 2026-07-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

The Round-7 mechanisms are materially present and the normal-operation algorithms are now coherent: quarantine re-arm converges, health is lane-scoped, and response outcomes are closed. Three implementation gaps remain around crash persistence, configuration drift, and normative consistency; the first can still re-authorize a rejected reaction after a StateStore failure followed by Bridge restart.

## What's Good (Keep)

- `ensureReactionBlocked` is now the sole blocked-observation entry and treats a zero-row CAS as a reason to re-read, not as success.
- Removal and founder response cannot proceed until the current quarantine row is durably observed as blocked. The clear/re-arm concurrency cases are explicitly named.
- Channel health is no longer project-wide. The planned key includes Lead, Discord channel/thread, and non-secret bot identity, preventing a healthy Lead from resetting another Lead's failure counter.
- Missing health rows and health reads are non-authorizing, recovery requires a same-lane successful probe plus durable persistence, and activation/authority/sweep share the same predicate.
- §4.5b now cleanly separates card-state effects from health-state effects for 200, authorization failures, deletion, rate limiting, server/malformed responses, network errors, and nonce reconciliation.
- Existing safeguards remain sound: one activation primitive, fail-closed POST reconciliation, versioned reaction episodes, stale-message observation, and the live writer hold check.
- The FLY-1244 sibling still lacks the authority seam even though its planned implementation commits are complete; §4.3 remains correctly blocked on a separate pinned seam commit.

## Issues & Recommendations

1. **[HIGH] “Treat unhealthy/non-authorizing” after a StateStore mutation failure is not preserved across process restart.** If a health increment/latch write fails, the durable row can remain `healthy`; the current process may treat it as unhealthy, but after a crash the next process will trust that old healthy row because only a missing row is probe-gated. The quarantine fallback has the same shape: `ensureReactionBlocked` can fail because StateStore is unavailable, and its proposed `retire/block` uses that same store and is not required to persist before return. A restart can therefore recover an active card with no quarantine while the rejected Discord reaction is still present. **Suggested fix:** add a startup authority-reconciliation barrier. Every Bridge process must treat all lanes as current-boot unknown until a same-lane probe succeeds and its result is persisted, regardless of a prior `healthy` row. Before any approval route is enabled, reconcile every persisted live card; a present reaction without a durably consumable/current quarantine must be quarantined and require a fresh click, or the card must be durably retired. Authority remains closed until this pass completes; failed retirement/quarantine keeps it closed. Add mutation-failure→crash→restart tests for both health and quarantine, asserting zero writes before reconciliation and a verified fresh click after recovery.

2. **[MED] Frozen `channel_key` does not define what happens when the actual configured lane changes.** Freezing the old tuple prevents consumers from deriving different keys, but after a Lead/channel/bot reconfiguration the HTTP request is made through the new tuple. Recording that new bot's successful probe under the card's old frozen key would falsely recover a lane that was never probed; deriving the new key would violate the frozen-card contract. **Suggested fix:** immediately compare the current server-resolved tuple with the card's frozen tuple before every probe/read. A mismatch is a typed non-authorizing `channel_config_drift` outcome that retires the old card and creates a new attempt with the new key. A health result may mutate only the key that exactly describes the credential/channel used for that request. Define bot identity resolution failure as unknown/unhealthy, and make the reconfiguration tests assert retirement/repost rather than merely “key does not drift.”

3. **[MED] The normative DDL and test/file checklists still lag the Round-8 prose.** The actual `founder_ship_card` SQL block in §4.1 does not contain the promised `channel_key TEXT NOT NULL`; it appears only later in prose. §4.7 still calls the quarantine suite “tombstone 三格” and omits the new clear-vs-re-arm, dual-re-armer, mutation-failure, lane-isolation, and closed-outcome cases. E13 likewise omits the clear-vs-re-arm and cleared-crash-new-hold races, and §8's StateStore surface lists neither quarantine nor channel-health storage. **Suggested fix:** put `channel_key` in the authoritative §4.1 DDL, list both new tables/APIs in §8, and synchronize §4.7 plus E11/E13 with every required Round-8 test—including the restart cases from issue 1—so the implement session cannot follow a stale checklist.

## Verdict

CHANGES REQUESTED — address items above
