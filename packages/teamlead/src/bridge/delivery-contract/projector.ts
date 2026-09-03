import type { CommDB } from "flywheel-comm/db";
import type { StateStore } from "../../StateStore.js";
import { deliveryRootId } from "./types.js";

function sourceKey(table: string, pk: string): string {
	return `${table}\u0000${pk}`;
}

function workflowRunIsTerminal(status: string): boolean {
	return status === "completed" || status === "terminated";
}

export class DeliveryProjector {
	constructor(
		private readonly deps: {
			store: StateStore;
			commDb: CommDB;
			projectName: string;
		},
	) {}

	runPass(_now = new Date().toISOString()): {
		examined: number;
		minted: number;
		advanced: number;
	} {
		const result = { examined: 0, minted: 0, advanced: 0 };
		const activeSources = new Set<string>();
		for (const row of this.deps.commDb.listRunnerDeliveryProjectionRows()) {
			result.examined++;
			if (row.state !== "ACKED" && row.superseded_by === null) {
				activeSources.add(sourceKey("mailbox", row.id));
			}
			const issueId = row.issue_id?.trim() || "unknown";
			const rootId = deliveryRootId({
				projectName: this.deps.projectName,
				issueId,
				family: "mailbox",
				physicalId: row.id,
			});
			const identity =
				this.deps.store.resolveWorkflowDeliveryProjectionIdentity({
					family: "mailbox",
					table: "mailbox",
					physicalId: row.id,
					fallbackRootId: rootId,
				});
			const projected = this.deps.store.projectWorkflowDeliveryAttempt({
				rootId: identity.rootId,
				attemptId: identity.attemptId,
				family: "mailbox",
				contractRef: { table: "mailbox", pk: row.id },
				mintedAt: row.created_at,
				sentAt: row.notified_at ?? row.delivered_at,
				receivedAt: row.acked_at,
				consumedAt: row.acked_at,
			});
			result.minted += projected.minted;
			result.advanced += projected.advanced;
		}
		for (const row of this.deps.commDb.listRunnerPhaseWakeProjectionRows(
			Date.parse(_now),
		)) {
			result.examined++;
			if (row.state !== "finished") {
				activeSources.add(sourceKey("runner_phase_wakes", row.message_id));
			}
			const issueId = row.issue_id?.trim() || "unknown";
			const metadata = row.metadata_json
				? (JSON.parse(row.metadata_json) as { rootId?: unknown })
				: {};
			const rootId =
				typeof metadata.rootId === "string"
					? metadata.rootId
					: deliveryRootId({
							projectName: this.deps.projectName,
							issueId,
							family: "phase_wake",
							physicalId: row.message_id,
						});
			const startedAt =
				row.started_at === null ? null : new Date(row.started_at).toISOString();
			const identity =
				this.deps.store.resolveWorkflowDeliveryProjectionIdentity({
					family: "phase_wake",
					table: "runner_phase_wakes",
					physicalId: row.message_id,
					fallbackRootId: rootId,
				});
			const projected = this.deps.store.projectWorkflowDeliveryAttempt({
				rootId: identity.rootId,
				attemptId: identity.attemptId,
				family: "phase_wake",
				contractRef: { table: "runner_phase_wakes", pk: row.message_id },
				mintedAt: new Date(row.queued_at).toISOString(),
				sentAt: row.first_push_at,
				receivedAt: startedAt,
				consumedAt: startedAt,
			});
			result.minted += projected.minted;
			result.advanced += projected.advanced;
		}
		for (const row of this.deps.commDb.listRunnerTurnWakeProjectionRows(
			Date.parse(_now),
		)) {
			result.examined++;
			if (row.state !== "acked" && row.state !== "cancelled") {
				activeSources.add(sourceKey("turn_wake_outbox", row.wake_id));
			}
			const rootId = deliveryRootId({
				projectName: this.deps.projectName,
				issueId: row.issue_id,
				family: "turn_wake",
				physicalId: row.wake_id,
			});
			const receivedAt =
				row.acked_at === null ? null : new Date(row.acked_at).toISOString();
			const identity =
				this.deps.store.resolveWorkflowDeliveryProjectionIdentity({
					family: "turn_wake",
					table: "turn_wake_outbox",
					physicalId: row.wake_id,
					fallbackRootId: rootId,
				});
			const projected = this.deps.store.projectWorkflowDeliveryAttempt({
				rootId: identity.rootId,
				attemptId: identity.attemptId,
				family: "turn_wake",
				contractRef: { table: "turn_wake_outbox", pk: row.wake_id },
				mintedAt: new Date(row.created_at).toISOString(),
				sentAt:
					row.first_push_at === null
						? null
						: new Date(row.first_push_at).toISOString(),
				receivedAt,
				consumedAt: receivedAt,
			});
			result.minted += projected.minted;
			result.advanced += projected.advanced;
		}
		for (const attempt of this.deps.store.listUnsettledWorkflowDeliveryAttempts()) {
			if (attempt.root_id.split(":")[0] !== this.deps.projectName) continue;
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
		return result;
	}
}
