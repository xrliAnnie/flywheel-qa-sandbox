/**
 * FLY-191 Phase 2 (Codex PR R1 HIGH-4) — the founder-consent gate-response
 * endpoint WRITES the approve_to_ship authority source, so it must never be
 * reachable unauthenticated: tokenless deployments get a hard 503 (refuse)
 * instead of tokenAuthMiddleware's silent no-op pass-through.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function makeConfig(apiToken?: string): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		apiToken,
		founderConsent: { decisionMode: "off" },
	} as unknown as BridgeConfig;
}

describe("gate-response endpoint auth (FLY-191 / Codex PR R1 HIGH-4)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	async function boot(apiToken?: string) {
		store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, testProjects, makeConfig(apiToken));
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	}

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
		vi.restoreAllMocks();
	});

	it("tokenless deployment → 503 (refuses unauthenticated approval writes)", async () => {
		await boot(undefined);
		const res = await fetch(
			`${baseUrl}/api/founder-consent/runner-gate-response`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					questionId: "q1",
					leadId: "lead-x",
					answer: JSON.stringify({ approved: true }),
					executionId: "e1",
				}),
			},
		);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("TEAMLEAD_API_TOKEN");
	});

	it("with a token configured, a wrong bearer → 401", async () => {
		await boot("secret-token");
		const res = await fetch(
			`${baseUrl}/api/founder-consent/runner-gate-response`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer wrong",
				},
				body: JSON.stringify({
					questionId: "q1",
					leadId: "lead-x",
					answer: JSON.stringify({ approved: true }),
					executionId: "e1",
				}),
			},
		);
		expect(res.status).toBe(401);
	});
});
