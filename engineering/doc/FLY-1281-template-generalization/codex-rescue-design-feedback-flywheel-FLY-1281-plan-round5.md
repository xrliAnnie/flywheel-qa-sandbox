# Design Review — FLY-1281 plan.md (Round 5)

Date: 2026-07-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

Draft v5 adopts all four Round 4 recommendations and the revised completion/flag direction is sound. Three remaining contradictions prevent the written plan from guaranteeing its own byte-compatibility and exactly-once recovery tests, primarily around the new start reservation lifecycle and the interaction between duplicate-completion audit suppression and marker replay.

## What's Good (Keep)

- Keep Step 1a's v2-only start integration: no candidate and v1 candidate both return to the exact legacy start path, while only a v2 candidate may enter generalized admission.
- Keep the enrolled-v2 marker branch before the legacy terminal short-circuits, and keep `missing_output` as a typed retryable result that preserves rather than quarantines the marker.
- Keep the separation between deterministic run-event identity, ingress source identity, and canonical completion-submission digest. Allowing a new source ID for the same digest is a reasonable logical-idempotency policy.
- Keep the explicit start idempotency key and the requirement that a different normalized selection under the same key fail closed.
- Keep the unified generalized admission, immutable runtime projection, typed snapshot parser, server-derived node identity, and capability-driven D2 rule from earlier rounds.
- Keep the C→D boundary and the E2E assertion that C never dispatches a successor or review node.

## Issues & Recommendations

1. **The normative plan still contains the v1 start wiring that v5 says was removed.** Step 1a correctly says a v1 candidate is never start-wired in C, but total acceptance §0.8 still says “v1 candidate → existing v1 contract,” and Step 6b item ② says the same thing. Those are implementation instructions, not historical notes, so an implementer can still materialize a v1 run and violate the new OFF/ON byte-compat sentinel. The completion matrix also retains the old “different event rejects” wording even though 4e now permits a different `source_event_id` when the submission digest matches, and §0.7 omits the newly required idempotency key from the public start contract. Make all normative sections agree: Step 6b must return `null`/legacy for both no candidate and v1 candidate; §0.8 must state the same under both flag states; the public DTO list must include the v2-only idempotency key; and the old event-conflict cell must become execution/route/submission-digest conflict.

2. **One append-only `workflow_start_idempotency` row cannot implement the three promised recovery boundaries as specified.** The row is described as containing the final run/node/attempt/execution and response snapshot, but fresh `RunDispatcher.start` currently allocates `executionId` internally, and the durable pre-bound execution/adopt path exists only in `RetryDispatcher.dispatch`. The HTTP response is assembled even later, after `waitForSession`, and may include `chatThreadId`. If the row is inserted only when the final response exists, a crash/retry after materialization or admission has no durable key and collides with the active run. If a complete row is inserted up front, a replay can return success even though no admission or physical launch occurred; append-only triggers also prevent filling the later response. Define a reservation/re-drive state machine rather than a key→final-result shortcut: preallocate run and execution IDs; atomically persist an immutable key+selection-digest reservation with materialization; add a generalized-only pre-bound fresh-start seam that uses the durable launch claim/commit adoption discipline; represent progress with append-only stage events or a mutable CAS pointer; and insert the immutable response receipt only after the response facts exist. A same-key replay before launch commit must resume/re-drive the same execution, while a committed launch is adopted and never spawned again. Extend the tests from simulated response loss to Bridge-process crashes/concurrent retries at reservation, admission, CommDB, and launch-commit boundaries.

3. **Duplicate-completion audit suppression conflicts with the new marker verification rule.** Suppose completion A committed and produced the sole lifecycle audit. A second `flywheel-comm complete` call B has a new source event ID but the same submission digest, so 4e correctly suppresses B's audit. If B's success response is lost, its marker remains. The reconciler then sees a receipt but no audit row for marker event ID B, replays B, and the completion handler suppresses B again; the required “marker event audit exists before unlink” condition can never become true. Use one canonical generalized-completion audit identity (for example a deterministic audit ID derived from the receipt/run-event UID, or the receipt's first `source_event_id`) and have the reconciler verify that canonical audit plus the matching submission digest—not every duplicate marker's ingress ID. For an equivalent B marker, delete when the canonical audit exists; if it is missing, re-drive exactly that canonical audit once. Add a response-loss test for the second, same-digest/different-source invocation, in addition to the existing direct double-complete and original-receipt crash tests.

## Verdict

CHANGES REQUESTED — address items above
