import type { StateStore } from "../StateStore.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { leadEventEnvelopeFromJournalRow } from "./legacy-lead-event-reconciler.js";
/** Durable producer/retry loop. Canonical mailbox dedupe retains the original delivery id. */
export function createVoiceCapabilityEventPump(options: {
	store: StateStore;
	now?: () => number;
	deliver(
		envelope: LeadEventEnvelope,
	): Promise<{ delivered: boolean; queued?: boolean; error?: string }>;
}) {
	let pending = false;
	return {
		async tick() {
			if (pending) return;
			pending = true;
			try {
				options.store.recordCapabilityTargetLockReminders(
					(options.now ?? Date.now)(),
				);
				for (const row of options.store.listPendingVoiceCapabilityEvents()) {
					try {
						const result = await options.deliver(
							leadEventEnvelopeFromJournalRow(row),
						);
						if (result.delivered) options.store.markLeadEventDelivered(row.seq);
						else if (!result.queued)
							options.store.recordDeliveryFailure(
								row.seq,
								result.error ?? "voice_capability_delivery_pending",
							);
					} catch {
						options.store.recordDeliveryFailure(
							row.seq,
							"voice_capability_delivery_failed",
						);
					}
				}
			} finally {
				pending = false;
			}
		},
	};
}
