# Design Review — FLY-980 plan.md (Round 1)

Date: 2026-07-07
Author: Codex
Status: CHANGES REQUESTED

## Summary

The spike direction is right: evaluating the full /eleven stack with Custom LLM, Claude brain, latency ladder, barge-in, overrides, voice audition, and cost evidence is the correct go/no-go surface. However, the plan is not executable as written against the current checkout: several repo-grounded assumptions are false or underspecified, and one ElevenLabs timeout assumption uses the wrong platform control.

## What's Good (Keep)

- Scope is disciplined: standalone `engineering/spike/FLY-980-eleven/`, no production `packages/` changes, and a separate QA replay boundary.
- V1-V10 cover the real product decision: protocol, baseline latency, Claude latency, slow-brain behavior, interruption, tools, multi-Lead overrides, voices, and cost.
- The latency ladder is the right shape: echo → API lower bound → `claude -p` production-shape brain, with `speech-end→first-audio` and shim `request→first-delta` split.
- Pricing and cost evidence direction is current for ElevenAgents: official pricing now lists Creator as 275 included call minutes, 10 concurrent calls, $0.080 additional minutes, and $0.160 burst minutes: https://elevenlabs.io/pricing/agents
- Biome assumption is correct: `biome.json` includes `**`, and a current FLY-968 spike `.mjs` is checkable by `pnpm exec biome check`.

## Issues & Recommendations

1. **The OpenAI messages → `HeadlessClaudeBrain` adapter is underspecified, and V8 cannot pass as written.**

   `BrainAdapter.respond()` takes `{ text, history }`, not raw OpenAI chat messages (`packages/voice-core/src/types.ts:149`). `HeadlessClaudeBrain` has a fixed `identityFile` constructor option and only sends that identity on the first non-resume turn (`packages/voice-core/src/brain/HeadlessClaudeBrain.ts:38`, `:74`, `:84`). The plan says the shim parses/logs `messages` and uses one test persona identity file (`engineering/doc/FLY-980-elevenlabs-tts-spike/plan.md:63`, `:69`), but V8 expects per-session Tadashi vs Cass persona override to change self-identification (`plan.md:124`). As written, platform system prompt/persona overrides can be ignored by the brain, and a singleton resume session can cross-contaminate separate ElevenLabs conversations.

   Suggested fix: S1 must define a deterministic adapter: extract the last user message, map prior user/assistant messages to `Turn[]`, handle system prompts explicitly, and key `HeadlessClaudeBrain` instances by ElevenLabs conversation/session id. For V8, either choose the identity file per session/Lead or synthesize a spike-only identity file from the allowed override before the first non-resume call. For `FLY980_RESUME=0`, instantiate fresh or use `useResume:false` so the full-history condition is real.

2. **`cwd = 空目录` is not supported by the current `HeadlessClaudeBrain` interface.**

   The plan requires `cwd = ~/fly980-eleven/cwd-empty/` (`plan.md:72`), and research makes empty cwd a key latency variable (`research.md:53`). But `HeadlessClaudeBrainOptions` has no `cwd`, and `respond()` calls `this.runner.spawn(this.opts.claudeBin, args)` without spawn options (`packages/voice-core/src/brain/HeadlessClaudeBrain.ts:38`, `:99`). `ProcessRunner.spawn()` does support `cwd`, but only if the caller passes it (`packages/voice-core/src/process.ts:34`, `:52`, `:147`).

   Suggested fix: keep D8' by using a spike-only `ProcessRunner` wrapper that forwards `spawn(cmd,args,{cwd: emptyDir})`, and make that explicit in S1. Treat empty cwd verification as a V4 evidence line, not an implicit claim.

3. **V5 is using the wrong ElevenLabs timeout control for slow LLM behavior.**

   The plan says to test slow brain behavior by comparing `turn_timeout` 7s vs 15s (`plan.md:37`, `:112`). Official ElevenLabs docs define `conversation_config.turn.turn_timeout` as "take turn after silence", i.e. how long the assistant waits during user silence before taking the next turn, not how long the platform waits for a slow LLM response. The slow-LLM feature in the docs is "Soft timeout", which speaks a filler while continuing to wait for the actual response: https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow

   Suggested fix: split V5 into (a) endpointing/turn-taking behavior using `turn_timeout`, and (b) slow custom-LLM response behavior using soft timeout / buffer words / platform wait behavior. The go/no-go question is (b); do not let a `turn_timeout` experiment stand in for it.

4. **Fresh checkout assets referenced by the plan are missing.**

   FLY-980 exploration/research references `ref/u1-16k.pcm / u2-16k.pcm` as reusable assets (`exploration.md:81`, `research.md:159`), and `s5-elevenlabs-agent.mjs` hard-reads exactly those files (`engineering/spike/FLY-968-voice-bakeoff/s5-elevenlabs-agent.mjs:21`). In this checkout, `engineering/spike/FLY-968-voice-bakeoff/ref/` only has `utterances.md`; `.pcm` files are gitignored (`.gitignore:4`) and must be generated by `gen-ref-audio.sh`. The plan also relies on `scripts/voice-audition-fly546.mjs`, but no such file exists in this checkout.

   Suggested fix: add S0 hard steps to run/verify `engineering/spike/FLY-968-voice-bakeoff/gen-ref-audio.sh` or generate local FLY-980 equivalents, and inline the 8-Lead persona/voice requirements into the plan or point to an existing accessible file/commit. Without that, V2/S4 and V9 are not reproducible from the repo.

5. **The current `s4b-voice-judge.mjs` is only a method reference, not a drop-in V9 judge.**

   `s4b` hardcodes one Chinese sentence and emits one global top-3 ranking for a vendor (`engineering/spike/FLY-968-voice-bakeoff/s4b-voice-judge.mjs:22`, `:76`). FLY-980 V9 needs 8 Leads, at least two candidates per Lead, zh/en/mixed samples, and per-Lead final recommendations (`plan.md:41`, `:137`).

   Suggested fix: state that `audition.mjs` includes a new parameterized judge layer: expected sentence(s), language tag, lead id, candidate voice id, and per-Lead scoring output. Keep `s4b` as methodology precedent, not as the executable judge.

6. **S3 needs an explicit fail-closed create-agent validation step.**

   Official Custom LLM docs confirm OpenAI-compatible `/v1/chat/completions` or `/v1/responses`, SSE `data: {json}\n\n`, `[DONE]`, and standard OpenAI-format `tools`: https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm. Overrides docs confirm voice/language/prompt/LLM overrides are security-gated: https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides. But the public create-agent API reference only exposes `conversation_config` as an object and does not document the nested `custom_llm.request_headers` or security override fields: https://elevenlabs.io/docs/api-reference/agents/create. Prior FLY-968 V10 evidence also says "见本文件参数" but does not preserve the actual non-secret agent JSON.

   Suggested fix: make S3 first create the minimum agent, immediately `GET` it back, and write a redacted config snapshot to evidence. If `request_headers` is rejected, fall back to documented secret/API-key configuration or a one-time dashboard setup, then record the exact working shape. If Security override API fields are rejected, stop V8 until the dashboard/manual enablement is done and captured.

## Verdict

CHANGES REQUESTED — address items above before implementation.
