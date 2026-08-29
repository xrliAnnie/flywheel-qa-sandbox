# Design Review — plan.md (FLY-543) (Round 2)

Date: 2026-07-06
Author: Codex
Status: APPROVED

## Summary
Round 2 addresses all eight Round 1 blockers in the actual plan, not just in the change summary. The design is now implementable as a scoped, read-only POC foundation: it preserves the pipeline default, makes the safety boundary explicit, adds a confirmation gate for high-risk speech, fixes cancellation/resume contracts, and updates Gemini Live assumptions to match current official docs.

## What's Good (Keep)
- The POC safety boundary is now honest: HeadlessClaudeBrain is a zero-tool, read-only Lead persona approximation, with action-capable routing deferred to bridge/use-case issues that can carry the full Lead rule stack (`plan.md:26-38`).
- ConfirmedTranscriptGate is now a real build step with tested high-risk pattern coverage, confirmation metadata in JSONL, and acceptance criteria tied back to the FLY-342 eval set (`plan.md:58-59`, `242-248`, `282-288`).
- Cancellation is first-class: `AbortSignal` is threaded through brain/STT/TTS contracts, `interrupt()` has per-state semantics, and tests must assert subprocess termination and no post-cancel assistant transcript (`plan.md:168-180`, `195-202`, `234-241`).
- Resume moved to session creation, which matches Gemini Live's connect-time `sessionResumption.handle`; `goAway.timeLeft` and rolling handles are explicitly mapped (`plan.md:127-140`, `260-270`).
- Gemini capability claims are no longer hard-coded. The adapter derives `scheduled` vs `basic` from the pinned model and actual non-blocking function/scheduling support (`plan.md:260-270`).
- Subprocess argv hygiene is now a hard contract, including edge-tts temp-file input, Claude stdin prompt input, and tests that assert transcript/prompt text never appears in argv (`plan.md:204-207`, `229-241`, `287`).
- Latency evidence is now honest: first response means `playbackStartMs`, while `ttsFirstByteMs` is reported separately (`plan.md:249-255`, `283`, `300`).
- The TypeScript contract gaps are closed with `VoiceError`, `TranscriptSink`, `TranscriptEntry`, `sessionId`, unsubscribe return, and a Phase 0 interface review before freezing (`plan.md:101-193`, `223-224`).

## Issues & Recommendations
1. **No blocking issues found.**

   Why it matters: the plan now gives implementers enough concrete interface, state-machine, safety, and evidence contracts to build from without silently changing architecture during implementation.

   Suggested fix: none required before implementation. During implementation, keep S0.1 as a real spike with captured CLI evidence, because the exact zero-tool Claude invocation is intentionally left to current CLI behavior.

2. **Implementation note: keep the Gemini docs dependency explicit in evidence.**

   Why it matters: Live API behavior is time-sensitive. I verified the current official docs: session resumption handle is configured in `sessionResumption` at connect time, tokens are valid for 2 hours after termination, `goAway.timeLeft` exists, and Gemini 3.1 Flash Live Preview only supports synchronous function calling while Gemini 2.5 Flash Live Preview supports synchronous and asynchronous. Sources: https://ai.google.dev/gemini-api/docs/live-api/session-management and https://ai.google.dev/gemini-api/docs/live-api/tools.

   Suggested fix: when Phase 2 is implemented, save a short `evidence/gemini-live-docs-checked.md` with the model id, SDK version, and doc date used for capability derivation. This is not a design blocker.

## Verdict
APPROVED — ready to implement.
