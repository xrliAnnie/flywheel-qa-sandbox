import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { canonical } from "../canonical.js";
import { signDispatchPermit } from "../permit.js";
import { createProviderAuthorityHandler } from "../provider-authority.js";
import { fixture, NOW } from "./store-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup(wrongPeer = false) {
	const f = fixture();
	f.approve();
	const claim = f.store.claim(f.request, NOW + 3000);
	if (claim.kind !== "claimed") throw Error("claim");
	const permit = JSON.parse(
		signDispatchPermit(
			{
				audience: f.identity.providerInstanceId,
				proposalId: f.frozen.proposalId,
				receiptId: f.receiptId,
				attemptId: claim.attemptId,
				contentDigest: f.digest,
				accountUserId: f.identity.accountUserId,
				accountEpoch: f.identity.accountEpoch,
				providerGeneration: f.identity.providerGeneration,
				leaseId: f.request.leaseId,
				keyId: "key-a",
				approvalExpiresAt: f.decision.expiresAt,
				leaseExpiresAt: NOW + 90000,
			},
			Buffer.alloc(32),
			NOW + 3000,
		).permitJson,
	);
	const root = mkdtempSync("/tmp/xhs-authority-test-");
	const helper = join(root, "peer");
	execFileSync("cc", [
		"-O2",
		fileURLToPath(
			new URL(
				"../../../../../scripts/xhs/xhs-peer-credentials.c",
				import.meta.url,
			),
		),
		"-o",
		helper,
	]);
	const state = {
		activation: "activation-a",
		tokens: 0,
		changeDuringToken: false,
		onScope: undefined as ((signal: AbortSignal) => Promise<void>) | undefined,
	};
	const handler = createProviderAuthorityHandler({
		store: f.store,
		providerUid: process.getuid!() + (wrongPeer ? 1 : 0),
		peerHelper: {
			path: helper,
			sha256: createHash("sha256").update(readFileSync(helper)).digest("hex"),
		},
		now: () => NOW + 3001,
		scope: async (_proposalId, signal) => {
			await state.onScope?.(signal);
			return {
				identity: f.identity,
				activationId: state.activation,
				keyId: "key-a",
			};
		},
		token: async (context) => {
			state.tokens++;
			expect(context.frozen).toEqual(f.frozen);
			expect(context.activationId).toBe("activation-a");
			if (state.changeDuringToken) state.activation = "replacement-activation";
			return "synthetic-private-token";
		},
	});
	const server = createServer(handler);
	const socket = join(root, "authority.sock");
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, resolve);
	});
	cleanups.push(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		f.close();
		rmSync(root, { recursive: true, force: true });
	});
	const post = (path: string, body: unknown) =>
		new Promise<{ status: number; body: Record<string, unknown> }>(
			(resolve, reject) => {
				const req = request(
					{
						socketPath: socket,
						path,
						method: "POST",
						headers: {
							"content-type": "application/json",
							"X-Peer-Uid": String(process.getuid!()),
						},
						agent: false,
					},
					(res) => {
						let raw = "";
						res.on("data", (chunk) => {
							raw += chunk;
						});
						res.on("end", () => {
							try {
								resolve({ status: res.statusCode!, body: JSON.parse(raw) });
							} catch (error) {
								reject(error);
							}
						});
					},
				);
				req.on("error", reject);
				req.end(JSON.stringify(body));
			},
		);
	return { f, permit, state, post, server, socket };
}
it("serves bound admission/token responses using kernel peer and real ledger", async () => {
	const { f, permit, state, post } = await setup();
	const tokenRequest = {
		permit,
		account: f.frozen.account,
		target: f.frozen.target,
	};
	expect((await post("/internal/v1/provider-token", tokenRequest)).status).toBe(
		403,
	);
	expect(state.tokens).toBe(0);
	const admitted = await post("/internal/v1/provider-admission", permit);
	expect(admitted).toEqual({
		status: 200,
		body: {
			admitted: true,
			permitDigest: createHash("sha256")
				.update(canonical(permit))
				.digest("hex"),
		},
	});
	const resolved = await post("/internal/v1/provider-token", tokenRequest);
	expect(resolved.status).toBe(200);
	expect(resolved.body.token).toBe("synthetic-private-token");
	expect(state.tokens).toBe(1);
});
it("rechecks activation after the asynchronous resource lookup", async () => {
	const { f, permit, state, post } = await setup();
	await post("/internal/v1/provider-admission", permit);
	state.changeDuringToken = true;
	const response = await post("/internal/v1/provider-token", {
		permit,
		account: f.frozen.account,
		target: f.frozen.target,
	});
	expect(response).toEqual({
		status: 403,
		body: { code: "private_provider_denied" },
	});
});
it("rejects a claimed header UID when the kernel peer is wrong", async () => {
	const { f, permit, post } = await setup(true);
	expect((await post("/internal/v1/provider-admission", permit)).status).toBe(
		403,
	);
	expect(f.store.status(f.frozen.proposalId, f.identity)?.attempt?.state).toBe(
		"claimed",
	);
});
it("cancels scope work when the peer disconnects after sending the complete request", async () => {
	const s = await setup();
	let enter!: (signal: AbortSignal) => void, release!: () => void;
	const entered = new Promise<AbortSignal>((resolve) => {
		enter = resolve;
	});
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	s.state.onScope = async (signal) => {
		enter(signal);
		await pending;
	};
	const closed = new Promise<void>((resolve) =>
		s.server.once("connection", (socket) =>
			socket.once("close", () => resolve()),
		),
	);
	const req = request({
		socketPath: s.socket,
		path: "/internal/v1/provider-admission",
		method: "POST",
		agent: false,
	});
	req.on("error", () => {});
	req.end(JSON.stringify(s.permit));
	try {
		const signal = await entered;
		req.destroy();
		await closed;
		expect(signal.aborted).toBe(true);
		expect(
			s.f.store.status(s.f.frozen.proposalId, s.f.identity)?.attempt?.state,
		).toBe("claimed");
	} finally {
		req.destroy();
		release();
	}
});
