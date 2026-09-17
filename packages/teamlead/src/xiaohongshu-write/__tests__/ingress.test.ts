import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { XhsWriteExecutor } from "../executor.js";
import { createWriteIngressHandler } from "../ingress.js";
import { fixture, NOW } from "./store-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(wrongPeer = false) {
	const f = fixture(process.getuid!());
	f.approve();
	const root = mkdtempSync("/tmp/xhs-ingress-");
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
		scopes: 0,
		purpose: undefined as "read" | "write" | undefined,
		executes: 0,
		prepares: 0,
		providerPrepares: 0,
		commits: 0,
		selection: null as unknown,
		preparedInput: null as unknown,
		reads: 0,
		listInput: null as unknown,
	};
	const handler = createWriteIngressHandler({
		modelUid: process.getuid!() + (wrongPeer ? 1 : 0),
		peerHelper: {
			path: helper,
			sha256: createHash("sha256").update(readFileSync(helper)).digest("hex"),
		},
		store: f.store,
		readLogin: async (_context, action) =>
			action === "check_login_status"
				? { loggedIn: false }
				: { loggedIn: true, image: "", expiresAt: 0 },
		readDetail: async (context, input) => {
			expect(context.activationId).toBe("activation-a");
			state.reads++;
			state.listInput = { action: "get_feed_detail", input };
			return "{}";
		},
		readList: async (context, action, input) => {
			expect(context.activationId).toBe("activation-a");
			state.reads++;
			state.listInput = { action, input };
			return "{}";
		},
		readFeeds: async (context) => {
			expect(context.activationId).toBe("activation-a");
			state.reads++;
			return '{"feeds":[],"count":0}';
		},
		now: () => NOW + 3000,
		scope: async (_peerUid, selection, _signal, purpose) => {
			state.purpose = purpose;
			state.selection = selection;
			state.scopes++;
			return {
				identity: { ...f.identity, requesterUid: process.getuid!() },
				activationId: "activation-a",
			};
		},
		preparation: {
			async prepare(_peer, input) {
				state.preparedInput = input;
				state.prepares++;
				throw Error("synthetic-private-token");
			},
		},
		executor: (context) => {
			state.executes++;
			return new XhsWriteExecutor({
				store: f.store,
				now: () => NOW + 3000,
				key: Buffer.alloc(32, 1),
				scope: async () => ({ ...context, keyId: "key-1" }),
				media: () => {
					throw Error("no media");
				},
				provider: {
					async prepare() {
						state.providerPrepares++;
						return {
							leaseId: "lease-1",
							accountUserId: f.identity.accountUserId,
							accountEpoch: f.identity.accountEpoch,
							providerGeneration: f.identity.providerGeneration,
							contentDigest: f.digest,
							leaseExpiresAt: NOW + 60000,
						};
					},
					async commit() {
						state.commits++;
						expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
							"consumed",
						);
						return "succeeded";
					},
				},
			});
		},
	});
	const server = createServer(handler);
	const socketPath = join(root, "ingress.sock");
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		f.close();
		rmSync(root, { recursive: true, force: true });
	});
	const call = (path: string, body: unknown) =>
		new Promise<{ status: number; body: Record<string, unknown> }>(
			(resolve, reject) => {
				const req = request(
					{
						socketPath,
						path,
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-peer-uid": String(process.getuid!()),
						},
					},
					(res) => {
						let text = "";
						res.on("data", (chunk) => {
							text += chunk;
						});
						res.on("end", () =>
							resolve({ status: res.statusCode!, body: JSON.parse(text) }),
						);
					},
				);
				req.on("error", reject);
				req.end(JSON.stringify(body));
			},
		);
	const envelope = {
		projectId: f.identity.projectId,
		leadId: f.identity.leadId,
		activationId: "activation-a",
		input: { proposalId: f.frozen.proposalId },
	};
	return { f, state, call, envelope };
}
it("serves scoped real status and cancel without exposing receipt/key material", async () => {
	const s = await setup();
	const status = await s.call("/v1/write/status", s.envelope);
	expect(status.status).toBe(200);
	expect(status.body.state).toBe("approved");
	expect(Object.keys(status.body).sort()).toEqual([
		"attempt",
		"contentDigest",
		"expiresAt",
		"proposalId",
		"state",
	]);
	expect(await s.call("/v1/write/cancel", s.envelope)).toEqual({
		status: 200,
		body: { state: "revoked" },
	});
	expect(s.state.executes).toBe(0);
});
it("rejects claimed header identity, private routes, scope replacement and extra authority fields", async () => {
	const s = await setup(true);
	expect((await s.call("/v1/write/status", s.envelope)).status).toBe(403);
	expect(s.state.scopes).toBe(0);
	const t = await setup();
	for (const [path, body] of [
		["/internal/v1/provider-admission", t.envelope],
		["/v1/write/mint", t.envelope],
		["/v1/write/status", { ...t.envelope, projectId: "other" }],
		["/v1/write/status", { ...t.envelope, activationId: "old" }],
		["/v1/write/status", { ...t.envelope, approved: true }],
		[
			"/v1/write/status",
			{ ...t.envelope, input: { ...t.envelope.input, identity: t.f.identity } },
		],
	] as const)
		expect((await t.call(path, body)).status).toBe(403);
	expect(t.state.executes).toBe(0);
});
it("serves only scoped empty-input feed reads without invoking writes", async () => {
	const s = await setup();
	expect(
		await s.call("/v1/read/list_feeds", { ...s.envelope, input: {} }),
	).toEqual({ status: 200, body: { text: '{"feeds":[],"count":0}' } });
	expect(
		(
			await s.call("/v1/read/list_feeds", {
				...s.envelope,
				input: { xsec_token: "forged" },
			})
		).status,
	).toBe(403);
	expect(s.state.reads).toBe(1);
	expect(s.state.prepares + s.state.executes + s.state.commits).toBe(0);
});
it("keeps preparation errors private and prevents draft scope injection", async () => {
	const s = await setup();
	const reply = await s.call("/v1/write/prepare", {
		...s.envelope,
		input: { projectId: "other" },
	});
	expect(reply.status).toBe(403);
	expect(s.state.prepares).toBe(0);
	const failed = await s.call("/v1/write/prepare", {
		...s.envelope,
		input: { prepareRequestId: "draft-request" },
	});
	expect(failed).toEqual({
		status: 403,
		body: { code: "write_ingress_denied" },
	});
	expect(s.state.prepares).toBe(1);
	expect(s.state.preparedInput).toMatchObject({ activationId: "activation-a" });
	await s.call("/v1/write/prepare", {
		...s.envelope,
		input: { activationId: "forged" },
	});
	expect(s.state.prepares).toBe(1);
});

