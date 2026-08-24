import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isWorkflowPhaseRole } from "flywheel-config";
import type {
	WorkflowIssueDeliveryInput,
	WorkflowResumeContext,
} from "flywheel-edge-worker/dist/Blueprint.js";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import {
	isStateStoreIrreversibleTerminalForZombie,
	MAX_BLIND_REPLACEMENTS,
	type StateStore,
	WORKFLOW_LAUNCH_SOFT_LEASE_MS,
	type WorkflowDeadExecutionActivityBaseline,
	type WorkflowDeadExecutionActivityEvidence,
	type WorkflowDeadExecutionWatchRow,
	type WorkflowEngineAlertIdentity,
	type WorkflowLaunchWindowIdentity,
	type WorkflowSideEffectRow,
} from "../StateStore.js";
import { resolveNodeDispatchAtLaunch } from "../workflow-dispatch-resolution.js";
import { WORKFLOW_REPLACEMENT_RETRY_DELAYS_MS } from "../workflow-replacement-policy.js";
import {
	nodeRequiresFounderReview,
	parseWorkflowRunSnapshot,
	resolveWorkflowDecisionContract,
	workflowGateEntryPromptCapabilities,
	workflowNodeAgentContent,
} from "../workflow-run-snapshot.js";
import {
	SHIP_READY_REMIND_MS,
	type WorkflowShipReadyArm,
	type WorkflowShipReadyNotice,
	workflowShipReadyUid,
} from "../workflow-ship-ready.js";
import { credentialWindowForNode } from "../workflow-submission-expiry.js";
import { workflowApprovalGate } from "../workflow-template.js";
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
import { parsePaneLossGenerationParams } from "./pane-loss-reconcile.js";
import type { IStartDispatcher, StartResult } from "./retry-dispatcher.js";
import type { AdmissionDecision } from "./runner-admission.js";
import { waitForWorkflowLaunchOutcome } from "./workflow-launch-outcome.js";
import { resolveWorkflowResumeTarget } from "./workflow-resume-resolver.js";
import type { WorkflowReworkCoordinatorOutcome } from "./workflow-rework-coordinator.js";
import {
	drainWorkflowShipCarrierDeliveries,
	type WorkflowShipCarrierDeliveryOutcome,
} from "./workflow-ship-carrier-coordinator.js";

interface WorkflowEngineDispatcherOptions {
	store: StateStore;
	startDispatcher: IStartDispatcher;
	workflowReworkReentryEnabled?: () => boolean;
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
	probeUnlaunchedExternalEvidence?: (
		executionId: string,
		projectName: string,
	) => Promise<"absent" | "present" | "unknown">;
	cleanupUnlaunchedWorkflowWindow?: (
		identity: WorkflowLaunchWindowIdentity,
	) => Promise<"absent" | "cleaned" | "present" | "unknown">;
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
		runId: string,
	) => WorkflowEngineAlertIdentity;
	/** FLY-1375: engine-owned land nodes execute here instead of spawning. */
	landExecutor?: (operationId: string) => Promise<{
		status: "completed" | "busy" | "partial" | "held" | "superseded" | "rework";
		reason?: string;
	}>;
	shipReadyArm?: WorkflowShipReadyArm;
	reconcileWorkflowRework?: (
		requestId: string,
	) => Promise<WorkflowReworkCoordinatorOutcome>;
	reconcileWorkflowCarrier?: (
		questionId: string,
	) => Promise<WorkflowShipCarrierDeliveryOutcome>;
	/** FLY-1638: checked before durable execution admission/credential writes. */
	admissionProbe?: () => AdmissionDecision;
}

export interface WorkflowEngineReconcileResult {
	started: number;
	held: number;
}

export const DEAD_EXECUTION_WATCH_TTL_MS = 24 * 60 * 60 * 1_000;
const SHIP_READY_MAX_PER_TICK = 3;
const SHIP_READY_FOUNDER_RETRY_BASE_MS = 30_000;
const SHIP_READY_FOUNDER_RETRY_CAP_MS = 5 * 60_000;
const SHIP_READY_FOUNDER_BUDGET_MS = 45 * 60_000;

/**
 * Consumes only engine-owned dispatch outbox rows. The snapshot already chose
 * the physical execution id and dispatch triple; this component may deliver or
 * recover that choice, but never select a different edge or successor.
 */
export class WorkflowEngineDispatcher {
	private readonly env: Record<string, string | undefined>;
	private readonly workflowReworkReentryEnabled: () => boolean;
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
	private readonly probeUnlaunchedExternalEvidence: NonNullable<
		WorkflowEngineDispatcherOptions["probeUnlaunchedExternalEvidence"]
	>;
	private readonly cleanupUnlaunchedWorkflowWindow: NonNullable<
		WorkflowEngineDispatcherOptions["cleanupUnlaunchedWorkflowWindow"]
	>;
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
	private readonly shipReadyFounderRetries = new Map<
		string,
		{ attempts: number; nextAttemptAtMs: number }
	>();
	private readonly heldReworkRecoveryProbeAt = new Map<string, number>();
	private readonly completionExceptionProbeAt = new Map<string, number>();
	private deadExecutionWatchCursor:
		| { observedAt: string; deadExecutionId: string }
		| undefined;
	private readonly ownerId = randomUUID();
	private timer: NodeJS.Timeout | undefined;
	private reconciling = false;

	private unlaunchedThresholdMs(
		name:
			| "FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS"
			| "FLYWHEEL_ENGINE_UNLAUNCHED_ROLLBACK_MS",
		fallback: number,
	): number {
		const configured = Number(this.env[name]);
		return Number.isFinite(configured) && configured > 0
			? configured
			: fallback;
	}

	private reworkThresholdMs(
		name: "FLYWHEEL_ENGINE_REWORK_ALERT_MS" | "FLYWHEEL_ENGINE_REWORK_HOLD_MS",
		fallback: number,
	): number {
		const configured = Number(this.env[name]);
		return Number.isFinite(configured) && configured > 0
			? configured
			: fallback;
	}

	private probeTerminalLaunchLiveness(
		executionId: string,
		projectName: string,
	): Promise<GeneralizedLaunchLiveness> {
		return this.options.probeLaunchLiveness
			? this.probeLaunchLiveness(executionId, projectName)
			: probeGeneralizedLaunchLiveness(executionId, projectName, {
					allowMissingTargetHostAbsence: true,
				});
	}

