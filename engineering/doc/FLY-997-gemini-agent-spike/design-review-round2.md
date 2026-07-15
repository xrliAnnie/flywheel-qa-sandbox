# Design Review — FLY-997 plan.md (Round 2)
Date: 2026-07-08
Author: Codex
Status: APPROVED

## Summary
Round 2 closes the Round 1 blockers. The plan is now executable as a research spike against the current checkout: it separates model/tool-loop reliability from production integration, makes the sandbox fail-closed, and no longer overclaims what the mock guardrail experiment can prove.

## What's Good (Keep)
- S3 is now realistic: no `flywheel-voice-poc talk` assumption, a spike-local Live harness passes `extraTools`, and mode a vs mode b are measured and concluded separately.
- The mock contract table now matches the real production route shape closely enough for the matrix to produce valid reliability data, with spike-stricter schemas explicitly labeled.
- The sandbox guard is executable, not aspirational: localhost-only client, Bridge env hard-fail, no `@linear/sdk` / `flywheel-comm` imports in the harness, and outbound origin evidence.
- V8 now has the right evidence boundary: behavior observation and toy-surface red line only; D5 carries the build-shape static guardrail audit and S-b downgraded-token requirement.
- SDK/API drift is handled up front in S1, with Interactions API as the primary current surface and generateContent only as a recorded fallback.
- Evidence hygiene is now part of the contract: committed summaries/manifest in `evidence/`, raw JSONL under gitignored `out/`, and redaction rules before review.

## Issues & Recommendations
1. **Non-blocking research.md wording drift remains.**

   `research.md` now has the correct S3 reality in §3.5, but a few older references still say results land via `when_idle` (`research.md` diagram line 102, V6 row line 161, risk line 171). The current `plan.md` is the implementation contract and is clear, so this is not a blocker.

   **Suggested fix:** before handoff, change those residual research references to "ACK + later new-turn reinjection; true async scheduling probed separately" so upstream readers do not reintroduce the old assumption.

2. **Minor evidence diagram mismatch.**

   `plan.md` D2 and acceptance correctly split committed `evidence/` from raw `out/`, but the mermaid diagram still labels judge output as `evidence/*.jsonl`. This is harmless because the delivery table and acceptance criteria are authoritative.

   **Suggested fix:** if touching the doc again, relabel the diagram node to `evidence/manifest + out/*.jsonl`.

3. **Implementation note: scope the static grep assertion carefully.**

   The S1 grep guard for `@linear/sdk` and `flywheel-comm` should target harness source files, not generated lockfiles, README snippets, or the whole repo. The plan intent is clear; this is just to prevent a false-positive smoke failure.

   **Suggested fix:** record the exact grep command in evidence, e.g. scoped to `*.mjs` / source files under `engineering/spike/FLY-997-gemini-agent/`.

## Verdict
APPROVED — ready to implement.
