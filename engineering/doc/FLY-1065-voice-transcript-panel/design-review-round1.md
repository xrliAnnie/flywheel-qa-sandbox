# Design Review — plan.md (Round 1)
Date: 2026-07-09
Author: Codex
Status: CHANGES REQUESTED

## Summary

The plan is directionally right and is feasible on the PR #501 / FLY-967 baseline. I verified the key premise against the extracted tree: `genaiConnector.mapMessage()` currently maps transcript `final` from `!!sc.turnComplete`, while `GeminiLiveSession` only writes the transcript sink when a transcript event is final. `AssistantSession` then only consumes final transcripts for captions, quotes, end-word detection, and recap capture. So the plan correctly identifies the root cause as a voice-core final/aggregation problem, not just a Discord rendering problem.

I would not hand this to implementation yet. There are two correctness blockers in the plan as written: landing reads the JSONL before the proposed close-flush can run, and the new transcript receipt is not chunk-aware even though the plan posts up to three transcript comments. There are also two integration gaps that should be made explicit before implementation: the Bridge `/api/linear/comment` route is not present in this main-based checkout, and the new async TivPresenter status anchor needs single-flight/coalescing semantics or it can still create multiple status messages under normal rapid status calls.

## What's Good (Keep)

- Keep the core architecture: connector stays a thin mapper, `GeminiLiveSession` owns per-role aggregation, and downstream consumers continue to consume `final:true` turn-level events.
- Keep `Transcription.finished` as the primary signal plus `turn-complete` / interrupted / close fallback. This matches the SDK evidence and avoids betting the feature on one server behavior.
- Keep transcript event and `TranscriptEntry` changes additive. The existing public types in `packages/voice-core/src/types.ts` can absorb optional `finished?` / `interrupted?` without breaking current consumers.
- Keep `captions !== false` default-on with explicit `false` as the log-only escape hatch. The config resolver already has the fail-fast optional boolean pattern for `bargeIn`; reuse that pattern.
- Keep the status/caption split: status should be one edited message, captions should be per-turn messages. That directly addresses the founder complaint without building partial streaming UI in v1.
- Keep the staged E2E requirement. This feature touches Gemini event ordering, Discord message behavior, local JSONL, and Linear landing; unit tests alone will not prove it.

## Issues & Recommendations

1. Landing reads transcript before the proposed close-flush can run.

   Why it matters: P2 relies on `GeminiLiveSession.close()` to flush residual user/assistant buffers, including rotator tail data. But current `AssistantSession.toLanding()` calls `landing.run()` first and only calls `teardown()` afterward. `teardown()` then unsubscribes handlers, flushes the speaker, and closes the conversation. Evidence: `toLanding()` invokes `this.opts.landing.run(...)` at `AssistantSession.ts:420` and only afterward calls `await this.teardown()` at `AssistantSession.ts:439`; `teardown()` closes the conversation at `AssistantSession.ts:491-492`. The rotator close path also delegates to the live session close (`TalkSessionRotator.ts:55-60`). If P6 reads JSONL inside `landing.run()`, any transcript emitted or written by P2's close flush will happen too late to appear in the Linear transcript comment. It can also miss recap/quote text that only becomes final on close.

   Suggested fix: Add an explicit pre-landing transcript finalization step to the plan. The smallest clean contract is: in `toLanding()`, stop accepting new ears frames / clear timers, keep transcript handlers installed, `await this.conv?.close()` or call a new `flushTranscript()` seam before `landing.run()`, then set `this.conv = null` so `teardown()` does not close twice. Add a unit test where a fake conversation emits a final transcript during `close()` and assert `landing.run()` receives it / reads it before posting.

2. Transcript comment idempotency is under-specified for multi-comment posting.

   Why it matters: The current receipt is one summary receipt (`commentAt`, `commentUrl`) and the plan adds one `transcriptAt?: string`. But P6 also says `buildTranscriptComments()` may return up to three comments. If chunk 1 posts and chunk 2 fails, a single `transcriptAt` cannot represent partial progress. If it is written only after all chunks succeed, rerun duplicates chunk 1. If it is written after the first chunk, rerun skips missing chunks. The current landing receipt pattern is explicitly what prevents duplicate summary comments (`AssistantLanding.ts:48-53`, `AssistantLanding.ts:77-118`); the new transcript phase needs the same rigor at chunk granularity.

   Suggested fix: Either simplify v1 to a single transcript comment capped at the conservative limit plus JSONL fallback, or make the receipt chunk-aware. For example: `transcript: { chunks: [{ index, url?, postedAt }], completeAt?, rowHash?, chunkCount }`. Write each posted chunk atomically before moving to the next, and on rerun resume from the first missing chunk. Tests should cover failure after chunk 1 of 3 and prove rerun does not duplicate chunk 1 and does post chunks 2-3.

