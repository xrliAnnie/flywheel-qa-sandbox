import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const servers: http.Server[] = [];
const stores: StateStore[] = [];

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
	for (const store of stores.splice(0)) store.close();
});

const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/canonical/flywheel",
		leads: [],
	},
];

async function boot(): Promise<string> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const config = {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "flywheel-eng-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
	} as BridgeConfig;
	const app = createBridgeApp(store, projects, config);
	const server = app.listen(0, "127.0.0.1");
	servers.push(server);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("listen failed");
	return `http://127.0.0.1:${address.port}`;
}

describe("Gate carrier rebind Bridge mount", () => {
	it("mounts the production stage route outside Bearer auth and fails closed without proof", async () => {
		const origin = await boot();
		const response = await fetch(
			`${origin}/api/workflow/gate-carrier-rebind/stage`,
			{
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({
					question_id: `workflow-gate:${"1".repeat(64)}`,
					candidate_execution_id: "candidate-execution",
				}),
			},
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			ok: false,
			reason: "rebind_proof_unavailable",
		});
	});
});
