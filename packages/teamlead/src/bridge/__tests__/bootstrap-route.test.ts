import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createBootstrapReadRouter } from "../bootstrap-route.js";

let store: StateStore;
beforeEach(async () => {
	store = await StateStore.create(":memory:");
});
afterEach(() => store.close());

async function request(
	path: string,
	token = "master",
	apiToken: string | undefined = "master",
) {
	const app = express();
	app.use(
		"/api/bootstrap",
		createBootstrapReadRouter({
			store,
			projects: [
				{
					projectName: "bootstrap-route-test",
					projectRoot: "/tmp",
					leads: [{ agentId: "lead", match: { labels: [] } }],
				},
			],
			apiToken,
			geminiAgentToken: "gemini",
		}),
	);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const response = await fetch(
			`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bootstrap/${path}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		return { status: response.status, body: await response.json() };
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

it("requires configured master credentials before returning recovery content", async () => {
	expect(
		(await request("lead/questions?kind=ask&limit=1", "gemini")).status,
	).toBe(403);
	expect(
		(await request("lead/questions?kind=ask&limit=1", "external")).status,
	).toBe(401);
	expect(
		(await request("lead/questions?kind=ask&limit=1", "master", "")).status,
	).toBe(503);
	expect((await request("unknown/questions?kind=ask&limit=1")).status).toBe(
		404,
	);
});
it("validates page input and provides bounded recovery state without dispatch", async () => {
	for (const query of [
		"kind=oops",
		"kind=ask&limit=51",
		"kind=ask&limit=1.5",
		"kind=ask&cursor=bad",
		"kind=ask&cursor=%7B%7D",
	]) {
		expect((await request(`lead/questions?${query}`)).status).toBe(400);
	}
	const result = await request("lead/questions?kind=ask&limit=1");
	expect(result.status).toBe(200);
	expect(result.body.items).toEqual([]);
	expect(result.body.nextCursor).toBeNull();
	const state = await request("lead/sections?kind=activeSessions&limit=1");
	expect(state.status).toBe(200);
	expect(state.body.items).toEqual([]);
	expect(
		(await request("lead/sections?kind=activeSessions&cursor=-1")).status,
	).toBe(400);
});

it("pages audit-only history without delivering it or exposing another Lead", async () => {
	const first = store.appendLeadEvent(
		"lead",
		"audit-1",
		"stage_changed",
		'{"stage":"test"}',
		undefined,
		"audit_only",
	);
	store.appendLeadEvent(
		"other",
		"private",
		"stage_changed",
		"{}",
		undefined,
		"audit_only",
	);
	const second = store.appendLeadEvent(
		"lead",
		"audit-2",
		"stage_changed",
		"{}",
		undefined,
		"audit_only",
	);
	const model = store.appendLeadEvent("lead", "action", "session_failed", "{}");
	const page = await request("lead/audit-events?limit=1");
	expect(page.status).toBe(200);
	expect(page.body.items.map((row: { seq: number }) => row.seq)).toEqual([
		second,
	]);
	expect(page.body.nextCursor).toBe(String(second));
	const next = await request(
		`lead/audit-events?limit=1&cursor=${page.body.nextCursor}`,
	);
	expect(next.body.items.map((row: { seq: number }) => row.seq)).toEqual([
		first,
	]);
	expect(next.body.nextCursor).toBeNull();
	expect(store.getLeadEventBySeq(first)?.delivered_at).toBeUndefined();
	expect(store.listUndeliveredLeadEvents().map((row) => row.seq)).toEqual([
		model,
	]);
	expect((await request("lead/audit-events", "gemini")).status).toBe(403);
	expect((await request("lead/audit-events?cursor=-1")).status).toBe(400);
});
