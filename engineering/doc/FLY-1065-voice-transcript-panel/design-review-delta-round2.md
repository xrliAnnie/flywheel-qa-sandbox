# Design Review — FLY-1065 §6b signal-chain delta (Round 2)

Date: 2026-07-09
Author: Codex
Status: CHANGES REQUESTED

## Summary

The Round 1 blocker for `inputTranscription + interrupted` transcript ordering is fixed for transcript-only frames: output transcript now reaches the old assistant buffer before cancel, input transcript now lands after cancel, and the session-level no-`turn-complete` repro is covered. I still cannot approve the signal contract because the same role-aware ordering creates an uncovered interrupted-frame audio hole: if that same serverContent also carries `modelTurn.parts` audio, the new input transcript clears `turnCancelled` before the old audio is emitted, so cancelled audio can leak as the next turn's first assistant output.

## Point 1 — generation-complete 事件契约

`mapMessage()` is now role-aware around `interrupted`. For interrupted frames, it emits output transcript first, then `interrupted`, then input transcript, then `generation-complete`, then `turn-complete`; non-interrupted frames keep the old input-before-output order. The new connector tests pin input+interrupted order, full transcript/interrupted/generation/turn order, and byte-compatible non-interrupted order. This closes the exact transcript ordering bug from Round 1.

The remaining gap is that `modelTurn.parts` audio is still emitted after the post-interrupt input transcript. Audio chunks in an interrupted serverContent belong to the old generation for the same reason output transcript does. With current order, an interrupted frame containing `inputTranscription` and inline audio will emit `interrupted`, then user transcript, which resets `turnCancelled=false`, then audio; the session will not drop that audio. There is no connector or session test for `interrupted + inputTranscription + modelTurn.inlineData`.

## Point 2 — 三级降级顺序 + 幂等闸

For transcript-only combinations, the three-tier fallback now behaves correctly. The user transcript emitted after `interrupted` survives the cancel, so the next real assistant transcript can call `ensureTurnStarted()`, flush the new user turn, and later `generation-complete` flushes the assistant answer. The new session-level test with no intervening `turn-complete` proves the old assistant half-line, the new user turn, and the new assistant answer all land exactly once.

The audio hole breaks the same priority chain for an interrupted mixed media frame. Because `audio` is also a first-assistant-output signal, same-frame old audio emitted after the input reset can open a response window and flush the new user turn before the model has actually answered the new utterance. Worse, it can feed cancelled old audio to the speaker despite the `interrupted` contract. The `flushFinal()` idempotency gate still prevents duplicate finals, but the signal ordering is wrong for the audio branch.

## Point 3 — 边界闭合(信号缺失组合穷举)

The previously requested close/error contract is now pinned acceptably. `error` by itself does not fabricate a final; owner-driven `close()` drains the residual buffer to transcript event and sink. The owner paths still call close: `TalkSessionRotator.close()` and goAway rotation close the live session, and `AssistantSession.toLanding()` closes the conversation before landing reads JSONL.

The no-`generationComplete` / no-`turnComplete` graceful-close path remains closed by `GeminiLiveSession.close()`, and goAway rotation remains closed because the rotator calls old `session.close()` before opening the replacement. I did not find a remaining "subtitle never flushes" path in those owner-drained combinations. The remaining blocker is not a missing final; it is a same-frame interrupted audio ordering hole that can leak cancelled audio and falsely treat it as the next assistant output signal.

## Issues & Recommendations

1. Fix interrupted-frame audio ordering before approval. In interrupted frames, keep old-generation audio under the cancelled window, e.g. emit `modelTurn.parts` audio before the post-interrupt `emitInput()` so the session drops it while `turnCancelled=true`, or explicitly suppress audio from interrupted frames. Preserve the Round 1 fix by still emitting input transcript after the cancel.
2. Add connector and session tests for `interrupted + inputTranscription + modelTurn.inlineData` in one serverContent. Expected behavior: old audio is not emitted to `response-audio`, the input transcript reset survives, and the next real assistant transcript/audio after that frame opens the new response and flushes the user turn.

## Verdict

CHANGES REQUESTED