3. The plan assumes `/api/linear/comment` exists, but this checkout does not show that route.

   Why it matters: The PR #501 voice-bridge client calls `POST /api/linear/comment` (`wiring.ts:579-584`), and the plan says no new Bridge route is needed. In the main-based checkout I verified `packages/teamlead/src/bridge/plugin.ts` has `/api/linear/create-issue`, `/api/linear/update-issue`, and `/api/linear/issues` route blocks (`plugin.ts:2026-2028`, `plugin.ts:2229-2230`, `plugin.ts:2296-2298`), but no `/api/linear/comment` route. The extracted PR #501 tree only contains `packages/voice-core` and `packages/voice-bridge`, so it does not prove the route exists either. If production has the route from another pending branch, the plan must name that dependency; if not, landing comments will fail regardless of transcript fixes.

   Suggested fix: Add an implementation preflight step after rebase: verify the Bridge exposes `POST /api/linear/comment` with token auth, `projectName` handling where applicable, body validation, and a test. If absent, add it as an explicit P0/P6 dependency or change `makeLinearClient.comment()` to call an existing supported route. Do not leave this as an implicit assumption.

4. TivPresenter status needs a single-flight async state machine, not only a throttle.

   Why it matters: `TivSurface.status()` is synchronous/void today, and current wiring fire-and-forgets `sendMessage()` (`wiring.ts:253-256`). The new presenter will call async `sendForId()` and `edit()` while preserving a void interface. The plan says first status sends an anchor and later statuses edit it, but it does not specify what happens when several `status()` calls arrive before the first `sendForId()` resolves, or when an edit is in flight and a newer status arrives. That is common in this session: start calls "正在进场", live calls "listening", response-started calls "speaking", tool-call calls "thinking", response-done calls "listening" (`AssistantSession.ts:418`, `AssistantSession.ts:356-357`, etc.). Without single-flight/coalescing, the "one status message" guarantee can fail under normal promise timing.

   Suggested fix: Specify presenter internals: one pending promise chain, one `statusMessageId`, one `latestLine`, one scheduled flush timer, and a monotonically increasing sequence or dirty flag so stale sends/edits cannot overwrite newer lines. Tests should include rapid statuses before first `sendForId` resolves, rapid statuses during a slow edit, and edit failure while a newer line is queued.

5. Interrupted ordering is not pinned at the connector boundary.

   Why it matters: The plan wants interrupted assistant partials to be flushed "before cancel" so the half-spoken line is preserved. Current connector emits `interrupted` before transcript fields in the same server message (`genaiConnector.ts:155-172`). If Gemini ever sends `serverContent.interrupted` with a same-frame `outputTranscription`, session-level "flush before cancel" will flush only the already-buffered text, then the same-frame assistant transcript will be suppressed by `turnCancelled`. That undermines the interrupted transcript promise.

   Suggested fix: Decide and test event ordering. Prefer mapping same-frame input/output transcription before `interrupted`, or introduce a combined/batched handling rule so transcript deltas in an interrupted frame are appended before the interrupted flush. Add a connector or session test for `interrupted + outputTranscription` in one message.

6. "SessionId alignment" is only path alignment in the plan, not JSONL entry alignment.

   Why it matters: P3 changes the JSONL file path to `${assistantSessionId}.jsonl`, which fixes the landing fallback path. But `GeminiLiveSession.writeTranscript()` still writes `sessionId: this.sessionId`, where `this.sessionId` is the Gemini backend session UUID (`GeminiLiveBackend.ts:316-325`). With `TalkSessionRotator`, a single assistant meeting can span multiple backend session IDs. That may be useful, but it is not the same as "JSONL落盘...对齐 sessionId" in the plan.

   Suggested fix: Make the contract explicit. Either say JSONL filename/receipt marker use the assistant session ID while each row keeps backend `sessionId`, or wrap/extend the sink to add `assistantSessionId?: string` to each row. If landing reads by file only, row-level backend session IDs are fine, but the plan should not imply they are aligned unless implemented.

7. The secret-scrub redline should be defense-in-depth at landing, not only at the core final emitter.

   Why it matters: The best primary fix is to scrub once in `flushFinal()` before emitting final transcript and writing JSONL. That protects production captions, quotes, recap, and JSONL. But P6 introduces an injectable `readTranscript?: () => TranscriptRow[]` and static `buildTranscriptComments(rows, opts)`. If those paths ever receive old JSONL, test seams, or future non-core rows, Linear can become an unsanitized outlet despite the stated "all external exits must pass scrubTranscript()" redline.

   Suggested fix: Keep core-level scrub, and also call `scrubTranscript()` when formatting transcript rows for Linear comments. Consider applying it in `TivPresenter.caption()` too because the presenter is intended as a reusable shared path for later 545/1018 callers.

8. The test plan should add two specific regression cases.

   Why it matters: The current tests cover the broad surfaces, but the two highest-risk gaps above need direct tests or they will regress silently.

   Suggested fix: Add these to P7:
   - `AssistantSession`: a fake conversation whose `close()` emits/writes a final transcript before resolving; assert landing sees the close-flushed transcript and the success card does not claim a transcript when rows remain empty.
   - `AssistantLanding`: transcript chunk 1 posts, chunk 2 fails, rerun resumes without duplicating chunk 1.

## Verdict

CHANGES REQUESTED — address the sequencing and idempotency blockers, and make the Linear route and TivPresenter async contracts explicit before implementation. After those updates, the plan should be ready to implement.
