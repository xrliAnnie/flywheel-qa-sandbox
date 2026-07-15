# Design Review — plan.md r2 (FLY-543) (Round 2)

Date: 2026-07-06
Author: Codex
Status: APPROVED

## Summary
Round 2 closes all four Round 1 blockers in the actual updated documents. The r2 plan is now buildable as the tightened round-1 foundation: Edge TTS for announce, Gemini Live for realtime conversation, no local models or standalone STT, no Bridge/StateStore changes, and the inherited safety/cancellation/argv/latency/type contracts are concrete enough for implementation.

## What's Good (Keep)
- The top-level CLI now obeys the same argv hygiene contract as child subprocesses: POC-A accepts text only via `say --stdin` or `say --file <path>`, with no positional text form and tests covering both this process argv and child argv (`plan.md:227-229`, `plan.md:267-272`).
- HeadlessClaudeBrain now has one streaming path for every turn, including the first: `stream-json + include-partial-messages + verbose`, `text_delta` extraction, and `session_id` capture from stream events (`plan.md:237-244`, `plan.md:275-282`; `evidence/spike-phase0.md:23-28`).
- The Gemini interrupt contract now matches the official Live API shape: server `interrupted` is treated as an output signal for natural barge-in, while manual `interrupt()` is explicitly local suppression and does not claim server-side cancellation (`plan.md:214-224`, `plan.md:283-292`; `research.md:156-162`). This aligns with Google’s API reference for `serverContent.interrupted` and `toolCallCancellation`.
- The stale spike evidence is now clearly scoped: only S0.1/S0.1b machine facts remain valid, and the old S0.3 interface-freeze conclusion is marked obsolete for r2 (`evidence/spike-phase0.md:41-46`).
- The core round-1 scope remains clean: no Discord voice bridge, no product use-case flow, no voice cloning, no transcript-to-Linear implementation, no local whisper/CosyVoice/Qwen implementation, no standalone STT, and no Bridge/StateStore change (`plan.md:34-38`, `plan.md:329-335`).
- Repo fit still checks out: `packages/voice-core` follows the `packages/*` workspace/package shape, while the Lead identity premise is grounded in the actual `claude-lead.sh` identity and rule injection flow rather than pretending `identity.md` equals a full Lead runtime.

## Issues & Recommendations
1. **No blocking issues found.**

   Why it matters: the updated plan gives implementers concrete contracts for the previously ambiguous areas: argv-safe text entry, a single streaming Claude parser path, Gemini interrupt semantics, and evidence scoping before interface freeze.

   Suggested fix: none required before implementation.

2. **Implementation note: keep the manual-interrupt/tool-call edge case explicit in code tests.**

   Why it matters: the plan correctly says manual interrupt is local suppression only. During implementation, if manual interrupt happens while an `ask_lead` function call is in flight, the adapter should avoid wedging the Live session: either close/reconnect/resume, or send an explicit safe tool response if the S0.2 spike proves that is the right protocol shape.

   Suggested fix: add this as a test case under step 6 when building `GeminiLiveSession`. This is not a design blocker because the plan already requires S0.2 protocol confirmation and a post-spike interface review before freezing `types.ts`.

3. **Implementation note: clean minor stale wording in the spike file when convenient.**

   Why it matters: `evidence/spike-phase0.md` is now correctly scoped, but the mic section still mentions old whisper/gate observations as historical machine facts. The top note prevents this from becoming an implementation contract, so it is not blocking.

   Suggested fix: when committing the final docs, consider renaming the mic heading to S0.1b and marking the whisper/gate sentence as historical/out-of-scope for r2.

## Verdict
APPROVED — ready to implement.
