import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { isThreeStagePhaseRole } from "flywheel-config";
import type { StateStore, WorkflowSideEffectRow } from "../StateStore.js";
import {
	parseWorkflowRunSnapshot,
	workflowNodeAgentContent,
} from "../workflow-run-snapshot.js";
import { workflowTemplateDispatchBlockReason } from "../workflow-template-dispatch.js";
import {
	type GeneralizedLaunchLiveness,
	getGeneralizedLaunchDelivery,
	probeGeneralizedLaunchLiveness,
	waitForGeneralizedLaunchDelivery,
} from "./generalized-launch-recovery.js";
import { resolveWorkflowHeadAuthority } from "./head-authority.js";
import {
	type MaterializedHeadAuthority,
	unavailableMaterializedHeadAuthority,
} from "./materialized-head-authority.js";
import type { IStartDispatcher } from "./retry-dispatcher.js";

interface WorkflowEngineDispatcherOptions {
	store: StateStore;
	startDispatcher: IStartDispatcher;
	env?: Record<string, string | undefined>;
	stateRoot?: string;
	log?: (message: string) => void;
	now?: () => Date;
	resolvePredecessorHead?: (
		executionId: string,
		projectName: string,
	) => Promise<string>;
	resolveLeadId?: (executionId: string) => string | undefined;
	materializedHeadAuthority?: MaterializedHeadAuthority;
	probeLaunchLiveness?: (
		executionId: string,
		projectName: string,
	) => Promise<GeneralizedLaunchLiveness>;
}

export interface WorkflowEngineReconcileResult {
	started: number;
	held: number;
}

/**
 * Consumes only engine-owned dispatch outbox rows. The snapshot already chose
 * the physical execution id and dispatch triple; this component may deliver or
 * recover that choice, but never select a different edge or successor.
 */
export class WorkflowEngineDispatcher {
	private readonly env: Record<string, string | undefined>;
	private readonly stateRoot: string;
	private readonly log: (message: string) => void;
	private readonly now: () => Date;
	private readonly resolvePredecessorHead: (
		executionId: string,
		projectName: string,
	) => Promise<string>;
	private readonly resolveLeadId: (executionId: string) => string | undefined;
	private readonly materializedHeadAuthority: MaterializedHeadAuthority;
	private readonly probeLaunchLiveness: (
		executionId: string,
		projectName: string,
	) => Promise<GeneralizedLaunchLiveness>;
	private readonly ownerId = randomUUID();
	private timer: NodeJS.Timeout | undefined;
	private reconciling = false;

	constructor(private readonly options: WorkflowEngineDispatcherOptions) {
		this.env = options.env ?? process.env;
		this.stateRoot =
			options.stateRoot ??
			join(homedir(), ".flywheel", "state", "launch-commits");
		this.log = options.log ?? (() => {});
		this.now = options.now ?? (() => new Date());
		this.resolvePredecessorHead =
			options.resolvePredecessorHead ??
			((executionId) =>
				resolveWorkflowHeadAuthority(options.store, executionId).then(
					(authority) => authority.prHeadSha,
				));
		this.resolveLeadId = options.resolveLeadId ?? (() => undefined);
		this.materializedHeadAuthority =
			options.materializedHeadAuthority ?? unavailableMaterializedHeadAuthority;
		this.probeLaunchLiveness =
			options.probeLaunchLiveness ?? probeGeneralizedLaunchLiveness;
	}

