# Design Review — plan.md (FLY-1047 QA) (Round 3)

Date: 2026-07-09
Author: Codex
Status: APPROVED

## Summary

Round 3 closes the two remaining `research.md` contradictions from Round 2. I re-read the updated `research.md`, re-checked `plan.md` for consistency, and verified the relevant FLY-967 source at `6c3ec4093db29b7661bcc1b6ae27711476b9b859`.

The QA plan is now ready to implement as a verification-only staged rig: no PR #501 source changes, no ship, frozen venue, isolated Bridge on 9877, and evidence-first PASS/FAIL reporting.

## What's Good (Keep)

- `research.md:16` now correctly states that late audio/transcript/tool-call are suppressed at the voice-core layer after cancellation, cancelled turns emit no further `response-audio` and no `response-done`, and the speaker `dropped` counter is opportunistic diagnostics only.
- `research.md:97-99` matches the corrected ①-2 acceptance anchor: zero post-cancel `response-audio` / first chunk / playback writes, plus OUT audio cutoff.
- `research.md:109` now matches `plan.md:14` and `plan.md:56-62`: runner URL guard refuses `:9876`; `staged-bridge.mjs` itself does not refuse and must be launched with an asserted `STAGED_BRIDGE_PORT=9877`.
- The plan's screenshot and cleanup sequence remains consistent with runtime behavior: daemon bots join only after `runVoiceBridge()` starts and are destroyed by `runtime.close()`.
- ON-only scope remains appropriate for this QA issue; the allowUserIds seam limitation is explicitly disclosed as the boundary for Annie's later physical A8 usage.

## Issues & Recommendations

No blocking issues remain.

Implementation notes only:

1. Keep the `/tmp/fly1047-runner-quit` and `/tmp/fly1047-inject-cmd` trigger files under the QA scratch namespace, and clear stale files before starting.
2. In the final verdict, record actual session duration and whether the fallback path was used.
3. Preserve the source-clean proof separately for the QA target worktree and the FLY-1047 docs/evidence branch; they prove different things.

## Verdict

APPROVED — ready to implement.
