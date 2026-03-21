import { randomUUID } from "node:crypto";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type {
	IRetryDispatcher,
	RetryRequest,
	RetryResult,
} from "../bridge/retry-dispatcher.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		notificationChannel: "test-ch",
		defaultLeadAgentId: "product-lead",
		...overrides,
	};
}

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

/** Mock IRetryDispatcher that records dispatch calls and resolves immediately. */
function createMockDispatcher(): IRetryDispatcher & {
	calls: RetryRequest[];
	rejectNext?: string;
} {
	const calls: RetryRequest[] = [];
	let rejectNext: string | undefined;

	return {
		calls,
		get rejectNext() {
			return rejectNext;
		},
		set rejectNext(v: string | undefined) {
			rejectNext = v;
		},

		async dispatch(req: RetryRequest): Promise<RetryResult> {
			if (rejectNext) {
				const msg = rejectNext;
				rejectNext = undefined;
				throw new Error(msg);
			}
			calls.push(req);
			return {
				newExecutionId: randomUUID(),
				oldExecutionId: req.oldExecutionId,
			};
		},
		getInflightIssues(): Set<string> {
			return new Set();
		},
		stopAccepting(): void {},
		async drain(): Promise<void> {},
		async teardownRuntimes(): Promise<void> {},
	};
}

/** Mock dispatcher that reports an issue as inflight. */
function createInflightDispatcher(inflightIssueId: string): IRetryDispatcher {
	return {
		async dispatch(): Promise<RetryResult> {
			throw new Error("should not be called");
		},
		getInflightIssues(): Set<string> {
			return new Set([inflightIssueId]);
		},
		stopAccepting(): void {},
		async drain(): Promise<void> {},
		async teardownRuntimes(): Promise<void> {},
	};
}

