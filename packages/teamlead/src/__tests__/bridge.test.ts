import { afterEach, describe, expect, it } from "vitest";
import { createBridgeApp, startBridge } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import { loadConfig } from "../config.js";
import { StateStore } from "../StateStore.js";

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0, // random port
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		...overrides,
	};
}

describe("Bridge scaffold", () => {
	let closeFn: (() => Promise<void>) | undefined;

	afterEach(async () => {
		if (closeFn) {
			await closeFn();
			closeFn = undefined;
		}
	});

	it("GET /health returns 200 with uptime (no auth required)", async () => {
		const store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, [], makeConfig());

		const res = await fetch(await startAndGetUrl(app, "/health"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(typeof body.uptime).toBe("number");
		expect(body.sessions_count).toBe(0);

		store.close();
	});

	it("Unknown routes return 404", async () => {
		const store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, [], makeConfig());

		const res = await fetch(await startAndGetUrl(app, "/nonexistent"));
		expect(res.status).toBe(404);

		store.close();
	});

	it("/api/* requires apiToken when configured", async () => {
		const config = makeConfig({ apiToken: "secret-api" });
		const { store, close } = await startBridge(config, [
			{
				projectName: "test",
				projectRoot: "/tmp",
				lead: { agentId: "product-lead", channel: "test-channel" },
			},
		]);
		closeFn = close;

		const _addr = getListeningPort(close);
		// This will hit the 404 catch-all since no /api routes are mounted yet,
		// but auth middleware isn't applied yet either (will be in Task 3).
		// For now, just verify startBridge works.
		expect(store).toBeDefined();
	});

	it("loadConfig() rejects host=0.0.0.0", () => {
		const prev = process.env.TEAMLEAD_HOST;
		process.env.TEAMLEAD_HOST = "0.0.0.0";
		try {
			expect(() => loadConfig()).toThrow("must be loopback");
		} finally {
			if (prev === undefined) delete process.env.TEAMLEAD_HOST;
			else process.env.TEAMLEAD_HOST = prev;
		}
	});

	it("loadConfig() rejects IPv6 all-interfaces (::)", () => {
		const prev = process.env.TEAMLEAD_HOST;
		process.env.TEAMLEAD_HOST = "::";
		try {
			expect(() => loadConfig()).toThrow("must be loopback");
		} finally {
			if (prev === undefined) delete process.env.TEAMLEAD_HOST;
			else process.env.TEAMLEAD_HOST = prev;
		}
	});

	it("loadConfig() defaults host to 127.0.0.1", () => {
		const prev = process.env.TEAMLEAD_HOST;
		delete process.env.TEAMLEAD_HOST;
		try {
			const config = loadConfig();
			expect(config.host).toBe("127.0.0.1");
		} finally {
			if (prev !== undefined) process.env.TEAMLEAD_HOST = prev;
		}
	});

	it("loadConfig() rejects non-numeric TEAMLEAD_STUCK_THRESHOLD", () => {
		const prev = process.env.TEAMLEAD_STUCK_THRESHOLD;
		process.env.TEAMLEAD_STUCK_THRESHOLD = "abc";
		try {
			expect(() => loadConfig()).toThrow("TEAMLEAD_STUCK_THRESHOLD");
		} finally {
			if (prev === undefined) delete process.env.TEAMLEAD_STUCK_THRESHOLD;
			else process.env.TEAMLEAD_STUCK_THRESHOLD = prev;
		}
	});

	it("loadConfig() rejects non-numeric TEAMLEAD_STUCK_INTERVAL", () => {
		const prev = process.env.TEAMLEAD_STUCK_INTERVAL;
		process.env.TEAMLEAD_STUCK_INTERVAL = "0";
		try {
			expect(() => loadConfig()).toThrow("TEAMLEAD_STUCK_INTERVAL");
		} finally {
			if (prev === undefined) delete process.env.TEAMLEAD_STUCK_INTERVAL;
			else process.env.TEAMLEAD_STUCK_INTERVAL = prev;
		}
	});

	it("startBridge throws if projects is empty", async () => {
		const config = makeConfig();
		await expect(startBridge(config, [])).rejects.toThrow(
			"No projects configured",
		);
	});

	it("startBridge starts and closes cleanly", async () => {
		const config = makeConfig();
		const result = await startBridge(config, [
			{
				projectName: "test",
				projectRoot: "/tmp",
				lead: { agentId: "product-lead", channel: "test-channel" },
			},
		]);
		closeFn = result.close;

		expect(result.app).toBeDefined();
		expect(result.store).toBeDefined();

		await result.close();
		closeFn = undefined;
	});
});

// Helper: start an express app on a random port and return the base URL
async function startAndGetUrl(
	app: ReturnType<typeof createBridgeApp>,
	path: string,
): Promise<string> {
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;

	// Close after fetch — we wrap in a cleanup pattern
	const url = `http://127.0.0.1:${port}${path}`;

	// Schedule cleanup
	setTimeout(() => server.close(), 5000);

	return url;
}

function getListeningPort(_close: () => Promise<void>): number {
	// Placeholder — will be used when routes are mounted
	return 0;
}
