import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({
		client: { rawRequest: vi.fn() },
	})),
}));

const ROOT = "11111111-1111-4111-8111-111111111111";
const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [{ agentId: "eng", chatChannel: "c", match: { labels: ["Eng"] } }],
	},
];

function config(apiToken?: string): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test",
		defaultLeadAgentId: "eng",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		...(apiToken ? { apiToken } : {}),
	};
}

async function post(
	app: ReturnType<typeof createBridgeApp>,
	path: string,
	body: Record<string, unknown>,
	token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const server = http.createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no address");
		const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
		});
		return {
			status: response.status,
			json: (await response.json()) as Record<string, unknown>,
		};
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

afterEach(() => vi.restoreAllMocks());

describe("POST /api/doa-backoff/reset", () => {
	it("is fail-closed when the master token is not configured", async () => {
		const store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, projects, config());
		const response = await post(app, "/api/doa-backoff/reset", {
			projectName: "flywheel",
			issueId: ROOT,
			reason: "investigated",
		});
		expect(response).toMatchObject({ status: 503 });
	});

	it("requires master auth, has no actions alias, and derives actor server-side", async () => {
		const store = await StateStore.create(":memory:");
		const now = Date.parse("2026-08-12T12:00:00.000Z");
		store.upsertSession({
			execution_id: "failed-1",
			issue_id: ROOT,
			issue_identifier: "FLY-1718",
			project_name: "flywheel",
			status: "failed",
			session_role: "main",
			started_at: new Date(now - 10_000).toISOString(),
			last_activity_at: new Date(now).toISOString(),
		});
		store.evaluateDoaBackoff({
			projectName: "flywheel",
			lifecycleRootUuid: ROOT,
			issueKeys: [ROOT, "FLY-1718"],
			issueId: ROOT,
			role: "main",
			leadId: "eng",
			successorExecutionId: "successor",
			nowMs: now,
			thresholdMs: 60_000,
			leaseMs: 600_000,
		});
		const app = createBridgeApp(store, projects, config("secret"));

		expect(
			await post(app, "/api/doa-backoff/reset", {
				projectName: "flywheel",
				issueId: ROOT,
				reason: "investigated",
			}),
		).toMatchObject({ status: 401 });
		expect(
			await post(
				app,
				"/api/actions/doa-backoff/reset",
				{ projectName: "flywheel", issueId: ROOT, reason: "investigated" },
				"secret",
			),
		).toMatchObject({ status: 404 });

		const reset = await post(
			app,
			"/api/doa-backoff/reset",
			{
				projectName: "flywheel",
				issueId: "FLY-1718",
				role: "main",
				reason: "predecessor root cause fixed",
				actor: "forged-founder",
			},
			"secret",
		);
		expect(reset).toMatchObject({
			status: 200,
			json: { ok: true, reset: true, previousCount: 1 },
		});
		expect(store.listDoaBackoffResetReceipts()).toEqual([
			expect.objectContaining({ actor: "master-api-token" }),
		]);
	});
});
