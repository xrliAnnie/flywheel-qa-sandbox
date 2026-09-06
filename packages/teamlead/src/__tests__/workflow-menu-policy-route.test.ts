import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import type { BridgeConfig } from "../bridge/types.js";
import { StateStore } from "../StateStore.js";

const servers: http.Server[] = [];
const stores: StateStore[] = [];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		...overrides,
	};
}

async function start(config: BridgeConfig): Promise<string> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const server = createBridgeApp(store, [], config).listen(0, "127.0.0.1");
	servers.push(server);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return `http://127.0.0.1:${port}/api/workflow/menu-policies`;
}

afterEach(async () => {
	while (servers.length > 0) {
		const server = servers.pop()!;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	while (stores.length > 0) stores.pop()!.close();
});

describe("GET /api/workflow/menu-policies", () => {
	it("uses master bearer auth and returns the shape projection", async () => {
		const url = await start(
			makeConfig({
				apiToken: "master-token",
				geminiAgentToken: "scoped-token",
			}),
		);

		expect((await fetch(url)).status).toBe(401);
		expect(
			(
				await fetch(url, {
					headers: { Authorization: "Bearer scoped-token" },
				})
			).status,
		).toBeGreaterThanOrEqual(401);
		const response = await fetch(url, {
			headers: { Authorization: "Bearer master-token" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			schemaVersion: 1,
			source: ".flywheel/agents/registry.yaml",
			taskCategories: expect.arrayContaining([
				expect.objectContaining({
					taskCategory: "code",
					templateId: "tpl_code",
				}),
			]),
		});
	});

	it("fails closed when the master bearer token is not configured", async () => {
		const response = await fetch(await start(makeConfig()));

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "workflow menu policy API requires TEAMLEAD_API_TOKEN",
		});
	});
});
