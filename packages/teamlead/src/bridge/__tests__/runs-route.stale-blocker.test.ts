/**
 * FLY-742: runs-route 409-path integration — the stale-blocker guard decides
 * whether the run-start is DECLINED (409) or self-heals (falls through). Uses a
 * real `createServer` + `listen(0)` + fetch (the repo's route-test convention,
 * see chat-thread-routes.test.ts); the guard/store/admission are fakes so the
 * test is network-free (the active-session check runs BEFORE the Linear
 * pre-flight). Fails explicitly on a listener error and restores env after.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "../../StateStore.js";
import { createRunsRouter } from "../runs-route.js";

const BLOCKER = {
	issue_id: "issue-1",
	session_role: "main",
	status: "awaiting_review",
	execution_id: "old-exec",
	project_name: "sub",
} as Session;

// Only getActiveSessions() is reached before the 409 / admission branch.
const fakeStore = {
	getActiveSessions: () => [BLOCKER],
} as unknown as Parameters<typeof createRunsRouter>[1];

const fakeDispatcher = {
	getInflightCount: () => 0,
	start: async () => {
		throw new Error("start should not be reached in these tests");
	},
} as unknown as Parameters<typeof createRunsRouter>[0];

// Defers admission → 429, which proves the request got PAST the 409 branch.
const deferringAdmission = {
	tryAdmit: () => ({ admit: false, reason: "load", detail: "test-defer" }),
} as unknown as Parameters<typeof createRunsRouter>[3];

function startApp(guard?: {
	handleActiveBlocker(b: Session): Promise<{ proceed: boolean }>;
}): Promise<{ url: string; server: Server }> {
	const app = express();
	app.use(express.json());
	app.use(
		"/api/runs",
		createRunsRouter(
			fakeDispatcher,
			fakeStore,
			[],
			deferringAdmission,
			undefined,
			false,
			guard,
		),
	);
	const server = createServer(app);
	return new Promise((resolve, reject) => {
		server.on("error", reject); // fail-explicit if listen is forbidden
		server.listen(0, () => {
			const { port } = server.address() as AddressInfo;
			resolve({ url: `http://127.0.0.1:${port}`, server });
		});
	});
}

async function post(url: string) {
	return fetch(`${url}/api/runs/start`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			issueId: "issue-1",
			projectName: "sub",
			sessionRole: "main",
		}),
	});
}

let server: Server | undefined;
let priorLinearKey: string | undefined;

beforeAll(() => {
	priorLinearKey = process.env.LINEAR_API_KEY;
	process.env.LINEAR_API_KEY = "test-key"; // top-of-handler gate
});

afterAll(() => {
	if (priorLinearKey === undefined) delete process.env.LINEAR_API_KEY;
	else process.env.LINEAR_API_KEY = priorLinearKey;
});

afterEach(async () => {
	if (server) {
		await new Promise<void>((r) => server?.close(() => r()));
		server = undefined;
	}
});

describe("runs-route stale-blocker guard integration", () => {
	it("no guard injected → unchanged 409 (byte-compat)", async () => {
		const app = await startApp(undefined);
		server = app.server;
		const res = await post(app.url);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { message: string };
		expect(body.message).toContain("already has an active session");
	});

	it("guard proceed:false → 409 (stale but alert-only / silent)", async () => {
		const app = await startApp({
			handleActiveBlocker: async () => ({ proceed: false }),
		});
		server = app.server;
		const res = await post(app.url);
		expect(res.status).toBe(409);
	});

	it("guard proceed:true → falls through past 409 (reaches admission → 429)", async () => {
		let called = 0;
		const app = await startApp({
			handleActiveBlocker: async () => {
				called += 1;
				return { proceed: true };
			},
		});
		server = app.server;
		const res = await post(app.url);
		expect(res.status).not.toBe(409); // did NOT decline
		expect(res.status).toBe(429); // reached admission (deferred)
		expect(called).toBe(1);
	});
});
