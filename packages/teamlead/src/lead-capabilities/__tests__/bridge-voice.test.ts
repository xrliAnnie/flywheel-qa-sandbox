import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { LeadCapabilityBroker, type LeadOperationContext } from "../broker.js";
import { createBridgeVoiceHandlers } from "../handlers/bridge-voice.js";

const state = vi.hoisted(() => ({ enabled: true, current: true }));
vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({
		assertActivationCurrent: () => {
			if (!state.current) throw new Error("stale");
			return { lead: { codexVoiceActions: state.enabled } };
		},
	}),
}));

const REQUEST_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "20000000-0000-4000-8000-000000000001";

function context(): LeadOperationContext {
	return {
		requestId: REQUEST_ID,
		projectName: "raya",
		leadId: "raya",
		activationId: "activation",
		signal: new AbortController().signal,
		assertCurrent: async () => {
			if (!state.current) throw new Error("stale");
		},
	};
}

it("sends a fixed scoped voice envelope and validates the result identity", async () => {
	state.enabled = true;
	state.current = true;
	const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
		const request = JSON.parse(String(init?.body));
		expect(request.input).toEqual({ mode: "rg", topic: "聊一下" });
		expect(request.input).not.toHaveProperty("projectName");
		expect(init?.headers).toMatchObject({
			authorization: "Bearer bridge-token",
		});
		return Response.json({
			requestId: REQUEST_ID,
			status: "succeeded",
			resourceRefs: [`voice-session:${SESSION_ID}`],
			data: {
				result: {
					sessionId: SESSION_ID,
					threadId: null,
					mode: "rg",
					state: "desired",
					accepted: true,
				},
				receiptId: REQUEST_ID,
				observedAt: "2026-09-17T20:00:00.000Z",
			},
		});
	});
	const handlers = createBridgeVoiceHandlers({
		env: {
			FLYWHEEL_API_TOKEN: "bridge-token",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "carrier",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
			FLYWHEEL_PROJECT_NAME: "raya",
			FLYWHEEL_LEAD_ID: "raya",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
		},
		activationId: "activation",
		fetchImpl,
	});
	await expect(
		handlers
			.get("voice.session.start")!
			.execute({ mode: "rg", topic: "聊一下" }, context()),
	).resolves.toMatchObject({
		status: "succeeded",
		providerRef: `voice-session:${SESSION_ID}`,
	});
});

it("rechecks the raw opt-in at authorization time", async () => {
	state.enabled = false;
	state.current = true;
	const handler = createBridgeVoiceHandlers({
		env: {
			FLYWHEEL_API_TOKEN: "bridge-token",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "carrier",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
			FLYWHEEL_PROJECT_NAME: "raya",
			FLYWHEEL_LEAD_ID: "raya",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
		},
		activationId: "activation",
		fetchImpl: vi.fn(),
	}).get("voice.session.status")!;
	await expect(
		handler.authorize({ sessionId: SESSION_ID }, context()),
	).rejects.toThrow("bridge_voice_scope_denied");
});

it("rejects a response when the activation becomes stale during the request", async () => {
	state.enabled = true;
	state.current = true;
	const handler = createBridgeVoiceHandlers({
		env: {
			FLYWHEEL_API_TOKEN: "bridge-token",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "carrier",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
			FLYWHEEL_PROJECT_NAME: "raya",
			FLYWHEEL_LEAD_ID: "raya",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
		},
		activationId: "activation",
		fetchImpl: vi.fn(async () => {
			state.current = false;
			return Response.json({
				requestId: REQUEST_ID,
				status: "succeeded",
				resourceRefs: [`voice-session:${SESSION_ID}`],
				data: {
					result: {
						sessionId: SESSION_ID,
						mode: "rg",
						state: "live",
						threadId: null,
						receiveHealth: null,
					},
					receiptId: REQUEST_ID,
					observedAt: "2026-09-17T20:00:00.000Z",
				},
			});
		}),
	}).get("voice.session.status")!;
	await expect(
		handler.execute({ sessionId: SESSION_ID }, context()),
	).rejects.toThrow();
});

/**
 * FLY-2701 review R3 (HIGH): review R2 made the Bridge answer a start that met
 * its own booking with `succeeded` and a schedule-shaped payload. This handler
 * demands exactly one `voice-session:` resourceRef and parses the old start
 * schema, so the real Lead never saw the booking — it got a scope denial. The
 * schedule outcome has to be part of the catalog/handler/resourceRef contract,
 * end to end, or the "return the existing booking" rule only works in a router
 * unit test.
 */
const SCHEDULE_ID = "30000000-0000-4000-8000-000000000001";

