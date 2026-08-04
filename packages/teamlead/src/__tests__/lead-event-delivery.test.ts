import { describe, expect, it } from "vitest";
import {
	deriveLeadEventAckToken,
	LeadEventDeliveryCoordinator,
	tokenMatches,
} from "../bridge/lead-event-delivery.js";
import type {
	DeliveryResult,
	LeadEventEnvelope,
	LeadRuntime,
	LeadRuntimeHealth,
} from "../bridge/lead-runtime.js";
import { StateStore } from "../StateStore.js";

class RecordingRuntime implements LeadRuntime {
	readonly type = "recording";
	readonly delivered: LeadEventEnvelope[] = [];

	async deliver(envelope: LeadEventEnvelope): Promise<DeliveryResult> {
		this.delivered.push(envelope);
		return { delivered: true };
	}
	async sendBootstrap(): Promise<void> {}
	async health(): Promise<LeadRuntimeHealth> {
		return { status: "healthy", lastDeliveryAt: null, lastDeliveredSeq: 0 };
	}
	async shutdown(): Promise<void> {}
}

describe("LeadEventDeliveryCoordinator", () => {
	it("passes non-ACK events straight to the runtime", async () => {
		const store = await StateStore.create(":memory:");
		const runtime = new RecordingRuntime();
		const seq = store.appendLeadEvent(
			"lead-1",
			"event-1",
			"status",
			JSON.stringify({ event_type: "status" }),
			"exec-1",
		);
		const envelope: LeadEventEnvelope = {
			seq,
			event: { event_type: "status" },
			sessionKey: "exec-1",
			leadId: "lead-1",
			timestamp: "2026-08-04T00:00:00.000Z",
		};
		const delivery = new LeadEventDeliveryCoordinator({
			store,
			runtimeForLead: () => runtime,
			secretProvider: {
				getActive: () => ({ secretId: "v1", key: Buffer.alloc(32, 1) }),
			},
		});

		expect(await delivery.deliver(envelope)).toEqual({ delivered: true });
		expect(runtime.delivered).toEqual([envelope]);
		store.close();
	});

	it("adds one signed receipt token to a persisted legacy ACK event", async () => {
		const store = await StateStore.create(":memory:");
		const runtime = new RecordingRuntime();
		const seq = store.appendLeadEvent(
			"lead-1",
			"event-2",
			"gate_question",
			JSON.stringify({ event_type: "gate_question" }),
			"exec-1",
		);
		(
			store as unknown as {
				db: { run(sql: string, params: unknown[]): void };
			}
		).db.run(
			`UPDATE lead_events SET ack_required = 1, ack_policy = 'question_response',
			 ack_protocol_version = 1, ack_owner_lead_id = 'lead-1' WHERE seq = ?`,
			[seq],
		);
		const delivery = new LeadEventDeliveryCoordinator({
			enabled: true,
			store,
			runtimeForLead: () => runtime,
			secretProvider: {
				getActive: () => ({ secretId: "v1", key: Buffer.alloc(32, 2) }),
			},
			now: () => Date.parse("2026-08-04T00:00:00.000Z"),
		});

		expect(
			await delivery.deliver({
				seq,
				event: { event_type: "gate_question" },
				sessionKey: "exec-1",
				leadId: "lead-1",
				timestamp: "",
			}),
		).toEqual({ delivered: true });
		expect(runtime.delivered[0]).toMatchObject({
			leadId: "lead-1",
			ack: { eventSeq: seq, policy: "question_response" },
		});
		expect(runtime.delivered[0]?.ack?.token).toBeTruthy();
		store.close();
	});
});

describe("lead-event receipt tokens", () => {
	it("match only the same event and owner epoch", () => {
		const secret = { secretId: "v1", key: Buffer.alloc(32, 3) };
		const token = deriveLeadEventAckToken(secret, {
			eventSeq: 7,
			ackOwnerLeadId: "lead-1",
			ownerEpoch: 2,
		});
		expect(tokenMatches(token, token)).toBe(true);
		expect(
			tokenMatches(
				token,
				deriveLeadEventAckToken(secret, {
					eventSeq: 7,
					ackOwnerLeadId: "lead-1",
					ownerEpoch: 3,
				}),
			),
		).toBe(false);
	});
});
