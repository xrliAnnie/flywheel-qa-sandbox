# Design Review — plan.md (FLY-968) (Round 1)

Date: 2026-07-07
Author: Codex
Status: CHANGES REQUESTED

## Summary
The plan is pointed at the right research question and keeps the scope appropriately limited to spikes, evidence, and docs. The OpenAI-first sequencing is correct, and the local/official evidence I checked supports the broad premises: Gemini Live native audio is AUDIO-only, OpenAI Realtime supports text-only output, and `voice-core` already reserves an `openai-realtime` backend id.

I am requesting changes because the current multi-Gemini go/no-go can still produce a misleading "go" without proving two hard product constraints: PRD latency and per-agent voice quality/distinctness. The gated multi-session context test also needs one stronger cross-agent scenario so the research does not overstate "context retained."

## What's Good (Keep)
- P1 before P3 is the right value order: OpenAI text-out is the cheapest way to revive the original 545 B architecture, so it should be falsified first.
- Scope discipline is good: `plan.md` explicitly avoids product code and constrains output to spike scripts, evidence, `bakeoff.md`, recommendations, and founder HTML (`plan.md:19-24`, `plan.md:135-142`).
- The spike methodology mostly follows the S1/FLY-960 precedent: independent `engineering/spike/**`, checked-in README/repro instructions, ignored `out/` logs, event JSONL, monotonic clocks, and speech-end anchoring (`plan.md:30-44`; FLY-960 used the same spike/evidence split).
- The OpenAI text-out assumption is currently consistent with official docs: current OpenAI Realtime API reference says `output_modalities: ["text"]` disables model audio output. The model-name check in P1 is also important because current docs now show `gpt-realtime-2.1`, not a stable generic `gpt-realtime` name.
- The `voice-core` claim is true with the expected nuance: `VoiceBackend.id` already includes `"openai-realtime"` (`packages/voice-core/src/types.ts:86-92`), while the current event map has `response-audio` and `transcript` but no explicit `response-text` event yet (`packages/voice-core/src/types.ts:121-134`), matching research.md's note that text-out still needs a small extension.
- The S1 facts are correctly carried forward: Gemini TEXT modality is server-rejected and AUDIO first chunk was 797-1017ms (`engineering/doc/FLY-545-huddle-mode/evidence/s1-gemini-text-modality.md`, branch `flywheel-FLY-545`, lines 8-11 and 46-50).

## Issues & Recommendations
1. **Multi-Gemini go/no-go omits two hard gates: latency and usable distinct voices.**
   Why it matters: `plan.md` runs a V6 latency measurement and mentions V8 only partly, but the final T3 go/no-go criterion only requires "only the named speaker talks + context retained + cost <=2x" (`plan.md:89-95`). PRD §15 makes >1.5s first-sound broken (`product/doc/FLY-906-voice-product-experience/prd.md:322-333`), and PRD §17 makes per-agent distinct voices a hard requirement (`product/doc/FLY-906-voice-product-experience/prd.md:376-399`). As written, the plan could label multi-Gemini "go" even if 3-session latency regresses past the broken band or the three Gemini voices are not distinguishable/usable in Chinese.
   Suggested fix: make the T1 verdict matrix explicit. For example: GO requires V3 pass, V5 pass, V6 <=1.2s, V8-Gemini >=3 Chinese-usable and clearly distinguishable voices, and measured/extrapolated cost <=2x single session. 1.2-1.5s should be qualified-go with latency caveat; >1.5s should block Huddle go for §15. Voice failure should block per-agent Gemini go even if orchestration works.

2. **V8-Gemini is in research.md but not actually planned as an executable step.**
   Why it matters: research.md defines V8 as "OpenAI 10 voices + Gemini 30 voices" and requires each vendor to yield at least three usable Chinese voices (`engineering/doc/FLY-968-voice-model-bakeoff/research.md:170-183`). `plan.md` only sweeps OpenAI voices in P2 (`plan.md:66-74`). P3 merely starts three Gemini sessions with different voices and records self-intro WAVs (`plan.md:76-82`), which does not objectively select from the Gemini voice set or prove Chinese quality/distinctness.
   Suggested fix: add a small P2b/P3a Gemini voice sweep before the multi-session orchestration run. It can be cheap: generate one fixed Chinese sentence for all 30 documented Gemini voices or a pre-declared shortlist if the $5 cap is tight, score 0-2/0-3 for Chinese intelligibility and distinctness, save WAVs in evidence, and use the top three in `s4-gemini-multisession.mjs`.

3. **The gated+补喂 context test does not clearly cover cross-agent assistant context.**
   Why it matters: exploration.md explicitly calls out that independent sessions will not hear each other's audio answers and asks whether Lead A's answer must be transcribed and fed to B/C (`engineering/doc/FLY-968-voice-model-bakeoff/exploration.md:64-75`). P3 T3-c says to feed text to unaddressed sessions and later verify they can cite the fed facts (`plan.md:85-88`), but it does not specify whether the fed facts include other agents' model-generated answers, not just Annie's prompts. That can produce a false "context retained" verdict for real meetings where Lead B must know what Lead A just answered.
   Suggested fix: script one mini dialogue where session A introduces a unique fact in its answer, that answer transcript is injected into sessions B/C, then B is later asked a question that requires that fact. Log the exact injection payloads and separately judge: no unsolicited speech during补喂, correct later citation, and behavior when the answer transcript is intentionally not fed as a negative control.

4. **The "other vendors" shallow sweep is under-specified in the executable plan.**
   Why it matters: exploration.md scopes Track 3 as a per-vendor shallow sweep across Nova, Hume, ElevenLabs, xAI, and Chinese realtime candidates (`engineering/doc/FLY-968-voice-model-bakeoff/exploration.md:97-109`). `plan.md` only has an executable P4 for ElevenLabs and relies on P5 to fold in the old research table (`plan.md:97-115`). Because research.md labels Track 3 as E4/depth-limited (`engineering/doc/FLY-968-voice-model-bakeoff/research.md:156-168`, `research.md:197-198`), an implementer can currently skip a fresh doc-level check for xAI/Qwen/etc. and still appear to satisfy "other players有无 dark horse."
   Suggested fix: add a P4.5 doc-only refresh step with a hard timebox and one evidence markdown row per no-key vendor: official docs URL/date, text-out status, voice/custom voice status, tool support, Chinese support, pricing if public, and recommendation (`ignore`, `watch`, or `follow-up`). Keep ElevenLabs as the only real-machine non-mainline vendor unless the timebox finds a blocker-level surprise.

## Verdict
CHANGES REQUESTED — address items above before handing this to implementation.
