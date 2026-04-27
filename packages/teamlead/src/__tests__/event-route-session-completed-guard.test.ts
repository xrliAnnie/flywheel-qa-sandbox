/**
 * FLY-108: session_completed strict route guard + status mapping + FSM reject logging.
 *
 * Covers:
 * - Strict enum guard: route ∈ {auto_approve, needs_review, blocked}
 * - Missing/undefined/empty route → skip (don't upsert session, don't transition)
 * - Invalid route ("garbage", "rejected") → skip
 * - Valid routes map to the expected status
 * - FSM reject logs at error level with pre-state + target + route
 */

import type http from "node:http";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
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

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
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
		...overrides,
	};
}

describe("session_completed route guard (FLY-108)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	async function startRunning(executionId: string, issueId: string) {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: `evt-start-${executionId}`,
				execution_id: executionId,
				issue_id: issueId,
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: { issueIdentifier: "GEO-G1", issueTitle: "Guard test" },
			}),
		});
		expect(res.status).toBe(200);
	}

	async function postCompleted(body: Record<string, unknown>) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify(body),
		});
	}

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		const transitionOpts: ApplyTransitionOpts = { store, fsm, executor };
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			transitionOpts,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;

		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("empty payload → 200 with warning, session status unchanged", async () => {
		await startRunning("exec-empty", "issue-empty");

		const res = await postCompleted({
			event_id: "evt-empty",
			execution_id: "exec-empty",
			issue_id: "issue-empty",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.warning).toBe("invalid route skipped");
		expect(store.getSession("exec-empty")!.status).toBe("running");
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("invalid route"),
		);
	});

	it("decision without route → skip", async () => {
		await startRunning("exec-decnoroute", "issue-decnoroute");

		const res = await postCompleted({
			event_id: "evt-decnoroute",
			execution_id: "exec-decnoroute",
			issue_id: "issue-decnoroute",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: {}, evidence: {} },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-decnoroute")!.status).toBe("running");
	});

	it("route=garbage → skip (strict enum)", async () => {
		await startRunning("exec-garbage", "issue-garbage");

		const res = await postCompleted({
			event_id: "evt-garbage",
			execution_id: "exec-garbage",
			issue_id: "issue-garbage",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "garbage" }, evidence: {} },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-garbage")!.status).toBe("running");
	});

	it("route=rejected → skip (not a DecisionRoute)", async () => {
		await startRunning("exec-rejected", "issue-rejected");

		const res = await postCompleted({
			event_id: "evt-rejected",
			execution_id: "exec-rejected",
			issue_id: "issue-rejected",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "rejected" }, evidence: {} },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-rejected")!.status).toBe("running");
	});

	it("route=auto_approve + empty evidence → awaiting_review (guard pass, FSM runs)", async () => {
		await startRunning("exec-aa-empty", "issue-aa-empty");

		const res = await postCompleted({
			event_id: "evt-aa-empty",
			execution_id: "exec-aa-empty",
			issue_id: "issue-aa-empty",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "auto_approve" }, evidence: {} },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-aa-empty")!.status).toBe("awaiting_review");
	});

	it("route=auto_approve + landingStatus.merged → completed", async () => {
		await startRunning("exec-aa-merged", "issue-aa-merged");

		const res = await postCompleted({
			event_id: "evt-aa-merged",
			execution_id: "exec-aa-merged",
			issue_id: "issue-aa-merged",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "auto_approve" },
				evidence: {
					landingStatus: { status: "merged", prNumber: 42 },
					changedFilePaths: ["x.ts"],
					commitCount: 1,
					filesChangedCount: 1,
					linesAdded: 1,
					linesRemoved: 0,
				},
			},
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-aa-merged")!.status).toBe("completed");
	});

	it("route=needs_review → awaiting_review", async () => {
		await startRunning("exec-nr", "issue-nr");

		const res = await postCompleted({
			event_id: "evt-nr",
			execution_id: "exec-nr",
			issue_id: "issue-nr",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "needs_review" }, evidence: {} },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-nr")!.status).toBe("awaiting_review");
	});

	it("route=blocked → blocked", async () => {
		await startRunning("exec-blk", "issue-blk");

		const res = await postCompleted({
			event_id: "evt-blk",
			execution_id: "exec-blk",
			issue_id: "issue-blk",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "blocked" }, evidence: {} },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-blk")!.status).toBe("blocked");
	});

	it("FSM reject logs at error level with pre-state + target + route", async () => {
		// Put session into a terminal state first via a legit transition.
		await startRunning("exec-fsm-rej", "issue-fsm-rej");
		await postCompleted({
			event_id: "evt-blk-pre",
			execution_id: "exec-fsm-rej",
			issue_id: "issue-fsm-rej",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "blocked" }, evidence: {} },
		});
		expect(store.getSession("exec-fsm-rej")!.status).toBe("blocked");

		// Second session_completed from terminal "blocked" should be rejected by the FSM.
		errorSpy.mockClear();
		await postCompleted({
			event_id: "evt-blk-dup",
			execution_id: "exec-fsm-rej",
			issue_id: "issue-fsm-rej",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "needs_review" }, evidence: {} },
		});

		const errorCalls = errorSpy.mock.calls
			.map((args) => args.join(" "))
			.join("\n");
		expect(errorCalls).toContain("FSM rejected");
		expect(errorCalls).toContain("pre-state=blocked");
		expect(errorCalls).toContain("target=awaiting_review");
		expect(errorCalls).toContain("route=needs_review");
	});
});
