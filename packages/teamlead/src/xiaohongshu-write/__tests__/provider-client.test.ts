import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { canonical, contentDigest } from "../canonical.js";
import { XhsWriteExecutor } from "../executor.js";
import { signDispatchPermit } from "../permit.js";
import { XhsProviderClient } from "../provider-client.js";
import { fixture, NOW } from "./store-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

it("normalizes all six private reads and binds their results before returning raw data", async () => {
	const f = frozenFixture();
	const expected = { account: f.frozen.account, upstream: f.frozen.upstream };
	let data: unknown;
	const requests: { path: string; input: unknown }[] = [];
	const client = await setup(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		requests.push({ path: req.url!, input: JSON.parse(raw) });
		res.end(JSON.stringify({ ...expected, data }));
	});
	const cases = [
		[
			"search_feeds",
			{ keyword: "fixture" },
			{ feeds: [], count: 0 },
			{
				keyword: "fixture",
				limit: 20,
				filters: {
					sort_by: "",
					note_type: "",
					publish_time: "",
					search_scope: "",
					location: "",
				},
			},
		],
		[
			"get_feed_detail",
			{ feed_id: "feed-a", xsec_token: "synthetic-token" },
			{ feed_id: "feed-a", data: { note: { noteId: "feed-a" }, comments: {} } },
			{
				feed_id: "feed-a",
				xsec_token: "synthetic-token",
				load_all_comments: false,
				limit: 20,
				click_more_replies: false,
				reply_limit: 10,
				scroll_speed: "normal",
			},
		],
		[
			"user_profile",
			{ user_id: "user-a", xsec_token: "synthetic-token" },
			{ userBasicInfo: {}, interactions: [], feeds: [] },
			{ user_id: "user-a", xsec_token: "synthetic-token" },
		],
		["list_collections", {}, [], { limit: 20 }],
		[
			"get_collection_content",
			{ collection_id: "board-a" },
			{ notes: [], count: 0, total: 0 },
			{ collection_id: "board-a", limit: 20 },
		],
		["list_saved_content", {}, { feeds: [], count: 0 }, { limit: 20 }],
	] as const;
	for (const [operation, input, result, normalized] of cases) {
		data = result;
		expect(await client.read(operation, input, expected)).toEqual({
			...expected,
			data,
		});
		expect(requests.at(-1)).toEqual({
			path: `/v1/read/${operation}`,
			input: normalized,
		});
	}
	for (const [operation, input] of [
		["list_collections", { limit: 501 }],
		["search_feeds", { keyword: "fixture", filters: { sort_by: "综合|最新" } }],
		["user_profile", { user_id: "user-a", xsec_token: "short" }],
		["user_profile", { user_id: "user\na", xsec_token: "synthetic-token" }],
		["get_feed_detail", { feed_id: "../x", xsec_token: "synthetic-token" }],
	] as const)
		await expect(client.read(operation, input, expected)).rejects.toThrow(
			"private_provider_unavailable",
		);
	expect(requests).toHaveLength(6);
	data = {
		feed_id: "feed-a",
		data: { note: { noteId: "other" }, comments: {} },
	};
	await expect(
		client.read(
			"get_feed_detail",
			{ feed_id: "feed-a", xsec_token: "synthetic-token" },
			expected,
		),
	).rejects.toThrow("private_provider_unavailable");
});

it("reads private feeds only with exact account and provider binding, without widening account replies", async () => {
	const f = frozenFixture();
	const expected = { account: f.frozen.account, upstream: f.frozen.upstream };
	const data = {
		feeds: [
			{
				id: "feed-1",
				xsec_token: "private-synthetic-token",
				title: "x".repeat(12000),
			},
		],
		count: 1,
	};
	let reply: unknown = { ...expected, data };
	const paths: string[] = [];
	const client = await setup(async (req, res) => {
		paths.push(req.url!);
		let body = "";
		for await (const chunk of req) body += chunk;
		expect(body).toBe("{}");
		res.end(JSON.stringify(reply));
	});
	expect(await client.readFeeds(expected)).toEqual({ ...expected, data });
	for (const invalid of [
		{
			...expected,
			account: {
				...expected.account,
				accountEpoch: expected.account.accountEpoch + 1,
			},
			data,
		},
		{
			...expected,
			upstream: { ...expected.upstream, binarySha256: "b".repeat(64) },
			data,
		},
		{ ...expected, data, cookies: "private" },
		{ ...expected, data: { ...data, count: 2 } },
		{
			...expected,
			data: { feeds: [{ id: "feed-1", title: "x".repeat(196608) }], count: 1 },
		},
	]) {
		reply = invalid;
		await expect(client.readFeeds(expected)).rejects.toThrow(
			"private_provider_unavailable",
		);
	}
	expect(paths).toEqual(Array(6).fill("/v1/read/list_feeds"));
	reply = { ...expected, loggedIn: true, padding: "x".repeat(12000) };
	await expect(client.account()).rejects.toThrow(
		"private_provider_unavailable",
	);
});

