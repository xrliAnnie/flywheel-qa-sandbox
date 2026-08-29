/**
 * FLY-191 Phase 2 — /events route: pr_head_sha persistence (§5.5.2) +
 * re-review window reset.
 *
 * - session_completed (needs_review) persists `evidence.headSha` (full 40-hex
 *   only — malformed input is dropped at the boundary) as sessions.pr_head_sha;
 * - a SECOND needs_review completion while already awaiting_review (re-review
 *   after changes_requested) has no FSM self-loop: it must reset the review
 *   window + refresh pr_head_sha WITHOUT an FSM-reject error, and return 200.
 */

import type http from "node:http";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { REVIEW_BINDING_UNBOUND, StateStore } from "../StateStore.js";

const HEAD_V1 = "a".repeat(40);
const HEAD_V2 = "b".repeat(40);

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

describe("event-route pr_head_sha + re-review (FLY-191 Phase 2)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

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

	async function startRunning(executionId: string) {
		const res = await postEvent({
			event_id: `evt-start-${executionId}`,
			execution_id: executionId,
			issue_id: "FLY-191",
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { issueIdentifier: "FLY-191", issueTitle: "unfreeze" },
		});
		expect(res.status).toBe(200);
	}

	function completedBody(
		executionId: string,
		eventId: string,
		headSha?: string,
		reviewQuestionId?: string,
	) {
		return {
			event_id: eventId,
			execution_id: executionId,
			issue_id: "FLY-191",
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
					...(headSha ? { headSha } : {}),
				},
				sessionRole: "main",
				...(reviewQuestionId ? { reviewQuestionId } : {}),
			},
		};
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
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
		vi.restoreAllMocks();
	});

	it("persists evidence.headSha + payload.reviewQuestionId as the review binding on needs_review completion", async () => {
		await startRunning("exec-sha");
		const res = await postEvent(
			completedBody(
				"exec-sha",
				"evt-c1",
				HEAD_V1,
				"11111111-1111-1111-1111-111111111111",
			),
		);
		expect(res.status).toBe(200);

		const s = store.getSession("exec-sha");
		expect(s?.status).toBe("awaiting_review");
		expect(s?.pr_head_sha).toBe(HEAD_V1);
		expect(s?.review_question_id).toBe("11111111-1111-1111-1111-111111111111");
		expect(s?.awaiting_review_entered_at).toBeTruthy();
	});

	it("drops a malformed headSha/questionId at the boundary → sha cleared, binding = UNBOUND sentinel (fail-closed downstream)", async () => {
		await startRunning("exec-bad");
		await postEvent(
			completedBody("exec-bad", "evt-c2", "not-a-sha; DROP", "x; DROP TABLE"),
		);
		const s = store.getSession("exec-bad");
		expect(s?.status).toBe("awaiting_review");
		expect(s?.pr_head_sha).toBeUndefined();
		// Codex R2 HIGH-1: NOT NULL (that would mean "legacy, approvable via
		// fallback") — the sentinel marks "Phase-2 binding missing, refuse".
		expect(s?.review_question_id).toBe(REVIEW_BINDING_UNBOUND);
	});

	it("re-review with a NEW qid but missing headSha clears the sha (Codex PR R1 HIGH-2 — never retain a stale head)", async () => {
		await startRunning("exec-clear");
		await postEvent(
			completedBody(
				"exec-clear",
				"evt-cl1",
				HEAD_V1,
				"22222222-2222-2222-2222-222222222222",
			),
		);
		expect(store.getSession("exec-clear")?.pr_head_sha).toBe(HEAD_V1);

		// GENUINE re-review (new questionId) whose headSha is missing/garbled
		// (e.g. git failed in the worktree): the binding moves to the new
		// question and the OLD head must not survive — verify-approval
		// fail-closes on the missing sha instead of matching stale V1.
		// (A qid-LESS second completion is the dual-sink duplicate case and
		// preserves the binding — covered separately below, Codex R3 HIGH.)
		await postEvent(
			completedBody(
				"exec-clear",
				"evt-cl2",
				undefined,
				"23232323-2323-2323-2323-232323232323",
			),
		);
		const s = store.getSession("exec-clear");
		expect(s?.pr_head_sha).toBeUndefined(); // cleared, NOT V1
		expect(s?.review_question_id).toBe("23232323-2323-2323-2323-232323232323");
	});

	it("re-review (second needs_review while awaiting_review) resets the window + re-binds without FSM error", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await startRunning("exec-rr");
		await postEvent(
			completedBody(
				"exec-rr",
				"evt-rr1",
				HEAD_V1,
				"33333333-3333-3333-3333-333333333333",
			),
		);
		expect(store.getSession("exec-rr")?.pr_head_sha).toBe(HEAD_V1);

		// Simulate the notified state of an expired first window
		store.markGateTimeoutNotified("exec-rr");

		// Re-review with a NEW head + NEW question (changes_requested → fixes pushed)
		const res = await postEvent(
			completedBody(
				"exec-rr",
				"evt-rr2",
				HEAD_V2,
				"44444444-4444-4444-4444-444444444444",
			),
		);
		expect(res.status).toBe(200);

		const s = store.getSession("exec-rr");
		expect(s?.status).toBe("awaiting_review");
		expect(s?.pr_head_sha).toBe(HEAD_V2); // stale approval can't ship v1
		expect(s?.review_question_id).toBe("44444444-4444-4444-4444-444444444444"); // old question superseded
		// Fresh window: dedup stamp cleared so a new timeout escalation can fire
		expect(s?.gate_timeout_notified_at).toBeUndefined();
		expect(s?.awaiting_review_entered_at).toBeTruthy();

		// No FSM-reject error for the legal re-review
		const fsmErrors = errorSpy.mock.calls.filter((c) =>
			String(c[0]).includes("FSM rejected"),
		);
		expect(fsmErrors).toHaveLength(0);
	});

	// Codex PR R3 HIGH: dual-sink protection — the in-process emitter
	// (ExecutionEventEmitter) POSTs qid-less needs_review completions; they
	// must never clobber a real binding set by `complete --question-id`.
	it("qid-less duplicate completion (dual-sink) PRESERVES a real binding + the review window", async () => {
		await startRunning("exec-dual");
		await postEvent(
			completedBody(
				"exec-dual",
				"evt-dual-1",
				HEAD_V1,
				"66666666-6666-6666-6666-666666666666",
			),
		);
		store.markGateTimeoutNotified("exec-dual"); // observable window state

		// In-process emitter fires for the same completion — no reviewQuestionId
		await postEvent(completedBody("exec-dual", "evt-dual-2", HEAD_V1));

		const s = store.getSession("exec-dual");
		expect(s?.review_question_id).toBe("66666666-6666-6666-6666-666666666666"); // NOT clobbered to sentinel
		expect(s?.pr_head_sha).toBe(HEAD_V1);
		// Window untouched: dedup stamp survives (no drift from duplicate emission)
		expect(s?.gate_timeout_notified_at).toBeTruthy();
	});

	it("reverse order converges: qid-less first entry (sentinel) then qid'd completion re-binds", async () => {
		await startRunning("exec-rev");
		// In-process emitter lands FIRST (no qid) → sentinel
		await postEvent(completedBody("exec-rev", "evt-rev-1", HEAD_V1));
		expect(store.getSession("exec-rev")?.review_question_id).toBe(
			REVIEW_BINDING_UNBOUND,
		);

		// CLI completion (with qid) lands SECOND → real binding wins
		await postEvent(
			completedBody(
				"exec-rev",
				"evt-rev-2",
				HEAD_V1,
				"77777777-7777-7777-7777-777777777777",
			),
		);
		expect(store.getSession("exec-rev")?.review_question_id).toBe(
			"77777777-7777-7777-7777-777777777777",
		);
	});

	it("duplicate event_id replay does NOT re-stamp the window (idempotency)", async () => {
		await startRunning("exec-dup");
		await postEvent(completedBody("exec-dup", "evt-dup", HEAD_V1));
		store.markGateTimeoutNotified("exec-dup");

		// Replay the SAME event_id — must not clear the dedup stamp
		await postEvent(completedBody("exec-dup", "evt-dup", HEAD_V1));
		expect(store.getSession("exec-dup")?.gate_timeout_notified_at).toBeTruthy();
	});
});
