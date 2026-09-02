# FLY-2247 synthesis — external Deep Research report + our integration analysis

Added after PR #1029's six review rounds, per Tadashi's instruction
`060c1e29-2121-4995-a59c-770396bb1888` (2026-09-02): the founder exported a ChatGPT
Deep Research report by hand; use it as the external evidence baseline, verify its key
claims, and contribute the integration-surface analysis it could not do.

| File | What it is |
|---|---|
| `fly2247-bargein-research.md` | **The deliverable.** Verification of the report's key claims + mapping its recommended pipeline onto Raya's chain + migration steps. Byte-identical to `~/.flywheel/artifacts/fly2247-bargein-research.md` (the path Tadashi asked for); this copy exists so it travels with the branch. |
| `fly2247-dr-report-source.md` | The founder's export, unmodified, so the verification above stays checkable. Note: the citation URLs did not survive the copy — 53 citation markers remain, 0 http links. |

**One conclusion here supersedes `../plan.md`:** the keep/delete matrix in plan.md omitted
latency. The platform's speech_started must complete a full round trip, so it cannot be the
fast path for a sub-300ms audible stop — the local detector should stay and own the fast
path, with the platform event demoted to corroboration. See §6 of the synthesis.
