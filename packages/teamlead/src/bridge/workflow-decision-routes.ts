import express from "express";
import {
	adapterTypeToFamily,
	canonicalSubmissionDigest,
	formatRunnerMemoryCloseoutLine,
	parseRunnerMemoryCloseoutReceipt,
	sanitizeOneLine,
} from "flywheel-config";
import type {
	StateStore,
	WorkflowEngineAlertIdentity,
	WorkflowGateCarrierRebindCanonical,
	WorkflowGateEntryBinding,
	WorkflowLoopReentryCanonical,
} from "../StateStore.js";
import { resolveWorkflowDecisionContract } from "../workflow-run-snapshot.js";
import { workflowApprovalGate } from "../workflow-template.js";
import type { ConfirmTokenStore } from "./fleet-admin.js";
import { resolveWorkflowHeadAuthority } from "./head-authority.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import {
	leadEventEnvelopeFromJournalRow,
	REDRIVABLE_LEAD_EVENT_PRIORITY,
} from "./legacy-lead-event-reconciler.js";
import { isSameOrigin, loopbackSelfOrigin } from "./loopback-origin.js";
import {
	type MaterializedHeadAuthority,
	type MaterializedHeadAuthorityResult,
	unavailableMaterializedHeadAuthority,
} from "./materialized-head-authority.js";
import { resolveBoundRepositoryAuthority } from "./repository-authority.js";
import {
	probeWorkflowPr,
	type WorkflowPrProbeResult,
} from "./workflow-pr-probe.js";

export type { WorkflowPrProbeResult } from "./workflow-pr-probe.js";

class WorkflowDecisionRejection extends Error {
	constructor(
		reason: string,
		readonly detail?: Record<string, unknown>,
	) {
		super(reason);
	}
}

interface WorkflowDecisionBody {
	credential?: unknown;
	client_request_id?: unknown;
	status?: unknown;
	summary?: unknown;
	client_pr_head_sha?: unknown;
	runner_memory_closeout?: unknown;
}

/** Persist optional runner closeout evidence without affecting decision acceptance. */
export function persistRunnerMemoryCloseout(
	store: Pick<StateStore, "patchSessionMetadata">,
	executionId: string,
	raw: unknown,
	logPrefix: "[workflow-decision]" | "[event-route]",
): void {
	if (raw === undefined) return;
	const receipt = parseRunnerMemoryCloseoutReceipt(raw);
	if (!receipt) {
		console.warn(
			`${logPrefix} runner-memory closeout receipt rejected exec=${executionId} reason=malformed`,
		);
		return;
	}
	try {
		store.patchSessionMetadata(executionId, {
			runner_memory_closeout: receipt.state,
			runner_memory_receipt: JSON.stringify(receipt),
		});
		console.info(
			`${formatRunnerMemoryCloseoutLine(logPrefix, receipt)} exec=${executionId}`,
		);
	} catch (error) {
		console.warn(
			`${logPrefix} runner-memory closeout persist failed exec=${executionId}: ${sanitizeOneLine(error instanceof Error ? error.message : String(error), 200)}`,
		);
	}
}

export interface WorkflowDecisionRouterDeps {
	store: StateStore;
	materializedHeadAuthority?: MaterializedHeadAuthority;
	prProbe?: (input: {
		prNumber: number;
		probeRepoSlug: string;
	}) => Promise<WorkflowPrProbeResult>;
	now?: () => string;
	nodeReuseEnabled?: () => boolean;
	reQa?: {
		tokens: Pick<ConfirmTokenStore, "issue" | "verifyAndConsume">;
		respawn(
			canonical: WorkflowReQaCanonical,
			prHeadSha: string,
		): Promise<{ executionId: string }>;
	};
	loopReentry?: {
		tokens: Pick<ConfirmTokenStore, "issue" | "verifyAndConsume">;
	};
	gateCarrierRebind?: {
		tokens: Pick<ConfirmTokenStore, "issue" | "verifyAndConsume">;
	};
	resolveAlertIdentity: (
		projectName: string,
		issueId: string,
		runId: string,
	) => WorkflowEngineAlertIdentity;
	enqueueLeadEvent: (envelope: LeadEventEnvelope) => void;
}

