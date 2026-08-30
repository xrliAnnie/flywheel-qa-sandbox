# FLY-127 department-scope-spawn progress

- Phase: design
- Cursor: 3/7
- Updated: 2026-08-30

## Chunks

- `baseline_audit`: completed — confirmed `origin/main` contains the original FLY-127 layers and reproduced the `leadId`-omission bypass.
- `design_review_r1`: changes_requested — omission authorization gap, command, boundary and baseline claims corrected.
- `design_review_r2`: changes_requested — reviewer required complete caller migration, exact response precedence, realistic Gemini/QA fixtures, shell CI wiring and a truthful TeamLead baseline policy.
- `design_docs_r3`: completed — enumerated every repository caller/test/doc migration; configured project roots audited; guard precedence and rollback pinned; residual `/actions/retry` authentication gap named.
- `baseline_gates`: completed — local TeamLead full suite is nondeterministic (13 files/29 tests, then 28 files) because of sandbox/host integration, permissions, timeouts and unrelated failures. Linux CI runs the authoritative suite.
- `baseline_waiver`: pending — correction question `64213dc8-a8a7-4ac0-bbd8-5c8dd4107e4b` replaces disproved question `61b39bc0-f774-4d1d-8f39-aff33aca5a5a`.
- `route_identity_guard`: pending
- `caller_binding`: pending
- `rules_acceptance`: pending
- `verification_review`: pending
- `pr_handoff`: pending

## Next

Commit the round-3 design documents and request a fresh design review. Do not modify runtime code until APPROVED.

## Ledger transport note

The required `flywheel-comm progress --exec-id b9541631-b28d-465a-aad0-aff162a115fd ...` call returns `exec-id ... is not the active writer (status=terminated)` even though `flywheel-comm turn` returned `yours phase=implement epoch=1`. Lead question `2b9dafc0-2400-4e07-a161-873181aa15b1` remains open. This file preserves the cursor until writer state is resolved.
