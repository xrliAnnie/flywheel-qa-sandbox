import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { createBridgeApp } from "../plugin.js";
import type { BridgeConfig } from "../types.js";

const EXEC = "11111111-2222-4333-8444-555555555555";
const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel-fly2891-route",
		leads: [],
	},
];

function config(token?: string): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		...(token ? { ingestToken: token } : {}),
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	};
}

async function listen(app: ReturnType<typeof createBridgeApp>) {
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function close(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}

const body = {
	executionId: EXEC,
	reviewType: "code",
	codexThreadId: "01a0daf6-1f50-7522-b7dc-f0b3812a5dab",
	codexTurnId: "01a0daf6-2634-7a23-a8e9-c1669023f451",
	round: 1,
	verdict: "CHANGES_REQUESTED",
	modelEvidence: "rollout_turn",
	observedModel: "gpt-5.6-sol",
	observedEffort: "xhigh",
	reviewedHeadSha: "c".repeat(40),
	reviewedAt: "2026-09-25T11:00:00.000Z",
};

describe("FLY-2891 POST /review-rounds", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: EXEC,
			issue_id: "FLY-2891",
			project_name: "flywheel",
			status: "running",
		});
	});
	afterEach(() => store.close());

	it("records with the ingest token and rejects a wrong one", async () => {
		const { server, baseUrl } = await listen(
			createBridgeApp(store, projects, config("ingest-secret")),
		);
		try {
			const denied = await fetch(`${baseUrl}/review-rounds`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer wrong",
				},
				body: JSON.stringify(body),
			});
			expect(denied.status).toBe(401);
			const ok = await fetch(`${baseUrl}/review-rounds`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer ingest-secret",
				},
				body: JSON.stringify(body),
			});
			expect(ok.status).toBe(200);
			expect(await ok.json()).toMatchObject({
				recorded: true,
				kind: "round",
			});
			const invalid = await fetch(`${baseUrl}/review-rounds`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer ingest-secret",
				},
				body: JSON.stringify({ ...body, round: 0 }),
			});
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toMatchObject({
				recorded: false,
				errorType: "invalid_payload",
			});
			expect(store.reviewRounds.listRoundsForExecutions([EXEC])).toHaveLength(
				1,
			);
		} finally {
			await close(server);
		}
	});

	it("fails closed with 503 when the Bridge has no ingest token", async () => {
		const { server, baseUrl } = await listen(
			createBridgeApp(store, projects, config()),
		);
		try {
			const response = await fetch(`${baseUrl}/review-rounds`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(503);
			expect(store.reviewRounds.listRoundsForExecutions([EXEC])).toEqual([]);
		} finally {
			await close(server);
		}
	});
});

describe("FLY-2891 POST /code-review-validation", () => {
	let store: StateStore;
	const projection = {
		executionId: EXEC,
		reviewType: "code",
		reviewedHeadSha: "c".repeat(40),
		reviewerModel: "gpt-5.6-sol",
		reviewerEffort: "xhigh",
		codexThreadId: "01a0daf6-1f50-7522-b7dc-f0b3812a5dab",
		codexTurnId: "01a0daf6-2634-7a23-a8e9-c1669023f451",
	};
	const post = (baseUrl: string, body: unknown, token = "ingest-secret") =>
		fetch(`${baseUrl}/code-review-validation`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		});
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: EXEC,
			issue_id: "FLY-2891",
			project_name: "flywheel",
			status: "running",
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		store.close();
	});

	it("confirms model validation, denies mismatches readably, and guards input", async () => {
		const { server, baseUrl } = await listen(
			createBridgeApp(store, projects, config("ingest-secret")),
		);
		try {
			const unrouted = await post(baseUrl, projection);
			expect(unrouted.status).toBe(200);
			expect(await unrouted.json()).toEqual({
				allowed: true,
				reviewerModelChecked: true,
			});
			vi.spyOn(store, "getWorkflowRunNodeForExecution").mockReturnValue({
				run_id: "run-1",
				node_id: "implement",
			} as never);
			vi.spyOn(store, "listWorkflowRunEvents").mockReturnValue([
				{
					run_id: "run-1",
					seq: 1,
					event_uid: "review_model_routed:run-1:implement:code:e1",
					kind: "review_model_routed",
					node_id: "implement",
					edge_id: null,
					execution_id: EXEC,
					payload: {
						reviewType: "code",
						requestId: "e1",
						reviewerVendor: "codex",
						reviewerModel: "gpt-5.6-sol",
						reviewerEffort: "xhigh",
					},
					at: "2026-09-25T10:00:00.000Z",
				},
			]);
			expect((await post(baseUrl, projection)).status).toBe(200);
			const denied = await post(baseUrl, {
				...projection,
				reviewerModel: "gpt-6-astra",
			});
			expect(denied.status).toBe(409);
			expect(await denied.json()).toEqual({
				allowed: false,
				reason:
					"reviewer model mismatch: request requires gpt-5.6-sol/xhigh, review ran gpt-6-astra/xhigh",
			});
			const noModel = await post(baseUrl, {
				...projection,
				reviewerModel: undefined,
			});
			expect(noModel.status).toBe(400);
			expect(await noModel.json()).toMatchObject({
				reason: expect.stringContaining("upgrade flywheel-comm"),
			});
			expect(
				(await post(baseUrl, { ...projection, reviewedHeadSha: "x" })).status,
			).toBe(400);
			expect(
				(
					await post(baseUrl, {
						...projection,
						executionId: "99999999-2222-4333-8444-555555555555",
					})
				).status,
			).toBe(404);
			expect((await post(baseUrl, projection, "wrong")).status).toBe(401);
		} finally {
			await close(server);
		}
	});

	it("fails closed with 503 when the Bridge has no ingest token", async () => {
		const { server, baseUrl } = await listen(
			createBridgeApp(store, projects, config()),
		);
		try {
			expect((await post(baseUrl, projection)).status).toBe(503);
		} finally {
			await close(server);
		}
	});
});
