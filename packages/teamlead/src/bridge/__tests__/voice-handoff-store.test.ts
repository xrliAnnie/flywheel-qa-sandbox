import Database from "better-sqlite3";
import type { VoiceHandoffRequest } from "flywheel-voice-core";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceHandoffStore } from "../voice-handoff-store.js";

const dbs: Database.Database[] = [];

afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
});

function harness() {
	const db = new Database(":memory:");
	dbs.push(db);
	const store = new VoiceHandoffStore(db);
	store.migrate();
	return store;
}

function request(
	handoffId = "018f47d2-7b64-7b42-a3df-123456789abc",
): VoiceHandoffRequest {
	return {
		handoffId,
		idempotencyKey: `transcript-1:lead-1:action`,
		requestDigest: "a".repeat(64),
		intentKind: "action",
		payload: {
			targetLeadId: "lead-1",
			text: "Please handle the deployment check.",
			quotes: ["handle the deployment check"],
		},
		sessionId: "session-1",
		generation: 4,
		transcriptId: "transcript-1",
		utteranceId: "utterance-1",
		originalText: "Please handle the deployment check.",
		authorityBinding: {
			projectName: "flywheel",
			founderUserId: "founder-1",
			targetLeadId: "lead-1",
			sessionId: "session-1",
			generation: 4,
			transcriptId: "transcript-1",
			transcriptDigest: "b".repeat(64),
		},
		transcriptDurabilityReceipt: {
			version: 1,
			durable: true,
			sessionId: "session-1",
			transcriptId: "transcript-1",
			contentDigest: "b".repeat(64),
			persistedAt: "2026-09-23T20:00:00.000Z",
		},
	};
}

function authorize(store: VoiceHandoffStore, value = request()) {
	return store.authorize({
		request: value,
		projectName: "flywheel",
		founderUserId: "founder-1",
		targetLeadId: "lead-1",
		messageId: `voice-handoff:${value.handoffId}`,
		providerOperationId: `chat:lead-1:voice-handoff:${value.handoffId}`,
		now: "2026-09-23T20:00:01.000Z",
	});
}

describe("VoiceHandoffStore", () => {
	it("authorizes idempotently and fences a changed digest", () => {
		const store = harness();
		const first = authorize(store);
		expect(authorize(store)).toEqual(first);
		expect(() =>
			authorize(store, {
				...request(),
				requestDigest: "c".repeat(64),
			}),
		).toThrow("voice_handoff_identity_conflict");
	});

	it("uses an attempt token to fence stale dispatch completion", () => {
		const store = harness();
		const row = authorize(store);
		const dispatch = store.beginDispatch(
			row.handoffId,
			"2026-09-23T20:00:02.000Z",
		)!;
		expect(dispatch.state).toBe("dispatching");
		expect(
			store.finishDispatch({
				handoffId: row.handoffId,
				attemptToken: "stale",
				state: "committed",
				now: "2026-09-23T20:00:03.000Z",
			}),
		).toBeUndefined();
		expect(
			store.finishDispatch({
				handoffId: row.handoffId,
				attemptToken: dispatch.attemptToken!,
				state: "committed",
				now: "2026-09-23T20:00:03.000Z",
			})?.state,
		).toBe("committed");
	});

	it("allocates per-handoff result sequence and replays from each cursor", () => {
		const store = harness();
		const row = authorize(store);
		const append = (resultEventId: string, text: string) =>
			store.appendResult({
				handoffId: row.handoffId,
				resultEventId,
				requestDigest: row.requestDigest,
				sourceLeadId: row.targetLeadId,
				sourceDeliveryId: `delivery:${resultEventId}`,
				resultKind: "lead_reply",
				text,
				createdAt: "2026-09-23T20:00:04.000Z",
			});
		expect(append("result-1", "first").seq).toBe(1);
		expect(append("result-2", "second").seq).toBe(2);
		expect(append("result-1", "first").seq).toBe(1);
		expect(() => append("result-1", "changed")).toThrow(
			"voice_handoff_result_conflict",
		);

		expect(store.listResults(row.handoffId, 1, 100)).toMatchObject({
			highWatermark: 2,
			nextCursor: 2,
			events: [{ seq: 2, text: "second" }],
		});
	});

	it("rejects a result from a forged Lead or wrong request digest", () => {
		const store = harness();
		const row = authorize(store);
		expect(() =>
			store.appendResult({
				handoffId: row.handoffId,
				resultEventId: "result-forged",
				requestDigest: "f".repeat(64),
				sourceLeadId: "other-lead",
				sourceDeliveryId: "delivery-forged",
				resultKind: "completed",
				text: "done",
				createdAt: "2026-09-23T20:00:04.000Z",
			}),
		).toThrow("voice_handoff_result_unauthorized");
	});

	it("reconciles a preallocated provider identity without redispatch", () => {
		const store = harness();
		const row = authorize(store);
		const dispatch = store.beginDispatch(
			row.handoffId,
			"2026-09-23T20:00:02.000Z",
		)!;
		store.finishDispatch({
			handoffId: row.handoffId,
			attemptToken: dispatch.attemptToken!,
			state: "ambiguous",
			now: "2026-09-23T20:00:03.000Z",
		});
		expect(store.listAmbiguous("2026-09-23T20:00:03.000Z")).toHaveLength(1);
		expect(
			store.recordReconcile({
				handoffId: row.handoffId,
				found: true,
				now: "2026-09-23T20:00:04.000Z",
			})?.state,
		).toBe("committed");
	});
});
