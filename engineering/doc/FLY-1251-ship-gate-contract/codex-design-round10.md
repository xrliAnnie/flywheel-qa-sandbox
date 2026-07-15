# Design Review — FLY-1251 plan.md (Round 10)
Date: 2026-07-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 10 closes the Round-9 authorization holes: boot reconciliation now has explicit success states, live-card 404s invalidate authority, and same-boot mutation failures are remembered by every authority consumer. Two boot-lifecycle contradictions still prevent the plan from being safely executable without designer judgment, and the claimed §8 synchronization is still absent on disk.

## What's Good (Keep)

- `approval_channel_health.last_probe_boot_id` is now present in the normative SQL rather than prose only.
- The boot reconciler requires a 200 read, durable same-boot health, and durable quarantine before treating a reaction-bearing card as reconciled.
- Startup failure classes are explicitly unresolved and non-authorizing; they no longer silently count as a completed reconciliation pass.
- `assertActiveCardAuthority` now checks `message_gone=0`, so another execution's same-lane health success cannot make a known-deleted card authoritative.
- The 404 table is state-sensitive: observation-only release is limited to retiring/retired cards, while live rows lose their live slot.
- The lane/card poison sets close the same-process gap left by failed health, quarantine, or fallback-retirement mutations, and all four relevant consumers are named.
- E13 now carries the startup unresolved, producer exclusion, same-boot poison, dual-execution 404, dual-rearmer, and exhaustion cases.
- The incident stopgap, docs-only classifier, single activation primitive, quarantine episode model, and six-route authority contract remain coherent.
- The FLY-1244 sibling still has commit A but no route-source/authority-hook seam; §4.3 remains correctly blocked on a future pinned seam commit.

## Issues & Recommendations

1. **[HIGH] A permanently unreadable card prevents the boot reconciler from ever draining and globally starves unrelated Bridge work.** §4.5 declares 401/403/429/5xx/malformed/network outcomes unresolved forever, while `gatePoller.start()` is forbidden until every live card reaches a terminal reconciliation outcome. This defeats the existing channel-down convergence: after three 401/403 failures the lane can be durably unhealthy, but the card remains live and the channel-down sweep that would retire it has not started. It also expands one broken Lead/lane into a global outage for every project because the single GatePoller never starts. In current source, `startBridge()` has already opened the HTTP listener but cannot return; `index.ts` installs its SIGINT/SIGTERM cleanup only after that return, so a permanent Discord failure also leaves startup and clean shutdown half-initialized. **Suggested fix:** give the boot reconciler a bounded safe terminal path. After a defined retry/failure threshold (immediately for a durably latched unhealthy lane is reasonable), durably retire the live card as `channel_down`/`boot_reconcile_unresolved` without requiring a Discord edit; the retired message remains in the observation set for later recovery. Retirement failure keeps authority closed and retries. Alternatively start the poller in an explicit `cardProductionDisabled` mode so its health/sweep duties can converge old cards while no new card or approval authority is enabled. Add a multi-lane test proving a permanently broken lane cannot authorize but also cannot prevent a healthy lane and `startBridge()` lifecycle from progressing.

2. **[HIGH] The 404/config-drift terminal paths contradict the producer-exclusion invariant.** The boot reconciler treats durable retirement for 404/config drift as a terminal card outcome and says no card can be produced before the drain completes. But §4.5b's 404 rule and §4.5's config-drift rule both immediately say to create a fresh attempt when the gate remains pending. If that shared handler reposts during boot, a new live card appears outside the reconciler's original set and the claimed structural exclusion is false; if it does not repost, the implementation must invent a context-dependent behavior not stated in the plan. **Suggested fix:** split “invalidate” from “repost.” In boot context, durably retire the old row and defer all posting; after the reconciler drains and `gatePoller.start()` runs, the ordinary pending-gate scan creates exactly one fresh attempt. Runtime handling may still repost immediately/next tick. Test that a boot-time 404 and config drift create no card row or Discord POST before the drain, then converge to one fresh attempt after production is enabled.

3. **[MED] The Round-10 file/method checklist update still did not land.** §8's PR-2 line still says `StateStore.ts (founder_ship_card + CAS)`, and its integration row still says `snapshot + card + enrollment_source`; neither lists `ship_card_reaction_quarantine`, `approval_channel_health`, the health/quarantine methods, or the boot reconciler. The `plugin.ts` row also mentions only manual-spawn registration, not the required await-before-poller/writer ordering. §4.7 remains on the older generic boot-barrier checklist even though E13 is current, and the `retire_reason` DDL comment omits the new `message_gone`, `channel_config_drift`, and any bounded boot-reconcile reason introduced by issue 1. **Suggested fix:** update the PR-2 file list and symbol matrix with the actual ownership of all tables/methods and plugin startup sequence, synchronize §4.7 with E13, and extend the retire-reason contract. The separate implement session should not have to reconstruct these placements from scattered prose.

## Verdict

CHANGES REQUESTED — address items above
