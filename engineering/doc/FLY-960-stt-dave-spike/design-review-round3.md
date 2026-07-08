# Design Review — plan.md (FLY-960 STT/DAVE spike) (Round 3)
Date: 2026-07-07
Author: Codex
Status: APPROVED

## Summary
Round 3 addresses the remaining executable-runbook blockers from Round 2. The plan is now fit for the implement-phase runner: it is timeboxed, scoped to spike/doc evidence only, has bounded network refresh behavior, resolves credentials without leaking values, and has a fail-closed DAVE proof chain.

I verified the two highest-risk command assumptions locally: the `bounded()` perl helper executes and interrupts a long command, and the main-checkout `flywheel-comm` dist path exists and prints the expected CLI usage.

## What's Good (Keep)
- The macOS timeout issue is fixed with a repo-independent `/usr/bin/perl` `bounded()` helper, and network failures are explicitly record-and-continue rather than blockers (`plan.md:40-50`).
- The `flywheel-comm` pushback is acceptable as documented: the plan uses the deployed main-checkout dist, explains why it should match the running Bridge/CommDB contract, and adds an existence self-check (`plan.md:51-56`, `plan.md:89-91`).
- Gemini key resolution now actually exports `GEMINI_API_KEY` through the relevant sources, including `NANOBANANA_GEMINI_API_KEY` and `FLYWHEEL_VOICE_GEMINI_KEY_ENV` indirection, while recording only the source label (`plan.md:92-111`).
- The native Opus install can no longer block the base spike package install; `@discordjs/opus` is optional and the active decoder is recorded (`plan.md:133-149`).
- The B-path ref lock now uses `pipefail`, validates a 40-hex SHA, and writes an explicit `UNRESOLVED` marker on failure, so an empty lock file cannot become fake evidence (`plan.md:365-373`).
- The A-path reliability protocol remains concrete enough for QA: controlled `SIGUSR1` rejoin plus quantitative loop/recovery criteria (`plan.md:265-271`, `plan.md:331-339`).

## Issues & Recommendations
1. Non-blocking watch item: DAVE proof instrumentation still depends on `@discordjs/voice` internals if debug output is insufficient.

   Why it matters: The node_modules patch recipe necessarily uses grep-located internal handlers (`plan.md:308-322`). That is acceptable for a spike, but it is the most likely place for implement to spend time if the library debug output does not expose `dave_protocol_version` and epoch events directly.

   Suggested fix: no plan change required before implement. Keep the current fail-closed rule: if the three-piece proof is unavailable, the report must say `DAVE proof unavailable` and must not mark GO by inference (`plan.md:325-326`).

## Verdict
APPROVED — ready to implement.
