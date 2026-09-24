import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeVoiceClient } from "../../../../voice-headphone/src/bridge-client.js";
import type { HeadphoneInboxStore } from "../headphone-inbox.js";
import { createHeadphoneRouter } from "../headphone-routes.js";
import { voiceSessionAuthMiddleware } from "../voice-session-auth.js";

const MASTER = "master-token";
const SESSION_ID = "10000000-0000-4000-8000-000000000101";
const LEASE = "lease-token";
let server: Server | undefined;

afterEach(
	() =>
		new Promise<void>((resolve) => {
			if (!server) return resolve();
			server.close(() => {
				server = undefined;
				resolve();
			});
		}),
);

async function start() {
	const item = {
		itemId: "item-1",
		revision: 2,
		projectName: "flywheel",
		founderUserId: "founder-1",
		channelId: "channel-1",
		sourceMessageId: "message-1",
		sourceRevision: "revision-2",
		authorId: "lead-1",
		needsDecision: true,
		text: "choose an option",
		speechBrief: null,
		sourceCreatedAt: "2026-09-23T20:00:00.000Z",
		sourceResolved: false,
		contentDigest: "a".repeat(64),
		seq: 2,
	};
	const snapshot = vi.fn(() => ({
		snapshotId: "snapshot-1",
		highWatermark: 2,
		nextCursor: null,
		sourceStatus: [],
		items: [item],
	}));
	const claim = vi.fn(() => ({
		item,
		claimToken: "claim-token",
		leaseExpiresAt: "2026-09-23T20:00:31.000Z",
		attempt: 1,
		pendingKey: `inbox:${item.itemId}:${item.revision}:${SESSION_ID}:7:1`,
	}));
	const ack = vi.fn(() => false);
	const listSourceState = vi.fn(() => []);
	const inbox = {
		snapshot,
		claim,
		ack,
		listSourceState,
	} as unknown as HeadphoneInboxStore;
	const app = express();
	app.use(express.json());
	app.use(
		"/api/voice/headphone",
		voiceSessionAuthMiddleware(MASTER),
		createHeadphoneRouter({
			inbox,
			founderUserId: "founder-1",
			now: () => new Date("2026-09-23T20:00:01.000Z"),
			getSession: (sessionId) =>
				sessionId === SESSION_ID
					? {
							sessionId,
							projectName: "flywheel",
							sessionGeneration: 7,
							leaseToken: LEASE,
							leaseExpiresAt: "2026-09-23T20:01:00.000Z",
							state: "live",
						}
					: undefined,
		}),
	);
	server = createServer(app);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const bridgeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		bridgeUrl,
		base: `${bridgeUrl}/api/voice/headphone`,
		snapshot,
		claim,
	};
}

async function call(
	base: string,
	path: string,
	options: {
		token?: string;
		lease?: string;
		method?: string;
		body?: unknown;
	} = {},
) {
	const response = await fetch(`${base}${path}`, {
		method: options.method ?? "GET",
		headers: {
			...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
			...(options.lease ? { "X-Voice-Lease": options.lease } : {}),
			...(options.body === undefined
				? {}
				: { "Content-Type": "application/json" }),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	return { status: response.status, body: await response.json() };
}

describe("headphone routes", () => {
	it("requires the master credential and the current session lease", async () => {
		const { base, snapshot } = await start();
		const path = `/?sessionId=${SESSION_ID}&generation=7`;
		expect(await call(base, path)).toMatchObject({ status: 401 });
		expect(
			await call(base, path, { token: MASTER, lease: "stale" }),
		).toMatchObject({ status: 403 });
		expect(
			await call(base, path, { token: MASTER, lease: LEASE }),
		).toMatchObject({
			status: 200,
			body: {
				snapshotId: "snapshot-1",
				highWatermark: 2,
				nextCursor: null,
				sourceStatus: [],
				items: [
					{
						id: "item-1",
						revision: 2,
						needsDecision: true,
						text: "choose an option",
					},
				],
			},
		});
		expect(snapshot).toHaveBeenCalledWith({
			projectName: "flywheel",
			founderUserId: "founder-1",
			limit: 100,
		});
	});

	it("rejects unknown claim fields before any inbox mutation", async () => {
		const { base, claim } = await start();
		expect(
			await call(base, "/claim", {
				method: "POST",
				token: MASTER,
				lease: LEASE,
				body: {
					sessionId: SESSION_ID,
					generation: 7,
					itemId: "item-1",
					revision: 2,
					unexpected: true,
				},
			}),
		).toMatchObject({
			status: 400,
			body: { error: "headphone_claim_invalid" },
		});
		expect(claim).not.toHaveBeenCalled();
	});

	it("projects a claimed item to the same public shape as the list route", async () => {
		const { base } = await start();
		const response = await call(base, "/claim", {
			method: "POST",
			token: MASTER,
			lease: LEASE,
			body: {
				sessionId: SESSION_ID,
				generation: 7,
				itemId: "item-1",
				revision: 2,
			},
		});

		expect(response).toEqual({
			status: 200,
			body: {
				item: {
					id: "item-1",
					revision: 2,
					createdAt: "2026-09-23T20:00:00.000Z",
					needsDecision: true,
					text: "choose an option",
				},
				claimToken: "claim-token",
				leaseExpiresAt: "2026-09-23T20:00:31.000Z",
				attempt: 1,
				pendingKey: `inbox:item-1:2:${SESSION_ID}:7:1`,
			},
		});
	});

	it("feeds a nullable stored speech brief through the real route and client contract", async () => {
		const { bridgeUrl } = await start();
		const client = new BridgeVoiceClient({
			bridgeUrl,
			token: MASTER,
		});
		const binding = {
			sessionId: SESSION_ID,
			generation: 7,
			leaseToken: LEASE,
		};

		const [listed] = await client.listHeadphoneItems(binding);
		expect(listed).toEqual({
			id: "item-1",
			revision: 2,
			createdAt: "2026-09-23T20:00:00.000Z",
			needsDecision: true,
			text: "choose an option",
		});
		await expect(client.claimHeadphoneItem(binding, listed!)).resolves.toEqual({
			item: listed,
			claimToken: "claim-token",
			attempt: 1,
			pendingKey: `inbox:item-1:2:${SESSION_ID}:7:1`,
		});
	});
});
