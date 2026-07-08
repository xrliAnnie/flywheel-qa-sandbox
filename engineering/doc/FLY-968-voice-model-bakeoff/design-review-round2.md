# Design Review — plan.md (FLY-968) (Round 2)

Date: 2026-07-07
Author: Codex
Status: APPROVED

## Summary
Round 2 closes the four Round 1 issues in the actual `plan.md`, not just in the summary. The plan now has explicit falsifiable gates for multi-Gemini, executable Gemini voice-sweep evidence, a stronger cross-agent context-backfill test, and a bounded doc refresh for no-key vendors.

The remaining risks are normal research-spike risks, not design blockers: vendor behavior may differ at runtime, scoring is partly subjective, and no-key vendors stay document-level by design.

## What's Good (Keep)
- The T1 verdict matrix is now objective enough to drive implementation: GO, qualified-go, and NO-GO are separated, and the two product hard gates are explicit (`V6 >1.5s` blocks Huddle under PRD §15; `V8-Gemini <3` usable/distinguishable Chinese voices blocks §17).
- P3a makes V8-Gemini executable. The plan now requires WAV evidence, a scoring table, and top-3 voice selection before the multi-session run.
- T3-c now tests the actual multi-agent context problem: founder utterance backfill, cross-agent answer backfill, logged injection payloads, and a negative control proving the backfill mechanism is necessary.
- P4.5 properly bounds the "other vendors" sweep. It avoids unplanned scope expansion while still requiring dated official-source evidence and an ignore/watch/follow-up label for each no-key vendor.
- DoD now names the new evidence artifacts: Gemini voice sweep, T1 verdict matrix, and `vendor-doc-refresh.md`.

## Issues & Recommendations
1. No blocking issues found.

   Implementation note: keep the P3a voice shortlist pre-declared in evidence before listening/scoring, so the final "top 3" cannot look cherry-picked after the fact. This is a rigor note, not an approval blocker.

2. No blocking issues found on scope.

   The plan still respects the <$5/no-product-code boundary: added work is limited to spike scripts, evidence WAV/JSONL/markdown, and doc refresh rows.

## Verdict
APPROVED — ready to implement.
