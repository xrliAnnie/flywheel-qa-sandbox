# Design Review — plan.md (FLY-1047 QA) (Round 1)

Date: 2026-07-09
Author: Codex
Status: CHANGES REQUESTED

## Summary

The QA shape is directionally right: it verifies PR #501 at the frozen head in an isolated worktree, uses the staged Discord venue, keeps PR source read-only, and exercises the real Gemini Live server-VAD path rather than a local shortcut. I verified the main code claims against `/Users/xiaorongli/Dev/flywheel-FLY-967` at `6c3ec4093db29b7661bcc1b6ae27711476b9b859`; the barge-in default, `allowUserIds` seam, `NO_INTERRUPTION` pin, opening-window logs, and staged runner assumptions mostly match.

I would not send this to implementation unchanged because a few execution-contract details can produce flaky runs or false evidence interpretation. These are plan fixes, not feature-code changes.

## What's Good (Keep)

- The source-target split is correct: PR code is treated as read-only ground truth, and the actual QA run happens in a fresh detached worktree at the PR head.
- `bargeIn` default ON is real (`packages/voice-bridge/src/assistant/config.ts:123`) and is threaded to voice-core as `assistant.bargeIn !== false` (`assistant/wiring.ts:638`).
- The server-VAD cancellation path exists as claimed: `genaiConnector.ts:154` maps `serverContent.interrupted`, `GeminiLiveBackend.ts:291-292` cancels the turn, and `AssistantSession.ts:331-333` logs `response cancelled (barge-in) — flushing speaker` and calls `speaker.flush()`.
- The `allowUserIds` seam is the right QA entry point: `EarsReceiver.admitted()` is `isHuman(userId) || this.allow.has(userId)` and admitted users then use the same decode/downmix/onFrame path as humans.
- Reusing the staged Bridge/daemon rig is consistent with the prior FLY-967 safety work: `gemini-staged.mjs` pins default `FLYWHEEL_BRIDGE_URL` to `127.0.0.1:9877` and refuses `:9876`; `staged-bridge.mjs` uses in-memory `StateStore` and SIGTERM cleanup.
- ON-only scope is sound for this issue. OFF/no-interruption speaker-echo validation is a different physical rig and should not block this QA.

## Issues & Recommendations

1. The runner hold window is too short for the stated two-act procedure.

   Why it matters: the plan says the custom runner defaults `STAGED_HOLD_MS` to `300000` so both acts happen in one daemon lifetime, but the underlying staged runner sleeps for `HOLD_MS` and then calls `runtime.close()` (`packages/voice-bridge/e2e/gemini-staged.mjs:96-100`). Five minutes is inconsistent with the plan's own P3/P4 estimates of about 10 minutes each and leaves little room for manual Chrome confirmation, prompt latency, or the fallback path.

   Suggested fix: make `qa1047-runner.mjs` wait for an explicit `/tmp/fly1047-runner-quit` or raise the default hold to a bounded value that actually covers the planned procedure, e.g. 10-12 minutes, with an explicit manual shutdown step once evidence is captured. Keep the Gemini audio-session limit in mind and record the actual session duration in the verdict.

2. The `dropped` counter is not a reliable ① barge-in anchor for server-side cancellation.

   Why it matters: after `interrupted`, `GeminiLiveBackend` marks the turn cancelled and drops later `audio` before emitting `response-audio` (`GeminiLiveBackend.ts:251-254,291-292`). `AssistantSpeaker.droppedChunks` only increments if `feed()` is called while inactive (`AssistantSpeaker.ts:64-67`), and it is logged from `endTurn()` on clean `response-done` (`AssistantSpeaker.ts:96-100`), which cancelled turns do not emit (`GeminiLiveBackend.ts:256-260`). So the plan's "late chunks 进 dropped 计数" can be absent even when the implementation is behaving correctly.

   Suggested fix: change ①-2 to require no post-cancel `response-audio` / speaker first-chunk / playback writes for the same turn, plus OUT-capture tail cutoff. Treat `dropped` as opportunistic diagnostic evidence only, not a PASS/FAIL requirement.

3. The production-port hard-refusal statement is only true for the runner, not for `staged-bridge.mjs`.

   Why it matters: `gemini-staged.mjs` refuses `FLYWHEEL_BRIDGE_URL` containing `:9876` (`e2e/gemini-staged.mjs:43-48`), but `staged-bridge.mjs` itself accepts `STAGED_BRIDGE_PORT` and defaults to 9877 without rejecting 9876 (`e2e/staged-bridge.mjs:30-51`). The plan repeatedly says the script hard-refuses 9876. The default command is safe, but the contract is overstated and an inherited env var could bind the isolated Bridge to the production-default port if it is free.

   Suggested fix: in the QA scratch launcher or shell command, force and assert `STAGED_BRIDGE_PORT=9877` before starting the staged Bridge. Example contract: `STAGED_BRIDGE_PORT=9877 node .../staged-bridge.mjs`, plus a preflight that aborts if `STAGED_BRIDGE_PORT` is anything else. No PR source change is required.

4. The VC screenshot/cleanup expectations should be made internally consistent.

   Why it matters: P3 asks for a screenshot showing Annie + Note-taker + probe before the QA runner starts, but the Note-taker is joined by `runVoiceBridge()` after daemon startup (`src/cli.ts:141-154`). P5 also says the final VC should contain only the resident Note-taker, while the redline says all participants exit and `runtime.close()` destroys all bots (`src/cli.ts:177-190`). This does not break the rig, but it can confuse evidence review.

   Suggested fix: take two screenshots: before runner start, Annie + probe in VC to prove `initial-check` should see a human; after runner start, Annie + probe + Note-taker + orchestrator to prove the rig is assembled. At cleanup, assert the actual intended final state explicitly: either empty VC, or only a known external resident bot if one exists outside this daemon.

## Verdict

CHANGES REQUESTED — address the execution-contract items above, then the plan should be ready to implement without changing PR #501 source.
