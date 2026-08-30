# FLY-127 department-scope-spawn progress

- Phase: design
- Cursor: 2/7
- Updated: 2026-08-30

## Chunks

- `baseline_audit`: completed — confirmed `origin/main` contains the original three-layer FLY-127 implementation, then reproduced the `leadId`-omission bypass.
- `design_review_r1`: changes_requested — reviewer caught the omitted-identity authorization gap, an incorrect focused-test command, overbroad boundary claim, and unhandled baseline full-gate failures.
- `design_docs_r2`: completed — revised exploration/research/plan now require explicit Lead identity, bind Gemini and QA callers, preserve flag-off rollback, and state the exact initial-start boundary.
- `baseline_gates`: completed — build and focused tests green; exact `pnpm test:packages:run` has two pre-existing `packages/core/test/tmux-viewer.macos.test.ts` failures because Terminal Apple Events are unavailable in the managed runner. No runtime code has changed yet.
- `baseline_waiver`: pending — Lead question `61b39bc0-f774-4d1d-8f39-aff33aca5a5a` requests a waiver limited to those same two unchanged macOS failures and no new failures.
- `route_identity_guard`: pending
- `caller_binding`: pending
- `rules_acceptance`: pending
- `verification_review`: pending
- `pr_handoff`: pending

## Next

Commit and submit the revised `plan.md` for a fresh design-review round. Do not implement until approved.

## Ledger transport note

The required `flywheel-comm progress --exec-id b9541631-b28d-465a-aad0-aff162a115fd ...` call still returns `exec-id ... is not the active writer (status=terminated)` even though `flywheel-comm turn` returned `yours phase=implement epoch=1`. Lead question `2b9dafc0-2400-4e07-a161-873181aa15b1` remains open. This file preserves the cursor until the writer-state mismatch is resolved.
