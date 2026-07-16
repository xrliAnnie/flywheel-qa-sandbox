import { createServer } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { createTmuxHoldObservationRouter } from "../tmux-hold-route.js";

const TOKEN = "tmux-hold-test-token";
const SOCKET = "/private/tmp/tmux-501/default";
const PROJECTS = [
	{
		projectName: "flywheel",
		leads: [{ agentId: "flywheel-eng-lead" }],
	},
] as ProjectEntry[];

async function request(
	app: express.Application,
	body: Record<string, unknown>,
	token: string | undefined = TOKEN,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/tmux-hold-observation`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(token ? { authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(body),
			},
		);
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		};
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((err) => (err ? reject(err) : resolve())),
		);
	}
}

describe("POST /api/tmux-hold-observation", () => {
	let store: StateStore;
	let app: express.Application;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-tmux",
			issue_id: "issue-tmux",
			project_name: "flywheel",
			status: "running",
			adapter_type: "claude-tmux",
		} as never);
		store.upsertSession({
			execution_id: "exec-terminal",
			issue_id: "issue-terminal",
			project_name: "flywheel",
			status: "running",
			adapter_type: "terminal",
		} as never);
		app = express();
		app.use(express.json());
		app.use(
			"/api/tmux-hold-observation",
			createTmuxHoldObservationRouter({
				store,
				projects: PROJECTS,
				apiToken: TOKEN,
				canonicalSocketPath: SOCKET,
				now: () => Date.parse("2026-07-15T08:00:00.000Z"),
			}),
		);
	});

	afterEach(() => store.close());

	function validBody(overrides: Record<string, unknown> = {}) {
		return {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			socketPath: SOCKET,
			kind: "saturated",
			heldSinceTs: Date.parse("2026-07-15T07:59:00.000Z") / 1_000,
			evidence: { reason: "backlog_full", originalServerPid: 1234 },
			...overrides,
		};
	}

	it("fails closed when apiToken is absent or the bearer is wrong", async () => {
		const noTokenApp = express();
		noTokenApp.use(express.json());
		noTokenApp.use(
			"/api/tmux-hold-observation",
			createTmuxHoldObservationRouter({
				store,
				projects: PROJECTS,
				canonicalSocketPath: SOCKET,
			}),
		);
		expect((await request(noTokenApp, validBody())).status).toBe(503);
		expect((await request(app, validBody(), "wrong")).status).toBe(401);
	});

	it("hydrates every running tmux-backed session in the first transaction", async () => {
		const response = await request(app, validBody());
		expect(response.status).toBe(200);
		expect(response.body.incidentId).toEqual(expect.any(String));
		const hold = store.getActiveTmuxHold(SOCKET);
		expect(hold?.affectedExecutionIds).toEqual(["exec-tmux"]);
		expect(hold?.shape).toBe("provisional");
		expect(hold?.evidence).toMatchObject({
			originalServerPid: 1234,
			originalServerPidSource: "supervisor_archive",
		});
	});

	it("merges changing reasons into one incident and requires the canonical ack id", async () => {
		const first = await request(app, validBody());
		const incidentId = first.body.incidentId as string;
		const second = await request(
			app,
			validBody({ kind: "unknown", incidentId }),
		);
		expect(second.status).toBe(200);
		expect(second.body.incidentId).toBe(incidentId);
		expect(store.listTmuxHoldHistory(SOCKET)).toHaveLength(1);
		expect(store.getActiveTmuxHold(SOCKET)?.reasonHistory).toEqual([
			"saturated",
			"unknown",
		]);

		const mismatch = await request(
			app,
			validBody({ incidentId: "not-the-active-incident" }),
		);
		expect(mismatch.status).toBe(409);
		expect(store.getActiveTmuxHold(SOCKET)?.incidentId).toBe(incidentId);
	});

	it("rejects stale ack retries after resolution instead of resurrecting them", async () => {
		const first = await request(app, validBody());
		const incidentId = first.body.incidentId as string;
		expect(store.resolveTmuxHold(SOCKET, incidentId)).toBe(true);

		const stale = await request(app, validBody({ incidentId }));
		expect(stale.status).toBe(409);
		expect(store.getActiveTmuxHold(SOCKET)).toBeUndefined();
		expect(store.listTmuxHoldHistory(SOCKET)).toHaveLength(1);
	});

	it("rejects non-canonical sockets, unknown identities, kinds, and stale timestamps", async () => {
		for (const body of [
			validBody({ socketPath: "/private/tmp/tmux-501/other" }),
			validBody({ projectName: "other" }),
			validBody({ leadId: "other-lead" }),
			validBody({ kind: "marker_disabled" }),
			validBody({ heldSinceTs: Date.parse("2026-07-13T00:00:00Z") / 1_000 }),
		]) {
			expect((await request(app, body)).status).toBe(400);
		}
		expect(store.listActiveTmuxHolds()).toHaveLength(0);
	});

	it("rejects oversized evidence and invalid original-server identities", async () => {
		expect(
			(
				await request(
					app,
					validBody({ evidence: { detail: "x".repeat(20_000) } }),
				)
			).status,
		).toBe(413);
		expect(
			(await request(app, validBody({ evidence: { originalServerPid: -1 } })))
				.status,
		).toBe(400);
	});
});
