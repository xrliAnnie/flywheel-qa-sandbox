# Design Review — plan.md (FLY-543) (Round 1)

Date: 2026-07-06
Author: Codex
Status: CHANGES REQUESTED

## Summary
The direction is feasible and fits the repo: a new `packages/voice-core` package can be built with the same package shape as `packages/token-usage`, and the default pipeline choice matches the FLY-342 founder decision. The plan is not yet safe to hand to implement "verbatim": several contracts are underspecified where implementation would otherwise ship an unsafe or false abstraction, especially HeadlessClaudeBrain, high-risk STT confirmation, interrupt/resume semantics, and Gemini Live capability claims.

## What's Good (Keep)
- The package placement and build/test shape match the monorepo convention: `packages/*` workspace, `type: module`, `tsc` to `dist/`, Vitest per package, root Biome lint.
- The default `pipeline` backend aligns with FLY-342: local whisper.cpp STT plus edge-tts TTS, with realtime reserved for special occasions.
- The scope boundary is mostly disciplined: no Discord voice bridge, no Bridge/StateStore changes, no voice cloning, no transcript-to-Linear pipeline.
- The subprocess injection direction is right. `ExecFileFn`-style seams already exist in the repo and are the right pattern for whisper/edge/ffmpeg/afplay/claude tests.
- The plan correctly treats failures as explicit and paths as config, which matches CLAUDE.md Non-Negotiables.

## Issues & Recommendations
1. **HeadlessClaudeBrain is not equivalent to an existing Lead, and the plan does not define the safety boundary.**

   Why it matters: `claude-lead.sh` does more than load `.lead/<id>/identity.md`. It copies the identity into `~/.claude/agents/<lead>.md`, starts Claude with `--agent "$LEAD_ID"` and `--permission-mode bypassPermissions`, then appends a role-aware stack of base rules such as department rules, runner messaging, founder-only authority, cross-dept reply contract, etc. See `packages/teamlead/scripts/claude-lead.sh:570-604`, `1544-1548`, and `1654-1842`. The plan only says `claude -p + identity.md` (`engineering/doc/FLY-543-pluggable-voice-skill/plan.md:35`, `68`, `178-180`), so the POC brain can silently lose governance rules while still being described as "Lead reasoning".

   Suggested fix: make the POC boundary explicit. Either implement a `LeadPromptResolver` that reproduces the necessary launcher rule stack for the selected `leadId` and role, or declare HeadlessClaudeBrain a read-only "Lead persona approximation" and run it with no action tools for FLY-543. For the POC, prefer `claude -p --tools ""` or a narrow explicit allowlist, plus a voice-context rule that says spoken commands are not executed. Defer action-capable voice routing to the product/bridge issues unless this plan adds the full Lead rule bundle and approval guard.

2. **The plan omits the FLY-342 high-risk transcript confirmation requirement.**

   Why it matters: FLY-342's evidence explicitly found that whisper.cpp preserved the 5 high-risk negation reversals, but still degraded rare technical tokens such as `pnpm`, `xhigh`, `E2E`, and hash tails; the research says FLY-543 must add text confirmation for issue IDs, commands, and approve/ship high-risk instructions (`engineering/doc/FLY-342-diy-voice-agent/research.md:214-219`, `307-315`; `eval-set.md:46-51`). FLY-543's plan records transcripts and evals, but it sends STT output straight into the brain in the POC (`plan.md:183-188`). That is unsafe for a voice interface whose example utterances include approve/ship/merge/commit/deploy.

   Suggested fix: add a small `ConfirmedTranscriptGate` before `BrainAdapter.respond` in the CLI. At minimum, display the transcript and require an explicit keyboard confirmation before sending any turn to the brain; better, require typed confirmation for high-risk patterns from the FLY-342 eval set. Record `{confirmed: true|false, confirmationMode, riskTags}` in JSONL and add unit tests using the high-risk eval sentences.

3. **`interrupt()` cannot actually cancel thinking/TTS with the current interfaces.**

   Why it matters: the plan promises `interrupt()` discards a reply while in `thinking` and kills playback while in `speaking` (`plan.md:124-131`, `174-176`), but `BrainAdapter.respond(turn): AsyncIterable<string>` has no `AbortSignal`, and neither `SttEngine` nor `TtsEngine` accepts cancellation (`plan.md:134-143`). An implementation can ignore future chunks, but the Claude/edge subprocess can keep running until timeout, burn resources, and race transcript events.

   Suggested fix: thread cancellation through the contracts now: `respond(turn, { signal })`, `transcribe(wav16k, { signal })`, and `synthesize(text, voice, { signal })`. Define exact post-cancel events: no assistant transcript after cancellation, emit `response-cancelled`, and kill child processes. Add tests that prove the active child process is terminated on interrupt.

