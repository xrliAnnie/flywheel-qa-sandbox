# Design Review — FLY-967 plan.md (Round 1)

Date: 2026-07-07
Author: Codex
Status: CHANGES REQUESTED

## Summary

The overall A-mode architecture is feasible on top of FLY-545 PR-1: the existing voice-core already has Gemini Live AUDIO, 16k PCM input, 24k mono PCM output, response-cancelled, transcript JSONL, ask_lead, and rotator support, while the current Bridge already has create-issue, update-issue, and project-scoped issues routes. The plan is also disciplined about scope: it keeps writes out, reuses the shared #huddle daemon, waits for 545 PR-1, and preserves the A/B experiment boundary.

However, there are several implementability gaps that need to be fixed before handing this to implement. The biggest ones are a missing voice-core control/input contract for making Gemini speak first, an incorrect local barge-in contract, an unsupported Gemini `languageCode` config promise, and under-specified `projectName` scoping for Linear calls.

## What's Good (Keep)

- Correctly treats `packages/voice-bridge` as a FLY-545 PR-1 dependency, not as something that exists today; the current checkout confirms `packages/voice-bridge` is absent.
- Keeps A's incremental work mostly isolated to `assistant/*`, plus a small voice-core extension and conditional Bridge routes.
- Good use of evidence gates: S-A1 measures first audio, interruption latency, voice choice, and briefing effectiveness before claiming A's latency advantage.
- The read-only tool boundary is right: `lookup_issue`, `board_snapshot`, and existing `ask_lead` are a sane minimum; no write tools or voice authorization are introduced.
- Landing failure semantics mostly follow the approved FLY-545 shape: comment failure does not close, close failure leaves manual recovery, and staged E2E plus Annie real-use evidence are required.
- The technical premise for native AUDIO is source-backed: current code maps output chunks to `pcm16` 24k mono (`packages/voice-core/src/backends/gemini/genaiConnector.ts:147-154`), input is sent as `audio/pcm;rate=16000` (`genaiConnector.ts:93-100`), and official Live docs currently match that 16k input / 24k output contract.

## Issues & Recommendations

1. Missing contract for Gemini to speak first / receive text control prompts.

   Why it matters: FLY-967 requires the assistant to open the meeting with a briefing timestamp (`plan.md:225-229`). Today `ConversationSession` only exposes `sendAudio`, `interrupt`, and `injectToolResult` (`packages/voice-core/src/types.ts:136-146`), and the Gemini transport only exposes `sendAudio` plus tool responses (`packages/voice-core/src/backends/gemini/transport.ts:37-46`). `systemInstruction`/`systemPreamble` sets context, but it does not by itself cause the model to produce an opening utterance. Official Live docs show text input is a separate `sendRealtimeInput({ text })` path.

   Suggested fix: add an explicit voice-core contract in §5.1/P1, for example `ConversationSession.sendText(text, { turnComplete?: true })` or `startTurn(text)`, wired through `LiveConnection.sendText` to `session.sendRealtimeInput({ text })`. Cover it with mock transport tests and use it for the opening line, tool-filler control prompts if needed, and any deterministic concluding prompt. If the intent is not to let Gemini initiate, change §6 so the opening is a deterministic local clip/TIV message and remove the native-voice opening claim.

2. Local barge-in pre-stop should call the existing local `interrupt()` path, not only flush speaker output.

   Why it matters: The plan says the local pre-stop gate should `flush` but "not send interrupt" (`plan.md:248-252`). In current voice-core, `interrupt()` is already local suppression only; it does not send a server cancel (`packages/voice-core/src/backends/gemini/GeminiLiveBackend.ts:163-166`). It marks the turn cancelled, aborts in-flight `ask_lead`, emits `response-cancelled`, drops late audio, and suppresses late tool calls (`GeminiLiveBackend.ts:190-194`, `219-237`). If AssistantSpeaker only flushes while the session remains active, the model can keep generating unheard audio/transcripts or complete tool calls for a dead turn until server VAD eventually catches up.

   Suggested fix: define localBargeIn as `speaker.flush(); conversation.interrupt();` and explicitly note that this is not a client-side Gemini cancel. Keep it idempotent with the later server `interrupted` event. Add fake-timer/unit tests that a local pre-stop drops late audio, suppresses assistant transcript, aborts active tool handlers, and resumes normally on the next user turn.

