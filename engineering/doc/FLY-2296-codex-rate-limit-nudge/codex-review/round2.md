# Design Review — plan.md (Round 2)

Date: 2026-09-03
Author: Codex
Status: CHANGES REQUESTED

## Summary

The updated plan resolves the full-access Lead gap, the unsafe Lead TOML classification, and the probe credential-copy issue; the runner's root-scope shape handling is also now correct. One recovery-path credential invariant remains unresolved: validating before new writes does not remove a managed GH token already present in the execution home, and the proposed residue test assumes cleanup that its own setup does not perform.

## What's Good (Keep)

- `ensure_notice_pin` now runs at the actual assembly endpoint of both Lead profiles, with full-access coverage proving the notice pin and Lead-actions MCP survive together.
- The Lead classifier now appends only when the top-level `notice` key is entirely absent and fails closed for existing unpinned shapes, avoiding invalid duplicate tables without adding a Bash TOML rewriter.
- The runner scan is correctly limited to the root segment and includes a relative-key control case, while retaining the parsed postcondition for unsupported quoted shapes.
- The probe now strips the FLY-123 credential block, verifies the copied config contains no `GH_TOKEN`, preserves mode 0600, and installs bounded cleanup before starting processes.
- Scope remains disciplined: one Codex preference key, no flags or environment switches, no patrol changes, and no expansion into pause/resume or account switching.

## Issues & Recommendations

1. [HIGH] Moving both pins before filesystem writes prevents new partial state, but it does not scrub a credential already present in the same execution home. The proposed residue test first calls `provisionCodexHome` directly with a token; that helper returns with the managed GH-token block still present—there is no adapter `finally` in this unit-test path. In the real crash-recovery path, the old block can likewise survive because startup cleanup deliberately excludes live execution IDs, and `provisionCodexHome` is called before `CodexTmuxAdapter.executeOwned` enters the `try/finally` that scrubs credentials. A subsequent pin rejection therefore leaves the old token untouched, so the planned “no `GH_TOKEN`” assertion either fails or becomes vacuous if the test manually pre-scrubs it. Keep precomputation before new writes, but put it behind a rejection handler that calls `scrubCodexHomeCredential(opts.executionId, env)` before rethrowing (or establish an equivalent outer cleanup boundary). The regression test must seed an existing unsanitized managed token, perform no intermediate scrub, trigger the invalid notice shape, then assert the token was removed while the pre-existing auth bytes were not rewritten.

## Verdict

CHANGES REQUESTED — address the item above
