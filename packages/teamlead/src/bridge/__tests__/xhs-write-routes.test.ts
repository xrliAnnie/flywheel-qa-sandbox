import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { createXhsWriteRouter } from "../xhs-write-routes.js";

const state = vi.hoisted(() => ({
	calls: [] as { action: string; input: unknown }[],
	current: true,
	checks: 0,
	drift: false,
	response: {} as unknown,
	artifact: {} as unknown,
}));
vi.mock("../xhs-write-context.js", () => ({
	createXhsWriteContext: (header: unknown) => {
		if (header !== "fixture-identity") throw Error("private-identity");
		return {
			scope: {
				projectId: "project",
				leadId: "lead",
				activationId: "activation",
			},
			assertCurrent: () => {
				state.checks++;
				if (!state.current) throw Error("private-identity");
			},
		};
	},
}));
vi.mock("../../xiaohongshu-write/parent-client-policy.js", () => ({
	createBridgeXhsWriteClient: () => ({
		async call(action: string, input: unknown) {
			state.calls.push({ action, input });
			if (state.drift) state.current = false;
			return state.response;
		},
		async importArtifact() {
			return state.artifact;
		},
	}),
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
	state.calls = [];
	state.current = true;
	state.checks = 0;
	state.drift = false;
});
async function setup(apiToken = "test-token") {
	const data = Buffer.from("controlled-media");
	const sha256 = createHash("sha256").update(data).digest("hex");
	state.artifact = {
		artifactId: randomUUID(),
		sha256,
		sizeBytes: data.length,
		mimeType: "image/png",
	};
	const app = express();
	app.use(
		createXhsWriteRouter({
			apiToken,
			env: {},
			artifacts: (scope) => ({
				read: async (handle: string) => {
					expect(scope).toEqual({
						projectId: "project",
						leadId: "lead",
						activationId: "activation",
					});
					if (handle !== "owned") throw Error("private-file");
					return {
						data,
						artifact: {
							handle,
							relativePath: "private.png",
							size: data.length,
							mimeType: "image/png",
							sha256,
						},
					};
				},
			}),
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lead/xiaohongshu/write/`;
	const call = async (
		action: string,
		input: unknown,
		token = "test-token",
		raw?: string,
	) => {
		const response = await fetch(root + action, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"x-flywheel-lead-context": "fixture-identity",
			},
			body:
				raw ??
				JSON.stringify({
					requestId: "12345678-1234-4234-8234-123456789012",
					input,
				}),
		});
		return { status: response.status, body: await response.json() };
	};
	return { call };
}
it("imports controlled handles and forwards only frozen prepare inputs", async () => {
	const s = await setup();
	state.response = {
		proposalId: randomUUID(),
		contentDigest: "a".repeat(64),
		expiresAt: Date.now() + 10000,
		state: "awaiting_approval",
		cardRef: null,
	};
	const input = {
		operationId: "xiaohongshu.publish_content",
		accountSelector: "account",
		payload: { title: "title", content: "body" },
		artifactHandles: ["owned"],
	};
	expect((await s.call("prepare", input)).status).toBe(200);
	expect(state.calls).toEqual([
		{
			action: "prepare",
			input: {
				prepareRequestId: "12345678-1234-4234-8234-123456789012",
				operationId: input.operationId,
				accountSelector: "account",
				payload: {
					...input.payload,
					tags: [],
					visibility: null,
					isOriginal: null,
					scheduleAt: null,
					unlike: null,
					unfavorite: null,
				},
				artifactIds: [(state.artifact as { artifactId: string }).artifactId],
				targetHandle: null,
			},
		},
	]);
	state.calls = [];
	expect(
		(await s.call("prepare", { ...input, artifactHandles: ["unknown"] }))
			.status,
	).toBe(503);
	expect(state.calls).toEqual([]);
});
it("uses fixed execute/status/cancel shapes and suppresses success after identity drift", async () => {
	const s = await setup();
	const proposalId = randomUUID();
	state.response = {
		kind: "attempt",
		attemptId: randomUUID(),
		state: "succeeded",
	};
	const input = {
		proposalId,
		receiptId: randomUUID(),
		expectedContentDigest: "a".repeat(64),
		operationId: "xiaohongshu.like_feed",
	};
	expect((await s.call("execute", input)).status).toBe(200);
	expect(state.calls[0]?.input).toMatchObject({
		proposalId,
		contentDigest: input.expectedContentDigest,
		executeRequestId: "12345678-1234-4234-8234-123456789012",
	});
	state.response = {
		proposalId,
		contentDigest: "a".repeat(64),
		state: "approved",
		expiresAt: Date.now() + 10000,
		attempt: null,
	};
	expect((await s.call("status", { proposalId })).status).toBe(200);
	state.response = { state: "revoked" };
	expect((await s.call("cancel", { proposalId })).status).toBe(200);
	state.drift = true;
	expect(await s.call("cancel", { proposalId })).toEqual({
		status: 503,
		body: { code: "xhs_result_unknown" },
	});
});
it("authenticates before parsing and rejects duplicate JSON without an authority call", async () => {
	const s = await setup();
	expect((await s.call("execute", {}, "wrong", "{")).status).toBe(401);
	expect(
		(
			await s.call(
				"execute",
				{},
				"test-token",
				'{"requestId":"x","requestId":"y","input":{}}',
			)
		).status,
	).toBe(400);
	expect(state.calls).toEqual([]);
	const disabled = await setup("");
	expect((await disabled.call("execute", {}, "test-token", "{")).status).toBe(
		503,
	);
	expect(state.calls).toEqual([]);
});

it("rejects an imported artifact digest mismatch and a secret-bearing authority response", async () => {
	const s = await setup();
	state.artifact = { ...(state.artifact as object), sha256: "f".repeat(64) };
	expect(
		(
			await s.call("prepare", {
				operationId: "xiaohongshu.publish_content",
				accountSelector: "account",
				payload: { title: "t", content: "c" },
				artifactHandles: ["owned"],
			})
		).status,
	).toBe(503);
	expect(state.calls).toEqual([]);
	const proposalId = randomUUID();
	state.response = {
		proposalId,
		contentDigest: "a".repeat(64),
		state: "approved",
		expiresAt: Date.now() + 10000,
		attempt: null,
		xsec_token: "private",
	};
	expect(await s.call("status", { proposalId })).toEqual({
		status: 503,
		body: { code: "xhs_result_unknown" },
	});
});
