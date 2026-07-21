import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateStore } from "../../StateStore.js";
import { createRunsRouter } from "../runs-route.js";

const fakeDispatcher = {
	getInflightCount: () => 0,
} as Parameters<typeof createRunsRouter>[0];

const fakeAdmission = {
	tryAdmit: () => ({ admit: false, reason: "load", detail: "unused" }),
} as Parameters<typeof createRunsRouter>[3];

let server: Server | undefined;

afterEach(async () => {
	if (!server) return;
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = undefined;
});

async function startApp(store: StateStore): Promise<string> {
	const app = express();
	app.use(express.json());
	app.use(
		"/api/runs",
		createRunsRouter(
			fakeDispatcher,
			store,
			[],
			fakeAdmission,
			undefined,
			false,
			undefined,
			{ masterToken: "master-secret", scopedToken: "scoped-secret" },
		),
	);
	server = createServer(app);
	await new Promise<void>((resolve, reject) => {
		server?.once("error", reject);
		server?.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

function managementStore(result: ReturnType<typeof vi.fn>) {
	return {
		getWorkflowRun: (runId: string) =>
			runId === "run-1"
				? { run_id: runId, project_name: "flywheel", status: "active" }
				: undefined,
		listRunAttributedExecutions: () => [],
		holdWorkflowRunByOperator: result,
		terminateWorkflowRunByOperator: result,
	} as unknown as StateStore;
}

async function post(
	baseUrl: string,
	action: "hold" | "terminate",
	token = "master-secret",
) {
	return fetch(`${baseUrl}/api/runs/run-1/${action}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			reason: "  operator recovery  ",
			clientRequestId: `request-${action}`,
		}),
	});
}

describe("runs-route run management", () => {
	it.each(["hold", "terminate"] as const)(
		"authorizes and audits a quiescent %s request",
		async (action) => {
			const change = vi.fn(() => ({
				ok: true as const,
				status: action === "hold" ? ("held" as const) : ("terminated" as const),
				idempotentReplay: false,
			}));
			const baseUrl = await startApp(managementStore(change));

			const response = await post(baseUrl, action);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				success: true,
				runId: "run-1",
				status: action === "hold" ? "held" : "terminated",
			});
			expect(change).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: "run-1",
					reason: "operator recovery",
					clientRequestId: `request-${action}`,
					principal: "master",
					evidence: [],
				}),
			);
		},
	);

	it("rejects a scoped token before reading run state", async () => {
		const change = vi.fn();
		const store = managementStore(change);
		const getRun = vi.spyOn(store, "getWorkflowRun");
		const baseUrl = await startApp(store);

		const response = await post(baseUrl, "hold", "scoped-secret");

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: "MASTER_AUTH_REQUIRED",
		});
		expect(getRun).not.toHaveBeenCalled();
		expect(change).not.toHaveBeenCalled();
	});

	it("maps a quiescence refusal to a typed conflict", async () => {
		const change = vi.fn(() => ({
			ok: false as const,
			reason: "run_has_live_executions",
			executionIds: ["exec-live"],
		}));
		const baseUrl = await startApp(managementStore(change));

		const response = await post(baseUrl, "hold");

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			success: false,
			code: "RUN_HAS_LIVE_EXECUTIONS",
			reason: "run_has_live_executions",
			executionIds: ["exec-live"],
		});
	});
});
