import { executeLeadBridgeWrite } from "./lead-capability-write.js";
import type { LeadEventDeliveryCoordinator } from "./lead-event-delivery.js";

type Options = Parameters<typeof executeLeadBridgeWrite>[0];
/** Thin owned-event adapter; coordinator enablement and legacy ACK semantics are authoritative. */
export async function executeLeadInboxEventAck(
	options: Omit<
		Options,
		| "operationId"
		| "providerPrefix"
		| "resultIdentity"
		| "effect"
		| "input"
		| "authorize"
		| "sideEffectsPossible"
	> & {
		input: { eventHandle: string };
		coordinator: Pick<
			LeadEventDeliveryCoordinator,
			"readOwnedEvent" | "acknowledgeOwnedEvent"
		>;
	},
) {
	await options.assertCurrent();
	options.signal.throwIfAborted();
	const target = {
		...options.input,
		projectName: options.projectName,
		leadId: options.leadId,
	};
	const row = options.coordinator.readOwnedEvent(target);
	let attempted = false;
	return executeLeadBridgeWrite({
		...options,
		operationId: "inbox.event.ack",
		providerPrefix: "inbox-event",
		resultIdentity: { eventId: row.event_id },
		authorize: async () => {
			await options.assertCurrent();
			if (options.coordinator.readOwnedEvent(target).event_id !== row.event_id)
				throw new Error("inbox_event_scope_denied");
		},
		sideEffectsPossible: () => attempted,
		effect: async () => {
			await options.assertCurrent();
			options.signal.throwIfAborted();
			attempted = true;
			const result = options.coordinator.acknowledgeOwnedEvent(target);
			if (result.status === "disabled") {
				attempted = false;
				throw new Error("inbox_event_ack_disabled");
			}
			if (result.eventId !== row.event_id)
				throw new Error("inbox_event_scope_denied");
		},
	});
}
