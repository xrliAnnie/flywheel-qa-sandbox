# Design Review — FLY-980 plan.md (Round 2)

Date: 2026-07-07
Author: Codex
Status: APPROVED

## Summary

Round 2 addresses all six Round 1 blockers in the actual plan text. The spike is now executable against the current checkout: the shim adapter has a concrete messages-to-BrainAdapter contract, `claude -p` empty-cwd is achievable without `packages/` changes, slow-brain behavior is tested through Soft timeout rather than `turn_timeout`, missing generated assets are called out as S0 gates, V9 no longer pretends `s4b` is drop-in, and agent creation is fail-closed.

## What's Good (Keep)

- S1 now correctly treats `HeadlessClaudeBrain` as a per-conversation stateful adapter instead of a singleton string streamer; persona overrides have a real end-to-end path via per-conversation identity files.
- The empty-cwd implementation uses the existing `ProcessRunner` seam (`spawn(..., { cwd })`) and preserves the no-production-code boundary.
- V5 is now technically correct: `turn_timeout` is scoped to user-silence endpointing, while slow LLM behavior is measured through Soft timeout on/off.
- S0 now makes fresh-checkout prerequisites explicit: build `voice-core`, regenerate gitignored PCM fixtures, and avoid referencing the unmerged FLY-546 script as if it existed locally.
- S3’s create-agent flow is appropriately fail-closed: create, GET back, redact, record the accepted shape, and block V8 until override Security enablement is confirmed.
- The verdict table remains well aligned to the founder go/no-go question and the QA replay boundary is clear.

## Issues & Recommendations

1. **Non-blocking cleanup: research.md still has stale asset/import wording.**

   The plan is now correct, but `research.md` §9 still says the spike should import voice-core via a workspace dependency (`"flywheel-voice-core": "workspace:*"`) even though `pnpm-workspace.yaml` only includes `packages/*` and the plan uses a relative dist import. The same table still points to PR #496 `voice-audition-fly546.mjs` as an asset, while the plan now correctly says that file is not present and inlines the table.

   Suggested fix: before committing docs, align `research.md:162-165` with the plan: generated PCM fixtures, relative dist import after build, and inlined persona table. This is documentation consistency, not an implementation blocker.

2. **Non-blocking guardrail: expand `shim.test.mjs` beyond the original V1 four cases if time allows.**

   The new S1 adapter/session/cwd behavior is central enough that a few cheap local tests would pay for themselves: messages mapping, system prompt written to identity file, two conversation keys not sharing one resume brain, `FLY980_RESUME=0` creating fresh instances, and the cwd wrapper forwarding `{cwd}`. Real-machine evidence will still be the acceptance gate, but these tests would catch the most likely implementation slips before burning ElevenLabs quota.

## Verdict

APPROVED — ready to implement.
