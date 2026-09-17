import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { createXhsReadRouter } from "../xhs-read-routes.js";

const state = vi.hoisted(() => ({
	current: true,
	drift: false,
	calls: [] as { action: string; input: unknown }[],
	output: {} as unknown,
}));
vi.mock("../xhs-write-context.js", () => ({
	createXhsWriteContext: () => ({
		scope: { projectId: "project", leadId: "lead", activationId: "activation" },
		assertCurrent: () => {
			if (!state.current) throw Error("private");
		},
	}),
}));
vi.mock("../../xiaohongshu-write/parent-client-policy.js", () => ({
	createBridgeXhsWriteClient: (options: { scope: unknown }) => {
		expect(options.scope).toEqual({
			projectId: "project",
			leadId: "lead",
			activationId: "activation",
		});
		return {
			async call(action: string, input: unknown) {
				state.calls.push({ action, input });
				if (state.drift) state.current = false;
				return state.output;
			},
		};
	},
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
	state.current = true;
	state.drift = false;
	state.calls = [];
});
async function setup() {
	const app = express();
	app.use(createXhsReadRouter({ apiToken: "token", env: {} }));
	app.use(express.json());
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return async (
		action: string,
		input: unknown,
		token = "token",
		raw?: string,
	) => {
		const res = await fetch(
			`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lead/xiaohongshu/read/${action}`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: raw ?? JSON.stringify({ requestId: randomUUID(), input }),
			},
		);
		return {
			status: res.status,
			body: res.status === 404 ? null : await res.json(),
		};
	};
}
it("routes all eight existing public reads with the same activation scope as prepare", async () => {
	const call = await setup();
	for (const [action, input] of [
		["list_feeds", {}],
		["search_feeds", { keyword: "query" }],
		["list_saved_content", {}],
		["list_collections", {}],
		["get_collection_content", { collection_id: "collection" }],
		["get_feed_detail", { feed_id: "feed", resourceHandle: randomUUID() }],
		["check_login_status", {}],
		["get_login_qrcode", {}],
	] as const) {
		state.output =
			action === "check_login_status"
				? { loggedIn: false }
				: action === "get_login_qrcode"
					? { loggedIn: true, image: "", expiresAt: 0 }
					: { text: '{"resourceHandle":"observed"}' };
		expect(await call(action, input)).toEqual({
			status: 200,
			body: state.output,
		});
	}
	expect(state.calls).toHaveLength(8);
	expect((await call("user_profile", {})).status).toBe(404);
	expect((await call("execute", {})).status).toBe(404);
});
it("rejects forged token inputs and malformed requests before contacting authority", async () => {
	const call = await setup();
	expect((await call("list_feeds", {}, "wrong", "{")).status).toBe(401);
	expect(
		(await call("list_feeds", {}, "token", '{"input":{},"input":{}}')).status,
	).toBe(400);
	expect(
		(
			await call("get_feed_detail", {
				feed_id: "feed",
				resourceHandle: randomUUID(),
				xsec_token: "private",
			})
		).status,
	).toBe(400);
	expect(state.calls).toEqual([]);
});
it("suppresses invalid responses and success after current identity changes", async () => {
	const call = await setup();
	state.output = { text: "data", xsec_token: "private" };
	expect(await call("list_feeds", {})).toEqual({
		status: 503,
		body: { code: "xhs_read_unavailable" },
	});
	state.output = { text: "data" };
	state.drift = true;
	expect((await call("list_feeds", {})).status).toBe(503);
});
