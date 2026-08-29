# Design Review — FLY-1006 plan.md (Round 1)

Date: 2026-07-08
Author: Codex
Status: CHANGES REQUESTED

## Summary

The overall direction is feasible: M1 is a thin product-test wrapper around the FLY-980 rig, and M2 can fit the voice-bridge architecture once FLY-967 lands. I would not approve the plan as written because several implementation-critical contracts are underspecified or contradicted by the actual source: agent creation does not currently build the claimed production/M2 audio config, the room-level slot/ears wiring is private to `/gemini` on the FLY-967 branch, and the proposed `/eleven` playback path uses a discrete utterance queue for streaming PCM.

## What's Good (Keep)

- The scope boundary is disciplined: shim/agent lifecycle, stale-answer dropping, multi-human mixing, and full 8-Lead rollout are correctly deferred.
- M1/M2 sequencing is correct in principle: M1 can run immediately, while M2 should wait for FLY-967 PR #501 because the raw PCM playback, interaction defer, and human-filter fixes are real dependencies.
- Evidence and acceptance are framed honestly: Annie's real-microphone and VC sessions are acceptance artifacts, not something the test suite can fake.
- The plan preserves the important FLY-980 security findings: API key server-side only, workspace-secret Custom LLM auth, evidence-based readback, and credits accounting.
- The planned offline seams for `ElevenWs` are the right testing shape: injectable fetch/WebSocket, init-frame assertions, audio decode, interruption, and metadata validation.

## Issues & Recommendations

1. **Agent rebuild step claims production/M2 config that `create-agent.mjs` does not set.**

   The plan says to reuse "980 create-agent.mjs" unchanged while producing `cascade_timeout_seconds=15`, soft timeout fillers, `turn_v3`, `flash_v2_5`, and `tts.agent_output_audio_format="pcm_24000"` (`engineering/doc/FLY-1006-eleven-product-e2e/plan.md:56-60`). The actual script creates the workspace secret and sets `tts.model_id`, optional `voice_id`, and `turn_model`, but it does not set cascade timeout, soft timeout, or output audio format (`engineering/spike/FLY-980-eleven/create-agent.mjs:37-62`). FLY-980's runbook records those production knobs as separate real-world requirements (`engineering/doc/FLY-980-elevenlabs-tts-spike/evidence/v10-cost-and-runbook.md:47-57`).

   Why it matters: implementing S1 literally can rebuild a non-production agent. For M1 that risks the slow-brain failure mode FLY-980 already found; for M2 it can make the `onAudio(Buffer /*24k*/)` assumption false and break `upsample24kMonoTo48kStereo`.

   Suggested fix: change S1 from "create-agent unchanged" to an explicit FLY-1006 wrapper or post-create patch sequence. The plan should name the exact patch/readback requirements for `cascade_timeout_seconds`, `soft_timeout_config`, `tts.model_id`, `tts.agent_output_audio_format`, override bits, and workspace secret cleanup. Make `conversation_initiation_metadata` readback a hard gate before M2 starts.

2. **M2 needs a shared room runtime; FLY-967 currently owns a private slot and ears receiver inside `/gemini` wiring.**

   The plan requires `/meet`, `/gemini`, and `/eleven` to contend for one room slot (`plan.md:139-141`), but the FLY-967 template constructs a new `SessionSlot` inside `wireAssistantMode` (`origin/flywheel-FLY-967:packages/voice-bridge/src/assistant/wiring.ts:206`). The same wiring also constructs and attaches the resident `EarsReceiver` internally (`origin/flywheel-FLY-967:packages/voice-bridge/src/assistant/wiring.ts:180-197`). If `/eleven` adds its own slot/ears wiring next to this, `/gemini` and `/eleven` can both believe they own the VC, or duplicate receiver subscriptions.

   Why it matters: this is the room's core safety invariant. A failing slot invariant can cause two modes to speak/listen concurrently; duplicate ears pipelines can also make staged results misleading.

   Suggested fix: add an explicit M2 substep after #501 merge to refactor the runtime assembly to one shared `SessionSlot` and one shared ears router, owned by `runVoiceBridge` or a `VoiceRoomRuntime`. Pass that shared slot/router into `/gemini` and `/eleven` wiring. Add tests proving `/gemini` holding the slot rejects `/eleven`, `/eleven` holding it rejects `/gemini`, and `onFrame`/`onBargeIn` dispatch only to the active session.