	start(intervalMs = 1_000): void {
		if (this.timer) return;
		void this.reconcile().catch((error) => {
			this.log(
				`workflow engine reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		this.timer = setInterval(() => {
			void this.reconcile().catch((error) => {
				this.log(
					`workflow engine reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		}, intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	async reconcile(): Promise<WorkflowEngineReconcileResult> {
		if (this.reconciling) return { started: 0, held: 0 };
		this.reconciling = true;
		const result = { started: 0, held: 0 };
		try {
			for (const intent of this.options.store.listNonTerminalWorkflowSideEffects()) {
				if (intent.kind !== "dispatch") continue;
				const run = this.options.store.getWorkflowRun(intent.run_id);
				if (!run || run.engine_owned !== 1) continue;
				try {
					const started = await this.consume(intent);
					if (started) result.started += 1;
					else result.held += 1;
				} catch (error) {
					result.held += 1;
					this.log(
						`workflow engine dispatch held for ${intent.execution_id}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
			return result;
		} catch (error) {
			this.log(
				`workflow engine reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return result;
		} finally {
			this.reconciling = false;
		}
	}

	private markStarted(
		intent: WorkflowSideEffectRow,
		options: { preserveTerminalNode?: boolean } = {},
	): void {
		const run = this.options.store.getWorkflowRun(intent.run_id);
		if (!run) throw new Error("engine_run_not_found");
		this.options.store.applyWorkflowShadowBatch({
			projectName: run.project_name,
			issueId: run.issue_id,
			runId: run.run_id,
			ops: [
				{
					op: "side_effect",
					node: intent.node_id,
					attempt: intent.attempt,
					executionId: intent.execution_id,
					to: "started",
				},
			],
		});
		if (!options.preserveTerminalNode) {
			this.options.store.upsertWorkflowRunNode({
				runId: intent.run_id,
				nodeId: intent.node_id,
				attempt: intent.attempt,
				state: "running",
				executionId: intent.execution_id,
			});
		}
	}

	private async consume(intent: WorkflowSideEffectRow): Promise<boolean> {
		const store = this.options.store;
		const run = store.getWorkflowRun(intent.run_id);
		if (!run?.snapshot || run.status !== "active" || run.engine_owned !== 1) {
			throw new Error("engine_run_not_active");
		}
		const snapshot = parseWorkflowRunSnapshot(run.snapshot);
		const dispatchBlocked = workflowTemplateDispatchBlockReason(
			snapshot.schema_version,
			this.env,
		);
		if (dispatchBlocked) {
			throw new Error(`engine_dispatch_${dispatchBlocked}`);
		}
		if (
			store.getWorkflowRunNode(intent.run_id, intent.node_id, intent.attempt)
				?.state === "done"
		) {
			this.markStarted(intent, { preserveTerminalNode: true });
			return true;
		}
		if (store.getSession(intent.execution_id)) {
			this.markStarted(intent);
			return true;
		}
		const node = snapshot.resolved.nodes.find(
			(candidate) => candidate.id === intent.node_id,
		);
		const agentContent = node ? workflowNodeAgentContent(node) : undefined;
		if (!node?.dispatch || !agentContent || node.type === "gate") {
			throw new Error("engine_node_not_executable");
		}
		let transitionPayload:
			| {
					successorExecutionId?: unknown;
					loopIteration?: unknown;
					outcome?: unknown;
			  }
			| undefined;
		const transition = [...store.listWorkflowRunEvents(intent.run_id)]
			.reverse()
			.find((event) => {
				if (event.kind !== "edge_traversed") return false;
				try {
					const payload =
						typeof event.payload === "string"
							? (JSON.parse(event.payload) as typeof transitionPayload)
							: (event.payload as typeof transitionPayload);
					if (payload?.successorExecutionId !== intent.execution_id)
						return false;
					transitionPayload = payload;
					return true;
				} catch {
					return false;
				}
			});
		const predecessor = transition?.execution_id
			? store.getSession(transition.execution_id)
			: undefined;
		const leadId = transition?.execution_id
			? this.resolveLeadId(transition.execution_id)
			: undefined;
		const loopIteration = Number(transitionPayload?.loopIteration);
		const phaseFixContext =
			node.type === "implement" &&
			transitionPayload?.outcome === "qa_fail" &&
			Number.isInteger(loopIteration) &&
			loopIteration > 0 &&
			transition?.execution_id
				? {
						round: loopIteration,
						qaSummary: this.qaFixSummary(transition.execution_id),
					}
				: undefined;
		let startPoint: string | undefined;
		if (isThreeStagePhaseRole(node.type)) {
			if (!transition?.execution_id || !predecessor) {
				throw new Error("engine_predecessor_unavailable");
			}
			startPoint = (
				await this.resolvePredecessorHead(
					transition.execution_id,
					run.project_name,
				)
			)
				.trim()
				.toLowerCase();
			if (!/^[0-9a-f]{40}$/.test(startPoint)) {
				throw new Error("engine_predecessor_head_invalid");
			}
		} else if (node.type === "review") {
			const predecessorIds = new Set(
				snapshot.manifest.edges
					.filter(
						(edge) => edge.to === node.id && edge.condition === "node_done",
					)
					.map((edge) => edge.from),
			);
			const outputProducers = snapshot.resolved.nodes.filter(
				(candidate) =>
					predecessorIds.has(candidate.id) &&
					candidate.capabilities.produces_output,
			);
			if (outputProducers.length > 0) {
				if (outputProducers.length !== 1) {
					throw new Error("engine_materialized_producer_ambiguous");
				}
				startPoint = (
					await this.materializedHeadAuthority.resolve(intent.run_id, node.id)
				).head
					.trim()
					.toLowerCase();
				if (!/^[0-9a-f]{40}$/.test(startPoint)) {
					throw new Error("engine_materialized_head_invalid");
				}
			}
		}
		const now = this.now();
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: intent.run_id,
			nodeId: intent.node_id,
			executionId: intent.execution_id,
			attempt: intent.attempt,
			now: now.toISOString(),
			expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
			absoluteDeadlineAt: new Date(
				now.getTime() + 24 * 60 * 60_000,
			).toISOString(),
			env: this.env,
		});
		if (!admitted.ok) {
			throw new Error(`engine_admission_${admitted.reason}`);
		}

		const ownerId = this.ownerId;
		const markerPath = join(this.stateRoot, intent.execution_id);
		const launch = store.recoverOrAcquireWorkflowLaunch({
			executionId: intent.execution_id,
			ownerId,
			now: now.toISOString(),
			leaseExpiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
			markerPath,
		});
		if (launch.status === "busy" || launch.status === "hold") return false;
		let launchGateToken: string;
		let commitWorkflowLaunch: () => { ok: boolean; reason?: string };
		let deliveryRepair:
			| { generation: number; attempt: number; ownerId: string }
			| undefined;
		if (launch.status === "committed") {
			if (store.getSession(intent.execution_id)) {
				this.markStarted(intent);
				return true;
			}
			const liveness = await this.probeLaunchLiveness(
				intent.execution_id,
				run.project_name,
			);
			if (liveness !== "dead") return false;
			const repairNow = this.now();
			const repair = store.claimWorkflowLaunchDeliveryRepair({
				executionId: intent.execution_id,
				repairOwner: ownerId,
				now: repairNow.toISOString(),
				leaseExpiresAt: new Date(
					repairNow.getTime() + 60 * 60_000,
				).toISOString(),
			});
			if (repair.status !== "claimed") return false;
			deliveryRepair = {
				generation: repair.generation,
				attempt: repair.attempt,
				ownerId,
			};
			launchGateToken = repair.token;
			commitWorkflowLaunch = () =>
				store.commitWorkflowLaunchDeliveryRepair({
					executionId: intent.execution_id,
					repairOwner: ownerId,
					generation: repair.generation,
					attempt: repair.attempt,
					markerPath,
					now: this.now().toISOString(),
				});
		} else {
			launchGateToken = launch.token;
			commitWorkflowLaunch = () =>
				store.fencedCommitWorkflowLaunch({
					executionId: intent.execution_id,
					ownerId,
					generation: launch.generation,
					deliveryAttempt: launch.deliveryAttempt,
					markerPath,
					now: this.now().toISOString(),
				});
		}
		let outputCredential = admitted.outputCredential;
		let submissionCredential = admitted.submissionCredential;
		if (admitted.idempotentReplay && launch.status === "acquired") {
			const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
			const absoluteDeadlineAt = new Date(
				now.getTime() + 24 * 60 * 60_000,
			).toISOString();
			if (node.capabilities.produces_output) {
				const rotated = store.rotateGeneralizedWorkflowOutputCredential({
					executionId: intent.execution_id,
					ownerId,
					generation: launch.generation,
					now: now.toISOString(),
					expiresAt,
					absoluteDeadlineAt,
				});
				if (!rotated.ok) {
					throw new Error(`engine_output_rotation_${rotated.reason}`);
				}
				outputCredential = rotated.outputCredential;
			}
			if (node.type === "qa" || node.type === "review") {
				const rotated = store.rotateGeneralizedWorkflowSubmissionCredential({
					executionId: intent.execution_id,
					ownerId,
					generation: launch.generation,
					now: now.toISOString(),
					expiresAt,
					absoluteDeadlineAt,
				});
				if (!rotated.ok) {
					throw new Error(`engine_submission_rotation_${rotated.reason}`);
				}
				submissionCredential = rotated.submissionCredential;
			}
		} else if (deliveryRepair) {
			const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
			const absoluteDeadlineAt = new Date(
				now.getTime() + 24 * 60 * 60_000,
			).toISOString();
			if (node.capabilities.produces_output) {
				const rotated =
					store.rotateGeneralizedWorkflowOutputCredentialForDeliveryRepair({
						executionId: intent.execution_id,
						repairOwner: deliveryRepair.ownerId,
						generation: deliveryRepair.generation,
						repairAttempt: deliveryRepair.attempt,
						now: now.toISOString(),
						expiresAt,
						absoluteDeadlineAt,
					});
				if (!rotated.ok) {
					throw new Error(`engine_output_delivery_rotation_${rotated.reason}`);
				}
				outputCredential = rotated.outputCredential;
			}
			if (node.type === "qa" || node.type === "review") {
				const rotated =
					store.rotateGeneralizedWorkflowSubmissionCredentialForDeliveryRepair({
						executionId: intent.execution_id,
						repairOwner: deliveryRepair.ownerId,
						generation: deliveryRepair.generation,
						repairAttempt: deliveryRepair.attempt,
						now: now.toISOString(),
						expiresAt,
						absoluteDeadlineAt,
					});
				if (!rotated.ok) {
					throw new Error(
						`engine_submission_delivery_rotation_${rotated.reason}`,
					);
				}
				submissionCredential = rotated.submissionCredential;
			}
		}
		const role = isThreeStagePhaseRole(node.type) ? node.type : "main";
		await this.options.startDispatcher.start({
			issueId: run.issue_id,
			issueIdentifier: run.issue_id,
			projectName: run.project_name,
			successorExecutionId: intent.execution_id,
			...(leadId && { leadId }),
			sessionRole: role,
			shareParentBranch: isThreeStagePhaseRole(node.type) ? true : undefined,
			...(startPoint && { startPoint }),
			ignoreRunnerLabelSelection: true,
			...(predecessor?.issue_identifier && {
				issueIdentifier: predecessor.issue_identifier,
			}),
			...(predecessor?.issue_title && { issueTitle: predecessor.issue_title }),
			...(predecessor?.design_backend && {
				designBackend: predecessor.design_backend,
			}),
			...(predecessor?.doc_tier === "full" ||
			predecessor?.doc_tier === "plan_only" ||
			predecessor?.doc_tier === "none"
				? { docTier: predecessor.doc_tier }
				: {}),
			...(predecessor?.issue_url && { issueUrl: predecessor.issue_url }),
			...(phaseFixContext && { phaseFixContext }),
			...(predecessor?.codex_skip !== undefined && {
				codexSkip: predecessor.codex_skip,
			}),
			// FLY-1372 §2.5: propagate the founder-ux snapshot hop-by-hop — the
			// successor session row must carry it (via the emitStarted seam) or
			// hop-2 would copy nothing and the gate would misread the run.
			...(predecessor?.founder_facing_ux !== undefined && {
				founderFacingUx: !!predecessor.founder_facing_ux,
			}),
			generalizedExecution: {
				engineOwned: true,
				executionId: intent.execution_id,
				runId: intent.run_id,
				nodeId: intent.node_id,
				attempt: intent.attempt,
				snapshotDigest: snapshot.snapshot_digest,
				dispatch: node.dispatch,
				capabilities: { ...node.capabilities },
				agentContent,
				outputCredential,
				submissionCredential,
				idempotencyKey: `engine:${intent.run_id}:${intent.node_id}:${intent.attempt}`,
				launchGateToken,
				commitWorkflowLaunch,
			},
		});
		let delivered = await waitForGeneralizedLaunchDelivery(
			store,
			intent.execution_id,
		);
		delivered ??= getGeneralizedLaunchDelivery(store, intent.execution_id);
		if (!delivered) return false;
		// A deterministic/fresh-spawn runner can finish before start() returns.
		// Never let launch bookkeeping regress its committed terminal projection.
		this.markStarted(intent, {
			preserveTerminalNode:
				store.getWorkflowRunNode(intent.run_id, intent.node_id, intent.attempt)
					?.state === "done",
		});
		return true;
	}

	private qaFixSummary(executionId: string): string {
		for (const event of [
			...this.options.store.getEventsByExecution(executionId),
		].reverse()) {
			if (event.event_type !== "workflow_decision") continue;
			const payload = event.payload as
				| { status?: unknown; summary?: unknown }
				| undefined;
			if (payload?.status !== "fail") continue;
			if (typeof payload.summary === "string" && payload.summary.trim()) {
				return payload.summary.trim().slice(0, 1_000);
			}
		}
		return "(no QA summary provided)";
	}
}
