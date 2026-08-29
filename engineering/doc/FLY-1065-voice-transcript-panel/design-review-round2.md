# Design Review — plan.md (Round 2)
Date: 2026-07-09
Author: Codex
Status: APPROVED

## Summary

Round 2 addresses the Round 1 blockers and closes the material design gaps. I re-read the updated plan at `engineering/doc/FLY-1065-voice-transcript-panel/plan.md` and re-checked the relevant PR #501 baseline seams.

The two prior blockers are now handled: P5 explicitly closes the conversation before `landing.run()` so close-flushed transcript finals can reach caption/quotes/recap/sink before JSONL is read, and P6 replaces the single transcript timestamp with a chunk-aware receipt (`rowCount`, `chunkCount`, `postedChunks`, `completeAt`) that can resume after partial transcript comment failure without duplicating already-posted chunks.

I also verified the previously uncertain Linear route claim from the local git object: `git show 683418b4:packages/teamlead/src/bridge/plugin.ts` contains `POST /api/linear/comment` at line 2326, validates `issueId`/`body`, checks project binding when `projectName` is supplied, and calls `client.createComment()` against the resolved issue. The plan now correctly treats this as a post-rebase preflight instead of an implicit assumption.

## What's Good (Keep)

- Keep the implementation preflight in §1: rebase only after PR #501 merges, then verify both `packages/voice-bridge/src/assistant/` and `POST /api/linear/comment` exist before touching code.
- Keep P5's pre-landing close/flush ordering and the explicit regression test. This is the right fix for the JSONL tail-loss problem.
- Keep the chunk-aware receipt design in P6. It matches the existing `AssistantLanding` failure-order law while supporting multi-comment transcript posting.
- Keep the TivPresenter single-flight state machine. The `statusMessageId/latestLine/dirty/inFlight/flushTimer` contract is precise enough to implement and test.
- Keep the connector same-frame ordering test for `outputTranscription + interrupted`. That closes the subtle half-sentence loss path.
- Keep defense-in-depth scrubbing at core final flush, caption output, and Linear transcript formatting.
- Keep the sessionId clarification: filename equals assistant session ID; row-level `sessionId` remains backend session UUID for rotator traceability.

## Issues & Recommendations

1. Implementation guardrail: preserve recap accumulation during pre-landing close.

   Why it matters: Current `AssistantSession` accumulates assistant recap only while `_state === "concluding"`. The Round 2 plan says `toLanding()` uses `state=landing` to stop new ears input, then closes the conversation while transcript handlers stay subscribed. If implementation sets `_state = "landing"` before close without another guard, close-flushed assistant finals would caption and sink, but would not enter `recapText`.

   Suggested fix: Treat the P7 test as mandatory: fake `close()` emits a final assistant transcript before resolving, and `landing.run()` must see it in `recapText`. Implement with a small `closingForLandingWasConcluding` flag, or an equivalent handler condition, rather than relying only on `_state === "concluding"`.

2. Implementation guardrail: fix the `flushFinal` pseudo-code null order.

   Why it matters: P2 writes `text = scrubTranscript(acc.flush(role)); text 为 null 直接返回`, but `acc.flush(role)` can return `null` while `scrubTranscript()` accepts a string. This is just pseudo-code, but implementing it literally will be a TypeScript error.

   Suggested fix: Implement as `const raw = acc.flush(role); if (raw == null) return; const text = scrubTranscript(raw); ...`.

These are not plan blockers because the updated tests and contracts force the correct behavior.

## Verdict

APPROVED — ready to implement.