it("reads only the strict private account projection and rejects secret-bearing extensions", async () => {
	const f = frozenFixture();
	const status = {
		account: f.frozen.account,
		upstream: f.frozen.upstream,
		loggedIn: true,
	};
	let body: unknown = status;
	const client = await setup((req, res) => {
		expect(req.url).toBe("/v1/account");
		req.resume();
		res.end(JSON.stringify(body));
	});
	expect(await client.account()).toEqual(status);
	for (const invalid of [
		{ ...status, cookies: "private" },
		{ ...status, account: { ...status.account, xsec_token: "private" } },
		{ ...status, loggedIn: "yes" },
	]) {
		body = invalid;
		await expect(client.account()).rejects.toThrow(
			"private_provider_unavailable",
		);
	}
});

it("coordinates real ledger consumption, signed HTTP dispatch admission and restart replay", async () => {
	const f = frozenFixture();
	const key = Buffer.alloc(32, 1);
	let prepares = 0,
		mutations = 0;
	const client = await setup(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		if (req.url === "/v1/prepare") {
			prepares++;
			res.end(
				JSON.stringify({
					leaseId: "lease-1",
					accountUserId: f.identity.accountUserId,
					accountEpoch: 1,
					providerGeneration: f.identity.providerGeneration,
					contentDigest: f.digest,
					leaseExpiresAt: NOW + 60000,
				}),
			);
			return;
		}
		const body = JSON.parse(Buffer.concat(chunks).toString());
		const expected = createHmac("sha256", key)
			.update("flywheel:xhs-permit:v1\n")
			.update(canonical(body.permit))
			.digest("hex");
		if (
			body.signature !== expected ||
			!f.store.admitDispatch(
				body.permit,
				f.identity,
				"activation-a",
				"key-1",
				NOW + 3000,
			)
		) {
			res.end('{"state":"denied"}');
			return;
		}
		mutations++;
		res.end('{"state":"succeeded"}');
	});
	const executor = () =>
		new XhsWriteExecutor({
			store: f.store,
			provider: client,
			key,
			now: () => NOW + 3000,
			scope: async () => ({
				identity: f.identity,
				activationId: "activation-a",
				keyId: "key-1",
			}),
			media: () => {
				throw Error("no media");
			},
		});
	const request = {
		proposalId: f.frozen.proposalId,
		receiptId: f.receiptId,
		operationId: f.frozen.operationId,
		contentDigest: f.digest,
		executeRequestId: "execute-1",
	};
	f.prepare();
	expect(await executor().execute(request)).toMatchObject({ kind: "denied" });
	expect(prepares).toBe(0);
	expect(mutations).toBe(0);
	f.approve();
	const first = await executor().execute(request);
	expect(first).toMatchObject({ kind: "attempt", state: "succeeded" });
	f.restart();
	expect(
		await executor().execute({ ...request, executeRequestId: "replayed" }),
	).toEqual(first);
	expect(prepares).toBe(1);
	expect(mutations).toBe(1);
});
async function setup(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
	wrongPeer = false,
) {
	const root = mkdtempSync("/tmp/xhs-client-");
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
	const socketPath = join(root, "provider.sock");
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	});
	return new XhsProviderClient({
		socketPath,
		providerUid: process.getuid!() + (wrongPeer ? 1 : 0),
		peerHelper: {
			path: helper,
			sha256: createHash("sha256").update(readFileSync(helper)).digest("hex"),
		},
		now: () => NOW,
	});
}
function frozenFixture() {
	const f = fixture();
	cleanup.push(async () => f.close());
	return f;
}
it("streams exact frozen content only after kernel peer verification and binds the returned lease", async () => {
	const f = frozenFixture();
	let calls = 0;
	const client = await setup(async (req, res) => {
		calls++;
		expect(req.url).toBe("/v1/prepare");
		expect(req.headers["x-content-digest"]).toBe(f.digest);
		let raw = "";
		for await (const chunk of req) raw += chunk.toString();
		expect(raw).toContain('name="frozen"');
		expect(raw).toContain(f.frozen.proposalId);
		res.end(
			JSON.stringify({
				leaseId: "lease-1",
				accountUserId: f.identity.accountUserId,
				accountEpoch: 1,
				providerGeneration: f.identity.providerGeneration,
				contentDigest: f.digest,
				leaseExpiresAt: NOW + 60000,
			}),
		);
	});
	const lease = await client.prepare(f.frozen, () => {
		throw Error("no-media");
	});
	expect(lease.leaseId).toBe("lease-1");
	expect(calls).toBe(1);
	await expect(
		client.prepare(
			{ ...f.frozen, payload: { ...f.frozen.payload, unlike: null } },
			() => {
				throw Error();
			},
		),
	).rejects.toThrow("private_provider_unavailable");
	expect(calls).toBe(1);
});
it("sends no HTTP body to a wrong Unix principal", async () => {
	const f = frozenFixture();
	let calls = 0;
	const client = await setup((_, res) => {
		calls++;
		res.end("{}");
	}, true);
	await expect(
		client.prepare(f.frozen, () => {
			throw Error();
		}),
	).rejects.toThrow("private_provider_unavailable");
	expect(calls).toBe(0);
});
it("rejects a lease for changed content or account", async () => {
	const f = frozenFixture();
	let changed: Record<string, unknown> = { contentDigest: "f".repeat(64) };
	const client = await setup((req, res) => {
		req.resume();
		res.end(
			JSON.stringify({
				leaseId: "lease-1",
				accountUserId: f.identity.accountUserId,
				accountEpoch: 1,
				providerGeneration: f.identity.providerGeneration,
				contentDigest: f.digest,
				leaseExpiresAt: NOW + 60000,
				...changed,
			}),
		);
	});
	for (const variant of [
		changed,
		{ accountUserId: "other" },
		{ accountEpoch: 2 },
		{ providerGeneration: "other" },
		{ leaseExpiresAt: NOW },
		{ token: "must-not-leak" },
	]) {
		changed = variant;
		await expect(
			client.prepare(f.frozen, () => {
				throw Error();
			}),
		).rejects.toThrow("private_provider_unavailable");
	}
});
it("does not resend a commit after the peer closes without a response", async () => {
	const f = frozenFixture();
	let calls = 0;
	const client = await setup(async (req) => {
		for await (const _ of req) {
		}
		calls++;
		req.socket.destroy();
	});
	const signed = signDispatchPermit(
		{
			audience: f.identity.providerInstanceId,
			proposalId: f.frozen.proposalId,
			receiptId: f.receiptId,
			attemptId: "attempt-1",
			contentDigest: f.digest,
			accountUserId: f.identity.accountUserId,
			accountEpoch: 1,
			providerGeneration: f.identity.providerGeneration,
			leaseId: "lease-1",
			keyId: "key-1",
			approvalExpiresAt: NOW + 60000,
			leaseExpiresAt: NOW + 60000,
		},
		Buffer.alloc(32, 1),
		NOW,
	);
	await expect(client.commit("lease-1", signed)).resolves.toBe("unknown");
	expect(calls).toBe(1);
});
it("accepts only a bounded fixed status projection", async () => {
	let body = '{"state":"unknown"}';
	const client = await setup((req, res) => {
		req.resume();
		res.end(body);
	});
	const query = {
		receiptId: "r",
		attemptId: "a",
		contentDigest: "a".repeat(64),
	};
	expect(await client.status(query)).toBe("unknown");
	for (const bad of [
		'{"state":"succeeded","token":"secret"}',
		'{"state":"unknown","state":"succeeded"}',
		"x".repeat(8193),
	]) {
		body = bad;
		await expect(client.status(query)).rejects.toThrow(
			"private_provider_unavailable",
		);
	}
});
it("hashes each media stream against the frozen artifact bytes", async () => {
	const f = frozenFixture();
	const bytes = Buffer.from("synthetic-media");
	const frozen = {
		...f.frozen,
		operationId: "xiaohongshu.publish_content" as const,
		target: null,
		payload: {
			...f.frozen.payload,
			title: "title",
			content: "body",
			visibility: "仅自己可见" as const,
			isOriginal: false,
			unlike: null,
		},
		media: [
			{
				artifactId: "artifact-1",
				sha256: createHash("sha256").update(bytes).digest("hex"),
				sizeBytes: bytes.length,
				mimeType: "image/png" as const,
			},
		],
	};
	const digest = contentDigest(frozen);
	let received = Buffer.alloc(0);
	let earlyReply = false;
	const client = await setup(async (req, res) => {
		try {
			if (!earlyReply) {
				for await (const chunk of req)
					received = Buffer.concat([received, chunk]);
			} else req.resume();
			res.end(
				JSON.stringify({
					leaseId: "lease-1",
					accountUserId: f.identity.accountUserId,
					accountEpoch: 1,
					providerGeneration: f.identity.providerGeneration,
					contentDigest: digest,
					leaseExpiresAt: NOW + 60000,
				}),
			);
		} catch {}
	});
	await client.prepare(frozen, async function* () {
		yield bytes;
	});
	expect(received.includes(bytes)).toBe(true);
	await expect(
		client.prepare(frozen, async function* () {
			yield Buffer.from("changed-media!!");
		}),
	).rejects.toThrow("private_provider_unavailable");
	earlyReply = true;
	await expect(
		client.prepare(frozen, async function* () {
			await new Promise((resolve) => setTimeout(resolve, 50));
			yield Buffer.from("changed-media!!");
		}),
	).rejects.toThrow("private_provider_unavailable");
	const controller = new AbortController();
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const attempt = client
		.prepare(
			frozen,
			async function* () {
				entered();
				await blocked;
				yield bytes;
			},
			controller.signal,
		)
		.then(
			() => "accepted",
			() => "cancelled",
		);
	try {
		await started;
		await new Promise((resolve) => setTimeout(resolve, 50));
		controller.abort();
		expect(
			await Promise.race([
				attempt,
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("stalled"), 500),
				),
			]),
		).toBe("cancelled");
	} finally {
		release();
		await attempt;
	}
});

