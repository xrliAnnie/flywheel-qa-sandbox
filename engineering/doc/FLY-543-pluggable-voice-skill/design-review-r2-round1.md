# Design Review — plan.md r2 (FLY-543) (Round 1)

Date: 2026-07-06
Author: Codex
Status: CHANGES REQUESTED

## Summary
The r2 direction is sound: the scope has been tightened to exactly the two round-1 surfaces Annie asked for, and the announce/converse split matches both Edge TTS and Gemini Live better than the old pipeline-shaped abstraction. I am not approving it yet because a few concrete implementation contracts contradict each other; if an implementer follows this plan verbatim, argv hygiene, first-turn streaming/resume, and Gemini interrupt semantics can be implemented incorrectly.

## What's Good (Keep)
- The scope boundary is much cleaner than the original plan: Edge TTS is speak-only, Gemini Live is the realtime voice conversation backend, and local whisper/CosyVoice/Qwen plus standalone STT are explicitly deferred (`plan.md:15-38`, `plan.md:315-321`; `exploration.md:164-181`).
- The new `AnnouncerSession` / `ConversationSession` split is the right abstraction for independent speech-out and speech-in+out capability faces (`plan.md:59-64`, `plan.md:117-128`; `research.md:96-107`).
- The package placement and build shape match this repo’s package convention: `packages/*` workspace, `type: module`, `tsc` to `dist`, package `bin`, and Vitest, consistent with `packages/token-usage/package.json` and `pnpm-workspace.yaml`.
- The Lead brain boundary is now honest: `claude -p` is a zero-tool, read-only Lead persona approximation, not a full `claude-lead.sh` runtime with Bridge/action authority (`plan.md:25-32`; `research.md:38-50`; `claude-lead.sh:574-601`, `1656-1842`).
- The main Gemini Live API claims checked out against current official docs: 16kHz PCM input, 24kHz PCM output, bidirectional transcriptions, GoAway, session resumption at setup/connect time, and `toolCallCancellation` are real Live API concepts. Sources: https://ai.google.dev/gemini-api/docs/live-api/capabilities, https://ai.google.dev/gemini-api/docs/live-api/session-management, https://ai.google.dev/api/live.
- The plan’s zero Bridge/StateStore claim is credible: the r2 implementation is a new package plus POC CLI, and the diff currently contains only doc/evidence files.

## Issues & Recommendations
1. **The POC-A CLI violates the plan’s own argv hygiene contract.**

   Why it matters: `plan.md:219-221` says user/assistant text and prompts must not enter argv, but `plan.md:259-260` defines the primary demo command as `flywheel-voice-poc say "文本"`. That puts report/briefing text into the `flywheel-voice-poc` process argv even if the child `edge-tts` call later uses `--file`. This matters because the stated use case is reading reports/briefings aloud, and the inherited argv hygiene contract exists specifically to prevent process-table leakage of spoken text, secrets, issue IDs, tokens, or operational commands.

   Suggested fix: make `say --stdin` and/or `say --file <path>` the primary documented interface and acceptance path. If a positional text shortcut remains, mark it explicitly as non-sensitive demo-only and exclude it from A7, or better remove it for round-1. Add parser/unit coverage that the child subprocess argv never contains text, and update the plan so the top-level CLI contract is not contradicting the subprocess contract.

2. **HeadlessClaudeBrain’s first-turn resume plan conflicts with its streaming contract.**

   Why it matters: the `BrainAdapter.respond()` contract returns `AsyncIterable<string>` (`plan.md:189-194`), and S0.1 says the streaming form is `--output-format stream-json --include-partial-messages --verbose` with `text_delta` extraction (`plan.md:230-236`; `evidence/spike-phase0.md:23-28`). But Phase 2 step 5 says the first turn uses `--output-format json` to capture `session_id` (`plan.md:264-268`). If implemented literally, the first voice turn is non-streaming or has a different parser path, which weakens the latency contract and creates unnecessary divergence. The spike already states stream-json events also carry `session_id`, so the non-streaming first turn is not needed.

   Suggested fix: use `--output-format stream-json --include-partial-messages --verbose` for all `respond()` calls, including the first one, and parse/cache `session_id` from the stream events. Add tests for first-turn stream parsing, `session_id` capture, and resume turns re-sending `--tools "" --strict-mcp-config`.

3. **The Gemini interrupt contract overstates what the client can send to the Live API.**

   Why it matters: `plan.md:214-216` says `interrupt()` “透传 Gemini（interrupted 事件）” and then guarantees `response-cancelled` plus no later assistant transcript. In the official Live API, `serverContent.interrupted` is an output signal from the server indicating a client message/activity interrupted generation; it is not itself a client command. The API also documents `toolCallCancellation` as an output notification. If a manual CLI interrupt only kills `ffplay`, Gemini may still be generating server-side unless the adapter sends a real interrupting input/activity or explicitly treats the rest of that server turn as locally suppressed. As written, the plan can lead to tests that mock a nonexistent client-side “interrupted event” instead of testing the actual protocol.

   Suggested fix: split the contract into two cases. For natural barge-in, map Gemini’s server `interrupted` signal to local playback stop, `response-cancelled`, transcript suppression, and any `toolCallCancellation` handling. For manual local interrupt, specify the actual supported client action to send, or state it is local suppression only and do not claim server-side cancellation; abort any in-flight `ask_lead` brain call either way. Add mock Live tests for both paths.

4. **The spike evidence file still contains a stale old-interface freeze conclusion.**

   Why it matters: r2 correctly says S0.2 Gemini Live spike is still pending and S0.3 must re-check §3 before freezing `types.ts` (`plan.md:239-247`). But `evidence/spike-phase0.md:41-45` says “spike 结论回照 plan §3 合同: 无需改动, types.ts 冻结” and refers to the old pipeline backend `ResumeHandle`. That was true for the recycled old implementation attempt, not for this r2 interface. Since the plan explicitly relies on this evidence for S0.1/S0.1b, leaving the stale S0.3 block invites implementers to skip the required post-Gemini interface review.

   Suggested fix: edit the evidence note to scope it only to S0.1/S0.1b facts, and replace the S0.3 block with “obsolete for r2; final interface freeze happens after S0.2 Gemini Live spike per plan.md §4.” Keep the useful `claude -p` and mic facts; remove the old pipeline `ResumeHandle` conclusion.

## Verdict
CHANGES REQUESTED — address items above before implementation follows this plan verbatim.
