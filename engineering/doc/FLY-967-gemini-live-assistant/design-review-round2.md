# Design Review — FLY-967 plan.md (Round 2)

Date: 2026-07-07
Author: Codex
Status: APPROVED

## Summary

Round 2 closes the six Round 1 blockers. The updated plan now has an explicit `sendText` control-input contract for Gemini speak-first behavior, uses `conversation.interrupt()` for local barge-in suppression, removes the unsupported `languageCode` config, scopes Linear calls by `projectName`, adds landing rerun idempotency, and makes the recent-decisions briefing mechanism implementable with the existing route.

I re-checked the affected seams against the current code and sibling plan: current voice-core still lacks `sendText` today, so the new §5.1/P1 extension is real work; current `interrupt()` is local suppression as the plan now states; Bridge create/list routes already support `projectName`; and FLY-545 P12 already requires project-scoped issue lookup. The remaining notes below are cleanup-level and should not block implementation.

## What's Good (Keep)

- The speak-first gap is now handled directly: §5.1 adds `ConversationSession.sendText(text)` and §6 uses it for both the opening line and the concluding recap trigger (`engineering/doc/FLY-967-gemini-live-assistant/plan.md:153-165`, `248-257`).
- Local barge-in now matches the actual voice-core cancellation contract: `speaker.flush()` plus `conversation.interrupt()`, with explicit tests for late audio, transcript suppression, tool abort, and next-turn recovery (`plan.md:274-281`).
- The Gemini language config is now aligned with current Live API docs: voice selection remains in `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`; language constraints stay in prompt text (`plan.md:117-121`, `289-291`).
- Linear scope is now explicit: `BridgeLinearClient` requires `projectName`, `lookup_issue` carries `projectName`, and tests assert project scope on create/list/lookup paths (`plan.md:184-199`, `299-301`).
- Landing retry behavior is materially safer: a local `landing-receipt.json` plus `assistant-summary <sessionId>` marker prevents duplicate comment posting after close failure (`plan.md:259-267`).
- The briefing route limitation is no longer hidden: recent decisions are fetched with `state=Done&limit=50`, then filtered by `updatedAt` client-side with a truncation note (`plan.md:223-225`).

## Issues & Recommendations

1. Non-blocking cleanup: remove the stale `languageCode` residue in §5.1.

   Why it matters: The config block and P1 tests correctly say not to send `languageCode`, but one bullet still says ``speechConfig`(voiceName/languageCode)` (`plan.md:170-172`). That line now contradicts the rest of the plan.

   Suggested fix: Change it to ``speechConfig`(voiceName only)` or fold it into the P1 test sentence. This is editorial cleanup, not a design blocker, because the config and test contract are already correct.

2. Non-blocking hardening: mark `sendText` control prompts as non-founder utterances.

   Why it matters: Live API text input is sent as conversation input, but the opening/recap prompts are control prompts, not Annie's words. The plan says they are "她听不到的控制提示" (`plan.md:157-159`), but AssistantLanding later quotes "原话" from JSONL (`plan.md:259`). Implementers should not accidentally log or cite "请开场" / "请做 recap" as founder utterances.

   Suggested fix: Add one sentence in §5.1 or P6: `sendText` control prompts are tagged/excluded from founder transcript and never eligible for quote extraction. A small unit test on AssistantLanding quote selection is enough.

## Verdict

APPROVED — ready to implement. The remaining recommendations are small clarity fixes that can be folded into implementation without another design review.
