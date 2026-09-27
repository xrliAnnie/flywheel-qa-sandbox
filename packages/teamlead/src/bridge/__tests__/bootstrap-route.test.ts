import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createBootstrapReadRouter } from "../bootstrap-route.js";

let store: StateStore;
beforeEach(async () => {
	store = await StateStore.create(":memory:");
});
afterEach(() => {
	vi.restoreAllMocks();
	store.close();
});

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
		'{"stage":"test","project_name":"bootstrap-route-test"}',
		undefined,
		"audit_only",
	);
	store.appendLeadEvent(
		"other",
		"private",
		"stage_changed",
		'{"project_name":"bootstrap-route-test"}',
		undefined,
		"audit_only",
	);
	const second = store.appendLeadEvent(
		"lead",
		"audit-2",
		"stage_changed",
		'{"project_name":"bootstrap-route-test"}',
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

it("binds audit range reads to the configured project and exact requested generation", async () => {
	const epoch = "00000000-0000-4000-8000-000000000000";
	const read = vi.spyOn(store, "getLeadAuditEventPage").mockReturnValue({
		items: [],
		nextCursor: null,
	});
	const result = await request(
		`lead/audit-events?afterSeq=1&throughSeq=9&storeEpoch=${epoch}&cursor=8&limit=2&projectName=other-project`,
	);
	expect(result.status).toBe(200);
	expect(read).toHaveBeenCalledWith("lead", 2, 8, {
		projectName: "bootstrap-route-test",
		afterSeq: 1,
		throughSeq: 9,
		storeEpoch: epoch,
	});
});

it("rejects malformed or inverted audit ranges before any store read", async () => {
	const read = vi.spyOn(store, "getLeadAuditEventPage");
	for (const query of [
		"afterSeq=-1",
		"afterSeq=1.5",
		"afterSeq=9007199254740992",
		"afterSeq=",
		"afterSeq=1&afterSeq=2",
		"throughSeq=-1",
		"throughSeq=1.5",
		"throughSeq=9007199254740992",
		"throughSeq[]=1",
		"afterSeq=2&throughSeq=1",
		"storeEpoch=not-a-generation",
		"storeEpoch=00000000-0000-4000-8000-000000000000:recovery",
		"storeEpoch=00000000-0000-4000-8000-000000000000&storeEpoch=00000000-0000-4000-8000-000000000001",
	]) {
		expect((await request(`lead/audit-events?${query}`)).status, query).toBe(
			400,
		);
	}
	expect(read).not.toHaveBeenCalled();
});

it("returns a generation conflict without exposing stale audit content", async () => {
	vi.spyOn(store, "getLeadAuditEventPage").mockImplementation(() => {
		throw new Error("audit_store_epoch_mismatch");
	});
	const result = await request(
		"lead/audit-events?afterSeq=0&throughSeq=0&storeEpoch=00000000-0000-4000-8000-000000000000",
	);
	expect(result).toEqual({
		status: 409,
		body: { error: "audit_store_epoch_mismatch" },
	});
});

it("returns only the configured project and exact audit sequence range", async () => {
	const append = (id: string, projectName: string, leadId = "lead") =>
		store.appendLeadEvent(
			leadId,
			id,
			"stage_changed",
			JSON.stringify({ project_name: projectName, stage: "test" }),
			undefined,
			"audit_only",
		);
	const before = append("before-range", "bootstrap-route-test");
	const first = append("in-range-first", "bootstrap-route-test");
	append("other-project", "another-project");
	append("other-lead", "bootstrap-route-test", "other");
	const last = append("in-range-last", "bootstrap-route-test");
	append("after-range", "bootstrap-route-test");
	const result = await request(
		`lead/audit-events?afterSeq=${before}&throughSeq=${last}`,
	);
	expect(result.status).toBe(200);
	expect(result.body.items.map((row: { seq: number }) => row.seq)).toEqual([
		last,
		first,
	]);
	expect(result.body.nextCursor).toBeNull();
	expect(result.body.storeEpoch).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	);
	const bounded = await request(
		`lead/audit-events?afterSeq=${before}&throughSeq=${last}&storeEpoch=${result.body.storeEpoch}&cursor=${last}`,
	);
	expect(bounded.status).toBe(200);
	expect(bounded.body.items.map((row: { seq: number }) => row.seq)).toEqual([
		first,
	]);
	expect(
		(
			await request(
				"lead/audit-events?storeEpoch=00000000-0000-4000-8000-000000000000",
			)
		).status,
	).toBe(409);
	expect((await request("unknown/audit-events?afterSeq=0")).status).toBe(404);
	expect(
		(await request("lead/audit-events?afterSeq=0", "external")).status,
	).toBe(401);
	expect((await request("lead/audit-events?afterSeq=0", "gemini")).status).toBe(
		403,
	);
});
