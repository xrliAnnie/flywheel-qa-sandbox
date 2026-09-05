import type { CommDB } from "flywheel-comm/db";
import type { StateStore } from "../../StateStore.js";
import { LegacyDeliveryReachabilityGuard } from "./legacy-reachability.js";
import { DELIVERY_MAINTENANCE_PAGE_SIZE } from "./policy.js";
import { deliveryRootId } from "./types.js";

function sourceKey(table: string, pk: string): string {
	return `${table}\u0000${pk}`;
}

function workflowRunIsTerminal(status: string): boolean {
	return status === "completed" || status === "terminated";
}

type ProjectionIdentity = ReturnType<
	StateStore["resolveWorkflowDeliveryProjectionIdentities"]
>[number];

function projectionNeedsWrite(
	identity: ProjectionIdentity,
	input: {
		contractRef: Record<string, unknown>;
		mintedAt: string;
		sentAt?: string | null;
		receivedAt?: string | null;
		consumedAt?: string | null;
	},
): boolean {
	return (
		!identity.found ||
		identity.settlementReason === "legacy_unreachable" ||
		identity.contractRefJson !== JSON.stringify(input.contractRef) ||
		(identity.generation === 1 && identity.mintedAt !== input.mintedAt) ||
		Boolean(input.sentAt && !identity.sentAt) ||
		Boolean(input.receivedAt && !identity.receivedAt) ||
		Boolean(input.consumedAt && !identity.consumedAt)
	);
}

export interface DeliveryProjectorCursor {
	lane: "mailbox" | "phase_wake" | "turn_wake" | "unsettled";
	after?: number | string;
}

export interface DeliveryProjectorPassResult {
	examined: number;
	minted: number;
	advanced: number;
	nextCursor?: DeliveryProjectorCursor;
}

export class DeliveryProjector {
	private readonly activeSources = new Set<string>();

	constructor(
		private readonly deps: {
			store: StateStore;
			commDb: CommDB;
			projectName: string;
		},
	) {}

