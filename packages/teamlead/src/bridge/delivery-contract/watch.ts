import type { CommDB } from "flywheel-comm/db";
import {
	CMUX_LIVE_SESSION_STATUSES,
	isWakeTerminalStatus,
} from "../../operational-terminal-status.js";
import type {
	StateStore,
	WorkflowDeliveryContractUnboundAlertPayload,
	WorkflowDeliveryContractUnboundAlertReceipt,
	WorkflowEngineAlertIdentity,
} from "../../StateStore.js";
import { classifyDeliveryAttempt } from "./classify.js";
import { LegacyDeliveryReachabilityGuard } from "./legacy-reachability.js";
import {
	classifyRecipientLiveness,
	collectRecipientLivenessEvidence,
} from "./liveness.js";
import {
	DELIVERY_MAINTENANCE_PAGE_SIZE,
	MAILBOX_SLOT_FREEZE_AFTER_MS,
	TURN_WAKE_FREEZE_AFTER_MS,
} from "./policy.js";
import { observeRunnerMailboxDelivery } from "./sources/mailbox.js";
import { observeRunnerTurnWakeDelivery } from "./sources/turn-wake.js";
import type { DeliveryTerminal } from "./types.js";

const TERMINAL_STATES = new Set<DeliveryTerminal>([
	"frozen",
	"superseded",
	"cancelled",
	"undeliverable",
]);

export interface DeliveryWatchCursor {
	afterRootId: string;
}

export interface DeliveryWatchPassResult {
	observed: number;
	opened: number;
	closed: number;
	alerted: number;
	nextCursor?: DeliveryWatchCursor;
}

export class DeliveryContractWatch {
	constructor(
		private readonly deps: {
			store: StateStore;
			commDb?: CommDB;
			projectName?: string;
			resolveAlertIdentity(input: {
				projectName: string;
				issueId: string;
				runId: string | null;
			}): WorkflowEngineAlertIdentity;
			enqueueUnboundAlert?(
				payload: WorkflowDeliveryContractUnboundAlertPayload,
			): WorkflowDeliveryContractUnboundAlertReceipt;
		},
	) {}