it("carries the exact request through real executor and consumes once before provider dispatch", async () => {
	const s = await setup();
	const valid = {
		...s.envelope,
		input: {
			proposalId: s.f.frozen.proposalId,
			receiptId: s.f.receiptId,
			operationId: s.f.frozen.operationId,
			contentDigest: s.f.digest,
			executeRequestId: "execute-1",
		},
	};
	expect((await s.call("/v1/write/execute", s.envelope)).body.kind).toBe(
		"denied",
	);
	expect(s.state.providerPrepares).toBe(0);
	const first = await s.call("/v1/write/execute", valid);
	expect(first.body).toMatchObject({ kind: "attempt", state: "succeeded" });
	expect(
		await s.call("/v1/write/execute", {
			...valid,
			input: { ...valid.input, executeRequestId: "replay" },
		}),
	).toEqual(first);
	expect(s.state).toMatchObject({ providerPrepares: 1, commits: 1 });
});
it("binds recovery status to the original receipt, digest and frozen operation", async () => {
	const s = await setup();
	const input = {
		proposalId: s.f.frozen.proposalId,
		receiptId: s.f.receiptId,
		contentDigest: s.f.digest,
		operationId: s.f.frozen.operationId,
	};
	expect(
		(await s.call("/v1/write/status", { ...s.envelope, input })).status,
	).toBe(200);
	for (const change of [
		{ receiptId: "00000000-0000-4000-8000-000000000001" },
		{ contentDigest: "f".repeat(64) },
		{ operationId: "xiaohongshu.favorite_feed" },
	])
		expect(
			(
				await s.call("/v1/write/status", {
					...s.envelope,
					input: { ...input, ...change },
				})
			).status,
		).toBe(403);
	expect(s.state).toMatchObject({
		executes: 0,
		providerPrepares: 0,
		commits: 0,
	});
	const execution = await s.call("/v1/write/execute", {
		...s.envelope,
		input: { ...input, executeRequestId: "execute-before-recovery" },
	});
	expect(execution.body).toMatchObject({ kind: "attempt", state: "succeeded" });
	s.f.store.setDispatchEnabled(false, NOW + 4000);
	const recovered = await s.call("/v1/write/status", { ...s.envelope, input });
	expect(recovered).toMatchObject({
		status: 200,
		body: {
			proposalId: input.proposalId,
			contentDigest: input.contentDigest,
			state: "consumed",
			attempt: { attemptId: execution.body.attemptId, state: "succeeded" },
		},
	});
	expect(s.state).toMatchObject({
		executes: 1,
		providerPrepares: 1,
		commits: 1,
	});
});

