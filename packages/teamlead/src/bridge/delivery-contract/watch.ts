import type {
	CommDB,
	RunnerDeliveryProjectionRow,
	RunnerTurnWakeProjectionRow,
} from "flywheel-comm/db";
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
import {
	classifyRecipientLiveness,
	collectRecipientLivenessEvidence,
} from "./liveness.js";
import {
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

	runPass(_now: string): {
		observed: number;
		opened: number;
		closed: number;
		alerted: number;
	} {
		const result = { observed: 0, opened: 0, closed: 0, alerted: 0 };
		const mailboxRows = new Map<string, RunnerDeliveryProjectionRow>(
			(this.deps.commDb?.listRunnerDeliveryProjectionRows(_now) ?? []).map(
				(row) => [row.id, row],
			),
		);
		const turnWakeRows = new Map<string, RunnerTurnWakeProjectionRow>(
			(this.deps.commDb?.listRunnerTurnWakeProjectionRows() ?? []).map(
				(row) => [row.wake_id, row],
			),
		);
		for (const attempt of this.deps.store.listLiveWorkflowDeliveryAttempts()) {
			try {
				const ref = JSON.parse(attempt.contract_ref_json) as {
					runId?: string;
					projectName?: string;
					issueId?: string;
					table?: string;
					pk?: string;
					terminal?: string | null;
				};
				const projectName =
					ref.projectName ?? attempt.root_id.split(":")[0] ?? "unknown";
				if (this.deps.projectName && projectName !== this.deps.projectName)
					continue;
				result.observed++;
				const classification = classifyDeliveryAttempt(attempt, _now);
				const mailboxRow =
					ref.table === "mailbox" && typeof ref.pk === "string"
						? mailboxRows.get(ref.pk)
						: undefined;
				const turnWakeRow =
					ref.table === "turn_wake_outbox" && typeof ref.pk === "string"
						? turnWakeRows.get(ref.pk)
						: undefined;
				const phaseWakeRow =
					ref.table === "runner_phase_wakes" && typeof ref.pk === "string"
						? this.deps.commDb?.getRunnerPhaseWakeProjectionRow(ref.pk)
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
				const issueId =
					ref.issueId ?? attempt.root_id.split(":")[1] ?? "unknown";
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
		return result;
	}
}
