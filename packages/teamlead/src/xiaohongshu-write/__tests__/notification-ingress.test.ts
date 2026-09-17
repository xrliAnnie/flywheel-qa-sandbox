import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { XhsAuthorityClient } from "../authority-client.js";
import { createAuthorityHandlers } from "../authority-handlers.js";
import { fixture, NOW } from "./store-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(enabled = false, wrongPeer = false) {
	const f = fixture(process.getuid!());
	f.approve();
	const root = mkdtempSync("/tmp/xhs-notice-");
	const path = join(root, "peer");
	execFileSync("cc", [
		"-O2",
		fileURLToPath(
			new URL(
				"../../../../../scripts/xhs/xhs-peer-credentials.c",
				import.meta.url,
			),
		),
		"-o",
		path,
	]);
	const peerHelper = {
		path,
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
	};
	const state = { current: true, now: NOW + 3000, providerCalls: 0 };
	const assertCurrent = () => {
		if (!state.current) throw Error("private-policy-error");
	};
	const unavailable = async () => {
		state.providerCalls++;
		throw Error("provider-offline");
	};
	const handlers = createAuthorityHandlers({
		config: {
			enabled,
			modelUid: process.getuid!() + (wrongPeer ? 1 : 0),
			serviceUid: process.getuid!(),
			policyVersion: 1,
			founderConfigVersion: 1,
			keyId: "key-a",
			peerHelper,
			registry: [
				{
					projectId: f.identity.projectId,
					leadId: f.identity.leadId,
					account: f.frozen.account,
					founderId: "founder",
					canonicalFounderId: "founder",
					botId: "bot",
					guildId: "guild",
					channelId: "thread",
					initialCursor: "12345678901234567",
				},
			],
			provider: {
				providerBinary: {
					path: "/fixture/provider",
					sha256: f.frozen.upstream.binarySha256,
				},
				toolSchemaDigest: f.frozen.upstream.toolSchemaDigest,
			},
		},
		store: f.store,
		key: Buffer.alloc(32),
		assertCurrent,
		provider: {
			account: unavailable,
			prepare: unavailable,
			commit: unavailable,
			readFeeds: unavailable,
			read: unavailable,
			loginQR: unavailable,
		},
		artifacts: { read: unavailable, import: unavailable },
		transport: () => {
			throw Error("no-discord");
		},
		attachmentLimit: 10 * 1024 * 1024,
		now: () => state.now,
	});
	const server = createServer(handlers.ingress);
	const socketPath = join(root, "authority.sock");
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		handlers.close();
		f.close();
		rmSync(root, { recursive: true, force: true });
	});
	const scope = {
		projectId: f.identity.projectId,
		leadId: f.identity.leadId,
		activationId: "activation-a",
	};
	const client = new XhsAuthorityClient({
		socketPath,
		authorityUid: process.getuid!(),
		peerHelper,
		scope,
		assertCurrent: () => {},
	});
	const raw = (body: unknown, route = "/v1/notification/list") =>
		new Promise<{ status: number; body: unknown }>((resolve, reject) => {
			const req = request(
				{
					socketPath,
					path: route,
					method: "POST",
					headers: { "content-type": "application/json", "x-peer-uid": "0" },
				},
				(res) => {
					let data = "";
					res.on("data", (chunk) => {
						data += chunk;
					});
					res.on("end", () =>
						resolve({ status: res.statusCode!, body: JSON.parse(data) }),
					);
				},
			);
			req.on("error", reject);
			req.end(typeof body === "string" ? body : JSON.stringify(body));
		});
	return { f, state, client, raw, scope };
}
it.each([true, false])(
	"delivers notices with write enabled=%s and offline provider; ACK never consumes approval",
	async (enabled) => {
		const s = await setup(enabled);
		const eventId = `xhs-approved:${s.f.receiptId}`;
		const expected = {
			events: [
				{
					eventId,
					receiptId: s.f.receiptId,
					eventKind: "approved",
					proposalId: s.f.frozen.proposalId,
					contentDigest: s.f.digest,
					expiry: s.f.decision.expiresAt,
				},
			],
		};
		expect(await s.client.call("notifications", {})).toEqual(expected);
		expect(await s.client.call("notifications", {})).toEqual(expected);
		expect(await s.client.call("notification_ack", { eventId })).toEqual({
			acknowledged: true,
		});
		expect(await s.client.call("notification_ack", { eventId })).toEqual({
			acknowledged: true,
		});
		expect(await s.client.call("notifications", {})).toEqual({ events: [] });
		expect(s.f.store.pendingFounderNotifications()).toHaveLength(1);
		expect(s.f.store.status(s.f.frozen.proposalId, s.f.identity)?.state).toBe(
			"approved",
		);
		s.state.now = s.f.decision.expiresAt;
		expect(await s.client.call("notifications", {})).toMatchObject({
			events: [{ eventKind: "expired" }],
		});
		expect(s.f.store.claim(s.f.request, s.state.now).kind).toBe("denied");
		expect(s.state.providerCalls).toBe(0);
	},
);
it("rejects unknown scope, forged authorization, duplicate JSON, extra fields and stale policy", async () => {
	const s = await setup();
	for (const body of [
		{ ...s.scope, projectId: "other", input: {} },
		{ ...s.scope, leadId: "other", input: {} },
		{ ...s.scope, input: { approved: true } },
		{ ...s.scope, input: {}, actor: "founder" },
		JSON.stringify({ ...s.scope, input: {} }).replace(
			'"input":{}',
			'"input":{},"input":{}',
		),
	])
		expect((await s.raw(body)).status).toBe(403);
	expect(
		(await s.raw({ ...s.scope, input: {} }, "/v1/notification/mint")).status,
	).toBe(403);
	expect(s.f.store.bridgeNotifications(s.f.identity)).toHaveLength(1);
	s.state.current = false;
	expect(await s.raw({ ...s.scope, input: {} })).toEqual({
		status: 403,
		body: { code: "notification_ingress_denied" },
	});
});

it("rejects a wrong kernel peer even with a spoofed UID header", async () => {
	const s = await setup(false, true);
	expect((await s.raw({ ...s.scope, input: {} })).status).toBe(403);
	expect(s.f.store.bridgeNotifications(s.f.identity)).toHaveLength(1);
	expect(s.state.providerCalls).toBe(0);
});
