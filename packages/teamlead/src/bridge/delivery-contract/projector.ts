import type { CommDB } from "flywheel-comm/db";
import type { StateStore } from "../../StateStore.js";
import { deliveryRootId } from "./types.js";

function sourceKey(table: string, pk: string): string {
	return `${table}\u0000${pk}`;
}

function recipientIsTerminal(status: string | null): boolean {
	return status === "completed" || status === "failed";
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
			activeSources.add(sourceKey("mailbox", row.id));
			const issueId = row.issue_id?.trim() || "unknown";
			const rootId = deliveryRootId({
				projectName: this.deps.projectName,
				issueId,
				family: "mailbox",
				physicalId: row.id,
			});
			const projected = this.deps.store.projectWorkflowDeliveryAttempt({
				rootId,
				attemptId: `${rootId}:g1:a1`,
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
		for (const row of this.deps.commDb.listRunnerPhaseWakeProjectionRows()) {
			result.examined++;
			activeSources.add(sourceKey("runner_phase_wakes", row.message_id));
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
			const projected = this.deps.store.projectWorkflowDeliveryAttempt({
				rootId,
				attemptId: `${rootId}:g1:a1`,
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
		for (const row of this.deps.commDb.listRunnerTurnWakeProjectionRows()) {
			result.examined++;
			activeSources.add(sourceKey("turn_wake_outbox", row.wake_id));
			const rootId = deliveryRootId({
				projectName: this.deps.projectName,
				issueId: row.issue_id,
				family: "turn_wake",
				physicalId: row.wake_id,
			});
			const receivedAt =
				row.acked_at === null ? null : new Date(row.acked_at).toISOString();
			const projected = this.deps.store.projectWorkflowDeliveryAttempt({
				rootId,
				attemptId: `${rootId}:g1:a1`,
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
			};
			if (typeof ref.table !== "string" || typeof ref.pk !== "string") continue;
			if (activeSources.has(sourceKey(ref.table, ref.pk))) continue;
			let settlementReason: string | undefined;
			if (attempt.family === "mailbox" && ref.table === "mailbox") {
				const row = this.deps.commDb.getRunnerDeliveryProjectionRow(ref.pk);
				if (
					row &&
					(row.state === "ACKED" ||
						row.state === "DEAD" ||
						row.superseded_by !== null ||
						row.dead_reason !== null ||
						recipientIsTerminal(row.recipient_status))
				) {
					settlementReason = "source_terminal";
				}
			} else if (
				attempt.family === "phase_wake" &&
				ref.table === "runner_phase_wakes"
			) {
				const row = this.deps.commDb.getRunnerPhaseWakeProjectionRow(ref.pk);
				if (
					row &&
					(row.state === "finished" ||
						recipientIsTerminal(row.recipient_status))
				) {
					settlementReason = "source_terminal";
				}
			} else if (
				attempt.family === "turn_wake" &&
				ref.table === "turn_wake_outbox"
			) {
				const row = this.deps.commDb.getRunnerTurnWakeProjectionRow(ref.pk);
				if (
					row &&
					(row.state === "acked" ||
						row.state === "cancelled" ||
						recipientIsTerminal(row.recipient_status))
				) {
					settlementReason = "source_terminal";
				}
			} else {
				const run = this.deps.store.getWorkflowStateDeliverySourceRun({
					family: attempt.family,
					table: ref.table,
					pk: ref.pk,
				});
				if (
					run?.project_name === this.deps.projectName &&
					workflowRunIsTerminal(run.status)
				) {
					settlementReason = "run_terminal";
				}
			}
			if (
				settlementReason &&
				this.deps.store.settleProjectedWorkflowDeliveryAttempt({
					family: attempt.family,
					table: ref.table,
					pk: ref.pk,
					reason: settlementReason,
				})
			) {
				result.advanced++;
			}
		}
		return result;
	}
}