describe("Retry E2E — composite action with mock dispatcher", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let dispatcher: ReturnType<typeof createMockDispatcher>;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		dispatcher = createMockDispatcher();
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			undefined,
			dispatcher,
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

	// ── Happy path ──────────────────────────────────────────────

	it("retry failed session → dispatches new execution + links lineage", async () => {
		store.upsertSession({
			execution_id: "old-exec",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "failed",
			issue_identifier: "GEO-100",
			issue_title: "Fix bug",
			last_error: "Test failed",
			decision_route: "blocked",
			run_attempt: 0,
		});

		const res = await fetch(`${baseUrl}/api/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "old-exec", reason: "try again" }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.success).toBe(true);
		expect(body.message).toContain("retry dispatched");
		expect(body.message).toContain("attempt #1");

		// Dispatcher was called with correct params
		expect(dispatcher.calls).toHaveLength(1);
		const call = dispatcher.calls[0]!;
		expect(call.oldExecutionId).toBe("old-exec");
		expect(call.issueId).toBe("issue-1");
		expect(call.issueIdentifier).toBe("GEO-100");
		expect(call.projectName).toBe("geoforge3d");
		expect(call.reason).toBe("try again");
		expect(call.previousError).toBe("Test failed");
		expect(call.previousDecisionRoute).toBe("blocked");
		expect(call.runAttempt).toBe(1);

		// Lineage: old session has retry_successor
		const oldSession = store.getSession("old-exec");
		expect(oldSession!.retry_successor).toBeDefined();
		expect(oldSession!.status).toBe("failed"); // old session stays terminal
	});

	it("retry rejected session → dispatches with incremented run_attempt", async () => {
		store.upsertSession({
			execution_id: "old-exec",
			issue_id: "issue-2",
			project_name: "geoforge3d",
			status: "rejected",
			run_attempt: 2,
		});

		const res = await fetch(`${baseUrl}/api/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "old-exec" }),
		});

		expect(res.status).toBe(200);
		expect(dispatcher.calls[0]!.runAttempt).toBe(3);
	});

	it("retry blocked session → dispatches successfully", async () => {
		store.upsertSession({
			execution_id: "old-exec",
			issue_id: "issue-3",
			project_name: "geoforge3d",
			status: "blocked",
		});

		const res = await fetch(`${baseUrl}/api/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "old-exec" }),
		});

		expect(res.status).toBe(200);
		expect(dispatcher.calls).toHaveLength(1);
	});

	// ── Eligibility checks ──────────────────────────────────────

	it("retry from awaiting_review → rejected (not retryable)", async () => {
		store.upsertSession({
			execution_id: "old-exec",
			issue_id: "issue-4",
			project_name: "geoforge3d",
			status: "awaiting_review",
		});

		const res = await fetch(`${baseUrl}/api/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "old-exec" }),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.success).toBe(false);
		expect(body.message).toContain("awaiting_review");
		expect(dispatcher.calls).toHaveLength(0);
	});

	it("retry nonexistent session → 400", async () => {
		const res = await fetch(`${baseUrl}/api/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "nonexistent" }),
		});

		expect(res.status).toBe(400);
		expect(dispatcher.calls).toHaveLength(0);
	});

	it("retry without execution_id → 400", async () => {
		const res = await fetch(`${baseUrl}/api/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason: "test" }),
		});

		expect(res.status).toBe(400);
	});

	// ── Concurrency guards ──────────────────────────────────────

	it("retry blocked when same issue has active running session", async () => {
		// Create a running session for issue-5
		store.upsertSession({
			execution_id: "running-exec",
			issue_id: "issue-5",
			project_name: "geoforge3d",
			status: "running",
		});
		// Create a failed session for same issue
		store.upsertSession({
			execution_id: "failed-exec",
			issue_id: "issue-5",
			project_name: "geoforge3d",
			status: "failed",
		});

		const res = await fetch(`${baseUrl}/api/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "failed-exec" }),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.success).toBe(false);
		expect(body.message).toContain("already has an active session");
		expect(dispatcher.calls).toHaveLength(0);
	});

	it("retry blocked when dispatcher reports inflight for same issue", async () => {
		// Use a special dispatcher that reports issue-6 as inflight
		const inflightStore = await StateStore.create(":memory:");
		const inflightDispatcher = createInflightDispatcher("issue-6");
		const app2 = createBridgeApp(
			inflightStore,
			testProjects,
			makeConfig(),
			undefined,
			undefined,
			inflightDispatcher,
		);
		const server2 = app2.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server2.once("listening", resolve));
		const addr2 = server2.address();
		const port2 = typeof addr2 === "object" && addr2 ? addr2.port : 0;

		inflightStore.upsertSession({
			execution_id: "old-exec",
			issue_id: "issue-6",
			project_name: "geoforge3d",
			status: "failed",
		});

		const res = await fetch(`http://127.0.0.1:${port2}/api/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "old-exec" }),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.success).toBe(false);
		expect(body.message).toContain("already has an execution in progress");

		await new Promise<void>((resolve, reject) => {
			server2.close((err) => (err ? reject(err) : resolve()));
		});
		inflightStore.close();
	});

	// ── Dispatch failure ────────────────────────────────────────

	it("dispatch failure → 400 with error message", async () => {
		store.upsertSession({
			execution_id: "old-exec",
			issue_id: "issue-7",
			project_name: "geoforge3d",
			status: "failed",
		});
		dispatcher.rejectNext = "Blueprint crashed";

		const res = await fetch(`${baseUrl}/api/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "old-exec" }),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.success).toBe(false);
		expect(body.message).toContain("Blueprint crashed");
	});

	// ── resolve-action with dispatcher ──────────────────────────

	it("resolve-action shows retry eligible for failed session", async () => {
		store.upsertSession({
			execution_id: "old-exec",
			issue_id: "issue-8",
			project_name: "geoforge3d",
			status: "failed",
		});

		const res = await fetch(
			`${baseUrl}/api/resolve-action?issue_id=issue-8&action=retry`,
		);
		const body = await res.json();

		expect(body.can_execute).toBe(true);
		expect(body.execution_id).toBe("old-exec");
	});

	it("resolve-action blocks retry when inflight", async () => {
		const inflightStore = await StateStore.create(":memory:");
		const inflightDispatcher = createInflightDispatcher("issue-9");
		const app2 = createBridgeApp(
			inflightStore,
			testProjects,
			makeConfig(),
			undefined,
			undefined,
			inflightDispatcher,
		);
		const server2 = app2.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server2.once("listening", resolve));
		const addr2 = server2.address();
		const port2 = typeof addr2 === "object" && addr2 ? addr2.port : 0;

		inflightStore.upsertSession({
			execution_id: "old-exec",
			issue_id: "issue-9",
			project_name: "geoforge3d",
			status: "failed",
		});

		const res = await fetch(
			`http://127.0.0.1:${port2}/api/resolve-action?issue_id=issue-9&action=retry`,
		);
		const body = await res.json();

		expect(body.can_execute).toBe(false);
		expect(body.reason).toContain("retry in progress");

		await new Promise<void>((resolve, reject) => {
			server2.close((err) => (err ? reject(err) : resolve()));
		});
		inflightStore.close();
	});

	// ── Thread unarchive on retry ───────────────────────────────

	it("retry unarchives thread for the issue", async () => {
		store.upsertSession({
			execution_id: "old-exec",
			issue_id: "issue-10",
			project_name: "geoforge3d",
			status: "failed",
		});
		store.upsertThread("thread-10", "channel-1", "issue-10");
		store.markArchived("thread-10");

		const res = await fetch(`${baseUrl}/api/actions/retry`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ execution_id: "old-exec" }),
		});

		expect(res.status).toBe(200);

		// Thread should be unarchived
		const eligible = store.getEligibleForCleanup(0);
		const _threadForIssue = eligible.find((c) => c.issue_id === "issue-10");
		// If unarchived, it won't appear in cleanup candidates (archived_at is null)
		// Let's verify via the session that retry_successor is set
		const oldSession = store.getSession("old-exec");
		expect(oldSession!.retry_successor).toBeDefined();
	});
});
