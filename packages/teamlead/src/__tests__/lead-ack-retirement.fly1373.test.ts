import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("FLY-1373 legacy Lead ACK retirement", () => {
	let store: StateStore;
	let priorLegacy: string | undefined;
	let priorAck: string | undefined;

	beforeEach(async () => {
		priorLegacy = process.env.FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS;
		priorAck = process.env.FLYWHEEL_DELIVERY_ACK;
		process.env.FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS = "1";
		process.env.FLYWHEEL_DELIVERY_ACK = "1";
		store = await StateStore.create(":memory:");
	});

	afterEach(() => {
		store.close();
		if (priorLegacy === undefined)
			delete process.env.FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS;
		else process.env.FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS = priorLegacy;
		if (priorAck === undefined) delete process.env.FLYWHEEL_DELIVERY_ACK;
		else process.env.FLYWHEEL_DELIVERY_ACK = priorAck;
	});

	function seedLegacyAck(seq: number): void {
		const internal = store as unknown as {
			db: { run(sql: string, params: unknown[]): void };
		};
		internal.db.run(
			`UPDATE lead_events SET ack_required = 1,
			 ack_policy = 'explicit_receipt', ack_protocol_version = 1,
			 ack_owner_lead_id = 'lead-1' WHERE seq = ?`,
			[seq],
		);
	}

	it("retires every open cohort and removes it from every active selector", () => {
		const seq = store.appendLeadEvent(
			"lead-1",
			"event-1",
			"session_failed",
			JSON.stringify({
				event_type: "session_failed",
				execution_id: "exec-1",
				issue_id: "issue-1",
				project_name: "flywheel",
			}),
		);
		seedLegacyAck(seq);
		store.setActiveDeliverySecretId("secret-1");
		const now = "2026-07-19T20:00:00.000Z";
		const attempt = store.claimLeadEventDeliveryAttempt({
			eventSeq: seq,
			reason: "initial",
			secretId: "secret-1",
			nowIso: now,
			leaseExpiresIso: "2026-07-19T20:01:00.000Z",
		});
		expect(attempt).not.toBeNull();

		expect(store.retireOpenLeadEventAcks(now, "fly1373_cutover")).toBe(1);
		expect(store.getLeadEventBySeq(seq)).toMatchObject({
			ack_retired_at: now,
			ack_retired_reason: "fly1373_cutover",
		});
		expect(store.listLeadEventDeliveryAttempts(seq)[0]?.retired_at).toBe(now);
		expect(store.listOpenAckLeadEvents()).toEqual([]);
		expect(store.listLateAckLeadEvents(now)).toEqual([]);
		expect(store.listExpiredAckIngressRows(now)).toEqual([]);
		expect(store.transferLeadEventAckOwner(seq, "lead-2", now)).toBe(false);
		expect(store.markLeadEventAcked(seq, now)).toBe(false);
		expect(store.markLeadEventDeadLetterPending(seq, now)).toBe(false);
	});

	it("is idempotent and does not retire already acknowledged rows", () => {
		const seq = store.appendLeadEvent(
			"lead-1",
			"event-2",
			"session_failed",
			JSON.stringify({
				event_type: "session_failed",
				execution_id: "exec-2",
				issue_id: "issue-2",
				project_name: "flywheel",
			}),
		);
		seedLegacyAck(seq);
		const now = "2026-07-19T20:00:00.000Z";
		expect(store.markLeadEventAcked(seq, now)).toBe(true);
		expect(store.retireOpenLeadEventAcks(now, "fly1373_cutover")).toBe(0);
		expect(store.getLeadEventBySeq(seq)?.ack_retired_at).toBeUndefined();
	});
});
