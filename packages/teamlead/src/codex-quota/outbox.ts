import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { leadEventEnvelopeFromJournalRow } from "../bridge/legacy-lead-event-reconciler.js";
import type { DurableQueueReceipt } from "../bridge/runtime-registry.js";
import type {
	AlertAttemptOptions,
	AlertPayload,
} from "../LeadAlertNotifier.js";
import type { StateStore } from "../StateStore.js";
export interface CodexQuotaOutboxOptions {
	store: StateStore;
	send(payload: AlertPayload, attempt: AlertAttemptOptions): Promise<unknown>;
	founderUserId?: string;
	resolveLead?(executionId: string): string | undefined;
	enqueueLead?(
		envelope: LeadEventEnvelope,
		content: string,
	): DurableQueueReceipt;
	now?: () => number;
}
/** The existing notifier owns Discord retries; claims never substitute for its receipt. */
export function createCodexQuotaOutboxDelivery(
	options: CodexQuotaOutboxOptions,
): () => Promise<void> {
	return async () => {
		for (const row of options.store.codexQuota.listOutbox()) {
			if (row.delivery_state !== "pending") continue;
			const eventId = String(row.event_id);
			if (row.kind === "lead_summary") {
				if (!options.resolveLead || !options.enqueueLead) continue;
				const targets = options.store.codexQuota
					.listTargets(String(row.incident_id))
					.filter((t) => t.target_kind === "runner");
				const groups = new Map<string, typeof targets>();
				let complete = targets.length > 0;
				for (const target of targets) {
					const lead = options.resolveLead(String(target.old_execution_id));
					if (!lead) {
						complete = false;
						continue;
					}
					groups.set(lead, [...(groups.get(lead) ?? []), target]);
				}
				for (const [lead, owned] of groups) {
					const session = options.store.getSession(
						String(owned[0]!.old_execution_id),
					);
					if (!session) {
						complete = false;
						continue;
					}
					const incident = options.store.codexQuota.getIncident(
						String(row.incident_id),
					);
					const source =
						options.store.codexQuota.getRunnerBindings(session.execution_id)[0]
							?.profile ?? "unknown";
					const content =
						`Codex quota recovery ${source} -> ${String(incident?.target_profile ?? "unknown")}: ` +
						owned
							.map(
								(t) =>
									`${String(t.run_id)} -> ${String(t.new_run_id ?? "none")} (${String(t.state)})`,
							)
							.join("; ");
					const deliveryId = `${eventId}:lead:${lead}`;
					try {
						const seq = options.store.appendLeadEvent(
							lead,
							deliveryId,
							"codex_quota_recovery",
							JSON.stringify({
								event_type: "codex_quota_recovery",
								execution_id: session.execution_id,
								issue_id: session.issue_id,
								project_name: session.project_name,
								summary: content,
							}),
							session.execution_id,
						);
						const durable = options.store.getLeadEventBySeq(seq);
						if (!durable) {
							complete = false;
							continue;
						}
						const accepted = options.enqueueLead(
							leadEventEnvelopeFromJournalRow(durable, 2),
							content,
						);
						if (accepted.queued !== true || !accepted.deliveryId)
							complete = false;
					} catch {
						complete = false;
					}
				}
				if (complete)
					options.store.codexQuota.markOutboxDelivered(
						eventId,
						`${eventId}:lead-queues`,
					);
				continue;
			}
			const receipt = options.store.getAlertDeliveryReceipt(eventId);
			if (receipt) {
				options.store.codexQuota.markOutboxDelivered(
					eventId,
					`${receipt.outcome}:${receipt.recorded_at}`,
				);
				continue;
			}
			const founder = row.kind === "founder_alert";
			const notification = row.kind === "switch_notification";
			const founderVisible = founder || notification;
			if (founderVisible && !/^\d{16,22}$/.test(options.founderUserId ?? ""))
				continue;
			const claim = options.store.codexQuota.claimOutboxAttempt(
				eventId,
				(options.now ?? Date.now)(),
			);
			if (!claim) continue;
			const incidentId = String(row.incident_id);
			const incident = options.store.codexQuota.getIncident(incidentId);
			let reason = "quota_incident";
			try {
				const data = JSON.parse(String(row.payload_json));
				if (
					typeof data.reason === "string" &&
					/^[a-z_]{1,80}$/.test(data.reason)
				)
					reason = data.reason;
			} catch {}
			let sourceProfile = "unknown";
			let reset = "unknown";
			try {
				const source = options.store.codexQuota
					.listOutbox()
					.find((item) => item.event_id === `${incidentId}:usage_limit`);
				const data = JSON.parse(String(source?.payload_json ?? "{}"));
				if (["school", "personal", "business"].includes(data.profile))
					sourceProfile = data.profile;
				if (typeof data.resetsAt === "number" && Number.isFinite(data.resetsAt))
					reset = new Date(data.resetsAt).toISOString();
			} catch {}
			const runs = options.store.codexQuota
				.listTargets(incidentId)
				.filter((target) => target.target_kind === "runner");
			const targetProfile = ["school", "personal", "business"].includes(
				String(incident?.target_profile),
			)
				? String(incident?.target_profile)
				: "none";
			const details = `Trigger=usageLimited from=${sourceProfile} reset=${reset} to=${targetProfile} affected_runs=${runs.length} restarted_runs=${runs.filter((target) => target.state === "recovered").length}`;
			const payload: AlertPayload = {
				leadId: "codex-quota",
				projectName: "machine",
				eventId,
				eventType: founder
					? "quota_no_target"
					: row.kind === "usage_limit"
						? "usage_limit"
						: "quota_switch_confirmation",
				title: founder
					? "Codex quota recovery needs attention"
					: row.kind === "usage_limit"
						? "Codex usage limit observed"
						: "Codex quota recovery update",
				body: founder
					? `Codex fleet remains paused (${reason}). No blind replacement is allowed. Check account resets or add credits. ${details}`
					: notification
						? `Codex automatic account switch (${reason}). ${details}`
						: `Codex incident ${incidentId}: ${reason}. Recovery is tracked by the fleet coordinator.`,
				severity: founder ? "severe" : "warning",
				metadata: {
					codexQuota: {
						vendor: "codex",
						incidentId,
						generation: Number(incident?.generation ?? 0),
					},
				},
				...(founder ? { mentionUserId: options.founderUserId } : {}),
			};
			try {
				await options.send(payload, {
					replayAfterAmbiguousAttempt: claim.replay,
				});
			} catch {
				continue;
			}
			const delivered = options.store.getAlertDeliveryReceipt(eventId);
			if (delivered)
				options.store.codexQuota.markOutboxDelivered(
					eventId,
					`${delivered.outcome}:${delivered.recorded_at}`,
				);
		}
	};
}
