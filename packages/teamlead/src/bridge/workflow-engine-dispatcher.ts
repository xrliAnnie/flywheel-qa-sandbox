import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { isThreeStagePhaseRole } from "flywheel-config";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import {
	isStateStoreIrreversibleTerminalForZombie,
	type StateStore,
	type WorkflowDeadExecutionActivityBaseline,
	type WorkflowDeadExecutionActivityEvidence,
	type WorkflowDeadExecutionWatchRow,
	type WorkflowEngineAlertIdentity,
	type WorkflowSideEffectRow,
} from "../StateStore.js";
import { resolveNodeDispatchAtLaunch } from "../workflow-dispatch-resolution.js";
import {
	parseWorkflowRunSnapshot,
	workflowNodeAgentContent,
} from "../workflow-run-snapshot.js";
import { workflowTemplateDispatchBlockReason } from "../workflow-template-dispatch.js";
import {
	captureDeadExecutionActivityBaseline,
	probeDeadExecutionActivity,
} from "./dead-exec-activity.js";
import { parseSqliteUtcMs } from "./founder-notify-utils.js";
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
	captureDeadExecutionActivityBaseline?: (
		executionId: string,
		projectName: string,
		sessionCommitCount: number | null,
	) => Promise<WorkflowDeadExecutionActivityBaseline>;
	probeDeadExecutionActivity?: (
		watch: WorkflowDeadExecutionWatchRow,
		sessionCommitCount: number | null,
	) => Promise<WorkflowDeadExecutionActivityEvidence | null>;
	alertSink?: {
		current?: { alert: (payload: AlertPayload) => Promise<AlertResult> };
	};
	resolveRunAlertIdentity?: (
		projectName: string,
		issueId: string,
	) => WorkflowEngineAlertIdentity;
}

export interface WorkflowEngineReconcileResult {
	started: number;
	held: number;
}

const NON_RETRYABLE_RESOURCE_FAILURE =
	/\b(quota|billing|usage\s+limit|credit(?:s)?\s+(?:exhausted|depleted)|auth(?:entication|orization)?\s+(?:failed|expired|required)|login\s+expired|unauthorized|forbidden)\b/i;

const APPROVED_FABLE_UNAVAILABILITY =
	/\b(?:fable|model|provider|service)\b[^.;\n]*\b(?:(?:temporarily|currently)\s+)?unavailable\b|\b(?:provider\s+outage|service\s+down)\b/i;

export const DEAD_EXECUTION_WATCH_TTL_MS = 24 * 60 * 60 * 1_000;

function isNonRetryableResourceFailure(error: string | undefined): boolean {
	return !!error && NON_RETRYABLE_RESOURCE_FAILURE.test(error);
}

