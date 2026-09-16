# FLY-2602 Lead effort 安全更新 — 实施计划
Issue: FLY-2602 (https://linear.app/geoforge3d/issue/FLY-2602)
日期: 2026-09-16
基于: research.md

## Revision 3: evidence supersedes receipt premise
Authority: Lead scope instruction f940de57-be65-4b4a-a1fa-5adc4cf189c8 and reply to question 8f7da3b8-6600-4a23-a58b-522ef403119b. Real restart source preflight proves effort-only changes do not require receipt refresh. Deliver a guarded operator runbook and regression coverage; do NOT add lead-registry update, change activation hash policy or modify recovery logic. Lead alone performs live Raya config edit and normal restart in the authorized window.

## Workflow change
1. Change only registry code.eng_design Astra defaultEffort xhigh -> high. Keep Sol implementation defaults and Claude design/QA unchanged. Ratio policy/cohort serialization stays frozen.
2. Add a FLY-2602 catalog migration invoked during Bridge startup alongside existing catalog setup, before listeners/admission. Only target tpl_code and tpl_simple_code, only their unique implement node, only the observed source vendor=codex model=astra or gpt-6-astra effort=medium. Publish a new revision changing model to gpt-5.6-sol and effort to xhigh. Preserve all other manifest bytes semantically, schema version, graph, founder ownership, seed metadata, historical revisions and run snapshots. Existing desired Sol-xhigh is a no-op; unrelated/custom source profiles are preserved with an explicit skipped result. Missing/retired templates do not get recreated or activated.
3. Use StateStore revision/publication APIs with expected revision CAS and a transaction; audit the FLY-2602 migration and ensure failure rolls back draft/publication changes. Reuse the startup verified snapshot discipline for any on-disk mutation. Do not change general seed-owner rules, expose a new publication API or start a second production StateStore owner.

## Tests and proof
- RED: Astra design default resolution is high for both parity and percentage split; minimal registry edit to green. Existing assignment replay stays pinned.
- RED: initialize isolated catalog with the captured founder-owned published manifests (code@13/simple@5), run existing FLY-2121 first and demonstrate preserved old values, then the bounded migration. Through createWorkflowTemplateRouter GET /api/workflow/templates/:id, assert published implement Sol xhigh, unchanged Claude nodes/graph/owner, immutable old revision/run snapshots, and eng_heavy untouched.
- Negative cases: alternate custom profile, wrong vendor, absent or duplicate implement, retired/missing template, CAS conflict/rollback; migration rerun no-op without extra revision/audit growth.
- Extend existing restart-summary-source-preflight shell test: effort-only edit without refreshing receipt passes actual mapped source verifier; identity/assignment edit still fails. This replaces the original requested negative test whose premise is false.
- Run isolated Raya-shaped config preflight verification. One-line operator recipe must preserve every unrelated config field, validate before/after and provide rollback; receipt unchanged is expected. Separate normal Lead-owned restart/log high and next shuttle preflight proof from implementation acceptance.

## Required gates
pnpm lint; pnpm -r build; pnpm test:packages:run with eligible package receipt fallback only; affected shell tests. Avoid real GUI tests per project policy. Commit/push, effective registered code-review approval, milestone-last commit, PR and exact-head CI. Report then complete --route needs_review --pr NUMBER; park. No production mutations, service restart, QA dispatch or merge by implement.

## Known acceptance boundary
Host Raya change/restart and production GET showing the new template revisions happen after deployment under Lead authority. Isolated router/migration proof is not production activation. This revision supersedes revision 1's unnecessary receipt update design.

## Review corrections (authoritative over the shorter steps above)
- Run FLY-2602 immediately AFTER successful FLY-2121 setup, before listeners/admission.
- Non-fatal startup contract: backup failure, model/manifest validation failure, expectedRevision CAS conflict and ordinary publication errors log a structured warning/result and continue boot with the prior publication. Backup failure skips all migration writes. Per-template atomic transactions roll back draft/publication/audit writes. If audit storage is unavailable, log stderr without throwing again. Only genuine database-integrity violations retain the existing fatal classification. Inject every named failure in tests and assert boot continuation and no orphan revision.
- Pin one modelSnapshot for edited-node validation and publication. Validate Sol/xhigh against that snapshot, then use allowUnsupportedModels=true to preserve unrelated historical model spellings; structural validation remains active.
- Use createAndPublishWorkflowTemplateRevision and its CAS transaction, with createdBy=system to preserve ownership. Migration audit uses workflow_catalog_migration_audit, migration_id=FLY-2602, item_kind=seed_update, stable JSON detail and INSERT OR IGNORE under the existing UNIQUE constraint. Couple successful publication and audit in a bounded StateStore transaction. A per-template success marker prevents reapplying after a later deliberate founder reversion. No new audit enum or table.
- Percentage tests inject a temporary FLYWHEEL_MODELS_CONFIG percentage authority via the existing withRuntimeModelConfig helper; registry parity alone is insufficient.
- Live read-only identity verification confirms projectName=raya, agentId=raya, key=raya-raya, backend=codex-app-server. Existing fleet apply cannot serve this Lead: classify_lead returns UNAPPLIED codex-desired before comparing effort. Preserve that safety boundary; the locked edit recipe must assert the full key. Lead-owned normal Codex carrier reconciliation/restart must verify any manifest/plist effort carriers too; stale carriers cannot count as activation.
