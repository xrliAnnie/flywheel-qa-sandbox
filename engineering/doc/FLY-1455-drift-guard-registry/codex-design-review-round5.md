# Design Review — FLY-1455 plan.md (Round 5)

Date: 2026-08-16
Author: Codex
Status: APPROVED

## Summary

v5 closes all three Round 4 findings and is implement-ready. The seven config migrations match the current source, scanner authority is consistently code-only and ledger-independent, and occurrence-level span reconciliation makes the regex cross-check non-vacuous without reintroducing comment/string hits.

## What's Good (Keep)

- All seven existing `pattern: "config"` rows now have exact, source-valid file/symbol/configAccess mappings. In particular, `doc_flow` correctly anchors to `Blueprint.runInner`, and `skill_framework_split_participation` moves to `makeSkillFrameworkParticipationReader` with the false Blueprint config row explicitly removed.
- The decision not to catalog `run-infra.ts` as another delegated site is explicit and sound: the canonical reader is the actual read evidence, while exhaustive consumer call-graph enumeration is outside the `readSites` contract.
- The three-layer contract is now consistent throughout the active design: `regexCandidates` are diagnostic/cross-check input only, `rawCodeHits` are the sole scan authority, and only post-ledger `unhandledHits` drive the registration invariant. Env stale checks also consume only `rawCodeHits`.
- Source-span reconciliation is per occurrence, and fixture 22 includes the same-file/same-name masking negative case. This prevents an adjacent valid AST hit from concealing a scanner hole.
- Parse failures remain fail-closed; comment/string candidates cannot settle ledgers or keep exemptions alive; shell dynamic reverse is validated with file-type-appropriate evidence.
- The PR-1 → PR-2/B2′ sequencing remains feasible, all anti-rot checks land with their corresponding escape hatches, and the config backfill/census plan is reviewable rather than silent.
- No scope red line is violated: there is no creation-time retirement requirement, cleanup-issue automation, retirement-declaration scaffolding, `question` behavior change, or `longTermKeep` implementation.

## Issues & Recommendations

1. **No blocking issues.** Implement against the pinned mappings and fixture contracts; any source drift discovered during implementation should update the reviewed table rather than weaken reverse validation.

## Verdict

APPROVED — ready to implement
