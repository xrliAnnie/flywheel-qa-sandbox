# FLY-2461 中文批准 — 返工验证
Issue: FLY-2461 (https://linear.app/geoforge3d/issue/FLY-2461)
日期: 2026-09-09
基于: plan-r2.md

QA FAIL claim 982 at a7e2097836a84df7f0dbfbcd9b7af54c6e78f2c6 returned TURN to implement epoch 3. QA reported criteria 1–7 passing with explicit bench limits; only criterion 8 is rework scope. The approved plan is unchanged.

QA observed three visible prompts for three bare approvals against one card. Audit insertion failure after POST pinned the persisted inbound cursor, permitting replay to post again. The fix claims a deterministic event keyed by thread and card before attempting guidance. Duplicate claims suppress further attempts; a failed claim suppresses guidance without pinning ingress. Post-attempt audit failure cannot escape. Current review/ship card binding supplies the card identity; when no binding exists, the pending question is the fallback. Stale-card paths use their referenced card identity.

Lead ruling 7ebed589-c854-4570-83f7-5bca490735b0 explicitly chooses at-most-once guidance attempt per thread/card, including failed or unknown POST outcomes. This supersedes the old expectation that a NEW bare token retries a failed hint. The claim is retained; failed POST still attempts failure audit. Anchored approval retry is unaffected. No known-not-sent/unknown HTTP classification is introduced.

TDD evidence:
- Dedup test red: expected one POST, observed three; then green.
- Audit-throw test red: process_failed instead of advancing durable cursor; then green.
- Claim-throw guard red: process_failed instead of advancing without POST; then green.
- Full ingress suite: 52/52 pass. Includes real SQLite close/reopen persistence, new-card/new-thread isolation for both review and ship, existing failed-POST then anchored approval coverage, stale-card guards and identity negatives.
- Logs: /tmp/FLY-2461-rework-dedup-red.log, /tmp/FLY-2461-rework-audit-red.log, /tmp/FLY-2461-rework-claim-red.log, /tmp/FLY-2461-rework-ingress-green.log.

Rework verification: pnpm lint exit 0 (14 warnings); pnpm -r build exit 0; TeamLead typecheck exit 0. The single VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run completed exit 0: 897 files passed, 12,307 tests passed / 6 skipped, 961.14 seconds. Log: /tmp/FLY-2461-rework-teamlead.log. Per Lead response c26d7adc, the aggregate was not rerun; initial aggregate evidence remains in verification.md. Fresh exact-head review/CI remain pending for this rework. Prior-head green CI and APPROVED review do not apply to the changed head. QA must recheck the revised behavior; implementation does not claim a new real-room result.