	runPass(
		_now = new Date().toISOString(),
		cursor?: DeliveryProjectorCursor,
	): DeliveryProjectorPassResult {
		const result: DeliveryProjectorPassResult = {
			examined: 0,
			minted: 0,
			advanced: 0,
		};
		let lane = cursor?.lane ?? "mailbox";
		let after = cursor?.after;
		let remaining = DELIVERY_MAINTENANCE_PAGE_SIZE;
		if (!cursor) this.activeSources.clear();
		const activeSources = this.activeSources;
		const legacyReachability = new LegacyDeliveryReachabilityGuard(
			this.deps.store,
		);
		if (lane === "mailbox") {
			const candidates = this.deps.commDb.listRunnerDeliveryProjectionRows(
				_now,
				{
					...(typeof after === "number" ? { afterSeq: after } : {}),
					limit: remaining + 1,
					includeInflight: false,
				},
			);
			const rows = candidates.slice(0, remaining);
			const identities =
				this.deps.store.resolveWorkflowDeliveryProjectionIdentities(
					rows.map((row) => ({
						family: "mailbox",
						table: "mailbox",
						physicalId: row.id,
						fallbackRootId: deliveryRootId({
							projectName: this.deps.projectName,
							issueId: row.issue_id?.trim() || "unknown",
							family: "mailbox",
							physicalId: row.id,
						}),
					})),
				);
			for (const [index, row] of rows.entries()) {
				result.examined++;
				const sourceIsActive =
					row.state !== "ACKED" && row.superseded_by === null;
				const issueId = row.issue_id?.trim() || "unknown";
				const identity = identities[index]!;
				if (!sourceIsActive && identity.settled) continue;
				if (
					sourceIsActive &&
					legacyReachability.isLegacyUnreachable({
						recipientExecutionId: row.to_agent,
						fallbackRecipientStatus: row.recipient_status,
						projectName: this.deps.projectName,
						issueId,
						mintedAt: row.created_at,
						now: _now,
						attemptId: identity.attemptId,
					})
				) {
					if (
						this.deps.store.settleProjectedWorkflowDeliveryAttempt({
							family: "mailbox",
							table: "mailbox",
							pk: row.id,
							reason: "legacy_unreachable",
							now: _now,
						})
					) {
						result.advanced++;
					}
					continue;
				}
				if (sourceIsActive) {
					activeSources.add(sourceKey("mailbox", row.id));
				}
				const projectionInput = {
					contractRef: { table: "mailbox", pk: row.id },
					mintedAt: row.created_at,
					sentAt: row.notified_at ?? row.delivered_at,
					receivedAt: row.acked_at,
					consumedAt: row.acked_at,
				};
				if (!projectionNeedsWrite(identity, projectionInput)) continue;
				const projected = this.deps.store.projectWorkflowDeliveryAttempt({
					rootId: identity.rootId,
					attemptId: identity.attemptId,
					family: "mailbox",
					...projectionInput,
					...(sourceIsActive ? { legacyRearmAt: _now } : {}),
				});
				result.minted += projected.minted;
				result.advanced += projected.advanced;
			}
			remaining -= rows.length;
			if (candidates.length > rows.length) {
				result.nextCursor = {
					lane,
					after: rows[rows.length - 1]!.seq,
				};
				return result;
			}
			lane = "phase_wake";
			after = undefined;
			if (remaining === 0) {
				result.nextCursor = { lane };
				return result;
			}
		}
		if (lane === "phase_wake") {
			const candidates = this.deps.commDb.listRunnerPhaseWakeProjectionRows(
				Date.parse(_now),
				{
					...(typeof after === "number" ? { afterQueueSeq: after } : {}),
					limit: remaining + 1,
				},
			);
			const rows = candidates.slice(0, remaining);
			const identities =
				this.deps.store.resolveWorkflowDeliveryProjectionIdentities(
					rows.map((row) => {
						const metadata = row.metadata_json
							? (JSON.parse(row.metadata_json) as { rootId?: unknown })
							: {};
						return {
							family: "phase_wake",
							table: "runner_phase_wakes",
							physicalId: row.message_id,
							fallbackRootId:
								typeof metadata.rootId === "string"
									? metadata.rootId
									: deliveryRootId({
											projectName: this.deps.projectName,
											issueId: row.issue_id?.trim() || "unknown",
											family: "phase_wake",
											physicalId: row.message_id,
										}),
						};
					}),
				);
			for (const [index, row] of rows.entries()) {
				result.examined++;
				const sourceIsActive = row.state !== "finished";
				const issueId = row.issue_id?.trim() || "unknown";
				const identity = identities[index]!;
				if (!sourceIsActive && identity.settled) continue;
				if (
					sourceIsActive &&
					legacyReachability.isLegacyUnreachable({
						recipientExecutionId: row.execution_id,
						fallbackRecipientStatus: row.recipient_status,
						projectName: this.deps.projectName,
						issueId,
						mintedAt: new Date(row.queued_at).toISOString(),
						now: _now,
						attemptId: identity.attemptId,
					})
				) {
					if (
						this.deps.store.settleProjectedWorkflowDeliveryAttempt({
							family: "phase_wake",
							table: "runner_phase_wakes",
							pk: row.message_id,
							reason: "legacy_unreachable",
							now: _now,
						})
					) {
						result.advanced++;
					}
					continue;
				}
				if (sourceIsActive) {
					activeSources.add(sourceKey("runner_phase_wakes", row.message_id));
				}
				const startedAt =
					row.started_at === null
						? null
						: new Date(row.started_at).toISOString();
				const projectionInput = {
					contractRef: { table: "runner_phase_wakes", pk: row.message_id },
					mintedAt: new Date(row.queued_at).toISOString(),
					sentAt: row.first_push_at,
					receivedAt: startedAt,
					consumedAt: startedAt,
				};
				if (!projectionNeedsWrite(identity, projectionInput)) continue;
				const projected = this.deps.store.projectWorkflowDeliveryAttempt({
					rootId: identity.rootId,
					attemptId: identity.attemptId,
					family: "phase_wake",
					...projectionInput,
					...(sourceIsActive ? { legacyRearmAt: _now } : {}),
				});
				result.minted += projected.minted;
				result.advanced += projected.advanced;
			}
			remaining -= rows.length;
			if (candidates.length > rows.length) {
				result.nextCursor = {
					lane,
					after: rows[rows.length - 1]!.queue_seq,
				};
				return result;
			}
			lane = "turn_wake";
			after = undefined;
			if (remaining === 0) {
				result.nextCursor = { lane };
				return result;
			}
		}
		if (lane === "turn_wake") {
			const candidates = this.deps.commDb.listRunnerTurnWakeProjectionRows(
				Date.parse(_now),
				{
					...(typeof after === "number" ? { afterQueueSeq: after } : {}),
					limit: remaining + 1,
				},
			);
			const rows = candidates.slice(0, remaining);
			const identities =
				this.deps.store.resolveWorkflowDeliveryProjectionIdentities(
					rows.map((row) => ({
						family: "turn_wake",
						table: "turn_wake_outbox",
						physicalId: row.wake_id,
						fallbackRootId: deliveryRootId({
							projectName: this.deps.projectName,
							issueId: row.issue_id,
							family: "turn_wake",
							physicalId: row.wake_id,
						}),
					})),
				);
			for (const [index, row] of rows.entries()) {
				result.examined++;
				const sourceIsActive =
					row.state !== "acked" && row.state !== "cancelled";
				const receivedAt =
					row.acked_at === null ? null : new Date(row.acked_at).toISOString();
				const identity = identities[index]!;
				if (!sourceIsActive && identity.settled) continue;
				if (
					sourceIsActive &&
					legacyReachability.isLegacyUnreachable({
						recipientExecutionId: row.execution_id,
						fallbackRecipientStatus: row.recipient_status,
						projectName: this.deps.projectName,
						issueId: row.issue_id,
						mintedAt: new Date(row.created_at).toISOString(),
						now: _now,
						attemptId: identity.attemptId,
					})
				) {
					if (
						this.deps.store.settleProjectedWorkflowDeliveryAttempt({
							family: "turn_wake",
							table: "turn_wake_outbox",
							pk: row.wake_id,
							reason: "legacy_unreachable",
							now: _now,
						})
					) {
						result.advanced++;
					}
					continue;
				}
				if (sourceIsActive) {
					activeSources.add(sourceKey("turn_wake_outbox", row.wake_id));
				}
				const projectionInput = {
					contractRef: { table: "turn_wake_outbox", pk: row.wake_id },
					mintedAt: new Date(row.created_at).toISOString(),
					sentAt:
						row.first_push_at === null
							? null
							: new Date(row.first_push_at).toISOString(),
					receivedAt,
					consumedAt: receivedAt,
				};
				if (!projectionNeedsWrite(identity, projectionInput)) continue;
				const projected = this.deps.store.projectWorkflowDeliveryAttempt({
					rootId: identity.rootId,
					attemptId: identity.attemptId,
					family: "turn_wake",
					...projectionInput,
					...(sourceIsActive ? { legacyRearmAt: _now } : {}),
				});
				result.minted += projected.minted;
				result.advanced += projected.advanced;
			}
			remaining -= rows.length;
			if (candidates.length > rows.length) {
				result.nextCursor = {
					lane,
					after: rows[rows.length - 1]!.queue_seq,
				};
				return result;
			}
			lane = "unsettled";
			after = undefined;
			if (remaining === 0) {
				result.nextCursor = { lane };
				return result;
			}
		}
		const candidates = this.deps.store.listUnsettledWorkflowDeliveryAttempts({
			projectName: this.deps.projectName,
			...(typeof after === "string" ? { afterRootId: after } : {}),
			limit: remaining + 1,
		});
		const attempts = candidates.slice(0, remaining);
		for (const attempt of attempts) {
			const ref = JSON.parse(attempt.contract_ref_json) as {
				table?: unknown;
				pk?: unknown;
				runId?: unknown;
				routeRevision?: unknown;
				redriveGeneration?: unknown;
			};
			if (typeof ref.table !== "string" || typeof ref.pk !== "string") continue;
			const version =
				attempt.family === "rework" && Number.isSafeInteger(ref.routeRevision)
					? { routeRevision: Number(ref.routeRevision) }
					: attempt.family === "carrier" &&
							Number.isSafeInteger(ref.redriveGeneration)
						? { redriveGeneration: Number(ref.redriveGeneration) }
						: undefined;
			if (activeSources.has(sourceKey(ref.table, ref.pk))) continue;
			let settlementReason: string | undefined;
			let commSourceMissing = false;
			if (attempt.family === "mailbox" && ref.table === "mailbox") {
				const row = this.deps.commDb.getRunnerDeliveryProjectionRow(ref.pk);
				if (row && (row.state === "ACKED" || row.superseded_by !== null)) {
					settlementReason = "source_terminal";
				}
				commSourceMissing = !row;
			} else if (
				attempt.family === "phase_wake" &&
				ref.table === "runner_phase_wakes"
			) {
				const row = this.deps.commDb.getRunnerPhaseWakeProjectionRow(ref.pk);
				if (row?.state === "finished") {
					settlementReason = "source_terminal";
				}
				commSourceMissing = !row;
			} else if (
				attempt.family === "turn_wake" &&
				ref.table === "turn_wake_outbox"
			) {
				const row = this.deps.commDb.getRunnerTurnWakeProjectionRow(ref.pk);
				if (row && (row.state === "acked" || row.state === "cancelled")) {
					settlementReason = "source_terminal";
				}
				commSourceMissing = !row;
			} else {
				const authoritativeRun =
					this.deps.store.getWorkflowStateDeliverySourceRun({
						family: attempt.family,
						table: ref.table,
						pk: ref.pk,
					});
				const run =
					authoritativeRun ??
					(typeof ref.runId === "string"
						? this.deps.store.getWorkflowRun(ref.runId)
						: undefined) ??
					this.deps.store.getWorkflowDeliveryAttemptRun(attempt.attempt_id);
				if (
					run?.project_name === this.deps.projectName &&
					workflowRunIsTerminal(run.status)
				) {
					settlementReason = "run_terminal";
				}
			}
			if (commSourceMissing) {
				if (
					this.deps.store.hasInFlightWorkflowDeliveryReroute({
						operationId: ref.pk,
						childAttemptId: attempt.attempt_id,
						family: attempt.family,
					})
				) {
					continue;
				}
				const run = this.deps.store.getWorkflowDeliveryAttemptRun(
					attempt.attempt_id,
				);
				if (
					run?.project_name === this.deps.projectName &&
					workflowRunIsTerminal(run.status)
				) {
					settlementReason = "run_terminal";
				} else {
					settlementReason = "source_pruned";
				}
			}
			if (
				settlementReason &&
				this.deps.store.settleProjectedWorkflowDeliveryAttempt({
					family: attempt.family,
					table: ref.table,
					pk: ref.pk,
					reason: settlementReason,
					now: _now,
					...(version ? { version } : {}),
				})
			) {
				result.advanced++;
			}
		}
		if (candidates.length > attempts.length) {
			result.nextCursor = {
				lane: "unsettled",
				after: attempts[attempts.length - 1]!.root_id,
			};
		}
		return result;
	}
}
