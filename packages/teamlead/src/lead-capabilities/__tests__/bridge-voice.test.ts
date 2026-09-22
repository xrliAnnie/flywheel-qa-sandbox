import { expect, it, vi } from "vitest";
import type { LeadOperationContext } from "../broker.js";
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
