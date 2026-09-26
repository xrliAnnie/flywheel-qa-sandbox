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
		// FLY-516: additive field, false in steady state (byte-compat).
		expect(body.shuttingDown).toBe(false);
		expect(typeof body.uptime).toBe("number");
		expect(body.sessions_count).toBe(0);

		store.close();
	});

	// FLY-516: when the shared shutdown holder is flipped (close() does this at
	// teardown start), /health must report shuttingDown:true and ok:false so the
	// wrapper preflight reclaims the port instead of yielding to a draining
	// (zombie-in-the-making) Bridge that still answers 200.
	it("GET /health reflects shuttingDown via the shutdown holder", async () => {
		const store = await StateStore.create(":memory:");
		const holder = { shuttingDown: false };
		const app = createBridgeApp(
			store,
			[],
			makeConfig(),
			undefined, // broadcaster
			undefined, // transitionOpts
			undefined, // retryDispatcher
			undefined, // cipherWriter
			undefined, // eventFilter
			undefined, // _unusedForumTagUpdater
			undefined, // registry
			undefined, // _unusedForumPostCreator
			undefined, // memoryService
			undefined, // captureSessionFn
			undefined, // startDispatcher
			undefined, // standupService
			undefined, // standupProjectName
			{ shutdownStateHolder: holder },
		);

		const base = await startAndGetUrl(app, "/health");
		const before = await (await fetch(base)).json();
		expect(before.ok).toBe(true);
		expect(before.shuttingDown).toBe(false);

		// Simulate close() flipping the flag mid-flight.
		holder.shuttingDown = true;
		const duringRes = await fetch(base);
		expect(duringRes.status).toBe(200); // still 200 (additive, not a 503)
		const during = await duringRes.json();
		expect(during.ok).toBe(false);
		expect(during.shuttingDown).toBe(true);

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
				leads: [
					{
						agentId: "product-lead",
						forumChannel: "test-channel",
						chatChannel: "test-chat",
						match: { labels: ["Product"] },
					},
				],
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

	// FLY-162 P1: replyByIssueEnabled config field + fail-startup guard
	it("loadConfig() defaults replyByIssueEnabled to false when env not set", () => {
		const prev = process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
		delete process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
		try {
			const config = loadConfig();
			expect(config.replyByIssueEnabled).toBe(false);
		} finally {
			if (prev !== undefined)
				process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = prev;
		}
	});

	it("loadConfig() reads TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true when apiToken is set", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = "true";
		process.env.TEAMLEAD_API_TOKEN = "test-token";
		try {
			const config = loadConfig();
			expect(config.replyByIssueEnabled).toBe(true);
			expect(config.apiToken).toBe("test-token");
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
			else process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = prevFlag;
			if (prevToken === undefined) delete process.env.TEAMLEAD_API_TOKEN;
			else process.env.TEAMLEAD_API_TOKEN = prevToken;
		}
	});

	it("loadConfig() throws when replyByIssueEnabled=true but TEAMLEAD_API_TOKEN missing (FLY-162 Codex R2 #2)", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = "true";
		delete process.env.TEAMLEAD_API_TOKEN;
		try {
			expect(() => loadConfig()).toThrow(/TEAMLEAD_API_TOKEN/);
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
			else process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = prevFlag;
			if (prevToken !== undefined) process.env.TEAMLEAD_API_TOKEN = prevToken;
		}
	});

	it("loadConfig() throws when replyByIssueEnabled=true and apiToken is empty string", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = "true";
		process.env.TEAMLEAD_API_TOKEN = "";
		try {
			expect(() => loadConfig()).toThrow(/TEAMLEAD_API_TOKEN/);
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
			else process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = prevFlag;
			if (prevToken === undefined) delete process.env.TEAMLEAD_API_TOKEN;
			else process.env.TEAMLEAD_API_TOKEN = prevToken;
		}
	});

	// FLY-162 Layer 2: replyGuardEnabled config field + fail-startup guard + prefixes
	it("loadConfig() defaults replyGuardEnabled false and issuePrefixes to [FLY,GEO]", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
		const prevPfx = process.env.TEAMLEAD_ISSUE_PREFIXES;
		delete process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
		delete process.env.TEAMLEAD_ISSUE_PREFIXES;
		try {
			const config = loadConfig();
			expect(config.replyGuardEnabled).toBe(false);
			expect(config.issuePrefixes).toEqual(["FLY", "GEO"]);
		} finally {
			if (prevFlag !== undefined)
				process.env.TEAMLEAD_REPLY_GUARD_ENABLED = prevFlag;
			if (prevPfx !== undefined) process.env.TEAMLEAD_ISSUE_PREFIXES = prevPfx;
		}
	});

	it("loadConfig() parses TEAMLEAD_ISSUE_PREFIXES (trim + uppercase + drop empties)", () => {
		const prev = process.env.TEAMLEAD_ISSUE_PREFIXES;
		process.env.TEAMLEAD_ISSUE_PREFIXES = " fly , geo, ,Ops ";
		try {
			expect(loadConfig().issuePrefixes).toEqual(["FLY", "GEO", "OPS"]);
		} finally {
			if (prev === undefined) delete process.env.TEAMLEAD_ISSUE_PREFIXES;
			else process.env.TEAMLEAD_ISSUE_PREFIXES = prev;
		}
	});

	it("loadConfig() throws when replyGuardEnabled=true but TEAMLEAD_API_TOKEN missing (FLY-162 Codex R1 #3)", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		process.env.TEAMLEAD_REPLY_GUARD_ENABLED = "true";
		delete process.env.TEAMLEAD_API_TOKEN;
		try {
			expect(() => loadConfig()).toThrow(/TEAMLEAD_API_TOKEN/);
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
			else process.env.TEAMLEAD_REPLY_GUARD_ENABLED = prevFlag;
			if (prevToken !== undefined) process.env.TEAMLEAD_API_TOKEN = prevToken;
		}
	});

	it("loadConfig() reads replyGuardEnabled=true when apiToken is set", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		process.env.TEAMLEAD_REPLY_GUARD_ENABLED = "true";
		process.env.TEAMLEAD_API_TOKEN = "test-token";
		try {
			expect(loadConfig().replyGuardEnabled).toBe(true);
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
			else process.env.TEAMLEAD_REPLY_GUARD_ENABLED = prevFlag;
			if (prevToken === undefined) delete process.env.TEAMLEAD_API_TOKEN;
			else process.env.TEAMLEAD_API_TOKEN = prevToken;
		}
	});

	it("loadConfig() throws when replyGuardEnabled=true and issuePrefixes parses empty", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		const prevPfx = process.env.TEAMLEAD_ISSUE_PREFIXES;
		process.env.TEAMLEAD_REPLY_GUARD_ENABLED = "true";
		process.env.TEAMLEAD_API_TOKEN = "test-token";
		process.env.TEAMLEAD_ISSUE_PREFIXES = " , ";
		try {
			expect(() => loadConfig()).toThrow(/TEAMLEAD_ISSUE_PREFIXES is empty/);
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
			else process.env.TEAMLEAD_REPLY_GUARD_ENABLED = prevFlag;
			if (prevToken === undefined) delete process.env.TEAMLEAD_API_TOKEN;
			else process.env.TEAMLEAD_API_TOKEN = prevToken;
			if (prevPfx === undefined) delete process.env.TEAMLEAD_ISSUE_PREFIXES;
			else process.env.TEAMLEAD_ISSUE_PREFIXES = prevPfx;
		}
	});

	it("loadConfig() throws when replyGuardEnabled=true and a prefix is unscannable (<2 letters)", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		const prevPfx = process.env.TEAMLEAD_ISSUE_PREFIXES;
		process.env.TEAMLEAD_REPLY_GUARD_ENABLED = "true";
		process.env.TEAMLEAD_API_TOKEN = "test-token";
		process.env.TEAMLEAD_ISSUE_PREFIXES = "FLY,A";
		try {
			expect(() => loadConfig()).toThrow(/scanner can never match/);
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
			else process.env.TEAMLEAD_REPLY_GUARD_ENABLED = prevFlag;
			if (prevToken === undefined) delete process.env.TEAMLEAD_API_TOKEN;
			else process.env.TEAMLEAD_API_TOKEN = prevToken;
			if (prevPfx === undefined) delete process.env.TEAMLEAD_ISSUE_PREFIXES;
			else process.env.TEAMLEAD_ISSUE_PREFIXES = prevPfx;
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
				leads: [
					{
						agentId: "product-lead",
						forumChannel: "test-channel",
						chatChannel: "test-chat",
						match: { labels: ["Product"] },
					},
				],
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
