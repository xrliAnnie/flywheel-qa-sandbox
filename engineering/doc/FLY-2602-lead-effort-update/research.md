# FLY-2602 Lead effort 安全更新 — 调研
Issue: FLY-2602 (https://linear.app/geoforge3d/issue/FLY-2602)
日期: 2026-09-16
基于: exploration.md

## Implementation anchors
- `.flywheel/agents/registry.yaml`: code/simple_code policies; only code.eng_design Astra default effort needs a policy edit.
- `packages/teamlead/src/workflow-menu.ts`: compileWorkflowMenuSeed emits manifests from defaults; admission selects split model and its policy effort.
- `packages/teamlead/src/workflow-catalog-migration.ts`: FLY-2121 catalog migration imports repo seeds; tpl_eng_heavy intentionally excluded from removal.
- `packages/config/src/model-split.ts` and `scripts/design-model-split.mjs`: ratio policy owns model selection, not effort; historical cohort hashes must stay stable.
- `packages/flywheel-comm/src/commands/lead-registry.ts`: reuse add transaction rather than introducing another writer.
- `scripts/flywheel-lead.sh`: config_write_locked projects.json.cfglock wrapper and materialization.
- `summary-registry-migration.ts`: refresh writes exact candidate hash; verifier must reject unrefreshed byte changes.
- `lead-registry-recover.ts`: pre/planned assignment digests can be identical for effort-only writes. Recovery must check activation before treating that digest as an unwritten receipt.

## Verified corrections (2026-09-16)
The actual restart source preflight accepts an effort-only byte edit with an unchanged receipt; it rejects an identity edit with summary_registry_projection_mismatch. Evidence: /tmp/FLY-2602-preflight-experiment.log, all checks pass. Lead reply to 8f7da3b8 explicitly authorizes the smaller direct-edit-plus-verification runbook if this is proven. Do not add a hash gate or update writer merely to satisfy the original incorrect premise.

GET /api/workflow/templates/:id with the existing runner credential succeeds. The earlier /api/workflow-templates 401 was an incorrect path, promptly corrected in Lead report 67b633af-e80b-4053-bb6f-c6381680a7e7. Captured metadata/manifests: /tmp/FLY-2602-live-templates.json.
- tpl_code revision 13, schema2, founder-owned, implement astra medium; eng_design fable high; qa claude-opus-5 high.
- tpl_simple_code revision 5, founder-owned, implement astra medium; qa claude-opus-5 high.
- tpl_eng_heavy revision 5, system-owned, implement gpt-5.6-sol xhigh.
FLY-2121 deliberately skips founder-owned templates; removing that guard would overwrite unrelated founder changes. Need a bounded, idempotent field migration that publishes a fresh immutable revision while retaining ownership, graph, other node settings and existing run snapshots.
