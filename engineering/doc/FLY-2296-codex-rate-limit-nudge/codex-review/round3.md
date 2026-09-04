# Design Review — plan.md (Round 3)

Date: 2026-09-03
Author: Codex
Status: APPROVED

## Summary

The Round 2 credential-residue gap is closed: pin validation remains before new filesystem writes, while rejection now explicitly removes any managed GH token retained by the same execution home before rethrowing. The plan is feasible, bounded to the single Codex notice key, and has discriminating unit, integration, and real-TUI evidence paths.

## What's Good (Keep)

- The rejection handler covers the gap left by both cleanup layers: `scrubOrphanedCodexHomes` intentionally skips live execution IDs, and the adapter's `try/finally` begins only after `provisionCodexHome` returns.
- The residue regression starts from a proven unsanitized managed token, performs no intermediate cleanup, and verifies token removal without rewriting `auth.json` or `.active`; removing the scrub call is required to turn it red.
- Runner TOML handling is semantic and fail-loud while preserving valid relative keys and the production `[notice.model_migrations]` shape.
- Both Lead assembly branches receive the same pin, including the full-access rewrite path, with tests preserving the Lead-actions MCP configuration.
- The fake app-server probe exercises the real TUI across missing/true/false states without carrying auth or the managed GitHub credential into its temporary home.
- Rollout, rollback, and out-of-scope boundaries remain explicit and consistent with the current recovery architecture.

## Issues & Recommendations

None.

## Verdict

APPROVED — ready to implement
