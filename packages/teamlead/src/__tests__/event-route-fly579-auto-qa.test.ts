/**
 * FLY-579 — /events route ↔ AutoQaCoordinator integration. Drives the real
 * createBridgeApp HTTP handler with a real coordinator (real StateStore, fake
 * dispatcher + fake effects) and asserts the full chain:
 *   session_completed(needs_review, main) → awaiting_review → QA spawned + held
 *   qa_result(pass) → record passed + founder ship-ready released.
 */

import type http from "node:http";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import {
	AutoQaCoordinator,
	type AutoQaSideEffects,
} from "../bridge/auto-qa-coordinator.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { StartRequest } from "../bridge/retry-dispatcher.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const HEAD = "a".repeat(40);

const testProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
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
	} as BridgeConfig;
}

describe("event-route ↔ AutoQaCoordinator (FLY-579)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let startCalls: StartRequest[];
	let shipReady: number;
	let posts: string[];

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	async function postEvent(body: Record<string, unknown>) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify(body),
		});
	}

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		startCalls = [];
		shipReady = 0;
		posts = [];

		const effects: AutoQaSideEffects = {
			postThread: ({ text }) => {
				posts.push(text);
			},
			// FLY-643: auto-QA creates a separate QA·FLY-XX issue to run on.
			createQaIssue: () => ({
				issueId: "qa-issue-uuid",
				issueIdentifier: "FLY-700",
				issueTitle: "QA · FLY-579 — auto-qa",
				issueUrl: "https://linear.app/x/issue/FLY-700",
			}),
			notifyShipReady: () => {
				shipReady += 1;
			},
			feedbackWakeMain: () => {},
			alertLeadPipelineError: () => {},
			// FLY-630 ②: parent-thread stage badge (no-op fake — verified separately).
			stampIssueStage: () => {},
		};
		const coordinator = new AutoQaCoordinator({
			store,
			startDispatcher: {
				start: async (req: StartRequest) => {
					startCalls.push(req);
					return { executionId: "qa-1", issueId: req.issueId };
				},
			},
			resolveQaPolicy: () => ({ enabled: true }),
			effects,
		});

		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		const transitionOpts: ApplyTransitionOpts = { store, fsm, executor };
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			transitionOpts,
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
			{ autoQaCoordinator: { current: coordinator } },
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		vi.restoreAllMocks();
	});

	async function startRunning(executionId: string, role = "main") {
		await postEvent({
			event_id: `evt-start-${executionId}`,
			execution_id: executionId,
			issue_id: "FLY-579",
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: {
				issueIdentifier: "FLY-579",
				issueTitle: "auto-qa",
				sessionRole: role,
			},
		});
	}

	it("session_completed(needs_review,main) → spawns QA pinned to head + holds (durable record)", async () => {
		await startRunning("main-1");
		const res = await postEvent({
			event_id: "evt-complete-1",
			execution_id: "main-1",
			issue_id: "FLY-579",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: {
					commitCount: 1,
					filesChangedCount: 1,
					linesAdded: 1,
					linesRemoved: 0,
					diffSummary: "1 file changed",
					changedFilePaths: ["a.ts"],
					commitMessages: ["feat: x"],
					headSha: HEAD,
				},
				sessionRole: "main",
				reviewQuestionId: "11111111-1111-1111-1111-111111111111",
			},
		});
		expect(res.status).toBe(200);

		// QA spawned on the SEPARATE QA issue, pinned to the reviewed commit, with
		// QA context pointing back at the parent + the backend pinned to the
		// transported Claude lane (FLY-643).
		expect(startCalls).toHaveLength(1);
		expect(startCalls[0].sessionRole).toBe("qa");
		expect(startCalls[0].issueId).toBe("qa-issue-uuid");
		expect(startCalls[0].ignoreRunnerLabelSelection).toBe(true);
		expect(startCalls[0].startPoint).toBe(HEAD);
		expect(startCalls[0].qaContext?.prHeadSha).toBe(HEAD);
		expect(startCalls[0].qaContext?.parentExecutionId).toBe("main-1");

		// Durable held record exists, with the separate QA issue persisted.
		const rec = store.getAutoQaRecord("main-1", HEAD);
		expect(rec?.status).toBe("running");
		expect(rec?.qa_execution_id).toBe("qa-1");
		expect(rec?.qa_issue_id).toBe("qa-issue-uuid");
	});

	it("qa_result(pass) → record passed + founder ship-ready released", async () => {
		await startRunning("main-1");
		await postEvent({
			event_id: "evt-complete-2",
			execution_id: "main-1",
			issue_id: "FLY-579",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: {
					commitCount: 1,
					filesChangedCount: 1,
					linesAdded: 1,
					linesRemoved: 0,
					diffSummary: "x",
					changedFilePaths: ["a.ts"],
					commitMessages: ["feat: x"],
					headSha: HEAD,
				},
				sessionRole: "main",
				reviewQuestionId: "22222222-2222-2222-2222-222222222222",
			},
		});
		// Register the QA session so the verdict linkage check passes.
		await startRunning("qa-1", "qa");

		const res = await postEvent({
			event_id: "evt-qa-result-1",
			execution_id: "qa-1",
			issue_id: "FLY-579",
			project_name: "geoforge3d",
			event_type: "qa_result",
			payload: {
				status: "pass",
				targetExecutionId: "main-1",
				qaExecutionId: "qa-1",
				prHeadSha: HEAD,
				summary: "verified end to end",
			},
		});
		expect(res.status).toBe(200);
		expect(store.getAutoQaRecord("main-1", HEAD)?.status).toBe("passed");
		expect(shipReady).toBe(1);
	});
});