function isApprovedFableUnavailability(error: string | undefined): boolean {
	return !!error && APPROVED_FABLE_UNAVAILABILITY.test(error);
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
	private readonly captureDeadExecutionActivityBaseline: NonNullable<
		WorkflowEngineDispatcherOptions["captureDeadExecutionActivityBaseline"]
	>;
	private readonly probeDeadExecutionActivity: NonNullable<
		WorkflowEngineDispatcherOptions["probeDeadExecutionActivity"]
	>;
	private readonly alertSink: WorkflowEngineDispatcherOptions["alertSink"];
	private readonly resolveRunAlertIdentity: NonNullable<
		WorkflowEngineDispatcherOptions["resolveRunAlertIdentity"]
	>;
	private readonly unknownLivenessCounts = new Map<string, number>();
	private deadExecutionWatchCursor:
		| { observedAt: string; deadExecutionId: string }
		| undefined;
	private readonly ownerId = randomUUID();
	private timer: NodeJS.Timeout | undefined;
	private reconciling = false;

	/** Default-on, call-time read so the direct flag console needs no restart. */
	private deadExecutionSweepEnabled(): boolean {
		return this.env.FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP !== "0";
	}

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
		this.captureDeadExecutionActivityBaseline =
			options.captureDeadExecutionActivityBaseline ??
			((executionId, projectName, sessionCommitCount) =>
				captureDeadExecutionActivityBaseline({
					executionId,
					projectName,
					markerPath: join(this.stateRoot, executionId),
					sessionCommitCount,
				}));
		this.probeDeadExecutionActivity =
			options.probeDeadExecutionActivity ??
			((watch, sessionCommitCount) =>
				probeDeadExecutionActivity({
					watch,
					markerPath: join(this.stateRoot, watch.dead_execution_id),
					sessionCommitCount,
				}));
		this.alertSink = options.alertSink;
		this.resolveRunAlertIdentity =
			options.resolveRunAlertIdentity ??
			((projectName) => ({
				leadId: "unassigned",
				projectName,
				leadResolution: "fallback",
			}));
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
			await this.reconcileWorkflowEngineAlerts();
			this.reconcileWorkflowDivergence();
			await this.reconcileDeadExecutionTripwires();
			if (this.deadExecutionSweepEnabled()) {
				await this.reconcileDeadExecutions();
			}
			for (const intent of this.options.store.listNonTerminalWorkflowSideEffects()) {
				if (intent.kind !== "dispatch") continue;
				const run = this.options.store.getWorkflowRun(intent.run_id);
				if (!run || run.engine_owned !== 1) continue;
				const siblingLaunches = this.options.store
					.listWorkflowSideEffects(intent.run_id)
					.filter(
						(row) =>
							row.kind === "dispatch" &&
							row.node_id === intent.node_id &&
							row.attempt === intent.attempt,
					);
				const latestOrdinal = siblingLaunches.reduce(
					(max, row) => Math.max(max, row.launch_ordinal),
					0,
				);
				const node = this.options.store.getWorkflowRunNode(
					intent.run_id,
					intent.node_id,
					intent.attempt,
				);
				if (
					intent.launch_ordinal !== latestOrdinal ||
					node?.execution_id !== intent.execution_id
				) {
					continue;
				}
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

	private async reconcileDeadExecutionTripwires(): Promise<void> {
		const store = this.options.store;
		if (typeof store.pruneWorkflowDeadExecutionWatches === "function") {
			const pruned = store.pruneWorkflowDeadExecutionWatches({
				now: this.now().toISOString(),
				ttlMs: DEAD_EXECUTION_WATCH_TTL_MS,
				limit: 200,
			});
			if (pruned > 0) {
				this.log(
					`workflow engine pruned ${pruned} dead-exec tripwire watch(es)`,
				);
			}
		}
		if (
			typeof store.listActiveWorkflowDeadExecutionWatches !== "function" ||
			typeof store.tripWorkflowDeadExecutionWatch !== "function"
		) {
			return;
		}
		let watches = store.listActiveWorkflowDeadExecutionWatches(
			200,
			this.deadExecutionWatchCursor,
		);
		if (watches.length === 0 && this.deadExecutionWatchCursor) {
			this.deadExecutionWatchCursor = undefined;
			watches = store.listActiveWorkflowDeadExecutionWatches(200);
		}
		const lastWatch = watches.at(-1);
		if (lastWatch) {
			this.deadExecutionWatchCursor = {
				observedAt: lastWatch.observed_at,
				deadExecutionId: lastWatch.dead_execution_id,
			};
		}
		for (const watch of watches) {
			const session = store.getSession(watch.dead_execution_id);
			const sessionCommitCount =
				typeof session?.commit_count === "number" ? session.commit_count : null;
			let evidence: WorkflowDeadExecutionActivityEvidence | null;
			try {
				evidence = await this.probeDeadExecutionActivity(
					watch,
					sessionCommitCount,
				);
			} catch (error) {
				this.log(
					`workflow engine dead-exec tripwire held for ${watch.dead_execution_id}: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			if (!evidence) continue;
			if (evidence.kind === "tmux_output") {
				this.log(
					`workflow engine dead-exec tripwire tmux-only activity logged for ${watch.dead_execution_id}: ${evidence.detail}`,
				);
				continue;
			}
			const tripped = store.tripWorkflowDeadExecutionWatch({
				deadExecutionId: watch.dead_execution_id,
				evidence,
				alertIdentity: this.resolveRunAlertIdentity(
					watch.project_name,
					watch.issue_id,
				),
				now: this.now().toISOString(),
			});
			if (!tripped.ok) {
				this.log(
					`workflow engine dead-exec tripwire commit held for ${watch.dead_execution_id}: ${tripped.reason}`,
				);
			}
		}
	}

	async reconcileWorkflowEngineAlerts(max = 20): Promise<number> {
		const sink = this.alertSink?.current;
		if (!sink) return 0;
		let finalized = 0;
		for (let index = 0; index < max; index += 1) {
			const now = this.now();
			const claim = this.options.store.claimNextWorkflowAlert({
				ownerId: this.ownerId,
				now: now.toISOString(),
				leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
			});
			if (!claim) break;
			try {
				const delivery = await sink.alert({
					...claim.payload,
					// ClaimsDB is claim-before-send, so each outbox attempt needs a
					// distinct transport identity or a failed attempt would suppress retry.
					eventId: `${claim.escalationUid}:${claim.attempt}`,
				});
				const accepted = delivery.sent === true || delivery.queued === true;
				this.options.store.finishWorkflowAlertDelivery({
					escalationUid: claim.escalationUid,
					ownerId: claim.ownerId,
					generation: claim.generation,
					outcome: accepted ? "sent" : "failed",
					...(accepted
						? {}
						: { error: delivery.skipped ?? "alert_not_delivered" }),
					now: this.now().toISOString(),
				});
				finalized += 1;
			} catch (error) {
				this.options.store.finishWorkflowAlertDelivery({
					escalationUid: claim.escalationUid,
					ownerId: claim.ownerId,
					generation: claim.generation,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
					now: this.now().toISOString(),
				});
				finalized += 1;
			}
		}
		return finalized;
	}

	private reconcileWorkflowDivergence(): void {
		if (
			typeof this.options.store.listWorkflowDivergenceCandidates !== "function"
		) {
			return;
		}
		for (const candidate of this.options.store.listWorkflowDivergenceCandidates()) {
			try {
				this.options.store.commitWorkflowDivergenceObservation({
					runId: candidate.runId,
					nodeId: candidate.nodeId,
					attempt: candidate.attempt,
					executionId: candidate.executionId,
					observedStatus: candidate.sessionStatus,
					observedLifecycleRevision: candidate.lifecycleRevision,
					now: this.now().toISOString(),
				});
			} catch (error) {
				this.log(
					`workflow divergence observation held for ${candidate.executionId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	private async reconcileDeadExecutions(): Promise<void> {
		const store = this.options.store;
		const runs =
			typeof store.listActiveWorkflowRuns === "function"
				? store.listActiveWorkflowRuns()
				: [];
		for (const run of runs) {
			if (run.engine_owned !== 1 || !run.snapshot) continue;
			let snapshot: ReturnType<typeof parseWorkflowRunSnapshot>;
			try {
				snapshot = parseWorkflowRunSnapshot(run.snapshot);
			} catch (error) {
				this.log(
					`workflow engine dead-exec sweep held for ${run.run_id}: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			for (const workflowNode of snapshot.resolved.nodes) {
				for (const node of store.listWorkflowRunNodes(
					run.run_id,
					workflowNode.id,
				)) {
					if (node.state !== "running" || !node.execution_id) continue;
					const session = store.getSession(node.execution_id);
					if (
						!isStateStoreIrreversibleTerminalForZombie(session?.status) &&
						!store.hasWorkflowExecutionTeardownFact(
							run.run_id,
							workflowNode.id,
							node.execution_id,
						)
					) {
						continue;
					}
					if (
						store.getWorkflowNodeCompletion(
							run.run_id,
							workflowNode.id,
							node.attempt,
						)
					) {
						continue;
					}
					const launches = store
						.listWorkflowSideEffects(run.run_id)
						.filter(
							(row) =>
								row.kind === "dispatch" &&
								row.node_id === workflowNode.id &&
								row.attempt === node.attempt,
						);
					const latest = launches.reduce<WorkflowSideEffectRow | undefined>(
						(current, row) =>
							!current || row.launch_ordinal > current.launch_ordinal
								? row
								: current,
						undefined,
					);
					if (!latest || latest.execution_id !== node.execution_id) continue;
					const resourceFailure = isNonRetryableResourceFailure(
						session?.last_error,
					);
					const runtime = store.getWorkflowExecutionRuntime(node.execution_id);
					const approvedDesignFallback =
						!resourceFailure &&
						isApprovedFableUnavailability(session?.last_error) &&
						workflowNode.type === "design" &&
						runtime?.vendor === "claude" &&
						runtime.model === "claude-fable-5";
					const retryDelaysMs = [60_000, 5 * 60_000, 15 * 60_000];
					if (
						!resourceFailure &&
						!approvedDesignFallback &&
						launches.length < 4
					) {
						const delay = retryDelaysMs[Math.max(0, launches.length - 1)]!;
						const launchedAt = parseSqliteUtcMs(latest.created_at);
						if (
							launchedAt !== null &&
							this.now().getTime() - launchedAt < delay
						) {
							continue;
						}
					}
					let liveness: GeneralizedLaunchLiveness;
					try {
						liveness = await this.probeLaunchLiveness(
							node.execution_id,
							run.project_name,
						);
					} catch (error) {
						this.log(
							`workflow engine dead-exec probe held for ${node.execution_id}: ${error instanceof Error ? error.message : String(error)}`,
						);
						continue;
					}
					if (liveness !== "dead") {
						if (liveness === "unknown") {
							const key = `${run.run_id}:${workflowNode.id}:${node.attempt}:${node.execution_id}`;
							const count = (this.unknownLivenessCounts.get(key) ?? 0) + 1;
							this.unknownLivenessCounts.set(key, count);
							if (count === 3) {
								const identity = this.resolveRunAlertIdentity(
									run.project_name,
									run.issue_id,
								);
								const uid = `probe_unknown:${run.run_id}:${workflowNode.id}:${node.attempt}:${node.execution_id}`;
								store.enqueueWorkflowEngineAlert({
									escalationUid: uid,
									runId: run.run_id,
									now: this.now().toISOString(),
									payload: {
										leadId: identity.leadId,
										projectName: identity.projectName,
										eventId: uid,
										eventType: "workflow_engine_escalation",
										severity: "severe",
										sessionKey: `wf:${run.run_id}`,
										title: `Workflow liveness is unknown for ${run.issue_id}`,
										body: `Run ${run.run_id} node ${workflowNode.id} has a terminal session without a completion receipt, but process liveness remained unknown for three probes. The engine kept the node unchanged.`,
										metadata: {
											workflowEngine: {
												runId: run.run_id,
												issueId: run.issue_id,
												nodeId: workflowNode.id,
												executionId: node.execution_id,
												disposition: "probe_unknown",
												leadResolution: identity.leadResolution,
											},
										},
									},
								});
							}
						}
						continue;
					}
					this.unknownLivenessCounts.delete(
						`${run.run_id}:${workflowNode.id}:${node.attempt}:${node.execution_id}`,
					);
					const observedAt = this.now().toISOString();
					const disposition = approvedDesignFallback
						? "design_fallback"
						: resourceFailure
							? "hold"
							: "retry";
					let activityBaseline:
						| WorkflowDeadExecutionActivityBaseline
						| undefined;
					if (disposition !== "hold") {
						try {
							activityBaseline =
								await this.captureDeadExecutionActivityBaseline(
									node.execution_id,
									run.project_name,
									typeof session?.commit_count === "number"
										? session.commit_count
										: null,
								);
						} catch (error) {
							// A replacement without a trustworthy baseline would disable the
							// founder's false-positive tripwire. Hold this tick and retry.
							this.log(
								`workflow engine dead-exec activity baseline held for ${node.execution_id}: ${error instanceof Error ? error.message : String(error)}`,
							);
							continue;
						}
					}
					const recovered = store.rollbackDeadWorkflowNodeExecution({
						runId: run.run_id,
						nodeId: workflowNode.id,
						attempt: node.attempt,
						deadExecutionId: node.execution_id,
						newExecutionId: randomUUID(),
						reason: approvedDesignFallback
							? "design_fable_unavailable_fallback_to_gpt_5_6"
							: resourceFailure
								? "quota_or_auth_failure"
								: "terminal_session_and_dead_probe",
						retryDisposition: disposition,
						activityBaseline,
						alertIdentity: this.resolveRunAlertIdentity(
							run.project_name,
							run.issue_id,
						),
						livenessEvidence: { liveness: "dead", observedAt },
						now: observedAt,
					});
					if (!recovered.ok) {
						this.log(
							`workflow engine dead-exec recovery held for ${node.execution_id}: ${recovered.reason}`,
						);
					}
				}
			}
		}
	}

	private markStarted(
		intent: WorkflowSideEffectRow,
		options: { preserveTerminalNode?: boolean } = {},
	): boolean {
		const run = this.options.store.getWorkflowRun(intent.run_id);
		if (!run) throw new Error("engine_run_not_found");
		const currentNode = this.options.store.getWorkflowRunNode(
			intent.run_id,
			intent.node_id,
			intent.attempt,
		);
		if (currentNode?.execution_id !== intent.execution_id) return false;
		this.options.store.applyWorkflowShadowBatch({
			projectName: run.project_name,
			issueId: run.issue_id,
			runId: run.run_id,
			expectedEngineOwned: 1,
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
		return true;
	}

	private adoptKnownSession(
		intent: WorkflowSideEffectRow,
	): boolean | undefined {
		const store = this.options.store;
		const session = store.getSession(intent.execution_id);
		if (!session) return undefined;
		if (isStateStoreIrreversibleTerminalForZombie(session.status)) {
			const receipt = store.getWorkflowNodeCompletion(
				intent.run_id,
				intent.node_id,
				intent.attempt,
			);
			if (receipt?.execution_id !== intent.execution_id) {
				throw new Error("engine_execution_dead");
			}
			return this.markStarted(intent, { preserveTerminalNode: true });
		}
		return this.markStarted(intent);
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
			return this.markStarted(intent, { preserveTerminalNode: true });
		}
		const adopted = this.adoptKnownSession(intent);
		if (adopted !== undefined) return adopted;
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
		const events = [...store.listWorkflowRunEvents(intent.run_id)].reverse();
		let transition: (typeof events)[number] | undefined;
		let transitionExecutionId = intent.execution_id;
		const visitedExecutionIds = new Set<string>();
		while (!visitedExecutionIds.has(transitionExecutionId)) {
			visitedExecutionIds.add(transitionExecutionId);
			transition = events.find((event) => {
				if (event.kind !== "edge_traversed") return false;
				try {
					const payload =
						typeof event.payload === "string"
							? (JSON.parse(event.payload) as typeof transitionPayload)
							: (event.payload as typeof transitionPayload);
					if (payload?.successorExecutionId !== transitionExecutionId)
						return false;
					transitionPayload = payload;
					return true;
				} catch {
					return false;
				}
			});
			if (transition) break;
			const rollback = events.find((event) => {
				if (event.kind !== "execution_dead_rolled_back") return false;
				try {
					const payload =
						typeof event.payload === "string"
							? (JSON.parse(event.payload) as { newExecutionId?: unknown })
							: (event.payload as { newExecutionId?: unknown });
					return payload?.newExecutionId === transitionExecutionId;
				} catch {
					return false;
				}
			});
			if (!rollback?.execution_id) break;
			transitionExecutionId = rollback.execution_id;
		}
		const startReservation = store.getWorkflowStartReservationForRun(
			intent.run_id,
		);
		const startRetryExecutionId =
			!transition &&
			startReservation?.node_id === intent.node_id &&
			startReservation.attempt === intent.attempt &&
			startReservation.execution_id === transitionExecutionId
				? transitionExecutionId
				: undefined;
		const predecessorExecutionId =
			transition?.execution_id ?? startRetryExecutionId;
		const predecessor = predecessorExecutionId
			? store.getSession(predecessorExecutionId)
			: undefined;
		const leadId = predecessorExecutionId
			? this.resolveLeadId(predecessorExecutionId)
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
			if (!predecessorExecutionId || !predecessor) {
				throw new Error("engine_predecessor_unavailable");
			}
			startPoint = (
				await this.resolvePredecessorHead(
					predecessorExecutionId,
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
		const approvedDesignFallback = store
			.listWorkflowRunEvents(intent.run_id)
			.some((event) => {
				if (event.kind !== "execution_dead_rolled_back") return false;
				try {
					const payload =
						typeof event.payload === "string"
							? (JSON.parse(event.payload) as Record<string, unknown>)
							: (event.payload as Record<string, unknown>);
					return (
						payload.newExecutionId === intent.execution_id &&
						payload.retryDisposition === "design_fallback"
					);
				} catch {
					return false;
				}
			});
		const dispatchResolution = resolveNodeDispatchAtLaunch(store, {
			runId: intent.run_id,
			nodeId: intent.node_id,
			env: this.env,
			approvedDesignFallback,
		});
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
			dispatchResolution,
		});
		if (!admitted.ok) {
			throw new Error(`engine_admission_${admitted.reason}`);
		}
		const runtime = store.getWorkflowExecutionRuntime(intent.execution_id);
		if (!runtime) throw new Error("engine_runtime_dispatch_missing");
		const runtimeDispatch = {
			vendor: runtime.vendor as "claude" | "codex",
			model: runtime.model,
			...(runtime.effort
				? {
						effort: runtime.effort as "low" | "medium" | "high" | "xhigh",
					}
				: {}),
		};

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
			const committedSession = this.adoptKnownSession(intent);
			if (committedSession !== undefined) return committedSession;
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
				dispatch: runtimeDispatch,
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
		return this.markStarted(intent, {
			preserveTerminalNode:
				store.getWorkflowRunNode(intent.run_id, intent.node_id, intent.attempt)
					?.state === "done",
		});
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
