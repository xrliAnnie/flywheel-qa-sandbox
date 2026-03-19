import type http from "node:http";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
		lead: { agentId: "product-lead", channel: "test-channel" },
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

/**
 * FSM-aware E2E tests — full lifecycle with WorkflowFSM validation + audit trail.
 * Unlike bridge-e2e.test.ts (legacy path), this creates transitionOpts explicitly.
 */
describe("FSM E2E lifecycle", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let transitionOpts: ApplyTransitionOpts;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	beforeEach(async () => {
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

	it("full lifecycle: start → complete → reject → retry via FSM", async () => {
		// 1. session_started → running (FSM: pending → running)
		const startRes = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-fsm-1",
				execution_id: "exec-fsm",
				issue_id: "issue-fsm",
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: { issueIdentifier: "GEO-300", issueTitle: "FSM test" },
			}),
		});
		expect(startRes.status).toBe(200);
		expect(store.getSession("exec-fsm")!.status).toBe("running");

		// 2. session_completed (needs_review) → awaiting_review
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-fsm-2",
				execution_id: "exec-fsm",
				issue_id: "issue-fsm",
				project_name: "geoforge3d",
				event_type: "session_completed",
				payload: {
					decision: { route: "needs_review", reasoning: "has changes" },
					evidence: { commitCount: 5, linesAdded: 100, linesRemoved: 20 },
				},
			}),
		});
		expect(store.getSession("exec-fsm")!.status).toBe("awaiting_review");

		// 3. Action: reject → rejected (FSM: awaiting_review → rejected)
		const rejectRes = await fetch(`${baseUrl}/actions/reject`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				execution_id: "exec-fsm",
				reason: "needs more work",
			}),
		});
		expect(rejectRes.status).toBe(200);
		const rejectBody = await rejectRes.json();
		expect(rejectBody.success).toBe(true);
		expect(store.getSession("exec-fsm")!.status).toBe("rejected");

		// 4. GEO-168: retry is now a composite action — without dispatcher, FSM rejects rejected→running
		const retryRes = await fetch(`${baseUrl}/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-fsm" }),
		});
		expect(retryRes.status).toBe(400);
		expect((await retryRes.json()).success).toBe(false);
		// Old session stays rejected (GEO-168: retry no longer transitions old execution)
		expect(store.getSession("exec-fsm")!.status).toBe("rejected");

		// 5. Verify audit trail in session_events (3 transitions, not 4 — retry doesn't transition)
		await new Promise((r) => setTimeout(r, 100));
		const events = store.getEventsByExecution("exec-fsm");
		const audits = events.filter((e) => e.event_type === "state_transition");
		expect(audits.length).toBeGreaterThanOrEqual(3);

		const transitions = audits.map((e) => {
			const p = e.payload as { from: string; to: string };
			return `${p.from} → ${p.to}`;
		});
		expect(transitions).toContain("pending → running");
		expect(transitions).toContain("running → awaiting_review");
		expect(transitions).toContain("awaiting_review → rejected");
	});

	it("FSM rejects illegal action transition", async () => {
		// Setup: start a session → it's running
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-illegal-1",
				execution_id: "exec-illegal",
				issue_id: "issue-illegal",
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: { issueIdentifier: "GEO-301" },
			}),
		});
		expect(store.getSession("exec-illegal")!.status).toBe("running");

		// Try to approve a running session → FSM should reject (approve requires awaiting_review)
		const approveRes = await fetch(`${baseUrl}/actions/approve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-illegal" }),
		});
		const body = await approveRes.json();
		// approve pre-check rejects because status is "running", not "awaiting_review"
		expect(body.success).toBe(false);
		// Status unchanged
		expect(store.getSession("exec-illegal")!.status).toBe("running");
	});

	it("shelve action from multiple states via FSM", async () => {
		// Start → complete (blocked) → shelve
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-shelve-1",
				execution_id: "exec-shelve",
				issue_id: "issue-shelve",
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: { issueIdentifier: "GEO-302" },
			}),
		});
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-shelve-2",
				execution_id: "exec-shelve",
				issue_id: "issue-shelve",
				project_name: "geoforge3d",
				event_type: "session_completed",
				payload: {
					decision: { route: "blocked", reasoning: "dependency missing" },
				},
			}),
		});
		expect(store.getSession("exec-shelve")!.status).toBe("blocked");

		// Shelve from blocked
		const shelveRes = await fetch(`${baseUrl}/actions/shelve`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-shelve" }),
		});
		expect((await shelveRes.json()).success).toBe(true);
		expect(store.getSession("exec-shelve")!.status).toBe("shelved");
	});

	it("metadata is persisted via patchSessionMetadata on completed", async () => {
		// Start → complete with evidence
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-meta-1",
				execution_id: "exec-meta",
				issue_id: "issue-meta",
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: { issueIdentifier: "GEO-303", issueTitle: "Metadata test" },
			}),
		});
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-meta-2",
				execution_id: "exec-meta",
				issue_id: "issue-meta",
				project_name: "geoforge3d",
				event_type: "session_completed",
				payload: {
					decision: { route: "needs_review", reasoning: "review plz" },
					evidence: {
						commitCount: 7,
						filesChangedCount: 12,
						linesAdded: 300,
						linesRemoved: 50,
						diffSummary: "big refactor",
					},
					summary: "Refactored everything",
				},
			}),
		});

		const session = store.getSession("exec-meta")!;
		expect(session.status).toBe("awaiting_review");
		expect(session.commit_count).toBe(7);
		expect(session.files_changed).toBe(12);
		expect(session.lines_added).toBe(300);
		expect(session.lines_removed).toBe(50);
		expect(session.decision_route).toBe("needs_review");
		expect(session.summary).toBe("Refactored everything");
	});

	it("dashboard payload includes allowedActions from FSM", async () => {
		// Start → complete → awaiting_review
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-dash-1",
				execution_id: "exec-dash",
				issue_id: "issue-dash",
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: { issueIdentifier: "GEO-304" },
			}),
		});
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify({
				event_id: "evt-dash-2",
				execution_id: "exec-dash",
				issue_id: "issue-dash",
				project_name: "geoforge3d",
				event_type: "session_completed",
				payload: { decision: { route: "needs_review" } },
			}),
		});

		// SSE snapshot includes allowedActions
		const sseRes = await fetch(`${baseUrl}/sse`);
		const text = await sseRes.text();
		const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
		expect(dataLine).toBeDefined();
		const payload = JSON.parse(dataLine!.replace("data: ", ""));
		const activeSession = payload.active.find(
			(s: any) => s.execution_id === "exec-dash",
		);
		expect(activeSession).toBeDefined();
		expect(activeSession.allowedActions).toContain("approve");
		expect(activeSession.allowedActions).toContain("reject");
		expect(activeSession.allowedActions).toContain("defer");
		expect(activeSession.allowedActions).toContain("shelve");
		expect(activeSession.allowedActions).not.toContain("retry");
	});
});
