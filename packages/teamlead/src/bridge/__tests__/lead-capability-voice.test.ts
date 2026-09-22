import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createLeadCapabilityVoiceRouter } from "../lead-capability-voice.js";

const scopeState = vi.hoisted(() => ({ enabled: true, current: true }));
vi.mock("flywheel-comm/lead-lease", () => ({
	forwardedLeadAuthorizationEnv: () => ({}),
}));
vi.mock("../lead-capability-scope.js", () => ({
	captureLeadCapabilityScope: () => {
		if (!scopeState.current) throw new Error("denied");
		return {
			row: { lead: { codexVoiceActions: scopeState.enabled } },
			assertSourceCurrent: () => {
				if (!scopeState.current) throw new Error("denied");
			},
		};
	},
}));

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const REQUEST_ID = "20000000-0000-4000-8000-000000000001";
let store: StateStore;
let server: Server | undefined;

beforeEach(async () => {
	store = await StateStore.create(":memory:");
	scopeState.enabled = true;
	scopeState.current = true;
});

afterEach(
	() =>
		new Promise<void>((resolve) => {
			const finish = () => {
				store.close();
				resolve();
			};
			if (!server) return finish();
			server.close(finish);
			server = undefined;
		}),
);

async function fixture(
	options: {
		onResolve?: () => void;
		onProvision?: (sessionId: string) => void | Promise<void>;
	} = {},
) {
	const provision = vi.fn(async (sessionId: string) => {
		if (options.onProvision) {
			await options.onProvision(sessionId);
			return;
		}
		store.updateVoiceProvisioning({
			sessionId,
			expectedStep: "reserved",
			nextStep: "done",
			nextState: "desired",
			rootMessageId: "300000000000000001",
			threadId: "300000000000000002",
			updatedAt: "2026-09-17T20:00:00.000Z",
		});
	});
	const app = express();
	app.use(express.json());
	const routers = createLeadCapabilityVoiceRouter({
		store,
		leaseRenewMs: 4_000,
		now: () => "2026-09-17T20:00:00.000Z",
		resolveStart: async () => {
			options.onResolve?.();
			return {
				sessionId: SESSION_ID,
				mode: "rg",
				projectName: "raya",
				leadId: "raya",
				guildId: "guild",
				voiceChannelId: "voice",
				voiceBotUserId: "12345678901234567",
				requestedBy: "master",
				credentialTier: "master",
				createdAt: "2026-09-17T20:00:00.000Z",
			};
		},
		provisionSession: provision,
	});
	app.use("/", routers.operationRouter);
	app.use("/receipt", routers.receiptRouter);
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		provision,
	};
}

function envelope(operationId: string, input: unknown, requestId = REQUEST_ID) {
	return {
		schemaVersion: 1,
		operationId,
		requestId,
		projectName: "raya",
		leadId: "raya",
		identityDigest: "a".repeat(64),
		carrierClaim: "claim",
		activationId: "activation",
		input,
	};
}

