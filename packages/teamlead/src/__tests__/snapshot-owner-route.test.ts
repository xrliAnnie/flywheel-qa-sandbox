import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import type { BridgeConfig } from "../bridge/types.js";
import { StateStore } from "../StateStore.js";

const servers: http.Server[] = [];
const stores: StateStore[] = [];

async function start(apiToken?: string) {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.upsertSession({
		execution_id: "exec-1",
		issue_id: "issue-1",
		project_name: "flywheel",
		status: "running",
		started_at: "2026-09-08T12:00:00.000Z",
	});
	const config: BridgeConfig = {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		apiToken,
	};
	const server = createBridgeApp(store, [], config).listen(0, "127.0.0.1");
	servers.push(server);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return `http://127.0.0.1:${port}/api/sessions/exec-1/snapshot-owner`;
}

afterEach(async () => {
	while (servers.length > 0) {
		const server = servers.pop()!;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	while (stores.length > 0) stores.pop()!.close();
});

describe("GET /api/sessions/:executionId/snapshot-owner", () => {
	it("returns only the authenticated active owner", async () => {
		const url = await start("master-token");
		expect((await fetch(url)).status).toBe(401);
		expect(
			(await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status,
		).toBe(401);
		const response = await fetch(url, {
			headers: { Authorization: "Bearer master-token" },
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			owner: {
				kind: "session",
				executionId: "exec-1",
				sessionStartedAt: "2026-09-08T12:00:00.000Z",
			},
		});
	});

	it("fails closed when the Bridge API token is not configured", async () => {
		const response = await fetch(await start());
		expect(response.status).toBe(503);
	});
});
