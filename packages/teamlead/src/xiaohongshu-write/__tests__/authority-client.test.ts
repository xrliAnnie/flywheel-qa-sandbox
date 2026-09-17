import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { XhsAuthorityClient } from "../authority-client.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
async function setup(wrongPeer = false, expectedUid?: number) {
	const root = mkdtempSync("/tmp/xhs-public-client-");
	const helper = join(root, "peer"),
		socketPath = join(root, "authority.sock");
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
		calls: 0,
		checks: 0,
		rejectCheck: 0,
		raw: {} as unknown,
		close: false,
		leak: false,
		prepared: false,
		path: "",
		feedText: null as string | null,
		login: null as unknown,
		artifact: null as unknown,
	};
	const reply = {
		proposalId: randomUUID(),
		contentDigest: "a".repeat(64),
		state: "approved",
		expiresAt: Date.now() + 10000,
		attempt: null,
	};
	const server = createServer(async (req, res) => {
		state.path = req.url ?? "";
		state.calls++;
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const raw = Buffer.concat(chunks);
		state.raw = req.headers["x-flywheel-artifact"]
			? {
					metadata: JSON.parse(
						Buffer.from(
							String(req.headers["x-flywheel-artifact"]),
							"base64",
						).toString("utf8"),
					),
					data: raw,
				}
			: JSON.parse(raw.toString("utf8"));
		if (state.close) {
			req.socket.destroy();
			return;
		}
		res.setHeader("content-type", "application/json");
		const response =
			state.artifact !== null
				? state.artifact
				: state.login !== null
					? state.login
					: state.feedText !== null
						? { text: state.feedText }
						: state.prepared
							? {
									proposalId: reply.proposalId,
									contentDigest: reply.contentDigest,
									state: reply.state,
									expiresAt: reply.expiresAt,
									cardRef: null,
								}
							: reply;
		res.end(
			JSON.stringify(
				state.leak ? { ...response, xsec_token: "synthetic-secret" } : response,
			),
		);
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	});
	const scope = {
		projectId: "project-1",
		leadId: "lead-1",
		activationId: "activation-1",
	};
	const client = new XhsAuthorityClient({
		socketPath,
		authorityUid: expectedUid ?? process.getuid!() + (wrongPeer ? 1 : 0),
		peerHelper: {
			path: helper,
			sha256: createHash("sha256").update(readFileSync(helper)).digest("hex"),
		},
		scope,
		assertCurrent: async () => {
			if (++state.checks === state.rejectCheck) throw Error("stale carrier");
		},
	});
	return { client, state, reply, scope };
}
it("reads feed projections only through the fixed authority route and empty input", async () => {
	const s = await setup();
	s.state.feedText = JSON.stringify({
		feeds: [
			{ id: "feed-a", title: "x".repeat(100000), resourceHandle: randomUUID() },
		],
		count: 1,
	});
	expect(await s.client.call("list_feeds", {})).toEqual({
		text: s.state.feedText,
	});
	expect(s.state.path).toBe("/v1/read/list_feeds");
	expect(s.state.checks).toBe(3);
	await expect(
		s.client.call("list_feeds", { xsec_token: "forged" }),
	).rejects.toThrow("authority_request_unavailable");
	expect(s.state.calls).toBe(1);
	s.state.leak = true;
	await expect(s.client.call("list_feeds", {})).rejects.toThrow(
		"authority_request_unavailable",
	);
});
it("sends only the parent scope after peer/current checks and accepts strict status projection", async () => {
	const s = await setup();
	const original = { ...s.scope };
	s.scope.activationId = "mutated";
	expect(
		await s.client.call("status", { proposalId: s.reply.proposalId }),
	).toEqual(s.reply);
	expect(s.state.raw).toEqual({
		...original,
		input: { proposalId: s.reply.proposalId },
	});
	expect(s.state.checks).toBe(3);
});
it("sends no HTTP to a wrong UID or after activation fails before dispatch", async () => {
	const wrong = await setup(true);
	await expect(wrong.client.call("status", {})).rejects.toThrow(
		"authority_request_unavailable",
	);
	expect(wrong.state.calls).toBe(0);
	const stale = await setup();
	stale.state.rejectCheck = 2;
	await expect(stale.client.call("status", {})).rejects.toThrow(
		"authority_request_unavailable",
	);
	expect(stale.state.calls).toBe(0);
});
it("does not retry on uncertain execution and never returns secret-bearing extensions", async () => {
	const s = await setup();
	s.state.close = true;
	await expect(s.client.call("execute", {})).rejects.toThrow(
		"authority_request_unavailable",
	);
	expect(s.state.calls).toBe(1);
	s.state.close = false;
	s.state.leak = true;
	await expect(s.client.call("status", {})).rejects.toThrow(
		"authority_request_unavailable",
	);
	expect(s.state.calls).toBe(2);
});
it("accepts preparation recovery only on the fixed status route", async () => {
	const s = await setup();
	s.state.prepared = true;
	expect(
		await s.client.call("status", { prepareRequestId: "original-request" }),
	).toMatchObject({ proposalId: s.reply.proposalId, cardRef: null });
	expect(s.state.path).toBe("/v1/write/status");
	expect(s.state.calls).toBe(1);
	s.state.leak = true;
	await expect(
		s.client.call("status", { prepareRequestId: "original-request" }),
	).rejects.toThrow("authority_request_unavailable");
});