it("accepts the booking a start was deduplicated into", async () => {
	state.enabled = true;
	state.current = true;
	const fetchImpl = vi.fn<typeof fetch>(async () =>
		Response.json({
			requestId: REQUEST_ID,
			status: "succeeded",
			resourceRefs: [`voice-schedule:${SCHEDULE_ID}`],
			data: {
				result: {
					status: "schedule_bound",
					scheduleId: SCHEDULE_ID,
					revision: 1,
					state: "scheduled",
					sessionId: null,
					scheduledAt: "2026-09-17T21:00:00.000Z",
				},
				receiptId: REQUEST_ID,
				observedAt: "2026-09-17T20:00:00.000Z",
			},
		}),
	);
	const handlers = createBridgeVoiceHandlers({
		env: {
			FLYWHEEL_API_TOKEN: "bridge-token",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "carrier",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
			FLYWHEEL_PROJECT_NAME: "raya",
			FLYWHEEL_LEAD_ID: "raya",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
		},
		activationId: "activation",
		fetchImpl,
	});

	await expect(
		handlers
			.get("voice.session.start")!
			.execute({ mode: "meeting", meetingId: SESSION_ID }, context()),
	).resolves.toMatchObject({
		status: "succeeded",
		providerRef: `voice-schedule:${SCHEDULE_ID}`,
		data: { result: { status: "schedule_bound", scheduleId: SCHEDULE_ID } },
	});
});

it("still refuses a schedule payload that does not match its resource ref", async () => {
	state.enabled = true;
	state.current = true;
	const fetchImpl = vi.fn<typeof fetch>(async () =>
		Response.json({
			requestId: REQUEST_ID,
			status: "succeeded",
			resourceRefs: ["voice-schedule:40000000-0000-4000-8000-000000000009"],
			data: {
				result: {
					status: "schedule_bound",
					scheduleId: SCHEDULE_ID,
					revision: 1,
					state: "scheduled",
					sessionId: null,
					scheduledAt: "2026-09-17T21:00:00.000Z",
				},
				receiptId: REQUEST_ID,
				observedAt: "2026-09-17T20:00:00.000Z",
			},
		}),
	);
	const handlers = createBridgeVoiceHandlers({
		env: {
			FLYWHEEL_API_TOKEN: "bridge-token",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "carrier",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
			FLYWHEEL_PROJECT_NAME: "raya",
			FLYWHEEL_LEAD_ID: "raya",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
		},
		activationId: "activation",
		fetchImpl,
	});

	await expect(
		handlers
			.get("voice.session.start")!
			.execute({ mode: "meeting", meetingId: SESSION_ID }, context()),
	).rejects.toThrow();
});

/**
 * FLY-2701 review R4 (MEDIUM): the deduplicated *success* reached the Lead, but
 * the conflict did not. The handler's rejection branch returned only
 * status/errorCode, and the broker then normalised anything it did not
 * recognise to `provider_rejected` with empty resourceRefs — so a Lead that
 * disagreed with an existing booking was told "rejected" and nothing else, with
 * no way to find the booking. Plan §5 asks for the opposite: report the booking.
 */
it("carries the booking's identity through the real broker on a conflict", async () => {
	state.enabled = true;
	state.current = true;
	const home = mkdtempSync(join(tmpdir(), "fly2701-broker-"));
	const journal = new SqliteJournalStore(join(home, "journal.sqlite"));
	const fetchImpl = vi.fn<typeof fetch>(async () =>
		Response.json({
			requestId: REQUEST_ID,
			status: "rejected",
			resourceRefs: [`voice-schedule:${SCHEDULE_ID}`],
			errorCode: "voice_schedule_binding_conflict",
		}),
	);
	const broker = new LeadCapabilityBroker({
		projectName: "raya",
		leadId: "raya",
		activationId: "activation",
		receipts: journal.operationReceipts,
		allowedOperationIds: () => new Set(["voice.session.start"]),
		assertCurrent: async () => {},
		handlers: createBridgeVoiceHandlers({
			env: {
				FLYWHEEL_API_TOKEN: "bridge-token",
				FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "carrier",
				FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
				FLYWHEEL_PROJECT_NAME: "raya",
				FLYWHEEL_LEAD_ID: "raya",
				FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
			},
			activationId: "activation",
			fetchImpl,
		}),
		secrets: ["bridge-token"],
	});

	const result = await broker.execute({
		schemaVersion: 1,
		operationId: "voice.session.start",
		requestId: REQUEST_ID,
		input: { mode: "meeting", meetingId: SESSION_ID },
	});

	expect(result).toMatchObject({
		status: "rejected",
		errorCode: "voice_schedule_binding_conflict",
		resourceRefs: [`voice-schedule:${SCHEDULE_ID}`],
	});
	rmSync(home, { recursive: true, force: true });
});
