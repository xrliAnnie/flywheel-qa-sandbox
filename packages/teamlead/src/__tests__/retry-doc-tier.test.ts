/**
 * FLY-205 — retry doc-tier continuity.
 *
 * The retry path must REUSE the predecessor session's doc_tier (never
 * silently upgrade plan_only/none back to full — Codex design R1 #3) and
 * carry issue_url so the DOC-FLOW header is identical between start and
 * retry prompts (Codex design R2 #2). The tier must also be persisted on
 * the retry SUCCESSOR row so a retry-of-retry does not drift (R2 #1).
 */

import type http from "node:http";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type {
	IRetryDispatcher,
	RetryRequest,
} from "../bridge/retry-dispatcher.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "sub",
		projectRoot: "/tmp/sub",
		leads: [
			{
				agentId: "sub-lead",
				chatChannel: "test-chat",
				match: { labels: ["Sub"] },
				department: "content",
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
		defaultLeadAgentId: "sub-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	};
}

function createMockRetryDispatcher(store: StateStore): IRetryDispatcher & {
	_requests: RetryRequest[];
} {
	let n = 0;
	const mock = {
		_requests: [] as RetryRequest[],
		dispatch: vi.fn(async (req: RetryRequest) => {
			mock._requests.push(req);
			n++;
			const newExecutionId = `retry-exec-${n}`;
			// Successor session row appears (Blueprint would create it via
			// emitStarted in production)
			store.upsertSession({
				execution_id: newExecutionId,
				issue_id: req.issueId,
				project_name: req.projectName,
				status: "running",
			});
			return { newExecutionId, oldExecutionId: req.oldExecutionId };
		}),
		getInflightIssues: vi.fn(() => new Set<string>()),
		hasInflightForRole: vi.fn(() => false),
		stopAccepting: vi.fn(),
		drain: vi.fn(async () => {}),
		teardownRuntimes: vi.fn(async () => {}),
	};
	return mock;
}

describe("FLY-205 — retry doc-tier continuity", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let retryDispatcher: ReturnType<typeof createMockRetryDispatcher>;
	let savedLinearKey: string | undefined;

	beforeEach(async () => {
		// No LINEAR_API_KEY → retry uses stored codex_skip (warn path), no
		// Linear network calls in this test.
		savedLinearKey = process.env.LINEAR_API_KEY;
		delete process.env.LINEAR_API_KEY;
		store = await StateStore.create(":memory:");
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		const transitionOpts: ApplyTransitionOpts = { store, fsm, executor };
		retryDispatcher = createMockRetryDispatcher(store);
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			transitionOpts,
			retryDispatcher,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		if (savedLinearKey !== undefined) {
			process.env.LINEAR_API_KEY = savedLinearKey;
		}
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	function seedFailedSession(executionId: string): void {
		store.upsertSession({
			execution_id: executionId,
			issue_id: "LEARN-21",
			project_name: "sub",
			status: "failed",
			issue_identifier: "LEARN-21",
			issue_title: "深度睡眠包",
			doc_tier: "plan_only",
			issue_url: "https://linear.app/x/issue/LEARN-21",
		});
	}

	it("retry reuses predecessor doc_tier + issue_url (no silent upgrade to full)", async () => {
		seedFailedSession("exec-orig");
		const res = await fetch(`${baseUrl}/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-orig" }),
		});
		expect(res.status).toBe(200);
		expect(retryDispatcher._requests).toHaveLength(1);
		expect(retryDispatcher._requests[0]!.docTier).toBe("plan_only");
		expect(retryDispatcher._requests[0]!.issueUrl).toBe(
			"https://linear.app/x/issue/LEARN-21",
		);
	});

	it("successor row persists the tier — retry-of-retry does not drift to full", async () => {
		seedFailedSession("exec-orig2");
		const res1 = await fetch(`${baseUrl}/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-orig2" }),
		});
		expect(res1.status).toBe(200);
		const successor = store.getSession("retry-exec-1");
		expect(successor?.doc_tier).toBe("plan_only");
		expect(successor?.issue_url).toBe("https://linear.app/x/issue/LEARN-21");

		// Fail the successor, retry IT → tier must still be plan_only
		store.forceStatus("retry-exec-1", "failed", new Date().toISOString());
		const res2 = await fetch(`${baseUrl}/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "retry-exec-1" }),
		});
		expect(res2.status).toBe(200);
		expect(retryDispatcher._requests[1]!.docTier).toBe("plan_only");
		const successor2 = store.getSession("retry-exec-2");
		expect(successor2?.doc_tier).toBe("plan_only");
	});

	it("DELAYED successor row creation (production race) — patch still lands (Codex code R1 HIGH-2)", async () => {
		seedFailedSession("exec-race");
		// Production shape: dispatch() returns BEFORE emitStarted() creates the
		// successor row. Simulate with a delayed row creation.
		retryDispatcher.dispatch.mockImplementationOnce(
			async (req: RetryRequest) => {
				retryDispatcher._requests.push(req);
				const newExecutionId = "retry-exec-delayed";
				setTimeout(() => {
					store.upsertSession({
						execution_id: newExecutionId,
						issue_id: req.issueId,
						project_name: req.projectName,
						status: "running",
					});
				}, 400);
				return { newExecutionId, oldExecutionId: req.oldExecutionId };
			},
		);
		const res = await fetch(`${baseUrl}/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-race" }),
		});
		expect(res.status).toBe(200);
		// waitForSession must have bridged the gap: tier persisted on successor
		const successor = store.getSession("retry-exec-delayed");
		expect(successor).toBeDefined();
		expect(successor?.doc_tier).toBe("plan_only");
		expect(successor?.issue_url).toBe("https://linear.app/x/issue/LEARN-21");
	}, 15_000);

	it("pre-FLY-205 session (no doc_tier) → docTier undefined in request, successor persisted as full", async () => {
		store.upsertSession({
			execution_id: "exec-legacy",
			issue_id: "LEARN-22",
			project_name: "sub",
			status: "failed",
			issue_identifier: "LEARN-22",
		});
		const res = await fetch(`${baseUrl}/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-legacy" }),
		});
		expect(res.status).toBe(200);
		expect(retryDispatcher._requests[0]!.docTier).toBeUndefined();
		// Successor explicitly records the effective tier (full)
		const successor = store.getSession("retry-exec-1");
		expect(successor?.doc_tier).toBe("full");
	});

	// FLY-728 Part C — retry REUSES the predecessor's persisted `dispatch_model`
	// (the sorter's dispatch param ONLY), source-honestly — NOT the resolved
	// runner_model (Codex design R1 HIGH-2: runner_model conflates label/project/
	// account sources; re-deriving from it would reintroduce a removed label's or
	// a stale project default's model).
	function seedFailed(
		executionId: string,
		cols: { runner_model?: string; dispatch_model?: string },
	): void {
		store.upsertSession({
			execution_id: executionId,
			issue_id: "LEARN-23",
			project_name: "sub",
			status: "failed",
			issue_identifier: "LEARN-23",
			...cols,
		});
	}

	it("retry reuses a persisted dispatch_model (sorter choice survives)", async () => {
		seedFailed("exec-m1", {
			dispatch_model: "claude-fable-5",
			runner_model: "claude-fable-5",
		});
		const res = await fetch(`${baseUrl}/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-m1" }),
		});
		expect(res.status).toBe(200);
		expect(retryDispatcher._requests[0]!.dispatchModel).toBe("claude-fable-5");
	});

	it("retry with no dispatch_model → dispatchModel undefined (re-resolve from current state)", async () => {
		seedFailed("exec-m2", {});
		const res = await fetch(`${baseUrl}/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-m2" }),
		});
		expect(res.status).toBe(200);
		expect(retryDispatcher._requests[0]!.dispatchModel).toBeUndefined();
	});

	it("a label-derived runner_model (no dispatch_model) is NOT reintroduced on retry", async () => {
		// Original ran Fable because of a manual `fable` label (no dispatch param).
		// The label may be removed before retry — so its model must NOT come back
		// via runner_model. Only dispatch_model (NULL here) drives dispatchModel.
		seedFailed("exec-m3", { runner_model: "claude-fable-5" });
		const res = await fetch(`${baseUrl}/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-m3" }),
		});
		expect(res.status).toBe(200);
		expect(retryDispatcher._requests[0]!.dispatchModel).toBeUndefined();
	});

	it("successor row persists dispatch_model — retry-of-retry keeps the sorter model", async () => {
		seedFailed("exec-m4", { dispatch_model: "claude-fable-5" });
		const res1 = await fetch(`${baseUrl}/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "exec-m4" }),
		});
		expect(res1.status).toBe(200);
		// The successor row carries dispatch_model forward.
		expect(store.getSession("retry-exec-1")?.dispatch_model).toBe(
			"claude-fable-5",
		);
		// Fail the successor + retry IT → the model must still survive.
		store.forceStatus("retry-exec-1", "failed", new Date().toISOString());
		const res2 = await fetch(`${baseUrl}/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "retry-exec-1" }),
		});
		expect(res2.status).toBe(200);
		expect(retryDispatcher._requests[1]!.dispatchModel).toBe("claude-fable-5");
		expect(store.getSession("retry-exec-2")?.dispatch_model).toBe(
			"claude-fable-5",
		);
	});
});