	runPass(_now: string, cursor?: DeliveryWatchCursor): DeliveryWatchPassResult {
		const result: DeliveryWatchPassResult = {
			observed: 0,
			opened: 0,
			closed: 0,
			alerted: 0,
		};
		const legacyReachability = new LegacyDeliveryReachabilityGuard(
			this.deps.store,
		);
		const candidates = this.deps.store.listLiveWorkflowDeliveryAttempts({
			...(this.deps.projectName ? { projectName: this.deps.projectName } : {}),
			...(cursor ? { afterRootId: cursor.afterRootId } : {}),
			limit: DELIVERY_MAINTENANCE_PAGE_SIZE + 1,
		});
		const attempts = candidates.slice(0, DELIVERY_MAINTENANCE_PAGE_SIZE);
		for (const attempt of attempts) {
			try {
				const ref = JSON.parse(attempt.contract_ref_json) as {
					runId?: string;
					projectName?: string;
					issueId?: string;
					table?: string;
					pk?: string;
					terminal?: string | null;
					routeRevision?: number;
					redriveGeneration?: number;
				};
				const projectName =
					ref.projectName ?? attempt.root_id.split(":")[0] ?? "unknown";
				if (this.deps.projectName && projectName !== this.deps.projectName)
					continue;
				result.observed++;
				const classification = classifyDeliveryAttempt(attempt, _now);
				const mailboxRow =
					ref.table === "mailbox" && typeof ref.pk === "string"
						? this.deps.commDb?.getRunnerDeliveryProjectionRow(
								ref.pk,
								_now,
								true,
							)
						: undefined;
				const turnWakeRow =
					ref.table === "turn_wake_outbox" && typeof ref.pk === "string"
						? this.deps.commDb?.getRunnerTurnWakeProjectionRow(
								ref.pk,
								Date.parse(_now),
								true,
							)
						: undefined;
				const phaseWakeRow =
					ref.table === "runner_phase_wakes" && typeof ref.pk === "string"
						? this.deps.commDb?.getRunnerPhaseWakeProjectionRow(
								ref.pk,
								Date.parse(_now),
								true,
							)
						: undefined;
				const reworkRoute =
					attempt.family === "rework" && typeof ref.pk === "string"
						? this.deps.store.getLatestWorkflowReworkRoute(ref.pk)
						: undefined;
				const reworkDelivery =
					attempt.family === "rework" && typeof ref.pk === "string"
						? this.deps.store.getWorkflowReworkDelivery(ref.pk)
						: undefined;
				const carrierDelivery =
					attempt.family === "carrier" && typeof ref.pk === "string"
						? this.deps.store.getWorkflowCarrierDelivery(ref.pk)
						: undefined;
				const mailboxObservation = mailboxRow
					? observeRunnerMailboxDelivery(mailboxRow)
					: undefined;
				const turnWakeObservation = turnWakeRow
					? observeRunnerTurnWakeDelivery(turnWakeRow)
					: undefined;
				const stateRecipientExecutionId =
					reworkRoute?.preferred_actor_execution_id ??
					carrierDelivery?.source_execution_id;
				const issueId =
					ref.issueId ?? attempt.root_id.split(":")[1] ?? "unknown";
				const recipientExecutionId =
					mailboxRow?.to_agent ??
					turnWakeRow?.execution_id ??
					phaseWakeRow?.execution_id ??
					stateRecipientExecutionId;
				const fallbackRecipientStatus =
					mailboxRow?.recipient_status ??
					turnWakeRow?.recipient_status ??
					phaseWakeRow?.recipient_status;
				const sourceIsActive =
					(mailboxRow &&
						mailboxRow.state !== "ACKED" &&
						mailboxRow.superseded_by === null) ||
					(phaseWakeRow && phaseWakeRow.state !== "finished") ||
					(turnWakeRow &&
						turnWakeRow.state !== "acked" &&
						turnWakeRow.state !== "cancelled") ||
					Boolean(stateRecipientExecutionId);
				if (
					sourceIsActive &&
					recipientExecutionId &&
					typeof ref.table === "string" &&
					typeof ref.pk === "string" &&
					legacyReachability.isLegacyUnreachable({
						recipientExecutionId,
						fallbackRecipientStatus,
						projectName,
						issueId,
						mintedAt: attempt.minted_at,
						now: _now,
						attemptId: attempt.attempt_id,
						runId: ref.runId,
					})
				) {
					const version =
						attempt.family === "rework" &&
						Number.isSafeInteger(ref.routeRevision)
							? { routeRevision: Number(ref.routeRevision) }
							: attempt.family === "carrier" &&
									Number.isSafeInteger(ref.redriveGeneration)
								? { redriveGeneration: Number(ref.redriveGeneration) }
								: undefined;
					const settled =
						this.deps.store.settleProjectedWorkflowDeliveryAttempt({
							family: attempt.family,
							table: ref.table,
							pk: ref.pk,
							reason: "legacy_unreachable",
							now: _now,
							...(version ? { version } : {}),
						});
					if (settled) {
						result.closed++;
						continue;
					}
				}
				const stateRecipientLive = stateRecipientExecutionId
					? CMUX_LIVE_SESSION_STATUSES.has(
							this.deps.store.getSession(stateRecipientExecutionId)?.status ??
								"",
						)
					: false;
				const stateNativeUndeliverable =
					((reworkDelivery?.state === "awaiting_receipt" ||
						reworkDelivery?.state === "replacement_pending") &&
						!stateRecipientLive) ||
					(carrierDelivery?.state === "awaiting_receipt" &&
						!stateRecipientLive);
				const phaseWakeUndeliverable = Boolean(
					phaseWakeRow &&
						phaseWakeRow.started_at === null &&
						isWakeTerminalStatus(phaseWakeRow.recipient_status),
				);
				const sourceObservation = mailboxObservation ?? turnWakeObservation;
				const terminal = sourceObservation?.terminal ?? ref.terminal;
				const effectiveTerminal =
					phaseWakeUndeliverable || stateNativeUndeliverable
						? "undeliverable"
						: terminal;
				if (TERMINAL_STATES.has(effectiveTerminal as DeliveryTerminal)) {
					classification.terminal = effectiveTerminal as DeliveryTerminal;
					classification.terminalShape = sourceObservation?.shapeId ?? null;
					classification.overdue = false;
					classification.severe = false;
				}
				const candidateRun = ref.runId
					? this.deps.store.getWorkflowRun(ref.runId)
					: this.deps.store.getActiveWorkflowRunForIssue(issueId);
				const activeRun =
					candidateRun?.status === "active" &&
					candidateRun.project_name === projectName &&
					candidateRun.issue_id === issueId
						? candidateRun
						: undefined;
				const runId =
					activeRun?.project_name === projectName ? activeRun.run_id : null;
				const recipientLiveness =
					attempt.family === "rework" &&
					stateRecipientExecutionId &&
					this.deps.commDb
						? classifyRecipientLiveness(
								collectRecipientLivenessEvidence({
									store: this.deps.store,
									commDb: this.deps.commDb,
									executionId: stateRecipientExecutionId,
									nowMs: Date.parse(_now),
								}),
								Date.parse(_now),
							)
						: undefined;
				if (sourceObservation?.shapeId && sourceObservation.shapeSince) {
					const recipientExecutionId =
						mailboxRow?.to_agent ?? turnWakeRow?.execution_id;
					if (
						activeRun &&
						this.deps.commDb &&
						recipientExecutionId &&
						typeof ref.pk === "string"
					) {
						const nowMs = Date.parse(_now);
						const evidence = collectRecipientLivenessEvidence({
							store: this.deps.store,
							commDb: this.deps.commDb,
							executionId: recipientExecutionId,
							nowMs,
						});
						const thresholdMs =
							sourceObservation.shapeId === "mailbox_inflight_slots_exhausted"
								? MAILBOX_SLOT_FREEZE_AFTER_MS
								: TURN_WAKE_FREEZE_AFTER_MS;
						this.deps.store.freezeWorkflowDelivery({
							runId: activeRun.run_id,
							shape: sourceObservation.shapeId,
							attemptId: attempt.attempt_id,
							rootId: attempt.root_id,
							physicalId: ref.pk,
							recipientExecutionId,
							shapeSince: sourceObservation.shapeSince,
							thresholdMs,
							commEvidence: evidence,
							now: _now,
							alertIdentity: this.deps.resolveAlertIdentity({
								projectName,
								issueId,
								runId: activeRun.run_id,
							}),
						});
					}
					continue;
				}
				const observed = this.deps.store.observeWorkflowDeliveryContract({
					attempt,
					classification,
					runId,
					projectName,
					issueId,
					now: _now,
					alertIdentity: this.deps.resolveAlertIdentity({
						projectName,
						issueId,
						runId,
					}),
					...(recipientLiveness ? { recipientLiveness } : {}),
					enqueueUnboundAlert: this.deps.enqueueUnboundAlert,
				});
				result.opened += observed.opened;
				result.closed += observed.closed;
				result.alerted += observed.alerted;
			} catch (error) {
				console.warn(
					`[delivery-contract] attempt ${attempt.attempt_id} failed closed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
		if (candidates.length > DELIVERY_MAINTENANCE_PAGE_SIZE) {
			result.nextCursor = {
				afterRootId: attempts[attempts.length - 1]!.root_id,
			};
		}
		return result;
	}
}
