/**
 * FLY-696 M1/④ — the Bridge /events `account_rotation` branch.
 *
 * A Codex per-runner rotation notice is fleet-global: it carries only
 * provider/to/reason/... and NO issue/execution/project fields, so it must be
 * handled BEFORE the required-field validation and posted to the unified Alerts
 * channel via the late-bound callback. Byte-compat: with no callback wired the
 * event is still acked (200), just not posted.
 */
import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
];

function makeConfig(): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	};
}

/** Build the bridge app with an optional account_rotation post holder. */
async function makeApp(holder?: {
	current?: (detail: string) => Promise<void>;
}): Promise<{ baseUrl: string; server: http.Server; store: StateStore }> {
	const store = await StateStore.create(":memory:");
	const app = createBridgeApp(
		store,
		testProjects,
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
		holder ? { accountRotationPost: holder } : undefined,
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return { baseUrl: `http://127.0.0.1:${port}`, server, store };
}

async function post(
	baseUrl: string,
	body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
	const res = await fetch(`${baseUrl}/events`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer ingest-secret",
		},
		body: JSON.stringify(body),
	});
	return { status: res.status, json: await res.json() };
}

describe("Event route — account_rotation (FLY-696 M1/④)", () => {
	let server: http.Server | undefined;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve, reject) => {
				server?.close((err) => (err ? reject(err) : resolve()));
			});
			server = undefined;
		}
	});

	it("posts the formatted notice — WITHOUT any issue/execution/project fields", async () => {
		const posted: string[] = [];
		const holder = {
			current: async (detail: string) => {
				posted.push(detail);
			},
		};
		const app = await makeApp(holder);
		server = app.server;

		const { status, json } = await post(app.baseUrl, {
			event_id: "rot-1",
			event_type: "account_rotation",
			source: "flywheel-comm",
			// deliberately NO issue_id / execution_id / project_name
			payload: {
				provider: "codex",
				from: "school",
				to: "business",
				reason: "rate_limit",
			},
		});

		expect(status).toBe(200);
		expect(json).toEqual({ ok: true });
		expect(posted).toEqual([
			"🔁 Codex 账号轮转：school → business（额度/限流）",
		]);
	});

	it("acks (200) but does not throw when no post callback is wired (byte-compat)", async () => {
		const app = await makeApp(); // no holder
		server = app.server;
		const { status, json } = await post(app.baseUrl, {
			event_id: "rot-2",
			event_type: "account_rotation",
			payload: { provider: "codex", to: "business", reason: "auth_expired" },
		});
		expect(status).toBe(200);
		expect(json).toEqual({ ok: true });
	});

	it("returns 400 when payload.provider or payload.to is missing", async () => {
		const posted: string[] = [];
		const app = await makeApp({
			current: async (d) => {
				posted.push(d);
			},
		});
		server = app.server;
		const { status } = await post(app.baseUrl, {
			event_id: "rot-3",
			event_type: "account_rotation",
			payload: { provider: "codex" }, // no `to`
		});
		expect(status).toBe(400);
		expect(posted).toEqual([]);
	});

	it("does not fail the request when the post callback throws", async () => {
		const app = await makeApp({
			current: async () => {
				throw new Error("discord down");
			},
		});
		server = app.server;
		const { status, json } = await post(app.baseUrl, {
			event_id: "rot-4",
			event_type: "account_rotation",
			payload: { provider: "codex", to: "business", reason: "rate_limit" },
		});
		expect(status).toBe(200);
		expect(json).toEqual({ ok: true });
	});

	// FLY-929 A4: the STRUCTURED notice rides along as the post's second
	// argument so the plugin's site can build the #flywheel-notify digest from
	// structured data (never re-parsed from the formatted Alerts line).
	it("passes the structured notice as the second argument", async () => {
		const calls: Array<[string, unknown]> = [];
		const app = await makeApp({
			current: async (detail: string, rotation?: unknown) => {
				calls.push([detail, rotation]);
			},
		});
		server = app.server;
		const { status } = await post(app.baseUrl, {
			event_id: "rot-5",
			event_type: "account_rotation",
			payload: {
				provider: "codex",
				from: "school",
				to: "business",
				reason: "rate_limit",
				resetAt: "2026-07-08T02:00:00Z",
			},
		});
		expect(status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]![1]).toEqual({
			provider: "codex",
			from: "school",
			to: "business",
			reason: "rate_limit",
			resetAt: "2026-07-08T02:00:00Z",
		});
	});
});