4. **The resume API is on the wrong side of the connection lifecycle.**

   Why it matters: `VoiceBackend.createSession(opts)` has no resume handle, while `VoiceSession.resume(handle)` is a method on an already-created session (`plan.md:105-131`). Gemini Live session resumption is configured at connect time using `sessionResumption.handle`, and the SDK returns `sessionResumptionUpdate.newHandle` messages for later reconnects. The official docs also now say resumption tokens are valid for 2 hours after termination, not 24 hours. Sources: Google Live session management docs, https://ai.google.dev/gemini-api/docs/live-api/session-management.

   Suggested fix: move resume into creation, for example `createSession({ ...opts, resumeHandle })`, or add `VoiceBackend.resumeSession(handle, opts)`. `VoiceSession.close()` should return the latest handle. Map Gemini `goAway.timeLeft` to `session-expiring` and update the plan's stale 24h assumption.

5. **Gemini Live capabilities are model-specific, but the plan hard-codes `toolCallScheduling: "scheduled"`.**

   Why it matters: the plan says GeminiLiveBackend capabilities include scheduled tool-call handling (`plan.md:190-194`). Current Google docs say asynchronous function calling is not yet supported in Gemini 3.1 Flash Live, and scheduling only applies to non-blocking function definitions and function responses. A blanket `"scheduled"` capability will make upper layers believe they can rely on `SILENT/WHEN_IDLE/INTERRUPT` when the selected model may only support blocking/basic tool calls. Sources: Google Live tool docs, https://ai.google.dev/gemini-api/docs/live-api/tools.

   Suggested fix: pin the Gemini Live model in config and derive capabilities from that model. Only advertise `"scheduled"` when the adapter uses non-blocking function declarations and `FunctionResponseScheduling`; otherwise advertise `"basic"`. Add a mock Live test for both the scheduled and fallback/basic paths.

6. **Subprocess text handling needs an argv-leakage rule.**

   Why it matters: spoken text can include secrets or operational tokens; the FLY-342 eval set itself includes "API key" and "bot token" cases. The plan says to wrap `claude`, `edge-tts`, and friends as subprocesses, but it does not require prompts/text to stay out of process argv. `edge-tts --text` and `claude -p <prompt>` style invocations expose content to the process table.

   Suggested fix: make a hard implementation rule: executable paths and flags may be argv; user transcript, assistant text, and prompts go via stdin or 0600 temp files. For edge-tts, use `--file` with a private temp file or a tiny Python wrapper reading stdin. For Claude, pipe stdin to `claude -p --output-format json` or use a private prompt file when needed. Add tests that inspect mocked argv and assert no transcript/prompt text appears.

7. **The latency evidence will overclaim "first audio heard" unless TTS/playback streams.**

   Why it matters: `TtsEngine.synthesize` returns a complete `Buffer` plus `firstByteMs` (`plan.md:141-143`), and `Player` plays after that buffer exists. That measures first byte from edge-tts, not the moment Annie hears audio. FLY-342's demo had the same limitation: it measured first chunk while still playing the saved mp3 after synthesis completed.

   Suggested fix: either implement streaming TTS/playback in Phase 1, or change acceptance wording to record both `ttsFirstByteMs` and actual `playbackStartMs`. The POC evidence should not call first chunk "end-to-end first response audio" unless playback really starts then.

8. **The TypeScript contract still has small build-blocking gaps.**

   Why it matters: the plan says `types.ts` is frozen in Phase 1 step 1, but the shown contract references `TranscriptSink` and `VoiceError` without defining or importing them (`plan.md:98-103`, `130`). It also does not say how `sessionId` is generated even though transcript JSONL requires it (`plan.md:151-152`).

   Suggested fix: add these to the interface section before freezing it: `VoiceError` shape/codes, `TranscriptSink` interface, `sessionId` source, event emitter unsubscribe behavior, and exact JSONL schema. Then allow one deliberate interface review after the Phase 0 spikes instead of making step 1 permanently frozen before the risky seams are tested.

## Verdict
CHANGES REQUESTED — address items above before implementation follows this plan verbatim.
