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

describe("POST /api/workflow-resume/reopen", () => {
	it("is fail-closed when the master token is not configured", async () => {
		const store = await StateStore.create(":memory:");
		const response = await post(
			createBridgeApp(store, projects, config()),
			"/api/workflow-resume/reopen",
			{ executionId: "exec-1", reason: "process tree verified dead" },
		);
		expect(response.status).toBe(503);
		store.close();
	});

	it("requires master auth, has no actions alias, and derives the audit actor server-side", async () => {
		const store = await StateStore.create(":memory:");
		const reopen = vi
			.spyOn(store, "reopenWorkflowExecutionResume")
			.mockReturnValue({
				ok: true,
				demandId: "rework-1",
				previousAttemptCount: 1,
			});
		const app = createBridgeApp(store, projects, config("secret"));
		const body = {
			executionId: "exec-1",
			reason: "process tree verified dead",
			actor: "forged-founder",
		};

		expect(await post(app, "/api/workflow-resume/reopen", body)).toMatchObject({
			status: 401,
		});
		expect(
			await post(app, "/api/actions/workflow-resume/reopen", body, "secret"),
		).toMatchObject({ status: 404 });
		expect(
			await post(app, "/api/workflow-resume/reopen", body, "secret"),
		).toMatchObject({
			status: 200,
			json: {
				ok: true,
				demandId: "rework-1",
				previousAttemptCount: 1,
			},
		});
		expect(reopen).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-1",
				actor: "master-api-token",
				reason: "process tree verified dead",
			}),
		);
		store.close();
	});
});