3. Remove or reframe `assistant.languageCode`; Gemini native audio does not support explicit language code.

   Why it matters: The config contract includes `"languageCode": "cmn-CN"` (`plan.md:117-120`) and §5.1 says `languageCode` is passed through speech config (`plan.md:158-160`). Current official Gemini Live docs say native audio models automatically choose language and do not support explicitly setting the language code; language restriction should be done via system instructions. This is an implementation trap: the field may be ignored, rejected, or give the user a false guarantee.

   Suggested fix: delete `assistant.languageCode` from the config contract, or rename it to a prompt-only field such as `languagePreference` and state that it is appended to `systemHint`, not sent to `speechConfig`. Add a test that only `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` is emitted for voice choice.

4. Linear calls need an explicit `projectName` scope contract.

   Why it matters: The current `create-issue` route already has a `projectName` binding path (`packages/teamlead/src/bridge/plugin.ts:1975-1979`), and `/api/linear/issues` applies `projectName` binding fail-loud (`plugin.ts:2266-2273`). FLY-545 P12 also requires the new issue lookup route to respect `projectName` binding (`/Users/xiaorongli/Dev/flywheel-FLY-545/engineering/doc/FLY-545-huddle-mode/plan.md:306-309`). FLY-967 does include `projectName` on `board_snapshot` (`plan.md:181`) but not on `lookup_issue` (`plan.md:172-173`), and P7 only asserts the created title shape (`plan.md:275-276`). In a multi-project/multi-team workspace, this can fail issue creation or return/read the wrong Linear issue.

   Suggested fix: make `projectName` a required field on `BridgeLinearClient` construction and assert every Linear call carries it where applicable: create-issue body, issue lookup query, issues query, and any route that resolves project scope. Add tests that `/talk` create-issue sends `projectName`, `lookup_issue` calls `/api/linear/issue?projectName=<current>&query=...`, identifier lookup is exact before keyword search, and unknown projectName fails loud.

5. Carry FLY-545's landing idempotency guard into AssistantLanding.

   Why it matters: The approved sibling plan calls out a non-blocking but explicit implementation guard: summary comments need a deterministic marker/idempotency key, or a test that duplicate rerun comments are acceptable (`FLY-545 plan.md:12-14`). FLY-967 says landing can be rerun and "comment idempotent append" (`plan.md:237-241`) but does not define the marker, key, or duplicate-acceptable behavior. Close failure after comment success is exactly the rerun case that will duplicate the summary unless this is nailed down.

   Suggested fix: add an `assistant-summary` marker/idempotency key derived from the `/talk` issue id + session id, or explicitly state that duplicate summary comments are acceptable and add a test proving the final TIV/retry behavior is understandable. Prefer the marker; it is closer to 545 and keeps the shared landing semantics aligned.

6. Briefing "recent decisions" should state how it works with the existing route.

   Why it matters: The plan says recent decisions are "近 14 天 Done" (`plan.md:203-206`), but the existing `/api/linear/issues` route supports project/state/labels/limit/slim, not a date filter (`packages/teamlead/src/bridge/linear-query.ts:33-40`, `56-76`). It does return `updatedAt` and orders by `updatedAt` (`linear-query.ts:80-92`, `151-165`), so this is implementable, but only as client-side filtering after fetching enough Done issues.

   Suggested fix: update §5.3/P4 to say: request `state=completed/done` with a bounded high enough `limit`, then locally filter `updatedAt >= now-14d`, cap at 15, and show `truncated/stale` if the route reports truncation. Add a unit test for date filtering and route truncation behavior.

## Verdict

CHANGES REQUESTED — address the contract gaps above before implementation. The design direction is sound, but the current plan would otherwise leave implementers guessing at critical seams.