async function post(url: string, path: string, body: unknown) {
	const response = await fetch(`${url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json() };
}

it("starts once, replays the durable intent, and serves a receipt without reprovisioning", async () => {
	const { url, provision } = await fixture();
	const request = envelope("voice.session.start", {
		mode: "rg",
		topic: "聊一下",
	});
	const first = await post(url, "", request);
	expect(first).toMatchObject({
		status: 200,
		body: {
			status: "succeeded",
			resourceRefs: [`voice-session:${SESSION_ID}`],
			data: { result: { sessionId: SESSION_ID, accepted: true } },
		},
	});
	expect(await post(url, "", request)).toMatchObject({
		status: 200,
		body: { status: "succeeded", data: { result: { sessionId: SESSION_ID } } },
	});
	expect(provision).toHaveBeenCalledTimes(1);
	expect(await post(url, "/receipt", request)).toMatchObject({
		status: 200,
		body: { status: "succeeded", data: { result: { sessionId: SESSION_ID } } },
	});
	expect(
		await post(
			url,
			"",
			envelope(
				"voice.session.status",
				{ sessionId: SESSION_ID },
				"20000000-0000-4000-8000-000000000002",
			),
		),
	).toMatchObject({
		status: 200,
		body: { data: { result: { sessionId: SESSION_ID, state: "desired" } } },
	});
	const stop = envelope(
		"voice.session.stop",
		{ sessionId: SESSION_ID },
		"20000000-0000-4000-8000-000000000003",
	);
	expect(await post(url, "", stop)).toMatchObject({
		status: 200,
		body: { data: { result: { sessionId: SESSION_ID, state: "cancelled" } } },
	});
	expect(await post(url, "/receipt", stop)).toMatchObject({
		status: 200,
		body: { data: { result: { sessionId: SESSION_ID, state: "cancelled" } } },
	});
});

it("rechecks current scope after preflight before reserving or provisioning", async () => {
	const { url, provision } = await fixture({
		onResolve: () => {
			scopeState.current = false;
		},
	});
	expect(
		await post(url, "", envelope("voice.session.start", { mode: "rg" })),
	).toMatchObject({ status: 403, body: { errorCode: "voice_scope_denied" } });
	expect(store.getVoiceSession(SESSION_ID)).toBeUndefined();
	expect(provision).not.toHaveBeenCalled();
});

it("reports an uncertain post-reservation provisioning failure as unknown until receipt reconciliation", async () => {
	const { url } = await fixture({
		onProvision: () => {
			throw new Error("provisioning_transport_unknown");
		},
	});
	const request = envelope("voice.session.start", { mode: "rg" });
	const first = await post(url, "", request);
	expect(first).toMatchObject({
		status: 200,
		body: {
			status: "unknown",
			resourceRefs: [`voice-session:${SESSION_ID}`],
		},
	});
	expect(store.getVoiceSession(SESSION_ID)?.state).toBe("provisioning");
	expect(await post(url, "/receipt", request)).toMatchObject({
		status: 200,
		body: {
			status: "unknown",
			resourceRefs: [`voice-session:${SESSION_ID}`],
		},
	});
	store.updateVoiceProvisioning({
		sessionId: SESSION_ID,
		expectedStep: "reserved",
		nextStep: "done",
		nextState: "desired",
		rootMessageId: "300000000000000001",
		threadId: "300000000000000002",
		updatedAt: "2026-09-17T20:00:01.000Z",
	});
	expect(await post(url, "/receipt", request)).toMatchObject({
		status: 200,
		body: {
			status: "succeeded",
			data: { result: { sessionId: SESSION_ID, state: "desired" } },
		},
	});
});

it("reports a durable provisioning failure as rejected with its reason", async () => {
	const { url } = await fixture({
		onProvision: (sessionId) => {
			store.updateVoiceProvisioning({
				sessionId,
				expectedStep: "reserved",
				nextStep: "done",
				nextState: "failed",
				reason: "provisioning_thread",
				updatedAt: "2026-09-17T20:00:01.000Z",
			});
		},
	});
	const request = envelope("voice.session.start", { mode: "rg" });
	expect(await post(url, "", request)).toMatchObject({
		status: 200,
		body: {
			status: "rejected",
			errorCode: "provisioning_thread",
			resourceRefs: [`voice-session:${SESSION_ID}`],
		},
	});
	expect(await post(url, "/receipt", request)).toMatchObject({
		status: 200,
		body: {
			status: "rejected",
			errorCode: "provisioning_thread",
			resourceRefs: [`voice-session:${SESSION_ID}`],
		},
	});
});

it("denies an unconfigured Lead and hides foreign session existence", async () => {
	const { url } = await fixture();
	scopeState.enabled = false;
	expect(
		await post(
			url,
			"",
			envelope("voice.session.status", { sessionId: SESSION_ID }),
		),
	).toMatchObject({ status: 403, body: { errorCode: "voice_scope_denied" } });
	scopeState.enabled = true;
	expect(
		await post(
			url,
			"",
			envelope("voice.session.status", { sessionId: SESSION_ID }),
		),
	).toMatchObject({ status: 403, body: { errorCode: "voice_scope_denied" } });
});