function enqueueCommittedWorkflowClaim(
	deps: WorkflowDecisionRouterDeps,
	result: { claimId: number; leadEventSeq: number },
): void {
	const row = deps.store.getLeadEventBySeq(result.leadEventSeq);
	if (!row) {
		console.warn("[workflow-decision] committed claim event row missing", {
			claimId: result.claimId,
			leadEventSeq: result.leadEventSeq,
		});
		return;
	}
	try {
		deps.enqueueLeadEvent(
			leadEventEnvelopeFromJournalRow(row, REDRIVABLE_LEAD_EVENT_PRIORITY),
		);
	} catch (error) {
		console.warn("[workflow-decision] committed claim event enqueue failed", {
			claimId: result.claimId,
			leadEventSeq: result.leadEventSeq,
			leadId: row.lead_id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function decisionRejectionStatus(reason: string): number {
	if (reason === "credential_not_found") return 401;
	if (reason === "alert_identity_invalid") return 503;
	return 409;
}

type SubmissionCredential = NonNullable<
	ReturnType<StateStore["getWorkflowSubmissionCredentialByToken"]>
>;

interface EngineDecisionCanonical {
	reporting: NonNullable<ReturnType<StateStore["getSession"]>>;
	serverHead: string;
	predicate: string;
	issuerVendor: string;
	issuerModel: string;
	producerExecutionId: string;
	producerVendor: string;
	family: string;
	entersApprovalGate: boolean;
	materializedAuthority?: MaterializedHeadAuthorityResult;
}

async function resolveEngineDecisionCanonical(
	deps: WorkflowDecisionRouterDeps,
	credential: SubmissionCredential,
	status: "pass" | "fail",
): Promise<EngineDecisionCanonical | undefined> {
	const current = deps.store.resolveCurrentWorkflowActivation(
		credential.execution_id,
	);
	if (current.kind === "none") return undefined;
	if (current.kind === "ambiguous") {
		if (!deps.store.isWorkflowEngineOwnedExecution(credential.execution_id)) {
			return undefined;
		}
		throw new Error("execution_binding_ambiguous");
	}
	if (current.run.engine_owned !== 1) return undefined;
	if (current.binding.activation_id !== credential.activation_id) {
		throw new Error("submission_binding_not_current");
	}
	const context = current;
	const decision = resolveWorkflowDecisionContract(
		context.snapshot,
		context.node.id,
	);
	if (!decision) {
		throw new Error("node_does_not_emit_decisions");
	}
	if (credential.family !== decision.family) {
		throw new Error("decision_family_mismatch");
	}
	const reporting = deps.store.getSession(credential.execution_id);
	const issuer = deps.store.getWorkflowExecutionRuntime(
		credential.execution_id,
	);
	if (!reporting || !issuer) throw new Error("execution_runtime_unavailable");

	let serverHead: string;
	let producerExecutionId: string;
	let materializedAuthority: MaterializedHeadAuthorityResult | undefined;
	if (decision.family === "qa_verdict") {
		serverHead = (
			await resolveWorkflowHeadAuthority(deps.store, credential.execution_id)
		).prHeadSha;
		const producerNodeId = context.snapshot.manifest.edges.find(
			(edge) => edge.to === context.node.id,
		)?.from;
		const producer = producerNodeId
			? deps.store
					.listWorkflowRunNodes(credential.run_id, producerNodeId)
					.filter((node) => node.execution_id && node.state === "done")
					.at(-1)
			: undefined;
		if (!producer?.execution_id) throw new Error("producer_not_found");
		producerExecutionId = producer.execution_id;
	} else {
		const authority = await (
			deps.materializedHeadAuthority ?? unavailableMaterializedHeadAuthority
		).resolve(credential.run_id, context.node.id);
		materializedAuthority = authority;
		serverHead = authority.head.toLowerCase();
		if (!/^[0-9a-f]{40}$/.test(serverHead)) {
			throw new Error("materialized_head_invalid");
		}
		const output = deps.store.getWorkflowNodeOutput(authority.outputId);
		const directProducer = output
			? context.snapshot.manifest.edges.some(
					(edge) => edge.from === output.node_id && edge.to === context.node.id,
				)
			: false;
		if (
			!output ||
			output.run_id !== credential.run_id ||
			output.attempt !== authority.attempt ||
			!directProducer
		) {
			throw new Error("materialized_output_mismatch");
		}
		producerExecutionId = output.execution_id;
	}
	const producer = deps.store.getWorkflowExecutionRuntime(producerExecutionId);
	if (!producer) throw new Error("producer_runtime_unavailable");
	return {
		reporting,
		serverHead,
		predicate:
			status === "pass" ? decision.passPredicate : decision.failPredicate,
		issuerVendor: issuer.vendor,
		issuerModel: issuer.model,
		producerExecutionId,
		producerVendor: producer.vendor,
		family: decision.family,
		entersApprovalGate:
			status === "pass" &&
			context.snapshot.manifest.edges.some(
				(edge) =>
					edge.from === context.node.id &&
					edge.condition === decision.passOutcome &&
					edge.to === workflowApprovalGate(context.snapshot.manifest).node,
			),
		...(materializedAuthority ? { materializedAuthority } : {}),
	};
}

function workflowPrRefValid(ref: string): boolean {
	return (
		ref.length > 0 &&
		ref.length <= 255 &&
		!ref.startsWith(".") &&
		!ref.endsWith(".") &&
		!ref.endsWith(".lock") &&
		!ref.includes("..") &&
		![...ref].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character);
		})
	);
}

async function resolveGateEntryBinding(
	deps: WorkflowDecisionRouterDeps,
	canonical: EngineDecisionCanonical,
): Promise<WorkflowGateEntryBinding | undefined> {
	if (!canonical.entersApprovalGate) return undefined;
	const isWorktree = canonical.family === "qa_verdict";
	const materialized = canonical.materializedAuthority;
	if (!isWorktree && !materialized) {
		throw new Error("materialized_head_unavailable");
	}
	const authorityExecutionId = isWorktree
		? canonical.reporting.execution_id
		: canonical.producerExecutionId;
	const worktreeBinding = deps.store.getWorktreeBinding(authorityExecutionId);
	if (!worktreeBinding) throw new Error("land_head_pr_identity_unavailable");
	const authority = await resolveBoundRepositoryAuthority({
		authorityRoot: worktreeBinding.path,
	});
	if (
		authority.identity !== "__main__" ||
		(isWorktree
			? authority.headSha !== canonical.serverHead
			: authority.probeRepoSlug.toLowerCase() !==
				materialized!.repo.toLowerCase())
	) {
		throw new Error("land_head_authority_drift");
	}
	const producer = deps.store.getSession(canonical.producerExecutionId);
	const prNumber = producer?.pr_number;
	const expectedProducerMirrorHead = producer?.pr_head_sha?.toLowerCase();
	if (
		!Number.isSafeInteger(prNumber) ||
		(prNumber ?? 0) < 1 ||
		!/^[0-9a-f]{40}$/.test(expectedProducerMirrorHead ?? "")
	) {
		throw new Error("land_head_pr_identity_unavailable");
	}
	let probe: WorkflowPrProbeResult;
	try {
		probe = await (deps.prProbe ?? probeWorkflowPr)({
			prNumber: prNumber!,
			probeRepoSlug: authority.probeRepoSlug,
		});
	} catch {
		throw new Error("land_head_pr_probe_failed");
	}
	if (
		typeof probe.state !== "string" ||
		typeof probe.isDraft !== "boolean" ||
		typeof probe.isCrossRepository !== "boolean" ||
		typeof probe.headRefName !== "string" ||
		typeof probe.headRefOid !== "string"
	) {
		throw new Error("land_head_pr_probe_invalid");
	}
	const state = probe.state.trim().toUpperCase();
	if (state === "MERGED") throw new Error("land_head_pr_merged");
	if (state !== "OPEN") throw new Error("land_head_pr_closed");
	if (probe.isDraft) throw new Error("land_head_pr_draft");
	if (probe.isCrossRepository) throw new Error("land_head_pr_cross_repo");
	if (!workflowPrRefValid(probe.headRefName)) {
		throw new Error("land_head_pr_ref_invalid");
	}
	if (!isWorktree && materialized!.ref !== `refs/heads/${probe.headRefName}`) {
		throw new Error("land_head_materialized_ref_mismatch");
	}
	if (probe.headRefOid.trim().toLowerCase() !== canonical.serverHead) {
		if (!isWorktree) {
			throw new Error("land_head_materialized_pr_not_at_tip");
		}
		throw new WorkflowDecisionRejection("land_head_pr_not_at_tip", {
			expectedHeadOid: canonical.serverHead,
			expectedHeadRefName: probe.headRefName,
			prNumber: prNumber!,
			repoSlug: authority.probeRepoSlug,
			currentHeadOid: probe.headRefOid.trim().toLowerCase(),
		});
	}
	if (!isWorktree) {
		return {
			kind: "materialization_receipt",
			prNumber: prNumber!,
			headSha: canonical.serverHead,
			targetRepoIdentity: authority.identity,
			probeRepoSlug: authority.probeRepoSlug,
			targetRepoPath: authority.path,
			worktreeBindingGeneration: `receipt-v1:${materialized!.effectId}`,
			expectedProducerMirrorHead: expectedProducerMirrorHead!,
			effectId: materialized!.effectId,
			producerNodeId: materialized!.producerNodeId,
			outputId: materialized!.outputId,
			outputAttempt: materialized!.attempt,
			repo: materialized!.repo,
			ref: materialized!.ref,
		};
	}
	return {
		kind: "worktree",
		prNumber: prNumber!,
		headSha: canonical.serverHead,
		targetRepoIdentity: authority.identity,
		probeRepoSlug: authority.probeRepoSlug,
		targetRepoPath: authority.path,
		worktreeBindingGeneration: worktreeBinding.generation,
		expectedProducerMirrorHead: expectedProducerMirrorHead!,
	};
}

export interface WorkflowReQaCanonical {
	runId: string;
	issueId: string;
	projectName: string;
	sourceExecutionId: string;
	sourceAttempt: number;
	targetAttempt: number;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function workflowGateCarrierRebindCanonical(
	value: unknown,
): WorkflowGateCarrierRebindCanonical | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const requestId = stringField(raw.requestId);
	const runId = stringField(raw.runId);
	const gateNodeId = stringField(raw.gateNodeId);
	const questionId = stringField(raw.questionId);
	const candidateExecutionId = stringField(raw.candidateExecutionId);
	const subjectDigest = stringField(raw.subjectDigest)?.toLowerCase();
	const holderAttempt = raw.holderAttempt;
	const exactKeys = [
		"requestId",
		"runId",
		"gateNodeId",
		"holderAttempt",
		"questionId",
		"candidateExecutionId",
		"subjectDigest",
	];
	if (
		!requestId ||
		!/^gate-carrier-rebind:[0-9a-f]{64}$/i.test(requestId) ||
		!runId ||
		!gateNodeId ||
		!questionId ||
		!candidateExecutionId ||
		!subjectDigest ||
		!/^[0-9a-f]{40}$/.test(subjectDigest) ||
		!Number.isInteger(holderAttempt) ||
		Number(holderAttempt) < 1 ||
		Object.keys(raw).length !== exactKeys.length ||
		!exactKeys.every((key) => Object.hasOwn(raw, key))
	) {
		return undefined;
	}
	return {
		requestId,
		runId,
		gateNodeId,
		holderAttempt: Number(holderAttempt),
		questionId,
		candidateExecutionId,
		subjectDigest,
	};
}

function rejectNonLoopback(
	req: express.Request,
	res: express.Response,
): boolean {
	if (loopbackSelfOrigin(req.headers.host)) return false;
	res.status(403).json({ ok: false, reason: "non_loopback_host" });
	return true;
}

function requestHeaders(
	req: express.Request,
): Record<string, string | undefined> {
	return {
		origin:
			typeof req.headers.origin === "string" ? req.headers.origin : undefined,
		referer:
			typeof req.headers.referer === "string" ? req.headers.referer : undefined,
	};
}

function resolveReQaCanonical(
	store: StateStore,
	executionId: string,
):
	| { ok: true; canonical: WorkflowReQaCanonical }
	| { ok: false; reason: string } {
	const session = store.getSession(executionId);
	if (
		!session ||
		(session.session_role ?? "main") !== "qa" ||
		(session.chat_thread_role ?? "main") !== "qa"
	) {
		return { ok: false, reason: "not_durable_qa_execution" };
	}
	if (store.getWorkflowActor(executionId)) {
		return { ok: false, reason: "qa_already_enrolled" };
	}
	const node = store.getWorkflowRunNodeForExecution(executionId);
	if (!node || node.node_id !== "qa") {
		return { ok: false, reason: "qa_projection_not_found" };
	}
	const run = store.getWorkflowRun(node.run_id);
	if (!run || run.status !== "active") {
		return { ok: false, reason: "active_run_not_found" };
	}
	return {
		ok: true,
		canonical: {
			runId: run.run_id,
			issueId: session.issue_id,
			projectName: session.project_name,
			sourceExecutionId: executionId,
			sourceAttempt: node.attempt,
			targetAttempt: node.attempt + 1,
		},
	};
}

/** Credential-authenticated workflow verdicts and the shared head read model. */
export function createWorkflowDecisionRouter(
	deps: WorkflowDecisionRouterDeps,
): express.Router {
	const router = express.Router();

	router.post("/output", (req, res) => {
		if (rejectNonLoopback(req, res)) return;
		const body = (req.body ?? {}) as Record<string, unknown>;
		const credential = stringField(body.credential);
		const clientRequestId = stringField(body.client_request_id);
		const payload = typeof body.payload === "string" ? body.payload : undefined;
		if (!credential || !clientRequestId || payload === undefined) {
			res.status(400).json({ ok: false, reason: "invalid_request" });
			return;
		}
		const result = deps.store.submitWorkflowNodeOutput({
			token: credential,
			clientRequestId,
			payload,
			now: deps.now?.(),
		});
		if (!result.ok) {
			res
				.status(result.reason === "credential_not_found" ? 401 : 409)
				.json(result);
			return;
		}
		res.json(result);
	});

	router.post("/head-authority", async (req, res) => {
		if (rejectNonLoopback(req, res)) return;
		const body = (req.body ?? {}) as Record<string, unknown>;
		const executionId = stringField(body.execution_id);
		const approveQuestionId = stringField(body.approve_question_id);
		if (!executionId) {
			res.status(400).json({ ok: false, reason: "execution_id_required" });
			return;
		}
		try {
			if (approveQuestionId) {
				const binding =
					deps.store.getWorkflowShipTargetBinding(approveQuestionId);
				const holder =
					deps.store.getCurrentWorkflowGateHolderByQuestionId(
						approveQuestionId,
					);
				if (!binding || binding.superseded_at) {
					const authorityMode = holder?.authority_mode ?? "legacy_runner_ship";
					const required =
						authorityMode === "runner_ship" ||
						authorityMode === "legacy_runner_ship";
					res.status(409).json({
						ok: false,
						reason: "ship_target_binding_unavailable",
						binding: {
							required,
							reason: binding?.superseded_at
								? "binding_superseded"
								: required
									? `${authorityMode}_binding_missing`
									: `not_required_for_${authorityMode}_authority`,
							authorityMode,
						},
					});
					return;
				}
				if (holder) {
					if (
						binding.run_id !== holder.run_id ||
						binding.frozen_head_sha !== holder.head_sha
					) {
						throw new Error("ship_target_binding_mismatch");
					}
				} else {
					const session = deps.store.getSession(executionId);
					if (
						session?.review_question_id !== approveQuestionId ||
						session.pr_head_sha?.toLowerCase() !== binding.frozen_head_sha
					) {
						throw new Error("ship_target_binding_mismatch");
					}
					if (
						binding.run_id &&
						deps.store.getWorkflowRunIdForExecution(executionId) !==
							binding.run_id
					) {
						throw new Error("ship_target_binding_mismatch");
					}
				}
				if (binding.target_repo_identity !== "__main__") {
					throw new Error("nested_ship_unsupported");
				}
				const authority = await resolveBoundRepositoryAuthority({
					authorityRoot: binding.target_repo_path,
				});
				const receiptEffectId = binding.worktree_binding_generation.startsWith(
					"receipt-v1:",
				)
					? binding.worktree_binding_generation.slice("receipt-v1:".length)
					: undefined;
				const materialized = receiptEffectId
					? deps.store.getWorkflowMaterializedHeadByEffect(receiptEffectId)
					: undefined;
				if (
					authority.path !== binding.target_repo_path ||
					authority.identity !== "__main__" ||
					authority.probeRepoSlug !== binding.probe_repo_slug ||
					(receiptEffectId
						? !materialized ||
							materialized.effectId !== receiptEffectId ||
							materialized.repo.toLowerCase() !==
								binding.probe_repo_slug.toLowerCase() ||
							materialized.head.toLowerCase() !== binding.frozen_head_sha
						: authority.headSha !== binding.frozen_head_sha)
				) {
					throw new Error("ship_target_authority_drift");
				}
				if (materialized) {
					const exactHeadAuthority = binding.run_id
						? deps.store.resolveWorkflowExactHeadAuthority({
								runId: binding.run_id,
								headSha: binding.frozen_head_sha,
							})
						: undefined;
					const nodeBinding = exactHeadAuthority?.valid
						? exactHeadAuthority.binding
						: undefined;
					if (!nodeBinding) throw new Error("ship_target_authority_drift");
					let probe: WorkflowPrProbeResult;
					try {
						probe = await (deps.prProbe ?? probeWorkflowPr)({
							prNumber: nodeBinding.pr_number,
							probeRepoSlug: binding.probe_repo_slug,
						});
					} catch {
						throw new Error("ship_target_authority_drift");
					}
					if (
						typeof probe.state !== "string" ||
						typeof probe.isDraft !== "boolean" ||
						typeof probe.isCrossRepository !== "boolean" ||
						typeof probe.headRefName !== "string" ||
						typeof probe.headRefOid !== "string" ||
						probe.state.trim().toUpperCase() !== "OPEN" ||
						probe.isDraft ||
						probe.isCrossRepository ||
						!workflowPrRefValid(probe.headRefName) ||
						materialized.ref !== `refs/heads/${probe.headRefName}` ||
						probe.headRefOid.trim().toLowerCase() !== binding.frozen_head_sha
					) {
						throw new Error("ship_target_authority_drift");
					}
				}
				res.json({
					ok: true,
					executionId,
					approveQuestionId,
					targetRepoIdentity: binding.target_repo_identity,
					prHeadSha: materialized?.head ?? authority.headSha,
				});
				return;
			}
			const authority = await resolveWorkflowHeadAuthority(
				deps.store,
				executionId,
			);
			res.json({
				ok: true,
				executionId,
				prHeadSha: authority.prHeadSha,
			});
		} catch (error) {
			res.status(409).json({
				ok: false,
				reason: error instanceof Error ? error.message : "head_unavailable",
			});
		}
	});

	router.post("/decision", async (req, res) => {
		if (rejectNonLoopback(req, res)) return;
		const body = (req.body ?? {}) as WorkflowDecisionBody;
		const credential = stringField(body.credential);
		const clientRequestId = stringField(body.client_request_id);
		const status = stringField(body.status)?.toLowerCase();
		const summary = stringField(body.summary);
		const clientHead = stringField(body.client_pr_head_sha)?.toLowerCase();
		if (!credential || !clientRequestId || !status) {
			res.status(400).json({ ok: false, reason: "invalid_request" });
			return;
		}
		if (status !== "pass" && status !== "fail") {
			res.status(400).json({ ok: false, reason: "invalid_status" });
			return;
		}
		if (clientHead && !/^[0-9a-f]{40}$/.test(clientHead)) {
			res.status(400).json({ ok: false, reason: "invalid_client_head" });
			return;
		}

		const credentialRow =
			deps.store.getWorkflowSubmissionCredentialByToken(credential);
		if (!credentialRow) {
			res.status(401).json({ ok: false, reason: "credential_not_found" });
			return;
		}
		let engineCanonical: EngineDecisionCanonical | undefined;
		try {
			engineCanonical = await resolveEngineDecisionCanonical(
				deps,
				credentialRow,
				status as "pass" | "fail",
			);
		} catch (error) {
			res.status(409).json({
				ok: false,
				reason:
					error instanceof Error
						? error.message
						: "decision_authority_unavailable",
			});
			return;
		}
		if (engineCanonical) {
			if (clientHead && clientHead !== engineCanonical.serverHead) {
				res.status(409).json({
					ok: false,
					reason: "head_authority_mismatch",
					expectedPrHeadSha: engineCanonical.serverHead,
				});
				return;
			}
			let gateEntryBinding:
				| Awaited<ReturnType<typeof resolveGateEntryBinding>>
				| undefined;
			try {
				// An already-consumed credential must reach the store's immutable replay
				// receipt without depending on a fresh network attestation.
				gateEntryBinding = credentialRow.consumed_at
					? undefined
					: await resolveGateEntryBinding(deps, engineCanonical);
			} catch (error) {
				res.status(409).json({
					ok: false,
					reason:
						error instanceof Error
							? error.message
							: "land_head_pr_identity_unavailable",
					...(error instanceof WorkflowDecisionRejection && error.detail
						? { detail: error.detail }
						: {}),
				});
				return;
			}
			const result = deps.store.submitWorkflowDecisionByCredential({
				nodeReuseEnabled: deps.nodeReuseEnabled?.() ?? false,
				credential,
				clientRequestId,
				predicate: engineCanonical.predicate,
				subjectDigest: engineCanonical.serverHead,
				issuerVendor: engineCanonical.issuerVendor,
				issuerModel: engineCanonical.issuerModel,
				subjectProducerExecutionId: engineCanonical.producerExecutionId,
				subjectProducerVendor: engineCanonical.producerVendor,
				claimExpiresAt: credentialRow.expires_at,
				evidence: summary ? { summary } : undefined,
				...(gateEntryBinding ? { gateEntryBinding } : {}),
				alertIdentity: deps.resolveAlertIdentity(
					engineCanonical.reporting.project_name,
					engineCanonical.reporting.issue_id,
					credentialRow.run_id,
				),
				now: deps.now?.(),
			});
			if (!result.ok) {
				res.status(decisionRejectionStatus(result.reason)).json(result);
				return;
			}
			enqueueCommittedWorkflowClaim(deps, result);
			deps.store.insertEvent({
				event_id: `workflow-decision:${credentialRow.id}:${clientRequestId}`,
				execution_id: engineCanonical.reporting.execution_id,
				issue_id: engineCanonical.reporting.issue_id,
				project_name: engineCanonical.reporting.project_name,
				event_type: "workflow_decision",
				source: "bridge.workflow-decision",
				payload: {
					status,
					predicate: engineCanonical.predicate,
					targetExecutionId: engineCanonical.producerExecutionId,
					subjectHead: engineCanonical.serverHead,
					...(summary ? { summary } : {}),
				},
			});
			persistRunnerMemoryCloseout(
				deps.store,
				credentialRow.execution_id,
				body.runner_memory_closeout,
				"[workflow-decision]",
			);
			res.json({
				ok: true,
				claimId: result.claimId,
				serverSeq: result.serverSeq,
				idempotentReplay: result.idempotentReplay,
				requestId: clientRequestId,
			});
			return;
		}
		const reporting = deps.store.getSession(credentialRow.execution_id);
		if (
			!reporting ||
			(reporting.session_role ?? "main") !== "qa" ||
			(reporting.chat_thread_role ?? "main") !== "qa"
		) {
			res.status(409).json({ ok: false, reason: "not_durable_qa_execution" });
			return;
		}

		let serverHead: string;
		try {
			serverHead = (
				await resolveWorkflowHeadAuthority(deps.store, reporting.execution_id)
			).prHeadSha;
		} catch (error) {
			res.status(409).json({
				ok: false,
				reason: error instanceof Error ? error.message : "head_unavailable",
			});
			return;
		}
		if (clientHead && clientHead !== serverHead) {
			res.status(409).json({
				ok: false,
				reason: "head_authority_mismatch",
				expectedPrHeadSha: serverHead,
			});
			return;
		}

		const producerNode = deps.store
			.listWorkflowRunNodes(credentialRow.run_id, "implement")
			.filter(
				(node) => node.execution_id && node.attempt <= credentialRow.attempt,
			)
			.at(-1);
		if (!producerNode?.execution_id) {
			res.status(409).json({ ok: false, reason: "producer_not_found" });
			return;
		}
		// The ledger stores one row per logical attempt. A normal QA kickback
		// therefore leaves historical implement rows behind; select the latest
		// producer at or before this QA attempt instead of treating history as
		// ambiguity. ORDER BY attempt in listWorkflowRunNodes makes this stable.
		const producer = deps.store.getSession(producerNode.execution_id);
		if (!producer) {
			res.status(409).json({ ok: false, reason: "producer_not_found" });
			return;
		}
		const now = deps.now?.() ?? new Date().toISOString();
		const nowMs = Date.parse(now);
		if (!Number.isFinite(nowMs)) {
			res.status(500).json({ ok: false, reason: "invalid_server_clock" });
			return;
		}
		const result = deps.store.submitWorkflowDecisionByCredential({
			nodeReuseEnabled: deps.nodeReuseEnabled?.() ?? false,
			credential,
			clientRequestId,
			predicate: status === "pass" ? "qa_passed" : "qa_failed",
			subjectDigest: serverHead,
			issuerVendor: adapterTypeToFamily(reporting.adapter_type),
			issuerModel:
				reporting.runner_model ??
				reporting.dispatch_model ??
				reporting.adapter_type ??
				"unknown",
			subjectProducerExecutionId: producer.execution_id,
			subjectProducerVendor: adapterTypeToFamily(producer.adapter_type),
			// Persisted credential expiry is the deterministic server-owned claim
			// deadline. Recomputing `now + TTL` here makes a response-loss retry hash
			// differently even when the client payload is exact.
			claimExpiresAt: credentialRow.expires_at,
			evidence: summary ? { summary } : undefined,
			alertIdentity: deps.resolveAlertIdentity(
				reporting.project_name,
				reporting.issue_id,
				credentialRow.run_id,
			),
			now,
		});
		if (!result.ok) {
			res.status(decisionRejectionStatus(result.reason)).json(result);
			return;
		}
		enqueueCommittedWorkflowClaim(deps, result);

		const eventId = `workflow-decision:${credentialRow.id}:${clientRequestId}`;
		deps.store.insertEvent({
			event_id: eventId,
			execution_id: reporting.execution_id,
			issue_id: reporting.issue_id,
			project_name: reporting.project_name,
			event_type: "qa_result",
			source: "bridge.workflow-decision",
			payload: {
				status,
				targetExecutionId: producer.execution_id,
				qaExecutionId: reporting.execution_id,
				prHeadSha: serverHead,
				...(summary ? { summary } : {}),
			},
		});
		persistRunnerMemoryCloseout(
			deps.store,
			credentialRow.execution_id,
			body.runner_memory_closeout,
			"[workflow-decision]",
		);
		res.json({
			ok: true,
			claimId: result.claimId,
			serverSeq: result.serverSeq,
			idempotentReplay: result.idempotentReplay,
			requestId: clientRequestId,
		});
	});

	router.post("/re-qa/stage", (req, res) => {
		if (!deps.reQa) {
			res.status(503).json({
				ok: false,
				reason: "re_qa_unavailable",
			});
			return;
		}
		const selfOrigin = loopbackSelfOrigin(req.headers.host);
		if (!selfOrigin) {
			res.status(403).json({ ok: false, reason: "non_loopback_host" });
			return;
		}
		if (!isSameOrigin(requestHeaders(req), selfOrigin)) {
			res.status(403).json({ ok: false, reason: "cross_origin" });
			return;
		}
		const executionId = stringField(
			(req.body as { execution_id?: unknown } | undefined)?.execution_id,
		);
		if (!executionId) {
			res.status(400).json({ ok: false, reason: "execution_id_required" });
			return;
		}
		const resolved = resolveReQaCanonical(deps.store, executionId);
		if (!resolved.ok) {
			res.status(409).json(resolved);
			return;
		}
		const confirmToken = deps.reQa.tokens.issue(
			canonicalSubmissionDigest(resolved.canonical),
		);
		res.json({ ok: true, canonical: resolved.canonical, confirmToken });
	});

	router.post("/gate-carrier-rebind/stage", (req, res) => {
		if (!deps.gateCarrierRebind) {
			res
				.status(503)
				.json({ ok: false, reason: "gate_carrier_rebind_unavailable" });
			return;
		}
		const selfOrigin = loopbackSelfOrigin(req.headers.host);
		if (!selfOrigin) {
			res.status(403).json({ ok: false, reason: "non_loopback_host" });
			return;
		}
		if (!isSameOrigin(requestHeaders(req), selfOrigin)) {
			res.status(403).json({ ok: false, reason: "cross_origin" });
			return;
		}
		const body = (req.body ?? {}) as {
			question_id?: unknown;
			candidate_execution_id?: unknown;
		};
		const questionId = stringField(body.question_id);
		const candidateExecutionId = stringField(body.candidate_execution_id);
		if (!questionId || !candidateExecutionId) {
			res.status(400).json({ ok: false, reason: "invalid_request" });
			return;
		}
		const canonical = deps.store.resolveWorkflowGateCarrierRebindCanonical(
			questionId,
			candidateExecutionId,
		);
		if (!canonical) {
			res.status(409).json({ ok: false, reason: "rebind_proof_unavailable" });
			return;
		}
		const confirmToken = deps.gateCarrierRebind.tokens.issue(
			canonicalSubmissionDigest(canonical),
		);
		res.json({ ok: true, canonical, confirmToken });
	});

	router.post("/gate-carrier-rebind", (req, res) => {
		if (!deps.gateCarrierRebind) {
			res
				.status(503)
				.json({ ok: false, reason: "gate_carrier_rebind_unavailable" });
			return;
		}
		const selfOrigin = loopbackSelfOrigin(req.headers.host);
		if (!selfOrigin) {
			res.status(403).json({ ok: false, reason: "non_loopback_host" });
			return;
		}
		if (!isSameOrigin(requestHeaders(req), selfOrigin)) {
			res.status(403).json({ ok: false, reason: "cross_origin" });
			return;
		}
		const input = (req.body ?? {}) as {
			canonical?: unknown;
			confirmToken?: unknown;
		};
		const canonical = workflowGateCarrierRebindCanonical(input.canonical);
		const confirmToken = stringField(input.confirmToken);
		if (!canonical || !confirmToken) {
			res.status(400).json({ ok: false, reason: "missing_canonical_or_token" });
			return;
		}
		const canonicalDigest = canonicalSubmissionDigest(canonical);
		const prior = deps.store.getWorkflowGateCarrierRebindReceipt(
			canonical.requestId,
		);
		if (prior) {
			if (
				prior.canonicalDigest !== canonicalDigest ||
				prior.questionId !== canonical.questionId ||
				prior.sourceExecutionId !== canonical.candidateExecutionId
			) {
				res.status(409).json({ ok: false, reason: "request_conflict" });
				return;
			}
			res.json({
				ok: true,
				idempotentReplay: true,
				questionId: prior.questionId,
				sourceExecutionId: prior.sourceExecutionId,
				reviewWindowStartedAt: prior.reviewWindowStartedAt,
			});
			return;
		}
		const current = deps.store.resolveWorkflowGateCarrierRebindCanonical(
			canonical.questionId,
			canonical.candidateExecutionId,
		);
		if (!current || canonicalSubmissionDigest(current) !== canonicalDigest) {
			res.status(409).json({ ok: false, reason: "rebind_state_changed" });
			return;
		}
		const token = deps.gateCarrierRebind.tokens.verifyAndConsume(
			confirmToken,
			canonicalDigest,
		);
		if (!token.ok) {
			res.status(403).json({ ok: false, reason: token.reason });
			return;
		}
		const result = deps.store.rebindWorkflowGateCarrier({
			requestId: canonical.requestId,
			questionId: canonical.questionId,
			candidateExecutionId: canonical.candidateExecutionId,
			canonicalDigest,
			now: deps.now?.() ?? new Date().toISOString(),
		});
		if (!result.ok) {
			res.status(result.reason === "invalid_input" ? 400 : 409).json(result);
			return;
		}
		res.json(result);
	});

	router.post("/loop-reentry/stage", (req, res) => {
		if (!deps.loopReentry) {
			res.status(503).json({ ok: false, reason: "loop_reentry_unavailable" });
			return;
		}
		const selfOrigin = loopbackSelfOrigin(req.headers.host);
		if (!selfOrigin) {
			res.status(403).json({ ok: false, reason: "non_loopback_host" });
			return;
		}
		if (!isSameOrigin(requestHeaders(req), selfOrigin)) {
			res.status(403).json({ ok: false, reason: "cross_origin" });
			return;
		}
		const body = (req.body ?? {}) as {
			execution_id?: unknown;
			loop_id?: unknown;
		};
		const executionId = stringField(body.execution_id);
		const loopId = stringField(body.loop_id);
		if (!executionId || !loopId) {
			res.status(400).json({ ok: false, reason: "invalid_request" });
			return;
		}
		const canonical = deps.store.resolveWorkflowLoopReentryCanonical(
			executionId,
			loopId,
		);
		if (!canonical) {
			res.status(409).json({ ok: false, reason: "loop_reentry_unavailable" });
			return;
		}
		const confirmToken = deps.loopReentry.tokens.issue(
			canonicalSubmissionDigest(canonical),
		);
		res.json({ ok: true, canonical, confirmToken });
	});

	router.post("/loop-reentry", (req, res) => {
		if (!deps.loopReentry) {
			res.status(503).json({ ok: false, reason: "loop_reentry_unavailable" });
			return;
		}
		const selfOrigin = loopbackSelfOrigin(req.headers.host);
		if (!selfOrigin) {
			res.status(403).json({ ok: false, reason: "non_loopback_host" });
			return;
		}
		if (!isSameOrigin(requestHeaders(req), selfOrigin)) {
			res.status(403).json({ ok: false, reason: "cross_origin" });
			return;
		}
		const input = (req.body ?? {}) as {
			canonical?: WorkflowLoopReentryCanonical;
			confirmToken?: unknown;
		};
		const confirmToken = stringField(input.confirmToken);
		if (!input.canonical || !confirmToken) {
			res.status(400).json({ ok: false, reason: "missing_canonical_or_token" });
			return;
		}
		const canonical = input.canonical;
		const canonicalDigest = canonicalSubmissionDigest(canonical);
		const prior = deps.store.getWorkflowLoopReentryReceipt(canonical.requestId);
		if (prior) {
			if (prior.canonicalDigest !== canonicalDigest) {
				res.status(409).json({ ok: false, reason: "request_conflict" });
				return;
			}
			res.json({
				ok: true,
				idempotentReplay: true,
				receipt: prior.receipt,
			});
			return;
		}
		const current = deps.store.resolveWorkflowLoopReentryCanonical(
			canonical.sourceExecutionId,
			canonical.loopId,
		);
		if (!current || canonicalSubmissionDigest(current) !== canonicalDigest) {
			res.status(409).json({ ok: false, reason: "loop_state_changed" });
			return;
		}
		const token = deps.loopReentry.tokens.verifyAndConsume(
			confirmToken,
			canonicalDigest,
		);
		if (!token.ok) {
			res.status(403).json({ ok: false, reason: token.reason });
			return;
		}
		const result = deps.store.commitWorkflowLoopReentryRequest({
			nodeReuseEnabled: deps.nodeReuseEnabled?.() ?? false,
			canonical,
			canonicalDigest,
			tokenIdentity: canonicalSubmissionDigest(confirmToken),
			initiator: canonical.sourceExecutionId,
			now: deps.now?.() ?? new Date().toISOString(),
		});
		if (!result.ok) {
			res.status(result.reason === "invalid_input" ? 400 : 409).json(result);
			return;
		}
		res.json(result);
	});

	router.post("/re-qa", async (req, res) => {
		if (!deps.reQa) {
			res.status(503).json({
				ok: false,
				reason: "re_qa_unavailable",
			});
			return;
		}
		const selfOrigin = loopbackSelfOrigin(req.headers.host);
		if (!selfOrigin) {
			res.status(403).json({ ok: false, reason: "non_loopback_host" });
			return;
		}
		if (!isSameOrigin(requestHeaders(req), selfOrigin)) {
			res.status(403).json({ ok: false, reason: "cross_origin" });
			return;
		}
		const input = (req.body ?? {}) as {
			canonical?: WorkflowReQaCanonical;
			confirmToken?: string;
		};
		if (!input.canonical || typeof input.confirmToken !== "string") {
			res.status(400).json({ ok: false, reason: "missing_canonical_or_token" });
			return;
		}
		const canonical = input.canonical;
		const resolved = resolveReQaCanonical(
			deps.store,
			canonical.sourceExecutionId,
		);
		if (
			!resolved.ok ||
			canonicalSubmissionDigest(resolved.canonical) !==
				canonicalSubmissionDigest(canonical)
		) {
			res.status(409).json({ ok: false, reason: "re_qa_state_changed" });
			return;
		}
		const token = deps.reQa.tokens.verifyAndConsume(
			input.confirmToken,
			canonicalSubmissionDigest(canonical),
		);
		if (!token.ok) {
			res.status(403).json({ ok: false, reason: token.reason });
			return;
		}

		const existingAttempts = deps.store.listWorkflowRunNodes(
			canonical.runId,
			"qa",
		);
		const latestQaAttempt = existingAttempts.at(-1)?.attempt ?? 0;
		if (latestQaAttempt >= canonical.targetAttempt) {
			const existing = existingAttempts.find(
				(candidate) => candidate.attempt === canonical.targetAttempt,
			);
			if (
				existing?.execution_id &&
				deps.store.getWorkflowActivationForAttempt({
					executionId: existing.execution_id,
					runId: canonical.runId,
					nodeId: "qa",
					attempt: canonical.targetAttempt,
				})
			) {
				res.json({
					ok: true,
					idempotentReplay: true,
					executionId: existing.execution_id,
					targetAttempt: canonical.targetAttempt,
				});
				return;
			}
		}

		let prHeadSha: string;
		try {
			prHeadSha = (
				await resolveWorkflowHeadAuthority(
					deps.store,
					canonical.sourceExecutionId,
				)
			).prHeadSha;
		} catch (error) {
			res.status(409).json({
				ok: false,
				reason: error instanceof Error ? error.message : "head_unavailable",
			});
			return;
		}
		try {
			const spawned = await deps.reQa.respawn(canonical, prHeadSha);
			const binding = deps.store.getWorkflowActivationForAttempt({
				executionId: spawned.executionId,
				runId: canonical.runId,
				nodeId: "qa",
				attempt: canonical.targetAttempt,
			});
			if (
				!binding ||
				binding.run_id !== canonical.runId ||
				binding.node_id !== "qa" ||
				binding.attempt !== canonical.targetAttempt
			) {
				throw new Error("replacement_not_admitted");
			}
			res.json({
				ok: true,
				idempotentReplay: false,
				executionId: spawned.executionId,
				targetAttempt: canonical.targetAttempt,
			});
		} catch (error) {
			res.status(500).json({
				ok: false,
				reason: error instanceof Error ? error.message : "re_qa_failed",
			});
		}
	});

	return router;
}