it("recovers a prepared request through status without preparing again", async () => {
	const s = await setup();
	const recovered = await s.call("/v1/write/status", {
		...s.envelope,
		input: { prepareRequestId: "prepare-a" },
	});
	expect(recovered).toMatchObject({
		status: 200,
		body: {
			proposalId: s.f.frozen.proposalId,
			contentDigest: s.f.digest,
			state: "approved",
		},
	});
	expect(Object.keys(recovered.body).sort()).toEqual([
		"cardRef",
		"contentDigest",
		"expiresAt",
		"proposalId",
		"state",
	]);
	expect(s.state).toMatchObject({
		prepares: 0,
		executes: 0,
		providerPrepares: 0,
		commits: 0,
	});
	expect(
		(
			await s.call("/v1/write/status", {
				...s.envelope,
				input: { prepareRequestId: "missing" },
			})
		).status,
	).toBe(403);
	expect(
		(
			await s.call("/v1/write/status", {
				...s.envelope,
				input: {
					prepareRequestId: "prepare-a",
					proposalId: s.f.frozen.proposalId,
				},
			})
		).status,
	).toBe(403);
});
it("passes activation attribution to the root scope resolver without accepting a replacement", async () => {
	const s = await setup();
	expect((await s.call("/v1/write/status", s.envelope)).status).toBe(200);
	expect(s.state.selection).toEqual({
		projectId: s.envelope.projectId,
		leadId: s.envelope.leadId,
		activationId: "activation-a",
	});
	expect(
		(
			await s.call("/v1/write/status", {
				...s.envelope,
				activationId: "replacement",
			})
		).status,
	).toBe(403);
	expect(s.state.executes).toBe(0);
});

it("admits only fixed token-free list and detail operations without entering write execution", async () => {
	const s = await setup();
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
		expect(
			await s.call(`/v1/read/${action}`, { ...s.envelope, input }),
		).toEqual({ status: 200, body: { text: "{}" } });
		expect(s.state.purpose).toBe("read");
		expect(s.state.listInput).toMatchObject({
			action,
			input: { ...input, limit: 20 },
		});
		const reads = s.state.reads;
		expect(
			(
				await s.call(`/v1/read/${action}`, {
					...s.envelope,
					input: { ...input, xsec_token: "forged" },
				})
			).status,
		).toBe(403);
		expect(s.state.reads).toBe(reads);
	}
	expect(s.state.executes).toBe(0);
	expect(s.state.prepares).toBe(0);
});

it("does not accept a model claim of read scope on a write route", async () => {
	const s = await setup();
	await s.call("/v1/write/status", s.envelope);
	expect(s.state.purpose).toBe("write");
	const scopes = s.state.scopes;
	expect(
		(await s.call("/v1/write/status", { ...s.envelope, purpose: "read" }))
			.status,
	).toBe(403);
	expect(s.state.scopes).toBe(scopes);
});

it("serves login projections through read scope and rejects caller credentials", async () => {
	const s = await setup();
	for (const action of ["check_login_status", "get_login_qrcode"]) {
		const result = await s.call(`/v1/read/${action}`, {
			...s.envelope,
			input: {},
		});
		expect(result.status).toBe(200);
		expect(s.state.purpose).toBe("read");
		expect(result.body).not.toHaveProperty("account");
		expect(
			(
				await s.call(`/v1/read/${action}`, {
					...s.envelope,
					input: { cookie: "forged" },
				})
			).status,
		).toBe(403);
	}
	expect(s.state.executes).toBe(0);
	expect(s.state.prepares).toBe(0);
});
