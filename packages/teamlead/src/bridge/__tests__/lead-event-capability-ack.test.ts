import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { SqliteOutboundDedupStore } from "../../lead-backends/codex/SqliteOutboundDedupStore.js";
import { StateStore } from "../../StateStore.js";
import { LeadEventDeliveryCoordinator } from "../lead-event-delivery.js";
import { executeLeadInboxEventAck } from "../lead-inbox-event-ack.js";

it.each([false, true])(
	"keeps event ACK coordinator enabled=%s semantics without exposing tokens",
	async (enabled) => {
		const store = await StateStore.create(":memory:");
		const secretProvider = {
			getActive: vi.fn(() => ({ secretId: "test", key: Buffer.alloc(32, 7) })),
		};
		try {
			const seq = store.appendLeadEvent(
				"eng",
				"event-id",
				"session_failed",
				JSON.stringify({ event_type: "session_failed", project_name: "demo" }),
			);
			(
				store as unknown as {
					db: { run(sql: string, params: unknown[]): void };
				}
			).db.run(
				"UPDATE lead_events SET ack_required = 1, ack_policy = 'explicit_receipt', ack_protocol_version = 1 WHERE seq = ?",
				[seq],
			);
			const coordinator = new LeadEventDeliveryCoordinator({
				store,
				secretProvider,
				runtimeForLead: () => undefined,
				enabled,
			});
			const input = {
				eventHandle: `event_${seq}`,
				projectName: "demo",
				leadId: "eng",
			};
			expect(() =>
				coordinator.acknowledgeOwnedEvent({ ...input, leadId: "other" }),
			).toThrow();
			expect(() =>
				coordinator.acknowledgeOwnedEvent({ ...input, projectName: "foreign" }),
			).toThrow();
			const receipts = new SqliteOutboundDedupStore(":memory:");
			try {
				const requestId = randomUUID();
				const options = {
					projectName: "demo",
					leadId: "eng",
					activationId: "activation",
					requestId,
					input: { eventHandle: input.eventHandle },
					coordinator,
					receipts: receipts.operationReceipts,
					signal: new AbortController().signal,
					secrets: [],
					assertCurrent: async () => {},
				};
				const response = await executeLeadInboxEventAck(options);
				expect(response.status).toBe(enabled ? "succeeded" : "rejected");
				if (!enabled)
					expect(response.errorCode).toBe("inbox_event_ack_disabled");
				expect(
					(await executeLeadInboxEventAck({ ...options, receiptOnly: true }))
						.status,
				).toBe(response.status);
				expect(
					(
						await executeLeadInboxEventAck({
							...options,
							receiptOnly: true,
							requestId: randomUUID(),
						})
					).status,
				).toBe("unknown");
			} finally {
				receipts.close();
			}
			const result = coordinator.acknowledgeOwnedEvent(input);
			expect(result).toEqual({
				status: enabled ? "acknowledged" : "disabled",
				eventId: "event-id",
			});
			expect(Boolean(store.getLeadEventBySeq(seq)?.acked_at)).toBe(enabled);
			if (!enabled) expect(secretProvider.getActive).not.toHaveBeenCalled();
			expect(coordinator.acknowledgeOwnedEvent(input)).toEqual(result);
		} finally {
			store.close();
		}
	},
);
