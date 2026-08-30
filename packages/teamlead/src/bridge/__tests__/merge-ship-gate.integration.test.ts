/**
 * FLY-869 B — merge-race ship gate, END-TO-END integration (Annie's explicit ask).
 *
 * Real StateStore (native better-sqlite3, per-statement autocommit) + real CommDB
 * (via FLYWHEEL_COMM_DIR redirect) + the actual `verifyApproval` ship-authority +
 * the QA snapshot gate + the Bridge seam (`computeShipDecision` / `parkMergeBlock` /
 * `isMergeBlocked` / `clearMergeBlockOnApproval`) + the finalization chokepoint
 * (`isPostApproveShipComplete`). NO mocks on the decision path — this is the real
 * merged→completed mapping every sink (DirectEventSink / event-route / W2 /
 * complete-marker-reconciler) computes.
 *
 * Two groups Annie required, plus the two anti-regressions the plan pins:
 *   ① FLY-120 — a GENUINELY approved + merged session PASSES the gate to `completed`
 *      (NOT stranded in awaiting_review). This is the fragile hot-spot the whole
 *      issue must not regress.
 *   ② merged-WITHOUT-approval (runner 抢跑 self-merge) → merge_block marker + NOT Done
 *      (决定③: no auto-revert, leave open, loud alert). Idempotent once-per-head.
 *   ③ recovery — a same-head founder approval CLEARS the block (B-3, R2 HIGH-5).
 *   ④ the retired environment key cannot bypass merge approval.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import { installWorkflowAgentFiles } from "../../__tests__/fixtures/workflow-agent-project.js";
import {
	insertHistoricalAutoQaRecord,
	setHistoricalQaRequiredSnapshot,
} from "../../__tests__/helpers/historical-qa.js";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV1 } from "../../workflow-run-snapshot.js";
import {
	computeAuthoritativeShipDecision,
	computeEngineWorkflowShipPrecondition,
	computeShipDecision,
	finalizeRecoveredMerge,
	isMergeBlocked,
	parkMergeBlock,
} from "../merge-ship-gate.js";
import { isPostApproveShipComplete } from "../post-ship-finalization.js";
import type { BridgeConfig } from "../types.js";

const EXEC = "exec-fly869-b";
const LEAD = "flywheel-eng-lead";
const PROJECT = "proj";
const ISSUE = "FLY-869";
const HEAD = "a".repeat(40);
const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};
const CI_GREEN = () => ({
	green: true as const,
	reason: "ci_green" as const,
	mergeStateStatus: "CLEAN",
	checks: ["Build & Test"],
});

const GATES_ON = {} as NodeJS.ProcessEnv;

describe("FLY-869 B — merge-race ship gate (real StateStore + real CommDB)", () => {
	let tmpDir: string;
	let store: StateStore;
	let commRoot: string;
	let worktreePath: string;
	let prevCommDir: string | undefined;

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly869-b-int-"));
		// Redirect commDbPathForProject → <tmp>/comm/<project>/comm.db (never the
		// live Bridge comm.db). computeShipDecision reads process.env for this.
		commRoot = join(tmpDir, "comm");
		mkdirSync(join(commRoot, PROJECT), { recursive: true });
		prevCommDir = process.env.FLYWHEEL_COMM_DIR;
		process.env.FLYWHEEL_COMM_DIR = commRoot;
		store = await StateStore.create(join(tmpDir, "teamlead.db"));
		worktreePath = join(tmpDir, "worktree");
		execFileSync("git", ["init", "-q", worktreePath]);
		const headRef = execFileSync(
			"git",
			["-C", worktreePath, "symbolic-ref", "HEAD"],
			{ encoding: "utf8" },
		).trim();
		mkdirSync(join(worktreePath, ".git", headRef, ".."), {
			recursive: true,
		});
		writeFileSync(join(worktreePath, ".git", headRef), `${HEAD}\n`);
		installWorkflowAgentFiles(worktreePath);
		writeFileSync(
			join(worktreePath, ".flywheel", "config.yaml"),
			"project: flywheel\n",
		);
	});

	afterEach(() => {
		if (prevCommDir === undefined) delete process.env.FLYWHEEL_COMM_DIR;
		else process.env.FLYWHEEL_COMM_DIR = prevCommDir;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function commDbPath(): string {
		return join(commRoot, PROJECT, "comm.db");
	}

	/** Insert an approve_to_ship question FROM the runner + a structured approval. */
	function foundersApproved(executionId = EXEC): string {
		const db = new CommDB(commDbPath());
		try {
			const qid = db.insertQuestion(executionId, LEAD, "PR ready", {
				checkpoint: "approve_to_ship",
			});
			db.insertResponse(qid, "bridge", JSON.stringify({ approved: true }));
			return qid;
		} finally {
			db.close();
		}
	}

	/** A session with a PASSED QA record + APPROVED Codex record for HEAD. */
	function withQaAndCodexGreen(): void {
		setHistoricalQaRequiredSnapshot(store, {
			executionId: EXEC,
			required: 1,
			reason: "test",
		});
		insertHistoricalAutoQaRecord(store, {
			parentExecutionId: EXEC,
			targetPrHeadSha: HEAD,
			issueId: ISSUE,
			projectName: PROJECT,
			status: "passed",
		});
		store.recordCodexReviewApproved({
			executionId: EXEC,
			targetPrHeadSha: HEAD,
			issueId: ISSUE,
			projectName: PROJECT,
		});
	}

	function withCodexGreen(executionId = EXEC): void {
		store.recordCodexReviewApproved({
			executionId,
			targetPrHeadSha: HEAD,
			issueId: ISSUE,
			projectName: PROJECT,
		});
	}

	function upsert(
		status: string,
		reviewQuestionId?: string,
		executionId = EXEC,
	): void {
		store.upsertSession({
			execution_id: executionId,
			issue_id: ISSUE,
			project_name: PROJECT,
			pr_number: 869,
			status,
			session_role: "main",
			branch: "fly-869",
			worktree_path: worktreePath,
		});
		store.setReviewBinding(executionId, {
			questionId: reviewQuestionId ?? null,
			prHeadSha: HEAD,
		});
	}

	function engineQaAtFounderGate(): { qaClaimId: number } {
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		store.importWorkflowTemplateSeed(seed);
		store.materializeWorkflowRun({
			runId: "engine-run",
			issueId: ISSUE,
			projectName: PROJECT,
			taskCategory: "code",
			templateId: seed.templateId,
			claimsReadEnrolled: true,
			actor: "lead",
			env: WORKFLOW_ON,
			startReservation: {
				idempotencyKey: "engine-start",
				selectionDigest: "selection",
				nodeId: "design",
				attempt: 1,
				executionId: "engine-design",
				createdAt: "2026-07-16T00:00:00.000Z",
			},
		});
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_run SET gate_carrier_epoch = 0 WHERE run_id = 'engine-run'",
		);
		store.upsertWorkflowRunNode({
			runId: "engine-run",
			nodeId: "design",
			attempt: 1,
			state: "running",
			executionId: "engine-design",
		});
		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "engine-run",
				nodeId: "design",
				attempt: 1,
				executionId: "engine-design",
				outcome: "design_done",
				successorExecutionId: "engine-implement",
				now: "2026-07-16T00:05:00.000Z",
			}).ok,
		).toBe(true);
		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "engine-run",
				nodeId: "implement",
				attempt: 1,
				executionId: "engine-implement",
				outcome: "implement_done",
				successorExecutionId: EXEC,
				now: "2026-07-16T00:10:00.000Z",
			}).ok,
		).toBe(true);
		const admission = store.admitGeneralizedWorkflowExecution({
			runId: "engine-run",
			nodeId: "qa",
			executionId: EXEC,
			attempt: 1,
			now: "2026-07-16T00:11:00.000Z",
			expiresAt: "2026-07-16T00:11:30.000Z",
			absoluteDeadlineAt: "2027-07-17T00:11:00.000Z",
			env: WORKFLOW_ON,
		});
		if (!admission.ok || !admission.submissionCredential) {
			throw new Error("engine QA admission failed");
		}
		upsert("running", undefined, EXEC);
		const qa = store.submitWorkflowDecisionByCredential({
			nodeReuseEnabled: false,
			credential: admission.submissionCredential,
			clientRequestId: "engine-qa-pass",
			predicate: "qa_passed",
			subjectDigest: HEAD,
			issuerVendor: "claude",
			issuerModel: "claude-opus-4-8",
			subjectProducerExecutionId: "engine-implement",
			subjectProducerVendor: "codex",
			claimExpiresAt: "2027-07-16T00:11:00.000Z",
			now: "2026-07-16T00:12:00.000Z",
		});
		if (!qa.ok) throw new Error(qa.reason);
		upsert("approved_to_ship");
		setHistoricalQaRequiredSnapshot(store, {
			executionId: EXEC,
			required: 0,
			reason: "engine claims fixture",
		});
		return { qaClaimId: qa.claimId };
	}

	function productWithReviewPredicate(
		predicate: "codex_approved" | "design_review_approved",
	) {
		const seed = pinLegacyWorkflowSeedAgents(
			legacyWorkflowSeeds().find(
				(candidate) => candidate.templateId === "tpl_product_v1",
			)!,
		);
		const flags = WORKFLOW_ON;
		store.importWorkflowTemplateSeed(seed, flags);
		store.materializeWorkflowRun({
			runId: "product-run",
			issueId: ISSUE,
			projectName: PROJECT,
			taskCategory: "product",
			templateId: seed.templateId,
			claimsReadEnrolled: true,
			actor: "lead",
			canonicalRoot: worktreePath,
			env: flags,
			startReservation: {
				idempotencyKey: "product-start",
				selectionDigest: "selection",
				nodeId: "research",
				attempt: 1,
				executionId: "product-research",
				createdAt: "2026-07-16T00:00:00.000Z",
			},
		});
		store.upsertWorkflowRunNode({
			runId: "product-run",
			nodeId: "research",
			attempt: 1,
			state: "running",
			executionId: "product-research",
		});
		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "product-run",
				nodeId: "research",
				attempt: 1,
				executionId: "product-research",
				outcome: "node_done",
				successorExecutionId: "product-produce",
				now: "2026-07-16T00:05:00.000Z",
			}).ok,
		).toBe(true);
		const produce = store.admitGeneralizedWorkflowExecution({
			runId: "product-run",
			nodeId: "produce",
			executionId: "product-produce",
			attempt: 1,
			now: "2026-07-16T00:06:00.000Z",
			expiresAt: "2027-07-16T00:06:00.000Z",
			absoluteDeadlineAt: "2027-07-17T00:06:00.000Z",
			env: flags,
		});
		if (!produce.ok || !produce.outputCredential) {
			throw new Error("product produce admission failed");
		}
		upsert("running", undefined, "product-produce");
		const output = store.submitWorkflowNodeOutput({
			token: produce.outputCredential,
			clientRequestId: "product-produce-output",
			payload: '{"result":"ready"}',
			now: "2026-07-16T00:07:00.000Z",
		});
		if (!output.ok) throw new Error(output.reason);
		const outputRow = store.getWorkflowNodeOutput(output.outputId);
		if (!outputRow) throw new Error("product output missing");
		const completion = store.commitEnrolledCompletion({
			nodeReuseEnabled: false,
			executionId: "product-produce",
			route: "needs_review",
			sourceEventId: "product-produce-complete",
			completionSubmission: { decision: { route: "needs_review" } },
			subjectDigest: HEAD,
			prBinding: {
				prNumber: 869,
				headSha: HEAD,
				targetRepoIdentity: "__main__",
				probeRepoSlug: "geoforge3d/flywheel",
				targetRepoPath: worktreePath,
				worktreeBindingGeneration: "product-fixture",
			},
			now: "2026-07-16T00:10:00.000Z",
		});
		if (!completion.ok) throw new Error(completion.reason);
		const materialization = store.allocateWorkflowMaterialization({
			runId: "product-run",
			nodeId: "produce",
			attempt: 1,
			outputId: output.outputId,
			outputDigest: outputRow.output_digest,
			repo: "geoforge3d/flywheel",
			ref: "refs/heads/fly-869",
			baseHead: HEAD,
		});
		store.adoptWorkflowMaterializationCommit({
			effectId: materialization.effect_id,
			treeHead: HEAD,
			commitHead: HEAD,
		});
		store.confirmWorkflowMaterializationPush({
			effectId: materialization.effect_id,
			remoteHead: HEAD,
			reviewNodeId: "review",
		});
		const reviewExecution = store.getWorkflowRunNode(
			"product-run",
			"review",
			1,
		)?.execution_id;
		if (!reviewExecution) throw new Error("product review successor missing");
		const review = store.admitGeneralizedWorkflowExecution({
			runId: "product-run",
			nodeId: "review",
			executionId: reviewExecution,
			attempt: 1,
			now: "2026-07-16T00:11:00.000Z",
			expiresAt: "2027-07-16T00:11:00.000Z",
			absoluteDeadlineAt: "2027-07-17T00:11:00.000Z",
			env: flags,
		});
		if (!review.ok || !review.submissionCredential) {
			throw new Error("product review admission failed");
		}
		upsert("running", undefined, reviewExecution);
		const submitted = store.submitWorkflowDecisionByCredential({
			nodeReuseEnabled: false,
			credential: review.submissionCredential,
			clientRequestId: "product-review-predicate",
			predicate,
			subjectDigest: HEAD,
			issuerVendor: "claude",
			issuerModel: "sonnet",
			subjectProducerExecutionId: "product-produce",
			subjectProducerVendor: "codex",
			claimExpiresAt: "2027-07-16T00:11:00.000Z",
			...(predicate === "design_review_approved"
				? {
						gateEntryBinding: {
							kind: "materialization_receipt" as const,
							prNumber: 869,
							headSha: HEAD,
							targetRepoIdentity: "__main__",
							probeRepoSlug: "geoforge3d/flywheel",
							targetRepoPath: worktreePath,
							worktreeBindingGeneration: `receipt-v1:${materialization.effect_id}`,
							expectedProducerMirrorHead: HEAD,
							effectId: materialization.effect_id,
							producerNodeId: "produce",
							outputId: output.outputId,
							outputAttempt: 1,
							repo: "geoforge3d/flywheel",
							ref: "refs/heads/fly-869",
						},
					}
				: {}),
			now: "2026-07-16T00:12:00.000Z",
		});
		if (!submitted.ok) return submitted;
		expect(
			store.appendWorkflowSystemClaim({
				issuerKind: "founder_challenge",
				runId: "product-run",
				issueId: ISSUE,
				decisionKind: "founder_decision",
				predicate: "founder_approved",
				subjectKind: "git_head",
				subjectDigest: HEAD,
				permanent: true,
				authorityId: "product-founder",
			}).ok,
		).toBe(true);
		upsert("approved_to_ship", undefined, reviewExecution);
		setHistoricalQaRequiredSnapshot(store, {
			executionId: reviewExecution,
			required: 0,
			reason: "product claims fixture",
		});
		return { ...submitted, executionId: reviewExecution };
	}

	// ── Group ① — FLY-120: genuinely approved + merged → eligible → completed ──
	it("approved + merged PASSES the gate to completed (FLY-120 not regressed)", () => {
		const qid = foundersApproved();
		upsert("approved_to_ship", qid);
		withQaAndCodexGreen();

		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		const d = computeShipDecision(store, session, HEAD, GATES_ON, CI_GREEN);

		expect(d.eligible).toBe(true);
		expect(d.mergeApprovalOk).toBe(true);
		expect(d.qaOk).toBe(true);
		// The sink does NOT park an eligible merge → the founder-hold suppressor stays clear.
		expect(isMergeBlocked(session)).toBe(false);
		// The single finalization chokepoint drives it to Done (existingStatus was
		// approved_to_ship — the exact FLY-120 "approved then already-merged" shape).
		expect(
			isPostApproveShipComplete({
				existingStatus: "approved_to_ship",
				route: "needs_review",
				landingStatus: { status: "merged" },
				shipEligible: d.eligible,
			}),
		).toBe(true);
	});

	it("claims READ makes worktree HEAD authoritative and rejects stale cached evidence", async () => {
		upsert("awaiting_review");
		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		const decision = await computeAuthoritativeShipDecision(
			store,
			session,
			"b".repeat(40),
			{
				...GATES_ON,
				FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
			} as NodeJS.ProcessEnv,
		);
		expect(decision).toMatchObject({
			eligible: false,
			mergeReason: "head_authority_mismatch",
			qaReason: "head_authority_mismatch_failclosed",
			authoritativeHead: HEAD,
		});
	});

	it("engine-owned terminalization additively requires every snapshot ship claim at USE time", async () => {
		const { qaClaimId } = engineQaAtFounderGate();
		const qid = foundersApproved();
		upsert("approved_to_ship", qid);
		withCodexGreen();
		expect(store.getWorkflowClaim(qaClaimId)).toMatchObject({
			expires_at: null,
			permanent: 1,
		});
		const session = store.getSession(EXEC)!;
		const off = {
			FLYWHEEL_WORKFLOW_CLAIMS_READ: "0",
		} as NodeJS.ProcessEnv;
		expect(
			await computeAuthoritativeShipDecision(store, session, HEAD, off),
		).toMatchObject({
			eligible: false,
			workflowClaimsOk: false,
			workflowClaimsReason: "founder_approved:no_claim",
		});
		const env = {
			...off,
			FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
		} as NodeJS.ProcessEnv;

		const missingFounder = await computeAuthoritativeShipDecision(
			store,
			session,
			HEAD,
			env,
		);
		expect(missingFounder).toMatchObject({
			eligible: false,
			workflowClaimsOk: false,
			workflowClaimsReason: "founder_approved:no_claim",
		});
		expect(
			store.appendWorkflowSystemClaim({
				issuerKind: "founder_challenge",
				runId: "engine-run",
				issueId: ISSUE,
				decisionKind: "founder_decision",
				predicate: "founder_approved",
				subjectKind: "git_head",
				subjectDigest: HEAD,
				permanent: true,
				authorityId: "founder-engine-head",
			}).ok,
		).toBe(true);
		const approvedDecision = await computeAuthoritativeShipDecision(
			store,
			session,
			HEAD,
			env,
			undefined,
			CI_GREEN,
		);
		expect(approvedDecision).toMatchObject({
			eligible: true,
			workflowClaimsOk: true,
		});

		store.revokeWorkflowClaim({
			claimId: qaClaimId,
			reason: "head invalidated",
			actor: "bridge",
		});
		expect(
			await computeAuthoritativeShipDecision(store, session, HEAD, env),
		).toMatchObject({
			eligible: false,
			workflowClaimsReason: "qa_passed:revoked",
		});
		expect(
			await computeEngineWorkflowShipPrecondition(store, EXEC, "b".repeat(40)),
		).toMatchObject({
			engineOwned: true,
			eligible: false,
			authoritativeHead: HEAD,
			reason: "head_authority_mismatch",
		});
	});

	it("parked and completed recovery both reject a capable run with no founder_review pass", async () => {
		mkdirSync(join(worktreePath, ".flywheel"), { recursive: true });
		writeFileSync(
			join(worktreePath, ".flywheel", "config.yaml"),
			"project: proj\nlinear:\n  team_id: FLY\nrunners:\n  default: claude\n  available:\n    claude:\n      type: claude\nteams:\n  - name: default\n    orchestrators:\n      - type: dag\n        runner: claude\ndecision_layer:\n  autonomy_level: advisor\n  escalation_channel: discord\ncheckpoints:\n  founder_review:\n    enabled: true\n    timeout_ms: 172800000\n    timeout_behavior: fail-close\n",
		);
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy_land_v1",
		)!;
		const manifest = {
			...seed.manifest,
			nodes: seed.manifest.nodes.map((node) =>
				node.id === "implement"
					? { ...node, founder_review: true as const }
					: node,
			),
		};
		store.createWorkflowRun({
			runId: "founder-review-run",
			issueId: ISSUE,
			projectName: PROJECT,
			snapshotJson: JSON.stringify(
				buildWorkflowRunSnapshotV1({
					template: { id: seed.templateId, revision: 1 },
					manifest,
				}),
			),
			claimsReadEnrolled: true,
		});
		upsert("completed");
		store.upsertWorkflowRunNode({
			runId: "founder-review-run",
			nodeId: "implement",
			attempt: 1,
			state: "done",
			executionId: EXEC,
		});
		const sql = (
			store as unknown as {
				db: { run(statement: string, params?: unknown[]): void };
			}
		).db;
		sql.run(
			"UPDATE workflow_run SET engine_owned = 1, current_node_id = 'land' WHERE run_id = 'founder-review-run'",
		);
		sql.run(
			`INSERT INTO workflow_actor
			   (execution_id, project_name, issue_id, role, created_at)
			 VALUES (?, ?, ?, 'implement', '2026-08-14T00:00:00.000Z')`,
			[EXEC, PROJECT, ISSUE],
		);
		sql.run(
			`INSERT INTO workflow_execution_binding
			   (activation_id, execution_id, run_id, node_id, attempt, mode, bound_at)
			 VALUES ('founder-review-activation', ?, 'founder-review-run',
			         'implement', 1, 'spawn', '2026-08-14T00:00:00.000Z')`,
			[EXEC],
		);
		sql.run(
			`INSERT INTO workflow_node_pr_binding
			   (run_id, node_id, attempt, pr_number, head_sha,
			    target_repo_identity, probe_repo_slug, target_repo_path,
			    worktree_binding_generation, receipt_id, bound_at)
			 VALUES ('founder-review-run', 'implement', 1, 1758, ?,
			         '__main__', 'geoforge3d/flywheel', ?,
			         'generation-1', 'founder-review-receipt',
			         '2026-08-14T00:00:00.000Z')`,
			[HEAD, worktreePath],
		);

		expect(
			await computeEngineWorkflowShipPrecondition(store, EXEC, HEAD),
		).toMatchObject({
			engineOwned: true,
			eligible: false,
			authoritativeHead: HEAD,
			reason: "founder_review_missing",
		});
		expect(
			await computeAuthoritativeShipDecision(
				store,
				store.getSession(EXEC)!,
				HEAD,
				{
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
				} as NodeJS.ProcessEnv,
			),
		).toMatchObject({
			eligible: false,
			mergeReason: "founder_review_missing",
			workflowClaimsReason: "founder_review_missing",
		});
	});

	it("does not confuse predicates in the review family", () => {
		expect(productWithReviewPredicate("codex_approved")).toEqual({
			ok: false,
			reason: "transition_refused",
			detail: { transitionReason: "predicate_has_no_engine_outcome" },
		});
		expect(
			store.resolveWorkflowDecisionClaim({
				runId: "product-run",
				nodeId: "review",
				decisionKind: "review_verdict",
				predicate: "design_review_approved",
				requiredAttempt: 1,
				subjectKind: "git_head",
				subjectDigest: HEAD,
				now: "2026-07-16T00:12:00.000Z",
			}),
		).toEqual({ valid: false, reason: "no_claim" });
	});

	// ── Group ② — merged WITHOUT approval → merge_block + not Done (决定③) ──
	it("merged without approval → merge_block marker + NOT completed (idempotent once-per-head)", () => {
		// Runner 抢跑: merged landing, but never approved (status still awaiting_review,
		// no answered approve_to_ship question). QA + Codex green — proving it is the
		// MERGE-APPROVAL gate, not QA/Codex, that blocks it.
		upsert("awaiting_review");
		withQaAndCodexGreen();

		let session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		const d = computeShipDecision(store, session, HEAD, GATES_ON);
		expect(d.eligible).toBe(false);
		expect(d.mergeApprovalOk).toBe(false);
		expect(d.qaOk).toBe(true); // QA passed — the block is purely merge-approval.

		// Park it (决定③ — no auto-revert, durable head-bound marker).
		expect(parkMergeBlock(store, session, HEAD, d)).toBe(true);
		session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		expect(isMergeBlocked(session)).toBe(true);
		expect(session.merge_block_reason).toContain("merge_without_approval");
		expect(session.merge_block_head?.toLowerCase()).toBe(HEAD);
		// NOT marked completed / Done.
		expect(session.status).not.toBe("completed");
		// The finalization chokepoint refuses to finalize a non-eligible merge.
		expect(
			isPostApproveShipComplete({
				existingStatus: "awaiting_review",
				route: "needs_review",
				landingStatus: { status: "merged" },
				shipEligible: d.eligible,
			}),
		).toBe(false);

		// Idempotent: a replay / second surface does not re-claim (single alert).
		expect(parkMergeBlock(store, session, HEAD, d)).toBe(false);
	});

	// ── Group ③ — recovery: a same-head approval eligibility-gated CLEARS + COMPLETES
	//    (B-3, R2 HIGH-5 + Codex R1 #1 / R2 #2 — clear only when eligible, then complete) ──
	it("a same-head founder approval on a parked eligible session clears + drives it to completed", async () => {
		// Start parked (as in Group ②): merged, QA + Codex green, but not yet approved.
		upsert("awaiting_review");
		withQaAndCodexGreen();
		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		parkMergeBlock(
			store,
			session,
			HEAD,
			computeShipDecision(store, session, HEAD, GATES_ON),
		);
		expect(isMergeBlocked(store.getSession(EXEC))).toBe(true);

		// The founder approves THIS head (FSM flips approved_to_ship + CommDB answered) —
		// the marker is STILL present when finalizeRecoveredMerge runs (Codex R2 #2: it
		// gates the clear on eligibility). Now fully eligible → clears + completes.
		const qid = foundersApproved();
		upsert("approved_to_ship", qid);
		const completed = await finalizeRecoveredMerge(
			store,
			{} as BridgeConfig,
			[],
			EXEC,
			undefined,
			GATES_ON,
			undefined,
			undefined,
			undefined,
			CI_GREEN,
		);
		expect(completed).toBe(true);
		expect(isMergeBlocked(store.getSession(EXEC))).toBe(false); // marker cleared
		expect(store.getSession(EXEC)?.status).toBe("completed");
	});

	it("a same-head recovered merge does not require an open-PR CI probe", async () => {
		upsert("awaiting_review");
		withQaAndCodexGreen();
		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		parkMergeBlock(
			store,
			session,
			HEAD,
			computeShipDecision(store, session, HEAD, GATES_ON, CI_GREEN),
		);
		const qid = foundersApproved();
		upsert("approved_to_ship", qid);

		const completed = await finalizeRecoveredMerge(
			store,
			{} as BridgeConfig,
			[],
			EXEC,
			undefined,
			GATES_ON,
		);

		expect(completed).toBe(true);
		expect(isMergeBlocked(store.getSession(EXEC))).toBe(false);
		expect(store.getSession(EXEC)?.status).toBe("completed");
	});

	it("recovered product merge resolves its materialized head through the production authority port", async () => {
		const product = productWithReviewPredicate("design_review_approved");
		expect(product.ok).toBe(true);
		if (!product.ok) throw new Error(product.reason);
		const qid = foundersApproved(product.executionId);
		store.setReviewBinding(product.executionId, {
			questionId: qid,
			prHeadSha: HEAD,
		});
		withCodexGreen(product.executionId);
		// This test isolates materialized-head recovery for a pre-carrier run.
		// Newly materialized runs are covered as epoch 1 elsewhere.
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_run SET gate_carrier_epoch = 0 WHERE run_id = 'product-run'",
		);
		const session = store.getSession(product.executionId)!;
		parkMergeBlock(store, session, HEAD, {
			eligible: false,
			mergeApprovalOk: false,
			qaOk: false,
			mergeReason: "head_authority_unavailable",
			qaReason: "head_authority_unavailable_failclosed",
		});
		const materializedHeadAuthority = {
			resolve: async () => ({ head: HEAD, outputId: 1, attempt: 1 }),
		};
		const productDecision = await computeAuthoritativeShipDecision(
			store,
			store.getSession(product.executionId)!,
			HEAD,
			{},
			materializedHeadAuthority,
			CI_GREEN,
		);
		expect(productDecision).toMatchObject({ eligible: true });

		const completed = await finalizeRecoveredMerge(
			store,
			{} as BridgeConfig,
			[],
			product.executionId,
			undefined,
			{
				FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
			} as NodeJS.ProcessEnv,
			undefined,
			undefined,
			materializedHeadAuthority,
			CI_GREEN,
		);

		expect(completed).toBe(true);
		expect(isMergeBlocked(store.getSession(product.executionId))).toBe(false);
		expect(store.getSession(product.executionId)?.status).toBe("completed");
	});

	// ── FLY-907 (Codex R1 MED-2): the recovered-merge path is the FOURTH
	// completion sink — it must close a DAG workflow issue's parked phases and
	// only THEN run the terminal display refresh (order enforced by
	// runPostShipFinalization: phase finalization step 1.25 before the
	// display-refresh step 1.3, both before archive). ──
	it("recovered merge runs finalizeWorkflowPhaseRoles BEFORE the terminal display refresh", async () => {
		upsert("awaiting_review");
		withQaAndCodexGreen();
		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		parkMergeBlock(
			store,
			session,
			HEAD,
			computeShipDecision(store, session, HEAD, GATES_ON),
		);
		const qid = foundersApproved();
		upsert("approved_to_ship", qid);

		const order: string[] = [];
		const completed = await finalizeRecoveredMerge(
			store,
			{} as BridgeConfig,
			[],
			EXEC,
			undefined,
			GATES_ON,
			async () => {
				order.push("refresh");
			},
			async () => {
				order.push("finalize-phases");
			},
			undefined,
			CI_GREEN,
		);
		expect(completed).toBe(true);
		expect(order).toEqual(["finalize-phases", "refresh"]);
	});

	// ── Group ③b — recovery LEAVES the marker when a gate is still unmet (Codex R2 #2) ──
	it("recovery does NOT clear the marker nor complete when the QA gate is still unmet", async () => {
		// Parked (merged, Codex approved) but QA REQUIRED with no passing record; founder approves.
		upsert("awaiting_review");
		setHistoricalQaRequiredSnapshot(store, {
			executionId: EXEC,
			required: 1,
			reason: "t",
		});
		store.recordCodexReviewApproved({
			executionId: EXEC,
			targetPrHeadSha: HEAD,
			issueId: ISSUE,
			projectName: PROJECT,
		});
		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		// Park it (not eligible — QA required, no passing record).
		parkMergeBlock(
			store,
			session,
			HEAD,
			computeShipDecision(store, session, HEAD, GATES_ON),
		);
		expect(isMergeBlocked(store.getSession(EXEC))).toBe(true);

		const qid = foundersApproved();
		upsert("approved_to_ship", qid);
		// QA gate still unmet → recovery must NOT complete AND must LEAVE the marker (held).
		const completed = await finalizeRecoveredMerge(
			store,
			{} as BridgeConfig,
			[],
			EXEC,
			undefined,
			GATES_ON,
			undefined,
			undefined,
			undefined,
			CI_GREEN,
		);
		expect(completed).toBe(false);
		expect(store.getSession(EXEC)?.status).toBe("approved_to_ship");
		// Codex R2 #2: the durable suppressor is NOT dropped — the session stays held.
		expect(isMergeBlocked(store.getSession(EXEC))).toBe(true);
	});

	// ── Group ④ — the retired key cannot bypass the gate ──
	it("ignores the retired merge-gate key", () => {
		upsert("awaiting_review"); // unapproved
		withQaAndCodexGreen();
		const session = store.getSession(EXEC);
		if (!session) throw new Error("session missing");
		const retiredKey = ["FLYWHEEL", "MERGE", "APPROVAL", "GATE"].join("_");
		const d = computeShipDecision(store, session, HEAD, {
			[retiredKey]: "0",
		} as NodeJS.ProcessEnv);
		expect(d.mergeApprovalOk).toBe(false);
		expect(d.qaOk).toBe(true);
		expect(d.eligible).toBe(false);
	});
});
