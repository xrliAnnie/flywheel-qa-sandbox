# Design Review — FLY-1006 plan.md (Round 2)

Date: 2026-07-08
Author: Codex
Status: APPROVED

## Summary

Round 2 closes the six Round 1 blockers with concrete, source-aware implementation gates. The plan is now feasible to hand to Implement: it explicitly separates agent create/patch/readback, promotes the shared VC room runtime before adding `/eleven`, uses a streaming mouth for PCM output, fixes the M1 signed-url/persona contract, hardens the ElevenLabs WS client, and gives the staged venue concrete fail-closed scripts.

## What's Good (Keep)

- S1 now matches the actual FLY-980 scripts: `create-agent.mjs` is treated as secret/override/model scaffolding only, while `patch-agent.mjs` applies cascade timeout, soft timeout, and `tts.agent_output_audio_format="pcm_24000"` with GET readback gates (`plan.md:56-68`).
- S2 now has a reproducible M1 contract: the local server returns `{signedUrl, lead:{voiceId,prompt}}`, key stays server-side, and tracked 3-Lead persona files are declared as deliverables with fail-loud startup tests (`plan.md:74-92`).
- S5b correctly identifies the FLY-967 private `SessionSlot`/`EarsReceiver` problem and puts the shared `VoiceRoomRuntime` lift before any `/eleven` work (`plan.md:123-135`).
- S6 adds the right WebSocket hardening: mandatory unique `custom_llm_extra_body.conversation_id`, ping/pong handling, metadata format checks, and evidence that the id reaches shim jsonl (`plan.md:141-156`).
- S7 now uses the correct streaming audio abstraction instead of `LeadSpeaker`'s discrete queue, with explicit turn mapping and tests for raw-stream count, flush, late-chunk drop, and backpressure (`plan.md:160-186`).
- S8 is now testable rather than aspirational: the two named scripts define env contracts, prod-port refusal, SIGTERM cleanup, transcript source, barge-in survival, bidirectional slot contention, and exit-1 fail-closed behavior (`plan.md:190-205`).

## Issues & Recommendations

1. **Non-blocking doc consistency cleanup: research.md still has one stale `LeadSpeaker` phrase.**

   The plan and research module table now correctly name `AssistantSpeaker` as the streaming mouth (`research.md:105-111`, `plan.md:160-186`). However, the earlier audio-hop paragraph still says `upsample24kMonoTo48kStereo -> 48k s16le stereo -> LeadSpeaker` and describes stop/clear-queue semantics (`research.md:86-93`). This no longer matches the approved plan.

   Why it matters: this is not an implementation blocker because `plan.md` is explicit and internally consistent, but it can confuse an implementer who skims research first.

   Suggested fix: before or during implementation, update that research paragraph to say streaming mouth / `AssistantSpeaker` or same-shape `ElevenSpeaker`, with `flush` rather than `LeadSpeaker.stop()`/queue clearing.

## Verdict

APPROVED — ready to implement. The remaining item is a minor research-doc wording cleanup, not a blocker to the plan.
