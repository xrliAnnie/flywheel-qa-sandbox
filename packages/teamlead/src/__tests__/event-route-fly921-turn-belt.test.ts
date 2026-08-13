/**
 * /events wiring pins for workflow TURN reconciliation. A workflow actor
 * reaching a terminal signal must trigger a scoped reconcile carrying that
 * execution as terminalExecId. Sister pins: DirectEventSink.test.ts.
 */

import type http from "node:http";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { TurnBeltReconciler } from "../bridge/turn-belt-reconcile.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Flywheel"] },
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
		defaultLeadAgentId: "flywheel-eng-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	} as BridgeConfig;
}

describe("event-route turn-belt reconcile wiring (FLY-921 Fix C)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let reconcileCalls: Array<Record<string, unknown> | undefined>;

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
		reconcileCalls = [];

		const turnBeltReconciler = {
			reconcileTurnBelt: vi.fn(async (scope?: Record<string, unknown>) => {
				reconcileCalls.push(scope);
			}),
		} as unknown as TurnBeltReconciler;

		// Real FSM transitionOpts — the Codex R1 HIGH shape needs the genuine
		// awaiting_review→failed FSM rejection, not a transition-less upsert.
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
			{
				turnBeltReconciler: { current: turnBeltReconciler },
			},
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

	function seedPhaseSession(execId: string, role: string, status = "running") {
		store.upsertSession({
			execution_id: execId,
			issue_id: "FLY-543",
			project_name: "flywheel",
			status,
			session_role: role,
			chat_thread_role: role === "main" ? "main" : role,
		});
	}

	it("session_failed of a workflow actor → scoped reconcile with terminalExecId", async () => {
		seedPhaseSession("qa-exec-1", "qa");
		const res = await postEvent({
			event_id: "evt-fail-1",
			execution_id: "qa-exec-1",
			issue_id: "FLY-543",
			project_name: "flywheel",
			event_type: "session_failed",
			payload: { error: "killed by lead" },
		});
		expect(res.status).toBe(200);
		expect(reconcileCalls).toHaveLength(1);
		expect(reconcileCalls[0]).toMatchObject({
			issueId: "FLY-543",
			projectName: "flywheel",
			terminalExecId: "qa-exec-1",
		});
	});

	it("session_completed of a workflow actor → scoped reconcile", async () => {
		seedPhaseSession("impl-exec-1", "implement");
		const res = await postEvent({
			event_id: "evt-done-1",
			execution_id: "impl-exec-1",
			issue_id: "FLY-543",
			project_name: "flywheel",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: {},
			},
		});
		expect(res.status).toBe(200);
		expect(reconcileCalls).toHaveLength(1);
		expect(reconcileCalls[0]).toMatchObject({
			issueId: "FLY-543",
			projectName: "flywheel",
			terminalExecId: "impl-exec-1",
		});
	});

	it("Codex R1 HIGH: session_failed of a PARKED (awaiting_review) holder — FSM rejects the transition, reconcile still runs", async () => {
		// The FLY-543 kill shape: the holder is parked at awaiting_review; the
		// WorkflowFSM has no awaiting_review→failed edge, so applyTransition
		// rejects and the handler early-returns — the stale-holder recovery must
		// NOT be skipped (the process is dead regardless of the status flip).
		seedPhaseSession("impl-parked", "implement", "awaiting_review");
		const res = await postEvent({
			event_id: "evt-fail-parked",
			execution_id: "impl-parked",
			issue_id: "FLY-543",
			project_name: "flywheel",
			event_type: "session_failed",
			payload: { error: "killed by lead" },
		});
		expect(res.status).toBe(200);
		// Status stays awaiting_review (FSM rejected) …
		expect(store.getSession("impl-parked")!.status).toBe("awaiting_review");
		// … but the scoped reconcile ran anyway.
		expect(reconcileCalls).toHaveLength(1);
		expect(reconcileCalls[0]).toMatchObject({
			issueId: "FLY-543",
			projectName: "flywheel",
			terminalExecId: "impl-parked",
		});
	});

	it("byte-compat: a main-role session's failure does NOT touch the turn belt", async () => {
		seedPhaseSession("main-exec-1", "main");
		const res = await postEvent({
			event_id: "evt-fail-main",
			execution_id: "main-exec-1",
			issue_id: "FLY-543",
			project_name: "flywheel",
			event_type: "session_failed",
			payload: { error: "boom" },
		});
		expect(res.status).toBe(200);
		expect(reconcileCalls).toHaveLength(0);
	});
});
