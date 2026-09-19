# FLY-2737 approved design handoff

**Issue**: FLY-2737
**Date**: 2026-09-18
**Status**: APPROVED (effective review receipt; design phase only)
**Source**: plan.md, authority.md, review-r4.json

Effective `reviewVerdict=APPROVED`, raw `reviewerVerdict=APPROVED`; request `7d354432-5b03-4159-885e-35d989ec1d55`, question `56465d49-b977-4cf0-be3b-3f5e1bb1dce6`, delivery nonce `d4a81349-70e3-43d9-a365-b3bbb113afa4`. This was the Lead-authorized limited R4 (the transport calls it round 3 within the resumed execution).

Keep plan.md unchanged after this approval. Its draft label records its state at submission; this receipt records the resulting approval. Observed plan blob `eb6e310b849255b2256d835d790ba84d353b8099` is identical at submitted artifact commit `096c0317d` and closeout observation `bf90eb1c0`. This is observed artifact continuity, not a claim that the currently shipped review transport already emits the future durable proof designed in §4.4.

## Selected scope

Delete executable legacy pure-document gates and card opinions. Use the same true three-point evidence decision in dry_run and auto; auto may write a distinct three_point_auto approval only with all passes, exact evidence, current guards and delivered opinion. Preserve founder stop/rework/revocation/head guards and existing land path. Do not flip live mode or require another opening merely at deployment; exact founder policy replacement provenance and mode receipts remain distinct.

Implement task 0's durable reviewed-plan proof producer, then shared strict evidence and the remaining tasks. Historical design approvals without proof cannot auto-authorize; new reviewed bytes and actual QA report bytes/explicit semantic pass are required. Read the full acceptance matrix A–V and exact failure paths, including real producer integration and is_current-fallback mutant. No production readiness claim before collection/model capacity and end-to-end evidence pass.

## Non-blocking review advisories for Lead disposition

The following remain visible for implementation planning or separate follow-up. They are not hidden, and their presence does not reverse the effective approved design verdict.

### MEDIUM: plan-reference-selector-still-reads-current-manifest

§4.4 states the intent correctly ('its new receipt, not current-manifest lookup, is the alignment authority') and task 0 says to 'read only sealed records from ship-judgment/evidence-authority.ts'. But evidence-authority is not the only supplier of the expected blob. StateStore.readShipJudgmentPlanReference (StateStore.ts:5745) independently calls getCurrentDesignReviewManifest(row.execution_id) at StateStore.ts:5756 and returns {requestId, path, expectedBlobSha} from the is_current=1 row. It is consumed by runtime-collect.ts:71 and production-collect.ts:225, and in runtime-collect.ts:71-78 it WINS over the evidence-authority value: readReference() prefers `preferred` whenever preferred.requestId === approval.requestId, and both ids are the same codex_review_job.request_id, so they always match. So on the runtime-collect lane the is_current-derived blob is the dominant one today. Task 0's enumeration (StateStore 'schema/types/methods', design-review-manifest, design-review-validation/route, coordinator/parser, evidence-authority) never names this method or runtime-collect.ts, and the mutation test is scoped to 'the sealed-proof reader' (singular). Name StateStore.readShipJudgmentPlanReference:5745 and ship-judgment/runtime-collect.ts explicitly in task 0 — converted to the sealed proof or retired — and scope the is_current mutant to cover both lanes so acceptance S's 'later mutable manifest cannot approve' row actually exercises the path that supplies the blob.

### MEDIUM: coordinator-capture-failure-policy-unspecified

The coordinator-lane paragraph reads 'snapshot a committed, clean plan using snapshotDesignReviewPlan ... BEFORE queuing the reviewer. Atomically insert the job AND its captured proof', which literally makes a successful capture a precondition of registering the review job. But capture can legitimately fail on inputs the coordinator accepts today: planPath is OPTIONAL for design (review-request-coordinator.ts:642 and the 'Empty → prompt fallback' comment at :653-656), and snapshotDesignReviewPlan (design-review-manifest.ts:52-176) fails closed on missing/dirty/invalid_path/git_error, including any uncommitted or index-divergent plan. Meanwhile the 'Historical and crash behavior' paragraph says a target without sealed proof merely 'stays reviewed_plan_blob missing and cannot auto-approve', which implies proof-less jobs are tolerated. /review-requests is a shared producer used by every project and every issue's design gate, so resolving this the wrong way is a broad availability regression, not a Flywheel-only one. State the policy explicitly: a failed capture registers the job normally with an explicit proof-absent disposition and makes alignment report missing, and it MUST NOT reject the review request or fail the job. Add a negative producer test for 'design review with no planPath / dirty plan still registers and still reviews, with no sealed proof'.

### LOW: changes-requested-label-fidelity

evidence-ledger.ts:308-321 distinguishes three design states today: approved (evidence ref), changes_requested (fail(a,'design_changes_requested') → aggregateJudgment returns recommend_reject), and anything else (missing → undetermined). §4.3 now routes alignment authority through the sealed proof and lists only undetermined outcomes ('Missing expected SHA/commit/object, malformed identity, path mismatch, edited plan, or missing target makes alignment undetermined'). A rejected design review produces no sealed approved proof, so a wholesale substitution would render it as 待补证 rather than 未通过/建议拒. Both block approval, so this is not a safety issue — only founder-facing label fidelity, and §2's new row already says 'preserve genuine missing states in both modes'. Make it explicit: the sealed proof supplies the approved-blob authority, while the existing codex_review_job CHANGES_REQUESTED → fail path is retained unchanged.

Other retained follow-ups: approval ceiling/circuit breaker needs separately agreed policy (do not add automatic mode switching); model-lane capacity and collection-budget readiness need measured acceptance and explicit diagnostics. R2/R3 model/collection limitations are already in plan §10 and the founder page.

## Phase and validation boundaries

Design artifacts only. No product code, production flags/data, restart, deploy, ship approval, merge, successor dispatch, or local full `pnpm test:packages:run`. Preserve exact-stash recovery provenance; never select stash@{0}. Keep founder_review unchanged.

Local founder HTML structure/controller verification passes. Both Mermaid sources previously failed local rendering plus standard retries due to Chromium bootstrap permission denial; the HTML honestly retains two DIAGRAM PENDING LOCAL RENDER placeholders and the .mmd sources. No remote render or visual browser QA is claimed. Hosted publication and HTTP/CSP/source validation receipt is recorded in design-verification.md after publication.

Closeout learning recorded as one requested memory update note under the permitted native memory extension directory (`20260918T171731Z-policy-replacement-mode-proof.md`); shared role-memory index was not rewritten. It was observed within its size budget (89 lines / 19684 bytes). Runtime closeout receipt is authoritative for its final budget status.
