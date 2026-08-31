import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlagRetirementScanner } from "../bridge/flag-retirement-scan.js";
import { type BridgeAppOptions, createBridgeApp } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import type { BridgeConfig } from "../bridge/types.js";
import { StateStore } from "../StateStore.js";

function config(apiToken?: string): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test",
		defaultLeadAgentId: "flywheel-eng-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		...(apiToken ? { apiToken } : {}),
	};
}

async function post(
	app: ReturnType<typeof createBridgeApp>,
	body: Record<string, unknown>,
	options: { token?: string; host?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
	const server = http.createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no address");
		const payload = JSON.stringify(body);
		return await new Promise((resolve, reject) => {
			const request = http.request(
				{
					host: "127.0.0.1",
					port: address.port,
					path: "/api/flag-scan/run",
					method: "POST",
					headers: {
						Host: options.host ?? `127.0.0.1:${address.port}`,
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(payload),
						...(options.token
							? { Authorization: `Bearer ${options.token}` }
							: {}),
					},
				},
				(response) => {
					let raw = "";
					response.setEncoding("utf8");
					response.on("data", (chunk) => {
						raw += chunk;
					});
					response.on("end", () => {
						resolve({
							status: response.statusCode ?? 0,
							json: JSON.parse(raw) as Record<string, unknown>,
						});
					});
				},
			);
			request.on("error", reject);
			request.end(payload);
		});
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

const stores: StateStore[] = [];

async function appWith(
	apiToken: string | undefined,
	current?: {
		runNow(): Promise<Record<string, unknown>>;
		dryRun(): Promise<Record<string, unknown>>;
	},
) {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const opts = {
		flagScanRoute: { current },
	} as unknown as BridgeAppOptions;
	return createBridgeApp(
		store,
		[],
		config(apiToken),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		opts,
	);
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	vi.restoreAllMocks();
});

describe("POST /api/flag-scan/run mount", () => {
	it("is reachable before the catch-all and invokes a real forced run", async () => {
		const runNow = vi
			.fn()
			.mockResolvedValue({ status: "published", runId: 42 });
		const dryRun = vi.fn().mockResolvedValue({
			status: "dry_run",
			runToken: "preview",
			candidateCount: 0,
		});
		const app = await appWith("master-token", { runNow, dryRun });

		expect(await post(app, {}, { token: "master-token" })).toEqual({
			status: 200,
			json: { status: "published", runId: 42 },
		});
		expect(runNow).toHaveBeenCalledTimes(1);
		expect(dryRun).not.toHaveBeenCalled();

		expect(
			await post(app, { dryRun: true }, { token: "master-token" }),
		).toMatchObject({ status: 200, json: { status: "dry_run" } });
		expect(dryRun).toHaveBeenCalledTimes(1);
	});

	it("returns 200 after the mounted route computes, commits, and delivers one real scan", async () => {
		const scanStore = await StateStore.create(":memory:");
		stores.push(scanStore);
		const postDiscord = vi.fn(async () => ({
			status: "done" as const,
			evidence: JSON.stringify({ rootMessageId: "zero-root" }),
		}));
		const runtime = createFlagRetirementScanner({
			store: scanStore,
			loadSources: async () => ({
				rows: [
					{
						spec: {
							name: "route_reachable_flag",
							category: "feature",
							source: "env",
							scope: "bridge_global",
							envVar: "ROUTE_REACHABLE_FLAG",
							polarity: "opt_in",
							valueKind: "bool",
							default: false,
							description: "Route integration fixture",
							readSites: [],
							toggleable: "readonly",
						},
						view: {
							name: "route_reachable_flag",
							category: "feature",
							description: "Route integration fixture",
							toggleable: "readonly",
							valueKind: "bool",
							scope: "bridge_global",
							source: "env",
							envVar: "ROUTE_REACHABLE_FLAG",
							readTimings: ["call_time"],
							default: false,
							effective: false,
							displayEffective: false,
						},
					},
				],
				expectedProjectNames: [],
			}),
			loadProvenance: async () => [
				{
					flagName: "route_reachable_flag",
					incarnationCommit: "abc123",
					status: "resolved",
					sourceIssue: "FLY-2104",
					author: "test",
					committedAt: 1,
					prNumber: 1,
				},
			],
			effects: {
				publishReport: vi.fn(),
				postDiscord,
				reconcileDiscord: vi.fn(async () => ({ status: "missing" as const })),
				notifyLead: vi.fn(async () => ({
					status: "done" as const,
					evidence: "mailbox",
				})),
			},
			alertFailure: vi.fn(async () => undefined),
			now: () => Date.parse("2026-08-23T15:00:00.000Z"),
			newRunToken: () => "route-real-run",
			leaseOwner: "route-test",
			enabled: () => true,
		});
		const app = await appWith("master-token", runtime);

		expect(await post(app, {}, { token: "master-token" })).toEqual({
			status: 200,
			json: { status: "published", runId: 1 },
		});
		expect(scanStore.listFlagScanRuns()).toMatchObject([
			{ runToken: "route-real-run", status: "published" },
		]);
		expect(postDiscord).toHaveBeenCalledWith({
			runToken: "route-real-run",
			body: "本周 0 候选",
		});
	});

	it("keeps auth, loopback, body, readiness, and race outcomes fail-closed", async () => {
		const runtime = {
			runNow: vi.fn().mockResolvedValue({ status: "lost_race" }),
			dryRun: vi.fn().mockResolvedValue({ status: "dry_run" }),
		};
		const app = await appWith("master-token", runtime);

		expect(await post(app, {})).toMatchObject({ status: 401 });
		expect(
			await post(app, {}, { token: "master-token", host: "example.com" }),
		).toMatchObject({ status: 403 });
		expect(
			await post(app, { dryRun: "yes" }, { token: "master-token" }),
		).toMatchObject({ status: 400 });
		expect(
			await post(app, { extra: true }, { token: "master-token" }),
		).toMatchObject({ status: 400 });
		expect(await post(app, {}, { token: "master-token" })).toMatchObject({
			status: 409,
			json: { status: "lost_race" },
		});

		const notReady = await appWith("master-token");
		expect(await post(notReady, {}, { token: "master-token" })).toMatchObject({
			status: 503,
		});

		const tokenless = await appWith(undefined, runtime);
		expect(await post(tokenless, {})).toMatchObject({ status: 503 });
	});
});