it("accepts QR epoch advancement only for the same pinned account and bounded image", async () => {
	const f = frozenFixture();
	const expected = {
		account: { ...f.frozen.account, accountEpoch: 2 },
		upstream: f.frozen.upstream,
	};
	const image =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==";
	const good = {
		...expected,
		account: {
			...expected.account,
			accountEpoch: expected.account.accountEpoch + 1,
		},
		image,
		loggedIn: false,
		expiresAt: NOW + 120000,
	};
	const oversized = Buffer.from(image.split(",")[1], "base64");
	oversized.writeUInt32BE(2049, 16);
	let response: unknown = good;
	const client = await setup(async (req, res) => {
		expect(req.url).toBe("/v1/read/get_login_qrcode");
		let body = "";
		for await (const chunk of req) body += chunk;
		expect(body).toBe("{}");
		res.end(JSON.stringify(response));
	});
	expect(await client.loginQR(expected)).toEqual(good);
	for (const invalid of [
		{ ...good, account: { ...good.account, accountEpoch: 1 } },
		{ ...good, account: { ...good.account, accountUserId: "other" } },
		{ ...good, upstream: { ...good.upstream, binarySha256: "c".repeat(64) } },
		{ ...good, image: "https://example.test/qr.png" },
		{ ...good, image: "data:image/png;base64,bm90LXBuZw==" },
		{ ...good, image: `${image}\n` },
		{ ...good, image: `data:image/png;base64,${oversized.toString("base64")}` },
		{ ...good, image: `data:image/png;base64,${"A".repeat(530000)}` },
		{ ...good, expiresAt: NOW },
		{ ...good, expiresAt: NOW + 240001 },
		{ ...good, loggedIn: true },
		{ ...good, cookie: "secret" },
	]) {
		response = invalid;
		await expect(client.loginQR(expected)).rejects.toThrow(
			"private_provider_unavailable",
		);
	}
	response = { ...good, image: "", loggedIn: true, expiresAt: 0 };
	expect(await client.loginQR(expected)).toEqual(response);
});
