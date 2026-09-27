---
issue: FLY-2922
phase: design
phaseCursor: 1/6
updated: 2026-09-27T05:50:51.765Z
nextStep: "AUDIT DONE, usage limit cut. Facts: sandbox main (1855f7a1a) has NO
  workflow hold/recovery subsystem; approved design (gate d9ab4f85, plan
  c4d40fbed, SHA 7de9bef9) + impl WIP 5/6 live on origin/flywheel-FLY-2922 @
  28ffc18aa (prod PR #1374 OPEN). Upstream docs exported by git show
  origin/flywheel-FLY-2922:engineering/doc/FLY-2922-unified-node-recovery/{expl\
  oration,research,plan,design-correction,review-result,implementation-evidence\
  ,delivery-evidence}.md. MEDIUM checks in branch code:
  carveout=rework_delivery_owned StateStore:63615 OK;
  materializer=materializeWorkflowNodeReplacementTx StateStore:65053 (budget
  check 65095, held CAS to verify); preflight
  rework_replacement_context_unlaunchable NOT FOUND (open item); merge-order in
  milestone md (2921 first, e9a72127f merged). Non-blocking Lead question
  d26e7f85 (baseline confirm) pending — check before writing docs. NEXT: stage
  set brainstorm already done; write exploration.md (基于 无) -> research.md ->
  plan.md in this folder, then stage set design_review --plan,
  codex-design-review with Bridge model/effort, review-round, founder HTML (mmdc
  11.12.0 present; use --svgId FLY-2922-d<N>), publish-report --publish-only,
  ask --report DESIGN-HTML ready, complete --route phase_design_complete."
chunks: []
pointers: {}
---

# FLY-2922 progress
**phase**: design (1/6)
**next**: AUDIT DONE, usage limit cut. Facts: sandbox main (1855f7a1a) has NO workflow hold/recovery subsystem; approved design (gate d9ab4f85, plan c4d40fbed, SHA 7de9bef9) + impl WIP 5/6 live on origin/flywheel-FLY-2922 @ 28ffc18aa (prod PR #1374 OPEN). Upstream docs exported by git show origin/flywheel-FLY-2922:engineering/doc/FLY-2922-unified-node-recovery/{exploration,research,plan,design-correction,review-result,implementation-evidence,delivery-evidence}.md. MEDIUM checks in branch code: carveout=rework_delivery_owned StateStore:63615 OK; materializer=materializeWorkflowNodeReplacementTx StateStore:65053 (budget check 65095, held CAS to verify); preflight rework_replacement_context_unlaunchable NOT FOUND (open item); merge-order in milestone md (2921 first, e9a72127f merged). Non-blocking Lead question d26e7f85 (baseline confirm) pending — check before writing docs. NEXT: stage set brainstorm already done; write exploration.md (基于 无) -> research.md -> plan.md in this folder, then stage set design_review --plan, codex-design-review with Bridge model/effort, review-round, founder HTML (mmdc 11.12.0 present; use --svgId FLY-2922-d<N>), publish-report --publish-only, ask --report DESIGN-HTML ready, complete --route phase_design_complete.
