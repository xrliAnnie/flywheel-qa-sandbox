/**
 * FLY-108 Integration: dual session_completed path through Bridge.
 *
 * Covers:
 *   Scenario A (Variant A normal): `needs_review → approve → auto_approve+merged`
 *     - 1st session_completed → awaiting_review (spy not called)
 *     - approve action via applyTransition → approved_to_ship
 *     - 2nd session_completed (auto_approve+merged) → completed (spy called 1x)
 *     - 3rd session_completed with NEW event_id → spy STILL 1x (atomic claim)
 *
 *   Scenario B (Variant B — docs-only compressed pipeline):
 *     - session_started → running
 *     - session_completed (auto_approve+merged) → running → completed (spy 1x)
 *
 * Notes:
 * - vi.mock replaces runPostShipFinalization with a spy so we observe invocation
 *   count without wiring Discord/fetch stubs.
 * - transitionOpts is wired so FSM transitions happen; post-ship gate runs.
 */
import type http from "node:http";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { applyTransition } from "../applyTransition.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

// Mock post-ship-finalization. Keep isPostApproveShipComplete real so the
// gate logic matches production; only runPostShipFinalization is spied.
const runPostShipSpy = vi.fn(async () => {});
vi.mock("../bridge/post-ship-finalization.js", async () => {
	const actual = await vi.importActual<
		typeof import("../bridge/post-ship-finalization.js")
	>("../bridge/post-ship-finalization.js");
	return {
		...actual,
		runPostShipFinalization: (...args: unknown[]) => runPostShipSpy(...args),
	};
});

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

describe("FLY-108 Integration: dual session_completed through Bridge", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let transitionOpts: ApplyTransitionOpts;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	beforeEach(async () => {
		runPostShipSpy.mockClear();
		store = await StateStore.create(":memory:");
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		transitionOpts = { store, fsm, executor };
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
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	async function postEvent(body: Record<string, unknown>) {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify(body),
		});
		return res;
	}

	it("Scenario A: needs_review → approve → auto_approve+merged fires post-ship exactly once", async () => {
		const execId = "exec-scenarioA";
		const issueId = "issue-scenarioA";

		// 1. session_started → running
		const startRes = await postEvent({
			event_id: "evtA-start",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { issueIdentifier: "GEO-A1", issueTitle: "Scenario A" },
		});
		expect(startRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("running");

		// 2. session_completed (needs_review) → awaiting_review
		const needsRes = await postEvent({
			event_id: "evtA-needs",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "needs_review" }, evidence: {} },
		});
		expect(needsRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("awaiting_review");
		expect(runPostShipSpy).not.toHaveBeenCalled();

		// 3. approve action → approved_to_ship (simulate via applyTransition)
		const approveResult = applyTransition(
			transitionOpts,
			execId,
			"approved_to_ship",
			{
				executionId: execId,
				issueId,
				projectName: "geoforge3d",
				trigger: "action:approve",
			},
		);
		expect(approveResult.ok).toBe(true);
		expect(store.getSession(execId)!.status).toBe("approved_to_ship");

		// 4. session_completed (auto_approve + landingStatus.merged) → completed
		const mergedRes = await postEvent({
			event_id: "evtA-merged",
			execution_id: execId,
			issue_id: issueId,
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
		expect(mergedRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("completed");
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);

		// 5. Second session_completed with NEW event_id from terminal state
		// → FSM rejects completed→completed, no second call. (In prod, Runner
		// retries would hit event_id dedup; this tests the FSM rejection path.)
		const dupRes = await postEvent({
			event_id: "evtA-merged-dup",
			execution_id: execId,
			issue_id: issueId,
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
		expect(dupRes.status).toBe(200);
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
	});

	it("Scenario B: docs-only compressed pipeline — running → completed fires post-ship once", async () => {
		const execId = "exec-scenarioB";
		const issueId = "issue-scenarioB";

		// 1. session_started → running
		const startRes = await postEvent({
			event_id: "evtB-start",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { issueIdentifier: "GEO-B1", issueTitle: "Scenario B" },
		});
		expect(startRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("running");

		// 2. session_completed (auto_approve + merged) → running → completed
		const mergedRes = await postEvent({
			event_id: "evtB-merged",
			execution_id: execId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: {
				decision: { route: "auto_approve" },
				evidence: {
					landingStatus: { status: "merged", prNumber: 99 },
					changedFilePaths: ["docs.md"],
					commitCount: 1,
					filesChangedCount: 1,
					linesAdded: 5,
					linesRemoved: 0,
				},
			},
		});
		expect(mergedRes.status).toBe(200);
		expect(store.getSession(execId)!.status).toBe("completed");
		expect(runPostShipSpy).toHaveBeenCalledTimes(1);
	});
});