3. **The playback plan uses `LeadSpeaker` for streaming PCM, but the codebase's streaming abstraction is `AssistantSpeaker`.**

   The plan says `ElevenWs.onAudio -> upsample24kMonoTo48kStereo -> LeadSpeaker (audio buffer source, StreamType.Raw)` (`plan.md:127-131`). `LeadSpeaker` is a serial discrete utterance queue: each `{kind:"audio"}` call creates a new stream/resource from that buffer and waits for player events (`packages/voice-bridge/src/audio/LeadSpeaker.ts:123-190`). FLY-967 introduced `AssistantSpeaker` specifically because model audio is a continuous response-audio chunk stream; it opens one `PassThrough` per turn and feeds chunks into it (`origin/flywheel-FLY-967:packages/voice-bridge/src/assistant/AssistantSpeaker.ts:1-10`, `:58-87`). The raw PCM fix also lives at the stream resource factory layer (`origin/flywheel-FLY-967:packages/voice-bridge/src/bots/discordWiring.ts:346-364`).

   Why it matters: treating every ElevenLabs `audio_event` as a discrete `LeadSpeaker.speak()` item risks audible pops/gaps, queue buildup, and late audio playing after interruption. It also obscures the turn boundary needed for "stop before any later enqueue" tests.

   Suggested fix: make the plan use `AssistantSpeaker` directly if its event model fits, or add a small `ElevenSpeaker` with the same `beginTurn/feed/endTurn/flush` shape. Define how ElevenLabs events map to begin/end of a response, and add tests for one raw stream per agent response, backpressure warning, interruption flushing, and late chunk drop after `interruption`/local barge-in.

4. **M1 talk-page lead override contract is internally inconsistent and depends on missing persona files.**

   The signed-url route is specified to "only return signedUrl" while the page needs `voiceId` and `prompt` to call `Conversation.startSession({ overrides: ... })` (`plan.md:66-75`). The plan also says persona md files are reused from "980 S6", but there are no tracked persona `.md` files under `engineering/spike/FLY-980-eleven/`; the spike only records inline persona requirements and evidence examples.

   Why it matters: P2 depends on per-session persona/voice switching. If implementers follow the route contract literally, the browser has no prompt/voice data; if they depend on local untracked files, the rig is not reproducible for QA.

   Suggested fix: choose one explicit shape. Either return non-secret `{ signedUrl, lead: { voiceId, prompt } }` from the local server, or embed a tracked 3-Lead prompt table in the static page. Add the actual Tadashi/Cass/Belle persona prompt text to the FLY-1006 spike directory and test that all three configured leads have non-empty prompt + voice IDs.

5. **`ElevenWs` should include ping/pong and conversation-id gates in the planned tests.**

   The FLY-980 WS driver handles ElevenLabs `ping` by sending `pong` (`engineering/spike/FLY-980-eleven/e2e-session.mjs:130-134`) and only adds `custom_llm_extra_body` when explicitly provided (`engineering/spike/FLY-980-eleven/e2e-session.mjs:78-84`). FLY-980 evidence says the platform default does not send `elevenlabs_extra_body`/`user_id`; production concurrency needs a client-provided conversation id (`engineering/doc/FLY-980-elevenlabs-tts-spike/evidence/v10-cost-and-runbook.md:67-72`).

   Why it matters: missing ping/pong can make long sessions flaky, and missing per-session ids can collapse shim keying back to the spike's `single-session` fallback.

   Suggested fix: add `ping -> pong` to the `ElevenWs` responsibilities and tests. Make a unique `conversation_id` mandatory in the init frame, assert it in unit tests, and capture shim evidence during M2 showing the id arrives in `elevenlabs_extra_body`.

6. **S8 "reuse 967 staged venue" needs a concrete /eleven adaptation, not just a reference.**

   The FLY-967 harness is Gemini-specific: it autostarts `/gemini`, scans Gemini transcript JSONL, records orchestrator audio, and uses Gemini `generateContent` to transcribe the captured output. The FLY-1006 plan lists the right acceptance legs (`plan.md:146-154`) but does not specify the new `/eleven` runner script, env contract, output transcript source, production-port refusal, or fail-closed assertions.

   Why it matters: the staged rig is the only automated gate before Annie VC time. A vague "reuse" can easily become a green log that did not actually prove `/eleven` audio in, audio out, interruption, and slot contention.

   Suggested fix: add named scripts such as `e2e/eleven-staged.mjs` and `e2e/eleven-voice-loop.mjs`, modeled on FLY-967 but with ElevenLabs-specific env (`ELEVENLABS_AGENT_ID`, shim health URL, signed-url path), transcript source, interruption injection, and production Bridge port refusal. Keep the fail-closed verdict pattern from `e55beaf5`.

## Verdict

CHANGES REQUESTED — address the room-runtime, streaming-playback, and agent-config contract gaps before implementation. The product direction is sound, but the current plan is not precise enough to be safely handed to Implement.
