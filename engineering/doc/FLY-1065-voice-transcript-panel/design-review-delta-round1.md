# Design Review — FLY-1065 §6b signal-chain delta (Round 1)

Date: 2026-07-09
Author: Codex
Status: CHANGES REQUESTED

## Summary

The revised happy path is implemented as described: `finished` is retained as a fast path, `generation-complete` is now a transport event, `generation-complete` and `turn-complete` both drain through the single `flushFinal()` exit, and `close()` drains residual buffers. However, the cancellation boundary is not fully closed: an `inputTranscription + interrupted` same-frame or near-frame sequence can leave a new user turn buffered while `turnCancelled` stays true, causing the next assistant output to be suppressed instead of opening the response window and flushing the user.

## Point 1 — generation-complete 事件契约

`transport.ts` adds `{ type: "generation-complete" }` and keeps `finished?: boolean` on transcript events. `genaiConnector.ts` maps `sc.inputTranscription.finished === true` / `sc.outputTranscription.finished === true`, keeps legacy `final: !!sc.turnComplete`, emits transcript fragments before `interrupted`, then emits audio, `generation-complete`, and `turn-complete`.

That order is correct for the known R1 bug: `outputTranscription + interrupted` in one `serverContent` appends the half-line before the interrupted flush. It also preserves `generationComplete` behind transcript fragments, so a final output fragment and `generationComplete` in the same SDK message will not lose the last text.

The gap is that the connector applies "transcripts before interrupted" to both roles. If a barge-in frame carries `inputTranscription` for Annie's new speech plus `interrupted`, the session first buffers the new user text, then `interrupted` calls `cancelCurrentTurn()` and leaves `turnCancelled=true`. There is no connector or session test for `inputTranscription + interrupted`, nor for a full same-frame mix of input/output transcript, `interrupted`, `generationComplete`, and `turnComplete`.

## Point 2 — 三级降级顺序 + 幂等闸

For non-cancelled turns, the priority chain is sound. Transcript fragments append to `TurnAccumulator`; `finished===true` immediately calls `flushFinal(role)`; first assistant transcript/audio calls `ensureTurnStarted()`, which flushes user before `response-started`; `generation-complete` flushes user then assistant; `turn-complete` repeats the same drains as a last resort; and every path goes through `flushFinal()`, where empty `acc.flush(role)` returns null before scrub/emit/sink. That gives the desired "at most once" behavior across duplicate signals.

The `ensureTurnStarted()` guard is the weak point. It returns when `turnCancelled` is true. A problematic sequence is:

1. Assistant is speaking; Annie barges in.
2. SDK emits the new user `inputTranscription` before or in the same message as `interrupted`.
3. Session buffers that user text, then `interrupted` flushes the old assistant partial and sets `turnCancelled=true`.
4. If no `turn-complete` clears the flag before the model answers Annie's new utterance, the next assistant transcript/audio is dropped by the `turnCancelled` guards before `ensureTurnStarted()` can flush the buffered user turn.
5. `generation-complete` or `turn-complete` may later flush the user buffer, but assistant text already dropped from the buffer cannot be recovered; if those signals are also absent, the user final waits until `close()`.

So the implementation does not yet prove "每 role 每轮至多一个 final、绝不为零" under the cancellation/order combinations this review was asked to stress. The existing reset on user transcript only helps when the user transcript arrives after cancellation; it does not help when the user transcript is emitted before `interrupted`.

## Point 3 — 边界闭合(信号缺失组合穷举)

Covered combinations that do close correctly:

1. `finished` present: the role flushes immediately; later `generation-complete` / `turn-complete` / `close()` hit an empty buffer and do not double-emit.
2. `finished` absent, assistant output present, `generationComplete` present: first assistant output flushes user, `generation-complete` flushes assistant, later `turn-complete` is a no-op for finals.
3. `generationComplete` absent, `turnComplete` present: `turn-complete` drains user first, then assistant.
4. `generationComplete` and `turnComplete` absent, graceful teardown or goAway rotation: `close()` drains both roles before closing; goAway-driven rotator renewal calls old `session.close()`, so residual buffers are covered there.
5. `interrupted` after assistant text: assistant partial flushes with `interrupted:true`; later duplicate flush signals are idempotent.
6. `interrupted` after `generation-complete`: assistant buffer is empty, so interrupted is a no-op and the already-complete assistant final remains unmarked, which matches the stated contract.

Not fully closed:

1. `inputTranscription` before/same-frame `interrupted`, then no `turnComplete` before next assistant output: stale `turnCancelled=true` can suppress the next assistant output and delay or lose finals as described above.
2. Unexpected connector `onclose`/`error` without a subsequent owner-driven `close()`: `genaiConnector` surfaces an `error`, and `GeminiLiveBackend` emits it, but that path does not itself drain buffers. This is less central than the cancellation bug because normal goAway rotation and landing teardown do call `close()`, but it is still a "connection died before terminal signals" sequence where final emission depends on higher-level teardown.

## Issues & Recommendations

1. Fix the `inputTranscription + interrupted` cancellation ordering hole before approval. Either make connector ordering role-aware for interrupted frames, e.g. append `outputTranscription` before `interrupted` but deliver `inputTranscription` after `interrupted`, or change session state so a buffered/new user turn can reopen the response window even when the previous assistant generation was cancelled. Add tests for `inputTranscription + interrupted` and for `inputTranscription + interrupted -> assistant output -> generation-complete` with no intervening `turn-complete`.
2. Add an explicit same-frame ordering test for transcript fragments + `interrupted` + `generationComplete` + `turnComplete` in one `serverContent`. The current implementation likely behaves acceptably for output-side text, but the contract is important enough to pin rather than infer.
3. Consider whether unexpected `error`/`onclose` should trigger a best-effort residual flush or whether the owning layer must always call `close()` after an error. At minimum, document and test the chosen contract so "connection died before terminal signals" is not ambiguous.

## Verdict

CHANGES REQUESTED
