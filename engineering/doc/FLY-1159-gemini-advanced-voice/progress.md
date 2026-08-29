---
issue: FLY-1159
phase: implement
phaseCursor: 5/6
updated: 2026-07-11T17:50:00.000Z
nextStep: "REWORK (founder changes-requested, epoch 5): two-command shape DONE on
  03f885b8 (/gemini byte-frozen; /gemini-advanced separate command carries
  delegate_task; voice-bridge 348/348; build/typecheck/lint/guard green; docs v2).
  Remaining: Codex incremental review on rework head -> new code-review.json +
  await-codex-gate -> NEW gate approve_to_ship --no-block + complete needs_review
  (review window resets) -> park. QA re-verdict follows; Annie real-voice tests
  /gemini-advanced ONLY."
chunks: []
pointers: {}
---

# FLY-1159 progress
**phase**: implement (5/6, epoch 5 rework) — founder pinned the two-command contract
(2026-07-11: /gemini -> just Gemini Live; /gemini-advanced -> Gemini Live + Gemini
Agent, both voice). Rework committed (03f885b8): advanced.commandName config
(default gemini-advanced, collision fail-fast), second GeminiCommand registered when
advanced configured, plain factory built from advanced-stripped config (byte-freeze
by construction), shared SessionSlot, runtime/health expose the advanced name.
Tests: 348/348 (two-command registration + byte-freeze + injection through the REAL
factory + config cases). Docs: exploration §2 = v2 contract; handoff carries a v2
correction banner; plan QA oracle updated (Annie tests /gemini-advanced only).
**next**: Codex incremental (new head) -> hard gate -> re-handoff (new bound gate +
fresh complete needs_review) -> park. No worktree commits after the ledger push.
