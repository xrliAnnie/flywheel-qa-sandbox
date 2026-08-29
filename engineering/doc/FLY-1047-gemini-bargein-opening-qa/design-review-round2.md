# Design Review — plan.md (FLY-1047 QA) (Round 2)

Date: 2026-07-09
Author: Codex
Status: CHANGES REQUESTED

## Summary

The updated `plan.md` closes the four Round 1 execution-contract issues in the right places: explicit quit-file runner lifetime with a 12min backstop, corrected ①-2 barge-in evidence, honest runner-vs-Bridge port guarding, and consistent VC screenshots/cleanup. I re-read both updated docs and re-checked the relevant FLY-967 source at `6c3ec4093db29b7661bcc1b6ae27711476b9b859`.

The only remaining blockers are stale statements still present in `research.md`. They contradict the corrected plan/research anchor table and can mislead the QA implementer on exactly the two safety/evidence points Round 1 was about.

## What's Good (Keep)

- `plan.md:45-50` now replaces the fixed `STAGED_HOLD_MS` sleep with an explicit `/tmp/fly1047-runner-quit` lifecycle plus a bounded cap and verdict-duration reporting.
- `plan.md:78-80` and `research.md:97-99` now correctly make ①-2 about zero post-cancel response-audio / first-chunk / playback writes, with `dropped` demoted to opportunistic diagnostics.
- `plan.md:14` and `plan.md:56-62` now correctly force `STAGED_BRIDGE_PORT=9877` in the launcher and state that `staged-bridge.mjs` itself does not reject 9876.
- `plan.md:66-72` and `plan.md:85` now match runtime reality: the pre-runner screenshot is Annie + probe; the post-runner screenshot includes daemon bots; final cleanup expects an empty VC after `runtime.close()`.
- The underlying code still supports the plan: `GeminiLiveBackend.ts:251-260` suppresses post-cancel audio and does not emit `response-done` for cancelled turns; `AssistantSpeaker.ts:64-99` only increments/logs `dropped` through `feed()`/`endTurn()`; `staged-bridge.mjs:30-51` accepts any `STAGED_BRIDGE_PORT`, while `gemini-staged.mjs:43-48` refuses runner URLs containing `:9876`.

## Issues & Recommendations

1. `research.md §1.1` still says `dropped` is observable for late chunks after server cancellation.

   Why it matters: `research.md:16` still ends the cancellation chain with "late chunks 由 turn 闸拦, dropped 计数可观测". That is the old incorrect contract. In the actual code, cancelled turns suppress late audio inside `GeminiLiveBackend` before `AssistantSession`/`AssistantSpeaker.feed()` sees it, and cancelled turns do not emit `response-done`, so the `turn end — dropped=D` log may never appear.

   Suggested fix: rewrite that sentence to match the updated §3 table, e.g. "late audio/transcript/tool-call are suppressed in voice-core; QA asserts no post-cancel response-audio/playback and treats speaker dropped counts as opportunistic only."

2. `research.md §4` still repeats the old "script hard-refuses 9876" production-isolation claim.

   Why it matters: `research.md:109` says "Bridge 钉 :9877(脚本硬拒 9876)", which contradicts the corrected §2.2 and `plan.md`. The real split is: runner URL guard refuses `:9876`; `staged-bridge.mjs` only defaults to 9877 and must be pinned by the launcher. This is a safety-contract doc, so the risk section should not carry the old overstatement.

   Suggested fix: update §4 risk 6 to the same wording as §2.2/redline 3: runner refuses `:9876`; staged Bridge launcher forces/asserts `STAGED_BRIDGE_PORT=9877`; no production StateStore/config/Bridge contact; no `.env.staged` values in logs.

## Verdict

CHANGES REQUESTED — the plan-level fixes are good, but clean up the two stale `research.md` contradictions before implementation.
