# Design Review — FLY-1065 §6b signal-chain delta (Round 3)

Date: 2026-07-09
Author: Codex
Status: APPROVED

## Summary

The Round 2 interrupted-frame audio hole is closed. `mapMessage()` now keeps every old-generation output in the cancelled window, then emits the new input transcript last so the cancel reset survives; the connector and session tests cover the exact failure sequence.

## Point 1 — generation-complete 事件契约

The interrupted-frame event order is now correct for the mixed transcript/audio case: output transcript → `interrupted` → old-generation audio → input transcript → `generation-complete` → `turn-complete`. That preserves the R1 fix (assistant half-line is buffered before interrupted flush), the R2 fix (old audio is emitted while `turnCancelled=true` and is dropped by the session), and the required reset semantics (her new input lands after the cancel and after old audio). Non-interrupted frames still keep input-before-output order.

The new connector tests pin both the full mixed frame including inline audio and the narrower interrupted+input+audio ordering. `generation-complete` remains emitted after all same-frame transcript/audio handling, so it still drains buffered text rather than racing ahead of the final fragments.

## Point 2 — 三级降级顺序 + 幂等闸

The session-side chain now holds across the previously problematic combinations. During barge-in, old assistant text flushes with `interrupted:true`; same-frame old audio is suppressed while the cancelled flag is still set; the new user transcript then resets the flag; the next real assistant output opens the response window and flushes the user; `generation-complete` flushes the new assistant answer. The added session test proves no `response-audio` or `response-started` fires for cancelled audio, while the real new answer still lands both finals.

The existing idempotency gate remains intact: every final still goes through `flushFinal()`, and empty buffers no-op before scrub/emit/sink. I did not find a remaining combination that double-emits a role final or suppresses a buffered role indefinitely under the scoped signal chain.

## Point 3 — 边界闭合(信号缺失组合穷举)

The previously reviewed close/error contract remains acceptable: transport `error` alone does not fabricate a final, owner-driven `close()` drains residual buffers, goAway rotation closes the old session, and landing closes the conversation before reading JSONL. If `generationComplete` is missing, `turn-complete` still drains user then assistant; if both are missing but the owner closes, `close()` drains both residual buffers.

For interrupted frames, the missing-signal edge now also closes: even without an intervening `turn-complete`, old output is flushed or dropped as appropriate, new input resets the cancel window, and the next real assistant output plus `generation-complete` produces exactly one final per role.

## Issues & Recommendations

None.

## Verdict

APPROVED