it("routes list and detail reads through the authority and rejects raw tokens before sending", async () => {
	const s = await setup();
	s.state.feedText = "{}";
	for (const [action, input] of [
		["search_feeds", { keyword: "query" }],
		["list_saved_content", {}],
		["list_collections", {}],
		["get_collection_content", { collection_id: "collection-a" }],
		[
			"get_feed_detail",
			{
				feed_id: "feed-a",
				resourceHandle: "00000000-0000-4000-8000-000000000001",
			},
		],
	] as const) {
		expect(await s.client.call(action, input)).toEqual({ text: "{}" });
		expect(s.state.path).toBe(`/v1/read/${action}`);
		const calls = s.state.calls;
		await expect(
			s.client.call(action, { ...input, xsec_token: "forged" }),
		).rejects.toThrow("authority_request_unavailable");
		expect(s.state.calls).toBe(calls);
	}
});

it("routes login reads with strict input and projection", async () => {
	const s = await setup();
	for (const action of ["check_login_status", "get_login_qrcode"] as const) {
		s.state.login =
			action === "check_login_status"
				? { loggedIn: false }
				: { loggedIn: true, image: "", expiresAt: 0 };
		expect(await s.client.call(action, {})).toEqual(s.state.login);
		expect(s.state.path).toBe(`/v1/read/${action}`);
		const count = s.state.calls;
		await expect(s.client.call(action, { cookie: "forged" })).rejects.toThrow(
			"authority_request_unavailable",
		);
		expect(s.state.calls).toBe(count);
		s.state.leak = true;
		await expect(s.client.call(action, {})).rejects.toThrow(
			"authority_request_unavailable",
		);
		s.state.leak = false;
	}
});

it("receives QR images only while their display window is valid", async () => {
	const s = await setup();
	const image =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==";
	s.state.login = { loggedIn: false, image, expiresAt: Date.now() + 60000 };
	expect(await s.client.call("get_login_qrcode", {})).toEqual(s.state.login);
	for (const expiresAt of [Date.now() - 1, Date.now() + 300000]) {
		s.state.login = { loggedIn: false, image, expiresAt };
		await expect(s.client.call("get_login_qrcode", {})).rejects.toThrow(
			"authority_request_unavailable",
		);
	}
});

it("uploads a frozen copy of bounded artifact bytes only after peer/current checks and verifies the returned identity", async () => {
	const s = await setup();
	const bytes = Buffer.from([0x89, 0x50, 0, 0xff]);
	const original = Buffer.from(bytes);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const artifact = {
		artifactId: randomUUID(),
		mimeType: "image/png",
		sizeBytes: bytes.length,
		sha256,
	};
	s.state.artifact = artifact;
	const uploading = s.client.importArtifact({
		data: bytes,
		mimeType: "image/png",
	});
	bytes.fill(0);
	expect(await uploading).toEqual(artifact);
	expect(s.state.path).toBe("/v1/artifact/import");
	expect(s.state.raw).toEqual({
		metadata: {
			...s.scope,
			mimeType: "image/png",
			sizeBytes: original.length,
			sha256,
		},
		data: original,
	});
	expect(s.state.checks).toBe(3);
	s.state.artifact = { ...artifact, sha256: "0".repeat(64) };
	await expect(
		s.client.importArtifact({ data: original, mimeType: "image/png" }),
	).rejects.toThrow("authority_request_unavailable");
	const before = s.state.calls;
	for (const input of [
		{ data: Buffer.alloc(0), mimeType: "image/png" },
		{ data: Buffer.alloc(10 * 1024 * 1024 + 1), mimeType: "image/png" },
		{ data: original, mimeType: "image/png", path: "/tmp/path" },
	])
		await expect(s.client.importArtifact(input)).rejects.toThrow(
			"authority_request_unavailable",
		);
	expect(s.state.calls).toBe(before);
	const wrong = await setup(true);
	await expect(
		wrong.client.importArtifact({ data: original, mimeType: "image/png" }),
	).rejects.toThrow("authority_request_unavailable");
	expect(wrong.state.calls).toBe(0);
});

it("accepts a root listener pin but sends no HTTP to a user-owned listener", async () => {
	expect(process.getuid!()).toBeGreaterThan(0);
	const s = await setup(false, 0);
	await expect(s.client.call("list_feeds", {})).rejects.toThrow(
		"authority_request_unavailable",
	);
	expect(s.state.calls).toBe(0);
});