	constructor(private readonly options: WorkflowEngineDispatcherOptions) {
		this.env = options.env ?? process.env;
		this.workflowReworkReentryEnabled =
			options.workflowReworkReentryEnabled ?? (() => true);
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
		this.probeUnlaunchedExternalEvidence =
			options.probeUnlaunchedExternalEvidence ?? (async () => "unknown");
		this.cleanupUnlaunchedWorkflowWindow =
			options.cleanupUnlaunchedWorkflowWindow ?? (async () => "unknown");
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
			await this.reconcileAdmissionPauseAlert();
			this.reconcileWorkflowDivergence();
			await this.reconcileDeadExecutionTripwires();
			await this.reconcileDeadExecutions();
			await this.reconcileWorkflowReworks(result);
			await this.reconcileWorkflowCarriers(result);
			this.reconcileWorkflowReworkStalls();
			await this.reconcileUnlaunchedWorkflowStalls();
			for (const intent of this.options.store.listNonTerminalWorkflowSideEffects()) {
				if (intent.kind !== "dispatch") continue;
				const run = this.options.store.getWorkflowRun(intent.run_id);
				if (!run || run.engine_owned !== 1 || run.status !== "active") continue;
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
			await this.reconcileWorkflowShipReady();
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

	private async reconcileAdmissionPauseAlert(): Promise<void> {
		const sink = this.alertSink?.current;
		if (!sink) return;
		const now = this.now();
		const claim = this.options.store.claimAdmissionPauseAlert({
			now: now.toISOString(),
			minAgeMs: 5 * 60_000,
		});
		if (!claim) return;
		let sent = false;
		try {
			const result = await sink.alert({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				eventId: `admission-pause:${claim.set_at}`,
				eventType: "workflow_engine_escalation",
				severity: "severe",
				sessionKey: `admission-pause:${claim.set_at}`,
				title: "Runner admission pause has remained active for 5 minutes",
				body: `The operator admission brake set by ${claim.set_by} is still active. It expires at ${claim.paused_until}. Check the restart/deploy before resuming it.`,
			});
			sent = result.sent === true || result.queued === true;
		} catch (error) {
			this.log(
				`admission pause alert held: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.options.store.finishAdmissionPauseAlert({
			setAt: claim.set_at,
			outcome: sent ? "sent" : "failed",
			now: this.now().toISOString(),
		});
	}

	private async reconcileWorkflowShipReady(): Promise<void> {
		const arm = this.options.shipReadyArm;
		if (!arm) return;
		const store = this.options.store;
		const now = this.now();
		const nowIso = now.toISOString();
		const nowMs = now.getTime();
		await this.reconcileRunnerShipMerges(arm, nowIso);

		try {
			const ready = store.listWorkflowShipReadyGates({ now: nowIso });
			const active = new Set(
				ready.map((notice) => workflowShipReadyUid(notice)),
			);
			for (const uid of this.shipReadyFounderRetries.keys()) {
				if (!active.has(uid)) this.shipReadyFounderRetries.delete(uid);
			}
			const selected: Array<{
				notice: WorkflowShipReadyNotice;
				founderDue: boolean;
			}> = [];
			for (const notice of ready) {
				const uid = workflowShipReadyUid(notice);
				const retry = this.shipReadyFounderRetries.get(uid);
				const founderDue =
					notice.pending.founder && (!retry || nowMs >= retry.nextAttemptAtMs);
				if (!notice.pending.lead && !founderDue) continue;
				selected.push({ notice, founderDue });
				if (selected.length >= SHIP_READY_MAX_PER_TICK) break;
			}

			for (const { notice, founderDue } of selected) {
				try {
					if (notice.pending.lead) {
						try {
							const queued = await arm.queueLeadNotice(notice);
							if (!queued.queued) {
								throw new Error("lead_queue_not_durable");
							}
							store.recordWorkflowShipReadyFact({
								runId: notice.runId,
								gateNodeId: notice.gateNodeId,
								attempt: notice.attempt,
								path: "lead",
								now: nowIso,
							});
						} catch (error) {
							this.log(
								`ship-ready Lead arm held for ${workflowShipReadyUid(notice)}: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}

					if (founderDue) {
						try {
							const outcome = await arm.postFounderCard(notice);
							if (outcome.kind === "posted") {
								store.recordWorkflowShipReadyFact({
									runId: notice.runId,
									gateNodeId: notice.gateNodeId,
									attempt: notice.attempt,
									path: "founder",
									now: nowIso,
								});
								this.shipReadyFounderRetries.delete(
									workflowShipReadyUid(notice),
								);
							} else if (outcome.kind === "permanent") {
								this.recordWorkflowShipReadyDeliveryFailure(
									notice,
									outcome.reason,
									nowIso,
								);
							} else {
								this.deferWorkflowShipReadyFounder(
									notice,
									outcome.reason,
									outcome.retryAfterMs,
									nowMs,
									nowIso,
								);
							}
						} catch (error) {
							this.deferWorkflowShipReadyFounder(
								notice,
								error instanceof Error ? error.message : String(error),
								undefined,
								nowMs,
								nowIso,
							);
						}
					}
				} catch (error) {
					this.log(
						`ship-ready candidate held for ${workflowShipReadyUid(notice)}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		} catch (error) {
			this.log(
				`ship-ready readiness scan held: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		let stalled: WorkflowShipReadyNotice[];
		try {
			stalled = store.listWorkflowShipReadyStalled({
				now: nowIso,
				remindAfterMs: SHIP_READY_REMIND_MS,
			});
		} catch (error) {
			this.log(
				`ship-ready stalled scan held: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}

		let handled: Awaited<
			ReturnType<WorkflowShipReadyArm["classifyShipHandled"]>
		>;
		try {
			handled = await arm.classifyShipHandled(stalled);
		} catch (error) {
			this.log(
				`ship-ready handled guard held: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		for (const notice of stalled) {
			try {
				const outcome = handled.get(workflowShipReadyUid(notice));
				if (!outcome || outcome.kind === "unknown") continue;
				if (outcome.kind === "handled") {
					if (outcome.reason === "pr_merged") {
						store.recordWorkflowShipReadyHandledObserved({
							runId: notice.runId,
							gateNodeId: notice.gateNodeId,
							attempt: notice.attempt,
							reason: "pr_merged",
							now: nowIso,
						});
					}
					continue;
				}
				store.recordWorkflowShipReadyStalledAlert({
					runId: notice.runId,
					gateNodeId: notice.gateNodeId,
					attempt: notice.attempt,
					gateOpenedAt: notice.gateOpenedAt,
					sourceExecutionId: notice.sourceExecutionId,
					alertIdentity: this.resolveRunAlertIdentity(
						notice.projectName,
						notice.issueId,
						notice.runId,
					),
					now: nowIso,
				});
			} catch (error) {
				this.log(
					`ship-ready stalled candidate held for ${workflowShipReadyUid(notice)}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	private async reconcileRunnerShipMerges(
		arm: WorkflowShipReadyArm,
		now: string,
	): Promise<void> {
		if (!arm.classifyRunnerShipMerged) return;
		const store = this.options.store;
		let candidates: ReturnType<typeof store.listRunnerShipHoldersForMergeProbe>;
		try {
			candidates = store.listRunnerShipHoldersForMergeProbe(now);
		} catch (error) {
			this.log(
				`runner-ship merge candidate scan held: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const activeCompletionDigests = new Set(
			candidates.map((candidate) => candidate.completionContextDigest),
		);
		for (const digest of this.completionExceptionProbeAt.keys()) {
			if (!activeCompletionDigests.has(digest)) {
				this.completionExceptionProbeAt.delete(digest);
			}
		}
		const nowMs = Date.parse(now);
		const eligibleCandidates = candidates.filter((candidate) => {
			const nextProbeAt = this.completionExceptionProbeAt.get(
				candidate.completionContextDigest,
			);
			return nextProbeAt === undefined || nowMs >= nextProbeAt;
		});
		let probes: Awaited<
			ReturnType<NonNullable<WorkflowShipReadyArm["classifyRunnerShipMerged"]>>
		>;
		try {
			probes = await arm.classifyRunnerShipMerged(eligibleCandidates);
		} catch (error) {
			this.log(
				`runner-ship merge probe held: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		for (const candidate of eligibleCandidates) {
			try {
				const alertIdentity = this.resolveRunAlertIdentity(
					candidate.projectName,
					candidate.issueId,
					candidate.runId,
				);
				if (candidate.authority.status === "authority_conflict") {
					store.recordRunnerShipAuthorityConflict({
						questionId: candidate.questionId,
						expectedDigest: candidate.authority.digest,
						alertIdentity,
						now,
					});
					continue;
				}
				if (candidate.observationConflict) {
					store.recordRunnerShipMergedObservationConflict({
						questionId: candidate.questionId,
						fingerprint: candidate.observationConflict.fingerprint,
						expectedDigest: candidate.observationConflict.digest,
						conflictingHeads: candidate.observationConflict.conflictingHeads,
						alertIdentity,
						now,
					});
					continue;
				}
				const probe = probes.get(candidate.questionId);
				if (!probe) continue;
				if (
					probe.failure?.notify &&
					candidate.authority.status === "resolved" &&
					candidate.fingerprint
				) {
					if (
						probe.failure.kind === "hydration_revalidation" &&
						candidate.mergedObserved?.status === "valid"
					) {
						store.recordRunnerShipHydrationRevalidationFailure({
							questionId: candidate.questionId,
							fingerprint: candidate.fingerprint,
							expectedHydratedHead: candidate.mergedObserved.headSha,
							error: probe.failure.reason,
							alertIdentity,
							now,
						});
					}
				}
				if (probe.state !== "merged") continue;
				const mergedHead = probe.headRefOid?.trim().toLowerCase();
				if (candidate.authority.status === "legacy_missing") {
					const anomaly = !mergedHead
						? ("head_unavailable" as const)
						: mergedHead !== candidate.subjectDigest.toLowerCase()
							? ("head_mismatch" as const)
							: candidate.holderState !== "approved"
								? ("rogue_before_approval" as const)
								: ("legacy_completion_blocked" as const);
					store.recordRunnerShipLegacyMergeAnomaly({
						questionId: candidate.questionId,
						expectedHolderState: candidate.holderState,
						expectedHolderHead: candidate.subjectDigest,
						observed: {
							prNumber: candidate.authority.prNumber,
							mergedHead: mergedHead ?? null,
							...(probe.rawHeadRefOid !== undefined
								? { rawHeadRefOid: probe.rawHeadRefOid }
								: {}),
							anomaly,
						},
						alertIdentity,
						now,
					});
					continue;
				}
				if (candidate.authority.status !== "resolved") continue;
				if (probe.evidence !== "current" && probe.evidence !== "verified") {
					continue;
				}
				const persisted = store.recordRunnerShipMergedObserved({
					questionId: candidate.questionId,
					expectedHolderState: candidate.holderState,
					expectedHolderHead: candidate.subjectDigest,
					expectedAuthority: candidate.authority,
					mergedHead: mergedHead ?? null,
					...(probe.rawHeadRefOid !== undefined
						? { rawHeadRefOid: probe.rawHeadRefOid }
						: {}),
					alertIdentity,
					now,
				});
				if (
					persisted.status === "candidate_changed" ||
					persisted.status === "quarantined"
				) {
					continue;
				}
				if (!mergedHead) {
					if (
						probe.failure?.notify &&
						probe.failure.kind === "head_enrichment" &&
						candidate.fingerprint
					) {
						store.recordRunnerShipHeadEnrichmentFailure({
							questionId: candidate.questionId,
							fingerprint: candidate.fingerprint,
							error: probe.failure.reason,
							alertIdentity,
							now,
						});
					}
					continue;
				}
				const deadEndKind =
					mergedHead !== candidate.subjectDigest.toLowerCase()
						? ("head_mismatch" as const)
						: candidate.holderState !== "approved"
							? ("rogue_before_approval" as const)
							: undefined;
				if (deadEndKind) {
					store.recordRunnerShipMergeDeadEnd({
						questionId: candidate.questionId,
						expectedHolderState: candidate.holderState,
						expectedHolderHead: candidate.subjectDigest,
						expectedAuthority: candidate.authority,
						expectedObservationHead: mergedHead,
						mergedHead,
						deadEndKind,
						alertIdentity,
						now,
					});
					continue;
				}
				const completionContextDigest =
					store.runnerShipCompletionDigestAfterObservedMerge({
						questionId: candidate.questionId,
						expectedHolderState: candidate.holderState,
						expectedHolderHead: candidate.subjectDigest,
						expectedAuthority: candidate.authority,
						mergedHead,
						now,
					});
				if (!completionContextDigest) continue;
				activeCompletionDigests.add(completionContextDigest);
				let completed: ReturnType<
					typeof store.completeWorkflowGateRunAfterShip
				>;
				try {
					completed = store.completeWorkflowGateRunAfterShip({
						questionId: candidate.questionId,
						mergedHead,
						expectedHolderState: candidate.holderState,
						expectedHolderHead: candidate.subjectDigest,
						expectedObservationHead: mergedHead,
						observedAuthority: candidate.authority,
						alertIdentity,
						now,
					});
				} catch (error) {
					const detail = (
						error instanceof Error ? error.message : String(error)
					).slice(0, 240);
					this.log(
						`runner-ship merge completion held for ${candidate.questionId}: ${detail}`,
					);
					try {
						store.recordRunnerShipCompletionException({
							questionId: candidate.questionId,
							expectedContextDigest: completionContextDigest,
							errorCode: "completion_exception",
							boundedDetail: detail,
							mergedHead,
							alertIdentity,
							now,
						});
						this.completionExceptionProbeAt.delete(completionContextDigest);
					} catch (ledgerError) {
						// This Map is only a process-local storm brake when even the durable
						// failure ledger cannot write; it never carries retry correctness.
						this.completionExceptionProbeAt.set(
							completionContextDigest,
							nowMs + 60_000,
						);
						this.log(
							`runner-ship completion failure ledger held for ${candidate.questionId}: ${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)}`,
						);
					}
					continue;
				}
				this.completionExceptionProbeAt.delete(completionContextDigest);
				if (!completed.ok) {
					this.log(
						`runner-ship merge completion held for ${candidate.questionId}: ${completed.reason}`,
					);
				}
			} catch (error) {
				this.log(
					`runner-ship merge candidate held for ${candidate.questionId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	private async reconcileWorkflowReworks(
		result: WorkflowEngineReconcileResult,
	): Promise<void> {
		const reconcile = this.options.reconcileWorkflowRework;
		if (!reconcile) return;
		let deliveries: ReturnType<
			typeof this.options.store.listWorkflowReworkDeliveries
		>;
		try {
			deliveries = this.options.store.listWorkflowReworkDeliveries({
				states: [
					"pending",
					"turn_granted",
					"awaiting_receipt",
					"wake_delivered",
					"held",
				],
				now: this.now().toISOString(),
			});
		} catch (error) {
			result.held += 1;
			this.log(
				`workflow rework delivery scan held: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const heldRecoveryCandidates = new Set<string>();
		for (const delivery of deliveries) {
			const request = this.options.store.getWorkflowReworkRequest(
				delivery.request_id,
			);
			const run = request
				? this.options.store.getWorkflowRun(request.run_id)
				: undefined;
			if (
				delivery.state === "held" &&
				request &&
				run?.engine_owned === 1 &&
				run.status === "held" &&
				delivery.last_error === "persisted_target_missing"
			) {
				heldRecoveryCandidates.add(delivery.request_id);
				const route = this.options.store.getLatestWorkflowReworkRoute(
					delivery.request_id,
				);
				if (!route) {
					result.held += 1;
					continue;
				}
				const probeNow = this.now();
				const nextProbeAt = this.heldReworkRecoveryProbeAt.get(
					delivery.request_id,
				);
				if (nextProbeAt !== undefined && probeNow.getTime() < nextProbeAt) {
					continue;
				}
				// Pace every real probe, including thrown/unknown/alive outcomes. The
				// durable delivery backoff remains authoritative across restarts.
				this.heldReworkRecoveryProbeAt.set(
					delivery.request_id,
					probeNow.getTime() + 60_000,
				);
				let liveness: GeneralizedLaunchLiveness;
				try {
					liveness = await this.probeTerminalLaunchLiveness(
						route.preferred_actor_execution_id,
						run.project_name,
					);
				} catch (error) {
					result.held += 1;
					this.log(
						`workflow rework pane-loss probe held for ${delivery.request_id}: ${error instanceof Error ? error.message : String(error)}`,
					);
					continue;
				}
				if (liveness !== "dead") {
					result.held += 1;
					continue;
				}
				let materialized: { ok: boolean; reason?: string };
				const attemptedAt = this.now().toISOString();
				try {
					materialized =
						this.options.store.materializeWorkflowReworkReplacement({
							requestId: delivery.request_id,
							deadExecutionId: route.preferred_actor_execution_id,
							newExecutionId: randomUUID(),
							reason: "persisted_target_missing_and_dead_probe",
							observedAt: attemptedAt,
							recoverHeldPaneLoss: true,
						});
				} catch (error) {
					result.held += 1;
					const reason = (
						error instanceof Error ? error.message : String(error)
					).slice(0, 240);
					this.log(
						`workflow held rework recovery failed for ${delivery.request_id}: ${reason}`,
					);
					this.settleHeldReworkRecoveryFailure({
						requestId: delivery.request_id,
						run,
						reason,
						now: attemptedAt,
					});
					continue;
				}
				if (!materialized.ok) {
					result.held += 1;
					const reason = (materialized.reason ?? "unknown_failure").slice(
						0,
						240,
					);
					this.log(
						`workflow held rework recovery failed for ${delivery.request_id}: ${reason}`,
					);
					this.settleHeldReworkRecoveryFailure({
						requestId: delivery.request_id,
						run,
						reason,
						now: attemptedAt,
					});
				} else {
					this.heldReworkRecoveryProbeAt.delete(delivery.request_id);
				}
				continue;
			}
			if (
				!request ||
				!run ||
				run.engine_owned !== 1 ||
				run.status !== "active"
			) {
				continue;
			}
			if (this.workflowReworkReentryEnabled()) {
				const resumed = this.options.store.transitionWorkflowReworkPause({
					requestId: delivery.request_id,
					generation: delivery.generation,
					state: "resumed",
					alertIdentity: this.resolveRunAlertIdentity(
						run.project_name,
						run.issue_id,
						run.run_id,
					),
					now: this.now().toISOString(),
				});
				if (!resumed.ok) {
					this.log(
						`workflow re-entry resume alert held for ${delivery.request_id}: ${resumed.reason}`,
					);
				}
			}
			let outcome: WorkflowReworkCoordinatorOutcome;
			try {
				outcome = await reconcile(delivery.request_id);
			} catch (error) {
				result.held += 1;
				this.log(
					`workflow rework reconcile held for ${delivery.request_id}: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			if (outcome.kind === "replacement_pending") {
				const materialized =
					this.options.store.materializeWorkflowReworkReplacement({
						requestId: delivery.request_id,
						deadExecutionId: outcome.executionId,
						newExecutionId: randomUUID(),
						reason: outcome.reason,
						observedAt: this.now().toISOString(),
					});
				if (!materialized.ok) {
					result.held += 1;
					this.log(
						`workflow rework replacement held for ${delivery.request_id}: ${materialized.reason}`,
					);
				}
				continue;
			}
			if (outcome.kind === "disabled") {
				const now = this.now().toISOString();
				const alerted = this.options.store.transitionWorkflowReworkPause({
					requestId: delivery.request_id,
					generation: delivery.generation,
					state: "paused",
					now,
					alertIdentity: this.resolveRunAlertIdentity(
						run.project_name,
						run.issue_id,
						run.run_id,
					),
				});
				if (!alerted.ok) {
					this.log(
						`workflow re-entry pause alert held for ${delivery.request_id}: ${alerted.reason}`,
					);
				}
				result.held += 1;
				continue;
			}
			if (outcome.kind === "retryable" || outcome.kind === "invalid") {
				result.held += 1;
			}
		}
		for (const requestId of this.heldReworkRecoveryProbeAt.keys()) {
			if (!heldRecoveryCandidates.has(requestId)) {
				this.heldReworkRecoveryProbeAt.delete(requestId);
			}
		}
	}

	private async reconcileWorkflowCarriers(
		result: WorkflowEngineReconcileResult,
	): Promise<void> {
		const reconcile = this.options.reconcileWorkflowCarrier;
		if (!reconcile) return;
		try {
			const drained = await drainWorkflowShipCarrierDeliveries({
				store: this.options.store,
				reconcile,
				now: this.now().toISOString(),
			});
			result.started += drained.delivered;
			result.held += drained.held;
		} catch (error) {
			result.held += 1;
			this.log(
				`workflow carrier delivery scan held: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private settleHeldReworkRecoveryFailure(input: {
		requestId: string;
		run: NonNullable<ReturnType<StateStore["getWorkflowRun"]>>;
		reason: string;
		now: string;
	}): void {
		try {
			this.options.store.settleHeldReworkRecoveryFailure({
				requestId: input.requestId,
				reason: input.reason,
				alertIdentity: this.resolveRunAlertIdentity(
					input.run.project_name,
					input.run.issue_id,
					input.run.run_id,
				),
				now: input.now,
			});
		} catch (error) {
			this.log(
				`workflow held rework failure ledger held for ${input.requestId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private deferWorkflowShipReadyFounder(
		notice: WorkflowShipReadyNotice,
		reason: string,
		retryAfterMs: number | undefined,
		nowMs: number,
		nowIso: string,
	): void {
		const gateOpenedMs = Date.parse(notice.gateOpenedAt);
		if (
			!Number.isFinite(gateOpenedMs) ||
			nowMs - gateOpenedMs > SHIP_READY_FOUNDER_BUDGET_MS
		) {
			this.recordWorkflowShipReadyDeliveryFailure(
				notice,
				`retry_budget_exhausted:${reason}`,
				nowIso,
			);
			return;
		}
		const uid = workflowShipReadyUid(notice);
		const attempts = (this.shipReadyFounderRetries.get(uid)?.attempts ?? 0) + 1;
		const exponential = Math.min(
			SHIP_READY_FOUNDER_RETRY_CAP_MS,
			SHIP_READY_FOUNDER_RETRY_BASE_MS * 2 ** (attempts - 1),
		);
		this.shipReadyFounderRetries.set(uid, {
			attempts,
			nextAttemptAtMs:
				nowMs + Math.max(exponential, retryAfterMs ?? exponential),
		});
	}

	private recordWorkflowShipReadyDeliveryFailure(
		notice: WorkflowShipReadyNotice,
		reason: string,
		now: string,
	): void {
		this.options.store.recordWorkflowShipReadyDeliveryFailure({
			runId: notice.runId,
			gateNodeId: notice.gateNodeId,
			attempt: notice.attempt,
			reason,
			gateOpenedAt: notice.gateOpenedAt,
			sourceExecutionId: notice.sourceExecutionId,
			alertIdentity: this.resolveRunAlertIdentity(
				notice.projectName,
				notice.issueId,
				notice.runId,
			),
			now,
		});
		this.shipReadyFounderRetries.delete(workflowShipReadyUid(notice));
	}

	private reconcileWorkflowReworkStalls(): void {
		const reentryPaused = !this.workflowReworkReentryEnabled();
		const now = this.now();
		const nowMs = now.getTime();
		const alertMs = this.reworkThresholdMs(
			"FLYWHEEL_ENGINE_REWORK_ALERT_MS",
			30 * 60_000,
		);
		const holdMs = this.reworkThresholdMs(
			"FLYWHEEL_ENGINE_REWORK_HOLD_MS",
			60 * 60_000,
		);
		let deliveries: ReturnType<
			typeof this.options.store.listWorkflowReworkDeliveries
		>;
		try {
			deliveries = this.options.store.listWorkflowReworkDeliveries({
				includeDeferred: true,
			});
		} catch (error) {
			this.log(
				`workflow rework stall scan held: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		for (const delivery of deliveries) {
			// Retryable failures have their own 1/2/4/8-minute budget and terminal
			// fifth strike. The legacy stall clock must not race that owner.
			if (delivery.hold_count > 0) continue;
			const request = this.options.store.getWorkflowReworkRequest(
				delivery.request_id,
			);
			const run = request
				? this.options.store.getWorkflowRun(request.run_id)
				: undefined;
			if (
				!request ||
				!run ||
				run.engine_owned !== 1 ||
				run.status !== "active"
			) {
				continue;
			}
			let pauseClockStartedAt: string | null = null;
			if (delivery.state === "pending" || delivery.state === "turn_granted") {
				// Operator-paused original-actor retries own a distinct durable FSM.
				// Replacement activation stalls remain safety-governed below even
				// while the original-actor re-entry kill switch is off.
				if (reentryPaused) continue;
				const resumed = this.options.store.transitionWorkflowReworkPause({
					requestId: delivery.request_id,
					generation: delivery.generation,
					state: "resumed",
					alertIdentity: this.resolveRunAlertIdentity(
						run.project_name,
						run.issue_id,
						run.run_id,
					),
					now: now.toISOString(),
				});
				if (!resumed.ok) {
					this.log(
						`workflow re-entry stall clock held for ${delivery.request_id}: ${resumed.reason}`,
					);
					continue;
				}
				pauseClockStartedAt = resumed.clockStartedAt;
			}
			if (delivery.state === "replacement_pending") {
				const route = this.options.store.getLatestWorkflowReworkRoute(
					delivery.request_id,
				);
				const node = route
					? this.options.store.getWorkflowRunNode(
							request.run_id,
							route.target_node_id,
							route.target_attempt,
						)
					: undefined;
				// Once the replacement is admitted, the fresh-spawn tripwire owns
				// cancellation fencing and rollback. Do not let the activation timer
				// race that stronger evidence path.
				if (node?.state === "admitted") continue;
			}
			const naturalSourceAt =
				delivery.state === "pending"
					? request.requested_at
					: delivery.updated_at;
			const pauseClockStartedMs = pauseClockStartedAt
				? parseSqliteUtcMs(pauseClockStartedAt)
				: null;
			const naturalSourceMs = parseSqliteUtcMs(naturalSourceAt);
			const sourceAt =
				pauseClockStartedAt &&
				pauseClockStartedMs != null &&
				naturalSourceMs != null &&
				pauseClockStartedMs > naturalSourceMs
					? pauseClockStartedAt
					: naturalSourceAt;
			const sourceMs = parseSqliteUtcMs(sourceAt);
			if (sourceMs == null || nowMs < sourceMs) continue;
			const ageMs = nowMs - sourceMs;
			const reason = delivery.last_error ?? `delivery_${delivery.state}`;
			const escalate = (action: "alert" | "hold") => {
				const escalated = this.options.store.escalateWorkflowReworkStall({
					requestId: delivery.request_id,
					generation: delivery.generation,
					action,
					sourceAt,
					reason,
					now: now.toISOString(),
					alertIdentity: this.resolveRunAlertIdentity(
						run.project_name,
						run.issue_id,
						run.run_id,
					),
				});
				if (!escalated.ok) {
					this.log(
						`workflow rework ${action} held for ${delivery.request_id}: ${escalated.reason}`,
					);
				}
			};
			if (ageMs >= alertMs) escalate("alert");
			if (ageMs >= holdMs) escalate("hold");
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
					watch.run_id,
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

	private escalateUnlaunchedStall(input: {
		intent: WorkflowSideEffectRow;
		action: "alert" | "hold";
		sourceAt: string;
		reason: string;
		projectName: string;
		issueId: string;
	}): void {
		const escalated = this.options.store.escalateUnlaunchedWorkflowStall({
			runId: input.intent.run_id,
			nodeId: input.intent.node_id,
			attempt: input.intent.attempt,
			executionId: input.intent.execution_id,
			launchOrdinal: input.intent.launch_ordinal,
			action: input.action,
			sourceAt: input.sourceAt,
			reason: input.reason,
			now: this.now().toISOString(),
			alertIdentity: this.resolveRunAlertIdentity(
				input.projectName,
				input.issueId,
				input.intent.run_id,
			),
		});
		if (!escalated.ok) {
			this.log(
				`workflow engine unlaunched ${input.action} held for ${input.intent.execution_id}: ${escalated.reason}`,
			);
		}
	}

	private async probeUnlaunchedEvidence(
		executionId: string,
		projectName: string,
	): Promise<"absent" | "present" | "unknown"> {
		try {
			return await this.probeUnlaunchedExternalEvidence(
				executionId,
				projectName,
			);
		} catch (error) {
			this.log(
				`workflow engine unlaunched evidence probe failed for ${executionId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return "unknown";
		}
	}

	private persistedUnlaunchedWindow(
		executionId: string,
	):
		| { status: "none" }
		| { status: "incomplete" }
		| { status: "exact"; identity: WorkflowLaunchWindowIdentity } {
		const rawParams =
			this.options.store.getSession(executionId)?.session_params;
		if (!rawParams) return { status: "none" };
		try {
			const params = JSON.parse(rawParams) as Record<string, unknown>;
			if (!("pane_loss_generation" in params)) return { status: "none" };
		} catch {
			return { status: "incomplete" };
		}
		const parsed = parsePaneLossGenerationParams(rawParams);
		if (
			!parsed?.window_id ||
			parsed.execution_id !== executionId ||
			parsed.launch_generation === undefined ||
			!parsed.launch_fingerprint ||
			!/^([a-f0-9]{64})$/i.test(parsed.launch_fingerprint)
		) {
			return { status: "incomplete" };
		}
		return {
			status: "exact",
			identity: {
				socketPath: parsed.socket_path,
				serverStartTime: parsed.server_start_time,
				windowId: parsed.window_id,
				executionId,
				launchGeneration: parsed.launch_generation,
				launchFingerprint: parsed.launch_fingerprint,
			},
		};
	}

	private async reconcileUnlaunchedWorkflowStalls(): Promise<void> {
		const store = this.options.store;
		const nowMs = this.now().getTime();
		const alertMs = this.unlaunchedThresholdMs(
			"FLYWHEEL_ENGINE_UNLAUNCHED_ALERT_MS",
			5 * 60_000,
		);
		const rollbackMs = this.unlaunchedThresholdMs(
			"FLYWHEEL_ENGINE_UNLAUNCHED_ROLLBACK_MS",
			10 * 60_000,
		);
		for (const intent of store.listNonTerminalWorkflowSideEffects()) {
			if (intent.kind !== "dispatch" || intent.state !== "intent_recorded") {
				continue;
			}
			const run = store.getWorkflowRun(intent.run_id);
			if (!run || run.engine_owned !== 1 || run.status !== "active") continue;
			const siblings = store
				.listWorkflowSideEffects(intent.run_id)
				.filter(
					(row) =>
						row.kind === "dispatch" &&
						row.node_id === intent.node_id &&
						row.attempt === intent.attempt,
				);
			const latestOrdinal = siblings.reduce(
				(max, row) => Math.max(max, row.launch_ordinal),
				0,
			);
			const node = store.getWorkflowRunNode(
				intent.run_id,
				intent.node_id,
				intent.attempt,
			);
			if (
				latestOrdinal !== intent.launch_ordinal ||
				node?.execution_id !== intent.execution_id
			) {
				continue;
			}
			const events = store.listWorkflowRunEvents(intent.run_id);
			if (node.state !== "admitted") continue;
			const binding = store.getWorkflowActivationForAttempt({
				executionId: intent.execution_id,
				runId: intent.run_id,
				nodeId: intent.node_id,
				attempt: intent.attempt,
			});
			if (!binding) continue;
			const admitted = events.find(
				(event) =>
					event.event_uid ===
					(binding.mode === "spawn" && intent.attempt === 1
						? `generalized_execution_admitted:${intent.execution_id}`
						: `workflow_activation_admitted:${binding.activation_id}`),
			);
			const admittedPayload = admitted?.payload as { at?: unknown } | undefined;
			const sourceAt =
				typeof admittedPayload?.at === "string"
					? admittedPayload.at
					: admitted?.at;
			const sourceMs = parseSqliteUtcMs(sourceAt);
			if (
				admitted?.kind !== "execution_admitted" ||
				admitted.execution_id !== intent.execution_id ||
				!sourceAt ||
				sourceMs == null ||
				nowMs < sourceMs
			) {
				continue;
			}
			const ageMs = nowMs - sourceMs;
			const reason = intent.reason ?? "launch_not_completed";
			if (ageMs >= alertMs) {
				this.escalateUnlaunchedStall({
					intent,
					action: "alert",
					sourceAt,
					reason,
					projectName: run.project_name,
					issueId: run.issue_id,
				});
			}
			if (ageMs < rollbackMs) continue;
			const markerPath = join(this.stateRoot, intent.execution_id);
			if (existsSync(markerPath)) {
				this.escalateUnlaunchedStall({
					intent,
					action: "hold",
					sourceAt,
					reason: "launch_marker_present",
					projectName: run.project_name,
					issueId: run.issue_id,
				});
				continue;
			}
			const preciseWindow = this.persistedUnlaunchedWindow(intent.execution_id);
			if (preciseWindow.status === "incomplete") {
				this.escalateUnlaunchedStall({
					intent,
					action: "hold",
					sourceAt,
					reason: "precise_window_identity_incomplete",
					projectName: run.project_name,
					issueId: run.issue_id,
				});
				continue;
			}
			const externalBeforeFence = await this.probeUnlaunchedEvidence(
				intent.execution_id,
				run.project_name,
			);
			if (preciseWindow.status === "none" && externalBeforeFence !== "absent") {
				this.escalateUnlaunchedStall({
					intent,
					action: "hold",
					sourceAt,
					reason: `external_launch_evidence_${externalBeforeFence}`,
					projectName: run.project_name,
					issueId: run.issue_id,
				});
				continue;
			}
			const cancellation = store.beginUnlaunchedWorkflowCancellation({
				runId: intent.run_id,
				nodeId: intent.node_id,
				attempt: intent.attempt,
				executionId: intent.execution_id,
				launchOrdinal: intent.launch_ordinal,
				cancellationOwner: `unlaunched-tripwire:${this.ownerId}`,
				reason: "unlaunched_admission_hard_ttl",
				now: this.now().toISOString(),
			});
			if (!cancellation.ok) {
				if (cancellation.reason !== "launch_owner_live") {
					this.escalateUnlaunchedStall({
						intent,
						action: "hold",
						sourceAt,
						reason: cancellation.reason,
						projectName: run.project_name,
						issueId: run.issue_id,
					});
				}
				continue;
			}
			let preciseWindowEvidence:
				| (WorkflowLaunchWindowIdentity & {
						physicalEvidence: "absent" | "cleaned";
				  })
				| undefined;
			if (preciseWindow.status === "exact") {
				const cleanup = await this.cleanupUnlaunchedWorkflowWindow(
					preciseWindow.identity,
				);
				if (cleanup !== "absent" && cleanup !== "cleaned") {
					this.escalateUnlaunchedStall({
						intent,
						action: "hold",
						sourceAt,
						reason: `precise_window_cleanup_${cleanup}`,
						projectName: run.project_name,
						issueId: run.issue_id,
					});
					continue;
				}
				preciseWindowEvidence = {
					...preciseWindow.identity,
					physicalEvidence: cleanup,
				};
			}
			const externalAfterFence = existsSync(markerPath)
				? "present"
				: preciseWindowEvidence
					? "absent"
					: await this.probeUnlaunchedEvidence(
							intent.execution_id,
							run.project_name,
						);
			if (externalAfterFence !== "absent") {
				this.escalateUnlaunchedStall({
					intent,
					action: "hold",
					sourceAt,
					reason: `post_fence_launch_evidence_${externalAfterFence}`,
					projectName: run.project_name,
					issueId: run.issue_id,
				});
				continue;
			}
			const rolledBack = store.rollbackUnlaunchedWorkflowAdmission({
				runId: intent.run_id,
				nodeId: intent.node_id,
				attempt: intent.attempt,
				executionId: intent.execution_id,
				launchOrdinal: intent.launch_ordinal,
				fenceGeneration: cancellation.generation,
				markerPath,
				now: this.now().toISOString(),
				...(preciseWindowEvidence && { preciseWindowEvidence }),
				alertIdentity: this.resolveRunAlertIdentity(
					run.project_name,
					run.issue_id,
					run.run_id,
				),
			});
			if (!rolledBack.ok) {
				this.escalateUnlaunchedStall({
					intent,
					action: "hold",
					sourceAt,
					reason: rolledBack.reason,
					projectName: run.project_name,
					issueId: run.issue_id,
				});
			}
		}
	}

	async reconcileWorkflowEngineAlerts(max = 20): Promise<number> {
		const sink = this.alertSink?.current;
		if (!sink) return 0;
		let finalized = await this.reconcileLegacyLandAlerts(sink, max);
		for (let index = finalized; index < max; index += 1) {
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

	private async reconcileLegacyLandAlerts(
		sink: { alert: (payload: AlertPayload) => Promise<AlertResult> },
		max: number,
	): Promise<number> {
		let finalized = 0;
		for (let index = 0; index < max; index += 1) {
			const now = this.now();
			const claim = this.options.store.claimNextLandAlert({
				ownerId: this.ownerId,
				now: now.toISOString(),
				leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
			});
			if (!claim) break;
			const identity = this.resolveRunAlertIdentity(
				claim.payload.projectName,
				claim.payload.issueId,
				`land:${claim.operationId}`,
			);
			try {
				const delivery = await sink.alert({
					leadId: identity.leadId,
					projectName: identity.projectName,
					eventId: `land-held:${claim.operationId}:${claim.resumeGeneration}:${claim.attempt}`,
					eventType: "workflow_engine_escalation",
					severity: "severe",
					sessionKey: `land:${claim.operationId}`,
					title: `Land operation held for ${claim.payload.issueId}`,
					body: `PR #${claim.payload.prNumber} land operation ${claim.operationId} is held. Reason: ${claim.payload.reason}. Inspect the PR, then recover with POST /api/lifecycle/land/${claim.operationId}/resume using audited actor and reason fields.`,
					metadata: {
						workflowEngine: {
							runId: `land:${claim.operationId}`,
							issueId: claim.payload.issueId,
							nodeId: "land",
							executionId: `land:${claim.operationId}`,
							disposition: "held",
							leadResolution: identity.leadResolution,
						},
					},
				});
				const accepted = delivery.sent === true || delivery.queued === true;
				this.options.store.finishLandAlertDelivery({
					operationId: claim.operationId,
					resumeGeneration: claim.resumeGeneration,
					ownerId: claim.ownerId,
					generation: claim.generation,
					outcome: accepted ? "sent" : "failed",
					...(accepted
						? {}
						: { error: delivery.skipped ?? "alert_not_delivered" }),
					now: this.now().toISOString(),
				});
			} catch (error) {
				this.options.store.finishLandAlertDelivery({
					operationId: claim.operationId,
					resumeGeneration: claim.resumeGeneration,
					ownerId: claim.ownerId,
					generation: claim.generation,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
					now: this.now().toISOString(),
				});
			}
			finalized += 1;
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

	private deferDeadExecutionForReadyResume(input: {
		runId: string;
		issueId: string;
		projectName: string;
		nodeId: string;
		attempt: number;
		executionId: string;
	}): boolean {
		const delivery = this.options.store
			.listWorkflowRunEvents(input.runId)
			.filter(
				(event) =>
					event.kind === "issue_delivery" &&
					event.node_id === input.nodeId &&
					event.execution_id === input.executionId,
			)
			.at(-1);
		const payload =
			delivery?.payload && typeof delivery.payload === "object"
				? (delivery.payload as Record<string, unknown>)
				: undefined;
		if (typeof payload?.bodyDigest !== "string") return false;
		const resolution = resolveWorkflowResumeTarget(this.options.store, {
			runId: input.runId,
			envelopeObservation: {
				source: "issue_delivery",
				digest: payload.bodyDigest,
			},
			env: this.env,
			verifyAnchor: () => true,
		});
		if (
			!resolution.ok ||
			resolution.targetNodeId !== input.nodeId ||
			resolution.targetAttempt !== input.attempt
		) {
			return false;
		}
		const opened = this.options.store.openWorkflowResumeFirstWindow({
			runId: input.runId,
			nodeId: input.nodeId,
			attempt: input.attempt,
			executionId: input.executionId,
			attachmentId: resolution.attachmentId,
			alertIdentity: this.resolveRunAlertIdentity(
				input.projectName,
				input.issueId,
				input.runId,
			),
			now: this.now().toISOString(),
		});
		if (!opened.ok) {
			this.log(
				`workflow resume-first window held for ${input.executionId}: ${opened.reason}`,
			);
			return false;
		}
		return opened.defer;
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
					if (
						store.shouldSuppressDeadExecutionRecovery({
							executionId: node.execution_id,
							now: this.now().toISOString(),
						})
					) {
						continue;
					}
					if (session?.status === "completed") {
						let liveness: GeneralizedLaunchLiveness;
						try {
							liveness = await this.probeTerminalLaunchLiveness(
								node.execution_id,
								run.project_name,
							);
						} catch {
							liveness = "unknown";
						}
						if (
							liveness === "dead" &&
							this.deferDeadExecutionForReadyResume({
								runId: run.run_id,
								issueId: run.issue_id,
								projectName: run.project_name,
								nodeId: workflowNode.id,
								attempt: node.attempt,
								executionId: node.execution_id,
							})
						) {
							continue;
						}
						const held = store.holdCompletedWorkflowExecutionWithoutReceipt({
							runId: run.run_id,
							nodeId: workflowNode.id,
							attempt: node.attempt,
							executionId: node.execution_id,
							alertIdentity: this.resolveRunAlertIdentity(
								run.project_name,
								run.issue_id,
								run.run_id,
							),
							now: this.now().toISOString(),
						});
						if (!held.ok) {
							this.log(
								`workflow engine completion-receipt hold refused for ${node.execution_id}: ${held.reason}`,
							);
						}
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
					if (launches.length <= MAX_BLIND_REPLACEMENTS) {
						const delay =
							WORKFLOW_REPLACEMENT_RETRY_DELAYS_MS[
								Math.max(0, launches.length - 1)
							]!;
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
						liveness = await this.probeTerminalLaunchLiveness(
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
									run.run_id,
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
					if (
						this.deferDeadExecutionForReadyResume({
							runId: run.run_id,
							issueId: run.issue_id,
							projectName: run.project_name,
							nodeId: workflowNode.id,
							attempt: node.attempt,
							executionId: node.execution_id,
						})
					) {
						continue;
					}
					const observedAt = this.now().toISOString();
					let activityBaseline:
						| WorkflowDeadExecutionActivityBaseline
						| undefined;
					try {
						activityBaseline = await this.captureDeadExecutionActivityBaseline(
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
					const recovered = store.rollbackDeadWorkflowNodeExecution({
						runId: run.run_id,
						nodeId: workflowNode.id,
						attempt: node.attempt,
						deadExecutionId: node.execution_id,
						newExecutionId: randomUUID(),
						reason: "terminal_session_and_dead_probe",
						activityBaseline,
						alertIdentity: this.resolveRunAlertIdentity(
							run.project_name,
							run.issue_id,
							run.run_id,
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
		this.options.store.applyWorkflowLedgerBatch({
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
			const reworkLaunch =
				this.options.store.markWorkflowReworkReplacementLaunched({
					executionId: intent.execution_id,
					now: this.now().toISOString(),
					alertIdentity: this.resolveRunAlertIdentity(
						run.project_name,
						run.issue_id,
						run.run_id,
					),
				});
			if (!reworkLaunch.ok) {
				throw new Error(
					`engine_rework_replacement_launch_${reworkLaunch.reason}`,
				);
			}
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
		const node = snapshot.resolved.nodes.find(
			(candidate) => candidate.id === intent.node_id,
		);
		if (node?.type === "land") {
			const holdLandRun = (reason: string, operationId?: string): boolean => {
				const held = store.holdWorkflowLandNode({
					runId: run.run_id,
					nodeId: node.id,
					attempt: intent.attempt,
					executionId: intent.execution_id,
					...(operationId ? { operationId } : {}),
					reason,
					now: this.now().toISOString(),
					alertIdentity: this.resolveRunAlertIdentity(
						run.project_name,
						run.issue_id,
						run.run_id,
					),
				});
				if (!held.ok) {
					throw new Error(`engine_land_hold_${held.reason}`);
				}
				return false;
			};
			if (!this.options.landExecutor) {
				return holdLandRun("engine_land_executor_unavailable");
			}
			const holder = store.getCurrentWorkflowGateHolder(
				intent.run_id,
				workflowApprovalGate(snapshot.manifest).node,
			);
			const exactHeadAuthority = holder
				? store.resolveWorkflowExactHeadAuthority({
						runId: intent.run_id,
						headSha: holder.head_sha,
					})
				: undefined;
			const prBinding = exactHeadAuthority?.valid
				? exactHeadAuthority.binding
				: undefined;
			const prNumber = prBinding?.pr_number;
			if (
				!holder ||
				holder.state !== "approved" ||
				!prNumber ||
				!/^[0-9a-f]{40}$/i.test(holder.head_sha)
			) {
				throw new Error("engine_land_authority_unavailable");
			}
			if (prBinding.target_repo_identity !== "__main__") {
				return holdLandRun("nested_land_unsupported");
			}
			const currentOperation = store.getLandOperationForRun(run.run_id);
			const existingOperation = store.getLandOperationForRun(
				run.run_id,
				holder.head_sha,
			);
			if (currentOperation && !existingOperation) {
				return holdLandRun(
					"engine_land_operation_authority_mismatch",
					currentOperation.operation_id,
				);
			}
			if (
				existingOperation &&
				(existingOperation.issue_id !== run.issue_id ||
					existingOperation.project_name !== run.project_name ||
					existingOperation.pr_number !== prNumber ||
					existingOperation.approved_head !== holder.head_sha.toLowerCase())
			) {
				return holdLandRun(
					"engine_land_operation_authority_mismatch",
					existingOperation.operation_id,
				);
			}
			const operation =
				existingOperation ??
				store.ensureLandOperation({
					runId: run.run_id,
					issueId: run.issue_id,
					projectName: run.project_name,
					prNumber,
					approvedHead: holder.head_sha,
					now: this.now().toISOString(),
				});
			const execution = await this.options.landExecutor(operation.operation_id);
			if (execution.status === "superseded" || execution.status === "rework") {
				// The holder + operation generation swap committed atomically. Leave
				// the run active; the next reconciliation pass selects either the new
				// head or the durable rework delivery.
				return false;
			}
			if (execution.status === "held") {
				return holdLandRun(
					execution.reason ?? "land_operation_held",
					operation.operation_id,
				);
			}
			if (
				execution.status === "partial" &&
				/^(?:ship_workflow_pending|pr_head_mismatch|head_alignment_pending|base_refresh_pending|merge_conflict|merge_conflict_rework_pending:|external_outage|policy_alignment_pending|mergeability_pending|ambiguous_cool_reconcile_pending|land_queue_busy|issue_closeout_incomplete|land_linear_done_disposition_incomplete|land_postconditions_incomplete:)/.test(
					execution.reason ?? "",
				)
			) {
				const partial = store.recordWorkflowLandPartial({
					runId: run.run_id,
					nodeId: node.id,
					attempt: intent.attempt,
					executionId: intent.execution_id,
					operationId: operation.operation_id,
					reason: execution.reason!,
					now: this.now().toISOString(),
					alertIdentity: this.resolveRunAlertIdentity(
						run.project_name,
						run.issue_id,
						run.run_id,
					),
				});
				if (!partial.ok) {
					throw new Error(`engine_land_partial_${partial.reason}`);
				}
			}
			if (execution.status !== "completed") return false;
			const completed = store.completeWorkflowLandNode({
				runId: run.run_id,
				nodeId: node.id,
				attempt: intent.attempt,
				executionId: intent.execution_id,
				operationId: operation.operation_id,
				now: this.now().toISOString(),
			});
			if (!completed.ok) {
				throw new Error(`engine_land_completion_${completed.reason}`);
			}
			return this.markStarted(intent, { preserveTerminalNode: true });
		}
		if (
			store.getWorkflowRunNode(intent.run_id, intent.node_id, intent.attempt)
				?.state === "done"
		) {
			return this.markStarted(intent, { preserveTerminalNode: true });
		}
		const adopted = this.adoptKnownSession(intent);
		if (adopted !== undefined) return adopted;
		const agentContent = node ? workflowNodeAgentContent(node) : undefined;
		if (!node?.dispatch || !agentContent || node.type === "gate") {
			throw new Error("engine_node_not_executable");
		}
		const workflowResumeAdmission =
			store.getWorkflowResumeAdmissionForExecution(intent.execution_id);
		let workflowResume: WorkflowResumeContext | undefined;
		if (workflowResumeAdmission) {
			const source = store.getWorkflowResumeAttachment(
				workflowResumeAdmission.source_attachment_id,
			);
			const sourceState = source
				? store.getWorkflowResumeAttachmentState(source.attachment_id)
				: undefined;
			const anchorCommit =
				source?.anchor_commit ?? sourceState?.resolved_anchor_commit;
			if (
				workflowResumeAdmission.action_kind !== "redispatch_execution" ||
				workflowResumeAdmission.run_id !== intent.run_id ||
				workflowResumeAdmission.target_node_id !== intent.node_id ||
				workflowResumeAdmission.new_attempt !== intent.attempt ||
				workflowResumeAdmission.frozen_s3_body === null ||
				!source?.anchor_ref ||
				source.carrier_kind !== "git_checkpoint" ||
				sourceState?.state !== "ready" ||
				!anchorCommit ||
				!/^[0-9a-f]{40}$/i.test(anchorCommit)
			) {
				throw new Error("engine_resume_admission_invalid");
			}
			workflowResume = {
				runId: intent.run_id,
				admissionKey: workflowResumeAdmission.admission_key,
				sourceAttachmentId: workflowResumeAdmission.source_attachment_id,
				anchorRef: source.anchor_ref,
				anchorCommit: anchorCommit.toLowerCase(),
				frozenBody: workflowResumeAdmission.frozen_s3_body,
			};
		}
		const reworkReplacementRequestId = intent.reason?.startsWith(
			"rework_replacement:",
		)
			? intent.reason.slice("rework_replacement:".length)
			: undefined;
		const replacementContext = reworkReplacementRequestId
			? (() => {
					const request = store.getWorkflowReworkRequest(
						reworkReplacementRequestId,
					);
					const route = store.getLatestWorkflowReworkRoute(
						reworkReplacementRequestId,
					);
					const delivery = store.getWorkflowReworkDelivery(
						reworkReplacementRequestId,
					);
					const baseRevision = request?.base_revision?.trim().toLowerCase();
					if (
						!request ||
						!route ||
						!delivery ||
						request.run_id !== intent.run_id ||
						route.target_node_id !== intent.node_id ||
						route.target_attempt !== intent.attempt ||
						route.preferred_actor_execution_id !== intent.execution_id ||
						delivery.route_revision !== route.revision ||
						delivery.state !== "replacement_pending" ||
						!baseRevision ||
						!/^[0-9a-f]{40}$/.test(baseRevision)
					) {
						throw new Error("engine_rework_replacement_context_invalid");
					}
					return {
						requestId: reworkReplacementRequestId,
						startPoint: baseRevision,
						founderFeedback:
							typeof request.founder_feedback_verbatim === "string" &&
							request.founder_feedback_verbatim.length > 0
								? request.founder_feedback_verbatim
								: undefined,
					};
				})()
			: undefined;
		let transitionPayload:
			| {
					successorExecutionId?: unknown;
					targetAttempt?: unknown;
					loopIteration?: unknown;
					outcome?: unknown;
					founderFeedback?: unknown;
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
		const isRootPhaseFirstAttempt =
			isWorkflowPhaseRole(node.type) &&
			intent.attempt === 1 &&
			!snapshot.manifest.edges.some((edge) => edge.to === node.id);
		const startRetryExecutionId =
			!transition &&
			startReservation?.node_id === intent.node_id &&
			startReservation.attempt === intent.attempt &&
			startReservation.execution_id === transitionExecutionId &&
			transitionExecutionId !== intent.execution_id
				? transitionExecutionId
				: undefined;
		const resumeSourceExecutionId = workflowResumeAdmission
			? store.getWorkflowRunNode(
					intent.run_id,
					intent.node_id,
					workflowResumeAdmission.target_attempt,
				)?.execution_id
			: undefined;
		const predecessorExecutionId =
			resumeSourceExecutionId ??
			transition?.execution_id ??
			startRetryExecutionId;
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
		const founderFeedback =
			(
				replacementContext?.founderFeedback ??
				(transitionPayload?.outcome === "founder_feedback_kickback" &&
				typeof transitionPayload.founderFeedback === "string"
					? transitionPayload.founderFeedback
					: undefined)
			)
				?.trim()
				.slice(0, 4_000) || undefined;
		const contextualAgentContent = founderFeedback
			? `${agentContent}\n\nFounder feedback for this revision:\n${founderFeedback}`
			: agentContent;
		let startPoint: string | undefined;
		if (workflowResume) {
			startPoint = workflowResume.anchorCommit;
		} else if (isWorkflowPhaseRole(node.type)) {
			if (replacementContext) {
				startPoint = replacementContext.startPoint;
			} else if (
				!isRootPhaseFirstAttempt &&
				(!predecessorExecutionId || !predecessor)
			) {
				throw new Error("engine_predecessor_unavailable");
			} else if (predecessorExecutionId) {
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
		const credentialExpiry = credentialWindowForNode(snapshot, node.id, now);
		const dispatchResolution = resolveNodeDispatchAtLaunch(store, {
			runId: intent.run_id,
			nodeId: intent.node_id,
		});
		const admission = this.options.admissionProbe?.();
		if (admission && !admission.admit) {
			throw new Error(`engine_admission_${admission.reason}`);
		}
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: intent.run_id,
			nodeId: intent.node_id,
			executionId: intent.execution_id,
			attempt: intent.attempt,
			now: now.toISOString(),
			expiresAt: credentialExpiry.expiresAt,
			absoluteDeadlineAt: credentialExpiry.absoluteDeadlineAt,
			...(reworkReplacementRequestId
				? {
						activationMode: "replacement" as const,
						reworkRequestId: reworkReplacementRequestId,
					}
				: {}),
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
						effort: runtime.effort as
							| "low"
							| "medium"
							| "high"
							| "xhigh"
							| "max",
					}
				: {}),
		};

		const ownerId = this.ownerId;
		const markerPath = join(this.stateRoot, intent.execution_id);
		const launch = store.recoverOrAcquireWorkflowLaunch({
			executionId: intent.execution_id,
			ownerId,
			now: now.toISOString(),
			leaseExpiresAt: new Date(
				now.getTime() + WORKFLOW_LAUNCH_SOFT_LEASE_MS,
			).toISOString(),
			markerPath,
		});
		if (
			launch.status === "busy" ||
			launch.status === "hold" ||
			launch.status === "cancelled"
		)
			return false;
		let launchGateToken: string;
		let launchGeneration: number;
		let commitWorkflowLaunch: () => { ok: boolean; reason?: string };
		let launchReleaseFence:
			| { ownerId: string; generation: number; markerPath: string }
			| undefined;
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
			launchGeneration = repair.generation;
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
			launchGeneration = launch.generation;
			launchReleaseFence = {
				ownerId,
				generation: launch.generation,
				markerPath,
			};
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
		const decisionContract = resolveWorkflowDecisionContract(snapshot, node.id);
		if (admitted.idempotentReplay && launch.status === "acquired") {
			const { expiresAt, absoluteDeadlineAt } = credentialWindowForNode(
				snapshot,
				node.id,
				now,
			);
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
			if (decisionContract) {
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
			const { expiresAt, absoluteDeadlineAt } = credentialWindowForNode(
				snapshot,
				node.id,
				now,
			);
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
			if (decisionContract) {
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
		const prepareWorkflowIssueDelivery = (
			input: WorkflowIssueDeliveryInput,
		) => {
			const { anchorCommit, ...candidate } = input;
			const prepared = store.prepareWorkflowIssueDelivery({
				executionId: intent.execution_id,
				activationId: admitted.activationId,
				ownerId,
				ownerGeneration: launchGeneration,
				deliveryAttempt: deliveryRepair?.attempt ?? launch.deliveryAttempt,
				anchorCommit,
				candidate,
				now: this.now().toISOString(),
			});
			if (!prepared.ok) throw new Error(prepared.reason);
		};
		const role = isWorkflowPhaseRole(node.type) ? node.type : "main";
		let startResult: StartResult;
		try {
			startResult = await this.options.startDispatcher.start({
				issueId: run.issue_id,
				issueIdentifier: run.issue_id,
				projectName: run.project_name,
				successorExecutionId: intent.execution_id,
				...(leadId && { leadId }),
				sessionRole: role,
				shareParentBranch: isWorkflowPhaseRole(node.type) ? true : undefined,
				...(startPoint && { startPoint }),
				...(workflowResume && { workflowResume }),
				ignoreRunnerLabelSelection: true,
				...(predecessor?.issue_identifier && {
					issueIdentifier: predecessor.issue_identifier,
				}),
				...(predecessor?.issue_title && {
					issueTitle: predecessor.issue_title,
				}),
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
				generalizedExecution: {
					engineOwned: true,
					executionId: intent.execution_id,
					activationId: admitted.activationId,
					runId: intent.run_id,
					nodeId: intent.node_id,
					attempt: intent.attempt,
					snapshotDigest: snapshot.snapshot_digest,
					gateCarrierEpoch: run.gate_carrier_epoch,
					dispatch: runtimeDispatch,
					capabilities: {
						...node.capabilities,
						founder_review_required: nodeRequiresFounderReview(
							snapshot,
							node.id,
						),
						...workflowGateEntryPromptCapabilities(snapshot, node.id),
					},
					agentContent: contextualAgentContent,
					outputCredential,
					submissionCredential,
					idempotencyKey: `engine:${intent.run_id}:${intent.node_id}:${intent.attempt}`,
					launchGateToken,
					launchGeneration,
					commitWorkflowLaunch,
					prepareWorkflowIssueDelivery,
					projectTurn: (turn) => store.recordWorkflowActivationTurn(turn),
				},
			});
		} catch (error) {
			if (launchReleaseFence) {
				store.releaseFailedWorkflowLaunch({
					executionId: intent.execution_id,
					ownerId: launchReleaseFence.ownerId,
					generation: launchReleaseFence.generation,
					markerPath: launchReleaseFence.markerPath,
					now: this.now().toISOString(),
					reason: `dispatcher_start_failed:${error instanceof Error ? error.message : String(error)}`,
					physicalEvidence: "absent",
				});
			}
			return false;
		}
		if (startResult.launchOutcome && launchReleaseFence) {
			const outcome = await waitForWorkflowLaunchOutcome({
				outcome: startResult.launchOutcome,
				heartbeat: () => {
					const heartbeatNow = this.now();
					store.renewWorkflowLaunchOwner({
						executionId: intent.execution_id,
						ownerId: launchReleaseFence!.ownerId,
						generation: launchReleaseFence!.generation,
						now: heartbeatNow.toISOString(),
						leaseExpiresAt: new Date(
							heartbeatNow.getTime() + WORKFLOW_LAUNCH_SOFT_LEASE_MS,
						).toISOString(),
					});
				},
			});
			if (!outcome || outcome.status === "precommit_failed") {
				if (
					outcome?.status === "precommit_failed" &&
					outcome.failure.physicalEvidence !== "unknown"
				) {
					store.releaseFailedWorkflowLaunch({
						executionId: intent.execution_id,
						ownerId: launchReleaseFence.ownerId,
						generation: launchReleaseFence.generation,
						markerPath: launchReleaseFence.markerPath,
						now: this.now().toISOString(),
						reason: outcome.failure.reason,
						physicalEvidence: outcome.failure.physicalEvidence,
					});
				}
				return false;
			}
		}
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
